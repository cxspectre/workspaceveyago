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
  const tidy = value => text(value).trim();
  const orNull = value => tidy(value) || null;

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

  /* ── Timing: age, first response, resolution ─────────────────────────
     The page is not redrawn every minute (overview-model.js's updatedLabel
     makes the same choice for the same reason), so these read in minutes,
     hours or days — coarse enough that the two minutes between one load and
     the next never makes a shown duration wrong. */
  function durationLabel(fromIso, toIso) {
    const from = fromIso ? new Date(fromIso) : null;
    const to = toIso ? new Date(toIso) : null;
    if (!from || Number.isNaN(from.getTime()) || !to || Number.isNaN(to.getTime())) return null;
    const minutes = Math.round(Math.max(0, to.getTime() - from.getTime()) / 60000);
    if (minutes < 1) return 'Under a minute';
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute' : ' minutes');
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour' : ' hours');
    const days = Math.round(hours / 24);
    return days + (days === 1 ? ' day' : ' days');
  }

  /* Whether a response target (0056: first_response_due_at, resolve_due_at)
     was met, missed, or is still ahead — 'due' while there is time left,
     'overdue' once the clock has run out with nothing to show for it. Met and
     missed are judged the moment the target itself was, at or before it
     counts as on time; a ticket with no target set (an old one, from before
     0056, or a priority the target table has no row for) is not judged at all. */
  function targetStatus(dueIso, actualIso, now) {
    if (!dueIso) return null;
    const due = new Date(dueIso);
    if (Number.isNaN(due.getTime())) return null;
    if (actualIso) {
      const actual = new Date(actualIso);
      if (Number.isNaN(actual.getTime())) return null;
      return actual.getTime() <= due.getTime() ? 'met' : 'missed';
    }
    const current = now instanceof Date ? now : new Date(now);
    return current.getTime() > due.getTime() ? 'overdue' : 'due';
  }

  /* ── Editing: subject, contact, company, project, product ────────────
     Staff may change any of these (0056); the side panel already finds the
     current contact and project by id (contactFor, projectFor above), never
     by a name that happens to match, and this keeps to the same rule: a
     select hands back an id or nothing, never a name to look up. */
  const EDIT_FIELDS = Object.freeze([
    ['subject', 'subject'], ['contactId', 'contact_id'], ['companyId', 'company_id'],
    ['projectId', 'project_id'], ['product', 'product']
  ]);
  const sent = (fields, key) => Object.prototype.hasOwnProperty.call(fields, key) && fields[key] !== undefined;

  function ticketChanges(ticket, fields) {
    const f = fields || {};
    const r = (ticket && ticket.row) || {};
    const refuse = (problem, field) => Object.freeze({ changes: Object.freeze({}), problem, field });
    if (sent(f, 'subject') && !tidy(f.subject)) return refuse('A ticket needs a subject.', 'subject');
    /* The row queries.js hands the page always carries the raw columns; a
       lighter fixture may not, so the shaped fields (title, product) stand in
       for them. queries.tickets() reads a missing product as '—' for display,
       which has to read as nothing here too — else leaving an already-blank
       product field blank would be sent as a change every time it is saved. */
    const rawProduct = r.product !== undefined ? r.product : (ticket && ticket.product);
    const current = Object.freeze({
      subject: tidy(r.subject != null ? r.subject : (ticket && ticket.title)),
      contact_id: r.contact_id || null,
      company_id: r.company_id || null,
      project_id: r.project_id || null,
      product: rawProduct === '—' ? null : orNull(rawProduct)
    });
    const changes = EDIT_FIELDS.reduce((all, [field, column]) => {
      if (!sent(f, field)) return all;
      const value = column === 'subject' ? tidy(f.subject) : orNull(f[field]);
      return value === current[column] ? all : Object.assign({}, all, { [column]: value });
    }, {});
    return Object.freeze({ changes: Object.freeze(changes), problem: null, field: null });
  }

  /* ── Delete and restore ───────────────────────────────────────────────
     The database already lets a manager set or clear deleted_at (0012's
     guard_soft_delete, applied to support_tickets by 0023) — this just reads
     which side of that a ticket is on. */
  const isDeleted = ticket => Boolean(ticket && ticket.row && ticket.row.deleted_at);

  /* ── Merging ───────────────────────────────────────────────────────────
     What someone types to say which ticket to merge into — a bare number, or
     any of the ways the queue's own search already accepts it (VYG-142,
     #VYG-142). Not a decimal, and not a leading zero pretending to be one:
     the database's ticket numbers are a plain identity sequence (0023). */
  function numberFromRef(value) {
    const m = tidy(value).match(/^#?(?:vyg-)?(\d+)$/i);
    return m ? Number(m[1]) : null;
  }

  /* ── Attachments ───────────────────────────────────────────────────────
     The ticket-attachments bucket's own limit (0056) — kept here rather than
     read off projects-model.js's FILE_LIMIT_BYTES, which is a different
     bucket's rule and a different number, and this file stays loadable on
     its own with nothing else on the page (tests/tickets.test.mjs). */
  const KB = 1024;
  const MB = KB * KB;
  const ATTACHMENT_LIMIT_BYTES = 25 * MB;

  /* A size a person reads: 512 B, 2 KB, 1.5 MB. */
  function fileSize(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n < KB) return `${n} B`;
    if (n < MB) return `${Math.round(n / KB)} KB`;
    return `${(n / MB).toFixed(1).replace(/\.0$/, '')} MB`;
  }

  /* Why a file cannot be attached, said before anything is uploaded — or null. */
  function fileProblem(file) {
    if (!file) return 'Pick a file first.';
    const name = text(file.name) || 'That file';
    if (!(Number(file.size) > 0)) return `"${name}" is empty.`;
    if (Number(file.size) > ATTACHMENT_LIMIT_BYTES) {
      return `"${name}" is larger than ${fileSize(ATTACHMENT_LIMIT_BYTES)}, the most a ticket attachment can be.`;
    }
    return null;
  }

  return Object.freeze({
    STATUSES, PRIORITIES, SCOPES,
    statusOf, priorityOf, assigneeOf, isOpen, inScope, searchText, matchesQuery, counts,
    conversation, replyNote, replyButton, ownerOptions, resolveAction, projectFor, contactFor,
    durationLabel, targetStatus, ticketChanges, isDeleted, numberFromRef,
    ATTACHMENT_LIMIT_BYTES, fileSize, fileProblem
  });
})();
