/* Mail's logic, without a page: which mailboxes a person has, what a mail URL
   means, which threads a folder shows, and which inline styles an email may
   keep. Loaded into a sandbox the way <script> tags run them.
   Run from the repo root with: node --test

   The style rules here take a property and a value AFTER the browser has
   parsed them — escapes resolved, comments gone, shorthands expanded. That
   parsing cannot be exercised in node; it was checked against the review's
   bypass payloads in a real browser (see the commit that added this).

   Arrays made inside the sandbox have the sandbox's Array.prototype, which
   strict deep-equality rejects — hence the [...spread] before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function sandbox(file, globals = {}) {
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  return context;
}

const model = vm.runInContext('mailModel', sandbox('mail-model.js'));
const htmlContext = sandbox('data/mail-html.js', { window: {} });
const styleAllowed = vm.runInContext('window.mailHtml.styleAllowed', htmlContext);
const cidFromSrc = vm.runInContext('window.mailHtml.cidFromSrc', htmlContext);

const ME = '6b1f7a52-0000-4000-8000-000000000001';
const COLLEAGUE = '6b1f7a52-0000-4000-8000-000000000002';
const PERSONAL = 'c0000000-0000-4000-8000-00000000000a';
const STUDIO = 'c0000000-0000-4000-8000-00000000000b';
const THREAD = 'd0000000-0000-4000-8000-0000000000f1';

const connection = (over) => ({
  id: STUDIO, provider: 'microsoft_mail', account_label: 'hello@veyago.cloud',
  employee_id: null, employee_name: null, status: 'connected', is_live: true,
  last_synced_at: '2026-09-13T08:00:00Z', last_error: null, ...over
});

/* ── Mailboxes ───────────────────────────────────────────────────────── */

test('a person sees the studio mailbox and their own, not a colleague\'s', () => {
  const rows = [
    connection({}),
    connection({ id: PERSONAL, account_label: 'cassian@veyago.cloud', employee_id: ME }),
    connection({ id: 'x', account_label: 'jd@veyago.cloud', employee_id: COLLEAGUE }),
    connection({ id: 'cal', provider: 'microsoft_calendar', account_label: 'hello@veyago.cloud' })
  ];
  const boxes = model.mailboxesFor(rows, ME);
  assert.deepEqual([...boxes.map(b => b.id)], [PERSONAL, STUDIO], 'personal first, then shared');
  assert.equal(boxes[0].kind, 'personal');
  assert.equal(boxes[0].kindLabel, 'Personal');
  assert.equal(boxes[0].address, 'cassian@veyago.cloud');
  assert.equal(boxes[1].kind, 'shared');
  assert.equal(boxes[1].kindLabel, 'Shared');
});

test('a mailbox that needs reconnecting says so', () => {
  const [box] = model.mailboxesFor([connection({ status: 'needs_reauth', is_live: false })], ME);
  assert.equal(box.live, false);
  assert.equal(box.status, 'needs_reauth');
});

test('no rows, or no signed-in person, gives no personal mailboxes and no crash', () => {
  assert.equal(model.mailboxesFor(null, ME).length, 0);
  assert.equal(model.mailboxesFor([connection({ employee_id: ME, id: PERSONAL })], null).length, 0);
  assert.equal(model.mailboxesFor([connection({ employee_id: ME, id: PERSONAL })], undefined).length, 0);
});

test('only a real true counts as live', () => {
  assert.equal(model.mailboxesFor([connection({ is_live: 'true' })], ME)[0].live, false);
});

/* ── Routes ──────────────────────────────────────────────────────────── */

test('mail routes name a mailbox, a folder and a thread by id', () => {
  assert.deepEqual({ ...model.parseMailRoute(['mail']) },
    { mailbox: 'all', folder: 'inbox', threadId: null });
  assert.deepEqual({ ...model.parseMailRoute(['mail', STUDIO, 'sent', THREAD]) },
    { mailbox: STUDIO, folder: 'sent', threadId: THREAD });
  assert.deepEqual({ ...model.parseMailRoute(['mail', 'all', 'starred']) },
    { mailbox: 'all', folder: 'starred', threadId: null });
});

test('old position-based links and junk degrade to the inbox, never to another thread', () => {
  assert.deepEqual({ ...model.parseMailRoute(['mail', 'inbox', '3']) },
    { mailbox: 'all', folder: 'inbox', threadId: null });
  assert.deepEqual({ ...model.parseMailRoute(['mail', '<script>', 'nope', 'x']) },
    { mailbox: 'all', folder: 'inbox', threadId: null });
});

test('a known mailbox with an unknown folder keeps the mailbox but opens nothing', () => {
  assert.deepEqual({ ...model.parseMailRoute(['mail', STUDIO, 'junk', THREAD]) },
    { mailbox: STUDIO, folder: 'inbox', threadId: null });
});

test('an uppercase uuid is still an id, and extra path parts are ignored', () => {
  const upper = THREAD.toUpperCase();
  assert.equal(model.parseMailRoute(['mail', 'all', 'inbox', upper, 'extra']).threadId, upper);
});

test('mailRoute is the inverse of parseMailRoute', () => {
  const route = { mailbox: PERSONAL, folder: 'sent', threadId: THREAD };
  const built = model.mailRoute(route);
  assert.equal(built, `mail/${PERSONAL}/sent/${THREAD}`);
  assert.deepEqual({ ...model.parseMailRoute(built.split('/')) }, route);
  assert.equal(model.mailRoute({ mailbox: 'all', folder: 'inbox', threadId: null }), 'mail/all/inbox');
});

/* ── Threads ─────────────────────────────────────────────────────────── */

const thread = (over) => ({
  id: THREAD, mailboxId: STUDIO, folder: 'inbox', unread: false, starred: false,
  sender: 'Anna Berg', email: 'anna@client.com', subject: 'Launch plan', preview: 'Can we move it?',
  ...over
});

const threads = [
  thread({ id: 't1', unread: true }),
  thread({ id: 't2', mailboxId: PERSONAL, starred: true, subject: 'Dinner', sender: 'Mum', email: 'mum@home.de', preview: 'See you Sunday' }),
  thread({ id: 't3', folder: 'sent', starred: true, subject: 'Invoice 42' }),
  thread({ id: 't4', mailboxId: PERSONAL, unread: true, subject: 'Flight' })
];

test('a folder shows its own threads, from the chosen mailbox or all of them', () => {
  const ids = opts => [...model.visibleThreads(threads, opts).map(t => t.id)];
  assert.deepEqual(ids({ mailbox: 'all', folder: 'inbox', query: '' }), ['t1', 't2', 't4']);
  assert.deepEqual(ids({ mailbox: PERSONAL, folder: 'inbox', query: '' }), ['t2', 't4']);
  assert.deepEqual(ids({ mailbox: 'all', folder: 'sent', query: '' }), ['t3']);
  assert.deepEqual(ids({ mailbox: 'all', folder: 'starred', query: '' }), ['t2', 't3'],
    'starred spans inbox and sent');
});

test('search matches sender, address, subject and preview, ignoring case', () => {
  const ids = query => [...model.visibleThreads(threads, { mailbox: 'all', folder: 'inbox', query }).map(t => t.id)];
  assert.deepEqual(ids('MUM'), ['t2']);
  assert.deepEqual(ids('home.de'), ['t2']);
  assert.deepEqual(ids('flight'), ['t4']);
  assert.deepEqual(ids('move it'), ['t1', 't4']);
  assert.deepEqual(ids('   '), ['t1', 't2', 't4'], 'blank search shows everything');
});

test('Starred reaches a conversation filed away in Outlook, which Inbox and Sent do not show', () => {
  const filed = [thread({ id: 't9', folder: 'archive', starred: true }), thread({ id: 't10', folder: 'archive' })];
  const ids = folder => [...model.visibleThreads(filed, { mailbox: 'all', folder, query: '' }).map(t => t.id)];
  assert.deepEqual(ids('starred'), ['t9']);
  assert.deepEqual(ids('inbox'), []);
  assert.deepEqual(ids('sent'), []);
  assert.equal(model.unreadCount([thread({ id: 't11', folder: 'archive', unread: true })], 'all'), 0,
    'filed mail is not waiting for anyone');
});

test('a conversation filed away in Outlook opens under Starred when starred, and otherwise where the person is', () => {
  assert.equal(model.folderForThread(thread({ folder: 'sent' }), 'inbox'), 'sent');
  assert.equal(model.folderForThread(thread({ folder: 'archive', starred: true }), 'inbox'), 'starred');
  assert.equal(model.folderForThread(thread({ folder: 'archive' }), 'sent'), 'sent',
    'a route to archive would land on an empty inbox, with the draft nowhere on screen');
  assert.equal(model.folderForThread(thread({ folder: 'trash' }), 'nonsense'), 'inbox');
  assert.equal(model.folderForThread(null, 'starred'), 'starred');
  assert.equal(model.folderForThread(thread({ folder: 'inbox', starred: true }), 'starred'), 'starred',
    'opened from Starred, a starred conversation stays there');
});

test('visibleThreads does not reorder or change the list it is given', () => {
  const before = JSON.stringify(threads);
  model.visibleThreads(threads, { mailbox: 'all', folder: 'starred', query: 'x' });
  assert.equal(JSON.stringify(threads), before);
});

test('unread counts are inbox-only and follow the mailbox', () => {
  assert.equal(model.unreadCount(threads, 'all'), 2);
  assert.equal(model.unreadCount(threads, PERSONAL), 1);
  assert.equal(model.unreadCount(threads, STUDIO), 1);
  assert.equal(model.unreadCount([thread({ folder: 'sent', unread: true })], 'all'), 0);
});

test('mergeOlder appends "load more" threads once, keeping mails\' own order and its own copy first', () => {
  const older = [thread({ id: 't5', subject: 'Old one' }), thread({ id: 't1', subject: 'Stale copy of t1' })];
  const merged = model.mergeOlder(threads, older);
  assert.deepEqual([...merged.map(t => t.id)], ['t1', 't2', 't3', 't4', 't5'],
    'a thread already in mails is kept once, at its own place, not repeated from the older page');
  assert.equal(merged[0].subject, 'Launch plan', 'mails\' own copy is kept — not the older page\'s stale one');
});

test('mergeOlder tolerates missing lists', () => {
  assert.deepEqual([...model.mergeOlder(null, null)], []);
  assert.deepEqual([...model.mergeOlder(threads, undefined).map(t => t.id)], threads.map(t => t.id));
});

test('a search hit for a thread outside the loaded window builds just enough of one to open', () => {
  const hit = { threadId: 'search-only', mailboxId: STUDIO, subject: 'Old renewal', preview: 'See attached', time: 'Sep 1', row: { sent_at: '2026-09-01T09:00:00Z' } };
  const built = model.threadFromSearchHit(hit);
  assert.equal(built.id, 'search-only');
  assert.equal(built.mailboxId, STUDIO);
  assert.equal(built.subject, 'Old renewal');
  assert.equal(built.preview, 'See attached');
  assert.equal(built.sender, 'Unknown sender', 'search_mail\'s own row does not carry a sender — never guessed at');
  assert.equal(built.unread, false, 'not known either way — never presented as read when it might not be');
  assert.equal(built.starred, false);
  assert.equal(built.folder, null, 'folderForThread falls back to wherever the person already is');
  assert.equal(built.fromSearch, true, 'so the reader can withhold star/unread, which need a state this does not have');
});

test('recipient lines read like a mail client, and stay short', () => {
  assert.equal(model.recipientLine(['a@x.com']), 'a@x.com');
  assert.equal(model.recipientLine(['a@x.com', 'b@y.com']), 'a@x.com, b@y.com');
  assert.equal(model.recipientLine(['a@x.com', 'b@y.com', 'c@z.com', 'd@w.com', 'e@v.com']),
    'a@x.com, b@y.com, c@z.com +2 more');
  assert.equal(model.recipientLine(null), '');
});

/* ── Email inline styles (after the browser has parsed them) ─────────── */

const blocked = { showImages: false };
const shown = { showImages: true };

test('ordinary email styling is kept', () => {
  for (const [property, value] of [
    ['color', 'rgb(51, 51, 51)'], ['background-color', 'rgb(255, 255, 255)'],
    ['font-family', '"Segoe UI", Arial'], ['font-size', '14px'], ['font-weight', '600'],
    ['line-height', '1.5'], ['text-align', 'center'], ['text-decoration-line', 'underline'],
    ['padding-top', '4px'], ['margin-left', 'auto'], ['border-top-width', '1px'],
    ['border-top-style', 'solid'], ['border-top-color', 'rgb(0, 0, 0)'],
    ['border-top-left-radius', '8px'], ['width', '600px'], ['max-width', '100%'],
    ['display', 'block'], ['vertical-align', 'top'], ['border-collapse', 'collapse'],
    ['background-image', 'none'],
  ]) {
    assert.equal(styleAllowed(property, value, blocked), true, `${property}: ${value}`);
  }
});

