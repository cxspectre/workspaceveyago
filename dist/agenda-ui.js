/* agenda-ui.js — the Agenda: a week, a day, a schedule or a month, and an
 * event's page.
 *
 * As agenda-model.js works them out. Any week can be shown: Previous, Today and
 * Next move a week at a time, and a day picked in the mini month opens that
 * day, in its own week. Saturday and Sunday are drawn whenever something is on
 * them, today is one of them, or one was picked. Month shows a whole month at
 * a glance, spill from either side included, each day's events as compact
 * chips — Previous and Next step by a month there instead. An event is on
 * every day it covers, at the time it has on that day, and one that overlaps
 * another says which. Kinds read in their own colours. Whoever may act on an
 * event's calendar — whoever booked a hand-made one, or an owner or admin
 * (0048); the studio's or your own for a synced one (0057) — can edit or
 * remove it: a synced change or removal reaches Outlook first, through
 * update-calendar-event and delete-calendar-event, before the local row
 * follows. An event's page says who is invited and how each answered, whether
 * it is only tentative or cancelled, who booked it and who organised it, its
 * video-call link, the calendar it came from, and the company, person and
 * project it is filed under — each by its id. Each calendar — a kind of event
 * — can be hidden from the week, the day and the schedule, and this browser
 * remembers which. A connections panel below the mini month names every
 * calendar this session may act on, when it last synced, and lets it be
 * reconnected, asked to sync now, or — an owner or admin only — a new one
 * connected (0057).
 *
 * The agenda used to be one Monday-to-Friday week that could not move, found
 * each event by its day of the month, and never showed a weekend event, an
 * all-day event west of Greenwich, or an event that began before the week.
 *
 * The week on screen is the store's to load (workspaceStore.showWeek), beside
 * today's, which the Overview needs; the month on screen, only while Month is
 * the view, the same way (showMonth). These replace agendaView and
 * eventDetail from workspace.js, and load after it. Tested in
 * tests/agenda-ui.test.mjs.
 */
