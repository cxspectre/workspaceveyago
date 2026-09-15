/* company-forms.js — inviting someone, changing a role or status, and
 * editing the studio's profile.
 *
 * As companyModel decides it, following the database (0042, 0016, 0061): only
 * an owner or admin invites or changes anyone; nobody their own role or
 * status; only an owner makes or changes an owner; and no change may leave
 * the studio without an owner who can sign in. Every choice offered here is
 * one companyModel.roleChoices/statusChoices/inviteForm already says would be
 * accepted — the database would refuse anything else regardless, but a
 * refusal on a form that just offered the choice reads as broken, not as a
 * rule, which is exactly what the admin's own member page takes care to avoid
 * (0042/0043).
 *
 * The People tab had no way to invite, change a role or deactivate anyone —
 * invite-employee already existed, the workspace just never called it.
 *
 * workspace.js draws the buttons this listens for (data-invite-open on the
 * People tab, data-employee-edit="<id>" on a person's page, data-studio-edit
 * on Studio). Every write goes through workspaceActions and reloads the
 * store. Tested in tests/company-forms.test.mjs.
 */
const companyForms = (function () {
  'use strict';

  const M = companyModel;
  const { field, say, quiet, closeDialog, sending, refocus } = dialogForms;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const text = value => String(value == null ? '' : value);
  const values = form => Object.fromEntries(new FormData(form).entries());
  /* A value as a CSS attribute selector quotes it (as notes-ui.js does). */
  const attr = value => text(value).replace(/["\\]/g, '\\$&');

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  function ready() {
    if (live()) return true;
    toast('Not yet: the workspace is still loading.');
    return false;
  }
  const viewer = () => (window.workspaceSession && workspaceSession.employee) || null;
  const heading = { selector: '#main h1', heading: true };

  /* ── Inviting ──────────────────────────────────────────────────────── */

  function roleOptionsHtml(roles, current) {
    return roles.map(r => `<option value="${esc(r.value)}"${r.value === current ? ' selected' : ''}${r.allowed ? '' : ' disabled'}>${esc(r.label)}</option>`).join('');
  }

  /* A note under the email field once it names someone already on the team —
     not a refusal: inviteForm() treats the same address as a re-invite, which
     invite-employee already knows how to do (it resends rather than doubles
     the row). Told before sending, not just after, the way crm-forms.js names
     a look-alike company before "Add contact" is pressed. */
  function updateExistingNote(form) {
    const note = form.querySelector('#invite-existing-note');
    if (!note) return;
    const checked = M.inviteForm(values(form), viewer(), team);
    note.hidden = !checked.existing;
    if (checked.existing) {
      note.textContent = checked.existing.name + ' is already on the team, as ' + checked.existing.roleLabel.toLowerCase()
        + (checked.existing.status === 'invited' ? ' — invited, not signed in yet. Sending this resends their invitation.' : '.');
    }
  }

  function openInvite() {
    if (!ready()) return;
    /* The button that opens this is already manager-only; asked directly —
       a stale page, a crafted click — the same rule that would refuse the
       send refuses opening the dialog at all, exactly as openEmployeeChange
       already does for a change nothing here would accept. */
    const blank = M.inviteForm({}, viewer(), team);
    if (blank.refusal) { toast(blank.refusal); return; }
    const roles = blank.roles;
    showModal('COMPANY · INVITE', '<h2>Invite someone</h2>'
      + '<p class="form-note">They get an email to set a password and sign in.</p>'
      + dialogForms.form('invite-form',
          field('Full name', '<input name="full_name" required autofocus autocomplete="off">')
          + field('Email', '<input name="email" type="email" required autocomplete="off">')
          + field('Role', `<select name="role">${roleOptionsHtml(roles, 'employee')}</select>`)
          + field('Title (optional)', '<input name="title" autocomplete="off">')
          + field('Start date (optional)', '<input name="start_date" type="date">')
          + '<p class="form-note" id="invite-existing-note" role="status" hidden></p>',
          'Send invitation'));
    const form = document.getElementById('invite-form');
    form.addEventListener('input', () => updateExistingNote(form));
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const checked = M.inviteForm(values(form), viewer(), team);
      const badField = Object.keys(checked.errors)[0];
      if (badField) { say(form, checked.errors[badField], badField); return; }
      if (checked.refusal) { say(form, checked.refusal); return; }
      const label = checked.reinvite ? 'Re-invited ' : 'Invited ';
      sending(form, () => workspaceActions.inviteEmployee(checked.payload), () => {
        toast(label + checked.payload.full_name + '.');
        refocus([{ selector: '[data-invite-open]' }, heading]);
      }, { part: 'team' });
    });
  }

  /* ── A role or status change ───────────────────────────────────────── */

  function choiceSelect(name, choice) {
    const current = (choice.choices.find(c => c.current) || {}).value || '';
    const opts = choice.choices.map(c =>
      `<option value="${esc(c.value)}"${c.value === current ? ' selected' : ''}${c.allowed || c.current ? '' : ' disabled'}>${esc(c.label)}</option>`).join('');
    const select = `<select name="${name}"${choice.editable ? '' : ' disabled'}>${opts}</select>`;
    return choice.editable ? select : select + `<small class="quiet-text">${esc(choice.reason || '')}</small>`;
  }

  function openEmployeeChange(member) {
    if (!ready()) return;
    const v = viewer();
    const roleChoice = M.roleChoices(v, member, team);
    const statusChoice = M.statusChoices(v, member, team);
    if (!roleChoice.editable && !statusChoice.editable) {
      toast(roleChoice.reason || statusChoice.reason || 'Nothing here can be changed.');
      return;
    }
    const currentRole = (roleChoice.choices.find(c => c.current) || {}).value || '';
    const currentStatus = (statusChoice.choices.find(c => c.current) || {}).value || '';
    showModal('COMPANY · PEOPLE', `<h2>Change ${esc(member.name)}’s role or status</h2>`
      + dialogForms.form('employee-change-form',
          field('Role', choiceSelect('role', roleChoice))
          + field('Status', choiceSelect('status', statusChoice))
          + '<p class="form-note" id="employee-change-note" role="status" hidden></p>',
          'Save'));
    const form = document.getElementById('employee-change-form');
    const statusField = form.querySelector('[name="status"]');
    const note = form.querySelector('#employee-change-note');
    const warn = () => {
      if (!statusField || !note) return;
      note.hidden = statusField.value !== 'inactive';
      note.textContent = 'They lose access immediately. Their record and history are kept.';
    };
    if (statusField) statusField.addEventListener('change', warn);
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const v2 = values(form);
      const changes = {};
      if (roleChoice.editable && v2.role !== currentRole) changes.role = v2.role;
      if (statusChoice.editable && v2.status !== currentStatus) changes.status = v2.status;
      if (!Object.keys(changes).length) { closeDialog(form); toast('Nothing changed.'); return; }
      const refusal = M.changeRefusal(v, member, team, changes);
      if (refusal) { say(form, refusal); return; }
      sending(form, () => workspaceActions.updateEmployee(member.id, changes), () => {
        toast('Saved.');
        refocus([{ selector: `[data-employee-edit="${attr(member.id)}"]` }, heading]);
      }, { record: `employee:${member.id}`, part: 'team' });
    });
  }

  /* ── The studio's profile ──────────────────────────────────────────── */

  function openStudio() {
    if (!ready()) return;
    const rows = (window.workspaceStore && workspaceStore.state.studioProfile) || [];
    const profile = M.studioProfile(rows);
    const before = { name: profile.name, tagline: profile.tagline, location: profile.location, email: profile.email, website: profile.website };
    showModal('COMPANY · STUDIO', '<h2>Edit studio profile</h2>'
      + '<p class="form-note">Shown to everyone on the team; owners and admins can change it.</p>'
      + dialogForms.form('studio-form',
          field('Name', `<input name="name" required autofocus value="${esc(before.name)}">`)
          + field('Tagline', `<input name="tagline" value="${esc(before.tagline)}">`)
          + field('Location', `<input name="location" value="${esc(before.location)}">`)
          + field('Contact email', `<input name="email" type="email" value="${esc(before.email)}">`)
          + field('Website', `<input name="website" value="${esc(before.website)}">`),
          'Save'));
    const form = document.getElementById('studio-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const v = values(form);
      const name = text(v.name).trim();
      if (!name) { say(form, 'Enter the studio’s name.', 'name'); return; }
      const email = text(v.email).trim();
      if (email && !EMAIL.test(email)) { say(form, 'Enter a valid email address, or leave it blank.', 'email'); return; }
      const typed = { name: name, tagline: text(v.tagline).trim(), location: text(v.location).trim(), email: email, website: text(v.website).trim() };
      const changes = {};
      Object.keys(M.STUDIO_KEYS).forEach(f => { if (typed[f] !== before[f]) changes[M.STUDIO_KEYS[f]] = typed[f]; });
      if (!Object.keys(changes).length) { closeDialog(form); toast('Nothing changed.'); return; }
      sending(form, () => workspaceActions.updateStudioProfile(changes), () => {
        toast('Studio profile saved.');
        refocus([{ selector: '[data-studio-edit]' }, heading]);
      }, { part: 'studioProfile' });
    });
  }

  /* ── What the buttons do ───────────────────────────────────────────── */

  document.addEventListener('click', e => {
    const at = selector => (e.target.closest ? e.target.closest(selector) : null);
    const invite = at('[data-invite-open]');
    if (invite) { e.preventDefault(); openInvite(); return; }
    const studio = at('[data-studio-edit]');
    if (studio) { e.preventDefault(); openStudio(); return; }
    const change = at('[data-employee-edit]');
    if (!change) return;
    e.preventDefault();
    if (!ready()) return;
    const member = (team || []).find(m => m && String(m.id) === String(change.dataset.employeeEdit));
    if (!member) { toast('That person is no longer on the team.'); return; }
    openEmployeeChange(member);
  });

  return Object.freeze({ openInvite, openEmployeeChange, openStudio });
})();
