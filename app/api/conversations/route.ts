import crypto from 'node:crypto';
import { currentUser, unauthorized } from '@/lib/auth';
import { all, run } from '@/lib/db';
import { getProject } from '@/lib/prefs';

interface Listed {
  id: string;
  title: string;
  updated_at: number;
  starred: number;
  archived_at: number | null;
  project_id: string | null;
}

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const params = new URL(req.url).searchParams;
  const archived = params.get('archived') === '1';
  const projectId = params.get('projectId');

  // Archived chats are hidden rather than deleted, so the default list has to
  // exclude them and the archive view has to be the only place they appear.
  const rows = projectId
    ? await all<Listed>(
        `SELECT id, title, updated_at, starred, archived_at, project_id
           FROM conversations
          WHERE user_id = ? AND project_id = ? AND archived_at IS NULL
          ORDER BY starred DESC, updated_at DESC LIMIT 200`,
        user.id,
        projectId,
      )
    : await all<Listed>(
        `SELECT id, title, updated_at, starred, archived_at, project_id
           FROM conversations
          WHERE user_id = ?
            AND (archived_at IS ${archived ? 'NOT NULL' : 'NULL'})
          ORDER BY starred DESC, updated_at DESC LIMIT 200`,
        user.id,
      );

  return Response.json(rows);
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const wanted = typeof body.projectId === 'string' ? body.projectId : null;
  // A project id from the client is only honoured if it is genuinely theirs.
  const projectId = wanted && (await getProject(user.id, wanted)) ? wanted : null;

  const id = crypto.randomUUID();
  const now = Date.now();
  await run(
    `INSERT INTO conversations (id, user_id, title, created_at, updated_at, project_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    user.id,
    'New chat',
    now,
    now,
    projectId,
  );
  return Response.json({ id, title: 'New chat', project_id: projectId });
}
