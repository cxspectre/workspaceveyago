/* The Agenda's page, as agenda-ui.js draws it: which week and days are on
   screen and where the week buttons and a picked day take them, events over
   several days and clashes, what anyone typed kept as text, an event's page,
   who may change or remove an event, the parts of the store an event comes
   back in, and removing one on dialog-forms.js. The page's helpers are
   stand-ins that keep what they are given, so what is tested is what
   agenda-ui.js hands them. Loaded into a sandbox the way <script> tags run it,
   on a clock the test sets, in Amsterdam. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'Europe/Amsterdam';

/* Wednesday, September 16, 2026, 09:00: the week is Monday 14 to Sunday 20. */
const NOW = new Date(2026, 8, 16, 9).getTime();
const TYPED = '<img src=x onerror=alert(1)>';
const WAIT = 'The last change to that event is still on its way. Try again in a moment.';
const REMOVAL_REFUSED = 'The event was not removed: it has been removed already, or only whoever booked it, or an owner or admin, can remove it — an event from a connected calendar is removed there.';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const at = (day, hour = 0, minute = 0, month = 8) => new Date(2026, month, day, hour, minute).toISOString();
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* An event as queries.events() hands it to the store, the row under `row`. */
function event(id, startsAt, endsAt, over = {}) {
  const row = {
    id, title: id, detail: null, location: null, starts_at: startsAt, ends_at: endsAt, all_day: false,
    kind: 'team', status: 'confirmed', project_id: null, company_id: null, contact_id: null,
    connection_id: 'conn-1', created_by: null, ...over
  };
  return { id, title: row.title, detail: row.detail || row.location || '', row };
}

/* An element a click lands on, with one data attribute. */
function target(attribute, value) {
  const key = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const node = { dataset: { [key]: value } };
  return { closest: selector => (selector === `[${attribute}]` ? node : null) };
}

/* refuseRemove: the database removes nothing. */
function load({ list = [], projectEvents = [], route = ['agenda'], mode = 'week', loaded = true, me = 'e-me', manager = false, contacts = [], projects = [], weeks = null, failed = [], ask = null, refuseRemove = false,
  team = [], companies = [], parts = ['events', 'team'], invitees = null, storage = null, phone = false } = {}) {
  const invitesAsked = [];
  const heading = { attributes: {}, focused: 0, setAttribute(name, value) { this.attributes[name] = value; }, focus() { this.focused += 1; } };
  /* The page's own heading, and the events a page asked the store for by id. */
  const title = { attributes: {}, focused: 0, setAttribute(name, value) { this.attributes[name] = value; }, focus() { this.focused += 1; } };
  /* The first calendar's toggle, as the page draws it. */
  const kindButton = { attributes: {}, focused: 0, setAttribute(name, value) { this.attributes[name] = value; }, focus() { this.focused += 1; } };
  const asks = [];
  const retried = [];
  const listeners = {};
  const dateChanges = [];
  const shown = [];
  const modals = [];
  const navigated = [];
  const toasts = [];
  const removed = [];
  const repaints = [];
  const handlers = {};
  /* The Remove dialog's form, as dialog-forms.js reaches into it. */
  const button = { disabled: false };
  const error = { textContent: '', id: 'agenda-remove-form-error' };
  const form = {
    isConnected: true,
    addEventListener: (type, fn) => { handlers[type] = fn; },
    querySelector: selector => (selector === '.form-error' ? error : selector === '.form-candidates' ? null : button)
  };
  /* The load after a write, while a test holds it; the loads begun so far, and
     the one each part last arrived from (store.js mark and loadedSince). */
  const holds = { reload: null };
  const loads = { begun: 0, arrived: {} };
  const context = vm.createContext({
    console,
    esc: escape,
    icon: name => `<svg data-icon="${name}"></svg>`,
    pill: (label, tone) => `<span class="pill ${tone}">${escape(label)}</span>`,
    titlebar: (title, subtitle, action = '') => `<h1>${escape(title)}</h1>${action}`,
    createButton: label => `<button>${label}</button>`,
    segments: (items, current, key) => items.map(([value, label]) =>
      `<button data-view="${key}" data-value="${value}"${current === value ? ' class="active"' : ''}>${label}</button>`).join(''),
    countTag: n => `<span class="small-count">${n}</span>`,
    empty: (title, body) => `<div class="workspace-empty"><h3>${escape(title)}</h3><p>${escape(body)}</p></div>`,
    detailHeader: (parent, label, title, subtitle, actions = '') =>
      `<a href="#${parent}">${escape(label)}</a><h1>${escape(title)}</h1><p class="sub">${escape(subtitle)}</p>${actions}`,
    properties: rows => rows.map(([k, v]) => `<div class="property-row"><span>${k}</span><div>${v}</div></div>`).join(''),
    linkedPanel: (title, items) => `<section><h2>${title}</h2>${items.map(([route, label, meta]) =>
      `<a href="#${escape(route)}"><strong>${escape(label)}</strong><small>${escape(meta)}</small></a>`).join('')}</section>`,
    notesPanel: (kind, id) => `<section class="notes" data-kind="${kind}" data-id="${escape(id)}"></section>`,
    notFound: () => '<p>Record not found</p>',
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); context.modal.open = true; },
    modal: { open: false, close() { this.open = false; } },
    navigate: to => navigated.push(to),
    repaintKeepingFocus: () => repaints.push(true),
    routeParts: route,
    events: list,
    contacts,
    projects,
    team,
    agendaMode: mode,
    /* The screen: a phone answers the page's narrow media query. */
    matchMedia: query => ({ matches: Boolean(phone) && /max-width:\s*840px/.test(query) }),
    workspaceSession: { employee: me ? { id: me } : null, isManager: () => manager },
    workspaceStore: {
      state: { loaded, companies, projectEvents, failed },
      /* As store.js looks an event up: the weeks loaded, then the project meetings. */
      eventById: id => [...context.events, ...context.workspaceStore.state.projectEvents]
        .find(e => String(e.id).toLowerCase() === String(id).toLowerCase()) || null,
      has: part => loaded && parts.includes(part),
      /* As store.js asks for who is invited to an event whose row left them out. */
      askInvitees: id => { invitesAsked.push(id); return invitees ? invitees(id) : { state: 'missing', attendees: [] }; },
      showWeek: week => shown.push(week.key),
      weekLoaded: key => (weeks ? weeks.includes(key) : true),
      /* As store.js's after() does: once the write is in, the workspace is
         loaded again, bringing the weeks and the project meetings back; a
         refusal is said in a toast unless the caller says it itself. */
      after: (work, options) => Promise.resolve(work).then(
        value => (holds.reload ? holds.reload.promise : Promise.resolve()).then(() => {
          loads.begun += 1;
          ['events', 'projectEvents'].forEach(part => { loads.arrived[part] = loads.begun; });
          return value;
        }),
        err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; }),
      mark: () => loads.begun,
      loadedSince: (part, mark) => loads.arrived[part] !== undefined && loads.arrived[part] > mark,
      askEvent: id => { asks.push(id); return ask ? ask(id) : { state: 'missing', event: null }; },
      retryEvent: id => retried.push(id)
    },
    workspaceActions: {
      deleteEvent: async id => {
        removed.push(id);
        if (refuseRemove) throw Object.assign(new Error(REMOVAL_REFUSED), { refused: true });
      }
    },
    CAL: { onChange: fn => dateChanges.push(fn) },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: () => form,
      querySelector: selector => (selector === '#main .day-view h2' ? heading : selector === '#main h1' ? title
        : selector === '#main [data-agenda-kind]' ? kindButton : null)
    },
    agendaView: () => 'the page workspace.js drew'
  });
  context.window = context;
  /* This browser's storage, when the test gives one. */
  if (storage === 'blocked') {
    /* As a browser set to block site data: reaching localStorage at all throws. */
    Object.defineProperty(context, 'localStorage', { get() { throw new Error('The operation is insecure.'); } });
  } else if (storage) {
    context.localStorage = storage;
  }
  vm.runInContext(`const RealDate = Date; var __now = ${NOW};
    Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [__now])); } static now() { return __now; } };`, context);
  for (const file of ['agenda-model.js', 'dialog-forms.js', 'agenda-ui.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  return {
    view: () => context.agendaView(),
    options: (how = { onAgenda: true }) => [...context.agendaUi.dayOptions(how)],
    go: to => context.navigate(to),
    route: () => [...context.routeParts],
    heading,
    click: node => (listeners.click || []).forEach(fn => fn({ target: node, preventDefault() {} })),
    setNow: ms => vm.runInContext(`__now = ${ms}`, context),
    changeDate: () => dateChanges.forEach(fn => fn()),
    submit: async () => { handlers.submit({ preventDefault() {} }); await settle(); },
    mode: () => context.agendaMode,
    setRoute: parts => { context.routeParts = parts; },
    canChange: e => context.agendaUi.canChange(e),
    partsOf: e => [...context.agendaUi.partsOf(e)],
    hiddenCalendar: kind => context.agendaUi.hiddenCalendar(kind),
    /* Holds the load after the next write open until the function it returns is called. */
    holdReload: () => { let release; holds.reload = { promise: new Promise(resolve => { release = resolve; }) }; return () => { holds.reload = null; release(); }; },
    shown, modals, navigated, toasts, removed, repaints, button, error, title, asks, retried, invitesAsked, kindButton, modal: context.modal
  };
}

