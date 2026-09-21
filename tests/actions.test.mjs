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
   purify: the stand-in for DOMPurify.
   rpc(name, args): what sb().rpc(name, args) resolves to — { data, error } —
   for an RPC an action calls directly rather than through a table write. */
/* rows(table, what): the rows a write awaited without single() touched — [] is
   what a delete or update RLS quietly refused looks like.
   fail(table, what): the error a write comes back with, or null. */
function workspace(answer, { storage, purify, manager = true, rows, fail, rpc } = {}) {
  const invoked = [];
  const written = [];
  const called = [];
  const record = (table, what) => (change, options) => {
    /* upsert() can be given a row or a list of rows (updateStudioProfile
       sends several settings at once) — a list is copied as a real, host-realm
       array of host-realm objects: [...] first, so the array itself is not
       still the sandbox's, the way strict deepEqual would tell apart. */
    const copy = Array.isArray(change) ? [...change].map(row => ({ ...row })) : { ...change };
    const index = written.push({ table, what, change: copy, ...(options ? { options: { ...options } } : {}) }) - 1;
    const error = fail ? fail(table, what) : null;
    let selected = false;
    const chain = {
      /* Which rows a write is aimed at: without this, a write to the wrong row passes. */
      eq: (column, value) => {
        written[index] = { ...written[index], where: [...(written[index].where || []), [column, value]] };
        return chain;
      },
      /* Named too: eq(column, null) matches no row in PostgREST, is(column, null) the empty ones. */
      is: (column, value) => {
        written[index] = { ...written[index], where: [...(written[index].where || []), [column, { is: value }]] };
        return chain;
      },
      /* Named, so a list given to eq() cannot pass for one given to in(). */
      in: (column, values) => {
        written[index] = { ...written[index], where: [...(written[index].where || []), [column, { in: [...values] }]] };
        return chain;
      },
      /* not('col', 'is', null) — "column is not null" — the negation of is(). */
      not: (column, op, value) => {
        written[index] = { ...written[index], where: [...(written[index].where || []), [column, { not: [op, value] }]] };
        return chain;
      },
      /* supabase-js hands rows back only to a write that asked for them. */
      select: () => { selected = true; return chain; },
      single: async () => (error ? { data: null, error } : { data: { id: 'new-row', ...change }, error: null }),
      then: (resolve, reject) => Promise.resolve(error
        ? { data: null, error }
        : { data: !selected ? null : rows ? rows(table, what) : [{ id: 'new-row', ...change }], error: null }).then(resolve, reject)
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
    from: (table) => ({
      update: record(table, 'update'), insert: record(table, 'insert'), upsert: record(table, 'upsert'),
      delete: () => record(table, 'delete')({})
    }),
    storage: { from: (bucket) => (storage ? storage(bucket) : {}) },
    rpc: async (name, args) => {
      called.push({ name, args: { ...args } });
      return rpc ? rpc(name, args) : { data: null, error: null };
    }
  };
  const session = {
    client, employee: { id: 'emp-1' }, session: { user: { id: USER } },
    isManager: () => manager
  };
  const context = vm.createContext({
    console,
    window: { workspaceSession: session, DOMPurify: purify, crypto: globalThis.crypto }
  });
  for (const file of ['mail-model.js', 'projects-model.js', 'tickets-model.js', 'data/actions.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  return { actions: context.window.workspaceActions, invoked, written, called };
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

/* ── Moving a conversation (0069) ─────────────────────────────────────── */

test('archiving goes through move-mail-thread, and nothing is written here', async () => {
  const ws = workspace(async () => ({ data: { ok: true, moved: 2, thread: { id: THREAD, folder: 'archive' } }, error: null }));
  const result = await ws.actions.moveMailThread(THREAD, 'archive');
  assert.equal(result.moved, 2);
  assert.deepEqual(ws.invoked, [{ name: 'move-mail-thread', body: { threadId: THREAD, to: 'archive' } }]);
  assert.equal(ws.written.length, 0,
    'the browser has no write on mail_threads.folder (0038), and a move it recorded alone would be undone by the next delta');
});

test('junk and delete are the other two, spelled the way the database spells them', async () => {
  for (const to of ['spam', 'trash']) {
    const ws = workspace(async () => ({ data: { ok: true, moved: 1 }, error: null }));
    await ws.actions.moveMailThread(THREAD, to);
    assert.equal(ws.invoked[0].body.to, to);
  }
});

/* The owner named three folders. Anything else is refused before a request is
   made — the Edge Function and graph-guard.ts refuse it again regardless. */
test('nowhere else is a place to send a conversation', async () => {
  for (const to of ['inbox', 'sent', 'deleteditems', 'starred', '', null]) {
    const ws = workspace(async () => ({ data: {}, error: null }));
    await assert.rejects(ws.actions.moveMailThread(THREAD, to), { message: /archived, marked as junk or deleted/ });
    assert.equal(ws.invoked.length, 0, String(to));
  }
});

test('a mailbox that cannot be reached is a refusal in the function\'s own words', async () => {
  const ws = workspace(async () => httpError(409, { error: 'This mailbox is disconnected, so nothing can be moved in Outlook.' }));
  await assert.rejects(ws.actions.moveMailThread(THREAD, 'trash'),
    { message: 'This mailbox is disconnected, so nothing can be moved in Outlook.' });
  assert.equal(ws.written.length, 0);
});

/* ── Mail and the CRM (0055, finally called) ──────────────────────────── */

test('linking a conversation calls link_mail_thread; the company follows in the database, not here', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), {
    rpc: () => ({ data: { id: THREAD, contact_id: 'c1', company_id: 'co1' }, error: null })
  });
  const row = await ws.actions.linkMailThread(THREAD, 'c1');
  assert.deepEqual([...ws.called].map(c => ({ ...c })), [{ name: 'link_mail_thread', args: { p_thread: THREAD, p_contact: 'c1' } }]);
  assert.equal(row.company_id, 'co1');
  assert.equal(ws.written.length, 0, 'never a direct write to mail_threads.contact_id');
});

test('no contact means null, which is how the database clears one', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), { rpc: () => ({ data: null, error: null }) });
  await ws.actions.linkMailThread(THREAD, '');
  assert.equal(ws.called[0].args.p_contact, null);
});

test('a refusal from link_mail_thread is said in a sentence, not as a raw database error', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), {
    rpc: () => ({ data: null, error: { message: 'That contact is not in the CRM.' } })
  });
  await assert.rejects(ws.actions.linkMailThread(THREAD, 'gone'), { message: /Could not link this conversation: That contact is not in the CRM./ });
});

test('the back-fill is a manager\'s, and is refused here before it is refused again in the database', async () => {
  const notManager = workspace(async () => ({ data: null, error: null }), { manager: false, rpc: () => ({ data: 3, error: null }) });
  await assert.rejects(notManager.actions.rematchMailThreads(), { message: /Only an owner or admin/ });
  assert.equal(notManager.called.length, 0, 'it reaches into every mailbox at once — including ones the caller cannot read');
});

test('a manager\'s back-fill answers how many conversations it matched', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), { rpc: () => ({ data: 7, error: null }) });
  assert.equal(await ws.actions.rematchMailThreads(), 7);
  assert.deepEqual({ ...ws.called[0].args }, { p_limit: 500 });
});

/* ── Mail attachments ─────────────────────────────────────────────────── */

test('an attachment\'s bytes come back from mail-attachment-content, as the blob supabase-js hands over', async () => {
  const blob = new Blob(['%PDF-fake'], { type: 'application/octet-stream' });
  const ws = workspace(async () => ({ data: blob, error: null }));
  const result = await ws.actions.mailAttachmentContent('att-1');
  assert.deepEqual(ws.invoked, [{ name: 'mail-attachment-content', body: { attachmentId: 'att-1' } }]);
  assert.equal(result, blob, 'the blob itself, not a copy — mail.js is the one that re-types and wraps it');
});

test('an attachment that no longer exists, or is not this person\'s to read, is an error naming why', async () => {
  const ws = workspace(async () => httpError(404, { error: 'No such attachment, or it is not yours to read' }));
  await assert.rejects(ws.actions.mailAttachmentContent('att-1'), { message: 'No such attachment, or it is not yours to read' });
});

test('a mailbox needing reconnecting to open its attachments says so', async () => {
  const ws = workspace(async () => httpError(409, { error: 'Reconnect this mailbox to open its attachments.' }));
  await assert.rejects(ws.actions.mailAttachmentContent('att-1'), { message: 'Reconnect this mailbox to open its attachments.' });
});

test('a response that is not a blob at all (a gateway page, say) is refused rather than handed to an <img>', async () => {
  const ws = workspace(async () => ({ data: 'not a blob', error: null }));
  await assert.rejects(ws.actions.mailAttachmentContent('att-1'), { message: 'Could not open that attachment.' });
});

