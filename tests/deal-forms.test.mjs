/* The pipeline's dialogs, as deal-forms.js runs them: a new or changed deal
   checked the way the database would check it, closing one recording both the
   outcome and the day it closed, reopening one clearing both, and an edit that
   saves only what the person changed. deals-model.js and crm-model.js are
   loaded beside it; the page's helpers and the store are stand-ins that keep
   what they are given. Loaded into a sandbox the way <script> tags run it.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* A zone east of UTC, where its midnight and UTC's are different moments: a
   day picked in the Close dialog is stored as the viewer's own. */
process.env.TZ = 'Europe/Amsterdam';

const TODAY = '2026-09-15';
const NORTHLINE = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const HARBOR = '7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c';
const OPEN = '8b3c4d5e-6f70-4b81-9c9d-0e1f2a3b4c5d';
const WON = '9c4d5e6f-7081-4c92-8dae-1f2a3b4c5d6e';
const ME = 'e1000000-0000-4000-8000-000000000001';
const MADE = 'a1000000-0000-4000-8000-000000000000';
const TEAM = [{ id: ME, name: 'Sam Rivera' }];
const TYPED = '<img src=x onerror=alert(1)>';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unescape = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* A company as queries.companies() hands it to the store. */
const company = (id, name) => ({
  id, name, domain: '', stage: 'Lead', kind: 'Prospect', value: '—', notes: '',
  row: { id, name, domain: null, kind: 'prospect', stage: 'lead', value: null, currency: 'USD', notes: null }
});

/* A deal as queries.deals() hands it to the store. */
const deal = (id, title, over = {}) => {
  const row = {
    id, company_id: NORTHLINE, title, stage: 'proposal', value: 12000, currency: 'EUR', owner_id: ME,
    expected_close: '2026-11-30', outcome: null, closed_at: null, notes: null, created_at: '2026-09-01T00:00:00Z', ...over
  };
  return { id, title, stage: 'Proposal', value: '€12,000', row };
};

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

/* The dialog's form: what it would send, and each part the code reaches for. */
function dialog(html) {
  const handlers = {};
  const parts = {};
  const part = selector => {
    parts[selector] = parts[selector] || {
      hidden: false, textContent: '', innerHTML: '', disabled: false, focused: 0, readOnly: false,
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
    querySelector: part,
    querySelectorAll: () => []
  };
}

/* An element a click lands on, with its data attributes. */
function target(attributes) {
  const dataset = Object.fromEntries(Object.entries(attributes).map(([name, value]) =>
    [name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));
  const element = { dataset };
  return { closest: selector => (selector.split(',').map(s => s.trim().replace(/^\[|\]$/g, '')).some(name => name in attributes) ? element : null) };
}

/* refuse: 'create', 'update' or 'delete' — which write the database refuses. */
function load({ companies = [company(NORTHLINE, 'Northline'), company(HARBOR, 'Harbor & Co')], deals = [],
  team = TEAM, loaded = true, manager = true, parts = ['companies', 'deals', 'team'], refuse = null } = {}) {
  const listeners = {};
  const toasts = [];
  const modals = [];
  const writes = [];
  let form = null;
  let refusing = refuse;
  const context = vm.createContext({
    console,
    esc: escape,
    icon: name => `<svg data-icon="${name}"></svg>`,
    financeDay: () => TODAY,
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); form = dialog(body); context.modal.open = true; },
    modal: { open: true, close() { this.open = false; } },
    navigate: () => {},
    team,
    workspaceSession: { employee: { id: ME, role: 'owner', status: 'active' }, isManager: () => manager },
    workspaceStore: {
      state: { loaded, companies, deals },
      has: part => parts.includes(part),
      mark: () => 1,
      loadedSince: () => true,
      /* As store.js's after() does: a refusal is said in a toast unless the
         caller says it itself ({ toast: false }), and passed on. */
      after: (work, options) => Promise.resolve(work).catch(err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; })
    },
    workspaceActions: {
      createDeal: async fields => {
        writes.push(['createDeal', { ...fields }]);
        if (refusing === 'create') throw new Error('Could not add the deal: permission denied');
        return { id: MADE, ...fields };
      },
      updateDeal: async (id, changes) => {
        writes.push(['updateDeal', id, { ...changes }]);
        if (refusing === 'update') throw new Error('The deal was not saved: it has been removed, or you may not change it.');
        return { id };
      },
      deleteDeal: async id => {
        writes.push(['deleteDeal', id]);
        if (refusing === 'delete') throw new Error('The deal was not removed: it has been removed already, or only an owner or admin can remove one.');
      }
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => (form && form.id === id ? form : null)
    },
    FormData: class { constructor(f) { this.f = f; } entries() { return Object.entries(this.f.values); } }
  });
  context.window = context;
  for (const file of ['crm-model.js', 'deals-model.js', 'dialog-forms.js', 'deal-forms.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  return {
    click: attributes => (listeners.click || []).forEach(fn => fn({ target: target(attributes), preventDefault() {} })),
    form: () => form,
    part: selector => form.querySelector(selector),
    fill: more => Object.assign(form.values, more),
    submit: async () => { form.handlers.submit({ preventDefault() {} }); await settle(); },
    refuse: what => { refusing = what; },
    body: () => modals.at(-1).body,
    toasts, modals, writes, modal: context.modal
  };
}

