/* Finance's page, as finance-ui.js draws it: the figures, the invoice list and
   an invoice's page — what did not load, what is empty, what anyone typed into
   an invoice kept as text, and which invoice an address opens. The page's
   helpers are stand-ins that escape what the real ones (workspace.js, app.js)
   escape and nothing more, so what is tested is what finance-ui.js hands them.
   Loaded into a sandbox the way <script> tags run it, beside the models it
   reads. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const TODAY = '2026-09-14';
const U1 = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const U2 = '7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c';
const TYPED = '<img src=x onerror=alert(1)>';
const MARKUP = /<img/i;

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* An invoice as queries.invoices() hands it to the store: the number as `id`,
   the uuid as `uuid`, the amount already formatted, and the row under `row`. */
function invoice(over = {}) {
  const row = {
    id: U1, number: 'INV-1042', client: 'Harbor & Co', client_email: 'billing@northline.example',
    amount: '1234.5', currency: 'USD', status: 'sent', issued_on: '2026-09-01', due_on: '2026-09-20',
    paid_on: null, notes: 'Site build', ...over
  };
  return {
    id: row.number, uuid: row.id, client: row.client, description: row.notes || '', amount: '$1,235',
    status: row.status.charAt(0).toUpperCase() + row.status.slice(1), row
  };
}

/* An element a click lands on, with its data attributes. */
function target(attributes) {
  const dataset = Object.fromEntries(Object.entries(attributes).map(([name, value]) =>
    [name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));
  const element = { dataset };
  return { closest: selector => (selector.split(',').map(s => s.trim().replace(/^\[|\]$/g, '')).some(name => name in attributes) ? element : null) };
}

/* The page, and what its buttons and dialogs do: the dialog showModal() is
   given is kept with the values a test fills in, and the writes are recorded.
   refuse: the database refuses the invoice writes. */
function start({
  list = [], route = ['finance'], contacts = [], loaded = ['invoices', 'revenueMix'], overview = null, mix = [],
  manager = true, refuse = false, live = true, query = '', range = '6 months',
  transactions = { state: 'ready', rows: [] }
} = {}) {
  const listeners = {};
  const toasts = [];
  const modals = [];
  const calls = [];
  const queries = { finance: query };
  let txState = transactions;
  /* The buttons given focus on the page, by selector. */
  const focused = [];
  let form = null;
  /* The buttons on the page as it was last drawn, by selector. A write's
     reload draws the page again (after() below), so a button the write brings
     is there only once that reload is done. */
  let drawn = [];
  const dialogForm = id => {
    const handlers = {};
    const parts = {};
    const part = selector => (parts[selector] = parts[selector] || {
      textContent: '', innerHTML: '', disabled: false, focused: 0, attributes: {}, dataset: {},
      id: selector === '.form-error' ? `${id}-error` : '',
      focus() { this.focused += 1; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; }
    });
    return { id, values: {}, isConnected: true, handlers, parts, addEventListener: (type, fn) => { handlers[type] = fn; }, querySelector: part };
  };
  /* What the database does with a write: the invoice as the next load brings it. */
  const store = (id, change) => {
    const at = list.findIndex(i => i.uuid === id);
    if (at !== -1) list[at] = invoice({ ...list[at].row, ...change });
  };
  const context = vm.createContext({
    console,
    esc: escape,
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); form = dialogForm((body.match(/<form id="([^"]+)"/) || [])[1]); context.modal.open = true; },
    modal: { open: true, close() { this.open = false; } },
    isManagerNow: () => manager,
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => (form && form.id === id ? form : null),
      querySelector: selector => (drawn.includes(selector) ? { focus: () => focused.push(selector) } : null)
    },
    FormData: class { constructor(f) { this.f = f; } get(name) { return this.f.values[name]; } },
    workspaceActions: {
      markInvoicePaid: async (id, paidOn) => {
        calls.push(['markInvoicePaid', id, paidOn]);
        if (refuse) throw new Error('The invoice was not changed: only an owner or admin can mark an invoice paid.');
        store(id, { status: 'paid', paid_on: paidOn });
        return { id };
      },
      reopenInvoice: async (id, paidOn) => {
        calls.push(['reopenInvoice', id, paidOn]);
        store(id, { status: 'sent', paid_on: null });
        return { id };
      }
    },
    icon: name => `<svg data-icon="${name}"></svg>`,
    pill: label => `<span class="pill">${escape(label)}</span>`,
    titlebar: (title, subtitle, button = '') => `<h1>${escape(title)}</h1><p>${escape(subtitle)}</p>${button}`,
    subnav: (items, current) => items.map(([path, label, key]) =>
      `<a href="#${path}"${current === key ? ' aria-current="page"' : ''}>${escape(label)}</a>`).join(''),
    statStrip: items => items.map(([label, value, hint]) =>
      `<div><span>${escape(label)}</span><strong>${escape(value)}</strong><small>${escape(hint)}</small></div>`).join(''),
    countTag: n => `<span class="small-count">${n}</span>`,
    detailHeader: (parent, label, title, subtitle, actions = '') =>
      `<a href="#${escape(parent)}">${escape(label)}</a><h1>${escape(title)}</h1><p>${escape(subtitle)}</p>${actions}`,
    empty: (title, body) => `<div class="workspace-empty"><h3>${escape(title)}</h3><p>${escape(body)}</p></div>`,
    /* As workspace.js: the value is put in as it is given. */
    properties: rows => rows.map(([k, v]) => `<div class="property-row"><span>${k}</span><div>${v}</div></div>`).join(''),
    /* As workspace.js: the title is put in as it is given. */
    linkedPanel: (title, items) => `<section><h2>${title}</h2>${items.map(([route, label, meta]) =>
      `<a href="#${escape(route)}"><strong>${escape(label)}</strong><small>${escape(meta)}</small></a>`).join('')}</section>`,
    notFound: () => '<p>Record not found</p>',
    revenueChart: () => '<div class="revenue-chart"></div>',
    financeDay: () => TODAY,
    CAL: { thisMonth: 'September' },
    routeParts: route,
    financeTab: 'overview',
    invoices: list,
    contacts,
    /* workspace.js's own state: the search box's text, kept across repaints
       (queryInput reads and writes it exactly as the real one does), and the
       revenue chart's own 6/12-month toggle, which the transactions panel
       shares so the two never disagree about what window they show. */
    queries,
    queryInput: (key, placeholder) =>
      `<div class="list-search"><input type="search" data-query="${key}" aria-label="${escape(placeholder)}" placeholder="${escape(placeholder)}" value="${escape(queries[key])}"></div>`,
    range,
    repaintKeepingFocus: () => {},
    workspaceStore: {
      has: part => loaded.includes(part),
      state: { overview, revenueMix: mix, loaded: live },
      /* As store.js's after() does: once the write is in, the workspace is
         loaded and the page drawn again before anyone is told; a refusal is
         said in a toast unless the caller says it itself ({ toast: false }),
         and passed on. */
      after: (work, options) => Promise.resolve(work).then(value => { draw(); return value; }, err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; }),
      transactions: since => { calls.push(['transactions', since]); return txState; },
      retryTransactions: since => { calls.push(['retryTransactions', since]); }
    },
    financeView: () => 'the page app.js drew'
  });
  context.window = context;
  for (const file of ['overview-model.js', 'finance-model.js', 'dialog-forms.js', 'finance-ui.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  function draw() {
    drawn = [...String(context.financeView()).matchAll(/data-invoice-(paid|unpaid)="([^"]+)"/g)].map(m => `[data-invoice-${m[1]}="${m[2]}"]`);
  }
  draw();
  return {
    view: () => context.financeView(),
    click: attributes => (listeners.click || []).forEach(fn => fn({ target: target(attributes), preventDefault() {} })),
    form: () => form,
    fill: values => Object.assign(form.values, values),
    send: () => form.handlers.submit({ preventDefault() {} }),
    submit: async () => { form.handlers.submit({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 0)); },
    toasts, modals, calls, focused, modal: context.modal
  };
}

