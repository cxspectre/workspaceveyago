/* The small pure helpers behind the Projects list and board — dueWithYear,
   isOverdue, taskProgress and sortProjects, in workspace.js — taken from the
   file by line, the way tests/wiring.test.mjs already takes app.js's, and run
   beside stand-ins for the few globals they read (CAL, esc, projectsModel).
   projectsView() and projectTile() themselves weave in dozens of page
   globals (icon, titlebar, statStrip, projectsUi, projectPanels, tasksUi,
   the live arrays…) that only a real page — or a browser — can stand in
   for; this file is the part of that page worth checking by hand: given a
   real project shape, do the date, overdue and progress rules read it
   right. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const WORKSPACE = readFileSync(new URL('../dist/workspace.js', import.meta.url), 'utf8').split('\n');
function take(prefix) {
  const found = WORKSPACE.filter(line => line.startsWith(prefix));
  assert.equal(found.length, 1, `workspace.js has one line starting ${JSON.stringify(prefix)}`);
  return found[0];
}

const STATUS_LABELS = ['Discovery', 'In progress', 'In review', 'On hold', 'Completed', 'Cancelled'];

/* today: the clock CAL.dayKey and `new Date()` read inside dueWithYear /
   isOverdue answer to. Real Date, not a stand-in — only its year and the
   day-key string matter here, and every case picks dates far enough from
   the actual today that a slow CI run cannot flip the answer. */
function load({ projectSort = 'name' } = {}) {
  const context = vm.createContext({
    projectSort,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    CAL: { dayKey: d => d.toISOString().slice(0, 10) },
    projectsModel: { STATUS_LABELS }
  });
  vm.runInContext(take('function checkedTasks(p){'), context);
  vm.runInContext(take('const MONTHS_SHORT = ['), context);
  vm.runInContext(take('function dueWithYear(p){'), context);
  vm.runInContext(take('function startsWithYear(p){'), context);
  vm.runInContext(take('function isOverdue(p){'), context);
  vm.runInContext(take('function taskProgress(p){'), context);
  vm.runInContext(take('const projectSelectOptions='), context);
  vm.runInContext(take('function sortProjects(list){'), context);
  return context;
}

const thisYear = new Date().getFullYear();
const project = (over = {}) => ({ tasks: [], checked: [], name: 'Northline site', status: 'In progress', ...over });

test('a due date this year is read as month and day only; another year says which one', () => {
  const c = load();
  assert.equal(vm.runInContext(`dueWithYear(${JSON.stringify(project({ dueOn: `${thisYear}-10-03`, due: 'Oct 3' }))})`, c), 'Oct 3');
  assert.equal(vm.runInContext(`dueWithYear(${JSON.stringify(project({ dueOn: `${thisYear + 1}-01-05`, due: 'Jan 5' }))})`, c), `Jan 5, ${thisYear + 1}`);
  assert.equal(vm.runInContext(`dueWithYear(${JSON.stringify(project({ dueOn: `${thisYear - 3}-12-31`, due: 'Dec 31' }))})`, c), `Dec 31, ${thisYear - 3}`);
});

test('a due date is read in UTC, so a late-evening UTC date does not read as the next day west of Greenwich', () => {
  const c = load();
  /* If this read local midnight instead of UTC midnight, an America/... host
     machine would show Sep 30, not Oct 1 — the same bug 0022's shortDue was
     written to avoid for exactly this column. */
  assert.equal(vm.runInContext(`dueWithYear(${JSON.stringify(project({ dueOn: `${thisYear}-10-01`, due: 'Oct 1' }))})`, c), 'Oct 1');
});

test('with no due-date column at all, the pre-formatted label is kept rather than showing nothing', () => {
  const c = load();
  assert.equal(vm.runInContext(`dueWithYear(${JSON.stringify(project({ dueOn: null, due: 'Some label' }))})`, c), 'Some label');
  assert.equal(vm.runInContext(`dueWithYear(${JSON.stringify(project({ dueOn: 'not-a-date', due: 'Fallback' }))})`, c), 'Fallback');
});

test('a start date follows the exact same year rule as a due date', () => {
  const c = load();
  assert.equal(vm.runInContext(`startsWithYear(${JSON.stringify(project({ startsOn: `${thisYear}-06-01`, starts: 'Jun 1' }))})`, c), 'Jun 1');
  assert.equal(vm.runInContext(`startsWithYear(${JSON.stringify(project({ startsOn: `${thisYear - 1}-06-01`, starts: 'Jun 1' }))})`, c), `Jun 1, ${thisYear - 1}`);
});

