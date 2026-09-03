/**
 * End-to-end smoke test.
 *
 *   1. Stop the server and delete data/ so a fresh install is exercised
 *   2. npm run build && npm start
 *   3. npm test
 *
 * It asserts against a real HTTP server, so it catches route wiring, cookie
 * handling and access-control mistakes a unit test would miss.
 *
 * Google's OAuth redirect cannot be driven headlessly, so instead of adding a
 * test-only backdoor to the app, this mints genuine NextAuth session cookies
 * with AUTH_SECRET — the same cookies the browser would receive. The allowlist
 * still applies: the user row has to exist and be active, which is exactly the
 * behaviour under test.
 *
 * It does not call the OpenAI API — that costs money.
 */
import { encode } from 'next-auth/jwt';
import postgres from 'postgres';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { startStubServer } from './mcp-stub.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const DATABASE_URL = envValue('DATABASE_URL');
const COOKIE_NAME = 'authjs.session-token';

/** Reads a key out of .env / .env.local, real environment first. */
function envValue(key) {
  if (process.env[key]) return process.env[key];
  for (const file of ['.env.local', '.env']) {
    let text;
    try {
      text = readFileSync(path.join(process.cwd(), file), 'utf8');
    } catch {
      continue;
    }
    const line = text
      .split(String.fromCharCode(10))
      .find((l) => l.trim().startsWith(key + '='));
    if (line) {
      const value = line.slice(line.indexOf('=') + 1).trim();
      if (value) return value;
    }
  }
  return '';
}

function authSecret() {
  const value = envValue('AUTH_SECRET');
  if (!value) throw new Error('AUTH_SECRET is missing from .env');
  return value;
}

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

async function makeFixtures() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trc-fixtures-'));

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [
    ['Form 1120-S  U.S. Income Tax Return for an S Corporation', 'Tax year 2024',
     'Acme Holdings Inc.', '7 Compensation of officers .......... 24,000'],
    ['Schedule K  Shareholders Pro Rata Share Items',
     '1 Ordinary business income .......... 210,000', '16d Distributions .......... 186,000'],
    ['Schedule L  Balance Sheets per Books', 'Total assets .......... 512,400'],
  ];
  for (const lines of pages) {
    const page = pdf.addPage([612, 792]);
    lines.forEach((line, i) =>
      page.drawText(line, { x: 50, y: 720 - i * 26, size: i === 0 ? 13 : 11, font }));
  }
  writeFileSync(path.join(dir, 'sample-1120s.pdf'), await pdf.save());

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Depreciation');
  ws.addRow(['Asset', 'Cost', 'Prior Dep', 'Current Dep']);
  [['Vehicle', 42000, 12000, 8400], ['Equipment', 18500, 5200, 3700],
   ['Furniture', 9200, 2100, 1840]].forEach((r) => ws.addRow(r));
  ws.getCell('B5').value = { formula: 'SUM(B2:B4)', result: 69700 };
  // Deliberately broken fill pattern: the render must keep this visible.
  ws.getCell('D5').value = { formula: 'SUM(D2:D3)', result: 12100 };
  await wb.xlsx.writeFile(path.join(dir, 'workpaper.xlsx'));

  const csvLines = ['Date,Account,Payee,Amount', '2024-03-14,6100 Travel,Delta,1284.30', ''];
  writeFileSync(path.join(dir, 'gl-export.csv'), csvLines.join(String.fromCharCode(10)));
  // MZ header: sniffing must reject this on magic bytes, not on the extension.
  writeFileSync(path.join(dir, 'blocked.exe'), Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]));

  return dir;
}

/** A cookie jar holding one identity. */
function jar(cookieValue) {
  const store = new Map();
  if (cookieValue) store.set(COOKIE_NAME, cookieValue);
  return {
    header: () => [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (v === '' || raw.includes('Max-Age=0')) store.delete(k);
        else store.set(k, v);
      }
    },
  };
}