const load = options => start(options).view;

test('what anyone typed into an invoice stays text: in the list, the figures, the mix and the invoice page', () => {
  const typed = invoice({ number: TYPED, client: TYPED, client_email: TYPED, notes: TYPED, currency: TYPED });
  const overview = { revenue_month: 10, revenue_currency: 'USD', revenue_by_currency: [{ currency: TYPED, month: 5 }] };
  const mix = [{ category: TYPED, amount: 10, currency: TYPED }];
  const list = load({ list: [typed], overview, mix })();
  assert.doesNotMatch(list, MARKUP);
  assert.match(list, /&lt;img src=x onerror=alert\(1\)&gt;/, 'shown as the text it is');
  const page = load({ list: [typed], route: ['finance', U1], contacts: [{ id: 'c-1', name: TYPED, email: TYPED }] })();
  assert.doesNotMatch(page, MARKUP);
  assert.match(page, /<a href="#crm\/c-1">/, 'and the contact with that address is still found');
  const alone = load({ list: [typed], route: ['finance', U1] })();
  assert.doesNotMatch(alone, MARKUP, 'and with no contact at that address');
  assert.match(alone, /<p>&lt;img src=x onerror=alert\(1\)&gt;<\/p>/);

  const itemised = invoice({ finance_invoice_lines: [{ id: 'l1', description: TYPED, quantity: 1, unit_amount: 1, amount: 1 }] });
  const linesPage = load({ list: [itemised], route: ['finance', U1] })();
  assert.doesNotMatch(linesPage, MARKUP, 'a line item\'s own description');
  assert.match(linesPage, /<td>&lt;img src=x onerror=alert\(1\)&gt;<\/td>/);

  const query = load({ list: [invoice()], route: ['finance', 'invoices'], query: TYPED })();
  assert.doesNotMatch(query, MARKUP, 'the search box carries back what was typed, escaped');
  assert.match(query, /value="&lt;img src=x onerror=alert\(1\)&gt;"/);
});

