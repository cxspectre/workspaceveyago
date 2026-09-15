/* Adding and changing an event made in the workspace, as event-edit.js does
   it: New event's own dialog — the day it starts on, each field saved where it
   belongs, invitees as addresses, a project that makes it client work — and
   an edit: what it may change and how it is checked (0026: a title, and an end
   not before the start), a time left as the dialog filled it in neither sent
   nor checked, the change made against the event as it was when the dialog
   opened, only what was changed sent, its fields shut while it goes, a refusal
   said once on the dialog, the keyboard put back, and the event's Edit waiting
   until every part of the store it comes back in has been loaded again. Who
   may change one, those parts and the days New event offers are agenda-ui.js's
   (tested in tests/agenda-ui.test.mjs), stand-ins here. On the clock of
   Amsterdam, where local time and UTC differ and the clocks change.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'Europe/Amsterdam';

const TYPED = '<img src=x onerror=alert(1)>';
const WAIT = 'The last change to that event is still on its way. Try again in a moment.';
const REFUSAL = 'The event was not changed: it was changed or removed since this was opened, or only whoever booked it, or an owner or admin, can change it. Close this and open the event again.';
const EDIT_BUTTON = '#main [data-agenda-edit="ev-1"]';
const NEW_BUTTON = '#main [data-create="agenda"]';
const HEADING = '#main h1';
/* Tuesday, September 15, 2026, 09:10, on the page's clock. */
const NOW = new Date(2026, 8, 15, 9, 10).getTime();
const BOOKING_WAIT = 'The last new event is still being booked. Try again in a moment.';
const PASSED = 'That time has passed, so nobody can be invited to it: pick a later time, or empty Invite to put it on record.';
/* projects-model.js as the page has it, for the time a project's meeting suggests. */
const projectsContext = vm.createContext({ console });
projectsContext.window = projectsContext;
const PROJECTS_MODEL = vm.runInContext(`${readFileSync(new URL('../dist/projects-model.js', import.meta.url), 'utf8')}\nprojectsModel;`, projectsContext);
/* When the event last changed, as the database stamps it (0026's trigger). */
const STAMP = '2026-09-15T08:00:00.123456+00:00';
const FIELDS = ['title', 'allDay', 'startsAt', 'endsAt', 'startDay', 'endDay', 'location', 'detail', 'attendees', 'projectId', 'link'];
/* The days New event offers (agenda-ui.js dayOptions), Wednesday picked. */
const DAYS = [
  { key: '2026-09-14', label: 'Monday, September 14', selected: false },
  { key: '2026-09-16', label: 'Wednesday, September 16', selected: true }
];

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unescape = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const at = (day, hour = 0, minute = 0, month = 8) => new Date(2026, month, day, hour, minute).toISOString();

/* An event as queries.events() hands it to the store: made in the workspace by e-me. */
function event(over = {}) {
  const row = {
    id: 'ev-1', title: 'Dentist', detail: 'Bring the forms', location: 'Keizersgracht 1', starts_at: at(18, 9), ends_at: at(18, 10),
    all_day: false, kind: 'internal', status: 'confirmed', project_id: null, company_id: null, contact_id: null,
    connection_id: null, created_by: 'e-me', updated_at: STAMP, ...over
  };
  return { id: row.id, title: row.title, row };
}

/* A project as projectsModel.shapeProject hands it to the page. */
const project = (uuid, name, status = 'In progress') => ({ id: uuid, uuid, name, status });

/* An element a click lands on, with one data attribute. */
function target(attribute, value) {
  const key = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const node = { dataset: { [key]: value } };
  return { closest: selector => (selector === `[${attribute}]` ? node : null) };
}

/* The dialog form showModal() puts on the page, its fields holding what the
   markup filled them in with, as a browser's would. */
