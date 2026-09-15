/* agenda-ui.js — the Agenda: a week, a day or a schedule, and an event's page.
 *
 * As agenda-model.js works them out. Any week can be shown: Previous, Today and
 * Next move a week at a time, and a day picked in the mini month opens that
 * day, in its own week. Saturday and Sunday are drawn whenever something is on
 * them, today is one of them, or one was picked. An event is on every day it
 * covers, at the time it has on that day, and one that overlaps another says
 * which. Kinds read in their own colours. A hand-made event can be removed by
 * whoever booked it, or by an owner or admin (0048); one synced from a
 * calendar is changed there. An event's page says who is invited and how each
 * answered, whether it is only tentative or cancelled, who booked it, and the
 * company, person and project it is filed under — each by its id. Each
 * calendar — a kind of event — can be hidden from the week, the day and the
 * schedule, and this browser remembers which.
 *
 * The agenda used to be one Monday-to-Friday week that could not move, found
 * each event by its day of the month, and never showed a weekend event, an
 * all-day event west of Greenwich, or an event that began before the week.
 *
 * The week on screen is the store's to load (workspaceStore.showWeek), beside
 * today's, which the Overview needs. These replace agendaView and eventDetail
 * from workspace.js, and load after it. Tested in tests/agenda-ui.test.mjs.
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
  const MODES = ['week', 'day', 'schedule'];
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

  function toolbar(drawn, now) {
    const name = A.weekName(week, now);
    const caption = [name, weekReady() ? '' : weekFailed() ? 'Did not load' : 'Loading…'].filter(Boolean).join(' · ');
    return '<div class="view-toolbar agenda-toolbar"><div class="agenda-week">'
      + `<button type="button" class="btn agenda-step" data-agenda-week="previous" aria-label="Previous week">${icon('chevron')}</button>`
      + '<button type="button" class="btn" data-agenda-week="today">Today</button>'
      + `<button type="button" class="btn agenda-step" data-agenda-week="next" aria-label="Next week">${icon('chevron')}</button>`
      + `<h2>${esc(A.rangeLabel(drawn))}${caption ? ` <small>${esc(caption)}</small>` : ''}</h2></div>`
      + segments([['week', 'Week'], ['day', 'Day'], ['schedule', 'Schedule']], agendaMode, 'agendaMode')
      + '</div>';
  }

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
    /* Loading until the week's events arrive or its load fails: a week still
       on its way does not look free, nor one not yet asked for failed. */
    const failedToLoad = (!eventsLoaded() || !weekReady()) && weekFailed();
    const loading = !failedToLoad && (!eventsLoaded() || !weekReady());
    const body = failedToLoad
      ? `<section class="panel agenda-waiting">${empty('The agenda did not load', 'It is tried again by itself.')}</section>`
      : loading ? `<section class="panel agenda-waiting" aria-busy="true">${empty('Loading the week…', 'Its events are on their way.')}</section>`
        : agendaMode === 'day' ? dayView(chosen)
          : agendaMode === 'schedule' ? scheduleView(shown)
            : weekView(shown);
    return titlebar('A little space for what’s next.', 'Your meetings and focused work, together.', createButton('New event', 'agenda'))
      + toolbar(drawn, now)
      + (failedToLoad || loading ? '' : kindFilter())
      + `<div class="calendar-layout"><aside class="calendar-side">${miniMonth(chosen, drawn, now)}</aside>`
      + `<div class="calendar-primary">${body}</div></div>`;
  };

  /* ── An event's page ───────────────────────────────────────────────── */

  /* A hand-made event — no calendar connection — can be changed or removed by
     whoever booked it, or an owner or admin (0048). A synced one belongs to its
     calendar: changed or removed here, the next sync would put it back. An
     event whose columns did not load shows no button rather than a guess. */
  function canChange(event) {
    const row = rowOf(event);
    if (row.connection_id !== null) return false;
    return isManager() || (row.created_by != null && row.created_by === meId());
  }

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
    const booked = row.connection_id === undefined ? [] : [['Booked', esc(row.connection_id ? 'In a connected calendar' : 'In the workspace only')]];
    /* The lists never load a cancelled event, but one opened by its link can
       be one: it says so, as a tentative one does. One made in Outlook was
       booked by no one here; until the team has loaded, no one is said to have
       left it. */
    const statusRow = STATUS_WORDS.has(row.status) ? [['Status', esc(STATUS_WORDS.get(row.status))]] : [];
    const teamLoaded = Boolean(store() && typeof store().has === 'function' && store().has('team'));
    const booker = row.created_by && teamLoaded ? [['Booked by', esc(nameOf(row.created_by) || 'Someone no longer on the team')]] : [];
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
        ...booked,
        ...booker
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
    showModal('AGENDA · REMOVE', `<h2>Remove ${esc(titleOf(event))}?</h2>`
      + '<p class="form-note">It leaves the agenda for everyone.</p>'
      + dialogForms.form('agenda-remove-form', '', 'Remove event'));
    const form = document.getElementById('agenda-remove-form');
    form.addEventListener('submit', submitted => {
      submitted.preventDefault();
      dialogForms.quiet(form);
      dialogForms.sending(form, () => workspaceActions.deleteEvent(String(event.id)), () => {
        navigate('agenda');
        toast('Event removed.');
      }, { record: `event:${String(event.id).toLowerCase()}`, part: partsOf(event) });
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
      else show(A.shiftWeek(week, to === 'previous' ? -1 : 1), null);
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
