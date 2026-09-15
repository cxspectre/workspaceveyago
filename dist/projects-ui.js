/* projects-ui.js — what a project page can do: edit the project, open a ticket
 * for it, book a meeting for it, archive it.
 *
 * The page is drawn by projectDetail() in workspace.js; this file adds the
 * buttons it shows (projectsUi.actions) and the dialogs behind them. Every write
 * goes through workspaceActions and then reloads the store, so what the page
 * shows afterwards is what the database accepted.
 *
 * What an edit changes, which tickets and meetings are a project's, what a
 * picker offers and when a meeting can be booked are decided in
 * projects-model.js and tested in tests/projects.test.mjs. The dialogs
 * themselves are checked in the browser.
 */
const projectsUi = (function () {
  'use strict';

  const M = projectsModel;
  const PRIORITIES = Object.freeze([['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']]);
  const TEXT_LIMIT = 200;
  const MEETING_MINUTES = 30;
  /* Offered for a budget; one already set in another currency is kept too. */
  const CURRENCIES = Object.freeze(['USD', 'EUR', 'GBP', 'CHF']);
  const ACTIONS = Object.freeze({
    projectEdit: 'edit', projectTicket: 'ticket', projectMeeting: 'meeting', projectArchive: 'archive'
  });

  /* Saves on their way, by action and project. A dialog closes as soon as its
     write lands, but someone who closes it sooner and sends it again must not
     open a second ticket or book a second meeting. */
  const saving = new Set();
  const saveKey = (action, p) => `${action}:${p.uuid}`;

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const isManager = () => Boolean(window.workspaceSession && workspaceSession.isManager && workspaceSession.isManager());
  const meId = () => (window.workspaceSession && workspaceSession.employee ? workspaceSession.employee.id : null);
  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeKey = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  function closeModal() {
    const modal = document.getElementById('modal');
    if (modal && modal.open) modal.close();
  }

  const options = (list, current) => list.map(([value, label]) =>
    `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const field = (label, control) => `<label class="form-field">${label}${control}</label>`;
  /* method="dialog": were the handler below ever not to run, sending the form
     would only close the dialog. The default, GET, puts what was typed in the URL. */
  const dialogForm = (id, body, submitLabel) => `<form id="${id}" method="dialog">${body}`
    + '<div class="dialog-actions"><button type="button" class="btn" data-action="close">Cancel</button>'
    + `<button type="submit" class="btn btn-primary">${submitLabel}</button></div></form>`;

  function actions(p) {
    return '<span class="project-actions">'
      + `<button type="button" class="btn" data-project-edit="${esc(p.id)}">Edit</button>`
      + `<button type="button" class="btn" data-project-ticket="${esc(p.id)}">${icon('tickets')}New ticket</button>`
      + `<button type="button" class="btn" data-project-meeting="${esc(p.id)}">${icon('agenda')}Schedule meeting</button>`
      + (isManager() ? `<button type="button" class="btn" data-project-archive="${esc(p.id)}">Archive</button>` : '')
      + '</span>';
  }

  /* One save at a time per action and project. The dialog closes once the
     database has the change; `done` runs when the reload after it has finished.
     If the write fails, the store's after() says why and the form can be sent
     again. */
  function submitting(form, key, makeWork, done) {
    if (saving.has(key)) return;
    saving.add(key);
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    const work = Promise.resolve().then(makeWork);
    /* Only this dialog: another may have been opened while this one saved. */
    work.then(() => { if (form.isConnected) closeModal(); }, () => {})
      .then(() => saving.delete(key));
    workspaceStore.after(work)
      .then(result => { if (done) done(result); })
      .catch(() => { if (button) button.disabled = false; });
  }

  /* ── Edit ──────────────────────────────────────────────────────────── */

  function openEdit(p) {
    const companies = M.choices(workspaceStore.state.companies, p.companyId, 'Current company (not in the list)');
    const owners = M.choices(team, p.ownerId, 'Current owner (no longer on the team)');
    /* Handing a project over is for owners and admins and the project's own
       owner (guard_project_owner, 0039). A disabled select is not sent, so for
       anyone else the owner stays as it is. */
    const handsOver = M.canManageProject(p, meId(), isManager());
    const s = workspaceStore.state;
    const clientPeople = M.projectPeople(p, s.projectContacts, contacts).length;
    /* The budget is for owners and admins (0039): nobody else is shown it. */
    const budget = isManager() ? M.budgetOf(p, s.projectBudgets) : null;
    const currencies = M.choices(CURRENCIES.map(code => ({ id: code, name: code })), budget && budget.currency, budget && budget.currency);
    showModal('PROJECT · EDIT', `<h2>Edit ${esc(p.name)}</h2>` + dialogForm('project-edit-form',
      field('Name', `<input name="name" required maxlength="${M.NAME_LIMIT}" value="${esc(p.name)}">`)
      + field('Client company', `<select name="companyId">${options([['', 'No company (internal)'], ...companies], p.companyId || '')}</select>`
        + (clientPeople
          ? `<small class="form-note">Changing the company takes ${clientPeople === 1 ? 'its person' : `its ${clientPeople} people`} off this project.</small>`
          : ''))
      + field('Owner', `<select name="ownerId"${handsOver ? '' : ' disabled'}>${options([['', 'No owner'], ...owners], p.ownerId || '')}</select>`
        + (handsOver ? '' : '<small class="form-note">Only an owner or admin, or the project\'s owner, can hand it over.</small>'))
      + '<div class="form-row form-row-two">'
      + field('Start date', `<input type="date" name="startsOn" value="${esc(p.startsOn || '')}">`)
      + field('Due date', `<input type="date" name="dueOn" value="${esc(p.dueOn || '')}">`)
      + '</div>'
      + (isManager()
        ? '<div class="form-row form-row-two">'
          + field('Budget', `<input name="budget" inputmode="decimal" autocomplete="off" placeholder="Not set" value="${budget ? esc(String(budget.amount)) : ''}">`)
          + field('Currency', `<select name="currency">${options(currencies, budget ? budget.currency : CURRENCIES[0])}</select>`)
          + '</div>'
        : '')
      + field('Description', `<textarea name="description">${esc(p.description || '')}</textarea>`),
      'Save project'));
    const form = document.getElementById('project-edit-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const { changes, problem } = M.projectChanges(p, values);
      if (problem) { toast(problem); return; }
      const budgetEdit = isManager()
        ? M.budgetChange(budget, { amount: values.budget, currency: values.currency })
        : { action: 'none', problem: null };
      if (budgetEdit.problem) { toast(budgetEdit.problem); return; }
      const edited = Object.keys(changes).length > 0;
      if (!edited && budgetEdit.action === 'none') { closeModal(); return; }
      submitting(form, saveKey('edit', p), async () => {
        if (edited) await workspaceActions.updateProject(p.uuid, changes);
        if (budgetEdit.action !== 'none') await workspaceActions.setProjectBudget(p.uuid, budgetEdit);
      }, () => toast('Project saved.'));
    });
  }

  /* ── New ticket ────────────────────────────────────────────────────── */

  function openTicket(p) {
    const people = contacts.filter(c => p.companyId && c.row && c.row.company && c.row.company.id === p.companyId);
    showModal('PROJECT · NEW TICKET', `<h2>New ticket for ${esc(p.name)}</h2>` + dialogForm('project-ticket-form',
      field('Subject', `<input name="subject" required maxlength="${TEXT_LIMIT}" placeholder="What needs doing?">`)
      + field('Priority', `<select name="priority">${options(PRIORITIES, 'normal')}</select>`)
      + (people.length
        ? field('Contact', `<select name="contactId">${options([['', 'No contact'], ...people.map(c => [c.id, c.name])], '')}</select>`)
        : '')
      + field('Details', '<textarea name="details" placeholder="What happened, and what is needed…"></textarea>'),
      'Open ticket'));
    const form = document.getElementById('project-ticket-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const subject = String(values.subject || '').trim();
      if (!subject) { toast('A ticket needs a subject.'); return; }
      submitting(form, saveKey('ticket', p), () => workspaceActions.createTicket({
        subject,
        priority: values.priority || 'normal',
        source: 'manual',
        product: p.name,
        projectId: p.uuid,
        companyId: p.companyId,
        contactId: values.contactId || null
      }).then(ticket => withDetails(ticket, String(values.details || '').trim())),
      ({ ticket, problem }) => {
        const name = ticket && ticket.number ? `VYG-${ticket.number}` : 'The ticket';
        toast(problem ? `${name} is open, but its details were not saved: ${problem}` : `${name} is open.`);
      });
    });
  }

  /* The details open the ticket's thread as an internal note. The ticket exists
     by then, so a note that fails is reported rather than retried: sending the
     form again would open a second ticket. */
  function withDetails(ticket, details) {
    if (!details) return { ticket, problem: null };
    return workspaceActions.replyToTicket(ticket.id, details, 'note')
      .then(() => ({ ticket, problem: null }), err => ({ ticket, problem: err.message }));
  }

  /* ── Meeting ───────────────────────────────────────────────────────── */

  function openMeeting(p) {
    const start = M.suggestedStart(new Date());
    const end = new Date(start.getTime() + MEETING_MINUTES * 60000);
    showModal('PROJECT · MEETING', '<h2>Schedule a meeting</h2>'
      + `<p class="form-note">For ${esc(p.name)}. It is booked in your Outlook calendar when one is connected, and saved here when not.</p>`
      + dialogForm('project-meeting-form',
        field('Title', `<input name="title" required maxlength="${TEXT_LIMIT}" value="${esc(`${p.name} · meeting`)}">`)
        + '<div class="form-row">'
        + field('Day', `<input type="date" name="day" required value="${dayKey(start)}">`)
        + field('Starts', `<input type="time" name="start" required value="${timeKey(start)}">`)
        + field('Ends', `<input type="time" name="end" required value="${timeKey(end)}">`)
        + '</div>'
        + field('Where', `<input name="location" maxlength="${TEXT_LIMIT}" placeholder="Office, video link, address…">`)
        + field('Notes', '<textarea name="detail"></textarea>'),
        'Schedule meeting'));
    const form = document.getElementById('project-meeting-form');
    /* A refused time blocks the form until it is cleared, so any edit clears it. */
    form.addEventListener('input', () => form.querySelectorAll('input').forEach(input => input.setCustomValidity('')));
    form.addEventListener('submit', e => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const { startsAt, endsAt, problem, field: culprit } = M.meetingTimes(values, new Date());
      if (problem) {
        form.elements[culprit].setCustomValidity(problem);
        form.elements[culprit].reportValidity();
        return;
      }
      submitting(form, saveKey('meeting', p), () => workspaceActions.createEvent({
        title: String(values.title || '').trim() || `${p.name} · meeting`,
        startsAt,
        endsAt,
        location: String(values.location || '').trim() || null,
        detail: String(values.detail || '').trim() || null,
        kind: p.companyId ? 'client' : 'internal',
        projectId: p.uuid,
        companyId: p.companyId
      }), result => toast(result && result.calendar
        ? `Added to ${result.calendar}.`
        : (result && result.why) || 'Saved here — no calendar is connected yet.'));
    });
  }

  /* ── Archive ───────────────────────────────────────────────────────── */

  function openArchive(p) {
    if (!isManager()) return;
    showModal('PROJECT · ARCHIVE', `<h2>Archive ${esc(p.name)}?</h2>`
      + '<p class="form-note">It leaves the board and every list. Nothing is deleted: its tasks, tickets, meetings and notes are kept, and it can be brought back from the Archived view.</p>'
      + dialogForm('project-archive-form', '', 'Archive project'));
    const form = document.getElementById('project-archive-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      submitting(form, saveKey('archive', p), () => workspaceActions.archiveProject(p.uuid), () => {
        navigate('projects');
        toast(`${p.name} is archived.`);
      });
    });
  }

  const OPEN = Object.freeze({ edit: openEdit, ticket: openTicket, meeting: openMeeting, archive: openArchive });

  /* ── Archived projects ─────────────────────────────────────────────── */
  /* Archiving worked; nothing could see an archived project again, or bring
     one back — the audit's own words for this were "can't be seen or
     brought back". workspaceStore.archivedProjects() is where they are now
     (workspace.js's Archived view draws the list; this is its Restore
     button and the dialog behind it). Looked up there rather than in
     `projects`, which never holds one. */
  function archivedById(id) {
    const store = window.workspaceStore;
    const entry = store && typeof store.archivedProjects === 'function' ? store.archivedProjects() : { projects: [] };
    return (entry.projects || []).find(p => p.id === id) || null;
  }

  function restoreButton(p) {
    return isManager()
      ? `<button type="button" class="btn" data-project-restore="${esc(p.id)}">Restore</button>`
      : '';
  }

  function openRestore(p) {
    if (!isManager()) return;
    showModal('PROJECT · RESTORE', `<h2>Restore ${esc(p.name)}?</h2>`
      + '<p class="form-note">It goes back onto the board, at the status it had when it was archived.</p>'
      + dialogForm('project-restore-form', '', 'Restore project'));
    const form = document.getElementById('project-restore-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      submitting(form, saveKey('restore', p), () => workspaceActions.restoreProject(p.id), () => {
        navigate('projects/' + p.id);
        toast(`${p.name} is restored.`);
      });
    });
  }

  document.addEventListener('click', e => {
    const restore = e.target.closest && e.target.closest('[data-project-restore]');
    if (restore) {
      e.preventDefault();
      if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
      const p = archivedById(restore.dataset.projectRestore);
      if (!p) { toast('That project is not in the archive any more. Reload the page.'); return; }
      if (saving.has(saveKey('restore', p))) { toast('Still saving the last one — a moment.'); return; }
      openRestore(p);
      return;
    }

    const target = e.target.closest
      && e.target.closest('[data-project-edit], [data-project-ticket], [data-project-meeting], [data-project-archive]');
    if (!target) return;
    e.preventDefault();
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    const [attribute, action] = Object.entries(ACTIONS).find(([key]) => target.dataset[key]);
    const p = M.projectById(projects, target.dataset[attribute]);
    if (!p) { toast('That project is not loaded any more. Reload the page.'); return; }
    if (saving.has(saveKey(action, p))) { toast('Still saving the last one — a moment.'); return; }
    OPEN[action](p);
  });

  return Object.freeze({ actions, restoreButton });
})();
