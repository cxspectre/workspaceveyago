/* The pipeline's logic, without a page: a deal as the views read it, the six
   columns of the board, one company holding several open deals at once, the
   forms as crm_deals (0067) takes them, and what moving a card or closing a
   deal changes. Loaded into a sandbox the way <script> tags run it, beside
   crm-model.js, whose money rules it counts a deal's value with.
   Run from the repo root with: node --test

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence [...spread], and plain() for nested shapes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* A zone east of UTC, where its midnight and UTC's are different moments:
   what a day picked in a dialog is stored as depends on the viewer's own. */
process.env.TZ = 'Europe/Amsterdam';

const context = vm.createContext({ console });
for (const file of ['crm-model.js', 'deals-model.js']) {
  vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
}
const model = vm.runInContext('dealsModel', context);

const plain = value => JSON.parse(JSON.stringify(value));
const titles = list => [...list].map(d => d.title);

const NORTH = 'c1000000-0000-4000-8000-000000000001';
const HARBOR = 'c1000000-0000-4000-8000-000000000002';
const GONE = 'c1000000-0000-4000-8000-0000000000ff';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const D2 = 'd1000000-0000-4000-8000-000000000002';
const D3 = 'd1000000-0000-4000-8000-000000000003';

/* What queries.companies() hands the store. */
const company = (id, name, row = {}) => ({
  id, name, domain: '', stage: 'Lead', kind: 'Prospect', value: '—', notes: '',
  row: { id, name, domain: null, kind: 'prospect', stage: 'lead', value: null, currency: 'USD', notes: null, ...row }
});

/* What queries.deals() hands the store: the row underneath, a little already
   formatted on top. */
const deal = (id, title, row = {}) => ({
  id, title, stage: 'Lead', value: '—',
  row: {
    id, company_id: NORTH, title, stage: 'lead', value: null, currency: 'USD', owner_id: null,
    expected_close: null, outcome: null, closed_at: null, notes: null, created_at: '2026-09-01T00:00:00Z', ...row
  }
});

const COMPANIES = [company(NORTH, 'Northline'), company(HARBOR, 'Harbor & Co')];

/* ── A deal as the views read it ──────────────────────────────────────── */

test('a deal carries its company, its money and the one rule everything turns on: open is having no outcome', () => {
  const [open] = model.dealList([deal(D1, 'Renewal', { stage: 'proposal', value: '12000.00', currency: 'eur', expected_close: '2026-11-30' })], COMPANIES);
  assert.equal(open.title, 'Renewal');
  assert.equal(open.companyId, NORTH);
  assert.equal(open.companyName, 'Northline');
  assert.equal(open.route, `crm/companies/${NORTH}`, 'a deal has no page of its own: its card opens its company');
  assert.equal(open.stage, 'proposal');
  assert.equal(open.stageLabel, 'Proposal');
  assert.equal(open.amount, 12000);
  assert.equal(open.currency, 'EUR', 'a code in lower case is that code');
  assert.equal(open.expectedClose, '2026-11-30');
  assert.equal(open.open, true);
  assert.equal(open.outcome, null);
  assert.equal(open.column, 'proposal');
  assert.equal(open.live, true);
});

test('a closed deal is drawn by its outcome and keeps the stage it stood at — the history one stage per company could not hold', () => {
  const [won] = model.dealList([deal(D1, 'Rebrand', { stage: 'proposal', outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })], COMPANIES);
  assert.equal(won.open, false);
  assert.equal(won.outcome, 'won');
  assert.equal(won.outcomeLabel, 'Won');
  assert.equal(won.stage, 'proposal', 'won OUT OF proposal, not moved to a "won" stage');
  assert.equal(won.column, 'won', 'the column it is drawn in is its outcome');
  assert.equal(won.columnLabel, 'Won');
  assert.equal(won.live, false, 'a deal already won is not still to be won');
});

test('a dormant deal is open — nobody won or lost it — but it is not counted as live pipeline', () => {
  const [quiet] = model.dealList([deal(D1, 'Old audit', { stage: 'dormant', value: 5000 })], COMPANIES);
  assert.equal(quiet.open, true);
  assert.equal(quiet.live, false);
  assert.equal(quiet.column, 'dormant');
});

