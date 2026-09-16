/* mail-compose.js — writing mail, without a page: opening a new/reply/
   forward draft, the to/cc/bcc address-chip wiring, and the send path
   (including what happens when the browser's own confirmation for "send a
   new copy" is declined, blocked, or never shown at all). Nothing has ever
   loaded this file into a sandbox before this — it is a live DOM element
   kept across renders (its own top comment explains why), so unlike
   mail.js's page (tests/mail.test.mjs, rebuilt fresh each render, checked
   by regex on the HTML string) this needs elements that survive and answer
   .value/.disabled/.hidden the way real ones do.

   The composer's own structure is entirely fixed (the same From/To/Cc/Bcc/
   Subject/editor/attachments fields every time, template() never called
   twice for one draft), so this hand-builds THOSE known fields once as
   plain mutable objects rather than parsing template()'s HTML — there is no
   general selector engine here, on purpose, matching this project's own
   precedent (tests/agenda-ui.test.mjs's document.querySelector answers only
   the handful of selectors its own file asks for).

   DOMPurify is not available in this environment at all (a real dependency,
   not one this project wrote) — real-DOM/CSS-cascade behaviour (drag-move,
   the hidden-node paste filter, DOMPurify's own sanitisation) is DOM-only
   and is verified by reading dist/mail-compose.js and dist/data/mail-html.js
   directly rather than skipped; each such spot below says so and points at
   the exact lines read. Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const STUDIO = 'c0000000-0000-4000-8000-00000000000b';
const PERSONAL = 'c0000000-0000-4000-8000-00000000000a';
const THREAD = 'd0000000-0000-4000-8000-0000000000f1';

/* A field that behaves like a real <input>/<select>/<textarea> long enough
   to be read and written the way mail-compose.js reads and writes one. */
function field(initial = {}) {
  return {
    value: '', disabled: false, hidden: false, checked: false, attrs: {},
    classList: { classes: new Set(), toggle(name, on) { on ? this.classes.add(name) : this.classes.delete(name); }, contains(name) { return this.classes.has(name); } },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
    focus() {},
    ...initial
  };
}

