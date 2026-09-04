/**
 * A demo engagement, so somebody can actually click through the thing.
 *
 * Everything built so far has been proved by tests against a database that was
 * thrown away afterwards. Nobody has walked the screens: start a review, read
 * the summary, open a finding, answer a question, look at the mapped books,
 * compare last year. That walk is where the awkward parts show up, and it needs
 * something on screen to walk through.
 *
 * This writes for real, and that is the point. It also creates the review
 * tables if they are not there yet, because the whole schema in lib/db.ts is
 * idempotent and running it is exactly what the app does on its first query.
 *
 *   node tests/seed-demo.mjs                 # says what it would do, writes nothing
 *   node tests/seed-demo.mjs --write         # creates the demo
 *   node tests/seed-demo.mjs --purge --write # removes it again
 *
 * Point DATABASE_URL wherever you want it. Against the live database it adds
 * two engagements and nothing else; it touches no existing row, and --purge
 * deletes exactly what it made.
 *
 * The findings here are hand-written, not model output. They exist to give the
 * screens something to render and are labelled DEMO throughout for that reason:
 * this shows nothing whatever about how well the review engine reviews. The
 * eval suite is what measures that.
 */
import postgres from 'postgres';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');
const PURGE = process.argv.includes('--purge');
/**
 * Does the whole seed for real and then throws it away.
 *
 * This is how the script is tested. It runs the same code against the same
 * database in a schema of its own, inside a transaction that is rolled back,
 * so "does the seed work" can be answered without deciding "where do the
 * tables live" first — which is the user's call, not the script's.
 */
const REHEARSE = process.argv.includes('--rehearse');
const REHEARSAL_SCHEMA = 'trc_demo_rehearsal';

/** Marks every row this script owns, so --purge can be exact. */
const DEMO_EIN = '[EIN-demo-01]';
const DEMO_LABEL = 'DEMO — Northwind Traders (not a real client)';

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

/**
 * Compiles the shipping engine rather than restating it.
 *
 * The demo has to go in through the same code the app uses — the same finding
 * codes, the same lineage keys, the same verdict rules — or it would be a
 * demonstration of this script instead of a demonstration of the product.
 */
