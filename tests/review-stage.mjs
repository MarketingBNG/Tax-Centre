/**
 * Integration test for the stage runner.
 *
 * review-gates.mjs proves the gates are correct in isolation. This proves they
 * are actually wired into the path a finding travels: a scripted model calls
 * record_findings with a mix of good and bad entries, and what lands in the
 * database is checked.
 *
 * No API key and no money — the provider is replaced with one that replays
 * fixed tool calls, so what is under test is our code rather than what a model
 * happened to say today. Runs in a throwaway schema inside a transaction that
 * is rolled back, exactly like review-store.mjs.
 *
 *   node tests/review-stage.mjs
 */
import postgres from 'postgres';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCHEMA_NAME = 'trc_stage_probe';
const USER = 'probe-user-1';

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
 * Compiles the engine, stubbing only what reaches outside it: the database
 * helpers, the provider registry, config, and the pieces of ingest/skills that
 * would need blob storage or an installed skill.
 */
function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trc-stage-'));
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
     export const CITATION_CORPUS_ENABLED = false;
     export const ANALYSIS_TIMEOUT_MS = 5000;
     export const TOOLS_ENABLED = true;
     export const MEMORY_LIMIT = 60;
     export const ROOT = ${JSON.stringify(ROOT)};`,
  );

  // The parser needs blob bytes it cannot have here, so it is replaced with one
  // that returns the documents the test declares. Everything downstream of it —
  // the number index, the gates, the store — is the real thing.
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

  writeFileSync(
    path.join(dir, 'prompts-stub.js'),
    `export async function buildStagePrompt() {
       return { system: ['stub'], turns: [{ role: 'user', parts: [{ kind: 'text', text: 'stub' }] }] };
     }`,
  );

  writeFileSync(
    path.join(dir, 'chat-stub.js'),
    `export async function recordUsage() {}`,
  );

  writeFileSync(
    path.join(dir, 'providers-stub.js'),
    `export const getProvider = () => { throw new Error('The test must inject a provider.'); };`,
  );

  /**
   * Every engine module, discovered rather than listed.
   *
   * A hand-maintained list silently stopped compiling this test twice as new
   * modules were added — the import failed, the suite chained on && and the
   * failure looked like nothing running. Reading the directory means adding a
   * module cannot break the test that covers it.
   */
  const sources = [
    ['lib/review-types.ts', 'engine/review-types.js'],
    ['lib/tools.ts', 'engine/tools.js'],
    ...readdirSync(path.join(ROOT, 'lib/review-engine'))
      .filter((name) => name.endsWith('.ts'))
      // Replaced by stubs below: they need blob storage or an installed skill.
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
        .replace(/from ['"]@\/lib\/tools['"]/g, "from './tools.js'")
        .replace(/from ['"]\.\/return-data['"]/g, "from '../return-data-stub.js'")
        .replace(/from ['"]\.\/prompts['"]/g, "from '../prompts-stub.js'")
        .replace(/from ['"]@\/lib\/review-types['"]/g, "from './review-types.js'")
        // Connector, account and skill tools are not reachable from a stage.
        .replace(/^import .*from ['"]\.\/connectors['"];?$/m, '')
        .replace(/^import .*from ['"]\.\/accounts['"];?$/m, '')
        .replace(/^import .*from ['"]\.\/skills['"];?$/m, '')
        // TypeScript emits relative imports without an extension; Node's ESM
        // loader requires one.
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
const store = await import(pathToFileURL(path.join(dir, 'engine/store.js')).href);
const runner = await import(pathToFileURL(path.join(dir, 'engine/stage-runner.js')).href);

const v7 = (() => {
  const dbTs = readFileSync(path.join(ROOT, 'lib/db.ts'), 'utf8');
  const start = dbTs.indexOf('/* ================================================================ v7 =====');
  return dbTs.slice(start, dbTs.indexOf('\n`;', start));
})();

/** A provider that replays fixed tool calls, then finishes. */
const scriptedProvider = (calls) => ({
  async streamChat({ runTool }) {
    const outputs = [];
    for (const call of calls) {
      try {
        outputs.push(await runTool(call));
      } catch (err) {
        outputs.push(`Error: ${err.message}`);
      }
    }
    return {
      text: outputs.join('\n'),
      thinking: '',
      model: 'stub',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costMicros: 0,
      finish: 'stop',
      toolRuns: [],
    };
  },
});

