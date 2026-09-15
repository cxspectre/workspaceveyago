/* A project's task list, as tasks-ui.js draws it: the order tasks are in, who
   each is for and when it is due, who may move a task along, edit it or remove
   it, what the edit and remove dialogs save, and what anyone typed kept as
   text. The page's helpers are stand-ins that keep what they are given, so what
   is tested is what tasks-ui.js hands them and the writes it asks for. Loaded
   into a sandbox the way <script> tags run it, on a clock the test sets.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'Europe/Amsterdam';

/* Wednesday, September 16, 2026, 09:00. */
const NOW = new Date(2026, 8, 16, 9).getTime();
const P1 = 'a1000000-0000-4000-8000-000000000001';
const ME = 'e1000000-0000-4000-8000-000000000001';
const YOU = 'e1000000-0000-4000-8000-000000000002';
const TEAM = [{ id: ME, name: 'Sam Rivera' }, { id: YOU, name: 'Ana Lima' }];
const OWNER_VIEW = { id: ME, role: 'owner', status: 'active' };
const TYPED = '<img src=x onerror=alert(1)>';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* A task as queries.js shapes it, the tasks row under `row`. */
function task(id, row = {}) {
  const r = { id, project_id: P1, title: `Task ${id}`, status: 'todo', priority: 'normal', due_date: null, assignee_id: null, details: null, ...row };
  return { id, title: r.title, done: r.status === 'done', status: r.status, assigneeId: r.assignee_id, who: null, row: r };
}

/* An element a click lands on, with one data attribute. */
function target(attribute, value) {
  const key = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const element = { dataset: { [key]: value } };
  return { closest: selector => (selector.split(',').map(s => s.trim()).includes(`[${attribute}]`) ? element : null) };
}

/* The dialog form showModal() puts on the page: its id, what it was filled in
   with, its error line, its submit button, its fields as dialog-forms.js marks
   them, and what got focus. */
function dialog(id) {
  const handlers = {};
  const fields = {};
  const form = {
    id, values: {}, isConnected: true, handlers, fields, focused: [],
    button: {
      disabled: false, dataset: {}, attributes: {}, focused: 0,
      focus() { this.focused += 1; },
      removeAttribute(name) { delete this.attributes[name]; }
    },
    error: { textContent: '', id: `${id}-error` },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    field: selector => (fields[selector] = fields[selector] || {
      attributes: {},
      focus: () => form.focused.push(selector),
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; }
    }),
    querySelector: selector => (selector === '[type="submit"]' ? form.button
      : selector === '.form-error' ? form.error
        : selector === '.form-candidates' ? null
          : form.field(selector))
  };
  return form;
}

/* refuseUpdates: every save is refused. staleReload: a save lands, but the
   reload after it brings the task as it was. */
