/* The project page's panels, without a page: project-panels.js against the
   model it reads, a stand-in store and actions that record every write, and a
   document that only hands out the event listeners it was given. Loaded into
   a sandbox the way <script> tags run it.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setImmediate(resolve));
const ticks = async n => { for (let i = 0; i < n; i++) await tick(); };

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const PROJECT = { id: 'p1', uuid: 'u-p1', name: 'Northline site', ownerId: 'e-owner', companyId: 'co1' };
const TEAM = [
  { id: 'e-owner', name: 'Ana Lima', initial: 'AL' },
  { id: 'e-me', name: 'Sam Rivera', initial: 'SR' },
  { id: 'e-jo', name: 'Jo Park', initial: 'JP' }
];
const MEMBERS = [{ project_id: 'p1', employee_id: 'e-me' }, { project_id: 'p1', employee_id: 'e-jo' }];
const FILES = [{
  id: 'f1', project_id: 'p1', name: 'brief.pdf', storage_path: 'p1/u1/brief.pdf', size_bytes: 2048,
  mime_type: 'application/pdf', uploaded_by: 'e-me', created_at: '2026-09-01T10:00:00Z'
}];

/* A dialog's fake DOM, the way finance-ui.test.mjs's own harness builds one:
   holds handlers registered on it and the small set of sub-elements a panel's
   dialog reads back with querySelector. */
function dialogForm(id) {
  const parts = {};
  const part = selector => (parts[selector] = parts[selector] || {
    textContent: '', disabled: false, focused: 0,
    focus() { this.focused += 1; }
  });
  return { id, isConnected: true, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, querySelector: part };
}

/* actions: the workspaceActions a test needs. picks and inputs: what
   document.querySelectorAll finds for "Add files" buttons, file inputs and
   upload status lines. modals: every showModal() call, body included, so a
   test can read what a dialog said. */
