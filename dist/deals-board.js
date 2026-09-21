/* deals-board.js — the pipeline: the board of deals, its filters, and a
   company's own deals on its page.

   As deals-model.js decides it (crm_deals, 0067): a company has as many deals
   as it has pieces of work in flight, each with its own stage and value; a
   deal is open exactly when it has no outcome; and a deal that is won or lost
   keeps the stage it stood at, so the board can say "won out of Proposal"
   rather than losing that the moment it is won. Six columns: the four stages
   an open deal can stand at, then Won and Lost.

   The board used to be drawn from COMPANIES, by crm-ui.js, because a stage
   and a value lived on the company row: a client with a renewal being quoted
   and a new site being scoped had one stage between them, the second value
   overwrote the first, and a deal moved to "client" lost the proposal it had
   been at. This file replaced that board; crm-ui.js keeps the companies and
   contacts lists, their pages and the stat strip, and calls in here for the
   pipeline tab and for a company's deals.

   Split out of crm-ui.js rather than added to it: that file was already at
   the length this project keeps files under, and the board is its own
   concern. It loads after crm-ui.js and reads crmUi.moneyLine for the one
   thing they must write the same way — a column's total, per currency, in
   the studio's currency first. The few one-line page helpers below are its
   own rather than crm-ui.js's, so neither file has to export its internals
   to the other. Tested through tests/crm-ui.test.mjs, which draws the whole
   CRM page, and tests/deals.test.mjs for the logic underneath. */
