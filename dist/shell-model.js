/* shell-model.js — the workspace's frame, with no page in it.
 *
 * What the search box can find and in which order, where the arrow keys go in
 * its results, and what the bell lists. The search used to see tickets,
 * projects, contacts, this week's events, invoices and loaded mail — no people,
 * companies, tasks or notes — stopped at eight results without saying so, and
 * could only be used with a mouse. The bell listed things with no way to reach
 * them. Kept apart from app.js so it can be tested without a browser —
 * tests/shell.test.mjs.
 */
const shellModel = (function () {
  'use strict';

  const SEARCH_LIMIT = 12;
  const NOTE_LENGTH = 80;
  /* Bell entries of one kind, before the rest are left to the page itself. */
  const PER_KIND = 5;

  const text = value => String(value == null ? '' : value);
  const plural = (n, one) => n + ' ' + (n === 1 ? one : one + 's');
  /* matches: how a kind of record is found beyond the words in hay, when it has
     a way of its own — an invoice number however it is written, say. */
  const entry = (type, label, detail, hay, route, matches) => Object.freeze(Object.assign(
    { type, label: text(label), detail: text(detail), hay: text(hay), route },
    typeof matches === 'function' ? { matches } : {}));

  /* A note is opened on its record's page. */
  const NOTE_ROUTES = Object.freeze({
    tickets: id => 'tickets/' + id,
    projects: id => 'projects/' + id + '/notes',
    crm: id => 'crm/' + id + '/activity',
    agenda: id => 'agenda/' + id
  });

  /* Everything the search box can find, from what the workspace has loaded,
     each with the route that opens it by its id. */
  function searchItems(sources) {
    const s = sources || {};
    const items = [];
    (s.navs || []).forEach(([key, label]) => items.push(entry('App', label, '', label, key)));
    (s.tickets || []).forEach(t => items.push(entry('Ticket', t.title, 'VYG-' + t.id + ' · ' + text(t.client),
      [t.title, t.client, t.product, t.contactEmail, 'VYG-' + t.id].join(' '), 'tickets/' + t.id)));
    (s.projects || []).forEach(p => items.push(entry('Project', p.name, p.client,
      [p.name, p.client, p.description].join(' '), 'projects/' + p.id)));
    (s.projects || []).forEach(p => (p.tasks || []).forEach(title =>
      items.push(entry('Task', title, p.name, title, 'projects/' + p.id + '/tasks'))));
    /* Contacts, invoices and people open by their uuid: a place in the list
       changes whenever anyone adds one, and the result would open someone else. */
    (s.contacts || []).forEach(c => items.push(entry('Contact', c.name, c.company,
      [c.name, c.company, c.email].join(' '), 'crm/' + c.id)));
    /* A company opens its own page, whoever works there. */
    (s.companies || []).forEach(co => items.push(entry('Company', co.name, co.domain,
      [co.name, co.domain].join(' '), 'crm/companies/' + co.id)));
    (s.team || []).forEach(m => items.push(entry('Person', m.name, m.role,
      [m.name, m.role].join(' '), 'company/people/' + m.id)));
    /* An event, found with the day it is on: the weeks loaded and the project
       meetings coming up, which reach beyond them — each once. */
    const seenEvents = new Set();
    [...(s.events || []), ...(s.projectEvents || [])].forEach(e => {
      const key = text(e && e.id).toLowerCase();
      if (!key || seenEvents.has(key)) return;
      seenEvents.add(key);
      items.push(entry('Event', e.title, e.when || e.time, [e.title, e.detail].join(' '), 'agenda/' + key));
    });
    /* An invoice is also found as Finance's own search finds it, when that is
       handed in (invoiceMatches: financeModel.matchesQuery): by the client's
       address, what it is for, or its number however it is written. */
    (s.invoices || []).forEach(v => items.push(entry('Invoice', v.id + ' · ' + text(v.client), v.status,
      [v.id, v.client, v.amount].join(' '), 'finance/' + v.uuid,
      typeof s.invoiceMatches === 'function' ? query => s.invoiceMatches(v, query) : null)));
    (s.mails || []).forEach(m => items.push(entry('Mail', m.subject, m.sender,
      [m.subject, m.sender, m.email, m.preview].join(' '), s.mailRoute ? s.mailRoute(m) : 'mail')));
    const notes = s.notes || {};
    Object.keys(NOTE_ROUTES).forEach(kind => {
      Object.keys(notes[kind] || {}).forEach(id => (notes[kind][id] || []).forEach(note => {
        const body = text(note.body);
        const label = body.length > NOTE_LENGTH ? body.slice(0, NOTE_LENGTH - 1) + '…' : body;
        items.push(entry('Note', label, note.who, body, NOTE_ROUTES[kind](id)));
      }));
    });
    return Object.freeze(items);
  }

  /* Labels that start with the words, then labels that contain them, then
     anything that mentions them — each group in the order it was found. */
  function search(items, query, limit) {
    const q = text(query).trim().toLowerCase();
    if (!q) return Object.freeze({ results: Object.freeze([]), more: 0 });
    const max = limit || SEARCH_LIMIT;
    const matches = [];
    (items || []).forEach((item, order) => {
      const label = item.label.toLowerCase();
      const mentioned = item.hay.toLowerCase().includes(q) || Boolean(item.matches && item.matches(query));
      const rank = label.startsWith(q) ? 0 : label.includes(q) ? 1 : mentioned ? 2 : -1;
      if (rank >= 0) matches.push({ item, rank, order });
    });
    matches.sort((a, b) => a.rank - b.rank || a.order - b.order);
    return Object.freeze({
      results: Object.freeze(matches.slice(0, max).map(m => m.item)),
      more: Math.max(0, matches.length - max)
    });
  }

  /* Which result has focus after a key: -1 is the search box itself. */
  function nextFocus(current, key, count) {
    if (!count) return -1;
    if (key === 'ArrowDown') return current + 1 >= count ? 0 : current + 1;
    if (key === 'ArrowUp') return current === -1 ? count - 1 : current - 1;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return current;
  }

  /* What the bell lists: urgent open tickets, invoices waiting to be paid (for
     the people who can read Finance), unread mail and today's events — each
     one leading to where it can be dealt with. */
  function attention(facts) {
    const f = facts || {};
    const items = [];
    (f.tickets || [])
      .filter(t => overviewModel.isOpenTicket(t) && overviewModel.URGENT.includes(t.priority))
      .slice(0, PER_KIND)
      .forEach(t => items.push(Object.freeze({
        key: 'ticket:' + t.uuid,
        title: '#VYG-' + t.id + ' needs attention',
        detail: text(t.priority) + ' priority · ' + text(t.client),
        route: 'tickets/' + t.id
      })));
    if (f.isManager) {
      (f.invoices || [])
        .map((invoice, index) => ({ invoice, index }))
        .filter(({ invoice }) => invoice.status === 'Overdue' || invoice.status === 'Sent')
        .sort((a, b) => (a.invoice.status === 'Overdue' ? 0 : 1) - (b.invoice.status === 'Overdue' ? 0 : 1) || a.index - b.index)
        .slice(0, PER_KIND)
        .forEach(({ invoice, index }) => items.push(Object.freeze({
          key: 'invoice:' + (invoice.uuid || invoice.id),
          title: invoice.id + (invoice.status === 'Overdue' ? ' is overdue' : ' is outstanding'),
          detail: [invoice.amount, invoice.client].filter(Boolean).join(' · '),
          route: 'finance/' + invoice.uuid
        })));
    }
    if (f.unreadMail > 0) {
      items.push(Object.freeze({
        key: 'mail:unread', title: plural(f.unreadMail, 'unread conversation'),
        detail: 'Across your mailboxes', route: 'mail'
      }));
    }
    const today = f.eventsToday || [];
    if (today.length) {
      items.push(Object.freeze({
        key: 'events:today', title: plural(today.length, 'event') + ' today',
        detail: today.map(e => text(e.title)).join(' · ').slice(0, 90), route: 'agenda/today'
      }));
    }
    return Object.freeze(items);
  }

  /* The attributes that tell one control in #main from another, the most
     telling first. A key made of the first of them alone matched every row of
     a table — data-action="ticket" — so a repaint put focus on the first row
     rather than on the one it was on. */
  const FOCUS_ATTRIBUTES = Object.freeze([
    'id', 'data-query', 'name', 'data-thread-id', 'data-action', 'data-id', 'data-nav', 'data-view',
    'data-value', 'data-folder', 'data-filter', 'data-range', 'data-mail', 'data-create',
    'data-project-task', 'data-task', 'data-record-id', 'data-field', 'data-ticket',
    'data-people-role', 'data-contact',
    'data-agenda-week', 'data-agenda-day', 'data-agenda-edit', 'data-agenda-delete', 'data-agenda-kind', 'data-task-status', 'data-task-edit', 'data-task-remove',
    'data-task-new', 'data-note-edit', 'data-note-remove',
    'href'
  ]);

  /* A CSS string: quotes, backslashes and line breaks escaped. */
  const cssString = value => '"' + text(value)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ') + '"';

  /* A selector for a control, from its tag and its attributes ({ name: value }):
     null when none of them tells it apart. */
  function focusSelector(tag, attributes) {
    const attrs = attributes || {};
    const present = name => Object.prototype.hasOwnProperty.call(attrs, name) && attrs[name] != null;
    const parts = FOCUS_ATTRIBUTES.filter(present).map(name => '[' + name + '=' + cssString(attrs[name]) + ']');
    return parts.length ? text(tag).toLowerCase() + parts.join('') : null;
  }

  /* Whether a click in a list row opens its record here. A click on a link
     that asks for a new tab or window — a modifier key held — is the
     browser's to follow; opening the record here as well took the page away
     beneath it. Only the row steps aside: the rest of the page still hears the
     click. */
  function opensHere(event) {
    const e = event || {};
    const modified = Boolean(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    const onLink = Boolean(e.target && typeof e.target.closest === 'function' && e.target.closest('a[href]'));
    return !(modified && onLink);
  }

  /* Which page an address is, as moving focus to a new page's heading asks:
     the page and its record, not its list. A company ("crm/companies/<id>")
     and a person ("company/people/<id>") name their record in the third part,
     and opening one from its list is a new page; keyed by two parts, both were
     the list, focus stayed where the link had been, and went nowhere. Anything
     after the record — a tab — is the same page. */
  function pageKey(page, parts) {
    const p = Array.isArray(parts) ? parts : [];
    const key = [text(page), text(p[1])];
    if ((page === 'crm' && p[1] === 'companies') || (page === 'company' && p[1] === 'people')) key.push(text(p[2]));
    return key.join('/');
  }

  return Object.freeze({ SEARCH_LIMIT, searchItems, search, nextFocus, attention, focusSelector, opensHere, pageKey });
})();