test('nothing may position itself, so nothing can be laid over the workspace', () => {
  for (const value of ['fixed', 'absolute', 'sticky', 'relative', 'static']) {
    assert.equal(styleAllowed('position', value, blocked), false, `position: ${value}`);
  }
  assert.equal(styleAllowed('top', '0px', blocked), false);
  assert.equal(styleAllowed('inset', '0px', blocked), false);
  assert.equal(styleAllowed('z-index', '99999', blocked), false);
  assert.equal(styleAllowed('transform', 'translateY(-500px)', blocked), false);
});

test('a CSS image is a remote image: blocked with the rest, and only ever https', () => {
  assert.equal(styleAllowed('background-image', 'url("https://track.example/p.gif")', blocked), false);
  assert.equal(styleAllowed('background-image', 'url("https://cdn.example/hero.png")', shown), true);
  assert.equal(styleAllowed('background-image', 'url("http://plain.example/x.png")', shown), false);
  assert.equal(styleAllowed('background-image', 'url("//cdn.example/x.png")', shown), false);
  assert.equal(styleAllowed('background-image',
    'url("https://a.example/1.png"), url("data:image/png;base64,AAAA")', shown), false);
});

test('every other way CSS can fetch something is refused, images shown or not', () => {
  for (const value of [
    'image-set(url("https://t.example/p.gif") 1dppx)',
    '-webkit-image-set(url("https://t.example/p.gif") 1x)',
    'cross-fade(url("https://a.example/a.png"), url("https://a.example/b.png"), 50%)',
    'image("https://t.example/p.gif")',
    'element(#logo)',
    'var(--anything)',
  ]) {
    assert.equal(styleAllowed('background-image', value, shown), false, value);
  }
  assert.equal(styleAllowed('list-style-image', 'url("https://t.example/p.gif")', shown), false);
  assert.equal(styleAllowed('cursor', 'url("https://t.example/c.cur"), auto', shown), false);
  assert.equal(styleAllowed('border-image-source', 'url("https://t.example/b.png")', shown), false);
  assert.equal(styleAllowed('content', 'url("https://t.example/p.gif")', shown), false);
});

test('properties that can run code, or that the list does not know, are refused', () => {
  assert.equal(styleAllowed('behavior', 'url(x.htc)', shown), false);
  assert.equal(styleAllowed('-moz-binding', 'url(x.xml#y)', shown), false);
  assert.equal(styleAllowed('width', 'expression(alert(1))', blocked), false);
  assert.equal(styleAllowed('--brand', 'red', blocked), false);
  assert.equal(styleAllowed('filter', 'url("#blur")', shown), false);
  assert.equal(styleAllowed('mask-image', 'none', blocked), false);
  assert.equal(styleAllowed('', 'red', blocked), false);
  assert.equal(styleAllowed('color', '', blocked), false);
});

/* ── Inline images (cid:) ────────────────────────────────────────────── */

test('a cid: src names the Content-ID it refers to, with no angle brackets', () => {
  assert.equal(cidFromSrc('cid:image001.png@01D8E645.CA255A20'), 'image001.png@01D8E645.CA255A20');
  assert.equal(cidFromSrc('CID:LOGO'), 'LOGO', 'the scheme is case-insensitive, same as mailto:');
});

test('a %-escaped cid decodes the same way a mailto: address\'s query string does', () => {
  assert.equal(cidFromSrc('cid:logo%40veyago.cloud'), 'logo@veyago.cloud');
  /* A bad escape is read as the literal text rather than thrown away: an
     unusual cid is still worth trying to match against an attachment list. */
  assert.equal(cidFromSrc('cid:not%a-real-escape'), 'not%a-real-escape');
});

test('anything that is not cid: at all is not one, whatever it looks like', () => {
  assert.equal(cidFromSrc('https://example.com/cid:not-a-scheme'), null);
  assert.equal(cidFromSrc('data:image/png;base64,AAAA'), null);
  assert.equal(cidFromSrc(''), null);
  assert.equal(cidFromSrc(null), null);
  assert.equal(cidFromSrc(undefined), null);
});

test('a cid: with nothing after it names nothing', () => {
  assert.equal(cidFromSrc('cid:'), null);
  assert.equal(cidFromSrc('cid: '), null);
});

/* ── Compose ─────────────────────────────────────────────────────────── */

test('answers carry one Re: or Fw:, however many the subject had', () => {
  assert.equal(model.subjectFor('reply', 'Homepage'), 'Re: Homepage');
  assert.equal(model.subjectFor('replyAll', 'RE: Homepage'), 'RE: Homepage');
  assert.equal(model.subjectFor('forward', 'Re: Homepage'), 'Fw: Re: Homepage');
  assert.equal(model.subjectFor('forward', 'FW: Homepage'), 'FW: Homepage');
  assert.equal(model.subjectFor('forward', 'Fwd: Homepage'), 'Fwd: Homepage');
  assert.equal(model.subjectFor('new', '  Kick-off  '), 'Kick-off');
  assert.equal(model.subjectFor('reply', ''), 'Re:');
});

const CONVERSATION = [
  { id: 'm1', email: 'ana@northline.example', outbound: false, to: ['hello@veyago.cloud'], cc: [] },
  { id: 'm2', email: 'hello@veyago.cloud', outbound: true, to: ['ana@northline.example'], cc: [] },
  { id: 'm3', email: 'ben@northline.example', outbound: false, to: ['hello@veyago.cloud'], cc: ['ana@northline.example'] },
  { id: 'm4', email: 'hello@veyago.cloud', outbound: true, to: ['ben@northline.example'], cc: [] }
];

test('a reply answers whoever wrote last from outside', () => {
  const answer = model.answerFor(CONVERSATION, 'reply', ['hello@veyago.cloud']);
  assert.equal(answer.messageId, 'm3');
  assert.deepEqual([...answer.to], ['ben@northline.example']);
  assert.deepEqual([...answer.cc], []);
});

test('reply all adds everyone the message went to, never the mailbox itself, and nobody twice', () => {
  const thread = [{
    id: 'm1', email: 'ben@northline.example', outbound: false,
    to: ['Hello@Veyago.cloud', 'ops@northline.example'],
    cc: ['ana@northline.example', 'BEN@northline.example', 'ops@northline.example', 'cdrefke@veyago.cloud']
  }];
  const answer = model.answerFor(thread, 'replyAll', ['hello@veyago.cloud', 'cdrefke@veyago.cloud']);
  assert.deepEqual([...answer.to], ['ben@northline.example']);
  assert.deepEqual([...answer.cc], ['ops@northline.example', 'ana@northline.example']);
});

test('on a conversation that is only ours, an answer goes back to whoever we wrote to', () => {
  const thread = [{ id: 'm1', email: 'hello@veyago.cloud', outbound: true, to: ['ana@northline.example', 'hello@veyago.cloud'], cc: ['ops@northline.example'] }];
  assert.deepEqual([...model.answerFor(thread, 'reply', ['hello@veyago.cloud']).to], ['ana@northline.example']);
  const all = model.answerFor(thread, 'replyAll', ['hello@veyago.cloud']);
  assert.deepEqual([...all.to], ['ana@northline.example']);
  assert.deepEqual([...all.cc], ['ops@northline.example']);
});

test('a forward sends on the newest message to nobody yet; nothing to answer is nothing', () => {
  const forward = model.answerFor(CONVERSATION, 'forward', ['hello@veyago.cloud']);
  assert.equal(forward.messageId, 'm4', 'the newest message carries the whole exchange below it');
  assert.deepEqual([...forward.to], []);
  assert.deepEqual([...forward.cc], []);
  assert.equal(model.answerFor([], 'reply', []), null);
  assert.equal(model.answerFor(null, 'reply', []), null);
});

test('an answer can be to any message in the conversation, not only the newest from outside', () => {
  /* We wrote to Ana and Ben; Ana replied to all; then Ben's out-of-office came in. */
  const thread = [
    { id: 'm1', email: 'hello@veyago.cloud', outbound: true, to: ['ana@northline.example', 'ben@northline.example'], cc: [] },
    { id: 'm2', email: 'ana@northline.example', outbound: false, to: ['hello@veyago.cloud'], cc: ['ben@northline.example'] },
    { id: 'm3', email: 'ben@northline.example', outbound: false, to: ['hello@veyago.cloud'], cc: [] }
  ];
  const own = ['hello@veyago.cloud'];
  const toAna = model.answerFor(thread, 'replyAll', own, 'm2');
  assert.equal(toAna.messageId, 'm2');
  assert.deepEqual([...toAna.to], ['ana@northline.example']);
  assert.deepEqual([...toAna.cc], ['ben@northline.example'], 'Ana\'s reply-all keeps Ben');
  assert.equal(model.answerFor(thread, 'forward', own, 'm1').messageId, 'm1');
  assert.equal(model.answerFor(thread, 'reply', own, 'm9'), null, 'a message that is not in the conversation is not guessed at');
  assert.equal(model.answerFor(thread, 'replyAll', own).messageId, 'm3', 'without a choice, the newest from outside');
});

test('names with commas in them, quotes, mailto: and stray brackets still give their address', () => {
  const parsed = model.parseAddresses('Lima, Ana <ana@northline.example>; Hart, Ben <ben@northline.example>');
  assert.deepEqual([...parsed.valid], ['ana@northline.example', 'ben@northline.example']);
  assert.deepEqual([...parsed.invalid], []);
  assert.deepEqual([...model.parseAddresses('"ops@northline.example"').valid], ['ops@northline.example']);
  assert.deepEqual([...model.parseAddresses('mailto:ops@northline.example').valid], ['ops@northline.example']);
  assert.deepEqual([...model.parseAddresses('ops@northline.example>').valid], ['ops@northline.example']);
  assert.deepEqual([...model.parseAddresses("'Ana Lima' <ana@northline.example>, ops@northline.example").valid],
    ['ana@northline.example', 'ops@northline.example']);
});

test('a display name that is itself an address is a name, not a second recipient — a genuinely separate address before a name still counts, whichever separator sets them apart', () => {
  /* Some senders set their display name to their old or public address; the
     one that receives mail is the one inside the angle brackets. */
  const renamed = model.parseAddresses('j.doe@old.example <j.doe@new.example>');
  assert.deepEqual([...renamed.valid], ['j.doe@new.example']);
  assert.deepEqual([...renamed.invalid], []);
  /* Comma-joined names, and a genuinely separate address before one, still count. */
  const mixed = model.parseAddresses('ops@northline.example, Doe, John <john@northline.example>');
  assert.deepEqual([...mixed.valid], ['ops@northline.example', 'john@northline.example']);
  assert.deepEqual([...mixed.invalid], []);
  /* The one piece touching the bracket is always read as its name, even when
     it looks like its own address and even when a comma or a semicolon (not
     only a plain name) set it apart from an earlier, separate address —
     comma and semicolon give the same answer. A product decision, not a
     guess: syntax alone cannot tell "two recipients, one whose name happens
     to be an address" from "three recipients, none of them named" apart. */
  const withComma = model.parseAddresses('ops@northline.example, j.doe@old.example <j.doe@new.example>');
  assert.deepEqual([...withComma.valid], ['ops@northline.example', 'j.doe@new.example']);
  assert.deepEqual([...withComma.invalid], []);
  const withSemicolon = model.parseAddresses('ops@northline.example; j.doe@old.example <j.doe@new.example>');
  assert.deepEqual([...withSemicolon.valid], ['ops@northline.example', 'j.doe@new.example']);
  assert.deepEqual([...withSemicolon.invalid], [], 'a comma and a semicolon here agree, on invalid too');
  const cruz = model.parseAddresses('ana@northline.example, ben@northline.example <cruz@northline.example>');
  assert.deepEqual([...cruz.valid], ['ana@northline.example', 'cruz@northline.example'], 'the piece touching the bracket, ben@…, is read as its name');
  assert.deepEqual([...cruz.invalid], []);
});

test('several addresses pasted with a space, not a comma, ahead of a named one are still every one of them', () => {
  const spaced = model.parseAddresses('ana@northline.example ben@northline.example <cruz@northline.example>');
  assert.deepEqual([...spaced.valid], ['ana@northline.example', 'ben@northline.example', 'cruz@northline.example']);
  assert.deepEqual([...spaced.invalid], []);
  const three = model.parseAddresses('ana@northline.example ben@northline.example cruz@northline.example <dee@northline.example>');
  assert.deepEqual([...three.valid], ['ana@northline.example', 'ben@northline.example', 'cruz@northline.example', 'dee@northline.example']);
  const noBracket = model.parseAddresses('ana@northline.example ben@northline.example cruz@northline.example');
  assert.deepEqual([...noBracket.valid], ['ana@northline.example', 'ben@northline.example', 'cruz@northline.example'], 'the same, with no bracket at all');
});

