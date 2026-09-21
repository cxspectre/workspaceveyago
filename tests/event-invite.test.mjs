/* What an event's page can say and do about a recurring series, a reminder, a
   time zone and an invitation (0068), as dist/event-invite.js draws it.

   The zone block is the one that matters, and it is the reason this file runs
   in Amsterdam: the honest answer depends on where the reader is, and a test
   that could not tell two zones apart would pass on the dishonest version too.

   Loaded into a sandbox the way <script> tags run it. The page's helpers are
   stand-ins that keep what they are given, so what is tested is what
   event-invite.js hands them. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'Europe/Amsterdam';

/* 16 September 2026, 13:00 UTC — 15:00 in Amsterdam, 09:00 in New York. */
const STARTS = '2026-09-16T13:00:00.000Z';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* A synced invitation waiting for an answer — the ordinary case every test
   below is a departure from. `row` is what queries.js's EVENT_LIST_COLUMNS
   brings back for one event. */
function event(over = {}) {
  const row = {
    id: 'ev-1', title: 'Northline weekly', detail: null, location: null,
    starts_at: STARTS, ends_at: '2026-09-16T13:30:00.000Z', all_day: false,
    kind: 'client', status: 'confirmed', connection_id: 'conn-1', created_by: null,
    recurrence_type: 'singleInstance', series_master_id: null, recurrence_summary: null,
    reminder_on: false, reminder_minutes: null,
    time_zone: null, time_zone_iana: null,
    response_status: 'notResponded', is_organizer: false,
    ...over
  };
  return { id: row.id, title: row.title, row };
}

function load({ loaded = true, canChange = true, respond = null, events = null } = {}) {
  const modals = [];
  const toasts = [];
  const replies = [];
  const button = { disabled: false };
  const error = { textContent: '', id: 'agenda-reply-form-error' };
  const listeners = {};
  const handlers = {};
  const focused = [];
  const form = {
    isConnected: true,
    fields: {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
    querySelector: selector => (selector === '.form-error' ? error : selector === '.form-candidates' ? null : button)
  };
  const known = events || [event()];
  const context = vm.createContext({
    console,
    toast: message => toasts.push(message),
    modal: { open: false, close() { this.open = false; } },
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); context.modal.open = true; },
    workspaceSession: { employee: { id: 'e-me' }, isManager: () => false },
    workspaceStore: {
      state: { loaded },
      eventById: id => known.find(e => e.id === id) || null,
      mark: () => 1,
      loadedSince: () => true,
      after: (work, options) => Promise.resolve(work).then(
        value => value,
        err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; })
    },
    workspaceActions: {
      respondToEvent: async (id, response, options) => {
        replies.push([id, response, { ...options }]);
        if (respond) return respond(id, response, options);
        return { ok: true, response, scope: options.scope, updated: 1 };
      }
    },
    agendaUi: {
      canChange: () => canChange,
      partsOf: e => (e && e.row && e.row.project_id ? ['events', 'projectEvents'] : ['events'])
    },
    FormData: class {
      constructor(f) { this.f = f; }
      get(name) { return Object.prototype.hasOwnProperty.call(this.f.fields || {}, name) ? this.f.fields[name] : ''; }
    },
    document: {
      activeElement: null,
      body: {},
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: () => form,
      querySelector: selector => {
        focused.push(selector);
        return null;
      }
    }
  });
  context.window = context;
  /* esc() the way a browser really has it: app.js declares it as a top-level
     `const`, which is a global LEXICAL binding and NOT a property of window.
     Handing it in as a context property instead would make `window.esc` truthy
     in here and nowhere else — and would quietly pass a version of
     event-invite.js that guarded on it and so never escaped anything. */
  vm.runInContext(
    "const esc = s => String(s ?? '').replace(/[&<>\"']/g, c => "
    + "({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));",
    context);
  vm.runInContext(readFileSync(new URL('../dist/dialog-forms.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../dist/event-invite.js', import.meta.url), 'utf8'), context);
  return {
    invite: context.eventInvite,
    /* Out of the sandbox's own realm, whose prototypes strict deep-equality
       rejects — the same copy actions.test.mjs makes for the same reason. */
    properties: e => [...context.eventInvite.properties(e)].map(row => [...row]),
    click: node => (listeners.click || []).forEach(fn => fn({ target: node, preventDefault() {} })),
    submit: async () => { handlers.submit({ preventDefault() {} }); await settle(); },
    type: fields => { form.fields = fields; },
    windowEsc: context.esc,
    modals, toasts, replies, button, error, focused
  };
}

/* A reply button as the panel draws it: two data attributes on one node. */
function replyTarget(id, answer) {
  const node = { dataset: { agendaReply: id, agendaAnswer: answer } };
  return { closest: selector => (selector === '[data-agenda-reply]' ? node : null) };
}

