/* The Overview's figures, asked for the way the database counts them: in the
   viewer's time zone (0041), and still readable from a database that has not
   been updated yet. queries.js against a stand-in Supabase client that records
   every call. Loaded into a sandbox the way <script> tags run it.
   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MISSING = name => ({
  data: null,
  error: { code: 'PGRST202', message: `Could not find the function public.${name}(p_months, p_tz) in the schema cache` }
});

/* rpc(name, args, n): what the nth call resolves to. What the page warns
   about on the console is kept in warnings. */
function load(rpc) {
  const calls = [];
  const warnings = [];
  const client = {
    rpc: (name, args) => {
      calls.push({ name, args: { ...args } });
      return Promise.resolve(rpc(name, args, calls.length));
    }
  };
  const quiet = { ...console, warn: (...parts) => warnings.push(parts.join(' ')) };
  const context = vm.createContext({ console: quiet, Intl, window: { workspaceSession: { client } } });
  vm.runInContext(readFileSync(new URL('../dist/data/queries.js', import.meta.url), 'utf8'), context);
  return { data: context.window.workspaceData, calls, warnings };
}

test('the overview is asked for in the viewer\'s own time zone', async () => {
  const q = load(() => ({ data: { time_zone: ZONE }, error: null }));
  const overview = await q.data.overview();
  assert.equal(overview.time_zone, ZONE);
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0].name, 'workspace_overview');
  assert.deepEqual(q.calls[0].args, { p_tz: ZONE });
});

test('the revenue series and mix say the zone as well as how many months', async () => {
  const q = load(() => ({ data: [], error: null }));
  await q.data.revenueSeries(12);
  await q.data.revenueMix(1);
  assert.deepEqual(q.calls.map(c => [c.name, c.args]), [
    ['revenue_series', { p_months: 12, p_tz: ZONE }],
    ['revenue_mix', { p_months: 1, p_tz: ZONE }]
  ]);
});

test('a database that does not take a time zone yet is asked again the way it understands', async () => {
  const q = load((name, args, n) => (n === 1 ? MISSING(name) : { data: [{ month: '2026-09-01', revenue: 1 }], error: null }));
  const rows = await q.data.revenueSeries(12);
  assert.equal(rows.length, 1);
  assert.deepEqual(q.calls.map(c => c.args), [{ p_months: 12, p_tz: ZONE }, { p_months: 12 }],
    'the workspace and the database can go live in either order');
});

test('any other failure is a failure, said in words, and not asked twice', async () => {
  const q = load(() => ({ data: null, error: { code: '42501', message: 'permission denied for function revenue_mix' } }));
  await assert.rejects(q.data.revenueMix(1), { message: 'Could not load the revenue mix: permission denied for function revenue_mix' });
  assert.equal(q.calls.length, 1);
});

test('a function found not to take a time zone is asked without one from then on, and the console says so once', async () => {
  const q = load((name, args) => ('p_tz' in args ? MISSING(name) : { data: [], error: null }));
  await q.data.revenueSeries(12);
  await q.data.revenueSeries(12);
  assert.deepEqual(q.calls.map(c => c.args), [{ p_months: 12, p_tz: ZONE }, { p_months: 12 }, { p_months: 12 }],
    'two round trips once, not on every refresh');
  assert.equal(q.warnings.length, 1);
  assert.match(q.warnings[0], /revenue_series does not take a time zone yet/);

  await q.data.revenueMix(1);
  assert.deepEqual(q.calls.slice(3).map(c => c.args), [{ p_months: 1, p_tz: ZONE }, { p_months: 1 }],
    'each function is found out on its own');
});

test('missing both ways, the error is the first answer; failing another way, it is that failure', async () => {
  const notThere = (name, args) => ({
    data: null,
    error: { code: 'PGRST202', message: `Could not find the function public.${name}(${Object.keys(args).join(', ')})` }
  });
  const missing = load(notThere);
  await assert.rejects(missing.data.overview(),
    { message: 'Could not load the overview: Could not find the function public.workspace_overview(p_tz)' },
    'the answer that names what the page asked for, not the retry\'s');
  assert.equal(missing.warnings.length, 0, 'nothing was found to be asked without a zone');

  const offline = load((name, args) => ('p_tz' in args ? MISSING(name) : { data: null, error: { message: 'Failed to fetch' } }));
  await assert.rejects(offline.data.overview(), { message: 'Could not load the overview: Failed to fetch' });
});

/* ── Money ────────────────────────────────────────────────────────────── */

/* ── Mail ─────────────────────────────────────────────────────────────── */

/* A client whose tables record every chained call and answer with the rows
   rowsFor(table) gives — none, unless a test says otherwise. */
function loadTables(rowsFor = () => []) {
  const queries = [];
  const client = {
    from(table) {
      const calls = [];
      queries.push({ table, calls });
      const builder = new Proxy({}, {
        get: (_, method) => (method === 'then'
          ? resolve => resolve({ data: rowsFor(table), error: null })
          : (...args) => { calls.push([method, ...args]); return builder; })
      });
      return builder;
    }
  };
  const context = vm.createContext({ console, Intl, window: { workspaceSession: { client } } });
  vm.runInContext(readFileSync(new URL('../dist/data/queries.js', import.meta.url), 'utf8'), context);
  return { data: context.window.workspaceData, queries };
}

test('Starred reaches conversations filed away in Outlook, and Inbox and Sent stay themselves', async () => {
  const { data, queries } = loadTables();
  await data.mailThreads(['inbox', 'sent', 'starred'], ['box-1']);
  const filters = queries.map(q => q.calls
    .filter(([method]) => method === 'eq' || method === 'not')
    .map(call => call.join(' ')));
  assert.deepEqual(filters, [
    ['eq folder inbox', 'eq connection_id box-1'],
    ['eq folder sent', 'eq connection_id box-1'],
    ['eq is_starred true', 'not folder in (inbox,sent)', 'eq connection_id box-1']
  ]);
});

test('mailThreads asks for the other party, and no longer for whoever sent most recently', async () => {
  const { data, queries } = loadTables();
  await data.mailThreads(['inbox'], ['box-1']);
  const select = queries[0].calls.find(([method]) => method === 'select')[1];
  assert.ok(select.includes('other_party_name'), 'asks for other_party_name');
  assert.ok(select.includes('other_party_email'), 'asks for other_party_email');
  assert.ok(!select.includes('last_from_name'), 'the renamed column is gone, not just supplemented');
});

