import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { getRun, requestAbort } from '@/lib/review-engine/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Asks a run to stop.
 *
 * The request handling this is not the one running the stage, so there is no
 * in-memory signal to raise — the flag goes in the database and the run reads
 * it at the next stage boundary. Work already committed stays committed; a
 * stopped run is a partial register, not a discarded one.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await getRun(id))) return notFound();

  await requestAbort(user.id, id);
  return Response.json({ ok: true });
}