/* ── Is it one of a series? ───────────────────────────────────────────── */

test('everything but a single instance is one of a series', () => {
  const { invite } = load();
  for (const recurrence_type of ['occurrence', 'exception', 'seriesMaster']) {
    assert.equal(invite.repeats(event({ recurrence_type })), true, recurrence_type);
  }
  assert.equal(invite.repeats(event({ recurrence_type: 'singleInstance' })), false);
});

test('a row from before 0068, or one that never loaded the column, does not claim to repeat', () => {
  const { invite } = load();
  assert.equal(invite.repeats(event({ recurrence_type: undefined })), false);
  assert.equal(invite.repeats(event({ recurrence_type: null })), false);
  assert.equal(invite.repeats(null), false);
});

test('how often it comes round is the words the sync read off the series master', () => {
  const { invite } = load();
  assert.equal(
    invite.repeatNote(event({ recurrence_type: 'occurrence', recurrence_summary: 'Every 2 weeks on Monday and Thursday' })),
    'Every 2 weeks on Monday and Thursday');
});

test('a series whose pattern could not be read still says it repeats', () => {
  const { invite } = load();
  assert.equal(invite.repeatNote(event({ recurrence_type: 'occurrence', recurrence_summary: null })), 'Repeats');
  assert.equal(invite.repeatNote(event()), null, 'a one-off says nothing at all');
});

/* ── Reminders ────────────────────────────────────────────────────────── */

test('a reminder reads in the largest unit that is exact', () => {
  const { invite } = load();
  const at = minutes => invite.reminderNote(event({ reminder_on: true, reminder_minutes: minutes }));
  assert.equal(at(0), 'When it starts', '"at the time of the event" is a setting, not an absence');
  assert.equal(at(1), '1 minute before');
  assert.equal(at(15), '15 minutes before');
  assert.equal(at(60), '1 hour before');
  assert.equal(at(120), '2 hours before');
  assert.equal(at(1440), '1 day before');
  assert.equal(at(2880), '2 days before');
});

test('a reminder that does not divide evenly keeps its minutes rather than rounding into a lie', () => {
  const { invite } = load();
  assert.equal(invite.reminderNote(event({ reminder_on: true, reminder_minutes: 90 })), '90 minutes before');
});

test('a reminder switched on with no minutes says only that it is on', () => {
  const { invite } = load();
  assert.equal(invite.reminderNote(event({ reminder_on: true, reminder_minutes: null })), 'On');
});

test('no reminder is left unsaid, not printed as "None"', () => {
  const { invite } = load();
  assert.equal(invite.reminderNote(event()), null);
  assert.equal(invite.reminderNote(event({ reminder_on: false, reminder_minutes: 15 })), null);
});

/* ── Time zones, honestly ─────────────────────────────────────────────── */

test('an event booked in the reader’s own zone is named and left there', () => {
  const { invite } = load();
  assert.equal(
    invite.zoneNote(event({ time_zone: 'W. Europe Standard Time', time_zone_iana: 'Europe/Amsterdam' })),
    'Europe/Amsterdam');
});

test('an event booked elsewhere is converted, in both directions, from a zone Intl can take', () => {
  const { invite } = load();
  assert.equal(
    invite.zoneNote(event({ time_zone: 'Eastern Standard Time', time_zone_iana: 'America/New_York' })),
    'America/New_York · 09:00 there, 15:00 here');
});

test('a Windows name nobody mapped is printed as it is, and says plainly that it was not converted', () => {
  /* The point of the whole feature. 0068 leaves time_zone_iana null rather
     than guessing, and a page that quietly converted through a guess would be
     an hour out — which is the bug _shared/graph-message.ts refuses to risk
     for a start time. */
  const { invite } = load();
  assert.equal(
    invite.zoneNote(event({ time_zone: 'Kamchatka Standard Time', time_zone_iana: null })),
    'Kamchatka Standard Time · times here are in your own time zone');
});

test('a zone whose clocks happen to agree with yours today says so rather than repeating a time twice', () => {
  const { invite } = load();
  assert.equal(
    invite.zoneNote(event({ time_zone_iana: 'Europe/Paris' })),
    'Europe/Paris · the same clock time as yours');
});

test('an all-day event has no clock time to compare, so its zone is only named', () => {
  const { invite } = load();
  assert.equal(
    invite.zoneNote(event({ all_day: true, time_zone: 'Eastern Standard Time', time_zone_iana: 'America/New_York' })),
    'Eastern Standard Time');
});

test('an event with no zone at all — every hand-made one — says nothing', () => {
  const { invite } = load();
  assert.equal(invite.zoneNote(event()), null);
});

/* ── How this calendar answered ───────────────────────────────────────── */

