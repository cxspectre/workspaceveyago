/* tickets-model.js — the support queue's logic, with no page in it.
 *
 * Which statuses and priorities a ticket can have and how they read, which
 * tickets a view shows, what search finds, the conversation in the order it
 * happened, and what the reply box says it will do. The ticket page used to
 * show only the customer's first message, offer three of the five statuses,
 * file "Assigned to me" by the initials "C", find the project and contact by
 * name, and say "Demo only" above a box that emailed the customer. Kept apart
 * from workspace.js so it can be tested without a browser —
 * tests/tickets.test.mjs.
 */
const ticketsModel = (function () {
  'use strict';

  /* support_tickets.status and .priority (0023), and how the queue shows them. */
  const STATUSES = Object.freeze([
    Object.freeze({ value: 'open', label: 'Open' }),
    Object.freeze({ value: 'in_progress', label: 'In progress' }),
    Object.freeze({ value: 'waiting', label: 'Waiting' }),
    Object.freeze({ value: 'resolved', label: 'Resolved' }),
    Object.freeze({ value: 'closed', label: 'Closed' })
  ]);
  const PRIORITIES = Object.freeze([
    Object.freeze({ value: 'low', label: 'Low' }),
    Object.freeze({ value: 'normal', label: 'Normal' }),
    Object.freeze({ value: 'high', label: 'High' }),
    Object.freeze({ value: 'urgent', label: 'Urgent' })
  ]);
  /* The statuses workspace_overview() counts as open (0029). */
  const OPEN = Object.freeze(['open', 'in_progress', 'waiting']);
  const DONE = Object.freeze(['resolved', 'closed']);
  const URGENT = Object.freeze(['high', 'urgent']);
  const SCOPES = Object.freeze([
    'All tickets', 'Assigned to me', 'Unassigned', 'High priority',
    'Open', 'In progress', 'Waiting', 'Resolved', 'Closed'
  ]);
  const KIND = Object.freeze({ inbound: 'Customer', outbound: 'Reply', internal: 'Internal note' });

  const text = value => String(value == null ? '' : value);

  /* A status or priority as the database has it, from either its value or its
     label: 'in_progress' and 'In progress' are the same status. */
  function valueIn(list, given) {
    const wanted = text(given).trim().toLowerCase();
    const hit = list.find(x => x.value === wanted || x.label.toLowerCase() === wanted);
    return hit ? hit.value : null;
  }

  const statusOf = ticket => valueIn(STATUSES, ticket && ((ticket.row && ticket.row.status) || ticket.status));
  const priorityOf = ticket => valueIn(PRIORITIES, ticket && ((ticket.row && ticket.row.priority) || ticket.priority));
  const assigneeOf = ticket => (ticket && (ticket.assigneeId || (ticket.row && ticket.row.assignee_id))) || null;
  const isOpen = ticket => OPEN.includes(statusOf(ticket));

  /* Which tickets a view shows. "Assigned to me" is who a ticket is assigned
     to, not a set of initials; a person's queue and the high-priority queue are
     the work still open; high priority includes urgent. */
  function inScope(ticket, scope, meId) {
    if (scope === 'Assigned to me') return Boolean(meId) && assigneeOf(ticket) === meId && isOpen(ticket);
    if (scope === 'Unassigned') return !assigneeOf(ticket) && isOpen(ticket);
    if (scope === 'High priority') return URGENT.includes(priorityOf(ticket)) && isOpen(ticket);
    const status = STATUSES.find(s => s.label === scope);
    return status ? statusOf(ticket) === status.value : true;
  }

  /* What search looks through: the subject, who it is from, the product, the
     number the way people write it (VYG-142) and the customer's address. */
  function searchText(ticket) {
    const t = ticket || {};
    return [t.title, t.client, t.product, 'VYG-' + text(t.id), t.contactEmail].map(text).join(' ').toLowerCase();
  }

  function matchesQuery(ticket, query) {
    const wanted = text(query).trim().toLowerCase();
    return !wanted || searchText(ticket).includes(wanted);
  }

  /* The strip above the queue. Resolved counts every ticket ever resolved or
     closed — it used to be labelled "This session". */
  function counts(tickets, meId) {
    const list = tickets || [];
    return Object.freeze({
      open: list.filter(isOpen).length,
      mine: list.filter(t => inScope(t, 'Assigned to me', meId)).length,
      urgent: list.filter(t => inScope(t, 'High priority', meId)).length,
      done: list.filter(t => DONE.includes(statusOf(t))).length
    });
  }

  /* The whole conversation, oldest first: the customer's messages, our replies
     and internal notes, each with who wrote it — and, for a reply, whether it
     reached the customer (0033). A reply with no delivery recorded says
     nothing rather than claiming either. */
  function conversation(ticket) {
    const t = ticket || {};
    return Object.freeze((t.thread || []).slice()
      .sort((a, b) => text(a.created_at).localeCompare(text(b.created_at)))
      .map(m => Object.freeze({
        id: m.id,
        who: text(m.who) || (m.direction === 'inbound' ? text(t.client) || 'Customer' : 'Veyago'),
        kind: KIND[m.direction] || 'Message',
        inbound: m.direction === 'inbound',
        internal: m.direction === 'internal',
        body: text(m.body),
        at: m.created_at || null,
        delivery: m.direction !== 'outbound' ? null
          : m.delivery_error ? 'Not sent: ' + text(m.delivery_error)
          : m.delivered_at ? 'Sent' : null
      })));
  }

  /* What the reply box will do, said before anything is sent. */
  function replyNote(ticket, mode) {
    if (mode === 'note') return 'Internal note: only the team sees it.';
    const email = ticket && ticket.contactEmail;
    return email
      ? 'Emailed to ' + email + '.'
      : 'This ticket has no customer address, so a reply is saved here but not emailed.';
  }

  const replyButton = (ticket, mode) =>
    (mode === 'note' ? 'Add note' : (ticket && ticket.contactEmail ? 'Send reply' : 'Save reply'));

  /* The owner picker, as [id, name]: "Unassigned" first, then the team. An
     owner who has left stays selected rather than quietly becoming the first
     name in the list. */
  function ownerOptions(team, assigneeId, assigneeName) {
    const people = (team || [])
      .filter(m => m && m.id)
      .map(m => Object.freeze([String(m.id), text(m.name)]));
    const gone = Boolean(assigneeId) && !people.some(([id]) => id === String(assigneeId));
    return Object.freeze([
      Object.freeze(['', 'Unassigned']),
      ...(gone ? [Object.freeze([String(assigneeId), text(assigneeName) || 'A former team member'])] : []),
      ...people
    ]);
  }

  /* The button beside the title: resolve a ticket still open, reopen one done. */
  function resolveAction(ticket) {
    const done = DONE.includes(statusOf(ticket));
    return Object.freeze({ status: done ? 'open' : 'resolved', label: done ? 'Reopen ticket' : 'Resolve ticket' });
  }

  /* Connected work, found by the ticket's own ids — never by a matching name. */
  function projectFor(ticket, projects) {
    const id = ticket && ticket.row && ticket.row.project_id;
    return id ? (projects || []).find(p => p && (p.id === id || p.uuid === id)) || null : null;
  }

  function contactFor(ticket, contacts) {
    const id = ticket && ticket.row && ticket.row.contact_id;
    return id ? (contacts || []).find(c => c && c.id === id) || null : null;
  }

  return Object.freeze({
    STATUSES, PRIORITIES, SCOPES,
    statusOf, priorityOf, assigneeOf, isOpen, inScope, searchText, matchesQuery, counts,
    conversation, replyNote, replyButton, ownerOptions, resolveAction, projectFor, contactFor
  });
})();
