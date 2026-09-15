/* session.js — who is signed in, and what they are allowed to see.
 *
 * TWO TRAPS, BOTH LEARNED HERE RATHER THAN READ ABOUT.
 *
 * 1. NEVER CALL sb.auth.getSession(). supabase-js serialises auth work behind
 *    a lock, and anything that reaches for the session while that lock is held
 *    — most easily, from inside an onAuthStateChange handler — waits forever.
 *    A promise that never settles is the worst failure shape available: no
 *    error, no timeout, a screen that simply stays where it is. So the session
 *    is only ever taken from the auth event, which hands it to us directly.
 *    onAuthStateChange fires INITIAL_SESSION on startup whether or not anyone
 *    is signed in, so nothing is lost by not asking.
 *
 * 2. THE RLS TIMING TRAP (the same one /admin/js/auth.js documents). A query
 *    fired before the JWT is genuinely active runs as nobody: RLS sees
 *    auth.uid() = null and every private row comes back empty, which reads as
 *    "there is no data" rather than "you asked too early". So the employee
 *    lookup retries a few times before concluding that someone is not staff —
 *    and the work happens outside the auth callback, never inside it.
 *
 * AND TWO RULES, FROM data/access.js.
 *
 * 3. Every auth event is checked for a second factor that is still owed
 *    BEFORE the employees row is read, and the row is not asked for until the
 *    code is in: a password alone is not a way in.
 *
 * 4. A check that could not finish says so — access 'unknown', never "not a
 *    team member" — and keeps what was known about the same person.
 *
 * Every auth event starts a fresh check, and only the newest may land: an
 * answer about a session that has since been replaced (the aal1 session of a
 * moment before its code was verified, or one signed out in another tab while
 * it was being checked) is thrown away.
 */
