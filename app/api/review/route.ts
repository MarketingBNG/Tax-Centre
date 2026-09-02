import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { currentUser, unauthorized, badRequest, notFound, audit } from '@/lib/auth';
import { one, run } from '@/lib/db';
import { runReview } from '@/lib/review';
import { getProvider } from '@/lib/providers';
import { appendEvent, heartbeat } from '@/lib/jobs';
import type { ConversationRow, FileRow } from '@/lib/types';

// A review can take minutes. On a serverless platform this has to stay inside
// the function's ceiling; raise it in vercel.json and on the plan, or the run
// is cut off and recorded as failed.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Starts a review and returns immediately.
 *
 * The work is handed to `waitUntil` rather than awaited: the browser gets an id
 * straight away, and the run continues after the response so closing the tab or
 * refreshing does not abandon it. Progress goes to stream_events, which
 * GET .../stream replays from a cursor.
 *
 * `waitUntil` keeps the instance alive only up to `maxDuration`. A review that
 * outruns that is marked failed by the staleness check rather than hanging as
 * 'running' forever.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { conversationId, fileIds, note } = await req.json().catch(() => ({}));

  const conversation = await one<ConversationRow>(
    `SELECT * FROM conversations WHERE id = ? AND user_id = ?`,
    conversationId,
    user.id,
  );
  if (!conversation) return notFound();

  const requested = (fileIds ?? []) as string[];
  const files: FileRow[] = [];
  for (const id of requested) {
    const file = await one<FileRow>(
      `SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      id,
      user.id,
    );
    if (file) files.push(file);
  }

  if (!files.length) return badRequest('Attach at least one readable file.');

  const reviewId = crypto.randomUUID();
  const names = files.map((f) => f.filename).join(', ');
  const label = `Review requested — ${names}` + (note?.trim() ? `\n\n${note.trim()}` : '');

  // The review row and the user's message are written before returning, so the
  // stream endpoint always finds something even if the client connects instantly.
  await run(
    `INSERT INTO reviews (id, conversation_id, user_id, status, model, skill_ids, heartbeat_at, created_at)
     VALUES (?, ?, ?, 'running', ?, '[]', ?, ?)`,
    reviewId,
    conversation.id,
    user.id,
    getProvider().reviewModel(),
    Date.now(),
    Date.now(),
  );
  await run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, 'user', ?, ?)`,
    crypto.randomUUID(),
    conversation.id,
    label,
    Date.now(),
  );

  let assembled = '';

  waitUntil(
    (async () => {
      try {
        await runReview({
          user,
          conversationId: conversation.id,
          files,
          note,
          reviewId,
          onEvent: async (event) => {
            if (event.type === 'text') assembled += event.delta;
            await appendEvent(reviewId, event);
          },
        });

        await run(
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
        await run(
          `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
          title,
          Date.now(),
          conversation.id,
        );
        await audit(user.id, 'review.complete', 'review', reviewId, { files: files.length });
      } catch {
        // runReview has already recorded the outcome and emitted the event.
        // Whatever prose arrived is still worth keeping.
        if (assembled) {
          await run(
            `INSERT INTO messages (id, conversation_id, role, content, review_id, created_at)
             VALUES (?, ?, 'assistant', ?, ?, ?)`,
            crypto.randomUUID(),
            conversation.id,
            assembled,
            reviewId,
            Date.now(),
          ).catch(() => undefined);
        }
      } finally {
        await heartbeat(reviewId).catch(() => undefined);
      }
    })(),
  );

  return Response.json({ reviewId, conversationId: conversation.id });
}
