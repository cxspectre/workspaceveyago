/* project-forms.js — starting a new project properly.
 *
 * "New project" was app.js's one-size quick-create dialog: a typed client
 * name that did not match an existing company word-for-word quietly created
 * a second one, the owner was always whoever clicked the button, there was
 * no start date or status to set, and once it saved you were left back on
 * the Projects list rather than on the project you had just made.
 *
 * This replaces it with a real dialog, on projects-model.js's own rules
 * (NAME_LIMIT, STATUS_LABELS, statusValue, projectChanges, choices) — and,
 * for the client company, the exact "does this look like one already in the
 * CRM? ask before adding a second one" pattern crm-forms.js already solved
 * for companies and contacts (duplicateCompanies, companyForm, from
 * crm-model.js) rather than a new one invented here. Only the small parts
 * particular to a company-shaped question — clearOf/why/REASONS/linkTo —
 * are copied rather than shared, the same way dialog-forms.js's own header
 * explains crm-forms.js and finance-ui.js each ended up with their own
 * before it existed: only the generic send/error/one-write-at-a-time parts
 * are common ground.
 *
 * A client company is offered from a select of the CRM's own companies
 * first, so the common case never risks a typo at all; "A new company…"
 * reveals a plain name field for the uncommon one, which still goes through
 * the same duplicate check.
 *
 * projects-ui.js draws the New project button (app.js's data-create); "New
 * project", wherever it is pressed, is app.js's createForm('projects'),
 * which this replaces, so this file loads after project-panels.js. Every
 * write goes through workspaceActions and reloads the store. Tested in
 * tests/project-forms.test.mjs.
 */
