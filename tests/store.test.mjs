/* The store, without a page: store.js against a stand-in workspaceData whose
   answers each test controls, and the arrays app.js declares. Loaded into a
   sandbox the way <script> tags run it. Run from the repo root with: node --test

   Timers never fire on their own here. A test fires the ones it means to — the
   twenty-second limit on a request, a scheduled retry — with fire(). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/* What the views declare in app.js and read from calendar.js. */
const PRELUDE = `
const tickets = []; const projects = []; const contacts = []; const mails = [];
const events = []; const invoices = []; const team = []; const workspaceActivity = [];
const recordNotes = { tickets: {}, projects: {}, crm: {}, agenda: {}, companies: {} };
var renders = 0, idleRepaints = 0, toasts = [];
function nav() {}
function render() { renders++; }
function repaintWhenIdle() { idleRepaints++; }
function toast(message) { toasts.push(message); }
const CAL = { loadFrom: '2026-09-14T00:00:00.000Z', loadTo: '2026-09-21T00:00:00.000Z',
              onChange() {}, contains() { return true; } };
`;

const ticket = (over = {}) => ({ id: 1, uuid: 't1', title: 'Broken login', status: 'Open', priority: 'High', ...over });
const projectRow = () => ({
  id: 'a1000000-0000-4000-8000-000000000001', name: 'Northline site', client: 'Northline', initial: 'N',
  style: 'client', progress: 0, due: '', status: 'In progress', description: '',
  row: { id: 'a1000000-0000-4000-8000-000000000001', company_id: null, owner_id: null, due_on: null }
});
const thread = (count = 2) => ({
  id: 'th1', subject: 'Hello', folder: 'inbox', unread: false,
  body: undefined, bodyHtml: undefined, thread: undefined,
  row: { id: 'th1', last_message_at: '2026-09-14T09:00:00Z', message_count: count }
});

/* Every loader the store calls, answering as a quiet studio would. */
function answers(over = {}) {
  return {
    tickets: async () => [ticket()],
    projects: async () => [],
    allProjectTasks: async () => [],
    contacts: async () => [],
    team: async () => [],
    events: async () => [],
    invoices: async () => [],
    activity: async () => [],
    mailboxes: async () => [],
    mailThreads: async () => ({ threads: [], truncated: [] }),
    mailMessages: async () => [{ body: 'hello', bodyHtml: '' }],
    overview: async () => ({ tickets_open: 1 }),
    revenueSeries: async () => [],
    revenueMix: async () => [],
    companies: async () => [],
    upcomingProjectEvents: async () => [],
    projectMembers: async () => [],
    projectContacts: async () => [],
    projectFiles: async () => [],
    projectBudgets: async () => [],
    notes: async () => [],
    ...over
  };
}

const failing = () => Object.fromEntries(Object.keys(answers()).map(name => [name, async () => {
  throw new Error('Could not load ' + name + ': Failed to fetch');
}]));

function start(loaders) {
  const calls = {};
  const counted = source => Object.fromEntries(Object.entries(source).map(([name, fn]) => [name, (...args) => {
    calls[name] = (calls[name] || 0) + 1;
    return fn(...args);
  }]));
  const timers = [];
  const listeners = {};
  const on = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  const emit = type => (listeners[type] || []).forEach(fn => fn({ type }));
  const window = { workspaceData: counted(loaders), addEventListener: on };
  const context = vm.createContext({
    console: { ...console, error() {}, warn() {} },
    window,
    document: {
      visibilityState: 'visible',
      body: { addEventListener: on, dispatchEvent: e => { (listeners[e.type] || []).forEach(fn => fn(e)); return true; } },
      addEventListener: on,
      querySelector: () => null,
      getElementById: () => null
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }),
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: () => 0
  });
  for (const file of ['data/load-model.js', 'projects-model.js', 'agenda-model.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  vm.runInContext(PRELUDE, context);
  vm.runInContext(readFileSync(new URL('../dist/data/store.js', import.meta.url), 'utf8'), context);
  return {
    store: window.workspaceStore,
    context,
    calls,
    read: name => vm.runInContext(name, context),
    answer: next => { window.workspaceData = counted(next); },
    pending: ms => timers.filter(t => !t.cleared && t.ms === ms),
    fire: ms => timers.filter(t => !t.cleared && t.ms === ms).forEach(t => { t.cleared = true; t.fn(); }),
    signIn: () => emit('workspace:authed'),
    goOnline: () => emit('online')
  };
}

/* ── The agenda's weeks ───────────────────────────────────────────────── */

const TODAY_WEEK = 'agendaModel.weekOf(new Date())';
const LATER_WEEK = 'agendaModel.shiftWeek(agendaModel.weekOf(new Date()), 3)';

test('events load for today\'s week and for the week the agenda shows, each by overlap, merged by id', async () => {
  const asked = [];
  const s = start(answers({
    eventsOverlapping: async range => {
      asked.push(range.from);
      return [
        { id: 'ev-shared', title: 'Offsite', row: { id: 'ev-shared', starts_at: '2026-09-20T08:00:00Z' } },
        { id: 'ev-' + range.from, title: 'That week', row: { id: 'ev-' + range.from, starts_at: range.from } }
      ];
    }
  }));
  const from = week => s.read(`agendaModel.loadRange(${week}).from`);
  await s.store.load();
  assert.ok(asked.includes(from(TODAY_WEEK)), 'today\'s week, for the Overview and the bell');
  const later = s.read(LATER_WEEK);
  assert.equal(s.store.weekLoaded(later.key), false);
  asked.length = 0;
  await s.store.showWeek(later);
  assert.deepEqual([...asked].sort(), [from(TODAY_WEEK), from(LATER_WEEK)].sort());
  assert.equal(s.store.weekLoaded(later.key), true);
  const ids = s.read('events').map(e => e.id);
  assert.equal(ids.filter(id => id === 'ev-shared').length, 1, 'an event in both weeks is there once');
  assert.ok(ids.includes('ev-' + from(LATER_WEEK)));
});

/* ── Who is invited to an event ───────────────────────────────────────── */

const INVITED_EVENT = 'e9000000-0000-4000-8000-000000000001';

test('who is invited to an event loads when its page asks, once however often it is drawn, is drawn again when it lands, and is asked again after a write', async () => {
  const asked = [];
  let answer = [{ name: 'Dana Reyes', email: 'dana@northline.example', response: 'accepted' }];
  const s = start(answers({ eventInvitees: async id => { asked.push(id); return answer; } }));
  assert.equal(s.store.askInvitees(INVITED_EVENT).state, 'loading', 'nothing is asked before the workspace has loaded');
  assert.deepEqual(asked, []);
  await s.store.load();
  assert.equal(s.store.askInvitees(INVITED_EVENT).state, 'loading');
  s.store.askInvitees(INVITED_EVENT.toUpperCase());
  const drawn = s.read('renders') + s.read('idleRepaints');
  await tick();
  assert.deepEqual(asked, [INVITED_EVENT], 'asked once, whatever case its address is in');
  const ready = s.store.askInvitees(INVITED_EVENT);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.attendees[0].name, 'Dana Reyes');
  assert.ok(s.read('renders') + s.read('idleRepaints') > drawn, 'the page is drawn again when they land');
  assert.equal(s.store.askInvitees('not-an-id').state, 'missing', 'only an event\'s id is asked for');
  answer = null;
  await s.store.after(Promise.resolve());
  assert.equal(s.store.askInvitees(INVITED_EVENT).state, 'loading', 'a write may have changed who is invited: asked again');
  await tick();
  assert.equal(s.store.askInvitees(INVITED_EVENT).state, 'missing', 'an event gone, or not this person\'s to see');
});

