import type { DocRole, ReturnType } from '@/lib/review-types';

/**
 * The gate in front of Stage 1.
 *
 * SKILL.md is explicit that a review does not begin with a partial set and
 * assume the rest: some documents are worth proceeding without, as long as the
 * register says what could not be checked, and some make the whole exercise
 * meaningless. That distinction is the table below, transcribed rather than
 * reinterpreted.
 *
 * Blocking here is cheaper than blocking later. A run stopped at creation costs
 * nothing; the same run stopped at Stage 3 has already spent several model
 * calls to arrive at "I needed the trial balance all along".
 */

export interface InputRequirement {
  role: DocRole;
  label: string;
  /** Which stages need it, for the message shown when it is missing. */
  neededFor: string;
  /**
   * blocking — the review cannot start.
   * flag     — proceed, and the consequence goes on the register as coverage.
   */
  severity: 'blocking' | 'flag';
  /** SKILL.md's own wording for what happens without it. */
  consequence: string;
  /** When absent, blocking applies only to these return types. */
  blockingFor?: ReturnType[];
}

export const INPUT_REQUIREMENTS: InputRequirement[] = [
  {
    role: 'drake_export',
    label: 'Drake return (all forms, schedules, statements, worksheets)',
    neededFor: 'Stage 3',
    severity: 'blocking',
    consequence: 'Stop — cannot review.',
  },
  {
    role: 'trial_balance_cy',
    label: 'Trial balance at year end',
    neededFor: 'Stages 1 and 2',
    severity: 'blocking',
    consequence: 'Stop — cannot tie out.',
  },
  {
    role: 'trial_balance_py',
    label: 'Trial balance at prior year end',
    neededFor: 'Stages 1 and 2',
    severity: 'blocking',
    consequence: 'Stop — cannot tie out. The balance sheet roll needs both years.',
  },
  {
    role: 'ownership_schedule',
    label: 'Ownership schedule, K-1 percentages, related-party list',
    neededFor: 'Stage 3',
    severity: 'blocking',
    // Everywhere else this is a flag; for these returns the allocations and the
    // reportable transactions are the review.
    blockingFor: ['1065', '1120-F', '1120-DRE-5472'],
    consequence: 'Stop for 1065 and 5472 filers — cannot review allocations or reportable transactions.',
  },
  {
    role: 'gl_detail',
    label: 'General ledger detail (or a QBO/Zoho export)',
    neededFor: 'Stage 1',
    severity: 'flag',
    consequence: 'Proceed — every account not sampled is flagged.',
  },
  {
    role: 'prior_year_return',
    label: 'Prior-year return as filed',
    neededFor: 'Stages 2 and 3',
    severity: 'flag',
    consequence: 'Proceed — all rollforward checks are flagged unverified.',
  },
  {
    role: 'bank_statement',
    label: 'Bank and loan statements at year end',
    neededFor: 'Stage 1',
    severity: 'flag',
    consequence: 'Proceed — cash and debt are flagged unreconciled.',
  },
  {
    role: 'fixed_asset_register',
    label: 'Fixed asset register / depreciation schedule',
    neededFor: 'Stages 1 and 3',
    severity: 'flag',
    consequence: 'Proceed — depreciation is flagged unverified.',
  },
  {
    role: 'preparer_notes',
    label: "Preparer's notes and open-item list",
    neededFor: 'All stages',
    severity: 'flag',
    consequence: 'Proceed — the question list will be longer.',
  },
  {
    role: 'engagement_letter',
    label: 'Engagement letter / scope',
    neededFor: 'All stages',
    severity: 'flag',
    consequence: 'Proceed — scope is flagged as assumed.',
  },
];

const isBlocking = (req: InputRequirement, returnType: ReturnType | null): boolean => {
  if (req.severity !== 'blocking') return false;
  if (!req.blockingFor) return true;
  return returnType !== null && req.blockingFor.includes(returnType);
};

