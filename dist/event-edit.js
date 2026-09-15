/* event-edit.js — adding an event, and changing one made in the workspace: its
 * title, when it starts and ends, where it is and its details.
 *
 * New event is this file's own dialog (it takes over app.js's createForm for
 * the agenda). It opens on the day the agenda offers first, at ten for half an
 * hour — or, on today, at the time a project's meeting would suggest, so it
 * does not open on a time already gone — and books the event with each field
 * where it belongs: the place, the details, who is invited, as addresses, and
 * the project, client or person it is for, which makes it client work, booked
 * in the studio calendar (create-calendar-event). An all-day event is booked
 * by its days, midnight to midnight in UTC, as Outlook keeps one. Nobody is
 * invited to a time that has
 * passed; with nobody invited, such an event is put on record. A problem is
 * said on its field and cleared on the next send, so the form never locks.
 * Once booked, it says where the event went, and when it went nowhere but
 * here, that nobody was invited. While one is being booked, New event waits:
 * a dialog closed with Esc cannot book it a second time.
 *
 * Whoever booked an event made here, or an owner or admin, changes it (0048,
 * as agenda-ui.js reads it: agendaUi.canChange); an event from a connected
 * calendar is changed in that calendar. The dialog is filled in with the event
 * as the page drew it, on the clock of whoever edits it, and sends only what
 * they changed. A time still reading as the dialog filled it in is not sent:
 * read back, a time in the hour the clocks repeat in autumn names the other
 * instant, and would move the event. The change is made against the event's
 * updated_at, so one someone made meanwhile is refused, not overwritten. The
 * end moves with the start, keeping how long the event is. An all-day event
 * keeps its day. A refusal is said on the dialog (dialog-forms.js); once
 * saved, the keyboard goes back to Edit — or to the page's heading, when the
 * event moved out of the weeks loaded and its page is fetching it. Until the
 * page has the change, Edit waits. Tested in tests/event-edit.test.mjs.
 */
