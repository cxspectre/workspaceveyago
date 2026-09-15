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

/* actions: the workspaceActions a test needs. picks and inputs: what
   document.querySelectorAll finds for "Add files" buttons and file inputs. */
function load({ manager = true, me = 'e-me', actions = {} } = {}) {
  const listeners = {};
  const toasts = [];
  const picks = [];
  const inputs = [];
  const context = vm.createContext({
    console,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    icon: () => '<svg></svg>',
    toast: message => toasts.push(message),
    render: () => {},
    showModal: () => {},
    projects: [PROJECT],
    contacts: [],
    team: TEAM,
    workspaceStore: {
      state: { loaded: true, projectMembers: MEMBERS, projectContacts: [], projectFiles: FILES, projectBudgets: [] },
      after: promise => promise
    },
    workspaceSession: { isManager: () => manager, employee: { id: me } },
    workspaceActions: actions,
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      querySelectorAll: selector => (selector === '[data-files-pick]' ? picks : selector === '[data-files-input]' ? inputs : []),
      getElementById: () => null
    }
  });
  context.window = context;
  for (const file of ['projects-model.js', 'project-panels.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  const fire = (type, target) => (listeners[type] || []).forEach(fn => fn({ type, target, preventDefault() {} }));
  return { panels: vm.runInContext('projectPanels', context), fire, toasts, picks, inputs };
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

test('buttons say whom or which file they act on', () => {
  const h = load({ me: 'e-me' });
  const team = h.panels.teamPanel(PROJECT);
  assert.match(team, /aria-label="Take Jo Park off the team">Remove</);
  assert.match(team, /aria-label="Leave Northline site">Leave</);
  const files = h.panels.filesPanel(PROJECT);
  assert.match(files, /aria-label="Download brief\.pdf">Download</);
  assert.match(files, /aria-label="Remove brief\.pdf">Remove</);
});