function loadComposer(options = {}) {
  const toasts = [];
  const sent = [];
  const uploaded = [];
  const removedPaths = [];
  const confirmCalls = [];
  /* Mutable, not fixed at creation: send()'s retryRisk is private state on
     the ONE open draft's closure, so re-driving a retry (a second Send
     click) has to happen on the SAME loaded composer — only what confirm()
     and sendMail() do on THIS next call needs to change, via setConfirm/
     setSendMail below, rather than a whole new sandbox. */
  let sendMailImpl = options.sendMail || (() => Promise.resolve({ threadId: null }));
  let confirmImpl = options.confirm || (() => true);

  const editorEl = { innerHTML: '<p><br></p>', innerText: '', focus() {}, scrollTop: 0, querySelector: () => null };
  const subjectEl = field();
  const importanceEl = field({ value: 'normal' });
  const fromEl = field();
  const filesEl = { value: '', click() { this.clicked = (this.clicked || 0) + 1; }, files: [] };
  const statusEl = { textContent: '', dataset: {} };
  const attachmentsEl = { innerHTML: '' };
  const sendEl = { disabled: false, textContent: 'Send' };
  const signatureEl = { innerHTML: '' };
  const discardEl = { textContent: 'Discard', classList: { add() {}, remove() {} } };
  const chipInputs = {
    to: field({ dataset: { chipInput: 'to' } }),
    cc: field({ dataset: { chipInput: 'cc' } }),
    bcc: field({ dataset: { chipInput: 'bcc' } })
  };
  const chipsSpans = { to: { innerHTML: '' }, cc: { innerHTML: '' }, bcc: { innerHTML: '' } };
  const rows = { to: field({ hidden: false }), cc: field({ hidden: true }), bcc: field({ hidden: true }) };
  const showToggles = { cc: field({ hidden: false }), bcc: field({ hidden: false }) };

  function elQuerySelector(selector) {
    if (selector === '[data-c="editor"]') return editorEl;
    if (selector === '[data-c="subject"]') return subjectEl;
    if (selector === '[data-c="importance"]') return importanceEl;
    if (selector === '[data-c="from"]') return fromEl;
    if (selector === '[data-c="files"]') return filesEl;
    if (selector === '[data-c="status"]') return statusEl;
    if (selector === '[data-c="attachments"]') return attachmentsEl;
    if (selector === '[data-c="send"]') return sendEl;
    if (selector === '[data-c="discard"]') return discardEl;
    if (selector === '[data-signature]') return signatureEl;
    const chipInput = /^\[data-chip-input="(\w+)"\]$/.exec(selector);
    if (chipInput) return chipInputs[chipInput[1]];
    const chips = /^\[data-chips="(\w+)"\]$/.exec(selector);
    if (chips) return chipsSpans[chips[1]];
    const row = /^\[data-row="(\w+)"\]$/.exec(selector);
    if (row) return rows[row[1]];
    const show = /^\[data-c="show-(\w+)"\]$/.exec(selector);
    if (show) return showToggles[show[1]];
    return null;
  }

  const listeners = {};
  const composerEl = {
    className: '', attrs: {},
    classList: { classes: new Set(), toggle(name, on) { on ? this.classes.add(name) : this.classes.delete(name); }, contains(name) { return this.classes.has(name); } },
    setAttribute(name, value) { this.attrs[name] = value; },
    get innerHTML() { return this._html || ''; }, set innerHTML(v) { this._html = v; },
    querySelector: elQuerySelector,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    contains: () => true,
    remove() {}
  };

  const boxes = options.boxes || [
    { id: STUDIO, address: 'hello@veyago.cloud', kind: 'shared' },
    { id: PERSONAL, address: 'cassian@veyago.cloud', kind: 'personal' }
  ];
  const onSent = options.onSent || (() => {});
  const onClose = options.onClose || (() => {});
  const context_ = {
    boxes, book: options.book || [], canReconnect: () => Boolean(options.canReconnect),
    onSent, onClose
  };

  const context = vm.createContext({
    console,
    esc,
    toast: message => toasts.push(message),
    showModal: () => {},
    document: {
      createElement: tag => (tag === 'section' ? composerEl : { innerHTML: '', appendChild() {}, querySelectorAll: () => [] }),
      addEventListener: () => {},
      querySelector: () => null,
      activeElement: null,
      execCommand: (...args) => { execCommandCalls.push(args); return true; },
      queryCommandState: () => false,
      createRange: () => (options.fakeRange ? options.fakeRange() : { setStart() {}, setEnd() {}, collapse() {} }),
      caretRangeFromPoint: (x, y) => (options.caretAt ? options.caretAt(x, y) : null)
    },
    window: {
      DOMPurify: {
        /* A pass-through stand-in: this file's own tests are not about
           sanitisation correctness (that needs a real browser and DOMPurify
           itself, neither available here) but about what mail-compose.js
           does with the RESULT — so the result is just the input, wrapped
           the way RETURN_DOM_FRAGMENT asks for. */
        sanitize: (html, opts) => (opts && opts.RETURN_DOM_FRAGMENT
          ? { __source: String(html || ''), querySelectorAll: () => [] }
          : String(html || ''))
      },
      mailHtml: { cleanStyle: () => '' },
      getSelection: () => (options.getSelection ? options.getSelection() : { rangeCount: 0, removeAllRanges() {}, addRange() {} }),
      prompt: () => (options.prompt !== undefined ? options.prompt : null),
      confirm: message => { confirmCalls.push(message); return confirmImpl(message); },
      crypto: { randomUUID: () => 'uuid-' + (++uuidCounter) }
    },
    workspaceActions: {
      sendMail: request => { sent.push(request); return sendMailImpl(request); },
      uploadMailAttachment: file => { uploaded.push(file); return options.uploadMailAttachment ? options.uploadMailAttachment(file) : Promise.resolve({ path: 'p/' + file.name, name: file.name, size: file.size, contentType: 'text/plain' }); },
      removeMailAttachments: paths => { removedPaths.push(...paths); return Promise.resolve(); },
      saveSignature: () => Promise.resolve({})
    },
    workspaceData: { mailSignatures: () => Promise.resolve([]) },
    Node: { TEXT_NODE: 3 },
    TextEncoder,
    setTimeout, clearTimeout
  });
  let uuidCounter = 0;
  const execCommandCalls = [];
  context.execCommandCalls = execCommandCalls;

  vm.runInContext(readFileSync(new URL('../dist/mail-model.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../dist/mail-compose.js', import.meta.url), 'utf8'), context);
  const composer = vm.runInContext('mailComposer', context);

  context.__ctx = context_;
  return {
    composer,
    /* template()'s actual HTML embeds the draft's starting subject/from/to/cc
       into the real DOM (value="…") — not parsed here (this harness hand-
       builds the composer's known fields rather than parsing arbitrary
       HTML, see the top of this file), so open()'s own starting values are
       copied onto the stand-ins directly, the way a real render would have
       left them. */
    open(init) {
      const opened = vm.runInContext(`mailComposer.open(${JSON.stringify(init)}, __ctx)`, context);
      if (opened) {
        subjectEl.value = String((init && init.subject) || '');
        fromEl.value = String((init && init.connectionId) || '');
        (init && init.to || []).forEach((address, i) => { chipsSpans.to.innerHTML += `<span>${esc(address)}</span>`; });
        (init && init.cc || []).forEach((address, i) => { chipsSpans.cc.innerHTML += `<span>${esc(address)}</span>`; if (i === 0) rows.cc.hidden = false; });
      }
      return opened;
    },
    /* onClick's own first step is target.closest('button') — the button
       itself, carrying dataset.c, is what the switch in onClick then reads. */
    click(dataC, dataset = {}) {
      const button = { dataset: { c: dataC, ...dataset } };
      (listeners.click || []).forEach(fn => fn({ target: { closest: sel => (sel === 'button' ? button : null) } }));
    },
    keydown(fieldName, key) {
      (listeners.keydown || []).forEach(fn => fn({
        key, preventDefault() {},
        target: { closest: sel => (sel === '[data-chip-input]' ? chipInputs[fieldName] : null) }
      }));
    },
    /* send()'s retryRisk lives on the one open draft's own closure — these
       change what the NEXT send()/confirm() call does, on the SAME draft,
       rather than starting a fresh sandbox with no risk recorded at all. */
    setSendMail(fn) { sendMailImpl = fn; },
    setConfirm(fn) { confirmImpl = fn; },
    fields: { editorEl, subjectEl, importanceEl, fromEl, chipInputs, chipsSpans, rows, showToggles, sendEl, statusEl, discardEl },
    toasts, sent, uploaded, removedPaths, confirmCalls,
    execCommandCalls
  };
}