test('a deal at a company that is no longer in the CRM names none, rather than one no page will open', () => {
  const [orphan] = model.dealList([deal(D1, 'Renewal', { company_id: GONE })], COMPANIES);
  assert.equal(orphan.company, null);
  assert.equal(orphan.companyName, '');
  assert.equal(orphan.route, `crm/companies/${GONE}`, 'the id it names is still where the card points');
});

test('a value stored outside the form\'s rules is read as it is, and no value is null rather than zero', () => {
  const [none] = model.dealList([deal(D1, 'Audit')], COMPANIES);
  assert.equal(none.amount, null, 'no value is not £0');
  const [odd] = model.dealList([deal(D2, 'Odd', { value: 50, currency: 'US$' })], COMPANIES);
  assert.equal(odd.currency, 'US$', 'a code stored before 0049 stays itself, so it is never added to anybody\'s dollars');
});

/* ── The board ────────────────────────────────────────────────────────── */

test('the board has a column for each stage an open deal can stand at, then one for each outcome', () => {
  const board = model.pipeline([]);
  assert.deepEqual([...board.columns].map(c => [c.stage, c.heading]), [
    ['lead', 'Leads'], ['qualified', 'Qualified'], ['proposal', 'Proposals'],
    ['dormant', 'Dormant'], ['won', 'Won'], ['lost', 'Lost']
  ]);
  assert.deepEqual(plain(board.open), { count: 0, totals: [] });
});

test('one company holds several open deals at once, each in its own column — the whole reason crm_deals exists', () => {
  const board = model.pipeline(model.dealList([
    deal(D1, 'Renewal', { stage: 'proposal', value: 12000 }),
    deal(D2, 'New site', { stage: 'qualified', value: 30000 }),
    deal(D3, 'Brand refresh', { stage: 'lead' })
  ], COMPANIES));
  const at = stage => board.columns.find(c => c.stage === stage);
  assert.deepEqual(titles(at('proposal').deals), ['Renewal']);
  assert.deepEqual(titles(at('qualified').deals), ['New site']);
  assert.deepEqual(titles(at('lead').deals), ['Brand refresh']);
  assert.equal(board.open.count, 3);
  assert.deepEqual(plain(board.open.totals), [{ currency: 'USD', amount: 42000 }],
    'three separate figures, not one overwritten by the next');
});

test('the pipeline figure is the open deals at a live stage: never a dormant one, never one already won or lost', () => {
  const board = model.pipeline(model.dealList([
    deal(D1, 'A', { stage: 'lead', value: 1 }),
    deal(D2, 'B', { stage: 'dormant', value: 1000 }),
    deal(D3, 'C', { stage: 'proposal', value: 10000, outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })
  ], COMPANIES));
  assert.equal(board.open.count, 1);
  assert.deepEqual(plain(board.open.totals), [{ currency: 'USD', amount: 1 }]);
  assert.equal(board.columns.find(c => c.stage === 'won').count, 1, 'the closed ones are still on the board, in their own column');
  assert.deepEqual(plain(board.columns.find(c => c.stage === 'won').totals), [{ currency: 'USD', amount: 10000 }]);
});

test('no total crosses a currency, and a deal listed twice counts once', () => {
  const twice = deal(D1, 'Renewal', { value: 1000 });
  const board = model.pipeline(model.dealList([twice, twice, deal(D2, 'Site', { value: 3500, currency: 'EUR' })], COMPANIES));
  assert.deepEqual(plain(board.open.totals), [{ currency: 'EUR', amount: 3500 }, { currency: 'USD', amount: 1000 }]);
  assert.equal(board.open.count, 2);
});

test('the board takes raw rows as readily as shaped deals, and nothing at all', () => {
  const board = model.pipeline([deal(D1, 'Renewal', { value: 1000 })]);
  assert.equal(board.open.count, 1);
  assert.deepEqual(plain(model.pipeline(null).open), { count: 0, totals: [] });
});

