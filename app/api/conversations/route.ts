import crypto from 'node:crypto';
import { currentUser, unauthorized } from '@/lib/auth';
import { all, run } from '@/lib/db';
import type { ConversationRow } from '@/lib/types';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  return Response.json(
    await all<ConversationRow>(
      `SELECT id, title, created_at, updated_at FROM conversations
       WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`,
      user.id,
    ),
  );
}

export async function POST() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const id = crypto.randomUUID();
  const now = Date.now();
  await run(
    `INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    user.id,
    'New review',
    now,
    now,
  );
  return Response.json({ id, title: 'New review' });
}
