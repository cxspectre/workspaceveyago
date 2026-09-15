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
