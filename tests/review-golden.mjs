/**
 * The golden-return eval suite.
 *
 * Items 23 and 24 of the build guidance. Each fixture under
 * tests/fixtures/golden is a small engagement with known defects, so a change
 * to the platform, the prompts or the model can be measured against the same
 * returns rather than judged by how a demo felt.
 *
 * Two modes, deliberately:
 *
 *   (default)  Validates every fixture and runs the whole pipeline with a
 *              scripted model. Free, and what CI should run. It cannot tell you
 *              whether the review is any good — it tells you the fixtures are
 *              well formed and the platform still walks them end to end.
 *
 *   --real     Runs the real model and scores it: which planted defects were
 *              found, and whether the two probes held. This is the eval. It
 *              costs money, so it takes --budget and stops when it is reached.
 *
 * The scoring is strict about vagueness and relaxed about where a problem turns
 * up. A finding counts only if it names the account or form the defect is about
 * — a line carrying the right defect_kind that says nothing specific is not a
 * catch, because a reviewer could not act on it. Which stage caught it is
 * reported but not required: the first real run flagged a suspect expense in
 * the financial stage rather than the books stage, and calling that a miss said
 * something false about the review.
 *
 * Both modes walk every stage of every fixture against the database, so the
 * free mode still takes several minutes — it is a pre-push gate, not something
 * to run on every save.
 *
 *   node tests/review-golden.mjs
 *   node tests/review-golden.mjs --real --budget 0.25 --only 1065-owner-draws
 *   node tests/review-golden.mjs --real --dump ../golden-out   # keep the findings
 */
import postgres from 'postgres';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, 'tests/fixtures/golden');
const SCHEMA_NAME = 'trc_golden_probe';
const USER = 'probe-user-1';

const argv = process.argv.slice(2);
const REAL = argv.includes('--real');
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BUDGET_USD = Number(flag('--budget', '0.25'));
const ONLY = flag('--only', null);
const MODEL = flag('--model', 'gpt-5.6-terra');
// Where to leave what the model wrote, so a paid run is diagnostic and not just
// a score. Off unless asked for.
const DUMP = flag('--dump', null);

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

/* ------------------------------------------------------------- the fixtures */

const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8')))
  .filter((f) => !ONLY || f.id === ONLY);

if (!fixtures.length) {
  console.error(ONLY ? `No fixture called ${ONLY}` : 'No fixtures found.');
  process.exit(1);
}

/**
 * Fixture validation, run in both modes.
 *
 * A malformed fixture is worse than a missing one: it scores something, and
 * whatever it scores is meaningless. These are the properties the scorer relies
 * on, checked rather than assumed.
 */
for (const fx of fixtures) {
  const label = `fixture ${fx.id}`;
  check(`${label}: has a return type and a year`, Boolean(fx.returnType && fx.taxYear));
  /**
   * A fixture marked `booksAbsent` is a return with no trial balance behind it.
   *
   * That is not a malformed fixture, it is a real and common situation: the
   * firm has the filed return and nothing else. What it tests is different —
   * whether the books stages say plainly that they could not check anything,
   * and whether the return-side checks still find what is findable from the
   * face of the return. So it is exempted from the document requirements
   * rather than excused from them quietly.
   */
  if (fx.booksAbsent) {
    check(
      `${label}: a books-absent fixture still carries the return`,
      fx.documents.some((d) => d.docRole === 'drake_export'),
      fx.documents.map((d) => d.docRole).join(', '),
    );
  } else {
    check(
      `${label}: carries the documents the input gate demands`,
      ['trial_balance_cy', 'trial_balance_py', 'drake_export'].every((role) =>
        fx.documents.some((d) => d.docRole === role),
      ),
      fx.documents.map((d) => d.docRole).join(', '),
    );
    check(
      `${label}: the return itself is only readable visually, as a real one would be`,
      fx.documents.some((d) => d.docRole === 'drake_export' && d.text === null),
    );
  }
  check(
    `${label}: every planted defect says what would count as finding it`,
    (fx.planted ?? []).every(
      (p) =>
        p.id &&
        p.what &&
        Array.isArray(p.mustMention) &&
        (p.minSeverity === null || p.minSeverity in SEVERITY_RANK),
    ),
  );
  check(
    `${label}: what it plants is visible in what it supplies`,
    (fx.planted ?? []).every(
      (p) =>
        // A defect about something missing has nothing in the documents to
        // point at — that is the defect. Flagged rather than exempted by
        // accident, so a typo in mustMention still fails this check.
        p.absence === true ||
        p.mustMention.every((needle) =>
          fx.documents.some((d) =>
            (d.text ?? '').toLowerCase().includes(String(needle).toLowerCase()),
          ) ||
          // Form numbers come from the obligations grid, not the documents.
          /^[0-9]{3,4}|FBAR|3CEB/i.test(String(needle)),
        ),
    ),
    'a defect nothing in the inputs points at is not findable, only guessable',
  );
}