test('an address followed by a parenthetical comment gives the address; a leading one, or one alone, is not read as an address at all', () => {
  assert.deepEqual([...model.parseAddresses('no-reply@northline.example (Do not reply)').valid], ['no-reply@northline.example']);
  assert.deepEqual([...model.parseAddresses('no-reply@northline.example (Do not reply)').invalid], []);
  /* More than one trailing comment, and one nested inside another. */
  assert.deepEqual([...model.parseAddresses('no-reply@northline.example (Do not reply) (Automated)').valid], ['no-reply@northline.example']);
  assert.deepEqual([...model.parseAddresses('no-reply@northline.example (a (nested) note)').valid], ['no-reply@northline.example']);
  /* A stray, unrelated paren earlier in the address (isAddress's own looseness,
     not touched here) does not confuse where the trailing comment starts. */
  assert.deepEqual([...model.parseAddresses('a(b)@northline.example (Do not reply)').valid], ['a(b)@northline.example']);
  /* Not handled: a comment before the address, rather than after it; nor one
     holding a comma or a semicolon of its own — parseAddresses has already
     split the text on those by the time a comment is looked for, so only the
     comment's first word survives, whole, as its own leftover token. */
  assert.deepEqual([...model.parseAddresses('(Do not reply) no-reply@northline.example').valid], []);
  assert.deepEqual([...model.parseAddresses('(Do not reply) no-reply@northline.example').invalid], ['(Do not reply) no-reply@northline.example']);
  const commaInComment = model.parseAddresses('ops@northline.example (Ops, Team)');
  assert.deepEqual([...commaInComment.valid], []);
  assert.deepEqual([...commaInComment.invalid], ['ops@northline.example (Ops', 'Team)']);
  /* A comment with nothing else is noise, not an address to reject either. */
  const alone = model.parseAddresses('(Do not reply)');
  assert.deepEqual([...alone.valid], []);
  assert.deepEqual([...alone.invalid], []);
});

test('a bracket holding two or three addresses, comma- or semicolon-separated, gives every one — but a comma inside a quoted local part is not read as one, and a stray leading or trailing separator is not a blank address', () => {
  assert.deepEqual([...model.parseAddresses('<ana@northline.example, ben@northline.example>').valid],
    ['ana@northline.example', 'ben@northline.example']);
  assert.deepEqual([...model.parseAddresses('<ana@northline.example; ben@northline.example>').valid],
    ['ana@northline.example', 'ben@northline.example']);
  assert.deepEqual([...model.parseAddresses('<ana@northline.example, ben@northline.example, cruz@northline.example>').valid],
    ['ana@northline.example', 'ben@northline.example', 'cruz@northline.example']);
  assert.deepEqual([...model.parseAddresses('<ana@northline.example,>').valid], ['ana@northline.example'], 'a stray trailing comma is not a second, blank address');
  assert.deepEqual([...model.parseAddresses('<,ana@northline.example>').valid], ['ana@northline.example'], 'nor a stray leading one');
  const quoted = model.parseAddresses('<"Lima, Ana"@northline.example>');
  assert.deepEqual([...quoted.valid], [], 'a comma inside quotes is not a second address — nothing is fabricated from the fragment');
  assert.deepEqual([...quoted.invalid], ['Lima, Ana"@northline.example'], 'kept as one leftover token, its own leading quote stripped as any address\'s would be');
  /* A semicolon inside quotes is left whole the same way; isAddress's own
     regex — unchanged here — is loose enough to accept the result anyway
     (";" and '"' are not excluded from a local part), a separate, pre-existing
     limitation this fix does not reach. */
  assert.deepEqual([...model.parseAddresses('<"a;b"@northline.example>').valid], ['a;b"@northline.example']);
});

test('mailto\'s ?subject= is taken off, whatever ran between the colon and the address; a literal ? in an address\'s own local part, which mailto: never introduced, is left alone', () => {
  assert.deepEqual([...model.parseAddresses('mailto:ops@northline.example?subject=Hello%20there').valid], ['ops@northline.example']);
  assert.deepEqual([...model.parseAddresses('mailto:ops@northline.example').valid], ['ops@northline.example']);
  /* Rendered as plain text on a web page, or typed by hand: a space (or a
     tab) after the colon still gives the address. */
  assert.deepEqual([...model.parseAddresses('mailto: ops@northline.example').valid], ['ops@northline.example']);
  assert.deepEqual([...model.parseAddresses('mailto:\tops@northline.example?subject=Hi').valid], ['ops@northline.example']);
  const weird = model.parseAddresses('weird?name@northline.example');
  assert.deepEqual([...weird.valid], ['weird?name@northline.example']);
  assert.deepEqual([...weird.invalid], []);
  assert.deepEqual([...model.parseAddresses('huh?').invalid], ['huh?'], 'kept whole, not mangled to "huh"');
  assert.deepEqual([...model.parseAddresses('MAILTO:ana@northline.example?subject=Hi').valid], ['ana@northline.example'], 'the scheme itself is case-insensitive too');
  assert.deepEqual([...model.parseAddresses('mailto:?subject=Hi').valid], [], 'no address at all: nothing to send to, and nothing invalid either');
  assert.deepEqual([...model.parseAddresses('mailto:?subject=Hi').invalid], []);
});

test('a subject already answered in another language keeps its prefix', () => {
  assert.equal(model.subjectFor('reply', 'AW: Angebot'), 'AW: Angebot');
  assert.equal(model.subjectFor('replyAll', 'SV: Offert'), 'SV: Offert');
  assert.equal(model.subjectFor('reply', 'Antw: Vraag'), 'Antw: Vraag');
  assert.equal(model.subjectFor('forward', 'WG: Angebot'), 'WG: Angebot');
  assert.equal(model.subjectFor('forward', 'TR: Devis'), 'TR: Devis');
  assert.equal(model.subjectFor('forward', 'AW: Angebot'), 'Fw: AW: Angebot', 'forwarding an answer is still a forward');
  assert.equal(model.subjectFor('reply', 'Return policy'), 'Re: Return policy', 'a word that starts like a prefix is not one');
});

test('a message too big to send is said before sending', () => {
  const ok = { mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], subject: 'Kick-off', text: 'Hi' };
  assert.equal(model.sendProblem({ ...ok, htmlBytes: model.LIMITS.htmlBytes }), null);
  assert.equal(model.sendProblem({ ...ok, htmlBytes: model.LIMITS.htmlBytes + 1 }), 'The message is too long.');
});

test('what the editor keeps from pasted HTML is one setting, used for signatures too', () => {
  const config = model.PURIFY_CONFIG;
  for (const attr of ['class', 'id', 'contenteditable', 'popover', 'tabindex', 'autofocus']) {
    assert.ok(config.FORBID_ATTR.includes(attr), attr);
  }
  for (const tag of ['style', 'form', 'input', 'button', 'dialog', 'template']) {
    assert.ok(config.FORBID_TAGS.includes(tag), tag);
  }
  assert.equal(config.ALLOW_DATA_ATTR, false, 'a pasted data-action must not become a workspace button');
});

test('typed and pasted addresses are split, named ones unwrapped, bad ones kept apart', () => {
  const parsed = model.parseAddresses('Ana Lima <ana@northline.example>, ops@northline.example; not-an-address\nben@northline.example BEN@northline.example');
  assert.deepEqual([...parsed.valid], ['ana@northline.example', 'ops@northline.example', 'ben@northline.example']);
  assert.deepEqual([...parsed.invalid], ['not-an-address']);
  assert.deepEqual([...model.parseAddresses('').valid], []);
  assert.deepEqual([...model.parseAddresses('  ,; \n').invalid], []);
  assert.equal(model.isAddress('ana@northline.example'), true);
  assert.equal(model.isAddress('ana@localhost'), false);
});

test('an upload is stored under a plain name that keeps its extension', () => {
  assert.equal(model.storageName('Quarterly Report (Final).pdf'), 'Quarterly-Report-Final.pdf');
  assert.equal(model.storageName('résumé.docx'), 'resume.docx');
  assert.equal(model.storageName('../../etc/passwd'), 'etc-passwd');
  assert.equal(model.storageName('...'), 'attachment');
  assert.equal(model.storageName('日本語.pdf'), 'attachment.pdf');
  assert.equal(model.storageName('archive.tar.gz'), 'archive.tar.gz');
  assert.equal(model.storageName('PHOTO.JPG'), 'PHOTO.jpg');
  const long = model.storageName('a'.repeat(300) + '.pdf');
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.pdf'));
  for (const name of ['Quarterly Report (Final).pdf', '../../etc/passwd', '...', '', null, '%2e%2e']) {
    assert.match(model.storageName(name), /^[A-Za-z0-9._-]{1,200}$/, String(name));
    assert.doesNotMatch(model.storageName(name), /^\.+$/, String(name));
    assert.doesNotMatch(model.storageName(name), /%/, String(name));
  }
});

test('attachments are checked against what one message can carry, before uploading', () => {
  const MB = 1024 * 1024;
  assert.equal(model.attachmentProblem([], [{ name: 'a.pdf', size: MB }]), null);
  assert.match(model.attachmentProblem([{ name: 'x', size: 20 * MB }], [{ name: 'big.mov', size: 6 * MB }]), /25 MB/);
  assert.match(model.attachmentProblem(Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, size: 1 })), [{ name: 'one-more', size: 1 }]), /20 attachments/);
  assert.match(model.attachmentProblem([], [{ name: 'empty.txt', size: 0 }]), /empty\.txt/);
});

test('a mailbox\'s own signature wins over the one for every mailbox, even when it is switched off', () => {
  const studio = { connection_id: STUDIO, html: '<p>Studio</p>', use_on_new: true, use_on_replies: false };
  const every = { connection_id: null, html: '<p>Everywhere</p>', use_on_new: true, use_on_replies: true };
  assert.equal(model.signatureFor([every, studio], STUDIO, 'new'), '<p>Studio</p>');
  assert.equal(model.signatureFor([every, studio], STUDIO, 'reply'), null, 'off for replies: no falling back to the general one');
  assert.equal(model.signatureFor([every, studio], PERSONAL, 'forward'), '<p>Everywhere</p>');
  assert.equal(model.signatureFor([], STUDIO, 'new'), null);
  assert.equal(model.signatureFor(null, STUDIO, 'new'), null);
  assert.equal(model.signatureFor([{ connection_id: null, html: '  ', use_on_new: true, use_on_replies: true }], STUDIO, 'new'), null);
});

test('what would stop a send is said before sending, in send-mail\'s words', () => {
  const ok = { mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], cc: [], bcc: [], subject: 'Kick-off', text: 'Hi', attachments: [] };
  assert.equal(model.sendProblem(ok), null);
  assert.match(model.sendProblem({ ...ok, connectionId: '' }), /mailbox/);
  assert.match(model.sendProblem({ ...ok, to: [] }), /recipient/);
  assert.match(model.sendProblem({ ...ok, to: [], cc: ['x@y.example'] }), /recipient/, 'a new message needs someone in To');
  assert.equal(model.sendProblem({ ...ok, mode: 'reply', to: [], cc: ['x@y.example'], subject: '' }), null, 'an answer only needs someone');
  assert.match(model.sendProblem({ ...ok, mode: 'forward', to: [], cc: ['x@y.example'] }), /recipient/);
  assert.match(model.sendProblem({ ...ok, subject: '  ' }), /subject/);
  assert.match(model.sendProblem({ ...ok, subject: 'x'.repeat(999) }), /too long/);
  assert.match(model.sendProblem({ ...ok, text: '  ' }), /empty/);
  assert.equal(model.sendProblem({ ...ok, text: '', attachments: [{ name: 'a.pdf' }] }), null);
  assert.equal(model.sendProblem({ ...ok, text: '', hasImage: true }), null);
  assert.match(model.sendProblem({ ...ok, to: Array.from({ length: 501 }, (_, i) => `p${i}@x.example`) }), /500/);
});

test('suggestions come from the CRM first, then from conversations, each address once and never our own', () => {
  const book = model.addressBook(
    [{ name: 'Ana Lima', email: 'ana@northline.example' }, { name: 'No mail', email: '' }],
    [{ sender: 'Ana', email: 'ANA@northline.example' }, { sender: 'Ben', email: 'ben@northline.example' },
     { sender: 'Studio', email: 'hello@veyago.cloud' }],
    ['hello@veyago.cloud']);
  assert.deepEqual([...book].map(entry => ({ ...entry })), [
    { name: 'Ana Lima', email: 'ana@northline.example' },
    { name: 'Ben', email: 'ben@northline.example' }
  ]);
});

/* ── Truncation-aware counts ─────────────────────────────────────────── */

