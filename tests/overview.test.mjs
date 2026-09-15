/* The Overview, without a page: what its tiles count, which tasks are "yours",
   which projects are active, where an activity entry leads, what the breadcrumb
   says and who sees Finance. Loaded into a sandbox the way <script> tags run
   it. Run from the repo root with: node --test

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence the {...spread} before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console });
for (const file of ['projects-model.js', 'overview-model.js']) {
  vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
}
const model = vm.runInContext('overviewModel', context);
const isActive = vm.runInContext('projectsModel', context).isActive;

const ME = 'e1000000-0000-4000-8000-000000000001';
const YOU = 'e1000000-0000-4000-8000-000000000002';
const TODAY = '2026-09-14';

/* A project as the store shapes it (projectsModel.shapeProject). */
const project = (over = {}) => ({
  id: 'p1', uuid: 'p1', name: 'Northline site', client: 'Northline', status: 'In progress',
  dueOn: null, due: '', tasks: [], taskIds: [], taskDue: [], taskDueOn: [], taskAssignees: [], checked: [],
  ...over
});

/* ── The tiles ────────────────────────────────────────────────────────── */

const tickets = [
  { status: 'Open', priority: 'High' }, { status: 'In progress', priority: 'Normal' },
  { status: 'Waiting', priority: 'Urgent' }, { status: 'Resolved', priority: 'High' },
  { status: 'Closed', priority: 'Urgent' }
];
const projects = [
  project({ status: 'In progress' }), project({ status: 'On hold' }),
  project({ status: 'Discovery' }), project({ status: 'Completed' })
];
/* Today's events, as agendaModel.eventsOn() places them. */
const eventsToday = [{ id: 'e1', title: 'Kickoff' }, { id: 'e2', title: 'Review' }];

test('an open ticket is open, in progress or waiting — closed is not open', () => {
  ['Open', 'In progress', 'Waiting'].forEach(status => assert.equal(model.isOpenTicket({ status }), true, status));
  ['Resolved', 'Closed'].forEach(status => assert.equal(model.isOpenTicket({ status }), false, status));
});

test('without the database figures, the tiles count what they say — not everything loaded', () => {
  const counts = model.tileCounts({ overview: null, tickets, projects, eventsToday, isActive });
  assert.deepEqual({ ...counts }, { ticketsOpen: 3, ticketsHigh: 2, projectsActive: 2, tasksMine: null, eventsToday: 2 });
});

test('with the database figures, the tiles use them — except today, which follows the agenda beside it', () => {
  const overview = { tickets_open: 7, tickets_high: 1, projects_active: 4, tasks_mine: 3, events_today: 5 };
  assert.deepEqual({ ...model.tileCounts({ overview, tickets, projects, eventsToday, isActive }) },
    { ticketsOpen: 7, ticketsHigh: 1, projectsActive: 4, tasksMine: 3, eventsToday: 2 });
  assert.equal(model.tileCounts({ overview, tickets, projects, eventsToday: null, isActive }).eventsToday, 5,
    'the database count when the week did not load');
});

test('a part that never loaded is not counted as zero', () => {
  const counts = model.tileCounts({ overview: null, tickets: null, projects: null, eventsToday: null, isActive });
  assert.deepEqual({ ...counts }, { ticketsOpen: null, ticketsHigh: null, projectsActive: null, tasksMine: null, eventsToday: null });
});

test('a count reads as a number, and a missing one as a dash — never "07"', () => {
  assert.equal(model.formatCount(7), '7');
  assert.equal(model.formatCount(0), '0');
  assert.equal(model.formatCount(null), '—');
});

test('one ticket, two tickets', () => {
  assert.equal(model.plural(1, 'open ticket'), '1 open ticket');
  assert.equal(model.plural(2, 'open ticket'), '2 open tickets');
  assert.equal(model.plural(0, 'active project'), '0 active projects');
  assert.equal(model.plural(1, 'person', 'people'), '1 person');
  assert.equal(model.plural(3, 'person', 'people'), '3 people');
});

/* ── Money ────────────────────────────────────────────────────────────── */

