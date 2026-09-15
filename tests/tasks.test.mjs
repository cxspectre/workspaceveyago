/* Project tasks and notes, without a page: what a task's checkbox shows and
   what ticking it sets, who may move a task along, edit or delete it, what a
   task form may save and what an edit changes, when a task is due and the
   order a list shows tasks in, and who may add, change or remove a note — each
   as the database decides it. Loaded into a sandbox the way <script> tags run
   it, with the time zone moved the way calendar.test.mjs moves it. Run from
   the repo root with: node --test

   Arrays and objects made inside the sandbox have the sandbox's prototypes,
   which strict deep-equality rejects — hence the [...spread] and {...spread}
   before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/tasks-model.js', import.meta.url), 'utf8');
const context = vm.createContext({ console });
vm.runInContext(source, context);
const model = vm.runInContext('tasksModel', context);

function inZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const ME = 'e1000000-0000-4000-8000-000000000001';
const ANA = 'e1000000-0000-4000-8000-000000000002';
const LEAD = 'e1000000-0000-4000-8000-000000000003';
const MEMBER = 'e1000000-0000-4000-8000-000000000004';
const ELSEWHERE = 'e1000000-0000-4000-8000-000000000005';
const INVITED = 'e1000000-0000-4000-8000-000000000006';
const LEFT = 'e1000000-0000-4000-8000-000000000007';
const P1 = 'a1000000-0000-4000-8000-000000000001';
const P2 = 'a1000000-0000-4000-8000-000000000002';
const T1 = 'b1000000-0000-4000-8000-000000000001';
const TODAY = '2026-09-14';                                   // a Monday

/* The signed-in person, as workspaceSession.employee has their employees row. */
const viewer = (id, over = {}) => ({
  id, full_name: 'Sam Rivera', email: 'sam@veyago.example', role: 'employee', title: null, status: 'active', ...over
});

/* What queries.projectTask() hands the store: the tasks row under `row`. */
function task(over = {}) {
  const row = {
    id: T1, project_id: P1, title: 'Draft the homepage', details: null, status: 'todo', priority: 'normal',
    due_date: null, assignee_id: null, created_at: '2026-09-01T09:00:00Z', ...over
  };
  return { id: row.id, title: row.title, done: row.status === 'done', status: row.status, who: null, assigneeId: row.assignee_id, row };
}

/* The team as queries.team() loads it. It leaves inactive people out; the one
   here proves a row that says so is refused all the same. */
const member = (id, status = 'active') => ({
  id, name: id, initial: 'S', role: 'Designer', focus: '', tag: 'Employee',
  row: { id, full_name: id, role: 'employee', title: 'Designer', status }
});
const TEAM = [member(ME), member(ANA), member(INVITED, 'invited'), member(LEFT, 'inactive')];

/* A project as the store shapes it (projectsModel.shapeProject), and every
   project's team as queries.projectMembers() loads it. */
const project = (over = {}) => ({ id: P1, uuid: P1, name: 'Northline site', ownerId: LEAD, ...over });
const MEMBERS = [
  { project_id: P1, employee_id: MEMBER, created_at: '2026-09-01T09:00:00Z' },
  { project_id: P2, employee_id: ELSEWHERE, created_at: '2026-09-01T09:00:00Z' }
];

/* ── Statuses and priorities ─────────────────────────────────────────── */

test('a task\'s statuses and priorities are the ones the database holds, each with its label', () => {
  assert.deepEqual([...model.STATUSES].map(s => s.value), ['todo', 'in_progress', 'blocked', 'done'], 'tasks.status (0005)');
  assert.deepEqual([...model.STATUSES].map(s => s.label), ['To do', 'In progress', 'Blocked', 'Done']);
  assert.deepEqual([...model.PRIORITIES].map(p => p.value), ['low', 'normal', 'high', 'urgent'], 'tasks.priority (0005)');
  assert.deepEqual([...model.PRIORITIES].map(p => p.label), ['Low', 'Normal', 'High', 'Urgent']);
});

