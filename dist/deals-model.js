/* deals-model.js — the pipeline's logic, with no page in it.
 *
 * A deal (crm_deals, 0067), the board it is drawn on, and what the deal
 * dialogs may save. Kept apart from the views (crm-ui.js, deal-forms.js) so it
 * can be tested without a browser — tests/deals.test.mjs.
 *
 * The CRM used to keep ONE stage and ONE value directly on the company row
 * (crm_companies.stage/.value/.currency, 0021), so a client with a retainer
 * being renewed and a new site being quoted had one stage between them, the
 * second value overwrote the first, and a company moved to 'client' lost the
 * proposal it had been at: the column held the present and nothing else. Here
 * a company has as many deals as it has pieces of work in flight, each with
 * its own stage and value, and a deal that is won or lost keeps the stage it
 * stood at when it closed.
 *
 * The one rule every read here turns on, and the database's own
 * (crm_deals_closed_check): a deal is OPEN exactly when it has no outcome.
 * Won and lost are the outcome, never a stage — which is why STAGES has four
 * entries and the board has six columns.
 *
 * crm_companies.stage and .value are NOT read by this file and are not
 * replaced by it either: they are still what the contacts list and the client
 * numbering run on (0067's header lists the readers that have to move first).
 */
const dealsModel = (function () {
  'use strict';

  const C = crmModel;

  /* crm_deals.stage (0067), in the order a deal moves through them. `live` is
     whether the column counts towards the pipeline figure: a dormant deal is
     open — nobody has won or lost it — but it is not work the studio is
     counting on, the same judgement crm-model.js's own STAGES has always made
     about a dormant company. */
  const STAGES = Object.freeze([
    Object.freeze({ value: 'lead', label: 'Lead', heading: 'Leads', live: true }),
    Object.freeze({ value: 'qualified', label: 'Qualified', heading: 'Qualified', live: true }),
    Object.freeze({ value: 'proposal', label: 'Proposal', heading: 'Proposals', live: true }),
    Object.freeze({ value: 'dormant', label: 'Dormant', heading: 'Dormant', live: false })
  ]);

  /* crm_deals.outcome (0067). Not stages: a deal keeps its stage when it
     closes, so the board can say a deal was won out of Proposal. */
  const OUTCOMES = Object.freeze([
    Object.freeze({ value: 'won', label: 'Won', heading: 'Won' }),
    Object.freeze({ value: 'lost', label: 'Lost', heading: 'Lost' })
  ]);

  /* The board's columns: the four stages an open deal can stand at, then the
     two outcomes. A closed deal is drawn by its outcome and never by the
     stage it kept, so every deal is in exactly one column. */
  const COLUMNS = Object.freeze([
    ...STAGES.map(s => Object.freeze({ ...s, closes: null })),
    ...OUTCOMES.map(o => Object.freeze({ ...o, live: false, closes: o.value }))
  ]);

  const LIVE = Object.freeze(STAGES.filter(s => s.live).map(s => s.value));

  const text = value => String(value == null ? '' : value);
  /* Text as the database keeps it: a browser may send a textarea's line breaks as CRLF. */
  const tidy = value => text(value).replace(/\r\n?/g, '\n').trim();
  const orNull = value => tidy(value) || null;
  const rowOf = record => (record && record.row) || record || {};

  /* A stage or an outcome as the database has it, from its value or its
     label: 'qualified' and 'Qualified' are one stage, the way crm-model.js
     already reads a company's. */
  function valueIn(list, given) {
    const wanted = text(given).trim().toLowerCase();
    const hit = wanted ? list.find(x => x.value === wanted || x.label.toLowerCase() === wanted) : null;
    return hit ? hit.value : null;
  }
  const stageValue = given => valueIn(STAGES, given);
  const outcomeValue = given => valueIn(OUTCOMES, given);
  const labelIn = (list, value) => (list.find(x => x.value === value) || { label: '' }).label;
  const stageLabel = value => labelIn(STAGES, value);
  const outcomeLabel = value => labelIn(OUTCOMES, value);
  /* The column a deal is drawn in, by value: its outcome once it has one. */
  const columnLabel = value => labelIn(COLUMNS, value);

  /* crm_deals.expected_close is a `date`, which PostgREST hands over as
     "2026-11-30" and takes back the same way. Anything else is no date: a
     half-typed one is not saved as a guess at the year. */
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  function readDate(value) {
    const typed = tidy(value);
    if (!typed) return { date: null, problem: null };
    if (!DATE.test(typed) || Number.isNaN(Date.parse(`${typed}T00:00:00Z`))) {
      return { date: null, problem: 'That is not a date, like 2026-11-30.' };
    }
    return { date: typed, problem: null };
  }

  /* The day someone picked, as the instant crm_deals.closed_at holds: the
     start of that day on the viewer's own clock. Never `new Date(day)`, which
     reads a bare date as UTC midnight and so lands on the day before for
     anyone west of it — the same trap queries.js's shortDate() names. */
  function instantOf(day) {
    const read = readDate(day);
    if (!read.date) return null;
    const start = new Date(`${read.date}T00:00:00`);
    return isNaN(start.getTime()) ? null : start.toISOString();
  }

  /* A stored instant as the day it falls on for the viewer, which is what a
     date input takes back — the other direction of instantOf(). */
  function dayOf(value) {
    const at = new Date(text(value));
    if (!text(value) || isNaN(at.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  }

  /* ── A deal as the views use it ────────────────────────────────────── */

  /* `deal` is what queries.deals() returns or a crm_deals row. Its company is
     found by id among `companies`, the companies loaded — one that is not
     among them was removed from the CRM, and the deal says so rather than
     naming a company no page will open. Until companies have loaded (null),
     nothing is claimed about it either way. */
  function shapeDeal(deal, companies) {
    const d = deal || {};
    const row = rowOf(d);
    const id = d.id || row.id || null;
    const companyId = row.company_id || null;
    const found = Array.isArray(companies) ? C.companyById(companies, companyId) : null;
    const company = found ? C.shapeCompany(found) : null;
    const stage = stageValue(row.stage);
    const outcome = outcomeValue(row.outcome);
    const column = outcome || stage;
    return Object.freeze({
      id,
      companyId,
      company,
      companyName: company ? company.name : '',
      title: text(row.title),
      stage,
      stageLabel: stageLabel(stage),
      amount: C.amountOf(row.value),
      currency: C.currencyOf(row.currency),
      ownerId: row.owner_id || null,
      expectedClose: text(row.expected_close),
      outcome,
      outcomeLabel: outcomeLabel(outcome),
      /* The rule the database keeps as crm_deals_closed_check (0067). */
      open: outcome === null,
      closedAt: text(row.closed_at),
      column,
      columnLabel: columnLabel(column),
      /* Counted in the pipeline figure: open, and at a stage the studio is
         counting on. */
      live: outcome === null && LIVE.includes(stage),
      notes: text(row.notes),
      /* A deal has no page of its own: its card opens the company it is for,
         which is where its people, its work and its other deals already are. */
      route: companyId ? 'crm/companies/' + companyId : null,
      row
    });
  }

  /* Each deal once, by id, in the order first seen. */
  function uniqueById(records) {
    const seen = new Set();
    return (records || []).filter(r => r && r.id && !seen.has(r.id) && seen.add(r.id));
  }

  function dealList(deals, companies) {
    return Object.freeze(uniqueById(deals).map(d => shapeDeal(d, companies)));
  }

  /* One company's deals, newest first among the open ones and most recently
     closed first among the rest — a company page reads what is live before
     what is history. `deals` are shaped. */
  function dealsFor(companyId, deals) {
    if (!companyId) return Object.freeze([]);
    const mine = (deals || []).filter(d => d && d.companyId === companyId);
    return Object.freeze([
      ...mine.filter(d => d.open),
      ...mine.filter(d => !d.open).sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0))
    ]);
  }

  /* ── The board ─────────────────────────────────────────────────────── */

  /* A column for each of the four stages and each of the two outcomes, every
     deal in exactly one of them, with what the column is worth in each
     currency — added in cents and never across currencies, exactly as
     crm-model.js counts a company's value (crmModel.totalsOf). `open` is the
     pipeline figure: the deals still to be won, which is the live stages and
     not the dormant ones, and never a closed deal. */
  function pipeline(deals) {
    const list = uniqueById(deals).map(d => (d && d.column !== undefined ? d : shapeDeal(d, null)));
    const columns = COLUMNS.map(c => {
      const members = list.filter(d => d.column === c.value);
      return Object.freeze({
        stage: c.value, label: c.label, heading: c.heading, live: c.live, closes: c.closes,
        deals: Object.freeze(members), count: members.length, totals: C.totalsOf(members)
      });
    });
    const live = list.filter(d => d.live);
    return Object.freeze({
      columns: Object.freeze(columns),
      open: Object.freeze({ count: live.length, totals: C.totalsOf(live) })
    });
  }

  /* ── Forms ─────────────────────────────────────────────────────────── */

  const TITLE_PROBLEM = 'A deal needs a name.';
  const COMPANY_PROBLEM = 'Pick the company this deal is for.';
  const STAGE_PROBLEM = 'Pick a stage from the pipeline.';
  const CURRENCY_PROBLEM = 'Pick a currency, like EUR or USD.';
  const CURRENCY = /^[A-Z]{3}$/;

  const sent = (fields, key) => Object.prototype.hasOwnProperty.call(fields, key) && fields[key] !== undefined;

  /* [form field, column, what the form says, what the record said] as columns
     to write: only fields the form sent, and only where they differ. The same
     shape crm-model.js's own changesFrom uses. */
  const changesFrom = (fields, candidates) => Object.freeze(candidates
    .filter(([field, , value, current]) => sent(fields, field) && value !== current)
    .reduce((all, [, column, value]) => ({ ...all, [column]: value }), {}));

  /* A new deal, as workspaceActions.createDeal() takes one — or why it cannot
     be saved, with `field` naming the input to point at. A deal needs a
     company and a name; stage and currency fall back to the database's own
     defaults. What the database would refuse — a stage it does not have, a
     currency that is not three letters, a value numeric(12,2) cannot hold or
     that is negative (crm_deals_value_check), a half-typed date — is refused
     here first, so the person is told which field rather than shown a
     constraint's name. A new deal is always open: won and lost are decided
     from the board, never typed into the form that creates one. */
  function dealForm(fields) {
    const f = fields || {};
    const refuse = (problem, field) => Object.freeze({ values: Object.freeze({}), problem, field });
    const companyId = orNull(f.companyId);
    if (!companyId) return refuse(COMPANY_PROBLEM, 'companyId');
    const title = tidy(f.title);
    if (!title) return refuse(TITLE_PROBLEM, 'title');
    const stage = tidy(f.stage) ? stageValue(f.stage) : 'lead';
    if (!stage) return refuse(STAGE_PROBLEM, 'stage');
    const value = C.readValue(f.value);
    if (value.problem) return refuse(value.problem, 'value');
    const currency = tidy(f.currency).toUpperCase() || 'USD';
    if (!CURRENCY.test(currency)) return refuse(CURRENCY_PROBLEM, 'currency');
    const close = readDate(f.expectedClose);
    if (close.problem) return refuse(close.problem, 'expectedClose');
    return Object.freeze({
      values: Object.freeze({
        companyId, title, stage, value: value.amount, currency,
        ownerId: orNull(f.ownerId), expectedClose: close.date, notes: orNull(f.notes)
      }),
      problem: null,
      field: null
    });
  }

  /* A value sent back as the record holds it, so an untouched field is not
     judged by a rule it was stored before — crm-model.js's own sameValue. */
  const sameValue = (typed, stored) => C.amountOf(typed) !== null && C.amountOf(typed) === C.amountOf(stored);

  /* Why an edit to a deal cannot be saved, as [problem, field], or null. A
     typed stage is always this edit's: a stored one follows the database's
     rules already. */
  function dealProblem(row, f) {
    const currency = tidy(f.currency).toUpperCase();
    if (sent(f, 'companyId') && !orNull(f.companyId)) return [COMPANY_PROBLEM, 'companyId'];
    if (sent(f, 'title') && tidy(f.title) !== tidy(row.title) && !tidy(f.title)) return [TITLE_PROBLEM, 'title'];
    if (sent(f, 'stage') && !stageValue(f.stage)) return [STAGE_PROBLEM, 'stage'];
    if (sent(f, 'value') && !sameValue(f.value, row.value) && C.readValue(f.value).problem) {
      return [C.readValue(f.value).problem, 'value'];
    }
    if (sent(f, 'currency') && currency !== text(row.currency) && !CURRENCY.test(currency)) return [CURRENCY_PROBLEM, 'currency'];
    if (sent(f, 'expectedClose') && tidy(f.expectedClose) !== text(row.expected_close) && readDate(f.expectedClose).problem) {
      return [readDate(f.expectedClose).problem, 'expectedClose'];
    }
    return null;
  }

  /* What an edit to a deal changes, as crm_deals columns — or why it cannot be
     saved. An empty field means "none". The outcome is not among them: won
     and lost are their own change (closeChanges), so a save from the edit
     dialog can never quietly close a deal or reopen one. */
  function dealChanges(deal, fields) {
    const f = fields || {};
    const row = rowOf(deal);
    const refuse = (problem, field) => Object.freeze({ changes: Object.freeze({}), problem, field });
    const problem = dealProblem(row, f);
    if (problem) return refuse(problem[0], problem[1]);
    const changes = changesFrom(f, [
      ['companyId', 'company_id', orNull(f.companyId), row.company_id || null],
      ['title', 'title', tidy(f.title), tidy(row.title)],
      ['stage', 'stage', stageValue(f.stage), stageValue(row.stage)],
      ['value', 'value', sameValue(f.value, row.value) ? C.amountOf(row.value) : C.readValue(f.value).amount, C.amountOf(row.value)],
      ['currency', 'currency', tidy(f.currency).toUpperCase(), text(row.currency)],
      ['expectedClose', 'expected_close', readDate(f.expectedClose).date, row.expected_close || null],
      ['ownerId', 'owner_id', orNull(f.ownerId), row.owner_id || null],
      ['notes', 'notes', orNull(f.notes), orNull(row.notes)]
    ]);
    /* The database checks the currency rule on every change to a row (0067,
       following 0049), so a deal backfilled from a company that still holds a
       code from before that rule has to be given one in the same change. */
    const stale = typeof row.currency === 'string' && !CURRENCY.test(row.currency);
    if (stale && Object.keys(changes).length && !('currency' in changes)) {
      return refuse(`This deal's currency, "${row.currency}", is not a code like EUR or USD. Pick one to save the change.`, 'currency');
    }
    return Object.freeze({ changes, problem: null, field: null });
  }

  /* ── Moving a deal, and closing it ─────────────────────────────────── */

  /* Closing a deal: the outcome and the day it closed, together — the
     database refuses one without the other (crm_deals_closed_check, 0067).
     The stage is deliberately left where it is: that a deal was won out of
     Proposal rather than out of Lead is the history the old shape could not
     hold at all. `at` is an ISO instant; nothing here reads the clock itself,
     so a test can say when. */
  function closeChanges(deal, outcome, at) {
    const shaped = deal && deal.column !== undefined ? deal : shapeDeal(deal, null);
    const wanted = outcomeValue(outcome);
    if (!wanted) return Object.freeze({ changes: Object.freeze({}), problem: 'Say whether the deal was won or lost.' });
    if (shaped.outcome === wanted) {
      return Object.freeze({ changes: Object.freeze({}), problem: `That deal is already ${outcomeLabel(wanted).toLowerCase()}.` });
    }
    return Object.freeze({
      changes: Object.freeze({ outcome: wanted, closed_at: text(at) || new Date().toISOString() }),
      problem: null
    });
  }

  /* Putting a closed deal back in the pipeline: both columns cleared
     together, which is the only way the database allows either to be. */
  function reopenChanges(deal) {
    const shaped = deal && deal.column !== undefined ? deal : shapeDeal(deal, null);
    if (shaped.open) return Object.freeze({ changes: Object.freeze({}), problem: 'That deal is already open.' });
    return Object.freeze({ changes: Object.freeze({ outcome: null, closed_at: null }), problem: null });
  }

  /* Dropping a card on a column. A stage column moves the deal there — and,
     if it was closed, reopens it in the same write, because a deal cannot sit
     in a stage column and still hold an outcome. An outcome column closes it
     where it stands. A drop on the column it is already in changes nothing,
     which is what makes a drag that goes nowhere cost no write at all. */
  function moveChanges(deal, column, at) {
    const shaped = deal && deal.column !== undefined ? deal : shapeDeal(deal, null);
    const target = (COLUMNS.find(c => c.value === text(column).trim().toLowerCase()) || null);
    const nothing = problem => Object.freeze({ changes: Object.freeze({}), problem });
    if (!target) return nothing('That is not a column on the board.');
    if (shaped.column === target.value) return nothing(null);
    if (target.closes) return closeChanges(shaped, target.closes, at);
    return Object.freeze({
      changes: Object.freeze(shaped.open
        ? { stage: target.value }
        : { stage: target.value, outcome: null, closed_at: null }),
      problem: null
    });
  }

  /* ── Search ────────────────────────────────────────────────────────── */

  /* What the board's search finds: a deal by its own name, by the company it
     is for, and by its notes. */
  function matchesQuery(deal, query) {
    const wanted = text(query).trim().toLowerCase();
    if (!wanted) return true;
    const d = deal || {};
    return [d.title, d.companyName, d.notes].map(text).join(' ').toLowerCase().includes(wanted);
  }

  return Object.freeze({
    STAGES, OUTCOMES, COLUMNS,
    stageValue, stageLabel, outcomeValue, outcomeLabel, columnLabel,
    readDate, instantOf, dayOf,
    shapeDeal, dealList, dealsFor, pipeline,
    dealForm, dealChanges, closeChanges, reopenChanges, moveChanges,
    matchesQuery
  });
})();