async function call(j, method, url, body, isForm = false) {
  const headers = j.header() ? { Cookie: j.header() } : {};
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  j.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html or binary */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const FIXTURES = await makeFixtures();
const SECRET = authSecret();

// With DISABLE_AUTH on, every request is an admin and the whole access-control
// half of this suite would report false passes. Refuse rather than mislead.
{
  const envText = readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  if (/^\s*DISABLE_AUTH\s*=\s*true/m.test(envText)) {
    console.error(
      [
        '',
        '  DISABLE_AUTH=true is set in .env.',
        '  Auth is bypassed, so the access-control checks cannot mean anything.',
        '  Set DISABLE_AUTH=false, restart the server, then run the tests again.',
        '',
      ].join(String.fromCharCode(10)),
    );
    process.exit(2);
  }
}

/* ─────────────────────── unauthenticated surface ─────────────────────── */

console.log('\n=== sign-in surface ===');
const anon = jar();

let r = await call(anon, 'GET', '/');
ok('/ redirects a signed-out visitor to /login', [302, 307].includes(r.status) && (r.headers.get('location') ?? '').includes('/login'), `HTTP ${r.status}`);

r = await call(anon, 'GET', '/login');
ok('login page renders', r.status === 200);
ok('login page offers Google sign-in', /Continue with Google|not set up yet/.test(r.text));

r = await call(anon, 'GET', '/api/auth/providers');
ok('NextAuth exposes the google provider', r.json?.google?.id === 'google', Object.keys(r.json ?? {}).join(','));

console.log('\n=== password-era endpoints are gone ===');
for (const [url, method] of [['/api/auth/login', 'POST'], ['/api/auth/logout', 'POST'], ['/api/setup', 'GET'], ['/api/auth/mfa/setup', 'GET']]) {
  r = await call(anon, method, url, method === 'POST' ? {} : undefined);
  // /api/auth/* now falls through to the NextAuth catch-all, which answers 400
  // for an unknown action; what matters is that none of them still work.
  ok(`${method} ${url} no longer works`, r.status >= 400, `HTTP ${r.status}`);
}

console.log('\n=== every protected route refuses an anonymous caller ===');
for (const [method, url] of [
  ['GET', '/api/me'],
  ['GET', '/api/conversations'],
  ['POST', '/api/conversations'],
  ['POST', '/api/files'],
  ['POST', '/api/chat'],
  ['GET', '/api/admin/prompt'],
  ['GET', '/api/admin/costs'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/retention'],
]) {
  r = await call(anon, method, url, method === 'POST' ? {} : undefined);
  ok(`${method} ${url} → 401`, r.status === 401, `HTTP ${r.status}`);
}

/* ───────────────────────── seed identities ───────────────────────────── */

// The schema exists by now because /login queried it.
if (!DATABASE_URL) {
  console.error(String.fromCharCode(10) + '  DATABASE_URL is not set — the suite needs the same Postgres the app uses.');
  process.exit(2);
}
const db = postgres(DATABASE_URL, { prepare: false, max: 2 });

// Postgres persists between runs, unlike the file database this suite was
// written against. Clear the accounts it creates first, or the second run
// reports false failures ("already exists", "401") that say nothing about the
// code. Cascades remove their conversations, files and usage rows.
await db`DELETE FROM users WHERE email IN (
  'admin@usaindiacfo.com',
  'rev@usaindiacfo.com',
  'admin2@usaindiacfo.com',
  'listed-as-member@usaindiacfo.com',
  'preview@localhost'
) OR email LIKE '%@example.test'`;
// House instructions live in settings, which no cascade touches.
await db`DELETE FROM settings WHERE key = 'system_prompt'`;
const cols = (
  await db`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
).map((c) => c.column_name);
ok('users table has no password column', !cols.includes('password_hash'), cols.join(','));

const adminId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const admin2Id = crypto.randomUUID();
const seed = (id, email, role, name) =>
  db`INSERT INTO users (id, email, role, display_name, is_active, created_at)
     VALUES (${id}, ${email}, ${role}, ${name}, 1, ${Date.now()})
     ON CONFLICT (email) DO NOTHING`;
await seed(adminId, 'admin@usaindiacfo.com', 'admin', 'Test Admin');
await seed(memberId, 'rev@usaindiacfo.com', 'member', 'Test Member');

const cookieFor = async (email) =>
  encode({ token: { email, name: email, sub: email }, secret: SECRET, salt: COOKIE_NAME, maxAge: 3600 });

const admin = jar(await cookieFor('admin@usaindiacfo.com'));
const member = jar(await cookieFor('rev@usaindiacfo.com'));
const stranger = jar(await cookieFor('nobody@gmail.com'));

console.log('\n=== identity is not authorisation ===');
r = await call(admin, 'GET', '/api/me');
ok('an allowlisted admin is recognised', r.json?.role === 'admin' && r.json?.email === 'admin@usaindiacfo.com', `HTTP ${r.status}`);
ok('provider reported', r.json?.provider === 'openai', `${r.json?.provider} / ${r.json?.model}`);
ok('pii tokenisation on by default', r.json?.piiMode === 'tokenize');

r = await call(stranger, 'GET', '/api/me');
ok('a valid Google session for an un-invited address is refused', r.status === 401, `HTTP ${r.status}`);

r = await call(member, 'GET', '/api/me');
ok('an allowlisted member is recognised', r.json?.role === 'member');

console.log(String.fromCharCode(10) + '=== ADMIN_EMAILS grants admin without an invitation ===');
{
  const adminLine =
    readFileSync(path.join(process.cwd(), '.env'), 'utf8')
      .split(String.fromCharCode(10))
      .find((l) => l.trim().startsWith('ADMIN_EMAILS=')) ?? '';
  const configured = adminLine
    .split('=')
    .slice(1)
    .join('=')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));

  ok('at least one admin is configured', configured.length > 0, configured.join(', ') || 'none');

  if (configured.length) {
    // No user row exists for this address; the configured list alone must let
    // it in, as an admin.
    const listedJar = jar(await cookieFor(configured[0]));
    r = await call(listedJar, 'GET', '/api/me');
    ok('a listed address signs in with no prior invitation', r.json?.role === 'admin',
       `${r.status} / ${r.json?.role} / ${r.json?.email}`);

    // And a member added to the list is promoted rather than left as-is.
    const demoteId = crypto.randomUUID();
    await db`INSERT INTO users (id, email, role, display_name, is_active, created_at)
             VALUES (${demoteId}, 'listed-as-member@usaindiacfo.com', 'member', 'Listed', 1, ${Date.now()})
             ON CONFLICT (email) DO NOTHING`;

    // Not in ADMIN_EMAILS, so it should stay a member.
    const stillMember = jar(await cookieFor('listed-as-member@usaindiacfo.com'));
    r = await call(stillMember, 'GET', '/api/me');
    ok('an address absent from the list is not promoted', r.json?.role === 'member', r.json?.role);
  }
}

/* ────────────────────── house instructions ───────────────────── */

console.log('\n=== house instructions ===');
// These are firm-wide and live in the same settings row the real app reads, so
// the original has to go back afterwards. Leaving the test string behind would
// silently change how the assistant answers for everybody.
r = await call(admin, 'GET', '/api/admin/prompt');
const housePromptBefore = r.json?.customPrompt ?? '';

r = await call(admin, 'POST', '/api/admin/prompt', { customPrompt: 'Always answer in British English.' });
ok('instructions saved', r.status === 200, `HTTP ${r.status}`);

r = await call(admin, 'GET', '/api/admin/prompt');
ok('instructions read back', r.json?.customPrompt === 'Always answer in British English.', r.json?.customPrompt);
ok('the built-in rules are shown too', typeof r.json?.basePrompt === 'string' && r.json.basePrompt.length > 100);
ok('a token estimate is reported', r.json?.tokenEstimate > 0, `${r.json?.tokenEstimate} tok`);

await call(admin, 'POST', '/api/admin/prompt', { customPrompt: housePromptBefore });
r = await call(admin, 'GET', '/api/admin/prompt');
ok('the house instructions are put back afterwards', r.json?.customPrompt === housePromptBefore, r.json?.customPrompt);

/* ──────────────────────────── uploads ───────────────────────────────── */

console.log('\n=== uploads ===');
r = await call(admin, 'POST', '/api/conversations');
const convId = r.json?.id;
ok('conversation created', Boolean(convId));

let form = new FormData();
form.set('conversationId', convId);
for (const name of ['sample-1120s.pdf', 'workpaper.xlsx', 'gl-export.csv', 'blocked.exe']) {
  form.append('files', new Blob([readFileSync(path.join(FIXTURES, name))]), name);
}
r = await call(admin, 'POST', '/api/files', form, true);
const files = r.json?.files ?? [];
const errors = r.json?.errors ?? [];
ok('pdf accepted with page count', files.find((f) => f.kind === 'pdf')?.pageCount === 3);
ok('xlsx accepted', files.some((f) => f.kind === 'xlsx'));
ok('csv accepted', files.some((f) => f.kind === 'text'));
ok('.exe rejected by magic bytes', errors.some((e) => e.filename === 'blocked.exe'), errors[0]?.error?.slice(0, 55));

form = new FormData();
form.set('conversationId', convId);
form.append('files', new Blob([readFileSync(path.join(FIXTURES, 'sample-1120s.pdf'))]), 'sample-1120s.pdf');
r = await call(admin, 'POST', '/api/files', form, true);
ok('duplicate upload deduped', r.json?.files?.[0]?.deduped === true);

console.log('\n=== upload guards ===');
form = new FormData();
form.set('conversationId', convId);
for (let i = 0; i < 21; i++) form.append('files', new Blob([Buffer.from(`x${i}`)]), `f${i}.txt`);
r = await call(admin, 'POST', '/api/files', form, true);
ok('more than 20 files per request is refused', r.status === 400, `HTTP ${r.status}`);

// UTF-16BE with an odd trailing byte used to crash Buffer.swap16().
const utf16be = Buffer.concat([
  Buffer.from([0xfe, 0xff]),
  Buffer.from('Amount,Value\r\n', 'utf16le').swap16(),
  Buffer.from([0x00]),
]);
form = new FormData();
form.set('conversationId', convId);
form.append('files', new Blob([utf16be]), 'odd-utf16be.csv');
r = await call(admin, 'POST', '/api/files', form, true);
ok('odd-length UTF-16BE file does not crash ingestion', r.status === 200 && r.json?.files?.length === 1, `HTTP ${r.status}`);

/* ────────────────────────── PII precision ───────────────────────────── */

console.log('\n=== PII tokenisation ===');
const mixed = [
  'Line,Detail,Amount',
  'SSN on file,123-45-6789,0.00',
  'EIN,12-3456789,0.00',
  'Gross receipts,none,123456789',
  'Payment,none,$123456789',
].join(String.fromCharCode(10));
form = new FormData();
form.set('conversationId', convId);
form.append('files', new Blob([Buffer.from(mixed)]), 'precision.csv');
r = await call(admin, 'POST', '/api/files', form, true);
const precision = r.json?.files?.[0];
ok('SSN and EIN masked', /SSN/.test(precision?.piiSummary ?? '') && /EIN/.test(precision?.piiSummary ?? ''), precision?.piiSummary ?? 'nothing masked');
ok('currency-prefixed figure not mistaken for a card number', !/CARD/.test(precision?.piiSummary ?? ''), precision?.piiSummary ?? '');

/* ───────────────────────── access control ───────────────────────────── */

console.log('\n=== access control ===');
const pdfId = files.find((f) => f.kind === 'pdf')?.id;

r = await call(member, 'GET', `/api/files/${pdfId}/raw`);
ok("a member cannot fetch admin's file (404, not 403)", r.status === 404, `HTTP ${r.status}`);

r = await call(member, 'GET', `/api/conversations/${convId}`);
ok("a member cannot open admin's conversation", r.status === 404, `HTTP ${r.status}`);

r = await call(member, 'GET', '/api/admin/prompt');
ok('a member is blocked from the house instructions', r.status === 403, `HTTP ${r.status}`);

r = await call(member, 'GET', '/api/admin/costs');
ok('a member is blocked from cost data', r.status === 403, `HTTP ${r.status}`);

r = await call(admin, 'GET', `/api/files/${pdfId}/raw`);
ok('admin can fetch own file', r.status === 200, `HTTP ${r.status}`);
ok('file served as attachment, not inline', (r.headers.get('content-disposition') ?? '').startsWith('attachment'));
ok('nosniff set on file download', r.headers.get('x-content-type-options') === 'nosniff');

/* ─────────────────────────── admin surfaces ─────────────────────────── */

console.log('\n=== admin surfaces ===');
r = await call(admin, 'GET', '/api/admin/costs');
ok('costs endpoint returns', r.status === 200 && typeof r.json?.monthToDateUsd === 'number');

r = await call(admin, 'GET', '/api/admin/retention');
ok('retention reports stored files', r.status === 200 && r.json?.liveFiles >= 3, `${r.json?.liveFiles} files, ${r.json?.retentionDays}d`);

r = await call(admin, 'POST', '/api/admin/settings', { monthlyCapUsd: 150 });
ok('settings saved', r.json?.ok === true);
r = await call(admin, 'GET', '/api/admin/settings');
ok('cap persisted', r.json?.monthlyCapUsd === 150);

console.log('\n=== people are added by email, not password ===');
r = await call(admin, 'POST', '/api/admin/users', { email: 'admin2@usaindiacfo.com', role: 'admin', displayName: 'Second Admin' });
ok('someone can be added with no password', r.status === 200 && r.json?.email === 'admin2@usaindiacfo.com', `HTTP ${r.status}`);
const createdAdmin2 = r.json?.id;

r = await call(admin, 'POST', '/api/admin/users', { email: 'not-an-email', role: 'member' });
ok('a malformed email is refused', r.status === 400, `HTTP ${r.status}`);

r = await call(admin, 'POST', '/api/admin/users', { email: 'admin2@usaindiacfo.com', role: 'member' });
ok('a duplicate email is refused', r.status === 409, `HTTP ${r.status}`);

// The newly added address can sign in straight away.
const admin2 = jar(await cookieFor('admin2@usaindiacfo.com'));
r = await call(admin2, 'GET', '/api/me');
ok('a just-added address can use a Google session immediately', r.json?.role === 'admin', `HTTP ${r.status}`);

console.log('\n=== deactivation takes effect on the next request ===');
r = await call(admin, 'POST', `/api/admin/users/${createdAdmin2}/active`, { active: false });
ok('admin deactivated the second admin', r.json?.ok === true, `HTTP ${r.status}`);

r = await call(admin2, 'GET', '/api/me');
ok('their existing session stops working immediately', r.status === 401, `HTTP ${r.status}`);

r = await call(admin, 'POST', `/api/admin/users/${adminId}/active`, { active: false });
ok('cannot deactivate your own account', r.status === 400, `HTTP ${r.status}`);

r = await call(admin, 'POST', '/api/admin/users/does-not-exist/active', { active: false });
ok('unknown user id returns 404', r.status === 404, `HTTP ${r.status}`);

// Only one active admin remains, so removing them must be refused.
r = await call(admin2, 'POST', `/api/admin/users/${adminId}/active`, { active: false });
ok('a deactivated admin cannot act at all', r.status === 401, `HTTP ${r.status}`);

/* ──────────────────── dedupe across conversations ───────────────────── */

console.log('\n=== the same document in two conversations ===');
r = await call(admin, 'POST', '/api/conversations');
const convB = r.json?.id;
form = new FormData();
form.set('conversationId', convB);
form.append('files', new Blob([readFileSync(path.join(FIXTURES, 'sample-1120s.pdf'))]), 'sample-1120s.pdf');
r = await call(admin, 'POST', '/api/files', form, true);
const reused = r.json?.files?.[0];
ok('the upload succeeds', Boolean(reused?.id), JSON.stringify(r.json?.errors ?? []));

{
  // White-box: nothing over HTTP exposes files.conversation_id, and that column
  // is exactly what the original bug corrupted.
  //
  // Two properties, and both matter. The first conversation must keep its own
  // file — deduplication used to move it, which silently emptied the older
  // thread. The second must get a usable one: handing back a row belonging to
  // another conversation left this one showing an attachment the model could
  // not actually see, and answering that it had no document.
  const [first] = await db`
    SELECT id FROM files
     WHERE conversation_id = ${convId} AND filename = 'sample-1120s.pdf' AND deleted_at IS NULL`;
  ok('the first conversation keeps its file', Boolean(first?.id));

  const [row] = await db`SELECT conversation_id FROM files WHERE id = ${reused.id}`;
  ok(
    'the second conversation gets its own',
    row?.conversation_id === convB,
    row?.conversation_id === convId ? 'still pointing at the first' : String(row?.conversation_id),
  );
  ok('and they are different rows', first?.id !== reused?.id);
}

{
  // Re-uploading into the same conversation is the case deduplication is for.
  const again = new FormData();
  again.set('conversationId', convB);
  again.append('files', new Blob([readFileSync(path.join(FIXTURES, 'sample-1120s.pdf'))]), 'sample-1120s.pdf');
  r = await call(admin, 'POST', '/api/files', again, true);
  ok('re-uploading into the same conversation is deduped', r.json?.files?.[0]?.deduped === true);
  ok('and returns the row already there', r.json?.files?.[0]?.id === reused?.id);
}
/* ─────────────────── rename, search, inline preview ─────────────────── */

console.log('\n=== conversation rename ===');
r = await call(admin, 'PATCH', `/api/conversations/${convId}`, { title: 'Acme Holdings 1120-S' });
ok('conversation renamed', r.json?.title === 'Acme Holdings 1120-S', `HTTP ${r.status}`);

r = await call(admin, 'PATCH', `/api/conversations/${convId}`, { title: '   ' });
ok('a blank title is refused', r.status === 400, `HTTP ${r.status}`);

r = await call(member, 'PATCH', `/api/conversations/${convId}`, { title: 'hijacked' });
ok("a member cannot rename someone else's conversation", r.status === 404, `HTTP ${r.status}`);

console.log('\n=== search ===');
r = await call(admin, 'GET', '/api/search?q=Acme');
ok('search finds a conversation by title', Array.isArray(r.json) && r.json.some((c) => c.id === convId), `${r.json?.length} result(s)`);

r = await call(admin, 'GET', '/api/search?q=%25%25');
ok('a wildcard-only query does not match everything', Array.isArray(r.json) && r.json.length === 0, `${r.json?.length} result(s)`);

r = await call(admin, 'GET', '/api/search?q=zzzznothing');
ok('an unmatched query returns nothing', Array.isArray(r.json) && r.json.length === 0);

r = await call(member, 'GET', '/api/search?q=Acme');
ok("search does not leak another user's conversations", Array.isArray(r.json) && r.json.length === 0);

console.log('\n=== in-app document preview ===');
r = await call(admin, 'GET', `/api/files/${pdfId}/raw?inline=1`);
ok('inline mode serves the file for the viewer', r.status === 200 && (r.headers.get('content-disposition') ?? '').startsWith('inline'), (r.headers.get('content-disposition') ?? '').slice(0, 28));
ok('inline mode still sandboxes the response', (r.headers.get('content-security-policy') ?? '').includes('sandbox'));

r = await call(member, 'GET', `/api/files/${pdfId}/raw?inline=1`);
ok('inline mode respects ownership', r.status === 404, `HTTP ${r.status}`);

/* ──────────────────────────── chat ───────────────────────────── */

console.log('\n=== chat ===');
// Attachments ride along with the message rather than starting a separate job.
const chat = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: admin.header() },
  body: JSON.stringify({
    conversationId: convId,
    question: 'What is in sample-1120s?',
    fileIds: [pdfId],
  }),
});
ok('chat responds with ndjson', chat.ok && (chat.headers.get('content-type') ?? '').includes('ndjson'), chat.headers.get('content-type') ?? '');

const events = [];
{
  const reader = chat.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(String.fromCharCode(10));
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) events.push(JSON.parse(l));
  }
}
// Asserted loosely on purpose: with a key configured this streams a real
// answer, and without one it fails. Either way the path is proven — the
// message persisted, the stream opened, and the outcome arrived as an event
// rather than as a dead connection.
ok('the turn produced events', events.length > 0, events.map((e) => e.type).join(','));
ok(
  'a failure arrives as an error event, not a hang',
  events.some((e) => e.type === 'error' || e.type === 'done'),
  events.map((e) => e.type).join(','),
);

r = await call(admin, 'GET', `/api/conversations/${convId}`);
ok('the question was persisted', (r.json?.messages ?? []).some((m) => m.content.includes('sample-1120s')));
ok(
  'the attachment is bound to the conversation',
  (r.json?.files ?? []).some((f) => f.id === pdfId),
  `${r.json?.files?.length} file(s)`,
);

r = await call(admin, 'GET', '/api/search?q=sample-1120s');
ok('search finds a conversation by message text', Array.isArray(r.json) && r.json.some((c) => c.id === convId), `${r.json?.length} result(s)`);

r = await call(member, 'POST', '/api/chat', { conversationId: convId, question: 'hello' });
ok("a member cannot post into someone else's conversation", r.status === 404, `HTTP ${r.status}`);


/* ─────────────────────── preferences and styles ──────────────────────── */

console.log('\n=== preferences, styles, memory ===');

for (const [method, url] of [
  ['GET', '/api/prefs'],
  ['GET', '/api/memories'],
  ['GET', '/api/styles'],
  ['GET', '/api/projects'],
  ['GET', '/api/export'],
]) {
  r = await call(anon, method, url);
  ok(`${method} ${url} refuses an anonymous caller`, r.status === 401, `HTTP ${r.status}`);
}

r = await call(admin, 'GET', '/api/prefs');
ok('prefs list the model choices', (r.json?.models ?? []).length >= 2, `${r.json?.models?.length} models`);
ok('prefs list the built-in styles', (r.json?.styles ?? []).some((s) => s.id === 'concise'));
ok('memory is on by default', r.json?.memoryEnabled === true);

r = await call(admin, 'POST', '/api/prefs', {
  instructions: 'Give me the figure before the explanation.',
  thinking: 'extended',
});
ok('preferences save', r.status === 200 && r.json?.thinking === 'extended', JSON.stringify(r.json));

r = await call(admin, 'POST', '/api/prefs', { model: 'not-a-real-model' });
ok('an unknown model falls back rather than being stored', r.json?.model === null, String(r.json?.model));

r = await call(admin, 'POST', '/api/styles', { name: 'Client email', instructions: 'No jargon.' });
const styleId = r.json?.id;
ok('a custom style is created', r.status === 200 && Boolean(styleId));

r = await call(admin, 'GET', '/api/prefs');
ok('a custom style joins the picker', (r.json?.styles ?? []).some((s) => s.id === styleId && !s.builtIn));

r = await call(member, 'PATCH', `/api/styles/${styleId}`, { name: 'stolen', instructions: 'x' });
r = await call(admin, 'GET', '/api/styles');
ok(
  'one person cannot rename a style belonging to another',
  (r.json ?? []).some((s) => s.id === styleId && s.name === 'Client email'),
);

r = await call(admin, 'POST', '/api/memories', { text: 'Prefers figures before prose.' });
const memoryId = r.json?.id;
ok('a memory is stored', r.status === 200 && Boolean(memoryId));

r = await call(member, 'DELETE', `/api/memories/${memoryId}`);
r = await call(admin, 'GET', '/api/memories');
ok(
  'one person cannot delete a memory belonging to another',
  (r.json ?? []).some((m) => m.id === memoryId),
  `${r.json?.length} remaining`,
);

r = await call(admin, 'DELETE', `/api/memories/${memoryId}`);
r = await call(admin, 'GET', '/api/memories');
ok('the owner can delete it', !(r.json ?? []).some((m) => m.id === memoryId));

/* ─────────────────────────────── projects ────────────────────────────── */

console.log('\n=== projects ===');

r = await call(admin, 'POST', '/api/projects', { name: 'Acme 2025' });
const projectId = r.json?.id;
ok('a project is created', r.status === 200 && Boolean(projectId));

r = await call(admin, 'POST', '/api/projects', { name: '  ' });
ok('a nameless project is refused', r.status === 400, `HTTP ${r.status}`);

r = await call(admin, 'PATCH', `/api/projects/${projectId}`, {
  instructions: 'Amounts are in USD. Assume the federal schedule.',
});
ok('project instructions save', r.status === 200);

{
  const form = new FormData();
  form.append('projectId', projectId);
  form.append(
    'files',
    new Blob([readFileSync(path.join(FIXTURES, 'gl-export.csv'))], { type: 'text/csv' }),
    'shelf.csv',
  );
  r = await call(admin, 'POST', '/api/files', form, true);
  ok(
    'a document can go on the project shelf',
    (r.json?.files ?? []).length === 1,
    JSON.stringify(r.json?.errors ?? []),
  );
}

{
  const form = new FormData();
  form.append('projectId', projectId);
  form.append('conversationId', convId);
  form.append('files', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'both.txt');
  r = await call(admin, 'POST', '/api/files', form, true);
  ok('a file cannot go to a chat and a project at once', r.status === 400, `HTTP ${r.status}`);
}

r = await call(member, 'GET', `/api/projects/${projectId}`);
ok('a member cannot read a project belonging to another', r.status === 404, `HTTP ${r.status}`);

r = await call(admin, 'POST', '/api/conversations', { projectId });
const projectConvId = r.json?.id;
ok('a chat can be created inside a project', r.json?.project_id === projectId);

r = await call(admin, 'GET', `/api/conversations/${projectConvId}`);
ok(
  'the project shelf is visible to a chat inside it',
  (r.json?.files ?? []).some((f) => f.filename === 'shelf.csv' && f.fromProject),
  `${r.json?.files?.length} file(s)`,
);

r = await call(admin, 'POST', '/api/conversations', { projectId: 'not-mine' });
ok('an unknown project id is ignored rather than trusted', r.json?.project_id === null);

/* ──────────────────────── branching and versions ─────────────────────── */

console.log('\n=== branching ===');

r = await call(admin, 'POST', '/api/conversations');
const branchConv = r.json?.id;

async function turn(body) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.header() },
    body: JSON.stringify({ conversationId: branchConv, ...body }),
  });
  await res.text();
  return res;
}

await turn({ question: 'Reply with the single word: alpha.' });

r = await call(admin, 'GET', `/api/conversations/${branchConv}`);
let thread = r.json?.messages ?? [];
ok('the turn produced a question and an answer', thread.length === 2, `${thread.length} message(s)`);

const firstAnswer = thread.find((m) => m.role === 'assistant');
const firstQuestion = thread.find((m) => m.role === 'user');

if (firstAnswer) {
  await turn({ action: 'retry', messageId: firstAnswer.id });
  r = await call(admin, 'GET', `/api/conversations/${branchConv}`);
  thread = r.json?.messages ?? [];
  const retried = thread.find((m) => m.role === 'assistant');
  ok(
    'retrying makes a second version of the answer',
    retried?.versionCount === 2,
    `${retried?.versionCount} version(s)`,
  );
  ok('the retry is the one on screen', retried?.version === 2, `showing ${retried?.version}`);

  r = await call(admin, 'PATCH', `/api/conversations/${branchConv}`, {
    headMessageId: retried?.versionIds?.[0],
  });
  r = await call(admin, 'GET', `/api/conversations/${branchConv}`);
  const back = (r.json?.messages ?? []).find((m) => m.role === 'assistant');
  ok('stepping back shows the first version again', back?.version === 1, `showing ${back?.version}`);
}

if (firstQuestion) {
  await turn({
    action: 'edit',
    messageId: firstQuestion.id,
    question: 'Reply with the single word: beta.',
  });
  r = await call(admin, 'GET', `/api/conversations/${branchConv}`);
  const edited = (r.json?.messages ?? []).find((m) => m.role === 'user');
  ok(
    'editing makes a second version of the question',
    edited?.versionCount === 2,
    `${edited?.versionCount} version(s)`,
  );
  ok('the edited question is what the thread now shows', edited?.content?.includes('beta'), edited?.content ?? '');
}

r = await call(admin, 'POST', '/api/chat', {
  conversationId: branchConv,
  action: 'edit',
  messageId: firstAnswer?.id,
  question: 'x',
});
ok('an answer cannot be edited as if it were a question', r.status === 400, `HTTP ${r.status}`);

r = await call(admin, 'POST', '/api/chat', {
  conversationId: branchConv,
  action: 'retry',
  messageId: firstQuestion?.id,
});
ok('a question cannot be retried as if it were an answer', r.status === 400, `HTTP ${r.status}`);

r = await call(admin, 'GET', `/api/conversations/${branchConv}`);
const answerId = (r.json?.messages ?? []).find((m) => m.role === 'assistant')?.id;
if (answerId) {
  r = await call(admin, 'PATCH', `/api/messages/${answerId}`, { vote: 1 });
  ok('an answer can be rated', r.json?.vote === 1, JSON.stringify(r.json));
  r = await call(member, 'PATCH', `/api/messages/${answerId}`, { vote: -1 });
  ok('a member cannot rate an answer belonging to another', r.status === 404, `HTTP ${r.status}`);
}

/* ─────────────────────── stars, archive, export ──────────────────────── */

console.log('\n=== stars, archive, export ===');

r = await call(admin, 'PATCH', `/api/conversations/${branchConv}`, { starred: true });
r = await call(admin, 'GET', '/api/conversations');
ok('a starred chat sorts to the top', r.json?.[0]?.id === branchConv, r.json?.[0]?.title ?? '');

r = await call(admin, 'PATCH', `/api/conversations/${branchConv}`, { archived: true });
r = await call(admin, 'GET', '/api/conversations');
ok('an archived chat leaves the main list', !(r.json ?? []).some((c) => c.id === branchConv));

r = await call(admin, 'GET', '/api/conversations?archived=1');
ok('and appears in the archive', (r.json ?? []).some((c) => c.id === branchConv));

r = await call(admin, 'PATCH', `/api/conversations/${branchConv}`, { archived: false });

r = await call(admin, 'GET', `/api/export?conversationId=${branchConv}`);
ok('a conversation exports as markdown', r.status === 200 && r.text.startsWith('#'), r.text.slice(0, 40));
ok('the export is offered as a download', (r.headers.get('content-disposition') ?? '').includes('attachment'));

r = await call(member, 'GET', `/api/export?conversationId=${branchConv}`);
ok('a member cannot export a conversation belonging to another', r.status === 404, `HTTP ${r.status}`);

r = await call(admin, 'GET', '/api/export');
ok('everything exports as json', r.status === 200 && Array.isArray(r.json?.conversations), typeof r.json);
ok(
  'the export carries the memories and projects',
  Array.isArray(r.json?.memories) && Array.isArray(r.json?.projects),
);

/* ───────────────────────── project deletion ──────────────────────────── */

r = await call(admin, 'DELETE', `/api/projects/${projectId}`);
ok('a project can be deleted', r.status === 200);

r = await call(admin, 'GET', `/api/conversations/${projectConvId}`);
ok(
  'its chats survive the deletion',
  r.status === 200 && r.json?.conversation?.projectId === null,
  `HTTP ${r.status}`,
);
ok('but its shelf is no longer in context', !(r.json?.files ?? []).some((f) => f.filename === 'shelf.csv'));

// Styles show up in a real settings screen, so the one this suite made goes away
// again. The suite shares a database with the app by design.
await call(admin, 'DELETE', `/api/styles/${styleId}`);
r = await call(admin, 'GET', '/api/styles');
ok('the test style is cleaned up', !(r.json ?? []).some((s) => s.id === styleId));

console.log('\n=== audit log ===');
r = await call(member, 'GET', '/api/admin/audit');
ok('the audit log is admins only', r.status === 403, `HTTP ${r.status}`);

r = await call(admin, 'GET', '/api/admin/audit');
ok('the audit log reads back', Array.isArray(r.json?.entries), typeof r.json?.entries);
ok('it records the uploads this suite made', (r.json?.entries ?? []).some((e) => e.action === 'file.upload'), (r.json?.actions ?? []).map((a) => a.action).join(','));

r = await call(admin, 'GET', '/api/admin/audit?action=file.upload');
ok('and filters by action', (r.json?.entries ?? []).every((e) => e.action === 'file.upload'), `${r.json?.entries?.length} entries`);


/* ────────────────────────────── connectors ───────────────────────────── */

console.log('\n=== connectors ===');

const stub = await startStubServer();

for (const [method, url] of [
  ['GET', '/api/admin/connectors'],
  ['POST', '/api/admin/connectors'],
  ['GET', '/api/connectors'],
]) {
  r = await call(anon, method, url, method === 'POST' ? {} : undefined);
  ok(`${method} ${url} refuses an anonymous caller`, r.status === 401, `HTTP ${r.status}`);
}

r = await call(member, 'GET', '/api/admin/connectors');
ok('a member cannot see the connector configuration', r.status === 403, `HTTP ${r.status}`);

r = await call(admin, 'POST', '/api/admin/connectors', {
  name: 'Practice records',
  url: stub.url,
  authHeader: 'Authorization',
  authValue: `Bearer ${stub.token}`,
});
const connectorId = r.json?.id;
ok('a connector is created', r.status === 200 && Boolean(connectorId), JSON.stringify(r.json ?? {}));
ok('the credential is never returned', r.json?.authValue === undefined && r.json?.hasSecret === true);

r = await call(admin, 'POST', '/api/admin/connectors', { name: 'Bad', url: 'ftp://nope' });
ok('a non-http URL is refused', r.status === 400, `HTTP ${r.status}`);

r = await call(admin, 'POST', '/api/admin/connectors', {
  name: 'Metadata',
  url: 'http://169.254.169.254/latest/meta-data/',
});
ok('the cloud metadata endpoint is refused', r.status === 400, `HTTP ${r.status}`);

r = await call(admin, 'POST', `/api/admin/connectors/${connectorId}/refresh`);
ok('the server is reachable and lists its tools', (r.json?.tools ?? []).length === 2, r.json?.error ?? `${r.json?.tools?.length} tools`);
ok(
  'read-only tools are marked as such',
  (r.json?.tools ?? []).find((t) => t.name === 'lookup_client')?.readOnly === true,
);
ok(
  'a tool that writes is marked too',
  (r.json?.tools ?? []).find((t) => t.name === 'delete_client')?.readOnly === false,
);

r = await call(member, 'GET', '/api/connectors');
ok(
  'a connector with nothing approved is not offered to anyone',
  !(r.json ?? []).some((c) => c.id === connectorId),
  `${r.json?.length} offered`,
);

r = await call(admin, 'PATCH', `/api/admin/connectors/${connectorId}`, {
  allowedTools: ['lookup_client'],
});
ok('a tool can be approved', r.status === 200);

r = await call(member, 'GET', '/api/connectors');
ok(
  'and the connector then appears in the picker',
  (r.json ?? []).some((c) => c.id === connectorId && c.toolCount === 1),
  JSON.stringify(r.json ?? []),
);
ok(
  'the picker never carries the URL or the credential',
  (r.json ?? []).every((c) => c.url === undefined && c.authValue === undefined),
);

// The credential must survive an edit that does not mention it, or renaming a
// connector would quietly break it.
r = await call(admin, 'PATCH', `/api/admin/connectors/${connectorId}`, { name: 'Practice records ' });
r = await call(admin, 'GET', `/api/admin/connectors/${connectorId}`);
ok('editing the name leaves the stored secret alone', r.json?.hasSecret === true);

r = await call(admin, 'POST', `/api/admin/connectors/${connectorId}/refresh`);
ok('and it still authenticates afterwards', !r.json?.error, r.json?.error ?? 'ok');

/* --------------------------------------------- switching one on per thread */

r = await call(admin, 'POST', '/api/conversations');
const connConv = r.json?.id;

r = await call(admin, 'GET', `/api/conversations/${connConv}`);
ok('a new chat has no connectors switched on', (r.json?.settings?.connectors ?? []).length === 0);

r = await call(admin, 'PATCH', `/api/conversations/${connConv}`, { connectors: [connectorId] });
r = await call(admin, 'GET', `/api/conversations/${connConv}`);
ok('one can be switched on for a thread', (r.json?.settings?.connectors ?? []).includes(connectorId));

r = await call(admin, 'PATCH', `/api/conversations/${connConv}`, { connectors: ['made-up-id'] });
r = await call(admin, 'GET', `/api/conversations/${connConv}`);
ok('an unknown connector id is discarded, not stored', (r.json?.settings?.connectors ?? []).length === 0);

r = await call(admin, 'PATCH', `/api/conversations/${connConv}`, { connectors: [connectorId] });
r = await call(admin, 'PATCH', `/api/admin/connectors/${connectorId}`, { enabled: false });
r = await call(admin, 'GET', `/api/conversations/${connConv}`);
ok(
  'disabling a connector drops it from threads already using it',
  (r.json?.settings?.connectors ?? []).length === 0,
);
await call(admin, 'PATCH', `/api/admin/connectors/${connectorId}`, { enabled: true });

r = await call(member, 'PATCH', `/api/admin/connectors/${connectorId}`, { enabled: false });
ok('a member cannot disable a connector', r.status === 403, `HTTP ${r.status}`);

r = await call(admin, 'GET', '/api/admin/audit?action=connector.tools');
ok(
  'approving a tool is written to the audit log',
  (r.json?.entries ?? []).some((e) => e.detail?.includes('lookup_client')),
  `${r.json?.entries?.length} entries`,
);

r = await call(admin, 'DELETE', `/api/admin/connectors/${connectorId}`);
ok('a connector can be deleted', r.status === 200);

r = await call(admin, 'GET', '/api/connectors');
ok('and stops being offered', !(r.json ?? []).some((c) => c.id === connectorId));

await stub.close();


/* ────────────────────────── connected accounts ───────────────────────── */

console.log('\n=== connected accounts ===');

for (const [method, url] of [
  ['GET', '/api/accounts'],
  ['GET', '/api/accounts/drive/start'],
  ['DELETE', '/api/accounts/drive'],
]) {
  r = await call(anon, method, url);
  ok(`${method} ${url} refuses an anonymous caller`, r.status === 401, `HTTP ${r.status}`);
}

r = await call(admin, 'GET', '/api/accounts');
const providers = r.json ?? [];
ok('Drive, Gmail and Box are all offered', ['drive', 'gmail', 'box'].every((id) => providers.some((p) => p.id === id)), providers.map((p) => p.id).join(','));
ok('none is connected to begin with', providers.every((p) => !p.connected));
ok(
  'each says whether the server has credentials for it',
  providers.every((p) => typeof p.configured === 'boolean'),
);

for (const p of providers.filter((x) => !x.configured)) {
  ok(
    `${p.id} explains what is missing and gives the exact redirect URI`,
    Boolean(p.setupHint) && String(p.redirectUri ?? '').endsWith(`/api/accounts/${p.id}/callback`),
    p.redirectUri ?? 'no redirect uri',
  );
}

for (const p of providers.filter((x) => x.configured)) {
  r = await call(admin, 'GET', `/api/accounts/${p.id}/start`);
  const location = r.headers.get('location') ?? '';
  ok(`${p.id} sends the browser to the provider`, r.status === 302 && location.startsWith('http'), `HTTP ${r.status}`);

  const url = new URL(location || 'http://x/');
  ok(`${p.id} asks for a code with PKCE`, url.searchParams.get('response_type') === 'code' && url.searchParams.get('code_challenge_method') === 'S256', url.searchParams.get('code_challenge_method') ?? 'none');
  ok(`${p.id} sends a state`, (url.searchParams.get('state') ?? '').length > 20);
  ok(
    `${p.id} asks for read-only scopes only`,
    !/\bdrive\b(?!\.readonly)|gmail\.(send|modify|compose)|drive\.file/.test(url.searchParams.get('scope') ?? ''),
    url.searchParams.get('scope') ?? '(set on the app)',
  );
}

for (const p of providers.filter((x) => !x.configured)) {
  r = await call(admin, 'GET', `/api/accounts/${p.id}/start`);
  ok(`${p.id} says so rather than sending you nowhere`, r.status === 400, `HTTP ${r.status}`);
}

r = await call(admin, 'GET', '/api/accounts/not-a-provider/start');
ok('an unknown account type is refused', r.status === 400, `HTTP ${r.status}`);

// A callback is reached by a human in a browser, so every outcome has to end in
// a redirect back into the app rather than in a JSON error nobody can act on.
r = await call(admin, 'GET', '/api/accounts/drive/callback?code=nope&state=nope');
ok(
  'a bad callback sends you back with a message, not a dead end',
  r.status === 302 && (r.headers.get('location') ?? '').includes('account_error'),
  `HTTP ${r.status} ${r.headers.get('location') ?? ''}`,
);

r = await call(admin, 'GET', '/api/accounts/drive/callback?error=access_denied');
ok(
  'declining at the provider comes back cleanly too',
  r.status === 302 && (r.headers.get('location') ?? '').includes('account_error=access_denied'),
  r.headers.get('location') ?? '',
);

r = await call(admin, 'GET', '/api/connectors');
ok(
  'an unconnected account is not offered in the composer',
  !(r.json ?? []).some((c) => c.kind === 'account'),
  JSON.stringify(r.json ?? []),
);

r = await call(admin, 'POST', '/api/conversations');
const acctConv = r.json?.id;
r = await call(admin, 'PATCH', `/api/conversations/${acctConv}`, { connectors: ['account:drive'] });
r = await call(admin, 'GET', `/api/conversations/${acctConv}`);
ok(
  'an account nobody connected cannot be switched on',
  (r.json?.settings?.connectors ?? []).length === 0,
  JSON.stringify(r.json?.settings?.connectors ?? []),
);

r = await call(admin, 'DELETE', '/api/accounts/drive');
ok('disconnecting an account that is not connected is harmless', r.status === 200, `HTTP ${r.status}`);

{
  // White-box: a refresh token is a standing grant to read somebody mailbox,
  // so nothing may write one to the database in the clear.
  const rows = await db`SELECT access_token, refresh_token FROM oauth_accounts`;
  ok(
    'no account token is stored in plaintext',
    rows.every((row) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(row.access_token)),
    `${rows.length} row(s)`,
  );
}

await db.end();
console.log(`
${pass} passed, ${fail} failed
`);
process.exit(fail ? 1 : 0);
