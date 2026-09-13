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
 */
(function () {
  'use strict';

  var cfg = window.VEYAGO_SUPABASE || {};

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[workspace] Supabase client not loaded — check data/supabase.js.');
    return;
  }

  var sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'veyago.workspace.auth' }
  });

  var state = { session: null, employee: null, role: null, resolved: false };
  var waiters = [];

  function settle() {
    state.resolved = true;
    waiters.splice(0).forEach(function (fn) { fn(state); });
    document.body.dispatchEvent(new CustomEvent('workspace:session', { detail: state }));
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* The signed-in person's employees row. Everything the UI shows or hides
     keys off role, so it is fetched once per auth change and cached. */
  async function loadEmployee() {
    if (!state.session) { state.employee = null; state.role = null; return; }

    for (var attempt = 0; attempt < 4; attempt++) {
      var res = await sb
        .from('employees')
        .select('id, full_name, email, role, title, status')
        .eq('user_id', state.session.user.id)
        .maybeSingle();

      if (res.error) {
        console.warn('[workspace] employee lookup failed:', res.error.message);
      } else if (res.data) {
        /* An inactive employee is not staff as far as the database is
           concerned (employee_role() filters on status), so the client agrees
           — or the UI offers actions every query will refuse. */
        state.employee = res.data.status !== 'inactive' ? res.data : null;
        state.role = state.employee ? state.employee.role : null;
        return;
      }
      /* No row and no error: either genuinely not a team member, or the token
         is not live yet. Both look identical from here, so wait and ask again
         before deciding. */
      if (attempt < 3) await sleep(250 * (attempt + 1));
    }
    state.employee = null;
    state.role = null;
  }

  sb.auth.onAuthStateChange(function (event, session) {
    state.session = session || null;
    /* Out of the callback before doing any work: supabase holds its auth lock
       for the duration, and a network round trip inside it blocks every other
       auth operation on the page. */
    setTimeout(async function () {
      await loadEmployee();
      settle();
    }, 0);
  });

  /* If no auth event ever arrives (a provider hiccup, a blocked storage API),
     resolve as signed-out rather than leaving the page waiting on nothing. */
  setTimeout(function () { if (!state.resolved) settle(); }, 4000);

  window.workspaceSession = {
    client: sb,

    /* Resolves once the JWT is genuinely usable. Query inside it, never before. */
    ready: function () {
      return new Promise(function (resolve) {
        if (state.resolved) return resolve(state);
        waiters.push(resolve);
      });
    },

    get session()  { return state.session; },
    get employee() { return state.employee; },
    get role()     { return state.role; },

    isSignedIn: function () { return !!state.session; },
    isStaff:    function () { return !!state.role; },
    isManager:  function () { return state.role === 'owner' || state.role === 'admin'; },

    signIn: function (email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password });
    },

    /* Re-read the employees row for the session we already hold. Deliberately
       does NOT ask for the session again — see trap 1 at the top. */
    refresh: async function () {
      await loadEmployee();
      return state;
    },

    signOut: async function () {
      await sb.auth.signOut();
      state.session = null; state.employee = null; state.role = null;
      if (window.workspaceGate) window.workspaceGate.close();
    }
  };
})();
