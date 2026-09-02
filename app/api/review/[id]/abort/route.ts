import { currentUser, unauthorized, notFound, audit } from '@/lib/auth';
import { one } from '@/lib/db';
import { abortJob } from '@/lib/jobs';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const owns = one<{ id: string }>(
    `SELECT id FROM reviews WHERE id = ? AND (user_id = ? OR ? = 'admin')`,
    id,
    user.id,
    user.role,
  );
  if (!owns) return notFound();

  const stopped = abortJob(id);
  if (stopped) audit(user.id, 'review.aborted', 'review', id, null);

  // Not running is not an error — the review may have finished a moment ago.
  return Response.json({ ok: true, stopped });
}