export interface GateResult {
  ok: boolean;
  /** Missing and blocking: the run is created as blocked_inputs and does not start. */
  missing: { role: DocRole; label: string; neededFor: string; consequence: string }[];
  /** Missing but proceedable: each becomes a coverage line on the register. */
  warnings: { role: DocRole; label: string; neededFor: string; consequence: string }[];
}

/**
 * Decides whether a run may start, given the roles the documents were assigned.
 *
 * Returns both lists either way. The warnings are as much the point as the
 * blocks: Rule 3 says a reviewer who sees a silent section cannot tell whether
 * it was checked or skipped, so what was missing has to be carried forward and
 * written down, not quietly dropped once the run is under way.
 */
export function checkInputs(returnType: ReturnType | null, present: DocRole[]): GateResult {
  const have = new Set(present);
  const missing: GateResult['missing'] = [];
  const warnings: GateResult['warnings'] = [];

  for (const req of INPUT_REQUIREMENTS) {
    if (have.has(req.role)) continue;
    const entry = {
      role: req.role,
      label: req.label,
      neededFor: req.neededFor,
      consequence: req.consequence,
    };
    if (isBlocking(req, returnType)) missing.push(entry);
    else warnings.push(entry);
  }

  return { ok: missing.length === 0, missing, warnings };
}

/**
 * A first guess at what a document is, from its filename.
 *
 * Only a starting point for the person filling in the wizard — the role is
 * confirmed in the UI before a run is created, because getting it wrong sends
 * a bank statement to the tie-out step and produces confident nonsense. Ordered
 * most specific first: "prior year trial balance" must not match the
 * current-year pattern on its way past.
 */
const ROLE_PATTERNS: { role: DocRole; pattern: RegExp }[] = [
  { role: 'trial_balance_py', pattern: /\b(prior|previous|py|last)\b[\s\S]{0,12}\b(tb|trial[\s_-]?balance)\b|\b(tb|trial[\s_-]?balance)\b[\s\S]{0,12}\b(prior|py|\d{4})\b(?=.*prior)/i },
  { role: 'trial_balance_cy', pattern: /\b(tb|trial[\s_-]?balance)\b/i },
  { role: 'prior_year_return', pattern: /\b(prior|py|last)[\s_-]?year\b[\s\S]{0,12}\breturn\b|\b\d{4}[\s_-]?(1065|1120|1040)\b(?=.*prior)/i },
  { role: 'drake_export', pattern: /\b(drake|proconnect|return|1065|1120s?|1120[\s_-]?f|1040(nr)?|f?1065)\b/i },
  { role: 'gl_detail', pattern: /\b(gl|general[\s_-]?ledger|ledger|transaction[\s_-]?detail)\b/i },
  { role: 'bank_statement', pattern: /\b(bank|loan|statement|reconciliation|rec)\b/i },
  { role: 'fixed_asset_register', pattern: /\b(fixed[\s_-]?asset|fa[\s_-]?register|depreciation|depr)\b/i },
  { role: 'ownership_schedule', pattern: /\b(ownership|k-?1|member|partner|shareholder|related[\s_-]?part)/i },
  { role: 'preparer_notes', pattern: /\b(notes?|open[\s_-]?items?|queries)\b/i },
  { role: 'engagement_letter', pattern: /\b(engagement|scope|letter)\b/i },
];

export function inferDocRole(filename: string): DocRole {
  const name = filename.replace(/\.[a-z0-9]+$/i, '');
  // Prior-year forms are checked explicitly first: a filename carrying both
  // "2024" and "trial balance" should not be read as the current year.
  if (/\b(prior|previous|py)\b/i.test(name) && /\b(tb|trial[\s_-]?balance)\b/i.test(name)) {
    return 'trial_balance_py';
  }
  if (/\b(prior|previous|py)\b/i.test(name) && /\breturn\b/i.test(name)) {
    return 'prior_year_return';
  }
  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(name)) return role;
  }
  return 'other';
}
