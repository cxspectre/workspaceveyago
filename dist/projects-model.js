/* projects-model.js — Projects' logic, with no page in it.
 *
 * What a project is known by, where it sits on the board, what its status means
 * to the database, who owns it, and which company a typed client name is. Kept
 * apart from the views (workspace.js) so it can be tested without a browser —
 * tests/projects.test.mjs.
 *
 * A project used to be known by its position in the list: in its links, its
 * note panel and its task checkboxes. The list is ordered by sort_order, which
 * every project shares, so a reload could hand the same position to another
 * project — a link, a note or a ticked task landing on the wrong one. It is
 * known by its uuid now, everywhere.
 */
const projectsModel = (function () {
  'use strict';

  /* client_projects.status (0022), in the order work moves through them. */
  const STATUSES = Object.freeze([
    Object.freeze({ value: 'discovery', label: 'Discovery' }),
    Object.freeze({ value: 'in_progress', label: 'In progress' }),
    Object.freeze({ value: 'in_review', label: 'In review' }),
    Object.freeze({ value: 'on_hold', label: 'On hold' }),
    Object.freeze({ value: 'completed', label: 'Completed' }),
    Object.freeze({ value: 'cancelled', label: 'Cancelled' })
  ]);
  const STATUS_LABELS = Object.freeze(STATUSES.map(s => s.label));
  /* The board is for work that is still somewhere. Cancelled work stays in the list. */
  const BOARD = Object.freeze(STATUS_LABELS.filter(label => label !== 'Cancelled'));
  /* Not being worked on: paused, finished or dropped. The Overview tile
     (workspace_overview(), 0029) counts discovery, in progress and in review as
     active, and so does everything here. */
  const INACTIVE = Object.freeze(['On hold', 'Completed', 'Cancelled']);

  /* A date column ('2026-10-03') as a list shows it. A date has no time of day,
     so it is read and written in UTC: anywhere west of Greenwich, local midnight
     would make it the day before. */
  const dueFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  function shortDue(value) {
    const parsed = value ? new Date(`${String(value).slice(0, 10)}T00:00:00Z`) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? dueFormat.format(parsed) : '';
  }

  function statusValue(label) {
    const found = STATUSES.find(s => s.label === label);
    return found ? found.value : null;
  }

  const isActive = project => Boolean(project) && !INACTIVE.includes(project.status);

  const NAME_LIMIT = 200;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  /* A real calendar date. 2026-13-40 is no date at all, and 2026-02-30 is
     quietly read as March 2 — so it has to come back as what went in. */
  const isDate = value => {
    if (!DATE.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };

  /* A project's tickets: the ones filed under it, and its client's tickets that
     are filed under no project yet — both by id. A ticket is never matched by a
     product name that happens to look like the project's. */
  function projectTickets(tickets, project) {
    if (!project) return Object.freeze([]);
    const filedHere = t => t.row.project_id === project.id;
    const clientsUnfiled = t => !t.row.project_id && Boolean(project.companyId) && t.row.company_id === project.companyId;
    return Object.freeze((tickets || []).filter(t => t && t.row && (filedHere(t) || clientsUnfiled(t))));
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  /* When a meeting is over: its end, a day after an all-day start, or its start. */
  const endOf = row => (row.ends_at
    ? Date.parse(row.ends_at)
    : Date.parse(row.starts_at) + (row.all_day ? DAY_MS : 0));

  /* A project's meetings that are not over yet, soonest first. One under way
     stays on the page until it ends. */
  function upcomingEvents(events, project, nowMs) {
    if (!project) return Object.freeze([]);
    return Object.freeze((events || [])
      .filter(e => e && e.row && e.row.project_id === project.id && endOf(e.row) > nowMs)
      .sort((a, b) => Date.parse(a.row.starts_at) - Date.parse(b.row.starts_at)));
  }

  /* What an edit changes, as client_projects columns: only fields the form
     sent, and only where they differ from the project as it was loaded. An
     empty text field means "none". `problem` says why nothing can be saved. */
  function projectChanges(project, fields) {
    const f = fields || {};
    const was = project || {};
    const has = key => Object.prototype.hasOwnProperty.call(f, key) && f[key] !== undefined;
    /* Line breaks as the database keeps them: a browser may send a textarea's as CRLF. */
    const text = value => String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
    const orNull = value => text(value) || null;
    const refuse = problem => Object.freeze({ changes: Object.freeze({}), problem });

    /* The form always sends the name, so it is judged only when it changed: a
       name that is already too long must not block moving the due date. */
    const renamed = has('name') && text(f.name) !== text(was.name);
    if (renamed && !text(f.name)) return refuse('A project needs a name.');
    if (renamed && text(f.name).length > NAME_LIMIT) return refuse(`A project name is at most ${NAME_LIMIT} characters long.`);
    if (has('dueOn') && text(f.dueOn) && !isDate(text(f.dueOn))) return refuse('That due date is not a date.');

    /* [form field, column, what the form says, what the project said], both
       sides tidied the same way, so a form nobody touched changes nothing. */
    const candidates = [
      ['name', 'name', text(f.name), text(was.name)],
      ['description', 'description', orNull(f.description), orNull(was.description)],
      ['companyId', 'company_id', orNull(f.companyId), orNull(was.companyId)],
      ['ownerId', 'owner_id', orNull(f.ownerId), orNull(was.ownerId)],
      ['dueOn', 'due_on', orNull(f.dueOn), orNull(was.dueOn)]
    ];
    const changes = candidates
      .filter(([field, , value, current]) => has(field) && value !== current)
      .reduce((all, [, column, value]) => ({ ...all, [column]: value }), {});
    return Object.freeze({ changes: Object.freeze(changes), problem: null });
  }

  /* A picker's options as [id, name]. The current value is kept even when the
     list does not have it — a company list that did not load, an owner who has
     left — so saving a form nobody touched never clears it. */
  function choices(items, current, currentLabel) {
    const list = (items || [])
      .filter(item => item && item.id)
      .map(item => Object.freeze([String(item.id), String(item.name || '')]));
    const keep = Boolean(current) && !list.some(([id]) => id === String(current));
    return Object.freeze(keep ? [Object.freeze([String(current), currentLabel || 'Current']), ...list] : list);
  }

  /* ── Meetings ──────────────────────────────────────────────────────── */

  const WORKING_DAY = Object.freeze({ first: 9, last: 17, morning: 10 });
  const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

  /* The time a meeting dialog suggests first: the next whole hour, or 10:00
     when that falls outside the working day. */
  function suggestedStart(now) {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
    const inDay = next.getDate() === now.getDate()
      && next.getHours() >= WORKING_DAY.first && next.getHours() <= WORKING_DAY.last;
    if (inDay) return next;
    const nextDay = now.getHours() >= WORKING_DAY.first ? 1 : 0;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + nextDay, WORKING_DAY.morning);
  }

  /* A meeting form's day and times as moments on this clock, or why they cannot
     be booked, with `field` naming the input to point at. A meeting already
     under way may be put on record; one that is over would never be listed. */
  function meetingTimes(values, now) {
    const v = values || {};
    const day = String(v.day || '');
    const start = TIME.exec(String(v.start || ''));
    const end = TIME.exec(String(v.end || ''));
    if (!isDate(day) || !start || !end) {
      return Object.freeze({ startsAt: null, endsAt: null, problem: 'Pick the day and the times again.', field: 'day' });
    }
    const [year, month, date] = day.split('-').map(Number);
    const at = time => new Date(year, month - 1, date, Number(time[1]), Number(time[2]));
    const startsAt = at(start);
    const endsAt = at(end);
    const refuse = (problem, field) => Object.freeze({ startsAt, endsAt, problem, field });
    if (endsAt <= startsAt) return refuse('A meeting ends after it starts.', 'end');
    if (endsAt <= now) return refuse('That time has already passed.', 'start');
    return Object.freeze({ startsAt, endsAt, problem: null, field: null });
  }

  /* Every project's tasks from one list, by project id, in the list's order. A
     task without a project belongs to none. Built in place here: copying the
     groups for every task would be quadratic in a studio's task count. */
  function groupTasks(tasks) {
    const groups = new Map();
    (tasks || []).forEach(t => {
      const projectId = t && t.row && t.row.project_id;
      if (!projectId) return;
      if (!groups.has(projectId)) groups.set(projectId, []);
      groups.get(projectId).push(t);
    });
    return Object.freeze(Object.fromEntries([...groups].map(([id, list]) => [id, Object.freeze(list)])));
  }

  /* A project as the views use it: everything by id, and its tasks as titles
     with a parallel list of ids, due dates and ticked positions (taskRows,
     checkedTasks). `project` is what queries.projects() returns; `tasks` is
     every project's tasks. Not frozen: the views' offline handlers still tick
     and add tasks in place. */
  function shapeProject(project, tasks) {
    const row = project.row || {};
    const mine = (tasks || []).filter(t => t && t.row && t.row.project_id === project.id);
    return {
      id: project.id,
      uuid: project.id,
      name: project.name,
      client: project.client,
      companyId: row.company_id || null,
      ownerId: row.owner_id || null,
      initial: project.initial,
      style: project.style,
      progress: project.progress,
      /* From the date column itself, read in UTC like a task's: the list's own
         label was read as local midnight and showed a day early in America. */
      due: row.due_on ? shortDue(row.due_on) : (project.due || ''),
      dueOn: row.due_on || null,
      status: project.status,
      description: project.description,
      tasks: mine.map(t => t.title),
      taskIds: mine.map(t => t.id),
      taskDue: mine.map(t => shortDue(t.row.due_date)),
      checked: mine.reduce((ticked, t, i) => (t.done ? ticked.concat(i) : ticked), [])
    };
  }

  /* By id and nothing else: an old position-based link ("#projects/0") opens
     nothing, rather than whichever project sits there now. */
  function projectById(projects, id) {
    if (typeof id !== 'string' || !id) return null;
    return (projects || []).find(p => p.id === id) || null;
  }

  function boardColumns(projects) {
    return Object.freeze(BOARD.map(status => Object.freeze({
      status,
      projects: Object.freeze((projects || []).filter(p => p.status === status))
    })));
  }

  function ownerOf(project, team) {
    if (!project || !project.ownerId) return null;
    return (team || []).find(member => member && member.id === project.ownerId) || null;
  }

  /* A company name as it is compared: look-alike characters folded (full-width
     letters, a non-breaking space), runs of spaces made one, case ignored. */
  const companyKey = name => String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

  /* Every company a typed client name could mean. Every company counts — one
     with no contacts yet used to be missed, and a second one created beside it. */
  function matchCompanies(companies, name) {
    const wanted = companyKey(name);
    if (!wanted) return Object.freeze([]);
    return Object.freeze((companies || []).filter(c => c && companyKey(c.name) === wanted));
  }

  /* The company a typed name means, when exactly one does. With two of the same
     name the choice is the person's, not the first in the alphabet's. */
  function findCompany(companies, name) {
    const matches = matchCompanies(companies, name);
    return matches.length === 1 ? matches[0] : null;
  }

  return Object.freeze({
    STATUSES, STATUS_LABELS, BOARD,
    NAME_LIMIT,
    statusValue, isActive, shortDue, groupTasks, shapeProject, projectById, boardColumns, ownerOf,
    matchCompanies, findCompany, projectTickets, upcomingEvents, projectChanges, choices,
    suggestedStart, meetingTimes
  });
})();