(function () {
  'use strict';

  const A = agendaModel;

  /* The week on screen, and the day picked in it as a date key — null for the
     model's choice: today when it is drawn, else Monday. */
  let week = A.startWeek(new Date());
  let picked = null;
  /* The week the agenda opens on today. Someone still on it moves on with the
     date; someone who went to another week stays there. */
  let opening = week.key;

  /* The view the agenda opens on: the one last picked with its view buttons,
     remembered in this browser; else, where the week does not fit — five
     140px days, seven with the weekend (workspace.css) — the schedule, with
     Week a tap away. */
  const MODE_KEY = 'veyago.agenda.mode';
  const MODES = ['week', 'day', 'schedule', 'month'];
  let savedMode = null;
  try {
    const saved = window.localStorage ? window.localStorage.getItem(MODE_KEY) : null;
    savedMode = MODES.includes(saved) ? saved : null;
  } catch (err) {
    /* A browser that keeps nothing: no view to go back to. */
  }
  try {
    if (savedMode) agendaMode = savedMode;
    else if (agendaMode === 'week' && window.matchMedia && window.matchMedia('(max-width: 840px)').matches) agendaMode = 'schedule';
  } catch (err) {
    /* No media queries to ask: the week stays. */
  }

  /* The calendars — kinds of event — hidden from the week, the day and the
     schedule, remembered in this browser. What it remembers is read with care:
     only kinds the agenda has, and nothing at all when storage fails. */
  const HIDDEN_KEY = 'veyago.agenda.hiddenKinds';
  const isKind = value => A.KINDS.some(k => k.value === value);
  function rememberedHidden() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(HIDDEN_KEY) : null;
      const list = raw ? JSON.parse(raw) : [];
      return new Set((Array.isArray(list) ? list : []).filter(isKind));
    } catch (err) {
      return new Set();
    }
  }
  let hidden = rememberedHidden();
  function hide(next) {
    hidden = next;
    try {
      if (window.localStorage) window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
    } catch (err) {
      /* A browser that keeps nothing still hides them for now. */
    }
  }

  const store = () => window.workspaceStore || null;
  const eventsLoaded = () => Boolean(store() && store().has('events'));
  const weekReady = () => !store() || typeof store().weekLoaded !== 'function' || store().weekLoaded(week.key);
  /* A week whose events did not load says so, rather than "Loading…" for good:
     that week's own failure (store.js weekFailed), not one an earlier week had
     while this one is still on its way. */
  const weekFailed = () => {
    const s = store();
    if (s && typeof s.weekFailed === 'function') return s.weekFailed(week.key);
    return Boolean(s && s.state && (s.state.failed || []).includes('the agenda'));
  };
  const meId = () => (window.workspaceSession && workspaceSession.employee ? workspaceSession.employee.id : null);
  const isManager = () => Boolean(window.workspaceSession && workspaceSession.isManager && workspaceSession.isManager());
  const rowOf = event => (event && event.row) || event || {};
  const titleOf = event => String((event && event.title) || rowOf(event).title || 'Event');

  function show(next, day) {
    if (!next) return;
    week = next;
    picked = day || null;
    if (store() && typeof store().showWeek === 'function') store().showWeek(week);
  }

  /* On a new day, someone still on the week the agenda opened on moves on with
     it — when that is a new week: a day picked in the same week stays picked. */
  CAL.onChange(() => {
    const next = A.startWeek(new Date());
    if (week.key === opening && next.key !== week.key) show(next, null);
    opening = next.key;
  });

  /* "agenda/today" — the Overview's today and the bell's events today — opens
     this week with today picked, at #agenda: the week the agenda was left on
     is not today. It lands on #agenda in place of the address that asked, so
     Back does not open today again. */
  const TODAY = 'agenda/today';
  function openToday() {
    const now = new Date();
    show(A.weekOf(now), A.dayKey(now));
    const place = window.location;
    if (place && window.history && place.hash === '#' + TODAY) window.history.replaceState(null, '', '#agenda');
  }
  if (typeof navigate === 'function') {
    const before = navigate;
    navigate = function (target) {
      if (String(target == null ? '' : target) !== TODAY) return before(target);
      openToday();
      return before('agenda');
    };
  }

  /* ── The week ──────────────────────────────────────────────────────── */

  /* `monthGrid`, `monthIsReady`: only while Month is the view on screen — the
     month's own name and load state stand in for the week's. Previous, Today
     and Next step by whole months there instead of weeks (the click handler,
     below). */
  function toolbar(drawn, now, monthGrid, monthIsReady) {
    const unit = monthGrid ? 'month' : 'week';
    const name = monthGrid ? '' : A.weekName(week, now);
    const ready = monthGrid ? monthIsReady : weekReady();
    const caption = [name, ready ? '' : weekFailed() ? 'Did not load' : 'Loading…'].filter(Boolean).join(' · ');
    const heading = monthGrid ? `${monthGrid.name} ${monthGrid.year}` : A.rangeLabel(drawn);
    return '<div class="view-toolbar agenda-toolbar"><div class="agenda-week">'
      + `<button type="button" class="btn agenda-step" data-agenda-week="previous" aria-label="Previous ${unit}">${icon('chevron')}</button>`
      + '<button type="button" class="btn" data-agenda-week="today">Today</button>'
      + `<button type="button" class="btn agenda-step" data-agenda-week="next" aria-label="Next ${unit}">${icon('chevron')}</button>`
      + `<h2>${esc(heading)}${caption ? ` <small>${esc(caption)}</small>` : ''}</h2></div>`
      + segments([['week', 'Week'], ['day', 'Day'], ['schedule', 'Schedule'], ['month', 'Month']], agendaMode, 'agendaMode')
      + '</div>';
  }

  /* The whole month a day belongs to, since eventsOverlapping() needs its
     range, not just its cells: the day before the grid's first cell to the
     day after its last, so a multi-day event crossing the grid's edge still
     shows. `key` ("2026-10") is what store.js monthLoaded() is asked about —
     the month the grid is actually FOR, not the possibly-different month its
     spill-over first or last cell belongs to. */
  function monthRangeOf(m) {
    if (!m || !Array.isArray(m.cells) || !m.cells.length) return null;
    const first = A.parseDay(m.cells[0].key);
    const last = A.parseDay(m.cells[m.cells.length - 1].key);
    if (!first || !last) return null;
    const dayMs = 24 * 60 * 60 * 1000;
    const anchor = m.cells.find(c => c.inMonth) || m.cells[0];
    return Object.freeze({
      key: anchor.key.slice(0, 7),
      since: new Date(first.getTime() - dayMs).toISOString(),
      to: new Date(last.getTime() + dayMs).toISOString()
    });
  }

  const monthReady = range => !range || !store() || typeof store().monthLoaded !== 'function' || store().monthLoaded(range.key);

  function miniMonth(chosen, drawn, now) {
    const m = A.month(chosen ? chosen.key : null, week, now);
    const cell = c => {
      const names = A.dayNames(c.key);
      const isPicked = Boolean(chosen && c.key === chosen.key);
      const classes = [c.inWeek ? 'in-week' : '', c.inMonth ? '' : 'outside', c.today ? 'today' : '', isPicked ? 'selected' : '']
        .filter(Boolean).join(' ');
      return `<button type="button" data-agenda-day="${c.key}"${classes ? ` class="${classes}"` : ''}`
        + ` aria-label="${esc(names.weekday + ', ' + names.full + (picked === c.key ? ', picked' : ''))}"${c.today ? ' aria-current="date"' : ''}>${c.number}</button>`;
    };
    return `<section class="panel mini-calendar"><div class="section-title"><h2>${esc(m.name)}</h2><span>${m.year}</span></div>`
      + `<div class="mini-week" aria-hidden="true">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<span>${d}</span>`).join('')}</div>`
      + `<div class="mini-days">${m.cells.map(cell).join('')}</div>`
      + `<p class="quiet-text">${esc([A.weekName(week, now), A.rangeLabel(drawn, false)].filter(Boolean).join(' · '))}</p></section>`;
  }

  /* ── Connected calendars (0057, "No way to connect a calendar or see its
     last sync") — a small panel below the mini month: every calendar this
     session may act on (state.calendars, filtered by RLS the same way
     mailboxes() already is), when it last synced, and a way to reconnect one
     or ask it to sync now, without waiting for the schedule (sync-
     calendar-scheduled, every 15 minutes) or the next time the Agenda opens.
     "Connect a calendar" mirrors microsoft-connect's own rule: an owner or
     admin, saying whose (0057 actions.connectCalendar; connection-rules.ts
     connectRefusal on the backend, which this only avoids a doomed round
     trip to). ──────────────────────────────────────────────────────────── */

  const MINUTE = 60 * 1000;
  /* Whether this session may reconnect a calendar (microsoft-connect's own
     rule, connection-rules.ts connectRefusal): the studio's needs an owner
     or admin; state.calendars never carries a colleague's personal one — the
     query is filtered by RLS the same way mailboxesFor() already is — so
     anything else here is already this person's own. */
  const canReconnect = cal => (cal.employeeId === null ? isManager() : true);

  function syncedNote(cal) {
    if (!cal.live) return cal.status === 'needs_reauth' ? 'Needs reconnecting' : 'Not syncing';
    if (!cal.lastSyncedAt) return 'Not synced yet';
    const minutes = Math.round((Date.now() - new Date(cal.lastSyncedAt).getTime()) / MINUTE);
    if (minutes < 1) return 'Synced just now';
    if (minutes < 60) return `Synced ${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `Synced ${hours} h ago` : `Synced ${Math.round(hours / 24)} d ago`;
  }

  function connectionRow(cal) {
    const sync = `<button type="button" class="btn text-btn" data-agenda-calendar-sync="${esc(cal.id)}">Sync now</button>`;
    const reconnect = canReconnect(cal)
      ? `<button type="button" class="btn" data-agenda-calendar-reconnect="${esc(cal.id)}">Reconnect</button>` : '';
    return `<div class="calendar-connection"><p>${esc(cal.label)}</p>`
      + `<small>${esc(cal.employeeId === null ? 'Studio' : (cal.ownerName || 'Personal'))}</small>`
      + `<small class="${cal.live ? '' : 'mailbox-warning'}">${esc(syncedNote(cal))}</small>`
      + `<div class="calendar-connection-actions">${sync}${reconnect}</div></div>`;
  }

  function connectionsPanel() {
    const s = store();
    const known = Boolean(s && typeof s.has === 'function' && s.has('calendars'));
    const list = (known && s.state && s.state.calendars) || [];
    const body = !known
      ? '<p class="quiet-text" aria-busy="true">Loading…</p>'
      : list.length ? list.map(connectionRow).join('')
        : '<p class="quiet-text">No calendar is connected yet.</p>';
    const connect = isManager()
      ? '<button type="button" class="btn agenda-calendar-connect" data-agenda-calendar-connect>Connect a calendar</button>' : '';
    return `<section class="panel calendar-connections"><div class="section-title"><h2>Connected calendars</h2></div>${body}${connect}</section>`;
  }

  /* Each calendar a toggle in its colour — the key to the colours as well —
     above the week, so a phone has it too; and Show all once one is hidden. */
  const kindFilter = () => '<div class="agenda-kinds" role="group" aria-label="Calendars shown">'
    + A.KINDS.map(k => `<button type="button" class="calendar-key" data-agenda-kind="${k.value}" aria-pressed="${!hidden.has(k.value)}"><span class="key-${k.tone}" aria-hidden="true"></span>${esc(k.label)}</button>`).join('')
    + (hidden.size ? '<button type="button" class="btn agenda-kinds-all" data-agenda-kind="all">Show all</button>' : '')
    + '</div>';

  /* How many of a day's events are in hidden calendars: on their own, or more
     beside the ones shown. */
  const inHidden = (n, beside) => (beside ? `${n} more` : `${n} ${n === 1 ? 'event' : 'events'}`)
    + ` in ${n === 1 ? 'a hidden calendar' : 'hidden calendars'}`;

  /* A day with the hidden calendars' events taken out, and how many were, so a
     day says what it is not showing. Clashes stay as they were found: a clash
     with a hidden event is still one. */
  const shownOn = day => Object.assign({}, day, {
    events: day.events.filter(p => !hidden.has(p.kind.value)),
    hiddenCount: day.events.filter(p => hidden.has(p.kind.value)).length
  });

  /* An event on one of its days: the time it has there, and what it clashes with. */
  function card(p) {
    const classes = ['calendar-event', 'type-' + p.kind.value, 'part-' + p.part, p.clash ? 'clash' : '', p.tentative ? 'tentative' : '']
      .filter(Boolean).join(' ');
    const detail = p.event && p.event.detail ? `<small>${esc(p.event.detail)}</small>` : '';
    const others = p.clashesWith.filter(Boolean);
    const clash = p.clash ? `<small class="clash-note">Clashes with ${esc(others.length ? others.join(', ') : 'another event')}</small>` : '';
    return `<a class="${classes}" href="#agenda/${esc(p.id)}"><small>${esc(p.time)}</small><strong>${esc(p.title)}</strong><span class="sr-only">, ${esc(p.kind.label)}${p.tentative ? ', tentative' : ''}.</span>${detail}${clash}</a>`;
  }

  const dayButton = d => `<button type="button" class="calendar-day-button" data-agenda-day="${d.key}"`
    + ` aria-label="${esc(d.weekday + ', ' + d.full + (picked === d.key ? ', picked' : ''))}"${d.today ? ' aria-current="date"' : ''}><span>${esc(d.short)}</span><strong>${d.number}</strong></button>`;

  /* A day with nothing on it is simply empty; a week with nothing on it says
     so once, rather than a filler line in every column. */
  const weekView = drawn => (drawn.every(d => !d.events.length && !d.hiddenCount) ? '<p class="quiet-text week-empty">Nothing on this week: room to focus.</p>' : '')
    + `<section class="panel calendar${drawn.length === 7 ? ' with-weekend' : ''}">`
    + drawn.map(d => `<div class="calendar-day${d.today ? ' today' : ''}${d.selected ? ' selected' : ''}">${dayButton(d)}`
      + (d.events.length
        ? d.events.map(card).join('') + (d.hiddenCount ? `<small class="hidden-note">${inHidden(d.hiddenCount, true)}</small>` : '')
        : (d.hiddenCount ? `<div class="empty-calendar">${inHidden(d.hiddenCount, false)}</div>` : '')) + '</div>').join('')
    + '</section>';

  function dayView(chosen) {
    const list = chosen ? chosen.events : [];
    return `<section class="panel day-view"><div class="list-toolbar"><h2>${esc(chosen ? chosen.weekday + ', ' + chosen.full : '')}</h2>${countTag(list.length)}</div>`
      + (list.length
        ? list.map(p => `<div class="day-event"><div class="day-event-time">${esc(p.time)}</div>${card(p)}<span aria-hidden="true">${pill(p.kind.label, p.kind.tone)}</span></div>`).join('')
          + (chosen.hiddenCount ? `<p class="quiet-text hidden-note">${inHidden(chosen.hiddenCount, true)}.</p>` : '')
        : chosen && chosen.hiddenCount ? empty('Nothing in the calendars shown', 'Show the hidden calendars to see this day’s events.')
          : empty('A clear day', 'Add an event or use the space to focus.'))
      + '</section>';
  }

  const scheduleView = drawn => '<section class="panel schedule-view">'
    + drawn.map(d => `<div class="schedule-date${d.today ? ' today' : ''}"${d.today ? ' aria-current="date"' : ''}>${esc(d.weekday)}<strong>${esc(d.label)}</strong></div>`
      + (d.events.length
        ? d.events.map(p => `<a href="#agenda/${esc(p.id)}" class="schedule-row${p.clash ? ' clash' : ''}"><span>${esc(p.time)}</span><strong>${esc(p.title)}</strong>${p.tentative ? '<small class="tentative-note">Tentative</small>' : ''}${pill(p.kind.label, p.kind.tone)}</a>`).join('')
          + (d.hiddenCount ? `<p class="quiet-text schedule-empty">${inHidden(d.hiddenCount, true)}.</p>` : '')
        : `<p class="quiet-text schedule-empty">${d.hiddenCount ? inHidden(d.hiddenCount, false) : 'No events scheduled'}.</p>`)).join('')
    + '</section>';

  /* A month at a glance ("No way to change weeks, and no month view"): every
     day of the whole grid (agendaModel.month, the spill from the months
     either side included, as the mini calendar already draws it), each day's
     events placed the way any other view's are (agendaModel.eventsOn) — so a
     clash, a hidden calendar or a tentative event reads the same everywhere.
     A day busier than MAX_MONTH_EVENTS shows the rest as "+N more"; either
     the number or a day's own events reuses data-agenda-day, so clicking any
     of it opens Day view for that date, exactly as the mini calendar does. */
  const MAX_MONTH_EVENTS = 3;

  function monthCell(c) {
    const key = c.key;
    const placed = eventsLoaded() ? A.eventsOn(events, key) : [];
    const day = shownOn({ events: placed });
    const shown = day.events.slice(0, MAX_MONTH_EVENTS);
    const extra = day.events.length - shown.length;
    const names = A.dayNames(key);
    const classes = ['month-cell', c.inMonth ? '' : 'outside', c.today ? 'today' : '', picked === key ? 'selected' : '']
      .filter(Boolean).join(' ');
    const html = `<div class="${classes}">`
      + `<button type="button" class="month-day-number" data-agenda-day="${key}"`
      + ` aria-label="${esc(names.weekday + ', ' + names.full + (picked === key ? ', picked' : ''))}"${c.today ? ' aria-current="date"' : ''}>${c.number}</button>`
      + '<div class="month-events">'
      + shown.map(p => `<a class="month-event type-${p.kind.value}${p.clash ? ' clash' : ''}" href="#agenda/${esc(p.id)}">`
          + `${p.allDay ? '' : `<small>${esc(p.time)}</small> `}${esc(p.title)}</a>`).join('')
      + (extra > 0 ? `<button type="button" class="month-more" data-agenda-day="${key}">+${extra} more</button>` : '')
      + (day.hiddenCount ? `<small class="hidden-note">${inHidden(day.hiddenCount, shown.length > 0)}</small>` : '')
      + '</div></div>';
    return { html, empty: !placed.length };
  }

  function monthView(m) {
    const cells = m.cells.map(monthCell);
    return (cells.every(c => c.empty) ? '<p class="quiet-text week-empty">Nothing this month: room to focus.</p>' : '')
      + '<section class="panel month-view">'
      + `<div class="month-weekdays" aria-hidden="true">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span>${d}</span>`).join('')}</div>`
      + `<div class="month-grid">${cells.map(c => c.html).join('')}</div>`
      + '</section>';
  }

  agendaView = function () {
    /* An address typed as #agenda/today, before this file could make it #agenda. */
    if (routeParts[1] === 'today') {
      openToday();
      routeParts = ['agenda'];
    }
    if (routeParts[1] !== undefined) return eventPage(String(routeParts[1]));
    const now = new Date();
    const drawn = A.weekDays(eventsLoaded() ? events : [], week, { now, selected: picked });
    const shown = drawn.map(shownOn);
    const chosen = shown.find(d => d.selected) || shown[0] || null;

    /* Month mode's grid is anchored on `picked` — set to the 1st of the month
       Previous/Next moved to, which need not be one of `week`'s own seven
       days — falling back to `week`/today exactly as the mini calendar's own
       A.month() call already does. showMonth(range) tells the store which
       month to load, or that none is shown any more (leaving month view):
       cheap either way when nothing changed (store.js), so calling it on
       every render, not only when the view is switched, is how showWeek's
       own callers already treat it too. */
    const monthGrid = agendaMode === 'month' ? A.month(picked, week, now) : null;
    const monthRange = monthGrid ? monthRangeOf(monthGrid) : null;
    if (store() && typeof store().showMonth === 'function') store().showMonth(monthRange);

    /* Loading until the week's or month's events arrive or the load fails: a
       week or month still on its way does not look free, nor one not yet
       asked for failed. */
    const ready = monthGrid ? monthReady(monthRange) : weekReady();
    const failedToLoad = (!eventsLoaded() || !ready) && weekFailed();
    const loading = !failedToLoad && (!eventsLoaded() || !ready);
    const body = failedToLoad
      ? `<section class="panel agenda-waiting">${empty('The agenda did not load', 'It is tried again by itself.')}</section>`
      : loading ? `<section class="panel agenda-waiting" aria-busy="true">${empty(monthGrid ? 'Loading the month…' : 'Loading the week…', 'Its events are on their way.')}</section>`
        : agendaMode === 'day' ? dayView(chosen)
          : agendaMode === 'schedule' ? scheduleView(shown)
            : monthGrid ? monthView(monthGrid)
              : weekView(shown);
    return titlebar('A little space for what’s next.', 'Your meetings and focused work, together.', createButton('New event', 'agenda'))
      + toolbar(drawn, now, monthGrid, ready)
      + (failedToLoad || loading ? '' : kindFilter())
      + `<div class="calendar-layout"><aside class="calendar-side">${miniMonth(chosen, drawn, now)}${connectionsPanel()}</aside>`
      + `<div class="calendar-primary">${body}</div></div>`;
  };

  /* ── An event's page ───────────────────────────────────────────────── */

  /* A hand-made event — no calendar connection — can be changed or removed by
     whoever booked it, or an owner or admin (0048). A synced one is nobody's
     to PATCH straight through RLS (0026): update-calendar-event and delete-
     calendar-event change it in Outlook first, then here (0057), for
     whoever may act on the CALENDAR it is in — the studio's, shared, for any
     member of staff, or a personal one for its own owner alone, the same
     line the backend draws (_shared/connection-rules.ts mayActOn). Who
     created the row is beside the point for a synced event; a manager gets
     no special say over a colleague's own calendar either. An event whose
     columns did not load, or whose calendar has not (state.calendars),
     shows no button rather than a guess. */
  function canChange(event) {
    const row = rowOf(event);
    if (row.connection_id === null) {
      return isManager() || (row.created_by != null && row.created_by === meId());
    }
    const cal = calendarOf(row.connection_id);
    return Boolean(cal) && (cal.employeeId === null || cal.employeeId === meId());
  }

  /* A connected calendar by its connection id (store.js state.calendars,
     0057): what canChange, and the event page's "Calendar" property, read to
     say whose it is. */
  const calendarOf = id => (id == null ? null : ((store() && store().state && store().state.calendars) || []).find(c => c && c.id === id) || null);

  /* The store's lookup (workspaceStore.eventById): the weeks loaded, then the
     project meetings coming up. Before the store is on the page, nothing is. */
  const eventById = id => (store() && typeof store().eventById === 'function' ? store().eventById(id) : null);

  /* Someone on the team by id (store.js team), and a company loaded by id. */
  const nameOf = id => ((typeof team === 'undefined' || !Array.isArray(team) ? [] : team).find(m => m && m.id === id) || {}).name || null;
  const companyOf = id => ((store() && store().state && store().state.companies) || []).find(c => c && c.id === id) || null;
  const trimmed = value => (typeof value === 'string' ? value.trim() : '');

  /* How an invitee answered, as Outlook records it (graph-message.ts). */
  const REPLIES = new Map([['accepted', 'Accepted'], ['declined', 'Declined'], ['tentativelyAccepted', 'Maybe'], ['organizer', 'Organiser']]);

  /* What an event's status says on its page; a confirmed one says nothing. */
  const STATUS_WORDS = new Map([['tentative', 'Tentative: not confirmed yet'], ['cancelled', 'Cancelled']]);

  /* Who is invited: from the row when it brought them — an event fetched by
     its id — else asked for by the page (store.js askInvitees), since the
     lists leave out the largest column an event has. */
  function inviteesOf(e, row) {
    if (Array.isArray(row.attendees)) return { state: 'ready', attendees: row.attendees };
    const s = store();
    return s && typeof s.askInvitees === 'function' ? s.askInvitees(e.id) : { state: 'missing', attendees: [] };
  }

  /* As the calendar recorded them (0026: [{name, email, response}]): each by
     name, else by address. An entry with neither is not an invitee. Nothing
     while they load; a word when they did not. */
  function invitedPanel(e, row) {
    const asked = inviteesOf(e, row);
    if (asked.state === 'failed') {
      return '<section class="panel content-panel attendee-panel"><h2>Invited</h2><p class="quiet-text">Who is invited did not load. It is tried again by itself.</p></section>';
    }
    const people = (asked.state === 'ready' && Array.isArray(asked.attendees) ? asked.attendees : [])
      .filter(a => a && typeof a === 'object' && (trimmed(a.name) || trimmed(a.email)));
    if (!people.length) return '';
    return '<section class="panel content-panel attendee-panel"><h2>Invited</h2><ul class="attendee-list" role="list">'
      + people.map(a => {
        const address = trimmed(a.email);
        const name = trimmed(a.name) || address;
        const under = trimmed(a.name) && address && trimmed(a.name).toLowerCase() !== address.toLowerCase() ? `<small>${esc(address)}</small>` : '';
        return `<li><div><strong>${esc(name)}</strong>${under}</div><span class="attendee-reply">${esc(REPLIES.get(a.response) || 'No reply yet')}</span></li>`;
      }).join('')
      + '</ul></section>';
  }

  function eventPage(id) {
    let e = eventById(id);
    if (!e) {
      if (!eventsLoaded()) {
        return detailHeader('agenda', 'Calendar', 'This event cannot be shown yet.',
          weekFailed() ? 'The agenda did not load. It is tried again by itself.' : 'The agenda is loading.');
      }
      /* Not in the weeks loaded — a client's past meeting, or a link to one:
         the store asks for it by its id, and the page is drawn again when it
         lands. */
      const asked = store() && typeof store().askEvent === 'function' ? store().askEvent(id) : { state: 'missing', event: null };
      if (asked.state === 'loading') return detailHeader('agenda', 'Calendar', 'Loading the event…', 'It is not in the weeks loaded, so it is being fetched.');
      if (asked.state === 'failed') {
        return detailHeader('agenda', 'Calendar', 'This event did not load.', 'It is tried again by itself.',
          `<button type="button" class="btn" data-agenda-event-retry="${esc(String(id))}">Try again</button>`);
      }
      if (asked.state !== 'ready' || !asked.event) return notFound();
      e = asked.event;
    }
    const row = rowOf(e);
    const when = A.span(e);
    const names = when ? A.dayNames(when.first) : null;
    const kind = A.kindOf(e);
    const title = titleOf(e);
    const contact = row.contact_id ? contacts.find(c => c.id === row.contact_id) || null : null;
    const project = row.project_id ? projects.find(p => p.uuid === row.project_id || p.id === row.project_id) || null : null;
    const eventId = esc(String(e.id));
    const actions = canChange(e)
      ? `<button type="button" class="btn" data-agenda-edit="${eventId}">Edit event</button><button type="button" class="btn" data-agenda-delete="${eventId}">Remove event</button>`
      : '';
    /* Which calendar, and whose (0057): the connection's own label once
       state.calendars has it, "studio calendar" for the shared one, else the
       team member it belongs to. A connection not among those loaded — the
       calendars part failed, or this is not one the session can see — falls
       back to the same plain word the page always said, rather than a guess. */
    const calendar = row.connection_id ? calendarOf(row.connection_id) : null;
    const calendarNote = calendar
      ? `${calendar.label} (${calendar.employeeId === null ? 'studio calendar' : (calendar.ownerName || 'personal calendar')})`
      : 'In a connected calendar';
    const booked = row.connection_id === undefined ? [] : [['Booked', esc(row.connection_id ? calendarNote : 'In the workspace only')]];
    /* The lists never load a cancelled event, but one opened by its link can
       be one: it says so, as a tentative one does. One made in Outlook was
       booked by no one here; until the team has loaded, no one is said to have
       left it. */
    const statusRow = STATUS_WORDS.has(row.status) ? [['Status', esc(STATUS_WORDS.get(row.status))]] : [];
    const teamLoaded = Boolean(store() && typeof store().has === 'function' && store().has('team'));
    const booker = row.created_by && teamLoaded ? [['Booked by', esc(nameOf(row.created_by) || 'Someone no longer on the team')]] : [];
    /* A synced event's own organiser, video-call link and booking zone (0057:
       graph-message.ts kept these instead of throwing them away). Checked for
       https here too, on the values as this session actually has them — never
       trusting a single layer, the way esc() is never skipped because a value
       "should" already be safe. */
    const meetingRow = row.meeting_url && /^https:\/\//i.test(row.meeting_url)
      ? [['Video call', `<a href="${esc(row.meeting_url)}" target="_blank" rel="noopener noreferrer">Join</a>`]]
      : [];
    const organizerRow = (row.organizer_name || row.organizer_email)
      ? [['Organiser', esc(row.organizer_name || row.organizer_email)]]
      : [];
    const zoneRow = row.time_zone ? [['Booked in', esc(row.time_zone)]] : [];
    const company = row.company_id ? companyOf(row.company_id) : null;
    return detailHeader('agenda', 'Calendar', title, A.dateLabel(e), actions)
      + '<div class="record-layout"><div class="record-main">'
      + `<section class="panel event-summary"><div class="date-tile" aria-hidden="true"><span>${esc(names ? names.monthAbbr : '')}</span><strong>${names ? names.number : ''}</strong></div>`
      + `<div><h2>${esc(title)}</h2><p>${esc(A.timeLabel(e))}</p>${row.location ? `<small>${esc(row.location)}</small>` : ''}</div>${pill(kind.label, kind.tone)}</section>`
      + (row.detail ? `<section class="panel content-panel"><h2>Meeting brief</h2><p class="body-copy">${esc(row.detail)}</p></section>` : '')
      + invitedPanel(e, row)
      + notesPanel('agenda', String(e.id)) + '</div>'
      + `<aside class="record-aside">${properties([
        ['Date', esc(A.dateLabel(e))],
        ['Time', esc(A.timeLabel(e))],
        ...statusRow,
        ['Calendar', pill(kind.label, kind.tone)],
        ['Where', esc(row.location || 'Not given')],
        ...meetingRow,
        ...booked,
        ...booker,
        ...organizerRow,
        ...zoneRow
      ])}`
      + linkedPanel('Connected work', [
        ...(company ? [[`crm/companies/${company.id}`, company.name, 'Company', 'crm']] : []),
        ...(contact ? [[`crm/${contact.id}`, contact.name, contact.company || 'Contact', 'crm']] : []),
        ...(project ? [[`projects/${project.id}`, project.name, 'Project workspace', 'projects']] : [])
      ])
      + '</aside></div>';
  }

  /* The parts of the store an event comes back in once it is changed or
     removed: the weeks loaded — and, for a project meeting, the project
     meetings coming up too, where its page finds it once it is out of the
     weeks. One fetched by its id is fetched again anyway (store.js askEvent). */
  function partsOf(event) {
    return rowOf(event).project_id ? ['events', 'projectEvents'] : ['events'];
  }

  /* Removing an event asks first, on dialog-forms.js: a refusal is said on the
     dialog, and until the page no longer has the event its Edit and Remove
     wait (the click handler below, and event-edit.js). */
  function openRemove(event) {
    const connectionId = rowOf(event).connection_id || null;
    showModal('AGENDA · REMOVE', `<h2>Remove ${esc(titleOf(event))}?</h2>`
      + `<p class="form-note">${connectionId ? 'It is also removed from the calendar it is in.' : 'It leaves the agenda for everyone.'}</p>`
      + dialogForms.form('agenda-remove-form', '', 'Remove event'));
    const form = document.getElementById('agenda-remove-form');
    form.addEventListener('submit', submitted => {
      submitted.preventDefault();
      dialogForms.quiet(form);
      dialogForms.sending(form, () => workspaceActions.deleteEvent(String(event.id), connectionId), () => {
        navigate('agenda');
        toast('Event removed.');
      }, { record: `event:${String(event.id).toLowerCase()}`, part: partsOf(event), only: partsOf(event) });
    });
  }

  /* A tab reserved before the async call, the way mail.js's own mailbox
     Reconnect already does: opened on the click itself, so a browser does
     not treat it as an unrequested pop-up once microsoft-connect answers a
     moment later. Not itself unit-tested past this call: coming back to this
     tab and reloading the workspace is DOM-only, the same as mail.js's
     identical, already-shipped mechanism, which this project has never had a
     harness for either (no jsdom, no window to leave and return to). */
  function openTab() {
    try {
      return typeof window.open === 'function' ? window.open('', '_blank') : null;
    } catch (err) {
      return null;
    }
  }
  function toMicrosoft(tab, url) {
    if (tab) { tab.opener = null; tab.location.href = url; return; }
    if (window.location && typeof window.location.assign === 'function') window.location.assign(url);
  }

  function openReconnect(button, cal) {
    const tab = openTab();
    if (tab) tab.document.title = 'Connecting to Microsoft…';
    button.disabled = true;
    workspaceActions.connectCalendar(cal.label)
      .then(url => {
        toMicrosoft(tab, url);
        toast(`Finish in the Microsoft tab. ${cal.label} updates when you come back.`);
      })
      .catch(err => {
        if (tab) tab.close();
        toast((err && err.message) || 'Reconnecting could not start.');
      })
      .then(() => { button.disabled = false; });
  }

  /* Connecting a NEW calendar — never a reconnect — is an owner or admin's
     to do, saying whose it is (microsoft-connect's own rule,
     connection-rules.ts connectRefusal): "Studio" is the form's default, sent
     as employeeId null explicitly, since leaving it out would mean "keep
     whatever owner it already has" — right for a reconnect, wrong for a
     brand new row that has none yet. */
  function openConnect() {
    const offered = (typeof team !== 'undefined' && Array.isArray(team) ? team : []).filter(m => m && m.id);
    showModal('AGENDA · CONNECT', '<h2>Connect a calendar</h2>'
      + dialogForms.form('agenda-connect-form',
        dialogForms.field('Address', '<input name="address" type="email" required autofocus placeholder="name@veyago.cloud">')
        + dialogForms.field('Whose', '<select name="whose"><option value="">Studio (shared with everyone)</option>'
          + dialogForms.options(offered.map(m => ({ value: m.id, label: m.name })), null) + '</select>'),
        'Continue to Microsoft'));
    const form = document.getElementById('agenda-connect-form');
    form.addEventListener('submit', submitted => {
      submitted.preventDefault();
      const button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      dialogForms.quiet(form);
      const data = new FormData(form);
      const address = String(data.get('address') || '').trim();
      if (!address) { dialogForms.say(form, 'Say which address to connect.', 'address'); return; }
      const whose = String(data.get('whose') || '');
      button.disabled = true;
      const tab = openTab();
      if (tab) tab.document.title = 'Connecting to Microsoft…';
      workspaceActions.connectCalendar(address, whose || null)
        .then(url => {
          toMicrosoft(tab, url);
          dialogForms.closeDialog(form);
          toast(`Finish in the Microsoft tab. ${address} updates when you come back.`);
        })
        .catch(err => {
          if (tab) tab.close();
          button.disabled = false;
          dialogForms.say(form, (err && err.message) || 'Connecting could not start.');
        });
    });
  }

  /* ── What the page's buttons do ────────────────────────────────────── */

  document.addEventListener('click', e => {
    const step = e.target.closest && e.target.closest('[data-agenda-week]');
    if (step) {
      e.preventDefault();
      const now = new Date();
      const to = step.dataset.agendaWeek;
      if (to === 'today') show(A.weekOf(now), A.dayKey(now));
      else if (agendaMode === 'month') {
        /* A month, not a week: the 1st of the one before or after whichever
           the grid is showing now (picked, else week's own Monday) — passed
           as `picked`, which A.month() reads before it falls back to `week`,
           so the grid moves even when that 1st falls in a week still mostly
           in the OLD month. */
        const anchor = A.parseDay(picked) || A.parseDay(week.key) || now;
        const target = A.dayKey(new Date(anchor.getFullYear(), anchor.getMonth() + (to === 'previous' ? -1 : 1), 1));
        show(A.weekOf(target), target);
      } else show(A.shiftWeek(week, to === 'previous' ? -1 : 1), null);
      repaintKeepingFocus();
      return;
    }
    /* A view picked with the view buttons (workspace.js switches it) is the
       one the agenda opens on next time. */
    const view = e.target.closest && e.target.closest('[data-view]');
    if (view && view.dataset.view === 'agendaMode' && MODES.includes(view.dataset.value)) {
      try {
        if (window.localStorage) window.localStorage.setItem(MODE_KEY, view.dataset.value);
      } catch (err) {
        /* A browser that keeps nothing still switches the view. */
      }
      return;
    }
    const kind = e.target.closest && e.target.closest('[data-agenda-kind]');
    if (kind) {
      e.preventDefault();
      const value = kind.dataset.agendaKind;
      if (value === 'all') {
        hide(new Set());
        repaintKeepingFocus();
        /* Show all is gone once pressed: the first calendar takes the keyboard. */
        const first = typeof document.querySelector === 'function' ? document.querySelector('#main [data-agenda-kind]') : null;
        if (first) first.focus({ preventScroll: true });
        return;
      }
      if (!isKind(value)) return;
      hide(hidden.has(value) ? new Set([...hidden].filter(v => v !== value)) : new Set([...hidden, value]));
      repaintKeepingFocus();
      return;
    }
    const day = e.target.closest && e.target.closest('[data-agenda-day]');
    if (day) {
      e.preventDefault();
      const key = A.dayKey(day.dataset.agendaDay);
      if (!key) return;
      show(week.days.includes(key) ? week : A.weekOf(key), key);
      agendaMode = 'day';
      repaintKeepingFocus();
      /* The day's button is gone from Day view — and at a narrow width the mini
         month with it — so the day's heading takes the focus. */
      const heading = typeof document.querySelector === 'function' ? document.querySelector('#main .day-view h2') : null;
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
      return;
    }
    const retry = e.target.closest && e.target.closest('[data-agenda-event-retry]');
    if (retry) {
      e.preventDefault();
      if (store() && typeof store().retryEvent === 'function') store().retryEvent(retry.dataset.agendaEventRetry);
      repaintKeepingFocus();
      /* The button is gone once the page is drawn again: its heading takes the keyboard. */
      const title = typeof document.querySelector === 'function' ? document.querySelector('#main h1') : null;
      if (title) {
        title.setAttribute('tabindex', '-1');
        title.focus({ preventScroll: true });
      }
      return;
    }
    const sync = e.target.closest && e.target.closest('[data-agenda-calendar-sync]');
    if (sync) {
      e.preventDefault();
      if (sync.disabled) return;
      if (!store() || !store().state.loaded) { toast('Not yet: the workspace is still loading.'); return; }
      const id = sync.dataset.agendaCalendarSync;
      sync.disabled = true;
      workspaceActions.syncCalendar(id)
        .then(result => {
          const n = result && typeof result.events === 'number' ? result.events : null;
          const synced = n === null ? 'Synced.' : `Synced: ${n} event${n === 1 ? '' : 's'}.`;
          /* An event Outlook no longer has, that the sync used to leave on the
             agenda forever, is now cancelled here too (0064) — said, not just
             done silently, so a sync that quietly cleared a dozen stale
             meetings is not mistaken for one that did nothing. */
          const removed = result && typeof result.cancelled === 'number' ? result.cancelled : 0;
          toast(removed > 0 ? `${synced} ${removed} no longer in Outlook.` : synced);
          /* calendars for its fresh last-synced time, events for anything new —
             not the whole workspace: the audit's own "every save reloads the
             whole workspace" applies here too. */
          return store().load({ quiet: true, only: ['calendars', 'events'] });
        })
        .catch(err => { toast((err && err.message) || 'Syncing could not start.'); })
        .then(() => { sync.disabled = false; });
      return;
    }
    const reconnect = e.target.closest && e.target.closest('[data-agenda-calendar-reconnect]');
    if (reconnect) {
      e.preventDefault();
      if (reconnect.disabled) return;
      if (!store() || !store().state.loaded) { toast('Not yet: the workspace is still loading.'); return; }
      const cal = ((store().state.calendars) || []).find(c => c && c.id === reconnect.dataset.agendaCalendarReconnect);
      if (!cal) return;
      openReconnect(reconnect, cal);
      return;
    }
    const connect = e.target.closest && e.target.closest('[data-agenda-calendar-connect]');
    if (connect) {
      e.preventDefault();
      if (!store() || !store().state.loaded) { toast('Not yet: the workspace is still loading.'); return; }
      openConnect();
      return;
    }
    const remove = e.target.closest && e.target.closest('[data-agenda-delete]');
    if (!remove) return;
    e.preventDefault();
    if (!store() || !store().state.loaded) { toast('Not yet: the workspace is still loading.'); return; }
    const event = eventById(remove.dataset.agendaDelete);
    if (!event || !canChange(event)) { toast('This event cannot be removed here.'); return; }
    /* A change to it still on its way (event-edit.js): the page shows it as it
       was, so it is not removed from under that change. */
    if (typeof dialogForms !== 'undefined' && dialogForms.stillSaving(`event:${String(event.id).toLowerCase()}`)) {
      toast('The last change to that event is still on its way. Try again in a moment.');
      return;
    }
    openRemove(event);
  });

  /* The days New event opens on (event-edit.js), all seven. Opened
     on the Agenda: the week on screen, with the day picked chosen, else today
     when it is in that week, else Monday. Opened anywhere else: this week, with
     today chosen — not whatever week the agenda was left on. */
  function dayOptions(options) {
    const now = new Date();
    const today = A.dayKey(now);
    const onAgenda = Boolean(options && options.onAgenda);
    const shown = onAgenda ? week : A.weekOf(now);
    const chosen = onAgenda && picked && shown.days.includes(picked) ? picked : shown.days.includes(today) ? today : shown.days[0];
    return Object.freeze(shown.days.map(key => {
      const names = A.dayNames(key);
      return Object.freeze({ key, label: names ? `${names.weekday}, ${names.label}` : key, selected: key === chosen });
    }));
  }

  /* The name of a calendar the agenda is hiding, or null: a new event booked in
     it would otherwise seem to have gone nowhere (event-edit.js). */
  const hiddenCalendar = value => (hidden.has(value) ? (A.KINDS.find(k => k.value === value) || {}).label || null : null);

  /* For event-edit.js: the day New event opens on, who may change an event, the parts it comes back in, and a calendar hidden. */
  window.agendaUi = Object.freeze({ dayOptions, canChange, partsOf, hiddenCalendar });
})();