test('what anyone types on a bank or card statement stays text on the transactions panel', () => {
  const rows = [{ id: 't1', posted_at: '2026-09-01', description: TYPED, counterparty: TYPED, kind: TYPED, amount: '1', currency: 'USD' }];
  const page = load({ transactions: { state: 'ready', rows } })();
  assert.doesNotMatch(page, MARKUP);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a row opens its invoice by its uuid, in lower case, and the invoice number is a link to it', () => {
  const html = load({ list: [invoice({ id: U1.toUpperCase() })] })();
  assert.match(html, new RegExp(`<tr data-action="invoice" data-id="${U1}"><td><a class="record-link" href="#finance/${U1}"><strong>INV-1042</strong></a></td>`));
});

test('an invoice without a uuid a link could carry is listed, and opens nothing', () => {
  const html = load({ list: [invoice({ id: 'invoice-7' })] })();
  assert.match(html, /<tr><td><strong>INV-1042<\/strong><\/td>/);
  assert.doesNotMatch(html, /data-action="invoice"/);
});

test('what did not load says so: the figures are dashes, the count is no zero, and no empty table is drawn', () => {
  const html = load({ loaded: [] })();
  assert.match(html, /Invoices did not load/);
  assert.match(html, /The revenue mix did not load/);
  assert.match(html, /<span>Revenue this month<\/span><strong>—<\/strong><small>September · did not load<\/small>/);
  assert.match(html, /<span>Listed invoices<\/span><strong>—<\/strong><small>Not loaded<\/small>/);
  assert.match(html, /<span>Awaiting payment<\/span><strong>—<\/strong><small>Not loaded<\/small>/);
  assert.match(html, /Recent invoices <span class="small-count">—<\/span>/);
  assert.doesNotMatch(html, /<table/);
});

test('no invoices yet, and no income this month, are each said once — with no table of headings', () => {
  const html = load({ overview: { revenue_month: 0, revenue_currency: 'EUR' } })();
  assert.match(html, /No invoices yet\./);
  assert.match(html, /No income recorded this month yet\./);
  assert.match(html, /<span>Awaiting payment<\/span><strong>€0\.00<\/strong><small>Nothing awaiting payment<\/small>/);
  assert.doesNotMatch(html, /<table/);
});

test('an address that is not an invoice opens nothing; one opened while invoices did not load says that instead', () => {
  assert.match(load({ list: [invoice()], route: ['finance', '0'] })(), /Record not found/, 'an old place in the list');
  assert.match(load({ list: [invoice()], route: ['finance', 'INV-1042'] })(), /Record not found/, 'a number');
  const waiting = load({ loaded: [], route: ['finance', U1] })();
  assert.doesNotMatch(waiting, /Record not found/);
  assert.match(waiting, /Invoices did not load/);
  assert.match(load({ loaded: [], route: ['finance', '0'] })(), /Record not found/,
    'an address that is no invoice\'s, even while invoices did not load');
});

test('an invoice is due today, or late, as of the day financeDay() gives', () => {
  const html = load({ list: [invoice({ due_on: TODAY }), invoice({ id: U2, number: 'INV-1043', due_on: '2026-09-10' })] })();
  assert.match(html, /<td>Due today<\/td>/);
  assert.match(html, /<span class="pill">Overdue<\/span><\/td><td>Due Sep 10 · 4 days late<\/td>/);
  assert.match(html, /<small>1 invoice overdue · Next due Sep 14<\/small>/);
});

test('money waiting with no due date says that no due date is set', () => {
  const html = load({ list: [invoice({ due_on: null })] })();
  assert.match(html, /<span>Awaiting payment<\/span><strong>\$1,234\.50<\/strong><small>No due date set<\/small>/);
});

test('the invoice table is named by its heading, and the column that opens a row has a name too', () => {
  const html = load({ list: [invoice()] })();
  assert.match(html, /<h2 id="finance-invoices-heading">Recent invoices <span class="small-count">1<\/span><\/h2>/);
  assert.match(html, /<table class="module-table" aria-labelledby="finance-invoices-heading">/);
  assert.match(html, /<th><span class="sr-only">Open<\/span><\/th>/);
});

/* ── The document: matching invoice-pdf.ts, tax, lines, last changed ─────── */

