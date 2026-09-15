/* Finance, without a page: which invoice a link opens, what an invoice's status
   is today, when it falls due or was paid, what is waiting to be paid in each
   currency, amounts with their cents, what search finds, the revenue mix's
   colours and who may see any of it. Loaded into a sandbox the way <script>
   tags run it, beside overview-model.js, whose revenue figures it reuses —
   except the last test, which reads workspace.js as text: wiring this model in
   retires helpers there that another view may still call.
   Run from the repo root with: node --test

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence the [...spread] and {...spread} before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console });
for (const file of ['overview-model.js', 'finance-model.js']) {
  vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
}
const model = vm.runInContext('financeModel', context);
const overview = vm.runInContext('overviewModel', context);

const TODAY = '2026-09-14';
const I1 = 'b1000000-0000-4000-8000-000000000001';
const I2 = 'b1000000-0000-4000-8000-000000000002';

const label = status => status.charAt(0).toUpperCase() + status.slice(1);
/* What queries.invoices() hands the store: the number as `id`, the uuid as
   `uuid`, the amount already formatted without its cents, the status as a
   label and the issue date as `date` — with the row itself under `row`. */
const invoice = (over = {}) => {
  const row = {
    id: I1, number: 'INV-1042', client: 'Northline', client_email: 'billing@northline.example',
    amount: 1234.5, currency: 'USD', status: 'sent',
    issued_on: '2026-09-01', due_on: '2026-09-20', paid_on: null, notes: 'Site build, phase 1',
    ...over
  };
  return {
    id: row.number, uuid: row.id, client: row.client, description: row.notes || '',
    amount: '$1,235', status: label(String(row.status)), date: 'Sep 1', row
  };
};

/* ── Which invoice a link opens ──────────────────────────────────────── */

test('an invoice is found by its uuid — not by its number, and not by its place in the list', () => {
  const list = [invoice({ id: I1, number: 'INV-1' }), invoice({ id: I2, number: 'INV-2' })];
  assert.equal(model.invoiceById(list, I2).row.number, 'INV-2');
  assert.equal(model.invoiceById([...list].reverse(), I2).row.number, 'INV-2', 'a reload that reorders the list must not change what a link opens');
  assert.equal(model.invoiceById(list, I2.toUpperCase()).row.number, 'INV-2');
  assert.equal(model.invoiceById(list, '1'), null, 'an old position-based link opens nothing rather than the wrong invoice');
  assert.equal(model.invoiceById(list, 1), null);
  assert.equal(model.invoiceById(list, 'INV-2'), null, 'search used to open an invoice by its number, and a number is not unique');
  assert.equal(model.invoiceById(list, ''), null);
  assert.equal(model.invoiceById(null, I1), null);
});

test('a link to an invoice carries its uuid, and nothing else can become one', () => {
  assert.equal(model.invoiceRoute(invoice()), `finance/${I1}`);
  assert.equal(model.routeKey(invoice()), I1);
  assert.equal(model.invoiceRoute({ id: I2, number: 'INV-9', client: 'Harbor' }), `finance/${I2}`, 'a row as the database returns it');
  assert.equal(model.invoiceRoute(invoice({ id: '"><img src=x onerror=alert(1)>' })), null, 'what is not a uuid never reaches an address');
  assert.equal(model.invoiceRoute(invoice({ id: null })), null);
  assert.equal(model.invoiceRoute(null), null);
});

