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

  /* Every company a typed name can mean: those loaded with the workspace —
     including the ones with no contacts yet — and any that arrived attached to
     a contact since. Only looking at contacts' companies is how a second
     company with the same name got created. */
  function companies() {
    var seen = {};
    var loaded = (window.workspaceStore && window.workspaceStore.state.companies) || [];
    /* A contact's company counts only if it is one of the companies loaded:
       the contacts embed does not leave deleted companies out. Until companies
       have loaded at all, contacts are all there is. */
    var known = {};
    loaded.forEach(function (c) { known[c.id] = 1; });
    var fromContacts = contacts
      .map(function (c) { return c.row && c.row.company; })
      .filter(function (co) { return co && (!loaded.length || known[co.id]); });
    return loaded.map(function (c) { return c.row || c; }).concat(fromContacts).filter(function (co) {
      if (!co || seen[co.id]) return false;
      seen[co.id] = 1;
      return true;
    });
  }

  function fail(err) {
    console.error('[workspace] write failed:', err);
    if (typeof toast === 'function') toast(err.message || 'That did not save.');
  }

  /* A value as a CSS attribute selector quotes it. */
  function attr(value) {
    return String(value == null ? '' : value).replace(/["\\]/g, '\\$&');
  }

  /* Tickets whose last reply got no answer, and so may have gone. */
  var replyMayHaveGone = {};

  /* A new ticket opens on its own page. When its opening note did not save,
     what was typed waits in the note box there — kept as the ticket's draft
     before the page is drawn, and kept even when the ticket has not loaded yet.
     The create form is closed: sending it again would open a second ticket. */
  function openNewTicket(outcome) {
    var number = outcome && outcome.ticket ? outcome.ticket.number : null;
    if (number == null) return toast('Ticket opened');
    var kept = Boolean(outcome.unsaved && window.ticketDrafts);
    if (kept) window.ticketDrafts.keep(number, { body: outcome.typed, mode: 'note' });
    if (typeof navigate === 'function') navigate('tickets/' + number);
    if (!outcome.unsaved) return toast('Ticket #VYG-' + number + ' opened');
    toast(outcome.unknown
      ? 'Ticket #VYG-' + number + ' opened. Whether its description saved is not known: look at the conversation before adding it again.'
        + (kept ? ' It is waiting in the note box on the ticket.' : '')
      : 'Ticket #VYG-' + number + ' opened, but its description did not save: ' + outcome.unsaved
        + (kept ? ' It is waiting in the note box on the ticket, ready to send again.' : ''));
  }

  /* A write before the workspace has loaded has nowhere real to go, and the
     offline handlers it would fall through to only pretend ("Updated in this
     demo session"). Say so instead. */
  function notYet() {
    var notice = window.workspaceStore && window.workspaceStore.state.notice;
    if (typeof toast !== 'function') return;
    toast(notice && notice.kind === 'blocked'
      ? 'Not saved: the workspace could not load. Try again once it has.'
      : 'Not saved: the workspace is still loading. Try again in a moment.');
  }

  /* A new project or contact matches its typed client name against the
     companies that loaded, and creates one when none matches. If companies
     never arrived, it would quietly create a second one. A ticket only links
     to what it finds, so it needs nothing. */
  function missingFor(kind) {
    /* A contact is added from crm-forms.js's dialog, which checks for itself. */
    var needs = { projects: ['companies'] }[kind] || [];
    return needs.filter(function (key) { return !window.workspaceStore.has(key); });
  }

  /* Moving through a closed select with the arrow keys fires a change for every
     option passed (Chrome and Firefox on Windows and Linux). A status is saved
     once the choice settles, not once per key. */
  var STATUS_SETTLE_MS = 600;
  var statusTimers = {};

  function resetSelect(select) {
    var shown = [].filter.call(select.options, function (o) { return o.defaultSelected; })[0];
    if (shown) select.value = shown.value;
  }

  /* A checkbox that has already flipped in the DOM but not yet in the database
     is a lie in progress; put it back until the write lands. */
  document.addEventListener('change', function (e) {
    var box = e.target.closest && e.target.closest('[data-project-task]');
    if (!box || !window.workspaceStore) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!live()) { box.checked = !box.checked; notYet(); return; }

    var project = window.workspaceStore.projectById(box.dataset.projectTask);
    /* By the task's own id: a background load can replace the list between the
       render and the tick, and a position would then name another task. */
    var taskId = box.dataset.taskId
      || (project && project.taskIds && project.taskIds[Number(box.dataset.task)]);
    if (!project || !taskId || project.taskIds.indexOf(taskId) < 0) {
      box.checked = !box.checked;
      fail(new Error('That task has changed since the page was drawn. Try again.'));
      return;
    }

    var wanted = box.checked;
    /* In line with the task's status select (tasks-ui.js): a tick waits for a
       status on its way, and a status picked after it compares with the tick.
       Saved apart, the two raced, and the later answer won whatever was picked. */
    if (typeof tasksUi !== 'undefined' && typeof tasksUi.setStatus === 'function') {
      tasksUi.setStatus(taskId, wanted ? 'done' : 'todo');
      return;
    }
    box.disabled = true;
    window.workspaceStore
      .after(window.workspaceActions.setTaskDone(taskId, wanted))
      .then(function () {
        if (typeof toast === 'function') toast(wanted ? 'Task completed' : 'Task reopened');
      })
      .catch(function (err) { box.checked = !wanted; fail(err); })
      .then(function () { box.disabled = false; });
  }, true);

  /* A project's status, from the select on its page. workspace.js changed it
     in memory and said "Updated in this demo session"; nothing was saved, and
     a reload put the old status back. */
  document.addEventListener('change', function (e) {
    var select = e.target.closest && e.target.closest('[data-record-kind="projects"][data-field="status"]');
    if (!select || !window.workspaceStore) return;
    e.stopImmediatePropagation();
    if (!live()) { resetSelect(select); notYet(); return; }

    var project = window.workspaceStore.projectById(select.dataset.recordId);
    var status = projectsModel.statusValue(select.value);
    if (!project || !status) {
      resetSelect(select);
      fail(new Error('That project is not loaded any more. Reload the page and try again.'));
      return;
    }

    clearTimeout(statusTimers[project.uuid]);
    statusTimers[project.uuid] = setTimeout(function () {
      delete statusTimers[project.uuid];
      var chosen = projectsModel.statusValue(select.value);
      if (!chosen || select.value === project.status) return;
      var label = select.value;
      window.workspaceStore
        .after(window.workspaceActions.setProjectStatus(project.uuid, chosen))
        .then(function () { if (typeof toast === 'function') toast('Status saved: ' + label); })
        .catch(function (err) { select.value = project.status; fail(err); });
    }, STATUS_SETTLE_MS);
  }, true);

  /* A ticket's status, priority and owner, from the selects on its page. The
     view changed them on screen and said "Updated in this demo session";
     nothing was saved, and a reload put them back. Settled like a project's
     status, and put back when the save is refused. */
  /* The value of each ticket field on its way to the database, and each
     field's saves, one after another. */
  var ticketSaving = {};
  var ticketSaves = {};

  var TICKET_FIELDS = {
    status: {
      stored: function (t) { return ticketsModel.statusOf(t); },
      save: function (A, id, value) { return A.setTicketStatus(id, value); },
      said: 'Status saved'
    },
    priority: {
      stored: function (t) { return ticketsModel.priorityOf(t); },
      save: function (A, id, value) { return A.setTicketPriority(id, value); },
      said: 'Priority saved'
    },
    owner: {
      stored: function (t) { return ticketsModel.assigneeOf(t) || ''; },
      save: function (A, id, value) { return A.assignTicket(id, value || null); },
      said: 'Owner saved'
    }
  };

  document.addEventListener('change', function (e) {
    var select = e.target.closest && e.target.closest('[data-record-kind="tickets"][data-field]');
    if (!select || !window.workspaceStore) return;
    e.stopImmediatePropagation();
    if (!live()) { resetSelect(select); notYet(); return; }

    var field = TICKET_FIELDS[select.dataset.field];
    var number = select.dataset.recordId;
    var ticket = window.workspaceStore.ticketByNumber(number);
    if (!field || !ticket) {
      resetSelect(select);
      fail(new Error('That ticket is not loaded any more. Reload the page and try again.'));
      return;
    }

    var key = ticket.uuid + ':' + select.dataset.field;
    clearTimeout(statusTimers[key]);
    statusTimers[key] = setTimeout(function () {
      delete statusTimers[key];
      /* Compared with the value on its way to the database, else with what is
         stored now. Until a save's reload lands the loaded ticket still has the
         old value, and changing it back compared equal and saved nothing. */
      var current = window.workspaceStore.ticketByNumber(number) || ticket;
      var chosen = select.value;
      var baseline = Object.prototype.hasOwnProperty.call(ticketSaving, key) ? ticketSaving[key] : field.stored(current);
      if (chosen === baseline) return;
      ticketSaving[key] = chosen;
      var shown = select.options && select.options[select.selectedIndex];
      var said = field.said + ': ' + (shown ? shown.text : chosen);
      /* One save of a field at a time, in the order chosen. */
      ticketSaves[key] = (ticketSaves[key] || Promise.resolve())
        .then(function () { return window.workspaceStore.after(field.save(window.workspaceActions, ticket.uuid, chosen)); })
        .then(function () { if (typeof toast === 'function') toast(said); },
              function (err) { resetSelect(select); fail(err); })
        .then(function () { if (ticketSaving[key] === chosen) delete ticketSaving[key]; });
    }, STATUS_SETTLE_MS);
  }, true);

  /* Resolve or reopen, from the button beside a ticket's title. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-ticket-status]');
    if (!btn || !window.workspaceStore) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!live()) { notYet(); return; }
    var ticket = window.workspaceStore.ticketByNumber(btn.dataset.ticket);
    var status = btn.dataset.ticketStatus;
    if (!ticket) { fail(new Error('That ticket is not loaded any more. Reload the page and try again.')); return; }
    btn.disabled = true;
    /* In line with the status select's saves (TICKET_FIELDS, above): resolving
       while a status change is on its way waits for it, and a change made
       after compares with this one. */
    var key = ticket.uuid + ':status';
    ticketSaving[key] = status;
    ticketSaves[key] = (ticketSaves[key] || Promise.resolve())
      .then(function () { return window.workspaceStore.after(window.workspaceActions.setTicketStatus(ticket.uuid, status)); })
      .then(function () {
        if (typeof toast === 'function') toast(status === 'resolved' ? 'Ticket resolved' : 'Ticket reopened');
      }, fail)
      .then(function () {
        if (ticketSaving[key] === status) delete ticketSaving[key];
        btn.disabled = false;
      });
  }, true);

  /* "Create ticket" on a mail thread. app.js handled this by inventing a
     ticket in memory; the database now opens a real one and brings the
     conversation with it. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-action="email-ticket"]');
    if (!btn || !live()) return;
    /* By id, from the button itself. The list is filtered by mailbox, folder
       and search, so a position in `mails` means nothing outside one view. */
    var thread = mails.filter(function (m) { return m.id === btn.dataset.threadId; })[0];
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
    if (!form || !form.matches || !window.workspaceStore) return;
    if (!live()) {
      var ours = form.id === 'create-form' || form.matches('[data-note-form], [data-ticket-reply]');
      if (!ours) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      notYet();
      return;
    }

    /* Notes on a record. The form is keyed by (kind, id); the store knows
       which row that means. What was written stays in the box until the
       database has it — a note that could not be saved is not lost — and the
       button waits for the save, so a second press does not save it twice.
       (A task is added from its project's page by tasks-ui.js.) */
    if (form.matches('[data-note-form]')) {
      e.stopImmediatePropagation();
      e.preventDefault();
      var noteBody = String(new FormData(form).get('note') || '').trim();
      if (!noteBody) return;
      var target = window.workspaceStore.noteTarget(form.dataset.noteForm, form.dataset.recordId);
      if (!target) { fail(new Error('That record is not loaded.')); return; }
      var noteButton = form.querySelector('button[type="submit"]');
      var noteBox = form.querySelector('textarea[name="note"]');
      if (noteButton && noteButton.disabled) return;
      /* One save of a record's note at a time — also from its box drawn again
         while the first went, when someone went to another tab and back. */
      var saves = window.noteDrafts && typeof window.noteDrafts.isSaving === 'function' ? window.noteDrafts : null;
      if (saves && saves.isSaving(form.dataset.noteForm, form.dataset.recordId)) {
        if (typeof toast === 'function') toast('That note is still saving.');
        return;
      }
      if (saves) saves.startSaving(form.dataset.noteForm, form.dataset.recordId);
      if (noteButton) noteButton.disabled = true;
      /* Nothing typed while it saves: words added then went out again, with
         what was saved, at the next press. */
      if (noteBox) noteBox.readOnly = true;
      var noteSaved = false;
      var noteAdded = Promise.resolve(window.workspaceActions.addNote(target.type, target.id, noteBody))
        .then(function (row) {
          /* Saved: the words kept for the box (notes-ui.js) go before the page
             is drawn again with them — unless more was written meanwhile. */
          if (window.noteDrafts) window.noteDrafts.sent(form.dataset.noteForm, form.dataset.recordId, noteBody);
          return row;
        });
      window.workspaceStore
        .after(noteAdded)
        .then(function () {
          noteSaved = true;
          /* Cleared only while it holds what was saved: anything typed since
             stays. A box drawn with kept words resets to them, so it is
             emptied too. */
          if (!noteBox || String(noteBox.value || '').trim() === noteBody) {
            form.reset();
            if (noteBox) noteBox.value = '';
          }
          if (typeof toast === 'function') toast('Note saved.');
        })
        .catch(fail)
        .then(function () {
          if (saves) saves.doneSaving(form.dataset.noteForm, form.dataset.recordId);
          if (noteButton) noteButton.disabled = false;
          if (noteBox) noteBox.readOnly = false;
          /* The button went off under the keyboard while the note saved. A saved
             note's page is drawn again, so the keyboard goes to the box on it,
             for the next note; a refused one's, to the button, to send again. */
          if (document.activeElement && document.activeElement !== document.body) return;
          var next = noteSaved
            ? document.querySelector('[data-note-form="' + attr(form.dataset.noteForm) + '"][data-record-id="' + attr(form.dataset.recordId) + '"] textarea')
            : noteButton;
          if (next && next.focus) next.focus();
        });
      return;
    }

    /* The "Create new" dialog. app.js pushed the new row into the in-memory
       array; these create it for real and reload, so what appears on screen is
       what the database accepted — including the parts it fills in itself, like
       a ticket's number. */
    if (form.id === 'create-form') {
      e.stopImmediatePropagation();
      e.preventDefault();
      /* One create per click. A double click, or Enter pressed twice, used to
         look the company up twice before either insert landed: two companies,
         two projects. */
      if (form.dataset.pending === '1') return;
      var d = new FormData(form);
      var kind = form.dataset.kind;
      var name = String(d.get('name') || '').trim();
      var context = String(d.get('context') || '').trim();
      var description = String(d.get('description') || '').trim();
      if (!name || !context) return;
      var missing = missingFor(kind);
      if (missing.length) {
        fail(new Error('Not saved: ' + missing.join(' and ') + ' did not load, and without them this could ' +
                       'create a duplicate. Try again once they have.'));
        return;
      }

      var A = window.workspaceActions;
      var lower = function (s) { return String(s || '').trim().toLowerCase(); };
      /* Two companies with the same name: the person chooses, not the first in
         the alphabet. Thrown inside the chain, so it arrives as a message. */
      var companyNamed = function (n) {
        var matches = projectsModel.matchCompanies(companies(), n);
        if (matches.length > 1) {
          throw new Error('More than one company is called "' + String(n).trim() + '". Rename one in the CRM, then try again.');
        }
        return matches.length ? matches[0].id : null;
      };
      /* A ticket's requester: by address, or by a name only one contact has.
         Two with that name is a question for the person, not a guess. */
      var contactFor = function (n) {
        var wanted = lower(n);
        var byAddress = contacts.filter(function (c) {
          return lower(c.email) === wanted || lower(c.row && c.row.email) === wanted;
        });
        if (byAddress.length) return byAddress[0];
        var byName = contacts.filter(function (c) { return lower(c.name) === wanted; });
        if (byName.length > 1) {
          throw new Error('More than one contact is called "' + String(n).trim() + '". Type their email address instead.');
        }
        return byName[0] || null;
      };
      /* Whose ticket it is, by id: the named contact's company, or the one
         company with exactly that name. It puts the ticket on that client's
         project pages until someone files it under a project. */
      var ticketCompany = function (n) {
        var hit = contacts.filter(function (c) { return lower(c.name) === lower(n); })[0];
        if (hit && hit.row && hit.row.company && hit.row.company.id) return hit.row.company.id;
        var company = projectsModel.findCompany(companies(), n);
        return company ? company.id : null;
      };

      var work;
      if (kind === 'tickets') {
        /* Low / Normal / High / Urgent in the form, as the database has them —
           and Medium, from a form still open since before, as normal. */
        var priority = { Low: 'low', Normal: 'normal', Medium: 'normal', High: 'high', Urgent: 'urgent' }[String(d.get('priority'))] || 'normal';
        /* The requester is the customer, found by address or by a name only one
           contact has — never the product, where it used to be filed. One the
           CRM does not know is written into the opening note, so what was typed
           is not lost — and, when what was typed is itself an address, kept on
           the ticket too (requesterEmail), so a reply still has somewhere to go
           without waiting for someone to add them to the CRM (audit #1).
           Looked up inside the chain, so a refusal is said. */
        work = Promise.resolve(context).then(contactFor).then(function (requester) {
          var typedAddress = !requester && typeof mailModel !== 'undefined' && mailModel.isAddress(context) ? context.trim() : null;
          var opening = requester ? description
            : ['Requester: ' + context, description].filter(Boolean).join('\n\n');
          return A.createTicket(Object.assign({
            subject: name, product: null, priority: priority,
            contactId: requester ? requester.row.id : null,
            companyId: requester && requester.row.company ? requester.row.company.id : ticketCompany(context)
          }, typedAddress ? { requesterEmail: typedAddress } : {})).then(function (ticket) {
            /* The description opens the thread, so it reads from the beginning
               rather than starting with our reply. */
            if (!opening) return { ticket: ticket };
            return A.replyToTicket(ticket.id, opening, 'note')
              .then(function () { return { ticket: ticket }; })
              /* The ticket exists now: failing here must not bring the form
                 back, where sending it again would open a second ticket. */
              .catch(function (err) {
                return {
                  ticket: ticket, unsaved: err.message || 'it could not be saved.', typed: opening,
                  unknown: Boolean(err && err.unknownOutcome)
                };
              });
          });
        });

      } else if (kind === 'projects') {
        /* A client name that is not in the CRM yet is a new client, not a
           typo — that is what someone means when they type it here. */
        work = Promise.resolve(context).then(companyNamed).then(function (id) {
          if (id || /^internal/i.test(context)) return id;
          return A.createCompany({ name: context, kind: 'client', stage: 'client' })
                  .then(function (c) { return c.id; });
        }).then(function (companyId) {
          return A.createProject({
            name: name, companyId: companyId, description: description,
            code: name.charAt(0).toUpperCase(), accent: companyId ? 'client' : 'default'
          });
        });

      } else {
        /* A new event is event-edit.js's own dialog, and a contact
           crm-forms.js's. */
        return;
      }

      form.dataset.pending = '1';
      var submitButton = form.querySelector('button:not([type="button"])');
      if (submitButton) submitButton.disabled = true;
      var modal = document.getElementById('modal');
      var outcome = null;
      var created = false;
      work.then(function (result) {
        created = true;
        outcome = result;
        if (modal && modal.close) modal.close();
        return window.workspaceStore.reload();
      }).then(function () {
        if (typeof toast !== 'function') return;
        if (kind === 'tickets') return openNewTicket(outcome);
        toast('Saved to the workspace');
      }).catch(function (err) {
        /* Not created: the form is still open, and can be sent again. */
        if (!created) {
          form.dataset.pending = '';
          if (submitButton) submitButton.disabled = false;
        }
        fail(err);
      });
      return;
    }

    /* Reply to a ticket, or leave an internal note. The form's id is the
       ticket NUMBER — what is in the URL — so it is exchanged for the uuid
       here rather than anywhere a person could see or edit it. */
    if (form.matches('[data-ticket-reply]')) {
      e.stopImmediatePropagation();
      e.preventDefault();
      /* One send per click: Enter pressed twice would email the customer twice. */
      if (form.dataset.pending === '1') return;
      var data = new FormData(form);
      var body = String(data.get('body') || '').trim();
      if (!body) return;
      var internal = String(data.get('mode') || '') === 'note';
      var thenWaiting = Boolean(data.get('thenWaiting'));
      var number = form.dataset.ticketReply;
      var ticket = window.workspaceStore.ticketByNumber(number);
      if (!ticket) { fail(new Error('That ticket is not loaded any more. Reload the page and try again.')); return; }
      /* A reply whose answer never arrived may have gone: sending again asks. */
      if (!internal && replyMayHaveGone[number] && typeof window.confirm === 'function'
          && !window.confirm('The last reply may already have been sent. Look at the conversation first. Send it again anyway?')) {
        return;
      }
      /* What was written stays until it is saved — in the box, and in the
         drafts every repaint draws the box from (tickets-ui.js). */
      form.dataset.pending = '1';
      var sendButton = form.querySelector('button[type="submit"]');
      if (sendButton) sendButton.disabled = true;
      var sent = window.workspaceActions.replyToTicket(ticket.uuid, body, internal ? 'note' : 'reply')
        .then(function (result) {
          /* Before the repaint that shows it in the conversation. A note says
             nothing about whether the last reply went. */
          if (window.ticketDrafts) window.ticketDrafts.sent(number, body);
          if (!internal) delete replyMayHaveGone[number];
          return result;
        });
      window.workspaceStore
        .after(sent)
        .then(function (result) {
          var box = form.querySelector('textarea[name="body"]');
          if (box && box.value.trim() === body) box.value = '';
          /* "Reply and set to Waiting": only once the reply is confirmed
             sent — a status that says the studio is waiting on the customer
             is not true of a reply that was only saved, or one whose
             delivery is not known (result.sent is exactly that: false for
             both, unlike a thrown, unknownOutcome error, which never reaches
             here at all — see the catch below). A second save through the
             same chain every other ticket field already uses. */
          if (!internal && thenWaiting && result && result.sent) {
            return window.workspaceStore.after(window.workspaceActions.setTicketStatus(ticket.uuid, 'waiting'))
              .then(function () {
                if (typeof toast === 'function') toast('Reply sent to ' + result.to + '. Status: Waiting.');
              }, function (err) {
                if (typeof toast === 'function') {
                  toast('Reply sent to ' + result.to + ', but the status was not saved: ' + err.message);
                }
              });
          }
          if (typeof toast !== 'function') return;
          /* Say what actually happened. "Reply posted" next to a reply that
             never left is the failure this whole path exists to avoid. */
          if (internal) return toast('Note added');
          if (result && result.sent) return toast('Reply sent to ' + result.to);
          toast((result && result.reason) || 'Saved, but not sent.');
        })
        .catch(function (err) {
          if (!internal && err && err.unknownOutcome) replyMayHaveGone[number] = true;
          fail(err);
        })
        .then(function () {
          form.dataset.pending = '';
          if (sendButton) sendButton.disabled = false;
        });
    }
  }, true);
})();