test('a status or priority is read by value or label, and one the column cannot hold reads as its default', () => {
  assert.equal(model.statusOf(task({ status: 'blocked' })), 'blocked');
  assert.equal(model.statusOf({ status: 'In progress' }), 'in_progress', 'a label is the same status');
  assert.equal(model.statusOf(task({ status: 'archived' })), 'todo');
  assert.equal(model.statusOf({ done: true }), 'done', 'the store\'s done flag, when there is no status to read');
  assert.equal(model.statusOf(null), 'todo');
  assert.equal(model.priorityOf(task({ priority: 'urgent' })), 'urgent');
  assert.equal(model.priorityOf({ priority: 'High' }), 'high');
  assert.equal(model.priorityOf(task({ priority: 'critical' })), 'normal');
});

/* ── The checkbox ────────────────────────────────────────────────────── */

test('the box is ticked for a done task and mixed for one in progress or blocked; it only ever sets done or to do', () => {
  const shown = status => {
    const box = model.tick(task({ status }));
    return [box.status, box.label, box.checked, box.mixed, box.next, box.action];
  };
  assert.deepEqual(shown('todo'), ['todo', 'To do', false, false, 'done', 'Mark as done']);
  assert.deepEqual(shown('in_progress'), ['in_progress', 'In progress', false, true, 'done', 'Mark as done'],
    'an empty box made a task under way look untouched');
  assert.deepEqual(shown('blocked'), ['blocked', 'Blocked', false, true, 'done', 'Mark as done']);
  assert.deepEqual(shown('done'), ['done', 'Done', true, false, 'todo', 'Reopen'],
    'the database keeps no record of what a task was before it was done (0005): it reopens as to do, the default');
  assert.deepEqual(shown('archived'), ['todo', 'To do', false, false, 'done', 'Mark as done'],
    'a status the column cannot hold reads as its default');
  assert.equal(model.tick({ done: true }).checked, true, 'the store\'s done flag, when there is no status to read');
  assert.deepEqual({ ...model.taskChanges(task({ status: 'done' }), { status: 'blocked' }) }, { status: 'blocked', completed_at: null },
    'in progress and blocked are the status choice\'s to set, never the box\'s');
});

test('a status picked from the list is sent with the time the task was done, as setTaskDone() and the admin send it', () => {
  const now = new Date('2026-09-14T10:30:00Z');
  assert.deepEqual({ ...model.taskChanges(task({ status: 'in_progress' }), { status: 'done' }, now) },
    { status: 'done', completed_at: '2026-09-14T10:30:00.000Z' }, 'no trigger stamps completed_at (0050)');
  assert.deepEqual({ ...model.taskChanges(task({ status: 'done' }), { status: 'To do' }, now) },
    { status: 'todo', completed_at: null }, 'a task that is no longer done has no time it was done');
  assert.deepEqual({ ...model.taskChanges(task({ status: 'todo' }), { status: 'blocked' }, now) },
    { status: 'blocked', completed_at: null }, 'sent with every status, as the admin sends it');
  assert.deepEqual({ ...model.taskChanges(task({ status: 'done' }), { status: 'done', title: 'Renamed' }, now) },
    { title: 'Renamed' }, 'a status that did not change leaves the time alone');
  assert.deepEqual({ ...model.taskChanges(task({ status: 'todo' }), { status: 'Done' }, now) },
    { status: 'done', completed_at: '2026-09-14T10:30:00.000Z' }, 'picked by its label');
});

test('done is never sent without the time it was done: with no now to stamp, the status stays as it was', () => {
  const todo = task({ status: 'todo' });
  assert.deepEqual({ ...model.taskChanges(todo, { status: 'done' }) }, {},
    'no trigger stamps completed_at (0050), and the admin counts "done this week" by it (admin/js/tasks.js): saved without it, a done task drops out');
  assert.deepEqual({ ...model.taskChanges(todo, { status: 'done', title: 'Renamed' }) }, { title: 'Renamed' }, 'the rest of the edit still goes');
  for (const notNow of [new Date('nonsense'), '2026-09-14T10:30:00Z', Date.parse('2026-09-14T10:30:00Z'), null]) {
    assert.deepEqual({ ...model.taskChanges(todo, { status: 'done' }, notNow) }, {}, `now is a Date, not ${String(notNow)}`);
  }
  assert.deepEqual({ ...model.taskChanges(task({ status: 'done' }), { status: 'in_progress' }) }, { status: 'in_progress', completed_at: null },
    'a task that is no longer done needs no time: it has none');
});

/* ── Who may do what ─────────────────────────────────────────────────── */

