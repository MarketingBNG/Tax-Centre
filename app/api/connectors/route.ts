import { currentUser, unauthorized } from '@/lib/auth';
import { ACCOUNT_PREFIX, approvedNames, enabledConnectors } from '@/lib/connectors';
import { connectedAccounts } from '@/lib/accounts';
import { CONNECTORS_ENABLED } from '@/lib/config';

/**
 * What the composer's picker shows — both kinds of connection in one list,
 * because the question it answers is "what may this thread reach", and whether
 * the credential is the firm's or your own is a detail below that.
 *
 * Not the URL and not the credential: a member has no use for either. A shared
 * connector with nothing approved, and an account nobody has connected, are
 * both omitted rather than shown as options that would do nothing if picked.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const shared = CONNECTORS_ENABLED
    ? (await enabledConnectors())
        .map((r) => ({
          id: r.id,
          kind: 'mcp' as const,
          name: r.name,
          detail: null as string | null,
          toolCount: approvedNames(r).length,
        }))
        .filter((r) => r.toolCount > 0)
    : [];

  const mine = (await connectedAccounts(user.id)).map((a) => ({
    id: `${ACCOUNT_PREFIX}${a.provider}`,
    kind: 'account' as const,
    name: a.label,
    detail: a.accountLabel,
    toolCount: a.toolCount,
  }));

  return Response.json([...mine, ...shared]);
}