test('who is invited that did not load says so until a load works, then is asked for again', async () => {
  let fail = true;
  let asked = 0;
  const s = start(answers({ eventInvitees: async () => {
    asked += 1;
    if (fail) throw new Error('Could not load who is invited: Failed to fetch');
    return [];
  } }));
  await s.store.load();
  s.store.askInvitees(INVITED_EVENT);
  await tick();
  assert.equal(s.store.askInvitees(INVITED_EVENT).state, 'failed');
  await tick();
  assert.equal(asked, 1, 'a page drawn again does not ask again by itself');
  fail = false;
  await s.store.load();
  s.store.askInvitees(INVITED_EVENT);
  await tick();
  assert.equal(s.store.askInvitees(INVITED_EVENT).state, 'ready');
  assert.equal(asked, 2);
});

/* ── Transactions (0060) ──────────────────────────────────────────────── */

test('transactions load for a window when Finance\'s own page asks, once however often it is drawn, and it is drawn again when they land', async () => {
  const asked = [];
  const s = start(answers({ transactions: async since => { asked.push(since); return [{ id: 'tx1', amount: -20 }]; } }));
  assert.equal(s.store.transactions('2026-01-01').state, 'loading', 'nothing is asked before the workspace has loaded');
  assert.deepEqual(asked, []);
  await s.store.load();
  const repaintsBefore = s.read('idleRepaints');
  assert.equal(s.store.transactions('2026-01-01').state, 'loading');
  s.store.transactions('2026-01-01');
  await tick();
  assert.deepEqual(asked, ['2026-01-01'], 'asked once');
  const ready = s.store.transactions('2026-01-01');
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.rows.map(r => r.id), ['tx1']);
  assert.ok(s.read('idleRepaints') > repaintsBefore, 'the page is drawn again once they land, as a background repaint that keeps what is being typed');
  s.store.transactions('2026-06-01');
  await tick();
  assert.equal(asked.length, 2, 'a different window asks again');
});

test('transactions that did not load say so until asked again, and a write asks for them afresh', async () => {
  let fail = true;
  let asked = 0;
  const s = start(answers({ transactions: async () => {
    asked += 1;
    if (fail) throw new Error('Could not load transactions: Failed to fetch');
    return [];
  } }));
  await s.store.load();
  s.store.transactions('2026-01-01');
  await tick();
  assert.equal(s.store.transactions('2026-01-01').state, 'failed');
  await tick();
  assert.equal(asked, 1, 'a failure is not asked again by every draw of the page');
  fail = false;
  s.store.retryTransactions('2026-01-01');
  s.store.transactions('2026-01-01');
  await tick();
  assert.equal(s.store.transactions('2026-01-01').state, 'ready');
  assert.equal(asked, 2);
  await s.store.after(Promise.resolve({}));
  s.store.transactions('2026-01-01');
  await tick();
  assert.equal(asked, 3, 'after a write they are asked for again: what was written may be among them');
});

test('a write that failed clears transactions too: it may still have changed something', async () => {
  let asked = 0;
  const s = start(answers({ transactions: async () => { asked += 1; return []; } }));
  await s.store.load();
  s.store.transactions('2026-01-01');
  await tick();
  await assert.rejects(s.store.after(Promise.reject(new Error('That was not saved.'))));
  s.store.transactions('2026-01-01');
  await tick();
  assert.equal(asked, 2);
});