function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trc-seed-'));
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

  // Nothing here calls a model. A provider that throws is the honest stub:
  // if this script ever starts reaching one, it should fail loudly rather
  // than quietly spend money on a demo.
  writeFileSync(
    path.join(dir, 'providers-stub.js'),
    `export const getProvider = () => ({
       async streamChat() { throw new Error('The demo seed must not call a model.'); },
     });`,
  );
  writeFileSync(path.join(dir, 'chat-stub.js'), `export async function recordUsage() {}`);
  writeFileSync(
    path.join(dir, 'return-data-stub.js'),
    `export const ModelVisualParser = { id: 'model-visual', async parse() { return { parts: [], index: [], documents: [] }; } };`,
  );
  writeFileSync(
    path.join(dir, 'prompts-stub.js'),
    `export async function buildStagePrompt() { throw new Error('The demo seed builds no prompts.'); }`,
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

/** The whole schema text out of lib/db.ts — the same string the app runs. */
function schemaSql() {
  const dbTs = readFileSync(path.join(ROOT, 'lib/db.ts'), 'utf8');
  const marker = 'const SCHEMA = `';
  const start = dbTs.indexOf(marker);
  if (start < 0) throw new Error('Could not find SCHEMA in lib/db.ts');
  const from = start + marker.length;
  const end = dbTs.indexOf('\n`;', from);
  if (end < 0) throw new Error('Could not find the end of SCHEMA in lib/db.ts');
  return dbTs.slice(from, end);
}

/* --------------------------------------------------------- the demo data */

/**
 * Two years of books, with a problem that spans both.
 *
 * The 86,000 sitting in 6300 is member draws written up as a consulting
 * expense, and it is there in both years — which is what makes the year-on-year
 * screen say something worth reading. Cash is 1,220 away from the bank
 * reconciliation in the later year, which is the other kind of finding: a
 * tie-out that fails for reasons nobody has explained.
 */
const TRIAL_BALANCE = {
  2025: [
    'Account,Description,Debit,Credit',
    '1010,Operating cash,43150.00,',
    '1200,Sundry Debtors,128450.00,',
    '1500,Suspense,3200.00,',
    '2100,Trade Creditors,,58200.00',
    '2400,Due to S Rao (member),,45000.00',
    '3000,Members capital,,100000.00',
    '3100,Distributions to members,40000.00,',
    '4000,Consulting revenue,,444200.00',
    '6100,Salaries and wages,214000.00,',
    '6300,Consulting fees - S Rao,86000.00,',
    '6500,Meals and entertainment,8400.00,',
    '6800,Rent - S Rao family trust,120000.00,',
    // Nothing recognises this, and it is here on purpose: an account the chart
    // cannot place is left unplaced and put in front of the reviewer rather
    // than filed under the nearest guess.
    '6950,Sundry adjustments - see note 4,4200.00,',
    'Total,,647400.00,647400.00',
  ].join('\n'),
  2024: [
    'Account,Description,Debit,Credit',
    '1010,Operating cash,38900.00,',
    '1200,Sundry Debtors,96300.00,',
    '2100,Trade Creditors,,44100.00',
    '2400,Due to S Rao (member),,30000.00',
    '3000,Members capital,,100000.00',
    '3100,Distributions to members,25000.00,',
    '4000,Consulting revenue,,388900.00',
    '6100,Salaries and wages,197800.00,',
    '6300,Consulting fees - S Rao,86000.00,',
    '6500,Meals and entertainment,7100.00,',
    '6800,Rent - S Rao family trust,112000.00,',
    'Total,,563100.00,563100.00',
  ].join('\n'),
};

const DRAWS_LOCATION = {
  form: '1065',
  schedule: 'K-1',
  line: '19a',
  gl_account: '6300',
};

const findingsFor = (year) => {
  const draws = {
    kind: 'exception',
    defectKind: 'wrong_classification',
    category: 'bookkeeping',
    title: 'DEMO: member draws written up as a consulting expense',
    whatIsWrong:
      '6300 "Consulting fees - S Rao" holds 86,000 paid to a member of the LLC. A member is not ' +
      'a contractor of their own partnership, so this is a distribution, not a deductible expense.',
    whyItMatters:
      'It understates ordinary income by 86,000 and misstates the K-1 — and because it is a ' +
      'bookkeeping habit rather than a return error, it repeats every year until the books change.',
    location: DRAWS_LOCATION,
    fix: {
      where: 'Books: reclassify 6300 to 3100. Drake: Schedule K, ordinary income.',
      change: 'Move the 86,000 from consulting fees to distributions to members.',
      then: 'Re-check ordinary income, the K-1 line 19a distribution and the capital accounts.',
      why: 'A payment to a member for services in the ordinary course is a guaranteed payment or a draw, not third-party consulting.',
    },
    amounts: [
      {
        label: 'in_6300',
        value: 86000,
        source_kind: 'text_doc',
        source_ref: `trial-balance-${year}.csv`,
        verified: true,
        confidence: 0.95,
      },
    ],
    owner: 'preparer',
    confidence: 0.94,
  };

  if (year === 2024) {
    return {
      s1: [
        {
          ...draws,
          status: 'closed',
          statusNote: 'DEMO: recorded as fixed in the 2024 file — and back again in 2025.',
        },
        {
          kind: 'agreed',
          defectKind: null,
          category: 'bookkeeping',
          title: 'DEMO: trial balance totals agree',
          whatIsWrong: 'Debits and credits both 563,100. Checked, no exception.',
          owner: null,
        },
      ],
      s2: [],
      tieOuts: [
        {
          name: 'Cash per books to bank reconciliation',
          leftValue: 38900,
          rightValue: 38900,
          leftSource: 'trial-balance-2024.csv',
          rightSource: 'bank-rec-dec-2024.xlsx',
          agrees: true,
        },
      ],
      questions: [],
    };
  }

  return {
    s1: [
      draws,
      {
        kind: 'exception',
        defectKind: 'unexplained_tieout_failure',
        category: 'bookkeeping',
        title: 'DEMO: cash does not agree to the December bank reconciliation',
        whatIsWrong:
          'The trial balance shows 43,150 in 1010. The December reconciliation shows 41,930. ' +
          'The 1,220 difference is not explained anywhere in the file.',
        whyItMatters:
          'Until the difference is explained it is not known whether the return is wrong by 1,220 ' +
          'or by considerably more with offsetting errors.',
        location: { form: '1065', schedule: 'L', line: '1d', gl_account: '1010' },
        fix: {
          where: 'Books: 1010. Drake: Schedule L, line 1d.',
          change: 'Identify the 1,220 and either post the missing entry or correct the reconciliation.',
          then: 'Re-run the tie-out before touching Schedule L.',
          why: 'A balance sheet line that does not tie to its supporting document supports nothing.',
        },
        amounts: [
          { label: 'per_books', value: 43150, source_kind: 'text_doc', source_ref: 'trial-balance-2025.csv', verified: true, confidence: 0.95 },
          { label: 'per_bank_rec', value: 41930, source_kind: 'text_doc', source_ref: 'bank-rec-dec-2025.xlsx', verified: true, confidence: 0.95 },
          { label: 'difference', value: 1220, source_kind: 'calc', source_ref: 'run_analysis', verified: true, confidence: 1 },
        ],
        owner: 'preparer',
        confidence: 0.97,
      },
      {
        kind: 'exception',
        defectKind: 'missing_evidence',
        category: 'bookkeeping',
        title: 'DEMO: suspense account still open at the year end',
        whatIsWrong: '1500 "Suspense" carries 3,200 at 31 December with no supporting schedule.',
        whyItMatters:
          'A suspense balance at a year end is unallocated by definition, so nothing downstream ' +
          'of it can be said to be right — including whichever line it eventually lands on.',
        location: { form: '1065', schedule: 'L', line: null, gl_account: '1500' },
        fix: {
          where: 'Books: 1500.',
          change: 'Allocate the 3,200 to the accounts it belongs to, or provide the schedule.',
          then: 'Re-check the affected Schedule L lines.',
          why: 'Nothing may be left unallocated at a reporting date.',
        },
        amounts: [
          { label: 'suspense_balance', value: 3200, source_kind: 'text_doc', source_ref: 'trial-balance-2025.csv', verified: true, confidence: 0.95 },
        ],
        owner: 'preparer',
        confidence: 0.9,
      },
      {
        kind: 'agreed',
        defectKind: null,
        category: 'bookkeeping',
        title: 'DEMO: trial balance totals agree',
        whatIsWrong: 'Debits and credits both 647,400. Checked, no exception.',
        owner: null,
      },
    ],
    s2: [
      {
        kind: 'exception',
        defectKind: 'unsupported_position',
        category: 'financial',
        title: 'DEMO: related-party rent with nothing on file to support the rate',
        whatIsWrong:
          '120,000 of rent is paid to a trust connected to the same member, up from 112,000. ' +
          'There is no lease and no comparable in the file.',
        whyItMatters:
          'A related-party rate that cannot be shown to be arm\'s length is the deduction most ' +
          'likely to be adjusted on examination, and it is 27% of ordinary expenses here.',
        location: { form: '1065', schedule: null, line: '13', gl_account: '6800' },
        fix: {
          where: 'Drake: deductions, rent. Request from the client: the lease.',
          change: 'Obtain the lease and one market comparable for the space.',
          then: 'If neither exists, restate the rent to a supportable figure and disclose the relationship.',
          why: 'The deduction stands on evidence of the rate, not on the payment having been made.',
        },
        amounts: [
          { label: 'rent_paid', value: 120000, source_kind: 'text_doc', source_ref: 'trial-balance-2025.csv', verified: true, confidence: 0.95 },
          { label: 'prior_year', value: 112000, source_kind: 'text_doc', source_ref: 'trial-balance-2024.csv', verified: true, confidence: 0.95 },
        ],
        owner: 'client',
        confidence: 0.88,
      },
    ],
    tieOuts: [
      {
        name: 'Cash per books to bank reconciliation',
        leftValue: 43150,
        rightValue: 41930,
        leftSource: 'trial-balance-2025.csv',
        rightSource: 'bank-rec-dec-2025.xlsx',
        agrees: false,
      },
      {
        name: 'Revenue per books to Schedule K line 1',
        leftValue: 444200,
        rightValue: 444200,
        leftSource: 'trial-balance-2025.csv',
        rightSource: 'return.pdf#p1',
        agrees: true,
      },
    ],
    questions: [
      {
        owner: 'preparer',
        question:
          'DEMO: the 86,000 in 6300 is paid to S Rao, who is a member. Was this treated as a ' +
          'guaranteed payment, or should it be a distribution?',
        figure: '86,000 in 6300 "Consulting fees - S Rao"',
        evidenceNeeded: 'The engagement letter or the member agreement covering the arrangement.',
      },
      {
        owner: 'preparer',
        question: 'DEMO: what is the 1,220 difference between cash per books and the December reconciliation?',
        figure: '43,150 per books against 41,930 per the reconciliation',
        evidenceNeeded: 'The reconciliation, or the entry that was missed.',
      },
      {
        owner: 'preparer',
        question: 'DEMO: what does the 3,200 in the suspense account consist of?',
        figure: '3,200 in 1500 "Suspense"',
        evidenceNeeded: 'The breakdown behind the balance.',
      },
      {
        owner: 'client',
        question: 'DEMO: is there a written lease for the premises rented from the family trust?',
        figure: '120,000 of rent in 6800',
        evidenceNeeded: 'The lease, and anything held on the market rate for comparable space.',
      },
      {
        owner: 'preparer',
        question:
          'DEMO: meals and entertainment of 8,400 is in one account. How much of it is entertainment, ' +
          'which is not deductible at all?',
        figure: '8,400 in 6500',
        evidenceNeeded: 'The split, or the underlying invoices.',
      },
    ],
  };
};

/* -------------------------------------------------------------- the seed */

const DATABASE_URL = envValue('DATABASE_URL') || envValue('POSTGRES_URL');
if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing from .env');
  process.exit(1);
}

