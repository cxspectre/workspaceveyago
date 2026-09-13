/* calendar.js — what day it is, for everything on the page that shows a date.
 *
 * The agenda first shipped hardcoded to one September week. The fix for that
 * worked the week out once, at page load, and was still wrong twice over: at
 * the weekend "today" was the Friday before, and a tab left open overnight
 * stayed on yesterday — for a workspace people keep open all week, that is the
 * usual case rather than the edge one.
 *
 * Now the week is a snapshot of one clock reading, replaced whenever the date
 * changes. Views read CAL.today, CAL.dates … as they always have; the getters
 * hand back whichever snapshot is current. Anything that has to act on a new
 * day — repaint, re-select, reload the week's events — subscribes with
 * CAL.onChange.
 *
 * Day-of-month numbers stay the key the views use for events. They are unique
 * inside the window a snapshot covers (at most nine days in a row), which is
 * why that window is bounded, and why anything crossing a month boundary —
 * the mini month, labels — works from Date objects instead.
 */
function createCalendar(clock) {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const WORK_DAYS = 5;
  const DAY_MS = 86400000;

  const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  const weekday = date => (date.getDay() + 6) % 7;                    // 0 = Monday
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  function snapshot(now) {
    const today = addDays(now, 0);
    const dow = weekday(today);
    const weekend = dow >= WORK_DAYS;
    /* A Mon–Fri grid has no Saturday or Sunday to put "today" in. Showing the
       week just gone made the agenda say Friday on a Sunday; the week about to
       start is the one a person opening it at the weekend is planning. */
    const monday = addDays(today, weekend ? 7 - dow : -dow);
    const days = Array.from({ length: WORK_DAYS }, (_, i) => addDays(monday, i));
    /* Events load from today — so a weekend's own events still reach the
       overview — through the Sunday that closes the week on screen. */
    const from = weekend ? today : monday;
    const to = addDays(monday, 7);
    const length = Math.round((to - from) / DAY_MS);                  // DST-safe
    return Object.freeze({
      today, weekend, from, to,
      days: Object.freeze(days),
      dates: Object.freeze(days.map(d => d.getDate())),
      focus: weekend ? days[0] : today,
      covered: Object.freeze(Array.from({ length }, (_, i) => addDays(from, i)))
    });
  }

  let snap = snapshot(clock());
  let listeners = [];

  const find = n => snap.covered.find(d => d.getDate() === n) || null;
  /* A number outside the window has no month of its own; the week's is the
     best guess, and the one the old hardcoded labels would have used. */
  const monthOf = n => find(n) || snap.focus;
  const nameFor = n => { const d = find(n); return d ? WEEKDAYS[weekday(d)] : ''; };
  const label = n => MONTHS[monthOf(n).getMonth()] + ' ' + n;
  const full = n => label(n) + ', ' + monthOf(n).getFullYear();
  const monthAbbr = n => MONTHS[monthOf(n).getMonth()].slice(0, 3).toUpperCase();

  /* A week can straddle two months — "September 28 – October 2, 2026". */
  function range(withYear) {
    const a = snap.days[0];
    const b = snap.days[WORK_DAYS - 1];
    const head = MONTHS[a.getMonth()] + ' ' + a.getDate();
    const tail = (a.getMonth() === b.getMonth() ? '' : MONTHS[b.getMonth()] + ' ') + b.getDate();
    return head + ' – ' + tail + (withYear === false ? '' : ', ' + b.getFullYear());
  }

  /* The month around the focused day, in whole Monday-first weeks. The spill
     from the months either side is included, so every day of a week that
     straddles a month boundary can still be picked. */
  function month() {
    const focus = snap.focus;
    const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
    const daysInMonth = new Date(focus.getFullYear(), focus.getMonth() + 1, 0).getDate();
    const rows = Math.ceil((weekday(first) + daysInMonth) / 7);
    const start = addDays(first, -weekday(first));
    const cells = Array.from({ length: rows * 7 }, (_, i) => {
      const date = addDays(start, i);
      return Object.freeze({
        date,
        day: date.getDate(),
        inMonth: date.getMonth() === focus.getMonth(),
        inWeek: snap.days.some(d => sameDay(d, date))
      });
    });
    return Object.freeze({ name: MONTHS[focus.getMonth()], year: focus.getFullYear(), cells: Object.freeze(cells) });
  }

  /* Re-reads the clock. Returns whether the date moved, and only then tells
     subscribers — a check every minute must not re-render every minute. */
  function refresh() {
    const next = snapshot(clock());
    if (sameDay(next.today, snap.today)) return false;
    snap = next;
    listeners.forEach(fn => {
      try {
        fn(api);
      } catch (err) {
        console.error('[calendar] a date-change handler failed:', err);
      }
    });
    return true;
  }

  function onChange(fn) {
    listeners = listeners.concat(fn);
    return () => { listeners = listeners.filter(l => l !== fn); };
  }

  const pad = n => String(n).padStart(2, '0');
  /* A date as a form can carry it and a person can read it — "2026-09-18" in
     local time. Not toISOString(), which is UTC and shifts the day for anyone
     east of Greenwich before 1 a.m. and west of it after 11 p.m. */
  const dayKey = date => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const parseDayKey = text => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text == null ? '' : String(text));
    if (!m) return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    /* new Date(2026, 1, 30) quietly becomes March 2; a key that does not
       survive the round trip was never a real date. */
    return dayKey(date) === m[0] ? date : null;
  };
  /* Whether an instant falls inside the loaded window — from inclusive, to
     exclusive, the same bounds the events query uses. */
  const contains = instant => {
    const t = new Date(instant).getTime();
    return !isNaN(t) && t >= snap.from.getTime() && t < snap.to.getTime();
  };

  const api = {
    dayKey, parseDayKey, contains,
    names: Object.freeze(WEEKDAYS.slice(0, WORK_DAYS)),
    short: Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
    get days() { return snap.days; },
    get dates() { return snap.dates; },
    get today() { return snap.today.getDate(); },
    /* The day the agenda opens on: today, or Monday when today is not in the grid. */
    get focus() { return snap.focus.getDate(); },
    get isNextWeek() { return snap.weekend; },
    get todayLong() { return WEEKDAYS[weekday(snap.today)] + ', ' + label(snap.today.getDate()); },
    get monthName() { return MONTHS[snap.focus.getMonth()]; },
    get year() { return snap.focus.getFullYear(); },
    /* The calendar month right now — not the grid's, which at the end of a
       month can already be the next one. */
    get thisMonth() { return MONTHS[snap.today.getMonth()]; },
    get loadFrom() { return snap.from.toISOString(); },
    get loadTo() { return snap.to.toISOString(); },
    inWeek: n => snap.dates.indexOf(n) !== -1,
    indexOf: n => snap.dates.indexOf(n),
    nameFor, label, full, monthAbbr, range, month, refresh, onChange
  };
  return api;
}

const CAL = createCalendar(() => new Date());

/* Nothing re-renders the page on its own, so something has to notice the date
   change. A minute is the most a visible tab can be stale by. A hidden tab's
   timers are throttled and a sleeping laptop runs none at all, so coming back
   to the page checks straight away instead of waiting for the next tick. */
if (typeof document !== 'undefined') {
  const RECHECK_MS = 60 * 1000;
  const recheck = () => { CAL.refresh(); };
  setInterval(recheck, RECHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheck();
  });
  window.addEventListener('focus', recheck);
  window.addEventListener('pageshow', recheck);
}
