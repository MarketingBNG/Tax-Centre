import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { eventsAfter, getRun } from '@/lib/review-engine/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Progress a client missed, replayed from a cursor.
 *
 * The advance stream only reaches whoever made that request. This is how a
 * reloaded tab, a second person watching, or a browser that dropped its
 * connection mid-stage catches up — pass the last cursor seen and get
 * everything since.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return notFound();

  const after = Number(new URL(req.url).searchParams.get('after') ?? 0);
  const rows = await eventsAfter(id, Number.isFinite(after) ? after : 0);

  return Response.json({
    events: rows.map((row) => ({
      cursor: Number(row.id),
      ...(JSON.parse(row.payload) as Record<string, unknown>),
    })),
    cursor: rows.length ? Number(rows[rows.length - 1].id) : after,
    runStatus: run.status,
    verdict: run.verdict,
  });
}
