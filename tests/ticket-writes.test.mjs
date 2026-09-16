/* The writes behind a ticket's page, as data/writes.js makes them: status,
   priority and owner saved by the ticket's id, in the order chosen, and put back
   when refused; resolve and reopen; a reply kept until it is saved, sent once,
   and asked about before sending again when its answer never arrived; and a new
   ticket that files its requester as the customer and never opens twice.
   writes.js against stand-in actions that record every call, a store, and a
   document that only hands out the listeners it was given. Loaded into a
   sandbox the way <script> tags run it. Run from the repo root with: node --test

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence the {...spread} before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setImmediate(resolve));
const ticks = async n => { for (let i = 0; i < n; i++) await tick(); };

const TICKET = {
  id: 142, uuid: 'u142', title: 'Checkout is broken', status: 'Open', priority: 'Normal', assigneeId: 'e-you',
  row: { status: 'open', priority: 'normal', assignee_id: 'e-you' }
};
const CONTACTS = [{
  name: 'Ana Lima', email: 'ana@northline.example',
  row: { id: 'c1', email: 'ana@northline.example', company: { id: 'co1', name: 'Northline' } }
}];

/* actions: results or functions standing in for workspaceActions. after: the
   store's after(), which a test can hold open. confirm: the answer to "send it
   again?". noteDrafts: the words notes-ui.js keeps for a note box. */
