import { currentUser, unauthorized, notFound } from '@/lib/auth';
import {
  getEngagement,
  latestReviewedRun,
  listFindings,
  priorYearEngagements,
} from '@/lib/review-engine/store';
import {
  recurrenceSummary,
  recurringFindings,
  type RecurrenceFinding,
  type YearOfFindings,
} from '@/lib/review-engine/recurrence';
import type { EngagementRow, FindingLocation, RunFindingRow } from '@/lib/review-types';

type Ctx = { params: Promise<{ id: string }> };

/** Where the problem is, in the words a preparer's screen would use. */
function place(row: RunFindingRow): string | null {
  if (!row.location_json) return null;
  let location: FindingLocation;
  try {
    location = JSON.parse(row.location_json) as FindingLocation;
  } catch {
    return null;
  }
  const parts = [
    location.gl_account,
    location.form,
    location.schedule ? `Sch ${location.schedule}` : null,
    location.line ? `line ${location.line}` : null,
  ].filter((part) => part && String(part).trim());
  return parts.length ? parts.join(' · ') : null;
}

async function yearOf(engagement: EngagementRow): Promise<YearOfFindings | null> {
  if (engagement.tax_year === null) return null;
  const run = await latestReviewedRun(engagement.id);
  if (!run) return null;

  const findings = await listFindings(run.id);
  return {
    taxYear: engagement.tax_year,
    engagementId: engagement.id,
    runId: run.id,
    runNumber: run.run_number,
    // Coverage lines say what was *not* tested. They are essential on the
    // workpaper and meaningless here: "we did not test this again" is not a
    // recurring defect.
    findings: findings
      .filter((row) => row.kind === 'exception')
      .map(
        (row): RecurrenceFinding => ({
          id: row.id,
          code: row.finding_code,
          stageKey: row.stage_key,
          category: row.category,
          severity: row.severity,
          status: row.status,
          title: row.title,
          lineageKey: row.lineage_key,
          where: place(row),
        }),
      ),
  };
}

/**
 * This year against the earlier years for the same client.
 *
 * Read-only and derived on request rather than stored: it is a reading of
 * registers that are themselves immutable, so there is nothing to keep in sync
 * and no way for a cached version to disagree with the runs it came from.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const engagement = await getEngagement(id);
  if (!engagement) return notFound();

  const priors = await priorYearEngagements(engagement);
  const years = (
    await Promise.all([engagement, ...priors].map((row) => yearOf(row)))
  ).filter((year): year is YearOfFindings => year !== null);

  const items = recurringFindings(years);

  return Response.json({
    // Every earlier engagement found, whether or not it had a review to read —
    // "we have a 2023 file but never finished reviewing it" is worth seeing,
    // and silence about it would read as "there is no 2023".
    clientKey: engagement.ein ? 'ein' : 'client_label',
    priors: priors.map((row) => ({
      id: row.id,
      taxYear: row.tax_year,
      returnType: row.return_type,
      reviewed: years.some((year) => year.engagementId === row.id),
    })),
    years: years
      .map((year) => ({
        taxYear: year.taxYear,
        engagementId: year.engagementId,
        runNumber: year.runNumber,
        exceptions: year.findings.length,
      }))
      .sort((a, b) => b.taxYear - a.taxYear),
    summary: recurrenceSummary(items, years.length),
    recurring: items,
  });
}
