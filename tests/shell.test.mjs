/* The workspace shell, without a page: what the search box can find and in
   which order, how the arrow keys move through its results, and what the bell
   lists. Loaded into a sandbox the way <script> tags run it.
   Run from the repo root with: node --test

   Arrays made inside the sandbox have the sandbox's Array.prototype, which
   strict deep-equality rejects — hence the [...spread] before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console });
for (const file of ['overview-model.js', 'finance-model.js', 'shell-model.js']) {
  vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
}
const model = vm.runInContext('shellModel', context);
const finance = vm.runInContext('financeModel', context);

/* What the views hold once the store has loaded. */
const sources = {
  navs: [['overview', 'Overview'], ['tickets', 'Tickets']],
  tickets: [{ id: 7, uuid: 't7', title: 'Checkout broken', client: 'Ana Lima', product: 'Kept', status: 'Open', priority: 'High' }],
  projects: [{ id: 'p1', name: 'Northline site', client: 'Northline', description: 'The new site', tasks: ['Send the draft'] }],
  contacts: [{ id: 'c0', name: 'Ana Lima', company: 'Northline', email: 'ana@northline.example', row: { company: { id: 'co1' } } }],
  companies: [{ id: 'co1', name: 'Northline', domain: 'northline.example' }, { id: 'co2', name: 'Quiet Co', domain: '' }],
  team: [{ id: 'm1', name: 'Sam Rivera', role: 'Designer' }],
  events: [{ id: 'e1', title: 'Northline kickoff', detail: 'Zoom', time: '10:00', when: 'Thu 17 Sep · 10:00' }],
  invoices: [{ id: 'INV-7', uuid: 'i7', client: 'Northline', amount: '$1,200', status: 'Overdue' }],
  mails: [{ id: 'th1', subject: 'Draft for review', sender: 'Ana Lima', email: 'ana@northline.example', preview: 'Here it is', folder: 'inbox' }],
  notes: { tickets: { 7: [{ body: 'Customer uses Safari 17' }] }, projects: {}, crm: {}, agenda: {} },
  mailRoute: m => `mail/all/${m.folder}/${m.id}`
};

const found = (query, from = sources) => model.search(model.searchItems(from), query).results.map(r => `${r.type}:${r.route}`);

/* ── Search ───────────────────────────────────────────────────────────── */

test('search finds people, companies, tasks and notes, not only records', () => {
  assert.deepEqual([...found('sam')], ['Person:company/people/m1']);
  assert.ok(found('send the').includes('Task:projects/p1/tasks'));
  assert.ok(found('safari').includes('Note:tickets/7'));
  assert.ok(found('draft for').includes('Mail:mail/all/inbox/th1'));
});

test('an event is found with the day it is on, and a project meeting beyond the weeks loaded is found too, once', () => {
  const withMeetings = { ...sources, projectEvents: [
    { id: 'E1', title: 'Northline kickoff', detail: 'Zoom', time: '10:00', when: 'Thu 17 Sep · 10:00' },
    { id: 'pm9', title: 'Harbor design review', detail: 'Bring the mockups', time: '14:00', when: 'Tue 13 Oct · 14:00' }
  ] };
  const events = model.search(model.searchItems(withMeetings), 'northline kickoff').results.filter(r => r.type === 'Event');
  assert.deepEqual([...events.map(r => [r.route, r.detail])], [['agenda/e1', 'Thu 17 Sep · 10:00']],
    'in the weeks and the project meetings both, whatever case its id is in: found once, by the day it is on');
  assert.ok(found('harbor design', withMeetings).includes('Event:agenda/pm9'));
  assert.ok(found('mockups', withMeetings).includes('Event:agenda/pm9'), 'by its details too');
  assert.deepEqual([...model.searchItems({ events: [{ id: 'x', title: 'Standup', time: '09:00' }] }).map(i => i.detail)], ['09:00'],
    'one with no day given keeps its time');
});

test('a company opens its own page, whoever works there', () => {
  assert.ok(found('northline').includes('Company:crm/companies/co1'));
  assert.deepEqual([...found('quiet')], ['Company:crm/companies/co2']);
});

