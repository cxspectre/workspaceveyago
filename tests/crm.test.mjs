/* The CRM's logic, without a page: contacts and companies known by their ids,
   every company listed with its people and the work filed under it, the
   pipeline over all six stages, the records a new one may duplicate, and the
   forms as crm_companies and crm_contacts (0021, 0049) take them. Loaded into
   a sandbox the way <script> tags run it. Run from the repo root with:
   node --test

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence [...spread], and plain() for nested shapes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console });
vm.runInContext(readFileSync(new URL('../dist/crm-model.js', import.meta.url), 'utf8'), context);
const model = vm.runInContext('crmModel', context);

const plain = value => JSON.parse(JSON.stringify(value));
const ids = list => [...list].map(item => item.id);

const NORTH = 'c1000000-0000-4000-8000-000000000001';
const HARBOR = 'c1000000-0000-4000-8000-000000000002';
const QUIET = 'c1000000-0000-4000-8000-000000000003';
const GONE = 'c1000000-0000-4000-8000-0000000000ff';
const ANA = 'b1000000-0000-4000-8000-000000000001';
const BEN = 'b1000000-0000-4000-8000-000000000002';
const CY = 'b1000000-0000-4000-8000-000000000003';
const DEE = 'b1000000-0000-4000-8000-000000000004';
const EVE = 'b1000000-0000-4000-8000-000000000005';
const SITE = 'a1000000-0000-4000-8000-000000000001';
const DOCK = 'a1000000-0000-4000-8000-000000000002';
const APP = 'a1000000-0000-4000-8000-000000000003';

/* What queries.companies() hands the store: a formatted value up top, the
   row underneath. */
const company = (id, name, row = {}) => ({
  id, name, domain: row.domain || '', stage: 'Lead', kind: 'Prospect', value: '—', notes: '',
  row: { id, name, domain: null, kind: 'prospect', stage: 'lead', value: null, currency: 'USD', notes: null, ...row }
});
/* What queries.contacts() hands the store. The company comes embedded — a
   deleted one too — and a contact with none is labelled a Lead. */
const embed = (id, name, stage = 'lead', value = null, currency = 'USD') => ({ id, name, stage, value, currency });
const contact = (id, name, co, email = '') => ({
  id, name, initial: name.split(' ').map(w => w[0]).join(''), company: co ? co.name : '—',
  email, stage: 'Lead', value: '—', notes: '',
  row: { id, full_name: name, email: email || null, title: null, notes: null, company: co }
});

const companies = [
  company(NORTH, 'Northline', { domain: 'northline.example', stage: 'proposal', value: 12000, currency: 'EUR' }),
  company(HARBOR, 'Harbor & Co', { stage: 'client', value: '4800.00' }),
  company(QUIET, 'Quiet Studio', { stage: 'qualified' })
];
const contacts = [
  contact(ANA, 'Ana Lima', embed(NORTH, 'Northline', 'proposal', 12000, 'EUR'), 'ana@northline.example'),
  contact(BEN, 'Ben Boss', embed(NORTH, 'Northline', 'proposal', 12000, 'EUR')),
  contact(CY, 'Cy Harbor', embed(HARBOR, 'Harbor & Co', 'client', 4800)),
  contact(DEE, 'Dee Solo', null, 'dee@gmail.com'),
  contact(EVE, 'Eve Former', embed(GONE, 'Gone Ltd', 'client', 99000))
];
/* Projects as projectsModel.shapeProject() leaves them. */
const projects = [
  { id: SITE, name: 'Northline site', client: 'Northline', companyId: NORTH },
  { id: DOCK, name: 'Harbor dock', client: 'Harbor & Co', companyId: HARBOR },
  { id: APP, name: 'Northline', client: 'Internal product', companyId: null }
];
const ticket = (id, row) => ({ id, title: `Ticket ${id}`, client: 'Northline', product: 'Northline', row });
const tickets = [
  ticket(101, { company_id: NORTH, project_id: null, contact_id: null }),
  ticket(102, { company_id: null, project_id: SITE, contact_id: null }),
  ticket(103, { company_id: null, project_id: null, contact_id: CY }),
  ticket(104, { company_id: HARBOR, project_id: null, contact_id: ANA }),
  ticket(105, { company_id: null, project_id: null, contact_id: null }),
  ticket(106, { company_id: GONE, project_id: null, contact_id: null }),
  ticket(107, { company_id: null, project_id: DOCK, contact_id: ANA }),
  ticket(108, { company_id: NORTH, project_id: null, contact_id: BEN })
];
const event = (id, row) => ({ id, title: 'Northline kickoff', detail: 'Ana Lima · Zoom', row });
const events = [
  event('ev1', { company_id: NORTH }),
  event('ev2', { project_id: SITE }),
  event('ev3', { contact_id: BEN }),
  event('ev4', {})
];
/* finance_invoices has a client name and no ids yet; one that carries them links. */
const invoices = [
  { id: 'INV-1', uuid: 'i1', client: 'Northline', row: { client: 'Northline' } },
  { id: 'INV-2', uuid: 'i2', client: 'Someone else', row: { company_id: NORTH } },
  { id: 'INV-3', uuid: 'i3', client: 'Someone else', row: { contact_id: CY } }
];
const sources = { contacts, projects, tickets, events, invoices };

