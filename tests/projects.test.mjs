/* Projects' logic, without a page: what a project is known by, where it sits
   on the board, what its status means to the database, who owns it and which
   company a typed client name is. Loaded into a sandbox the way <script> tags
   run it. Run from the repo root with: node --test

   Arrays and objects made inside the sandbox have the sandbox's prototypes,
   which strict deep-equality rejects — hence the [...spread] before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console });
vm.runInContext(readFileSync(new URL('../dist/projects-model.js', import.meta.url), 'utf8'), context);
const model = vm.runInContext('projectsModel', context);

const P1 = 'a1000000-0000-4000-8000-000000000001';
const P2 = 'a1000000-0000-4000-8000-000000000002';
const COMPANY = 'c1000000-0000-4000-8000-000000000001';
const OWNER = 'e1000000-0000-4000-8000-000000000001';

/* What queries.projects() hands the store. */
const row = (over = {}) => ({
  id: P1, name: 'Northline site', client: 'Northline', initial: 'N', style: 'client',
  progress: 50, due: 'Oct 1', status: 'In progress', description: 'The new site',
  row: { id: P1, company_id: COMPANY, owner_id: OWNER, due_on: '2026-10-01' },
  ...over
});
/* What queries.projectTasks() hands the store. */
const task = (id, projectId, over = {}) => ({
  id, title: `Task ${id}`, done: false, status: 'todo',
  row: { project_id: projectId, due_date: null }, ...over
});

/* ── Identity ────────────────────────────────────────────────────────── */

test('a project is known by its id, wherever it sits in the list', () => {
  const second = row({ id: P2, name: 'Studio app', row: { id: P2, company_id: null, owner_id: null } });
  const inOrder = [row(), second].map(p => model.shapeProject(p, []));
  const reversed = [second, row()].map(p => model.shapeProject(p, []));
  assert.equal(inOrder[0].id, P1);
  assert.equal(inOrder[0].uuid, P1);
  assert.equal(reversed[1].id, P1, 'a reload that reorders the list must not change what a link opens');
  assert.equal(model.projectById(reversed, P1).name, 'Northline site');
});

test('a project is found by its id and by nothing else', () => {
  const list = [model.shapeProject(row(), [])];
  assert.equal(model.projectById(list, P1).id, P1);
  assert.equal(model.projectById(list, '0'), null, 'an old position-based link opens nothing rather than the wrong project');
  assert.equal(model.projectById(list, 0), null);
  assert.equal(model.projectById(list, ''), null);
  assert.equal(model.projectById(null, P1), null);
});

test('its tasks are its own, ticked when done, each with its own due date', () => {
  const tasks = [
    task('t1', P1, { done: true, status: 'done' }),
    task('t2', P2),
    task('t3', P1, { row: { project_id: P1, due_date: '2026-10-03' } })
  ];
  const p = model.shapeProject(row(), tasks);
  assert.deepEqual([...p.tasks], ['Task t1', 'Task t3']);
  assert.deepEqual([...p.taskIds], ['t1', 't3']);
  assert.deepEqual([...p.checked], [0]);
  assert.deepEqual([...p.taskDue], ['', 'Oct 3'], 'a task shows its own date, not the project\'s');
});

test('owner and client company come from the row, by id', () => {
  const p = model.shapeProject(row(), []);
  assert.equal(p.ownerId, OWNER);
  assert.equal(p.companyId, COMPANY);
  const bare = model.shapeProject(row({ row: undefined }), []);
  assert.equal(bare.ownerId, null);
  assert.equal(bare.companyId, null);
});

/* ── Status and the board ────────────────────────────────────────────── */

test('every stage has a column on the board, and a new project is on it', () => {
  const stages = ['Discovery', 'In progress', 'In review', 'On hold', 'Completed', 'Cancelled'];
  const projects = stages.map((status, i) => model.shapeProject(row({ id: `p${i}`, status, row: { id: `p${i}` } }), []));
  const columns = model.boardColumns(projects);
  assert.deepEqual([...columns].map(c => c.status), ['Discovery', 'In progress', 'In review', 'On hold', 'Completed']);
  assert.deepEqual([...columns].map(c => c.projects.length), [1, 1, 1, 1, 1]);
  assert.equal(columns[0].projects[0].status, 'Discovery', 'a project is created in Discovery');
  assert.ok(![...columns].some(c => c.projects.some(p => p.status === 'Cancelled')), 'cancelled work is kept off the board');
});

