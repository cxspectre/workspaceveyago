/* project-panels.js — the parts of a project page that 0039 made possible: its
 * team, its client's people, its files and, for owners and admins, its budget.
 *
 * projectDetail() in workspace.js draws the page and asks this file for them
 * (teamPanel, peoplePanel, filesPanel, budgetRows). Who may do what is decided
 * in projects-model.js the way the database decides it, so a button is only
 * offered to someone the database would let through. The database still has
 * the last word, and every write reloads the store.
 */
const projectPanels = (function () {
  'use strict';

  const M = projectsModel;
  const ROLE_OPTIONS = Object.freeze(M.CONTACT_ROLES.map(r => [r.value, r.label]));

  const state = () => (window.workspaceStore ? workspaceStore.state : {});
  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const isManager = () => Boolean(window.workspaceSession && workspaceSession.isManager && workspaceSession.isManager());
  const meId = () => (window.workspaceSession && workspaceSession.employee ? workspaceSession.employee.id : null);
  const projectFor = id => M.projectById(projects, String(id || ''));
  const personNamed = id => team.find(m => m.id === id);
  const options = (list, current) => list.map(([value, label]) =>
    `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('');

  function money(amount, currency) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
    } catch (unknownCurrency) {
      return `${amount} ${currency}`;
    }
  }

  /* Writes on their way, by what they are about: a second click on the same
     thing waits for the first. A write that fails is said by the store's
     after(), and the page is drawn again from what is loaded, so a select that
     was changed shows what the database still holds. */
  const saving = new Set();
  function save(key, work, done) {
    if (saving.has(key)) {
      toast('Still saving the last change — a moment.');
      return Promise.resolve();
    }
    saving.add(key);
    return workspaceStore.after(Promise.resolve().then(work))
      .then(result => { if (done) done(result); })
      .catch(() => { if (typeof render === 'function') render(); })
      .then(() => { saving.delete(key); });
  }

  /* ── Team ──────────────────────────────────────────────────────────── */

  function teamPanel(p) {
    const s = state();
    const me = meId();
    const manages = M.canManageProject(p, me, isManager());
    const people = M.projectTeam(p, s.projectMembers, team);
    const candidates = manages ? M.teamCandidates(p, s.projectMembers, team) : [];
    const row = person => {
      const offerRemove = !person.owner && (manages || person.employeeId === me);
      const self = person.employeeId === me;
      /* A screen reader hears whom a button is about, not "Remove, Remove". */
      const name = self ? `Leave ${p.name}` : `Take ${person.name} off the team`;
      return '<li class="team-person">'
        + `<span class="avatar sm${person.owner ? ' owner' : ''}">${esc(person.initial)}</span>`
        + `<span class="team-name">${esc(person.name)}${person.owner ? '<small>Owner</small>' : ''}</span>`
        + (offerRemove
          ? `<button type="button" class="text-btn" data-team-remove="${esc(p.id)}" data-employee="${esc(person.employeeId)}" aria-label="${esc(name)}">${self ? 'Leave' : 'Remove'}</button>`
          : '')
        + '</li>';
    };
    return '<section class="panel content-panel project-team"><h2>Team</h2>'
      + (people.length ? `<ul class="plain-list">${people.map(row).join('')}</ul>` : '<p class="quiet-text">No owner or members yet.</p>')
      + (candidates.length
        ? `<form class="inline-add" method="dialog" data-team-form="${esc(p.id)}">`
          + `<select name="employeeId" aria-label="Add someone to the team">${options(candidates, '')}</select>`
          + '<button type="submit" class="btn">Add</button></form>'
        : '')
      + '<p class="quiet-text">The team and its owner can open the project\'s files.</p>'
      + '</section>';
  }

  function takeOffTeam(p, employeeId) {
    const person = personNamed(employeeId);
    const self = employeeId === meId();
    save(`team:${p.uuid}`, () => workspaceActions.removeProjectMember(p.uuid, employeeId),
      () => toast(self ? `You left ${p.name}.` : `${person ? person.name : 'They'} left ${p.name}'s team.`));
  }

  /* ── The client's people ───────────────────────────────────────────── */

  function peoplePanel(p) {
    const s = state();
    const people = M.projectPeople(p, s.projectContacts, contacts);
    const candidates = M.peopleCandidates(p, s.projectContacts, contacts);
    const row = person => '<li class="client-person">'
      + '<div class="client-person-name">'
      + (person.known ? `<a href="#crm/${esc(person.contactId)}">${esc(person.name)}</a>` : esc(person.name))
      + (person.email ? `<small>${esc(person.email)}</small>` : '')
      + '</div>'
      + `<select aria-label="Role of ${esc(person.name)}" data-people-role="${esc(p.id)}" data-contact="${esc(person.contactId)}">${options(ROLE_OPTIONS, person.role)}</select>`
      + `<button type="button" class="text-btn" data-people-remove="${esc(p.id)}" data-contact="${esc(person.contactId)}" aria-label="Take ${esc(person.name)} off the project">Remove</button>`
      + '</li>';
    const body = !p.companyId
      ? '<p class="quiet-text">Link the project to a client company to add its people.</p>'
      : (people.length ? `<ul class="plain-list">${people.map(row).join('')}</ul>` : '<p class="quiet-text">Nobody from the client yet.</p>')
        + (candidates.length
          ? `<form class="inline-add" method="dialog" data-people-form="${esc(p.id)}">`
            + `<select name="contactId" aria-label="Contact to add">${options(candidates, '')}</select>`
            + `<select name="role" aria-label="Their role on the project">${options(ROLE_OPTIONS, 'day_to_day')}</select>`
            + '<button type="submit" class="btn">Add</button></form>'
          : '');
    return `<section class="panel content-panel project-people"><h2>Client people</h2>${body}</section>`;
  }

  function takeOffProject(p, contactId) {
    const person = contacts.find(c => c.id === contactId);
    save(`people:${p.uuid}`, () => workspaceActions.removeProjectContact(p.uuid, contactId),
      () => toast(`${person ? person.name : 'The contact'} is off ${p.name}.`));
  }

  /* Each person's role saves on its own, and the latest choice wins. Every
     role on a project used to share one save, so a second change made while
     the first was saving was dropped. */
  const nextRole = new Map();
  function saveRole(p, contactId, role) {
    const key = `role:${p.uuid}:${contactId}`;
    if (saving.has(key)) {
      nextRole.set(key, role);
      return Promise.resolve();
    }
    return save(key, () => workspaceActions.setProjectContactRole(p.uuid, contactId, role), () => toast('Role saved.'))
      .then(() => {
        if (!nextRole.has(key)) return undefined;
        const latest = nextRole.get(key);
        nextRole.delete(key);
        return latest === role ? undefined : saveRole(p, contactId, latest);
      });
  }

  /* ── Files ─────────────────────────────────────────────────────────── */

  function filesPanel(p) {
    const s = state();
    const me = meId();
    const manages = M.canManageProject(p, me, isManager());
    if (!M.canOpenFiles(p, s.projectMembers, me, isManager())) {
      const owner = M.projectTeam(p, [], team).find(person => person.owner);
      return '<section class="panel content-panel project-files"><h2>Files</h2>'
        + `<p class="quiet-text">Files on this project are for its team. ${owner ? `${esc(owner.name)}, its owner,` : 'An owner or admin'} can add you.</p>`
        + '</section>';
    }
    const files = M.projectFiles(p, s.projectFiles);
    const uploader = id => { const person = personNamed(id); return person ? person.name : 'a former team member'; };
    const row = f => '<li class="file-row">'
      + `<span class="related-icon">${icon('projects')}</span>`
      + `<div class="file-name"><strong>${esc(f.name)}</strong><small>${esc(f.size)} · ${esc(f.added)} · ${esc(uploader(f.uploadedBy))}</small></div>`
      + `<button type="button" class="text-btn" data-file-open="${esc(f.id)}" data-project="${esc(p.id)}" aria-label="Download ${esc(f.name)}">Download</button>`
      + (manages || (me && f.uploadedBy === me)
        ? `<button type="button" class="text-btn" data-file-remove="${esc(f.id)}" data-project="${esc(p.id)}" aria-label="Remove ${esc(f.name)}">Remove</button>`
        : '')
      + '</li>';
    /* "Add files" is a button, which takes focus and Enter, and opens the
       hidden file input. A label round a hidden input could only be clicked. */
    return '<section class="panel content-panel project-files">'
      + `<div class="section-title"><h2>Files</h2><span class="quiet-text">${files.length} ${files.length === 1 ? 'file' : 'files'}</span></div>`
      + `<button type="button" class="btn file-pick" data-files-pick="${esc(p.id)}">${icon('plus')}Add files</button>`
      + `<input type="file" multiple hidden data-files-input="${esc(p.id)}">`
      + `<p class="quiet-text">Up to ${M.fileSize(M.FILE_LIMIT_BYTES)} each. Only the project's team, its owner and owners or admins can open them.</p>`
      + (files.length ? `<ul class="plain-list">${files.map(row).join('')}</ul>` : '<p class="quiet-text">No files yet.</p>')
      + '</section>';
  }

  /* One after another, so a failure is about one file; the page reloads once
     at the end, with whatever made it. */
  function upload(input) {
    const p = projectFor(input.dataset.filesInput);
    const files = [...(input.files || [])];
    input.value = '';
    if (!p || !files.length) return;
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    const problem = files.map(M.fileProblem).find(Boolean);
    if (problem) { toast(problem); return; }
    /* Files picked while an upload ran used to be dropped; the button now
       waits for it. */
    const pick = [...document.querySelectorAll('[data-files-pick]')].find(b => b.dataset.filesPick === input.dataset.filesInput);
    if (pick) { pick.disabled = true; pick.setAttribute('aria-busy', 'true'); }
    save(`files:${p.uuid}`, async () => {
      const failed = [];
      for (const [i, file] of files.entries()) {
        toast(`Uploading ${files.length > 1 ? `${i + 1} of ${files.length}: ` : ''}${file.name}…`);
        try {
          await workspaceActions.uploadProjectFile(p.uuid, file);
        } catch (err) {
          failed.push(err.message);
        }
      }
      return { added: files.length - failed.length, failed };
    }, ({ added, failed }) => toast(failed.length
      ? `${added} of ${files.length} added. ${failed[0]}`
      : (added === 1 ? `${files[0].name} is on the project.` : `${added} files are on the project.`)))
      .then(() => { if (pick && pick.isConnected) { pick.disabled = false; pick.removeAttribute('aria-busy'); } });
  }

  function download(file, button) {
    button.disabled = true;
    workspaceActions.projectFileLink(file.path, file.name)
      .then(url => {
        const link = document.createElement('a');
        link.href = url;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
      })
      .catch(err => toast(err.message))
      .then(() => { button.disabled = false; });
  }

  function confirmRemoveFile(p, file) {
    showModal('PROJECT · FILE', `<h2>Remove ${esc(file.name)}?</h2>`
      + '<p class="form-note">It is deleted from storage for everyone on the project, and cannot be brought back.</p>'
      + '<form id="project-file-remove-form" method="dialog"><div class="dialog-actions">'
      + '<button type="button" class="btn" data-action="close">Cancel</button>'
      + '<button type="submit" class="btn btn-primary">Remove file</button></div></form>');
    const form = document.getElementById('project-file-remove-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      save(`file:${file.id}`, () => workspaceActions.removeProjectFile(file).then(result => {
        const modal = document.getElementById('modal');
        if (form.isConnected && modal && modal.open) modal.close();
        return result;
      }), () => toast(`${file.name} is removed.`))
        .then(() => { button.disabled = false; });
    });
  }

  /* ── Budget ────────────────────────────────────────────────────────── */

  function budgetRows(p) {
    if (!isManager()) return [];
    const budget = M.budgetOf(p, state().projectBudgets);
    return [['Budget', budget ? esc(money(budget.amount, budget.currency)) : '<span class="quiet-text">Not set</span>']];
  }

  /* ── Events ────────────────────────────────────────────────────────── */

  function withProject(id) {
    if (!live()) { toast('Not yet: the workspace is still loading.'); return null; }
    const p = projectFor(id);
    if (!p) toast('That project is not loaded any more. Reload the page.');
    return p;
  }

  document.addEventListener('submit', e => {
    const form = e.target;
    if (!form.matches || !form.matches('[data-team-form], [data-people-form]')) return;
    e.preventDefault();
    const p = withProject(form.dataset.teamForm || form.dataset.peopleForm);
    if (!p) return;
    const values = Object.fromEntries(new FormData(form));
    if (form.dataset.teamForm) {
      const person = personNamed(values.employeeId);
      save(`team:${p.uuid}`, () => workspaceActions.addProjectMember(p.uuid, values.employeeId),
        () => toast(`${person ? person.name : 'They'} joined ${p.name}'s team.`));
      return;
    }
    const person = contacts.find(c => c.id === values.contactId);
    save(`people:${p.uuid}`, () => workspaceActions.addProjectContact(p.uuid, values.contactId, values.role),
      () => toast(`${person ? person.name : 'The contact'} is on ${p.name}: ${M.roleLabel(values.role).toLowerCase()}.`));
  });

  document.addEventListener('change', e => {
    const role = e.target.closest && e.target.closest('[data-people-role]');
    if (role) {
      const p = withProject(role.dataset.peopleRole);
      if (p) saveRole(p, role.dataset.contact, role.value);
      return;
    }
    const input = e.target.closest && e.target.closest('[data-files-input]');
    if (input) upload(input);
  });

  document.addEventListener('click', e => {
    const pick = e.target.closest && e.target.closest('[data-files-pick]');
    if (pick) {
      const input = [...document.querySelectorAll('[data-files-input]')].find(i => i.dataset.filesInput === pick.dataset.filesPick);
      if (input) input.click();
      return;
    }
    const target = e.target.closest
      && e.target.closest('[data-team-remove], [data-people-remove], [data-file-open], [data-file-remove]');
    if (!target) return;
    e.preventDefault();
    const d = target.dataset;
    const p = withProject(d.teamRemove || d.peopleRemove || d.project);
    if (!p) return;
    if (d.teamRemove) { takeOffTeam(p, d.employee); return; }
    if (d.peopleRemove) { takeOffProject(p, d.contact); return; }
    const file = M.projectFiles(p, state().projectFiles).find(f => f.id === (d.fileOpen || d.fileRemove));
    if (!file) { toast('That file is not loaded any more. Reload the page.'); return; }
    if (d.fileOpen) download(file, target);
    else confirmRemoveFile(p, file);
  });

  return Object.freeze({ teamPanel, peoplePanel, filesPanel, budgetRows });
})();
