/* The calendar is plain browser script with no build step, so it is loaded
   into a sandbox the way a <script> tag would run it, and driven by a clock
   the test controls. Run from the repo root with: node --test

   Arrays made inside the sandbox have the sandbox's Array.prototype, which
   strict deep-equality rejects — hence the [...spread] before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/calendar.js', import.meta.url), 'utf8');

function load(console = globalThis.console) {
  const context = vm.createContext({ console });
  vm.runInContext(source, context);
  return vm.runInContext('createCalendar', context);
}

/* A clock that can be moved, the way real time moves under an open tab. */
function at(year, month, day, hour = 9) {
  const clock = { now: new Date(year, month - 1, day, hour) };
  const cal = load()(() => new Date(clock.now));
  return { cal, clock };
}

const iso = (y, m, d) => new Date(y, m - 1, d).toISOString();
const key = date => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

test('a weekday shows its own working week with today in it', () => {
  const { cal } = at(2026, 9, 16);
  assert.deepEqual([...cal.dates], [14, 15, 16, 17, 18]);
  assert.equal(cal.today, 16);
  assert.equal(cal.focus, 16);
  assert.equal(cal.isNextWeek, false);
  assert.equal(cal.range(), 'September 14 – 18, 2026');
  assert.equal(cal.todayLong, 'Wednesday, September 16');
});

test('on Sunday, today is Sunday — not the Friday before it', () => {
  const { cal } = at(2026, 9, 13);
  assert.equal(cal.today, 13);
  assert.equal(cal.nameFor(13), 'Sunday');
  assert.equal(cal.label(13), 'September 13');
  assert.equal(cal.full(13), 'September 13, 2026');
  assert.equal(cal.todayLong, 'Sunday, September 13');
});

test('at the weekend the grid shows the week about to start', () => {
  for (const day of [12, 13]) {
    const { cal } = at(2026, 9, day);
    assert.deepEqual([...cal.dates], [14, 15, 16, 17, 18]);
    assert.equal(cal.isNextWeek, true);
    assert.equal(cal.focus, 14, 'Monday is selected, since today is not in the grid');
    assert.equal(cal.inWeek(day), false);
  }
});

test('the load window covers today and the whole week shown', () => {
  const weekend = at(2026, 9, 13).cal;
  assert.equal(weekend.loadFrom, iso(2026, 9, 13));
  assert.equal(weekend.loadTo, iso(2026, 9, 21));

  const weekday = at(2026, 9, 16).cal;
  assert.equal(weekday.loadFrom, iso(2026, 9, 14));
  assert.equal(weekday.loadTo, iso(2026, 9, 21));
});

test('a week that straddles two months names each day by its own month', () => {
  const { cal } = at(2026, 10, 1);
  assert.deepEqual([...cal.dates], [28, 29, 30, 1, 2]);
  assert.equal(cal.range(), 'September 28 – October 2, 2026');
  assert.equal(cal.label(28), 'September 28');
  assert.equal(cal.label(1), 'October 1');
  assert.equal(cal.monthAbbr(28), 'SEP');
  assert.equal(cal.monthAbbr(1), 'OCT');
  assert.equal(cal.monthName, 'October');
  assert.equal(cal.thisMonth, 'October');
});

test('on the last weekend of a month, "this month" is still the current one', () => {
  const { cal } = at(2026, 10, 31);
  assert.equal(cal.thisMonth, 'October');
  assert.equal(cal.monthName, 'November', 'the grid has already moved to Mon Nov 2');
});

test('a week that straddles New Year carries the right year on each day', () => {
  const { cal } = at(2026, 12, 31);
  assert.equal(cal.range(), 'December 28 – January 1, 2027');
  assert.equal(cal.full(28), 'December 28, 2026');
  assert.equal(cal.full(1), 'January 1, 2027');
});

test('the mini month is the real month, not a 30-day September', () => {
  const { cal } = at(2026, 10, 14);
  const month = cal.month();
  assert.equal(month.name, 'October');
  assert.equal(month.year, 2026);
  assert.equal(month.cells.length % 7, 0, 'whole weeks only');
  assert.equal(month.cells.filter(c => c.inMonth).length, 31);
  assert.equal(key(month.cells[0].date), '2026-9-28', 'Oct 1 2026 is a Thursday');
  assert.deepEqual([...month.cells.filter(c => c.inWeek).map(c => c.day)], [12, 13, 14, 15, 16]);
});

test('in a straddling week the days from the other month are still in the grid', () => {
  const { cal } = at(2026, 10, 1);
  const inWeek = cal.month().cells.filter(c => c.inWeek);
  assert.deepEqual([...inWeek.map(c => key(c.date))],
    ['2026-9-28', '2026-9-29', '2026-9-30', '2026-10-1', '2026-10-2']);
  assert.deepEqual([...inWeek.map(c => c.inMonth)], [false, false, false, true, true]);
});

test('refresh is a no-op while the date has not changed', () => {
  const { cal, clock } = at(2026, 9, 16, 9);
  let calls = 0;
  cal.onChange(() => { calls += 1; });
  clock.now = new Date(2026, 8, 16, 23, 59);
  assert.equal(cal.refresh(), false);
  assert.equal(calls, 0);
});

test('refresh moves to the new day after midnight and tells subscribers', () => {
  const { cal, clock } = at(2026, 9, 16, 23);
  const seen = [];
  cal.onChange(next => seen.push(next.today));
  clock.now = new Date(2026, 8, 17, 0, 1);
  assert.equal(cal.refresh(), true);
  assert.equal(cal.today, 17);
  assert.equal(cal.todayLong, 'Thursday, September 17');
  assert.deepEqual(seen, [17]);
});

test('Friday night rolls the grid over to the next week', () => {
  const { cal, clock } = at(2026, 9, 18, 22);
  assert.deepEqual([...cal.dates], [14, 15, 16, 17, 18]);
  clock.now = new Date(2026, 8, 19, 8);
  cal.refresh();
  assert.deepEqual([...cal.dates], [21, 22, 23, 24, 25]);
  assert.equal(cal.isNextWeek, true);
});

test('a subscriber that throws does not stop the others, and can unsubscribe', () => {
  const clock = { now: new Date(2026, 8, 16) };
  const logged = [];
  const cal = load({ error: (...args) => logged.push(args) })(() => new Date(clock.now));

  let reached = 0;
  cal.onChange(() => { throw new Error('boom'); });
  const stop = cal.onChange(() => { reached += 1; });
  clock.now = new Date(2026, 8, 17);
  cal.refresh();
  assert.equal(reached, 1);
  assert.equal(logged.length, 1, 'the failure is logged, not swallowed');

  stop();
  clock.now = new Date(2026, 8, 18);
  cal.refresh();
  assert.equal(reached, 1);
});