test('revenue is shown in its own currency, with the others named rather than added in', () => {
  const figures = model.revenueFigures({
    revenue_currency: 'EUR', revenue_month: 1200, revenue_prev_month: 1000, revenue_prev_through: '2026-08-14',
    revenue_by_currency: [
      { currency: 'EUR', month: 1200, previous: 1000 },
      { currency: 'USD', month: 300, previous: 0 },
      { currency: 'GBP', month: 0, previous: 80 }
    ],
    invoices_outstanding: {
      count: 3, currency: 'EUR', amount: 900, due_next: '2026-09-20',
      by_currency: [{ currency: 'EUR', count: 2, amount: 900 }, { currency: 'USD', count: 1, amount: 50 }]
    }
  });
  assert.equal(figures.currency, 'EUR');
  assert.equal(figures.month, 1200);
  assert.equal(figures.trend, 20);
  assert.equal(figures.previousThrough, '2026-08-14');
  assert.deepEqual([...figures.otherCurrencies], ['USD'], 'GBP had nothing this month');
  assert.equal(figures.invoices.amount, 900);
  assert.equal(figures.invoices.currency, 'EUR');
  assert.equal(figures.invoices.count, 3);
  assert.deepEqual([...figures.invoices.otherCurrencies], ['USD']);
});

test('no income last month is no trend at all, not "up 100%"', () => {
  assert.equal(model.revenueFigures({ revenue_currency: 'USD', revenue_month: 50, revenue_prev_month: 0 }).trend, null);
  assert.equal(model.revenueFigures({ revenue_currency: 'USD', revenue_month: 33, revenue_prev_month: 90 }).trend, -63.3);
});

test('a database that has not been updated yet still reads, as one currency', () => {
  const figures = model.revenueFigures({ revenue_month: 80, revenue_prev_month: 100, invoices_outstanding: { count: 1, amount: 20, due_next: null } });
  assert.equal(figures.currency, 'USD');
  assert.equal(figures.trend, -20);
  assert.deepEqual([...figures.otherCurrencies], []);
  assert.equal(figures.invoices.currency, 'USD');
  assert.equal(figures.invoices.amount, 20);
});

test('invoices in another currency are named by whether any are owed, not by their amount', () => {
  const figures = model.revenueFigures({
    revenue_currency: 'EUR', revenue_month: 0, revenue_prev_month: 0,
    invoices_outstanding: {
      count: 1, currency: 'EUR', amount: 100, due_next: '2026-09-20',
      by_currency: [{ currency: 'EUR', count: 1, amount: 100 }, { currency: 'USD', count: 1, amount: 0 }]
    }
  });
  assert.deepEqual([...figures.invoices.otherCurrencies], ['USD'], 'an invoice for nothing is still owed');
  assert.equal(figures.invoices.count, 1, 'the count is the shown currency\'s, as the database gives it');
  assert.equal(figures.invoices.dueNext, '2026-09-20');
});

test('the invoice tile says what Finance says of loaded invoices, and never "Due" a day gone by', () => {
  const owed = (overdue, nextDue) => ({ currency: 'USD', overdue, nextDue });
  assert.equal(model.invoiceDueNote('2026-09-10', owed(1, '2026-09-20'), TODAY), '1 overdue · Due Sep 20');
  assert.equal(model.invoiceDueNote('2026-09-10', owed(2, null), TODAY), '2 overdue');
  assert.equal(model.invoiceDueNote('2026-09-20', owed(0, '2026-09-20'), TODAY), 'Due Sep 20');
  assert.equal(model.invoiceDueNote('2026-09-20', owed(0, null), TODAY), '', 'none late, and no due date set');
  assert.equal(model.invoiceDueNote('2026-09-10', null, TODAY), 'Overdue since Sep 10', 'without the invoices, the database\'s date');
  assert.equal(model.invoiceDueNote(TODAY, null, TODAY), 'Due Sep 14');
  assert.equal(model.invoiceDueNote(null, null, TODAY), '');
  assert.equal(model.invoiceDueNote('2026-09-10', null, null), 'Due Sep 10', 'with no today, nothing is called late');
});