test('a client\'s past meetings load when their page asks, once however often it is drawn, and it is drawn again when they land', async () => {
  const asked = [];
  const s = start(answers({ pastMeetings: async filter => { asked.push(filter); return { meetings: [{ id: 'e1', title: 'Kickoff' }], more: false }; } }));
  const filter = { companyId: 'co1', before: '2026-09-15T00:00:00.000Z' };
  assert.equal(s.store.pastMeetings('company:co1', filter).state, 'loading', 'nothing is asked before the workspace has loaded');
  assert.equal(asked.length, 0);
  await s.store.load();
  const repaintsBefore = s.read('idleRepaints');
  assert.equal(s.store.pastMeetings('company:co1', filter).state, 'loading');
  s.store.pastMeetings('company:co1', filter);
  await tick();
  assert.equal(asked.length, 1, 'asked once');
  const ready = s.store.pastMeetings('company:co1', filter);
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.meetings.map(m => m.title), ['Kickoff']);
  assert.equal(ready.more, false);
  assert.ok(s.read('idleRepaints') > repaintsBefore, 'the page is drawn again when they land, as a background repaint that keeps what is being typed');
  s.store.pastMeetings('company:co1', { ...filter, contactIds: ['c9'] });
  await tick();
  assert.equal(asked.length, 2, 'a company whose people changed asks again');
});

test('past meetings that did not load say so until asked again, and a write asks for them afresh', async () => {
  let fail = true;
  let asked = 0;
  const s = start(answers({ pastMeetings: async () => {
    asked += 1;
    if (fail) throw new Error('Could not load past meetings: Failed to fetch');
    return { meetings: [], more: false };
  } }));
  await s.store.load();
  const filter = { contactIds: ['c1'], before: '2026-09-15T00:00:00.000Z' };
  s.store.pastMeetings('contact:c1', filter);
  await tick();
  assert.equal(s.store.pastMeetings('contact:c1', filter).state, 'failed');
  await tick();
  assert.equal(asked, 1, 'a failure is not asked again by every draw of the page');
  fail = false;
  s.store.retryPastMeetings('contact:c1');
  s.store.pastMeetings('contact:c1', filter);
  await tick();
  assert.equal(s.store.pastMeetings('contact:c1', filter).state, 'ready');
  assert.equal(asked, 2);
  await s.store.after(Promise.resolve({}));
  s.store.pastMeetings('contact:c1', filter);
  await tick();
  assert.equal(asked, 3, 'after a write they are asked for again: what was written may be among them');
});

test('past meetings that did not load are drawn again as such, so the page does not say "Loading" for good', async () => {
  const s = start(answers({ pastMeetings: async () => { throw new Error('Could not load past meetings: Failed to fetch'); } }));
  await s.store.load();
  const before = s.read('idleRepaints');
  s.store.pastMeetings('contact:c1', { contactIds: ['c1'] });
  await tick();
  assert.equal(s.store.pastMeetings('contact:c1', { contactIds: ['c1'] }).state, 'failed');
  assert.ok(s.read('idleRepaints') > before);
});

test('past meetings that set out before a write are not kept once they land after it', async () => {
  const gate = deferred();
  let asked = 0;
  const s = start(answers({ pastMeetings: async () => {
    asked += 1;
    if (asked === 1) { await gate.promise; return { meetings: [{ id: 'old', title: 'From before the write' }], more: false }; }
    return { meetings: [{ id: 'new', title: 'From after it' }], more: false };
  } }));
  await s.store.load();
  const filter = { contactIds: ['c1'] };
  s.store.pastMeetings('contact:c1', filter);
  await s.store.after(Promise.resolve({}));
  gate.resolve();
  await tick();
  s.store.pastMeetings('contact:c1', filter);
  await tick();
  assert.equal(asked, 2, 'asked for again after the write');
  assert.deepEqual(s.store.pastMeetings('contact:c1', filter).meetings.map(m => m.id), ['new']);
});

test('a write that failed clears past meetings too: it may still have changed something', async () => {
  let asked = 0;
  const s = start(answers({ pastMeetings: async () => { asked += 1; return { meetings: [], more: false }; } }));
  await s.store.load();
  s.store.pastMeetings('contact:c1', { contactIds: ['c1'] });
  await tick();
  await assert.rejects(s.store.after(Promise.reject(new Error('The note was not saved.'))));
  s.store.pastMeetings('contact:c1', { contactIds: ['c1'] });
  await tick();
  assert.equal(asked, 2);
});

test('Try again asks again only for what failed; past meetings that loaded are kept', async () => {
  const asked = [];
  const s = start(answers({ pastMeetings: async filter => {
    asked.push(filter.limit);
    if (filter.limit === 2) throw new Error('Could not load past meetings: Failed to fetch');
    return { meetings: [], more: false };
  } }));
  await s.store.load();
  s.store.pastMeetings('company:co1', { companyId: 'co1', limit: 1 });
  s.store.pastMeetings('company:co1', { companyId: 'co1', limit: 2 });
  await tick();
  s.store.retryPastMeetings('company:co1');
  s.store.pastMeetings('company:co1', { companyId: 'co1', limit: 1 });
  s.store.pastMeetings('company:co1', { companyId: 'co1', limit: 2 });
  await tick();
  assert.deepEqual(asked, [1, 2, 2]);
});

test('a load that works asks again for past meetings that did not load, as everything else is tried again by itself', async () => {
  let fail = true;
  let asked = 0;
  const s = start(answers({ pastMeetings: async () => {
    asked += 1;
    if (fail) throw new Error('Could not load past meetings: Failed to fetch');
    return { meetings: [], more: false };
  } }));
  await s.store.load();
  const filter = { contactIds: ['c1'] };
  s.store.pastMeetings('contact:c1', filter);
  await tick();
  fail = false;
  const before = s.read('idleRepaints');
  await s.store.load({ quiet: true });
  assert.ok(s.read('idleRepaints') > before, 'and the page is drawn again, which asks');
  s.store.pastMeetings('contact:c1', filter);
  await tick();
  assert.equal(asked, 2);
  assert.equal(s.store.pastMeetings('contact:c1', filter).state, 'ready');
});

