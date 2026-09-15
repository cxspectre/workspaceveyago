/* The support queue and a ticket's page, as tickets-ui.js draws them: the
   views, the counts, the whole conversation, the details as stored, what the
   reply box says, and where a ticket opened from elsewhere goes. The page's
   helpers are stand-ins that keep what they are given, so what is tested is
   what tickets-ui.js hands them. Loaded into a sandbox the way <script> tags
   run it. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* No browser runs in this suite (house style: a DOM-only behaviour like an
   actual narrow viewport cannot be unit-tested here), so this checks the rule
   itself rather than what it draws: on a phone the queue table gives up its
   forced 680px floor and the two least-needed columns, rather than scrolling
   sideways (audit #13). */
test('on a phone the ticket queue drops its forced width, not its readability, instead of scrolling sideways', () => {
  const css = readFileSync(new URL('../dist/workspace.css', import.meta.url), 'utf8');
  const phone = css.match(/@media \(max-width: 520px\) \{[^}]*\.queue-layout[\s\S]*?\n\}/);
  assert.ok(phone, 'a phone-width rule touches .queue-layout');
  assert.match(phone[0], /\.queue-layout \.module-table\s*\{\s*min-width:\s*0/, 'the 680px floor set elsewhere in this file gives way');
  assert.match(phone[0], /nth-child\(2\)[\s\S]*display:\s*none/, 'Product / client hidden — its client name is already in the title cell');
  assert.match(phone[0], /nth-child\(5\)[\s\S]*display:\s*none/, 'Owner hidden — a tap into the ticket already answers it');
});

const ME = 'e-me';
const YOU = 'e-you';
const TEAM = [{ id: ME, name: 'Sam Rivera', initial: 'SR' }, { id: YOU, name: 'Ana Lima', initial: 'AL' }];

/* A ticket as queries.tickets() hands it to the store. */
const ticket = (number, over = {}, row = {}) => ({
  id: number, uuid: 'u' + number, title: 'Ticket ' + number, client: 'Northline', product: 'Kept',
  status: 'Open', priority: 'Normal', owner: '—', assigneeId: null, assigneeName: '', contactEmail: '',
  thread: [], messageCount: 0, lastMessageAt: null, deliveryFailed: false, mergedIntoId: null,
  ...over,
  row: {
    status: 'open', priority: 'normal', assignee_id: null, project_id: null, contact_id: null, company_id: null,
    source: 'email', created_at: '2026-09-10T09:00:00Z', deleted_at: null, ...row
  }
});

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const settle = () => new Promise(resolve => setImmediate(resolve));

