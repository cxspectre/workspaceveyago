/* A record's notes, as notes-ui.js runs them: what is half written in a note
   box kept for the page drawn again, who may change or remove a note (0032, as
   tasks-model.js reads it), what the dialogs save and say, a refusal said once
   where it can be read, a note's buttons waiting until its change is on the
   page, and the keyboard put back where it can carry on. The page's helpers
   are stand-ins that keep what they are given. Loaded into a sandbox the way
   <script> tags run it. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ME = 'e1000000-0000-4000-8000-000000000001';
const YOU = 'e1000000-0000-4000-8000-000000000002';
const N1 = 'f1000000-0000-4000-8000-000000000001';
const TYPED = '<img src=x onerror=alert(1)>';
const OWNER = { id: ME, role: 'owner', status: 'active' };
const WAIT = 'The last change to that note is still on its way. Try again in a moment.';
const EDIT_BUTTON = `#main [data-note-edit="${N1}"]`;
const NOTE_BOX = '#main [data-note-form="projects"][data-record-id="p1"] textarea';
const HEADING = '#main h1';
const CHANGE_REFUSED = 'The note was not changed: only whoever wrote it can change it, or it has been removed.';
const REMOVAL_REFUSED = 'The note was not removed: only whoever wrote it, or an owner or admin, can remove it — or it has been removed already.';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* A note as the store files it under its record (store.js regroupNotes). */
const note = (over = {}) => ({ id: N1, body: 'Client wants blue', who: 'Sam Rivera', initial: 'SR', time: 'Today', authorId: ME, ...over });

/* The dialog form showModal() puts on the page: its id, what it was filled in
   with, its error line, its submit button and its fields as dialog-forms.js
   marks them. */
function dialog(id) {
  const handlers = {};
  const fields = {};
  const form = {
    id, values: {}, isConnected: true, handlers, focused: [],
    button: { disabled: false, dataset: {}, attributes: {}, focused: 0, focus() { this.focused += 1; }, removeAttribute(name) { delete this.attributes[name]; } },
    error: { textContent: '', id: `${id}-error` },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    field: selector => (fields[selector] = fields[selector] || {
      attributes: {},
      focus: () => form.focused.push(selector),
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; }
    }),
    querySelector: selector => (selector === '[type="submit"]' ? form.button
      : selector === '.form-error' ? form.error
        : selector === '.form-candidates' ? null
          : form.field(selector))
  };
  return form;
}

/* An element a click lands on, with one data attribute. */
function target(attribute, value) {
  const key = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const element = { dataset: { [key]: value } };
  return { closest: selector => (selector.split(',').map(s => s.trim()).includes(`[${attribute}]`) ? element : null) };
}

/* A record's note box with what is written in it, as an input event finds it. */
function noteBox(kind, id, value) {
  const box = { value, form: { dataset: { noteForm: kind, recordId: id } } };
  box.closest = selector => (selector === '[data-note-form] textarea[name="note"]' ? box : null);
  return box;
}

/* notes: recordNotes by kind and record. refuse: the database refuses the note
   writes. active: where the keyboard is. page: what the page has once it is
   drawn again, by the selector that finds it. misses: the parts the load after
   a write does not bring back. broken: finding anything on the page throws. */
