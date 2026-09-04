import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { getRun } from '@/lib/review-engine/store';
import { advanceRun } from '@/lib/review-engine/orchestrator';
import type { StageEvent } from '@/lib/review-engine/stage-runner';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Runs the next stage of a review, streaming progress as it goes.
 *
 * One stage per request. The client calls this in a loop until the run reports
 * itself finished, which is what keeps each request inside the platform's
 * timeout — a whole review would not fit in one, but a stage comfortably does.
 *
 * Progress is streamed as NDJSON, the same shape the chat route uses, and every
 * event is also appended to run_events so a tab that reconnects mid-stage can
 * replay what it missed rather than staring at nothing.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return notFound();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The reader went away — the run continues and commits regardless,
          // which is the point of keeping state in the database.
        }
      };

      try {
        const result = await advanceRun({
          runId: id,
          actorId: user.id,
          onEvent: (event: StageEvent) => send(event),
        });
        send({ type: 'advanced', ...result });
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
