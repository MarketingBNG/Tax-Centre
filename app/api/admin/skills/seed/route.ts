import { currentUser, unauthorized, forbidden, audit } from '@/lib/auth';
import { seedSkills } from '@/lib/review-engine/skills-source';

/**
 * Installs the bundled tax-return-review skill into the firm's skills.
 *
 * Until now the only way to get it there was to run tests/install-skill.mjs by
 * hand against a running server, which meant a fresh deploy had no skills at
 * all and nobody could tell from the repo whether the live one did.
 *
 * Pass { force: true } to replace an existing firm copy — otherwise this leaves
 * it alone, because a deploy silently reverting a partner's correction would be
 * worse than a stale copy.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const body = await req.json().catch(() => ({}));
  const result = await seedSkills(user, { force: Boolean(body.force) });

  if (result.installed) {
    await audit(user.id, 'skill.seeded', 'skill', result.name ?? null, {
      files: result.files,
      forced: Boolean(body.force),
    });
  }

  return Response.json(result);
}
