/* tasks-model.js — project tasks and notes, with no page in it.
 *
 * What a task's status and priority can be and how they read, what its
 * checkbox shows and what ticking it sets, who may move a task along, edit it
 * or delete it, what a task form may save and what an edit changes, when a
 * task is due and the order a list shows tasks in — and who may add, change
 * or remove a note, and what a note needs. Kept apart from the views so it can
 * be tested without a browser — tests/tasks.test.mjs.
 *
 * Every rule is the database's, and says which migration it comes from: tasks
 * (0005, 0006, 0022), notes (0032), project teams (0039), who is a manager
 * (0013, 0040), inactive people and the second factor (0006, 0040), and who
 * moves a task along and what marking one done sends with it (0050). They are
 * checked here to say so before a write is refused, never instead of the
 * database: RLS still refuses whatever gets past this. Two things are the
 * workspace's own, and say so: how long a title and its details may be, and
 * how a due date reads.
 *
 * Takes tasks as queries.js shapes them — { id, title, done, status,
 * assigneeId, row } with the tasks row under `row` — or the rows themselves;
 * the viewer as workspaceSession.employee has them; the team, a project's
 * members and projects as the store loads them. Everything it hands back is
 * frozen. It uses nothing else on the page.
 */
const tasksModel = (function () {
  'use strict';

  /* tasks.status (0005), in the order work moves through them. */
  const STATUSES = Object.freeze([
    Object.freeze({ value: 'todo', label: 'To do' }),
    Object.freeze({ value: 'in_progress', label: 'In progress' }),
    Object.freeze({ value: 'blocked', label: 'Blocked' }),
    Object.freeze({ value: 'done', label: 'Done' })
  ]);
  /* tasks.priority (0005), lowest first. */
  const PRIORITIES = Object.freeze([
    Object.freeze({ value: 'low', label: 'Low' }),
    Object.freeze({ value: 'normal', label: 'Normal' }),
    Object.freeze({ value: 'high', label: 'High' }),
    Object.freeze({ value: 'urgent', label: 'Urgent' })
  ]);
  /* workspace_notes.entity_type (0032): what a note can be on. */
  const NOTE_TARGETS = Object.freeze(['ticket', 'project', 'contact', 'company', 'event', 'task']);

  /* The workspace's limits, not the database's: tasks.title and tasks.details
     are text of any length (0005). A title is one line on the board, as long
     as a project's name may be (projects-model.js). */
  const TITLE_LIMIT = 200;
  const DETAILS_LIMIT = 10000;

  /* Both columns' defaults (0005): what a task has when a form sends none, and
     what a value the column cannot hold reads as. */
  const DEFAULT_STATUS = 'todo';
  const DEFAULT_PRIORITY = 'normal';
  const DONE = 'done';
  /* Started and not finished: the checkbox shows these as mixed. */
  const UNDER_WAY = Object.freeze(['in_progress', 'blocked']);
  /* is_manager() (0013, 0040): employee_role() in ('owner', 'admin'), and nothing else. */
  const MANAGER_ROLES = Object.freeze(['owner', 'admin']);

  const PROBLEMS = Object.freeze({
    title: 'A task needs a title.',
    titleLength: `A task title is at most ${TITLE_LIMIT} characters long.`,
    details: `A task's details are at most ${DETAILS_LIMIT} characters long.`,
    assigneeId: 'Pick someone on the team, or nobody.',
    dueDate: 'That due date is not a date.',
    priority: 'Pick a priority from the list.',
    status: 'Pick a status from the list.',
    projectId: 'Pick a project from the list, or none.',
    body: 'Write something first.',
    entityType: 'A note goes on a ticket, project, contact, company, event or task.',
    entityId: 'That record has no id yet.'
  });

  const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  const DAY_MS = 24 * 60 * 60 * 1000;
  /* A weekday names a day of the week ahead; seven days on, it would name today. */
  const WEEK_AHEAD = 6;
  const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
  /* A uuid as Postgres writes one: workspace_notes.entity_id is a uuid (0032). */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const text = value => String(value == null ? '' : value);
  const pad = n => String(n).padStart(2, '0');
  /* Text as the database keeps it: line breaks as \n — a browser may send a
     textarea's as \r\n — with no NUL, which Postgres text cannot hold, and no
     spaces around it. */
  const tidy = value => text(value).replace(/\r\n?/g, '\n').split(String.fromCharCode(0)).join('').trim();
  const orNull = value => tidy(value) || null;
  const idText = value => (text(value) === '' ? null : text(value));
  const isObject = value => Boolean(value) && typeof value === 'object';
  const has = (values, key) => Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined;
  /* Not instanceof, which is false for a Date made in another frame. */
  const isDate = value => Object.prototype.toString.call(value) === '[object Date]';
  /* The database row a record carries, or the record when it is a row itself. */
  const rowOf = record => (isObject(record) && isObject(record.row) ? record.row : isObject(record) ? record : {});
  /* A column from the row, else the shaped record's own name for it — or null. */
  function read(record, column, field) {
    const row = rowOf(record);
    if (row[column] != null) return row[column];
    return isObject(record) && record[field] != null ? record[field] : null;
  }

  /* A status or priority as the database has it, from its value or its label:
     'in_progress' and 'In progress' are the same status. */
  function valueIn(list, given) {
    const wanted = text(given).trim().toLowerCase();
    const hit = wanted ? list.find(x => x.value === wanted || x.label.toLowerCase() === wanted) : null;
    return hit ? hit.value : null;
  }

  /* ── Reading a task ────────────────────────────────────────────────── */

  /* A task's status, as a value from STATUSES. Every task has one (0005); a
     value the column cannot hold reads as its default, 'todo' — or 'done' when
     the task says done: true, as queries.js shapes one. */
  function statusOf(task) {
    return valueIn(STATUSES, read(task, 'status', 'status')) || (isObject(task) && task.done === true ? DONE : DEFAULT_STATUS);
  }

  /* A task's priority, as a value from PRIORITIES; one the column cannot hold
     reads as its default, 'normal' (0005). */
  function priorityOf(task) {
    return valueIn(PRIORITIES, read(task, 'priority', 'priority')) || DEFAULT_PRIORITY;
  }

  const titleOf = task => tidy(read(task, 'title', 'title'));
  const detailsOf = task => orNull(read(task, 'details', 'details'));
  const assigneeOf = task => idText(read(task, 'assignee_id', 'assigneeId'));
  const projectOf = task => idText(read(task, 'project_id', 'projectId'));
  /* A task's due date as its key, "2026-09-30", or null when it has none that is a date. */
  function dueOf(task) {
    const due = tidy(read(task, 'due_date', 'dueDate'));
    return isDateKey(due) ? due : null;
  }

  /* ── The checkbox ──────────────────────────────────────────────────── */

  /* What a task's checkbox shows, and what toggling it sets. Takes a task;
     returns { status, label, checked, mixed, next, action }.
     The box is ticked for a done task, and mixed — neither empty nor ticked,
     aria-checked="mixed" — for one in progress or blocked, so a task under way
     never looks untouched; `label` names the status either way. Ticking any
     task that is not done sets `next`, 'done'. Unticking a done task sets
     'todo', the column's default: the database keeps no record of what a task
     was before it was done (0005), and guessing would be worse. In progress
     and blocked are never the box's to set: they are picked from STATUSES and
     saved with taskChanges(). completed_at goes with every status, and is not
     set here: workspaceActions.setTaskDone() sends it with a tick, and
     taskChanges() with a status picked from the list (0050). */
  function tick(task) {
    const status = statusOf(task);
    const done = status === DONE;
    return Object.freeze({
      status,
      label: STATUSES.find(s => s.value === status).label,
      checked: done,
      mixed: UNDER_WAY.includes(status),
      next: done ? DEFAULT_STATUS : DONE,
      action: done ? 'Reopen' : 'Mark as done'
    });
  }

  /* ── Who may do what ───────────────────────────────────────────────── */

  /* Who is looking, as the database knows them: { id, manager }. `viewer` is
     the signed-in person's employees row as workspaceSession.employee has it,
     { id, role, status }, and the row alone decides. is_manager() is
     employee_role() in ('owner', 'admin') and nothing else — 0007 and 0013 took
     the admins allowlist out of it, and 0040 keeps it so — so someone with no
     employees row is neither staff nor a manager, and a `manager` flag next to
     a row is not read. Someone inactive has no role and no employee id (0006),
     and neither does a session that still owes its second factor (0040), which
     the workspace does not open for. */
  function viewerOf(viewer) {
    const v = isObject(viewer) ? viewer : {};
    const id = v.status !== 'inactive' ? idText(v.id) : null;
    return Object.freeze({ id, manager: id !== null && MANAGER_ROLES.includes(v.role) });
  }

  const projectIdOf = project => idText(isObject(project) ? (project.id != null ? project.id : project.uuid) : null);
  const ownerOf = project => idText(isObject(project) ? (project.ownerId != null ? project.ownerId : rowOf(project).owner_id) : null);

  /* Whether an employee is on the team of a task's project (0039): its owner
     or one of its members. `team` is either the member rows
     queries.projectMembers() loads for every project, { project_id,
     employee_id }, or one project's team as projectsModel.projectTeam() lists
     it, { employeeId }, which counts only when `project` is the task's own. */
  function onTeam(employeeId, task, project, team) {
    const projectId = projectOf(task);
    if (!employeeId || !projectId) return false;
    const ours = projectIdOf(project) === projectId;
    if (ours && ownerOf(project) === employeeId) return true;
    return (Array.isArray(team) ? team : []).some(m => isObject(m)
      && idText(m.employee_id != null ? m.employee_id : m.employeeId) === employeeId
      && (m.project_id != null ? idText(m.project_id) === projectId : ours));
  }

  /* Whether the viewer may move a task along — change its status (0050): an
     owner or admin, the task's assignee (assignee_id = active_employee_id(),
     0006), or someone on the team of the task's project, its owner or a member
     (0039). Nobody else on staff; and a task on no project has no team.
     Takes (viewer, task, project, team): the viewer as viewerOf() reads them,
     the task, the task's project as the store shapes it ({ id, ownerId }) or
     its row ({ id, owner_id }), and its team as onTeam() reads it. Returns a
     boolean. */
  function canChangeStatus(viewer, task, project, team) {
    if (!isObject(task)) return false;
    const me = viewerOf(viewer);
    if (me.manager) return true;
    return me.id !== null && (assigneeOf(task) === me.id || onTeam(me.id, task, project, team));
  }

  /* Whether the viewer may edit a task — its title, details, assignee,
     priority, due date or project: owners and admins only (0050). Everyone
     else changes the status alone, and the database puts back any other
     column they send (tasks_guard_assignee_columns, 0006 and 0022). Takes the
     arguments canChangeStatus() does, though only the viewer and the task
     matter; returns a boolean. */
  function canEdit(viewer, task) {
    return isObject(task) && viewerOf(viewer).manager;
  }

  /* Whether the viewer may delete a task: owners and admins only (0050). No
     policy on tasks but "manager all tasks" allows a delete (0005). Takes the
     arguments canChangeStatus() does; returns a boolean. */
  function canDelete(viewer, task) {
    return isObject(task) && viewerOf(viewer).manager;
  }

  /* ── The task form ─────────────────────────────────────────────────── */

  /* Whether an employee id is someone on the team who can be given work: in
     the team as queries.team() loads it, and not inactive. The list leaves
     inactive people out; a row that says so is refused all the same. Someone
     invited counts, as active_employee_id() counts them (0006). */
  function onStaff(team, employeeId) {
    return (Array.isArray(team) ? team : []).some(m => isObject(m)
      && idText(m.id) === employeeId && rowOf(m).status !== 'inactive' && m.status !== 'inactive');
  }

  /* Whether a project id is one of `projects`, when they are given; without
     them, the foreign key on tasks.project_id (0022) is the only check. */
  const listed = (projects, id) => !Array.isArray(projects) || projects.some(p => projectIdOf(p) === id);

  const titleProblem = title => (!title ? PROBLEMS.title : title.length > TITLE_LIMIT ? PROBLEMS.titleLength : null);

  /* A priority or status picked from its list: always this form's to judge,
     since what the task already has follows the column's rule. None picked is
     none sent. */
  const choice = (field, values, list) => [field, has(values, field) && tidy(values[field]) !== '',
    valueIn(list, values[field]), valueIn(list, values[field]) ? null : PROBLEMS[field]];

  /* A task form's fields as [field, sent, value, problem], in the form's order. */
  function taskReadings(v, c) {
    const task = isObject(c.task) ? c.task : null;
    /* On an edit, a value the task already has is not judged again. */
    const judged = (value, current) => !task || value !== current;
    const title = tidy(v.title);
    const details = orNull(v.details);
    const assigneeId = orNull(v.assigneeId);
    const dueDate = orNull(v.dueDate);
    const projectId = orNull(v.projectId);
    return [
      ['title', has(v, 'title') || !task, title, judged(title, task && titleOf(task)) ? titleProblem(title) : null],
      ['details', has(v, 'details'), details,
        details !== null && details.length > DETAILS_LIMIT && judged(details, task && detailsOf(task)) ? PROBLEMS.details : null],
      ['assigneeId', has(v, 'assigneeId'), assigneeId,
        assigneeId !== null && judged(assigneeId, task && assigneeOf(task)) && !onStaff(c.team, assigneeId) ? PROBLEMS.assigneeId : null],
      ['dueDate', has(v, 'dueDate'), dueDate, dueDate !== null && !isDateKey(dueDate) ? PROBLEMS.dueDate : null],
      choice('priority', v, PRIORITIES),
      choice('status', v, STATUSES),
      ['projectId', has(v, 'projectId'), projectId,
        projectId !== null && judged(projectId, task && projectOf(task)) && !listed(c.projects, projectId) ? PROBLEMS.projectId : null]
    ].filter(([, sent]) => sent);
  }

  /* Readings as a form's answer: { ok, values, errors, problem, field }.
     Nothing is handed back to save until all of it can be. */
  function formResult(readings) {
    const refused = readings.filter(([, , , problem]) => problem);
    const ok = refused.length === 0;
    return Object.freeze({
      ok,
      values: Object.freeze(ok ? Object.fromEntries(readings.map(([field, , value]) => [field, value])) : {}),
      errors: Object.freeze(Object.fromEntries(refused.map(([field, , , problem]) => [field, problem]))),
      problem: ok ? null : refused[0][3],
      field: ok ? null : refused[0][0]
    });
  }

  /* A task form, checked before anything is saved. Takes the form's values —
     { title, details, assigneeId, dueDate, priority, status, projectId }, any
     of them — and context { team, projects, task }: the team as queries.team()
     loads it, the projects as the store has them, and for an edit the task as
     it was loaded. Returns { ok, values, errors, problem, field }.
     `values` holds what the form sent, tidied, as workspaceActions.createTask()
     takes it, null for "none" — a field not sent is left out, and the
     database's default applies. `errors` names each field that cannot be
     saved, and `problem` and `field` are the first of them, for a form that
     points at one. A title is needed and at most TITLE_LIMIT characters;
     details at most DETAILS_LIMIT; the assignee someone on the team who is
     not inactive; the due date a real date, "2026-09-30"; the priority and
     status from their lists; the project one of `projects`, when given. On an
     edit, what the task already has is not judged again: a title that was
     already too long, or an assignee who has since left, must not block
     moving the due date. */
  function taskForm(values, context) {
    return formResult(taskReadings(isObject(values) ? values : {}, isObject(context) ? context : {}));
  }

  /* The time a task is marked done at, as completed_at takes it: `now` when it
     is a Date that is a time, else null. No time is made up. */
  const stamp = now => (isDate(now) && !Number.isNaN(now.getTime()) ? now.toISOString() : null);

  /* What an edit changes, as tasks columns (0005, 0022). Takes the task as it
     was loaded, `values` as taskForm() hands them back, and `now`, the Date the
     edit is saved at. Returns a frozen { column: value } with only the fields
     `values` has, and only where they differ from the task — both sides tidied
     the same way, so a form nobody touched changes nothing. Anything taskForm()
     refuses outright — no title, a priority or status from no list, a due date
     that is not a date — is left out rather than written; the length limits
     are taskForm()'s to apply. A changed status takes completed_at with it, the
     way workspaceActions.setTaskDone() and the admin send it, because no
     trigger stamps it (0050): `now` when the task becomes done, null when it
     becomes anything else. Done is never sent without its time — the admin
     counts "done this week" by completed_at (admin/js/tasks.js) — so marking a
     task done needs `now`: without a Date that is a time, the status is left as
     it was, and the rest of the edit still goes. */
  function taskChanges(task, values, now) {
    const v = isObject(values) ? values : {};
    const due = orNull(v.dueDate);
    const status = valueIn(STATUSES, v.status);
    const sendable = status === DONE && stamp(now) === null ? null : status;
    /* [form field, column, what the form says (undefined: leave out), what the task has] */
    const candidates = [
      ['title', 'title', tidy(v.title) || undefined, titleOf(task)],
      ['details', 'details', orNull(v.details), detailsOf(task)],
      ['assigneeId', 'assignee_id', orNull(v.assigneeId), assigneeOf(task)],
      ['dueDate', 'due_date', due === null || isDateKey(due) ? due : undefined, dueOf(task)],
      ['priority', 'priority', valueIn(PRIORITIES, v.priority) || undefined, priorityOf(task)],
      ['status', 'status', sendable || undefined, statusOf(task)],
      ['projectId', 'project_id', orNull(v.projectId), projectOf(task)]
    ];
    const changes = Object.fromEntries(candidates
      .filter(([field, , value, current]) => has(v, field) && value !== undefined && value !== current)
      .map(([, column, value]) => [column, value]));
    const completed = changes.status === undefined ? {} : { completed_at: changes.status === DONE ? stamp(now) : null };
    return Object.freeze({ ...changes, ...completed });
  }

  /* ── When a task is due ────────────────────────────────────────────── */

  /* A date key, "2026-09-14", as a day number — whole days since 1970, counted
     in UTC, where every day is 24 hours long — or null. A key that does not
     come back as itself was never a date: 2026-02-30 is not March 2. Nor is
     year 0, which Postgres has no date in. */
  function dayNumber(key) {
    const m = DATE_KEY.exec(text(key).trim());
    if (!m || Number(m[1]) < 1) return null;
    const date = new Date(`${m[0]}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === m[0] ? date.getTime() / DAY_MS : null;
  }

  function isDateKey(key) {
    return dayNumber(key) !== null;
  }

  /* Today as a day number: `today` is a Date — the day it is on this clock —
     or that day's key. Null when it is neither. */
  function todayNumber(today) {
    if (!isDate(today)) return dayNumber(today);
    if (Number.isNaN(today.getTime())) return null;
    return dayNumber(`${String(today.getFullYear()).padStart(4, '0')}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  }

  /* A day number as a list shows it: "Sep 30", with the year when it is not
     `year`: "Jan 5, 2027". */
  function shortDate(number, year) {
    const date = new Date(number * DAY_MS);
    const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
    return date.getUTCFullYear() === year ? label : `${label}, ${date.getUTCFullYear()}`;
  }

  /* Which reading a due date gets, `days` after today (null: no today known). */
  function dueKey(days, done) {
    if (days === null) return 'date';
    if (days < 0) return done ? 'date' : 'overdue';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return days <= WEEK_AHEAD ? 'weekday' : 'date';
  }

  /* When a task is due, as a list shows it. Takes a task and today — a Date,
     read on this clock, or a date key. Returns { key, label, date, overdue,
     dueOn }: key is 'none', 'overdue', 'today', 'tomorrow', 'weekday' or
     'date'; label reads "Overdue · Sep 10", "Due today", "Due tomorrow", "Due
     Friday" for a day of the week ahead, or "Due Sep 30" — "Due Jan 5, 2027"
     when it is not this year; date is the date alone; dueOn the date key.
     tasks.due_date is a date, not a moment (0005), so no time zone moves it:
     only today is this clock's. Due today is not late yet, and a done task is
     never overdue. Without a today to count from, a due date reads as its
     date, with its year. */
  function dueLabel(task, today) {
    const dueOn = dueOf(task);
    if (dueOn === null) return Object.freeze({ key: 'none', label: '', date: '', overdue: false, dueOn: null });
    const due = dayNumber(dueOn);
    const now = todayNumber(today);
    const date = shortDate(due, now === null ? null : new Date(now * DAY_MS).getUTCFullYear());
    const key = dueKey(now === null ? null : due - now, statusOf(task) === DONE);
    const labels = {
      overdue: `Overdue · ${date}`,
      today: 'Due today',
      tomorrow: 'Due tomorrow',
      weekday: `Due ${WEEKDAYS[new Date(due * DAY_MS).getUTCDay()]}`,
      date: `Due ${date}`
    };
    return Object.freeze({ key, label: labels[key], date, overdue: key === 'overdue', dueOn });
  }

  /* ── The order of a list ───────────────────────────────────────────── */

  const byKey = (a, b, key) => (a[key] === b[key] ? 0 : a[key] < b[key] ? -1 : 1);

  /* Tasks in the order a list shows them: open before done; then overdue
     first; then by due date, soonest first and undated last; then urgent
     before low; then oldest first by created_at — and, where that is not
     loaded, in the order they came, which is queries.js's by created_at.
     Takes tasks and today as dueLabel() does; returns them in a new frozen
     list, leaving out anything that is not a task. The tasks are not copied. */
  function sortTasks(tasks, today) {
    const now = todayNumber(today);
    const keyed = (Array.isArray(tasks) ? tasks : []).filter(isObject).map((task, index) => {
      const done = statusOf(task) === DONE;
      const due = dayNumber(dueOf(task));
      const created = Date.parse(read(task, 'created_at', 'createdAt'));
      return {
        task,
        index,
        done: done ? 1 : 0,
        overdue: !done && due !== null && now !== null && due < now ? 0 : 1,
        due: due === null ? Infinity : due,
        priority: PRIORITIES.length - PRIORITIES.findIndex(p => p.value === priorityOf(task)),
        created: Number.isNaN(created) ? Infinity : created
      };
    });
    return Object.freeze(keyed
      .sort((a, b) => byKey(a, b, 'done') || byKey(a, b, 'overdue') || byKey(a, b, 'due')
        || byKey(a, b, 'priority') || byKey(a, b, 'created') || a.index - b.index)
      .map(k => k.task));
  }

  /* ── Notes (0032) ──────────────────────────────────────────────────── */

  /* Who wrote a note: workspace_notes.author_id, from the row — which
     queries.notes() has to select — or a shaped note's authorId. Null once the
     author's employees row is gone (on delete set null). */
  const authorOf = note => idText(isObject(note) ? (note.authorId != null ? note.authorId : rowOf(note).author_id) : null);

  /* Whether the viewer may add a note. A note's author is its writer's own
     employees row ("staff writes workspace_notes": is_staff() and author_id =
     active_employee_id()), so someone with none cannot. Takes the viewer;
     returns a boolean. */
  function canAddNote(viewer) {
    return viewerOf(viewer).id !== null;
  }

  /* Whether the viewer may change a note's text: its author, and nobody else —
     an owner or admin neither ("author edits own workspace_notes"). Takes
     (viewer, note), the note as queries.notes() shapes it or its row; returns
     a boolean. */
  function canEditNote(viewer, note) {
    const me = viewerOf(viewer);
    return me.id !== null && authorOf(note) === me.id;
  }

  /* Whether the viewer may remove a note: its author, or an owner or admin
     ("author or manager deletes workspace_notes"). Takes (viewer, note);
     returns a boolean. */
  function canDeleteNote(viewer, note) {
    if (!isObject(note)) return false;
    const me = viewerOf(viewer);
    return me.manager || (me.id !== null && authorOf(note) === me.id);
  }

  /* A note form, checked the way workspace_notes checks a row. Takes the
     form's values, { body, entityType, entityId }, and options — { edit: true }
     for an edit, which changes the body alone and is checked for the body
     alone. Anything else is a new note, which needs all three: entity_type and
     entity_id are not null (0032), so a note on no record could never be
     saved. Returns { ok, values, errors, problem, field } as taskForm() does,
     `values` holding what the insert or the update sends. The body needs
     something in it (length(trim(body)) > 0) and is saved without the spaces
     around it — a body of line breaks is empty to a person, though Postgres's
     trim() keeps them; entityType is one of NOTE_TARGETS, exactly; entityId is
     the record's uuid. */
  function noteForm(values, options) {
    const v = isObject(values) ? values : {};
    const body = tidy(v.body);
    const readings = [['body', true, body, body ? null : PROBLEMS.body]];
    if (isObject(options) && options.edit === true) return formResult(readings);
    const entityType = tidy(v.entityType);
    const entityId = tidy(v.entityId);
    return formResult([...readings,
      ['entityType', true, entityType, NOTE_TARGETS.includes(entityType) ? null : PROBLEMS.entityType],
      ['entityId', true, entityId, UUID.test(entityId) ? null : PROBLEMS.entityId]
    ]);
  }

  return Object.freeze({
    STATUSES, PRIORITIES, NOTE_TARGETS, TITLE_LIMIT, DETAILS_LIMIT,
    statusOf, priorityOf, tick,
    canChangeStatus, canEdit, canDelete,
    taskForm, taskChanges,
    dueLabel, sortTasks,
    canAddNote, canEditNote, canDeleteNote, noteForm
  });
})();
