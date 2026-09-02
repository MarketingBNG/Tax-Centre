import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { one, audit } from '@/lib/db';
import { DATA_DIR } from '@/lib/config';
import type { FileRow } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const file =
    user.role === 'admin'
      ? one<FileRow>(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`, id)
      : one<FileRow>(
          `SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
          id,
          user.id,
        );
  if (!file) return notFound();

  const abs = path.join(DATA_DIR, file.storage_path);
  if (!existsSync(abs)) return notFound();

  if (user.role === 'admin' && file.user_id !== user.id) {
    // Admins can read across users; making that visible is what keeps it acceptable.
    audit(user.id, 'admin.read_other', 'file', file.id, { owner: file.user_id });
  }

  // `Content-Security-Policy: sandbox` (with no allow-same-origin) puts the
  // response in an opaque origin, so even inline it cannot script against the
  // reviewer's session. That is what makes the in-app preview safe; without it
  // a malicious PDF rendered inline would be a real vector.
  const inline = new URL(req.url).searchParams.get('inline') === '1';

  return new Response(new Uint8Array(readFileSync(abs)), {
    headers: {
      'Content-Type': file.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    },
  });
}
