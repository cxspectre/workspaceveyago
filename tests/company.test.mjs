/* The Company page's logic, without a page: the team in the order a studio
   reads it, one person's page, who may change whose role or status, the
   invitation form, the studio's profile and its connections — each as the
   database decides it (0005, 0016, 0024, 0036, 0038, 0041, 0042, 0043, 0044)
   and as invite-employee and microsoft-connect ask it (_shared/team-rules.ts,
   _shared/connection-rules.ts). Loaded into a sandbox the way <script> tags
   run it, with the time zone moved the way calendar.test.mjs moves it. Run
   from the repo root with: node --test

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence [...spread] and plain(). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/company-model.js', import.meta.url), 'utf8');
const context = vm.createContext({ console });
vm.runInContext(source, context);
const model = vm.runInContext('companyModel', context);

const plain = value => JSON.parse(JSON.stringify(value));

function inZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const OWNER = 'e1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'e1000000-0000-4000-8000-000000000002';
const ADMIN = 'e1000000-0000-4000-8000-000000000003';
const ASSISTANT = 'e1000000-0000-4000-8000-000000000004';
const EMPLOYEE = 'e1000000-0000-4000-8000-000000000005';
const INVITED = 'e1000000-0000-4000-8000-000000000006';
const GONE = 'e1000000-0000-4000-8000-000000000007';
const OTHER = 'e1000000-0000-4000-8000-0000000000ff';

/* An employees row as the team directory reads it: 0043's column grant. */
const member = (id, full_name, role, email, over = {}) => ({
  id, user_id: `u-${id.slice(-2)}`, email, full_name, role, title: null, status: 'active',
  start_date: null, created_at: '2026-01-05T10:00:00+00:00', updated_at: '2026-01-05T10:00:00+00:00', ...over
});

const cassian = member(OWNER, 'Cassian Drefke', 'owner', 'cassian@veyago.cloud', { title: 'Founder' });
const maya = member(CO_OWNER, 'Maya Stone', 'owner', 'maya@veyago.cloud');
const zoe = member(ADMIN, 'Zoë Adler', 'admin', 'zoe@veyago.cloud');
const ana = member(ASSISTANT, 'Ana Lima', 'assistant', 'ana@veyago.cloud', { title: 'Personal Assistant' });
const bo = member(EMPLOYEE, 'Bo Berg', 'employee', 'bo@veyago.cloud');
const ivy = member(INVITED, 'Ivy Chen', 'employee', 'ivy@veyago.cloud', { status: 'invited', user_id: null });
const gus = member(GONE, 'Gus Moreau', 'admin', 'gus@veyago.cloud', { status: 'inactive' });
/* In the order `.order('role')` used to hand them over: by the role's spelling. */
const TEAM = [zoe, gus, ana, bo, ivy, cassian];

/* The signed-in person as workspaceSession.employee has them: no user_id. */
const viewer = row => ({ id: row.id, full_name: row.full_name, email: row.email, role: row.role, title: row.title, status: row.status });

const OWN = 'Nobody can change their own role or status. Ask another owner or admin.';
const KEEP = 'The studio needs an owner who can sign in. Make someone else an owner first.';

/* ── One global ──────────────────────────────────────────────────────── */

test('the model is one global, companyModel, and leaves nothing else behind', () => {
  const fresh = vm.createContext({});
  const names = () => [...vm.runInContext('Object.getOwnPropertyNames(globalThis)', fresh)];
  const had = new Set(names());
  vm.runInContext(source, fresh);
  assert.deepEqual(names().filter(name => !had.has(name)), []);
  assert.equal(vm.runInContext('typeof companyModel', fresh), 'object');
  assert.ok(Object.isFrozen(vm.runInContext('companyModel', fresh)));
});

/* ── Labels ──────────────────────────────────────────────────────────── */

test('roles and statuses are the ones employees can hold, labelled for people (0005)', () => {
  assert.deepEqual([...model.ROLES].map(r => r.value), ['owner', 'admin', 'assistant', 'employee']);
  assert.deepEqual([...model.STATUSES].map(s => s.value), ['active', 'invited', 'inactive']);
  assert.deepEqual(['owner', 'admin', 'assistant', 'employee'].map(r => model.roleLabel(r)), ['Owner', 'Admin', 'Assistant', 'Employee']);
  assert.deepEqual(['active', 'invited', 'inactive'].map(s => model.statusLabel(s)), ['Active', 'Invited', 'Deactivated']);
  assert.equal(model.roleLabel('Owner'), 'Owner', 'a label reads as itself');
  assert.equal(model.statusLabel(' Invited '), 'Invited');
  for (const bad of ['manager', 'deleted', '', null, undefined, 42]) {
    assert.equal(model.roleLabel(bad), '', String(bad));
    assert.equal(model.statusLabel(bad), '', String(bad));
  }
});

/* ── Initials ────────────────────────────────────────────────────────── */

test('initials are the first letters of a name\'s first and last words', () => {
  assert.equal(model.initials('Cassian Drefke'), 'CD');
  assert.equal(model.initials('Ana María da Silva Lima'), 'AL');
  assert.equal(model.initials('  bo \t  berg '), 'BB', 'lower case, tabs and extra spaces');
  assert.equal(model.initials('Cassian'), 'C', 'a one-word name has one initial, not a second one made up');
  assert.equal(model.initials('Jean-Luc Picard'), 'JP');
  assert.equal(model.initials('Robert "Bob" O’Brien'), 'RO', 'a quote in front of a word is not its first letter');
});

test('an accented initial is the letter as written, whether it was stored composed or not', () => {
  assert.equal(model.initials('émile zola'), 'ÉZ');
  const decomposed = model.initials('Émile Zola');
  assert.equal(decomposed, 'ÉZ');
  assert.equal(decomposed.length, 2, 'one character each: the accent is not left behind or split off');
  assert.equal(model.initials('Łukasz Żuławski'), 'ŁŻ');
  assert.equal(model.initials('김민수'), '김', 'a script with no capitals');
  assert.equal(model.initials('김민수'.normalize('NFD')), '김', 'a syllable stored as its separate jamo is still one letter');
  assert.equal(model.initials('ßen'), 'ß', 'a letter whose capital is two letters is left as it is');
  assert.equal(model.initials('ΐδα'), 'Ϊ́', 'a capital that comes back in pieces is put back together');
});