test('isTruncated says when a mailbox\'s folder hit the per-folder cap, so a count from it is not the whole story', () => {
  const truncated = [`${STUDIO}|inbox`, `${PERSONAL}|sent`];
  assert.equal(model.isTruncated(truncated, STUDIO, ['inbox']), true);
  assert.equal(model.isTruncated(truncated, PERSONAL, ['inbox']), false, 'a different mailbox is not cut');
  assert.equal(model.isTruncated(truncated, STUDIO, ['sent']), false, 'a different folder is not cut');
  assert.equal(model.isTruncated(truncated, model.ALL, ['inbox']), true, 'All mailboxes sees any one mailbox\'s cut');
  assert.equal(model.isTruncated(truncated, STUDIO, ['inbox', 'starred']), true, 'starred draws from inbox too');
  assert.equal(model.isTruncated([], STUDIO, ['inbox']), false);
  assert.equal(model.isTruncated(null, STUDIO, ['inbox']), false);
  assert.equal(model.isTruncated(['all|inbox'], STUDIO, ['inbox']), true,
    'a failed mailbox list falls back to "all" and still names its own cut');
});

test('an unread count says when it is a floor rather than the true number', () => {
  const cut = model.unreadCountInfo(threads, STUDIO, [`${STUDIO}|inbox`]);
  assert.equal(cut.count, 1);
  assert.equal(cut.atLeast, true);
  const whole = model.unreadCountInfo(threads, STUDIO, []);
  assert.equal(whole.count, 1);
  assert.equal(whole.atLeast, false);
  assert.equal(model.unreadCountInfo(threads, model.ALL, []).count, 2, 'matches unreadCount itself');
});

test('with a true, database-counted answer, unreadCountInfo uses it instead of the floor guess', () => {
  const trueCounts = { [STUDIO]: 5, [PERSONAL]: 0 };
  const studio = model.unreadCountInfo(threads, STUDIO, [`${STUDIO}|inbox`], trueCounts);
  assert.equal(studio.count, 5, 'the real count, not the loaded-list guess (1) nor its floor');
  assert.equal(studio.atLeast, false, 'a real count is never a floor');
  const all = model.unreadCountInfo(threads, model.ALL, [], trueCounts);
  assert.equal(all.count, 5, 'All mailboxes sums the true counts');
  const untouched = model.unreadCountInfo(threads, STUDIO, [`${STUDIO}|inbox`], null);
  assert.equal(untouched.count, 1, 'with none yet, the old floor-based guess still answers');
  assert.equal(untouched.atLeast, true);
});

test('trueUnreadTotal sums a database count answer, and says "not yet known" until there is one', () => {
  assert.equal(model.trueUnreadTotal({ a: 3, b: '2' }), 5, 'a value however it arrived (a bigint reads as a string) still adds up');
  assert.equal(model.trueUnreadTotal({}), 0, 'answered, and the answer is zero — not "not yet known"');
  assert.equal(model.trueUnreadTotal(null), null, 'not yet loaded, or a database from before 0062: unknown, not zero');
});

test('a mailbox says what went wrong in a sentence the column fits, and keeps the whole of it', () => {
  const [box] = model.mailboxesFor([connection({
    last_error: 'Some mail filed away in Outlook may still show in this inbox until the daily check. inbox: Graph has not confirmed whether 1 message(s) left the inbox (Graph → 503: busy)'
  })], ME);
  assert.equal(model.mailboxNote(box), 'Some mail filed away in Outlook may still show in this inbox until the daily check.');
  assert.match(box.lastError, /Graph → 503/, 'the whole of it stays for a closer look');
  assert.equal(model.mailboxNote({ lastError: null }), null);
  assert.equal(model.mailboxNote({ lastError: 'Graph → 503: Service Unavailable' }), 'Graph → 503: Service Unavailable');
  assert.equal(model.mailboxNote({ lastError: 'x'.repeat(400) }).length, 160);
});

test('a long paste with no address in it does not freeze the composer', () => {
  /* Signature blocks and quoted threads can run to thousands of characters.
     Parsing must stay roughly linear in the input's length, not square it —
     the field would otherwise lock up the tab on a paste this ordinary. */
  const long = 'Kind regards,\n'.repeat(4000);
  const start = Date.now();
  const parsed = model.parseAddresses(long);
  assert.ok(Date.now() - start < 200, 'a 56,000-character paste with no address parses in well under 200ms');
  assert.deepEqual([...parsed.valid], []);
});

/* ── mail.js — the reading pane's own page ───────────────────────────────
   Nothing has ever loaded mail.js into a sandbox before this: its view is
   drawn like agenda-ui.js's and tickets-ui.js's, so it is tested the way
   tests/agenda-ui.test.mjs tests those — a page is a string, checked by
   regex, and document.querySelector only ever answers the handful of
   selectors the file itself asks for; there is no jsdom here to build a
   real one. Elements with an id ARE tracked here (a small registry rebuilt
   from every render's own HTML, by regex, fresh objects each time — the
   same "destroyed and rebuilt" identity a real innerHTML replace has), which
   is what lets repaintKeepingFocus's own real algorithm (copied from app.js,
   which this batch may not edit) be run for real rather than stubbed away:
   every element mail.js now gives an id specifically so this — and a real
   browser — can find it again after a redraw.
   mailComposer is mail-compose.js's own file (tests/mail-compose.test.mjs);
   stubbed here so this file tests only what mail.js itself does. */

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* over.data: { 'data-mail-star': someId } — bare attribute names, matching
   how mail.js's own click handler asks closest() for them ('[data-mail-
   star]'); the leading/trailing brackets are only ever in the SELECTOR, so
   both sides are compared the same way here (a mismatch here silently made
   an early check 46/47 above "pass" by never reaching the retry-read branch
   at all — found by hand-tracing every closest() call this click makes, in
   order, for the exact node a test passes it). */
function mtarget(over = {}) {
  const dataAttrs = over.data || {};
  const dataset = {};
  Object.entries(dataAttrs).forEach(([attr, value]) => {
    const key = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    dataset[key] = value;
  });
  let disabled = false;
  const el = {
    id: over.id || '', dataset, focused: 0, attrs: over.attrs || {}, value: over.value, href: over.href,
    focus() { this.focused++; mActiveElement = el; },
    setAttribute(name, value) { el.attrs[name] = value; },
    getAttribute: name => (name === 'href' ? over.href : el.attrs[name]),
    matches: selector => Boolean(over.matches && over.matches.includes(selector)),
    closest(selector) {
      const bare = /^\[([a-z-]+)\]$/.exec(selector);
      if (bare && Object.prototype.hasOwnProperty.call(dataAttrs, bare[1])) return el;
      if (over.mailto && selector === '.mail-body a[href^="mailto:" i]') return el;
      return null;
    }
  };
  /* A real browser blurs the focused element the instant it is disabled —
     well before whatever it was disabled for even answers — which is
     exactly the bug findings 5/9 traced by hand (mail.js's comment above
     refocusMailControl). Modelled here as a genuine accessor rather than a
     plain field, so a test disabling the very button that has the keyboard
     sees the same loss a real one would, and an explicit refocus by id is
     what is actually proven to matter, not a happy accident of this stand-in
     never losing focus the way a browser does. */
  Object.defineProperty(el, 'disabled', {
    get: () => disabled,
    set(value) { disabled = value; if (value && mActiveElement === el) mActiveElement = null; }
  });
  return el;
}
/* [data-mail-star], etc. — a click target with exactly one data attribute,
   the same shape as tests/agenda-ui.test.mjs's own target(). */
const dtarget = (attribute, value, id) => mtarget({ data: { [attribute]: value }, id });

let mActiveElement = null;