function load({
  list = [], scope = 'All tickets', route = [], query = '', contacts = [], projects = [], mails = [], notes = {}, notesLoaded = true,
  companies = [], manager = false, loaded = true, now = '2026-09-15T09:00:00Z',
  thread, threadOf, attachmentsOf, actions = {}, confirm = () => true
} = {}) {
  const listeners = {};
  const navigated = [];
  const older = [];
  const toasts = [];
  const threadAsks = [];
  const threadRetries = [];
  const modals = [];
  const answers = { updateTicket: {}, deleteTicket: {}, restoreTicket: {}, mergeTickets: 'u-kept', ...actions };
  const calls = [];
  const workspaceActions = Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, (...args) => {
    calls.push([name, ...args]);
    return typeof answer === 'function' ? answer(...args) : Promise.resolve(answer);
  }]));
  /* A dialog's own form, as dialog-forms.js reaches into it: one error line
     and one submit button, whichever dialog is open. */
  const dialogButton = { disabled: false, focus() {} };
  const dialogError = { textContent: '' };
  let dialogHandlers = {};
  const dialogForm = {
    isConnected: true,
    reset() {},
    addEventListener: (type, fn) => { dialogHandlers[type] = fn; },
    querySelector: selector => (selector === '.form-error' ? dialogError
      : selector === '.form-candidates' ? null
      : selector === '[type="submit"]' ? dialogButton : null),
    querySelectorAll: () => []
  };
  const loads = { begun: 0, arrived: {} };
  const context = vm.createContext({
    console,
    esc: escape,
    icon: () => '',
    pill: (text, tone) => `<span class="pill${tone ? ' ' + tone : ''}">${escape(text)}</span>`,
    titlebar: (title, subtitle, button = '') => `<h1>${escape(title)}</h1>${button}`,
    statStrip: items => items.map(([label, value, hint]) => `<div class="stat">${label}: ${value} (${escape(hint)})</div>`).join(''),
    createButton: label => `<button>${label}</button>`,
    countTag: n => `<span>${n}</span>`,
    queryInput: () => '<input type="search">',
    empty: title => `<p class="empty">${escape(title)}</p>`,
    detailHeader: (parent, label, title, subtitle, actions = '') => `<h1>${escape(title)}</h1><p class="sub">${escape(subtitle)}</p>${actions}`,
    properties: rows => rows.map(([k, v]) => `<div class="property"><span>${k}</span>${v}</div>`).join(''),
    linkedPanel: (title, items) => items.map(([href, label, meta]) => `<a href="#${href}">${escape(label)} (${meta})</a>`).join(''),
    noteFeed: (kind, id) => `<p class="feed">${kind} ${id}</p>`,
    notFound: () => '<p class="not-found"></p>',
    toast: message => toasts.push(message),
    showModal: (eyebrow, body) => { modals.push({ eyebrow, body }); context.modal.open = true; },
    modal: { open: false, close() { this.open = false; } },
    isManagerNow: () => manager,
    confirm: message => confirm(message),
    FormData: function (form) {
      return {
        get: name => (form.fields || {})[name],
        entries: () => Object.entries(form.fields || {})
      };
    },
    queries: { tickets: query },
    ticketScope: scope,
    routeParts: route,
    tickets: list,
    contacts, projects, mails,
    team: TEAM,
    recordNotes: { tickets: notes },
    workspaceStore: {
      state: { loaded, companies },
      has: part => part !== 'notes' || notesLoaded,
      ticketByNumber: n => list.find(t => String(t.id) === String(n)) || null,
      askTicketThread: t => {
        threadAsks.push(t.uuid);
        if (threadOf) return threadOf(t);
        return { state: 'ready', messages: Array.isArray(t.thread) ? t.thread : [] };
      },
      retryTicketThread: uuid => threadRetries.push(uuid),
      askTicketAttachments: uuid => (attachmentsOf ? attachmentsOf(uuid) : { state: 'ready', files: [] }),
      retryTicketAttachments: () => {},
      mark: () => loads.begun,
      loadedSince: (part, mark) => loads.arrived[part] !== undefined && loads.arrived[part] > mark,
      after: (work, options) => Promise.resolve(work).then(
        value => { loads.begun += 1; loads.arrived.tickets = loads.begun; return value; },
        err => { if (!(options && options.toast === false)) toasts.push(err.message); throw err; })
    },
    workspaceActions,
    workspaceSession: { employee: { id: ME, full_name: 'Sam Rivera' }, isManager: () => manager },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: id => (id.indexOf('ticket-') === 0 ? dialogForm : null),
      querySelector: () => null
    },
    ticketsView: () => 'the old queue',
    action: (name, id) => older.push([name, id]),
    navigate: target => navigated.push(target),
    repaintKeepingFocus: () => {}
  });
  context.window = context;
  const nowMs = new Date(now).getTime();
  vm.runInContext(`const RealDate = Date; var __now = ${nowMs};
    Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [__now])); } static now() { return __now; } };`, context);
  for (const file of ['mail-model.js', 'tickets-model.js', 'dialog-forms.js', 'tickets-ui.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  return {
    view: () => context.ticketsView(),
    action: (name, id) => context.action(name, id),
    fire: (type, target, extra = {}) => (listeners[type] || []).forEach(fn => fn({ type, target, preventDefault() {}, stopPropagation() {}, ...extra })),
    drafts: context.ticketDrafts,
    submitDialog: async (fields) => {
      dialogForm.fields = fields;
      await dialogHandlers.submit({ preventDefault() {} });
      await settle();
    },
    navigated, older, toasts, calls, modals, threadAsks, threadRetries,
    modal: context.modal, dialogError, dialogButton
  };
}

/* ── The queue ────────────────────────────────────────────────────────── */

