/* The page's script order, which several fixes depend on and nothing else
   would notice breaking. Classic scripts share one global scope and run in
   document order, so:

   - data/writes.js binds its capture-phase listeners before app.js and
     workspace.js bind theirs. Capture listeners on one node fire in the order
     they were added, so moving writes.js below them sends status changes,
     ticks and notes back to the offline handlers ("Updated in this demo
     session") — and every other test would still pass.
   - the models load before the views that call them at load time.
   - store.js loads last: it splices live rows into the arrays app.js declares.

   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const order = [...html.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
const at = name => {
  const index = order.indexOf(name);
  assert.ok(index >= 0, `${name} is on the page`);
  return index;
};

test('writes.js binds before the offline handlers in app.js and workspace.js', () => {
  assert.ok(at('data/writes.js') < at('app.js'));
  assert.ok(at('data/writes.js') < at('workspace.js'));
});

test('the models load before the views that use them', () => {
  assert.ok(at('mail-model.js') < at('mail-compose.js'));
  assert.ok(at('mail-compose.js') < at('mail.js'), 'mail.js renders with the composer as soon as it runs');
  assert.ok(at('projects-model.js') < at('workspace.js'));
  assert.ok(at('overview-model.js') < at('app.js'), 'app.js draws the Overview and the menu as soon as it runs');
  assert.ok(at('agenda-model.js') < at('app.js'), 'app.js paints the Overview and the bell with the agenda\'s rules as it runs');
  assert.ok(at('finance-model.js') < at('app.js'), 'the bell and the search box shape invoices as soon as app.js runs');
  assert.ok(at('finance-model.js') < at('workspace.js'));
  assert.ok(at('shell-model.js') < at('app.js'), 'the bell is painted with the menu');
  assert.ok(at('projects-model.js') < at('projects-ui.js'));
  assert.ok(at('workspace.js') < at('projects-ui.js'), 'the project page is drawn by workspace.js, its actions added by projects-ui.js');
  assert.ok(at('projects-model.js') < at('project-panels.js'), 'the panels read the model as soon as they load');
  assert.ok(at('data/mail-html.js') < at('mail-compose.js'));
  assert.ok(at('tickets-model.js') < at('tickets-ui.js'), 'the queue reads the model as soon as it is drawn');
  assert.ok(at('workspace.js') < at('tickets-ui.js'), 'tickets-ui.js replaces the queue and page workspace.js drew');
  assert.ok(at('finance-model.js') < at('finance-ui.js'), 'Finance reads the model as soon as it is drawn');
  assert.ok(at('workspace.js') < at('finance-ui.js'), 'finance-ui.js draws with the page helpers workspace.js defines');
  assert.ok(at('crm-model.js') < at('crm-ui.js'), 'the CRM figures read the model as soon as they are worked out');
  assert.ok(at('finance-model.js') < at('crm-ui.js'), 'the pipeline value is written the way Finance writes money');
  assert.ok(at('workspace.js') < at('crm-ui.js'), 'crm-ui.js draws the CRM with the page helpers workspace.js defines');
  assert.ok(at('projects-model.js') < at('crm-ui.js'), 'a contact\'s role on a project is named the way the project page names it');
  assert.ok(at('crm-model.js') < at('crm-forms.js'), 'the CRM dialogs check what they save with the model');
  assert.ok(at('dialog-forms.js') < at('crm-forms.js'), 'the CRM dialogs take their shared helpers as they load');
  assert.ok(at('dialog-forms.js') < at('finance-ui.js'), 'Finance\'s dialogs use the shared helpers');
  assert.ok(at('app.js') < at('crm-forms.js'), 'crm-forms.js replaces the Add contact form app.js defines');
  assert.ok(at('projects-model.js') < at('project-forms.js'), 'the New project dialog checks what it saves with the model');
  assert.ok(at('crm-model.js') < at('project-forms.js'), 'the New project dialog asks about a look-alike company the way the CRM does');
  assert.ok(at('dialog-forms.js') < at('project-forms.js'), 'the New project dialog takes its shared helpers as it loads');
  assert.ok(at('app.js') < at('project-forms.js'), 'project-forms.js replaces the New project form app.js defines');
  assert.ok(at('project-panels.js') < at('project-forms.js'), 'both draw a project page\'s own bits, loaded together');
  assert.ok(at('tasks-model.js') < at('tasks-ui.js'), 'tasks-ui.js reads the model as it loads');
  assert.ok(at('dialog-forms.js') < at('tasks-ui.js'), 'the task dialogs take their shared helpers as tasks-ui.js loads');
  assert.ok(at('dialog-forms.js') < at('notes-ui.js'), 'the note dialogs take their shared helpers as notes-ui.js loads');
  assert.ok(at('tasks-model.js') < at('notes-ui.js'), 'notes-ui.js reads who may change a note from the task model as it loads');
  assert.ok(at('tasks-ui.js') < at('workspace.js'), 'workspace.js draws a project\'s tasks as it runs when the address is a project\'s');
  assert.ok(at('agenda-model.js') < at('agenda-ui.js'), 'agenda-ui.js works out the week it opens on as it loads');
  assert.ok(at('workspace.js') < at('agenda-ui.js'), 'agenda-ui.js replaces the agenda workspace.js drew');
  assert.ok(at('agenda-ui.js') < at('event-edit.js'), 'event-edit.js asks agenda-ui.js who may change an event');
  assert.ok(at('dialog-forms.js') < at('event-edit.js'), 'the event dialog takes its shared helpers as event-edit.js loads');
  assert.ok(at('app.js') < at('event-edit.js'), 'event-edit.js takes New event over from the createForm app.js defines');
  assert.ok(at('dialog-forms.js') < at('agenda-ui.js'), 'the Remove event dialog takes its shared helpers as agenda-ui.js loads');
});

test('who may open the workspace is decided before the session and the gate ask', () => {
  assert.ok(at('data/access.js') < at('data/session.js'), 'session.js reads accessModel as soon as it runs');
  assert.ok(at('data/session.js') < at('data/gate.js'), 'the gate needs the session it guards');
});

test('the loading rules are there before the store reads them', () => {
  assert.ok(at('data/load-model.js') < at('data/store.js'));
  assert.ok(at('agenda-model.js') < at('data/store.js'), 'the store picks the weeks of events to load by the agenda\'s rules');
});

test('store.js loads last, after every array it fills', () => {
  assert.equal(order[order.length - 1], 'data/store.js');
});

/* A model or view module that a script on the page calls must be on the page
   itself. store.js once read the agenda's rules before agenda-model.js was on
   it, and the workspace never finished loading — with every other test green,
   since the store's own tests load the model beside it. Comments are blanked
   first: a note about a module is not a call to it. */
