import { currentUser, unauthorized, badRequest, notFound } from '@/lib/auth';
import { one, run } from '@/lib/db';

const ALLOWED = ['open', 'accepted', 'dismissed', 'resolved'];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { status } = await req.json().catch(() => ({}));
  if (!ALLOWED.includes(status)) return badRequest('Bad status');

  const { id } = await ctx.params;

  // Ownership joined through the review, so a reviewer cannot triage someone
  // else's findings by guessing an id.
  const row = one<{ id: string }>(
    `SELECT f.id FROM findings f
     JOIN reviews r ON r.id = f.review_id
     WHERE f.id = ? AND (r.user_id = ? OR ? = 'admin')`,
    id,
    user.id,
    user.role,
  );
  if (!row) return notFound();

  run(`UPDATE findings SET status = ? WHERE id = ?`, status, id);
  return Response.json({ ok: true });
}
