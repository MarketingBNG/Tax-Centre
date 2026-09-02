import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { one } from '@/lib/db';
import { readEvents, isRunning, reviewStatus } from '@/lib/jobs';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

/**
 * Replays a review's event log from `?from=<cursor>`, then tails it until the
 * review finishes. Reconnecting with the last cursor picks up exactly where the
 * browser left off, so a refresh mid-review loses nothing.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const owns = one<{ id: string }>(
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

      // Polling rather than a pub/sub fan-out: one process, a handful of
      // concurrent reviews, and the event log is the source of truth anyway.
      for (;;) {
        if (req.signal.aborted) break;

        const batch = readEvents(id, cursor);
        for (const row of batch) {
          cursor = row.id;
          send({ cursor: row.id, ...row.event });
        }

        const status = reviewStatus(id);
        const settled = status !== 'running' && !isRunning(id);
        if (settled && batch.length === 0) {
          send({ type: 'closed', status, cursor });
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, batch.length ? 60 : 400));
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