test('a task\'s status is moved by a manager, its assignee or its project\'s team, and by nobody else', () => {
  const assigned = task({ assignee_id: ANA });
  const can = (who, over = {}) => model.canChangeStatus(who, 'task' in over ? over.task : assigned,
    'project' in over ? over.project : project(), over.team || MEMBERS);
  assert.equal(can(viewer(ME, { role: 'owner' })), true, 'owners');
  assert.equal(can(viewer(ME, { role: 'admin' })), true, 'admins');
  assert.equal(can({ manager: true }), false,
    'someone with no employees row is no manager: is_manager() is employee_role() alone (0007, 0013, 0040), with no allowlist');
  assert.equal(can({ role: 'owner' }), false, 'nor is a role with no employee id');
  assert.equal(can(viewer(ANA)), true, 'the assignee');
  assert.equal(can(viewer(MEMBER)), true, 'a member of the task\'s project');
  assert.equal(can(viewer(LEAD)), true, 'the project\'s owner, who runs its team (0039)');
  assert.equal(can(viewer(ME)), false, 'staff who are none of these');
  assert.equal(can(viewer(ME, { role: 'assistant' })), false, 'an assistant is not a manager');
  assert.equal(can(viewer(ELSEWHERE)), false, 'a member of another project');
  assert.equal(can(viewer(ANA, { status: 'inactive' })), false, 'an inactive assignee has no employee id (0006)');
  assert.equal(can(viewer(ME, { role: 'owner', status: 'inactive' })), false, 'nor an inactive owner a role (0005)');
  assert.equal(can({ id: ME, role: 'owner', manager: false }), true, 'the row decides, as employee_role() does: a manager flag beside it is not read');
  assert.equal(can({ id: ME, role: 'employee', manager: true }), false);
  assert.equal(can(null), false);
  assert.equal(can(viewer(ANA), { task: null }), false, 'no task, nothing to move');
});

test('a project\'s team counts for its own tasks only, as member rows or as projectsModel.projectTeam() lists it', () => {
  const assigned = task({ assignee_id: ANA });
  const unfiled = task({ assignee_id: ANA, project_id: null });
  assert.equal(model.canChangeStatus(viewer(MEMBER), unfiled, project(), MEMBERS), false, 'a task on no project has no team');
  assert.equal(model.canChangeStatus(viewer(LEAD), unfiled, project(), MEMBERS), false);
  assert.equal(model.canChangeStatus(viewer(MEMBER), assigned, null, MEMBERS), true, 'a member row names its project');
  assert.equal(model.canChangeStatus(viewer(LEAD), assigned, project({ id: P2, uuid: P2 }), []), false,
    'the owner of a project that is not the task\'s');
  const entries = [{ employeeId: LEAD, owner: true, name: 'Lee', initial: 'L' }, { employeeId: MEMBER, owner: false, name: 'Mo', initial: 'M' }];
  assert.equal(model.canChangeStatus(viewer(MEMBER), assigned, project(), entries), true);
  assert.equal(model.canChangeStatus(viewer(MEMBER), assigned, project({ id: P2, uuid: P2, ownerId: null }), entries), false,
    'a team listed for another project');
  assert.equal(model.canChangeStatus(viewer(MEMBER), assigned, project(), null), false, 'no team loaded, no member');
  assert.equal(model.canChangeStatus(viewer(LEAD), task({ project_id: P1 }), { id: P1, row: { owner_id: LEAD } }, []), true,
    'a project row\'s owner_id will do');
});

test('only owners and admins edit or delete a task; staff change its status alone', () => {
  const assigned = task({ assignee_id: ANA });
  const members = [{ project_id: P1, employee_id: ME }];
  for (const who of [viewer(ME, { role: 'owner' }), viewer(ME, { role: 'admin' }), { id: ME, role: 'admin', manager: false }]) {
    assert.equal(model.canEdit(who, assigned, project(), members), true, JSON.stringify(who));
    assert.equal(model.canDelete(who, assigned, project(), members), true, JSON.stringify(who));
  }
  const staff = [viewer(ANA), viewer(ME), viewer(LEAD), viewer(ME, { role: 'assistant' }),
    viewer(ANA, { role: 'owner', status: 'inactive' }), { manager: true }, { role: 'admin' }, null];
  for (const who of staff) {
    assert.equal(model.canEdit(who, assigned, project({ ownerId: LEAD }), members), false, JSON.stringify(who));
    assert.equal(model.canDelete(who, assigned, project({ ownerId: LEAD }), members), false, JSON.stringify(who));
  }
  assert.equal(model.canEdit(viewer(ME, { role: 'owner' }), null), false, 'there is no task to edit');
  assert.equal(model.canDelete(viewer(ME, { role: 'owner' }), null), false);
});

