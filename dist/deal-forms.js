/* deal-forms.js — adding and changing the pipeline's deals.
 *
 * As deals-model.js decides it (dealForm, dealChanges, closeChanges,
 * reopenChanges), following the database: staff add and change a deal, only a
 * manager removes one (crm_deals, 0067, which gave the table the split 0021
 * gave the rest of the CRM). A deal needs a company and a name; its stage,
 * value, currency, owner, expected close date and notes are all optional.
 * What the database would refuse — a stage it does not have, a value that is
 * negative or larger than numeric(12,2), a currency that is not three capital
 * letters, an outcome without the day it closed — is refused here first,
 * naming the field rather than showing a constraint's name.
 *
 * An edit saves what the person changed in the dialog, and nothing else: a
 * change someone else made while it was open is not undone, and a field
 * nobody touched is not judged by rules it was stored before. Won and lost
 * are deliberately not on the edit form: closing a deal is its own dialog, so
 * a save that was only meant to fix a typo can never quietly close one.
 *
 * crm-ui.js draws the buttons (data-deal-new, data-deal-edit, data-deal-close,
 * data-deal-reopen, data-deal-delete) on the board's cards and on a company's
 * page. Every write goes through workspaceActions and reloads the store.
 * Loaded after crm-forms.js, which is where the shared dialog helpers and the
 * page globals it leans on are already in place. Tested in
 * tests/deal-forms.test.mjs.
 */
