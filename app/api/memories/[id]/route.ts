import { currentUser, unauthorized } from '@/lib/auth';
import { deleteMemory } from '@/lib/prefs';

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  await deleteMemory(user.id, id);
  return Response.json({ ok: true });
}
