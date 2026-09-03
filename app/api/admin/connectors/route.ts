import { currentUser, unauthorized, forbidden, badRequest, audit } from '@/lib/auth';
import {
  approvedNames,
  cachedTools,
  createConnector,
  listConnectors,
} from '@/lib/connectors';
import { CONNECTORS_ENABLED } from '@/lib/config';
import type { ConnectorRow } from '@/lib/types';

/**
 * The stored credential never comes back out of this route. An admin can see
 * that a secret is set and can replace it; nothing in the app can read it back,
 * so a compromised admin session cannot harvest connector tokens.
 */
const present = (row: ConnectorRow) => ({
  id: row.id,
  name: row.name,
  url: row.url,
  authHeader: row.auth_header,
  hasSecret: Boolean(row.auth_value),
  enabled: row.enabled === 1,
  approved: approvedNames(row),
  tools: cachedTools(row),
  toolsFetchedAt: row.tools_fetched_at,
  lastError: row.last_error,
  updatedAt: row.updated_at,
});

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  return Response.json({
    connectorsEnabled: CONNECTORS_ENABLED,
    connectors: (await listConnectors()).map(present),
  });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const url = String(body.url ?? '').trim();
  if (!name) return badRequest('A connector needs a name');
  if (!url) return badRequest('A connector needs a URL');

  try {
    const row = await createConnector({
      name,
      url,
      authHeader: body.authHeader ? String(body.authHeader) : null,
      authValue: body.authValue ? String(body.authValue) : null,
      createdBy: user.id,
    });
    // The URL is recorded; the credential deliberately is not.
    await audit(user.id, 'connector.create', 'connector', row.id, { name: row.name, url: row.url });
    return Response.json(present(row));
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