const dayColumns = html => (html.match(/<div class="calendar-day[ "]/g) || []).length;

test('opened anywhere but the Agenda, the New event form offers this week with today chosen, whatever week the agenda was left on', () => {
  const page = load();
  page.click(target('data-agenda-week', 'next'));
  const away = page.options({ onAgenda: false });
  assert.equal(away[0].key, '2026-09-14');
  assert.deepEqual(away.filter(o => o.selected).map(o => o.key), ['2026-09-16']);
  assert.equal(page.options()[0].key, '2026-09-21', 'on the Agenda, the week on screen');
});

test('"agenda/today" opens this week with today picked, at #agenda, and any other address goes where it says', () => {
  const page = load();
  page.click(target('data-agenda-week', 'next'));
  page.go('agenda/today');
  assert.deepEqual(page.navigated, ['agenda']);
  assert.equal(page.options()[0].key, '2026-09-14');
  assert.deepEqual(page.options().filter(o => o.selected).map(o => o.key), ['2026-09-16']);
  page.go('tickets/7');
  assert.deepEqual(page.navigated, ['agenda', 'tickets/7']);
});

test('an address typed as #agenda/today draws this week, not an event called "today"', () => {
  const page = load({ route: ['agenda', 'today'] });
  page.click(target('data-agenda-week', 'next'));
  const html = page.view();
  assert.match(html, /<h2>September 14 – 18, 2026 <small>This week<\/small><\/h2>/, 'this week, its weekdays: nothing is on at the weekend');
  assert.doesNotMatch(html, /Record not found/);
  assert.deepEqual(page.route(), ['agenda']);
});

test('a day picked stays picked when the date changes inside its week, and moves on with a new week', () => {
  const page = load();
  page.click(target('data-agenda-day', '2026-09-18'));
  page.setNow(new Date(2026, 8, 17, 0, 1).getTime());
  page.changeDate();
  assert.deepEqual(page.options().filter(o => o.selected).map(o => o.key), ['2026-09-18']);
  page.setNow(new Date(2026, 8, 19, 0, 1).getTime());
  page.changeDate();
  assert.equal(page.options()[0].key, '2026-09-21', 'at the weekend the agenda moves on to the week about to start');
});

