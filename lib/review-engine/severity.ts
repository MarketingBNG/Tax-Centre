import type { Category, DefectKind, FindingKind, Severity, StageKey } from '@/lib/review-types';
import { stageDef } from './stage-defs';

/**
 * How bad a finding is, decided in code.
 *
 * The model says what kind of defect it found; this decides what that means.
 * The split matters because consistency across reviewers and across a season is
 * the thing a firm is actually selling — two people reviewing two returns in
 * March and September should grade the same fact the same way, and a model
 * asked to judge severity in prose will not do that reliably.
 *
 * The tree is the guidance document's Figure 2, asked of every finding in every
 * module, in the same order:
 *
 *   1. Would this be filed wrong as it stands?          -> Critical
 *   2. Is a position unsupported, or a tie-out          -> High
 *      broken for a reason nobody knows?
 *   3. Is the figure right but the evidence missing?    -> Medium
 *   4. Is it only presentation?                         -> Low
 *
 * There is no fifth branch. A defect kind that does not map is a bug in the
 * vocabulary, not licence to guess — see `classify`.
 */

const TREE: Record<DefectKind, Severity> = {
  // 1 — would be filed wrong as it stands.
  wrong_amount: 'Critical',
  wrong_classification: 'Critical',
  missing_form: 'Critical',
  wrong_entity_type: 'Critical',

  // 2 — unsupported, or unexplained.
  unsupported_position: 'High',
  unexplained_tieout_failure: 'High',

  // 3 — right figure, missing workpaper. Survives the return; would not survive
  // an IRS query.
  missing_evidence: 'Medium',

  // 4 — wording, rounding, naming.
  presentation: 'Low',
};

export interface ClassifyInput {
  kind: FindingKind;
  defectKind: DefectKind | null;
}

/**
 * The severity for a finding, or null where the concept does not apply.
 *
 * An "agreed, no exception" line and a coverage note are register entries
 * rather than problems, so they carry no severity — that is what keeps a clean
 * section visible without inflating the counts a partner reads off the banner.
 */
export function classify({ kind, defectKind }: ClassifyInput): Severity | null {
  if (kind !== 'exception') return null;
  if (!defectKind) {
    // An exception with no defect kind is a finding the model could not
    // characterise. Treated as High rather than dropped or guessed downward:
    // something is wrong and nobody has said what.
    return 'High';
  }
  return TREE[defectKind] ?? 'High';
}

/** Sort key: Critical first. Used for the top-5 and for question ranking. */
export const severityRank = (severity: Severity | null): number =>
  severity === 'Critical' ? 0 : severity === 'High' ? 1 : severity === 'Medium' ? 2 : severity === 'Low' ? 3 : 4;

/**
 * Which of the five stored tags a finding carries.
 *
 * Derived from the stage that produced it, so the summary can group findings
 * without a second pass over them. The sixth row on the summary page —
 * "high-flag" — is not here on purpose: it is a filter over severity, and
 * giving it a tag of its own would let two answers to the same question drift
 * apart.
 *
 * A stage may override for a specific finding — the transfer-pricing checks
 * live inside the India module but belong in their own category, because the
 * team routes that work to a different specialist.
 */
export function categoryFor(stageKey: StageKey, override?: Category | null): Category {
  return override ?? stageDef(stageKey).category;
}

/**
 * Whether a finding blocks the whole run rather than just the verdict.
 *
 * Only Stage 0 does. A wrong entity type or a return type that does not match
 * the engagement makes every later stage meaningless — reviewing the balance
 * sheet of a return that should not exist wastes the run and produces findings
 * nobody can act on. Criticals found later set the verdict to Hold but the
 * sequence still completes, because Rule 3 wants the whole register even when
 * the answer is already "do not file".
 */
export const haltsRun = (stageKey: StageKey, severity: Severity | null): boolean =>
  stageKey === 'S0' && severity === 'Critical';
