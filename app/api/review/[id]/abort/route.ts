import { currentUser, unauthorized, notFound, audit } from '@/lib/auth';
import { one } from '@/lib/db';
import { requestAbort, reviewStatus } from '@/lib/jobs';

/**
 * Asks a running review to stop.
 *
 * This request will almost never reach the instance actually running the
 * review, so it sets a flag the running job polls rather than aborting
 * anything directly. Stopping is therefore eventual — within a couple of
 * seconds — not instantaneous.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const owns = await one<{ id: string }>(
    `SELECT id FROM reviews WHERE id = ? AND (user_id = ? OR ? = 'admin')`,
    id,
    user.id,
    user.role,
  );
  if (!owns) return notFound();

  const status = await reviewStatus(id);
  const running = status === 'running';

  if (running) {
    await requestAbort(id);
    await audit(user.id, 'review.aborted', 'review', id, null);
  }

  // Not running is not an error — the review may have finished a moment ago.
  return Response.json({ ok: true, stopped: running });
}
