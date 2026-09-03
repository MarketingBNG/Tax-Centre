import { currentUser, unauthorized, notFound, audit } from '@/lib/auth';
import { all } from '@/lib/db';
import { deleteProject, getProject, updateProject } from '@/lib/prefs';
import { projectFiles } from '@/lib/chat';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const project = await getProject(user.id, id);
  if (!project) return notFound();

  const [files, conversations] = await Promise.all([
    projectFiles(id),
    all<{ id: string; title: string; updated_at: number }>(
      `SELECT id, title, updated_at FROM conversations
        WHERE project_id = ? AND user_id = ? AND archived_at IS NULL
        ORDER BY updated_at DESC LIMIT 200`,
      id,
      user.id,
    ),
  ]);

  return Response.json({
    id: project.id,
    name: project.name,
    instructions: project.instructions,
    files: files.map((f) => ({
      id: f.id,
      filename: f.filename,
      kind: f.kind,
      sizeBytes: f.size_bytes,
      pageCount: f.page_count,
    })),
    conversations,
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await getProject(user.id, id))) return notFound();

  const body = await req.json().catch(() => ({}));
  await updateProject(user.id, id, {
    name: body.name === undefined ? undefined : String(body.name),
    instructions: body.instructions === undefined ? undefined : String(body.instructions),
  });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await getProject(user.id, id))) return notFound();

  await deleteProject(user.id, id);
  await audit(user.id, 'project.delete', 'project', id, null);
  return Response.json({ ok: true });
}
