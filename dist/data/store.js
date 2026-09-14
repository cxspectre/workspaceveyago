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
 *   contacts   addressed by array position, as they already are
 *
 * Anything that writes goes through workspaceActions with the uuid, so the
 * fragile part (a numeric id in a URL) never leaves the browser.
 */
(function () {
  'use strict';

  /* The events window is CAL.loadFrom – CAL.loadTo (calendar.js): the same
     object the agenda draws its grid from, so the rows loaded and the days
     drawn cannot disagree — including at the weekend, when the grid is the
     week about to start and today sits just before it. */

  function swap(target, rows) {
    target.length = 0;
    for (var i = 0; i < rows.length; i++) target.push(rows[i]);
    return target;
  }

  var state = { loaded: false, loading: false, error: null, overview: null, revenue: [], revenueMix: [] };

  /* A project's shape — known by its id, with its tasks as titles, ticks and
     ids — is projectsModel.shapeProject() in projects-model.js, which is tested. */

  /* Which events window the `events` array holds, as "from|to". The calendar
     can move on without the data: the reload at a date change can fail (a
     laptop waking before its Wi-Fi) or be asked for while another load runs. */
  var loadedWindow = null;
  var windowKey = function () { return CAL.loadFrom + '|' + CAL.loadTo; };

  /* A load asked for while one is running is queued, not dropped: the running
     one may be reading a window that is already out of date. Queued requests
     collapse into one, which is quiet only if every request was. `quiet` means
     a background load — no toast on failure, and the repaint waits for drafts. */
  var running = null;
  var queued = null;

  function load(options) {
    var quiet = !!(options && options.quiet === true);
    if (running) {
      queued = queued
        ? { quiet: queued.quiet && quiet, promise: queued.promise }
        : {
            quiet: quiet,
            promise: running.then(function () {
              var next = queued;
              queued = null;
              return load({ quiet: next.quiet });
            })
          };
      return queued.promise;
    }
    running = loadOnce(quiet).then(function () { running = null; });
    return running;
  }

  async function loadOnce(quiet) {
    state.loading = true;
    state.error = null;
    var key = windowKey();

    try {
      var d = window.workspaceData;

      /* One await for everything the shell needs. Sequential loads make the
         screen assemble itself in pieces, which reads as slow even when the
         total is the same. */
      var results = await Promise.all([
        d.tickets(), d.projects(), d.contacts(), d.team(),
        d.events(CAL.loadFrom, CAL.loadTo), d.invoices(), d.activity(8), loadMail(d),
        d.overview().catch(function () { return null; }),      // managers only
        d.revenueSeries(12).catch(function () { return []; }),  // ditto
        d.revenueMix(1).catch(function () { return []; }),
        d.notes().catch(function () { return []; }),
        /* Every company, contacts or not: what a typed client name is matched to.
           Said out loud when it fails, because matching then falls back to the
           companies contacts happen to carry. */
        d.companies().catch(function (err) {
          console.error('[workspace] companies did not load:', err);
          return [];
        }),
        /* Every project's tasks in one request, grouped by project below. */
        d.allProjectTasks(),
        /* Meetings booked on projects, from today on — not only this week's. */
        d.upcomingProjectEvents().catch(function (err) {
          console.error('[workspace] project meetings did not load:', err);
          return [];
        })
      ]);

      var liveTickets = results[0];
      var liveProjects = results[1];
      var liveContacts = results[2];
      var liveTeam = results[3];
      var liveEvents = results[4];
      var liveInvoices = results[5];
      var liveActivity = results[6];
      var liveMail = results[7].threads;
      state.mailboxes = results[7].mailboxes;
      state.mailTruncated = results[7].truncated;
      state.overview = results[8];
      state.revenue = results[9];
      state.revenueMix = results[10];
      var liveNotes = results[11];
      state.companies = results[12];
      state.projectEvents = results[14];

      var tasksByProject = projectsModel.groupTasks(results[13]);

      swap(tickets, liveTickets);
      swap(projects, liveProjects.map(function (p) {
        return projectsModel.shapeProject(p, tasksByProject[p.id] || []);
      }));
      swap(contacts, liveContacts);
      swap(team, liveTeam);
      swap(invoices, liveInvoices);
      swap(events, liveEvents);
      swap(mails, liveMail);

      /* workspaceActivity is the overview's feed; its shape is {message,time}. */
      swap(workspaceActivity, liveActivity.map(function (a) {
        return { message: a.text, time: a.when, id: a.id };
      }));

      /* The note panels are addressed by (kind, id) — a ticket NUMBER, or a
         position in the projects / contacts / events arrays. The database
         stores a uuid. This is the one place that translation lives, so the
         views keep the keys they already use. */
      var byKind = { tickets: {}, projects: {}, crm: {}, agenda: {} };
      var keyFor = function (note) {
        var i;
        if (note.entityType === 'ticket') {
          var t = liveTickets.filter(function (x) { return x.uuid === note.entityId; })[0];
          return t ? ['tickets', t.id] : null;
        }
        if (note.entityType === 'project') {
          return liveProjects.some(function (p) { return p.id === note.entityId; })
            ? ['projects', note.entityId] : null;
        }
        if (note.entityType === 'contact') {
          i = liveContacts.findIndex(function (c) { return c.id === note.entityId; });
          return i < 0 ? null : ['crm', i];
        }
        /* Events are keyed by uuid, not position: the events window moves by
           itself at a date change, and a position would then name another
           event. */
        if (note.entityType === 'event') {
          var ev = liveEvents.filter(function (e) { return e.id === note.entityId; })[0];
          return ev ? ['agenda', ev.id] : null;
        }
        return null;
      };
      liveNotes.forEach(function (note) {
        var key = keyFor(note);
        if (!key) return;                       // its record is gone or not loaded
        (byKind[key[0]][key[1]] = byKind[key[0]][key[1]] || []).push({
          body: note.body, time: note.time, who: note.who,
          initial: note.initial, id: note.id
        });
      });
      Object.keys(byKind).forEach(function (k) {
        Object.keys(recordNotes[k]).forEach(function (id) { delete recordNotes[k][id]; });
        Object.keys(byKind[k]).forEach(function (id) { recordNotes[k][id] = byKind[k][id]; });
      });

      bodies = {};
      loadedWindow = key;
      state.loaded = true;
      state.loading = false;
      document.body.dispatchEvent(new CustomEvent('workspace:loaded', { detail: state }));
      repaint(quiet);
      /* The date moved while this was in flight, so what landed is already
         the old window. load() queues behind the one still running. */
      if (windowKey() !== key) load({ quiet: true });
    } catch (err) {
      state.loading = false;
      state.error = err;
      console.error('[workspace] could not load:', err);
      document.body.dispatchEvent(new CustomEvent('workspace:load-failed', { detail: err }));
      /* A background load that fails is retried (bottom of this file); a
         toast every minute while offline would tell nobody anything new. */
      if (!quiet && typeof toast === 'function') toast(err.message);
    }
  }

  function repaint(quiet) {
    if (quiet && typeof repaintWhenIdle === 'function') repaintWhenIdle();
    else if (typeof render === 'function') render();
  }

  /* The mailboxes first, then each mailbox's own inbox and sent: one shared
     limit let a busy hello@ push a personal mailbox out of the load. Losing
     the mailbox list degrades to one query per folder across everything,
     rather than taking the rest of the workspace down with it. */
  function loadMail(d) {
    return d.mailboxes()
      .catch(function (err) {
        console.error('[workspace] could not load the mailboxes:', err);
        return [];
      })
      .then(function (boxes) {
        var ids = boxes.map(function (b) { return b.id; });
        return d.mailThreads(['inbox', 'sent'], ids).then(function (result) {
          return { mailboxes: boxes, threads: result.threads, truncated: result.truncated };
        });
      });
  }

  /* Thread bodies, fetched when a thread is opened rather than with the list.
     Cached for the page's lifetime: re-reading a message you just read should
     not be another round trip. */
  var bodies = {};
  var inFlight = {};
  /* A conversation that failed to load. It used to be cached as an empty one,
     which read as "no messages yet" — not true. Held until someone asks for a
     retry, so a render loop cannot turn one failure into a request storm. */
  var failedThreads = {};

  function loadThread(threadId) {
    if (!threadId || bodies[threadId] || inFlight[threadId] || failedThreads[threadId]) return;
    inFlight[threadId] = true;
    window.workspaceData.mailMessages(threadId)
      .then(function (messages) {
        bodies[threadId] = messages;
        /* Put it on the thread object too, so the synchronous render can read
           it without going through the cache. */
        var thread = mails.filter(function (m) { return m.id === threadId; })[0];
        if (thread) {
          var newest = messages[messages.length - 1];
          thread.thread = messages;
          thread.body = newest ? newest.body : '';
          thread.bodyHtml = newest ? newest.bodyHtml : '';
        }
        if (typeof render === 'function') render();
      })
      .catch(function (err) {
        console.error('[workspace] could not load the conversation:', err);
        failedThreads[threadId] = true;
        if (typeof render === 'function') render();
      })
      .then(function () { delete inFlight[threadId]; });
  }

  window.workspaceStore = {
    get state() { return state; },
    load: load,
    /* Everything again, after a write. The workspace stays "loaded" while it
       runs, because what is on screen is still the last good data: a write made
       meanwhile goes to the database rather than to the offline handlers, and a
       reload that fails leaves the data in place instead of an empty page. */
    reload: function () { return load(); },

    /* Views call this after a write so the screen and the database agree
       without a full reload. */
    async after(promise) {
      try {
        var out = await promise;
        await load();
        return out;
      } catch (err) {
        if (typeof toast === 'function') toast(err.message);
        throw err;
      }
    },


    /* The reverse of the grouping above: which record does (kind, id) mean? */
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
        var c = contacts[Number(id)];
        return c ? { type: 'contact', id: c.id } : null;
      }
      if (kind === 'agenda') {
        var e = events.filter(function (ev) { return ev.id === String(id); })[0];
        return e ? { type: 'event', id: e.id } : null;
      }
      return null;
    },

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

    /* Projects are known by id (projects-model.js), never by position. */
    projectById: function (id) { return projectsModel.projectById(projects, String(id || '')); },
    ticketByNumber: function (n) {
      return tickets.filter(function (t) { return t.id === Number(n); })[0] || null;
    }
  };

  document.body.addEventListener('workspace:authed', load);

  /* A tab left open past midnight, or over a weekend, is holding the wrong
     window of events. Only once someone is signed in: before that there is
     nothing loaded to replace, and RLS would hand back empty rows anyway.
     Until the new window lands, keep only the events still inside it — after
     a long sleep the rest would show up under the new week's matching day
     numbers. */
  CAL.onChange(function () {
    if (!state.loaded) return;
    swap(events, events.filter(function (e) { return e.row && CAL.contains(e.row.starts_at); }));
    repaint(true);
    load({ quiet: true });
  });

  /* Retry a window that never arrived: as soon as the connection is back, and
     otherwise once a minute. A load already running is left to finish. */
  var RETRY_MS = 60 * 1000;
  function retryStaleWindow() {
    if (state.loaded && !running && loadedWindow !== windowKey()) load({ quiet: true });
  }
  window.addEventListener('online', retryStaleWindow);
  setInterval(retryStaleWindow, RETRY_MS);
})();
