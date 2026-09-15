/* The CRM, as crm-ui.js draws it: its figures, the pipeline of companies, the
   companies and contacts lists, and each company's and contact's page. Each
   company once however many people work there, every stage in its column, no
   total across currencies, everything found by id rather than by a matching
   name, a contact's invoices the ones sent to their own address, and what did
   not load saying so. The page helpers are workspace.js's own, loaded from the
   file; the store's lists and app.js's few globals are stand-ins. Loaded into a
   sandbox the way <script> tags run it, beside the models it reads.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Today is decided on the viewer's clock (financeDay()): a zone east of UTC,
   where its midnight and UTC's are different moments. */
process.env.TZ = 'Europe/Amsterdam';

const TODAY = '2026-09-15';
const U1 = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const U2 = '7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c';
const U3 = '8b3c4d5e-6f70-4b81-9c9d-0e1f2a3b4c5d';
const TYPED = '<img src=x onerror=alert(1)>';
const MARKUP = /<img/i;
const STAGES = ['lead', 'qualified', 'proposal', 'client', 'dormant', 'lost'];
const EVERYTHING = ['contacts', 'companies', 'invoices', 'mail', 'team', 'projectContacts', 'notes'];

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNotFound = html => /This record is unavailable\./.test(html);

/* The page helpers crm-ui.js draws with, as workspace.js defines them: from
   `const matches` to notFound(). */
const HELPERS = (() => {
  const lines = readFileSync(new URL('../dist/workspace.js', import.meta.url), 'utf8').split('\n');
  const from = lines.findIndex(line => line.startsWith('const matches'));
  const to = lines.findIndex(line => line.startsWith('function notFound(){'));
  assert.ok(from >= 0 && to > from, 'the page helpers are where this test looks for them in workspace.js');
  return lines.slice(from, to + 1).join('\n');
})();

/* The page as it runs: workspace.js's helpers, the models and crm-ui.js, with
   the store's lists and app.js's globals as stand-ins. */