test('a Finance address opens the overview, the invoice list or one invoice — any other key is an invoice not found', () => {
  const route = parts => ({ ...model.financeRoute(parts) });
  assert.deepEqual(route(['finance']), { tab: 'overview', record: false, invoiceId: null });
  assert.deepEqual(route(['finance', '']), { tab: 'overview', record: false, invoiceId: null });
  assert.deepEqual(route(null), { tab: 'overview', record: false, invoiceId: null });
  assert.deepEqual(route(['finance', 'invoices']), { tab: 'invoices', record: false, invoiceId: null });
  assert.deepEqual(route(['finance', I1]), { tab: 'invoices', record: true, invoiceId: I1 });
  assert.deepEqual(route(['finance', I1.toUpperCase()]), { tab: 'invoices', record: true, invoiceId: I1 });
  for (const key of ['0', 'INV-1042', 'constructor', 'overview']) {
    assert.deepEqual(route(['finance', key]), { tab: 'invoices', record: true, invoiceId: null }, key);
  }

  /* The breadcrumb reads the same addresses the same way. */
  const data = { labels: { finance: 'Finance' }, invoices: [model.shapeInvoice(invoice(), TODAY)] };
  assert.equal(overview.crumb('finance', ['finance', '0'], data).current, 'Not found');
  assert.equal(overview.crumb('finance', ['finance', 'invoices'], data).current, 'Invoices');
  assert.equal(overview.crumb('finance', ['finance', I1], data).current, 'INV-1042');
});

/* ── Status ──────────────────────────────────────────────────────────── */

test('a sent invoice is overdue from the day after its due date, whatever its stored status says', () => {
  const on = (over, today = TODAY) => model.statusOf(invoice(over), today);
  assert.equal(on({ due_on: '2026-09-13' }), 'overdue', 'nobody has to remember to change the stored status');
  assert.equal(on({ due_on: TODAY }), 'sent', 'due today is not late yet');
  assert.equal(on({ due_on: '2026-09-15' }), 'sent');
  assert.equal(on({ due_on: null }), 'sent', 'no due date, nothing to be late for');
  assert.equal(on({ status: 'overdue', due_on: '2026-10-01' }), 'overdue', 'marked overdue by hand stays overdue, as in the admin');
  assert.equal(on({ status: 'paid', due_on: '2026-09-01' }), 'paid');
  assert.equal(on({ status: 'draft', due_on: '2026-09-01' }), 'draft', 'a draft is owed by nobody, so it is never late');
  /* Called directly: the helper's default would stand in for a missing today. */
  assert.equal(model.statusOf(invoice({ due_on: '2026-09-13' })), 'sent', 'without today there is nothing to compare with');
  assert.equal(model.statusOf(invoice({ due_on: '2026-09-13' }), '2026-02-30'), 'sent', 'nor with a day that is not one');
});

test('a status is the same read from the row or from its label, and there are four', () => {
  assert.deepEqual([...model.STATUSES].map(s => s.value), ['draft', 'sent', 'overdue', 'paid'], 'what finance_invoices allows (0005)');
  assert.equal(model.statusOf({ status: 'Paid' }, TODAY), 'paid');
  assert.equal(model.statusOf({ row: { status: 'draft' } }, TODAY), 'draft');
  assert.equal(model.statusOf({ status: 'Pending' }, TODAY), null, 'something unknown is nothing');
  assert.equal(model.statusLabel('overdue'), 'Overdue');
  assert.equal(model.statusLabel('nonsense'), '');
});

/* ── Due and paid ────────────────────────────────────────────────────── */

test('"Due / paid" says when an invoice falls due or was paid — never the day it was issued', () => {
  const said = (over, today = TODAY) => model.dueOrPaid(invoice(over), today);
  assert.equal(said({}), 'Due Sep 20', 'issued Sep 1, which the column used to show');
  assert.equal(said({ due_on: TODAY }), 'Due today');
  assert.equal(said({ due_on: '2026-09-13' }), 'Due Sep 13 · 1 day late');
  assert.equal(said({ due_on: '2026-09-10' }), 'Due Sep 10 · 4 days late');
  assert.equal(said({ due_on: '2025-12-30' }), 'Due Dec 30, 2025 · 258 days late');
  assert.equal(said({ status: 'overdue', due_on: '2026-10-01' }), 'Due Oct 1', 'no lateness before the date itself');
  assert.equal(said({ status: 'paid', paid_on: '2026-09-12' }), 'Paid Sep 12');
  assert.equal(said({ status: 'paid', paid_on: undefined }), 'Paid', 'a payment date that did not load is not made up');
  assert.equal(said({ due_on: null }), 'No due date');
  assert.equal(said({ status: 'draft', due_on: '2026-09-01' }), 'Due Sep 1', 'a draft is not late');
});

