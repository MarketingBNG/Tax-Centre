/**
 * The grounded-citation path, which nothing else has ever run.
 *
 * Every other suite runs with an empty corpus and the corpus flag off, so the
 * only outcome they can observe is a citation being demoted to "needs
 * verifying". That is the correct behaviour today, and it means the branch
 * where a citation is actually recorded as authority — the branch the whole
 * corpus exists for — has never executed. Dead code that will run for the first
 * time on the day the firm loads real content is not a good position to be in.
 *
 * So this loads a small corpus, turns the flag on, and drives a stage through
 * it: what the search tool hands back, a citation quoted correctly, a real
 * section attached to words it does not contain, a section that was not yet in
 * force, and a citation with nothing quoted at all.
 *
 * The passages here are a two-line sample, not a library. They are loaded to
 * exercise the mechanism, not to be cited by anybody: the firm decides what it
 * holds the rights to load, and this is not it.
 *
 * No API key and no money — the provider replays fixed tool calls. Runs in a
 * throwaway schema inside a transaction that is rolled back, so it is safe
 * against any database including production.
 *
 *   node tests/review-grounding.mjs
 */
import postgres from 'postgres';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCHEMA_NAME = 'trc_grounding_probe';
const USER = 'probe-user-1';

/**
 * A fixed date to read the corpus as of.
 *
 * Hard-coded rather than "now", because half of what is under test is that
 * authority is time-bound: a source that takes effect after this date must not
 * ground a citation, and a test that drifted with the clock would stop checking
 * that the moment the date passed.
 */
const AS_OF = Date.UTC(2026, 5, 30);

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

