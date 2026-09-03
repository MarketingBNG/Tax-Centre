import { currentUser, unauthorized, forbidden, notFound, badRequest, audit } from '@/lib/auth';
import {
  approvedNames,
  cachedTools,
  deleteConnector,
  getConnector,
  updateConnector,
} from '@/lib/connectors';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await ctx.params;
  const row = await getConnector(id);
  if (!row) return notFound();

  return Response.json({
    id: row.id,
    name: row.name,
    url: row.url,
    authHeader: row.auth_header,
    hasSecret: Boolean(row.auth_value),
    enabled: row.enabled === 1,
    approved: approvedNames(row),
    tools: cachedTools(row),
    lastError: row.last_error,
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await ctx.params;
  const before = await getConnector(id);
  if (!before) return notFound();

  const body = await req.json().catch(() => ({}));

  try {
    await updateConnector(id, {
      name: body.name === undefined ? undefined : String(body.name),
      url: body.url === undefined ? undefined : String(body.url),
      authHeader: body.authHeader === undefined ? undefined : String(body.authHeader ?? ''),
      authValue: body.authValue === undefined ? undefined : String(body.authValue ?? ''),
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      allowedTools: Array.isArray(body.allowedTools)
        ? body.allowedTools.map(String)
        : undefined,
    });
  } catch (err) {
    return badRequest((err as Error).message);
  }

  // Approving a tool is a grant of access, so what changed goes in the log
  // rather than only that something did.
  if (Array.isArray(body.allowedTools)) {
    const wasApproved = approvedNames(before);
    const added = body.allowedTools.filter((t: string) => !wasApproved.includes(t));
    const removed = wasApproved.filter((t) => !body.allowedTools.includes(t));
    await audit(user.id, 'connector.tools', 'connector', id, { added, removed });
  }
  if (body.enabled !== undefined && Boolean(body.enabled) !== (before.enabled === 1)) {
    await audit(user.id, 'connector.enabled', 'connector', id, { enabled: Boolean(body.enabled) });
  }

  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await ctx.params;
  const row = await getConnector(id);
  if (!row) return notFound();

  await deleteConnector(id);
  await audit(user.id, 'connector.delete', 'connector', id, { name: row.name });
  return Response.json({ ok: true });
}
