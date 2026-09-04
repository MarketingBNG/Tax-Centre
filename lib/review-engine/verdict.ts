import { OPEN_STATUSES, type FindingStatus, type Owner, type Severity, type StageKey, type Verdict } from '@/lib/review-types';
import type { Obligation } from './obligations';
import { missingForms } from './obligations';

/**
 * The verdict, computed from the register.
 *
 * The model never writes this. It is arithmetic over findings the model
 * supplied, and the moment it becomes a judgement call it stops being
 * consistent — which defeats the purpose of a verdict a partner can act on
 * without reading the detail.
 *
 * Recomputed after every status change, not just at the end of a run: closing
 * the last open Critical should move the banner immediately, and an approval
 * that was valid a moment ago should stop being valid the moment a finding
 * reopens.
 *
 * Rules 3, 4 and 4a from the output schema live here.
 */

export interface VerdictFinding {
  id: string;
  code: string;
  stageKey: StageKey;
  severity: Severity | null;
  status: FindingStatus;
  owner: Owner | null;
  /** Set where the finding rests on authority nobody verified. */
  authorityStatus?: string;
  title?: string;
}

export interface VerdictInput {
  findings: VerdictFinding[];
  requiredForms: Obligation[];
  presentForms: string[];
  facts: Record<string, unknown>;
  /** Tie-outs that failed — unreconciled cash or equity forces a Hold. */
  failedTieOuts?: { name: string; findingId: string | null }[];
}

export interface VerdictResult {
  result: Verdict;
  criticalOpen: number;
  highOpen: number;
  /** Medium items released under a condition, each needing an owner. */
  conditions: { findingId: string; code: string; owner: Owner | null }[];
  /** Positions taken on unverified authority, registered rather than hidden. */
  positionsToRegister: { findingId: string; code: string; title: string }[];
  /** Why it is not Clear, in the order a reader should address them. */
  blockers: string[];
}

const isOpen = (status: FindingStatus): boolean => OPEN_STATUSES.includes(status);

export function computeVerdict(input: VerdictInput): VerdictResult {
  const { findings, facts } = input;
  const open = findings.filter((f) => isOpen(f.status));

  const criticalOpen = open.filter((f) => f.severity === 'Critical').length;
  const highOpen = open.filter((f) => f.severity === 'High').length;
  const openMediums = open.filter((f) => f.severity === 'Medium');

  const blockers: string[] = [];

  if (criticalOpen) {
    blockers.push(
      `${criticalOpen} Critical ${criticalOpen === 1 ? 'item is' : 'items are'} open — the return cannot be filed as prepared.`,
    );
  }
  if (highOpen) {
    blockers.push(
      `${highOpen} High ${highOpen === 1 ? 'item is' : 'items are'} open and awaiting an answer.`,
    );
  }

  // Rule 4 — a required form that is not in the return is a Hold regardless of
  // how clean everything else is. Recomputed from facts every run, so a
  // determination is never carried forward untested.
  const absent = missingForms(input.requiredForms, input.presentForms);
  for (const form of absent) {
    blockers.push(`${form.form} is required but not present — ${form.because}`);
  }

  // Unreconciled cash or equity. SKILL.md lists this alongside a missing form
  // as a Hold in its own right: the balance sheet has to roll.
  const failed = input.failedTieOuts ?? [];
  for (const tie of failed) {
    blockers.push(`Tie-out failed: ${tie.name}`);
  }

  // Rule 4a — where there is an Indian link, the register must actually contain
  // an India-side line. A US verdict cannot close an open India item, and
  // silence about it is not the same as having checked.
  const indiaLink = facts.india_link === true;
  const hasIndiaLine = findings.some((f) => f.stageKey === 'S3-INDIA');
  if (indiaLink && !hasIndiaLine) {
    blockers.push(
      'This engagement has an Indian link but the register carries no India-symmetry line. ' +
        'The India module must run and record at least one entry, even if that entry is "agreed".',
    );
  }

  // Rule 3 — Clear needs no open Critical or High, and every remaining Medium
  // owned by somebody. An unowned Medium is a condition nobody has agreed to.
  const unownedMediums = openMediums.filter((f) => !f.owner);
  if (unownedMediums.length) {
    blockers.push(
      `${unownedMediums.length} Medium ${unownedMediums.length === 1 ? 'item has' : 'items have'} no owner — ` +
        'a condition needs somebody to carry it.',
    );
  }

  const holdReasons =
    criticalOpen > 0 || absent.length > 0 || failed.length > 0 || (indiaLink && !hasIndiaLine);

  const result: Verdict = holdReasons
    ? 'hold'
    : highOpen > 0 || unownedMediums.length > 0
      ? 'release_with_conditions'
      : 'clear';

  return {
    result,
    criticalOpen,
    highOpen,
    conditions: openMediums.map((f) => ({ findingId: f.id, code: f.code, owner: f.owner })),
    positionsToRegister: findings
      .filter((f) => f.authorityStatus === 'verify')
      .map((f) => ({ findingId: f.id, code: f.code, title: f.title ?? '' })),
    blockers,
  };
}

/**
 * Whether a human is allowed to sign this off as Clear.
 *
 * Separate from computeVerdict because they answer different questions: the
 * verdict is what the register says, this is what a person may do about it.
 * An AI verdict is a first pass — the approval is the sign-off — but the
 * platform still refuses an approval the register contradicts.
 */
export function canApprove(verdict: VerdictResult, asResult: Verdict): { ok: boolean; reason?: string } {
  if (asResult === 'hold') {
    return { ok: false, reason: 'Hold is the default state of an unapproved register; there is nothing to approve.' };
  }
  if (verdict.result === 'hold') {
    return {
      ok: false,
      reason: `The register is on Hold: ${verdict.blockers[0] ?? 'open Critical items remain.'}`,
    };
  }
  if (asResult === 'clear' && verdict.result !== 'clear') {
    return {
      ok: false,
      reason: `The register does not read Clear: ${verdict.blockers[0] ?? 'conditions remain open.'}`,
    };
  }
  return { ok: true };
}
