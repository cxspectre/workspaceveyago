/* crm-model.js — the CRM's logic, with no page in it.
 *
 * Who a contact is and which company they work at, every company with its
 * people and the work filed under it, the pipeline, the records a new one may
 * duplicate, and what the contact and company forms may save. Kept apart from
 * the views (workspace.js) so it can be tested without a browser —
 * tests/crm.test.mjs.
 *
 * The CRM used to be drawn from contacts alone. A contact was addressed by its
 * place in the list; a company with nobody at it was on no page; pipeline value
 * added a company's value once for every person working there, counted lost
 * and dormant deals, and added euros to dollars; the board had columns for
 * three of the six stages; a contact with no company was called a lead; and a
 * contact's page found projects and invoices by a matching name. Here the
 * company is the unit, everything is found by id, and no total crosses a
 * currency.
 */
const crmModel = (function () {
  'use strict';

  /* crm_companies.stage (0021), in the order a relationship moves through them.
     The open stages are the deals still to be won — the pipeline. A client's
     value is its yearly worth, and a dormant or lost deal is no pipeline. */
  const STAGES = Object.freeze([
    Object.freeze({ value: 'lead', label: 'Lead', heading: 'Leads', open: true }),
    Object.freeze({ value: 'qualified', label: 'Qualified', heading: 'Qualified', open: true }),
    Object.freeze({ value: 'proposal', label: 'Proposal', heading: 'Proposals', open: true }),
    Object.freeze({ value: 'client', label: 'Client', heading: 'Clients', open: false }),
    Object.freeze({ value: 'dormant', label: 'Dormant', heading: 'Dormant', open: false }),
    Object.freeze({ value: 'lost', label: 'Lost', heading: 'Lost', open: false })
  ]);
  const STAGE_LABELS = Object.freeze(STAGES.map(s => s.label));
  const OPEN = Object.freeze(STAGES.filter(s => s.open).map(s => s.value));
  /* crm_companies.kind (0021). */
  const KINDS = Object.freeze([
    Object.freeze({ value: 'prospect', label: 'Prospect' }),
    Object.freeze({ value: 'client', label: 'Client' }),
    Object.freeze({ value: 'partner', label: 'Partner' }),
    Object.freeze({ value: 'internal', label: 'Internal' })
  ]);

  const text = value => String(value == null ? '' : value);
  /* Text as the database keeps it: a browser may send a textarea's line breaks as CRLF. */
  const tidy = value => text(value).replace(/\r\n?/g, '\n').trim();
  const orNull = value => tidy(value) || null;
  /* The database row a record carries, or the record when it is a row itself. */
  const rowOf = record => (record && record.row) || record || {};
  const idOf = record => (typeof record === 'string' ? record : (record && record.id) || '');

  /* A stage or kind as the database has it, from its value or its label:
     'qualified' and 'Qualified' are the same stage. */
  function valueIn(list, given) {
    const wanted = text(given).trim().toLowerCase();
    const hit = wanted ? list.find(x => x.value === wanted || x.label.toLowerCase() === wanted) : null;
    return hit ? hit.value : null;
  }
  const stageValue = given => valueIn(STAGES, given);
  const kindValue = given => valueIn(KINDS, given);
  const labelIn = (list, value) => (list.find(x => x.value === value) || { label: '' }).label;
  const stageLabel = value => labelIn(STAGES, value);

  /* ── Money ─────────────────────────────────────────────────────────── */

  /* numeric(12,2) holds up to 9,999,999,999.99. */
  const VALUE_LIMIT = 1e10;
  /* crm_companies.currency since 0049, as project_budgets.currency since 0039. */
  const CURRENCY = /^[A-Z]{3}$/;

  /* A stored value as a number, or null — read from the row, never from the
     formatted "$12,000" queries.js puts beside it. */
  function amountOf(value) {
    if (value === null || value === undefined || text(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /* The currency a value is counted in. A blank is USD, the database's default;
     a code in lower case is that code; anything else — "US$", stored before
     0049 — stays itself, so it is never added to anybody's dollars. */
  function currencyOf(value) {
    const typed = text(value).trim();
    if (!typed) return 'USD';
    return CURRENCY.test(typed.toUpperCase()) ? typed.toUpperCase() : typed;
  }

  /* An amount the way people type one, by the rule a project budget is read
     with (projects-model.js): 12500, 12,500, 12.500,50, 12 500.5, 1'234'567.
     Thousands are grouped in threes by one separator, and one or two decimals
     follow the other. Empty is null; anything else is NaN, never a guess. */
  const AMOUNT = /^(\d+|\d{1,3}([ ,.])\d{3}(?:\2\d{3})*)(?:([.,])(\d{1,2}))?$/;

  function parseAmount(value) {
    const typed = text(value).trim().replace(/[  '’]/g, ' ');
    if (!typed) return null;
    const m = AMOUNT.exec(typed);
    if (!m || (m[2] && m[2] === m[3])) return NaN;
    return Number(`${m[1].replace(/[ ,.]/g, '')}.${m[4] || '0'}`);
  }

  /* What companies are worth, per currency — added in cents: as floating
     point, 0.57 and 1.13 make 1.6999999999999997. A company with no value
     adds nothing. */
  function totalsOf(companies) {
    const cents = new Map();
    companies.forEach(c => {
      const row = rowOf(c);
      const amount = amountOf(row.value);
      if (amount === null) return;
      const currency = currencyOf(row.currency);
      cents.set(currency, (cents.get(currency) || 0) + Math.round(amount * 100));
    });
    return Object.freeze([...cents.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(currency => Object.freeze({ currency, amount: cents.get(currency) / 100 })));
  }

  /* ── Names, domains and addresses, as they are compared ─────────────── */

  /* A name as it is compared: accents, case, punctuation and spacing set
     aside — "José  O'Brien" and "jose obrien" are one name. */
  function nameKey(name) {
    return text(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/['’`.]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /* Legal forms that do not make a company another company. */
  const LEGAL_FORMS = new Set(['inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'corp', 'corporation',
    'co', 'company', 'plc', 'gmbh', 'ag', 'kg', 'ug', 'ohg', 'bv', 'nv', 'vof']);

  /* A company name as it is compared for duplicates: its name key without the
     legal forms it ends in — "Northline GmbH", "Northline B.V." and "Harbor &
     Co." are Northline and Harbor. For candidates a person confirms only,
     never to pick a company for them (projectsModel.findCompany does that). */
  function companyKey(name) {
    const words = nameKey(name).split(' ').filter(Boolean);
    let end = words.length;
    while (end > 1 && (LEGAL_FORMS.has(words[end - 1]) || (words[end - 1] === 'and' && end < words.length))) end -= 1;
    return words.slice(0, end).join(' ');
  }

  /* A domain as crm_companies keeps it (0021): bare and in lower case —
     "northline.example", not "https://www.Northline.example/about", and not an
     address at it. */
  function domainKey(value) {
    return text(value).normalize('NFKC').trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/^.*@/, '')
      .replace(/:\d*$/, '')
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  }

  const DOMAIN = /^(?=.{4,253}$)(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}[\p{L}\p{N}-]{0,61}[\p{L}\p{N}]$/u;
  const isDomain = value => DOMAIN.test(text(value));

  /* An address as crm_contacts compares it: one live contact per lower(email). */
  const emailKey = value => text(value).trim().toLowerCase();

  /* An address: something before one @, a domain after it, and no spaces. */
  function isEmail(value) {
    const address = text(value);
    const at = address.indexOf('@');
    return at > 0 && at === address.lastIndexOf('@') && !/\s/.test(address) && isDomain(address.slice(at + 1));
  }

  /* The public mailboxes promote_enquiry_to_crm() files nobody under (0049). An
     address at one says nothing about where someone works, and a company that
     held one as its domain would collect every stranger who writes from it. */
  const PUBLIC_MAIL = new Set([
    'gmail.com', 'googlemail.com',
    'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.co.uk', 'hotmail.de', 'hotmail.nl', 'hotmail.be',
    'live.com', 'live.co.uk', 'live.de', 'live.nl', 'live.be', 'live.at', 'msn.com', 'windowslive.com',
    'yahoo.com', 'yahoo.co.uk', 'yahoo.de', 'ymail.com', 'rocketmail.com',
    'icloud.com', 'me.com', 'mac.com', 'privaterelay.appleid.com',
    'aol.com', 'aol.co.uk', 'aol.de', 'aim.com',
    'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
    'tutanota.com', 'tutanota.de', 'tutamail.com', 'tuta.io', 'tuta.com', 'keemail.me',
    'gmx.com', 'mail.com', 'zohomail.com', 'zohomail.eu', 'yandex.com', 'yandex.ru', 'mail.ru',
    'fastmail.com', 'fastmail.fm', 'hey.com', 'hushmail.com', 'mailfence.com', 'duck.com',
    'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de', 'magenta.de', 'freenet.de',
    'arcor.de', 'mail.de', 'online.de', 'posteo.de', 'posteo.net', 'mailbox.org',
    'aon.at', 'chello.at', 'bluewin.ch',
    'ziggo.nl', 'kpnmail.nl', 'kpnplanet.nl', 'planet.nl', 'home.nl', 'hetnet.nl', 'xs4all.nl',
    'upcmail.nl', 'chello.nl', 'casema.nl', 'telenet.be', 'skynet.be',
    'btinternet.com', 'sky.com', 'virginmedia.com', 'ntlworld.com', 'blueyonder.co.uk', 'talktalk.net',
    'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'cox.net', 'charter.net',
    'bellsouth.net', 'earthlink.net'
  ]);
  const isPublicMail = domain => PUBLIC_MAIL.has(domainKey(domain));

  /* ── Contacts and companies ─────────────────────────────────────────── */

  /* By id and nothing else: an old position-based link ("#crm/0") opens
     nobody, rather than whoever sits there now. */
  const byId = (list, id) => (typeof id === 'string' && id
    ? (list || []).find(item => item && item.id === id) || null
    : null);
  const contactById = (contacts, id) => byId(contacts, id);
  const companyById = (companies, id) => byId(companies, id);

  const contactRoute = contact => (idOf(contact) ? 'crm/' + idOf(contact) : null);
  const companyRoute = company => (idOf(company) ? 'crm/companies/' + idOf(company) : null);

  /* Each record once, by id, in the order first seen. */
  function uniqueById(records) {
    const seen = new Set();
    return (records || []).filter(r => r && r.id && !seen.has(r.id) && seen.add(r.id));
  }

  /* A company as the views use it. `company` is what queries.companies()
     returns, a crm_companies row, or the company embedded in a contact. */
  function shapeCompany(company) {
    const c = company || {};
    const row = rowOf(c);
    const id = c.id || row.id || null;
    const stage = stageValue(row.stage);
    const kind = kindValue(row.kind);
    return Object.freeze({
      id,
      name: text(row.name != null ? row.name : c.name),
      domain: text(row.domain),
      kind,
      kindLabel: labelIn(KINDS, kind),
      stage,
      stageLabel: stageLabel(stage),
      open: OPEN.includes(stage),
      amount: amountOf(row.value),
      currency: currencyOf(row.currency),
      notes: text(row.notes),
      ownerId: row.owner_id || null,
      route: companyRoute(id),
      row
    });
  }

  /* The company a contact's row names: its column, or the company embedded with it. */
  const companyIdOf = contact => {
    const row = rowOf(contact);
    return row.company_id || (row.company && row.company.id) || null;
  };

  /* A contact as the views use it, at the company their row names — found by id
     among `companies`, the companies loaded. One that is not among them was
     deleted, and is no company. Until companies have loaded (null), the company
     embedded with the contact is all there is. A contact's stage is their
     company's: with no company they have none, and are not a lead. */
  function shapeContact(contact, companies) {
    const c = contact || {};
    const row = rowOf(c);
    const embedded = companies == null && row.company ? row.company : null;
    const found = Array.isArray(companies) ? companyById(companies, companyIdOf(c)) : embedded;
    const company = found ? shapeCompany(found) : null;
    const id = c.id || row.id || null;
    return Object.freeze({
      id,
      name: text(c.name != null ? c.name : row.full_name),
      initial: text(c.initial),
      email: text(c.email || row.email),
      title: text(row.title),
      phone: text(row.phone),
      notes: text(c.notes || row.notes),
      companyId: company ? company.id : null,
      company,
      companyName: company ? company.name : '',
      stage: company ? company.stage : null,
      stageLabel: company ? company.stageLabel : '',
      route: contactRoute(id),
      row
    });
  }

  function contactList(contacts, companies) {
    return Object.freeze((contacts || []).filter(c => c && c.id).map(c => shapeContact(c, companies)));
  }

  /* What a CRM address opens: the list (crm), a contact (crm/<id>), the
     companies (crm/companies) or a company (crm/companies/<id>), with the tab
     after it and the record — null when nothing has that id. */
  function route(parts, contacts, companies) {
    const p = parts || [];
    const at = i => (typeof p[i] === 'string' && p[i] ? p[i] : null);
    const page = (kind, id, tab, record) => Object.freeze({ kind, id, tab, record });
    if (at(1) === 'companies') {
      return at(2)
        ? page('company', at(2), at(3) || 'overview', companyById(companies, at(2)))
        : page('companies', null, null, null);
    }
    return at(1)
      ? page('contact', at(1), at(2) || 'overview', contactById(contacts, at(1)))
      : page('list', null, null, null);
  }

  /* ── Connected work, by id ─────────────────────────────────────────── */

  const columnOf = (record, name) => rowOf(record)[name] || null;
  const projectCompanyId = project => (project && (project.companyId || columnOf(project, 'company_id'))) || null;
  const emptyWork = () => ({ contacts: [], projects: [], tickets: [], events: [], invoices: [] });
  const frozenWork = group => Object.freeze(Object.fromEntries(
    Object.entries(group).map(([kind, list]) => [kind, Object.freeze(list)])));

  /* The company a ticket, meeting or invoice belongs to: the one it is filed
     under, else its project's, else its contact's — so each is listed in one
     place, and never because of a name. */
  function ownerOf(record, projectCompany, contactCompany) {
    return columnOf(record, 'company_id')
      || projectCompany.get(columnOf(record, 'project_id'))
      || contactCompany.get(columnOf(record, 'contact_id'))
      || null;
  }

  /* The listed companies' people and work, from one pass over each list. Built
     in place here: filtering every list for every company would be quadratic
     in a studio's records. A project or contact at a company that is not
     listed still decides where its tickets go — just not to a listed company. */
  function indexWork(companies, sources) {
    const s = sources || {};
    const groups = new Map(companies.map(c => [c.id, emptyWork()]));
    const contactCompany = new Map();
    const projectCompany = new Map();
    (s.contacts || []).filter(c => c && c.id).forEach(c => {
      contactCompany.set(c.id, companyIdOf(c));
      if (groups.has(companyIdOf(c))) groups.get(companyIdOf(c)).contacts.push(shapeContact(c, companies));
    });
    (s.projects || []).filter(p => p && p.id).forEach(p => {
      projectCompany.set(p.id, projectCompanyId(p));
      if (groups.has(projectCompanyId(p))) groups.get(projectCompanyId(p)).projects.push(p);
    });
    ['tickets', 'events', 'invoices'].forEach(kind => (s[kind] || []).filter(Boolean).forEach(record => {
      const owner = ownerOf(record, projectCompany, contactCompany);
      if (groups.has(owner)) groups.get(owner)[kind].push(record);
    }));
    return groups;
  }

  /* Every company, people or not — each once, in the order given — with its
     people and the work filed under it. `sources` holds the store's lists:
     contacts, projects, tickets, events and invoices. */
  function companyList(companies, sources) {
    const list = uniqueById(companies);
    const groups = indexWork(list, sources);
    return Object.freeze(list.map(c => Object.freeze({ ...shapeCompany(c), ...frozenWork(groups.get(c.id)) })));
  }

  /* One company's people and work, found the way companyList() finds them. */
  function companyWork(company, sources) {
    if (!company || !company.id) return frozenWork(emptyWork());
    return frozenWork(indexWork([company], sources).get(company.id));
  }

  /* A contact's page: the projects they are on (project_contacts, 0039) first,
     then the rest of their company's, with their role on each they are on; and
     the tickets, meetings and invoices filed under them. `sources` also holds
     companies and projectContacts. A project that shares a name is nobody's. */
  function contactWork(contact, sources) {
    const s = sources || {};
    const none = Object.freeze([]);
    if (!contact || !contact.id) {
      return Object.freeze({ projects: none, roles: Object.freeze({}), tickets: none, events: none, invoices: none });
    }
    const person = shapeContact(contact, s.companies);
    const projects = (s.projects || []).filter(p => p && p.id);
    const links = (s.projectContacts || []).filter(l => l && l.contact_id === person.id);
    const onIt = uniqueById(links.map(l => projects.find(p => p.id === l.project_id)));
    const rest = person.companyId
      ? projects.filter(p => projectCompanyId(p) === person.companyId && !onIt.includes(p))
      : [];
    const roles = links.filter(l => onIt.some(p => p.id === l.project_id)).map(l => [l.project_id, l.role]);
    const filed = kind => Object.freeze((s[kind] || []).filter(r => r && columnOf(r, 'contact_id') === person.id));
    return Object.freeze({
      projects: Object.freeze([...onIt, ...rest]),
      roles: Object.freeze(Object.fromEntries(roles)),
      tickets: filed('tickets'),
      events: filed('events'),
      invoices: filed('invoices')
    });
  }

  /* ── The pipeline ──────────────────────────────────────────────────── */

  /* The board: a column for each of the six stages, each company on it once —
     however many people work there — with what the column is worth in each
     currency. `open` is the pipeline: the companies still to be won, and their
     value. `companies` may be companyList() entries, whose cards keep their
     people, or the companies as loaded. */
  function pipeline(companies) {
    const list = uniqueById(companies);
    const stageOf = c => stageValue(rowOf(c).stage);
    const columns = STAGES.map(s => {
      const members = list.filter(c => stageOf(c) === s.value);
      return Object.freeze({
        stage: s.value, label: s.label, heading: s.heading, open: s.open,
        companies: Object.freeze(members), count: members.length, totals: totalsOf(members)
      });
    });
    const open = list.filter(c => OPEN.includes(stageOf(c)));
    return Object.freeze({
      columns: Object.freeze(columns),
      open: Object.freeze({ count: open.length, totals: totalsOf(open) })
    });
  }

  /* ── Duplicates ────────────────────────────────────────────────────── */

  /* A record a new one may duplicate: what matched, and whether the database
     would refuse the new one outright (`blocking`) rather than keep both. */
  const candidate = (record, name, link, reasons, blocking) =>
    Object.freeze({ id: record.id, name: text(name), route: link, reasons: Object.freeze(reasons), blocking, record });

  /* The surest first: what the database would refuse, then what matched on
     more, then in the order given. */
  const surestFirst = found => Object.freeze(found
    .filter(c => c.reasons.length)
    .map((c, order) => ({ c, order }))
    .sort((a, b) => Number(b.c.blocking) - Number(a.c.blocking)
      || b.c.reasons.length - a.c.reasons.length || a.order - b.order)
    .map(x => x.c));

  /* Companies a new or edited one may duplicate: the same name however it is
     written, or the same domain — typed as a web address, or on the address of
     someone who works there, unless that is a public mailbox. The database
     keeps one live company per lower(domain) (0021): the same stored domain
     blocks. `exceptId` is the company being edited. */
  function duplicateCompanies(companies, fields, exceptId) {
    const f = fields || {};
    const name = companyKey(f.name);
    const typed = tidy(f.domain) ? domainKey(f.domain) : '';
    const mailDomain = text(f.email).includes('@') ? domainKey(f.email) : '';
    const fromMail = mailDomain && !isPublicMail(mailDomain) ? mailDomain : '';
    return surestFirst(uniqueById(companies).filter(c => c.id !== exceptId).map(c => {
      const row = rowOf(c);
      const theirs = row.name != null ? row.name : c.name;
      const stored = domainKey(row.domain);
      const reasons = [
        name && companyKey(theirs) === name ? 'name' : null,
        stored && (stored === typed || stored === fromMail) ? 'domain' : null
      ].filter(Boolean);
      const blocking = Boolean(typed) && text(row.domain).trim().toLowerCase() === typed;
      return candidate(c, theirs, companyRoute(c), reasons, blocking);
    }));
  }

  /* Contacts a new or edited one may duplicate: the same address, which the
     database refuses outright — one live contact per lower(email) (0021) — or
     the same name, which is only a question for the person. */
  function duplicateContacts(contacts, fields, exceptId) {
    const f = fields || {};
    const name = nameKey(f.name);
    const email = emailKey(f.email);
    return surestFirst(uniqueById(contacts).filter(c => c.id !== exceptId).map(c => {
      const row = rowOf(c);
      const theirs = c.name != null ? c.name : row.full_name;
      const sameEmail = Boolean(email) && emailKey(c.email || row.email) === email;
      const reasons = [name && nameKey(theirs) === name ? 'name' : null, sameEmail ? 'email' : null].filter(Boolean);
      return candidate(c, theirs, contactRoute(c), reasons, sameEmail);
    }));
  }

  /* ── Forms ─────────────────────────────────────────────────────────── */

  const EMAIL_PROBLEM = 'Enter a whole email address, like ana@northline.example.';
  const KIND_PROBLEM = 'Pick what kind of company this is.';
  const STAGE_PROBLEM = 'Pick a stage from the pipeline.';
  const CURRENCY_PROBLEM = 'Pick a currency, like EUR or USD.';

  const sent = (fields, key) => Object.prototype.hasOwnProperty.call(fields, key) && fields[key] !== undefined;

  /* [form field, column, what the form says, what the record said] as columns
     to write: only fields the form sent, and only where they differ. */
  const changesFrom = (fields, candidates) => Object.freeze(candidates
    .filter(([field, , value, current]) => sent(fields, field) && value !== current)
    .reduce((all, [, column, value]) => ({ ...all, [column]: value }), {}));

  /* A typed domain as crm_companies keeps it, or why it cannot be one. */
  function readDomain(value) {
    if (!tidy(value)) return { domain: null, problem: null };
    const domain = domainKey(value);
    if (!isDomain(domain)) return { domain: null, problem: 'That domain is not a web address, like northline.example.' };
    if (isPublicMail(domain)) return { domain: null, problem: `${domain} is a public mailbox, not a company's own domain.` };
    return { domain, problem: null };
  }

  /* A typed value as numeric(12,2) keeps it, or why it cannot be one. */
  function readValue(value) {
    const amount = parseAmount(value);
    if (amount === null) return { amount: null, problem: null };
    if (Number.isNaN(amount)) return { amount: null, problem: 'That value is not an amount.' };
    if (amount >= VALUE_LIMIT) return { amount: null, problem: 'That value is too large.' };
    return { amount: Math.round(amount * 100) / 100, problem: null };
  }

  /* A new contact, as workspaceActions.createContact() takes one — or why it
     cannot be saved, with `field` naming the input to point at. crm_contacts
     needs a name and nothing else: no company, no address. `company` is the
     company name typed, if any, for the caller to find or create. */
  function contactForm(fields) {
    const f = fields || {};
    const refuse = (problem, field) => Object.freeze({ values: Object.freeze({}), company: '', problem, field });
    const fullName = tidy(f.name);
    if (!fullName) return refuse('A contact needs a name.', 'name');
    const email = emailKey(f.email);
    if (email && !isEmail(email)) return refuse(EMAIL_PROBLEM, 'email');
    return Object.freeze({
      values: Object.freeze({
        fullName, companyId: orNull(f.companyId), email: email || null,
        phone: orNull(f.phone), title: orNull(f.title), notes: orNull(f.notes)
      }),
      company: tidy(f.company).replace(/\s+/g, ' '),
      problem: null,
      field: null
    });
  }

  /* What an edit to a contact changes, as crm_contacts columns. An empty field
     means "none". A name or an address is judged only when it changed. */
  function contactChanges(contact, fields) {
    const f = fields || {};
    const row = rowOf(contact);
    const refuse = (problem, field) => Object.freeze({ changes: Object.freeze({}), problem, field });
    const name = tidy(row.full_name != null ? row.full_name : contact && contact.name);
    const email = emailKey(row.email) || null;
    const typedEmail = emailKey(f.email) || null;
    if (sent(f, 'name') && tidy(f.name) !== name && !tidy(f.name)) return refuse('A contact needs a name.', 'name');
    if (sent(f, 'email') && typedEmail !== email && typedEmail && !isEmail(typedEmail)) return refuse(EMAIL_PROBLEM, 'email');
    const changes = changesFrom(f, [
      ['name', 'full_name', tidy(f.name), name],
      ['email', 'email', typedEmail, email],
      ['phone', 'phone', orNull(f.phone), orNull(row.phone)],
      ['title', 'title', orNull(f.title), orNull(row.title)],
      ['notes', 'notes', orNull(f.notes), orNull(row.notes)],
      ['companyId', 'company_id', orNull(f.companyId), companyIdOf(contact)]
    ]);
    return Object.freeze({ changes, problem: null, field: null });
  }

  /* A new company, as workspaceActions.createCompany() takes one — or why it
     cannot be saved. Only a name is needed: kind, stage and currency fall back
     to the database's defaults. What the database would refuse — a kind or
     stage it does not have, a currency that is not three letters (0049), a
     value numeric(12,2) cannot hold — is refused here first, and so is a
     public mailbox given as the company's domain. */
  function companyForm(fields) {
    const f = fields || {};
    const refuse = (problem, field) => Object.freeze({ values: Object.freeze({}), problem, field });
    const name = tidy(f.name);
    if (!name) return refuse('A company needs a name.', 'name');
    const domain = readDomain(f.domain);
    if (domain.problem) return refuse(domain.problem, 'domain');
    const kind = tidy(f.kind) ? kindValue(f.kind) : 'prospect';
    if (!kind) return refuse(KIND_PROBLEM, 'kind');
    const stage = tidy(f.stage) ? stageValue(f.stage) : 'lead';
    if (!stage) return refuse(STAGE_PROBLEM, 'stage');
    const value = readValue(f.value);
    if (value.problem) return refuse(value.problem, 'value');
    const currency = tidy(f.currency).toUpperCase() || 'USD';
    if (!CURRENCY.test(currency)) return refuse(CURRENCY_PROBLEM, 'currency');
    return Object.freeze({
      values: Object.freeze({
        name, domain: domain.domain, kind, stage, value: value.amount, currency,
        notes: orNull(f.notes), ownerId: orNull(f.ownerId)
      }),
      problem: null,
      field: null
    });
  }

  /* A value sent back as the record holds it: "-500" for a stored -500, which
     numeric(12,2) takes but this form would never type. */
  const sameValue = (typed, stored) => amountOf(typed) !== null && amountOf(typed) === amountOf(stored);

  /* Why an edit to a company cannot be saved, as [problem, field], or null. A
     typed kind or stage is always this edit's: the stored ones follow the
     database's rules. A domain, currency or value stored outside the form's
     rules is judged only when it changed. */
  function companyProblem(row, f) {
    const currency = tidy(f.currency).toUpperCase();
    if (sent(f, 'name') && tidy(f.name) !== tidy(row.name) && !tidy(f.name)) return ['A company needs a name.', 'name'];
    if (sent(f, 'domain') && domainKey(f.domain) !== domainKey(row.domain) && readDomain(f.domain).problem) {
      return [readDomain(f.domain).problem, 'domain'];
    }
    if (sent(f, 'kind') && !kindValue(f.kind)) return [KIND_PROBLEM, 'kind'];
    if (sent(f, 'stage') && !stageValue(f.stage)) return [STAGE_PROBLEM, 'stage'];
    if (sent(f, 'value') && !sameValue(f.value, row.value) && readValue(f.value).problem) return [readValue(f.value).problem, 'value'];
    if (sent(f, 'currency') && currency !== text(row.currency) && !CURRENCY.test(currency)) return [CURRENCY_PROBLEM, 'currency'];
    return null;
  }

  /* What an edit to a company changes, as crm_companies columns — or why it
     cannot be saved. The database checks the currency rule (0049) on every
     change to a row, so a company still holding a code from before it has to
     be given one in the same change. */
  function companyChanges(company, fields) {
    const f = fields || {};
    const row = rowOf(company);
    const refuse = (problem, field) => Object.freeze({ changes: Object.freeze({}), problem, field });
    const problem = companyProblem(row, f);
    if (problem) return refuse(problem[0], problem[1]);
    const sameDomain = domainKey(f.domain) === domainKey(row.domain);
    const changes = changesFrom(f, [
      ['name', 'name', tidy(f.name), tidy(row.name)],
      ['domain', 'domain', sameDomain ? orNull(row.domain) : readDomain(f.domain).domain, orNull(row.domain)],
      ['kind', 'kind', kindValue(f.kind), kindValue(row.kind)],
      ['stage', 'stage', stageValue(f.stage), stageValue(row.stage)],
      ['value', 'value', sameValue(f.value, row.value) ? amountOf(row.value) : readValue(f.value).amount, amountOf(row.value)],
      ['currency', 'currency', tidy(f.currency).toUpperCase(), text(row.currency)],
      ['notes', 'notes', orNull(f.notes), orNull(row.notes)],
      ['ownerId', 'owner_id', orNull(f.ownerId), row.owner_id || null]
    ]);
    const stale = typeof row.currency === 'string' && !CURRENCY.test(row.currency);
    if (stale && Object.keys(changes).length && !('currency' in changes)) {
      return refuse(`This company's currency, "${row.currency}", is not a code like EUR or USD. Pick one to save the change.`, 'currency');
    }
    return Object.freeze({ changes, problem: null, field: null });
  }

  /* ── Search ────────────────────────────────────────────────────────── */

  /* What the CRM's search finds: a company by its name, domain and people; a
     contact by their name, address and company. */
  function matchesQuery(entry, query) {
    const wanted = text(query).trim().toLowerCase();
    if (!wanted) return true;
    const e = entry || {};
    const people = (e.contacts || []).map(c => [c && c.name, c && c.email].map(text).join(' '));
    return [e.name, e.domain, e.email, e.companyName, ...people].map(text).join(' ').toLowerCase().includes(wanted);
  }

  return Object.freeze({
    STAGES, STAGE_LABELS, KINDS, VALUE_LIMIT,
    stageValue, stageLabel, kindValue,
    /* The money rules, exported so deals-model.js counts a deal's value the
       way this file has always counted a company's (0067 gave crm_deals the
       same numeric(12,2) and the same three-letter currency rule 0049 gave
       crm_companies, so the reading of them must not drift apart). */
    amountOf, currencyOf, parseAmount, readValue, totalsOf,
    nameKey, companyKey, domainKey, isPublicMail,
    contactById, companyById, contactRoute, companyRoute, route,
    shapeCompany, shapeContact, contactList, companyList, companyWork, contactWork,
    pipeline, duplicateCompanies, duplicateContacts,
    contactForm, contactChanges, companyForm, companyChanges,
    matchesQuery
  });
})();