test('the printed invoice gives Veyago\'s real registered address and EIN, matching invoice-pdf.ts, never "New York"', () => {
  const page = load({ list: [invoice()], route: ['finance', U1] })();
  assert.match(page, /54 State Street, Ste 804 #17055/);
  assert.match(page, /Albany, NY 12207, USA/);
  assert.match(page, /EIN 30-1492188/);
  assert.doesNotMatch(page, /New York/, 'the page used to disagree with the real document about where Veyago is');
  assert.match(page, /The document the client actually received.+is the PDF sent from the admin/,
    'and says plainly that payment itself — the real document\'s bank details — is not reproduced here');
});

test('an invoice\'s lines are drawn in the order they arrive — queries.js already asked the database for sort_order — and tax is one more row after them', () => {
  /* Not re-sorted here: the query (queries.js invoices()) already orders by
     sort_order, and doing it again client-side would be a second place that
     could disagree with the first about what "in order" means. */
  const lines = [
    { id: 'l1', description: 'Design', quantity: '2.00', unit_amount: '100.00', amount: '200.00', sort_order: 0 },
    { id: 'l2', description: 'Development', quantity: '10.00', unit_amount: '100.00', amount: '1000.00', sort_order: 1 }
  ];
  const page = load({ list: [invoice({ finance_invoice_lines: lines, tax_rate: '8.875', tax_amount: '106.50' })], route: ['finance', U1] })();
  const design = page.indexOf('Design');
  const development = page.indexOf('Development');
  const tax = page.indexOf('Tax (8.875%)');
  assert.ok(design > -1 && development > design, 'the array\'s own order, not re-sorted');
  assert.ok(tax > development, 'tax comes after the lines');
  assert.match(page, /<td>Design<\/td><td>2<\/td><td>\$200\.00<\/td>/, 'a whole quantity has no ".00" nailed onto it, unlike an amount, which always keeps its cents');
  assert.match(page, /<td>Development<\/td><td>10<\/td><td>\$1,000\.00<\/td>/);
  assert.match(page, /<td colspan="2">Tax \(8\.875%\)<\/td><td>\$106\.50<\/td>/);
});

test('an invoice with no lines recorded yet still shows its own description and total as its one line, and no tax row', () => {
  const page = load({ list: [invoice({ notes: 'Site build', finance_invoice_lines: [] })], route: ['finance', U1] })();
  assert.match(page, /<td>Site build<\/td><td>1<\/td><td>\$1,234\.50<\/td>/);
  assert.doesNotMatch(page, /Tax \(/);
  assert.doesNotMatch(page, /<td colspan="2">Tax<\/td>/, 'no tax_amount recorded means no tax row at all');
});

test('a quantity or a tax rate that is not a number does not throw, and reads as a dash or a bare "Tax"', () => {
  const page = load({
    list: [invoice({
      finance_invoice_lines: [{ id: 'l1', description: 'Odd row', quantity: 'not-a-number', unit_amount: 1, amount: 5 }],
      tax_amount: '12.00', tax_rate: null
    })], route: ['finance', U1]
  })();
  assert.match(page, /<td>Odd row<\/td><td>—<\/td>/);
  assert.match(page, /<td colspan="2">Tax<\/td><td>\$12\.00<\/td>/, 'a rate that is not recorded says only "Tax"');
});

test('the invoice\'s aside says when it last changed, or a dash before that ever arrives', () => {
  const changed = load({ list: [invoice({ updated_at: '2026-09-01T10:00:00Z' })], route: ['finance', U1] })();
  assert.match(changed, /<span>Last changed<\/span><div>Sep 1<\/div>/);
  const none = load({ list: [invoice({ updated_at: null })], route: ['finance', U1] })();
  assert.match(none, /<span>Last changed<\/span><div>—<\/div>/);
});

test('an invoice page finds its client by the invoice address, never by a company name two clients can share', () => {
  const contacts = [
    { id: 'c-name', name: 'Someone Else', company: 'Harbor & Co', email: 'someone@else.example' },
    { id: 'c-mail', name: 'Dana Reyes', company: 'Harbor & Co', email: ' Billing@Northline.example ' }
  ];
  const page = load({ list: [invoice()], route: ['finance', U1], contacts })();
  assert.match(page, /<a href="#crm\/c-mail"><strong>Dana Reyes<\/strong>/);
  assert.doesNotMatch(page, /Someone Else/);
  const nobody = load({ list: [invoice()], route: ['finance', U1], contacts: contacts.slice(0, 1) })();
  assert.match(nobody, /<p>billing@northline\.example<\/p>/, 'the address is shown without a contact');
  assert.doesNotMatch(nobody, /#crm\//);
});

test('a paid invoice\'s page says when it was paid, and that nothing is left to pay', () => {
  const page = load({ list: [invoice({ status: 'paid', paid_on: '2026-09-12' })], route: ['finance', U1] })();
  assert.match(page, /PAID ON/);
  assert.match(page, /Sep 12, 2026/);
  assert.match(page, /<span>Balance due<\/span><div>\$0\.00<\/div>/);
});

/* ── Recording a payment ──────────────────────────────────────────────── */

test('an invoice waiting for payment is marked paid on the day it was paid, which cannot be a day still to come', async () => {
  const h = start({ list: [invoice({ due_on: '2026-09-10' })], route: ['finance', U1] });
  const page = h.view();
  assert.match(page, new RegExp(`data-invoice-paid="${U1}"`), 'an overdue invoice too');
  assert.doesNotMatch(page, /data-invoice-unpaid/);
  assert.match(load({ list: [invoice()], route: ['finance', U1] })(), new RegExp(`data-invoice-paid="${U1}"`), 'and one not due yet');
  h.click({ 'data-invoice-paid': U1 });
  assert.equal(h.modals.length, 1);
  assert.match(h.modals[0].body, /<h2>Mark INV-1042 paid<\/h2>/);
  assert.match(h.modals[0].body, new RegExp(`name="paidOn" required min="2026-09-01" max="${TODAY}" value="${TODAY}"`), 'today, unless changed');
  assert.match(h.modals[0].body, /Nobody is charged or emailed|nobody is charged or emailed/, 'it records a payment, it does not collect one');
  h.fill({ paidOn: '2026-09-15' });
  await h.submit();
  assert.deepEqual(h.calls, []);
  assert.equal(h.form().parts['.form-error'].textContent, 'A payment cannot be recorded for a day still to come.');
  assert.equal(h.form().parts['[name="paidOn"]'].focused, 1);
  assert.equal(h.form().parts['[name="paidOn"]'].attributes['aria-invalid'], 'true', 'the problem is tied to the day it is about');
  assert.equal(h.form().parts['[name="paidOn"]'].attributes['aria-describedby'], 'invoice-paid-form-error', 'which reads out what is wrong with it');
  h.fill({ paidOn: '0026-09-12' });
  await h.submit();
  assert.equal(h.form().parts['.form-error'].textContent, 'Pick the day it was paid.', 'a year typed as 26');
  h.fill({ paidOn: '2026-08-30' });
  await h.submit();
  assert.equal(h.form().parts['.form-error'].textContent, 'The invoice was issued on Sep 1: pick that day or a later one.');
  h.fill({ paidOn: '' });
  await h.submit();
  assert.equal(h.form().parts['.form-error'].textContent, 'Pick the day it was paid.');
  h.fill({ paidOn: '2026-09-12' });
  await h.submit();
  assert.deepEqual(h.calls, [['markInvoicePaid', U1, '2026-09-12']]);
  assert.equal(h.form().parts['[name="paidOn"]'].attributes['aria-invalid'], undefined, 'and let go once the day is fine');
  assert.equal(h.form().parts['[name="paidOn"]'].attributes['aria-describedby'], undefined);
  assert.equal(h.modal.open, false);
  assert.equal(h.toasts.at(-1), 'INV-1042 marked paid.');
  assert.deepEqual(h.focused, [`[data-invoice-unpaid="${U1}"]`], 'focus on the button that undoes it, once the page is redrawn');
});

test('an invoice issued on a day still to come on this clock can be paid today: invoice-pdf stamps the UTC day', async () => {
  const h = start({ list: [invoice({ issued_on: '2026-09-15' })], route: ['finance', U1] });
  h.click({ 'data-invoice-paid': U1 });
  assert.match(h.modals[0].body, new RegExp(`name="paidOn" required min="2000-01-01" max="${TODAY}" value="${TODAY}"`), 'a range some day fits in');
  h.fill({ paidOn: TODAY });
  await h.submit();
  assert.equal(h.form().parts['.form-error'].textContent, '');
  assert.deepEqual(h.calls, [['markInvoicePaid', U1, TODAY]]);
});

test('an invoice someone recorded, or that went, while its dialog was open is not changed, and the dialog says why', async () => {
  const list = [invoice()];
  const h = start({ list, route: ['finance', U1] });
  h.click({ 'data-invoice-paid': U1 });
  list[0] = invoice({ status: 'paid', paid_on: '2026-09-13' });
  h.fill({ paidOn: TODAY });
  await h.submit();
  assert.deepEqual(h.calls, []);
  assert.equal(h.form().parts['.form-error'].textContent, 'This invoice is paid now, so nothing was changed. Close this and look again.');
  list.length = 0;
  await h.submit();
  assert.equal(h.form().parts['.form-error'].textContent, 'That invoice is no longer in the list.');
  assert.deepEqual(h.calls, []);
});

test('while the workspace is still loading, no invoice dialog opens', () => {
  const h = start({ list: [invoice()], route: ['finance', U1], live: false });
  h.click({ 'data-invoice-paid': U1 });
  assert.equal(h.modals.length, 0);
  assert.deepEqual(h.toasts, ['Not yet: the workspace is still loading.']);
});

test('a paid invoice is marked unpaid after a question, and a draft has no payment to record', async () => {
  const paid = start({ list: [invoice({ status: 'paid', paid_on: '2026-09-12' })], route: ['finance', U1] });
  const page = paid.view();
  assert.match(page, new RegExp(`data-invoice-unpaid="${U1}"`));
  assert.doesNotMatch(page, /data-invoice-paid/);
  paid.click({ 'data-invoice-unpaid': U1.toUpperCase() });
  assert.match(paid.modals[0].body, /<h2>Mark INV-1042 unpaid\?<\/h2>/);
  assert.doesNotMatch(paid.modals[0].body, /past its due date/, 'due on the 20th, so not late yet');
  await paid.submit();
  assert.deepEqual(paid.calls, [['reopenInvoice', U1, '2026-09-12']]);
  assert.equal(paid.toasts.at(-1), 'INV-1042 marked unpaid.');
  assert.deepEqual(paid.focused, [`[data-invoice-paid="${U1}"]`]);
  const late = start({ list: [invoice({ status: 'paid', paid_on: '2026-09-12', due_on: '2026-09-10' })], route: ['finance', U1] });
  late.click({ 'data-invoice-unpaid': U1 });
  assert.match(late.modals[0].body, /It is past its due date, so it will show as overdue\./);
  const dueToday = start({ list: [invoice({ status: 'paid', paid_on: '2026-09-12', due_on: TODAY })], route: ['finance', U1] });
  dueToday.click({ 'data-invoice-unpaid': U1 });
  assert.doesNotMatch(dueToday.modals[0].body, /past its due date/, 'due today is not late yet');
  const draft = load({ list: [invoice({ status: 'draft' })], route: ['finance', U1] })();
  assert.doesNotMatch(draft, /data-invoice-(paid|unpaid)/);
});

test('Mark unpaid undoes only the payment its dialog showed: one no longer paid, or paid again since, is left as it is', async () => {
  const list = [invoice({ status: 'paid', paid_on: '2026-09-12' })];
  const h = start({ list, route: ['finance', U1] });
  h.click({ 'data-invoice-unpaid': U1 });
  list[0] = invoice({ status: 'sent' });
  await h.submit();
  assert.deepEqual(h.calls, []);
  assert.equal(h.form().parts['.form-error'].textContent, 'This invoice is sent now, so nothing was changed. Close this and look again.');
  list[0] = invoice({ status: 'paid', paid_on: '2026-09-13' });
  await h.submit();
  assert.deepEqual(h.calls, []);
  assert.equal(h.form().parts['.form-error'].textContent, 'This invoice’s payment was recorded again since, so nothing was changed. Close this and look again.');
  list[0] = invoice({ status: 'paid', paid_on: '2026-09-12' });
  await h.submit();
  assert.deepEqual(h.calls, [['reopenInvoice', U1, '2026-09-12']], 'the day it was paid goes with it, for the database to check too');
});

test('a new invoice, and sending one, are the admin\'s, and open it in a new tab', () => {
  const list = load({ list: [invoice()] })();
  assert.match(list, /<a class="btn btn-primary" href="https:\/\/veyago\.cloud\/admin\/invoice-new\/" target="_blank" rel="noopener">/,
    'with the trailing slash the admin redirects to');
  assert.match(list, /<span class="sr-only"> \(opens the admin in a new tab\)<\/span>/);
  const page = load({ list: [invoice()], route: ['finance', U1] })();
  assert.match(page, /created and sent from <a class="record-link" href="https:\/\/veyago\.cloud\/admin\/invoices\/" target="_blank" rel="noopener">the admin/,
    'where the admin lists its invoices');
});

test('a refused change is said on the form, which stays open; only an owner or admin is let change an invoice; one gone says so', async () => {
  const h = start({ list: [invoice()], route: ['finance', U1], refuse: true });
  h.click({ 'data-invoice-paid': U1 });
  h.fill({ paidOn: TODAY });
  h.send();
  h.send();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.length, 1, 'two quick sends write once');
  assert.equal(h.modal.open, true);
  assert.equal(h.form().parts['.form-error'].textContent, 'The invoice was not changed: only an owner or admin can mark an invoice paid.');
  assert.equal(h.form().parts['[type="submit"]'].disabled, false);
  assert.equal(h.form().parts['[type="submit"]'].focused, 1, 'focus back on the button it left while it saved');
  assert.deepEqual(h.focused, [], 'and nothing on the page is focused for a change that did not happen');

  const staff = start({ list: [invoice()], route: ['finance', U1], manager: false });
  staff.click({ 'data-invoice-paid': U1 });
  assert.equal(staff.modals.length, 0);
  assert.deepEqual(staff.toasts, ['Only an owner or admin can change an invoice.']);

  const gone = start({ list: [invoice()], route: ['finance', U1] });
  gone.click({ 'data-invoice-paid': U2 });
  assert.equal(gone.modals.length, 0);
  assert.deepEqual(gone.toasts, ['That invoice is no longer in the list.']);
});

test('what anyone typed into an invoice stays text in its dialogs', () => {
  const h = start({ list: [invoice({ number: TYPED, client: TYPED })], route: ['finance', U1] });
  h.click({ 'data-invoice-paid': U1 });
  assert.equal(h.modals.length, 1);
  assert.doesNotMatch(h.modals[0].body, MARKUP);
  assert.match(h.modals[0].body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const paid = start({ list: [invoice({ number: TYPED, client: TYPED, status: 'paid', paid_on: '2026-09-12' })], route: ['finance', U1] });
  paid.click({ 'data-invoice-unpaid': U1 });
  assert.equal(paid.modals.length, 1);
  assert.doesNotMatch(paid.modals[0].body, MARKUP);
  assert.match(paid.modals[0].body, /<h2>Mark &lt;img src=x onerror=alert\(1\)&gt; unpaid\?<\/h2>/);
});

test('the revenue mix draws each category in the colour the model gives it, with its name beside its amount', () => {
  const mix = [{ category: 'Design', amount: 300, currency: 'USD' }, { category: 'Build', amount: 100, currency: 'USD' }];
  const html = load({ overview: { revenue_month: 400, revenue_currency: 'USD' }, mix })();
  assert.match(html, /<div class="revenue-mix-total">\$400\.00 <small>USD<\/small><\/div>/);
  assert.match(html, /<i style="width:25%;background:#2a78d6"><\/i><i style="width:75%;background:#eb6834"><\/i>/,
    'in name order: Build, then Design');
  assert.match(html, /Build<\/span><strong>\$100\.00<\/strong><small>25%<\/small>/);
});

/* ── Recent transactions, on the Overview tab (0060) ──────────────────────── */

test('recent transactions are drawn on the Overview tab, in the chart\'s own window, signed rather than coloured', () => {
  const rows = [
    { id: 't1', posted_at: '2026-09-10', description: 'Client wire', counterparty: 'Northline', amount: '1200.00', currency: 'USD', kind: 'income' },
    { id: 't2', posted_at: '2026-09-05', description: 'AWS', counterparty: null, amount: '-45.00', currency: 'USD', source: 'mercury' }
  ];
  const h = start({ transactions: { state: 'ready', rows } });
  const page = h.view();
  assert.match(page, /<h2>Recent transactions<\/h2><span class="quiet-text">Last 6 months<\/span>/);
  assert.match(page, /<td>Sep 10<\/td><td><div class="cell-main"><div><strong>Client wire<\/strong><small>Northline<\/small><\/div><\/div><\/td><td>Income<\/td><td>\$1,200\.00<\/td>/);
  assert.match(page, /<td>Sep 5<\/td><td><div class="cell-main"><div><strong>AWS<\/strong><\/div><\/div><\/td><td>Mercury<\/td><td>-\$45\.00<\/td>/,
    'no kind recorded falls back to the sync source, capitalised the same way');
  assert.deepEqual(h.calls.filter(c => c[0] === 'transactions').at(-1), ['transactions', '2026-03-18'], 'six months back from financeDay(), not the machine clock');
});

test('the 12-month range the chart itself is on asks for a wider window, and says so', () => {
  const h = start({ range: '12 months', transactions: { state: 'ready', rows: [] } });
  assert.match(h.view(), /Last 12 months/);
  assert.deepEqual(h.calls.filter(c => c[0] === 'transactions').at(-1), ['transactions', '2025-09-19']);
});

test('transactions still loading, or that did not load, say so; a retry asks the store again', () => {
  const loading = load({ transactions: { state: 'loading', rows: [] } })();
  assert.match(loading, /Loading transactions/);
  assert.doesNotMatch(loading, /table/);

  const empty = load({ transactions: { state: 'ready', rows: [] } })();
  assert.match(empty, /No transactions in this window\./);

  const h = start({ transactions: { state: 'failed', rows: [] } });
  assert.match(h.view(), /Transactions did not load\./);
  h.click({ 'data-finance-tx-retry': '' });
  assert.deepEqual(h.calls.filter(c => c[0] === 'retryTransactions'), [['retryTransactions', '2026-03-18']]);
});

test('more than twenty transactions shows the twenty most recent and says how many there are in all', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, posted_at: '2026-09-01', description: `Row ${i}`, amount: '1', currency: 'USD' }));
  const page = load({ transactions: { state: 'ready', rows } })();
  assert.equal([...page.matchAll(/<tr><td>Sep 1<\/td>/g)].length, 20);
  assert.match(page, /Showing the 20 most recent of 25\./);
});

