/* overview-model.js — the Overview's logic, with no page in it.
 *
 * What the tiles count, which tasks are "yours", which projects are active,
 * where an activity entry leads, what the breadcrumb says, and who sees
 * Finance. The Overview used to answer these with whatever was nearest: the
 * first three tasks from any project, whoever they were for; the first three
 * projects, paused or not; "Welcome back, Cassian" for everyone; "On track"
 * whatever the dates said. Kept apart from app.js and workspace.js so it can be
 * tested without a browser — tests/overview.test.mjs.
 */
const overviewModel = (function () {
  'use strict';

  /* The ticket statuses that still need someone: the same three
     workspace_overview() (0029) counts. Closed is not open. */
  const OPEN_TICKETS = Object.freeze(['Open', 'In progress', 'Waiting']);
  const URGENT = Object.freeze(['High', 'Urgent']);
  const FOCUS_LIMIT = 3;
  const ROW_LIMIT = 3;
  /* Money is for owners and admins (0005); the menu should not offer a page
     whose every figure the database will refuse. */
  const MANAGERS_ONLY = Object.freeze(['finance']);
  /* Each page's named sections, and only that page's: "#tickets/studio" is not
     the Studio. */
  const SECTIONS = Object.freeze({
    overview: Object.freeze({ activity: 'Recent activity' }),
    finance: Object.freeze({ invoices: 'Invoices' }),
    company: Object.freeze({ studio: 'Studio', preferences: 'Preferences' }),
    crm: Object.freeze({ companies: 'Companies', contacts: 'Contacts' })
  });
  /* What a record on each page is called, and the part of the store its list is. */
  const RECORDS = Object.freeze({
    tickets: Object.freeze({ part: 'tickets', name: 'Ticket' }),
    projects: Object.freeze({ part: 'projects', name: 'Project' }),
    crm: Object.freeze({ part: 'contacts', name: 'Contact' }),
    agenda: Object.freeze({ part: 'events', name: 'Event' }),
    finance: Object.freeze({ part: 'invoices', name: 'Invoice' })
  });
  const PEOPLE = Object.freeze({ part: 'team', name: 'Person' });
  /* Own keys only: a route segment such as "constructor" is not a name. */
  const own = (object, key) => (object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

  const pad = n => String(n).padStart(2, '0');
  const clock = date => pad(date.getHours()) + ':' + pad(date.getMinutes());

  const isOpenTicket = ticket => Boolean(ticket) && OPEN_TICKETS.includes(ticket.status);

  /* The tile figures. workspace_overview() when it answered, counted locally
     when it did not — and null, shown as a dash, for anything that cannot be
     counted: a part that never loaded is not zero, and "your open tasks" is
     not everyone's. Today's events, once today's week loaded, are the
     agenda's own (agendaModel.eventsOn): every event on today however long it
     runs, placed by its date — so the tile agrees with the agenda beside it.
     Only until then is the database's events_today used, which counts the
     events that start today: one carried over from yesterday is not in it. */
  function tileCounts(facts) {
    const f = facts || {};
    const o = f.overview || null;
    const count = (list, pick) => (Array.isArray(list) ? list.filter(pick).length : null);
    const figure = (key, local) => (o && o[key] != null ? Number(o[key]) : local);
    const active = f.isActive || (() => false);
    return Object.freeze({
      ticketsOpen: figure('tickets_open', count(f.tickets, isOpenTicket)),
      ticketsHigh: figure('tickets_high', count(f.tickets, t => isOpenTicket(t) && URGENT.includes(t.priority))),
      projectsActive: figure('projects_active', count(f.projects, active)),
      tasksMine: figure('tasks_mine', null),
      eventsToday: Array.isArray(f.eventsToday) ? f.eventsToday.length : figure('events_today', null)
    });
  }

  /* The money on the Overview, in its own currency (workspace_overview(),
     0041): the main currency's figure, the currencies that were not added in,
     and the trend against last month up to the same day. A database from
     before 0041 has no currencies, and was all USD. null when the database
     gave this person no money figures. */
  function revenueFigures(overview) {
    const o = overview || null;
    if (!o || o.revenue_month == null) return null;
    const currency = o.revenue_currency || 'USD';
    const month = Number(o.revenue_month) || 0;
    const previous = Number(o.revenue_prev_month) || 0;
    const others = (list, main, counts) => Object.freeze((Array.isArray(list) ? list : [])
      .filter(e => e && e.currency && e.currency !== main && Number(e[counts]) > 0)
      .map(e => e.currency));
    const inv = o.invoices_outstanding || {};
    const invoiceCurrency = inv.currency || currency;
    return Object.freeze({
      currency,
      month,
      previous,
      previousThrough: o.revenue_prev_through || null,
      /* No income last month is no comparison: "up 100%" from nothing reads
         as a fact. One decimal, as the tile shows it. */
      trend: previous > 0 ? Math.round(((month - previous) / previous) * 1000) / 10 : null,
      otherCurrencies: others(o.revenue_by_currency, currency, 'month'),
      invoices: Object.freeze({
        count: Number(inv.count) || 0,
        amount: Number(inv.amount) || 0,
        currency: invoiceCurrency,
        dueNext: inv.due_next || null,
        /* By invoices, not amounts: an invoice for nothing is still owed. */
        otherCurrencies: others(inv.by_currency, invoiceCurrency, 'count')
      })
    });
  }

  /* The due date on the Overview's invoice tile, in the currency the tile
     shows. With the invoices loaded, what Finance says of them (owed: that
     currency's entry from financeModel.awaitingPayment): how many are late, and
     the next due date still ahead. Without them, the database's soonest due date
     (due_next), which is late once it has passed — never "Due" a day gone by.
     A date is a calendar day, written in UTC as finance-model.js writes one. */
  const tileDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value == null ? '' : value));
  const dayLabel = day => tileDay.format(new Date(day + 'T00:00:00Z'));
  function invoiceDueNote(dueNext, owed, today) {
    if (owed) {
      return [owed.overdue ? owed.overdue + ' overdue' : '', isDay(owed.nextDue) ? 'Due ' + dayLabel(owed.nextDue) : '']
        .filter(Boolean).join(' · ');
    }
    if (!isDay(dueNext)) return '';
    return (isDay(today) && dueNext < today ? 'Overdue since ' : 'Due ') + dayLabel(dueNext);
  }

  const formatCount = n => (n == null ? '—' : String(n));
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const badge = n => (!n || n < 0 ? '' : n > 99 ? '99+' : String(n));

  /* "Updated at 14:02" rather than "5 min ago": the page is not redrawn every
     minute, and a relative time would go on saying five minutes for an hour. */
  const updatedLabel = loadedAt => (loadedAt == null ? '' : 'Updated at ' + clock(new Date(loadedAt)));

  function greeting(employee) {
    const first = String((employee && employee.full_name) || '').trim().split(/\s+/)[0];
    return (first ? 'Welcome back, ' + first + '. ' : '') + 'Here’s your day at Veyago.';
  }

  /* Dated before undated, the soonest date first. */
  function byDue(a, b) {
    if (a.dueOn && b.dueOn) return a.dueOn === b.dueOn ? 0 : (a.dueOn < b.dueOn ? -1 : 1);
    if (a.dueOn || b.dueOn) return a.dueOn ? -1 : 1;
    return 0;
  }

  /* The signed-in person's unticked tasks on work that is still moving. */
  function focusTasks(projects, meId, options) {
    const o = options || {};
    if (!meId) return Object.freeze([]);
    const active = o.isActive || (() => true);
    const items = [];
    (projects || []).filter(active).forEach(p => {
      (p.tasks || []).forEach((title, index) => {
        if ((p.taskAssignees || [])[index] !== meId) return;
        if ((p.checked || []).includes(index)) return;
        const dueOn = (p.taskDueOn || [])[index] || null;
        items.push(Object.freeze({
          projectId: p.id,
          projectName: p.name,
          title,
          index,
          taskId: (p.taskIds || [])[index] || null,
          dueOn,
          due: (p.taskDue || [])[index] || '',
          overdue: Boolean(dueOn && o.today && dueOn < o.today)
        }));
      });
    });
    items.sort((a, b) => byDue(a, b) || String(a.projectName).localeCompare(String(b.projectName)) || a.index - b.index);
    return Object.freeze(items.slice(0, o.limit || FOCUS_LIMIT));
  }

  function activeProjects(projects, isActive, limit) {
    const active = isActive || (() => true);
    return Object.freeze((projects || []).filter(active)
      .sort((a, b) => byDue(a, b) || String(a.name).localeCompare(String(b.name)))
      .slice(0, limit || ROW_LIMIT));
  }

  /* Due before today and still moving. Due today is not late yet. */
  function overdueProjects(projects, isActive, today) {
    const active = isActive || (() => true);
    return (projects || []).filter(p => active(p) && p.dueOn && today && p.dueOn < today).length;
  }

  const projectsFoot = n => (n ? n + ' overdue' : 'Nothing overdue');

  /* Where an activity entry leads: its record, found by id in what is loaded
     now. Something no longer loaded has no link, rather than a link to
     whatever took its place. */
  function routeFor(entry, records) {
    const r = records || {};
    const id = entry.entityId;
    if (!id) return null;
    if (entry.entityType === 'ticket') {
      const ticket = (r.tickets || []).find(t => t.uuid === id);
      return ticket ? 'tickets/' + ticket.id : null;
    }
    if (entry.entityType === 'project') {
      return (r.projects || []).some(p => p.id === id) ? 'projects/' + id : null;
    }
    /* By uuid, like projects: a place in the list changes whenever anyone adds
       a contact or an invoice, and the link would open someone else. */
    if (entry.entityType === 'contact') {
      return (r.contacts || []).some(c => c.id === id) ? 'crm/' + id : null;
    }
    if (entry.entityType === 'company') {
      return (r.companies || []).some(co => co.id === id) ? 'crm/companies/' + id : null;
    }
    if (entry.entityType === 'invoice') {
      return (r.invoices || []).some(v => v.uuid === id) ? 'finance/' + id : null;
    }
    return null;
  }

  function activityItem(entry, records) {
    const e = entry || {};
    const at = e.createdAt ? new Date(e.createdAt) : null;
    const time = at && !Number.isNaN(at.getTime()) ? clock(at) : '';
    return Object.freeze({
      id: e.id,
      who: e.who || 'Veyago',
      initial: e.initial || 'V',
      text: e.text || '',
      when: [e.when, time].filter(Boolean).join(' · '),
      route: routeFor(e, records)
    });
  }

  /* "Projects / Northline site", with "Projects" as the way back. A record
     page used to say "Details", whatever it was. */
  function crumb(page, parts, data) {
    const d = data || {};
    const list = own(d.labels, page) || page;
    const key = (parts || [])[1];
    if (key === undefined || key === '') return Object.freeze({ parent: null, current: list });
    const parent = Object.freeze({ route: page, label: list });
    const named = name => Object.freeze({ parent, current: name || 'Not found' });
    if (page === 'mail') return named(d.mailFolder || 'Inbox');
    /* By id, whatever case the address has it in: a uuid pasted in capitals is
       the same record, and read as another it named nothing. */
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    /* A company's page is under the companies list: "Companies / Northline". */
    if (page === 'crm' && key === 'companies' && parts[2]) {
      const companies = Object.freeze({ route: 'crm/companies', label: SECTIONS.crm.companies });
      const closed = d.open === false || (typeof d.has === 'function' && !d.has('companies'));
      const found = closed ? null : (d.companies || []).find(co => same(co.id, parts[2]));
      return Object.freeze({ parent: companies, current: closed ? 'Company' : (found && found.name) || 'Not found' });
    }
    /* A list has no pages under it: a contact's page is crm/<id>, not under
       "Contacts", so crm/contacts/<id> is not found rather than the list. */
    const section = page === 'crm' && parts[2] ? null : own(own(SECTIONS, page), key);
    if (section) return named(section);
    /* A record the page cannot show — its list did not load (d.has), or the
       page is closed to this person (d.open) — is named by what it is rather
       than called missing: the page beneath says which. */
    const record = page === 'company' ? (key === 'people' ? PEOPLE : null) : own(RECORDS, page);
    if (record && (d.open === false || (typeof d.has === 'function' && !d.has(record.part)))) {
      return Object.freeze({ parent, current: record.name });
    }
    if (page === 'tickets') return named(((d.tickets || []).find(t => same(t.id, key)) || {}).title);
    if (page === 'projects') return named(((d.projects || []).find(p => same(p.id, key)) || {}).name);
    if (page === 'crm') return named(((d.contacts || []).find(c => same(c.id, key)) || {}).name);
    if (page === 'agenda') {
      /* An event outside the weeks loaded — a past meeting opened from a
         client's page — is asked for by its id (d.event, the store's
         askEvent): named once it lands, and called an event while it is on
         its way or did not load, as the page beneath says. */
      const loaded = (d.events || []).find(e => same(e.id, key));
      if (loaded) return named(loaded.title);
      const asked = typeof d.event === 'function' ? d.event(key) : null;
      if (asked && asked.event) return named(asked.event.title);
      if (asked && (asked.state === 'loading' || asked.state === 'failed')) return Object.freeze({ parent, current: RECORDS.agenda.name });
      return named(null);
    }
    if (page === 'finance') return named(((d.invoices || []).find(v => same(v.uuid, key)) || {}).id);
    if (page === 'company' && key === 'people') return named(((d.team || []).find(m => same(m.id, parts[2])) || {}).name);
    return named(null);
  }

  const canOpen = (page, isManager) => Boolean(isManager) || !MANAGERS_ONLY.includes(page);
  const visibleNavs = (navs, isManager) => (navs || []).filter(n => canOpen(n[0], isManager));

  return Object.freeze({
    OPEN_TICKETS, URGENT,
    isOpenTicket, tileCounts, revenueFigures, invoiceDueNote, formatCount, plural, badge, updatedLabel, greeting,
    focusTasks, activeProjects, overdueProjects, projectsFoot,
    activityItem, crumb, canOpen, visibleNavs
  });
})();
