import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { logClientOpen, logRegisterExport } from '@/lib/access-log';
import { buildRegister } from '@/lib/review-engine/register';
import { getRun } from '@/lib/review-engine/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * The whole review as one JSON document, in the shape output-schema.md sets out.
 *
 * For the workpaper file and for anything downstream that needs the register as
 * data rather than as a page. `?download=1` saves it with a filename, so it can
 * go straight into the engagement folder alongside the printed summary.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const register = await buildRegister(id);
  if (!register) return notFound();

  const body = JSON.stringify(register, null, 2);
  const download = new URL(req.url).searchParams.get('download') === '1';

  // This route is the only place the whole register leaves as data, and it was
  // the one client read that loaded no run at all — so it needs the run fetched
  // rather than a check swapped in.
  const run = await getRun(id);
  if (run) {
    await logClientOpen(user.id, { engagementId: run.engagement_id, runId: run.id });
    // Reading the page and walking away with a copy are different acts, and the
    // second is the one an enquiry asks about. Not deduplicated.
    if (download) {
      await logRegisterExport(user.id, {
        runId: run.id,
        engagementId: run.engagement_id,
        registerVersion: run.register_version ?? null,
      });
    }
  }

  const engagement = register.engagement as { entity_name?: string | null; tax_year?: number | null };
  const name = [
    (engagement?.entity_name ?? 'review').replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    engagement?.tax_year ?? '',
    `run-${register.register_version}`,
  ]
    .filter(Boolean)
    .join('-');

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      ...(download
        ? { 'Content-Disposition': `attachment; filename="${name}.json"` }
        : {}),
    },
  });
}
