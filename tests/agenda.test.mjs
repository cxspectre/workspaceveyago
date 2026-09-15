/* The Agenda's logic, without a page: which week is on screen and where the
   week buttons take it, which days are drawn, which day each event is on,
   which events clash, and how kinds and times read. Loaded into a sandbox the
   way <script> tags run it, with the time zone moved the way
   calendar.test.mjs moves it. Run from the repo root with: node --test

   Arrays and objects made inside the sandbox have the sandbox's prototypes,
   which strict deep-equality rejects — hence the [...spread] before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console });
vm.runInContext(readFileSync(new URL('../dist/agenda-model.js', import.meta.url), 'utf8'), context);
const model = vm.runInContext('agendaModel', context);

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

/* A moment in September 2026 on this clock. */
const at = (day, hour = 0, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
/* What queries.events() hands the store: the calendar_events row under `row`. */
const event = (id, startsAt, endsAt = null, over = {}) => ({
  id,
  title: over.title || id,
  row: { id, title: over.title || id, starts_at: startsAt, ends_at: endsAt, all_day: false, kind: 'team', status: 'confirmed', ...over }
});
/* An all-day event the way the Outlook sync stores one: midnight UTC to the
   midnight after its last day, as PostgREST writes a timestamptz. */
const allDay = (id, first, afterLast, over = {}) =>
  event(id, `${first}T00:00:00+00:00`, afterLast ? `${afterLast}T00:00:00+00:00` : null, { all_day: true, ...over });

const ids = placed => [...placed].map(p => p.id);
const drawnIds = days => [...days].flatMap(d => ids(d.events));
const WEEK = '2026-09-16';                                   // Wednesday; the week is Sep 14 – 20
const WEDNESDAY = () => new Date(2026, 8, 16, 9);

/* What queries.events() is to ask for a week (see loadRange): events that
   start before the week ends and end after `since` — or, with no end, start
   at or after it. */
const asked = (row, range) => Date.parse(row.starts_at) < Date.parse(range.to)
  && (row.ends_at
    ? Date.parse(row.ends_at) > Date.parse(range.since)
    : Date.parse(row.starts_at) >= Date.parse(range.since));

/* ── Weeks ───────────────────────────────────────────────────────────── */

test('a week is Monday to Sunday, found by date from any day in it', () => {
  const week = model.weekOf(WEEK);
  assert.equal(week.key, '2026-09-14');
  assert.deepEqual([...week.days],
    ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
  assert.equal(model.weekOf('2026-09-20').key, '2026-09-14', 'Sunday closes a week, it does not open the next');
  assert.equal(model.weekOf(new Date(2026, 8, 21, 23, 30)).key, '2026-09-21');
  assert.deepEqual([...model.weekOf('2026-10-01').days].slice(0, 5),
    ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],
    'a week across two months has each day by its date, where day numbers made the 28th and the 1st look alike');
  for (const bad of ['2026-02-30', 'next week', '', null, undefined, new Date('nonsense')]) {
    assert.equal(model.weekOf(bad), null, String(bad));
  }
});

test('the agenda opens on this week, or at the weekend on the week about to start', () => {
  assert.equal(model.startWeek(WEDNESDAY()).key, '2026-09-14');
  assert.equal(model.startWeek(new Date(2026, 8, 18, 23, 59)).key, '2026-09-14', 'Friday night is still this week');
  assert.equal(model.startWeek(new Date(2026, 8, 19, 8)).key, '2026-09-21');
  assert.equal(model.startWeek(new Date(2026, 8, 20, 22)).key, '2026-09-21');
  assert.equal(model.startWeek('soon'), null);
});

test('previous and next move a week at a time, across months and into the new year', () => {
  const week = model.weekOf(WEEK);
  assert.equal(model.shiftWeek(week, 1).key, '2026-09-21');
  assert.equal(model.shiftWeek(week, -1).key, '2026-09-07');
  assert.equal(model.shiftWeek(week, 3).key, '2026-10-05');
  assert.equal(model.shiftWeek(week, 0).key, '2026-09-14');
  assert.equal(model.shiftWeek(model.weekOf('2026-12-30'), 1).key, '2027-01-04');
  assert.equal(model.shiftWeek(null, 1), null);
});

test('a week is named from the week today is in', () => {
  const now = WEDNESDAY();
  assert.equal(model.weekName(model.weekOf('2026-09-14'), now), 'This week');
  assert.equal(model.weekName(model.weekOf('2026-09-21'), now), 'Next week');
  assert.equal(model.weekName(model.weekOf('2026-09-07'), now), 'Last week');
  assert.equal(model.weekName(model.weekOf('2026-10-05'), now), '');
  const sunday = new Date(2026, 8, 20, 18);
  assert.equal(model.weekName(model.startWeek(sunday), sunday), 'Next week', 'opened on a Sunday, the agenda says which week it shows');
});

test('a week is loaded from its Monday to the next on this clock, reaching a day further back', () => {
  inZone('America/Los_Angeles', () => {
    const range = model.loadRange(model.weekOf(WEEK));
    assert.equal(range.from, new Date(2026, 8, 14).toISOString());
    assert.equal(range.to, new Date(2026, 8, 21).toISOString());
    assert.equal(range.since, new Date(Date.parse(range.from) - 86400000).toISOString());

    const monday = allDay('monday', '2026-09-14', null);
    assert.deepEqual(ids(model.eventsOn([monday], '2026-09-14')), ['monday']);
    assert.ok(Date.parse(monday.row.starts_at) < Date.parse(range.from),
      'an all-day Monday with no end starts at 17:00 on Sunday in California');
    assert.ok(asked(monday.row, range), 'and is still asked for');
  });
  assert.equal(model.loadRange(null), null);
});

test('everything a week draws is inside what it asks the database for, in every time zone', () => {
  for (const zone of ['Pacific/Pago_Pago', 'America/Los_Angeles', 'UTC', 'Europe/Berlin', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
    inZone(zone, () => {
      const week = model.weekOf(WEEK);
      const range = model.loadRange(week);
      const rows = [event('long', at(1, 9), at(30, 17))];
      for (let day = 10; day <= 24; day += 1) {
        const date = `2026-09-${String(day).padStart(2, '0')}`;
        const after = `2026-09-${String(day + 1).padStart(2, '0')}`;
        rows.push(allDay(`all-${day}`, date, after), allDay(`open-all-${day}`, date, null));
        for (const [hour, minute] of [[0, 0], [0, 30], [12, 0], [23, 30]]) {
          rows.push(event(`timed-${day}-${hour}-${minute}`, at(day, hour, minute), at(day, hour + 1, minute)));
          rows.push(event(`open-${day}-${hour}-${minute}`, at(day, hour, minute)));
        }
      }
      const drawn = new Set([...week.days].flatMap(key => ids(model.eventsOn(rows, key))));
      assert.equal(drawn.size, 72,
        `${zone}: its 14 all-day rows and 56 timed ones, Sunday night's meeting into Monday, and the long one — nothing from the days either side`);
      for (const id of drawn) {
        assert.ok(asked(rows.find(r => r.id === id).row, range), `${zone}: ${id} is drawn, so it has to be loaded`);
      }
    });
  }
});

/* ── Which days are drawn ────────────────────────────────────────────── */

test('Monday to Friday are always drawn, and the weekend when something is on it', () => {
  const week = model.weekOf(WEEK);
  const now = WEDNESDAY();
  assert.deepEqual([...model.weekDays([], week, { now })].map(d => d.key),
    ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
  assert.equal(model.weekDays([event('sat', at(19, 10), at(19, 12))], week, { now }).length, 7,
    'weekend events used to load and never show');
  const sunday = model.weekDays([event('sun', at(20, 10))], week, { now });
  assert.deepEqual([...sunday].slice(5).map(d => [d.key, d.weekend, d.events.length]),
    [['2026-09-19', true, 0], ['2026-09-20', true, 1]], 'Saturday is drawn too, rather than a gap before Sunday');
});

test('the weekend is drawn when today or the picked day is on it', () => {
  const week = model.weekOf(WEEK);
  const saturday = model.weekDays([], week, { now: new Date(2026, 8, 19, 9) });
  assert.equal(saturday.length, 7, 'today is never left out of its own week');
  assert.equal(saturday[5].today, true);
  assert.equal(saturday[5].selected, true);
  const picked = model.weekDays([], week, { now: WEDNESDAY(), selected: '2026-09-20' });
  assert.equal(picked.length, 7);
  assert.equal(picked[6].selected, true);
});

test('today stays today, whichever day is picked', () => {
  const week = model.weekOf(WEEK);
  const now = WEDNESDAY();
  const flags = days => [...days].map(d => (d.today ? 'T' : '-') + (d.selected ? 'S' : '-'));
  assert.deepEqual(flags(model.weekDays([], week, { now, selected: '2026-09-17' })), ['--', '--', 'T-', '-S', '--'],
    'picking Thursday used to move the "today" circle to Thursday');
  assert.deepEqual(flags(model.weekDays([], week, { now })), ['--', '--', 'TS', '--', '--'], 'nothing picked: today');
  assert.deepEqual(flags(model.weekDays([], week, { now, selected: '2026-10-01' })), ['--', '--', 'TS', '--', '--'],
    'a day of another week is not picked in this one');
  const next = model.shiftWeek(week, 1);
  assert.deepEqual(flags(model.weekDays([], next, { now })), ['-S', '--', '--', '--', '--'], 'a week without today opens on Monday');
  assert.deepEqual(flags(model.weekDays([], next, { now, selected: new Date(2026, 8, 23, 15) })), ['--', '--', '-S', '--', '--']);
});

/* ── Which day an event is on ────────────────────────────────────────── */

test('an event is on the day it starts, by date — never on another month\'s day with the same number', () => {
  const events = [
    event('standup', at(14, 9, 30), at(14, 9, 45)),
    event('october', new Date(2026, 9, 14, 9).toISOString(), new Date(2026, 9, 14, 10).toISOString())
  ];
  const days = model.weekDays(events, model.weekOf(WEEK), { now: WEDNESDAY() });
  assert.deepEqual(ids(days[0].events), ['standup']);
  assert.deepEqual(drawnIds(days), ['standup'], 'October 14 is not September 14');
});

test('a day\'s events are in time order, with what lasts all day first', () => {
  const events = [
    event('late', at(15, 16), at(15, 17)),
    event('early', at(15, 9), at(15, 10)),
    allDay('offsite', '2026-09-15', '2026-09-16'),
    event('overnight', at(14, 22), at(15, 2)),
    event('short', at(15, 9), at(15, 9, 30))
  ];
  const tuesday = model.weekDays(events, model.weekOf(WEEK), { now: WEDNESDAY() })[1];
  assert.deepEqual(ids(tuesday.events), ['offsite', 'overnight', 'short', 'early', 'late']);
  assert.deepEqual([...tuesday.events].map(p => p.time), ['All day', 'Until 02:00', '09:00 – 09:30', '09:00 – 10:00', '16:00 – 17:00']);
});

test('an all-day event is on its own date, wherever the browser is', () => {
  const friday = allDay('launch', '2026-09-18', '2026-09-19');
  for (const zone of ['America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo']) {
    inZone(zone, () => {
      const days = model.weekDays([friday], model.weekOf(WEEK), { now: WEDNESDAY() });
      assert.deepEqual([...days].map(d => d.events.length), [0, 0, 0, 0, 1],
        `${zone}: on the local clock it began the evening before west of Greenwich, and ran into Saturday east of it`);
      assert.equal(days[4].events[0].time, 'All day');
      assert.equal(days[4].events[0].allDay, true);
    });
  }
});

test('an all-day row not at midnight UTC was not stored as a date, and is read on this clock', () => {
  inZone('Europe/Berlin', () => {
    const local = event('holiday', new Date(2026, 8, 17).toISOString(), new Date(2026, 8, 18).toISOString(), { all_day: true });
    const days = model.weekDays([local], model.weekOf(WEEK), { now: WEDNESDAY() });
    assert.deepEqual([...days].map(d => d.events.length), [0, 0, 0, 1, 0]);
  });
});

test('an event over several days is on each of them, even one that began before the week', () => {
  const trip = allDay('trip', '2026-09-16', '2026-09-19');
  const conference = event('conference', at(10, 9), at(15, 17));
  const days = model.weekDays([trip, conference], model.weekOf(WEEK), { now: WEDNESDAY() });
  assert.deepEqual([...days].map(d => [...d.events].map(p => `${p.id} ${p.part} ${p.time}`)), [
    ['conference middle All day'],
    ['conference last Until 17:00'],
    ['trip first All day'],
    ['trip middle All day'],
    ['trip last All day']
  ], 'a conference from last Thursday used to be dropped, and a trip shown on Wednesday alone');
  assert.equal(days[0].events[0].allDay, true, 'a day in the middle of a timed event lasts all day');
});

test('a meeting past midnight is on both days; one that ends at midnight is not on the next', () => {
  const week = model.weekOf(WEEK);
  const times = days => [...days].slice(0, 2).map(d => [...d.events].map(p => p.time));
  assert.deepEqual(times(model.weekDays([event('late', at(14, 22), at(15, 2))], week, { now: WEDNESDAY() })),
    [['From 22:00'], ['Until 02:00']]);
  assert.deepEqual(times(model.weekDays([event('midnight', at(14, 22), at(15, 0))], week, { now: WEDNESDAY() })),
    [['22:00 – 00:00'], []]);
});

test('a timed event over the whole of its one day reads all day, not "00:00 – 00:00"', () => {
  for (const zone of ['Europe/Berlin', 'America/Los_Angeles']) {
    inZone(zone, () => {
      const offsite = event('offsite', at(16, 0), at(17, 0));
      assert.deepEqual([...model.eventsOn([offsite], '2026-09-16')].map(p => `${p.part} ${p.time}`), ['whole All day'],
        `${zone}: from midnight to midnight read as no time at all`);
      assert.deepEqual([...model.eventsOn([offsite], '2026-09-17')], [], 'and it is not on the day after');
      assert.equal(model.timeLabel(offsite), 'All day', 'nor in one line');
      const read = (from, to) => [model.eventsOn([event('x', from, to)], '2026-09-16')[0].time, model.timeLabel(event('x', from, to))];
      assert.deepEqual(read(at(16, 22), at(17, 0)), ['22:00 – 00:00', '22:00 – 00:00'], 'part of a day reads as its times');
      assert.deepEqual(read(at(16, 0, 30), at(17, 0)), ['00:30 – 00:00', '00:30 – 00:00']);
      assert.deepEqual(read(at(16, 0), at(16, 23)), ['00:00 – 23:00', '00:00 – 23:00']);
    });
  }
  /* The whole day on the clock, however long a clock change makes it. */
  inZone('America/Santiago', () => {                          // Sunday September 6, 2026 begins at 01:00
    const sunday = event('sunday', new Date(2026, 8, 6).toISOString(), new Date(2026, 8, 7).toISOString());
    assert.deepEqual([model.eventsOn([sunday], '2026-09-06')[0].time, model.timeLabel(sunday)], ['All day', 'All day'],
      'not "01:00 – 00:00"');
  });
  inZone('Europe/Berlin', () => {                             // Sunday October 25 is 25 hours long
    const sunday = event('sunday', new Date(2026, 9, 25).toISOString(), new Date(2026, 9, 26).toISOString());
    assert.deepEqual([model.eventsOn([sunday], '2026-10-25')[0].time, model.timeLabel(sunday)], ['All day', 'All day']);
  });
  const booked = model.eventsOn([event('offsite', at(16, 0), at(17, 0)), event('review', at(16, 10), at(16, 11))], '2026-09-16');
  assert.deepEqual([...booked].map(p => [p.id, p.clash]), [['offsite', true], ['review', true]],
    'it is still a booking, not a date: unlike an all-day event it clashes');
});

test('the last day of an event that ends at midnight reads until the end of that day, not "Until 00:00"', () => {
  for (const zone of ['Europe/Berlin', 'America/Los_Angeles']) {
    inZone(zone, () => {
      const days = model.weekDays([event('night shift', at(14, 22), at(16, 0))], model.weekOf(WEEK), { now: WEDNESDAY() });
      assert.deepEqual([...days].slice(0, 3).map(d => [...d.events].map(p => `${p.part} ${p.time}`)),
        [['first From 22:00'], ['last Until 24:00'], []],
        `${zone}: on Tuesday, "Until 00:00" read as the midnight Tuesday began with`);
    });
  }
  /* In Santiago the clocks go forward at midnight: Sunday September 6, 2026
     begins at 01:00, and that is where Saturday ends. */
  inZone('America/Santiago', () => {
    const vigil = event('vigil', new Date(2026, 8, 4, 20).toISOString(), new Date(2026, 8, 6).toISOString());
    assert.deepEqual([...model.eventsOn([vigil], '2026-09-05')].map(p => `${p.part} ${p.time}`), ['last Until 24:00'],
      'not "Until 01:00", an hour into Saturday');
    assert.deepEqual([...model.eventsOn([vigil], '2026-09-06')], []);
  });
});

test('an event that cannot be read, or was cancelled, is left off rather than put on today', () => {
  const week = model.weekOf(WEEK);
  const events = [
    event('no start', null), event('garbage', 'soon'), null, {},
    event('cancelled', at(16, 10), at(16, 11), { status: 'cancelled' }),
    event('backwards', at(16, 12), at(16, 11)),
    event('maybe', at(16, 14), at(16, 15), { status: 'tentative' })
  ];
  const days = model.weekDays(events, week, { now: WEDNESDAY() });
  assert.deepEqual(drawnIds(days), ['backwards', 'maybe']);
  assert.equal(days[2].events[0].time, '12:00', 'an end before the start is no end');
  assert.deepEqual([...days[2].events].map(p => p.tentative), [false, true]);
  assert.deepEqual([...model.weekDays(null, week, { now: WEDNESDAY() })].map(d => d.events.length), [0, 0, 0, 0, 0]);
  assert.deepEqual([...model.weekDays([], null, { now: WEDNESDAY() })], []);
});

test('a week whose days are not date keys draws no days, rather than failing', () => {
  const now = WEDNESDAY();
  const events = [event('a', at(16, 9), at(16, 10))];
  const days = [...model.weekOf(WEEK).days];
  for (const bad of [['a', 'b', 'c', 'd', 'e', 'f', 'g'], [...days.slice(0, 6), 'soon'], [...days.slice(0, 6), '2026-02-30'],
    [...days.slice(0, 6), null], [...days.slice(0, 6), new Date(2026, 8, 20)]]) {
    const drawn = model.weekDays(events, { key: 'x', days: bad }, { now });
    assert.deepEqual([...drawn], [], String(bad));
    assert.ok(Object.isFrozen(drawn));
  }
  assert.equal(model.weekDays(events, { key: 'x', days }, { now }).length, 5, 'the same week, with its days as keys, is drawn');
});

test('one day\'s events, for the Overview and the bell, are placed the way the week places them', () => {
  const events = [
    event('into today', at(15, 23), at(16, 1)),
    event('today', at(16, 9), at(16, 10)),
    event('tomorrow', at(17, 9), at(17, 10)),
    allDay('all today', '2026-09-16', '2026-09-17')
  ];
  assert.deepEqual(ids(model.eventsOn(events, new Date(2026, 8, 16, 18))), ['all today', 'into today', 'today']);
  assert.deepEqual(ids(model.eventsOn(events, '2026-09-17')), ['tomorrow']);
  assert.deepEqual([...model.eventsOn(events, 'not a day')], []);
});

/* ── Clashes ─────────────────────────────────────────────────────────── */

const plainClashes = found => Object.fromEntries(Object.entries(found).map(([id, others]) => [id, [...others].sort()]));

test('events that overlap clash; back to back they do not', () => {
  const events = [
    event('a', at(16, 9), at(16, 10)),
    event('b', at(16, 9, 30), at(16, 10, 30)),
    event('right after b', at(16, 10, 30), at(16, 11)),
    event('as a starts', at(16, 9)),
    event('lunch', at(16, 12), at(16, 13)),
    event('in lunch', at(16, 12, 15)),
    event('as lunch ends', at(16, 13))
  ];
  assert.deepEqual(plainClashes(model.clashes(events)), {
    a: ['as a starts', 'b'],
    b: ['a'],
    'as a starts': ['a'],
    lunch: ['in lunch'],
    'in lunch': ['lunch']
  }, 'an event with no end is a moment: it clashes with what it starts with or falls inside');
});

test('an all-day event clashes with nothing, a timed one over several days does, and nothing clashes with itself', () => {
  const events = [
    allDay('offsite', '2026-09-16', '2026-09-17'),
    event('workshop', at(15, 9), at(17, 17)),
    event('review', at(16, 10), at(16, 11)),
    event('review', at(16, 10), at(16, 11))
  ];
  assert.deepEqual(plainClashes(model.clashes(events)), { workshop: ['review'], review: ['workshop'] });
  assert.deepEqual({ ...model.clashes(null) }, {});
});

test('a clash is marked on both events, where the week draws them', () => {
  const events = [
    event('review', at(16, 14), at(16, 15), { title: 'Design review' }),
    event('call', at(16, 14, 30), at(16, 15), { title: 'Client call' }),
    event('free', at(16, 16), at(16, 17)),
    event('gone', at(16, 14), at(16, 15), { status: 'cancelled' })
  ];
  const wednesday = model.weekDays(events, model.weekOf(WEEK), { now: WEDNESDAY() })[2];
  assert.deepEqual([...wednesday.events].map(p => [p.id, p.clash, [...p.clashesWith]]), [
    ['review', true, ['Client call']],
    ['call', true, ['Design review']],
    ['free', false, []]
  ], 'a cancelled event clashes with nothing');
  assert.equal(model.eventsOn(events, '2026-09-16')[0].clash, true);
});

test('a clash is marked on the day it happens, not on every day of an event over several', () => {
  for (const zone of ['Europe/Berlin', 'America/Los_Angeles', 'Pacific/Auckland']) {
    inZone(zone, () => {
      const events = [
        event('workshop', at(14, 9), at(16, 17), { title: 'Workshop' }),
        event('review', at(16, 10), at(16, 11), { title: 'Design review' })
      ];
      const days = model.weekDays(events, model.weekOf(WEEK), { now: WEDNESDAY() });
      assert.deepEqual([...days].slice(0, 3).map(d => [...d.events].map(p => [p.id, p.part, p.clash, [...p.clashesWith]])), [
        [['workshop', 'first', false, []]],
        [['workshop', 'middle', false, []]],
        [['workshop', 'last', true, ['Design review']], ['review', 'whole', true, ['Workshop']]]
      ], `${zone}: the review is on Wednesday — Monday and Tuesday used to be marked as clashing with it too`);
      assert.equal(model.eventsOn(events, '2026-09-15')[0].clash, false, 'and so did Tuesday on the Overview');
      assert.deepEqual(plainClashes(model.clashes(events)), { workshop: ['review'], review: ['workshop'] },
        'clashes() still lists every clash an event has, whichever day');
    });
  }
});

test('each day compares only the part of an event it has, by the rules the whole week uses', () => {
  const events = [
    event('late', at(14, 22), at(15, 2)),
    event('call', at(14, 23), at(14, 23, 30)),
    event('early', at(15, 0), at(15, 1)),
    event('ping', at(15, 1, 30)),
    event('after', at(15, 2), at(15, 3)),
    event('till midnight', at(15, 23), at(16, 0)),
    event('at midnight', at(16, 0))
  ];
  const days = model.weekDays(events, model.weekOf(WEEK), { now: WEDNESDAY() });
  const marks = day => [...day.events].map(p => [p.id, [...p.clashesWith].sort()]);
  assert.deepEqual(marks(days[0]), [['late', ['call']], ['call', ['late']]], 'Monday: the call, not what Tuesday has');
  assert.deepEqual(marks(days[1]), [
    ['early', ['late']],
    ['late', ['early', 'ping']],
    ['ping', ['late']],
    ['after', []],
    ['till midnight', []]
  ], 'Tuesday: cut at midnight, last night\'s meeting still meets what starts with the day and what falls inside it; back to back is still no clash');
  assert.deepEqual(marks(days[2]), [['at midnight', []]], 'an event that ends at midnight is not on the next day, so it clashes with nothing there');
});

/* ── Kinds and times ─────────────────────────────────────────────────── */

test('the key lists the five kinds an event can have, each with its own label and colour', () => {
  assert.deepEqual([...model.KINDS].map(k => k.value), ['team', 'client', 'internal', 'personal', 'focus'],
    'calendar_events.kind (0026) — the key used to offer "Products", which is none of them');
  assert.deepEqual([...model.KINDS].map(k => k.label), ['Team', 'Client', 'Internal', 'Personal', 'Focus time']);
  assert.equal(new Set([...model.KINDS].map(k => k.tone)).size, 5, 'no two kinds share a colour');
});

test('an event\'s kind is its row\'s, and anything else reads as internal, the column default', () => {
  const kind = over => model.kindOf(event('x', at(16, 9), null, over));
  assert.equal(kind({ kind: 'client' }).label, 'Client');
  assert.equal(kind({ kind: 'focus' }).tone, model.KINDS[4].tone);
  assert.equal(model.eventsOn([event('x', at(16, 9), null, { kind: 'personal' })], '2026-09-16')[0].kind.value, 'personal');
  assert.equal(model.kindOf({ id: 'x', type: 'Focus' }).value, 'focus', 'the label queries.js makes of it is understood too');
  assert.equal(kind({ kind: 'product' }).value, 'internal');
  assert.equal(model.kindOf(null).value, 'internal');
});

test('an event\'s time reads whole, with no dangling dash when it has no end', () => {
  assert.equal(model.timeLabel(event('x', at(16, 9), at(16, 10, 30))), '09:00 – 10:30');
  assert.equal(model.timeLabel(event('x', at(16, 9))), '09:00', 'it used to read "09:00 –"');
  assert.equal(model.timeLabel(event('x', at(16, 9), at(16, 9))), '09:00', 'an end at the start is no end');
  assert.equal(model.timeLabel(allDay('x', '2026-09-16', '2026-09-17')), 'All day');
  assert.equal(model.timeLabel(allDay('x', '2026-09-16', '2026-09-19')), 'All day');
  assert.equal(model.timeLabel(event('x', at(14, 22), at(15, 2))), 'Sep 14, 22:00 – Sep 15, 02:00');
  assert.equal(model.timeLabel(event('x', null)), '');
  const longAgo = event('x', '0999-06-01T10:00:00Z', '0999-06-01T11:00:00Z');
  inZone('Europe/Berlin', () => assert.match(model.timeLabel(longAgo), /^\d\d:\d\d – \d\d:\d\d$/,
    'a day with no date key, in a year before 1000, has no bounds to fill'));
});

test('an event\'s date is its day, or the days it runs over', () => {
  assert.equal(model.dateLabel(event('x', at(16, 9), at(16, 10))), 'Wednesday, September 16, 2026');
  assert.equal(model.dateLabel(allDay('x', '2026-09-16', '2026-09-19')), 'September 16 – 18, 2026');
  assert.equal(model.dateLabel(allDay('x', '2026-09-30', '2026-10-03')), 'September 30 – October 2, 2026');
  assert.equal(model.dateLabel(allDay('x', '2026-12-31', '2027-01-03')), 'December 31, 2026 – January 2, 2027');
  assert.equal(model.dateLabel(event('x', 'soon')), '');
  assert.equal(inZone('Europe/Berlin', () => model.dateLabel(event('x', '0999-06-01T10:00:00Z', '0999-06-01T11:00:00Z'))), '',
    'a day in a year before 1000 has no name, and says so rather than failing');
});

test('the toolbar names the days drawn, with the year on both sides only when they cross into a new one', () => {
  const week = model.weekOf(WEEK);
  assert.equal(model.rangeLabel(model.weekDays([], week, { now: WEDNESDAY() })), 'September 14 – 18, 2026');
  assert.equal(model.rangeLabel(week.days), 'September 14 – 20, 2026');
  assert.equal(model.rangeLabel(week.days, false), 'September 14 – 20');
  assert.equal(model.rangeLabel(model.weekOf('2026-10-01').days.slice(0, 5)), 'September 28 – October 2, 2026');
  assert.equal(model.rangeLabel(model.weekOf('2026-12-31').days), 'December 28, 2026 – January 3, 2027');
  assert.equal(model.rangeLabel(['2026-09-16']), 'September 16, 2026');
  assert.equal(model.rangeLabel([]), '');
});

test('a day is named the ways the page names it', () => {
  assert.deepEqual({ ...model.dayNames('2026-09-20') }, {
    key: '2026-09-20', weekday: 'Sunday', short: 'Sun', number: 20, monthAbbr: 'SEP',
    label: 'September 20', full: 'September 20, 2026', weekend: true
  });
  assert.equal(model.dayNames(new Date(2026, 9, 1, 15)).label, 'October 1');
  assert.equal(model.dayKey(new Date(2026, 9, 1, 23, 59)), '2026-10-01');
  assert.equal(model.dayNames('2026-02-30'), null);
});

test('the mini month is the month around the picked day, marking the week on screen and today', () => {
  const now = WEDNESDAY();
  const week = model.weekOf('2026-10-01');
  const month = model.month('2026-10-01', week, now);
  assert.equal(month.name, 'October');
  assert.equal(month.year, 2026);
  assert.equal(month.cells.length % 7, 0, 'whole weeks only');
  assert.equal(month.cells[0].key, '2026-09-28', 'Oct 1 2026 is a Thursday');
  assert.equal([...month.cells].filter(c => c.inMonth).length, 31);
  assert.deepEqual([...month.cells].filter(c => c.inWeek).map(c => c.key), [...week.days],
    'the week on screen, not the week calendar.js opened on');
  assert.deepEqual([...month.cells].filter(c => c.today).map(c => c.key), [], 'today is in September');
  const september = model.month(null, model.weekOf(WEEK), now);
  assert.equal(september.name, 'September', 'with no day picked, the month of the week\'s Monday');
  assert.deepEqual([...september.cells].filter(c => c.today).map(c => [c.key, c.number]), [['2026-09-16', 16]]);
});

/* ── Clocks ──────────────────────────────────────────────────────────── */

test('a week keeps its seven days across a clock change, and so does what it loads', () => {
  inZone('Europe/Berlin', () => {
    const week = model.weekOf('2026-10-21');                 // the clocks go back on Sunday October 25
    assert.deepEqual([...week.days],
      ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    assert.equal(model.shiftWeek(week, 1).key, '2026-10-26');
    assert.equal(model.loadRange(week).to, new Date(2026, 9, 26).toISOString());
    assert.deepEqual(ids(model.eventsOn([event('late', new Date(2026, 9, 25, 23, 30).toISOString())], '2026-10-25')), ['late']);
  });
});

test('every day is in exactly one week, and next week starts the day after, two years round', () => {
  const dayAfter = key => {
    const [y, m, d] = key.split('-').map(Number);
    return model.dayKey(new Date(y, m - 1, d + 1));
  };
  for (const zone of ['Europe/Berlin', 'America/Santiago']) {
    inZone(zone, () => {
      for (let i = 0; i < 731; i += 1) {
        const date = new Date(2026, 0, 1 + i, 12);
        const week = model.weekOf(date);
        assert.equal(week.days.length, 7);
        assert.ok(week.days.includes(model.dayKey(date)), `${zone}: ${model.dayKey(date)}`);
        assert.equal(model.dayNames(week.key).weekday, 'Monday');
        assert.equal(model.shiftWeek(week, 1).key, dayAfter(week.days[6]), `${zone}: the week after ${week.key}`);
      }
    });
  }
});

test('what the model hands back cannot be changed by a view', () => {
  const week = model.weekOf(WEEK);
  const days = model.weekDays([event('a', at(16, 9), at(16, 10))], week, { now: WEDNESDAY() });
  const placed = days[2].events[0];
  for (const value of [model.KINDS, model.KINDS[0], week, week.days, model.loadRange(week), days, days[2],
    days[2].events, placed, placed.clashesWith, model.clashes([]), model.month(WEEK, week, WEDNESDAY()),
    model.month(WEEK, week, WEDNESDAY()).cells, model.dayNames(WEEK), model.eventsOn([], WEEK)]) {
    assert.ok(Object.isFrozen(value));
  }
});