/* ── Identity ────────────────────────────────────────────────────────── */

test('a contact and a company are found by their id and by nothing else', () => {
  assert.equal(model.contactById(contacts, BEN).name, 'Ben Boss');
  assert.equal(model.companyById(companies, QUIET).name, 'Quiet Studio');
  for (const wrong of ['1', 1, '', null, undefined]) {
    assert.equal(model.contactById(contacts, wrong), null, `an old position-based link (${wrong}) opens nobody`);
    assert.equal(model.companyById(companies, wrong), null);
  }
  assert.equal(model.contactById(null, ANA), null);
});

test('a contact opens at crm/<id> and a company at crm/companies/<id>', () => {
  assert.equal(model.contactRoute(ANA), `crm/${ANA}`);
  assert.equal(model.companyRoute(companies[0]), `crm/companies/${NORTH}`);
  assert.equal(model.contactRoute(null), null);

  const page = parts => plain({ ...model.route(parts, contacts, companies), record: undefined });
  assert.deepEqual(page(['crm']), { kind: 'list', id: null, tab: null });
  assert.deepEqual(page(['crm', ANA]), { kind: 'contact', id: ANA, tab: 'overview' });
  assert.deepEqual(page(['crm', ANA, 'activity']), { kind: 'contact', id: ANA, tab: 'activity' });
  assert.deepEqual(page(['crm', 'companies']), { kind: 'companies', id: null, tab: null });
  assert.deepEqual(page(['crm', 'companies', NORTH, 'activity']), { kind: 'company', id: NORTH, tab: 'activity' });
  assert.equal(model.route(['crm', ANA], contacts, companies).record.name, 'Ana Lima');
  assert.equal(model.route(['crm', 'companies', NORTH], contacts, companies).record.name, 'Northline');
  assert.equal(model.route(['crm', '0'], contacts, companies).record, null, 'a link by place finds nobody, and says so');
});

/* ── Contacts and companies ──────────────────────────────────────────── */

test('a contact\'s company and stage are its company\'s, by id; a contact with no company is not a lead', () => {
  const people = model.contactList(contacts, companies);
  const who = id => people.find(c => c.id === id);
  assert.deepEqual([who(ANA).companyId, who(ANA).companyName, who(ANA).stage, who(ANA).stageLabel],
    [NORTH, 'Northline', 'proposal', 'Proposal']);
  assert.equal(who(ANA).route, `crm/${ANA}`);
  assert.deepEqual([who(DEE).company, who(DEE).companyId, who(DEE).stage, who(DEE).stageLabel], [null, null, null, ''],
    'queries.contacts() labels a contact with no company a Lead; nobody is a lead without a company');
  assert.deepEqual([who(EVE).company, who(EVE).stage], [null, null], 'a company that was deleted is no company');
});

test('until companies have loaded, a contact\'s own company is all there is', () => {
  const people = model.contactList(contacts, null);
  assert.equal(people.find(c => c.id === EVE).companyName, 'Gone Ltd');
  assert.equal(people.find(c => c.id === ANA).stage, 'proposal');
  assert.deepEqual([...model.contactList(null, companies)], []);
});