function load({ tasks = [], viewer = { id: ME, role: 'employee', status: 'active' }, manager = false, members = [], owner = null, team = TEAM, teams = true, refuseUpdates = false, staleReload = false, loaded = true, refuseCreate = false, teamLoaded = true, refuseRemove = false, active = null, misses = [] } = {}) {
  const listeners = {};
  const timers = [];
  const toasts = [];
  const modals = [];
  const updates = [];
  const removals = [];
  const created = [];
  /* What the page gave the keyboard to, by selector, and the page itself. */
  const pageFocus = [];
  const BODY = {};
  let form = null;
  /* A save held on its way to the database, the saves still to refuse, and
     the status selects and tick boxes the page has. */
  let held = null;
  /* The load after a dialog's write, while a test holds it open. */
  let reloading = null;
  /* The loads begun so far, and the one each part last arrived from (store.js mark and loadedSince). */
  const loads = { begun: 0, arrived: {} };
  let refusals = refuseUpdates ? Infinity : 0;
  let onPage = [];
  let onBoxes = [];
  const project = { id: P1, uuid: P1, name: 'Northline site', ownerId: owner, taskIds: tasks.map(t => t.id), taskList: tasks };
  const context = vm.createContext({
    console,
    esc: escape,
    icon: name => `<svg data-icon="${name}"></svg>`,
    pill: (label, tone) => `<span class="pill ${tone}">${escape(label)}</span>`,
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); form = dialog((body.match(/<form id="([^"]+)"/) || [])[1]); context.modal.open = true; },
    modal: { open: true, close() { this.open = false; } },
    team,
    projects: [project],
    workspaceSession: { employee: viewer, isManager: () => manager },
    workspaceStore: {
      state: { loaded, projectMembers: members },
      has: part => (part === 'projectMembers' ? teams : part === 'team' ? teamLoaded : true),
      /* As store.js's after() does: once the write is in, the workspace is
         loaded again; a refusal is said in a toast unless the caller says it
         itself ({ toast: false }), and passed on. */
      after: (work, options) => Promise.resolve(work).then(
        value => (reloading ? reloading.promise : Promise.resolve()).then(() => {
          loads.begun += 1;
          if (!misses.includes('projects')) loads.arrived.projects = loads.begun;
          return value;
        }),
        err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; }),
      /* The loads begun so far, and the one the projects — and their tasks — last arrived from (store.js). */
      mark: () => loads.begun,
      loadedSince: (part, mark) => loads.arrived[part] !== undefined && loads.arrived[part] > mark
    },
    /* Timers fire only when a test fires them. */
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }),
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    workspaceActions: {
      updateTask: async (id, changes) => {
        updates.push([id, { ...changes }]);
        if (held) await held;
        if (refusals > 0) { refusals -= 1; throw new Error('The task was not saved.'); }
        /* What the store's reload brings back: the task as saved — or, stale, as it was. */
        const saved = tasks.find(t => t.id === id);
        if (saved && changes.status && !staleReload) Object.assign(saved, { status: changes.status, done: changes.status === 'done', row: { ...saved.row, status: changes.status } });
        return { id, status: changes.status };
      },
      deleteTask: async id => {
        removals.push(id);
        if (refuseRemove) throw new Error('The task was not removed: only an owner or admin can remove a task.');
      },
      createTask: async fields => {
        created.push({ ...fields });
        if (refuseCreate) throw new Error('Could not create the task: permission denied');
        return { id: 'new-task', ...fields };
      }
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => (form && form.id === id ? form : null),
      body: BODY,
      activeElement: active || BODY,
      querySelector: selector => ({ focus: () => pageFocus.push(selector) }),
      querySelectorAll: selector => (selector === '[data-task-status]' ? onPage : selector === '[data-task-id]' ? onBoxes : [])
    },
    FormData: class { constructor(f) { this.f = f; } entries() { return Object.entries(this.f.values); } }
  });
  context.window = context;
  vm.runInContext(`const RealDate = Date; var __now = ${NOW};
    Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [__now])); } static now() { return __now; } };`, context);
  for (const file of ['tasks-model.js', 'dialog-forms.js', 'tasks-ui.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  const ui = vm.runInContext('tasksUi', context);
  return {
    panel: () => ui.panel(project),
    click: node => (listeners.click || []).forEach(fn => fn({ target: node, preventDefault() {} })),
    change: node => (listeners.change || []).forEach(fn => fn({ target: node, preventDefault() {} })),
    form: () => form,
    submit: async () => { form.handlers.submit({ preventDefault() {} }); await settle(); },
    send: () => form.handlers.submit({ preventDefault() {} }),
    fire: () => timers.filter(t => !t.cleared).forEach(t => { t.cleared = true; t.fn(); }),
    page: (...selects) => { onPage = selects; },
    boxes: (...boxes) => { onBoxes = boxes; },
    refuseNext: () => { refusals = 1; },
    ui: () => ui,
    /* Holds the next saves on their way until the function it returns is called. */
    hold: () => { let release; held = new Promise(resolve => { release = resolve; }); return () => { held = null; release(); }; },
    /* Holds the load after the next dialog's write open until the function it returns is called. */
    holdReload: () => { let release; reloading = { promise: new Promise(resolve => { release = resolve; }) }; return () => { reloading = null; release(); }; },
    /* A later load brings the projects, and their tasks, back. */
    arrive: part => { loads.begun += 1; loads.arrived[part] = loads.begun; },
    /* A reload without the task: someone removed it. */
    remove: id => { project.taskList = project.taskList.filter(t => t.id !== id); },
    timers, toasts, modals, updates, removals, created, pageFocus, modal: context.modal
  };
}

const order = html => [...html.matchAll(/data-task-id="([^"]+)"/g)].map(m => m[1]);

/* A task's status select, as the page has it, and a change event that lands on it. */
const statusSelect = (id, value) => ({
  dataset: { taskStatus: id }, value, disabled: false, attributes: {},
  options: [{ value: 'todo', defaultSelected: true }],
  setAttribute(name, v) { this.attributes[name] = v; },
  removeAttribute(name) { delete this.attributes[name]; }
});
const on = element => ({ closest: selector => (selector === '[data-task-status]' ? element : null) });

/* ── The list ───────────────────────────────────────────────────────────── */

test('open tasks first, overdue at the top, then by due date and priority; done tasks last', () => {
  const html = load({
    tasks: [
      task('done', { status: 'done', due_date: '2026-09-01' }),
      task('later', { due_date: '2026-09-30' }),
      task('late', { due_date: '2026-09-10' }),
      task('urgent-undated', { priority: 'urgent' }),
      task('soon', { due_date: '2026-09-18' })
    ]
  }).panel();
  assert.deepEqual(order(html), ['late', 'soon', 'later', 'urgent-undated', 'done']);
  assert.match(html, /<span class="quiet-text">1 \/ 5 complete<\/span>/);
});

test('each task says who it is for, when it is due and how far along it is', () => {
  const html = load({
    tasks: [
      task('a', { assignee_id: YOU, due_date: '2026-09-10', status: 'in_progress' }),
      task('b', { due_date: '2026-09-17', priority: 'urgent', status: 'blocked' }),
      task('c', { assignee_id: 'e-gone' })
    ]
  }).panel();
  assert.match(html, /<span class="pill blue">In progress<\/span><span>Ana Lima<\/span><span class="task-due overdue">Overdue · Sep 10<\/span>/);
  assert.match(html, /<span class="pill red">Blocked<\/span><span>Nobody yet<\/span><span class="task-due">Due tomorrow<\/span><span class="pill red">Urgent<\/span>/);
  assert.match(html, /<span>Someone no longer on the team<\/span>/);
});

test('a project with no tasks says so, and the list is named by its heading', () => {
  const html = load().panel();
  assert.match(html, /<p class="quiet-text">No tasks yet\.<\/p>/);
  assert.match(html, new RegExp(`<div class="task-list" role="list" aria-labelledby="tasks-${P1}">`));
});

test('an owner or admin edits and removes; the assignee and the project\'s team move a task along; anyone else only sees it', () => {
  const t = task('a', { assignee_id: YOU });
  const controls = html => ({
    status: /data-task-status="a"/.test(html),
    edit: /data-task-edit="a"/.test(html),
    remove: /data-task-remove="a"/.test(html),
    tick: !/data-task-id="a"[^>]*disabled/.test(html)
  });
  assert.deepEqual(controls(load({ tasks: [t], viewer: OWNER_VIEW, manager: true }).panel()),
    { status: true, edit: true, remove: true, tick: true });
  assert.deepEqual(controls(load({ tasks: [t], viewer: { id: YOU, role: 'employee', status: 'active' } }).panel()),
    { status: true, edit: false, remove: false, tick: true }, 'its assignee');
  assert.deepEqual(controls(load({ tasks: [t], members: [{ project_id: P1, employee_id: ME }] }).panel()),
    { status: true, edit: false, remove: false, tick: true }, 'a member of the project\'s team');
  assert.deepEqual(controls(load({ tasks: [t], owner: ME }).panel()),
    { status: true, edit: false, remove: false, tick: true }, 'the project\'s owner');
  assert.deepEqual(controls(load({ tasks: [t] }).panel()),
    { status: false, edit: false, remove: false, tick: false }, 'anyone else on staff');
});

test('what anyone typed stays text, in the list and in the edit dialog', () => {
  const h = load({ tasks: [task('x', { title: TYPED, assignee_id: YOU, details: TYPED })], team: [{ id: YOU, name: TYPED }], viewer: OWNER_VIEW, manager: true });
  assert.doesNotMatch(h.panel(), /<img/i);
  h.click(target('data-task-edit', 'x'));
  assert.doesNotMatch(h.modals[0].body, /<img/i);
  assert.match(h.modals[0].body, /value="&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.match(h.modals[0].body, /<textarea name="details" maxlength="10000">&lt;img src=x onerror=alert\(1\)&gt;<\/textarea>/, 'details too');
  h.click(target('data-task-new', P1));
  assert.doesNotMatch(h.modals[1].body, /<img/i, 'nor in the new task dialog');
  assert.match(h.modals[1].body, new RegExp(`<option value="${YOU}">&lt;img src=x onerror=alert\\(1\\)&gt;</option>`));
});

/* ── The dialogs ────────────────────────────────────────────────────────── */

test('the edit dialog saves only what changed, and a task marked done takes the time it was done', async () => {
  const h = load({ tasks: [task('a', { due_date: '2026-09-20', assignee_id: YOU })], viewer: OWNER_VIEW, manager: true });
  h.click(target('data-task-edit', 'a'));
  assert.match(h.modals[0].body, /<input type="date" name="dueDate" value="2026-09-20">/);
  assert.match(h.modals[0].body, new RegExp(`<option value="${YOU}" selected>Ana Lima</option>`));
  h.form().values = { title: 'Task a', details: '', assigneeId: YOU, dueDate: '2026-09-25', priority: 'normal', status: 'done' };
  await h.submit();
  assert.equal(h.updates.length, 1);
  const [id, changes] = h.updates[0];
  assert.equal(id, 'a');
  assert.deepEqual(Object.keys(changes).sort(), ['completed_at', 'due_date', 'status']);
  assert.equal(changes.due_date, '2026-09-25');
  assert.equal(changes.completed_at, new Date(NOW).toISOString());
  assert.deepEqual(h.toasts, ['Task saved.']);
  assert.deepEqual(h.pageFocus, ['#main [data-task-edit="a"]'], 'the keyboard back on the task, on the page as drawn again');
});

test('a dialog that cannot be saved says why and points at the field; one nobody changed saves nothing', async () => {
  const h = load({ tasks: [task('a')], viewer: OWNER_VIEW, manager: true });
  h.click(target('data-task-edit', 'a'));
  h.form().values = { title: '   ', details: '', assigneeId: '', dueDate: '', priority: 'normal', status: 'todo' };
  await h.submit();
  assert.deepEqual(h.updates, []);
  assert.equal(h.form().error.textContent, 'A task needs a title.');
  assert.equal(h.form().field('[name="title"]').attributes['aria-invalid'], 'true', 'on the field it is about');
  assert.deepEqual(h.form().focused, ['[name="title"]']);
  h.form().values = { title: 'Task a', details: '', assigneeId: '', dueDate: '', priority: 'normal', status: 'todo' };
  await h.submit();
  assert.equal(h.form().error.textContent, '', 'said no more once it is fine');
  assert.equal(h.form().field('[name="title"]').attributes['aria-invalid'], undefined);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.toasts, ['Nothing changed.']);
  assert.equal(h.modal.open, false, 'and the dialog closes');
});

test('an edit the database refuses is said on the dialog, which stays open with what was typed', async () => {
  const h = load({ tasks: [task('a')], viewer: OWNER_VIEW, manager: true, refuseUpdates: true });
  h.click(target('data-task-edit', 'a'));
  h.form().values = { title: 'Task a, renamed', details: '', assigneeId: '', dueDate: '', priority: 'normal', status: 'todo' };
  await h.submit();
  assert.equal(h.updates.length, 1);
  assert.equal(h.modal.open, true);
  assert.equal(h.form().error.textContent, 'The task was not saved.');
  assert.equal(h.form().button.disabled, false);
  assert.equal(h.form().button.focused, 1, 'focus back on the button it left while it saved');
  assert.deepEqual(h.toasts, [], 'said once, on the dialog, rather than in a toast as well');
});

test('until the workspace is loaded again after an edit or a removal, that task\'s buttons wait; another task\'s do not', async () => {
  const WAIT = 'The last change to that task is still on its way. Try again in a moment.';
  const h = load({ tasks: [task('a'), task('b')], viewer: OWNER_VIEW, manager: true });
  const reloaded = h.holdReload();
  h.click(target('data-task-edit', 'a'));
  h.form().values = { title: 'Task a, renamed', details: '', assigneeId: '', dueDate: '', priority: 'normal', status: 'todo' };
  await h.submit();
  assert.equal(h.updates.length, 1);
  assert.equal(h.modal.open, false, 'the dialog closes once the database has it');
  h.click(target('data-task-edit', 'a'));
  h.click(target('data-task-remove', 'a'));
  assert.equal(h.modals.length, 1, 'no dialog filled in with the task as it was');
  assert.deepEqual(h.toasts, [WAIT, WAIT]);
  h.click(target('data-task-edit', 'b'));
  assert.equal(h.modals.length, 2, 'another task opens');
  reloaded();
  await settle();
  assert.equal(h.toasts.at(-1), 'Task saved.');
  h.click(target('data-task-remove', 'a'));
  assert.equal(h.modals.length, 3, 'once it is loaded again, the task opens');
  const removing = load({ tasks: [task('a')], viewer: OWNER_VIEW, manager: true });
  const removed = removing.holdReload();
  removing.click(target('data-task-remove', 'a'));
  await removing.submit();
  removing.click(target('data-task-remove', 'a'));
  assert.deepEqual(removing.removals, ['a'], 'not removed twice');
  assert.deepEqual(removing.toasts, [WAIT]);
  removed();
  await settle();
});

test('a task whose project did not come back with the load after its change keeps its buttons waiting until a later load brings it', async () => {
  const WAIT = 'The last change to that task is still on its way. Try again in a moment.';
  const h = load({ tasks: [task('a')], viewer: OWNER_VIEW, manager: true, misses: ['projects'] });
  h.arrive('projects');
  h.click(target('data-task-edit', 'a'));
  h.form().values = { title: 'Task a, renamed', details: '', assigneeId: '', dueDate: '', priority: 'normal', status: 'todo' };
  await h.submit();
  assert.deepEqual(h.toasts, ['Task saved.']);
  h.click(target('data-task-edit', 'a'));
  assert.equal(h.modals.length, 1, 'the page still has the task as it was, which saving again would put back');
  assert.equal(h.toasts.at(-1), WAIT);
  h.arrive('projects');
  h.click(target('data-task-edit', 'a'));
  assert.equal(h.modals.length, 2);
});

test('removing asks first, then removes the task', async () => {
  const h = load({ tasks: [task('a')], viewer: OWNER_VIEW, manager: true });
  h.click(target('data-task-remove', 'a'));
  assert.match(h.modals[0].body, /<h2>Remove Task a\?<\/h2>/);
  assert.deepEqual(h.removals, []);
  await h.submit();
  assert.deepEqual(h.removals, ['a']);
  assert.deepEqual(h.toasts, ['Task removed.']);
  assert.deepEqual(h.pageFocus, [`#main [data-task-new="${P1}"]`], 'its buttons are gone, so the keyboard goes to New task');
});

/* ── Adding a task ──────────────────────────────────────────────────────── */

test('anyone on staff adds a task with New task, in place of the box that took a title alone', () => {
  const html = load({ tasks: [task('a')] }).panel();
  assert.match(html, new RegExp(`<div class="task-actions"><button type="button" class="btn" data-task-new="${P1}"><svg data-icon="plus"></svg>New task</button></div>`));
  assert.doesNotMatch(html, /data-add-task|<input name="task"/);
  assert.match(load().panel(), /<p class="quiet-text">No tasks yet\.<\/p>/);
  assert.doesNotMatch(load({ viewer: null }).panel(), /data-task-new/, 'not for a session with no one on the team behind it');
});

test('New task asks for a title, details, who it is for, when it is due and how urgent — for whoever adds it, unless changed', async () => {
  const h = load({ tasks: [task('a')] });
  h.click(target('data-task-new', P1));
  assert.equal(h.modals.length, 1);
  const body = h.modals[0].body;
  assert.match(body, /<h2>New task<\/h2>/);
  assert.match(body, /<form id="task-new-form" method="dialog" novalidate>/);
  assert.match(body, /<input name="title" required maxlength="200" autofocus>/, 'the keyboard starts on the title');
  assert.match(body, /<textarea name="details" maxlength="10000"><\/textarea>/);
  assert.match(body, new RegExp(`<select name="assigneeId"><option value="">Nobody</option><option value="${ME}" selected>Sam Rivera</option><option value="${YOU}">Ana Lima</option></select>`));
  assert.match(body, /<input type="date" name="dueDate">/);
  assert.match(body, /<option value="normal" selected>Normal<\/option>/);
  assert.doesNotMatch(body, /name="status"/, 'a new task starts to do');
  h.form().values = { title: '  Draft the homepage copy ', details: 'Two options', assigneeId: YOU, dueDate: '2026-09-25', priority: 'high' };
  await h.submit();
  assert.deepEqual(h.created, [{ title: 'Draft the homepage copy', details: 'Two options', assigneeId: YOU, dueDate: '2026-09-25', priority: 'high', projectId: P1 }]);
  assert.equal(h.modal.open, false);
  assert.deepEqual(h.toasts, ['Task added.']);
  assert.deepEqual(h.pageFocus, [`#main [data-task-new="${P1}"]`], 'the keyboard back on New task, on the page as drawn again');
});

test('a new task for nobody is added for nobody, with no due date or details when none are given', async () => {
  const h = load();
  h.click(target('data-task-new', P1));
  h.form().values = { title: 'Book the photographer', details: '', assigneeId: '', dueDate: '', priority: 'normal' };
  await h.submit();
  assert.deepEqual(h.created, [{ title: 'Book the photographer', details: null, assigneeId: null, dueDate: null, priority: 'normal', projectId: P1 }]);
  const outsider = load({ viewer: { id: 'e1000000-0000-4000-8000-000000000009', role: 'employee', status: 'active' } });
  outsider.click(target('data-task-new', P1));
  assert.match(outsider.modals[0].body, /<option value="">Nobody<\/option><option value="e1000000-0000-4000-8000-000000000001">Sam Rivera<\/option>/,
    'someone not in the team list is not picked for it; nobody is');
});

test('a new task the rules refuse says why on its field; one the database refuses keeps the dialog and what was typed', async () => {
  const h = load({ refuseCreate: true });
  h.click(target('data-task-new', P1));
  h.form().values = { title: '  ', details: '', assigneeId: ME, dueDate: '', priority: 'normal' };
  await h.submit();
  assert.deepEqual(h.created, []);
  assert.equal(h.form().error.textContent, 'A task needs a title.');
  assert.equal(h.form().field('[name="title"]').attributes['aria-invalid'], 'true');
  assert.deepEqual(h.form().focused, ['[name="title"]']);
  h.form().values = { title: 'Book the photographer', details: '', assigneeId: ME, dueDate: '2026-02-30', priority: 'normal' };
  await h.submit();
  assert.equal(h.form().error.textContent, 'That due date is not a date.');
  assert.equal(h.form().field('[name="dueDate"]').attributes['aria-invalid'], 'true');
  assert.equal(h.form().field('[name="title"]').attributes['aria-invalid'], undefined, 'the title, fixed, is marked no more');
  h.form().values = { title: 'Book the photographer', details: '', assigneeId: 'e1000000-0000-4000-8000-00000000dead', dueDate: '', priority: 'normal' };
  await h.submit();
  assert.equal(h.form().error.textContent, 'Pick someone on the team, or nobody.');
  assert.deepEqual(h.created, []);
  h.form().values = { title: 'Book the photographer', details: '', assigneeId: ME, dueDate: '', priority: 'normal' };
  h.send();
  h.send();
  await settle();
  assert.equal(h.created.length, 1, 'two quick sends add it once');
  assert.equal(h.modal.open, true, 'the dialog stays, with what was typed');
  assert.equal(h.form().error.textContent, 'Could not create the task: permission denied.');
  assert.equal(h.form().button.disabled, false);
  assert.equal(h.form().button.focused, 1);
});

test('New task waits for the workspace, needs its project loaded, and someone on the team to add it', () => {
  const waiting = load({ loaded: false });
  waiting.click(target('data-task-new', P1));
  assert.equal(waiting.modals.length, 0);
  assert.deepEqual(waiting.toasts, ['Not yet: the workspace is still loading.']);
  const gone = load();
  gone.click(target('data-task-new', 'a1000000-0000-4000-8000-00000000dead'));
  assert.equal(gone.modals.length, 0);
  assert.deepEqual(gone.toasts, ['That project is not loaded any more. Reload the page.']);
  const nobody = load({ viewer: null });
  nobody.click(target('data-task-new', P1));
  assert.equal(nobody.modals.length, 0);
  assert.deepEqual(nobody.toasts, ['Only someone on the team can add a task.']);
});

test('when the team did not load, a new task can be for whoever adds it or for nobody, and the dialog says so', async () => {
  const h = load({ teamLoaded: false, team: [] });
  h.click(target('data-task-new', P1));
  assert.match(h.modals[0].body, /The team did not load, so for now a task can be for you or for nobody\./);
  assert.match(h.modals[0].body, new RegExp(`<select name="assigneeId"><option value="">Nobody</option><option value="${ME}" selected>You</option></select>`));
  h.form().values = { title: 'Book the photographer', details: '', assigneeId: ME, dueDate: '', priority: 'normal' };
  await h.submit();
  assert.deepEqual(h.created.map(c => c.assigneeId), [ME], 'still for whoever adds it, not quietly for nobody');
  const edit = load({ tasks: [task('a', { assignee_id: YOU })], viewer: OWNER_VIEW, manager: true, teamLoaded: false, team: [] });
  edit.click(target('data-task-edit', 'a'));
  assert.match(edit.modals[0].body, new RegExp(`<option value="${YOU}" selected>Current assignee</option>`), 'not said to have left');
});

test('an edit keeps a task for someone who has left the team, unless someone else is picked', async () => {
  const GONE = 'e1000000-0000-4000-8000-00000000dead';
  const h = load({ tasks: [task('a', { assignee_id: GONE })], viewer: OWNER_VIEW, manager: true });
  h.click(target('data-task-edit', 'a'));
  assert.match(h.modals[0].body, new RegExp(`<option value="${GONE}" selected>Current assignee \\(no longer on the team\\)</option>`));
  h.form().values = { title: 'Task a', details: '', assigneeId: GONE, dueDate: '2026-09-30', priority: 'normal', status: 'todo' };
  await h.submit();
  assert.deepEqual(h.updates.map(([, changes]) => Object.keys(changes)), [['due_date']], 'moving the date leaves who it is for alone');
});

test('someone not on the project\'s team is told, before adding a task, that they can move it along only if it is for them', () => {
  const said = /You are not on this project’s team, so once it is added you can move it along only if it is for you\./;
  const outsider = load();
  outsider.click(target('data-task-new', P1));
  assert.match(outsider.modals[0].body, said);
  const member = load({ members: [{ project_id: P1, employee_id: ME }] });
  member.click(target('data-task-new', P1));
  assert.doesNotMatch(member.modals[0].body, said);
  const owner = load({ viewer: OWNER_VIEW, manager: true });
  owner.click(target('data-task-new', P1));
  assert.doesNotMatch(owner.modals[0].body, said);
  const unknown = load({ teams: false });
  unknown.click(target('data-task-new', P1));
  assert.doesNotMatch(unknown.modals[0].body, said, 'not said while project teams did not load');
});

test('a removal the database refuses is said on the dialog, and a retry starts from a clean one', async () => {
  const h = load({ tasks: [task('a')], viewer: OWNER_VIEW, manager: true, refuseRemove: true });
  h.click(target('data-task-remove', 'a'));
  await h.submit();
  assert.equal(h.form().error.textContent, 'The task was not removed: only an owner or admin can remove a task.');
  assert.equal(h.modal.open, true);
  h.send();
  assert.equal(h.form().error.textContent, '', 'the last refusal is not left up while the retry runs');
  await settle();
  assert.deepEqual(h.pageFocus, [], 'nothing on the page is focused for a removal that did not happen');
});

test('after a save, the keyboard is left where it is when it did not fall to the page', async () => {
  const h = load({ active: { isConnected: true } });
  h.click(target('data-task-new', P1));
  h.form().values = { title: 'Book the photographer', details: '', assigneeId: '', dueDate: '', priority: 'normal' };
  await h.submit();
  assert.deepEqual(h.toasts, ['Task added.']);
  assert.deepEqual(h.pageFocus, []);
});

/* ── Moving a task along ────────────────────────────────────────────────── */

test('its assignee moves a task along: the status is saved, and a task no longer done loses its completion time', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' } });
  const select = statusSelect('a', 'in_progress');
  h.change(on(select));
  h.fire();
  await settle();
  assert.deepEqual(h.updates, [['a', { status: 'in_progress', completed_at: null }]]);
  assert.deepEqual(h.toasts, ['Task a: In progress.']);
});