test('a thread shows the OTHER party — never whoever wrote most recently — and a CRM contact outranks both', async () => {
  const { data } = loadTables(table => (table !== 'mail_threads' ? [] : [
    { id: 't1', connection_id: 'box-1', folder: 'inbox', message_count: 2, last_message_at: '2026-09-10T09:00:00Z',
      subject: 'Kickoff', snippet: 'Looking forward', is_read: true, is_starred: false,
      other_party_name: 'Ana Lima', other_party_email: 'ana@northline.example',
      ticket_id: null, contact_id: null, contact: null },
    { id: 't2', connection_id: 'box-1', folder: 'inbox', message_count: 1, last_message_at: '2026-09-09T09:00:00Z',
      subject: 'Intro', snippet: 'Hello', is_read: true, is_starred: false,
      other_party_name: null, other_party_email: 'prospect@newbiz.example',
      ticket_id: null, contact_id: null, contact: null },
    { id: 't3', connection_id: 'box-1', folder: 'inbox', message_count: 3, last_message_at: '2026-09-08T09:00:00Z',
      subject: 'Renewal', snippet: 'Thanks', is_read: true, is_starred: false,
      other_party_name: 'Stale Name', other_party_email: 'stale@x.example',
      ticket_id: null, contact_id: 'c1', contact: { full_name: 'Real Contact', email: 'real@x.example' } },
    { id: 't4', connection_id: 'box-1', folder: 'inbox', message_count: 0, last_message_at: null,
      subject: 'Nothing known', snippet: '', is_read: true, is_starred: false,
      other_party_name: null, other_party_email: null, ticket_id: null, contact_id: null, contact: null }
  ]));
  const { threads } = await data.mailThreads(['inbox'], ['box-1']);
  const byId = Object.fromEntries(threads.map(t => [t.id, t]));
  assert.equal(byId.t1.sender, 'Ana Lima', 'answered or not, a known name is shown');
  assert.equal(byId.t2.sender, 'prospect@newbiz.example',
    'a thread we started, nobody has answered yet: the address we wrote to, not our own name nor "Unknown sender"');
  assert.equal(byId.t2.email, 'prospect@newbiz.example');
  assert.equal(byId.t3.sender, 'Real Contact', 'a matched CRM contact outranks the other-party columns');
  assert.equal(byId.t3.email, 'real@x.example');
  assert.equal(byId.t4.sender, 'Unknown sender', 'nothing known about either party at all');
});

test('a message carries its importance, Bcc and its attachments\' metadata', async () => {
  const { data, queries } = loadTables(table => (table !== 'mail_messages' ? [] : [
    { id: 'm1', external_id: 'x1', direction: 'inbound', from_name: 'Ana Lima', from_email: 'ana@northline.example',
      to_emails: ['hello@veyago.cloud'], cc_emails: [], bcc_emails: [], subject: 'Re: Kickoff',
      body_text: 'See attached', body_html: '', sent_at: '2026-09-10T09:00:00Z', importance: 'high',
      mail_attachments: [
        { id: 'a1', name: 'brief.pdf', content_type: 'application/pdf', size: 4096, is_inline: false, content_id: null },
        { id: 'a2', name: 'logo.png', content_type: 'image/png', size: 512, is_inline: true, content_id: 'logo1' }
      ] }
  ]));
  const [m] = await data.mailMessages('t1');
  const select = queries[0].calls.find(([method]) => method === 'select')[1];
  for (const part of ['bcc_emails', 'importance', 'mail_attachments']) {
    assert.ok(select.includes(part), `the query asks for ${part}`);
  }
  assert.equal(m.importance, 'high');
  assert.deepEqual([...m.bcc], []);
  assert.equal(m.attachments.length, 2);
  /* Spread first: these objects were built inside the vm sandbox, a different
     realm whose Object is not this file's — deepEqual (this file imports the
     strict assert, whose deepEqual is deepStrictEqual) tells them apart by
     that alone otherwise, however identical their own fields are. */
  assert.deepEqual({ ...m.attachments[0] },
    { id: 'a1', name: 'brief.pdf', size: 4096, contentType: 'application/pdf', isInline: false, contentId: null });
  assert.equal(m.attachments[1].isInline, true);
  assert.equal(m.attachments[1].contentId, 'logo1');
});

test('no importance reads as normal, and no attachments is an empty list, not missing', async () => {
  const { data } = loadTables(table => (table !== 'mail_messages' ? [] : [
    { id: 'm1', external_id: 'x1', direction: 'outbound', from_name: '', from_email: 'hello@veyago.cloud',
      to_emails: [], cc_emails: [], bcc_emails: null, subject: '', body_text: '', body_html: '',
      sent_at: '2026-09-10T09:00:00Z', importance: null, mail_attachments: null }
  ]));
  const [m] = await data.mailMessages('t1');
  assert.equal(m.importance, 'normal');
  assert.deepEqual([...m.bcc], []);
  assert.deepEqual([...m.attachments], []);
});

test('searchMail reaches the database for a whole mailbox\'s words, and skips a blank query entirely', async () => {
  const q = load((name, args) => (name === 'search_mail'
    ? {
      data: [{ thread_id: 't1', connection_id: 'box-1', subject: 'Kickoff', snippet: 'Looking forward to it', sent_at: '2026-01-05T09:00:00Z' }],
      error: null
    }
    : { data: null, error: { message: 'unexpected rpc ' + name } }));

  assert.deepEqual([...(await q.data.searchMail('   '))], [], 'blank (or whitespace-only) is not a search');
  assert.equal(q.calls.length, 0, 'nothing was asked for it');

  const [hit] = await q.data.searchMail('kickoff');
  assert.deepEqual(q.calls[0], { name: 'search_mail', args: { p_query: 'kickoff', p_limit: 30 } });
  assert.equal(hit.threadId, 't1');
  assert.equal(hit.mailboxId, 'box-1');
  assert.equal(hit.subject, 'Kickoff');
  assert.equal(hit.preview, 'Looking forward to it');
});

test('a search failure is said in words', async () => {
  const q = load(() => ({ data: null, error: { message: 'permission denied for function search_mail' } }));
  await assert.rejects(q.data.searchMail('kickoff'),
    { message: 'Could not search mail: permission denied for function search_mail' });
});

/* ── Tickets ──────────────────────────────────────────────────────────── */

/* The list embeds only enough of each message to know whether the
   conversation changed (id, direction, created_at, delivered_at,
   delivery_error) — never its body or who wrote it, which used to come with
   every ticket on every load (audit #12). The whole conversation, worded and
   attributed, is a separate call (ticketMessages), asked for once a ticket's
   page actually needs it — the same reason mail keeps a thread's body apart
   from its list (queries.mailThreads / mailMessages). */