test('a status label maps back to what the database stores', () => {
  assert.deepEqual([...model.STATUS_LABELS], ['Discovery', 'In progress', 'In review', 'On hold', 'Completed', 'Cancelled']);
  assert.equal(model.statusValue('In progress'), 'in_progress');
  assert.equal(model.statusValue('On hold'), 'on_hold');
  assert.equal(model.statusValue('Discovery'), 'discovery');
  assert.equal(model.statusValue('Cancelled'), 'cancelled');
  assert.equal(model.statusValue('Shipped'), null);
  assert.equal(model.statusValue(''), null);
});

test('active means being worked on: not on hold, completed or cancelled — the Overview tile\'s rule', () => {
  const as = status => model.shapeProject(row({ status }), []);
  assert.equal(model.isActive(as('Discovery')), true);
  assert.equal(model.isActive(as('In progress')), true);
  assert.equal(model.isActive(as('In review')), true);
  assert.equal(model.isActive(as('On hold')), false, 'paused work is not active, as workspace_overview() counts it');
  assert.equal(model.isActive(as('Completed')), false);
  assert.equal(model.isActive(as('Cancelled')), false);
});

test('every project\'s tasks from one list are grouped by project, in order', () => {
  const tasks = [task('t1', P1), task('t2', P2), task('t3', P1), { id: 'loose', row: { project_id: null } }, null];
  const grouped = model.groupTasks(tasks);
  assert.deepEqual([...grouped[P1]].map(t => t.id), ['t1', 't3']);
  assert.deepEqual([...grouped[P2]].map(t => t.id), ['t2']);
  assert.equal(grouped.null, undefined, 'a task without a project belongs to none');
  assert.deepEqual([...model.shapeProject(row(), grouped[P1]).taskIds], ['t1', 't3']);
  assert.deepEqual(Object.keys(model.groupTasks(null)), []);
});

/* ── Connected work ──────────────────────────────────────────────────── */

const ticket = (id, projectId, over = {}) => ({
  id, title: `Ticket ${id}`, status: 'Open', product: '—', row: { id: `u-${id}`, project_id: projectId }, ...over
});

test('a project\'s tickets are the ones filed under it and its client\'s unfiled ones — never matched by name', () => {
  const p = model.shapeProject(row(), []);
  const tickets = [
    ticket(1, P1),
    ticket(2, P2, { row: { id: 'u-2', project_id: P2, company_id: COMPANY } }),
    ticket(3, null, { product: 'Northline site' }),
    ticket(4, P1),
    ticket(5, null, { row: { id: 'u-5', project_id: null, company_id: COMPANY } }),
    ticket(6, null, { row: { id: 'u-6', project_id: null, company_id: 'c-other' } })
  ];
  assert.deepEqual([...model.projectTickets(tickets, p)].map(t => t.id), [1, 4, 5],
    'filed under another of the client\'s projects stays there; a look-alike product name or another client\'s ticket never shows');
  const internal = model.shapeProject(row({ row: { id: P1, company_id: null } }), []);
  assert.deepEqual([...model.projectTickets(tickets, internal)].map(t => t.id), [1, 4], 'an internal project has no client to share tickets with');
  assert.deepEqual([...model.projectTickets(null, p)], []);
  assert.deepEqual([...model.projectTickets(tickets, null)], []);
});

test('a project\'s meetings are its own, soonest first, until they are over', () => {
  const p = model.shapeProject(row(), []);
  const NOW = Date.parse('2026-09-14T12:00:00Z');
  const event = (id, projectId, startsAt, endsAt = null, allDay = false) =>
    ({ id, title: id, row: { project_id: projectId, starts_at: startsAt, ends_at: endsAt, all_day: allDay } });
  const events = [
    event('later', P1, '2026-09-20T09:00:00Z', '2026-09-20T10:00:00Z'),
    event('past', P1, '2026-09-10T09:00:00Z', '2026-09-10T10:00:00Z'),
    event('other', P2, '2026-09-15T09:00:00Z'),
    event('soon', P1, '2026-09-15T09:00:00Z'),
    event('ended this morning', P1, '2026-09-14T09:00:00Z', '2026-09-14T10:00:00Z'),
    event('under way', P1, '2026-09-14T11:30:00Z', '2026-09-14T12:30:00Z'),
    event('all day today', P1, '2026-09-14T00:00:00Z', null, true)
  ];
  assert.deepEqual([...model.upcomingEvents(events, p, NOW)].map(e => e.id), ['all day today', 'under way', 'soon', 'later'],
    'a meeting under way is still on the page; one that has ended is not');
  assert.deepEqual([...model.upcomingEvents(null, p, NOW)], []);
});

