/* event-invite.js — the four things an event's page could not say until 0068,
 * and the one thing it could not do.
 *
 * SAY: that a meeting is one of a series and how often it comes round; whether
 * the calendar will nudge anyone beforehand and how long before; which time
 * zone it was booked in, honestly; and how the calendar's owner answered the
 * invitation. DO: answer it — Accept, Maybe or Decline, for this one date or
 * for the whole series, reaching Outlook first through respond-calendar-event
 * and only then the row here, the same order every other calendar write in
 * this workspace keeps (0057).
 *
 * ITS OWN FILE, not more of agenda-ui.js, which was already at the size this
 * project stops adding to. agenda-ui.js calls in for the property rows and the
 * panel; the reply button's own click handler lives here, the way event-edit.js
 * owns [data-agenda-edit]. Loaded after agenda-ui.js in index.html, so
 * window.agendaUi is there to be asked who may act on a calendar — and every
 * call is guarded anyway, so a page without this file simply shows the event as
 * it did before.
 *
 * HONESTLY, about zones, is the word that carries weight here. Graph sends the
 * organiser's zone as a WINDOWS name — "W. Europe Standard Time" — which
 * Intl.DateTimeFormat throws a RangeError on. 0068 stores an IANA name beside
 * it when _shared/calendar-recurrence.ts recognised the Windows one, and NULL
 * when it did not. So this file has three things to say, and says whichever is
 * true rather than the most impressive one:
 *
 *   - the zone is yours          → name it, and stop.
 *   - the zone is not yours, and
 *     we have an IANA name       → "10:00 there, 09:00 here" — a real
 *                                  conversion, computed in both zones.
 *   - all we have is a Windows
 *     name nobody mapped         → print it, and say plainly that the times on
 *                                  this page are in the reader's own zone.
 *
 * The third is the point. Guessing a zone puts every time on the page an hour
 * out, which is the bug _shared/graph-message.ts already refuses to risk for a
 * start time. Tested in tests/event-invite.test.mjs, and on the page in
 * tests/agenda-ui.test.mjs.
 */