test('the list asks for enough to know a ticket changed, never a message\'s words', async () => {
  const { data, queries } = loadTables(table => (table !== 'support_tickets' ? [] : [{
    id: 'u142', number: 142, subject: 'Checkout', product: null, priority: 'urgent', status: 'in_progress',
    created_at: '2026-09-10T09:00:00Z', updated_at: '2026-09-10T10:00:00Z', assignee_id: 'e-me',
    merged_into_id: null, first_response_due_at: '2026-09-10T13:00:00Z', resolve_due_at: '2026-09-11T09:00:00Z',
    contact: { full_name: 'Ana Lima', email: 'ana@northline.example' }, company: null, assignee: { full_name: 'Sam Rivera' },
    ticket_messages: [
      { id: 'm2', direction: 'outbound', created_at: '2026-09-10T10:00:00Z', delivered_at: null, delivery_error: 'refused' },
      { id: 'm1', direction: 'inbound', created_at: '2026-09-10T09:00:00Z', delivered_at: null, delivery_error: null }
    ]
  }]));
  const [t] = await data.tickets();
  const select = queries[0].calls.find(([method]) => method === 'select')[1];
  for (const part of ['assignee_id', 'contact:crm_contacts (full_name, email)', 'delivered_at', 'delivery_error',
                      'first_response_at', 'updated_at', 'merged_into_id', 'first_response_due_at', 'resolve_due_at']) {
    assert.ok(select.includes(part), `the query asks for ${part}`);
  }
  assert.doesNotMatch(select, /\bbody\b/, 'a message\'s words are not in the list query');
  assert.doesNotMatch(select, /author:employees|sender:crm_contacts/, 'nor who wrote it — that comes with ticketMessages');
  assert.equal(t.assigneeId, 'e-me');
  assert.equal(t.assigneeName, 'Sam Rivera');
  assert.equal(t.contactEmail, 'ana@northline.example');
  assert.equal(t.status, 'In progress');
  assert.equal(t.thread, null, 'not loaded with the list; store.js asks for it lazily');
  assert.equal(t.messageCount, 2);
  assert.equal(t.lastMessageAt, '2026-09-10T10:00:00Z');
  assert.equal(t.deliveryFailed, true, 'the latest outbound message never delivered');
  assert.equal(t.mergedIntoId, null);
});

test('a fallback address stands in for the client and the reply-to address when there is no CRM contact', async () => {
  const { data } = loadTables(table => (table !== 'support_tickets' ? [] : [{
    id: 'u143', number: 143, subject: 'A question', product: null, priority: 'normal', status: 'open',
    created_at: '2026-09-10T09:00:00Z', requester_email: 'guest@example.invalid', requester_name: 'A Guest',
    contact: null, company: null, assignee: null, ticket_messages: []
  }]));
  const [t] = await data.tickets();
  assert.equal(t.client, 'A Guest', 'the raw sender name, when the CRM has no contact for them');
  assert.equal(t.contactEmail, 'guest@example.invalid', 'so a reply still has somewhere to go (audit #1)');
});

test('a delivered reply, or one with nothing sent yet, is not flagged as failed', async () => {
  const sent = (over) => loadTables(table => (table !== 'support_tickets' ? [] : [Object.assign({
    id: 'u1', number: 1, subject: 'x', product: null, priority: 'normal', status: 'open',
    created_at: '2026-09-10T09:00:00Z', contact: null, company: null, assignee: null
  }, over)]));
  const delivered = await sent({ ticket_messages: [{ id: 'm1', direction: 'outbound', created_at: '2026-09-10T10:00:00Z', delivered_at: '2026-09-10T10:00:02Z', delivery_error: null }] }).data.tickets();
  assert.equal(delivered[0].deliveryFailed, false);
  const none = await sent({ ticket_messages: [] }).data.tickets();
  assert.equal(none[0].deliveryFailed, false);
});

test('a ticket\'s whole conversation, oldest first, with who wrote each message', async () => {
  const { data, queries } = loadTables(table => (table !== 'ticket_messages' ? [] : [
    { id: 'm2', body: 'On it', direction: 'outbound', created_at: '2026-09-10T10:00:00Z',
      delivered_at: null, delivery_error: 'refused', author: { full_name: 'Sam Rivera' }, sender: null },
    { id: 'm1', body: 'Broken', direction: 'inbound', created_at: '2026-09-10T09:00:00Z',
      author: null, sender: { full_name: 'Ana Lima' } }
  ]));
  const thread = await data.ticketMessages('u142');
  const call = queries.find(q => q.table === 'ticket_messages');
  const select = call.calls.find(([method]) => method === 'select')[1];
  for (const part of ['body', 'delivered_at', 'delivery_error', 'author:employees (full_name)', 'sender:crm_contacts (full_name)']) {
    assert.ok(select.includes(part), `asks for ${part}`);
  }
  assert.deepEqual(call.calls.find(([method]) => method === 'eq'), ['eq', 'ticket_id', 'u142']);
  assert.deepEqual([...thread.map(m => `${m.id}:${m.who}`)], ['m1:Ana Lima', 'm2:Sam Rivera'], 'oldest first, with who wrote it');
});

test('a ticket\'s attachments, newest first', async () => {
  const { data, queries } = loadTables(table => (table !== 'ticket_attachments' ? [] : [
    { id: 'a1', name: 'screenshot.png', size_bytes: 2048, content_type: 'image/png', storage_path: 'u142/a1/screenshot.png', created_at: '2026-09-10T09:00:00Z' }
  ]));
  const files = await data.ticketAttachments('u142');
  const call = queries.find(q => q.table === 'ticket_attachments');
  assert.deepEqual(call.calls.find(([method]) => method === 'eq'), ['eq', 'ticket_id', 'u142']);
  assert.equal(files[0].name, 'screenshot.png');
  assert.equal(files[0].sizeBytes, 2048);
});

test('every ticket loads, past the thousand rows the API hands back at once', async () => {
  let served = 0;
  const ticket = i => ({ id: `t${i}`, number: i, subject: `Ticket ${i}`, status: 'open', priority: 'normal', ticket_messages: [] });
  const { data, queries } = loadTables(table => {
    if (table !== 'support_tickets') return [];
    served += 1;
    return served === 1 ? Array.from({ length: 1000 }, (_, i) => ticket(i)) : [ticket(1000)];
  });
  const list = await data.tickets();
  assert.equal(list.length, 1001);
  assert.deepEqual(queries.map(q => q.calls.filter(([method]) => method === 'range').map(call => call.slice(1).join('-'))), [['0-999'], ['1000-1999']]);
  assert.ok(queries[0].calls.some(call => call.join(' ') === 'order id'), 'pages in a fixed order do not overlap');
});

/* ── Agenda and tasks ─────────────────────────────────────────────────── */

/* agendaModel.loadRange() for the week of Monday 14 September 2026, in Berlin. */
const WEEK = Object.freeze({ from: '2026-09-13T22:00:00.000Z', to: '2026-09-20T22:00:00.000Z', since: '2026-09-12T22:00:00.000Z' });
const OVERLAP = 'or ends_at.gt."2026-09-12T22:00:00.000Z",and(ends_at.is.null,starts_at.gte."2026-09-12T22:00:00.000Z")';

