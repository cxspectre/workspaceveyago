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
  const employee = () => (window.workspaceSession && workspaceSession.employee) || null;
  const labelOf = (list, value) => (list.find(x => x.value === value) || { label: '—' }).label;
  const byNumber = n => tickets.find(t => String(t.id) === String(n)) || null;

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
    return `<tr data-action="ticket" data-id="${esc(t.id)}">`
      + `<td><div class="cell-main"><span class="ticket-symbol">${icon('tickets')}</span><div><a class="ticket-link" href="#tickets/${esc(t.id)}"><strong>${esc(t.title)}</strong></a>`
      + `<small><span class="ticket-id">#VYG-${esc(t.id)}</span> &nbsp;·&nbsp; ${esc(t.client)}</small></div></div></td>`
      + `<td class="muted">${esc(t.product)}</td>`
      + `<td>${pill(labelOf(T.PRIORITIES, T.priorityOf(t)))}</td>`
      + `<td>${pill(labelOf(T.STATUSES, T.statusOf(t)))}</td>`
      + `<td>${ownerCell(t)}</td></tr>`;
  }

  function queue() {
    const me = employee() && employee().id;
    const list = tickets.filter(t => T.inScope(t, ticketScope, me) && T.matchesQuery(t, queries.tickets));
    const count = T.counts(tickets, me);
    const views = T.SCOPES.map(scope => {
      const selected = scope === ticketScope;
      return `<button type="button" data-view="ticketScope" data-value="${esc(scope)}" class="${selected ? 'selected' : ''}" aria-pressed="${selected}">`
        + `${icon(scope === 'Assigned to me' ? 'crm' : 'tickets')}<span>${esc(scope)}</span></button>`;
    }).join('');
    const table = '<div class="table-wrap"><table class="module-table"><thead><tr><th>Ticket</th><th>Product / client</th>'
      + `<th>Priority</th><th>Status</th><th>Owner</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;

    return titlebar('Support, with context.', 'Keep every customer conversation moving.', createButton('New ticket', 'tickets'))
      + statStrip([
        ['Open', count.open, 'Open, in progress or waiting'],
        ['Assigned to you', count.mine, (employee() && employee().full_name) || 'You'],
        ['High priority', count.urgent, 'High or urgent, still open'],
        ['Resolved', count.done, 'Resolved or closed, all time']
      ])
      + `<div class="queue-layout"><aside class="panel queue-sidebar"><span class="eyebrow">VIEWS</span>${views}`
      + `<div class="queue-hint">${icon('tickets')}<p>Replies and internal notes stay with each ticket.</p></div></aside>`
      + `<section class="panel"><div class="list-toolbar"><h2>${esc(ticketScope)} ${countTag(list.length)}</h2>${queryInput('tickets', 'Search tickets')}</div>`
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
    const field = `ticket-response-${t.id}`;
    const noteId = `ticket-reply-note-${t.id}`;
    const draft = draftOf(t.id);
    const mode = draft.mode === 'note' ? 'note' : 'reply';
    return `<form class="ticket-reply-form" data-ticket-reply="${esc(t.id)}">`
      + '<fieldset class="reply-controls"><legend class="sr-only">Send as</legend>'
      + MODES.map(([value, text]) => `<label><input type="radio" name="mode" value="${value}"${value === mode ? ' checked' : ''}> ${esc(text)}</label>`).join('')
      + '</fieldset>'
      + `<label class="sr-only" for="${esc(field)}">Message</label>`
      + `<textarea id="${esc(field)}" name="body" required placeholder="Write a reply or leave a note for the team…">${esc(draft.body)}</textarea>`
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

  function details(t) {
    const r = t.row || {};
    return [
      ['Status', choice('Ticket status', t, 'status', T.STATUSES.map(s => [s.value, s.label]), T.statusOf(t))],
      ['Priority', choice('Ticket priority', t, 'priority', T.PRIORITIES.map(p => [p.value, p.label]), T.priorityOf(t))],
      ['Owner', choice('Ticket owner', t, 'owner', T.ownerOptions(team, T.assigneeOf(t), t.assigneeName), T.assigneeOf(t) || '')],
      ['Requester', esc(t.client) + (t.contactEmail ? `<br><small>${esc(t.contactEmail)}</small>` : '')],
      ['Product', esc(t.product)],
      ['Came in', esc([SOURCES[r.source] || '', when(r.created_at)].filter(Boolean).join(' · ') || '—')],
      ['First reply', esc(r.first_response_at ? when(r.first_response_at) : 'Not sent yet')]
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

  function detail(number) {
    const t = byNumber(number);
    if (!t) return notFound();
    const resolve = T.resolveAction(t);
    const messages = T.conversation(t);
    const button = `<button type="button" class="btn${resolve.status === 'resolved' ? ' btn-primary' : ''}" data-ticket="${esc(t.id)}" data-ticket-status="${resolve.status}">${icon('check')}${esc(resolve.label)}</button>`;
    /* Its notes — and, when notes did not load, the section saying so
       (noteFeed) rather than none, which read as a ticket without notes. */
    const notesMissing = Boolean(window.workspaceStore && typeof workspaceStore.has === 'function' && !workspaceStore.has('notes'));
    const notes = (recordNotes.tickets[t.id] || []).length || notesMissing
      ? `<div class="section-title"><h2 id="ticket-notes-${esc(t.id)}" tabindex="-1">Notes on this ticket</h2></div><div class="conversation-feed">${noteFeed('tickets', t.id)}</div>`
      : '';
    return detailHeader('tickets', 'All tickets', t.title, `VYG-${t.id} · ${t.client}`, button)
      + '<div class="record-layout"><div class="record-main"><section class="panel content-panel">'
      + `<div class="section-title"><h2>Conversation</h2>${t.product && t.product !== '—' ? pill(t.product, 'blue') : ''}</div>`
      + `<div class="conversation-feed">${messages.length ? messages.map(entry).join('')
        : '<p class="quiet-text">Nothing has been written on this ticket yet.</p>'}</div>`
      + replyForm(t) + notes
      + '</section></div>'
      + `<aside class="record-aside">${properties(details(t))}${linkedPanel('Connected work', connected(t))}</aside></div>`;
  }

  ticketsView = function () {
    return routeParts[1] ? detail(Number(routeParts[1])) : queue();
  };

  /* A ticket opened from anywhere — the Overview, search, the bell — goes to
     its page. It opened a pop-up drawn from old sample data, whose resolve
     button changed the screen alone. */
  const beforeTickets = action;
  action = function (name, id) {
    if (name === 'ticket') { navigate('tickets/' + id); return; }
    beforeTickets(name, id);
  };

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
    if (note) note.textContent = T.replyNote(t, mode);
    if (label) label.textContent = T.replyButton(t, mode);
  });

  document.addEventListener('input', e => {
    const box = e.target && e.target.closest && e.target.closest('[data-ticket-reply] textarea[name="body"]');
    if (!box || !box.form) return;
    keepDraft(box.form.dataset.ticketReply, { body: box.value });
  });
})();