test('a date is its own day wherever the browser is, with the year when it is not this year', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(model.shortDate('2026-10-01', TODAY), 'Oct 1', 'read as local midnight, it would be Sep 30 in California');
    assert.equal(model.dueOrPaid(invoice({ due_on: '2026-10-01' }), TODAY), 'Due Oct 1');
    assert.equal(model.shapeInvoice(invoice({ due_on: '2026-10-01' }), TODAY).dateValue, 'Oct 1, 2026');
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.equal(model.shortDate('2025-12-30', TODAY), 'Dec 30, 2025');
  assert.equal(model.shortDate('2026-12-30', TODAY), 'Dec 30');
  assert.equal(model.shortDate('2026-02-30', TODAY), '', 'not a date');
  assert.equal(model.shortDate(null, TODAY), '');
  assert.equal(model.shortDate('2026-10-01'), 'Oct 1, 2026', 'without today, the year is always given');
});

/* ── Waiting to be paid ──────────────────────────────────────────────── */

const plain = entries => [...entries].map(entry => ({ ...entry }));

test('awaiting payment is what was sent and is not paid yet — late or not, and never a draft', () => {
  const list = [
    invoice({ amount: 100, due_on: '2026-09-20' }),
    invoice({ amount: 50.25, due_on: '2026-09-10' }),
    invoice({ status: 'draft', amount: 999 }),
    invoice({ status: 'paid', amount: 10, paid_on: '2026-09-02' }),
    invoice({ status: 'overdue', amount: 20, currency: 'EUR', due_on: null })
  ];
  assert.deepEqual(plain(model.awaitingPayment(list, TODAY, 'USD')), [
    { currency: 'USD', count: 2, cents: 15025, amount: 150.25, money: '$150.25', overdue: 1, overdueCents: 5025, overdueMoney: '$50.25', nextDue: '2026-09-20' },
    { currency: 'EUR', count: 1, cents: 2000, amount: 20, money: '€20.00', overdue: 1, overdueCents: 2000, overdueMoney: '€20.00', nextDue: null }
  ]);
});

test('each currency is added up on its own — the studio\'s first, then the one with the most invoices', () => {
  const of = (currency, n) => Array.from({ length: n }, () => invoice({ currency, amount: 1 }));
  const list = [...of('GBP', 2), ...of('EUR', 1), ...of('USD', 3)];
  const order = main => [...model.awaitingPayment(list, TODAY, main)].map(entry => entry.currency);
  assert.deepEqual(order('EUR'), ['EUR', 'USD', 'GBP'], 'the studio\'s currency first, as the Overview orders them (0041)');
  assert.deepEqual(order(null), ['USD', 'GBP', 'EUR']);
  assert.deepEqual([...model.awaitingPayment([...of('JPY', 1), ...of('CHF', 1)], TODAY)].map(entry => entry.currency), ['CHF', 'JPY'],
    'a tie goes by the code');
  const spelled = [invoice({ currency: ' eur ', amount: 1 }), invoice({ currency: 'EUR', amount: 2 }), invoice({ currency: '', amount: 4 })];
  assert.deepEqual([...model.awaitingPayment(spelled, TODAY)].map(entry => [entry.currency, entry.cents]), [['EUR', 300], ['USD', 400]],
    'grouped as the database groups them: trimmed and in upper case, a blank being the column\'s default');
});

test('adding invoices up keeps every cent', () => {
  const [usd] = model.awaitingPayment([invoice({ amount: 0.1 }), invoice({ amount: 0.2 }), invoice({ amount: '1234.50' })], TODAY);
  assert.equal(usd.cents, 123480);
  assert.equal(usd.money, '$1,234.80', 'not rounded to $1,235, and not 0.30000000000000004 of anything');
  assert.equal(model.awaitingPayment([invoice({ amount: 'lots' }), invoice({ amount: 5 })], TODAY)[0].count, 1,
    'an amount that is not a number is left out, not counted as nothing');
});

