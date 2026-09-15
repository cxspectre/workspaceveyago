/* The Company page, as workspace.js draws it: the team in the order
   companyModel.teamCards reads it (owners, then admins, then the rest, each
   group by name — not the spelling of the role, which put the owner last and
   left the first card's styling to whoever happened to be there), a person's
   page with what companyModel.personDetails answers (email, phone where it is
   shown, start date, invitation status, and a real "currently focused on"
   rather than an always-empty line), the studio's own profile
   (companyModel.studioProfile) in place of what used to be written into the
   page, and its connections (companyModel.connectionRows). The page helpers
   are workspace.js's own, loaded from the file, beside the real models it
   reads; the store's lists and app.js's few globals are stand-ins. Loaded
   into a sandbox the way <script> tags run it.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'Europe/Amsterdam';
const TODAY = '2026-09-15';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNotFound = html => /This record is unavailable\./.test(html);

/* The page helpers workspace.js draws with — from `const matches` through
   personDetail() — the same slice tests/crm-ui.test.mjs takes for the CRM. */
const HELPERS = (() => {
  const lines = readFileSync(new URL('../dist/workspace.js', import.meta.url), 'utf8').split('\n');
  const from = lines.findIndex(line => line.startsWith('const matches'));
  const to = lines.findIndex(line => line.startsWith('function personDetail(id){'));
  assert.ok(from >= 0 && to > from, 'the page helpers are where this test looks for them in workspace.js');
  return lines.slice(from, to + 1).join('\n');
})();

const OWNER = 'e1000000-0000-4000-8000-000000000001';
const ADMIN = 'e1000000-0000-4000-8000-000000000003';
const EMPLOYEE = 'e1000000-0000-4000-8000-000000000005';

/* An employees row exactly as queries.team() now shapes one under `.row`
   (0061: user_id, email, start_date, created_at, updated_at included). */
const row = (id, full_name, role, email, over = {}) => ({
  id, user_id: `u-${id.slice(-2)}`, email, full_name, role, title: null, status: 'active',
  start_date: null, created_at: '2026-01-05T10:00:00Z', updated_at: '2026-01-05T10:00:00Z', ...over
});
const card = (id, name, initial, r) => ({ id, name, initial, role: r.title || r.role, tag: r.role, row: r });

const zoe = row(ADMIN, 'Zoë Adler', 'admin', 'zoe@veyago.cloud');
const cassian = row(OWNER, 'Cassian Drefke', 'owner', 'cassian@veyago.cloud', { title: 'Founder' });
const bo = row(EMPLOYEE, 'Bo Berg', 'employee', 'bo@veyago.cloud');
/* In the order `.order('role')` used to hand them over — admin, owner, bo —
   the order the old sort left the owner last in. */
const TEAM = [card(ADMIN, 'Zoë Adler', 'ZA', zoe), card(OWNER, 'Cassian Drefke', 'CD', cassian), card(EMPLOYEE, 'Bo Berg', 'BB', bo)];

