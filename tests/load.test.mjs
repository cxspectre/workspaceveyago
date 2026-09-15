/* Loading the workspace, without a page: a request that never answers, what
   the notice says when part of the workspace did not load, and when to look
   again. Loaded into a sandbox the way <script> tags run it.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../dist/data/load-model.js', import.meta.url), 'utf8'), context);
const model = vm.runInContext('loadModel', context);

const at = (hour, minute) => new Date(2026, 8, 14, hour, minute);

/* ── A request that never answers ─────────────────────────────────────── */

test('a request that answers in time is its answer', async () => {
  assert.equal(await model.withTimeout(Promise.resolve('rows'), 50, 'tickets'), 'rows');
});

test('a request that fails in time keeps its own failure', async () => {
  await assert.rejects(
    model.withTimeout(Promise.reject(new Error('Could not load tickets: offline')), 50, 'tickets'),
    { message: 'Could not load tickets: offline' });
});

test('a request that never answers gives up, and says what it was loading', async () => {
  await assert.rejects(model.withTimeout(new Promise(() => {}), 20, 'tickets'),
    { message: 'Loading tickets took too long.' });
});

/* ── What the notice says ─────────────────────────────────────────────── */

test('names read as a sentence', () => {
  assert.equal(model.joinNames([]), '');
  assert.equal(model.joinNames(['tickets']), 'tickets');
  assert.equal(model.joinNames(['tickets', 'mail']), 'tickets and mail');
  assert.equal(model.joinNames(['tickets', 'mail', 'the agenda']), 'tickets, mail and the agenda');
});

test('nothing failed, nothing to say', () => {
  assert.equal(model.loadNotice({ missing: [], stale: [], total: 12, everLoaded: true }), null);
  assert.equal(model.loadNotice({ missing: [], stale: [], total: 12, everLoaded: false }), null);
});

test('a first load where everything failed blocks the workspace rather than showing it empty', () => {
  const names = Array.from({ length: 12 }, (_, i) => `section ${i}`);
  const notice = model.loadNotice({ missing: names, stale: [], total: 12, everLoaded: false, coreMissing: ['tickets'] });
  assert.equal(notice.kind, 'blocked');
  assert.equal(notice.text, 'Check your connection, then try again.');
});

test('a first load missing a part the workspace stands on blocks, and names it', () => {
  const notice = model.loadNotice({ missing: ['contacts', 'mail'], stale: [], total: 12, everLoaded: false, coreMissing: ['contacts'] });
  assert.equal(notice.kind, 'blocked');
  assert.equal(notice.text, 'Could not load contacts. Check your connection, then try again.');
});

test('a part that never loaded is named, and the rest of the workspace carries on', () => {
  const notice = model.loadNotice({ missing: ['invoices', 'mail'], stale: [], total: 12, everLoaded: false, coreMissing: [] });
  assert.equal(notice.kind, 'partial');
  assert.equal(notice.text, 'Could not load invoices and mail.');
});

test('a refresh that failed says how old what is on screen is', () => {
  const notice = model.loadNotice({ missing: [], stale: ['tickets'], total: 12, everLoaded: true, staleSince: at(9, 5) });
  assert.equal(notice.kind, 'stale');
  assert.equal(notice.text, 'Could not refresh tickets — showing what loaded at 09:05.');
});

test('everything failing after a good load is stale, not blocked', () => {
  const names = Array.from({ length: 12 }, (_, i) => `section ${i}`);
  const notice = model.loadNotice({ missing: [], stale: names, total: 12, everLoaded: true, staleSince: at(14, 30) });
  assert.equal(notice.kind, 'stale');
});

test('both at once say both, the missing part first', () => {
  const notice = model.loadNotice({ missing: ['mail'], stale: ['tickets'], total: 12, everLoaded: true, staleSince: at(14, 30) });
  assert.equal(notice.kind, 'partial');
  assert.equal(notice.text, 'Could not load mail. Could not refresh tickets — showing what loaded at 14:30.');
});

/* ── When to look again ───────────────────────────────────────────────── */

test('a failed load is tried again soon, then less often', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(n => model.retryDelay(n)),
    [15000, 30000, 60000, 120000, 300000, 300000, 300000]);
  assert.equal(model.retryDelay(-1), 15000);
});

test('an open tab looks again every two minutes; a hidden one waits until it is looked at', () => {
  const t0 = 1000000;
  assert.equal(model.REFRESH_MS, 120000);
  assert.equal(model.refreshDue({ loadedAt: t0, now: t0 + 119000, visible: true }), false);
  assert.equal(model.refreshDue({ loadedAt: t0, now: t0 + 120000, visible: true }), true);
  assert.equal(model.refreshDue({ loadedAt: t0, now: t0 + 999000, visible: false }), false);
  assert.equal(model.refreshDue({ loadedAt: null, now: t0, visible: true }), true);
});
