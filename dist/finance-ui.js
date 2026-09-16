/* finance-ui.js — Finance: the figures, the invoice list and each invoice's page.
 *
 * As finance-model.js works them out: an invoice by its uuid alone, its status
 * as of today (a sent invoice past its due date is overdue), every amount with
 * its cents in its own currency, and currencies listed side by side, never
 * added together. What did not load says so — never a zero, an empty list or an
 * invoice that is not there — and a list with no rows is not drawn as a table
 * of headings.
 *
 * These replace the page app.js drew, and load after workspace.js, whose page
 * helpers they draw with; workspace.js still decides who may open Finance at
 * all. Tested in tests/finance-ui.test.mjs.
 */
(function () {
  'use strict';

  const F = financeModel;
  const HEADING = 'finance-invoices-heading';
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  /* No payment is recorded on a day before this: a year typed as "26" is 0026. */
  const EARLIEST = '2000-01-01';
  /* Marking an invoice paid or unpaid changes finance_invoices (the list) and
     workspace_overview()'s invoices_outstanding (the Overview tile) — nothing
     else. It does not touch finance_transactions, so revenue, the revenue
     series and the revenue mix are exactly as they were: reloading them, and
     every unrelated part of the workspace besides, on every payment recorded
     was the "every write reloads all finance data" the audit found. */
  const PAYMENT_PARTS = ['invoices', 'overview'];

  /* ── The invoice list: search, a status filter, sortable columns, paging ──
     Kept as module state, the way financeTab itself is (workspace.js): a
     search typed or a column sorted is a preference for this list, not a
     value a dialog or a write needs to know about. Only the "Invoices" tab
     gets any of this — the Overview tab's "Recent invoices" stays the small,
     unfiltered preview it always was. */
  const PAGE_SIZE = 50;
  let invoiceSort = { key: null, dir: 'asc' };
  let invoiceStatus = '';
  let invoiceShown = PAGE_SIZE;
  /* What invoiceShown counts against: the query, the status filter and the
     sort together. A change to any of them starts the list over at the first
     page — a "Show more" position kept from a different search would show
     the wrong slice of the new one. */
  let lastInvoiceFilterKey = null;

  /* A shaped invoice's value for a sortable column: text folded for a
     case-insensitive compare, the cents already worked out (finance-model.js)
     for Amount, and whichever date the "Due / paid" column itself reads —
     paidOn once it is paid, dueOn otherwise — so the sort agrees with what is
     on screen. */
  function sortValue(s, key) {
    if (key === 'client') return String(s.client || '').toLowerCase();
    if (key === 'amount') return s.cents === null ? -Infinity : s.cents;
    if (key === 'status') return s.statusValue || '';
    if (key === 'due') return (s.statusValue === 'paid' ? s.paidOn : s.dueOn) || '';
    return String(s.number || '').toLowerCase();
  }
  const has = part => Boolean(window.workspaceStore && workspaceStore.has(part));
  const live = () => Boolean(window.workspaceStore && workspaceStore.state && workspaceStore.state.loaded);
  /* The admin, where an invoice is made and sent: its guided flow shows the
     real document before it leaves (veyagocloud admin/js/invoice-new.js). */
  const ADMIN_URL = window.VEYAGO_ADMIN_URL || 'https://veyago.cloud/admin/';
  const adminLink = (path, label, className) =>
    `<a class="${className}" href="${esc(ADMIN_URL + path)}" target="_blank" rel="noopener">${label}<span class="sr-only"> (opens the admin in a new tab)</span></a>`;

  /* Under "Awaiting payment": how many are late and the next due date still
     ahead — or that no due date is set, or that nothing is waiting. */
  function awaitingHint(awaiting, today) {
    if (awaiting === null) return 'Not loaded';
    if (!awaiting.length) return 'Nothing awaiting payment';
    const late = awaiting.reduce((n, entry) => n + entry.overdue, 0);
    const nextDue = awaiting.map(entry => entry.nextDue).filter(Boolean).sort()[0] || null;
    return [late ? overviewModel.plural(late, 'invoice') + ' overdue' : '',
      nextDue ? 'Next due ' + F.shortDate(nextDue, today) : ''].filter(Boolean).join(' · ') || 'No due date set';
  }

  function revenueStat(revenue) {
    if (!revenue) return ['Revenue this month', '—', CAL.thisMonth + ' · did not load'];
    const beside = revenue.otherCurrencies.length ? ' · also ' + revenue.otherCurrencies.join(', ') : ' · from transactions';
    return ['Revenue this month', F.money(revenue.month, revenue.currency), CAL.thisMonth + beside];
  }

  /* A plain row with a link in it, so its cells are read out; a click anywhere
     in the row still opens the invoice (data-action), and a click on the link
     that asks for a new tab is left to the browser (app.js). */
  function invoiceRow(s) {
    const opens = s.uuid ? ` data-action="invoice" data-id="${esc(s.uuid)}"` : '';
    const number = s.route
      ? `<a class="record-link" href="#${esc(s.route)}"><strong>${esc(s.number)}</strong></a>`
      : `<strong>${esc(s.number)}</strong>`;
    return `<tr${opens}><td>${number}</td>`
      + `<td><div class="cell-main"><div><strong>${esc(s.client)}</strong><small>${esc(s.description)}</small></div></div></td>`
      + `<td>${esc(s.amount)}</td><td>${pill(s.status)}</td><td>${esc(s.dueOrPaid)}</td><td>${icon('chevron')}</td></tr>`;
  }

  function invoiceTable(shaped, loaded) {
    if (!loaded) return '<div class="empty-state">Invoices did not load. They are tried again by themselves.</div>';
    if (!shaped.length) return '<div class="empty-state">No invoices yet.</div>';
    return `<div class="table-wrap"><table class="module-table" aria-labelledby="${HEADING}"><thead><tr>`
      + '<th>Invoice</th><th>Client</th><th>Amount</th><th>Status</th><th>Due / paid</th><th><span class="sr-only">Open</span></th>'
      + `</tr></thead><tbody>${shaped.map(invoiceRow).join('')}</tbody></table></div>`;
  }

  /* Searched (financeModel.matchesQuery, reused from the model — number,
     client, address or description), filtered to one status, and sorted —
     every one of the "can't be searched, filtered, sorted or paged" list of
     things the audit found the invoice list unable to do. */
  function searchedInvoices(shaped, query, status) {
    let list = status ? shaped.filter(s => s.statusValue === status) : shaped;
    if (query) list = list.filter(s => F.matchesQuery(s, query));
    return list;
  }

  function sortedInvoices(list, sort) {
    if (!sort.key) return list;
    const dir = sort.dir === 'desc' ? -1 : 1;
    /* A copy: never the array a write's own reload is about to swap out from
       under whatever still holds a reference to it (data/store.js's swap()). */
    return [...list].sort((a, b) => {
      const av = sortValue(a, sort.key), bv = sortValue(b, sort.key);
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  /* A column heading someone can click to sort by it: the same column again
     toggles direction, a different one starts ascending. aria-sort names the
     one column actually doing the sorting; the others say "none" rather than
     nothing, so a screen reader is told they are sortable too. */
  function sortHeader(label, key, sort) {
    const active = sort.key === key;
    const arrow = active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';
    return `<th aria-sort="${active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}">`
      + `<button type="button" class="sort-header" data-finance-sort="${key}">${esc(label)}${arrow}</button></th>`;
  }

  function statusFilterBar(current) {
    const options = [{ value: '', label: 'All statuses' }].concat(F.STATUSES);
    return `<div class="tabs" role="group" aria-label="Filter invoices by status">${options.map(o =>
      `<button type="button" data-finance-status="${esc(o.value)}" class="${current === o.value ? 'active' : ''}" aria-pressed="${current === o.value}">${esc(o.label)}</button>`).join('')}</div>`;
  }

  /* The Invoices tab's own table: sortable headings, a page of `shown` rows
     at a time, and a count of what searching or filtering left out — never a
     table of headings over nothing, and never silently every row when there
     are hundreds (list-limit, as crm-ui.js's contact and company lists do). */
  function invoiceListSection(all, loaded, query, status, sort, shown) {
    if (!loaded) return { toolbar: '', body: invoiceTable([], false), count: '—' };
    const matched = sortedInvoices(searchedInvoices(all, query, status), sort);
    const toolbar = queryInput('finance', 'Search invoices') + statusFilterBar(status);
    if (!matched.length) {
      const body = all.length
        ? '<div class="empty-state">No invoices match. Try another search or status.</div>'
        : '<div class="empty-state">No invoices yet.</div>';
      return { toolbar, count: matched.length, body };
    }
    const page = matched.slice(0, shown);
    const table = `<div class="table-wrap"><table class="module-table" aria-labelledby="${HEADING}"><thead><tr>`
      + sortHeader('Invoice', 'number', sort) + sortHeader('Client', 'client', sort) + sortHeader('Amount', 'amount', sort)
      + sortHeader('Status', 'status', sort) + sortHeader('Due / paid', 'due', sort) + '<th><span class="sr-only">Open</span></th>'
      + `</tr></thead><tbody>${page.map(invoiceRow).join('')}</tbody></table></div>`
      + (matched.length > page.length
        ? `<p class="quiet-text list-limit"><button type="button" class="text-btn" data-finance-more>Show ${Math.min(PAGE_SIZE, matched.length - page.length)} more</button> — showing ${page.length} of ${matched.length}</p>`
        : '');
    return { toolbar, count: matched.length, body: table };
  }

  /* An invoice's own address while invoices did not load: that, rather than an
     invoice that is not there. */
  function notLoadedPage() {
    return detailHeader('finance/invoices', 'All invoices', 'This invoice cannot be shown yet.',
      'Invoices did not load. They are tried again by themselves.')
      + `<section class="panel">${empty('Invoices did not load', 'The invoice opens here once they have.')}</section>`;
  }

  financeView = function () {
    const today = financeDay();
    const route = F.financeRoute(routeParts);
    const loaded = has('invoices');
    if (route.record) {
      /* An address that is no invoice's never will be one. */
      if (route.invoiceId === null) return notFound();
      if (!loaded) return notLoadedPage();
      const found = F.invoiceById(invoices, route.invoiceId);
      return found ? invoiceDetail(F.shapeInvoice(found, today)) : notFound();
    }
    financeTab = route.tab;
    const overview = window.workspaceStore ? workspaceStore.state.overview : null;
    const f = F.figures({ overview, invoices: loaded ? invoices : null, today });
    const main = f.revenue ? f.revenue.currency : null;
    const shaped = loaded ? invoices.map(invoice => F.shapeInvoice(invoice, today)) : [];
    return titlebar('A clear view of the business.', 'Income, invoices, and the clients behind them.',
      adminLink('invoice-new/', `${icon('plus')}New invoice`, 'btn btn-primary'))
      + subnav([['finance', 'Overview', 'overview'], ['finance/invoices', 'Invoices', 'invoices']], financeTab)
      + statStrip([
        revenueStat(f.revenue),
        ['Listed invoices', F.moneyList(f.listed, main), f.count === null ? 'Not loaded' : overviewModel.plural(f.count, 'invoice')],
        ['Paid invoices', F.moneyList(f.paid, main), 'From the invoice list'],
        ['Awaiting payment', F.moneyList(f.awaiting, main), awaitingHint(f.awaiting, today)]
      ])
      + (financeTab === 'overview'
        ? `<div class="financial-grid">${revenueChart()}<section class="panel breakdown"><div class="section-title"><h2>Revenue mix</h2><span class="quiet-text">${esc(CAL.thisMonth)}</span></div>${revenueMixPanel()}</section></div>`
          + transactionsPanel() + overviewInvoicesSection(shaped, loaded)
        : invoicesTabSection(shaped, loaded));
  };

  /* The Overview tab's own "Recent invoices" preview: every invoice, in the
     order the database gives them, with none of the Invoices tab's controls
     — a small, unfiltered look at the ledger, not the place to search it. */
  function overviewInvoicesSection(shaped, loaded) {
    return `<section class="panel"><div class="list-toolbar"><h2 id="${HEADING}">Recent invoices ${countTag(loaded ? shaped.length : '—')}</h2><span class="quiet-text">From the invoice ledger</span></div>`
      + invoiceTable(shaped, loaded) + '</section>';
  }

  /* The Invoices tab: search, a status filter and sortable columns over
     every invoice, paged rather than all drawn at once. A change to the
     query, the filter or the sort starts "Show more" over at the first page
     — kept as module state (invoiceShown), the same way financeTab is, so a
     background refresh with the same search does not reset a page someone
     has paged into. */
  function invoicesTabSection(shaped, loaded) {
    const filterKey = queries.finance + ' ' + invoiceStatus + ' ' + invoiceSort.key + invoiceSort.dir;
    if (filterKey !== lastInvoiceFilterKey) { invoiceShown = PAGE_SIZE; lastInvoiceFilterKey = filterKey; }
    const section = invoiceListSection(shaped, loaded, queries.finance, invoiceStatus, invoiceSort, invoiceShown);
    return `<section class="panel"><div class="list-toolbar"><h2 id="${HEADING}">Invoices ${countTag(loaded ? section.count : '—')}</h2>${section.toolbar}</div>`
      + section.body + '</section>';
  }

  /* The revenue mix: every category in a colour of its own, in name order so a
     colour follows its category, and past eight the smallest folded into one
     grey slice (finance-model.js). Each slice keeps its name beside its amount:
     three of the colours are faint on the panel. */
  function revenueMixPanel() {
    const mix = F.revenueMix(has('revenueMix') ? workspaceStore.state.revenueMix : null);
    if (!mix) return '<p class="quiet-text" style="padding:14px 0">The revenue mix did not load.</p>';
    if (!mix.slices.length) return '<p class="quiet-text" style="padding:14px 0">No income recorded this month yet.</p>';
    return `<div class="revenue-mix-total">${esc(mix.total)} <small>${esc(mix.currency)}</small></div>`
      + `<div class="mix-bar">${mix.slices.map(s => `<i style="width:${Number(s.width)}%;background:${esc(s.colour)}"></i>`).join('')}</div>`
      + mix.slices.map(s => `<div class="mix-row"><span><i class="mix-dot" style="background:${esc(s.colour)}"></i>${esc(s.label)}</span><strong>${esc(s.money)}</strong><small>${Number(s.share)}%</small></div>`).join('')
      + `<p class="quiet-text">Values in ${esc(mix.currency)}, from posted transactions.</p>`;
  }

  /* Sentence case for a raw database value ('microsoft_mail' -> 'Microsoft
     mail'), for the one or two fields transactions carry that are not
     already labelled by finance-model.js: kind and source. A dash, never a
     blank cell, when there is nothing to show. */
  function plainLabel(value) {
    const words = String(value || '').replace(/_/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—';
  }

  /* One transaction: the day it posted, what it was and who with, its kind
     when the sync or a person recorded one, and its signed amount — negative
     already reads as spent, so the list needs no colour to say expense from
     income. */
  function transactionRow(t) {
    const amount = F.money(t.amount, t.currency);
    return `<tr><td>${esc(F.shortDate(t.posted_at, financeDay()))}</td>`
      + `<td><div class="cell-main"><div><strong>${esc(t.description || '—')}</strong>${t.counterparty ? `<small>${esc(t.counterparty)}</small>` : ''}</div></div></td>`
      + `<td>${esc(t.kind ? plainLabel(t.kind) : plainLabel(t.source))}</td>`
      + `<td>${esc(amount === null ? '—' : amount)}</td></tr>`;
  }

  /* The chart's own 6/12-month toggle (app.js's range), counted back from
     financeDay() — the same "today" every other Finance figure uses, and the
     one a test can fix — rather than the machine's own clock, which a page
     rendered at 23:59 and one rendered a minute later must not disagree
     about. Months are treated as 30 days, matching how the toggle is worded:
     an exact calendar month would make "6 months" a different number of days
     depending which six they were. */
  function transactionsMonths() {
    return typeof range !== 'undefined' && range === '12 months' ? 12 : 6;
  }

  function transactionsSince(months) {
    const today = financeDay();
    const base = DAY.test(today || '') ? new Date(today + 'T00:00:00Z') : new Date();
    return new Date(base.getTime() - months * 30 * 86400000).toISOString().slice(0, 10);
  }

  /* Recent transactions, on the Overview tab beside the chart and the mix —
     the window the chart itself shows, so the three agree about what "this
     window" means. Asked for lazily (workspaceStore.transactions): a manager
     who never opens Finance this session never costs a query on it, and —
     the audit's "every write reloads all finance data" — a write anywhere
     else in the workspace does not refetch it either, because it is not one
     of the PARTS store.js reloads on every load at all (data/store.js). */
  function transactionsPanel() {
    const months = transactionsMonths();
    const since = transactionsSince(months);
    const asked = window.workspaceStore && typeof workspaceStore.transactions === 'function'
      ? workspaceStore.transactions(since) : { state: 'loading', rows: [] };
    const heading = `<div class="list-toolbar"><h2>Recent transactions</h2><span class="quiet-text">Last ${months} months</span></div>`;
    if (asked.state === 'loading') {
      return `<section class="panel">${heading}<p class="quiet-text" style="padding:6px 18px 14px">Loading transactions…</p></section>`;
    }
    if (asked.state === 'failed') {
      return `<section class="panel">${heading}<div class="empty-state">Transactions did not load. `
        + '<button type="button" class="text-btn" data-finance-tx-retry>Try again</button></div></section>';
    }
    if (!asked.rows.length) {
      return `<section class="panel">${heading}<div class="empty-state">No transactions in this window.</div></section>`;
    }
    const SHOWN = 20;
    const rows = asked.rows.slice(0, SHOWN);
    const table = `<div class="table-wrap"><table class="module-table"><thead><tr><th>Date</th><th>Description</th><th>Kind</th><th>Amount</th></tr></thead>`
      + `<tbody>${rows.map(transactionRow).join('')}</tbody></table></div>`
      + (asked.rows.length > rows.length ? `<p class="quiet-text list-limit">Showing the ${SHOWN} most recent of ${asked.rows.length}.</p>` : '');
    return `<section class="panel">${heading}${table}</section>`;
  }

  /* A quantity as an invoice line shows it: "10", not "10.00" — numeric
     columns come back from PostgREST as strings, to keep the cents Number()
     would drop, but a quantity is a count, not money, and reads oddly with
     two decimals nailed onto a whole number. Not a number at all is a dash,
     never a zero someone did not enter. */
  function quantityText(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—';
  }

  /* An invoice's itemised lines (0060, finance_invoice_lines), in the order
     the invoice lists them. One made before 0060, or a test row with none
     recorded, falls back to the single description and total this page
     always showed — the row is not "blank", it is "not itemised". */
  function invoiceLineRows(s) {
    const rows = ((s.row || {}).finance_invoice_lines || []).filter(Boolean);
    if (!rows.length) return `<tr><td>${esc(s.description)}</td><td>1</td><td>${esc(s.amount)}</td></tr>`;
    return rows.map(l => `<tr><td>${esc(l.description)}</td><td>${esc(quantityText(l.quantity))}</td><td>${esc(F.money(l.amount, s.currency))}</td></tr>`).join('');
  }

  /* Tax or VAT, as one more row in the same table as the lines — reusing the
     table's own right-aligned amount column rather than a second element
     that would need its own layout. Nothing when none is recorded, which is
     every invoice made before 0060 and most made since: tax is additional
     detail, not a requirement. */
  function taxRow(s) {
    const amount = (s.row || {}).tax_amount;
    if (amount === null || amount === undefined || amount === '') return '';
    const rate = (s.row || {}).tax_rate;
    const label = rate === null || rate === undefined || rate === '' ? 'Tax' : `Tax (${Number(rate)}%)`;
    return `<tr><td colspan="2">${esc(label)}</td><td>${esc(F.money(amount, s.currency))}</td></tr>`;
  }

  /* A client number (0053), given once a company first reaches the client
     stage: queries.js embeds it straight off finance_invoices.company_id
     (0051) onto the raw row, the same way it already carries tax and the
     line items finance-model.js's own shapeInvoice() does not know about —
     that peer file is not touched here either. An invoice with no company
     linked, or one linked to a company not yet a client, has none to quote. */
  function clientNumberOf(s) {
    const company = (s.row || {}).company;
    return company && company.client_number != null ? company.client_number : null;
  }

  /* One invoice, shaped (finance-model.js): its own currency and cents, its
     status today, and the date that matters — when it falls due, or when it was
     paid. Its client's contact is the one with the invoice's address; a company
     name, which two clients can share, finds nobody. */
  function invoiceDetail(s) {
    const address = String(s.clientEmail || '').trim().toLowerCase();
    const contact = address ? contacts.find(c => String(c.email || '').trim().toLowerCase() === address) || null : null;
    const billedTo = contact ? `<p>${esc(contact.name)}<br>${esc(contact.email)}</p>` : s.clientEmail ? `<p>${esc(s.clientEmail)}</p>` : '';
    const lines = invoiceLineRows(s);
    const tax = taxRow(s);
    const clientNumber = clientNumberOf(s);
    return detailHeader('finance/invoices', 'All invoices', s.number, s.client,
      statusAction(s) + `<button class="btn" data-print-invoice>${icon('external')}Print invoice</button>`)
      + '<div class="record-layout invoice-layout"><section class="panel invoice-document">'
      /* Veyago Inc.'s own registered address and EIN — public facts, on the
         business's own legal page, not secrets — matching exactly what
         invoice-pdf.ts prints (_shared/invoice-pdf.ts BUSINESS_BASE). This
         page used to say "New York", which the real document never has: two
         things calling themselves the same invoice, disagreeing about who
         sent it, reads as a mistake on one of them. */
      + `<div class="invoice-heading"><div><span class="invoice-wordmark">Veyago</span><p>Veyago Inc.<br>54 State Street, Ste 804 #17055<br>Albany, NY 12207, USA<br>EIN 30-1492188<br>hello@veyago.cloud</p></div><div><h2>Invoice</h2><p>${esc(s.number)}</p>${pill(s.status)}</div></div>`
      + `<div class="invoice-parties"><div><span class="eyebrow">BILL TO</span><h3>${esc(s.client)}</h3>${billedTo}</div>`
      + `<div><span class="eyebrow">${esc(s.dateHeading.toUpperCase())}</span><p>${esc(s.dateValue)}</p><span class="quiet-text">Currency: ${esc(s.currency)}</span></div></div>`
      + `<div class="table-wrap"><table class="invoice-lines"><thead><tr><th>Description</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${lines}${tax}</tbody></table></div>`
      + `<div class="invoice-total"><span>Total</span><strong>${esc(s.amount)} <small>${esc(s.currency)}</small></strong></div>`
      /* Payment itself is deliberately NOT reproduced here: it lives on the
         document invoice-pdf.ts actually sends (bank details from
         workspace_settings, never exposed to the browser), and a second copy
         of it here could drift from that one and tell a client the wrong
         thing to pay into. This page says only where the real one is. */
      + '<div class="invoice-note"><h3>Thank you for building with Veyago.</h3><p>Printed from the workspace, for reference only. The document the client actually received — with where to pay — is the PDF sent from the admin.</p></div></section>'
      + `<aside class="record-aside">${properties([
          ['Status', pill(s.status)],
          ...(clientNumber != null ? [['Client No.', esc(String(clientNumber))]] : []),
          ['Total', esc(s.amount)], ['Balance due', esc(s.balance)], ['Currency', esc(s.currency)],
          ['Issued', esc(s.issued || '—')], ['Last changed', esc(F.shortDate((s.row || {}).updated_at, financeDay()) || '—')]
        ])}`
      + linkedPanel('Client relationship', contact ? [[`crm/${contact.id}`, contact.name, s.client, 'crm']] : [])
      + `<p class="aside-note">Invoices are created and sent from ${adminLink('invoices/', 'the admin', 'record-link')}.</p></aside></div>`;
  }

  /* ── Recording a payment ───────────────────────────────────────────── */

  /* What an owner or admin can record from an invoice's page: that one waiting
     for payment was paid, or that one marked paid was not. A draft has asked
     nobody for anything, and is sent from the admin. */
  function statusAction(s) {
    if (!s.uuid) return '';
    if (s.statusValue === 'paid') {
      return `<button class="btn" type="button" data-invoice-unpaid="${esc(s.uuid)}">Mark unpaid</button>`;
    }
    if (s.statusValue === 'sent' || s.statusValue === 'overdue') {
      return `<button class="btn btn-primary" type="button" data-invoice-paid="${esc(s.uuid)}">${icon('check')}Mark paid</button>`;
    }
    return '';
  }

  /* Whether an invoice's issue day has come on this clock. invoice-pdf stamps
     a sent invoice with the UTC day, which is still tomorrow here on an
     evening west of Greenwich: until that day comes it bounds nothing, or no
     day would be both on or after it and not still to come. */
  const issuedBy = (issuedOn, today) => DAY.test(issuedOn || '') && (!DAY.test(today) || issuedOn <= today);

  /* A day a payment was made: a date, not one still to come, and not before
     the invoice was issued. */
  function paidProblem(paidOn, today, issuedOn) {
    if (!DAY.test(paidOn) || paidOn < EARLIEST) return 'Pick the day it was paid.';
    if (DAY.test(today) && paidOn > today) return 'A payment cannot be recorded for a day still to come.';
    if (issuedBy(issuedOn, today) && paidOn < issuedOn) return `The invoice was issued on ${F.shortDate(issuedOn, today)}: pick that day or a later one.`;
    return null;
  }

  /* The invoice as the store has it now, shaped — or null, said on the dialog
     when there is one, else in a toast. */
  function invoiceNow(uuid, form) {
    const found = F.invoiceById(invoices, uuid);
    if (found) return F.shapeInvoice(found, financeDay());
    if (form) dialogForms.say(form, 'That invoice is no longer in the list.');
    else toast('That invoice is no longer in the list.');
    return null;
  }

  /* The invoice, if it still waits for what the dialog was opened to record:
     someone may have recorded the payment, or turned it back into a draft in
     the admin, while the dialog was open. */
  function stillAs(form, uuid, statuses) {
    const s = invoiceNow(uuid, form);
    if (!s || statuses.includes(s.statusValue)) return s;
    dialogForms.say(form, `This invoice is ${String(s.status).toLowerCase()} now, so nothing was changed. Close this and look again.`);
    return null;
  }

  /* Once the reload has redrawn the page, the keyboard's focus goes to the
     button that undoes what was just done: the one it was on is gone. */
  function focusOn(selector) {
    const button = document.querySelector(selector);
    if (button && button.focus) button.focus();
  }

  function openPaid(uuid) {
    const s = invoiceNow(uuid);
    if (!s) return;
    const today = financeDay();
    const earliest = issuedBy(s.issuedOn, today) ? s.issuedOn : EARLIEST;
    showModal('FINANCE · INVOICE', `<h2>Mark ${esc(s.number)} paid</h2>`
      + `<p class="form-note">The day ${esc(s.client)} paid ${esc(s.amount)}. This records the payment: nobody is charged or emailed, and revenue, which comes from posted transactions, does not change.</p>`
      + dialogForms.form('invoice-paid-form', dialogForms.field('Paid on',
        `<input type="date" name="paidOn" required min="${esc(earliest)}" max="${esc(today)}" value="${esc(today)}">`), 'Mark paid'));
    const form = document.getElementById('invoice-paid-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      dialogForms.quiet(form);
      const now = stillAs(form, uuid, ['sent', 'overdue']);
      if (!now) return;
      const paidOn = String(new FormData(form).get('paidOn') || '').trim();
      const problem = paidProblem(paidOn, financeDay(), now.issuedOn);
      if (problem) { dialogForms.say(form, problem, 'paidOn'); return; }
      dialogForms.sending(form, () => workspaceActions.markInvoicePaid(now.uuid, paidOn), () => {
        toast(`${now.number} marked paid.`);
        focusOn(`[data-invoice-unpaid="${now.uuid}"]`);
      }, { only: PAYMENT_PARTS });
    });
  }

  /* The day an invoice was paid, as a date key, or null when none is recorded. */
  const paidDay = s => (DAY.test(s.paidOn || '') ? s.paidOn : null);

  function openUnpaid(uuid) {
    const s = invoiceNow(uuid);
    if (!s) return;
    const today = financeDay();
    /* The payment this dialog undoes: one recorded again since, on another
       day, is not the one it asked about. */
    const paidOn = paidDay(s);
    const late = DAY.test(s.dueOn || '') && DAY.test(today) && s.dueOn < today ? ' It is past its due date, so it will show as overdue.' : '';
    showModal('FINANCE · INVOICE', `<h2>Mark ${esc(s.number)} unpaid?</h2>`
      + `<p class="form-note">It goes back to waiting for payment, and the day it was paid is cleared.${late}</p>`
      + dialogForms.form('invoice-unpaid-form', '', 'Mark unpaid'));
    const form = document.getElementById('invoice-unpaid-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      dialogForms.quiet(form);
      const now = stillAs(form, uuid, ['paid']);
      if (!now) return;
      if (paidDay(now) !== paidOn) {
        dialogForms.say(form, 'This invoice’s payment was recorded again since, so nothing was changed. Close this and look again.');
        return;
      }
      dialogForms.sending(form, () => workspaceActions.reopenInvoice(now.uuid, paidOn), () => {
        toast(`${now.number} marked unpaid.`);
        focusOn(`[data-invoice-paid="${now.uuid}"]`);
      }, { only: PAYMENT_PARTS });
    });
  }

  /* The invoice list's own controls: a status filter, a sortable column, a
     page of more rows, or a retry for transactions that did not load. Pure
     view state — nothing here writes to the database, so none of it goes
     through workspaceStore.after() or needs live()/isManagerNow() guards the
     way changing an invoice does. */
  document.addEventListener('click', e => {
    const status = e.target.closest && e.target.closest('[data-finance-status]');
    if (status) { invoiceStatus = status.dataset.financeStatus; repaintKeepingFocus(); return; }

    const sort = e.target.closest && e.target.closest('[data-finance-sort]');
    if (sort) {
      const key = sort.dataset.financeSort;
      invoiceSort = invoiceSort.key === key ? { key, dir: invoiceSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
      repaintKeepingFocus();
      return;
    }

    if (e.target.closest && e.target.closest('[data-finance-more]')) { invoiceShown += PAGE_SIZE; repaintKeepingFocus(); return; }

    if (e.target.closest && e.target.closest('[data-finance-tx-retry]')) {
      if (window.workspaceStore && typeof workspaceStore.retryTransactions === 'function') {
        workspaceStore.retryTransactions(transactionsSince(transactionsMonths()));
      }
      repaintKeepingFocus();
      return;
    }

    const button = e.target.closest && e.target.closest('[data-invoice-paid], [data-invoice-unpaid]');
    if (!button) return;
    e.preventDefault();
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    if (!isManagerNow()) { toast('Only an owner or admin can change an invoice.'); return; }
    if (button.dataset.invoicePaid !== undefined) openPaid(String(button.dataset.invoicePaid));
    else openUnpaid(String(button.dataset.invoiceUnpaid));
  });
})();
