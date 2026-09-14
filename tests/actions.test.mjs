/* The writes, without a database: which call a button makes, and what a person
   is told when it fails. Loaded into a sandbox the way <script> tags run them,
   against a stand-in Supabase client that records every call.
   Run from the repo root with: node --test

   The stand-in fails the way supabase-js does: a non-2xx answer comes back as
   { data: null, error } with the Response on error.context, and the function's
   own { error } body is only readable from there.

   Objects made inside the sandbox have the sandbox's prototypes, which strict
   deep-equality rejects — hence the {...spread} before comparing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const THREAD = 'd0000000-0000-4000-8000-0000000000f1';
const TICKET = 'e0000000-0000-4000-8000-0000000000a1';

/* A non-2xx answer. body undefined: the answer was not JSON. */
function httpError(status, body) {
  return {
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: {
        status,
        json: async () => {
          if (body === undefined) throw new SyntaxError('Unexpected token < in JSON');
          return body;
        }
      }
    }
  };
}

const unreachable = {
  data: null,
  error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context: {} }
};

const USER = 'a0000000-0000-4000-8000-000000000001';

/* answer(name, options): what functions.invoke resolves to.
   storage(bucket): the stand-in for sb().storage.from(bucket).
   purify: the stand-in for DOMPurify. */