function load({ route = ['crm'], query = '', contacts = [], companies = [], loaded = EVERYTHING,
  projects = [], projectContacts = [], tickets = [], invoices = [], mails = [], team = [], manager = true, overview = null,
  events = [], projectEvents = [], past = {}, notes = {}, viewer = null, drafts = null } = {}) {
  /* What the page asked the store for past meetings, and asked again. */
  const pastAsked = [];
  const retried = [];
  const listeners = {};
  /* What was given the keyboard, by id. */
  const focused = [];
  let renders = 0;
  const context = vm.createContext({
    console,
    esc: escape,
    icon: name => `<svg data-icon="${name}"></svg>`,
    pill: (label, tone) => `<span class="pill${tone ? ' ' + tone : ''}">${escape(label)}</span>`,
    page: 'crm',
    navs: [['crm', 'CRM']],
    queries: { crm: query },
    recordNotes: { tickets: {}, projects: {}, crm: {}, agenda: {}, companies: {}, ...notes },
    workspaceSession: viewer ? { employee: viewer } : undefined,
    /* The words notes-ui.js keeps for each note box, by kind and record. */
    noteDrafts: drafts ? { get: (kind, id) => drafts[`${kind}|${id}`] || '' } : undefined,
    workspaceActivity: [],
    workspaceData: { initials: name => (String(name).trim()[0] || '?').toUpperCase() },
    financeDay: () => TODAY,
    isManagerNow: () => manager,
    mailModel: {
      ALL: 'all',
      mailRoute: ({ mailbox, folder, threadId }) => ['mail', mailbox, folder, threadId].join('/'),
      folderForThread: (thread, fallback) => thread.folder || fallback
    },
    routeParts: route,
    contacts, projects, tickets, invoices, mails, team, events,
    workspaceStore: {
      has: part => loaded.includes(part),
      state: { companies, projectContacts, overview, projectEvents },
      pastMeetings: (key, filter) => {
        pastAsked.push([key, JSON.parse(JSON.stringify(filter))]);
        return past[key] || { state: 'loading', meetings: [], more: false };
      },
      retryPastMeetings: key => retried.push(key)
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => ({ focus: () => focused.push(id) })
    },
    render: () => { renders += 1; },
    crmView: () => 'the page app.js drew'
  });
  context.window = context;
  vm.runInContext(HELPERS, context);
  for (const file of ['overview-model.js', 'finance-model.js', 'projects-model.js', 'crm-model.js', 'tasks-model.js', 'agenda-model.js', 'crm-ui.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  /* A click on an element with these data attributes. */
  const click = attributes => {
    const dataset = Object.fromEntries(Object.entries(attributes).map(([name, value]) =>
      [name.replace(/^data-/, '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), value]));
    const element = { dataset };
    const target = { closest: selector => (Object.keys(attributes).some(name => selector === `[${name}]`) ? element : null) };
    (listeners.click || []).forEach(fn => fn({ target, preventDefault() {} }));
  };
  return { context, view: () => context.crmView(), pastAsked, retried, click, focused, renders: () => renders };
}

const base = load();
const ui = vm.runInContext('crmUi', base.context);
const finance = vm.runInContext('financeModel', base.context);
const ROLE = vm.runInContext('projectsModel.CONTACT_ROLES[0]', base.context);
const money = (amount, currency) => finance.money(amount, currency);

/* A company as queries.companies() hands it to the store: the row under `row`,
   beside text already formatted for the page. */
let made = 0;
function company(stage, value, currency = 'USD', over = {}) {
  made += 1;
  const row = { id: `company-${made}`, name: `Company ${made}`, domain: null, kind: 'prospect', stage, value, currency, owner_id: null, notes: null, ...over };
  return { id: row.id, name: row.name, domain: row.domain || '', stage: stage[0].toUpperCase() + stage.slice(1), kind: 'Prospect', value: `${value} ${currency}`, notes: row.notes || '', row };
}

/* A contact as queries.contacts() hands it over, at `at` — a company() — or at
   none, with the company embedded the way the query embeds it. */
function contact(name, email, at = null, over = {}) {
  const embedded = at ? { id: at.id, name: at.name, stage: at.row.stage, value: at.row.value, currency: at.row.currency } : null;
  const row = { id: `contact-${name}`, full_name: name, email, phone: null, title: null, notes: null, company: embedded, ...over };
  return { id: row.id, name, initial: name[0], company: at ? at.name : '—', email, notes: row.notes || '', row };
}

/* An invoice as queries.invoices() hands it to the store. */
function invoice(over = {}) {
  const row = {
    id: U1, number: 'INV-1042', client: 'Northline', client_email: 'ana@northline.example', amount: '1200', currency: 'EUR',
    status: 'sent', issued_on: '2026-09-01', due_on: '2026-09-30', paid_on: null, notes: null, ...over
  };
  return { id: row.number, uuid: row.id, client: row.client, description: '', amount: '€1,200', status: 'Sent', row };
}
const shaped = over => finance.shapeInvoice(invoice(over), TODAY);

function figure(stats, label) {
  const found = [...stats].find(item => item[0] === label);
  assert.ok(found, `${label} is in the strip`);
  return { value: found[1], caption: found[2] };
}

/* The part of the board between a column's heading and the next column. */
const column = (html, stage) => html.split(`<h2 id="crm-stage-${stage}">`)[1].split('<section')[0];
const bodyRows = html => html.split('<tbody>')[1].split('</tbody>')[0].split('<tr>').filter(Boolean);

/* ── The figures ──────────────────────────────────────────────────────── */

test('a company\'s page offers Edit company and Add person, a contact\'s Edit contact, and every list New company', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const ana = contact('Ana', 'ana@northline.example', northline, { id: U2 });
  const lists = { companies: [northline], contacts: [ana] };
  const page = load({ ...lists, route: ['crm', 'companies', U1] }).view();
  assert.match(page, new RegExp(`data-crm-edit-company="${U1}"`));
  assert.match(page, new RegExp(`data-crm-new-contact="${U1}"`));
  assert.match(load({ ...lists, route: ['crm', U2] }).view(), new RegExp(`data-crm-edit-contact="${U2}"`));
  for (const route of [['crm'], ['crm', 'companies'], ['crm', 'contacts']]) {
    assert.match(load({ ...lists, route }).view(), /data-crm-new-company/, route.join('/'));
  }
});

test('a company\'s notes are on its Activity & notes tab, and its overview lists the meetings filed under it, its projects or its people', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const ana = contact('Ana', 'ana@northline.example', northline, { id: U2 });
  const site = { id: 'p1', name: 'Northline site', status: 'In progress', companyId: U1, row: { id: 'p1', company_id: U1 } };
  const meeting = (id, title, startsAt, over) => ({
    id, title, when: startsAt.slice(5, 10), row: { id, starts_at: startsAt, project_id: null, company_id: null, contact_id: null, ...over }
  });
  const kickoff = meeting('e1', 'Kickoff', '2026-09-17T12:00:00Z', { project_id: 'p1' });
  const call = meeting('e2', 'Call with Ana', '2026-09-16T08:00:00Z', { contact_id: U2 });
  const dentist = meeting('e3', 'Dentist', '2026-09-16T10:00:00Z');
  const review = meeting('e4', 'Design review', '2026-10-02T07:00:00Z', { company_id: U1 });
  const lists = { companies: [northline], contacts: [ana], projects: [site], events: [kickoff, call, dentist], projectEvents: [review, kickoff] };
  const page = load({ ...lists, route: ['crm', 'companies', U1] }).view();
  assert.deepEqual([...page.matchAll(/href="#agenda\/(e\d)"/g)].map(m => m[1]), ['e2', 'e1', 'e4'],
    'in the order they start, each once, and nobody else\'s');
  assert.match(page, /<small>09-16<\/small>/, 'each says when');
  assert.match(page, new RegExp(`href="#crm/companies/${U1}/activity"`));
  const notes = load({ ...lists, route: ['crm', 'companies', U1, 'activity'] }).view();
  assert.match(notes, new RegExp(`data-note-form="companies" data-record-id="${U1}"`));
  assert.doesNotMatch(notes, /href="#agenda\//, 'the overview\'s panels stay on the overview');
});

/* A meeting as the store holds it, at a local time. */
const localMeeting = (id, title, startsAt, over = {}) => ({
  id, title, when: `when ${id}`, row: { id, starts_at: startsAt, ends_at: null, project_id: null, company_id: null, contact_id: null, ...over }
});
const section = (html, title) => {
  const found = new RegExp(`<h2[^>]*>${title}</h2>`).exec(html);
  return found ? html.slice(found.index, html.indexOf('</section>', found.index)) : '';
};
const agendaLinks = html => [...html.matchAll(/href="#agenda\/([^"]+)"/g)].map(m => m[1]);

test('a company\'s page lists its meetings from today on, then its past ones, asked for by the company, its projects and its people', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const ana = contact('Ana', 'ana@northline.example', northline, { id: U2 });
  const site = { id: U3, name: 'Northline site', status: 'In progress', companyId: U1, row: { id: U3, company_id: U1 } };
  const yesterday = localMeeting('e0', 'Stand-up', '2026-09-14T09:00:00', { company_id: U1 });
  const offsite = localMeeting('e5', 'Offsite', '2026-09-14T09:00:00', { company_id: U1, ends_at: '2026-09-16T17:00:00' });
  const call = localMeeting('e2', 'Call with Ana', '2026-09-16T08:00:00', { contact_id: U2 });
  const pitch = localMeeting('e9', 'Pitch', '2026-08-01T10:00:00', { company_id: U1 });
  const h = load({
    companies: [northline], contacts: [ana], projects: [site], events: [yesterday, offsite, call],
    route: ['crm', 'companies', U1],
    past: { [`company:${U1}`]: { state: 'ready', meetings: [yesterday, offsite, pitch], more: true } }
  });
  const page = h.view();
  assert.deepEqual(agendaLinks(section(page, 'Coming up')), ['e5', 'e2'], 'from today on, one still under way included');
  assert.match(page, /Meetings from today on, filed under the company, its projects or its people\./);
  assert.deepEqual(agendaLinks(section(page, 'Past meetings')), ['e0', 'e9'], 'the most recent first, as the store gives them, and none listed twice');
  assert.match(section(page, 'Past meetings'), /<small>when e9<\/small>/);
  assert.match(page, /Older meetings are not listed\./);
  const [key, filter] = h.pastAsked.at(-1);
  assert.equal(key, `company:${U1}`);
  assert.deepEqual({ ...filter, before: undefined }, { companyId: U1, projectIds: [U3], contactIds: [U2], limit: 20, before: undefined });
  assert.equal(new Date(filter.before).getTime(), new Date('2026-09-15T00:00:00').getTime(), 'before the start of today, on the viewer\'s clock');
});

test('past meetings still loading say so; ones that did not load can be asked for again; none, and nothing coming up, say so', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const route = ['crm', 'companies', U1];
  const loading = load({ companies: [northline], route }).view();
  assert.match(section(loading, 'Past meetings'), /<p class="quiet-text" role="status">Loading past meetings…<\/p>/);
  assert.match(loading, /<h2 id="past-meetings" tabindex="-1">Past meetings<\/h2>/, 'a heading that can take the keyboard');
  assert.match(section(loading, 'Coming up'), /Nothing coming up\./);
  const failed = load({ companies: [northline], route, past: { [`company:${U1}`]: { state: 'failed', meetings: [], more: false } } });
  const page = failed.view();
  assert.match(section(page, 'Past meetings'), /<p class="quiet-text" role="status">Past meetings did not load\. They are tried again by themselves\.<\/p>/);
  assert.match(section(page, 'Past meetings'), new RegExp(`<button type="button" class="btn" data-crm-past-retry="company:${U1}">Try again</button>`));
  failed.click({ 'data-crm-past-retry': `company:${U1}` });
  assert.deepEqual(failed.retried, [`company:${U1}`]);
  assert.equal(failed.renders(), 1, 'and the page is drawn again, which asks');
  assert.deepEqual(failed.focused, ['past-meetings'], 'Try again is gone once the page is drawn again, so the keyboard goes to the panel');
  const none = load({ companies: [northline], route, past: { [`company:${U1}`]: { state: 'ready', meetings: [], more: false } } }).view();
  assert.match(section(none, 'Past meetings'), /No past meetings\./);
  assert.doesNotMatch(none, /Older meetings are not listed|first 50/);
  const capped = load({ companies: [northline], route, past: { [`company:${U1}`]: { state: 'ready', meetings: [], more: false, capped: true } } }).view();
  assert.match(capped, /Only meetings filed under its first 50 projects and 50 people are listed\./);
});

test('a meeting that ended before today is past, whatever the zone: an all-day one yesterday, and one that ended at midnight', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const allDay = localMeeting('d1', 'Offsite', '2026-09-14T00:00:00Z', { company_id: U1, all_day: true, ends_at: '2026-09-15T00:00:00Z' });
  const late = localMeeting('d2', 'Late call', '2026-09-14T23:00:00', { company_id: U1, ends_at: '2026-09-15T00:00:00' });
  const night = localMeeting('d3', 'Night shift', '2026-09-14T23:30:00', { company_id: U1, ends_at: '2026-09-15T00:30:00' });
  const page = load({ companies: [northline], events: [allDay, late, night], route: ['crm', 'companies', U1],
    past: { [`company:${U1}`]: { state: 'ready', meetings: [allDay, late, night], more: false } } }).view();
  assert.deepEqual(agendaLinks(section(page, 'Coming up')), ['d3'], 'only the one still going on today');
  assert.deepEqual(agendaLinks(section(page, 'Past meetings')), ['d2', 'd1'], 'the most recent first, whatever order they came in');
});

test('a past meeting is filed under one company, as meetings coming up are: its own company first, then its project\'s, then its person\'s', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const harbor = company('client', 100, 'USD', { id: U3, name: 'Harbor' });
  const ana = contact('Ana', 'ana@northline.example', northline, { id: U2 });
  const site = { id: 'p1', name: 'Northline site', status: 'In progress', companyId: U1, row: { id: 'p1', company_id: U1 } };
  const theirs = localMeeting('m1', 'Harbor review', '2026-09-01T10:00:00', { project_id: 'p1', company_id: U3 });
  const ours = localMeeting('m2', 'Call with Ana', '2026-09-02T10:00:00', { contact_id: U2 });
  const page = load({ companies: [northline, harbor], contacts: [ana], projects: [site], route: ['crm', 'companies', U1],
    past: { [`company:${U1}`]: { state: 'ready', meetings: [ours, theirs], more: false } } }).view();
  assert.deepEqual(agendaLinks(section(page, 'Past meetings')), ['m2'], 'Harbor\'s meeting on a Northline project is Harbor\'s');
});

test('the notes tab asks for no past meetings: its overview is not drawn', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const ana = contact('Ana', 'ana@northline.example', northline, { id: U2 });
  const onCompany = load({ companies: [northline], contacts: [ana], route: ['crm', 'companies', U1, 'activity'] });
  onCompany.view();
  assert.deepEqual(onCompany.pastAsked, []);
  const onPerson = load({ companies: [northline], contacts: [ana], route: ['crm', U2, 'activity'] });
  onPerson.view();
  assert.deepEqual(onPerson.pastAsked, []);
});