const dealsBoardUi = (function () {
  'use strict';

  const D = dealsModel;
  const NONE = '\u2014';
  const text = value => String(value == null ? '' : value);

  const has = part => Boolean(window.workspaceStore && workspaceStore.has(part));
  const stored = () => (window.workspaceStore && workspaceStore.state) || {};
  const loadedCompanies = () => (has('companies') ? stored().companies || [] : null);
  const quiet = words => `<span class="quiet-text">${esc(words)}</span>`;
  const recordLink = (route, label) => `<a class="record-link" href="#${esc(route)}">${label}</a>`;
  /* Initials, as the rest of the workspace makes them (queries.js), are
     decoration: the name beside them is what is read out. */
  const avatar = (name, className) =>
    `<div class="avatar${className ? ' ' + className : ''}" aria-hidden="true">${esc(workspaceData.initials(name))}</div>`;
  const moneyLine = (totals, main) => crmUi.moneyLine(totals, main);
  const repaint = () => (typeof repaintKeepingFocus === 'function' ? repaintKeepingFocus() : (typeof render === 'function' && render()));

  /* ── Narrowing and ordering the deals board ────────────────────────────
     The board's own filters, separate from the companies table's
     (boardFilters, below): a deal has a stage and an owner of its own, and no
     kind at all — a kind is a company's. Kept for the session the same way,
     so opening a deal's company and coming back does not reset them. */
  const dealFilters = { stage: '', owner: '', sort: 'close' };
  const DEAL_SORTS = Object.freeze([
    { value: 'close', label: 'Expected close' },
    { value: 'value', label: 'Value' },
    { value: 'name', label: 'Name' },
    { value: 'company', label: 'Company' }
  ]);

  /* The deals as loaded, or null when they did not load (crm_deals, 0067).
     Not a CORE part of the store, so the board says so and they are tried
     again by themselves, rather than the whole workspace waiting on them. */
  const loadedDeals = () => (has('deals') ? stored().deals || [] : null);
  /* The deals as the views read them, with each one's company found by id
     among the companies loaded. Null when either list is missing: a deal
     whose company cannot be looked up would be drawn under no name at all. */
  const shapedDeals = companies => (loadedDeals() && companies ? D.dealList(loadedDeals(), companies) : null);

  /* The pipeline (#crm): every deal on the board, narrowed by search and by
     the deal filters, then in the order picked. Deals need the companies too
     — a card names the company it is for — so either list missing says so
     rather than drawing a board of deals belonging to nobody. */
  function dealsView(companies, query, main) {
    if (!companies) return `<section class="panel">${empty('Companies did not load', 'They are tried again by themselves.')}</section>`;
    const all = shapedDeals(companies);
    if (!all) return `<section class="panel">${empty('Deals did not load', 'They are tried again by themselves.')}</section>`;
    const matching = all.filter(deal => D.matchesQuery(deal, query));
    const entries = sortedDeals(narrowedDeals(matching, dealFilters), dealFilters.sort);
    return dealFilterBar() + dealsBoard(entries, main, isDealsNarrowed(query));
  }

  /* Deals kept only where every filter set matches: the stage exactly — which
     for a closed deal is the stage it kept, not the column it is drawn in, so
     filtering by Proposal finds the ones won out of Proposal too — and the
     owner by id, 'unowned' meaning no owner and never someone whose id
     happens to read that way (crm_deals.owner_id is a uuid). */
  function narrowedDeals(entries, filters) {
    const f = filters || {};
    return entries.filter(deal => {
      if (f.stage && deal.stage !== f.stage) return false;
      if (f.owner === 'unowned') return !deal.ownerId;
      if (f.owner && deal.ownerId !== f.owner) return false;
      return true;
    });
  }

  /* Sorting first is what leaves each board column in the same order every
     time — pipeline() only groups the list handed to it. A deal with no
     expected close date sorts after the ones that have one: a date nobody has
     set is not "the far future", it is a question still open. */
  function sortedDeals(entries, sort) {
    const list = [...entries];
    const byName = (a, b) => a.title.localeCompare(b.title);
    if (sort === 'value') {
      return list.sort((a, b) => (b.amount === null ? -Infinity : b.amount) - (a.amount === null ? -Infinity : a.amount) || byName(a, b));
    }
    if (sort === 'company') return list.sort((a, b) => a.companyName.localeCompare(b.companyName) || byName(a, b));
    if (sort === 'name') return list.sort(byName);
    return list.sort((a, b) => {
      if (!a.expectedClose !== !b.expectedClose) return a.expectedClose ? -1 : 1;
      return a.expectedClose.localeCompare(b.expectedClose) || byName(a, b);
    });
  }

  const isDealsNarrowed = query => Boolean(text(query).trim() || dealFilters.stage || dealFilters.owner);

  /* The board's own filter and sort controls. No Kind: that is a company's,
     and this board draws deals. Owner choices come from the team actually
     loaded, the same rule filterBar() applies — a select with one option
     nobody could pick from is worse than one left out. */
  function dealFilterBar() {
    const stageOptions = D.STAGES.map(s => `<option value="${esc(s.value)}"${dealFilters.stage === s.value ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    const sortOptions = DEAL_SORTS.map(s => `<option value="${esc(s.value)}"${dealFilters.sort === s.value ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    const ownerField = has('team')
      ? (() => {
        const owners = [...team].sort((a, b) => a.name.localeCompare(b.name));
        const ownerOptions = owners.map(m => `<option value="${esc(m.id)}"${dealFilters.owner === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')
          + `<option value="unowned"${dealFilters.owner === 'unowned' ? ' selected' : ''}>No owner</option>`;
        return `<label class="filter-field">Owner<select data-deal-filter="owner"><option value="">Any owner</option>${ownerOptions}</select></label>`;
      })() : '';
    return `<div class="filter-bar" role="group" aria-label="Narrow and order the pipeline">`
      + `<label class="filter-field">Stage<select data-deal-filter="stage"><option value="">Any stage</option>${stageOptions}</select></label>`
      + ownerField
      + `<label class="filter-field">Sort by<select data-deal-sort>${sortOptions}</select></label>`
      + (dealFilters.stage || dealFilters.owner ? `<button type="button" class="text-btn" data-deal-clear-filters>Clear filters</button>` : '')
      + `</div>`;
  }

  /* A column for each of the four stages an open deal can stand at, then one
     for each outcome — six in all, as the board has always had, but they are
     now a deal's columns and not a company's: a client with a renewal being
     quoted and a new site being scoped is on two of them at once, which is
     the whole reason crm_deals exists (0067). Won and Lost hold the closed
     deals, which before this had nowhere to be at all.

     Every card and column carries what a drop needs to know (data-deal-card,
     data-deal-column): the drag itself is the browser's own, and cannot be
     run without one — verified by reading the handler below, not by a browser
     test (tests/crm-ui.test.mjs's harness has no DOM to drag across). */
  function dealsBoard(entries, main, narrowed) {
    const columns = D.pipeline(entries).columns.map(column => {
      const id = `crm-deal-${esc(column.stage)}`;
      const empty = narrowed ? 'Nothing here matches.'
        : column.closes ? `No deals ${column.closes} yet.` : 'No deals at this stage.';
      return `<section class="board-column" aria-labelledby="${id}" data-deal-column="${esc(column.stage)}"><div class="board-heading"><h2 id="${id}">${esc(column.heading)}</h2>${countTag(column.count)}</div>`
        + (column.totals.length ? `<p class="board-total">${esc(moneyLine(column.totals, main))}</p>` : '')
        + `<div class="board-cards">${column.deals.map(dealCard).join('') || `<div class="board-empty">${esc(empty)}</div>`}</div></section>`;
    });
    return `<div class="project-board stage-board crm-board">${columns.join('')}</div>`;
  }

  /* What a card says under its value: when it is expected to close while it
     is open, when it closed once it is not, and — for a closed deal — the
     stage it stood at when it closed, which is the history the old shape
     could not hold. */
  function dealCaption(deal) {
    if (!deal.open) {
      return `${deal.outcomeLabel} from ${deal.stageLabel || 'no stage'}`
        + (deal.closedAt ? ` · ${financeModel.shortDate(deal.closedAt, financeDay())}` : '');
    }
    return deal.expectedClose
      ? `Expected ${financeModel.shortDate(deal.expectedClose, financeDay())}`
      : 'No close date yet';
  }

  /* A card is an article, not a link: it carries its own buttons, and a
     button inside a link is neither valid nor reachable by keyboard in the
     order a person expects. The company it is for is the link, so a card
     still opens somewhere — a deal has no page of its own, and its company is
     where its people, its work and its other deals already are. */
  function dealCard(deal) {
    const id = esc(deal.id);
    const heading = `deal-title-${id}`;
    return `<article class="panel contact-card deal-card" draggable="true" data-deal-card="${id}" aria-labelledby="${heading}">`
      + `<div class="card-top">${avatar(deal.companyName || 'No company', 'contact-avatar')}</div>`
      + `<h3 id="${heading}">${esc(deal.title)}</h3>`
      + `<p>${deal.route ? recordLink(deal.route, esc(deal.companyName || 'Its company')) : quiet('No company')}</p>`
      + `<div class="contact-value"><strong>${esc(dealValueText(deal))}</strong><span>${esc(dealCaption(deal))}</span></div>`
      + `<div class="card-actions">${dealButtons(deal)}</div>`
      + '</article>';
  }

  /* Edit, and then the one thing worth doing to a deal from the board: close
     it while it is open, or put it back in the pipeline once it is not. */
  function dealButtons(deal) {
    const id = esc(deal.id);
    return `<button type="button" class="text-btn" data-deal-edit="${id}">Edit</button>`
      + (deal.open
        ? `<button type="button" class="text-btn" data-deal-close="${id}">Won or lost…</button>`
        : `<button type="button" class="text-btn" data-deal-reopen="${id}">Reopen</button>`);
  }

  const dealValueText = deal => (deal.amount === null ? NONE : financeModel.money(deal.amount, deal.currency));

  /* A company's deals (0067): what is open first, then the won and lost ones,
     most recently closed first — a page reads what is live before what is
     history. Drawn from the same shaped list the board is, so what a deal
     says here and what it says there cannot drift apart.

     Removing a deal is offered here and not on the board: it is the one thing
     that cannot be undone from the page it happens on, and a manager doing it
     on purpose is on a company's page, not dragging cards. crm-ui only
     decides whether to draw the button; guard_soft_delete (0012, wired to
     crm_deals by 0067) decides whether the write is allowed. */
  function dealsPanelShell(body) {
    return `<section class="panel content-panel related-panel"><h2>Deals</h2>${body}</section>`;
  }

  function companyDealsPanel(companyId, companies) {
    const all = shapedDeals(companies);
    if (!all) return dealsPanelShell('<p class="quiet-text">Deals did not load. They are tried again by themselves.</p>');
    const mine = D.dealsFor(companyId, all);
    if (!mine.length) return dealsPanelShell('<p class="quiet-text">No deals yet. Add one with Add deal.</p>');
    const rows = mine.map(deal => `<div class="related-item deal-row">`
      + `<div><strong>${esc(deal.title)}</strong><small>${esc(dealCaption(deal))}</small></div>`
      + `<span class="deal-row-value">${pill(deal.open ? deal.stageLabel : deal.outcomeLabel)}<strong>${esc(dealValueText(deal))}</strong></span>`
      + `<span class="card-actions">${dealButtons(deal)}`
      + (isManagerNow() ? `<button type="button" class="text-btn" data-deal-delete="${esc(deal.id)}">Remove</button>` : '')
      + `</span></div>`).join('');
    return dealsPanelShell(rows);
  }

  /* Picking a stage, owner or sort order for the board: kept for the session
     (dealFilters), the same as the companies table's own. */
  document.addEventListener('change', e => {
    const filter = e.target.closest && e.target.closest('[data-deal-filter]');
    const sort = e.target.closest && e.target.closest('[data-deal-sort]');
    if (!filter && !sort) return;
    if (filter) dealFilters[filter.dataset.dealFilter] = filter.value;
    else dealFilters.sort = sort.value;
    repaint();
  });

  document.addEventListener('click', e => {
    const clear = e.target.closest && e.target.closest('[data-deal-clear-filters]');
    if (!clear) return;
    e.preventDefault();
    dealFilters.stage = '';
    dealFilters.owner = '';
    repaint();
  });

  /* Dragging a deal's card onto another column saves it there — the same
     write the dialogs make (deal-forms.js), decided by the same rule
     (dealsModel.moveChanges), so a drag and a dialog cannot disagree about
     what moving a deal means. A stage column moves it, and reopens it if it
     was closed; the Won and Lost columns close it where it stands, keeping
     the stage it was at, which is the history crm_deals was added for (0067).
     Native HTML5 drag and drop: a dragover handler must call preventDefault()
     for a drop to be allowed onto an element at all, and the id travels in
     the browser's own DataTransfer, which nothing here invents. A real drag
     cannot be run in tests/crm-ui.test.mjs's sandbox (no DOM to drag across);
     its harness calls these three handlers directly with a stand-in event
     instead, and the case that matters most — dropping a card back on the
     column it is already in — is decided by moveChanges returning no change
     at all, before workspaceActions is ever reached. */
  document.addEventListener('dragstart', e => {
    const card = e.target.closest && e.target.closest('[data-deal-card]');
    if (!card || !e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.dealCard);
  });

  document.addEventListener('dragover', e => {
    if (!(e.target.closest && e.target.closest('[data-deal-column]'))) return;
    e.preventDefault();
  });

  document.addEventListener('drop', e => {
    const column = e.target.closest && e.target.closest('[data-deal-column]');
    if (!column) return;
    e.preventDefault();
    const id = e.dataTransfer && e.dataTransfer.getData('text/plain');
    const target = column.dataset.dealColumn;
    const deals = shapedDeals(loadedCompanies());
    const deal = id && deals ? deals.find(d => d.id === id) : null;
    if (!deal || !target) return;
    const move = D.moveChanges(deal, target, new Date().toISOString());
    if (!Object.keys(move.changes).length) {
      if (move.problem && typeof toast === 'function') toast(move.problem);
      return;
    }
    if (!window.workspaceStore || !workspaceStore.state.loaded) {
      if (typeof toast === 'function') toast('Not yet: the workspace is still loading.');
      return;
    }
    /* Only the deals themselves change from this write — not the company it
       is for, and nothing else the workspace loads — so only that part is
       asked for again rather than the whole workspace (store.js's after()). */
    workspaceStore.after(workspaceActions.updateDeal(id, move.changes), { only: ['deals'] })
      .then(() => { if (typeof toast === 'function') toast(`${deal.title} moved to ${D.columnLabel(target)}.`); })
      .catch(() => {});
  });
  return Object.freeze({ shaped: shapedDeals, view: dealsView, companyPanel: companyDealsPanel });
})();