const host = (() => {
  try {
    return new URL(DATABASE_URL).host;
  } catch {
    return 'unknown host';
  }
})();

const dir = build();
const shim = await import(pathToFileURL(path.join(dir, 'db-shim.js')).href);
const store = await import(pathToFileURL(path.join(dir, 'engine/store.js')).href);
const books = await import(pathToFileURL(path.join(dir, 'engine/books.js')).href);
const severity = await import(pathToFileURL(path.join(dir, 'engine/severity.js')).href);
const stageDefs = await import(pathToFileURL(path.join(dir, 'engine/stage-defs.js')).href);
const versioning = await import(pathToFileURL(path.join(dir, 'engine/versioning.js')).href);
const orchestrator = await import(pathToFileURL(path.join(dir, 'engine/orchestrator.js')).href);

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
shim.useConnection(sql);

/** Fills in the severity and the lineage key the way the pipeline does. */
function graded(stageKey, finding) {
  return {
    ...finding,
    severity: severity.classify({ kind: finding.kind, defectKind: finding.defectKind ?? null }),
    lineageKey: versioning.lineageKey({
      stageKey,
      defectKind: finding.defectKind ?? null,
      location: finding.location ?? null,
      title: finding.title,
    }),
  };
}

async function seedYear(actorId, year) {
  const engagement = await store.createEngagement(actorId, {
    clientLabel: DEMO_LABEL,
    entityName: 'Northwind Traders LLC',
    ein: DEMO_EIN,
    returnType: '1065',
    taxYear: year,
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-12-31`,
  });

  await store.assertFact(actorId, engagement.id, 'jurisdictions', ['US-FED', 'US-NJ'], 'user');
  // What is in the file. Without it the verdict correctly reports the New
  // Jersey return as missing, which would be a different demo — the point here
  // is the books, not an absent filing.
  await store.assertFact(
    actorId,
    engagement.id,
    'forms_present',
    ['1065', 'US-NJ return'],
    'user',
  );
  const facts = await store.currentFacts(engagement.id);

  const imported = await books.recordImport(actorId, {
    engagementId: engagement.id,
    source: books.spreadsheetSource(async () => TRIAL_BALANCE[year]),
    ref: `demo-trial-balance-${year}`,
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-12-31`,
  });

  const run = await store.createRun(actorId, {
    engagementId: engagement.id,
    runNumber: await store.nextRunNumber(engagement.id),
    status: 'running',
    promptVersion: 'demo-seed',
    model: 'none — hand-written demo data',
    corpusHash: `demo-${year}`,
    factsSnapshot: facts,
  });

  const plan = stageDefs.planStages({ returnType: '1065', facts });
  await store.createStages(
    run.id,
    plan.map((stage, index) => ({ stageKey: stage.stageKey, seq: index, status: stage.status })),
  );

  // The same call the real run-create route makes, so the printed workpaper
  // says what was not checked and why rather than staying silent about it.
  await orchestrator.recordPlannedGaps(run.id, {
    notApplicable: plan
      .filter((stage) => stage.status === 'not_applicable')
      .map((stage) => ({ stageKey: stage.stageKey, reason: stage.reason })),
  });

  const data = findingsFor(year);

  await store.insertFindings(run.id, 'S0', [
    graded('S0', {
      kind: 'agreed',
      defectKind: null,
      category: 'irs_return',
      title: 'DEMO: entity, period and return type agree across the file',
      whatIsWrong: `Northwind Traders LLC, 1065, calendar ${year}. Checked, no exception.`,
      owner: null,
    }),
  ]);

  const s1 = await store.insertFindings(
    run.id,
    'S1',
    data.s1.map((finding) => graded('S1', finding)),
  );
  if (data.s2.length) {
    await store.insertFindings(
      run.id,
      'S2',
      data.s2.map((finding) => graded('S2', finding)),
    );
  }

  const cashFinding = s1.find((row) => row.title.includes('bank reconciliation'));
  await store.insertTieOuts(
    run.id,
    'S1',
    data.tieOuts.map((tie) => ({
      ...tie,
      findingId: tie.agrees ? null : (cashFinding?.id ?? null),
    })),
  );

  if (data.questions.length) await store.insertQuestions(run.id, data.questions);

  for (const stage of await store.listStages(run.id)) {
    if (stage.status === 'not_applicable') continue;
    await store.completeStage(stage.id, {
      status: 'complete',
      model: 'none — hand-written demo data',
      rawOutput: 'Seeded by tests/seed-demo.mjs. No model was called.',
      costMicros: 0,
    });
  }

  // The engine's own finalise, so the verdict comes from the same rules a real
  // run is settled by — required forms, failed tie-outs and all.
  await orchestrator.finalise(run.id, actorId);

  const rows = await store.listFindings(run.id);
  const settled = await store.getRun(run.id);

  return {
    engagement,
    run,
    verdict: settled?.verdict ?? null,
    findings: rows.length,
    mapped: imported.mapped,
    unmapped: imported.unmapped,
  };
}

