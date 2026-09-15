/* load-model.js — loading the workspace, with no page in it.
 *
 * The workspace used to load in one Promise.all. One query that failed took
 * every other one down with it; a request that never answered held every later
 * load behind it; and a first load that failed left a page of zeros that looked
 * like an empty studio. store.js now loads each part on its own, with a time
 * limit, and this file holds the rules it follows — how long to wait, what to
 * tell people, when to look again — where they can be tested without a
 * browser: tests/load.test.mjs.
 */
const loadModel = (function () {
  'use strict';

  /* A request that has not answered in this long is not going to. */
  const TIMEOUT_MS = 20000;
  /* How often an open tab that someone is looking at reads everything again. */
  const REFRESH_MS = 120000;
  /* A load that failed is tried again after these, then every five minutes. */
  const RETRY_STEPS_MS = Object.freeze([15000, 30000, 60000, 120000, 300000]);

  const pad = n => String(n).padStart(2, '0');
  const clock = date => pad(date.getHours()) + ':' + pad(date.getMinutes());

  /* Settles as the promise does, or rejects once `ms` have passed. The request
     is not cancelled — it is only no longer waited for. */
  function withTimeout(promise, ms, what) {
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Loading ' + what + ' took too long.')), ms);
    });
    return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
  }

  function joinNames(names) {
    const list = (names || []).filter(Boolean);
    if (list.length <= 1) return list.join('');
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  /* What to tell people about the latest load, or null when all is well.
       missing     labels of the parts that have never loaded
       stale       labels of the parts that loaded before, but not this time
       total       how many parts there are
       everLoaded  whether the workspace has opened before
       coreMissing labels of the parts it cannot open without, never loaded
       staleSince  when what is on screen for the stale parts was loaded
     Before the workspace has opened, a missing core part blocks it — the page
     says "The workspace could not load" above this text. */
  function loadNotice(facts) {
    const f = facts || {};
    const missing = f.missing || [];
    const stale = f.stale || [];
    const coreMissing = f.coreMissing || [];
    if (!missing.length && !stale.length) return null;
    if (!f.everLoaded && (missing.length >= f.total || coreMissing.length)) {
      return Object.freeze({
        kind: 'blocked',
        text: (missing.length >= f.total ? '' : 'Could not load ' + joinNames(coreMissing) + '. ')
          + 'Check your connection, then try again.'
      });
    }
    const parts = [];
    if (missing.length) parts.push('Could not load ' + joinNames(missing) + '.');
    if (stale.length) {
      parts.push('Could not refresh ' + joinNames(stale) +
        (f.staleSince ? ' — showing what loaded at ' + clock(f.staleSince) + '.' : '.'));
    }
    return Object.freeze({ kind: missing.length ? 'partial' : 'stale', text: parts.join(' ') });
  }

  function retryDelay(attempt) {
    const step = Math.min(Math.max(Number(attempt) || 0, 0), RETRY_STEPS_MS.length - 1);
    return RETRY_STEPS_MS[step];
  }

  /* A hidden tab waits: its timers are throttled anyway, and nobody is reading
     it. Coming back to it counts as looking. */
  function refreshDue(facts) {
    const f = facts || {};
    if (!f.visible) return false;
    return f.loadedAt == null || f.now - f.loadedAt >= REFRESH_MS;
  }

  return Object.freeze({
    TIMEOUT_MS, REFRESH_MS,
    withTimeout, joinNames, loadNotice, retryDelay, refreshDue, clock
  });
})();