test('a company\'s own deals are what is open first, then its history, most recently closed first', () => {
  const all = model.dealList([
    deal(D1, 'Won last year', { outcome: 'won', closed_at: '2025-09-10T09:00:00Z' }),
    deal(D2, 'Open now', { stage: 'proposal' }),
    deal(D3, 'Lost recently', { outcome: 'lost', closed_at: '2026-08-01T09:00:00Z' }),
    deal('d-elsewhere', 'Someone else\'s', { company_id: HARBOR })
  ], COMPANIES);
  assert.deepEqual(titles(model.dealsFor(NORTH, all)), ['Open now', 'Lost recently', 'Won last year']);
  assert.deepEqual(titles(model.dealsFor(HARBOR, all)), ['Someone else\'s']);
  assert.deepEqual([...model.dealsFor('', all)], []);
});

/* ── The forms ────────────────────────────────────────────────────────── */

test('a new deal needs a company and a name, and takes the database\'s defaults for the rest', () => {
  const made = model.dealForm({ companyId: NORTH, title: '  Renewal  ' });
  assert.equal(made.problem, null);
  assert.deepEqual(plain(made.values), {
    companyId: NORTH, title: 'Renewal', stage: 'lead', value: null, currency: 'USD',
    ownerId: null, expectedClose: null, notes: null
  });
  assert.deepEqual(plain(model.dealForm({ title: 'Renewal' })), { values: {}, problem: 'Pick the company this deal is for.', field: 'companyId' });
  assert.deepEqual(plain(model.dealForm({ companyId: NORTH, title: '   ' })), { values: {}, problem: 'A deal needs a name.', field: 'title' });
});

test('a new deal is refused exactly what the database would refuse, with the field to point at', () => {
  const bad = (fields, problem, field) => {
    const out = model.dealForm({ companyId: NORTH, title: 'Renewal', ...fields });
    assert.equal(out.problem, problem);
    assert.equal(out.field, field);
  };
  bad({ stage: 'won' }, 'Pick a stage from the pipeline.', 'stage');
  bad({ stage: 'negotiating' }, 'Pick a stage from the pipeline.', 'stage');
  bad({ value: 'twelve thousand' }, 'That value is not an amount.', 'value');
  bad({ value: '-500' }, 'That value is not an amount.', 'value');
  bad({ value: '99999999999' }, 'That value is too large.', 'value');
  bad({ currency: 'Euro' }, 'Pick a currency, like EUR or USD.', 'currency');
  bad({ expectedClose: '30-11-2026' }, 'That is not a date, like 2026-11-30.', 'expectedClose');
  bad({ expectedClose: '2026-13-40' }, 'That is not a date, like 2026-11-30.', 'expectedClose');
});

test('a new deal is always open: won and lost are decided from the board, never typed into the form that makes one', () => {
  const made = model.dealForm({ companyId: NORTH, title: 'Renewal', outcome: 'won', closedAt: '2026-09-14T00:00:00Z' });
  assert.equal('outcome' in made.values, false);
  assert.equal('closedAt' in made.values, false);
});

test('an amount and a stage are read the way a person writes them, and a typed label is the same stage as its value', () => {
  assert.equal(model.dealForm({ companyId: NORTH, title: 'R', value: '12.500,50' }).values.value, 12500.5);
  assert.equal(model.dealForm({ companyId: NORTH, title: 'R', value: '12,500' }).values.value, 12500);
  assert.equal(model.dealForm({ companyId: NORTH, title: 'R', stage: 'Qualified' }).values.stage, 'qualified');
  assert.equal(model.dealForm({ companyId: NORTH, title: 'R', currency: 'eur' }).values.currency, 'EUR');
});

