import { currentUser, unauthorized } from '@/lib/auth';
import { audit } from '@/lib/db';
import { disconnectAccount } from '@/lib/accounts';

type Ctx = { params: Promise<{ provider: string }> };

/**
 * Disconnect. This deletes the stored tokens; it does not revoke the grant at
 * the provider, so the message in the UI says to remove it there too if that
 * matters to them.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { provider } = await ctx.params;
  await disconnectAccount(user.id, provider);
  await audit(user.id, 'account.disconnect', 'account', provider, null);

  return Response.json({ ok: true });
}
