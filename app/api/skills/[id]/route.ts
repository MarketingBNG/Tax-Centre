import { currentUser, unauthorized, forbidden, notFound, audit } from '@/lib/auth';
import { deleteSkill, getSkill, setSkillEnabled, skillFile, skillFiles } from '@/lib/skills';

type Ctx = { params: Promise<{ id: string }> };

/** A firm skill is everybody's; only an admin may change or remove one. */
const mayEdit = (scope: string, role: string) => scope === 'personal' || role === 'admin';

export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const skill = await getSkill(id, user.id);
  if (!skill) return notFound();

  // ?path=references/... returns one file, for the preview in the admin screen.
  const wanted = new URL(req.url).searchParams.get('path');
  if (wanted) {
    const file = await skillFile(id, wanted);
    if (!file) return notFound();
    return Response.json({ path: file.path, content: file.content });
  }

  return Response.json({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    scope: skill.scope,
    enabled: skill.enabled === 1,
    files: (await skillFiles(id)).map((f) => ({ path: f.path, bytes: Number(f.bytes) })),
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const skill = await getSkill(id, user.id);
  if (!skill) return notFound();
  if (!mayEdit(skill.scope, user.role)) return forbidden();

  const body = await req.json().catch(() => ({}));
  if (body.enabled !== undefined) {
    await setSkillEnabled(id, Boolean(body.enabled));
    await audit(user.id, 'skill.enabled', 'skill', id, {
      name: skill.name,
      enabled: Boolean(body.enabled),
    });
  }

  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const skill = await getSkill(id, user.id);
  if (!skill) return notFound();
  if (!mayEdit(skill.scope, user.role)) return forbidden();

  await deleteSkill(id);
  await audit(user.id, 'skill.delete', 'skill', id, { name: skill.name, scope: skill.scope });
  return Response.json({ ok: true });
}
