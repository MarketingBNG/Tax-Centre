import { currentUser, unauthorized, forbidden } from '@/lib/auth';
import { all } from '@/lib/db';
import { originFor } from '@/lib/accounts/origin';
import { BOOKS_PROVIDERS, isConfigured } from '@/lib/review-engine/books-oauth';

export const dynamic = 'force-dynamic';

/**
 * Whether each books provider is registered on this server.
 *
 * A firm-level question with a firm-level answer, which is why it is here
 * rather than only on an engagement's books screen. Whether QuickBooks has been
 * registered has nothing to do with any one client, and an admin should not
 * have to open somebody's return to find the redirect URL they need in order to
 * register it.
 *
 * The credentials themselves never leave the server. This reports only whether
 * a pair is present, so a compromised admin session cannot harvest them.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const origin = originFor(req);

  // How many clients have authorised each provider, so an admin can see at a
  // glance whether a registered app is actually being used.
  const counts = await all<{ provider: string; n: string }>(
    `SELECT provider, COUNT(*) AS n FROM books_connections
      WHERE revoked_at IS NULL GROUP BY provider`,
  );
  const revoked = await all<{ provider: string; n: string }>(
    `SELECT provider, COUNT(*) AS n FROM books_connections
      WHERE revoked_at IS NOT NULL GROUP BY provider`,
  );
  const countFor = (rows: { provider: string; n: string }[], id: string) =>
    Number(rows.find((r) => r.provider === id)?.n ?? 0);

  return Response.json({
    providers: BOOKS_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      configured: isConfigured(provider),
      setupHint: provider.setupHint,
      // Given exactly, because it has to match what is registered with the
      // vendor byte for byte and retyping it from memory is where an
      // afternoon goes.
      redirectUri: `${origin}/api/books/${provider.id}/callback`,
      // Named so an admin knows which pair to set, without the values.
      envKeys: [
        `${provider.id === 'quickbooks' ? 'QUICKBOOKS' : provider.id.toUpperCase()}_CLIENT_ID`,
        `${provider.id === 'quickbooks' ? 'QUICKBOOKS' : provider.id.toUpperCase()}_CLIENT_SECRET`,
      ],
      scopes: provider.scopes,
      connectedClients: countFor(counts, provider.id),
      needsReconnect: countFor(revoked, provider.id),
    })),
  });
}