function load({ route = ['company'], team = TEAM, tickets = [], projects = [], manager = true,
  viewer = null, integrations = [], studioProfile = [], loaded = ['team', 'integrations', 'studioProfile'], priv = null } = {}) {
  const context = vm.createContext({
    console,
    esc: escape,
    icon: name => `<svg data-icon="${name}"></svg>`,
    pill: (label, tone) => `<span class="pill${tone ? ' ' + tone : ''}">${escape(label)}</span>`,
    page: 'company',
    navs: [['overview', 'Overview'], ['company', 'Company']],
    queries: { company: '' },
    workspaceData: { initials: name => (String(name).trim()[0] || '?').toUpperCase() },
    isManagerNow: () => manager,
    workspaceSession: { employee: viewer },
    routeParts: route,
    CAL: { dayKey: () => TODAY },
    team, tickets, projects,
    workspaceStore: {
      has: part => loaded.includes(part),
      state: { integrations, studioProfile },
      askEmployeePrivate: () => priv
    },
    document: { addEventListener: () => {} }
  });
  context.window = context;
  vm.runInContext(HELPERS, context);
  for (const file of ['overview-model.js', 'projects-model.js', 'tickets-model.js', 'company-model.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  return { context };
}

const call = (context, name, ...args) => vm.runInContext(`${name}(${args.map(a => JSON.stringify(a)).join(',')})`, context);

/* ── The team ─────────────────────────────────────────────────────────── */

test('team cards are grouped owner, admin, then the rest — not by the spelling of the role — and never invent an initial', () => {
  const { context } = load();
  const html = call(context, 'companyView');
  const order = [...html.matchAll(/company\/people\/(e1000000-0000-4000-8000-00000000000[135])/g)].map(m => m[1]);
  assert.deepEqual(order, [OWNER, ADMIN, EMPLOYEE], 'the owner leads, not the admin the old alphabetical order put first');
  assert.match(html, /class="avatar owner">CD</, 'the owner\'s own card gets the owner styling, from the real role — not whichever card is first');
  assert.doesNotMatch(html, /class="avatar owner">ZA/, 'an admin is not styled as the owner');
});

test('a card counts tickets and projects by id, never by matching initials', () => {
  const { context } = load({
    tickets: [{ id: 1, uuid: 't1', assigneeId: OWNER, status: 'Open' }, { id: 2, uuid: 't2', assigneeId: ADMIN, status: 'Open' }],
    projects: [{ id: 'p1', ownerId: OWNER }]
  });
  const html = call(context, 'companyView');
  const cards = [...html.matchAll(/company\/people\/([^"]+)"[\s\S]*?person-work-count">([\s\S]*?)<\/div><\/div><\/a>/g)];
  const forOwner = cards.find(m => m[1] === OWNER)[2];
  assert.match(forOwner, /1 open ticket/);
  assert.match(forOwner, /1 owned project/);
  const forAdmin = cards.find(m => m[1] === ADMIN)[2];
  assert.match(forAdmin, />1 open ticket/);
  assert.match(forAdmin, />0 owned project/);
});

test('an invited card says so, and Invite someone is offered to a manager alone', () => {
  const invited = row(EMPLOYEE, 'Ivy Chen', 'employee', 'ivy@veyago.cloud', { status: 'invited', user_id: null });
  const { context } = load({ team: [...TEAM.slice(0, 2), card(EMPLOYEE, 'Ivy Chen', 'IC', invited)] });
  const managerHtml = call(context, 'companyView');
  assert.match(managerHtml, /Invited/);
  assert.match(managerHtml, /data-invite-open/);
  const staff = load({ team: [...TEAM.slice(0, 2), card(EMPLOYEE, 'Ivy Chen', 'IC', invited)], manager: false });
  assert.doesNotMatch(call(staff.context, 'companyView'), /data-invite-open/, 'staff are not offered an invite button');
});

test('the team not loaded, or loaded but empty, each say so — neither invents a card', () => {
  const empty = load({ team: [] });
  assert.match(call(empty.context, 'companyView'), /Nobody on the team yet\./);
  const failed = load({ team: [], loaded: ['integrations', 'studioProfile'] });
  assert.match(call(failed.context, 'companyView'), /The team did not load\. It is tried again by itself\./);
});

/* ── A person's page ──────────────────────────────────────────────────── */

test('a person\'s page shows their email, an invited status, and no phone or note nobody may see', () => {
  const { context } = load({ viewer: { id: ADMIN, full_name: 'Zoë Adler', email: 'zoe@veyago.cloud', role: 'admin', title: null, status: 'active' } });
  const html = call(context, 'personDetail', OWNER);
  assert.match(html, /cassian@veyago\.cloud/);
  assert.match(html, /Owner/);
  assert.doesNotMatch(html, /Phone/, 'not shown to an admin looking at the owner\'s own record');
  assert.doesNotMatch(html, /Internal note/, 'no note field at all when nothing came back for it');
});

test('a manager sees a colleague\'s phone once it has loaded, and their start date', () => {
  const dated = row(EMPLOYEE, 'Bo Berg', 'employee', 'bo@veyago.cloud', { start_date: '2025-03-10' });
  const { context } = load({
    team: [...TEAM.slice(0, 2), card(EMPLOYEE, 'Bo Berg', 'BB', dated)],
    viewer: { id: OWNER, full_name: 'Cassian Drefke', email: 'cassian@veyago.cloud', role: 'owner', title: null, status: 'active' },
    priv: { phone: '+1 555 0100', notes: 'Great with clients' }
  });
  const html = call(context, 'personDetail', EMPLOYEE);
  assert.match(html, /\+1 555 0100/);
  assert.match(html, /March 10, 2025/);
  assert.match(html, /Great with clients/);
});

test('"currently focused on" lists a real unticked task on active work, not an empty line', () => {
  const { context } = load({
    projects: [{ id: 'p1', name: 'Northline site', status: 'In progress', tasks: ['Wireframes'], checked: [],
      taskAssignees: [OWNER], taskDueOn: ['2026-09-20'], taskDue: ['Sep 20'], taskIds: ['task-1'] }]
  });
  const html = call(context, 'personDetail', OWNER);
  assert.match(html, /Currently focused on/);
  assert.match(html, /Wireframes/);
  assert.match(html, /Due Sep 20/);
});

test('a stale link to someone gone from the team says the record is unavailable, not a page with nothing on it', () => {
  const { context } = load();
  assert.ok(isNotFound(call(context, 'personDetail', 'nobody-here')));
});

test('"Change role or status" is offered on a colleague\'s page, never on your own, and not to an admin looking at the owner\'s', () => {
  const managerOnBo = load({ viewer: { id: OWNER, full_name: 'Cassian Drefke', email: 'cassian@veyago.cloud', role: 'owner', title: null, status: 'active' } });
  assert.match(call(managerOnBo.context, 'personDetail', EMPLOYEE), /data-employee-edit="e1000000-0000-4000-8000-000000000005"/);

  const ownOwnPage = load({ viewer: { id: OWNER, full_name: 'Cassian Drefke', email: 'cassian@veyago.cloud', role: 'owner', title: null, status: 'active' } });
  assert.doesNotMatch(call(ownOwnPage.context, 'personDetail', OWNER), /data-employee-edit/, 'nobody changes their own role or status');

  const adminOnOwner = load({ viewer: { id: ADMIN, full_name: 'Zoë Adler', email: 'zoe@veyago.cloud', role: 'admin', title: null, status: 'active' } });
  assert.doesNotMatch(call(adminOnOwner.context, 'personDetail', OWNER), /data-employee-edit/, 'only an owner changes an owner');

  const staffOnBo = load({ manager: false, viewer: { id: ADMIN, full_name: 'Zoë Adler', email: 'zoe@veyago.cloud', role: 'employee', title: null, status: 'active' } });
  assert.doesNotMatch(call(staffOnBo.context, 'personDetail', EMPLOYEE), /data-employee-edit/, 'staff are never offered it');
});

/* ── The studio tab ───────────────────────────────────────────────────── */

test('the studio profile comes from the database, not text written into the page, and falls back to the studio\'s defaults when there is none', () => {
  const filled = load({ route: ['company', 'studio'], studioProfile: [
    { key: 'studio_name', value: 'Northline Studio' }, { key: 'studio_email', value: 'hello@northline.example' }
  ] });
  const html = call(filled.context, 'companyView');
  assert.match(html, /Northline Studio/);
  assert.match(html, /hello@northline\.example/);
  assert.doesNotMatch(html, /Veyago Inc\./, 'the hand-written name is gone once a real one is stored');

  const blank = load({ route: ['company', 'studio'], studioProfile: [] });
  assert.match(call(blank.context, 'companyView'), /Veyago Inc\./, 'the studio\'s own defaults still show with nothing stored');
});

test('Edit profile is offered to a manager and nobody else', () => {
  const manager = load({ route: ['company', 'studio'] });
  assert.match(call(manager.context, 'companyView'), /data-studio-edit/);
  const staff = load({ route: ['company', 'studio'], manager: false });
  assert.doesNotMatch(call(staff.context, 'companyView'), /data-studio-edit/);
});

const OWNER_VIEWER = { id: OWNER, full_name: 'Cassian Drefke', email: 'cassian@veyago.cloud', role: 'owner', title: null, status: 'active' };

test('connections show their provider, whose they are, and when they last synced', () => {
  const { context } = load({ route: ['company', 'studio'], viewer: OWNER_VIEWER, integrations: [
    { id: 'c1', provider: 'microsoft_mail', account_label: 'hello@veyago.cloud', employee_id: null, status: 'connected', last_synced_at: '2026-09-15T08:00:00Z', last_error: null }
  ] });
  const html = call(context, 'companyView');
  assert.match(html, /Outlook mail/);
  assert.match(html, /Studio/);
  assert.match(html, /Last synced/);
});

test('integrations that did not load say so, and an empty list says nothing is connected', () => {
  const failed = load({ route: ['company', 'studio'], loaded: ['team', 'studioProfile'] });
  assert.match(call(failed.context, 'companyView'), /Integrations did not load\. They are tried again by themselves\./);
  const none = load({ route: ['company', 'studio'], viewer: OWNER_VIEWER, integrations: [] });
  assert.match(call(none.context, 'companyView'), /Nothing connected yet\./);
});
