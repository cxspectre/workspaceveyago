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

  /* The switcher offers what this person can actually open: studio mailboxes,
     and their own. Since 0044 integration_status returns no more than that;
     before it every member of staff could list other people's personal
     connections too (never their mail — RLS on the threads sees to that), so
     the rule is kept here as well. */
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

  /* The folder a conversation's page opens under: its own when the mail view
     has it, Starred for a starred one filed away in Outlook (0045), and
     otherwise where the person already is — the thread opens by its id there. A
     route to "archive" would land on an empty inbox with the thread nowhere on
     screen. */
  function folderForThread(thread, fallback) {
    const folder = thread && thread.folder;
    /* Opened from Starred, a starred conversation stays under Starred. */
    if (fallback === 'starred' && thread && thread.starred) return 'starred';
    if (FOLDERS.includes(folder)) return folder;
    if (thread && thread.starred) return 'starred';
    return FOLDERS.includes(fallback) ? fallback : 'inbox';
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

  /* ── Compose ───────────────────────────────────────────────────────── */

  /* What one message can carry: the numbers send-mail enforces (veyagocloud
     supabase/functions/_shared/mail-send.ts), checked here first so nobody
     waits on a round trip, or an upload, to hear them. */
  const LIMITS = Object.freeze({
    recipients: 500,
    attachments: 20,
    attachmentBytes: 25 * 1024 * 1024,
    htmlBytes: 2 * 1024 * 1024,
    subjectLength: 998
  });
  /* As loose as send-mail's: a bounce is a better failure than refusing a real
     address. */
  const ADDRESS = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
  const ANSWERS = Object.freeze(['reply', 'replyAll', 'forward']);

  /* What the editor keeps of pasted or stored HTML — a saved signature goes
     into the editor too, so it is cleaned the same way. Handed to DOMPurify;
     inline styles are then filtered by mailHtml.cleanStyle, like mail being
     read. No data-* attributes: a pasted data-action would be a workspace
     button. */
  const PURIFY_CONFIG = Object.freeze({
    USE_PROFILES: Object.freeze({ html: true }),
    FORBID_TAGS: Object.freeze(['style', 'meta', 'link', 'title', 'form', 'input', 'button', 'select', 'textarea', 'dialog', 'template']),
    FORBID_ATTR: Object.freeze(['class', 'id', 'contenteditable', 'popover', 'tabindex', 'autofocus', 'accesskey', 'draggable']),
    ALLOW_DATA_ATTR: false
  });

  const lower = value => String(value || '').trim().toLowerCase();
  const isAddress = value => ADDRESS.test(String(value || '').trim());

  /* Each address once, the first spelling kept. */
  const uniqueAddresses = list =>
    list.filter((address, i) => list.findIndex(other => lower(other) === lower(address)) === i);

  /* Prefixes mail clients put on answers and forwards, in the languages mail
     arrives in: re; aw (German), antw (Dutch), sv (Scandinavian), vs (Finnish),
     odp (Polish), res (Portuguese); fw, fwd; wg (German), tr (French), rv
     (Spanish), vl (Finnish), enc (Portuguese). A prefix is followed by a colon,
     so "Return policy" is not one. */
  const REPLY_PREFIX = /^(re|aw|antw|sv|vs|odp|res)\s*:/i;
  const FORWARD_PREFIX = /^(fw|fwd|wg|tr|rv|vl|enc)\s*:/i;

  function subjectFor(mode, subject) {
    const base = String(subject || '').trim();
    if (mode === 'forward') return FORWARD_PREFIX.test(base) ? base : `Fw: ${base}`.trim();
    if (mode === 'reply' || mode === 'replyAll') return REPLY_PREFIX.test(base) ? base : `Re: ${base}`.trim();
    return base;
  }

  /* Who an answer goes to, the way Outlook works it out. A reply answers the
     newest message from outside — on a conversation that is only ours, the
     newest message — and goes to its sender, or, when that message is ours, to
     whoever it went to. Reply all adds everyone else it went to. The mailbox
     itself, and anything in `own`, is never among them. A forward sends on the
     newest message, which carries the whole exchange below it, to nobody yet.
     `messageId` answers that message instead — an out-of-office arriving last
     must not decide who a reply-all reaches. One that is not in the
     conversation is not guessed at. */
  function answerFor(messages, mode, own, messageId) {
    const list = Array.isArray(messages) ? messages : [];
    if (!ANSWERS.includes(mode) || !list.length) return null;
    const chosen = messageId ? list.find(m => m.id === messageId) : null;
    if (messageId && !chosen) return null;
    const newest = list[list.length - 1];
    if (mode === 'forward') {
      return Object.freeze({ messageId: (chosen || newest).id, to: Object.freeze([]), cc: Object.freeze([]) });
    }

    const target = chosen || [...list].reverse().find(m => !m.outbound) || newest;
    const ours = new Set((own || []).map(lower));
    const notOurs = address => Boolean(address) && !ours.has(lower(address));
    const to = uniqueAddresses((target.outbound ? (target.to || []) : [target.email]).filter(notOurs));
    const cc = mode === 'replyAll'
      ? uniqueAddresses([...(target.outbound ? [] : (target.to || [])), ...(target.cc || [])]
          .filter(notOurs)
          .filter(address => !to.some(t => lower(t) === lower(address))))
      : [];
    return Object.freeze({ messageId: target.id, to: Object.freeze(to), cc: Object.freeze(cc) });
  }

  /* One address as people paste it, with quotes, a mailto: and stray angle
     brackets taken off. */
  const bareAddress = token => String(token || '').trim()
    .replace(/^mailto:/i, '')
    .replace(/^["'<\s]+|["'>\s]+$/g, '')
    .trim();

  /* What someone typed or pasted into an address field. A named address comes
     out whole first, because its name may hold a comma ("Lima, Ana <ana@…>"):
     before a <address>, semicolons and new lines always separate recipients,
     and a comma does only where an address sits before it. The rest splits on
     commas, semicolons and new lines — and on spaces, when several addresses
     share one piece. */
  function parseAddresses(text) {
    const tokens = [];
    const rest = String(text || '').replace(/([^<>]*)<([^<>]*)>/g, (_, before, inside) => {
      const segments = before.split(/[;\n]/);
      const pieces = segments.pop().split(',');
      const lastAddress = pieces.map(piece => piece.includes('@')).lastIndexOf(true);
      tokens.push(...segments, ...pieces.slice(0, lastAddress + 1), inside);
      return '\n';
    });
    tokens.push(...rest.split(/[,;\n]+/));
    const cleaned = tokens
      .map(token => String(token).trim())
      .filter(Boolean)
      .flatMap(token => ((token.match(/@/g) || []).length > 1 ? token.split(/\s+/) : [token]))
      .map(bareAddress)
      .filter(Boolean);
    return Object.freeze({
      valid: Object.freeze(uniqueAddresses(cleaned.filter(isAddress))),
      invalid: Object.freeze(cleaned.filter(token => !isAddress(token)))
    });
  }

  /* The object name an upload is stored under: letters, digits, dot, dash and
     underscore, at most 200, never only dots — what send-mail accepts. Accents
     are dropped rather than the letters they sit on, the extension is kept, and
     the name a recipient sees travels separately, as it was. */
  function storageName(fileName) {
    const plain = String(fileName || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
    const dot = plain.lastIndexOf('.');
    const rawExtension = dot > 0 ? plain.slice(dot + 1) : '';
    const extension = /^[A-Za-z0-9]{1,10}$/.test(rawExtension) ? `.${rawExtension.toLowerCase()}` : '';
    const stem = (extension ? plain.slice(0, dot) : plain)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 200 - extension.length)
      .replace(/[-.]+$/g, '');
    return (stem || 'attachment') + extension;
  }

  /* Whether adding these files would take a message past what it can carry.
     Sizes in bytes; null when they fit. */
  function attachmentProblem(current, adding) {
    const incoming = adding || [];
    const all = [...(current || []), ...incoming];
    const empty = incoming.find(file => !(Number(file.size) > 0));
    if (empty) return `"${empty.name}" is empty.`;
    if (all.length > LIMITS.attachments) return `At most ${LIMITS.attachments} attachments per message.`;
    const total = all.reduce((sum, file) => sum + Number(file.size || 0), 0);
    return total > LIMITS.attachmentBytes ? 'Attachments come to more than 25 MB.' : null;
  }

  /* The signature a message starts with: the one written for its mailbox,
     else the one for every mailbox — and none when the chosen one is switched
     off for this kind of message. A mailbox's own signature that is off does
     not fall back to the general one: switching it off is the choice. */
  function signatureFor(signatures, connectionId, mode) {
    const list = Array.isArray(signatures) ? signatures.filter(Boolean) : [];
    const chosen = list.find(s => s.connection_id === connectionId) || list.find(s => !s.connection_id);
    if (!chosen) return null;
    const on = mode === 'new' ? chosen.use_on_new !== false : chosen.use_on_replies !== false;
    return on && String(chosen.html || '').trim() ? chosen.html : null;
  }

  /* What would stop a send, in send-mail's words. A new message and a forward
     need someone in To; an answer only needs someone. `text` is what a person
     would read; an image or an attachment is something too. */
  function sendProblem(draft) {
    const d = draft || {};
    const to = d.to || [];
    const recipients = to.length + (d.cc || []).length + (d.bcc || []).length;
    const subject = String(d.subject || '').trim();
    const answering = d.mode === 'reply' || d.mode === 'replyAll';
    if (!isId(d.connectionId)) return 'Choose the mailbox to send from.';
    if (answering ? !recipients : !to.length) return 'Add at least one recipient.';
    if (recipients > LIMITS.recipients) return `At most ${LIMITS.recipients} recipients per message.`;
    if (d.mode === 'new' && !subject) return 'Add a subject.';
    if (subject.length > LIMITS.subjectLength) return 'That subject is too long.';
    if (Number(d.htmlBytes) > LIMITS.htmlBytes) return 'The message is too long.';
    if (!String(d.text || '').trim() && !d.hasImage && !(d.attachments || []).length) return 'The message is empty.';
    return null;
  }

  /* Addresses to suggest while typing a recipient: CRM contacts first, then
     people from the loaded conversations. Each address once, by the first name
     found for it; never one of our own. */
  function addressBook(contacts, threads, own) {
    const ours = new Set((own || []).map(lower));
    const entries = [
      ...(contacts || []).map(c => [c && c.name, c && c.email]),
      ...(threads || []).map(t => [t && t.sender, t && t.email])
    ];
    const found = new Map();
    entries.forEach(([name, email]) => {
      const address = String(email || '').trim();
      const key = lower(address);
      if (!isAddress(address) || ours.has(key) || found.has(key)) return;
      found.set(key, Object.freeze({ name: String(name || '').trim(), email: address }));
    });
    return Object.freeze([...found.values()]);
  }

  /* What a mailbox's last error says, as the list shows it: the first sentence,
     short enough for the column, with the whole of it kept for a closer look.
     A mailbox still syncing can carry one too — mail the sync went on without
     confirming with Outlook, noted until the daily check (mail-sync.ts in the
     backend). */
  function mailboxNote(box) {
    const MAX = 160;
    const text = String((box && box.lastError) || '').trim();
    if (!text) return null;
    const end = text.indexOf('. ');
    const first = end > 0 ? text.slice(0, end + 1) : text;
    return first.length > MAX ? first.slice(0, MAX - 1) + '…' : first;
  }

  return Object.freeze({
    ALL, FOLDERS, mailboxesFor, mailboxNote, parseMailRoute, mailRoute, folderForThread, visibleThreads, unreadCount, recipientLine,
    LIMITS, PURIFY_CONFIG, isAddress, subjectFor, answerFor, parseAddresses, storageName, attachmentProblem,
    signatureFor, sendProblem, addressBook
  });
})();
