/**
 * One review stage against the real model.
 *
 * Everything else in the suite uses a scripted stand-in, which proves our own
 * rules work but says nothing about whether the review is any good. This calls
 * the real model, with the real prompts and the real firm skill content, and
 * checks what comes back through the real gates.
 *
 * It spends money, so it is not part of `npm test`. There is a hard ceiling
 * below, checked before each stage and again after, and the run stops rather
 * than continuing past it.
 *
 * Safe against any database, including the live one: the schema is created in a
 * throwaway namespace inside a single transaction which is rolled back at the
 * end, and search_path is set to that namespace alone so no table in public is
 * read or written. The last assertion checks nothing survived.
 *
 *   node tests/review-live.mjs
 *   node tests/review-live.mjs --model gpt-5.6-terra --budget 0.40
 */
import postgres from 'postgres';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCHEMA_NAME = 'trc_live_probe';
const USER = 'probe-user-1';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

/** Cheapest capable model by default; the ceiling is what actually protects us. */
const MODEL = arg('model', 'gpt-5.6-luna');
const BUDGET_USD = Number(arg('budget', '0.40'));

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
const notes = [];
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
 * Compiles the engine with the real provider, the real prompts and the real
 * skill loader. Only the database and the config are stood in for.
 */
function build(apiKey) {
  // Inside the project, not the system temp directory: the compiled provider
  // imports `openai` and the ingest layer imports exceljs, mammoth and
  // pdf-lib, and a bare package specifier only resolves from somewhere under
  // the project's own node_modules. Removed in the finally block below.
  const dir = mkdtempSync(path.join(ROOT, '.trc-live-'));
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

  // The real values, except the output ceiling which is trimmed to keep one
  // stage cheap.
  writeFileSync(
    path.join(dir, 'config-stub.js'),
    `export const OPENAI_API_KEY = ${JSON.stringify(apiKey)};
     export const ROOT = ${JSON.stringify(ROOT)};
     export const MODELS = { chat: ${JSON.stringify(MODEL)} };
     export const EFFORT = 'medium';
     export const MAX_OUTPUT_TOKENS = 6000;
     export const MAX_TOOL_ROUNDS = 4;
     export const REVIEW_MAX_TOOL_ROUNDS = 8;
     export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;
     export const CITATION_CORPUS_ENABLED = false;
     export const REVIEW_COST_CEILING_USD = ${BUDGET_USD};
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
  // Stands in for lib/providers/index.ts, handing back the real OpenAI provider.
  writeFileSync(
    path.join(dir, 'providers/index.js'),
    `import { openaiProvider } from './openai.js';
     export const getProvider = () => openaiProvider;`,
  );
  // Only text-bearing documents are used, so the blob store is never reached.
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
      .map((n) => [`lib/review-engine/${n}`, `engine/${n.replace(/\.ts$/, '.js')}`]),
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

/**
 * A small trial balance with problems a senior reviewer should find:
 * an owner distribution booked as an expense, a non-zero suspense account, and
 * cash that does not agree to the reconciliation. Deliberately tiny — the
 * question is whether the engine works end to end, not how it handles volume.
 */
const TRIAL_BALANCE = `WORKBOOK — 1 sheet

## Sheet "TB 2025" — rows 1-16, cols A-C
r1 | A1: Account | B1: Description | C1: Balance
r2 | A2: 1010 | B2: Operating cash | C2: 42180.00
r3 | A3: 1200 | B3: Accounts receivable | C3: 88400.00
r4 | A4: 1900 | B4: Suspense | C4: 3150.00
r5 | A5: 1500 | B5: Equipment | C5: 61000.00
r6 | A6: 1510 | B6: Accumulated depreciation | C6: -18300.00
r7 | A7: 2010 | B7: Accounts payable | C7: -31200.00
r8 | A8: 2500 | B8: Loan payable - bank | C8: -54000.00
r9 | A9: 3000 | B9: Members capital | C9: -96410.00
r10 | A10: 4000 | B10: Revenue | C10: -838900.00
r11 | A11: 5000 | B11: Cost of goods sold | C11: 612400.00
r12 | A12: 6100 | B12: Rent - related party | C12: 96000.00
r13 | A13: 6200 | B13: Meals and entertainment | C13: 14800.00
r14 | A14: 6300 | B14: Owner draws | C14: 72000.00
r15 | A15: 6410 | B15: Professional fees | C15: 8900.00
r16 | A16: 6120 | B16: Bank charges | C16: 780.00`;

const BANK_REC = `WORKBOOK — 1 sheet

## Sheet "Dec bank rec" — rows 1-6, cols A-B
r1 | A1: Balance per bank statement 31 Dec 2025 | B1: 41930.00
r2 | A2: Add deposits in transit | B2: 0.00
r3 | A3: Less outstanding cheques | B3: 0.00
r4 | A4: Adjusted bank balance | B4: 41930.00
r5 | A5: Balance per general ledger 1010 | B5: 42180.00
r6 | A6: Unreconciled difference | B6: 250.00`;

const DATABASE_URL = envValue('DATABASE_URL') || envValue('POSTGRES_URL');
const API_KEY = envValue('OPENAI_API_KEY');

if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing from .env');
  process.exit(1);
}
if (!API_KEY) {
  console.log('OPENAI_API_KEY is not set — skipping the live test.');
  process.exit(0);
}

console.log(`Live review stage · model ${MODEL} · ceiling $${BUDGET_USD.toFixed(2)}\n`);

// A previous run that failed while importing never reached its cleanup.
for (const entry of readdirSync(ROOT)) {
  if (entry.startsWith('.trc-live-')) rmSync(path.join(ROOT, entry), { recursive: true, force: true });
}

const dir = build(API_KEY);
// The compiled tree lives in the project, so make sure it goes even if an
// import throws before the try block below.
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const shim = await import(pathToFileURL(path.join(dir, 'db-shim.js')).href);
const store = await import(pathToFileURL(path.join(dir, 'engine/store.js')).href);
const runner = await import(pathToFileURL(path.join(dir, 'engine/stage-runner.js')).href);
const shared = await import(pathToFileURL(path.join(dir, 'providers/shared.js')).href);

const v7 = (() => {
  const dbTs = readFileSync(path.join(ROOT, 'lib/db.ts'), 'utf8');
  const start = dbTs.indexOf('/* ================================================================ v7 =====');
  return dbTs.slice(start, dbTs.indexOf('\n`;', start));
})();

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
let spentUsd = 0;

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
                            kind TEXT, storage_path TEXT, mime TEXT, user_id TEXT,
                            page_count INTEGER, deleted_at BIGINT);
        -- Empty, so skills-source falls through to the folder in the repo.
        CREATE TABLE agent_skills (id TEXT PRIMARY KEY, name TEXT, description TEXT, body TEXT,
                                   scope TEXT, user_id TEXT, enabled INTEGER, folder TEXT,
                                   created_by TEXT, created_at BIGINT, updated_at BIGINT);
        CREATE TABLE agent_skill_files (skill_id TEXT, path TEXT, content TEXT, bytes BIGINT,
                                        PRIMARY KEY (skill_id, path));
        INSERT INTO users VALUES ('${USER}', 'Probe User');
      `);
      await db.unsafe(v7);

      await db.unsafe(
        `INSERT INTO files (id, filename, extracted_text, kind, storage_path, mime, user_id)
         VALUES ('f-tb', 'tb-2025.xlsx', $1, 'xlsx', 'p', 'm', '${USER}'),
                ('f-rec', 'dec-bank-rec.xlsx', $2, 'xlsx', 'p', 'm', '${USER}')`,
        [TRIAL_BALANCE, BANK_REC],
      );

      const engagement = await store.createEngagement(USER, {
        clientLabel: 'Probe Holdings',
        entityName: 'Probe Holdings LLC',
        returnType: '1065',
        taxYear: 2025,
        periodStart: '2025-01-01',
        periodEnd: '2025-12-31',
      });

      const run = await store.createRun(USER, {
        engagementId: engagement.id,
        runNumber: 1,
        status: 'running',
        promptVersion: 'trr-1.0',
        model: MODEL,
        corpusHash: 'live-probe',
        factsSnapshot: {},
      });
      await store.addRunDocuments(run.id, [
        { fileId: 'f-tb', docRole: 'trial_balance_cy' },
        { fileId: 'f-rec', docRole: 'bank_statement' },
      ]);
      await store.createStages(run.id, [{ stageKey: 'S1', seq: 1, status: 'pending' }]);
      const stage = await store.claimNextStage(run.id);

      const events = [];
      console.log('Running Stage 1 (books and bookkeeping)…\n');
      const started = Date.now();

      const result = await runner.runStage({
        runId: run.id,
        stageId: stage.id,
        stageKey: 'S1',
        engagement,
        facts: {},
        actorId: USER,
        model: MODEL,
        onEvent: (e) => {
          events.push(e);
          if (e.type === 'finding') console.log(`  ${e.code}  [${e.severity ?? 'agreed'}]  ${e.title}`);
          if (e.type === 'tool') console.log(`  · ${e.note}`);
        },
      });

      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      const stageRow = (await store.listStages(run.id)).find((s) => s.id === stage.id);
      spentUsd = Number(stageRow?.cost_micros ?? 0) / 1_000_000;

      console.log(`\nStage ${result.status} in ${seconds}s · $${spentUsd.toFixed(4)}\n`);

      /* --------------------------------------------------- did it work at all */

      check('the stage completed against the real model', result.status === 'complete', result.error ?? '');

      const findings = await store.listFindings(run.id);
      check('it recorded findings', findings.length > 0, `${findings.length} lines`);

      const exceptions = findings.filter((f) => f.kind === 'exception');
      const agreed = findings.filter((f) => f.kind === 'agreed');
      check(
        'it recorded both problems and clean sections',
        exceptions.length > 0 && agreed.length > 0,
        `${exceptions.length} exceptions, ${agreed.length} agreed`,
      );

      /* ------------------------------------------- did the gates hold on real output */

      check(
        'every stored amount carries a source',
        findings
          .flatMap((f) => JSON.parse(f.amounts_json ?? '[]'))
          .every((a) => a.source_kind && a.source_ref),
      );
      check(
        'no citation was stored as authority',
        findings.every((f) => f.authority_citation === null),
      );
      check(
        'severity only ever came from the tree',
        exceptions.every((f) => f.severity !== null) && agreed.every((f) => f.severity === null),
      );
      check(
        'every exception has a fix a novice could follow',
        exceptions.every((f) => {
          const fix = JSON.parse(f.fix_json ?? 'null');
          return fix && fix.where && fix.change;
        }),
      );
      check(
        'every finding has a lineage key, so the next run can match it',
        findings.every((f) => f.lineage_key),
      );

      /* ------------------------------------------------- did it find the real problems */

      const text = findings
        .map((f) => `${f.title} ${f.what_is_wrong}`.toLowerCase())
        .join(' | ');

      const spotted = {
        'the 250 cash difference': /250|reconcil/.test(text),
        'owner draws booked as an expense': /draw|distribution/.test(text),
        'the non-zero suspense account': /suspense/.test(text),
        'related-party rent': /related.?part|rent/.test(text),
      };
      for (const [what, found] of Object.entries(spotted)) {
        if (found) console.log(`ok    it spotted ${what}`);
        else notes.push(`did not spot ${what}`);
      }
      check(
        'it found at least half of the seeded problems',
        Object.values(spotted).filter(Boolean).length >= 2,
        `${Object.values(spotted).filter(Boolean).length} of ${Object.keys(spotted).length}`,
      );

      const calcs = await store.listCalcs(run.id);
      if (calcs.length) console.log(`ok    it used the calculation layer (${calcs.length} runs)`);
      else notes.push('it did not use run_analysis — figures came from reading, not computing');

      check(
        `it stayed inside the ceiling`,
        spentUsd < BUDGET_USD,
        `$${spentUsd.toFixed(4)} of $${BUDGET_USD.toFixed(2)}`,
      );

      void shared;
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

console.log(`\n${pass} passed, ${failures.length} failed · spent $${spentUsd.toFixed(4)}`);
if (notes.length) {
  console.log('\nWorth knowing:');
  for (const note of notes) console.log(`  - ${note}`);
}
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