test('a contact\'s page lists their meetings coming up and their past ones, asked for by them', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const ana = contact('Ana', 'ana@northline.example', northline, { id: U2 });
  const call = localMeeting('e2', 'Call with Ana', '2026-09-16T08:00:00', { contact_id: U2 });
  const lunch = localMeeting('e7', 'Lunch', '2026-09-01T12:00:00', { contact_id: U2 });
  const h = load({ companies: [northline], contacts: [ana], events: [call], route: ['crm', U2],
    past: { [`contact:${U2}`]: { state: 'ready', meetings: [lunch], more: false } } });
  const page = h.view();
  assert.deepEqual(agendaLinks(section(page, 'Coming up')), ['e2']);
  assert.match(page, /Meetings from today on, filed under them\./);
  assert.deepEqual(agendaLinks(section(page, 'Past meetings')), ['e7']);
  const [key, filter] = h.pastAsked.at(-1);
  assert.equal(key, `contact:${U2}`);
  assert.deepEqual(filter.contactIds, [U2]);
  assert.equal(filter.limit, 20);
});

test('what anyone typed into a past meeting stays text', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const typed = { ...localMeeting('e8', TYPED, '2026-09-01T12:00:00', { company_id: U1 }), when: TYPED };
  const page = load({ companies: [northline], route: ['crm', 'companies', U1],
    past: { [`company:${U1}`]: { state: 'ready', meetings: [typed], more: false } } }).view();
  assert.doesNotMatch(page, MARKUP);
  assert.match(section(page, 'Past meetings'), /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a record\'s notes offer Edit to whoever wrote each, and Remove to them or an owner or admin; notes that did not load say so', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const mine = { id: 'n1', body: 'Client wants blue', who: 'Sam Rivera', initial: 'SR', time: 'Today', authorId: 'e-me' };
  const theirs = { id: 'n2', body: 'Budget approved', who: 'Ana Lima', initial: 'AL', time: 'Yesterday', authorId: 'e-ana' };
  const route = ['crm', 'companies', U1, 'activity'];
  const notes = { companies: { [U1]: [mine, theirs] } };
  const staffView = { id: 'e-me', role: 'employee', status: 'active' };
  const ownerView = { id: 'e-me', role: 'owner', status: 'active' };
  const staff = load({ companies: [northline], route, notes, viewer: staffView }).view();
  assert.match(staff, /<p>Client wants blue<\/p>/);
  assert.match(staff, /<button type="button" class="text-btn" data-note-edit="n1" aria-label="Edit your note from Today: “Client wants blue”">Edit<\/button>/);
  assert.match(staff, /<button type="button" class="text-btn" data-note-remove="n1" aria-label="Remove your note from Today: “Client wants blue”">Remove<\/button>/);
  assert.doesNotMatch(staff, /aria-describedby/, 'each button names its note by how it begins, rather than reading the whole note out again');
  assert.doesNotMatch(staff, /data-note-(edit|remove)="n2"/, 'nothing to change on someone else\'s note');
  const owner = load({ companies: [northline], route, notes, viewer: ownerView }).view();
  assert.match(owner, /data-note-edit="n1" aria-label="Edit your note from Today: “Client wants blue”"/, 'an owner changes their own note');
  assert.match(owner, /data-note-remove="n1" aria-label="Remove your note from Today: “Client wants blue”"/);
  assert.doesNotMatch(owner, /data-note-edit="n2"/, 'an owner or admin does not change someone else\'s words');
  assert.match(owner, /data-note-remove="n2" aria-label="Remove Ana Lima’s note from Yesterday: “Budget approved”"/);
  const long = { companies: { [U1]: [{ ...mine, body: 'word '.repeat(20) }] } };
  assert.match(load({ companies: [northline], route, notes: long, viewer: staffView }).view(), /aria-label="Edit your note from Today: “(word ){7}word…”"/,
    'two notes from the same day are told apart by how each begins');
  const flags = { companies: { [U1]: [{ ...mine, body: `${'a'.repeat(38)}🇳🇱🇳🇱` }] } };
  assert.ok(load({ companies: [northline], route, notes: flags, viewer: staffView }).view().includes(`aria-label="Edit your note from Today: “${'a'.repeat(38)}🇳🇱🇳🇱”"`),
    'forty characters as a person counts them, flags whole');
  assert.doesNotMatch(load({ companies: [northline], route, notes }).view(), /data-note-(edit|remove)/, 'with no one signed in, no note offers either');
  /* A note whose author's row was deleted: 0032 sets author_id null. */
  const former = { companies: { [U1]: [{ id: 'n3', body: 'Kickoff went well', who: 'Former team member', initial: 'FT', time: 'Sep 1', authorId: null }] } };
  const formerForOwner = load({ companies: [northline], route, notes: former, viewer: ownerView }).view();
  assert.doesNotMatch(formerForOwner, /data-note-edit="n3"/, 'no one changes the words of someone who has left');
  assert.match(formerForOwner, /data-note-remove="n3" aria-label="Remove a former team member’s note from Sep 1: “Kickoff went well”"/);
  assert.doesNotMatch(load({ companies: [northline], route, notes: former, viewer: staffView }).view(), /data-note-(edit|remove)="n3"/);
  const failed = load({ companies: [northline], route, loaded: EVERYTHING.filter(part => part !== 'notes') }).view();
  assert.match(failed, /Notes did not load\. They are tried again by themselves\./);
  assert.doesNotMatch(failed, /No notes yet/);
  assert.match(load({ companies: [northline], route }).view(), /No notes yet\./);
  const typed = load({ companies: [northline], route, notes: { companies: { [U1]: [{ ...theirs, who: TYPED, time: TYPED }] } }, viewer: ownerView }).view();
  assert.doesNotMatch(typed, MARKUP, 'what anyone typed stays text in the buttons\' names too');
});