/* ── The task form ───────────────────────────────────────────────────── */

test('a new task needs a title no longer than the limit, and every field that cannot be saved is named', () => {
  const ctx = { team: TEAM };
  const fine = model.taskForm({ title: '  Draft the homepage  ' }, ctx);
  assert.equal(fine.ok, true);
  assert.deepEqual({ ...fine.values }, { title: 'Draft the homepage' }, 'only what the form sent: the database defaults the rest');
  assert.deepEqual({ ...fine.errors }, {});
  assert.equal(fine.problem, null);
  assert.equal(fine.field, null);

  assert.deepEqual({ ...model.taskForm({}, ctx).errors }, { title: 'A task needs a title.' });
  assert.equal(model.taskForm({ title: ' \r\n ' }, ctx).field, 'title');
  assert.equal(model.taskForm({ title: 'x'.repeat(model.TITLE_LIMIT) }, ctx).ok, true);
  assert.equal(model.taskForm({ title: 'x'.repeat(model.TITLE_LIMIT + 1) }, ctx).errors.title,
    `A task title is at most ${model.TITLE_LIMIT} characters long.`);

  const bad = model.taskForm({
    title: '', details: 'x'.repeat(model.DETAILS_LIMIT + 1), assigneeId: LEFT,
    dueDate: '2026-02-30', priority: 'critical', status: 'waiting', projectId: P2
  }, { team: TEAM, projects: [project()] });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors), ['title', 'details', 'assigneeId', 'dueDate', 'priority', 'status', 'projectId']);
  assert.equal(bad.errors.details, `A task's details are at most ${model.DETAILS_LIMIT} characters long.`);
  assert.equal(bad.problem, 'A task needs a title.');
  assert.equal(bad.field, 'title');
  assert.deepEqual({ ...bad.values }, {}, 'nothing to save until all of it can be');
});

test('a task is given to someone on the team, due on a real date, with a priority and status from the lists', () => {
  const form = values => model.taskForm({ title: 'Draft', ...values }, { team: TEAM });
  assert.equal(form({ assigneeId: ANA }).values.assigneeId, ANA);
  assert.equal(form({ assigneeId: INVITED }).values.assigneeId, INVITED,
    'an invited member is not inactive: active_employee_id() counts them (0006)');
  assert.equal(form({ assigneeId: LEFT }).errors.assigneeId, 'Pick someone on the team, or nobody.', 'someone inactive');
  assert.equal(form({ assigneeId: 'e-stranger' }).field, 'assigneeId');
  assert.equal(model.taskForm({ title: 'Draft', assigneeId: ANA }, {}).field, 'assigneeId',
    'with no team loaded there is no telling who is on it');
  assert.equal(form({ assigneeId: '  ' }).values.assigneeId, null, 'blank is nobody');

  assert.equal(form({ dueDate: ' 2026-09-30 ' }).values.dueDate, '2026-09-30');
  assert.equal(form({ dueDate: '2028-02-29' }).ok, true, 'a leap day');
  for (const notADate of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '30.09.2026', '2026-9-30', '0000-01-01', 'tomorrow']) {
    assert.equal(form({ dueDate: notADate }).errors.dueDate, 'That due date is not a date.', notADate);
  }
  assert.equal(form({ dueDate: '' }).values.dueDate, null, 'blank is no due date');

  assert.equal(form({ priority: 'High' }).values.priority, 'high');
  assert.equal(form({ priority: 'critical' }).errors.priority, 'Pick a priority from the list.');
  assert.equal('priority' in form({ priority: '' }).values, false, 'none picked: the column default, normal, applies');
  assert.equal(form({ status: 'blocked' }).values.status, 'blocked');
  assert.equal(form({ status: 'waiting' }).errors.status, 'Pick a status from the list.');

  assert.equal(form({ details: '  Line one\r\nline two  ' }).values.details, 'Line one\nline two');
  assert.equal(form({ details: '   ' }).values.details, null);
  assert.equal(form({ details: 'x'.repeat(model.DETAILS_LIMIT) }).ok, true);
  assert.equal(form({ title: `Draft${String.fromCharCode(0)}` }).values.title, 'Draft', 'Postgres text cannot hold NUL');

  const withProjects = { team: TEAM, projects: [project()] };
  assert.equal(model.taskForm({ title: 'Draft', projectId: P1 }, withProjects).values.projectId, P1);
  assert.equal(model.taskForm({ title: 'Draft', projectId: P2 }, withProjects).errors.projectId, 'Pick a project from the list, or none.');
  assert.equal(model.taskForm({ title: 'Draft', projectId: '' }, withProjects).values.projectId, null);
});

