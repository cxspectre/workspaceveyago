/* Who is signed in, without a page: session.js against a stand-in Supabase
   client whose auth events, second factors and employees lookup each test
   controls. Loaded into a sandbox the way <script> tags run it.
   Run from the repo root with: node --test

   Timers: by default a wait under four seconds (the deferral out of the auth
   callback, the pauses between lookups) runs on the next microtask. A test
   that needs to see what happens BEFORE a deferred check starts passes
   manualTimers and runs them with flush(). Longer timers — the four-second
   "no auth event at all" fallback, the twenty-second request limit — only run
   when a test fires them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const USER = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const STORAGE_KEY = 'veyago.workspace.auth';
const EMPLOYEE = { id: 'emp-1', full_name: 'Sam Rivera', email: 'sam@veyago.cloud', role: 'admin', title: null, status: 'active' };
const COLLEAGUE = { ...EMPLOYEE, id: 'emp-2', full_name: 'Jo Park', role: 'employee' };
const VERIFIED = { data: { all: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] }, error: null };
const NO_FACTORS = { data: { all: [], totp: [] }, error: null };
const OFFLINE = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };

const token = claims => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const session = (level, user = USER) => ({ access_token: token({ sub: user, aal: level }), user: { id: user } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/* factors(n): what the nth mfa.listFactors resolves to.
   employee(n): what the nth employees lookup resolves to.
   signOut(scope): what auth.signOut resolves to.
   fetch(url, init): the network the timed fetch wraps.
   stored: what localStorage holds under the session key.
   online: navigator.onLine. */
