/* crm-forms.js — adding and changing the CRM's companies and contacts.
 *
 * As crm-model.js decides it (contactForm, contactChanges, companyForm,
 * companyChanges, duplicateContacts, duplicateCompanies), following the
 * database: staff add and change companies and contacts (0021); a company
 * needs a name, and a contact a name and nothing else. What the database
 * would refuse — an address or a domain another record already has (0021's
 * unique indexes), a kind or stage it does not have, a currency that is not a
 * code (0049), a public mailbox as a company's domain — is refused here first,
 * naming the record it clashes with. A record that only looks the same, by
 * name, is listed, and the save goes on once the person presses "… anyway".
 *
 * An edit saves what the person changed in the dialog, and nothing else: a
 * change someone else made while it was open is not undone, and a field
 * nobody touched is not judged by rules it was stored before.
 *
 * The CRM had no way to change a company or a contact: its selects only
 * changed the screen. "Add contact" demanded a company and an address, which
 * the database does not need, matched a typed company by name without a word,
 * and a contact that failed left a spare company behind that the next try
 * doubled.
 *
 * crm-ui.js draws the buttons (data-crm-new-company, data-crm-edit-company,
 * data-crm-new-contact, data-crm-edit-contact). "Add contact", wherever it is
 * pressed, is app.js's createForm('crm'), which this replaces, so this file
 * loads after app.js. Every write goes through workspaceActions and reloads
 * the store. Tested in tests/crm-forms.test.mjs.
 */