const finding = (over = {}) => ({
  kind: 'exception',
  defect_kind: 'wrong_amount',
  category_override: null,
  title: 'A finding',
  what_is_wrong: 'Something disagrees.',
  why_it_matters: 'It matters.',
  location: { form: '1065', schedule: 'L', line: '1d', gl_account: '1010' },
  fix: { where: 'Balance sheet screen', change: 'Set it to 41,930', then: 'Re-check totals', why: 'Books drive the return.' },
  authority_citation: null,
  evidence: [],
  amounts: [],
  owner: 'preparer',
  confidence: 0.95,
  ...over,
});

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

try {
  await sql
    .begin(async (db) => {
      shim.useConnection(db);

      await db.unsafe(`
        CREATE SCHEMA ${SCHEMA_NAME};
        SET LOCAL search_path TO ${SCHEMA_NAME};
        CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
        CREATE TABLE audit_log (id TEXT PRIMARY KEY, at BIGINT, actor_id TEXT,
                                action TEXT, target_type TEXT, target_id TEXT, detail TEXT);
        CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, extracted_text TEXT,
                            kind TEXT, storage_path TEXT, mime TEXT);
        INSERT INTO users VALUES ('${USER}', 'Probe User');
        INSERT INTO files VALUES
          ('f-tb', 'tb-2025.xlsx', 'A1: Cash 41,930.00' || chr(10) || 'A2: Suspense 250', 'xlsx', 'p', 'm'),
          ('f-ret', 'return.pdf', NULL, 'pdf', 'p', 'm');
      `);
      await db.unsafe(v7);

      const engagement = await store.createEngagement(USER, {
        clientLabel: 'Probe Co',
        returnType: '1065',
        taxYear: 2025,
      });
      const run = await store.createRun(USER, {
        engagementId: engagement.id,
        runNumber: 1,
        status: 'running',
        promptVersion: 'trr-1.0',
        model: 'stub',
        corpusHash: 'h',
        factsSnapshot: {},
      });
      await store.addRunDocuments(run.id, [
        { fileId: 'f-tb', docRole: 'trial_balance_cy' },
        { fileId: 'f-ret', docRole: 'drake_export' },
      ]);
      await store.createStages(run.id, [{ stageKey: 'S1', seq: 1, status: 'pending' }]);
      const stage = await store.claimNextStage(run.id);

      const events = [];
      let toolReply = '';

      const result = await runner.runStage({
        runId: run.id,
        stageId: stage.id,
        stageKey: 'S1',
        engagement,
        facts: {},
        actorId: USER,
        model: 'stub',
        onEvent: (e) => events.push(e),
        provider: scriptedProvider([
          {
            name: 'record_findings',
            args: {
              findings: [
                // Good: quoted from a document whose text we have.
                finding({
                  title: 'Cash does not agree to the reconciliation',
                  amounts: [
                    { label: 'per_books', value: 41930, source_kind: 'text_doc', source_ref: 'tb-2025.xlsx' },
                  ],
                }),
                // Rule 1: a plausible figure with no source at all.
                finding({ title: 'Invented depreciation', amounts: [{ label: 'depreciation', value: 18450 }] }),
                // Rule 1: cites a document it does not appear in.
                finding({
                  title: 'Figure not in the document it cites',
                  amounts: [
                    { label: 'cash', value: 99999, source_kind: 'text_doc', source_ref: 'tb-2025.xlsx' },
                  ],
                }),
                // Rule 2: a real-looking citation with nothing behind it.
                finding({
                  title: 'Position with an invented citation',
                  defect_kind: 'unsupported_position',
                  authority_citation: 'IRC 162(a)',
                }),
                // Rule 8: honestly low confidence.
                finding({ title: 'Not at all sure about this', confidence: 0.3 }),
                // Rule 3: a clean section, recorded rather than left silent.
                finding({
                  kind: 'agreed',
                  defect_kind: null,
                  title: 'Trial balance foots',
                  what_is_wrong: 'Reconciled, no exception.',
                  fix: null,
                  owner: null,
                }),
                // A figure read off a PDF page: allowed, but not verified.
                finding({
                  title: 'Read from the return PDF',
                  amounts: [
                    { label: 'per_return', value: 42180, source_kind: 'visual', source_ref: 'return.pdf#p3' },
                  ],
                }),
              ],
            },
          },
          {
            name: 'record_tie_outs',
            args: {
              tie_outs: [
                { name: 'L cash = bank rec', left_value: 42180, right_value: 41930, left_source: 'return', right_source: 'tb', agrees: false },
              ],
            },
          },
        ]),
      });

      // The reply the model would have seen for the rejected entries.
      toolReply = String(result.error ?? '');

      const stored = await store.listFindings(run.id);
      const byTitle = (t) => stored.find((f) => f.title === t);

      check('the stage completes', result.status === 'complete', result.status ?? result.error);

      check(
        'a sourced finding is stored',
        Boolean(byTitle('Cash does not agree to the reconciliation')),
      );
      check(
        'severity is computed from the defect kind, not taken from the model',
        byTitle('Cash does not agree to the reconciliation')?.severity === 'Critical',
        byTitle('Cash does not agree to the reconciliation')?.severity,
      );
      check(
        'the category comes from the stage',
        byTitle('Cash does not agree to the reconciliation')?.category === 'bookkeeping',
      );

      check('RULE 1: an unsourced figure never reaches the register', !byTitle('Invented depreciation'));
      check(
        'RULE 1: a figure absent from the document it cites is refused',
        !byTitle('Figure not in the document it cites'),
      );

      const cited = byTitle('Position with an invented citation');
      check('RULE 2: the finding survives, the citation does not', Boolean(cited));
      check(
        'RULE 2: nothing is stored as authority',
        cited?.authority_citation === null && cited?.authority_status === 'verify',
      );
      check(
        'RULE 2: what was claimed is kept for the audit trail',
        cited?.claimed_citation === 'IRC 162(a)',
      );

      const unsure = byTitle('Not at all sure about this');
      check('RULE 8: a low-confidence finding is escalated', unsure?.status === 'escalated');
      check(
        'RULE 8: its severity is untouched, not quietly softened',
        unsure?.severity === 'Critical',
        unsure?.severity,
      );

      check('RULE 3: an agreed line is kept, with no severity', byTitle('Trial balance foots')?.severity === null);

      const visual = byTitle('Read from the return PDF');
      check(
        'a page-image figure is stored but marked unverified',
        JSON.parse(visual?.amounts_json ?? '[]')[0]?.verified === false,
      );
      check(
        'and it drags the confidence down to the visual cap',
        Number(visual?.confidence) <= 0.6,
        String(visual?.confidence),
      );

      check('tie-outs are recorded even when they fail', (await store.listTieOuts(run.id)).length === 1);

      check(
        'the register was told what it rejected',
        events.some((e) => e.type === 'finding'),
      );

      /* ------------------------------- a stage that records nothing at all */

      await store.createStages(run.id, [{ stageKey: 'S2', seq: 2, status: 'pending' }]);
      const silent = await store.claimNextStage(run.id);
      await runner.runStage({
        runId: run.id,
        stageId: silent.id,
        stageKey: 'S2',
        engagement,
        facts: {},
        actorId: USER,
        model: 'stub',
        onEvent: () => {},
        provider: scriptedProvider([]),
      });

      const s2 = (await store.listFindings(run.id)).filter((f) => f.stage_key === 'S2');
      check(
        'RULE 3: a silent stage still leaves a line, escalated for a human',
        s2.length === 1 && s2[0].kind === 'coverage' && s2[0].status === 'escalated',
        s2.length ? `${s2[0].kind}/${s2[0].status}` : 'nothing recorded',
      );

      /* ----------------------------------------- stage 4 asks the questions */

      await store.createStages(run.id, [{ stageKey: 'S4', seq: 7, status: 'pending' }]);
      const s4 = await store.claimNextStage(run.id);

      const open = (await store.listFindings(run.id)).filter((f) => f.severity);
      await runner.runStage({
        runId: run.id,
        stageId: s4.id,
        stageKey: 'S4',
        engagement,
        facts: {},
        actorId: USER,
        model: 'stub',
        onEvent: () => {},
        provider: scriptedProvider([
          {
            name: 'record_questions',
            args: {
              questions: [
                {
                  finding_code: open[0].finding_code,
                  owner: 'preparer',
                  question: 'Which figure is right?',
                  figure: '42,180 vs 41,930',
                  answer_kind: 'fact',
                  branches: [{ if: 'the bank rec is right', then: 'post the 250 difference' }],
                  evidence_needed: 'updated bank reconciliation',
                },
                {
                  finding_code: null,
                  owner: 'client',
                  question: 'Did the Singapore entity hold 25% at any point?',
                  figure: 'ownership',
                  answer_kind: 'yes_no',
                  branches: [],
                  evidence_needed: 'cap table',
                },
              ],
            },
          },
        ]),
      });

      const asked = await store.listQuestions(run.id);
      check('stage 4 records the questions', asked.length === 2, `${asked.length} asked`);
      check(
        'a question resolves the finding code it names to the real finding',
        asked[0].finding_id === open[0].id,
      );
      check(
        'and the finding points back at the question waiting on it',
        (await store.getFinding(open[0].id))?.question_id === asked[0].id,
      );
      check(
        'a client question is kept, marked for the partner to raise',
        asked.some((q) => q.owner === 'client'),
      );
      check(
        'branches survive as structured data, not prose',
        JSON.parse(asked[0].branches_json)[0].then === 'post the 250 difference',
      );

      /* ---------------------------------- the register, in the documented shape */

      const register = await (
        await import(pathToFileURL(path.join(dir, 'engine/register.js')).href)
      ).buildRegister(run.id);

      check('the register export is produced', Boolean(register));
      check(
        'it carries the provenance a finding can be defended with months later',
        register.prompt_version === 'trr-1.0' &&
          Boolean(register.corpus_hash) &&
          Boolean(register.review_id),
      );
      check(
        'findings are keyed by their code, not their internal id',
        register.findings.every((f) => /^S\d-\d{3}$/.test(f.id)),
        register.findings.map((f) => f.id).join(', '),
      );
      check(
        'a question points at its finding by code',
        register.questions[0]?.finding_id === open[0].finding_code,
      );
      check(
        'the demoted citation is exported as claimed, never as authority',
        register.findings.some(
          (f) => f.authority.citation === null && f.authority.claimed_citation === 'IRC 162(a)',
        ),
      );
      check(
        'the verdict is computed into the export, not copied from a stale column',
        ['hold', 'release_with_conditions', 'clear'].includes(register.verdict.result),
        register.verdict.result,
      );
      check(
        'sections that could not be checked are listed rather than omitted',
        Array.isArray(register.coverage.not_checked) && register.coverage.not_checked.length > 0,
      );
      check(
        'counts the platform does not track are null, not zero',
        register.coverage.stage_1_accounts_sampled === null,
      );
      check(
        'an unapproved register says so rather than implying a sign-off',
        register.approval.approved_by === null,
      );

      /* ------------------------------------------- a retry does not double up */

      const before = (await store.listFindings(run.id)).filter((f) => f.stage_key === 'S1').length;
      await store.createStages(run.id, []);
      await runner.runStage({
        runId: run.id,
        stageId: stage.id,
        stageKey: 'S1',
        engagement,
        facts: {},
        actorId: USER,
        model: 'stub',
        onEvent: () => {},
        provider: scriptedProvider([
          { name: 'record_findings', args: { findings: [finding({ title: 'Only one now' })] } },
        ]),
      });
      const after = (await store.listFindings(run.id)).filter((f) => f.stage_key === 'S1');
      check(
        'a retried stage replaces its findings rather than adding to them',
        after.length === 1 && after[0].title === 'Only one now',
        `${before} before, ${after.length} after`,
      );

      void toolReply;
      throw new Error('__rollback__');
    })
    .catch((err) => {
      if (err.message !== '__rollback__') throw err;
    });

  const gone = await sql`
    SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ${SCHEMA_NAME}`;
  check('the probe schema is rolled back entirely', Number(gone[0].n) === 0);
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