test('every company is listed, people or not, each once, with its value as a number', () => {
  const list = model.companyList([...companies, companies[2]], sources);
  assert.deepEqual(ids(list), [NORTH, HARBOR, QUIET], 'Quiet Studio has nobody yet and is still there, once');
  const north = list[0];
  assert.deepEqual([north.name, north.domain, north.stage, north.stageLabel, north.open, north.amount, north.currency, north.kind, north.route],
    ['Northline', 'northline.example', 'proposal', 'Proposal', true, 12000, 'EUR', 'prospect', `crm/companies/${NORTH}`]);
  assert.equal(list[1].amount, 4800, 'read from the row, not from "$4,800"');
  assert.deepEqual(ids(north.contacts), [ANA, BEN]);
  assert.deepEqual(ids(list[2].contacts), []);
  assert.equal(north.contacts[0].companyName, 'Northline');
});

/* ── Connected work ──────────────────────────────────────────────────── */

test('a company\'s work is found by ids — never by a name that looks like its own', () => {
  const list = model.companyList(companies, sources);
  const [north, harbor, quiet] = list;
  assert.deepEqual(ids(north.projects), [SITE], 'the internal project called "Northline" is not the client\'s');
  assert.deepEqual(ids(north.tickets), [101, 102, 108]);
  assert.deepEqual(ids(harbor.tickets), [103, 104, 107],
    'filed under the company, else its project\'s company, else its contact\'s — each ticket in one place');
  assert.ok(!list.some(c => c.tickets.some(t => [105, 106].includes(t.id))), 'no ids, or a deleted company: nowhere');
  assert.deepEqual(ids(north.events), ['ev1', 'ev2', 'ev3'], 'a meeting whose detail names Ana Lima is not hers by that');
  assert.deepEqual([...north.invoices].map(i => i.uuid), ['i2'], 'an invoice made out to "Northline" is not linked by its name');
  assert.deepEqual([...harbor.invoices].map(i => i.uuid), ['i3']);
  assert.deepEqual([quiet.projects.length, quiet.tickets.length, quiet.events.length], [0, 0, 0]);
});

test('one company\'s page finds the same work as the whole list', () => {
  const alone = model.companyWork(companies[1], sources);
  assert.deepEqual(ids(alone.contacts), [CY]);
  assert.deepEqual(ids(alone.projects), [DOCK]);
  assert.deepEqual(ids(alone.tickets), [103, 104, 107]);
  assert.deepEqual(ids(model.companyWork(null, sources).tickets), []);
});

test('a contact\'s page lists the projects they are on first, then their company\'s, and what is filed under them', () => {
  const later = { id: 'p-later', name: 'Northline later', client: 'Northline', companyId: NORTH };
  /* Two companies may share a name: the other Northline's project says "Northline" too. */
  const namesake = { id: 'p-namesake', name: 'The other Northline site', client: 'Northline', companyId: 'c-other-northline' };
  const links = [{ project_id: SITE, contact_id: BEN, role: 'billing' }, { project_id: DOCK, contact_id: CY, role: 'technical' }];
  const ben = model.contactWork(model.contactById(contacts, BEN),
    { ...sources, companies, projects: [later, ...projects, namesake], projectContacts: links });
  assert.deepEqual(ids(ben.projects), [SITE, 'p-later'], 'the other Northline\'s project is not theirs');
  assert.deepEqual({ ...ben.roles }, { [SITE]: 'billing' });
  assert.deepEqual(ids(ben.tickets), [108]);
  assert.deepEqual(ids(ben.events), ['ev3']);
  const ana = model.contactWork(model.contactById(contacts, ANA), { ...sources, companies });
  assert.deepEqual(ids(ana.tickets), [104, 107], 'their own tickets, whoever the tickets are filed under');
  assert.deepEqual(ids(model.contactWork(model.contactById(contacts, CY), { ...sources, companies }).invoices), ['INV-3']);
});