test('the transactions panel is only on the Overview tab, not the Invoices tab', () => {
  const page = load({ list: [invoice()], route: ['finance', 'invoices'], transactions: { state: 'ready', rows: [{ id: 't1', posted_at: '2026-09-01', description: 'Should not appear', amount: '1', currency: 'USD' }] } })();
  assert.doesNotMatch(page, /Recent transactions/);
  assert.doesNotMatch(page, /Should not appear/);
});

/* ── The Invoices tab: search, a status filter, sortable columns, paging (0060) ── */

/* Three invoices, each a distinct id, number, client, amount and status —
   what a search, a filter and a sort each need to tell apart. */
function ledger() {
  return [
    invoice({ id: U1, number: 'INV-1042', client: 'Harbor & Co', amount: '1234.50', status: 'sent', due_on: '2026-09-20', paid_on: null }),
    invoice({ id: U2, number: 'INV-2001', client: 'Acme', amount: '500.00', status: 'paid', due_on: '2026-08-01', paid_on: '2026-09-05' }),
    invoice({ id: '9f2c4a3b-4d5e-4f60-8a7b-9c0d1e2f3a4c', number: 'INV-1500', client: 'Zenith', amount: '9999.00', status: 'draft', due_on: null, paid_on: null })
  ];
}

test('the Invoices tab can be searched — by number, client or address — and says how many matched', () => {
  const h = start({ list: ledger(), route: ['finance', 'invoices'], query: 'harbor' });
  const page = h.view();
  assert.match(page, /Invoices <span class="small-count">1<\/span>/);
  assert.match(page, /INV-1042/);
  assert.doesNotMatch(page, /INV-2001/);
  assert.doesNotMatch(page, /INV-1500/);
});

