import { currentUser, unauthorized, notFound, audit } from '@/lib/auth';
import { one, all, run } from '@/lib/db';
import { getReviewBundle } from '@/lib/review';
import type { ConversationRow, MessageRow, FileRow } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

// Ownership lives in the SQL predicate, and a miss returns 404 rather than 403
// so ids cannot be probed for existence.
function owned(id: string, userId: string) {
  return one<ConversationRow>(
    `SELECT * FROM conversations WHERE id = ? AND user_id = ?`,
    id,
    userId,
  );
}

export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const conversation = await owned(id, user.id);
  if (!conversation) return notFound();

  const messages = await all<MessageRow>(
    `SELECT id, role, content, review_id, created_at FROM messages
     WHERE conversation_id = ? ORDER BY created_at`,
    id,
  );
  // The files reviews in this conversation actually read — see the note in
  // lib/review.ts runFollowUp for why files.conversation_id is not the source
  // of truth here.
  const files = await all<FileRow>(
    `SELECT f.id, f.filename, f.kind, f.size_bytes, f.page_count, f.pii_counts
     FROM files f
     JOIN review_files rf ON rf.file_id = f.id
     JOIN reviews r ON r.id = rf.review_id
     WHERE r.conversation_id = ? AND f.deleted_at IS NULL
     GROUP BY f.id
     ORDER BY MIN(r.created_at), MIN(rf.document_index)`,
    id,
  );

  const reviews: Record<string, unknown> = {};
  for (const m of messages) {
    if (!m.review_id) continue;
    const bundle = await getReviewBundle(m.review_id, user.id, user.role === 'admin');
    if (bundle) reviews[m.review_id] = bundle;
  }

  // A review still in flight has no assistant message yet, so the client needs
  // to be told about it explicitly in order to reattach to its stream.
  const running = await one<{ id: string }>(
    `SELECT id FROM reviews WHERE conversation_id = ? AND status = 'running'
     ORDER BY created_at DESC LIMIT 1`,
    id,
  );

  return Response.json({
    conversation,
    messages,
    files,
    reviews,
    runningReviewId: running?.id ?? null,
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await owned(id, user.id))) return notFound();

  const { title } = await req.json().catch(() => ({}));
  const trimmed = String(title ?? '').trim().slice(0, 120);
  if (!trimmed) return Response.json({ error: 'Title cannot be empty' }, { status: 400 });

  await run(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`, trimmed, Date.now(), id);
  return Response.json({ ok: true, title: trimmed });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await owned(id, user.id))) return notFound();

  await run(`DELETE FROM conversations WHERE id = ?`, id);
  await audit(user.id, 'conversation.delete', 'conversation', id, null);
  return Response.json({ ok: true });
}