test('no id is nothing to ask for', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(ws.actions.mailAttachmentContent(''), { message: /not loaded any more/ });
  assert.equal(ws.invoked.length, 0);
});

/* ── Events ───────────────────────────────────────────────────────────── */

test('removing an event asks which rows went, and none is a refusal, said as one', async () => {
  const removed = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'ev-1' }] });
  await removed.actions.deleteEvent('ev-1');
  assert.deepEqual(removed.written.map(w => [w.table, w.what, w.where]), [['calendar_events', 'delete', [['id', 'ev-1']]]]);
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.deleteEvent('ev-1'), { message: /^The event was not removed: it has been removed already, or only whoever booked it, or an owner or admin, can remove it/ });
});

test('changing an event sends only its title, times, place and details, to an event made here as it was when opened; nothing changed is a refusal, said as one', async () => {
  const STAMP = '2026-09-15T08:00:00.123456+00:00';
  const saved = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'ev-1', title: 'Dentist, moved' }] });
  const row = await saved.actions.updateEvent('ev-1', { title: 'Dentist, moved', starts_at: '2026-09-21T12:30:00.000Z', ends_at: null }, STAMP);
  assert.equal(row.title, 'Dentist, moved');
  assert.deepEqual(saved.written.map(w => [w.table, w.what, w.change, w.where]),
    [['calendar_events', 'update', { title: 'Dentist, moved', starts_at: '2026-09-21T12:30:00.000Z', ends_at: null }, [['id', 'ev-1'], ['connection_id', { is: null }], ['updated_at', STAMP]]]],
    'an event someone changed since the dialog opened has another updated_at, so it is not touched');
  const unstamped = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'ev-1' }] });
  await unstamped.actions.updateEvent('ev-1', { title: 'Dentist' });
  assert.deepEqual(unstamped.written[0].where, [['id', 'ev-1'], ['connection_id', { is: null }]], 'with no stamp to go by, the event as it is');
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.updateEvent('ev-1', { title: 'Dentist' }, STAMP),
    { message: 'The event was not changed: it was changed or removed since this was opened, or only whoever booked it, or an owner or admin, can change it. Close this and open the event again.' });
  const sneaky = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'ev-1' }] });
  await assert.rejects(sneaky.actions.updateEvent('ev-1', { connection_id: null, title: 'Dentist' }), { message: 'Only an event’s title, times, place and details can be changed here.' });
  await assert.rejects(sneaky.actions.updateEvent('ev-1', {}), { message: 'Nothing was changed.' });
  await assert.rejects(sneaky.actions.updateEvent('ev-1', { title: '  ' }), { message: 'An event needs a title.' });
  await assert.rejects(sneaky.actions.updateEvent('ev-1', { starts_at: 'soon' }), { message: 'An event needs a start time.' });
  await assert.rejects(sneaky.actions.updateEvent('ev-1', { starts_at: '2026-09-21T12:30:00.000Z', ends_at: '2026-09-21T12:00:00.000Z' }),
    { message: 'An event cannot end before it starts.' });
  assert.equal(sneaky.written.length, 0, 'nothing is sent for a change that cannot be saved');
});

test('a synced event\'s change goes through update-calendar-event, not straight to the table (0057)', async () => {
  const STAMP = '2026-09-15T08:00:00.123456+00:00';
  const ws = workspace(async () => ({ data: { ok: true, id: 'ev-1' }, error: null }));
  const result = await ws.actions.updateEvent('ev-1', { title: 'Kickoff, moved' }, STAMP, 'conn-1');
  assert.deepEqual(result, { ok: true, id: 'ev-1' });
  assert.deepEqual(ws.invoked, [{
    name: 'update-calendar-event',
    body: { eventId: 'ev-1', changes: { title: 'Kickoff, moved' }, since: STAMP }
  }]);
  assert.equal(ws.written.length, 0, 'the table is changed by the function, with the service role, not from here');
});

test('a synced event still checks its own field allowlist before asking Outlook to change anything', async () => {
  const ws = workspace(async () => ({ data: { ok: true }, error: null }));
  await assert.rejects(ws.actions.updateEvent('ev-1', { kind: 'client' }, null, 'conn-1'),
    { message: 'Only an event’s title, times, place and details can be changed here.' });
  assert.equal(ws.invoked.length, 0, 'refused here, so Outlook is never asked');
});

test('a synced event\'s refusal is said in update-calendar-event\'s own words', async () => {
  const ws = workspace(async () => httpError(409, { error: 'This is part of a recurring series, which cannot be changed from the workspace yet.' }));
  await assert.rejects(ws.actions.updateEvent('ev-1', { title: 'Kickoff' }, null, 'conn-1'),
    { message: 'This is part of a recurring series, which cannot be changed from the workspace yet.' });
});

test('a synced event is removed through delete-calendar-event, not a table delete', async () => {
  const ws = workspace(async () => ({ data: { ok: true }, error: null }));
  await ws.actions.deleteEvent('ev-1', 'conn-1');
  assert.deepEqual(ws.invoked, [{ name: 'delete-calendar-event', body: { eventId: 'ev-1' } }]);
  assert.equal(ws.written.length, 0);
});

test('a synced event\'s removal refusal is said in the function\'s own words', async () => {
  const ws = workspace(async () => httpError(409, { error: 'This event is marked private, so it cannot be changed from the studio calendar.' }));
  await assert.rejects(ws.actions.deleteEvent('ev-1', 'conn-1'),
    { message: 'This event is marked private, so it cannot be changed from the studio calendar.' });
});

test('with no connection id, both still go straight to the table exactly as before', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'ev-1' }] });
  await ws.actions.updateEvent('ev-1', { title: 'Dentist' }, null, null);
  await ws.actions.deleteEvent('ev-1', undefined);
  assert.deepEqual(ws.written.map(w => [w.table, w.what]), [['calendar_events', 'update'], ['calendar_events', 'delete']]);
  assert.equal(ws.invoked.length, 0);
});

/* ── Connecting and syncing a calendar (0057) ────────────────────────────── */

test('connecting a calendar asks microsoft-connect for that provider, and hands back Microsoft\'s page', async () => {
  const ws = workspace(async () => ({ data: { connectionId: 'c1', consentUrl: CONSENT }, error: null }));
  const url = await ws.actions.connectCalendar('hello@veyago.cloud');
  assert.equal(url, CONSENT);
  assert.deepEqual(ws.invoked, [{
    name: 'microsoft-connect',
    body: { provider: 'microsoft_calendar', accountLabel: 'hello@veyago.cloud' }
  }], 'no employeeId: a reconnect keeps whose calendar it is');
});

test('connecting a brand new studio calendar says whose it is, explicitly', async () => {
  const ws = workspace(async () => ({ data: { connectionId: 'c1', consentUrl: CONSENT }, error: null }));
  await ws.actions.connectCalendar('hello@veyago.cloud', null);
  assert.deepEqual(ws.invoked[0].body, { provider: 'microsoft_calendar', accountLabel: 'hello@veyago.cloud', employeeId: null });
});

test('connecting a calendar refuses a page that is not Microsoft\'s, and needs an address', async () => {
  const bad = workspace(async () => ({ data: { consentUrl: 'javascript:alert(1)' }, error: null }));
  await assert.rejects(bad.actions.connectCalendar('hello@veyago.cloud'), /Microsoft/);
  const empty = workspace(async () => ({ data: { consentUrl: CONSENT }, error: null }));
  await assert.rejects(empty.actions.connectCalendar(''), /calendar/i);
  assert.equal(empty.invoked.length, 0);
});

test('syncing a calendar asks sync-outlook-calendar for that connection', async () => {
  const ws = workspace(async () => ({ data: { ok: true, events: 4, skipped: 0 }, error: null }));
  const result = await ws.actions.syncCalendar('conn-1');
  assert.deepEqual(result, { ok: true, events: 4, skipped: 0 });
  assert.deepEqual(ws.invoked, [{ name: 'sync-outlook-calendar', body: { connectionId: 'conn-1' } }]);
});

test('syncing needs a calendar to sync, and says why a sync was refused', async () => {
  const empty = workspace(async () => ({ data: {}, error: null }));
  await assert.rejects(empty.actions.syncCalendar(''), /calendar/i);
  assert.equal(empty.invoked.length, 0);
  const refused = workspace(async () => httpError(409, { error: 'That calendar is not connected. Reconnect it first.' }));
  await assert.rejects(refused.actions.syncCalendar('conn-1'), { message: 'That calendar is not connected. Reconnect it first.' });
});

/* ── Tasks ────────────────────────────────────────────────────────────── */