test('a note box is drawn with what was written in it before the page was drawn again, as text', () => {
  const northline = company('client', 100, 'USD', { id: U1, name: 'Northline' });
  const route = ['crm', 'companies', U1, 'activity'];
  const kept = load({ companies: [northline], route, drafts: { [`companies|${U1}`]: `Call back ${TYPED}` } }).view();
  assert.match(kept, /<textarea id="record-note" name="note" required placeholder="[^"]*">Call back &lt;img src=x onerror=alert\(1\)&gt;<\/textarea>/);
  assert.doesNotMatch(kept, MARKUP);
  assert.match(load({ companies: [northline], route }).view(), /<textarea id="record-note" name="note" required placeholder="[^"]*"><\/textarea>/);
});

test('the strip is contacts, pipeline value and active clients, in that order', () => {
  assert.deepEqual([...ui.stats([], [])].map(item => item[0]), ['Contacts', 'Pipeline value', 'Active clients']);
});

test('pipeline value counts each company once, however many people work there', () => {
  const northline = company('proposal', 12000);
  const harbor = company('lead', 3000);
  const people = ['Ana', 'Ben', 'Cy'].map(name => contact(name, `${name.toLowerCase()}@northline.example`, northline));
  const stats = ui.stats(people, [northline, harbor]);
  assert.deepEqual(figure(stats, 'Contacts'), { value: 3, caption: 'People in your network' });
  assert.equal(figure(stats, 'Pipeline value').value, money(15000, 'USD'));
  assert.match(figure(stats, 'Pipeline value').value, /^\$15,000(\.00)?$/);
  assert.equal(figure(stats, 'Pipeline value').caption, '2 companies still to win', 'a company with nobody at it is still a deal');
});

test('the pipeline is the deals still to be won — leads, qualified deals and proposals, not clients, dormant or lost deals', () => {
  const stats = ui.stats([], STAGES.map((stage, i) => company(stage, 10 ** i)));
  assert.equal(figure(stats, 'Pipeline value').value, money(111, 'USD'));
  assert.equal(figure(stats, 'Pipeline value').caption, '3 companies still to win');
});

test('one currency is never added into another: each has its own total, side by side', () => {
  const stats = ui.stats([], [company('lead', 1000, 'USD'), company('proposal', 3500, 'EUR'), company('lead', 250, 'usd')]);
  assert.equal(figure(stats, 'Pipeline value').value, `${money(3500, 'EUR')} · ${money(1250, 'USD')}`);
});

test('a currency stored before currencies had to be codes is never added to the dollars', () => {
  const parts = figure(ui.stats([], [company('lead', 1000, 'USD'), company('lead', 50, 'US$')]), 'Pipeline value').value.split(' · ');
  assert.equal(parts.length, 2);
  assert.ok(parts.includes(money(1000, 'USD')), 'the dollars are only the dollars');
  assert.ok(parts.includes(money(50, 'US$')));
});

test('active clients are companies, not the people who work at them', () => {
  const client = company('client', 9000);
  const people = ['Ana', 'Ben', 'Cy'].map(name => contact(name, `${name.toLowerCase()}@client.example`, client));
  const stats = ui.stats(people, [client, company('lead', 10), company('dormant', 20)]);
  assert.deepEqual(figure(stats, 'Active clients'), { value: 1, caption: 'Companies you work with' });
});