test('an initial never ends in a virama, which would join it to the next initial as one conjunct', () => {
  assert.equal(model.initials('प्रिया शर्मा'), 'पश', 'प् and श made प्श, one syllable that is neither of them');
  assert.equal(model.initials('श्रीदेवी'), 'श', 'nor is one left dangling after a one-word name');
  const viramas = {
    Devanagari: 0x094D, Bengali: 0x09CD, Gurmukhi: 0x0A4D, Gujarati: 0x0ACD, Oriya: 0x0B4D, Tamil: 0x0BCD,
    Telugu: 0x0C4D, Kannada: 0x0CCD, Malayalam: 0x0D4D, Sinhala: 0x0DCA, Thai: 0x0E3A, Tibetan: 0x0F84,
    Myanmar: 0x1039, 'Myanmar asat': 0x103A, Khmer: 0x17D2, Balinese: 0x1B44, Javanese: 0xA9C0, Brahmi: 0x11046
  };
  for (const [script, codePoint] of Object.entries(viramas)) {
    assert.equal(model.initials(`क${String.fromCodePoint(codePoint)}र श`), 'कश', script);
  }
  assert.equal(model.initials('किरण ज़ैदी'), 'किज़ै',
    'a vowel sign and a nukta are their letter\'s own, and stay: कि and ज़ै');
  assert.equal(model.initials('ọ́lá Adé'), 'Ọ́A', 'and so is a tone mark no single character has, as Yoruba writes Ọ́');
  assert.equal(model.initials('שְׁמוּאֵל'), 'שְׁ',
    'and Hebrew points: a sheva is no virama, though its class is the next one up');
});

test('emoji are not letters: they are passed over, and never cut in half', () => {
  assert.equal(model.initials('🦊 Fox'), 'F');
  assert.equal(model.initials('Ana 🌸'), 'A');
  assert.equal(model.initials('🌸Ana Lima'), 'AL', 'a letter after an emoji is still the word\'s first letter');
  const halves = /[\uD800-\uDFFF]/;
  for (const name of ['👩‍💻', '🚀 🛰️', '👨‍👩‍👧 Park']) {
    assert.equal(halves.test(model.initials(name, 'dev@veyago.cloud')), false, name);
  }
  assert.equal(model.initials('👩‍💻 🚀', 'dev.team@veyago.cloud'), 'DT', 'a name with no letters falls back to the address');
});

test('with no letters in the name the initials come from the address, and with none there, there are none', () => {
  assert.equal(model.initials('', 'ana.lima@veyago.cloud'), 'AL');
  assert.equal(model.initials(null, 'hello@veyago.cloud'), 'H');
  assert.equal(model.initials('   ', 'jo_ann-smith@veyago.cloud'), 'JS');
  assert.equal(model.initials('', 'jo+work@veyago.cloud'), 'J', 'the tag after + is not part of anyone\'s name');
  assert.equal(model.initials('42', 'Émile@veyago.cloud'), 'É');
  assert.equal(model.initials('', '1234@veyago.cloud'), '', 'nothing to take: no "?" made up');
  assert.equal(model.initials(), '');
  assert.equal(model.initials('Ana Lima', 'zz@veyago.cloud'), 'AL', 'a name with letters wins');
});

/* ── The team ────────────────────────────────────────────────────────── */

test('the team lists owners first, then admins, the rest of the team, the invited and the deactivated', () => {
  const cards = model.teamCards(TEAM, viewer(zoe));
  assert.deepEqual([...cards].map(c => [c.name, c.group]), [
    ['Cassian Drefke', 'owner'],
    ['Zoë Adler', 'admin'],
    ['Ana Lima', 'staff'],
    ['Bo Berg', 'staff'],
    ['Ivy Chen', 'invited'],
    ['Gus Moreau', 'inactive']
  ], 'ordered by the role\'s spelling, the owner came last');
  assert.deepEqual([...model.TEAM_GROUPS].map(g => g.value), ['owner', 'admin', 'staff', 'invited', 'inactive']);
  assert.deepEqual([...model.TEAM_GROUPS].map(g => g.label), ['Owners', 'Admins', 'Team', 'Invited', 'Deactivated']);
});

test('within a group people are in name order, the way people read names: accents and case move nobody', () => {
  const names = ['émile Roux', 'Eli Novak', 'Finn Ode', 'ana Lima', 'Bo Berg', 'Élodie Petit'];
  const rows = names.map((name, i) => member(`e2000000-0000-4000-8000-00000000000${i}`, name, 'employee', `p${i}@veyago.cloud`));
  assert.deepEqual([...model.teamCards(rows, null)].map(c => c.name),
    ['ana Lima', 'Bo Berg', 'Eli Novak', 'Élodie Petit', 'émile Roux', 'Finn Ode']);
});

test('a card says who someone is, and the owner styling is the owner\'s alone', () => {
  const cards = model.teamCards(TEAM, viewer(zoe));
  const byId = id => [...cards].find(c => c.id === id);
  assert.deepEqual(plain(byId(OWNER)), {
    id: OWNER, route: `company/people/${OWNER}`, name: 'Cassian Drefke', email: 'cassian@veyago.cloud',
    initials: 'CD', title: 'Founder', role: 'owner', roleLabel: 'Owner', status: 'active', statusLabel: 'Active',
    group: 'owner', owner: true, you: false
  });
  assert.deepEqual([...cards].filter(c => c.owner).map(c => c.id), [OWNER], 'not the first card\'s');
  assert.equal(byId(ASSISTANT).title, 'Personal Assistant');
  assert.equal(byId(EMPLOYEE).title, '', 'no title is no title, not the role said twice');
  assert.deepEqual([byId(INVITED).statusLabel, byId(GONE).statusLabel, byId(GONE).roleLabel], ['Invited', 'Deactivated', 'Admin']);
});