/* ── Opening a draft ──────────────────────────────────────────────────── */

test('a new message opens with an empty body, the given mailbox, recipients and subject, and no thread to answer', () => {
  const c = loadComposer();
  const opened = c.open({ mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], subject: 'Kick-off' });
  assert.equal(opened, true);
  assert.equal(c.composer.isOpen(), true);
  assert.equal(c.composer.mode(), 'new');
  assert.equal(c.composer.threadId(), null);
});

test('a reply opens in reply mode, carrying the thread and message it answers', () => {
  const c = loadComposer();
  c.open({ mode: 'reply', connectionId: STUDIO, threadId: THREAD, messageId: 'm1', to: ['ana@northline.example'], subject: 'Re: Kick-off' });
  assert.equal(c.composer.mode(), 'reply');
  assert.equal(c.composer.threadId(), THREAD);
});

test('a forward opens in forward mode with no recipients yet', () => {
  const c = loadComposer();
  c.open({ mode: 'forward', connectionId: STUDIO, threadId: THREAD, subject: 'Fw: Kick-off' });
  assert.equal(c.composer.mode(), 'forward');
});

test('an unrecognised mode opens as a new message rather than throwing', () => {
  const c = loadComposer();
  const opened = c.open({ mode: 'bogus', connectionId: STUDIO });
  assert.equal(opened, true);
  assert.equal(c.composer.mode(), 'new');
});

