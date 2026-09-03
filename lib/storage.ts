import 'server-only';
import { put, del, get } from '@vercel/blob';
import { BLOB_TOKEN } from './config';

/**
 * Uploaded documents live in blob storage, not on disk: the runtime has no
 * writable filesystem that survives a request, so a local path would mean a
 * an attachment vanished between the upload and the message that reads it.
 *
 * The store is PRIVATE, and what we persist is the pathname rather than a URL.
 * A public blob URL is itself a capability — anyone holding it can read the
 * document — so keeping one in the database would quietly route around the
 * ownership checks in /api/files/[id]/raw. Reads here are authenticated with
 * the store token instead, and that route re-checks ownership and proxies the
 * bytes.
 */

export interface StoredBlob {
  pathname: string;
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
    access: 'private',
    contentType,
    addRandomSuffix: true,
    token: BLOB_TOKEN,
  });
  return { pathname: result.pathname, size: body.length };
}

/** Reads a stored document back. Returns null if it has been purged. */
export async function getBlob(pathname: string): Promise<Buffer | null> {
  if (!BLOB_TOKEN) return null;
  try {
    const result = await get(pathname, { access: 'private', token: BLOB_TOKEN });
    if (!result?.stream) return null;
    const chunks: Uint8Array[] = [];
    // @ts-expect-error - the SDK returns a web ReadableStream, which is async-iterable at runtime
    for await (const chunk of result.stream) chunks.push(chunk as Uint8Array);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

export async function deleteBlob(pathname: string): Promise<void> {
  if (!BLOB_TOKEN) return;
  try {
    await del(pathname, { token: BLOB_TOKEN });
  } catch {
    // Already gone is the desired end state, not an error.
  }
}

export const isStorageConfigured = (): boolean => Boolean(BLOB_TOKEN);