test('the next due date is the soonest one still ahead, not one already missed', () => {
  const list = [
    invoice({ due_on: '2026-09-10' }), invoice({ due_on: '2026-09-25' }),
    invoice({ due_on: '2026-09-18' }), invoice({ status: 'draft', due_on: '2026-09-15' })
  ];
  assert.equal(model.awaitingPayment(list, TODAY)[0].nextDue, '2026-09-18', 'a draft is not due to be paid');
  assert.equal(model.awaitingPayment([invoice({ due_on: TODAY })], TODAY)[0].nextDue, TODAY, 'due today is still ahead');
  assert.equal(model.awaitingPayment([invoice({ due_on: '2026-09-10' })], TODAY)[0].nextDue, null);
});

/* ── The page's figures ──────────────────────────────────────────────── */

test('the page\'s figures: revenue is the Overview\'s own, invoices are added up per currency', () => {
  const o = {
    revenue_currency: 'EUR', revenue_month: 1200, revenue_prev_month: 1000, revenue_prev_through: '2026-08-14',
    revenue_by_currency: [{ currency: 'EUR', month: 1200, previous: 1000 }, { currency: 'USD', month: 300, previous: 0 }],
    invoices_outstanding: { count: 1, currency: 'EUR', amount: 20, due_next: null, by_currency: [] }
  };
  const list = [
    invoice({ amount: 100 }),
    invoice({ status: 'paid', amount: 40, currency: 'EUR', paid_on: '2026-09-03' }),
    invoice({ status: 'draft', amount: 5 }),
    invoice({ status: 'overdue', amount: 20, currency: 'EUR' })
  ];
  const figures = model.figures({ overview: o, invoices: list, today: TODAY });
  assert.deepEqual({ ...figures.revenue }, { ...overview.revenueFigures(o) }, 'worked out once, in overview-model.js');
  assert.equal(figures.revenue.trend, 20);
  assert.equal(figures.count, 4);
  assert.deepEqual([...figures.awaiting].map(e => [e.currency, e.money]), [['EUR', '€20.00'], ['USD', '$100.00']],
    'the studio\'s currency first, and the draft is not waiting for anything');
  assert.deepEqual([...figures.paid].map(e => [e.currency, e.money]), [['EUR', '€40.00']]);
  assert.deepEqual([...figures.listed].map(e => [e.currency, e.count, e.money]), [['EUR', 2, '€60.00'], ['USD', 2, '$105.00']]);
  assert.equal(model.moneyList(figures.awaiting), '€20.00 · $100.00', 'side by side, never added together');
});

test('figures that did not load are not zeros, and paid invoices are never passed off as this month\'s revenue', () => {
  const none = model.figures({ overview: null, invoices: null, today: TODAY });
  assert.deepEqual({ ...none }, { revenue: null, count: null, listed: null, paid: null, awaiting: null });
  assert.equal(model.moneyList(none.awaiting), '—');
  assert.equal(model.figures({ overview: null, invoices: [invoice({ status: 'paid', amount: 500 })], today: TODAY }).revenue, null,
    'the page used to add up paid invoices when the database had not answered');
  assert.equal(model.figures({ overview: { revenue_month: null, tickets_open: 3 }, invoices: [], today: TODAY }).revenue, null,
    'an overview without money in it has no revenue to show');
  assert.equal(model.moneyList([], 'EUR'), '€0.00', 'nothing waiting is nothing, in the studio\'s currency');
  assert.equal(model.moneyList([]), '$0.00');
});

/* ── Money ───────────────────────────────────────────────────────────── */

