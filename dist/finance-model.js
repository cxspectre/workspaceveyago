/* finance-model.js — Finance's logic, with no page in it.
 *
 * Which invoice a link opens, what an invoice's status is today, when it falls
 * due or was paid, what is waiting to be paid in each currency, amounts with
 * their cents, what the invoice search finds, the revenue mix's colours and
 * who may see any of it. Kept apart from the views (workspace.js) so it can be
 * tested without a browser — tests/finance.test.mjs.
 *
 * The Finance page used to answer these with whatever was nearest. An invoice
 * was known by its place in the list, and search opened it by its number. The
 * "Due / paid" column showed the day an invoice was issued, one long past its
 * due date still said Sent, and "Awaiting payment" counted drafts. Every amount
 * lost its cents and every currency was added into one USD figure. Staff, who
 * can read no invoice at all, were shown a page of zeros, and the revenue mix
 * had three colours, so its fourth category looked like its first.
 *
 * What comes out of here is text, numbers and uuids — never markup. An invoice
 * number is whatever someone typed into it; escaping stays with the views that
 * put it in the page.
 */
const financeModel = (function () {
  'use strict';

  /* finance_invoices.status (0005), in the order an invoice moves through them. */
  const STATUSES = Object.freeze([
    Object.freeze({ value: 'draft', label: 'Draft' }),
    Object.freeze({ value: 'sent', label: 'Sent' }),
    Object.freeze({ value: 'overdue', label: 'Overdue' }),
    Object.freeze({ value: 'paid', label: 'Paid' })
  ]);
  /* Waiting to be paid: sent, late or not — the invoices workspace_overview()
     counts as outstanding (0029, 0041). A draft has asked nobody for anything. */
  const AWAITING = Object.freeze(['sent', 'overdue']);
  /* The roles is_manager() lets read finance (0013). */
  const MANAGERS = Object.freeze(['owner', 'admin']);
  /* What the session says (access.js) when a manager may go on reading: a staff
     session, or a check that could not finish for the person the page is
     already open for. */
  const READING = Object.freeze(['staff', 'unknown']);

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const CODE = /^[A-Z]{3}$/;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NONE = '—';

  const text = value => String(value == null ? '' : value);
  const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  /* ── Dates ─────────────────────────────────────────────────────────── */

  /* A real calendar date, as a date column and CAL.dayKey() write one:
     2026-02-30 is quietly read as March 2, so it has to come back as it went in. */
  function isDate(value) {
    const day = text(value);
    if (!DATE.test(day)) return false;
    const date = new Date(`${day}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
  }
  const dateOf = value => (isDate(text(value).slice(0, 10)) ? text(value).slice(0, 10) : null);
  const utc = day => new Date(`${day}T00:00:00Z`);

  /* A date has no time of day, so it is read and written in UTC: anywhere west
     of Greenwich, local midnight would make it the day before. */
  const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const yearFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  /* A date as a list shows it: "Sep 20", or "Dec 30, 2025" when it is not in
     today's year. Without today, the year is always given. */
  function shortDate(value, today) {
    const day = dateOf(value);
    if (!day) return '';
    const thisYear = isDate(today) && text(today).slice(0, 4) === day.slice(0, 4);
    return (thisYear ? dayFormat : yearFormat).format(utc(day));
  }

  /* A date on the invoice itself, always with its year. */
  const fullDate = day => (day ? yearFormat.format(utc(day)) : '');

  /* ── Money ─────────────────────────────────────────────────────────── */

  /* An amount as whole cents, so adding invoices up never drifts: 0.1 + 0.2 is
     30 cents, not 0.30000000000000004 of a dollar. numeric(12,2) keeps two
     decimals at most. What is not a number is null, never zero. */
  function centsOf(amount) {
    if (amount == null || text(amount).trim() === '') return null;
    const n = Number(amount);
    return Number.isFinite(n) ? Math.round(n * 100) || 0 : null;
  }

  /* A currency as finance rows are grouped by it (0041): trimmed and in upper
     case, a blank one being the column's default, USD. */
  const currencyOf = value => text(value).trim().toUpperCase() || 'USD';

  /* One formatter per currency, made once: making them is the slow part. */
  const formats = new Map();
  function currencyFormat(code) {
    if (!formats.has(code)) formats.set(code, new Intl.NumberFormat('en-US', { style: 'currency', currency: code }));
    return formats.get(code);
  }
  const plainFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* Whole cents in a currency, with that currency's own minor unit. */
  function formatCents(cents, currency) {
    if (cents === null) return NONE;
    const code = currencyOf(currency);
    if (CODE.test(code)) {
      try {
        return currencyFormat(code).format(cents / 100);
      } catch (err) {
        /* A code Intl does not take: written beside the number, below. */
      }
    }
    return `${plainFormat.format(cents / 100)} ${text(currency).trim()}`;
  }

  /* An amount in its own currency, with its cents: "$1,234.50", "€1,200.00" —
     and "¥1,234" for a currency that has none. The list used to round every
     amount to a whole number. A code Intl cannot format ("US$") is written
     beside the number rather than thrown out of the page being drawn, and what
     is not an amount is a dash. */
  const money = (amount, currency) => formatCents(centsOf(amount), currency);

  /* ── An invoice ────────────────────────────────────────────────────── */

  function statusValue(given) {
    const wanted = text(given).trim().toLowerCase();
    const hit = STATUSES.find(s => s.value === wanted || s.label.toLowerCase() === wanted);
    return hit ? hit.value : null;
  }

  function statusLabel(value) {
    const hit = STATUSES.find(s => s.value === value);
    return hit ? hit.label : '';
  }

  /* What an invoice says, from what queries.invoices() hands the store — the
     number as `id`, the uuid as `uuid`, the row itself under `row` — or from a
     finance_invoices row as the database returns it. The row is read first:
     the list's own amount is text that has already lost its cents. */
  function factsOf(invoice) {
    const v = invoice || {};
    const r = v.row || v;
    const uuid = text(v.uuid != null ? v.uuid : r.id).trim();
    const pick = (column, field) => text(r[column] != null ? r[column] : v[field]);
    return {
      uuid: UUID.test(uuid) ? uuid.toLowerCase() : null,
      number: pick('number', 'number'),
      client: pick('client', 'client'),
      clientEmail: pick('client_email', 'clientEmail'),
      description: pick('notes', 'description'),
      cents: centsOf(r.amount),
      currency: currencyOf(r.currency),
      status: statusValue(r.status != null ? r.status : v.status),
      issuedOn: dateOf(r.issued_on),
      dueOn: dateOf(r.due_on),
      paidOn: dateOf(r.paid_on)
    };
  }

  /* An invoice's status today. A sent invoice is overdue from the day after its
     due date, whether or not anyone changed the stored status — the rule the
     admin's invoice list follows (admin/js/invoices.js), so both say the same
     of the same invoice. One marked overdue by hand stays overdue; a draft is
     owed by nobody, so it is never late; and without today there is nothing to
     compare with. */
  const statusFrom = (f, today) =>
    (f.status === 'sent' && f.dueOn !== null && isDate(today) && f.dueOn < today ? 'overdue' : f.status);

  const statusOf = (invoice, today) => statusFrom(factsOf(invoice), today);

  /* What the "Due / paid" column says: the day an invoice was paid, or the day
     it falls due and how late it is. The column used to show the day it was
     issued. A payment date that did not load is not made up. */
  function dueOrPaidFrom(f, status, today) {
    if (status === 'paid') return f.paidOn ? `Paid ${shortDate(f.paidOn, today)}` : 'Paid';
    if (!f.dueOn) return 'No due date';
    if (f.dueOn === today) return 'Due today';
    const due = `Due ${shortDate(f.dueOn, today)}`;
    if (status !== 'overdue' || !isDate(today) || f.dueOn > today) return due;
    const late = Math.round((utc(today) - utc(f.dueOn)) / DAY_MS);
    return `${due} · ${late} ${late === 1 ? 'day' : 'days'} late`;
  }

  const dueOrPaid = (invoice, today) => {
    const f = factsOf(invoice);
    return dueOrPaidFrom(f, statusFrom(f, today), today);
  };

  /* An invoice as the page shows it: plain values, in its own currency. `id`
     stays the number and `uuid` the uuid, as queries.invoices() has them, so
     the breadcrumb (overviewModel.crumb), the bell and the search box
     (shellModel) read a shaped invoice as they read a listed one — its `amount`
     now with cents, and its `status` overdue when it is. */
  function shapeInvoice(invoice, today) {
    const f = factsOf(invoice);
    const status = statusFrom(f, today);
    const paid = status === 'paid';
    return Object.freeze({
      id: f.number,
      uuid: f.uuid,
      route: f.uuid ? `finance/${f.uuid}` : null,
      number: f.number,
      client: f.client,
      clientEmail: f.clientEmail,
      description: f.description,
      currency: f.currency,
      cents: f.cents,
      amount: formatCents(f.cents, f.currency),
      /* A paid invoice leaves nothing to pay; any other still asks for all of it. */
      balance: formatCents(paid ? 0 : f.cents, f.currency),
      status: statusLabel(status),
      statusValue: status,
      issuedOn: f.issuedOn,
      dueOn: f.dueOn,
      paidOn: f.paidOn,
      issued: shortDate(f.issuedOn, today),
      dueOrPaid: dueOrPaidFrom(f, status, today),
      /* The date block on the invoice document. */
      dateHeading: paid ? 'Paid on' : 'Due date',
      dateValue: paid ? (fullDate(f.paidOn) || 'Not recorded') : (fullDate(f.dueOn) || 'No due date'),
      row: (invoice && invoice.row) || invoice || null
    });
  }

  /* ── Links ─────────────────────────────────────────────────────────── */

  /* An invoice by its uuid and by nothing else: a place in the list changes
     whenever an invoice is added, and a number is not unique (0005 does not make
     it so). An old "#finance/0", or a number, opens nothing rather than
     whichever invoice happens to fit. */
  function invoiceById(invoices, id) {
    if (typeof id !== 'string' || !UUID.test(id.trim())) return null;
    const wanted = id.trim().toLowerCase();
    return (invoices || []).find(invoice => invoice && factsOf(invoice).uuid === wanted) || null;
  }

  /* The uuid a link to an invoice carries — null when it has none a link could
     safely carry. */
  const routeKey = invoice => factsOf(invoice).uuid;

  function invoiceRoute(invoice) {
    const key = routeKey(invoice);
    return key ? `finance/${key}` : null;
  }

  /* What a Finance address shows: the overview ("#finance"), the invoice list
     ("#finance/invoices") or one invoice ("#finance/<uuid>"). Any other key — a
     position, a number — is an invoice that is not there, which is what the
     breadcrumb already says of it (overviewModel.crumb). */
  function financeRoute(parts) {
    const key = (parts || [])[1];
    if (key === undefined || key === null || key === '') {
      return Object.freeze({ tab: 'overview', record: false, invoiceId: null });
    }
    if (key === 'invoices') return Object.freeze({ tab: 'invoices', record: false, invoiceId: null });
    const id = text(key).trim();
    return Object.freeze({ tab: 'invoices', record: true, invoiceId: UUID.test(id) ? id.toLowerCase() : null });
  }

  /* ── Money owed ────────────────────────────────────────────────────── */

  const sumCents = entries => entries.reduce((total, entry) => total + entry.cents, 0);

  /* One currency's invoices added up: how many and how much, how many of them
     are late, and the soonest due date still ahead of an unpaid one. */
  function currencyTotal(code, entries, today) {
    const late = entries.filter(entry => entry.status === 'overdue');
    const ahead = entries
      .filter(entry => AWAITING.includes(entry.status) && entry.dueOn !== null && isDate(today) && entry.dueOn >= today)
      .map(entry => entry.dueOn)
      .sort();
    const cents = sumCents(entries);
    const lateCents = sumCents(late);
    return Object.freeze({
      currency: code,
      count: entries.length,
      cents,
      amount: cents / 100,
      money: formatCents(cents, code),
      overdue: late.length,
      overdueCents: lateCents,
      overdueMoney: formatCents(lateCents, code),
      nextDue: ahead.length ? ahead[0] : null
    });
  }

  /* Invoices added up in each currency — never one currency into another. The
     studio's currency first when it is given, then the currency with the most
     invoices: the order the Overview lists them in (0041). An amount that is
     not a number is left out rather than counted as nothing. */
  function totals(invoices, today, mainCurrency) {
    const main = mainCurrency ? currencyOf(mainCurrency) : null;
    const entries = (invoices || [])
      .filter(Boolean)
      .map(invoice => factsOf(invoice))
      .filter(f => f.cents !== null)
      .map(f => ({ ...f, status: statusFrom(f, today) }));
    const codes = [...new Set(entries.map(entry => entry.currency))];
    return Object.freeze(codes
      .map(code => currencyTotal(code, entries.filter(entry => entry.currency === code), today))
      .sort((a, b) => (b.currency === main) - (a.currency === main) || b.count - a.count || byCode(a.currency, b.currency)));
  }

  /* What is waiting to be paid, in each currency: sent invoices, late or not —
     never drafts, which ask nobody for anything yet, and which the page used to
     count. */
  const awaitingPayment = (invoices, today, mainCurrency) =>
    totals((invoices || []).filter(invoice => invoice && AWAITING.includes(statusOf(invoice, today))), today, mainCurrency);

  /* Per-currency totals on one line, side by side: "€1,200.00 · $80.00". None
     at all is nothing, in `currency`; totals that never loaded are a dash, not
     a zero. */
  function moneyList(entries, currency) {
    if (!Array.isArray(entries)) return NONE;
    if (!entries.length) return money(0, currency);
    return entries.map(entry => entry.money).join(' · ');
  }

  /* The figures at the top of the Finance page. Revenue is the Overview's own
     answer (overviewModel.revenueFigures), not worked out a second time — and
     paid invoices never stand in for it when the database has not answered: a
     paid invoice is not this month's income. Invoices are added up per
     currency. What did not load is null, shown as a dash rather than a zero. */
  function figures(facts) {
    const f = facts || {};
    const revenue = overviewModel.revenueFigures(f.overview || null);
    if (!Array.isArray(f.invoices)) {
      return Object.freeze({ revenue, count: null, listed: null, paid: null, awaiting: null });
    }
    const main = revenue ? revenue.currency : null;
    const paid = f.invoices.filter(invoice => invoice && statusOf(invoice, f.today) === 'paid');
    return Object.freeze({
      revenue,
      count: f.invoices.length,
      listed: totals(f.invoices, f.today, main),
      paid: totals(paid, f.today, main),
      awaiting: awaitingPayment(f.invoices, f.today, main)
    });
  }

  /* ── Search ────────────────────────────────────────────────────────── */

  /* Text as search compares it: look-alike characters folded (full-width
     letters, a non-breaking space), runs of spaces made one, case ignored. */
  const fold = value => text(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  /* Letters and digits alone: "INV-1042", "inv 1042" and "#1042" are one number. */
  const bare = value => fold(value).replace(/[^\p{L}\p{N}]/gu, '');

  const haystack = f => [f.number, f.client, f.clientEmail, f.description].map(fold).join(' ');

  /* What search looks through: the number, the client, the client's address
     and what the invoice is for. */
  const searchText = invoice => haystack(factsOf(invoice));

  /* Whether an invoice is one someone searched for: by its number however it is
     written, by its client, its address or what it is for. No search is
     everything. */
  function matchesQuery(invoice, query) {
    const wanted = fold(query);
    if (!wanted) return true;
    const f = factsOf(invoice);
    if (haystack(f).includes(wanted)) return true;
    const key = bare(wanted);
    return Boolean(key) && (bare(f.number).includes(key) || bare(f.client).includes(key));
  }

  /* ── The revenue mix ───────────────────────────────────────────────── */

  /* The reference categorical palette, in its validated order: the dataviz
     validator passes it against the panel's surface for neighbouring slices,
     with colour-blind separation of ΔE 9.1 at worst and 19.6 for everyone else.
     The order is what keeps neighbours apart, so validate a new one before
     changing it. Aqua, yellow and magenta sit under 3:1 against the panel,
     which is why every slice keeps its name beside its amount. */
  const PALETTE = Object.freeze(['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']);
  /* The folded tail: grey, so it reads as the rest rather than as a category. */
  const FOLDED = '#898781';
  /* What revenue_mix() calls income with no category (0031). */
  const UNCATEGORISED = 'Uncategorised';

  const byName = (a, b) => a.category.localeCompare(b.category, 'en', { sensitivity: 'base' }) || byCode(a.category, b.category);

  /* The mix's categories, each once, with what it earned in cents. A blank
     category is uncategorised income; nothing earned is no slice. */
  function mixCategories(rows) {
    const earned = rows
      .filter(Boolean)
      .map(row => ({ category: text(row.category).trim() || UNCATEGORISED, cents: centsOf(row.amount) }))
      .filter(row => row.cents !== null && row.cents > 0);
    return [...new Set(earned.map(row => row.category))].map(category => ({
      category,
      cents: sumCents(earned.filter(row => row.category === category))
    }));
  }

  /* Which categories keep a colour. Up to eight, every one. Past eight, the
     largest named categories and Uncategorised keep seven between them and the
     rest fold into one slice: never a ninth colour, never one used twice.
     Uncategorised is never folded away — it is the income nobody has sorted. */
  function foldCategories(categories) {
    const named = categories.filter(c => c.category !== UNCATEGORISED);
    const loose = categories.filter(c => c.category === UNCATEGORISED);
    if (categories.length <= PALETTE.length) return { shown: [...[...named].sort(byName), ...loose], folded: [] };
    const room = PALETTE.length - 1 - loose.length;
    const bySize = [...named].sort((a, b) => b.cents - a.cents || byName(a, b));
    return { shown: [...bySize.slice(0, room).sort(byName), ...loose], folded: bySize.slice(room) };
  }

  /* This month's income by category (revenue_mix(), 0041), as the panel draws
     it. Every category has a colour of its own, however many there are. A
     colour follows its category, not its rank: slices run in name order, with
     Uncategorised and the folded tail last, so income moving from one category
     to another repaints nothing, and slices side by side in the bar are side by
     side in the palette. Shares are worked out from the amounts, so the slices
     add up; `width` is the exact share, for the bar. A database from before
     0041 gives no currency, and was all USD. null when the mix did not load. */
  function revenueMix(rows) {
    if (!Array.isArray(rows)) return null;
    const first = rows.find(row => row && row.currency);
    const currency = currencyOf(first ? first.currency : '');
    const categories = mixCategories(rows);
    const total = sumCents(categories);
    const { shown, folded } = foldCategories(categories);
    const sliceOf = (category, label, cents, colour, slot, count) => Object.freeze({
      category,
      label,
      cents,
      amount: cents / 100,
      money: formatCents(cents, currency),
      share: total > 0 ? Math.round((cents / total) * 1000) / 10 : 0,
      width: total > 0 ? Math.min(100, Math.max(0, (cents / total) * 100)) : 0,
      colour,
      slot,
      folded: category === null,
      count
    });
    const tail = folded.length
      ? [sliceOf(null, `${folded.length} other categories`, sumCents(folded), FOLDED, 0, folded.length)]
      : [];
    return Object.freeze({
      currency,
      cents: total,
      total: formatCents(total, currency),
      slices: Object.freeze([...shown.map((c, i) => sliceOf(c.category, c.category, c.cents, PALETTE[i], i + 1, 1)), ...tail])
    });
  }

  /* ── Who sees Finance ──────────────────────────────────────────────── */

  /* Whether a person may see Finance, as is_manager() decides (0013, 0040): an
     owner or an admin whose employees row is active, in a session that has
     entered its second factor when the account has one. From workspaceSession
     (access, role, employee) that is a staff session with one of those roles —
     or a check that could not finish, which keeps the role of the person the
     page is already open for: "could not check" is not "no" (access.js). From
     an employees row, its role and status. Staff in any other role used to be
     shown a Finance page of zeros, every figure one the database refuses them. */
  function canSeeFinance(person) {
    if (!person) return false;
    const employee = person.employee || null;
    const role = person.role !== undefined ? person.role : (employee ? employee.role : null);
    const status = employee ? employee.status : person.status;
    const session = person.access === undefined || READING.includes(person.access);
    return session && status !== 'inactive' && MANAGERS.includes(role);
  }

  return Object.freeze({
    STATUSES, PALETTE, FOLDED,
    invoiceById, routeKey, invoiceRoute, financeRoute,
    statusOf, statusLabel, dueOrPaid, shortDate, shapeInvoice,
    money, totals, awaitingPayment, moneyList, figures,
    searchText, matchesQuery,
    revenueMix, canSeeFinance
  });
})();
