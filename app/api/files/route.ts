import { currentUser, unauthorized, badRequest, notFound, audit } from '@/lib/auth';
import { one } from '@/lib/db';
import { ingestFile } from '@/lib/ingest';
import { describeCounts } from '@/lib/pii';
import { MAX_UPLOAD_BYTES } from '@/lib/config';
import { getProject } from '@/lib/prefs';
import type { ConversationRow } from '@/lib/types';

const MAX_FILES_PER_REQUEST = 20;

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  // formData() buffers the whole body in memory, so refuse an oversized request
  // before reading a byte of it rather than after.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) {
    return Response.json(
      {
        error: `That upload is ${(declared / 1048576).toFixed(0)} MB, over the ${(MAX_UPLOAD_BYTES / 1048576).toFixed(0)} MB request limit. Upload fewer files at a time.`,
      },
      { status: 413 },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) return badRequest('Expected a multipart upload');

  const conversationId = (form.get('conversationId') as string) || null;
  if (conversationId) {
    const conv = await one<ConversationRow>(
      `SELECT id FROM conversations WHERE id = ? AND user_id = ?`,
      conversationId,
      user.id,
    );
    if (!conv) return notFound();
  }

  // A project shelf upload. Exclusive with a conversation: a file belongs to
  // one or the other, never both, or removing it from one leaves a live
  // reference behind in the other.
  const projectId = (form.get('projectId') as string) || null;
  if (projectId) {
    if (conversationId) return badRequest('Upload to a chat or to a project, not both');
    if (!(await getProject(user.id, projectId))) return notFound();
  }

  const uploads = form.getAll('files').filter((f): f is File => f instanceof File);
  const files: unknown[] = [];
  const errors: { filename: string; error: string }[] = [];

  if (uploads.length > MAX_FILES_PER_REQUEST) {
    return badRequest(`At most ${MAX_FILES_PER_REQUEST} files per upload.`);
  }

  for (const upload of uploads) {
    try {
      // Check the declared size before materialising the bytes.
      if (upload.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `"${upload.name}" is ${(upload.size / 1048576).toFixed(1)} MB, over the limit.`,
        );
      }
      const buffer = Buffer.from(await upload.arrayBuffer());
      const stored = await ingestFile({
        userId: user.id,
        conversationId,
        projectId,
        filename: upload.name,
        buffer,
      });

      await audit(user.id, 'file.upload', 'file', stored.id, {
        filename: stored.filename,
        kind: stored.kind,
        bytes: stored.size_bytes,
        pii: stored.pii_counts ?? null,
      });

      const counts = stored.pii_counts ? JSON.parse(stored.pii_counts) : {};
      files.push({
        id: stored.id,
        filename: stored.filename,
        kind: stored.kind,
        pageCount: stored.page_count,
        sizeBytes: stored.size_bytes,
        deduped: Boolean(stored.deduped),
        piiSummary: describeCounts(counts) || null,
      });
    } catch (err) {
      errors.push({ filename: upload.name, error: (err as Error).message });
    }
  }

  return Response.json({ files, errors });
}
