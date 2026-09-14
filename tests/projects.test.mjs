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

test('active means neither completed nor cancelled', () => {
  const as = status => model.shapeProject(row({ status }), []);
  assert.equal(model.isActive(as('Discovery')), true);
  assert.equal(model.isActive(as('On hold')), true);
  assert.equal(model.isActive(as('Completed')), false);
  assert.equal(model.isActive(as('Cancelled')), false);
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

test('a typed client is an existing company whatever its case or spacing, contacts or not', () => {
  const companies = [{ id: COMPANY, name: 'Northline Studio' }, { id: 'c2', name: 'Harbor & Co' }];
  assert.equal(model.findCompany(companies, '  northline studio ').id, COMPANY);
  assert.equal(model.findCompany(companies, 'HARBOR & CO').id, 'c2');
  assert.equal(model.findCompany(companies, 'Northline'), null, 'a different name is a different company');
  assert.equal(model.findCompany(companies, ''), null);
  assert.equal(model.findCompany(null, 'Northline Studio'), null);
});
