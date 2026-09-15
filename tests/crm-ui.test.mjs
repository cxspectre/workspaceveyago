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
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* The page helpers crm-ui.js draws with, as workspace.js defines them: from
   `const matches` to notFound(). */
const HELPERS = (() => {
  const lines = readFileSync(new URL('../dist/workspace.js', import.meta.url), 'utf8').split('\n');
  const from = lines.findIndex(line => line.startsWith('const matches'));
  const to = lines.findIndex(line => line.startsWith('function notFound(){'));
  assert.ok(from >= 0 && to > from, 'the page helpers are where this test looks for them in workspace.js');
  return lines.slice(from, to + 1).join('\n');
})();

/* A hand-driven clock for the search debounce: setTimeout/clearTimeout that
   do nothing until the test itself asks for the next one to fire, so a delay
   is proven rather than raced against a real one. */
function fakeClock() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout: fn => { const id = nextId++; pending.set(id, fn); return id; },
    clearTimeout: id => { pending.delete(id); },
    fire() { const fns = [...pending.values()]; pending.clear(); fns.forEach(fn => fn()); },
    get pendingCount() { return pending.size; }
  };
}

/* The page as it runs: workspace.js's helpers, the models and crm-ui.js, with
   the store's lists and app.js's globals as stand-ins. */
