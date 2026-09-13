/* Mail's logic, without a page: which mailboxes a person has, what a mail URL
   means, which threads a folder shows, and what an email's inline styles are
   allowed to do. Loaded into a sandbox the way <script> tags run them.
   Run from the repo root with: node --test

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
const cleanStyle = vm.runInContext('window.mailHtml.cleanStyle', htmlContext);

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
  const boxes = model.mailboxesFor([connection({ employee_id: ME, id: PERSONAL })], null);
  assert.equal(boxes.length, 0);
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

/* ── Email inline styles ─────────────────────────────────────────────── */

test('ordinary email styling survives', () => {
  assert.equal(cleanStyle('color: #333; font-size: 14px; padding: 0 4px', { showImages: false }),
    'color: #333; font-size: 14px; padding: 0 4px');
  assert.equal(cleanStyle('position: relative; font-family: "Segoe UI", Arial', { showImages: false }),
    'position: relative; font-family: "Segoe UI", Arial');
});

test('a CSS url() is a remote image, so it is blocked with the others', () => {
  assert.equal(cleanStyle('color: red; background: url(https://track.example/p.gif)', { showImages: false }),
    'color: red');
  assert.equal(cleanStyle('background-image: url("https://cdn.example/hero.png")', { showImages: true }),
    'background-image: url("https://cdn.example/hero.png")', 'shown once the reader asks');
  assert.equal(cleanStyle('background: url(http://plain.example/x.png)', { showImages: true }), '',
    'never plain http');
  assert.equal(cleanStyle('background: -webkit-image-set(url(https://a.example/1.png) 1x)', { showImages: false }), '');
});

test('an email cannot pin itself over the workspace or run anything', () => {
  assert.equal(cleanStyle('position: fixed; inset: 0; z-index: 9999', { showImages: false }), 'inset: 0; z-index: 9999');
  assert.equal(cleanStyle('position:absolute;top:0', { showImages: false }), 'top:0');
  assert.equal(cleanStyle('position: sticky', { showImages: false }), '');
  assert.equal(cleanStyle('width: expression(alert(1))', { showImages: false }), '');
  assert.equal(cleanStyle('-moz-binding: url(x.xml#y)', { showImages: true }), '');
  assert.equal(cleanStyle('behavior: url(x.htc)', { showImages: true }), '');
});

test('semicolons inside quotes or brackets do not split a declaration', () => {
  assert.equal(cleanStyle('font-family: "A;B", serif; color: blue', { showImages: false }),
    'font-family: "A;B", serif; color: blue');
  assert.equal(cleanStyle('background: url("https://x.example/a;b.png"); color: blue', { showImages: false }),
    'color: blue');
});

test('garbage in, nothing out', () => {
  assert.equal(cleanStyle('', { showImages: false }), '');
  assert.equal(cleanStyle(null, { showImages: false }), '');
  assert.equal(cleanStyle('}{ color red; 9bad: 1', { showImages: false }), '');
});
