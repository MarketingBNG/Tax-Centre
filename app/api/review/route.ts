import crypto from 'node:crypto';
import { currentUser, unauthorized, badRequest, notFound, audit } from '@/lib/auth';
import { one, run } from '@/lib/db';
import { runReview } from '@/lib/review';
import { getProvider } from '@/lib/providers';
import { registerJob, finishJob, appendEvent } from '@/lib/jobs';
import type { ConversationRow, FileRow } from '@/lib/types';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

/**
 * Starts a review and returns immediately.
 *
 * The work is deliberately not awaited here: a review can run for minutes, and
 * tying it to this request would mean a refresh or a closed tab abandons it.
 * Progress goes to stream_events, which GET .../stream replays from a cursor.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { conversationId, fileIds, note } = await req.json().catch(() => ({}));

  const conversation = one<ConversationRow>(
    `SELECT * FROM conversations WHERE id = ? AND user_id = ?`,
    conversationId,
    user.id,
  );
  if (!conversation) return notFound();

  const files = ((fileIds ?? []) as string[])
    .map((id) =>
      one<FileRow>(
        `SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        id,
        user.id,
      ),
    )
    .filter((f): f is FileRow => Boolean(f));

  if (!files.length) return badRequest('Attach at least one readable file.');

  const reviewId = crypto.randomUUID();
  const names = files.map((f) => f.filename).join(', ');
  const label = `Review requested — ${names}` + (note?.trim() ? `\n\n${note.trim()}` : '');

  // The review row and the user's message are written before returning, so the
  // stream endpoint always finds something even if the client connects instantly.
  run(
    `INSERT INTO reviews (id, conversation_id, user_id, status, model, skill_ids, created_at)
     VALUES (?, ?, ?, 'running', ?, '[]', ?)`,
    reviewId,
    conversation.id,
    user.id,
    getProvider().reviewModel(),
    Date.now(),
  );
  run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, 'user', ?, ?)`,
    crypto.randomUUID(),
    conversation.id,
    label,
    Date.now(),
  );

  const signal = registerJob(reviewId);
  let assembled = '';

  void (async () => {
    try {
      await runReview({
        user,
        conversationId: conversation.id,
        files,
        note,
        reviewId,
        signal,
        onEvent: (event) => {
          if (event.type === 'text') assembled += event.delta;
          appendEvent(reviewId, event);
        },
      });

      run(
        `INSERT INTO messages (id, conversation_id, role, content, review_id, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?)`,
        crypto.randomUUID(),
        conversation.id,
        assembled,
        reviewId,
        Date.now(),
      );

      const title =
        conversation.title === 'New review'
          ? files[0].filename.replace(/\.[^.]+$/, '').slice(0, 60)
          : conversation.title;
      run(
        `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
        title,
        Date.now(),
        conversation.id,
      );
      audit(user.id, 'review.complete', 'review', reviewId, { files: files.length });
    } catch {
      // runReview has already recorded the outcome and emitted the event.
      // Whatever prose arrived is still worth keeping.
      if (assembled) {
        run(
          `INSERT INTO messages (id, conversation_id, role, content, review_id, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?)`,
          crypto.randomUUID(),
          conversation.id,
          assembled,
          reviewId,
          Date.now(),
        );
      }
    } finally {
      finishJob(reviewId);
    }
  })();

  return Response.json({ reviewId, conversationId: conversation.id });
}
