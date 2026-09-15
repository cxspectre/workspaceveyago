/* The sign-in screen's wiring, without a browser: gate.js against a stand-in
   page and a stand-in session whose answers each test sets. What each answer
   means is accessModel's business (tests/access.test.mjs). This is about what
   those tests cannot see: that gate.js opens the workspace only when the model
   says so, only once, and locks it again when the session it opened for ends.
   The two-factor bypass lived in exactly this wiring.
   Run from the repo root with: node --test */
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

const PARTS = ['#gate-form', '#gate-email', '#gate-pw', '#gate-code', '#gate-submit',
  '#gate-msg', '#gate-sub', '#step-pw', '#pw-field', '#step-code', '#gate-back', '#gate-forgot'];

/* Enough of an element for gate.js, which builds its card with innerHTML and
   then looks the parts up by id. */
function element(page, name) {
  const listeners = {};
  const classes = new Set();
  const el = {
    name, hidden: false, disabled: false, inert: false, open: false,
    value: '', textContent: '', className: '', innerHTML: '', dataset: {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    attributes: {},
    setAttribute: (name, value) => { el.attributes[name] = String(value); },
    getAttribute: name => (Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    fire: type => Promise.all((listeners[type] || []).map(fn => fn({ type, target: el, preventDefault() {} }))),
    focus: () => { page.focused = name; },
    select: () => { page.focused = name; },
    close: () => { el.open = false; },
    appendChild: child => child,
    replaceWith: () => {},
    querySelector: selector => page.parts[selector] || null
  };
  return el;
}

/* The header paintHeader() repaints: the sidebar's profile link, the avatar
   inside it, the role chip and, once a session chip replaces it, the button
   inside that. Selectors only reachable once someone is signed in, so no
   test that never sets state.employee ever looks them up. */
const HEADER_PARTS = { '.sidebar .profile': '.profile', '.avatar': '.avatar', '.demo-label': '.demo-label', '.header-avatar': '.header-avatar', '.session-signout': '.session-signout' };

function start(initial = {}) {
  const page = { parts: {}, focused: null, reloads: 0, authed: 0, gate: null };
  PARTS.forEach(id => { page.parts[id] = element(page, id); });
  Object.entries(HEADER_PARTS).forEach(([selector, name]) => { page.parts[selector] = element(page, name); });
  const app = element(page, '.app');
  app.classList.add('locked');
  app.inert = true;
  const modal = element(page, '#modal');
  const listeners = {};
  const ready = deferred();
  const calls = { signIn: 0, challenge: 0, verify: [], signOut: 0, refresh: 0, reset: [] };
  const state = { access: 'signed-out', userId: null, factorId: null, employee: null, ...initial };
  const answers = {
    signIn: async () => ({ data: {}, error: null }),
    verify: async () => ({ data: {}, error: null }),
    reset: async () => ({ data: { ok: true }, error: null }),
    afterRefresh: null
  };
  /* The real two-initial shape (queries.js initials()), which paintHeader()
     asks for by name — its own tests cover initials() itself. */
  const window = { workspaceData: { initials: name => String(name || '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase() } };
  const emit = () => (listeners['workspace:session'] || []).forEach(fn => fn({ type: 'workspace:session' }));

  window.workspaceSession = {
    client: {
      functions: {
        invoke: (name, options) => { calls.reset.push({ name, email: options.body.email }); return answers.reset(); }
      },
      auth: {
        signInWithPassword: () => { calls.signIn++; return answers.signIn(); },
        mfa: {
          challenge: async () => { calls.challenge++; return { data: { id: 'ch' + calls.challenge }, error: null }; },
          verify: params => { calls.verify.push({ ...params }); return answers.verify(); }
        }
      }
    },
    get access() { return state.access; },
    get userId() { return state.userId; },
    get factorId() { return state.factorId; },
    get employee() { return state.employee; },
    ready: () => ready.promise,
    refresh: async () => {
      calls.refresh++;
      if (answers.afterRefresh) Object.assign(state, answers.afterRefresh);
      return state;
    },
    /* As session.js does: the answer changes, the event fires, the gate is told. */
    signOut: async () => {
      calls.signOut++;
      Object.assign(state, { access: 'signed-out', userId: null, factorId: null });
      emit();
      if (window.workspaceGate) window.workspaceGate.close();
      return { error: null };
    }
  };

  const context = vm.createContext({
    console: { ...console, error() {} },
    window,
    location: { reload: () => { page.reloads++; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: {
      body: {
        appendChild: child => child,
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        dispatchEvent: event => {
          if (event.type === 'workspace:authed') page.authed++;
          (listeners[event.type] || []).forEach(fn => fn(event));
          return true;
        }
      },
      querySelector: selector => (selector === '.app' ? app : page.parts[selector] || null),
      getElementById: id => (id === 'modal' ? modal : null),
      createElement: () => { page.gate = element(page, '#gate'); return page.gate; }
    }
  });
  for (const file of ['data/access.js', 'data/gate.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  return {
    page, app, modal, calls, answers,
    part: id => page.parts[id],
    gate: () => page.gate,
    api: () => window.workspaceGate,
    set: next => Object.assign(state, next),
    emit,
    ready: () => ready.resolve(state),
    submit: () => page.parts['#gate-form'].fire('submit'),
    back: () => page.parts['#gate-back'].fire('click')
  };
}

/* ── The door ─────────────────────────────────────────────────────────── */

test('a stored session that still owes its code gets the code screen, and the page stays locked', async () => {
  const g = start({ access: 'needs-code', userId: 'u1', factorId: 'f1' });
  g.ready();
  await tick();
  assert.equal(g.page.authed, 0);
  assert.equal(g.app.inert, true);
  assert.ok(g.app.classList.contains('locked'));
  assert.equal(g.part('#step-code').hidden, false);
  assert.equal(g.part('#step-pw').hidden, true);
  assert.equal(g.page.focused, '#gate-code');
  assert.equal(g.calls.challenge, 1);
});

test('a session event cannot open the workspace for a session that owes its code', async () => {
  const g = start();
  g.ready();
  await tick();
  g.set({ access: 'needs-code', userId: 'u1', factorId: 'f1' });
  g.emit();
  await tick();
  assert.equal(g.page.authed, 0);
  assert.equal(g.app.inert, true);
  assert.equal(g.part('#step-code').hidden, false);
});

test('the workspace opens once, however often staff is confirmed', async () => {
  const g = start({ access: 'staff', userId: 'u1' });
  g.ready();
  await tick();
  g.emit();
  g.emit();
  await tick();
  assert.equal(g.page.authed, 1);
  assert.equal(g.app.inert, false);
  assert.equal(g.app.classList.contains('locked'), false);
  assert.equal(g.gate().hidden, true);
});

/* ── Once open ────────────────────────────────────────────────────────── */

test('a session that ends locks the page, closes any dialog, and reloads without a draft prompt', async () => {
  const g = start({ access: 'staff', userId: 'u1' });
  g.ready();
  await tick();
  g.modal.open = true;
  g.set({ access: 'signed-out', userId: null });
  g.emit();
  await tick();
  assert.equal(g.page.reloads, 1);
  assert.equal(g.app.inert, true);
  assert.equal(g.modal.open, false, 'a dialog sits above the gate, so it has to go');
  assert.equal(g.modal.inert, true);
  assert.equal(g.api().leaving, true, 'mail.js skips its unsent-draft prompt');
});

test('someone else signing in from another tab reloads the page', async () => {
  const g = start({ access: 'staff', userId: 'u1' });
  g.ready();
  await tick();
  g.set({ userId: 'u2' });
  g.emit();
  await tick();
  assert.equal(g.page.reloads, 1);
});

test('a check that could not finish leaves the open workspace alone', async () => {
  const g = start({ access: 'staff', userId: 'u1' });
  g.ready();
  await tick();
  g.set({ access: 'unknown' });
  g.emit();
  await tick();
  assert.equal(g.page.reloads, 0);
  assert.equal(g.app.inert, false);
});

/* ── The steps ────────────────────────────────────────────────────────── */

test('an answer that arrives while a step waits on the server is left to that step', async () => {
  const g = start();
  g.ready();
  await tick();
  const signIn = deferred();
  g.answers.signIn = () => signIn.promise;
  g.part('#gate-email').value = 'sam@veyago.cloud';
  g.part('#gate-pw').value = 'fixture-secret';
  const submitting = g.submit();
  await tick();
  assert.equal(g.part('#gate-submit').disabled, true);

  g.set({ access: 'staff', userId: 'u1' });
  g.emit();
  await tick();
  assert.equal(g.page.authed, 0, 'the password step decides, once it has finished');

  signIn.resolve({ data: {}, error: null });
  await submitting;
  await tick();
  assert.equal(g.page.authed, 1);
  assert.equal(g.part('#gate-pw').value, '');
});

test('a sign-in that did not reach the service says so and keeps the form', async () => {
  const g = start();
  g.ready();
  await tick();
  g.answers.signIn = async () => ({ data: null, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } });
  g.part('#gate-email').value = 'sam@veyago.cloud';
  g.part('#gate-pw').value = 'fixture-secret';
  await g.submit();
  assert.match(g.part('#gate-msg').textContent, /connection/);
  assert.equal(g.part('#gate-submit').disabled, false);
  assert.equal(g.page.authed, 0);
});

test('a step that throws does not leave the screen stuck', async () => {
  const g = start();
  g.ready();
  await tick();
  g.answers.signIn = () => { throw new TypeError("Cannot read properties of undefined (reading 'auth')"); };
  g.part('#gate-email').value = 'sam@veyago.cloud';
  g.part('#gate-pw').value = 'fixture-secret';
  await g.submit();
  assert.equal(g.part('#gate-submit').disabled, false);
  assert.match(g.part('#gate-msg').textContent, /went wrong/);
  g.set({ access: 'staff', userId: 'u1' });
  g.emit();
  await tick();
  assert.equal(g.page.authed, 1, 'session events are listened to again');
});

test('a wrong code, then the right one, opens the workspace — each try with its own challenge', async () => {
  const g = start({ access: 'needs-code', userId: 'u1', factorId: 'f1' });
  g.ready();
  await tick();
  g.answers.verify = async () => ({ data: null, error: { name: 'AuthApiError', status: 422, code: 'mfa_verification_failed' } });
  g.part('#gate-code').value = '123 456';
  await g.submit();
  assert.match(g.part('#gate-msg').textContent, /not accepted/);
  assert.deepEqual(g.calls.verify[0], { factorId: 'f1', challengeId: 'ch1', code: '123456' });

  g.answers.verify = async () => ({ data: {}, error: null });
  g.answers.afterRefresh = { access: 'staff' };
  await g.submit();
  await tick();
  assert.equal(g.calls.verify[1].challengeId, 'ch2');
  assert.equal(g.page.authed, 1);
});

test('a code that was accepted but did not finish signing in says so', async () => {
  const g = start({ access: 'needs-code', userId: 'u1', factorId: 'f1' });
  g.ready();
  await tick();
  g.part('#gate-code').value = '123456';
  await g.submit();
  await tick();
  assert.equal(g.page.authed, 0);
  assert.match(g.part('#gate-msg').textContent, /did not finish/);
  assert.equal(g.part('#gate-submit').disabled, false);
});

test('a code screen with no factor it can use still has a way back', async () => {
  const g = start({ access: 'needs-code', userId: 'u1', factorId: null });
  g.ready();
  await tick();
  assert.equal(g.part('#gate-submit').hidden, true);
  assert.equal(g.part('#step-code').hidden, true, 'no field for a code that cannot be checked');
  assert.equal(g.part('#gate-back').hidden, false);
  assert.equal(g.page.focused, '#gate-back');
  await g.back();
  await tick();
  assert.equal(g.calls.signOut, 1);
  assert.equal(g.part('#step-pw').hidden, false);
});

/* ── The header, once someone is signed in ───────────────────────────── */

test('the sidebar and the header chip say whose session it is — never a name written into the page', async () => {
  const g = start({ access: 'staff', userId: 'u1', employee: { full_name: 'Ana Lima', role: 'assistant', title: null } });
  g.ready();
  await tick();
  assert.equal(g.part('.sidebar .profile').attributes['aria-label'], 'Ana Lima, Assistant',
    'said from the signed-in employee, not "Cassian, workspace owner" for everyone');
  assert.equal(g.part('.avatar').textContent, 'AL');
  assert.equal(g.part('.demo-label').textContent, 'Assistant');
});

test('a title stands in for the role where one is set', async () => {
  const g = start({ access: 'staff', userId: 'u1', employee: { full_name: 'Cassian Drefke', role: 'owner', title: 'Founder' } });
  g.ready();
  await tick();
  assert.equal(g.part('.sidebar .profile').attributes['aria-label'], 'Cassian Drefke, Founder');
  assert.equal(g.part('.demo-label').textContent, 'Founder');
});

test('not a team member: signed out, told why, and the password form stays up', async () => {
  const g = start({ access: 'not-staff', userId: 'u1' });
  g.ready();
  await tick();
  assert.equal(g.calls.signOut, 1);
  assert.match(g.part('#gate-msg').textContent, /not an active team member/);
  assert.equal(g.part('#step-pw').hidden, false);
  assert.equal(g.page.authed, 0);
});

/* ── A forgotten password ─────────────────────────────────────────────── */

test('a forgotten password sends a reset link, and the answer is the same for any address', async () => {
  const g = start();
  g.ready();
  await tick();
  assert.equal(g.part('#gate-forgot').hidden, false);
  await g.part('#gate-forgot').fire('click');
  assert.equal(g.part('#pw-field').hidden, true, 'no password field when asking for a new one');
  assert.equal(g.part('#gate-submit').textContent, 'Send reset link');
  assert.equal(g.part('#gate-forgot').hidden, true);
  g.part('#gate-email').value = ' sam@veyago.cloud ';
  await g.submit();
  assert.deepEqual(g.calls.reset, [{ name: 'request-password-reset', email: 'sam@veyago.cloud' }]);
  assert.match(g.part('#gate-msg').textContent, /If that address has an account/);
  assert.equal(g.page.authed, 0);
});

test('a reset asked for without a real address, or while offline, says what to fix', async () => {
  const g = start();
  g.ready();
  await tick();
  await g.part('#gate-forgot').fire('click');
  g.part('#gate-email').value = 'sam';
  await g.submit();
  assert.match(g.part('#gate-msg').textContent, /email address/);
  assert.equal(g.calls.reset.length, 0);

  g.answers.reset = async () => ({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' } });
  g.part('#gate-email').value = 'sam@veyago.cloud';
  await g.submit();
  assert.match(g.part('#gate-msg').textContent, /connection/);
  assert.equal(g.part('#gate-submit').disabled, false);
});

test('back from a forgotten password is the sign-in form again, with nobody signed out', async () => {
  const g = start();
  g.ready();
  await tick();
  await g.part('#gate-forgot').fire('click');
  assert.equal(g.part('#gate-back').hidden, false);
  assert.equal(g.part('#gate-back').textContent, 'Back to sign in');
  await g.back();
  assert.equal(g.part('#pw-field').hidden, false);
  assert.equal(g.part('#gate-submit').textContent, 'Sign in');
  assert.equal(g.part('#gate-back').hidden, true);
  assert.equal(g.calls.signOut, 0);
});

test('a check that could not finish offers to try again, and opens only once it can', async () => {
  const g = start({ access: 'unknown', userId: 'u1' });
  g.ready();
  await tick();
  assert.equal(g.part('#gate-submit').textContent, 'Try again');
  assert.equal(g.page.focused, '#gate-submit');
  await g.submit();
  assert.match(g.part('#gate-msg').textContent, /Still could not/);
  assert.equal(g.page.authed, 0);

  g.answers.afterRefresh = { access: 'staff' };
  await g.submit();
  await tick();
  assert.equal(g.page.authed, 1);
});