test('"Assigned to me" is who a ticket is assigned to, and only the work still open', () => {
  const html = load({ scope: 'Assigned to me', list: [
    ticket(1, { assigneeId: ME, assigneeName: 'Sam Rivera', owner: 'SR' }, { assignee_id: ME }),
    ticket(2, { assigneeId: YOU, assigneeName: 'Ana Lima', owner: 'AL' }, { assignee_id: YOU }),
    ticket(3, { assigneeId: ME, status: 'Closed' }, { assignee_id: ME, status: 'closed' }),
    ticket(4, { owner: 'SR' })
  ] }).view();
  assert.match(html, /<strong>Ticket 1<\/strong>/);
  assert.doesNotMatch(html, /<strong>Ticket [234]<\/strong>/, 'matching initials is not being assigned');
  assert.match(html, /aria-label="Owner: Sam Rivera"/);
});

test('a view for every status the database has, marked when chosen, and counts as the database counts', () => {
  const html = load({ scope: 'Waiting', list: [
    ticket(1, { assigneeId: ME }, { assignee_id: ME }),
    ticket(2, { status: 'Waiting' }, { status: 'waiting', priority: 'urgent' }),
    ticket(3, { status: 'Closed' }, { status: 'closed' }),
    ticket(4, { status: 'Resolved' }, { status: 'resolved', priority: 'high' })
  ] }).view();
  for (const scope of ['All tickets', 'Assigned to me', 'Unassigned', 'High priority', 'Open', 'In progress', 'Waiting', 'Resolved', 'Closed']) {
    assert.match(html, new RegExp(`data-value="${scope}"`), scope);
  }
  assert.match(html, /data-value="Waiting" class="selected" aria-pressed="true"/);
  assert.match(html, /data-value="Open" class="" aria-pressed="false"/);
  assert.match(html, /Open: 2 \(Open, in progress or waiting\)/);
  assert.match(html, /Assigned to you: 1 \(Sam Rivera\)/);
  assert.match(html, /High priority: 1 \(High or urgent, still open\)/);
  assert.match(html, /Resolved: 2 \(Resolved or closed, all time\)/);
  assert.match(html, /<strong>Ticket 2<\/strong>/);
  assert.doesNotMatch(html, /<strong>Ticket 1<\/strong>|This session/);
  assert.match(html, /<span class="pill">Urgent<\/span><\/td><td><span class="pill">Waiting<\/span>/, 'priority and status as the database has them');
});

test('search finds a number the way people write it, and a customer\'s address', () => {
  const list = [ticket(142, { contactEmail: 'ana@northline.example' }), ticket(143)];
  const byNumber = load({ list, query: 'vyg-142' }).view();
  assert.match(byNumber, /<strong>Ticket 142<\/strong>/);
  assert.doesNotMatch(byNumber, /<strong>Ticket 143<\/strong>/);
  assert.match(load({ list, query: 'ANA@northline' }).view(), /<strong>Ticket 142<\/strong>/);
});

/* ── A ticket's page ──────────────────────────────────────────────────── */

test('a ticket\'s page shows the whole conversation in order, who wrote each part, and whether a reply went', () => {
  const thread = [
    { id: 'm3', direction: 'outbound', body: 'Fixed now.', created_at: '2026-09-10T11:00:00Z', who: 'Sam Rivera', delivered_at: '2026-09-10T11:00:05Z' },
    { id: 'm1', direction: 'inbound', body: 'Checkout <b>fails</b>', created_at: '2026-09-10T09:00:00Z', who: '' },
    { id: 'm2', direction: 'internal', body: 'Payment provider outage', created_at: '2026-09-10T10:00:00Z', who: 'Ana Lima' },
    { id: 'm4', direction: 'outbound', body: 'Following up', created_at: '2026-09-10T12:00:00Z', who: 'Sam Rivera', delivery_error: 'mailbox refused' }
  ];
  const html = load({ route: ['tickets', '142'], list: [ticket(142, { client: 'Ana Lima', thread })] }).view();
  const at = ['Checkout &lt;b&gt;fails&lt;/b&gt;', 'Payment provider outage', 'Fixed now.', 'Following up'].map(text => html.indexOf(text));
  assert.ok(at.every(i => i > 0), 'every message is on the page');
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'oldest first');
  assert.match(html, /conversation-entry internal[\s\S]*<strong>Ana Lima<\/strong><span>Internal note/);
  assert.match(html, /conversation-entry inbound[\s\S]*<strong>Ana Lima<\/strong><span>Customer/, 'the customer, by name');
  assert.match(html, /<small class="delivery">Sent<\/small>/);
  assert.match(html, /<small class="delivery failed">Not sent: mailbox refused<\/small>/);
  assert.doesNotMatch(html, /<b>fails/, 'what a customer wrote is shown, never run');
});

