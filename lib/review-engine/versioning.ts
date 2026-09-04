import crypto from 'node:crypto';
import type { DefectKind, FindingLocation, FindingStatus, Severity, StageKey } from '@/lib/review-types';
import { STAGE_KEYS } from '@/lib/review-types';

/**
 * Re-running, and comparing one run against the last.
 *
 * A run is never edited: a correction is a new run. That is what makes the
 * comparison mean something — "six closed, one new, verdict moved from Hold to
 * Release with conditions" is a fact about two immutable registers rather than
 * a reconstruction from an edit history.
 *
 * The question the team actually asks is "did the fix work", and answering it
 * needs findings to be recognisable across runs even though their codes are
 * assigned per run. That is what the lineage key is for.
 */

/**
 * A stable-ish identity for the same underlying problem across runs.
 *
 * Built from where the problem is and what kind it is — deliberately not from
 * the title, because the model will word the same finding differently on a
 * second pass and that must not read as "the old one closed, a new one
 * appeared". Where there is no location to key on, a normalised title is the
 * fallback; imperfect, but better than treating every such finding as new.
 */
export function lineageKey(input: {
  stageKey: StageKey;
  defectKind: DefectKind | null;
  location: FindingLocation | null;
  title: string;
}): string {
  const where = input.location
    ? [input.location.form, input.location.schedule, input.location.line, input.location.gl_account]
        .map((part) => (part ?? '').trim().toLowerCase())
        .join('|')
    : '';

  const basis = where.replace(/\|+/g, '')
    ? `${input.stageKey}|${input.defectKind ?? ''}|${where}`
    : // No location: fall back to the shape of the title, with figures and
      // punctuation stripped so "$42,180" changing does not look like a new
      // finding.
      `${input.stageKey}|${input.defectKind ?? ''}|${input.title
        .toLowerCase()
        .replace(/[\d.,$()]/g, '')
        .replace(/\s+/g, ' ')
        .trim()}`;

  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------ invalidation */

/**
 * Which stages have to run again, given what changed.
 *
 * Per stage rather than per check, and that is a real decision. The checks
 * inside a stage share one model context on purpose — Stage 1's checks all read
 * the same trial balance, and splitting them would multiply the cost several
 * times over while losing the cross-checks that come from seeing the whole
 * thing at once. The stage is the unit the model is invoked on, so it is the
 * honest unit of re-running.
 *
 * The cascade follows the skill's own reasoning: books drive the return, so a
 * corrected book figure invalidates everything downstream of it. Stage 4 always
 * re-runs, because the questions and the verdict are derived from whatever the
 * register now says.
 */
export function stagesToRerun(input: {
  /** Stages whose findings were answered, or whose documents changed. */
  touched: StageKey[];
  /** True when a document was added or replaced outright. */
  documentsChanged?: boolean;
}): StageKey[] {
  const affected = new Set<StageKey>();
  const all = STAGE_KEYS as readonly StageKey[];

  const everythingFrom = (from: StageKey) => {
    const start = all.indexOf(from);
    for (const key of all.slice(start)) affected.add(key);
  };

  if (input.documentsChanged) {
    // New inputs mean the whole sequence saw the wrong world.
    everythingFrom('S0');
    return all.filter((key) => affected.has(key));
  }

  for (const stage of input.touched) {
    if (stage === 'S0') {
      // Identity was wrong; nothing after it was reviewing the right thing.
      everythingFrom('S0');
    } else if (stage === 'S1') {
      // Books drive the return — the skill's own rule, and the reason Stage 1
      // runs first at all.
      everythingFrom('S1');
    } else if (stage === 'S2') {
      affected.add('S2');
    } else {
      // A Stage 3 module answers for itself; the others are unaffected.
      affected.add(stage);
    }
  }

  // Questions and the verdict are derived, so they are never carried forward.
  if (affected.size) affected.add('S4');

  return all.filter((key) => affected.has(key));
}

/* -------------------------------------------------------------------- diff */

export interface DiffFinding {
  id: string;
  code: string;
  stageKey: StageKey;
  severity: Severity | null;
  status: FindingStatus;
  title: string;
  lineageKey: string | null;
  carriedFromFindingId: string | null;
}

export interface RunDiff {
  closed: DiffFinding[];
  opened: DiffFinding[];
  unchanged: DiffFinding[];
  /** Same problem, different severity or status. */
  changed: { before: DiffFinding; after: DiffFinding }[];
  questionsAnswered: number;
  /** Asked in the earlier run and still unanswered in the later one. */
  questionsIgnored: number;
}

const OPEN: FindingStatus[] = ['open', 'answered_pending_evidence', 'escalated', 'client'];

/**
 * What moved between two runs.
 *
 * Matched by explicit lineage first — a carried-forward finding knows which one
 * it descends from — and by lineage key second, for findings the later run
 * genuinely re-derived.
 *
 * "Closed" here means the problem is absent or settled in the later run, which
 * is the only thing that answers "did the fix work". A finding whose number
 * merely changed is reported as changed, not closed: the check still fails.
 */
export function diffRuns(input: {
  before: DiffFinding[];
  after: DiffFinding[];
  questions: { before: number; answeredInBefore: number; stillOpenInAfter: number };
}): RunDiff {
  const { before, after } = input;

  const byLineage = new Map<string, DiffFinding>();
  const byId = new Map<string, DiffFinding>();
  for (const finding of before) {
    byId.set(finding.id, finding);
    if (finding.lineageKey) byLineage.set(finding.lineageKey, finding);
  }

  const matchedBefore = new Set<string>();
  const opened: DiffFinding[] = [];
  const unchanged: DiffFinding[] = [];
  const changed: { before: DiffFinding; after: DiffFinding }[] = [];

  for (const finding of after) {
    const prior =
      (finding.carriedFromFindingId ? byId.get(finding.carriedFromFindingId) : undefined) ??
      (finding.lineageKey ? byLineage.get(finding.lineageKey) : undefined);

    if (!prior) {
      opened.push(finding);
      continue;
    }
    matchedBefore.add(prior.id);

    if (prior.severity === finding.severity && prior.status === finding.status) {
      unchanged.push(finding);
    } else {
      changed.push({ before: prior, after: finding });
    }
  }

  // Anything open before that the later run does not carry at all is closed:
  // the check no longer fails.
  const closed = before.filter(
    (finding) => !matchedBefore.has(finding.id) && OPEN.includes(finding.status),
  );

  return {
    closed,
    opened,
    unchanged,
    changed,
    questionsAnswered: input.questions.answeredInBefore,
    // Asked, and still not answered by the time the next run was built. This is
    // the check that stops a return being re-run and re-cleared without the
    // fact somebody asked for ever arriving.
    questionsIgnored: input.questions.stillOpenInAfter,
  };
}