test('a client\'s past meeting is found by its id, so its link opens its page', async () => {
  const s = start(answers({ pastMeetings: async () => ({ meetings: [{ id: 'ev-9', title: 'Pitch' }], more: false }) }));
  await s.store.load();
  s.store.pastMeetings('company:co1', { companyId: 'co1' });
  await tick();
  assert.equal(s.store.eventById('EV-9').title, 'Pitch');
});

test('an event not in the weeks loaded is asked for by its id, once, and found when it lands; one not there says so; one that did not load is asked for again', async () => {
  const OLD = 'e9000000-0000-4000-8000-000000000001';
  const GONE = 'e9000000-0000-4000-8000-000000000002';
  const FAILS = 'e9000000-0000-4000-8000-000000000003';
  const asked = [];
  let fail = false;
  const s = start(answers({ event: async id => {
    asked.push(id);
    if (fail) throw new Error('Could not load the event: Failed to fetch');
    return id === OLD ? { id: OLD, title: 'Pitch', row: { id: OLD, starts_at: '2026-08-01T10:00:00Z' } } : null;
  } }));
  assert.equal(s.store.askEvent(OLD).state, 'loading', 'nothing is asked before the workspace has loaded');
  assert.deepEqual(asked, []);
  await s.store.load();
  assert.equal(s.store.eventById(OLD), null);
  const before = s.read('idleRepaints');
  s.store.askEvent(OLD);
  s.store.askEvent(OLD);
  await tick();
  assert.deepEqual(asked, [OLD], 'asked once');
  assert.equal(s.store.askEvent(OLD).state, 'ready');
  assert.equal(s.store.eventById(OLD.toUpperCase()).title, 'Pitch', 'and found by its id, as any event is');
  assert.ok(s.read('idleRepaints') > before, 'the page is drawn again when it lands');
  s.store.askEvent(GONE);
  await tick();
  assert.equal(s.store.askEvent(GONE).state, 'missing');
  assert.equal(s.store.askEvent('x,id.gt.0').state, 'missing');
  assert.equal(asked.length, 2, 'an id that is not a uuid is not asked for');
  fail = true;
  s.store.askEvent(FAILS);
  await tick();
  assert.equal(s.store.askEvent(FAILS).state, 'failed');
  fail = false;
  s.store.retryEvent(FAILS);
  s.store.askEvent(FAILS);
  await tick();
  assert.equal(asked.filter(id => id === FAILS).length, 2);
  assert.equal(s.store.askEvent(FAILS).state, 'missing');
});

test('notes are filed under their record with who wrote them, so whoever wrote one can be offered Edit', async () => {
  const s = start(answers({ notes: async () => [{ id: 'n1', entityType: 'ticket', entityId: 't1', body: 'Called them', who: 'Sam Rivera', initial: 'SR', time: 'Today', authorId: 'e-me' }] }));
  await s.store.load();
  const filed = s.read('recordNotes.tickets[1]');
  assert.equal(filed.length, 1);
  assert.equal(filed[0].authorId, 'e-me');
});

test('a week already loaded is shown without asking again', async () => {
  const s = start(answers({ eventsOverlapping: async () => [] }));
  await s.store.load();
  const before = s.calls.eventsOverlapping;
  await s.store.showWeek(s.read(TODAY_WEEK));
  assert.equal(s.calls.eventsOverlapping, before);
  assert.equal(s.store.weekLoaded(s.read(TODAY_WEEK).key), true);
});

test('a week not loaded asks for its events, not for the whole workspace again', async () => {
  const s = start(answers({ eventsOverlapping: async () => [] }));
  await s.store.load();
  const before = { ...s.calls };
  await s.store.showWeek(s.read(LATER_WEEK));
  assert.deepEqual(Object.keys(s.calls).filter(name => s.calls[name] !== before[name]), ['eventsOverlapping']);
  assert.equal(s.store.weekLoaded(s.read(LATER_WEEK).key), true);
});

test('a week whose events fail says so, and leaves the rest of the workspace as it was', async () => {
  const s = start(answers({ eventsOverlapping: async () => [] }));
  await s.store.load();
  const loadedAt = s.store.state.loadedAt;
  s.answer(answers({ eventsOverlapping: async () => { throw new Error('Could not load the agenda: Failed to fetch'); } }));
  await s.store.showWeek(s.read(LATER_WEEK));
  assert.deepEqual([...s.store.state.failed], ['the agenda']);
  assert.equal(s.store.weekLoaded(s.read(LATER_WEEK).key), false);
  assert.equal(s.store.state.loadedAt, loadedAt, 'the whole workspace keeps its own refresh clock');
  assert.equal(s.store.has('tickets'), true);
});

test('a whole load asked for while a week\'s events load still runs whole, with another week queued too', async () => {
  const gate = deferred();
  const s = start(answers({ eventsOverlapping: async () => [] }));
  await s.store.load();
  const tickets = s.calls.tickets;
  s.answer(answers({ eventsOverlapping: async () => { await gate.promise; return []; } }));
  const first = s.store.showWeek(s.read(LATER_WEEK));
  const second = s.store.showWeek(s.read('agendaModel.shiftWeek(agendaModel.weekOf(new Date()), 5)'));
  const whole = s.store.load();
  gate.resolve();
  await Promise.all([first, second, whole]);
  assert.equal(s.calls.tickets, tickets + 1, 'the whole load ran once, after the week\'s events');
});