const eventInvite = (function () {
  'use strict';

  const text = value => String(value == null ? '' : value);
  const trimmed = value => (typeof value === 'string' ? value.trim() : '');
  const rowOf = event => (event && event.row) || event || {};
  const store = () => window.workspaceStore || null;
  const live = () => Boolean(store() && store().state && store().state.loaded);
  const eventById = id => (store() && typeof store().eventById === 'function' ? store().eventById(id) : null);
  /* A value as a CSS attribute selector quotes it — event-edit.js's own attr(). */
  const attr = value => text(value).replace(/["\\]/g, '\\$&');

  /* Graph's own six words for an answer (0068 calendar_events.response_status),
     and what each reads as on the page. 'none' is an event nobody was invited
     to and 'organizer' is the person who called it — neither is an answer. */
  const REPLY_WORDS = new Map([
    ['accepted', 'You accepted'],
    ['tentativelyAccepted', 'You said maybe'],
    ['declined', 'You declined'],
    ['notResponded', 'You have not replied yet']
  ]);

  /* The three a person may send, as the buttons offer them. The value is
     Graph's spelling, which respond-calendar-event checks again and
     calendar_events_response_status_known (0068) checks a third time — one
     spelling all the way down rather than a translation per layer. */
  const ANSWERS = [
    { value: 'accepted', label: 'Accept', past: 'Accepted' },
    { value: 'tentativelyAccepted', label: 'Maybe', past: 'Marked as maybe' },
    { value: 'declined', label: 'Decline', past: 'Declined' }
  ];

  const answerOf = value => ANSWERS.find(a => a.value === value) || null;

  /* ── What an event's page says ─────────────────────────────────────── */

  /* Part of a series at all: everything but Graph's 'singleInstance', which is
     also what a hand-made event and every row from before 0068 reads as. */
  const repeats = row => {
    const type = trimmed(rowOf(row).recurrence_type);
    return Boolean(type) && type !== 'singleInstance';
  };

  /* How often it comes round, in the words the sync read off the series master
     — or just "Repeats" when the master could not be read (0068: the row still
     knows it is one of a series even when the pattern's words are missing). */
  function repeatNote(row) {
    if (!repeats(row)) return null;
    return trimmed(rowOf(row).recurrence_summary) || 'Repeats';
  }

  /* How long before the start the calendar nudges its owner. Zero minutes is a
     real setting — "at the time of the event" — and is said as one, never
     folded into "no reminder" (0068 keeps the same distinction in the column).
     Rounded into hours and days where that reads better, and only where it is
     exact: 90 minutes stays 90 minutes rather than becoming a wrong "1 hour". */
  function reminderNote(row) {
    const r = rowOf(row);
    if (r.reminder_on !== true) return null;
    const minutes = r.reminder_minutes;
    if (!Number.isInteger(minutes) || minutes < 0) return 'On';
    if (minutes === 0) return 'When it starts';
    if (minutes % 1440 === 0) {
      const days = minutes / 1440;
      return days + (days === 1 ? ' day before' : ' days before');
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours + (hours === 1 ? ' hour before' : ' hours before');
    }
    return minutes + (minutes === 1 ? ' minute before' : ' minutes before');
  }

  /* This browser's own IANA zone, or '' when it will not say — an old browser,
     or one deliberately lying about where it is. Everything below treats '' as
     "cannot compare", which falls back to naming the event's zone and stopping. */
  function myZone() {
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      return trimmed(resolved && resolved.timeZone);
    } catch (err) {
      return '';
    }
  }

  /* An instant as a 24-hour clock time in one IANA zone, or null. The try/catch
     is the whole reason time_zone_iana exists as a separate column: handed a
     Windows name, Intl.DateTimeFormat THROWS a RangeError, and an event page
     that throws shows nothing at all. */
  function clockIn(instant, zone) {
    if (!zone) return null;
    const when = new Date(instant);
    if (isNaN(when.getTime())) return null;
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false
      }).format(when);
    } catch (err) {
      return null;
    }
  }

  /* An IANA name has no spaces; a Windows one always does ("W. Europe Standard
     Time"). The same shape _shared/calendar-recurrence.ts tests before storing
     one and calendar_events_time_zone_iana_shape (0068) re-checks — repeated
     here because a row synced BEFORE 0068 has a null time_zone_iana and may
     well have an IANA name sitting in time_zone already, which is worth using
     rather than apologising for until the next sync fills the column in. */
  const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+._-]+){0,2}$/;

  /* What "Booked in" says — see this file's header for why there are three
     answers and not one. null when the event carries no zone at all, which is
     every hand-made event. */
  function zoneNote(row) {
    const r = rowOf(row);
    const raw = trimmed(r.time_zone);
    const iana = trimmed(r.time_zone_iana) || (IANA_SHAPE.test(raw) ? raw : '');
    if (!raw && !iana) return null;
    /* An all-day event has no clock time to compare, so naming the zone is all
       there is to say about it truthfully. */
    if (!iana) return raw + ' · times here are in your own time zone';
    if (r.all_day === true) return raw || iana;
    const mine = myZone();
    if (!mine || mine === iana) return iana;
    const there = clockIn(r.starts_at, iana);
    const here = clockIn(r.starts_at, mine);
    if (!there || !here) return iana;
    if (there === here) return iana + ' · the same clock time as yours';
    return iana + ' · ' + there + ' there, ' + here + ' here';
  }

  /* How the calendar's owner answered — whose answer that is follows from
     whose calendar the row was synced from (0068's own column comment). */
  const replyNote = row => REPLY_WORDS.get(trimmed(rowOf(row).response_status)) || null;

  /* The rows this file adds to an event's page, in the order they read best:
     how often, whether you will be nudged, where in the world it was booked,
     and how you answered. Each left out entirely when it has nothing to say,
     rather than printed as "None" — a hand-made event would otherwise gain
     four empty properties it can never fill. */
  /* esc() bare, never `window.esc ? esc(…) : …`: app.js declares it as a
     top-level `const`, which in a classic script is a global LEXICAL binding
     and is not a property of window at all — so a guard written that way
     would read as false in a real browser and quietly stop escaping, while
     passing every test that put esc on the sandbox's global object. Every
     other file here calls it bare for the same reason. */
  function properties(row) {
    const rows = [];
    const repeat = repeatNote(row);
    if (repeat) rows.push(['Repeats', esc(repeat)]);
    const reminder = reminderNote(row);
    if (reminder) rows.push(['Reminder', esc(reminder)]);
    const zone = zoneNote(row);
    if (zone) rows.push(['Booked in', esc(zone)]);
    const reply = replyNote(row);
    if (reply) rows.push(['Your reply', esc(reply)]);
    return rows;
  }

  /* ── Answering it ──────────────────────────────────────────────────── */

  /* Whether this session may answer this event, checked here only to avoid
     offering a button that respond-calendar-event would refuse — it checks all
     of this again, against the calendar's CURRENT state, which is the check
     that counts. An event must be:
       - from a connected calendar (a hand-made one invited nobody);
       - not cancelled (nothing left to answer);
       - one the calendar owner did not organise (is_organizer);
       - carrying a real invitation — Graph's 'none' means nobody was invited;
       - in a calendar this session may act on — agendaUi.canChange, which for
         a synced event is exactly the backend's own mayActOn rule.
     A row that never loaded these columns answers false rather than guessing. */
  function canReply(event) {
    const r = rowOf(event);
    if (!r.connection_id || r.status === 'cancelled') return false;
    if (r.is_organizer !== false) return false;
    if (!REPLY_WORDS.has(trimmed(r.response_status))) return false;
    return Boolean(window.agendaUi && typeof agendaUi.canChange === 'function' && agendaUi.canChange(event));
  }

  /* The three buttons, with whichever answer is already given shown as the one
     in effect rather than hidden: changing your mind is a normal thing to do,
     and a person who accepted last week still needs to see that they did. */
  function panel(event) {
    if (!canReply(event)) return '';
    const r = rowOf(event);
    const given = trimmed(r.response_status);
    const id = esc(text(event && event.id));
    const buttons = ANSWERS.map(a => {
      const now = a.value === given;
      return `<button type="button" class="btn reply-btn${now ? ' reply-now' : ''}"`
        + ` data-agenda-reply="${id}" data-agenda-answer="${a.value}" aria-pressed="${now}">${a.label}</button>`;
    }).join('');
    const series = repeats(r)
      ? '<p class="quiet-text">This is one of a series. You can answer for this date alone or for every one.</p>'
      : '';
    return '<section class="panel content-panel invite-panel"><h2>Your reply</h2>'
      + `<p class="body-copy">${esc(replyNote(r) || 'You have not replied yet')}.</p>`
      + series
      + `<div class="invite-actions">${buttons}</div></section>`;
  }

  /* Saved under the same key an edit and a removal are (agenda-ui.js,
     event-edit.js): the three must not overtake each other on one event. */
  const recordOf = event => `event:${text(event && event.id).toLowerCase()}`;
  const partsOf = event => (window.agendaUi && typeof agendaUi.partsOf === 'function' ? agendaUi.partsOf(event) : ['events']);

  /* Answering asks first, on dialog-forms.js, the way removing already does —
     not because a reply is dangerous, but because there are two real choices
     to make about it that a bare button cannot offer: whether this date or the
     whole series, and what to say to the organiser while answering. */
  function openReply(event, answer) {
    const r = rowOf(event);
    const title = text(r.title || event.title) || 'this meeting';
    const scope = repeats(r)
      ? dialogForms.field('Answer for', '<select name="scope">'
        + '<option value="occurrence">This date only</option>'
        + '<option value="series">Every one in the series</option></select>')
      : '';
    showModal('AGENDA · REPLY', `<h2>${answer.label} ${esc(title)}?</h2>`
      + '<p class="form-note">The organiser is told, and the calendar it came from is updated.</p>'
      + dialogForms.form('agenda-reply-form',
        scope + dialogForms.field('A note for the organiser (optional)', '<textarea name="comment" maxlength="1000"></textarea>'),
        `Send “${answer.label}”`));
    const form = document.getElementById('agenda-reply-form');
    form.addEventListener('submit', submitted => {
      submitted.preventDefault();
      dialogForms.quiet(form);
      const data = new FormData(form);
      const chosen = text(data.get('scope')) === 'series' ? 'series' : 'occurrence';
      const comment = text(data.get('comment')).trim();
      dialogForms.sending(form,
        () => workspaceActions.respondToEvent(text(event.id), answer.value, { scope: chosen, comment: comment }),
        () => {
          /* A decline usually takes the meeting out of the calendar in Outlook
             — its own behaviour, not ours — and the next sync then retires the
             row here too. Said plainly, so a meeting that disappears a quarter
             of an hour later is not mistaken for something going wrong. */
          toast(answer.value === 'declined'
            ? `${answer.past}. It leaves the calendar it came from.`
            : `${answer.past}. The organiser has been told.`);
          dialogForms.refocus([
            { selector: `#main [data-agenda-reply="${attr(event.id)}"]` },
            { selector: '#main h1', heading: true }
          ]);
        },
        { record: recordOf(event), part: partsOf(event), only: partsOf(event) });
    });
  }

  document.addEventListener('click', e => {
    const target = e.target.closest && e.target.closest('[data-agenda-reply]');
    if (!target) return;
    e.preventDefault();
    if (!live()) { toast('Not yet: the workspace is still loading.'); return; }
    const answer = answerOf(target.dataset.agendaAnswer);
    if (!answer) return;
    const event = eventById(target.dataset.agendaReply);
    if (!event) { toast('That event is not loaded any more. Reload the page.'); return; }
    if (dialogForms.stillSaving(recordOf(event))) {
      toast('The last change to that event is still on its way. Try again in a moment.');
      return;
    }
    if (!canReply(event)) { toast('This invitation cannot be answered here.'); return; }
    openReply(event, answer);
  });

  return Object.freeze({
    repeats, repeatNote, reminderNote, zoneNote, replyNote, properties, canReply, panel, recordOf
  });
})();
window.eventInvite = eventInvite;
