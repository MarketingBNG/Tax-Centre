import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { buildRegister } from '@/lib/review-engine/register';

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
