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

  /* What each open dialog was drawn with, and the question it last asked. */
  const drawn = new WeakMap();
  const asked = new WeakMap();
  /* Saying what is wrong, a clean form for each send, and one write at a time:
     as every dialog does them (dialog-forms.js). */
  const { field, options, say, quiet, closeDialog, sending } = dialogForms;

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
     not quietly take it away; a new contact may also be at a new company.

     `start` is what a NEW contact's name and address begin as — how Mail's
     "Add sender to the CRM" hands over who the conversation is with, so
     nobody retypes an address they are looking at. It is only ever a starting
     point: every field stays editable and every rule below still runs on what
     is actually submitted. An existing contact ignores it outright; their own
     record is not something a caller gets to pre-fill. */
  function contactFields(person, companies, { allowNew = false, companyId = '', start = {} } = {}) {
    const began = person ? { name: '', email: '' } : { name: text(start.name), email: text(start.email) };
    const choices = companies.map(co => C.shapeCompany(co)).sort((a, b) => a.name.localeCompare(b.name))
      .map(co => ({ value: co.id, label: co.name }));
    const current = person ? companyIdOf(person) : companyId;
    const gone = current && !choices.some(o => o.value === current) ? [{ value: current, label: 'Current company (no longer in the CRM)' }] : [];
    return field('Name', `<input name="name" required maxlength="200" value="${esc(person ? person.name : began.name)}">`)
      + field('Email', `<input type="email" name="email" value="${esc(person ? person.email : began.email)}">`)
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
     records — one a reload brings in afterwards is asked about too. Blocked
     on a domain, the field marked is `domainField` — the New company dialog's
     own "domain" input, but the new-contact dialog has no such field: there
     the domain comes from the address instead, so its "company" name field
     (the only one naming the new company at all) takes the focus instead. */
  function clearOf(form, found, typed, domainField = 'domain') {
    const box = form.querySelector('.form-candidates');
    const button = form.querySelector('[type="submit"]');
    const blocking = found.find(c => c.blocking);
    if (blocking) {
      box.innerHTML = `<p>${linkTo(blocking)} already has ${esc(why(blocking))}.</p>`;
      say(form, `${blocking.name} already has ${why(blocking)}: change it, or open ${blocking.name} instead.`,
        blocking.reasons.includes('email') ? 'email' : domainField);
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
    /* Only ever changes companies — never a contact, since this dialog adds
       none — so only that part is asked for again (store.js's after()). */
    sending(form, () => workspaceActions.createCompany(company.values), made => {
      toast(`${company.values.name} added.`);
      navigate(C.companyRoute(made));
    }, { only: ['companies'] });
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
    /* Contacts embed their company's name, stage, value and currency
       (queries.contacts()), and the ticket queue embeds a company's name
       too (queries.tickets(), for a ticket filed under one with no contact
       of its own) — both would otherwise show a company edit stale until
       the next quiet refresh. Nothing else loaded embeds a company's own
       fields this way (only a single open ticket's own page re-asks for its
       company fresh, which already happens whenever that page is opened). */
    sending(form, () => workspaceActions.updateCompany(opened.id, edit.changes), () => toast(`${name} saved.`), { only: ['contacts', 'companies', 'tickets'] });
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

  /* The domain a new company gets when none is typed for it directly: the
     contact's own address, unless it is a public mailbox — never a guess at
     a company nobody named, only the same address a person adding the
     company by hand would type into its own domain field. Filing mail from
     that address under it later (0025) is the point. */
  function domainFromEmail(email) {
    if (!text(email).includes('@')) return '';
    const domain = C.domainKey(email);
    return domain && !C.isPublicMail(domain) ? domain : '';
  }

  function submitNewContact(form, added) {
    const v = values(form);
    quiet(form);
    const atNew = v.companyId === NEW_COMPANY;
    const companyName = atNew ? text(v.company).trim() : '';
    if (atNew && !companyName) { say(form, 'Give the new company a name, or pick one.', 'company'); return; }
    const person = C.contactForm({ ...v, companyId: atNew ? '' : v.companyId });
    if (person.problem) { say(form, person.problem, person.field); return; }
    /* A domain the address gives away is asked about — and, exactly as a
       typed domain would, blocks outright when it is one another company
       already has — the same way the New company dialog treats a typed one;
       before this, only the same NAME was ever checked here. */
    const domain = atNew ? domainFromEmail(person.values.email) : '';
    const found = [
      ...C.duplicateContacts(contacts, { name: person.values.fullName, email: person.values.email }),
      ...(atNew ? C.duplicateCompanies(loadedCompanies(), { name: companyName, domain, email: person.values.email }) : [])
    ];
    if (!clearOf(form, found, [person.values.fullName, person.values.email, v.companyId, companyName], 'company')) return;
    /* create_contact_with_company (0053) adds the contact and, when none was
       picked, its company, in one transaction — matched by name among live
       companies, or made new when none matches. A contact refused no longer
       leaves a company behind for a retry to add again: nothing this call
       inserts is kept unless all of it is, so there is no spare row here to
       track or rename as there was with two separate requests. */
    sending(form, () => workspaceActions.createContactWithCompany({
      fullName: person.values.fullName, email: person.values.email, phone: person.values.phone,
      title: person.values.title, notes: person.values.notes,
      companyId: atNew ? null : person.values.companyId, companyName: atNew ? companyName : null
    }), made => {
      toast(`${person.values.fullName} added.`);
      /* Opened from somewhere with its own idea of what happens next — Mail,
         which links the conversation to whoever was just added — that caller
         says so, and the CRM does NOT then navigate away from the page they
         pressed it on. Opened from the CRM, as it always was, there is no
         such caller and the contact's own page is where to go. */
      if (added) { added(made); return; }
      navigate(C.contactRoute(made.contactId));
    }, { only: ['contacts', 'companies'] });
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
    sending(form, () => workspaceActions.updateContact(opened.id, edit.changes), () => toast(`${name} saved.`), { only: ['contacts'] });
  }

  /* `over` is for a caller outside the CRM — Mail's "Add sender to the CRM",
     so far: { name, email } to start a NEW contact's fields with, and
     onAdded(made) for what happens once they exist, in place of walking off
     to their page. Every rule this dialog enforces is unaffected by either:
     the fields are a starting point, and onAdded runs after the same write
     the CRM's own path makes. */
  function openContact(contact, companyId, over = {}) {
    const companies = loadedCompanies();
    const person = contact ? C.shapeContact(contact, companies) : null;
    showModal(person ? 'CRM · CONTACT' : 'CRM · NEW CONTACT', `<h2>${person ? `Edit ${esc(person.name)}` : 'New contact'}</h2>`
      + dialogForm('crm-contact-form',
        contactFields(person, companies, {
          allowNew: !person, companyId: companyId || '',
          start: { name: over.name, email: over.email }
        }),
        person ? 'Save contact' : 'Add contact'));
    const form = document.getElementById('crm-contact-form');
    drawn.set(form, values(form));
    const choice = form.querySelector('[data-crm-company-choice]');
    const named = form.querySelector('[data-crm-company-name]');
    if (choice && named) choice.addEventListener('change', () => { named.hidden = choice.value !== NEW_COMPANY; });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (contact) submitEditContact(form, contact);
      else submitNewContact(form, typeof over.onAdded === 'function' ? over.onAdded : null);
    });
  }

  /* ── Merging two companies, or two contacts (merge_companies / merge_contacts,
     0053) ───────────────────────────────────────────────────────────────
     Opened from the record that is kept: the person picks which other one —
     never itself — is folded into it. Owners and admins only, which crm-ui.js
     already checks before drawing the button; the database checks again. */
  const MERGE = Object.freeze({
    company: {
      noun: 'company', list: () => loadedCompanies(), shape: r => C.shapeCompany(r),
      action: (keep, drop) => workspaceActions.mergeCompanies(keep, drop)
    },
    contact: {
      noun: 'contact', list: () => contacts, shape: r => C.shapeContact(r, loadedCompanies()),
      action: (keep, drop) => workspaceActions.mergeContacts(keep, drop)
    }
  });

  function submitMerge(form, kind, keep) {
    const cfg = MERGE[kind];
    const dropId = text(values(form).dropId);
    quiet(form);
    if (!dropId) { say(form, `Pick the ${cfg.noun} to merge in.`, 'dropId'); return; }
    const drop = cfg.shape(cfg.list().find(r => r && r.id === dropId));
    /* No `only` here: a merge repoints the merged record's projects, tickets,
       mail, meetings, invoices and notes onto the one kept (0053) — every
       part the workspace loads, not only contacts and companies — so this is
       the one CRM write that still asks for the whole workspace again, the
       same as before this file started scoping the others. Rare and
       deliberate, unlike a keystroke or a single field, so the cost of
       asking for everything is not the problem here that it is elsewhere. */
    sending(form, () => cfg.action(keep.id, dropId), () => {
      toast(`${drop.name || 'The record'} merged into ${keep.name}.`);
    });
  }

  function openMerge(record, kind) {
    const cfg = MERGE[kind];
    const keep = cfg.shape(record);
    const others = cfg.list().filter(r => r && r.id !== keep.id).map(r => cfg.shape(r))
      .sort((a, b) => a.name.localeCompare(b.name));
    showModal(`CRM · MERGE`, `<h2>Merge into ${esc(keep.name)}</h2>`
      + `<p class="form-note">Everything the other ${cfg.noun} has — its projects, tickets, mail, meetings, invoices and notes — moves to ${esc(keep.name)}, and it is then removed from the CRM. This cannot be undone here.</p>`
      + dialogForm('crm-merge-form',
        field(`The ${cfg.noun} to merge in`, `<select name="dropId" required><option value="">Pick one…</option>${options(others.map(o => ({ value: o.id, label: o.name })), '')}</select>`),
        'Merge'));
    const form = document.getElementById('crm-merge-form');
    form.addEventListener('submit', e => { e.preventDefault(); submitMerge(form, kind, keep); });
  }

  /* ── Removing a company or a contact (deleted_at, actions.deleteCompany/
     deleteContact) ─────────────────────────────────────────────────────
     A confirm step first, the same pattern established projects-wide for
     anything this permanent (project-panels.js's confirmLeaveTeam and
     confirmRemovePerson): a plain dialog naming what stays behind, since a
     removed record is off every list from the next load on, and there is no
     "… anyway" here to press by mistake. Owners and admins only, which
     crm-ui.js already checks before drawing the button; guard_soft_delete
     (0012) checks again regardless of what the button offered. */
  const REMOVE = Object.freeze({
    company: {
      noun: 'company', shape: r => C.shapeCompany(r), route: 'crm/companies', only: ['contacts', 'companies', 'tickets'],
      warning: 'It leaves the pipeline, the companies list and its own page. Its people and its work — projects, tickets, mail and invoices — stay exactly where they are, filed under no company.',
      action: id => workspaceActions.deleteCompany(id)
    },
    contact: {
      noun: 'contact', shape: r => C.shapeContact(r, loadedCompanies()), route: 'crm/contacts', only: ['contacts'],
      warning: 'It leaves every list and their own page. The projects, tickets and mail already linked to them stay exactly where they are.',
      action: id => workspaceActions.deleteContact(id)
    }
  });

  function submitDelete(form, kind, record) {
    const cfg = REMOVE[kind];
    sending(form, () => cfg.action(record.id), () => {
      toast(`${record.name || 'It'} is removed from the CRM.`);
      navigate(cfg.route);
    }, { only: cfg.only });
  }

  function openDelete(record, kind) {
    const cfg = REMOVE[kind];
    const shaped = cfg.shape(record);
    showModal('CRM · REMOVE', `<h2>Remove ${esc(shaped.name)} from the CRM?</h2>`
      + `<p class="form-note">${cfg.warning}</p>`
      + dialogForms.form(`crm-delete-${kind}-form`, '', `Remove ${cfg.noun}`));
    const form = document.getElementById(`crm-delete-${kind}-form`);
    form.addEventListener('submit', e => { e.preventDefault(); quiet(form); submitDelete(form, kind, shaped); });
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
    const button = at('[data-crm-new-company], [data-crm-edit-company], [data-crm-new-contact], [data-crm-edit-contact], '
      + '[data-crm-merge-company], [data-crm-merge-contact], [data-crm-delete-company], [data-crm-delete-contact]');
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
    if (d.crmMergeCompany !== undefined) {
      const company = C.companyById(loadedCompanies(), id('crmMergeCompany'));
      if (company) openMerge(company, 'company');
      else toast('That company is no longer in the CRM.');
      return;
    }
    if (d.crmMergeContact !== undefined) {
      const contact = C.contactById(contacts, id('crmMergeContact'));
      if (contact) openMerge(contact, 'contact');
      else toast('That contact is no longer in the CRM.');
      return;
    }
    if (d.crmDeleteCompany !== undefined) {
      const company = C.companyById(loadedCompanies(), id('crmDeleteCompany'));
      if (company) openDelete(company, 'company');
      else toast('That company is no longer in the CRM.');
      return;
    }
    if (d.crmDeleteContact !== undefined) {
      const contact = C.contactById(contacts, id('crmDeleteContact'));
      if (contact) openDelete(contact, 'contact');
      else toast('That contact is no longer in the CRM.');
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

  return Object.freeze({ openCompany, openContact, openMerge, openDelete });
})();
