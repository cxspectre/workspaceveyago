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
    statusValue, isActive, shortDue, groupTasks, shapeProject, projectById, boardColumns, ownerOf,
    matchCompanies, findCompany
  });
})();
