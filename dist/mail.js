/* mail.js — the Mail view: mailboxes, folders, the conversation list and the
 * reading pane. Replaces the mailView workspace.js used to define.
 *
 * What changed, and why:
 *
 *   Mailboxes. A personal mailbox and hello@veyago.cloud are both connected,
 *   and every thread already records which one it came from — the view merged
 *   them into one inbox under a hardcoded "Demo mailbox" label.
 *
 *   The whole conversation. The reader showed only the newest message, so a
 *   reply that said "see below" had nothing below it.
 *
 *   Read and starred are saved. Opening a thread marks it read in the
 *   database; the star used to flip a property in memory and vanish on reload.
 *
 *   Nothing opens by itself. A thread shown by default would be marked read
 *   without anybody having read it.
 *
 * Anything that does not need a page is in mail-model.js, which is tested.
 */
(function () {
  'use strict';

  const M = mailModel;
  const FOLDER_LABELS = Object.freeze({ inbox: 'Inbox', starred: 'Starred', sent: 'Sent' });
  const SNIPPET_LENGTH = 140;
  const MINUTE = 60 * 1000;

  /* Message ids opened beyond the newest, and threads with a read-write in
     flight. Replaced, never edited, like everything else the view keeps. */
  let expanded = Object.freeze({});
  let markingRead = Object.freeze({});

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const employeeId = () => (window.workspaceSession && workspaceSession.employee && workspaceSession.employee.id) || null;
  const mailboxes = () => M.mailboxesFor(live() ? workspaceStore.state.mailboxes : [], employeeId());
  const threadById = id => mails.find(t => t.id === id) || null;

  /* The store's arrays are shared with every view, so a changed thread goes
     back in as a new object at the same position. */
  function replaceThread(id, changes) {
    const i = mails.findIndex(t => t.id === id);
    if (i < 0) return;
    const current = mails[i];
    mails.splice(i, 1, { ...current, ...changes, row: { ...current.row, ...(changes.row || {}) } });
  }

  function syncedLabel(box) {
    if (!box.live) return box.status === 'needs_reauth' ? 'Needs reconnecting' : 'Not syncing';
    if (!box.lastSyncedAt) return 'Not synced yet';
    const minutes = Math.round((Date.now() - new Date(box.lastSyncedAt).getTime()) / MINUTE);
    if (minutes < 1) return 'Synced just now';
    if (minutes < 60) return `Synced ${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `Synced ${hours} h ago` : `Synced ${Math.round(hours / 24)} d ago`;
  }

  /* ── The folder column ─────────────────────────────────────────────── */

  function mailboxLink(route, mailbox, inner, title) {
    const selected = route.mailbox === mailbox;
    return `<a href="#${M.mailRoute({ mailbox, folder: route.folder })}" class="mailbox-link ${selected ? 'selected' : ''}"`
      + `${selected ? ' aria-current="true"' : ''} title="${esc(title)}">${inner}</a>`;
  }

  const countBadge = n => (n ? `<small class="mail-count">${n}</small>` : '');

  function mailboxColumn(route, boxes) {
    const all = mailboxLink(route, M.ALL,
      `<span class="mailbox-mark all">${icon('mail')}</span>`
      + `<span class="mailbox-name"><strong>All mailboxes</strong><small>${boxes.length} connected</small></span>`
      + countBadge(M.unreadCount(mails, M.ALL)), 'All mailboxes');

    const each = boxes.map(b => mailboxLink(route, b.id,
      `<span class="mailbox-mark ${b.kind}">${esc(b.address.charAt(0).toUpperCase())}</span>`
      + `<span class="mailbox-name"><strong>${esc(b.address)}</strong>`
      + `<small class="${b.live ? '' : 'mailbox-warning'}">${esc(b.live ? b.kindLabel : syncedLabel(b))}</small></span>`
      + countBadge(M.unreadCount(mails, b.id)), b.address)).join('');

    /* Below 1050px the column becomes a row, and a select fits where a list
       of addresses does not. */
    const options = [[M.ALL, 'All mailboxes']].concat(boxes.map(b => [b.id, b.address]));
    const select = `<label class="mailbox-select"><span class="sr-only">Mailbox</span><select data-mailbox-select>`
      + options.map(([value, label]) => `<option value="${esc(value)}"${value === route.mailbox ? ' selected' : ''}>${esc(label)}</option>`).join('')
      + '</select></label>';

    const folders = M.FOLDERS.map(folder => {
      const unread = folder === 'inbox' ? M.unreadCount(mails, route.mailbox) : 0;
      const mark = folder === 'starred' ? '<span class="folder-star" aria-hidden="true">★</span>' : icon(folder === 'sent' ? 'arrow' : 'mail');
      return `<a href="#${M.mailRoute({ mailbox: route.mailbox, folder })}" class="folder-link ${route.folder === folder ? 'selected' : ''}">`
        + `${mark}<span>${FOLDER_LABELS[folder]}</span>${unread ? `<small>${unread}</small>` : ''}</a>`;
    }).join('');

    const box = boxes.find(b => b.id === route.mailbox);
    const foot = box
      ? `<span class="eyebrow">MAILBOX</span><p>${esc(box.address)}</p><small class="${box.live ? '' : 'mailbox-warning'}">${esc(syncedLabel(box))}</small>`
      : boxes.length ? '' : '<span class="eyebrow">MAILBOX</span><p>No mailbox connected</p><small>Mail appears here once one is.</small>';

    return `<aside class="mail-folders"><div class="mailbox-switcher"><span class="eyebrow">MAILBOXES</span>${all}${each}</div>`
      /* A div, not <nav>: the sidebar's `nav a` rules would stack every folder
         into an icon-over-label tile. */
      + `${select}<div class="mail-folder-list" role="navigation" aria-label="Folders">${folders}</div><div class="mail-folder-foot">${foot}</div></aside>`;
  }

  /* ── The conversation list ─────────────────────────────────────────── */

  function threadList(route, list, boxes, shownId) {
    const addressOf = id => (boxes.find(b => b.id === id) || {}).address || '';
    const tagMailbox = route.mailbox === M.ALL && boxes.length > 1;
    const items = list.map(t => {
      const selected = t.id === shownId;
      return `<a href="#${M.mailRoute({ ...route, threadId: t.id })}" class="thread-item${selected ? ' selected' : ''}${t.unread ? ' unread' : ''}"${selected ? ' aria-current="true"' : ''}>`
        + `<div class="mail-item-header"><strong>${t.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}${esc(t.sender)}</strong><small>${esc(t.time)}</small></div>`
        + `<h3>${t.starred ? '<span class="thread-star" aria-label="Starred">★</span> ' : ''}${esc(t.subject)}</h3>`
        + `<p>${esc(t.preview)}</p>${tagMailbox ? `<span class="thread-mailbox">${esc(addressOf(t.mailboxId))}</span>` : ''}</a>`;
    }).join('');
    const where = route.mailbox === M.ALL ? 'All mailboxes' : addressOf(route.mailbox);
    return `<div class="conversation-list"><div class="mail-list-heading"><h2>${FOLDER_LABELS[route.folder]}</h2>`
      + `<small class="mail-list-where">${esc(where)}</small>${queryInput('mail', 'Search mail')}</div>`
      + (items || empty('No conversations', queries.mail.trim() ? 'Nothing matches that search.' : 'This folder is empty.'))
      + `<div class="mail-list-count">${list.length} conversation${list.length === 1 ? '' : 's'}</div></div>`;
  }

  /* ── The reading pane ──────────────────────────────────────────────── */

  const snippet = message => String(message.body || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH) || 'Open to read';

  function messageCard(message, open, newest) {
    const when = (message.date === 'Today' ? '' : esc(message.date) + ' · ') + esc(message.time);
    const avatar = `<div class="avatar${message.outbound ? ' owner' : ''}">${esc(message.initial)}</div>`;
    if (!open) {
      return `<button type="button" class="mail-message collapsed" data-mail-expand="${esc(message.id)}" aria-expanded="false">`
        + `${avatar}<span class="mail-message-summary"><span class="mail-message-line"><strong>${esc(message.sender)}</strong><small>${when}</small></span>`
        + `<span class="mail-message-snippet">${esc(snippet(message))}</span></span></button>`;
    }
    const to = M.recipientLine(message.to);
    const cc = M.recipientLine(message.cc);
    const head = `${avatar}<span class="mail-message-meta"><span class="mail-message-line"><strong>${esc(message.sender)}</strong><small>${when}</small></span>`
      + `<small class="mail-recipients">${esc(message.email)}${to ? ` to ${esc(to)}` : ''}${cc ? ` · cc ${esc(cc)}` : ''}</small></span>`;
    /* The newest message is always open; an older one can be folded again. */
    const header = newest
      ? `<div class="mail-message-head">${head}</div>`
      : `<button type="button" class="mail-message-head" data-mail-expand="${esc(message.id)}" aria-expanded="true">${head}</button>`;
    return `<article class="mail-message">${header}<div class="mail-body">${mailBody(message)}</div></article>`;
  }

  function conversation(thread) {
    const messages = live() ? workspaceStore.threadBody(thread.id) : null;
    if (!messages) return '<p class="quiet-text mail-loading">Loading the conversation…</p>';
    if (!messages.length) return '<p class="quiet-text">This conversation has no messages yet.</p>';
    const newest = messages.length - 1;
    return messages.map((m, i) => messageCard(m, i === newest || Boolean(expanded[m.id]), i === newest)).join('');
  }

  function related(thread) {
    const ticket = thread.ticketId ? tickets.find(t => t.uuid === thread.ticketId) : null;
    const c = thread.contactId ? contacts.findIndex(x => x.id === thread.contactId) : -1;
    if (c < 0 && !ticket) return '';
    return '<div class="reader-related"><span class="eyebrow">CONNECTED TO THIS CONVERSATION</span>'
      + (c >= 0 ? link('crm/' + c, contacts[c].company || contacts[c].name, 'crm', 'related-chip') : '')
      + (ticket ? link('tickets/' + ticket.id, 'VYG-' + ticket.id, 'tickets', 'related-chip') : '')
      + '</div>';
  }

  function reader(thread, boxes, listLength) {
    if (!thread) {
      return `<div class="reader reader-empty">${listLength
        ? empty('Select a conversation', 'It opens here, next to the list.')
        : empty('Nothing to read here', 'Try another folder or mailbox.')}</div>`;
    }
    const box = boxes.find(b => b.id === thread.mailboxId);
    const hasTicket = Boolean(thread.ticketId && tickets.some(t => t.uuid === thread.ticketId));
    const starLabel = thread.starred ? 'Unstar conversation' : 'Star conversation';
    return `<div class="reader" data-thread-id="${esc(thread.id)}"><div class="reader-toolbar">`
      + `<span>${box ? pill(box.address, box.kind === 'personal' ? 'purple' : 'blue') : ''}</span><div class="reader-tools">`
      + `<button class="icon-btn" data-mail-unread="${esc(thread.id)}" title="Mark as unread" aria-label="Mark as unread">${icon('mail')}</button>`
      + `<button class="icon-btn${thread.starred ? ' starred' : ''}" data-mail-star="${esc(thread.id)}" aria-pressed="${thread.starred ? 'true' : 'false'}" title="${starLabel}" aria-label="${starLabel}">${thread.starred ? '★' : '☆'}</button>`
      + `</div></div><div class="reader-content"><h2>${esc(thread.subject)}</h2>`
      + (thread.count > 1 ? `<small class="mail-thread-count">${thread.count} messages</small>` : '')
      + `<div class="mail-conversation">${conversation(thread)}</div><div class="mail-actions">`
      + `<button class="btn btn-primary" data-mail-reply="${esc(thread.id)}">${icon('reply')}Reply</button>`
      + `<button class="btn" data-action="email-ticket" data-thread-id="${esc(thread.id)}">${icon('tickets')}${hasTicket ? 'Open ticket' : 'Create ticket'}</button>`
      + `</div>${related(thread)}</div></div>`;
  }

  /* ── The view ──────────────────────────────────────────────────────── */

  mailView = function () {
    const route = M.parseMailRoute(routeParts);
    const boxes = mailboxes();
    /* A mailbox that is no longer connected (or not loaded yet) falls back
       to all of them rather than to an empty screen. */
    const mailbox = route.mailbox === M.ALL || boxes.some(b => b.id === route.mailbox) ? route.mailbox : M.ALL;
    const current = Object.freeze({ ...route, mailbox });
    const list = M.visibleThreads(mails, { mailbox, folder: route.folder, query: queries.mail });
    /* Open even when a search hides it: the link is what was asked for. */
    const shown = route.threadId ? threadById(route.threadId) : null;

    mailFolder = FOLDER_LABELS[route.folder];              // the breadcrumb reads it
    selectedMail = shown ? mails.indexOf(shown) : 0;       // app.js's contact action still does
    if (shown && shown.unread) markRead(shown);

    return titlebar('Your conversations.', 'Every mailbox you use, in one place.',
        `<button class="btn btn-primary" data-action="compose">${icon('plus')}Compose</button>`)
      + `<section class="panel mail-workspace">${mailboxColumn(current, boxes)}`
      + `${threadList(current, list, boxes, shown && shown.id)}${reader(shown, boxes, list.length)}</section>`;
  };

  /* render() rebuilds #main with innerHTML, which throws away where the list
     and the reader were scrolled. Clicking a thread two hundred rows down
     used to jump the list back to the top. Keep both: the list always, the
     reader while it still shows the same conversation. */
  const baseRender = render;
  render = function () {
    if (page !== 'mail') return baseRender();
    const list = document.querySelector('.conversation-list');
    const pane = document.querySelector('.reader');
    const before = {
      list: list ? list.scrollTop : 0,
      reader: pane ? pane.scrollTop : 0,
      thread: pane ? pane.dataset.threadId : null
    };
    baseRender();
    const nextList = document.querySelector('.conversation-list');
    const nextPane = document.querySelector('.reader');
    if (nextList) nextList.scrollTop = before.list;
    if (nextPane && before.thread && nextPane.dataset.threadId === before.thread) nextPane.scrollTop = before.reader;
  };

  /* ── Writes ────────────────────────────────────────────────────────── */

  function markRead(thread) {
    if (!live() || markingRead[thread.id]) return;
    markingRead = Object.freeze({ ...markingRead, [thread.id]: true });
    workspaceActions.markThreadRead(thread.id, true)
      .then(() => {
        replaceThread(thread.id, { unread: false, row: { is_read: true } });
        repaintWhenIdle();
      })
      .catch(err => console.error('[mail] could not mark the conversation read:', err))
      .then(() => {
        const { [thread.id]: _finished, ...rest } = markingRead;
        markingRead = Object.freeze(rest);
      });
  }

  /* Not optimistic, like the rest of the workspace: the star changes when the
     database says it did. */
  function toggleStar(button) {
    const thread = threadById(button.dataset.mailStar);
    if (!thread || !live()) return;
    const wanted = !thread.starred;
    button.disabled = true;
    workspaceActions.starThread(thread.id, wanted)
      .then(() => {
        replaceThread(thread.id, { starred: wanted, row: { is_starred: wanted } });
        render();
      })
      .catch(err => {
        button.disabled = false;
        toast(err.message || 'That did not save.');
      });
  }

  function markUnread(button) {
    const thread = threadById(button.dataset.mailUnread);
    if (!thread || !live()) return;
    button.disabled = true;
    workspaceActions.markThreadRead(thread.id, false)
      .then(() => {
        replaceThread(thread.id, { unread: true, row: { is_read: false } });
        const route = M.parseMailRoute(routeParts);
        /* Close it, or the open reader would mark it read again at once. */
        navigate(M.mailRoute({ mailbox: route.mailbox, folder: route.folder }));
        toast('Marked as unread');
      })
      .catch(err => {
        button.disabled = false;
        toast(err.message || 'That did not save.');
      });
  }

  /* Still the compose dialog until inline compose replaces it. The reply goes
     to whoever wrote last from outside, not to the thread's last sender — that
     is often us. */
  function replyTo(threadId) {
    const thread = threadById(threadId);
    if (!thread) return;
    const messages = (live() && workspaceStore.threadBody(thread.id)) || [];
    const lastInbound = messages.filter(m => !m.outbound).slice(-1)[0];
    const subject = /^re:/i.test(thread.subject) ? thread.subject : 'Re: ' + thread.subject;
    compose(lastInbound ? lastInbound.email : thread.email, subject);
  }

  document.addEventListener('click', e => {
    if (page !== 'mail' || !e.target.closest) return;
    const star = e.target.closest('[data-mail-star]');
    if (star) { e.preventDefault(); toggleStar(star); return; }
    const unread = e.target.closest('[data-mail-unread]');
    if (unread) { e.preventDefault(); markUnread(unread); return; }
    const reply = e.target.closest('[data-mail-reply]');
    if (reply) { e.preventDefault(); replyTo(reply.dataset.mailReply); return; }
    const toggle = e.target.closest('[data-mail-expand]');
    if (toggle) {
      e.preventDefault();
      const id = toggle.dataset.mailExpand;
      expanded = Object.freeze({ ...expanded, [id]: !expanded[id] });
      render();
    }
  });

  document.addEventListener('change', e => {
    const select = e.target.closest && e.target.closest('[data-mailbox-select]');
    if (!select) return;
    const route = M.parseMailRoute(routeParts);
    navigate(M.mailRoute({ mailbox: select.value, folder: route.folder }));
  });
})();