test('a week whose events did not load says so, rather than "Loading…" for good; one still loading says that, not that the week is free', () => {
  const failed = load({ weeks: [], failed: ['the agenda'] }).view();
  assert.match(failed, /Did not load/);
  assert.match(failed, /The agenda did not load/);
  const loading = load({ weeks: [] }).view();
  assert.match(loading, /Loading…/);
  assert.match(loading, /Loading the week…/);
  assert.doesNotMatch(loading, /The agenda did not load|Nothing on this week/);
  const first = load({ loaded: false }).view();
  assert.match(first, /Loading the week…/, 'before the first load has answered, it is loading, not failed');
  assert.doesNotMatch(first, /The agenda did not load/);
  assert.match(load({ loaded: false, failed: ['the agenda'] }).view(), /The agenda did not load/);
});

test('an event page opened before the agenda has loaded says it is loading, and says when the agenda did not load', () => {
  const waiting = load({ loaded: false, route: ['agenda', 'k'] }).view();
  assert.match(waiting, /This event cannot be shown yet/);
  assert.match(waiting, /The agenda is loading\./);
  assert.doesNotMatch(waiting, /did not load/);
  assert.match(load({ loaded: false, failed: ['the agenda'], route: ['agenda', 'k'] }).view(), /The agenda did not load\. It is tried again by itself\./);
});

test('a card says its calendar in words as well as colour, the day view shows it, and the week\'s day buttons say which day is picked', () => {
  const list = [event('deep', at(16, 9), at(16, 11), { kind: 'focus', title: 'Deep work' })];
  const week = load({ list }).view();
  assert.match(week, /<strong>Deep work<\/strong><span class="sr-only">, Focus time\.<\/span>/);
  assert.match(week, /class="calendar-day-button" data-agenda-day="2026-09-16" aria-label="Wednesday, September 16, 2026" aria-current="date"><span>/,
    'a button that opens the day is not a toggle: no pressed state, and "picked" only for a day someone picked');
  assert.doesNotMatch(week, /aria-pressed="(true|false)"><span>/);
  const tentative = load({ list: [event('maybe', at(16, 13), at(16, 14), { title: 'Maybe lunch', status: 'tentative' })], mode: 'schedule' }).view();
  assert.match(tentative, /<strong>Maybe lunch<\/strong><small class="tentative-note">Tentative<\/small>/, 'a tentative event says so in words');
  assert.match(tentative, /<div class="schedule-date today" aria-current="date">/, 'the schedule marks today');
  const day = load({ list, mode: 'day' }).view();
  assert.match(day, /<\/a><span aria-hidden="true"><span class="pill gray">Focus time<\/span><\/span><\/div>/, 'said once: the card says it to a screen reader');
});

test('on a phone the agenda opens on the schedule, which fits it; Week is a tap away, and a view already picked stays', () => {
  assert.equal(load({ phone: true }).mode(), 'schedule');
  assert.equal(load().mode(), 'week', 'a wider screen opens on the week');
  assert.equal(load({ phone: true, mode: 'day' }).mode(), 'day');
});

test('an event not in the weeks loaded is fetched by its id: its page says so while it loads, draws it once it lands, and says when there is none', () => {
  const PAST = 'e9000000-0000-4000-8000-000000000001';
  const pitch = event(PAST, at(1, 10, 0, 7), at(1, 11, 0, 7), { title: 'Pitch' });
  let answer = { state: 'loading', event: null };
  const page = load({ route: ['agenda', PAST], ask: () => answer });
  assert.match(page.view(), /<h1>Loading the event…<\/h1>/);
  assert.deepEqual(page.asks, [PAST]);
  answer = { state: 'ready', event: pitch };
  assert.match(page.view(), /<h1>Pitch<\/h1>/, 'a client\'s past meeting opens its page');
  answer = { state: 'missing', event: null };
  assert.match(page.view(), /Record not found/);
  const waiting = load({ route: ['agenda', PAST], loaded: false, ask: () => answer });
  assert.match(waiting.view(), /This event cannot be shown yet\./);
  assert.deepEqual(waiting.asks, [], 'nothing is asked for before the agenda has loaded');
});

test('an event that did not load can be asked for again, and the keyboard goes to the page\'s heading', () => {
  const PAST = 'e9000000-0000-4000-8000-000000000001';
  const page = load({ route: ['agenda', PAST], ask: () => ({ state: 'failed', event: null }) });
  const html = page.view();
  assert.match(html, /<h1>This event did not load\.<\/h1>/);
  assert.match(html, new RegExp(`<button type="button" class="btn" data-agenda-event-retry="${PAST}">Try again</button>`));
  page.click(target('data-agenda-event-retry', PAST));
  assert.deepEqual(page.retried, [PAST]);
  assert.equal(page.repaints.length, 1, 'the page is drawn again, which asks');
  assert.equal(page.title.focused, 1, 'Try again is gone, so the heading takes the keyboard');
  assert.equal(page.title.attributes.tabindex, '-1');
});

test('a day picked in the week takes you to its heading in Day view', () => {
  const page = load();
  page.click(target('data-agenda-day', '2026-09-18'));
  assert.equal(page.heading.focused, 1);
  assert.equal(page.heading.attributes.tabindex, '-1');
});