function start({
  factors = async () => NO_FACTORS,
  employee = async () => ({ data: EMPLOYEE, error: null }),
  signOut = async () => ({ error: null }),
  fetch = async () => ({ ok: true }),
  storage = null,
  stored = null,
  online = true,
  manualTimers = false
} = {}) {
  let listener = null;
  let options = null;
  const timers = [];
  const windowListeners = {};
  const calls = { factors: 0, employees: 0, signOut: [], removed: [] };
  const events = [];
  const client = {
    auth: {
      onAuthStateChange: fn => { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { listFactors: () => factors(++calls.factors) },
      signOut: opts => {
        const scope = opts && opts.scope ? opts.scope : 'global';
        calls.signOut.push(scope);
        return signOut(scope);
      }
    },
    from: table => {
      assert.equal(table, 'employees');
      const chain = { select: () => chain, eq: () => chain, maybeSingle: () => employee(++calls.employees) };
      return chain;
    }
  };
  const localStorage = storage || {
    getItem: key => (key === STORAGE_KEY ? stored : null),
    removeItem: key => { calls.removed.push(key); }
  };
  const context = vm.createContext({
    console: { ...console, warn() {}, error() {} },
    atob,
    AbortController,
    fetch,
    navigator: { onLine: online },
    window: {
      supabase: { createClient: (url, key, opts) => { options = opts; return client; } },
      VEYAGO_SUPABASE: { url: 'https://example.supabase.co', anonKey: 'anon' },
      localStorage,
      addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); }
    },
    document: { body: { dispatchEvent: event => { events.push(event); return true; } } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout: (fn, ms) => {
      if (!manualTimers && ms < 4000) { Promise.resolve().then(fn); return 0; }
      return timers.push({ fn, ms, done: false });
    },
    clearTimeout: id => { if (id && timers[id - 1]) timers[id - 1].done = true; }
  });
  for (const file of ['data/access.js', 'data/session.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  const run = pick => timers.filter(t => !t.done && pick(t.ms)).forEach(t => { t.done = true; t.fn(); });
  return {
    ws: context.window.workspaceSession,
    calls,
    events,
    options: () => options,
    emit: (event, value) => listener(event, value),
    storageEvent: (key, newValue) => (windowListeners.storage || []).forEach(fn => fn({ key, newValue })),
    fallback: () => run(ms => ms === 4000),
    fire: ms => run(at => at === ms),
    flush: () => run(ms => ms < 4000)
  };
}

/* ── Signing in ───────────────────────────────────────────────────────── */

test('an account with a second factor owes its code before anything is read', async () => {
  const s = start({ factors: async () => VERIFIED });
  s.emit('SIGNED_IN', session('aal1'));
  await tick();
  assert.equal(s.ws.access, 'needs-code');
  assert.equal(s.ws.factorId, 'f1');
  assert.equal(s.ws.isStaff(), false);
  assert.equal(s.ws.needsCode(), true);
  assert.equal(s.calls.employees, 0, 'the database refuses that lookup until the code is in');
});

test('a session that already cleared its code is not asked for the factors again', async () => {
  const s = start({ factors: async () => VERIFIED });
  s.emit('INITIAL_SESSION', session('aal2'));
  await tick();
  assert.equal(s.ws.access, 'staff');
  assert.equal(s.calls.factors, 0);
  assert.equal(s.ws.employee.id, 'emp-1');
  assert.equal(s.ws.isManager(), true);
});

test('an account with no second factor goes straight to the team check', async () => {
  const s = start();
  s.emit('SIGNED_IN', session('aal1'));
  await tick();
  assert.equal(s.ws.access, 'staff');
  assert.equal(s.ws.isStaff(), true);
  assert.equal(s.ws.userId, USER);
});

test('when the factors cannot be read, the workspace stays shut', async () => {
  const refused = start({ factors: async () => ({ data: null, error: OFFLINE }) });
  refused.emit('INITIAL_SESSION', session('aal1'));
  const thrown = start({ factors: async () => { throw new TypeError('Failed to fetch'); } });
  thrown.emit('INITIAL_SESSION', session('aal1'));
  await tick();
  for (const s of [refused, thrown]) {
    assert.equal(s.ws.access, 'unknown');
    assert.equal(s.calls.employees, 0);
  }
});

test('a lookup that keeps failing is "could not check", not "not a team member"', async () => {
  const s = start({ employee: async () => ({ data: null, error: { message: 'Failed to fetch' } }) });
  s.emit('SIGNED_IN', session('aal1'));
  await tick();
  assert.equal(s.ws.access, 'unknown');
  assert.equal(s.ws.isStaff(), false);
  assert.equal(s.calls.employees, 4, 'asked again before giving up');
});

test('one failed attempt followed by an answer is that answer', async () => {
  const s = start({
    employee: async n => (n === 1 ? { data: null, error: { message: 'Failed to fetch' } } : { data: EMPLOYEE, error: null })
  });
  s.emit('SIGNED_IN', session('aal1'));
  await tick();
  assert.equal(s.ws.access, 'staff');
  assert.equal(s.calls.employees, 2);
});

test('no employees row after asking again, or an inactive one, is not staff', async () => {
  const none = start({ employee: async () => ({ data: null, error: null }) });
  none.emit('SIGNED_IN', session('aal1'));
  const inactive = start({ employee: async () => ({ data: { ...EMPLOYEE, status: 'inactive' }, error: null }) });
  inactive.emit('SIGNED_IN', session('aal1'));
  await tick();
  assert.equal(none.ws.access, 'not-staff');
  assert.equal(none.calls.employees, 4, 'a token that is not live yet also finds no row, so it asks again');
  assert.equal(inactive.ws.access, 'not-staff');
  assert.equal(inactive.ws.employee, null);
  assert.equal(inactive.calls.employees, 1, 'an inactive row is an answer');
});

/* ── While the workspace is open ──────────────────────────────────────── */

test('a failed check for the same person keeps what was known about them', async () => {
  let offline = false;
  const s = start({ employee: async () => (offline ? { data: null, error: { message: 'Failed to fetch' } } : { data: EMPLOYEE, error: null }) });
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  offline = true;
  s.emit('TOKEN_REFRESHED', session('aal2'));
  await tick();
  assert.equal(s.ws.access, 'unknown');
  assert.equal(s.ws.employee.id, 'emp-1', 'the views keep the tools they had a minute ago');
  assert.equal(s.ws.isManager(), true);
});

test('a failed check for someone else keeps nobody', async () => {
  let offline = false;
  const s = start({ employee: async () => (offline ? { data: null, error: { message: 'Failed to fetch' } } : { data: EMPLOYEE, error: null }) });
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  offline = true;
  s.emit('SIGNED_IN', session('aal2', OTHER));
  await tick();
  assert.equal(s.ws.access, 'unknown');
  assert.equal(s.ws.employee, null);
  assert.equal(s.ws.userId, OTHER);
});

test('signing out anywhere reads as signed out, and says so', async () => {
  const s = start();
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  s.emit('SIGNED_OUT', null);
  await tick();
  assert.equal(s.ws.access, 'signed-out');
  assert.equal(s.ws.employee, null);
  assert.equal(s.ws.role, null);
  assert.equal(s.ws.userId, null);
  assert.equal(s.events.at(-1).type, 'workspace:session');
  assert.equal(s.events.at(-1).detail.access, 'signed-out');
});

test('signing out in another tab while offline still locks this one', async () => {
  const s = start();
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  s.storageEvent(STORAGE_KEY, null);
  await tick();
  assert.equal(s.ws.access, 'signed-out', 'supabase-js only tells other tabs when the server heard the sign-out');
});

test('a change to some other stored value is not a sign-out', async () => {
  const s = start();
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  s.storageEvent('veyago-compact', null);
  s.storageEvent(STORAGE_KEY, '{"access_token":"refreshed"}');
  await tick();
  assert.equal(s.ws.access, 'staff');
});

test('an older check that finishes last never overwrites a newer one', async () => {
  const slow = deferred();
  const s = start({ factors: () => slow.promise });
  s.emit('SIGNED_IN', session('aal1'));
  await tick();
  s.emit('MFA_CHALLENGE_VERIFIED', session('aal2'));
  await tick();
  assert.equal(s.ws.access, 'staff');
  slow.resolve(VERIFIED);
  await tick();
  assert.equal(s.ws.access, 'staff', 'the aal1 answer arrived last, but describes a session that has gone');
});

test('an answer about a session that has already been replaced is not used, even before the new check starts', async () => {
  const lookup = deferred();
  const s = start({ employee: () => lookup.promise, manualTimers: true });
  s.emit('INITIAL_SESSION', session('aal2'));
  s.flush();
  await tick();
  s.emit('SIGNED_OUT', null);
  lookup.resolve({ data: EMPLOYEE, error: null });
  await tick();
  assert.notEqual(s.ws.access, 'staff', 'that session was signed out in another tab while it was being checked');
  s.flush();
  await tick();
  assert.equal(s.ws.access, 'signed-out');
});

test('an auth event and a refresh() asked for at the same moment share one check', async () => {
  const s = start();
  s.emit('SIGNED_IN', session('aal1'));
  const state = await s.ws.refresh();
  assert.equal(state.access, 'staff');
  assert.equal(s.calls.factors, 1);
  assert.equal(s.calls.employees, 1, 'the gate refreshes right after signing in; that is not a second lookup');
});

test('events that arrive together are checked once, with the last session', async () => {
  const s = start({ factors: async () => VERIFIED });
  s.emit('SIGNED_IN', session('aal1'));
  s.emit('MFA_CHALLENGE_VERIFIED', session('aal2'));
  await tick();
  assert.equal(s.ws.access, 'staff');
  assert.equal(s.calls.factors, 0, 'the aal1 session had already gone when the check ran');
  assert.equal(s.calls.employees, 1);
});

test('refresh() waits for a newer check that is still running, and hands back its answer', async () => {
  const lookups = [deferred(), deferred(), deferred()];
  const s = start({ employee: n => lookups[n - 1].promise });
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  let answered = null;
  s.ws.refresh().then(state => { answered = state.userId; });
  await tick();
  s.emit('SIGNED_IN', session('aal2', OTHER));
  await tick();

  lookups[1].resolve({ data: EMPLOYEE, error: null });
  await tick();
  assert.equal(answered, null, 'the check refresh() started is out of date, and a newer one is still running');

  lookups[2].resolve({ data: COLLEAGUE, error: null });
  await tick();
  assert.equal(answered, OTHER);
  lookups[0].resolve({ data: EMPLOYEE, error: null });
  await tick();
  assert.equal(s.ws.employee.id, 'emp-2');
});

/* ── Waiting, timing out and signing out ──────────────────────────────── */

test('ready() waits for the first answer', async () => {
  const s = start();
  let answered = false;
  s.ws.ready().then(() => { answered = true; });
  await tick();
  assert.equal(answered, false, 'no auth event yet');
  s.emit('INITIAL_SESSION', null);
  await tick();
  assert.equal(answered, true);
});

test('with no auth event and nothing stored, the fallback answers signed out', async () => {
  const s = start();
  s.fallback();
  const state = await s.ws.ready();
  assert.equal(state.access, 'signed-out');
});

test('the fallback waits while a stored session is still being refreshed', async () => {
  const s = start({ stored: '{"access_token":"expired overnight"}' });
  let answered = false;
  s.ws.ready().then(() => { answered = true; });
  s.fallback();
  await tick();
  assert.equal(answered, false, 'the next-morning refresh on a slow link is not "signed out"');
});

test('a slow check is not cut short by the fallback: only a missing auth event is', async () => {
  const slow = deferred();
  const s = start({ factors: () => slow.promise });
  let answered = null;
  s.ws.ready().then(state => { answered = state.access; });
  s.emit('INITIAL_SESSION', session('aal1'));
  await tick();
  s.fallback();
  await tick();
  assert.equal(answered, null, 'a signed-in person on a slow network is not shown the password form');
  slow.resolve(NO_FACTORS);
  await tick();
  assert.equal(answered, 'staff');
});

test('auth and database requests give up after twenty seconds; uploads and functions are left alone', async () => {
  const seen = [];
  const s = start({ fetch: (url, init) => { seen.push({ url, signal: init && init.signal }); return new Promise(() => {}); } });
  const timed = s.options().global.fetch;
  timed('https://example.supabase.co/auth/v1/token?grant_type=password', { method: 'POST' });
  timed('https://example.supabase.co/rest/v1/employees?select=id', {});
  timed('https://example.supabase.co/storage/v1/object/project-files/a/b', { method: 'POST' });
  timed('https://example.supabase.co/functions/v1/send-mail', { method: 'POST' });
  assert.ok(seen[0].signal && seen[1].signal, 'auth and rest carry a signal');
  assert.equal(seen[2].signal, undefined, 'a 50 MB upload may take longer than twenty seconds');
  assert.equal(seen[3].signal, undefined);
  assert.equal(seen[0].signal.aborted, false);
  s.fire(20000);
  assert.equal(seen[0].signal.aborted, true);
  assert.equal(seen[1].signal.aborted, true);
});

test('the time limit still holds while a response body is being read', async () => {
  const seen = [];
  const s = start({ fetch: (url, init) => { seen.push(init.signal); return Promise.resolve({ ok: true }); } });
  await s.options().global.fetch('https://example.supabase.co/rest/v1/employees?select=id', {});
  assert.equal(seen[0].aborted, false);
  s.fire(20000);
  assert.equal(seen[0].aborted, true, 'a body that stalls after the headers arrived is cut off too');
});

test('signing out ends this browser\'s session, not every device\'s', async () => {
  const s = start();
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  await s.ws.signOut();
  assert.deepEqual([...s.calls.signOut], ['local']);
  assert.equal(s.ws.access, 'signed-out');
});

test('a sign-out the network cannot deliver still forgets the session in this browser', async () => {
  const s = start({ signOut: async () => ({ error: OFFLINE }) });
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  const result = await s.ws.signOut();
  assert.equal(result.error, null);
  assert.deepEqual([...s.calls.removed].sort(),
    ['veyago.workspace.auth', 'veyago.workspace.auth-code-verifier', 'veyago.workspace.auth-user']);
  assert.equal(s.ws.access, 'signed-out');
});

test('offline, signing out forgets the session straight away rather than waiting on the network', async () => {
  const s = start({ online: false });
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  const result = await s.ws.signOut();
  assert.equal(result.error, null);
  assert.deepEqual([...s.calls.signOut], [], 'no request that could only time out');
  assert.ok(s.calls.removed.includes(STORAGE_KEY));
  assert.equal(s.ws.access, 'signed-out');
});

test('a sign-out that cannot even forget the session says so, and keeps the session it could not end', async () => {
  const s = start({
    signOut: async () => ({ error: OFFLINE }),
    storage: { getItem: () => null, removeItem: () => { throw new Error('The operation is insecure.'); } }
  });
  s.emit('SIGNED_IN', session('aal2'));
  await tick();
  const result = await s.ws.signOut();
  assert.ok(result.error);
  assert.equal(s.ws.access, 'staff');
});