test('a record whose list did not load, or on a page closed to this person, is named by what it is, not "Not found"', () => {
  const labels = { finance: 'Finance', tickets: 'Tickets', company: 'Company' };
  const U = 'b1000000-0000-4000-8000-000000000001';
  const at = (page, parts, over) => model.crumb(page, parts, { labels, invoices: [], tickets: [], team: [], ...over }).current;
  assert.equal(at('finance', ['finance', U], { has: () => false }), 'Invoice', 'invoices did not load');
  assert.equal(at('finance', ['finance', U], { has: () => true, open: false }), 'Invoice', 'Finance is closed to this person');
  assert.equal(at('finance', ['finance', U], { has: () => true, open: true }), 'Not found', 'loaded, open, and not there');
  assert.equal(at('finance', ['finance', 'invoices'], { has: () => false }), 'Invoices', 'a section is still named');
  assert.equal(at('tickets', ['tickets', '7'], { has: part => part !== 'tickets' }), 'Ticket');
  assert.equal(at('company', ['company', 'people', 'e1'], { has: () => false }), 'Person');
  assert.equal(at('finance', ['finance', U], {}), 'Not found', 'a caller that says nothing about loading reads as before');
});

test('no money figures for someone the database gives none', () => {
  assert.equal(model.revenueFigures({ revenue_month: null }), null);
  assert.equal(model.revenueFigures(null), null);
});

/* ── My focus ─────────────────────────────────────────────────────────── */

test('"my focus" is my unticked tasks on active projects, soonest first', () => {
  const list = [
    project({
      id: 'p1', name: 'Northline site',
      tasks: ['Mine, later', 'Yours', 'Mine, done', 'Mine, no date'], taskIds: ['t1', 't2', 't3', 't4'],
      taskDueOn: ['2026-09-20', '2026-09-15', '2026-09-10', null], taskDue: ['Sep 20', 'Sep 15', 'Sep 10', ''],
      taskAssignees: [ME, YOU, ME, ME], checked: [2]
    }),
    project({
      id: 'p2', name: 'Paused app', status: 'On hold',
      tasks: ['Mine, on hold'], taskIds: ['t5'], taskDueOn: ['2026-09-01'], taskDue: ['Sep 1'], taskAssignees: [ME]
    }),
    project({
      id: 'p3', name: 'Atlas',
      tasks: ['Mine, overdue'], taskIds: ['t6'], taskDueOn: ['2026-09-12'], taskDue: ['Sep 12'], taskAssignees: [ME]
    })
  ];
  const focus = model.focusTasks(list, ME, { isActive, today: TODAY });
  assert.deepEqual([...focus.map(f => f.taskId)], ['t6', 't1', 't4']);
  assert.equal(focus[0].overdue, true);
  assert.equal(focus[1].overdue, false);
  assert.equal(focus[0].projectId, 'p3');
  assert.equal(focus[0].projectName, 'Atlas');
  assert.equal(focus[2].index, 3, 'the position the task checkbox needs');
});

test('nobody signed in, or nothing assigned, is no focus — not somebody else\'s tasks', () => {
  const list = [project({ tasks: ['Yours'], taskIds: ['t2'], taskDueOn: [null], taskDue: [''], taskAssignees: [YOU] })];
  assert.equal(model.focusTasks(list, ME, { isActive, today: TODAY }).length, 0);
  assert.equal(model.focusTasks(list, null, { isActive, today: TODAY }).length, 0);
});

test('focus stops at three unless asked for more', () => {
  const many = project({
    tasks: ['a', 'b', 'c', 'd'], taskIds: ['1', '2', '3', '4'],
    taskDueOn: [null, null, null, null], taskDue: ['', '', '', ''], taskAssignees: [ME, ME, ME, ME]
  });
  assert.equal(model.focusTasks([many], ME, { isActive, today: TODAY }).length, 3);
  assert.equal(model.focusTasks([many], ME, { isActive, today: TODAY, limit: 10 }).length, 4);
});

/* ── Projects ─────────────────────────────────────────────────────────── */