test('companies that did not load are a dash, not a zero, and the people who did load are still counted', () => {
  for (const companies of [null, undefined]) {
    const stats = ui.stats([contact('Ana', 'ana@northline.example')], companies);
    assert.equal(figure(stats, 'Contacts').value, 1);
    assert.deepEqual(figure(stats, 'Pipeline value'), { value: '—', caption: 'Companies did not load' });
    assert.deepEqual(figure(stats, 'Active clients'), { value: '—', caption: 'Companies did not load' });
  }
});

test('with no deal to win the value is a dash that says so, a deal with no value adds nothing, and no clients is zero', () => {
  const none = ui.stats([], []);
  assert.deepEqual(figure(none, 'Pipeline value'), { value: '—', caption: 'No open deals' });
  assert.equal(figure(none, 'Active clients').value, 0);
  const unvalued = ui.stats([], [company('lead', null), company('proposal', '')]);
  assert.deepEqual(figure(unvalued, 'Pipeline value'), { value: '—', caption: '2 companies still to win' });
  assert.equal(figure(ui.stats([], [company('lead', 500)]), 'Pipeline value').caption, '1 company still to win');
});

test('a company loaded twice counts once: in the value, the caption and the clients', () => {
  const client = company('client', 9000);
  const lead = company('lead', 500);
  const stats = ui.stats([], [client, client, lead, lead]);
  assert.equal(figure(stats, 'Active clients').value, 1);
  assert.deepEqual(figure(stats, 'Pipeline value'), { value: money(500, 'USD'), caption: '1 company still to win' });
});

test('the studio\'s currency comes first, then the other codes, then what was stored before currencies were codes', () => {
  const list = [company('lead', 7, 'EUR'), company('lead', 50, 'US$'), company('lead', 1000, 'USD'), company('lead', 3, 'CHF')];
  assert.equal(figure(ui.stats([], list, 'USD'), 'Pipeline value').value,
    [money(1000, 'USD'), money(3, 'CHF'), money(7, 'EUR'), money(50, 'US$')].join(' · '));
  assert.equal(figure(ui.stats([], list, null), 'Pipeline value').value,
    [money(3, 'CHF'), money(7, 'EUR'), money(1000, 'USD'), money(50, 'US$')].join(' · '), 'with no studio currency, the codes in order');
});

/* ── A contact's invoices ─────────────────────────────────────────────── */

test('a contact\'s invoices are the ones sent to their address, however either was typed', () => {
  const ana = contact('Ana', ' Ana@Northline.example ');
  const list = [shaped(), shaped({ id: U2, number: 'INV-1043', client_email: 'ANA@northline.EXAMPLE' }), shaped({ id: U3, number: 'INV-1044', client_email: 'ben@northline.example' })];
  assert.deepEqual([...ui.invoicesFor(ana, list)].map(i => i.number), ['INV-1042', 'INV-1043']);
});

test('an invoice billed to their company\'s name is not theirs, and someone with no address has none', () => {
  const northline = company('client', 0);
  const ben = contact('Ben', 'ben@elsewhere.example', northline);
  assert.equal(ui.invoicesFor(ben, [shaped({ client: northline.name })]).length, 0);
  const cy = contact('Cy', '', northline);
  assert.equal(ui.invoicesFor(cy, [shaped({ client_email: '' }), shaped({ id: U2, client_email: null })]).length, 0,
    'no address is no match for an invoice with none');
  assert.equal(ui.invoicesFor(null, [shaped()]).length, 0);
});

test('an invoice with no page to open is left out, a gap in the list is skipped, and invoices not known are not "none"', () => {
  const ana = contact('Ana', 'ana@northline.example');
  assert.equal(ui.invoicesFor(ana, [shaped({ id: 'INV-1042' })]).length, 0, 'a link carries a uuid or nothing');
  assert.equal(ui.invoicesFor(ana, [null, undefined, shaped()]).length, 1);
  assert.equal(ui.invoicesFor(ana, null), null);
});

test('an address that only contains theirs, or an invoice with no address, is not theirs', () => {
  const ana = contact('Ana', 'ana@northline.example');
  const list = [shaped(), shaped({ id: U2, number: 'INV-1043', client_email: 'joana@northline.example' }),
    shaped({ id: U3, number: 'INV-1044', client_email: '' })];
  assert.deepEqual([...ui.invoicesFor(ana, list)].map(i => i.number), ['INV-1042']);
});

/* ── The lists ────────────────────────────────────────────────────────── */

test('the pipeline, the companies and the contacts are each an address of their own', () => {
  const current = route => (load({ route }).view().match(/<a href="#([^"]+)" class="selected" aria-current="page">/) || [])[1];
  assert.equal(current(['crm']), 'crm');
  assert.equal(current(['crm', 'companies']), 'crm/companies');
  assert.equal(current(['crm', 'contacts']), 'crm/contacts');
});

test('the pipeline has a column for each of the six stages, each named by its heading, and a company with nobody at it is on it', () => {
  const northline = company('client', 12000, 'EUR', { name: 'Northline' });
  const kite = company('lead', 2500, 'USD', { name: 'Kite Labs' });
  const quiet = company('dormant', 5000, 'USD', { name: 'Quiet Co' });
  const html = load({ companies: [northline, kite, quiet], contacts: [contact('Olivia', 'olivia@northline.example', northline)] }).view();
  assert.deepEqual([...html.matchAll(/<h2 id="crm-stage-[a-z]+">([^<]+)<\/h2>/g)].map(m => m[1]),
    ['Leads', 'Qualified', 'Proposals', 'Clients', 'Dormant', 'Lost']);
  for (const stage of STAGES) {
    assert.ok(html.includes(`<section class="board-column" aria-labelledby="crm-stage-${stage}">`), `the ${stage} column is named by its heading`);
  }
  assert.match(column(html, 'lead'), new RegExp(`href="#crm/companies/${kite.id}"`), 'Kite Labs has nobody yet, and is on the board');
  assert.match(column(html, 'dormant'), /Quiet Co/, 'a dormant company is not dropped off the board');
  assert.match(column(html, 'client'), /Olivia/, 'a card says who works there');
});

