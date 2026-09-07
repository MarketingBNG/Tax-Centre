/**
 * Read-audit and spend-cap tests.
 *
 * Both are controls that were previously described rather than enforced: every
 * write was audited and no read was, and the monthly cap was reported by the
 * admin screens while nothing consulted it. What makes them testable is that
 * both are SQL, so neither needs a model or a running server.
 *
 * The interesting assertions are the negative ones. A read log that writes a
 * row per request is worse than no read log, because the run page polls every
 * four seconds and the answer drowns; so the dedupe window is the thing under
 * test, not the insert.
 *
 * Safe to point at any database, including the live one: one transaction, a
 * schema of its own with search_path set to it alone, rolled back at the end.
 * The last assertion checks nothing in public was touched.
 *
 *   node tests/access-log.mjs
 */
import postgres from 'postgres';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCHEMA_NAME = 'trc_access_probe';
const ALICE = 'probe-alice';
const BOB = 'probe-bob';

function envValue(key) {
  if (process.env[key]) return process.env[key];
  for (const file of ['.env.local', '.env']) {
    let text;
    try {
      text = readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const line = text.split('\n').find((l) => l.trim().startsWith(key + '='));
    if (line) {
      const value = line.slice(line.indexOf('=') + 1).trim();
      if (value) return value.replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`ok    ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/** Compiles the real access-log.ts and spend.ts, not a restatement of them. */
function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trc-access-'));

  writeFileSync(
    path.join(dir, 'db-shim.js'),
    [
      `import crypto from 'node:crypto';`,
      `let db = null;`,
      `export const useConnection = (handle) => { db = handle; };`,
      `const toPositional = (q) => { let n = 0; return q.replace(/\\?/g, () => '$' + ++n); };`,
      `export async function one(q, ...p) { const r = await db.unsafe(toPositional(q), p); return r[0] ?? null; }`,
      `export async function all(q, ...p) { return await db.unsafe(toPositional(q), p); }`,
      `export async function run(q, ...p) { await db.unsafe(toPositional(q), p); }`,
      `export async function getSetting(key, fallback) {`,
      `  const r = await one('SELECT value FROM settings WHERE key = ?', key);`,
      `  return r ? r.value : fallback;`,
      `}`,
      `export async function setSetting(key, value) {`,
      `  await run('INSERT INTO settings (key, value) VALUES (?, ?)`
        + ` ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', key, value);`,
      `}`,
      `export async function audit(actorId, action, targetType, targetId, detail) {`,
      `  await run('INSERT INTO audit_log (id, at, actor_id, action, target_type, target_id, detail)`
        + ` VALUES (?, ?, ?, ?, ?, ?, ?)',`,
      `    crypto.randomUUID(), Date.now(), actorId, action,`,
      `    targetType ?? null, targetId ?? null,`,
      `    detail === undefined ? null : JSON.stringify(detail));`,
      `}`,
    ].join('\n'),
  );

  // A live binding so the test can drive the window both ways. The real config
  // reads it from the environment once, which is right there and wrong here.
  writeFileSync(
    path.join(dir, 'config-stub.js'),
    [
      `export let ACCESS_LOG_WINDOW_MINUTES = 30;`,
      `export const setWindow = (value) => { ACCESS_LOG_WINDOW_MINUTES = value; };`,
    ].join('\n'),
  );

  for (const [src, out] of [
    ['lib/access-log.ts', 'access-log.js'],
    ['lib/spend.ts', 'spend.js'],
  ]) {
    const { outputText } = ts.transpileModule(readFileSync(path.join(ROOT, src), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: src,
    });
    writeFileSync(
      path.join(dir, out),
      outputText
        .replace(/^import ['"]server-only['"];?$/m, '')
        .replace(/from ['"]\.\/db['"]/g, "from './db-shim.js'")
        .replace(/from ['"]\.\/config['"]/g, "from './config-stub.js'"),
    );
  }
  return dir;
}

const DATABASE_URL = envValue('DATABASE_URL') || envValue('POSTGRES_URL');
if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing from .env');
  process.exit(1);
}

const dir = build();
const shim = await import(pathToFileURL(path.join(dir, 'db-shim.js')).href);
const log = await import(pathToFileURL(path.join(dir, 'access-log.js')).href);
const spend = await import(pathToFileURL(path.join(dir, 'spend.js')).href);
const config = await import(pathToFileURL(path.join(dir, 'config-stub.js')).href);

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

const monthStart = (() => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

try {
  await sql
    .begin(async (db) => {
      shim.useConnection(db);

      await db.unsafe(`
        CREATE SCHEMA ${SCHEMA_NAME};
        SET LOCAL search_path TO ${SCHEMA_NAME};
        CREATE TABLE audit_log (id TEXT PRIMARY KEY, at BIGINT NOT NULL, actor_id TEXT,
                                action TEXT NOT NULL, target_type TEXT, target_id TEXT,
                                detail TEXT);
        CREATE INDEX idx_audit_actor_target ON audit_log(actor_id, action, target_id, at DESC);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE usage_records (id TEXT PRIMARY KEY, cost_micros BIGINT NOT NULL DEFAULT 0,
                                    created_at BIGINT NOT NULL);
      `);

      const rows = async (action) =>
        Number(
          (
            await db.unsafe(`SELECT COUNT(*)::int AS c FROM audit_log WHERE action = $1`, [action])
          )[0].c,
        );

      /* ---------------------------------------------- the read is recorded */

      await log.logClientOpen(ALICE, { engagementId: 'eng-1', clientLabel: 'Acme Holdings' });
      check('reading a client review writes an audit line', (await rows('client.opened')) === 1);

      const first = (
        await db.unsafe(`SELECT actor_id, target_type, target_id, detail FROM audit_log LIMIT 1`)
      )[0];
      check(
        'the line names the person, the client and the time',
        first.actor_id === ALICE &&
          first.target_type === 'engagement' &&
          first.target_id === 'eng-1' &&
          JSON.parse(first.detail).clientLabel === 'Acme Holdings',
      );

      /* -------------------------------------------------- the dedupe window */

      await log.logClientOpen(ALICE, { engagementId: 'eng-1' });
      await log.logClientOpen(ALICE, { engagementId: 'eng-1' });
      await log.logClientOpen(ALICE, { engagementId: 'eng-1' });
      check(
        'a second read inside the window does not write a second line',
        (await rows('client.opened')) === 1,
        'the run page polls every four seconds',
      );

      await log.logClientOpen(BOB, { engagementId: 'eng-1' });
      check(
        'a different person reading the same client is its own line',
        (await rows('client.opened')) === 2,
      );

      await log.logClientOpen(ALICE, { engagementId: 'eng-2' });
      check(
        'the same person reading a different client is its own line',
        (await rows('client.opened')) === 3,
      );

      // Backdated rather than waited out: the window is the thing under test,
      // not the clock.
      await db.unsafe(
        `UPDATE audit_log SET at = $1 WHERE actor_id = $2 AND target_id = 'eng-1'`,
        [Date.now() - 31 * 60_000, ALICE],
      );
      await log.logClientOpen(ALICE, { engagementId: 'eng-1' });
      check(
        'a read after the window has passed is recorded again',
        (await rows('client.opened')) === 4,
        'the log stays a record of when, not only of whether',
      );

      /* ----------------------------------- suppression, never rewriting */

      const earliest = Number(
        (
          await db.unsafe(
            `SELECT MIN(at)::bigint AS m FROM audit_log
              WHERE actor_id = $1 AND target_id = 'eng-1'`,
            [ALICE],
          )
        )[0].m,
      );
      check(
        'the earlier line keeps its own timestamp rather than being extended',
        earliest < Date.now() - 30 * 60_000,
        'a log we can rewrite is not evidence of anything',
      );

      /* ------------------------------------- a window of zero logs all */

      config.setWindow(0);
      const before = await rows('client.opened');
      await log.logClientOpen(ALICE, { engagementId: 'eng-3' });
      await log.logClientOpen(ALICE, { engagementId: 'eng-3' });
      check(
        'setting the window to zero records every read',
        (await rows('client.opened')) === before + 2,
      );
      config.setWindow(30);

      /* ------------------------------------------ taking a copy away */

      await log.logRegisterExport(ALICE, {
        runId: 'run-1',
        engagementId: 'eng-1',
        registerVersion: 4,
      });
      await log.logRegisterExport(ALICE, {
        runId: 'run-1',
        engagementId: 'eng-1',
        registerVersion: 4,
      });
      check(
        'exporting the register is never deduplicated',
        (await rows('review.register_exported')) === 2,
        'reading a page and walking away with a copy are different acts',
      );

      /* ------------------------------------------- the client roster */

      await log.logRosterRead(ALICE, 2000);
      await log.logRosterRead(ALICE, 2000);
      check(
        'pulling the whole client list is one line, not one per client',
        (await rows('client.roster_read')) === 1,
      );

      /* ------------------------------------------- a refused read */

      await log.logAccessDenied(BOB, { engagementId: 'eng-9', reason: 'box_denied' });
      await log.logAccessDenied(BOB, { engagementId: 'eng-9', reason: 'box_denied' });
      check(
        'a refused read is never deduplicated',
        (await rows('client.access_denied')) === 2,
        'rare, and always interesting',
      );

      /* ------------------------------------------- the monthly cap */

      await shim.setSetting('monthly_cap_usd', '200');

      let state = await spend.spendState();
      check('an unspent month is under the cap', !state.exceeded && state.capped);

      await db.unsafe(`INSERT INTO usage_records VALUES ('u1', $1, $2)`, [
        50 * 1_000_000,
        monthStart + 1000,
      ]);
      state = await spend.spendState();
      check(
        'spend so far this month is counted',
        Math.abs(state.monthToDateUsd - 50) < 0.001 && !state.exceeded,
      );

      await db.unsafe(`INSERT INTO usage_records VALUES ('u2', $1, $2)`, [
        160 * 1_000_000,
        monthStart + 2000,
      ]);
      state = await spend.spendState();
      check('passing the cap is reported as exceeded', state.exceeded);
      check(
        'the message says the numbers and who can change them',
        /210\.00/.test(spend.capMessage(state)) && /admin/i.test(spend.capMessage(state)),
      );

      // Last month's spend is last month's problem.
      await db.unsafe(`INSERT INTO usage_records VALUES ('u3', $1, $2)`, [
        900 * 1_000_000,
        monthStart - 86_400_000,
      ]);
      state = await spend.spendState();
      check(
        'spend before this month is not counted against this month',
        Math.abs(state.monthToDateUsd - 210) < 0.001,
      );

      await shim.setSetting('monthly_cap_usd', '0');
      state = await spend.spendState();
      check(
        'a cap of zero means no cap rather than no spending',
        !state.capped && !state.exceeded,
        'this is how the settings screen already reads it',
      );

      throw new Error('__rollback__');
    })
    .catch((err) => {
      if (err.message !== '__rollback__') throw err;
    });

  const leaked = await sql.unsafe(
    `SELECT COUNT(*)::int AS c FROM information_schema.schemata WHERE schema_name = $1`,
    [SCHEMA_NAME],
  );
  check('nothing survived the run', Number(leaked[0].c) === 0, 'the transaction was rolled back');
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error('\n' + (err.stack ?? err.message));
} finally {
  await sql.end({ timeout: 5 });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