/* ── Adding a deal ────────────────────────────────────────────────────── */

test('a new deal opens filled in with the database\'s defaults, the studio\'s companies and the signed-in person as owner', () => {
  const h = load();
  h.click({ 'data-deal-new': '' });
  assert.equal(h.modals.length, 1);
  assert.equal(h.modals[0].eyebrow, 'CRM · NEW DEAL');
  assert.match(h.body(), /<h2>New deal<\/h2>/);
  assert.match(h.body(), new RegExp(`<option value="${ME}" selected>Sam Rivera</option>`), 'the signed-in person owns it unless changed');
  assert.match(h.body(), /<option value="lead" selected>Lead<\/option>/, 'a deal starts at the first stage');
  assert.match(h.body(), /<select name="companyId" required><option value="">Pick a company…<\/option>/,
    'nothing is picked for them: a deal is always for a company somebody chose');
  assert.doesNotMatch(h.body(), /name="outcome"/, 'won and lost are their own dialog, never a field on this one');
  assert.match(h.body(), /Harbor &amp; Co/, 'every company is a choice, by name');
});

test('New deal from a company\'s own page arrives with that company already picked', () => {
  const h = load();
  h.click({ 'data-deal-new': HARBOR.toUpperCase() });
  assert.match(h.body(), new RegExp(`<option value="${HARBOR}" selected>Harbor &amp; Co</option>`),
    'an id written in capitals is the same company: the database writes uuids in lower case');
});