test('a project past its due date is overdue only while it is not finished', () => {
  const c = load();
  const past = `${thisYear - 1}-01-01`;
  assert.equal(vm.runInContext(`isOverdue(${JSON.stringify(project({ dueOn: past, status: 'In progress' }))})`, c), true);
  assert.equal(vm.runInContext(`isOverdue(${JSON.stringify(project({ dueOn: past, status: 'Completed' }))})`, c), false, 'finished work is not overdue, whatever its due date says');
  assert.equal(vm.runInContext(`isOverdue(${JSON.stringify(project({ dueOn: past, status: 'On hold' }))})`, c), true, 'paused is not finished');
  const future = `${thisYear + 5}-01-01`;
  assert.equal(vm.runInContext(`isOverdue(${JSON.stringify(project({ dueOn: future, status: 'In progress' }))})`, c), false);
  assert.equal(vm.runInContext(`isOverdue(${JSON.stringify(project({ dueOn: null, status: 'In progress' }))})`, c), false, 'no due date is never overdue');
});

test('a project with no tasks reads "No tasks yet", never "0 of 0 tasks complete" or a 0% bar caption', () => {
  const c = load();
  assert.equal(vm.runInContext(`taskProgress(${JSON.stringify(project({ tasks: [] }))})`, c), '<span>No tasks yet</span>');
  assert.equal(vm.runInContext(`taskProgress(${JSON.stringify(project({ tasks: ['a', 'b'], checked: [0] }))})`, c),
    '<span>1 of 2 tasks complete</span><span>50%</span>');
});

/* sortProjects runs inside the sandbox and hands back an array made there,
   which strict deep-equality treats as a different Array from one of this
   file's own literals even when every element matches (the same reason
   actions.test.mjs and others {...spread} before comparing) — [...spread]
   in the host realm sidesteps it. */
test('projects sort by name by default, tie-broken the same way for every sort', () => {
  const c = load({ projectSort: 'name' });
  const list = [project({ name: 'Zeta' }), project({ name: 'Alpha' }), project({ name: 'Mid' })];
  const sorted = [...vm.runInContext(`sortProjects(${JSON.stringify(list)})`, c)];
  assert.deepEqual(sorted.map(p => p.name), ['Alpha', 'Mid', 'Zeta']);
});

test('sorting by due date puts no-due-date projects last, tied entries by name', () => {
  const c = load({ projectSort: 'due' });
  const list = [
    project({ name: 'No date', dueOn: null }),
    project({ name: 'Later', dueOn: `${thisYear + 1}-01-01` }),
    project({ name: 'Sooner', dueOn: `${thisYear}-01-01` }),
    project({ name: 'Also sooner', dueOn: `${thisYear}-01-01` })
  ];
  const sorted = [...vm.runInContext(`sortProjects(${JSON.stringify(list)})`, c)];
  assert.deepEqual(sorted.map(p => p.name), ['Also sooner', 'Sooner', 'Later', 'No date']);
});

test('sorting by status follows the board\'s own order, not the alphabet', () => {
  const c = load({ projectSort: 'status' });
  const list = [
    project({ name: 'Held', status: 'On hold' }),
    project({ name: 'Fresh', status: 'Discovery' }),
    project({ name: 'Reviewing', status: 'In review' })
  ];
  const sorted = [...vm.runInContext(`sortProjects(${JSON.stringify(list)})`, c)];
  assert.deepEqual(sorted.map(p => p.name), ['Fresh', 'Reviewing', 'Held'], 'Discovery, then In review, then On hold — the order work moves through them');
});

test('the status filter and sort selects offer every status and mark the one chosen', () => {
  const c = load();
  vm.runInContext('projectFilter=undefined', c); // not read by projectSelectOptions itself; just proving it is a plain option-list builder
  const html = vm.runInContext(`projectSelectOptions([['all','All statuses'],...projectsModel.STATUS_LABELS.map(s=>[s,s])],'In review')`, c);
  assert.match(html, /<option value="all">All statuses<\/option>/);
  assert.match(html, /<option value="In review" selected>In review<\/option>/);
  assert.equal((html.match(/<option/g) || []).length, STATUS_LABELS.length + 1);
});
