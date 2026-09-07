import { currentUser, unauthorized, badRequest } from '@/lib/auth';
import { logRosterRead } from '@/lib/access-log';
import {
  countEngagements,
  createEngagement,
  listEngagementSummaries,
  assertFact,
} from '@/lib/review-engine/store';
import { RETURN_TYPES, normaliseEin, type ReturnType } from '@/lib/review-types';

/**
 * Engagements are firm-visible.
 *
 * A preparer answers questions on a run somebody else started and a partner
 * approves one neither of them created, so scoping these to the person who
 * typed them in would break the workflow. Every action records who took it.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const LIMIT = 200;
  const [rows, total] = await Promise.all([listEngagementSummaries(LIMIT), countEngagements()]);
  await logRosterRead(user.id, total);

  // The list has always stopped at 200. Saying so is the whole change: a
  // truncated list that does not mention it is indistinguishable from a
  // complete one, and the client it dropped is indistinguishable from a client
  // that does not exist.
  return Response.json({
    total,
    shown: rows.length,
    truncated: total > rows.length,
    engagements: rows.map((row) => ({
      id: row.id,
      clientLabel: row.client_label,
      entityName: row.entity_name,
      ein: row.ein,
      returnType: row.return_type,
      taxYear: row.tax_year,
      runCount: Number(row.run_count),
      latestRun: row.run_id
        ? {
            id: row.run_id,
            runNumber: row.run_number,
            status: row.run_status,
            verdict: row.verdict,
            registerVersion: row.register_version,
            createdAt: row.run_created_at,
            openCriticalHigh: Number(row.open_high),
          }
        : null,
    })),
  });
}

const isReturnType = (value: unknown): value is ReturnType =>
  RETURN_TYPES.includes(value as ReturnType);

/** ISO date, or nothing. Anything else would reach Stage 0 as a silent null. */
const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => ({}));

  const clientLabel = String(body.clientLabel ?? '').trim();
  if (!clientLabel) return badRequest('An engagement needs a client name');

  const returnType = body.returnType ?? null;
  if (returnType !== null && !isReturnType(returnType)) {
    return badRequest(`returnType must be one of: ${RETURN_TYPES.join(', ')}`);
  }

  const taxYear = body.taxYear === undefined || body.taxYear === null ? null : Number(body.taxYear);
  if (taxYear !== null && (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100)) {
    return badRequest('taxYear must be a four-digit year');
  }

  for (const key of ['periodStart', 'periodEnd'] as const) {
    const value = body[key];
    if (value !== undefined && value !== null && !isIsoDate(String(value))) {
      return badRequest(`${key} must be an ISO date (YYYY-MM-DD)`);
    }
  }

  const ein = normaliseEin(body.ein);
  if ('error' in ein) return badRequest(ein.error);

  const engagement = await createEngagement(user.id, {
    clientLabel,
    entityName: body.entityName ? String(body.entityName).trim() : null,
    ein: ein.ein,
    returnType,
    taxYear,
    periodStart: body.periodStart ? String(body.periodStart) : null,
    periodEnd: body.periodEnd ? String(body.periodEnd) : null,
    shortYear: Boolean(body.shortYear),
  });

  // The facts that decide which stages a run will plan. Recorded as facts
  // rather than columns because Stage 0 can later contradict what was typed
  // in here, and both versions have to survive that.
  const facts = body.facts && typeof body.facts === 'object' ? body.facts : {};
  for (const [key, value] of Object.entries(facts as Record<string, unknown>)) {
    await assertFact(user.id, engagement.id, key, value, 'user');
  }

  return Response.json({ id: engagement.id }, { status: 201 });
}