test('a contact without a company has only what is filed under them', () => {
  const solo = model.contactWork(model.contactById(contacts, DEE), {
    ...sources, companies, projects: [...projects, { id: 'p-dee', name: 'Dee Solo', client: 'Dee Solo', companyId: null }]
  });
  assert.deepEqual(ids(solo.projects), [], 'a project named after them is not theirs');
  assert.deepEqual(ids(model.contactWork(model.contactById(contacts, EVE), { ...sources, companies }).projects), []);
  assert.deepEqual(ids(model.contactWork(null, sources).tickets), []);
});

/* ── The pipeline ────────────────────────────────────────────────────── */

test('all six stages, in the order a relationship moves, three of them still open', () => {
  assert.deepEqual([...model.STAGES].map(s => s.value), ['lead', 'qualified', 'proposal', 'client', 'dormant', 'lost']);
  assert.deepEqual([...model.STAGES].map(s => s.label), ['Lead', 'Qualified', 'Proposal', 'Client', 'Dormant', 'Lost'],
    'the labels queries.js makes, and the pills are coloured by');
  assert.deepEqual([...model.STAGES].filter(s => s.open).map(s => s.value), ['lead', 'qualified', 'proposal']);
  assert.equal(model.stageValue('Qualified'), 'qualified');
  assert.equal(model.stageValue('dormant'), 'dormant');
  assert.equal(model.stageValue('Won'), null);
  assert.equal(model.stageLabel('lost'), 'Lost');
  assert.equal(model.stageLabel(null), '');
});

test('the board has a column for every stage, and a company on it once however many people work there', () => {
  const board = model.pipeline(model.companyList(companies, sources));
  assert.deepEqual([...board.columns].map(c => c.heading), ['Leads', 'Qualified', 'Proposals', 'Clients', 'Dormant', 'Lost']);
  assert.deepEqual([...board.columns].map(c => ids(c.companies)), [[], [QUIET], [NORTH], [HARBOR], [], []],
    'a qualified company used to be on no column at all');
  assert.equal(board.columns[2].companies[0].contacts.length, 2, 'a card keeps its people');
  assert.deepEqual(plain(board.columns[2].totals), [{ currency: 'EUR', amount: 12000 }], 'Northline has two people and one value');
  assert.deepEqual(plain(board.open), { count: 2, totals: [{ currency: 'EUR', amount: 12000 }] });
});