test('every model and view module the page calls is defined by a script on the page', () => {
  const code = src => readFileSync(new URL(`../dist/${src}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const defined = new Set(order.flatMap(src => [...code(src).matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|^\s*window\.([A-Za-z_$][\w$]*)\s*=/gm)]
    .map(m => m[1] || m[2])));
  const missing = order.flatMap(src => [...new Set([...code(src).matchAll(/(?<![\w$.'"])([a-z][A-Za-z]*(?:Model|Ui))\./g)].map(m => m[1]))]
    .filter(name => !defined.has(name))
    .map(name => `${src} calls ${name}`));
  assert.deepEqual(missing, []);
});

/* The helpers crm-ui.js draws with come from app.js and data/queries.js. One
   renamed or removed there throws as the CRM is drawn, and the page stays
   blank — while crm-ui's own tests, which stand in for them, stay green. */
test('the helpers the CRM draws with are defined by a script on the page', () => {
  const code = src => readFileSync(new URL(`../dist/${src}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const page = order.map(code).join('\n');
  const crm = code('crm-ui.js');
  for (const name of ['isManagerNow', 'financeDay']) {
    assert.match(crm, new RegExp(`\\b${name}\\(`), `crm-ui.js draws with ${name}`);
    assert.match(page, new RegExp(`^\\s*(?:(?:const|let|var)\\s+${name}\\s*=|function\\s+${name}\\s*\\()`, 'm'), `${name} is defined on the page`);
  }
  assert.match(crm, /\bworkspaceData\.initials\b/, 'crm-ui.js draws with workspaceData.initials');
  assert.match(code('data/queries.js'), /window\.workspaceData\s*=\s*\{\s*initials:\s*initials\b/, 'workspaceData.initials is defined on the page');
});

/* The breadcrumb and the tab's title name an event opened by its link that the
   weeks loaded do not hold — a past meeting from a client's page — once the
   store has fetched it. workspace.js's render hands crumb() the store's
   askEvent for that; without it the page showed the meeting under "Not found",
   while overview-model's own tests stayed green. */
test('the breadcrumb is handed the store\'s lookup for an event asked for by its id', () => {
  const code = readFileSync(new URL('../dist/workspace.js', import.meta.url), 'utf8');
  assert.match(code, /overviewModel\.crumb\([^;]*\bevent:\s*id\s*=>\s*window\.workspaceStore\s*&&\s*typeof workspaceStore\.askEvent\s*===\s*'function'\s*\?\s*workspaceStore\.askEvent\(id\)\s*:\s*null\s*\}\)/);
});

/* A script with a syntax error does not run at all, and the page quietly falls
   back to whatever ran before it — Mail once showed the old demo inbox that
   way, with every other test green. */
test('every script on the page parses', () => {
  for (const src of order) {
    const code = readFileSync(new URL(`../dist/${src}`, import.meta.url), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code, { filename: src }), `${src} does not parse`);
  }
});

test('every script carries the same cache-busting version', () => {
  const versions = new Set([...html.matchAll(/\.(?:js|css)\?v=(\d+)/g)].map(m => m[1]));
  assert.equal(versions.size, 1, `one version for all assets, found ${[...versions].join(', ')}`);
});
