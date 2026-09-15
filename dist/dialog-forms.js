/* dialog-forms.js — what the workspace's dialog forms do the same way.
 *
 * Saying what is wrong on the form itself, tied to the field it is about and
 * read out even when the same thing is said twice; starting each send from a
 * clean form; and sending one write at a time — its fields shut while it goes,
 * the dialog closed once the database has it, and, when it is refused, the
 * reason on the form rather than only in a toast that goes, and the keyboard's
 * focus back on the button that being disabled had dropped. crm-forms.js and
 * finance-ui.js each had a copy, and the copies had already drifted apart.
 *
 * A write that names the record it changes keeps that record marked as still
 * on its way to the page: until the database answers, and then until every
 * part of the store it comes back in has been loaded since. The dialog has
 * closed by then, but the page — and a dialog opened from it — still shows the
 * record as it was (stillSaving).
 *
 * A form made by form() holds its fields, an error line (role="alert", with an
 * id), and — for a form that asks about look-alike records — a box for the
 * question. Loaded before the views that use it (index.html); tested through
 * tests/crm-forms.test.mjs, tests/finance-ui.test.mjs, tests/tasks-ui.test.mjs,
 * tests/notes-ui.test.mjs, tests/event-edit.test.mjs and tests/agenda-ui.test.mjs.
 */