test('a week\'s events are the ones that overlap it, one that began before it included', async () => {
  const { data, queries } = loadTables(table => (table !== 'calendar_events' ? [] : [{
    id: 'ev1', title: 'Offsite', detail: null, location: 'Lisbon', starts_at: '2026-09-12T23:00:00Z', ends_at: '2026-09-15T16:00:00Z',
    all_day: false, kind: 'team', status: 'confirmed', project_id: null, company_id: null, contact_id: null, connection_id: null, created_by: 'e-me'
  }]));
  const [event] = await data.eventsOverlapping(WEEK);
  assert.deepEqual(queries.map(q => q.table), ['calendar_events']);
  const calls = queries[0].calls.map(call => call.join(' '));
  assert.ok(calls.includes('lt starts_at 2026-09-20T22:00:00.000Z'), 'starts before the week ends');
  assert.ok(calls.includes(OVERLAP), 'ends after the day before the week, or has no end and starts from then');
  assert.ok(calls.includes('neq status cancelled'));
  assert.ok(!calls.some(call => call.startsWith('gte starts_at')), 'nothing that began before the week is left out');
  const select = queries[0].calls.find(([method]) => method === 'select')[1].split(/,\s*/);
  for (const column of ['starts_at', 'ends_at', 'all_day', 'kind', 'status', 'company_id', 'connection_id', 'created_by']) {
    assert.ok(select.includes(column), `the query asks for ${column}`);
  }
  assert.ok(!select.includes('attendees'), 'who is invited is asked for by an event\'s page, not with every week');
  assert.equal(event.id, 'ev1');
  assert.equal(event.detail, 'Lisbon');
  assert.equal(event.row.created_by, 'e-me');
  assert.match(event.when, / · \d\d:\d\d$/, 'it says when, as a project\'s or a company\'s page lists it');
});

test('the week goes into the filter as timestamps, and a range that is not two of them asks for nothing', async () => {
  const { data, queries } = loadTables();
  await data.eventsOverlapping({ to: '2026-09-20T22:00:00Z', since: 'Sat, 12 Sep 2026 22:00:00 GMT' });
  const calls = queries[0].calls.map(call => call.join(' '));
  assert.ok(calls.includes('lt starts_at 2026-09-20T22:00:00.000Z'));
  assert.ok(calls.includes(OVERLAP));
  for (const range of [null, {}, { to: WEEK.to }, { to: WEEK.to, since: '2026-09-12",id.neq.x' }, { to: 'next week', since: WEEK.since }]) {
    const before = queries.length;
    assert.deepEqual([...await data.eventsOverlapping(range)], []);
    assert.equal(queries.length, before, `nothing is asked for ${JSON.stringify(range)}`);
  }
});

test('project meetings coming up arrive with everything their page shows, and when they are', async () => {
  const { data, queries } = loadTables(table => (table !== 'calendar_events' ? [] : [{
    id: 'pe1', title: 'Design review', detail: 'Bring the mockups', location: 'Studio',
    starts_at: '2026-10-02T09:00:00Z', ends_at: '2026-10-02T10:00:00Z', all_day: false, kind: 'client', status: 'confirmed',
    project_id: 'p1', company_id: null, contact_id: null, connection_id: null, created_by: 'u-sam'
  }]));
  const [meeting] = await data.upcomingProjectEvents();
  const select = queries[0].calls.find(([method]) => method === 'select')[1].split(/,\s*/);
  for (const column of ['detail', 'location', 'kind', 'status', 'company_id', 'contact_id', 'connection_id', 'created_by']) {
    assert.ok(select.includes(column), `asks for ${column}`);
  }
  assert.ok(!select.includes('attendees'), 'not who is invited, for up to 500 meetings every two minutes');
  assert.equal(meeting.detail, 'Bring the mockups');
  assert.equal(meeting.row.created_by, 'u-sam');
  assert.ok(meeting.when, 'the project page still says when');
});

test('a client\'s past meetings: before the day given, filed under the company, its projects or its people, the most recent first, one more asked for', async () => {
  const CO = 'b1000000-0000-4000-8000-000000000001';
  const P = 'a1000000-0000-4000-8000-000000000001';
  const C1 = 'c1000000-0000-4000-8000-000000000001';
  const plain = value => JSON.parse(JSON.stringify(value));
  const year = new Date().getFullYear();
  const rows = [
    { id: 'e3', title: 'Review', starts_at: `${year}-01-20T12:00:00Z`, ends_at: `${year}-01-20T13:00:00Z`, all_day: false, kind: 'client', status: 'confirmed' },
    { id: 'e2', title: 'Kickoff', starts_at: `${year}-01-10T12:00:00Z`, ends_at: null, all_day: false, kind: 'client', status: 'confirmed' },
    { id: 'e1', title: 'Pitch', starts_at: `${year - 1}-12-01T12:00:00Z`, ends_at: null, all_day: false, kind: 'client', status: 'confirmed' }
  ];
  const { data, queries } = loadTables(table => (table === 'calendar_events' ? rows : []));
  const result = await data.pastMeetings({ companyId: CO, projectIds: [P, 'x),id.gt.(0'], contactIds: [C1], before: `${year + 1}-01-01T00:00:00Z`, limit: 2 });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, 'calendar_events');
  const call = name => plain(queries[0].calls.find(([method]) => method === name));
  assert.deepEqual(call('or'), ['or', `company_id.eq.${CO},project_id.in.(${P}),contact_id.in.(${C1})`], 'only ids that are uuids go into the filter');
  assert.deepEqual(call('lt'), ['lt', 'starts_at', `${year + 1}-01-01T00:00:00.000Z`]);
  assert.deepEqual(call('neq'), ['neq', 'status', 'cancelled']);
  assert.deepEqual(call('order'), ['order', 'starts_at', { ascending: false }]);
  assert.deepEqual(call('limit'), ['limit', 3], 'one more than are shown, to know whether there are more');
  assert.match(call('select')[1], /connection_id, calendar_id, created_by/, 'the columns that say who may change one, and which calendar it is in (0057)');
  assert.doesNotMatch(call('select')[1], /attendees/, 'who is invited is asked for by the page of the one opened');
  assert.deepEqual(result.meetings.map(m => m.id), ['e3', 'e2']);
  assert.equal(result.more, true);

  const all = await loadTables(table => (table === 'calendar_events' ? rows : [])).data.pastMeetings({ companyId: CO, before: `${year + 1}-01-01T00:00:00Z` });
  assert.equal(all.more, false);
  assert.match(all.meetings.find(m => m.id === 'e1').when, new RegExp(`${year - 1}`), 'a meeting from another year says which');
  assert.doesNotMatch(all.meetings.find(m => m.id === 'e2').when, new RegExp(`${year}`), 'one from this year does not');

  const crafted = loadTables();
  await crafted.data.pastMeetings({ companyId: 'x,id.gt.0', contactIds: [C1], before: `${year}-09-15T00:00:00Z` });
  assert.deepEqual(plain(crafted.queries[0].calls.find(([method]) => method === 'or')), ['or', `contact_id.in.(${C1})`], 'a company id that is not a uuid is left out');

  const none = loadTables();
  assert.deepEqual(plain(await none.data.pastMeetings({ contactIds: ['contact-Olivia'], before: `${year}-09-15T00:00:00Z` })), { meetings: [], more: false }, 'no id that is a uuid, no request');
  assert.deepEqual(plain(await none.data.pastMeetings({ companyId: CO, before: 'not a day' })), { meetings: [], more: false }, 'no day, no request');
  assert.equal(none.queries.length, 0);
});