test('the details show what is stored: every status and priority, and Unassigned for nobody', () => {
  const html = load({ route: ['tickets', '7'], list: [ticket(7, { status: 'Waiting' }, { status: 'waiting', priority: 'normal' })] }).view();
  const options = field => (html.match(new RegExp(`data-field="${field}">([\\s\\S]*?)</select>`)) || [])[1] || '';
  assert.equal((options('status').match(/<option/g) || []).length, 5);
  assert.match(options('status'), /value="waiting" selected>Waiting/);
  assert.equal((options('priority').match(/<option/g) || []).length, 4);
  assert.match(options('priority'), /value="normal" selected>Normal/, 'normal is Normal, not Medium or Low');
  assert.match(options('owner'), /value="" selected>Unassigned/, 'nobody is not the first teammate');
  assert.match(html, /data-record-kind="tickets" data-record-id="7" data-field="status"/);
});

test('a resolved ticket says whether it met its response target — not only one still waiting', () => {
  const missed = load({
    route: ['tickets', '9'],
    list: [ticket(9, {}, { resolve_due_at: '2026-09-12T00:00:00Z', resolved_at: '2026-09-14T00:00:00Z' })]
  }).view();
  assert.match(missed, /Resolved.*?Missed/s, 'a resolution two days after its target says Missed, not silence');
  const met = load({
    route: ['tickets', '10'],
    list: [ticket(10, {}, { resolve_due_at: '2026-09-16T00:00:00Z', resolved_at: '2026-09-14T00:00:00Z' })]
  }).view();
  assert.match(met, /Resolved.*?Met/s);
  const waiting = load({
    route: ['tickets', '11'],
    list: [ticket(11, {}, { resolve_due_at: '2026-09-16T00:00:00Z', resolved_at: null })]
  }).view();
  assert.match(waiting, /Not yet.*?Due/s, 'still open and inside its target: Due, not silence');
});

test('an owner who has left stays the owner shown, rather than becoming the first name', () => {
  const html = load({ route: ['tickets', '8'], list: [ticket(8, { assigneeId: 'e-gone', assigneeName: 'Jo Park' }, { assignee_id: 'e-gone' })] }).view();
  assert.match(html, /value="e-gone" selected>Jo Park/);
});

test('the reply box says where a reply goes before anything is sent, and says it again for a note', () => {
  const h = load({ route: ['tickets', '142'], list: [ticket(142, { contactEmail: 'ana@northline.example' })] });
  const html = h.view();
  assert.match(html, /Emailed to ana@northline\.example\./);
  assert.match(html, /data-reply-label>Send reply</);
  assert.doesNotMatch(html, /Demo only|No external email/);

  const note = { textContent: '' };
  const label = { textContent: '' };
  const form = { dataset: { ticketReply: '142' }, querySelector: s => (s === '[data-reply-note]' ? note : s === '[data-reply-label]' ? label : null) };
  const radio = { value: 'note', form };
  radio.closest = s => (s === '[data-ticket-reply] input[name="mode"]' ? radio : null);
  h.fire('change', radio);
  assert.equal(note.textContent, 'Internal note: only the team sees it.');
  assert.equal(label.textContent, 'Add note');

  const nobody = load({ route: ['tickets', '5'], list: [ticket(5)] }).view();
  assert.match(nobody, /has no customer address, so a reply is saved here but not emailed/);
  assert.match(nobody, /data-reply-label>Save reply</);
});

/* ── Reply and set to Waiting (audit #5) ─────────────────────────────────── */

test('"Then set to Waiting" shows for a reply, and hides the moment Internal note is chosen', () => {
  const h = load({ route: ['tickets', '142'], list: [ticket(142, { contactEmail: 'ana@northline.example' })] });
  const html = h.view();
  assert.match(html, /<label class="check-row" data-then-waiting><input type="checkbox" name="thenWaiting"> Then set to Waiting<\/label>/);

  const waitRow = { hidden: false };
  const form = { dataset: { ticketReply: '142' }, querySelector: s => (s === '[data-then-waiting]' ? waitRow : null) };
  const radio = { value: 'note', form };
  radio.closest = s => (s === '[data-ticket-reply] input[name="mode"]' ? radio : null);
  h.fire('change', radio);
  assert.equal(waitRow.hidden, true);
  radio.value = 'reply';
  h.fire('change', radio);
  assert.equal(waitRow.hidden, false);
});

