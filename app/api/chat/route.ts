import crypto from 'node:crypto';
import { currentUser, unauthorized, badRequest, notFound } from '@/lib/auth';
import { one, run } from '@/lib/db';
import { runFollowUp } from '@/lib/review';
import type { ConversationRow, StreamEvent } from '@/lib/types';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { conversationId, question } = await req.json().catch(() => ({}));
  if (!question?.trim()) return badRequest('Empty question');

  const conversation = one<ConversationRow>(
    `SELECT * FROM conversations WHERE id = ? AND user_id = ?`,
    conversationId,
    user.id,
  );
  if (!conversation) return notFound();

  run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, 'user', ?, ?)`,
    crypto.randomUUID(),
    conversation.id,
    question.trim(),
    Date.now(),
  );

  const encoder = new TextEncoder();
  let assembled = '';

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          // Client disconnected; the answer still persists below.
        }
      };

      try {
        await runFollowUp({
          user,
          conversationId: conversation.id,
          question: question.trim(),
          // Closing the browser's fetch aborts this request, which stops the
          // model call rather than letting it run on and bill.
          signal: req.signal,
          onEvent: (event) => {
            if (event.type === 'text') assembled += event.delta;
            emit(event);
          },
        });
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message });
      } finally {
        if (assembled) {
          run(
            `INSERT INTO messages (id, conversation_id, role, content, created_at)
             VALUES (?, ?, 'assistant', ?, ?)`,
            crypto.randomUUID(),
            conversation.id,
            assembled,
            Date.now(),
          );
          run(`UPDATE conversations SET updated_at = ? WHERE id = ?`, Date.now(), conversation.id);
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