function loadMail(options = {}) {
  const {
    boxes = [connection({})], threads = [], route = ['mail'], loaded = true,
    mailboxesFailed = false, mailTruncated = [], notice = null, mailUnreadCounts = null,
    bodies = () => null, failedThreadIds = [], retriedThreadIds = [],
    markThreadReadResult = async () => ({}), starThreadResult = async () => ({}),
    reconnectMailboxResult = async () => 'https://login.microsoftonline.com/x',
    connectMailboxResult = async () => 'https://login.microsoftonline.com/x',
    disconnectMailboxResult = async () => ({}),
    mailAttachmentContentResult = async () => new Blob(['x'], { type: 'application/octet-stream' }),
    manager = false, me = ME, meEmail = null,
    tickets = [], contacts = [], team = [],
    /* null: no store.searchMail/moreMail at all — an older store the way the
       pre-0062 mail part answered, so nothing about them is asked for.
       Otherwise a function of (mailbox, folder) / (query) answering the
       { state, ... } shape those store methods themselves return. */
    searchMailAnswer = null, moreMailAnswer = null
  } = options;
  const searchMailCalls = [];
  const retrySearchMailCalls = [];
  const loadMoreMailCalls = [];

  const toasts = [];
  const navigated = [];
  const openedWith = [];
  const composerClosed = [];
  const mailAttachmentRequests = [];
  const listeners = {};
  const on = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  const timers = [];
  /* A plain in-memory stand-in for window.localStorage — real enough for
     the draft-across-a-sign-out persistence to read and write, seeded from
     options.storedItems the way a browser that already had something saved
     would be. */
  const storageMap = new Map(Object.entries(options.storedItems || {}));
  const localStorageStub = {
    getItem: k => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => { storageMap.set(k, String(v)); },
    removeItem: k => { storageMap.delete(k); }
  };

  const state = { page: 'mail', routeParts: [...route], mailFolder: 'Inbox', selectedMail: 0, renders: 0 };
  const queries = { mail: options.query || '' };
  const mailsArr = threads.map(t => ({ ...t }));

  let mainHtml = '';
  let elementsById = {};
  let conversationListEl = null;
  let readerEl = null;
  let searchInputEl = null;

  /* Rebuilt from scratch after every render, the way a real innerHTML
     replace destroys and recreates every element under it: an id found
     before is a DIFFERENT object after, so a piece of code holding on to
     the old one (rather than looking it up again by id) would notice. */
  function refreshRegistry() {
    const fresh = {};
    /* Every opening tag with an id, its href and every data-* attribute IT
       carries — so a registry element answers closest('[data-mail-star]')
       etc. the same way the real element it stands in for would, and a
       plain <a href> click can be followed the way a real browser follows
       one (see the click() method below). Attributes elsewhere on the page
       (a DIFFERENT element's data-mail-star, say) are never picked up: the
       match is scoped to this one tag's own text, ">" included. */
    for (const tag of mainHtml.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
      const idMatch = tag[0].match(/\bid="([^"]*)"/);
      if (!idMatch) continue;
      const hrefMatch = tag[0].match(/\bhref="([^"]*)"/);
      const data = {};
      for (const [, name, value] of tag[0].matchAll(/\s(data-[a-z-]+)="([^"]*)"/g)) data[name] = value;
      fresh[idMatch[1]] = mtarget({ id: idMatch[1], href: hrefMatch ? hrefMatch[1] : undefined, data });
    }
    elementsById = fresh;
    conversationListEl = /class="conversation-list"/.test(mainHtml) ? { scrollTop: 0 } : null;
    const withThread = mainHtml.match(/<div class="reader" data-thread-id="([^"]+)">/);
    readerEl = withThread ? { scrollTop: 0, dataset: { threadId: withThread[1] } }
      : /<div class="reader[ "]/.test(mainHtml) ? { scrollTop: 0, dataset: {} } : null;
    const q = mainHtml.match(/data-query="mail"[^>]*value="([^"]*)"/);
    searchInputEl = q ? { value: q[1], selectionStart: q[1].length, focus() {}, setSelectionRange() {} } : null;
  }

  const mainContainer = {
    contains(el) {
      if (!el) return false;
      if (el === conversationListEl || el === readerEl) return true;
      return Boolean(el && el.id) && elementsById[el.id] === el;
    }
  };

  /* Every <a> created for a download (mail.js's downloadAttachment, the same
     shape tickets-ui.js's own downloadFile already uses with no test of its
     own — the actual click is a real browser's to make of a real anchor).
     Tracked here so a test can see one was made and "clicked", without mail.js
     needing to know it is running in a sandbox rather than a real DOM. */
  const downloadLinks = [];
  const documentStub = {
    get activeElement() { return mActiveElement; },
    addEventListener: on,
    body: {
      classList: { toggle() {} }, addEventListener: on,
      dispatchEvent: e => { (listeners[e.type] || []).forEach(fn => fn(e)); return true; },
      appendChild() {}, removeChild() {}
    },
    createElement(tag) {
      const link = { tagName: String(tag || '').toLowerCase(), clicks: 0, click() { this.clicks++; }, remove() {} };
      if (link.tagName === 'a') downloadLinks.push(link);
      return link;
    },
    querySelector(selector) {
      if (selector === '#main') return mainContainer;
      if (selector === '.conversation-list') return conversationListEl;
      if (selector === '.reader') return readerEl;
      if (selector === '#modal') return { open: false };
      if (selector === '[data-query="mail"]') return searchInputEl;
      return null;
    },
    querySelectorAll(selector) {
      const m = /^#main #(.+)$/.exec(selector);
      return (m && elementsById[m[1]]) ? [elementsById[m[1]]] : [];
    },
    getElementById: id => elementsById[id] || null
  };

  /* app.js's own focusKey/repaintKeepingFocus, copied rather than
     reimplemented from a description: that file is a peer's to edit, not
     this batch's, but every OTHER page in this project reuses it by name as
     a plain top-level global (classic scripts share one scope) — this
     sandbox stands in for app.js the same way store.test.mjs's own PRELUDE
     stands in for it, so mail.js's real render-wrapper fix is exercised
     against the real algorithm it calls, not a description of one. */
  function focusKey(el) {
    if (el && el.closest && el.closest('#nav') && el.getAttribute && el.getAttribute('href')) {
      return { selector: '#nav ' + shellModel.focusSelector('a', { href: el.getAttribute('href') }), index: 0 };
    }
    const main = documentStub.querySelector('#main');
    if (!el || !main || el === main || !main.contains(el)) return null;
    if (el.matches && el.matches('h1[tabindex="-1"]')) return { selector: '#main h1', index: 0, heading: true };
    if (el.id) return { selector: '#main #' + cssStub.escape(el.id), index: 0 };
    return null;
  }
  function repaintKeepingFocus() {
    const active = mActiveElement;
    const key = focusKey(active);
    render();
    if (!key) return;
    const next = documentStub.querySelectorAll(key.selector)[key.index];
    if (!next || next === mActiveElement) return;
    if (key.heading && next.setAttribute) next.setAttribute('tabindex', '-1');
    next.focus({ preventScroll: true });
  }
  function repaintWhenIdle() { repaintKeepingFocus(); }
  /* mirrors workspace.js's own navigate() shape closely enough to exercise
     the real bug this batch fixes: a route change WITHIN Mail (opening a
     thread, or closing it to mark it unread) calls bare render(), not
     repaintKeepingFocus — workspace.js's own focusNewPage explicitly skips
     itself for a route change within Mail besides, since there is no <h1>
     either way — proving mail.js's OWN wrapper now compensates on its own,
     regardless of which path called render(). */
  function navigate(target) {
    navigated.push(target);
    const parts = String(target || 'overview').split('/');
    const samePage = state.page === parts[0] && state.routeParts.join('/') === parts.join('/');
    state.page = parts[0]; state.routeParts = parts;
    if (samePage) { repaintKeepingFocus(); return; }
    render();
  }
  function baseRenderForMail() {
    state.renders++;
    if (state.page !== 'mail') { mainHtml = '<h1>Some other page</h1>'; refreshRegistry(); return; }
    mainHtml = vm.runInContext('mailView()', context);
    refreshRegistry();
  }
  /* Reassigned by mail.js itself, the same way app.js's own render is —
     this is only the starting point mail.js's wrapper captures as its
     baseRender. */
  let render = baseRenderForMail;

  const cssStub = { escape: s => String(s) };
  const shellModel = { focusSelector: () => null };

  const context = vm.createContext({
    console,
    URLSearchParams,
    URL,
    esc: escape,
    icon: name => `<svg data-icon="${name}"></svg>`,
    pill: (label, tone) => `<span class="pill ${tone}">${escape(label)}</span>`,
    link: (route, label, ic = 'arrow', cls = 'text-btn') => `<a href="#${escape(route)}" class="${cls}">${escape(label)}</a>`,
    empty: (title, body) => `<div class="workspace-empty"><h3>${escape(title)}</h3><p>${escape(body)}</p></div>`,
    queryInput: (key, placeholder) => `<div class="list-search"><input data-query="${key}" aria-label="${escape(placeholder)}" placeholder="${escape(placeholder)}" value="${escape(queries[key])}"></div>`,
    toast: message => toasts.push(message),
    CSS: cssStub,
    shellModel,
    get page() { return state.page; }, set page(v) { state.page = v; },
    get routeParts() { return state.routeParts; }, set routeParts(v) { state.routeParts = v; },
    get mailFolder() { return state.mailFolder; }, set mailFolder(v) { state.mailFolder = v; },
    get selectedMail() { return state.selectedMail; }, set selectedMail(v) { state.selectedMail = v; },
    queries,
    tickets, contacts, team,
    mails: mailsArr,
    workspaceSession: { employee: me ? { id: me, email: meEmail } : null, isManager: () => manager },
    workspaceStore: {
      state: { loaded, mailboxes: boxes, mailboxesFailed, mailTruncated, notice, mailUnreadCounts },
      has: key => (options.hasParts ? options.hasParts.includes(key) : true),
      threadBody: id => bodies(id),
      threadFailed: id => failedThreadIds.includes(id),
      retryThread: id => retriedThreadIds.push(id),
      reload: () => Promise.resolve(),
      /* null (the default): as a store from before these methods existed —
         mail.js reads `typeof workspaceStore.searchMail !== 'function'` and
         falls back exactly as it does for an older store, so no test needs
         to know about search or "Load more" unless it is actually about
         them. */
      ...(searchMailAnswer ? {
        searchMail: query => { searchMailCalls.push(query); return searchMailAnswer(query); },
        retrySearchMail: query => retrySearchMailCalls.push(query)
      } : {}),
      ...(moreMailAnswer ? {
        moreMail: (mailbox, folder) => moreMailAnswer(mailbox, folder),
        loadMoreMail: (mailbox, folder) => loadMoreMailCalls.push({ mailbox, folder })
      } : {})
    },
    workspaceActions: {
      markThreadRead: (id, read) => markThreadReadResult(id, read),
      starThread: (id, starred) => starThreadResult(id, starred),
      reconnectMailbox: address => reconnectMailboxResult(address),
      connectMailbox: (address, whose) => connectMailboxResult(address, whose),
      disconnectMailbox: id => disconnectMailboxResult(id),
      mailAttachmentContent: id => { mailAttachmentRequests.push(id); return mailAttachmentContentResult(id); }
    },
    mailComposer: {
      open(init) { openedWith.push(init); return options.refuseComposerOpen ? false : true; },
      close() { composerClosed.push(true); },
      beforeRender() {}, afterRender() {},
      focus() {},
      hasContent: () => Boolean(options.composerHasContent),
      openSignatures() {},
      isOpen: () => Boolean(options.composerOpen),
      isSending: () => Boolean(options.composerSending),
      mode: () => options.composerMode || null,
      threadId: () => options.composerThreadId || null,
      snapshot: () => (options.composerSnapshot !== undefined ? options.composerSnapshot : null)
    },
    document: documentStub,
    window: {
      open: () => null, addEventListener: on, DOMPurify: null, mailHtml: null, location: { hash: '' },
      workspaceGate: options.gateLeaving ? { leaving: true } : null,
      localStorage: options.noLocalStorage ? null : localStorageStub
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    get render() { return render; }, set render(v) { render = v; },
    navigate, repaintKeepingFocus, repaintWhenIdle, focusKey,
    /* mailView/compose: mail.js reassigns these (`mailView = function…`)
       inside a 'use strict' IIFE — reassigning an identifier never declared
       anywhere throws there, exactly as it would for app.js's own real
       ones, so they are pre-declared here the same way app.js declares them
       before mail.js ever runs. */
    mailView: () => '', compose: () => {},
    /* app.js's own mailBody(), which sanitises an already-loaded message's
       body for display — a stand-in, since testing DOMPurify-based
       rendering needs a real DOM (see the top of this file). */
    mailBody: m => escape(String(m.body || ''))
  });
  context.window.workspaceSession = context.workspaceSession;
  context.window.workspaceStore = context.workspaceStore;

  vm.runInContext(readFileSync(new URL('../dist/mail-model.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../dist/mail.js', import.meta.url), 'utf8'), context);

  return {
    view: () => { render(); return mainHtml; },
    /* A plain <a href="#…"> click that no data-mail-* handler intercepts
       (preventDefault never called) is a real browser's to follow: it
       changes location.hash, which fires hashchange, which app.js's own
       listener answers with navigate(hash) — simulated here since this
       sandbox has no real anchor-following of its own. */
    click(node) {
      let prevented = false;
      (listeners.click || []).forEach(fn => fn({ target: node, preventDefault() { prevented = true; } }));
      if (!prevented && node && typeof node.href === 'string' && node.href.startsWith('#')) navigate(node.href.slice(1));
    },
    change: node => (listeners.change || []).forEach(fn => fn({ target: node })),
    keydown: (node, key = 'Escape') => {
      let prevented = false;
      (listeners.keydown || []).forEach(fn => fn({ target: node, key, preventDefault() { prevented = true; } }));
      return prevented;
    },
    input: node => (listeners.input || []).forEach(fn => fn({ target: node, stopImmediatePropagation() {} })),
    setActive: el => { mActiveElement = el; },
    active: () => mActiveElement,
    byId: id => elementsById[id] || null,
    fire: ms => { timers.filter(t => !t.cleared && t.ms === ms).forEach(t => { t.cleared = true; t.fn(); }); },
    renders: () => state.renders,
    route: () => state.routeParts,
    searchMailCalls, retrySearchMailCalls, loadMoreMailCalls,
    /* Fires the same beforeunload the gate's own reload does (data/gate.js
       leave()), and returns the event so a test can check whether the
       browser's own "leave site?" prompt was asked for. */
    signOut() {
      const event = { prevented: false, preventDefault() { this.prevented = true; }, returnValue: undefined };
      (listeners.beforeunload || []).forEach(fn => fn(event));
      return event;
    },
    signIn: () => (listeners['workspace:loaded'] || []).forEach(fn => fn({ type: 'workspace:loaded' })),
    storedDraft: () => {
      const raw = storageMap.get('veyago.mail.draft');
      return raw ? JSON.parse(raw) : null;
    },
    toasts, navigated, openedWith, composerClosed, mailAttachmentRequests, downloadLinks,
    compose: (...args) => vm.runInContext(`compose(${args.map(a => JSON.stringify(a)).join(',')})`, context)
  };
}

/* ── store.js's mail parts ───────────────────────────────────────────────
   store.js keeps every part of the workspace, not only mail's, so a sandbox
   for it needs the same stand-ins tests/store.test.mjs uses for the parts
   the load waits on (PARTS iterates every one of them together) — that file
   belongs to a peer session and is not this batch's to add to, so its
   PRELUDE/answers()/start() pattern is followed here rather than imported. */

const tick = () => new Promise(resolve => setImmediate(resolve));

const STORE_PRELUDE = `
const tickets = []; const projects = []; const contacts = []; const mails = [];
const events = []; const invoices = []; const team = []; const workspaceActivity = [];
const recordNotes = { tickets: {}, projects: {}, crm: {}, agenda: {}, companies: {} };
var renders = 0, idleRepaints = 0, toasts = [];
let page = 'mail';
function nav() {}
function render() { renders++; }
function repaintWhenIdle() { idleRepaints++; }
function toast(message) { toasts.push(message); }
const CAL = { loadFrom: '2026-09-14T00:00:00.000Z', loadTo: '2026-09-21T00:00:00.000Z',
              onChange() {}, contains() { return true; } };
`;

function storeAnswers(over = {}) {
  return {
    tickets: async () => [], projects: async () => [], allProjectTasks: async () => [],
    contacts: async () => [], team: async () => [], events: async () => [], invoices: async () => [],
    activity: async () => [], mailboxes: async () => [], mailThreads: async () => ({ threads: [], truncated: [] }),
    mailUnreadCounts: async () => ({}),
    mailMessages: async () => [{ body: 'hello', bodyHtml: '' }], overview: async () => ({}),
    revenueSeries: async () => [], revenueMix: async () => [], companies: async () => [],
    upcomingProjectEvents: async () => [], projectMembers: async () => [], projectContacts: async () => [],
    projectFiles: async () => [], projectBudgets: async () => [], notes: async () => [],
    ...over
  };
}

/* Mirrors store.test.mjs's start(): a real vm sandbox running the actual
   dist/data/store.js, its own captured setTimeout queue for retries, and
   here also a captured setInterval queue (that file stubs setInterval as a
   no-op, since none of ITS tests need to fire one) so the periodic mail
   refresh can be fired on demand instead of waited for. The clock is
   replaced the way tests/agenda-ui.test.mjs replaces it, so a "45 real
   seconds passed" recency check can be driven without an actual wait. */