test('"active projects" leaves out paused and finished work, soonest due first', () => {
  const list = [
    project({ id: 'a', name: 'Undated', status: 'In progress', dueOn: null }),
    project({ id: 'b', name: 'Paused', status: 'On hold', dueOn: '2026-09-15' }),
    project({ id: 'c', name: 'Later', status: 'Discovery', dueOn: '2026-10-01' }),
    project({ id: 'd', name: 'Sooner', status: 'In review', dueOn: '2026-09-20' }),
    project({ id: 'e', name: 'Done', status: 'Completed', dueOn: '2026-09-01' })
  ];
  assert.deepEqual(model.activeProjects(list, isActive).map(p => p.id), ['d', 'c', 'a']);
  assert.deepEqual(model.activeProjects(list, isActive, 2).map(p => p.id), ['d', 'c']);
  assert.equal(list[0].id, 'a', 'the list it was given is not reordered');
});

test('"on track" is a count of overdue work, not a slogan', () => {
  const list = [
    project({ status: 'In progress', dueOn: '2026-09-10' }),
    project({ status: 'Discovery', dueOn: TODAY }),
    project({ status: 'On hold', dueOn: '2026-09-01' }),
    project({ status: 'In review', dueOn: null })
  ];
  assert.equal(model.overdueProjects(list, isActive, TODAY), 1, 'due today is not overdue yet, and paused work is not counted');
  assert.equal(model.projectsFoot(0), 'Nothing overdue');
  assert.equal(model.projectsFoot(1), '1 overdue');
  assert.equal(model.projectsFoot(3), '3 overdue');
});

/* ── Words on the page ────────────────────────────────────────────────── */

test('the welcome is for whoever is signed in', () => {
  assert.equal(model.greeting({ full_name: 'Sam Rivera' }), 'Welcome back, Sam. Here’s your day at Veyago.');
  assert.equal(model.greeting({ full_name: '  ' }), 'Here’s your day at Veyago.');
  assert.equal(model.greeting(null), 'Here’s your day at Veyago.');
});

test('"updated" says when the figures were loaded, and stays true', () => {
  assert.equal(model.updatedLabel(new Date(2026, 8, 14, 9, 5).getTime()), 'Updated at 09:05');
  assert.equal(model.updatedLabel(null), '');
});

/* ── Activity ─────────────────────────────────────────────────────────── */

const entry = (over = {}) => ({
  id: 'a1', who: 'Sam Rivera', initial: 'SR', text: 'Opened a ticket', when: 'Today',
  createdAt: '2026-09-14T14:02:00', entityType: 'ticket', entityId: 'uuid-7', ...over
});
const records = {
  tickets: [{ id: 7, uuid: 'uuid-7' }],
  projects: [{ id: 'p1' }],
  contacts: [{ id: 'c0' }, { id: 'c1' }],
  invoices: [{ id: 'INV-1', uuid: 'i1' }]
};

test('an activity entry says who and when, and leads to its record', () => {
  const item = model.activityItem(entry(), records);
  assert.equal(item.initial, 'SR');
  assert.equal(item.who, 'Sam Rivera');
  assert.equal(item.when, 'Today · 14:02');
  assert.equal(item.route, 'tickets/7');
  assert.equal(model.activityItem(entry({ entityType: 'project', entityId: 'p1' }), records).route, 'projects/p1');
  assert.equal(model.activityItem(entry({ entityType: 'contact', entityId: 'c1' }), records).route, 'crm/c1');
  assert.equal(model.activityItem(entry({ entityType: 'invoice', entityId: 'i1' }), records).route, 'finance/i1');
});

test('a contact or invoice link names the record, so one added before it changes nothing', () => {
  const grown = {
    ...records,
    contacts: [{ id: 'c-new' }, ...records.contacts],
    invoices: [{ id: 'INV-0', uuid: 'i0' }, ...records.invoices]
  };
  assert.equal(model.activityItem(entry({ entityType: 'contact', entityId: 'c1' }), grown).route, 'crm/c1');
  assert.equal(model.activityItem(entry({ entityType: 'invoice', entityId: 'i1' }), grown).route, 'finance/i1');
});

test('an entry whose record is gone, or of a kind with no page, leads nowhere', () => {
  assert.equal(model.activityItem(entry({ entityId: 'deleted' }), records).route, null);
  assert.equal(model.activityItem(entry({ entityType: 'mail' }), records).route, null);
});

test('an entry with nobody behind it is the studio, not a blank', () => {
  const item = model.activityItem(entry({ who: null, initial: null, createdAt: null }), records);
  assert.equal(item.who, 'Veyago');
  assert.equal(item.initial, 'V');
  assert.equal(item.when, 'Today');
});

