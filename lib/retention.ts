import 'server-only';
import { all, run, audit } from './db';
import { RETENTION_ORIGINALS_DAYS } from './config';
import { deleteBlob } from './storage';
import type { FileRow } from './types';

/**
 * This app is a review assistant, not the firm's document management system.
 * The client's source documents live in the DMS; holding a second, less
 * governed copy of every SSN-bearing PDF indefinitely is liability with no
 * offsetting benefit. So originals expire while the work product — what was
 * reviewed, what was found, by whom, under which skill version — is kept.
 */
export async function sweepExpiredOriginals(): Promise<{ deleted: number; freedBytes: number }> {
  if (!RETENTION_ORIGINALS_DAYS) return { deleted: 0, freedBytes: 0 };

  const cutoff = Date.now() - RETENTION_ORIGINALS_DAYS * 86_400_000;
  const stale = await all<FileRow>(
    `SELECT * FROM files WHERE deleted_at IS NULL AND created_at < ?`,
    cutoff,
  );

  let deleted = 0;
  let freedBytes = 0;

  for (const file of stale) {
    try {
      // Remove the bytes first: a tombstone with the blob still present is a
      // worse outcome than a blob with no tombstone, which the next sweep fixes.
      await deleteBlob(file.storage_path);
      await run(
        `UPDATE files SET deleted_at = ?, extracted_text = NULL WHERE id = ?`,
        Date.now(),
        file.id,
      );
      await audit(null, 'file.purged', 'file', file.id, {
        filename: file.filename,
        sha256: file.sha256,
        ageDays: Math.floor((Date.now() - Number(file.created_at)) / 86_400_000),
      });
      deleted += 1;
      freedBytes += Number(file.size_bytes);
    } catch (err) {
      console.error('[retention] could not purge', file.id, (err as Error).message);
    }
  }

  return { deleted, freedBytes };
}

/** Immediate purge of one file, for an explicit delete request. */
export async function purgeFile(fileId: string, actorId: string): Promise<boolean> {
  const rows = await all<FileRow>(
    `SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`,
    fileId,
  );
  const file = rows[0];
  if (!file) return false;

  await deleteBlob(file.storage_path);
  await run(`UPDATE files SET deleted_at = ?, extracted_text = NULL WHERE id = ?`, Date.now(), fileId);
  await audit(actorId, 'file.delete', 'file', fileId, {
    filename: file.filename,
    sha256: file.sha256,
  });
  return true;
}