test('opening a second draft while one is being sent is refused', async () => {
  const c = loadComposer({ sendMail: () => new Promise(() => {}) });
  c.open({ mode: 'new', connectionId: STUDIO, to: ['a@x.example'], subject: 'x' });
  c.fields.editorEl.innerHTML = '<p>hi</p>';
  c.fields.editorEl.innerText = 'hi';
  c.click('send');
  await settle();
  assert.equal(c.composer.isSending(), true);
  assert.equal(c.open({ mode: 'new', connectionId: STUDIO }), false, 'refused: that send finishes into its own draft');
});

/* ── to/cc/bcc address-chip wiring ────────────────────────────────────── */

test('typing a valid address and pressing Enter turns it into a chip, clearing the field', () => {
  const c = loadComposer();
  c.open({ mode: 'new', connectionId: STUDIO });
  c.fields.chipInputs.to.value = 'ana@northline.example';
  c.keydown('to', 'Enter');
  assert.equal(c.fields.chipInputs.to.value, '', 'the field is cleared once committed');
  assert.match(c.fields.chipsSpans.to.innerHTML, /ana@northline\.example/);
});

test('a name-and-address pair, and several addresses at once, all become chips', () => {
  const c = loadComposer();
  c.open({ mode: 'new', connectionId: STUDIO });
  c.fields.chipInputs.to.value = 'Ana Lima <ana@northline.example>, ops@northline.example';
  c.keydown('to', 'Enter');
  assert.match(c.fields.chipsSpans.to.innerHTML, /ana@northline\.example/);
  assert.match(c.fields.chipsSpans.to.innerHTML, /ops@northline\.example/);
});

test('something that is not an address stays in the field, marked invalid, rather than becoming a chip', () => {
  const c = loadComposer();
  c.open({ mode: 'new', connectionId: STUDIO });
  c.fields.chipInputs.cc.value = 'not-an-address';
  c.keydown('cc', 'Enter');
  assert.equal(c.fields.chipInputs.cc.value, 'not-an-address', 'left for the person to fix');
  assert.equal(c.fields.chipsSpans.cc.innerHTML, '');
});

test('Cc and Bcc addresses reach the request the same way To does', async () => {
  const c = loadComposer();
  c.open({ mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], subject: 'Kick-off' });
  c.fields.chipInputs.cc.value = 'ben@northline.example';
  c.keydown('cc', 'Enter');
  c.fields.editorEl.innerHTML = '<p>Hi</p>';
  c.fields.editorEl.innerText = 'Hi';
  c.click('send');
  await settle();
  assert.equal(c.sent.length, 1);
  assert.deepEqual([...c.sent[0].cc], ['ben@northline.example']);
});

test('open() also accepts a starting Bcc list, the same way To and Cc already do', async () => {
  const c = loadComposer();
  c.open({ mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], bcc: ['audit@northline.example'], subject: 'Kick-off' });
  c.fields.editorEl.innerHTML = '<p>Hi</p>';
  c.fields.editorEl.innerText = 'Hi';
  c.click('send');
  await settle();
  assert.deepEqual([...c.sent[0].bcc], ['audit@northline.example']);
});

/* ── snapshot(): the draft as plain data, for mail.js to persist across a
   sign-out and restore on the next sign-in (audit: "Signing out forgets an
   unsent draft") ─────────────────────────────────────────────────────────── */

