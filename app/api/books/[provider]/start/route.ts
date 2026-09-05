import { currentUser, unauthorized, badRequest } from '@/lib/auth';
import { originFor } from '@/lib/accounts/origin';
import { booksProvider, startAuthorization } from '@/lib/review-engine/books-oauth';
import { getEngagement } from '@/lib/review-engine/store';

type Ctx = { params: Promise<{ provider: string }> };

export const dynamic = 'force-dynamic';

/** The callback URL to register with each vendor. One per provider. */
export const booksRedirectUri = (req: Request, providerId: string): string =>
  `${originFor(req)}/api/books/${providerId}/callback`;

/**
 * Starts a client's authorisation of their own accounting system.
 *
 * Reached from the engagement, and the grant is recorded against the client
 * rather than the person who clicked: a reviewer connecting a client's
 * QuickBooks is obtaining access for the firm, not for themselves, and it has
 * to keep working when they hand the file over.
 *
 * ?engagement=<id> — where the person came from, so the callback can send them
 *   back to it and so the grant can be audited against a piece of work.
 * ?region=in|com|eu — Zoho only. Its accounts live in one of several data
 *   centres and its tokens are not valid across them.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { provider: providerId } = await ctx.params;
  const provider = booksProvider(providerId);
  if (!provider) return badRequest(`There is no books connector called "${providerId}".`);

  const params = new URL(req.url).searchParams;
  const engagementId = params.get('engagement');
  if (!engagementId) {
    return badRequest('Which engagement is this for? Start from the books screen.');
  }

  const engagement = await getEngagement(engagementId);
  if (!engagement) return badRequest('That engagement does not exist.');

  /*
   * The client, not the engagement, owns the grant.
   *
   * A client is reviewed every year and the same books serve each of those
   * engagements. Keying the grant to one engagement would mean re-consenting
   * the client annually for access they already gave.
   *
   * Which client is decided the same way prior-year comparison decides it: the
   * EIN where there is one, the exact label only where there is not. Using the
   * label alone would break every grant the day somebody tidies up a client
   * name, and a fuzzy match would point one client's review at another's
   * books — which is worse than having no connection at all.
   */
  const clientKey = engagement.ein ?? engagement.client_label;

  try {
    const { url } = await startAuthorization({
      provider,
      clientKey,
      engagementId,
      redirectUri: booksRedirectUri(req, provider.id),
      redirectTo: `/reviews/${engagementId}/books`,
      region: params.get('region'),
      startedBy: user.id,
    });
    return Response.redirect(url, 302);
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
