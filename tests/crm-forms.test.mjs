/* The CRM's dialogs, as crm-forms.js runs them: a new or changed company or
   contact checked the way the database would check it, a record it would
   clash with named before anything is written, one that only looks the same
   asked about first, an edit that saves only what the person changed, and a
   new company made for a contact kept when the contact is refused.
   crm-model.js is loaded beside it; the page's helpers and the store are
   stand-ins that keep what they are given. Loaded into a sandbox the way
   <script> tags run it. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const NORTHLINE = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const HARBOR = '7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c';
const ANA = '8b3c4d5e-6f70-4b81-9c9d-0e1f2a3b4c5d';
const BEN = '9c4d5e6f-7081-4c92-8dae-1f2a3b4c5d6e';
const ME = 'e1000000-0000-4000-8000-000000000001';
const MADE = 'a1000000-0000-4000-8000-000000000000';
const ADDED = 'c1000000-0000-4000-8000-000000000000';
const TEAM = [{ id: ME, name: 'Sam Rivera' }];
const TYPED = '<img src=x onerror=alert(1)>';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unescape = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* A company as queries.companies() hands it to the store, the row under `row`. */
function company(id, over = {}) {
  const row = { id, name: 'Northline', domain: 'northline.example', kind: 'client', stage: 'client', value: 12000, currency: 'EUR', owner_id: ME, notes: null, ...over };
  return { id, name: row.name, domain: row.domain || '', stage: 'Client', kind: 'Client', value: '€12,000', notes: row.notes || '', row };
}

/* A contact as queries.contacts() hands it over, their company embedded. */
function contact(id, name, email, at = null, over = {}) {
  const row = { id, full_name: name, email, phone: null, title: null, notes: null, company: at ? { id: at.id, name: at.name } : null, ...over };
  return { id, name, initial: name[0], company: at ? at.name : '—', email: email || '', notes: row.notes || '', row };
}

/* What a browser's FormData sends from the dialog showModal() was given: each
   input's value, each select's chosen option, each textarea's text. */
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
      hidden: selector === '[data-crm-company-name]', textContent: '', innerHTML: '', disabled: false, focused: 0,
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