test('a note is changed by whoever wrote it and removed by them or an owner or admin, and a refusal is said as one', async () => {
  const saved = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'n1' }] });
  await saved.actions.updateNote('n1', '  Client wants green  ');
  await saved.actions.deleteNote('n1');
  assert.deepEqual(saved.written.map(w => [w.table, w.what, w.change, w.where]), [
    ['workspace_notes', 'update', { body: 'Client wants green' }, [['id', 'n1']]],
    ['workspace_notes', 'delete', {}, [['id', 'n1']]]
  ], 'only the words, to that note; and the removal asks which rows went');
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.updateNote('n1', 'Client wants green'),
    err => /^The note was not changed: only whoever wrote it can change it, or it has been removed\.$/.test(err.message) && err.refused === true);
  await assert.rejects(refused.actions.deleteNote('n1'),
    err => /^The note was not removed: only whoever wrote it, or an owner or admin, can remove it — or it has been removed already\.$/.test(err.message) && err.refused === true);
  const empty = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(empty.actions.updateNote('n1', '   '), { message: 'Write something first.' });
  assert.equal(empty.written.length, 0);
});

test('a new task is for whoever it was given to, for nobody when that is none, and for whoever adds it when no one was given', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await ws.actions.createTask({ title: ' Draft copy ', details: 'Two options', assigneeId: 'emp-2', dueDate: '2026-09-25', priority: 'high', projectId: 'p-1' });
  await ws.actions.createTask({ title: 'Book the photographer', details: null, assigneeId: null, dueDate: null, priority: 'normal', projectId: 'p-1' });
  await ws.actions.createTask({ title: 'Order prints', projectId: 'p-1' });
  assert.deepEqual(ws.written.map(w => [w.table, w.what, w.change]), [
    ['tasks', 'insert', { title: 'Draft copy', details: 'Two options', project_id: 'p-1', assignee_id: 'emp-2', priority: 'high', due_date: '2026-09-25', created_by: USER }],
    ['tasks', 'insert', { title: 'Book the photographer', details: null, project_id: 'p-1', assignee_id: null, priority: 'normal', due_date: null, created_by: USER }],
    ['tasks', 'insert', { title: 'Order prints', details: null, project_id: 'p-1', assignee_id: 'emp-1', priority: 'normal', due_date: null, created_by: USER }]
  ]);
  await assert.rejects(ws.actions.createTask({ title: '  ', projectId: 'p-1' }), { message: 'A task needs a title.' });
  assert.equal(ws.written.length, 3);
});

test('saving a task writes only the columns that changed, to that task, and a refusal is said as one', async () => {
  const saved = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'task-1', due_date: '2026-09-30' }] });
  const row = await saved.actions.updateTask('task-1', { due_date: '2026-09-30' });
  assert.equal(row.id, 'task-1');
  assert.deepEqual(saved.written.map(w => [w.table, w.what, w.change, w.where]),
    [['tasks', 'update', { due_date: '2026-09-30' }, [['id', 'task-1']]]]);
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.updateTask('task-1', { status: 'done' }), { message: /The task was not saved\./ });
  const nothing = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(nothing.actions.updateTask('task-1', {}), { message: 'Nothing to save.' });
  assert.equal(nothing.written.length, 0);
});

test('removing a company or a contact from the CRM is a manager-only soft delete, and one already removed is a refusal', async () => {
  const removed = workspace(async () => ({ data: null, error: null }), { rows: table => [{ id: table === 'crm_companies' ? 'co-1' : 'c-1' }] });
  await removed.actions.deleteCompany('co-1');
  await removed.actions.deleteContact('c-1');
  assert.deepEqual(removed.written.map(w => [w.table, w.what]), [['crm_companies', 'update'], ['crm_contacts', 'update']]);
  assert.ok('deleted_at' in removed.written[0].change);
  assert.ok('deleted_at' in removed.written[1].change);
  assert.deepEqual(removed.written[0].where, [['id', 'co-1'], ['deleted_at', { is: null }]]);
  assert.deepEqual(removed.written[1].where, [['id', 'c-1'], ['deleted_at', { is: null }]]);

  const staff = workspace(async () => ({ data: null, error: null }), { manager: false });
  await assert.rejects(staff.actions.deleteCompany('co-1'), { message: 'Only an owner or admin can remove a company from the CRM.' });
  await assert.rejects(staff.actions.deleteContact('c-1'), { message: 'Only an owner or admin can remove a contact from the CRM.' });
  assert.equal(staff.written.length, 0, 'refused before it reaches the database');

  const already = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(already.actions.deleteCompany('co-1'),
    { message: 'The company was not removed: it has been removed already, or only an owner or admin can remove one.' });
  await assert.rejects(already.actions.deleteContact('c-1'),
    { message: 'The contact was not removed: it has been removed already, or only an owner or admin can remove one.' });
});

test('saving a company or a contact writes only the columns given, to that row while it is in the CRM, and a refusal is said as one', async () => {
  const saved = workspace(async () => ({ data: null, error: null }), { rows: table => [{ id: table === 'crm_companies' ? 'co-1' : 'c-1' }] });
  assert.equal((await saved.actions.updateCompany('co-1', { stage: 'client' })).id, 'co-1');
  assert.equal((await saved.actions.updateContact('c-1', { title: 'Producer' })).id, 'c-1');
  assert.deepEqual(saved.written.map(w => [w.table, w.what, w.change, w.where]), [
    ['crm_companies', 'update', { stage: 'client' }, [['id', 'co-1'], ['deleted_at', { is: null }]]],
    ['crm_contacts', 'update', { title: 'Producer' }, [['id', 'c-1'], ['deleted_at', { is: null }]]]
  ], 'a record a manager removed is not changed back into view');
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.updateCompany('co-1', { stage: 'client' }), { message: /^The company was not saved/ });
  await assert.rejects(refused.actions.updateContact('c-1', { title: 'Producer' }), { message: /^The contact was not saved/ });
  const nothing = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(nothing.actions.updateCompany('co-1', {}), { message: 'Nothing to save.' });
  await assert.rejects(nothing.actions.updateContact('c-1', {}), { message: 'Nothing to save.' });
  assert.equal(nothing.written.length, 0);
});

test('a new company is added in the currency and with the owner it was given, or else the defaults', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await ws.actions.createCompany({ name: 'Harbor', currency: 'EUR' });
  await ws.actions.createCompany({ name: 'Lighthouse' });
  await ws.actions.createCompany({ name: 'Northline', ownerId: null });
  assert.equal(ws.written[0].change.currency, 'EUR');
  assert.equal('currency' in ws.written[1].change, false, 'the column\'s own default');
  assert.equal(ws.written[1].change.owner_id, 'emp-1', 'nothing said: whoever adds it');
  assert.equal(ws.written[2].change.owner_id, null, '"No owner" is no owner');
});

test('a company at a domain another already has says so plainly, not the database\'s own words', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), {
    fail: table => (table === 'crm_companies'
      ? { message: 'duplicate key value violates unique constraint "crm_companies_domain_idx"' } : null)
  });
  await assert.rejects(ws.actions.createCompany({ name: 'Northline Two', domain: 'northline.example' }),
    { message: 'A company at that domain is already in the CRM.' });
  const otherFailure = workspace(async () => ({ data: null, error: null }),
    { fail: () => ({ message: 'permission denied for table crm_companies' }) });
  await assert.rejects(otherFailure.actions.createCompany({ name: 'Northline' }),
    { message: 'Could not add the company: permission denied for table crm_companies' },
    'a failure that is not the domain index keeps the database\'s own words');
});

test('a new contact is added with only a name required, its address lower case, and blanks kept as null', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await ws.actions.createContact({ fullName: '  Ana Lima  ', companyId: 'co-1', email: ' Ana@Northline.EXAMPLE ', phone: '+31 20 000 0001', title: 'Producer', notes: 'Met at the fair' });
  await ws.actions.createContact({ fullName: 'Ben Ortiz' });
  assert.deepEqual(ws.written.map(w => [w.table, w.what, w.change]), [
    ['crm_contacts', 'insert', {
      full_name: 'Ana Lima', company_id: 'co-1', email: 'ana@northline.example',
      phone: '+31 20 000 0001', title: 'Producer', notes: 'Met at the fair'
    }],
    ['crm_contacts', 'insert', { full_name: 'Ben Ortiz', company_id: null, email: null, phone: null, title: null, notes: null }]
  ]);
  await assert.rejects(ws.actions.createContact({ fullName: '  ' }), { message: 'A contact needs a name.' });
  assert.equal(ws.written.length, 2, 'nothing sent for a name that is blank once trimmed');
});

test('a contact at an address another already has says so plainly, not the database\'s own words', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), {
    fail: table => (table === 'crm_contacts'
      ? { message: 'duplicate key value violates unique constraint "crm_contacts_email_idx"' } : null)
  });
  await assert.rejects(ws.actions.createContact({ fullName: 'Ana Lima', email: 'ana@northline.example' }),
    { message: 'That email address is already used by another contact.' });
});