function dialog(id, body) {
  const handlers = {};
  const fields = {};
  const initial = name => {
    const input = body.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
    if (input) return unescape((input[0].match(/value="([^"]*)"/) || [])[1] || '');
    const area = body.match(new RegExp(`<textarea[^>]*name="${name}"[^>]*>([\\s\\S]*?)</textarea>`));
    if (area) return unescape(area[1]);
    const select = body.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
    if (select) return unescape((select[1].match(/<option value="([^"]*)" selected>/) || select[1].match(/<option value="([^"]*)"/) || [])[1] || '');
    return null;
  };
  const inputOf = name => (body.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`)) || [])[0] || '';
  const typeOf = name => (inputOf(name).match(/type="([^"]+)"/) || [])[1] || null;
  const checkedAt = name => /\schecked[\s>]/.test(inputOf(name));
  /* The groups of fields a dialog shows or puts away, by their data attribute. */
  const groups = {};
  const form = {
    id, isConnected: true, handlers, focused: [],
    button: { disabled: false, dataset: {}, attributes: {}, focused: 0, focus() { this.focused += 1; }, removeAttribute(name) { delete this.attributes[name]; } },
    error: { textContent: '', id: `${id}-error` },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    has: name => initial(name) !== null,
    group: attribute => (groups[attribute] = groups[attribute] || { hidden: body.includes(`${attribute} hidden`) }),
    field: name => (fields[name] = fields[name] || {
      name, value: initial(name), type: typeOf(name), checked: checkedAt(name), readOnly: false, attributes: {}, listeners: {},
      focus() { form.focused.push(name); },
      setAttribute(key, value) { this.attributes[key] = value; },
      removeAttribute(key) { delete this.attributes[key]; },
      addEventListener(type, fn) { this.listeners[type] = fn; }
    }),
    querySelector: selector => {
      if (selector === '[type="submit"]') return form.button;
      if (selector === '.form-error') return form.error;
      if (selector === '.form-candidates') return null;
      const group = /^\[(data-[a-z-]+)\]$/.exec(selector);
      if (group) return body.includes(group[1]) ? form.group(group[1]) : null;
      const named = /^\[name="([^"]+)"\]$/.exec(selector);
      return named && form.has(named[1]) ? form.field(named[1]) : null;
    },
    querySelectorAll: () => FIELDS.filter(name => form.has(name)).map(name => form.field(name))
  };
  return form;
}

/* list: the events the store has. refuse: the database changes nothing.
   page: what the page has once it is drawn again, by the selector that finds
   it. misses: the parts the load after a write does not bring back. on: the
   page the workspace is on. booked: what booking a new event answers, or an
   error it is refused with. */
function load({ list = [event()], me = 'e-me', manager = false, loaded = true, refuse = false, page = [EDIT_BUTTON, HEADING], active = null, misses = [],
  on = 'overview', projects = [], booked = { calendar: 'studio@veyago.cloud' }, now = NOW, days = DAYS, agenda = true, hiddenCalendars = {},
  companies = [], contacts = [] } = {}) {
  const listeners = {};
  const toasts = [];
  const modals = [];
  const updates = [];
  const created = [];
  const earlier = [];
  const dayCalls = [];
  const pageFocus = [];
  const BODY = {};
  const elements = Object.fromEntries(page.map(selector => [selector, {
    attributes: {}, setAttribute(key, value) { this.attributes[key] = String(value); }, focus: () => pageFocus.push(selector)
  }]));
  let form = null;
  const holds = { write: null, reload: null, book: null };
  /* The loads begun so far, and the one each part last arrived from (store.js mark and loadedSince). */
  const loads = { begun: 0, arrived: {} };
  const begin = parts => {
    loads.begun += 1;
    parts.forEach(part => { loads.arrived[part] = loads.begun; });
  };
  const context = vm.createContext({
    console,
    esc: escape,
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); form = dialog((body.match(/<form id="([^"]+)"/) || [])[1], body); context.modal.open = true; },
    modal: { open: false, close() { this.open = false; } },
    page: on,
    projects,
    contacts,
    projectsModel: { isActive: p => p.status !== 'Completed', suggestedStart: PROJECTS_MODEL.suggestedStart },
    /* app.js's form, for everything else it makes. */
    createForm: kind => earlier.push(kind),
    workspaceSession: { employee: me ? { id: me } : null, isManager: () => manager },
    /* As agenda-ui.js decides them: who may change an event made here, the parts it comes back in, and the days New event offers. */
    agendaUi: {
      canChange: e => e.row.connection_id === null && (manager || e.row.created_by === me),
      partsOf: e => (e.row.project_id ? ['events', 'projectEvents'] : ['events']),
      hiddenCalendar: kind => (Object.prototype.hasOwnProperty.call(hiddenCalendars, kind) ? hiddenCalendars[kind] : null),
      ...(agenda ? { dayOptions: options => { dayCalls.push({ ...options }); return days; } } : {})
    },
    workspaceStore: {
      state: { loaded, companies },
      eventById: id => list.find(e => String(e.id).toLowerCase() === String(id).toLowerCase()) || null,
      /* As store.js's after() does: once the write is in, the workspace is
         loaded again, each part it brings back arriving from that load; a
         refusal is said in a toast unless the caller says it itself
         ({ toast: false }), and passed on. */
      after: (work, options) => Promise.resolve(work).then(
        value => (holds.reload ? holds.reload.promise : Promise.resolve()).then(() => {
          begin(['events', 'projectEvents'].filter(part => !misses.includes(part)));
          return value;
        }),
        err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; }),
      mark: () => loads.begun,
      loadedSince: (part, mark) => loads.arrived[part] !== undefined && loads.arrived[part] > mark
    },
    workspaceActions: {
      updateEvent: async (id, changes, since) => {
        updates.push([id, { ...changes }, since]);
        if (holds.write) await holds.write.promise;
        if (refuse) throw Object.assign(new Error(REFUSAL), { refused: true });
        return { id, ...changes };
      },
      createEvent: async fields => {
        created.push({ ...fields, attendees: [...fields.attendees] });
        if (holds.book) await holds.book.promise;
        if (booked instanceof Error) throw booked;
        return booked;
      }
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => (form && form.id === id ? form : null),
      body: BODY,
      activeElement: active || BODY,
      querySelector: selector => elements[selector] || null
    },
    /* As a browser's: a checkbox is 'on' when ticked and left out when not. */
    FormData: class {
      constructor(f) { this.f = f; }
      value(name) { const field = this.f.field(name); return field.type === 'checkbox' ? (field.checked ? 'on' : null) : field.value; }
      get(name) { return this.f.has(name) ? this.value(name) : null; }
      entries() { return FIELDS.filter(n => this.f.has(n) && this.value(n) !== null).map(n => [n, this.value(n)]); }
    }
  });
  context.window = context;
  vm.runInContext(`const RealDate = Date; var __now = ${now};
    Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [__now])); } static now() { return __now; } };`, context);
  for (const file of ['dialog-forms.js', 'event-edit.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  const hold = which => {
    let release;
    holds[which] = { promise: new Promise(resolve => { release = resolve; }) };
    return () => { holds[which] = null; release(); };
  };
  return {
    model: vm.runInContext('eventEdit', context),
    click: node => (listeners.click || []).forEach(fn => fn({ target: node, preventDefault() {} })),
    create: kind => context.createForm(kind),
    form: () => form,
    fill: values => Object.entries(values).forEach(([name, value]) => { form.field(name).value = value; }),
    change: name => { const field = form.field(name); if (field.listeners.change) field.listeners.change({ target: field }); },
    check: (name, on) => { const field = form.field(name); field.checked = on; if (field.listeners.change) field.listeners.change({ target: field }); },
    submit: async () => { form.handlers.submit({ preventDefault() {} }); await settle(); },
    send: () => form.handlers.submit({ preventDefault() {} }),
    holdWrite: () => hold('write'),
    holdReload: () => hold('reload'),
    holdBooking: () => hold('book'),
    /* A later load brings a part back. */
    arrive: part => begin([part]),
    element: selector => elements[selector],
    toasts, modals, updates, created, earlier, dayCalls, pageFocus, modal: context.modal
  };
}

const SAME = { title: 'Dentist', startsAt: '2026-09-18T09:00', endsAt: '2026-09-18T10:00', location: 'Keizersgracht 1', detail: 'Bring the forms' };

/* ── New event ──────────────────────────────────────────────────────────── */

test('New event opens its own dialog, on the day the agenda offers first, at ten for half an hour; everything else is app.js\'s', () => {
  const h = load();
  h.create('agenda');
  assert.equal(h.modals.length, 1);
  const body = h.modals[0].body;
  assert.match(body, /<h2>New event<\/h2>/);
  assert.match(body, /<form id="event-new-form" method="dialog" novalidate>/);
  assert.match(body, /<input name="title" required maxlength="200" autofocus>/);
  assert.match(body, /<input type="datetime-local" name="startsAt" required value="2026-09-16T10:00">/);
  assert.match(body, /<input type="datetime-local" name="endsAt" value="2026-09-16T10:30">/);
  assert.match(body, /<input name="location">/);
  assert.match(body, /<textarea name="detail"><\/textarea>/);
  assert.match(body, /<input name="attendees" type="text" inputmode="email" autocomplete="off" placeholder="name@company\.com, …">/);
  assert.match(body, /data-label="Add event">Add event<\/button>/);
  assert.doesNotMatch(body, /name="projectId"/, 'no projects to file it under, no choice of one');
  assert.deepEqual(h.dayCalls, [{ onAgenda: false }], 'from the Overview, this week — not the week the agenda was left on');
  const onAgenda = load({ on: 'agenda' });
  onAgenda.create('agenda');
  assert.deepEqual(onAgenda.dayCalls, [{ onAgenda: true }], 'on the Agenda, the week on screen');
  h.create('tickets');
  assert.deepEqual(h.earlier, ['tickets']);
  assert.equal(h.modals.length, 1);
});

test('on today, New event opens at the next whole hour of the working day — after it, at ten the next morning — never on a time gone', () => {
  const TODAY = [{ key: '2026-09-15', label: 'Tuesday, September 15', selected: true }, { key: '2026-09-16', label: 'Wednesday, September 16', selected: false }];
  const opened = setup => { const h = load(setup); h.create('agenda'); const body = h.modals[0].body; return [/name="startsAt" required value="([^"]*)"/.exec(body)[1], /name="endsAt" value="([^"]*)"/.exec(body)[1]]; };
  assert.deepEqual(opened({ days: TODAY, now: new Date(2026, 8, 15, 14, 20).getTime() }), ['2026-09-15T15:00', '2026-09-15T15:30']);
  assert.deepEqual(opened({ days: TODAY, now: new Date(2026, 8, 15, 18, 5).getTime() }), ['2026-09-16T10:00', '2026-09-16T10:30']);
  assert.deepEqual(opened({ agenda: false, now: new Date(2026, 8, 15, 14, 20).getTime() }), ['2026-09-15T15:00', '2026-09-15T15:30'], 'with no agenda to ask, today');
  const unchosen = [{ key: '2026-09-21', label: 'Monday, September 21', selected: false }, { key: '2026-09-22', label: 'Tuesday, September 22', selected: false }];
  assert.deepEqual(opened({ days: unchosen }), ['2026-09-21T10:00', '2026-09-21T10:30'], 'no day chosen: the first one offered');
});

test('nobody is invited to a time that has passed; with nobody invited, it is put on record', () => {
  const { newEvent } = load().model;
  const at = new Date(2026, 8, 15, 9, 10);
  const check = values => { const checked = newEvent({ title: 'Standup', ...values }, [], at); return [checked.ok, checked.field, checked.problem]; };
  const invite = { attendees: 'ana@northline.example' };
  assert.deepEqual(check({ startsAt: '2026-09-15T08:00', endsAt: '2026-09-15T09:00', ...invite }), [false, 'startsAt', PASSED]);
  assert.deepEqual(check({ startsAt: '2026-09-15T08:00', endsAt: '2026-09-15T09:00' }), [true, undefined, undefined], 'put on record');
  assert.equal(check({ startsAt: '2026-09-15T09:00', endsAt: '2026-09-15T10:00', ...invite })[0], true, 'one under way may still invite');
  assert.deepEqual(check({ startsAt: '2026-09-15T08:30', ...invite }), [false, 'startsAt', PASSED], 'with no end, over half an hour after it starts');
  assert.equal(check({ startsAt: '2026-09-15T08:50', ...invite })[0], true);
  assert.equal(newEvent({ title: 'Standup', startsAt: '2026-09-15T08:00', endsAt: '2026-09-15T09:00', ...invite }, []).ok, false, 'on the page\'s clock when no time is given');
  assert.equal(newEvent({ title: 'Standup', startsAt: '2026-09-15T08:00', endsAt: '2026-09-15T09:00', ...invite }, [], new Date(2026, 8, 15, 7, 0)).ok, true,
    'judged at the time it is sent');
});

test('a new event is booked with what was typed in each field — its place, its details and who is invited — and the keyboard goes back to New event', async () => {
  const h = load({ page: [NEW_BUTTON, HEADING] });
  h.create('agenda');
  h.fill({ title: '  Kickoff  ', startsAt: '2026-09-17T14:00', endsAt: '2026-09-17T15:30', location: ' Studio ', detail: 'Bring the moodboard',
    attendees: 'Ana@Northline.example, ben@northline.example; ana@northline.example' });
  await h.submit();
  assert.deepEqual(h.created, [{
    title: 'Kickoff', startsAt: '2026-09-17T12:00:00.000Z', endsAt: '2026-09-17T13:30:00.000Z', location: 'Studio', detail: 'Bring the moodboard',
    allDay: false, attendees: ['ana@northline.example', 'ben@northline.example'], projectId: null, companyId: null, contactId: null, kind: 'internal'
  }], 'the place and the details each where they belong, and each address once');
  assert.deepEqual(h.toasts, ['Added to studio@veyago.cloud.']);
  assert.equal(h.modal.open, false);
  assert.deepEqual(h.pageFocus, [NEW_BUTTON]);
});

test('an all-day event is booked by its days: from the midnight it starts to the midnight after the day it ends, as Outlook keeps one', async () => {
  const h = load();
  h.create('agenda');
  const body = h.modals[0].body;
  assert.match(body, /<label class="check-row"><input type="checkbox" name="allDay"> All day<\/label>/);
  assert.match(body, /<div class="form-pair" data-timed>/);
  assert.match(body, /<div class="form-pair" data-all-day hidden>[\s\S]*?<input type="date" name="startDay" required value="2026-09-16">[\s\S]*?<input type="date" name="endDay" value="">/);
  h.check('allDay', true);
  assert.equal(h.form().group('data-all-day').hidden, false);
  assert.equal(h.form().group('data-timed').hidden, true, 'the times are put away');
  h.fill({ title: 'Offsite', startDay: '2026-09-17', endDay: '2026-09-18' });
  await h.submit();
  assert.deepEqual(h.created.map(e => [e.allDay, e.startsAt, e.endsAt]), [[true, '2026-09-17T00:00:00.000Z', '2026-09-19T00:00:00.000Z']]);

  const { newEvent } = h.model;
  const at = new Date(2026, 8, 15, 9, 10);
  const day = values => { const c = newEvent({ title: 'Offsite', allDay: 'on', ...values }, [], at); return c.ok ? [c.event.startsAt, c.event.endsAt, c.event.allDay] : [c.field, c.problem]; };
  assert.deepEqual(day({ startDay: '2026-09-17' }), ['2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z', true], 'one day, when no end is given');
  assert.deepEqual(day({ allDay: true, startDay: '2026-09-17' }), ['2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z', true], 'ticked as true, too');
  assert.deepEqual(day({ startDay: '' }), ['startDay', 'Pick the day it is on.']);
  assert.deepEqual(day({ startDay: '2026-02-30' }), ['startDay', 'Pick the day it is on.'], 'a day that does not exist');
  assert.deepEqual(day({ startDay: '0026-09-17' }), ['startDay', 'Pick the day it is on.'], 'a year typed as 26');
  assert.deepEqual(day({ startDay: '1026-09-17' }), ['startDay', 'Pick the day it is on.'], 'a year long past, as a slipped key makes it');
  assert.deepEqual(day({ startDay: '2026-09-17', endDay: 'soon' }), ['endDay', 'Pick the day it ends, or leave it empty.']);
  assert.deepEqual(day({ startDay: '2026-09-17', endDay: '2026-09-16' }), ['endDay', 'It has to end on or after the day it starts.']);
  assert.deepEqual(day({ startDay: '2026-12-31', endDay: '2026-12-31' }), ['2026-12-31T00:00:00.000Z', '2027-01-01T00:00:00.000Z', true], 'into the next year');
  assert.deepEqual(day({ startDay: '2026-03-29', startsAt: 'nonsense', endsAt: '2026-03-28T10:00' }), ['2026-03-29T00:00:00.000Z', '2026-03-30T00:00:00.000Z', true],
    'the times put away are not read, and the day the clocks change is a day');
  const gone = newEvent({ title: 'Offsite', allDay: 'on', startDay: '2026-09-14', attendees: 'ana@northline.example' }, [], at);
  assert.deepEqual([gone.ok, gone.field, gone.problem], [false, 'startDay', PASSED], 'nobody is invited to days gone');
  assert.equal(newEvent({ title: 'Offsite', allDay: 'on', startDay: '2026-09-15', attendees: 'ana@northline.example' }, [], at).ok, true, 'today is not gone yet');
  const lateNight = newEvent({ title: 'Offsite', allDay: 'on', startDay: '2026-09-15', attendees: 'ana@northline.example' }, [], new Date(2026, 8, 16, 1, 30));
  assert.deepEqual([lateNight.ok, lateNight.field], [false, 'startDay'], 'at half past one on the 16th the 15th is gone here, though in UTC it is still the 15th');
  assert.equal(newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', startDay: 'nonsense' }, []).event.allDay, false, 'not ticked, the days are not read');
});

test('All day takes its days from the times, and gives them back on the days picked', () => {
  const h = load();
  h.create('agenda');
  h.fill({ startsAt: '2026-09-18T14:00' });
  h.change('startsAt');
  assert.equal(h.form().field('endsAt').value, '2026-09-18T14:30');
  h.check('allDay', true);
  assert.equal(h.form().field('startDay').value, '2026-09-18');
  assert.equal(h.form().field('endDay').value, '', 'one day');
  h.fill({ startDay: '2026-09-20' });
  h.check('allDay', false);
  assert.equal(h.form().group('data-timed').hidden, false);
  assert.equal(h.form().group('data-all-day').hidden, true);
  assert.equal(h.form().field('startsAt').value, '2026-09-20T14:00', 'at the time it had, on the day picked');
  assert.equal(h.form().field('endsAt').value, '2026-09-20T14:30', 'for as long as it was');
  h.fill({ startsAt: '2026-09-20T09:00' });
  h.change('startsAt');
  assert.equal(h.form().field('endsAt').value, '2026-09-20T09:30', 'and the end still follows the start');
  h.fill({ endsAt: '2026-09-22T17:00' });
  h.check('allDay', true);
  assert.deepEqual([h.form().field('startDay').value, h.form().field('endDay').value], ['2026-09-20', '2026-09-22'], 'over several days, until the last');
});

test('All day reads an end at midnight as the day before, keeps the days picked when ticked again, and leaves a start it cannot read alone', () => {
  const late = load();
  late.create('agenda');
  late.fill({ startsAt: '2026-09-17T22:00', endsAt: '2026-09-18T00:00' });
  late.check('allDay', true);
  assert.deepEqual([late.form().field('startDay').value, late.form().field('endDay').value], ['2026-09-17', ''], 'until midnight is that one day');

  const again = load();
  again.create('agenda');
  again.check('allDay', true);
  again.fill({ startDay: '2026-09-20', endDay: '2026-09-22' });
  again.check('allDay', false);
  again.check('allDay', true);
  assert.deepEqual([again.form().field('startDay').value, again.form().field('endDay').value], ['2026-09-20', '2026-09-22'], 'the days picked stay');

  const blank = load();
  blank.create('agenda');
  blank.fill({ startsAt: '' });
  blank.check('allDay', true);
  assert.deepEqual([blank.form().field('startDay').value, blank.form().field('endDay').value], ['2026-09-16', ''], 'no time to take a day from: the day offered stays');
  blank.fill({ startDay: '2026-09-20' });
  blank.check('allDay', false);
  assert.equal(blank.form().field('startsAt').value, '', 'nor is a time made up for it');
});

test('an event for a client or a person is filed under them as client work; they are offered in groups, as text, and one not offered is refused', async () => {
  const companies = [{ id: 'co-1', name: 'Northline' }, { id: 'co-2', name: TYPED }];
  const contacts = [{ id: 'c-1', name: 'Dana Reyes', company: 'Northline' }, { id: 'c-2', name: 'Lee Park', company: '—' },
    { id: 'c-3', name: 'Dana Reyes', company: 'Harbor', email: 'dana@harbor.example', row: { company: { id: 'co-2' } } },
    { name: 'Demo person', company: 'Demo' }];
  const h = load({ companies, contacts });
  h.create('agenda');
  const body = h.modals[0].body;
  assert.match(body, /<select name="link"><option value="">No one<\/option><optgroup label="Companies"><option value="company:co-1">Northline<\/option><option value="company:co-2">&lt;img src=x onerror=alert\(1\)&gt;<\/option><\/optgroup><optgroup label="People"><option value="contact:c-1">Dana Reyes · Northline<\/option><option value="contact:c-2">Lee Park<\/option><option value="contact:c-3">Dana Reyes · Harbor · dana@harbor\.example<\/option><\/optgroup><\/select>/,
    'two of the same name are told apart by their company and address');
  assert.doesNotMatch(body, /Demo person/, 'someone without an id is not offered');
  assert.doesNotMatch(body, /<img/i);
  assert.doesNotMatch((() => { const only = load({ companies }); only.create('agenda'); return only.modals[0].body; })(), /<optgroup label="People">/, 'no people, no empty group');
  assert.doesNotMatch((() => { const only = load({ contacts }); only.create('agenda'); return only.modals[0].body; })(), /<optgroup label="Companies">/, 'no companies, no empty group');
  assert.match(body, /<p class="form-note">An event for a project, a client or a person goes in the studio calendar/);
  h.fill({ title: 'Check-in', link: 'contact:c-1' });
  await h.submit();
  assert.deepEqual([h.created[0].contactId, h.created[0].companyId, h.created[0].kind], ['c-1', null, 'client']);

  const { newEvent } = h.model;
  const linked = link => newEvent({ title: 'Check-in', startsAt: '2026-09-17T14:00', link }, [], undefined, { companies, contacts });
  assert.deepEqual([linked('company:co-1').event.companyId, linked('company:co-1').event.contactId, linked('company:co-1').event.kind], ['co-1', null, 'client']);
  assert.deepEqual([linked('company:co-9').field, linked('company:co-9').problem], ['link', 'Pick a client or person from the list.']);
  assert.equal(linked('contact:co-1').field, 'link', 'a company\'s id is not a person\'s');
  assert.equal(linked('bogus').field, 'link');
  assert.equal(newEvent({ title: 'Check-in', startsAt: '2026-09-17T14:00', link: 'company:co-1' }, []).field, 'link', 'nothing offered, nothing to pick');
  const both = newEvent({ title: 'Review', startsAt: '2026-09-17T14:00', projectId: 'p1', link: 'company:co-1' }, [{ uuid: 'p1', name: 'Site', companyId: 'co-2' }], undefined, { companies, contacts }).event;
  assert.deepEqual([both.projectId, both.companyId], ['p1', 'co-1'], 'the client picked, over the project\'s');
  const person = newEvent({ title: 'Review', startsAt: '2026-09-17T14:00', projectId: 'p1', link: 'contact:c-2' }, [{ uuid: 'p1', name: 'Site', companyId: 'co-2' }], undefined, { companies, contacts }).event;
  assert.deepEqual([person.companyId, person.contactId, person.kind], ['co-2', 'c-2', 'client'], 'a person with no company keeps the project\'s client');
  const theirs = newEvent({ title: 'Review', startsAt: '2026-09-17T14:00', projectId: 'p1', link: 'contact:c-3' }, [{ uuid: 'p1', name: 'Site', companyId: 'co-9' }], undefined, { companies, contacts }).event;
  assert.deepEqual([theirs.companyId, theirs.contactId], ['co-2', 'c-3'], 'a person is filed with their own company, over the project\'s, so its page lists the event');

  const nobody = load();
  nobody.create('agenda');
  assert.doesNotMatch(nobody.modals[0].body, /name="link"|form-note/, 'nobody in the CRM and no projects: no choice, and no note');
});

test('a problem is said on its field, and the next send starts from a clean dialog: an end before the start no longer locks the form', async () => {
  const h = load();
  h.create('agenda');
  h.fill({ title: 'Kickoff', startsAt: '2026-09-17T14:00', endsAt: '2026-09-17T13:00' });
  await h.submit();
  assert.deepEqual(h.created, []);
  assert.equal(h.form().error.textContent, 'It has to end after it starts.');
  assert.equal(h.form().field('endsAt').attributes['aria-invalid'], 'true');
  h.fill({ endsAt: '2026-09-17T15:00' });
  await h.submit();
  assert.equal(h.form().error.textContent, '');
  assert.equal(h.created.length, 1, 'sent, once the end is after the start');
  const { newEvent } = h.model;
  const problem = values => { const checked = newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', endsAt: '', ...values }, []); return [checked.ok, checked.field, checked.problem]; };
  assert.deepEqual(problem({ title: ' ' }), [false, 'title', 'Give the event a title.']);
  assert.deepEqual(problem({ title: 'x'.repeat(201) }), [false, 'title', 'A title is at most 200 characters.']);
  assert.deepEqual(problem({ startsAt: '' }), [false, 'startsAt', 'Pick the day and time it starts.']);
  assert.deepEqual(problem({ startsAt: '2026-03-29T02:30' }), [false, 'startsAt', 'Pick the day and time it starts.'], 'a time the clocks skip');
  assert.deepEqual(problem({ endsAt: 'soon' }), [false, 'endsAt', 'Pick the day and time it ends, or leave it empty.']);
  assert.deepEqual(problem({ endsAt: '2026-09-17T14:00' }), [false, 'endsAt', 'It has to end after it starts.'], 'nor may it end as it starts');
  const open = newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', endsAt: '' }, []);
  assert.equal(open.ok, true);
  assert.equal(open.event.endsAt, null, 'an end left empty is left to the calendar: half an hour');
});

test('someone invited is an address; a word that is not one is refused on the invite field, as text', async () => {
  const { newEvent } = load().model;
  const checked = newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', attendees: 'ana@northline.example ben' }, []);
  assert.deepEqual([checked.ok, checked.field, checked.problem], [false, 'attendees', '“ben” is not an email address.']);
  assert.equal(newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', attendees: 'ana@northline' }, []).field, 'attendees', 'an address needs a domain');
  assert.deepEqual([...newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', attendees: ' ' }, []).event.attendees], [], 'nobody is fine');
  const copied = newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', attendees: 'Ana Silva <Ana@Northline.example>; ben@northline.example\nana@northline.example' }, []);
  assert.deepEqual([...copied.event.attendees], ['ana@northline.example', 'ben@northline.example'], 'as Outlook copies them: a name and the address');
  assert.equal(newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', attendees: 'x'.repeat(100) }, []).problem, `“${'x'.repeat(60)}…” is not an email address.`,
    'a long word is repeated only in part');
  const list = attendees => { const checked = newEvent({ title: 'Kickoff', startsAt: '2026-09-17T14:00', attendees }, []); return checked.ok ? [...checked.event.attendees] : checked.problem; };
  assert.deepEqual(list('Ana <ana@x.example> Ben <ben@x.example>'), ['ana@x.example', 'ben@x.example'], 'named invitees separated by a space: neither is passed over');
  assert.deepEqual(list('Ana <ana@x.example>\tBen <ben@x.example>'), ['ana@x.example', 'ben@x.example'], 'or by a tab, as a spreadsheet pastes them');
  assert.deepEqual(list('ana@x.example <ben@x.example>'), ['ana@x.example', 'ben@x.example'], 'an address before a named one');
  assert.deepEqual(list('Drefke, Cassian <cassian@veyago.cloud>; "Silva, Ana" <ana@x.example>'), ['cassian@veyago.cloud', 'ana@x.example'], 'Outlook\'s "Last, First" names, quoted or not');
  assert.equal(list('Ana Silva, ben@x.example'), '“Ana” is not an email address.', 'a name with no address is refused, not dropped');
  assert.equal(list('<ana@x.example'), '“<ana@x.example” is not an email address.');
  const WORD = '<img/src=x/onerror=alert(1)>';
  const h = load();
  h.create('agenda');
  h.fill({ title: 'Kickoff', attendees: WORD });
  await h.submit();
  assert.equal(h.form().error.textContent, `“${WORD}” is not an email address.`, 'said as text: the error line is set with textContent');
  assert.equal(h.form().field('attendees').attributes['aria-invalid'], 'true');
});

test('an event on a project is client work, filed under the project; only active projects are offered, and one not offered is refused', async () => {
  const projects = [{ ...project('p1', 'Northline site'), companyId: 'c1' }, project('p2', 'Harbor app', 'Completed'), project('p3', TYPED), { id: 7, name: 'Legacy list', status: 'In progress' }];
  const h = load({ projects });
  h.create('agenda');
  const body = h.modals[0].body;
  assert.match(body, /<select name="projectId"><option value="">No project<\/option><option value="p1">Northline site<\/option><option value="p3">&lt;img src=x onerror=alert\(1\)&gt;<\/option><\/select>/);
  assert.doesNotMatch(body, /Harbor app/, 'a completed project is not offered');
  assert.doesNotMatch(body, /<img/i);
  assert.doesNotMatch(body, /Legacy list/, 'one with no address to book against is not offered');
  assert.match(body, /<p class="form-note">An event for a project, a client or a person goes in the studio calendar, where the team sees it\. Any other goes in your own calendar, or the studio’s when you have none connected\.<\/p>/);
  h.fill({ title: 'Design review', startsAt: '2026-09-17T14:00', projectId: 'p1' });
  h.change('startsAt');
  await h.submit();
  assert.equal(h.created[0].projectId, 'p1');
  assert.equal(h.created[0].companyId, 'c1');
  assert.equal(h.created[0].kind, 'client');
  const { newEvent } = h.model;
  const ours = newEvent({ title: 'Design review', startsAt: '2026-09-17T14:00', projectId: 'p3' }, projects).event;
  assert.deepEqual([ours.projectId, ours.companyId, ours.kind], ['p3', null, 'internal'], 'a project of the studio\'s own is filed under it, and stays internal, as its own meetings are');
  const forged = newEvent({ title: 'Design review', startsAt: '2026-09-17T14:00', projectId: 'p2' }, [projects[0], projects[2]]);
  assert.deepEqual([forged.ok, forged.field, forged.problem], [false, 'projectId', 'Pick a project from the list.']);
});

test('a booking refused is said once, on the dialog, which stays open; one saved in the workspace alone says why', async () => {
  const refused = load({ booked: new Error('Your calendar needs reconnecting before events can be booked into it.') });
  refused.create('agenda');
  refused.fill({ title: 'Physio' });
  await refused.submit();
  assert.equal(refused.form().error.textContent, 'Your calendar needs reconnecting before events can be booked into it.');
  assert.deepEqual(refused.toasts, []);
  assert.equal(refused.modal.open, true);
  assert.equal(refused.form().button.disabled, false);
  const why = 'The studio calendar needs reconnecting, so this is saved in the workspace only.';
  const waiting = load({ booked: { why } });
  waiting.create('agenda');
  waiting.fill({ title: 'Design review' });
  await waiting.submit();
  assert.deepEqual(waiting.toasts, [why]);
  const waitingInvited = load({ booked: { why } });
  waitingInvited.create('agenda');
  waitingInvited.fill({ title: 'Design review', attendees: 'ana@northline.example' });
  await waitingInvited.submit();
  assert.deepEqual(waitingInvited.toasts, [`${why} No invitations went out: they are sent from a connected calendar.`], 'why, and that nobody was invited');
  const alone = load({ booked: { id: 'ev-9', why: null } });
  alone.create('agenda');
  alone.fill({ title: 'Physio' });
  await alone.submit();
  assert.deepEqual(alone.toasts, ['Saved in the workspace: no calendar is connected yet.']);
  const hiddenAway = load({ hiddenCalendars: { internal: 'Internal' } });
  hiddenAway.create('agenda');
  hiddenAway.fill({ title: 'Physio' });
  await hiddenAway.submit();
  assert.deepEqual(hiddenAway.toasts, ['Added to studio@veyago.cloud. It is in Internal, which the agenda is hiding.'],
    'booked into a calendar the agenda hides, it says where it went');
  const invited = load({ booked: { id: 'ev-9', why: null } });
  invited.create('agenda');
  invited.fill({ title: 'Kickoff', attendees: 'ana@northline.example' });
  await invited.submit();
  assert.deepEqual(invited.toasts, ['Saved in the workspace: no calendar is connected yet. No invitations went out: they are sent from a connected calendar.'],
    'someone invited to an event saved here alone is told nobody was');
});

test('while a new event is being booked New event waits, so a dialog closed with Esc cannot book it twice', async () => {
  const h = load();
  const answered = h.holdBooking();
  h.create('agenda');
  h.fill({ title: 'Kickoff', attendees: 'ana@northline.example' });
  h.send();
  await settle();
  h.modal.close();
  h.create('agenda');
  assert.equal(h.modals.length, 1, 'no second dialog to send it from');
  assert.deepEqual(h.toasts, [BOOKING_WAIT]);
  answered();
  await settle();
  h.create('agenda');
  assert.equal(h.modals.length, 2, 'once it is booked, New event opens again');
  assert.equal(h.created.length, 1);
});

test('while the workspace is still loading New event says so, and opens nothing', () => {
  const h = load({ loaded: false });
  h.create('agenda');
  assert.equal(h.modals.length, 0);
  assert.deepEqual(h.toasts, ['Not yet: the workspace is still loading.']);
});

/* ── Changing an event ──────────────────────────────────────────────────── */

test('an edit changes an event\'s title, when it starts and ends, where it is and its details, and sends only what changed', () => {
  const { changes } = load().model;
  const row = event().row;
  assert.deepEqual({ ...changes(row, SAME).changes }, {}, 'the event as it was is no change');
  const moved = changes(row, { ...SAME, startsAt: '2026-09-21T14:30', endsAt: '2026-09-21T15:30', location: '  ', detail: ' Bring the forms ' });
  assert.equal(moved.ok, true);
  assert.deepEqual({ ...moved.changes }, { starts_at: '2026-09-21T12:30:00.000Z', ends_at: '2026-09-21T13:30:00.000Z', location: null },
    'read on the clock of whoever edits it: 14:30 in Amsterdam is 12:30 UTC');
  assert.deepEqual({ ...changes(row, { ...SAME, title: '  Dentist, moved  ' }).changes }, { title: 'Dentist, moved' });
  assert.deepEqual({ ...changes(row, { ...SAME, endsAt: '' }).changes }, { ends_at: null }, 'an end left empty is no end');
  assert.deepEqual({ ...changes({ ...row, starts_at: '2026-09-18T07:00:30.000Z' }, SAME).changes }, {},
    'a start stored with seconds, shown to the minute, is not moved by saving');
  assert.deepEqual({ ...changes({ ...row, detail: null, location: null }, { ...SAME, detail: '', location: '' }).changes }, {}, 'empty is none');
});

test('a title, a start that can be read and an end after it are asked for, each on its own field', () => {
  const { changes } = load().model;
  const row = event().row;
  const problem = values => { const checked = changes(row, { ...SAME, ...values }); return [checked.ok, checked.field, checked.problem]; };
  assert.deepEqual(problem({ title: '  ' }), [false, 'title', 'Give the event a title.']);
  assert.deepEqual(problem({ title: 'x'.repeat(201) }), [false, 'title', 'A title is at most 200 characters.']);
  assert.equal(changes(row, { ...SAME, title: 'x'.repeat(200) }).ok, true);
  const START = 'Pick the day and time it starts.';
  assert.deepEqual(problem({ startsAt: '' }), [false, 'startsAt', START]);
  assert.deepEqual(problem({ startsAt: '2026-02-30T09:00' }), [false, 'startsAt', START], 'a day that does not exist');
  assert.deepEqual(problem({ startsAt: '0026-09-18T09:00' }), [false, 'startsAt', START], 'a year typed as 26');
  assert.deepEqual(problem({ startsAt: '1026-09-18T09:00' }), [false, 'startsAt', START], 'a year long past, as a slipped key makes it');
  assert.deepEqual(problem({ startsAt: '2026-03-29T02:30', endsAt: '2026-03-29T04:00' }), [false, 'startsAt', START], 'a time the clocks skip');
  assert.deepEqual(problem({ endsAt: 'soon' }), [false, 'endsAt', 'Pick the day and time it ends, or leave it empty.']);
  assert.deepEqual(problem({ endsAt: '2026-09-18T09:00' }), [false, 'endsAt', 'It has to end after it starts.']);
  assert.deepEqual(problem({ endsAt: '2026-09-18T08:00' }), [false, 'endsAt', 'It has to end after it starts.']);
});

test('a time left as the dialog filled it in is neither sent nor checked: in the hour the clocks repeat it would read back an hour off', () => {
  const { changes, localValue } = load().model;
  const repeated = event({ starts_at: '2026-10-25T01:30:00.000Z', ends_at: '2026-10-25T02:15:00.000Z' }).row;
  const shown = { title: 'Dentist', startsAt: '2026-10-25T02:30', endsAt: '2026-10-25T03:15', location: 'Keizersgracht 1', detail: 'Bring the forms' };
  assert.equal(localValue(repeated.starts_at), '2026-10-25T02:30', 'the second 02:30 of that night');
  assert.deepEqual({ ...changes(repeated, { ...shown, title: 'Dentist, moved' }).changes }, { title: 'Dentist, moved' }, 'not moved an hour earlier by a new title');
  assert.deepEqual({ ...changes(repeated, { ...shown, endsAt: '2026-10-25T04:00' }).changes }, { ends_at: '2026-10-25T03:00:00.000Z' }, 'moving only the end sends only the end');
  const backwards = event({ starts_at: '2026-10-25T00:30:00.000Z', ends_at: '2026-10-25T01:15:00.000Z' }).row;
  const checked = changes(backwards, { ...shown, startsAt: '2026-10-25T02:30', endsAt: '2026-10-25T02:15', title: 'Dentist, moved' });
  assert.equal(checked.ok, true, 'an end reading as before its start, only because the clocks went back, does not stop a new title');
  assert.deepEqual({ ...checked.changes }, { title: 'Dentist, moved' });
  const moment = event({ ends_at: at(18, 9) }).row;
  assert.deepEqual({ ...changes(moment, { ...SAME, endsAt: '2026-09-18T09:00', title: 'Dentist, moved' }).changes }, { title: 'Dentist, moved' },
    'nor does an event stored ending as it starts');
});

test('a title stored longer than an edit allows does not stop the rest of the event from being changed', () => {
  const { changes } = load().model;
  const long = event({ title: 'x'.repeat(250) }).row;
  const checked = changes(long, { ...SAME, title: 'x'.repeat(250), location: 'Prinsengracht 5' });
  assert.equal(checked.ok, true);
  assert.deepEqual({ ...checked.changes }, { location: 'Prinsengracht 5' });
  assert.equal(changes(long, { ...SAME, title: 'y'.repeat(250) }).field, 'title', 'a new title that long is still refused');
});

test('an all-day event keeps its day: only its title, place and details change', () => {
  const allDay = event({ all_day: true, starts_at: '2026-09-18T00:00:00.000Z', ends_at: '2026-09-19T00:00:00.000Z', location: null, detail: null });
  const h = load({ list: [allDay] });
  h.click(target('data-agenda-edit', 'ev-1'));
  assert.doesNotMatch(h.modals[0].body, /name="startsAt"|name="endsAt"/);
  assert.match(h.modals[0].body, /<p class="form-note">It is an all-day event, so its day stays as it is here\.<\/p>/);
  assert.deepEqual({ ...h.model.changes(allDay.row, { title: 'Offsite', startsAt: 'nonsense' }).changes }, { title: 'Offsite' });
});

test('the dialog opens filled in with the event as the page drew it, on this clock, with what anyone typed kept as text', () => {
  const h = load({ list: [event({ title: TYPED, location: TYPED, detail: TYPED })] });
  h.click(target('data-agenda-edit', 'ev-1'));
  const body = h.modals[0].body;
  assert.equal(h.modals[0].eyebrow, 'AGENDA · EVENT');
  assert.match(body, /<form id="event-edit-form" method="dialog" novalidate>/);
  assert.match(body, /<input name="title" required maxlength="200" autofocus value="&lt;img src=x onerror=alert\(1\)&gt;">/);
  assert.match(body, /<input type="datetime-local" name="startsAt" required value="2026-09-18T09:00">/);
  assert.match(body, /<input type="datetime-local" name="endsAt" value="2026-09-18T10:00">/);
  assert.match(body, /<textarea name="detail">&lt;img src=x onerror=alert\(1\)&gt;<\/textarea>/);
  assert.match(body, /data-label="Save event">Save event<\/button>/);
  assert.doesNotMatch(body, /<img/i);
});

test('a changed event is saved with only what changed, made against when it last changed, and the keyboard goes back to its Edit button', async () => {
  const h = load();
  h.click(target('data-agenda-edit', 'ev-1'));
  h.fill({ title: 'Dentist, moved', startsAt: '2026-09-21T14:30', endsAt: '2026-09-21T15:30' });
  await h.submit();
  assert.deepEqual(h.updates, [['ev-1', { title: 'Dentist, moved', starts_at: '2026-09-21T12:30:00.000Z', ends_at: '2026-09-21T13:30:00.000Z' }, STAMP]]);
  assert.deepEqual(h.toasts, ['Event saved.']);
  assert.equal(h.modal.open, false);
  assert.deepEqual(h.pageFocus, [EDIT_BUTTON]);
  const away = load({ page: [HEADING] });
  away.click(target('data-agenda-edit', 'ev-1'));
  away.fill({ startsAt: '2026-10-21T14:30', endsAt: '2026-10-21T15:30' });
  await away.submit();
  assert.deepEqual(away.pageFocus, [HEADING], 'moved out of the weeks loaded, its page is loading it: the keyboard goes to the heading');
  assert.equal(away.element(HEADING).attributes.tabindex, '-1');
  const elsewhere = load({ active: { isConnected: true } });
  elsewhere.click(target('data-agenda-edit', 'ev-1'));
  elsewhere.fill({ title: 'Dentist, moved' });
  await elsewhere.submit();
  assert.deepEqual(elsewhere.pageFocus, [], 'a keyboard somewhere on the page is left there');
});

test('an edit that changes nothing saves nothing; a refusal is said once, on the dialog, which stays open', async () => {
  const h = load();
  h.click(target('data-agenda-edit', 'ev-1'));
  await h.submit();
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.toasts, ['Nothing changed.']);
  assert.equal(h.modal.open, false);
  const refused = load({ refuse: true });
  refused.click(target('data-agenda-edit', 'ev-1'));
  refused.fill({ title: 'Dentist, moved' });
  await refused.submit();
  assert.equal(refused.modal.open, true);
  assert.equal(refused.form().error.textContent, REFUSAL);
  assert.deepEqual(refused.toasts, []);
  assert.equal(refused.form().button.disabled, false);
});

test('while a change is being written its fields take no typing, and after a refusal they take it again', async () => {
  const h = load({ refuse: true });
  h.click(target('data-agenda-edit', 'ev-1'));
  h.fill({ title: 'Dentist, moved' });
  const wrote = h.holdWrite();
  h.send();
  await settle();
  assert.equal(h.form().field('title').readOnly, true, 'what is typed now would not be sent');
  assert.equal(h.form().field('detail').readOnly, true);
  wrote();
  await settle();
  assert.equal(h.form().error.textContent, REFUSAL);
  assert.equal(h.form().field('title').readOnly, false);
  assert.equal(h.form().field('detail').readOnly, false);
});

test('a problem is said on its field, and the next send starts from a clean dialog', async () => {
  const h = load();
  h.click(target('data-agenda-edit', 'ev-1'));
  h.fill({ endsAt: '2026-09-18T08:00' });
  await h.submit();
  assert.deepEqual(h.updates, []);
  assert.equal(h.form().error.textContent, 'It has to end after it starts.');
  assert.equal(h.form().field('endsAt').attributes['aria-invalid'], 'true');
  assert.deepEqual(h.form().focused, ['endsAt']);
  h.fill({ endsAt: '2026-09-18T11:00' });
  await h.submit();
  assert.equal(h.form().error.textContent, '');
  assert.equal(h.form().field('endsAt').attributes['aria-invalid'], undefined);
  assert.deepEqual(h.updates, [['ev-1', { ends_at: '2026-09-18T09:00:00.000Z' }, STAMP]]);
});

test('the change is judged, and made, against the event as the dialog showed it, so what someone changed meanwhile is not undone', async () => {
  const list = [event()];
  const h = load({ list });
  h.click(target('data-agenda-edit', 'ev-1'));
  list[0] = event({ title: 'Dentist (moved by Ana)', location: 'Prinsengracht 5', updated_at: '2026-09-15T09:30:00.000000+00:00' });
  h.fill({ detail: 'Bring the forms and the card' });
  await h.submit();
  assert.deepEqual(h.updates, [['ev-1', { detail: 'Bring the forms and the card' }, STAMP]],
    'only the details, and against the event as it was — which the database refuses, now that Ana changed it');
});

test('moving the start moves the end with it, keeping how long the event is', () => {
  const h = load();
  h.click(target('data-agenda-edit', 'ev-1'));
  h.fill({ startsAt: '2026-09-18T13:15' });
  h.change('startsAt');
  assert.equal(h.form().field('endsAt').value, '2026-09-18T14:15');
  h.fill({ endsAt: '2026-09-18T16:00' });
  h.fill({ startsAt: '2026-09-19T13:15' });
  h.change('startsAt');
  assert.equal(h.form().field('endsAt').value, '2026-09-19T16:00', 'from wherever the end was last set');
  const open = load({ list: [event({ ends_at: null })] });
  open.click(target('data-agenda-edit', 'ev-1'));
  open.fill({ startsAt: '2026-09-18T13:15' });
  open.change('startsAt');
  assert.equal(open.form().field('endsAt').value, '', 'an event with no end still has none');
  const fresh = load();
  fresh.create('agenda');
  fresh.fill({ startsAt: '2026-09-16T15:00' });
  fresh.change('startsAt');
  assert.equal(fresh.form().field('endsAt').value, '2026-09-16T15:30', 'and in New event too');
});

test('only an event its person may change opens; a forged button, a missing event and a workspace still loading are told', () => {
  const theirs = load({ list: [event({ created_by: 'e-you' })] });
  theirs.click(target('data-agenda-edit', 'ev-1'));
  assert.equal(theirs.modals.length, 0);
  assert.deepEqual(theirs.toasts, ['This event cannot be changed here.']);
  const manager = load({ list: [event({ created_by: 'e-you' })], manager: true });
  manager.click(target('data-agenda-edit', 'ev-1'));
  assert.equal(manager.modals.length, 1, 'an owner or admin may');
  const gone = load({ list: [] });
  gone.click(target('data-agenda-edit', 'ev-1'));
  assert.deepEqual(gone.toasts, ['That event is not loaded any more. Reload the page.']);
  const waiting = load({ loaded: false });
  waiting.click(target('data-agenda-edit', 'ev-1'));
  assert.deepEqual(waiting.toasts, ['Not yet: the workspace is still loading.']);
  assert.equal(waiting.modals.length, 0);
});

test('until the workspace is loaded again after a change, the event\'s Edit waits: the page still shows it as it was', async () => {
  const h = load();
  const reloaded = h.holdReload();
  h.click(target('data-agenda-edit', 'ev-1'));
  h.fill({ title: 'Dentist, moved' });
  await h.submit();
  assert.equal(h.modal.open, false, 'the dialog closes once the database has it');
  h.click(target('data-agenda-edit', 'EV-1'));
  assert.equal(h.modals.length, 1);
  assert.deepEqual(h.toasts, [WAIT]);
  assert.equal(h.model.recordOf({ id: 'EV-1' }), 'event:ev-1', 'the same event, whatever case its address has');
  reloaded();
  await settle();
  h.click(target('data-agenda-edit', 'ev-1'));
  assert.equal(h.modals.length, 2);
});

test('a change whose weeks did not come back with the load after it keeps Edit waiting until a later load brings them', async () => {
  const h = load({ misses: ['events'] });
  h.arrive('events');
  h.click(target('data-agenda-edit', 'ev-1'));
  h.fill({ title: 'Dentist, moved' });
  await h.submit();
  assert.deepEqual(h.toasts, ['Event saved.']);
  h.click(target('data-agenda-edit', 'ev-1'));
  assert.equal(h.modals.length, 1, 'the page still has the event as it was, which saving again would put back');
  assert.equal(h.toasts.at(-1), WAIT);
  h.arrive('events');
  h.click(target('data-agenda-edit', 'ev-1'));
  assert.equal(h.modals.length, 2);
});

test('a project meeting waits for the project meetings as well as the weeks; any other event does not', async () => {
  const meeting = load({ list: [event({ project_id: 'p-1' })], misses: ['projectEvents'] });
  meeting.click(target('data-agenda-edit', 'ev-1'));
  meeting.fill({ title: 'Design review, moved' });
  await meeting.submit();
  meeting.click(target('data-agenda-edit', 'ev-1'));
  assert.equal(meeting.modals.length, 1, 'the weeks came back; the project meetings, where its page finds it out of the weeks, did not');
  assert.equal(meeting.toasts.at(-1), WAIT);
  meeting.arrive('projectEvents');
  meeting.click(target('data-agenda-edit', 'ev-1'));
  assert.equal(meeting.modals.length, 2);
  const other = load({ misses: ['projectEvents'] });
  other.click(target('data-agenda-edit', 'ev-1'));
  other.fill({ title: 'Dentist, moved' });
  await other.submit();
  other.click(target('data-agenda-edit', 'ev-1'));
  assert.equal(other.modals.length, 2, 'an event on no project is not held up by the project meetings');
});