test('your own card is marked, and nobody else\'s', () => {
  assert.deepEqual([...model.teamCards(TEAM, viewer(ana))].filter(c => c.you).map(c => c.id), [ASSISTANT]);
  assert.deepEqual([...model.teamCards(TEAM, null)].filter(c => c.you), []);
});

test('the team is read from store entries and rows alike, each person once, and nothing unreadable is listed', () => {
  const entry = { id: OWNER, name: 'Cassian Drefke', initial: 'C', role: 'Founder', tag: 'Owner', focus: '', row: cassian };
  const cards = model.teamCards([entry, cassian, null, {}, { row: null }, ana], viewer(ana));
  assert.deepEqual([...cards].map(c => [c.id, c.roleLabel]), [[OWNER, 'Owner'], [ASSISTANT, 'Assistant']],
    'queries.team() puts the job title in `role`; the role is the row\'s');
  assert.deepEqual([...model.teamCards(null, null)], []);
  const unnamed = model.teamCards([member(OTHER, '', 'employee', 'jo.doe@veyago.cloud')], null)[0];
  assert.deepEqual([unnamed.name, unnamed.initials], ['jo.doe@veyago.cloud', 'JD']);
});

/* ── A person's page ─────────────────────────────────────────────────── */

test('a person\'s page has their address, title, role, status, start date and whether they can sign in', () => {
  const page = model.personDetails({ ...ana, start_date: '2026-03-02' }, null, viewer(bo));
  assert.deepEqual(plain([page.id, page.route, page.name, page.email, page.initials, page.title, page.roleLabel, page.statusLabel, page.you]),
    [ASSISTANT, `company/people/${ASSISTANT}`, 'Ana Lima', 'ana@veyago.cloud', 'AL', 'Personal Assistant', 'Assistant', 'Active', false]);
  assert.deepEqual(plain(page.startDate), { key: '2026-03-02', label: 'March 2, 2026' });
  assert.deepEqual(plain(page.signIn), { state: 'active', label: 'Can sign in' });
  assert.equal(model.personDetails(ana, null, viewer(ana)).you, true);
  assert.equal(model.personDetails({}, null, viewer(ana)), null, 'nobody to show');
  assert.equal(model.personDetails(ana, null, null).startDate, null, 'no start date is none');
});

test('whether someone can sign in is read from their row', () => {
  const state = over => model.personDetails({ ...bo, ...over }, null, null).signIn;
  assert.deepEqual(plain(state({ status: 'invited' })), { state: 'invited', label: 'Invited, not signed in yet' },
    'invite-employee links the account when it invites');
  assert.deepEqual(plain(state({ status: 'invited', user_id: null })), { state: 'none', label: 'No sign-in yet' });
  assert.deepEqual(plain(state({ status: 'inactive' })), { state: 'deactivated', label: 'Deactivated, cannot sign in' });
  const { user_id: _, ...unread } = bo;
  assert.deepEqual(plain(model.personDetails(unread, null, null).signIn), { state: 'unknown', label: 'Not known' },
    'a row read without user_id does not say');
});

test('a person\'s page says what their role reaches in the workspace', () => {
  const access = row => model.personDetails(row, null, null).access;
  assert.equal(access(cassian), 'Everything, including Finance, the team and other owners.');
  assert.equal(access(zoe), 'Everything, including Finance and the team, except owners.');
  assert.equal(access(ana), 'The studio’s work, without Finance or changes to the team.');
  assert.equal(access(bo), access(ana), 'is_manager() is owners and admins; nothing in the workspace tells an assistant from an employee');
});

const privateRow = (phone, notes) => [{ phone, notes }];   // what rpc('employee_private') hands back

test('a phone number and notes are shown only when employee_private() answered, and only as it answers (0043)', () => {
  const manager = model.personDetails(ana, privateRow('+1 555 0100', 'Prefers mornings.'), viewer(zoe));
  assert.deepEqual(plain([manager.phone, manager.notes]),
    [{ shown: true, value: '+1 555 0100' }, { shown: true, value: 'Prefers mornings.' }]);

  const self = model.personDetails(ana, privateRow('+1 555 0100', null), viewer(ana));
  assert.deepEqual(plain([self.phone, self.notes]), [{ shown: true, value: '+1 555 0100' }, { shown: false, value: null }],
    'their own phone, and not a "no notes" that is really "not yours to read"');

  const single = model.personDetails(ana, { phone: '+1 555 0100', notes: 'Prefers mornings.' }, viewer(ana));
  assert.equal(single.phone.value, '+1 555 0100', 'one row, as maybeSingle() hands it, is read too');
  assert.equal(single.notes.shown, false, 'notes handed to the person themself are still not shown to them');

  const colleague = model.personDetails(ana, [], viewer(bo));
  assert.deepEqual(plain([colleague.phone, colleague.notes]), [{ shown: false, value: null }, { shown: false, value: null }],
    'no row for a colleague: nothing, not "not set"');

  for (const unanswered of [null, undefined]) {
    const page = model.personDetails(ana, unanswered, viewer(zoe));
    assert.deepEqual([page.phone.shown, page.notes.shown], [false, false], 'not asked, or the call failed');
  }

  const stray = model.personDetails(ana, privateRow('+1 555 0100', 'Prefers mornings.'), viewer(bo));
  assert.deepEqual([stray.phone.shown, stray.notes.shown], [false, false], 'a row for someone the database would not answer is not shown');

  const blank = model.personDetails(ana, privateRow('   ', null), viewer(zoe));
  assert.deepEqual(plain([blank.phone, blank.notes]), [{ shown: true, value: null }, { shown: true, value: null }], 'answered, and not set');
});