test('promoting an enquiry calls the database\'s own function, and a refusal says why', async () => {
  const ws = workspace(async () => ({}), { rpc: () => ({ data: 'contact-1', error: null }) });
  const contactId = await ws.actions.promoteEnquiry('enq-1');
  assert.equal(contactId, 'contact-1');
  assert.deepEqual(ws.called, [{ name: 'promote_enquiry_to_crm', args: { p_enquiry_id: 'enq-1' } }]);
  const refused = workspace(async () => ({}), { rpc: () => ({ data: null, error: { message: 'Only staff can promote an enquiry' } }) });
  await assert.rejects(refused.actions.promoteEnquiry('enq-1'), { message: 'Could not promote the enquiry: Only staff can promote an enquiry' });
});

/* ── A contact with their company, in one step (create_contact_with_company, 0053) ── */

test('a contact and a new company are added together, by name, and the pair comes back by id', async () => {
  const ws = workspace(async () => ({}), { rpc: () => ({ data: { contact_id: 'c-1', company_id: 'co-1' }, error: null }) });
  const made = await ws.actions.createContactWithCompany({ fullName: 'Ana Lima', email: 'ana@northline.example', companyName: 'Northline' });
  assert.deepEqual({ ...made }, { contactId: 'c-1', companyId: 'co-1' });
  assert.deepEqual(ws.called, [{
    name: 'create_contact_with_company',
    args: {
      p_full_name: 'Ana Lima', p_email: 'ana@northline.example', p_phone: null, p_title: null,
      p_is_primary: false, p_notes: null, p_enquiry_id: null, p_company_id: null, p_company_name: 'Northline'
    }
  }]);
});

test('a contact is added at a company already in the CRM, by id, with no name sent alongside it', async () => {
  const ws = workspace(async () => ({}), { rpc: () => ({ data: { contact_id: 'c-2', company_id: 'co-9' }, error: null }) });
  await ws.actions.createContactWithCompany({ fullName: 'Ben Ortiz', companyId: 'co-9' });
  assert.equal(ws.called[0].args.p_company_id, 'co-9');
  assert.equal(ws.called[0].args.p_company_name, null);
});

test('a reply that answers with a bare object or a one-row array is read the same way', async () => {
  const asObject = workspace(async () => ({}), { rpc: () => ({ data: { contact_id: 'c-3', company_id: null }, error: null }) });
  assert.deepEqual({ ...await asObject.actions.createContactWithCompany({ fullName: 'Cy' }) }, { contactId: 'c-3', companyId: null });
  const asArray = workspace(async () => ({}), { rpc: () => ({ data: [{ contact_id: 'c-4', company_id: 'co-1' }], error: null }) });
  assert.deepEqual({ ...await asArray.actions.createContactWithCompany({ fullName: 'Dee' }) }, { contactId: 'c-4', companyId: 'co-1' });
});

test('a contact refused for an address already in the CRM names which one, from the database\'s own detail', async () => {
  const ws = workspace(async () => ({}), {
    rpc: () => ({
      data: null,
      error: { message: 'A contact with that email address is already in the CRM.', details: JSON.stringify({ contact_id: 'existing-1' }) }
    })
  });
  await assert.rejects(ws.actions.createContactWithCompany({ fullName: 'Ana Lima', email: 'ana@northline.example' }), (err) => {
    assert.equal(err.message, 'Could not add the contact: A contact with that email address is already in the CRM.');
    assert.equal(err.conflictContactId, 'existing-1');
    return true;
  });
  const twoNamed = workspace(async () => ({}), {
    rpc: () => ({
      data: null,
      error: { message: 'More than one company is called "Northline". Pick one of them.', details: JSON.stringify({ company_ids: ['a', 'b'] }) }
    })
  });
  await assert.rejects(twoNamed.actions.createContactWithCompany({ fullName: 'Ben', companyName: 'Northline' }), (err) => {
    assert.deepEqual([...err.matchingCompanyIds], ['a', 'b']);
    return true;
  });
  const noDetail = workspace(async () => ({}), { rpc: () => ({ data: null, error: { message: 'A contact needs a name.' } }) });
  await assert.rejects(noDetail.actions.createContactWithCompany({ fullName: ' ' }), (err) => {
    assert.equal('conflictContactId' in err, false, 'nothing to read when the database sent no detail');
    return true;
  });
});

/* ── Merging companies and contacts (0053) ─────────────────────────────── */

test('merging companies or contacts calls the database\'s own function and hands back what it moved', async () => {
  const moved = { kept_id: 'co-1', merged_id: 'co-2', moved: { 'crm_contacts.company_id': 2 } };
  const ws = workspace(async () => ({}), { rpc: (name) => ({ data: name === 'merge_companies' ? moved : { kept_id: 'c-1' }, error: null }) });
  assert.deepEqual(await ws.actions.mergeCompanies('co-1', 'co-2'), moved);
  assert.deepEqual(await ws.actions.mergeContacts('c-1', 'c-2'), { kept_id: 'c-1' });
  assert.deepEqual(ws.called, [
    { name: 'merge_companies', args: { p_keep: 'co-1', p_drop: 'co-2' } },
    { name: 'merge_contacts', args: { p_keep: 'c-1', p_drop: 'c-2' } }
  ]);
  const refused = workspace(async () => ({}), { rpc: () => ({ data: null, error: { message: 'Only an owner or admin can merge companies.' } }) });
  await assert.rejects(refused.actions.mergeCompanies('co-1', 'co-2'), { message: 'Could not merge the companies: Only an owner or admin can merge companies.' });
  const before = ws.called.length;
  await assert.rejects(ws.actions.mergeCompanies('co-1', 'co-1'), { message: 'A company cannot be merged into itself.' });
  assert.equal(ws.called.length, before, 'refused before the database is asked');
  await assert.rejects(ws.actions.mergeContacts('', 'c-2'), /Pick the contact to keep/);
});

test('an invoice marked paid or unpaid writes its status and the day it was paid to that invoice, and a refusal is said as one', async () => {
  const saved = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'inv-1' }] });
  await saved.actions.markInvoicePaid('inv-1', '2026-09-12');
  await saved.actions.reopenInvoice('inv-1', '2026-09-12');
  await saved.actions.reopenInvoice('inv-2', null);
  assert.deepEqual(saved.written.map(w => [w.table, w.what, w.change, w.where]), [
    ['finance_invoices', 'update', { status: 'paid', paid_on: '2026-09-12' }, [['id', 'inv-1'], ['status', { in: ['sent', 'overdue'] }]]],
    ['finance_invoices', 'update', { status: 'sent', paid_on: null }, [['id', 'inv-1'], ['status', 'paid'], ['paid_on', '2026-09-12']]],
    ['finance_invoices', 'update', { status: 'sent', paid_on: null }, [['id', 'inv-2'], ['status', 'paid'], ['paid_on', { is: null }]]]
  ], 'only an invoice still waiting is marked paid, and only the payment its dialog showed is undone');
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.markInvoicePaid('inv-1', '2026-09-12'),
    err => /has been paid, turned back into a draft or removed since/.test(err.message) && err.refused === true);
  await assert.rejects(refused.actions.reopenInvoice('inv-1', '2026-09-12'),
    err => /its payment was changed or it is no longer marked paid/.test(err.message) && err.refused === true);
  const failing = workspace(async () => ({ data: null, error: null }), { fail: () => ({ message: 'Failed to fetch' }) });
  await assert.rejects(failing.actions.markInvoicePaid('inv-1', '2026-09-12'),
    err => err.message === 'Could not mark the invoice paid: Failed to fetch' && !err.refused, 'a write that failed is no refusal');
  const undated = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(undated.actions.markInvoicePaid('inv-1', 'yesterday'), { message: 'Pick the day it was paid.' });
  await assert.rejects(undated.actions.reopenInvoice('inv-1'), { message: 'Which payment to undo was not given.' });
  assert.equal(undated.written.length, 0);
});

test('ticking a task off asks which rows changed, and none is a refusal, said as one', async () => {
  const ticked = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'task-1', status: 'done' }] });
  const row = await ticked.actions.setTaskDone('task-1', true);
  assert.equal(row.id, 'task-1');
  assert.deepEqual(ticked.written.map(w => [w.table, w.what, w.change.status, w.where]), [['tasks', 'update', 'done', [['id', 'task-1']]]]);
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.setTaskDone('task-1', true),
    { message: 'The task was not changed: only its assignee, its project’s team, or an owner or admin can tick it off.' },
    'not supabase-js\'s "no rows returned"');
});