const crmForms = (function () {
  'use strict';

  const C = crmModel;
  /* The company choice that means one not in the CRM yet. */
  const NEW_COMPANY = 'new';
  const CODE = /^[A-Z]{3}$/;
  const text = value => String(value == null ? '' : value);

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const has = part => Boolean(window.workspaceStore && workspaceStore.has(part));
  const stored = () => (window.workspaceStore && workspaceStore.state) || {};
  const loadedCompanies = () => stored().companies || [];
  const signedIn = () => (window.workspaceSession && workspaceSession.employee) || null;
  const values = form => Object.fromEntries(new FormData(form).entries());

  /* What each open dialog was drawn with, the question it last asked, and the
     company it added for a contact that was then refused. */
  const drawn = new WeakMap();
  const asked = new WeakMap();
  const madeFor = new WeakMap();
  /* Saying what is wrong, a clean form for each send, and one write at a time:
     as every dialog does them (dialog-forms.js). */
  const { sentence, field, options, say, quiet, closeDialog, sending } = dialogForms;

  /* The fields the person changed since the dialog opened. */
  const edited = form => {
    const before = drawn.get(form) || {};
    return Object.fromEntries(Object.entries(values(form)).filter(([name, value]) => value !== before[name]));
  };

  /* A new company is in the studio's currency when the Overview knows it (0041). */
  const studioCurrency = () => {
    const overview = stored().overview;
    const code = overview ? text(overview.revenue_currency).trim().toUpperCase() : '';
    return CODE.test(code) ? code : 'USD';
  };

  /* The workspace only opens once companies have arrived (store.js, CORE), so
     there is always something to check a name against by then. */
  function ready() {
    if (live()) return true;
    toast('Not yet: the workspace is still loading.');
    return false;
  }

  /* ── The dialogs ───────────────────────────────────────────────────── */

  /* A CRM dialog asks about look-alike records, so its form has a box for that. */
  const dialogForm = (id, body, submitLabel) => dialogForms.form(id, body, submitLabel, { candidates: true });

  /* An owner not among the team: someone who left it — or, when the team did
     not load, whoever it is, the signed-in person being "You". */
  function ownerChoices(owner) {
    const listed = (team || []).map(m => ({ value: m.id, label: m.name }));
    if (!owner || listed.some(o => o.value === owner)) return listed;
    const me = signedIn();
    const label = has('team') ? 'The current owner (no longer on the team)'
      : me && me.id === owner ? 'You' : 'The current owner (the team did not load)';
    return [...listed, { value: owner, label }];
  }

  /* A company's fields, filled in from it (crmModel.shapeCompany) or, for a
     new one, with the database's defaults, the studio's currency and the
     signed-in person as owner. */
  function companyFields(c) {
    const me = signedIn();
    const owner = c ? c.ownerId || '' : (me && me.id) || '';
    return field('Name', `<input name="name" required maxlength="200" value="${esc(c ? c.name : '')}">`)
      + field('Domain', `<input name="domain" placeholder="northline.example" value="${esc(c ? c.domain : '')}">`)
      + '<div class="form-pair">'
      + field('Kind', `<select name="kind">${options(C.KINDS, c ? c.kind : 'prospect')}</select>`)
      + field('Stage', `<select name="stage">${options(C.STAGES, c ? c.stage : 'lead')}</select>`)
      + '</div><div class="form-pair">'
      + field('Value', `<input name="value" inputmode="decimal" value="${esc(c && c.amount !== null ? String(c.amount) : '')}">`)
      + field('Currency', `<input name="currency" maxlength="3" autocapitalize="characters" value="${esc(c ? text(c.row.currency) : studioCurrency())}">`)
      + '</div>'
      + field('Owner', `<select name="ownerId"><option value="">No owner</option>${options(ownerChoices(owner), owner)}</select>`)
      + field('Notes', `<textarea name="notes" maxlength="5000">${esc(c ? c.notes : '')}</textarea>`);
  }

  /* The company a contact's row names, whether or not it is still in the CRM. */
  const companyIdOf = person => {
    const row = (person && person.row) || {};
    return row.company_id || (row.company && row.company.id) || '';
  };

  /* A contact's fields, filled in from them (crmModel.shapeContact). A company
     they are at that has left the CRM stays chosen, so saving their title does
     not quietly take it away; a new contact may also be at a new company. */
  function contactFields(person, companies, { allowNew = false, companyId = '' } = {}) {
    const choices = companies.map(co => C.shapeCompany(co)).sort((a, b) => a.name.localeCompare(b.name))
      .map(co => ({ value: co.id, label: co.name }));
    const current = person ? companyIdOf(person) : companyId;
    const gone = current && !choices.some(o => o.value === current) ? [{ value: current, label: 'Current company (no longer in the CRM)' }] : [];
    return field('Name', `<input name="name" required maxlength="200" value="${esc(person ? person.name : '')}">`)
      + field('Email', `<input type="email" name="email" value="${esc(person ? person.email : '')}">`)
      + '<div class="form-pair">'
      + field('Phone', `<input type="tel" name="phone" value="${esc(person ? person.phone : '')}">`)
      + field('Title', `<input name="title" value="${esc(person ? person.title : '')}">`)
      + '</div>'
      + field('Company', `<select name="companyId" data-crm-company-choice><option value="">No company</option>${options([...choices, ...gone], current)}`
        + (allowNew ? `<option value="${NEW_COMPANY}">A new company…</option>` : '') + '</select>')
      + (allowNew ? field('The new company’s name', '<input name="company" maxlength="200">', ' data-crm-company-name hidden') : '')
      + field('Notes', `<textarea name="notes" maxlength="5000">${esc(person ? person.notes : '')}</textarea>`);
  }

  /* ── Asking about look-alike records ───────────────────────────────── */

  const REASONS = Object.freeze({ name: 'the same name', domain: 'the same domain', email: 'the same email address' });
  const why = found => found.reasons.map(reason => REASONS[reason] || reason).join(' and ');
  const linkTo = found => `<a href="#${esc(found.route)}">${esc(found.name)}</a>`;

  /* Whether the save goes on. A record the database would refuse it for stops
     it, naming whose that is; records that only look the same are listed, and
     the save goes on once the person presses "… anyway" for those same
     records — one a reload brings in afterwards is asked about too. */
  function clearOf(form, found, typed) {
    const box = form.querySelector('.form-candidates');
    const button = form.querySelector('[type="submit"]');
    const blocking = found.find(c => c.blocking);
    if (blocking) {
      box.innerHTML = `<p>${linkTo(blocking)} already has ${esc(why(blocking))}.</p>`;
      say(form, `${blocking.name} already has ${why(blocking)}: change it, or open ${blocking.name} instead.`,
        blocking.reasons.includes('email') ? 'email' : 'domain');
      return false;
    }
    const question = JSON.stringify([typed, found.map(c => c.id)]);
    if (!found.length || asked.get(form) === question) return true;
    asked.set(form, question);
    const anyway = `${button.dataset.label} anyway`;
    box.innerHTML = `<p>Already in the CRM:</p><ul>${found.map(c => `<li>${linkTo(c)}: ${esc(why(c))}</li>`).join('')}</ul>`
      + `<p>Press “${esc(anyway)}” to go ahead.</p>`;
    button.textContent = anyway;
    /* The button that goes ahead reads out what it goes ahead past. */
    if (button.setAttribute) button.setAttribute('aria-describedby', box.id);
    if (button.focus) button.focus();
    return false;
  }

  /* ── Companies ─────────────────────────────────────────────────────── */

  function submitNewCompany(form) {
    const v = values(form);
    quiet(form);
    const company = C.companyForm(v);
    if (company.problem) { say(form, company.problem, company.field); return; }
    const found = C.duplicateCompanies(loadedCompanies(), { name: company.values.name, domain: company.values.domain });
    if (!clearOf(form, found, [company.values.name, company.values.domain])) return;
    sending(form, () => workspaceActions.createCompany(company.values), made => {
      toast(`${company.values.name} added.`);
      navigate(C.companyRoute(made));
    });
  }

  /* A form field's column, for judging an edit against the right record. */
  const COMPANY_COLUMNS = Object.freeze({ name: 'name', domain: 'domain', kind: 'kind', stage: 'stage', value: 'value', currency: 'currency', notes: 'notes', ownerId: 'owner_id' });
  const CONTACT_COLUMNS = Object.freeze({ name: 'full_name', email: 'email', phone: 'phone', title: 'title', notes: 'notes', companyId: 'company_id' });

  /* The record an edit is judged against: the fields the person changed as
     the dialog showed them, and everything else as the store has it now — so a
     change someone made meanwhile is neither undone nor held against them. */
  function blended(opened, current, v, columns) {
    const before = (opened && opened.row) || {};
    const row = { ...((current && current.row) || {}) };
    Object.keys(v).forEach(name => {
      const column = columns[name];
      if (!column) return;
      row[column] = before[column];
      if (column === 'company_id') row.company = before.company;
    });
    return { ...current, row };
  }

  /* What the person changed, and only that is checked against the others. */
  function submitEditCompany(form, opened) {
    const v = edited(form);
    quiet(form);
    const current = C.companyById(loadedCompanies(), opened.id);
    if (!current) { say(form, 'That company is no longer in the CRM.'); return; }
    const edit = C.companyChanges(blended(opened, current, v, COMPANY_COLUMNS), v);
    if (edit.problem) { say(form, edit.problem, edit.field); return; }
    if (!Object.keys(edit.changes).length) { closeDialog(form); toast('Nothing changed.'); return; }
    const renamedTo = 'name' in edit.changes ? edit.changes.name : '';
    const movedTo = 'domain' in edit.changes ? edit.changes.domain : '';
    const found = C.duplicateCompanies(loadedCompanies(), { name: renamedTo, domain: movedTo }, opened.id);
    if (!clearOf(form, found, [renamedTo, movedTo])) return;
    const name = renamedTo || C.shapeCompany(current).name;
    sending(form, () => workspaceActions.updateCompany(opened.id, edit.changes), () => toast(`${name} saved.`));
  }

  function openCompany(company) {
    const c = company ? C.shapeCompany(company) : null;
    showModal(c ? 'CRM · COMPANY' : 'CRM · NEW COMPANY', `<h2>${c ? `Edit ${esc(c.name)}` : 'New company'}</h2>`
      + dialogForm('crm-company-form', companyFields(c), c ? 'Save company' : 'Add company'));
    const form = document.getElementById('crm-company-form');
    drawn.set(form, values(form));
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (company) submitEditCompany(form, company);
      else submitNewCompany(form);
    });
  }

  /* ── Contacts ──────────────────────────────────────────────────────── */

  /* The company first, when there is a new one — or the one this dialog added
     before, renamed if its name was corrected — then the contact at it. A
     contact refused once its company is in the CRM leaves that company chosen
     for them, and says so. */
  async function addContact(form, person, company, kept) {
    let companyId = kept ? kept.id : person.companyId;
    if (kept && kept.rename) {
      try {
        await workspaceActions.updateCompany(kept.id, { name: kept.rename });
      } catch (err) {
        /* Refused — gone from the CRM, or not this person's to change — it is
           nobody's to keep. A rename that never reached the database leaves
           the company this dialog added still this dialog's to rename. */
        if (err && err.refused) madeFor.delete(form);
        throw err;
      }
      madeFor.set(form, { id: kept.id, name: kept.rename });
    }
    if (company) {
      const row = await workspaceActions.createCompany(company);
      madeFor.set(form, { id: row.id, name: company.name });
      companyId = row.id;
    }
    try {
      return await workspaceActions.createContact({ ...person, companyId });
    } catch (err) {
      const made = madeFor.get(form);
      if (!made || made.id !== companyId) throw err;
      /* With its dialog still open the company stays chosen there; closed, the
         next dialog knows nothing of it, so this says where it is. */
      const where = dialogForms.showing(form) ? `${made.name} stays chosen for them.` : `${made.name} is in the CRM: pick it when you add them again.`;
      throw new Error(`${made.name} was added, but ${person.fullName} was not: ${sentence(err.message)} ${where}`);
    }
  }

  /* The company a new contact goes to, when it is a new one: what to add, or
     the company this dialog already added — or why neither can be. */
  function newCompanyFor(form, v) {
    const typed = text(v.company).trim();
    if (!typed) return { problem: 'Give the new company a name, or pick one.' };
    const made = madeFor.get(form);
    if (made) {
      const rename = typed !== made.name ? typed : '';
      const checked = rename ? C.companyForm({ name: rename }) : null;
      return checked && checked.problem ? { problem: checked.problem } : { kept: { id: made.id, rename }, name: rename };
    }
    /* Owned by whoever adds it, as a company added on its own is. */
    const me = signedIn();
    const company = C.companyForm({ name: typed, currency: studioCurrency(), ownerId: me ? me.id : '' });
    return company.problem ? { problem: company.problem } : { company: company.values, name: typed };
  }

  function submitNewContact(form) {
    const v = values(form);
    quiet(form);
    const atNew = v.companyId === NEW_COMPANY;
    const person = C.contactForm({ ...v, companyId: atNew ? '' : v.companyId });
    if (person.problem) { say(form, person.problem, person.field); return; }
    const place = atNew ? newCompanyFor(form, v) : {};
    if (place.problem) { say(form, place.problem, 'company'); return; }
    const exceptId = place.kept ? place.kept.id : undefined;
    const found = [
      ...C.duplicateContacts(contacts, { name: person.values.fullName, email: person.values.email }),
      ...(place.name ? C.duplicateCompanies(loadedCompanies(), { name: place.name, email: person.values.email }, exceptId) : [])
    ];
    if (!clearOf(form, found, [person.values.fullName, person.values.email, v.companyId, text(v.company).trim()])) return;
    const spare = !atNew && madeFor.get(form);
    sending(form, () => addContact(form, person.values, place.company || null, place.kept || null), row => {
      toast(`${person.values.fullName} added.${spare ? ` ${spare.name}, added a moment ago, stays in the CRM.` : ''}`);
      navigate(C.contactRoute(row));
    });
  }

  /* What the person changed, and only that is checked against the others. */
  function submitEditContact(form, opened) {
    const v = edited(form);
    quiet(form);
    const current = C.contactById(contacts, opened.id);
    if (!current) { say(form, 'That contact is no longer in the CRM.'); return; }
    const edit = C.contactChanges(blended(opened, current, v, CONTACT_COLUMNS), v);
    if (edit.problem) { say(form, edit.problem, edit.field); return; }
    if (!Object.keys(edit.changes).length) { closeDialog(form); toast('Nothing changed.'); return; }
    const renamedTo = 'full_name' in edit.changes ? edit.changes.full_name : '';
    const movedTo = 'email' in edit.changes ? edit.changes.email : '';
    const found = C.duplicateContacts(contacts, { name: renamedTo, email: movedTo }, opened.id);
    if (!clearOf(form, found, [renamedTo, movedTo])) return;
    const name = renamedTo || C.shapeContact(current, loadedCompanies()).name;
    sending(form, () => workspaceActions.updateContact(opened.id, edit.changes), () => toast(`${name} saved.`));
  }

  function openContact(contact, companyId) {
    const companies = loadedCompanies();
    const person = contact ? C.shapeContact(contact, companies) : null;
    showModal(person ? 'CRM · CONTACT' : 'CRM · NEW CONTACT', `<h2>${person ? `Edit ${esc(person.name)}` : 'New contact'}</h2>`
      + dialogForm('crm-contact-form', contactFields(person, companies, { allowNew: !person, companyId: companyId || '' }),
        person ? 'Save contact' : 'Add contact'));
    const form = document.getElementById('crm-contact-form');
    drawn.set(form, values(form));
    const choice = form.querySelector('[data-crm-company-choice]');
    const named = form.querySelector('[data-crm-company-name]');
    if (choice && named) choice.addEventListener('change', () => { named.hidden = choice.value !== NEW_COMPANY; });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (contact) submitEditContact(form, contact);
      else submitNewContact(form);
    });
  }

  /* ── What the CRM's buttons do ─────────────────────────────────────── */

  /* A plain click, which opens a link here — not one for a new tab or window. */
  const plainClick = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) && (e.button === undefined || e.button === 0);

  document.addEventListener('click', e => {
    const at = selector => (e.target.closest ? e.target.closest(selector) : null);
    /* A record a dialog names opens its page, and the dialog goes — unless it
       opens in a new tab, which leaves the dialog and what was typed in it. */
    if (at('.form-candidates a')) {
      if (plainClick(e) && typeof modal !== 'undefined' && modal.open) modal.close();
      return;
    }
    const button = at('[data-crm-new-company], [data-crm-edit-company], [data-crm-new-contact], [data-crm-edit-contact]');
    if (!button) return;
    e.preventDefault();
    if (!ready()) return;
    const d = button.dataset;
    const id = key => text(d[key]).toLowerCase();
    if (d.crmNewCompany !== undefined) { openCompany(null); return; }
    if (d.crmNewContact !== undefined) { openContact(null, id('crmNewContact')); return; }
    if (d.crmEditCompany !== undefined) {
      const company = C.companyById(loadedCompanies(), id('crmEditCompany'));
      if (company) openCompany(company);
      else toast('That company is no longer in the CRM.');
      return;
    }
    const contact = C.contactById(contacts, id('crmEditContact'));
    if (contact) openContact(contact, '');
    else toast('That contact is no longer in the CRM.');
  });

  /* "Add contact", wherever it is pressed, is this dialog: app.js's form asked
     for a company and an address the database does not need. */
  if (typeof createForm === 'function') {
    const before = createForm;
    createForm = function (kind) {
      if (kind !== 'crm') return before(kind);
      if (ready()) openContact(null, '');
      return undefined;
    };
  }

  return Object.freeze({ openCompany, openContact });
})();
