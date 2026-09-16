/* tickets-ui.js — the support queue and a ticket's page.
 *
 * The queue shows who a ticket is assigned to by id, has a view for every
 * status the database knows, and its search finds "VYG-142" or a customer's
 * address. A ticket's page shows the whole conversation — the customer's
 * messages, our replies and whether each reached the customer, and internal
 * notes — says where a reply will go before it is sent, and saves status,
 * priority and owner (data/writes.js). The logic is tickets-model.js.
 *
 * These replace the versions workspace.js drew, which showed the customer's
 * first message only, filed "Assigned to me" by the initials "C", offered three
 * of the five statuses, found the project and contact by name, and changed the
 * details on screen alone.
 */
(function () {
  'use strict';

  const T = ticketsModel;
  const { field, options, say, quiet, sending, closeDialog, refocus } = dialogForms;
  const text = value => String(value == null ? '' : value);
  /* A value as a CSS attribute selector quotes it. */
  const attr = value => text(value).replace(/["\\]/g, '\\$&');
  const employee = () => (window.workspaceSession && workspaceSession.employee) || null;
  const labelOf = (list, value) => (list.find(x => x.value === value) || { label: '—' }).label;
  const byNumber = n => tickets.find(t => String(t.id) === String(n)) || null;
  const byUuid = uuid => tickets.find(t => t.uuid === uuid) || null;
  const live = () => Boolean(window.workspaceStore && workspaceStore.state && workspaceStore.state.loaded);

  /* What someone has written in a ticket's reply box, and whether as a reply or
     a note — kept here, not only in the box. Every save repaints the page: a box
     rebuilt empty lost the reply, and one rebuilt on "Reply" turned the next
     note into an email. The mode stays as last used on that ticket. */
  const drafts = new Map();
  const draftOf = number => drafts.get(String(number)) || Object.freeze({ body: '', mode: 'reply' });
  const keepDraft = (number, change) => {
    drafts.set(String(number), Object.freeze({ ...draftOf(number), ...change }));
  };
  window.ticketDrafts = Object.freeze({
    get: draftOf,
    keep: keepDraft,
    /* After a send the words go and the mode stays — unless the box changed
       while it was sending, when what is there now is kept. */
    sent: (number, body) => {
      if (draftOf(number).body.trim() === String(body).trim()) keepDraft(number, { body: '' });
    }
  });

  /* A date and time the way this person writes them. */
  function when(at) {
    const d = at ? new Date(at) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
  }

  const initialsOf = name => String(name || '').trim().split(/\s+/).filter(Boolean)
    .map(word => Array.from(word)[0]).slice(0, 2).join('').toUpperCase();

  /* ── The queue ─────────────────────────────────────────────────────── */

  function ownerCell(t) {
    return t.assigneeName
      ? `<span class="avatar sm" role="img" aria-label="${esc('Owner: ' + t.assigneeName)}" title="${esc(t.assigneeName)}">${esc(t.owner)}</span>`
      : '<span class="muted">Unassigned</span>';
  }

  /* A plain row with a link in it: a row that is itself a button is read out as
     its label alone, so its status, priority and owner were never heard. A click
     anywhere in the row still opens the ticket. */
  function row(t) {
    const age = T.durationLabel(t.row && t.row.created_at, new Date().toISOString());
    const failed = t.deliveryFailed
      ? '<small class="delivery-flag" role="status">Reply not sent</small>' : '';
    return `<tr data-action="ticket" data-id="${esc(t.id)}">`
      + `<td><div class="cell-main"><span class="ticket-symbol">${icon('tickets')}</span><div><a class="ticket-link" href="#tickets/${esc(t.id)}"><strong>${esc(t.title)}</strong></a>`
      + `<small><span class="ticket-id">#VYG-${esc(t.id)}</span> &nbsp;·&nbsp; ${esc(t.client)}${age ? ' &nbsp;·&nbsp; ' + esc(age) + ' old' : ''}</small>${failed}</div></div></td>`
      + `<td class="muted">${esc(t.product)}</td>`
      + `<td>${pill(labelOf(T.PRIORITIES, T.priorityOf(t)))}</td>`
      + `<td>${pill(labelOf(T.STATUSES, T.statusOf(t)))}</td>`
      + `<td>${ownerCell(t)}</td></tr>`;
  }

  /* Newest first is the database's own order (queries.tickets), kept as the
     default so a fresh sign-in sees exactly what it always has; oldest first
     is one click away for triage — the ones waiting longest, first. Held here
     rather than as a page-global like ticketScope: nothing else on the page
     reads it, so it does not need workspace.js's [data-view] wiring. */
  let ticketSort = 'newest';

  function queue() {
    const me = employee() && employee().id;
    const list = tickets.filter(t => T.inScope(t, ticketScope, me) && T.matchesQuery(t, queries.tickets));
    const createdAt = x => String((x.row || {}).created_at || '');
    list.sort((a, b) => (ticketSort === 'oldest' ? 1 : -1) * createdAt(a).localeCompare(createdAt(b)));
    const count = T.counts(tickets, me);
    const views = T.SCOPES.map(scope => {
      const selected = scope === ticketScope;
      return `<button type="button" data-view="ticketScope" data-value="${esc(scope)}" class="${selected ? 'selected' : ''}" aria-pressed="${selected}">`
        + `${icon(scope === 'Assigned to me' ? 'crm' : 'tickets')}<span>${esc(scope)}</span></button>`;
    }).join('');
    const table = '<div class="table-wrap"><table class="module-table"><thead><tr><th>Ticket</th><th>Product / client</th>'
      + `<th>Priority</th><th>Status</th><th>Owner</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;
    const sortButton = (value, label) => `<button type="button" data-ticket-sort="${value}" class="text-btn${ticketSort === value ? ' selected' : ''}" aria-pressed="${ticketSort === value}">${label}</button>`;

    return titlebar('Support, with context.', 'Keep every customer conversation moving.', createButton('New ticket', 'tickets'))
      + statStrip([
        ['Open', count.open, 'Open, in progress or waiting'],
        ['Assigned to you', count.mine, (employee() && employee().full_name) || 'You'],
        ['High priority', count.urgent, 'High or urgent, still open'],
        ['Resolved', count.done, 'Resolved or closed, all time']
      ])
      + `<div class="queue-layout"><aside class="panel queue-sidebar"><span class="eyebrow">VIEWS</span>${views}`
      + `<div class="queue-hint">${icon('tickets')}<p>Replies and internal notes stay with each ticket.</p></div>`
      + (isManagerNow() ? '<form class="restore-ticket-form" data-restore-ticket>'
          + '<label class="sr-only" for="restore-ticket-number">Restore a deleted ticket by number</label>'
          + '<input id="restore-ticket-number" name="number" placeholder="Restore #VYG-…">'
          + '<button type="submit" class="text-btn">Restore</button></form>' : '')
      + '</aside>'
      + `<section class="panel"><div class="list-toolbar"><h2>${esc(ticketScope)} ${countTag(list.length)}</h2>`
      + `<div class="ticket-sort" role="group" aria-label="Sort tickets">${sortButton('newest', 'Newest first')}${sortButton('oldest', 'Oldest first')}</div>`
      + `${queryInput('tickets', 'Search tickets')}</div>`
      + (list.length ? table : empty('No tickets here', 'Try another view or a different search.'))
      + `<div class="table-bottom"><span>${list.length} ticket${list.length === 1 ? '' : 's'}</span>`
      + '<span>Search finds a subject, a customer, their address or a number like VYG-142.</span></div></section></div>';
  }

  /* ── A ticket's page ───────────────────────────────────────────────── */

  function entry(message) {
    const kind = message.internal ? 'internal' : message.inbound ? 'inbound' : 'outbound';
    const failed = Boolean(message.delivery) && message.delivery !== 'Sent';
    const delivery = message.delivery
      ? `<small class="delivery${failed ? ' failed' : ''}">${esc(message.delivery)}</small>` : '';
    return `<article class="conversation-entry ${kind}">`
      + `<div class="avatar${message.inbound ? '' : ' owner'}" aria-hidden="true">${esc(initialsOf(message.who) || (message.inbound ? 'C' : 'V'))}</div>`
      + `<div><div class="message-meta"><strong>${esc(message.who)}</strong>`
      + `<span>${esc(message.kind)}${message.at ? ' · ' + esc(when(message.at)) : ''}</span></div>`
      + `<p>${esc(message.body)}</p>${delivery}</div></article>`;
  }

  const MODES = Object.freeze([['reply', 'Reply to the customer'], ['note', 'Internal note']]);

  function replyForm(t) {
    const fieldId = `ticket-response-${t.id}`;
    const noteId = `ticket-reply-note-${t.id}`;
    const draft = draftOf(t.id);
    const mode = draft.mode === 'note' ? 'note' : 'reply';
    /* One combined action, for the common case of answering and leaving it
       with the customer next: a reply, and once it is confirmed sent,
       Waiting — rather than a second trip back to the Status select. Only
       for a reply: a note stays between us, so "Waiting" would say nothing
       true (data/writes.js only acts on this when the send is confirmed). */
    const waitRow = `<label class="check-row" data-then-waiting${mode === 'note' ? ' hidden' : ''}>`
      + '<input type="checkbox" name="thenWaiting"> Then set to Waiting</label>';
    return `<form class="ticket-reply-form" data-ticket-reply="${esc(t.id)}">`
      + '<fieldset class="reply-controls"><legend class="sr-only">Send as</legend>'
      + MODES.map(([value, text]) => `<label><input type="radio" name="mode" value="${value}"${value === mode ? ' checked' : ''}> ${esc(text)}</label>`).join('')
      + '</fieldset>'
      + `<label class="sr-only" for="${esc(fieldId)}">Message</label>`
      + `<textarea id="${esc(fieldId)}" name="body" required placeholder="Write a reply or leave a note for the team…">${esc(draft.body)}</textarea>`
      + waitRow
      + `<div class="form-bottom"><span id="${esc(noteId)}" data-reply-note>${esc(T.replyNote(t, mode))}</span>`
      + `<button type="submit" id="ticket-reply-send-${esc(t.id)}" class="btn btn-primary" aria-describedby="${esc(noteId)}"><span data-reply-label>${esc(T.replyButton(t, mode))}</span> ${icon('arrow')}</button></div>`
      + '</form>';
  }

  /* A select data/writes.js saves: by the ticket's number, as in the URL. */
  function choice(labelText, t, field, options, current) {
    return `<select aria-label="${esc(labelText)}" data-record-kind="tickets" data-record-id="${esc(t.id)}" data-field="${field}">`
      + options.map(([value, text]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`).join('')
      + '</select>';
  }

  const SOURCES = Object.freeze({ email: 'Email', form: 'Web form', manual: 'Added here' });

  /* A response against its target (0056): met or missed once answered,
     overdue or still due while it waits. Silent when the ticket has no
     target — an old one, or a priority the target table has no row for. */
  function targetLine(dueAt, actualAt) {
    const status = T.targetStatus(dueAt, actualAt, new Date().toISOString());
    if (!status) return '';
    const WORDS = { met: 'Met', missed: 'Missed', due: 'Due', overdue: 'Overdue' };
    const TONE = { met: 'green', missed: 'red', due: '', overdue: 'red' };
    return ' ' + pill(WORDS[status] + ' · ' + when(dueAt), TONE[status]);
  }

  /* A client number (0053), read straight off the ticket's own row the same
     way finance-ui.js reads it off an invoice's: company:crm_companies
     already carries it (queries.js), and tickets-model.js — a peer file — is
     never asked. Only a company the ticket is filed under directly (its own
     company_id, not one reached through its contact) has one to quote here. */
  function clientNumberOf(t) {
    const company = (t.row || {}).company;
    return company && company.client_number != null ? company.client_number : null;
  }

  function details(t) {
    const r = t.row || {};
    const age = T.durationLabel(r.created_at, new Date().toISOString());
    const mergedInto = t.mergedIntoId ? byUuid(t.mergedIntoId) : null;
    const clientNumber = clientNumberOf(t);
    return [
      ['Status', choice('Ticket status', t, 'status', T.STATUSES.map(s => [s.value, s.label]), T.statusOf(t))],
      ['Priority', choice('Ticket priority', t, 'priority', T.PRIORITIES.map(p => [p.value, p.label]), T.priorityOf(t))],
      ['Owner', choice('Ticket owner', t, 'owner', T.ownerOptions(team, T.assigneeOf(t), t.assigneeName), T.assigneeOf(t) || '')],
      ['Requester', esc(t.client) + (t.contactEmail ? `<br><small>${esc(t.contactEmail)}</small>` : '')],
      ...(clientNumber != null ? [['Client No.', esc(String(clientNumber))]] : []),
      ['Product', esc(t.product)],
      ['Came in', esc([SOURCES[r.source] || '', when(r.created_at)].filter(Boolean).join(' · ') || '—') + (age ? ` <small>(${esc(age)} old)</small>` : '')],
      ['First reply', esc(r.first_response_at ? when(r.first_response_at) : 'Not sent yet') + targetLine(r.first_response_due_at, r.first_response_at)],
      ['Resolved', (r.resolved_at ? esc(when(r.resolved_at)) + ' <small>(' + esc(T.durationLabel(r.created_at, r.resolved_at) || '—') + ')</small>' : esc('Not yet')) + targetLine(r.resolve_due_at, r.resolved_at)],
      ...(mergedInto ? [['Merged into', `<a class="record-link" href="#tickets/${esc(mergedInto.id)}">#VYG-${esc(mergedInto.id)}</a>`]] : [])
    ];
  }

  /* The ticket's own contact, project and mail conversation — found by id,
     never by a name that happens to match. */
  function connected(t) {
    const contact = T.contactFor(t, contacts);
    const project = T.projectFor(t, projects);
    const thread = mails.find(m => m && m.row && m.row.ticket_id === t.uuid);
    return [
      ...(contact ? [[`crm/${contact.id}`, contact.name, 'Contact profile', 'crm']] : []),
      ...(project ? [[`projects/${project.id}`, project.name, 'Project workspace', 'projects']] : []),
      ...(thread ? [[mailModel.mailRoute({ mailbox: 'all', folder: mailModel.folderForThread(thread, 'inbox'), threadId: thread.id }), thread.subject, 'Mail conversation', 'mail']] : [])
    ];
  }

  /* The whole conversation: what the list already carried (a fixture in
     tests, or once the store has fetched it), or the store's own lazy copy
     (data/store.js askTicketThread) — asked for apart from the list so
     opening a ticket does not wait on every OTHER ticket's messages loading
     too (audit #12). */
  function threadFor(t) {
    if (Array.isArray(t.thread)) return { state: 'ready', messages: t.thread };
    if (window.workspaceStore && typeof workspaceStore.askTicketThread === 'function') {
      return workspaceStore.askTicketThread(t);
    }
    return { state: 'loading', messages: [] };
  }

  function conversationPanel(t, asked) {
    if (asked.state === 'loading') {
      return '<p class="quiet-text" role="status">Loading the conversation…</p>';
    }
    if (asked.state === 'failed') {
      return '<p class="quiet-text" role="alert">This conversation did not load. It is tried again by itself.</p>'
        + `<button type="button" class="text-btn" data-ticket-thread-retry="${esc(t.uuid)}">Try again</button>`;
    }
    const messages = T.conversation(Object.assign({}, t, { thread: asked.messages }));
    return messages.length ? messages.map(entry).join('')
      : '<p class="quiet-text">Nothing has been written on this ticket yet.</p>';
  }

  /* Attachments (audit #11): staff-uploaded files and, once carried over,
     ones that arrived with an incoming email — same shape either way, shown
     apart from the conversation since they belong to the ticket, not always
     to one particular message. Same lazy-once-open pattern as the
     conversation, but store.js keeps this one simple (no version check) since
     a ticket rarely gains or loses a file. */
  function attachmentRow(t, f) {
    const mine = Boolean(employee() && f.uploadedBy === employee().id);
    return '<li class="file-row">'
      + `<span class="related-icon">${icon('tickets')}</span>`
      + `<div class="file-name"><strong>${esc(f.name)}</strong><small>${esc(T.fileSize(f.sizeBytes))}${f.uploaderName ? ' · ' + esc(f.uploaderName) : ''}</small></div>`
      + `<button type="button" class="text-btn" data-ticket-file-open="${esc(f.id)}" data-ticket="${esc(t.uuid)}" aria-label="Download ${esc(f.name)}">Download</button>`
      + (isManagerNow() || mine
        ? `<button type="button" class="text-btn" data-ticket-file-remove="${esc(f.id)}" data-ticket="${esc(t.uuid)}" aria-label="Remove ${esc(f.name)}">Remove</button>`
        : '')
      + '</li>';
  }

  function attachmentsPanel(t) {
    const asked = window.workspaceStore && typeof workspaceStore.askTicketAttachments === 'function'
      ? workspaceStore.askTicketAttachments(t.uuid) : { state: 'loading', files: [] };
    const body = asked.state === 'loading' ? '<p class="quiet-text" role="status">Loading attachments…</p>'
      : asked.state === 'failed'
        ? '<p class="quiet-text" role="alert">Attachments did not load. It is tried again by itself.</p>'
          + `<button type="button" class="text-btn" data-ticket-files-retry="${esc(t.uuid)}">Try again</button>`
        : (asked.files.length ? `<ul class="plain-list">${asked.files.map(f => attachmentRow(t, f)).join('')}</ul>` : '<p class="quiet-text">No attachments yet.</p>');
    const count = asked.state === 'ready' ? asked.files.length : null;
    return '<section class="panel content-panel ticket-attachments">'
      + `<div class="section-title"><h2>Attachments</h2>${count == null ? '' : `<span class="quiet-text">${count} ${count === 1 ? 'file' : 'files'}</span>`}</div>`
      + `<button type="button" class="btn file-pick" data-ticket-files-pick="${esc(t.uuid)}">${icon('plus')}Add files</button>`
      + `<input type="file" multiple hidden data-ticket-files-input="${esc(t.uuid)}">`
      + `<p class="quiet-text">Up to ${T.fileSize(T.ATTACHMENT_LIMIT_BYTES)} each.</p>`
      + body + '</section>';
  }

  function detail(number) {
    const t = byNumber(number);
    if (!t) return notFound();
    const resolve = T.resolveAction(t);
    const asked = threadFor(t);
    const actions = [
      `<button type="button" class="btn" data-ticket-edit="${esc(t.id)}">Edit ticket</button>`,
      t.mergedIntoId ? '' : `<button type="button" class="btn" data-ticket-merge="${esc(t.id)}">Merge into…</button>`,
      isManagerNow() ? `<button type="button" class="btn" data-ticket-delete="${esc(t.uuid)}">Delete ticket</button>` : '',
      `<button type="button" class="btn${resolve.status === 'resolved' ? ' btn-primary' : ''}" data-ticket="${esc(t.id)}" data-ticket-status="${resolve.status}">${icon('check')}${esc(resolve.label)}</button>`
    ].filter(Boolean).join('');
    const button = actions;
    /* Its notes — and, when notes did not load, the section saying so
       (noteFeed) rather than none, which read as a ticket without notes. */
    const notesMissing = Boolean(window.workspaceStore && typeof workspaceStore.has === 'function' && !workspaceStore.has('notes'));
    const notes = (recordNotes.tickets[t.id] || []).length || notesMissing
      ? `<div class="section-title"><h2 id="ticket-notes-${esc(t.id)}" tabindex="-1">Notes on this ticket</h2></div><div class="conversation-feed">${noteFeed('tickets', t.id)}</div>`
      : '';
    return detailHeader('tickets', 'All tickets', t.title, `VYG-${t.id} · ${t.client}`, button)
      + '<div class="record-layout"><div class="record-main"><section class="panel content-panel">'
      + `<div class="section-title"><h2>Conversation</h2>${t.product && t.product !== '—' ? pill(t.product, 'blue') : ''}</div>`
      + `<div class="conversation-feed">${conversationPanel(t, asked)}</div>`
      + replyForm(t) + notes
      + '</section>' + attachmentsPanel(t) + '</div>'
      + `<aside class="record-aside">${properties(details(t))}${linkedPanel('Connected work', connected(t))}</aside></div>`;
  }

  ticketsView = function () {
    return routeParts[1] ? detail(Number(routeParts[1])) : queue();
  };

  /* ── Edit, delete and merge dialogs (audit #2, #4, #8) ────────────────
     Same shape as event-edit.js's own dialogs: opened with the record as the
     page has it, sent through workspaceActions once dialog-forms.js has
     checked nothing else is already on its way. */

  /* A picker of records by id, never by a name someone typed: "— None —"
     first, then every record sorted by name, and — an id the list does not
     have, because it left the CRM or a project — kept selected rather than
     silently becoming "— None —" or the first name in the list. */
  function pickerOptions(list, current) {
    const seen = (list || []).filter(x => x && x.id)
      .map(x => ({ value: String(x.id), label: text(x.name) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const gone = current && !seen.some(o => o.value === current);
    return [{ value: '', label: '— None —' }]
      .concat(gone ? [{ value: current, label: 'Not in this list any more' }] : [])
      .concat(seen);
  }

  function openEdit(t) {
    const r = t.row || {};
    const companyList = (window.workspaceStore && workspaceStore.state.companies) || [];
    showModal('TICKET · EDIT', `<h2>Edit #VYG-${esc(t.id)}</h2>`
      + dialogForms.form('ticket-edit-form',
          field('Subject', `<input name="subject" required autofocus value="${esc(t.title)}">`)
          + field('Product', `<input name="product" value="${esc(t.product === '—' ? '' : t.product)}">`)
          + field('Contact', `<select name="contactId">${options(pickerOptions(contacts, r.contact_id), r.contact_id || '')}</select>`)
          + field('Company', `<select name="companyId">${options(pickerOptions(companyList, r.company_id), r.company_id || '')}</select>`)
          + field('Project', `<select name="projectId">${options(pickerOptions(projects, r.project_id), r.project_id || '')}</select>`),
          'Save changes'));
    const form = document.getElementById('ticket-edit-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const checked = T.ticketChanges(t, Object.fromEntries(new FormData(form).entries()));
      if (checked.problem) { say(form, checked.problem, checked.field); return; }
      if (!Object.keys(checked.changes).length) { closeDialog(form); toast('Nothing changed.'); return; }
      sending(form, () => workspaceActions.updateTicket(t.uuid, checked.changes, r.updated_at || null), () => {
        toast('Ticket saved.');
        refocus([{ selector: `#main [data-ticket-edit="${attr(t.id)}"]` }, { selector: '#main h1', heading: true }]);
      }, { record: `ticket:${t.uuid}`, part: 'tickets' });
    });
  }

  /* Deleting asks first, on dialog-forms.js — the same pattern as agenda-ui.js's
     Remove event — since a deleted ticket leaves every queue and search until a
     manager restores it. */
  function openDelete(t) {
    showModal('TICKET · DELETE', `<h2>Delete #VYG-${esc(t.id)}?</h2>`
      + '<p class="form-note">It leaves every queue and search until a manager restores it by its number.</p>'
      + dialogForms.form('ticket-delete-form', '', 'Delete ticket'));
    const form = document.getElementById('ticket-delete-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      sending(form, () => workspaceActions.deleteTicket(t.uuid), () => {
        navigate('tickets');
        toast('Ticket #VYG-' + t.id + ' deleted.');
      }, { record: `ticket:${t.uuid}`, part: 'tickets' });
    });
  }

  /* Merging into a ticket already on the page — typed as a number, VYG-141 or
     #VYG-141, the way search already reads one (ticketsModel.numberFromRef).
     merge_tickets() (0056) is staff, not managers only — same as everything
     else this page already lets any signed-in team member do. */
  function openMerge(t) {
    showModal('TICKET · MERGE', `<h2>Merge #VYG-${esc(t.id)} into another ticket</h2>`
      + '<p class="form-note">Its thread, notes and conversations move to the ticket kept; this one closes and points at it.</p>'
      + dialogForms.form('ticket-merge-form', field('Merge into', '<input name="into" required placeholder="Ticket number, like 141">'), 'Merge tickets'));
    const form = document.getElementById('ticket-merge-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const typed = new FormData(form).get('into');
      const number = T.numberFromRef(typed);
      if (!number) { say(form, 'Type the other ticket\'s number, like 141 or VYG-141.', 'into'); return; }
      if (number === t.id) { say(form, 'A ticket cannot be merged into itself.', 'into'); return; }
      const other = byNumber(number);
      if (!other) { say(form, 'No ticket #VYG-' + number + ' is loaded here.', 'into'); return; }
      sending(form, () => workspaceActions.mergeTickets(other.uuid, t.uuid), () => {
        navigate('tickets/' + other.id);
        toast('#VYG-' + t.id + ' merged into #VYG-' + other.id + '.');
      }, { record: `ticket:${t.uuid}`, part: 'tickets' });
    });
  }

  /* Attachments: picking, downloading and removing a file. Upload itself
     happens on the hidden input's change event, below. */
  function uploadFiles(input) {
    const t = byUuid(input.dataset.ticketFilesInput);
    const files = [...(input.files || [])];
    input.value = '';
    if (!t || !files.length) return;
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    const problem = files.map(T.fileProblem).find(Boolean);
    if (problem) { toast(problem); return; }
    const pick = document.querySelector('[data-ticket-files-pick="' + attr(t.uuid) + '"]');
    if (pick) { pick.disabled = true; pick.setAttribute('aria-busy', 'true'); }
    const work = (async () => {
      const failed = [];
      for (const [i, file] of files.entries()) {
        toast('Uploading ' + (files.length > 1 ? (i + 1) + ' of ' + files.length + ': ' : '') + file.name + '…');
        try {
          await workspaceActions.uploadTicketAttachment(t.uuid, file);
        } catch (err) {
          failed.push(err.message);
        }
      }
      return { added: files.length - failed.length, failed };
    })();
    workspaceStore.after(work, { toast: false }).then(result => {
      toast(result.failed.length ? result.added + ' of ' + files.length + ' added. ' + result.failed[0]
        : (result.added === 1 ? files[0].name + ' is on the ticket.' : result.added + ' files are on the ticket.'));
    }, err => toast(err.message))
      .then(() => { if (pick && pick.isConnected) { pick.disabled = false; pick.removeAttribute('aria-busy'); } });
  }

  function downloadFile(file, button) {
    button.disabled = true;
    workspaceActions.ticketAttachmentLink(file.storagePath, file.name)
      .then(url => {
        const link = document.createElement('a');
        link.href = url;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
      })
      .catch(err => toast(err.message))
      .then(() => { button.disabled = false; });
  }

  /* Removing asks first, on dialog-forms.js, the same as deleting a ticket or
     removing an event: it is gone from storage for everyone once confirmed. */
  function openRemoveFile(t, file) {
    showModal('TICKET · ATTACHMENT', `<h2>Remove ${esc(file.name)}?</h2>`
      + '<p class="form-note">It is deleted from storage for everyone, and cannot be brought back.</p>'
      + dialogForms.form('ticket-file-remove-form', '', 'Remove attachment'));
    const form = document.getElementById('ticket-file-remove-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      sending(form, () => workspaceActions.removeTicketAttachment(file), () => {
        toast(file.name + ' is removed.');
      }, { record: `ticket:${t.uuid}`, part: 'tickets' });
    });
  }

  document.addEventListener('change', e => {
    const input = e.target && e.target.closest && e.target.closest('[data-ticket-files-input]');
    if (input) uploadFiles(input);
  });

  document.addEventListener('click', e => {
    const pick = e.target && e.target.closest && e.target.closest('[data-ticket-files-pick]');
    if (pick) {
      const input = document.querySelector('[data-ticket-files-input="' + attr(pick.dataset.ticketFilesPick) + '"]');
      if (input) input.click();
      return;
    }
    const filesRetry = e.target && e.target.closest && e.target.closest('[data-ticket-files-retry]');
    if (filesRetry) {
      if (window.workspaceStore && typeof workspaceStore.retryTicketAttachments === 'function') {
        workspaceStore.retryTicketAttachments(filesRetry.dataset.ticketFilesRetry);
      }
      repaintKeepingFocus();
      return;
    }
    const open = e.target && e.target.closest && e.target.closest('[data-ticket-file-open]');
    if (open) {
      const t = byUuid(open.dataset.ticket);
      const asked = t && window.workspaceStore && typeof workspaceStore.askTicketAttachments === 'function'
        ? workspaceStore.askTicketAttachments(t.uuid) : null;
      const file = asked && asked.files && asked.files.find(f => String(f.id) === open.dataset.ticketFileOpen);
      if (file) downloadFile(file, open);
      return;
    }
    const remove = e.target && e.target.closest && e.target.closest('[data-ticket-file-remove]');
    if (remove) {
      const t = byUuid(remove.dataset.ticket);
      const asked = t && window.workspaceStore && typeof workspaceStore.askTicketAttachments === 'function'
        ? workspaceStore.askTicketAttachments(t.uuid) : null;
      const file = asked && asked.files && asked.files.find(f => String(f.id) === remove.dataset.ticketFileRemove);
      if (t && file) openRemoveFile(t, file);
      return;
    }
    const editBtn = e.target && e.target.closest && e.target.closest('[data-ticket-edit]');
    if (editBtn) {
      if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
      const t = byNumber(editBtn.dataset.ticketEdit);
      if (!t) { toast('That ticket is not loaded any more. Reload the page.'); return; }
      openEdit(t);
      return;
    }
    const mergeBtn = e.target && e.target.closest && e.target.closest('[data-ticket-merge]');
    if (mergeBtn) {
      if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
      const t = byNumber(mergeBtn.dataset.ticketMerge);
      if (!t) { toast('That ticket is not loaded any more. Reload the page.'); return; }
      openMerge(t);
      return;
    }
    const deleteBtn = e.target && e.target.closest && e.target.closest('[data-ticket-delete]');
    if (deleteBtn) {
      if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
      if (!isManagerNow()) { toast('Only an owner or admin can delete a ticket.'); return; }
      const t = byUuid(deleteBtn.dataset.ticketDelete);
      if (!t) { toast('That ticket is not loaded any more. Reload the page.'); return; }
      openDelete(t);
    }
  });

  /* Restoring a deleted ticket, from the queue's own sidebar: by its number,
     the one a manager already has from the moment they deleted it — deleted
     tickets are not listed anywhere here for one to be picked from. */
  document.addEventListener('submit', e => {
    const form = e.target;
    if (!form || !form.matches || !form.matches('[data-restore-ticket]')) return;
    e.preventDefault();
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    const number = T.numberFromRef(new FormData(form).get('number'));
    if (!number) { toast('Type the ticket\'s number, like 141 or VYG-141.'); return; }
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    workspaceStore.after(workspaceActions.restoreTicket(number))
      .then(() => toast('Ticket #VYG-' + number + ' restored.'))
      .catch(err => toast(err.message))
      .then(() => { if (button) button.disabled = false; });
  });

  /* A ticket opened from anywhere — the Overview, search, the bell — goes to
     its page. It opened a pop-up drawn from old sample data, whose resolve
     button changed the screen alone. */
  const beforeTickets = action;
  action = function (name, id) {
    if (name === 'ticket') { navigate('tickets/' + id); return; }
    beforeTickets(name, id);
  };

  /* Sorting the queue, and asking again for a conversation that did not load —
     both draw the page again in place, keeping focus, as every other view
     toggle on this page does. */
  document.addEventListener('click', e => {
    const sortButton = e.target && e.target.closest && e.target.closest('[data-ticket-sort]');
    if (sortButton) {
      ticketSort = sortButton.dataset.ticketSort === 'oldest' ? 'oldest' : 'newest';
      repaintKeepingFocus();
      return;
    }
    const retry = e.target && e.target.closest && e.target.closest('[data-ticket-thread-retry]');
    if (retry && window.workspaceStore && typeof workspaceStore.retryTicketThread === 'function') {
      workspaceStore.retryTicketThread(retry.dataset.ticketThreadRetry);
      repaintKeepingFocus();
    }
  });

  /* The reply box says what it will do before anything is sent, and what is
     written in it, and how, outlives a repaint (drafts, above). */
  document.addEventListener('change', e => {
    const radio = e.target && e.target.closest && e.target.closest('[data-ticket-reply] input[name="mode"]');
    if (!radio || !radio.form) return;
    const number = radio.form.dataset.ticketReply;
    const mode = radio.value === 'note' ? 'note' : 'reply';
    keepDraft(number, { mode });
    const t = byNumber(number);
    if (!t) return;
    const note = radio.form.querySelector('[data-reply-note]');
    const label = radio.form.querySelector('[data-reply-label]');
    const waitRow = radio.form.querySelector('[data-then-waiting]');
    if (note) note.textContent = T.replyNote(t, mode);
    if (label) label.textContent = T.replyButton(t, mode);
    if (waitRow) waitRow.hidden = mode === 'note';
  });

  document.addEventListener('input', e => {
    const box = e.target && e.target.closest && e.target.closest('[data-ticket-reply] textarea[name="body"]');
    if (!box || !box.form) return;
    keepDraft(box.form.dataset.ticketReply, { body: box.value });
  });
})();