test('an amount is shown with its cents, in its own currency', () => {
  assert.equal(model.money(1234.5, 'USD'), '$1,234.50');
  assert.equal(model.money(1200, 'EUR'), '€1,200.00');
  assert.equal(model.money('99.9', 'gbp'), '£99.90');
  assert.equal(model.money(1234, 'JPY'), '¥1,234', 'a currency without cents shows none');
  assert.equal(model.money(-50, 'USD'), '-$50.00');
  assert.equal(model.money(-0.001, 'USD'), '$0.00', 'not "-$0.00"');
  assert.equal(model.money(0.1 + 0.2, 'USD'), '$0.30');
  assert.equal(model.money(10, ''), '$10.00', 'a blank currency is the column\'s default, USD');
  assert.equal(model.money(10, 'US$'), '10.00 US$', 'a code Intl cannot format is written beside the number, not thrown');
  assert.equal(model.money(null, 'USD'), '—');
  assert.equal(model.money('lots', 'USD'), '—');
  assert.equal(model.money('', 'USD'), '—');
});

/* ── An invoice on the page ──────────────────────────────────────────── */

test('an invoice as the page shows it: plain values in its own currency, with its balance', () => {
  const sent = model.shapeInvoice(invoice({ amount: 1234.5, currency: 'EUR' }), TODAY);
  assert.equal(sent.id, 'INV-1042', 'still the number, as the breadcrumb, the bell and search read it');
  assert.equal(sent.uuid, I1);
  assert.equal(sent.route, `finance/${I1}`);
  assert.equal(sent.number, 'INV-1042');
  assert.equal(sent.client, 'Northline');
  assert.equal(sent.clientEmail, 'billing@northline.example');
  assert.equal(sent.description, 'Site build, phase 1');
  assert.equal(sent.currency, 'EUR', 'the invoice\'s own currency, not "USD" written into the page');
  assert.equal(sent.cents, 123450);
  assert.equal(sent.amount, '€1,234.50');
  assert.equal(sent.balance, '€1,234.50');
  assert.equal(sent.status, 'Sent');
  assert.equal(sent.statusValue, 'sent');
  assert.equal(sent.issued, 'Sep 1');
  assert.equal(sent.dueOrPaid, 'Due Sep 20');
  assert.deepEqual([sent.dateHeading, sent.dateValue], ['Due date', 'Sep 20, 2026']);

  assert.equal(model.shapeInvoice(invoice({ due_on: '2026-09-10' }), TODAY).status, 'Overdue', 'it used to say Sent');

  const paid = model.shapeInvoice(invoice({ status: 'paid', paid_on: '2026-09-12', currency: 'EUR' }), TODAY);
  assert.equal(paid.balance, '€0.00');
  assert.deepEqual([paid.dateHeading, paid.dateValue], ['Paid on', 'Sep 12, 2026']);
  assert.equal(model.shapeInvoice(invoice({ status: 'paid', paid_on: undefined }), TODAY).dateValue, 'Not recorded');
  assert.equal(model.shapeInvoice(invoice({ due_on: null }), TODAY).dateValue, 'No due date');
});

test('the number and the client come back as the text they are — escaping stays with the page', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const shaped = model.shapeInvoice(invoice({ number: hostile, client: 'A & B "Studio"' }), TODAY);
  assert.equal(shaped.number, hostile, 'text, neither escaped here nor dropped');
  assert.equal(shaped.id, hostile);
  assert.equal(shaped.client, 'A & B "Studio"');
  assert.equal(shaped.route, `finance/${I1}`, 'the address is the uuid, whatever the number says');
  assert.equal(model.shapeInvoice(invoice({ number: 1042 }), TODAY).number, '1042', 'a number is text');
});

/* ── Search ──────────────────────────────────────────────────────────── */

test('search finds an invoice by its number however it is typed, and by its client', () => {
  const v = invoice();
  for (const typed of ['INV-1042', 'inv-1042', 'inv 1042', '#1042', '1042', 'ＩＮＶ－１０４２']) {
    assert.equal(model.matchesQuery(v, typed), true, typed);
  }
  for (const typed of ['northline', 'NORTH', 'billing@northline', 'site build']) {
    assert.equal(model.matchesQuery(v, typed), true, typed);
  }
  assert.equal(model.matchesQuery(invoice({ client: 'Harbor & Co' }), 'harbor co'), true, 'nobody types the "&"');
  assert.equal(model.matchesQuery(v, '1043'), false);
  assert.equal(model.matchesQuery(v, 'Harbor'), false);
  assert.equal(model.matchesQuery(v, '   '), true, 'no search is everything');
  assert.match(model.searchText(v), /inv-1042/);
});