test('editing a project sends only what changed, as the columns it lives in', () => {
  const p = model.shapeProject(row(), []);
  const unchanged = model.projectChanges(p, {
    name: ' Northline site ', description: 'The new site', companyId: COMPANY, ownerId: OWNER, dueOn: '2026-10-01'
  });
  assert.equal(unchanged.problem, null);
  assert.deepEqual({ ...unchanged.changes }, {}, 'nothing changed, nothing to send');

  const edit = model.projectChanges(p, { name: 'Northline relaunch', description: '', companyId: '', ownerId: 'e2', dueOn: '' });
  assert.equal(edit.problem, null);
  assert.deepEqual({ ...edit.changes }, {
    name: 'Northline relaunch', description: null, company_id: null, owner_id: 'e2', due_on: null
  });
  assert.deepEqual({ ...model.projectChanges(p, { dueOn: '2026-11-15' }).changes }, { due_on: '2026-11-15' },
    'a field the form did not send is left as it is');
});

test('a project edit that cannot be saved says why', () => {
  const p = model.shapeProject(row(), []);
  assert.match(model.projectChanges(p, { name: '   ' }).problem, /name/);
  assert.match(model.projectChanges(p, { name: 'x'.repeat(201) }).problem, /long/);
  assert.match(model.projectChanges(p, { dueOn: '2026-13-40' }).problem, /date/);
  assert.match(model.projectChanges(p, { dueOn: 'next friday' }).problem, /date/);
  assert.match(model.projectChanges(p, { dueOn: '2026-02-30' }).problem, /date/, 'not quietly saved as March 2');
  assert.deepEqual({ ...model.projectChanges(p, { name: '   ' }).changes }, {});
});

test('a form left as it was changes nothing, however its text was stored', () => {
  const p = model.shapeProject(row({ description: 'Line one\nLine two\n' }), []);
  const same = model.projectChanges(p, { name: 'Northline site', description: 'Line one\r\nLine two' });
  assert.deepEqual({ ...same.changes }, {}, 'a browser may send CRLF, and a trailing newline is not an edit');
  const edited = model.projectChanges(p, { description: 'Line one\r\nLine three' });
  assert.deepEqual({ ...edited.changes }, { description: 'Line one\nLine three' });
});

test('a picker keeps the current choice, even when its list does not have it', () => {
  const people = [{ id: 'e1', name: 'Jamie Doe' }, null, { name: 'no id' }];
  const plain = list => [...list].map(option => [...option]);
  assert.deepEqual(plain(model.choices(people, 'e1', 'Former owner')), [['e1', 'Jamie Doe']]);
  assert.deepEqual(plain(model.choices(people, 'e-gone', 'Former owner')), [['e-gone', 'Former owner'], ['e1', 'Jamie Doe']],
    'an owner who left, or a company list that did not load, is not cleared by saving an untouched form');
  assert.deepEqual(plain(model.choices(people, null, 'x')), [['e1', 'Jamie Doe']]);
  assert.deepEqual(plain(model.choices(null, null)), []);
});

test('a name that is already too long does not block other edits', () => {
  const long = 'x'.repeat(250);
  const p = model.shapeProject(row({ name: long }), []);
  const edit = model.projectChanges(p, { name: long, dueOn: '2026-11-01' });
  assert.equal(edit.problem, null, 'the form always sends the name; unchanged, its length is not this edit\'s problem');
  assert.deepEqual({ ...edit.changes }, { due_on: '2026-11-01' });
  assert.match(model.projectChanges(p, { name: `${long}y` }).problem, /long/, 'a changed name still has to fit');
});

test('the edit form sends the fields projectChanges reads', () => {
  const ui = readFileSync(new URL('../dist/projects-ui.js', import.meta.url), 'utf8');
  for (const field of ['name', 'companyId', 'ownerId', 'dueOn', 'description']) {
    assert.match(ui, new RegExp(`name="${field}"`), `renaming the ${field} field would quietly save nothing`);
  }
});

/* ── Meetings ────────────────────────────────────────────────────────── */

test('a meeting is suggested for the next whole hour, or 10:00 outside the working day', () => {
  const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute);
  const suggested = now => model.suggestedStart(now).getTime();
  assert.equal(suggested(at(14, 13, 8)), at(14, 14).getTime());
  assert.equal(suggested(at(14, 8, 15)), at(14, 9).getTime());
  assert.equal(suggested(at(14, 7)), at(14, 10).getTime(), 'before the working day: 10:00 that day');
  assert.equal(suggested(at(14, 17, 10)), at(15, 10).getTime(), 'after it: 10:00 the next day');
  assert.equal(suggested(at(14, 23, 30)), at(15, 10).getTime());
});