test('a client\'s past meetings ask by at most 50 projects and 50 people, say so when there were more, and break ties by id', async () => {
  const CO = 'b1000000-0000-4000-8000-000000000001';
  const id = n => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const plain = value => JSON.parse(JSON.stringify(value));
  const { data, queries } = loadTables(() => []);
  const result = await data.pastMeetings({
    companyId: CO,
    projectIds: Array.from({ length: 60 }, (_, i) => id(i)),
    contactIds: Array.from({ length: 55 }, (_, i) => id(100 + i)),
    before: '2026-09-15T00:00:00Z', limit: 500
  });
  const or = plain(queries[0].calls.find(([method]) => method === 'or'))[1];
  assert.equal(or.match(/project_id\.in\.\(([^)]*)\)/)[1].split(',').length, 50);
  assert.equal(or.match(/contact_id\.in\.\(([^)]*)\)/)[1].split(',').length, 50);
  assert.equal(result.capped, true, 'and says some were left out');
  assert.deepEqual(plain(queries[0].calls.filter(([method]) => method === 'order')),
    [['order', 'starts_at', { ascending: false }], ['order', 'id', { ascending: false }]]);
  assert.deepEqual(plain(queries[0].calls.find(([method]) => method === 'limit')), ['limit', 101], 'at most 100 shown, and one more asked for');
  const small = await loadTables(() => []).data.pastMeetings({ companyId: CO, projectIds: [id(1)], before: '2026-09-15T00:00:00Z' });
  assert.equal(small.capped, false);
});

test('who is invited to one event is asked for by its id — a uuid, and nothing else — and none is none', async () => {
  const EV = 'e9000000-0000-4000-8000-000000000001';
  const plain = value => JSON.parse(JSON.stringify(value));
  const people = [{ name: 'Dana Reyes', email: 'dana@northline.example', response: 'accepted' }];
  const { data, queries } = loadTables(table => (table === 'calendar_events' ? [{ id: EV, attendees: people }] : []));
  assert.deepEqual(plain(await data.eventInvitees(EV)), people);
  assert.deepEqual(plain(queries[0].calls.find(([method]) => method === 'select')), ['select', 'id, attendees']);
  assert.deepEqual(plain(queries[0].calls.find(([method]) => method === 'eq')), ['eq', 'id', EV]);
  assert.equal(await loadTables(() => []).data.eventInvitees(EV), null, 'no such event, or not this person\'s to see');
  const empty = loadTables(table => (table === 'calendar_events' ? [{ id: EV, attendees: null }] : []));
  assert.deepEqual(plain(await empty.data.eventInvitees(EV)), [], 'a column with nothing in it is nobody');
  const crafted = loadTables(() => []);
  assert.equal(await crafted.data.eventInvitees('x,id.gt.0'), null);
  assert.equal(crafted.queries.length, 0, 'what is not a uuid is not asked for');
});

test('one event is asked for by its id — a uuid, and nothing else — and none is none', async () => {
  const EV = 'e9000000-0000-4000-8000-000000000001';
  const plain = value => JSON.parse(JSON.stringify(value));
  const { data, queries } = loadTables(table => (table === 'calendar_events'
    ? [{ id: EV, title: 'Pitch', starts_at: '2026-08-01T10:00:00Z', ends_at: null, all_day: false, kind: 'client', status: 'confirmed' }] : []));
  const found = await data.event(EV);
  assert.equal(found.id, EV);
  assert.equal(found.title, 'Pitch');
  assert.deepEqual(plain(queries[0].calls.find(([method]) => method === 'eq')), ['eq', 'id', EV]);
  assert.match(queries[0].calls.find(([method]) => method === 'select')[1], /connection_id, calendar_id, created_by, organizer_name, organizer_email, meeting_url, time_zone, attendees/, 'every column its page reads');
  assert.match(queries[0].calls.find(([method]) => method === 'select')[1], /\bupdated_at\b/, 'and when it last changed, which an edit is made against');
  assert.equal(await loadTables(() => []).data.event(EV), null);
  const crafted = loadTables(() => []);
  assert.equal(await crafted.data.event('x,id.gt.0'), null);
  assert.equal(crafted.queries.length, 0, 'nothing is asked for an id that is not a uuid');
});

test('a note arrives with who wrote it by id, so whoever wrote it can be offered Edit', async () => {
  const { data, queries } = loadTables(table => (table === 'workspace_notes' ? [{
    id: 'n1', entity_type: 'project', entity_id: 'p1', body: 'Client wants blue', created_at: '2026-09-14T09:00:00Z',
    author_id: 'e-me', author: { full_name: 'Sam Rivera' }
  }] : []));
  const notes = await data.notes();
  assert.match(queries[0].calls.find(([method]) => method === 'select')[1], /\bauthor_id\b/);
  assert.equal(notes[0].authorId, 'e-me');
  assert.equal(notes[0].who, 'Sam Rivera');
});

test('a note whose author\'s row is gone is a former team member\'s, never the studio\'s', async () => {
  const { data } = loadTables(table => (table === 'workspace_notes' ? [
    { id: 'n1', entity_type: 'project', entity_id: 'p1', body: 'Kickoff went well', created_at: '2026-09-01T09:00:00Z', author_id: null, author: null }
  ] : []));
  const notes = await data.notes();
  assert.equal(notes[0].who, 'Former team member');
  assert.equal(notes[0].authorId, null);
  assert.doesNotMatch(notes.map(n => n.who).join(' '), /Veyago/);
});

/* ── Projects ─────────────────────────────────────────────────────────── */

test('projects order by sort_order, then by name and id so a reload never reshuffles them', async () => {
  const { data, queries } = loadTables(table => (table !== 'client_project_progress' ? [] : [
    { id: 'p1', name: 'Northline site' }, { id: 'p2', name: 'Kept · Autumn release' }
  ]));
  await data.projects();
  assert.deepEqual(queries[0].calls.filter(([method]) => method === 'order'),
    [['order', 'sort_order'], ['order', 'name'], ['order', 'id']],
    'sort_order is the same 0 for every project, so name then id is what actually settles the order');
});

