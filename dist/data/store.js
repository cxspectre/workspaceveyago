/* store.js — puts live data where the views already look for it.
 *
 * app.js and workspace.js render from top-level arrays: `tickets`, `projects`,
 * `contacts`, `mails`, `invoices`, `events`, `team`. They are `const`, but they
 * are ARRAYS, so their contents can be replaced in place — and a classic
 * script loaded after them shares the same global lexical scope and can reach
 * them by name. That is why this file loads LAST and why it splices rather
 * than assigns: no view code has to change to start showing real rows.
 *
 * Identity is preserved where the views depend on it:
 *   tickets    keyed by ticket number, which is already an integer in the
 *              database, so `tickets.find(t => t.id === Number(id))` still works
 *   projects   known by their uuid (projects-model.js): a position is not stable
 *   contacts   keyed by uuid: a position changes whenever anyone adds one
 *
 * Anything that writes goes through workspaceActions with the uuid, so the
 * fragile part (a numeric id in a URL) never leaves the browser.
 *
 * EACH PART LOADS ON ITS OWN. The workspace used to load in one Promise.all:
 * one query that failed took every other part down with it, a request that
 * never answered held every later load behind it, and a first load that failed
 * left a page of zeros that looked like an empty studio. Now a part that fails
 * keeps what it showed before — or nothing, the first time — and is named in a
 * notice; a request gives up after twenty seconds; a load that failed is tried
 * again; and an open tab looks again every two minutes, repainting only when
 * something changed. The rules are in load-model.js, the behaviour is held by
 * tests/store.test.mjs.
 */
