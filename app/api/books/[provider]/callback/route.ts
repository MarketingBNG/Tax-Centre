import { originFor } from '@/lib/accounts/origin';
import { booksProvider, completeAuthorization } from '@/lib/review-engine/books-oauth';

type Ctx = { params: Promise<{ provider: string }> };

export const dynamic = 'force-dynamic';

/**
 * Where the vendor sends the browser back to.
 *
 * Always a redirect with a short message in the query string, never a JSON
 * body: a human in a browser reaches this URL, and an error rendered as JSON is
 * a dead end with no way back to the engagement.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { provider: providerId } = await ctx.params;
  const url = new URL(req.url);
  const params = url.searchParams;
  const home = originFor(req);

  const provider = booksProvider(providerId);

  /*
   * Where to land afterwards.
   *
   * The state row knows the engagement, but the state row is consumed by
   * completeAuthorization and may be gone by the time an error is handled — so
   * the engagement is also carried on the callback URL by the vendors that
   * preserve query parameters, and falls back to the books index otherwise.
   */
  const engagementId = params.get('engagement');
  const landing = engagementId ? `/reviews/${engagementId}/books` : '/reviews';
  const back = (query: string) => Response.redirect(`${home}${landing}?${query}`, 302);

  if (!provider) return back(`books_error=${encodeURIComponent('Unknown provider')}`);

  // The client declined on the vendor's own consent screen. Not an error in
  // this system, and it should not read like one.
  const denied = params.get('error');
  if (denied) {
    return back(
      `books_error=${encodeURIComponent(
        `${provider.label} access was not granted (${denied}).`,
      )}`,
    );
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return back('books_error=missing_code');

  try {
    const row = await completeAuthorization({
      state,
      code,
      // Byte-identical to the one sent at the start, or the vendor rejects the
      // exchange. Built the same way rather than remembered, so the two cannot
      // drift.
      redirectUri: `${home}/api/books/${provider.id}/callback`,
      callbackParams: params,
      region: params.get('region') ?? params.get('location'),
    });
    return back(
      `books_connected=${encodeURIComponent(row.external_label ?? row.external_id)}`,
    );
  } catch (err) {
    return back(`books_error=${encodeURIComponent((err as Error).message)}`);
  }
}
