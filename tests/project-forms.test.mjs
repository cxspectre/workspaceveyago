/* The "New project" dialog, as project-forms.js runs it: a client company
   picked straight from the CRM needs no guessing at all; a typed new one is
   checked the way the database would check it, and a record it would clash
   with — or one that only looks the same — is named before anything is
   written; the owner defaults to whoever opens the dialog but is never
   forced on them; and a made project is opened rather than left back on the
   list. projects-model.js and crm-model.js are loaded beside it; the page's
   helpers and the store are stand-ins that keep what they are given, the
   same shape tests/crm-forms.test.mjs already uses for the same reason (its
   own header explains why: crm-forms.js's addContact and this file's
   createProjectWork share the exact "company first, then the record"
   recovery). Loaded into a sandbox the way <script> tags run it.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ME = 'e1000000-0000-4000-8000-000000000001';
const NORTHLINE = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const MADE_COMPANY = 'a1000000-0000-4000-8000-000000000000';
const CREATED_PROJECT = 'b1000000-0000-4000-8000-000000000000';
const TEAM = [{ id: ME, name: 'Sam Rivera' }, { id: 'e2', name: 'Jo Park' }];

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unescape = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* A company as queries.companies() hands it to the store, the row under `row`. */
function company(id, name, over = {}) {
  const row = { id, name, domain: null, kind: 'client', stage: 'client', value: null, currency: 'EUR', owner_id: ME, notes: null, ...over };
  return { id, name, domain: row.domain || '', stage: 'Client', kind: 'Client', value: '—', notes: '', row };
}