/* ── The revenue mix ─────────────────────────────────────────────────── */

const mixRow = (category, amount, currency = 'EUR') => ({ category, amount, share: 0, currency });

test('every category in the revenue mix has a colour of its own, however many there are', () => {
  const names = ['Sales', 'Retainers', 'Hosting', 'Licences', 'Workshops', 'Consulting', 'Support', 'Grants'];
  const eight = model.revenueMix(names.map((name, i) => mixRow(name, 1000 - i * 10)));
  const colours = [...eight.slices].map(s => s.colour);
  assert.equal(new Set(colours).size, 8, 'the fourth category used to share the first one\'s colour');
  assert.ok(colours.every(c => model.PALETTE.includes(c)));

  const many = model.revenueMix([...names, 'Rent', 'Refunds', 'Interest', 'Royalties'].map((name, i) => mixRow(name, 1200 - i * 50)));
  const slices = [...many.slices];
  assert.equal(slices.length, 8);
  assert.equal(new Set(slices.map(s => s.colour)).size, 8, 'past eight, the smallest fold into one slice rather than repeat a colour');
  const tail = slices[slices.length - 1];
  assert.deepEqual([tail.folded, tail.label, tail.colour, tail.count], [true, '5 other categories', model.FOLDED, 5]);
  assert.equal(slices.reduce((n, s) => n + s.cents, 0), many.cents, 'folding keeps every euro in the total');
});

test('a category keeps its colour when income moves between categories', () => {
  const colourOf = (mix, name) => [...mix.slices].find(s => s.category === name).colour;
  const before = model.revenueMix([mixRow('Sales', 800), mixRow('Consulting', 200)]);
  const after = model.revenueMix([mixRow('Consulting', 900), mixRow('Sales', 100)]);
  assert.equal(colourOf(after, 'Sales'), colourOf(before, 'Sales'), 'a colour follows its category, not its rank');
  assert.equal(colourOf(after, 'Consulting'), colourOf(before, 'Consulting'));
  assert.deepEqual([...after.slices].map(s => s.slot), [1, 2], 'slices side by side in the bar are side by side in the palette');
});

test('uncategorised income keeps its name, after the categories, and is never folded away', () => {
  const named = Array.from({ length: 10 }, (_, i) => mixRow(`Category ${String.fromCharCode(65 + i)}`, 100 + i));
  const mix = model.revenueMix([mixRow('Uncategorised', 1), mixRow('', 1), ...named]);
  assert.deepEqual([...mix.slices].map(s => s.label), [
    'Category E', 'Category F', 'Category G', 'Category H', 'Category I', 'Category J', 'Uncategorised', '4 other categories'
  ], 'the largest named categories keep a colour; the rest fold into one slice');
  assert.equal([...mix.slices].find(s => s.label === 'Uncategorised').cents, 200, 'a blank category is uncategorised income too');
});

test('the mix adds up: shares from the amounts, widths the bar can use, and colours only from the palette', () => {
  const mix = model.revenueMix([
    { category: 'Sales', amount: '2000.00', share: 'x', currency: 'eur' },
    { category: 'red;background:url(https://example.com/x)', amount: 1000, share: '100%;left:0', currency: 'EUR' },
    { category: 'Nothing', amount: 0, currency: 'EUR' },
    { category: 'Broken', amount: 'n/a', currency: 'EUR' },
    null
  ]);
  const slices = [...mix.slices];
  assert.deepEqual(slices.map(s => s.category), ['red;background:url(https://example.com/x)', 'Sales'], 'nothing earned is no slice');
  assert.deepEqual(slices.map(s => s.share), [33.3, 66.7], 'worked out from the amounts, not read from the row');
  assert.ok(slices.every(s => typeof s.width === 'number' && s.width >= 0 && s.width <= 100));
  assert.ok(Math.abs(slices.reduce((n, s) => n + s.width, 0) - 100) < 1e-9, 'the bar is full');
  assert.deepEqual(slices.map(s => s.colour), [model.PALETTE[0], model.PALETTE[1]], 'a category\'s name is never a colour');
  assert.equal(mix.currency, 'EUR');
  assert.equal(mix.total, '€3,000.00');
  assert.equal(slices[1].money, '€2,000.00');
});

