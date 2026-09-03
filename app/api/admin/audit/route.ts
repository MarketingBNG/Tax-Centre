import { currentUser, unauthorized, forbidden } from '@/lib/auth';
import { all } from '@/lib/db';

const PAGE = 100;

/**
 * The audit trail, newest first.
 *
 * Read-only by design: there is no route that edits or deletes a row, because
 * a log the administrator can rewrite is not evidence of anything.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const params = new URL(req.url).searchParams;
  const action = (params.get('action') ?? '').trim();
  const before = Number(params.get('before') ?? 0);

  const rows = await all<{
    id: string;
    at: number;
    action: string;
    target_type: string | null;
    target_id: string | null;
    detail: string | null;
    email: string | null;
  }>(
    `SELECT a.id, a.at, a.action, a.target_type, a.target_id, a.detail, u.email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE (?::text = '' OR a.action = ?)
        AND (?::bigint = 0 OR a.at < ?)
      ORDER BY a.at DESC
      LIMIT ${PAGE}`,
    action,
    action,
    before,
    before,
  );

  const actions = await all<{ action: string; n: string }>(
    `SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY action`,
  );

  return Response.json({
    entries: rows.map((r) => ({
      id: r.id,
      at: Number(r.at),
      action: r.action,
      actor: r.email,
      target: r.target_id ? `${r.target_type ?? 'row'} ${r.target_id}` : null,
      detail: r.detail,
    })),
    actions: actions.map((a) => ({ action: a.action, count: Number(a.n) })),
    hasMore: rows.length === PAGE,
  });
}
