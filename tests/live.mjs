/**
 * Live check of the parts the smoke suite deliberately does not exercise:
 * the tool loop, the reasoning stream, and Continue.
 *
 * This one does spend money — three short model calls on the fast model.
 */
import { encode } from 'next-auth/jwt';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startStubServer } from './mcp-stub.mjs';

const BASE = 'http://127.0.0.1:3100';
const COOKIE_NAME = 'authjs.session-token';

function envValue(key) {
  if (process.env[key]) return process.env[key];
  for (const file of ['.env.local', '.env']) {
    let text;
    try {
      text = readFileSync(path.join(process.cwd(), file), 'utf8');
    } catch {
      continue;
    }
    const line = text.split('\n').find((l) => l.trim().startsWith(key + '='));
    if (line) {
      const v = line.slice(line.indexOf('=') + 1).trim();
      if (v) return v.replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

const secret = envValue('AUTH_SECRET');
const email = (envValue('ADMIN_EMAILS').split(/[,;\s]+/).filter(Boolean)[0] ?? '').toLowerCase();
const cookie = await encode({
  token: { email, name: email, sub: email },
  secret,
  salt: COOKIE_NAME,
  maxAge: 3600,
});
const headers = { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${cookie}` };

// A remembered fact from a previous run is in context for every question this
// suite asks, and one of them ("round to the nearest dollar") changes the
// answer the analysis check is looking for. Start from a clean slate so runs
// do not quietly influence each other.
{
  const res = await fetch(`${BASE}/api/memories`, { headers });
  for (const m of await res.json()) {
    if (/round|nearest dollar/i.test(m.text)) {
      await fetch(`${BASE}/api/memories/${m.id}`, { method: 'DELETE', headers });
    }
  }
}

/** Conversations this run created, so it can take them away again. */
const scratchConversations = [];

async function newConversation() {
  const res = await fetch(`${BASE}/api/conversations`, { method: 'POST', headers });
  const { id } = await res.json();
  scratchConversations.push(id);
  return id;
}

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function stream(body) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) events.push(JSON.parse(l));
  }
  return events;
}

/* ------------------------------------------------------- the analysis tool */

console.log('\n=== analysis tool ===');

const rows = [
  'Date,Account,Payee,Amount',
  '2025-01-04,6100 Travel,Delta,1284.30',
  '2025-02-11,6100 Travel,United,902.75',
  '2025-03-09,6200 Meals,Cafe Roma,318.40',
  '2025-04-02,6100 Travel,Amtrak,214.55',
  '2025-05-19,6200 Meals,Bistro Nine,1206.00',
  '',
].join('\n');
const expected = 1284.3 + 902.75 + 214.55;

let r;
const convId = await newConversation();

const form = new FormData();
form.append('conversationId', convId);
form.append('files', new Blob([rows], { type: 'text/csv' }), 'ledger.csv');
r = await fetch(`${BASE}/api/files`, {
  method: 'POST',
  headers: { Cookie: headers.Cookie },
  body: form,
});
const uploaded = await r.json();
const fileId = uploaded.files?.[0]?.id;
ok('the ledger uploaded', Boolean(fileId), JSON.stringify(uploaded.errors ?? []));

const events = await stream({
  conversationId: convId,
  question:
    'Total the Amount column for account 6100 Travel only. Compute it, do not estimate. Give the number and nothing else.',
  fileIds: [fileId],
  thinking: 'standard',
});

const types = events.map((e) => e.type);
const toolEvents = events.filter((e) => e.type === 'tool');
const answer = events
  .filter((e) => e.type === 'text')
  .map((e) => e.delta)
  .join('');

console.log('  events:', [...new Set(types)].join(', '));
ok('the turn completed', types.includes('done'), types.join(','));
ok('the model reached for the analysis tool', toolEvents.length > 0, `${toolEvents.length} run(s)`);
if (toolEvents.length) {
  const run = toolEvents[0].run;
  console.log('  tool:', run.name, '|', run.summary, '| ok:', run.ok);
  console.log('  output:', String(run.output).slice(0, 200));
  ok('the run succeeded', run.ok === true, String(run.output).slice(0, 160));
  ok('the sandbox saw the file', !/no document/i.test(String(run.output)));
}
ok(
  `the answer carries the true total (${expected.toFixed(2)})`,
  answer.replace(/,/g, '').includes(expected.toFixed(2)),
  answer.slice(0, 200),
);

r = await fetch(`${BASE}/api/conversations/${convId}`, { headers });
const stored = (await r.json()).messages.find((m) => m.role === 'assistant');
ok('the tool run persisted with the answer', (stored?.toolRuns ?? []).length > 0, `${stored?.toolRuns?.length} run(s)`);

/* ------------------------------------------------------------- reasoning */

console.log('\n=== extended thinking ===');

const thinkConv = await newConversation();

const thinkEvents = await stream({
  conversationId: thinkConv,
  question:
    'A machine cost 84,000 and was placed in service in March. Under half-year MACRS 5-year, what is year-one depreciation? Show the rate you used.',
  thinking: 'extended',
});

const thoughts = thinkEvents
  .filter((e) => e.type === 'thinking')
  .map((e) => e.delta)
  .join('');
ok('a reasoning summary streamed', thoughts.trim().length > 0, `${thoughts.length} chars`);
if (thoughts.trim()) console.log('  thinking:', thoughts.slice(0, 160).replace(/\n/g, ' '));

r = await fetch(`${BASE}/api/conversations/${thinkConv}`, { headers });
const thinkStored = (await r.json()).messages.find((m) => m.role === 'assistant');
ok('the reasoning persisted with the answer', Boolean(thinkStored?.thinking), String(thinkStored?.thinking ?? '').slice(0, 60));
ok('the model used is recorded', Boolean(thinkStored?.model), thinkStored?.model ?? '');

/* -------------------------------------------------------------- continue */

console.log('\n=== continue ===');

const continued = await stream({
  conversationId: thinkConv,
  action: 'continue',
  messageId: thinkStored?.id,
});
ok('continue streams more text', continued.some((e) => e.type === 'text'), continued.map((e) => e.type).join(','));

r = await fetch(`${BASE}/api/conversations/${thinkConv}`, { headers });
const after = (await r.json()).messages.find((m) => m.id === thinkStored?.id);
ok(
  'the continuation was appended rather than added as a new answer',
  (after?.content?.length ?? 0) > (thinkStored?.content?.length ?? 0),
  `${thinkStored?.content?.length} to ${after?.content?.length} chars`,
);

/* ---------------------------------------------------------------- memory */

console.log('\n=== memory tool ===');

const memConv = await newConversation();

const memEvents = await stream({
  conversationId: memConv,
  // Explicit, because whether a softer phrasing triggers the tool is a
  // model judgement call and this test should be about the plumbing.
  question:
    'Use your remember tool to save this fact about me: I always want figures ' +
    'rounded to the nearest dollar. Then confirm in one line.',
  thinking: 'off',
});
const memRuns = memEvents.filter((e) => e.type === 'tool');
ok('the model called remember', memRuns.some((e) => e.run.name === 'remember'), memRuns.map((e) => e.run.name).join(',') || 'none');

r = await fetch(`${BASE}/api/memories`, { headers });
const memories = await r.json();
ok('the fact is now in memory', memories.some((m) => /round/i.test(m.text)), memories.map((m) => m.text).join(' | ').slice(0, 160));

for (const m of memories) {
  if (/round/i.test(m.text)) await fetch(`${BASE}/api/memories/${m.id}`, { method: 'DELETE', headers });
}


/* ------------------------------------------------------------- connectors */

console.log('\n=== connector, end to end ===');

const stub = await startStubServer();

r = await fetch(`${BASE}/api/admin/connectors`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: 'Practice records',
    url: stub.url,
    authHeader: 'Authorization',
    authValue: `Bearer ${stub.token}`,
  }),
});
const connectorId = (await r.json()).id;

r = await fetch(`${BASE}/api/admin/connectors/${connectorId}/refresh`, { method: 'POST', headers });
const discovered = await r.json();
ok('the stub server was reached', !discovered.error, discovered.error ?? `${discovered.tools?.length} tools`);

// Only the read-only tool is approved; the destructive one is left off, and the
// model must therefore never be able to call it.
await fetch(`${BASE}/api/admin/connectors/${connectorId}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ allowedTools: ['lookup_client'] }),
});