test('connected work is the ticket\'s own contact, project and conversation — never one with a similar name', () => {
  const contacts = [{ id: 'c-other', name: 'Northline' }, { id: 'c-ana', name: 'Ana Lima' }];
  const projects = [{ id: 'p-kept', uuid: 'u-kept', name: 'Kept website' }, { id: 'p-real', uuid: 'u-real', name: 'Checkout rebuild' }];
  const mails = [{ id: 'd0000000-0000-4000-8000-0000000000f1', subject: 'Checkout', folder: 'inbox', row: { ticket_id: 'u9' } }];
  const html = load({ route: ['tickets', '9'], contacts, projects, mails,
    list: [ticket(9, { product: 'Kept' }, { contact_id: 'c-ana', project_id: 'u-real' })] }).view();
  assert.match(html, /href="#crm\/c-ana">Ana Lima/);
  assert.match(html, /href="#projects\/p-real">Checkout rebuild/);
  assert.doesNotMatch(html, /Kept website/);
  assert.match(html, /href="#mail\/all\/inbox\/d0000000-0000-4000-8000-0000000000f1">Checkout \(Mail conversation\)/);
});

test('the button beside the title resolves an open ticket and reopens a finished one', () => {
  const open = load({ route: ['tickets', '1'], list: [ticket(1)] }).view();
  assert.match(open, /data-ticket="1" data-ticket-status="resolved">Resolve ticket/);
  const done = load({ route: ['tickets', '2'], list: [ticket(2, { status: 'Closed' }, { status: 'closed' })] }).view();
  assert.match(done, /data-ticket="2" data-ticket-status="open">Reopen ticket/);
  assert.match(load({ route: ['tickets', '404'], list: [ticket(1)] }).view(), /not-found/);
});

test('a ticket\'s notes that did not load say so, rather than leaving no trace; a ticket with none has no section for them', () => {
  const failed = load({ route: ['tickets', '5'], list: [ticket(5)], notesLoaded: false }).view();
  assert.match(failed, /<div class="section-title"><h2 id="ticket-notes-5" tabindex="-1">Notes on this ticket<\/h2><\/div><div class="conversation-feed"><p class="feed">tickets 5<\/p><\/div>/);
  assert.doesNotMatch(load({ route: ['tickets', '5'], list: [ticket(5)] }).view(), /Notes on this ticket/);
  const noted = load({ route: ['tickets', '5'], list: [ticket(5)], notes: { 5: [{ id: 'n1', body: 'Called them' }] } }).view();
  assert.match(noted, /<h2 id="ticket-notes-5" tabindex="-1">Notes on this ticket<\/h2><\/div><div class="conversation-feed"><p class="feed">tickets 5<\/p>/,
    'the heading takes the keyboard when a note is removed');
});

test('what is written in the reply box, and whether as a note, outlives a repaint', () => {
  const h = load({ route: ['tickets', '142'], list: [ticket(142, { contactEmail: 'ana@northline.example' })] });
  const form = { dataset: { ticketReply: '142' }, querySelector: () => null };
  const box = { value: 'Checked the <logs>', form };
  box.closest = s => (s === '[data-ticket-reply] textarea[name="body"]' ? box : null);
  const radio = { value: 'note', form };
  radio.closest = s => (s === '[data-ticket-reply] input[name="mode"]' ? radio : null);
  h.fire('input', box);
  h.fire('change', radio);

  const repainted = h.view();
  assert.match(repainted, /name="body"[^>]*>Checked the &lt;logs&gt;<\/textarea>/, 'what was written is drawn again, escaped');
  assert.match(repainted, /value="note" checked/);
  assert.doesNotMatch(repainted, /value="reply" checked/, 'a repaint no longer turns a note into an email');
  assert.match(repainted, /data-reply-label>Add note</);

  h.drafts.sent('142', 'Checked the <logs>');
  const afterSend = h.view();
  assert.match(afterSend, /name="body"[^>]*><\/textarea>/, 'a sent draft is gone');
  assert.match(afterSend, /value="note" checked/, 'the mode stays as last used on the ticket');

  h.drafts.keep('142', { body: 'A second thought' });
  h.drafts.sent('142', 'Checked the <logs>');
  assert.equal(h.drafts.get('142').body, 'A second thought', 'what was typed while it sent is kept');
});