test('a week shown while the whole workspace loads asks for its events once that lands, not for everything again', async () => {
  const s = start(answers({ eventsOverlapping: async () => [] }));
  await s.store.load();
  const slow = deferred();
  s.answer(answers({ eventsOverlapping: async () => [], tickets: async () => { await slow.promise; return [ticket()]; } }));
  const tickets = s.calls.tickets;
  const whole = s.store.load({ quiet: true });
  const week = s.store.showWeek(s.read(LATER_WEEK));
  slow.resolve();
  await Promise.all([whole, week]);
  assert.equal(s.calls.tickets, tickets + 1, 'the whole workspace once');
  assert.equal(s.store.weekLoaded(s.read(LATER_WEEK).key), true);
});

test('a week\'s events that load clear the agenda\'s earlier failure, from the notice too', async () => {
  const s = start(answers({ eventsOverlapping: async () => { throw new Error('Could not load the agenda: Failed to fetch'); } }));
  await s.store.load();
  assert.deepEqual([...s.store.state.failed], ['the agenda']);
  assert.equal(s.store.state.notice.text, 'Could not load the agenda.');
  s.answer(answers({ eventsOverlapping: async () => [] }));
  await s.store.showWeek(s.read(LATER_WEEK));
  assert.deepEqual([...s.store.state.failed], []);
  assert.equal(s.store.state.notice, null, 'the bar no longer says the agenda did not load');
  assert.equal(s.pending(15000).length, 0, 'and the retry for the agenda alone is called off');
});

test('a week\'s retry that loads starts the delays again from the first', async () => {
  const noAgenda = async () => { throw new Error('Could not load the agenda: Failed to fetch'); };
  const s = start(answers({ eventsOverlapping: async () => [] }));
  await s.store.load();
  s.answer(answers({ eventsOverlapping: noAgenda }));
  await s.store.showWeek(s.read(LATER_WEEK));
  s.answer(answers({ eventsOverlapping: async () => [] }));
  s.fire(15000);
  await tick();
  assert.equal(s.store.weekLoaded(s.read(LATER_WEEK).key), true);
  s.answer(answers({ eventsOverlapping: noAgenda }));
  await s.store.showWeek(s.read('agendaModel.shiftWeek(agendaModel.weekOf(new Date()), 6)'));
  assert.equal(s.pending(15000).length, 1, 'the first delay, not the second');
});

test('a note on a project meeting outside the weeks loaded is shown on its page', async () => {
  const review = { id: 'pe1', title: 'Design review', row: { id: 'pe1' } };
  const s = start(answers({
    eventsOverlapping: async () => [],
    upcomingProjectEvents: async () => [review],
    notes: async () => [{ id: 'n1', entityType: 'event', entityId: 'pe1', body: 'Bring the mockups', time: 'Today', who: 'Sam Rivera', initial: 'SR' }]
  }));
  await s.store.load();
  const notes = s.read('recordNotes.agenda.pe1');
  assert.equal(notes && notes.length, 1);
  assert.equal(notes[0].body, 'Bring the mockups');
});

test('a note on a company is shown on its page, and a note written there finds the company', async () => {
  const s = start(answers({
    companies: async () => [{ id: 'co1', name: 'Northline', row: { id: 'co1' } }],
    notes: async () => [{ id: 'n1', entityType: 'company', entityId: 'co1', body: 'Met at the fair', time: 'Today', who: 'Sam Rivera', initial: 'SR' }]
  }));
  await s.store.load();
  const notes = s.read('recordNotes.companies.co1');
  assert.equal(notes && notes[0].body, 'Met at the fair');
  assert.deepEqual({ ...s.store.noteTarget('companies', 'CO1') }, { type: 'company', id: 'co1' });
  assert.equal(s.store.noteTarget('companies', 'gone'), null);
});

test('a week that loads after one failed calls off that retry, and the next failure starts from the first delay', async () => {
  const noAgenda = async () => { throw new Error('Could not load the agenda: Failed to fetch'); };
  const s = start(answers({ eventsOverlapping: async () => [] }));
  await s.store.load();
  s.answer(answers({ eventsOverlapping: noAgenda }));
  await s.store.showWeek(s.read(LATER_WEEK));
  assert.equal(s.pending(15000).length, 1);
  s.answer(answers({ eventsOverlapping: async () => [] }));
  await s.store.showWeek(s.read('agendaModel.shiftWeek(agendaModel.weekOf(new Date()), 4)'));
  assert.equal(s.pending(15000).length, 0, 'nothing is left to try again');
  s.answer(answers({ eventsOverlapping: noAgenda }));
  await s.store.showWeek(s.read('agendaModel.shiftWeek(agendaModel.weekOf(new Date()), 6)'));
  assert.equal(s.pending(15000).length, 1, 'the first delay, not the second');
});

test('a week that loads leaves a retry of the whole workspace on its way, and the notice of what it is for', async () => {
  const s = start(answers({ eventsOverlapping: async () => [], invoices: async () => { throw new Error('Could not load invoices: Failed to fetch'); } }));
  await s.store.load();
  assert.equal(s.pending(15000).length, 1);
  await s.store.showWeek(s.read(LATER_WEEK));
  assert.equal(s.pending(15000).length, 1, 'invoices are still tried again');
  assert.equal(s.store.state.notice.text, 'Could not load invoices.');
  assert.deepEqual([...s.store.state.failed], ['invoices']);
});