test('a card says who works there and what it is worth, its name is a heading under its column\'s, and its initials are not read out', () => {
  const harbor = company('client', 9000, 'USD', { name: 'Harbor & Co' });
  const kite = company('lead', null, 'USD', { name: 'Kite Labs' });
  const html = load({ companies: [harbor, kite], contacts: [contact('Ben', 'ben@harbor.example', harbor), contact('Maya', 'maya@harbor.example', harbor)] }).view();
  assert.match(column(html, 'client'), /<h3>Harbor &amp; Co<\/h3><p>Ben and 1 more<\/p>/);
  assert.match(column(html, 'client'), /<strong>\$9,000\.00<\/strong><span>Yearly value<\/span>/);
  assert.match(column(html, 'lead'), /<p>Nobody here yet<\/p>/);
  assert.match(column(html, 'lead'), /<strong>—<\/strong><span>Deal value<\/span>/, 'a deal with no value is a dash, not $0.00');
  assert.match(column(html, 'client'), /<div class="avatar contact-avatar" aria-hidden="true">/);
});

test('each column says what it is worth in each currency, never added together', () => {
  const html = load({ companies: [company('lead', 1000, 'USD'), company('lead', 3500, 'EUR'), company('client', 10)] }).view();
  assert.ok(column(html, 'lead').includes(`<p class="board-total">${money(3500, 'EUR')} · ${money(1000, 'USD')}</p>`));
  assert.doesNotMatch(column(html, 'qualified'), /board-total/, 'a column worth nothing says nothing');
});

test('the pages put the studio\'s currency first, in the strip and on the board', () => {
  /* Dollars, which a list in code order puts after euros. */
  const html = load({ overview: { revenue_currency: 'usd' }, companies: [company('lead', 1000, 'USD'), company('lead', 500, 'EUR')] }).view();
  const dollarsFirst = `${money(1000, 'USD')} · ${money(500, 'EUR')}`;
  assert.ok(html.includes(`<strong>${dollarsFirst}</strong>`), 'the strip');
  assert.ok(column(html, 'lead').includes(`<p class="board-total">${dollarsFirst}</p>`), 'the column');
});

test('the companies list has each company once, with its people, value and owner, in a table named by its heading', () => {
  const harbor = company('proposal', 8000, 'USD', { name: 'Harbor & Co', owner_id: 'e-sam', domain: 'harbor.example' });
  const html = load({
    route: ['crm', 'companies'], companies: [harbor, company('lead', null, 'USD', { name: 'Kite Labs' })], team: [{ id: 'e-sam', name: 'Sam Rivera' }],
    contacts: [contact('Ben', 'ben@harbor.example', harbor), contact('Maya', 'maya@harbor.example', harbor)]
  }).view();
  const rows = bodyRows(html);
  assert.equal(rows.length, 2);
  const row = rows.find(r => r.includes('Harbor'));
  assert.match(row, new RegExp(`href="#crm/companies/${harbor.id}"`));
  assert.match(row, /<td>2<\/td>/);
  assert.match(row, /\$8,000\.00/);
  assert.match(row, /Sam Rivera/);
  assert.match(row, /harbor\.example/);
  assert.match(rows.find(r => r.includes('Kite')), /<td>—<\/td>/, 'no value is a dash');
  assert.match(html, /<table class="module-table" aria-labelledby="crm-list-heading">/);
  assert.match(html, /<h2 id="crm-list-heading">Companies /);
});

test('search finds a company by one of its people, and contacts by their name', () => {
  const harbor = company('proposal', 8000, 'USD', { name: 'Harbor & Co' });
  const kite = company('lead', 10, 'USD', { name: 'Kite Labs' });
  const people = [contact('Maya', 'maya@harbor.example', harbor), contact('Ben', 'ben@kite.example', kite)];
  const companies = load({ route: ['crm', 'companies'], query: 'maya', companies: [harbor, kite], contacts: people }).view();
  assert.match(companies, /Harbor &amp; Co/);
  assert.doesNotMatch(companies, /Kite Labs/);
  const found = load({ route: ['crm', 'contacts'], query: 'maya', companies: [harbor, kite], contacts: people }).view();
  assert.match(found, /href="#crm\/contact-Maya"/);
  assert.doesNotMatch(found, /href="#crm\/contact-Ben"/);
});

test('a list with nothing in it says which: none yet, or none found by the search', () => {
  const northline = company('client', 1, 'USD', { name: 'Northline' });
  const olivia = contact('Olivia', 'olivia@northline.example', northline);
  assert.match(load({ route: ['crm', 'companies'] }).view(), /No companies yet/);
  assert.match(load({ route: ['crm', 'companies'], companies: [northline], query: 'nobody-by-this-name' }).view(), /No companies found/);
  assert.match(load({ route: ['crm', 'contacts'] }).view(), /No contacts yet/);
  assert.match(load({ route: ['crm', 'contacts'], contacts: [olivia], companies: [northline], query: 'nobody-by-this-name' }).view(), /No contacts found/);
});

test('a long list draws its first rows, and says how many there are', () => {
  const many = Array.from({ length: ui.ROW_LIMIT + 5 }, (_, i) => contact(`Person${String(i).padStart(3, '0')}`, `p${i}@example.com`));
  const html = load({ route: ['crm', 'contacts'], contacts: many }).view();
  assert.equal((html.match(/<tr><td>/g) || []).length, ui.ROW_LIMIT);
  assert.ok(html.includes(`Showing ${ui.ROW_LIMIT} of ${ui.ROW_LIMIT + 5}. Search to narrow the list.`));
  assert.ok(html.includes(`<span class="small-count">${ui.ROW_LIMIT + 5}</span>`), 'the count is every contact');
});

test('a contact with no company has no company and no stage — not a lead — and one whose company was deleted has none', () => {
  const gone = company('client', 1, 'USD', { name: 'Gone Ltd' });
  const northline = company('proposal', 1, 'USD', { name: 'Northline' });
  const html = load({
    route: ['crm', 'contacts'], companies: [northline],
    contacts: [contact('Jo', 'jo@example.com'), contact('Kim', 'kim@gone.example', gone), contact('Olivia', 'olivia@northline.example', northline)]
  }).view();
  const rows = bodyRows(html);
  const row = name => rows.find(r => r.includes(`<strong>${name}</strong>`));
  assert.doesNotMatch(row('Jo'), /pill/, 'no stage');
  assert.doesNotMatch(row('Jo'), /Lead/);
  assert.doesNotMatch(row('Kim'), /Gone Ltd/, 'a deleted company is nobody\'s');
  assert.match(row('Olivia'), new RegExp(`href="#crm/companies/${northline.id}">Northline<`));
  assert.match(row('Olivia'), /<span class="pill">Proposal<\/span>/);
});

test('while companies did not load the pipeline says so, rather than showing an empty board', () => {
  const html = load({ loaded: ['contacts'] }).view();
  assert.match(html, /Companies did not load/);
  assert.doesNotMatch(html, /crm-stage-/);
});

/* ── A company's page ─────────────────────────────────────────────────── */