/* ── The breadcrumb ───────────────────────────────────────────────────── */

const labels = { overview: 'Overview', mail: 'Mail', tickets: 'Tickets', agenda: 'Agenda', projects: 'Projects', crm: 'CRM', finance: 'Finance', company: 'Company' };
const data = {
  labels,
  tickets: [{ id: 7, title: 'Broken login' }],
  projects: [{ id: 'p1', name: 'Northline site' }],
  contacts: [{ id: 'c0', name: 'Ana Lima' }],
  events: [{ id: 'e1', title: 'Kickoff' }],
  invoices: [{ id: 'INV-1', uuid: 'i1' }],
  team: [{ id: 'm1', name: 'Sam Rivera' }],
  mailFolder: 'Sent'
};

test('a list page is just its name', () => {
  assert.deepEqual({ ...model.crumb('tickets', ['tickets'], data) }, { parent: null, current: 'Tickets' });
});

test('a record page names the record, and its list is a way back', () => {
  const projectCrumb = model.crumb('projects', ['projects', 'p1', 'files'], data);
  assert.equal(projectCrumb.current, 'Northline site');
  assert.deepEqual({ ...projectCrumb.parent }, { route: 'projects', label: 'Projects' });
  assert.equal(model.crumb('tickets', ['tickets', '7'], data).current, 'Broken login');
  assert.equal(model.crumb('crm', ['crm', 'c0'], data).current, 'Ana Lima');
  assert.equal(model.crumb('agenda', ['agenda', 'e1'], data).current, 'Kickoff');
  assert.equal(model.crumb('finance', ['finance', 'i1'], data).current, 'INV-1');
  assert.equal(model.crumb('finance', ['finance', 'invoices'], data).current, 'Invoices');
  assert.equal(model.crumb('company', ['company', 'studio'], data).current, 'Studio');
  assert.equal(model.crumb('company', ['company', 'people', 'm1'], data).current, 'Sam Rivera');
  assert.equal(model.crumb('overview', ['overview', 'activity'], data).current, 'Recent activity');
  assert.equal(model.crumb('mail', ['mail', 'all', 'sent'], data).current, 'Sent');
});

test('a record that is not there says so', () => {
  assert.equal(model.crumb('tickets', ['tickets', '99'], data).current, 'Not found');
  assert.equal(model.crumb('crm', ['crm', 'x'], data).current, 'Not found');
  assert.equal(model.crumb('crm', ['crm', '0'], data).current, 'Not found', 'an old link by place opens nobody');
  assert.equal(model.crumb('finance', ['finance', '0'], data).current, 'Not found');
  assert.equal(model.crumb('company', ['company', 'people', '0'], data).current, 'Not found');
});

test('an event outside the weeks loaded is named once it lands, and called an event while it is on its way or did not load', () => {
  const answers = {
    e9: { state: 'ready', event: { id: 'e9', title: 'Pitch' } },
    e8: { state: 'loading', event: null },
    e7: { state: 'failed', event: null },
    e6: { state: 'missing', event: null }
  };
  const asked = [];
  const withAsk = { ...data, has: () => true, event: id => { asked.push(id); return answers[id] || null; } };
  const at = key => model.crumb('agenda', ['agenda', key], withAsk).current;
  assert.equal(at('e9'), 'Pitch');
  assert.equal(at('e8'), 'Event');
  assert.equal(at('e7'), 'Event');
  assert.equal(at('e6'), 'Not found');
  assert.equal(at('e1'), 'Kickoff');
  assert.deepEqual(asked, ['e9', 'e8', 'e7', 'e6'], 'an event in the weeks loaded is not asked for');
  assert.equal(model.crumb('agenda', ['agenda', 'e5'], data).current, 'Not found', 'with nothing to ask, not found');
});