test('someone who may not move or edit a task is refused, even with a forged control', () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })] });
  const select = { dataset: { taskStatus: 'a' }, value: 'done', options: [{ value: 'todo', defaultSelected: true }], disabled: false };
  h.change({ closest: selector => (selector === '[data-task-status]' ? select : null) });
  assert.deepEqual(h.updates, []);
  assert.equal(select.value, 'todo', 'what was picked is put back');
  assert.match(h.toasts[0], /Only the task’s assignee, its project’s team, or an owner or admin can move it along\./);
  h.click(target('data-task-edit', 'a'));
  h.click(target('data-task-remove', 'a'));
  assert.equal(h.modals.length, 0);
  assert.deepEqual(h.toasts.slice(1), ['Only an owner or admin can edit a task.', 'Only an owner or admin can remove a task.']);
});

test('arrowing through the statuses saves the one it settles on, once, and the select stays enabled for the keyboard', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' } });
  const select = statusSelect('a', 'in_progress');
  h.page(select);
  h.change(on(select));
  select.value = 'blocked';
  h.change(on(select));
  select.value = 'done';
  h.change(on(select));
  await settle();
  assert.deepEqual(h.updates, [], 'nothing is saved while the choice is still moving');
  assert.equal(select.disabled, false);
  assert.equal(h.timers.filter(t => !t.cleared).length, 1, 'one save waiting');
  assert.equal(h.timers.find(t => !t.cleared).ms, 600);
  const release = h.hold();
  h.fire();
  await settle();
  assert.equal(select.attributes['aria-busy'], 'true', 'busy while it saves');
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0][1].status, 'done');
  release();
  await settle();
  assert.equal(select.attributes['aria-busy'], undefined, 'no longer busy once saved');
  assert.equal(select.disabled, false);
});

