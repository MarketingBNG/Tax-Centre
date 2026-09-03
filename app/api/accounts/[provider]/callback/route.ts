import { currentUser } from '@/lib/auth';
import { audit } from '@/lib/db';
import { completeAuth } from '@/lib/accounts';
import { originFor } from '@/lib/accounts/origin';

type Ctx = { params: Promise<{ provider: string }> };

export const dynamic = 'force-dynamic';

/**
 * Where the provider sends the browser back to.
 *
 * Always ends in a redirect to the app with a short message in the query
 * string, because this URL is reached by a human in a browser: a JSON error
 * body here would be a dead end with no way back.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { provider } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const home = originFor(req);

  const back = (query: string) => Response.redirect(`${home}/?${query}`, 302);

  const denied = params.get('error');
  if (denied) return back(`account_error=${encodeURIComponent(denied)}`);

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return back('account_error=missing_code');

  try {
    const result = await completeAuth({ code, state });
    // The state row carries the user id, so this does not depend on the session
    // surviving the round trip to the provider — but log it against whoever is
    // signed in here, which is the same person in every normal flow.
    const user = await currentUser();
    await audit(user?.id ?? null, 'account.connect', 'account', result.providerId, {
      label: result.label,
    });
    return back(`connected=${encodeURIComponent(result.providerId)}`);
  } catch (err) {
    return back(`account_error=${encodeURIComponent((err as Error).message)}`);
  }
}
