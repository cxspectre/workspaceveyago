/* access.js — who may open the workspace, with no page in it.
 *
 * The session (session.js) and the sign-in screen (gate.js) ask the same
 * questions: does this session still owe its second factor, is this person on
 * the team, and what should the screen do about the answer. They are answered
 * here, once, where they can be tested without a browser —
 * tests/access.test.mjs.
 *
 * TWO RULES THIS FILE EXISTS TO KEEP.
 *
 * 1. A password alone never opens the workspace for an account with a second
 *    factor. The access token's own `aal` claim says whether the code was
 *    entered. Whether a factor exists is asked of the server (listFactors),
 *    because session.user.factors is missing from the session
 *    signInWithPassword hands back — the admin found that out as a bypass
 *    (veyagocloud admin/js/auth.js, mfaOutstanding). Not being able to find
 *    out keeps the door shut.
 *
 * 2. "Could not check" is not "no". A lookup that failed on the network used
 *    to read as "not a team member", and the gate signed the person out.
 *    Failure has its own answer, 'unknown', and its own screen.
 */
const accessModel = (function () {
  'use strict';

  const ACCESS = Object.freeze({
    SIGNED_OUT: 'signed-out',
    NEEDS_CODE: 'needs-code',
    STAFF: 'staff',
    NOT_STAFF: 'not-staff',
    UNKNOWN: 'unknown'
  });

  const CODE_LENGTH = 6;

  const MESSAGES = Object.freeze({
    credentials: 'That email and password do not match.',
    code: 'That code was not accepted. Codes change every 30 seconds — enter the current one.',
    expired: 'That code took too long. Enter the current one.',
    challenge: 'The code check could not start. Try again.',
    tooMany: 'Too many attempts. Wait a minute, then try again.',
    offline: 'Could not reach the sign-in service. Check your connection and try again.',
    down: 'The sign-in service is not answering right now. Try again in a moment.',
    unexpected: 'Something went wrong. Try again in a moment.'
  });

  /* How each browser words a request that never reached the network:
     Chrome, Safari, Firefox, and React Native's fetch. */
  const NETWORK_FAILURE = /failed to fetch|load failed|networkerror|network request failed/i;

  /* The access token's assurance level: 'aal1', 'aal2', or null when the token
     cannot be read. The browser does not check the signature; the database
     reads the same claim from a token whose signature it has checked. */
  function tokenLevel(accessToken) {
    const payload = String(accessToken || '').split('.')[1];
    if (!payload) return null;
    try {
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)));
      return claims && (claims.aal === 'aal1' || claims.aal === 'aal2') ? claims.aal : null;
    } catch (err) {
      return null;
    }
  }

  /* From what mfa.listFactors() resolves to. Any verified factor is owed — the
     rule the database applies — but only an authenticator app (TOTP) can be
     challenged from the sign-in screen, so that is the one handed back. An
     unverified factor is an abandoned enrolment: no authenticator can produce
     its codes, so it is not owed. */
  function secondFactor(data) {
    const d = data || {};
    const all = Array.isArray(d.all)
      ? d.all
      : [].concat(Array.isArray(d.totp) ? d.totp : [], Array.isArray(d.phone) ? d.phone : []);
    const verified = all.filter(f => f && f.status === 'verified');
    const totp = verified.filter(f => (f.factor_type || f.factorType) === 'totp')[0];
    return Object.freeze({ owed: verified.length > 0, factorId: totp ? totp.id : null });
  }

  /* What a session may do.
     facts.level   the token's 'aal1' / 'aal2'
     facts.factor  'owed' | 'none' | 'failed' — not needed at aal2
     facts.lookup  the employees row: 'staff' | 'none' | 'failed' */
  function accessFor(facts) {
    const f = facts || {};
    if (!f.signedIn) return ACCESS.SIGNED_OUT;
    if (f.level !== 'aal2') {
      if (f.factor === 'owed') return ACCESS.NEEDS_CODE;
      if (f.factor !== 'none') return ACCESS.UNKNOWN;
    }
    if (f.lookup === 'staff') return ACCESS.STAFF;
    if (f.lookup === 'none') return ACCESS.NOT_STAFF;
    return ACCESS.UNKNOWN;
  }

  /* What the sign-in screen does with an answer: 'password', 'code', 'open',
     'refuse' or 'problem' before the workspace opens; 'stay' or 'reload' once
     it is open. Anything that means the open page no longer belongs to the
     person it opened for reloads — the only way to be sure none of their data
     is left in memory. A check that could not finish is not that. */
  function gateStep(access, where) {
    const w = where || {};
    if (w.opened) {
      if (!w.userId || w.userId !== w.openedUserId) return 'reload';
      return access === ACCESS.STAFF || access === ACCESS.UNKNOWN ? 'stay' : 'reload';
    }
    const screens = {
      [ACCESS.SIGNED_OUT]: 'password',
      [ACCESS.NEEDS_CODE]: 'code',
      [ACCESS.STAFF]: 'open',
      [ACCESS.NOT_STAFF]: 'refuse'
    };
    return screens[access] || 'problem';
  }

  const status = error => Number(error && error.status) || 0;

  /* A failure that is about the connection or a limit, not about what was
     typed. supabase-js reports a request that never arrived as
     AuthRetryableFetchError with status 0, and 502–504 with their status; a
     request the twenty-second limit in session.js gave up on is an AbortError.
     A TypeError counts only when it is the browser's network failure — any
     other TypeError is a bug, and "check your connection" would send someone
     looking in the wrong place. */
  function transport(error) {
    const e = error || {};
    if (status(e) === 429 || /rate_limit|too_many/.test(String(e.code || ''))) return MESSAGES.tooMany;
    if (e.name === 'AbortError'
        || (e.name === 'AuthRetryableFetchError' && status(e) === 0)
        || (e.name === 'TypeError' && NETWORK_FAILURE.test(String(e.message || '')))) return MESSAGES.offline;
    if (status(e) >= 500) return MESSAGES.down;
    return null;
  }

  /* An answer from the auth service, as opposed to something going wrong in
     the page before a request was even made. */
  const fromService = e => Boolean(e) && (/^Auth/.test(String(e.name || '')) || status(e) >= 400);

  /* Vague about every answer that is not the connection or a limit: "not
     confirmed" or "suspended" would tell someone guessing that the address has
     an account, and helps nobody who simply mistyped. */
  function signInMessage(error) {
    return transport(error) || (fromService(error) ? MESSAGES.credentials : MESSAGES.unexpected);
  }

  function codeMessage(error) {
    if (String((error && error.code) || '') === 'mfa_challenge_expired') return MESSAGES.expired;
    return transport(error) || (fromService(error) ? MESSAGES.code : MESSAGES.unexpected);
  }

  function challengeMessage(error) {
    return transport(error) || (fromService(error) ? MESSAGES.challenge : MESSAGES.unexpected);
  }

  /* Authenticators show "123 456"; a field limited to six characters kept five
     of those digits. */
  function codeDigits(value) {
    return String(value == null ? '' : value).replace(/\D/g, '').slice(0, CODE_LENGTH);
  }

  return Object.freeze({
    ACCESS, CODE_LENGTH, MESSAGES,
    tokenLevel, secondFactor, accessFor, gateStep,
    signInMessage, codeMessage, challengeMessage, codeDigits
  });
})();
