import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { one } from '@/lib/db';
import { readEvents, reviewStatus, isStale, markStaleFailed } from '@/lib/jobs';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Replays a review's event log from `?from=<cursor>`, then tails it until the
 * review finishes. Reconnecting with the last cursor picks up exactly where the
 * browser left off, so a refresh mid-review loses nothing.
 *
 * Staleness matters here: the instance running the review can be killed by a
 * deploy or a timeout, and nothing would then move the row off 'running'. When
 * the heartbeat goes quiet this closes the review out rather than tailing an
 * event log that will never grow.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const owns = await one<{ id: string }>(
    `SELECT id FROM reviews WHERE id = ? AND (user_id = ? OR ? = 'admin')`,
    id,
    user.id,
    user.role,
  );
  if (!owns) return notFound();

  const url = new URL(req.url);
  let cursor = Number(url.searchParams.get('from') ?? 0) || 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (obj: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch {
          open = false;
        }
      };

      // Polling rather than a pub/sub fan-out: there is no shared process to
      // broadcast from, and the event log is the source of truth anyway.
      try {
        for (;;) {
          if (req.signal.aborted) break;

          const batch = await readEvents(id, cursor);
          for (const row of batch) {
            cursor = row.id;
            send({ cursor: row.id, ...row.event });
          }

          const status = await reviewStatus(id);

          if (status !== 'running') {
            if (batch.length === 0) {
              send({ type: 'closed', status, cursor });
              break;
            }
          } else if (batch.length === 0 && (await isStale(id))) {
            await markStaleFailed(id);
            send({
              type: 'error',
              message:
                'The review stopped unexpectedly — the server running it went away. ' +
                'Nothing was lost; start it again.',
            });
            send({ type: 'closed', status: 'failed', cursor });
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, batch.length ? 80 : 500));
        }
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      }

      open = false;
      try {
        controller.close();
      } catch {
        /* already closed by the client going away */
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
