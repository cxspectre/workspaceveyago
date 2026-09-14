/* gate.js — the sign-in screen.
 *
 * The workspace shows real client correspondence and, for a manager, real
 * money. It does not open until someone is signed in AND has an active
 * employees row, because RLS will refuse everything otherwise and an app that
 * renders empty panels to a stranger looks broken rather than closed.
 *
 * TOTP: /admin enrols second factors, and an account with one must clear it
 * here too. Supabase reports that as nextLevel === 'aal2' — a session that
 * exists but is not yet trusted. Skipping that check would leave anyone with
 * MFA on unable to get in at all, because every query would still be refused.
 */
(function () {
  'use strict';

  var sb = window.workspaceSession && window.workspaceSession.client;
  if (!sb) { console.error('[workspace] no Supabase client — gate cannot run.'); return; }

  var gate, form, emailEl, pwEl, codeEl, submitBtn, msgEl, stepPw, stepCode, backBtn;
  var factorId = null, challengeId = null;

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
        '<p id="gate-sub">Sign in to continue.</p>' +
        '<form class="gate-form" id="gate-form" novalidate>' +
          '<div id="step-pw">' +
            '<label for="gate-email">Email</label>' +
            '<input id="gate-email" type="email" autocomplete="username" required>' +
            '<label for="gate-pw" style="margin-top:10px;display:block">Password</label>' +
            '<input id="gate-pw" type="password" autocomplete="current-password" required>' +
          '</div>' +
          '<div id="step-code" hidden>' +
            '<label for="gate-code">Six-digit code</label>' +
            '<input id="gate-code" class="gate-code" inputmode="numeric" autocomplete="one-time-code" ' +
                   'maxlength="6" pattern="[0-9]*">' +
          '</div>' +
          '<button class="btn btn-primary" id="gate-submit" type="submit">Sign in</button>' +
        '</form>' +
        '<p class="gate-msg" id="gate-msg" role="status" aria-live="polite"></p>' +
        '<button class="gate-back" id="gate-back" type="button" hidden>Use a different account</button>' +
      '</div>';
    document.body.appendChild(gate);

    form      = gate.querySelector('#gate-form');
    emailEl   = gate.querySelector('#gate-email');
    pwEl      = gate.querySelector('#gate-pw');
    codeEl    = gate.querySelector('#gate-code');
    submitBtn = gate.querySelector('#gate-submit');
    msgEl     = gate.querySelector('#gate-msg');
    stepPw    = gate.querySelector('#step-pw');
    stepCode  = gate.querySelector('#step-code');
    backBtn   = gate.querySelector('#gate-back');

    form.addEventListener('submit', onSubmit);
    backBtn.addEventListener('click', reset);
  }

  function say(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'gate-msg' + (kind ? ' ' + kind : '');
  }

  function busy(on, label) {
    submitBtn.disabled = !!on;
    submitBtn.textContent = on ? (label || 'Signing in…') : (stepCode.hidden ? 'Sign in' : 'Verify');
  }

  function reset() {
    factorId = challengeId = null;
    stepCode.hidden = true;
    stepPw.hidden = false;
    backBtn.hidden = true;
    codeEl.value = '';
    gate.querySelector('#gate-sub').textContent = 'Sign in to continue.';
    say('');
    busy(false);
    emailEl.focus();
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitBtn.disabled) return;
    return stepCode.hidden ? passwordStep() : codeStep();
  }

  async function passwordStep() {
    var email = emailEl.value.trim();
    var password = pwEl.value;
    if (!email || !password) { say('Enter your email and password.', 'err'); return; }

    busy(true);
    say('');
    var res = await sb.auth.signInWithPassword({ email: email, password: password });
    if (res.error) {
      busy(false);
      /* Deliberately vague: confirming that an address exists is a favour to
         someone guessing, and no help at all to the person who mistyped. */
      say('That email and password do not match.', 'err');
      pwEl.select();
      return;
    }

    var level = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    var next = level && level.data && level.data.nextLevel;
    var current = level && level.data && level.data.currentLevel;
    if (next === 'aal2' && current !== 'aal2') return askForCode();

    return admit();
  }

  async function askForCode() {
    var list = await sb.auth.mfa.listFactors();
    var d = (list && list.data) || {};
    var factors = Array.isArray(d.totp) ? d.totp
                : Array.isArray(d.all) ? d.all.filter(function (f) {
                    return f.factor_type === 'totp' || f.factorType === 'totp';
                  })
                : [];
    var verified = factors.filter(function (f) { return f.status === 'verified'; });
    if (!verified.length) {
      /* An abandoned enrolment leaves an unverified factor. Prompting for a
         code no authenticator can produce would strand the person, so treat it
         as no second factor and let them in. */
      return admit();
    }

    factorId = verified[0].id;
    var ch = await sb.auth.mfa.challenge({ factorId: factorId });
    if (ch.error) { busy(false); say(ch.error.message, 'err'); return; }
    challengeId = ch.data.id;

    stepPw.hidden = true;
    stepCode.hidden = false;
    backBtn.hidden = false;
    gate.querySelector('#gate-sub').textContent = 'Enter the code from your authenticator.';
    busy(false);
    say('');
    codeEl.focus();
  }

  async function codeStep() {
    var code = codeEl.value.replace(/\s/g, '');
    if (code.length !== 6) { say('That code is six digits.', 'err'); return; }
    busy(true, 'Verifying…');
    var res = await sb.auth.mfa.verify({ factorId: factorId, challengeId: challengeId, code: code });
    if (res.error) {
      busy(false);
      say('That code was not accepted. Codes expire quickly — try the next one.', 'err');
      codeEl.select();
      /* A challenge is single-use: a fresh one, or the next code fails too. */
      var ch = await sb.auth.mfa.challenge({ factorId: factorId });
      if (!ch.error) challengeId = ch.data.id;
      return;
    }
    return admit();
  }

  /* Signed in is not the same as allowed in. */
  async function admit() {
    busy(true, 'Opening…');
    await window.workspaceSession.refresh();

    if (!window.workspaceSession.isStaff()) {
      await window.workspaceSession.signOut();
      busy(false);
      say('That account is signed in, but it is not an active team member. ' +
          'Ask an owner to add you in Company → People.', 'err');
      return;
    }

    say('');
    open();
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
    if (label) label.textContent = me.title || me.role.charAt(0).toUpperCase() + me.role.slice(1);

    var avatar = document.querySelector('.header-avatar');
    if (!avatar || avatar.dataset.sessionChip) return;

    var chip = el('div', 'session-chip');
    chip.dataset.sessionChip = '1';
    chip.innerHTML =
      '<span class="session-name">' + esc(me.full_name) + '</span>' +
      '<span class="avatar owner">' + esc(initials) + '</span>' +
      '<button class="session-signout" type="button" title="Sign out" aria-label="Sign out">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>' +
        '</svg>' +
      '</button>';
    chip.querySelector('.session-signout').addEventListener('click', function () {
      /* What someone left in Mail is theirs: a draft, its uploads, the
         signatures it loaded. The uploads are removed while their session can
         still remove them, and the page starts over afterwards, so whoever
         signs in next in this tab finds none of it. */
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
    gate.hidden = true;
    document.querySelector('.app').classList.remove('locked');
    paintHeader();
    document.body.dispatchEvent(new CustomEvent('workspace:authed'));
    /* render() rebuilds the shell on every navigation, so the chip has to be
       re-applied after each one. */
    document.body.addEventListener('workspace:loaded', paintHeader);
  }

  function close() {
    if (gate) { gate.hidden = false; reset(); }
    document.querySelector('.app').classList.add('locked');
  }

  window.workspaceGate = { open: open, close: close };

  /* Lock immediately, before anything renders — the shell must never be
     readable to someone who has not signed in, even for one frame. */
  document.querySelector('.app').classList.add('locked');
  build();

  function decide() {
    if (window.workspaceSession.isStaff()) open();
    else { gate.hidden = false; reset(); }
  }

  window.workspaceSession.ready().then(decide);

  /* The employee lookup retries when the token is not live yet, so "not staff"
     can become "staff" a moment later. Re-deciding on every session event means
     that resolves into an open door rather than a locked one. */
  document.body.addEventListener('workspace:session', function () {
    if (window.workspaceSession.isStaff() && gate && !gate.hidden) open();
  });
})();