const eventEdit = (function () {
  'use strict';

  const { field, options, say, quiet, sending, closeDialog, stillSaving, refocus } = dialogForms;
  const text = value => String(value == null ? '' : value);
  const rowOf = event => (event && event.row) || event || {};
  const store = () => window.workspaceStore || null;
  const live = () => Boolean(store() && store().state && store().state.loaded);
  const eventById = id => (store() && typeof store().eventById === 'function' ? store().eventById(id) : null);
  /* A value as a CSS attribute selector quotes it. */
  const attr = value => text(value).replace(/["\\]/g, '\\$&');

  const TITLE_LIMIT = 200;
  /* What a datetime-local field holds: the day, and the time to the minute. */
  const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
  const EARLIEST_YEAR = 2000;
  const pad = n => String(n).padStart(2, '0');

  /* An instant as a datetime-local field holds it, on this clock — or '' for
     none, or one that cannot be read. */
  function localValue(instant) {
    if (instant == null || instant === '') return '';
    const date = new Date(instant);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /* A datetime-local field's value as an instant on this clock, or null. A day
     that does not exist, a time the clocks skip that day, or a year before
     2000 — one typed as 26 — is refused, not moved to another. */
  function instantOf(value) {
    const m = LOCAL.exec(text(value).trim());
    if (!m || Number(m[1]) < EARLIEST_YEAR) return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    return localValue(date) === m[0] ? date : null;
  }

  /* A stored time as an instant, or null for none, or one that cannot be read. */
  const storedTime = value => (value == null || Number.isNaN(Date.parse(value)) ? null : new Date(Date.parse(value)));
  const refused = (problem, name) => Object.freeze({ ok: false, problem, field: name, changes: Object.freeze({}) });
  const orNone = value => text(value).trim() || null;

  /* What an edit changes, checked the way calendar_events checks a row (0026:
     a title, and an end not before the start). Takes the row as the dialog
     showed it and the form's values — { title, startsAt, endsAt, location,
     detail } — and returns { ok, changes, problem, field }, `changes` holding
     only what differs from the row, as the update sends it. A time field still
     reading as the dialog filled it in is untouched: not sent, and not checked.
     A title longer than an edit allows is refused only once it is changed. An
     all-day event keeps its day and times: the dialog does not offer them. */
  function changes(row, values) {
    const r = row || {};
    const v = values || {};
    const out = {};
    const title = text(v.title).trim();
    if (!title) return refused('Give the event a title.', 'title');
    if (title !== text(r.title).trim()) {
      if (Array.from(title).length > TITLE_LIMIT) return refused(`A title is at most ${TITLE_LIMIT} characters.`, 'title');
      out.title = title;
    }
    if (r.all_day !== true) {
      const startText = text(v.startsAt).trim();
      const endText = text(v.endsAt).trim();
      const startMoved = startText !== localValue(r.starts_at);
      const endMoved = endText !== localValue(r.ends_at);
      if (startMoved || endMoved) {
        const start = startMoved ? instantOf(startText) : storedTime(r.starts_at);
        if (!start) return refused('Pick the day and time it starts.', 'startsAt');
        const end = endMoved ? (endText ? instantOf(endText) : null) : storedTime(r.ends_at);
        if (endMoved && endText && !end) return refused('Pick the day and time it ends, or leave it empty.', 'endsAt');
        if (end && end.getTime() <= start.getTime()) return refused('It has to end after it starts.', 'endsAt');
        if (startMoved) out.starts_at = start.toISOString();
        if (endMoved) out.ends_at = end ? end.toISOString() : null;
      }
    }
    const location = orNone(v.location);
    if (location !== orNone(r.location)) out.location = location;
    const detail = orNone(v.detail);
    if (detail !== orNone(r.detail)) out.detail = detail;
    return Object.freeze({ ok: true, changes: Object.freeze(out) });
  }

  /* ── A new event ────────────────────────────────────────────────────── */

  /* When New event starts it, on a day other than today, and for how long —
     the half hour Outlook gives an event booked with no end (graph-write.ts). */
  const NEW_START = '10:00';
  const NEW_MINUTES = 30;
  /* What a new event's write is saved under while it goes (dialog-forms.js). */
  const NEW_RECORD = 'event:new';
  /* What a date field holds; a day's length in UTC, which no clock change
     alters; and what the Client or person choice holds. */
  const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DAY_MS = 86400000;
  const LINK = /^(company|contact):(.+)$/;
  /* An address: a name, an @, and a domain of labels with no empty one. */
  const ADDRESS = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:.]+(\.[^\s@<>()[\]",;:.]+)+$/;
  /* What separates invitees; and one invitee — a name and <the address>, as
     Outlook copies it, the name holding commas or quoted text but no @ of its
     own, or else an address on its own. */
  const BETWEEN = /[\s,;]+/y;
  const ENTRY = /((?:"[^"]*"|[^<>@;\n"])*?)<([^<>\s]*)>|[^\s,;<>]+/y;
  /* How much of what is not an address the refusal repeats. */
  const QUOTE_LIMIT = 60;
  const quoted = word => {
    const chars = Array.from(word);
    return `“${chars.length > QUOTE_LIMIT ? `${chars.slice(0, QUOTE_LIMIT).join('')}…` : word}”`;
  };

  /* Who is invited: read one invitee after another from the start, so no
     address is passed over — separated by commas, semicolons, new lines, tabs
     or spaces — each once, whatever its case. What is not an address is
     refused, not dropped. */
  function invitees(value) {
    const typed = text(value);
    const found = [];
    let at = 0;
    while (at < typed.length) {
      BETWEEN.lastIndex = at;
      if (BETWEEN.test(typed)) { at = BETWEEN.lastIndex; continue; }
      ENTRY.lastIndex = at;
      const entry = ENTRY.exec(typed);
      const address = entry ? (entry[2] === undefined ? entry[0] : entry[2]) : '';
      if (!entry || !ADDRESS.test(address)) {
        return { problem: `${quoted(entry ? entry[0].trim() : typed.slice(at).split(/[\s,;]/)[0])} is not an email address.` };
      }
      found.push(address.toLowerCase());
      at = ENTRY.lastIndex;
    }
    return { list: [...new Set(found)] };
  }

  /* A date field's value as the midnight UTC that day begins, or null: a day
     that does not exist, or a year before 2000, is refused. */
  function dayOf(value) {
    const m = DAY_TEXT.exec(text(value).trim());
    if (!m || Number(m[1]) < EARLIEST_YEAR) return null;
    const midnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(midnight).toISOString().slice(0, 10) === m[0] ? midnight : null;
  }

  /* When a timed event starts and ends, from its date-and-time fields: a start
     that can be read, and an end, if any, after it. */
  function timesOf(v) {
    const start = instantOf(v.startsAt);
    if (!start) return { problem: 'Pick the day and time it starts.', field: 'startsAt' };
    const endText = text(v.endsAt).trim();
    const end = endText ? instantOf(endText) : null;
    if (endText && !end) return { problem: 'Pick the day and time it ends, or leave it empty.', field: 'endsAt' };
    if (end && end.getTime() <= start.getTime()) return { problem: 'It has to end after it starts.', field: 'endsAt' };
    return { start, end };
  }

  /* An all-day event's days, from its date fields: from the midnight it starts
     to the midnight after the day it ends, in UTC — as Outlook keeps one and
     the agenda reads one (agenda-model.js span) — one day when no end is given. */
  function daysOf(v) {
    const first = dayOf(v.startDay);
    if (first === null) return { problem: 'Pick the day it is on.', field: 'startDay' };
    const endText = text(v.endDay).trim();
    const last = endText ? dayOf(endText) : first;
    if (last === null) return { problem: 'Pick the day it ends, or leave it empty.', field: 'endDay' };
    if (last < first) return { problem: 'It has to end on or after the day it starts.', field: 'endDay' };
    return { start: new Date(first), end: new Date(last + DAY_MS), lastDay: new Date(last).toISOString().slice(0, 10) };
  }

  /* The client or person picked, among those the dialog offered, as the ids
     create-calendar-event files an event under; null for one not offered. */
  function linkOf(value, links) {
    const m = LINK.exec(value);
    if (!m) return null;
    const list = (links || {})[m[1] === 'company' ? 'companies' : 'contacts'];
    const found = (Array.isArray(list) ? list : []).find(x => x && text(x.id) === m[2]);
    if (!found) return null;
    if (m[1] === 'company') return { companyId: text(found.id), contactId: null };
    /* A person is filed with their own company, so its page lists the event. */
    const own = found.row && found.row.company && found.row.company.id;
    return { companyId: own ? text(own) : null, contactId: text(found.id) };
  }

  /* A new event, checked as calendar_events checks one (0026) and as
     create-calendar-event books one. Takes the form's values — { title,
     allDay, startsAt, endsAt, startDay, endDay, location, detail, attendees,
     projectId, link } — the projects the dialog offered, the time it is sent,
     and the companies and people it offered ({ companies, contacts }), and
     returns { ok, event, problem, field }: `event` as
     workspaceActions.createEvent takes it. A client or a person makes it client
     work, and so does a client's project, as a project's own meeting is
     (projects-ui.js); a client picked is filed over the project's. What the
     dialog did not offer is refused. An event over by now — ending then, or
     half an hour after it starts — invites nobody: Outlook would send the
     invitations all the same. */
  function newEvent(values, offered, now, links) {
    const v = values || {};
    const title = text(v.title).trim();
    if (!title) return refused('Give the event a title.', 'title');
    if (Array.from(title).length > TITLE_LIMIT) return refused(`A title is at most ${TITLE_LIMIT} characters.`, 'title');
    const allDay = v.allDay === 'on' || v.allDay === true;
    const when = allDay ? daysOf(v) : timesOf(v);
    if (when.problem) return refused(when.problem, when.field);
    const { start, end } = when;
    const invited = invitees(v.attendees);
    if (invited.problem) return refused(invited.problem, 'attendees');
    const nowMs = now == null ? Date.now() : new Date(now).getTime();
    /* An all-day event is over once its last day is behind the booker's own
       date — not the UTC one, which turns hours early or late away from
       Greenwich. */
    const over = allDay ? when.lastDay < localValue(nowMs).slice(0, 10)
      : (end || new Date(start.getTime() + NEW_MINUTES * 60000)).getTime() <= nowMs;
    if (invited.list.length && over) {
      return refused('That time has passed, so nobody can be invited to it: pick a later time, or empty Invite to put it on record.', allDay ? 'startDay' : 'startsAt');
    }
    const chosen = text(v.projectId).trim();
    const project = chosen ? (offered || []).find(p => text(p.uuid) === chosen) : null;
    if (chosen && !project) return refused('Pick a project from the list.', 'projectId');
    const linkText = text(v.link).trim();
    const linked = linkText ? linkOf(linkText, links) : null;
    if (linkText && !linked) return refused('Pick a client or person from the list.', 'link');
    const companyId = (linked && linked.companyId) || (project && project.companyId) || null;
    const contactId = (linked && linked.contactId) || null;
    return Object.freeze({
      ok: true,
      event: Object.freeze({
        title, allDay, startsAt: start.toISOString(), endsAt: end ? end.toISOString() : null,
        location: orNone(v.location), detail: orNone(v.detail), attendees: Object.freeze(invited.list),
        projectId: project ? project.uuid : null, companyId, contactId, kind: companyId || contactId ? 'client' : 'internal'
      })
    });
  }

  /* Where a new event went. One saved in the workspace alone invited nobody:
     invitations go out from the calendar it is booked in. */
  function booked(outcome, invited) {
    if (outcome && outcome.calendar) return `Added to ${outcome.calendar}.`;
    const where = (outcome && outcome.why) || 'Saved in the workspace: no calendar is connected yet.';
    return invited ? `${where} No invitations went out: they are sent from a connected calendar.` : where;
  }

  /* A new event in a calendar the agenda is hiding (agenda-ui.js) would seem
     not to have been booked: the toast says where it is. */
  function hiddenFrom(kind) {
    const name = window.agendaUi && typeof agendaUi.hiddenCalendar === 'function' ? agendaUi.hiddenCalendar(kind) : null;
    return name ? ` It is in ${name}, which the agenda is hiding.` : '';
  }

  /* The projects an event can be for: the active ones the page has (app.js
     keeps them; projects-model.js says which are active). */
  function activeProjects() {
    const list = typeof projects === 'undefined' || !Array.isArray(projects) ? [] : projects;
    const active = typeof projectsModel !== 'undefined' && typeof projectsModel.isActive === 'function' ? projectsModel.isActive : () => true;
    return list.filter(p => p && p.uuid && active(p));
  }

  /* When New event starts: on the day the agenda offers first — the week on
     screen on the Agenda, this week anywhere else (agenda-ui.js dayOptions) —
     at ten; on today, when a project's meeting would (projects-model.js
     suggestedStart: the next whole hour of the working day, else ten the next
     morning). */
  function firstStart(now) {
    const onAgenda = typeof page !== 'undefined' && page === 'agenda';
    const days = window.agendaUi && typeof agendaUi.dayOptions === 'function' ? agendaUi.dayOptions({ onAgenda }) : [];
    const chosen = days.find(d => d.selected) || days[0];
    const today = localValue(now).slice(0, 10);
    const day = chosen ? text(chosen.key) : today;
    if (day === today && typeof projectsModel !== 'undefined' && typeof projectsModel.suggestedStart === 'function') {
      return new Date(projectsModel.suggestedStart(now).getTime());
    }
    return instantOf(`${day}T${NEW_START}`);
  }

  /* The companies and people an event can be for: those the CRM has loaded
     (store.js companies, app.js contacts). */
  function crmLinks() {
    const s = store();
    const companies = s && s.state && Array.isArray(s.state.companies) ? s.state.companies : [];
    const people = typeof contacts === 'undefined' || !Array.isArray(contacts) ? [] : contacts;
    return { companies: companies.filter(c => c && c.id), contacts: people.filter(c => c && c.id) };
  }
  /* A person by name, with their company when they have one ('—' is none) and
     their address, so two people of the same name can be told apart. */
  const personLabel = c => [text(c.name), c.company && c.company !== '—' ? text(c.company) : '', text(c.email)].filter(Boolean).join(' · ');

  function openNew() {
    const start = firstStart(new Date());
    const offered = activeProjects();
    const links = crmLinks();
    const project = offered.length
      ? field('Project', `<select name="projectId"><option value="">No project</option>${options(offered.map(p => ({ value: text(p.uuid), label: text(p.name) })), null)}</select>`)
      : '';
    const link = links.companies.length || links.contacts.length
      ? field('Client or person', '<select name="link"><option value="">No one</option>'
        + (links.companies.length ? `<optgroup label="Companies">${options(links.companies.map(c => ({ value: `company:${text(c.id)}`, label: text(c.name) })), null)}</optgroup>` : '')
        + (links.contacts.length ? `<optgroup label="People">${options(links.contacts.map(c => ({ value: `contact:${text(c.id)}`, label: personLabel(c) })), null)}</optgroup>` : '')
        + '</select>')
      : '';
    const note = project || link
      ? '<p class="form-note">An event for a project, a client or a person goes in the studio calendar, where the team sees it. Any other goes in your own calendar, or the studio’s when you have none connected.</p>'
      : '';
    showModal('AGENDA · EVENT', '<h2>New event</h2>'
      + dialogForms.form('event-new-form',
        field('Title', `<input name="title" required maxlength="${TITLE_LIMIT}" autofocus>`)
        + '<label class="check-row"><input type="checkbox" name="allDay"> All day</label>'
        + `<div class="form-pair" data-timed>${field('Starts', `<input type="datetime-local" name="startsAt" required value="${esc(localValue(start))}">`)}`
        + `${field('Ends', `<input type="datetime-local" name="endsAt" value="${esc(start ? localValue(start.getTime() + NEW_MINUTES * 60000) : '')}">`)}</div>`
        + `<div class="form-pair" data-all-day hidden>${field('Starts on', `<input type="date" name="startDay" required value="${esc(localValue(start).slice(0, 10))}">`)}`
        + `${field('Ends on', '<input type="date" name="endDay" value="">')}</div>`
        + field('Where', '<input name="location">')
        + field('Invite', '<input name="attendees" type="text" inputmode="email" autocomplete="off" placeholder="name@company.com, …">')
        + project
        + link
        + note
        + field('Details', '<textarea name="detail"></textarea>'),
        'Add event'));
    const form = document.getElementById('event-new-form');
    const moveStart = keepLength(form);
    allDayToggle(form, moveStart);
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const checked = newEvent(Object.fromEntries(new FormData(form).entries()), offered, new Date(), links);
      if (!checked.ok) { say(form, checked.problem, checked.field); return; }
      sending(form, () => workspaceActions.createEvent(checked.event), outcome => {
        toast(booked(outcome, checked.event.attendees.length > 0) + hiddenFrom(checked.event.kind));
        refocus([{ selector: '#main [data-create="agenda"]' }, { selector: '#main h1', heading: true }]);
      }, { record: NEW_RECORD });
    });
  }

  /* app.js's createForm makes everything else. */
  if (typeof createForm === 'function') {
    const before = createForm;
    createForm = function (kind) {
      if (kind !== 'agenda') return before(kind);
      if (!live()) { toast('Not yet: the workspace is still loading.'); return undefined; }
      if (stillSaving(NEW_RECORD)) { toast('The last new event is still being booked. Try again in a moment.'); return undefined; }
      openNew();
      return undefined;
    };
  }

  /* ── Changing an event ──────────────────────────────────────────────── */

  /* What an event's change is saved under until the page has it
     (dialog-forms.js): the same event whatever case its address is in. */
  const recordOf = event => `event:${text(event && event.id).toLowerCase()}`;
  /* The parts of the store the event comes back in (agenda-ui.js partsOf). */
  const partsOf = event => (window.agendaUi && typeof agendaUi.partsOf === 'function' ? agendaUi.partsOf(event) : ['events']);

  /* Moving the start moves the end with it, keeping how long the event is —
     from wherever the end was when the start last moved. Answers how to move
     the start from here too, as All day does, so the end still follows. */
  function keepLength(form) {
    const start = form.querySelector('[name="startsAt"]');
    const end = form.querySelector('[name="endsAt"]');
    if (!start || !end || !start.addEventListener) return () => {};
    let from = instantOf(start.value);
    const moved = () => {
      const to = instantOf(start.value);
      const ends = instantOf(end.value);
      if (from && to && ends) end.value = localValue(ends.getTime() + (to.getTime() - from.getTime()));
      if (to) from = to;
    };
    start.addEventListener('change', moved);
    return value => {
      start.value = value;
      moved();
    };
  }

  /* All day puts the times away and asks for the days: from the day the start
     is on to the day the end is on, left empty for one day. Turned off, the
     times come back at the time they had, on the day picked. */
  function allDayToggle(form, moveStart) {
    const box = form.querySelector('[name="allDay"]');
    const timed = form.querySelector('[data-timed]');
    const days = form.querySelector('[data-all-day]');
    const start = form.querySelector('[name="startsAt"]');
    const end = form.querySelector('[name="endsAt"]');
    const startDay = form.querySelector('[name="startDay"]');
    const endDay = form.querySelector('[name="endDay"]');
    if (!box || !timed || !days || !start || !end || !startDay || !endDay || !box.addEventListener) return;
    /* The times as All day was last turned off: ticked again with them
       unmoved, the days picked stay as they were. */
    let carried = null;
    box.addEventListener('change', () => {
      const on = Boolean(box.checked);
      timed.hidden = on;
      days.hidden = !on;
      if (on) {
        if (carried && carried.start === start.value && carried.end === end.value) return;
        const startDate = text(start.value).slice(0, 10);
        if (DAY_TEXT.test(startDate)) startDay.value = startDate;
        /* The end is exclusive: one at midnight ends on the day before. */
        const ends = instantOf(end.value);
        const endDate = ends ? localValue(ends.getTime() - 60000).slice(0, 10) : '';
        endDay.value = DAY_TEXT.test(endDate) && endDate > text(startDay.value) ? endDate : '';
      } else {
        if (DAY_TEXT.test(text(startDay.value)) && LOCAL.test(text(start.value))) {
          moveStart(`${startDay.value}${text(start.value).slice(10)}`);
        }
        carried = { start: start.value, end: end.value };
      }
    });
  }

  function openEdit(event) {
    const row = rowOf(event);
    const timed = row.all_day !== true;
    const times = timed
      ? `<div class="form-pair">${field('Starts', `<input type="datetime-local" name="startsAt" required value="${esc(localValue(row.starts_at))}">`)}`
        + `${field('Ends', `<input type="datetime-local" name="endsAt" value="${esc(localValue(row.ends_at))}">`)}</div>`
      : '';
    showModal('AGENDA · EVENT', `<h2>Edit ${esc(text(row.title || event.title) || 'event')}</h2>`
      + (timed ? '' : '<p class="form-note">It is an all-day event, so its day stays as it is here.</p>')
      + dialogForms.form('event-edit-form',
        field('Title', `<input name="title" required maxlength="${TITLE_LIMIT}" autofocus value="${esc(row.title)}">`)
        + times
        + field('Where', `<input name="location" value="${esc(row.location || '')}">`)
        + field('Details', `<textarea name="detail">${esc(row.detail || '')}</textarea>`),
        'Save event'));
    const form = document.getElementById('event-edit-form');
    keepLength(form);
    form.addEventListener('submit', e => {
      e.preventDefault();
      quiet(form);
      const checked = changes(row, Object.fromEntries(new FormData(form).entries()));
      if (!checked.ok) { say(form, checked.problem, checked.field); return; }
      if (!Object.keys(checked.changes).length) {
        closeDialog(form);
        toast('Nothing changed.');
        return;
      }
      sending(form, () => workspaceActions.updateEvent(text(row.id || event.id), checked.changes, row.updated_at || null), () => {
        toast('Event saved.');
        refocus([{ selector: `#main [data-agenda-edit="${attr(event.id)}"]` }, { selector: '#main h1', heading: true }]);
      }, { record: recordOf(event), part: partsOf(event) });
    });
  }

  document.addEventListener('click', e => {
    const target = e.target.closest && e.target.closest('[data-agenda-edit]');
    if (!target) return;
    e.preventDefault();
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    const event = eventById(target.dataset.agendaEdit);
    if (!event) { toast('That event is not loaded any more. Reload the page.'); return; }
    if (stillSaving(recordOf(event))) { toast('The last change to that event is still on its way. Try again in a moment.'); return; }
    if (!(window.agendaUi && typeof agendaUi.canChange === 'function' && agendaUi.canChange(event))) {
      toast('This event cannot be changed here.');
      return;
    }
    openEdit(event);
  });

  return Object.freeze({ changes, newEvent, localValue, instantOf, recordOf });
})();