test('on an edit, what the task already has is not judged again', () => {
  const long = 'x'.repeat(model.TITLE_LIMIT + 20);
  const longDetails = 'y'.repeat(model.DETAILS_LIMIT + 1);
  const kept = task({ title: long, details: longDetails, assignee_id: LEFT });
  const ctx = { team: TEAM, task: kept };
  assert.equal(model.taskForm({ title: long, details: longDetails, assigneeId: LEFT, dueDate: '2026-10-01' }, ctx).ok, true,
    'a title already too long, or an assignee who has since left, must not block moving the due date');
  assert.deepEqual({ ...model.taskForm({ dueDate: '2026-10-01' }, ctx).values }, { dueDate: '2026-10-01' },
    'an edit that sends no title needs none');
  assert.equal(model.taskForm({ title: `${long}z` }, ctx).field, 'title', 'a changed title is judged');
  assert.equal(model.taskForm({ title: '' }, ctx).errors.title, 'A task needs a title.', 'and cannot be cleared');
  assert.equal(model.taskForm({ assigneeId: LEFT }, { team: TEAM, task: task() }).field, 'assigneeId',
    'handing a task to someone who has left is refused');
  assert.equal(model.taskForm({ priority: 'critical' }, ctx).field, 'priority', 'a picked priority is always this edit\'s');
});

test('an edit changes only the columns that differ from the task as it was loaded', () => {
  const loaded = task({ details: 'Hero first', assignee_id: ANA, due_date: '2026-09-30', priority: 'normal', status: 'in_progress' });
  const untouched = {
    title: ' Draft the homepage ', details: 'Hero first\r\n', assigneeId: ANA, dueDate: '2026-09-30',
    priority: 'Normal', status: 'In progress', projectId: P1
  };
  assert.deepEqual({ ...model.taskChanges(loaded, untouched) }, {}, 'a form nobody touched changes nothing');
  assert.deepEqual({ ...model.taskChanges(loaded, { ...untouched, title: 'Draft the new homepage', dueDate: '', assigneeId: '' }) },
    { title: 'Draft the new homepage', assignee_id: null, due_date: null });
  assert.deepEqual({ ...model.taskChanges(loaded, { details: '', priority: 'urgent', status: 'blocked', projectId: P2 }) },
    { details: null, priority: 'urgent', status: 'blocked', completed_at: null, project_id: P2 });
  assert.deepEqual({ ...model.taskChanges(loaded, { title: ' ', priority: 'critical', status: 'waiting', dueDate: '2026-02-30' }) }, {},
    'what taskForm() refuses is left out rather than written into the row');
  assert.deepEqual({ ...model.taskChanges(loaded, { created_by: ME, completedAt: 'now', title: undefined }) }, {}, 'the form\'s own fields only');
  assert.deepEqual({ ...model.taskChanges(loaded.row, { title: 'Renamed' }) }, { title: 'Renamed' }, 'the row itself will do');
  const edit = model.taskForm({ title: 'Renamed', priority: 'High', dueDate: '2026-09-30' }, { team: TEAM, task: loaded });
  assert.deepEqual({ ...model.taskChanges(loaded, edit.values) }, { title: 'Renamed', priority: 'high' });
});

/* ── When a task is due ──────────────────────────────────────────────── */

