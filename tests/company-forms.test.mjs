/* company-forms.js's dialogs: inviting someone, changing a role or status,
 * and editing the studio's profile — each checked the way companyModel says
 * the database would check it (0042, 0016, 0061), so the form never offers,
 * or sends, a change the database would refuse. company-model.js and the
 * real dialog-forms.js are loaded beside it; the page's helpers and the
 * store are stand-ins that keep what they are given, as tests/crm-forms.test.mjs
 * already does for the CRM's own dialogs. Loaded into a sandbox the way
 * <script> tags run it. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const OWNER = 'e1000000-0000-4000-8000-000000000001';
const ADMIN = 'e1000000-0000-4000-8000-000000000003';
const EMPLOYEE = 'e1000000-0000-4000-8000-000000000005';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unescape = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* What a browser's FormData sends from the dialog showModal() was given
   (as tests/crm-forms.test.mjs's own fieldsOf does). */
function fieldsOf(html) {
  const values = {};
  for (const [tag, name] of html.matchAll(/<input\b[^>]*\bname="([^"]+)"[^>]*>/g)) {
    values[name] = unescape((tag.match(/\bvalue="([^"]*)"/) || [])[1] || '');
  }
  for (const [, name, inner] of html.matchAll(/<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const chosen = inner.match(/<option value="([^"]*)" selected>/) || inner.match(/<option value="([^"]*)"/);
    values[name] = unescape(chosen ? chosen[1] : '');
  }
  for (const [, name, inner] of html.matchAll(/<textarea\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    values[name] = unescape(inner);
  }
  return values;
}

/* A field named by its selector ([name="status"]) gets a live `value` tied to
   the form's own values, the way a real <select>'s does — company-forms.js
   reads it straight off the element in a change listener (as crm-forms.js
   already does for its own company-or-new toggle). */
function dialog(html) {
  const handlers = {};
  const parts = {};
  const values = fieldsOf(html);
  const part = selector => {
    if (parts[selector]) return parts[selector];
    const named = selector.match(/^\[name="([^"]+)"\]$/);
    const obj = {
      hidden: false, textContent: '', disabled: false, focused: 0, dataset: {}, attributes: {}, listeners: {},
      focus() { this.focused += 1; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; }
    };
    if (named) Object.defineProperty(obj, 'value', { get: () => values[named[1]], set: v => { values[named[1]] = v; } });
    parts[selector] = obj;
    return obj;
  };
  return {
    id: (html.match(/<form id="([^"]+)"/) || [])[1], values, isConnected: true, html,
    addEventListener: (type, fn) => { handlers[type] = fn; },
    querySelector: part,
    handlers
  };
}

/* An element a click lands on, with its data attributes. */
function target(attributes) {
  const dataset = Object.fromEntries(Object.entries(attributes).map(([name, value]) =>
    [name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));
  const element = { dataset };
  return { closest: selector => (selector.split(',').map(s => s.trim().replace(/^\[|\]$/g, '')).some(name => name in attributes) ? element : null) };
}

const member = (id, full_name, role, email, over = {}) => ({
  id, user_id: `u-${id.slice(-2)}`, email, full_name, role, title: null, status: 'active',
  start_date: null, created_at: '2026-01-05T10:00:00Z', updated_at: '2026-01-05T10:00:00Z', ...over
});
const cassian = member(OWNER, 'Cassian Drefke', 'owner', 'cassian@veyago.cloud');
const zoe = member(ADMIN, 'Zoë Adler', 'admin', 'zoe@veyago.cloud');
const bo = member(EMPLOYEE, 'Bo Berg', 'employee', 'bo@veyago.cloud');
const TEAM = [cassian, zoe, bo];

/* viewer: workspaceSession.employee. team: employees rows (companyModel reads
   the whole team, the current viewer included). refuse: what
   workspaceActions throws for, if anything. studioProfile: workspace_settings
   rows already stored. */
function load({ viewer = cassian, team = TEAM, refuse = null, studioProfile = [], loaded = true } = {}) {
  const listeners = {};
  const toasts = [];
  const modals = [];
  const writes = [];
  let form = null;
  const context = vm.createContext({
    console,
    esc: escape,
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); form = dialog(body); context.modal.open = true; },
    modal: { open: true, close() { this.open = false; } },
    team,
    workspaceSession: { employee: viewer },
    workspaceStore: {
      state: { loaded, studioProfile },
      mark: () => 1,
      loadedSince: () => true,
      after: (work, options) => Promise.resolve(work).catch(err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; })
    },
    workspaceActions: {
      inviteEmployee: async fields => {
        writes.push(['inviteEmployee', { ...fields }]);
        if (refuse === 'invite') throw new Error('Could not send the invitation.');
        return { ok: true, employee: { id: 'new-emp' } };
      },
      updateEmployee: async (id, changes) => {
        writes.push(['updateEmployee', id, { ...changes }]);
        if (refuse === 'update') throw Object.assign(new Error('That was not saved: it changed since this was opened, or the database no longer allows it here.'), { refused: true });
        return { id };
      },
      updateStudioProfile: async changes => {
        writes.push(['updateStudioProfile', { ...changes }]);
        if (refuse === 'studio') throw new Error('Could not save the studio profile.');
        return { ok: true };
      }
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => (form && form.id === id ? form : null),
      /* dialog-forms.js's refocus() looks for a place on the page once a
         dialog closes; there is none here, which it already handles as a
         page with nothing to focus. */
      querySelector: () => null
    },
    FormData: class { constructor(f) { this.f = f; } entries() { return Object.entries(this.f.values); } }
  });
  context.window = context;
  for (const file of ['company-model.js', 'dialog-forms.js', 'company-forms.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  const forms = vm.runInContext('companyForms', context);
  return {
    forms,
    click: attributes => (listeners.click || []).forEach(fn => fn({ target: target(attributes), preventDefault() {} })),
    form: () => form,
    fill: more => Object.assign(form.values, more),
    submit: async () => { form.handlers.submit({ preventDefault() {} }); await settle(); },
    body: () => modals.at(-1) && modals.at(-1).body,
    modalOpen: () => modals.length > 0,
    toasts, writes, modal: context.modal
  };
}

/* ── Inviting ─────────────────────────────────────────────────────────── */

test('inviting someone sends exactly what the form checked, and offers no role a manager may not give', () => {
  const h = load({ viewer: zoe });
  h.forms.openInvite();
  assert.doesNotMatch(h.body(), /<option value="owner"[^>]*selected/, 'owner is not selected by default');
  assert.match(h.body(), /<option value="owner" disabled>Owner<\/option>/, 'an admin cannot make someone an owner');
  h.fill({ full_name: 'Ana Lima', email: 'ana@northline.example', role: 'employee', title: '', start_date: '' });
  return h.submit().then(() => {
    assert.deepEqual(h.writes, [['inviteEmployee', {
      email: 'ana@northline.example', full_name: 'Ana Lima', role: 'employee', title: null, start_date: null
    }]]);
    assert.equal(h.toasts.at(-1), 'Invited Ana Lima.');
    assert.equal(h.modal.open, false);
  });
});

test('a non-manager is refused before the dialog even opens, the same as a crafted click on a hidden button', () => {
  const h = load({ viewer: bo });
  h.forms.openInvite();
  assert.equal(h.modalOpen(), false);
  assert.equal(h.toasts.at(-1), 'Only an owner or admin can invite someone.');
});

test('a blank name is refused on the form before anything is sent', async () => {
  const h = load();
  h.forms.openInvite();
  h.fill({ full_name: '', email: 'ana@northline.example', role: 'employee' });
  await h.submit();
  assert.equal(h.form().querySelector('.form-error').textContent, 'Enter their full name.');
  assert.equal(h.writes.length, 0);
});

test('an admin cannot make someone an owner even by forcing the value past the disabled option', async () => {
  const h = load({ viewer: zoe });
  h.forms.openInvite();
  h.fill({ full_name: 'New Owner', email: 'new@veyago.cloud', role: 'owner' });
  await h.submit();
  assert.equal(h.form().querySelector('.form-error').textContent, 'Only an owner can make someone an owner.');
  assert.equal(h.writes.length, 0);
});

test('inviting an address already on the team says so, and sending it resends rather than doubling the row', async () => {
  const h = load();
  h.forms.openInvite();
  h.fill({ full_name: 'Zoe Adler', email: 'zoe@veyago.cloud', role: 'admin' });
  h.form().handlers.input();
  assert.equal(h.form().querySelector('#invite-existing-note').hidden, false);
  await h.submit();
  assert.deepEqual(h.writes[0][0], 'inviteEmployee');
  assert.equal(h.toasts.at(-1), 'Re-invited Zoe Adler.');
});

/* ── Changing a role or status ───────────────────────────────────────── */

test('nobody is offered a dialog to change their own role or status', () => {
  const h = load({ viewer: cassian });
  h.forms.openEmployeeChange(cassian);
  assert.equal(h.modalOpen(), false);
  assert.match(h.toasts.at(-1), /own role or status/);
});

test('changing a status writes only that column, and warns before deactivating', async () => {
  const h = load({ viewer: cassian });
  h.forms.openEmployeeChange(bo);
  const note = h.form().querySelector('#employee-change-note');
  h.form().querySelector('[name="status"]').listeners.change();
  h.fill({ role: 'employee', status: 'inactive' });
  h.form().querySelector('[name="status"]').listeners.change();
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /lose access immediately/);
  await h.submit();
  assert.deepEqual(h.writes, [['updateEmployee', EMPLOYEE, { status: 'inactive' }]]);
  assert.equal(h.toasts.at(-1), 'Saved.');
});

test('an admin cannot make an employee an owner even by forcing the value', async () => {
  const h = load({ viewer: zoe });
  h.forms.openEmployeeChange(bo);
  h.fill({ role: 'owner', status: 'active' });
  await h.submit();
  assert.equal(h.form().querySelector('.form-error').textContent, 'Only an owner can make someone an owner.');
  assert.equal(h.writes.length, 0);
});

test('nothing changed is a toast, not a write', async () => {
  const h = load({ viewer: cassian });
  h.forms.openEmployeeChange(bo);
  h.fill({ role: 'employee', status: 'active' });
  await h.submit();
  assert.equal(h.writes.length, 0);
  assert.equal(h.toasts.at(-1), 'Nothing changed.');
  assert.equal(h.modal.open, false);
});

test('a change refused by the database says so on the dialog, and stays open', async () => {
  const h = load({ viewer: cassian, refuse: 'update' });
  h.forms.openEmployeeChange(bo);
  h.fill({ role: 'admin', status: 'active' });
  await h.submit();
  assert.match(h.form().querySelector('.form-error').textContent, /not saved/);
  assert.equal(h.modal.open, true, 'the dialog stays open on a refusal');
});

/* ── The studio's profile ─────────────────────────────────────────────── */

test('the studio profile form opens filled with what is stored, or the defaults with nothing stored', () => {
  const filled = load({ studioProfile: [{ key: 'studio_name', value: 'Northline Studio' }] });
  filled.forms.openStudio();
  assert.deepEqual(filled.form().values.name, 'Northline Studio');
  const blank = load({ studioProfile: [] });
  blank.forms.openStudio();
  assert.equal(blank.form().values.name, 'Veyago Inc.');
});

test('saving sends only the fields that changed, keyed by their workspace_settings names', async () => {
  const h = load({ studioProfile: [{ key: 'studio_name', value: 'Veyago Inc.' }, { key: 'studio_email', value: 'hello@veyago.cloud' }] });
  h.forms.openStudio();
  h.fill({ name: 'Veyago Inc.', tagline: 'A new tagline', location: 'New York, United States', email: 'hello@veyago.cloud', website: 'https://www.veyago.cloud/' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateStudioProfile', { studio_tagline: 'A new tagline' }]]);
  assert.equal(h.toasts.at(-1), 'Studio profile saved.');
});

test('a blank name, or an email that is not one, is refused before anything is sent', async () => {
  const blankName = load();
  blankName.forms.openStudio();
  blankName.fill({ name: '', email: '' });
  await blankName.submit();
  assert.equal(blankName.form().querySelector('.form-error').textContent, 'Enter the studio’s name.');
  assert.equal(blankName.writes.length, 0);

  const badEmail = load();
  badEmail.forms.openStudio();
  badEmail.fill({ name: 'Veyago Inc.', email: 'not-an-address' });
  await badEmail.submit();
  assert.match(badEmail.form().querySelector('.form-error').textContent, /valid email/);
  assert.equal(badEmail.writes.length, 0);
});

test('a field left exactly as shown is not resent — even a default shown with nothing stored — and clearing one that was stored writes an empty override', async () => {
  const h = load({ studioProfile: [{ key: 'studio_tagline', value: 'Old tagline' }] });
  h.forms.openStudio();
  /* location, email and website are pre-filled with the studio's own
     defaults (nothing is stored for them); left untouched, none of the
     three is sent. Only tagline, blanked from what was really stored, is. */
  h.fill({ name: 'Veyago Inc.', tagline: '' });
  await h.submit();
  assert.deepEqual(h.writes, [['updateStudioProfile', { studio_tagline: '' }]]);
});

/* ── The buttons ──────────────────────────────────────────────────────── */

test('the buttons open their dialogs', () => {
  const h = load();
  h.click({ 'data-invite-open': '' });
  assert.equal(h.form().id, 'invite-form');
  h.click({ 'data-studio-edit': '' });
  assert.equal(h.form().id, 'studio-form');
  h.click({ 'data-employee-edit': EMPLOYEE });
  assert.equal(h.form().id, 'employee-change-form');
});

test('a workspace still loading says so instead of opening any of the three dialogs', () => {
  const h = load({ loaded: false });
  for (const attrs of [{ 'data-invite-open': '' }, { 'data-studio-edit': '' }, { 'data-employee-edit': EMPLOYEE }]) {
    h.click(attrs);
  }
  assert.equal(h.modalOpen(), false);
  assert.ok(h.toasts.every(t => t === 'Not yet: the workspace is still loading.'));
  assert.equal(h.toasts.length, 3);
});

test('a stale employee-edit link says the person is no longer on the team', () => {
  const h = load();
  h.click({ 'data-employee-edit': 'gone' });
  assert.equal(h.toasts.at(-1), 'That person is no longer on the team.');
  assert.equal(h.modalOpen(), false);
});
