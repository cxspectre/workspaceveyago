/* tasks-ui.js — a project's tasks: who each is for, when it is due, how far
 * along it is, and the dialogs that change or remove one.
 *
 * As tasks-model.js decides it, following the database (0005, 0006, 0022,
 * 0039, 0050). Anyone on staff adds a task: who it is for, when it is due, how
 * urgent it is and its details. An owner or admin edits a task's title,
 * details, assignee, due date, priority and status, and removes it. The task's
 * assignee and its project's team move it along — its status, and nothing
 * else. Everyone else on staff sees it. The list shows open tasks first,
 * overdue ones at the top, then by due date and priority.
 *
 * The task panel used to list titles only: nobody could see or set who a task
 * was for or when it was due, change a title, or remove a task, a task in
 * progress looked untouched, and a new task took a title alone, for whoever
 * added it.
 *
 * The project page (workspace.js projectDetail) draws its task panel with
 * tasksUi.panel(project). Ticking a box is data/writes.js's; every other write
 * goes through workspaceActions and reloads the store. Tested in
 * tests/tasks-ui.test.mjs.
 */
const tasksUi = (function () {
  'use strict';

  const T = tasksModel;
  const UNDER_WAY = Object.freeze(['in_progress', 'blocked']);
  const RAISED = Object.freeze(['high', 'urgent']);

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const members = () => (window.workspaceStore && workspaceStore.state.projectMembers) || [];
  /* Whether project teams loaded. Until they have, nobody can be told they are
     off a task's team: its controls are offered, and the database decides
     (0050), saying so when it refuses. */
  const teamKnown = () => !(window.workspaceStore && typeof workspaceStore.has === 'function') || workspaceStore.has('projectMembers');
  const mayMove = (task, project) => !teamKnown() || T.canChangeStatus(viewer(), task, project, members());
  /* A task's status is saved once the choice settles: moving through a closed
     select with the arrow keys fires a change for every option passed (Chrome
     and Firefox on Windows and Linux). As data/writes.js saves a ticket's, a
     task's saves go one after another in the order chosen, and a choice is
     compared with the status on its way to the database, else with the one
     stored: until a save's reload lands, the task as loaded still has the old
     status, and changing it back compared equal and saved nothing. */
  const SETTLE_MS = 600;
  const settling = new Map();
  const statusSaving = new Map();
  const statusSaves = new Map();
  /* The signed-in person as tasks-model reads them: their employees row, and
     whether the session says they manage — which it may know when the row
     cannot show it. */
  function viewer() {
    const s = window.workspaceSession || null;
    const e = s && s.employee ? s.employee : null;
    const manager = Boolean(s && typeof s.isManager === 'function' && s.isManager());
    return e ? { id: e.id, role: e.role, status: e.status, manager } : { id: null, manager: false };
  }
  const nameOf = id => ((team || []).find(m => m.id === id) || {}).name || null;
  const labelIn = (list, value) => (list.find(x => x.value === value) || { label: '' }).label;
  const { field, options, say, quiet, sending, closeDialog } = dialogForms;

  /* A task by its id, with the project it is on — never by its place in a list. */
  function findTask(id) {
    for (const project of projects || []) {
      const task = (project.taskList || []).find(t => t && String(t.id) === String(id));
      if (task) return { task, project };
    }
    return null;
  }

  /* ── The list ──────────────────────────────────────────────────────── */

  function row(task, project, today) {
    const me = viewer();
    const tick = T.tick(task);
    const due = T.dueLabel(task, today);
    const status = T.statusOf(task);
    const priority = T.priorityOf(task);
    const moves = mayMove(task, project);
    /* A status on its way to the database is what the controls show, marked
       busy, whatever a reload in between brought; the stored one is kept
       beside it, to be put back if the database refuses. */
    const pending = statusSaving.has(String(task.id)) ? statusSaving.get(String(task.id)) : null;
    const shown = pending || status;
    const busy = pending ? ' aria-busy="true"' : '';
    const who = task.assigneeId ? nameOf(task.assigneeId) || 'Someone no longer on the team' : 'Nobody yet';
    const box = `task-${esc(task.id)}`;
    const meta = [
      UNDER_WAY.includes(status) ? pill(labelIn(T.STATUSES, status), status === 'blocked' ? 'red' : 'blue') : '',
      `<span>${esc(who)}</span>`,
      due.label ? `<span class="task-due${due.overdue ? ' overdue' : ''}">${esc(due.label)}</span>` : '',
      RAISED.includes(priority) ? pill(labelIn(T.PRIORITIES, priority), priority === 'urgent' ? 'red' : 'amber') : ''
    ].filter(Boolean).join('');
    const controls = [
      moves ? `<select data-task-status="${esc(task.id)}" data-stored="${esc(status)}"${busy} aria-label="${esc('Status of ' + task.title)}">${options(T.STATUSES, shown)}</select>` : '',
      T.canEdit(me, task) ? `<button type="button" class="btn" data-task-edit="${esc(task.id)}" aria-label="${esc('Edit ' + task.title)}">Edit</button>` : '',
      T.canDelete(me, task) ? `<button type="button" class="btn" data-task-remove="${esc(task.id)}" aria-label="${esc('Remove ' + task.title)}">Remove</button>` : ''
    ].join('');
    return `<div class="workspace-task task-row${tick.checked ? ' done' : ''}" role="listitem">`
      + `<input type="checkbox" id="${box}" data-project-task="${esc(project.id)}" data-task-id="${esc(task.id)}" data-stored="${esc(status)}"${shown === 'done' ? ' checked' : ''}${moves ? '' : ' disabled'}>`
      + `<div class="task-main"><label for="${box}">${esc(task.title)}</label><small class="task-meta">${meta}</small></div>`
      + (controls ? `<div class="task-controls">${controls}</div>` : '')
      + '</div>';
  }

  function panel(project) {
    const today = new Date();
    const tasks = T.sortTasks(project.taskList || [], today);
    const done = tasks.filter(t => T.statusOf(t) === 'done').length;
    const heading = `tasks-${esc(project.id)}`;
    /* Anyone on staff adds a task (0006); a session with no one on the team
       behind it is not offered it. */
    const adds = viewer().id !== null
      ? `<div class="task-actions"><button type="button" class="btn" data-task-new="${esc(project.id)}">${icon('plus')}New task</button></div>`
      : '';
    return `<section class="panel content-panel"><div class="section-title"><h2 id="${heading}">Tasks</h2><span class="quiet-text">${done} / ${tasks.length} complete</span></div>`
      + `<div class="task-list" role="list" aria-labelledby="${heading}">${tasks.map(t => row(t, project, today)).join('')
        || '<p class="quiet-text">No tasks yet.</p>'}</div>`
      + adds + '</section>';
  }

  /* ── The dialogs ───────────────────────────────────────────────────── */

  /* Whether the team loaded. It is not a part the workspace waits for
     (store.js), so a page can open without it: until it has, a task can be for
     the person adding it or for nobody, and the dialog says so. */
  const teamIn = () => !(window.workspaceStore && typeof workspaceStore.has === 'function') || workspaceStore.has('team');

  /* Who a task can be for: the team as loaded, or the person adding it while
     it has not — and, on an edit, whoever it is for now when they are not
     among those, so saving keeps them. */
  function peopleFor(current) {
    const me = viewer();
    const loaded = teamIn();
    const people = loaded
      ? (team || []).map(m => ({ value: m.id, label: m.name }))
      : (me.id !== null ? [{ value: me.id, label: 'You' }] : []);
    const gone = current && !people.some(p => p.value === current)
      ? [{ value: current, label: loaded ? 'Current assignee (no longer on the team)' : 'Current assignee' }]
      : [];
    return [...people, ...gone];
  }

  /* The team a task form is checked against: as loaded, or the person adding
     it alone while it has not. */
  function teamForForm() {
    const me = viewer();
    return teamIn() ? team : (me.id !== null ? [{ id: me.id, status: me.status }] : []);
  }

  /* After a dialog's save, the keyboard's focus on `selector` when it has
     fallen to the page: the page is drawn again after a save, and a refresh
     while the dialog was open may already have replaced the button that
     opened it. Focus somewhere on the page is left where it is. */
  function refocus(selector) {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected !== false) return;
    const next = document.querySelector(selector);
    if (next && next.focus) next.focus();
  }
  const newTaskButton = project => `#main [data-task-new="${project.id}"]`;

  /* A task's fields: filled in from the task an edit changes, or empty for a
     new one — which is for `assigneeId`, the person adding it unless they
     change it, and starts to do, so it has no status to pick. The title has
     the keyboard when the dialog opens. */
  function taskFields(task, assigneeId) {
    const row = (task && task.row) || {};
    return field('Title', `<input name="title" required maxlength="${T.TITLE_LIMIT}" autofocus${task ? ` value="${esc(task.title)}"` : ''}>`)
      + field('Details', `<textarea name="details" maxlength="${T.DETAILS_LIMIT}">${esc(row.details || '')}</textarea>`)
      + field('Assigned to', `<select name="assigneeId"><option value="">Nobody</option>${options(peopleFor(task ? assigneeId : ''), assigneeId)}</select>`)
      + field('Due date', `<input type="date" name="dueDate"${task ? ` value="${esc(row.due_date || '')}"` : ''}>`)
      + field('Priority', `<select name="priority">${options(T.PRIORITIES, task ? T.priorityOf(task) : 'normal')}</select>`)
      + (task ? field('Status', `<select name="status">${options(T.STATUSES, T.statusOf(task))}</select>`) : '');
  }

  /* A new task on this project. Anyone on staff adds one (0006); what the
     model accepts is sent, and "Nobody" is no one. Someone who is not on the
     project's team is told first that they can move it along only if it is
     for them (0050) — asking another team for something is theirs to do, so
     it is said, not refused. Refused by the database, the dialog stays with
     what was typed and says why. */
  function openNew(project) {
    const me = viewer();
    const outside = teamKnown() && !T.canChangeStatus(me, { projectId: project.uuid, assigneeId: null }, project, members());
    const notes = (teamIn() ? '' : '<p class="form-note">The team did not load, so for now a task can be for you or for nobody.</p>')
      + (outside ? '<p class="form-note">You are not on this project’s team, so once it is added you can move it along only if it is for you.</p>' : '');
    /* For whoever adds it: picked when they are in the list; when they are
       not, no one is picked, and the list shows Nobody. */
    showModal('PROJECT · TASK', '<h2>New task</h2>' + notes + dialogForms.form('task-new-form', taskFields(null, me.id || ''), 'Add task'));
    const form = document.getElementById('task-new-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const checked = T.taskForm(Object.fromEntries(new FormData(form).entries()), { team: teamForForm() });
      if (!checked.ok) { say(form, checked.problem, checked.field); return; }
      sending(form, () => workspaceActions.createTask({ ...checked.values, projectId: project.uuid }), () => {
        toast('Task added.');
        refocus(newTaskButton(project));
      });
    });
  }

  function openEdit(task) {
    showModal('PROJECT · TASK', `<h2>Edit ${esc(task.title)}</h2>`
      + dialogForms.form('task-edit-form', taskFields(task, task.assigneeId || ''), 'Save task'));
    const form = document.getElementById('task-edit-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const checked = T.taskForm(Object.fromEntries(new FormData(form).entries()), { team: teamForForm(), projects, task });
      if (!checked.ok) { say(form, checked.problem, checked.field); return; }
      const changes = T.taskChanges(task, checked.values, new Date());
      if (!Object.keys(changes).length) {
        closeDialog(form);
        toast('Nothing changed.');
        return;
      }
      sending(form, () => workspaceActions.updateTask(task.id, changes), () => {
        toast('Task saved.');
        refocus(`#main [data-task-edit="${task.id}"]`);
      }, { record: recordOf(task), part: 'projects' });
    });
  }

  /* What a task's change is saved under until it is loaded back
     (dialog-forms.js): its buttons wait until then. */
  const recordOf = task => `task:${task.id}`;

  /* Removing a task: its buttons go with it, so the keyboard goes to New task. */
  function openRemove(task, project) {
    showModal('PROJECT · TASK', `<h2>Remove ${esc(task.title)}?</h2>`
      + '<p class="form-note">It leaves the project for everyone.</p>'
      + dialogForms.form('task-remove-form', '', 'Remove task'));
    const form = document.getElementById('task-remove-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      sending(form, () => workspaceActions.deleteTask(task.id), () => {
        toast('Task removed.');
        refocus(newTaskButton(project));
      }, { record: recordOf(task), part: 'projects' });
    });
  }

  /* ── What the list's controls do ───────────────────────────────────── */

  const refuse = message => toast(message);

  document.addEventListener('click', e => {
    const target = e.target.closest && e.target.closest('[data-task-new], [data-task-edit], [data-task-remove]');
    if (!target) return;
    e.preventDefault();
    if (!live()) { refuse('Not yet: the workspace is still loading.'); return; }
    if (target.dataset.taskNew !== undefined) {
      const project = (projects || []).find(p => String(p.id) === String(target.dataset.taskNew));
      if (!project) { refuse('That project is not loaded any more. Reload the page.'); return; }
      if (viewer().id === null) { refuse('Only someone on the team can add a task.'); return; }
      openNew(project);
      return;
    }
    const editing = target.dataset.taskEdit !== undefined;
    const found = findTask(editing ? target.dataset.taskEdit : target.dataset.taskRemove);
    if (!found) { refuse('That task is not loaded any more. Reload the page.'); return; }
    if (dialogForms.stillSaving(recordOf(found.task))) { refuse('The last change to that task is still on its way. Try again in a moment.'); return; }
    const me = viewer();
    if (editing ? !T.canEdit(me, found.task) : !T.canDelete(me, found.task)) {
      refuse('Only an owner or admin can ' + (editing ? 'edit' : 'remove') + ' a task.');
      return;
    }
    if (editing) openEdit(found.task);
    else openRemove(found.task, found.project);
  });

  /* The status select a task has on the page now: a repaint while its choice
     settled or saved rebuilt it. It stays enabled while it saves, and says it
     is busy: disabled, it dropped the keyboard's focus to the page, and the
     next arrow key scrolled it. */
  const statusSelectOf = id => [].find.call(document.querySelectorAll('[data-task-status]'), s => s.dataset.taskStatus === id) || null;
  const boxOf = id => [].find.call(document.querySelectorAll('[data-task-id]'), b => b.dataset.taskId === id) || null;
  /* A select back to the status stored: the one the list was drawn with. */
  const resetSelect = select => {
    if (!select) return;
    const drawn = [].filter.call(select.options || [], o => o.defaultSelected)[0];
    const value = (select.dataset && select.dataset.stored) || (drawn && drawn.value);
    if (value) select.value = value;
  };
  /* A task's controls back to the status stored — its select and its box. */
  const putBack = id => {
    resetSelect(statusSelectOf(id));
    const box = boxOf(id);
    if (box && box.dataset && box.dataset.stored) box.checked = box.dataset.stored === 'done';
  };
  const markBusy = (id, busy) => {
    const select = statusSelectOf(id);
    if (!select) return;
    if (busy) select.setAttribute('aria-busy', 'true');
    else select.removeAttribute('aria-busy');
  };
  const REMOVED = 'That task was removed, so its new status was not saved.';
  /* A task as the database has it once a save before landed. */
  const withStatus = (task, status) => ({ ...task, status, done: status === 'done', row: { ...(task.row || {}), status } });

  /* One settled choice, after the task's saves before it. `stored` is the
     status the save before it wrote: a later one compares with that, rather
     than with a reload that may not have brought it. What the database refuses
     is put back on the task's controls — unless a later choice is already on
     its way — and after() says why. */
  async function saveStep(id, chosen, stored) {
    const current = findTask(id);
    if (!current) { refuse(REMOVED); return stored; }
    const base = stored ? withStatus(current.task, stored) : current.task;
    const changes = T.taskChanges(base, { status: chosen }, new Date());
    if (!Object.keys(changes).length) return stored;
    markBusy(id, true);
    try {
      const saved = await workspaceStore.after(workspaceActions.updateTask(current.task.id, changes));
      toast(`${current.task.title}: ${labelIn(T.STATUSES, changes.status)}.`);
      return (saved && saved.status) || changes.status;
    } catch (err) {
      if (statusSaving.get(id) === chosen && !settling.has(id)) putBack(id);
      return stored;
    } finally {
      markBusy(id, false);
    }
  }

  function saveStatus(id, chosen) {
    const found = findTask(id);
    if (!found) { refuse(REMOVED); return; }
    const baseline = statusSaving.has(id) ? statusSaving.get(id) : T.statusOf(found.task);
    if (chosen === baseline) return;
    statusSaving.set(id, chosen);
    statusSaves.set(id, (statusSaves.get(id) || Promise.resolve(null))
      .then(stored => saveStep(id, chosen, stored))
      .then(stored => {
        if (statusSaving.get(id) === chosen) statusSaving.delete(id);
        /* Handed on only to a save still to come: once they stop, the next
           choice starts from what the store has. */
        return statusSaving.has(id) ? stored : null;
      }));
  }

  /* A tick in a task's box (data/writes.js). A click is a choice already made:
     a status still settling in the select gives way to it, and the tick goes
     after a save on its way, as the select's own choices do. */
  function setStatus(id, status) {
    const key = String(id);
    clearTimeout(settling.get(key));
    settling.delete(key);
    saveStatus(key, status);
  }

  /* The status a task's assignee or team picks, saved once the choice settles. */
  document.addEventListener('change', e => {
    const select = e.target.closest && e.target.closest('[data-task-status]');
    if (!select) return;
    if (!live()) { resetSelect(select); refuse('Not yet: the workspace is still loading.'); return; }
    const id = select.dataset.taskStatus;
    const found = findTask(id);
    if (!found || !mayMove(found.task, found.project)) {
      resetSelect(select);
      refuse('Only the task’s assignee, its project’s team, or an owner or admin can move it along.');
      return;
    }
    const chosen = select.value;
    clearTimeout(settling.get(id));
    settling.set(id, setTimeout(() => {
      settling.delete(id);
      saveStatus(id, chosen);
    }, SETTLE_MS));
  });

  return Object.freeze({ panel, setStatus });
})();
