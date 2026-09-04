import { currentUser, unauthorized, notFound, badRequest } from '@/lib/auth';
import { confirmAmount, getFinding, getRun, registerVersion } from '@/lib/review-engine/store';
import { resettleVerdict } from '@/lib/review-engine/orchestrator';

type Ctx = { params: Promise<{ id: string; findingId: string }> };

/**
 * Confirms a figure the platform could not verify.
 *
 * Figures read off a page image cannot be checked by anything here — that is
 * what the structured-export parser would fix. Until then a serious finding
 * resting on one is escalated rather than relied on, and this is how a person
 * takes responsibility for it: they look at the page and say so, by name.
 *
 * The figure keeps its source_kind. It was still read visually, and the record
 * should say so; what changes is that somebody is now accountable for it.
 */
export async function POST(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id, findingId } = await ctx.params;
  const run = await getRun(id);
  if (!run) return notFound();

  const finding = await getFinding(findingId);
  if (!finding || finding.run_id !== id) return notFound();

  const body = await req.json().catch(() => ({}));
  const label = String(body.label ?? '').trim();
  if (!label) return badRequest('Which figure? Send the amount label.');

  const updated = await confirmAmount(user.id, findingId, label);
  if (!updated) return badRequest('That figure is not on this finding, or is not awaiting confirmation.');

  const verdict = await resettleVerdict(id);

  return Response.json({
    ok: true,
    finding: {
      id: updated.id,
      code: updated.finding_code,
      status: updated.status,
      statusNote: updated.status_note,
      amounts: JSON.parse(updated.amounts_json || '[]'),
    },
    verdict,
    registerVersion: await registerVersion(id),
  });
}
