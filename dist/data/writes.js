/* writes.js — makes the interactive bits actually write to the database.
 *
 * app.js and workspace.js already handle these events; their handlers update
 * the in-memory arrays and re-render, which was right when the arrays were the
 * only source of truth. Now the database is.
 *
 * These listeners run in the CAPTURE phase AND this file is loaded before
 * app.js and workspace.js. Both halves matter: workspace.js also binds with
 * capture and calls stopImmediatePropagation() for exactly these targets, and
 * capture listeners on the same node fire in REGISTRATION order. Loading this
 * afterwards means it never runs at all — which looks like it works, because
 * the old in-memory handler still ticks the box and still says "Task
 * completed".
 *
 * Deliberately NOT optimistic. The obvious version ticks the box immediately
 * and writes in the background, which looks faster and quietly lies whenever
 * the write is refused — and RLS refuses plenty here by design (an assignee
 * cannot re-file a task; a non-manager cannot delete). Waiting for the round
 * trip means what is on screen is what is in the database.
 */
(function () {
  'use strict';

  function live() {
    return window.workspaceStore && window.workspaceStore.state.loaded;
  }

  /* The app keeps no companies array — they arrive attached to contacts. */
  function companies() {
    var seen = {};
    return contacts.reduce(function (acc, c) {
      var co = c.row && c.row.company;
      if (co && !seen[co.id]) { seen[co.id] = 1; acc.push(co); }
      return acc;
    }, []);
  }

  function fail(err) {
    console.error('[workspace] write failed:', err);
    if (typeof toast === 'function') toast(err.message || 'That did not save.');
  }

  /* A checkbox that has already flipped in the DOM but not yet in the database
     is a lie in progress; put it back until the write lands. */
  document.addEventListener('change', function (e) {
    var box = e.target.closest && e.target.closest('[data-project-task]');
    if (!box || !live()) return;
    e.stopImmediatePropagation();
    e.preventDefault();

    var project = window.workspaceStore.projectByIndex(Number(box.dataset.projectTask));
    var index = Number(box.dataset.task);
    var taskId = project && project.taskIds && project.taskIds[index];
    if (!taskId) return;

    var wanted = box.checked;
    box.disabled = true;
    window.workspaceStore
      .after(window.workspaceActions.setTaskDone(taskId, wanted))
      .then(function () {
        if (typeof toast === 'function') toast(wanted ? 'Task completed' : 'Task reopened');
      })
      .catch(function (err) { box.checked = !wanted; fail(err); })
      .then(function () { box.disabled = false; });
  }, true);

  /* "Create ticket" on a mail thread. app.js handled this by inventing a
     ticket in memory; the database now opens a real one and brings the
     conversation with it. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-action="email-ticket"]');
    if (!btn || !live()) return;
    var thread = mails[typeof selectedMail === 'number' ? selectedMail : 0];
    if (!thread || !thread.id) return;
    e.stopImmediatePropagation();
    e.preventDefault();

    if (thread.row && thread.row.ticket_id) {
      /* Already has one — go to it rather than pretending to make another. */
      var existing = tickets.filter(function (t) { return t.uuid === thread.row.ticket_id; })[0];
      if (existing) { location.hash = '#tickets/' + existing.id; return; }
    }

    btn.disabled = true;
    window.workspaceStore
      .after(window.workspaceActions.createTicketFromThread(thread.id, thread.row && thread.row.product))
      .then(function (ticketId) {
        var made = tickets.filter(function (t) { return t.uuid === ticketId; })[0];
        if (typeof toast === 'function') toast(made ? 'Ticket #VYG-' + made.id + ' opened' : 'Ticket opened');
        if (made) location.hash = '#tickets/' + made.id;
      })
      .catch(fail)
      .then(function () { btn.disabled = false; });
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.matches || !live()) return;

    /* Add a task to a project. */
    if (form.matches('[data-add-task]')) {
      e.stopImmediatePropagation();
      e.preventDefault();
      var title = String(new FormData(form).get('task') || '').trim();
      if (!title) return;
      var project = window.workspaceStore.projectByIndex(Number(form.dataset.addTask));
      if (!project) return;
      form.reset();
      window.workspaceStore
        .after(window.workspaceActions.createTask({ title: title, projectId: project.uuid }))
        .then(function () { if (typeof toast === 'function') toast('Task added'); })
        .catch(fail);
      return;
    }

    /* Notes on a record. The form is keyed by (kind, id); the store knows
       which row that means. */
    if (form.matches('[data-note-form]')) {
      e.stopImmediatePropagation();
      e.preventDefault();
      var noteBody = String(new FormData(form).get('note') || '').trim();
      if (!noteBody) return;
      var target = window.workspaceStore.noteTarget(form.dataset.noteForm, form.dataset.recordId);
      if (!target) { fail(new Error('That record is not loaded.')); return; }
      form.reset();
      window.workspaceStore
        .after(window.workspaceActions.addNote(target.type, target.id, noteBody))
        .then(function () { if (typeof toast === 'function') toast('Note saved'); })
        .catch(fail);
      return;
    }

    /* The "Create new" dialog. app.js pushed the new row into the in-memory
       array; these create it for real and reload, so what appears on screen is
       what the database accepted — including the parts it fills in itself, like
       a ticket's number. */
    if (form.id === 'create-form') {
      e.stopImmediatePropagation();
      e.preventDefault();
      var d = new FormData(form);
      var kind = form.dataset.kind;
      var name = String(d.get('name') || '').trim();
      var context = String(d.get('context') || '').trim();
      var description = String(d.get('description') || '').trim();
      if (!name || !context) return;

      var A = window.workspaceActions;
      var lower = function (s) { return String(s || '').trim().toLowerCase(); };
      var companyNamed = function (n) {
        var hit = companies().filter(function (c) { return lower(c.name) === lower(n); })[0];
        return hit ? hit.id : null;
      };
      var contactNamed = function (n) {
        var hit = contacts.filter(function (c) { return lower(c.name) === lower(n); })[0];
        return hit ? hit.row.id : null;
      };

      var work;
      if (kind === 'tickets') {
        /* Low / Medium / High in the form; low / normal / high in the database. */
        var priority = { Low: 'low', Medium: 'normal', High: 'high' }[String(d.get('priority'))] || 'normal';
        work = A.createTicket({
          subject: name, product: context, priority: priority,
          contactId: contactNamed(context)
        }).then(function (ticket) {
          /* The description becomes the opening message, so the thread reads
             from the beginning rather than starting with our reply. */
          if (!description) return ticket;
          return A.replyToTicket(ticket.id, description, 'note').then(function () { return ticket; });
        });

      } else if (kind === 'projects') {
        /* A client name that is not in the CRM yet is a new client, not a
           typo — that is what someone means when they type it here. */
        work = Promise.resolve(companyNamed(context)).then(function (id) {
          if (id || /^internal/i.test(context)) return id;
          return A.createCompany({ name: context, kind: 'client', stage: 'client' })
                  .then(function (c) { return c.id; });
        }).then(function (companyId) {
          return A.createProject({
            name: name, companyId: companyId, description: description,
            code: name.charAt(0).toUpperCase(), accent: companyId ? 'client' : 'default'
          });
        });

      } else if (kind === 'crm') {
        work = Promise.resolve(companyNamed(context)).then(function (id) {
          if (id) return id;
          return A.createCompany({ name: context }).then(function (c) { return c.id; });
        }).then(function (companyId) {
          return A.createContact({
            fullName: name, companyId: companyId,
            email: String(d.get('email') || ''), notes: description
          });
        });

      } else if (kind === 'agenda') {
        var start = String(d.get('time') || '');
        var end = String(d.get('end') || '');
        if (end <= start) {
          var endField = form.querySelector('[name="end"]');
          endField.setCustomValidity('End time must be after the start time.');
          endField.reportValidity();
          return;
        }
        /* The day arrives as a full date (YYYY-MM-DD), not a day number. A
           form left open across midnight on a Friday used to look the number
           up in the NEXT week's grid, miss, fall back to "today" and book the
           event on Saturday. A date that cannot be read is refused instead. */
        var base = CAL.parseDayKey(String(d.get('day') || ''));
        if (!base) {
          var dayField = form.querySelector('[name="day"]');
          dayField.setCustomValidity('Pick the day again — the week has changed.');
          dayField.addEventListener('change', function () { dayField.setCustomValidity(''); }, { once: true });
          dayField.reportValidity();
          return;
        }
        var iso = function (hhmm) {
          var parts = hhmm.split(':');
          return new Date(base.getFullYear(), base.getMonth(), base.getDate(),
                          Number(parts[0]), Number(parts[1]));
        };
        work = A.createEvent({
          title: name, detail: context, startsAt: iso(start), endsAt: iso(end),
          kind: /client|meeting/i.test(context) ? 'client' : 'internal'
        });
      } else {
        return;
      }

      var modal = document.getElementById('modal');
      var outcome = null;
      work.then(function (result) {
        outcome = result;
        if (modal && modal.close) modal.close();
        return window.workspaceStore.reload();
      }).then(function () {
        if (typeof toast !== 'function') return;
        /* Say where it went. An event that only exists here is a different
           thing from one that is now in your diary. */
        if (kind === 'agenda') {
          return toast(outcome && outcome.calendar
            ? 'Added to ' + outcome.calendar
            : 'Saved here — no calendar is connected yet');
        }
        toast('Saved to the workspace');
      }).catch(fail);
      return;
    }

    /* Reply to a ticket, or leave an internal note. The form's id is the
       ticket NUMBER — what is in the URL — so it is exchanged for the uuid
       here rather than anywhere a person could see or edit it. */
    if (form.matches('[data-ticket-reply]')) {
      e.stopImmediatePropagation();
      e.preventDefault();
      var data = new FormData(form);
      var body = String(data.get('body') || '').trim();
      if (!body) return;
      var internal = /note/i.test(String(data.get('mode') || ''));
      var ticket = window.workspaceStore.ticketByNumber(form.dataset.ticketReply);
      if (!ticket) return;
      form.reset();
      window.workspaceStore
        .after(window.workspaceActions.replyToTicket(ticket.uuid, body, internal ? 'note' : 'reply'))
        .then(function (result) {
          if (typeof toast !== 'function') return;
          /* Say what actually happened. "Reply posted" next to a reply that
             never left is the failure this whole path exists to avoid. */
          if (internal) return toast('Note added');
          if (result && result.sent) return toast('Reply sent to ' + result.to);
          toast((result && result.reason) || 'Saved, but not sent.');
        })
        .catch(fail);
    }
  }, true);
})();