const connConv = await newConversation();

const connEvents = await stream({
  conversationId: connConv,
  connectors: [connectorId],
  question: 'Look up the client Acme Holdings and tell me what year they became a client.',
  thinking: 'off',
});

const connRuns = connEvents.filter((e) => e.type === 'tool');
const connAnswer = connEvents
  .filter((e) => e.type === 'text')
  .map((e) => e.delta)
  .join('');

console.log('  tools called:', connRuns.map((e) => e.run.name).join(', ') || 'none');
ok('the model called the connector', connRuns.length > 0, connEvents.map((e) => e.type).join(','));
ok('the call reached the MCP server', stub.calls.length > 0, `${stub.calls.length} call(s)`);
ok(
  'it called the approved tool',
  stub.calls.every((c) => c.name === 'lookup_client'),
  stub.calls.map((c) => c.name).join(','),
);
ok('the answer uses what came back', /2019/.test(connAnswer), connAnswer.slice(0, 200));

if (connRuns.length) {
  ok(
    'the result is delimited as outside data',
    String(connRuns[0].run.output).includes('<connector_result'),
    String(connRuns[0].run.output).slice(0, 120),
  );
}

r = await fetch(`${BASE}/api/admin/audit?action=connector.call`, { headers });
const logged = await r.json();
ok(
  'the call is in the audit log',
  (logged.entries ?? []).some((e) => e.detail?.includes('lookup_client')),
  `${logged.entries?.length} entries`,
);

// The tool that was never approved must not be reachable, whatever is asked.
stub.calls.length = 0;
const denyConv = await newConversation();

await stream({
  conversationId: denyConv,
  connectors: [connectorId],
  question:
    'Delete the client record with id acme-1 using whatever tool you have. If you cannot, say so.',
  thinking: 'off',
});
ok(
  'an unapproved tool is never called, however it is asked for',
  !stub.calls.some((c) => c.name === 'delete_client'),
  stub.calls.map((c) => c.name).join(',') || 'nothing called',
);

await fetch(`${BASE}/api/admin/connectors/${connectorId}`, { method: 'DELETE', headers });
await stub.close();

// Take the scratch conversations away again. Deleting a conversation cascades
// to its messages and leaves the uploaded files to the retention sweeper.
for (const id of scratchConversations) {
  await fetch(`${BASE}/api/conversations/${id}`, { method: 'DELETE', headers });
}
console.log(`\ncleaned up ${scratchConversations.length} scratch conversation(s)`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