function workspace(answer, { storage, purify } = {}) {
  const invoked = [];
  const written = [];
  const record = (table, what) => (change, options) => {
    written.push({ table, what, change: { ...change }, ...(options ? { options: { ...options } } : {}) });
    const chain = {
      eq: () => chain,
      select: () => chain,
      single: async () => ({ data: { id: 'new-row', ...change }, error: null })
    };
    return chain;
  };
  const client = {
    functions: {
      invoke: async (name, options) => {
        invoked.push({ name, body: { ...options.body } });
        return answer(name, options);
      }
    },
    from: (table) => ({ update: record(table, 'update'), insert: record(table, 'insert'), upsert: record(table, 'upsert') }),
    storage: { from: (bucket) => (storage ? storage(bucket) : {}) }
  };
  const session = { client, employee: { id: 'emp-1' }, session: { user: { id: USER } } };
  const context = vm.createContext({
    console,
    window: { workspaceSession: session, DOMPurify: purify, crypto: globalThis.crypto }
  });
  for (const file of ['mail-model.js', 'data/actions.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  return { actions: context.window.workspaceActions, invoked, written };
}

/* ── Read and starred ─────────────────────────────────────────────────── */

test('marking read goes through update-mail-state, and nothing else is written', async () => {
  const ws = workspace(async () => ({ data: { ok: true, outlook: true, reason: null }, error: null }));
  const result = await ws.actions.markThreadRead(THREAD, true);
  assert.equal(result.ok, true);
  assert.deepEqual(ws.invoked, [{ name: 'update-mail-state', body: { threadId: THREAD, read: true } }]);
  assert.equal(ws.written.length, 0, 'the function writes the thread; the browser does not');
});

test('starring sends starred, not read', async () => {
  const ws = workspace(async () => ({ data: { ok: true }, error: null }));
  await ws.actions.starThread(THREAD, false);
  assert.deepEqual(ws.invoked[0].body, { threadId: THREAD, starred: false });
});

test('the answer is handed back whole, so the view can say Outlook did not get it', async () => {
  const reason = 'Reconnect this mailbox for read and starred to reach Outlook.';
  const ws = workspace(async () => ({ data: { ok: true, outlook: false, reason }, error: null }));
  const result = await ws.actions.starThread(THREAD, true);
  assert.equal(result.outlook, false);
  assert.equal(result.reason, reason);
});

test('a refusal says why, in the function\'s words rather than supabase-js\'s', async () => {
  const ws = workspace(async () => httpError(403, { error: 'Staff only' }));
  await assert.rejects(ws.actions.starThread(THREAD, true), { message: 'Staff only' });
  assert.equal(ws.written.length, 0);
});

test('Outlook failing is a failure too, with its reason', async () => {
  const ws = workspace(async () => httpError(502, { error: 'Outlook did not take the change: Graph → 503' }));
  await assert.rejects(ws.actions.markThreadRead(THREAD), { message: /Outlook did not take the change/ });
  assert.equal(ws.written.length, 0);
});

test('a conversation the function cannot find is an error, not a quiet write to the thread', async () => {
  const ws = workspace(async () => httpError(404, { error: 'No such conversation' }));
  await assert.rejects(ws.actions.markThreadRead(THREAD, true), { message: 'No such conversation' });
  assert.equal(ws.written.length, 0,
    'writing the thread row directly would be undone by the next sync, and never reach Outlook');
});

test('a function that cannot be reached is an error too, never a direct write', async () => {
  const ws = workspace(async () => unreachable);
  await assert.rejects(ws.actions.markThreadRead(THREAD, false), { message: /Failed to send/ });
  assert.equal(ws.written.length, 0);

  const gateway = workspace(async () => httpError(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }));
  await assert.rejects(gateway.actions.starThread(THREAD, true), { message: 'Requested function was not found' });
  assert.equal(gateway.written.length, 0);
});

test('an answer that is not JSON still fails with a sentence', async () => {
  const ws = workspace(async () => httpError(500));
  await assert.rejects(ws.actions.markThreadRead(THREAD, true), (err) => {
    assert.ok(String(err.message).length > 0);
    return true;
  });
  assert.equal(ws.written.length, 0);
});

/* ── Ticket replies ───────────────────────────────────────────────────── */

test('a ticket reply that could not be sent says so in the function\'s words', async () => {
  const ws = workspace(async () => httpError(502, {
    ok: false, sent: false, error: 'The reply was saved but could not be sent: mailbox refused'
  }));
  await assert.rejects(ws.actions.replyToTicket(TICKET, 'Thanks, fixed.', 'reply'),
    { message: 'The reply was saved but could not be sent: mailbox refused' });
  assert.equal(ws.written.length, 0, 'the function saved it; the browser must not save it twice');
});

/* ── Reconnecting a mailbox ───────────────────────────────────────────── */

const CONSENT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&state=y';

test('reconnecting asks microsoft-connect for that mailbox, and hands back Microsoft\'s page', async () => {
  const ws = workspace(async () => ({ data: { connectionId: 'c1', consentUrl: CONSENT }, error: null }));
  const url = await ws.actions.reconnectMailbox('hello@veyago.cloud');
  assert.equal(url, CONSENT);
  assert.deepEqual(ws.invoked, [{
    name: 'microsoft-connect',
    body: { provider: 'microsoft_mail', accountLabel: 'hello@veyago.cloud' }
  }], 'no employeeId: a reconnect keeps whose mailbox it is');
});

test('a sign-in page that is not Microsoft\'s is never opened', async () => {
  for (const consentUrl of ['https://login.microsoftonline.com.evil.example/authorize', 'http://login.microsoftonline.com/x',
                            'javascript:alert(1)', '', undefined]) {
    const ws = workspace(async () => ({ data: { consentUrl }, error: null }));
    await assert.rejects(ws.actions.reconnectMailbox('hello@veyago.cloud'), /Microsoft/, String(consentUrl));
  }
});

test('reconnecting says why it was refused, in the function\'s words', async () => {
  const ws = workspace(async () => httpError(403, { error: 'Managers only' }));
  await assert.rejects(ws.actions.reconnectMailbox('hello@veyago.cloud'), { message: 'Managers only' });
});

test('reconnecting needs a mailbox to reconnect', async () => {
  const ws = workspace(async () => ({ data: { consentUrl: CONSENT }, error: null }));
  await assert.rejects(ws.actions.reconnectMailbox(''), /mailbox/i);
  assert.equal(ws.invoked.length, 0);
});

/* ── Sending ──────────────────────────────────────────────────────────── */

const SEND = {
  connectionId: 'c0000000-0000-4000-8000-00000000000b', mode: 'new', messageId: null,
  to: ['ana@northline.example'], cc: [], bcc: [], subject: 'Kick-off', html: '<p>Hi</p>',
  importance: 'high', attachments: []
};

test('sending hands send-mail the request, and its answer back', async () => {
  const ws = workspace(async () => ({ data: { ok: true, sent: true, threadId: 't1', stored: true }, error: null }));
  const result = await ws.actions.sendMail(SEND);
  assert.equal(result.threadId, 't1');
  assert.deepEqual(ws.invoked, [{ name: 'send-mail', body: SEND }]);
});

test('a mailbox that needs reconnecting says so, in a way the view can act on', async () => {
  const ws = workspace(async () => httpError(409, {
    error: 'This mailbox needs reconnecting before it can send from the workspace.', reconnect: true
  }));
  await assert.rejects(ws.actions.sendMail(SEND), (err) => {
    assert.match(err.message, /needs reconnecting/);
    assert.equal(err.reconnect, true);
    assert.equal(err.draftSaved, false);
    return true;
  });
});

test('a send whose answer never arrived may have gone out, and says so', async () => {
  const ws = workspace(async () => unreachable);
  await assert.rejects(ws.actions.sendMail(SEND), (err) => {
    assert.equal(err.unknownOutcome, true);
    assert.match(err.message, /may have been sent/i);
    assert.match(err.message, /Sent/, 'it says where to look before trying again');
    return true;
  });

  const timedOut = workspace(async () => httpError(504));
  await assert.rejects(timedOut.actions.sendMail(SEND), (err) => {
    assert.equal(err.unknownOutcome, true, 'a gateway timeout without our answer is not a refusal');
    return true;
  });
});

test('a refusal from send-mail itself is a refusal, not an unknown', async () => {
  const ws = workspace(async () => httpError(400, { error: 'Add a subject' }));
  await assert.rejects(ws.actions.sendMail(SEND), (err) => {
    assert.equal(err.unknownOutcome, false);
    assert.equal(err.message, 'Add a subject');
    return true;
  });
});

test('a send that failed after its draft existed says where the draft is', async () => {
  const ws = workspace(async () => httpError(502, {
    error: 'The message was not sent: Graph → 503 It is saved in Drafts in Outlook.', draftSaved: true
  }));
  await assert.rejects(ws.actions.sendMail(SEND), (err) => {
    assert.match(err.message, /Drafts/);
    assert.equal(err.draftSaved, true);
    assert.equal(err.reconnect, false);
    return true;
  });
});

/* ── Attachments ──────────────────────────────────────────────────────── */

function storageStub(error = null) {
  const calls = [];
  return {
    calls,
    storage: (bucket) => ({
      upload: async (path, file, options) => {
        calls.push({ bucket, what: 'upload', path, options: { ...options } });
        return { data: error ? null : { path }, error };
      },
      remove: async (paths) => {
        calls.push({ bucket, what: 'remove', paths: [...paths] });
        return { data: [], error };
      }
    })
  };
}

test('an attachment is stored under your own id, a fresh folder and a plain name', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage });
  const ref = await ws.actions.uploadMailAttachment({ name: 'Quarterly Report (Final).pdf', size: 1234, type: 'application/pdf' });

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].bucket, 'mail-attachments');
  assert.match(stub.calls[0].path, new RegExp(`^${USER}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/Quarterly-Report-Final\\.pdf$`));
  assert.equal(stub.calls[0].options.upsert, false, 'an upload never replaces another');
  assert.deepEqual({ ...ref }, {
    path: stub.calls[0].path, name: 'Quarterly Report (Final).pdf', size: 1234, contentType: 'application/pdf'
  }, 'the name a recipient sees stays as it was');
});