test('the four answers a calendar owner can be in read in plain words', () => {
  const { invite } = load();
  const reply = response_status => invite.replyNote(event({ response_status }));
  assert.equal(reply('accepted'), 'You accepted');
  assert.equal(reply('tentativelyAccepted'), 'You said maybe');
  assert.equal(reply('declined'), 'You declined');
  assert.equal(reply('notResponded'), 'You have not replied yet');
});

test('an event nobody was invited to, and one you called yourself, are not answers', () => {
  const { invite } = load();
  assert.equal(invite.replyNote(event({ response_status: 'none' })), null);
  assert.equal(invite.replyNote(event({ response_status: 'organizer' })), null);
});

/* ── The property rows ────────────────────────────────────────────────── */

test('the page gains only the rows it has something true to put in', () => {
  const h = load();
  assert.deepEqual(h.properties(event()).map(r => r[0]), ['Your reply'],
    'an ordinary synced invitation with no series, reminder or zone');
  assert.deepEqual(h.properties(event({ response_status: 'none' })), [],
    'a hand-made event gains nothing at all rather than four empty rows');
});

test('all four rows, in the order they read best', () => {
  const h = load();
  const rows = h.properties(event({
    recurrence_type: 'occurrence', recurrence_summary: 'Every week on Monday',
    reminder_on: true, reminder_minutes: 15,
    time_zone: 'W. Europe Standard Time', time_zone_iana: 'Europe/Amsterdam',
    response_status: 'accepted'
  }));
  assert.deepEqual(rows, [
    ['Repeats', 'Every week on Monday'],
    ['Reminder', '15 minutes before'],
    ['Booked in', 'Europe/Amsterdam'],
    ['Your reply', 'You accepted']
  ]);
});

test('whatever Graph sent is escaped before it reaches the page — with esc() where a browser really keeps it', () => {
  /* See load(): esc is a global lexical binding here, exactly as app.js leaves
     it, so `window.esc` is undefined. Anything that reached for it through
     window would stop escaping in production while passing in a sandbox that
     had been kinder about where it put things. */
  const h = load();
  assert.equal(h.windowEsc, undefined, 'the sandbox is as unkind as a browser');
  const rows = h.properties(event({
    recurrence_type: 'occurrence', recurrence_summary: '<img src=x onerror=alert(1)>',
    time_zone: '<script>', time_zone_iana: null
  }));
  assert.equal(rows[0][1], escape('<img src=x onerror=alert(1)>'));
  assert.ok(!rows.some(r => String(r[1]).includes('<script>')));
});

/* ── Who may answer ───────────────────────────────────────────────────── */

test('a synced invitation in a calendar this session may act on can be answered', () => {
  const { invite } = load();
  assert.equal(invite.canReply(event()), true);
  assert.equal(invite.canReply(event({ response_status: 'accepted' })), true, 'changing your mind is still answering');
});

test('there is nothing to answer on a hand-made event, one nobody was invited to, or one you called', () => {
  const { invite } = load();
  assert.equal(invite.canReply(event({ connection_id: null })), false);
  assert.equal(invite.canReply(event({ response_status: 'none' })), false);
  assert.equal(invite.canReply(event({ response_status: 'organizer', is_organizer: true })), false);
  assert.equal(invite.canReply(event({ is_organizer: true })), false);
});

test('a cancelled meeting, and a row that never loaded the columns, offer nothing', () => {
  const { invite } = load();
  assert.equal(invite.canReply(event({ status: 'cancelled' })), false);
  assert.equal(invite.canReply(event({ is_organizer: undefined })), false,
    'a row missing the column guesses nothing');
  assert.equal(invite.canReply(event({ response_status: undefined })), false);
});

test('a calendar this session may not act on offers nothing — the same line the backend draws', () => {
  const { invite } = load({ canChange: false });
  assert.equal(invite.canReply(event()), false);
});

/* ── The panel ────────────────────────────────────────────────────────── */

test('three buttons, with the answer already given shown as the one in effect', () => {
  const { invite } = load();
  const html = invite.panel(event({ response_status: 'accepted' }));
  assert.match(html, /data-agenda-answer="accepted" aria-pressed="true"/);
  assert.match(html, /data-agenda-answer="declined" aria-pressed="false"/);
  assert.match(html, /data-agenda-answer="tentativelyAccepted" aria-pressed="false"/);
  assert.match(html, /You accepted/);
});

test('a series says so on the panel, so nobody has to guess what Accept would cover', () => {
  const { invite } = load();
  assert.match(invite.panel(event({ recurrence_type: 'occurrence' })), /one of a series/i);
  assert.ok(!/one of a series/i.test(invite.panel(event())));
});

test('nothing at all when there is no invitation to answer', () => {
  const { invite } = load();
  assert.equal(invite.panel(event({ connection_id: null })), '');
});