test('a status picked while the last is saving waits for it, and is compared with it rather than with the task as loaded', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' } });
  const select = statusSelect('a', 'done');
  h.page(select);
  const release = h.hold();
  h.change(on(select));
  h.fire();
  await settle();
  assert.equal(h.updates.length, 1, 'done, on its way');
  select.value = 'todo';
  h.change(on(select));
  h.fire();
  await settle();
  assert.equal(h.updates.length, 1, 'the second waits for the first');
  release();
  await settle();
  assert.deepEqual(h.updates.map(([, changes]) => changes.status), ['done', 'todo'],
    'back to to-do, though the task as loaded was to-do when it was picked');
  assert.equal(h.updates[1][1].completed_at, null);
});

test('a status the database refuses is put back on the select the page has by then', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' }, refuseUpdates: true });
  const changed = statusSelect('a', 'done');
  const rebuilt = statusSelect('a', 'done');
  h.page(rebuilt);
  const release = h.hold();
  h.change(on(changed));
  h.fire();
  await settle();
  assert.equal(rebuilt.attributes['aria-busy'], 'true', 'busy while it saves');
  release();
  await settle();
  assert.equal(h.updates.length, 1);
  assert.equal(rebuilt.value, 'todo', 'the select on the page shows the status stored');
  assert.equal(rebuilt.attributes['aria-busy'], undefined);
  assert.equal(h.toasts.at(-1), 'The task was not saved.', 'and says why');
});