test('an edit saves only the fields the form sent, and only where they differ', () => {
  const record = deal(D1, 'Renewal', { stage: 'proposal', value: '12000.00', currency: 'EUR' });
  assert.deepEqual(plain(model.dealChanges(record, { title: 'Renewal', stage: 'proposal' }).changes), {},
    'nothing changed is nothing to save');
  assert.deepEqual(plain(model.dealChanges(record, { title: 'Retainer renewal' }).changes), { title: 'Retainer renewal' });
  assert.deepEqual(plain(model.dealChanges(record, { value: '15000', stage: 'qualified' }).changes),
    { value: 15000, stage: 'qualified' });
  assert.deepEqual(plain(model.dealChanges(record, { expectedClose: '2026-11-30', notes: ' ' }).changes),
    { expected_close: '2026-11-30' }, 'an empty field means none, which it already was');
  assert.deepEqual(plain(model.dealChanges(record, { companyId: HARBOR }).changes), { company_id: HARBOR });
});

test('an edit never closes a deal or reopens one: the outcome is not a field it can write', () => {
  const record = deal(D1, 'Renewal', { stage: 'proposal' });
  const out = model.dealChanges(record, { outcome: 'won', closedAt: '2026-09-14', stage: 'lead' });
  assert.deepEqual(plain(out.changes), { stage: 'lead' });
});

test('an edit is judged by the same rules a new deal is, and a field nobody touched is not judged at all', () => {
  const record = deal(D1, 'Renewal', { stage: 'proposal', value: '12000.00', currency: 'US$' });
  assert.deepEqual(plain(model.dealChanges(record, { title: '  ' })), { changes: {}, problem: 'A deal needs a name.', field: 'title' });
  assert.deepEqual(plain(model.dealChanges(record, { stage: 'won' })), { changes: {}, problem: 'Pick a stage from the pipeline.', field: 'stage' });
  assert.equal(model.dealChanges(record, { value: 'lots' }).field, 'value');
  assert.equal(model.dealChanges(record, { expectedClose: 'soon' }).field, 'expectedClose');
  assert.equal(model.dealChanges(record, { companyId: '' }).field, 'companyId');
  /* The value it already holds, sent back untouched, is not judged as a typo. */
  assert.deepEqual(plain(model.dealChanges(record, { value: '12000.00', currency: 'USD' }).changes), { currency: 'USD' });
});

