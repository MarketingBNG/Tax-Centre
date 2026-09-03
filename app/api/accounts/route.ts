import { currentUser, unauthorized } from '@/lib/auth';
import { ACCOUNT_PROVIDERS, connectedAccounts, isConfigured } from '@/lib/accounts';
import { redirectUriFor } from '@/lib/accounts/origin';

/**
 * Every account type this build knows about, and where this person stands with
 * each: not set up on the server, set up but not connected, or connected.
 *
 * The redirect URI is included for the ones that are not configured, because
 * the first thing anybody setting this up needs is the exact string to paste
 * into the provider console — and getting it wrong by a slash is the usual
 * reason the first attempt fails.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const connected = await connectedAccounts(user.id);

  return Response.json(
    ACCOUNT_PROVIDERS.map((p) => {
      const mine = connected.find((c) => c.provider === p.id);
      const configured = isConfigured(p);
      return {
        id: p.id,
        label: p.label,
        blurb: p.blurb,
        configured,
        connected: Boolean(mine),
        accountLabel: mine?.accountLabel ?? null,
        connectedAt: mine?.connectedAt ?? null,
        toolCount: p.tools.length,
        // Only useful to whoever is doing the setup, and not a secret.
        setupHint: configured ? null : p.setupHint,
        redirectUri: configured ? null : redirectUriFor(req, p.id),
      };
    }),
  );
}