/* ── Answering it ─────────────────────────────────────────────────────── */

test('a reply asks first, and sends what the dialog was filled in with', async () => {
  const h = load();
  h.click(replyTarget('ev-1', 'accepted'));
  assert.equal(h.modals.length, 1);
  assert.match(h.modals[0].body, /Accept Northline weekly\?/);
  h.type({ comment: '  Can we start at ten?  ' });
  await h.submit();
  assert.deepEqual(h.replies, [['ev-1', 'accepted', { scope: 'occurrence', comment: 'Can we start at ten?' }]]);
  assert.deepEqual(h.toasts, ['Accepted. The organiser has been told.']);
});

test('a one-off is never offered a series choice it cannot make', () => {
  const h = load();
  h.click(replyTarget('ev-1', 'declined'));
  assert.ok(!h.modals[0].body.includes('name="scope"'));
});

test('one of a series can be answered for every one of them', async () => {
  const h = load({ events: [event({ recurrence_type: 'occurrence', series_master_id: 'master-1' })] });
  h.click(replyTarget('ev-1', 'tentativelyAccepted'));
  assert.match(h.modals[0].body, /name="scope"/);
  assert.match(h.modals[0].body, /Every one in the series/);
  h.type({ scope: 'series' });
  await h.submit();
  assert.deepEqual(h.replies[0][2], { scope: 'series', comment: '' });
  assert.deepEqual(h.toasts, ['Marked as maybe. The organiser has been told.']);
});

test('a scope nobody offered falls back to this date rather than answering for the series', async () => {
  const h = load({ events: [event({ recurrence_type: 'occurrence', series_master_id: 'master-1' })] });
  h.click(replyTarget('ev-1', 'accepted'));
  h.type({ scope: 'everything, obviously' });
  await h.submit();
  assert.equal(h.replies[0][2].scope, 'occurrence');
});

test('declining says that the meeting leaves the calendar, because in Outlook it does', async () => {
  const h = load();
  h.click(replyTarget('ev-1', 'declined'));
  await h.submit();
  assert.deepEqual(h.toasts, ['Declined. It leaves the calendar it came from.']);
});

test('a refusal is said on the dialog, and the buttons come back', async () => {
  const h = load({ respond: async () => { throw new Error('This meeting was cancelled in the calendar.'); } });
  h.click(replyTarget('ev-1', 'accepted'));
  await h.submit();
  await settle();
  assert.match(h.error.textContent, /cancelled in the calendar/);
  assert.equal(h.button.disabled, false);
  assert.deepEqual(h.toasts, [], 'said once, on the dialog, not twice');
});

test('nothing is sent before the workspace has loaded', () => {
  const h = load({ loaded: false });
  h.click(replyTarget('ev-1', 'accepted'));
  assert.deepEqual(h.modals, []);
  assert.deepEqual(h.toasts, ['Not yet: the workspace is still loading.']);
});

test('an event the page no longer has is said, not answered', () => {
  const h = load();
  h.click(replyTarget('ev-gone', 'accepted'));
  assert.deepEqual(h.modals, []);
  assert.match(h.toasts[0], /not loaded any more/);
});

test('an invitation this session may not answer is refused before a round trip', () => {
  const h = load({ canChange: false });
  h.click(replyTarget('ev-1', 'accepted'));
  assert.deepEqual(h.modals, []);
  assert.deepEqual(h.toasts, ['This invitation cannot be answered here.']);
});

test('an answer nobody offers does nothing at all', () => {
  const h = load();
  h.click(replyTarget('ev-1', 'organizer'));
  assert.deepEqual(h.modals, []);
  assert.deepEqual(h.toasts, []);
});

test('a change to the same event still on its way holds the reply back', async () => {
  /* A real one, not a stand-in: the first reply is sent and never answered, so
     dialog-forms.js still has the event's record settling when the second
     click arrives. Edit and Remove hold on the same key, so the three cannot
     overtake each other on one event. */
  const h = load({ respond: () => new Promise(() => {}) });
  h.click(replyTarget('ev-1', 'accepted'));
  await h.submit();
  h.click(replyTarget('ev-1', 'declined'));
  assert.equal(h.modals.length, 1, 'no second dialog');
  assert.equal(h.replies.length, 1, 'and no second reply sent');
  assert.match(h.toasts[0], /still on its way/);
});

test('a row synced before 0068 carries an IANA name in time_zone alone, and it is used rather than apologised for', () => {
  const { invite } = load();
  assert.equal(invite.zoneNote(event({ time_zone: 'Europe/Amsterdam', time_zone_iana: null })), 'Europe/Amsterdam');
  assert.equal(invite.zoneNote(event({ time_zone: 'America/New_York', time_zone_iana: null })),
    'America/New_York · 09:00 there, 15:00 here');
});
