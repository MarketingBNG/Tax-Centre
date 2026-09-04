import {
  CATEGORIES,
  CATEGORY_LABELS,
  OPEN_STATUSES,
  type Category,
  type FindingStatus,
  type Severity,
} from '@/lib/review-types';
import { severityRank } from './severity';

/**
 * The counts the summary page shows, computed once on the server.
 *
 * The summary, the print view and the engagement list all read these rather
 * than each counting the register themselves. Counting in three places is how
 * two parts of the same page end up disagreeing about how many items are open,
 * and a partner who sees "3 open" beside a list of four stops trusting either.
 */

export interface DerivableFinding {
  id: string;
  code: string;
  category: Category;
  severity: Severity | null;
  status: FindingStatus;
}

export interface CategoryCount {
  open: number;
  worst: Severity | null;
  label: string;
}

export interface DerivedSummary {
  categories: Record<string, CategoryCount>;
  topFindingIds: string[];
  openCriticalHigh: number;
  escalated: number;
}

export const isOpenStatus = (status: FindingStatus): boolean =>
  OPEN_STATUSES.includes(status);

/** Worse of the two, where null means "nothing yet". */
const worseOf = (a: Severity | null, b: Severity | null): Severity | null =>
  severityRank(a) <= severityRank(b) ? a : b;

export function deriveSummary(findings: DerivableFinding[]): DerivedSummary {
  const categories: Record<string, CategoryCount> = {};
  for (const category of CATEGORIES) {
    categories[category] = { open: 0, worst: null, label: CATEGORY_LABELS[category] };
  }

  /**
   * The sixth row. It is a filter over severity, not a category — a Critical
   * bookkeeping finding is counted in Bookkeeping and here, which is why these
   * rows deliberately do not sum to the register total. Storing it as a tag
   * would let the two answers drift apart.
   */
  categories.high_flag = { open: 0, worst: null, label: 'High-flag issues' };

  for (const finding of findings) {
    if (!isOpenStatus(finding.status)) continue;

    const bucket = categories[finding.category];
    if (bucket) {
      bucket.open += 1;
      bucket.worst = worseOf(finding.severity, bucket.worst);
    }

    if (finding.severity === 'Critical' || finding.severity === 'High') {
      categories.high_flag.open += 1;
      categories.high_flag.worst = worseOf(finding.severity, categories.high_flag.worst);
    }
  }

  // Worst first, then by code so the order is stable between reloads — a top
  // five that reshuffles on refresh is a top five nobody trusts.
  const openRanked = findings
    .filter((f) => isOpenStatus(f.status) && f.severity)
    .sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code),
    );

  return {
    categories,
    topFindingIds: openRanked.slice(0, 5).map((f) => f.id),
    openCriticalHigh: openRanked.filter(
      (f) => f.severity === 'Critical' || f.severity === 'High',
    ).length,
    escalated: findings.filter((f) => f.status === 'escalated').length,
  };
}