test('a due date reads as overdue, today, tomorrow, a weekday this week, or a date — with the year only when it is not this year', () => {
  const due = (dueDate, over = {}) => {
    const shown = model.dueLabel(task({ due_date: dueDate, ...over }), TODAY);
    return [shown.key, shown.label, shown.overdue];
  };
  assert.deepEqual(due(null), ['none', '', false]);
  assert.deepEqual(due('2026-09-10'), ['overdue', 'Overdue · Sep 10', true]);
  assert.deepEqual(due('2026-09-13'), ['overdue', 'Overdue · Sep 13', true]);
  assert.deepEqual(due('2026-09-14'), ['today', 'Due today', false], 'due today is not late yet');
  assert.deepEqual(due('2026-09-15'), ['tomorrow', 'Due tomorrow', false]);
  assert.deepEqual(due('2026-09-16'), ['weekday', 'Due Wednesday', false]);
  assert.deepEqual(due('2026-09-20'), ['weekday', 'Due Sunday', false]);
  assert.deepEqual(due('2026-09-21'), ['date', 'Due Sep 21', false], 'a week on, a weekday would name today');
  assert.deepEqual(due('2027-01-05'), ['date', 'Due Jan 5, 2027', false]);
  assert.deepEqual(due('2025-12-30'), ['overdue', 'Overdue · Dec 30, 2025', true]);
  assert.deepEqual(due('2026-09-10', { status: 'done' }), ['date', 'Due Sep 10', false], 'a done task is never overdue');
  assert.deepEqual(due('2026-02-30'), ['none', '', false], 'what is not a date is no due date');

  const shown = model.dueLabel(task({ due_date: '2027-01-05' }), TODAY);
  assert.deepEqual([shown.date, shown.dueOn], ['Jan 5, 2027', '2027-01-05'], 'the date alone, for a column of its own');
  assert.equal(model.dueLabel(task({ due_date: '2026-09-15' }), new Date(2026, 8, 14, 12)).key, 'tomorrow', 'today as a Date');
  const noToday = model.dueLabel(task({ due_date: '2026-09-15' }), 'soon');
  assert.deepEqual([noToday.key, noToday.label, noToday.overdue], ['date', 'Due Sep 15, 2026', false],
    'with no today to count from, the date — and its year, since this year is not known either');
  assert.equal(model.dueLabel(null, TODAY).key, 'none');
});

test('today is the day it is on this clock, and a due date never moves with the time zone', () => {
  for (const zone of ['Pacific/Pago_Pago', 'America/Los_Angeles', 'UTC', 'Europe/Berlin', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
    inZone(zone, () => {
      for (const now of [new Date(2026, 8, 14, 0, 30), new Date(2026, 8, 14, 23, 30)]) {
        const keys = ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']
          .map(dueDate => model.dueLabel(task({ due_date: dueDate }), now).key);
        assert.deepEqual(keys, ['overdue', 'today', 'tomorrow', 'weekday'],
          `${zone} at ${now.getHours()}:30 on Monday — read in UTC, today is another day here`);
        assert.equal(model.dueLabel(task({ due_date: '2026-09-16' }), now).label, 'Due Wednesday');
      }
    });
  }
});

test('days are counted whole across a clock change', () => {
  inZone('Europe/Berlin', () => {                             // the clocks go back on Sunday October 25
    const now = new Date(2026, 9, 24, 23, 30);
    const read = dueDate => model.dueLabel(task({ due_date: dueDate }), now).label;
    assert.deepEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-30', '2026-10-31'].map(read),
      ['Due today', 'Due tomorrow', 'Due Monday', 'Due Friday', 'Due Oct 31']);
  });
  inZone('America/Santiago', () => {                          // Sunday September 6 begins at 01:00
    const now = new Date(2026, 8, 5, 23, 30);
    const read = dueDate => model.dueLabel(task({ due_date: dueDate }), now).label;
    assert.deepEqual(['2026-09-04', '2026-09-06', '2026-09-07', '2026-09-12'].map(read),
      ['Overdue · Sep 4', 'Due tomorrow', 'Due Monday', 'Due Sep 12']);
  });
});

/* ── The order of a list ─────────────────────────────────────────────── */

