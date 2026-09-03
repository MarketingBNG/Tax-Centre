import { currentUser, unauthorized, notFound, audit } from '@/lib/auth';
import { one, run } from '@/lib/db';
import type { FileRow } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Remove a document from the conversation or project it is attached to.
 *
 * Soft delete: the row stays so the answers that already cite it still resolve
 * to a filename rather than to nothing, and the retention sweeper is what
 * eventually removes the bytes.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const file = await one<FileRow>(
    `SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    id,
    user.id,
  );
  if (!file) return notFound();

  await run(`UPDATE files SET deleted_at = ? WHERE id = ?`, Date.now(), id);
  await audit(user.id, 'file.remove', 'file', id, { filename: file.filename });
  return Response.json({ ok: true });
}
