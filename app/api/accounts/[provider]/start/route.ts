import { currentUser, unauthorized, badRequest } from '@/lib/auth';
import { beginAuth } from '@/lib/accounts';
import { redirectUriFor } from '@/lib/accounts/origin';

type Ctx = { params: Promise<{ provider: string }> };

export const dynamic = 'force-dynamic';

/**
 * Sends the person to the provider to authorise. A redirect rather than JSON,
 * so the browser can simply follow a link.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { provider } = await ctx.params;

  try {
    const url = await beginAuth({
      userId: user.id,
      providerId: provider,
      redirectUri: redirectUriFor(req, provider),
    });
    return Response.redirect(url, 302);
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
