import { currentUser, unauthorized, forbidden, notFound, audit } from '@/lib/auth';
import { getConnector, refreshTools } from '@/lib/connectors';

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 60;

/**
 * Asks the server what it can do, and caches the answer.
 *
 * Also the "test connection" button: a connector that cannot be reached, or
 * that refuses the credential, reports why here rather than failing silently
 * in the middle of somebody's question later.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await ctx.params;
  if (!(await getConnector(id))) return notFound();

  const { tools, error } = await refreshTools(id);
  await audit(user.id, 'connector.refresh', 'connector', id, {
    tools: tools.length,
    error: error ?? null,
  });

  return Response.json({ tools, error });
}