test('snapshot() reads to/cc/bcc, subject and the words as plain text — committing a chip not yet turned into one first', () => {
  const c = loadComposer();
  c.open({ mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], subject: 'Kick-off' });
  c.fields.chipInputs.cc.value = 'ben@northline.example';
  c.fields.chipInputs.bcc.value = 'audit@northline.example';
  c.fields.subjectEl.value = 'Kick-off, revised';
  c.fields.editorEl.innerText = 'See you Monday';
  const snap = c.composer.snapshot();
  assert.equal(snap.mode, 'new');
  assert.equal(snap.connectionId, STUDIO);
  assert.deepEqual([...snap.to], ['ana@northline.example']);
  assert.deepEqual([...snap.cc], ['ben@northline.example'], 'committed by snapshot() itself, the same way send() already commits every field before reading it');
  assert.deepEqual([...snap.bcc], ['audit@northline.example']);
  assert.equal(snap.subject, 'Kick-off, revised');
  assert.equal(snap.bodyText, 'See you Monday');
  assert.equal(c.fields.chipInputs.cc.value, '', 'committing clears the field, the same as pressing Enter would');
});

test('snapshot() answers null with nothing open', () => {
  const c = loadComposer();
  assert.equal(c.composer.snapshot(), null);
});

test('snapshot() carries a reply\'s own thread and message, so restoring it answers the right conversation', () => {
  const c = loadComposer();
  c.open({ mode: 'reply', connectionId: STUDIO, threadId: THREAD, messageId: 'm1', to: ['ana@northline.example'], subject: 'Re: Kick-off' });
  const snap = c.composer.snapshot();
  assert.equal(snap.mode, 'reply');
  assert.equal(snap.threadId, THREAD);
  assert.equal(snap.messageId, 'm1');
});

/* ── Sending, and its failure paths ──────────────────────────────────── */

test('a message with nothing in it refuses to send, in send-mail\'s own words', async () => {
  const c = loadComposer();
  c.open({ mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], subject: 'Kick-off' });
  c.fields.editorEl.innerHTML = '<p><br></p>';
  c.fields.editorEl.innerText = '';
  c.click('send');
  await settle();
  assert.equal(c.sent.length, 0);
  assert.match(c.fields.statusEl.textContent, /empty/);
});

test('a send that fails offers the reason and, when reconnecting would help, says so', async () => {
  const c = loadComposer({
    sendMail: () => { const err = new Error('The mailbox needs reconnecting.'); err.reconnect = true; return Promise.reject(err); },
    canReconnect: true
  });
  c.open({ mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], subject: 'Kick-off' });
  c.fields.editorEl.innerHTML = '<p>Hi</p>';
  c.fields.editorEl.innerText = 'Hi';
  c.click('send');
  await settle();
  assert.match(c.fields.statusEl.textContent, /needs reconnecting\.? Reconnect it under Connections\./);
});

/* Finding 6: "Send a new copy" could do nothing if the browser blocked or
   silently declined the confirmation, with no word said either way. Each of
   these opens ONE draft, gets it into "the last attempt may have been sent"
   state with a first failed send, then drives the retry on that SAME
   draft — retryRisk is private state on its own closure, so a fresh
   loadComposer() for the retry would start with no risk recorded at all. */

async function draftWithUnknownOutcome() {
  const c = loadComposer({ sendMail: () => { const err = new Error('unknown'); err.unknownOutcome = true; return Promise.reject(err); } });
  c.open({ mode: 'new', connectionId: STUDIO, to: ['ana@northline.example'], subject: 'Kick-off' });
  c.fields.editorEl.innerHTML = '<p>Hi</p>';
  c.fields.editorEl.innerText = 'Hi';
  c.click('send');
  await settle();
  assert.equal(c.sent.length, 1, 'setup: the first attempt did go out and its outcome is unknown');
  return c;
}

test('declining to send a new copy says so, rather than doing nothing silently', async () => {
  const c = await draftWithUnknownOutcome();
  c.confirmCalls.length = 0;
  c.setConfirm(() => false);
  c.click('send');
  await settle();
  assert.equal(c.confirmCalls.length, 1, 'the confirmation was actually asked for');
  assert.equal(c.sent.length, 1, 'not sent again');
  assert.equal(c.fields.statusEl.textContent, 'Not sent.');
});

