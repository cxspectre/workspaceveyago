/* The agenda and the tasks as app.js and workspace.js wire them in: today on
   the Overview — its panel, its tile and the bell — the create forms left to
   app.js, and a project page's task panel. The functions are app.js's own, taken from
   the file and run in a sandbox beside the models they read, on a clock the
   test sets, in Amsterdam; the page around them is stand-ins.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'Europe/Amsterdam';

/* Tuesday, September 15, 2026, 09:10: the week is Monday 14 to Sunday 20. */
const NOW = new Date(2026, 8, 15, 9, 10).getTime();
const THIS_WEEK = '2026-09-14';
const at = (day, hour = 0, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const APP = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8').split('\n');
const WORKSPACE = readFileSync(new URL('../dist/workspace.js', import.meta.url), 'utf8');
function take(prefix) {
  const found = APP.filter(line => line.startsWith(prefix));
  assert.equal(found.length, 1, `app.js has one line starting ${prefix}`);
  return found[0];
}
const WIRING = ['const todayEvents=', 'function overviewCounts(){', 'function agendaPanel(){', 'function attentionItems(){', 'function createForm(kind){']
  .map(take).join('\n');

/* An event as queries.js hands it to the store, the row under `row`. */
function event(id, startsAt, endsAt, over = {}) {
  const row = { id, title: id, detail: null, location: null, starts_at: startsAt, ends_at: endsAt, all_day: false, kind: 'team', status: 'confirmed', ...over };
  return { id, title: row.title, detail: row.detail || row.location || '', time: 'the time queries.js wrote', end: '', day: new Date(startsAt).getDate(), row };
}

/* Yesterday into this afternoon, this morning, and next Tuesday. */
const OFFSITE = event('offsite', at(14, 10), at(15, 16), { title: 'Studio offsite', kind: 'internal', location: 'Lisbon' });
const STANDUP = event('standup', at(15, 9), at(15, 9, 30), { title: 'Standup' });
const LATER = event('later', at(22, 11), at(22, 12), { title: 'Next week\'s review' });

function load({ events = [OFFSITE, STANDUP, LATER], has = ['events'], weeks = [THIS_WEEK], failed = [], page = 'overview', days = [] } = {}) {
  const modals = [];
  const dayCalls = [];
  const context = vm.createContext({
    console,
    esc: escape,
    icon: name => `<svg data-icon="${name}"></svg>`,
    pill: (label, tone) => `<span class="pill ${tone}">${escape(label)}</span>`,
    showModal: (eyebrow, body) => modals.push({ eyebrow, body }),
    page,
    events,
    tickets: [],
    projects: [],
    mails: [],
    isManagerNow: () => false,
    shapedInvoices: () => [],
    mailModel: { ALL: 'all', unreadCount: () => 0 },
    projectsModel: { isActive: () => true },
    workspaceStore: { has: part => has.includes(part), weekLoaded: key => weeks.includes(key), state: { overview: null, failed } },
    agendaUi: { dayOptions: options => { dayCalls.push({ ...options }); return days; } }
  });
  context.window = context;
  vm.runInContext(`const RealDate = Date; var __now = ${NOW};
    Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [__now])); } static now() { return __now; } };`, context);
  for (const file of ['agenda-model.js', 'overview-model.js', 'finance-model.js', 'shell-model.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  vm.runInContext(WIRING, context);
  return { context, modals, dayCalls };
}

const eventsEntry = context => [...context.attentionItems()].find(item => item.route === 'agenda/today') || null;

/* app.js's hasDraft(), run over these fields on the page: whether a quiet
   repaint would lose what someone is writing. */
function drafting(fields, focused = null) {
  const main = { contains: () => false, querySelectorAll: () => fields };
  const context = vm.createContext({ document: { querySelector: selector => (selector === '#main' ? main : null), activeElement: focused } });
  vm.runInContext(take('const hasDraft='), context);
  return vm.runInContext('hasDraft()', context);
}

test('a note box drawn with words kept for it holds a quiet repaint back only while it has the keyboard: left, it is drawn again with them', () => {
  const field = (value, defaultValue, inNoteBox = true) => ({ value, defaultValue, closest: selector => (inNoteBox && selector === '[data-note-form]' ? {} : null) });
  const kept = field('Half a note', 'Half a note');
  assert.equal(drafting([kept], kept), true, 'being written in, the repaint waits');
  assert.equal(drafting([kept]), false, 'left for elsewhere, nothing is lost by drawing it again from what was kept');
  const empty = field('', '');
  assert.equal(drafting([empty], empty), false);
  const spaces = field('  ', '  ');
  assert.equal(drafting([spaces], spaces), false, 'spaces are nothing written');
  assert.equal(drafting([field('Typed', '', false)]), true, 'any field typed into is being written in, as before');
  assert.equal(drafting([field('As drawn', 'As drawn', false)]), false, 'a field elsewhere, as it was drawn, is not');
});

/* ── Today on the Overview ────────────────────────────────────────────── */

test('today on the Overview is what is on today, whatever other week is loaded — and the tile, the bell and the panel agree', () => {
  const { context } = load();
  assert.equal(context.overviewCounts().eventsToday, 2, 'the offsite that runs into today, and the standup');
  const entry = eventsEntry(context);
  assert.ok(entry, 'the bell has today\'s events, opening today in the agenda');
  assert.match(entry.detail, /Standup/);
  assert.match(entry.detail, /Studio offsite/);
  assert.doesNotMatch(entry.detail, /Next week/);
  const panel = context.agendaPanel();
  assert.match(panel, /<a class="agenda-item" href="#agenda\/standup"><div class="agenda-time">09:00 – 09:30<\/div>/, 'each event a link to its page, its time inside it');
  assert.match(panel, /href="#agenda\/offsite"><div class="agenda-time">Until 16:00<\/div>/);
  assert.match(panel, /class="agenda-description type-internal"/);
  assert.doesNotMatch(panel, /Next week/);
  assert.doesNotMatch(panel, /the time queries\.js wrote/);
  assert.equal((panel.match(/data-nav="agenda\/today"/g) || []).length, 2, 'Open agenda and View full calendar open today');
});

test('a quiet day says so', () => {
  const { context } = load({ events: [LATER] });
  assert.equal(context.overviewCounts().eventsToday, 0);
  assert.match(context.agendaPanel(), /Nothing in the diary today\./);
  assert.equal(eventsEntry(context), null);
});

test('while today\'s week is not in, the Overview says it is loading, or that it did not load — never that nothing is on', () => {
  for (const setup of [{ has: [] }, { weeks: ['2026-09-21'] }]) {
    const { context } = load(setup);
    assert.equal(context.overviewCounts().eventsToday, null, 'the tile falls back to the database\'s count');
    assert.equal(eventsEntry(context), null);
    const panel = context.agendaPanel();
    assert.match(panel, /Today’s agenda is loading…/);
    assert.doesNotMatch(panel, /Nothing in the diary/);
    assert.doesNotMatch(panel, /class="agenda-item"/);
  }
  assert.match(load({ weeks: [], failed: ['the agenda'] }).context.agendaPanel(), /The agenda did not load\. It is tried again by itself\./);
});

/* ── The create forms ─────────────────────────────────────────────────── */

/* New event is event-edit.js's own dialog (tests/event-edit.test.mjs). */
const DAYS = [
  { key: '2026-09-14', label: 'Monday, September 14', selected: false },
  { key: '2026-09-15', label: 'Tuesday, September 15', selected: true }
];

test('app.js\'s create forms do not need the agenda at all, and no longer draw an event form of their own', () => {
  const { context, modals, dayCalls } = load({ days: DAYS });
  context.createForm('agenda');
  assert.doesNotMatch(modals[0].body, /name="day"|name="time"|Create an event/, 'the old form, which locked and dropped its notes, is gone');
  assert.deepEqual(dayCalls, []);
});

test('the other create forms do not need the agenda at all', () => {
  const { context, modals, dayCalls } = load({ days: DAYS });
  context.agendaUi = undefined;
  for (const kind of ['tickets', 'projects', 'crm']) assert.doesNotThrow(() => context.createForm(kind), kind);
  assert.equal(modals.length, 3);
  assert.deepEqual(dayCalls, []);
});

/* ── Search ───────────────────────────────────────────────────────────── */

test('search is handed the project meetings coming up, beside the weeks loaded', () => {
  const meeting = { id: 'pm9', title: 'Harbor design review' };
  const context = vm.createContext({
    workspaceStore: { state: { companies: [], projectEvents: [meeting] } },
    overviewModel: { visibleNavs: list => list }, navs: [], isManagerNow: () => false,
    tickets: [], projects: [], contacts: [], team: [], events: [STANDUP], shapedInvoices: () => [],
    financeModel: { matchesQuery: () => false }, mails: [], recordNotes: {}, mailModel: {}
  });
  /* As on a page, where window is the global the scripts share. */
  context.window = context;
  vm.runInContext(take('function searchSources(){'), context);
  const handed = vm.runInContext('searchSources()', context);
  assert.deepEqual([...handed.projectEvents].map(e => e.id), ['pm9']);
  assert.deepEqual([...handed.events].map(e => e.id), ['standup']);
  delete context.workspaceStore;
  assert.deepEqual([...vm.runInContext('searchSources()', context).projectEvents], [], 'before the store is on the page, none');
});

/* ── A project page ───────────────────────────────────────────────────── */

test('a project page draws its own task panel', () => {
  assert.match(WORKSPACE, /const taskPanel=tasksUi\.panel\(p\);/);
});