test('the agenda moving while a first load fails leaves its events to the retry, not to the blocked screen', async () => {
  const slow = deferred();
  const s = start(answers({
    eventsOverlapping: async () => [],
    contacts: async () => { await slow.promise; throw new Error('Could not load contacts: Failed to fetch'); }
  }));
  const first = s.store.load();
  await tick();
  const asked = s.calls.eventsOverlapping;
  await s.store.showWeek(s.read(LATER_WEEK));
  slow.resolve();
  await first;
  await tick();
  assert.equal(s.store.state.loaded, false);
  assert.equal(s.calls.eventsOverlapping, asked, 'nothing more is asked until the retry loads it all');
  assert.equal(s.pending(15000).length, 1);
});

test('a week whose events failed tries its events again, not the whole workspace', async () => {
  const s = start(answers({ eventsOverlapping: async () => [] }));
  await s.store.load();
  s.answer(answers({ eventsOverlapping: async () => { throw new Error('Could not load the agenda: Failed to fetch'); } }));
  await s.store.showWeek(s.read(LATER_WEEK));
  assert.equal(s.pending(15000).length, 1, 'a retry is on its way');
  s.answer(answers({ eventsOverlapping: async () => [] }));
  const before = { ...s.calls };
  s.fire(15000);
  await tick();
  assert.deepEqual(Object.keys(s.calls).filter(name => s.calls[name] !== before[name]), ['eventsOverlapping']);
  assert.equal(s.store.weekLoaded(s.read(LATER_WEEK).key), true);
  assert.deepEqual([...s.store.state.failed], []);
});

test('a retry on its way for the whole workspace stays whole when a week\'s events fail too', async () => {
  const noInvoices = async () => { throw new Error('Could not load invoices: Failed to fetch'); };
  const s = start(answers({ eventsOverlapping: async () => [], invoices: noInvoices }));
  await s.store.load();
  assert.equal(s.pending(15000).length, 1);
  s.answer(answers({ eventsOverlapping: async () => { throw new Error('Could not load the agenda: Failed to fetch'); }, invoices: noInvoices }));
  await s.store.showWeek(s.read(LATER_WEEK));
  assert.equal(s.pending(15000).length, 1, 'still the one retry');
  s.answer(answers({ eventsOverlapping: async () => [] }));
  const tickets = s.calls.tickets;
  s.fire(15000);
  await tick();
  assert.equal(s.calls.tickets, tickets + 1, 'the retry loads everything');
  assert.deepEqual([...s.store.state.failed], []);
});

test('an event is found by id in the weeks loaded or the project meetings coming up, for its page and its notes', async () => {
  const kickoff = { id: 'e1', title: 'Kickoff', row: { id: 'e1', starts_at: new Date().toISOString() } };
  const review = { id: 'pe1', title: 'Design review', row: { id: 'pe1' } };
  const s = start(answers({ eventsOverlapping: async () => [kickoff], upcomingProjectEvents: async () => [review] }));
  await s.store.load();
  assert.equal(s.store.eventById('E1').title, 'Kickoff', 'whatever case the address has it in');
  assert.equal(s.store.eventById('pe1').title, 'Design review');
  assert.equal(s.store.eventById('gone'), null);
  assert.equal(s.store.eventById(''), null);
  assert.deepEqual({ ...s.store.noteTarget('agenda', 'pe1') }, { type: 'event', id: 'pe1' }, 'a note on a meeting outside the weeks loaded');
  assert.equal(s.store.noteTarget('agenda', 'gone'), null);
});

/* ── One part at a time ───────────────────────────────────────────────── */

test('a part that fails leaves the rest of the workspace on screen', async () => {
  const s = start(answers({
    invoices: async () => { throw new Error('Could not load invoices: Failed to fetch'); },
    projects: async () => [projectRow()]
  }));
  await s.store.load();
  assert.equal(s.store.state.loaded, true);
  assert.equal(s.read('invoices').length, 0);
  assert.equal(s.read('projects').length, 1);
  assert.deepEqual([...s.store.state.failed], ['invoices']);
  assert.equal(s.store.state.notice.text, 'Could not load invoices.');
  assert.equal(s.store.has('projects'), true);
  assert.equal(s.store.has('invoices'), false, 'a view or a write that needs invoices can tell they never arrived');
});

test('a first load without tickets, projects, contacts or companies does not open the workspace', async () => {
  const s = start(answers({ contacts: async () => { throw new Error('Could not load contacts: Failed to fetch'); } }));
  await s.store.load();
  assert.equal(s.store.state.loaded, false, 'an empty CRM would look real, and a write could duplicate a client');
  assert.equal(s.store.state.notice.kind, 'blocked');
  assert.equal(s.store.state.notice.text, 'Could not load contacts. Check your connection, then try again.');
  assert.equal(s.read('tickets').length, 1, 'what did arrive is kept for when the rest does');

  s.answer(answers());
  s.fire(15000);
  await tick();
  assert.equal(s.store.state.loaded, true);
  assert.equal(s.store.state.notice, null);
});

test('a part whose data cannot be shown is named, and the others carry on', async () => {
  const s = start(answers({ activity: async () => null }));
  await s.store.load();
  assert.equal(s.store.state.loaded, true);
  assert.deepEqual([...s.store.state.failed], ['recent activity']);
  assert.equal(s.read('tickets').length, 1);
});

test('a load someone asked for draws the page keeping focus where it was', async () => {
  const s = start(answers());
  vm.runInContext('var focusRepaints = 0; repaintKeepingFocus = function () { focusRepaints++; };', s.context);
  await s.store.load();
  await s.store.load();
  assert.ok(s.read('focusRepaints') >= 2, 'a select just changed is rebuilt, and keyboard focus would fall to the top');
  assert.equal(s.read('renders'), 0);
});