const projectForms = (function () {
  'use strict';

  const M = projectsModel;
  /* The company choice that means "not in the CRM yet". */
  const NEW_COMPANY = 'new';
  const CODE = /^[A-Z]{3}$/;
  const text = value => String(value == null ? '' : value);
  const trim = value => text(value).trim();
  const orNull = value => trim(value) || null;

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const meId = () => (window.workspaceSession && workspaceSession.employee ? workspaceSession.employee.id : null);
  const loadedCompanies = () => (window.workspaceStore && workspaceStore.state.companies) || [];
  const values = form => Object.fromEntries(new FormData(form).entries());
  /* Saying what is wrong, a clean form for each send, and one write at a
     time: as every dialog does them (dialog-forms.js). */
  const { field, say, quiet, sending, sentence, showing } = dialogForms;
  const dialogForm = (id, body, submitLabel) => dialogForms.form(id, body, submitLabel, { candidates: true });

  /* [value, label] tuples, as projects-ui.js and projects-model.js's own
     choices() already shape a picker's options — not dialog-forms.js's
     options(), which wants {value, label} objects. */
  const options = (list, current) => list.map(([value, label]) =>
    `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('');

  function ready() {
    if (live()) return true;
    toast('Not yet: the workspace is still loading.');
    return false;
  }

  /* A new company is in the studio's currency when the Overview knows it
     (0041) — crm-forms.js's own copy of the same small rule. */
  function studioCurrency() {
    const overview = (window.workspaceStore && workspaceStore.state.overview) || null;
    const code = overview ? trim(overview.revenue_currency).toUpperCase() : '';
    return CODE.test(code) ? code : 'USD';
  }

  const companyOptions = () => loadedCompanies().map(c => [c.id, c.name]).sort((a, b) => a[1].localeCompare(b[1]));

  /* ── Asking about a look-alike company ─────────────────────────────── */

  const REASONS = Object.freeze({ name: 'the same name', domain: 'the same domain', email: 'the same email address' });
  const why = found => found.reasons.map(reason => REASONS[reason] || reason).join(' and ');
  const linkTo = found => `<a href="#${esc(found.route)}">${esc(found.name)}</a>`;
  /* What each open dialog last asked, and the company it added for a project
     that was then refused (crm-forms.js's own addContact does the same for
     a refused contact, so a retry reuses the company rather than doubling
     it). */
  const asked = new WeakMap();
  const madeFor = new WeakMap();

  function clearOf(form, found, typed) {
    const box = form.querySelector('.form-candidates');
    const button = form.querySelector('[type="submit"]');
    const blocking = found.find(c => c.blocking);
    if (blocking) {
      box.innerHTML = `<p>${linkTo(blocking)} already has ${esc(why(blocking))}.</p>`;
      say(form, `${blocking.name} already has ${why(blocking)}: pick it from the list, or use a different name.`);
      return false;
    }
    const question = JSON.stringify([typed, found.map(c => c.id)]);
    if (!found.length || asked.get(form) === question) return true;
    asked.set(form, question);
    const anyway = `${button.dataset.label} anyway`;
    box.innerHTML = `<p>Already in the CRM:</p><ul>${found.map(c => `<li>${linkTo(c)}: ${esc(why(c))}</li>`).join('')}</ul>`
      + `<p>Press “${esc(anyway)}” to go ahead.</p>`;
    button.textContent = anyway;
    if (button.setAttribute) button.setAttribute('aria-describedby', box.id);
    if (button.focus) button.focus();
    return false;
  }

  /* The new company to add, when "A new company…" is chosen: what to add,
     or the company this dialog already added on a previous, refused try —
     renamed if the typed name was corrected since. Mirrors crm-forms.js's
     own newCompanyFor exactly, for a contact's company. */
  function newCompanyFor(form, v) {
    const typed = trim(v.company);
    if (!typed) return { problem: 'Give the new company a name, or pick one from the list.' };
    const made = madeFor.get(form);
    if (made) {
      const rename = typed !== made.name ? typed : '';
      const checked = rename ? crmModel.companyForm({ name: rename }) : null;
      return checked && checked.problem ? { problem: checked.problem } : { kept: { id: made.id, rename }, name: rename };
    }
    const built = crmModel.companyForm({ name: typed, kind: 'client', stage: 'client', currency: studioCurrency(), ownerId: meId() || '' });
    return built.problem ? { problem: built.problem } : { company: built.values, name: typed };
  }

  /* Where the project's company comes from: an existing one chosen directly
     (no ambiguity — an id, not a typed name), none, or a new one (above). */
  function companyPlan(form, v) {
    if (v.companyId !== NEW_COMPANY) return { companyId: v.companyId || null };
    return newCompanyFor(form, v);
  }

  /* The company first, when there is a new one, then the project at it —
     mirroring crm-forms.js's addContact: a company added here but then
     refused for the project is not made twice on a retry. */
  async function createProjectWork(base, plan, form) {
    let companyId = 'companyId' in plan ? plan.companyId : (plan.kept ? plan.kept.id : null);
    if (plan.kept && plan.kept.rename) {
      try {
        await workspaceActions.updateCompany(plan.kept.id, { name: plan.kept.rename });
      } catch (err) {
        /* Refused — gone from the CRM, or not this person's to change — it
           is nobody's to keep. */
        if (err && err.refused) madeFor.delete(form);
        throw err;
      }
      madeFor.set(form, { id: plan.kept.id, name: plan.kept.rename });
    }
    if (plan.company) {
      const row = await workspaceActions.createCompany(plan.company);
      madeFor.set(form, { id: row.id, name: plan.company.name });
      companyId = row.id;
    }
    try {
      return await workspaceActions.createProject({ ...base, companyId, accent: companyId ? 'client' : 'default' });
    } catch (err) {
      const made = madeFor.get(form);
      if (!made || made.id !== companyId) throw err;
      const where = showing(form) ? `${made.name} stays chosen.` : `${made.name} is in the CRM: pick it when you try again.`;
      throw new Error(`${made.name} was added, but the project was not: ${sentence(err.message)} ${where}`);
    }
  }

  /* ── The dialog ─────────────────────────────────────────────────────── */

  function openNew() {
    const owner = meId();
    showModal('PROJECT · NEW', '<h2>New project</h2>' + dialogForm('project-new-form',
      field('Name', `<input name="name" required maxlength="${M.NAME_LIMIT}" placeholder="Website relaunch">`)
      + field('Client company', `<select name="companyId" data-project-company-choice>${options([['', 'No company (internal)'], ...companyOptions(), [NEW_COMPANY, 'A new company…']], '')}</select>`)
      + field('The new company’s name', '<input name="company" maxlength="200">', ' data-project-company-name hidden')
      + field('Owner', `<select name="ownerId"><option value="">No owner</option>${options(M.choices(team, owner, 'You'), owner || '')}</select>`)
      + '<div class="form-row form-row-two">'
      + field('Start date', '<input type="date" name="startsOn">')
      + field('Due date', '<input type="date" name="dueOn">')
      + '</div>'
      + field('Status', `<select name="status">${options(M.STATUS_LABELS.map(s => [s, s]), 'Discovery')}</select>`)
      + field('Description', '<textarea name="description" placeholder="A little more context…"></textarea>'),
      'Create project'));
    const form = document.getElementById('project-new-form');
    const choice = form.querySelector('[data-project-company-choice]');
    const named = form.querySelector('[data-project-company-name]');
    if (choice && named) choice.addEventListener('change', () => { named.hidden = choice.value !== NEW_COMPANY; });
    form.addEventListener('submit', e => {
      e.preventDefault();
      submitNewProject(form);
    });
  }

  /* projectsModel.projectChanges(null, fields) validates a new project's
     name length and its dates exactly as it would an edit's (its `was` is
     `{}` for a project of `null`) — reused rather than re-written, per the
     project's own house style. The one thing it cannot catch this way is a
     blank name: its "renamed" check compares against `was.name` (also
     blank), so a name that is blank both before and after reads as
     unchanged and never trips the required check. Judged here instead,
     first, the way the model's own comment says a rename is judged only
     when it changed. */
  function submitNewProject(form) {
    const v = values(form);
    quiet(form);
    const name = trim(v.name);
    if (!name) { say(form, 'A project needs a name.', 'name'); return; }
    if (name.length > M.NAME_LIMIT) { say(form, `A project name is at most ${M.NAME_LIMIT} characters long.`, 'name'); return; }
    const validated = M.projectChanges(null, { name: v.name, description: v.description, startsOn: v.startsOn, dueOn: v.dueOn });
    if (validated.problem) { say(form, validated.problem); return; }
    const plan = companyPlan(form, v);
    if (plan.problem) { say(form, plan.problem, 'company'); return; }
    const found = plan.name ? crmModel.duplicateCompanies(loadedCompanies(), { name: plan.name }, plan.kept ? plan.kept.id : undefined) : [];
    if (!clearOf(form, found, [plan.name, v.companyId])) return;
    const base = {
      name,
      description: orNull(v.description),
      ownerId: v.ownerId || null,
      startsOn: orNull(v.startsOn),
      dueOn: orNull(v.dueOn),
      status: M.statusValue(v.status) || 'discovery',
      code: name.charAt(0).toUpperCase()
    };
    sending(form, () => createProjectWork(base, plan, form), created => {
      toast(`${name} is on the board.`);
      if (typeof navigate === 'function') navigate('projects/' + created.id);
    });
  }

  /* "New project", wherever it is pressed, is this dialog: app.js's form
     asked for a "client or internal product" as free text, which is how a
     mistyped client became a second CRM company. */
  if (typeof createForm === 'function') {
    const before = createForm;
    createForm = function (kind) {
      if (kind !== 'projects') return before(kind);
      if (ready()) openNew();
      return undefined;
    };
  }

  return Object.freeze({ openNew });
})();
