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

  function money(amount, currency) {
    if (amount === null || amount === undefined) return null;
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0
    }).format(Number(amount));
  }

  /* Sentence case, not Title Case. The views match these strings exactly —
     the project board filters on 'In progress' and the pill colour map is
     keyed by 'In review', 'High', 'Paid'. 'In Progress' matches none of them,
     and the failure is silent: the board renders its columns and no cards. */
  function label(s) {
    var words = String(s || '').replace(/_/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
  }

  window.workspaceData = {
    initials: initials,
    money: money,
    shortDate: shortDate,

    /* ── Overview ──────────────────────────────────────────────────────
       One RPC rather than five counts, so the tiles cannot disagree with
       each other. revenue_month is null for non-managers by design. */
    async overview() {
      var res = await sb().rpc('workspace_overview');
      if (res.error) throw new Error('Could not load the overview: ' + res.error.message);
      return res.data;
    },

    async activity(limit) {
      var rows = unwrap(await sb()
        .from('workspace_activity')
        .select('id, verb, entity_type, entity_id, summary, created_at, actor:employees (full_name)')
        .order('created_at', { ascending: false })
        .limit(limit || 8), 'activity');
      return rows.map(function (r) {
        var who = r.actor ? r.actor.full_name : 'Veyago';
        return {
          id: r.id, who: who, initial: initials(who), text: r.summary,
          when: shortDate(r.created_at), verb: r.verb,
          entityType: r.entity_type, entityId: r.entity_id, row: r
        };
      });
    },

    /* ── Agenda ──────────────────────────────────────────────────────── */
    async events(fromISO, toISO) {
      var from = fromISO || new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
      var to = toISO || new Date(Date.now() + 7 * 86400000).toISOString();
      var rows = unwrap(await sb()
        .from('calendar_events')
        .select('id, title, detail, location, starts_at, ends_at, all_day, kind, status, project_id')
        .neq('status', 'cancelled')
        /* End-exclusive: `to` is the midnight AFTER the last day shown, and an
           event starting on it belongs to a day no grid draws. */
        .gte('starts_at', from).lt('starts_at', to)
        .order('starts_at'), 'the agenda');
      return rows.map(function (r) {
        return {
          id: r.id, title: r.title,
          time: r.all_day ? 'All day' : clockTime(r.starts_at),
          end: r.ends_at ? clockTime(r.ends_at) : '',
          detail: r.detail || r.location || '',
          type: label(r.kind),
          day: new Date(r.starts_at).getDate(),
          row: r
        };
      });
    },

    /* ── Tickets ─────────────────────────────────────────────────────── */
    async tickets() {
      var rows = unwrap(await sb()
        .from('support_tickets')
        .select('id, number, subject, product, priority, status, created_at, ' +
                'contact:crm_contacts (full_name), company:crm_companies (name), ' +
                'assignee:employees (full_name), ' +
                /* The queue view shows the opening message under each row, and
                   the detail view shows the whole thread. Both come from this
                   one embed rather than a second round trip per ticket. */
                'ticket_messages (id, body, direction, created_at)')
        .is('deleted_at', null)
        .order('created_at', { ascending: false }), 'tickets');
      return rows.map(function (r) {
        var client = (r.contact && r.contact.full_name)
                  || (r.company && r.company.name) || 'Unknown';
        var thread = (r.ticket_messages || []).slice().sort(function (a, b) {
          return String(a.created_at).localeCompare(String(b.created_at));
        });
        var opening = thread.filter(function (m) { return m.direction === 'inbound'; })[0];
        return {
          id: r.number, uuid: r.id, title: r.subject, client: client,
          product: r.product || '—',
          priority: label(r.priority), status: label(r.status),
          owner: r.assignee ? initials(r.assignee.full_name) : '—',
          date: shortDate(r.created_at),
          body: opening ? opening.body : '',
          thread: thread, row: r
        };
      });
    },

    /* A ticket with its whole thread, oldest first — the order you read it in. */
    async ticket(uuid) {
      var head = await sb()
        .from('support_tickets')
        .select('*, contact:crm_contacts (full_name, email), company:crm_companies (name), ' +
                'assignee:employees (full_name), project:client_projects (name)')
        .eq('id', uuid).maybeSingle();
      if (head.error) throw new Error('Could not load the ticket: ' + head.error.message);
      if (!head.data) return null;

      var messages = unwrap(await sb()
        .from('ticket_messages')
        .select('id, direction, body, created_at, author_employee:employees (full_name), ' +
                'author_contact:crm_contacts (full_name)')
        .eq('ticket_id', uuid)
        .order('created_at'), 'the ticket thread');

      return {
        ticket: head.data,
        messages: messages.map(function (m) {
          var who = (m.author_employee && m.author_employee.full_name)
                 || (m.author_contact && m.author_contact.full_name)
                 || (m.direction === 'inbound' ? 'Customer' : 'Veyago');
          return {
            id: m.id, who: who, initial: initials(who), body: m.body,
            direction: m.direction, internal: m.direction === 'internal',
            when: shortDate(m.created_at), row: m
          };
        })
      };
    },

    /* ── Projects ────────────────────────────────────────────────────── */
    async projects() {
      var rows = unwrap(await sb()
        .from('client_project_progress')
        .select('*')
        .order('sort_order'), 'projects');
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

    async projectTasks(projectId) {
      var rows = unwrap(await sb()
        .from('tasks')
        .select('id, project_id, title, status, priority, due_date, assignee:employees (full_name)')
        .eq('project_id', projectId)
        .order('created_at'), 'project tasks');
      return rows.map(function (r) {
        return {
          id: r.id, title: r.title, done: r.status === 'done', status: r.status,
          who: r.assignee ? r.assignee.full_name : null, row: r
        };
      });
    },

    /* ── CRM ─────────────────────────────────────────────────────────── */
    async contacts() {
      var rows = unwrap(await sb()
        .from('crm_contacts')
        .select('id, full_name, email, title, notes, ' +
                'company:crm_companies (id, name, stage, value, currency)')
        .is('deleted_at', null)
        .order('full_name'), 'contacts');
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

    async companies() {
      var rows = unwrap(await sb()
        .from('crm_companies')
        .select('id, name, domain, kind, stage, value, currency, notes')
        .is('deleted_at', null)
        .order('name'), 'companies');
      return rows.map(function (r) {
        return {
          id: r.id, name: r.name, domain: r.domain || '',
          stage: label(r.stage), kind: label(r.kind),
          value: money(r.value, r.currency) || '—', notes: r.notes || '', row: r
        };
      });
    },

    /* ── Finance (managers only — RLS returns [] for everyone else) ──── */
    async invoices() {
      var rows = unwrap(await sb()
        .from('finance_invoices')
        .select('id, number, client, amount, currency, status, issued_on, due_on, notes')
        .order('issued_on', { ascending: false, nullsFirst: false }), 'invoices');
      return rows.map(function (r) {
        return {
          id: r.number, uuid: r.id, client: r.client,
          description: r.notes || '', amount: money(r.amount, r.currency),
          status: label(r.status),
          date: r.issued_on ? shortDate(r.issued_on) : '', row: r
        };
      });
    },

    async transactions(sinceISODate) {
      var since = sinceISODate ||
        new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
      return unwrap(await sb()
        .from('finance_transactions')
        .select('id, posted_at, description, counterparty, amount, currency, status, source')
        .gte('posted_at', since)
        .order('posted_at', { ascending: false }), 'transactions');
    },

    /* ── Company ─────────────────────────────────────────────────────── */
    async team() {
      var rows = unwrap(await sb()
        .from('employees')
        .select('id, full_name, role, title, status')
        .neq('status', 'inactive')
        .order('role'), 'the team');
      return rows.map(function (r) {
        return {
          id: r.id, name: r.full_name, initial: initials(r.full_name),
          role: r.title || label(r.role), focus: '',
          tag: label(r.role), row: r
        };
      });
    },

    /* ── Mail ────────────────────────────────────────────────────────── */
    async mailThreads(folder) {
      var rows = unwrap(await sb()
        .from('mail_threads')
        .select('id, subject, snippet, folder, is_read, is_starred, message_count, ' +
                'last_message_at, last_from_name, last_from_email, ticket_id, ' +
                'contact:crm_contacts (full_name, email)')
        /* Deliberately NO message bodies. Embedding them made this query 16MB
           for 189 threads — every HTML email in the mailbox, fetched on every
           reload, to render a list that shows a sender, a subject and a
           snippet. Bodies load per thread when one is opened. */
        .eq('folder', (folder || 'inbox').toLowerCase())
        .order('last_message_at', { ascending: false, nullsFirst: false }), 'mail');
      return rows.map(function (r) {
        /* Who wrote, in decreasing order of how much we know about them. The
           subject is NOT a fallback here — it was, and the list showed a
           column of subject lines under a heading meant for names. */
        var who = (r.contact && r.contact.full_name)
               || r.last_from_name
               || r.last_from_email
               || 'Unknown sender';
        return {
          id: r.id, sender: who, initial: initials(who),
          email: (r.contact && r.contact.email) || r.last_from_email || '',
          subject: r.subject || '(no subject)', preview: r.snippet || '',
          time: clockTime(r.last_message_at), unread: !r.is_read,
          starred: r.is_starred, count: r.message_count,
          /* Filled in by workspaceStore.loadThread() when this thread is
             opened. Absent, not empty, so the reader can tell "not loaded yet"
             from "this message has no body". */
          body: undefined, bodyHtml: undefined, thread: undefined,
          row: r
        };
      });
    },

    async mailMessages(threadId) {
      var rows = unwrap(await sb()
        .from('mail_messages')
        .select('id, direction, from_name, from_email, to_emails, subject, ' +
                'body_text, body_html, sent_at')
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
          time: clockTime(r.sent_at),
          outbound: r.direction === 'outbound', row: r
        };
      });
    },

    /* Monthly income for the Overview chart. Summed in the database so it
       agrees with the Revenue tile; empty for a non-manager, by RLS. */
    async revenueSeries(months) {
      var res = await sb().rpc('revenue_series', { p_months: months || 12 });
      if (res.error) throw new Error('Could not load revenue: ' + res.error.message);
      return res.data || [];
    },

    /* This month's income by category, for the Finance mix panel. */
    async revenueMix(months) {
      var res = await sb().rpc('revenue_mix', { p_months: months || 1 });
      if (res.error) throw new Error('Could not load the revenue mix: ' + res.error.message);
      return res.data || [];
    },

    /* Every note in one query. The panels are keyed by record, but fetching
       per record would be one round trip per open detail view; there are never
       many notes, so the store groups them once. */
    async notes() {
      var rows = unwrap(await sb()
        .from('workspace_notes')
        .select('id, entity_type, entity_id, body, created_at, author:employees (full_name)')
        .order('created_at'), 'notes');
      return rows.map(function (r) {
        var who = r.author ? r.author.full_name : 'Veyago';
        return {
          id: r.id, entityType: r.entity_type, entityId: r.entity_id,
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
    }
  };
})();