test('a page that throws while it is drawn does not stop the load, or the retry of a part that failed', async () => {
  const s = start(answers({ invoices: async () => { throw new Error('Could not load invoices: Failed to fetch'); } }));
  vm.runInContext('render = function () { throw new RangeError("Invalid currency code : US$"); };', s.context);
  await s.store.load();
  assert.equal(s.store.state.loaded, true);
  assert.equal(s.store.state.notice.text, 'Could not load invoices.');
  assert.equal(s.pending(15000).length, 1, 'invoices are still tried again');
});

test('a request that never answers does not hold the others up, or the next load', async () => {
  const s = start(answers({ mailThreads: () => new Promise(() => {}) }));
  const loading = s.store.load();
  await tick();
  assert.equal(s.pending(20000).length, 1, 'only the hung request is still being waited for');
  s.fire(20000);
  await loading;
  assert.equal(s.read('tickets').length, 1);
  assert.deepEqual([...s.store.state.failed], ['mail']);

  s.answer(answers());
  await s.store.load();
  assert.deepEqual([...s.store.state.failed], []);
  assert.equal(s.store.state.notice, null);
});

test('a refresh that fails keeps what loaded before, and says how old it is', async () => {
  let offline = false;
  const s = start(answers({
    tickets: async () => { if (offline) throw new Error('Could not load tickets: Failed to fetch'); return [ticket()]; }
  }));
  await s.store.load();
  offline = true;
  await s.store.load({ quiet: true });
  assert.equal(s.read('tickets').length, 1, 'what was on screen stays on screen');
  assert.equal(s.store.state.notice.kind, 'stale');
  assert.match(s.store.state.notice.text, /^Could not refresh tickets — showing what loaded at \d\d:\d\d\.$/);
});

/* ── A first load that fails ──────────────────────────────────────────── */

test('a first load where everything fails is not an empty studio: it blocks and tries again', async () => {
  const s = start(failing());
  await s.store.load();
  assert.equal(s.store.state.loaded, false, 'writes stay closed');
  assert.equal(s.store.state.notice.kind, 'blocked');
  assert.equal(s.pending(15000).length, 1, 'a retry is on its way');

  s.answer(answers());
  s.fire(15000);
  await tick();
  assert.equal(s.store.state.loaded, true);
  assert.equal(s.store.state.notice, null);
  assert.equal(s.read('tickets').length, 1);
});

test('retries back off while the connection stays down', async () => {
  const s = start(failing());
  await s.store.load();
  s.fire(15000);
  await tick();
  assert.equal(s.pending(30000).length, 1);
  s.fire(30000);
  await tick();
  assert.equal(s.pending(60000).length, 1);
});

test('the connection coming back tries again straight away, even while a load is running', async () => {
  const s = start(failing());
  s.signIn();
  await tick();
  assert.equal(s.pending(15000).length, 1);

  const slow = deferred();
  s.answer(answers({ tickets: () => slow.promise }));
  const running = s.store.load({ quiet: true });
  s.goOnline();
  assert.equal(s.pending(15000).length, 0, 'the retry five minutes out is not the next one');
  slow.resolve([ticket()]);
  await running;
  await tick();
  assert.equal(s.store.state.loaded, true);
});

test('before the first load lands, the views are not drawn with zeros', async () => {
  const slow = deferred();
  const s = start(answers({ tickets: () => slow.promise }));
  const loading = s.store.load();
  s.context.render();
  assert.equal(s.context.renders, 0, 'a navigation while loading shows the loading screen instead');
  slow.resolve([ticket()]);
  await loading;
  assert.equal(s.context.renders, 1);
});

/* ── Writes and refreshes ─────────────────────────────────────────────── */

test('a write that fails still reloads, so the page shows what the database has', async () => {
  const s = start(answers());
  await s.store.load();
  const before = s.calls.tickets;
  await assert.rejects(s.store.after(Promise.reject(new Error('Could not save: refused'))),
    { message: 'Could not save: refused' });
  await tick();
  assert.equal(s.calls.tickets, before + 1);
  assert.ok(s.context.toasts.includes('Could not save: refused'));
});

test('a refusal the page says itself, on a dialog, is not said again in a toast; the page is still loaded again', async () => {
  const s = start(answers());
  await s.store.load();
  const before = s.calls.tickets;
  await assert.rejects(s.store.after(Promise.reject(new Error('The note was not changed.')), { toast: false }),
    { message: 'The note was not changed.' });
  await tick();
  assert.equal(s.calls.tickets, before + 1);
  assert.ok(!s.context.toasts.includes('The note was not changed.'));
});

test('after() narrowed by `only` reloads just those parts, not the whole workspace (0060)', async () => {
  const s = start(answers());
  await s.store.load();
  const before = { ...s.calls };
  await s.store.after(Promise.resolve('saved'), { only: ['invoices'] });
  await tick();
  assert.equal(s.calls.invoices, before.invoices + 1, 'the part named is reloaded');
  assert.equal(s.calls.tickets, before.tickets, 'an unrelated part is not');
  assert.equal(s.calls.revenueSeries, before.revenueSeries, 'nor a finance part that was not named either');
  assert.equal(s.calls.revenueMix, before.revenueMix);
});

test('after() with `only` still draws the page, even where the one part it named came back unchanged', async () => {
  const s = start(answers());
  await s.store.load();
  const painted = s.context.renders + s.context.idleRepaints;
  await s.store.after(Promise.resolve('saved'), { only: ['tickets'] });
  await tick();
  assert.ok(s.context.renders + s.context.idleRepaints > painted,
    'a write closed its dialog on the strength of this landing: the page must not stay as it was before it');
});

test('after() with no `only` still reloads everything, exactly as it always has', async () => {
  const s = start(answers());
  await s.store.load();
  const before = { ...s.calls };
  await s.store.after(Promise.resolve('saved'));
  await tick();
  for (const name of Object.keys(before)) assert.equal(s.calls[name], before[name] + 1, name + ' reloads too');
});