test('a list shows open tasks before done ones: overdue first, then by due date, priority and when each was made', () => {
  const make = (id, over) => task({ id, title: id, ...over });
  const list = [
    make('done early', { status: 'done', due_date: '2026-09-01', created_at: '2026-08-01T09:00:00Z' }),
    make('undated urgent', { priority: 'urgent', created_at: '2026-09-02T09:00:00Z' }),
    make('next week, low', { due_date: '2026-09-21', priority: 'low', created_at: '2026-09-01T09:00:00Z' }),
    make('overdue', { due_date: '2026-09-10', status: 'blocked', created_at: '2026-09-05T09:00:00Z' }),
    make('today, newer', { due_date: '2026-09-14', created_at: '2026-09-03T09:00:00Z' }),
    make('today, older', { due_date: '2026-09-14', created_at: '2026-09-01T09:00:00Z' }),
    make('today, high', { due_date: '2026-09-14', priority: 'high', created_at: '2026-09-04T09:00:00Z' }),
    make('undated', { created_at: '2026-09-01T09:00:00Z' }),
    make('done late', { status: 'done', due_date: '2026-09-30', created_at: '2026-08-01T09:00:00Z' })
  ];
  const sorted = model.sortTasks(list, TODAY);
  assert.deepEqual([...sorted].map(t => t.id), [
    'overdue', 'today, high', 'today, older', 'today, newer', 'next week, low', 'undated urgent', 'undated', 'done early', 'done late'
  ]);
  assert.equal(list[0].id, 'done early', 'the list it was given is left as it was');
  assert.equal(sorted[0], list[3], 'the tasks themselves, not copies');
  assert.ok(Object.isFrozen(sorted));
});

test('tasks alike keep the order they came in, which is queries.js\'s by created_at', () => {
  const a = task({ id: 'a', created_at: null });
  const b = task({ id: 'b', created_at: null });
  assert.deepEqual([...model.sortTasks([a, b], TODAY)].map(t => t.id), ['a', 'b']);
  assert.deepEqual([...model.sortTasks([b, a], TODAY)].map(t => t.id), ['b', 'a']);
  assert.deepEqual([...model.sortTasks([null, a, 'garbage'], TODAY)].map(t => t.id), ['a']);
  assert.deepEqual([...model.sortTasks(null, TODAY)], []);
  const overdue = task({ id: 'overdue', due_date: '2026-09-01' });
  assert.deepEqual([...model.sortTasks([task({ id: 'soon', due_date: '2026-09-15' }), overdue], 'not a day')].map(t => t.id),
    ['overdue', 'soon'], 'with no today, still by due date');
});

/* ── Notes ───────────────────────────────────────────────────────────── */

test('a note is changed by its author alone, and removed by its author or an owner or admin (0032)', () => {
  const note = { id: 'n1', entityType: 'project', entityId: P1, body: 'Client wants blue', who: 'Ana', row: { id: 'n1', author_id: ANA } };
  assert.equal(model.canEditNote(viewer(ANA), note), true);
  assert.equal(model.canDeleteNote(viewer(ANA), note), true);
  assert.equal(model.canEditNote(viewer(ME, { role: 'owner' }), note), false, 'nobody edits someone else\'s note, an owner neither');
  assert.equal(model.canDeleteNote(viewer(ME, { role: 'owner' }), note), true);
  assert.equal(model.canDeleteNote(viewer(ME, { role: 'admin' }), note), true);
  assert.equal(model.canDeleteNote({ manager: true }, note), false, 'someone with no employees row manages nothing (0040)');
  assert.equal(model.canDeleteNote({ role: 'admin' }, note), false);
  assert.equal(model.canEditNote(viewer(ME), note), false);
  assert.equal(model.canDeleteNote(viewer(ME), note), false);
  assert.equal(model.canEditNote(viewer(ANA, { status: 'inactive' }), note), false, 'an inactive author has no employee id (0006)');
  assert.equal(model.canDeleteNote(viewer(ANA, { status: 'inactive' }), note), false);

  const orphan = { id: 'n2', row: { id: 'n2', author_id: null } };   // its author's row is gone: on delete set null
  assert.equal(model.canEditNote({ manager: false }, orphan), false, 'no author is nobody\'s note');
  assert.equal(model.canEditNote(viewer(ME, { role: 'owner' }), orphan), false);
  assert.equal(model.canDeleteNote(viewer(ME, { role: 'admin' }), orphan), true);
  assert.equal(model.canDeleteNote(viewer(ME), orphan), false);
  assert.equal(model.canEditNote(viewer(ANA), { authorId: ANA }), true, 'the author as a shaped note may carry it');
  assert.equal(model.canEditNote(viewer(ANA), null), false);
  assert.equal(model.canDeleteNote(viewer(ME, { role: 'owner' }), null), false);
});

test('a note is added by someone on the team, as themselves (0032)', () => {
  assert.equal(model.canAddNote(viewer(ME)), true);
  assert.equal(model.canAddNote(viewer(ME, { role: 'owner' })), true);
  assert.equal(model.canAddNote({ manager: true }), false, 'someone with no employees row is not staff, and cannot be a note\'s author');
  assert.equal(model.canAddNote(viewer(ME, { status: 'inactive' })), false);
  assert.equal(model.canAddNote(null), false);
});

