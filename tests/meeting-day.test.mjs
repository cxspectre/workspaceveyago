/* The day a meeting is on, as queries.js writes it for a page: an all-day
   meeting is its date wherever the viewer is, and one from another year says
   which — never "Yesterday" with a year after it. In New York, on a clock the
   test sets: New Year's Day 2027, 10:00. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'America/New_York';

const NOW = Date.UTC(2027, 0, 1, 15, 0, 0);
const CO = 'b1000000-0000-4000-8000-000000000001';

/* queries.js on a client whose every request answers with `rows`. */
function load(rows) {
  const client = {
    from() {
      const builder = new Proxy({}, { get: (_, method) => (method === 'then' ? resolve => resolve({ data: rows, error: null }) : () => builder) });
      return builder;
    }
  };
  const context = vm.createContext({ console, Intl, window: { workspaceSession: { client } } });
  vm.runInContext(`const RealDate = Date; var __now = ${NOW};
    Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [__now])); } static now() { return __now; } };`, context);
  vm.runInContext(readFileSync(new URL('../dist/data/queries.js', import.meta.url), 'utf8'), context);
  return context.window.workspaceData;
}

test('an all-day meeting is its date wherever the viewer is, and one from another year says which, never "Yesterday"', async () => {
  const data = load([
    { id: 'e1', title: 'Offsite', starts_at: '2026-12-31T00:00:00Z', ends_at: '2027-01-01T00:00:00Z', all_day: true, kind: 'client', status: 'confirmed' },
    { id: 'e2', title: 'Wrap-up', starts_at: '2026-12-31T15:00:00Z', ends_at: null, all_day: false, kind: 'client', status: 'confirmed' },
    { id: 'e3', title: 'Plan', starts_at: '2027-01-01T13:00:00Z', ends_at: null, all_day: false, kind: 'client', status: 'confirmed' }
  ]);
  const { meetings } = await data.pastMeetings({ companyId: CO, before: '2027-01-02T00:00:00Z' });
  const when = id => meetings.find(meeting => meeting.id === id).when;
  assert.equal(when('e1'), 'Dec 31, 2026', 'not Dec 30, the evening before in New York');
  assert.equal(when('e2'), 'Dec 31, 2026 · 10:00', 'another year says which — and yesterday was another year');
  assert.equal(when('e3'), 'Today · 08:00');
});
