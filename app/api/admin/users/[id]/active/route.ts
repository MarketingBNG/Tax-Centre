import {
  currentUser,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  audit,
} from '@/lib/auth';
import { one, run } from '@/lib/db';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await ctx.params;
  if (id === user.id) return badRequest('You cannot deactivate your own account');

  const target = await one<{ id: string; role: string; is_active: number; email: string }>(
    `SELECT id, role, is_active, email FROM users WHERE id = ?`,
    id,
  );
  if (!target) return notFound();

  const { active } = await req.json().catch(() => ({}));
  const makeActive = Boolean(active);

  // Deactivating the last active admin would lock the whole firm out of costs
  // and user management with no way back in through the UI.
  if (!makeActive && target.role === 'admin' && target.is_active) {
    const remaining =
      (await one<{ c: number }>(
        `SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?`,
        id,
      ))?.c ?? 0;
    if (remaining === 0) {
      return badRequest(
        'That is the only active admin. Promote someone else to admin first, ' +
          'otherwise nobody could manage instructions or users.',
      );
    }
  }

  await run(`UPDATE users SET is_active = ? WHERE id = ?`, makeActive ? 1 : 0, id);

  // Revocation is immediate without touching sessions: the JWT callback
  // re-reads this row on every request, so a deactivated user loses access on
  // their next one rather than when a token expires.

  await audit(user.id, 'user.set_active', 'user', id, { active: makeActive, email: target.email });
  return Response.json({ ok: true });
}