test('pipeline value is the open deals, each company once, never adding one currency to another', () => {
  const board = model.pipeline([
    company('co-lead', 'Lead Co', { stage: 'lead', value: 10000 }),
    company('co-qualified', 'Qualified Co', { stage: 'qualified', value: '2500.10' }),
    company('co-proposal', 'Proposal Co', { stage: 'proposal', value: 5000.5, currency: 'EUR' }),
    company('co-client', 'Client Co', { stage: 'client', value: 12000 }),
    company('co-dormant', 'Dormant Co', { stage: 'dormant', value: 7000 }),
    company('co-lost', 'Lost Co', { stage: 'lost', value: 99999 }),
    company('co-lead', 'Lead Co', { stage: 'lead', value: 10000 })
  ]);
  assert.deepEqual(plain(board.open), { count: 3, totals: [{ currency: 'EUR', amount: 5000.5 }, { currency: 'USD', amount: 12500.1 }] },
    'a lost or dormant deal is not pipeline, and a company listed twice counts once');
  assert.deepEqual([...board.columns].map(c => c.count), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(plain(board.columns[3].totals), [{ currency: 'USD', amount: 12000 }]);
  assert.deepEqual(plain(board.columns[5].totals), [{ currency: 'USD', amount: 99999 }]);
});

test('a company with no value still counts, and a code stored before 0049 is not added to dollars', () => {
  const board = model.pipeline([
    company('a', 'A', { value: '0.57', currency: 'eur' }),
    company('b', 'B', { value: '1.13', currency: 'EUR' }),
    company('c', 'C', { value: 300, currency: 'US$' }),
    company('d', 'D', { value: 5, currency: '' }),
    company('e', 'E', { value: null }),
    company('f', 'F', { value: 'lots' })
  ]);
  assert.equal(board.open.count, 6);
  assert.deepEqual(plain(board.open.totals), [
    { currency: 'EUR', amount: 1.7 }, { currency: 'US$', amount: 300 }, { currency: 'USD', amount: 5 }
  ], 'added in cents: as floating point, 0.57 and 1.13 make 1.6999999999999997; a blank code is the database default');
  assert.deepEqual(plain(model.pipeline(null).open), { count: 0, totals: [] });
});

/* ── Duplicates ──────────────────────────────────────────────────────── */

test('a domain is kept the way crm_companies keeps it: bare, and in lower case', () => {
  for (const typed of ['northline.example', 'NORTHLINE.example', 'https://www.northline.example/about?x=1#top',
                       'http://northline.example:8080', 'ana@northline.example', 'northline.example.']) {
    assert.equal(model.domainKey(typed), 'northline.example', typed);
  }
  assert.equal(model.domainKey(null), '');
});

test('a company that may already exist is found by its name, however it is written', () => {
  const list = [company('n1', 'Northline GmbH'), company('n2', 'Müller Design'), company('n3', 'Harbor & Co.'), company('n4', 'Northline Studio')];
  const found = name => [...model.duplicateCompanies(list, { name })].map(d => d.id);
  assert.deepEqual(found('northline'), ['n1']);
  assert.deepEqual(found('NORTHLINE B.V.'), ['n1'], 'a legal form is not part of the name');
  assert.deepEqual(found('Muller  design'), ['n2'], 'accents and spacing do not make a second company');
  assert.deepEqual(found('Harbor and Co'), ['n3']);
  assert.deepEqual(found('Harbor'), ['n3']);
  assert.deepEqual(found('Northline Studios'), [], 'a different name is a different company');
  assert.deepEqual(found('   '), []);
  assert.deepEqual([...model.duplicateCompanies(list, { name: 'Northline GmbH' }, 'n1')], [], 'a company being edited is not its own duplicate');
  const hit = model.duplicateCompanies(list, { name: 'northline' })[0];
  assert.deepEqual(plain({ ...hit, record: undefined }),
    { id: 'n1', name: 'Northline GmbH', route: 'crm/companies/n1', reasons: ['name'], blocking: false });
});

test('a company is found by its domain, typed as a web address or on someone\'s email address', () => {
  const list = [
    company(NORTH, 'Northline', { domain: 'northline.example' }),
    company('old', 'Old Harbor', { domain: 'www.harbor.example' }),
    company('mailbox', 'Somebody at Gmail', { domain: 'gmail.com' })
  ];
  const seen = found => plain([...found].map(d => [d.id, d.reasons, d.blocking]));
  assert.deepEqual(seen(model.duplicateCompanies(list, { name: 'North Line', domain: 'https://www.Northline.example/contact' })),
    [[NORTH, ['domain'], true]], 'one live company per domain (0021): refused here before the database refuses it');
  assert.deepEqual(seen(model.duplicateCompanies(list, { domain: 'harbor.example' })), [['old', ['domain'], false]],
    'stored as www.harbor.example it would not collide, but it is the same company');
  assert.deepEqual(seen(model.duplicateCompanies(list, { name: 'New Co', email: 'Ana@northline.example' })), [[NORTH, ['domain'], false]],
    'a new contact\'s address points at the company they work for');
  assert.deepEqual([...model.duplicateCompanies(list, { email: 'dee@gmail.com' })], [], 'a public mailbox is nobody\'s company (0049)');
  assert.equal(model.isPublicMail('gmx.de'), true);
  assert.equal(model.isPublicMail('northline.example'), false);
});

test('a contact with the same address is refused before the database refuses it; the same name is only asked about', () => {
  const seen = found => plain([...found].map(d => [d.id, d.reasons, d.blocking]));
  assert.deepEqual(seen(model.duplicateContacts(contacts, { name: 'Anna Lima', email: ' ANA@Northline.example ' })), [[ANA, ['email'], true]]);
  assert.deepEqual(seen(model.duplicateContacts(contacts, { name: 'ana  lima', email: 'ana.lima@elsewhere.example' })), [[ANA, ['name'], false]]);
  assert.deepEqual(seen(model.duplicateContacts(contacts, { name: 'Ana Lima', email: 'ana@northline.example' })), [[ANA, ['name', 'email'], true]]);
  assert.equal(model.duplicateContacts(contacts, { email: 'ana@northline.example' })[0].route, `crm/${ANA}`);
  assert.deepEqual([...model.duplicateContacts(contacts, { name: 'Ana Lima', email: 'ana@northline.example' }, ANA)], [],
    'a contact being edited is not their own duplicate');
  assert.deepEqual([...model.duplicateContacts(contacts, { name: '', email: '' })], []);
});

/* ── Forms ───────────────────────────────────────────────────────────── */

test('a new contact needs only a name: no company and no address', () => {
  const form = model.contactForm({ name: '  Ana Lima ', company: '', email: '' });
  assert.equal(form.problem, null);
  assert.deepEqual({ ...form.values }, { fullName: 'Ana Lima', companyId: null, email: null, phone: null, title: null, notes: null });
  assert.equal(form.company, '', 'crm_contacts.company_id may be null, and email too');
  const full = model.contactForm({ name: 'Ana Lima', company: ' Northline  Studio ', email: ' Ana@Northline.Example ', title: 'Founder', notes: 'Met at\r\nthe fair\n' });
  assert.deepEqual({ ...full.values }, { fullName: 'Ana Lima', companyId: null, email: 'ana@northline.example', phone: null, title: 'Founder', notes: 'Met at\nthe fair' });
  assert.equal(full.company, 'Northline Studio');
});

test('a new contact that cannot be saved says why, and which field', () => {
  assert.deepEqual(plain(model.contactForm({ name: '   ', email: 'ana@northline.example' })),
    { values: {}, company: '', problem: 'A contact needs a name.', field: 'name' });
  for (const bad of ['ana', 'ana@northline', 'ana @northline.example', 'ana@@northline.example', '@northline.example']) {
    const form = model.contactForm({ name: 'Ana Lima', email: bad });
    assert.match(String(form.problem), /address/, `"${bad}" is refused`);
    assert.equal(form.field, 'email');
  }
});

test('a new company takes the database\'s defaults, and refuses what the database would', () => {
  const bare = model.companyForm({ name: ' Northline ' });
  assert.equal(bare.problem, null);
  assert.deepEqual({ ...bare.values }, { name: 'Northline', domain: null, kind: 'prospect', stage: 'lead', value: null, currency: 'USD', notes: null, ownerId: null });
  const typed = model.companyForm({ name: 'Northline', domain: 'https://www.Northline.example/about', kind: 'Client', stage: 'Proposal', value: '12.500,50', currency: 'eur' });
  assert.deepEqual([typed.values.domain, typed.values.kind, typed.values.stage, typed.values.value, typed.values.currency],
    ['northline.example', 'client', 'proposal', 12500.5, 'EUR']);
  const refused = (fields, pattern, field) => {
    const form = model.companyForm({ name: 'Northline', ...fields });
    assert.match(String(form.problem), pattern, JSON.stringify(fields));
    assert.equal(form.field, field);
    assert.deepEqual({ ...form.values }, {});
  };
  refused({ name: '  ' }, /needs a name/, 'name');
  refused({ stage: 'Won' }, /stage/, 'stage');
  refused({ kind: 'Vendor' }, /kind/, 'kind');
  refused({ currency: 'US$' }, /currency/, 'currency');
  refused({ value: '-5' }, /amount/, 'value');
  refused({ value: '1,2345' }, /amount/, 'value');
  refused({ value: '99999999999' }, /large/, 'value');
  refused({ domain: 'northline' }, /domain/, 'domain');
  refused({ domain: 'gmail.com' }, /public mailbox/, 'domain');
});

test('editing a contact sends only what changed, as the columns it lives in', () => {
  const ana = model.contactById(contacts, ANA);
  const same = model.contactChanges(ana, { name: 'Ana Lima ', email: 'ANA@northline.example', title: '', companyId: NORTH });
  assert.equal(same.problem, null);
  assert.deepEqual({ ...same.changes }, {}, 'a form nobody touched changes nothing');
  const edit = model.contactChanges(ana, { name: 'Ana Lima-Park', email: '', title: 'CEO', companyId: '' });
  assert.deepEqual({ ...edit.changes }, { full_name: 'Ana Lima-Park', email: null, title: 'CEO', company_id: null });
  assert.deepEqual({ ...model.contactChanges(ana, { phone: '+31 6 1234 5678' }).changes }, { phone: '+31 6 1234 5678' },
    'a field the form did not send is left as it is');
  assert.match(model.contactChanges(ana, { name: ' ' }).problem, /name/);
  assert.equal(model.contactChanges(ana, { email: 'ana@' }).field, 'email');
});

test('editing a company sends only what changed; a stage is saved as the database spells it', () => {
  const north = companies[0];
  assert.deepEqual({ ...model.companyChanges(north, { stage: 'Client' }).changes }, { stage: 'client' });
  const same = model.companyChanges(north, {
    name: 'Northline', domain: 'https://northline.example/', kind: 'Prospect', stage: 'proposal', value: '12,000', currency: 'EUR', notes: ''
  });
  assert.equal(same.problem, null);
  assert.deepEqual({ ...same.changes }, {});
  assert.deepEqual({ ...model.companyChanges(north, { value: '', domain: '', ownerId: 'e1' }).changes }, { domain: null, value: null, owner_id: 'e1' });
  assert.match(model.companyChanges(north, { stage: 'Won' }).problem, /stage/);
  assert.match(model.companyChanges(north, { value: 'lots' }).problem, /amount/);
  assert.match(model.companyChanges(north, { domain: 'hotmail.com' }).problem, /public mailbox/);
  const legacy = company('legacy', 'Legacy', { domain: 'gmail.com' });
  assert.deepEqual(plain(model.companyChanges(legacy, { domain: 'gmail.com', stage: 'qualified' })),
    { changes: { stage: 'qualified' }, problem: null, field: null }, 'a domain stored earlier is not this edit\'s problem while it stays');
});

test('a company still holding a currency from before 0049 is given a code in the same change', () => {
  const old = company('old', 'Old Co', { currency: 'US$', value: 900 });
  const refused = model.companyChanges(old, { stage: 'Client' });
  assert.match(refused.problem, /US\$/);
  assert.equal(refused.field, 'currency');
  assert.deepEqual({ ...refused.changes }, {}, 'the database refuses any change to the row until its code is fixed');
  assert.deepEqual({ ...model.companyChanges(old, { stage: 'Client', currency: 'usd' }).changes }, { stage: 'client', currency: 'USD' });
  assert.equal(model.companyChanges(old, { stage: 'lead', currency: 'US$' }).problem, null, 'a form nobody touched is not refused');
  assert.deepEqual({ ...model.companyChanges(company('lower', 'Lower', { currency: 'eur' }), { currency: 'eur' }).changes }, { currency: 'EUR' });
});

/* numeric(12,2) takes a negative value, which this form would never type. An
   edit form fills the field with String(value), "-500", and sends it back. */
test('a value stored outside the form\'s rules, like a negative one, is judged only when it changes', () => {
  const owed = company('owed', 'Owed Co', { value: -500 });
  const same = model.companyChanges(owed, { value: String(-500), stage: 'Client' });
  assert.equal(same.problem, null, 'the stored value, sent back as it was, is not this edit\'s problem');
  assert.deepEqual({ ...same.changes }, { stage: 'client' }, 'and it is not wiped either');
  assert.match(String(model.companyChanges(owed, { value: '-400' }).problem), /amount/, 'a new negative value is still refused');
  assert.deepEqual({ ...model.companyChanges(owed, { value: '400' }).changes }, { value: 400 });
  assert.deepEqual({ ...model.companyChanges(owed, { value: '' }).changes }, { value: null });
});

/* ── Search ──────────────────────────────────────────────────────────── */

test('search finds a company by its people, and a contact by their company', () => {
  const [north] = model.companyList(companies, sources);
  assert.equal(model.matchesQuery(north, 'ana@north'), true);
  assert.equal(model.matchesQuery(north, 'BEN'), true);
  assert.equal(model.matchesQuery(north, 'northline.example'), true);
  assert.equal(model.matchesQuery(north, 'harbor'), false);
  const ana = model.contactList(contacts, companies).find(c => c.id === ANA);
  assert.equal(model.matchesQuery(ana, 'northline'), true);
  assert.equal(model.matchesQuery(ana, '  '), true, 'no search is everything');
});