test('a company\'s page lists its people, projects and tickets by id — never a project that only shares its name — and the invoices sent to its people', () => {
  const northline = company('client', 12000, 'EUR', { name: 'Northline', owner_id: 'e-sam', domain: 'northline.example', notes: 'Retainer since 2024' });
  const labs = company('lead', 10, 'USD', { name: 'Northline Labs' });
  const olivia = contact('Olivia', 'olivia@northline.example', northline);
  const html = load({
    route: ['crm', 'companies', northline.id], companies: [northline, labs], contacts: [olivia],
    team: [{ id: 'e-sam', name: 'Sam Rivera' }],
    projects: [
      { id: 'p1', name: 'Site relaunch', client: 'Northline', companyId: northline.id, status: 'In progress', row: {} },
      { id: 'p2', name: 'Labs app', client: 'Northline', companyId: labs.id, status: 'Planning', row: {} }
    ],
    tickets: [{ id: 142, title: 'Checkout fails', status: 'Open', row: { company_id: null, project_id: null, contact_id: olivia.id } }],
    invoices: [invoice({ client_email: 'OLIVIA@northline.example' }), invoice({ id: U2, number: 'INV-2003', client_email: 'billing@northline.example' })]
  }).view();
  assert.match(html, /href="#crm\/contact-Olivia"/);
  assert.match(html, /Site relaunch/);
  assert.doesNotMatch(html, /Labs app/, 'a project at another company is not listed because its client name matches');
  assert.match(html, /Checkout fails/, 'a ticket filed under one of its people');
  assert.match(html, /INV-1042/);
  assert.doesNotMatch(html, /INV-2003/, 'billed to its name at an address none of its people has');
  assert.match(html, /<span>Owner<\/span><div>Sam Rivera<\/div>/);
  assert.match(html, /€12,000\.00/);
  assert.match(html, /Retainer since 2024/);
});

test('an invoice sent to two of a company\'s people is listed once', () => {
  const northline = company('client', 1, 'USD', { name: 'Northline' });
  const people = [contact('Ana', 'billing@northline.example', northline), contact('Bea', 'BILLING@northline.example', northline)];
  const html = load({ route: ['crm', 'companies', northline.id], companies: [northline], contacts: people, invoices: [invoice({ client_email: 'billing@northline.example' })] }).view();
  assert.equal((html.match(/INV-1042/g) || []).length, 1);
});

test('an address that is no company\'s opens nothing, a page has only its own tabs, and while companies did not load the page says so', () => {
  const co = company('lead', 1);
  assert.ok(isNotFound(load({ route: ['crm', 'companies', 'company-nope'], companies: [co] }).view()));
  assert.ok(isNotFound(load({ route: ['crm', 'companies', co.id, 'anything'], companies: [co] }).view()));
  const waiting = load({ route: ['crm', 'companies', co.id], loaded: ['contacts'] }).view();
  assert.match(waiting, /Companies did not load/);
  const ana = contact('Ana', 'ana@northline.example');
  assert.ok(isNotFound(load({ route: ['crm', '0'], contacts: [ana] }).view()), 'an old link by place opens nobody');
  assert.ok(isNotFound(load({ route: ['crm', ana.id, 'bogus'], contacts: [ana] }).view()));
  assert.ok(isNotFound(load({ route: ['crm', 'contacts', 'x'], contacts: [ana] }).view()), 'not the contacts list');
});

test('an id written in capitals opens the same company or contact', () => {
  const northline = company('client', 1, 'USD', { id: 'c0000000-0000-4000-8000-00000000abcd', name: 'Northline' });
  const olivia = contact('Olivia', 'olivia@northline.example', northline, { id: 'a0000000-0000-4000-8000-00000000abcd' });
  const lists = { companies: [northline], contacts: [olivia] };
  assert.match(load({ ...lists, route: ['crm', 'companies', 'C0000000-0000-4000-8000-00000000ABCD'] }).view(), /<h1>Northline<\/h1>/);
  assert.match(load({ ...lists, route: ['crm', 'A0000000-0000-4000-8000-00000000ABCD'] }).view(), /<h1>Olivia<\/h1>/);
});

/* ── A contact's page ─────────────────────────────────────────────────── */

test('a contact\'s page puts the projects they are on first, with their role, then the rest of their company\'s', () => {
  const northline = company('client', 1, 'USD', { name: 'Northline', owner_id: 'e-sam' });
  const olivia = contact('Olivia', 'olivia@northline.example', northline, { phone: '+1 555 0100', title: 'Head of product' });
  const html = load({
    route: ['crm', olivia.id], companies: [northline], contacts: [olivia], team: [{ id: 'e-sam', name: 'Sam Rivera' }],
    projects: [
      { id: 'p1', name: 'Site relaunch', companyId: northline.id, status: 'In progress', row: {} },
      { id: 'p2', name: 'Brand refresh', companyId: northline.id, status: 'Planning', row: {} },
      { id: 'p3', name: 'Northline', client: 'Northline', companyId: null, status: 'Planning', row: {} }
    ],
    projectContacts: [{ project_id: 'p2', contact_id: olivia.id, role: ROLE.value }]
  }).view();
  assert.ok(html.indexOf('Brand refresh') > -1 && html.indexOf('Brand refresh') < html.indexOf('Site relaunch'), 'the project they are on comes first');
  assert.match(html, new RegExp(`Their role: ${ROLE.label}`));
  assert.doesNotMatch(html, /href="#projects\/p3"/, 'a project named like their company is not theirs');
  assert.match(html, /\+1 555 0100/);
  assert.match(html, /Head of product/);
  assert.match(html, /<span>Owner<\/span><div>Sam Rivera<\/div>/, 'their company\'s owner');
  assert.match(html, new RegExp(`href="#crm/companies/${northline.id}">Northline<`));
});

test('a contact\'s conversations are theirs by id or by address, and their invoices by address', () => {
  const olivia = contact('Olivia', 'olivia@northline.example');
  const html = load({
    route: ['crm', olivia.id], contacts: [olivia],
    mails: [
      { id: 'th1', subject: 'Draft for review', contactId: olivia.id, email: 'someone@else.example', time: '09:00', folder: 'inbox' },
      { id: 'th2', subject: 'Invoice question', contactId: null, email: 'OLIVIA@northline.example', time: '10:00', folder: 'sent' },
      { id: 'th3', subject: 'Not hers', contactId: null, email: 'ben@harbor.example', time: '11:00', folder: 'inbox' }
    ],
    invoices: [invoice({ client_email: 'olivia@northline.example' }), invoice({ id: U2, number: 'INV-2003', client: 'Olivia', client_email: 'ben@harbor.example' })]
  }).view();
  assert.match(html, /href="#mail\/all\/inbox\/th1"/);
  assert.match(html, /href="#mail\/all\/sent\/th2"/);
  assert.doesNotMatch(html, /Not hers/);
  assert.match(html, /INV-1042/);
  assert.doesNotMatch(html, /INV-2003/, 'an invoice with her name on it, sent to someone else');
  assert.match(html, /data-action="contact-email"/);
  assert.match(html, /<span>Company<\/span><div>—<\/div>/, 'no company');
});

