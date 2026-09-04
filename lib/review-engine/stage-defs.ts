import type { Category, DocRole, ReturnType, StageKey } from '@/lib/review-types';

/**
 * The stage table: what runs, in what order, and what makes it apply.
 *
 * SKILL.md says the sequence must not be reordered, and gives the reason —
 * most return errors are book errors faithfully copied onto the form, so fixing
 * the form without fixing the books means the same error returns next year.
 * A single prompt cannot be relied on to honour that; a table the orchestrator
 * walks can, because the code decides what runs next rather than the model.
 *
 * Stage 3 is four rows rather than one so each fits inside a serverless
 * invocation, and so answering an international question re-runs the
 * international module without redoing the federal one.
 */

export interface StageDef {
  key: StageKey;
  seq: number;
  /** Shown on the progress rail. */
  label: string;
  /** The category findings from this stage carry, unless the stage overrides it. */
  category: Category;
  /**
   * Reference files from the tax-return-review skill this stage reads.
   * Resolved through lib/review-engine/skills-source.ts, so the domain content
   * stays in markdown the firm can correct without a deploy.
   */
  references: string[];
  /**
   * Document roles this stage depends on. A re-run compares these against what
   * changed to decide whether the stage must run again or can be carried
   * forward — see versioning.ts.
   */
  consumes: DocRole[];
  /**
   * Whether the stage applies at all, given the engagement's facts. Returning
   * false records the stage as not_applicable with a reason — never a silent
   * omission, because Rule 3 says a skipped section must still be visible.
   */
  applies: (ctx: StageContext) => { applies: boolean; reason?: string };
}

export interface StageContext {
  returnType: ReturnType | null;
  facts: Record<string, unknown>;
}

/* ------------------------------------------------------------ fact readers */

const bool = (facts: Record<string, unknown>, key: string): boolean => facts[key] === true;

const num = (facts: Record<string, unknown>, key: string): number => {
  const value = facts[key];
  return typeof value === 'number' ? value : Number(value) || 0;
};

const list = (facts: Record<string, unknown>, key: string): string[] => {
  const value = facts[key];
  return Array.isArray(value) ? value.map(String) : [];
};

/** Jurisdictions other than the federal one — what makes a state module apply. */
export const stateJurisdictions = (facts: Record<string, unknown>): string[] =>
  list(facts, 'jurisdictions').filter((j) => j.toUpperCase() !== 'US-FED');

/**
 * Any fact that pulls an international information return into scope.
 *
 * Deliberately broad. Missing a 5471 because nobody ticked a box is the failure
 * mode this is guarding against, so anything suggestive turns the module on and
 * the module itself decides what is actually required.
 */
export const hasForeignFact = (facts: Record<string, unknown>): boolean =>
  bool(facts, 'india_link') ||
  bool(facts, 'foreign_partner') ||
  bool(facts, 'foreign_accounts') ||
  bool(facts, 'foreign_subsidiary') ||
  bool(facts, 'foreign_owner') ||
  num(facts, 'foreign_owner_pct') > 0 ||
  list(facts, 'foreign_jurisdictions').length > 0;

/**
 * The federal reference files for a return type, in the order SKILL.md lists
 * them. A foreign-owned disregarded entity files a pro-forma 1120 with a 5472,
 * so it reads the 5472 module as its federal step rather than the plain 1120.
 */
export const federalReferences = (returnType: ReturnType | null): string[] => {
  switch (returnType) {
    case '1065':
      return ['references/stage-3-1065.md'];
    case '1120':
    case '1120-S':
      return ['references/stage-3-1120.md', 'references/stage-3-1120F-5472.md'];
    case '1120-F':
      return ['references/stage-3-1120F-5472.md'];
    case '1120-DRE-5472':
      return ['references/stage-3-1120F-5472.md'];
    case '1040':
      return ['references/stage-3-1040.md'];
    case '1040-NR':
    case '1040-DUAL':
      return ['references/stage-3-1040NR.md'];
    default:
      return ['references/INDEX.md'];
  }
};

/* -------------------------------------------------------------- the table */

