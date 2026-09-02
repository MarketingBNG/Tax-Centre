import 'server-only';
import { unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { all, run, audit } from './db';
import { DATA_DIR, RETENTION_ORIGINALS_DAYS } from './config';
import type { FileRow } from './types';

/**
 * This app is a review assistant, not the firm's document management system.
 * The client's source documents live in the DMS; holding a second, less-governed
 * copy of every SSN-bearing PDF indefinitely is liability with no offsetting
 * benefit. So originals expire while the work product — what was reviewed, what
 * was found, by whom, under which skill version — is kept.
 */
export function sweepExpiredOriginals(): { deleted: number; freedBytes: number } {
  if (!RETENTION_ORIGINALS_DAYS) return { deleted: 0, freedBytes: 0 };

  const cutoff = Date.now() - RETENTION_ORIGINALS_DAYS * 86_400_000;
  const stale = all<FileRow>(
    `SELECT * FROM files WHERE deleted_at IS NULL AND created_at < ?`,
    cutoff,
  );

  let deleted = 0;
  let freedBytes = 0;

  for (const file of stale) {
    const abs = path.join(DATA_DIR, file.storage_path);
    try {
      if (existsSync(abs)) unlinkSync(abs);
      // Tombstone rather than DELETE: the review that cited this file keeps a
      // record that the document existed and when it was purged.
      run(
        `UPDATE files SET deleted_at = ?, extracted_text = NULL WHERE id = ?`,
        Date.now(),
        file.id,
      );
      audit(null, 'file.purged', 'file', file.id, {
        filename: file.filename,
        sha256: file.sha256,
        ageDays: Math.floor((Date.now() - file.created_at) / 86_400_000),
      });
      deleted += 1;
      freedBytes += file.size_bytes;
    } catch (err) {
      console.error('[retention] could not purge', file.id, (err as Error).message);
    }
  }

  return { deleted, freedBytes };
}

/** Immediate purge of one file, for an explicit delete request. */
export function purgeFile(fileId: string, actorId: string): boolean {
  const file = all<FileRow>(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`, fileId)[0];
  if (!file) return false;

  const abs = path.join(DATA_DIR, file.storage_path);
  try {
    if (existsSync(abs)) unlinkSync(abs);
  } catch {
    /* the tombstone below still revokes access */
  }
  run(`UPDATE files SET deleted_at = ?, extracted_text = NULL WHERE id = ?`, Date.now(), fileId);
  audit(actorId, 'file.delete', 'file', fileId, { filename: file.filename, sha256: file.sha256 });
  return true;
}