/* An element a click lands on, with its data attributes. */
function target(attributes) {
  const dataset = Object.fromEntries(Object.entries(attributes).map(([name, value]) =>
    [name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));
  const element = { dataset };
  return { closest: selector => (selector.split(',').map(s => s.trim().replace(/^\[|\]$/g, '')).some(name => name in attributes) ? element : null) };
}

const lower = s => String(s ?? '').trim().toLowerCase();

/* refuse: 'company', 'contact', 'companyName' (more than one company by that
   name) or 'update' — which write the database refuses. */
function load({ companies = [], contacts = [], team = TEAM, loaded = true, parts = ['companies', 'contacts', 'team'], refuse = null } = {}) {
  const listeners = {};
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
    icon: name => `<svg data-icon="${name}"></svg>`,
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); form = dialog(body); context.modal.open = true; },
    modal: { open: true, close() { this.open = false; } },
    navigate: to => navigated.push(to),
    createForm: kind => created.push(kind),
    team,
    contacts,
    workspaceSession: { employee: { id: ME, role: 'employee', status: 'active' } },
    workspaceStore: {
      state: { loaded, companies },
      has: part => parts.includes(part),
      /* As store.js's after() does: a refusal is said in a toast unless the
         caller says it itself ({ toast: false }), and passed on. */
      after: (work, options) => Promise.resolve(work).catch(err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; })
    },
    workspaceActions: {
      createCompany: async fields => {
        writes.push(['createCompany', { ...fields }]);
        if (refusing === 'company') throw new Error('Could not add the company: permission denied');
        return { id: MADE, ...fields };
      },
      createContact: async fields => {
        writes.push(['createContact', { ...fields }]);
        if (refusing === 'contact') throw new Error('Could not add the contact: duplicate key value violates unique constraint');
        return { id: ADDED, full_name: fields.fullName };
      },
      /* create_contact_with_company (0053): matches p_company_name among the
         live companies by lower(btrim(name)), refuses more than one match,
         and otherwise makes a new one owned by the caller — all in the one
         call, so a refused contact leaves nothing behind to track or rename. */
      createContactWithCompany: async fields => {
        writes.push(['createContactWithCompany', { ...fields }]);
        if (refusing === 'contact') {
          throw Object.assign(new Error('Could not add the contact: A contact with that email address is already in the CRM.'), { conflictContactId: 'existing-1' });
        }
        if (refusing === 'offline') throw new Error('Failed to fetch');
        let companyId = fields.companyId || null;
        if (fields.companyName) {
          const matches = companies.filter(c => lower(c.name) === lower(fields.companyName));
          if (refusing === 'companyName' || matches.length > 1) {
            throw new Error(`Could not add the contact: More than one company is called "${fields.companyName}". Pick one of them.`);
          }
          if (matches.length === 1) {
            companyId = matches[0].id;
          } else {
            companyId = MADE;
            const row = { id: MADE, name: fields.companyName, domain: null, kind: 'prospect', stage: 'lead', value: null, currency: 'USD', owner_id: ME, notes: null };
            companies.push({ id: MADE, name: row.name, domain: '', stage: 'Lead', kind: 'Prospect', value: '—', notes: '', row });
          }
        }
        return { contactId: ADDED, companyId };
      },
      updateCompany: async (id, changes) => {
        writes.push(['updateCompany', id, { ...changes }]);
        /* 'update': no row came back, which touched() says as a refusal; 'offline': it never reached the database. */
        if (refusing === 'update') throw Object.assign(new Error('The company was not saved: it has been removed from the CRM, or you may not change it.'), { refused: true });
        if (refusing === 'offline') throw new Error('Failed to fetch');
        return { id };
      },
      updateContact: async (id, changes) => { writes.push(['updateContact', id, { ...changes }]); return { id }; },
      mergeCompanies: async (keep, drop) => {
        writes.push(['mergeCompanies', keep, drop]);
        if (refusing === 'merge') throw new Error('Only an owner or admin can merge companies.');
        return { kept_id: keep, merged_id: drop };
      },
      mergeContacts: async (keep, drop) => {
        writes.push(['mergeContacts', keep, drop]);
        if (refusing === 'merge') throw new Error('Only an owner or admin can merge contacts.');
        return { kept_id: keep, merged_id: drop };
      }
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => (form && form.id === id ? form : null)
    },
    FormData: class { constructor(f) { this.f = f; } entries() { return Object.entries(this.f.values); } }
  });
  context.window = context;
  for (const file of ['crm-model.js', 'dialog-forms.js', 'crm-forms.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  const clickOn = (node, more = {}) => (listeners.click || []).forEach(fn => fn({ target: node, preventDefault() {}, ...more }));
  return {
    click: attributes => clickOn(target(attributes)),
    clickOn,
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

test('a contact refused leaves nothing behind: a later attempt makes its company fresh rather than finding a ghost from before', async () => {
  const h = load({ refuse: 'contact' });
  h.create('crm');
  h.fill({ name: 'Ana Lima', email: 'ana@northline.example', companyId: 'new', company: 'Northline' });
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createContactWithCompany'], 'one call — company and contact together');
  assert.equal(h.part('.form-error').textContent, 'Could not add the contact: A contact with that email address is already in the CRM.');
  assert.equal(h.modal.open, true, 'the dialog stays open to fix and try again');
  h.refuse(null);
  h.fill({ email: 'ben@northline.example' });
  await h.submit();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1][1].companyName, 'Northline', 'the same company is asked for again — nothing was kept from the failed attempt to reuse or rename');
  assert.equal(h.toasts.at(-1), 'Ana Lima added.');
});

/* ── Companies ────────────────────────────────────────────────────────── */

test('a new company is checked the way the database checks one, saved in its currency, and opened', async () => {
  const h = load();
  h.click({ 'data-crm-new-company': '' });
  assert.equal(h.modals.length, 1);
  assert.match(h.body(), /<h2>New company<\/h2>/);
  assert.match(h.body(), new RegExp(`<option value="${ME}" selected>Sam Rivera</option>`), 'the signed-in person owns it unless changed');
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.equal(h.part('.form-error').textContent, 'A company needs a name.');
  assert.equal(h.part('[name="name"]').focused, 1);
  h.fill({ name: '  Harbor Studio ', domain: 'https://www.harbor.example/about', currency: 'eur', value: '12500.50', stage: 'qualified' });
  await h.submit();
  assert.deepEqual(h.writes, [['createCompany', {
    name: 'Harbor Studio', domain: 'harbor.example', kind: 'prospect', stage: 'qualified', value: 12500.5, currency: 'EUR', notes: null, ownerId: ME
  }]]);
  assert.equal(h.modal.open, false);
  assert.deepEqual(h.navigated, [`crm/companies/${MADE}`]);
  assert.equal(h.toasts.at(-1), 'Harbor Studio added.');
});

test('a company with a domain another has is refused and names it; one that only shares a name is asked about, then added', async () => {
  const h = load({ companies: [company(NORTHLINE)] });
  h.click({ 'data-crm-new-company': '' });
  h.fill({ name: 'Northline Two', domain: 'northline.example' });
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.equal(h.part('.form-error').textContent, 'Northline already has the same domain: change it, or open Northline instead.');
  assert.equal(h.part('[name="domain"]').focused, 1);
  assert.match(h.part('.form-candidates').innerHTML, new RegExp(`<a href="#crm/companies/${NORTHLINE}">Northline</a>`));
  h.fill({ name: 'Northline GmbH', domain: '' });
  await h.submit();
  assert.deepEqual(h.writes, [], 'asked first');
  assert.equal(h.part('.form-error').textContent, '');
  assert.match(h.part('.form-candidates').innerHTML, /Northline<\/a>: the same name/);
  assert.match(h.part('.form-candidates').innerHTML, /Press “Add company anyway” to go ahead\./);
  assert.equal(h.part('[type="submit"]').textContent, 'Add company anyway');
  assert.equal(h.part('[type="submit"]').focused, 1, 'the button that goes ahead has focus');
  assert.ok('aria-describedby' in h.part('[type="submit"]').attributes, 'and reads out the records it goes ahead past');
  assert.match(h.body(), /<div class="form-candidates" id="crm-company-form-candidates" role="status"><\/div>/);
  await h.submit();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][1].name, 'Northline GmbH');
});