const dealForms = (function () {
  'use strict';

  const D = dealsModel;
  const C = crmModel;
  const CODE = /^[A-Z]{3}$/;
  const text = value => String(value == null ? '' : value);

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const has = part => Boolean(window.workspaceStore && workspaceStore.has(part));
  const stored = () => (window.workspaceStore && workspaceStore.state) || {};
  const loadedCompanies = () => stored().companies || [];
  const loadedDeals = () => stored().deals || [];
  const signedIn = () => (window.workspaceSession && workspaceSession.employee) || null;
  const values = form => Object.fromEntries(new FormData(form).entries());

  /* Every deal as the views read it, with its company found by id — the same
     list crm-ui.js draws the board from, so a dialog and a card can never
     disagree about what a deal says. */
  const shapedDeals = () => D.dealList(loadedDeals(), loadedCompanies());
  const dealById = id => shapedDeals().find(d => d.id === text(id).toLowerCase()) || null;

  /* What each open dialog was drawn with. */
  const drawn = new WeakMap();
  /* Saying what is wrong, a clean form for each send, and one write at a
     time: as every dialog does them (dialog-forms.js). */
  const { field, options, say, quiet, closeDialog, sending } = dialogForms;

  /* The fields the person changed since the dialog opened. */
  const edited = form => {
    const before = drawn.get(form) || {};
    return Object.fromEntries(Object.entries(values(form)).filter(([name, value]) => value !== before[name]));
  };

  /* A new deal is in the studio's currency when the Overview knows it (0041),
     the same fallback crm-forms.js gives a new company. */
  const studioCurrency = () => {
    const overview = stored().overview;
    const code = overview ? text(overview.revenue_currency).trim().toUpperCase() : '';
    return CODE.test(code) ? code : 'USD';
  };

  /* The board opens once companies have arrived (store.js, CORE), and deals
     are not CORE: a deal cannot be added or changed while the list of them
     has not loaded, because the dialog would be editing a record the page
     cannot see. */
  function ready() {
    if (!live()) {
      toast('Not yet: the workspace is still loading.');
      return false;
    }
    if (!has('deals')) {
      toast('Deals did not load. They are tried again by themselves.');
      return false;
    }
    return true;
  }

  /* ── The dialogs ───────────────────────────────────────────────────── */

  /* An owner not among the team: someone who left it — or, when the team did
     not load, whoever it is, the signed-in person being "You". The same
     reading crm-forms.js gives a company's owner. */
  function ownerChoices(owner) {
    const listed = (team || []).map(m => ({ value: m.id, label: m.name }));
    if (!owner || listed.some(o => o.value === owner)) return listed;
    const me = signedIn();
    const label = has('team') ? 'The current owner (no longer on the team)'
      : me && me.id === owner ? 'You' : 'The current owner (the team did not load)';
    return [...listed, { value: owner, label }];
  }

  /* The companies to file a deal under, by name. A company the deal is
     already at that has since left the CRM stays chosen, so saving a title
     does not quietly move the deal to nobody — the same care crm-forms.js
     takes with a contact's company. */
  function companyChoices(current) {
    const choices = loadedCompanies().map(co => C.shapeCompany(co))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(co => ({ value: co.id, label: co.name }));
    return current && !choices.some(o => o.value === current)
      ? [...choices, { value: current, label: 'Its company (no longer in the CRM)' }]
      : choices;
  }

  /* A deal's fields, filled in from it (dealsModel.shapeDeal) or, for a new
     one, with the database's defaults, the studio's currency and the
     signed-in person as owner. No outcome field: closing a deal is its own
     dialog. */
  function dealFields(deal, companyId) {
    const me = signedIn();
    const owner = deal ? deal.ownerId || '' : (me && me.id) || '';
    const company = deal ? deal.companyId || '' : text(companyId);
    return field('Company', `<select name="companyId" required><option value="">Pick a company…</option>`
      + `${options(companyChoices(company), company)}</select>`)
      + field('Name', `<input name="title" required maxlength="200" value="${esc(deal ? deal.title : '')}">`)
      + '<div class="form-pair">'
      + field('Stage', `<select name="stage">${options(D.STAGES, deal ? deal.stage : 'lead')}</select>`)
      + field('Expected close', `<input type="date" name="expectedClose" value="${esc(deal ? deal.expectedClose : '')}">`)
      + '</div><div class="form-pair">'
      + field('Value', `<input name="value" inputmode="decimal" value="${esc(deal && deal.amount !== null ? String(deal.amount) : '')}">`)
      + field('Currency', `<input name="currency" maxlength="3" autocapitalize="characters" value="${esc(deal ? text(deal.row.currency) : studioCurrency())}">`)
      + '</div>'
      + field('Owner', `<select name="ownerId"><option value="">No owner</option>${options(ownerChoices(owner), owner)}</select>`)
      + field('Notes', `<textarea name="notes" maxlength="5000">${esc(deal ? deal.notes : '')}</textarea>`);
  }

  /* ── Adding and editing ────────────────────────────────────────────── */

  function submitNewDeal(form) {
    const v = values(form);
    quiet(form);
    const deal = D.dealForm(v);
    if (deal.problem) { say(form, deal.problem, deal.field); return; }
    /* Only the deals themselves change — never a company, a contact or
       anything else the workspace loads — so only that part is asked for
       again (store.js's after()). */
    sending(form, () => workspaceActions.createDeal(deal.values), () => {
      toast(`${deal.values.title} added.`);
    }, { only: ['deals'] });
  }

  /* A form field's column, for judging an edit against the right record. */
  const DEAL_COLUMNS = Object.freeze({
    companyId: 'company_id', title: 'title', stage: 'stage', value: 'value',
    currency: 'currency', expectedClose: 'expected_close', ownerId: 'owner_id', notes: 'notes'
  });

  /* The record an edit is judged against: the fields the person changed as
     the dialog showed them, and everything else as the store has it now — so
     a change someone made meanwhile is neither undone nor held against them.
     crm-forms.js's own blended(), for this table's columns. */
  function blended(opened, current, v) {
    const before = (opened && opened.row) || {};
    const row = { ...((current && current.row) || {}) };
    Object.keys(v).forEach(name => {
      const column = DEAL_COLUMNS[name];
      if (column) row[column] = before[column];
    });
    return { ...current, row };
  }

  function submitEditDeal(form, opened) {
    const v = edited(form);
    quiet(form);
    const current = dealById(opened.id);
    if (!current) { say(form, 'That deal is no longer on the board.'); return; }
    const edit = D.dealChanges(blended(opened, current, v), v);
    if (edit.problem) { say(form, edit.problem, edit.field); return; }
    if (!Object.keys(edit.changes).length) { closeDialog(form); toast('Nothing changed.'); return; }
    const name = 'title' in edit.changes ? edit.changes.title : current.title;
    sending(form, () => workspaceActions.updateDeal(opened.id, edit.changes),
      () => toast(`${name} saved.`), { only: ['deals'] });
  }

  function openDeal(deal, companyId) {
    showModal(deal ? 'CRM · DEAL' : 'CRM · NEW DEAL',
      `<h2>${deal ? `Edit ${esc(deal.title)}` : 'New deal'}</h2>`
      + dialogForms.form('deal-form', dealFields(deal, companyId), deal ? 'Save deal' : 'Add deal'));
    const form = document.getElementById('deal-form');
    drawn.set(form, values(form));
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (deal) submitEditDeal(form, deal);
      else submitNewDeal(form);
    });
  }

  /* ── Won or lost ───────────────────────────────────────────────────── */

  /* Closing a deal is its own dialog because it records two things at once —
     which way it went and the day it went that way — and the database refuses
     either without the other (crm_deals_closed_check, 0067). The stage is
     left exactly where it is: that a deal was won out of Proposal rather than
     out of Lead is what the old one-stage-per-company shape could never say.

     The day defaults to today on the viewer's own clock, and is stored as the
     start of that day in their zone (dealsModel.instantOf) — not the bare
     date read as UTC, which lands on the day before for anyone west of it. */
  function submitClose(form, deal) {
    const v = values(form);
    quiet(form);
    const at = D.instantOf(v.closedOn);
    if (!at) { say(form, 'Pick the day the deal closed.', 'closedOn'); return; }
    const close = D.closeChanges(deal, v.outcome, at);
    if (close.problem) { say(form, close.problem, 'outcome'); return; }
    const label = D.outcomeLabel(close.changes.outcome).toLowerCase();
    sending(form, () => workspaceActions.updateDeal(deal.id, close.changes),
      () => toast(`${deal.title} marked ${label}.`), { only: ['deals'] });
  }

  function openClose(deal) {
    const today = typeof financeDay === 'function' ? financeDay() : D.dayOf(new Date().toISOString());
    showModal('CRM · CLOSE A DEAL', `<h2>How did ${esc(deal.title)} go?</h2>`
      + `<p class="form-note">It keeps the stage it is at now, ${esc(deal.stageLabel || 'none')}, so the board can still say where it was when it closed. Reopening it later puts it back there.</p>`
      + dialogForms.form('deal-close-form',
        field('Outcome', `<select name="outcome" required>${options(D.OUTCOMES, 'won')}</select>`)
        + field('Closed on', `<input type="date" name="closedOn" required value="${esc(D.dayOf(deal.closedAt) || today)}">`),
        'Save outcome'));
    const form = document.getElementById('deal-close-form');
    form.addEventListener('submit', e => { e.preventDefault(); submitClose(form, deal); });
  }

  /* Putting a closed deal back in the pipeline. No dialog: it undoes exactly
     one thing, and is itself undone by closing the deal again — unlike
     removing one, which the next load makes permanent. */
  function reopen(deal) {
    const change = D.reopenChanges(deal);
    if (change.problem) { toast(change.problem); return; }
    workspaceStore.after(workspaceActions.updateDeal(deal.id, change.changes), { only: ['deals'] })
      .then(() => toast(`${deal.title} is back in the pipeline.`))
      .catch(() => {});
  }

  /* ── Removing a deal ───────────────────────────────────────────────── */

  /* A confirm step first, the pattern established for anything this permanent
     (crm-forms.js's own openDelete): a plain dialog naming what stays behind,
     since a removed deal is off every list from the next load on, and there is
     no "… anyway" here to press by mistake. Owners and admins only, which
     crm-ui.js already checks before drawing the button; guard_soft_delete
     (0012, wired to crm_deals by 0067) checks again regardless. */
  function openDelete(deal) {
    showModal('CRM · REMOVE', `<h2>Remove ${esc(deal.title)}?</h2>`
      + `<p class="form-note">It leaves the board and its company's page. ${esc(deal.companyName || 'The company')} keeps every other deal it has, and its people and work are untouched.</p>`
      + dialogForms.form('deal-delete-form', '', 'Remove deal'));
    const form = document.getElementById('deal-delete-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      sending(form, () => workspaceActions.deleteDeal(deal.id), () => {
        toast(`${deal.title} is removed.`);
      }, { only: ['deals'] });
    });
  }

  /* ── What the board's buttons do ───────────────────────────────────── */

  document.addEventListener('click', e => {
    const at = selector => (e.target.closest ? e.target.closest(selector) : null);
    const button = at('[data-deal-new], [data-deal-edit], [data-deal-close], [data-deal-reopen], [data-deal-delete]');
    if (!button) return;
    e.preventDefault();
    const d = button.dataset;
    /* Adding a deal needs the companies, which are CORE, and the list of
       deals, which is not — the same check every other button here makes. */
    if (!ready()) return;
    if (d.dealNew !== undefined) {
      if (!loadedCompanies().length) { toast('Add a company first: a deal is always for one.'); return; }
      openDeal(null, text(d.dealNew).toLowerCase());
      return;
    }
    const wanted = text(d.dealEdit || d.dealClose || d.dealReopen || d.dealDelete);
    const deal = dealById(wanted);
    if (!deal) { toast('That deal is no longer on the board.'); return; }
    if (d.dealEdit !== undefined) openDeal(deal, '');
    else if (d.dealClose !== undefined) openClose(deal);
    else if (d.dealReopen !== undefined) reopen(deal);
    else openDelete(deal);
  });

  return Object.freeze({ openDeal, openClose, openDelete, reopen });
})();
