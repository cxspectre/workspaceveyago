/* crm-ui.js — the CRM: its figures, the companies and contacts lists, and
   each company's and contact's page. The pipeline board itself is
   deals-board.js's (crm_deals, 0067), which this file calls for the pipeline
   tab, for a company's own deals, and for the deals the stat strip counts.

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
   The board itself then moved onto deals (0067) and out into deals-board.js,
   which loads after this file and is called from it.

   `crmUi` is what is worked out rather than drawn. The pages replace the one
   app.js drew, with the page helpers workspace.js defines, so this file loads
   after it. Tested in tests/crm-ui.test.mjs. */
const crmUi = (function () {
  'use strict';

  const C = crmModel;
  const D = dealsModel;
  const NONE = '—';
  const CODE = /^[A-Z]{3}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /* A long list draws this many rows, and says how many a search can narrow. */
  const ROW_LIMIT = 200;
  const LIST_HEADING = 'crm-list-heading';
  /* How long a keystroke waits before it redraws the list: long enough that
     a fast typist's word lands as one redraw, not one per letter, short
     enough that it still feels like typing rather than a delay. */
  const SEARCH_DEBOUNCE_MS = 200;

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

  /* ── Narrowing and ordering the companies list ─────────────────────────
     Search used to be the only way to make a long board or table shorter.
     Kept for the session, as the search box's own typed words are
     (queries.crm): opening a company and coming back does not reset it. */
  const boardFilters = { stage: '', kind: '', owner: '', sort: 'name' };
  const SORTS = Object.freeze([
    { value: 'name', label: 'Name' },
    { value: 'value', label: 'Value' },
    { value: 'stage', label: 'Pipeline stage' }
  ]);

  /* Entries kept only where every filter set matches: the stage or kind
     exactly, the owner by id — 'unowned' meaning no owner, never someone
     whose id happens to read that way (crm_companies.owner_id is a uuid). */
  function narrowedBy(entries, filters) {
    const f = filters || {};
    return entries.filter(entry => {
      if (f.stage && entry.stage !== f.stage) return false;
      if (f.kind && entry.kind !== f.kind) return false;
      if (f.owner === 'unowned') { if (entry.ownerId) return false; }
      else if (f.owner && entry.ownerId !== f.owner) return false;
      return true;
    });
  }

  /* Entries in the order a person picked, without changing the list given:
     by name; by value, most valuable first, nothing worth last; or by where
     each is in the pipeline (crmModel.STAGES' own order). Sorting first is
     what leaves each board column, and each page of the table, in the same
     order — pipeline() only groups the list handed to it. */
  function sortedBy(entries, sort) {
    const list = [...entries];
    if (sort === 'value') {
      return list.sort((a, b) => (b.amount === null ? -Infinity : b.amount) - (a.amount === null ? -Infinity : a.amount)
        || a.name.localeCompare(b.name));
    }
    if (sort === 'stage') {
      const order = C.STAGES.map(s => s.value);
      return list.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || a.name.localeCompare(b.name));
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /* Whether anything is narrowing the list right now — a search, or a
     filter — so an empty result reads as "nothing matches" rather than
     "the CRM has nothing in it". */
  const isNarrowed = query => Boolean(text(query).trim() || boardFilters.stage || boardFilters.kind || boardFilters.owner);

  /* The filter and sort controls above the pipeline and the companies table.
     Owner choices come from the team actually loaded; without it, only the
     stage, kind and sort controls are offered — a select with one option
     nobody could pick from is worse than one left out. */
  function filterBar() {
    const stageOptions = C.STAGES.map(s => `<option value="${esc(s.value)}"${boardFilters.stage === s.value ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    const kindOptions = C.KINDS.map(k => `<option value="${esc(k.value)}"${boardFilters.kind === k.value ? ' selected' : ''}>${esc(k.label)}</option>`).join('');
    const sortOptions = SORTS.map(s => `<option value="${esc(s.value)}"${boardFilters.sort === s.value ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    const ownerField = has('team')
      ? (() => {
        const owners = [...team].sort((a, b) => a.name.localeCompare(b.name));
        const ownerOptions = owners.map(m => `<option value="${esc(m.id)}"${boardFilters.owner === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')
          + `<option value="unowned"${boardFilters.owner === 'unowned' ? ' selected' : ''}>No owner</option>`;
        return `<label class="filter-field">Owner<select data-crm-filter="owner"><option value="">Any owner</option>${ownerOptions}</select></label>`;
      })() : '';
    const cleared = boardFilters.stage || boardFilters.kind || boardFilters.owner;
    return `<div class="filter-bar" role="group" aria-label="Narrow and order the list">`
      + `<label class="filter-field">Stage<select data-crm-filter="stage"><option value="">Any stage</option>${stageOptions}</select></label>`
      + `<label class="filter-field">Kind<select data-crm-filter="kind"><option value="">Any kind</option>${kindOptions}</select></label>`
      + ownerField
      + `<label class="filter-field">Sort by<select data-crm-sort>${sortOptions}</select></label>`
      + (cleared ? `<button type="button" class="text-btn" data-crm-clear-filters>Clear filters</button>` : '')
      + `</div>`;
  }

  /* The strip at the top of the CRM, as statStrip() takes it: [label, value,
     caption] for each figure. `contacts`, `companies` and `deals` are the
     lists as loaded — null when one did not load, and then what is worked out
     from it is a dash, never a zero: a studio that has not answered yet is not
     the same as one with nobody in it. `main` is the studio's currency, when
     it is known.

     Pipeline value is the DEALS still to be won (0067), not the companies:
     before crm_deals existed a client with two pieces of work in flight could
     hold only one value between them, so this figure counted one deal per
     company however many it really had, and counted nothing at all for the
     second. Active clients stays a count of companies — a client is a
     relationship, which is still what crm_companies.stage records. */
  function stats(contacts, companies, main, deals) {
    const people = Array.isArray(contacts)
      ? ['Contacts', contacts.length, 'People in your network']
      : ['Contacts', NONE, 'Contacts did not load'];
    const open = Array.isArray(deals) ? D.pipeline(deals).open : null;
    const value = open
      ? ['Pipeline value', open.totals.length ? moneyLine(open.totals, main) : NONE,
        open.count ? `${plural(open.count, 'deal', 'deals')} still to win` : 'No open deals']
      : ['Pipeline value', NONE, 'Deals did not load'];
    if (!Array.isArray(companies)) {
      return Object.freeze([people, value, ['Active clients', NONE, 'Companies did not load']]);
    }
    const clients = C.pipeline(companies).columns.find(column => column.stage === 'client') || { count: 0 };
    return Object.freeze([people, value, ['Active clients', clients.count, 'Companies you work with']]);
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
  /* The contacts as loaded, or null when they did not load: `contacts` is a
     shared array that starts empty and stays that way until the store fills
     it (data/store.js), so reading it before then read as "no contacts" —
     "0 Contacts" in the strip, "No contacts yet" on the list — on the very
     first paint, before sign-in has even asked for anything. */
  const loadedContacts = () => (has('contacts') ? contacts : null);
  /* The studio's currency, as the Overview has it (0041), when it is known. */
  const studioCurrency = () => {
    const overview = stored().overview;
    return overview && overview.revenue_currency ? text(overview.revenue_currency).trim().toUpperCase() : null;
  };
  /* An id written in capitals is the same record: the database writes uuids in
     lower case, and the breadcrumb names the record either way. */
  const addressParts = () => routeParts.map(part => (typeof part === 'string' && UUID.test(part) ? part.toLowerCase() : part));

  /* ── Website enquiries ─────────────────────────────────────────────────
     Leads from the public "Get a quote" form (0019): readable by owners and
     admins only (manager reads enquiries) — staff get none back, not a
     failure, so the tab is hidden from them entirely rather than shown as
     an empty inbox nobody can explain. Unlike the workspace's other lists,
     these are asked for on demand, here, rather than with the rest of the
     workspace (data/store.js): almost no session ever opens this tab, and
     nobody but a manager can read the answer anyway. */
  let enquiriesState = { status: 'idle', list: null };

  function loadEnquiries() {
    if (enquiriesState.status === 'loading') return;
    enquiriesState = { status: 'loading', list: null };
    const done = () => { if (typeof repaintKeepingFocus === 'function') repaintKeepingFocus(); else if (typeof render === 'function') render(); };
    Promise.resolve()
      .then(() => window.workspaceData.enquiries())
      .then(list => { enquiriesState = { status: 'ready', list }; done(); },
        err => {
          console.error('[workspace] enquiries did not load:', err);
          enquiriesState = { status: 'failed', list: null };
          done();
        });
  }

  /* An enquiry already promoted (crm_contacts.enquiry_id, 0021) is linked to
     the contact it became rather than offered a second time. */
  function promotedContacts() {
    const found = new Map();
    (loadedContacts() || []).forEach(c => {
      const eid = c.row && c.row.enquiry_id;
      if (eid && !found.has(eid)) found.set(eid, c.id);
    });
    return found;
  }

  function enquiryRow(promoted) {
    return e => {
      const contactId = promoted.get(e.id);
      const action = contactId
        ? `<a class="text-btn" href="#crm/${esc(contactId)}">Already in the CRM</a>`
        : `<button class="btn" type="button" data-crm-promote="${esc(e.id)}">Promote</button>`;
      return `<tr><td><div class="cell-main"><div><strong>${esc(e.name || 'No name given')}</strong>${e.email ? `<small>${esc(e.email)}</small>` : ''}</div></div></td>`
        + `<td>${e.business ? esc(e.business) : quiet(NONE)}</td>`
        + `<td class="break-word">${e.message ? esc(e.message) : quiet(NONE)}</td>`
        + `<td>${esc(e.when)}</td><td>${action}</td></tr>`;
    };
  }

  function enquiriesBody() {
    if (enquiriesState.status === 'idle') loadEnquiries();
    if (enquiriesState.status === 'idle' || enquiriesState.status === 'loading') {
      return `<section class="panel">${empty('Loading enquiries…', 'They are read from the public site’s "Get a quote" form.')}</section>`;
    }
    if (enquiriesState.status === 'failed') {
      return `<section class="panel">${empty('Enquiries did not load', 'They are tried again by themselves.')}<button type="button" class="btn" data-crm-enquiries-retry>Try again</button></section>`;
    }
    return listPanel('Enquiries', ['From', 'Business', 'Message', 'Received', ''], enquiriesState.list || [],
      enquiryRow(promotedContacts()),
      ['No enquiries yet', 'New "Get a quote" submissions from the site will show up here.']);
  }

  /* Owners and admins only, matching the RLS that already limits reading
     website_enquiries to them (0019) — this tab does not change who may
     read enquiries, only gives managers a way to act on them without
     leaving the workspace for the site admin. */
  function enquiriesPage() {
    const manager = isManagerNow();
    return titlebar('Website enquiries.', 'Leads from the public "Get a quote" form, ready to bring into the CRM.')
      + subnav(crmTabs(), 'enquiries')
      + (manager ? enquiriesBody()
        : `<section class="panel">${empty('Owners and admins only', 'Website enquiries are visible to owners and admins, the same as in the site admin.')}</section>`);
  }

  /* Enquiries is offered only to whoever could ever see one — the same
     reasoning nav() already applies to Finance. */
  const crmTabs = () => [
    ['crm', 'Pipeline', 'pipeline'], ['crm/companies', 'Companies', 'companies'], ['crm/contacts', 'Contacts', 'contacts'],
    ...(isManagerNow() ? [['crm/enquiries', 'Enquiries', 'enquiries']] : [])
  ];

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
    if (parts[1] === 'enquiries' && !parts[2]) return enquiriesPage();
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
  const SEARCH_LABEL = Object.freeze({
    pipeline: 'Search deals and their companies',
    companies: 'Search companies and their people',
    contacts: 'Search contacts'
  });

  function listPage(tab, companies) {
    const query = queries.crm;
    const main = studioCurrency();
    const people = loadedContacts();
    const body = tab === 'contacts'
      ? (people
        ? contactTable(C.contactList(people, companies).filter(person => C.matchesQuery(person, query)))
        : `<section class="panel">${empty('Contacts did not load', 'They are tried again by themselves.')}</section>`)
      : tab === 'companies' ? companyView(companies, query)
        : dealsBoardUi.view(companies, query, main);
    /* "New deal" only where a deal can be added: it needs a company to pick
       from, so it is offered once the companies have arrived. */
    const newDeal = companies && companies.length
      ? `<button class="btn" type="button" data-deal-new>${icon('plus')}New deal</button>` : '';
    return titlebar('Good relationships, in one place.', 'Keep the people, conversations, and work connected.',
      newDeal + `<button class="btn" type="button" data-crm-new-company>${icon('plus')}New company</button>` + createButton('Add contact', 'crm'))
      + statStrip(stats(people, companies, main, dealsBoardUi.shaped(companies)))
      + subnav(crmTabs(), tab)
      + `<div class="view-toolbar">${queryInput('crm', SEARCH_LABEL[tab] || SEARCH_LABEL.companies)}</div>`
      + body;
  }

  /* The companies list: every company with its people and work, narrowed by
     search and by the filter bar, then in the order picked. */
  function companyView(companies, query) {
    if (!companies) return `<section class="panel">${empty('Companies did not load', 'They are tried again by themselves.')}</section>`;
    const matching = C.companyList(companies, sources(companies)).filter(entry => C.matchesQuery(entry, query));
    const entries = sortedBy(narrowedBy(matching, boardFilters), boardFilters.sort);
    return filterBar() + companyTable(entries, isNarrowed(query));
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

  function companyTable(entries, narrowed) {
    const ownerCell = ownerId => {
      const owner = ownerOf(ownerId);
      return owner.name ? esc(owner.name) : quiet(ownerId ? owner.words : NONE);
    };
    return listPanel('Companies', ['Company', 'Stage', 'People', 'Value', 'Owner'], entries, entry =>
      `<tr><td><div class="cell-main">${avatar(entry.name)}<div>${recordLink(entry.route, `<strong>${esc(entry.name)}</strong>`)}<small>${esc(entry.domain || entry.kindLabel)}</small></div></div></td>`
        + `<td>${stageCell(entry.stageLabel)}</td><td>${entry.contacts.length}</td><td>${esc(valueText(entry))}</td><td>${ownerCell(entry.ownerId)}</td></tr>`,
      narrowed ? ['No companies found', 'Try another search, or clear a filter.'] : ['No companies yet', 'Add one with New company, or with its first contact or project.']);
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

  /* ── A record's linked mail ─────────────────────────────────────────────
     Mail links to the CRM by itself, so far (0025's own address match;
     0059's domain fallback) — there is still no "link this thread" or "add
     sender to the CRM" affordance, and old threads are never back-filled;
     both are bigger, separate pieces, left undone here. What this adds is
     narrower: mail_threads already carries contact_id/company_id, and
     nothing on either page read it straight — a contact's own "Conversations"
     panel only ever knew what was already loaded for the Mail view, which
     keeps a working window of a few hundred a folder (queries.mailThreads),
     not everything ever linked. queries.mailThreadsFor(filter) asks
     mail_threads directly, by contact_id or company_id; this asks for it once
     a page opens and keeps it by `key` ('contact:<id>' / 'company:<id>'), the
     way a client's past meetings are kept, but locally — this is the only
     place that asks, so there is nothing here for data/store.js to share. */
  const linkedMailState = new Map();

  function askLinkedMail(key, filter) {
    const cached = linkedMailState.get(key);
    if (cached) return cached;
    const loading = { status: 'loading', threads: null, more: false };
    linkedMailState.set(key, loading);
    const done = () => { if (typeof repaintKeepingFocus === 'function') repaintKeepingFocus(); else if (typeof render === 'function') render(); };
    Promise.resolve()
      .then(() => window.workspaceData.mailThreadsFor(filter))
      .then(result => { linkedMailState.set(key, { status: 'ready', threads: result.threads || [], more: Boolean(result.more) }); done(); },
        err => {
          console.error('[workspace] linked mail did not load:', err);
          linkedMailState.set(key, { status: 'failed', threads: null, more: false });
          done();
        });
    return loading;
  }

  const linkedMailSection = body => `<section class="panel content-panel related-panel"><h2 id="linked-mail" tabindex="-1">Linked mail</h2>${body}</section>`;
  const mailThreadItems = threads => threads.map(t =>
    [mailModel.mailRoute({ mailbox: mailModel.ALL, folder: mailModel.folderForThread(t, 'inbox'), threadId: t.id }), t.subject, t.time, 'mail']);

  /* `exclude` leaves out a thread already listed elsewhere on the page — a
     contact's own "Conversations & invoices" panel, built from whatever mail
     is already loaded — so nothing linked shows twice. A company's page has
     nothing else to exclude against, and passes none. */
  function linkedMailPanel(key, filter, exclude) {
    const asked = askLinkedMail(key, filter);
    if (asked.status === 'loading') return linkedMailSection('<p class="quiet-text" role="status">Loading linked mail…</p>');
    if (asked.status === 'failed') {
      return linkedMailSection('<p class="quiet-text" role="status">Linked mail did not load. They are tried again by themselves.</p>'
        + `<button type="button" class="btn" data-crm-mail-retry="${esc(key)}">Try again</button>`);
    }
    const shown = exclude && exclude.size ? asked.threads.filter(t => !exclude.has(String(t.id))) : asked.threads;
    /* Empty two different ways: genuinely nothing linked, or everything found
       is already listed above (a contact's own "Conversations" panel) — the
       first is not true of the second, and saying it anyway would read as
       this contact having no mail at all when they plainly do. */
    const empty = asked.threads.length ? 'Already listed above.' : 'No linked mail yet.';
    return linkedMailSection(shown.length ? meetingLinks(mailThreadItems(shown)) : `<p class="quiet-text">${esc(empty)}</p>`)
      + (asked.more ? note('Older mail is not listed.') : '');
  }

  /* Linked mail that did not load, asked for again — the page redrawn without
     the button, so the keyboard goes to the panel's own heading, the way a
     client's past meetings already do this. */
  document.addEventListener('click', e => {
    const retry = e.target.closest && e.target.closest('[data-crm-mail-retry]');
    if (!retry) return;
    e.preventDefault();
    linkedMailState.delete(retry.dataset.crmMailRetry);
    if (typeof render === 'function') render();
    const heading = document.getElementById('linked-mail');
    if (heading && heading.focus) heading.focus();
  });

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
      + `<button class="btn" type="button" data-deal-new="${id}">${icon('plus')}Add deal</button>`
      + `<button class="btn" type="button" data-crm-new-contact="${id}">${icon('plus')}Add person</button>`
      + (isManagerNow() ? `<button class="btn" type="button" data-crm-merge-company="${id}">Merge…</button>` : '')
      + (isManagerNow() ? `<button class="btn" type="button" data-crm-delete-company="${id}">Remove company</button>` : '')
      + `<button class="btn btn-primary" type="button" data-crm-edit-company="${id}">Edit company</button>`;
    /* Drawn only on the Overview tab: it asks for past meetings, which the notes tab does not show. */
    const overview = notes ? '' : `<section class="panel contact-summary">${avatar(c.name, null, 'contact-avatar')}<div><span class="eyebrow">${esc((c.kindLabel || 'Company').toUpperCase())}</span><h2>${esc(c.name)}</h2><p>${esc(c.domain || 'No domain on record')}</p></div></section>`
      + (c.notes ? `<section class="panel content-panel"><h2>About</h2><p class="body-copy">${esc(c.notes)}</p></section>` : '')
      + linkedPanel('People', work.contacts.map(person =>
        [person.route, person.name,
          [person.row && person.row.is_primary ? 'Primary contact' : null, person.title, person.email].filter(Boolean).join(' · ') || 'Contact', 'crm']))
      + dealsBoardUi.companyPanel(c.id, companies)
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
        : '')
      + linkedMailPanel(`company:${c.id}`, { companyId: c.id });
    return detailHeader('crm/companies', 'All companies', c.name, [c.kindLabel, c.domain].filter(Boolean).join(' · ') || 'Company', actions)
      + subnav([[`crm/companies/${id}`, 'Overview', 'overview'], [`crm/companies/${id}/activity`, 'Activity & notes', 'activity']], notes ? 'activity' : 'overview')
      + `<div class="record-layout"><div class="record-main">${notes ? notesPanel('companies', c.id) : overview}</div><aside class="record-aside">`
      + properties([
        ['Stage', c.stageLabel ? esc(c.stageLabel) : NONE],
        ...(record.clientNumber != null ? [['Client No.', esc(String(record.clientNumber))]] : []),
        ['Kind', c.kindLabel ? esc(c.kindLabel) : NONE],
        ['Value', esc(valueText(c))],
        ['Currency', esc(c.currency)],
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
      + invoiceNote(person, sent)
      + linkedMailPanel(`contact:${person.id}`, { contactId: person.id }, new Set(threads.map(m => String(m.id))));
    return detailHeader('crm/contacts', 'All contacts', person.name, person.companyName || 'No company',
      `<button class="btn" type="button" data-crm-edit-contact="${id}">Edit contact</button>`
      + (isManagerNow() ? `<button class="btn" type="button" data-crm-merge-contact="${id}">Merge…</button>` : '')
      + (isManagerNow() ? `<button class="btn" type="button" data-crm-delete-contact="${id}">Remove contact</button>` : '')
      + (person.email ? `<button class="btn btn-primary" data-action="contact-email" data-id="${id}">${icon('mail')}Write email</button>` : ''))
      + subnav([[`crm/${id}`, 'Overview', 'overview'], [`crm/${id}/activity`, 'Activity & notes', 'activity']], notes ? 'activity' : 'overview')
      + `<div class="record-layout"><div class="record-main">${notes ? notesPanel('crm', person.id) : overview}</div><aside class="record-aside">`
      + properties([
        ['Company', person.company ? recordLink(person.company.route, esc(person.company.name)) : NONE],
        ['Stage', person.stageLabel ? esc(person.stageLabel) : NONE],
        ['Email', person.email ? `<span class="break-word">${esc(person.email)}</span>` : NONE],
        ['Phone', person.phone ? esc(person.phone) : NONE],
        ['Title', person.title ? esc(person.title) : NONE],
        ['Primary contact', person.row && person.row.is_primary ? 'Yes' : NONE],
        ['Source', person.row && person.row.enquiry_id ? 'A website enquiry' : NONE],
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

  /* Enquiries that did not load, asked for again. */
  document.addEventListener('click', e => {
    const retry = e.target.closest && e.target.closest('[data-crm-enquiries-retry]');
    if (!retry) return;
    e.preventDefault();
    loadEnquiries();
  });

  /* Turning an enquiry into a company and contact (promote_enquiry_to_crm,
     0021), using the RPC and RLS boundary as they already are — this button
     only exists where the enquiries list itself is already manager-only. */
  document.addEventListener('click', e => {
    const button = e.target.closest && e.target.closest('[data-crm-promote]');
    if (!button) return;
    e.preventDefault();
    if (button.disabled) return;
    if (!window.workspaceStore || !workspaceStore.state.loaded) {
      if (typeof toast === 'function') toast('Not yet: the workspace is still loading.');
      return;
    }
    const enquiryId = button.dataset.crmPromote;
    button.disabled = true;
    workspaceStore.after(workspaceActions.promoteEnquiry(enquiryId), { only: ['contacts', 'companies'] })
      .then(contactId => {
        if (typeof toast === 'function') toast('Added to the CRM.');
        if (typeof navigate === 'function' && contactId) navigate(`crm/${contactId}`);
      })
      .catch(() => {})
      .then(() => { button.disabled = false; });
  });

  const repaint = () => (typeof repaintKeepingFocus === 'function' ? repaintKeepingFocus() : (typeof render === 'function' && render()));

  /* Picking a stage, kind, owner or sort order: kept for the session
     (boardFilters), same as the search box's own typed words, and the page
     is drawn again keeping the keyboard on the control just used. */
  document.addEventListener('change', e => {
    const filter = e.target.closest && e.target.closest('[data-crm-filter]');
    const sort = e.target.closest && e.target.closest('[data-crm-sort]');
    if (!filter && !sort) return;
    if (filter) boardFilters[filter.dataset.crmFilter] = filter.value;
    else boardFilters.sort = sort.value;
    repaint();
  });

  document.addEventListener('click', e => {
    const clear = e.target.closest && e.target.closest('[data-crm-clear-filters]');
    if (!clear) return;
    e.preventDefault();
    boardFilters.stage = '';
    boardFilters.kind = '';
    boardFilters.owner = '';
    repaint();
  });

  /* The shared search box (workspace.js) redraws the whole page on every
     keystroke — fine for a short list, felt like typing through mud on a
     CRM with hundreds of rows. Registered in the CAPTURE phase, which runs
     ahead of that bubble-phase listener regardless of which file loads
     first (as writes.js's own capture-phase listeners already rely on), so
     stopping it here also stops the immediate redraw for this one box —
     every other view's search is untouched. window.setTimeout/clearTimeout,
     not the bare globals, so a test can stand in for the clock. */
  let searchTimer = null;
  document.addEventListener('input', e => {
    if (!(e.target.matches && e.target.matches('[data-query="crm"]'))) return;
    e.stopImmediatePropagation();
    const input = e.target;
    const value = input.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      queries.crm = value;
      if (typeof redrawPreservingFocus === 'function') redrawPreservingFocus(input);
    }, SEARCH_DEBOUNCE_MS);
  }, true);

  return Object.freeze({ ROW_LIMIT, stats, invoicesFor, moneyLine });
})();
