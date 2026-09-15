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
        : '')
      + `<section class="panel"><div class="list-toolbar"><h2 id="${HEADING}">${financeTab === 'overview' ? 'Recent invoices' : 'Invoices'} ${countTag(loaded ? shaped.length : '—')}</h2><span class="quiet-text">From the invoice ledger</span></div>`
      + invoiceTable(shaped, loaded) + '</section>';
  };

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

  /* One invoice, shaped (finance-model.js): its own currency and cents, its
     status today, and the date that matters — when it falls due, or when it was
     paid. Its client's contact is the one with the invoice's address; a company
     name, which two clients can share, finds nobody. */
  function invoiceDetail(s) {
    const address = String(s.clientEmail || '').trim().toLowerCase();
    const contact = address ? contacts.find(c => String(c.email || '').trim().toLowerCase() === address) || null : null;
    const billedTo = contact ? `<p>${esc(contact.name)}<br>${esc(contact.email)}</p>` : s.clientEmail ? `<p>${esc(s.clientEmail)}</p>` : '';
    return detailHeader('finance/invoices', 'All invoices', s.number, s.client,
      statusAction(s) + `<button class="btn" data-print-invoice>${icon('external')}Print invoice</button>`)
      + '<div class="record-layout invoice-layout"><section class="panel invoice-document">'
      + `<div class="invoice-heading"><div><span class="invoice-wordmark">Veyago</span><p>Veyago Inc.<br>New York, United States<br>hello@veyago.cloud</p></div><div><h2>Invoice</h2><p>${esc(s.number)}</p>${pill(s.status)}</div></div>`
      + `<div class="invoice-parties"><div><span class="eyebrow">BILL TO</span><h3>${esc(s.client)}</h3>${billedTo}</div>`
      + `<div><span class="eyebrow">${esc(s.dateHeading.toUpperCase())}</span><p>${esc(s.dateValue)}</p><span class="quiet-text">Currency: ${esc(s.currency)}</span></div></div>`
      + `<div class="table-wrap"><table class="invoice-lines"><thead><tr><th>Description</th><th>Qty</th><th>Amount</th></tr></thead><tbody><tr><td>${esc(s.description)}</td><td>1</td><td>${esc(s.amount)}</td></tr></tbody></table></div>`
      + `<div class="invoice-total"><span>Total</span><strong>${esc(s.amount)} <small>${esc(s.currency)}</small></strong></div>`
      + '<div class="invoice-note"><h3>Thank you for building with Veyago.</h3><p>Printed from the workspace. The invoice the client receives is the PDF sent from the admin.</p></div></section>'
      + `<aside class="record-aside">${properties([['Status', pill(s.status)], ['Total', esc(s.amount)], ['Balance due', esc(s.balance)], ['Currency', esc(s.currency)], ['Issued', esc(s.issued || '—')]])}`
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
      });
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
      });
    });
  }

  document.addEventListener('click', e => {
    const button = e.target.closest && e.target.closest('[data-invoice-paid], [data-invoice-unpaid]');
    if (!button) return;
    e.preventDefault();
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    if (!isManagerNow()) { toast('Only an owner or admin can change an invoice.'); return; }
    if (button.dataset.invoicePaid !== undefined) openPaid(String(button.dataset.invoicePaid));
    else openUnpaid(String(button.dataset.invoiceUnpaid));
  });
})();
