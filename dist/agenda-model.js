/* agenda-model.js — the Agenda's logic, with no page in it.
 *
 * Which week is on screen and where the week buttons take it, which days are
 * drawn, which day each event is on, which events clash, and how kinds and
 * times read. The agenda used to draw one Monday-to-Friday week and find each
 * event by its day of the month: it could not move to another week, loaded
 * weekend events and never showed them, put an all-day event on the day before
 * anywhere west of Greenwich, showed an event over several days on its first
 * day only — and not at all when it began before the week — marked "today" on
 * whichever day was picked, coloured events by their place in a list, and
 * wrote "09:00 –" for an event with no end. Kept apart from workspace.js and
 * app.js so it can be tested without a browser — tests/agenda.test.mjs.
 *
 * A day is known by its date on this clock, "2026-09-14": unlike a day of the
 * month it never means two days, and it sorts and compares as text.
 */
const agendaModel = (function () {
  'use strict';

  const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December']);
  const WEEKDAYS = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  const WORK_DAYS = 5;
  const DAY_MS = 24 * 60 * 60 * 1000;

  /* calendar_events.kind (0026), in the order the key lists them, each with the
     pill colour it is drawn in. Red stays for what needs attention. */
  const KINDS = Object.freeze([
    Object.freeze({ value: 'team', label: 'Team', tone: 'blue' }),
    Object.freeze({ value: 'client', label: 'Client', tone: 'purple' }),
    Object.freeze({ value: 'internal', label: 'Internal', tone: 'green' }),
    Object.freeze({ value: 'personal', label: 'Personal', tone: 'amber' }),
    Object.freeze({ value: 'focus', label: 'Focus time', tone: 'gray' })
  ]);
  /* The column's default, and what a kind the database cannot hold reads as. */
  const DEFAULT_KIND = KINDS[2];

  const text = value => String(value == null ? '' : value);
  const pad = n => String(n).padStart(2, '0');
  const clock = date => pad(date.getHours()) + ':' + pad(date.getMinutes());
  /* Not instanceof, which is false for a Date made in another window or frame. */
  const isDate = value => Object.prototype.toString.call(value) === '[object Date]';
  const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  const weekday = date => (date.getDay() + 6) % 7;                    // 0 = Monday
  const localKey = date => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const utcKey = date => date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
  const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

  /* A day, from a date key or a Date, as its midnight on this clock — or null.
     A key that does not come back as itself was never a date: 2026-02-30 is
     not March 2. */
  function parseDay(value) {
    if (isDate(value)) return Number.isNaN(value.getTime()) ? null : addDays(value, 0);
    const m = DAY.exec(text(value));
    if (!m) return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return localKey(date) === m[0] ? date : null;
  }

  function dayKey(value) {
    const date = parseDay(value);
    return date ? localKey(date) : null;
  }

  /* A day the ways the page names it. */
  function dayNames(value) {
    const date = parseDay(value);
    if (!date) return null;
    const name = WEEKDAYS[weekday(date)];
    const month = MONTHS[date.getMonth()];
    const label = month + ' ' + date.getDate();
    return Object.freeze({
      key: localKey(date),
      weekday: name,
      short: name.slice(0, 3),
      number: date.getDate(),
      monthAbbr: month.slice(0, 3).toUpperCase(),
      label,
      full: label + ', ' + date.getFullYear(),
      weekend: weekday(date) >= WORK_DAYS
    });
  }

  /* ── Weeks ─────────────────────────────────────────────────────────── */

  /* The Monday-to-Sunday week a day is in, known by its Monday. */
  function weekOf(value) {
    const date = parseDay(value);
    if (!date) return null;
    const monday = addDays(date, -weekday(date));
    return Object.freeze({
      key: localKey(monday),
      days: Object.freeze(Array.from({ length: 7 }, (_, i) => localKey(addDays(monday, i))))
    });
  }

  /* The week the agenda opens on: this one, or at the weekend the week about
     to start — the one a person opening it on a Sunday is planning, and the
     one calendar.js opens on. */
  function startWeek(now) {
    const today = parseDay(now);
    if (!today) return null;
    return weekOf(weekday(today) < WORK_DAYS ? today : addDays(today, 7 - weekday(today)));
  }

  /* n weeks on, or back when n is negative. */
  function shiftWeek(week, n) {
    const monday = parseDay(week && week.key);
    return monday ? weekOf(addDays(monday, 7 * Math.trunc(Number(n) || 0))) : null;
  }

  /* "This week", "Next week" or "Last week", counted from the week today is
     in; any other week has no name. */
  function weekName(week, now) {
    const monday = parseDay(week && week.key);
    const current = weekOf(now);
    if (!monday || !current) return '';
    /* Rounded: a week with a clock change in it is an hour long or short. */
    const offset = Math.round((monday - parseDay(current.key)) / (7 * DAY_MS));
    return offset === 0 ? 'This week' : offset === 1 ? 'Next week' : offset === -1 ? 'Last week' : '';
  }

  /* What to load for a week: from its Monday to the next on this clock, and
     `since`, a day before that. The events a week can draw are the ones that
     start before `to` and end after `since` — or, with no end, start at or
     after it. The day's reach is for all-day events, which are dated in UTC:
     in California an all-day Monday starts at 17:00 on Sunday. Anything else
     that brings in is on no day of the week, and is not drawn. */
  function loadRange(week) {
    const monday = parseDay(week && week.key);
    if (!monday) return null;
    return Object.freeze({
      from: monday.toISOString(),
      to: addDays(monday, 7).toISOString(),
      since: new Date(monday.getTime() - DAY_MS).toISOString()
    });
  }

  /* The month around a day — the picked one, else the week's Monday — in whole
     Monday-first weeks, as the mini calendar draws it. Every cell is a date,
     so any of them can be picked, the spill from the months either side too. */
  function month(value, week, now) {
    const focus = parseDay(value) || parseDay(week && week.key) || parseDay(now);
    if (!focus) return null;
    const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
    const length = new Date(focus.getFullYear(), focus.getMonth() + 1, 0).getDate();
    const start = addDays(first, -weekday(first));
    const shown = new Set(week && Array.isArray(week.days) ? week.days : []);
    const today = dayKey(now);
    const cells = Array.from({ length: Math.ceil((weekday(first) + length) / 7) * 7 }, (_, i) => {
      const date = addDays(start, i);
      const key = localKey(date);
      return Object.freeze({
        key,
        number: date.getDate(),
        inMonth: date.getMonth() === focus.getMonth(),
        inWeek: shown.has(key),
        today: key === today
      });
    });
    return Object.freeze({ name: MONTHS[focus.getMonth()], year: focus.getFullYear(), cells: Object.freeze(cells) });
  }

  /* ── Events ────────────────────────────────────────────────────────── */

  /* Events as queries.events() hands them to the store, with the database row
     under `row` — or the row itself. */
  const rowOf = event => (event && event.row) || event || {};
  const idOf = event => {
    const id = event && event.id != null ? event.id : rowOf(event).id;
    return id == null ? null : String(id);
  };
  const titleOf = event => text((event && event.title) || rowOf(event).title);
  const atMidnightUtc = date => date.getUTCHours() === 0 && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;

  /* When an event is: its first and last day, whether it lasts all day, and the
     moments it starts and ends (null for no end) — or null when its start
     cannot be read. An all-day event is a date rather than a moment, and the
     Outlook sync stores one as midnight UTC to the midnight after
     (graph-message.ts). Read in UTC it is on its own date everywhere; read on
     the local clock it began the day before west of Greenwich and ran into the
     day after east of it. An all-day row that is not at midnight UTC was not
     stored as a date, and is read on this clock. The end is exclusive — a
     meeting until midnight is not on the next day — and an end that is not
     after the start is no end. */
  function span(event) {
    const row = rowOf(event);
    const startsAt = Date.parse(row.starts_at);
    if (Number.isNaN(startsAt)) return null;
    const ends = Date.parse(row.ends_at);
    const endsAt = !Number.isNaN(ends) && ends > startsAt ? ends : null;
    const allDay = row.all_day === true;
    const start = new Date(startsAt);
    const keyOf = allDay && atMidnightUtc(start) ? utcKey : localKey;
    const first = keyOf(start);
    return Object.freeze({
      first,
      last: endsAt === null ? first : keyOf(new Date(endsAt - 1)),
      allDay,
      startsAt,
      endsAt
    });
  }

  /* The events that can be drawn: a start that can be read, and not cancelled. */
  const readable = events => (Array.isArray(events) ? events : [])
    .map(event => ({ event, span: span(event) }))
    .filter(x => x.span && rowOf(x.event).status !== 'cancelled');

  /* Which events overlap in time, as id → the ids of the events each clashes
     with, in the order they start. Only events with a time clash: an all-day
     event is a date, not a booking. Back to back is not a clash. An event with
     no end is a moment, clashing with what it starts together with or falls
     inside. Built in place: a studio's week is short, and copying the table for
     every pair would make it long. */
  function clashesAmong(list) {
    const timed = list
      .filter(x => !x.span.allDay && idOf(x.event) !== null)
      .sort((a, b) => a.span.startsAt - b.span.startsAt);
    const found = new Map();
    const note = (id, other) => {
      if (!found.has(id)) found.set(id, []);
      if (!found.get(id).includes(other)) found.get(id).push(other);
    };
    timed.forEach((a, i) => {
      const end = a.span.endsAt === null ? a.span.startsAt : a.span.endsAt;
      for (let j = i + 1; j < timed.length; j += 1) {
        const b = timed[j];
        const together = b.span.startsAt === a.span.startsAt;
        /* Sorted by start: once one begins after a has ended, so do the rest. */
        if (!together && b.span.startsAt >= end) break;
        if (idOf(a.event) !== idOf(b.event)) {
          note(idOf(a.event), idOf(b.event));
          note(idOf(b.event), idOf(a.event));
        }
      }
    });
    return Object.freeze(Object.fromEntries([...found].map(([id, others]) => [id, Object.freeze(others)])));
  }

  const clashes = events => clashesAmong(readable(events));

  /* An event's kind, from its row — or from the label queries.js made of it.
     The database holds only the five (0026); anything else reads as its
     default. */
  function kindOf(event) {
    const given = text(rowOf(event).kind || (event && event.type)).trim().toLowerCase();
    return KINDS.find(k => k.value === given || k.label.toLowerCase() === given) || DEFAULT_KIND;
  }

  /* Which part of an event a day has — all of it, its first day, a day in the
     middle, or its last — or null. */
  function partOn(when, key) {
    if (key < when.first || key > when.last) return null;
    if (when.first === when.last) return 'whole';
    return key === when.first ? 'first' : key === when.last ? 'last' : 'middle';
  }

  /* Where a day begins and where it ends on this clock, as moments — or null
     for a key that is not a date. Usually midnight to midnight, but a clock
     change makes a day 23 or 25 hours long, and in some zones moves midnight
     itself: in Santiago, September 6, 2026 begins at 01:00. */
  function dayBounds(key) {
    const day = parseDay(key);
    return day ? Object.freeze({ from: day.getTime(), to: addDays(day, 1).getTime() }) : null;
  }

  /* Whether an event fills a day — `bounds`, from dayBounds() — from the moment
     the day begins to the moment the next one does. */
  const fills = (when, bounds) => bounds !== null && when.startsAt === bounds.from && when.endsAt === bounds.to;

  /* An event's time on one of its days, the day `bounds` are of. One that runs
     to the end of its last day reads "Until 24:00" there: its end is the moment
     the next day begins, and "Until 00:00" read as the midnight that day began
     with. One that fills the one day it is on reads "All day", as a day in the
     middle of a longer one does: "00:00 – 00:00" read as no time at all. */
  function timeOn(when, part, bounds) {
    if (when.allDay || part === 'middle' || fills(when, bounds)) return 'All day';
    const start = clock(new Date(when.startsAt));
    if (part === 'first') return 'From ' + start;
    if (part === 'last') return 'Until ' + (when.endsAt === bounds.to ? '24:00' : clock(new Date(when.endsAt)));
    return when.endsAt === null ? start : start + ' – ' + clock(new Date(when.endsAt));
  }

  /* The part of an event a day has: from its start or the day's, whichever is
     later, to its end or the day's, whichever is earlier. A moment stays one. */
  function clip(when, bounds) {
    return Object.freeze(Object.assign({}, when, {
      startsAt: Math.max(when.startsAt, bounds.from),
      endsAt: when.endsAt === null ? null : Math.min(when.endsAt, bounds.to)
    }));
  }

  /* One day's events in the order the day has them: what lasts all day, then
     by start — one carried over from the night before starts at midnight —
     the shorter first, then by title. A clash is marked on the day it happens:
     each event is cut to the part of it the day has, and those parts are
     compared by clashesAmong()'s rules. A workshop from Monday to Wednesday
     that met a review on Wednesday was marked as clashing on Monday and
     Tuesday too. */
  function placeOn(list, key) {
    const bounds = dayBounds(key);
    const onDay = list
      .map(x => ({ x, part: partOn(x.span, key) }))
      .filter(p => p.part);
    const clashing = clashesAmong(onDay.map(({ x }) => ({ event: x.event, span: clip(x.span, bounds) })));
    const titles = new Map(list.map(x => [idOf(x.event), titleOf(x.event)]));
    const clashesOf = id => (id !== null && Object.prototype.hasOwnProperty.call(clashing, id) ? clashing[id] : []);
    return onDay
      .map(({ x, part }) => {
        const when = x.span;
        const allDay = when.allDay || part === 'middle';
        const others = clashesOf(idOf(x.event));
        return {
          rank: allDay ? 0 : 1,
          from: part === 'last' ? bounds.from : when.startsAt,
          until: when.endsAt === null ? when.startsAt : when.endsAt,
          placed: Object.freeze({
            id: idOf(x.event),
            title: titleOf(x.event),
            event: x.event,
            kind: kindOf(x.event),
            part,
            allDay,
            tentative: rowOf(x.event).status === 'tentative',
            time: timeOn(when, part, bounds),
            clash: others.length > 0,
            clashesWith: Object.freeze(others.map(id => titles.get(id) || ''))
          })
        };
      })
      .sort((a, b) => a.rank - b.rank || a.from - b.from || a.until - b.until
        || a.placed.title.localeCompare(b.placed.title))
      .map(p => p.placed);
  }

  /* The days a week draws, each with its events. Monday to Friday always, and
     the weekend when something is on it, when today is, or when it is the day
     picked — Saturday and Sunday together, so a Sunday never follows a gap.
     `selected` is the picked day when it is drawn, else today when that is,
     else Monday; `today` is today whichever day is picked. They used to be one
     flag, so picking Thursday moved "today" to Thursday. The week is one
     weekOf() makes: one whose days are not seven date keys draws no days. */
  function weekDays(events, week, options) {
    const o = options || {};
    const isKey = value => typeof value === 'string' && dayKey(value) === value;
    if (!week || !Array.isArray(week.days) || week.days.length !== 7 || !week.days.every(isKey)) return Object.freeze([]);
    const today = dayKey(o.now);
    const picked = dayKey(o.selected);
    const list = readable(events);
    const placed = week.days.map(key => ({ key, events: placeOn(list, key) }));
    const weekend = placed.slice(WORK_DAYS)
      .some(d => d.events.length > 0 || d.key === today || d.key === picked);
    const drawn = weekend ? placed : placed.slice(0, WORK_DAYS);
    const isDrawn = key => key !== null && drawn.some(d => d.key === key);
    const selected = isDrawn(picked) ? picked : isDrawn(today) ? today : drawn[0].key;
    return Object.freeze(drawn.map(d => Object.freeze(Object.assign({}, dayNames(d.key), {
      today: d.key === today,
      selected: d.key === selected,
      events: Object.freeze(d.events)
    }))));
  }

  /* One day's events, placed the way the week places them: for the Overview's
     "Today's agenda", its tile and the bell. */
  function eventsOn(events, day) {
    const key = dayKey(day);
    if (!key) return Object.freeze([]);
    return Object.freeze(placeOn(readable(events), key));
  }

  /* ── Labels ────────────────────────────────────────────────────────── */

  /* The dates a run of days covers — "September 14 – 18, 2026", "September 28
     – October 2, 2026", "December 28, 2026 – January 3, 2027" — from day keys
     or the days weekDays() draws. withYear false leaves the year off. */
  function rangeLabel(days, withYear) {
    const keys = (Array.isArray(days) ? days : []).map(d => (d && typeof d === 'object' ? d.key : d));
    const a = parseDay(keys[0]);
    const b = parseDay(keys[keys.length - 1]);
    if (!a || !b) return '';
    const year = withYear !== false;
    const sameYear = a.getFullYear() === b.getFullYear();
    const head = MONTHS[a.getMonth()] + ' ' + a.getDate();
    const tail = year ? ', ' + b.getFullYear() : '';
    if (localKey(a) === localKey(b)) return head + tail;
    const middle = (year && !sameYear ? ', ' + a.getFullYear() : '') + ' – '
      + (sameYear && a.getMonth() === b.getMonth() ? '' : MONTHS[b.getMonth()] + ' ') + b.getDate();
    return head + middle + tail;
  }

  /* An event's date: its day, or the days it runs over — or '' for a day with
     no date key, as one before the year 1000 or after 9999 has none. */
  function dateLabel(event) {
    const when = span(event);
    if (!when) return '';
    if (when.first !== when.last) return rangeLabel([when.first, when.last]);
    const names = dayNames(when.first);
    return names ? names.weekday + ', ' + names.full : '';
  }

  /* An event's time in one line, whichever day it is read on: "09:00 – 10:30",
     "09:00" for one with no end, "All day" — for a timed event that fills its
     one day too, as timeOn() reads it — and for a timed event over several days
     the dates as well: "Sep 14, 22:00 – Sep 15, 02:00". */
  function timeLabel(event) {
    const when = span(event);
    if (!when) return '';
    if (when.allDay || fills(when, dayBounds(when.first))) return 'All day';
    const start = new Date(when.startsAt);
    if (when.endsAt === null) return clock(start);
    const end = new Date(when.endsAt);
    if (when.first === when.last) return clock(start) + ' – ' + clock(end);
    const dated = date => MONTHS[date.getMonth()].slice(0, 3) + ' ' + date.getDate() + ', ' + clock(date);
    return dated(start) + ' – ' + dated(end);
  }

  return Object.freeze({
    KINDS,
    dayKey, parseDay, dayNames,
    weekOf, startWeek, shiftWeek, weekName, loadRange, month,
    span, weekDays, eventsOn, clashes, kindOf,
    rangeLabel, dateLabel, timeLabel
  });
})();