test('a search that matches nothing says so, without a table of headings — different words from an empty ledger', () => {
  const some = load({ list: ledger(), route: ['finance', 'invoices'], query: 'not a real client' })();
  assert.match(some, /No invoices match\. Try another search or status\./);
  assert.doesNotMatch(some, /<table/);
  const none = load({ list: [], route: ['finance', 'invoices'] })();
  assert.match(none, /No invoices yet\./);
});

test('the Invoices tab while invoices have not loaded yet offers no search box, and says so, not an empty table', () => {
  const page = load({ list: ledger(), route: ['finance', 'invoices'], loaded: [] })();
  assert.match(page, /Invoices did not load\. They are tried again by themselves\./);
  assert.doesNotMatch(page, /data-query="finance"/);
  assert.doesNotMatch(page, /data-finance-status/);
  assert.match(page, /Invoices <span class="small-count">—<\/span>/);
});

test('the Invoices tab can be filtered to one status', () => {
  const h = start({ list: ledger(), route: ['finance', 'invoices'] });
  const page = h.view();
  assert.match(page, /data-finance-status="" class="active" aria-pressed="true">All statuses/);
  h.click({ 'data-finance-status': 'paid' });
  const filtered = h.view();
  assert.match(filtered, /Invoices <span class="small-count">1<\/span>/);
  assert.match(filtered, /INV-2001/);
  assert.doesNotMatch(filtered, /INV-1042/);
  assert.match(filtered, /data-finance-status="paid" class="active" aria-pressed="true">Paid/);
});