const dialogForms = (function () {
  'use strict';

  /* A no-break space: what tells a message said twice from itself (say). */
  const NBSP = String.fromCharCode(160);
  const text = value => String(value == null ? '' : value);
  /* What each form last said, and the field it last marked. */
  const said = new WeakMap();
  const marked = new WeakMap();
  /* The records a write was sent for and not yet answered; and the changes
     that landed, by record: the store's mark then, and the parts of the store
     they come back in. */
  const settling = new Set();
  const landed = new Map();

  /* Words as a sentence: ending in a full stop, unless they end already. */
  const sentence = words => (/[.!?]$/.test(text(words).trim()) ? text(words).trim() : `${text(words).trim()}.`);

  const field = (label, control, attributes = '') => `<label class="form-field"${attributes}>${label}${control}</label>`;
  const options = (list, current) => list.map(x =>
    `<option value="${esc(x.value)}"${x.value === current ? ' selected' : ''}>${esc(x.label)}</option>`).join('');

  /* A dialog's form: its fields, the box a question about look-alike records
     goes in when it asks one, its error line, and its two buttons. */
  function form(id, body, submitLabel, { candidates = false } = {}) {
    return `<form id="${id}" method="dialog" novalidate>${body}`
      + (candidates ? `<div class="form-candidates" id="${id}-candidates" role="status"></div>` : '')
      + `<p class="form-error" id="${id}-error" role="alert"></p>`
      + '<div class="dialog-actions"><button type="button" class="btn" data-action="close">Cancel</button>'
      + `<button type="submit" class="btn btn-primary" data-label="${esc(submitLabel)}">${esc(submitLabel)}</button></div></form>`;
  }

  /* On the form, tied to the field it is about. A live region reads out only
     text that changed, so the same message said twice differs by a space. */
  function say(target, problem, name) {
    const error = target.querySelector('.form-error');
    const words = said.get(target) === problem ? problem + NBSP : problem;
    said.set(target, words);
    error.textContent = words;
    const bad = name ? target.querySelector(`[name="${name}"]`) : null;
    if (!bad) return;
    if (bad.setAttribute) {
      bad.setAttribute('aria-invalid', 'true');
      bad.setAttribute('aria-describedby', error.id);
    }
    marked.set(target, bad);
    if (bad.focus) bad.focus();
  }

  /* Each send starts from a clean form: no error, no field marked, no question
     showing, and the button saying what it does. A question already answered
     stays answered — that is for the form's own code to remember. */
  function quiet(target) {
    const bad = marked.get(target);
    if (bad && bad.removeAttribute) {
      bad.removeAttribute('aria-invalid');
      bad.removeAttribute('aria-describedby');
    }
    marked.delete(target);
    target.querySelector('.form-error').textContent = '';
    const box = target.querySelector('.form-candidates');
    if (box) box.innerHTML = '';
    const button = target.querySelector('[type="submit"]');
    if (button.dataset && button.dataset.label) button.textContent = button.dataset.label;
    if (button.removeAttribute) button.removeAttribute('aria-describedby');
  }

  /* Whether this form's dialog is the one open: closed, or replaced by
     another, what is said on it is said to no one. */
  const showing = target => Boolean(target && target.isConnected) && typeof modal !== 'undefined' && modal.open;

  function closeDialog(target) {
    if (showing(target)) modal.close();
  }

  const storeOrNull = () => (typeof workspaceStore === 'undefined' ? null : workspaceStore);

  /* Whether the page has a change that landed: every part of the store it
     comes back in has arrived from a load begun after it did. With no part
     named, or no store to say, it has once its write was answered. */
  function onPage(change) {
    const store = storeOrNull();
    if (!change.parts.length || change.mark === null || !store || typeof store.loadedSince !== 'function') return true;
    return change.parts.every(part => store.loadedSince(part, change.mark));
  }

  /* Whether a change sent for `record` ('note:<id>', 'task:<id>') is still on
     its way to the page: not yet answered, or answered and a part of the store
     it comes back in not loaded since. A load that did not bring that part
     back leaves the page as it was, and a dialog opened from it would put the
     old back. */
  function stillSaving(record) {
    const key = text(record);
    if (settling.has(key)) return true;
    const change = landed.get(key);
    if (!change) return false;
    if (!onPage(change)) return true;
    landed.delete(key);
    return false;
  }

  /* The fields someone could type into while a write goes, and would think
     sent: shut until it answers. */
  const typable = target => (typeof target.querySelectorAll === 'function'
    ? [...target.querySelectorAll('input:not([type="hidden"]), textarea')] : []);

  /* One write from a dialog: its button off and its fields shut while it goes,
     the dialog closed once the database has it, and, if it was refused, the
     fields and the button back, the reason on the form, and the keyboard's
     focus on the button again. The reason is said there alone — the store's
     toast would say it a second time — unless the dialog was closed while the
     write went, when a toast is where it can still be read. `record` names
     what the write changes, and `part` the part of the store it comes back in,
     or a list of them; stillSaving() answers for them. `only`, when a dialog's
     write can only ever change certain parts of the store (store.js's after()),
     asks for just those again rather than the whole workspace. What the view
     does once the change is in — drawing the page it goes to — is not the
     change: something going wrong there is logged, never said as a refusal. */
  function sending(target, work, done, { record = null, part = null, only = null } = {}) {
    const button = target.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    /* Changes the page has had since are let go of, rather than kept for good. */
    for (const [other, change] of landed) {
      if (onPage(change)) landed.delete(other);
    }
    const key = record === null ? null : text(record);
    const parts = part === null ? [] : [].concat(part);
    if (key !== null) {
      settling.add(key);
      landed.delete(key);
    }
    const shut = typable(target).filter(input => !input.readOnly);
    shut.forEach(input => { input.readOnly = true; });
    const write = Promise.resolve().then(work);
    write.then(() => {
      if (key !== null) {
        const store = storeOrNull();
        /* Loads begun before the change landed do not hold it (store.js mark). */
        landed.set(key, { mark: store && typeof store.mark === 'function' ? store.mark() : null, parts });
      }
      closeDialog(target);
    }, () => {});
    workspaceStore.after(write, { toast: false, only }).then(done, err => {
      const reason = sentence((err && err.message) || 'That was not saved');
      button.disabled = false;
      shut.forEach(input => { input.readOnly = false; });
      if (!showing(target)) {
        if (typeof toast === 'function') toast(reason);
        return;
      }
      say(target, reason);
      if (button.focus) button.focus();
    }).catch(err => {
      console.error('[workspace] after a change was sent:', err);
    }).then(() => { if (key !== null) settling.delete(key); });
  }

  /* After a save, the keyboard on the first of `places` — { selector, heading }
     — that the page has, when it has fallen to the page: the page is drawn
     again, and with it the button that opened the dialog. A heading takes it
     as a place to read on from, not a control. Focus somewhere on the page is
     left where it is. */
  function refocus(places) {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected !== false) return;
    for (const place of places) {
      const next = document.querySelector(place.selector);
      if (!next || !next.focus) continue;
      if (place.heading && next.setAttribute) next.setAttribute('tabindex', '-1');
      next.focus();
      return;
    }
  }

  return Object.freeze({ sentence, field, options, form, say, quiet, showing, closeDialog, sending, stillSaving, refocus });
})();
