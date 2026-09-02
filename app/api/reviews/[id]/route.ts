import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { getReviewBundle } from '@/lib/review';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const bundle = getReviewBundle(id, user.id, user.role === 'admin');
  return bundle ? Response.json(bundle) : notFound();
}