test('the New event form offers the week on screen, weekend too, with the day picked chosen, else today, else Monday', () => {
  const page = load();
  const keys = () => page.options().map(o => o.key);
  const chosen = () => page.options().filter(o => o.selected).map(o => o.key);
  assert.deepEqual(keys(), ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
  assert.deepEqual(chosen(), ['2026-09-16'], 'today, a Wednesday');
  assert.equal(page.options()[2].label, 'Wednesday, September 16');
  page.click(target('data-agenda-day', '2026-09-19'));
  assert.deepEqual(chosen(), ['2026-09-19'], 'the day picked, a Saturday');
  page.click(target('data-agenda-week', 'next'));
  assert.equal(keys()[0], '2026-09-21');
  assert.deepEqual(chosen(), ['2026-09-21'], 'Monday, in a week without today in it');
  page.click(target('data-agenda-week', 'today'));
  assert.deepEqual(chosen(), ['2026-09-16']);
});

/* ── The week ───────────────────────────────────────────────────────────── */

test('the agenda opens on this week, Monday to Friday, with the weekend only when something is on it', () => {
  const weekdays = load({ list: [event('standup', at(14, 10), at(14, 10, 30))] }).view();
  assert.equal(dayColumns(weekdays), 5);
  assert.match(weekdays, /September 14 – 18, 2026 <small>This week<\/small>/);
  assert.match(weekdays, /<div class="calendar-day today selected">/, 'today is Wednesday, and picked while nothing else is');
  const weekend = load({ list: [event('launch', at(19, 11), at(19, 12))] }).view();
  assert.equal(dayColumns(weekend), 7);
  assert.match(weekend, /<section class="panel calendar with-weekend">/);
});

test('Previous, Today and Next move a week at a time, and tell the store which week to load', () => {
  const h = load();
  h.click(target('data-agenda-week', 'next'));
  assert.deepEqual(h.shown, ['2026-09-21']);
  assert.match(h.view(), /September 21 – 25, 2026 <small>Next week<\/small>/);
  h.click(target('data-agenda-week', 'previous'));
  h.click(target('data-agenda-week', 'previous'));
  assert.match(h.view(), /September 7 – 11, 2026 <small>Last week<\/small>/);
  h.click(target('data-agenda-week', 'today'));
  assert.deepEqual(h.shown, ['2026-09-21', '2026-09-14', '2026-09-07', '2026-09-14']);
  assert.match(h.view(), /<div class="calendar-day today selected">/);
  assert.equal(h.repaints.length, 4, 'each move repaints, keeping focus on the button');
});

test('a day picked in the mini month opens that day, in its own week', () => {
  const h = load({ list: [event('review', at(2, 14, 0, 9), at(2, 15, 0, 9), { title: 'Design review' })] });
  h.click(target('data-agenda-day', '2026-10-02'));
  assert.deepEqual(h.shown, ['2026-09-28']);
  assert.equal(h.mode(), 'day');
  const html = h.view();
  assert.match(html, /<h2>Friday, October 2, 2026<\/h2><span class="small-count">1<\/span>/);
  assert.match(html, /Design review/);
  h.click(target('data-agenda-day', '2026-02-30'));
  assert.deepEqual(h.shown, ['2026-09-28'], 'a date that does not exist moves nothing');
});

test('the mini month offers every day, marks today and the picked day, and names each for a screen reader', () => {
  const html = load().view();
  assert.match(html, /<button type="button" data-agenda-day="2026-09-16" class="in-week today selected" aria-label="Wednesday, September 16, 2026" aria-current="date">16<\/button>/);
  assert.match(html, /<button type="button" data-agenda-day="2026-08-31" class="outside" aria-label="Monday, August 31, 2026">31<\/button>/);
});

test('an event over several days is on each of them, at the time it has there, and clashes are marked', () => {
  const late = event('late', at(14, 22), at(15, 2), { title: 'Late deploy' });
  const a = event('a', at(16, 10), at(16, 11), { title: 'Planning' });
  const b = event('b', at(16, 10, 30), at(16, 11, 30), { title: 'Interview' });
  const html = load({ list: [late, a, b] }).view();
  assert.match(html, /<a class="calendar-event type-team part-first" href="#agenda\/late"><small>From 22:00<\/small>/);
  assert.match(html, /<a class="calendar-event type-team part-last" href="#agenda\/late"><small>Until 02:00<\/small>/);
  assert.match(html, /<a class="calendar-event type-team part-whole clash" href="#agenda\/a">.*?<small class="clash-note">Clashes with Interview<\/small>/);
  assert.match(html, /<a class="calendar-event type-team part-whole clash" href="#agenda\/b">.*?<small class="clash-note">Clashes with Planning<\/small>/);
});

test('each kind reads in its own colour, in the week, the schedule and the key', () => {
  const list = [event('focus', at(15, 9), at(15, 11), { kind: 'focus', title: 'Deep work' })];
  assert.match(load({ list }).view(), /class="calendar-event type-focus part-whole"/);
  const schedule = load({ list, mode: 'schedule' }).view();
  assert.match(schedule, /<strong>Deep work<\/strong><span class="pill gray">Focus time<\/span>/);
  assert.match(schedule, /<span class="key-amber" aria-hidden="true"><\/span>Personal/);
});

/* A browser's localStorage, holding what it is given. */
function memoryStorage(initial = {}) {
  const items = { ...initial };
  return { items, getItem: key => (key in items ? items[key] : null), setItem: (key, value) => { items[key] = String(value); } };
}

test('a calendar can be hidden and shown again — in the week, the day and the schedule — and a clash with a hidden event is still said', () => {
  const standup = event('standup', at(15, 9), at(15, 10), { title: 'Standup', kind: 'team' });
  const dentist = event('dentist', at(15, 9, 30), at(15, 10, 30), { title: 'Dentist', kind: 'personal' });
  const gym = event('gym', at(16, 7), at(16, 8), { title: 'Gym', kind: 'personal' });
  const storage = memoryStorage();
  const h = load({ list: [standup, dentist, gym], storage });
  const shown = h.view();
  assert.match(shown, /<div class="agenda-kinds" role="group" aria-label="Calendars shown">/);
  assert.match(shown, /<button type="button" class="calendar-key" data-agenda-kind="personal" aria-pressed="true"><span class="key-amber" aria-hidden="true"><\/span>Personal<\/button>/);
  assert.doesNotMatch(shown, /data-agenda-kind="all"/, 'nothing hidden, nothing to show again');
  assert.match(shown, /<strong>Dentist<\/strong>/);

  h.click(target('data-agenda-kind', 'personal'));
  const hidden = h.view();
  assert.equal(h.repaints.length, 1);
  assert.match(hidden, /data-agenda-kind="personal" aria-pressed="false"/);
  assert.doesNotMatch(hidden, /<strong>Dentist<\/strong>|<strong>Gym<\/strong>/);
  assert.match(hidden, /<strong>Standup<\/strong>/);
  assert.match(hidden, /Clashes with Dentist/, 'the clash is real, whether or not the calendar is shown');
  assert.match(hidden, /<div class="empty-calendar">1 event in a hidden calendar<\/div>/, 'a day with only hidden events does not say it is free');
  assert.match(hidden, /Clashes with Dentist<\/small><\/a><small class="hidden-note">1 more in a hidden calendar<\/small>/, 'nor does a day with some of them');
  assert.equal(h.hiddenCalendar('personal'), 'Personal', 'the page says which calendar it hides');
  assert.equal(h.hiddenCalendar('team'), null);
  assert.equal(h.hiddenCalendar('constructor'), null);
  assert.match(hidden, /<button type="button" class="btn agenda-kinds-all" data-agenda-kind="all">Show all<\/button>/);
  assert.deepEqual(JSON.parse(storage.items['veyago.agenda.hiddenKinds']), ['personal'], 'remembered in this browser');

  const schedule = load({ list: [standup, dentist, gym], storage, mode: 'schedule' }).view();
  assert.doesNotMatch(schedule, /Dentist<\/strong>|Gym<\/strong>/, 'the choice holds after a reload');
  assert.match(schedule, /<p class="quiet-text schedule-empty">1 event in a hidden calendar\.<\/p>/);
  assert.match(schedule, /<strong>Standup<\/strong><span class="pill blue">Team<\/span><\/a><p class="quiet-text schedule-empty">1 more in a hidden calendar\.<\/p>/);
  const day = load({ list: [standup, dentist, gym], storage });
  day.click(target('data-agenda-day', '2026-09-16'));
  assert.match(day.view(), /Nothing in the calendars shown/);
  const partly = load({ list: [standup, dentist, gym], storage });
  partly.click(target('data-agenda-day', '2026-09-15'));
  const partlyView = partly.view();
  assert.match(partlyView, /<span class="small-count">1<\/span>/, 'the day counts what it shows');
  assert.match(partlyView, /<p class="quiet-text hidden-note">1 more in a hidden calendar\.<\/p>/);

  h.click(target('data-agenda-kind', 'all'));
  assert.match(h.view(), /<strong>Dentist<\/strong>/);
  assert.equal(h.kindButton.focused, 1, 'Show all is gone once pressed: the keyboard goes to the first calendar');
  h.click(target('data-agenda-kind', 'focus'));
  h.click(target('data-agenda-kind', 'focus'));
  assert.match(h.view(), /data-agenda-kind="focus" aria-pressed="true"/, 'a second press shows a calendar again');
  assert.deepEqual(JSON.parse(storage.items['veyago.agenda.hiddenKinds']), []);
  assert.deepEqual(JSON.parse(storage.items['veyago.agenda.hiddenKinds']), []);
});

test('what this browser remembers of the calendars hidden is read with care: an unknown calendar is ignored, and storage that fails hides nothing', () => {
  const deep = event('deep', at(15, 9), at(15, 11), { title: 'Deep work', kind: 'focus' });
  const kept = load({ list: [deep], storage: memoryStorage({ 'veyago.agenda.hiddenKinds': JSON.stringify(['focus', 'bogus', 7]) }) }).view();
  assert.doesNotMatch(kept, /Deep work/);
  assert.doesNotMatch(kept, /bogus/);
  for (const storage of [memoryStorage({ 'veyago.agenda.hiddenKinds': 'not json' }), { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, 'blocked']) {
    const h = load({ list: [deep], storage });
    assert.match(h.view(), /Deep work/);
    assert.doesNotThrow(() => h.click(target('data-agenda-kind', 'focus')), 'a browser that keeps nothing still hides it for now');
    assert.doesNotMatch(h.view(), /Deep work/);
  }
  const onlyUnknown = load({ list: [deep], storage: memoryStorage({ 'veyago.agenda.hiddenKinds': JSON.stringify(['bogus']) }) }).view();
  assert.doesNotMatch(onlyUnknown, /data-agenda-kind="all"/, 'an unknown calendar remembered hides nothing, so there is nothing to show again');
  const unknown = load({ list: [deep] });
  unknown.click(target('data-agenda-kind', 'bogus'));
  assert.match(unknown.view(), /Deep work/, 'a forged calendar button hides nothing');
  assert.equal(unknown.repaints.length, 0);
  assert.doesNotMatch(unknown.view(), /data-agenda-kind="all"/);
});

test('what a hidden calendar still decides: the weekend drawn for an event in it, an event of no known kind hidden with Internal, and no calendars above an agenda that did not load', () => {
  const storage = memoryStorage({ 'veyago.agenda.hiddenKinds': JSON.stringify(['personal', 'internal']) });
  const saturday = event('gym', at(19, 8), at(19, 9), { title: 'Gym', kind: 'personal' });
  const week = load({ list: [saturday], storage }).view();
  assert.equal(dayColumns(week), 7, 'the weekend is drawn for what is on it, shown or not');
  assert.match(week, /<div class="empty-calendar">1 event in a hidden calendar<\/div>/);
  const odd = event('odd', at(15, 9), at(15, 10), { title: 'Odd one', kind: 'bogus' });
  assert.doesNotMatch(load({ list: [odd], storage }).view(), /Odd one/, 'drawn as Internal, it is hidden with Internal');
  const two = [event('a', at(17, 9), at(17, 10), { kind: 'personal' }), event('b', at(17, 11), at(17, 12), { kind: 'personal' })];
  assert.match(load({ list: two, storage }).view(), /<div class="empty-calendar">2 events in hidden calendars<\/div>/);
  assert.doesNotMatch(load({ loaded: false, storage }).view(), /agenda-kinds/, 'no calendars to pick above an agenda that did not load');
});

test('what anyone typed into an event stays text, on the week, the schedule and its page', () => {
  const typed = event('x', at(15, 9), at(15, 10), { title: TYPED, detail: TYPED, location: TYPED });
  for (const mode of ['week', 'day', 'schedule']) {
    const h = load({ list: [typed], mode });
    if (mode === 'day') h.click(target('data-agenda-day', '2026-09-15'));
    assert.doesNotMatch(h.view(), /<img/i, mode);
  }
  const page = load({ list: [typed], route: ['agenda', 'x'] }).view();
  assert.doesNotMatch(page, /<img/i);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('when the events did not load the agenda says so, and a week with nothing on it says that once', () => {
  assert.match(load({ loaded: false, failed: ['the agenda'] }).view(), /The agenda did not load/);
  const empty = load().view();
  assert.match(empty, /<p class="quiet-text week-empty">Nothing on this week: room to focus\.<\/p>/);
  assert.doesNotMatch(empty, /class="empty-calendar"/, 'not a filler line in every column');
  const busy = load({ list: [event('standup', at(14, 10), at(14, 10, 30))] }).view();
  assert.doesNotMatch(busy, /week-empty|class="empty-calendar"/, 'a day with nothing on it is simply empty');
  const h = load({ mode: 'schedule' });
  assert.match(h.view(), /No events scheduled\./);
  h.click(target('data-agenda-day', '2026-09-17'));
  assert.match(h.view(), /A clear day/);
});

test('someone on the week the agenda opened on moves on with the date; someone who went elsewhere stays', () => {
  const h = load();
  h.setNow(new Date(2026, 8, 19, 10).getTime());
  h.changeDate();
  assert.deepEqual(h.shown, ['2026-09-21'], 'on Saturday the agenda opens on the week about to start');
  const away = load();
  away.click(target('data-agenda-week', 'next'));
  away.click(target('data-agenda-week', 'next'));
  away.setNow(new Date(2026, 8, 19, 10).getTime());
  away.changeDate();
  assert.deepEqual(away.shown, ['2026-09-21', '2026-09-28']);
});

/* ── An event's page ────────────────────────────────────────────────────── */

test('an event\'s page gives its date, time, kind and place, and the work it is filed under by id', () => {
  const contacts = [{ id: 'c-2', name: 'Name Twin', company: 'Other' }, { id: 'c-1', name: 'Dana Reyes', company: 'Northline' }];
  const projects = [{ id: 'p-1', uuid: 'p-1', name: 'Northline site' }];
  const kickoff = event('k', at(17, 14), at(17, 15, 30), { title: 'Kickoff', location: 'Studio', kind: 'client', contact_id: 'c-1', project_id: 'p-1' });
  const page = load({ list: [kickoff], route: ['agenda', 'k'], contacts, projects }).view();
  assert.match(page, /<h1>Kickoff<\/h1><p class="sub">Thursday, September 17, 2026<\/p>/);
  assert.match(page, /<p>14:00 – 15:30<\/p><small>Studio<\/small><\/div><span class="pill purple">Client<\/span>/);
  assert.match(page, /<a href="#crm\/c-1"><strong>Dana Reyes<\/strong><small>Northline<\/small><\/a>/);
  assert.match(page, /<a href="#projects\/p-1"><strong>Northline site<\/strong>/);
  assert.doesNotMatch(page, /Name Twin/);
  assert.match(page, /<section class="notes" data-kind="agenda" data-id="k">/);
});

test('an event\'s page lists who is invited and how each answered, as text, skipping what is not an invitee', () => {
  const attendees = [
    { name: 'Dana Reyes', email: 'dana@northline.example', response: 'accepted' },
    { name: null, email: 'ben@northline.example', response: 'declined' },
    { name: TYPED, email: 'x@northline.example', response: 'tentativelyAccepted' },
    { name: 'Sam Rivera', email: 'sam@veyago.cloud', response: 'organizer' },
    { name: 'Ana Lima', email: 'ana@veyago.cloud', response: 'none' },
    { name: 'Olivia Chen', email: 'olivia@northline.example' },
    { name: 'Proto Type', email: 'proto@northline.example', response: 'constructor' },
    { name: 'Mallory', email: TYPED, response: 'accepted' },
    { name: 'Lee@Northline.example', email: 'lee@northline.example', response: 'declined' },
    { name: '   ', email: '', response: 'accepted' },
    'dana@northline.example', null, { response: 'accepted' }
  ];
  const kickoff = event('k', at(17, 14), at(17, 15), { title: 'Kickoff', attendees });
  const page = load({ list: [kickoff], route: ['agenda', 'k'] }).view();
  assert.match(page, /<section class="panel content-panel attendee-panel"><h2>Invited<\/h2><ul class="attendee-list" role="list">/, 'a list a screen reader still announces as one, unstyled');
  assert.match(page, /<li><div><strong>Lee@Northline\.example<\/strong><\/div><span class="attendee-reply">Declined<\/span><\/li>/, 'a name that is the address is not said twice');
  assert.match(page, /<li><div><strong>Dana Reyes<\/strong><small>dana@northline\.example<\/small><\/div><span class="attendee-reply">Accepted<\/span><\/li>/);
  assert.match(page, /<li><div><strong>ben@northline\.example<\/strong><\/div><span class="attendee-reply">Declined<\/span><\/li>/, 'no name: the address is the name');
  assert.match(page, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong><small>x@northline\.example<\/small><\/div><span class="attendee-reply">Maybe<\/span>/);
  assert.match(page, /<strong>Sam Rivera<\/strong><small>sam@veyago\.cloud<\/small><\/div><span class="attendee-reply">Organiser<\/span>/);
  assert.match(page, /<strong>Ana Lima<\/strong><small>ana@veyago\.cloud<\/small><\/div><span class="attendee-reply">No reply yet<\/span>/);
  assert.match(page, /<strong>Olivia Chen<\/strong><small>olivia@northline\.example<\/small><\/div><span class="attendee-reply">No reply yet<\/span>/);
  assert.match(page, /<strong>Proto Type<\/strong><small>proto@northline\.example<\/small><\/div><span class="attendee-reply">No reply yet<\/span>/, 'an answer Outlook does not give is no answer');
  assert.match(page, /<strong>Mallory<\/strong><small>&lt;img src=x onerror=alert\(1\)&gt;<\/small>/, 'an address stays text too');
  assert.equal((page.match(/<li>/g) || []).length, 9, 'a bare string, nothing, a name of spaces, or a reply with no one behind it is not an invitee');
  assert.deepEqual(load({ list: [kickoff], route: ['agenda', 'k'] }).invitesAsked, [], 'a row that brought its invitees asks for none');
  assert.doesNotMatch(page, /<img/i);
  for (const none of [[], undefined, 'dana@northline.example']) {
    assert.doesNotMatch(load({ list: [event('q', at(17, 9), at(17, 10), { attendees: none })], route: ['agenda', 'q'] }).view(), /Invited/, `nobody invited: ${JSON.stringify(none)}`);
  }
});

test('an event from a list, which leaves out who is invited, asks for them by its id: nothing while they load, the list once they land, a word when they did not', () => {
  const kickoff = event('k', at(17, 14), at(17, 15), { title: 'Kickoff' });
  const asking = state => load({ list: [kickoff], route: ['agenda', 'k'], invitees: () => state });
  const loading = asking({ state: 'loading', attendees: [] });
  assert.doesNotMatch(loading.view(), /Invited/);
  assert.deepEqual(loading.invitesAsked, ['k']);
  const ready = asking({ state: 'ready', attendees: [{ name: 'Dana Reyes', email: 'dana@northline.example', response: 'accepted' }] }).view();
  assert.match(ready, /<strong>Dana Reyes<\/strong><small>dana@northline\.example<\/small><\/div><span class="attendee-reply">Accepted<\/span>/);
  assert.match(asking({ state: 'failed', attendees: [] }).view(),
    /<section class="panel content-panel attendee-panel"><h2>Invited<\/h2><p class="quiet-text">Who is invited did not load\. It is tried again by itself\.<\/p><\/section>/);
  assert.doesNotMatch(asking({ state: 'missing', attendees: [] }).view(), /Invited/);
  assert.doesNotMatch(asking({ state: 'loading', attendees: [{ name: 'Dana Reyes', email: 'dana@northline.example' }] }).view(), /Dana Reyes/, 'nothing is listed before it has landed');
});

test('an event\'s page says when it is only tentative, and who booked one made here — or that they have left the team', () => {
  const team = [{ id: 'e-ana', name: 'Ana Lima' }, { id: 'e-typed', name: TYPED }];
  const view = over => load({ list: [event('k', at(17, 14), at(17, 15), over)], route: ['agenda', 'k'], team }).view();
  assert.match(view({ status: 'tentative' }), /<div class="property-row"><span>Status<\/span><div>Tentative: not confirmed yet<\/div><\/div>/);
  assert.doesNotMatch(view({ status: 'confirmed' }), /<span>Status<\/span>/, 'a confirmed event needs no word on it');
  assert.match(view({ status: 'cancelled' }), /<div class="property-row"><span>Status<\/span><div>Cancelled<\/div><\/div>/, 'one cancelled, opened by its link, says so');
  assert.match(view({ connection_id: 'conn-1', created_by: 'e-ana' }), /<span>Booked by<\/span><div>Ana Lima<\/div>/, 'and one booked from here into Outlook');
  assert.doesNotMatch(load({ list: [event('g', at(17, 14), at(17, 15), { connection_id: null, created_by: 'e-gone' })], route: ['agenda', 'g'], team, parts: ['events'] }).view(),
    /Booked by/, 'until the team has loaded, no one is said to have left it');
  assert.match(view({ connection_id: null, created_by: 'e-ana' }), /<div class="property-row"><span>Booked by<\/span><div>Ana Lima<\/div><\/div>/);
  assert.match(view({ connection_id: null, created_by: 'e-gone' }), /<span>Booked by<\/span><div>Someone no longer on the team<\/div>/);
  assert.match(view({ connection_id: null, created_by: 'e-typed' }), /<span>Booked by<\/span><div>&lt;img src=x onerror=alert\(1\)&gt;<\/div>/);
  assert.doesNotMatch(view({ created_by: null }), /Booked by/, 'one made in Outlook was booked by no one here');
  const unknown = event('u', at(17, 14), at(17, 15));
  delete unknown.row.created_by;
  assert.doesNotMatch(load({ list: [unknown], route: ['agenda', 'u'], team }).view(), /Booked by/, 'no guess when the column did not load');
});

test('the company an event is filed under is linked by its id, beside its person and project', () => {
  const companies = [{ id: 'co-2', name: 'Name Twin' }, { id: 'co-1', name: 'Northline' }];
  const filed = event('k', at(17, 14), at(17, 15), { title: 'Kickoff', company_id: 'co-1' });
  const page = load({ list: [filed], route: ['agenda', 'k'], companies }).view();
  assert.match(page, /<a href="#crm\/companies\/co-1"><strong>Northline<\/strong><small>Company<\/small><\/a>/);
  assert.doesNotMatch(page, /Name Twin/);
  assert.doesNotMatch(load({ list: [filed], route: ['agenda', 'k'] }).view(), /crm\/companies/, 'a company that did not load is not linked');
});

test('a project meeting outside the weeks loaded opens its page, and an address in capitals opens the same event', () => {
  const review = event('pm-1', at(2, 10, 0, 9), at(2, 11, 0, 9), { title: 'Design review', connection_id: null });
  assert.match(load({ projectEvents: [review], route: ['agenda', 'pm-1'] }).view(), /<h1>Design review<\/h1>/);
  const kickoff = event('k', at(17, 14), at(17, 15), { title: 'Kickoff' });
  assert.match(load({ list: [kickoff], route: ['agenda', 'K'] }).view(), /<h1>Kickoff<\/h1>/);
});

test('an event that is not loaded opens nothing', () => {
  assert.match(load({ list: [event('k', at(17, 14), at(17, 15))], route: ['agenda', 'gone'] }).view(), /Record not found/);
  assert.match(load({ loaded: false, route: ['agenda', 'k'] }).view(), /This event cannot be shown yet/);
});

test('only a hand-made event can be removed, and only by whoever booked it or an owner or admin', () => {
  const mine = event('m', at(15, 9), at(15, 10), { connection_id: null, created_by: 'e-me' });
  const theirs = event('t', at(15, 9), at(15, 10), { connection_id: null, created_by: 'e-you' });
  const synced = event('s', at(15, 9), at(15, 10), { connection_id: 'conn-1', created_by: 'e-me' });
  const unknown = event('u', at(15, 9), at(15, 10));
  delete unknown.row.connection_id;
  const button = /data-agenda-delete=/;
  assert.match(load({ list: [mine], route: ['agenda', 'm'] }).view(), button);
  assert.doesNotMatch(load({ list: [theirs], route: ['agenda', 't'] }).view(), button);
  assert.match(load({ list: [theirs], route: ['agenda', 't'], manager: true }).view(), button, 'an owner or admin may');
  assert.doesNotMatch(load({ list: [synced], route: ['agenda', 's'], manager: true }).view(), button, 'a synced event is changed in its calendar');
  assert.doesNotMatch(load({ list: [unknown], route: ['agenda', 'u'], manager: true }).view(), button, 'no guess when the columns did not load');
});

test('a session with no one on the team behind it is offered neither Edit nor Remove, whatever the event says of who booked it', () => {
  const nobody = event('n', at(15, 9), at(15, 10), { connection_id: null, created_by: null });
  assert.doesNotMatch(load({ list: [nobody], route: ['agenda', 'n'], me: null }).view(), /data-agenda-(edit|delete)=/);
});

test('removing asks first, then removes the event, reloads and goes back to the agenda', async () => {
  const mine = event('m', at(15, 9), at(15, 10), { title: 'Dentist', connection_id: null, created_by: 'e-me' });
  const h = load({ list: [mine], route: ['agenda', 'm'] });
  h.click(target('data-agenda-delete', 'm'));
  assert.equal(h.modals.length, 1);
  assert.match(h.modals[0].body, /<h2>Remove Dentist\?<\/h2>/);
  assert.match(h.modals[0].body, /<form id="agenda-remove-form" method="dialog" novalidate>.*<p class="form-error" id="agenda-remove-form-error" role="alert"><\/p>/,
    'a dialog with a line to say a refusal on');
  assert.deepEqual(h.removed, [], 'nothing is removed before it is confirmed');
  await h.submit();
  assert.deepEqual(h.removed, ['m']);
  assert.deepEqual(h.navigated, ['agenda']);
  assert.deepEqual(h.toasts, ['Event removed.']);
});

test('a removal the database refuses is said once, on the dialog, which stays open to try again', async () => {
  const mine = event('m', at(15, 9), at(15, 10), { title: 'Dentist', connection_id: null, created_by: 'e-me' });
  const h = load({ list: [mine], route: ['agenda', 'm'], refuseRemove: true });
  h.click(target('data-agenda-delete', 'm'));
  await h.submit();
  assert.equal(h.error.textContent, REMOVAL_REFUSED);
  assert.deepEqual(h.toasts, [], 'not in a toast as well');
  assert.equal(h.modal.open, true);
  assert.equal(h.button.disabled, false);
  assert.deepEqual(h.navigated, []);
});

test('until the workspace is loaded again after a removal, the event\'s Remove waits: the page still shows it', async () => {
  const mine = event('m', at(15, 9), at(15, 10), { title: 'Dentist', connection_id: null, created_by: 'e-me' });
  const h = load({ list: [mine], route: ['agenda', 'm'] });
  const reloaded = h.holdReload();
  h.click(target('data-agenda-delete', 'm'));
  await h.submit();
  assert.deepEqual(h.removed, ['m']);
  assert.equal(h.modal.open, false, 'the dialog closes once the database has it');
  h.click(target('data-agenda-delete', 'M'));
  assert.equal(h.modals.length, 1, 'not asked again while the page still shows it');
  assert.deepEqual(h.toasts, [WAIT]);
  reloaded();
  await settle();
  assert.deepEqual(h.navigated, ['agenda']);
  assert.equal(h.toasts.at(-1), 'Event removed.');
});

test('an event that may not be removed is refused, even if its button is forged', () => {
  const theirs = event('t', at(15, 9), at(15, 10), { connection_id: null, created_by: 'e-you' });
  const h = load({ list: [theirs], route: ['agenda', 't'] });
  h.click(target('data-agenda-delete', 't'));
  assert.equal(h.modals.length, 0);
  assert.deepEqual(h.toasts, ['This event cannot be removed here.']);
});

test('an event made in the workspace offers Edit to whoever may remove it, and the page says who may change one', () => {
  const mine = event('m', at(15, 9), at(15, 10), { connection_id: null, created_by: 'e-me' });
  const theirs = event('t', at(15, 9), at(15, 10), { connection_id: null, created_by: 'e-you' });
  const synced = event('s', at(15, 9), at(15, 10), { connection_id: 'conn-1', created_by: 'e-me' });
  assert.match(load({ list: [mine], route: ['agenda', 'm'] }).view(),
    /<button type="button" class="btn" data-agenda-edit="m">Edit event<\/button><button type="button" class="btn" data-agenda-delete="m">Remove event<\/button>/);
  assert.doesNotMatch(load({ list: [theirs], route: ['agenda', 't'] }).view(), /data-agenda-edit=/);
  assert.match(load({ list: [theirs], route: ['agenda', 't'], manager: true }).view(), /data-agenda-edit="t"/, 'an owner or admin may');
  assert.doesNotMatch(load({ list: [synced], route: ['agenda', 's'], manager: true }).view(), /data-agenda-edit=/, 'a synced event is changed in its calendar');
  const h = load({ list: [mine, theirs] });
  assert.equal(h.canChange(mine), true);
  assert.equal(h.canChange(theirs), false);
});

test('an event comes back with the weeks, and a project meeting with the project meetings too', () => {
  const h = load();
  assert.deepEqual(h.partsOf(event('a', at(15, 9), at(15, 10))), ['events']);
  assert.deepEqual(h.partsOf(event('p', at(15, 9), at(15, 10), { project_id: 'p-1' })), ['events', 'projectEvents'],
    'out of the weeks, its page finds it among the project meetings');
});