test('a queue row is a row with a link, so its cells are read out; the reply note describes the send button', () => {
  const queue = load({ list: [ticket(1)] }).view();
  assert.doesNotMatch(queue, /<tr[^>]*role="button"/);
  assert.match(queue, /<a class="ticket-link" href="#tickets\/1"><strong>Ticket 1<\/strong><\/a>/);
  const page = load({ route: ['tickets', '1'], list: [ticket(1)] }).view();
  assert.match(page, /<span id="ticket-reply-note-1" data-reply-note>/);
  assert.match(page, /<button type="submit" id="ticket-reply-send-1" class="btn btn-primary" aria-describedby="ticket-reply-note-1">/,
    'with an id, so focus finds it again after the repaint a send makes');
});

test('a conversation filed away in Outlook is still connected work, under Starred when starred', () => {
  const mails = [{ id: 'd0000000-0000-4000-8000-0000000000f2', subject: 'Later', folder: 'archive', starred: true, row: { ticket_id: 'u9' } }];
  const html = load({ route: ['tickets', '9'], mails, list: [ticket(9)] }).view();
  assert.match(html, /href="#mail\/all\/starred\/d0000000-0000-4000-8000-0000000000f2">Later \(Mail conversation\)/);
});

test('a ticket opened from anywhere goes to its page; everything else is left to what was there', () => {
  const h = load({ list: [ticket(142)] });
  h.action('ticket', 142);
  h.action('invoice', 3);
  assert.deepEqual(h.navigated, ['tickets/142']);
  assert.deepEqual(h.older, [['invoice', 3]]);
});

/* ── The conversation, asked for apart from the list (audit #12) ────────── */

test('a ticket\'s page asks the store for its conversation when the list did not carry it', () => {
  const h = load({
    route: ['tickets', '142'], list: [ticket(142, { thread: null })],
    threadOf: t => ({ state: 'loading', messages: [] })
  });
  const html = h.view();
  assert.deepEqual(h.threadAsks, ['u142']);
  assert.match(html, /Loading the conversation/i);
});

test('a conversation that did not load says so, with a way to try again', () => {
  const h = load({
    route: ['tickets', '142'], list: [ticket(142, { thread: null })],
    threadOf: () => ({ state: 'failed', messages: [] })
  });
  const html = h.view();
  assert.match(html, /did not load/i);
  const retry = html.match(/data-ticket-thread-retry="([^"]+)"/);
  assert.ok(retry, 'a button to ask again');
  h.fire('click', { closest: s => (s === '[data-ticket-thread-retry]' ? { dataset: { ticketThreadRetry: retry[1] } } : null) });
  assert.deepEqual(h.threadRetries, ['u142']);
});

test('a ready conversation with no messages yet still says so plainly', () => {
  const html = load({ route: ['tickets', '142'], list: [ticket(142, { thread: null })], threadOf: () => ({ state: 'ready', messages: [] }) }).view();
  assert.match(html, /Nothing has been written on this ticket yet/);
});

/* ── Attachments (audit #11) ──────────────────────────────────────────── */

test('a ticket\'s attachments show once they load, with Download for everyone and Remove for the uploader or a manager', () => {
  const html = load({
    route: ['tickets', '142'], list: [ticket(142)],
    attachmentsOf: () => ({ state: 'ready', files: [
      { id: 'a1', name: 'shot.png', sizeBytes: 2048, uploadedBy: ME, uploaderName: 'Sam Rivera' },
      { id: 'a2', name: 'log.txt', sizeBytes: 512, uploadedBy: YOU, uploaderName: 'Ana Lima' }
    ] })
  }).view();
  assert.match(html, /shot\.png[\s\S]*2 KB[\s\S]*Sam Rivera/);
  assert.match(html, /data-ticket-file-open="a1"/);
  assert.match(html, /data-ticket-file-remove="a1"/, 'the uploader can remove their own');
  assert.doesNotMatch(html, /data-ticket-file-remove="a2"/, 'not someone else\'s, without being a manager');
});

test('a manager can remove any attachment, not only their own', () => {
  const html = load({
    route: ['tickets', '142'], list: [ticket(142)], manager: true,
    attachmentsOf: () => ({ state: 'ready', files: [{ id: 'a2', name: 'log.txt', sizeBytes: 512, uploadedBy: YOU }] })
  }).view();
  assert.match(html, /data-ticket-file-remove="a2"/);
});