try {
  if (REHEARSE) {
    console.log(`database: ${host}`);
    console.log(`rehearsing in schema ${REHEARSAL_SCHEMA}, rolled back at the end\n`);

    await sql
      .begin(async (db) => {
        shim.useConnection(db);
        await db.unsafe(
          `CREATE SCHEMA ${REHEARSAL_SCHEMA}; SET LOCAL search_path TO ${REHEARSAL_SCHEMA};`,
        );
        await db.unsafe(schemaSql());
        await db.unsafe(
          `INSERT INTO users (id, email, role, display_name, is_active, created_at)
           VALUES ('rehearsal-user', 'rehearsal@example.invalid', 'admin', 'Rehearsal', 1, 0)`,
        );

        for (const year of [2024, 2025]) {
          const result = await seedYear('rehearsal-user', year);
          console.log(
            `TY ${year}: ${result.findings} register lines, verdict "${result.verdict}", ` +
              `${result.mapped} accounts mapped${
                result.unmapped ? `, ${result.unmapped} unplaced` : ''
              }`,
          );
        }

        // The point of the whole exercise: the problem in 6300 is one problem
        // across two years, not two unrelated ones.
        const recurrence = await import(
          pathToFileURL(path.join(dir, 'engine/recurrence.js')).href
        );
        const engagements = await db.unsafe(
          `SELECT id, tax_year FROM engagements WHERE ein = $1 ORDER BY tax_year`,
          [DEMO_EIN],
        );
        const years = [];
        for (const row of engagements) {
          const run = await store.latestReviewedRun(row.id);
          const findings = await store.listFindings(run.id);
          years.push({
            taxYear: row.tax_year,
            engagementId: row.id,
            runId: run.id,
            runNumber: run.run_number,
            findings: findings
              .filter((f) => f.kind === 'exception')
              .map((f) => ({
                id: f.id,
                code: f.finding_code,
                stageKey: f.stage_key,
                category: f.category,
                severity: f.severity,
                status: f.status,
                title: f.title,
                lineageKey: f.lineage_key,
                where: null,
              })),
          });
        }
        const items = recurrence.recurringFindings(years);
        console.log(`\nyear on year: ${recurrence.recurrenceSummary(items, years.length)}`);
        for (const item of items) {
          console.log(
            `  ${item.title} — ${item.appearances.map((a) => a.taxYear).join(', ')}` +
              `${item.cameBack ? ' (came back)' : ''}`,
          );
        }

        throw new Error('__rollback__');
      })
      .catch((err) => {
        if (err.message !== '__rollback__') throw err;
      });

    const left = await sql`
      SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ${REHEARSAL_SCHEMA}`;
    console.log(
      Number(left[0].n) === 0
        ? '\nrolled back — nothing was left behind.'
        : `\nWARNING: schema ${REHEARSAL_SCHEMA} still exists.`,
    );
    if (Number(left[0].n) !== 0) process.exitCode = 1;

    await sql.end();
    rmSync(dir, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }

  const existing = await sql`
    SELECT to_regclass('public.engagements') IS NOT NULL AS has_tables`;
  const hasTables = Boolean(existing[0]?.has_tables);

  console.log(`database: ${host}`);
  console.log(`review tables: ${hasTables ? 'already present' : 'not created yet'}`);

  if (PURGE) {
    const found = await sql`SELECT id, tax_year FROM engagements WHERE ein = ${DEMO_EIN}`;
    if (!found.length) {
      console.log('\nNothing to purge — no demo engagement is present.');
    } else if (!WRITE) {
      console.log(
        `\nWould delete ${found.length} demo engagement(s) (${found
          .map((r) => `TY ${r.tax_year}`)
          .join(', ')}) and everything hanging off them.\nRe-run with --write to do it.`,
      );
    } else {
      const deleted = await sql`DELETE FROM engagements WHERE ein = ${DEMO_EIN} RETURNING id`;
      console.log(`\nDeleted ${deleted.length} demo engagement(s), cascading to runs and findings.`);
    }
    await sql.end();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }

  if (!WRITE) {
    console.log(
      [
        '',
        'Would do, in this order:',
        `  1. run the schema in lib/db.ts (idempotent — creates the review tables if absent)`,
        `  2. create two engagements for "${DEMO_LABEL}", TY 2024 and TY 2025`,
        '  3. import a trial balance for each, normalised into the chart of accounts',
        '  4. record a finished run against each, with hand-written findings, tie-outs and questions',
        '',
        'Nothing else is touched. Re-run with --write to do it, and',
        '--purge --write to remove it again afterwards.',
        '',
      ].join('\n'),
    );
    await sql.end();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }

  const already = await sql`SELECT COUNT(*) AS n FROM engagements WHERE ein = ${DEMO_EIN}`.catch(
    () => [{ n: 0 }],
  );
  if (Number(already[0].n) > 0) {
    console.error(
      '\nA demo engagement is already there. Run with --purge --write first if you want a fresh one.',
    );
    await sql.end();
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  console.log('\nrunning the schema…');
  await sql.unsafe(schemaSql());

  const actor = await sql`
    SELECT id, email, role FROM users
     WHERE is_active = 1
     ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at
     LIMIT 1`;
  if (!actor.length) {
    console.error(
      'No active user to attribute this to. Every review action records who did it, so the ' +
        'demo needs a real account to hang off — log in once first.',
    );
    await sql.end();
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  const actorId = actor[0].id;
  console.log(`attributing to ${actor[0].email}`);

  // The earlier year first, so run numbering and the recurrence history read
  // in the order they happened.
  for (const year of [2024, 2025]) {
    const result = await seedYear(actorId, year);
    console.log(
      `\nTY ${year}: ${result.findings} register lines, verdict "${result.verdict}", ` +
        `${result.mapped} accounts mapped${result.unmapped ? `, ${result.unmapped} unplaced` : ''}`,
    );
    console.log(`  /reviews/${result.engagement.id}`);
    console.log(`  /reviews/${result.engagement.id}/runs/${result.run.run_number}`);
    console.log(`  /reviews/${result.engagement.id}/books`);
    if (year === 2025) console.log(`  /reviews/${result.engagement.id}/history`);
  }

  console.log(
    [
      '',
      'Done. Walk it in this order: the summary, then a finding, then the questions,',
      'then the books, then year on year. Sign-off will refuse — the verdict is a Hold,',
      'and a Hold is the default state of an unapproved register.',
      '',
      'The findings are hand-written, not model output. This says nothing about how well',
      'the engine reviews; tests/review-golden.mjs is what measures that.',
      '',
      'Remove it with: node tests/seed-demo.mjs --purge --write',
      '',
    ].join('\n'),
  );
} catch (err) {
  console.error('\n' + (err.stack ?? err.message));
  process.exitCode = 1;
} finally {
  await sql.end();
  rmSync(dir, { recursive: true, force: true });
}
