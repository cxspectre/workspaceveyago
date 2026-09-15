/* mail-compose.js — writing mail, in the reading pane.
 *
 * New messages, replies, reply-all and forwards, laid out the way Outlook lays
 * them out: From, To, Cc and Bcc as address chips with suggestions, a subject,
 * importance, a formatting toolbar, the mailbox's signature, and attachments
 * that upload as they are added. Sent through workspaceActions.sendMail(), which
 * hands it to send-mail, where every rule is checked again.
 *
 * One draft at a time, kept as a live element rather than drawn from a string:
 * the Mail view rebuilds its HTML on every change, and an editor rebuilt from
 * HTML loses what was typed, the caret and the undo history. mail.js leaves a
 * [data-composer-slot] where the draft belongs; afterRender() moves the element
 * into it, and it waits, detached and intact, while it is not on screen.
 *
 * The decisions — who an answer goes to, limits, signatures, what stops a
 * send — are in mail-model.js, which is tested.
 */
const mailComposer = (function () {
  'use strict';

  const M = mailModel;
  const MODE_LABELS = Object.freeze({ new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' });
  const FONT_SIZES = Object.freeze([['2', 'Small'], ['3', 'Normal'], ['5', 'Large'], ['6', 'Huge']]);
  const COLOURS = Object.freeze([['#1d1d1f', 'Black'], ['#0066cc', 'Blue'], ['#248a3d', 'Green'], ['#b45309', 'Amber'], ['#c62828', 'Red'], ['#7b3fc4', 'Purple']]);
  const STATEFUL = Object.freeze(['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']);
  const TOOLBAR_CONTROLS = '.composer-tool, .composer-size, .composer-swatch';
  const LINK = /^(https?:\/\/|mailto:)\S+$/i;
  const DISCARD_WINDOW_MS = 4000;
  /* Mail clients ignore the page's stylesheet, so the message carries its own. */
  const BODY_STYLE = "font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;"
    + ' font-size: 14px; line-height: 1.5; color: #1d1d1f;';

  let draft = null;                 // what the draft says; replaced, never edited
  let uploads = Object.freeze([]);  // its attachments, as they upload
  let el = null;                    // the editor element: the one thing kept alive
  let context = null;               // { boxes, book, canReconnect, onSent, onClose } from mail.js
  let signatures = null;            // the person's signatures, once they have loaded
  let appliedSignature = '';        // what was last put in the signature block
  let lastSelection = null;         // the editor's selection, as nodes and offsets
  let focusBefore = null;           // what had focus when a render began
  let fieldSelection = null;        // and, for a text field, where its caret was
  let scrollBefore = 0;
  let rendering = false;
  let sending = false;
  let retryRisk = null;             // 'draft' | 'unknown': the last send may have left a copy
  let discardArmedUntil = 0;

  const find = selector => (el ? el.querySelector(selector) : null);
  const editor = () => find('[data-c="editor"]');
  const statusId = () => (draft ? `composer-status-${draft.id}` : '');
  const hasFiles = e => Boolean(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
  const fileSize = bytes => (bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

  /* Pasted, dropped and stored HTML: DOMPurify with the editor's setting, then
     every inline style through the filter mail being read goes through — no
     position:fixed laid over the workspace, nothing fetched from a url(). */
  function cleanHtml(html) {
    const fragment = window.DOMPurify.sanitize(String(html || ''), { ...M.PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true });
    fragment.querySelectorAll('[style]').forEach(node => {
      const kept = window.mailHtml ? window.mailHtml.cleanStyle(node.getAttribute('style'), { showImages: false }) : '';
      if (kept) node.setAttribute('style', kept);
      else node.removeAttribute('style');
    });
    const holder = document.createElement('div');
    holder.appendChild(fragment);
    return holder.innerHTML;
  }

  function status(message, kind) {
    const node = find('[data-c="status"]');
    if (!node) return;
    node.textContent = message || '';
    node.dataset.kind = kind || '';
  }

  /* ── Selection that survives a render ──────────────────────────────── */

  /* Kept as boundary nodes and offsets, not as a live Range: a Range inside the
     editor collapses onto #main the moment a render replaces the page around
     it, and restoring that put the caret at the top of the message. */
  const snapshot = range => Object.freeze({
    startContainer: range.startContainer, startOffset: range.startOffset,
    endContainer: range.endContainer, endOffset: range.endOffset
  });
  const nodeLength = node => (node.nodeType === Node.TEXT_NODE ? node.length : node.childNodes.length);

  function rangeFrom(saved, box) {
    if (!saved || !box || !box.contains(saved.startContainer) || !box.contains(saved.endContainer)) return null;
    try {
      const range = document.createRange();
      range.setStart(saved.startContainer, Math.min(saved.startOffset, nodeLength(saved.startContainer)));
      range.setEnd(saved.endContainer, Math.min(saved.endOffset, nodeLength(saved.endContainer)));
      return range;
    } catch (stale) {
      return null;
    }
  }

  function restoreSelection() {
    const box = editor();
    if (!box) return;
    box.focus({ preventScroll: true });
    const range = rangeFrom(lastSelection, box);
    if (!range) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  document.addEventListener('selectionchange', () => {
    const box = editor();
    const selection = window.getSelection();
    if (!box || !selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!box.contains(range.commonAncestorContainer)) return;
    lastSelection = snapshot(range);
    updateToolState();
  });

  /* ── Recipients ────────────────────────────────────────────────────── */

  function chipsHtml(field) {
    return draft[field].map((address, i) =>
      `<span class="chip" title="${esc(address)}">${esc(address)}`
      + `<button type="button" data-chip-remove="${field}" data-index="${i}" aria-label="Remove ${esc(address)}">×</button></span>`).join('');
  }

  function setField(field, list) {
    draft = Object.freeze({ ...draft, [field]: Object.freeze([...list]) });
    const chips = find(`[data-chips="${field}"]`);
    if (chips) chips.innerHTML = chipsHtml(field);
  }

  /* What is typed into an address field becomes chips. What is not an address
     stays in the field, marked and said out loud, for the person to fix. */
  function commitInput(field) {
    const input = find(`[data-chip-input="${field}"]`);
    if (!input) return true;
    if (!input.value.trim()) {
      input.setAttribute('aria-invalid', 'false');
      return true;
    }
    const parsed = M.parseAddresses(input.value);
    const known = draft[field].map(a => a.toLowerCase());
    setField(field, [...draft[field], ...parsed.valid.filter(a => !known.includes(a.toLowerCase()))]);
    const invalid = parsed.invalid.length > 0;
    input.value = parsed.invalid.join(', ');
    input.classList.toggle('invalid', invalid);
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    if (invalid) {
      status(`${parsed.invalid.map(a => `"${a}"`).join(', ')} ${parsed.invalid.length === 1 ? 'does' : 'do'} not look like an email address.`, 'error');
    }
    return !invalid;
  }

  function showRow(field) {
    const row = find(`[data-row="${field}"]`);
    const toggle = find(`[data-c="show-${field}"]`);
    if (row) row.hidden = false;
    if (toggle) toggle.hidden = true;
    const input = row && row.querySelector('input');
    if (input) input.focus();
  }

  /* ── Drawing the draft, once ───────────────────────────────────────── */

  function template() {
    const answering = draft.mode !== 'new';
    /* The mailbox an answer goes out from is the one shown, even if the list of
       mailboxes did not load or does not include it. */
    const known = context.boxes.some(b => b.id === draft.connectionId);
    const from = (known ? '' : `<option value="${esc(draft.connectionId || '')}" selected>This conversation's mailbox</option>`)
      + context.boxes.map(b =>
        `<option value="${esc(b.id)}"${b.id === draft.connectionId ? ' selected' : ''}>${esc(b.address)}</option>`).join('');
    const row = (field, label) =>
      `<div class="composer-row" data-row="${field}"${field !== 'to' && !draft[field].length ? ' hidden' : ''}>`
      + `<span class="composer-label">${label}</span><div class="composer-chips"><span data-chips="${field}">${chipsHtml(field)}</span>`
      + `<input data-chip-input="${field}" list="composer-book" autocomplete="off" spellcheck="false" aria-label="${label}"`
      + ` aria-invalid="false" aria-describedby="${statusId()}"></div>`
      + (field === 'to'
        ? `<button type="button" class="text-btn" data-c="show-cc"${draft.cc.length ? ' hidden' : ''}>Cc</button>`
          + '<button type="button" class="text-btn" data-c="show-bcc">Bcc</button>'
        : '')
      + '</div>';
    const tool = (cmd, label, glyph, arg) =>
      `<button type="button" class="composer-tool" data-cmd="${cmd}"${arg ? ` data-arg="${esc(arg)}"` : ''}`
      + ` title="${label}" aria-label="${label}"${STATEFUL.includes(cmd) ? ' aria-pressed="false"' : ''}>${glyph}</button>`;

    return '<div class="composer-head"><div class="composer-title">'
      + `<strong>${MODE_LABELS[draft.mode]}</strong>`
      + (draft.about ? `<small class="composer-about">${esc(draft.about)}</small>` : '')
      + `</div><span class="composer-status" id="${statusId()}" data-c="status" role="status" aria-live="polite"></span></div>`
      + '<div class="composer-fields">'
      + `<label class="composer-row"><span class="composer-label">From</span><select data-c="from"${answering ? ' disabled' : ''}>${from}</select>`
      + (answering ? '<small class="composer-note">Answers go out from the mailbox the message arrived in.</small>' : '')
      + '</label>'
      + row('to', 'To') + row('cc', 'Cc') + row('bcc', 'Bcc')
      + `<label class="composer-row"><span class="composer-label">Subject</span>`
      + `<input data-c="subject" maxlength="${M.LIMITS.subjectLength}" value="${esc(draft.subject)}" aria-label="Subject"></label>`
      + '</div>'
      + '<div class="composer-toolbar" role="toolbar" aria-label="Formatting">'
      + tool('bold', 'Bold', '<b>B</b>') + tool('italic', 'Italic', '<i>I</i>')
      + tool('underline', 'Underline', '<u>U</u>') + tool('strikeThrough', 'Strikethrough', '<s>S</s>')
      + '<select class="composer-size" data-cmd-select="fontSize" aria-label="Text size">'
      + FONT_SIZES.map(([value, label]) => `<option value="${value}"${value === '3' ? ' selected' : ''}>${label}</option>`).join('')
      + '</select><span class="composer-swatches">'
      + COLOURS.map(([colour, name]) =>
        `<button type="button" class="composer-swatch" data-cmd="foreColor" data-arg="${colour}" style="background:${colour}" title="${name} text" aria-label="${name} text"></button>`).join('')
      + '</span>'
      + tool('hiliteColor', 'Highlight', '<span class="composer-highlight">ab</span>', '#fff3a3')
      + tool('insertUnorderedList', 'Bulleted list', '• —') + tool('insertOrderedList', 'Numbered list', '1. —')
      + tool('outdent', 'Decrease indent', '⇤') + tool('indent', 'Increase indent', '⇥')
      + tool('formatBlock', 'Quote', '“ ”', 'blockquote') + tool('createLink', 'Insert link', 'Link')
      + tool('removeFormat', 'Clear formatting', 'Clear')
      + '</div>'
      + `<div class="composer-editor" data-c="editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message">${draft.bodyHtml}</div>`
      + '<ul class="composer-attachments" data-c="attachments"></ul>'
      + '<div class="composer-foot">'
      + '<button type="button" class="btn btn-primary" data-c="send">Send</button>'
      + '<button type="button" class="btn" data-c="attach">Attach files</button><input type="file" data-c="files" multiple hidden>'
      + '<label class="composer-importance"><span>Importance</span><select data-c="importance">'
      + '<option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option></select></label>'
      + '<button type="button" class="text-btn" data-c="signatures">Signatures</button>'
      + '<button type="button" class="text-btn composer-discard" data-c="discard">Discard</button>'
      + '</div>'
      + `<datalist id="composer-book">${context.book.map(e => `<option value="${esc(e.email)}">${esc(e.name)}</option>`).join('')}</datalist>`;
  }

  /* ── Formatting ────────────────────────────────────────────────────── */

  function updateToolState() {
    if (!el) return;
    el.querySelectorAll('.composer-tool[aria-pressed]').forEach(button => {
      let on = false;
      try {
        on = document.queryCommandState(button.dataset.cmd);
      } catch (unsupported) {
        on = false;
      }
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function format(cmd, arg) {
    if (cmd === 'createLink') {
      const url = window.prompt('Link address', 'https://');
      restoreSelection();
      if (url === null) return;
      if (!LINK.test(url.trim())) {
        status('A link starts with https://, http:// or mailto:.', 'error');
        return;
      }
      document.execCommand('createLink', false, url.trim());
      return;
    }
    restoreSelection();
    /* Colours as inline styles, which mail clients keep; the rest as tags. */
    document.execCommand('styleWithCSS', false, cmd === 'foreColor' || cmd === 'hiliteColor');
    document.execCommand(cmd, false, arg || null);
    document.execCommand('styleWithCSS', false, false);
    updateToolState();
  }

  /* One tab stop for the whole toolbar; the arrow keys move along it. */
  function moveInToolbar(e) {
    const controls = [...el.querySelectorAll(TOOLBAR_CONTROLS)];
    const at = controls.indexOf(e.target);
    if (at < 0) return false;
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: controls.length - 1 }[e.key];
    if (next === undefined) return false;
    e.preventDefault();
    const target = controls[(next + controls.length) % controls.length];
    controls.forEach(control => { control.tabIndex = control === target ? 0 : -1; });
    target.focus();
    return true;
  }

  /* ── Signatures ────────────────────────────────────────────────────── */

  /* A load that failed is not remembered: the next attempt tries again, and
     nothing is saved over a signature the person was never shown. */
  async function loadSignatures() {
    if (signatures) return signatures;
    try {
      signatures = Object.freeze(await window.workspaceData.mailSignatures());
      return signatures;
    } catch (err) {
      console.error('[mail] signatures did not load:', err);
      return null;
    }
  }

  /* Only while the signature block still holds what was put there: words typed
     into it stay when From changes or a signature is saved. */
  async function applySignature() {
    const list = await loadSignatures();
    const block = find('[data-signature]');
    if (!list || !block || !draft || block.innerHTML !== appliedSignature) return;
    const html = M.signatureFor(list, draft.connectionId, draft.mode);
    block.innerHTML = html ? cleanHtml(html) : '';
    appliedSignature = block.innerHTML;
  }

  async function openSignatures() {
    const list = await loadSignatures();
    if (!list) {
      toast('Your signatures did not load. Try again in a moment.');
      return;
    }
    const initial = draft && draft.connectionId ? draft.connectionId : '';
    const options = [['', 'Every mailbox']].concat((context ? context.boxes : []).map(b => [b.id, b.address]));
    const tools = [['bold', 'Bold', '<b>B</b>'], ['italic', 'Italic', '<i>I</i>'], ['underline', 'Underline', '<u>U</u>'], ['createLink', 'Insert link', 'Link']];
    showModal('MAIL · SIGNATURES', '<h2>Signatures</h2>'
      + '<p class="form-note">A mailbox\'s own signature is used there instead of the one for every mailbox. '
      + 'It is added when a message is started, and can still be changed in the message.</p>'
      + '<form id="signature-form">'
      + '<label class="form-field">Mailbox<select name="connection">'
      + options.map(([value, label]) => `<option value="${esc(value)}"${value === initial ? ' selected' : ''}>${esc(label)}</option>`).join('')
      + '</select></label>'
      + '<div class="form-field"><span>Signature</span><div class="signature-toolbar">'
      + tools.map(([cmd, label, glyph]) => `<button type="button" class="composer-tool" data-sig-cmd="${cmd}" title="${label}" aria-label="${label}">${glyph}</button>`).join('')
      + '</div><div class="composer-editor signature-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Signature"></div></div>'
      + '<label class="check-row"><input type="checkbox" name="useOnNew"> Add to new messages</label>'
      + '<label class="check-row"><input type="checkbox" name="useOnReplies"> Add to replies and forwards</label>'
      + '<div class="dialog-actions"><button type="button" class="btn" data-action="close">Cancel</button>'
      + '<button type="submit" class="btn btn-primary">Save signature</button></div></form>');

    const form = document.getElementById('signature-form');
    const box = form.querySelector('.signature-editor');
    const fill = () => {
      const id = form.elements.connection.value || null;
      const existing = (signatures || list).find(s => (s.connection_id || null) === id);
      box.innerHTML = existing ? cleanHtml(existing.html) : '';
      form.elements.useOnNew.checked = existing ? existing.use_on_new !== false : true;
      form.elements.useOnReplies.checked = existing ? existing.use_on_replies !== false : true;
    };
    fill();
    form.elements.connection.addEventListener('change', fill);
    form.addEventListener('mousedown', e => { if (e.target.closest('[data-sig-cmd]')) e.preventDefault(); });
    form.addEventListener('click', e => {
      const button = e.target.closest('[data-sig-cmd]');
      if (!button) return;
      box.focus();
      if (button.dataset.sigCmd !== 'createLink') {
        document.execCommand(button.dataset.sigCmd, false, null);
        return;
      }
      const url = window.prompt('Link address', 'https://');
      box.focus();
      if (url !== null && LINK.test(url.trim())) document.execCommand('createLink', false, url.trim());
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const saved = await workspaceActions.saveSignature({
          connectionId: form.elements.connection.value || null,
          html: box.innerHTML,
          useOnNew: form.elements.useOnNew.checked,
          useOnReplies: form.elements.useOnReplies.checked
        });
        signatures = Object.freeze([saved].concat((signatures || []).filter(s =>
          (s.connection_id || null) !== (saved.connection_id || null))));
        document.querySelector('#modal').close();
        toast('Signature saved.');
        applySignature();
      } catch (err) {
        toast(err.message || 'The signature was not saved.');
      } finally {
        submit.disabled = false;
      }
    });
  }

  /* ── Attachments ───────────────────────────────────────────────────── */

  function renderUploads() {
    const list = find('[data-c="attachments"]');
    if (!list) return;
    list.innerHTML = uploads.map(u =>
      `<li class="composer-file ${u.state}"><span class="composer-file-name" title="${esc(u.name)}">${esc(u.name)}</span>`
      + `<small>${u.state === 'uploading' ? 'Uploading…' : u.state === 'failed' ? esc(u.error) : fileSize(u.size)}</small>`
      + `<button type="button" data-remove="${esc(u.key)}" aria-label="Remove ${esc(u.name)}">×</button></li>`).join('');
  }

  function updateUpload(key, changes) {
    uploads = Object.freeze(uploads.map(u => (u.key === key ? Object.freeze({ ...u, ...changes }) : u)));
    renderUploads();
  }

  function addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length || !draft) return;
    const problem = M.attachmentProblem(uploads.filter(u => u.state !== 'failed'), files);
    if (problem) {
      status(problem, 'error');
      return;
    }
    const owner = draft.id;
    const added = files.map(file => Object.freeze({
      key: window.crypto.randomUUID(), name: file.name, size: file.size, state: 'uploading', ref: null, error: null
    }));
    uploads = Object.freeze([...uploads, ...added]);
    renderUploads();
    status('');
    added.forEach((entry, i) => {
      workspaceActions.uploadMailAttachment(files[i])
        .then(ref => {
          /* Sent or discarded while this was uploading: nothing will send it. */
          if (!draft || draft.id !== owner || !uploads.some(u => u.key === entry.key)) {
            workspaceActions.removeMailAttachments([ref.path]).catch(() => undefined);
            return;
          }
          updateUpload(entry.key, { state: 'ready', ref });
        })
        .catch(err => updateUpload(entry.key, { state: 'failed', error: err.message || 'Did not upload' }));
    });
  }

  function removeUpload(key) {
    const entry = uploads.find(u => u.key === key);
    uploads = Object.freeze(uploads.filter(u => u.key !== key));
    renderUploads();
    if (entry && entry.ref) {
      workspaceActions.removeMailAttachments([entry.ref.path])
        .catch(err => console.warn('[mail] upload not removed:', err.message));
    }
  }

  /* ── Sending and closing ───────────────────────────────────────────── */

  function setBusy(on) {
    if (!el) return;
    el.classList.toggle('sending', on);
    const send = find('[data-c="send"]');
    if (!send) return;
    send.disabled = on;
    send.textContent = on ? 'Sending…' : retryRisk ? 'Send a new copy' : 'Send';
  }

  async function send() {
    if (!draft || sending) return;
    const addressesOk = ['to', 'cc', 'bcc'].map(commitInput).every(Boolean);
    if (!addressesOk) { status('Fix the addresses marked in red first.', 'error'); return; }
    if (uploads.some(u => u.state === 'uploading')) { status('Wait for the attachments to finish uploading.', 'error'); return; }
    if (uploads.some(u => u.state === 'failed')) { status('Remove the attachments that did not upload.', 'error'); return; }

    const box = editor();
    const request = {
      connectionId: draft.connectionId,
      mode: draft.mode,
      messageId: draft.mode === 'new' ? null : draft.messageId,
      to: [...draft.to], cc: [...draft.cc], bcc: [...draft.bcc],
      subject: String(find('[data-c="subject"]').value || '').trim(),
      html: `<div style="${BODY_STYLE}">${cleanHtml(box.innerHTML)}</div>`,
      importance: find('[data-c="importance"]').value,
      attachments: uploads.map(u => u.ref)
    };
    const problem = M.sendProblem({
      ...request, text: box.innerText, hasImage: Boolean(box.querySelector('img')),
      htmlBytes: new TextEncoder().encode(request.html).length
    });
    if (problem) { status(problem, 'error'); return; }

    /* The last attempt may have left a copy behind, and sending again makes
       another: said before, not after. */
    if (retryRisk && !window.confirm(retryRisk === 'draft'
      ? 'The last attempt left this message in Drafts in Outlook. Send a new copy anyway? Delete the one in Drafts afterwards.'
      : 'The last attempt may already have been sent. Look in Sent in Outlook first. Send it again anyway?')) return;

    sending = true;
    const sentDraft = draft;
    const sentWith = context;
    setBusy(true);
    status('Sending…');
    const ours = () => Boolean(draft) && draft.id === sentDraft.id;
    try {
      const result = await workspaceActions.sendMail(request);
      const from = sentWith.boxes.find(b => b.id === request.connectionId);
      if (ours()) finish();
      if (sentWith.onSent) sentWith.onSent(result, { mode: sentDraft.mode, threadId: sentDraft.threadId, from: from ? from.address : '' });
    } catch (err) {
      if (ours()) {
        if (err.draftSaved) retryRisk = 'draft';
        else if (err.unknownOutcome) retryRisk = 'unknown';
        const box = sentWith.boxes.find(b => b.id === request.connectionId);
        const hint = !err.reconnect ? ''
          /* Only a mailbox listed under Connections can be reconnected there. */
          : box && sentWith.canReconnect && sentWith.canReconnect(box) ? ' Reconnect it under Connections.' : ' Ask a manager to reconnect it.';
        status(`${err.message}${hint}`, 'error');
      }
    } finally {
      sending = false;
      if (ours()) setBusy(false);
    }
  }

  function finish() {
    draft = null;
    uploads = Object.freeze([]);
    lastSelection = null;
    appliedSignature = '';
    retryRisk = null;
    discardArmedUntil = 0;
    if (el) el.remove();
    el = null;
  }

  /* Resolves once the draft's uploads are removed. Uploads already on their way
     out with a send are send-mail's to remove. */
  function close() {
    const paths = sending ? [] : uploads.map(u => u.ref && u.ref.path).filter(Boolean);
    finish();
    return paths.length
      ? workspaceActions.removeMailAttachments(paths).catch(err => console.warn('[mail] uploads not removed:', err.message))
      : Promise.resolve();
  }

  function disarmDiscard() {
    discardArmedUntil = 0;
    const button = find('[data-c="discard"]');
    if (!button) return;
    button.textContent = 'Discard';
    button.classList.remove('armed');
    const node = find('[data-c="status"]');
    if (node && node.dataset.kind === 'confirm') status('');
  }

  function discard() {
    if (sending) return;
    if (hasContent() && Date.now() > discardArmedUntil) {
      discardArmedUntil = Date.now() + DISCARD_WINDOW_MS;
      const button = find('[data-c="discard"]');
      button.textContent = 'Discard this draft?';
      button.classList.add('armed');
      status('Click Discard again to throw this draft away.', 'confirm');
      setTimeout(() => { if (Date.now() >= discardArmedUntil) disarmDiscard(); }, DISCARD_WINDOW_MS);
      return;
    }
    const onClose = context && context.onClose;
    close();
    if (onClose) onClose();
  }

  /* Something that would be lost: words beyond the signature, an image, an
     attachment, or anything changed from how the draft opened — the subject,
     recipients, Bcc, From, importance, or an address still being typed. */
  function hasContent() {
    if (!draft || !el) return false;
    const copy = editor().cloneNode(true);
    copy.querySelectorAll('[data-signature]').forEach(node => node.remove());
    const subject = find('[data-c="subject"]');
    const importance = find('[data-c="importance"]');
    const sameList = (a, b) => a.map(x => x.toLowerCase()).join(',') === b.map(x => x.toLowerCase()).join(',');
    const typing = ['to', 'cc', 'bcc'].some(field => {
      const input = find(`[data-chip-input="${field}"]`);
      return Boolean(input && input.value.trim());
    });
    return copy.textContent.trim().length > 0
      || Boolean(copy.querySelector('img'))
      || uploads.length > 0
      || Boolean(subject && subject.value.trim() !== draft.initial.subject.trim())
      || !sameList(draft.to, draft.initial.to)
      || !sameList(draft.cc, draft.initial.cc)
      || draft.bcc.length > 0
      || draft.connectionId !== draft.initial.connectionId
      || Boolean(importance && importance.value !== 'normal')
      || typing;
  }

  /* ── Events, bound once per draft ──────────────────────────────────── */

  function onClick(e) {
    const button = e.target.closest('button');
    if (!button || !el.contains(button)) return undefined;
    if (button.dataset.chipRemove) {
      const field = button.dataset.chipRemove;
      const index = Number(button.dataset.index);
      setField(field, draft[field].filter((_, i) => i !== index));
      return undefined;
    }
    if (button.dataset.cmd) return format(button.dataset.cmd, button.dataset.arg);
    if (button.dataset.remove) return removeUpload(button.dataset.remove);
    switch (button.dataset.c) {
      case 'show-cc': return showRow('cc');
      case 'show-bcc': return showRow('bcc');
      case 'attach': return find('[data-c="files"]').click();
      case 'send': return send();
      case 'discard': return discard();
      case 'signatures': return openSignatures();
      default: return undefined;
    }
  }

  function onChange(e) {
    const target = e.target;
    if (target.matches('[data-cmd-select]')) {
      restoreSelection();
      document.execCommand(target.dataset.cmdSelect, false, target.value);
      return;
    }
    if (target.matches('[data-c="files"]')) {
      addFiles(target.files);
      target.value = '';
      return;
    }
    if (target.matches('[data-c="from"]')) {
      draft = Object.freeze({ ...draft, connectionId: target.value });
      applySignature();
    }
  }

  function onKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
      return;
    }
    if (moveInToolbar(e)) return;
    const input = e.target.closest && e.target.closest('[data-chip-input]');
    if (!input) return;
    const field = input.dataset.chipInput;
    if (['Enter', ',', ';'].includes(e.key) && input.value.trim()) {
      e.preventDefault();
      commitInput(field);
    } else if (e.key === 'Enter') {
      e.preventDefault();
    } else if (e.key === 'Backspace' && !input.value && draft[field].length) {
      setField(field, draft[field].slice(0, -1));
    }
  }

  function onPaste(e) {
    const data = e.clipboardData;
    const input = e.target.closest && e.target.closest('[data-chip-input]');
    if (input) {
      const text = data && data.getData('text/plain');
      if (text && /[,;\n]/.test(text)) {
        e.preventDefault();
        input.value = `${input.value} ${text}`.trim();
        commitInput(input.dataset.chipInput);
      }
      return;
    }
    if (!(e.target.closest && e.target.closest('[data-c="editor"]')) || !data) return;
    const html = data.getData('text/html');
    /* A copied file or screenshot is attached rather than pasted into the text. */
    if (data.files && data.files.length && !html) {
      e.preventDefault();
      addFiles(data.files);
      return;
    }
    if (!html) return;                     // plain text pastes as it is
    e.preventDefault();
    document.execCommand('insertHTML', false, cleanHtml(html));
  }

  /* Where a drop lands, as the caret. */
  function placeCaretAt(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
      }
    }
    if (!range) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function bind() {
    el.addEventListener('mousedown', e => {
      /* Pressing a toolbar button must not take the selection out of the text. */
      if (e.target.closest('.composer-tool, .composer-swatch')) e.preventDefault();
    });
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('paste', onPaste);
    el.addEventListener('focusout', e => {
      /* A render takes the draft off the page for a moment, and a browser may
         call that leaving the field: a half-typed address is not committed then. */
      const input = e.target.closest && e.target.closest('[data-chip-input]');
      if (input && !rendering) commitInput(input.dataset.chipInput);
    });
    el.addEventListener('input', e => {
      const input = e.target.closest && e.target.closest('[data-chip-input]');
      /* Choosing a suggestion replaces the field's text in one go. */
      if (input && e.inputType === 'insertReplacementText' && M.isAddress(input.value)) commitInput(input.dataset.chipInput);
      if (discardArmedUntil) disarmDiscard();
    });
    el.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      el.classList.add('dropping');
    });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('dropping'); });
    el.addEventListener('drop', e => {
      if (hasFiles(e)) {
        e.preventDefault();
        el.classList.remove('dropping');
        addFiles(e.dataTransfer.files);
        return;
      }
      /* Dropped HTML goes the way pasted HTML does, through the same cleaning. */
      const html = e.dataTransfer && e.dataTransfer.getData('text/html');
      if (!html || !(e.target.closest && e.target.closest('[data-c="editor"]'))) return;
      e.preventDefault();
      placeCaretAt(e.clientX, e.clientY);
      document.execCommand('insertHTML', false, cleanHtml(html));
    });
  }

  /* ── What mail.js calls ────────────────────────────────────────────── */

  /* init: { mode, connectionId, threadId, messageId, to, cc, subject, about, bodyText }
     with: { boxes, book, canReconnect, onSent(result, sent), onClose() }
     Refused while a message is being sent: that send finishes into its own draft. */
  function open(init, withContext) {
    if (sending) return false;
    close();
    context = withContext;
    const mode = MODE_LABELS[init.mode] ? init.mode : 'new';
    const text = String(init.bodyText || '').trim();
    const paragraphs = text
      ? text.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
      : '<p><br></p>';
    const to = Object.freeze([...(init.to || [])]);
    const cc = Object.freeze([...(init.cc || [])]);
    const subject = String(init.subject || '');
    const connectionId = init.connectionId || null;
    draft = Object.freeze({
      id: window.crypto.randomUUID(),
      mode,
      connectionId,
      threadId: init.threadId || null,
      messageId: init.messageId || null,
      to, cc, bcc: Object.freeze([]),
      subject,
      about: String(init.about || ''),
      bodyHtml: `${paragraphs}<p><br></p><div class="composer-signature" data-signature></div>`,
      initial: Object.freeze({ to, cc, subject, connectionId })
    });
    el = document.createElement('section');
    el.className = 'composer';
    el.setAttribute('aria-label', MODE_LABELS[mode]);
    el.innerHTML = template();
    el.querySelectorAll(TOOLBAR_CONTROLS).forEach((control, i) => { control.tabIndex = i === 0 ? 0 : -1; });
    bind();
    applySignature();
    return true;
  }

  function beforeRender() {
    rendering = true;
    const active = document.activeElement;
    focusBefore = el && el.contains(active) ? active : null;
    fieldSelection = focusBefore && typeof focusBefore.selectionStart === 'number'
      ? [focusBefore.selectionStart, focusBefore.selectionEnd] : null;
    const box = editor();
    scrollBefore = box ? box.scrollTop : 0;
  }

  function afterRender() {
    rendering = false;
    if (!el) return;
    const slot = document.querySelector('[data-composer-slot]');
    if (!slot) return;
    slot.replaceWith(el);
    const box = editor();
    if (box) box.scrollTop = scrollBefore;
    if (focusBefore && el.contains(focusBefore)) {
      if (focusBefore === box) {
        restoreSelection();
      } else {
        focusBefore.focus({ preventScroll: true });
        if (fieldSelection && typeof focusBefore.setSelectionRange === 'function') {
          try {
            focusBefore.setSelectionRange(fieldSelection[0], fieldSelection[1]);
          } catch (noCaret) {
            /* not every field has a caret to put back */
          }
        }
      }
    }
    focusBefore = null;
    fieldSelection = null;
  }

  function focus() {
    if (!el || !el.isConnected) return;
    el.scrollIntoView({ block: 'nearest' });
    if (draft.mode === 'new' && !draft.to.length) {
      find('[data-chip-input="to"]').focus();
      return;
    }
    if (draft.mode === 'new' && !draft.subject) {
      find('[data-c="subject"]').focus();
      return;
    }
    const box = editor();
    box.focus();
    const range = document.createRange();
    range.setStart(box, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return Object.freeze({
    open, close, beforeRender, afterRender, focus, hasContent, openSignatures,
    isOpen: () => Boolean(draft),
    isSending: () => sending,
    mode: () => (draft ? draft.mode : null),
    threadId: () => (draft ? draft.threadId : null)
  });
})();