test('a note needs something written, on one of the six kinds of record, by its id (0032)', () => {
  const fine = model.noteForm({ body: '  Client wants blue\r\nand green  ', entityType: 'project', entityId: P1 });
  assert.equal(fine.ok, true);
  assert.deepEqual({ ...fine.values }, { body: 'Client wants blue\nand green', entityType: 'project', entityId: P1 });
  assert.deepEqual([...model.NOTE_TARGETS], ['ticket', 'project', 'contact', 'company', 'event', 'task'], 'workspace_notes.entity_type');
  for (const kind of model.NOTE_TARGETS) {
    assert.equal(model.noteForm({ body: 'x', entityType: kind, entityId: P1 }).ok, true, kind);
  }
  assert.equal(model.noteForm({ body: ' \n\t ', entityType: 'project', entityId: P1 }).errors.body, 'Write something first.');
  assert.equal(model.noteForm({ body: 'x', entityType: 'invoice', entityId: P1 }).errors.entityType,
    'A note goes on a ticket, project, contact, company, event or task.');
  assert.equal(model.noteForm({ body: 'x', entityType: 'Project', entityId: P1 }).field, 'entityType', 'the check is exact');
  assert.equal(model.noteForm({ body: 'x', entityType: 'project', entityId: '' }).errors.entityId, 'That record has no id yet.');
  assert.equal(model.noteForm({ body: 'x', entityType: 'project', entityId: '12' }).field, 'entityId', 'entity_id is a uuid');
  const edit = model.noteForm({ body: ' Edited ', entityType: 'invoice', entityId: '12' }, { edit: true });
  assert.deepEqual([edit.ok, { ...edit.values }], [true, { body: 'Edited' }], 'an edit checks and sends the body alone');
  assert.deepEqual({ ...model.noteForm({ body: ' ' }, { edit: true }).errors }, { body: 'Write something first.' });
  const untargeted = model.noteForm({ body: 'x' });
  assert.deepEqual([untargeted.ok, { ...untargeted.values }, { ...untargeted.errors }], [false, {}, {
    entityType: 'A note goes on a ticket, project, contact, company, event or task.', entityId: 'That record has no id yet.'
  }], 'a new note on no record would be refused: workspace_notes.entity_type and entity_id are not null (0032)');
  assert.equal(model.noteForm({ body: 'x', entityType: undefined, entityId: undefined }).field, 'entityType');
  assert.equal(model.noteForm({ body: 'x', entityType: 'project' }, { edit: false }).field, 'entityId', 'anything but an edit is a new note');
  assert.equal(model.noteForm({}).field, 'body');
  assert.equal(model.noteForm(null).field, 'body');
  const refused = model.noteForm({ body: '', entityType: 'x', entityId: 'y' });
  assert.deepEqual(Object.keys(refused.errors), ['body', 'entityType', 'entityId']);
  assert.deepEqual({ ...refused.values }, {});
  assert.equal(refused.problem, 'Write something first.');
});

/* ── The model itself ────────────────────────────────────────────────── */

test('what the model hands back cannot be changed by a view', () => {
  const due = task({ due_date: TODAY });
  const form = model.taskForm({ title: 'x' }, { team: TEAM });
  const refused = model.taskForm({}, { team: TEAM });
  const note = model.noteForm({ body: 'x', entityType: 'task', entityId: T1 });
  const edited = model.noteForm({ body: 'x' }, { edit: true });
  for (const value of [model, model.STATUSES, model.STATUSES[0], model.PRIORITIES, model.PRIORITIES[0], model.NOTE_TARGETS,
    model.tick(due), form, form.values, form.errors, refused, refused.values, refused.errors,
    model.taskChanges(due, { title: 'y' }), model.dueLabel(due, TODAY), model.sortTasks([due], TODAY), note, note.values, note.errors,
    edited, edited.values]) {
    assert.ok(Object.isFrozen(value));
  }
});

test('the model is one global made by an IIFE, with no page and no network in it', () => {
  const topLevel = source.split('\n').filter(line => /^(const|let|var|function|class)\b/.test(line));
  assert.deepEqual(topLevel, ['const tasksModel = (function () {']);
  assert.doesNotMatch(source, /\b(window|document|fetch|localStorage|XMLHttpRequest)\b/);
});