test('archived projects are read past the view, which leaves them out, ordered newest-archived first', async () => {
  const plain = value => JSON.parse(JSON.stringify(value));
  const { data, queries } = loadTables(table => (table !== 'client_projects' ? [] : [
    { id: 'p1', name: 'Old brief', code: null, accent: 'default', status: 'cancelled', description: null,
      company_id: null, owner_id: null, due_on: null, deleted_at: '2026-08-01T09:00:00Z', company: null }
  ]));
  const [p] = await data.archivedProjects();
  assert.equal(p.id, 'p1');
  assert.equal(p.name, 'Old brief');
  assert.equal(p.archivedAt, '2026-08-01T09:00:00Z');
  assert.deepEqual(plain(queries[0].calls.filter(([method]) => method === 'not')), [['not', 'deleted_at', 'is', null]]);
  assert.deepEqual(plain(queries[0].calls.filter(([method]) => method === 'order')),
    [['order', 'deleted_at', { ascending: false }], ['order', 'id']]);
});

test('archived projects are named by their company, or "Internal product" with none', async () => {
  const { data } = loadTables(table => (table !== 'client_projects' ? [] : [
    { id: 'p1', name: 'Client work', code: null, accent: 'client', status: 'on_hold', description: null,
      company_id: 'co1', owner_id: null, due_on: null, deleted_at: '2026-08-01T09:00:00Z', company: { name: 'Northline' } },
    { id: 'p2', name: 'Side project', code: null, accent: 'default', status: 'discovery', description: null,
      company_id: null, owner_id: null, due_on: null, deleted_at: '2026-08-02T09:00:00Z', company: null }
  ]));
  const [client, internal] = await data.archivedProjects();
  assert.equal(client.client, 'Northline');
  assert.equal(internal.client, 'Internal product');
});

test('a project\'s own activity is asked for by its id, past the studio-wide feed\'s window, and shaped the same way', async () => {
  const plain = value => JSON.parse(JSON.stringify(value));
  const PROJECT = 'a1000000-0000-4000-8000-000000000001';
  const { data, queries } = loadTables(table => (table !== 'workspace_activity' ? [] : [{
    id: 'a1', verb: 'created', entity_type: 'task', entity_id: 't1', summary: 'New task · Draft copy',
    created_at: '2026-09-14T09:00:00Z', actor: { full_name: 'Sam Rivera' }
  }]));
  const [entry] = await data.projectActivity(PROJECT);
  assert.equal(entry.who, 'Sam Rivera');
  assert.equal(entry.text, 'New task · Draft copy');
  assert.deepEqual(plain(queries[0].calls.filter(([method]) => method === 'eq')), [['eq', 'project_id', PROJECT]]);
  assert.deepEqual(plain(queries[0].calls.find(([method]) => method === 'order')), ['order', 'created_at', { ascending: false }]);
});

test('a project\'s activity asks for nothing without a real id', async () => {
  const { data, queries } = loadTables(() => []);
  assert.deepEqual([...(await data.projectActivity('drop table projects;'))], []);
  assert.deepEqual([...(await data.projectActivity(''))], []);
  assert.equal(queries.length, 0);
});

test('every note loads, past the thousand rows the API hands back at once', async () => {
  let served = 0;
  const note = i => ({ id: `n${i}`, entity_type: 'project', entity_id: 'p1', body: `Note ${i}`, created_at: '2026-09-01T09:00:00Z', author_id: null, author: null });
  const { data, queries } = loadTables(table => {
    if (table !== 'workspace_notes') return [];
    served += 1;
    return served === 1 ? Array.from({ length: 1000 }, (_, i) => note(i)) : [note(1000)];
  });
  const list = await data.notes();
  assert.equal(list.length, 1001);
  assert.deepEqual(queries.map(q => q.calls.filter(([method]) => method === 'range').map(call => call.slice(1).join('-'))), [['0-999'], ['1000-1999']]);
  assert.ok(queries[0].calls.some(call => call.join(' ') === 'order id'), 'pages in a fixed order do not overlap');
});

test('a task arrives with its details, who made it, and when it was made and finished', async () => {
  const { data, queries } = loadTables(table => (table !== 'tasks' ? [] : [{
    id: 'task-1', project_id: 'p1', title: 'Wireframes', details: 'Home and checkout', status: 'done', priority: 'high',
    due_date: '2026-09-18', assignee_id: 'e-ana', created_by: 'u-sam', created_at: '2026-09-10T09:00:00Z',
    completed_at: '2026-09-14T15:00:00Z', assignee: { full_name: 'Ana Lima' }
  }]));
  const [one] = await data.projectTasks('p1');
  const [every] = await data.allProjectTasks();
  assert.equal(queries.length, 2);
  for (const query of queries) {
    const select = query.calls.find(([method]) => method === 'select')[1].split(/,\s*/);
    for (const column of ['details', 'created_by', 'created_at', 'completed_at', 'due_date', 'priority', 'assignee_id']) {
      assert.ok(select.includes(column), `the ${query.table} query asks for ${column}`);
    }
  }
  assert.equal(one.row.details, 'Home and checkout');
  assert.equal(every.row.completed_at, '2026-09-14T15:00:00Z');
  assert.equal(one.who, 'Ana Lima');
});

test('every project\'s tasks load, past the thousand rows the API hands back at once', async () => {
  let served = 0;
  const task = i => ({ id: `task-${i}`, project_id: 'p1', title: `Task ${i}`, status: 'todo' });
  const { data, queries } = loadTables(table => {
    if (table !== 'tasks') return [];
    served += 1;
    return served === 1 ? Array.from({ length: 1000 }, (_, i) => task(i)) : [task(1000)];
  });
  const every = await data.allProjectTasks();
  assert.equal(every.length, 1001);
  assert.deepEqual(queries.map(q => q.calls.filter(([method]) => method === 'range').map(call => call.slice(1).join('-'))), [['0-999'], ['1000-1999']]);
});

/* ── CRM ──────────────────────────────────────────────────────────────── */

test('every contact loads, past the thousand rows the API hands back at once, with their phone', async () => {
  let served = 0;
  const { data, queries } = loadTables(table => {
    if (table !== 'crm_contacts') return [];
    served += 1;
    return served === 1
      ? Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, full_name: `Person ${i}`, email: null, company: null }))
      : [{ id: 'c-last', full_name: 'Zoe Last', email: 'zoe@example.com', phone: '+1 555 0100', company: null }];
  });
  const list = await data.contacts();
  assert.equal(list.length, 1001);
  assert.equal(list[1000].row.phone, '+1 555 0100');
  assert.deepEqual(queries.map(q => q.calls.filter(([method]) => method === 'range').map(call => call.slice(1).join('-'))), [['0-999'], ['1000-1999']]);
  assert.ok(queries[0].calls.find(([method]) => method === 'select')[1].split(/,\s*/).includes('phone'));
  assert.ok(queries[0].calls.some(call => call.join(' ') === 'order id'), 'pages in a fixed order do not overlap');
});

