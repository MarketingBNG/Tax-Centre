import type { Category, FindingStatus, Severity, StageKey } from '@/lib/review-types';

/**
 * The same client, this year against last.
 *
 * The run-to-run diff answers "did the fix work". This answers a different and
 * more uncomfortable question: is this the third year in a row we have raised
 * it? A finding that comes back every season is not an error, it is a process
 * that produces the error, and the useful conversation is with whoever keeps
 * the books rather than with whoever prepared the return.
 *
 * Matching across years reuses the same lineage key the run diff uses — where
 * the problem is and what kind it is, never the wording. That works across
 * years for the same reason it works across runs: the account and the schedule
 * line are stable while the model's phrasing is not.
 *
 * Nothing here decides anything. Recurrence is not a severity: an account
 * misclassified three years running is exactly as wrong as one misclassified
 * once, and inflating it would corrupt a grading scheme that is deliberately
 * out of the model's hands. It is context for the reviewer, and it is left as
 * context.
 */

const OPEN: FindingStatus[] = ['open', 'answered_pending_evidence', 'escalated', 'client'];
const SETTLED: FindingStatus[] = ['closed', 'changed', 'answered'];

export interface RecurrenceFinding {
  id: string;
  code: string;
  stageKey: StageKey;
  category: Category;
  severity: Severity | null;
  status: FindingStatus;
  title: string;
  lineageKey: string | null;
  /** For the reviewer's eye: the account or line, if the finding named one. */
  where: string | null;
}

export interface YearOfFindings {
  taxYear: number;
  engagementId: string;
  runId: string;
  runNumber: number;
  findings: RecurrenceFinding[];
}

export interface RecurringAppearance {
  taxYear: number;
  engagementId: string;
  runId: string;
  findingId: string;
  code: string;
  severity: Severity | null;
  status: FindingStatus;
  open: boolean;
}

export interface RecurringItem {
  lineageKey: string;
  /** The most recent year's wording, since that is the one being worked on. */
  title: string;
  stageKey: StageKey;
  category: Category;
  where: string | null;
  /** Oldest first, so the row reads as a history. */
  appearances: RecurringAppearance[];
  yearsSeen: number;
  /**
   * Raised, settled, and raised again in a later year.
   *
   * Worth separating from a finding that has simply stayed open. One says the
   * fix did not hold; the other says nobody has got to it yet. They call for
   * different conversations.
   */
  cameBack: boolean;
  /** True while it is still unsettled in the most recent year. */
  openNow: boolean;
}

/**
 * The findings that appear in more than one year, worst-recurring first.
 *
 * Years may arrive in any order; a year appearing twice for one lineage — which
 * would need two engagements for the same client and the same tax year — counts
 * once, because that is a filing quirk rather than a recurrence.
 */
export function recurringFindings(years: YearOfFindings[]): RecurringItem[] {
  const byLineage = new Map<string, { year: YearOfFindings; finding: RecurrenceFinding }[]>();

  for (const year of years) {
    for (const finding of year.findings) {
      if (!finding.lineageKey) continue;
      const bucket = byLineage.get(finding.lineageKey) ?? [];
      bucket.push({ year, finding });
      byLineage.set(finding.lineageKey, bucket);
    }
  }

  const items: RecurringItem[] = [];

  for (const [lineageKey, entries] of byLineage) {
    const seenYears = new Set<number>();
    const ordered = entries
      .slice()
      .sort((a, b) => a.year.taxYear - b.year.taxYear)
      .filter((entry) => {
        if (seenYears.has(entry.year.taxYear)) return false;
        seenYears.add(entry.year.taxYear);
        return true;
      });

    if (ordered.length < 2) continue;

    const appearances: RecurringAppearance[] = ordered.map(({ year, finding }) => ({
      taxYear: year.taxYear,
      engagementId: year.engagementId,
      runId: year.runId,
      findingId: finding.id,
      code: finding.code,
      severity: finding.severity,
      status: finding.status,
      open: OPEN.includes(finding.status),
    }));

    // Settled once, and back afterwards.
    let cameBack = false;
    for (let i = 0; i < ordered.length - 1; i += 1) {
      if (!SETTLED.includes(ordered[i].finding.status)) continue;
      if (appearances.slice(i + 1).some((later) => later.open)) {
        cameBack = true;
        break;
      }
    }

    const latest = ordered[ordered.length - 1];

    items.push({
      lineageKey,
      title: latest.finding.title,
      stageKey: latest.finding.stageKey,
      category: latest.finding.category,
      where: latest.finding.where,
      appearances,
      yearsSeen: appearances.length,
      cameBack,
      openNow: OPEN.includes(latest.finding.status),
    });
  }

  const worst = (item: RecurringItem): number => {
    const rank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    return Math.min(
      ...item.appearances.map((a) => (a.severity ? rank[a.severity] : 4)),
    );
  };

  return items.sort(
    (a, b) =>
      // Most years first — that is the whole point of the view — then how
      // serious it ever got, then whether it is still live.
      b.yearsSeen - a.yearsSeen ||
      worst(a) - worst(b) ||
      Number(b.openNow) - Number(a.openNow) ||
      a.title.localeCompare(b.title),
  );
}

/**
 * A one-line reading of the pattern, for the top of the page.
 *
 * Written rather than left to the reader because the number on its own invites
 * the wrong conclusion: three recurrences across three years is a bookkeeping
 * process to fix, not three mistakes to correct.
 */
export function recurrenceSummary(items: RecurringItem[], yearsCompared: number): string {
  if (yearsCompared < 2) {
    return 'Only one year has a finished review, so there is nothing to compare against yet.';
  }
  if (!items.length) {
    return `Nothing raised this year was raised in the ${yearsCompared - 1} earlier year${
      yearsCompared === 2 ? '' : 's'
    } reviewed. Each year's problems have been different ones.`;
  }

  const cameBack = items.filter((item) => item.cameBack).length;
  const parts = [
    `${items.length} finding${items.length === 1 ? '' : 's'} appear${
      items.length === 1 ? 's' : ''
    } in more than one year.`,
  ];
  if (cameBack) {
    parts.push(
      `${cameBack} ${cameBack === 1 ? 'was' : 'were'} settled in an earlier year and raised again ` +
        'afterwards, so the fix did not hold.',
    );
  }
  parts.push(
    'A problem that returns each season is a process producing it rather than a one-off error, ' +
      'and is worth raising with whoever keeps the books.',
  );
  return parts.join(' ');
}