test('a task removed before its status settles is not saved, and that is said', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' } });
  h.change(on(statusSelect('a', 'done')));
  h.remove('a');
  h.fire();
  await settle();
  assert.deepEqual(h.updates, []);
  assert.equal(h.toasts.at(-1), 'That task was removed, so its new status was not saved.');
});

test('a status changed back while the last one saves is saved, even when the reload after that save brought nothing new', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' }, staleReload: true });
  const select = statusSelect('a', 'done');
  h.page(select);
  const release = h.hold();
  h.change(on(select));
  h.fire();
  await settle();
  select.value = 'todo';
  h.change(on(select));
  h.fire();
  release();
  await settle();
  assert.deepEqual(h.updates.map(([, changes]) => changes.status), ['done', 'todo'],
    'compared with the done the first save wrote, not with the to-do a stale reload still shows');
});

test('a tick joins the task\'s saves: a status still settling gives way to it, and it waits for a save on its way', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' } });
  const select = statusSelect('a', 'in_progress');
  h.page(select);
  h.change(on(select));
  h.ui().setStatus('a', 'done');
  assert.equal(h.timers.filter(t => !t.cleared).length, 0, 'the choice still settling is dropped');
  await settle();
  assert.deepEqual(h.updates.map(([, changes]) => changes.status), ['done']);
  const release = h.hold();
  h.ui().setStatus('a', 'todo');
  await settle();
  select.value = 'done';
  h.change(on(select));
  h.fire();
  await settle();
  assert.equal(h.updates.length, 2, 'the select waits for the untick');
  release();
  await settle();
  assert.deepEqual(h.updates.map(([, changes]) => changes.status), ['done', 'todo', 'done']);
});