test('a meeting\'s times are read on this clock, and one that cannot happen says why', () => {
  const now = new Date(2026, 8, 14, 13, 8);
  const booked = model.meetingTimes({ day: '2026-09-14', start: '14:00', end: '14:45' }, now);
  assert.equal(booked.problem, null);
  assert.equal(booked.startsAt.getTime(), new Date(2026, 8, 14, 14, 0).getTime());
  assert.equal(booked.endsAt.getTime(), new Date(2026, 8, 14, 14, 45).getTime());
  assert.equal(model.meetingTimes({ day: '2026-09-14', start: '13:00', end: '14:00' }, now).problem, null,
    'a meeting under way can still be put on record');

  const backwards = model.meetingTimes({ day: '2026-09-14', start: '14:00', end: '14:00' }, now);
  assert.match(backwards.problem, /ends after it starts/);
  assert.equal(backwards.field, 'end');

  const over = model.meetingTimes({ day: '2026-09-14', start: '09:00', end: '10:00' }, now);
  assert.match(over.problem, /passed/, 'booked, it would never show among the project\'s meetings');
  assert.equal(over.field, 'start');

  for (const bad of [{ day: '2026-02-30', start: '10:00', end: '11:00' }, { day: '', start: '10:00', end: '11:00' },
                     { day: '2026-09-15', start: '25:00', end: '26:00' }, {}]) {
    assert.match(model.meetingTimes(bad, now).problem, /day and the times/, JSON.stringify(bad));
  }
});

/* ── People and companies ────────────────────────────────────────────── */

test('the owner is the team member with the owner id', () => {
  const team = [{ id: 'e-other', name: 'Jamie Doe', initial: 'JD' }, { id: OWNER, name: 'Cassian Drefke', initial: 'CD' }];
  assert.equal(model.ownerOf(model.shapeProject(row(), []), team).name, 'Cassian Drefke');
  assert.equal(model.ownerOf(model.shapeProject(row({ row: { id: P1, owner_id: 'e-gone' } }), []), team), null);
  assert.equal(model.ownerOf(model.shapeProject(row({ row: { id: P1, owner_id: null } }), []), team), null);
  assert.equal(model.ownerOf(model.shapeProject(row(), []), null), null);
});

test('a project\'s due date is its date, wherever the browser is', () => {
  const p = model.shapeProject(row({ due: 'Sep 30', row: { id: P1, company_id: COMPANY, owner_id: OWNER, due_on: '2026-10-01' } }), []);
  assert.equal(p.due, 'Oct 1', 'read as local midnight, 2026-10-01 used to show as Sep 30 west of Greenwich');
  assert.equal(p.dueOn, '2026-10-01');
  assert.equal(model.shapeProject(row({ due: '', row: { id: P1, due_on: null } }), []).due, '');
  assert.equal(model.shapeProject(row({ due: '', row: { id: P1, due_on: null } }), []).dueOn, null);
});

test('spaces inside a name, and look-alike characters, do not make a second company', () => {
  const companies = [{ id: COMPANY, name: 'Harbor & Co' }, { id: 'c-wide', name: 'ＡＢＣ Studio' }];
  assert.equal(model.findCompany(companies, 'Harbor  &   Co').id, COMPANY);
  assert.equal(model.findCompany(companies, 'Harbor & Co').id, COMPANY, 'a non-breaking space is a space');
  assert.equal(model.findCompany(companies, 'abc studio').id, 'c-wide', 'full-width letters are letters');
});

test('when two companies share a name, none is picked for you', () => {
  const companies = [{ id: 'c1', name: 'Northline' }, { id: 'c2', name: 'northline ' }, { id: 'c3', name: 'Harbor' }];
  assert.deepEqual([...model.matchCompanies(companies, 'NORTHLINE')].map(c => c.id), ['c1', 'c2']);
  assert.equal(model.findCompany(companies, 'Northline'), null, 'ambiguous: the person chooses, not the first in the alphabet');
  assert.equal(model.findCompany(companies, 'Harbor').id, 'c3');
  assert.deepEqual([...model.matchCompanies(companies, '')], []);
});

test('a typed client is an existing company whatever its case or spacing, contacts or not', () => {
  const companies = [{ id: COMPANY, name: 'Northline Studio' }, { id: 'c2', name: 'Harbor & Co' }];
  assert.equal(model.findCompany(companies, '  northline studio ').id, COMPANY);
  assert.equal(model.findCompany(companies, 'HARBOR & CO').id, 'c2');
  assert.equal(model.findCompany(companies, 'Northline'), null, 'a different name is a different company');
  assert.equal(model.findCompany(companies, ''), null);
  assert.equal(model.findCompany(null, 'Northline Studio'), null);
});