test('unticking a task reopens it at the status it is given, not always "to do"', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await ws.actions.setTaskDone('task-1', false, 'in_progress');
  await ws.actions.setTaskDone('task-2', false, 'blocked');
  await ws.actions.setTaskDone('task-3', false, 'todo');
  await ws.actions.setTaskDone('task-4', false);
  await ws.actions.setTaskDone('task-5', false, 'done');
  await ws.actions.setTaskDone('task-6', false, 'not-a-status');
  assert.deepEqual(ws.written.map(w => w.change.status),
    ['in_progress', 'blocked', 'todo', 'todo', 'todo', 'todo'],
    'an unknown or missing status — and "done" itself, which is not something to reopen a task to — falls back to "to do"');
  assert.deepEqual(ws.written.map(w => w.change.completed_at), Array(6).fill(null));
  const ticked = workspace(async () => ({ data: null, error: null }));
  await ticked.actions.setTaskDone('task-1', true, 'in_progress');
  assert.equal(ticked.written[0].change.status, 'done', 'a hint meant for reopening is ignored while ticking');
});

test('removing a task asks which rows went, and none is a refusal, said as one', async () => {
  const removed = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'task-1' }] });
  await removed.actions.deleteTask('task-1');
  assert.deepEqual(removed.written.map(w => [w.table, w.what, w.where]), [['tasks', 'delete', [['id', 'task-1']]]]);
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.deleteTask('task-1'), { message: /only an owner or admin can remove a task/ });
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

test('a reply whose answer never arrived may have gone: nothing is saved here, and it says so', async () => {
  for (const answer of [unreachable, httpError(504)]) {
    const ws = workspace(async () => answer);
    await assert.rejects(ws.actions.replyToTicket(TICKET, 'Thanks, fixed.', 'reply'), (err) => {
      assert.equal(err.unknownOutcome, true);
      assert.match(err.message, /may have been sent/);
      return true;
    });
    assert.equal(ws.written.length, 0, 'a second copy would show the reply twice');
  }
});

test('a note whose answer never arrived is said as a note, not as a reply that may have gone', async () => {
  const ws = workspace(async () => unreachable);
  await assert.rejects(ws.actions.replyToTicket(TICKET, 'Checking the logs.', 'note'), (err) => {
    assert.equal(err.unknownOutcome, true);
    assert.match(err.message, /^The note may have been saved/);
    return true;
  });
});

test('a 404 in the function\'s own words is its answer, not a function that is not deployed', async () => {
  const ws = workspace(async () => httpError(404, { error: 'No such ticket' }));
  await assert.rejects(ws.actions.replyToTicket(TICKET, 'Thanks, fixed.', 'reply'), { message: 'No such ticket' });
  assert.equal(ws.written.length, 0, 'nothing saved beside it as "not deployed"');
});

test('a reply function that is not deployed still keeps what was written, and says it did not go', async () => {
  const ws = workspace(async () => httpError(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }));
  const result = await ws.actions.replyToTicket(TICKET, 'Thanks, fixed.', 'reply');
  assert.equal(result.sent, false);
  assert.equal(ws.written.length, 1);
  assert.equal(ws.written[0].table, 'ticket_messages');
});

test('a ticket\'s priority, owner and status are written to that ticket, and "Unassigned" is no owner', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await ws.actions.setTicketPriority(TICKET, 'urgent');
  await ws.actions.assignTicket(TICKET, '');
  await ws.actions.setTicketStatus(TICKET, 'waiting');
  assert.deepEqual(ws.written, [
    { table: 'support_tickets', what: 'update', change: { priority: 'urgent' }, where: [['id', TICKET]] },
    { table: 'support_tickets', what: 'update', change: { assignee_id: null }, where: [['id', TICKET]] },
    { table: 'support_tickets', what: 'update', change: { status: 'waiting' }, where: [['id', TICKET]] }
  ]);
});

test('assigning a ticket also tells the new owner; Unassigned tells nobody, and a failure there does not undo the save', async () => {
  const given = workspace(async (name) => ({ data: { ok: true }, error: null }), { rows: () => [{ id: TICKET, assignee_id: 'e2' }] });
  const row = await given.actions.assignTicket(TICKET, 'e2');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(row.assignee_id, 'e2');
  assert.deepEqual(given.invoked.map((i) => [i.name, i.body]), [['notify-ticket', { ticket_id: TICKET, event: 'assigned' }]]);

  const cleared = workspace(async () => ({ data: { ok: true }, error: null }), { rows: () => [{ id: TICKET, assignee_id: null }] });
  await cleared.actions.assignTicket(TICKET, '');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cleared.invoked, [], 'Unassigned tells nobody — there is no one to tell');

  const notifyFails = workspace(async () => { throw new Error('network blip'); }, { rows: () => [{ id: TICKET, assignee_id: 'e2' }] });
  const savedAnyway = await notifyFails.actions.assignTicket(TICKET, 'e2');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(savedAnyway.assignee_id, 'e2', 'the reassignment itself is not undone by a notification failure');
});

test('a new ticket carries a sender\'s raw address when the CRM has no contact for them', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'new-row' }] });
  await ws.actions.createTicket({ subject: 'A question', requesterEmail: 'guest@example.invalid', requesterName: 'A Guest' });
  assert.deepEqual(ws.written[0].change.requester_email, 'guest@example.invalid');
  assert.deepEqual(ws.written[0].change.requester_name, 'A Guest');
});

test('an edit to a ticket sends only what changed, against when it was opened; nothing changed or an empty subject is a refusal', async () => {
  const STAMP = '2026-09-15T08:00:00.123456+00:00';
  const saved = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: TICKET, subject: 'Renamed' }] });
  const row = await saved.actions.updateTicket(TICKET, { subject: 'Renamed', contact_id: 'c1' }, STAMP);
  assert.equal(row.subject, 'Renamed');
  assert.deepEqual(saved.written[0].where, [['id', TICKET], ['updated_at', STAMP]]);
  assert.deepEqual(saved.written[0].change, { subject: 'Renamed', contact_id: 'c1' });

  const unstamped = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: TICKET }] });
  await unstamped.actions.updateTicket(TICKET, { product: 'Kept' });
  assert.deepEqual(unstamped.written[0].where, [['id', TICKET]], 'with no stamp to go by, the ticket as it is');

  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.updateTicket(TICKET, { subject: 'Renamed' }, STAMP),
    { message: 'The ticket was not saved: it was changed since this was opened, or you may not change it. Close this and open the ticket again.' });

  const sneaky = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: TICKET }] });
  await assert.rejects(sneaky.actions.updateTicket(TICKET, { assignee_id: 'e2', subject: 'Renamed' }),
    { message: 'Only a ticket’s subject, contact, company, project and product can be changed here.' });
  await assert.rejects(sneaky.actions.updateTicket(TICKET, {}), { message: 'Nothing was changed.' });
  await assert.rejects(sneaky.actions.updateTicket(TICKET, { subject: '  ' }), { message: 'A ticket needs a subject.' });
});

test('deleting a ticket is a manager-only soft delete, and one already deleted is a refusal', async () => {
  const deleted = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: TICKET }] });
  await deleted.actions.deleteTicket(TICKET);
  assert.equal(deleted.written[0].table, 'support_tickets');
  assert.ok('deleted_at' in deleted.written[0].change);
  assert.deepEqual(deleted.written[0].where, [['id', TICKET], ['deleted_at', { is: null }]]);

  const staff = workspace(async () => ({ data: null, error: null }), { manager: false });
  await assert.rejects(staff.actions.deleteTicket(TICKET), { message: 'Only an owner or admin can delete a ticket.' });
  assert.equal(staff.written.length, 0, 'refused before it reaches the database');

  const already = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(already.actions.deleteTicket(TICKET),
    { message: 'The ticket was not deleted: it has been removed already, or only an owner or admin can remove one.' });
});

test('restoring a ticket is by its number, manager-only, and a ticket that was not deleted is a refusal', async () => {
  const restored = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: TICKET }] });
  await restored.actions.restoreTicket(142);
  assert.deepEqual(restored.written[0].change, { deleted_at: null });
  assert.deepEqual(restored.written[0].where, [['number', 142], ['deleted_at', { not: ['is', null] }]]);

  const staff = workspace(async () => ({ data: null, error: null }), { manager: false });
  await assert.rejects(staff.actions.restoreTicket(142), { message: 'Only an owner or admin can restore a ticket.' });

  const notNumber = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(notNumber.actions.restoreTicket(NaN), { message: 'That is not a ticket number.' });
  assert.equal(notNumber.written.length, 0);

  const notDeleted = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(notDeleted.actions.restoreTicket(142),
    { message: 'No deleted ticket has that number, or only an owner or admin can restore one.' });
});