test('contacts, invoices and people open by their id, not by their place in the list', () => {
  assert.ok(found('ana lima').includes('Contact:crm/c0'));
  assert.ok(found('inv-7').includes('Invoice:finance/i7'));
  const grown = {
    ...sources,
    contacts: [{ id: 'c-new', name: 'Bo Chen', company: 'Atlas', email: '', row: {} }, ...sources.contacts],
    invoices: [{ id: 'INV-6', uuid: 'i6', client: 'Atlas', amount: '$10', status: 'Paid' }, ...sources.invoices]
  };
  assert.ok(found('ana lima', grown).includes('Contact:crm/c0'), 'someone added first does not move the link');
  assert.ok(found('inv-7', grown).includes('Invoice:finance/i7'));
});

test('an invoice is found as Finance finds it, when that is handed in: by its address, what it is for, or its number however it is written', () => {
  const row = { id: 'b1000000-0000-4000-8000-000000000001', number: 'INV-1042', client: 'Harbor & Co',
    client_email: 'billing@northline.example', notes: 'Site build', amount: 1234.5, currency: 'USD', status: 'sent' };
  const invoice = { id: row.number, uuid: row.id, client: row.client, amount: '$1,234.50', status: 'Sent', row };
  const route = `Invoice:finance/${row.id}`;
  const withFinance = { ...sources, invoices: [invoice], invoiceMatches: finance.matchesQuery };
  for (const query of ['billing@northline', 'inv 1042', 'harbor co', 'site build']) {
    assert.ok(found(query, withFinance).includes(route), query);
  }
  assert.ok(!found('inv 1042', { ...sources, invoices: [invoice] }).includes(route), 'without it, only the words the list shows');
});

test('a row opens its record on a click; a click on its link that asks for a new tab or window is left to the browser', () => {
  const link = {};
  const onLink = { closest: selector => (selector === 'a[href]' ? link : null) };
  const onCell = { closest: () => null };
  assert.equal(model.opensHere({ target: onLink }), true, 'a plain click on the link opens the record here');
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.equal(model.opensHere({ target: onLink, [key]: true }), false, key);
    assert.equal(model.opensHere({ target: onCell, [key]: true }), true, key + ' elsewhere in the row still opens it');
  }
  assert.equal(model.opensHere({}), true);
});

test('labels that start with the words come first, then labels that contain them, then the rest', () => {
  const types = model.search(model.searchItems(sources), 'northline').results.map(r => r.type);
  assert.deepEqual([...types], ['Project', 'Company', 'Event', 'Invoice', 'Contact', 'Mail']);
});

test('at most twelve results, and it says how many more there are', () => {
  const many = {
    ...sources,
    tickets: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, uuid: `t${i}`, title: `Bug ${i}`, client: 'X', product: 'Y', status: 'Open', priority: 'Low' }))
  };
  const out = model.search(model.searchItems(many), 'bug');
  assert.equal(out.results.length, 12);
  assert.equal(out.more, 8);
});

test('an empty search finds nothing', () => {
  assert.equal(model.search(model.searchItems(sources), '   ').results.length, 0);
});

test('a record with nothing to search by is still findable by its number', () => {
  assert.ok(found('vyg-7').includes('Ticket:tickets/7'));
});

/* ── The keyboard ─────────────────────────────────────────────────────── */

test('arrow keys move through the results, and back up to the box', () => {
  assert.equal(model.nextFocus(-1, 'ArrowDown', 3), 0);
  assert.equal(model.nextFocus(0, 'ArrowDown', 3), 1);
  assert.equal(model.nextFocus(2, 'ArrowDown', 3), 0, 'wraps round');
  assert.equal(model.nextFocus(0, 'ArrowUp', 3), -1, 'back to the box');
  assert.equal(model.nextFocus(-1, 'ArrowUp', 3), 2, 'up from the box is the last result');
  assert.equal(model.nextFocus(1, 'Home', 3), 0);
  assert.equal(model.nextFocus(1, 'End', 3), 2);
  assert.equal(model.nextFocus(-1, 'ArrowDown', 0), -1, 'nothing to move to');
  assert.equal(model.nextFocus(1, 'a', 3), 1, 'any other key leaves focus where it is');
});