function load({ notes = { projects: { p1: [note()] } }, viewer = { id: ME, role: 'employee', status: 'active' }, loaded = true, refuse = false, active = null,
  page = [EDIT_BUTTON, NOTE_BOX, HEADING], misses = [], broken = false } = {}) {
  const listeners = {};
  const toasts = [];
  const modals = [];
  const updates = [];
  const removals = [];
  const pageFocus = [];
  const BODY = {};
  const elements = Object.fromEntries(page.map(selector => [selector, {
    attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value); }, focus: () => pageFocus.push(selector)
  }]));
  let form = null;
  /* A write on its way to the database, and the load after it, while a test holds them. */
  const holds = { write: null, reload: null };
  /* The loads begun so far, and the one each part last arrived from (store.js mark and loadedSince). */
  const loads = { begun: 0, arrived: {} };
  const begin = parts => {
    loads.begun += 1;
    parts.forEach(part => { loads.arrived[part] = loads.begun; });
  };
  const context = vm.createContext({
    console: { ...console, error() {} },
    esc: escape,
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); form = dialog((body.match(/<form id="([^"]+)"/) || [])[1]); context.modal.open = true; },
    modal: { open: false, close() { this.open = false; } },
    recordNotes: { tickets: {}, projects: {}, crm: {}, agenda: {}, companies: {}, ...notes },
    workspaceSession: { employee: viewer },
    workspaceStore: {
      state: { loaded },
      /* As store.js's after() does: once the write is in, the workspace is
         loaded again — each part it brings back arriving from that load; a
         refusal is said in a toast unless the caller says it itself
         ({ toast: false }), and passed on. */
      after: (work, options) => Promise.resolve(work).then(
        value => (holds.reload ? holds.reload.promise : Promise.resolve()).then(() => {
          begin(['notes', 'projects', 'events'].filter(part => !misses.includes(part)));
          return value;
        }),
        err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; }),
      mark: () => loads.begun,
      loadedSince: (part, mark) => loads.arrived[part] !== undefined && loads.arrived[part] > mark
    },
    workspaceActions: {
      updateNote: async (id, body) => {
        updates.push([id, body]);
        if (holds.write) await holds.write.promise;
        if (refuse) throw new Error(CHANGE_REFUSED);
        return { id, body };
      },
      deleteNote: async id => {
        removals.push(id);
        if (holds.write) await holds.write.promise;
        if (refuse) throw new Error(REMOVAL_REFUSED);
      }
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => (form && form.id === id ? form : null),
      body: BODY,
      activeElement: active || BODY,
      /* The page as drawn again: what is on it is found, and nothing else. */
      querySelector: selector => {
        if (broken) throw new TypeError('Cannot read properties of undefined (reading \'name\')');
        return elements[selector] || null;
      }
    },
    FormData: class { constructor(f) { this.f = f; } get(name) { return this.f.values[name]; } entries() { return Object.entries(this.f.values); } }
  });
  context.window = context;
  for (const file of ['tasks-model.js', 'dialog-forms.js', 'notes-ui.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  /* Holds the next write, or the load after it, until the function it returns is called. */
  const hold = which => {
    let release;
    holds[which] = { promise: new Promise(resolve => { release = resolve; }) };
    return () => { holds[which] = null; release(); };
  };
  return {
    click: node => (listeners.click || []).forEach(fn => fn({ target: node, preventDefault() {} })),
    type: node => (listeners.input || []).forEach(fn => fn({ target: node })),
    form: () => form,
    submit: async () => { form.handlers.submit({ preventDefault() {} }); await settle(); },
    send: () => form.handlers.submit({ preventDefault() {} }),
    holdWrite: () => hold('write'),
    holdReload: () => hold('reload'),
    /* A later load brings a part back. */
    arrive: part => begin([part]),
    element: selector => elements[selector],
    drafts: () => context.noteDrafts,
    toasts, modals, updates, removals, pageFocus, modal: context.modal
  };
}

test('whoever wrote a note edits its words: the dialog shows them, an empty note is refused on its field, and the same words change nothing', async () => {
  const h = load();
  h.click(target('data-note-edit', N1));
  assert.equal(h.modals.length, 1);
  assert.match(h.modals[0].body, /<h2>Edit note<\/h2>/);
  assert.match(h.modals[0].body, /<form id="note-edit-form" method="dialog" novalidate>/);
  assert.match(h.modals[0].body, /<textarea name="body" required autofocus>Client wants blue<\/textarea>/);
  h.form().values = { body: '   ' };
  await h.submit();
  assert.deepEqual(h.updates, []);
  assert.equal(h.form().error.textContent, 'Write something first.');
  assert.equal(h.form().field('[name="body"]').attributes['aria-invalid'], 'true');
  h.form().values = { body: ' Client wants blue ' };
  await h.submit();
  assert.equal(h.form().error.textContent, '', 'the last problem is not left up once the words are fine');
  assert.deepEqual(h.updates, [], 'the same words, tidied, are no change');
  assert.deepEqual(h.toasts, ['Nothing changed.']);
  assert.equal(h.modal.open, false);
  const spaced = load({ notes: { projects: { p1: [note({ body: '  Client wants blue \n' })] } } });
  spaced.click(target('data-note-edit', N1));
  spaced.form().values = { body: 'Client wants blue' };
  await spaced.submit();
  assert.deepEqual(spaced.updates, [], 'nor are the same words stored with spaces around them');
  assert.deepEqual(spaced.toasts, ['Nothing changed.']);
});

test('a changed note is saved, and the keyboard goes back to its Edit button on the page as drawn again', async () => {
  const h = load();
  h.click(target('data-note-edit', N1));
  h.form().values = { body: '  Client wants blue and green  ' };
  await h.submit();
  assert.deepEqual(h.updates, [[N1, 'Client wants blue and green']]);
  assert.deepEqual(h.toasts, ['Note saved.']);
  assert.equal(h.modal.open, false);
  assert.deepEqual(h.pageFocus, [EDIT_BUTTON]);
  const elsewhere = load({ active: { isConnected: true } });
  elsewhere.click(target('data-note-edit', N1));
  elsewhere.form().values = { body: 'Client wants green' };
  await elsewhere.submit();
  assert.deepEqual(elsewhere.pageFocus, [], 'a keyboard somewhere on the page is left there');
  const gone = load({ page: [NOTE_BOX, HEADING] });
  gone.click(target('data-note-edit', N1));
  gone.form().values = { body: 'Client wants green' };
  await gone.submit();
  assert.deepEqual(gone.pageFocus, [NOTE_BOX], 'a note removed meanwhile has no Edit button to go back to: the note box has the keyboard');
});

test('removing asks first, then removes the note, and the keyboard goes to the note box of the record it was on', async () => {
  const h = load();
  h.click(target('data-note-remove', N1));
  assert.match(h.modals[0].body, /<h2>Remove this note\?<\/h2>/);
  assert.match(h.modals[0].body, /It leaves the record for everyone\./);
  assert.deepEqual(h.removals, []);
  await h.submit();
  assert.deepEqual(h.removals, [N1]);
  assert.deepEqual(h.toasts, ['Note removed.']);
  assert.deepEqual(h.pageFocus, [NOTE_BOX]);
});

test('removing a ticket\'s note puts the keyboard on the ticket\'s notes, or on its heading once none is left — never in the box that may reply to the customer', async () => {
  const NOTES = '#main [id="ticket-notes-142"]';
  const REPLY_BOX = '#main [id="ticket-response-142"]';
  const h = load({ notes: { tickets: { 142: [note()] } }, page: [NOTES, REPLY_BOX, HEADING] });
  h.click(target('data-note-remove', N1));
  await h.submit();
  assert.deepEqual(h.pageFocus, [NOTES]);
  assert.equal(h.element(NOTES).attributes.tabindex, '-1');
  const last = load({ notes: { tickets: { 142: [note()] } }, page: [REPLY_BOX, HEADING] });
  last.click(target('data-note-remove', N1));
  await last.submit();
  assert.deepEqual(last.pageFocus, [HEADING], 'the last note gone, its section goes with it');
  assert.equal(last.element(HEADING).attributes.tabindex, '-1');
  const bare = load({ page: [] });
  bare.click(target('data-note-remove', N1));
  await bare.submit();
  assert.deepEqual(bare.pageFocus, []);
});

test('the Remove dialog says whose note goes and what it says, cut short, as text', () => {
  const mine = load();
  mine.click(target('data-note-remove', N1));
  assert.match(mine.modals[0].body, /<p class="form-note">Your note from Today: “Client wants blue”<\/p>/);
  const words = Array(40).fill('word').join(' ');
  const theirs = load({ viewer: OWNER, notes: { projects: { p1: [note({ authorId: YOU, who: 'Ana Lima', time: 'Yesterday', body: words })] } } });
  theirs.click(target('data-note-remove', N1));
  assert.match(theirs.modals[0].body, /<p class="form-note">Ana Lima’s note from Yesterday: “(word ){23}word…”<\/p>/);
  const former = load({ viewer: OWNER, notes: { projects: { p1: [note({ authorId: null, who: 'Former team member' })] } } });
  former.click(target('data-note-remove', N1));
  assert.match(former.modals[0].body, /<p class="form-note">A former team member’s note from Today: “Client wants blue”<\/p>/);
  const typed = load({ viewer: OWNER, notes: { projects: { p1: [note({ authorId: YOU, who: TYPED, time: TYPED, body: TYPED })] } } });
  typed.click(target('data-note-remove', N1));
  assert.doesNotMatch(typed.modals[0].body, /<img/i);
  assert.match(typed.modals[0].body, /&lt;img src=x onerror=alert\(1\)&gt;’s note/);
});

test('only whoever wrote a note changes it, and they or an owner or admin remove it; anyone else is told, even with a forged button', () => {
  const theirs = { projects: { p1: [note({ authorId: YOU })] } };
  const other = load({ notes: theirs });
  other.click(target('data-note-edit', N1));
  other.click(target('data-note-remove', N1));
  assert.equal(other.modals.length, 0);
  assert.deepEqual(other.toasts, ['Only whoever wrote a note can change it.', 'Only whoever wrote a note, or an owner or admin, can remove it.']);
  const owner = load({ notes: theirs, viewer: OWNER });
  owner.click(target('data-note-edit', N1));
  assert.equal(owner.modals.length, 0, 'an owner or admin does not change someone else\'s words');
  owner.click(target('data-note-remove', N1));
  assert.equal(owner.modals.length, 1);
});

test('a change the database refuses is said once, on the dialog, which stays open; two quick sends write once', async () => {
  const h = load({ refuse: true });
  h.click(target('data-note-edit', N1));
  h.form().values = { body: 'Client wants green' };
  h.send();
  h.send();
  await settle();
  assert.equal(h.updates.length, 1);
  assert.equal(h.modal.open, true);
  assert.equal(h.form().error.textContent, CHANGE_REFUSED);
  assert.equal(h.form().button.disabled, false);
  assert.deepEqual(h.pageFocus, []);
  assert.deepEqual(h.toasts, [], 'not in a toast as well, which a screen reader reads out a second time');
  const removal = load({ refuse: true });
  removal.click(target('data-note-remove', N1));
  await removal.submit();
  assert.equal(removal.form().error.textContent, REMOVAL_REFUSED);
  assert.deepEqual(removal.toasts, []);
  removal.send();
  assert.equal(removal.form().error.textContent, '', 'a retry starts from a clean dialog');
  await settle();
});

test('a refusal that comes back after its dialog was closed is said in a toast, where it can still be read', async () => {
  const h = load({ refuse: true });
  h.click(target('data-note-remove', N1));
  const wrote = h.holdWrite();
  h.send();
  h.modal.close();
  wrote();
  await settle();
  assert.deepEqual(h.toasts, [REMOVAL_REFUSED]);
  assert.equal(h.form().error.textContent, '');
});

test('a dialog another took the place of before its answer came is neither closed over the new one nor spoken on', async () => {
  const h = load();
  h.click(target('data-note-edit', N1));
  h.form().values = { body: 'Call Wednesday' };
  const first = h.form();
  const wrote = h.holdWrite();
  h.send();
  first.isConnected = false;
  wrote();
  await settle();
  assert.equal(h.modal.open, true, 'the dialog open now is left open');
  assert.deepEqual(h.toasts, ['Note saved.']);
  const refused = load({ refuse: true });
  refused.click(target('data-note-edit', N1));
  refused.form().values = { body: 'Call Wednesday' };
  const replaced = refused.form();
  const held = refused.holdWrite();
  refused.send();
  replaced.isConnected = false;
  held();
  await settle();
  assert.equal(refused.modal.open, true);
  assert.deepEqual(refused.toasts, [CHANGE_REFUSED], 'said where it can be read');
  assert.equal(replaced.error.textContent, '', 'not on a form no one sees');
});

test('something going wrong after a change is saved is not said as a refusal, and the note does not stay waiting', async () => {
  const h = load({ broken: true });
  h.click(target('data-note-edit', N1));
  h.form().values = { body: 'Call Wednesday' };
  await h.submit();
  assert.deepEqual(h.toasts, ['Note saved.'], 'no toast saying the saved note failed');
  assert.equal(h.form().error.textContent, '');
  h.click(target('data-note-edit', N1));
  assert.equal(h.modals.length, 2);
});

test('until the workspace is loaded again after a change, that note\'s buttons wait: the page still shows it as it was', async () => {
  const h = load();
  const reloaded = h.holdReload();
  h.click(target('data-note-edit', N1));
  h.form().values = { body: 'Call Wednesday' };
  await h.submit();
  assert.deepEqual(h.updates, [[N1, 'Call Wednesday']]);
  assert.equal(h.modal.open, false, 'the dialog closes once the database has it');
  h.click(target('data-note-edit', N1));
  h.click(target('data-note-remove', N1));
  assert.equal(h.modals.length, 1, 'no dialog filled in with the words from before');
  assert.deepEqual(h.toasts, [WAIT, WAIT]);
  reloaded();
  await settle();
  assert.equal(h.toasts.at(-1), 'Note saved.');
  h.click(target('data-note-edit', N1));
  assert.equal(h.modals.length, 2, 'once it is loaded again, the note opens');
});

test('a change whose notes did not come back with the load after it keeps the note waiting until a later load brings them', async () => {
  const h = load({ misses: ['notes'] });
  h.arrive('notes');
  h.click(target('data-note-edit', N1));
  h.form().values = { body: 'Call Wednesday' };
  await h.submit();
  assert.deepEqual(h.toasts, ['Note saved.']);
  h.click(target('data-note-edit', N1));
  assert.equal(h.modals.length, 1, 'the page still has the words from before, which saving would put back');
  assert.equal(h.toasts.at(-1), WAIT);
  h.arrive('notes');
  h.click(target('data-note-edit', N1));
  assert.equal(h.modals.length, 2, 'once notes are loaded again, it opens');
});

test('a removal waits the same way, so it is not sent twice; a refusal lets the note be opened again at once', async () => {
  const h = load();
  const reloaded = h.holdReload();
  h.click(target('data-note-remove', N1));
  await h.submit();
  h.click(target('data-note-remove', N1));
  assert.deepEqual(h.removals, [N1]);
  assert.equal(h.modals.length, 1);
  assert.deepEqual(h.toasts, [WAIT]);
  reloaded();
  await settle();
  const refused = load({ refuse: true });
  refused.click(target('data-note-edit', N1));
  refused.form().values = { body: 'Call Wednesday' };
  await refused.submit();
  refused.modal.close();
  refused.click(target('data-note-edit', N1));
  assert.equal(refused.modals.length, 2);
});

test('while the workspace is still loading nothing opens, and a note no longer loaded says so', () => {
  const waiting = load({ loaded: false });
  waiting.click(target('data-note-edit', N1));
  assert.equal(waiting.modals.length, 0);
  assert.deepEqual(waiting.toasts, ['Not yet: the workspace is still loading.']);
  const gone = load({ notes: {} });
  gone.click(target('data-note-remove', N1));
  assert.equal(gone.modals.length, 0);
  assert.deepEqual(gone.toasts, ['That note is not loaded any more. Reload the page.']);
});

test('what anyone typed into a note stays text in its dialog', () => {
  const h = load({ notes: { crm: { c1: [note({ body: TYPED })] } } });
  h.click(target('data-note-edit', N1));
  assert.doesNotMatch(h.modals[0].body, /<img/i);
  assert.match(h.modals[0].body, /&lt;img src=x onerror=alert\(1\)&gt;<\/textarea>/);
});

test('what is written in a note box is kept by its record for the box drawn again; a saved note lets it go, unless more was written', () => {
  const h = load();
  h.type(noteBox('projects', 'p1', 'Half a note'));
  assert.equal(h.drafts().get('projects', 'p1'), 'Half a note');
  assert.equal(h.drafts().get('projects', 'p2'), '', 'another record\'s box is its own');
  assert.equal(h.drafts().get('companies', 'p1'), '');
  h.drafts().sent('projects', 'p1', 'Half a note, and more');
  assert.equal(h.drafts().get('projects', 'p1'), 'Half a note', 'written further while it saved: kept');
  h.drafts().sent('projects', 'p1', ' Half a note ');
  assert.equal(h.drafts().get('projects', 'p1'), '');
  h.type(noteBox('crm', 'c1', 'Call back'));
  h.type(noteBox('crm', 'c1', '   '));
  assert.equal(h.drafts().get('crm', 'c1'), '', 'a box emptied keeps nothing');
  h.type({ value: 'not a note box', closest: () => null });
  assert.equal(h.drafts().get('undefined', 'undefined'), '');
});

test('a note whose change is still being written waits too, when its dialog was closed meanwhile', async () => {
  const h = load();
  h.click(target('data-note-edit', N1));
  h.form().values = { body: 'Call Wednesday' };
  const wrote = h.holdWrite();
  h.send();
  h.modal.close();
  h.click(target('data-note-edit', N1));
  assert.equal(h.modals.length, 1, 'not opened with the words from before while the change is still being written');
  assert.deepEqual(h.toasts, [WAIT]);
  wrote();
  await settle();
});

test('a load begun while the change was still being written does not count as bringing it back, even when it ends after', async () => {
  const h = load({ misses: ['notes'] });
  h.click(target('data-note-edit', N1));
  h.form().values = { body: 'Call Wednesday' };
  const wrote = h.holdWrite();
  h.send();
  h.arrive('notes');
  wrote();
  await settle();
  assert.deepEqual(h.toasts, ['Note saved.']);
  h.click(target('data-note-edit', N1));
  assert.equal(h.modals.length, 1, 'those notes were read before the change landed');
  assert.equal(h.toasts.at(-1), WAIT);
});

test('a note cut short in the Remove dialog is cut between characters, never through a flag', () => {
  const flags = `${'a'.repeat(118)}🇳🇱🇳🇱`;
  const h = load({ notes: { projects: { p1: [note({ body: flags })] } } });
  h.click(target('data-note-remove', N1));
  assert.ok(h.modals[0].body.includes(`: “${flags}”</p>`), 'a hundred and twenty characters, as a person counts them, are not cut');
  const longer = load({ notes: { projects: { p1: [note({ body: `${'a'.repeat(118)}🇳🇱🇳🇱🇳🇱` })] } } });
  longer.click(target('data-note-remove', N1));
  assert.ok(longer.modals[0].body.includes(`: “${'a'.repeat(118)}🇳🇱…”</p>`), 'and one more is cut after a whole flag');
});