test('a refused tick is put back in the task\'s box', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' }, refuseUpdates: true });
  const box = { dataset: { taskId: 'a', stored: 'todo' }, checked: true };
  h.boxes(box);
  h.ui().setStatus('a', 'done');
  await settle();
  assert.equal(box.checked, false);
  assert.equal(h.toasts.at(-1), 'The task was not saved.');
});

test('a refused status is not put back while a later choice for the task is on its way', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' } });
  const select = statusSelect('a', 'done');
  h.page(select);
  h.refuseNext();
  const release = h.hold();
  h.change(on(select));
  h.fire();
  await settle();
  select.value = 'blocked';
  h.change(on(select));
  h.fire();
  release();
  await settle();
  assert.equal(select.value, 'blocked', 'not put back to the stored status while blocked is saving');
  assert.deepEqual(h.updates.map(([, changes]) => changes.status), ['done', 'blocked']);
});

test('a task list drawn again while a status saves shows the choice on its way, marked busy', async () => {
  const h = load({ tasks: [task('a', { assignee_id: YOU })], viewer: { id: YOU, role: 'employee', status: 'active' } });
  const release = h.hold();
  h.change(on(statusSelect('a', 'blocked')));
  h.fire();
  await settle();
  const drawn = h.panel();
  assert.match(drawn, /<select data-task-status="a" data-stored="todo" aria-busy="true"/);
  assert.match(drawn, /<option value="blocked" selected>/);
  release();
  await settle();
  assert.doesNotMatch(h.panel(), /aria-busy/);
  assert.match(h.panel(), /<select data-task-status="a" data-stored="blocked"/);
});

test('when project teams did not load, a task\'s controls are offered and the database decides', async () => {
  const t = task('a', { assignee_id: YOU });
  const html = load({ tasks: [t], teams: false }).panel();
  assert.match(html, /data-task-status="a"/);
  assert.doesNotMatch(html, /data-task-id="a"[^>]*disabled/);
  const h = load({ tasks: [t], teams: false });
  h.change(on(statusSelect('a', 'done')));
  h.fire();
  await settle();
  assert.equal(h.updates.length, 1, 'sent, for the database to decide');
  assert.deepEqual(h.toasts.filter(message => /Only the task/.test(message)), []);
});