test('a deal still holding a currency from before the rule has to be given one in the same change', () => {
  const stale = deal(D1, 'Renewal', { currency: 'US$' });
  const refused = model.dealChanges(stale, { title: 'Retainer' });
  assert.match(refused.problem, /^This deal's currency, "US\$", is not a code like EUR or USD\./);
  assert.equal(refused.field, 'currency');
  assert.deepEqual(plain(refused.changes), {});
  assert.deepEqual(plain(model.dealChanges(stale, { title: 'Retainer', currency: 'USD' }).changes),
    { title: 'Retainer', currency: 'USD' });
  assert.deepEqual(plain(model.dealChanges(stale, {}).changes), {}, 'changing nothing is still nothing to fix');
});

/* ── Moving a deal, and closing it ────────────────────────────────────── */

test('closing a deal records which way it went and the day it went that way — the database refuses either alone', () => {
  const [open] = model.dealList([deal(D1, 'Renewal', { stage: 'proposal' })], COMPANIES);
  const won = model.closeChanges(open, 'won', '2026-09-14T00:00:00Z');
  assert.deepEqual(plain(won.changes), { outcome: 'won', closed_at: '2026-09-14T00:00:00Z' });
  assert.equal('stage' in won.changes, false, 'it keeps the stage it stood at: that is the history');
  assert.equal(model.closeChanges(open, 'Lost', '2026-09-14T00:00:00Z').changes.outcome, 'lost', 'a label is the same outcome as its value');
});

test('closing a deal that is already that way, or neither way, changes nothing and says why', () => {
  const [won] = model.dealList([deal(D1, 'R', { outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })], COMPANIES);
  assert.deepEqual(plain(model.closeChanges(won, 'won', '2026-09-14T00:00:00Z')),
    { changes: {}, problem: 'That deal is already won.' });
  assert.deepEqual(plain(model.closeChanges(won, 'maybe', '2026-09-14T00:00:00Z')),
    { changes: {}, problem: 'Say whether the deal was won or lost.' });
  assert.equal(model.closeChanges(won, 'lost', '2026-09-14T00:00:00Z').changes.outcome, 'lost', 'a deal won can still be corrected to lost');
});

test('reopening clears the outcome and the date together, which is the only way the database allows either', () => {
  const [won] = model.dealList([deal(D1, 'R', { outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })], COMPANIES);
  assert.deepEqual(plain(model.reopenChanges(won).changes), { outcome: null, closed_at: null });
  const [open] = model.dealList([deal(D2, 'R')], COMPANIES);
  assert.deepEqual(plain(model.reopenChanges(open)), { changes: {}, problem: 'That deal is already open.' });
});

test('dropping a card on a stage column moves it there, and on its own column changes nothing at all', () => {
  const [open] = model.dealList([deal(D1, 'Renewal', { stage: 'lead' })], COMPANIES);
  assert.deepEqual(plain(model.moveChanges(open, 'proposal').changes), { stage: 'proposal' });
  assert.deepEqual(plain(model.moveChanges(open, 'lead')), { changes: {}, problem: null },
    'a drag that goes nowhere costs no write, and says nothing either');
  assert.deepEqual(plain(model.moveChanges(open, 'elsewhere')), { changes: {}, problem: 'That is not a column on the board.' });
});

test('dropping a card on Won or Lost closes it where it stands', () => {
  const [open] = model.dealList([deal(D1, 'Renewal', { stage: 'proposal' })], COMPANIES);
  const won = model.moveChanges(open, 'won', '2026-09-14T00:00:00Z');
  assert.deepEqual(plain(won.changes), { outcome: 'won', closed_at: '2026-09-14T00:00:00Z' });
  assert.deepEqual(plain(model.moveChanges(open, 'lost', '2026-09-14T00:00:00Z').changes),
    { outcome: 'lost', closed_at: '2026-09-14T00:00:00Z' });
});

test('dropping a closed card back on a stage reopens it in the same write, since it cannot be both', () => {
  const [won] = model.dealList([deal(D1, 'R', { stage: 'qualified', outcome: 'won', closed_at: '2026-09-10T09:00:00Z' })], COMPANIES);
  assert.deepEqual(plain(model.moveChanges(won, 'proposal').changes), { stage: 'proposal', outcome: null, closed_at: null });
  assert.deepEqual(plain(model.moveChanges(won, 'won')), { changes: {}, problem: null }, 'already in that column');
  assert.deepEqual(plain(model.moveChanges(won, 'lost', '2026-09-14T00:00:00Z').changes),
    { outcome: 'lost', closed_at: '2026-09-14T00:00:00Z' }, 'one outcome can be corrected to the other');
});

/* ── Dates ────────────────────────────────────────────────────────────── */

test('a day someone picked is stored as the start of that day on their own clock, never UTC\'s midnight', () => {
  /* Amsterdam is ahead of UTC, so its midnight is the evening before there —
     read as UTC, a close date would land on the day before. */
  assert.equal(model.instantOf('2026-11-30'), '2026-11-29T23:00:00.000Z');
  assert.equal(model.dayOf('2026-11-29T23:00:00.000Z'), '2026-11-30', 'and reads back as the day it was');
  assert.equal(model.instantOf('not a date'), null);
  assert.equal(model.instantOf(''), null);
  assert.equal(model.dayOf(''), '');
  assert.equal(model.dayOf('not a date'), '');
});

/* ── Search ───────────────────────────────────────────────────────────── */

test('the board\'s search finds a deal by its name, its company or its notes', () => {
  const [renewal] = model.dealList([deal(D1, 'Retainer renewal', { notes: 'Ana asked in August' })], COMPANIES);
  assert.equal(model.matchesQuery(renewal, ''), true, 'no search matches everything');
  assert.equal(model.matchesQuery(renewal, 'RETAINER'), true);
  assert.equal(model.matchesQuery(renewal, 'northline'), true);
  assert.equal(model.matchesQuery(renewal, 'august'), true);
  assert.equal(model.matchesQuery(renewal, 'harbor'), false);
  assert.equal(model.matchesQuery(null, 'anything'), false);
});
