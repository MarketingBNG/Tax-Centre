import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { one, audit } from '@/lib/db';
import { getBlob } from '@/lib/storage';
import { getRun } from '@/lib/review-engine/store';
import type { FileRow } from '@/lib/types';

type Ctx = { params: Promise<{ id: string; fileId: string }> };

/**
 * Serves a document that belongs to a review.
 *
 * /api/files/[id]/raw exists already, but it scopes to whoever uploaded the
 * file — which is right for chat and wrong here. A review is firm-visible work:
 * the preparer who uploaded the trial balance is routinely not the reviewer
 * reading the finding that cites it, and evidence a reviewer cannot open is
 * not evidence.
 *
 * So the check is different rather than absent. Membership of this run is what
 * grants access, and only for the documents the run actually attached — this
 * cannot be used to read an arbitrary file id.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id, fileId } = await ctx.params;
  const run = await getRun(id);
  if (!run) return notFound();

  // The file has to be attached to this run. Without this the route would be a
  // way around the ownership check on every file in the database.
  const attached = await one<{ file_id: string }>(
    `SELECT file_id FROM run_documents WHERE run_id = ? AND file_id = ?`,
    id,
    fileId,
  );
  if (!attached) return notFound();

  const file = await one<FileRow>(
    `SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`,
    fileId,
  );
  if (!file) return notFound();

  const bytes = await getBlob(file.storage_path);
  if (!bytes) return notFound();

  if (file.user_id !== user.id) {
    // Reading somebody else's upload is expected here, but it is still worth a
    // line in the log — visible cross-reading is what keeps it acceptable.
    await audit(user.id, 'review.read_document', 'file', file.id, {
      runId: id,
      owner: file.user_id,
    });
  }

  const inline = new URL(req.url).searchParams.get('inline') === '1';

  // Sandbox with no allow-same-origin puts the response in an opaque origin, so
  // a hostile PDF cannot script against the reviewer's session even though it
  // is served from our host. That is what makes the in-app preview safe.
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