test('someone with no address shares no conversation that has none either', () => {
  const jo = contact('Jo', '');
  const html = load({ route: ['crm', jo.id], contacts: [jo], mails: [{ id: 'th9', subject: 'No sender address', contactId: null, email: '', time: '10:00', folder: 'inbox' }] }).view();
  assert.doesNotMatch(html, /No sender address/);
  assert.match(html, /<strong>0<\/strong>Emails/);
});

test('the activity tab is their notes, and someone with no address has no Write email button', () => {
  const olivia = contact('Olivia', 'olivia@northline.example');
  assert.match(load({ route: ['crm', olivia.id, 'activity'], contacts: [olivia] }).view(), /data-note-form="crm" data-record-id="contact-Olivia"/);
  const jo = contact('Jo', '');
  assert.doesNotMatch(load({ route: ['crm', jo.id], contacts: [jo] }).view(), /contact-email/);
});

/* ── What did not load, and who may see invoices ──────────────────────── */

test('staff, who cannot read invoices, see their conversations, and no invoice list that could only ever be empty', () => {
  const northline = company('client', 1, 'USD', { name: 'Northline' });
  const olivia = contact('Olivia', 'olivia@northline.example', northline);
  const lists = {
    manager: false, companies: [northline], contacts: [olivia],
    mails: [{ id: 'th1', subject: 'Draft for review', contactId: olivia.id, email: '', time: '09:00', folder: 'inbox' }],
    invoices: [invoice({ client_email: 'olivia@northline.example' })]
  };
  const person = load({ ...lists, route: ['crm', olivia.id] }).view();
  assert.match(person, /<h2>Conversations<\/h2>/);
  assert.match(person, /Draft for review/);
  assert.doesNotMatch(person, /invoice/i);
  assert.doesNotMatch(load({ ...lists, route: ['crm', 'companies', northline.id] }).view(), /invoice/i);
});

test('a manager is told when invoices did not load, and how a contact\'s invoices are found — or why none can be', () => {
  const northline = company('client', 1, 'USD', { name: 'Northline' });
  const olivia = contact('Olivia', 'olivia@northline.example', northline);
  const waiting = { companies: [northline], contacts: [olivia], loaded: EVERYTHING.filter(part => part !== 'invoices'), invoices: [invoice({ client_email: 'olivia@northline.example' })] };
  assert.match(load({ ...waiting, route: ['crm', olivia.id] }).view(), /Invoices did not load/);
  assert.match(load({ ...waiting, route: ['crm', 'companies', northline.id] }).view(), /Invoices did not load/);
  assert.doesNotMatch(load({ ...waiting, route: ['crm', olivia.id] }).view(), /INV-1042/);
  assert.match(load({ companies: [northline], contacts: [olivia], route: ['crm', olivia.id] }).view(),
    /Invoices are listed by the address they were sent to: olivia@northline\.example\./);
  const jo = contact('Jo', '');
  assert.match(load({ contacts: [jo], route: ['crm', jo.id] }).view(), /No email address on record, so no invoices can be matched to them\./);
});

test('what did not load says so: a contact\'s conversations and roles, and a company\'s owner', () => {
  const northline = company('client', 1, 'USD', { name: 'Northline', owner_id: 'e-sam' });
  const olivia = contact('Olivia', 'olivia@northline.example', northline);
  const lists = {
    companies: [northline], contacts: [olivia], team: [{ id: 'e-sam', name: 'Sam Rivera' }],
    mails: [{ id: 'th1', subject: 'Draft for review', contactId: olivia.id, email: '', time: '09:00', folder: 'inbox' }]
  };
  const without = part => EVERYTHING.filter(p => p !== part);
  const noMail = load({ ...lists, route: ['crm', olivia.id], loaded: without('mail') }).view();
  assert.match(noMail, /Conversations did not load/);
  assert.doesNotMatch(noMail, /Draft for review/);
  assert.match(noMail, /<strong>—<\/strong>Emails/);
  assert.match(load({ ...lists, route: ['crm', olivia.id], loaded: without('projectContacts') }).view(), /Their roles on projects did not load/);
  const noTeam = load({ ...lists, route: ['crm', 'companies', northline.id], loaded: without('team') }).view();
  assert.match(noTeam, /<span>Owner<\/span><div>The team did not load<\/div>/);
  assert.match(load({ ...lists, route: ['crm', 'companies'], loaded: without('team') }).view(), /The team did not load/);
  assert.match(load({ ...lists, team: [], route: ['crm', 'companies', northline.id] }).view(), /Someone no longer on the team/);
  assert.match(load({ ...lists, route: ['crm', olivia.id] }).view(), /<span>Owner<\/span><div>Sam Rivera<\/div>/);
});

/* ── What anyone typed ────────────────────────────────────────────────── */

test('whatever anyone typed into a company, a contact or a conversation stays text on every CRM page', () => {
  const co = company('lead', 5, TYPED, { name: TYPED, domain: TYPED, notes: TYPED, owner_id: 'e-typed' });
  const person = contact(TYPED, TYPED, co, { title: TYPED, phone: TYPED, notes: TYPED });
  const lists = {
    companies: [co], contacts: [person], team: [{ id: 'e-typed', name: TYPED }],
    projects: [{ id: 'p1', name: TYPED, companyId: co.id, status: TYPED, row: {} }],
    tickets: [{ id: 7, title: TYPED, status: TYPED, row: { company_id: co.id } }],
    mails: [{ id: 'th1', subject: TYPED, contactId: person.id, email: TYPED, time: TYPED, folder: 'inbox' }],
    invoices: [invoice({ number: TYPED, client_email: TYPED })]
  };
  for (const route of [['crm'], ['crm', 'companies'], ['crm', 'contacts'], ['crm', 'companies', co.id], ['crm', 'companies', co.id, 'activity'], ['crm', person.id], ['crm', person.id, 'activity']]) {
    const html = load({ ...lists, route }).view();
    assert.doesNotMatch(html, MARKUP, route.join('/'));
    assert.ok(!isNotFound(html), route.join('/'));
  }
});
