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

  /* supabase-js reports a missing function as a FunctionsFetchError or a 404;
     both mean "not deployed", which is a different problem from "refused". */
  function isMissingFunction(err) {
    var name = String(err && err.name || '');
    var message = String(err && err.message || '');
    return name === 'FunctionsFetchError'
        || /Failed to (send|fetch)/i.test(message)
        || (err && err.context && err.context.status === 404);
  }

  /* An Edge Function's own { error } body is more useful than the generic
     "Edge Function returned a non-2xx status code" supabase-js surfaces. */
  function readFunctionError(res) {
    var fromBody = res.data && res.data.error;
    if (fromBody) return fromBody;
    return (res.error && res.error.message) || 'The reply could not be sent.';
  }

  function must(condition, message) {
    if (!condition) throw new Error(message);
  }

  function one(res, what) {
    if (res.error) throw new Error('Could not ' + what + ': ' + res.error.message);
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
      throw new Error(readFunctionError(res));
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
        throw new Error(readFunctionError(res));
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

    async markThreadRead(threadId, read) {
      return one(await sb().from('mail_threads')
        .update({ is_read: read !== false }).eq('id', threadId).select().single(),
        'update the thread');
    },

    async starThread(threadId, starred) {
      return one(await sb().from('mail_threads')
        .update({ is_starred: !!starred }).eq('id', threadId).select().single(),
        'star the thread');
    }
  };
})();