test('a contact carries whether they are primary and which enquiry introduced them, on its raw row', async () => {
  const { data, queries } = loadTables(table => (table !== 'crm_contacts' ? [] : [{
    id: 'c1', full_name: 'Ana Lima', email: 'ana@northline.example', is_primary: true, enquiry_id: 'enq-1', company: null
  }]));
  const [ana] = await data.contacts();
  assert.equal(ana.row.is_primary, true);
  assert.equal(ana.row.enquiry_id, 'enq-1');
  const select = queries[0].calls.find(([method]) => method === 'select')[1];
  assert.ok(select.split(/,\s*/).includes('is_primary'));
  assert.ok(select.split(/,\s*/).includes('enquiry_id'));
});

test('a contact pushed into the next page while the list is read is listed once', async () => {
  let served = 0;
  const person = i => ({ id: `c${i}`, full_name: `Person ${i}`, email: null, company: null });
  const { data } = loadTables(table => {
    if (table !== 'crm_contacts') return [];
    served += 1;
    /* Someone added ahead of the second page moves the first page's last into it. */
    return served === 1 ? Array.from({ length: 1000 }, (_, i) => person(i)) : [person(999), person(1000)];
  });
  const list = await data.contacts();
  assert.equal(list.length, 1001);
  assert.equal(new Set(list.map(c => c.id)).size, 1001);
});

test('every company loads, past the thousand rows the API hands back at once, in a fixed order', async () => {
  let served = 0;
  const { data, queries } = loadTables(table => {
    if (table !== 'crm_companies') return [];
    served += 1;
    return served === 1
      ? Array.from({ length: 1000 }, (_, i) => ({ id: `co${i}`, name: `Company ${i}`, kind: 'client', stage: 'lead' }))
      : [{ id: 'co-last', name: 'Zeta', kind: 'client', stage: 'lead' }];
  });
  const list = await data.companies();
  assert.equal(list.length, 1001);
  assert.equal(list[1000].name, 'Zeta');
  assert.deepEqual(queries.map(q => q.calls.filter(([method]) => method === 'range').map(call => call.slice(1).join('-'))), [['0-999'], ['1000-1999']]);
  assert.ok(queries[0].calls.some(call => call.join(' ') === 'order id'), 'pages in a fixed order do not overlap');
});

test('a list of exactly a thousand asks once more, and stops at the empty page', async () => {
  let served = 0;
  const { data, queries } = loadTables(table => {
    if (table !== 'crm_companies') return [];
    served += 1;
    return served === 1 ? Array.from({ length: 1000 }, (_, i) => ({ id: `co${i}`, name: `Company ${i}`, kind: 'client', stage: 'lead' })) : [];
  });
  assert.equal((await data.companies()).length, 1000);
  assert.equal(queries.length, 2);
});

test('a company arrives with its owner', async () => {
  const { data, queries } = loadTables(table => (table !== 'crm_companies' ? [] : [{
    id: 'co1', name: 'Northline', domain: null, kind: 'client', stage: 'client', value: 1, currency: 'EUR', owner_id: 'e-sam', notes: null
  }]));
  const [co] = await data.companies();
  assert.ok(queries[0].calls.find(([method]) => method === 'select')[1].split(/,\s*/).includes('owner_id'));
  assert.equal(co.row.owner_id, 'e-sam');
});

test('a client carries its number; a company not yet one has none', async () => {
  const { data, queries } = loadTables(table => (table !== 'crm_companies' ? [] : [
    { id: 'co1', name: 'Northline', domain: null, kind: 'client', stage: 'client', value: 1, currency: 'EUR', owner_id: null, notes: null, client_number: 42 },
    { id: 'co2', name: 'Harbor & Co', domain: null, kind: 'client', stage: 'lead', value: 0, currency: 'USD', owner_id: null, notes: null, client_number: null }
  ]));
  const [client, lead] = await data.companies();
  assert.ok(queries[0].calls.find(([method]) => method === 'select')[1].split(/,\s*/).includes('client_number'));
  assert.equal(client.clientNumber, 42);
  assert.equal(lead.clientNumber, null);
});

test('enquiries arrive newest first, with what the promote button and the list need', async () => {
  const { data, queries } = loadTables(table => (table !== 'website_enquiries' ? [] : [{
    id: 'enq-1', kind: 'website', name: 'Bo Ahn', email: 'bo@example.com', business: 'Ahn Studio',
    website: null, message: 'Looking for a rebuild.', status: 'new', created_at: '2026-09-10T09:00:00Z'
  }]));
  const [enquiry] = await data.enquiries();
  assert.equal(enquiry.id, 'enq-1');
  assert.equal(enquiry.name, 'Bo Ahn');
  assert.equal(enquiry.business, 'Ahn Studio');
  assert.equal(enquiry.status, 'New');
  assert.equal(enquiry.row.email, 'bo@example.com');
  const order = queries[0].calls.find(([method]) => method === 'order');
  assert.equal(order[1], 'created_at');
  assert.equal(order[2].ascending, false, 'newest first');
});

test('a blank enquiry field reads as empty text, never null in the page', async () => {
  const { data } = loadTables(table => (table !== 'website_enquiries' ? [] : [{
    id: 'enq-2', kind: 'product', name: 'Cy Ide', email: 'cy@example.com', business: null,
    website: null, message: null, status: 'spam', created_at: '2026-09-11T09:00:00Z'
  }]));
  const [enquiry] = await data.enquiries();
  assert.equal(enquiry.business, '');
  assert.equal(enquiry.message, '');
  assert.equal(enquiry.status, 'Spam');
});

/* ── Finance ──────────────────────────────────────────────────────────── */

test('an invoice arrives with when it last changed, its tax and its lines, oldest line first', async () => {
  const { data, queries } = loadTables(table => (table !== 'finance_invoices' ? [] : [{
    id: 'inv-1', number: 'INV-1042', client: 'Northline', amount: 1200, currency: 'USD', status: 'sent',
    updated_at: '2026-09-10T12:00:00Z', tax_rate: 8.875, tax_amount: 106.5,
    finance_invoice_lines: [
      { id: 'line-2', description: 'Development', quantity: 10, unit_amount: 100, amount: 1000, sort_order: 1 },
      { id: 'line-1', description: 'Design', quantity: 2, unit_amount: 100, amount: 200, sort_order: 0 }
    ]
  }]));
  const [invoice] = await data.invoices();
  assert.equal(invoice.row.updated_at, '2026-09-10T12:00:00Z');
  assert.equal(invoice.row.tax_rate, 8.875);
  assert.equal(invoice.row.tax_amount, 106.5);
  assert.equal(invoice.row.finance_invoice_lines.length, 2, 'the row carries the lines exactly as fetched');
  const select = queries[0].calls.find(([method]) => method === 'select')[1];
  ['updated_at', 'tax_rate', 'tax_amount'].forEach(column =>
    assert.ok(select.includes(column), `${column} is asked for`));
  assert.ok(select.includes('finance_invoice_lines'), 'the lines are embedded, not fetched separately');
  assert.ok(queries[0].calls.some(call => call[0] === 'order' && call[1] === 'sort_order'
    && call[2] && call[2].foreignTable === 'finance_invoice_lines' && call[2].ascending === true),
    'lines come back in the order the invoice lists them, not however finance_invoice_lines happens to be stored');
});