test('a ticket attachment is stored before it is recorded, and taken away again if the record fails to save', async () => {
  const uploaded = [];
  const removedFromStorage = [];
  const storage = bucket => ({
    upload: async (path, file, opts) => { uploaded.push({ bucket, path, opts }); return { error: null }; },
    remove: async paths => { removedFromStorage.push({ bucket, paths }); return { error: null }; }
  });
  const file = { name: 'shot.png', size: 1024, type: 'image/png' };

  const ok = workspace(async () => ({ data: null, error: null }), { storage });
  await ok.actions.uploadTicketAttachment(TICKET, file);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].bucket, 'ticket-attachments');
  assert.match(uploaded[0].path, new RegExp('^' + TICKET + '/'));
  assert.equal(ok.written[0].table, 'ticket_attachments');
  assert.equal(ok.written[0].change.name, 'shot.png');
  assert.equal(ok.written[0].change.size_bytes, 1024);

  const failing = workspace(async () => ({ data: null, error: null }),
    { storage, fail: table => (table === 'ticket_attachments' ? { message: 'permission denied' } : null) });
  await assert.rejects(failing.actions.uploadTicketAttachment(TICKET, file), { message: 'Could not add "shot.png" to the ticket: permission denied' });
  assert.equal(removedFromStorage.length, 1, 'the stored file is taken away again when its record does not save');

  const empty = workspace(async () => ({ data: null, error: null }), { storage });
  await assert.rejects(empty.actions.uploadTicketAttachment(TICKET, { name: 'x.png', size: 0 }), /is empty/);
  const tooBig = workspace(async () => ({ data: null, error: null }), { storage });
  await assert.rejects(tooBig.actions.uploadTicketAttachment(TICKET, { name: 'x.png', size: 30 * 1024 * 1024 }), /larger than 25 MB/);
});

test('removing an attachment takes the file from storage first, then its record; a refusal is said as one', async () => {
  const storage = () => ({ remove: async () => ({ error: null }) });
  const removed = workspace(async () => ({ data: null, error: null }), { storage, rows: () => [{ id: 'a1' }] });
  await removed.actions.removeTicketAttachment({ id: 'a1', name: 'shot.png', storagePath: 'u1/a1/shot.png' });
  assert.deepEqual(removed.written[0], { table: 'ticket_attachments', what: 'delete', change: {}, where: [['id', 'a1']] });

  const refused = workspace(async () => ({ data: null, error: null }), { storage, rows: () => [] });
  await assert.rejects(refused.actions.removeTicketAttachment({ id: 'a1', name: 'shot.png', storagePath: 'u1/a1/shot.png' }),
    { message: 'Only whoever uploaded it, or an owner or admin, can remove this attachment.' });
});

test('a signed download link must be one Supabase actually gave back', async () => {
  const storage = () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x.supabase.co/sign/a1' }, error: null }) });
  const ws = workspace(async () => ({ data: null, error: null }), { storage });
  assert.equal(await ws.actions.ticketAttachmentLink('u1/a1/shot.png', 'shot.png'), 'https://x.supabase.co/sign/a1');

  const untrusted = workspace(async () => ({ data: null, error: null }), { storage: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'javascript:alert(1)' }, error: null }) }) });
  await assert.rejects(untrusted.actions.ticketAttachmentLink('u1/a1/shot.png', 'shot.png'), { message: 'Could not open the file.' });
});

test('merging calls merge_tickets(keep, drop) and hands back an error in its own words', async () => {
  const calls = [];
  const context = vm.createContext({
    console,
    window: {
      workspaceSession: {
        client: { rpc: (name, args) => { calls.push([name, { ...args }]); return Promise.resolve({ data: 'kept-id', error: null }); } }
      }
    }
  });
  for (const file of ['mail-model.js', 'projects-model.js', 'data/actions.js']) {
    vm.runInContext(readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'), context);
  }
  const kept = await context.window.workspaceActions.mergeTickets('u-keep', 'u-drop');
  assert.equal(kept, 'kept-id');
  assert.deepEqual(calls, [['merge_tickets', { p_keep: 'u-keep', p_drop: 'u-drop' }]]);

  context.window.workspaceSession.client.rpc = () => Promise.resolve({ data: null, error: { message: 'A ticket cannot be merged into itself' } });
  await assert.rejects(context.window.workspaceActions.mergeTickets('u-keep', 'u-keep'),
    { message: 'Could not merge the tickets: A ticket cannot be merged into itself' });
});

/* ── Booking ──────────────────────────────────────────────────────────── */

const EVENT = { title: 'Physio', startsAt: '2026-09-15T08:00:00Z', endsAt: '2026-09-15T09:00:00Z' };

test('an event is saved here alone only when the function says so', async () => {
  const ws = workspace(async () => httpError(409, { error: 'No calendar is connected', localOnly: true, reason: 'none' }));
  const saved = await ws.actions.createEvent(EVENT);
  assert.equal(ws.written.length, 1);
  assert.equal(ws.written[0].table, 'calendar_events');
  assert.equal(saved.why, null, 'nothing to fix: nothing is connected');
});

test('a studio calendar waiting to be reconnected says so when the event is saved here instead', async () => {
  const why = 'The studio calendar needs reconnecting, so this is saved in the workspace only.';
  const ws = workspace(async () => httpError(409, { error: why, localOnly: true, reason: 'studio-needs-reconnect' }));
  assert.equal((await ws.actions.createEvent({ ...EVENT, projectId: 'p1' })).why, why);
});

test('client work with no studio calendar to go in says so, not that no calendar is connected', async () => {
  const ws = workspace(async () => httpError(409, { error: 'No calendar is connected', localOnly: true, reason: 'no-studio' }));
  assert.equal((await ws.actions.createEvent({ ...EVENT, projectId: 'p1' })).why, 'The studio calendar is not connected, so this is saved in the workspace only.');
});

test('a refused private event, a 409 that is not localOnly, or no answer at all saves nothing', async () => {
  const answers = [
    httpError(503, { error: 'Your calendar needs reconnecting before events can be booked into it.', reason: 'own-needs-reconnect' }),
    httpError(409, { error: 'That calendar is not connected. Reconnect it first.' }),
    httpError(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }),
    unreachable
  ];
  for (const answer of answers) {
    const ws = workspace(async () => answer);
    await assert.rejects(ws.actions.createEvent(EVENT));
    assert.equal(ws.written.length, 0, `nothing written for ${answer.error.name} ${answer.error.context.status || ''}`);
  }
  const refused = workspace(async () => answers[0]);
  await assert.rejects(refused.actions.createEvent(EVENT), { message: 'Your calendar needs reconnecting before events can be booked into it.' });
  const lost = workspace(async () => unreachable);
  await assert.rejects(lost.actions.createEvent(EVENT), { message: 'The event could not be booked, and nothing was saved.' },
    'one sentence, not the client library\'s');
});

test('a priority the database does not know is refused before anything is written', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(ws.actions.setTicketPriority(TICKET, 'Medium'), /priority/);
  assert.equal(ws.written.length, 0);
});

/* ── Company ──────────────────────────────────────────────────────────── */

test('a role or status change writes only the columns given, and a refusal is said as one', async () => {
  const saved = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'e-1', role: 'admin' }] });
  assert.equal((await saved.actions.updateEmployee('e-1', { role: 'admin' })).role, 'admin');
  assert.deepEqual(saved.written.map(w => [w.table, w.what, w.change, w.where]),
    [['employees', 'update', { role: 'admin' }, [['id', 'e-1']]]]);
  const refused = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(refused.actions.updateEmployee('e-1', { status: 'inactive' }), { message: /^That was not saved/ });
  const nothing = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(nothing.actions.updateEmployee('e-1', {}), { message: 'Nothing to save.' });
  assert.equal(nothing.written.length, 0);
});

test('an invitation is sent through invite-employee, whole', async () => {
  const fields = { email: 'ana@northline.example', full_name: 'Ana Lima', role: 'employee', title: null, start_date: null };
  const ws = workspace(async () => ({ data: { ok: true, employee: { id: 'e-2' } }, error: null }));
  const out = await ws.actions.inviteEmployee(fields);
  assert.equal(out.employee.id, 'e-2');
  assert.deepEqual(ws.invoked, [{ name: 'invite-employee', body: fields }]);
});

test('the function\'s own refusal to invite is said in its words', async () => {
  const ws = workspace(async () => httpError(403, { error: 'Only an owner can make someone an owner.' }));
  await assert.rejects(ws.actions.inviteEmployee({ email: 'x@y.example', full_name: 'X', role: 'owner' }),
    { message: 'Only an owner can make someone an owner.' });
});

test('the studio profile is saved as workspace_settings rows, keyed so a value already saved is replaced', async () => {
  const saved = workspace(async () => ({ data: null, error: null }),
    { rows: () => [{ key: 'studio_name', value: 'Northline' }] });
  await saved.actions.updateStudioProfile({ studio_name: 'Northline', studio_email: 'hello@northline.example' });
  assert.deepEqual(saved.written, [{
    table: 'workspace_settings', what: 'upsert',
    change: [{ key: 'studio_name', value: 'Northline' }, { key: 'studio_email', value: 'hello@northline.example' }],
    options: { onConflict: 'key' }
  }]);
  const nothing = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(nothing.actions.updateStudioProfile({}), { message: 'Nothing to save.' });
});