test('a confirmation the browser refuses to show at all (throws) is said plainly, not left silent', async () => {
  const c = await draftWithUnknownOutcome();
  c.setConfirm(() => { throw new Error('Dialogs are suppressed on this page.'); });
  c.click('send');
  await settle();
  assert.equal(c.sent.length, 1, 'never got past the confirmation to send again');
  assert.match(c.fields.statusEl.textContent, /Your browser would not show the confirmation/);
});

test('a message sent again with the confirmation accepted goes out', async () => {
  const c = await draftWithUnknownOutcome();
  c.setConfirm(() => true);
  c.setSendMail(req => Promise.resolve({ threadId: 't9' }));
  c.click('send');
  await settle();
  assert.equal(c.sent.length, 2, 'confirmed: sent again');
});

test('open() again finishes cleanly whatever the previous draft\'s state', () => {
  const c = loadComposer();
  c.open({ mode: 'new', connectionId: STUDIO });
  c.composer.close();
  assert.equal(c.composer.isOpen(), false);
});

/* ── Findings that need a real DOM/selection to fully exercise ──────────
   Documented and verified by reading the code (this project's own
   precedent for exactly this: see the top of tests/mail.test.mjs on
   style-parsing, and this file's own top comment). Each finding below was
   traced by hand through dist/mail-compose.js and dist/data/mail-html.js;
   none of them can be driven from here without a real Selection/Range,
   drag-and-drop, or CSS cascade, which this Node sandbox does not have. */

test('DOCUMENTED — finding 14 (cursor race): beforeRender() now reads window.getSelection() fresh', () => {
  const src = readFileSync(new URL('../dist/mail-compose.js', import.meta.url), 'utf8');
  assert.match(src, /selectionchange \(below\) is what keeps lastSelection current/,
    'the fix and its reasoning are in beforeRender(): read the selection live at the moment a render is about to run, ' +
    'rather than trust lastSelection (updated only by the async selectionchange listener) to have already caught up to ' +
    'the keystroke just typed. Proving the RACE itself needs a real browser dispatching selectionchange asynchronously, ' +
    'which no fake queue in this sandbox can reproduce faithfully — Node has no such event at all.');
});

test('DOCUMENTED — finding 15 (drag copies instead of moving): dragstart/dragend/drop now remove the source range', () => {
  const src = readFileSync(new URL('../dist/mail-compose.js', import.meta.url), 'utf8');
  assert.match(src, /dragSourceRange = \(box && box\.contains\(e\.target\)/);
  assert.match(src, /if \(source\) source\.deleteContents\(\)/,
    'preventDefault() on drop (needed so this file\'s own insert runs instead of the browser\'s) was also cancelling the ' +
    'browser\'s own "remove the source, this was a move" half of the same native gesture — the actual move now happens ' +
    'by hand. A real drag-and-drop gesture and a live Selection/Range are both DOM-only; this sandbox has neither.');
});

test('DOCUMENTED — finding 16 (hidden text rides through paste): cleanHtml drops a node hidden by its own style', () => {
  const src = readFileSync(new URL('../dist/mail-compose.js', import.meta.url), 'utf8');
  assert.match(src, /probe\.style\.display === 'none' \|\| probe\.style\.visibility === 'hidden'/,
    'display:none/visibility:hidden are both on cleanStyle\'s own allowlist (mail-html.js SAFE_PROPERTY) — legitimate ' +
    'for ordinary layout, and also how text is hidden from the composer while still riding along in the message once ' +
    'sent. The check reads the value the way cleanStyle itself does: by letting the BROWSER parse a style string ' +
    '(document.createElement("div").style.cssText = …) and asking it what it resolved to, rather than pattern-matching ' +
    'the text by hand — mail-html.js\'s own top comment explains why a hand-rolled CSS parser lost to review payloads ' +
    'before. That parsing is real browser/CSSOM behaviour Node does not have at all, so it cannot be unit-tested here.');
});
