/* crm-ui.js — the CRM: its figures, the pipeline of companies, the companies
   and contacts lists, and each company's and contact's page.

   As crm-model.js has them: the company is the unit, each once however many
   people work there; every stage has its column; everything is found by id,
   never by a matching name; and no total crosses a currency. A contact with no
   company has no stage — they are not a lead — and one whose company was
   deleted has none. A contact's invoices are the ones sent to their address,
   and a company's the ones sent to its people; staff, who cannot read invoices,
   are not shown a list of them that could only ever be empty. What did not load
   says so rather than reading as nothing: a contact's conversations and roles
   on projects, a company's owner, the invoices.

   The CRM used to be drawn from contacts alone, by workspace.js: pipeline value
   added a company's value once for every person working there, counted dormant
   and lost deals and added euros to dollars; active clients counted people; a
   company with nobody at it was on no page; the board had three of the six
   stages; and a contact's page found projects and invoices by a matching name.

   `crmUi` is what is worked out rather than drawn. The pages replace the one
   app.js drew, with the page helpers workspace.js defines, so this file loads
   after it. Tested in tests/crm-ui.test.mjs. */
const crmUi = (function () {
  'use strict';

  const C = crmModel;
  const NONE = '—';
  const CODE = /^[A-Z]{3}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /* A long list draws this many rows, and says how many a search can narrow. */
  const ROW_LIMIT = 200;
  const LIST_HEADING = 'crm-list-heading';

  const text = value => String(value == null ? '' : value);
  const addressOf = value => text(value).trim().toLowerCase();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const rowOf = record => (record && record.row) || record || {};

  /* ── What is worked out ────────────────────────────────────────────── */

  /* The studio's currency first, then the other codes, then what was stored
     before currencies had to be codes (0049). */
  const rank = (currency, main) => (currency === main ? 0 : CODE.test(currency) ? 1 : 2);

  /* Each currency's total side by side, written the way Finance writes money:
     "$42,000.00 · €3,500.00". */
  const moneyLine = (totals, main) => [...totals]
    .sort((a, b) => rank(a.currency, main) - rank(b.currency, main))
    .map(t => financeModel.money(t.amount, t.currency))
    .join(' · ');

  /* The strip at the top of the CRM, as statStrip() takes it: [label, value,
     caption] for each figure. `companies` is the companies as loaded — null
     when they did not load, and then what is worked out from them is a dash,
     never a zero. `main` is the studio's currency, when it is known. */
  function stats(contacts, companies, main) {
    const people = ['Contacts', (contacts || []).length, 'People in your network'];
    if (!Array.isArray(companies)) {
      return Object.freeze([
        people,
        ['Pipeline value', NONE, 'Companies did not load'],
        ['Active clients', NONE, 'Companies did not load']
      ]);
    }
    const board = C.pipeline(companies);
    const open = board.open;
    const clients = board.columns.find(column => column.stage === 'client') || { count: 0 };
    return Object.freeze([
      people,
      ['Pipeline value', open.totals.length ? moneyLine(open.totals, main) : NONE,
        open.count ? `${plural(open.count, 'company', 'companies')} still to win` : 'No open deals'],
      ['Active clients', clients.count, 'Companies you work with']
    ]);
  }

  /* The invoices sent to a contact: to their address, however either was
     typed — never one billed to their company's name. `invoices` are shaped
     (financeModel.shapeInvoice); one with no page to open is left out. Null
     when the invoices are not known. */
  function invoicesFor(contact, invoices) {
    if (!Array.isArray(invoices)) return null;
    const address = addressOf(contact && contact.email);
    if (!address) return Object.freeze([]);
    return Object.freeze(invoices
      .filter(invoice => invoice && invoice.route && addressOf(invoice.clientEmail) === address));
  }

  /* ── What the pages read ───────────────────────────────────────────── */

  const has = part => Boolean(window.workspaceStore && workspaceStore.has(part));
  const stored = () => (window.workspaceStore && workspaceStore.state) || {};
  /* The companies as loaded, or null when they did not load. */
  const loadedCompanies = () => (has('companies') ? stored().companies || [] : null);
  /* The studio's currency, as the Overview has it (0041), when it is known. */
  const studioCurrency = () => {
    const overview = stored().overview;
    return overview && overview.revenue_currency ? text(overview.revenue_currency).trim().toUpperCase() : null;
  };
  /* An id written in capitals is the same record: the database writes uuids in
     lower case, and the breadcrumb names the record either way. */
  const addressParts = () => routeParts.map(part => (typeof part === 'string' && UUID.test(part) ? part.toLowerCase() : part));

  /* The meetings the page has: the weeks loaded and the project meetings
     coming up, each once. */
  const meetings = () => {
    const seen = new Set();
    return [...(events || []), ...(stored().projectEvents || [])].filter(e => e && e.id && !seen.has(e.id) && seen.add(e.id));
  };

  /* The store's lists, as crm-model.js finds a company's or a contact's work in them. */
  const sources = companies => ({
    companies, contacts, projects, tickets,
    events: meetings(),
    projectContacts: stored().projectContacts || []
  });

  /* What a page can say of the invoices sent to `people`: nothing, to staff,
     who cannot read invoices (RLS returns none, which is not "none sent"); that
     they did not load, to a manager whose invoices did not; otherwise the ones
     sent to those people, each once. Only those are shaped: shaping every
     invoice took most of a page's time. */
  function invoicesTo(people) {
    if (!isManagerNow()) return { shown: false, list: null };
    if (!has('invoices')) return { shown: true, list: null };
    const addresses = new Set(people.map(person => addressOf(person && person.email)).filter(Boolean));
    const today = financeDay();
    const shaped = (invoices || [])
      .filter(invoice => invoice && addresses.has(addressOf(rowOf(invoice).client_email)))
      .map(invoice => financeModel.shapeInvoice(invoice, today));
    const sent = people.flatMap(person => [...invoicesFor(person, shaped)]);
    return { shown: true, list: sent.filter((invoice, i) => sent.findIndex(other => other.uuid === invoice.uuid) === i) };
  }

  /* Who owns a company, as far as the page can tell: their name; that nobody
     is set; that the team did not load; or that the owner has left the team. */
  function ownerOf(ownerId) {
    if (!ownerId) return { name: null, words: 'No owner yet' };
    if (!has('team')) return { name: null, words: 'The team did not load' };
    const member = (team || []).find(m => m && m.id === ownerId);
    return member ? { name: member.name, words: member.name } : { name: null, words: 'Someone no longer on the team' };
  }

  const valueText = company => (company.amount === null ? NONE : financeModel.money(company.amount, company.currency));
  const quiet = words => `<span class="quiet-text">${esc(words)}</span>`;
  const note = words => `<p class="aside-note">${esc(words)}</p>`;
  const stageCell = label => (label ? pill(label) : quiet(NONE));
  const recordLink = (route, label) => `<a class="record-link" href="#${esc(route)}">${label}</a>`;
  /* Initials, as the rest of the workspace makes them (queries.js), are
     decoration: the name beside them is what is read out. */
  const avatar = (name, letters, className) =>
    `<div class="avatar${className ? ' ' + className : ''}" aria-hidden="true">${esc(letters || workspaceData.initials(name))}</div>`;
  const invoiceItems = list => list.map(invoice => [invoice.route, invoice.number + ' · ' + invoice.amount, invoice.status, 'finance']);

  crmView = function () {
    const companies = loadedCompanies();
    const parts = addressParts();
    if (parts[1] === 'contacts' && !parts[2]) return listPage('contacts', companies);
    const route = C.route(parts, contacts, companies || []);
    if (route.kind === 'list') return listPage('pipeline', companies);
    if (route.kind === 'companies') return listPage('companies', companies);
    if (route.kind === 'company') {
      if (!companies) return notLoadedPage('crm/companies', 'All companies', 'Companies');
      return route.record && ['overview', 'activity'].includes(route.tab) ? companyPage(route.record, companies, route.tab) : notFound();
    }
    if (!has('contacts')) return notLoadedPage('crm/contacts', 'All contacts', 'Contacts');
    return route.record && ['overview', 'activity'].includes(route.tab) ? contactPage(route.record, companies, route.tab) : notFound();
  };

  /* A record's own address while its list did not load: that, rather than a
     record that is not there. */
  function notLoadedPage(parent, label, what) {
    return detailHeader(parent, label, 'This page cannot be shown yet.', `${what} did not load. They are tried again by themselves.`)
      + `<section class="panel">${empty(`${what} did not load`, 'The page opens here once they have.')}</section>`;
  }

  /* The pipeline (#crm), the companies (#crm/companies) or the contacts
     (#crm/contacts): each tab an address, with the figures above them all. */
  function listPage(tab, companies) {
    const query = queries.crm;
    const main = studioCurrency();
    const body = tab === 'contacts'
      ? contactTable(C.contactList(contacts, companies).filter(person => C.matchesQuery(person, query)))
      : companyView(tab, companies, query, main);
    return titlebar('Good relationships, in one place.', 'Keep the people, conversations, and work connected.',
      `<button class="btn" type="button" data-crm-new-company>${icon('plus')}New company</button>` + createButton('Add contact', 'crm'))
      + statStrip(stats(contacts, companies, main))
      + subnav([['crm', 'Pipeline', 'pipeline'], ['crm/companies', 'Companies', 'companies'], ['crm/contacts', 'Contacts', 'contacts']], tab)
      + `<div class="view-toolbar">${queryInput('crm', tab === 'contacts' ? 'Search contacts' : 'Search companies and their people')}</div>`
      + body;
  }

  /* The pipeline or the companies list: every company with its people and work. */
  function companyView(tab, companies, query, main) {
    if (!companies) return `<section class="panel">${empty('Companies did not load', 'They are tried again by themselves.')}</section>`;
    const entries = C.companyList(companies, sources(companies)).filter(entry => C.matchesQuery(entry, query));
    return tab === 'companies' ? companyTable(entries) : board(entries, main);
  }

  /* A column for each of the six stages, each company on it once, with what
     the column is worth in each currency. */
  function board(entries, main) {
    const columns = C.pipeline(entries).columns.map(column => {
      const id = `crm-stage-${esc(column.stage)}`;
      return `<section class="board-column" aria-labelledby="${id}"><div class="board-heading"><h2 id="${id}">${esc(column.heading)}</h2>${countTag(column.count)}</div>`
        + (column.totals.length ? `<p class="board-total">${esc(moneyLine(column.totals, main))}</p>` : '')
        + `<div class="board-cards">${column.companies.map(companyCard).join('') || '<div class="board-empty">No companies at this stage.</div>'}</div></section>`;
    });
    return `<div class="project-board stage-board crm-board">${columns.join('')}</div>`;
  }

  function companyCard(entry) {
    const people = entry.contacts;
    const who = people.length ? people[0].name + (people.length > 1 ? ` and ${people.length - 1} more` : '') : 'Nobody here yet';
    return `<a class="panel contact-card" href="#${esc(entry.route)}"><div class="card-top">${avatar(entry.name, null, 'contact-avatar')}${icon('chevron')}</div>`
      + `<h3>${esc(entry.name)}</h3><p>${esc(who)}</p>`
      + `<div class="contact-value"><strong>${esc(valueText(entry))}</strong><span>${entry.stage === 'client' ? 'Yearly value' : 'Deal value'}</span></div>`
      + (entry.domain ? `<small>${esc(entry.domain)}</small>` : '')
      + '</a>';
  }

  /* A list with its heading and count, drawing at most ROW_LIMIT rows and
     saying how many there are; with none, what to do instead of a table of
     headings. Rows open from their name's link, not from anywhere in the row as
     Finance's and the ticket queue's do: a contact's row holds a second link,
     to their company, and both lists work the same way. */
  function listPanel(title, headings, entries, row, [emptyTitle, emptyBody]) {
    const shown = entries.slice(0, ROW_LIMIT);
    const table = shown.length
      ? `<div class="table-wrap"><table class="module-table" aria-labelledby="${LIST_HEADING}"><thead><tr>${headings.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>`
        + `<tbody>${shown.map(row).join('')}</tbody></table></div>`
        + (entries.length > shown.length ? `<p class="quiet-text list-limit">Showing ${shown.length} of ${entries.length}. Search to narrow the list.</p>` : '')
      : empty(emptyTitle, emptyBody);
    return `<section class="panel"><div class="list-toolbar"><h2 id="${LIST_HEADING}">${esc(title)} ${countTag(entries.length)}</h2></div>${table}</section>`;
  }

  function companyTable(entries) {
    const ownerCell = ownerId => {
      const owner = ownerOf(ownerId);
      return owner.name ? esc(owner.name) : quiet(ownerId ? owner.words : NONE);
    };
    return listPanel('Companies', ['Company', 'Stage', 'People', 'Value', 'Owner'], entries, entry =>
      `<tr><td><div class="cell-main">${avatar(entry.name)}<div>${recordLink(entry.route, `<strong>${esc(entry.name)}</strong>`)}<small>${esc(entry.domain || entry.kindLabel)}</small></div></div></td>`
        + `<td>${stageCell(entry.stageLabel)}</td><td>${entry.contacts.length}</td><td>${esc(valueText(entry))}</td><td>${ownerCell(entry.ownerId)}</td></tr>`,
      queries.crm ? ['No companies found', 'Try another name, domain or person.'] : ['No companies yet', 'Add one with New company, or with its first contact or project.']);
  }

  function contactTable(people) {
    return listPanel('Contacts', ['Contact', 'Company', 'Stage', 'Title'], people, person =>
      `<tr><td><div class="cell-main">${avatar(person.name, person.initial)}<div>${recordLink(person.route, `<strong>${esc(person.name)}</strong>`)}<small>${esc(person.email)}</small></div></div></td>`
        + `<td>${person.company ? recordLink(person.company.route, esc(person.company.name)) : quiet(NONE)}</td>`
        + `<td>${stageCell(person.stageLabel)}</td><td>${person.title ? esc(person.title) : quiet(NONE)}</td></tr>`,
      queries.crm ? ['No contacts found', 'Try another name, address or company.'] : ['No contacts yet', 'Add a contact to start a relationship.']);
  }

  /* Meetings in the order they start, each saying when. */
  const meetingItems = list => [...list]
    .sort((a, b) => text(rowOf(a).starts_at).localeCompare(text(rowOf(b).starts_at)))
    .map(meeting => ['agenda/' + meeting.id, meeting.title, meeting.when || text(meeting.time), 'agenda']);

  /* A panel of meetings, or a line saying there are none: "No linked records
     yet" said nothing about meetings. */
  const meetingPanel = (title, items, none) => (items.length
    ? linkedPanel(title, items)
    : `<section class="panel content-panel related-panel"><h2>${title}</h2><p class="quiet-text">${esc(none)}</p></section>`);

  /* The start of today on the viewer's clock (financeDay()): meetings from then
     on are coming up, and the ones before it are the client's history. */
  function dayStart() {
    const start = new Date(financeDay() + 'T00:00:00');
    return isNaN(start.getTime()) ? null : start;
  }
  const PAST_SHOWN = 20;

  /* Past meetings' panel, drawn as linkedPanel draws one, with a heading that
     can take the keyboard: Try again is gone once the page is drawn again, so
     it hands the keyboard to the panel, and a repaint finds the heading again
     by its id. */
  const pastSection = body => `<section class="panel content-panel related-panel"><h2 id="past-meetings" tabindex="-1">Past meetings</h2>${body}</section>`;
  const meetingLinks = items => items.map(([route, label, meta, kind]) =>
    `<a href="#${esc(route)}" class="related-item"><span class="related-icon">${icon(kind)}</span><div><strong>${esc(label)}</strong><small>${esc(meta)}</small></div>${icon('chevron')}</a>`).join('');

  /* A client's past meetings, as the store has them for this page: loading;
     did not load, with a button that asks again; or the most recent first,
     leaving out one already listed as coming up because it is still under way. */
  /* A client's past meetings, as the store has them for this page: loading;
     did not load, with a button that asks again; or the most recent first,
     each filed under one company the way meetings coming up are (`fileUnder`,
     crm-model.js), leaving out one already listed as coming up because it is
     still under way. */
  function pastPanel(key, filter, shown, fileUnder) {
    const past = workspaceStore.pastMeetings(key, filter);
    if (past.state === 'loading') return pastSection('<p class="quiet-text" role="status">Loading past meetings…</p>');
    if (past.state === 'failed') {
      return pastSection('<p class="quiet-text" role="status">Past meetings did not load. They are tried again by themselves.</p>'
        + `<button type="button" class="btn" data-crm-past-retry="${esc(key)}">Try again</button>`);
    }
    const startOf = meeting => Date.parse(rowOf(meeting).starts_at) || 0;
    const items = [...fileUnder(past.meetings)]
      .filter(meeting => !shown.has(String(meeting.id)))
      .sort((a, b) => startOf(b) - startOf(a))
      .map(meeting => ['agenda/' + meeting.id, meeting.title, meeting.when || text(meeting.time), 'agenda']);
    return pastSection(items.length ? meetingLinks(items) : '<p class="quiet-text">No past meetings.</p>')
      + (past.more ? note('Older meetings are not listed.') : '')
      + (past.capped ? note('Only meetings filed under its first 50 projects and 50 people are listed.') : '');
  }

  /* A client's meetings: those loaded that are on today or later, in the order
     they start — one still under way included — then their past meetings,
     which the page asks the store for by `filter`. A meeting's last day is
     agenda-model.js's: an end is not part of it, and an all-day meeting is its
     date wherever the viewer is. `where` says how the meetings were found;
     `fileUnder` files past meetings as crm-model.js files the rest. */
  function meetingsPanels(key, events, filter, where, fileUnder) {
    const today = financeDay();
    const start = dayStart();
    const coming = events.filter(meeting => {
      const span = agendaModel.span(meeting);
      return !span || span.last >= today;
    });
    const shown = new Set(coming.map(meeting => String(meeting.id)));
    return meetingPanel('Coming up', meetingItems(coming), 'Nothing coming up.')
      + note(`Meetings from today on, ${where}.`)
      + (start ? pastPanel(key, { ...filter, limit: PAST_SHOWN, before: start.toISOString() }, shown, fileUnder) : '');
  }

  /* A company's page: its people, its projects and tickets, its meetings
     coming up and its past ones — filed under it, its projects or its people,
     by id — and the invoices sent to its people; its notes on a tab of their
     own. */
  function companyPage(record, companies, tab) {
    const c = C.shapeCompany(record);
    const work = C.companyWork(record, sources(companies));
    const sent = invoicesTo(work.contacts);
    const owner = ownerOf(c.ownerId);
    const id = esc(c.id);
    const notes = tab === 'activity';
    const actions = (c.stageLabel ? pill(c.stageLabel) : '')
      + `<button class="btn" type="button" data-crm-new-contact="${id}">${icon('plus')}Add person</button>`
      + `<button class="btn btn-primary" type="button" data-crm-edit-company="${id}">Edit company</button>`;
    /* Drawn only on the Overview tab: it asks for past meetings, which the notes tab does not show. */
    const overview = notes ? '' : `<section class="panel contact-summary">${avatar(c.name, null, 'contact-avatar')}<div><span class="eyebrow">${esc((c.kindLabel || 'Company').toUpperCase())}</span><h2>${esc(c.name)}</h2><p>${esc(c.domain || 'No domain on record')}</p></div></section>`
      + (c.notes ? `<section class="panel content-panel"><h2>About</h2><p class="body-copy">${esc(c.notes)}</p></section>` : '')
      + linkedPanel('People', work.contacts.map(person =>
        [person.route, person.name, [person.title, person.email].filter(Boolean).join(' · ') || 'Contact', 'crm']))
      + linkedPanel('Projects & support', [
        ...work.projects.map(project => ['projects/' + project.id, project.name, 'Project · ' + text(project.status), 'projects']),
        ...work.tickets.map(ticket => ['tickets/' + ticket.id, ticket.title, 'VYG-' + ticket.id + ' · ' + text(ticket.status), 'tickets'])
      ])
      + meetingsPanels(`company:${c.id}`, work.events,
        { companyId: c.id, projectIds: work.projects.map(project => project.id), contactIds: work.contacts.map(person => person.id) },
        'filed under the company, its projects or its people',
        meetings => C.companyWork(record, { ...sources(companies), events: meetings }).events)
      + (sent.shown
        ? linkedPanel('Invoices to its people', invoiceItems(sent.list || []))
          + note(sent.list ? 'Invoices are listed by the address they were sent to: one of its people\'s.' : 'Invoices did not load. They are tried again by themselves.')
        : '');
    return detailHeader('crm/companies', 'All companies', c.name, [c.kindLabel, c.domain].filter(Boolean).join(' · ') || 'Company', actions)
      + subnav([[`crm/companies/${id}`, 'Overview', 'overview'], [`crm/companies/${id}/activity`, 'Activity & notes', 'activity']], notes ? 'activity' : 'overview')
      + `<div class="record-layout"><div class="record-main">${notes ? notesPanel('companies', c.id) : overview}</div><aside class="record-aside">`
      + properties([
        ['Stage', c.stageLabel ? esc(c.stageLabel) : NONE],
        ['Kind', c.kindLabel ? esc(c.kindLabel) : NONE],
        ['Value', esc(valueText(c))],
        ['Owner', esc(owner.words)],
        ['Domain', c.domain ? `<span class="break-word">${esc(c.domain)}</span>` : NONE]
      ])
      + `<section class="panel content-panel"><h2>Relationship activity</h2><div class="relationship-counts"><span><strong>${work.contacts.length}</strong>People</span><span><strong>${work.projects.length}</strong>Projects</span><span><strong>${work.tickets.length}</strong>Tickets</span></div></section>`
      + '</aside></div>';
  }

  /* Under a contact's conversations: how their invoices are found, or why none
     can be — and nothing for staff, who are shown no invoices at all. */
  function invoiceNote(person, sent) {
    if (!sent.shown) return '';
    if (!sent.list) return note('Invoices did not load. They are tried again by themselves.');
    return note(person.email
      ? `Invoices are listed by the address they were sent to: ${person.email}.`
      : 'No email address on record, so no invoices can be matched to them.');
  }

  /* A contact's page: the projects they are on first, with their role, then
     the rest of their company's; the tickets filed under them; their meetings
     coming up and their past ones; the conversations with them, by id or
     address; and the invoices sent to them. */
  function contactPage(record, companies, tab) {
    const person = C.shapeContact(record, companies);
    const work = C.contactWork(record, sources(companies));
    const address = addressOf(person.email);
    const mailLoaded = has('mail');
    const threads = mailLoaded
      ? (mails || []).filter(m => m && (m.contactId === person.id || (address && addressOf(m.email) === address)))
      : [];
    const sent = invoicesTo([person]);
    const rolesLoaded = has('projectContacts');
    const owner = person.company ? ownerOf(person.company.ownerId) : null;
    const id = esc(person.id);
    const notes = tab === 'activity';
    /* Drawn only on the Overview tab: it asks for past meetings, which the notes tab does not show. */
    const overview = notes ? '' : `<section class="panel contact-summary">${avatar(person.name, person.initial, 'contact-avatar')}<div><span class="eyebrow">${esc((person.companyName || 'No company').toUpperCase())}</span><h2>${esc(person.name)}</h2><p>${esc([person.title, person.email].filter(Boolean).join(' · '))}</p></div>${person.stageLabel ? pill(person.stageLabel) : ''}</section>`
      + (person.notes ? `<section class="panel content-panel"><h2>Relationship brief</h2><p class="body-copy">${esc(person.notes)}</p></section>` : '')
      + linkedPanel('Projects & support', [
        ...work.projects.map(project => ['projects/' + project.id, project.name,
          work.roles[project.id] ? 'Their role: ' + projectsModel.roleLabel(work.roles[project.id]) : 'A project of ' + person.companyName, 'projects']),
        ...work.tickets.map(ticket => ['tickets/' + ticket.id, ticket.title, 'VYG-' + ticket.id + ' · ' + text(ticket.status), 'tickets'])
      ])
      + (rolesLoaded ? '' : note('Their roles on projects did not load, so only their company\'s projects are listed.'))
      + meetingsPanels(`contact:${person.id}`, work.events, { contactIds: [person.id] }, 'filed under them',
        meetings => C.contactWork(record, { ...sources(companies), events: meetings }).events)
      + linkedPanel(sent.shown ? 'Conversations & invoices' : 'Conversations', [
        ...threads.map(m => [mailModel.mailRoute({ mailbox: mailModel.ALL, folder: mailModel.folderForThread(m, 'inbox'), threadId: m.id }), m.subject, m.time, 'mail']),
        ...invoiceItems(sent.list || [])
      ])
      + (mailLoaded ? '' : note('Conversations did not load. They are tried again by themselves.'))
      + invoiceNote(person, sent);
    return detailHeader('crm/contacts', 'All contacts', person.name, person.companyName || 'No company',
      `<button class="btn" type="button" data-crm-edit-contact="${id}">Edit contact</button>`
      + (person.email ? `<button class="btn btn-primary" data-action="contact-email" data-id="${id}">${icon('mail')}Write email</button>` : ''))
      + subnav([[`crm/${id}`, 'Overview', 'overview'], [`crm/${id}/activity`, 'Activity & notes', 'activity']], notes ? 'activity' : 'overview')
      + `<div class="record-layout"><div class="record-main">${notes ? notesPanel('crm', person.id) : overview}</div><aside class="record-aside">`
      + properties([
        ['Company', person.company ? recordLink(person.company.route, esc(person.company.name)) : NONE],
        ['Stage', person.stageLabel ? esc(person.stageLabel) : NONE],
        ['Email', person.email ? `<span class="break-word">${esc(person.email)}</span>` : NONE],
        ['Phone', person.phone ? esc(person.phone) : NONE],
        ['Title', person.title ? esc(person.title) : NONE],
        ['Owner', owner ? esc(owner.words) : NONE]
      ])
      + `<section class="panel content-panel"><h2>Relationship activity</h2><div class="relationship-counts"><span><strong>${work.projects.length}</strong>Projects</span><span><strong>${work.tickets.length}</strong>Tickets</span><span><strong>${mailLoaded ? threads.length : NONE}</strong>Emails</span></div></section>`
      + '</aside></div>';
  }

  /* Past meetings that did not load, asked for again. The page is drawn again
     without the button, so the keyboard goes to the panel's heading. */
  document.addEventListener('click', e => {
    const retry = e.target.closest && e.target.closest('[data-crm-past-retry]');
    if (!retry) return;
    e.preventDefault();
    workspaceStore.retryPastMeetings(retry.dataset.crmPastRetry);
    if (typeof render === 'function') render();
    const heading = document.getElementById('past-meetings');
    if (heading && heading.focus) heading.focus();
  });

  return Object.freeze({ ROW_LIMIT, stats, invoicesFor, moneyLine });
})();