function startStore(loaders, { visible = true } = {}) {
  const calls = {};
  const counted = source => Object.fromEntries(Object.entries(source).map(([name, fn]) => [name, (...args) => {
    calls[name] = (calls[name] || 0) + 1;
    return fn(...args);
  }]));
  const listeners = {};
  const on = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  const emit = type => (listeners[type] || []).forEach(fn => fn({ type }));
  const docState = { visibilityState: visible ? 'visible' : 'hidden' };
  const win = { workspaceData: counted(loaders), addEventListener: on };
  const intervals = [];
  const context = vm.createContext({
    console: { ...console, error() {}, warn() {} },
    window: win,
    document: {
      get visibilityState() { return docState.visibilityState; },
      body: { addEventListener: on, dispatchEvent: e => { (listeners[e.type] || []).forEach(fn => fn(e)); return true; } },
      addEventListener: on,
      querySelector: () => null,
      getElementById: () => null
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }
  });
  vm.runInContext(`const RealDate = Date; var __now = ${Date.now()};
    Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [__now])); } static now() { return __now; } };`, context);
  for (const file of ['data/load-model.js', 'projects-model.js', 'agenda-model.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  vm.runInContext(STORE_PRELUDE, context);
  vm.runInContext(readFileSync(new URL('../dist/data/store.js', import.meta.url), 'utf8'), context);
  return {
    store: win.workspaceStore,
    calls,
    setPage: value => vm.runInContext(`page = ${JSON.stringify(value)};`, context),
    setVisible: value => { docState.visibilityState = value ? 'visible' : 'hidden'; },
    advance: ms => vm.runInContext(`__now += ${ms};`, context),
    fireIntervals: ms => intervals.filter(t => t.ms === ms).forEach(t => t.fn()),
    signIn: () => emit('workspace:authed')
  };
}

/* mailModel.parseMailRoute only recognises a uuid-shaped thread id (an old
   position-based link must not open the wrong conversation) — these stand
   in for real ones the way tests/mail.test.mjs's own THREAD constant does. */
const T1 = 'd0000000-0000-4000-8000-000000000001';
const T2 = 'd0000000-0000-4000-8000-000000000002';

/* A thread as queries.js's mailThreads() hands it to the store — the shape
   store.test.mjs's own thread() helper uses too. */
const mthread = (over = {}) => ({
  id: T1, mailboxId: STUDIO, folder: 'inbox', unread: false, starred: false,
  sender: 'Anna Berg', email: 'anna@client.com', subject: 'Launch plan', preview: 'Can we move it?',
  time: '09:00', count: 1, ticketId: null, contactId: null,
  row: { last_message_at: '2026-09-14T09:00:00Z', message_count: 1 },
  ...over
});

test('the reading pane draws a thread\'s sender, subject and preview', () => {
  const page = loadMail({ threads: [mthread({ unread: true })] });
  const html = page.view();
  assert.match(html, /Anna Berg/);
  assert.match(html, /Launch plan/);
});

/* ── Attachments, importance and Bcc (finding: "nothing shows or fetches
   them; inline images vanish, importance and Bcc are never shown") ────── */

const openMessage = over => ({
  id: 'm1', sender: 'Anna Berg', email: 'anna@client.com', subject: 'Launch plan',
  body: 'See attached', bodyHtml: '', to: ['hello@veyago.cloud'], cc: [], bcc: [],
  date: 'Today', time: '09:00', outbound: false, importance: 'normal', attachments: [], ...over
});

test('an open message lists its own attachments, named and sized, each with a way to open it', () => {
  const page = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({
      attachments: [
        { id: 'att-1', name: 'Quote.pdf', size: 204800, contentType: 'application/pdf', isInline: false, contentId: null },
        { id: 'att-2', name: 'logo.png', size: 512, contentType: 'image/png', isInline: true, contentId: 'logo1' }
      ]
    })] : null
  });
  const html = page.view();
  assert.match(html, /data-mail-attachment="att-1"/);
  assert.match(html, /Quote\.pdf/);
  assert.match(html, /data-mail-attachment="att-2"/);
  assert.match(html, /logo\.png/);
});

test('a message with nothing attached draws no attachments list at all', () => {
  const page = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({ attachments: [] })] : null
  });
  assert.doesNotMatch(page.view(), /data-mail-attachment/);
});

test('a high-priority message says so; a normal one is not flagged at all', () => {
  const high = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({ importance: 'high' })] : null
  }).view();
  assert.match(high, /High priority/);
  const normal = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({ importance: 'normal' })] : null
  }).view();
  assert.doesNotMatch(normal, /High priority/);
});

test('a message with Bcc names them; one with none says nothing about Bcc at all', () => {
  const withBcc = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({ outbound: true, bcc: ['ops@northline.example'] })] : null
  }).view();
  assert.match(withBcc, /ops@northline\.example/);
  const noBcc = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({ bcc: [] })] : null
  }).view();
  assert.doesNotMatch(noBcc, /bcc/i);
});

test('clicking an attachment fetches its bytes and hands the browser a real download', async () => {
  const page = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({
      attachments: [{ id: 'att-1', name: 'Quote.pdf', size: 1024, contentType: 'application/pdf', isInline: false, contentId: null }]
    })] : null,
    mailAttachmentContentResult: async () => new Blob(['%PDF'], { type: 'application/octet-stream' })
  });
  page.view();
  const button = mtarget({ data: { 'data-mail-attachment': 'att-1', 'data-message-id': 'm1', 'data-thread-id': T1 } });
  page.click(button);
  assert.equal(button.disabled, true, 'disabled the instant it is clicked, before the fetch answers');
  await new Promise(setImmediate);
  assert.deepEqual(page.mailAttachmentRequests, ['att-1']);
  assert.equal(page.downloadLinks.length, 1, 'a real <a download> is made, the same shape tickets-ui.js\'s own downloadFile uses');
  assert.equal(page.downloadLinks[0].clicks, 1);
  assert.equal(page.downloadLinks[0].download, 'Quote.pdf');
  assert.equal(button.disabled, false, 're-enabled once the download is handed off');
});

test('an attachment that fails to fetch says so, in the function\'s own words', async () => {
  const page = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({
      attachments: [{ id: 'att-1', name: 'Quote.pdf', size: 1024, contentType: 'application/pdf', isInline: false, contentId: null }]
    })] : null,
    mailAttachmentContentResult: async () => { throw new Error('Reconnect this mailbox to open its attachments.'); }
  });
  page.view();
  page.click(mtarget({ data: { 'data-mail-attachment': 'att-1', 'data-message-id': 'm1', 'data-thread-id': T1 } }));
  await new Promise(setImmediate);
  assert.deepEqual(page.toasts, ['Reconnect this mailbox to open its attachments.']);
  assert.equal(page.downloadLinks.length, 0);
});

test('an inline image is asked for once — not again on a later render, and not for one already given up on', async () => {
  let deliveries = 0;
  const page = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({
      attachments: [
        { id: 'att-2', name: 'logo.png', size: 512, contentType: 'image/png', isInline: true, contentId: 'logo1' },
        { id: 'att-3', name: 'sig.gif', size: 200, contentType: 'image/gif', isInline: true, contentId: 'sig1' }
      ]
    })] : null,
    mailAttachmentContentResult: async id => {
      deliveries++;
      if (id === 'att-3') throw new Error('gone');
      return new Blob(['x'], { type: 'application/octet-stream' });
    }
  });
  page.view();                                  // first render: asks for both
  await new Promise(setImmediate);
  assert.deepEqual([...page.mailAttachmentRequests].sort(), ['att-2', 'att-3']);
  assert.equal(deliveries, 2);
  page.view();                                   // a second render must not ask again
  await new Promise(setImmediate);
  assert.equal(page.mailAttachmentRequests.length, 2, 'neither the resolved one nor the failed one is asked for twice');
  assert.equal(deliveries, 2);
});

test('an inline image with no attachment behind it (a non-image cid the model already dropped) asks for nothing', () => {
  const page = loadMail({
    threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1],
    bodies: id => id === T1 ? [openMessage({ attachments: [
      { id: 'att-1', name: 'Quote.pdf', size: 1024, contentType: 'application/pdf', isInline: false, contentId: null }
    ] })] : null
  });
  page.view();
  assert.deepEqual(page.mailAttachmentRequests, [], 'a non-inline attachment is never auto-fetched, only asked for on its own click');
});

/* ── A failed mailbox list (finding: "A failed mailbox list says…") ────── */

test('a failed mailbox list says so in the folder column, not "no mailbox connected"', () => {
  const failed = loadMail({ boxes: [], mailboxesFailed: true }).view();
  assert.match(failed, /Mailboxes did not load/);
  assert.doesNotMatch(failed, /No mailbox connected/);
  const genuinelyNone = loadMail({ boxes: [], mailboxesFailed: false }).view();
  assert.match(genuinelyNone, /No mailbox connected/);
  assert.doesNotMatch(genuinelyNone, /Mailboxes did not load/);
});

test('compose says the mailboxes failed to load, not to connect one that already is', () => {
  const page = loadMail({ boxes: [], mailboxesFailed: true });
  page.compose();
  assert.deepEqual(page.toasts, ['Your mailboxes did not load. Try again in a moment.']);
  const ok = loadMail({ boxes: [], mailboxesFailed: false });
  ok.compose();
  assert.deepEqual(ok.toasts, ['Connect a mailbox to send mail from the workspace.']);
});

/* ── Unread counts that may be a floor, not the true number ─────────────── */

test('an unread badge past the per-folder cap says "or more" for a screen reader, and shows a +', () => {
  const cut = loadMail({
    threads: [mthread({ unread: true })],
    mailTruncated: [`${STUDIO}|inbox`]
  }).view();
  assert.match(cut, /<small class="mail-count">1\+<span class="sr-only"> unread, or more<\/span><\/small>/);
  const whole = loadMail({ threads: [mthread({ unread: true })] }).view();
  assert.match(whole, /<small class="mail-count">1<span class="sr-only"> unread<\/span><\/small>/);
  assert.doesNotMatch(whole, /1\+/);
});

test('once mail_unread_counts() has answered, every badge shows the real count instead of the loaded-list floor', () => {
  const html = loadMail({
    threads: [mthread({ unread: true })],
    mailUnreadCounts: { [STUDIO]: 9 },
    mailTruncated: [`${STUDIO}|inbox`]   // would otherwise say "1+" — the true count is never a floor
  }).view();
  assert.match(html, /<small class="mail-count">9<span class="sr-only"> unread<\/span><\/small>/);
  assert.doesNotMatch(html, /9\+/);
  assert.doesNotMatch(html, />1</, 'the stale loaded-list count of 1 is not shown anywhere once the true one has landed');
});

/* ── A failed mark-as-read (finding 5) ───────────────────────────────────── */

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a failed mark-as-read says so and offers a retry, instead of staying silently bold', async () => {
  const page = loadMail({
    threads: [mthread({ unread: true })],
    route: ['mail', 'all', 'inbox', T1],
    markThreadReadResult: async () => { throw new Error('Could not mark the conversation as read: network error'); },
    bodies: () => [{ id: 'm1', body: 'hi', outbound: false, sender: 'Anna', initial: 'A', date: 'Today', time: '09:00', to: [], cc: [] }]
  });
  page.view();
  await settle();
  const after = page.view();
  assert.deepEqual(page.toasts, ['Could not mark the conversation as read: network error']);
  assert.match(after, /Could not mark this conversation as read\./);
  assert.match(after, new RegExp(`data-mail-retry-read="${T1}"`));
});

test('retrying a failed mark-as-read clears the note and tries again', async () => {
  let attempts = 0;
  const page = loadMail({
    threads: [mthread({ unread: true })],
    route: ['mail', 'all', 'inbox', T1],
    markThreadReadResult: async () => { attempts++; if (attempts === 1) throw new Error('offline'); return {}; },
    bodies: () => [{ id: 'm1', body: 'hi', outbound: false, sender: 'Anna', initial: 'A', date: 'Today', time: '09:00', to: [], cc: [] }]
  });
  page.view();
  await settle();
  assert.match(page.view(), /Could not mark this conversation as read\./);
  page.click(dtarget('data-mail-retry-read', T1));
  await settle();
  assert.equal(attempts, 2);
  assert.doesNotMatch(page.view(), /Could not mark this conversation as read\./);
});

/* ── "Load more": older mail than mailThreads() loaded (finding 2) ──────── */

test('a "Load more" button appears while there may be older mail, and asks the store for the folder shown', () => {
  const page = loadMail({
    threads: [mthread({ id: T1 })],
    moreMailAnswer: () => ({ state: 'ready', more: true, threads: [] })
  });
  const html = page.view();
  assert.match(html, /Load older mail/);
  const button = page.byId('mail-load-more');
  page.click(button);
  assert.deepEqual(page.loadMoreMailCalls, [{ mailbox: 'all', folder: 'inbox' }]);
});