/** As review-stage.mjs, but with the corpus flag on. */
function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trc-grounding-'));
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

  // The one line that differs from every other suite.
  writeFileSync(
    path.join(dir, 'config-stub.js'),
    `export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;
     export const REVIEW_MAX_TOOL_ROUNDS = 12;
     export const REVIEW_COST_CEILING_USD = 8;
     export const CITATION_CORPUS_ENABLED = true;
     export const ANALYSIS_TIMEOUT_MS = 5000;
     export const TOOLS_ENABLED = true;
     export const MEMORY_LIMIT = 60;
     export const ROOT = ${JSON.stringify(ROOT)};`,
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

  // The prompt stub records whether the runner told the prompt a corpus was
  // available, which is what decides whether the model is offered the search
  // tool at all.
  writeFileSync(
    path.join(dir, 'prompts-stub.js'),
    `export const seen = { corpusAvailable: null };
     export async function buildStagePrompt(input) {
       seen.corpusAvailable = input.corpusAvailable;
       return { system: ['stub'], turns: [{ role: 'user', parts: [{ kind: 'text', text: 'stub' }] }] };
     }`,
  );

  writeFileSync(path.join(dir, 'chat-stub.js'), `export async function recordUsage() {}`);
  writeFileSync(
    path.join(dir, 'providers-stub.js'),
    `export const getProvider = () => { throw new Error('The test must inject a provider.'); };`,
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
const store = await import(pathToFileURL(path.join(dir, 'engine/store.js')).href);
const corpus = await import(pathToFileURL(path.join(dir, 'engine/corpus.js')).href);
const runner = await import(pathToFileURL(path.join(dir, 'engine/stage-runner.js')).href);
const promptStub = await import(pathToFileURL(path.join(dir, 'prompts-stub.js')).href);

const v7 = (() => {
  const dbTs = readFileSync(path.join(ROOT, 'lib/db.ts'), 'utf8');
  const start = dbTs.indexOf('/* ================================================================ v7 =====');
  return dbTs.slice(start, dbTs.indexOf('\n`;', start));
})();

/**
 * The sample passage.
 *
 * The opening of IRC 162(a), which is US statute and so not anybody's
 * copyright. Two sentences, loaded so the mechanism has something real-shaped
 * to match against — the quote the model offers has to be found in this text
 * word for word or the citation does not stand.
 */
const IRC_162_A =
  'There shall be allowed as a deduction all the ordinary and necessary expenses paid or ' +
  'incurred during the taxable year in carrying on any trade or business.';

/** What the tools replied, so the search tool's own answers can be read. */
const replies = [];

const scriptedProvider = (calls) => ({
  async streamChat({ runTool }) {
    const outputs = [];
    for (const call of calls) {
      try {
        outputs.push(await runTool(call));
      } catch (err) {
        outputs.push(`Error: ${err.message}`);
      }
      replies.push({ name: call.name, reply: String(outputs[outputs.length - 1] ?? '') });
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
  defect_kind: 'unsupported_position',
  category_override: null,
  title: 'A position',
  what_is_wrong: 'A deduction is claimed with nothing behind it.',
  why_it_matters: 'It matters.',
  location: { form: '1065', schedule: null, line: '20', gl_account: '6300' },
  fix: { where: 'Deductions screen', change: 'Obtain the support', then: 'Re-check', why: 'It has to be supportable.' },
  authority_citation: null,
  evidence: [],
  amounts: [],
  owner: 'preparer',
  confidence: 0.9,
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
          ('f-tb', 'tb-2025.xlsx', 'A1: Consulting expense 72,000.00', 'xlsx', 'p', 'm'),
          ('f-ret', 'return.pdf', NULL, 'pdf', 'p', 'm');
      `);
      await db.unsafe(v7);

      /* ------------------------------------------------ load a small corpus */

      const inForce = await corpus.ingestSource(USER, {
        kind: 'irc',
        title: 'Sample: IRC 162 (loaded by tests/review-grounding.mjs)',
        citationRoot: 'IRC',
        effectiveFrom: Date.UTC(2018, 0, 1),
        passages: [{ citation: 'IRC 162(a)', heading: 'In general', body: IRC_162_A }],
      });
      check('a source loads with its passages', inForce.passages === 1);

      // Not yet in force at AS_OF. A citation into this must not ground, and
      // that is the whole reason sources carry dates.
      await corpus.ingestSource(USER, {
        kind: 'irc',
        title: 'Sample: a section that takes effect later',
        citationRoot: 'IRC',
        effectiveFrom: Date.UTC(2027, 0, 1),
        passages: [
          {
            citation: 'IRC 199B(c)',
            heading: 'Sample',
            body: 'A deduction shall be allowed for qualified sample expenditures.',
          },
        ],
      });

      check(
        'the corpus reports content as of the review date',
        (await corpus.corpusHasContent(AS_OF)) === true,
      );
      check(
        'and reports none before anything was in force',
        (await corpus.corpusHasContent(Date.UTC(2010, 0, 1))) === false,
      );

      /* ---------------------------------------------------------- the stage */

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
        corpusAsOf: AS_OF,
      });
      await store.addRunDocuments(run.id, [
        { fileId: 'f-tb', docRole: 'trial_balance_cy' },
        { fileId: 'f-ret', docRole: 'drake_export' },
      ]);
      await store.createStages(run.id, [{ stageKey: 'S2', seq: 1, status: 'pending' }]);
      const stage = await store.claimNextStage(run.id);

      const result = await runner.runStage({
        runId: run.id,
        stageId: stage.id,
        stageKey: 'S2',
        engagement,
        facts: {},
        actorId: USER,
        model: 'stub',
        corpusAsOf: AS_OF,
        onEvent: () => {},
        provider: scriptedProvider([
          { name: 'search_authority', args: { citation: 'IRC 162(a)' } },
          { name: 'search_authority', args: { citation: 'IRC 274(n)(3)' } },
          { name: 'search_authority', args: { citation: 'IRC 199B(c)' } },
          {
            name: 'record_findings',
            args: {
              findings: [
                // Quoted correctly out of what the search returned.
                finding({
                  title: 'Ordinary and necessary is the test, and it is not met',
                  authority_citation: 'IRC 162(a)',
                  authority_quote: 'ordinary and necessary expenses paid or incurred during the taxable year',
                }),
                // A real section, attached to words it does not contain. This is
                // the failure the second half of the check exists for: the
                // citation is genuine, so a check that only asked "is this
                // section in the corpus" would wave it through.
                finding({
                  title: 'Right section, words it does not contain',
                  authority_citation: 'IRC 162(a)',
                  authority_quote: 'a deduction is allowed only where a written agreement exists',
                }),
                // In the corpus, but not yet in force for this year.
                finding({
                  title: 'Cites a section that takes effect later',
                  authority_citation: 'IRC 199B(c)',
                  authority_quote: 'qualified sample expenditures',
                }),
                // A citation with nothing quoted at all.
                finding({
                  title: 'Cites without quoting',
                  authority_citation: 'IRC 162(a)',
                }),
                // Nothing claimed: no authority required, and none invented.
                finding({ title: 'Plain English, no citation', defect_kind: 'missing_evidence' }),
              ],
            },
          },
        ]),
      });

      check('the stage completed', result.status === 'complete', result.status ?? '');
      check(
        'the runner tells the prompt a corpus is available, so the search tool is offered',
        promptStub.seen.corpusAvailable === true,
        String(promptStub.seen.corpusAvailable),
      );

      const searches = replies.filter((r) => r.name === 'search_authority');
      check(
        'searching returns the passage, so the model quotes rather than recalls',
        searches[0]?.reply.includes('ordinary and necessary'),
        searches[0]?.reply.slice(0, 60),
      );
      check(
        'searching for something the corpus does not hold says so, and says not to recall it',
        /nothing addressed by/i.test(searches[1]?.reply ?? '') &&
          /from memory/i.test(searches[1]?.reply ?? ''),
        searches[1]?.reply.slice(0, 80),
      );
      check(
        'a section that takes effect after the review date reads as not held',
        /nothing addressed by/i.test(searches[2]?.reply ?? ''),
        searches[2]?.reply.slice(0, 80),
      );

      const rows = await store.listFindings(run.id);
      const byTitle = (needle) => rows.find((r) => r.title.includes(needle));

      /* ------------------------------------------------ what got recorded */

      const grounded = byTitle('Ordinary and necessary is the test');
      check(
        'a citation in force, quoted word for word, is recorded as authority',
        grounded?.authority_status === 'grounded' && grounded?.authority_citation === 'IRC 162(a)',
        `${grounded?.authority_status} / ${grounded?.authority_citation}`,
      );
      check(
        'and it records which passage it came from, so it can be defended later',
        Boolean(grounded?.authority_source_span),
        grounded?.authority_source_span ?? 'none',
      );

      const wrongWords = byTitle('words it does not contain');
      check(
        'PROBE a real section attached to words it does not contain is refused',
        wrongWords?.authority_status === 'verify' && wrongWords?.authority_citation === null,
        `${wrongWords?.authority_status} / ${wrongWords?.authority_citation}`,
      );
      check(
        'and what it claimed is kept, so the refusal is auditable',
        wrongWords?.claimed_citation === 'IRC 162(a)',
        wrongWords?.claimed_citation ?? 'none',
      );

      const notYet = byTitle('takes effect later');
      check(
        'PROBE a section not in force for the year under review is not authority for it',
        notYet?.authority_status === 'verify' && notYet?.authority_citation === null,
        `${notYet?.authority_status} / ${notYet?.authority_citation}`,
      );

      const unquoted = byTitle('Cites without quoting');
      check(
        'PROBE a citation with nothing quoted is refused even though the section is held',
        unquoted?.authority_status === 'verify' && unquoted?.authority_citation === null,
        `${unquoted?.authority_status} / ${unquoted?.authority_citation}`,
      );

      const plain = byTitle('Plain English');
      check(
        'a finding claiming no authority needs none',
        plain?.authority_status === 'none_required' && plain?.claimed_citation === null,
        plain?.authority_status ?? '',
      );

      check(
        'the findings themselves survive the authority being demoted',
        rows.filter((r) => r.kind === 'exception').length === 5,
        `${rows.filter((r) => r.kind === 'exception').length} exceptions`,
      );
      check(
        'severity is unaffected by whether authority was found',
        rows
          .filter((r) => r.kind === 'exception' && r.defect_kind === 'unsupported_position')
          .every((r) => r.severity === 'High'),
        rows.filter((r) => r.kind === 'exception').map((r) => `${r.severity}`).join(','),
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
