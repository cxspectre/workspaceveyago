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
  /* Whatever the list on screen is showing right now — the loaded folder, or
     a search's own results — for next/previous navigation and Mark all as
     read: both act on exactly what a person sees, not a value recomputed
     from routeParts that might disagree with it by the time a key is
     pressed. Set once, at the top of every render (mailView). */
  let currentThreadList = Object.freeze([]);
  /* An inline image's own bytes, once fetched: keyed by message id + Content-ID,
     never by attachment id alone — two different messages can each carry an
     image with the same cid, and this must not show one's logo on the other's.
     Resolved and pending are kept apart so a slow fetch is not asked for twice
     while it is still in flight; failed is separate again, so one Graph will
     not serve any more (a message that has since moved or been deleted) is not
     retried on every idle repaint until the page is reloaded. */
  let inlineImages = Object.freeze({});
  let inlineImagesPending = Object.freeze({});
  let inlineImagesFailed = Object.freeze({});

  const live = () => Boolean(window.workspaceStore && workspaceStore.state.loaded);
  const employeeId = () => (window.workspaceSession && workspaceSession.employee && workspaceSession.employee.id) || null;
  const mailboxes = () => M.mailboxesFor(live() ? workspaceStore.state.mailboxes : [], employeeId());
  const threadById = id => mails.find(t => t.id === id) || null;
  /* "Show images" is decided per message, and showing them in one message no
     longer hides them again in another. workspace.js's handler adds to this. */
  const imagesShown = id => (window.__mailShowImages || []).includes(id);
  /* Who may reconnect a mailbox, as microsoft-connect decides it: owners and
     admins the studio's, and anyone their own. mailboxesFor() lists no
     colleague's, so a personal mailbox here is this person's own. */
  const canReconnect = box => (Boolean(box) && box.kind === 'personal')
    || Boolean(window.workspaceSession && workspaceSession.isManager && workspaceSession.isManager());

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

  /* An unread count as a screen reader can use it too: the number stays the
     visible content, "unread" (and, past the cap, "or more") rides along as
     text a sighted person never sees rather than only living in a colour. */
  function unreadBadge(info, className) {
    if (!info.count) return '';
    const cls = className ? ` class="${className}"` : '';
    const word = info.atLeast ? ' unread, or more' : ' unread';
    return `<small${cls}>${info.count}${info.atLeast ? '+' : ''}<span class="sr-only">${word}</span></small>`;
  }

  function connectionRow(box) {
    /* Every Reconnect button said only "Reconnect": fine with one on screen,
       indistinguishable read out one after another when Connections lists
       several. The visible word stays short; the name a screen reader gets
       says which mailbox. The same rule (studio needs a manager, a personal
       one needs to be your own — mailboxesFor() already guarantees any
       "personal" box reaching this is this person's own) is what 0055
       widened disconnecting to as well, so one `eligible` check gates both
       buttons. */
    const eligible = canReconnect(box);
    const reconnectButton = eligible
      ? `<button type="button" id="mail-reconnect-${esc(box.id)}" class="btn mailbox-reconnect" data-mail-reconnect="${esc(box.id)}" aria-label="Reconnect ${esc(box.address)}">Reconnect</button>`
      : '';
    const disconnectButton = eligible
      ? `<button type="button" id="mail-disconnect-${esc(box.id)}" class="btn mailbox-disconnect" data-mail-disconnect="${esc(box.id)}" aria-label="Disconnect ${esc(box.address)}">Disconnect</button>`
      : '';
    const actions = eligible ? `<div class="mailbox-connection-actions">${reconnectButton}${disconnectButton}</div>` : '';
    /* Why a mailbox is in trouble — or what a working one went on without —
       rather than "Not syncing" alone. */
    const note = M.mailboxNote(box);
    return `<div class="mailbox-connection"><p>${esc(box.address)}</p>`
      + `<small class="${box.live ? '' : 'mailbox-warning'}">${esc(syncedLabel(box))}</small>`
      + (note ? `<small class="mailbox-note" title="${esc(box.lastError)}">${esc(note)}</small>` : '')
      + `${actions}</div>`;
  }

  function mailboxColumn(route, boxes) {
    const truncated = (live() && workspaceStore.state.mailTruncated) || [];
    /* The true count (mail_unread_counts(), 0062), once the database has
       answered: every unreadCountInfo() call below prefers it outright over
       the floor-based guess, so every badge here — All mailboxes, each own
       mailbox, and the Inbox folder link further down — stops undercounting
       the moment it lands, with nothing else here needing to change. */
    const trueCounts = live() ? workspaceStore.state.mailUnreadCounts : null;
    const all = mailboxLink(route, M.ALL,
      `<span class="mailbox-mark all">${icon('mail')}</span>`
      + `<span class="mailbox-name"><strong>All mailboxes</strong><small>${boxes.length} connected</small></span>`
      + unreadBadge(M.unreadCountInfo(mails, M.ALL, truncated, trueCounts), 'mail-count'), 'All mailboxes');

    const each = boxes.map(b => mailboxLink(route, b.id,
      `<span class="mailbox-mark ${b.kind}">${esc(b.address.charAt(0).toUpperCase())}</span>`
      + `<span class="mailbox-name"><strong>${esc(b.address)}</strong>`
      + `<small class="${b.live ? '' : 'mailbox-warning'}">${esc(b.live ? b.kindLabel : syncedLabel(b))}</small></span>`
      + unreadBadge(M.unreadCountInfo(mails, b.id, truncated, trueCounts), 'mail-count'), b.address)).join('');

    /* Below 1050px the column becomes a row, and a select fits where a list
       of addresses does not. */
    const options = [[M.ALL, 'All mailboxes']].concat(boxes.map(b => [b.id, b.address]));
    const select = `<label class="mailbox-select"><span class="sr-only">Mailbox</span><select data-mailbox-select>`
      + options.map(([value, label]) => `<option value="${esc(value)}"${value === route.mailbox ? ' selected' : ''}>${esc(label)}</option>`).join('')
      + '</select></label>';

    const folders = M.FOLDERS.map(folder => {
      const info = folder === 'inbox' ? M.unreadCountInfo(mails, route.mailbox, truncated, trueCounts) : { count: 0, atLeast: false };
      const mark = folder === 'starred' ? '<span class="folder-star" aria-hidden="true">★</span>' : icon(folder === 'sent' ? 'arrow' : 'mail');
      return `<a href="#${M.mailRoute({ mailbox: route.mailbox, folder })}" class="folder-link ${route.folder === folder ? 'selected' : ''}">`
        + `${mark}<span>${FOLDER_LABELS[folder]}</span>${unreadBadge(info)}</a>`;
    }).join('');

    const box = boxes.find(b => b.id === route.mailbox);
    /* Losing the mailbox LIST is not the same as there being no mailbox: the
       first tries again by itself, and the second is fixed by connecting
       one. Conflating them used to send someone to Connect a mailbox that was
       already connected — only its list had failed to load. */
    const mailboxesFailed = live() && Boolean(workspaceStore.state.mailboxesFailed);
    const foot = box
      ? `<span class="eyebrow">MAILBOX</span>${connectionRow(box)}`
      : !boxes.length ? (mailboxesFailed
        ? '<span class="eyebrow">MAILBOX</span><p>Mailboxes did not load</p><small>It tries again by itself.</small>'
        : live() && !workspaceStore.has('mail')
          ? '<span class="eyebrow">MAILBOX</span><p>Mail did not load</p><small>It tries again by itself.</small>'
          : '<span class="eyebrow">MAILBOX</span><p>No mailbox connected</p><small>Mail appears here once one is.</small>')
      /* Every mailbox this person may reconnect shows its connection here, so
         reconnecting one — to grant a permission added since, say — is a click
         from any view. */
      : boxes.some(canReconnect)
        ? `<span class="eyebrow">CONNECTIONS</span>${boxes.filter(canReconnect).map(connectionRow).join('')}` : '';

    /* Connecting a brand NEW mailbox — not reconnecting one already there —
       is an owner or admin's to do, the same rule microsoft-connect already
       enforces for a calendar (agenda-ui.js's own "Connect a calendar"
       mirrors this identically): whoever it is for, the button itself is
       manager-only, since a plain member of staff who wants their own first
       mailbox connected still needs one to say whose it is. */
    const canConnect = Boolean(window.workspaceSession && workspaceSession.isManager && workspaceSession.isManager());
    const connectButton = canConnect
      ? `<button type="button" id="mail-connect-button" class="btn mailbox-connect" data-mail-connect="">Connect a mailbox</button>` : '';

    const newMessage = `<button class="btn btn-primary mail-new" data-action="compose">${icon('plus')}`
      + `${mailComposer.isOpen() ? 'Continue draft' : 'New message'}</button>`;
    return `<aside class="mail-folders">${newMessage}<div class="mailbox-switcher"><span class="eyebrow">MAILBOXES</span>${all}${each}</div>`
      /* A div, not <nav>: the sidebar's `nav a` rules would stack every folder
         into an icon-over-label tile. */
      + `${select}<div class="mail-folder-list" role="navigation" aria-label="Folders">${folders}</div><div class="mail-folder-foot">${foot}${connectButton}</div></aside>`;
  }

  /* ── The conversation list ─────────────────────────────────────────── */

  /* Mail mode hides the context bar, where the workspace says a part did not
     load or refresh — so the same words go at the top of the list. */
  function loadNote() {
    const notice = window.workspaceStore && workspaceStore.state.notice;
    if (!notice || notice.kind === 'blocked') return '';
    return `<div class="mail-list-truncated mail-load-note"><span role="status">${esc(notice.text)}</span>`
      + '<button type="button" class="text-btn" data-load-retry>Retry</button></div>';
  }

  /* Each mailbox's folders load up to a limit (queries.js). When the one on
     screen hit it, say so, rather than let the list pass for everything. */
  function truncatedNote(route) {
    const truncated = (live() && workspaceStore.state.mailTruncated) || [];
    /* Starred is drawn from all three loads, the filed-and-starred one among them. */
    const folders = route.folder === 'starred' ? ['inbox', 'sent', 'starred'] : [route.folder];
    return M.isTruncated(truncated, route.mailbox, folders)
      ? '<div class="mail-list-truncated">Showing the most recent conversations only.</div>' : '';
  }

  /* Every unread thread in `list` — whatever a person watching the screen
     right now would call "all": this folder, this mailbox — never wider. */
  function markAllReadButton(list) {
    return list.some(t => t.unread)
      ? '<button type="button" id="mail-mark-all-read" class="text-btn mail-mark-all-read" data-mail-mark-all-read="">Mark all as read</button>' : '';
  }

  function threadList(route, list, boxes, shownId, more) {
    const addressOf = id => (boxes.find(b => b.id === id) || {}).address || '';
    const tagMailbox = route.mailbox === M.ALL && boxes.length > 1;
    const items = list.map(t => {
      const selected = t.id === shownId;
      /* Unread and starred were said only in colour — a dot and a filled
         star. One sr-only phrase ahead of the sender says both in words, so
         the icons themselves can stay decorative (aria-hidden). */
      const states = [t.unread && 'Unread', t.starred && 'Starred'].filter(Boolean);
      const stateText = states.length ? `<span class="sr-only">${states.join('. ')}. </span>` : '';
      return `<a id="mail-thread-${esc(t.id)}" href="#${M.mailRoute({ ...route, threadId: t.id })}" class="thread-item${selected ? ' selected' : ''}${t.unread ? ' unread' : ''}"${selected ? ' aria-current="true"' : ''}>`
        + `<div class="mail-item-header"><strong>${stateText}${t.unread ? '<span class="unread-dot" aria-hidden="true"></span>' : ''}${esc(t.sender)}</strong><small>${esc(t.time)}</small></div>`
        + `<h3>${t.starred ? '<span class="thread-star" aria-hidden="true">★</span> ' : ''}${esc(t.subject)}</h3>`
        + `<p>${esc(t.preview)}</p>${tagMailbox ? `<span class="thread-mailbox">${esc(addressOf(t.mailboxId))}</span>` : ''}</a>`;
    }).join('');
    const where = route.mailbox === M.ALL ? 'All mailboxes' : addressOf(route.mailbox);
    /* "Load more" (0062's own audit item, "No way to load older mail"): a
       page further back than mailThreads()'s own 200-per-folder window,
       appended by store.js's loadMoreMail — never shown while searching,
       where every match already comes back in one answer. Hidden once a
       page comes back short of the cap (nothing further back to ask for),
       and its own label doubles as the retry once a page fails. */
    const loadMoreButton = more && more.more !== false
      ? `<button type="button" id="mail-load-more" class="btn text-btn mail-load-more" data-mail-load-more=""${more.state === 'loading' ? ' disabled aria-busy="true"' : ''}>`
        + `${more.state === 'failed' ? 'Older mail did not load — try again' : more.state === 'loading' ? 'Loading…' : 'Load older mail'}</button>`
      : '';
    return `<div class="conversation-list"><div class="mail-list-heading"><h2>${FOLDER_LABELS[route.folder]}</h2>`
      + `<small class="mail-list-where">${esc(where)}</small>${queryInput('mail', 'Search mail')}${markAllReadButton(list)}</div>${loadNote()}`
      + (items || empty('No conversations', 'This folder is empty.'))
      + `<div class="mail-list-count">${list.length} conversation${list.length === 1 ? '' : 's'}</div>${truncatedNote(route)}${loadMoreButton}</div>`;
  }

  /* Search spans every message this person could read (search_mail, 0055),
     not the 200-per-folder window mailThreads() keeps — so it draws its own
     list rather than narrowing the loaded one further, which could not have
     found an older match anyway. A hit for a thread already loaded shows
     exactly as the ordinary list would (sender, read and starred state); one
     reached only through search does not guess at those — search_mail's own
     row does not carry them — and says so by leaving the row plain rather
     than confidently marking it read or starred when it might not be. */
  function searchPanel(route, search, boxes, shownId) {
    const addressOf = id => (boxes.find(b => b.id === id) || {}).address || '';
    const heading = `<div class="mail-list-heading"><h2>Search results</h2>${queryInput('mail', 'Search mail')}</div>`;
    if (search.state === 'loading') {
      return `<div class="conversation-list">${heading}<p class="quiet-text mail-loading" role="status" aria-busy="true">Searching…</p></div>`;
    }
    if (search.state === 'failed') {
      return `<div class="conversation-list">${heading}<div class="mail-load-failed"><p>The search did not run.</p>`
        + `<button type="button" id="mail-search-retry" class="btn" data-mail-search-retry="">Try again</button></div></div>`;
    }
    const hits = search.results;
    const items = hits.map(hit => {
      const known = threadById(hit.threadId);
      /* A hit already loaded opens under its own folder — Starred if it was
         starred there, exactly as the ordinary list's own links do
         (folderForThread) — one known only through search opens under
         wherever the person already is: there is no better guess. */
      const openFolder = known ? M.folderForThread(known, route.folder) : route.folder;
      const selected = hit.threadId === shownId;
      const states = known ? [known.unread && 'Unread', known.starred && 'Starred'].filter(Boolean) : [];
      const stateText = states.length ? `<span class="sr-only">${states.join('. ')}. </span>` : '';
      return `<a id="mail-thread-${esc(hit.threadId)}" href="#${M.mailRoute({ mailbox: route.mailbox, folder: openFolder, threadId: hit.threadId })}" class="thread-item${selected ? ' selected' : ''}${known && known.unread ? ' unread' : ''}"${selected ? ' aria-current="true"' : ''}>`
        + `<div class="mail-item-header"><strong>${stateText}${known && known.unread ? '<span class="unread-dot" aria-hidden="true"></span>' : ''}${esc(known ? known.sender : 'Unknown sender')}</strong><small>${esc(hit.time)}</small></div>`
        + `<h3>${known && known.starred ? '<span class="thread-star" aria-hidden="true">★</span> ' : ''}${esc(hit.subject)}</h3>`
        + `<p>${esc(hit.preview)}</p><span class="thread-mailbox">${esc(addressOf(hit.mailboxId))}</span></a>`;
    }).join('');
    return `<div class="conversation-list">${heading}`
      + (items || empty('No matches', 'Nothing in your mail matches that search.'))
      + `<div class="mail-list-count">${hits.length} result${hits.length === 1 ? '' : 's'}</div></div>`;
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

  const inlineImageKey = (messageId, contentId) => messageId + '|' + contentId;

  /* mailBody() (app.js) already asks mail-html.js to leave a pending inline
     image as <img data-mail-cid="…"> with no src (mail-html.js's own second
     pass, run once per message and cached by bodyHtml above) — this fills one
     in once it has actually been fetched, on the cached string rather than by
     re-rendering: mailBody's own signature takes only the message, and it is
     not this batch's file to hand it a second argument through. A cid this
     message's own attachments never named is left exactly as "not yet found"
     would be — nothing here can tell that apart from "still coming". */
  function withResolvedInlineImages(html, messageId) {
    return html.replace(/data-mail-cid="([^"]*)"/g, (whole, cid) => {
      const url = inlineImages[inlineImageKey(messageId, cid)];
      return url ? `src="${esc(url)}" ${whole}` : whole;
    });
  }

  /* Graph's bytes for an inline image do not change once fetched, so each one
     is asked for once — never again while it is in flight, and never again at
     all once it has failed, until the page reloads (workspace:loaded, below,
     is what that resets — the same lifetime readFailed already has). Nothing
     here shows an error for a failed inline image: the img is simply left
     pending, the way a still-loading one is, rather than adding a second kind
     of broken-image state next to "images blocked" that only this one
     function would ever produce. */
  function resolveInlineImages(message) {
    if (!live()) return;
    (message.attachments || []).forEach(a => {
      if (!a.isInline || !a.contentId) return;
      const key = inlineImageKey(message.id, a.contentId);
      if (inlineImages[key] || inlineImagesPending[key] || inlineImagesFailed[key]) return;
      inlineImagesPending = Object.freeze({ ...inlineImagesPending, [key]: true });
      workspaceActions.mailAttachmentContent(a.id)
        .then(blob => {
          const typed = typeof blob.slice === 'function' ? blob.slice(0, blob.size, a.contentType) : blob;
          inlineImages = Object.freeze({ ...inlineImages, [key]: URL.createObjectURL(typed) });
        })
        .catch(err => {
          console.error('[mail] could not load an inline image:', err);
          inlineImagesFailed = Object.freeze({ ...inlineImagesFailed, [key]: true });
        })
        .then(() => {
          const { [key]: _done, ...rest } = inlineImagesPending;
          inlineImagesPending = Object.freeze(rest);
          repaintWhenIdle();
        });
    });
  }

  /* A size a person reads, the same wording ticketsModel.fileSize already
     gives a ticket's own attachments (window.-qualified: mail.js runs before
     tickets-model.js does not matter for a classic script sharing one global
     scope, but a test sandbox loading mail.js on its own, with nothing else
     on the page, must not throw for want of it). */
  function attachmentSize(bytes) {
    return (window.ticketsModel && typeof ticketsModel.fileSize === 'function')
      ? ticketsModel.fileSize(bytes) : `${Math.max(0, Number(bytes) || 0)} B`;
  }

  function attachmentRow(threadId, message, a) {
    return `<li><button type="button" class="text-btn" data-mail-attachment="${esc(a.id)}" data-message-id="${esc(message.id)}" data-thread-id="${esc(threadId)}" aria-label="Download ${esc(a.name)}">`
      + `${esc(a.name)} <small>(${esc(attachmentSize(a.size))})</small></button></li>`;
  }

  function attachmentsPanel(threadId, message) {
    if (!message.attachments || !message.attachments.length) return '';
    return `<ul class="plain-list mail-attachments" aria-label="Attachments">`
      + message.attachments.map(a => attachmentRow(threadId, message, a)).join('') + '</ul>';
  }

  function findMessageAttachment(threadId, messageId, attachmentId) {
    const messages = live() ? workspaceStore.threadBody(threadId) : null;
    const message = messages && messages.find(m => m.id === messageId);
    const attachment = message && (message.attachments || []).find(a => a.id === attachmentId);
    return attachment || null;
  }

  /* The same shape tickets-ui.js's own downloadFile already uses for a
     ticket's attachments: a real <a download>, made, clicked and thrown away,
     rather than window.open (a pop-up blocker's to catch) or navigating the
     tab away from Mail. Not optimistic and not re-rendered: the button is
     disabled directly, the way toggleStar and reconnect already do it for the
     same reason (a render mid-flight would lose the very button that has the
     click). */
  function downloadAttachment(button) {
    const threadId = button.dataset.threadId;
    const messageId = button.dataset.messageId;
    const attachmentId = button.dataset.mailAttachment;
    const attachment = findMessageAttachment(threadId, messageId, attachmentId);
    if (!attachment) { toast('That attachment is not loaded any more. Reload the page.'); return; }
    button.disabled = true;
    workspaceActions.mailAttachmentContent(attachmentId)
      .then(blob => {
        const typed = typeof blob.slice === 'function' ? blob.slice(0, blob.size, attachment.contentType) : blob;
        const url = URL.createObjectURL(typed);
        const link = document.createElement('a');
        link.href = url;
        link.download = attachment.name;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      })
      .catch(err => toast(err.message || 'Could not open that attachment.'))
      .then(() => { button.disabled = false; });
  }

  function messageCard(message, open, newest, threadId) {
    const when = (message.date === 'Today' ? '' : esc(message.date) + ' · ') + esc(message.time);
    const avatar = `<div class="avatar${message.outbound ? ' owner' : ''}">${esc(message.initial)}</div>`;
    /* An id, not just data-mail-expand: this button's own attribute is not
       one repaintKeepingFocus knows to look for (shell-model.js FOCUS_
       ATTRIBUTES is a peer file, not this batch's to add to), but every
       element it checks starts with a plain id when one is there. */
    const expandId = `mail-expand-${esc(message.id)}`;
    if (!open) {
      return `<button type="button" id="${expandId}" class="mail-message collapsed" data-mail-expand="${esc(message.id)}" aria-expanded="false">`
        + `${avatar}<span class="mail-message-summary"><span class="mail-message-line"><strong>${esc(message.sender)}</strong><small>${when}</small></span>`
        + `<span class="mail-message-snippet">${esc(snippet(message))}</span></span></button>`;
    }
    const to = M.recipientLine(message.to);
    const cc = M.recipientLine(message.cc);
    /* Bcc is only ever present on our own sent copies (mail-model's own MailRow
       shape) — a recipient cannot see another's Bcc, so an inbound message
       simply never carries one here; nothing extra needs to gate this on
       message.outbound. */
    const bcc = M.recipientLine(message.bcc);
    const head = `${avatar}<span class="mail-message-meta"><span class="mail-message-line"><strong>${esc(message.sender)}</strong>`
      + `${message.importance === 'high' ? ' ' + pill('High priority', 'red') : ''}<small>${when}</small></span>`
      + `<small class="mail-recipients">${esc(message.email)}${to ? ` to ${esc(to)}` : ''}${cc ? ` · cc ${esc(cc)}` : ''}${bcc ? ` · bcc ${esc(bcc)}` : ''}</small></span>`;
    /* The newest message is always open; an older one can be folded again. */
    const header = newest
      ? `<div class="mail-message-head">${head}</div>`
      : `<button type="button" id="${expandId}" class="mail-message-head" data-mail-expand="${esc(message.id)}" aria-expanded="true">${head}</button>`;
    /* Answer this message — not whichever came in last, which may be an
       out-of-office or a bounce. */
    const answers = [['reply', 'Reply'], ['replyAll', 'Reply all'], ['forward', 'Forward']].map(([mode, label]) =>
      `<button type="button" class="text-btn" data-mail-answer="${mode}" data-thread-id="${esc(threadId)}" data-message-id="${esc(message.id)}">${label}</button>`).join('');
    return `<article class="mail-message">${header}<div class="mail-body">${withResolvedInlineImages(bodyHtml(message), message.id)}</div>`
      + attachmentsPanel(threadId, message)
      + `<div class="mail-message-actions">${answers}</div></article>`;
  }

  function conversation(thread) {
    if (!live()) return '';
    /* A failed load used to be cached as an empty conversation: "Loading…"
       for a while, then "no messages yet", which was not true. */
    if (workspaceStore.threadFailed(thread.id)) {
      return `<div class="mail-load-failed"><p>This conversation did not load.</p>`
        + `<button id="mail-retry-${esc(thread.id)}" class="btn" data-mail-retry="${esc(thread.id)}">Try again</button></div>`;
    }
    const messages = workspaceStore.threadBody(thread.id);
    if (!messages) return '<p class="quiet-text mail-loading">Loading the conversation…</p>';
    if (!messages.length) return '<p class="quiet-text">This conversation has no messages yet.</p>';
    const newest = messages.length - 1;
    return messages.map((m, i) => {
      const open = i === newest || Boolean(expanded[m.id]);
      /* A side effect inside the view, the same way mailView() itself already
         calls markRead(shown) — only an open message's images are worth
         fetching, and a folded one still shows its cid markers plainly if
         it is ever opened before this runs again. */
      if (open) resolveInlineImages(m);
      return messageCard(m, open, i === newest, thread.id);
    }).join('');
  }

  function related(thread) {
    const ticket = thread.ticketId ? tickets.find(t => t.uuid === thread.ticketId) : null;
    const contact = thread.contactId ? contacts.find(x => x.id === thread.contactId) : null;
    if (!contact && !ticket) return '';
    return '<div class="reader-related"><span class="eyebrow">CONNECTED TO THIS CONVERSATION</span>'
      + (contact ? link('crm/' + contact.id, contact.company || contact.name, 'crm', 'related-chip') : '')
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
    return `<button id="mail-expand-reader" class="icon-btn" data-mail-expand-reader aria-pressed="${expanded ? 'true' : 'false'}"`
      + ` title="${label}" aria-label="${label}">${expanded ? '⤡' : '⤢'}</button>`;
  }

  /* A failed mark-as-read used to leave the thread bold with nothing said:
     no error, no way to try again short of a reload. Said the way the whole
     conversation's own load failure is (mail-load-note), with a retry that
     asks again just for this. */
  function readFailedNote(thread) {
    if (!readFailed[thread.id]) return '';
    return '<div class="mail-load-note"><span role="status">Could not mark this conversation as read.</span>'
      + `<button type="button" id="mail-retry-read-${esc(thread.id)}" class="text-btn" data-mail-retry-read="${esc(thread.id)}">Retry</button></div>`;
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
    /* A thread search found but the loaded list never did (M.threadFromSearchHit)
       does not actually know its own read or starred state — search_mail's own
       row carries neither — so toggling either here would flip a guess, not a
       fact. Both controls are withheld rather than shown against a state that
       might be wrong; the conversation itself, and answering it, need only the
       id, so they work exactly as they do for a thread the list did load. */
    const toggles = thread.fromSearch ? '' : `<button id="mail-unread-${esc(thread.id)}" class="icon-btn" data-mail-unread="${esc(thread.id)}" title="Mark as unread" aria-label="Mark as unread">${icon('mail')}</button>`
      + `<button id="mail-star-${esc(thread.id)}" class="icon-btn${thread.starred ? ' starred' : ''}" data-mail-star="${esc(thread.id)}" aria-pressed="${thread.starred ? 'true' : 'false'}" title="${starLabel}" aria-label="${starLabel}">${thread.starred ? '★' : '☆'}</button>`;
    return `<div class="reader" data-thread-id="${esc(thread.id)}"><div class="reader-toolbar">`
      + `<span>${box ? pill(box.address, box.kind === 'personal' ? 'purple' : 'blue') : ''}</span><div class="reader-tools">${expandButton(expanded)}`
      + `${toggles}`
      + `</div></div><div class="reader-content">${readFailedNote(thread)}<h2>${esc(thread.subject)}</h2>`
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
    const q = queries.mail.trim();
    /* A word typed searches every message this person could read (search_
       mail, 0055), replacing the plain folder list rather than narrowing it
       further — mailThreads() only ever loads the 200 most recent per
       folder, so filtering just that window could not find an older match
       anyway (the audit's own "Search is shallow"). "Load more" (below) is
       the loaded window's own way further back, and does not apply here: a
       search already answers from the whole mailbox in one go. */
    const search = q && live() && typeof workspaceStore.searchMail === 'function' ? workspaceStore.searchMail(q) : null;
    const more = !search && live() && typeof workspaceStore.moreMail === 'function' ? workspaceStore.moreMail(mailbox, current.folder) : null;
    const list = search ? [] : M.visibleThreads(M.mergeOlder(mails, (more && more.threads) || []), { mailbox, folder: current.folder });
    currentThreadList = search ? search.results : list;

    /* Open even when a search hides it: the link is what was asked for. A
       thread search alone found (not in `mails`) is still opened — built
       from just what the hit itself answered (M.threadFromSearchHit) — so a
       result reaching further back than the loaded window is not a dead
       click; only while that search is still on screen, exactly as an
       ordinary link to a thread outside the loaded window already was not
       openable once its own page moved on from it either. */
    const shownFromList = route.threadId ? threadById(route.threadId) : null;
    const shownFromSearch = !shownFromList && search && route.threadId
      ? (search.results.find(hit => hit.threadId === route.threadId) || null) : null;
    const shown = shownFromList || (shownFromSearch ? M.threadFromSearchHit(shownFromSearch) : null);
    const listLength = search ? search.results.length : list.length;

    /* A synthetic search-only thread is never in `mails`: falls back to the
       newest rather than -1, so old positional code reading mails[selectedMail]
       (app.js's own dead demo branches) finds a real row, not undefined. */
    selectedMail = shown ? Math.max(mails.indexOf(shown), 0) : 0;       // app.js's contact action still reads it
    if (shown && shown.unread) markRead(shown);

    /* Full screen, so no page heading: the one thing it carried, writing a new
       message, is at the top of the folders. The full width is only kept while
       there is something to read or write in it. */
    const expanded = readerExpanded && Boolean(shown || draftWithoutThread());
    const panel = search
      ? searchPanel(current, search, boxes, shown ? shown.id : route.threadId)
      : threadList(current, list, boxes, shown && shown.id, more);
    return `<section class="panel mail-workspace${expanded ? ' reader-expanded' : ''}">${mailboxColumn(current, boxes)}`
      + `${panel}${reader(shown, boxes, listLength, expanded)}</section>`;
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
    /* Mail draws no page heading — the one thing workspace.js's own
       after-navigate rule (focusNewPage) has to land keyboard focus on, and
       it explicitly skips that rule for a route change within Mail besides,
       since opening a thread, starring one or marking one unread are all
       exactly that: a route change inside the same page. Left alone, the
       keyboard fell to <body> on every one of those. Every call to render()
       while on this page passes through here, whoever asked for it, so
       focus is saved and restored here the same way repaintKeepingFocus does
       it (app.js) — reused directly: it is a plain top-level const there,
       and this file already relies on classic scripts sharing one scope. */
    const active = document.activeElement;
    const key = typeof focusKey === 'function' ? focusKey(active) : null;
    const selection = key && active && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd] : null;
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
    if (key) {
      const next = document.querySelectorAll(key.selector)[key.index];
      if (next && next !== document.activeElement) {
        if (key.heading) next.setAttribute('tabindex', '-1');
        next.focus({ preventScroll: true });
        if (selection && next.setSelectionRange) {
          try { next.setSelectionRange(selection[0], selection[1]); } catch (noCaret) { /* not every field has a caret to put back */ }
        }
      }
    }
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
        warnIfOutlookMissed(result);
      })
      .catch(err => {
        console.error('[mail] could not mark the conversation read:', err);
        readFailed = Object.freeze({ ...readFailed, [thread.id]: true });
        /* Silent before this: the thread stayed bold with nothing said, and
           the only way back was a full reload. */
        toast(err.message || 'Could not mark the conversation as read.');
      })
      .then(() => {
        const { [thread.id]: _finished, ...rest } = markingRead;
        markingRead = Object.freeze(rest);
        /* Always, success or failure: a failure needs the retry note drawn,
           which repaintWhenIdle used to run only on success. */
        repaintWhenIdle();
      });
  }

  document.body.addEventListener('workspace:loaded', () => {
    readFailed = Object.freeze({});
    restoreDraftIfAny();
    inlineImagesFailed = Object.freeze({});
  });

  /* Mark all as read: every unread thread in what is actually on screen right
     now — this folder, this mailbox, the same list Mark all as read's own
     button is drawn beside — not a sweep of the whole mailbox. Each goes
     through markRead() one at a time: the same single write update-mail-
     state already makes, and Outlook needs, for one thread — so a failure on
     any one of them is said and can be retried exactly the way it already is
     for a single thread, with no new bulk endpoint required. */
  function markAllRead(list) {
    if (!live()) return;
    (list || []).filter(t => t.unread && !markingRead[t.id] && !readFailed[t.id]).forEach(markRead);
  }

  /* A disabled button loses focus to <body> at once, in every browser — well
     before the write it disabled itself for has even answered — so by the
     time render() runs, there is nothing left for its own focus-preservation
     to have captured. Found by hand-tracing this file's disable-then-await
     pattern: nothing here was ever a unit test's business, since jsdom-free
     node has no such thing as browser focus at all. Put back explicitly, by
     id, once the button (or its stand-in after a route change) exists again. */
  function refocusMailControl(id) {
    const el = document.getElementById(id);
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }

  /* Not optimistic, like the rest of the workspace: the star changes when the
     database says it did. */
  function toggleStar(button) {
    const thread = threadById(button.dataset.mailStar);
    if (!thread || !live()) return;
    const wanted = !thread.starred;
    const id = button.id;
    button.disabled = true;
    workspaceActions.starThread(thread.id, wanted)
      .then(result => {
        replaceThread(thread.id, { starred: wanted, row: { is_starred: wanted } });
        render();
        refocusMailControl(id);
        warnIfOutlookMissed(result);
      })
      .catch(err => {
        button.disabled = false;
        button.focus({ preventScroll: true });
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
        /* The button itself is gone once the reader closes: the keyboard
           goes to the conversation's own row in the list, now shown bold
           again, rather than falling to the page. */
        refocusMailControl(`mail-thread-${thread.id}`);
        toast('Marked as unread');
        warnIfOutlookMissed(result);
      })
      .catch(err => {
        button.disabled = false;
        button.focus({ preventScroll: true });
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
      canReconnect,
      onSent: afterSend,
      onClose: () => { if (page === 'mail') render(); }
    };
  }

  /* A draft carried across a sign-out and back in again for the same person
     (audit: "Signing out forgets an unsent draft") — localStorage, since
     signing out reloads the page (data/gate.js's leave()), which wipes every
     other record of a draft, mail-compose.js's own kept-across-a-redraw one
     (that file's own top comment) included. One shared key, not one per
     person: the entry names whose draft it is, and is consumed — read once,
     then removed, whichever way it turns out — the moment anyone next signs
     in, so a browser shared with someone else never sits holding a
     stranger's half-written words waiting for them to come back. */
  const DRAFT_STORAGE_KEY = 'veyago.mail.draft';

  function saveDraftForSignOut() {
    if (!mailComposer.hasContent() || typeof mailComposer.snapshot !== 'function') return;
    const snap = mailComposer.snapshot();
    const employeeId = window.workspaceSession && workspaceSession.employee && workspaceSession.employee.id;
    if (!snap || !employeeId) return;
    try {
      if (window.localStorage) window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ employeeId, draft: snap }));
    } catch (fullOrBlocked) {
      /* A browser that keeps nothing simply loses the draft, as it always has. */
    }
  }

  function restoreDraftIfAny() {
    if (mailComposer.isOpen()) return;
    let stored = null;
    try {
      const raw = window.localStorage ? window.localStorage.getItem(DRAFT_STORAGE_KEY) : null;
      stored = raw ? JSON.parse(raw) : null;
      if (window.localStorage) window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch (unreadable) {
      return;
    }
    if (!stored || !stored.draft) return;
    const employeeId = window.workspaceSession && workspaceSession.employee && workspaceSession.employee.id;
    if (!employeeId || stored.employeeId !== employeeId) return;   // a different person signed in
    const boxes = mailboxes();
    if (!boxes.length) {
      toast('A draft from before you last signed in could not be restored: no mailbox is connected.');
      return;
    }
    const from = boxes.find(b => b.id === stored.draft.connectionId) || boxes[0];
    const opened = mailComposer.open({ ...stored.draft, connectionId: from.id }, composerContext());
    if (opened) toast('Picked up an unfinished message from before you signed out.');
  }

  /* Takes the person to the draft: the conversation it answers, or the reading
     pane of the mailbox they were in for a new message. */
  function showDraft() {
    const route = M.parseMailRoute(page === 'mail' ? routeParts : []);
    const thread = mailComposer.threadId() ? threadById(mailComposer.threadId()) : null;
    navigate(M.mailRoute({
      mailbox: route.mailbox,
      folder: thread ? M.folderForThread(thread, route.folder) : route.folder,
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
    if (!boxes.length) {
      toast(workspaceStore.state.mailboxesFailed
        ? 'Your mailboxes did not load. Try again in a moment.'
        : 'Connect a mailbox to send mail from the workspace.');
      return;
    }
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
      const here = M.parseMailRoute(routeParts);
      navigate(M.mailRoute({ mailbox: here.mailbox, folder: M.folderForThread(thread, here.folder), threadId: thread.id }));
    });
  }

  window.addEventListener('beforeunload', e => {
    /* The session ended and the gate is reloading the page: the draft cannot be
       sent from here any more, and the prompt would only hold a locked page
       open. Its words are not simply lost, though — saved first, for the
       next time this same person signs in (restoreDraftIfAny, above). */
    if (window.workspaceGate && window.workspaceGate.leaving) { saveDraftForSignOut(); return; }
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

  /* Connecting a brand new mailbox — never a reconnect — asks who it is for
     first: microsoft-connect's own rule (mirrored, not re-decided, here —
     the function says the same thing again if this gets it wrong) is an
     owner or admin for the studio's, and anyone their own; agenda-ui.js's
     own "Connect a calendar" reads the identical rule for the other
     provider, and this dialog is that one's shape carried over. A tab is
     reserved on the click itself, the same way reconnect() above already
     does, so the browser does not treat Microsoft's page as an unrequested
     pop-up once the round trip to start it answers a moment later. */
  function openConnectMailbox() {
    const offered = (typeof team !== 'undefined' && Array.isArray(team) ? team : []).filter(m => m && m.id);
    showModal('MAIL · CONNECT', '<h2>Connect a mailbox</h2>'
      + dialogForms.form('mail-connect-form',
        dialogForms.field('Address', '<input name="address" type="email" required autofocus placeholder="name@veyago.cloud">')
        + dialogForms.field('Whose', '<select name="whose"><option value="">Studio (shared with everyone)</option>'
          + dialogForms.options(offered.map(m => ({ value: m.id, label: m.name })), null) + '</select>'),
        'Continue to Microsoft'));
    const form = document.getElementById('mail-connect-form');
    form.addEventListener('submit', submitted => {
      submitted.preventDefault();
      const button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      dialogForms.quiet(form);
      const data = new FormData(form);
      const address = String(data.get('address') || '').trim();
      if (!address) { dialogForms.say(form, 'Say which address to connect.', 'address'); return; }
      const whose = String(data.get('whose') || '');
      button.disabled = true;
      const tab = window.open('', '_blank');
      if (tab) tab.document.title = 'Connecting to Microsoft…';
      workspaceActions.connectMailbox(address, whose || null)
        .then(url => {
          reconnecting = true;
          if (!tab) { window.location.assign(url); }
          else { tab.opener = null; tab.location.href = url; }
          dialogForms.closeDialog(form);
          toast(`Finish in the Microsoft tab. ${address} updates when you come back.`);
        })
        .catch(err => {
          if (tab) tab.close();
          button.disabled = false;
          dialogForms.say(form, err.message || 'Connecting could not start.');
        });
    });
  }

  /* Disconnecting takes effect at once — nothing to finish in another tab, no
     round trip to come back from — so it goes through dialog-forms.js's own
     sending() the way every other immediate write in this project does,
     behind a confirm: it stops that mailbox syncing until it is connected
     again, for everyone who reads it if it is the studio's shared one. */
  function openDisconnect(box) {
    showModal('MAIL · DISCONNECT', `<h2>Disconnect ${esc(box.address)}?</h2>`
      + `<p class="form-note">Mail stops syncing here until it is connected again${box.kind === 'personal' ? '' : ', for everyone who reads this shared mailbox'}.</p>`
      + dialogForms.form('mail-disconnect-form', '', 'Disconnect'));
    const form = document.getElementById('mail-disconnect-form');
    form.addEventListener('submit', submitted => {
      submitted.preventDefault();
      dialogForms.quiet(form);
      dialogForms.sending(form, () => workspaceActions.disconnectMailbox(box.id), () => {
        toast(`${box.address} disconnected.`);
      }, { record: `mailbox:${box.id}`, part: ['mail'], only: ['mail'] });
    });
  }

  function backFromMicrosoft() {
    if (!reconnecting || document.visibilityState !== 'visible' || !window.workspaceStore) return;
    reconnecting = false;
    Promise.resolve(workspaceStore.reload()).then(() => { if (page === 'mail') render(); });
  }
  window.addEventListener('focus', backFromMicrosoft);
  document.addEventListener('visibilitychange', backFromMicrosoft);

  /* An address inside a message: opened in the composer, not a new browser
     tab (mail-html.js sets no target/rel on a mailto: link precisely so
     there is nothing else that would open it). Split on the first "?" before
     anything else: a mailto: may name more than one address, comma-separated
     ("mailto:a@x,b@y?subject=…"), and letting M.parseAddresses see the whole
     href would leave the query string stuck to the LAST one only — the
     comma splits it away from the "mailto:" prefix its own stripping looks
     for. compose() re-parses `to` itself, so a plain address string is all
     it needs here. */
  function mailtoClicked(link) {
    const href = String(link.getAttribute('href') || '');
    const [addresses, ...queryParts] = href.split('?');
    const to = addresses.replace(/^mailto:/i, '');
    if (!M.parseAddresses(to).valid.length) return;
    const params = new URLSearchParams(queryParts.join('?'));
    compose(to, params.get('subject') || '', params.get('body') || '');
  }

  document.addEventListener('click', e => {
    if (page !== 'mail' || !e.target.closest) return;
    const mailto = e.target.closest('.mail-body a[href^="mailto:" i]');
    if (mailto) { e.preventDefault(); mailtoClicked(mailto); return; }
    const reconnectButton = e.target.closest('[data-mail-reconnect]');
    if (reconnectButton) { e.preventDefault(); reconnect(reconnectButton); return; }
    const disconnectButton = e.target.closest('[data-mail-disconnect]');
    if (disconnectButton) {
      e.preventDefault();
      const box = mailboxes().find(b => b.id === disconnectButton.dataset.mailDisconnect);
      if (box) openDisconnect(box);
      return;
    }
    if (e.target.closest('[data-mail-connect]')) { e.preventDefault(); openConnectMailbox(); return; }
    const loadMore = e.target.closest('[data-mail-load-more]');
    if (loadMore) {
      e.preventDefault();
      if (loadMore.disabled || !live() || typeof workspaceStore.loadMoreMail !== 'function') return;
      const here = M.parseMailRoute(routeParts);
      workspaceStore.loadMoreMail(here.mailbox, here.folder);
      render();
      return;
    }
    if (e.target.closest('[data-mail-search-retry]')) {
      e.preventDefault();
      if (typeof workspaceStore.retrySearchMail === 'function') workspaceStore.retrySearchMail(queries.mail);
      render();
      return;
    }
    if (e.target.closest('[data-mail-mark-all-read]')) { e.preventDefault(); markAllRead(currentThreadList); return; }
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
    const attachmentButton = e.target.closest('[data-mail-attachment]');
    if (attachmentButton) { e.preventDefault(); downloadAttachment(attachmentButton); return; }
    const retry = e.target.closest('[data-mail-retry]');
    if (retry) { e.preventDefault(); workspaceStore.retryThread(retry.dataset.mailRetry); render(); return; }
    const retryRead = e.target.closest('[data-mail-retry-read]');
    if (retryRead) {
      e.preventDefault();
      const id = retryRead.dataset.mailRetryRead;
      const { [id]: _cleared, ...rest } = readFailed;
      readFailed = Object.freeze(rest);
      const thread = threadById(id);
      if (thread) markRead(thread);
      render();
      return;
    }
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

  /* j/k and the arrow keys move to the next or previous conversation in
     whatever is actually on screen right now (currentThreadList, set at the
     top of every mailView() render) — the loaded list, or a search's own
     results, in the order shown. Not while typing anywhere (the search box
     itself included), not with a dialog open, and not while a draft is open:
     a stray letter must not carry someone away from an answer they are
     writing. Opening the next conversation this way marks it read exactly as
     clicking it already does — the same route change, through navigate(). */
  document.addEventListener('keydown', e => {
    if (page !== 'mail' || (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('#modal').open || mailComposer.isOpen()) return;
    if (!currentThreadList.length) return;
    const idOf = item => (item.threadId !== undefined ? item.threadId : item.id);
    const here = M.parseMailRoute(routeParts);
    const index = here.threadId ? currentThreadList.findIndex(item => idOf(item) === here.threadId) : -1;
    const delta = (e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1;
    const nextIndex = index === -1 ? 0 : Math.min(Math.max(index + delta, 0), currentThreadList.length - 1);
    if (nextIndex === index) return;
    e.preventDefault();
    navigate(M.mailRoute({ mailbox: here.mailbox, folder: here.folder, threadId: idOf(currentThreadList[nextIndex]) }));
  });

  document.addEventListener('change', e => {
    const select = e.target.closest && e.target.closest('[data-mailbox-select]');
    if (!select) return;
    const route = M.parseMailRoute(routeParts);
    navigate(M.mailRoute({ mailbox: select.value, folder: route.folder }));
  });

  /* workspace.js's own [data-query] handler (redrawPreservingFocus) rebuilds
     the whole page on every keystroke, with no pause between them — fine for
     the CRM or a project list, not for a mailbox that can hold hundreds of
     conversations. That handler is shared by four searches and is not this
     batch's to change, so mail's own is caught here first — registered on
     the capture phase, which runs before the bubble-phase listener workspace.js
     added earlier — and stopImmediatePropagation keeps that other handler from
     ever seeing the keystroke at all. The other three searches are untouched. */
  let mailSearchDebounce = null;
  const MAIL_SEARCH_DEBOUNCE_MS = 200;
  document.addEventListener('input', e => {
    if (!e.target.matches || !e.target.matches('[data-query="mail"]')) return;
    e.stopImmediatePropagation();
    const input = e.target;
    const value = input.value;
    clearTimeout(mailSearchDebounce);
    mailSearchDebounce = setTimeout(() => {
      mailSearchDebounce = null;
      queries.mail = value;
      const start = input.selectionStart;
      render();
      const next = document.querySelector('[data-query="mail"]');
      if (next) {
        next.focus();
        if (next.setSelectionRange) { try { next.setSelectionRange(start, start); } catch (noCaret) { /* not focused, or not that kind of field */ } }
      }
    }, MAIL_SEARCH_DEBOUNCE_MS);
  }, true);

  /* workspace.js navigates to the starting route before this file runs, so a
     link straight to mail was painted by the old view. Paint it with this one. */
  if (page === 'mail') render();
})();
