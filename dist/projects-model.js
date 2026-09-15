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
    if (has('startsOn') && text(f.startsOn) && !isDate(text(f.startsOn))) return refuse('That start date is not a date.');
    /* Judged when a date changed, like the name: dates that were already the
       wrong way round must not block renaming the project. */
    const startsOn = has('startsOn') ? orNull(f.startsOn) : orNull(was.startsOn);
    const dueOn = has('dueOn') ? orNull(f.dueOn) : orNull(was.dueOn);
    const redated = startsOn !== orNull(was.startsOn) || dueOn !== orNull(was.dueOn);
    if (redated && startsOn && dueOn && startsOn > dueOn) return refuse('The start date is after the due date.');

    /* [form field, column, what the form says, what the project said], both
       sides tidied the same way, so a form nobody touched changes nothing. */
    const candidates = [
      ['name', 'name', text(f.name), text(was.name)],
      ['description', 'description', orNull(f.description), orNull(was.description)],
      ['companyId', 'company_id', orNull(f.companyId), orNull(was.companyId)],
      ['ownerId', 'owner_id', orNull(f.ownerId), orNull(was.ownerId)],
      ['startsOn', 'starts_on', orNull(f.startsOn), orNull(was.startsOn)],
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

  /* ── The team (0039) ───────────────────────────────────────────────── */

  const FORMER_MEMBER = 'Former team member';
  const membersOf = (project, memberRows) =>
    (memberRows || []).filter(m => m && project && m.project_id === project.id);

  /* Who runs a project's team, as can_manage_project() decides: owners and
     admins, and the project's own owner. */
  function canManageProject(project, meId, manager) {
    return Boolean(manager) || (Boolean(meId) && Boolean(project) && project.ownerId === meId);
  }

  /* Who opens a project's files, as can_open_project_files() decides: whoever
     runs its team, and its members. */
  function canOpenFiles(project, memberRows, meId, manager) {
    return canManageProject(project, meId, manager)
      || (Boolean(meId) && membersOf(project, memberRows).some(m => m.employee_id === meId));
  }

  /* A project's team: its owner first, then its members in the order they
     joined, each once. Someone who has left the team is still named as such. */
  function projectTeam(project, memberRows, team) {
    if (!project) return Object.freeze([]);
    const entry = (employeeId, owner) => {
      const person = (team || []).find(m => m && m.id === employeeId);
      return Object.freeze({
        employeeId,
        owner,
        name: person ? person.name : FORMER_MEMBER,
        initial: person ? person.initial : '?'
      });
    };
    const owner = project.ownerId ? [entry(project.ownerId, true)] : [];
    const members = membersOf(project, memberRows)
      .filter(m => m.employee_id !== project.ownerId)
      .map(m => entry(m.employee_id, false));
    return Object.freeze([...owner, ...members]);
  }

  /* Who can still join, as [id, name]: the team's people who are neither the
     project's owner nor a member of it already. */
  function teamCandidates(project, memberRows, team) {
    if (!project) return Object.freeze([]);
    const taken = new Set([project.ownerId, ...membersOf(project, memberRows).map(m => m.employee_id)]);
    return Object.freeze((team || [])
      .filter(m => m && m.id && !taken.has(m.id))
      .map(m => Object.freeze([String(m.id), String(m.name || '')])));
  }

  /* ── The client's people (0039) ────────────────────────────────────── */

  /* project_contacts.role, in the order a list shows them. */
  const CONTACT_ROLES = Object.freeze([
    Object.freeze({ value: 'decision_maker', label: 'Decision maker' }),
    Object.freeze({ value: 'billing', label: 'Billing' }),
    Object.freeze({ value: 'day_to_day', label: 'Day to day' }),
    Object.freeze({ value: 'technical', label: 'Technical' }),
    Object.freeze({ value: 'other', label: 'Other' })
  ]);
  const GONE_CONTACT = 'A contact no longer in the CRM';
  const roleIndex = value => {
    const index = CONTACT_ROLES.findIndex(r => r.value === value);
    return index < 0 ? CONTACT_ROLES.length : index;
  };
  const roleLabel = value => (CONTACT_ROLES.find(r => r.value === value) || CONTACT_ROLES[CONTACT_ROLES.length - 1]).label;
  const linksOf = (project, linkRows) =>
    (linkRows || []).filter(l => l && project && l.project_id === project.id);

  /* A project's client people with their role on it, decision makers first.
     A contact gone from the CRM stays listed, so its link can still be removed;
     `known` says whether there is still a CRM page to link to. */
  function projectPeople(project, linkRows, contacts) {
    if (!project) return Object.freeze([]);
    const list = contacts || [];
    return Object.freeze(linksOf(project, linkRows)
      .map(l => {
        const person = list.find(c => c && c.id === l.contact_id) || null;
        return Object.freeze({
          contactId: l.contact_id,
          role: l.role,
          roleLabel: roleLabel(l.role),
          name: person ? person.name : GONE_CONTACT,
          email: person ? (person.email || '') : '',
          known: Boolean(person)
        });
      })
      .sort((a, b) => roleIndex(a.role) - roleIndex(b.role) || a.name.localeCompare(b.name)));
  }

  /* Who can still be added, as [id, name]: the project company's contacts who
     are not on it yet. An internal project has no client people. */
  function peopleCandidates(project, linkRows, contacts) {
    if (!project || !project.companyId) return Object.freeze([]);
    const taken = new Set(linksOf(project, linkRows).map(l => l.contact_id));
    return Object.freeze((contacts || [])
      .filter(c => c && c.id && !taken.has(c.id) && c.row && c.row.company && c.row.company.id === project.companyId)
      .map(c => Object.freeze([String(c.id), String(c.name || '')])));
  }

  /* ── Files (0039) ──────────────────────────────────────────────────── */

  const KB = 1024;
  const MB = KB * KB;
  /* The project-files bucket's limit. */
  const FILE_LIMIT_BYTES = 50 * MB;

  /* A size a person reads: 512 B, 2 KB, 1.5 MB. */
  function fileSize(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n < KB) return `${n} B`;
    if (n < MB) return `${Math.round(n / KB)} KB`;
    return `${(n / MB).toFixed(1).replace(/\.0$/, '')} MB`;
  }

  /* Why a file cannot be stored, said before anything is uploaded — or null. */
  function fileProblem(file) {
    if (!file) return 'Pick a file first.';
    const name = String(file.name || 'That file');
    if (!(Number(file.size) > 0)) return `"${name}" is empty.`;
    if (Number(file.size) > FILE_LIMIT_BYTES) {
      return `"${name}" is larger than ${fileSize(FILE_LIMIT_BYTES)}, the most a project file can be.`;
    }
    return null;
  }

  const addedFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

  /* A project's files, newest first. */
  function projectFiles(project, fileRows) {
    if (!project) return Object.freeze([]);
    return Object.freeze((fileRows || [])
      .filter(f => f && f.project_id === project.id)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map(f => Object.freeze({
        id: f.id,
        name: f.name,
        path: f.storage_path,
        size: fileSize(f.size_bytes),
        type: f.content_type || '',
        uploadedBy: f.uploaded_by || null,
        added: f.created_at ? addedFormat.format(new Date(f.created_at)) : ''
      })));
  }

  /* ── Budget (0039) ─────────────────────────────────────────────────── */

  /* numeric(12,2) holds up to 9,999,999,999.99. */
  const BUDGET_LIMIT = 1e10;
  const CURRENCY = /^[A-Z]{3}$/;

  /* An amount the way people type one: 12500, 12,500, 12.500,50, 12 500.5,
     1'234'567. Thousands are grouped in threes by one separator — a comma, a
     point, a space or an apostrophe — and one or two decimals follow the other
     separator. Anything else is refused rather than guessed at: "1,2345" used
     to be read as 12,345 and "1.5.5" as 15.5. Empty is null; not an amount is
     NaN. */
  const AMOUNT = /^(\d+|\d{1,3}([ ,.])\d{3}(?:\2\d{3})*)(?:([.,])(\d{1,2}))?$/;

  function parseAmount(text) {
    const typed = String(text == null ? '' : text).trim().replace(/[  '’]/g, ' ');
    if (!typed) return null;
    const m = AMOUNT.exec(typed);
    if (!m || (m[2] && m[2] === m[3])) return NaN;
    return Number(`${m[1].replace(/[ ,.]/g, '')}.${m[4] || '0'}`);
  }

  function budgetOf(project, budgetRows) {
    if (!project) return null;
    const found = (budgetRows || []).find(b => b && b.project_id === project.id);
    return found ? Object.freeze({ amount: Number(found.amount), currency: String(found.currency || 'USD') }) : null;
  }

  /* What a budget form does to `current` (budgetOf): set a budget, change it,
     clear it, or leave it — with the amount and currency to write, or why it
     cannot. */
  function budgetChange(current, fields) {
    const f = fields || {};
    const refuse = problem => Object.freeze({ action: 'none', amount: null, currency: null, problem });
    const amount = parseAmount(f.amount);
    if (amount === null) {
      return Object.freeze({ action: current ? 'clear' : 'none', amount: null, currency: null, problem: null });
    }
    if (Number.isNaN(amount)) return refuse('That budget is not an amount.');
    if (amount >= BUDGET_LIMIT) return refuse('That budget is too large.');
    const currency = String(f.currency || '').trim().toUpperCase();
    if (!CURRENCY.test(currency)) return refuse('Pick a currency, like EUR or USD.');
    const rounded = Math.round(amount * 100) / 100;
    const unchanged = Boolean(current) && current.amount === rounded && current.currency === currency;
    return Object.freeze({
      action: unchanged ? 'none' : (current ? 'change' : 'set'),
      amount: rounded,
      currency,
      problem: null
    });
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
     with a parallel list of ids, due dates and ticked positions (checkedTasks
     in workspace.js, "my focus" in overview-model.js, a tick in
     data/writes.js). `project` is what queries.projects() returns; `tasks` is
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
      startsOn: row.starts_on || null,
      starts: shortDue(row.starts_on),
      completedAt: row.completed_at || null,
      status: project.status,
      description: project.description,
      tasks: mine.map(t => t.title),
      taskIds: mine.map(t => t.id),
      taskDue: mine.map(t => shortDue(t.row.due_date)),
      /* The date itself and who each task is for: "my focus" (overview-model.js). */
      taskDueOn: mine.map(t => t.row.due_date || null),
      taskAssignees: mine.map(t => t.row.assignee_id || null),
      checked: mine.reduce((ticked, t, i) => (t.done ? ticked.concat(i) : ticked), []),
      /* The tasks themselves, as queries.js shapes them, for the task list
         (tasks-ui.js) — which reads status, priority and details from them. */
      taskList: mine
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
    suggestedStart, meetingTimes,
    CONTACT_ROLES, FILE_LIMIT_BYTES,
    canManageProject, canOpenFiles, projectTeam, teamCandidates,
    roleLabel, projectPeople, peopleCandidates,
    fileSize, fileProblem, projectFiles,
    budgetOf, budgetChange
  });
})();