(function () {
  'use strict';

  var L = loadModel;
  var CHECK_EVERY_MS = 30 * 1000;
  var ACTIVITY_LIMIT = 30;
  /* The parts the workspace stands on. Until each has arrived once it is not
     shown: an empty ticket list or CRM reads as a quiet studio, and a write
     that matches a typed client name against them could create a second one. */
  var CORE = ['tickets', 'projects', 'contacts', 'companies'];

  function swap(target, rows) {
    target.length = 0;
    for (var i = 0; i < rows.length; i++) target.push(rows[i]);
    return target;
  }

  var state = {
    loaded: false, loading: false, error: null, loadedAt: null,
    failed: [], notice: null,
    overview: null, revenue: [], revenueMix: [], companies: [], projectEvents: [],
    projectMembers: [], projectContacts: [], projectFiles: [], projectBudgets: [],
    /* mailboxesFailed: the mailbox LIST itself did not load — different from
       there being none. Threads still load (loadMail falls back to no
       connection filter at all), so `mail` still "arrives"; this is the only
       place that failure survives to be shown. */
    mailboxes: [], mailboxesFailed: false, mailTruncated: [], calendars: [],
    /* The true unread count per mailbox (mail_unread_counts(), 0062) — null
       until it has answered once, or on a database from before it: unknown,
       not zero, so mail-model.js's own floor guess is what shows until then. */
    mailUnreadCounts: null,
    /* The Company page's own parts: connections (companyModel.connectionRows),
       the studio's public profile (companyModel.studioProfile) and which bell
       items this person has already dismissed. */
    integrations: [], studioProfile: [], dismissedNotifications: []
  };

  /* When each part last arrived, and what it looked like then. */
  var arrivedAt = {};
  var signatures = {};
  /* The parts that failed as the notice has them: a whole load's failures,
     and since then each part load's (loadParts), in place of the ones before. */
  var lastFailures = [];
  var unserialisable = 0;
  var lastNotes = [];

  /* The weeks of events loaded: today's — which the Overview, the bell, search
     and notes need, whatever the agenda shows — and the week the agenda shows
     when it is another (showWeek, from agenda-ui.js). Until the agenda says,
     that is the week it opens on (agendaModel.startWeek): at the weekend, the
     week about to start. Each week is every event that overlaps it
     (agendaModel.loadRange), so one that began the week before is there too. */
  var shownWeek = null;
  var loadedWeeks = {};
  /* The week keys whose events failed on their last try, and are not being
     asked for again right now — so a week that failed once is not shown as
     failing forever, a week that never asked is not shown as failing at all,
     and a week asked for again shows loading, not the last try's failure,
     while that ask is on its way. Cleared the moment a new request covers a
     key (markWeeksAsking, called before the fetch in loadOnce and loadParts —
     the same windowKey the fetch itself asks weeksToLoad() for, one request
     covering it and failing or succeeding for all of them at once), and again
     on that request's own success (markWeeks) in case a stale key from a
     different, still-failing request rode along. */
  var failedWeeks = {};
  function markWeeksAsking(weeksKey) {
    weeksKey.split('|').forEach(function (key) { delete failedWeeks[key]; });
  }
  function markWeeksFailed(weeksKey) {
    weeksKey.split('|').forEach(function (key) { failedWeeks[key] = true; });
  }
  function weeksToLoad() {
    var now = new Date();
    var today = agendaModel.weekOf(now);
    var shown = shownWeek || agendaModel.startWeek(now);
    return shown.key === today.key ? [today] : [today, shown];
  }
  /* The month view (agenda-ui.js showMonth): a grid of whole weeks, wider than
     the one or two weeksToLoad() already covers, asked for as one range
     rather than one request per row. Set only while the agenda shows it —
     showMonth(null) clears it, so a view nobody is looking at stops asking
     for a month's worth of events every two minutes. { key, since, to } —
     `key` names the month ("2026-10") for monthLoaded(); `since`/`to` are
     what eventsOverlapping() takes, the same shape agendaModel.loadRange()
     gives a week. */
  var shownMonth = null;
  var loadedMonth = null;
  var windowKey = function () {
    var key = weeksToLoad().map(function (week) { return week.key; }).join('|');
    return shownMonth ? key + '+' + shownMonth.key : key;
  };

  /* Events from more than one week, each once — one over a weekend is in both —
     in the order they start. */
  function mergeEvents(lists) {
    var seen = {};
    return [].concat.apply([], lists).filter(function (e) {
      var id = e && (e.id != null ? e.id : e.row && e.row.id);
      if (id == null || seen[id]) return false;
      seen[id] = true;
      return true;
    }).sort(function (a, b) {
      var x = String((a.row || a).starts_at || ''), y = String((b.row || b).starts_at || '');
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  function markWeeks(loaded) {
    loadedWeeks = {};
    /* markWeeksAsking already cleared these keys before this fetch began, so
       this delete never has anything left to do — kept as a second line of
       defence, in case a future caller of markWeeks skips that step. */
    loaded.weeks.forEach(function (key) { loadedWeeks[key] = true; delete failedWeeks[key]; });
    /* Cleared, not left as it was, when this load did not ask for a month
       (loaded.month undefined on an answer kept from before weekFailed's
       `keep`, or null once nobody asked for one): a month shown again after
       being left is loaded again rather than trusted stale. */
    loadedMonth = loaded.month || null;
  }

  /* options.sign: what counts as a change, when not the whole answer.
     options.keep: what to take from an answer that did not change. */
  function part(key, label, load, apply, options) {
    var o = options || {};
    return { key: key, label: label, load: load, apply: apply, sign: o.sign || null, keep: o.keep || null };
  }

  /* A project's shape — known by its id, with its tasks as titles, ticks and
     ids — is projectsModel.shapeProject() in projects-model.js, which is tested. */
  var PARTS = [
    part('tickets', 'tickets',
      function (d) { return d.tickets(); },
      function (rows) { swap(tickets, rows); }),
    /* Every project's tasks in one request, grouped by project. */
    part('projects', 'projects',
      function (d) { return Promise.all([d.projects(), d.allProjectTasks()]); },
      function (both) {
        var tasksByProject = projectsModel.groupTasks(both[1]);
        swap(projects, both[0].map(function (p) {
          return projectsModel.shapeProject(p, tasksByProject[p.id] || []);
        }));
      }),
    part('contacts', 'contacts',
      function (d) { return d.contacts(); },
      function (rows) { swap(contacts, rows); }),
    part('team', 'the team',
      function (d) { return d.team(); },
      function (rows) { swap(team, rows); }),
    /* The weeks travel with the rows, so a week that moved counts as a change.
       Before queries.js can ask for the events overlapping a week, the events
       starting in it. The month view's range (showMonth) rides along the same
       request, one more eventsOverlapping call rather than a load of its own —
       every event a month, a week or a day view could show is one array. */
    part('events', 'the agenda',
      function (d) {
        var weeks = weeksToLoad();
        var month = shownMonth;
        var asks = weeks.map(function (week) {
          var range = agendaModel.loadRange(week);
          return typeof d.eventsOverlapping === 'function' ? d.eventsOverlapping(range) : d.events(range.from, range.to);
        });
        if (month) asks.push(d.eventsOverlapping({ since: month.since, to: month.to }));
        return Promise.all(asks).then(function (lists) {
          return { weeks: weeks.map(function (week) { return week.key; }), month: month ? month.key : null, rows: mergeEvents(lists) };
        });
      },
      function (loaded) {
        swap(events, loaded.rows);
        markWeeks(loaded);
      },
      { keep: markWeeks }),
    part('invoices', 'invoices',
      function (d) { return d.invoices(); },
      function (rows) { swap(invoices, rows); }),
    /* The Overview's feed and its "View all" page: each entry as queries.js
       shapes it — who, when, and the record it is about. */
    part('activity', 'recent activity',
      function (d) { return d.activity(ACTIVITY_LIMIT); },
      function (rows) { swap(workspaceActivity, rows); }),
    part('mail', 'mail', loadMail, applyMail, {
      /* A mailbox's sync time moves every few minutes with nothing new to show:
         not a change worth a repaint, but kept for the next one. Whether the
         mailbox list itself is currently failing is not, on its own, either —
         mailboxesFailed is kept the same way — but IS part of the signature,
         so recovering from a failure (even onto the same empty list) repaints.
         unreadCounts is too: a thread outside the loaded window going from
         unread to read moves the true count with nothing else here to show it. */
      sign: function (value) {
        return {
          threads: value.threads,
          truncated: value.truncated,
          mailboxesFailed: value.mailboxesFailed,
          mailboxes: value.mailboxes.map(function (b) { return Object.assign({}, b, { last_synced_at: null }); }),
          unreadCounts: value.unreadCounts
        };
      },
      keep: function (value) {
        state.mailboxes = value.mailboxes;
        state.mailboxesFailed = Boolean(value.mailboxesFailed);
        state.mailUnreadCounts = value.unreadCounts || null;
      }
    }),
    part('overview', 'the overview figures',
      function (d) { return d.overview(); },
      function (figures) { state.overview = figures; }),
    part('revenue', 'revenue',
      function (d) { return d.revenueSeries(12); },
      function (rows) { state.revenue = rows; }),
    part('revenueMix', 'the revenue mix',
      function (d) { return d.revenueMix(1); },
      function (rows) { state.revenueMix = rows; }),
    /* Every company, contacts or not: what a typed client name is matched to. */
    part('companies', 'companies',
      function (d) { return d.companies(); },
      function (rows) { state.companies = rows; }),
    /* Meetings booked on projects, from today on — not only this week's. */
    part('projectEvents', 'project meetings',
      function (d) { return d.upcomingProjectEvents(); },
      function (rows) { state.projectEvents = rows; }),
    /* A project's team, client people, files and budgets (0039). */
    part('projectMembers', 'project teams',
      function (d) { return d.projectMembers(); },
      function (rows) { state.projectMembers = rows; }),
    part('projectContacts', 'client people on projects',
      function (d) { return d.projectContacts(); },
      function (rows) { state.projectContacts = rows; }),
    part('projectFiles', 'project files',
      function (d) { return d.projectFiles(); },
      function (rows) { state.projectFiles = rows; }),
    part('projectBudgets', 'project budgets',
      function (d) { return d.projectBudgets(); },
      function (rows) { state.projectBudgets = rows; }),
    part('notes', 'notes',
      function (d) { return d.notes(); },
      function (rows) { lastNotes = rows; }),
    /* The studio's calendar connections and this person's own (0057): which
       calendar a synced event came from (agenda-ui.js), and a connections
       panel to reconnect one or ask it to sync now. Not CORE: an agenda with
       no calendars connected is exactly what a studio with none looks like. */
    part('calendars', 'connected calendars',
      function (d) { return d.calendars(); },
      function (rows) { state.calendars = rows; }),
    /* The studio's and this person's own connections (0044), for the
       Company/Studio integrations panel. */
    part('integrations', 'integrations',
      function (d) { return d.integrations(); },
      function (rows) { state.integrations = rows; }),
    /* The studio's public profile (studio_profile(), 0061): [] for a database
       from before 0061 or for anyone it answers nothing to — either way
       companyModel.studioProfile() reads that as the studio's own defaults. */
    part('studioProfile', 'the studio profile',
      function (d) { return d.studioProfile(); },
      function (rows) { state.studioProfile = rows; }),
    /* Which bell items this person has already dismissed (0061): [] for a
       database from before 0061, which the bell then shows everything on, as
       it always has. */
    part('dismissedNotifications', 'dismissed notifications',
      function (d) { return d.notificationDismissals(); },
      function (rows) { state.dismissedNotifications = rows; })
  ];

  /* A load asked for while one is running is queued, not dropped: the running
     one may be reading a window that is already out of date. Queued requests
     collapse into one, which is quiet only if every request was, and loads the
     whole workspace if any request did rather than some parts (options.only).
     `quiet` means a background load — the repaint waits for drafts, and only
     happens when something changed. */
  var running = null;
  var queued = null;

  /* What two queued loads ask for together: everything, if either did. */
  function bothParts(a, b) {
    if (!a || !b) return null;
    return a.concat(b.filter(function (key) { return a.indexOf(key) === -1; }));
  }

  function load(options) {
    var quiet = !!(options && options.quiet === true);
    /* options.only: the parts to load, by key — a week's events, when the
       agenda moves to a week not loaded — rather than the whole workspace. */
    var only = options && Array.isArray(options.only) ? options.only.slice() : null;
    if (running) {
      queued = queued
        ? { quiet: queued.quiet && quiet, only: bothParts(queued.only, only), promise: queued.promise }
        : {
            quiet: quiet,
            only: only,
            promise: running.then(function () {
              var next = queued;
              queued = null;
              return load({ quiet: next.quiet, only: next.only });
            })
          };
      return queued.promise;
    }
    var done = function () { running = null; };
    running = loadOnce(quiet, only).then(done, function (err) {
      done();
      console.error('[workspace] the load itself failed:', err);
    });
    return running;
  }

  /* FNV-1a over the JSON, and its length: enough to tell "the same as last
     time" from "something changed" without keeping megabytes of JSON per part
     — tickets carry every message twice. */
  function signatureOf(value) {
    var json;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      return 'unserialisable:' + (++unserialisable);
    }
    var hash = 0x811c9dc5;
    for (var i = 0; i < json.length; i++) {
      hash ^= json.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36) + ':' + json.length;
  }

  function fetchPart(p, d) {
    return L.withTimeout(Promise.resolve().then(function () { return p.load(d); }), L.TIMEOUT_MS, p.label)
      .then(function (value) { return { part: p, value: value }; },
            function (error) { return { part: p, error: error }; });
  }

  async function loadOnce(quiet, only) {
    if (only) return loadParts(quiet, only);
    var everLoaded = state.loaded;
    state.loading = true;
    /* The loading screen rather than a page of zeros — unless the last try
       failed, when its message stays up while this one runs. */
    if (!everLoaded && !state.notice) repaint(false);

    var key = windowKey();
    /* Asked for again now, so its last failure — if it had one — is not the
       last word on it while this is on its way. */
    markWeeksAsking(key);
    var startedAt = lastStart = Math.max(Date.now(), lastStart + 1);
    var outcomes = await Promise.all(PARTS.map(function (p) { return fetchPart(p, window.workspaceData); }));

    var applied = applyOutcomes(outcomes, quiet, startedAt);
    var changed = applied.changed;
    var failures = applied.failures;
    if (failures.some(function (o) { return o.part.key === 'events'; })) markWeeksFailed(key);
    if (changed || !quiet) regroupNotes();

    var coreMissing = CORE.filter(function (key) { return !arrivedAt[key]; });
    var previous = state.notice;
    if (!coreMissing.length) state.loaded = true;
    state.loading = false;
    state.loadedAt = Date.now();
    lastFailures = failures;
    state.failed = failures.map(function (o) { return o.part.label; });
    state.error = failures.length ? failures[0].error : null;
    state.notice = noticeFor(failures, everLoaded, coreMissing);

    document.body.dispatchEvent(state.loaded
      ? new CustomEvent('workspace:loaded', { detail: state })
      : new CustomEvent('workspace:load-failed', { detail: state.error }));
    paintNotice();
    resetRetryButtons();
    var askedAgain = !failures.length && clearFailedAsks();

    /* Repainted when someone asked for the load, when the workspace opens,
       when it goes between open and blocked, when something on an open
       workspace changed, or when a page's past meetings or event that did not
       load are to be asked for again. A blocked screen is not rebuilt on every
       retry: a screen reader would read its message out again each time. */
    var blockedBefore = Boolean(previous && previous.kind === 'blocked');
    var blockedNow = Boolean(state.notice && state.notice.kind === 'blocked');
    var opening = !everLoaded && state.loaded;
    if (!quiet || opening || blockedBefore !== blockedNow || (changed && state.loaded) || askedAgain) repaint(quiet && everLoaded);

    if (failures.length) scheduleRetry();
    else resetRetry();
    /* The date moved, or the agenda went to another week, while this was in
       flight, so the events that landed are already the old window's — and
       only the events hang on it. load() queues behind the one still running.
       A workspace still blocked leaves them to its retry, which loads it all:
       a failure here would rebuild the blocked screen, and a screen reader
       would read its message out again. */
    if (windowKey() !== key && state.loaded) load({ quiet: true, only: ['events'] });
  }

  /* Each part's answer put in place — or, on a background refresh, left alone
     when it did not change — and what failed. */
  function applyOutcomes(outcomes, quiet, startedAt) {
    var changed = false;
    var failures = [];
    outcomes.forEach(function (o) {
      if (o.error) {
        console.error('[workspace] ' + o.part.label + ' did not load:', o.error);
        failures.push(o);
        return;
      }
      try {
        var signature = signatureOf(o.part.sign ? o.part.sign(o.value) : o.value);
        var unchanged = Boolean(arrivedAt[o.part.key]) && signature === signatures[o.part.key];
        /* A background refresh leaves a part that did not change alone. A load
           someone asked for — the one after a write — applies everything again,
           so an edit only ever made in memory does not outlive it. */
        if (unchanged && quiet) {
          if (o.part.keep) o.part.keep(o.value);
        } else {
          o.part.apply(o.value);
          signatures[o.part.key] = signature;
          if (!unchanged) changed = true;
        }
        arrivedAt[o.part.key] = startedAt;
      } catch (err) {
        console.error('[workspace] ' + o.part.label + ' could not be shown:', err);
        failures.push({ part: o.part, error: err });
      }
    });
    return { changed: changed, failures: failures };
  }

  /* Some parts on their own — a week's events, when the agenda moves to one not
     loaded — rather than the whole workspace, which asked twenty questions again
     for one week's events. What they bring is put in place and repainted when
     it changed, and what failed is added to what the workspace says failed; the
     notice, the refresh clock and a failed whole load's retries stay the whole
     workspace's. */
  async function loadParts(quiet, only) {
    var parts = PARTS.filter(function (p) { return only.indexOf(p.key) !== -1; });
    var keys = parts.map(function (p) { return p.key; });
    var key = windowKey();
    /* Only when events are among the parts asked for here — otherwise these
       weeks are not being asked about at all, and a real failure of theirs
       must not read as cleared. */
    if (keys.indexOf('events') !== -1) markWeeksAsking(key);
    var startedAt = lastStart = Math.max(Date.now(), lastStart + 1);
    var outcomes = await Promise.all(parts.map(function (p) { return fetchPart(p, window.workspaceData); }));
    var applied = applyOutcomes(outcomes, quiet, startedAt);
    if (applied.failures.some(function (o) { return o.part.key === 'events'; })) markWeeksFailed(key);
    lastFailures = lastFailures
      .filter(function (o) { return keys.indexOf(o.part.key) === -1; })
      .concat(applied.failures);
    state.failed = lastFailures.map(function (o) { return o.part.label; });
    state.error = lastFailures.length ? lastFailures[0].error : null;
    state.notice = noticeFor(lastFailures, state.loaded, CORE.filter(function (k) { return !arrivedAt[k]; }));
    paintNotice();
    if (applied.changed || !quiet) regroupNotes();
    /* A load someone asked for repaints regardless of changed — loadOnce does
       the same for the whole workspace (after(), with `only`, is the one
       caller that reaches here not quiet: a write's own dialog has already
       closed by the time this runs, and a write that happened to change
       nothing the signature could tell apart must not leave the page as it
       was before it). */
    if (!quiet || applied.changed || applied.failures.length) repaint(quiet && state.loaded);
    if (applied.failures.length) scheduleRetry(applied.failures.map(function (o) { return o.part.key; }));
    /* Nothing left failing: no retry is needed, and the next failure starts
       from the first delay — a retry that has just fired included. */
    else if (!lastFailures.length) resetRetry();
    else settleRetry(keys);
    if (windowKey() !== key) load({ quiet: true, only: only });
  }

  function noticeFor(failures, everLoaded, coreMissing) {
    var label = function (o) { return o.part.label; };
    var stale = failures.filter(function (o) { return arrivedAt[o.part.key]; });
    return L.loadNotice({
      missing: failures.filter(function (o) { return !arrivedAt[o.part.key]; }).map(label),
      stale: stale.map(label),
      total: PARTS.length,
      everLoaded: everLoaded,
      coreMissing: PARTS
        .filter(function (p) { return coreMissing.indexOf(p.key) !== -1; })
        .map(function (p) { return p.label; }),
      staleSince: stale.length
        ? new Date(Math.min.apply(null, stale.map(function (o) { return arrivedAt[o.part.key]; })))
        : null
    });
  }

  /* A page that throws while it is drawn must not take the load down with it:
     the retry would never be scheduled, and a failed part never tried again.
     The load after a save puts focus back where it was: a select someone just
     changed was rebuilt, and keyboard focus fell to the top of the page. */
  function repaint(quiet) {
    try {
      if (quiet && typeof repaintWhenIdle === 'function') repaintWhenIdle();
      else if (typeof repaintKeepingFocus === 'function') repaintKeepingFocus();
      else if (typeof render === 'function') render();
    } catch (err) {
      console.error('[workspace] the page could not be drawn:', err);
    }
  }

  /* ── Trying again, and looking again ─────────────────────────────────── */

  var retryTimer = null;
  var retryAttempt = 0;
  /* What the retry loads: the parts that failed on their own — a week's
     events — or everything, once a whole load has failed too. */
  var retryParts = null;

  function scheduleRetry(only) {
    var parts = Array.isArray(only) ? only : null;
    if (retryTimer) {
      retryParts = bothParts(retryParts, parts);
      return;
    }
    retryParts = parts;
    retryTimer = setTimeout(function () {
      var next = retryParts;
      retryTimer = null;
      retryParts = null;
      load({ quiet: true, only: next });
    }, L.retryDelay(retryAttempt++));
  }

  function resetRetry() {
    retryAttempt = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryParts = null;
  }

  /* A retry on its way for parts that have loaded since is not needed, and
     the next failure starts from the first delay again. One for the whole
     workspace stays. */
  function settleRetry(keys) {
    if (!retryTimer || !retryParts) return;
    if (retryParts.every(function (k) { return keys.indexOf(k) !== -1; })) resetRetry();
  }

  var authed = false;

  function refreshIfDue() {
    if (!authed || running) return;
    var visible = document.visibilityState !== 'hidden';
    if (L.refreshDue({ loadedAt: state.loadedAt, now: Date.now(), visible: visible })) load({ quiet: true });
  }

  /* ── What the page shows while it waits ──────────────────────────────── */

  /* Until something has loaded, a view drawn from the empty arrays would say
     "No projects yet" and "All calm" — true of nothing. */
  var drawViews = render;
  render = function () {
    if (!state.loaded && (state.loading || state.notice)) return drawWaiting();
    return drawViews.apply(this, arguments);
  };

  function drawWaiting() {
    if (typeof nav === 'function') nav();
    var main = document.querySelector('#main');
    if (!main) return;
    var blocked = state.notice && state.notice.kind === 'blocked';
    main.innerHTML = blocked
      ? '<section class="panel load-screen" role="alert">' +
          '<h2>The workspace could not load.</h2>' +
          '<p>Check your connection, then try again. It also tries again by itself.</p>' +
          '<button class="btn btn-primary" type="button" data-load-retry>Try again</button>' +
        '</section>'
      : '<section class="panel load-screen" aria-busy="true">' +
          '<h2>Loading the workspace…</h2>' +
          '<p>Tickets, projects, mail and the rest are on their way.</p>' +
        '</section>';
  }

  /* Part of the workspace did not load, or did not refresh: said beside the
     breadcrumb, outside #main, so no render wipes it. */
  function paintNotice() {
    var bar = document.querySelector('.context-bar');
    if (!bar) return;
    var notice = state.notice && state.notice.kind !== 'blocked' ? state.notice : null;
    var box = document.getElementById('load-notice');
    if (!notice) {
      if (box) box.hidden = true;
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.id = 'load-notice';
      box.className = 'load-notice';
      box.innerHTML = '<span role="status"></span><button type="button" class="text-btn" data-load-retry>Retry</button>';
      bar.insertBefore(box, document.getElementById('today'));
    }
    box.hidden = false;
    var text = box.querySelector('span');
    /* Set only when it says something new: a live region reads itself out
       again every time its text is set, and this runs after every load. */
    if (text.textContent !== notice.text) {
      text.textContent = notice.text;
      text.title = notice.text;
    }
    var button = box.querySelector('button');
    button.disabled = false;
    button.textContent = 'Retry';
  }

  /* Every "Retry" pressed while the load ran gets its label back — the one in
     Mail's list too, which a quiet load that changed nothing does not redraw. */
  function resetRetryButtons() {
    if (typeof document.querySelectorAll !== 'function') return;
    [].forEach.call(document.querySelectorAll('[data-load-retry]'), function (button) {
      if (!button.dataset.label) return;
      button.disabled = false;
      button.textContent = button.dataset.label;
    });
  }

  /* ── Notes ───────────────────────────────────────────────────────────── */

  /* The note panels are addressed by (kind, id) — a ticket NUMBER, or a
     project's, contact's or event's own id. The database stores a uuid. This
     is the one place that translation lives, so the views keep the keys they
     already use. Worked out again whenever anything changed, from the arrays
     as they are now. */
  function noteKey(note) {
    if (note.entityType === 'ticket') {
      var t = tickets.filter(function (x) { return x.uuid === note.entityId; })[0];
      return t ? ['tickets', t.id] : null;
    }
    if (note.entityType === 'project') {
      return projects.some(function (p) { return p.id === note.entityId; })
        ? ['projects', note.entityId] : null;
    }
    /* Contacts by uuid too: a note form keyed by a place in the list saved the
       note on whoever had moved into that place while it was being written. */
    if (note.entityType === 'contact') {
      return contacts.some(function (c) { return c.id === note.entityId; })
        ? ['crm', note.entityId] : null;
    }
    /* A company's notes, on its own page (0032 takes entity_type 'company'). */
    if (note.entityType === 'company') {
      return (state.companies || []).some(function (c) { return c.id === note.entityId; })
        ? ['companies', note.entityId] : null;
    }
    /* Events are keyed by uuid, not position: the events window moves by
       itself at a date change, and a position would then name another event.
       A project meeting outside the weeks loaded has its notes too. */
    if (note.entityType === 'event') {
      var ev = findEvent(note.entityId);
      return ev ? ['agenda', ev.id] : null;
    }
    return null;
  }

  /* An event by its id, whatever case the address has it in: from the weeks
     loaded, then the project meetings coming up. The one lookup an event's
     page (agenda-ui.js), a note on it and its notes' place use. */
  function findEvent(id) {
    var key = String(id == null ? '' : id).toLowerCase();
    if (!key) return null;
    var match = function (ev) { return Boolean(ev) && String(ev.id).toLowerCase() === key; };
    var found = events.filter(match)[0] || (state.projectEvents || []).filter(match)[0];
    if (found) return found;
    /* A client's past meeting a page loaded, or an event a page asked for by
       its id: their links open their pages too. */
    var pages = Object.keys(pastMeetingsBy);
    for (var i = 0; i < pages.length; i++) {
      var past = pastMeetingsBy[pages[i]];
      var inIt = past.state === 'ready' ? past.meetings.filter(match)[0] : null;
      if (inIt) return inIt;
    }
    var asked = eventsAskedFor[key];
    return asked && asked.state === 'ready' ? asked.event : null;
  }

  function regroupNotes() {
    var byKind = { tickets: {}, projects: {}, crm: {}, agenda: {}, companies: {} };
    lastNotes.forEach(function (note) {
      var key = noteKey(note);
      if (!key) return;                       // its record is gone or not loaded
      (byKind[key[0]][key[1]] = byKind[key[0]][key[1]] || []).push({
        body: note.body, time: note.time, who: note.who,
        initial: note.initial, id: note.id, authorId: note.authorId || null
      });
    });
    Object.keys(byKind).forEach(function (k) {
      if (!recordNotes[k]) recordNotes[k] = {};
      Object.keys(recordNotes[k]).forEach(function (id) { delete recordNotes[k][id]; });
      Object.keys(byKind[k]).forEach(function (id) { recordNotes[k][id] = byKind[k][id]; });
    });
  }

  /* ── Mail ────────────────────────────────────────────────────────────── */

  /* The mailboxes first, then each mailbox's own inbox, sent and starred: one
     shared limit let a busy hello@ push a personal mailbox out of the load.
     Losing the mailbox list degrades to one query per folder across
     everything (RLS decides what comes back), rather than taking mail down
     with it — but that IS a failure, and mail.js must not read it as "no
     mailbox connected": the caller gets mailboxesFailed alongside the empty
     list, rather than the error being swallowed into indistinguishable rows. */
  function loadMail(d) {
    return Promise.all([
      d.mailboxes().then(
        function (boxes) { return { boxes: boxes, failed: false }; },
        function (err) {
          console.error('[workspace] could not load the mailboxes:', err);
          return { boxes: [], failed: true };
        }
      ),
      /* A COUNT-based answer (mail_unread_counts(), 0062): the true unread
         total for every mailbox this person can read, not only the 200 most
         recent inbox threads mailThreads() keeps. Missing on a database from
         before 0062, or failing for any other reason, degrades to null —
         mail-model.js's own floor-based guess (unreadCountInfo) is what the
         badges already showed before this existed, and stays the fallback
         rather than a failure here taking the rest of mail down with it. */
      d.mailUnreadCounts().then(
        function (counts) { return counts; },
        function (err) {
          console.error('[workspace] the true unread count did not load:', err);
          return null;
        }
      )
    ]).then(function (loaded) {
      var mailboxes = loaded[0];
      var unreadCounts = loaded[1];
      var ids = mailboxes.boxes.map(function (b) { return b.id; });
      return d.mailThreads(['inbox', 'sent', 'starred'], ids).then(function (result) {
        return {
          mailboxes: mailboxes.boxes, mailboxesFailed: mailboxes.failed,
          threads: result.threads, truncated: result.truncated,
          unreadCounts: unreadCounts
        };
      });
    });
  }

  /* Thread bodies, fetched when a thread is opened rather than with the list,
     and kept while the thread does not change: a refresh used to throw every
     opened conversation away, so the one being read flashed "Loading the
     message…" whenever any mail arrived. */
  var bodies = {};
  var inFlight = {};
  /* A conversation that failed to load. It used to be cached as an empty one,
     which read as "no messages yet" — not true. Held until someone asks for a
     retry, so a render loop cannot turn one failure into a request storm. */
  var failedThreads = {};

  function attachBody(thread, messages) {
    var newest = messages[messages.length - 1];
    thread.thread = messages;
    thread.body = newest ? newest.body : '';
    thread.bodyHtml = newest ? newest.bodyHtml : '';
  }

  function applyMail(result) {
    var before = {};
    mails.forEach(function (m) { before[m.id] = m; });
    var present = {};
    result.threads.forEach(function (t) {
      present[t.id] = true;
      var old = before[t.id];
      var same = old && old.row && t.row
        && old.row.last_message_at === t.row.last_message_at
        && old.row.message_count === t.row.message_count;
      if (same && bodies[t.id]) attachBody(t, bodies[t.id]);
      else delete bodies[t.id];
    });
    Object.keys(bodies).forEach(function (id) { if (!present[id]) delete bodies[id]; });
    swap(mails, result.threads);
    state.mailboxes = result.mailboxes;
    state.mailboxesFailed = Boolean(result.mailboxesFailed);
    state.mailTruncated = result.truncated;
    state.mailUnreadCounts = result.unreadCounts || null;
    /* "Load more"'s own cursor (below) is the oldest thread `mails` held the
       moment it was last asked for; a fresh mail load can move that window
       forward (new mail arrived) or, more rarely, back, so a page reached
       through it is not trusted across one — asked for again, from `mails`
       as it now stands, rather than risking a silently skipped or repeated
       stretch of mail. */
    moreMailBy = {};
  }

  /* Which version of a thread is loaded: a new message changes both. */
  function versionOf(threadId) {
    var thread = mails.filter(function (m) { return m.id === threadId; })[0];
    return thread && thread.row ? thread.row.message_count + '|' + thread.row.last_message_at : null;
  }

  function loadThread(threadId) {
    if (!threadId || bodies[threadId] || inFlight[threadId] || failedThreads[threadId]) return;
    var request = {};
    var asked = versionOf(threadId);
    inFlight[threadId] = request;
    var done = function () { if (inFlight[threadId] === request) delete inFlight[threadId]; };
    window.workspaceData.mailMessages(threadId)
      .then(function (messages) {
        done();
        /* A refresh brought a newer message while these were on their way, so
           they are no longer the whole conversation: ask again. */
        if (versionOf(threadId) !== asked) return loadThread(threadId);
        bodies[threadId] = messages;
        /* Put it on the thread object too, so the synchronous render can read
           it without going through the cache. */
        var thread = mails.filter(function (m) { return m.id === threadId; })[0];
        if (thread) attachBody(thread, messages);
        if (typeof render === 'function') render();
      }, function (err) {
        done();
        console.error('[workspace] could not load the conversation:', err);
        failedThreads[threadId] = true;
        if (typeof render === 'function') render();
      });
  }

  /* ── "Load more": older mail, one page beyond what mailThreads() keeps ──
     Kept apart from `mails` itself (never pushed into it) rather than folded
     into the ordinary mail part: a background refresh's own swap(mails, …)
     (applyMail, above) always answers with the newest 200-per-folder window
     again, which would silently throw an appended older page away the next
     time mail refreshes — kept here instead, mail.js's own list draws both
     together (mailModel.mergeOlder), and applyMail clears this cache outright
     the moment mail genuinely reloads, since the window a further page would
     continue past may have moved. */
  var moreMailBy = {};
  var moreMailKey = function (mailbox, folder) { return String(mailbox) + '|' + String(folder); };
  var MORE_MAIL_IDLE = Object.freeze({ state: 'idle', more: true, threads: Object.freeze([]) });

  /* The oldest last_message_at among a list of threads matching this mailbox
     and folder — Starred spans every folder a thread could actually be filed
     under, exactly as mailModel.visibleThreads() itself reads "starred". */
  function oldestInScope(list, mailbox, folder) {
    return list.reduce(function (min, t) {
      var matches = (folder === 'starred' ? Boolean(t.starred) : t.folder === folder)
        && (mailbox === 'all' || t.mailboxId === mailbox);
      var at = matches && t.row ? t.row.last_message_at : null;
      return at && (!min || at < min) ? at : min;
    }, null);
  }

  function loadMoreMail(mailbox, folder) {
    var key = moreMailKey(mailbox, folder);
    var existing = moreMailBy[key] || MORE_MAIL_IDLE;
    if (existing.state === 'loading') return existing;
    /* Continues past whatever "Load more" has already reached for this key,
       falling back to the ordinary loaded window the first time it is asked. */
    var before = oldestInScope(existing.threads, mailbox, folder) || oldestInScope(mails, mailbox, folder);
    if (!before) {
      moreMailBy[key] = { state: 'ready', more: false, threads: existing.threads };
      repaint(true);
      return moreMailBy[key];
    }
    var entry = { state: 'loading', more: existing.more, threads: existing.threads };
    moreMailBy[key] = entry;
    var ids = mailbox === 'all' ? state.mailboxes.map(function (b) { return b.id; }) : [mailbox];
    window.workspaceData.mailThreads([folder], ids, before)
      .then(function (result) {
        if (moreMailBy[key] !== entry) return;
        moreMailBy[key] = {
          state: 'ready',
          /* Any one (mailbox, folder) pair hitting queries.js's own PER_FOLDER
             cap means there is more still further back than this page reached. */
          more: result.truncated.length > 0,
          threads: existing.threads.concat(result.threads)
        };
        repaint(true);
      }, function (err) {
        if (moreMailBy[key] !== entry) return;
        console.error('[workspace] older mail did not load:', err);
        moreMailBy[key] = { state: 'failed', more: existing.more, threads: existing.threads };
        repaint(true);
      });
    return entry;
  }

  /* ── A word search across every message this person could read ──────────
     Kept by the exact query typed (search_mail, 0055) — the same word
     searched twice while nothing else has happened should not ask again —
     and forgotten on a write (after(), below), the same as every other
     page's own "asked for" cache: a send, a star or a read may change what
     matches or what a hit's own row now says. */
  var mailSearchBy = {};
  var MAIL_SEARCH_LOADING = Object.freeze({ state: 'loading', results: Object.freeze([]) });
  var MAIL_SEARCH_EMPTY = Object.freeze({ state: 'ready', results: Object.freeze([]) });

  function loadMailSearch(query) {
    var entry = { state: 'loading', results: [] };
    mailSearchBy[query] = entry;
    window.workspaceData.searchMail(query)
      .then(function (results) {
        if (mailSearchBy[query] !== entry) return;
        mailSearchBy[query] = { state: 'ready', results: results || [] };
        repaint(true);
      }, function (err) {
        if (mailSearchBy[query] !== entry) return;
        console.error('[workspace] mail search did not load:', err);
        mailSearchBy[query] = { state: 'failed', results: [] };
        repaint(true);
      });
    return entry;
  }

  /* A client's past meetings, asked for when their page is drawn rather than
     with the workspace — the weeks the agenda loads do not reach back — and
     kept by page and by what was asked, until a write, which may have changed
     one of them. Ones that did not load say so until someone asks again, so a
     page drawn over and over cannot turn one failure into a stream of
     requests. */
  var pastMeetingsBy = {};
  var PAST_LOADING = Object.freeze({ state: 'loading', meetings: Object.freeze([]), more: false });

  function loadPastMeetings(id, filter) {
    var entry = { state: 'loading', meetings: [], more: false };
    pastMeetingsBy[id] = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.pastMeetings(filter); })
      .then(function (result) {
        if (pastMeetingsBy[id] !== entry) return;
        pastMeetingsBy[id] = { state: 'ready', meetings: (result && result.meetings) || [], more: Boolean(result && result.more), capped: Boolean(result && result.capped) };
        /* Notes on these meetings are filed now that they can be found. */
        regroupNotes();
        repaint(true);
      }, function (err) {
        if (pastMeetingsBy[id] !== entry) return;
        console.error('[workspace] past meetings did not load:', err);
        pastMeetingsBy[id] = { state: 'failed', meetings: [], more: false };
        repaint(true);
      });
    return entry;
  }

  /* Transactions in a window, asked for only once Finance's own page wants
     them (finance-ui.js): a manager who never opens Finance this session
     never asks for one, and a write anywhere else in the workspace does not
     refetch them either — after() clears this cache like the others below
     rather than folding it into the whole-workspace reload every write does.
     Kept by the window's since-date, until a write. */
  var transactionsBy = {};
  var TX_LOADING = Object.freeze({ state: 'loading', rows: Object.freeze([]) });

  function loadTransactions(since) {
    var entry = { state: 'loading', rows: [] };
    transactionsBy[since] = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.transactions(since); })
      .then(function (rows) {
        if (transactionsBy[since] !== entry) return;
        transactionsBy[since] = { state: 'ready', rows: rows || [] };
        repaint(true);
      }, function (err) {
        if (transactionsBy[since] !== entry) return;
        console.error('[workspace] transactions did not load:', err);
        transactionsBy[since] = { state: 'failed', rows: [] };
        repaint(true);
      });
    return entry;
  }

  /* Events asked for one at a time by a page the weeks loaded do not reach —
     a link to a client's past meeting — kept by id until a write, and found by
     eventById once they land. */
  var UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var EVENT_LOADING = Object.freeze({ state: 'loading', event: null });
  var EVENT_MISSING = Object.freeze({ state: 'missing', event: null });
  var eventsAskedFor = {};

  function loadEvent(key) {
    var entry = { state: 'loading', event: null };
    eventsAskedFor[key] = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.event(key); })
      .then(function (event) {
        if (eventsAskedFor[key] !== entry) return;
        eventsAskedFor[key] = event ? { state: 'ready', event: event } : { state: 'missing', event: null };
        if (event) regroupNotes();
        repaint(true);
      }, function (err) {
        if (eventsAskedFor[key] !== entry) return;
        console.error('[workspace] the event did not load:', err);
        eventsAskedFor[key] = { state: 'failed', event: null };
        repaint(true);
      });
    return entry;
  }

  /* Who is invited to an event whose row came from a list — the lists leave
     that column out, the largest an event has — asked for by its page and
     kept by id until a write, as events asked for are. */
  var INVITEES_LOADING = Object.freeze({ state: 'loading', attendees: Object.freeze([]) });
  var INVITEES_MISSING = Object.freeze({ state: 'missing', attendees: Object.freeze([]) });
  var inviteesAskedFor = {};

  /* A ticket's whole conversation — every message, worded and attributed —
     apart from the list, which carries only enough of each message to know
     whether the conversation changed (queries.js: messageCount,
     lastMessageAt). Kept by the ticket's uuid, alongside the version it was
     fetched for: a background refresh that leaves both numbers the same
     leaves the cached conversation alone, and ANY write anywhere reloads the
     list (store.after()) without pulling every open ticket's thread with it —
     the version comparison is what tells "this ticket changed" from "some
     other save happened while this ticket's page was open" (audit #12). This
     is deliberately NOT reset in after(), unlike pastMeetingsBy and the two
     below: doing that would reload every open ticket's conversation after
     every save in the workspace, which is the exact cost this exists to
     avoid. A change to THIS ticket's own thread already moves its
     messageCount or lastMessageAt on the next load, which is enough. */
  var TICKET_THREAD_LOADING = Object.freeze({ state: 'loading', messages: Object.freeze([]) });
  var ticketThreadsAskedFor = {};

  function ticketThreadVersion(t) {
    return String(t && t.messageCount != null ? t.messageCount : '') + '|' + String((t && t.lastMessageAt) || '');
  }

  function loadTicketThread(uuid, version) {
    var entry = { state: 'loading', messages: [], version: version };
    ticketThreadsAskedFor[uuid] = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.ticketMessages(uuid); })
      .then(function (messages) {
        if (ticketThreadsAskedFor[uuid] !== entry) return;
        ticketThreadsAskedFor[uuid] = { state: 'ready', messages: messages, version: version };
        repaint(true);
      }, function (err) {
        if (ticketThreadsAskedFor[uuid] !== entry) return;
        console.error('[workspace] the ticket\'s conversation did not load:', err);
        ticketThreadsAskedFor[uuid] = { state: 'failed', messages: [], version: version };
        repaint(true);
      });
    return entry;
  }

  /* A ticket's attachments (0056), kept by uuid until a write — any write, as
     pastMeetingsBy and inviteesAskedFor already are: there is no cheap
     per-ticket signal for these the way messageCount and lastMessageAt are
     for the conversation, and attachments are added and removed rarely
     enough that reloading them after every save costs little. */
  var TICKET_FILES_LOADING = Object.freeze({ state: 'loading', files: Object.freeze([]) });
  var ticketFilesAskedFor = {};

  function loadTicketFiles(uuid) {
    var entry = { state: 'loading', files: [] };
    ticketFilesAskedFor[uuid] = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.ticketAttachments(uuid); })
      .then(function (files) {
        if (ticketFilesAskedFor[uuid] !== entry) return;
        ticketFilesAskedFor[uuid] = { state: 'ready', files: files };
        repaint(true);
      }, function (err) {
        if (ticketFilesAskedFor[uuid] !== entry) return;
        console.error('[workspace] the ticket\'s attachments did not load:', err);
        ticketFilesAskedFor[uuid] = { state: 'failed', files: [] };
        repaint(true);
      });
    return entry;
  }

  function loadInvitees(key) {
    var entry = { state: 'loading', attendees: [] };
    inviteesAskedFor[key] = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.eventInvitees(key); })
      .then(function (attendees) {
        if (inviteesAskedFor[key] !== entry) return;
        inviteesAskedFor[key] = attendees ? { state: 'ready', attendees: attendees } : INVITEES_MISSING;
        repaint(true);
      }, function (err) {
        if (inviteesAskedFor[key] !== entry) return;
        console.error('[workspace] who is invited did not load:', err);
        inviteesAskedFor[key] = { state: 'failed', attendees: [] };
        repaint(true);
      });
    return entry;
  }

  /* Archived projects (deleted_at set): left out of `projects` entirely, the
     same way the client_project_progress view leaves them out, so there was
     no way to see or restore one again. Asked for only when the Projects
     page switches to its Archived view — not with the rest of the workspace,
     since most visits never need it — and kept until a write, which may add
     to or shrink the list (archiving, restoring). One shared entry: unlike
     project activity there is only ever one archived list, not one per id. */
  var archivedProjectsBy = null;
  var ARCHIVED_PROJECTS_LOADING = Object.freeze({ state: 'loading', projects: Object.freeze([]) });

  function loadArchivedProjects() {
    var entry = { state: 'loading', projects: [] };
    archivedProjectsBy = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.archivedProjects(); })
      .then(function (rows) {
        if (archivedProjectsBy !== entry) return;
        archivedProjectsBy = { state: 'ready', projects: rows || [] };
        repaint(true);
      }, function (err) {
        if (archivedProjectsBy !== entry) return;
        console.error('[workspace] archived projects did not load:', err);
        archivedProjectsBy = { state: 'failed', projects: [] };
        repaint(true);
      });
    return entry;
  }

  /* A person's phone and notes (employee_private(), 0043), asked for by their
     page and kept by id until a write, as events asked for are — companyModel
     reads a missing answer, whatever the reason, the same way it reads one it
     was never entitled to: not shown, never "none on file". */
  var employeePrivateAskedFor = {};

  function loadEmployeePrivate(id) {
    var entry = { state: 'loading', details: null };
    employeePrivateAskedFor[id] = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.employeePrivate(id); })
      .then(function (details) {
        if (employeePrivateAskedFor[id] !== entry) return;
        employeePrivateAskedFor[id] = { state: 'ready', details: details };
        repaint(true);
      }, function (err) {
        if (employeePrivateAskedFor[id] !== entry) return;
        console.error('[workspace] their phone and notes did not load:', err);
        employeePrivateAskedFor[id] = { state: 'failed', details: null };
        repaint(true);
      });
    return entry;
  }

  /* A project's own activity (0052), asked for when its page is drawn rather
     than with the whole workspace — the studio-wide feed is capped to its
     most recent rows and a project's own history can reach further back than
     that. Kept by project id until a write, which may have added to it. */
  var projectActivityBy = {};
  var PROJECT_ACTIVITY_LOADING = Object.freeze({ state: 'loading', activity: Object.freeze([]) });

  function loadProjectActivity(id) {
    var entry = { state: 'loading', activity: [] };
    projectActivityBy[id] = entry;
    Promise.resolve()
      .then(function () { return window.workspaceData.projectActivity(id); })
      .then(function (rows) {
        if (projectActivityBy[id] !== entry) return;
        projectActivityBy[id] = { state: 'ready', activity: rows || [] };
        repaint(true);
      }, function (err) {
        if (projectActivityBy[id] !== entry) return;
        console.error('[workspace] a project\'s activity did not load:', err);
        projectActivityBy[id] = { state: 'failed', activity: [] };
        repaint(true);
      });
    return entry;
  }

  /* Past meetings, events, invitees, a ticket's conversation and its
     attachments, a project's own activity, and a person's phone and notes, a
     page asked for that did not load: a load that works tries them again, as
     everything else is tried again by itself. Answers whether any were let
     go. A failed conversation still carries the version it failed at
     (ticketThreadVersion), so this does not undo that — the next
     askTicketThread simply finds nothing cached and asks afresh. */
  function clearFailedAsks() {
    var cleared = false;
    [pastMeetingsBy, eventsAskedFor, inviteesAskedFor, ticketThreadsAskedFor, ticketFilesAskedFor, projectActivityBy, employeePrivateAskedFor].forEach(function (asks) {
      Object.keys(asks).forEach(function (id) {
        if (asks[id].state === 'failed') { delete asks[id]; cleared = true; }
      });
    });
    if (archivedProjectsBy && archivedProjectsBy.state === 'failed') { archivedProjectsBy = null; cleared = true; }
    return cleared;
  }

  /* When the latest load began — never the same moment twice, so a load begun
     just after a change landed is told from one begun just before it. */
  var lastStart = 0;

  window.workspaceStore = {
    get state() { return state; },
    load: load,
    /* Everything again, after a write. The workspace stays "loaded" while it
       runs, because what is on screen is still the last good data: a write made
       meanwhile goes to the database rather than to the offline handlers, and a
       reload that fails leaves the data in place instead of an empty page. */
    reload: function () { return load(); },

    /* Whether a part has ever arrived. A write that matches a typed name
       against companies or contacts needs them, or it creates a second one. */
    has: function (key) { return Boolean(arrivedAt[key]); },
    /* When the latest load began: a change that lands now is on the page once
       its part has arrived from a load begun after this (loadedSince). */
    mark: function () { return lastStart; },
    /* Whether a part has arrived from a load begun after `mark` — so the page
       holds a change that landed then (dialog-forms.js stillSaving). A load
       begun before it, or one that did not bring the part back, does not. */
    loadedSince: function (key, mark) { return Boolean(arrivedAt[key]) && arrivedAt[key] > Number(mark); },

    /* The week the agenda shows (agenda-ui.js). One not loaded yet is fetched
       in the background — its events, not the whole workspace — and the agenda
       repainted when it lands. */
    showWeek: function (week) {
      if (!week || !week.key) return Promise.resolve();
      shownWeek = week;
      return state.loaded && !loadedWeeks[week.key] ? load({ quiet: true, only: ['events'] }) : Promise.resolve();
    },
    /* Whether a week's events are in: until then the agenda says it is loading. */
    weekLoaded: function (key) { return Boolean(loadedWeeks[key]); },
    /* Whether that week's own events failed on their last try — not some
       other week's, and not stuck true once it has since loaded. */
    weekFailed: function (key) { return Boolean(failedWeeks[key]); },

    /* The month the agenda shows (agenda-ui.js, month mode): { key, since, to }
       — since/to as eventsOverlapping() takes a week's. null clears it, so
       leaving month view stops asking for a whole month's events every two
       minutes. One not loaded yet is fetched in the background, as showWeek
       fetches a week; one already loaded is not asked for again. */
    showMonth: function (month) {
      shownMonth = (month && month.key) ? month : null;
      return shownMonth && state.loaded && loadedMonth !== shownMonth.key
        ? load({ quiet: true, only: ['events'] })
        : Promise.resolve();
    },
    /* Whether a month's events are in: until then the month view says it is loading. */
    monthLoaded: function (key) { return Boolean(key) && loadedMonth === key; },

    /* A company's or a person's past meetings (crm-ui.js), as { state:
       'loading' | 'ready' | 'failed', meetings, more }. The first ask for a
       page, once the workspace has loaded, starts the load; the page is drawn
       again when it lands. */
    pastMeetings: function (key, filter) {
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.pastMeetings !== 'function') return PAST_LOADING;
      var id = String(key) + '|' + JSON.stringify(filter || {});
      return pastMeetingsBy[id] || loadPastMeetings(id, filter || {});
    },
    /* Ask again for a page's past meetings that did not load. */
    retryPastMeetings: function (key) {
      var prefix = String(key) + '|';
      Object.keys(pastMeetingsBy).forEach(function (id) {
        if (id.indexOf(prefix) === 0 && pastMeetingsBy[id].state === 'failed') delete pastMeetingsBy[id];
      });
    },

    /* An event a page needs that the weeks loaded do not hold (agenda-ui.js),
       asked for by its id, as { state: 'loading' | 'ready' | 'missing' |
       'failed', event }. Once it lands, eventById finds it too. */
    askEvent: function (id) {
      var key = String(id == null ? '' : id).toLowerCase();
      var found = findEvent(key);
      if (found) return { state: 'ready', event: found };
      if (!UUID_TEXT.test(key)) return EVENT_MISSING;
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.event !== 'function') return EVENT_LOADING;
      return eventsAskedFor[key] || loadEvent(key);
    },
    /* Ask again for an event that did not load. */
    retryEvent: function (id) {
      var key = String(id == null ? '' : id).toLowerCase();
      if (eventsAskedFor[key] && eventsAskedFor[key].state === 'failed') delete eventsAskedFor[key];
    },

    /* Who is invited to an event (agenda-ui.js), asked for by its id, as
       { state: 'loading' | 'ready' | 'missing' | 'failed', attendees }. */
    askInvitees: function (id) {
      var key = String(id == null ? '' : id).toLowerCase();
      if (!UUID_TEXT.test(key)) return INVITEES_MISSING;
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.eventInvitees !== 'function') return INVITEES_LOADING;
      return inviteesAskedFor[key] || loadInvitees(key);
    },

    /* A ticket's whole conversation (tickets-ui.js), as { state: 'loading' |
       'ready' | 'failed', messages }. Takes the ticket itself, not only its
       id: the version that decides whether a cached copy still answers for it
       (messageCount, lastMessageAt) lives on the ticket the list just loaded,
       not in this cache. */
    askTicketThread: function (ticket) {
      var uuid = ticket && ticket.uuid;
      if (!uuid) return TICKET_THREAD_LOADING;
      var version = ticketThreadVersion(ticket);
      var cached = ticketThreadsAskedFor[uuid];
      if (cached && cached.version === version) return cached;
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.ticketMessages !== 'function') return TICKET_THREAD_LOADING;
      return loadTicketThread(uuid, version);
    },
    /* Ask again for a ticket's conversation that did not load. */
    retryTicketThread: function (uuid) {
      if (ticketThreadsAskedFor[uuid] && ticketThreadsAskedFor[uuid].state === 'failed') delete ticketThreadsAskedFor[uuid];
    },

    /* A ticket's attachments (tickets-ui.js), as { state: 'loading' | 'ready'
       | 'failed', files }. */
    askTicketAttachments: function (uuid) {
      if (!uuid) return TICKET_FILES_LOADING;
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.ticketAttachments !== 'function') return TICKET_FILES_LOADING;
      return ticketFilesAskedFor[uuid] || loadTicketFiles(uuid);
    },
    /* Ask again for a ticket's attachments that did not load. */
    retryTicketAttachments: function (uuid) {
      if (ticketFilesAskedFor[uuid] && ticketFilesAskedFor[uuid].state === 'failed') delete ticketFilesAskedFor[uuid];
    },

    /* A project's own activity (project-panels.js), as { state: 'loading' |
       'ready' | 'failed', activity }. The first ask for a project, once the
       workspace has loaded, starts the load; its page is drawn again once it
       lands. */
    projectActivity: function (id) {
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.projectActivity !== 'function') return PROJECT_ACTIVITY_LOADING;
      return projectActivityBy[id] || loadProjectActivity(id);
    },
    /* Ask again for a project's activity that did not load. */
    retryProjectActivity: function (id) {
      if (projectActivityBy[id] && projectActivityBy[id].state === 'failed') delete projectActivityBy[id];
    },

    /* Archived projects (projects-ui.js's Archived view), as { state:
       'loading' | 'ready' | 'failed', projects }. The first ask starts the
       load; the page is drawn again once it lands. */
    archivedProjects: function () {
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.archivedProjects !== 'function') return ARCHIVED_PROJECTS_LOADING;
      return archivedProjectsBy || loadArchivedProjects();
    },
    /* Ask again for the archived list once it has failed. */
    retryArchivedProjects: function () {
      if (archivedProjectsBy && archivedProjectsBy.state === 'failed') archivedProjectsBy = null;
    },

    /* Transactions since a day (finance-ui.js), as { state: 'loading' |
       'ready' | 'failed', rows }. The first ask for a window starts the
       load; the page is drawn again when it lands. */
    transactions: function (since) {
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.transactions !== 'function') return TX_LOADING;
      return transactionsBy[since] || loadTransactions(since);
    },
    /* Ask again for a window of transactions that did not load. */
    retryTransactions: function (since) {
      if (transactionsBy[since] && transactionsBy[since].state === 'failed') delete transactionsBy[since];
    },

    /* A person's phone and notes (company-forms.js, workspace.js personDetail),
       by their employee id: the row employee_private() answered, or null while
       it is on its way, was refused, or is not this person's to see —
       companyModel.personDetails() treats every one of those the same way. */
    askEmployeePrivate: function (id) {
      var key = String(id == null ? '' : id).toLowerCase();
      if (!UUID_TEXT.test(key) || !state.loaded || !window.workspaceData
          || typeof window.workspaceData.employeePrivate !== 'function') return null;
      var entry = employeePrivateAskedFor[key] || loadEmployeePrivate(key);
      return entry.state === 'ready' ? entry.details : null;
    },

    /* Views call this after a write so the screen and the database agree. A
       refusal is said in a toast — unless the view says it itself, where it
       happened, and asks for none with { toast: false }: a dialog's error
       line (dialog-forms.js), which a screen reader would otherwise hear
       twice. options.only: the parts this write can have changed — a CRM
       save touches only contacts and companies, an event save only
       ['events'] (and ['events','projectEvents'] for one on a project), not
       the other parts a note or a task save still reloads whole; named ones
       are reloaded on their own, fewer requests for the same repaint.
       Left out, every part reloads exactly as it always has: `only` is
       something a caller opts INTO, never assumed. A write that FAILS
       always reloads everything regardless, in a full, quiet reload — a
       refusal can still land after an earlier step of a multi-step write
       went through, and `only` naming what the caller expected to change is
       not proof nothing else did. */
    async after(promise, options) {
      var only = options && Array.isArray(options.only) && options.only.length ? options.only : null;
      /* Not quiet: a write's own dialog has already closed by the time this
         runs, and loadParts() only skips its repaint on a quiet load that
         changed nothing — a write that happened to change nothing the
         signature could tell apart must still redraw, or the page is left
         showing the record as still saving. */
      var reload = only ? { only: only } : undefined;
      try {
        var out = await promise;
        pastMeetingsBy = {};
        eventsAskedFor = {};
        inviteesAskedFor = {};
        ticketFilesAskedFor = {};
        projectActivityBy = {};
        archivedProjectsBy = null;
        transactionsBy = {};
        employeePrivateAskedFor = {};
        mailSearchBy = {};
        await load(reload);
        return out;
      } catch (err) {
        pastMeetingsBy = {};
        eventsAskedFor = {};
        inviteesAskedFor = {};
        ticketFilesAskedFor = {};
        projectActivityBy = {};
        archivedProjectsBy = null;
        transactionsBy = {};
        employeePrivateAskedFor = {};
        mailSearchBy = {};
        if (typeof toast === 'function' && !(options && options.toast === false)) toast(err.message);
        /* A write that failed may still have changed something — a row saved
           before a later step was refused — so the page is brought back to
           what the database has, and a second try starts from the truth.
           Always the whole workspace, never scoped to `only`: a caller
           naming the parts it expected to change is not proof nothing else
           did, and the safety net a failure needs is not narrower just
           because the write happened to name a part. */
        load({ quiet: true });
        throw err;
      }
    },

    /* The reverse of noteKey(): which record does (kind, id) mean? */
    noteTarget: function (kind, id) {
      if (kind === 'tickets') {
        var t = this.ticketByNumber(id);
        return t ? { type: 'ticket', id: t.uuid } : null;
      }
      if (kind === 'projects') {
        var p = projectsModel.projectById(projects, String(id || ''));
        return p ? { type: 'project', id: p.uuid } : null;
      }
      if (kind === 'crm') {
        var c = this.contactById(id);
        return c ? { type: 'contact', id: c.id } : null;
      }
      if (kind === 'companies') {
        var wanted = String(id == null ? '' : id).toLowerCase();
        var co = (state.companies || []).filter(function (x) { return x.id === wanted; })[0];
        return co ? { type: 'company', id: co.id } : null;
      }
      if (kind === 'agenda') {
        var e = this.eventById(id);
        return e ? { type: 'event', id: e.id } : null;
      }
      return null;
    },

    /* An event by its id (findEvent): a note on a meeting outside the weeks
       loaded used to find no event to go on. */
    eventById: function (id) { return findEvent(id); },

    /* Called by the mail reader on every render. Returns what it has and
       fetches what it does not; the fetch re-renders when it lands. */
    threadBody: function (threadId) {
      if (bodies[threadId]) return bodies[threadId];
      loadThread(threadId);
      return null;
    },
    loadThread: loadThread,
    threadFailed: function (threadId) { return Boolean(failedThreads[threadId]); },
    /* Asked for by a person, so it gets one fresh attempt. */
    retryThread: function (threadId) {
      delete failedThreads[threadId];
      loadThread(threadId);
    },

    /* "Load more" for one folder of one mailbox (mail.js), as { state:
       'idle' | 'loading' | 'ready' | 'failed', more, threads } — never
       started merely by asking (unlike pastMeetings/transactions above):
       a page rendered over and over must not turn into a stream of older-
       mail requests nobody clicked for. loadMoreMail is the one thing that
       starts it. */
    moreMail: function (mailbox, folder) { return moreMailBy[moreMailKey(mailbox, folder)] || MORE_MAIL_IDLE; },
    loadMoreMail: loadMoreMail,

    /* A word search across every mailbox this person can read (mail.js),
       as { state: 'loading' | 'ready' | 'failed', results }. A blank query
       is answered at once, with nothing asked for: search_mail itself
       answers nothing for one, and skipping the round trip is one less
       place a slow network shows on every keystroke that clears the box. */
    searchMail: function (query) {
      var q = String(query || '').trim();
      if (!q) return MAIL_SEARCH_EMPTY;
      if (!state.loaded || !window.workspaceData || typeof window.workspaceData.searchMail !== 'function') return MAIL_SEARCH_LOADING;
      return mailSearchBy[q] || loadMailSearch(q);
    },
    /* Ask again for a search that did not load. */
    retrySearchMail: function (query) {
      var q = String(query || '').trim();
      if (mailSearchBy[q] && mailSearchBy[q].state === 'failed') delete mailSearchBy[q];
    },

    /* Projects are known by id (projects-model.js), never by position. */
    projectById: function (id) { return projectsModel.projectById(projects, String(id || '')); },
    /* A contact by its uuid — never by its place in the list, which changes
       whenever anyone adds one. */
    contactById: function (id) {
      return contacts.filter(function (c) { return c.id === String(id); })[0] || null;
    },

    ticketByNumber: function (n) {
      return tickets.filter(function (t) { return t.id === Number(n); })[0] || null;
    }
  };

  document.body.addEventListener('workspace:authed', function () {
    authed = true;
    load();
  });

  /* "Try again" on the loading screen, "Retry" in the notice. */
  document.addEventListener('click', function (e) {
    var button = e.target.closest && e.target.closest('[data-load-retry]');
    if (!button) return;
    e.preventDefault();
    button.disabled = true;
    button.dataset.label = button.dataset.label || button.textContent;
    button.textContent = 'Trying…';
    resetRetry();
    /* Quiet once the workspace is open: a full repaint would wipe a draft. */
    load({ quiet: state.loaded });
  });

  /* Look again every two minutes while someone is looking, as soon as they
     come back to the tab, and as soon as the connection is back. */
  setInterval(refreshIfDue, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', refreshIfDue);

  /* Mail was otherwise read again only after a write, a send or a date
     change — someone reading their inbox waited up to two minutes (the whole
     workspace's own clock) for new mail to show, or for a "Synced … ago"
     label to stop lying. Asked for on its own, more often, but only while
     Mail is the page open and someone is looking at it: everywhere else the
     two-minute clock above already carries it. */
  var MAIL_REFRESH_MS = 45 * 1000;

  function refreshMailIfOpen() {
    if (!authed || running) return;
    if (typeof page === 'undefined' || page !== 'mail') return;
    if (document.visibilityState === 'hidden') return;
    if (arrivedAt.mail != null && Date.now() - arrivedAt.mail < MAIL_REFRESH_MS) return;
    load({ quiet: true, only: ['mail'] });
  }
  setInterval(refreshMailIfOpen, MAIL_REFRESH_MS);
  document.addEventListener('visibilitychange', refreshMailIfOpen);
  window.addEventListener('online', function () {
    if (!authed) return;
    /* Even with a load running: it may be the one that is failing, and the
       next scheduled retry can be five minutes away. load() queues behind it. */
    resetRetry();
    load({ quiet: true });
  });

  /* A tab left open past midnight, or over a weekend, may be holding the wrong
     weeks of events. Only once someone is signed in: before that there is
     nothing loaded to replace, and RLS would hand back empty rows anyway. The
     events loaded stay until the new weeks land: every view places an event by
     its date (agendaModel), so none shows on a day it is not on. */
  CAL.onChange(function () {
    if (!state.loaded) return;
    repaint(true);
    load({ quiet: true });
  });
})();
