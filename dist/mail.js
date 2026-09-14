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

  /* Message ids opened beyond the newest; threads with a read-write in flight,
     or one that failed since the last load; email bodies already sanitised.
     Replaced, never edited, like everything else the view keeps. */
  let expanded = Object.freeze({});
  /* Whether the reading pane has the whole width, folders and list set aside. */
  let readerExpanded = false;
  let markingRead = Object.freeze({});
  let readFailed = Object.freeze({});
  let renderedBodies = Object.freeze({});

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const employeeId = () => (window.workspaceSession && workspaceSession.employee && workspaceSession.employee.id) || null;
  const mailboxes = () => M.mailboxesFor(live() ? workspaceStore.state.mailboxes : [], employeeId());
  const threadById = id => mails.find(t => t.id === id) || null;
  /* "Show images" is decided per message, and showing them in one message no
     longer hides them again in another. workspace.js's handler adds to this. */
  const imagesShown = id => (window.__mailShowImages || []).includes(id);
  /* microsoft-connect is for managers, so the button is only offered to them. */
  const canReconnect = () => Boolean(window.workspaceSession && workspaceSession.isManager && workspaceSession.isManager());

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

  function connectionRow(box) {
    const button = canReconnect()
      ? `<button type="button" class="btn mailbox-reconnect" data-mail-reconnect="${esc(box.id)}">Reconnect</button>`
      : '';
    return `<div class="mailbox-connection"><p>${esc(box.address)}</p>`
      + `<small class="${box.live ? '' : 'mailbox-warning'}">${esc(syncedLabel(box))}</small>${button}</div>`;
  }

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
      ? `<span class="eyebrow">MAILBOX</span>${connectionRow(box)}`
      : !boxes.length ? '<span class="eyebrow">MAILBOX</span><p>No mailbox connected</p><small>Mail appears here once one is.</small>'
      /* A manager sees every mailbox's connection here, so reconnecting one —
         to grant a permission added since, say — is a click from any view. */
      : canReconnect() ? `<span class="eyebrow">CONNECTIONS</span>${boxes.map(connectionRow).join('')}` : '';

    const newMessage = `<button class="btn btn-primary mail-new" data-action="compose">${icon('plus')}`
      + `${mailComposer.isOpen() ? 'Continue draft' : 'New message'}</button>`;
    return `<aside class="mail-folders">${newMessage}<div class="mailbox-switcher"><span class="eyebrow">MAILBOXES</span>${all}${each}</div>`
      /* A div, not <nav>: the sidebar's `nav a` rules would stack every folder
         into an icon-over-label tile. */
      + `${select}<div class="mail-folder-list" role="navigation" aria-label="Folders">${folders}</div><div class="mail-folder-foot">${foot}</div></aside>`;
  }

  /* ── The conversation list ─────────────────────────────────────────── */

  /* Each mailbox's folders load up to a limit (queries.js). When the one on
     screen hit it, say so, rather than let the list pass for everything. */
  function truncatedNote(route) {
    const keys = (live() && workspaceStore.state.mailTruncated) || [];
    const folders = route.folder === 'starred' ? ['inbox', 'sent'] : [route.folder];
    const cut = keys.some(key => {
      const [box, folder] = key.split('|');
      return folders.includes(folder) && (route.mailbox === M.ALL || box === 'all' || box === route.mailbox);
    });
    return cut ? '<div class="mail-list-truncated">Showing the most recent conversations only.</div>' : '';
  }

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
      + `<div class="mail-list-count">${list.length} conversation${list.length === 1 ? '' : 's'}</div>${truncatedNote(route)}</div>`;
  }

  /* ── The reading pane ──────────────────────────────────────────────── */

  const snippet = message => String(message.body || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH) || 'Open to read';

  /* DOMPurify on every render of every open message made each keystroke in
     the search box re-sanitise a whole conversation. A message's body never
     changes, so its rendering is kept per image choice. */
  function bodyHtml(message) {
    const key = message.id + (imagesShown(message.id) ? '|images' : '|blocked');
    if (!(key in renderedBodies)) renderedBodies = Object.freeze({ ...renderedBodies, [key]: mailBody(message) });
    return renderedBodies[key];
  }

  function messageCard(message, open, newest, threadId) {
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
    /* Answer this message — not whichever came in last, which may be an
       out-of-office or a bounce. */
    const answers = [['reply', 'Reply'], ['replyAll', 'Reply all'], ['forward', 'Forward']].map(([mode, label]) =>
      `<button type="button" class="text-btn" data-mail-answer="${mode}" data-thread-id="${esc(threadId)}" data-message-id="${esc(message.id)}">${label}</button>`).join('');
    return `<article class="mail-message">${header}<div class="mail-body">${bodyHtml(message)}</div>`
      + `<div class="mail-message-actions">${answers}</div></article>`;
  }

  function conversation(thread) {
    if (!live()) return '';
    /* A failed load used to be cached as an empty conversation: "Loading…"
       for a while, then "no messages yet", which was not true. */
    if (workspaceStore.threadFailed(thread.id)) {
      return `<div class="mail-load-failed"><p>This conversation did not load.</p>`
        + `<button class="btn" data-mail-retry="${esc(thread.id)}">Try again</button></div>`;
    }
    const messages = workspaceStore.threadBody(thread.id);
    if (!messages) return '<p class="quiet-text mail-loading">Loading the conversation…</p>';
    if (!messages.length) return '<p class="quiet-text">This conversation has no messages yet.</p>';
    const newest = messages.length - 1;
    return messages.map((m, i) => messageCard(m, i === newest || Boolean(expanded[m.id]), i === newest, thread.id)).join('');
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

  /* A draft with nowhere else to be shown: a new message, or an answer whose
     conversation has left the list — archived in Outlook, or past the newest
     the list holds — rather than a draft nobody can get back to. */
  const draftWithoutThread = () => mailComposer.isOpen()
    && (mailComposer.mode() === 'new' || !threadById(mailComposer.threadId()));

  function expandButton(expanded) {
    const label = expanded ? 'Show folders and conversations' : 'Use the full width';
    return `<button class="icon-btn" data-mail-expand-reader aria-pressed="${expanded ? 'true' : 'false'}"`
      + ` title="${label}" aria-label="${label}">${expanded ? '⤡' : '⤢'}</button>`;
  }

  function reader(thread, boxes, listLength, expanded) {
    if (!thread) {
      /* A new message is written where a conversation would be read. */
      if (draftWithoutThread()) {
        const note = mailComposer.mode() === 'new' ? ''
          : '<small class="quiet-text">This conversation is no longer in Inbox or Sent. The answer still goes to it.</small>';
        return `<div class="reader reader-compose"><div class="reader-toolbar"><span>${note}</span><div class="reader-tools">${expandButton(expanded)}</div></div>`
          + '<div class="reader-content"><div data-composer-slot></div></div></div>';
      }
      return `<div class="reader reader-empty">${listLength
        ? empty('Select a conversation', 'It opens here, next to the list.')
        : empty('Nothing to read here', 'Try another folder or mailbox.')}</div>`;
    }
    const box = boxes.find(b => b.id === thread.mailboxId);
    const hasTicket = Boolean(thread.ticketId && tickets.some(t => t.uuid === thread.ticketId));
    const starLabel = thread.starred ? 'Unstar conversation' : 'Star conversation';
    return `<div class="reader" data-thread-id="${esc(thread.id)}"><div class="reader-toolbar">`
      + `<span>${box ? pill(box.address, box.kind === 'personal' ? 'purple' : 'blue') : ''}</span><div class="reader-tools">${expandButton(expanded)}`
      + `<button class="icon-btn" data-mail-unread="${esc(thread.id)}" title="Mark as unread" aria-label="Mark as unread">${icon('mail')}</button>`
      + `<button class="icon-btn${thread.starred ? ' starred' : ''}" data-mail-star="${esc(thread.id)}" aria-pressed="${thread.starred ? 'true' : 'false'}" title="${starLabel}" aria-label="${starLabel}">${thread.starred ? '★' : '☆'}</button>`
      + `</div></div><div class="reader-content"><h2>${esc(thread.subject)}</h2>`
      + (thread.count > 1 ? `<small class="mail-thread-count">${thread.count} messages</small>` : '')
      /* An answer being written sits above the conversation, where it is seen. */
      + (mailComposer.threadId() === thread.id ? '<div data-composer-slot></div>' : '')
      + `<div class="mail-conversation">${conversation(thread)}</div><div class="mail-actions">`
      + `<button class="btn btn-primary" data-mail-answer="reply" data-thread-id="${esc(thread.id)}">${icon('reply')}Reply</button>`
      + `<button class="btn" data-mail-answer="replyAll" data-thread-id="${esc(thread.id)}">Reply all</button>`
      + `<button class="btn" data-mail-answer="forward" data-thread-id="${esc(thread.id)}">${icon('arrow')}Forward</button>`
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

    selectedMail = shown ? mails.indexOf(shown) : 0;       // app.js's contact action still reads it
    if (shown && shown.unread) markRead(shown);

    /* Full screen, so no page heading: the one thing it carried, writing a new
       message, is at the top of the folders. The full width is only kept while
       there is something to read or write in it. */
    const expanded = readerExpanded && Boolean(shown || draftWithoutThread());
    return `<section class="panel mail-workspace${expanded ? ' reader-expanded' : ''}">${mailboxColumn(current, boxes)}`
      + `${threadList(current, list, boxes, shown && shown.id)}${reader(shown, boxes, list.length, expanded)}</section>`;
  };

  /* render() rebuilds #main with innerHTML, which throws away where the list
     and the reader were scrolled. Clicking a thread two hundred rows down
     used to jump the list back to the top. Keep both: the list always, the
     reader while it still shows the same conversation.
     The breadcrumb is written BEFORE the view runs, so the folder it names is
     set here rather than inside mailView, where it arrived one render late. */
  const baseRender = render;
  render = function () {
    document.body.classList.toggle('mail-mode', page === 'mail');
    if (page !== 'mail') return baseRender();
    mailFolder = FOLDER_LABELS[M.parseMailRoute(routeParts).folder];
    const list = document.querySelector('.conversation-list');
    const pane = document.querySelector('.reader');
    const before = {
      list: list ? list.scrollTop : 0,
      reader: pane ? pane.scrollTop : 0,
      thread: pane ? pane.dataset.threadId : null
    };
    mailComposer.beforeRender();
    try {
      baseRender();
    } finally {
      mailComposer.afterRender();
    }
    const nextList = document.querySelector('.conversation-list');
    const nextPane = document.querySelector('.reader');
    if (nextList) nextList.scrollTop = before.list;
    if (nextPane && before.thread && nextPane.dataset.threadId === before.thread) nextPane.scrollTop = before.reader;
  };

  /* ── Writes ────────────────────────────────────────────────────────── */

  /* A failed mark-read is not retried on every render — typing in the search
     box would send one request per keystroke. The next load clears it. */
  /* update-mail-state saved the change here but Outlook did not get it —
     usually a mailbox connected before Mail.ReadWrite. Said once per page
     load: opening every conversation would otherwise repeat it. */
  let outlookWarned = false;
  function warnIfOutlookMissed(result) {
    if (outlookWarned || !result || result.outlook !== false || !result.reason) return;
    outlookWarned = true;
    toast(result.reason);
  }

  function markRead(thread) {
    if (!live() || markingRead[thread.id] || readFailed[thread.id]) return;
    markingRead = Object.freeze({ ...markingRead, [thread.id]: true });
    workspaceActions.markThreadRead(thread.id, true)
      .then(result => {
        replaceThread(thread.id, { unread: false, row: { is_read: true } });
        repaintWhenIdle();
        warnIfOutlookMissed(result);
      })
      .catch(err => {
        console.error('[mail] could not mark the conversation read:', err);
        readFailed = Object.freeze({ ...readFailed, [thread.id]: true });
      })
      .then(() => {
        const { [thread.id]: _finished, ...rest } = markingRead;
        markingRead = Object.freeze(rest);
      });
  }

  document.body.addEventListener('workspace:loaded', () => { readFailed = Object.freeze({}); });

  /* Not optimistic, like the rest of the workspace: the star changes when the
     database says it did. */
  function toggleStar(button) {
    const thread = threadById(button.dataset.mailStar);
    if (!thread || !live()) return;
    const wanted = !thread.starred;
    button.disabled = true;
    workspaceActions.starThread(thread.id, wanted)
      .then(result => {
        replaceThread(thread.id, { starred: wanted, row: { is_starred: wanted } });
        render();
        warnIfOutlookMissed(result);
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
      .then(result => {
        replaceThread(thread.id, { unread: true, row: { is_read: false } });
        const route = M.parseMailRoute(routeParts);
        /* Close it, or the open reader would mark it read again at once. */
        navigate(M.mailRoute({ mailbox: route.mailbox, folder: route.folder }));
        toast('Marked as unread');
        warnIfOutlookMissed(result);
      })
      .catch(err => {
        button.disabled = false;
        toast(err.message || 'That did not save.');
      });
  }

  /* ── Writing ───────────────────────────────────────────────────────── */

  /* Addresses that are us: never among an answer's recipients, never offered
     as a suggestion. */
  const ownAddresses = () => mailboxes().map(b => b.address)
    .concat(window.workspaceSession && workspaceSession.employee && workspaceSession.employee.email
      ? [workspaceSession.employee.email] : []);

  function composerContext() {
    return {
      boxes: mailboxes(),
      book: M.addressBook(contacts, mails, ownAddresses()),
      canReconnect: canReconnect(),
      onSent: afterSend,
      onClose: () => { if (page === 'mail') render(); }
    };
  }

  /* Takes the person to the draft: the conversation it answers, or the reading
     pane of the mailbox they were in for a new message. */
  function showDraft() {
    const route = M.parseMailRoute(page === 'mail' ? routeParts : []);
    const thread = mailComposer.threadId() ? threadById(mailComposer.threadId()) : null;
    navigate(M.mailRoute({
      mailbox: route.mailbox,
      folder: thread ? thread.folder : route.folder,
      threadId: thread ? thread.id : null
    }));
    /* After the render has put the draft on screen. Not requestAnimationFrame:
       a tab in the background may never run it. */
    setTimeout(() => mailComposer.focus(), 0);
  }

  /* Every "write an email" in the workspace — the Compose button, a contact's
     address — opens the draft here, in the reading pane, not in a window. A
     draft in progress is shown rather than replaced. */
  compose = function (to = '', subject = '', body = '') {
    const asked = Boolean(to || subject || body);
    if (mailComposer.isOpen() && (!asked || mailComposer.hasContent())) {
      if (asked) toast('Finish or discard the message you are writing first.');
      showDraft();
      return;
    }
    if (!live()) { toast('Mail is still loading.'); return; }
    const boxes = mailboxes();
    if (!boxes.length) { toast('Connect a mailbox to send mail from the workspace.'); return; }
    const route = M.parseMailRoute(page === 'mail' ? routeParts : []);
    const from = boxes.find(b => b.id === route.mailbox) || boxes[0];
    const opened = mailComposer.open({
      mode: 'new', connectionId: from.id, to: M.parseAddresses(to).valid, subject, bodyText: body
    }, composerContext());
    if (!opened) { toast('Wait for the message being sent to finish.'); return; }
    showDraft();
  };

  /* messageId: answer that message; without it, the newest from outside. */
  function answer(mode, threadId, messageId) {
    const thread = threadById(threadId);
    if (!thread) return;
    if (mailComposer.isOpen() && (mailComposer.hasContent() || mailComposer.isSending())) {
      toast(mailComposer.isSending() ? 'Wait for the message being sent to finish.' : 'Finish or discard the message you are writing first.');
      showDraft();
      return;
    }
    const messages = live() ? workspaceStore.threadBody(thread.id) : null;
    if (!messages) { toast('The conversation is still loading. Try again in a moment.'); return; }
    const recipients = M.answerFor(messages, mode, ownAddresses(), messageId || undefined);
    if (!recipients) return;
    /* The subject of the message being answered, not the list's label for it:
       a conversation without one is shown as "(no subject)", which is not a
       subject to reply to. */
    const original = messages.find(m => m.id === recipients.messageId);
    const when = original ? `${original.date === 'Today' ? '' : `${original.date} `}${original.time}` : '';
    const opened = mailComposer.open({
      mode, connectionId: thread.mailboxId, threadId: thread.id, messageId: recipients.messageId,
      to: recipients.to, cc: recipients.cc,
      subject: M.subjectFor(mode, original ? original.subject : thread.subject),
      about: original ? `${mode === 'forward' ? 'Forwarding' : 'Replying to'} ${original.sender} · ${when}` : ''
    }, composerContext());
    if (!opened) { toast('Wait for the message being sent to finish.'); return; }
    render();
    setTimeout(() => mailComposer.focus(), 0);
  }

  /* Sent: re-read what changed, and show the conversation the message is in. */
  function afterSend(result, sent) {
    toast(sent.from ? `Sent from ${sent.from}.` : 'Sent.');
    Promise.resolve(workspaceStore.reload()).then(() => {
      if (page !== 'mail') return;
      const thread = result && result.threadId ? threadById(result.threadId) : null;
      if (!thread) {
        if (!(result && result.threadId)) toast('Sent. It shows in the conversation after the next sync.');
        render();
        return;
      }
      navigate(M.mailRoute({ mailbox: M.parseMailRoute(routeParts).mailbox, folder: thread.folder, threadId: thread.id }));
    });
  }

  window.addEventListener('beforeunload', e => {
    if (!mailComposer.hasContent()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* Reconnecting asks Microsoft again, with the permissions the app has now: a
     permission added since a mailbox was connected (Mail.ReadWrite) arrives
     only with a new consent. The consent page opens in a new tab, reserved on
     the click itself so the browser does not block it as a pop-up. Coming back
     to this tab re-reads the mailboxes. */
  let reconnecting = false;

  function reconnect(button) {
    const box = mailboxes().find(b => b.id === button.dataset.mailReconnect);
    if (!box || !live()) return;
    const tab = window.open('', '_blank');
    if (tab) tab.document.title = 'Connecting to Microsoft…';
    button.disabled = true;
    workspaceActions.reconnectMailbox(box.address)
      .then(url => {
        reconnecting = true;
        if (!tab) { window.location.assign(url); return; }
        tab.opener = null;
        tab.location.href = url;
        toast(`Finish in the Microsoft tab. ${box.address} updates when you come back.`);
      })
      .catch(err => {
        if (tab) tab.close();
        toast(err.message || 'Reconnecting could not start.');
      })
      .then(() => { button.disabled = false; });
  }

  function backFromMicrosoft() {
    if (!reconnecting || document.visibilityState !== 'visible' || !window.workspaceStore) return;
    reconnecting = false;
    Promise.resolve(workspaceStore.reload()).then(() => { if (page === 'mail') render(); });
  }
  window.addEventListener('focus', backFromMicrosoft);
  document.addEventListener('visibilitychange', backFromMicrosoft);

  document.addEventListener('click', e => {
    if (page !== 'mail' || !e.target.closest) return;
    const reconnectButton = e.target.closest('[data-mail-reconnect]');
    if (reconnectButton) { e.preventDefault(); reconnect(reconnectButton); return; }
    const star = e.target.closest('[data-mail-star]');
    if (star) { e.preventDefault(); toggleStar(star); return; }
    const unread = e.target.closest('[data-mail-unread]');
    if (unread) { e.preventDefault(); markUnread(unread); return; }
    if (e.target.closest('[data-mail-expand-reader]')) {
      e.preventDefault();
      readerExpanded = !readerExpanded;
      render();
      return;
    }
    const answerButton = e.target.closest('[data-mail-answer]');
    if (answerButton) {
      e.preventDefault();
      answer(answerButton.dataset.mailAnswer, answerButton.dataset.threadId, answerButton.dataset.messageId);
      return;
    }
    const retry = e.target.closest('[data-mail-retry]');
    if (retry) { e.preventDefault(); workspaceStore.retryThread(retry.dataset.mailRetry); render(); return; }
    const toggle = e.target.closest('[data-mail-expand]');
    if (toggle) {
      e.preventDefault();
      const id = toggle.dataset.mailExpand;
      expanded = Object.freeze({ ...expanded, [id]: !expanded[id] });
      render();
    }
  });

  /* Escape gives the folders and the list back. */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || page !== 'mail' || !readerExpanded) return;
    if (document.querySelector('#modal').open) return;
    /* Escape while writing belongs to the writing — a spellcheck or suggestion
       popup — not to the layout. */
    if (e.target.closest && e.target.closest('.composer')) return;
    readerExpanded = false;
    render();
  });

  document.addEventListener('change', e => {
    const select = e.target.closest && e.target.closest('[data-mailbox-select]');
    if (!select) return;
    const route = M.parseMailRoute(routeParts);
    navigate(M.mailRoute({ mailbox: select.value, folder: route.folder }));
  });

  /* workspace.js navigates to the starting route before this file runs, so a
     link straight to mail was painted by the old view. Paint it with this one. */
  if (page === 'mail') render();
})();
