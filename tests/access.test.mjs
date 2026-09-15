/* Who may open the workspace, without a page: what the access token says,
   whether a second factor is still owed, which screen the gate shows next, and
   what a person is told when signing in fails. Loaded into a sandbox the way
   <script> tags run it. Run from the repo root with: node --test

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence the {...spread} before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, atob });
vm.runInContext(readFileSync(new URL('../dist/data/access.js', import.meta.url), 'utf8'), context);
const model = vm.runInContext('accessModel', context);

/* An access token carrying these claims. The browser never checks the
   signature — the database does — so any will do. */
const token = claims => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

const apiError = (status, code, message = 'Request failed') => ({ name: 'AuthApiError', status, code, message });
const offline = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };

/* ── The access token ─────────────────────────────────────────────────── */

test('the assurance level is read from the access token itself', () => {
  assert.equal(model.tokenLevel(token({ sub: 'u1', aal: 'aal2' })), 'aal2');
  assert.equal(model.tokenLevel(token({ sub: 'u1', aal: 'aal1' })), 'aal1');
});

test('a token in base64url, with non-ASCII claims, still reads', () => {
  const claims = { aal: 'aal2', note: '>>>>>>??????', user_metadata: { full_name: 'Zoë Ørsted' } };
  const payload = token(claims).split('.')[1];
  assert.match(payload, /-/, 'the payload really uses the URL-safe alphabet');
  assert.match(payload, /_/);
  assert.equal(model.tokenLevel(token(claims)), 'aal2');
});

test('anything that is not a readable token has no level', () => {
  assert.equal(model.tokenLevel(token({ sub: 'u1' })), null);
  assert.equal(model.tokenLevel(token({ aal: 'aal3' })), null);
  assert.equal(model.tokenLevel('not-a-token'), null);
  assert.equal(model.tokenLevel('a.@@@@.c'), null);
  assert.equal(model.tokenLevel(''), null);
  assert.equal(model.tokenLevel(undefined), null);
});

/* ── Second factors ───────────────────────────────────────────────────── */

const VERIFIED_TOTP = { id: 'f1', factor_type: 'totp', status: 'verified' };

test('a verified authenticator app is owed, from either list supabase-js returns', () => {
  const unverified = { id: 'f0', factor_type: 'totp', status: 'unverified' };
  assert.deepEqual({ ...model.secondFactor({ totp: [unverified, VERIFIED_TOTP] }) }, { owed: true, factorId: 'f1' });
  assert.deepEqual({ ...model.secondFactor({ all: [unverified, VERIFIED_TOTP], totp: [] }) }, { owed: true, factorId: 'f1' });
  assert.deepEqual({ ...model.secondFactor({ all: [{ id: 'f2', factorType: 'totp', status: 'verified' }] }) },
    { owed: true, factorId: 'f2' });
});

test('an abandoned enrolment is not a second factor', () => {
  const unverified = { id: 'f0', factor_type: 'totp', status: 'unverified' };
  assert.deepEqual({ ...model.secondFactor({ all: [unverified], totp: [unverified] }) }, { owed: false, factorId: null });
  assert.deepEqual({ ...model.secondFactor({}) }, { owed: false, factorId: null });
  assert.deepEqual({ ...model.secondFactor(null) }, { owed: false, factorId: null });
});

test('a verified factor this screen cannot challenge is still owed, like the database says', () => {
  assert.deepEqual({ ...model.secondFactor({ all: [{ id: 'p1', factor_type: 'phone', status: 'verified' }] }) },
    { owed: true, factorId: null });
});

/* ── Access ───────────────────────────────────────────────────────────── */

const facts = (over = {}) => ({ signedIn: true, level: 'aal1', factor: 'none', lookup: 'staff', ...over });

test('no session, no way in', () => {
  assert.equal(model.accessFor(facts({ signedIn: false })), 'signed-out');
});

test('a password alone is not enough for an account with a second factor', () => {
  assert.equal(model.accessFor(facts({ factor: 'owed' })), 'needs-code');
  assert.equal(model.accessFor(facts({ factor: 'owed', lookup: undefined })), 'needs-code');
});

test('a session that cleared its code goes on to the team check', () => {
  assert.equal(model.accessFor(facts({ level: 'aal2', factor: 'owed' })), 'staff');
  assert.equal(model.accessFor(facts({ level: 'aal2', factor: undefined, lookup: 'none' })), 'not-staff');
});

test('an account with no second factor goes straight to the team check', () => {
  assert.equal(model.accessFor(facts()), 'staff');
  assert.equal(model.accessFor(facts({ lookup: 'none' })), 'not-staff');
});

test('not knowing whether a code is owed keeps the door shut', () => {
  assert.equal(model.accessFor(facts({ factor: 'failed' })), 'unknown');
  assert.equal(model.accessFor(facts({ factor: undefined })), 'unknown');
});

