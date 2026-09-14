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

/* answer(name, options): what functions.invoke resolves to. */
function workspace(answer) {
  const invoked = [];
  const written = [];
  const record = (table, what) => (change) => {
    written.push({ table, what, change: { ...change } });
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
    from: (table) => ({ update: record(table, 'update'), insert: record(table, 'insert') })
  };
  const session = { client, employee: { id: 'emp-1' }, session: null };
  const context = vm.createContext({ console, window: { workspaceSession: session } });
  vm.runInContext(readFileSync(new URL('../dist/data/actions.js', import.meta.url), 'utf8'), context);
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