/* ── Notifications ────────────────────────────────────────────────────── */

test('dismissing a notification inserts one row, under the signed-in person\'s own id', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await ws.actions.dismissNotification('ticket:t1');
  assert.deepEqual(ws.written, [{ table: 'notification_dismissals', what: 'insert',
    change: { employee_id: 'emp-1', notif_key: 'ticket:t1' } }]);
});

test('dismissing the same key twice is a harmless repeat, not an error', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), {
    fail: () => ({ code: '23505', message: 'duplicate key value violates unique constraint' })
  });
  await ws.actions.dismissNotification('events:today');
  assert.equal(ws.written.length, 1, 'still attempted — the constraint is what makes it a no-op');
});

test('any other failure to dismiss is said, not swallowed', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), {
    fail: () => ({ code: '42501', message: 'permission denied' })
  });
  await assert.rejects(ws.actions.dismissNotification('mail:unread'), { message: 'Could not dismiss that: permission denied' });
});

test('nothing is written for a blank key', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(ws.actions.dismissNotification(''), /Nothing to dismiss/);
  assert.equal(ws.written.length, 0);
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
  const refusal = 'Only an owner or admin can reconnect a studio mailbox or calendar.';
  const ws = workspace(async () => httpError(403, { error: refusal }));
  await assert.rejects(ws.actions.reconnectMailbox('hello@veyago.cloud'), { message: refusal });
});

test('reconnecting needs a mailbox to reconnect', async () => {
  const ws = workspace(async () => ({ data: { consentUrl: CONSENT }, error: null }));
  await assert.rejects(ws.actions.reconnectMailbox(''), /mailbox/i);
  assert.equal(ws.invoked.length, 0);
});

/* ── Connecting or disconnecting a mailbox (0062) ─────────────────────────
   connectMailbox mirrors connectCalendar's own shape exactly (0057) — the
   same microsoft-connect call, the other provider; disconnectMailbox is a
   plain table write, the same shape markThreadRead/starThread are NOT (those
   go through an Edge Function for Outlook's sake) — 0055 already widened
   integration_connections' own UPDATE policy to let a plain member of staff
   disconnect their own personal mailbox, or a manager the studio's, the same
   line reconnecting already draws; the workspace only ever sets `status`,
   which 0038's own trigger is what actually enforces. */

test('connecting a mailbox asks microsoft-connect for that provider, and hands back Microsoft\'s page', async () => {
  const ws = workspace(async () => ({ data: { connectionId: 'c1', consentUrl: CONSENT }, error: null }));
  const url = await ws.actions.connectMailbox('cassian@veyago.cloud');
  assert.equal(url, CONSENT);
  assert.deepEqual(ws.invoked, [{ name: 'microsoft-connect', body: { provider: 'microsoft_mail', accountLabel: 'cassian@veyago.cloud' } }],
    'no employeeId: the same shape connectCalendar already uses for a plain reconnect');
});

test('connecting a brand new studio mailbox says whose it is, explicitly, mirroring connectCalendar', async () => {
  const ws = workspace(async () => ({ data: { connectionId: 'c1', consentUrl: CONSENT }, error: null }));
  await ws.actions.connectMailbox('hello@veyago.cloud', null);
  assert.deepEqual(ws.invoked[0].body, { provider: 'microsoft_mail', accountLabel: 'hello@veyago.cloud', employeeId: null });
});

test('connecting a mailbox refuses a page that is not Microsoft\'s, and needs an address', async () => {
  const bad = workspace(async () => ({ data: { consentUrl: 'javascript:alert(1)' }, error: null }));
  await assert.rejects(bad.actions.connectMailbox('hello@veyago.cloud'), /Microsoft/);
  const empty = workspace(async () => ({ data: { consentUrl: CONSENT }, error: null }));
  await assert.rejects(empty.actions.connectMailbox(''), /mailbox/i);
  assert.equal(empty.invoked.length, 0);
});

test('disconnecting sets a mailbox\'s status directly — no Edge Function round trip, the way marking a thread read needs one', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), { rows: () => [{ id: 'c1' }] });
  const row = await ws.actions.disconnectMailbox('c1');
  assert.equal(row.id, 'c1');
  assert.deepEqual(ws.written.map(w => [w.table, w.what, w.change, w.where]),
    [['integration_connections', 'update', { status: 'disconnected' }, [['id', 'c1']]]]);
  assert.equal(ws.invoked.length, 0);
});

test('disconnecting a mailbox this session may not act on (RLS refuses the write) says so, rather than a silent success', async () => {
  const ws = workspace(async () => ({ data: null, error: null }), { rows: () => [] });
  await assert.rejects(ws.actions.disconnectMailbox('c1'),
    { message: /^That mailbox could not be disconnected: it may already be, or this is not yours to change\./ });
});

test('disconnecting needs a mailbox to disconnect', async () => {
  const ws = workspace(async () => ({ data: null, error: null }));
  await assert.rejects(ws.actions.disconnectMailbox(''), /mailbox/i);
  assert.equal(ws.written.length, 0);
});

/* ── Projects ─────────────────────────────────────────────────────────── */

test('editing a project writes only the columns a project form may change', async () => {
  const ws = workspace(async () => ({}));
  await ws.actions.updateProject('p1', {
    name: 'New name', due_on: null, owner_id: 'e2',
    deleted_at: '2026-09-14T00:00:00Z', budget: 100000, status: 'completed'
  });
  assert.deepEqual(ws.written, [{
    table: 'client_projects', what: 'update',
    change: { name: 'New name', due_on: null, owner_id: 'e2' },
    where: [['id', 'p1']]
  }], 'the budget is managers\' business and archiving has its own action; neither rides along on an edit');
});

test('an edit with nothing in it writes nothing', async () => {
  const ws = workspace(async () => ({}));
  assert.equal(await ws.actions.updateProject('p1', {}), null);
  assert.equal(await ws.actions.updateProject('p1', { budget: 5 }), null);
  assert.equal(ws.written.length, 0);
});

test('archiving a project is for owners and admins, and keeps the project', async () => {
  const manager = workspace(async () => ({}), { manager: true });
  await manager.actions.archiveProject('p1');
  assert.equal(manager.written.length, 1);
  assert.equal(manager.written[0].table, 'client_projects');
  assert.deepEqual(Object.keys(manager.written[0].change), ['deleted_at'], 'archived, not deleted: the row stays');
  assert.deepEqual(manager.written[0].where, [['id', 'p1']], 'that project, and no other');
  assert.ok(!Number.isNaN(Date.parse(manager.written[0].change.deleted_at)));

  const staff = workspace(async () => ({}), { manager: false });
  await assert.rejects(staff.actions.archiveProject('p1'), /owner or admin/);
  assert.equal(staff.written.length, 0);
});

test('restoring a project is for owners and admins too, and asks which row came back', async () => {
  const manager = workspace(async () => ({}), { manager: true, rows: () => [{ id: 'p1', deleted_at: null }] });
  await manager.actions.restoreProject('p1');
  assert.deepEqual(manager.written, [{ table: 'client_projects', what: 'update', change: { deleted_at: null }, where: [['id', 'p1']] }]);

  const staff = workspace(async () => ({}), { manager: false });
  await assert.rejects(staff.actions.restoreProject('p1'), /owner or admin/);
  assert.equal(staff.written.length, 0);

  const gone = workspace(async () => ({}), { manager: true, rows: () => [] });
  await assert.rejects(gone.actions.restoreProject('p1'),
    err => /not archived any more, or only an owner or admin/.test(err.message) && err.refused === true);
});

test('a new project is owned by whoever adds it, by the owner it is given, or by no one when that is chosen — never confused with "not said"', async () => {
  const ws = workspace(async () => ({}));
  await ws.actions.createProject({ name: 'Northline site' });
  await ws.actions.createProject({ name: 'Kept · Autumn release', ownerId: 'e-2' });
  await ws.actions.createProject({ name: 'A side project', ownerId: null });
  assert.equal(ws.written[0].change.owner_id, 'emp-1', 'nothing said: whoever adds it');
  assert.equal(ws.written[1].change.owner_id, 'e-2');
  assert.equal(ws.written[2].change.owner_id, null, '"No owner" picked in the dialog is no owner, not the creator again');
});

