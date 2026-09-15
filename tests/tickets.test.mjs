/* The support queue, without a page: statuses and priorities as the database
   has them, which tickets a view shows, what search finds, the conversation in
   order, and what the reply box says. Loaded into a sandbox the way <script>
   tags run it. Run from the repo root with: node --test

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence the [...spread] and {...spread} before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console });
vm.runInContext(readFileSync(new URL('../dist/tickets-model.js', import.meta.url), 'utf8'), context);
const model = vm.runInContext('ticketsModel', context);

const ME = 'e1000000-0000-4000-8000-000000000001';
const YOU = 'e1000000-0000-4000-8000-000000000002';

/* A ticket as queries.tickets() hands it to the store. */
const ticket = (over = {}, row = {}) => ({
  id: 142, uuid: 't142', title: 'Checkout is broken', client: 'Ana Lima', product: 'Kept',
  status: 'Open', priority: 'Normal', contactEmail: 'ana@northline.example', thread: [],
  ...over,
  row: { status: 'open', priority: 'normal', assignee_id: null, project_id: null, contact_id: null, ...row }
});

/* ── Statuses and priorities ──────────────────────────────────────────── */

test('every status and priority the database knows, with the label the queue shows', () => {
  assert.deepEqual([...model.STATUSES.map(s => s.value)], ['open', 'in_progress', 'waiting', 'resolved', 'closed']);
  assert.deepEqual([...model.PRIORITIES.map(p => p.label)], ['Low', 'Normal', 'High', 'Urgent'],
    'no "Medium": the database says normal, and a normal ticket used to show as Low');
});

test('a status or priority is the same whether read from the row or from its label', () => {
  assert.equal(model.statusOf(ticket({}, { status: 'in_progress' })), 'in_progress');
  assert.equal(model.statusOf({ status: 'In progress' }), 'in_progress');
  assert.equal(model.priorityOf(ticket({}, { priority: 'urgent' })), 'urgent');
  assert.equal(model.statusOf({ status: 'Pending' }), null, 'something unknown is nothing');
});

/* ── Views ────────────────────────────────────────────────────────────── */

test('"Assigned to me" is who a ticket is assigned to, not a set of initials', () => {
  const mine = ticket({ owner: 'SR' }, { assignee_id: ME });
  const yours = ticket({ owner: 'C' }, { assignee_id: YOU });
  assert.equal(model.inScope(mine, 'Assigned to me', ME), true);
  assert.equal(model.inScope(yours, 'Assigned to me', ME), false);
  assert.equal(model.inScope(mine, 'Assigned to me', null), false, 'nobody signed in has no queue');
  assert.equal(model.inScope(ticket({}, { assignee_id: ME, status: 'resolved' }), 'Assigned to me', ME), false,
    'a person\'s queue is the work still open');
});

test('high priority includes urgent, and unassigned is open work nobody has', () => {
  assert.equal(model.inScope(ticket({}, { priority: 'urgent' }), 'High priority', ME), true);
  assert.equal(model.inScope(ticket({}, { priority: 'high', status: 'closed' }), 'High priority', ME), false);
  assert.equal(model.inScope(ticket(), 'Unassigned', ME), true);
  assert.equal(model.inScope(ticket({}, { assignee_id: YOU }), 'Unassigned', ME), false);
});

test('waiting and closed have views of their own', () => {
  assert.equal(model.inScope(ticket({}, { status: 'waiting' }), 'Waiting', ME), true);
  assert.equal(model.inScope(ticket({}, { status: 'closed' }), 'Closed', ME), true);
  assert.equal(model.inScope(ticket({}, { status: 'closed' }), 'Open', ME), false);
  assert.ok(model.SCOPES.includes('Waiting') && model.SCOPES.includes('Closed') && model.SCOPES.includes('Unassigned'));
});

test('the strip counts open work, yours, what is urgent, and everything ever resolved', () => {
  const list = [
    ticket({}, { status: 'open', assignee_id: ME, priority: 'urgent' }),
    ticket({}, { status: 'waiting', assignee_id: YOU }),
    ticket({}, { status: 'resolved', assignee_id: ME }),
    ticket({}, { status: 'closed', priority: 'high' })
  ];
  assert.deepEqual({ ...model.counts(list, ME) }, { open: 2, mine: 1, urgent: 1, done: 2 });
});

test('search finds a ticket by its number the way people write it, and by the customer\'s address', () => {
  const t = ticket();
  assert.equal(model.matchesQuery(t, 'VYG-142'), true);
  assert.equal(model.matchesQuery(t, 'vyg-142'), true);
  assert.equal(model.matchesQuery(t, 'ana@northline'), true);
  assert.equal(model.matchesQuery(t, 'checkout'), true);
  assert.equal(model.matchesQuery(t, 'refund'), false);
  assert.equal(model.matchesQuery(t, '   '), true, 'no search is everything');
});

/* ── The conversation ─────────────────────────────────────────────────── */

