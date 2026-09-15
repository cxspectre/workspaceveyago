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