test('a new project sends its start date, and every field a fresh project can be given', async () => {
  const ws = workspace(async () => ({}));
  await ws.actions.createProject({
    name: 'Northline site', companyId: 'co1', description: 'Relaunch',
    startsOn: '2026-09-15', dueOn: '2026-12-01', status: 'in_progress', code: 'N', accent: 'client'
  });
  assert.deepEqual(ws.written[0].change, {
    name: 'Northline site', company_id: 'co1', code: 'N', accent: 'client', status: 'in_progress',
    description: 'Relaunch', starts_on: '2026-09-15', due_on: '2026-12-01', owner_id: 'emp-1'
  });
  const bare = workspace(async () => ({}));
  await bare.actions.createProject({ name: 'Minimal' });
  assert.equal(bare.written[0].change.starts_on, null);
  assert.equal(bare.written[0].change.status, 'discovery');
  await assert.rejects(bare.actions.createProject({ name: '  ' }), { message: 'A project needs a name.' });
});

test('a project\'s start date is one of the columns an edit may change', async () => {
  const ws = workspace(async () => ({}));
  await ws.actions.updateProject('p1', { starts_on: '2026-09-15' });
  assert.deepEqual(ws.written[0].change, { starts_on: '2026-09-15' });
});

/* ── A project's team, client people, files and budget (0039) ────────── */

test('adding someone to a project and taking them off touch that membership only', async () => {
  const ws = workspace(async () => ({}));
  await ws.actions.addProjectMember('p1', 'e2');
  await ws.actions.removeProjectMember('p1', 'e2');
  assert.deepEqual(ws.written, [
    { table: 'project_members', what: 'insert', change: { project_id: 'p1', employee_id: 'e2' } },
    { table: 'project_members', what: 'delete', change: {}, where: [['project_id', 'p1'], ['employee_id', 'e2']] }
  ]);
});

test('a removal the database quietly refused says so, instead of looking done', async () => {
  const ws = workspace(async () => ({}), { rows: () => [] });
  await assert.rejects(ws.actions.removeProjectMember('p1', 'e2'), /owner/);
  await assert.rejects(ws.actions.removeProjectContact('p1', 'k1'), /not on the project/);
});

test('a refused addition to the team says who may add people', async () => {
  const ws = workspace(async () => ({}), {
    fail: table => (table === 'project_members' ? { message: 'new row violates row-level security policy for table "project_members"' } : null)
  });
  await assert.rejects(ws.actions.addProjectMember('p1', 'e2'), /owner or an owner or admin/);
});

test('a client person joins with a role, and only the role changes afterwards — never upserted', async () => {
  const ws = workspace(async () => ({}));
  await ws.actions.addProjectContact('p1', 'k1', 'billing');
  await ws.actions.setProjectContactRole('p1', 'k1', 'decision_maker');
  await ws.actions.removeProjectContact('p1', 'k1');
  assert.deepEqual(ws.written, [
    { table: 'project_contacts', what: 'insert', change: { project_id: 'p1', contact_id: 'k1', role: 'billing' } },
    { table: 'project_contacts', what: 'update', change: { role: 'decision_maker' }, where: [['project_id', 'p1'], ['contact_id', 'k1']] },
    { table: 'project_contacts', what: 'delete', change: {}, where: [['project_id', 'p1'], ['contact_id', 'k1']] }
  ], 'the column grants refuse an upsert, which also updates the key');
  await assert.rejects(ws.actions.addProjectContact('p1', 'k1', 'boss'), /role/);
  await assert.rejects(ws.actions.setProjectContactRole('p1', 'k1', ''), /role/);
  assert.equal(ws.written.length, 3, 'a role the database does not know is refused before it is sent');
});

test('a project file is stored in its project\'s folder, then recorded', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage });
  const record = await ws.actions.uploadProjectFile('p1', { name: 'Brief (v2).pdf', size: 2048, type: 'application/pdf' });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].bucket, 'project-files');
  assert.match(stub.calls[0].path, /^p1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/Brief-v2\.pdf$/);
  assert.equal(stub.calls[0].options.upsert, false);
  assert.deepEqual(ws.written, [{
    table: 'project_files', what: 'insert',
    change: { project_id: 'p1', storage_path: stub.calls[0].path, name: 'Brief (v2).pdf', size_bytes: 2048, content_type: 'application/pdf' }
  }]);
  assert.equal(record.id, 'new-row');
});

test('an upload that could not be recorded is taken away again', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), {
    storage: stub.storage,
    fail: table => (table === 'project_files' ? { message: 'new row violates row-level security policy' } : null)
  });
  await assert.rejects(ws.actions.uploadProjectFile('p1', { name: 'a.pdf', size: 5, type: 'application/pdf' }), /a\.pdf/);
  assert.deepEqual(stub.calls.map(c => c.what), ['upload', 'remove']);
  assert.deepEqual(stub.calls[1].paths, [stub.calls[0].path], 'nobody would ever see an upload without its record');
});

test('a file too large for the bucket is refused before it is uploaded', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage });
  await assert.rejects(ws.actions.uploadProjectFile('p1', { name: 'film.mov', size: 52428801, type: 'video/quicktime' }), /50 MB/);
  await assert.rejects(ws.actions.uploadProjectFile('p1', { name: 'empty.txt', size: 0, type: 'text/plain' }), /empty/);
  assert.equal(stub.calls.length, 0);
  assert.equal(ws.written.length, 0);
});

test('removing a file removes the upload first, then its record', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage });
  await ws.actions.removeProjectFile({ id: 'f1', name: 'brief.pdf', path: 'p1/u1/brief.pdf' });
  assert.deepEqual(stub.calls, [{ bucket: 'project-files', what: 'remove', paths: ['p1/u1/brief.pdf'] }]);
  assert.deepEqual(ws.written, [{ table: 'project_files', what: 'delete', change: {}, where: [['id', 'f1']] }]);
});

test('a file someone may not remove stays, and they are told whose it is to remove', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage, rows: () => [] });
  await assert.rejects(ws.actions.removeProjectFile({ id: 'f1', name: 'brief.pdf', path: 'p1/u1/brief.pdf' }), /uploaded it/);
});

test('a file opens through a link that expires in a minute, downloading under its own name when one is given', async () => {
  const stub = storageStub();
  const ws = workspace(async () => ({}), { storage: stub.storage });
  const bare = await ws.actions.projectFileLink('p1/u1/brief.pdf');
  assert.match(bare, /^https:\/\//);
  assert.deepEqual(stub.calls, [{ bucket: 'project-files', what: 'sign', path: 'p1/u1/brief.pdf', seconds: 60, options: undefined }],
    'nothing to name the download by: no options, not a link the browser reads as one');

  const named = await ws.actions.projectFileLink('p1/u1/brief.pdf', 'Brief (v2).pdf');
  assert.match(named, /^https:\/\//);
  assert.deepEqual({ ...stub.calls[1].options }, { download: 'Brief (v2).pdf' },
    'the file’s own name, not the storage path it happens to be filed under');
});

test('a link the storage API refuses, or one that is not really a link, opens nothing', async () => {
  const refused = workspace(async () => ({}), { storage: () => ({ createSignedUrl: async () => ({ data: null, error: { message: 'Object not found' } }) }) });
  await assert.rejects(refused.actions.projectFileLink('p1/u1/gone.pdf'), { message: 'Could not open the file: Object not found' });
  const bogus = workspace(async () => ({}), { storage: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'javascript:alert(1)' }, error: null }) }) });
  await assert.rejects(bogus.actions.projectFileLink('p1/u1/x.pdf'), { message: 'Could not open the file.' });
});

test('a budget is set with insert, changed with update and cleared with delete — never upserted', async () => {
  const ws = workspace(async () => ({}));
  await ws.actions.setProjectBudget('p1', { action: 'set', amount: 12500, currency: 'EUR' });
  await ws.actions.setProjectBudget('p1', { action: 'change', amount: 13000, currency: 'EUR' });
  await ws.actions.setProjectBudget('p1', { action: 'clear' });
  assert.equal(await ws.actions.setProjectBudget('p1', { action: 'none' }), null);
  assert.deepEqual(ws.written, [
    { table: 'project_budgets', what: 'insert', change: { project_id: 'p1', amount: 12500, currency: 'EUR' } },
    { table: 'project_budgets', what: 'update', change: { amount: 13000, currency: 'EUR' }, where: [['project_id', 'p1']] },
    { table: 'project_budgets', what: 'delete', change: {}, where: [['project_id', 'p1']] }
  ]);
});

test('a budget is for owners and admins only', async () => {
  const ws = workspace(async () => ({}), { manager: false });
  await assert.rejects(ws.actions.setProjectBudget('p1', { action: 'set', amount: 1, currency: 'EUR' }), /owner or admin/);
  assert.equal(ws.written.length, 0);
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
      },
      createSignedUrl: async (path, seconds, options) => {
        calls.push({ bucket, what: 'sign', path, seconds, options });
        return { data: error ? null : { signedUrl: `https://storage.example/sign/${path}` }, error };
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