test('the whole conversation, oldest first: the customer, our replies and the notes between us', () => {
  const t = ticket({
    thread: [
      { id: 'm3', direction: 'internal', who: 'Sam Rivera', body: 'Asked engineering', created_at: '2026-09-14T11:00:00Z' },
      { id: 'm1', direction: 'inbound', who: '', body: 'It fails at payment', created_at: '2026-09-14T09:00:00Z' },
      { id: 'm2', direction: 'outbound', who: 'Sam Rivera', body: 'Looking into it', created_at: '2026-09-14T10:00:00Z', delivered_at: '2026-09-14T10:00:05Z' },
      { id: 'm4', direction: 'outbound', who: 'Sam Rivera', body: 'Fixed', created_at: '2026-09-14T12:00:00Z', delivery_error: 'mailbox refused' },
      { id: 'm5', direction: 'outbound', who: 'Sam Rivera', body: 'Old reply', created_at: '2026-09-14T13:00:00Z' }
    ]
  });
  const shown = model.conversation(t);
  assert.deepEqual([...shown.map(m => m.id)], ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.deepEqual([...shown.map(m => m.kind)], ['Customer', 'Reply', 'Internal note', 'Reply', 'Reply']);
  assert.equal(shown[0].who, 'Ana Lima', 'the customer, when the message does not name its author');
  assert.equal(shown[1].delivery, 'Sent');
  assert.equal(shown[2].delivery, null, 'a note is never sent');
  assert.equal(shown[3].delivery, 'Not sent: mailbox refused');
  assert.equal(shown[4].delivery, null, 'a reply with no delivery recorded claims neither');
});

test('the reply box says what it will do before anything is sent', () => {
  const t = ticket();
  assert.equal(model.replyNote(t, 'reply'), 'Emailed to ana@northline.example.');
  assert.equal(model.replyButton(t, 'reply'), 'Send reply');
  assert.equal(model.replyNote(t, 'note'), 'Internal note: only the team sees it.');
  assert.equal(model.replyButton(t, 'note'), 'Add note');
  const noAddress = ticket({ contactEmail: '' });
  assert.match(model.replyNote(noAddress, 'reply'), /no customer address/);
  assert.equal(model.replyButton(noAddress, 'reply'), 'Save reply');
});

/* ── Details ──────────────────────────────────────────────────────────── */

test('the owner picker starts with Unassigned, and keeps an owner who has left', () => {
  const team = [{ id: ME, name: 'Sam Rivera' }, { id: YOU, name: 'Ana Park' }];
  assert.deepEqual([...model.ownerOptions(team, null)].map(o => [...o]),
    [['', 'Unassigned'], [ME, 'Sam Rivera'], [YOU, 'Ana Park']]);
  assert.deepEqual(model.ownerOptions(team, 'e-gone', 'Jo Former').map(o => [...o])[1], ['e-gone', 'Jo Former']);
});

test('resolving an open ticket, reopening a done one', () => {
  assert.deepEqual({ ...model.resolveAction(ticket({}, { status: 'waiting' })) }, { status: 'resolved', label: 'Resolve ticket' });
  assert.deepEqual({ ...model.resolveAction(ticket({}, { status: 'closed' })) }, { status: 'open', label: 'Reopen ticket' });
});

test('connected work is found by the ticket\'s ids, never by a matching name', () => {
  const projects = [{ id: 'p-other', name: 'Kept relaunch' }, { id: 'p-real', name: 'Something else' }];
  const contacts = [{ id: 'c-namesake', name: 'Ana Lima' }, { id: 'c-real', name: 'A. Lima' }];
  const t = ticket({ product: 'Kept' }, { project_id: 'p-real', contact_id: 'c-real' });
  assert.equal(model.projectFor(t, projects).id, 'p-real');
  assert.equal(model.contactFor(t, contacts).id, 'c-real');
  assert.equal(model.projectFor(ticket({ product: 'Kept' }), projects), null, 'no project id is no project');
  assert.equal(model.contactFor(ticket(), contacts), null);
});

/* ── Timing: age, first response, resolution (audit #3, #9) ─────────────── */

test('a duration between two moments reads in the coarsest sensible unit', () => {
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', '2026-09-14T09:00:20Z'), 'Under a minute');
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', '2026-09-14T09:01:00Z'), '1 minute');
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', '2026-09-14T09:45:00Z'), '45 minutes');
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', '2026-09-14T10:00:00Z'), '1 hour');
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', '2026-09-14T11:00:00Z'), '2 hours');
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', '2026-09-15T09:00:00Z'), '1 day');
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', '2026-09-16T09:00:00Z'), '2 days');
});

test('a duration going backwards, or missing an end, is nothing rather than a negative number', () => {
  assert.equal(model.durationLabel(null, '2026-09-14T09:00:00Z'), null, 'no start');
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', null), null, 'no end');
  assert.equal(model.durationLabel('not a date', '2026-09-14T09:00:00Z'), null, 'an unreadable start');
  assert.equal(model.durationLabel('2026-09-14T09:00:00Z', '2026-09-14T08:00:00Z'), 'Under a minute',
    'a clock a moment behind the one that stamped the start reads as no time at all, not a negative one');
});

test('a response target is met, missed, still due, or overdue — never more than one at once', () => {
  const due = '2026-09-14T12:00:00Z';
  assert.equal(model.targetStatus(due, '2026-09-14T11:00:00Z', '2026-09-14T13:00:00Z'), 'met');
  assert.equal(model.targetStatus(due, due, '2026-09-14T13:00:00Z'), 'met', 'exactly on time is met');
  assert.equal(model.targetStatus(due, '2026-09-14T12:00:01Z', '2026-09-14T13:00:00Z'), 'missed');
  assert.equal(model.targetStatus(due, null, '2026-09-14T11:00:00Z'), 'due');
  assert.equal(model.targetStatus(due, null, due), 'due', 'exactly at the deadline, still not overdue');
  assert.equal(model.targetStatus(due, null, '2026-09-14T12:00:01Z'), 'overdue');
  assert.equal(model.targetStatus(null, null, '2026-09-14T13:00:00Z'), null, 'no target is nothing to judge');
});

/* ── Editing (audit #2): subject, contact, company, project, product ────── */

test('an edit to a ticket changes only what the form sent, and only what actually differs', () => {
  const t = ticket({ title: 'Checkout is broken', product: 'Kept' }, { contact_id: 'c1', company_id: 'co1', project_id: 'p1' });
  assert.deepEqual({ ...model.ticketChanges(t, { subject: 'Checkout is broken' }).changes }, {},
    'sent, but the same as it was, is nothing to save');
  assert.deepEqual({ ...model.ticketChanges(t, {}).changes }, {}, 'a field never sent is not judged');
  assert.deepEqual({ ...model.ticketChanges(t, { subject: 'Checkout is still broken' }).changes },
    { subject: 'Checkout is still broken' });
  assert.deepEqual({ ...model.ticketChanges(t, { contactId: '', companyId: 'co2', projectId: 'p2' }).changes },
    { contact_id: null, company_id: 'co2', project_id: 'p2' });
  assert.deepEqual({ ...model.ticketChanges(t, { product: '' }).changes }, { product: null });
  assert.deepEqual({ ...model.ticketChanges(t, { product: '  Kept  ' }).changes }, {}, 'trimmed before it is compared');
  const noProduct = ticket({ title: 'Checkout is broken', product: '—' }, {});
  assert.deepEqual({ ...model.ticketChanges(noProduct, { product: '' }).changes }, {},
    'queries.tickets() reads no product as the placeholder "—": leaving it blank is not a change');
});

test('a ticket cannot be saved with a blank subject', () => {
  const refused = model.ticketChanges(ticket(), { subject: '   ' });
  assert.deepEqual({ ...refused.changes }, {});
  assert.match(refused.problem, /needs a subject/);
  assert.equal(refused.field, 'subject');
});

/* ── Delete and restore (audit #4) ───────────────────────────────────────── */

test('a ticket is deleted only when the database says so', () => {
  assert.equal(model.isDeleted(ticket({}, { deleted_at: '2026-09-14T09:00:00Z' })), true);
  assert.equal(model.isDeleted(ticket()), false);
  assert.equal(model.isDeleted(ticket({}, { deleted_at: null })), false);
});

/* ── Merging (audit #8): who to merge into, typed however people write it ── */

/* ── Attachments (audit #11) ─────────────────────────────────────────────── */

test('a file size reads the way a person would say it', () => {
  assert.equal(model.fileSize(0), '0 B');
  assert.equal(model.fileSize(512), '512 B');
  assert.equal(model.fileSize(2048), '2 KB');
  assert.equal(model.fileSize(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(model.fileSize(2 * 1024 * 1024), '2 MB', 'a whole number of megabytes has no trailing .0');
});

test('a file too large or empty cannot be attached to a ticket; a good one is fine', () => {
  assert.match(model.fileProblem({ name: 'x.png', size: 0 }), /is empty/);
  assert.match(model.fileProblem({ name: 'x.png', size: 30 * 1024 * 1024 }), /larger than 25 MB/);
  assert.equal(model.fileProblem({ name: 'x.png', size: 1024 }), null);
  assert.match(model.fileProblem(null), /Pick a file/);
});

test('a typed reference to a ticket reads its number however someone writes it', () => {
  assert.equal(model.numberFromRef('142'), 142);
  assert.equal(model.numberFromRef('VYG-142'), 142);
  assert.equal(model.numberFromRef('#vyg-142'), 142);
  assert.equal(model.numberFromRef('  #VYG-142  '), 142);
  assert.equal(model.numberFromRef('nope'), null);
  assert.equal(model.numberFromRef(''), null);
  assert.equal(model.numberFromRef('142.5'), null, 'a ticket number is a whole number');
});
