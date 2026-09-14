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

  /* supabase-js reports a missing function as a FunctionsFetchError or a 404;
     both mean "not deployed", which is a different problem from "refused". */
  function isMissingFunction(err) {
    var name = String(err && err.name || '');
    var message = String(err && err.message || '');
    return name === 'FunctionsFetchError'
        || /Failed to (send|fetch)/i.test(message)
        || (err && err.context && err.context.status === 404);
  }

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

      /* If the function is not deployed yet, a reply must still be recorded —
         losing what someone wrote is worse than not emailing it. The insert
         below is the same one RLS has always allowed, and the caller is told
         plainly that nothing was sent. */
      if (isMissingFunction(res.error)) {
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
      throw new Error(await functionError(res, 'The reply could not be sent.'));
    },

    async setTicketStatus(ticketId, status) {
      must(['open','in_progress','waiting','resolved','closed'].indexOf(status) !== -1,
           'Unknown ticket status: ' + status);
      /* resolved_at is stamped by the database, never sent from here. */
      return one(await sb().from('support_tickets')
        .update({ status: status }).eq('id', ticketId).select().single(),
        'update the ticket');
    },

    async assignTicket(ticketId, employeeId) {
      return one(await sb().from('support_tickets')
        .update({ assignee_id: employeeId || null }).eq('id', ticketId).select().single(),
        'reassign the ticket');
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
        assignee_id: fields.assigneeId || (me() ? me().id : null)
      }).select().single(), 'create the ticket');
    },

    /* ── Tasks ───────────────────────────────────────────────────────── */

    /* An assignee may move their own task along and nothing else — the column
       guard (0022) silently restores title, project, priority and due date if
       a non-manager sends them, so do not bother sending them. */
    async setTaskDone(taskId, done) {
      return one(await sb().from('tasks').update({
        status: done ? 'done' : 'todo',
        completed_at: done ? new Date().toISOString() : null
      }).eq('id', taskId).select().single(), 'update the task');
    },

    async createTask(fields) {
      must(fields && fields.title && fields.title.trim(), 'A task needs a title.');
      return one(await sb().from('tasks').insert({
        title: fields.title.trim(),
        details: fields.details || null,
        project_id: fields.projectId || null,
        assignee_id: fields.assigneeId || (me() ? me().id : null),
        priority: fields.priority || 'normal',
        due_date: fields.dueDate || null,
        created_by: window.workspaceSession.session
          ? window.workspaceSession.session.user.id : null
      }).select().single(), 'create the task');
    },

    /* ── Projects ────────────────────────────────────────────────────── */

    async createProject(fields) {
      must(fields && fields.name && fields.name.trim(), 'A project needs a name.');
      return one(await sb().from('client_projects').insert({
        name: fields.name.trim(),
        company_id: fields.companyId || null,
        code: fields.code || null,
        accent: fields.accent || 'default',
        status: fields.status || 'discovery',
        description: fields.description || null,
        due_on: fields.dueOn || null,
        owner_id: fields.ownerId || (me() ? me().id : null)
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
      var allowed = ['name', 'description', 'company_id', 'owner_id', 'due_on'];
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

    /* ── CRM ─────────────────────────────────────────────────────────── */

    async createCompany(fields) {
      must(fields && fields.name && fields.name.trim(), 'A company needs a name.');
      /* Bare host only: the domain is what inbound mail is matched on, so
         "https://www.northline.example/" must not become a second company. */
      var domain = (fields.domain || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;
      return one(await sb().from('crm_companies').insert({
        name: fields.name.trim(), domain: domain,
        kind: fields.kind || 'prospect', stage: fields.stage || 'lead',
        value: fields.value ?? null, notes: fields.notes || null,
        owner_id: fields.ownerId || (me() ? me().id : null)
      }).select().single(), 'add the company');
    },

    async createContact(fields) {
      must(fields && fields.fullName && fields.fullName.trim(), 'A contact needs a name.');
      return one(await sb().from('crm_contacts').insert({
        full_name: fields.fullName.trim(),
        company_id: fields.companyId || null,
        email: (fields.email || '').trim().toLowerCase() || null,
        phone: fields.phone || null, title: fields.title || null,
        notes: fields.notes || null
      }).select().single(), 'add the contact');
    },

    async updateContact(contactId, fields) {
      return one(await sb().from('crm_contacts')
        .update(fields).eq('id', contactId).select().single(), 'update the contact');
    },

    /* Turn a /websites/ enquiry into a company + contact. Safe to call twice:
       the function returns the same contact rather than making a duplicate. */
    async promoteEnquiry(enquiryId) {
      var res = await sb().rpc('promote_enquiry_to_crm', { p_enquiry_id: enquiryId });
      if (res.error) throw new Error('Could not promote the enquiry: ' + res.error.message);
      return res.data;
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
         phone too. 409 means nothing is connected — then a local-only event is
         the right answer, not an error. */
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

      var status = res.error && res.error.context && res.error.context.status;
      if (status && status !== 409 && !isMissingFunction(res.error)) {
        throw new Error(await functionError(res, 'The event could not be booked.'));
      }

      /* Local only: connection_id and external_id stay null, which is what the
         RLS policy for a hand-made event requires and what keeps it out of the
         sync's unique index. */
      return one(await sb().from('calendar_events').insert({
        title: fields.title.trim(),
        detail: fields.detail || null, location: fields.location || null,
        starts_at: startsAt, ends_at: endsAt,
        all_day: !!fields.allDay, kind: fields.kind || 'internal',
        project_id: fields.projectId || null, company_id: fields.companyId || null,
        created_by: me() ? me().id : null
      }).select().single(), 'add the event');
    },

    async deleteEvent(eventId) {
      var res = await sb().from('calendar_events').delete().eq('id', eventId);
      if (res.error) throw new Error('Could not remove the event: ' + res.error.message);
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

    async deleteNote(noteId) {
      var res = await sb().from('workspace_notes').delete().eq('id', noteId);
      if (res.error) throw new Error('Could not remove the note: ' + res.error.message);
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

    /* ── Connections ─────────────────────────────────────────────────── */

    /* Starts reconnecting a mailbox and resolves to Microsoft's consent page.
       No employeeId is sent: microsoft-connect then keeps whose mailbox it is
       and who consented to it. Only ever a Microsoft sign-in page — the page is
       opened as it comes back, so anything else is refused rather than
       followed. Managers only; the function says so to anyone else. */
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