test('a record that looks the same, brought in by a reload after the question was answered, is asked about too', async () => {
  const companies = [company(NORTHLINE)];
  const h = load({ companies });
  h.click({ 'data-crm-new-company': '' });
  h.fill({ name: 'Northline GmbH' });
  await h.submit();
  companies.push(company(HARBOR, { name: 'Northline AG', domain: null }));
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.match(h.part('.form-candidates').innerHTML, /Northline AG<\/a>/);
  await h.submit();
  assert.equal(h.writes.length, 1);
});

test('a question answered by changing what was typed goes: its box is emptied, and the button says what it does again', async () => {
  const h = load({ companies: [company(NORTHLINE)], refuse: 'company' });
  h.click({ 'data-crm-new-company': '' });
  h.fill({ name: 'Northline GmbH' });
  await h.submit();
  assert.equal(h.part('[type="submit"]').textContent, 'Add company anyway');
  h.fill({ name: 'Harbor Studio' });
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createCompany'], 'sent, and refused, so the dialog is still there to look at');
  assert.equal(h.part('.form-candidates').innerHTML, '', 'no question left showing');
  assert.equal(h.part('[type="submit"]').textContent, 'Add company');
  assert.equal('aria-describedby' in h.part('[type="submit"]').attributes, false);
});

test('a question already answered is asked again once the name it was about changes, even to one like the same record', async () => {
  const h = load({ companies: [company(NORTHLINE)] });
  h.click({ 'data-crm-new-company': '' });
  h.fill({ name: 'Northline GmbH' });
  await h.submit();
  h.fill({ name: 'Northline AG' });
  await h.submit();
  assert.deepEqual(h.writes, [], 'asked about again, for the name now typed');
  assert.equal(h.part('[type="submit"]').textContent, 'Add company anyway');
  await h.submit();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][1].name, 'Northline AG');
});

