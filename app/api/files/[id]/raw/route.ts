import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { one, audit } from '@/lib/db';
import { getBlob } from '@/lib/storage';
import type { FileRow } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Serves a stored document after re-checking ownership.
 *
 * The blob's own URL is never handed to the browser: possession of that URL is
 * possession of the file, and it would bypass every check below. The bytes are
 * proxied through here instead so a reviewer cannot read another reviewer's
 * client documents by guessing or sharing a link.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const file =
    user.role === 'admin'
      ? await one<FileRow>(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`, id)
      : await one<FileRow>(
          `SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
          id,
          user.id,
        );
  if (!file) return notFound();

  const bytes = await getBlob(file.storage_path);
  if (!bytes) return notFound();

  if (user.role === 'admin' && file.user_id !== user.id) {
    // Admins can read across users; making that visible is what keeps it
    // acceptable rather than corrosive.
    await audit(user.id, 'admin.read_other', 'file', file.id, { owner: file.user_id });
  }

  // `Content-Security-Policy: sandbox` (with no allow-same-origin) puts the
  // response in an opaque origin, so even inline it cannot script against the
  // reviewer's session. That is what makes the in-app preview safe.
  const inline = new URL(req.url).searchParams.get('inline') === '1';

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': file.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    },
  });
}