function load({ route = ['crm'], query = '', contacts = [], companies = [], loaded = EVERYTHING,
  projects = [], projectContacts = [], tickets = [], invoices = [], mails = [], team = [], manager = true, overview = null,
  events = [], projectEvents = [], past = {}, notes = {}, viewer = null, drafts = null, workspaceLoaded = true,
  refuse = null, clock = null, enquiries = null, enquiriesFail = false, promoteResult = 'new-contact-1', refusePromote = null } = {}) {
  /* What the page asked the store for past meetings, and asked again. */
  const pastAsked = [];
  const retried = [];
  const promoted = [];
  const navigated = [];
  const listeners = {};
  const toasts = [];
  const written = [];
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
    toast: message => toasts.push(message),
    recordNotes: { tickets: {}, projects: {}, crm: {}, agenda: {}, companies: {}, ...notes },
    workspaceSession: viewer ? { employee: viewer } : undefined,
    /* The words notes-ui.js keeps for each note box, by kind and record. */
    noteDrafts: drafts ? { get: (kind, id) => drafts[`${kind}|${id}`] || '' } : undefined,
    workspaceActivity: [],
    workspaceData: {
      initials: name => (String(name).trim()[0] || '?').toUpperCase(),
      enquiries: () => (enquiriesFail ? Promise.reject(new Error('Could not load enquiries: timeout')) : Promise.resolve(enquiries || []))
    },
    financeDay: () => TODAY,
    isManagerNow: () => manager,
    mailModel: {
      ALL: 'all',
      mailRoute: ({ mailbox, folder, threadId }) => ['mail', mailbox, folder, threadId].join('/'),
      folderForThread: (thread, fallback) => thread.folder || fallback
    },
    routeParts: route,
    navigate: to => navigated.push(to),
    contacts, projects, tickets, invoices, mails, team, events,
    workspaceActions: {
      updateCompany: async (id, changes) => {
        written.push(['updateCompany', id, { ...changes }]);
        if (refuse) throw new Error(refuse);
        return { id };
      },
      promoteEnquiry: async id => {
        promoted.push(id);
        if (refusePromote) throw new Error(refusePromote);
        return promoteResult;
      }
    },
    workspaceStore: {
      has: part => loaded.includes(part),
      state: { companies, projectContacts, overview, projectEvents, loaded: workspaceLoaded },
      pastMeetings: (key, filter) => {
        pastAsked.push([key, JSON.parse(JSON.stringify(filter))]);
        return past[key] || { state: 'loading', meetings: [], more: false };
      },
      retryPastMeetings: key => retried.push(key),
      /* As store.js's after() does: a refusal is toasted, a success is not. */
      after: work => Promise.resolve(work).catch(err => { toasts.push(err.message); throw err; })
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => ({ focus: () => focused.push(id) })
    },
    render: () => { renders += 1; },
    repaintKeepingFocus: () => { renders += 1; },
    redrawPreservingFocus: () => { renders += 1; },
    crmView: () => 'the page app.js drew'
  });
  context.window = context;
  if (clock) { context.window.setTimeout = clock.setTimeout; context.window.clearTimeout = clock.clearTimeout; }
  else { context.window.setTimeout = (...args) => setTimeout(...args); context.window.clearTimeout = (...args) => clearTimeout(...args); }
  vm.runInContext(HELPERS, context);
  for (const file of ['overview-model.js', 'finance-model.js', 'projects-model.js', 'crm-model.js', 'tasks-model.js', 'agenda-model.js', 'crm-ui.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  /* A DOM event of `type` landing on an element with these data attributes,
     with whatever else (value, dataTransfer) the handler reads off it. */
  const fire = (type, attributes, extra = {}) => {
    const dataset = Object.fromEntries(Object.entries(attributes).map(([name, value]) =>
      [name.replace(/^data-/, '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), value]));
    const matchesSelector = selector => Object.entries(attributes).some(([name, value]) => selector === `[${name}]` || selector === `[${name}="${value}"]`);
    /* A real element answers both matches() and closest() the same way about
       itself; this stand-in is the only element in the tree, so closest()
       is just matches() with a self-reference. */
    const element = { dataset, value: extra.value, matches: matchesSelector };
    element.closest = selector => (matchesSelector(selector) ? element : null);
    const target = extra.target || element;
    let defaultPrevented = false;
    const stopped = [];
    (listeners[type] || []).forEach(fn => fn({
      target, preventDefault: () => { defaultPrevented = true; }, stopPropagation: () => stopped.push('stop'),
      stopImmediatePropagation: () => stopped.push('stop'), dataTransfer: extra.dataTransfer
    }));
    return { defaultPrevented, stopped: stopped.length > 0 };
  };
  const click = attributes => fire('click', attributes);
  const change = (attributes, value) => fire('change', attributes, { value });
  /* A stand-in for the browser's DataTransfer: what was set on drag, read on drop. */
  const dataTransfer = () => {
    const store = {};
    return { setData: (type, value) => { store[type] = value; }, getData: type => store[type], effectAllowed: '' };
  };
  return {
    context, view: () => context.crmView(), pastAsked, retried, click, change, fire, dataTransfer,
    focused, renders: () => renders, toasts, written, promoted, navigated
  };
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

test('contacts that did not load are a dash, not a zero, in the strip', () => {
  for (const contactsList of [null, undefined]) {
    const stats = ui.stats(contactsList, [company('lead', 500)]);
    assert.deepEqual(figure(stats, 'Contacts'), { value: '—', caption: 'Contacts did not load' });
    assert.equal(figure(stats, 'Pipeline value').value, money(500, 'USD'), 'companies loaded fine on their own');
  }
});

test('before contacts have loaded the strip and the contacts tab say so, not that there are none', () => {
  const withoutContacts = EVERYTHING.filter(part => part !== 'contacts');
  const strip = load({ route: ['crm'], loaded: withoutContacts }).view();
  assert.match(strip, /<span>Contacts<\/span><strong>—<\/strong><small>Contacts did not load<\/small>/);
  const tab = load({ route: ['crm', 'contacts'], loaded: withoutContacts, contacts: [contact('Ana', 'ana@northline.example')] }).view();
  assert.match(tab, /<h3>Contacts did not load<\/h3><p>They are tried again by themselves\.<\/p>/);
  assert.doesNotMatch(tab, /No contacts yet/);
  assert.doesNotMatch(tab, /Ana/, 'the stale global array is not drawn as if it had loaded');
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
    assert.match(html, new RegExp(`<section class="board-column"[^>]* aria-labelledby="crm-stage-${stage}"[^>]*>`), `the ${stage} column is named by its heading`);
    assert.match(html, new RegExp(`<section class="board-column"[^>]* data-crm-column="${stage}"[^>]*>`), `the ${stage} column says which stage a drop onto it means`);
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

test('the pipeline\'s six columns narrow for a phone: the plain board\'s own phone rule is not specific enough to reach crm-board, so it needs, and has, its own', () => {
  const css = readFileSync(new URL('../dist/workspace.css', import.meta.url), 'utf8');
  const desktop = css.match(/\.project-board\.stage-board\.crm-board\s*\{\s*grid-template-columns:\s*repeat\(6,\s*minmax\((\d+)px/);
  const at760 = css.match(/@media \(max-width: 760px\) \{ \.project-board\.stage-board\.crm-board \{ grid-template-columns: repeat\(6, minmax\((\d+)px/);
  const at520 = css.match(/@media \(max-width: 520px\) \{ \.project-board\.stage-board\.crm-board \{ grid-template-columns: repeat\(6, minmax\((\d+)px/);
  assert.ok(desktop && at760 && at520, 'an unconditional rule and an override at each breakpoint all exist');
  assert.ok(Number(at760[1]) < Number(desktop[1]), '760px is narrower than the unconditional default');
  assert.ok(Number(at520[1]) < Number(at760[1]), '520px narrower again');
  /* Both overrides repeat the full three-class selector — the plain
     .project-board rule elsewhere in these same breakpoints has only one
     class, so it can never win a specificity tie against this one, at any
     source order. */
  assert.ok(css.indexOf(at760[0]) > css.indexOf(desktop[0]), 'declared after the unconditional rule, so it wins the tie at the same specificity');
  assert.ok(css.indexOf(at520[0]) > css.indexOf(at760[0]), 'and 520px after 760px, so it wins at the smallest width');
});

test('while companies did not load the pipeline says so, rather than showing an empty board', () => {
  const html = load({ loaded: ['contacts'] }).view();
  assert.match(html, /Companies did not load/);
  assert.doesNotMatch(html, /crm-stage-/);
});

/* ── Filtering and sorting the companies list ────────────────────────────── */

test('the filter bar narrows the pipeline and the companies table by stage, kind and owner, each an exact match', () => {
  const sam = { id: 'e-sam', name: 'Sam Rivera' };
  const northline = company('client', 100, 'USD', { name: 'Northline', owner_id: 'e-sam' });
  const harbor = company('lead', 50, 'USD', { name: 'Harbor', kind: 'partner' });
  const kite = company('lead', 20, 'USD', { name: 'Kite Labs' });
  const list = [northline, harbor, kite];

  const byStage = load({ route: ['crm', 'companies'], companies: list, team: [sam] });
  byStage.change({ 'data-crm-filter': 'stage' }, 'lead');
  const stageFiltered = byStage.view();
  assert.match(stageFiltered, /Harbor/);
  assert.match(stageFiltered, /Kite Labs/);
  assert.doesNotMatch(stageFiltered, /Northline/);

  const byKind = load({ route: ['crm', 'companies'], companies: list, team: [sam] });
  byKind.change({ 'data-crm-filter': 'kind' }, 'partner');
  const kindFiltered = byKind.view();
  assert.match(kindFiltered, /Harbor/);
  assert.doesNotMatch(kindFiltered, /Kite Labs|Northline/);

  const byOwner = load({ route: ['crm', 'companies'], companies: list, team: [sam] });
  byOwner.change({ 'data-crm-filter': 'owner' }, 'e-sam');
  const ownerFiltered = byOwner.view();
  assert.match(ownerFiltered, /Northline/);
  assert.doesNotMatch(ownerFiltered, /Harbor|Kite Labs/);

  const unowned = load({ route: ['crm', 'companies'], companies: list, team: [sam] });
  unowned.change({ 'data-crm-filter': 'owner' }, 'unowned');
  const unownedFiltered = unowned.view();
  assert.doesNotMatch(unownedFiltered, /Northline/);
  assert.match(unownedFiltered, /Harbor/);
  assert.match(unownedFiltered, /Kite Labs/);
});

test('without the team loaded, only the owner filter is left out — a select with nobody to choose is worse than none', () => {
  const html = load({ route: ['crm', 'companies'], loaded: EVERYTHING.filter(p => p !== 'team'), companies: [company('lead', 1)] }).view();
  assert.doesNotMatch(html, /data-crm-filter="owner"/);
  assert.match(html, /data-crm-filter="stage"/);
  assert.match(html, /data-crm-sort/);
});

test('sort orders the companies table by name, by value, or by where each is in the pipeline, ties broken by name', () => {
  const alpha = company('lead', 5, 'USD', { name: 'Alpha' });
  const bravo = company('lead', 50, 'USD', { name: 'Bravo' });
  const charlie = company('client', 10, 'USD', { name: 'Charlie' });
  const h = load({ route: ['crm', 'companies'], companies: [bravo, alpha, charlie] });
  const names = html => bodyRows(html).map(r => r.match(/<strong>([^<]+)<\/strong>/)[1]);
  assert.deepEqual(names(h.view()), ['Alpha', 'Bravo', 'Charlie'], 'name is the default');
  h.change({ 'data-crm-sort': '' }, 'value');
  assert.deepEqual(names(h.view()), ['Bravo', 'Charlie', 'Alpha'], 'highest value first');
  h.change({ 'data-crm-sort': '' }, 'stage');
  assert.deepEqual(names(h.view()), ['Alpha', 'Bravo', 'Charlie'], 'two leads before the client, tied leads by name');
});

test('a Clear filters button appears only once a filter is set, and clears every one of them at once', () => {
  const h = load({ route: ['crm', 'companies'], companies: [company('lead', 10, 'USD', { name: 'Alpha' }), company('client', 20, 'USD', { name: 'Beta' })] });
  assert.doesNotMatch(h.view(), /data-crm-clear-filters/);
  h.change({ 'data-crm-filter': 'stage' }, 'lead');
  const filtered = h.view();
  assert.match(filtered, /data-crm-clear-filters/);
  assert.doesNotMatch(filtered, /Beta/);
  h.click({ 'data-crm-clear-filters': '' });
  const cleared = h.view();
  assert.doesNotMatch(cleared, /data-crm-clear-filters/);
  assert.match(cleared, /Beta/);
});

test('a filter or a search with nothing matching says so, kept apart from a CRM with nothing in it yet', () => {
  const h = load({ route: ['crm', 'companies'], companies: [company('lead', 1, 'USD', { name: 'Alpha' })] });
  h.change({ 'data-crm-filter': 'stage' }, 'lost');
  assert.match(h.view(), /No companies found/);
});

/* ── Dragging a card to another stage ────────────────────────────────────── */

test('dragging a card onto another column saves its new stage, and dropping it back on its own does nothing', async () => {
  const northline = company('lead', 1000, 'USD', { id: U1, name: 'Northline' });
  const h = load({ companies: [northline], route: ['crm'] });
  const dt = h.dataTransfer();
  h.fire('dragstart', { 'data-crm-card': U1 }, { dataTransfer: dt });
  assert.equal(dt.getData('text/plain'), U1);
  const over = h.fire('dragover', { 'data-crm-column': 'client' });
  assert.equal(over.defaultPrevented, true, 'a drop is only ever allowed once this runs');
  h.fire('drop', { 'data-crm-column': 'client' }, { dataTransfer: dt });
  await settle();
  assert.deepEqual(h.written, [['updateCompany', U1, { stage: 'client' }]]);
  assert.equal(h.toasts.at(-1), 'Northline moved to Client.');

  const same = load({ companies: [northline], route: ['crm'] });
  const dt2 = same.dataTransfer();
  same.fire('dragstart', { 'data-crm-card': U1 }, { dataTransfer: dt2 });
  same.fire('drop', { 'data-crm-column': 'lead' }, { dataTransfer: dt2 });
  await settle();
  assert.deepEqual(same.written, [], 'already there: nothing to save');
});

test('a drop with no dragged id, no matching company, or before the workspace has loaded saves nothing', async () => {
  const northline = company('lead', 1, 'USD', { id: U1, name: 'Northline' });
  const noId = load({ companies: [northline], route: ['crm'] });
  noId.fire('drop', { 'data-crm-column': 'client' }, { dataTransfer: noId.dataTransfer() });
  await settle();
  assert.deepEqual(noId.written, []);

  const goneCompany = load({ companies: [northline], route: ['crm'] });
  const dt = goneCompany.dataTransfer();
  dt.setData('text/plain', 'not-a-real-id');
  goneCompany.fire('drop', { 'data-crm-column': 'client' }, { dataTransfer: dt });
  await settle();
  assert.deepEqual(goneCompany.written, []);

  const loading = load({ companies: [northline], route: ['crm'], workspaceLoaded: false });
  const dt2 = loading.dataTransfer();
  dt2.setData('text/plain', U1);
  loading.fire('drop', { 'data-crm-column': 'client' }, { dataTransfer: dt2 });
  await settle();
  assert.deepEqual(loading.written, []);
  assert.equal(loading.toasts.at(-1), 'Not yet: the workspace is still loading.');
});

test('a stage a drop refuses to save says so in a toast, as any other CRM write does', async () => {
  const northline = company('lead', 1, 'USD', { id: U1, name: 'Northline' });
  const h = load({ companies: [northline], route: ['crm'], refuse: 'The company was not saved: it has been removed from the CRM, or you may not change it.' });
  const dt = h.dataTransfer();
  dt.setData('text/plain', U1);
  h.fire('drop', { 'data-crm-column': 'client' }, { dataTransfer: dt });
  await settle();
  assert.equal(h.toasts.at(-1), 'The company was not saved: it has been removed from the CRM, or you may not change it.');
});

/* ── Debouncing the search box ───────────────────────────────────────────── */

test('typing in the search box waits before it redraws, and a further keystroke restarts the wait, not stacks another', () => {
  const clock = fakeClock();
  const h = load({ route: ['crm', 'contacts'], contacts: [contact('Ana', 'ana@northline.example')], clock });
  const first = h.fire('input', { 'data-query': 'crm' }, { value: 'an' });
  assert.equal(first.stopped, true, 'the shared, whole-page listener does not also run for this keystroke');
  assert.equal(h.renders(), 0, 'not yet, on the keystroke alone');
  assert.equal(clock.pendingCount, 1);
  h.fire('input', { 'data-query': 'crm' }, { value: 'ana' });
  assert.equal(clock.pendingCount, 1, 'the first wait is cancelled, not left running alongside a second');
  clock.fire();
  assert.equal(h.renders(), 1, 'one redraw for the settled word, not one per letter');
  assert.equal(h.context.queries.crm, 'ana');
});

test('an input event on another view\'s search box is left to the shared listener', () => {
  const clock = fakeClock();
  const h = load({ route: ['crm'], clock });
  const result = h.fire('input', { 'data-query': 'tickets' }, { value: 'urgent' });
  assert.equal(result.stopped, false);
  assert.equal(clock.pendingCount, 0);
});

/* ── Website enquiries ────────────────────────────────────────────────── */

test('the Enquiries tab is offered to a manager and hidden from staff, in both the pipeline\'s subnav and the tab itself', () => {
  const manager = load({ route: ['crm'], manager: true });
  assert.match(manager.view(), /href="#crm\/enquiries"/);
  const staff = load({ route: ['crm'], manager: false });
  assert.doesNotMatch(staff.view(), /href="#crm\/enquiries"/);
});

test('a manager visiting Enquiries directly sees the list; staff visiting it directly are told plainly, not shown an empty inbox', () => {
  const staff = load({ route: ['crm', 'enquiries'], manager: false }).view();
  assert.match(staff, /Owners and admins only/);
  assert.doesNotMatch(staff, /Promote/);
  const manager = load({ route: ['crm', 'enquiries'], manager: true, enquiries: [] }).view();
  assert.doesNotMatch(manager, /Owners and admins only/);
});

test('enquiries load once the page is drawn, list who wrote in, and a Promote button for each not already in the CRM', () => {
  const bo = { id: 'enq-1', name: 'Bo Ahn', email: 'bo@example.com', business: 'Ahn Studio', message: 'Looking for a rebuild.', status: 'New', when: 'Sep 10', row: {} };
  const h = load({ route: ['crm', 'enquiries'], enquiries: [bo] });
  const first = h.view();
  assert.match(first, /Loading enquiries/);
  return settle().then(() => {
    assert.equal(h.renders(), 1, 'drawn again once the answer lands');
    const loaded = h.view();
    assert.match(loaded, /Bo Ahn/);
    assert.match(loaded, /bo@example\.com/);
    assert.match(loaded, /Ahn Studio/);
    assert.match(loaded, /Looking for a rebuild\./);
    assert.match(loaded, /data-crm-promote="enq-1"/);
  });
});

test('an enquiry already promoted links to the contact it became, instead of offering Promote again', async () => {
  const bo = { id: 'enq-1', name: 'Bo Ahn', email: 'bo@example.com', business: '', message: '', status: 'New', when: 'Sep 10', row: {} };
  const already = contact('Bo Ahn', 'bo@example.com', null, { enquiry_id: 'enq-1' });
  const h = load({ route: ['crm', 'enquiries'], enquiries: [bo], contacts: [already] });
  h.view();
  await settle();
  const loaded = h.view();
  assert.doesNotMatch(loaded, /data-crm-promote/);
  assert.match(loaded, new RegExp(`href="#crm/${already.id}">Already in the CRM<`));
});

test('no enquiries at all says so, and one that did not load can be asked for again', async () => {
  const empty = load({ route: ['crm', 'enquiries'], enquiries: [] });
  empty.view();
  await settle();
  assert.match(empty.view(), /No enquiries yet/);

  const failed = load({ route: ['crm', 'enquiries'], enquiriesFail: true });
  failed.view();
  await settle();
  const page = failed.view();
  assert.match(page, /Enquiries did not load/);
  assert.match(page, /data-crm-enquiries-retry/);
  failed.click({ 'data-crm-enquiries-retry': '' });
  await settle();
  assert.match(failed.view(), /Enquiries did not load/, 'failing again says so again, rather than hanging on "Loading"');
});

test('Promote calls the same RPC the site admin uses, then opens the contact it made', async () => {
  const bo = { id: 'enq-1', name: 'Bo Ahn', email: 'bo@example.com', business: '', message: '', status: 'New', when: 'Sep 10', row: {} };
  const h = load({ route: ['crm', 'enquiries'], enquiries: [bo], promoteResult: 'new-contact-9' });
  h.view();
  await settle();
  h.fire('click', { 'data-crm-promote': 'enq-1' });
  await settle();
  assert.deepEqual(h.promoted, ['enq-1']);
  assert.equal(h.toasts.at(-1), 'Added to the CRM.');
  assert.deepEqual(h.navigated, ['crm/new-contact-9']);
});

test('a refused promotion is toasted, and nothing is promoted before the workspace has loaded', async () => {
  const bo = { id: 'enq-1', name: 'Bo Ahn', email: 'bo@example.com', business: '', message: '', status: 'New', when: 'Sep 10', row: {} };
  const refused = load({ route: ['crm', 'enquiries'], enquiries: [bo], refusePromote: 'Only staff can promote an enquiry' });
  refused.view();
  await settle();
  refused.fire('click', { 'data-crm-promote': 'enq-1' });
  await settle();
  assert.equal(refused.toasts.at(-1), 'Only staff can promote an enquiry');
  assert.deepEqual(refused.navigated, []);

  const loading = load({ route: ['crm', 'enquiries'], enquiries: [bo], workspaceLoaded: false });
  loading.view();
  await settle();
  loading.fire('click', { 'data-crm-promote': 'enq-1' });
  assert.deepEqual(loading.promoted, []);
  assert.equal(loading.toasts.at(-1), 'Not yet: the workspace is still loading.');
});

test('what an enquiry carries stays text: a name, a business or a message with markup in it is shown, never run', async () => {
  const evil = { id: 'enq-1', name: TYPED, email: TYPED, business: TYPED, message: TYPED, status: 'New', when: TYPED, row: {} };
  const h = load({ route: ['crm', 'enquiries'], enquiries: [evil] });
  h.view();
  await settle();
  const page = h.view();
  assert.doesNotMatch(page, MARKUP);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
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

test('a company\'s page shows its currency, and a primary contact is named as one in the people panel', () => {
  const northline = company('client', 12000, 'EUR', { id: U1, name: 'Northline' });
  const ana = contact('Ana', 'ana@northline.example', northline, { id: U2, is_primary: true });
  const ben = contact('Ben', 'ben@northline.example', northline, { id: U3 });
  const html = load({ companies: [northline], contacts: [ana, ben], route: ['crm', 'companies', U1] }).view();
  assert.match(html, /<span>Currency<\/span><div>EUR<\/div>/);
  assert.match(html, /Primary contact · ana@northline\.example/, 'the primary contact is named as one');
  assert.doesNotMatch(section(html, 'People'), /Ben.*Primary contact/s, 'not for someone who isn\'t');
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

test('a contact\'s page names them as the primary contact, and as having come from a website enquiry', () => {
  const olivia = contact('Olivia', 'olivia@northline.example', null, { is_primary: true, enquiry_id: 'enq-1' });
  const html = load({ route: ['crm', olivia.id], contacts: [olivia] }).view();
  assert.match(html, /<span>Primary contact<\/span><div>Yes<\/div>/);
  assert.match(html, /<span>Source<\/span><div>A website enquiry<\/div>/);
  const jo = contact('Jo', '');
  const plain = load({ route: ['crm', jo.id], contacts: [jo] }).view();
  assert.match(plain, /<span>Primary contact<\/span><div>—<\/div>/);
  assert.match(plain, /<span>Source<\/span><div>—<\/div>/);
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
