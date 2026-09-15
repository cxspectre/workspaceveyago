/* The oldest layer of workspace.js's click and change handlers: what is left
   once writes.js (which loads first, and always stops the events it knows how
   to save for real) has had its turn. A record edit or a task tick that
   writes.js does not yet cover must not claim it saved anything — that was
   the "Updated in this demo session" bug — and a star toggle that nothing
   renders any more (data-star, superseded by mail.js's own data-mail-star)
   should not still be here pretending to work. Run from the repo root with:
   node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const WORKSPACE = readFileSync(new URL('../dist/workspace.js', import.meta.url), 'utf8').split('\n');
function take(prefix) {
  const found = WORKSPACE.filter(line => line.startsWith(prefix));
  assert.equal(found.length, 1, `workspace.js has one line starting ${prefix}`);
  return found[0];
}

function load() {
  const toasts = [];
  const renders = [];
  const listeners = {};
  const tickets = [{ id: 1, title: 'Original ticket' }];
  const projects = [{ id: 'p1', name: 'Original project', tasks: ['Task one'] }];
  const contacts = [{ id: 'c1', name: 'Original contact' }];
  const context = vm.createContext({
    console,
    tickets, projects, contacts,
    render: () => renders.push(true),
    toast: message => toasts.push(message),
    activityRecord: () => {},
    repaintKeepingFocus: () => {},
    redrawPreservingFocus: () => {},
    queries: {},
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      body: { classList: { toggle: () => {} } }
    },
    localStorage: { setItem: () => {} },
    window: {}
  });
  context.window = context;
  vm.runInContext(take('document.addEventListener(\'click\',e=>{const view='), context);
  vm.runInContext(take('document.addEventListener(\'change\',e=>{const target='), context);
  const fire = (type, target) => (listeners[type] || []).forEach(fn => fn({ target, preventDefault() {}, stopImmediatePropagation() {} }));
  return { fire, toasts, renders, tickets, projects, contacts };
}

/* A change writes.js has not claimed: today only data-record-kind="crm" and
   data-record-kind="projects" with a field other than "status" are unclaimed
   (see tests/queries.test.mjs and tests/ticket-writes.test.mjs for what IS
   claimed) — this stands in for either, and for a task tick reaching here at
   all, which only happens if window.workspaceStore itself is missing. */
function target(attrs) {
  return { dataset: attrs, matches: selector => Object.keys(attrs).some(key => selector.includes(`[data-${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`)) };
}

test('a record change that nothing has claimed touches nothing, redraws the real value back, and never claims it saved', () => {
  const h = load();
  const contactBefore = { ...h.contacts[0] };
  h.fire('change', target({ recordKind: 'crm', recordId: 'c1', field: 'stage' }));
  assert.deepEqual(h.contacts[0], contactBefore, 'no field on the record is written just because a select changed');
  assert.equal(h.renders.length, 1, 'the field is redrawn back to what it really is');
  assert.ok(h.toasts.length, 'something is said, so a developer notices the gap');
  assert.doesNotMatch(h.toasts[0], /demo session|Updated/i, 'never claims a save that did not happen');
});

test('a task tick that nothing has claimed (workspaceStore missing) leaves the task untouched and says so', () => {
  const h = load();
  const before = { ...h.projects[0] };
  h.fire('change', target({ projectTask: 'p1', task: '0' }));
  assert.deepEqual(h.projects[0], before, 'no status is invented for the task');
  assert.doesNotMatch((h.toasts[0] || ''), /completed|reopened/i, 'never claims the tick was saved');
});

test('a preference toggle still really saves — the one real feature in this handler', () => {
  const h = load();
  h.fire('change', { id: 'compact-setting', checked: true, matches: () => false });
  assert.deepEqual(h.toasts, ['Preference updated']);
});

test('a star click no longer does anything — nothing renders data-star any more (mail.js uses data-mail-star)', () => {
  const h = load();
  const clicked = { closest: selector => (selector === '[data-star]' ? { dataset: { star: '0' } } : null) };
  assert.doesNotThrow(() => h.fire('click', clicked));
  assert.deepEqual(h.renders, [], 'a selector nothing renders is not wired to anything any more');
});
