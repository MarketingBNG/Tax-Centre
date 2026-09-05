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
    ['lib/secrets.ts', 'secrets.js'],
    ['lib/review-engine/store.ts', 'store.js'],
    ['lib/review-engine/corpus.ts', 'corpus.js'],
    ['lib/review-engine/chart-of-accounts.ts', 'chart-of-accounts.js'],
    ['lib/review-engine/books.ts', 'books.js'],
    ['lib/review-engine/books-oauth.ts', 'books-oauth.js'],
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
        .replace(/from ['"]@\/lib\/review-types['"]/g, "from './review-types.js'")
        .replace(/from ['"]@\/lib\/secrets['"]/g, "from './secrets.js'")
        // TypeScript emits relative imports without an extension; Node's
        // loader requires one.
        .replace(/from ['"](\.\.?\/[^'"]*)['"]/g, (whole, spec) =>
          spec.endsWith('.js') ? whole : `from '${spec}.js'`,
        ),
    );
  }
  return dir;
}

/**
 * The review schema, sliced out of lib/db.ts so this tests the text that ships.
 *
 * From the v7 marker to the end of the string, so a later block — v8's corpus
 * tables, and whatever comes after — is covered without anyone remembering to
 * widen this.
 */
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
const corpus = await import(pathToFileURL(path.join(dir, 'corpus.js')).href);
const coa = await import(pathToFileURL(path.join(dir, 'chart-of-accounts.js')).href);
const booksStore = await import(pathToFileURL(path.join(dir, 'books.js')).href);

// Token encryption derives its key from AUTH_SECRET. Supplied here so the
// connection tests exercise the real encrypt/decrypt path rather than a stub —
// the point of storing a grant encrypted is that it comes back out again.
process.env.AUTH_SECRET ||= envValue('AUTH_SECRET') || 'probe-secret-for-tests-only';
const booksOauth = await import(pathToFileURL(path.join(dir, 'books-oauth.js')).href);

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

      /* ------------------------- confirming a figure nothing could verify */

      const [visualFinding] = await store.insertFindings(run.id, 'S3-FED', [
        {
          kind: 'exception',
          defectKind: 'wrong_amount',
          severity: 'Critical',
          category: 'irs_return',
          title: 'Schedule L cash disagrees with the books',
          whatIsWrong: 'Read off the return PDF; nothing here can check it.',
          status: 'escalated',
          statusNote: 'per_return (42180) could only be read off a page image.',
          amounts: [
            {
              label: 'per_return',
              value: 42180,
              source_kind: 'visual',
              source_ref: 'return.pdf#p3',
              verified: false,
              confidence: 0.6,
              needs_confirmation: true,
              confirmed_by: null,
              confirmed_at: null,
            },
          ],
        },
      ]);

      const confirmed = await store.confirmAmount(USER, visualFinding.id, 'per_return');
      const confirmedAmounts = JSON.parse(confirmed.amounts_json);
      check(
        'confirming a figure records who did it and when',
        confirmedAmounts[0].confirmed_by === USER &&
          typeof confirmedAmounts[0].confirmed_at === 'number' &&
          confirmedAmounts[0].needs_confirmation === false,
      );
      check(
        'the figure keeps saying it was read off a page — that fact does not go away',
        confirmedAmounts[0].source_kind === 'visual' && confirmedAmounts[0].verified === false,
      );
      check(
        'and the finding comes back off the escalation queue',
        confirmed.status === 'open',
        confirmed.status,
      );
      check(
        'confirming the same figure twice changes nothing further',
        JSON.parse((await store.confirmAmount(USER, visualFinding.id, 'per_return')).amounts_json)[0]
          .confirmed_by === USER,
      );

      const lowConfidence = await store.insertFindings(run.id, 'S3-FED', [
        {
          kind: 'exception',
          defectKind: 'wrong_amount',
          severity: 'Critical',
          category: 'irs_return',
          title: 'Something the model was unsure of',
          whatIsWrong: 'Low confidence, not a page-read problem.',
          status: 'escalated',
          statusNote: 'Confidence 0.30 is below the 0.7 threshold — needs a reviewer.',
          amounts: [
            {
              label: 'per_return',
              value: 42180,
              source_kind: 'visual',
              source_ref: 'return.pdf#p3',
              verified: false,
              needs_confirmation: true,
            },
          ],
        },
      ]);
      check(
        'a finding escalated for low confidence stays escalated even once its figure is confirmed',
        (await store.confirmAmount(USER, lowConfidence[0].id, 'per_return')).status === 'escalated',
      );

      /* ------------------------------------------------ the authority corpus */

      const year = (y) => Date.UTC(y, 0, 1);

      await corpus.ingestSource(USER, {
        kind: 'form_instructions',
        title: 'Instructions for Form 1065 (2025)',
        versionLabel: '2025',
        effectiveFrom: year(2025),
        passages: [
          {
            citation: 'Instructions to Form 1065, Schedule L',
            heading: 'Balance Sheets per Books',
            body:
              'The balance sheet should agree with the partnership books and records. ' +
              'Attach a statement explaining any differences.',
          },
        ],
      });

      const found = await corpus.lookupCitation('Instructions to Form 1065, Schedule L', year(2026));
      check('a loaded source is retrievable by its citation', found.length === 1, `${found.length} hits`);

      const grounded = await corpus.verifyCitation({
        citation: 'Instructions to Form 1065, Schedule L',
        quote: 'The balance sheet should agree with the partnership books and records',
        asOf: year(2026),
      });
      check(
        'a citation whose quoted words are in the passage is grounded',
        grounded.ok === true && grounded.sourceSpan.includes('Instructions for Form 1065'),
        grounded.ok ? grounded.sourceSpan : grounded.reason,
      );

      const wrongWords = await corpus.verifyCitation({
        citation: 'Instructions to Form 1065, Schedule L',
        quote: 'The balance sheet need not agree with the books in any material respect',
        asOf: year(2026),
      });
      check(
        'PROBE: a real citation with words it does not contain is refused',
        wrongWords.ok === false && /do not appear/.test(wrongWords.reason),
        wrongWords.ok ? 'granted' : wrongWords.reason.slice(0, 60),
      );

      const noQuote = await corpus.verifyCitation({
        citation: 'Instructions to Form 1065, Schedule L',
        quote: null,
        asOf: year(2026),
      });
      check(
        'a reference with nothing quoted is not authority',
        noQuote.ok === false && /quoted words/.test(noQuote.reason),
      );

      const invented = await corpus.verifyCitation({
        citation: 'IRC 7999(z)(4)',
        quote: 'Notwithstanding any other provision of this subtitle, the taxpayer shall prevail',
        asOf: year(2026),
      });
      check(
        'PROBE: a citation nothing in the corpus addresses is refused',
        invented.ok === false && /Nothing in the corpus/.test(invented.reason),
      );

      const tooEarly = await corpus.verifyCitation({
        citation: 'Instructions to Form 1065, Schedule L',
        quote: 'The balance sheet should agree with the partnership books and records',
        asOf: year(2019),
      });
      check(
        'a source that was not yet in force is not authority for an earlier year',
        tooEarly.ok === false,
        tooEarly.ok ? 'granted' : 'refused',
      );

      const beforeCorpus = await corpus.corpusFingerprint(year(2026));
      await corpus.ingestSource(USER, {
        kind: 'firm_sop',
        title: 'Firm SOP — partner capital reconciliation',
        effectiveFrom: year(2025),
        passages: [
          {
            citation: 'Firm SOP 4.2',
            body: 'Partner capital per Schedule L must be reconciled to Schedule M-2 every year.',
          },
        ],
      });
      const afterCorpus = await corpus.corpusFingerprint(year(2026));
      check(
        'the corpus fingerprint moves when the corpus does, so a run says which state it read',
        beforeCorpus.fingerprint !== afterCorpus.fingerprint &&
          afterCorpus.sources === beforeCorpus.sources + 1,
        `${beforeCorpus.sources} → ${afterCorpus.sources}`,
      );

      const reloaded = await corpus.ingestSource(USER, {
        kind: 'firm_sop',
        title: 'Firm SOP — partner capital reconciliation',
        effectiveFrom: year(2025),
        passages: [
          {
            citation: 'Firm SOP 4.2',
            body: 'Partner capital per Schedule L must be reconciled to Schedule M-2 every year.',
          },
        ],
      });
      const stillOne = await corpus.corpusFingerprint(year(2026));
      check(
        'loading the same text twice does not create a second source to disagree with the first',
        stillOne.sources === afterCorpus.sources && reloaded.passages === 1,
        `${stillOne.sources} sources`,
      );

      let undated = null;
      try {
        await corpus.ingestSource(USER, {
          kind: 'irc',
          title: 'Undated section',
          effectiveFrom: Number.NaN,
          passages: [{ citation: 'IRC 162', body: 'There shall be allowed as a deduction…' }],
        });
      } catch (err) {
        undated = err.message;
      }
      check(
        'a source with no effective date cannot be loaded at all',
        undated !== null && /date it took effect/.test(undated),
        undated?.slice(0, 50),
      );

      /* ------------------------------------------------- books, normalised */

      const TB = [
        'Account,Description,Debit,Credit',
        '1010,Operating cash,41930.00,',
        '1200,Sundry Debtors,88400.00,',
        '3200,Owner draws,72000.00,',
        '4000,Revenue,,202330.00',
        '9100,Zylkon reserve movement,,0.00',
      ].join('\n');

      const source = {
        id: 'spreadsheet',
        label: 'Uploaded trial balance',
        async fetch() {
          return { accounts: coa.parseTrialBalanceText(TB).accounts, extractedAt: 1_760_000_000_000 };
        },
      };

      const imported = await booksStore.recordImport(USER, {
        engagementId: eng.id,
        source,
        ref: 'file-1',
        periodStart: '2025-01-01',
        periodEnd: '2025-12-31',
      });
      check(
        'an import records how many accounts it read and how many it could not place',
        imported.import.row_count === 5 && imported.unmapped === 1,
        `${imported.mapped} mapped, ${imported.unmapped} unmapped`,
      );
      check(
        'the extraction date comes from the source, not from when it was imported',
        Number(imported.import.extracted_at) === 1_760_000_000_000 &&
          Number(imported.import.created_at) !== 1_760_000_000_000,
      );
      check(
        'and the period it covers is recorded separately from both',
        imported.import.period_start === '2025-01-01' && imported.import.period_end === '2025-12-31',
      );

      const stored = await booksStore.importAccounts(imported.import.id);
      const draws = stored.find((a) => a.source_code === '3200');
      check(
        'the client\'s own code and name survive beside the standard key',
        draws.source_name === 'Owner draws' && draws.mapped_key === 'distributions',
        `${draws.source_code} ${draws.source_name} → ${draws.mapped_key}`,
      );
      check(
        'an account nothing recognised is stored unmapped, with the reason',
        (() => {
          const unknown = stored.find((a) => a.source_code === '9100');
          return unknown.mapped_key === null && /does not match/.test(unknown.mapping_reason);
        })(),
      );

      const again = await booksStore.recordImport(USER, {
        engagementId: eng.id,
        source,
        ref: 'file-1',
      });
      check(
        'importing the same books twice does not create a second version to disagree with the first',
        again.duplicate === true && again.import.id === imported.import.id,
      );

      const block = await booksStore.normalisedBooksBlock(eng.id);
      check(
        'the stage is given the mapped accounts and told what could not be mapped',
        block.includes('distributions') && block.includes('could not be mapped'),
      );
      check(
        'and is told to quote the client\'s own account rather than the standard key',
        /preparer/i.test(block),
      );

      /* --------------------------------------- earlier years, same client */

      const priorYear = await store.createEngagement(USER, {
        clientLabel: 'Acme Holdings',
        entityName: 'Acme Holdings LLC',
        ein: '[EIN-a3f2]',
        returnType: '1065',
        taxYear: 2024,
      });
      // Same label, different client. The label is free text a colleague will
      // spell their own way, so it must not be what joins years together when
      // there is an EIN to join on.
      await store.createEngagement(USER, {
        clientLabel: 'Acme Holdings',
        ein: '[EIN-9999]',
        returnType: '1065',
        taxYear: 2024,
      });

      const priors = await store.priorYearEngagements(eng);
      check(
        'an earlier year for the same EIN is found',
        priors.length === 1 && priors[0].id === priorYear.id,
        priors.map((p) => `${p.tax_year} ${p.ein}`).join(', '),
      );
      check(
        'a later year is not offered as history for an earlier one',
        (await store.priorYearEngagements(priorYear)).length === 0,
      );

      const noEinThis = await store.createEngagement(USER, {
        clientLabel: 'Bharat Textiles',
        returnType: '1120',
        taxYear: 2025,
      });
      const noEinPrior = await store.createEngagement(USER, {
        clientLabel: 'Bharat Textiles',
        returnType: '1120',
        taxYear: 2024,
      });
      await store.createEngagement(USER, {
        clientLabel: 'Bharat Textiles Pvt Ltd',
        returnType: '1120',
        taxYear: 2024,
      });
      const byLabel = await store.priorYearEngagements(noEinThis);
      check(
        'with no EIN it falls back to the exact label',
        byLabel.length === 1 && byLabel[0].id === noEinPrior.id,
        byLabel.map((p) => p.client_label).join(', '),
      );

      // A run that never got past the input gate recorded nothing, and must not
      // present itself as a year that was reviewed and found clean.
      const priorRun = await store.createRun(USER, {
        engagementId: priorYear.id,
        runNumber: await store.nextRunNumber(priorYear.id),
        status: 'blocked_inputs',
        promptVersion: 'trr-1.0',
        model: 'gpt-5.6-terra',
        corpusHash: 'hash-prior',
        factsSnapshot: {},
      });
      check(
        'a run blocked on its inputs is not a year that can be compared',
        (await store.latestReviewedRun(priorYear.id)) === null,
      );
      await store.setRunStatus(priorRun.id, 'complete');
      check(
        'a finished run is',
        (await store.latestReviewedRun(priorYear.id))?.id === priorRun.id,
      );

      /* ------------------------------------- client books connections (v10) */

      /**
       * The OAuth dance, minus the network.
       *
       * The token exchange itself needs a vendor, so what is checked here is
       * everything around it: that an authorisation is recorded before the
       * browser leaves, that the URL carries what each vendor requires, and
       * that a used or stale state cannot be presented twice.
       */
      const qbo = booksOauth.booksProvider('quickbooks');
      const zoho = booksOauth.booksProvider('zoho');

      check('every books provider is addressable by id', Boolean(qbo && zoho));
      check(
        'a provider with no credentials reports itself unconfigured',
        booksOauth.isConfigured({ ...qbo, clientId: () => '', clientSecret: () => '' }) === false,
      );

      // Stand-in credentials: registering a real developer app is the firm's
      // job, and none of this code path needs a real one to be exercised.
      const fakeQbo = {
        ...qbo,
        clientId: () => 'test-client-id',
        clientSecret: () => 'test-client-secret',
      };
      const fakeZoho = {
        ...zoho,
        clientId: () => 'test-client-id',
        clientSecret: () => 'test-client-secret',
      };

      check(
        'an unregistered provider refuses to start and says how to register it',
        await (async () => {
          try {
            await booksOauth.startAuthorization({
              provider: { ...qbo, clientId: () => '', clientSecret: () => '' },
              clientKey: '00-0000000',
              redirectUri: 'https://example.test/api/books/quickbooks/callback',
            });
            return false;
          } catch (err) {
            return /developer\.intuit\.com/.test(err.message);
          }
        })(),
      );

      const started = await booksOauth.startAuthorization({
        provider: fakeQbo,
        clientKey: '00-0000000',
        engagementId: eng.id,
        redirectUri: 'https://example.test/api/books/quickbooks/callback',
        startedBy: USER,
      });
      const startedUrl = new URL(started.url);

      check(
        'the authorisation asks for the accounting scope and nothing wider',
        startedUrl.searchParams.get('scope') === 'com.intuit.quickbooks.accounting',
        startedUrl.searchParams.get('scope') ?? '',
      );
      check(
        'the verifier never travels: only its hash is on the URL',
        startedUrl.searchParams.get('code_challenge_method') === 'S256' &&
          !started.url.includes(
            (
              await db.unsafe(`SELECT code_verifier FROM books_oauth_states WHERE state = $1`, [
                started.state,
              ])
            )[0].code_verifier,
          ),
      );
      check(
        'Zoho is asked for offline access, or the grant dies in an hour',
        await (async () => {
          const z = await booksOauth.startAuthorization({
            provider: fakeZoho,
            clientKey: '00-0000000',
            redirectUri: 'https://example.test/api/books/zoho/callback',
            region: 'in',
          });
          const u = new URL(z.url);
          return (
            u.searchParams.get('access_type') === 'offline' &&
            u.host === 'accounts.zoho.in'
          );
        })(),
      );

      check(
        'an unknown state is refused',
        await (async () => {
          try {
            await booksOauth.completeAuthorization({
              state: 'never-issued',
              code: 'x',
              redirectUri: 'https://example.test/cb',
              callbackParams: new URLSearchParams(),
            });
            return false;
          } catch (err) {
            return /not one this server started/.test(err.message);
          }
        })(),
      );

      check(
        'presenting a state consumes it, so a code cannot be replayed',
        await (async () => {
          const pending = await booksOauth.startAuthorization({
            provider: fakeQbo,
            clientKey: '00-0000000',
            redirectUri: 'https://example.test/cb',
          });
          // First attempt fails at the network, which is fine — what matters
          // is that the row is gone afterwards.
          await booksOauth
            .completeAuthorization({
              state: pending.state,
              code: 'x',
              redirectUri: 'https://example.test/cb',
              callbackParams: new URLSearchParams(),
            })
            .catch(() => {});
          const left = await db.unsafe(
            `SELECT COUNT(*) AS n FROM books_oauth_states WHERE state = $1`,
            [pending.state],
          );
          return Number(left[0].n) === 0;
        })(),
      );

      check(
        'a stale authorisation is refused rather than completed late',
        await (async () => {
          const pending = await booksOauth.startAuthorization({
            provider: fakeQbo,
            clientKey: '00-0000000',
            redirectUri: 'https://example.test/cb',
          });
          await db.unsafe(`UPDATE books_oauth_states SET created_at = $1 WHERE state = $2`, [
            Date.now() - 60 * 60 * 1000,
            pending.state,
          ]);
          try {
            await booksOauth.completeAuthorization({
              state: pending.state,
              code: 'x',
              redirectUri: 'https://example.test/cb',
              callbackParams: new URLSearchParams(),
            });
            return false;
          } catch (err) {
            return /took too long/.test(err.message);
          }
        })(),
      );

      /* -------------------------------- a stored grant, and how it goes bad */

      const { encryptSecret } = await import(pathToFileURL(path.join(dir, 'secrets.js')).href);

      const storeGrant = async (overrides = {}) => {
        const row = {
          id: crypto.randomUUID(),
          client_key: '00-0000000',
          provider: 'quickbooks',
          external_id: '9130000000000000',
          external_label: 'Probe Co',
          data_region: null,
          access_token: encryptSecret('live-access-token'),
          refresh_token: encryptSecret('live-refresh-token'),
          expires_at: Date.now() + 60 * 60 * 1000,
          scope: 'com.intuit.quickbooks.accounting',
          revoked_at: null,
          last_error: null,
          connected_by: USER,
          created_at: Date.now(),
          updated_at: Date.now(),
          ...overrides,
        };
        await db.unsafe(
          `INSERT INTO books_connections
             (id, client_key, provider, external_id, external_label, data_region,
              access_token, refresh_token, expires_at, scope, revoked_at, last_error,
              connected_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          Object.values(row),
        );
        return row;
      };

      const liveGrant = await storeGrant();
      check(
        'a stored grant comes back decrypted and usable',
        (await booksOauth.resolveConnection(liveGrant)).accessToken === 'live-access-token',
      );
      check(
        'the token is not readable from the row itself',
        !JSON.stringify(liveGrant).includes('live-access-token'),
      );

      check(
        'a withdrawn grant says reconnect rather than failing at import time',
        await (async () => {
          const revoked = await storeGrant({
            id: crypto.randomUUID(),
            external_id: '9130000000000001',
            revoked_at: Date.now(),
          });
          try {
            await booksOauth.resolveConnection(revoked);
            return false;
          } catch (err) {
            return /Reconnect it before importing/.test(err.message);
          }
        })(),
      );

      /**
       * The case that would otherwise look like a vendor outage: AUTH_SECRET
       * was rotated, so the ciphertext is inert. That is the encryption working
       * — and it has to read as "reconnect", not as a crash.
       */
      check(
        'tokens encrypted under a rotated key read as needing reconnection',
        await (async () => {
          const stale = await storeGrant({
            id: crypto.randomUUID(),
            external_id: '9130000000000002',
            access_token: 'not.valid.ciphertext',
            refresh_token: null,
            expires_at: Date.now() + 60 * 60 * 1000,
          });
          try {
            await booksOauth.resolveConnection(stale);
            return false;
          } catch (err) {
            return /could not be decrypted/.test(err.message);
          }
        })(),
      );

      check(
        'a grant that failed is marked on the row, so the screen can explain it',
        await (async () => {
          const row = await db.unsafe(
            `SELECT revoked_at, last_error FROM books_connections WHERE external_id = $1`,
            ['9130000000000002'],
          );
          return row[0].revoked_at !== null && /rotated/.test(row[0].last_error ?? '');
        })(),
      );

      /*
       * The duplicate has to be attempted inside a savepoint.
       *
       * A constraint violation aborts the enclosing Postgres transaction, so
       * catching the error in JavaScript is not enough — every later statement
       * would fail with "current transaction is aborted" and the real failure
       * would be buried under it.
       */
      check(
        'one client cannot hold two grants for the same company twice over',
        await (async () => {
          let refused = false;
          await db
            .savepoint(async (sp) => {
              await sp.unsafe(
                `INSERT INTO books_connections
                   (id, client_key, provider, external_id, access_token, scope,
                    created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                  crypto.randomUUID(),
                  '00-0000000',
                  'quickbooks',
                  '9130000000000000',
                  encryptSecret('second-token'),
                  '',
                  Date.now(),
                  Date.now(),
                ],
              );
            })
            .catch(() => {
              refused = true;
            });

          const after = await db.unsafe(
            `SELECT COUNT(*) AS n FROM books_connections WHERE external_id = $1`,
            ['9130000000000000'],
          );
          return refused && Number(after[0].n) === 1;
        })(),
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
