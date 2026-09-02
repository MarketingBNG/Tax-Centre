import 'server-only';
import { put, del, head } from '@vercel/blob';
import { BLOB_TOKEN } from './config';

/**
 * Uploaded documents live in blob storage, not on disk.
 *
 * The runtime has no writable filesystem that survives a request, so a local
 * path would mean a client's return vanished between the upload and the review
 * that reads it.
 *
 * Blobs are stored with `access: 'public'`, which is how this SDK works — the
 * URL is the capability. That URL is never exposed to the browser: it is kept
 * in the database, and `/api/files/[id]/raw` re-checks ownership and proxies
 * the bytes. `addRandomSuffix` makes the path unguessable so the URL cannot be
 * derived from a filename.
 */

export interface StoredBlob {
  url: string;
  size: number;
}

function assertConfigured(): void {
  if (!BLOB_TOKEN) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set. Create a Blob store (Vercel → Storage → ' +
        'Blob) and put its token in .env.',
    );
  }
}

export async function putBlob(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<StoredBlob> {
  assertConfigured();
  const result = await put(key, body, {
    access: 'public',
    contentType,
    addRandomSuffix: true,
    token: BLOB_TOKEN,
  });
  return { url: result.url, size: body.length };
}

/** Reads a stored document back. Returns null if it has been purged. */
export async function getBlob(url: string): Promise<Buffer | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteBlob(url: string): Promise<void> {
  assertConfigured();
  try {
    await del(url, { token: BLOB_TOKEN });
  } catch {
    // Already gone is the desired end state, not an error.
  }
}

export async function blobExists(url: string): Promise<boolean> {
  if (!BLOB_TOKEN) return false;
  try {
    await head(url, { token: BLOB_TOKEN });
    return true;
  } catch {
    return false;
  }
}

export const isStorageConfigured = (): boolean => Boolean(BLOB_TOKEN);
