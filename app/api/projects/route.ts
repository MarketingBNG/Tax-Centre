import { currentUser, unauthorized, badRequest } from '@/lib/auth';
import { all } from '@/lib/db';
import { createProject, listProjects } from '@/lib/prefs';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const projects = await listProjects(user.id);

  // One query for all the counts rather than two per project: a person with
  // thirty projects should not cost sixty round trips to render a sidebar.
  const counts = await all<{ project_id: string; chats: string; docs: string }>(
    `SELECT p.id AS project_id,
            (SELECT COUNT(*) FROM conversations c
              WHERE c.project_id = p.id AND c.archived_at IS NULL) AS chats,
            (SELECT COUNT(*) FROM files f
              WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS docs
       FROM projects p WHERE p.user_id = ?`,
    user.id,
  );
  const byId = new Map(counts.map((c) => [c.project_id, c]));

  return Response.json(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      instructions: p.instructions,
      updatedAt: p.updated_at,
      chatCount: Number(byId.get(p.id)?.chats ?? 0),
      docCount: Number(byId.get(p.id)?.docs ?? 0),
    })),
  );
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  if (!name) return badRequest('A project needs a name');

  const project = await createProject(user.id, name);
  return Response.json({ id: project.id, name: project.name, instructions: '' });
}
