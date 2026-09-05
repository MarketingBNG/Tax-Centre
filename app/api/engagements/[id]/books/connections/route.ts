import { currentUser, unauthorized, notFound, badRequest, forbidden } from '@/lib/auth';
import { getEngagement } from '@/lib/review-engine/store';
import {
  BOOKS_PROVIDERS,
  booksProvider,
  disconnect,
  getConnection,
  isConfigured,
  listConnections,
  resolveConnection,
} from '@/lib/review-engine/books-oauth';

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/**
 * Which accounting systems this client has connected, and which could be.
 *
 * Reports the three states separately, because they need different actions
 * from different people:
 *
 *   not set up  — the firm has not registered the developer app. An admin
 *                 fixes this once, for every client at once.
 *   available   — registered, this client has not authorised it yet.
 *   connected   — usable, unless the grant has since been withdrawn.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const engagement = await getEngagement(id);
  if (!engagement) return notFound();

  const clientKey = engagement.ein ?? engagement.client_label;
  const connections = await listConnections(clientKey);

  return Response.json({
    clientKey,
    providers: BOOKS_PROVIDERS.map((provider) => {
      const existing = connections.filter((c) => c.provider === provider.id);
      return {
        id: provider.id,
        label: provider.label,
        configured: isConfigured(provider),
        // Never the client id or secret, only whether they exist.
        setupHint: isConfigured(provider) ? null : provider.setupHint,
        // Zoho only: the data centre has to be chosen before the redirect,
        // because its tokens are not valid across regions.
        needsRegion: provider.id === 'zoho',
        connections: existing.map((c) => ({
          id: c.id,
          company: c.external_label ?? c.external_id,
          externalId: c.external_id,
          region: c.data_region,
          connectedAt: Number(c.created_at),
          // A withdrawn grant is shown as needing reconnection rather than
          // being hidden: it fails at import time otherwise, months later,
          // with nothing on screen explaining why.
          revoked: c.revoked_at !== null,
          lastError: c.last_error,
        })),
      };
    }),
  });
}

/**
 * Probes a connection, or removes it.
 *
 * The probe exists because the report parsers are not written yet, and cannot
 * honestly be written until a real response has been seen. It returns the
 * structure of what the vendor actually sent for this company. Restricted to
 * admins: it is a development tool that returns raw client financial data, and
 * it should not be one click away for everybody.
 */
export async function POST(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const engagement = await getEngagement(id);
  if (!engagement) return notFound();

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    connectionId?: string;
  };
  if (!body.connectionId) return badRequest('Which connection?');

  const row = await getConnection(body.connectionId);
  if (!row) return notFound();

  // The connection belongs to a client, and this route is reached through an
  // engagement. Those have to be the same client, or an engagement becomes a
  // way to reach another client's books.
  const clientKey = engagement.ein ?? engagement.client_label;
  if (row.client_key !== clientKey) return forbidden();

  if (body.action === 'disconnect') {
    await disconnect(user.id, row.id);
    return Response.json({ ok: true });
  }

  if (body.action === 'probe') {
    if (user.role !== 'admin') return forbidden();
    const provider = booksProvider(row.provider);
    if (!provider) return badRequest('Unknown provider.');
    try {
      const resolved = await resolveConnection(row);
      return Response.json({ ok: true, report: await provider.probe(resolved) });
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 200 });
    }
  }

  return badRequest('Unknown action.');
}
