/* gate.js — the sign-in screen.
 *
 * The workspace shows real client correspondence and, for a manager, real
 * money. It does not open until someone is signed in, has entered their second
 * factor if their account has one, AND has an active employees row — because
 * RLS refuses everything otherwise, and an app that renders empty panels to a
 * stranger looks broken rather than closed.
 *
 * WHAT THE SCREEN DOES IS DECIDED IN ONE PLACE: accessModel.gateStep()
 * (data/access.js, tested), from the session's answer (data/session.js).
 * Every way in — a page load with a stored session, the password form, the
 * code form, an auth event from another tab — ends in reconcile(), which asks
 * that one question. There used to be three doors: the password form checked
 * the second factor, but a reload or a session event opened the workspace for
 * any member of staff, code or no code. tests/gate.test.mjs holds this wiring
 * to it.
 *
 * Once the workspace is open the question keeps being asked, on every auth
 * event. A session that ends — signed out in another tab, expired, replaced by
 * someone else's, an employee made inactive — reloads the page, the only way
 * to be sure nothing of theirs stays on screen or in memory.
 */
(function () {
  'use strict';

  var session = window.workspaceSession;
  var sb = session && session.client;
  if (!sb) { console.error('[workspace] no Supabase client — gate cannot run.'); return; }

  var A = accessModel;
  var app = document.querySelector('.app');

  var gate, form, emailEl, pwEl, codeEl, submitBtn, msgEl, subEl, stepPw, pwField, stepCode, backBtn, forgotBtn;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  /* Password and two-factor settings live in the admin (veyagocloud). */
  var ACCOUNT_URL = window.VEYAGO_ACCOUNT_URL || 'https://veyago.cloud/admin/account/';
  var factorId = null, challengeId = null;
  /* The screen that is up: checking, password, refused, code, problem, leaving
     — or open, once the gate is out of the way. */
  var mode = 'checking';
  /* A step is waiting on the server. Session events that arrive meanwhile are
     left to it: it reconciles when it finishes, with the newest answer. */
  var working = false;
  /* Opened once per page. Signing out reloads, so a second open could only be
     a duplicate — and it used to load everything twice. */
  var opened = false, openedUserId = null;

  var LABELS = { password: 'Sign in', refused: 'Sign in', forgot: 'Send reset link', code: 'Verify', problem: 'Try again', leaving: 'Reload' };
  var SUBTITLES = {
    checking: 'Checking your sign-in…',
    password: 'Sign in to continue.',
    refused: 'Sign in to continue.',
    forgot: 'We’ll email you a link to choose a new password.',
    code: 'Enter the code from your authenticator.',
    problem: 'Your sign-in could not be checked.',
    leaving: 'Your session has ended.'
  };

  /* `leaving` tells mail.js not to hold the reload up with its unsent-draft
     prompt: the session is over, the draft cannot be sent from here, and the
     prompt would only keep a locked page open. */
  var gateApi = { close: close, leaving: false };
  window.workspaceGate = gateApi;

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function build() {
    gate = el('div', 'gate');
    gate.id = 'gate';
    gate.innerHTML =
      '<div class="gate-card">' +
        '<span class="gate-mark" aria-hidden="true">V</span>' +
        '<h1>Veyago Workspace</h1>' +
        '<p id="gate-sub"></p>' +
        '<form class="gate-form" id="gate-form" novalidate>' +
          '<div id="step-pw" hidden>' +
            '<label for="gate-email">Email</label>' +
            '<input id="gate-email" type="email" autocomplete="username" required>' +
            '<div id="pw-field">' +
              '<label for="gate-pw" style="margin-top:10px;display:block">Password</label>' +
              '<input id="gate-pw" type="password" autocomplete="current-password" required>' +
            '</div>' +
          '</div>' +
          '<div id="step-code" hidden>' +
            '<label for="gate-code">Six-digit code</label>' +
            /* No maxlength: six characters cut "123 456", pasted from an
               authenticator, to five digits. The input handler keeps digits. */
            '<input id="gate-code" class="gate-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*">' +
          '</div>' +
          '<button class="btn btn-primary" id="gate-submit" type="submit" hidden>Sign in</button>' +
        '</form>' +
        '<p class="gate-msg" id="gate-msg" role="status" aria-live="polite"></p>' +
        '<button class="gate-back" id="gate-back" type="button" hidden>Use a different account</button>' +
        '<button class="gate-link" id="gate-forgot" type="button" hidden>Forgot your password?</button>' +
      '</div>';
    document.body.appendChild(gate);

    form      = gate.querySelector('#gate-form');
    emailEl   = gate.querySelector('#gate-email');
    pwEl      = gate.querySelector('#gate-pw');
    codeEl    = gate.querySelector('#gate-code');
    submitBtn = gate.querySelector('#gate-submit');
    msgEl     = gate.querySelector('#gate-msg');
    subEl     = gate.querySelector('#gate-sub');
    stepPw    = gate.querySelector('#step-pw');
    stepCode  = gate.querySelector('#step-code');
    backBtn   = gate.querySelector('#gate-back');
    pwField   = gate.querySelector('#pw-field');
    forgotBtn = gate.querySelector('#gate-forgot');

    form.addEventListener('submit', onSubmit);
    backBtn.addEventListener('click', onBack);
    forgotBtn.addEventListener('click', function () { if (!working) show('forgot'); });
    codeEl.addEventListener('input', function () {
      var digits = A.codeDigits(codeEl.value);
      if (digits !== codeEl.value) codeEl.value = digits;
    });
    show('checking');
  }

  function say(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'gate-msg' + (kind ? ' ' + kind : '');
  }

  function busy(on, label) {
    submitBtn.disabled = !!on;
    submitBtn.textContent = on ? label : (LABELS[mode] || 'Sign in');
  }

  /* inert as well as blurred: a blurred app could still be reached with Tab,
     and "/" focused its search box from behind the sign-in screen. The dialog
     sits outside the app and, once open, above the gate — so it is closed and
     made inert too. */
  function lock() {
    app.classList.add('locked');
    app.inert = true;
    var dialog = document.getElementById('modal');
    if (dialog) {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      dialog.inert = true;
    }
  }

  function unlock() {
    app.classList.remove('locked');
    app.inert = false;
    var dialog = document.getElementById('modal');
    if (dialog) dialog.inert = false;
  }

  /* One screen, with nothing of the last one left on it, and focus on the one
     thing to do there. */
  function show(next) {
    mode = next;
    gate.hidden = false;
    stepPw.hidden = next !== 'password' && next !== 'refused' && next !== 'forgot';
    pwField.hidden = next === 'forgot';
    stepCode.hidden = next !== 'code';
    submitBtn.hidden = !LABELS[next];
    backBtn.hidden = next !== 'code' && next !== 'problem' && next !== 'forgot';
    backBtn.textContent = next === 'forgot' ? 'Back to sign in' : 'Use a different account';
    forgotBtn.hidden = next !== 'password' && next !== 'refused';
    subEl.textContent = SUBTITLES[next] || '';
    busy(false);
    say('');
    var target = { password: emailEl, refused: emailEl, forgot: emailEl, code: codeEl, problem: submitBtn, leaving: submitBtn }[next];
    if (target) target.focus();
  }

  function reconcile() {
    if (working || mode === 'leaving') return;
    var step = A.gateStep(session.access, { opened: opened, openedUserId: openedUserId, userId: session.userId });
    if (step === 'open') open();
    else if (step === 'reload') leave();
    else if (step === 'code' && mode !== 'code') askForCode();
    else if (step === 'password' && mode !== 'password' && mode !== 'refused' && mode !== 'forgot') showPassword();
    else if (step === 'refuse' && mode !== 'refused') refuse();
    else if (step === 'problem' && mode !== 'problem') showProblem();
  }

  /* A step that talks to the server. Session events wait for it, and one that
     throws still ends — with a message, the button back, and events listened
     to again — so the screen is never stuck. */
  async function run(work) {
    working = true;
    try {
      await work();
    } catch (err) {
      console.error('[workspace] sign-in step failed:', err);
      say(A.MESSAGES.unexpected, 'err');
    } finally {
      working = false;
      busy(false);
    }
    reconcile();
  }

  function attempt(call) {
    return Promise.resolve().then(call).catch(function (err) { return { error: err }; });
  }

  function showPassword() {
    factorId = challengeId = null;
    codeEl.value = '';
    show('password');
  }

  function onSubmit(e) {
    e.preventDefault();
    if (working) return;
    if (mode === 'password' || mode === 'refused') return passwordStep();
    if (mode === 'forgot') return forgotStep();
    if (mode === 'code') return codeStep();
    if (mode === 'problem') return retry();
    if (mode === 'leaving') location.reload();
  }

  function passwordStep() {
    var email = emailEl.value.trim();
    var password = pwEl.value;
    if (!email || !password) { say('Enter your email and password.', 'err'); return; }

    return run(async function () {
      busy(true, 'Signing in…');
      say('');
      var res = await attempt(function () {
        return sb.auth.signInWithPassword({ email: email, password: password });
      });
      if (res.error) {
        say(A.signInMessage(res.error), 'err');
        pwEl.select();
        return;
      }
      pwEl.value = '';
      busy(true, 'Checking…');
      await session.refresh();
      /* A fresh sign-in, whatever the last one was refused for. */
      mode = 'password';
    });
  }

  function askForCode() {
    show('code');
    pwEl.value = '';
    codeEl.value = '';
    factorId = session.factorId;
    challengeId = null;
    if (!factorId) {
      submitBtn.hidden = true;
      stepCode.hidden = true;
      say('This account’s second factor can’t be used on this screen. ' +
          'Use a different account, or ask an owner for help.', 'err');
      backBtn.focus();
      return;
    }
    return run(async function () {
      busy(true, 'Preparing…');
      await challenge();
    });
  }

  /* A challenge is single-use: each try at a code needs its own. */
  async function challenge() {
    challengeId = null;
    var res = await attempt(function () { return sb.auth.mfa.challenge({ factorId: factorId }); });
    if (res.error || !res.data) {
      say(A.challengeMessage(res.error), 'err');
      return false;
    }
    challengeId = res.data.id;
    return true;
  }

  function codeStep() {
    var code = A.codeDigits(codeEl.value);
    if (code.length !== A.CODE_LENGTH) { say('Enter the six-digit code from your authenticator.', 'err'); return; }
    if (!factorId) return;

    return run(async function () {
      busy(true, 'Verifying…');
      say('');
      if (challengeId === null && !(await challenge())) return;
      var res = await attempt(function () {
        return sb.auth.mfa.verify({ factorId: factorId, challengeId: challengeId, code: code });
      });
      challengeId = null;
      if (res.error) {
        say(A.codeMessage(res.error), 'err');
        codeEl.select();
        return;
      }
      busy(true, 'Opening…');
      await session.refresh();
      if (session.access === A.ACCESS.NEEDS_CODE) {
        say('The code was accepted, but signing in did not finish. Enter the current code again.', 'err');
        codeEl.value = '';
        codeEl.focus();
      }
    });
  }

  function showProblem() {
    show('problem');
    say('Check your connection, then try again.', 'err');
  }

  function retry() {
    return run(async function () {
      busy(true, 'Checking…');
      say('');
      await session.refresh();
      if (session.access === A.ACCESS.UNKNOWN) {
        say('Still could not check your sign-in. Check your connection, then try again.', 'err');
      }
    });
  }

  /* Signed in is not the same as allowed in. The session is ended in this
     browser only: the same account may be signed in to other apps that share
     the project, where it is welcome. */
  function refuse() {
    show('refused');
    say('That account is signed in, but it is not an active team member. ' +
        'Ask an owner to add you in Company → People.', 'err');
    return run(function () { return session.signOut(); });
  }

  function useAnotherAccount() {
    if (working) return;
    showPassword();
    return run(function () { return session.signOut(); });
  }

  function onBack() {
    if (mode === 'forgot') {
      if (!working) showPassword();
      return;
    }
    return useAnotherAccount();
  }

  /* A reset link, sent by request-password-reset (veyagocloud), which answers
     the same whether or not the address has an account. The link opens the
     admin's choose-a-password page — which asks for the second factor first
     when the account has one — and the new password then works here. */
  function forgotStep() {
    var email = emailEl.value.trim();
    if (!EMAIL.test(email)) { say('Enter the email address you sign in with.', 'err'); return; }
    return run(async function () {
      busy(true, 'Sending…');
      say('');
      var res = await attempt(function () {
        return sb.functions.invoke('request-password-reset', { body: { email: email } });
      });
      if (res.error) {
        say(res.error.name === 'FunctionsFetchError'
          ? A.MESSAGES.offline
          : 'The reset link could not be sent right now. Try again in a moment.', 'err');
        return;
      }
      say('If that address has an account, a reset link is on its way. It opens a page to choose a ' +
          'new password; then sign in here with it.', 'ok');
    });
  }

  /* The page belongs to a session that is over. */
  function leave() {
    gateApi.leaving = true;
    lock();
    show('leaving');
    location.reload();
  }

  /* The header shipped with a static "C" avatar and a "Demo workspace" chip.
     Both are now claims the app can check, and a dashboard showing real client
     mail should say whose session it is — not least so a shared screen makes
     it obvious when it is the wrong one. */
  function paintHeader() {
    var me = window.workspaceSession.employee;
    if (!me) return;
    var initials = window.workspaceData
      ? window.workspaceData.initials(me.full_name)
      : me.full_name.charAt(0).toUpperCase();

    var label = document.querySelector('.demo-label');
    var role = me.title || me.role.charAt(0).toUpperCase() + me.role.slice(1);
    if (label) label.textContent = role;

    /* The sidebar's profile link said "Cassian, workspace owner", with a "C",
       for everyone who signed in. */
    var profile = document.querySelector('.sidebar .profile');
    if (profile) {
      profile.setAttribute('aria-label', me.full_name + ', ' + role);
      var badge = profile.querySelector('.avatar');
      if (badge) badge.textContent = initials;
    }

    var avatar = document.querySelector('.header-avatar');
    if (!avatar || avatar.dataset.sessionChip) return;

    var chip = el('div', 'session-chip');
    chip.dataset.sessionChip = '1';
    chip.innerHTML =
      '<span class="session-name">' + esc(me.full_name) + '</span>' +
      '<span class="avatar owner">' + esc(initials) + '</span>' +
      '<a class="session-account" href="' + esc(ACCOUNT_URL) + '" target="_blank" rel="noopener" ' +
         'title="Password and two-factor" aria-label="Password and two-factor (opens the admin)">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>' +
        '</svg>' +
      '</a>' +
      '<button class="session-signout" type="button" title="Sign out" aria-label="Sign out">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>' +
        '</svg>' +
      '</button>';
    chip.querySelector('.session-signout').addEventListener('click', function (e) {
      /* What someone left in Mail is theirs: a draft, its uploads, the
         signatures it loaded. The uploads are removed while their session can
         still remove them, and the page starts over afterwards, so whoever
         signs in next in this tab finds none of it. */
      var button = e.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.title = 'Signing out…';
      var closing = typeof mailComposer !== 'undefined' ? mailComposer.close() : null;
      Promise.resolve(closing)
        .catch(function () { return null; })
        .then(function () { return window.workspaceSession.signOut(); })
        .then(function () { location.reload(); }, function () { location.reload(); });
    });
    avatar.replaceWith(chip);
  }

  /* The app's own esc() lives in app.js, which may not have run yet when the
     gate is built; look it up at call time rather than capturing it. */
  function esc(s) {
    return typeof window.esc === 'function' ? window.esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
  }

  function open() {
    if (opened) return;
    opened = true;
    openedUserId = session.userId;
    mode = 'open';
    gate.hidden = true;
    pwEl.value = '';
    codeEl.value = '';
    say('');
    unlock();
    paintHeader();
    /* render() rebuilds the shell on every navigation, so the chip has to be
       re-applied after each one. */
    document.body.addEventListener('workspace:loaded', paintHeader);
    document.body.dispatchEvent(new CustomEvent('workspace:authed'));
  }

  /* Called by workspaceSession.signOut(). */
  function close() {
    if (opened) leave();
    else if (mode !== 'password' && mode !== 'refused' && mode !== 'forgot') showPassword();
  }

  /* Lock straight away. index.html ships the app locked and inert as well, so
     the shell stays closed even if this file never runs. */
  lock();
  build();

  session.ready().then(reconcile);
  document.body.addEventListener('workspace:session', reconcile);
})();