test('a section belongs to its own page, and a route segment is never read as a name', () => {
  assert.equal(model.crumb('tickets', ['tickets', 'studio'], data).current, 'Not found', 'not "Studio"');
  assert.equal(model.crumb('projects', ['projects', 'invoices'], data).current, 'Not found', 'not "Invoices"');
  assert.equal(model.crumb('company', ['company', 'constructor'], data).current, 'Not found');
  assert.equal(model.crumb('finance', ['finance', 'toString'], data).current, 'Not found');
  assert.equal(model.crumb('overview', ['overview', 'hasOwnProperty'], data).current, 'Not found');
});

/* ── The menu ─────────────────────────────────────────────────────────── */

test('Finance is only in the menu of someone who can read it', () => {
  const navs = [['overview', 'Overview'], ['mail', 'Mail'], ['finance', 'Finance'], ['company', 'Company']];
  assert.deepEqual(model.visibleNavs(navs, false).map(n => n[0]), ['overview', 'mail', 'company']);
  assert.deepEqual(model.visibleNavs(navs, true).map(n => n[0]), ['overview', 'mail', 'finance', 'company']);
  assert.equal(model.canOpen('finance', false), false);
  assert.equal(model.canOpen('finance', true), true);
  assert.equal(model.canOpen('tickets', false), true);
});

test('a badge shows only when there is something to count', () => {
  assert.equal(model.badge(0), '');
  assert.equal(model.badge(null), '');
  assert.equal(model.badge(3), '3');
  assert.equal(model.badge(120), '99+');
});

test('a record in the breadcrumb is found whatever case the address writes its id in', () => {
  const data = {
    invoices: [{ uuid: 'f0000000-0000-4000-8000-00000000abcd', id: 'INV-9' }],
    contacts: [{ id: 'c0000000-0000-4000-8000-00000000abcd', name: 'Ana Lima' }],
    projects: [{ id: 'a0000000-0000-4000-8000-00000000abcd', name: 'Relaunch' }],
    events: [{ id: 'e1000000-0000-4000-8000-00000000abcd', title: 'Kickoff' }]
  };
  assert.equal(model.crumb('finance', ['finance', 'F0000000-0000-4000-8000-00000000ABCD'], data).current, 'INV-9',
    'an invoice opened from a link written in capitals is not "Not found"');
  assert.equal(model.crumb('crm', ['crm', 'C0000000-0000-4000-8000-00000000ABCD'], data).current, 'Ana Lima');
  assert.equal(model.crumb('projects', ['projects', 'A0000000-0000-4000-8000-00000000ABCD'], data).current, 'Relaunch');
  assert.equal(model.crumb('agenda', ['agenda', 'E1000000-0000-4000-8000-00000000ABCD'], data).current, 'Kickoff');
});

test('the CRM\'s lists are its sections, and a company\'s page is under its companies', () => {
  const crm = { labels, contacts: [{ id: 'c0', name: 'Ana Lima' }], companies: [{ id: 'co1', name: 'Northline' }], has: () => true };
  assert.equal(model.crumb('crm', ['crm', 'companies'], crm).current, 'Companies');
  assert.equal(model.crumb('crm', ['crm', 'contacts'], crm).current, 'Contacts');
  const page = model.crumb('crm', ['crm', 'companies', 'CO1'], crm);
  assert.equal(page.current, 'Northline');
  assert.deepEqual({ ...page.parent }, { route: 'crm/companies', label: 'Companies' });
  assert.equal(model.crumb('crm', ['crm', 'companies', 'co9'], crm).current, 'Not found');
  assert.equal(model.crumb('crm', ['crm', 'companies', 'co1'], { ...crm, has: part => part !== 'companies' }).current, 'Company',
    'not missing: companies did not load');
  assert.equal(model.crumb('crm', ['crm', 'c0'], crm).current, 'Ana Lima');
  assert.equal(model.crumb('crm', ['crm', 'contacts', 'c0'], crm).current, 'Not found',
    'the page there is not found, so the crumb does not call it the contacts list');
  assert.equal(model.crumb('crm', ['crm', 'contacts', ''], crm).current, 'Contacts', 'a trailing slash is still the list');
  assert.equal(model.activityItem({ id: 'a1', entityType: 'company', entityId: 'co1', text: 'Stage changed' }, crm).route, 'crm/companies/co1');
  assert.equal(model.activityItem({ id: 'a2', entityType: 'company', entityId: 'co9', text: 'Stage changed' }, crm).route, null);
});