test('two uploads of the same file never share a path', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage });
  const one = await ws.actions.uploadMailAttachment({ name: 'a.pdf', size: 1, type: '' });
  const two = await ws.actions.uploadMailAttachment({ name: 'a.pdf', size: 1, type: '' });
  assert.notEqual(one.path, two.path);
  assert.equal(one.contentType, 'application/octet-stream');
});

test('an empty file is refused before anything is uploaded', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage });
  await assert.rejects(ws.actions.uploadMailAttachment({ name: 'empty.txt', size: 0, type: 'text/plain' }), /empty/);
  assert.equal(stub.calls.length, 0);
});

test('a refused upload says which file it was', async () => {
  const stub = storageStub({ message: 'new row violates row-level security policy' });
  const ws = workspace(async () => ({}), { storage: stub.storage });
  await assert.rejects(ws.actions.uploadMailAttachment({ name: 'a.pdf', size: 5, type: 'application/pdf' }), /a\.pdf/);
});

test('removing attachments removes exactly those, and nothing when there are none', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage });
  await ws.actions.removeMailAttachments([`${USER}/x/a.pdf`, '', null]);
  await ws.actions.removeMailAttachments([]);
  assert.deepEqual(stub.calls, [{ bucket: 'mail-attachments', what: 'remove', paths: [`${USER}/x/a.pdf`] }]);
});

/* ── Signatures ───────────────────────────────────────────────────────── */

test('a signature is saved once per mailbox, cleaned first', async () => {
  const purify = { sanitize: (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, '') };
  const ws = workspace(async () => ({}), { purify });
  await ws.actions.saveSignature({ connectionId: null, html: '<p>Cassian</p><script>alert(1)</script>', useOnNew: true, useOnReplies: false });
  assert.deepEqual(ws.written, [{
    table: 'mail_signatures', what: 'upsert',
    change: { employee_id: 'emp-1', connection_id: null, html: '<p>Cassian</p>', use_on_new: true, use_on_replies: false },
    options: { onConflict: 'employee_id,connection_id' }
  }]);
});

test('a signature is cleaned with the same setting as the editor', async () => {
  const seen = [];
  const purify = { sanitize: (html, config) => { seen.push(config); return String(html); } };
  const ws = workspace(async () => ({}), { purify });
  await ws.actions.saveSignature({ connectionId: null, html: '<p>Cassian</p>' });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].FORBID_ATTR.includes('class'));
  assert.ok(seen[0].FORBID_ATTR.includes('popover'));
  assert.equal(seen[0].ALLOW_DATA_ATTR, false);
});

test('a signature is not saved uncleaned', async () => {
  const ws = workspace(async () => ({}), { purify: undefined });
  await assert.rejects(ws.actions.saveSignature({ connectionId: null, html: '<p>x</p>' }), /editor/i);
  assert.equal(ws.written.length, 0);
});
