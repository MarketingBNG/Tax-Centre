/**
 * The whole lifecycle of a review, end to end.
 *
 * review-gates.mjs proves the rules are right on their own. review-stage.mjs
 * proves one stage enforces them. This proves the sequence a reviewer actually
 * walks: a run planned from an engagement, every stage advanced in order,
 * inapplicable modules recorded rather than skipped silently, questions
 * answered with and without a document, a verdict that moves as the register
 * moves, a sign-off that lapses the moment anything changes under it, and a
 * second run that re-does only what an answer could have affected.
 *
 * No API key and no money — the provider replays fixed tool calls per stage, so
 * what is under test is the orchestration rather than what a model said today.
 * Runs in a throwaway schema inside a transaction that is rolled back, so it is
 * safe against any database including production.
 *
 *   node tests/review-lifecycle.mjs
 */
import postgres from 'postgres';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCHEMA_NAME = 'trc_lifecycle_probe';
const USER = 'probe-user-1';
const OTHER = 'probe-user-2';

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
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`ok    ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
};

/**
 * Compiles the engine, stubbing only what reaches outside it.
 *
 * The provider stub is scripted per stage. It learns which stage it is in from
 * the prompt stub, because the stage key is what the runner passes there — the
 * alternative, counting calls, would silently mis-attribute a retry.
 */
function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trc-lifecycle-'));
  mkdirSync(path.join(dir, 'engine'), { recursive: true });

  writeFileSync(
    path.join(dir, 'db-shim.js'),
    `let db = null;
     export const useConnection = (h) => { db = h; };
     const toPositional = (q) => { let n = 0; return q.replace(/\\?/g, () => '$' + ++n); };
     export async function one(q, ...p) { const r = await db.unsafe(toPositional(q), p); return r[0] ?? null; }
     export async function all(q, ...p) { return await db.unsafe(toPositional(q), p); }
     export async function run(q, ...p) { await db.unsafe(toPositional(q), p); }
     export async function audit(a, b, c, d, e) {
       await run('INSERT INTO audit_log (id, at, actor_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?,?)',
         crypto.randomUUID(), Date.now(), a, b, c ?? null, d ?? null, e === undefined ? null : JSON.stringify(e));
     }`,
  );

  writeFileSync(
    path.join(dir, 'config-stub.js'),
    `export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;
     export const REVIEW_MAX_TOOL_ROUNDS = 12;
     export const REVIEW_COST_CEILING_USD = 8;
     export const CITATION_CORPUS_ENABLED = false;
     export const ANALYSIS_TIMEOUT_MS = 5000;
     export const TOOLS_ENABLED = true;
     export const MEMORY_LIMIT = 60;
     export const ROOT = ${JSON.stringify(ROOT)};`,
  );

  // The monthly cap, drivable from the test. A live binding rather than a
  // constant so one suite can run a review both under and over the cap.
  writeFileSync(
    path.join(dir, 'spend-stub.js'),
    `let exceeded = false;
     export const setExceeded = (value) => { exceeded = value; };
     export async function spendState() {
       return { monthToDateUsd: exceeded ? 250 : 12, capUsd: 200, capped: true, exceeded };
     }
     export const capMessage = (s) =>
       \`This month's model spend has reached $\${s.monthToDateUsd.toFixed(2)} against a \` +
       \`$\${s.capUsd.toFixed(2)} cap, so nothing further will run. An admin can raise the \` +
       'cap in Admin → Usage & cost.';`,
  );

  writeFileSync(
    path.join(dir, 'return-data-stub.js'),
    `export const ModelVisualParser = {
       id: 'model-visual',
       async parse(files) {
         return {
           parts: [],
           index: [],
           documents: files.map(({ file, docRole }) => ({
             fileId: file.id, filename: file.filename, docRole,
             parserId: 'model-visual',
             confidence: file.extracted_text ? 0.95 : 0.6,
             text: file.extracted_text,
           })),
         };
       },
     };`,
  );

  // The bus carries the stage key from the prompt builder to the provider, both
  // of which are stubs here. Nothing in the engine reads it.
  writeFileSync(
    path.join(dir, 'bus.js'),
    `export const state = { stageKey: null, script: {}, calls: [] };`,
  );

  writeFileSync(
    path.join(dir, 'prompts-stub.js'),
    `import { state } from './bus.js';
     export async function buildStagePrompt({ stageKey }) {
       state.stageKey = stageKey;
       return { system: ['stub'], turns: [{ role: 'user', parts: [{ kind: 'text', text: 'stub' }] }] };
     }`,
  );

  writeFileSync(
    path.join(dir, 'chat-stub.js'),
    `export async function recordUsage() {}`,
  );

  writeFileSync(
    path.join(dir, 'providers-stub.js'),
    `import { state } from './bus.js';
     export const getProvider = () => ({
       async streamChat({ runTool }) {
         const calls = state.script[state.stageKey] ?? [];
         state.calls.push(state.stageKey);
         const outputs = [];
         for (const call of calls) {
           try { outputs.push(await runTool(call)); }
           catch (err) { outputs.push('Error: ' + err.message); }
         }
         return {
           text: outputs.join('\\n'), thinking: '', model: 'stub',
           usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
           costMicros: 0, finish: 'stop', toolRuns: [],
         };
       },
     });`,
  );

  const sources = [
    ['lib/review-types.ts', 'engine/review-types.js'],
    ['lib/tools.ts', 'engine/tools.js'],
    ...readdirSync(path.join(ROOT, 'lib/review-engine'))
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => !['return-data.ts', 'prompts.ts', 'skills-source.ts'].includes(name))
      .map((name) => [`lib/review-engine/${name}`, `engine/${name.replace(/\.ts$/, '.js')}`]),
  ];

  for (const [src, out] of sources) {
    const { outputText } = ts.transpileModule(readFileSync(path.join(ROOT, src), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: src,
    });
    writeFileSync(
      path.join(dir, out),
      outputText
        .replace(/^import ['"]server-only['"];?$/m, '')
        .replace(/from ['"]@\/lib\/db['"]/g, "from '../db-shim.js'")
        .replace(/from ['"]\.\/db['"]/g, "from '../db-shim.js'")
        .replace(/from ['"]@\/lib\/config['"]/g, "from '../config-stub.js'")
        .replace(/from ['"]\.\/config['"]/g, "from '../config-stub.js'")
        .replace(/from ['"]@\/lib\/providers['"]/g, "from '../providers-stub.js'")
        .replace(/from ['"]@\/lib\/chat['"]/g, "from '../chat-stub.js'")
        .replace(/from ['"]@\/lib\/spend['"]/g, "from '../spend-stub.js'")
        .replace(/from ['"]@\/lib\/tools['"]/g, "from './tools.js'")
        .replace(/from ['"]\.\/return-data['"]/g, "from '../return-data-stub.js'")
        .replace(/from ['"]\.\/prompts['"]/g, "from '../prompts-stub.js'")
        .replace(/from ['"]@\/lib\/review-types['"]/g, "from './review-types.js'")
        .replace(/^import .*from ['"]\.\/connectors['"];?$/m, '')
        .replace(/^import .*from ['"]\.\/accounts['"];?$/m, '')
        .replace(/^import .*from ['"]\.\/skills['"];?$/m, '')
        .replace(/from ['"](\.\.?\/[^'"]*)['"]/g, (whole, spec) =>
          spec.endsWith('.js') ? whole : `from '${spec}.js'`,
        ),
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
const { state } = await import(pathToFileURL(path.join(dir, 'bus.js')).href);
const store = await import(pathToFileURL(path.join(dir, 'engine/store.js')).href);
const orchestrator = await import(pathToFileURL(path.join(dir, 'engine/orchestrator.js')).href);
const stageDefs = await import(pathToFileURL(path.join(dir, 'engine/stage-defs.js')).href);
const gate = await import(pathToFileURL(path.join(dir, 'engine/input-gate.js')).href);
const questions = await import(pathToFileURL(path.join(dir, 'engine/questions.js')).href);
const versioning = await import(pathToFileURL(path.join(dir, 'engine/versioning.js')).href);
const verdictMod = await import(pathToFileURL(path.join(dir, 'engine/verdict.js')).href);
const register = await import(pathToFileURL(path.join(dir, 'engine/register.js')).href);
const spend = await import(pathToFileURL(path.join(dir, 'spend-stub.js')).href);

const v7 = (() => {
  const dbTs = readFileSync(path.join(ROOT, 'lib/db.ts'), 'utf8');
  const start = dbTs.indexOf('/* ================================================================ v7 =====');
  return dbTs.slice(start, dbTs.indexOf('\n`;', start));
})();

const base = (over = {}) => ({
  kind: 'exception',
  defect_kind: 'missing_evidence',
  category_override: null,
  title: 'A finding',
  what_is_wrong: 'Something is unsupported.',
  why_it_matters: 'It matters.',
  location: { form: '1065', schedule: 'L', line: '1d', gl_account: '1010' },
  fix: {
    where: 'Balance sheet screen',
    change: 'Attach the reconciliation',
    then: 'Re-check the total',
    why: 'Books drive the return.',
  },
  authority_citation: null,
  evidence: [],
  amounts: [],
  owner: 'preparer',
  confidence: 0.95,
  ...over,
});

const agreed = (title) =>
  base({
    kind: 'agreed',
    defect_kind: null,
    title,
    what_is_wrong: 'Checked, no exception.',
    fix: null,
    owner: null,
  });

/** What the scripted model does in each stage of run 1. */
const SCRIPT = {
  S0: [{ name: 'record_findings', args: { findings: [agreed('Entity, year and return type agree')] } }],
  S1: [
    {
      name: 'record_findings',
      args: {
        findings: [
          base({
            title: 'Cash reconciliation not attached',
            amounts: [{ label: 'per_books', value: 41930, source_kind: 'text_doc', source_ref: 'tb-2025.xlsx' }],
          }),
          base({
            defect_kind: 'unexplained_tieout_failure',
            title: 'Suspense account left open at year end',
            amounts: [{ label: 'suspense', value: 250, source_kind: 'text_doc', source_ref: 'tb-2025.xlsx' }],
          }),
        ],
      },
    },
  ],
  S2: [{ name: 'record_findings', args: { findings: [agreed('Ratios consistent with a business of this size')] } }],
  'S3-FED': [{ name: 'record_findings', args: { findings: [agreed('Schedules K and K-1 foot')] } }],
  S4: [
    {
      name: 'record_questions',
      args: {
        questions: [
          {
            finding_code: 'S1-001',
            owner: 'preparer',
            question: 'Which reconciliation supports the 41,930 cash balance?',
            figure: '$41,930, Schedule L line 1, GL 1010',
            answer_kind: 'document',
            branches: [
              { if: 'A reconciliation exists', then: 'Attach it and close the item' },
              { if: 'None exists', then: 'Prepare one before filing' },
            ],
            evidence_needed: 'Bank reconciliation at year end',
          },
          {
            finding_code: 'S1-002',
            owner: 'preparer',
            question: 'What are the two entries sitting in suspense at 250?',
            figure: '$250, GL 3150',
            answer_kind: 'fact',
            branches: [
              { if: 'They are known', then: 'Reclassify them' },
              { if: 'They are not', then: 'Escalate before filing' },
            ],
            evidence_needed: 'General ledger detail for 3150',
          },
        ],
      },
    },
    { name: 'record_findings', args: { findings: [agreed('Fix list and questions prepared')] } },
  ],
};

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

try {
  await sql
    .begin(async (db) => {
      shim.useConnection(db);
      state.script = SCRIPT;

      await db.unsafe(`
        CREATE SCHEMA ${SCHEMA_NAME};
        SET LOCAL search_path TO ${SCHEMA_NAME};
        CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
        CREATE TABLE audit_log (id TEXT PRIMARY KEY, at BIGINT, actor_id TEXT,
                                action TEXT, target_type TEXT, target_id TEXT, detail TEXT);
        CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, extracted_text TEXT,
                            kind TEXT, storage_path TEXT, mime TEXT);
        INSERT INTO users VALUES ('${USER}', 'Probe User'), ('${OTHER}', 'Second Reviewer');
        INSERT INTO files VALUES
          ('f-tb', 'tb-2025.xlsx', 'Cash 41,930.00' || chr(10) || 'Suspense 250', 'xlsx', 'p', 'm'),
          ('f-tb-py', 'tb-2024.xlsx', 'Cash 38,100.00', 'xlsx', 'p', 'm'),
          ('f-ret', 'return.pdf', NULL, 'pdf', 'p', 'm'),
          ('f-recon', 'bank-recon.pdf', NULL, 'pdf', 'p', 'm');
      `);
      await db.unsafe(v7);

      /* ---------------------------------------------------- the input gate */

      const short = gate.checkInputs('1065', ['drake_export']);
      check(
        'a run without the books is refused before anything is spent',
        !short.ok && short.missing.some((m) => m.role === 'trial_balance_cy'),
        short.missing.map((m) => m.role).join(', '),
      );

      const full = gate.checkInputs('1065', [
        'drake_export',
        'trial_balance_cy',
        'trial_balance_py',
        'ownership_schedule',
      ]);
      check('a complete set passes the gate', full.ok);

      /* -------------------------------------------------------------- run 1 */

      const engagement = await store.createEngagement(USER, {
        clientLabel: 'Probe Co',
        entityName: 'Probe Holdings LLC',
        returnType: '1065',
        taxYear: 2025,
      });
      const run1 = await store.createRun(USER, {
        engagementId: engagement.id,
        runNumber: await store.nextRunNumber(engagement.id),
        status: 'pending',
        promptVersion: 'trr-1.0',
        model: 'stub',
        corpusHash: 'h1',
        factsSnapshot: {},
      });
      check('the first run is numbered 1', run1.run_number === 1);

      await store.addRunDocuments(run1.id, [
        { fileId: 'f-tb', docRole: 'trial_balance_cy' },
        { fileId: 'f-tb-py', docRole: 'trial_balance_py' },
        { fileId: 'f-ret', docRole: 'drake_export' },
      ]);
      const plan = stageDefs.planStages({ returnType: '1065', facts: {} });
      await store.createStages(run1.id, plan);
      await orchestrator.recordPlannedGaps(run1.id, {
        notApplicable: plan
          .filter((s) => s.status === 'not_applicable')
          .map((s) => ({ stageKey: s.stageKey, reason: s.reason })),
        missingInputs: gate.checkInputs('1065', [
          'drake_export',
          'trial_balance_cy',
          'trial_balance_py',
          'ownership_schedule',
        ]).warnings,
      });
      check(
        'the plan carries every stage, inapplicable ones included',
        plan.length === 8 && plan.some((s) => s.status === 'not_applicable'),
        `${plan.filter((s) => s.status === 'pending').length} to run of ${plan.length}`,
      );

      let guard = 0;
      let advance;
      do {
        advance = await orchestrator.advanceRun({ runId: run1.id, actorId: USER, onEvent: () => {} });
      } while (!advance.runFinished && ++guard < 20);

      check('the run reaches a terminal state', advance.runFinished && guard < 20, `${guard + 1} advances`);
      check(
        'only applicable stages called the model',
        state.calls.join(',') === 'S0,S1,S2,S3-FED,S4',
        state.calls.join(',') || 'none',
      );

      const stages1 = await store.listStages(run1.id);
      check(
        'no stage is left pending',
        stages1.every((s) => s.status !== 'pending' && s.status !== 'running'),
        stages1.map((s) => `${s.stage_key}:${s.status}`).join(' '),
      );
      check(
        'an inapplicable module is on the register, not missing from it',
        (await store.listFindings(run1.id)).some((f) => f.stage_key === 'S3-INDIA'),
      );

      const findings1 = await store.listFindings(run1.id);
      const cash = findings1.find((f) => f.title.startsWith('Cash reconciliation'));
      const suspense = findings1.find((f) => f.title.startsWith('Suspense'));
      check('missing paperwork is graded Medium', cash?.severity === 'Medium', String(cash?.severity));
      check('an unexplained tie-out failure is graded High', suspense?.severity === 'High', String(suspense?.severity));

      const settled = await store.getRun(run1.id);
      check(
        'an open High releases with conditions rather than clearing',
        settled.verdict === 'release_with_conditions',
        String(settled.verdict),
      );

      /* ----------------------------------------------------- the Q&A loop */

      const asked = await store.listQuestions(run1.id);
      check('questions were asked and attached to findings', asked.length === 2 && asked.every((q) => q.finding_id));
      check(
        'questions are never asked about a Low finding',
        questions.selectQuestions(
          [{ findingId: 'x', question: 'q' }],
          [{ id: 'x', severity: 'Low', status: 'open' }],
        ).selected.length === 0,
      );

      // Answered in words alone. The figure was never in doubt, so a Medium
      // may rest on an explanation — and it is logged as one.
      const mediumQ = asked.find((q) => q.finding_id === cash.id);
      await store.recordAnswer(USER, mediumQ.id, {
        answerText: 'The reconciliation was prepared but filed in the prior-year binder.',
        evidenceFileIds: [],
      });
      const mediumOutcome = questions.outcomeOfAnswer({ severity: 'Medium', hasEvidence: false });
      await store.updateFindingStatus(USER, cash.id, { status: mediumOutcome.status, statusNote: mediumOutcome.note });
      check('words alone settle a Medium', mediumOutcome.status === 'answered', mediumOutcome.status);

      // The same answer against a High is not enough.
      const highQ = asked.find((q) => q.finding_id === suspense.id);
      const wordsOnly = questions.outcomeOfAnswer({ severity: 'High', hasEvidence: false });
      check(
        'words alone leave a High open',
        wordsOnly.status === 'answered_pending_evidence',
        wordsOnly.status,
      );

      await store.recordAnswer(USER, highQ.id, {
        answerText: 'Both entries were unpresented cheques; the ledger detail is attached.',
        evidenceFileIds: ['f-recon'],
      });
      const withEvidence = questions.outcomeOfAnswer({ severity: 'High', hasEvidence: true });
      await store.updateFindingStatus(USER, suspense.id, { status: withEvidence.status, statusNote: withEvidence.note });
      check('a document closes a High', withEvidence.status === 'closed');

      await orchestrator.finalise(run1.id, USER);
      const afterAnswers = await store.getRun(run1.id);
      check(
        'the verdict follows the register without a re-run',
        afterAnswers.verdict === 'clear',
        `${afterAnswers.verdict}: ${(JSON.parse(afterAnswers.verdict_json).blockers ?? []).join(' | ')}`,
      );

      /* ------------------------------------------------------- the sign-off */

      const versionSeen = await store.registerVersion(run1.id);
      const verdictJson = JSON.parse(afterAnswers.verdict_json);
      check(
        'Hold cannot be approved',
        !verdictMod.canApprove({ ...verdictJson, result: 'hold' }, 'hold').ok,
      );
      check('a clear register can be signed off', verdictMod.canApprove(verdictJson, 'clear').ok);

      await store.recordApproval(USER, run1.id, {
        registerVersionSeen: versionSeen,
        verdictSeen: 'clear',
      });
      const standing = await store.currentApproval(run1.id);
      check('the sign-off records who signed it', standing?.approver_name === 'Probe User');

      // Anything moving underneath it takes the approval with it.
      await store.updateFindingStatus(OTHER, cash.id, { status: 'open', statusNote: 'Reopened — the binder was empty.' });
      check('an approval lapses when the register changes', (await store.currentApproval(run1.id)) === null);
      check(
        'but it is still on the record',
        (await store.listApprovals(run1.id)).length === 1,
      );

      /* -------------------------------------------------------------- run 2 */

      const rerun = versioning.stagesToRerun({ touched: ['S1'] });
      check(
        'an answer about the books re-runs everything downstream of them',
        rerun.join(',') === 'S1,S2,S3-FED,S3-INTL,S3-STATE,S3-INDIA,S4',
        rerun.join(','),
      );
      check('and never re-runs scope, which nothing touched', !rerun.includes('S0'));

      const run2 = await store.createRun(USER, {
        engagementId: engagement.id,
        runNumber: await store.nextRunNumber(engagement.id),
        parentRunId: run1.id,
        status: 'pending',
        promptVersion: 'trr-1.0',
        model: 'stub',
        corpusHash: 'h2',
        factsSnapshot: {},
      });
      check('the second run is numbered 2', run2.run_number === 2);

      await store.addRunDocuments(run2.id, [
        { fileId: 'f-tb', docRole: 'trial_balance_cy' },
        { fileId: 'f-tb-py', docRole: 'trial_balance_py' },
        { fileId: 'f-ret', docRole: 'drake_export' },
      ]);

      // Stage 0 is carried forward with its finding, exactly as the rerun route
      // does it: not re-run, but still on the register.
      const carried = findings1.filter((f) => f.stage_key === 'S0');
      await store.createStages(
        run2.id,
        plan.map((s) => ({
          ...s,
          status: rerun.includes(s.stageKey)
            ? s.status
            : s.status === 'not_applicable'
              ? 'not_applicable'
              : 'carried_forward',
        })),
      );
      await orchestrator.recordPlannedGaps(run2.id, {
        notApplicable: plan
          .filter((s) => s.status === 'not_applicable')
          .map((s) => ({ stageKey: s.stageKey, reason: s.reason })),
      });
      await store.insertFindings(
        run2.id,
        'S0',
        carried.map((f) => ({
          kind: f.kind,
          defectKind: f.defect_kind,
          severity: f.severity,
          category: f.category,
          title: f.title,
          whatIsWrong: f.what_is_wrong,
          status: f.status,
          owner: f.owner,
          confidence: f.confidence,
          lineageKey: f.lineage_key,
          carriedFromFindingId: f.id,
        })),
      );

      // This time the books are clean: the reconciliation is attached and
      // suspense is cleared.
      state.script = {
        ...SCRIPT,
        S1: [{ name: 'record_findings', args: { findings: [agreed('Cash and suspense both reconcile')] } }],
        S4: [{ name: 'record_findings', args: { findings: [agreed('Nothing left to ask')] } }],
      };
      state.calls = [];

      guard = 0;
      do {
        advance = await orchestrator.advanceRun({ runId: run2.id, actorId: USER, onEvent: () => {} });
      } while (!advance.runFinished && ++guard < 20);

      check(
        'the carried-forward stage does not call the model again',
        !state.calls.includes('S0'),
        state.calls.join(',') || 'none',
      );

      const findings2 = await store.listFindings(run2.id);
      const toDiff = (rows) =>
        rows.map((f) => ({
          id: f.id,
          code: f.finding_code,
          stageKey: f.stage_key,
          severity: f.severity,
          status: f.status,
          title: f.title,
          lineageKey: f.lineage_key,
          carriedFromFindingId: f.carried_from_finding_id,
        }));

      const diff = versioning.diffRuns({
        before: toDiff(await store.listFindings(run1.id)),
        after: toDiff(findings2),
        questions: { before: 2, answeredInBefore: 2, stillOpenInAfter: 0 },
      });
      check(
        'the comparison shows the reopened item as closed by run 2',
        diff.closed.some((f) => f.id === cash.id),
        `${diff.closed.length} closed, ${diff.opened.length} new`,
      );
      check(
        'and the carried-forward scope line as unchanged, not as new',
        diff.unchanged.some((f) => f.stageKey === 'S0') && !diff.opened.some((f) => f.stageKey === 'S0'),
      );
      check('it counts the questions that were answered', diff.questionsAnswered === 2);

      const run2Settled = await store.getRun(run2.id);
      check('a clean second run clears', run2Settled.verdict === 'clear', String(run2Settled.verdict));

      /* ------------------------------------------------------ the workpaper */

      const doc = await register.buildRegister(run2.id);
      check('the register exports for the workpaper file', !!doc && !!doc.engagement);
      // The BIGINT trap: epoch millis arrive from the driver as a string, and
      // new Date(string) on one gives Invalid Date without complaining.
      check(
        'and carries a real run date, not an invalid one',
        typeof doc.run_at === 'string' && !Number.isNaN(Date.parse(doc.run_at)),
        String(doc.run_at),
      );
      check(
        'every finding it exports carries a grade field, even when the grade is none',
        Array.isArray(doc.findings) && doc.findings.every((f) => 'severity' in f && 'status' in f),
        `${doc.findings?.length} findings`,
      );
      check(
        'and what was not checked is exported as its own section',
        Array.isArray(doc.coverage?.not_checked) && doc.coverage.not_checked.length > 0,
        `${doc.coverage?.not_checked?.length} not-checked lines`,
      );

      /* --------------------------------------------------------- the brakes */

      await store.requestAbort(USER, run2.id);
      check('a stop request is recorded and readable', await store.isAbortRequested(run2.id));

      /* ---------------------------------------------------- the monthly cap */

      // The cap was reported by the admin screens for a long time and enforced
      // nowhere. Halted rather than failed, because nothing about the review is
      // wrong — the firm is out of budget for the month, and a halted run is one
      // that can carry on once somebody raises the cap.
      const capped = await store.createRun(USER, {
        engagementId: engagement.id,
        runNumber: await store.nextRunNumber(engagement.id),
        status: 'pending',
        promptVersion: 'trr-1.1',
        model: 'stub',
        corpusHash: 'cap-probe',
        factsSnapshot: {},
      });
      await store.createStages(
        capped.id,
        stageDefs.planStages({ returnType: '1065', facts: {} }),
      );

      spend.setExceeded(true);
      const stopped = await orchestrator.advanceRun({
        runId: capped.id,
        actorId: USER,
        onEvent: () => {},
      });
      spend.setExceeded(false);

      check(
        'a run stops when the month is over its cap',
        stopped.runFinished === true && stopped.runStatus === 'halted',
        String(stopped.runStatus),
      );
      check(
        'and says so in a sentence with the numbers in it',
        /cap/i.test(stopped.message ?? '') && /\$/.test(stopped.message ?? ''),
        stopped.message ?? '(no message)',
      );
      const cappedRow = await store.getRun(capped.id);
      check(
        'the reason it stopped is on the run, not only in the response',
        cappedRow?.halt_reason === 'monthly_cap',
        String(cappedRow?.halt_reason),
      );
      check(
        'no stage was claimed, so nothing was left half done',
        (await store.listStages(capped.id)).every((st) => st.status !== 'running'),
      );

      throw new Error('__rollback__');
    })
    .catch((err) => {
      if (err.message !== '__rollback__') throw err;
    });
} finally {
  await sql.end({ timeout: 5 });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
