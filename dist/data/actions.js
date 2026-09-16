/* actions.js — the writes.
 *
 * Every one of these is also enforced in the database; the checks here exist to
 * fail early with a sentence a person can read, not to be the boundary. If you
 * remove a check from this file nothing becomes possible that was not possible
 * before — RLS still refuses it. (Proven in veyagocloud/supabase/tests/.)
 *
 * Anything that must be true no matter who calls it — a resolution timestamp,
 * a response clock, a thread's message count — is set by a trigger, not here.
 * The client does not get to decide when a ticket was resolved.
 */
(function () {
  'use strict';

  function sb() { return window.workspaceSession.client; }
  function me() { return window.workspaceSession.employee; }

  /* Where attachments wait between being added and being sent (0038 §5). */
  var MAIL_ATTACHMENTS = 'mail-attachments';
  /* A project's files: <project id>/<upload id>/<file name> (0039). */
  var PROJECT_FILES = 'project-files';

  /* An Edge Function's own JSON answer to a failed call. supabase-js answers a
     non-2xx with { data: null, error } and the Response on error.context, so
     the function's body is only readable from there — once: a Response body
     cannot be read twice. */
  async function functionBody(res) {
    var context = res.error && res.error.context;
    if (context && typeof context.json === 'function') {
      try {
        var body = await context.json();
        if (body && typeof body === 'object') return body;
      } catch (notJson) {
        /* A gateway page rather than our JSON: the generic message will do. */
      }
    }
    return res.data && typeof res.data === 'object' ? res.data : {};
  }

  /* What went wrong, in the function's own words — without it, all a person
     sees is "Edge Function returned a non-2xx status code". */
  function errorMessage(res, body, fallback) {
    return String(body.error || body.message || (res.error && res.error.message) || fallback);
  }

  async function functionError(res, fallback) {
    return errorMessage(res, await functionBody(res), fallback);
  }

  function must(condition, message) {
    if (!condition) throw new Error(message);
  }

  function one(res, what) {
    if (res.error) throw new Error('Could not ' + what + ': ' + res.error.message);
    return res.data;
  }

  /* A delete or update that RLS refuses touches nothing and says nothing: the
     rows that come back are the only proof it happened. */
  function touched(res, what, refusal) {
    if (res.error) throw new Error('Could not ' + what + ': ' + res.error.message);
    /* No row back: gone, changed since, or not this person's to change. A
       refusal, marked as one, so a view can tell it from a write that never
       reached the database. */
    if (!(res.data && res.data.length)) throw Object.assign(new Error(refusal), { refused: true });
    return res.data;
  }

  function isContactRole(role) {
    return projectsModel.CONTACT_ROLES.some(function (r) { return r.value === role; });
  }

  /* Every status a task can be reopened to — everything but 'done' itself. */
  var REOPEN_STATUSES = ['todo', 'in_progress', 'blocked'];

  /* Text after a JSON parse, or null when it is not JSON: an RPC's `detail`
     (create_contact_with_company, 0053) names the record it clashed with, but
     only when the database sent one — an unrelated failure has none. */
  function parsedDetail(text) {
    if (!text) return null;
    try {
      var parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  /* A duplicate key on one of the CRM's own unique indexes, read as the
     sentence a person typed something wrong would want — never the
     database's "duplicate key value violates unique constraint …", which
     names a constraint, not what was typed. */
  function crmDuplicate(res, index) {
    return Boolean(res.error) && new RegExp(index, 'i').test(res.error.message);
  }

  /* Read or starred, through update-mail-state, which changes Outlook, the
     stored messages and the thread together. There is deliberately no fallback
     to writing the thread row: that never reached Outlook and was undone by the
     next sync, and a failure that merely looked like "not deployed" — a timeout,
     the function's own 404 — would have taken it silently. This ships once
     update-mail-state is live (veyagocloud docs/workspace-backend.md, Going
     live). */
  async function threadState(threadId, change) {
    var res = await sb().functions.invoke('update-mail-state', {
      body: Object.assign({ threadId: threadId }, change)
    });
    if (res.error) throw new Error(await functionError(res, 'That change did not save.'));
    return res.data;
  }

  window.workspaceActions = {

    /* ── Tickets ─────────────────────────────────────────────────────── */

    /* kind: 'reply' goes to the customer, 'note' stays between us. The
       difference is not cosmetic — an outbound reply starts the response
       clock (trigger, 0023), an internal note deliberately does not. */
    async replyToTicket(ticketId, body, kind) {
      must(body && body.trim(), 'Write something first.');
      must(me(), 'You need to be signed in as a team member to reply.');

      /* The Edge Function posts the message AND emails it, in that order, so
         the two cannot drift. It returns { sent, reason } — a reply to a
         ticket with no contact email is saved and honestly reported as not
         sent, rather than silently looking answered. */
      var res = await sb().functions.invoke('send-ticket-reply', {
        body: { ticketId: ticketId, body: body.trim(), kind: kind === 'note' ? 'note' : 'reply' }
      });

      if (!res.error) return res.data;

      var answer = await functionBody(res);
      var status = res.error.context && res.error.context.status;

      /* If the function is not deployed yet — the gateway's own 404, with no
         answer of the function's — a reply must still be recorded: losing what
         someone wrote is worse than not emailing it. The insert below is the
         same one RLS has always allowed, and the caller is told plainly that
         nothing was sent. */
      if (status === 404 && !answer.error) {
        var row = one(await sb().from('ticket_messages').insert({
          ticket_id: ticketId,
          author_employee_id: me().id,
          direction: kind === 'note' ? 'internal' : 'outbound',
          body: body.trim()
        }).select().single(), 'post the reply');
        return {
          ok: true, messageId: row.id, sent: false,
          reason: kind === 'note'
            ? 'Internal note — kept between us.'
            : 'Saved. Sending is not deployed on this project yet, so it has not gone out.'
        };
      }
      /* No answer of the function's own — the connection dropped, or the
         gateway gave up while it was still working — says nothing about whether
         the reply went. Saving a copy, or saying it did not go, invites sending
         it twice. */
      if (!answer.error && (!status || status >= 500)) {
        var unknown = new Error(kind === 'note'
          ? 'The note may have been saved. Look at the conversation before adding it again.'
          : 'The reply may have been sent. Look at the conversation before sending it again.');
        unknown.unknownOutcome = true;
        throw unknown;
      }
      throw new Error(errorMessage(res, answer, 'The reply could not be sent.'));
    },

    async setTicketStatus(ticketId, status) {
      must(['open','in_progress','waiting','resolved','closed'].indexOf(status) !== -1,
           'Unknown ticket status: ' + status);
      /* resolved_at is stamped by the database, never sent from here. */
      return one(await sb().from('support_tickets')
        .update({ status: status }).eq('id', ticketId).select().single(),
        'update the ticket');
    },

    async setTicketPriority(ticketId, priority) {
      must(['low', 'normal', 'high', 'urgent'].indexOf(priority) !== -1,
           'Unknown ticket priority: ' + priority);
      return one(await sb().from('support_tickets')
        .update({ priority: priority }).eq('id', ticketId).select().single(),
        'change the priority');
    },

    async assignTicket(ticketId, employeeId) {
      var row = one(await sb().from('support_tickets')
        .update({ assignee_id: employeeId || null }).eq('id', ticketId).select().single(),
        'reassign the ticket');
      /* Told once, after the assignment itself has already saved — never
         awaited into anything the caller does with the save, so a mail
         failure here can never look like the reassignment failed. Only when
         someone was actually given the ticket: notify-ticket (0056) decides
         for itself whether they should hear about it (not themselves, not
         inactive, an address on file) — this just starts the call. */
      if (employeeId) {
        sb().functions.invoke('notify-ticket', { body: { ticket_id: ticketId, event: 'assigned' } })
          .catch(function (err) { console.warn('[workspace] could not tell the assignee:', err && err.message); });
      }
      return row;
    },

    async createTicket(fields) {
      must(fields && fields.subject && fields.subject.trim(), 'A ticket needs a subject.');
      return one(await sb().from('support_tickets').insert({
        subject: fields.subject.trim(),
        contact_id: fields.contactId || null,
        company_id: fields.companyId || null,
        project_id: fields.projectId || null,
        product: fields.product || null,
        priority: fields.priority || 'normal',
        source: fields.source || 'manual',
        assignee_id: fields.assigneeId || (me() ? me().id : null),
        /* A sender the CRM has no contact for (audit #1): the raw address so
           a reply still has somewhere to go, kept as a fallback that yields
           to a contact linked here or later on the ticket's edit dialog. */
        requester_email: fields.requesterEmail || null,
        requester_name: fields.requesterName || null
      }).select().single(), 'create the ticket');
    },

    /* What an edit to a ticket changes (ticketsModel.ticketChanges), and only
       that — its subject, contact, company, project and product; status,
       priority and owner keep their own selects and saves above. `since` is
       the updated_at the change was made against (0023's own touch trigger
       moves it on every update), so a change made meanwhile is refused, not
       overwritten — the same rule updateEvent already uses. */
    async updateTicket(ticketId, changes, since) {
      var EDITABLE = ['subject', 'contact_id', 'company_id', 'project_id', 'product'];
      var fields = changes || {};
      var keys = Object.keys(fields);
      must(keys.length, 'Nothing was changed.');
      must(keys.every(function (key) { return EDITABLE.indexOf(key) !== -1; }),
        'Only a ticket’s subject, contact, company, project and product can be changed here.');
      if ('subject' in fields) must(String(fields.subject || '').trim(), 'A ticket needs a subject.');
      var update = sb().from('support_tickets').update(fields).eq('id', ticketId);
      if (since) update = update.eq('updated_at', since);
      return touched(await update.select(), 'save the ticket',
        'The ticket was not saved: it was changed since this was opened, or you may not change it. Close this and open the ticket again.')[0];
    },

    /* Soft delete: only a manager, and the database enforces the same rule
       (guard_soft_delete, 0012) whichever way a ticket's deleted_at is
       changed — this check just fails fast with a sentence a person can
       read, the way archiveProject's own check does. .is('deleted_at', null)
       makes an already-deleted ticket a refusal rather than a silent no-op. */
    async deleteTicket(ticketId) {
      must(window.workspaceSession.isManager && window.workspaceSession.isManager(),
        'Only an owner or admin can delete a ticket.');
      touched(await sb().from('support_tickets')
        .update({ deleted_at: new Date().toISOString() }).eq('id', ticketId).is('deleted_at', null).select('id'),
        'delete the ticket', 'The ticket was not deleted: it has been removed already, or only an owner or admin can remove one.');
    },

    /* By its number, the one a manager already has from the moment they
       deleted it — deleted tickets are not listed anywhere in the workspace
       for one to be picked from instead (0056). */
    async restoreTicket(number) {
      must(window.workspaceSession.isManager && window.workspaceSession.isManager(),
        'Only an owner or admin can restore a ticket.');
      must(Number.isInteger(number) && number > 0, 'That is not a ticket number.');
      touched(await sb().from('support_tickets')
        .update({ deleted_at: null }).eq('number', number).not('deleted_at', 'is', null).select('id'),
        'restore the ticket', 'No deleted ticket has that number, or only an owner or admin can restore one.');
    },

    /* ── Ticket attachments (0056) ──────────────────────────────────────
       Stored first, then recorded — the same order uploadProjectFile uses,
       for the same reason: an upload whose record will not save is taken
       away again, since without its record nobody would ever see it. */
    async uploadTicketAttachment(ticketId, file) {
      var problem = ticketsModel.fileProblem(file);
      must(!problem, problem);
      must(ticketId, 'That ticket has no id yet.');
      var contentType = file.type || 'application/octet-stream';
      var path = ticketId + '/' + window.crypto.randomUUID() + '/' + mailModel.storageName(file.name);
      var stored = await sb().storage.from('ticket-attachments').upload(path, file, { contentType: contentType, upsert: false });
      if (stored.error) throw new Error('Could not upload "' + file.name + '": ' + stored.error.message);
      var res = await sb().from('ticket_attachments').insert({
        ticket_id: ticketId, storage_path: path, name: String(file.name),
        size_bytes: Number(file.size), content_type: contentType
      }).select().single();
      if (res.error) {
        await sb().storage.from('ticket-attachments').remove([path]);
        throw new Error('Could not add "' + file.name + '" to the ticket: ' + res.error.message);
      }
      return res.data;
    },

    /* The upload goes first, as removeProjectFile's does: a record left
       without its upload shows as missing and can still be removed; an
       upload left without its record would be found by nobody. */
    async removeTicketAttachment(file) {
      must(file && file.id && file.storagePath, 'That attachment is not loaded any more. Reload the page.');
      var label = '"' + (file.name || 'the file') + '"';
      var removed = await sb().storage.from('ticket-attachments').remove([file.storagePath]);
      if (removed.error) throw new Error('Could not remove ' + label + ': ' + removed.error.message);
      return touched(await sb().from('ticket_attachments').delete().eq('id', file.id).select(),
        'remove ' + label,
        'Only whoever uploaded it, or an owner or admin, can remove this attachment.');
    },

    /* A minute is long enough to start a download, and short enough that a
       link copied out of the page soon stops working — the same choice
       projectFileLink makes. */
    async ticketAttachmentLink(path, name) {
      var res = await sb().storage.from('ticket-attachments').createSignedUrl(path, 60, name ? { download: name } : undefined);
      if (res.error) throw new Error('Could not open the file: ' + res.error.message);
      must(res.data && /^https:\/\//.test(res.data.signedUrl || ''), 'Could not open the file.');
      return res.data.signedUrl;
    },

    /* Two tickets about the same problem, made one (0056's merge_tickets()):
       p_drop's thread, notes and conversations move to p_keep, p_drop closes
       pointing at it. Any signed-in staff member, not managers only — the
       same as everything else this page lets a team member do to a ticket. */
    async mergeTickets(keepId, dropId) {
      var res = await sb().rpc('merge_tickets', { p_keep: keepId, p_drop: dropId });
      if (res.error) throw new Error('Could not merge the tickets: ' + res.error.message);
      return res.data;
    },

    /* ── Tasks ───────────────────────────────────────────────────────── */

    /* An assignee may move their own task along and nothing else — the column
       guard (0022) silently restores title, project, priority and due date if
       a non-manager sends them, so do not bother sending them. RLS refuses a
       tick someone may not make by touching nothing (0050): the rows changed
       are asked back, and none is said as a refusal rather than as
       supabase-js's "no rows returned".

       Unticking only ever knows "done" or "not done" — a checkbox has no room
       for "in progress" or "blocked" — so on its own it cannot say which of
       those a task should go back to. `revertTo` is that answer, when the
       caller has one (data/writes.js reads it off the checkbox that ticked
       the task done in the first place, from before the task became done): a
       status a task can be reopened to, or it is ignored and the task goes
       back to "to do", as it always has. */
    async setTaskDone(taskId, done, revertTo) {
      var reopenAs = REOPEN_STATUSES.indexOf(revertTo) !== -1 ? revertTo : 'todo';
      return touched(await sb().from('tasks').update({
        status: done ? 'done' : reopenAs,
        completed_at: done ? new Date().toISOString() : null
      }).eq('id', taskId).select(), 'update the task',
        'The task was not changed: only its assignee, its project’s team, or an owner or admin can tick it off.')[0];
    },

    /* What an edit changes (tasksModel.taskChanges), and only that. RLS refuses
       a task someone may not change by touching nothing (0050), so the rows
       changed are asked back: none is a refusal, and is said as one. */
    async updateTask(taskId, changes) {
      must(changes && Object.keys(changes).length, 'Nothing to save.');
      return touched(await sb().from('tasks').update(changes).eq('id', taskId).select(), 'save the task',
        'The task was not saved. Its assignee and its project’s team can change its status; only an owner or admin can change the rest.')[0];
    },

    /* Owners and admins only (0050); anyone else removes nothing, said as a refusal. */
    async deleteTask(taskId) {
      touched(await sb().from('tasks').delete().eq('id', taskId).select('id'), 'remove the task',
        'The task was not removed: only an owner or admin can remove a task.');
    },

    async createTask(fields) {
      must(fields && fields.title && fields.title.trim(), 'A task needs a title.');
      return one(await sb().from('tasks').insert({
        title: fields.title.trim(),
        details: fields.details || null,
        project_id: fields.projectId || null,
        /* Whoever it was given to; null is nobody. Not given at all, it is for
           whoever adds it. */
        assignee_id: fields.assigneeId !== undefined ? fields.assigneeId : (me() ? me().id : null),
        priority: fields.priority || 'normal',
        due_date: fields.dueDate || null,
        created_by: window.workspaceSession.session
          ? window.workspaceSession.session.user.id : null
      }).select().single(), 'create the task');
    },

    /* ── Projects ────────────────────────────────────────────────────── */

    /* ownerId: undefined means nothing was said, so whoever adds it owns it —
       null is a deliberate "no owner", same as createCompany already reads
       it. `fields.ownerId || me()` could not tell those apart, so "No owner"
       picked in the New project dialog silently became the creator anyway. */
    async createProject(fields) {
      must(fields && fields.name && fields.name.trim(), 'A project needs a name.');
      return one(await sb().from('client_projects').insert({
        name: fields.name.trim(),
        company_id: fields.companyId || null,
        code: fields.code || null,
        accent: fields.accent || 'default',
        status: fields.status || 'discovery',
        description: fields.description || null,
        starts_on: fields.startsOn || null,
        due_on: fields.dueOn || null,
        owner_id: fields.ownerId !== undefined ? fields.ownerId : (me() ? me().id : null)
      }).select().single(), 'create the project');
    },

    async setProjectStatus(projectId, status) {
      return one(await sb().from('client_projects')
        .update({ status: status }).eq('id', projectId).select().single(),
        'update the project');
    },

    /* The columns a project form may change. Status has its own select and
       save, archiving has archiveProject(), and the budget is for managers
       and arrives with its own rules — anything else in `changes` is dropped.
       Resolves to null when there is nothing to write. */
    async updateProject(projectId, changes) {
      var allowed = ['name', 'description', 'company_id', 'owner_id', 'starts_on', 'due_on'];
      var update = allowed.reduce(function (acc, column) {
        return changes && Object.prototype.hasOwnProperty.call(changes, column)
          ? Object.assign({}, acc, { [column]: changes[column] })
          : acc;
      }, {});
      if (!Object.keys(update).length) return null;
      return one(await sb().from('client_projects')
        .update(update).eq('id', projectId).select().single(), 'save the project');
    },

    /* Archived, not deleted: deleted_at is set, the row stays, and the project
       leaves the board and every list. Owners and admins only — the database
       refuses anyone else too (guard_soft_delete). */
    async archiveProject(projectId) {
      must(window.workspaceSession.isManager && window.workspaceSession.isManager(),
        'Only an owner or admin can archive a project.');
      return one(await sb().from('client_projects')
        .update({ deleted_at: new Date().toISOString() }).eq('id', projectId).select().single(),
        'archive the project');
    },

    /* The other direction: back onto the board and every list. guard_soft_delete
       (0012) enforces owners and admins only for either direction of deleted_at,
       so the check here is the same one archiving already makes, not a new
       rule — and the row changed is asked back, so one already restored, or
       gone outright, is a refusal rather than a silent no-op. */
    async restoreProject(projectId) {
      must(window.workspaceSession.isManager && window.workspaceSession.isManager(),
        'Only an owner or admin can restore a project.');
      return touched(await sb().from('client_projects')
        .update({ deleted_at: null }).eq('id', projectId).select(),
        'restore the project',
        'The project was not restored: it is not archived any more, or only an owner or admin can restore it.')[0];
    },

    /* ── Projects: team, client people, files, budget (0039) ─────────── */
    /* These tables have column grants, so they are written with insert, update
       and delete only: PostgREST's upsert also updates the key, and is refused. */

    async addProjectMember(projectId, employeeId) {
      must(projectId && employeeId, 'Pick someone to add.');
      var res = await sb().from('project_members')
        .insert({ project_id: projectId, employee_id: employeeId }).select().single();
      if (res.error && /row-level security/i.test(res.error.message)) {
        throw new Error('Only the project\'s owner or an owner or admin can add people to it.');
      }
      return one(res, 'add them to the project');
    },

    async removeProjectMember(projectId, employeeId) {
      return touched(await sb().from('project_members')
        .delete().eq('project_id', projectId).eq('employee_id', employeeId).select(),
        'take them off the project',
        'Not removed: only the project\'s owner or an owner or admin can take someone else off a project.');
    },

    async addProjectContact(projectId, contactId, role) {
      must(isContactRole(role), 'Pick a role for them on the project.');
      return one(await sb().from('project_contacts')
        .insert({ project_id: projectId, contact_id: contactId, role: role }).select().single(),
        'add them to the project');
    },

    async setProjectContactRole(projectId, contactId, role) {
      must(isContactRole(role), 'Pick a role for them on the project.');
      return touched(await sb().from('project_contacts')
        .update({ role: role }).eq('project_id', projectId).eq('contact_id', contactId).select(),
        'change their role', 'That contact is not on the project any more.')[0];
    },

    async removeProjectContact(projectId, contactId) {
      return touched(await sb().from('project_contacts')
        .delete().eq('project_id', projectId).eq('contact_id', contactId).select(),
        'take them off the project', 'That contact was not on the project any more.');
    },

    /* Stored first, then recorded. An upload whose record will not save is
       taken away again: without its record, nobody would ever see it. */
    async uploadProjectFile(projectId, file) {
      var problem = projectsModel.fileProblem(file);
      must(!problem, problem);
      must(projectId, 'That project has no id yet.');
      var contentType = file.type || 'application/octet-stream';
      var path = projectId + '/' + window.crypto.randomUUID() + '/' + mailModel.storageName(file.name);
      var stored = await sb().storage.from(PROJECT_FILES).upload(path, file, { contentType: contentType, upsert: false });
      if (stored.error) throw new Error('Could not upload "' + file.name + '": ' + stored.error.message);
      var res = await sb().from('project_files').insert({
        project_id: projectId, storage_path: path, name: String(file.name),
        size_bytes: Number(file.size), content_type: contentType
      }).select().single();
      if (res.error) {
        await sb().storage.from(PROJECT_FILES).remove([path]);
        throw new Error('Could not add "' + file.name + '" to the project: ' + res.error.message);
      }
      return res.data;
    },

    /* The upload goes first. A record left without its upload shows as missing
       and can still be removed; an upload left without its record would be
       found by nobody. */
    async removeProjectFile(file) {
      must(file && file.id && file.path, 'That file is not loaded any more. Reload the page.');
      var label = '"' + (file.name || 'the file') + '"';
      var removed = await sb().storage.from(PROJECT_FILES).remove([file.path]);
      if (removed.error) throw new Error('Could not remove ' + label + ': ' + removed.error.message);
      return touched(await sb().from('project_files').delete().eq('id', file.id).select(),
        'remove ' + label,
        'Only whoever uploaded it, the project\'s owner or an owner or admin can remove this file.');
    },

    /* A minute is long enough to start a download, and short enough that a link
       copied out of the page soon stops working. */
    async projectFileLink(path, name) {
      var res = await sb().storage.from(PROJECT_FILES).createSignedUrl(path, 60, name ? { download: name } : undefined);
      if (res.error) throw new Error('Could not open the file: ' + res.error.message);
      must(res.data && /^https:\/\//.test(res.data.signedUrl || ''), 'Could not open the file.');
      return res.data.signedUrl;
    },

    /* `change` is projectsModel.budgetChange(): set, change, clear or none. */
    async setProjectBudget(projectId, change) {
      must(window.workspaceSession.isManager && window.workspaceSession.isManager(),
        'Only an owner or admin can set a project\'s budget.');
      var c = change || {};
      if (c.action === 'set') {
        return one(await sb().from('project_budgets')
          .insert({ project_id: projectId, amount: c.amount, currency: c.currency }).select().single(),
          'set the budget');
      }
      if (c.action === 'change') {
        return touched(await sb().from('project_budgets')
          .update({ amount: c.amount, currency: c.currency }).eq('project_id', projectId).select(),
          'change the budget', 'That budget was cleared meanwhile. Reload and set it again.')[0];
      }
      if (c.action === 'clear') {
        touched(await sb().from('project_budgets').delete().eq('project_id', projectId).select(),
          'clear the budget', 'That budget was already cleared.');
      }
      return null;
    },

    /* ── CRM ─────────────────────────────────────────────────────────── */

    async createCompany(fields) {
      must(fields && fields.name && fields.name.trim(), 'A company needs a name.');
      /* Bare host only: the domain is what inbound mail is matched on, so
         "https://www.northline.example/" must not become a second company. */
      var domain = (fields.domain || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;
      /* In the currency it was given (crmModel.companyForm), or the column's own default. */
      var res = await sb().from('crm_companies').insert(Object.assign({
        name: fields.name.trim(), domain: domain,
        kind: fields.kind || 'prospect', stage: fields.stage || 'lead',
        value: fields.value ?? null, notes: fields.notes || null,
        /* No owner, when the form says none; the person adding it, when nothing says. */
        owner_id: fields.ownerId !== undefined ? fields.ownerId : (me() ? me().id : null)
      }, fields.currency ? { currency: fields.currency } : {})).select().single();
      /* The client already asks crmModel.duplicateCompanies before sending this
         (crm-forms.js); this is only the same domain landing here anyway — a
         race, or data that had not loaded yet — and the raw index name is not
         a sentence anyone typed something wrong would understand. */
      if (crmDuplicate(res, 'crm_companies_domain_idx')) {
        throw new Error('A company at that domain is already in the CRM.');
      }
      return one(res, 'add the company');
    },

    /* What an edit to a company changes (crmModel.companyChanges), and only
       that. Staff may change a company (0021), but not one a manager has
       removed: that, or a change RLS refuses, touches no row, and the rows
       changed are asked back to say so. */
    async updateCompany(companyId, changes) {
      must(changes && Object.keys(changes).length, 'Nothing to save.');
      return touched(await sb().from('crm_companies').update(changes).eq('id', companyId).is('deleted_at', null).select(), 'save the company',
        'The company was not saved: it has been removed from the CRM, or you may not change it.')[0];
    },

    /* Soft delete: owners and admins only, and the database enforces the same
       rule whichever way a company's deleted_at is changed (guard_soft_delete,
       0012, wired to crm_companies by 0021) — this check just fails fast with
       a sentence a person can read, the way archiveProject's own check does.
       .is('deleted_at', null) makes a company already removed a refusal
       rather than a silent no-op. Its people and its work stay exactly where
       they are: a contact still names it (crm_contacts.company_id is left
       alone), but the next load of `companies` leaves it out, so every page
       reads them as having no company any more — the same as a company a
       contact's own row never had. */
    async deleteCompany(companyId) {
      must(window.workspaceSession.isManager && window.workspaceSession.isManager(),
        'Only an owner or admin can remove a company from the CRM.');
      touched(await sb().from('crm_companies')
        .update({ deleted_at: new Date().toISOString() }).eq('id', companyId).is('deleted_at', null).select('id'),
        'remove the company', 'The company was not removed: it has been removed already, or only an owner or admin can remove one.');
    },

    async createContact(fields) {
      must(fields && fields.fullName && fields.fullName.trim(), 'A contact needs a name.');
      var res = await sb().from('crm_contacts').insert({
        full_name: fields.fullName.trim(),
        company_id: fields.companyId || null,
        email: (fields.email || '').trim().toLowerCase() || null,
        phone: fields.phone || null, title: fields.title || null,
        notes: fields.notes || null
      }).select().single();
      /* Same reasoning as createCompany's domain check, above: the client
         already asked crmModel.duplicateContacts, so this is a race or stale
         data, not a typo — say so in a sentence, not the index's name. */
      if (crmDuplicate(res, 'crm_contacts_email_idx')) {
        throw new Error('That email address is already used by another contact.');
      }
      return one(res, 'add the contact');
    },

    /* A contact and, when none was picked, their company, in one transaction
       (create_contact_with_company, 0053): the workspace used to add the two
       with two requests (createCompany then createContact, above), so a
       contact refused after its company was made — an address already in the
       CRM, say — left the company behind, for a retry to add again. Exactly
       one of companyId or companyName is sent, matching what the database
       takes; neither means no company, as createContact's does. A refusal
       that names the record it clashed with (a duplicate address, or more
       than one company by that name) carries that id or those ids along, so
       the dialog can point at it rather than only saying so. */
    async createContactWithCompany(fields) {
      var f = fields || {};
      var res = await sb().rpc('create_contact_with_company', {
        p_full_name: f.fullName || '',
        p_email: f.email || null,
        p_phone: f.phone || null,
        p_title: f.title || null,
        p_is_primary: Boolean(f.isPrimary),
        p_notes: f.notes || null,
        p_enquiry_id: f.enquiryId || null,
        p_company_id: f.companyId || null,
        p_company_name: f.companyName || null
      });
      if (res.error) {
        var err = new Error('Could not add the contact: ' + res.error.message);
        var detail = parsedDetail(res.error.details);
        if (detail && detail.contact_id) err.conflictContactId = detail.contact_id;
        if (detail && detail.company_ids) err.matchingCompanyIds = detail.company_ids;
        throw err;
      }
      /* A function with OUT parameters answers one row: as a bare object from
         most Postgres versions, as a one-row array from some — read either. */
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      return { contactId: row && row.contact_id, companyId: row && row.company_id };
    },

    /* What an edit to a contact changes (crmModel.contactChanges), and only that,
       said as a refusal when no row changed. */
    async updateContact(contactId, changes) {
      must(changes && Object.keys(changes).length, 'Nothing to save.');
      return touched(await sb().from('crm_contacts').update(changes).eq('id', contactId).is('deleted_at', null).select(), 'save the contact',
        'The contact was not saved: they have been removed from the CRM, or you may not change them.')[0];
    },

    /* Soft delete, the same rule and the same reasoning as deleteCompany
       above: owners and admins only, enforced again by guard_soft_delete
       whichever way this is called. A project they are on, a ticket filed
       under them or mail matched to them all keep pointing at their row —
       only the next load of `contacts` leaves them off every list, so the
       rest of the workspace reads them the way it already reads any contact
       it cannot find by id. */
    async deleteContact(contactId) {
      must(window.workspaceSession.isManager && window.workspaceSession.isManager(),
        'Only an owner or admin can remove a contact from the CRM.');
      touched(await sb().from('crm_contacts')
        .update({ deleted_at: new Date().toISOString() }).eq('id', contactId).is('deleted_at', null).select('id'),
        'remove the contact', 'The contact was not removed: it has been removed already, or only an owner or admin can remove one.');
    },

    /* Turn a /websites/ enquiry into a company + contact. Safe to call twice:
       the function returns the same contact rather than making a duplicate. */
    async promoteEnquiry(enquiryId) {
      var res = await sb().rpc('promote_enquiry_to_crm', { p_enquiry_id: enquiryId });
      if (res.error) throw new Error('Could not promote the enquiry: ' + res.error.message);
      return res.data;
    },

    /* Merging two companies, or two contacts, into one (merge_companies() /
       merge_contacts(), 0053; owners and admins only): everything that
       pointed at the one merged away — its projects, tickets, mail, events,
       invoices, notes and, for a contact, project links — points at the one
       kept afterwards, and the merged record is deleted and marked where it
       went. `keepId` stays in the CRM; `dropId` is folded into it. Answers
       what the database moved, so the dialog can say so. */
    async mergeCompanies(keepId, dropId) {
      must(keepId && dropId, 'Pick the company to keep and the company to merge into it.');
      must(keepId !== dropId, 'A company cannot be merged into itself.');
      var res = await sb().rpc('merge_companies', { p_keep: keepId, p_drop: dropId });
      if (res.error) throw new Error('Could not merge the companies: ' + res.error.message);
      return res.data;
    },

    async mergeContacts(keepId, dropId) {
      must(keepId && dropId, 'Pick the contact to keep and the contact to merge into it.');
      must(keepId !== dropId, 'A contact cannot be merged into itself.');
      var res = await sb().rpc('merge_contacts', { p_keep: keepId, p_drop: dropId });
      if (res.error) throw new Error('Could not merge the contacts: ' + res.error.message);
      return res.data;
    },

    /* ── Finance (owners and admins, 0005) ── */

    /* Paid, on the day it was paid — one the page checked is not still to
       come. RLS lets only owners and admins change an invoice; anyone else
       changes no row, and that is said as a refusal. */
    async markInvoicePaid(invoiceId, paidOn) {
      must(/^\d{4}-\d{2}-\d{2}$/.test(String(paidOn || '')), 'Pick the day it was paid.');
      /* Only one still waiting for payment: one someone has since recorded,
         or turned back into a draft in the admin, is left as it is. */
      return touched(await sb().from('finance_invoices').update({ status: 'paid', paid_on: paidOn })
        .eq('id', invoiceId).in('status', ['sent', 'overdue']).select(),
        'mark the invoice paid', 'The invoice was not changed: it has been paid, turned back into a draft or removed since, or only an owner or admin can change it.')[0];
    },

    /* Back to waiting for payment, when it was marked paid by mistake: sent —
       finance-model.js reads it as overdue once its due date has passed — and
       no day it was paid. Only the payment the dialog showed, by the day it
       was paid (null for none): one recorded again since is left as it is. */
    async reopenInvoice(invoiceId, paidOn) {
      must(paidOn === null || /^\d{4}-\d{2}-\d{2}$/.test(String(paidOn)), 'Which payment to undo was not given.');
      var unpaid = sb().from('finance_invoices').update({ status: 'sent', paid_on: null })
        .eq('id', invoiceId).eq('status', 'paid');
      unpaid = paidOn === null ? unpaid.is('paid_on', null) : unpaid.eq('paid_on', paidOn);
      return touched(await unpaid.select(), 'mark the invoice unpaid',
        'The invoice was not changed: its payment was changed or it is no longer marked paid, it was removed, or only an owner or admin can change it.')[0];
    },

    /* ── Agenda ──────────────────────────────────────────────────────── */

    /* Local events only. A row invented against a synced calendar would be
       refused by RLS and would vanish on the next sync anyway. */
    async createEvent(fields) {
      must(fields && fields.title && fields.title.trim(), 'An event needs a title.');
      must(fields.startsAt, 'An event needs a start time.');

      var startsAt = new Date(fields.startsAt).toISOString();
      var endsAt = fields.endsAt ? new Date(fields.endsAt).toISOString() : null;

      /* Book it in Outlook when a calendar is connected, so it shows up on the
         phone too. */
      var res = await sb().functions.invoke('create-calendar-event', {
        body: {
          title: fields.title.trim(), startsAt: startsAt, endsAt: endsAt,
          detail: fields.detail || null, location: fields.location || null,
          allDay: !!fields.allDay, kind: fields.kind || 'internal',
          attendees: fields.attendees || [],
          projectId: fields.projectId || null, companyId: fields.companyId || null,
          contactId: fields.contactId || null
        }
      });

      if (!res.error) return res.data;

      /* Saved here alone only when the function says so (localOnly): no
         calendar is connected, or the studio's needs reconnecting. Any other
         failure saves nothing — a private event the function refused, or an
         answer that never arrived, must not land where every member of staff
         reads it. */
      var answer = await functionBody(res);
      if (answer.localOnly !== true) {
        /* In the function's words when it gave any; otherwise one sentence
           rather than the client library's. */
        throw new Error(answer.error || answer.message
          ? errorMessage(res, answer, '')
          : 'The event could not be booked, and nothing was saved.');
      }

      /* Local only: connection_id and external_id stay null, which is what the
         RLS policy for a hand-made event requires and what keeps it out of the
         sync's unique index. */
      var local = one(await sb().from('calendar_events').insert({
        title: fields.title.trim(),
        detail: fields.detail || null, location: fields.location || null,
        starts_at: startsAt, ends_at: endsAt,
        all_day: !!fields.allDay, kind: fields.kind || 'internal',
        project_id: fields.projectId || null, company_id: fields.companyId || null,
        contact_id: fields.contactId || null,
        created_by: me() ? me().id : null
      }).select().single(), 'add the event');
      /* Why it is only here, when that is something to fix: the studio
         calendar waiting to be reconnected, or client work with no studio
         calendar to go in — which someone whose own calendar is connected
         would otherwise be told is no calendar at all. */
      return Object.assign({}, local, {
        why: answer.reason === 'studio-needs-reconnect' ? (answer.error || null)
          : answer.reason === 'no-studio' ? 'The studio calendar is not connected, so this is saved in the workspace only.'
            : null
      });
    },

    /* A hand-made event, by whoever booked it or an owner or admin (0048):
       RLS refuses anything else by removing nothing, so the rows removed are
       asked back; none is a refusal, and is said as one. A SYNCED event
       (connectionId given) is nobody's to delete straight through RLS —
       delete-calendar-event removes it in Outlook first, then here (0057,
       "Edits and deletes need to reach Outlook"). */
    async deleteEvent(eventId, connectionId) {
      if (connectionId) {
        var res = await sb().functions.invoke('delete-calendar-event', { body: { eventId: eventId } });
        if (res.error) throw new Error(await functionError(res, 'The event was not removed.'));
        return res.data;
      }
      touched(await sb().from('calendar_events').delete().eq('id', eventId).select('id'), 'remove the event',
        'The event was not removed: it has been removed already, or only whoever booked it, or an owner or admin, can remove it.');
    },

    /* Changing a hand-made event, by whoever booked it or an owner or admin
       (0048): only what an edit may change — its title, times, place and
       details, checked here whichever event this is, since update-calendar-
       event trusts this same allowlist rather than repeating the check for a
       different reason to disagree. `since` is the updated_at the change was
       made against, which 0026's trigger moves on every change: an event
       changed meanwhile is not overwritten. For a hand-made event RLS refuses
       by changing nothing, as do the connection_id and updated_at filters;
       none changed is a refusal, said as one. A SYNCED event (connectionId
       given) is nobody's to PATCH straight through RLS — update-calendar-
       event changes it in Outlook first, then here (0057). */
    async updateEvent(eventId, changes, since, connectionId) {
      var EDITABLE = ['title', 'detail', 'location', 'starts_at', 'ends_at'];
      var fields = changes || {};
      var keys = Object.keys(fields);
      must(keys.length, 'Nothing was changed.');
      must(keys.every(function (key) { return EDITABLE.indexOf(key) !== -1; }), 'Only an event’s title, times, place and details can be changed here.');
      if ('title' in fields) must(String(fields.title || '').trim(), 'An event needs a title.');
      if ('starts_at' in fields) must(!isNaN(Date.parse(fields.starts_at)), 'An event needs a start time.');
      if (fields.starts_at && fields.ends_at) must(Date.parse(fields.ends_at) > Date.parse(fields.starts_at), 'An event cannot end before it starts.');
      if (connectionId) {
        var synced = await sb().functions.invoke('update-calendar-event', {
          body: { eventId: eventId, changes: fields, since: since || null }
        });
        if (synced.error) throw new Error(await functionError(synced, 'The event was not changed.'));
        return synced.data;
      }
      var update = sb().from('calendar_events').update(fields).eq('id', eventId).is('connection_id', null);
      if (since) update = update.eq('updated_at', since);
      return touched(await update.select(), 'change the event',
        'The event was not changed: it was changed or removed since this was opened, or only whoever booked it, or an owner or admin, can change it. Close this and open the event again.')[0];
    },

    /* ── Notes ───────────────────────────────────────────────────────── */

    /* author_id must be the caller's own employee row — RLS refuses anything
       else, so there is no point letting a caller pass one. */
    async addNote(entityType, entityId, body) {
      must(body && body.trim(), 'Write something first.');
      must(me(), 'You need to be signed in as a team member to add a note.');
      must(entityId, 'That record has no id yet.');
      return one(await sb().from('workspace_notes').insert({
        entity_type: entityType, entity_id: entityId,
        author_id: me().id, body: body.trim()
      }).select().single(), 'save the note');
    },

    /* Whoever wrote a note changes its words (0032); anyone else changes
       nothing, said as a refusal. */
    async updateNote(noteId, body) {
      must(body && String(body).trim(), 'Write something first.');
      return touched(await sb().from('workspace_notes').update({ body: String(body).trim() }).eq('id', noteId).select(),
        'save the note', 'The note was not changed: only whoever wrote it can change it, or it has been removed.')[0];
    },

    /* Whoever wrote a note, or an owner or admin, removes it (0032); anyone
       else removes nothing — which used to be taken for a removal. */
    async deleteNote(noteId) {
      touched(await sb().from('workspace_notes').delete().eq('id', noteId).select('id'), 'remove the note',
        'The note was not removed: only whoever wrote it, or an owner or admin, can remove it — or it has been removed already.');
    },

    /* ── Mail ────────────────────────────────────────────────────────── */

    /* Open a ticket for a mail thread, carrying the conversation into it.
       Idempotent: a thread that already has one returns that ticket. */
    async createTicketFromThread(threadId, product) {
      var res = await sb().rpc('create_ticket_from_thread', {
        p_thread_id: threadId, p_product: product || null
      });
      if (res.error) throw new Error('Could not open a ticket: ' + res.error.message);
      return res.data;
    },

    /* Resolves to update-mail-state's answer: { ok, thread, outlook, reason }.
       outlook false means the change is saved here but Outlook did not get it —
       the view says so, or the next sync would quietly undo it. */
    async markThreadRead(threadId, read) {
      return threadState(threadId, { read: read !== false });
    },

    async starThread(threadId, starred) {
      return threadState(threadId, { starred: !!starred });
    },

    /* ── Notifications ───────────────────────────────────────────────── */

    /* Marks one bell item seen (notification_dismissals, 0061) — a plain
       insert; there is nothing to change about a dismissal once it exists.
       Dismissing the same key twice is a harmless repeat, not an error the
       person needs to see: the table's own primary key catches it (23505). */
    async dismissNotification(key) {
      must(key && String(key).trim(), 'Nothing to dismiss.');
      must(me(), 'You need to be signed in as a team member to dismiss this.');
      var res = await sb().from('notification_dismissals')
        .insert({ employee_id: me().id, notif_key: String(key) });
      if (res.error && res.error.code !== '23505') {
        throw new Error('Could not dismiss that: ' + res.error.message);
      }
    },

    /* ── Company: the team, invitations and the studio profile ─────────── */

    /* A role or status change on someone's employees row — the same guard as
       0042 (companyModel.changeRefusal decides beforehand whether the form
       offers it); a change RLS refuses touches no row, and the rows changed
       are asked back so that is said as a refusal rather than a silent
       success. Owner rows, and someone's own role or status, are refused the
       same way the database refuses them. */
    async updateEmployee(employeeId, changes) {
      must(changes && Object.keys(changes).length, 'Nothing to save.');
      return touched(await sb().from('employees').update(changes).eq('id', employeeId).select(),
        'save that change',
        'That was not saved: it changed since this was opened, or the database no longer allows it here.')[0];
    },

    /* Sends the invite-employee Edge Function exactly the fields it takes
       (companyModel.inviteForm's payload); the function asks the same
       questions the form already asked (_shared/team-rules.ts), so a refusal
       here is either a race with someone else's change or the account's own
       email delivery, never a surprise about who may invite whom. */
    async inviteEmployee(fields) {
      var res = await sb().functions.invoke('invite-employee', { body: fields });
      if (res.error) throw new Error(await functionError(res, 'Could not send the invitation.'));
      return res.data;
    },

    /* Only owners and admins may write workspace_settings (0016) — the same
       upsert the admin already uses for any other setting, keyed so a value
       already saved is replaced rather than duplicated. `changes` is
       { workspace_settings key: new value }, built by whoever calls this from
       companyModel.STUDIO_KEYS, not the model's own field names. */
    async updateStudioProfile(changes) {
      var keys = Object.keys(changes || {});
      must(keys.length, 'Nothing to save.');
      var rows = keys.map(function (key) { return { key: key, value: changes[key] }; });
      return one(await sb().from('workspace_settings').upsert(rows, { onConflict: 'key' }).select(),
        'save the studio profile');
    },

    /* ── Connections ─────────────────────────────────────────────────── */

    /* Starts reconnecting a mailbox and resolves to Microsoft's consent page.
       No employeeId is sent: microsoft-connect then keeps whose mailbox it is
       and who consented to it. Only ever a Microsoft sign-in page — the page is
       opened as it comes back, so anything else is refused rather than
       followed. Owners and admins reconnect the studio's mailboxes, and anyone
       their own; the function says so to anyone else. */
    async reconnectMailbox(address) {
      must(address && String(address).trim(), 'Say which mailbox to reconnect.');
      var res = await sb().functions.invoke('microsoft-connect', {
        body: { provider: 'microsoft_mail', accountLabel: String(address).trim() }
      });
      if (res.error) throw new Error(await functionError(res, 'Reconnecting could not start.'));
      var url = String(res.data && res.data.consentUrl || '');
      must(/^https:\/\/login\.microsoftonline\.com\//.test(url), 'Microsoft did not send a sign-in page back.');
      return url;
    },

    /* Starts connecting a brand NEW mailbox — never a reconnect, which
       reconnectMailbox above already does — the same call as connectCalendar
       below makes for the other provider (0057's own pattern, mirrored here
       rather than a second one invented for mail): `employeeId` says whose it
       is, null for the studio's, left out entirely for anyone connecting
       their own; microsoft-connect itself decides who may say so (an owner
       or admin for the studio's, anyone their own). */
    async connectMailbox(address, employeeId) {
      must(address && String(address).trim(), 'Say which mailbox to connect.');
      var body = { provider: 'microsoft_mail', accountLabel: String(address).trim() };
      if (employeeId !== undefined) body.employeeId = employeeId;
      var res = await sb().functions.invoke('microsoft-connect', { body: body });
      if (res.error) throw new Error(await functionError(res, 'Connecting could not start.'));
      var url = String(res.data && res.data.consentUrl || '');
      must(/^https:\/\/login\.microsoftonline\.com\//.test(url), 'Microsoft did not send a sign-in page back.');
      return url;
    },

    /* Disconnecting, unlike reconnecting or connecting, needs no Edge
       Function: it does not touch Microsoft at all, only this row's own
       `status` — the one column (with last_error) 0038 already grants the
       browser, and its own trigger (integration_connections_browser_can_
       only_disconnect) refuses anything else written from here. 0055 widened
       who may make this exact write to match reconnecting: a plain member of
       staff their own personal mailbox, an owner or admin the studio's — so
       RLS itself decides who, and a refused write comes back as zero rows,
       said as one rather than a silent success. */
    async disconnectMailbox(connectionId) {
      must(connectionId, 'Which mailbox to disconnect was not given.');
      return touched(await sb().from('integration_connections').update({ status: 'disconnected' }).eq('id', connectionId).select('id'),
        'disconnect that mailbox',
        'That mailbox could not be disconnected: it may already be, or this is not yours to change.')[0];
    },

    /* Starts connecting — or reconnecting — a calendar: the same call as
       reconnectMailbox, for the other provider (0057, "No way to connect a
       calendar or see its last sync"). `employeeId` is left out for a plain
       reconnect, which keeps whose calendar it already is; passed as null it
       says a brand new connection is the studio's, an owner or admin only —
       microsoft-connect itself decides who may say so. */
    async connectCalendar(address, employeeId) {
      must(address && String(address).trim(), 'Say which calendar to connect.');
      var body = { provider: 'microsoft_calendar', accountLabel: String(address).trim() };
      if (employeeId !== undefined) body.employeeId = employeeId;
      var res = await sb().functions.invoke('microsoft-connect', { body: body });
      if (res.error) throw new Error(await functionError(res, 'Connecting could not start.'));
      var url = String(res.data && res.data.consentUrl || '');
      must(/^https:\/\/login\.microsoftonline\.com\//.test(url), 'Microsoft did not send a sign-in page back.');
      return url;
    },

    /* Asks sync-outlook-calendar to pull this connection now, rather than
       waiting for the schedule (0057 §3, every 15 minutes) or the next time
       the Agenda happens to be opened. */
    async syncCalendar(connectionId) {
      must(connectionId, 'Which calendar to sync was not given.');
      var res = await sb().functions.invoke('sync-outlook-calendar', { body: { connectionId: connectionId } });
      if (res.error) throw new Error(await functionError(res, 'Syncing could not start.'));
      return res.data;
    },

    /* ── Mail: sending ───────────────────────────────────────────────── */

    /* One message, new or an answer, through send-mail — which checks all of
       it again and stores the sent copy. A refusal is an Error that also says
       whether reconnecting the mailbox would help (reconnect) and whether the
       message is waiting in Outlook's Drafts (draftSaved). */
    async sendMail(request) {
      var res = await sb().functions.invoke('send-mail', { body: request });
      if (!res.error) return res.data;
      var body = await functionBody(res);
      var status = res.error.context && res.error.context.status;
      /* No answer of send-mail's own — the connection dropped, or the gateway
         gave up while it was still working — says nothing about whether the
         message went. Saying "not sent" invites a retry that mails someone twice. */
      var unknown = !body.error && (!status || status >= 500);
      var err = new Error(unknown
        ? 'The message may have been sent. Look in Sent before sending it again.'
        : errorMessage(res, body, 'The message was not sent.'));
      err.reconnect = body.reconnect === true;
      err.draftSaved = body.draftSaved === true;
      err.unknownOutcome = unknown;
      throw err;
    },

    /* An attachment goes to Storage before its message is sent; send-mail
       reads it from there, as the sender. <your auth id>/<a fresh folder>/<a
       plain name> is the only shape it accepts, and an upload never replaces
       another. */
    async uploadMailAttachment(file) {
      must(file && Number(file.size) > 0, '"' + String(file && file.name || 'That file') + '" is empty.');
      var session = window.workspaceSession.session;
      must(session && session.user && session.user.id, 'Sign in again to attach files.');
      var contentType = file.type || 'application/octet-stream';
      var path = session.user.id + '/' + window.crypto.randomUUID() + '/' + mailModel.storageName(file.name);
      var res = await sb().storage.from(MAIL_ATTACHMENTS).upload(path, file, { contentType: contentType, upsert: false });
      if (res.error) throw new Error('Could not attach "' + file.name + '": ' + res.error.message);
      return { path: path, name: String(file.name), size: Number(file.size), contentType: contentType };
    },

    /* Uploads for a message that will not be sent — removed, or discarded. */
    async removeMailAttachments(paths) {
      var list = (paths || []).filter(Boolean);
      if (!list.length) return;
      var res = await sb().storage.from(MAIL_ATTACHMENTS).remove(list);
      if (res.error) throw new Error('Could not remove the attachment: ' + res.error.message);
    },

    /* ── Mail: signatures ────────────────────────────────────────────── */

    /* One per mailbox (connectionId), or one for every mailbox (null). Cleaned
       before it is stored: it goes into the editor, and from there into mail
       sent under the studio's name. */
    async saveSignature(fields) {
      must(me(), 'You need to be signed in as a team member to save a signature.');
      must(window.DOMPurify, 'The editor is still loading. Try again in a moment.');
      var html = window.DOMPurify.sanitize(String(fields && fields.html || ''), mailModel.PURIFY_CONFIG);
      return one(await sb().from('mail_signatures').upsert({
        employee_id: me().id,
        connection_id: fields.connectionId || null,
        html: html,
        use_on_new: fields.useOnNew !== false,
        use_on_replies: fields.useOnReplies !== false
      }, { onConflict: 'employee_id,connection_id' }).select().single(), 'save the signature');
    }
  };
})();