(function () {
  'use strict';

  var cfg = window.VEYAGO_SUPABASE || {};

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[workspace] Supabase client not loaded — check data/supabase.js.');
    return;
  }

  var STORAGE_KEY = 'veyago.workspace.auth';
  var REQUEST_TIMEOUT_MS = 20000;
  var LOOKUP_ATTEMPTS = 4;
  var NO_EVENT_MS = 4000;
  var LAST_RESORT_MS = 30000;

  /* Auth and database requests give up after twenty seconds. supabase-js has
     no time limit of its own, and a sign-in or a lookup that never answered
     left the sign-in screen waiting for good. Uploads and Edge Functions are
     left alone: a 50 MB file can take longer than that. */
  function timedFetch(input, init) {
    var url = typeof input === 'string' ? input : String((input && (input.href || input.url)) || '');
    if (!/\/(auth|rest)\/v1\//.test(url) || (init && init.signal) || typeof AbortController === 'undefined') {
      return fetch(input, init);
    }
    var controller = new AbortController();
    /* Not cleared when the headers arrive: a body that stalls after them hangs
       the query just the same. Aborting a request that finished does nothing. */
    setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(input, Object.assign({}, init, { signal: controller.signal }));
  }

  var sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: STORAGE_KEY },
    global: { fetch: timedFetch }
  });

  var A = accessModel;

  var state = {
    session: null, employee: null, role: null,
    access: A.ACCESS.SIGNED_OUT, factorId: null, userId: null, resolved: false
  };
  /* Whose employees row state.employee is: a failed check keeps it only for
     the same person. */
  var employeeUserId = null;
  var waiters = [];
  var generation = 0;
  var latest = Promise.resolve();
  var sawEvent = false;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function userOf(session) { return session && session.user ? session.user.id : null; }

  function settle() {
    state.resolved = true;
    waiters.splice(0).forEach(function (fn) { fn(state); });
    document.body.dispatchEvent(new CustomEvent('workspace:session', { detail: state }));
  }

  /* 'owed', 'none' or 'failed', and the factor to challenge. A token that
     already says aal2 has had its code entered: nothing to ask. */
  async function secondFactor(session) {
    if (A.tokenLevel(session.access_token) === 'aal2') return { factor: 'cleared', factorId: null };
    try {
      var res = await sb.auth.mfa.listFactors();
      if (res.error) throw res.error;
      var found = A.secondFactor(res.data);
      return { factor: found.owed ? 'owed' : 'none', factorId: found.factorId };
    } catch (err) {
      console.warn('[workspace] could not read the second factors:', err && err.message);
      return { factor: 'failed', factorId: null };
    }
  }

  /* The signed-in person's employees row: 'staff', 'none' or 'failed'.
     Everything the UI shows or hides keys off its role. */
  async function lookupEmployee(session) {
    var failed = false;
    for (var attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt++) {
      var res;
      try {
        res = await sb
          .from('employees')
          .select('id, full_name, email, role, title, status')
          .eq('user_id', session.user.id)
          .maybeSingle();
      } catch (err) {
        res = { data: null, error: err };
      }

      if (res.error) {
        failed = true;
        console.warn('[workspace] employee lookup failed:', res.error.message);
      } else if (res.data) {
        /* An inactive employee is not staff as far as the database is
           concerned (employee_role() filters on status), so the client agrees
           — or the UI offers actions every query will refuse. */
        var active = res.data.status !== 'inactive';
        return { lookup: active ? 'staff' : 'none', employee: active ? res.data : null };
      } else {
        /* No row and no error: either genuinely not a team member, or the token
           is not live yet. Both look identical from here, so wait and ask again
           before deciding. */
        failed = false;
      }
      if (attempt < LOOKUP_ATTEMPTS - 1) await sleep(250 * (attempt + 1));
    }
    return { lookup: failed ? 'failed' : 'none', employee: null };
  }

  async function inspect(session) {
    if (!session) return { access: A.accessFor({ signedIn: false }), employee: null, factorId: null };
    var level = A.tokenLevel(session.access_token);
    var second = await secondFactor(session);
    /* Stopped before the team check even for a member of staff: the code is
       owed, or whether it is could not be found out. */
    var before = A.accessFor({ signedIn: true, level: level, factor: second.factor, lookup: 'staff' });
    if (before !== A.ACCESS.STAFF) return { access: before, employee: null, factorId: second.factorId };

    var found = await lookupEmployee(session);
    return {
      access: A.accessFor({ signedIn: true, level: level, factor: second.factor, lookup: found.lookup }),
      employee: found.employee,
      factorId: null
    };
  }

  function commit(session, found) {
    var userId = userOf(session);
    var keep = found.access === A.ACCESS.UNKNOWN && employeeUserId !== null && employeeUserId === userId;
    if (!keep) {
      state.employee = found.employee;
      employeeUserId = found.employee ? userId : null;
    }
    state.role = state.employee ? state.employee.role : null;
    state.access = found.access;
    state.factorId = found.factorId;
    state.userId = userId;
    settle();
  }

  /* Checks the session held now. Resolves with the newest answer, once no
     check that started later — or is about to start — is still running. */
  function evaluate() {
    var gen = ++generation;
    var session = state.session;
    var run = inspect(session)
      .catch(function (err) {
        console.error('[workspace] could not check the session:', err);
        return { access: session ? A.ACCESS.UNKNOWN : A.ACCESS.SIGNED_OUT, employee: null, factorId: null };
      })
      .then(function (found) {
        /* Newest, and still about the session held now: an auth event that has
           not had its own check yet has already replaced it. */
        if (gen === generation && session === state.session) commit(session, found);
      });
    latest = run;
    return newest();
  }

  function newest() {
    var seen = latest;
    return seen.then(function () {
      if (seen !== latest) return newest();
      if (scheduled) return scheduled;
      return state;
    });
  }

  /* A check that an auth event asked for and that has not started yet. Events
     arriving together — and a refresh() asked for right after the sign-in or
     the code that caused them — share it, rather than each reading the factors
     and the employees row again. */
  var scheduled = null;

  function schedule() {
    if (!scheduled) {
      scheduled = new Promise(function (resolve) {
        setTimeout(function () {
          scheduled = null;
          resolve(evaluate());
        }, 0);
      });
    }
    return scheduled;
  }

  function attemptSignOut(scope) {
    return Promise.resolve()
      .then(function () { return sb.auth.signOut({ scope: scope }); })
      .then(function (res) { return res || { error: null }; }, function (err) { return { error: err }; });
  }

  /* What signOut() removes from this browser — which supabase-js only does
     once the server has heard about it. */
  function forgetStoredSession() {
    try {
      [STORAGE_KEY, STORAGE_KEY + '-code-verifier', STORAGE_KEY + '-user'].forEach(function (key) {
        window.localStorage.removeItem(key);
      });
      return { error: null };
    } catch (err) {
      return { error: err };
    }
  }

  sb.auth.onAuthStateChange(function (event, session) {
    sawEvent = true;
    state.session = session || null;
    /* Out of the callback before doing any work: supabase holds its auth lock
       for the duration, and a network round trip inside it blocks every other
       auth operation on the page. */
    schedule();
  });

  function hasStoredSession() {
    try {
      return Boolean(window.localStorage && window.localStorage.getItem(STORAGE_KEY));
    } catch (err) {
      return false;
    }
  }

  /* If no auth event ever arrives (a provider hiccup, a blocked storage API),
     resolve as signed-out rather than leaving the page waiting on nothing. Not
     when an event did arrive and its check is only slow, and not while a
     stored session is still being refreshed — the next morning, on a slow
     link, that is the first thing supabase-js does. Either would show someone
     who is signed in the password form, then snatch it away. The last resort
     answers anyway, so the screen never waits for good. */
  setTimeout(function () {
    if (!sawEvent && !state.resolved && !hasStoredSession()) settle();
  }, NO_EVENT_MS);
  setTimeout(function () { if (!state.resolved) settle(); }, LAST_RESORT_MS);

  /* supabase-js tells other tabs about a sign-out only once the server has
     heard it. A tab that signed out offline just forgets the stored session,
     which every other tab hears as a storage event — or a cleared storage. */
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('storage', function (e) {
      if ((e.key !== STORAGE_KEY && e.key !== null) || e.newValue !== null || !state.session) return;
      state.session = null;
      schedule();
    });
  }

  window.workspaceSession = {
    client: sb,

    /* Resolves once the first check has an answer. Query after it, never before. */
    ready: function () {
      return new Promise(function (resolve) {
        if (state.resolved) return resolve(state);
        waiters.push(resolve);
      });
    },

    get session()  { return state.session; },
    get employee() { return state.employee; },
    get role()     { return state.role; },
    /* 'signed-out' | 'needs-code' | 'staff' | 'not-staff' | 'unknown' */
    get access()   { return state.access; },
    /* The authenticator to challenge while access is 'needs-code'. */
    get factorId() { return state.factorId; },
    /* The user the current answer is about. */
    get userId()   { return state.userId; },

    isSignedIn: function () { return !!state.session; },
    isStaff:    function () { return state.access === A.ACCESS.STAFF; },
    needsCode:  function () { return state.access === A.ACCESS.NEEDS_CODE; },
    isManager:  function () { return state.role === 'owner' || state.role === 'admin'; },

    signIn: function (email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password });
    },

    /* Checks the session we already hold again. Deliberately does NOT ask for
       the session — see trap 1 at the top. */
    refresh: function () { return scheduled || evaluate(); },

    /* Ends the session in this browser — not the person's sessions on every
       other device and in the admin, which 'global' would. When the server
       cannot be told, the session is still forgotten here: a sign-out that
       failed on the network used to leave it behind, and the reload after it
       opened the workspace again. */
    signOut: async function (scope) {
      /* Offline, the request could only time out — twenty seconds in which
         closing the tab would leave the session stored. Forget it here first. */
      var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      var res = offline ? forgetStoredSession() : await attemptSignOut(scope || 'local');
      if (res.error && !offline) {
        console.warn('[workspace] sign-out did not reach the server; forgetting the session in this browser:', res.error.message);
        res = forgetStoredSession();
      }
      if (res.error) return { error: res.error };
      state.session = null;
      await (scheduled || evaluate());
      if (window.workspaceGate) window.workspaceGate.close();
      return { error: null };
    }
  };
})();