test('a mix that did not load is not an empty month, and an older database\'s mix is in USD', () => {
  assert.equal(model.revenueMix(null), null);
  const empty = model.revenueMix([]);
  assert.deepEqual([...empty.slices], []);
  assert.equal(empty.total, '$0.00');
  assert.equal(model.revenueMix([{ category: 'Sales', amount: 10, share: 100 }]).currency, 'USD',
    'before 0041 the mix had no currency, and was all USD');
});

test('the mix palette is the validated one, in its validated order', () => {
  assert.deepEqual([...model.PALETTE], ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    'the order is what keeps neighbours apart for colour-blind readers: validate a new order before changing it');
  assert.equal(model.FOLDED, '#898781');
});

/* ── Who sees Finance ────────────────────────────────────────────────── */

test('Finance is for owners and admins, in a session that has entered its code', () => {
  const can = person => model.canSeeFinance(person);
  assert.equal(can({ access: 'staff', role: 'owner' }), true);
  assert.equal(can({ access: 'staff', role: 'admin' }), true);
  assert.equal(can({ access: 'staff', role: 'employee' }), false, 'staff used to be shown a Finance page of zeros');
  assert.equal(can({ access: 'staff', role: 'assistant' }), false);
  assert.equal(can({ access: 'needs-code', role: 'owner' }), false, 'a password alone opens no figures (0040)');
  assert.equal(can({ access: 'not-staff', role: null }), false);
  assert.equal(can({ access: 'signed-out', role: null }), false);
  assert.equal(can({ access: 'unknown', role: 'admin' }), true, 'a check that could not finish keeps what the same person could see');
  assert.equal(can({ access: 'unknown', role: null }), false);
  assert.equal(can({ role: 'owner', status: 'active' }), true, 'an employees row');
  assert.equal(can({ role: 'admin', status: 'inactive' }), false, 'an inactive employee has no role (employee_role(), 0040)');
  assert.equal(can({ access: 'staff', role: 'owner', employee: { role: 'owner', status: 'inactive' } }), false);
  assert.equal(can(null), false);
  /* workspaceSession itself: access and role are getters on it. */
  const session = { get access() { return 'staff'; }, get role() { return 'admin'; }, employee: { role: 'admin', status: 'active' } };
  assert.equal(can(session), true);
});

/* ── Wiring it in ────────────────────────────────────────────────────── */

/* Moving the Finance page onto this model retired three helpers in
   workspace.js. revenueThisMonth() went with the Finance wiring. usd() and the
   money() that read a number back out of formatted text went once the CRM's
   "Pipeline value" moved onto crmModel.pipeline() (crm-ui.js): deleted with
   the Finance wiring alone, they would have left every CRM page throwing, and
   blank. The check stays as a guard for whatever comes next: a helper goes
   with its last caller, whichever view that is. Comments are blanked first: a
   note about a helper is not a call to it. */
test('workspace.js keeps each helper the Finance wiring retires for as long as anything there still calls it', () => {
  const source = readFileSync(new URL('../dist/workspace.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
  const lines = source.split('\n');
  const missing = ['revenueThisMonth', 'usd', 'money'].flatMap(name => {
    const call = new RegExp(`(?<![\\w$.])${name}\\(`);
    const callers = lines.flatMap((line, i) => (call.test(line) ? [i + 1] : []));
    const defined = new RegExp(`^(?:const|let|var|function)\\s+${name}\\b`, 'm').test(source);
    return callers.length && !defined ? [`${name}() on line ${callers.join(', ')}`] : [];
  });
  assert.deepEqual(missing, [], 'called in workspace.js but no longer defined there: delete a helper with its last caller');
});