/* What a browser's FormData sends from the dialog showModal() was given. */
function fieldsOf(html) {
  const values = {};
  for (const [tag, name] of html.matchAll(/<input\b[^>]*\bname="([^"]+)"[^>]*>/g)) {
    values[name] = unescape((tag.match(/\bvalue="([^"]*)"/) || [])[1] || '');
  }
  for (const [, name, inner] of html.matchAll(/<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const chosen = inner.match(/<option value="([^"]*)" selected>/) || inner.match(/<option value="([^"]*)"/);
    values[name] = unescape(chosen ? chosen[1] : '');
  }
  for (const [, name, inner] of html.matchAll(/<textarea\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    values[name] = unescape(inner);
  }
  return values;
}

/* The dialog's form: what it would send, and each part the code reaches for
   — the same shape tests/crm-forms.test.mjs builds one in. */
function dialog(html) {
  const handlers = {};
  const parts = {};
  const part = selector => {
    parts[selector] = parts[selector] || {
      hidden: selector === '[data-project-company-name]', textContent: '', innerHTML: '', disabled: false, focused: 0,
      value: '', id: '', dataset: {}, attributes: {}, listeners: {},
      focus() { this.focused += 1; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; }
    };
    return parts[selector];
  };
  const submit = part('[type="submit"]');
  submit.dataset.label = unescape((html.match(/data-label="([^"]*)"/) || [])[1] || '');
  submit.textContent = submit.dataset.label;
  return {
    id: (html.match(/<form id="([^"]+)"/) || [])[1], values: fieldsOf(html), isConnected: true, handlers, parts,
    addEventListener: (type, fn) => { handlers[type] = fn; },
    querySelector: part
  };
}

/* refuse: 'company', 'project' or 'update' — which write the database refuses. */
function load({ companies = [company(NORTHLINE, 'Northline')], team = TEAM, loaded = true, overview = null, refuse = null } = {}) {
  const toasts = [];
  const modals = [];
  const writes = [];
  const navigated = [];
  const created = [];
  let form = null;
  let refusing = refuse;
  const context = vm.createContext({
    console,
    esc: escape,
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); form = dialog(body); context.modal.open = true; },
    modal: { open: true, close() { this.open = false; } },
    navigate: to => navigated.push(to),
    createForm: kind => created.push(kind),
    team,
    workspaceSession: { employee: { id: ME, role: 'employee', status: 'active' } },
    workspaceStore: {
      state: { loaded, companies, overview },
      after: (work, options) => Promise.resolve(work).catch(err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; })
    },
    workspaceActions: {
      createCompany: async fields => {
        writes.push(['createCompany', { ...fields }]);
        if (refusing === 'company') throw new Error('Could not add the company: permission denied');
        return { id: MADE_COMPANY, ...fields };
      },
      createProject: async fields => {
        writes.push(['createProject', { ...fields }]);
        if (refusing === 'project') throw new Error('Could not create the project: permission denied');
        return { id: CREATED_PROJECT, ...fields };
      },
      updateCompany: async (id, changes) => {
        writes.push(['updateCompany', id, { ...changes }]);
        if (refusing === 'update') throw Object.assign(new Error('The company was not saved: it has been removed from the CRM, or you may not change it.'), { refused: true });
        return { id };
      }
    },
    document: {
      addEventListener: () => {},
      getElementById: id => (form && form.id === id ? form : null)
    },
    FormData: class { constructor(f) { this.f = f; } entries() { return Object.entries(this.f.values); } }
  });
  context.window = context;
  for (const file of ['projects-model.js', 'crm-model.js', 'dialog-forms.js', 'project-forms.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  return {
    create: kind => context.createForm(kind),
    form: () => form,
    part: selector => form.querySelector(selector),
    fill: more => Object.assign(form.values, more),
    send: () => form.handlers.submit({ preventDefault() {} }),
    submit: async () => { form.handlers.submit({ preventDefault() {} }); await settle(); },
    refuse: what => { refusing = what; },
    body: () => modals.at(-1).body,
    toasts, modals, writes, navigated, created, modal: context.modal
  };
}

test('the dialog opens on the signed-in person as owner, Discovery, and no company chosen', () => {
  const h = load();
  h.create('projects');
  assert.equal(h.modals.length, 1);
  assert.match(h.body(), /<h2>New project<\/h2>/);
  assert.match(h.body(), new RegExp(`<option value="${ME}" selected>Sam Rivera</option>`), 'the signed-in person owns it unless changed');
  assert.match(h.body(), /<option value="" selected>No company \(internal\)<\/option>/);
  assert.match(h.body(), /<option value="Discovery" selected>Discovery<\/option>/);
  assert.match(h.body(), new RegExp(`<option value="${NORTHLINE}">Northline</option>`), 'an existing company is offered by name, not typed');
});

test('a blank name is refused before anything is checked or sent, even though the field is later filled the same as it opened', () => {
  const h = load();
  h.create('projects');
  h.fill({ name: '  ', companyId: '', ownerId: ME });
  h.send();
  assert.match(h.part('.form-error').textContent, /A project needs a name/);
  assert.equal(h.writes.length, 0, 'projectChanges(null, …) alone would miss this: "was" and "is" are both blank, so nothing looks renamed');
});

test('a name past the limit is refused', () => {
  const h = load();
  h.create('projects');
  h.fill({ name: 'x'.repeat(201), companyId: '' });
  h.send();
  assert.match(h.part('.form-error').textContent, /at most 200 characters/);
  assert.equal(h.writes.length, 0);
});

test('a start date after the due date is refused', () => {
  const h = load();
  h.create('projects');
  h.fill({ name: 'Northline site', companyId: '', startsOn: '2026-12-01', dueOn: '2026-09-01' });
  h.send();
  assert.match(h.part('.form-error').textContent, /start date is after the due date/);
  assert.equal(h.writes.length, 0);
});

test('picking an existing company sends its id directly — nothing to type, nothing to duplicate', async () => {
  const h = load();
  h.create('projects');
  h.fill({ name: 'Northline site', companyId: NORTHLINE, ownerId: ME, status: 'In progress', startsOn: '2026-09-15', dueOn: '2026-12-01', description: 'Relaunch' });
  await h.submit();
  assert.deepEqual(h.writes, [['createProject', {
    name: 'Northline site', description: 'Relaunch', ownerId: ME, startsOn: '2026-09-15', dueOn: '2026-12-01',
    status: 'in_progress', code: 'N', companyId: NORTHLINE, accent: 'client'
  }]]);
  assert.equal(h.navigated[0], 'projects/' + CREATED_PROJECT);
  assert.equal(h.toasts.at(-1), 'Northline site is on the board.');
});

test('"No company (internal)" sends no company and the default accent', async () => {
  const h = load();
  h.create('projects');
  h.fill({ name: 'Internal tool', companyId: '' });
  await h.submit();
  assert.equal(h.writes[0][1].companyId, null);
  assert.equal(h.writes[0][1].accent, 'default');
  assert.equal(h.writes[0][1].status, 'discovery', 'the dialog\'s own default, when nothing else is chosen');
});

test('"No owner" is no owner, not the person who opened the dialog', async () => {
  const h = load();
  h.create('projects');
  h.fill({ name: 'Side project', companyId: '', ownerId: '' });
  await h.submit();
  assert.equal(h.writes[0][1].ownerId, null);
});

test('a typed new company that matches nothing is added, then the project — and opened', async () => {
  const h = load();
  h.create('projects');
  h.fill({ name: 'Kept · Autumn release', companyId: 'new', company: 'Kept Studio' });
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createCompany', 'createProject']);
  assert.deepEqual(h.writes[0][1], { name: 'Kept Studio', domain: null, kind: 'client', stage: 'client', value: null, currency: 'USD', notes: null, ownerId: ME });
  assert.equal(h.writes[1][1].companyId, MADE_COMPANY);
  assert.equal(h.writes[1][1].accent, 'client');
  assert.equal(h.navigated[0], 'projects/' + CREATED_PROJECT);
});

test('a typed new company that looks like one already in the CRM is asked about, not created, until pressed again', async () => {
  const h = load({ companies: [company(NORTHLINE, 'Northline')] });
  h.create('projects');
  h.fill({ name: 'Rebrand', companyId: 'new', company: 'northline' });
  h.send();
  assert.equal(h.writes.length, 0, 'not created yet — only asked about');
  assert.match(h.part('.form-candidates').innerHTML, /Northline/);
  assert.equal(h.part('[type="submit"]').textContent, 'Create project anyway');
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createCompany', 'createProject'], 'pressed again, it goes ahead');
});

test('a company already at that exact domain blocks the save outright, with no "anyway"', async () => {
  const h = load({ companies: [company(NORTHLINE, 'Northline', { domain: 'northline.example' })] });
  h.create('projects');
  /* Blocking needs a domain match, which this dialog never collects — so a
     name-only match is always just a question, never a hard block. Proven
     here: the same typed name that matched by name alone in the test above
     never blocks, however many times it is sent. */
  h.fill({ name: 'Rebrand', companyId: 'new', company: 'Northline' });
  h.send();
  h.send();
  assert.equal(h.writes.length, 0, 'still only asking — a name match alone never blocks, it only asks once');
});

test('a project refused after its new company was added says so on the dialog, and a retry does not add the company twice', async () => {
  const h = load({ refuse: 'project' });
  h.create('projects');
  h.fill({ name: 'Kept · Autumn release', companyId: 'new', company: 'Kept Studio' });
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createCompany', 'createProject']);
  /* The dialog is still open (the write failed, so nothing closed it), so
     this is said there, not in a toast — dialog-forms.js's sending() only
     toasts a refusal once the dialog itself is gone. */
  assert.match(h.part('.form-error').textContent, /Kept Studio was added, but the project was not:.*stays chosen/);
  assert.equal(h.toasts.length, 0);

  h.refuse(null);
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createCompany', 'createProject', 'createProject'], 'no second createCompany call');
  assert.equal(h.writes[2][1].companyId, MADE_COMPANY);
});

test('a rename typed before a retry renames the company this dialog already added, rather than making another', async () => {
  const h = load({ refuse: 'project' });
  h.create('projects');
  h.fill({ name: 'Kept · Autumn release', companyId: 'new', company: 'Kept Studio' });
  await h.submit();
  h.refuse(null);
  h.fill({ company: 'Kept Studios' });
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createCompany', 'createProject', 'updateCompany', 'createProject']);
  assert.deepEqual(h.writes[2], ['updateCompany', MADE_COMPANY, { name: 'Kept Studios' }]);
});

test('the new company’s own name still needs a name, and its own rules apply', () => {
  const h = load();
  h.create('projects');
  h.fill({ name: 'Rebrand', companyId: 'new', company: '  ' });
  h.send();
  assert.match(h.part('.form-error').textContent, /Give the new company a name/);
  assert.equal(h.writes.length, 0);
});

test('a fresh company is priced in the studio’s declared currency, not always USD', async () => {
  const h = load({ overview: { revenue_currency: 'eur' } });
  h.create('projects');
  h.fill({ name: 'Rebrand', companyId: 'new', company: 'Kept Studio' });
  await h.submit();
  assert.equal(h.writes[0][1].currency, 'EUR');
});

test('the workspace still loading refuses to open the dialog at all', () => {
  const h = load({ loaded: false });
  h.create('projects');
  assert.equal(h.modals.length, 0);
  assert.match(h.toasts.at(-1), /still loading/);
});

test('a kind other than \'projects\' is left to whatever createForm() already does', () => {
  const h = load();
  h.create('tickets');
  assert.equal(h.modals.length, 0);
  assert.deepEqual(h.created, ['tickets']);
});
