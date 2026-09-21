/* queries.js — one function per workspace view.
 *
 * Each returns objects shaped like the sample arrays in app.js / workspace.js,
 * so swapping a view over is `const tickets = await workspaceData.tickets()`
 * and nothing else. The raw database row travels along under `row` whenever a
 * caller needs a field the view shape does not carry.
 *
 * Every function assumes a live session — await workspaceSession.ready() first.
 * Reads are filtered by RLS, so a query that returns [] for an employee and
 * rows for an owner is the database working, not a bug.
 */
(function () {
  'use strict';

  function sb() { return window.workspaceSession.client; }

  /* Throw rather than return half a screen: a silent [] reads as "no tickets"
     when it actually means "the query failed", and that is the kind of wrong
     that goes unnoticed for a week. */
  function unwrap(res, what) {
    if (res.error) throw new Error('Could not load ' + what + ': ' + res.error.message);
    return res.data || [];
  }

  /* Every row a list has, a page at a time. The API hands back at most PAGE
     rows per request (Supabase's max rows) and cuts a list off there without a
     word, so a full page asks for the next. `ask(from, to)` builds one page's
     request, in an order that ends on the id, so pages do not overlap. A row
     added ahead of the next page while the list is read pushes the last one
     into it: a row met twice is kept once. These are pages by place, not a
     snapshot: a row removed ahead of the next page moves one past it unread
     until the next load, and a project whose Max rows is set below PAGE would
     be cut off at its first page. */
  var PAGE = 1000;
  async function everyRow(ask, what) {
    var rows = [];
    var seen = Object.create(null);
    var fresh = function (row) {
      var id = row && row.id;
      if (id == null) return true;
      if (seen[id]) return false;
      seen[id] = true;
      return true;
    };
    for (var from = 0; ; from += PAGE) {
      var page = unwrap(await ask(from, from + PAGE - 1), what);
      rows = rows.concat(page.filter(fresh));
      if (page.length < PAGE) return rows;
    }
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/)
      .filter(function (w) { return /^[\p{L}]/u.test(w); });
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* Dates the way a person reads them. Local, never toISOString() — that
     converts to UTC and shifts the day for anyone west of it. */
  function shortDate(value) {
    if (!value) return '';
    var d = new Date(value);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return 'Today';
    var yest = new Date(today); yest.setDate(yest.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function clockTime(value) {
    if (!value) return '';
    var d = new Date(value);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* The day a meeting is on, as a page says it: an all-day meeting stored at
     midnight UTC is that date wherever the viewer is (agenda-model.js reads it
     so), any other the viewer's own day. Today and yesterday by name, but a day
     in another year says which year — never "Yesterday" with a year after it. */
  function meetingDay(value, allDay) {
    var d = new Date(value);
    if (!value || isNaN(d.getTime())) return '';
    var utc = Boolean(allDay) && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
    var year = utc ? d.getUTCFullYear() : d.getFullYear();
    var month = utc ? d.getUTCMonth() : d.getMonth();
    var date = utc ? d.getUTCDate() : d.getDate();
    var today = new Date();
    if (year !== today.getFullYear()) return MONTHS[month] + ' ' + date + ', ' + year;
    var same = function (other) { return other.getFullYear() === year && other.getMonth() === month && other.getDate() === date; };
    if (same(today)) return 'Today';
    var yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (same(yesterday)) return 'Yesterday';
    return MONTHS[month] + ' ' + date;
  }

  /* A moment as a filter compares it, or null when it is not one: only a
     timestamp goes into a filter, never text that could add a condition. */
  function isoTime(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /* An id as an or() filter takes it: a uuid, and nothing else — any other
     text could add a condition of its own. */
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function uuids(list, most) {
    return (Array.isArray(list) ? list : []).filter(function (id) { return UUID.test(String(id)); }).slice(0, most);
  }

  /* A code Intl can format as a currency: three letters, any case. A blank is
     USD, the database's default; anything else — "US$", a typo — is null. */
  function currencyCode(value) {
    var code = String(value == null ? '' : value).trim().toUpperCase();
    if (!code) return 'USD';
    return /^[A-Z]{3}$/.test(code) ? code : null;
  }

  /* An amount in its currency. A code Intl cannot format used to throw a
     RangeError out of the page being drawn, and the Overview and Finance
     stayed blank until the record was fixed; it is written beside the number
     instead. { compact: true } for the chart's axis: "$62K". */
  function money(amount, currency, options) {
    if (amount === null || amount === undefined) return null;
    var style = { maximumFractionDigits: 0 };
    if (options && options.compact) style.notation = 'compact';
    var code = currencyCode(currency);
    if (!code) return new Intl.NumberFormat('en-US', style).format(Number(amount)) + ' ' + String(currency).trim();
    return new Intl.NumberFormat('en-US', Object.assign({ style: 'currency', currency: code }, style)).format(Number(amount));
  }

  /* Sentence case, not Title Case. The views match these strings exactly —
     the project board filters on 'In progress' and the pill colour map is
     keyed by 'In review', 'High', 'Paid'. 'In Progress' matches none of them,
     and the failure is silent: the board renders its columns and no cards. */
  function label(s) {
    var words = String(s || '').replace(/_/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
  }

  /* The viewer's IANA time zone: the Overview's "today" and "this month" are
     theirs, not UTC's (0041). */
  function timeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (err) {
      return 'UTC';
    }
  }

  /* The RPCs that turned out not to take p_tz: asked without it from then on,
     rather than twice on every refresh. */
  var withoutZone = {};

  /* An RPC that counts days and months, asked in the viewer's time zone. A
     database from before 0041 has no p_tz and answers PGRST202 ("no such
     function"); it is asked again without it, so the workspace and the
     database can go live in either order — and the console says, once, that
     its days are UTC's. */
  async function rpcInZone(name, args, what) {
    var fail = function (error) { return new Error('Could not load ' + what + ': ' + error.message); };
    if (withoutZone[name]) {
      var plainOnly = await sb().rpc(name, Object.assign({}, args));
      if (plainOnly.error) throw fail(plainOnly.error);
      return plainOnly.data;
    }
    var zoned = await sb().rpc(name, Object.assign({}, args, { p_tz: timeZone() }));
    if (!zoned.error) return zoned.data;
    if (zoned.error.code !== 'PGRST202') throw fail(zoned.error);
    var plain = await sb().rpc(name, Object.assign({}, args));
    /* Missing both ways, the first answer is the one that names what is missing. */
    if (plain.error) throw fail(plain.error.code === 'PGRST202' ? zoned.error : plain.error);
    withoutZone[name] = true;
    console.warn('[workspace] ' + name + ' does not take a time zone yet (migration 0041), so it counts UTC days.');
    return plain.data;
  }

  /* A task with what its page shows and its rules read (tasks-model.js): its
     details, who made it, and when it was made and finished (0005). */
  var TASK_COLUMNS = 'id, project_id, title, details, status, priority, due_date, assignee_id, created_by, created_at, completed_at, ' +
    'assignee:employees (full_name)';

  /* updated_at: what a change made here is made against, so one someone made
     meanwhile is refused rather than overwritten (actions.updateEvent). */
  var EVENT_COLUMNS = 'id, title, detail, location, starts_at, ends_at, all_day, kind, status, project_id, company_id, contact_id, updated_at';
  /* What a list of events brings for each one's page: who may change it
     (connection_id, created_by), and — for a synced one (0057) — who
     organised it, its video-call link and the zone it was booked in.
     Who is invited (attendees, 0026: [{name, email, response}]) is the
     largest column an event has and only its page reads it, so it comes
     with one event asked for by its id (event, eventInvitees) rather than
     with every week, project meeting and past meeting, which are loaded
     again every two minutes.
     0068's eight are all small scalars, and they are in the LIST for a
     reason: recurrence_type marks a series in the week, the day, the
     schedule and the month, and the rest are read by an event's page, which
     is very often drawn from a row a list already brought (agenda-ui.js
     eventById). Following attendees' lead and fetching them separately would
     mean a second round trip to print four words. The bar attendees clears —
     "the largest column an event has" — is not one a boolean and an integer
     come near. */
  var EVENT_LIST_COLUMNS = EVENT_COLUMNS + ', connection_id, calendar_id, created_by, organizer_name, organizer_email, meeting_url, time_zone' +
    ', recurrence_type, series_master_id, recurrence_summary, reminder_on, reminder_minutes, time_zone_iana, response_status, is_organizer';
  var EVENT_PAGE_COLUMNS = EVENT_LIST_COLUMNS + ', attendees';

  function agendaEvent(r) {
    return {
      id: r.id, title: r.title,
      time: r.all_day ? 'All day' : clockTime(r.starts_at),
      end: r.ends_at ? clockTime(r.ends_at) : '',
      detail: r.detail || r.location || '',
      type: label(r.kind),
      day: new Date(r.starts_at).getDate(),
      /* When, in words: what a project's or a company's page lists it by. */
      when: meetingDay(r.starts_at, r.all_day) + (r.all_day ? '' : ' · ' + clockTime(r.starts_at)),
      row: r
    };
  }

  /* An activity row (workspace_activity, 0027/0052) the way a feed shows it,
     whether it came from the studio-wide feed or one project's own. */
  function shapeActivity(r) {
    var who = r.actor ? r.actor.full_name : 'Veyago';
    return {
      id: r.id, who: who, initial: initials(who), text: r.summary,
      when: shortDate(r.created_at), createdAt: r.created_at, verb: r.verb,
      entityType: r.entity_type, entityId: r.entity_id, row: r
    };
  }

  function projectTask(r) {
    return {
      id: r.id, title: r.title, done: r.status === 'done', status: r.status,
      who: r.assignee ? r.assignee.full_name : null, assigneeId: r.assignee_id || null, row: r
    };
  }

  window.workspaceData = {
    initials: initials,
    currencyCode: currencyCode,
    money: money,
    shortDate: shortDate,

    /* ── Overview ──────────────────────────────────────────────────────
       One RPC rather than five counts, so the tiles cannot disagree with
       each other. revenue_month is null for non-managers by design. */
    async overview() {
      return rpcInZone('workspace_overview', {}, 'the overview');
    },

    async activity(limit) {
      var rows = unwrap(await sb()
        .from('workspace_activity')
        .select('id, verb, entity_type, entity_id, summary, created_at, actor:employees (full_name)')
        .order('created_at', { ascending: false })
        .limit(limit || 8), 'activity');
      return rows.map(shapeActivity);
    },

    /* ── Agenda ──────────────────────────────────────────────────────── */
    async events(fromISO, toISO) {
      var from = fromISO || new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
      var to = toISO || new Date(Date.now() + 7 * 86400000).toISOString();
      var rows = unwrap(await sb()
        .from('calendar_events')
        .select(EVENT_COLUMNS)
        .neq('status', 'cancelled')
        /* End-exclusive: `to` is the midnight AFTER the last day shown, and an
           event starting on it belongs to a day no grid draws. */
        .gte('starts_at', from).lt('starts_at', to)
        .order('starts_at'), 'the agenda');
      return rows.map(agendaEvent);
    },

    /* The events a week can draw, for the range agendaModel.loadRange() gives
       it: the ones that start before the week ends and end after `since`, the
       day before it begins — or, with no end, start from then on. Asking only
       for events that start inside the week left out one that began before it
       and runs into it. connection_id and created_by decide who may change or
       remove an event (0048): a synced event is the sync's, and one entered
       here its maker's or a manager's. A range that is not two timestamps asks
       for nothing. */
    async eventsOverlapping(range) {
      var to = isoTime(range && range.to);
      var since = isoTime(range && range.since);
      if (!to || !since) return [];
      var rows = unwrap(await sb()
        .from('calendar_events')
        .select(EVENT_LIST_COLUMNS)
        .neq('status', 'cancelled')
        .lt('starts_at', to)
        .or('ends_at.gt."' + since + '",and(ends_at.is.null,starts_at.gte."' + since + '")')
        .order('starts_at'), 'the agenda');
      return rows.map(agendaEvent);
    },

    /* Meetings booked against a project, from today on. A project page lists
       them whatever week the agenda happens to be showing. */
    async upcomingProjectEvents() {
      var from = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
      /* Every column the agenda's own events have: a meeting outside the weeks
         loaded opens its page from this row, which had no brief, place, kind,
         calendar or creator — and so no Remove button. */
      var rows = unwrap(await sb()
        .from('calendar_events')
        .select(EVENT_LIST_COLUMNS)
        .not('project_id', 'is', null)
        .neq('status', 'cancelled')
        .gte('starts_at', from)
        .order('starts_at')
        .limit(500), 'project meetings');
      return rows.map(agendaEvent);
    },

    /* A client's history: meetings that started before `before`, filed under a
       company, its projects or its people — or under one person — the most
       recent first — ties by id, so a page of them is the same each time —
       which the weeks the agenda loads do not reach back to. At most `limit`
       (20 unless given, 100 at most), and one more is asked for, to tell
       whether there are more. Only ids that are uuids go into the filter, at
       most 50 projects and 50 people, so the address stays a size a server
       takes; `capped` says when some were left out. With no id, or no day,
       nothing is asked. */
    async pastMeetings(filter) {
      var f = filter || {};
      var before = isoTime(f.before);
      var conditions = [];
      if (uuids([f.companyId], 1).length) conditions.push('company_id.eq.' + f.companyId);
      var allProjects = uuids(f.projectIds, Infinity);
      var allContacts = uuids(f.contactIds, Infinity);
      var projectIds = allProjects.slice(0, 50);
      var contactIds = allContacts.slice(0, 50);
      if (projectIds.length) conditions.push('project_id.in.(' + projectIds.join(',') + ')');
      if (contactIds.length) conditions.push('contact_id.in.(' + contactIds.join(',') + ')');
      if (!before || !conditions.length) return { meetings: [], more: false };
      var limit = Math.min(Math.max(Math.floor(Number(f.limit)) || 20, 1), 100);
      var rows = unwrap(await sb()
        .from('calendar_events')
        .select(EVENT_LIST_COLUMNS)
        .neq('status', 'cancelled')
        .lt('starts_at', before)
        .or(conditions.join(','))
        .order('starts_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1), 'past meetings');
      return {
        meetings: rows.slice(0, limit).map(agendaEvent),
        more: rows.length > limit,
        capped: allProjects.length > 50 || allContacts.length > 50
      };
    },

    /* One event by its id, for a page the weeks loaded do not reach — a
       client's past meeting, or a link to one. null when there is none, or it
       is not this person's to see; only a uuid is asked for. */
    async event(id) {
      if (!uuids([id], 1).length) return null;
      var rows = unwrap(await sb()
        .from('calendar_events')
        .select(EVENT_PAGE_COLUMNS)
        .eq('id', id)
        .limit(1), 'the event');
      return rows.length ? agendaEvent(rows[0]) : null;
    },

    /* Who is invited to one event, by its id, for the page of one that came
       from a list — which leaves that column out. null when there is no such
       event, or it is not this person's to see; nobody when the column holds
       nothing. Only a uuid is asked for. */
    async eventInvitees(id) {
      if (!uuids([id], 1).length) return null;
      var rows = unwrap(await sb()
        .from('calendar_events')
        .select('id, attendees')
        .eq('id', id)
        .limit(1), 'who is invited');
      if (!rows.length) return null;
      return Array.isArray(rows[0].attendees) ? rows[0].attendees : [];
    },

    /* ── A project's team, client people, files and budget (0039) ─────── */
    /* Small tables, loaded whole and shaped by projects-model.js. RLS decides
       what comes back: files only for the projects this person may open,
       budgets only for owners and admins. */

    async projectMembers() {
      return unwrap(await sb().from('project_members')
        .select('project_id, employee_id, created_at')
        .order('created_at'), 'project teams');
    },

    async projectContacts() {
      return unwrap(await sb().from('project_contacts')
        .select('project_id, contact_id, role, created_at')
        .order('created_at'), 'project contacts');
    },

    async projectFiles() {
      return unwrap(await sb().from('project_files')
        .select('id, project_id, storage_path, name, size_bytes, content_type, uploaded_by, created_at')
        .order('created_at', { ascending: false }), 'project files');
    },

    async projectBudgets() {
      return unwrap(await sb().from('project_budgets')
        .select('project_id, amount, currency, updated_at'), 'project budgets');
    },

    /* ── Tickets ─────────────────────────────────────────────────────── */
    /* Every open and closed ticket, a page at a time (everyRow): the API's own
       row cap used to cut this off in silence past a thousand, and a studio
       with more tickets than that would have quietly stopped seeing its
       oldest ones. */
    async tickets() {
      var rows = await everyRow(function (from, to) {
        return sb()
          .from('support_tickets')
          .select('id, number, subject, product, priority, status, source, created_at, updated_at, ' +
                  'first_response_at, resolved_at, first_response_due_at, resolve_due_at, ' +
                  'project_id, company_id, contact_id, assignee_id, merged_into_id, ' +
                  'requester_name, requester_email, ' +
                  /* client_number (0053) rides along on the same embed the
                     ticket already carries, so its page can quote it beside
                     whichever company it is filed under — read straight off
                     the row (tickets-ui.js's clientNumberOf), never through
                     tickets-model.js, which knows nothing of it. */
                  'contact:crm_contacts (full_name, email), company:crm_companies (name, client_number), ' +
                  'assignee:employees (full_name), ' +
                  /* Enough of each message to know whether the conversation
                     changed since it was last read — its id, direction and
                     delivery — never its words or who wrote it: that used to
                     come with every ticket on every load (audit #12), the
                     heaviest part of a row that mostly goes unread. The whole
                     conversation is a separate call (ticketMessages), asked for
                     once a ticket's page actually needs it, the same way a mail
                     thread's body is kept apart from its list. */
                  'ticket_messages (id, direction, created_at, delivered_at, delivery_error)')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to);
      }, 'tickets');
      return rows.map(function (r) {
        var messages = (r.ticket_messages || []).slice().sort(function (a, b) {
          return String(a.created_at).localeCompare(String(b.created_at));
        });
        var lastOutbound = messages.filter(function (m) { return m.direction === 'outbound'; }).pop();
        var client = (r.contact && r.contact.full_name)
                  || (r.company && r.company.name)
                  /* A sender no CRM contact matched (audit #1) is still someone
                     to answer: routing (route_mail_to_ticket) and manual
                     creation both keep the raw name and address they arrived
                     with, so the ticket is never just "Unknown" with nowhere
                     for a reply to go. */
                  || r.requester_name || r.requester_email || 'Unknown';
        return {
          id: r.number, uuid: r.id, title: r.subject, client: client,
          product: r.product || '—',
          priority: label(r.priority), status: label(r.status),
          owner: r.assignee ? initials(r.assignee.full_name) : '—',
          /* "Assigned to me" is this id — it was a set of initials. */
          assigneeId: r.assignee_id || null,
          assigneeName: r.assignee ? r.assignee.full_name : '',
          contactEmail: (r.contact && r.contact.email) || r.requester_email || '',
          date: shortDate(r.created_at),
          /* How many messages the conversation has, and when the last one
             arrived: what tells the store's cached copy of the whole
             conversation (data/store.js askTicketThread) from one worth
             asking for again, without carrying every message's words here to
             find out. */
          messageCount: messages.length,
          lastMessageAt: messages.length ? messages[messages.length - 1].created_at : null,
          /* Whether the most recent reply reached the customer — shown in the
             queue so a failed send is found without opening the ticket. */
          deliveryFailed: Boolean(lastOutbound && lastOutbound.delivery_error && !lastOutbound.delivered_at),
          mergedIntoId: r.merged_into_id || null,
          /* Not loaded with the list (see the embed's comment above); asked
             for by the ticket's page through workspaceStore.askTicketThread. */
          thread: null, row: r
        };
      });
    },

    /* A ticket's whole conversation, oldest first, with who wrote each
       message — asked for once a ticket's page is open (data/store.js), not
       with every ticket on every load (audit #12). */
    async ticketMessages(ticketId) {
      var rows = unwrap(await sb()
        .from('ticket_messages')
        .select('id, body, direction, created_at, delivered_at, delivery_error, ' +
                'author:employees (full_name), sender:crm_contacts (full_name)')
        .eq('ticket_id', ticketId)
        .order('created_at'), 'the ticket\'s conversation');
      return rows.slice().sort(function (a, b) {
        return String(a.created_at).localeCompare(String(b.created_at));
      }).map(function (m) {
        return Object.assign({}, m, {
          who: (m.author && m.author.full_name) || (m.sender && m.sender.full_name) || ''
        });
      });
    },

    /* A ticket's attachments, newest first — audit #11. Most come with a
       message (message_id set, from an incoming email); one added straight to
       the ticket has none. */
    async ticketAttachments(ticketId) {
      var rows = unwrap(await sb()
        .from('ticket_attachments')
        .select('id, message_id, storage_path, name, size_bytes, content_type, uploaded_by, created_at, ' +
                'uploader:employees (full_name)')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: false }), 'the ticket\'s attachments');
      return rows.map(function (r) {
        return {
          id: r.id, name: r.name, sizeBytes: r.size_bytes, contentType: r.content_type,
          storagePath: r.storage_path, messageId: r.message_id,
          uploadedBy: r.uploaded_by || null, uploaderName: r.uploader ? r.uploader.full_name : '',
          createdAt: r.created_at
        };
      });
    },

    /* ── Projects ────────────────────────────────────────────────────── */
    /* sort_order is 0 for every project alike — nothing in the workspace ever
       sets it to anything else — so ordering by it first settled nothing, and
       whatever order Postgres happened to hand rows back in (not guaranteed
       to be the same twice) decided the rest: a reload could reshuffle the
       whole list. Ordered by name then, tie-broken by id, the way contacts
       and companies already are (everyRow, above) — every reload the same. */
    async projects() {
      var rows = unwrap(await sb()
        .from('client_project_progress')
        .select('*')
        .order('sort_order').order('name').order('id'), 'projects');
      return rows.map(function (r) {
        return {
          id: r.id, name: r.name, client: r.company_name || 'Internal product',
          initial: r.code || initials(r.name), style: r.accent === 'default' ? '' : r.accent,
          progress: Number(r.progress) || 0,
          due: r.due_on ? shortDate(r.due_on) : '',
          status: label(r.status), description: r.description || '',
          taskCount: r.task_count, tasksDone: r.tasks_done, row: r
        };
      });
    },

    /* Archived projects (deleted_at set): left out of client_project_progress
       entirely (0022's view), so a project once archived could not be found
       again anywhere in the workspace. Read straight off client_projects —
       RLS lets any staff member see it, archived or not (0022's own select
       policy carries no deleted_at condition; only the view added one) — with
       just enough to list and restore one, none of the task rollups a live
       board needs. Newest-archived first, tie-broken by id. */
    async archivedProjects() {
      var rows = unwrap(await sb()
        .from('client_projects')
        .select('id, name, code, accent, status, description, company_id, owner_id, due_on, deleted_at, ' +
                'company:crm_companies (name)')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .order('id'), 'archived projects');
      return rows.map(function (r) {
        return {
          id: r.id, name: r.name, client: (r.company && r.company.name) || 'Internal product',
          initial: r.code || initials(r.name), style: r.accent === 'default' ? '' : r.accent,
          status: label(r.status), description: r.description || '',
          archivedAt: r.deleted_at, archived: shortDate(r.deleted_at), row: r
        };
      });
    },

    /* A project's own history (0052): the tasks, notes and files logged under
       it, which can reach further back than the studio-wide feed's most
       recent window keeps (that one is loaded with the workspace and capped;
       this is asked for by a project's page, the way a client's past
       meetings are). Only a uuid is asked for. */
    async projectActivity(projectId, limit) {
      if (!uuids([projectId], 1).length) return [];
      var rows = unwrap(await sb()
        .from('workspace_activity')
        .select('id, verb, entity_type, entity_id, summary, created_at, actor:employees (full_name)')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 200)), 'this project’s activity');
      return rows.map(shapeActivity);
    },

    async projectTasks(projectId) {
      var rows = unwrap(await sb()
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('project_id', projectId)
        .order('created_at'), 'project tasks');
      return rows.map(projectTask);
    },

    /* Every project's tasks in one request rather than one per project, a page
       at a time (everyRow). */
    async allProjectTasks() {
      var rows = await everyRow(function (from, to) {
        return sb()
          .from('tasks')
          .select(TASK_COLUMNS)
          .not('project_id', 'is', null)
          .order('created_at')
          .order('id')
          .range(from, to);
      }, 'project tasks');
      return rows.map(projectTask);
    },

    /* ── CRM ─────────────────────────────────────────────────────────── */
    /* Every contact, a page at a time (everyRow): the list used to stop at the
       thousandth without a word. */
    async contacts() {
      var rows = await everyRow(function (from, to) {
        return sb()
          .from('crm_contacts')
          /* is_primary and enquiry_id ride along on the raw row (crm-ui.js
             reads them from .row) rather than in the shape below, which
             crm-model.js's shapeContact() already builds from these same
             columns and is not this file's to change. */
          .select('id, full_name, email, phone, title, notes, is_primary, enquiry_id, ' +
                  'company:crm_companies (id, name, stage, value, currency)')
          .is('deleted_at', null)
          .order('full_name')
          .order('id')
          .range(from, to);
      }, 'contacts');
      return rows.map(function (r) {
        var co = r.company;
        return {
          id: r.id, name: r.full_name, initial: initials(r.full_name),
          company: co ? co.name : '—', email: r.email || '',
          stage: co ? label(co.stage) : 'Lead',
          value: co ? (money(co.value, co.currency) || '—') : '—',
          notes: r.notes || '', row: r
        };
      });
    },

    /* Every company, a page at a time (everyRow), as contacts are. A client
       number (0053) is given once, when a company first reaches the client
       stage — a lead has none yet. */
    async companies() {
      var rows = await everyRow(function (from, to) {
        return sb()
          .from('crm_companies')
          .select('id, name, domain, kind, stage, value, currency, owner_id, notes, client_number')
          .is('deleted_at', null)
          .order('name')
          .order('id')
          .range(from, to);
      }, 'companies');
      return rows.map(function (r) {
        return {
          id: r.id, name: r.name, domain: r.domain || '',
          stage: label(r.stage), kind: label(r.kind), clientNumber: r.client_number == null ? null : r.client_number,
          value: money(r.value, r.currency) || '—', notes: r.notes || '', row: r
        };
      });
    },

    /* Every deal, a page at a time (everyRow), as companies and contacts are:
       a studio's pipeline only ever grows, and the closed deals are the part
       that never stops growing.

       Open and closed alike — the board draws both, and the Won and Lost
       columns ARE the history 0067 added the table for. Soft-deleted ones are
       left out, the same as a removed company or contact.

       Ordered by created_at then id, so every reload puts a column's cards in
       the same order rather than PostgREST's own. The shape stays thin on
       purpose: dealsModel.shapeDeal() builds what the views read, from these
       same columns, and is tested without a browser. */
    async deals() {
      var rows = await everyRow(function (from, to) {
        return sb()
          .from('crm_deals')
          .select('id, company_id, title, stage, value, currency, owner_id, ' +
                  'expected_close, outcome, closed_at, notes, created_at')
          .is('deleted_at', null)
          .order('created_at')
          .order('id')
          .range(from, to);
      }, 'deals');
      return rows.map(function (r) {
        return {
          id: r.id, title: r.title,
          stage: label(r.outcome || r.stage),
          value: money(r.value, r.currency) || '—',
          row: r
        };
      });
    },

    /* Leads from the public "Get a quote" form (managers only — RLS returns []
       for anyone else, 0019). The site admin already lists these; this is the
       same table, read for the workspace's own Promote button. */
    async enquiries() {
      var rows = unwrap(await sb()
        .from('website_enquiries')
        .select('id, kind, name, email, business, website, message, status, created_at')
        .order('created_at', { ascending: false }), 'enquiries');
      return rows.map(function (r) {
        return {
          id: r.id, name: r.name || '', email: r.email || '',
          business: r.business || '', website: r.website || '',
          message: r.message || '', status: label(r.status),
          kind: label(r.kind), when: shortDate(r.created_at), row: r
        };
      });
    },

    /* ── Finance (managers only — RLS returns [] for everyone else) ──── */
    /* updated_at, tax_rate and tax_amount, and each invoice's line items
       (0060): finance-model.js's shapeInvoice() does not know any of these —
       it is a peer file, tested and not touched here — but every shaped
       invoice keeps the full row under `row`, which is where finance-ui.js
       reads them from. Lines come back oldest-sort-order first, the way an
       invoice reads down the page; an invoice with none (every one made
       before 0060 was backfilled with the one line invoice-pdf.ts prints for
       it, so this is really "not yet re-read", not "blank"). A page at a
       time (everyRow), as tickets and contacts are: a studio with more than
       a thousand invoices was silently missing its oldest. Ties on issued_on
       (same day, or both unissued) break on id, so a page ends the same way
       every time it is asked for. */
    async invoices() {
      var rows = await everyRow(function (from, to) {
        return sb()
          .from('finance_invoices')
          .select('id, number, client, client_email, amount, currency, status, issued_on, due_on, paid_on, notes, ' +
                  'updated_at, tax_rate, tax_amount, ' +
                  /* company_id (0051, filled by a trigger from the client name
                     or the invoice's project) and the client_number it leads
                     to (0053) ride along on the row for finance-ui.js to read
                     straight off .row.company — a company with no number yet,
                     or no company at all, embeds as null and quotes nothing. */
                  'company_id, company:crm_companies (client_number), ' +
                  'finance_invoice_lines (id, description, quantity, unit_amount, amount, sort_order)')
          .order('issued_on', { ascending: false, nullsFirst: false })
          .order('sort_order', { foreignTable: 'finance_invoice_lines', ascending: true })
          .order('id')
          .range(from, to);
      }, 'invoices');
      return rows.map(function (r) {
        return {
          id: r.number, uuid: r.id, client: r.client,
          description: r.notes || '', amount: money(r.amount, r.currency),
          status: label(r.status), row: r
        };
      });
    },

    /* Every transaction in the window, a page at a time (everyRow): the plain
       .limit()-less query this replaced stopped at Supabase's 1000-row cap
       without a word once an account had more than that many in range. */
    async transactions(sinceISODate) {
      var since = sinceISODate ||
        new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
      return everyRow(function (from, to) {
        return sb()
          .from('finance_transactions')
          .select('id, posted_at, description, counterparty, amount, currency, status, source, kind')
          .gte('posted_at', since)
          .order('posted_at', { ascending: false })
          .order('id')
          .range(from, to);
      }, 'transactions');
    },

    /* ── Company ─────────────────────────────────────────────────────── */
    /* Ordered by name, not by the spelling of the role — that put the owner
       last, alphabetically after admin and assistant (companyModel.teamCards
       re-sorts anyway: owners, then admins, then the rest, each group by
       name). user_id, email, start_date and the two timestamps are what
       companyModel needs for a person's page and the invite/role rules
       (0043's own grant); every column it is not manager-only for. Still only
       active and invited members: the deactivated are excluded here, as
       before, because this one array is also the picker every other page
       assigns work from (project teams, task assignees, ticket owners), and
       none of those wants a former employee offered back. */
    async team() {
      var rows = unwrap(await sb()
        .from('employees')
        .select('id, user_id, full_name, email, role, title, status, start_date, created_at, updated_at')
        .neq('status', 'inactive')
        .order('full_name')
        .order('id'), 'the team');
      return rows.map(function (r) {
        return {
          id: r.id, name: r.full_name, initial: initials(r.full_name),
          role: r.title || label(r.role),
          tag: label(r.role), row: r
        };
      });
    },

    /* A person's phone (owners, admins and themself) and notes (owners and
       admins only), by their id (employee_private(), 0043). null for nobody
       such, or nothing this viewer may see — companyModel.personDetails()
       reads that as "not shown", never as "none on file". */
    async employeePrivate(id) {
      var rows = unwrap(await sb().rpc('employee_private', { p_employee_id: id }), 'their phone and notes');
      return rows[0] || null;
    },

    /* The studio's own profile — name, tagline, location, contact address,
       website, base currency — for any signed-in member of staff
       (studio_profile(), 0061). [] for anyone else, and for the rest of
       workspace_settings (bank details among them), which stays behind
       "managers read settings" (0016); companyModel.studioProfile() reads an
       empty answer as the studio's own public defaults. */
    async studioProfile() {
      return unwrap(await sb().rpc('studio_profile'), 'the studio profile');
    },

    /* ── Mail ────────────────────────────────────────────────────────── */
    /* Threads for the mail view, each mailbox's folders loaded on their own.
       One shared limit let a busy hello@ push a personal mailbox out of the
       load altogether, and its folders then read as empty. With no mailbox
       ids (the mailbox list failed) it falls back to one query per folder
       across whatever RLS lets this person see.
       Returns { threads, truncated } — truncated names the "mailbox|folder"
       lists that hit the limit, so the view can say it is not everything. */
    /* `before` (an ISO timestamp): a page older than that cursor, for "Load
       more" (store.js loadMoreMail) — the ordinary load leaves it out
       entirely, asking for the newest PER_FOLDER exactly as it always has. */
    async mailThreads(folders, mailboxIds, before) {
      var PER_FOLDER = 200;   // a working inbox, not an archive
      var wanted = [].concat(folders || 'inbox').map(function (f) { return String(f).toLowerCase(); });
      var boxes = mailboxIds && mailboxIds.length ? mailboxIds : [null];

      function threadQuery(box, folder) {
        /* Deliberately NO message bodies. Embedding them made this query 16MB
           for 189 threads — every HTML email in the mailbox, fetched on every
           reload, to render a list that shows a sender, a subject and a
           snippet. Bodies load per thread when one is opened. */
        var q = sb()
          .from('mail_threads')
          .select('id, connection_id, subject, snippet, folder, is_read, is_starred, message_count, ' +
                  'last_message_at, other_party_name, other_party_email, ticket_id, contact_id, ' +
                  'contact:crm_contacts (full_name, email), ' +
                  /* company_id and its client_number (0053) ride along on the
                     conversation's own row, the same way a ticket already
                     carries them (the tickets query above) — so the reading
                     pane can quote the number beside a client's name without
                     a second round trip, and read it straight off the row
                     (mail.js's clientNumberOf, the twin of tickets-ui.js's).
                     mail_threads.company_id is set by the CRM match on an
                     address (0025/0055), widened to a sender's domain for
                     inbound mail no contact claims (0059), or by hand
                     (link_mail_thread). */
                  'company_id, company:crm_companies (name, client_number)');
        /* Starred reaches past the folders listed: a conversation filed away in
           Outlook (0045) with a flag on it is still one you marked to come back
           to. Inbox and Sent load as themselves, so they are left out here. */
        q = folder === 'starred'
          ? q.eq('is_starred', true).not('folder', 'in', '(inbox,sent)')
          : q.eq('folder', folder);
        if (box) q = q.eq('connection_id', box);
        if (before) q = q.lt('last_message_at', before);
        return q
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(PER_FOLDER)
          .then(function (res) { return { key: (box || 'all') + '|' + folder, rows: unwrap(res, 'mail') }; });
      }

      var loaded = await Promise.all(boxes.reduce(function (all, box) {
        return all.concat(wanted.map(function (folder) { return threadQuery(box, folder); }));
      }, []));
      var truncated = loaded
        .filter(function (l) { return l.rows.length >= PER_FOLDER; })
        .map(function (l) { return l.key; });
      var rows = loaded
        .reduce(function (all, l) { return all.concat(l.rows); }, [])
        .sort(function (a, b) { return String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')); });

      var threads = rows.map(function (r) {
        /* Who the OTHER party is, in decreasing order of how much we know
           about them — never whoever sent the newest message (0055: that was
           "last_from_name", and showed our own name on a thread we replied
           to). The subject is NOT a fallback here — it was, and the list
           showed a column of subject lines under a heading meant for names. */
        var who = (r.contact && r.contact.full_name)
               || r.other_party_name
               || r.other_party_email
               || 'Unknown sender';
        var day = shortDate(r.last_message_at);
        return {
          id: r.id, sender: who, initial: initials(who),
          email: (r.contact && r.contact.email) || r.other_party_email || '',
          subject: r.subject || '(no subject)', preview: r.snippet || '',
          /* A clock time only for today's mail. "09:14" on a thread from last
             week reads as this morning. */
          time: day === 'Today' ? clockTime(r.last_message_at) : day,
          unread: !r.is_read, starred: r.is_starred, count: r.message_count,
          mailboxId: r.connection_id, folder: r.folder,
          ticketId: r.ticket_id, contactId: r.contact_id, companyId: r.company_id,
          /* Filled in by workspaceStore.loadThread() when this thread is
             opened. Absent, not empty, so the reader can tell "not loaded yet"
             from "this message has no body". */
          body: undefined, bodyHtml: undefined, thread: undefined,
          row: r
        };
      });
      return { threads: threads, truncated: truncated };
    },

    async mailMessages(threadId) {
      var rows = unwrap(await sb()
        .from('mail_messages')
        .select('id, external_id, direction, from_name, from_email, to_emails, cc_emails, bcc_emails, ' +
                'subject, body_text, body_html, sent_at, importance, ' +
                /* One embed rather than a second round trip per message
                   (0055) — mail_attachments is metadata only: name, kind,
                   size and, for an inline image, its cid. There is nowhere to
                   fetch the bytes from yet, so an inline <img src="cid:…">
                   still will not render; a named, sized attachment list is
                   what this makes possible today. */
                'mail_attachments (id, name, content_type, size, is_inline, content_id)')
        .eq('thread_id', threadId)
        .order('sent_at'), 'the conversation');
      /* body_html rides along, but ONLY data/mail-html.js may render it — it is
         the most hostile HTML this app handles. See 0025's header. */
      return rows.map(function (r) {
        return {
          id: r.id, sender: r.from_name || r.from_email || 'Unknown',
          initial: initials(r.from_name || r.from_email),
          email: r.from_email || '', subject: r.subject || '',
          body: r.body_text || '', bodyHtml: r.body_html || '',
          time: clockTime(r.sent_at), date: shortDate(r.sent_at),
          to: r.to_emails || [], cc: r.cc_emails || [], bcc: r.bcc_emails || [],
          importance: r.importance || 'normal',
          attachments: (r.mail_attachments || []).map(function (a) {
            return {
              id: a.id, name: a.name || 'attachment', size: a.size || 0,
              contentType: a.content_type || 'application/octet-stream',
              isInline: Boolean(a.is_inline), contentId: a.content_id || null
            };
          }),
          outbound: r.direction === 'outbound', row: r
        };
      });
    },

    /* A contact's or a company's linked conversations, straight off
       mail_threads.contact_id/company_id (0025's own best-effort match on an
       address; 0059 widens the company side to a sender's domain for inbound
       mail no contact claims) — read here, not through mailThreads() above,
       whose per-folder window (queries.js's own PER_FOLDER cap) only ever
       holds a working set for the Mail view, so an older conversation, or one
       filed away (0045), can be linked and still never show up there. This is
       the only place that asks for it, so there is nothing here for
       data/store.js to share — crm-ui.js keeps its own small cache, by key,
       the way it already asks for a client's past meetings.
       Newest first; one more asked for than `limit`, to say whether there are
       more. Only a uuid goes into either filter; with neither, nothing is. */
    async mailThreadsFor(filter) {
      var f = filter || {};
      var conditions = [];
      if (uuids([f.contactId], 1).length) conditions.push('contact_id.eq.' + f.contactId);
      if (uuids([f.companyId], 1).length) conditions.push('company_id.eq.' + f.companyId);
      if (!conditions.length) return { threads: [], more: false };
      var limit = Math.min(Math.max(Math.floor(Number(f.limit)) || 20, 1), 100);
      var rows = unwrap(await sb()
        .from('mail_threads')
        .select('id, subject, folder, is_read, is_starred, last_message_at, other_party_name, other_party_email, contact_id, company_id')
        .or(conditions.join(','))
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(limit + 1), 'their mail');
      return {
        threads: rows.slice(0, limit).map(function (r) {
          return {
            id: r.id, subject: r.subject || '(no subject)',
            sender: r.other_party_name || r.other_party_email || 'Unknown sender',
            time: shortDate(r.last_message_at),
            folder: r.folder, starred: r.is_starred, unread: !r.is_read,
            contactId: r.contact_id, companyId: r.company_id, row: r
          };
        }),
        more: rows.length > limit
      };
    },

    /* What the mail switcher offers: the studio's mailboxes and this person's
       own. Since 0044 that is all RLS returns; before it any member of staff
       could list every connection — colleagues' addresses and last errors
       included — so the filter stays in the query, and
       mailModel.mailboxesFor() applies the same rule a second time. */
    async mailboxes() {
      var me = window.workspaceSession.employee;
      var query = sb()
        .from('integration_status')
        .select('id, provider, account_label, employee_id, employee_name, status, ' +
                'is_live, last_synced_at, last_error')
        .eq('provider', 'microsoft_mail');
      query = me && me.id
        ? query.or('employee_id.is.null,employee_id.eq.' + me.id)
        : query.is('employee_id', null);
      return unwrap(await query.order('account_label'), 'mailboxes');
    },

    /* The true unread count for every mailbox this session may read
       (mail_unread_counts(), 0062) — a real count(), not the 200-per-folder
       window mailThreads() loads. security invoker on the database side, so
       it answers under mail_threads' own RLS, the same rule mailThreads()
       itself reads under; a colleague's personal mailbox is never in it.
       Shaped as a plain {connectionId: count} map, which is what
       mailModel.unreadCountInfo()/trueUnreadTotal() already expect — and
       Number()'d, since a bigint count can come back from PostgREST as a
       string rather than a number. */
    async mailUnreadCounts() {
      var res = await sb().rpc('mail_unread_counts');
      if (res.error) throw new Error('Could not load the unread mail count: ' + res.error.message);
      var out = {};
      (res.data || []).forEach(function (r) { out[r.connection_id] = Number(r.unread_count) || 0; });
      return out;
    },

    /* Every message this person could already open, not only the folders and
       200-per-page loaded on screen (mailThreads above) — a word search_mail
       (0055) finds in a subject, a sender, or a message body. A blank query
       is not asked at all: the database already answers nothing for one, and
       skipping the round trip is one less place a slow network shows. */
    async searchMail(q) {
      var query = String(q || '').trim();
      if (!query) return [];
      var res = await sb().rpc('search_mail', { p_query: query, p_limit: 30 });
      if (res.error) throw new Error('Could not search mail: ' + res.error.message);
      return (res.data || []).map(function (r) {
        var day = shortDate(r.sent_at);
        return {
          threadId: r.thread_id, mailboxId: r.connection_id,
          subject: r.subject || '(no subject)', preview: r.snippet || '',
          time: day === 'Today' ? clockTime(r.sent_at) : day, row: r
        };
      });
    },

    /* A past meeting, or a plain event weeks outside the weeks loaded, found
       by a word in its title, detail or location — a word search_events
       (0064) finds, the same way search_mail (0055) already finds one in
       mail. A blank query is not asked at all, the same guard searchMail
       uses. Shaped by agendaEvent, same as every other event this file
       returns, so shell-model.js's search can treat it exactly like one from
       the weeks loaded or from upcomingProjectEvents. */
    async searchEvents(q) {
      var query = String(q || '').trim();
      if (!query) return [];
      var res = await sb().rpc('search_events', { p_query: query, p_limit: 20 });
      if (res.error) throw new Error('Could not search events: ' + res.error.message);
      return (res.data || []).map(agendaEvent);
    },

    /* Every calendar connection the agenda may show or act on: the studio's
       and this person's own (0044's rule, the same integration_status view
       mailboxes() reads, filtered to the other provider). What the agenda
       says a synced event came from, and what a connections panel offers to
       reconnect or sync (0057, "No way to connect a calendar or see its last
       sync"). */
    async calendars() {
      var me = window.workspaceSession.employee;
      var query = sb()
        .from('integration_status')
        .select('id, provider, account_label, employee_id, employee_name, status, ' +
                'is_live, last_synced_at, last_error')
        .eq('provider', 'microsoft_calendar');
      query = me && me.id
        ? query.or('employee_id.is.null,employee_id.eq.' + me.id)
        : query.is('employee_id', null);
      var rows = unwrap(await query.order('account_label'), 'calendars');
      return rows.map(function (r) {
        return {
          id: r.id, label: r.account_label,
          /* null = the studio's, shared calendar; otherwise this person's own
             (integration_status only ever returns one of the two — 0044). */
          employeeId: r.employee_id || null,
          ownerName: r.employee_id ? r.employee_name : 'Studio',
          live: Boolean(r.is_live), status: r.status,
          lastSyncedAt: r.last_synced_at, lastError: r.last_error || '',
          row: r
        };
      });
    },

    /* The signed-in person's own signatures: one per mailbox, and at most one
       for every mailbox (connection_id null). RLS returns nobody else's. */
    async mailSignatures() {
      return unwrap(await sb()
        .from('mail_signatures')
        .select('id, connection_id, html, use_on_new, use_on_replies, updated_at')
        .order('updated_at', { ascending: false }), 'your signatures');
    },

    /* Monthly income for the Overview chart. Summed in the database so it
       agrees with the Revenue tile; empty for a non-manager, by RLS. */
    async revenueSeries(months) {
      return (await rpcInZone('revenue_series', { p_months: months || 12 }, 'revenue')) || [];
    },

    /* This month's income by category, for the Finance mix panel. */
    async revenueMix(months) {
      return (await rpcInZone('revenue_mix', { p_months: months || 1 }, 'the revenue mix')) || [];
    },

    /* Every note, a page at a time (everyRow). The panels are keyed by
       record, but fetching per record would be one round trip per open
       detail view, so the store groups them once instead — which used to mean
       a studio with more than a thousand notes silently lost its oldest ones
       from every panel at once. Ties on created_at break on id. */
    async notes() {
      var rows = await everyRow(function (from, to) {
        return sb()
          .from('workspace_notes')
          .select('id, entity_type, entity_id, body, created_at, author_id, author:employees (full_name)')
          .order('created_at')
          .order('id')
          .range(from, to);
      }, 'notes');
      return rows.map(function (r) {
        /* Only the employee signed in writes a note (0032's insert policy),
           and a note keeps no author once theirs is deleted (on delete set
           null): a note with none is a former team member's, never the
           studio's. */
        var who = r.author ? r.author.full_name : 'Former team member';
        return {
          id: r.id, entityType: r.entity_type, entityId: r.entity_id,
          /* Who wrote it, by id: only they change it (0032). */
          authorId: r.author_id || null,
          body: r.body, who: who, initial: initials(who),
          time: shortDate(r.created_at), row: r
        };
      });
    },

    /* ── Integrations (the settings screen) ──────────────────────────── */
    async integrations() {
      return unwrap(await sb()
        .from('integration_status')
        .select('*')
        .order('provider'), 'integrations');
    },

    /* ── Notifications (the bell) ────────────────────────────────────── */
    /* Which attention items (shellModel.attention() keys, e.g. "ticket:<uuid>")
       this person has already dismissed (notification_dismissals, 0061). RLS
       hands back only their own rows. */
    async notificationDismissals() {
      var rows = unwrap(await sb()
        .from('notification_dismissals')
        .select('notif_key'), 'dismissed notifications');
      return rows.map(function (r) { return r.notif_key; });
    }
  };
})();
