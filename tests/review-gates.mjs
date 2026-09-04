/**
 * Unit tests for the review engine's decision layer.
 *
 * These are the modules that must not depend on a model's judgement: the
 * severity tree, the amounts gate, the authority gate, the obligations rules
 * and the verdict. No database, no network, no API key — they are pure
 * functions, and that is the point of having separated them.
 *
 * Includes the fabrication and arithmetic probes the output schema requires as
 * pass/fail gates: a citation nothing grounded must never come back as
 * authority, and a figure with no source must never reach the register.
 *
 *   node tests/review-gates.mjs
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

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
 * Compiles the real modules rather than restating their logic.
 *
 * `@/lib/config` is replaced with a stub so the corpus switch can be driven
 * from the test; everything else is the shipping code, unmodified.
 */
function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trc-gates-'));

  // A live binding, not a const: authority.ts reads the flag when it runs, so
  // exporting `let` lets the test drive the corpus switch both ways. In the
  // real config it is read from the environment once, which is correct there.
  writeFileSync(
    path.join(dir, 'config-stub.js'),
    `export let CITATION_CORPUS_ENABLED = false;
     export const setCorpus = (value) => { CITATION_CORPUS_ENABLED = value; };
     export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;`,
  );

  const sources = [
    ['lib/review-types.ts', 'review-types.js'],
    ['lib/review-engine/stage-defs.ts', 'stage-defs.js'],
    ['lib/review-engine/severity.ts', 'severity.js'],
    ['lib/review-engine/amounts.ts', 'amounts.js'],
    ['lib/review-engine/authority.ts', 'authority.js'],
    ['lib/review-engine/obligations.ts', 'obligations.js'],
    ['lib/review-engine/verdict.ts', 'verdict.js'],
    ['lib/review-engine/derive.ts', 'derive.js'],
    ['lib/review-engine/questions.ts', 'questions.js'],
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
        .replace(/from ['"]@\/lib\/config['"]/g, "from './config-stub.js'")
        .replace(/from ['"]@\/lib\/review-types['"]/g, "from './review-types.js'")
        .replace(/from ['"]\.\/stage-defs['"]/g, "from './stage-defs.js'")
        .replace(/from ['"]\.\/obligations['"]/g, "from './obligations.js'")
        .replace(/from ['"]\.\/severity['"]/g, "from './severity.js'"),
    );
  }
  return dir;
}

const dir = build();
const load = (name) => import(pathToFileURL(path.join(dir, name)).href);

try {
  const severity = await load('severity.js');
  const amounts = await load('amounts.js');
  const authority = await load('authority.js');
  const obligations = await load('obligations.js');
  const verdict = await load('verdict.js');
  const stages = await load('stage-defs.js');
  const config = await load('config-stub.js');

  /* ================================================== the severity tree */

  const grade = (defectKind) => severity.classify({ kind: 'exception', defectKind });

  check('a wrong amount is Critical', grade('wrong_amount') === 'Critical');
  check('a wrong classification is Critical', grade('wrong_classification') === 'Critical');
  check('a missing form is Critical', grade('missing_form') === 'Critical');
  check('a wrong entity type is Critical', grade('wrong_entity_type') === 'Critical');
  check('an unsupported position is High', grade('unsupported_position') === 'High');
  check('an unexplained tie-out failure is High', grade('unexplained_tieout_failure') === 'High');
  check('a right figure with no workpaper is Medium', grade('missing_evidence') === 'Medium');
  check('presentation is Low', grade('presentation') === 'Low');

  check(
    'an agreed line carries no severity at all',
    severity.classify({ kind: 'agreed', defectKind: null }) === null,
  );
  check(
    'a coverage note carries no severity',
    severity.classify({ kind: 'coverage', defectKind: null }) === null,
  );
  check(
    'an exception nobody characterised is High, not dropped and not guessed down',
    severity.classify({ kind: 'exception', defectKind: null }) === 'High',
  );

  check(
    'severity ranks worst-first for the summary',
    severity.severityRank('Critical') < severity.severityRank('High') &&
      severity.severityRank('High') < severity.severityRank('Medium') &&
      severity.severityRank('Medium') < severity.severityRank('Low'),
  );

  check(
    'categories come from the stage that produced the finding',
    severity.categoryFor('S1') === 'bookkeeping' &&
      severity.categoryFor('S2') === 'financial' &&
      severity.categoryFor('S3-FED') === 'irs_return' &&
      severity.categoryFor('S3-INTL') === 'cross_border' &&
      severity.categoryFor('S3-INDIA') === 'cross_border',
  );
  check(
    'a stage may hand a finding to another category',
    severity.categoryFor('S3-INDIA', 'transfer_pricing') === 'transfer_pricing',
  );

  check(
    'only a Stage 0 Critical halts the run; later ones set Hold but finish the register',
    severity.haltsRun('S0', 'Critical') === true &&
      severity.haltsRun('S3-FED', 'Critical') === false &&
      severity.haltsRun('S0', 'High') === false,
  );

  /* =============================================== the amounts gate (Rule 1) */

  const index = amounts.buildNumberIndex({
    documents: [
      { fileId: 'f1', filename: 'bank-dec.xlsx', text: 'B12: 41,930.00\nB13: (250)\nB14: $1,204,556' },
      { fileId: 'f2', filename: 'return.pdf', text: null },
    ],
    calcs: [{ id: 'c1', values: [250, 96410.5] }],
  });

  check(
    'thousands separators, currency and decimals all index to the same figure',
    index.byDocument.get('f1').has(4193000) && index.byDocument.get('f1').has(120455600),
  );
  check(
    'a parenthesised balance indexes both ways round',
    index.byDocument.get('f1').has(25000) && index.byDocument.get('f1').has(-25000),
  );

  const good = amounts.checkAmounts(
    [
      { label: 'per_bank_rec', value: 41930, source_kind: 'text_doc', source_ref: 'bank-dec.xlsx' },
      { label: 'difference', value: 250, source_kind: 'calc', source_ref: 'c1' },
    ],
    index,
  );
  check(
    'a figure quoted from a document and one from the sandbox both verify',
    good.problems.length === 0 && good.accepted.every((a) => a.verified),
  );

  // ARITHMETIC PROBE — the figure is plausible and completely unsourced.
  const invented = amounts.checkAmounts([{ label: 'depreciation', value: 18450 }], index);
  check(
    'PROBE: a figure with no source is refused outright',
    invented.accepted.length === 0 && /source_kind and source_ref/.test(invented.problems[0].reason),
  );

  const wrongDoc = amounts.checkAmounts(
    [{ label: 'cash', value: 99999, source_kind: 'text_doc', source_ref: 'bank-dec.xlsx' }],
    index,
  );
  check(
    'PROBE: a figure that is not in the document it cites is refused',
    wrongDoc.accepted.length === 0 && /does not appear/.test(wrongDoc.problems[0].reason),
  );

  const notComputed = amounts.checkAmounts(
    [{ label: 'tax', value: 7321, source_kind: 'calc', source_ref: 'c1' }],
    index,
  );
  check(
    'PROBE: a figure claimed as computed that the sandbox never produced is refused',
    notComputed.accepted.length === 0 && /calculation layer/.test(notComputed.problems[0].reason),
  );

  const visual = amounts.checkAmounts(
    [{ label: 'per_return', value: 42180, source_kind: 'visual', source_ref: 'return.pdf#p3' }],
    index,
  );
  check(
    'a page-image read is accepted, marked unverified, and caps the confidence',
    visual.accepted.length === 1 &&
      visual.accepted[0].verified === false &&
      visual.confidenceCap === amounts.VISUAL_CAP,
    `cap ${visual.confidenceCap}`,
  );

  /* ============================================ the authority gate (Rule 2) */

  config.setCorpus(false);

  // FABRICATION PROBE — a real-looking section, asserted as grounded.
  const fabricated = authority.gateAuthority({ status: 'grounded', citation: 'IRC 162(a)' });
  check(
    'PROBE: with no corpus, a citation cannot be grounded',
    fabricated.status === 'verify' && fabricated.citation === null,
  );
  check(
    'PROBE: what was claimed is kept, so invented authority is auditable',
    fabricated.claimedCitation === 'IRC 162(a)',
  );

  check(
    'grounded with no citation at all is not grounded either',
    authority.gateAuthority({ status: 'grounded' }).status === 'verify',
  );
  check(
    'a finding needing no authority stays that way',
    authority.gateAuthority({ status: 'none_required' }).status === 'none_required',
  );

  config.setCorpus(true);
  check(
    'with a corpus, a citation still needs a retrieved span to be grounded',
    authority.gateAuthority({ status: 'grounded', citation: 'IRC 162(a)' }).status === 'verify',
  );
  check(
    'a citation with a span is granted once a corpus exists',
    authority.gateAuthority({
      status: 'grounded',
      citation: 'IRC 162(a)',
      sourceSpan: 'corpus:irc/162#a',
    }).status === 'grounded',
  );
  config.setCorpus(false);

  /* ------------------------------------------------------- obligations */

  const foreign = obligations.requiredForms('1120', {
    foreign_owner_pct: 30,
    foreign_accounts: true,
    jurisdictions: ['US-FED', 'US-NJ'],
  });
  const forms = foreign.map((o) => o.form);
  check(
    'a 25% foreign owner pulls in a 5472',
    forms.includes('5472'),
    forms.join(', '),
  );
  check('foreign accounts pull in both FBAR and 8938', forms.includes('FBAR (FinCEN 114)') && forms.includes('8938'));
  check('a state in scope pulls in its return', forms.includes('US-NJ return'));
  check(
    'the federal jurisdiction is not itself an extra obligation',
    !forms.some((f) => f.startsWith('US-FED')),
  );

  check(
    'a 19% foreign owner does not',
    !obligations.requiredForms('1120', { foreign_owner_pct: 19 }).some((o) => o.form === '5472'),
  );

  check(
    'form matching ignores punctuation and the word Form',
    obligations.missingForms([{ form: '5472', because: '', factKey: '' }], ['Form 5472']).length === 0,
  );

  /* ---------------------------------------------------------- verdict */

  const base = { requiredForms: [], presentForms: [], facts: {} };

  const clean = verdict.computeVerdict({
    ...base,
    findings: [{ id: '1', code: 'S1-001', stageKey: 'S1', severity: 'Low', status: 'open', owner: 'preparer' }],
  });
  check('nothing serious open reads Clear', clean.result === 'clear', clean.result);

  const critical = verdict.computeVerdict({
    ...base,
    findings: [{ id: '1', code: 'S3-001', stageKey: 'S3-FED', severity: 'Critical', status: 'open', owner: null }],
  });
  check('an open Critical is a Hold', critical.result === 'hold' && critical.criticalOpen === 1);

  const high = verdict.computeVerdict({
    ...base,
    findings: [{ id: '1', code: 'S1-001', stageKey: 'S1', severity: 'High', status: 'open', owner: 'preparer' }],
  });
  check('an open High releases only with conditions', high.result === 'release_with_conditions');

  // Rule 3, the case the whole answered_pending_evidence status exists for.
  const pending = verdict.computeVerdict({
    ...base,
    findings: [
      { id: '1', code: 'S1-001', stageKey: 'S1', severity: 'High', status: 'answered_pending_evidence', owner: 'preparer' },
    ],
  });
  check(
    'a High answered in words with nothing attached does not clear',
    pending.result === 'release_with_conditions' && pending.highOpen === 1,
  );
  check(
    'the same High with evidence attached does clear',
    verdict.computeVerdict({
      ...base,
      findings: [{ id: '1', code: 'S1-001', stageKey: 'S1', severity: 'High', status: 'closed', owner: 'preparer' }],
    }).result === 'clear',
  );

  const unowned = verdict.computeVerdict({
    ...base,
    findings: [{ id: '1', code: 'S1-001', stageKey: 'S1', severity: 'Medium', status: 'open', owner: null }],
  });
  check('a Medium nobody owns is not Clear', unowned.result === 'release_with_conditions');
  check(
    'a Medium with an owner is a condition, and Clear',
    verdict.computeVerdict({
      ...base,
      findings: [{ id: '1', code: 'S1-001', stageKey: 'S1', severity: 'Medium', status: 'open', owner: 'preparer' }],
    }).result === 'clear',
  );

  // Rule 4.
  const missingForm = verdict.computeVerdict({
    ...base,
    findings: [],
    requiredForms: [{ form: '5472', because: 'A foreign owner holds 30%.', factKey: 'foreign_owner_pct' }],
    presentForms: ['1120'],
  });
  check(
    'a required form that is absent is a Hold on its own',
    missingForm.result === 'hold' && /5472 is required/.test(missingForm.blockers[0]),
  );

  // Rule 4a.
  const indiaSilent = verdict.computeVerdict({
    ...base,
    facts: { india_link: true },
    findings: [{ id: '1', code: 'S1-001', stageKey: 'S1', severity: 'Low', status: 'closed', owner: null }],
  });
  check(
    'an Indian link with no India line on the register is a Hold',
    indiaSilent.result === 'hold' && indiaSilent.blockers.some((b) => /India-symmetry/.test(b)),
  );
  check(
    'an "agreed" India line satisfies it — the module ran and said so',
    verdict.computeVerdict({
      ...base,
      facts: { india_link: true },
      findings: [{ id: '1', code: 'S3-010', stageKey: 'S3-INDIA', severity: null, status: 'closed', owner: null }],
    }).result === 'clear',
  );

  const brokenTie = verdict.computeVerdict({
    ...base,
    findings: [],
    failedTieOuts: [{ name: 'L partners capital = M-2 line 9', findingId: null }],
  });
  check('a failed tie-out is a Hold', brokenTie.result === 'hold');

  check(
    'positions on unverified authority are listed for the register',
    verdict.computeVerdict({
      ...base,
      findings: [
        { id: '1', code: 'S3-009', stageKey: 'S3-FED', severity: 'High', status: 'open', owner: 'reviewer', authorityStatus: 'verify', title: 'Members treated as limited partners' },
      ],
    }).positionsToRegister.length === 1,
  );

  /* -------------------------------------------------------- approval */

  check(
    'nobody may sign off a register that is on Hold',
    verdict.canApprove(critical, 'clear').ok === false,
  );
  check(
    'nor sign off as Clear a register that only releases with conditions',
    verdict.canApprove(high, 'clear').ok === false,
  );
  check(
    'but may sign off the conditions themselves',
    verdict.canApprove(high, 'release_with_conditions').ok === true,
  );
  check(
    'Hold is not a thing to approve — it is the unapproved state',
    verdict.canApprove(clean, 'hold').ok === false,
  );

  /* ------------------------------------------------------ stage plan */

  const plan = stages.planStages({ returnType: '1065', facts: { india_link: true, jurisdictions: ['US-FED', 'US-NJ'] } });
  check(
    'the stage sequence is fixed and complete',
    plan.map((p) => p.stageKey).join(' ') === 'S0 S1 S2 S3-FED S3-INTL S3-STATE S3-INDIA S4',
    plan.map((p) => p.stageKey).join(' '),
  );
  check(
    'an Indian link turns the India and international modules on',
    plan.find((p) => p.stageKey === 'S3-INDIA').status === 'pending' &&
      plan.find((p) => p.stageKey === 'S3-INTL').status === 'pending',
  );

  const domestic = stages.planStages({ returnType: '1120', facts: { jurisdictions: ['US-FED'] } });
  check(
    'a purely domestic engagement skips them, with a reason rather than in silence',
    domestic.find((p) => p.stageKey === 'S3-INDIA').status === 'not_applicable' &&
      domestic.find((p) => p.stageKey === 'S3-STATE').status === 'not_applicable' &&
      Boolean(domestic.find((p) => p.stageKey === 'S3-INDIA').reason),
  );
  check(
    'the books and financial stages always run',
    domestic.find((p) => p.stageKey === 'S1').status === 'pending' &&
      domestic.find((p) => p.stageKey === 'S2').status === 'pending',
  );

  check(
    'the federal stage reads the module for the return type',
    stages.referencesFor('S3-FED', '1065')[0] === 'references/stage-3-1065.md' &&
      stages.referencesFor('S3-FED', '1040-NR')[0] === 'references/stage-3-1040NR.md',
  );

  /* --------------------------------------------- the summary's own counts */

  const derive = await load('derive.js');

  const register = [
    { id: 'a', code: 'S1-001', category: 'bookkeeping', severity: 'Critical', status: 'open' },
    { id: 'b', code: 'S1-002', category: 'bookkeeping', severity: 'Low', status: 'open' },
    { id: 'c', code: 'S2-001', category: 'financial', severity: 'High', status: 'answered_pending_evidence' },
    { id: 'd', code: 'S3-001', category: 'cross_border', severity: 'High', status: 'open' },
    { id: 'e', code: 'S3-002', category: 'cross_border', severity: 'Critical', status: 'closed' },
    { id: 'f', code: 'S3-003', category: 'transfer_pricing', severity: 'Medium', status: 'escalated' },
    { id: 'g', code: 'S1-003', category: 'bookkeeping', severity: null, status: 'closed' },
  ];
  const summary = derive.deriveSummary(register);

  check(
    'a closed finding drops out of the category counts',
    summary.categories.cross_border.open === 1,
    `cross_border ${summary.categories.cross_border.open}`,
  );
  check(
    'a category reports its worst open severity',
    summary.categories.bookkeeping.worst === 'Critical' &&
      summary.categories.financial.worst === 'High',
  );
  check(
    'high-flag is a filter, so a Critical is counted in its category and there too',
    summary.categories.high_flag.open === 3 && summary.categories.bookkeeping.open === 2,
    `high_flag ${summary.categories.high_flag.open}, bookkeeping ${summary.categories.bookkeeping.open}`,
  );
  check(
    'an escalated item still counts as open',
    summary.categories.transfer_pricing.open === 1 && summary.escalated === 1,
  );
  check(
    'the top five are worst-first',
    summary.topFindingIds[0] === 'a' && summary.topFindingIds.slice(0, 3).includes('c'),
    summary.topFindingIds.join(', '),
  );
  check(
    'the top five is capped at five even with more open',
    derive.deriveSummary(
      Array.from({ length: 9 }, (_, i) => ({
        id: `x${i}`,
        code: `S1-00${i}`,
        category: 'bookkeeping',
        severity: 'High',
        status: 'open',
      })),
    ).topFindingIds.length === 5,
  );
  check(
    'ordering is stable between reloads',
    JSON.stringify(derive.deriveSummary(register).topFindingIds) ===
      JSON.stringify(derive.deriveSummary([...register].reverse()).topFindingIds),
  );
  check(
    'an agreed line with no severity is never in the top five',
    !summary.topFindingIds.includes('g'),
  );

  /* -------------------------------- the preparer's questions and answers */

  const questions = await load('questions.js');

  const findingsForQ = [
    { id: 'crit', severity: 'Critical', status: 'open' },
    { id: 'high', severity: 'High', status: 'open' },
    { id: 'med', severity: 'Medium', status: 'open' },
    { id: 'low', severity: 'Low', status: 'open' },
  ];
  const ask = (findingId, text = 'q') => ({ findingId, owner: 'preparer', question: text });

  const picked = questions.selectQuestions(
    [ask('low', 'about a Low'), ask('med'), ask('crit'), ask('high')],
    findingsForQ,
  );
  check(
    'questions about a Low finding are never asked',
    !picked.selected.some((q) => q.question === 'about a Low'),
  );
  check(
    'the worst findings are asked about first',
    picked.selected[0].findingId === 'crit' && picked.selected[1].findingId === 'high',
    picked.selected.map((q) => q.findingId).join(', '),
  );

  const many = questions.selectQuestions(
    Array.from({ length: 16 }, () => ask('high')),
    findingsForQ,
  );
  check(
    'the list is capped at ten, and says how many it dropped',
    many.selected.length === 10 && many.dropped === 6,
    `${many.selected.length} kept, ${many.dropped} dropped`,
  );

  const thin = questions.selectQuestions([ask('crit')], findingsForQ);
  check(
    'too few questions while serious findings are open is reported, not padded',
    thin.shortfall > 0 && thin.selected.length === 1,
    `shortfall ${thin.shortfall}`,
  );
  check(
    'nothing serious open means no shortfall',
    questions.selectQuestions([ask('med')], [{ id: 'med', severity: 'Medium', status: 'open' }])
      .shortfall === 0,
  );

  // The rule the whole answered_pending_evidence status exists for.
  check(
    'answering a High in words alone leaves it open',
    questions.outcomeOfAnswer({ severity: 'High', hasEvidence: false }).status ===
      'answered_pending_evidence',
  );
  check(
    'and says why, rather than just refusing',
    /does not close a High/.test(
      questions.outcomeOfAnswer({ severity: 'High', hasEvidence: false }).note ?? '',
    ),
  );
  check(
    'the same answer with a document attached closes it',
    questions.outcomeOfAnswer({ severity: 'High', hasEvidence: true }).status === 'closed',
  );
  check(
    'a Critical needs a document too',
    questions.outcomeOfAnswer({ severity: 'Critical', hasEvidence: false }).status ===
      'answered_pending_evidence',
  );
  check(
    'a Medium can be settled by explanation — the figure was never in doubt',
    questions.outcomeOfAnswer({ severity: 'Medium', hasEvidence: false }).status === 'answered',
  );
  check(
    'an answer needing judgement goes to a reviewer, not to closed',
    questions.outcomeOfAnswer({ severity: 'High', hasEvidence: true, needsReviewer: true })
      .status === 'escalated',
  );
  check(
    'an answer that has to come from the client is marked as waiting on them',
    questions.outcomeOfAnswer({ severity: 'High', hasEvidence: false, awaitingClient: true })
      .status === 'client',
  );
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error('\n' + (err.stack ?? err.message));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
