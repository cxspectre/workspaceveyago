/* mail-model.js — Mail's logic, with no page in it.
 *
 * Which mailboxes a person has, what a mail URL means, which threads a folder
 * shows. Kept apart from the view (mail.js) so it can be tested without a
 * browser, and so the view is only about drawing.
 *
 * Mail URLs are #mail/<mailbox>/<folder>/<thread>: the mailbox is "all" or a
 * connection id, the thread is its uuid. They used to end in an array
 * position, which pointed at a different conversation after any reload that
 * changed the list — and a mail link is exactly the kind of thing people copy.
 */
const mailModel = (function () {
  const ALL = 'all';
  const FOLDERS = Object.freeze(['inbox', 'starred', 'sent']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const RECIPIENTS_SHOWN = 3;

  const isId = value => UUID.test(String(value || ''));

  /* integration_status is readable by every member of staff, including other
     people's personal connections (their MAIL is not — RLS on the threads sees
     to that). The switcher offers what this person can actually open: studio
     mailboxes, and their own. */
  function mailboxesFor(connections, employeeId) {
    return (connections || [])
      .filter(c => c && c.provider === 'microsoft_mail')
      .filter(c => !c.employee_id || (Boolean(employeeId) && c.employee_id === employeeId))
      .map(c => {
        const personal = Boolean(c.employee_id);
        return Object.freeze({
          id: c.id,
          address: String(c.account_label || ''),
          kind: personal ? 'personal' : 'shared',
          kindLabel: personal ? 'Personal' : 'Shared',
          status: c.status,
          live: c.is_live === true,
          lastSyncedAt: c.last_synced_at || null,
          lastError: c.last_error || null
        });
      })
      .sort((a, b) => (a.kind === b.kind
        ? a.address.localeCompare(b.address)
        : a.kind === 'personal' ? -1 : 1));
  }

  /* routeParts as navigate() splits them: ['mail', mailbox, folder, thread].
     Anything unrecognised falls back to the inbox rather than guessing — an
     old position-based link must not open somebody else's conversation. */
  function parseMailRoute(parts) {
    const [, mailbox, folder, threadId] = parts || [];
    const validMailbox = mailbox === ALL || isId(mailbox);
    const validFolder = FOLDERS.includes(folder);
    return Object.freeze({
      mailbox: validMailbox ? mailbox : ALL,
      folder: validFolder ? folder : 'inbox',
      threadId: validMailbox && validFolder && isId(threadId) ? threadId : null
    });
  }

  function mailRoute({ mailbox, folder, threadId }) {
    return ['mail', mailbox || ALL, folder || 'inbox']
      .concat(threadId ? [threadId] : [])
      .join('/');
  }

  /* Starred spans folders: a starred sent message is still something you
     marked to come back to. */
  function visibleThreads(threads, { mailbox = ALL, folder = 'inbox', query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return (threads || []).filter(t =>
      (mailbox === ALL || t.mailboxId === mailbox)
      && (folder === 'starred' ? Boolean(t.starred) : t.folder === folder)
      && (!q || [t.sender, t.email, t.subject, t.preview].join(' ').toLowerCase().includes(q)));
  }

  /* Unread means unread in the inbox. A sent thread is never waiting for you. */
  function unreadCount(threads, mailbox) {
    return (threads || []).filter(t =>
      t.folder === 'inbox' && t.unread && (!mailbox || mailbox === ALL || t.mailboxId === mailbox)).length;
  }

  function recipientLine(list) {
    const all = (list || []).filter(Boolean).map(String);
    if (all.length <= RECIPIENTS_SHOWN) return all.join(', ');
    return all.slice(0, RECIPIENTS_SHOWN).join(', ') + ' +' + (all.length - RECIPIENTS_SHOWN) + ' more';
  }

  return Object.freeze({
    ALL, FOLDERS, mailboxesFor, parseMailRoute, mailRoute, visibleThreads, unreadCount, recipientLine
  });
})();