/* ── The bell ─────────────────────────────────────────────────────────── */

test('the bell lists what needs someone, each leading to it', () => {
  const items = model.attention({
    tickets: [
      { id: 7, uuid: 't7', client: 'Ana', priority: 'High', status: 'Open' },
      { id: 8, uuid: 't8', client: 'Bo', priority: 'Urgent', status: 'Closed' },
      { id: 9, uuid: 't9', client: 'Cy', priority: 'Low', status: 'Open' }
    ],
    invoices: [
      { id: 'INV-1', uuid: 'i1', client: 'Northline', amount: '$1,200', status: 'Overdue' },
      { id: 'INV-2', uuid: 'i2', client: 'Atlas', amount: '$300', status: 'Paid' }
    ],
    unreadMail: 2,
    eventsToday: [{ title: 'Kickoff' }],
    isManager: true
  });
  assert.deepEqual([...items.map(i => i.route)], ['tickets/7', 'finance/i1', 'mail', 'agenda/today'],
    'events today open today in the agenda, whatever week it was left on');
  assert.equal(items[0].title, '#VYG-7 needs attention');
  assert.equal(items[0].detail, 'High priority · Ana');
  assert.equal(items[1].title, 'INV-1 is overdue');
  assert.equal(items[2].title, '2 unread conversations');
  assert.equal(items[3].title, '1 event today');
  assert.equal(items[3].detail, 'Kickoff');
});

test('someone who cannot read Finance is not told about invoices', () => {
  const items = model.attention({
    tickets: [], invoices: [{ id: 'INV-1', client: 'N', amount: '$1', status: 'Overdue' }],
    unreadMail: 0, eventsToday: [], isManager: false
  });
  assert.equal(items.length, 0);
});

/* ── Focus across a repaint ───────────────────────────────────────────── */

test('a control is found again by everything that tells it apart, not by its first attribute', () => {
  assert.equal(model.focusSelector('TR', { 'data-action': 'ticket', 'data-id': '7', role: 'button', tabindex: '0' }),
    'tr[data-action="ticket"][data-id="7"]', 'every ticket row has data-action="ticket"');
  assert.equal(model.focusSelector('input', { 'data-query': 'tickets', type: 'search' }), 'input[data-query="tickets"]');
  assert.equal(model.focusSelector('a', { href: '#projects/p"1\\x' }), 'a[href="#projects/p\\"1\\\\x"]',
    'quotes and backslashes cannot break out of the selector');
  assert.equal(model.focusSelector('div', { class: 'panel' }), null, 'nothing tells it apart');
  assert.equal(model.focusSelector('button', null), null);
});

test('an outstanding invoice that is not yet late says outstanding', () => {
  const items = model.attention({
    tickets: [], invoices: [{ id: 'INV-3', client: 'Atlas', amount: '$300', status: 'Sent' }],
    unreadMail: 0, eventsToday: [], isManager: true
  });
  assert.equal(items[0].title, 'INV-3 is outstanding');
  assert.equal(items[0].detail, '$300 · Atlas');
});

test('a ticket\'s selects, its resolve button, a project\'s role select and anything with an id are found again after a repaint', () => {
  assert.equal(model.focusSelector('SELECT', { 'data-record-kind': 'tickets', 'data-record-id': '142', 'data-field': 'status' }),
    'select[data-record-id="142"][data-field="status"]');
  assert.equal(model.focusSelector('BUTTON', { 'data-ticket': '142', 'data-ticket-status': 'resolved' }), 'button[data-ticket="142"]',
    'by its ticket, not by what it does next: Resolve becomes Reopen');
  assert.equal(model.focusSelector('BUTTON', { id: 'ticket-reply-send-142', type: 'submit' }), 'button[id="ticket-reply-send-142"]');
  assert.equal(model.focusSelector('SELECT', { 'data-people-role': 'p1', 'data-contact': 'c1', 'aria-label': 'Role of Ana' }),
    'select[data-people-role="p1"][data-contact="c1"]');
  assert.equal(model.focusSelector('BUTTON', { 'data-view': 'ticketScope', 'data-value': 'Open' }),
    'button[data-view="ticketScope"][data-value="Open"]', 'one view button, not the first of them');
});