test('after() ignores an empty or malformed `only` and reloads everything, the same as none at all', async () => {
  const s = start(answers());
  await s.store.load();
  const before = { ...s.calls };
  await s.store.after(Promise.resolve('saved'), { only: [] });
  await tick();
  assert.equal(s.calls.tickets, before.tickets + 1, 'an empty list is not "nothing": it falls back to the whole workspace');
});

test('a part loaded since a mark arrived from a load begun after it — not from one begun before, even one ending after, nor from one that did not bring it back', async () => {
  const s = start(answers());
  await s.store.load();
  const landed = s.store.mark();
  assert.equal(s.store.loadedSince('notes', landed), false, 'the load before a change landed does not hold it, however quickly the change came');
  await s.store.load();
  assert.equal(s.store.loadedSince('notes', landed), true);
  assert.equal(s.store.loadedSince('nothing', landed), false);
  const again = s.store.mark();
  s.answer(answers({ notes: async () => { throw new Error('Could not load notes: Failed to fetch'); } }));
  await s.store.load();
  assert.equal(s.store.loadedSince('notes', again), false, 'notes that did not come back leave a change to one off the page');
  assert.equal(s.store.loadedSince('tickets', again), true);
  const held = deferred();
  const slow = start(answers({ notes: () => held.promise }));
  const running = slow.store.load();
  const during = slow.store.mark();
  held.resolve([]);
  await running;
  assert.equal(slow.store.loadedSince('notes', during), false, 'a load begun before the change landed does not hold it, though its notes arrive after');
});

test('the load after a write puts back what the database has, even where nothing changed there', async () => {
  const s = start(answers());
  await s.store.load();
  s.read('tickets')[0].status = 'Resolved';
  await s.store.after(Promise.resolve('saved'));
  assert.equal(s.read('tickets')[0].status, 'Open', 'an edit only ever made in memory does not survive');
});

test('a quiet refresh with nothing new does not repaint; one with something new waits for drafts', async () => {
  let title = 'Broken login';
  const s = start(answers({ tickets: async () => [ticket({ title })] }));
  await s.store.load();
  const painted = s.context.renders;
  await s.store.load({ quiet: true });
  assert.equal(s.context.renders, painted);
  assert.equal(s.context.idleRepaints, 0);

  title = 'Broken login on Safari';
  await s.store.load({ quiet: true });
  assert.equal(s.context.idleRepaints, 1);
  assert.equal(s.context.renders, painted, 'repaintWhenIdle, never a render over what someone is typing');
});

test('a mailbox that only synced again is not a change worth repainting', async () => {
  let synced = '2026-09-14T09:00:00Z';
  const s = start(answers({ mailboxes: async () => [{ id: 'mb1', status: 'connected', last_synced_at: synced }] }));
  await s.store.load();
  synced = '2026-09-14T09:02:00Z';
  await s.store.load({ quiet: true });
  assert.equal(s.context.idleRepaints, 0);
  assert.equal(s.store.state.mailboxes[0].last_synced_at, synced, 'the new time is there for the next repaint');
});

test('an open conversation keeps its messages through a refresh that did not touch it', async () => {
  let count = 2;
  const s = start(answers({ mailThreads: async () => ({ threads: [thread(count)], truncated: [] }) }));
  await s.store.load();
  assert.equal(s.store.threadBody('th1'), null, 'fetched when first opened');
  await tick();
  assert.equal(s.calls.mailMessages, 1);

  await s.store.load({ quiet: true });
  assert.ok(s.store.threadBody('th1'), 'still there after the refresh');
  assert.equal(s.calls.mailMessages, 1);

  count = 3;
  await s.store.load({ quiet: true });
  assert.equal(s.store.threadBody('th1'), null, 'a new message in it is fetched again');
  await tick();
  assert.equal(s.calls.mailMessages, 2);
});

test('a conversation fetched while a new message arrived is fetched again, not kept half-told', async () => {
  let count = 2;
  let fetches = 0;
  const first = deferred();
  const three = [{ body: 'one', bodyHtml: '' }, { body: 'two', bodyHtml: '' }, { body: 'three', bodyHtml: '' }];
  const s = start(answers({
    mailThreads: async () => ({ threads: [thread(count)], truncated: [] }),
    mailMessages: () => (++fetches === 1 ? first.promise : Promise.resolve(three))
  }));
  await s.store.load();
  assert.equal(s.store.threadBody('th1'), null);
  count = 3;
  await s.store.load({ quiet: true });
  first.resolve([{ body: 'one', bodyHtml: '' }, { body: 'two', bodyHtml: '' }]);
  await tick();
  assert.equal(fetches, 2, 'asked again for the thread as it is now');
  assert.equal(s.store.threadBody('th1').length, 3, 'two messages were never kept for a thread of three');
});

test('activity entries keep who, when and what they are about — thirty of them', async () => {
  let asked = null;
  const s = start(answers({
    activity: async limit => {
      asked = limit;
      return [{ id: 'a1', who: 'Sam Rivera', initial: 'SR', text: 'Opened a ticket', when: 'Today',
                createdAt: '2026-09-14T14:02:00Z', entityType: 'ticket', entityId: 't1' }];
    }
  }));
  await s.store.load();
  const [entry] = s.read('workspaceActivity');
  assert.equal(entry.who, 'Sam Rivera');
  assert.equal(entry.initial, 'SR');
  assert.equal(entry.entityType, 'ticket');
  assert.equal(entry.entityId, 't1');
  assert.equal(asked, 30);
});
