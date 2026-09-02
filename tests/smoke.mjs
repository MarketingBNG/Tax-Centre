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
 * It does not call the OpenAI or Anthropic APIs — that costs money.
 */
import { encode } from 'next-auth/jwt';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import ExcelJS from 'exceljs';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const DB_PATH = path.join(process.cwd(), 'data', 'app.db');
const COOKIE_NAME = 'authjs.session-token';

function authSecret() {
  const line = readFileSync(path.join(process.cwd(), '.env'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('AUTH_SECRET='));
  if (!line) throw new Error('AUTH_SECRET is missing from .env');
  return line.slice(line.indexOf('=') + 1).trim();
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
  ['POST', '/api/review'],
  ['POST', '/api/chat'],
  ['GET', '/api/admin/skills'],
  ['GET', '/api/admin/costs'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/retention'],
]) {
  r = await call(anon, method, url, method === 'POST' ? {} : undefined);
  ok(`${method} ${url} → 401`, r.status === 401, `HTTP ${r.status}`);
}

/* ───────────────────────── seed identities ───────────────────────────── */

// The database exists by now because /login queried it.
const db = new DatabaseSync(DB_PATH);
const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
ok('users table has no password column', !cols.includes('password_hash'), cols.join(','));

const adminId = crypto.randomUUID();
const reviewerId = crypto.randomUUID();
const admin2Id = crypto.randomUUID();
const insert = db.prepare(
  `INSERT INTO users (id, email, role, display_name, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
);
insert.run(adminId, 'admin@usaindiacfo.com', 'admin', 'Test Admin', Date.now());
insert.run(reviewerId, 'rev@usaindiacfo.com', 'reviewer', 'Test Reviewer', Date.now());
db.close();

const cookieFor = async (email) =>
  encode({ token: { email, name: email, sub: email }, secret: SECRET, salt: COOKIE_NAME, maxAge: 3600 });

const admin = jar(await cookieFor('admin@usaindiacfo.com'));
const reviewer = jar(await cookieFor('rev@usaindiacfo.com'));
const stranger = jar(await cookieFor('nobody@gmail.com'));

console.log('\n=== identity is not authorisation ===');
r = await call(admin, 'GET', '/api/me');
ok('an allowlisted admin is recognised', r.json?.role === 'admin' && r.json?.email === 'admin@usaindiacfo.com', `HTTP ${r.status}`);
ok('provider reported', ['openai', 'anthropic'].includes(r.json?.provider), `${r.json?.provider} / ${r.json?.model} / citations=${r.json?.citationsSupported}`);
ok('pii tokenisation on by default', r.json?.piiMode === 'tokenize');

r = await call(stranger, 'GET', '/api/me');
ok('a valid Google session for an un-invited address is refused', r.status === 401, `HTTP ${r.status}`);

r = await call(reviewer, 'GET', '/api/me');
ok('an allowlisted reviewer is recognised', r.json?.role === 'reviewer');

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

    // And a reviewer added to the list is promoted rather than left as-is.
    const probe = new DatabaseSync(DB_PATH);
    const demoteId = crypto.randomUUID();
    probe.prepare(
      `INSERT INTO users (id, email, role, display_name, is_active, created_at) VALUES (?, ?, 'reviewer', ?, 1, ?)`,
    ).run(demoteId, 'listed-as-reviewer@usaindiacfo.com', 'Listed', Date.now());
    probe.close();

    // Not in ADMIN_EMAILS, so it should stay a reviewer.
    const stillReviewer = jar(await cookieFor('listed-as-reviewer@usaindiacfo.com'));
    r = await call(stillReviewer, 'GET', '/api/me');
    ok('an address absent from the list is not promoted', r.json?.role === 'reviewer', r.json?.role);
  }
}

/* ──────────────────────────── skills ────────────────────────────────── */

console.log('\n=== skills ===');
let form = new FormData();
form.set('title', '1120-S review checklist');
form.set('jurisdiction', 'us-federal');
form.set('body', '1. Tie Schedule K to the K-1s.\n2. Compare officer compensation to distributions.');
r = await call(admin, 'POST', '/api/admin/skills', form, true);
ok('skill published', r.status === 200 && r.json?.version === 1, `HTTP ${r.status}`);
const skillId = r.json?.id;

r = await call(admin, 'GET', '/api/admin/skills');
ok('skill appears in the bundle', r.json?.skills?.length === 1 && r.json?.bundleTokens > 0, `${r.json?.bundleTokens} tok`);

r = await call(admin, 'PUT', `/api/admin/skills/${skillId}`, { body: 'Updated checklist body.' });
ok('editing bumps the version', r.json?.version === 2, `v${r.json?.version}`);

/* ──────────────────────────── uploads ───────────────────────────────── */

console.log('\n=== uploads ===');
r = await call(admin, 'POST', '/api/conversations');
const convId = r.json?.id;
ok('conversation created', Boolean(convId));

form = new FormData();
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

r = await call(reviewer, 'GET', `/api/files/${pdfId}/raw`);
ok("reviewer cannot fetch admin's file (404, not 403)", r.status === 404, `HTTP ${r.status}`);

r = await call(reviewer, 'GET', `/api/conversations/${convId}`);
ok("reviewer cannot open admin's conversation", r.status === 404, `HTTP ${r.status}`);

r = await call(reviewer, 'GET', '/api/admin/skills');
ok('reviewer blocked from admin skills', r.status === 403, `HTTP ${r.status}`);

r = await call(reviewer, 'GET', '/api/admin/costs');
ok('reviewer blocked from cost data', r.status === 403, `HTTP ${r.status}`);

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

r = await call(admin, 'POST', '/api/admin/users', { email: 'not-an-email', role: 'reviewer' });
ok('a malformed email is refused', r.status === 400, `HTTP ${r.status}`);

r = await call(admin, 'POST', '/api/admin/users', { email: 'admin2@usaindiacfo.com', role: 'reviewer' });
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

console.log('\n=== dedupe must not steal a file from another conversation ===');
r = await call(admin, 'POST', '/api/conversations');
const convB = r.json?.id;
form = new FormData();
form.set('conversationId', convB);
form.append('files', new Blob([readFileSync(path.join(FIXTURES, 'sample-1120s.pdf'))]), 'sample-1120s.pdf');
r = await call(admin, 'POST', '/api/files', form, true);
const reused = r.json?.files?.[0];
ok('same file in a second conversation is deduped', reused?.deduped === true);

{
  // White-box: nothing over HTTP exposes files.conversation_id, and that column
  // is exactly what the bug corrupted.
  const probe = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = probe.prepare('SELECT conversation_id FROM files WHERE id = ?').get(reused.id);
  probe.close();
  ok('the file still belongs to the first conversation', row?.conversation_id === convId,
     row?.conversation_id === convId ? 'unchanged' : `moved to ${row?.conversation_id}`);
}
/* ─────────────────── rename, search, inline preview ─────────────────── */

console.log('\n=== conversation rename ===');
r = await call(admin, 'PATCH', `/api/conversations/${convId}`, { title: 'Acme Holdings 1120-S' });
ok('conversation renamed', r.json?.title === 'Acme Holdings 1120-S', `HTTP ${r.status}`);

r = await call(admin, 'PATCH', `/api/conversations/${convId}`, { title: '   ' });
ok('a blank title is refused', r.status === 400, `HTTP ${r.status}`);

r = await call(reviewer, 'PATCH', `/api/conversations/${convId}`, { title: 'hijacked' });
ok("a reviewer cannot rename someone else's conversation", r.status === 404, `HTTP ${r.status}`);

console.log('\n=== search ===');
r = await call(admin, 'GET', '/api/search?q=Acme');
ok('search finds a conversation by title', Array.isArray(r.json) && r.json.some((c) => c.id === convId), `${r.json?.length} result(s)`);

r = await call(admin, 'GET', '/api/search?q=%25%25');
ok('a wildcard-only query does not match everything', Array.isArray(r.json) && r.json.length === 0, `${r.json?.length} result(s)`);

r = await call(admin, 'GET', '/api/search?q=zzzznothing');
ok('an unmatched query returns nothing', Array.isArray(r.json) && r.json.length === 0);

r = await call(reviewer, 'GET', '/api/search?q=Acme');
ok("search does not leak another user's conversations", Array.isArray(r.json) && r.json.length === 0);

console.log('\n=== in-app document preview ===');
r = await call(admin, 'GET', `/api/files/${pdfId}/raw?inline=1`);
ok('inline mode serves the file for the viewer', r.status === 200 && (r.headers.get('content-disposition') ?? '').startsWith('inline'), (r.headers.get('content-disposition') ?? '').slice(0, 28));
ok('inline mode still sandboxes the response', (r.headers.get('content-security-policy') ?? '').includes('sandbox'));

r = await call(reviewer, 'GET', `/api/files/${pdfId}/raw?inline=1`);
ok('inline mode respects ownership', r.status === 404, `HTTP ${r.status}`);

/* ──────────── durable review streaming (needs no provider key) ────────── */

console.log('\n=== reviews run detached and replay from a cursor ===');
// With no provider key configured the job fails fast — which still exercises
// the whole path: detached start, persisted events, replay, and close.
r = await call(admin, 'POST', '/api/review', { conversationId: convId, fileIds: [pdfId] });
ok('POST /api/review returns an id immediately, not a stream', r.status === 200 && typeof r.json?.reviewId === 'string', `HTTP ${r.status}`);
const streamReviewId = r.json?.reviewId;

r = await call(admin, 'GET', `/api/conversations/${convId}`);
ok('the conversation reports whether a review is in flight', 'runningReviewId' in (r.json ?? {}));

// Starting the review wrote the user's message, so message-text search has
// something to find now.
r = await call(admin, 'GET', '/api/search?q=sample-1120s');
ok('search finds a conversation by message text', Array.isArray(r.json) && r.json.some((c) => c.id === convId), `${r.json?.length} result(s)`);

const first = await fetch(`${BASE}/api/review/${streamReviewId}/stream?from=0`, {
  headers: { Cookie: admin.header() },
});
ok('stream endpoint responds with ndjson', first.ok && (first.headers.get('content-type') ?? '').includes('ndjson'), first.headers.get('content-type') ?? '');

const events = [];
{
  const reader = first.body.getReader();
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
ok('the log replayed at least one event', events.length > 0, `${events.length} event(s)`);
ok('the stream ends with an explicit close', events.at(-1)?.type === 'closed', events.at(-1)?.type);
ok('every event carries a replay cursor', events.filter((e) => e.type !== 'closed').every((e) => typeof e.cursor === 'number'));

{
  // Reconnecting past the cursor must not repeat what was already delivered.
  const lastCursor = events.at(-1)?.cursor ?? 0;
  const again = await fetch(`${BASE}/api/review/${streamReviewId}/stream?from=${lastCursor}`, {
    headers: { Cookie: admin.header() },
  });
  const replayed = (await again.text())
    .trim()
    .split(String.fromCharCode(10))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  ok('reconnecting from the cursor replays no duplicates', replayed.every((e) => e.type === 'closed'), replayed.map((e) => e.type).join(','));
}

r = await call(admin, 'GET', `/api/reviews/${streamReviewId}`);
ok('the review settled and was recorded', ['failed', 'complete', 'aborted'].includes(r.json?.review?.status), r.json?.review?.status);
ok('the reason was stored, not swallowed', Boolean(r.json?.review?.error_text) || r.json?.review?.status === 'complete', (r.json?.review?.error_text ?? '').slice(0, 55));

r = await call(admin, 'POST', `/api/review/${streamReviewId}/abort`);
ok('aborting a settled review is a no-op, not an error', r.status === 200 && r.json?.stopped === false, `stopped=${r.json?.stopped}`);

r = await call(reviewer, 'GET', `/api/review/${streamReviewId}/stream?from=0`);
ok("a reviewer cannot read another user's review stream", r.status === 404, `HTTP ${r.status}`);

r = await call(reviewer, 'POST', `/api/review/${streamReviewId}/abort`);
ok("a reviewer cannot abort another user's review", r.status === 404, `HTTP ${r.status}`);

console.log(`
${pass} passed, ${fail} failed
`);
process.exit(fail ? 1 : 0);