test('a new deal is checked the way the database checks one, and saved', async () => {
  const h = load();
  h.click({ 'data-deal-new': '' });
  h.fill({ companyId: '', title: 'Retainer renewal' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Pick the company this deal is for.');
  assert.equal(h.writes.length, 0);

  h.fill({ companyId: NORTHLINE, title: '   ' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'A deal needs a name.');

  h.fill({ title: 'Retainer renewal', value: 'twelve thousand' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'That value is not an amount.');

  h.fill({ value: '12.500,50', currency: 'Euro' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Pick a currency, like EUR or USD.');

  h.fill({ currency: 'eur', expectedClose: '30-11-2026' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'That is not a date, like 2026-11-30.');

  h.fill({ expectedClose: '2026-11-30' });
  await h.submit();
  assert.deepEqual(h.writes, [['createDeal', {
    companyId: NORTHLINE, title: 'Retainer renewal', stage: 'lead', value: 12500.5,
    currency: 'EUR', ownerId: ME, expectedClose: '2026-11-30', notes: null
  }]]);
  assert.equal(h.toasts.at(-1), 'Retainer renewal added.');
  assert.equal(h.modal.open, false, 'the dialog closes once the database has it');
});

test('a new deal the database refuses says so on the form, and the dialog stays open to fix', async () => {
  const h = load({ refuse: 'create' });
  h.click({ 'data-deal-new': '' });
  h.fill({ companyId: NORTHLINE, title: 'Renewal' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Could not add the deal: permission denied.');
  assert.equal(h.modal.open, true);
});

test('nothing opens before the workspace has loaded, or while the deals have not', () => {
  const loading = load({ loaded: false });
  loading.click({ 'data-deal-new': '' });
  assert.equal(loading.modals.length, 0);
  assert.equal(loading.toasts.at(-1), 'Not yet: the workspace is still loading.');

  const noDeals = load({ parts: ['companies', 'team'] });
  noDeals.click({ 'data-deal-new': '' });
  assert.equal(noDeals.modals.length, 0);
  assert.equal(noDeals.toasts.at(-1), 'Deals did not load. They are tried again by themselves.');

  const noCompanies = load({ companies: [] });
  noCompanies.click({ 'data-deal-new': '' });
  assert.equal(noCompanies.modals.length, 0);
  assert.equal(noCompanies.toasts.at(-1), 'Add a company first: a deal is always for one.');
});

/* ── Editing a deal ───────────────────────────────────────────────────── */

test('an edit opens filled in from the deal, and saves only what the person changed', async () => {
  const open = deal(OPEN, 'Retainer renewal');
  const h = load({ deals: [open] });
  h.click({ 'data-deal-edit': OPEN });
  assert.equal(h.modals[0].eyebrow, 'CRM · DEAL');
  assert.match(h.body(), /<h2>Edit Retainer renewal<\/h2>/);
  assert.match(h.body(), new RegExp(`<option value="${NORTHLINE}" selected>Northline</option>`));
  assert.match(h.body(), /<option value="proposal" selected>Proposal<\/option>/);
  assert.match(h.body(), /name="expectedClose" value="2026-11-30"/);
  await h.submit();
  assert.equal(h.toasts.at(-1), 'Nothing changed.', 'a save that changes nothing writes nothing');
  assert.equal(h.writes.length, 0);

  h.fill({ stage: 'qualified', value: '15000' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateDeal', OPEN, { stage: 'qualified', value: 15000 }]],
    'only the two fields that changed, not every field the form holds');
  assert.equal(h.toasts.at(-1), 'Retainer renewal saved.');
});

test('an edit cannot close a deal or reopen one, however the form is filled in', async () => {
  const h = load({ deals: [deal(OPEN, 'Renewal')] });
  h.click({ 'data-deal-edit': OPEN });
  h.fill({ outcome: 'won', closedAt: '2026-09-14', title: 'Renewal 2027' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateDeal', OPEN, { title: 'Renewal 2027' }]]);
});

test('a deal that is no longer on the board says so rather than opening a dialog onto nothing', () => {
  const h = load({ deals: [deal(OPEN, 'Renewal')] });
  h.click({ 'data-deal-edit': 'not-a-real-id' });
  assert.equal(h.modals.length, 0);
  assert.equal(h.toasts.at(-1), 'That deal is no longer on the board.');
});

test('a title typed with markup in it is written as text, never as markup', () => {
  const h = load({ deals: [deal(OPEN, TYPED)] });
  h.click({ 'data-deal-edit': OPEN });
  assert.match(h.body(), /<h2>Edit &lt;img src=x onerror=alert\(1\)&gt;<\/h2>/);
  assert.doesNotMatch(h.body(), /<img/i);
});

/* ── Won or lost ──────────────────────────────────────────────────────── */

test('closing a deal records which way it went and the day it went, on the viewer\'s own clock', async () => {
  const h = load({ deals: [deal(OPEN, 'Renewal')] });
  h.click({ 'data-deal-close': OPEN });
  assert.equal(h.modals[0].eyebrow, 'CRM · CLOSE A DEAL');
  assert.match(h.body(), /<h2>How did Renewal go\?<\/h2>/);
  assert.match(h.body(), /It keeps the stage it is at now, Proposal/, 'the dialog says the stage is kept, which is the history');
  assert.match(h.body(), new RegExp(`name="closedOn" required value="${TODAY}"`), 'today, until the person says otherwise');
  await h.submit();
  assert.deepEqual(h.writes, [['updateDeal', OPEN, { outcome: 'won', closed_at: '2026-09-14T22:00:00.000Z' }]]);
  assert.equal(h.toasts.at(-1), 'Renewal marked won.');
  assert.equal(h.modal.open, false);
});

test('a deal can be closed on a day that is not today, and the stage is never among what is written', async () => {
  const h = load({ deals: [deal(OPEN, 'Renewal')] });
  h.click({ 'data-deal-close': OPEN });
  h.fill({ outcome: 'lost', closedOn: '2026-08-01' });
  await h.submit();
  const [, , changes] = h.writes[0];
  assert.deepEqual(changes, { outcome: 'lost', closed_at: '2026-07-31T22:00:00.000Z' });
  assert.equal('stage' in changes, false);
});

test('closing a deal with no day, or a half-typed one, says so on the form and writes nothing', async () => {
  const h = load({ deals: [deal(OPEN, 'Renewal')] });
  h.click({ 'data-deal-close': OPEN });
  h.fill({ closedOn: '' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Pick the day the deal closed.');
  assert.equal(h.writes.length, 0);

  h.fill({ closedOn: 'sometime' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Pick the day the deal closed. ',
    'said again, and the no-break space is what makes a live region read it out twice');
  assert.equal(h.writes.length, 0);
});

test('a deal already closed opens on the day it closed, and is corrected the other way but not to the same way', async () => {
  const h = load({ deals: [deal(WON, 'Rebrand', { outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })] });
  h.click({ 'data-deal-close': WON });
  assert.match(h.body(), /name="closedOn" required value="2026-09-10"/, 'the day on record, not today');
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'That deal is already won.');
  assert.equal(h.writes.length, 0);

  h.fill({ outcome: 'lost' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateDeal', WON, { outcome: 'lost', closed_at: '2026-09-09T22:00:00.000Z' }]],
    'a deal recorded the wrong way round is corrected, keeping the day it actually closed');
});

test('reopening clears the outcome and the date together, the only way the database allows either', () => {
  const h = load({ deals: [deal(WON, 'Rebrand', { outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })] });
  h.click({ 'data-deal-reopen': WON });
  assert.deepEqual(h.writes, [['updateDeal', WON, { outcome: null, closed_at: null }]]);
});

test('reopening a deal says so, and a refusal is said the way every other CRM write says one', async () => {
  const h = load({ deals: [deal(WON, 'Rebrand', { outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })] });
  h.click({ 'data-deal-reopen': WON });
  await settle();
  assert.equal(h.toasts.at(-1), 'Rebrand is back in the pipeline.');

  const refused = load({ deals: [deal(WON, 'Rebrand', { outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })], refuse: 'update' });
  refused.click({ 'data-deal-reopen': WON });
  await settle();
  assert.equal(refused.toasts.at(-1), 'The deal was not saved: it has been removed, or you may not change it.');
});

test('reopening a deal that is already open changes nothing and says why', async () => {
  const h = load({ deals: [deal(OPEN, 'Renewal')] });
  h.click({ 'data-deal-reopen': OPEN });
  await settle();
  assert.deepEqual(h.writes, []);
  assert.equal(h.toasts.at(-1), 'That deal is already open.');
});

/* ── Removing a deal ──────────────────────────────────────────────────── */

test('removing a deal asks first, names what stays behind, and then removes it', async () => {
  const h = load({ deals: [deal(OPEN, 'Renewal')] });
  h.click({ 'data-deal-delete': OPEN });
  assert.equal(h.modals[0].eyebrow, 'CRM · REMOVE');
  assert.match(h.body(), /<h2>Remove Renewal\?<\/h2>/);
  assert.match(h.body(), /Northline keeps every other deal it has/);
  assert.doesNotMatch(h.body(), /anyway/, 'nothing here to press past by mistake');
  await h.submit();
  assert.deepEqual(h.writes, [['deleteDeal', OPEN]]);
  assert.equal(h.toasts.at(-1), 'Renewal is removed.');
});

test('a removal the database refuses says so on the form, and the deal stays', async () => {
  const h = load({ deals: [deal(OPEN, 'Renewal')], refuse: 'delete' });
  h.click({ 'data-deal-delete': OPEN });
  await h.submit();
  assert.equal(h.part('.form-error').textContent,
    'The deal was not removed: it has been removed already, or only an owner or admin can remove one.');
  assert.equal(h.modal.open, true);
});

/* ── What every write asks the store for again ────────────────────────── */

test('a deal write asks only for the deals again, never the whole workspace', async () => {
  const asked = [];
  const h = load({ deals: [deal(OPEN, 'Renewal')] });
  /* after() is the store's; what matters is the `only` each caller passes,
     which is read from the dialogs themselves rather than guessed here. */
  const source = readFileSync(new URL('../dist/deal-forms.js', import.meta.url), 'utf8');
  for (const [, only] of source.matchAll(/only:\s*(\[[^\]]*\])/g)) asked.push(only);
  assert.ok(asked.length >= 4, 'every write scopes its reload');
  assert.deepEqual([...new Set(asked)], ["['deals']"],
    'a deal write changes no company, contact, ticket or invoice, so nothing else is asked for');
  assert.equal(h.writes.length, 0);
});