test('a column can be sorted, and sorting it again reverses it', () => {
  const h = start({ list: ledger(), route: ['finance', 'invoices'] });
  h.click({ 'data-finance-sort': 'amount' });
  const asc = h.view();
  const order = n => asc.indexOf(n);
  assert.ok(order('INV-2001') < order('INV-1042') && order('INV-1042') < order('INV-1500'), 'ascending: 500, 1234.50, 9999');
  assert.match(asc, /<th aria-sort="ascending"><button type="button" class="sort-header" data-finance-sort="amount">Amount ▲<\/button><\/th>/);

  h.click({ 'data-finance-sort': 'amount' });
  const desc = h.view();
  const order2 = n => desc.indexOf(n);
  assert.ok(order2('INV-1500') < order2('INV-1042') && order2('INV-1042') < order2('INV-2001'), 'the same column again reverses it');
  assert.match(desc, /aria-sort="descending"/);

  h.click({ 'data-finance-sort': 'client' });
  const byClient = h.view();
  assert.match(byClient, /data-finance-sort="client">Client ▲/, 'a different column starts ascending again');
});

test('sorting by "Due / paid" reads whichever date the column itself shows: paid_on once paid, due_on otherwise', () => {
  const h = start({ list: ledger(), route: ['finance', 'invoices'] });
  h.click({ 'data-finance-sort': 'due' });
  const page = h.view();
  const order = n => page.indexOf(n);
  /* INV-2001 paid 2026-09-05; INV-1042 due 2026-09-20; INV-1500 (draft) has no date at all, and sorts first as the empty string. */
  assert.ok(order('INV-1500') < order('INV-2001') && order('INV-2001') < order('INV-1042'));
});

