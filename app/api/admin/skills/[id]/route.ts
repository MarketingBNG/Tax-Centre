import { currentUser, unauthorized, forbidden, notFound, audit } from '@/lib/auth';
import { getSkill, updateSkill, deleteSkill } from '@/lib/skills';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await ctx.params;
  const patch = await req.json().catch(() => ({}));

  const updated = await updateSkill(id, patch);
  if (!updated) return notFound();

  await audit(user.id, 'skill.update', 'skill', id, { version: updated.version });
  return Response.json(updated);
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await ctx.params;
  const skill = await getSkill(id);
  if (!skill) return notFound();

  await deleteSkill(id);
  await audit(user.id, 'skill.delete', 'skill', id, { title: skill.title });
  return Response.json({ ok: true });
}
