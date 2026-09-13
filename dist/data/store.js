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
 *   projects   given a stable index, with the real uuid alongside as `.uuid`
 *   contacts   addressed by array position, as they already are
 *
 * Anything that writes goes through workspaceActions with the uuid, so the
 * fragile part (a numeric id in a URL) never leaves the browser.
 */
(function () {
  'use strict';

  /* The agenda renders a Mon–Fri grid, so the window has to be that week — not
     "today plus seven". In a week that straddles a month (Sep 28 – Oct 2) the
     earlier days are in the past, and a today-forward window would leave them
     blank while the grid still drew them. */
  function weekStart() {
    var now = new Date();
    var dow = (now.getDay() + 6) % 7;                       // 0 = Monday
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow).toISOString();
  }
  function weekEnd() {
    var start = new Date(weekStart());
    /* Through Sunday, so an event on the weekend still loads for the Schedule
       and Day views even though the week grid stops at Friday. */
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7).toISOString();
  }

  function swap(target, rows) {
    target.length = 0;
    for (var i = 0; i < rows.length; i++) target.push(rows[i]);
    return target;
  }

  var state = { loaded: false, loading: false, error: null, overview: null, revenue: [], revenueMix: [] };

  /* A project's tasks render as strings with a parallel list of checked
     indices (taskRows / checkedTasks). Live tasks are rows, so the titles go
     where the strings were and the uuids ride alongside in `taskIds` — which
     is what lets a tick in the UI become an UPDATE. */
  function shapeProject(p, tasks, index) {
    var mine = tasks.filter(function (t) { return t.row.project_id === p.id; });
    return {
      id: index,
      uuid: p.id,
      name: p.name,
      client: p.client,
      initial: p.initial,
      style: p.style,
      progress: p.progress,
      due: p.due,
      status: p.status,
      description: p.description,
      tasks: mine.map(function (t) { return t.title; }),
      taskIds: mine.map(function (t) { return t.id; }),
      checked: mine.reduce(function (acc, t, i) { if (t.done) acc.push(i); return acc; }, [])
    };
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;

    try {
      var d = window.workspaceData;

      /* One await for everything the shell needs. Sequential loads make the
         screen assemble itself in pieces, which reads as slow even when the
         total is the same. */
      var results = await Promise.all([
        d.tickets(), d.projects(), d.contacts(), d.team(),
        d.events(weekStart(), weekEnd()), d.invoices(), d.activity(8), d.mailThreads('inbox'),
        d.overview().catch(function () { return null; }),      // managers only
        d.revenueSeries(12).catch(function () { return []; }),  // ditto
        d.revenueMix(1).catch(function () { return []; }),
        d.notes().catch(function () { return []; })
      ]);

      var liveTickets = results[0];
      var liveProjects = results[1];
      var liveContacts = results[2];
      var liveTeam = results[3];
      var liveEvents = results[4];
      var liveInvoices = results[5];
      var liveActivity = results[6];
      var liveMail = results[7];
      state.overview = results[8];
      state.revenue = results[9];
      state.revenueMix = results[10];
      var liveNotes = results[11];

      /* Tasks for every project in one query rather than one per project. */
      var allTasks = [];
      for (var i = 0; i < liveProjects.length; i++) {
        var rows = await d.projectTasks(liveProjects[i].id);
        allTasks = allTasks.concat(rows);
      }

      swap(tickets, liveTickets);
      swap(projects, liveProjects.map(function (p, idx) {
        return shapeProject(p, allTasks, idx);
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
          i = liveProjects.findIndex(function (p) { return p.id === note.entityId; });
          return i < 0 ? null : ['projects', i];
        }
        if (note.entityType === 'contact') {
          i = liveContacts.findIndex(function (c) { return c.id === note.entityId; });
          return i < 0 ? null : ['crm', i];
        }
        if (note.entityType === 'event') {
          i = liveEvents.findIndex(function (e) { return e.id === note.entityId; });
          return i < 0 ? null : ['agenda', i];
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
      state.loaded = true;
      state.loading = false;
      document.body.dispatchEvent(new CustomEvent('workspace:loaded', { detail: state }));
      if (typeof render === 'function') render();
    } catch (err) {
      state.loading = false;
      state.error = err;
      console.error('[workspace] could not load:', err);
      document.body.dispatchEvent(new CustomEvent('workspace:load-failed', { detail: err }));
      if (typeof toast === 'function') toast(err.message);
    }
  }

  /* Thread bodies, fetched when a thread is opened rather than with the list.
     Cached for the page's lifetime: re-reading a message you just read should
     not be another round trip. */
  var bodies = {};
  var inFlight = {};

  function loadThread(threadId) {
    if (!threadId || bodies[threadId] || inFlight[threadId]) return;
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
        bodies[threadId] = [];
      })
      .then(function () { delete inFlight[threadId]; });
  }

  window.workspaceStore = {
    get state() { return state; },
    load: load,
    reload: function () { state.loaded = false; return load(); },

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
        var p = projects[Number(id)];
        return p ? { type: 'project', id: p.uuid } : null;
      }
      if (kind === 'crm') {
        var c = contacts[Number(id)];
        return c ? { type: 'contact', id: c.id } : null;
      }
      if (kind === 'agenda') {
        var e = events[Number(id)];
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

    projectByIndex: function (index) { return projects[index] || null; },
    ticketByNumber: function (n) {
      return tickets.filter(function (t) { return t.id === Number(n); })[0] || null;
    }
  };

  document.body.addEventListener('workspace:authed', load);
})();