test('every invoice loads, past the thousand rows the API hands back at once', async () => {
  let served = 0;
  const invoice = i => ({ id: `inv${i}`, number: `INV-${i}`, client: 'Northline', amount: 100, currency: 'USD', status: 'sent' });
  const { data, queries } = loadTables(table => {
    if (table !== 'finance_invoices') return [];
    served += 1;
    return served === 1 ? Array.from({ length: 1000 }, (_, i) => invoice(i)) : [invoice(1000)];
  });
  const list = await data.invoices();
  assert.equal(list.length, 1001);
  assert.deepEqual(queries.map(q => q.calls.filter(([method]) => method === 'range').map(call => call.slice(1).join('-'))), [['0-999'], ['1000-1999']]);
  assert.ok(queries[0].calls.some(call => call.join(' ') === 'order id'), 'pages in a fixed order do not overlap');
});

test('an invoice with no lines yet — every one made before 0060 has at least one, but a test row need not — is not asked to have any', async () => {
  const { data } = loadTables(table => (table !== 'finance_invoices' ? [] : [{
    id: 'inv-2', number: 'INV-1043', client: 'Acme', amount: 500, currency: 'USD', status: 'draft',
    updated_at: null, tax_rate: null, tax_amount: null, finance_invoice_lines: []
  }]));
  const [invoice] = await data.invoices();
  assert.deepEqual(invoice.row.finance_invoice_lines, []);
  assert.equal(invoice.row.tax_rate, null);
});

test('every transaction in the window loads, past the thousand rows the API hands back at once, in a fixed order', async () => {
  let served = 0;
  const { data, queries } = loadTables(table => {
    if (table !== 'finance_transactions') return [];
    served += 1;
    return served === 1
      ? Array.from({ length: 1000 }, (_, i) => ({ id: `tx${i}`, posted_at: '2026-09-01', amount: 10, currency: 'USD' }))
      : [{ id: 'tx-last', posted_at: '2026-08-01', amount: -5, currency: 'USD' }];
  });
  const rows = await data.transactions('2026-01-01');
  assert.equal(rows.length, 1001);
  assert.equal(rows[1000].id, 'tx-last');
  assert.deepEqual(queries.map(q => q.calls.filter(([method]) => method === 'range').map(call => call.slice(1).join('-'))), [['0-999'], ['1000-1999']]);
  assert.ok(queries[0].calls.some(call => call.join(' ') === 'gte posted_at 2026-01-01'), 'the window given is the one asked for');
  assert.ok(queries[0].calls.some(call => call[0] === 'order' && call[1] === 'id'), 'pages in a fixed order do not overlap');
});

test('with no window given, transactions default to the last 180 days', async () => {
  const { data, queries } = loadTables(() => []);
  await data.transactions();
  const since = queries[0].calls.find(([method]) => method === 'gte')[2];
  const expected = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  assert.equal(since, expected);
});

/* ── Company ──────────────────────────────────────────────────────────── */

test('the team is ordered by name, not by the spelling of the role, and carries what a person\'s page needs', async () => {
  const { data, queries } = loadTables(table => (table !== 'employees' ? [] : [{
    id: 'e1', user_id: 'u1', full_name: 'Ana Lima', email: 'ana@veyago.cloud', role: 'owner',
    title: null, status: 'active', start_date: '2026-01-05', created_at: '2026-01-05T09:00:00Z', updated_at: '2026-01-05T09:00:00Z'
  }]));
  const [member] = await data.team();
  const select = queries[0].calls.find(([method]) => method === 'select')[1].split(/,\s*/).map(s => s.trim());
  for (const column of ['user_id', 'email', 'start_date', 'created_at', 'updated_at']) {
    assert.ok(select.includes(column), `the query asks for ${column}`);
  }
  assert.ok(!select.includes('phone') && !select.includes('notes'), 'phone and notes stay behind employee_private()');
  assert.deepEqual(queries[0].calls.filter(([method]) => method === 'order'), [['order', 'full_name'], ['order', 'id']]);
  assert.equal(member.row.user_id, 'u1', 'the row travels whole, for companyModel to read');
  assert.equal(member.name, 'Ana Lima');
});

test('a person\'s phone and notes are asked for by their id, and nobody such is null', async () => {
  const q = load((name, args) => (name === 'employee_private' && args.p_employee_id === 'e1'
    ? { data: [{ phone: '+1 555 0100', notes: 'Founder' }], error: null }
    : { data: [], error: null }));
  assert.deepEqual(await q.data.employeePrivate('e1'), { phone: '+1 555 0100', notes: 'Founder' });
  assert.equal(await q.data.employeePrivate('gone'), null);
});

test('the studio\'s profile comes from studio_profile(), empty for anyone it does not answer', async () => {
  const q = load(() => ({ data: [{ key: 'studio_name', value: 'Northline' }, { key: 'base_currency', value: 'eur' }], error: null }));
  const rows = await q.data.studioProfile();
  assert.equal(q.calls[0].name, 'studio_profile');
  assert.deepEqual(rows.map(r => r.key), ['studio_name', 'base_currency']);

  const empty = load(() => ({ data: [], error: null }));
  assert.deepEqual(await empty.data.studioProfile(), []);
});

/* ── Notifications ────────────────────────────────────────────────────── */

test('dismissed notifications come back as their bare keys, RLS already limiting them to this person\'s own', async () => {
  const { data, queries } = loadTables(table => (table === 'notification_dismissals'
    ? [{ notif_key: 'ticket:t1' }, { notif_key: 'events:today' }] : []));
  assert.deepEqual(await data.notificationDismissals(), ['ticket:t1', 'events:today']);
  assert.deepEqual(queries[0].calls.find(([method]) => method === 'select'), ['select', 'notif_key']);
});

test('an amount is written in its currency, and a code Intl cannot format goes beside it rather than throwing', () => {
  const { data } = load(() => ({ data: null, error: null }));
  assert.equal(data.money(1200, 'eur'), '€1,200');
  assert.equal(data.money(1200, ''), '$1,200', 'a blank is the database default, USD');
  assert.equal(data.money(1200, null), '$1,200');
  assert.equal(data.money(1200, 'US$'), '1,200 US$', 'this used to be a RangeError that blanked the Overview');
  assert.equal(data.money(1200, 'EURO'), '1,200 EURO');
  assert.equal(data.money(62480, 'USD', { compact: true }), '$62K');
  assert.equal(data.money(null, 'USD'), null, 'no amount is not zero');
  assert.equal(data.currencyCode(' gbp '), 'GBP');
  assert.equal(data.currencyCode('US$'), null);
});