test('no "Load more" once a page came back short of the cap, or while a search is on screen', () => {
  const done = loadMail({ threads: [mthread()], moreMailAnswer: () => ({ state: 'ready', more: false, threads: [] }) });
  assert.doesNotMatch(done.view(), /Load older mail/);

  const searching = loadMail({
    threads: [mthread()], query: 'x',
    moreMailAnswer: () => ({ state: 'ready', more: true, threads: [] }),
    searchMailAnswer: () => ({ state: 'ready', results: [] })
  });
  assert.doesNotMatch(searching.view(), /Load older mail/, 'a search already answers from the whole mailbox in one go');
});

test('an older page "Load more" already fetched is appended to the list, not shown instead of it', () => {
  const OLDER = mthread({ id: 'd0000000-0000-4000-8000-000000000077', subject: 'Older one' });
  const page = loadMail({
    threads: [mthread({ id: T1, subject: 'Newer one' })],
    moreMailAnswer: () => ({ state: 'ready', more: false, threads: [OLDER] })
  });
  const html = page.view();
  assert.match(html, /Newer one/);
  assert.match(html, /Older one/);
  assert.match(html, /2 conversations/);
});

test('a failed "Load more" says so, and its own label doubles as the retry', () => {
  const page = loadMail({ threads: [mthread()], moreMailAnswer: () => ({ state: 'failed', more: true, threads: [] }) });
  assert.match(page.view(), /Older mail did not load — try again/);
});

/* ── Next/previous and mark all as read (finding 3) ──────────────────────── */

test('j/ArrowDown opens the next conversation on screen, k/ArrowUp the previous one', () => {
  const page = loadMail({
    threads: [mthread({ id: T1, subject: 'First' }), mthread({ id: T2, subject: 'Second' })],
    route: ['mail', 'all', 'inbox', T1]
  });
  page.view();
  page.keydown(mtarget(), 'j');
  assert.deepEqual(page.navigated, [`mail/all/inbox/${T2}`]);
  page.view();
  page.keydown(mtarget(), 'k');
  assert.deepEqual(page.navigated.slice(-1), [`mail/all/inbox/${T1}`]);
});

test('with nothing open, j opens the first conversation shown; k stays there rather than going before it', () => {
  const page = loadMail({ threads: [mthread({ id: T1 }), mthread({ id: T2 })] });
  page.view();
  page.keydown(mtarget(), 'j');
  assert.deepEqual(page.navigated, [`mail/all/inbox/${T1}`]);
});

test('j/k does nothing at the ends of the list, or with nothing in it', () => {
  const page = loadMail({ threads: [mthread({ id: T1 })], route: ['mail', 'all', 'inbox', T1] });
  page.view();
  page.keydown(mtarget(), 'j');
  assert.deepEqual(page.navigated, [], 'already the last (and only) conversation');

  const empty_ = loadMail({ threads: [] });
  empty_.view();
  empty_.keydown(mtarget(), 'j');
  assert.deepEqual(empty_.navigated, []);
});

test('j/k does nothing while a draft is open, so a stray letter cannot carry someone away from it', () => {
  const page = loadMail({
    threads: [mthread({ id: T1 }), mthread({ id: T2 })], route: ['mail', 'all', 'inbox', T1],
    composerOpen: true, composerThreadId: T1
  });
  page.view();
  page.keydown(mtarget(), 'j');
  assert.deepEqual(page.navigated, [], 'nothing moved — a draft answering this very conversation is open');
});

test('"Mark all as read" shows only while something on screen is unread, and marks each one', async () => {
  const marked = [];
  const page = loadMail({
    threads: [mthread({ id: T1, unread: true }), mthread({ id: T2, unread: true, subject: 'Other' })],
    markThreadReadResult: async id => { marked.push(id); return {}; }
  });
  const html = page.view();
  assert.match(html, /Mark all as read/);
  page.click(page.byId('mail-mark-all-read'));
  await settle();
  assert.deepEqual([...marked].sort(), [T1, T2].sort());
});

test('no "Mark all as read" once nothing on screen is unread', () => {
  const page = loadMail({ threads: [mthread({ unread: false })] });
  assert.doesNotMatch(page.view(), /Mark all as read/);
});

/* ── Connecting or disconnecting a mailbox (finding 5) ───────────────────── */

test('"Connect a mailbox" shows for a manager only — the same rule microsoft-connect itself enforces for a brand new connection', () => {
  const manager = loadMail({ manager: true }).view();
  assert.match(manager, /Connect a mailbox/);
  const staff = loadMail({ manager: false }).view();
  assert.doesNotMatch(staff, /Connect a mailbox/);
});

test('Disconnect sits beside Reconnect for every mailbox this session may act on', () => {
  const html = loadMail({
    manager: true,
    boxes: [
      connection({ status: 'needs_reauth', is_live: false }),
      connection({ id: PERSONAL, account_label: 'cassian@veyago.cloud', employee_id: ME, status: 'needs_reauth', is_live: false })
    ]
  }).view();
  assert.match(html, /aria-label="Disconnect hello@veyago\.cloud"/);
  assert.match(html, /aria-label="Disconnect cassian@veyago\.cloud"/);
});

test('a mailbox this session may not act on shows its connection, but neither Reconnect nor Disconnect', () => {
  const box = connection({});
  const html = loadMail({ manager: false, boxes: [box], route: ['mail', box.id, 'inbox'] }).view();
  assert.match(html, /hello@veyago\.cloud/, 'the connection itself is still shown');
  assert.doesNotMatch(html, /data-mail-disconnect/);
  assert.doesNotMatch(html, /data-mail-reconnect/);
});

/* ── A draft carried across a sign-out (finding 4) ───────────────────────── */

test('signing out saves an open draft, keyed to who is signed in, and does not hold up the reload with a prompt', () => {
  const SNAP = { mode: 'new', connectionId: STUDIO, threadId: null, messageId: null, to: ['ana@x.example'], cc: [], bcc: [], subject: 'Kick-off', bodyText: 'See you Monday' };
  const page = loadMail({ gateLeaving: true, composerHasContent: true, me: ME, composerSnapshot: SNAP });
  const event = page.signOut();
  assert.equal(event.prevented, false, 'the gate is already reloading — nothing here should hold that up with a confirmation');
  assert.deepEqual(page.storedDraft(), { employeeId: ME, draft: SNAP });
});

test('signing out with nothing worth saving leaves nothing behind', () => {
  const page = loadMail({ gateLeaving: true, composerHasContent: false });
  page.signOut();
  assert.equal(page.storedDraft(), null);
});

test('signing back in as the same person restores the draft, opening the composer with it', () => {
  const SNAP = { mode: 'new', connectionId: STUDIO, threadId: null, messageId: null, to: ['ana@x.example'], cc: [], bcc: [], subject: 'Kick-off', bodyText: 'See you Monday' };
  const page = loadMail({ me: ME, storedItems: { 'veyago.mail.draft': JSON.stringify({ employeeId: ME, draft: SNAP }) } });
  page.signIn();
  assert.equal(page.openedWith.length, 1);
  assert.equal(page.openedWith[0].connectionId, STUDIO);
  assert.equal(page.openedWith[0].subject, 'Kick-off');
  assert.equal(page.storedDraft(), null, 'consumed — read once, not restored again on the next load');
  assert.deepEqual(page.toasts, ['Picked up an unfinished message from before you signed out.']);
});

test('a different person signing in never sees a stranger\'s saved draft, and it is not left waiting for its owner either', () => {
  const page = loadMail({
    me: 'a0000000-0000-4000-8000-000000000099',
    storedItems: { 'veyago.mail.draft': JSON.stringify({ employeeId: ME, draft: { mode: 'new', connectionId: STUDIO, to: [], cc: [], bcc: [], subject: '', bodyText: 'private' } }) }
  });
  page.signIn();
  assert.equal(page.openedWith.length, 0);
  assert.equal(page.storedDraft(), null, 'consumed rather than left on a shared computer indefinitely, waiting for a sign-in that may never come');
});

test('a saved draft with no mailbox to send it from is not restored, and says so rather than failing silently', () => {
  const page = loadMail({
    me: ME, boxes: [],
    storedItems: { 'veyago.mail.draft': JSON.stringify({ employeeId: ME, draft: { mode: 'new', connectionId: STUDIO, to: [], cc: [], bcc: [], subject: '', bodyText: 'x' } }) }
  });
  page.signIn();
  assert.equal(page.openedWith.length, 0);
  assert.match(page.toasts[0], /could not be restored/);
});

test('nothing is restored while a draft is already open', () => {
  const page = loadMail({
    me: ME, composerOpen: true,
    storedItems: { 'veyago.mail.draft': JSON.stringify({ employeeId: ME, draft: { mode: 'new', connectionId: STUDIO, to: [], cc: [], bcc: [], subject: '', bodyText: 'x' } }) }
  });
  page.signIn();
  assert.equal(page.openedWith.length, 0);
});

/* ── Focus kept through a redraw (finding 9) ─────────────────────────────
   Opening a thread, starring one or marking one unread all rebuild #main —
   through render(), whichever path called it — and Mail draws no <h1> for
   workspace.js's own after-navigate rule to fall back on. These check that
   mail.js's own render wrapper puts the keyboard back by id, the same
   general mechanism repaintKeepingFocus uses (app.js, reproduced in this
   sandbox above) — real enough to exercise the actual algorithm, though a
   real browser is still the last word on focus itself (see the top of this
   file for why nothing here can be a full substitute for one). */

test('opening a thread through a route change (not repaintKeepingFocus) keeps the keyboard on that thread\'s own row', () => {
  const page = loadMail({ threads: [mthread({ id: T1 }), mthread({ id: T2, subject: 'Other' })] });
  page.view();
  const row = page.byId(`mail-thread-${T1}`);
  assert.ok(row, 'the row exists after the first render');
  page.setActive(row);
  page.click(row);
  assert.deepEqual(page.navigated, [`mail/all/inbox/${T1}`], 'a real <a> click is a route change, handled by navigate()');
  const freshRow = page.byId(`mail-thread-${T1}`);
  assert.notEqual(freshRow, row, 'a fresh object, the way a real innerHTML replace makes a new element');
  assert.equal(freshRow.focused, 1, 'the keyboard followed it to the new one');
});

test('starring a conversation keeps the keyboard on the star button once it says the new state', async () => {
  const page = loadMail({ threads: [mthread({ unread: false, starred: false })], route: ['mail', 'all', 'inbox', T1], bodies: () => [] });
  page.view();
  const button = page.byId(`mail-star-${T1}`);
  page.setActive(button);
  page.click(button);
  await settle();
  const after = page.byId(`mail-star-${T1}`);
  assert.notEqual(after, button);
  assert.equal(after.focused, 1);
  assert.match(page.view(), /aria-pressed="true"/, 'the star really did toggle');
});

test('a star that fails to save puts the keyboard right back on the same button, re-enabled', async () => {
  const page = loadMail({
    threads: [mthread({ starred: false })], route: ['mail', 'all', 'inbox', T1], bodies: () => [],
    starThreadResult: async () => { throw new Error('That did not save.'); }
  });
  page.view();
  const button = page.byId(`mail-star-${T1}`);
  button.disabled = false;
  page.setActive(button);
  page.click(button);
  await settle();
  assert.equal(button.disabled, false, 're-enabled after the failure');
  assert.equal(button.focused, 1);
  assert.deepEqual(page.toasts, ['That did not save.']);
});

test('marking a conversation unread closes it and puts the keyboard on its row in the list, not <body>', async () => {
  const page = loadMail({ threads: [mthread({ unread: false })], route: ['mail', 'all', 'inbox', T1], bodies: () => [] });
  page.view();
  const button = page.byId(`mail-unread-${T1}`);
  page.setActive(button);
  page.click(button);
  await settle();
  assert.deepEqual(page.route(), ['mail', 'all', 'inbox'], 'the reader closed, or it would mark it read again at once');
  const row = page.byId(`mail-thread-${T1}`);
  assert.ok(row, 'the row still exists once the list redraws');
  assert.equal(row.focused, 1);
  assert.match(page.view(), /class="thread-item unread"/, 'shown bold again');
});

test('a mark-unread that fails leaves the reader open and the keyboard on its own button', async () => {
  const page = loadMail({
    threads: [mthread({ unread: false })], route: ['mail', 'all', 'inbox', T1], bodies: () => [],
    markThreadReadResult: async () => { throw new Error('That did not save.'); }
  });
  page.view();
  const button = page.byId(`mail-unread-${T1}`);
  button.disabled = false;
  page.setActive(button);
  page.click(button);
  await settle();
  assert.equal(button.disabled, false);
  assert.equal(button.focused, 1);
  assert.deepEqual(page.route(), ['mail', 'all', 'inbox', T1], 'never closed: nothing was saved');
});