function load({ manager = true, me = 'e-me', actions = {}, activity } = {}) {
  const listeners = {};
  const toasts = [];
  const picks = [];
  const inputs = [];
  const statuses = [];
  const modals = [];
  const headings = {};
  const links = [];
  let form = null;
  const context = vm.createContext({
    console,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    icon: () => '<svg></svg>',
    toast: message => toasts.push(message),
    render: () => {},
    showModal: (eyebrow, body) => {
      modals.push({ eyebrow, body });
      form = dialogForm((body.match(/<form id="([^"]+)"/) || [])[1]);
      context.modal.open = true;
    },
    modal: { open: true, close() { this.open = false; } },
    invoices: [],
    tickets: [],
    overviewModel: { activityItem: (a, ctx) => ({ initial: a.initial || '?', text: a.text, who: a.who, when: a.when, route: ctx && ctx.route }) },
    activityRow: item => `<div class="activity">${item.text}</div>`,
    projects: [PROJECT],
    contacts: [],
    team: TEAM,
    workspaceStore: {
      state: { loaded: true, projectMembers: MEMBERS, projectContacts: [], projectFiles: FILES, projectBudgets: [], companies: [] },
      after: promise => promise,
      projectActivity: activity ? (() => activity) : undefined,
      retryProjectActivity: () => {}
    },
    workspaceSession: { isManager: () => manager, employee: { id: me } },
    workspaceActions: actions,
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      querySelectorAll: selector => (
        selector === '[data-files-pick]' ? picks
          : selector === '[data-files-input]' ? inputs
            : selector === '[data-files-status]' ? statuses
              : []),
      getElementById: id => (form && form.id === id ? form : (headings[id] || null)),
      /* download()'s <a>: created, given attributes, appended, clicked,
         removed. Every one made is kept in `links` for a test to read back. */
      createElement: () => { const el = { rel: '', target: '', href: '', clicked: 0, click() { this.clicked += 1; }, remove() {} }; links.push(el); return el; },
      body: { appendChild: () => {} }
    },
    FormData: class { constructor(f) { this.f = f; } get(name) { return this.f.values[name]; } }
  });
  context.window = context;
  for (const file of ['projects-model.js', 'project-panels.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  const fire = (type, target) => (listeners[type] || []).forEach(fn => fn({ type, target, preventDefault() {} }));
  const heading = (id, el) => { headings[id] = el; };
  return {
    panels: vm.runInContext('projectPanels', context),
    fire, toasts, picks, inputs, statuses, modals, links, heading,
    submit: () => form.handlers.submit({ preventDefault() {} }),
    form: () => form
  };
}

/* An element that answers closest() for one selector only. */
const only = (selector, element) => ({ closest: s => (s === selector ? element : null) });

test('each person’s role saves on its own, and the latest choice wins', async () => {
  const first = deferred();
  const saved = [];
  const h = load({
    actions: {
      setProjectContactRole: (projectId, contactId, role) => {
        saved.push([projectId, contactId, role]);
        return saved.length === 1 ? first.promise : Promise.resolve({});
      }
    }
  });
  const role = (contact, value) => only('[data-people-role]', { dataset: { peopleRole: 'p1', contact }, value });

  h.fire('change', role('c1', 'billing'));
  await tick();
  h.fire('change', role('c1', 'decision_maker'));
  h.fire('change', role('c1', 'technical'));
  h.fire('change', role('c2', 'other'));
  await tick();
  assert.deepEqual(saved, [['u-p1', 'c1', 'billing'], ['u-p1', 'c2', 'other']],
    'someone else\'s role is not held up; the same person\'s waits');
  assert.equal(h.toasts.some(t => /Still saving/.test(t)), false, 'nothing is dropped with a "still saving"');

  first.resolve({});
  await ticks(10);
  assert.deepEqual(saved, [['u-p1', 'c1', 'billing'], ['u-p1', 'c2', 'other'], ['u-p1', 'c1', 'technical']],
    'only the latest of the waiting choices is saved');
});

test('choosing the role that is already saving saves nothing more', async () => {
  const first = deferred();
  const saved = [];
  const h = load({ actions: { setProjectContactRole: (...args) => { saved.push(args); return first.promise; } } });
  const role = value => only('[data-people-role]', { dataset: { peopleRole: 'p1', contact: 'c1' }, value });
  h.fire('change', role('billing'));
  await tick();
  h.fire('change', role('technical'));
  h.fire('change', role('billing'));
  first.resolve({});
  await ticks(10);
  assert.equal(saved.length, 1);
});

test('“Add files” is a button that opens the file picker', () => {
  const h = load();
  const html = h.panels.filesPanel(PROJECT);
  assert.match(html, /<button type="button" class="btn file-pick" data-files-pick="p1">/);
  assert.doesNotMatch(html, /<label[^>]*file-pick/, 'a label round a hidden input cannot take focus');

  let opened = 0;
  h.inputs.push({ dataset: { filesInput: 'p1' }, click: () => { opened += 1; } });
  h.fire('click', only('[data-files-pick]', { dataset: { filesPick: 'p1' } }));
  assert.equal(opened, 1);
});

test('the button waits while files upload, so a second pick is not dropped', async () => {
  const upload = deferred();
  const h = load({ actions: { uploadProjectFile: () => upload.promise } });
  const attributes = {};
  const pick = {
    dataset: { filesPick: 'p1' }, disabled: false, isConnected: true,
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: name => { delete attributes[name]; }
  };
  h.picks.push(pick);
  const input = { dataset: { filesInput: 'p1' }, files: [{ name: 'brief.pdf', size: 2048, type: 'application/pdf' }], value: 'brief.pdf' };

  h.fire('change', only('[data-files-input]', input));
  assert.equal(pick.disabled, true);
  assert.equal(attributes['aria-busy'], 'true');

  upload.resolve({});
  await ticks(10);
  assert.equal(pick.disabled, false);
  assert.equal('aria-busy' in attributes, false);
});

test('leaving the team and taking someone off it both ask first, and nothing is written until confirmed', async () => {
  const removed = [];
  const h = load({ me: 'e-me', actions: { removeProjectMember: (projectId, employeeId) => { removed.push([projectId, employeeId]); return Promise.resolve({}); } } });
  h.fire('click', only('[data-team-remove], [data-people-remove], [data-file-open], [data-file-remove]', { dataset: { teamRemove: 'p1', employee: 'e-me' } }));
  assert.equal(h.modals.length, 1);
  assert.match(h.modals[0].body, /Leave Northline site\?/);
  assert.deepEqual(removed, [], 'nothing removed just by opening the dialog');
  h.submit();
  await ticks(10);
  assert.deepEqual(removed, [['u-p1', 'e-me']]);
  assert.equal(h.toasts.at(-1), 'You left Northline site.');
});

test('taking a colleague off the team says whose it is, not "You"', async () => {
  const h = load({ me: 'e-me', actions: { removeProjectMember: () => Promise.resolve({}) } });
  h.fire('click', only('[data-team-remove], [data-people-remove], [data-file-open], [data-file-remove]', { dataset: { teamRemove: 'p1', employee: 'e-jo' } }));
  assert.match(h.modals[0].body, /Take Jo Park off Northline site&#39;s team\?/);
  h.submit();
  await ticks(10);
  assert.equal(h.toasts.at(-1), "Jo Park left Northline site's team.");
});

test('taking a client contact off a project asks first too', async () => {
  const removed = [];
  const h = load({ actions: { removeProjectContact: (projectId, contactId) => { removed.push([projectId, contactId]); return Promise.resolve({}); } } });
  h.fire('click', only('[data-team-remove], [data-people-remove], [data-file-open], [data-file-remove]', { dataset: { peopleRemove: 'p1', contact: 'k1' } }));
  assert.match(h.modals[0].body, /Take them off Northline site\?/);
  assert.deepEqual(removed, []);
  h.submit();
  await ticks(10);
  assert.deepEqual(removed, [['u-p1', 'k1']]);
});

test('a file downloads through a link opened in a new tab, so a failed or slow download does not replace the workspace', async () => {
  const h = load({ actions: { projectFileLink: () => Promise.resolve('https://storage.example/sign/p1/u1/brief.pdf') } });
  const button = { disabled: false };
  h.fire('click', only('[data-team-remove], [data-people-remove], [data-file-open], [data-file-remove]',
    Object.assign({ dataset: { fileOpen: 'f1', project: 'p1' } }, button)));
  // download() is reached through the click handler's own target, which also carries the button to disable.
  await ticks(5);
  assert.equal(h.links.length, 1, 'exactly one link made for the download');
  assert.equal(h.links[0].target, '_blank');
  assert.equal(h.links[0].rel, 'noopener');
  assert.equal(h.links[0].href, 'https://storage.example/sign/p1/u1/brief.pdf');
  assert.equal(h.links[0].clicked, 1);
});

test('uploading several files shows one at a time in a status line, not a run of toasts that outrun each other', async () => {
  const uploaded = [];
  const files = [
    { name: 'brief.pdf', size: 10, type: 'application/pdf' },
    { name: 'scope.pdf', size: 10, type: 'application/pdf' }
  ];
  const h = load({ actions: { uploadProjectFile: (projectId, file) => { uploaded.push(file.name); return Promise.resolve({}); } } });
  const status = { textContent: '', isConnected: true, dataset: { filesStatus: 'p1' } };
  h.statuses.push(status);
  const seen = [];
  const originalSet = Object.getOwnPropertyDescriptor(status, 'textContent');
  Object.defineProperty(status, 'textContent', {
    get() { return this._t || ''; },
    set(v) { this._t = v; seen.push(v); }
  });
  const input = { dataset: { filesInput: 'p1' }, files, value: 'brief.pdf' };
  h.fire('change', only('[data-files-input]', input));
  await ticks(10);
  assert.deepEqual(uploaded, ['brief.pdf', 'scope.pdf']);
  assert.deepEqual(seen.slice(0, 2), ['Uploading 1 of 2: brief.pdf…', 'Uploading 2 of 2: scope.pdf…'],
    'each file’s own line, not squeezed out by the next before it could be read');
  assert.equal(seen.at(-1), '', 'cleared once the batch is done');
  assert.equal(h.toasts.filter(t => /^Uploading/.test(t)).length, 0, 'progress no longer spends the toast');
  assert.equal(h.toasts.at(-1), '2 files are on the project.');
});

test('the project\'s own activity loads, shows a retry when it fails, and is drawn again once it lands', () => {
  const failed = load({ activity: { state: 'failed', activity: [] } });
  const html = failed.panels.activityPanel(PROJECT);
  assert.match(html, /did not load/);
  assert.match(html, /data-project-activity-retry="p1"/);

  const loading = load({ activity: { state: 'loading', activity: [] } });
  assert.match(loading.panels.activityPanel(PROJECT), /Loading this project/);

  const empty = load({ activity: { state: 'ready', activity: [] } });
  assert.match(empty.panels.activityPanel(PROJECT), /Nothing yet/);

  const ready = load({ activity: { state: 'ready', activity: [{ id: 'a1', who: 'Sam Rivera', text: 'New task · Draft copy', when: 'Today' }] } });
  const html2 = ready.panels.activityPanel(PROJECT);
  assert.match(html2, /New task · Draft copy/);
  assert.match(html2, /id="project-activity-p1" tabindex="-1"/);
});

test('activity that did not load is asked for again from its own retry button, and the keyboard goes to the heading', () => {
  const retried = [];
  const h = load({ activity: { state: 'failed', activity: [] } });
  h.panels.activityPanel(PROJECT);
  h.workspaceStoreRetry = () => {};
  let focused = 0;
  h.heading('project-activity-p1', { focus: () => { focused += 1; } });
  h.fire('click', only('[data-project-activity-retry]', { dataset: { projectActivityRetry: 'p1' } }));
  assert.equal(focused, 1);
});

test('buttons say whom or which file they act on', () => {
  const h = load({ me: 'e-me' });
  const team = h.panels.teamPanel(PROJECT);
  assert.match(team, /aria-label="Take Jo Park off the team">Remove</);
  assert.match(team, /aria-label="Leave Northline site">Leave</);
  const files = h.panels.filesPanel(PROJECT);
  assert.match(files, /aria-label="Download brief\.pdf">Download</);
  assert.match(files, /aria-label="Remove brief\.pdf">Remove</);
});
