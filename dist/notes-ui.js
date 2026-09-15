/* notes-ui.js — a record's notes: what is half written in its note box, and
 * changing and removing a note.
 *
 * Whoever wrote a note changes its words, and they or an owner or admin
 * remove it (0032, as tasks-model.js reads it). Each asks in a dialog made
 * with dialog-forms.js, which says a refusal on the dialog and keeps it open.
 * The workspace is loaded again after a change, and the keyboard is put back
 * where someone can carry on. Until the page has the change, the note's
 * buttons wait: the page still shows the note as it was, and a dialog opened
 * from it would change again, or remove again, what is already changed.
 *
 * The note list, its buttons and the note box are workspace.js's (noteFeed,
 * noteForm); a note is added by data/writes.js. Tested in
 * tests/notes-ui.test.mjs.
 */
const notesUi = (function () {
  'use strict';

  const T = tasksModel;
  const { field, say, quiet, sending, closeDialog, stillSaving, refocus } = dialogForms;
  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const text = value => String(value == null ? '' : value);

  /* What someone has written in a record's note box, by record — kept here as
     well as in the box. Every save loads the workspace again and draws the
     page anew, and a box drawn empty lost a note half written when an older
     note was changed, a task added or a status set. workspace.js's noteForm
     draws the box with it; data/writes.js lets it go once the note is saved,
     and sends one note per record at a time — a box drawn again while one
     saves, when someone went to another tab and back, does not send it twice. */
  const drafts = new Map();
  const saving = new Set();
  const draftKey = (kind, id) => `${text(kind)}|${text(id)}`;
  const draftOf = (kind, id) => drafts.get(draftKey(kind, id)) || '';
  window.noteDrafts = Object.freeze({
    get: draftOf,
    keep: (kind, id, body) => {
      if (text(body).trim()) drafts.set(draftKey(kind, id), text(body));
      else drafts.delete(draftKey(kind, id));
    },
    /* After a save the words go — unless the box changed while it saved, when
       what is there now stays. */
    sent: (kind, id, body) => {
      if (draftOf(kind, id).trim() === text(body).trim()) drafts.delete(draftKey(kind, id));
    },
    isSaving: (kind, id) => saving.has(draftKey(kind, id)),
    startSaving: (kind, id) => { saving.add(draftKey(kind, id)); },
    doneSaving: (kind, id) => { saving.delete(draftKey(kind, id)); }
  });

  document.addEventListener('input', e => {
    const box = e.target && e.target.closest && e.target.closest('[data-note-form] textarea[name="note"]');
    const form = box && box.form;
    if (!form || !form.dataset) return;
    window.noteDrafts.keep(form.dataset.noteForm, form.dataset.recordId, box.value);
  });

  /* The signed-in person as tasks-model reads them: their employees row. */
  function viewer() {
    const s = window.workspaceSession || null;
    const e = s && s.employee ? s.employee : null;
    return e ? { id: e.id, role: e.role, status: e.status } : { id: null };
  }

  /* A value as a CSS attribute selector quotes it. */
  const attr = value => text(value).replace(/["\\]/g, '\\$&');

  /* A note by its id, with the record it is filed under (store.js regroupNotes). */
  function findNote(noteId) {
    for (const kind of Object.keys(recordNotes)) {
      for (const id of Object.keys(recordNotes[kind] || {})) {
        const note = (recordNotes[kind][id] || []).find(n => n && String(n.id) === String(noteId));
        if (note) return { note, kind, id };
      }
    }
    return null;
  }

  /* What a note's change is saved under until the page has it (dialog-forms.js). */
  const recordOf = note => `note:${note.id}`;

  /* Whose note it is, as a dialog says it: yours, a teammate's by name, or —
     one whose author's row was deleted, which 0032 leaves without one — a
     former team member's. */
  function whose(note) {
    if (T.canEditNote(viewer(), note)) return 'Your note';
    return note.authorId ? `${text(note.who).trim() || 'Someone'}’s note` : 'A former team member’s note';
  }

  /* A note's words as a person reads them, one character at a time: a flag or
     a family is one character, not the code points it is made of, and is not
     cut in two. */
  const characters = value => (typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.segment)
    : Array.from(value));

  /* A note's words on one line, cut short: enough to tell which note it is. */
  const EXCERPT = 120;
  function excerpt(body) {
    const chars = characters(text(body).trim().replace(/\s+/g, ' '));
    return chars.length > EXCERPT ? `${chars.slice(0, EXCERPT - 1).join('')}…` : chars.join('');
  }

  /* Where the keyboard can go on a record's page once a note is changed or
     gone: where its next note is written — or, on a ticket, which has no note
     box, its notes, or its heading once none is left. Not the ticket's reply
     box, which may be set to reply to the customer. */
  function placesOn(found) {
    const heading = { selector: '#main h1', heading: true };
    return found.kind === 'tickets'
      ? [{ selector: `#main [id="ticket-notes-${attr(found.id)}"]`, heading: true }, heading]
      : [{ selector: `#main [data-note-form="${attr(found.kind)}"][data-record-id="${attr(found.id)}"] textarea` }, heading];
  }

  function openEdit(found) {
    showModal('NOTE', '<h2>Edit note</h2>'
      + dialogForms.form('note-edit-form', field('Note', `<textarea name="body" required autofocus>${esc(found.note.body)}</textarea>`), 'Save note'));
    const form = document.getElementById('note-edit-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const checked = T.noteForm({ body: new FormData(form).get('body') }, { edit: true });
      if (!checked.ok) { say(form, checked.problem, 'body'); return; }
      if (checked.values.body === text(found.note.body).trim()) {
        closeDialog(form);
        toast('Nothing changed.');
        return;
      }
      sending(form, () => workspaceActions.updateNote(found.note.id, checked.values.body), () => {
        toast('Note saved.');
        refocus([{ selector: `#main [data-note-edit="${attr(found.note.id)}"]` }, ...placesOn(found)]);
      }, { record: recordOf(found.note), part: 'notes' });
    });
  }

  /* Removing a note says whose it is and what it says. Its buttons go with
     it, so the keyboard goes to where the record's next note is written. */
  function openRemove(found) {
    const time = text(found.note.time).trim();
    showModal('NOTE', '<h2>Remove this note?</h2>'
      + `<p class="form-note">${esc(whose(found.note))}${time ? ` from ${esc(time)}` : ''}: “${esc(excerpt(found.note.body))}”</p>`
      + '<p class="form-note">It leaves the record for everyone.</p>'
      + dialogForms.form('note-remove-form', '', 'Remove note'));
    const form = document.getElementById('note-remove-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      sending(form, () => workspaceActions.deleteNote(found.note.id), () => {
        toast('Note removed.');
        refocus(placesOn(found));
      }, { record: recordOf(found.note), part: 'notes' });
    });
  }

  document.addEventListener('click', e => {
    const target = e.target.closest && e.target.closest('[data-note-edit], [data-note-remove]');
    if (!target) return;
    e.preventDefault();
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    const editing = target.dataset.noteEdit !== undefined;
    const found = findNote(editing ? target.dataset.noteEdit : target.dataset.noteRemove);
    if (!found) { toast('That note is not loaded any more. Reload the page.'); return; }
    if (stillSaving(recordOf(found.note))) { toast('The last change to that note is still on its way. Try again in a moment.'); return; }
    const me = viewer();
    if (editing ? !T.canEditNote(me, found.note) : !T.canDeleteNote(me, found.note)) {
      toast(editing ? 'Only whoever wrote a note can change it.' : 'Only whoever wrote a note, or an owner or admin, can remove it.');
      return;
    }
    if (editing) openEdit(found);
    else openRemove(found);
  });

  return Object.freeze({ findNote });
})();