test('attachments say when they are loading or did not load', () => {
  const loading = load({ route: ['tickets', '142'], list: [ticket(142)], attachmentsOf: () => ({ state: 'loading', files: [] }) }).view();
  assert.match(loading, /Loading attachments/i);
  const h = load({ route: ['tickets', '142'], list: [ticket(142)], attachmentsOf: () => ({ state: 'failed', files: [] }) });
  const failedHtml = h.view();
  assert.match(failedHtml, /did not load/i);
  const retry = failedHtml.match(/data-ticket-files-retry="([^"]+)"/);
  assert.ok(retry);
});

/* ── The queue: age and a failed reply, sortable (audit #3) ──────────────── */

test('the queue shows how long a ticket has been open, and flags one whose last reply never sent', () => {
  const html = load({ now: '2026-09-15T09:00:00Z', list: [
    ticket(1, {}, { created_at: '2026-09-08T09:00:00Z' }),
    ticket(2, { deliveryFailed: true }, { created_at: '2026-09-14T09:00:00Z' })
  ] }).view();
  assert.match(html, /7 days old/);
  assert.match(html, /Reply not sent/);
});

/* ── Editing (audit #2) ───────────────────────────────────────────────── */

test('anyone on staff can edit a ticket\'s subject, contact, company, project and product', async () => {
  const contacts = [{ id: 'c1', name: 'Ana Lima' }];
  const projects = [{ id: 'p1', name: 'Checkout rebuild' }];
  const h = load({
    route: ['tickets', '142'], contacts, projects, companies: [{ id: 'co1', name: 'Northline' }],
    list: [ticket(142, { title: 'Checkout is broken', product: 'Kept' }, { contact_id: 'c1', updated_at: '2026-09-10T09:00:00Z' })]
  });
  const html = h.view();
  assert.match(html, /data-ticket-edit="142">Edit ticket/);
  h.fire('click', { closest: s => (s === '[data-ticket-edit]' ? { dataset: { ticketEdit: '142' } } : null) });
  assert.equal(h.modals.length, 1, 'the dialog opened');
  assert.match(h.modals[0].body, /<option value="c1" selected>Ana Lima<\/option>/);
  assert.match(h.modals[0].body, /<option value="p1">Checkout rebuild<\/option>/);
  await h.submitDialog({ subject: 'Checkout is still broken', contactId: 'c1', companyId: '', projectId: '', product: 'Kept' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual([h.calls[0][0], h.calls[0][1], { ...h.calls[0][2] }, h.calls[0][3]],
    ['updateTicket', 'u142', { subject: 'Checkout is still broken' }, '2026-09-10T09:00:00Z']);
  assert.equal(h.modal.open, false);
});

test('an edit with nothing changed says so and saves nothing', async () => {
  const h = load({ route: ['tickets', '142'], list: [ticket(142, { title: 'Checkout is broken', product: 'Kept' })] });
  h.view();
  h.fire('click', { closest: s => (s === '[data-ticket-edit]' ? { dataset: { ticketEdit: '142' } } : null) });
  await h.submitDialog({ subject: 'Checkout is broken', contactId: '', companyId: '', projectId: '', product: 'Kept' });
  assert.deepEqual(h.calls, []);
  assert.ok(h.toasts.includes('Nothing changed.'));
});

test('a blank subject is refused on the dialog, not sent', async () => {
  const h = load({ route: ['tickets', '142'], list: [ticket(142)] });
  h.view();
  h.fire('click', { closest: s => (s === '[data-ticket-edit]' ? { dataset: { ticketEdit: '142' } } : null) });
  await h.submitDialog({ subject: '   ' });
  assert.deepEqual(h.calls, []);
  assert.match(h.dialogError.textContent, /needs a subject/);
});

/* ── Delete and restore (audit #4) ────────────────────────────────────── */

test('only a manager sees Delete ticket; anyone can still resolve or reopen', () => {
  const staffHtml = load({ route: ['tickets', '142'], list: [ticket(142)], manager: false }).view();
  assert.doesNotMatch(staffHtml, /data-ticket-delete/);
  const managerHtml = load({ route: ['tickets', '142'], list: [ticket(142)], manager: true }).view();
  assert.match(managerHtml, /data-ticket-delete="u142">Delete ticket/);
});

test('deleting a ticket asks first, then leaves its page for the queue', async () => {
  const h = load({ route: ['tickets', '142'], list: [ticket(142)], manager: true });
  h.view();
  h.fire('click', { closest: s => (s === '[data-ticket-delete]' ? { dataset: { ticketDelete: 'u142' } } : null) });
  assert.equal(h.modal.open, true, 'a dialog, not an instant delete');
  await h.submitDialog({});
  assert.deepEqual(h.calls, [['deleteTicket', 'u142']]);
  assert.deepEqual(h.navigated, ['tickets']);
});

test('a manager can restore a deleted ticket by its number', async () => {
  const h = load({ manager: true });
  h.view();
  h.fire('submit', { matches: s => s === '[data-restore-ticket]', dataset: {}, fields: { number: 'VYG-99' },
    querySelector: s => (s === 'button[type="submit"]' ? { disabled: false } : null) });
  await settle();
  assert.deepEqual(h.calls, [['restoreTicket', 99]]);
  assert.ok(h.toasts.some(t => /restored/i.test(t)));
});

test('restoring needs a real ticket number', async () => {
  const h = load({ manager: true });
  h.view();
  h.fire('submit', { matches: s => s === '[data-restore-ticket]', dataset: {}, fields: { number: 'not a number' },
    querySelector: s => (s === 'button[type="submit"]' ? { disabled: false } : null) });
  await settle();
  assert.deepEqual(h.calls, []);
});

/* ── Merging (audit #8) ───────────────────────────────────────────────── */

test('any staff member can merge a ticket into another one that is loaded', async () => {
  const h = load({ route: ['tickets', '142'], list: [ticket(142, { title: 'Checkout is broken' }), ticket(141, { title: 'Checkout is broken too' })] });
  const html = h.view();
  assert.match(html, /data-ticket-merge="142">Merge into/);
  h.fire('click', { closest: s => (s === '[data-ticket-merge]' ? { dataset: { ticketMerge: '142' } } : null) });
  await h.submitDialog({ into: 'VYG-141' });
  assert.deepEqual(h.calls, [['mergeTickets', 'u141', 'u142']]);
  assert.deepEqual(h.navigated, ['tickets/141']);
});

test('merging refuses a ticket into itself, an unknown number, or nothing typed', async () => {
  const h = load({ route: ['tickets', '142'], list: [ticket(142)] });
  h.view();
  h.fire('click', { closest: s => (s === '[data-ticket-merge]' ? { dataset: { ticketMerge: '142' } } : null) });
  await h.submitDialog({ into: '142' });
  assert.deepEqual(h.calls, []);
  assert.match(h.dialogError.textContent, /itself/);

  h.fire('click', { closest: s => (s === '[data-ticket-merge]' ? { dataset: { ticketMerge: '142' } } : null) });
  await h.submitDialog({ into: '999' });
  assert.deepEqual(h.calls, []);
  assert.match(h.dialogError.textContent, /No ticket #VYG-999/);
});

test('an already-merged ticket has no Merge button, and says where it went', () => {
  const html = load({ route: ['tickets', '142'], list: [
    ticket(142, { mergedIntoId: 'u141' }), ticket(141, { title: 'The kept one' })
  ] }).view();
  assert.doesNotMatch(html, /data-ticket-merge/);
  assert.match(html, /Merged into[\s\S]*#VYG-141/);
});

test('the queue sorts newest first by default, and can be flipped to oldest first', () => {
  const h = load({ list: [
    ticket(1, {}, { created_at: '2026-09-10T09:00:00Z' }),
    ticket(2, {}, { created_at: '2026-09-12T09:00:00Z' })
  ] });
  const newest = h.view();
  assert.ok(newest.indexOf('Ticket 2') < newest.indexOf('Ticket 1'), 'newest first by default');
  h.fire('click', { closest: s => (s === '[data-ticket-sort]' ? { dataset: { ticketSort: 'oldest' } } : null) });
  const oldest = h.view();
  assert.ok(oldest.indexOf('Ticket 1') < oldest.indexOf('Ticket 2'), 'flipped to oldest first');
  h.fire('click', { closest: s => (s === '[data-ticket-sort]' ? { dataset: { ticketSort: 'newest' } } : null) });
  assert.ok(h.view().indexOf('Ticket 2') < h.view().indexOf('Ticket 1'), 'flips back');
});