test('a lookup that failed is not the same as not being on the team', () => {
  assert.equal(model.accessFor(facts({ lookup: 'failed' })), 'unknown');
  assert.equal(model.accessFor(facts({ lookup: undefined })), 'unknown');
});

/* ── What the gate does next ──────────────────────────────────────────── */

const step = (access, over = {}) =>
  model.gateStep(access, { opened: false, openedUserId: null, userId: 'u1', ...over });

test('before the workspace opens, each answer has its own screen', () => {
  assert.equal(step('signed-out'), 'password');
  assert.equal(step('needs-code'), 'code');
  assert.equal(step('staff'), 'open');
  assert.equal(step('not-staff'), 'refuse');
  assert.equal(step('unknown'), 'problem');
});

test('once open, losing the session, the role or the code locks it again', () => {
  const open = { opened: true, openedUserId: 'u1' };
  assert.equal(step('signed-out', { ...open, userId: null }), 'reload');
  assert.equal(step('not-staff', open), 'reload');
  assert.equal(step('needs-code', open), 'reload');
});

test('once open, someone else signing in from another tab reloads it', () => {
  assert.equal(step('staff', { opened: true, openedUserId: 'u1', userId: 'u2' }), 'reload');
  assert.equal(step('unknown', { opened: true, openedUserId: 'u1', userId: 'u2' }), 'reload');
});

test('once open, a check that could not finish leaves the workspace as it is', () => {
  assert.equal(step('staff', { opened: true, openedUserId: 'u1' }), 'stay');
  assert.equal(step('unknown', { opened: true, openedUserId: 'u1' }), 'stay');
});

/* ── What a person is told ────────────────────────────────────────────── */

test('a wrong password is told apart from a service that could not be reached', () => {
  assert.match(model.signInMessage(apiError(400, 'invalid_credentials', 'Invalid login credentials')), /do not match/);
  assert.match(model.signInMessage(offline), /connection/);
  assert.match(model.signInMessage(new TypeError('Failed to fetch')), /connection/);
  assert.match(model.signInMessage(new TypeError('Load failed')), /connection/, 'Safari');
  assert.match(model.signInMessage(new TypeError('NetworkError when attempting to fetch resource.')), /connection/, 'Firefox');
  assert.match(model.signInMessage({ name: 'AbortError', message: 'The operation was aborted.' }), /connection/, 'a request that timed out');
  assert.match(model.signInMessage({ name: 'AuthRetryableFetchError', status: 503, message: 'Service Unavailable' }), /not answering/);
  assert.match(model.signInMessage(apiError(500, 'unexpected_failure')), /not answering/);
});

test('too many attempts says to wait, not that the password is wrong', () => {
  assert.match(model.signInMessage(apiError(429, 'over_request_rate_limit')), /Too many attempts/);
  assert.doesNotMatch(model.signInMessage(apiError(429, 'over_request_rate_limit')), /do not match/);
});

test('any other answer from the service stays vague, so the screen confirms nothing about an address', () => {
  assert.match(model.signInMessage(apiError(400, 'email_not_confirmed')), /do not match/);
  assert.match(model.signInMessage(apiError(400, 'user_banned')), /do not match/);
  assert.match(model.signInMessage(apiError(422)), /do not match/);
  assert.match(model.signInMessage({ name: 'AuthInvalidCredentialsError', status: 400 }), /do not match/);
});

test('a bug in the page is neither a wrong password nor a bad connection', () => {
  const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
  assert.match(model.signInMessage(bug), /went wrong/);
  assert.match(model.signInMessage({}), /went wrong/);
  assert.match(model.codeMessage(bug), /went wrong/);
  assert.match(model.challengeMessage(bug), /went wrong/);
});

test('a wrong code, an expired one and too many tries each say what to do next', () => {
  assert.match(model.codeMessage(apiError(422, 'mfa_verification_failed', 'Invalid TOTP code entered')), /not accepted/);
  assert.match(model.codeMessage(apiError(422, 'mfa_challenge_expired')), /took too long/);
  assert.match(model.codeMessage(apiError(429, 'over_request_rate_limit')), /Too many attempts/);
  assert.match(model.codeMessage(offline), /connection/);
  assert.match(model.codeMessage(apiError(502, 'unexpected_failure')), /not answering/);
});

test('a code check that could not start is not called a wrong code', () => {
  assert.match(model.challengeMessage(offline), /connection/);
  assert.match(model.challengeMessage(apiError(429, 'over_request_rate_limit')), /Too many attempts/);
  assert.doesNotMatch(model.challengeMessage(apiError(404, 'mfa_factor_not_found')), /not accepted/);
});

test('a pasted code keeps all six digits, whatever they were written with', () => {
  assert.equal(model.codeDigits('123 456'), '123456');
  assert.equal(model.codeDigits(' 123-456 '), '123456');
  assert.equal(model.codeDigits('1234567'), '123456');
  assert.equal(model.codeDigits('abc'), '');
  assert.equal(model.codeDigits(null), '');
});