test('editing a company saves only what changed, to that company, and a form nobody changed saves nothing', async () => {
  const h = load({ companies: [company(NORTHLINE, { stage: 'proposal', notes: 'Met at the fair' })] });
  h.click({ 'data-crm-edit-company': NORTHLINE });
  assert.match(h.body(), /<h2>Edit Northline<\/h2>/);
  assert.match(h.body(), /<option value="proposal" selected>Proposal<\/option>/);
  assert.match(h.body(), /name="currency"[^>]*value="EUR"/);
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.equal(h.toasts.at(-1), 'Nothing changed.');
  h.click({ 'data-crm-edit-company': NORTHLINE.toUpperCase() });
  h.fill({ stage: 'client', value: '15000' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateCompany', NORTHLINE, { stage: 'client', value: 15000 }]]);
  assert.equal(h.toasts.at(-1), 'Northline saved.');
});

test('an edit saves only what the person changed, so a change someone made while the dialog was open is not undone', async () => {
  const lead = company(NORTHLINE, { stage: 'lead', value: 12000 });
  const companies = [lead];
  const people = [contact(ANA, 'Ana Lima', 'ana@northline.example', lead, { title: 'Producer', phone: '+31 20 000 0001' })];
  const h = load({ companies, contacts: people });
  h.click({ 'data-crm-edit-company': NORTHLINE });
  companies[0] = company(NORTHLINE, { stage: 'proposal', value: 20000 });
  h.fill({ notes: 'Call back in May' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateCompany', NORTHLINE, { notes: 'Call back in May' }]]);
  h.click({ 'data-crm-edit-contact': ANA });
  people[0] = contact(ANA, 'Ana Lima', 'ana@northline.example', lead, { title: 'Head of production', phone: '+31 20 000 0002' });
  h.fill({ notes: 'Prefers mail' });
  await h.submit();
  assert.deepEqual(h.writes.at(-1), ['updateContact', ANA, { notes: 'Prefers mail' }]);
});

test('a field nobody touched is neither saved nor judged by the rules, whatever it holds', async () => {
  const h = load({ companies: [company(NORTHLINE, { value: -500 })] });
  h.click({ 'data-crm-edit-company': NORTHLINE });
  await h.submit();
  assert.equal(h.toasts.at(-1), 'Nothing changed.');
  h.click({ 'data-crm-edit-company': NORTHLINE });
  h.fill({ notes: 'Credit note owed' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateCompany', NORTHLINE, { notes: 'Credit note owed' }]]);
});

test('a company edit the rules refuse says why, on the field it is about, and a currency stored before the rules is fixed with it', async () => {
  const h = load({ companies: [company(NORTHLINE, { currency: 'US$' })] });
  h.click({ 'data-crm-edit-company': NORTHLINE });
  h.fill({ domain: 'gmail.com' });
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.match(h.part('.form-error').textContent, /gmail\.com is a public mailbox/);
  assert.equal(h.part('[name="domain"]').focused, 1);
  assert.equal(h.part('[name="domain"]').attributes['aria-invalid'], 'true');
  h.fill({ domain: 'northline.example', stage: 'lost' });
  await h.submit();
  assert.match(h.part('.form-error').textContent, /currency, "US\$", is not a code/);
  assert.equal(h.part('[name="currency"]').focused, 1);
  assert.equal(h.part('[name="domain"]').attributes['aria-invalid'], undefined, 'no longer marked');
  assert.equal(h.part('[name="currency"]').attributes['aria-invalid'], 'true');
  h.fill({ currency: 'usd' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateCompany', NORTHLINE, { stage: 'lost', currency: 'USD' }]]);
});

test('a company renamed to look like another is asked about first', async () => {
  const h = load({ companies: [company(NORTHLINE), company(HARBOR, { name: 'Harbor', domain: 'harbor.example' })] });
  h.click({ 'data-crm-edit-company': HARBOR });
  h.fill({ name: 'Northline B.V.' });
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.match(h.part('.form-candidates').innerHTML, /Northline<\/a>: the same name/);
  await h.submit();
  assert.deepEqual(h.writes, [['updateCompany', HARBOR, { name: 'Northline B.V.' }]]);
  assert.equal(h.toasts.at(-1), 'Northline B.V. saved.');
});

test('a save the database refuses is said on the form, which stays open, and two quick sends write once', async () => {
  const h = load({ companies: [company(NORTHLINE)], refuse: 'update' });
  h.click({ 'data-crm-edit-company': NORTHLINE });
  h.fill({ stage: 'lost' });
  h.send();
  h.send();
  await settle();
  assert.equal(h.writes.length, 1, 'one write for two sends');
  assert.equal(h.modal.open, true, 'the dialog stays open');
  assert.equal(h.part('.form-error').textContent, 'The company was not saved: it has been removed from the CRM, or you may not change it.');
  assert.equal(h.part('[type="submit"]').disabled, false);
  assert.equal(h.part('[type="submit"]').focused, 1, 'focus is back on the button it left while it saved');
});

test('an edit is judged against what someone else changed meanwhile, and only what changed is checked against other records', async () => {
  const companies = [
    company(NORTHLINE, { domain: 'www.northline.example', currency: 'US$' }),
    company(HARBOR, { name: 'Harbor', domain: 'northline.example' })
  ];
  const h = load({ companies });
  h.click({ 'data-crm-edit-company': NORTHLINE });
  companies[0] = company(NORTHLINE, { domain: 'www.northline.example', currency: 'EUR' });
  h.fill({ notes: 'Prefers calls' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateCompany', NORTHLINE, { notes: 'Prefers calls' }]],
    'not refused for a currency someone else has fixed meanwhile');
  h.click({ 'data-crm-edit-company': NORTHLINE });
  h.fill({ name: 'Northline Group' });
  await h.submit();
  assert.deepEqual(h.writes.at(-1), ['updateCompany', NORTHLINE, { name: 'Northline Group' }], 'the domain it kept is not asked about');
});

test('the dialogs\' styles: a field not needed yet stays hidden, an error is red, and an empty list of matches stays a live region', () => {
  const css = readFileSync(new URL('../dist/workspace.css', import.meta.url), 'utf8');
  assert.match(css, /#modal-body \.form-field\[hidden\]\{display:none\}/, '.form-field\'s display would show it anyway');
  assert.match(css, /#modal-body \.form-pair\[hidden\]\{display:none\}/, 'nor would .form-pair\'s grid: New event\'s times, or its days, put away');
  assert.match(css, /#modal-body \.form-error\{color:#b94438/, 'not #modal-body p\'s grey');
  assert.match(css, /#modal-body \.form-candidates:empty\{padding:0;border:0;margin:0\}/);
  assert.doesNotMatch(css, /\.form-candidates:empty[^{]*\{display:none/, 'hidden, a live region is not read out as it fills');
});

test('when the team did not load the owner is still named for who it is, and No owner is saved as none', async () => {
  const h = load({ team: [], parts: ['companies', 'contacts'] });
  h.click({ 'data-crm-new-company': '' });
  assert.match(h.body(), new RegExp(`<option value="${ME}" selected>You</option>`));
  h.fill({ name: 'Harbor', ownerId: '' });
  await h.submit();
  assert.equal(h.writes[0][1].ownerId, null);
  const theirs = load({ team: [], parts: ['companies', 'contacts'], companies: [company(NORTHLINE, { owner_id: HARBOR })] });
  theirs.click({ 'data-crm-edit-company': NORTHLINE });
  assert.match(theirs.body(), new RegExp(`<option value="${HARBOR}" selected>The current owner \\(the team did not load\\)</option>`));
});

/* ── Contacts ─────────────────────────────────────────────────────────── */

test('a new contact needs a name and nothing else, and at a company in the CRM is filed under it by id', async () => {
  const northline = company(NORTHLINE);
  const h = load({ companies: [northline, company(HARBOR, { name: 'Harbor', domain: null })] });
  h.create('crm');
  assert.match(h.body(), /<h2>New contact<\/h2>/);
  assert.match(h.body(), new RegExp(`<option value="">No company</option><option value="${HARBOR}">Harbor</option><option value="${NORTHLINE}">Northline</option>`), 'companies by name');
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.equal(h.part('.form-error').textContent, 'A contact needs a name.');
  await h.submit();
  assert.equal(h.part('.form-error').textContent, `A contact needs a name.${String.fromCharCode(160)}`, 'said again, so it is read out again');
  h.fill({ name: 'Ben Ortiz' });
  await h.submit();
  assert.deepEqual(h.writes, [['createContactWithCompany',
    { fullName: 'Ben Ortiz', companyId: null, companyName: null, email: null, phone: null, title: null, notes: null }]]);
  assert.deepEqual(h.navigated, [`crm/${ADDED}`]);
  assert.equal(h.toasts.at(-1), 'Ben Ortiz added.');

  const at = load({ companies: [northline] });
  at.create('crm');
  at.fill({ name: 'Ana Lima', email: 'Ana@Northline.example', companyId: NORTHLINE });
  await at.submit();
  assert.deepEqual(at.writes, [['createContactWithCompany',
    { fullName: 'Ana Lima', companyId: NORTHLINE, companyName: null, email: 'ana@northline.example', phone: null, title: null, notes: null }]]);
});

test('the new company\'s name is asked for only when a new company is picked', () => {
  const h = load();
  h.create('crm');
  assert.match(h.body(), /<label class="form-field" data-crm-company-name hidden>/);
  const choice = h.part('[data-crm-company-choice]');
  choice.value = 'new';
  choice.listeners.change();
  assert.equal(h.part('[data-crm-company-name]').hidden, false);
  choice.value = '';
  choice.listeners.change();
  assert.equal(h.part('[data-crm-company-name]').hidden, true);
});

test('a contact at a new company is added with it in one call, and an address someone has stops it before anything is written', async () => {
  const h = load({ contacts: [contact(ANA, 'Ana Lima', 'ana@northline.example')] });
  h.create('crm');
  h.fill({ name: 'Ben Ortiz', companyId: 'new', company: ' ' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Give the new company a name, or pick one.');
  assert.equal(h.part('[name="company"]').focused, 1);
  h.fill({ name: 'Ana L.', email: 'ANA@northline.example', company: 'Northline' });
  await h.submit();
  assert.deepEqual(h.writes, []);
  assert.equal(h.part('.form-error').textContent, 'Ana Lima already has the same email address: change it, or open Ana Lima instead.');
  assert.equal(h.part('[name="email"]').focused, 1);
  h.fill({ name: 'Ben Ortiz', email: 'ben@northline.example' });
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createContactWithCompany'], 'one call — no spare company can be left behind by the other failing');
  assert.equal(h.writes[0][1].companyName, 'Northline');
  assert.equal(h.writes[0][1].companyId, null);
  assert.deepEqual(h.navigated, [`crm/${ADDED}`]);
});

test('a contact refused for a duplicate address is said as one, not the database\'s own words, and a retry sends the same company again', async () => {
  const h = load({ refuse: 'contact' });
  h.create('crm');
  h.fill({ name: 'Ana Lima', email: 'ana@northline.example', companyId: 'new', company: 'Northline' });
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createContactWithCompany']);
  assert.equal(h.part('.form-error').textContent, 'Could not add the contact: A contact with that email address is already in the CRM.');
  assert.equal(h.modal.open, true);
  assert.equal(h.part('[type="submit"]').disabled, false);
  h.refuse(null);
  h.fill({ email: 'ana2@northline.example' });
  await h.submit();
  assert.deepEqual(h.writes.map(([what]) => what), ['createContactWithCompany', 'createContactWithCompany']);
  assert.equal(h.writes[1][1].companyName, 'Northline');
});

test('more than one company already sharing the new company\'s name, found only once the database is asked, is said as the database says it', async () => {
  const h = load({ refuse: 'companyName' });
  h.create('crm');
  h.fill({ name: 'Ana Lima', companyId: 'new', company: 'Northline' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Could not add the contact: More than one company is called "Northline". Pick one of them.');
  assert.equal(h.writes.length, 1);
});

test('a new company at the same domain as another already in the CRM is refused and names it, exactly as the New company dialog\'s own domain field would', async () => {
  const northline = company(NORTHLINE, { name: 'Northline', domain: 'northline.example' });
  const h = load({ companies: [northline] });
  h.create('crm');
  h.fill({ name: 'Ben Ortiz', email: 'ben@northline.example', companyId: 'new', company: 'Northline Studio' });
  await h.submit();
  assert.deepEqual(h.writes, [], 'blocked before anything is sent');
  assert.equal(h.part('.form-error').textContent, 'Northline already has the same domain: change it, or open Northline instead.');
  assert.match(h.part('.form-candidates').innerHTML, new RegExp(`<a href="#crm/companies/${NORTHLINE}">Northline</a>`));
  assert.equal(h.part('[name="company"]').focused, 1, 'the dialog has no domain field of its own to focus — the company name is the one naming it');
  h.fill({ email: 'ben@gmail.com' });
  await h.submit();
  assert.equal(h.writes.length, 1, 'a public mailbox names no domain, so this one goes through unblocked');
});

test('editing a contact saves only what changed, and a contact whose company left the CRM keeps it unless another is picked', async () => {
  const northline = company(NORTHLINE);
  const ana = contact(ANA, 'Ana Lima', 'ana@northline.example', northline, { title: 'Producer' });
  const ben = contact(BEN, 'Ben Ortiz', 'ben@harbor.example', null, { company: { id: HARBOR, name: 'Harbor' } });
  const h = load({ companies: [northline], contacts: [ana, ben] });
  h.click({ 'data-crm-edit-contact': ANA });
  assert.match(h.body(), /<h2>Edit Ana Lima<\/h2>/);
  assert.doesNotMatch(h.body(), /A new company…/, 'a new company comes with a new contact only');
  h.fill({ title: 'Head of production', phone: '+31 20 123 4567' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateContact', ANA, { phone: '+31 20 123 4567', title: 'Head of production' }]]);
  assert.equal(h.toasts.at(-1), 'Ana Lima saved.');

  h.click({ 'data-crm-edit-contact': BEN });
  assert.match(h.body(), new RegExp(`<option value="${HARBOR}" selected>Current company \\(no longer in the CRM\\)</option>`));
  h.fill({ notes: 'Moved on' });
  await h.submit();
  assert.deepEqual(h.writes.at(-1), ['updateContact', BEN, { notes: 'Moved on' }], 'the company is not taken away');

  h.click({ 'data-crm-edit-contact': BEN });
  h.fill({ email: 'ana@northline.example' });
  await h.submit();
  assert.equal(h.writes.length, 2);
  assert.equal(h.part('.form-error').textContent, 'Ana Lima already has the same email address: change it, or open Ana Lima instead.');
});

test('clearing the new company\'s name on a retry asks for one again, and switching away from a new company altogether sends none', async () => {
  const h = load({ refuse: 'contact' });
  h.create('crm');
  h.fill({ name: 'Ana Lima', companyId: 'new', company: 'Northline' });
  await h.submit();
  assert.equal(h.writes.length, 1);
  h.refuse(null);
  h.fill({ company: ' ' });
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Give the new company a name, or pick one.');
  assert.equal(h.writes.length, 1, 'nothing more is written');
  h.fill({ companyId: '' });
  await h.submit();
  assert.equal(h.writes.at(-1)[1].companyId, null);
  assert.equal(h.writes.at(-1)[1].companyName, null);
  assert.equal(h.toasts.at(-1), 'Ana Lima added.');
});

test('an answer that never arrived while adding a contact is said as plainly as any other refusal, and the dialog stays open to try again', async () => {
  const h = load({ refuse: 'offline' });
  h.create('crm');
  h.fill({ name: 'Ana Lima', companyId: 'new', company: 'Northline' });
  await h.submit();
  assert.equal(h.writes.length, 1);
  assert.equal(h.part('.form-error').textContent, 'Failed to fetch.');
  assert.equal(h.modal.open, true);
});

/* ── Merging companies and contacts (0053) ─────────────────────────────── */

test('Merge lists every other company, never itself, and needs one picked', async () => {
  const northline = company(NORTHLINE, { name: 'Northline' });
  const harbor = company(HARBOR, { name: 'Harbor' });
  const h = load({ companies: [northline, harbor] });
  h.click({ 'data-crm-merge-company': NORTHLINE });
  assert.match(h.body(), /<h2>Merge into Northline<\/h2>/);
  assert.match(h.body(), new RegExp(`<option value="${HARBOR}">Harbor</option>`));
  assert.doesNotMatch(h.body(), new RegExp(`<option value="${NORTHLINE}">`), 'not itself');
  await h.submit();
  assert.equal(h.part('.form-error').textContent, 'Pick the company to merge in.');
  assert.deepEqual(h.writes, []);
  h.fill({ dropId: HARBOR });
  await h.submit();
  assert.deepEqual(h.writes, [['mergeCompanies', NORTHLINE, HARBOR]]);
  assert.equal(h.toasts.at(-1), 'Harbor merged into Northline.');
  assert.equal(h.modal.open, false);
});

test('Merge on a contact lists every other contact, and a refusal (owners and admins only) is said on the dialog', async () => {
  const northline = company(NORTHLINE);
  const ana = contact(ANA, 'Ana Lima', 'ana@northline.example', northline);
  const ben = contact(BEN, 'Ben Ortiz', 'ben@northline.example', northline);
  const h = load({ companies: [northline], contacts: [ana, ben], refuse: 'merge' });
  h.click({ 'data-crm-merge-contact': ANA });
  assert.match(h.body(), /<h2>Merge into Ana Lima<\/h2>/);
  assert.match(h.body(), new RegExp(`<option value="${BEN}">Ben Ortiz</option>`));
  h.fill({ dropId: BEN });
  await h.submit();
  assert.deepEqual(h.writes, [['mergeContacts', ANA, BEN]]);
  assert.equal(h.part('.form-error').textContent, 'Only an owner or admin can merge contacts.');
  assert.equal(h.modal.open, true, 'stays open so a manager watching can see why it did not go');
});

test('the Merge button is offered on a company\'s page and on a contact\'s', () => {
  const northline = company(NORTHLINE, { name: 'Northline' });
  const ana = contact(ANA, 'Ana Lima', 'ana@northline.example', northline);
  const h = load({ companies: [northline], contacts: [ana] });
  h.click({ 'data-crm-merge-company': 'not-loaded' });
  assert.equal(h.toasts.at(-1), 'That company is no longer in the CRM.');
  h.click({ 'data-crm-merge-contact': 'not-loaded' });
  assert.equal(h.toasts.at(-1), 'That contact is no longer in the CRM.');
});

/* ── Around the dialogs ───────────────────────────────────────────────── */

test('Add contact, wherever it is pressed, opens this dialog, and every other create goes where it went', () => {
  const h = load();
  h.create('crm');
  h.create('tickets');
  h.create('overview');
  assert.equal(h.modals.length, 1);
  assert.equal(h.modals[0].eyebrow, 'CRM · NEW CONTACT');
  assert.deepEqual(h.created, ['tickets', 'overview']);
});

test('Add person on a company\'s page opens the contact dialog with that company chosen', () => {
  const h = load({ companies: [company(NORTHLINE), company(HARBOR, { name: 'Harbor', domain: null })] });
  h.click({ 'data-crm-new-contact': NORTHLINE });
  assert.match(h.body(), new RegExp(`<option value="${NORTHLINE}" selected>Northline</option>`));
  assert.equal(h.form().values.companyId, NORTHLINE);
});

test('the dialogs wait for the workspace, and a record no longer there says so', () => {
  const loading = load({ loaded: false });
  loading.click({ 'data-crm-new-company': '' });
  loading.create('crm');
  assert.equal(loading.modals.length, 0);
  assert.deepEqual(loading.toasts, ['Not yet: the workspace is still loading.', 'Not yet: the workspace is still loading.']);

  const h = load({ companies: [company(NORTHLINE)] });
  h.click({ 'data-crm-edit-company': HARBOR });
  h.click({ 'data-crm-edit-contact': ANA });
  assert.equal(h.modals.length, 0);
  assert.deepEqual(h.toasts, ['That company is no longer in the CRM.', 'That contact is no longer in the CRM.']);
});

test('a record a dialog names opens its page and the dialog closes, but not when it opens in a new tab', () => {
  const h = load();
  const link = { closest: selector => (selector === '.form-candidates a' ? {} : null) };
  h.clickOn(link, { metaKey: true });
  assert.equal(h.modal.open, true, 'what was typed is still there');
  h.clickOn(link);
  assert.equal(h.modal.open, false);
});

test('what anyone typed stays text in the dialogs and in what they ask', async () => {
  const evil = company(NORTHLINE, { name: TYPED, domain: null, notes: `</textarea>${TYPED}` });
  const person = contact(ANA, TYPED, 'ana@northline.example', evil, { title: '"><script>alert(1)</script>', notes: `</textarea>${TYPED}` });
  const h = load({ companies: [evil], contacts: [person] });
  h.click({ 'data-crm-edit-company': NORTHLINE });
  h.click({ 'data-crm-edit-contact': ANA });
  h.create('crm');
  assert.equal(h.modals.length, 3);
  for (const { body } of h.modals) {
    assert.doesNotMatch(body, /<img src=x|<script>|"><script|<\/textarea><img/i);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/, 'shown as what was typed');
  }
  h.click({ 'data-crm-new-company': '' });
  h.fill({ name: TYPED });
  await h.submit();
  assert.doesNotMatch(h.part('.form-candidates').innerHTML, /<img src=x/);
  assert.match(h.part('.form-candidates').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;<\/a>/);
});