test('folding a message open again keeps the keyboard on it — the generic redraw-focus mechanism, not one of the id-based writes above', () => {
  const page = loadMail({
    threads: [mthread()], route: ['mail', 'all', 'inbox', T1],
    bodies: () => [
      { id: 'm1', body: 'first', outbound: false, sender: 'Anna', initial: 'A', date: 'Today', time: '09:00', to: [], cc: [] },
      { id: 'm2', body: 'second', outbound: false, sender: 'Anna', initial: 'A', date: 'Today', time: '09:05', to: [], cc: [] }
    ]
  });
  page.view();
  const collapsed = page.byId('mail-expand-m1');
  assert.ok(collapsed, 'the older message starts folded');
  page.setActive(collapsed);
  page.click(dtarget('data-mail-expand', 'm1'));
  const opened = page.byId('mail-expand-m1');
  assert.notEqual(opened, collapsed);
  assert.equal(opened.focused, 1);
  assert.match(page.view(), /data-mail-expand="m1" aria-expanded="true"/);
});

/* ── Accessibility: unread/starred in words, and Reconnect told apart ──── */

test('a thread row says unread and starred in words a screen reader gets, ahead of the sender', () => {
  const html = loadMail({ threads: [mthread({ unread: true, starred: true })] }).view();
  assert.match(html, /<strong><span class="sr-only">Unread\. Starred\. <\/span><span class="unread-dot" aria-hidden="true"><\/span>Anna Berg<\/strong>/);
  assert.match(html, /<span class="thread-star" aria-hidden="true">★<\/span>/, 'the icon itself is decorative now — the words carry the meaning');
  const plain = loadMail({ threads: [mthread({ unread: false, starred: false })] }).view();
  assert.doesNotMatch(plain, /sr-only">Unread/);
});

test('every Reconnect button is named for the mailbox it reconnects, not just "Reconnect"', () => {
  const html = loadMail({
    manager: true,   // canReconnect() offers the studio's own shared mailbox to a manager only
    boxes: [
      connection({ status: 'needs_reauth', is_live: false }),
      connection({ id: PERSONAL, account_label: 'cassian@veyago.cloud', employee_id: ME, status: 'needs_reauth', is_live: false })
    ]
  }).view();
  assert.match(html, /aria-label="Reconnect hello@veyago\.cloud"/);
  assert.match(html, /aria-label="Reconnect cassian@veyago\.cloud"/);
});

/* ── A mailto link in a message opens the composer, not a new tab ───────
   mail-html.js itself (setting no target/rel on a mailto: link) needs a
   real DOM to verify — DOMPurify and the browser's own style parser both
   run inside render(), which this sandbox cannot host either (see the top
   of this file) — read directly instead: dist/data/mail-html.js's anchor
   loop now returns early for a mailto: href before setting target/rel. This
   checks mail.js's own half: what happens once such a link is clicked. */

test('clicking a mailto: link in a message opens the composer with its address, subject and body', () => {
  const page = loadMail({ threads: [mthread()], route: ['mail', 'all', 'inbox', T1], bodies: () => [] });
  page.view();
  page.click(mtarget({ href: 'mailto:ops@northline.example?subject=Re%3A%20invoice&body=Hi%20there', mailto: true }));
  assert.equal(page.openedWith.length, 1);
  assert.deepEqual([...page.openedWith[0].to], ['ops@northline.example']);
  assert.equal(page.openedWith[0].subject, 'Re: invoice');
  assert.equal(page.openedWith[0].bodyText, 'Hi there');
});

test('a mailto: link with more than one address opens the composer with all of them', () => {
  const page = loadMail({ threads: [mthread()], route: ['mail', 'all', 'inbox', T1], bodies: () => [] });
  page.view();
  page.click(mtarget({ href: 'mailto:a@northline.example,b@northline.example', mailto: true }));
  assert.deepEqual([...page.openedWith[0].to], ['a@northline.example', 'b@northline.example']);
});

test('a mailto: link with no address at all opens nothing', () => {
  const page = loadMail({ threads: [mthread()], route: ['mail', 'all', 'inbox', T1], bodies: () => [] });
  page.view();
  page.click(mtarget({ href: 'mailto:?subject=Hi', mailto: true }));
  assert.equal(page.openedWith.length, 0);
});

/* ── Mail's own search is debounced (finding 11) ─────────────────────────
   workspace.js's shared [data-query] handler (redrawPreservingFocus) is a
   peer file's and rebuilds the page on every keystroke for all four of its
   searches; mail's own listener, added in front of it on the capture phase,
   is what is tested here — not that shared handler itself. */

test('typing in mail\'s own search does not redraw until the typing pauses, then asks the database rather than narrowing the loaded list', () => {
  const page = loadMail({
    threads: [mthread({ subject: 'Launch plan' }), mthread({ id: T2, subject: 'Something else' })],
    searchMailAnswer: () => ({ state: 'ready', results: [] })
  });
  const before = page.renders();
  const input = mtarget({ matches: ['[data-query="mail"]'] });
  input.value = 'launch';
  input.selectionStart = 6;
  input.setSelectionRange = () => {};
  page.input(input);
  assert.equal(page.renders(), before, 'no redraw yet');
  page.fire(200);
  assert.equal(page.renders(), before + 1, 'exactly one, once the debounce elapses');
  assert.deepEqual(page.searchMailCalls, ['launch'], 'search_mail spans the whole mailbox, not just what mailThreads() loaded');
  const html = page.view();
  assert.match(html, /Search results/, 'search replaces the plain folder list rather than narrowing it — the loaded window could not have found an older match anyway');
});

/* ── A word search across the whole mailbox, not just the loaded page
   (finding 1) ────────────────────────────────────────────────────────── */

test('a search still loading, or that failed, says so — never a silently empty list', () => {
  const loading = loadMail({ query: 'kickoff', searchMailAnswer: () => ({ state: 'loading', results: [] }) });
  assert.match(loading.view(), /Searching…/);

  const failed = loadMail({ query: 'kickoff', searchMailAnswer: () => ({ state: 'failed', results: [] }) });
  const html = failed.view();
  assert.match(html, /The search did not run\./);
  assert.match(html, /data-mail-search-retry/);
});

test('a search hit for a thread the loaded list already has shows its real sender, and opens it', () => {
  const HIT = { threadId: T1, mailboxId: STUDIO, subject: 'Kickoff notes', preview: 'See attached', time: 'Sep 1' };
  const page = loadMail({
    query: 'kickoff',
    threads: [mthread({ id: T1, sender: 'Ana Lima', unread: true })],
    searchMailAnswer: () => ({ state: 'ready', results: [HIT] })
  });
  const html = page.view();
  assert.match(html, /Ana Lima/, 'the known thread\'s own sender, not "Unknown sender"');
  const hit = page.byId(`mail-thread-${T1}`);
  assert.ok(hit);
  page.click(hit);
  assert.deepEqual(page.navigated, [`mail/all/inbox/${T1}`]);
});

test('a search hit for a thread outside the loaded window still opens, without guessing its read or starred state', () => {
  const OUTSIDE = 'd0000000-0000-4000-8000-000000000099';
  const HIT = { threadId: OUTSIDE, mailboxId: STUDIO, subject: 'Old renewal', preview: 'See attached', time: 'Sep 1' };
  const page = loadMail({
    query: 'renewal',
    threads: [],
    route: ['mail', 'all', 'inbox', OUTSIDE],
    searchMailAnswer: () => ({ state: 'ready', results: [HIT] }),
    bodies: () => [{ id: 'm1', body: 'hi', outbound: false, sender: 'Old Client', initial: 'O', date: 'Today', time: '09:00', to: [], cc: [] }]
  });
  const html = page.view();
  assert.match(html, /Old renewal/, 'the reader opens it — subject and mailbox from the hit itself');
  assert.doesNotMatch(html, /data-mail-star=/, 'starring is withheld: the true starred state is not something a search hit carries');
  assert.doesNotMatch(html, /data-mail-unread=/, 'so is mark-as-unread, for the same reason');
  assert.match(html, /data-mail-answer="reply"/, 'replying only needs the id, which this does have');
});

test('a failed mailbox list says so, rather than reading as no mailboxes connected', async () => {
  let s_ids = null;
  const s = startStore(storeAnswers({
    mailboxes: async () => { throw new Error('Failed to fetch'); },
    mailThreads: async (folders, ids) => { s_ids = ids; return { threads: [], truncated: [] }; }
  }));
  await s.store.load();
  assert.equal(s.store.state.mailboxesFailed, true);
  /* [...spread]: an array built inside the sandbox has the sandbox's own
     Array.prototype, which strict deep-equality rejects (see the top of this
     file) even though the contents are the same. */
  assert.deepEqual([...s.store.state.mailboxes], []);
  /* threads still load, with no connection filter — RLS decides, rather than
     mail going down entirely because the list of connections could not be read */
  assert.deepEqual([...s_ids], []);
  assert.equal(s.store.has('mail'), true, 'the part still "arrives": threads answered fine');
});

test('a mailbox list that loads fine says nothing failed', async () => {
  const s = startStore(storeAnswers());
  await s.store.load();
  assert.equal(s.store.state.mailboxesFailed, false);
});

test('recovering from a failed mailbox list is a change worth a repaint even onto the same empty list', async () => {
  let broken = true;
  const s = startStore(storeAnswers({
    mailboxes: async () => { if (broken) throw new Error('Failed to fetch'); return []; }
  }));
  await s.store.load();
  broken = false;
  await s.store.load({ quiet: true });
  assert.equal(s.store.state.mailboxesFailed, false, 'recovered');
});

test('a write elsewhere keeps an open conversation\'s messages: mail is not exempt from the workspace\'s own keep-what-did-not-change rule', async () => {
  const thread = count => ({
    id: 'th1', subject: 'Hello', folder: 'inbox', unread: false,
    body: undefined, bodyHtml: undefined, thread: undefined,
    row: { id: 'th1', last_message_at: '2026-09-14T09:00:00Z', message_count: count }
  });
  let count = 2;
  const s = startStore(storeAnswers({ mailThreads: async () => ({ threads: [thread(count)], truncated: [] }) }));
  await s.store.load();
  assert.equal(s.store.threadBody('th1'), null, 'fetched when first opened');
  await tick();
  assert.equal(s.calls.mailMessages, 1);

  /* store.after() calls load() with no options — the same as a save on an
     entirely unrelated ticket or task reloading the whole workspace, mail
     included. Not `{ quiet: true }`: this is the NON-quiet path. */
  await s.store.load();
  assert.ok(s.store.threadBody('th1'), 'the conversation everyone was reading is still there');
  assert.equal(s.calls.mailMessages, 1, 'not fetched again for a thread that did not change');

  count = 3;
  await s.store.load();
  assert.equal(s.store.threadBody('th1'), null, 'a genuinely new message in it is still fetched again');
});

test('mail refreshes on its own while its own page is open, without waiting for the whole workspace\'s two-minute clock', async () => {
  let loads = 0;
  const s = startStore(storeAnswers({ mailThreads: async () => { loads++; return { threads: [], truncated: [] }; } }));
  s.setPage('mail');
  s.signIn();
  await tick();
  assert.equal(loads, 1);
  s.advance(45000);
  s.fireIntervals(45000);
  await tick();
  assert.equal(loads, 2, 'asked again on its own tick');
});

test('mail does not refresh on its own tick for a page other than Mail, a hidden tab, or before sign-in\'s first load', async () => {
  let loads = 0;
  const s = startStore(storeAnswers({ mailThreads: async () => { loads++; return { threads: [], truncated: [] }; } }));
  s.setPage('overview');
  s.advance(45000);
  s.fireIntervals(45000);
  await tick();
  assert.equal(loads, 0, 'not before anyone has signed in, whatever the page');

  s.signIn();
  await tick();
  assert.equal(loads, 1);
  s.advance(45000);
  s.fireIntervals(45000);
  await tick();
  assert.equal(loads, 1, 'not on the Overview');

  s.setPage('mail');
  s.setVisible(false);
  s.advance(45000);
  s.fireIntervals(45000);
  await tick();
  assert.equal(loads, 1, 'not while the tab is hidden');

  s.setVisible(true);
  s.advance(45000);
  s.fireIntervals(45000);
  await tick();
  assert.equal(loads, 2, 'visible again, on Mail: it catches up');
});

test('a mail refresh already just asked for (by the two-minute clock or a write) is not asked for again a moment later', async () => {
  let loads = 0;
  const s = startStore(storeAnswers({ mailThreads: async () => { loads++; return { threads: [], truncated: [] }; } }));
  s.setPage('mail');
  s.signIn();
  await tick();
  assert.equal(loads, 1);
  await s.store.load({ quiet: true });
  assert.equal(loads, 2, 'e.g. the whole workspace\'s own refresh, moments before mail\'s own tick');
  s.fireIntervals(45000);
  await tick();
  assert.equal(loads, 2, 'too soon since the last one: mail\'s own tick waits its turn');
});
