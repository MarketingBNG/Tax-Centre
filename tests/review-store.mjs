/**
 * Store-level test for the review engine.
 *
 * Unlike smoke.mjs this needs no running server and spends no money, because
 * what it checks is SQL: the register-version bumping that rule 7 rests on, the
 * stage claim that stops two tabs running the same stage twice, and the
 * database constraint that refuses a citation nothing grounded.
 *
 * It is safe to point at any database, including the live one. Everything runs
 * inside a single transaction, in a schema of its own with search_path set to
 * that schema alone, and the transaction is rolled back at the end — so no
 * table in public is read or written, and nothing survives the run. The last
 * assertion checks exactly that.
 *
 *   node tests/review-store.mjs
 */
import postgres from 'postgres';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCHEMA_NAME = 'trc_review_probe';
const USER = 'probe-user-1';

/** Reads a key out of .env / .env.local, real environment first. */
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

/**
 * Compiles the real store.ts rather than restating its SQL here.
 *
 * A copy of the queries would drift from the ones that ship, and the queries
 * are the thing under test. The @/ alias and the server-only marker are the
 * only edits; everything else runs exactly as written.
 */
function buildStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trc-store-'));

  writeFileSync(
    path.join(dir, 'db-shim.js'),
    `let db = null;
     export const useConnection = (handle) => { db = handle; };
     const toPositional = (q) => { let n = 0; return q.replace(/\\?/g, () => '$' + ++n); };
     export async function one(q, ...p) { const r = await db.unsafe(toPositional(q), p); return r[0] ?? null; }
     export async function all(q, ...p) { return await db.unsafe(toPositional(q), p); }
     export async function run(q, ...p) { await db.unsafe(toPositional(q), p); }
     export async function audit(actorId, action, targetType, targetId, detail) {
       await run(\`INSERT INTO audit_log (id, at, actor_id, action, target_type, target_id, detail)
                  VALUES (?, ?, ?, ?, ?, ?, ?)\`,
         crypto.randomUUID(), Date.now(), actorId, action,
         targetType ?? null, targetId ?? null,
         detail === undefined ? null : JSON.stringify(detail));
     }`,
  );

  for (const [src, out] of [
    ['lib/review-types.ts', 'review-types.js'],
    ['lib/review-engine/store.ts', 'store.js'],
  ]) {
    const { outputText } = ts.transpileModule(readFileSync(path.join(ROOT, src), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: src,
    });
    writeFileSync(
      path.join(dir, out),
      outputText
        .replace(/^import ['"]server-only['"];?$/m, '')
        .replace(/from ['"]@\/lib\/db['"]/g, "from './db-shim.js'")
        .replace(/from ['"]@\/lib\/review-types['"]/g, "from './review-types.js'"),
    );
  }
  return dir;
}

/** The v7 block, sliced out of lib/db.ts so this tests the text that ships. */
function v7Block() {
  const dbTs = readFileSync(path.join(ROOT, 'lib/db.ts'), 'utf8');
  const start = dbTs.indexOf('/* ================================================================ v7 =====');
  if (start < 0) throw new Error('Could not find the v7 block in lib/db.ts');
  return dbTs.slice(start, dbTs.indexOf('\n`;', start));
}

const DATABASE_URL = envValue('DATABASE_URL') || envValue('POSTGRES_URL');
if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing from .env');
  process.exit(1);
}

const dir = buildStore();
const shim = await import(pathToFileURL(path.join(dir, 'db-shim.js')).href);
const store = await import(pathToFileURL(path.join(dir, 'store.js')).href);
const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

try {
  await sql
    .begin(async (db) => {
      shim.useConnection(db);

      // Stand-ins for the three tables the review tables reference, created
      // inside the probe schema so no foreign key can reach a real one.
      await db.unsafe(`
        CREATE SCHEMA ${SCHEMA_NAME};
        SET LOCAL search_path TO ${SCHEMA_NAME};
        CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
        CREATE TABLE files (id TEXT PRIMARY KEY);
        CREATE TABLE audit_log (id TEXT PRIMARY KEY, at BIGINT, actor_id TEXT,
                                action TEXT, target_type TEXT, target_id TEXT, detail TEXT);
        INSERT INTO users VALUES ('${USER}', 'Probe User');
        INSERT INTO files VALUES ('file-1'), ('file-2');
      `);
      await db.unsafe(v7Block());

      /* ---------------------------------------------------- engagements */

      const eng = await store.createEngagement(USER, {
        clientLabel: 'Acme Holdings',
        entityName: 'Acme Holdings LLC',
        ein: '[EIN-a3f2]',
        returnType: '1065',
        taxYear: 2025,
        periodStart: '2025-01-01',
        periodEnd: '2025-12-31',
      });
      check('engagement round-trips', eng.client_label === 'Acme Holdings' && eng.return_type === '1065');
      check('engagement patches', (await store.updateEngagement(USER, eng.id, { shortYear: true }))?.short_year === 1);

      /* ----------------------------------------------------------- facts */

      await store.assertFact(USER, eng.id, 'india_link', true, 'user');
      await store.assertFact(USER, eng.id, 'jurisdictions', ['US-FED', 'US-NJ'], 'user');
      await store.assertFact(USER, eng.id, 'india_link', false, 'stage0');

      const facts = await store.currentFacts(eng.id);
      const live = await store.listCurrentFactRows(eng.id);
      check(
        'a fact is superseded, not overwritten',
        facts.india_link === false && live.filter((r) => r.key === 'india_link').length === 1,
        `india_link=${facts.india_link}`,
      );
      check('array facts survive the round-trip', facts.jurisdictions?.[1] === 'US-NJ');

      /* ------------------------------------------------------------ runs */

      const runNumber = await store.nextRunNumber(eng.id);
      const run = await store.createRun(USER, {
        engagementId: eng.id,
        runNumber,
        status: 'pending',
        promptVersion: 'trr-1.0',
        model: 'gpt-5.6-terra',
        corpusHash: 'hash-1',
        factsSnapshot: facts,
      });
      check('runs number from 1', runNumber === 1 && run.register_version === 1);

      // BIGINT columns come back from the driver as strings. The row types say
      // number, and a string reaching `new Date()` yields Invalid Date rather
      // than throwing — which is how a bad run date reaches a printed summary
      // without anybody noticing.
      check(
        'timestamps come back as numbers, not strings',
        typeof run.created_at === 'number' && Number.isFinite(new Date(run.created_at).getTime()),
        `created_at is a ${typeof run.created_at}`,
      );
      check('the next run number advances', (await store.nextRunNumber(eng.id)) === 2);

      await store.addRunDocuments(run.id, [
        { fileId: 'file-1', docRole: 'drake_export' },
        { fileId: 'file-2', docRole: 'trial_balance_cy' },
      ]);
      check('run documents persist', (await store.listRunDocuments(run.id)).length === 2);

      /* ---------------------------------------------------------- stages */

      await store.createStages(run.id, [
        { stageKey: 'S0', seq: 0, status: 'pending' },
        { stageKey: 'S1', seq: 1, status: 'pending' },
        { stageKey: 'S3-FED', seq: 3, status: 'pending' },
        { stageKey: 'S3-INTL', seq: 4, status: 'pending' },
      ]);
      const first = await store.claimNextStage(run.id);
      const second = await store.claimNextStage(run.id);
      check(
        'stages are claimed in sequence, once each',
        first?.stage_key === 'S0' && second?.stage_key === 'S1',
        `${first?.stage_key} then ${second?.stage_key}`,
      );

      await store.completeStage(first.id, { model: 'gpt-5.6-terra', costMicros: 1200 });
      await store.failStage(second.id, 'boom');
      const retried = await store.claimNextStage(run.id);
      check(
        'a failed stage is retried before later ones',
        retried?.stage_key === 'S1' && retried.attempt === 2,
        `${retried?.stage_key} attempt ${retried?.attempt}`,
      );
      await store.completeStage(retried.id);

      /* -------------------------------------------------------- findings */

      const before = await store.registerVersion(run.id);
      const s1 = await store.insertFindings(run.id, 'S1', [
        {
          kind: 'exception',
          defectKind: 'unexplained_tieout_failure',
          severity: 'High',
          category: 'bookkeeping',
          title: 'Schedule L cash does not agree to the bank reconciliation',
          whatIsWrong: 'L line 1 is 42,180; the December reconciliation shows 41,930.',
          amounts: [
            { label: 'per_return', value: 42180, source_kind: 'visual', source_ref: 'drake.pdf#p3', verified: false },
            { label: 'per_bank_rec', value: 41930, source_kind: 'text_doc', source_ref: 'bank-dec.xlsx', verified: true },
          ],
          owner: 'preparer',
        },
        {
          kind: 'agreed',
          defectKind: null,
          severity: null,
          category: 'bookkeeping',
          title: 'Trial balance totals agree',
          whatIsWrong: 'Reconciled, no exception.',
        },
      ]);
      check('finding codes run in sequence', s1[0].finding_code === 'S1-001' && s1[1].finding_code === 'S1-002');
      check('an agreed line carries no severity', s1[1].severity === null);
      check('amounts keep their source', JSON.parse(s1[0].amounts_json)[0].source_kind === 'visual');
      check('inserting bumps the register version', (await store.registerVersion(run.id)) === before + 1);

      const fed = await store.insertFindings(run.id, 'S3-FED', [
        { kind: 'exception', defectKind: 'missing_form', severity: 'Critical', category: 'irs_return', title: 'Missing 5472', whatIsWrong: 'No 5472 for a 25% foreign owner.' },
      ]);
      const intl = await store.insertFindings(run.id, 'S3-INTL', [
        { kind: 'exception', defectKind: 'missing_form', severity: 'Critical', category: 'cross_border', title: 'Missing 8938', whatIsWrong: 'Foreign accounts exceed the threshold.' },
      ]);
      check(
        'the Stage 3 units share one S3 series',
        fed[0].finding_code === 'S3-001' && intl[0].finding_code === 'S3-002',
        `${fed[0].finding_code} then ${intl[0].finding_code}`,
      );

      const beforeStatus = await store.registerVersion(run.id);
      const moved = await store.updateFindingStatus(USER, s1[0].id, {
        status: 'answered_pending_evidence',
        statusNote: 'answered in words, nothing attached',
      });
      check(
        'a status change and its version bump land in one statement',
        moved?.status === 'answered_pending_evidence' &&
          (await store.registerVersion(run.id)) === beforeStatus + 1,
      );

      /* -------------------------------------------------------- questions */

      const questions = await store.insertQuestions(run.id, [
        {
          findingId: s1[0].id,
          owner: 'preparer',
          question: 'Which figure is right?',
          figure: '42,180 vs 41,930',
          branches: [{ if: 'the bank rec is right', then: 'post the 250 difference' }],
        },
        { owner: 'preparer', question: 'Is there a 5472 for the foreign member?' },
      ]);
      check('questions number from Q-1', questions[0].question_code === 'Q-1' && questions[1].question_code === 'Q-2');

      const answered = await store.recordAnswer(USER, questions[0].id, {
        answerText: 'The bank reconciliation is correct.',
        evidenceFileIds: ['file-2'],
        answerKind: 'fact',
      });
      check(
        'an answer records its author and evidence',
        answered?.answered_by === USER && JSON.parse(answered.answer_evidence_file_ids)[0] === 'file-2',
      );

      /* -------------------------------------------------------- approvals */

      await store.setVerdict(run.id, 'hold', { result: 'hold', critical_open: 2, high_open: 1 });
      const seen = await store.registerVersion(run.id);
      await store.recordApproval(USER, run.id, { registerVersionSeen: seen, verdictSeen: 'hold' });

      const standing = await store.currentApproval(run.id);
      check(
        'an approval stands at the version it saw',
        standing?.register_version_seen === seen && standing.approver_name === 'Probe User',
      );

      await store.updateFindingStatus(USER, s1[1].id, { status: 'closed' });
      check(
        'rule 7: changing the register lapses the approval by itself',
        (await store.currentApproval(run.id)) === null,
      );
      check('the lapsed approval is still on the record', (await store.listApprovals(run.id)).length === 1);

      /* ---------------------------------------- what the approve route checks */

      // The route refuses a stale version and refuses to approve a Hold. Both
      // decisions are made from these two values, so this asserts the values
      // the route reads rather than restating the route.
      const liveVersion = await store.registerVersion(run.id);
      check(
        'a version read before the last change no longer matches the live one',
        seen !== liveVersion,
        `read ${seen}, now ${liveVersion}`,
      );
      check(
        'the run still records the verdict the register computed',
        (await store.getRun(run.id))?.verdict === 'hold',
      );

      /* ---------------------------------------------------------- summary */

      const mine = (await store.listEngagementSummaries()).find((s) => s.id === eng.id);
      // Two open Criticals plus the High answered in words with nothing
      // attached: that one still counts, which is what the status is for.
      check(
        'the list folds in the latest run and its open Critical/High count',
        mine?.run_number === 1 && Number(mine.open_high) === 3,
        `run ${mine?.run_number}, ${mine?.open_high} open`,
      );

      /* ------------------------------------------------------ bookkeeping */

      await store.insertTieOuts(run.id, 'S1', [
        { name: 'K-1 box 1 total = Schedule K line 1', leftValue: 184220, rightValue: 184220, agrees: true },
      ]);
      check('tie-outs persist', (await store.listTieOuts(run.id)).length === 1);

      await store.recordCalc(run.id, 'S1', { code: 'money(1+1)', output: '2', values: [2] });
      check('calculations keep the figures they produced', (await store.listCalcs(run.id)).length === 1);

      await store.appendEvent(run.id, { type: 'stage', stage: 0 });
      await store.appendEvent(run.id, { type: 'stage', stage: 1 });
      const events = await store.eventsAfter(run.id, 0);
      check(
        'events replay from a cursor',
        events.length === 2 && (await store.eventsAfter(run.id, Number(events[0].id))).length === 1,
      );

      await store.clearStageOutput(run.id, 'S1');
      const left = await store.listFindings(run.id);
      check(
        'clearing a stage leaves the others alone, so a retry cannot double up',
        left.length === 2 && left.every((f) => f.stage_key.startsWith('S3')),
        `${left.length} left`,
      );

      await store.requestAbort(USER, run.id);
      check('a stop travels through the database', (await store.isAbortRequested(run.id)) === true);

      /* ------------------------------------------------------- guardrails */

      // Deliberately violating a constraint aborts the surrounding transaction,
      // so this runs inside a savepoint: the write is refused, the savepoint
      // rolls back, and the outer transaction survives to be checked.
      let refused = false;
      try {
        await db.savepoint(async (sp) => {
          shim.useConnection(sp);
          await store.insertFindings(run.id, 'S2', [
            {
              kind: 'exception',
              defectKind: 'unsupported_position',
              severity: 'High',
              category: 'financial',
              title: 'Invented authority',
              whatIsWrong: 'A citation with nothing behind it.',
              authorityStatus: 'verify',
              authorityCitation: 'IRC 162(a)',
            },
          ]);
        });
      } catch (err) {
        refused = /authority_citation|violates check constraint/i.test(String(err.message));
      } finally {
        shim.useConnection(db);
      }
      check('the database itself refuses a citation nothing grounded', refused);

      // The same finding without the citation is accepted, so the constraint is
      // rejecting the ungrounded authority and not the row.
      const demoted = await store.insertFindings(run.id, 'S2', [
        {
          kind: 'exception',
          defectKind: 'unsupported_position',
          severity: 'High',
          category: 'financial',
          title: 'Position taken with no verified authority',
          whatIsWrong: 'The principle is stated in plain English instead.',
          authorityStatus: 'verify',
          claimedCitation: 'IRC 162(a)',
        },
      ]);
      check(
        'the demoted form is accepted, with what was claimed kept for the record',
        demoted[0].authority_status === 'verify' &&
          demoted[0].authority_citation === null &&
          demoted[0].claimed_citation === 'IRC 162(a)',
      );

      throw new Error('__rollback__');
    })
    .catch((err) => {
      if (err.message !== '__rollback__') throw err;
    });

  const remaining = await sql`
    SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ${SCHEMA_NAME}`;
  check('the probe schema is rolled back entirely', Number(remaining[0].n) === 0);
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error('\n' + (err.stack ?? err.message));
} finally {
  await sql.end();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