check(
  'the set contains a clean return, so over-reporting is measurable too',
  fixtures.some((f) => (f.planted ?? []).length === 0) || Boolean(ONLY),
);
check(
  'the set contains both probes',
  (fixtures.some((f) => f.probe === 'fabrication') && fixtures.some((f) => f.probe === 'arithmetic')) ||
    Boolean(ONLY),
);
check(
  'the set covers more than one return type',
  new Set(fixtures.map((f) => f.returnType)).size > 1 || Boolean(ONLY),
);

// Said out loud rather than left implied. The brief asks for thirty; a suite
// that quietly reports "all green" on nine would read as coverage it does not
// have.
const SHORTFALL = 30 - readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).length;
if (SHORTFALL > 0) {
  console.log(
    `\nnote  ${SHORTFALL} short of the thirty the brief asks for, and all of these are ` +
      'synthetic. They catch regressions; they do not prove the platform is ready for a ' +
      'live client file. The rest have to be real returns with known answers.\n',
  );
}

/* ---------------------------------------------------------------- the build */

function build() {
  // Inside the project, not the system temp directory: in real mode the
  // compiled provider imports `openai` and the ingest layer imports exceljs,
  // and a bare package specifier only resolves from under the project's own
  // node_modules. Free mode does not need that, but using one location keeps
  // the two modes from drifting into two different builds.
  const dir = mkdtempSync(path.join(ROOT, '.trc-golden-'));
  mkdirSync(path.join(dir, 'engine'), { recursive: true });
  mkdirSync(path.join(dir, 'providers'), { recursive: true });

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
    `export const OPENAI_API_KEY = ${JSON.stringify(envValue('OPENAI_API_KEY'))};
     export const ROOT = ${JSON.stringify(ROOT)};
     export const MODELS = { chat: ${JSON.stringify(MODEL)} };
     export const EFFORT = 'medium';
     export const MAX_OUTPUT_TOKENS = 8000;
     export const MAX_TOOL_ROUNDS = 4;
     export const REVIEW_MAX_TOOL_ROUNDS = 10;
     export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;
     export const CITATION_CORPUS_ENABLED = false;
     export const REVIEW_COST_CEILING_USD = ${(BUDGET_USD / Math.max(1, fixtures.length)).toFixed(4)};
     export const ANALYSIS_TIMEOUT_MS = 5000;
     export const TOOLS_ENABLED = true;
     export const MEMORY_LIMIT = 60;
     export const PII_MODE = 'off';
     export const MAX_PDF_PAGES = 600;
     export const PRICING = {
       'gpt-5.6-luna': { in: 0.2, out: 1.2, cachedIn: 0.02 },
       'gpt-5.6-terra': { in: 2, out: 12, cachedIn: 0.2 },
       'gpt-5.6-sol': { in: 4, out: 20, cachedIn: 0.4 },
     };`,
  );

  writeFileSync(path.join(dir, 'chat-stub.js'), `export async function recordUsage() {}`);
  writeFileSync(
    path.join(dir, 'providers/index.js'),
    `import { openaiProvider } from './openai.js';
     import { state } from '../bus.js';
     export const getProvider = () =>
       state.scripted ? state.scriptedProvider : openaiProvider;`,
  );
  writeFileSync(
    path.join(dir, 'storage-stub.js'),
    `export async function getBlob() { return null; }
     export async function putBlob() { return { pathname: 'x' }; }`,
  );
  writeFileSync(
    path.join(dir, 'pii-stub.js'),
    `export async function tokenizeText(t) { return { text: t, counts: {} }; }
     export function describeCounts() { return ''; }`,
  );

  // Free mode replaces only the model. Everything else — the real prompts, the
  // real skill content, every gate — is the shipping code, so a fixture that
  // walks cleanly here has walked the real pipeline.
  writeFileSync(
    path.join(dir, 'bus.js'),
    `export const state = {
       scripted: true,
       calls: [],
       scriptedProvider: {
         async streamChat() {
           state.calls.push('stub');
           return {
             text: '', thinking: '', model: 'stub',
             usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
             costMicros: 0, finish: 'stop', toolRuns: [],
           };
         },
       },
     };`,
  );

  const sources = [
    ['lib/review-types.ts', 'engine/review-types.js'],
    ['lib/tools.ts', 'engine/tools.js'],
    ['lib/models.ts', 'engine/models.js'],
    ['lib/ingest.ts', 'engine/ingest.js'],
    ['lib/skills.ts', 'engine/skills.js'],
    ['lib/providers/shared.ts', 'providers/shared.js'],
    ['lib/providers/openai.ts', 'providers/openai.js'],
    ...readdirSync(path.join(ROOT, 'lib/review-engine'))
      .filter((n) => n.endsWith('.ts'))
      .map((n) => [`lib/review-engine/${n}`, `engine/${n.replace(/.ts$/, '.js')}`]),
  ];

  for (const [src, out] of sources) {
    const { outputText } = ts.transpileModule(readFileSync(path.join(ROOT, src), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: src,
    });

    const depth = out.includes('/') ? '../' : './';
    writeFileSync(
      path.join(dir, out),
      outputText
        .replace(/^import ['"]server-only['"];?$/m, '')
        .replace(/from ['"]@\/lib\/db['"]/g, `from '${depth}db-shim.js'`)
        .replace(/from ['"]\.\.?\/db['"]/g, `from '${depth}db-shim.js'`)
        .replace(/from ['"]@\/lib\/config['"]/g, `from '${depth}config-stub.js'`)
        .replace(/from ['"]\.\.?\/config['"]/g, `from '${depth}config-stub.js'`)
        .replace(/from ['"]@\/lib\/chat['"]/g, `from '${depth}chat-stub.js'`)
        .replace(/from ['"]\.\.?\/storage['"]/g, `from '${depth}storage-stub.js'`)
        .replace(/from ['"]\.\.?\/pii['"]/g, `from '${depth}pii-stub.js'`)
        .replace(/from ['"]@\/lib\/ingest['"]/g, `from '${depth}engine/ingest.js'`)
        .replace(/from ['"]@\/lib\/skills['"]/g, `from '${depth}engine/skills.js'`)
        .replace(/from ['"]@\/lib\/tools['"]/g, `from '${depth}engine/tools.js'`)
        .replace(/from ['"]@\/lib\/models['"]/g, `from '${depth}engine/models.js'`)
        .replace(/from ['"]\.\.?\/models['"]/g, `from '${depth}engine/models.js'`)
        .replace(/from ['"]@\/lib\/providers['"]/g, `from '${depth}providers/index.js'`)
        .replace(/from ['"]@\/lib\/review-types['"]/g, `from '${depth}engine/review-types.js'`)
        .replace(/from ['"]@\/lib\/providers\/types['"]/g, `from '${depth}engine/review-types.js'`)
        .replace(/^import .*from ['"]\.\/connectors['"];?$/m, '')
        .replace(/^import .*from ['"]\.\/accounts['"];?$/m, '')
        .replace(/from ['"](\.\.?\/[^'"]*)['"]/g, (whole, spec) =>
          spec.endsWith('.js') ? whole : `from '${spec}.js'`,
        ),
    );
  }
  return dir;
}

/* --------------------------------------------------------------- the scorer */

/**
 * Whether one finding counts as catching one planted defect.
 *
 * The stage a defect surfaces in is deliberately not part of the test. The
 * first real run flagged the suspect expense account, with the right figures
 * and the right fix, in the financial-review stage instead of the books stage —
 * and scoring that as a miss said something false about the review. Which check
 * catches a problem is the engine's business; that it was caught, named and made
 * actionable is the firm's. The stage is recorded in the output so a pattern of
 * drift is still visible.
 */
function catches(finding, planted) {
  if (planted.defectKinds && !planted.defectKinds.includes(finding.defect_kind)) return false;

  if (planted.minSeverity) {
    const rank = SEVERITY_RANK[finding.severity];
    if (rank === undefined || rank > SEVERITY_RANK[planted.minSeverity]) return false;
  }

  // The specificity test. A finding has to name the thing it is about.
  const haystack = [
    finding.title,
    finding.what_is_wrong,
    finding.why_it_matters,
    finding.fix_json,
    finding.location_json,
    finding.amounts_json,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return planted.mustMention.every((needle) => haystack.includes(String(needle).toLowerCase()));
}

/* ----------------------------------------------------------------- the runs */

const DATABASE_URL = envValue('DATABASE_URL') || envValue('POSTGRES_URL');
if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing from .env');
  process.exit(1);
}
if (REAL && !envValue('OPENAI_API_KEY')) {
  console.error('--real needs OPENAI_API_KEY.');
  process.exit(1);
}

// A leftover build directory from a crashed run would be imported by the next
// one and quietly test stale code.
for (const entry of readdirSync(ROOT)) {
  if (entry.startsWith('.trc-golden-')) rmSync(path.join(ROOT, entry), { recursive: true, force: true });
}

const dir = build();
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  rmSync(dir, { recursive: true, force: true });
};
process.on('exit', cleanup);

const shim = await import(pathToFileURL(path.join(dir, 'db-shim.js')).href);
const { state } = await import(pathToFileURL(path.join(dir, 'bus.js')).href);
const store = await import(pathToFileURL(path.join(dir, 'engine/store.js')).href);
const booksStore = await import(pathToFileURL(path.join(dir, 'engine/books.js')).href);
const coa = await import(pathToFileURL(path.join(dir, 'engine/chart-of-accounts.js')).href);
const orchestrator = await import(pathToFileURL(path.join(dir, 'engine/orchestrator.js')).href);
const stageDefs = await import(pathToFileURL(path.join(dir, 'engine/stage-defs.js')).href);

const schemaBlock = (() => {
  const dbTs = readFileSync(path.join(ROOT, 'lib/db.ts'), 'utf8');
  const start = dbTs.indexOf('/* ================================================================ v7 =====');
  return dbTs.slice(start, dbTs.indexOf('\n`;', start));
})();

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
let spentMicros = 0;
const scores = [];

try {
  await sql
    .begin(async (db) => {
      shim.useConnection(db);
      state.scripted = !REAL;

      await db.unsafe(`
        CREATE SCHEMA ${SCHEMA_NAME};
        SET LOCAL search_path TO ${SCHEMA_NAME};
        CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
        CREATE TABLE audit_log (id TEXT PRIMARY KEY, at BIGINT, actor_id TEXT,
                                action TEXT, target_type TEXT, target_id TEXT, detail TEXT);
        CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, extracted_text TEXT,
                            kind TEXT, storage_path TEXT, mime TEXT, user_id TEXT,
                            page_count INTEGER, deleted_at BIGINT);
        -- Left empty, so the skill loader falls through to the folder in the
        -- repo: the eval should measure the skill content that ships, not
        -- whatever a database happened to hold.
        CREATE TABLE agent_skills (id TEXT PRIMARY KEY, name TEXT, description TEXT, body TEXT,
                                   scope TEXT, user_id TEXT, enabled INTEGER, folder TEXT,
                                   created_by TEXT, created_at BIGINT, updated_at BIGINT);
        CREATE TABLE agent_skill_files (skill_id TEXT, path TEXT, content TEXT, bytes BIGINT,
                                        PRIMARY KEY (skill_id, path));
        CREATE TABLE model_usage (id TEXT PRIMARY KEY, at BIGINT, user_id TEXT, model TEXT,
                                  input_tokens INTEGER, output_tokens INTEGER,
                                  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
                                  cost_micros BIGINT, conversation_id TEXT);
        INSERT INTO users VALUES ('${USER}', 'Probe User');
      `);
      await db.unsafe(schemaBlock);

      for (const fx of fixtures) {
        if (REAL && spentMicros / 1_000_000 >= BUDGET_USD) {
          console.log(`\nstop  budget of $${BUDGET_USD} reached — ${fixtures.length - scores.length} fixtures not run.\n`);
          break;
        }

        // Documents, as rows the parser can read.
        let n = 0;
        const docs = [];
        for (const doc of fx.documents) {
          const fileId = `${fx.id}-f${n++}`;
          await db.unsafe(
            `INSERT INTO files (id, filename, extracted_text, kind, storage_path, mime)
             VALUES ($1, $2, $3, $4, 'probe', 'text/plain')`,
            [fileId, doc.filename, doc.text ?? null, doc.filename.split('.').pop()],
          );
          docs.push({ fileId, docRole: doc.docRole });
        }

        const engagement = await store.createEngagement(USER, {
          clientLabel: `Golden ${fx.id}`,
          entityName: `${fx.id} LLC`,
          returnType: fx.returnType,
          taxYear: fx.taxYear,
        });
        for (const [key, value] of Object.entries(fx.facts ?? {})) {
          await store.assertFact(USER, engagement.id, key, value, 'user');
        }

        /**
         * The current-year trial balance is imported, not just attached.
         *
         * Without this the eval never exercised the chart-of-accounts layer, so
         * the books stage was reviewing raw account names — and the standard
         * key that exists precisely to catch owner draws booked as an expense
         * was not in front of it. An eval that skips a capability cannot
         * measure it.
         */
        const cyTrialBalance = fx.documents.findIndex(
          (d) => d.docRole === 'trial_balance_cy' && d.text,
        );
        if (cyTrialBalance >= 0) {
          const text = fx.documents[cyTrialBalance].text;
          await booksStore.recordImport(USER, {
            engagementId: engagement.id,
            source: {
              id: 'spreadsheet',
              label: 'Fixture trial balance',
              async fetch() {
                const { accounts, skipped } = coa.parseTrialBalanceText(text);
                // A fixed date, so the same fixture hashes the same way twice.
                return { accounts, extractedAt: Date.UTC(fx.taxYear, 11, 31), skipped };
              },
            },
            ref: docs[cyTrialBalance].fileId,
            periodStart: `${fx.taxYear}-01-01`,
            periodEnd: `${fx.taxYear}-12-31`,
          });
        }

        const run = await store.createRun(USER, {
          engagementId: engagement.id,
          runNumber: 1,
          status: 'pending',
          promptVersion: 'trr-1.0',
          model: REAL ? MODEL : 'stub',
          corpusHash: fx.id,
          factsSnapshot: fx.facts ?? {},
        });
        await store.addRunDocuments(run.id, docs);

        const plan = stageDefs.planStages({ returnType: fx.returnType, facts: fx.facts ?? {} });
        await store.createStages(run.id, plan);
        await orchestrator.recordPlannedGaps(run.id, {
          notApplicable: plan
            .filter((s) => s.status === 'not_applicable')
            .map((s) => ({ stageKey: s.stageKey, reason: s.reason })),
        });

        let guard = 0;
        let advance;
        do {
          advance = await orchestrator.advanceRun({
            runId: run.id,
            actorId: USER,
            onEvent: () => {},
          });
        } while (!advance.runFinished && ++guard < 20);

        const findings = await store.listFindings(run.id);
        const stages = await store.listStages(run.id);
        const settled = await store.getRun(run.id);
        const cost = stages.reduce((total, s) => total + Number(s.cost_micros ?? 0), 0);
        spentMicros += cost;

        /**
         * A run the cost ceiling stopped part-way is unscoreable, not failing.
         *
         * Reported as skipped rather than asserted over: stages that never ran
         * have no findings, so every check below would fail and the output
         * would read as a broken platform when what happened is that the eval
         * ran out of money. Said out loud, because a suite that silently drops
         * a fixture is worse than one that fails on it.
         */
        const stoppedOnBudget =
          settled.status === 'failed' && (settled.error_text ?? '').includes('ceiling');

        if (stoppedOnBudget) {
          console.log(
            `skip  ${fx.id}: stopped at the $${BUDGET_USD} ceiling after ` +
              `${stages.filter((s) => s.status === 'complete').length} stages — recall not scored.`,
          );
          scores.push({
            id: fx.id,
            planted: (fx.planted ?? []).length,
            caught: null,
            exceptions: findings.filter((f) => f.kind === 'exception').length,
            verdict: 'not scored — budget',
            costUsd: cost / 1_000_000,
            missed: [],
          });
        }

        /**
         * A halted run has stages that deliberately never ran.
         *
         * A Stage 0 Critical stops the sequence, because nothing after it is
         * reviewing the right entity — so "every stage is terminal" is the
         * wrong assertion for that run, and asserting it anyway would report
         * the halt working correctly as a failure. What is required instead is
         * that everything up to the halt ran, and that the halt was recorded
         * with a reason.
         */
        const halted = settled.status === 'halted';
        const ranSeq = Math.max(
          ...stages
            .filter((s) => s.status !== 'pending' && s.status !== 'running')
            .map((s) => s.seq),
          -1,
        );
        const shouldHaveRun = (stage) => !halted || stage.seq <= ranSeq;

        // Completeness is meaningless on a run the money stopped part-way.
        // The gates below are not: they judge what was written, and a fabricated
        // citation in stage 2 is exactly as serious whether or not stage 3 ever
        // ran. Skipping them with the rest was throwing away the one thing a
        // truncated paid run can still tell us.
        if (!stoppedOnBudget)
          check(
            `${fx.id}: every stage reached a terminal state${halted ? ', up to the halt' : ''}`,
          stages
            .filter(shouldHaveRun)
            .every((s) => s.status !== 'pending' && s.status !== 'running'),
          stages.map((s) => `${s.stage_key}:${s.status}`).join(' '),
        );
        if (halted) {
          check(
            `${fx.id}: the halt says why`,
            Boolean(settled.halt_reason),
            settled.halt_reason ?? 'no reason recorded',
          );
        }
        if (!stoppedOnBudget)
          check(
            `${fx.id}: no stage that ran went silent`,
            stageDefs.STAGE_DEFS.every((def) => {
              const planned = plan.find((p) => p.stageKey === def.key);
              if (!planned || planned.status === 'not_applicable') return true;
              const stage = stages.find((s) => s.stage_key === def.key);
              if (stage && !shouldHaveRun(stage)) return true;
              return findings.some((f) => f.stage_key === def.key);
            }),
          );

        /* ------------------------------------- the gates, on every fixture */

        const amounts = findings.flatMap((f) => JSON.parse(f.amounts_json || '[]'));
        check(
          `${fx.id}: PROBE every stored figure carries a source`,
          amounts.every((a) => a.source_kind && a.source_ref),
          `${amounts.length} figures`,
        );
        check(
          `${fx.id}: PROBE nothing is stored as authority`,
          findings.every((f) => f.authority_citation === null),
          findings.filter((f) => f.claimed_citation).length + ' citations claimed and demoted',
        );
        check(
          `${fx.id}: severity only ever comes from the tree`,
          findings.every((f) =>
            f.kind === 'exception' ? f.severity !== null : f.severity === null,
          ),
        );

        if (REAL && !stoppedOnBudget) {
          const exceptions = findings.filter((f) => f.kind === 'exception');

          /**
           * What the model actually wrote, kept.
           *
           * The run happens inside a transaction that is rolled back, so
           * without this a paid run leaves a score and nothing to learn from —
           * and "found one of three" is not a finding, it is a prompt to go and
           * look. Written outside the repo, because it is a run log rather than
           * something to commit.
           */
          if (DUMP) {
            mkdirSync(DUMP, { recursive: true });
            writeFileSync(
              path.join(DUMP, `${fx.id}.json`),
              JSON.stringify(
                {
                  fixture: fx.id,
                  model: MODEL,
                  planted: fx.planted ?? [],
                  verdict: settled.verdict,
                  costUsd: cost / 1_000_000,
                  stages: stages.map((s) => ({
                    stage: s.stage_key,
                    status: s.status,
                    costUsd: Number(s.cost_micros ?? 0) / 1_000_000,
                  })),
                  findings: findings.map((f) => ({
                    code: f.finding_code,
                    stage: f.stage_key,
                    kind: f.kind,
                    defectKind: f.defect_kind,
                    severity: f.severity,
                    status: f.status,
                    title: f.title,
                    whatIsWrong: f.what_is_wrong,
                    location: f.location_json && JSON.parse(f.location_json),
                    fix: f.fix_json && JSON.parse(f.fix_json),
                    amounts: JSON.parse(f.amounts_json || '[]'),
                    claimedCitation: f.claimed_citation,
                  })),
                },
                null,
                2,
              ),
            );
          }
          const found = (fx.planted ?? []).map((planted) => {
            const hit = exceptions.find((f) => catches(f, planted)) ?? null;
            return {
              planted,
              hit,
              // Where it turned up against where the fixture expected it. Not a
              // pass condition, but a drift worth seeing.
              elsewhere: hit && planted.stage && hit.stage_key !== planted.stage
                ? `${planted.id} caught in ${hit.stage_key}, expected ${planted.stage}`
                : null,
            };
          });
          const caught = found.filter((f) => f.hit).length;

          scores.push({
            id: fx.id,
            planted: (fx.planted ?? []).length,
            caught,
            exceptions: exceptions.length,
            verdict: settled.verdict,
            costUsd: cost / 1_000_000,
            missed: found.filter((f) => !f.hit).map((f) => f.planted.id),
          });

          if ((fx.planted ?? []).length) {
            for (const drift of found.map((f) => f.elsewhere).filter(Boolean)) {
              console.log(`note  ${fx.id}: ${drift}`);
            }
            check(
              `${fx.id}: found ${caught} of ${fx.planted.length} planted defects`,
              caught === fx.planted.length,
              found.filter((f) => !f.hit).map((f) => f.planted.id).join(', ') || 'all found',
            );
          }
          if (fx.expect?.maxExceptions !== undefined) {
            check(
              `${fx.id}: does not invent problems in a clean return`,
              exceptions.length <= fx.expect.maxExceptions,
              `${exceptions.length} exceptions raised`,
            );
          }
          if (fx.expect?.haltsAt) {
            // Only meaningful against the real model: the scripted provider is
            // not trying to find the identity problem that causes the halt.
            check(
              `${fx.id}: the run stops at ${fx.expect.haltsAt} rather than reviewing on`,
              settled.status === 'halted',
              `status ${settled.status}`,
            );
          }
          if (fx.expect?.verdict) {
            check(
              `${fx.id}: verdict is ${fx.expect.verdict}`,
              settled.verdict === fx.expect.verdict,
              String(settled.verdict),
            );
          }
        }
      }

      throw new Error('__rollback__');
    })
    .catch((err) => {
      if (err.message !== '__rollback__') throw err;
    });
} finally {
  await sql.end({ timeout: 5 });
  cleanup();
}

if (REAL && scores.length) {
  const scored = scores.filter((s) => s.caught !== null);
  const planted = scored.reduce((n, s) => n + s.planted, 0);
  const caught = scored.reduce((n, s) => n + s.caught, 0);
  console.log('\n--- recall ---');
  for (const s of scores) {
    console.log(
      `  ${s.id.padEnd(28)} ${s.caught === null ? '—' : s.caught}/${s.planted}  ${s.exceptions} exceptions  ` +
        `${String(s.verdict).padEnd(24)} $${s.costUsd.toFixed(4)}` +
        (s.missed.length ? `  missed: ${s.missed.join(', ')}` : ''),
    );
  }
  console.log(
    `  total ${caught}/${planted} planted defects found across ${scored.length} scored ` +
      `fixture${scored.length === 1 ? '' : 's'}` +
      (scores.length > scored.length ? `, ${scores.length - scored.length} stopped on budget` : ''),
  );
  console.log(`  spent $${(spentMicros / 1_000_000).toFixed(4)} of $${BUDGET_USD}`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