function load({ actions = {}, loaded = true, after = promise => promise, confirm = () => true, contacts = CONTACTS, tasksUi, page = {}, noteDrafts } = {}) {
  const PAGE_BODY = {};
  const listeners = {};
  const toasts = [];
  const navigated = [];
  /* How many drafts had been kept each time the page moved. */
  const keptWhenNavigated = [];
  const calls = [];
  const drafts = { kept: [], sent: [] };
  const answers = {
    setTicketStatus: {}, setTicketPriority: {}, assignTicket: {},
    replyToTicket: { sent: true, to: 'ana@northline.example' },
    createTicket: { id: 'u200', number: 200 },
    ...actions
  };
  const workspaceActions = Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, (...args) => {
    calls.push([name, ...args]);
    return typeof answer === 'function' ? answer(...args) : Promise.resolve(answer);
  }]));
  const context = vm.createContext({
    console: { ...console, error: () => {} },
    toast: message => toasts.push(message),
    navigate: target => { navigated.push(target); keptWhenNavigated.push(drafts.kept.length); },
    confirm: message => confirm(message),
    setTimeout: fn => { fn(); return 0; },
    clearTimeout: () => {},
    FormData: function (form) { return { get: name => form.fields[name] }; },
    tickets: [TICKET], contacts, mails: [], projects: [],
    ticketDrafts: {
      keep: (number, draft) => drafts.kept.push([String(number), { ...draft }]),
      sent: (number, body) => drafts.sent.push([String(number), body])
    },
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById: () => ({ close: () => {} }),
      /* The page as drawn after a save: what a selector finds on it, if anything. */
      querySelector: selector => page[selector] || null,
      body: PAGE_BODY,
      activeElement: PAGE_BODY
    },
    workspaceStore: {
      state: { loaded, companies: [{ id: 'co1', name: 'Northline' }] },
      has: () => true,
      ticketByNumber: n => (Number(n) === 142 ? TICKET : null),
      projectById: id => (id === 'p1' ? { id: 'p1', uuid: 'p1', taskIds: ['t1'] } : null),
      noteTarget: (kind, id) => (kind === 'tickets' && id === '142' ? { type: 'ticket', id: 'u142' } : null),
      after,
      reload: async () => {}
    },
    workspaceActions,
    tasksUi,
    noteDrafts
  });
  context.window = context;
  for (const file of ['mail-model.js', 'projects-model.js', 'tickets-model.js', 'data/writes.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  /* Answers whether a listener stopped the rest from running. */
  const fire = (type, target) => {
    let stopped = false;
    const event = { type, target, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { stopped = true; } };
    for (const fn of listeners[type] || []) {
      fn(event);
      if (stopped) break;
    }
    return stopped;
  };
  return { fire, toasts, navigated, keptWhenNavigated, calls, drafts };
}

/* A task's tick box on its project's page. */
function taskBox(checked) {
  const box = { dataset: { projectTask: 'p1', taskId: 't1' }, checked, disabled: false };
  box.closest = s => (s === '[data-project-task]' ? box : null);
  return box;
}

test('a tick goes to the task list\'s own saves, so it cannot race the task\'s status select', () => {
  const set = [];
  const h = load({ tasksUi: { setStatus: (id, status) => set.push([id, status]) } });
  const box = taskBox(true);
  assert.equal(h.fire('change', box), true);
  assert.deepEqual(set, [['t1', 'done']]);
  assert.deepEqual(h.calls, [], 'not saved beside them');
  assert.equal(box.disabled, false);
});

test('without the task list on the page, a tick is saved on its own', async () => {
  const h = load({ actions: { setTaskDone: {} } });
  h.fire('change', taskBox(false));
  await ticks(3);
  assert.deepEqual(h.calls.map(call => [...call]), [['setTaskDone', 't1', false]]);
  assert.equal(h.toasts.at(-1), 'Task reopened');
});

/* A note box on a record's page, with what was written in it. */
function noteForm(note) {
  const button = { disabled: false, focused: 0, focus() { this.focused += 1; } };
  const box = { value: note };
  const form = {
    id: '', fields: { note }, dataset: { noteForm: 'tickets', recordId: '142' }, resets: 0,
    matches: s => s === '[data-note-form]',
    reset() { this.resets += 1; },
    querySelector: s => (s === 'button[type="submit"]' ? button : s === 'textarea[name="note"]' ? box : null)
  };
  return { form, button, box };
}

test('a note that could not be saved keeps what was written; a saved one clears the box, and two quick sends save it once', async () => {
  const letGo = [];
  const refused = load({ actions: { addNote: () => Promise.reject(new Error('Could not save the note: permission denied')) }, noteDrafts: { sent: (...args) => letGo.push(args) } });
  const kept = noteForm('Called the client about the deadline');
  refused.fire('submit', kept.form);
  await ticks(4);
  assert.equal(kept.form.resets, 0, 'what was written stays in the box');
  assert.deepEqual(letGo, [], 'and what was kept for the box stays kept, for the page drawn again');
  assert.equal(kept.box.readOnly, false, 'and the box takes typing again');
  assert.equal(refused.toasts.at(-1), 'Could not save the note: permission denied');
  assert.equal(kept.button.disabled, false, 'and it can be sent again');
  assert.equal(kept.button.focused, 1, 'from the button, which the keyboard lost while it saved');
  const redrawn = { focused: 0, focus() { this.focused += 1; } };
  /* What happened, in order: the words kept for the note box let go, and the
     workspace loaded again — and whether the box took typing then. */
  const order = [];
  const saved = load({
    actions: { addNote: {} },
    page: { '[data-note-form="tickets"][data-record-id="142"] textarea': redrawn },
    noteDrafts: { sent: (...args) => order.push(['let go', ...args]) },
    after: promise => Promise.resolve(promise).then(value => { order.push(['loaded again', note.box.readOnly]); return value; })
  });
  const note = noteForm('Called the client about the deadline');
  saved.fire('submit', note.form);
  saved.fire('submit', note.form);
  await ticks(4);
  assert.deepEqual(saved.calls, [['addNote', 'ticket', 'u142', 'Called the client about the deadline']]);
  assert.deepEqual(order.map(step => [...step]), [['let go', 'tickets', '142', 'Called the client about the deadline'], ['loaded again', true]],
    'the words kept for the box go before the page is drawn again with them, and the box takes no typing while it saves, so saved words cannot come back');
  assert.equal(note.box.readOnly, false, 'it takes typing again once the note is saved');
  assert.equal(note.form.resets, 1);
  assert.equal(note.box.value, '', 'emptied, even a box drawn with words kept for it, which a reset puts back');
  assert.equal(saved.toasts.at(-1), 'Note saved.');
  assert.equal(note.button.disabled, false);
  assert.equal(redrawn.focused, 1, 'the keyboard goes to the box on the page as drawn again, for the next note');
  const more = noteForm('Called the client about the deadline');
  const typing = load({ actions: { addNote: () => { more.box.value = 'Called the client about the deadline, and the budget'; return Promise.resolve({}); } } });
  typing.fire('submit', more.form);
  await ticks(4);
  assert.equal(more.form.resets, 0, 'what was typed while it saved stays in the box');
  assert.equal(more.box.value, 'Called the client about the deadline, and the budget');
});

test('a note box drawn again while its note saves does not send the note a second time', async () => {
  const saving = new Set();
  const noteDrafts = {
    sent: () => {},
    isSaving: (kind, id) => saving.has(`${kind}|${id}`),
    startSaving: (kind, id) => { saving.add(`${kind}|${id}`); },
    doneSaving: (kind, id) => { saving.delete(`${kind}|${id}`); }
  };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const h = load({ actions: { addNote: {} }, noteDrafts, after: promise => held.then(() => promise) });
  const first = noteForm('Called the client about the deadline');
  h.fire('submit', first.form);
  await ticks(2);
  const redrawn = noteForm('Called the client about the deadline');
  h.fire('submit', redrawn.form);
  await ticks(2);
  assert.equal(h.calls.filter(([name]) => name === 'addNote').length, 1, 'the box drawn again does not send it again');
  assert.equal(h.toasts.at(-1), 'That note is still saving.');
  release();
  await ticks(4);
  h.fire('submit', redrawn.form);
  await ticks(4);
  assert.equal(h.calls.filter(([name]) => name === 'addNote').length, 2, 'once it is saved, the box sends again');
});

const resolveButton = status => {
  const button = { dataset: { ticket: '142', ticketStatus: status }, disabled: false };
  button.closest = s => (s === '[data-ticket-status]' ? button : null);
  return button;
};

const mayHaveGone = message => Object.assign(new Error(message), { unknownOutcome: true });

const VALUES = {
  status: ['open', 'in_progress', 'waiting', 'resolved', 'closed'],
  priority: ['low', 'normal', 'high', 'urgent'],
  owner: ['', 'e-me', 'e-you']
};

/* A select on the ticket's page, drawn with `stored` selected and now set to `value`. */
function choice(field, value, stored) {
  const select = {
    dataset: { recordKind: 'tickets', recordId: '142', field },
    value,
    options: VALUES[field].map(v => ({ value: v, text: v || 'Unassigned', defaultSelected: v === stored })),
    selectedIndex: VALUES[field].indexOf(value)
  };
  select.closest = s => (s === '[data-record-kind="tickets"][data-field]' ? select : null);
  return select;
}

function replyForm(fields) {
  const button = { disabled: false };
  const box = { value: fields.body };
  const form = {
    id: '', fields, dataset: { ticketReply: '142' },
    matches: s => s === '[data-ticket-reply]',
    querySelector: s => (s === 'button[type="submit"]' ? button : s === 'textarea[name="body"]' ? box : null)
  };
  return { form, button, box };
}

function createForm(fields) {
  const button = { disabled: false };
  const form = {
    id: 'create-form', fields, dataset: { kind: 'tickets' },
    matches: () => false,
    querySelector: s => (s === 'button:not([type="button"])' ? button : null)
  };
  return { form, button };
}

/* ── Status, priority and owner ───────────────────────────────────────── */

test('a ticket\'s status, priority and owner are saved by its id, and Unassigned clears the owner', async () => {
  const h = load();
  h.fire('change', choice('status', 'waiting', 'open'));
  h.fire('change', choice('priority', 'urgent', 'normal'));
  h.fire('change', choice('owner', '', 'e-you'));
  await ticks(5);
  assert.deepEqual(h.calls, [['setTicketStatus', 'u142', 'waiting'], ['setTicketPriority', 'u142', 'urgent'], ['assignTicket', 'u142', null]]);
  assert.deepEqual(h.toasts, ['Status saved: waiting', 'Priority saved: urgent', 'Owner saved: Unassigned']);
});

test('the ticket selects are handled here alone: the demo handler that changed the screen never runs', () => {
  assert.equal(load().fire('change', choice('status', 'waiting', 'open')), true);
});

test('choosing what is already stored saves nothing', async () => {
  const h = load();
  h.fire('change', choice('status', 'open', 'open'));
  h.fire('change', choice('owner', 'e-you', 'e-you'));
  await ticks(3);
  assert.deepEqual(h.calls, []);
});

test('changing a field back while its save is on the way saves that too, in the order chosen', async () => {
  const held = [];
  const h = load({ after: promise => new Promise((resolve, reject) => held.push(() => promise.then(resolve, reject))) });
  h.fire('change', choice('status', 'resolved', 'open'));
  await ticks(3);
  h.fire('change', choice('status', 'open', 'open'));
  await ticks(3);
  assert.deepEqual(h.calls, [['setTicketStatus', 'u142', 'resolved']], 'the second waits for the first');
  held.shift()();
  await ticks(8);
  assert.deepEqual(h.calls, [['setTicketStatus', 'u142', 'resolved'], ['setTicketStatus', 'u142', 'open']],
    'back to open is saved, though the loaded ticket still said open');
  held.shift()();
  await ticks(8);
  assert.deepEqual(h.toasts, ['Status saved: resolved', 'Status saved: open']);
});

test('a refused change is put back, and says why', async () => {
  const h = load({ actions: { setTicketPriority: () => Promise.reject(new Error('Only staff can change a ticket.')) } });
  const select = choice('priority', 'urgent', 'normal');
  h.fire('change', select);
  await ticks(5);
  assert.equal(select.value, 'normal');
  assert.ok(h.toasts.includes('Only staff can change a ticket.'));
});

test('before the workspace has loaded nothing is saved, and the choice is put back', () => {
  const h = load({ loaded: false });
  const select = choice('status', 'closed', 'open');
  h.fire('change', select);
  assert.deepEqual(h.calls, []);
  assert.equal(select.value, 'open');
  assert.match(h.toasts[0], /^Not saved/);
});

test('resolve and reopen write the status, and the button waits for the answer', async () => {
  let answer;
  const h = load({ actions: { setTicketStatus: () => new Promise(resolve => { answer = resolve; }) } });
  const button = resolveButton('resolved');
  h.fire('click', button);
  assert.equal(button.disabled, true);
  await ticks(3);
  assert.deepEqual(h.calls, [['setTicketStatus', 'u142', 'resolved']]);
  answer({});
  await ticks(5);
  assert.equal(button.disabled, false);
  assert.deepEqual(h.toasts, ['Ticket resolved']);
});

test('resolving while a status change is on its way waits for it, in the order chosen', async () => {
  const held = [];
  const h = load({ after: promise => new Promise((resolve, reject) => held.push(() => promise.then(resolve, reject))) });
  h.fire('change', choice('status', 'waiting', 'open'));
  await ticks(3);
  const button = resolveButton('resolved');
  h.fire('click', button);
  await ticks(3);
  assert.deepEqual(h.calls, [['setTicketStatus', 'u142', 'waiting']], 'resolve waits for the status save');
  held.shift()();
  await ticks(8);
  assert.deepEqual(h.calls, [['setTicketStatus', 'u142', 'waiting'], ['setTicketStatus', 'u142', 'resolved']]);
  held.shift()();
  await ticks(8);
  assert.equal(button.disabled, false);
  assert.deepEqual(h.toasts, ['Status saved: waiting', 'Ticket resolved']);
});

/* ── Replies ──────────────────────────────────────────────────────────── */

test('a reply that fails keeps what was written, and a second send waits for the first', async () => {
  let refuse;
  const h = load({ actions: { replyToTicket: () => new Promise((resolve, reject) => { refuse = reject; }) } });
  const f = replyForm({ body: 'Thanks, fixed.', mode: 'reply' });
  h.fire('submit', f.form);
  h.fire('submit', f.form);
  assert.equal(h.calls.length, 1, 'Enter pressed twice sends once');
  assert.equal(f.button.disabled, true);
  refuse(new Error('The reply could not be sent.'));
  await ticks(5);
  assert.equal(f.box.value, 'Thanks, fixed.', 'what was written is still in the box');
  assert.deepEqual(h.drafts.sent, [], 'and still in the draft a repaint draws');
  assert.equal(f.button.disabled, false);
  assert.equal(f.form.dataset.pending, '');
  assert.ok(h.toasts.includes('The reply could not be sent.'));
});

test('a sent reply clears the box and its draft, and says where it went; a note says it stayed with the team', async () => {
  const h = load();
  const reply = replyForm({ body: 'Fixed now.', mode: 'reply' });
  h.fire('submit', reply.form);
  await ticks(5);
  const note = replyForm({ body: 'Provider outage.', mode: 'note' });
  h.fire('submit', note.form);
  await ticks(5);
  assert.deepEqual(h.calls, [['replyToTicket', 'u142', 'Fixed now.', 'reply'], ['replyToTicket', 'u142', 'Provider outage.', 'note']]);
  assert.equal(reply.box.value, '');
  assert.deepEqual(h.drafts.sent, [['142', 'Fixed now.'], ['142', 'Provider outage.']]);
  assert.deepEqual(h.toasts, ['Reply sent to ana@northline.example', 'Note added']);
});

test('a sent reply leaves the draft before the page is drawn again, not after', async () => {
  const sentWhenRepainted = [];
  const h = load({
    after: promise => promise.then(result => { sentWhenRepainted.push(h.drafts.sent.length); return result; })
  });
  h.fire('submit', replyForm({ body: 'Fixed now.', mode: 'reply' }).form);
  await ticks(5);
  assert.deepEqual(sentWhenRepainted, [1], 'a repaint before it would draw the sent reply back into the box');
});

/* ── Reply and set to Waiting (audit #5) ─────────────────────────────────── */

test('reply and set to Waiting sends the reply, then the status, once the reply is confirmed sent', async () => {
  const h = load();
  h.fire('submit', replyForm({ body: 'Fixed now.', mode: 'reply', thenWaiting: 'on' }).form);
  await ticks(8);
  assert.deepEqual(h.calls, [['replyToTicket', 'u142', 'Fixed now.', 'reply'], ['setTicketStatus', 'u142', 'waiting']]);
  assert.match(h.toasts.at(-1), /^Reply sent to ana@northline\.example\. Status: Waiting\./);
});

test('reply and set to Waiting does nothing extra for a note, or a reply only saved, not sent', async () => {
  const note = load();
  note.fire('submit', replyForm({ body: 'Provider outage.', mode: 'note', thenWaiting: 'on' }).form);
  await ticks(8);
  assert.deepEqual(note.calls, [['replyToTicket', 'u142', 'Provider outage.', 'note']], 'a note is never followed by a status change');

  const unsent = load({ actions: { replyToTicket: () => Promise.resolve({ sent: false, reason: 'No mailbox is connected.' }) } });
  unsent.fire('submit', replyForm({ body: 'Fixed now.', mode: 'reply', thenWaiting: 'on' }).form);
  await ticks(8);
  assert.deepEqual(unsent.calls, [['replyToTicket', 'u142', 'Fixed now.', 'reply']],
    'a reply that was not actually sent leaves the status alone: "Waiting" would not be true');
  assert.equal(unsent.toasts.at(-1), 'No mailbox is connected.');
});

test('an unchecked box leaves the status exactly as replying alone always has', async () => {
  const h = load();
  h.fire('submit', replyForm({ body: 'Fixed now.', mode: 'reply' }).form);
  await ticks(8);
  assert.deepEqual(h.calls, [['replyToTicket', 'u142', 'Fixed now.', 'reply']]);
});

test('reply and set to Waiting says so when the reply sent but the status could not be saved', async () => {
  const h = load({ actions: { setTicketStatus: () => Promise.reject(new Error('Only staff can change a ticket.')) } });
  h.fire('submit', replyForm({ body: 'Fixed now.', mode: 'reply', thenWaiting: 'on' }).form);
  await ticks(8);
  assert.equal(h.toasts.at(-1), 'Reply sent to ana@northline.example, but the status was not saved: Only staff can change a ticket.');
});

test('a note says nothing about whether the last reply went, either way', async () => {
  let asked = 0;
  const h = load({
    confirm: () => { asked += 1; return false; },
    actions: {
      replyToTicket: (id, body, kind) => (kind === 'note'
        ? Promise.resolve({ sent: false })
        : Promise.reject(mayHaveGone('The reply may have been sent. Look at the conversation before sending it again.')))
    }
  });
  h.fire('submit', replyForm({ body: 'Fixed now.', mode: 'reply' }).form);
  await ticks(5);
  h.fire('submit', replyForm({ body: 'Checking whether it went.', mode: 'note' }).form);
  await ticks(5);
  h.fire('submit', replyForm({ body: 'Fixed now.', mode: 'reply' }).form);
  await ticks(5);
  assert.equal(asked, 1, 'a note saved in between does not stop the question');
  assert.equal(h.calls.filter(call => call[3] === 'reply').length, 1, 'declined: the reply is not sent twice');

  let askedAfterNote = 0;
  const quiet = load({
    confirm: () => { askedAfterNote += 1; return true; },
    actions: {
      replyToTicket: (id, body, kind) => (kind === 'note'
        ? Promise.reject(mayHaveGone('The note may have been saved. Look at the conversation before adding it again.'))
        : Promise.resolve({ sent: true, to: 'ana@northline.example' }))
    }
  });
  quiet.fire('submit', replyForm({ body: 'Checking.', mode: 'note' }).form);
  await ticks(5);
  quiet.fire('submit', replyForm({ body: 'Fixed now.', mode: 'reply' }).form);
  await ticks(5);
  assert.equal(askedAfterNote, 0, 'a note that got no answer is not a reply that may have gone');
});

test('a reply whose answer never arrived asks before sending again', async () => {
  let asked = 0;
  let decline = true;
  const h = load({
    confirm: () => { asked += 1; return !decline; },
    actions: {
      replyToTicket: () => Promise.reject(Object.assign(
        new Error('The reply may have been sent. Look at the conversation before sending it again.'), { unknownOutcome: true }))
    }
  });
  const f = replyForm({ body: 'Fixed now.', mode: 'reply' });
  h.fire('submit', f.form);
  await ticks(5);
  h.fire('submit', f.form);
  await ticks(5);
  assert.equal(asked, 1);
  assert.equal(h.calls.length, 1, 'declined: nothing is sent again');
  decline = false;
  h.fire('submit', f.form);
  await ticks(5);
  assert.equal(h.calls.length, 2, 'confirmed: sent again');
});

/* ── A new ticket ─────────────────────────────────────────────────────── */

test('a new ticket files its requester as the customer, by name or address, and never as the product', async () => {
  const h = load();
  h.fire('submit', createForm({ name: 'Checkout is broken', context: 'ANA@northline.example', description: 'It fails at payment.', priority: 'High' }).form);
  await ticks(8);
  assert.equal(h.calls[0][0], 'createTicket');
  assert.deepEqual({ ...h.calls[0][1] }, { subject: 'Checkout is broken', product: null, priority: 'high', contactId: 'c1', companyId: 'co1' });
  assert.deepEqual(h.calls[1], ['replyToTicket', 'u200', 'It fails at payment.', 'note']);
  assert.deepEqual(h.navigated, ['tickets/200']);
  assert.deepEqual(h.toasts, ['Ticket #VYG-200 opened']);
});

test('a requester the CRM does not know is written into the opening note rather than dropped', async () => {
  const h = load();
  h.fire('submit', createForm({ name: 'Question', context: 'Someone New', description: 'Do you ship to Canada?', priority: 'Urgent' }).form);
  await ticks(8);
  assert.deepEqual({ ...h.calls[0][1] }, { subject: 'Question', product: null, priority: 'urgent', contactId: null, companyId: null });
  assert.equal(h.calls[1][2], 'Requester: Someone New\n\nDo you ship to Canada?');
});

test('a requester the CRM does not know, typed as an address, is still kept for a reply to reach (audit #1)', async () => {
  const h = load();
  h.fire('submit', createForm({ name: 'A question', context: 'guest@example.invalid', description: 'Do you ship to Canada?', priority: 'Normal' }).form);
  await ticks(8);
  assert.deepEqual({ ...h.calls[0][1] },
    { subject: 'A question', product: null, priority: 'normal', contactId: null, companyId: null, requesterEmail: 'guest@example.invalid' });
});

test('a name two contacts share is a question, not a guess: nothing is opened until an address says who', async () => {
  const twins = [...CONTACTS, {
    name: 'Ana Lima', email: 'ana@elsewhere.example',
    row: { id: 'c2', email: 'ana@elsewhere.example', company: { id: 'co2', name: 'Elsewhere' } }
  }];
  const h = load({ contacts: twins });
  const { form, button } = createForm({ name: 'Checkout', context: 'Ana Lima', description: '', priority: 'Low' });
  h.fire('submit', form);
  await ticks(8);
  assert.equal(h.calls.length, 0);
  assert.match(h.toasts.at(-1), /More than one contact is called "Ana Lima"/);
  assert.equal(form.dataset.pending, '', 'the form can be sent again');
  assert.equal(button.disabled, false);

  const byAddress = load({ contacts: twins });
  byAddress.fire('submit', createForm({ name: 'Checkout', context: 'ana@elsewhere.example', description: '', priority: 'Low' }).form);
  await ticks(8);
  assert.equal({ ...byAddress.calls[0][1] }.contactId, 'c2');
});

test('when the opening note fails, the ticket is not opened twice, and what was typed waits in its note box', async () => {
  const h = load({ actions: { replyToTicket: () => Promise.reject(new Error('The note could not be saved.')) } });
  const { form, button } = createForm({ name: 'Checkout is broken', context: 'Ana Lima', description: 'It fails at payment.', priority: 'Medium' });
  h.fire('submit', form);
  await ticks(8);
  h.fire('submit', form);
  await ticks(8);
  assert.equal(h.calls.filter(([name]) => name === 'createTicket').length, 1, 'sending the form again opens nothing');
  assert.equal(form.dataset.pending, '1');
  assert.equal(button.disabled, true);
  assert.deepEqual(h.drafts.kept, [['200', { body: 'It fails at payment.', mode: 'note' }]],
    'kept as the ticket\'s draft, drawn when its page is — even if it has not loaded yet');
  assert.deepEqual(h.navigated, ['tickets/200']);
  assert.deepEqual(h.keptWhenNavigated, [1], 'kept before the page moves, so the page is drawn with it');
  assert.match(h.toasts.at(-1), /^Ticket #VYG-200 opened, but its description did not save: The note could not be saved\. It is waiting in the note box/);
});

test('when whether the opening note saved is not known, the ticket says so rather than that it failed', async () => {
  const h = load({
    actions: { replyToTicket: () => Promise.reject(mayHaveGone('The note may have been saved. Look at the conversation before adding it again.')) }
  });
  h.fire('submit', createForm({ name: 'Checkout is broken', context: 'Ana Lima', description: 'It fails at payment.', priority: 'Normal' }).form);
  await ticks(8);
  assert.match(h.toasts.at(-1), /^Ticket #VYG-200 opened\. Whether its description saved is not known: look at the conversation/);
  assert.doesNotMatch(h.toasts.at(-1), /did not save/);
});

test('the New ticket form offers the priorities the database has, with Normal chosen', () => {
  const app = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.match(app, /<select name="priority"><option>Low<\/option><option selected>Normal<\/option><option>High<\/option><option>Urgent<\/option><\/select>/);
});
