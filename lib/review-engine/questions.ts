import type { FindingStatus, Severity } from '@/lib/review-types';
import { severityRank } from './severity';

/**
 * Selecting and closing the preparer's questions.
 *
 * The cap and the ranking are deterministic rather than left to the model,
 * because the point of a capped list is that it is genuinely the top of the
 * list. question-generator.md is explicit: one per unresolved High or Critical
 * first, then Medium, never Low, at most ten. Beyond ten the return is on hold
 * anyway and the register is the communication.
 *
 * The answer rules are here too, and they are the part worth being strict
 * about. A typed explanation with nothing attached does not close a High
 * finding — verbal explanations never have, and a platform that let one do so
 * under deadline pressure would be worse than no platform.
 */

export interface CandidateQuestion {
  findingId: string | null;
  owner: 'preparer' | 'client';
  question: string;
  figure?: string | null;
  branches?: { if: string; then: string }[];
  evidenceNeeded?: string | null;
  answerKind?: 'fact' | 'document' | 'yes_no' | 'text' | null;
}

export interface RankedFinding {
  id: string;
  severity: Severity | null;
  status: FindingStatus;
}

export const MAX_QUESTIONS = 10;
export const MIN_QUESTIONS_WHEN_SERIOUS = 5;

/**
 * Picks which questions survive.
 *
 * Ranked by the severity of the finding each one is attached to, so a cap of
 * ten drops the least consequential rather than whichever the model happened
 * to write last. Questions attached to a Low finding are dropped outright, and
 * unattached ones sort last — they are usually scope questions, which matter
 * but never more than an open Critical.
 */
export function selectQuestions(
  candidates: CandidateQuestion[],
  findings: RankedFinding[],
): { selected: CandidateQuestion[]; dropped: number; shortfall: number } {
  const byId = new Map(findings.map((f) => [f.id, f]));

  const ranked = candidates
    .map((question) => {
      const finding = question.findingId ? byId.get(question.findingId) : undefined;
      return { question, severity: finding?.severity ?? null };
    })
    // Never ask about Low — rule 1.
    .filter((entry) => entry.severity !== 'Low')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const selected = ranked.slice(0, MAX_QUESTIONS).map((entry) => entry.question);

  // Rule 6 wants at least five when something serious is open. Falling short is
  // not something code can invent its way out of — the caller reports it rather
  // than padding the list with questions nobody needs answered.
  const serious = findings.filter(
    (f) => (f.severity === 'Critical' || f.severity === 'High') && f.status !== 'closed',
  ).length;
  const shortfall =
    serious > 0 && selected.length < Math.min(MIN_QUESTIONS_WHEN_SERIOUS, serious)
      ? Math.min(MIN_QUESTIONS_WHEN_SERIOUS, serious) - selected.length
      : 0;

  return { selected, dropped: Math.max(0, ranked.length - selected.length), shortfall };
}

export interface AnswerOutcome {
  status: FindingStatus;
  note: string | null;
}

/**
 * What an answer does to the finding it was attached to.
 *
 * The distinction that matters is evidence, not eloquence. With a document
 * attached the finding moves on; without one it is recorded as answered and
 * stays counted as open, which is what "answered, evidence pending" means and
 * why the status exists as its own value rather than as a flag on `answered`.
 *
 * A Medium is the one case where words alone are enough: the figure was already
 * right and the finding was about missing workpaper support, so an explanation
 * is a legitimate resolution — logged, owned, and visible.
 */
export function outcomeOfAnswer(input: {
  severity: Severity | null;
  hasEvidence: boolean;
  /** Set when the answer itself needs a reviewer rather than closing anything. */
  needsReviewer?: boolean;
  /** Set when the answer says the fact has to come from the client. */
  awaitingClient?: boolean;
}): AnswerOutcome {
  if (input.awaitingClient) {
    return { status: 'client', note: 'Waiting on the client for this fact.' };
  }
  if (input.needsReviewer) {
    return { status: 'escalated', note: 'The answer needs a reviewer to judge, not just data entry.' };
  }

  if (input.hasEvidence) {
    return { status: 'closed', note: null };
  }

  if (input.severity === 'Medium' || input.severity === 'Low' || input.severity === null) {
    return {
      status: 'answered',
      note: 'Answered without a document. Acceptable here because the figure itself was not in doubt.',
    };
  }

  return {
    status: 'answered_pending_evidence',
    note:
      'Answered, evidence pending. A written explanation does not close a ' +
      `${input.severity} finding — attach the document that proves it.`,
  };
}