test('a page of invoices, not all of them at once: "Show more" reveals the rest, and a new search starts over at the first page', () => {
  const many = Array.from({ length: 51 }, (_, i) => invoice({ id: `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, number: `INV-${1000 + i}` }));
  const h = start({ list: many, route: ['finance', 'invoices'] });
  const first = h.view();
  assert.equal([...first.matchAll(/<tr data-action="invoice"/g)].length, 50);
  assert.match(first, /Show 1 more<\/button> — showing 50 of 51/);
  h.click({ 'data-finance-more': '' });
  const all = h.view();
  assert.equal([...all.matchAll(/<tr data-action="invoice"/g)].length, 51);
  assert.doesNotMatch(all, /list-limit/);

  h.click({ 'data-finance-status': 'draft' });
  const filteredAfterPaging = h.view();
  assert.doesNotMatch(filteredAfterPaging, /list-limit/, 'a filter that leaves fewer than a page needs no "Show more" left over from before');
});

test('the Overview tab\'s own "Recent invoices" has none of the Invoices tab\'s controls', () => {
  const page = load({ list: ledger() })();
  assert.doesNotMatch(page, /data-finance-status/);
  assert.doesNotMatch(page, /data-finance-sort/);
  assert.match(page, /Recent invoices <span class="small-count">3<\/span>/);
});
