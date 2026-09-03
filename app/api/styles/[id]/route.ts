import { currentUser, unauthorized, badRequest } from '@/lib/auth';
import { deleteStyle, updateStyle } from '@/lib/prefs';

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const instructions = String(body.instructions ?? '').trim();
  if (!name || !instructions) return badRequest('A style needs a name and instructions');

  await updateStyle(user.id, id, name, instructions);
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  await deleteStyle(user.id, id);
  return Response.json({ ok: true });
}