export const STAGE_DEFS: StageDef[] = [
  {
    key: 'S0',
    seq: 0,
    label: 'Scope and identity',
    category: 'irs_return',
    references: [],
    consumes: ['drake_export', 'engagement_letter', 'prior_year_return'],
    applies: () => ({ applies: true }),
  },
  {
    key: 'S1',
    seq: 1,
    label: 'Books and bookkeeping',
    category: 'bookkeeping',
    references: ['references/stage-1-books-and-gaap.md'],
    consumes: [
      'trial_balance_cy',
      'trial_balance_py',
      'gl_detail',
      'bank_statement',
      'fixed_asset_register',
    ],
    applies: () => ({ applies: true }),
  },
  {
    key: 'S2',
    seq: 2,
    label: 'Financial evaluation',
    category: 'financial',
    references: ['references/stage-2-financial-evaluation.md'],
    consumes: ['trial_balance_cy', 'trial_balance_py', 'prior_year_return', 'gl_detail'],
    applies: () => ({ applies: true }),
  },
  {
    key: 'S3-FED',
    seq: 3,
    label: 'Federal return',
    category: 'irs_return',
    references: [],
    consumes: ['drake_export', 'ownership_schedule', 'trial_balance_cy'],
    applies: () => ({ applies: true }),
  },
  {
    key: 'S3-INTL',
    seq: 4,
    label: 'International information returns',
    category: 'cross_border',
    references: ['references/stage-3-international-forms.md'],
    consumes: ['drake_export', 'ownership_schedule'],
    applies: ({ facts }) =>
      hasForeignFact(facts)
        ? { applies: true }
        : {
            applies: false,
            reason:
              'No foreign owner, account, affiliate or holding recorded on the engagement. ' +
              'If any exists, record it as a fact and re-run — this determination is made ' +
              'fresh each year and is never carried forward.',
          },
  },
  {
    key: 'S3-STATE',
    seq: 5,
    label: 'State and local',
    category: 'irs_return',
    references: ['references/stage-3-state.md'],
    consumes: ['drake_export', 'trial_balance_cy'],
    applies: ({ facts }) => {
      const states = stateJurisdictions(facts);
      return states.length
        ? { applies: true }
        : {
            applies: false,
            reason: 'No state or city jurisdiction recorded on the engagement.',
          };
    },
  },
  {
    key: 'S3-INDIA',
    seq: 6,
    label: 'India symmetry',
    category: 'cross_border',
    references: ['references/stage-3-india-symmetry.md'],
    consumes: ['drake_export', 'ownership_schedule'],
    applies: ({ facts }) =>
      bool(facts, 'india_link')
        ? { applies: true }
        : { applies: false, reason: 'No Indian owner, affiliate, income or asset recorded.' },
  },
  {
    key: 'S4',
    seq: 7,
    label: 'Fixes and questions',
    category: 'irs_return',
    references: ['references/question-generator.md', 'references/drake-fix-guide.md'],
    consumes: [],
    applies: () => ({ applies: true }),
  },
];

export const stageDef = (key: StageKey): StageDef =>
  STAGE_DEFS.find((s) => s.key === key) ?? STAGE_DEFS[0];

/**
 * The stage plan for a run: every stage in order, each marked pending or
 * not_applicable with its reason.
 *
 * Inapplicable stages stay in the plan rather than being left out, so the
 * progress rail shows the whole sequence and the register can say why a module
 * did not run.
 */
export function planStages(ctx: StageContext): {
  stageKey: StageKey;
  seq: number;
  status: 'pending' | 'not_applicable';
  reason?: string;
}[] {
  return STAGE_DEFS.map((def) => {
    const verdict = def.applies(ctx);
    return {
      stageKey: def.key,
      seq: def.seq,
      status: verdict.applies ? ('pending' as const) : ('not_applicable' as const),
      reason: verdict.reason,
    };
  });
}

/** The reference files a stage reads, with the federal stage resolved per return type. */
export const referencesFor = (key: StageKey, returnType: ReturnType | null): string[] =>
  key === 'S3-FED' ? federalReferences(returnType) : stageDef(key).references;
