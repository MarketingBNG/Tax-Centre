import { currentUser, unauthorized, badRequest } from '@/lib/auth';
import { addMemory, clearMemories, listMemories } from '@/lib/prefs';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const rows = await listMemories(user.id, 500);
  return Response.json(
    rows.map((m) => ({
      id: m.id,
      text: m.text,
      createdAt: m.created_at,
      conversationId: m.source_conversation_id,
    })),
  );
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? '').trim();
  if (!text) return badRequest('Nothing to remember');

  const row = await addMemory(user.id, text, null);
  return Response.json({ id: row.id, text: row.text, createdAt: row.created_at });
}

/** Forget everything. Deliberately a separate verb from deleting one fact. */
export async function DELETE() {
  const user = await currentUser();
  if (!user) return unauthorized();

  await clearMemories(user.id);
  return Response.json({ ok: true });
}
