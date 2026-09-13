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