test('a start date is the same date in every time zone; the day someone was added is this clock\'s', () => {
  const localKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  for (const zone of ['Pacific/Pago_Pago', 'America/Los_Angeles', 'UTC', 'Europe/Berlin', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
    inZone(zone, () => {
      const page = model.personDetails({ ...bo, start_date: '2026-09-14', created_at: '2026-09-14T23:30:00+00:00' }, null, null);
      assert.deepEqual(plain(page.startDate), { key: '2026-09-14', label: 'September 14, 2026' }, zone);
      assert.equal(page.added.key, localKey(new Date('2026-09-14T23:30:00Z')), zone);
    });
  }
  const added = zone => inZone(zone, () => model.personDetails({ ...bo, created_at: '2026-09-14T23:30:00+00:00' }, null, null).added.label);
  assert.equal(added('Europe/Berlin'), 'September 15, 2026');
  assert.equal(added('America/Los_Angeles'), 'September 14, 2026');
  for (const bad of ['2026-02-30', '14/09/2026', '2026-9-14', '', null]) {
    assert.equal(model.personDetails({ ...bo, start_date: bad }, null, null).startDate, null, String(bad));
  }
  assert.equal(model.personDetails({ ...bo, created_at: 'soon' }, null, null).added, null);
});

/* ── Roles and statuses (0042) ───────────────────────────────────────── */

test('only owners and admins change a role or a status', () => {
  const choices = model.roleChoices(viewer(ana), bo, TEAM);
  assert.equal(choices.editable, false);
  assert.equal(choices.reason, 'Only an owner or admin can change a team member’s role or status.');
  assert.deepEqual([...choices.choices].map(c => [c.value, c.current, c.allowed]),
    [['owner', false, false], ['admin', false, false], ['assistant', false, false], ['employee', true, false]]);
  assert.equal(model.canDeactivate(viewer(ana), bo, TEAM), false);
  assert.equal(model.canDeactivate(null, bo, TEAM), false);
  assert.equal(model.canDeactivate({ ...viewer(zoe), status: 'inactive' }, bo, TEAM), false,
    'a deactivated admin has no role at all (employee_role())');
});

test('nobody changes their own role or status, owner or admin', () => {
  const team = [...TEAM, maya];
  for (const me of [zoe, cassian]) {
    const roles = model.roleChoices(viewer(me), me, team);
    assert.deepEqual([roles.editable, roles.reason], [false, OWN], me.full_name);
    assert.deepEqual([model.statusChoices(viewer(me), me, team).editable, model.statusChoices(viewer(me), me, team).reason], [false, OWN]);
    assert.equal(model.deactivateRefusal(viewer(me), me, team), OWN);
    assert.equal(model.canDeactivate(viewer(me), me, team), false);
  }
});

test('an admin gives a colleague any role but owner, and deactivates them', () => {
  const choices = model.roleChoices(viewer(zoe), bo, TEAM);
  assert.deepEqual([choices.editable, choices.reason], [true, null]);
  assert.deepEqual(plain(choices.choices), [
    { value: 'owner', label: 'Owner', current: false, allowed: false, reason: 'Only an owner can make someone an owner.' },
    { value: 'admin', label: 'Admin', current: false, allowed: true, reason: null },
    { value: 'assistant', label: 'Assistant', current: false, allowed: true, reason: null },
    { value: 'employee', label: 'Employee', current: true, allowed: true, reason: null }
  ]);
  assert.equal(model.canDeactivate(viewer(zoe), bo, TEAM), true);
  assert.equal(model.canDeactivate(viewer(zoe), ivy, TEAM), true, 'an invitation can be withdrawn');
  assert.deepEqual(plain(model.statusChoices(viewer(zoe), gus, TEAM).choices).map(c => [c.value, c.current, c.allowed]),
    [['active', false, true], ['invited', false, true], ['inactive', true, true]], 'and brings someone back');
});

test('an admin changes nothing of an owner\'s, even with another owner to spare', () => {
  const team = [...TEAM, maya];
  const roles = model.roleChoices(viewer(zoe), cassian, team);
  assert.deepEqual([roles.editable, roles.reason], [false, 'Only an owner can change an owner.']);
  assert.equal(model.statusChoices(viewer(zoe), cassian, team).reason, 'Only an owner can change an owner.');
  assert.equal(model.deactivateRefusal(viewer(zoe), cassian, team), 'Only an owner can change an owner.');
  assert.equal(model.canDeactivate(viewer(zoe), { ...ivy, role: 'owner' }, team), false, 'an invited owner is an owner too');
});

test('an owner makes a colleague an owner, and stands another owner down while one who can sign in remains', () => {
  const team = [...TEAM, maya];
  assert.equal([...model.roleChoices(viewer(cassian), bo, team).choices].find(c => c.value === 'owner').allowed, true);
  assert.deepEqual([...model.roleChoices(viewer(cassian), maya, team).choices].map(c => [c.value, c.allowed]),
    [['owner', true], ['admin', true], ['assistant', true], ['employee', true]]);
  assert.equal(model.canDeactivate(viewer(cassian), maya, team), true, 'Cassian is still an owner who can sign in');
});

test('an owner who can sign in is an owner linked to a sign-in and not deactivated, as 0042 counts them', () => {
  const nils = member(OTHER, 'Nils Holm', 'owner', 'nils@veyago.cloud', { status: 'inactive' });
  assert.deepEqual([...model.ownersWhoCanSignIn([...TEAM, maya, nils])], [OWNER, CO_OWNER]);
  assert.deepEqual([...model.ownersWhoCanSignIn([cassian, { ...maya, status: 'invited' }])], [OWNER, CO_OWNER],
    'an invited owner whose account exists can sign in');
  assert.deepEqual([...model.ownersWhoCanSignIn([{ ...maya, user_id: null }, gus, bo])], []);
  assert.deepEqual([...model.ownersWhoCanSignIn(null)], []);
});

test('an owner stands another owner down whatever the team rows show: the owner looking is one who can sign in (0040, 0042)', () => {
  const unread = [...TEAM, maya].map(({ user_id: _, ...row }) => row);
  const coOwner = unread.find(m => m.id === CO_OWNER);
  assert.equal(model.deactivateRefusal(viewer(cassian), coOwner, unread), null,
    'employee_role() is owner only for a row someone is signed in to, so that owner remains — 08: "OWNER: changes an owner back"');
  assert.equal(model.changeRefusal(viewer(cassian), coOwner, unread, { role: 'admin' }), null, 'read without user_id');
  const entries = unread.map(row => ({ id: row.id, name: row.full_name, initial: '', role: row.title || '', focus: '', tag: '', row }));
  assert.equal(model.changeRefusal(viewer(cassian), entries.find(e => e.id === CO_OWNER), entries, { role: 'admin' }), null,
    'the team as queries.team() loads it');
  assert.equal(model.canDeactivate(viewer(cassian), coOwner, null), true, 'or with no team loaded at all');
  const roles = model.roleChoices(viewer(cassian), coOwner, unread);
  assert.deepEqual([roles.editable, roles.reason], [true, null]);
  assert.deepEqual([...roles.choices].map(c => [c.value, c.allowed]), [['owner', true], ['admin', true], ['assistant', true], ['employee', true]]);
  assert.equal([...model.statusChoices(viewer(cassian), coOwner, unread).choices].find(c => c.value === 'invited').allowed, true);
  assert.equal(model.canDeactivate(viewer(cassian), { ...maya, status: 'invited', user_id: null }, unread), true,
    'an owner with no sign-in is not one the studio can lose');
  assert.equal(model.deactivateRefusal(viewer(cassian), unread.find(m => m.id === OWNER), unread), OWN,
    'and the owner looking is never the one stood down');
});

test('rows that say the owner looking has no sign-in, which nobody signed in can be, are not taken for them: the team is counted', () => {
  const unread = [...TEAM, maya].map(({ user_id: _, ...row }) => row);
  const unlinked = unread.map(row => (row.id === OWNER ? { ...row, user_id: null } : row));
  assert.equal(model.deactivateRefusal(viewer(cassian), maya, unlinked), KEEP, 'their row in the team says so');
  assert.equal(model.deactivateRefusal({ ...viewer(cassian), user_id: null }, maya, unread), KEEP, 'the viewer\'s own row says so');
  assert.equal(model.deactivateRefusal(viewer(cassian), unlinked.find(m => m.id === CO_OWNER), unlinked), KEEP,
    'and then an owner read without user_id may be one the studio would lose');
  const nils = member(OTHER, 'Nils Holm', 'owner', 'nils@veyago.cloud');
  assert.equal(model.deactivateRefusal(viewer(cassian), maya, [...unlinked, nils]), null, 'Nils can still sign in');
});

test('no change the model allows leaves the studio without an owner who can sign in', () => {
  const olga = member(OTHER, 'Olga Vance', 'owner', 'olga@veyago.cloud', { status: 'invited', user_id: null });
  for (const team of [[cassian, maya, zoe, ana, bo, ivy, gus, olga], [cassian, zoe, ana, bo, ivy, gus, olga]]) {
    const changes = [...model.ROLES.map(r => ({ role: r.value })), ...model.STATUSES.map(s => ({ status: s.value }))];
    for (const me of team.filter(m => m.status !== 'inactive')) {
      for (const target of team) {
        for (const change of changes) {
          if (model.changeRefusal(viewer(me), target, team, change) !== null) continue;
          const after = team.map(m => (m.id === target.id ? { ...m, ...change } : m));
          assert.ok(model.ownersWhoCanSignIn(after).length > 0, `${me.full_name} → ${target.full_name} ${JSON.stringify(change)}`);
        }
      }
    }
  }
});

test('a change the database cannot hold is refused before it is tried', () => {
  assert.equal(model.changeRefusal(viewer(zoe), bo, TEAM, { role: 'manager' }), 'Choose a role: Owner, Admin, Assistant or Employee.');
  assert.equal(model.changeRefusal(viewer(zoe), bo, TEAM, { status: 'deleted' }), 'Choose a status: Active, Invited or Deactivated.');
  assert.equal(model.changeRefusal(viewer(zoe), {}, TEAM, { role: 'admin' }), 'This person is not on the team.');
  assert.equal(model.changeRefusal(viewer(zoe), bo, TEAM, {}), null, 'no change is no refusal');
  assert.equal(model.deactivateRefusal(viewer(zoe), gus, TEAM), 'They are already deactivated.');
  assert.equal(model.canDeactivate(viewer(zoe), gus, TEAM), false);
});

/* ── Inviting (invite-employee, _shared/team-rules.ts) ──────────────── */

test('an owner or admin invites someone new as invite-employee reads the request', () => {
  const form = model.inviteForm({ email: '  Nora.Park@Veyago.cloud ', full_name: '  Nora Park ', role: 'assistant', title: '  Designer ', start_date: '2026-10-01' },
    viewer(zoe), TEAM);
  assert.deepEqual([form.ok, form.refusal, plain(form.errors)], [true, null, {}]);
  assert.deepEqual(plain(form.payload), { email: 'nora.park@veyago.cloud', full_name: 'Nora Park', role: 'assistant', title: 'Designer', start_date: '2026-10-01' });
  assert.deepEqual([form.existing, form.reinvite, form.statusAfter], [null, false, 'invited']);
  const bare = model.inviteForm({ email: 'nora@veyago.cloud', full_name: 'Nora Park', title: '   ' }, viewer(zoe), TEAM);
  assert.deepEqual(plain(bare.payload), { email: 'nora@veyago.cloud', full_name: 'Nora Park', role: 'employee', title: null, start_date: null },
    'no role is employee, as the function reads it; a blank title is none');
});

test('what invite-employee answers as a bad request is caught before anything is sent', () => {
  const form = model.inviteForm({ email: 'nora@veyago', full_name: '   ', role: 'Owner', start_date: '2026-02-30' }, viewer(cassian), TEAM);
  assert.deepEqual([form.ok, form.payload], [false, null]);
  assert.deepEqual(plain(form.errors), {
    email: 'Enter a valid email address.',
    full_name: 'Enter their full name.',
    role: 'Choose a role: Owner, Admin, Assistant or Employee.',
    start_date: 'Enter the start date as a date, like 2026-09-14.'
  }, 'the function does not read "Owner" as owner');
  for (const email of ['a b@veyago.cloud', 'nora@@veyago.cloud', '@veyago.cloud', 'nora@veyago.', '']) {
    assert.equal(model.inviteForm({ email, full_name: 'Nora Park' }, viewer(zoe), TEAM).errors.email, 'Enter a valid email address.', email);
  }
  assert.equal(model.inviteForm({ email: 'nora@veyago.cloud', full_name: 'Nora', role: '' }, viewer(zoe), TEAM).errors.role,
    'Choose a role: Owner, Admin, Assistant or Employee.', 'an empty choice is no role');
});

test('only owners and admins invite, and only an owner invites an owner', () => {
  const values = { email: 'nora@veyago.cloud', full_name: 'Nora Park', role: 'employee' };
  const staff = model.inviteForm(values, viewer(ana), TEAM);
  assert.deepEqual([staff.ok, staff.refusal, staff.payload], [false, 'Only an owner or admin can invite someone.', null]);
  assert.deepEqual([...staff.roles].map(r => r.allowed), [false, false, false, false]);
  assert.equal(model.inviteForm(values, null, TEAM).ok, false);
  const admin = model.inviteForm({ ...values, role: 'owner' }, viewer(zoe), TEAM);
  assert.deepEqual([admin.ok, admin.refusal], [false, 'Only an owner can make someone an owner.']);
  assert.deepEqual(plain(admin.roles), [
    { value: 'owner', label: 'Owner', manages: true, allowed: false, reason: 'Only an owner can make someone an owner.' },
    { value: 'admin', label: 'Admin', manages: true, allowed: true, reason: null },
    { value: 'assistant', label: 'Assistant', manages: false, allowed: true, reason: null },
    { value: 'employee', label: 'Employee', manages: false, allowed: true, reason: null }
  ]);
  assert.equal(model.inviteForm({ ...values, role: 'owner' }, viewer(cassian), TEAM).ok, true);
});

test('re-inviting rewrites someone\'s role and status, so the rules for changing them hold for it', () => {
  const again = model.inviteForm({ email: 'BO@veyago.cloud', full_name: 'Bo Berg', role: 'assistant' }, viewer(zoe), TEAM);
  assert.deepEqual([again.ok, again.reinvite, again.statusAfter], [true, true, 'active'], 'a new sign-in link is not a demotion');
  assert.deepEqual(plain(again.existing),
    { id: EMPLOYEE, name: 'Bo Berg', email: 'bo@veyago.cloud', role: 'employee', roleLabel: 'Employee', status: 'active', statusLabel: 'Active' });
  assert.equal(model.inviteForm({ email: 'gus@veyago.cloud', full_name: 'Gus Moreau' }, viewer(zoe), TEAM).statusAfter, 'invited',
    'a deactivated member is invited again');

  for (const role of ['employee', 'assistant', 'admin']) {
    assert.equal(model.inviteForm({ email: 'cassian@veyago.cloud', full_name: 'Cassian Drefke', role }, viewer(zoe), TEAM).refusal,
      'Only an owner can re-invite an owner.', role);
  }
  assert.equal(model.inviteForm({ email: 'maya@veyago.cloud', full_name: 'Maya Stone', role: 'admin' }, viewer(cassian), [...TEAM, maya]).ok, true,
    'another owner may');

  const yourself = 'You can’t re-invite yourself: it would change your own role. Ask another owner or admin.';
  assert.equal(model.inviteForm({ email: 'zoe@veyago.cloud', full_name: 'Zoë Adler', role: 'owner' }, viewer(zoe), TEAM).refusal, yourself);
  assert.equal(model.inviteForm({ email: 'cassian@veyago.cloud', full_name: 'Cassian Drefke', role: 'owner' }, viewer(cassian), TEAM).refusal, yourself);
  assert.equal(model.inviteForm({ email: 'ivy@veyago.cloud', full_name: 'Ivy Chen', role: 'assistant' }, viewer(zoe), TEAM).ok, true,
    'a row nobody has signed in to belongs to nobody, not to the person inviting');
});

test('the same address in another case is the same person, never a second one', () => {
  const stored = [...TEAM, member(OTHER, 'Jo Park', 'employee', 'Jo@Veyago.cloud')];
  assert.equal(model.inviteForm({ email: 'jo@veyago.cloud', full_name: 'Jo Park' }, viewer(cassian), stored).refusal,
    'Jo@Veyago.cloud is already on the team. Re-invite them from their profile.');
  assert.equal(model.inviteForm({ email: 'cassian@veyago.cloud', full_name: 'Cassian Drefke' }, viewer(zoe), [{ ...cassian, email: 'Cassian@Veyago.cloud' }]).refusal,
    'Only an owner can re-invite an owner.', 'an owner stored in another case is still an owner');
});

/* ── The studio's profile (0016, 0041) ───────────────────────────────── */

const DEFAULTS = {
  name: 'Veyago Inc.', tagline: 'Independent software studio. Software for the journey.',
  location: 'New York, United States', email: 'hello@veyago.cloud',
  website: 'https://www.veyago.cloud/', websiteLabel: 'www.veyago.cloud', currency: null, fromSettings: []
};

test('the studio\'s profile is its settings, and the public facts where a setting is missing', () => {
  assert.deepEqual(plain(model.studioProfile([])), DEFAULTS);
  assert.deepEqual(plain(model.studioProfile(null)), DEFAULTS, 'staff read no settings at all: 0016 lets managers alone read them');
  assert.deepEqual(plain(model.studioProfile([
    { key: 'studio_name', value: '  Veyago GmbH ' },
    { key: 'studio_tagline', value: '' },
    { key: 'studio_location', value: 'Berlin, Germany' },
    { key: 'studio_email', value: 'Studio@Veyago.de' },
    { key: 'studio_website', value: 'veyago.de' },
    { key: 'base_currency', value: ' eur ' },
    null
  ])), {
    name: 'Veyago GmbH', tagline: DEFAULTS.tagline, location: 'Berlin, Germany', email: 'Studio@Veyago.de',
    website: 'https://veyago.de', websiteLabel: 'veyago.de', currency: 'EUR',
    fromSettings: ['name', 'location', 'email', 'website', 'currency']
  });
});

test('a setting that cannot be what it says is not shown', () => {
  const odd = model.studioProfile([
    { key: 'studio_email', value: 'not an address' },
    { key: 'studio_website', value: 'javascript:alert(1)' },
    { key: 'base_currency', value: 'euro' }
  ]);
  assert.deepEqual([odd.email, odd.website, odd.currency, [...odd.fromSettings]], [DEFAULTS.email, DEFAULTS.website, null, []]);
  assert.equal(model.studioProfile([{ key: 'base_currency', value: ' usd\n' }]).currency, null,
    'studio_currency() trims spaces alone, as Postgres trim() does (0041)');
  assert.equal(model.studioProfile([{ key: 'studio_website', value: 'https://veyago.cloud@evil.example/' }]).website, DEFAULTS.website,
    'a website with a sign-in part leads to the host after the @');
  assert.equal(model.studioProfile([{ key: 'studio_website', value: 'http://veyago.cloud/about/' }]).websiteLabel, 'veyago.cloud/about');
});

test('bank details stay out of the studio\'s profile', () => {
  const profile = model.studioProfile([
    { key: 'bank_routing', value: '026073150' }, { key: 'bank_account', value: '8310000001' },
    { key: 'bank_name', value: 'Column N.A.' }, { key: 'bank_address', value: '1 Main St|San Francisco' },
    { key: 'bank_account_type', value: 'Checking' }
  ]);
  const shown = JSON.stringify(profile);
  for (const detail of ['026073150', '8310000001', 'Column', 'Main St', 'Checking']) {
    assert.equal(shown.includes(detail), false, detail);
  }
});

/* ── Connections (0024, 0036, 0038, 0044, connection-rules.ts) ──────── */

/* A row of integration_status, as queries.integrations() reads it. */
const connection = (id, provider, account_label, employee_id, over = {}) => ({
  id, provider, account_label, employee_id, employee_name: null, status: 'connected', is_live: true,
  last_synced_at: '2026-09-14T07:30:00+00:00', last_error: null, ...over
});

const CONNECTIONS = [
  connection('c-stripe', 'stripe', 'Stripe', null, { last_synced_at: null }),
  connection('c-ana-mail', 'microsoft_mail', 'ana@veyago.cloud', ASSISTANT),
  connection('c-cal', 'microsoft_calendar', 'hello@veyago.cloud', null,
    { status: 'needs_reauth', last_error: 'Reconnect this studio connection, so its address can be checked against the directory.' }),
  connection('c-hello', 'microsoft_mail', 'hello@veyago.cloud', null, { status: 'error', last_error: 'Graph answered 503.' }),
  connection('c-zoe-mail', 'microsoft_mail', 'zoe@veyago.cloud', ADMIN),
  connection('c-mercury', 'mercury', 'Mercury Checking', null, { status: 'disconnected', last_error: 'An old failure.' }),
  connection('c-ana-cal', 'microsoft_calendar', 'ana@veyago.cloud', ASSISTANT, { status: 'disconnected' })
];

test('everyone on staff sees the studio\'s connections and their own, never a colleague\'s', () => {
  assert.deepEqual([...model.connectionRows(CONNECTIONS, viewer(ana))].map(r => [r.id, r.whose, r.whoseLabel]), [
    ['c-hello', 'studio', 'Studio'], ['c-cal', 'studio', 'Studio'], ['c-mercury', 'studio', 'Studio'], ['c-stripe', 'studio', 'Studio'],
    ['c-ana-mail', 'own', 'Yours'], ['c-ana-cal', 'own', 'Yours']
  ], 'Zoë\'s mailbox is hers, even from a database that still hands it over (0044)');
  assert.deepEqual([...model.connectionRows(CONNECTIONS, viewer(zoe))].map(r => r.id),
    ['c-hello', 'c-cal', 'c-mercury', 'c-stripe', 'c-zoe-mail'], 'owners and admins included');
  assert.deepEqual([...model.connectionRows(CONNECTIONS, null)], [], 'not on the team: nothing (is_staff())');
  assert.deepEqual([...model.connectionRows(CONNECTIONS, { ...viewer(ana), status: 'inactive' })], []);
  assert.deepEqual([...model.connectionRows(null, viewer(ana))], []);
});

test('a connection says what it is, whose it is, how it is and when it last synced', () => {
  inZone('Europe/Berlin', () => {
    const hello = [...model.connectionRows(CONNECTIONS, viewer(zoe))].find(r => r.id === 'c-hello');
    assert.deepEqual(plain(hello), {
      id: 'c-hello', provider: 'microsoft_mail', providerLabel: 'Outlook mail', kind: 'mail', account: 'hello@veyago.cloud',
      whose: 'studio', whoseLabel: 'Studio', status: 'error', statusLabel: 'Error', tone: 'red', lastError: 'Graph answered 503.',
      lastSyncedAt: '2026-09-14T07:30:00.000Z', lastSyncedLabel: 'Last synced Sep 14, 2026, 09:30',
      mayReconnect: true, reconnect: { provider: 'microsoft_mail', accountLabel: 'hello@veyago.cloud' }, mayDisconnect: true
    });
  });
});

test('a connection is connected, needs reconnecting, has an error with its text, or is disconnected', () => {
  assert.deepEqual([...model.connectionRows(CONNECTIONS, viewer(zoe))].map(r => [r.id, r.status, r.statusLabel, r.tone, r.lastError]), [
    ['c-hello', 'error', 'Error', 'red', 'Graph answered 503.'],
    ['c-cal', 'needs_reauth', 'Needs reconnecting', 'amber', 'Reconnect this studio connection, so its address can be checked against the directory.'],
    ['c-mercury', 'disconnected', 'Disconnected', null, null],
    ['c-stripe', 'connected', 'Connected', 'green', null],
    ['c-zoe-mail', 'connected', 'Connected', 'green', null]
  ]);
  const odd = model.connectionRows([connection('x', 'microsoft_mail', 'x@veyago.cloud', null, { status: 'paused', last_error: 'Why.' })], viewer(zoe))[0];
  assert.deepEqual([odd.status, odd.statusLabel, odd.lastError], ['disconnected', 'Disconnected', null], 'a status the column cannot hold reads as its default');
  const noted = model.connectionRows([connection('y', 'microsoft_mail', 'y@veyago.cloud', null,
    { last_error: 'Some mail filed away in Outlook may still show in this inbox until the daily check. ' })], viewer(zoe))[0];
  assert.equal(noted.lastError, null, 'a working mailbox\'s note is Mail\'s to show (mailModel.mailboxNote)');
});

test('every provider the database allows has a name, and one it no longer allows is shown as stored', () => {
  const providers = ['microsoft_mail', 'microsoft_calendar', 'imap', 'caldav', 'ics', 'mercury', 'stripe'];
  assert.deepEqual([...model.PROVIDERS].map(p => p.value), providers, '0036');
  const rows = model.connectionRows(providers.map((provider, i) => connection(`p${i}`, provider, 'account', null)), viewer(zoe));
  assert.deepEqual([...rows].map(r => [r.providerLabel, r.kind]), [
    ['Outlook mail', 'mail'], ['Outlook calendar', 'calendar'], ['IMAP mailbox', 'mail'], ['CalDAV calendar', 'calendar'],
    ['Calendar feed', 'calendar'], ['Mercury', 'bank'], ['Stripe', 'payments']
  ]);
  const legacy = model.connectionRows([connection('g', 'google_mail', 'old@veyago.cloud', null)], viewer(zoe))[0];
  assert.deepEqual([legacy.providerLabel, legacy.kind, legacy.mayReconnect], ['google_mail', 'other', false]);
});

test('the last sync is read on this clock, and a connection that never synced says so', () => {
  const row = over => model.connectionRows([connection('s', 'microsoft_mail', 's@veyago.cloud', null, over)], viewer(zoe))[0];
  const labels = {
    'America/Los_Angeles': 'Last synced Sep 13, 2026, 21:45',
    UTC: 'Last synced Sep 14, 2026, 04:45',
    'Asia/Kolkata': 'Last synced Sep 14, 2026, 10:15',
    'Pacific/Auckland': 'Last synced Sep 14, 2026, 16:45'
  };
  for (const [zone, label] of Object.entries(labels)) {
    inZone(zone, () => {
      const synced = row({ last_synced_at: '2026-09-14T04:45:00+00:00' });
      assert.deepEqual([synced.lastSyncedAt, synced.lastSyncedLabel], ['2026-09-14T04:45:00.000Z', label], zone);
    });
  }
  for (const never of [null, undefined, '', 'soon']) {
    const r = row({ last_synced_at: never });
    assert.deepEqual([r.lastSyncedAt, r.lastSyncedLabel], [null, 'Never synced'], String(never));
  }
});

test('reconnecting: owners and admins the studio\'s, anyone their own, and only what microsoft-connect connects', () => {
  const staff = model.connectionRows(CONNECTIONS, viewer(ana));
  assert.deepEqual([...staff].map(r => [r.id, r.mayReconnect]),
    [['c-hello', false], ['c-cal', false], ['c-mercury', false], ['c-stripe', false], ['c-ana-mail', true], ['c-ana-cal', true]]);
  assert.equal(staff[0].reconnect, null);
  const admin = model.connectionRows(CONNECTIONS, viewer(zoe));
  assert.deepEqual([...admin].map(r => [r.id, r.mayReconnect]),
    [['c-hello', true], ['c-cal', true], ['c-mercury', false], ['c-stripe', false], ['c-zoe-mail', true]]);
  assert.deepEqual(plain(admin[1].reconnect), { provider: 'microsoft_calendar', accountLabel: 'hello@veyago.cloud' },
    'no employeeId: a reconnect keeps whose the connection is');
  const shouting = model.connectionRows([connection('u', 'microsoft_mail', ' Hello@Veyago.cloud ', null)], viewer(zoe))[0];
  assert.deepEqual([shouting.account, shouting.reconnect.accountLabel], ['Hello@Veyago.cloud', 'hello@veyago.cloud'],
    'looked up the way microsoft-connect looks it up');
  assert.equal(model.connectionRows([connection('e', 'microsoft_mail', '   ', null)], viewer(zoe))[0].mayReconnect, false, 'no address to connect');
});

test('disconnecting is for owners and admins, for the studio\'s connections and their own', () => {
  assert.deepEqual([...model.connectionRows(CONNECTIONS, viewer(zoe))].map(r => [r.id, r.mayDisconnect]),
    [['c-hello', true], ['c-cal', true], ['c-mercury', false], ['c-stripe', true], ['c-zoe-mail', true]],
    'what is disconnected already is not disconnected again');
  assert.deepEqual([...model.connectionRows(CONNECTIONS, viewer(ana))].map(r => r.mayDisconnect), [false, false, false, false, false, false],
    'staff reconnect their own, but 0038 lets only owners and admins switch one off');
});

/* ── Frozen ──────────────────────────────────────────────────────────── */

test('what the model hands back cannot be changed by a view, and what it is given is left as it was', () => {
  const given = JSON.stringify([TEAM, CONNECTIONS]);
  const cards = model.teamCards(TEAM, viewer(zoe));
  const page = model.personDetails({ ...ana, start_date: '2026-03-02' }, privateRow('+1 555 0100', 'Notes.'), viewer(zoe));
  const roles = model.roleChoices(viewer(zoe), bo, TEAM);
  const statuses = model.statusChoices(viewer(zoe), bo, TEAM);
  const form = model.inviteForm({ email: 'nora@veyago.cloud', full_name: 'Nora Park' }, viewer(zoe), TEAM);
  const again = model.inviteForm({ email: 'bo@veyago.cloud', full_name: 'Bo Berg' }, viewer(zoe), TEAM);
  const profile = model.studioProfile([{ key: 'studio_name', value: 'Veyago' }]);
  const rows = model.connectionRows(CONNECTIONS, viewer(zoe));
  for (const value of [model, model.ROLES, model.ROLES[0], model.STATUSES, model.STATUSES[0], model.TEAM_GROUPS, model.TEAM_GROUPS[0],
    model.PROVIDERS, model.PROVIDERS[0], model.CONNECTION_STATUSES, model.CONNECTION_STATUSES[0],
    cards, cards[0], page, page.phone, page.notes, page.signIn, page.startDate, page.added,
    roles, roles.choices, roles.choices[0], statuses, statuses.choices,
    form, form.errors, form.payload, form.roles, form.roles[0], again.existing,
    profile, profile.fromSettings, rows, rows[0], rows[0].reconnect, model.ownersWhoCanSignIn(TEAM)]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.equal(JSON.stringify([TEAM, CONNECTIONS]), given);
});
