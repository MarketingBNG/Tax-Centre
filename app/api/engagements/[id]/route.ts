import { currentUser, unauthorized, notFound, badRequest } from '@/lib/auth';
import { logClientOpen } from '@/lib/access-log';
import {
  assertFact,
  getEngagement,
  listCurrentFactRows,
  listRuns,
  updateEngagement,
} from '@/lib/review-engine/store';
import { RETURN_TYPES, normaliseEin, type ReturnType } from '@/lib/review-types';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const engagement = await getEngagement(id);
  if (!engagement) return notFound();

  const [facts, runs] = await Promise.all([listCurrentFactRows(id), listRuns(id)]);

  await logClientOpen(user.id, { engagementId: engagement.id, clientLabel: engagement.client_label });

  return Response.json({
    id: engagement.id,
    clientLabel: engagement.client_label,
    entityName: engagement.entity_name,
    ein: engagement.ein,
    returnType: engagement.return_type,
    taxYear: engagement.tax_year,
    periodStart: engagement.period_start,
    periodEnd: engagement.period_end,
    shortYear: Boolean(engagement.short_year),
    facts: facts.map((fact) => ({
      key: fact.key,
      value: safeParse(fact.value),
      source: fact.source,
      evidenceFileId: fact.evidence_file_id,
      confidence: fact.confidence,
      createdAt: fact.created_at,
    })),
    runs: runs.map((run) => ({
      id: run.id,
      runNumber: run.run_number,
      status: run.status,
      verdict: run.verdict,
      registerVersion: run.register_version,
      haltReason: run.halt_reason,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
    })),
  });
}

/**
 * Edits the engagement, asserts facts, or both.
 *
 * A fact is never updated in place — `assertFact` supersedes the old row — so
 * this stays safe to call while runs that were built on the previous values
 * still exist.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await getEngagement(id))) return notFound();

  const body = await req.json().catch(() => ({}));

  if (body.returnType !== undefined && body.returnType !== null) {
    if (!RETURN_TYPES.includes(body.returnType as ReturnType)) {
      return badRequest(`returnType must be one of: ${RETURN_TYPES.join(', ')}`);
    }
  }

  const patch: Parameters<typeof updateEngagement>[2] = {};
  if (body.clientLabel !== undefined) patch.clientLabel = String(body.clientLabel).trim();
  if (body.entityName !== undefined) patch.entityName = body.entityName ? String(body.entityName) : null;
  if (body.ein !== undefined) {
    const ein = normaliseEin(body.ein);
    if ('error' in ein) return badRequest(ein.error);
    patch.ein = ein.ein;
  }
  if (body.returnType !== undefined) patch.returnType = body.returnType as ReturnType | null;
  if (body.taxYear !== undefined) patch.taxYear = body.taxYear === null ? null : Number(body.taxYear);
  if (body.periodStart !== undefined) patch.periodStart = body.periodStart ?? null;
  if (body.periodEnd !== undefined) patch.periodEnd = body.periodEnd ?? null;
  if (body.shortYear !== undefined) patch.shortYear = Boolean(body.shortYear);

  if (Object.keys(patch).length) await updateEngagement(user.id, id, patch);

  const facts = body.facts && typeof body.facts === 'object' ? body.facts : null;
  if (facts) {
    for (const [key, value] of Object.entries(facts as Record<string, unknown>)) {
      await assertFact(user.id, id, key, value, 'user');
    }
  }

  return Response.json({ ok: true });
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