test('opening a company or a person from its list is a new page for focus, and a tab of the same record is not', () => {
  assert.notEqual(model.pageKey('crm', ['crm', 'companies']), model.pageKey('crm', ['crm', 'companies', 'co1']));
  assert.notEqual(model.pageKey('crm', ['crm', 'companies', 'co1']), model.pageKey('crm', ['crm', 'companies', 'co2']), 'one company to another, through search');
  assert.notEqual(model.pageKey('company', ['company', 'people']), model.pageKey('company', ['company', 'people', 'm1']));
  assert.notEqual(model.pageKey('crm', ['crm', 'c1']), model.pageKey('crm', ['crm', 'c2']));
  assert.equal(model.pageKey('crm', ['crm', 'c1']), model.pageKey('crm', ['crm', 'c1', 'activity']), 'a tab of the same contact');
  assert.equal(model.pageKey('projects', ['projects', 'p1', 'tasks']), model.pageKey('projects', ['projects', 'p1', 'files']));
  assert.ok(model.pageKey('mail', ['mail']).startsWith('mail/'), 'Mail keeps focus inside its own panes, as it did');
  assert.ok(model.pageKey('mail', ['mail', 'all', 'sent']).startsWith('mail/'));
});

test('the agenda\'s week and day buttons, an event\'s remove button and a task\'s controls are found again after a repaint', () => {
  assert.equal(model.focusSelector('BUTTON', { type: 'button', class: 'btn agenda-step', 'data-agenda-week': 'next', 'aria-label': 'Next week' }),
    'button[data-agenda-week="next"]', 'Next week stays under the keyboard as the weeks move on');
  assert.equal(model.focusSelector('BUTTON', { type: 'button', 'data-agenda-day': '2026-09-16' }), 'button[data-agenda-day="2026-09-16"]');
  assert.equal(model.focusSelector('BUTTON', { class: 'btn', 'data-agenda-delete': 'ev-1' }), 'button[data-agenda-delete="ev-1"]');
  assert.equal(model.focusSelector('BUTTON', { type: 'button', class: 'calendar-key', 'data-agenda-kind': 'personal', 'aria-pressed': 'false' }),
    'button[data-agenda-kind="personal"]', 'a calendar\'s toggle stays under the keyboard as it hides its events');
  assert.equal(model.focusSelector('BUTTON', { type: 'button', class: 'btn', 'data-agenda-edit': 'ev-1' }), 'button[data-agenda-edit="ev-1"]',
    'Edit event is under the keyboard again once the event it saved is drawn');
  assert.equal(model.focusSelector('SELECT', { 'data-task-status': 't1', 'aria-label': 'Status of Wireframes' }), 'select[data-task-status="t1"]');
  assert.equal(model.focusSelector('BUTTON', { 'data-task-edit': 't1', 'aria-label': 'Edit Wireframes' }), 'button[data-task-edit="t1"]');
  assert.equal(model.focusSelector('BUTTON', { 'data-task-remove': 't1', 'aria-label': 'Remove Wireframes' }), 'button[data-task-remove="t1"]');
  assert.equal(model.focusSelector('BUTTON', { type: 'button', class: 'btn', 'data-task-new': 'p1' }), 'button[data-task-new="p1"]',
    'New task is under the keyboard again once the task it added is drawn');
  assert.equal(model.focusSelector('BUTTON', { type: 'button', class: 'text-btn', 'data-note-edit': 'n1', 'aria-label': 'Edit your note from Today' }), 'button[data-note-edit="n1"]');
  assert.equal(model.focusSelector('BUTTON', { type: 'button', class: 'text-btn', 'data-note-remove': 'n1', 'aria-label': 'Remove your note from Today' }), 'button[data-note-remove="n1"]');
});
