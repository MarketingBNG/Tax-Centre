import 'server-only';
import crypto from 'node:crypto';

/**
 * Encryption for the tokens that reach other people's systems.
 *
 * A refresh token for someone's mailbox is a standing grant to read it, which
 * makes it the one thing in this database that must not be usable from a
 * stolen dump on its own. AES-256-GCM, with the key derived from AUTH_SECRET
 * rather than stored beside the data — a backup of Postgres is then not enough
 * to use anything in it.
 *
 * Rotating AUTH_SECRET invalidates every stored token, which is the correct
 * behaviour: people reconnect their accounts, and the old ciphertext is inert.
 */

const KEY_INFO = 'assistant:oauth-token:v1';

let cached: Buffer | null = null;

function key(): Buffer {
  if (cached) return cached;

  const source = process.env.TOKEN_ENCRYPTION_KEY || process.env.AUTH_SECRET || '';
  if (!source) {
    throw new Error(
      'AUTH_SECRET is not set, so account tokens cannot be encrypted. ' +
        'Set it (or TOKEN_ENCRYPTION_KEY) before connecting an account.',
    );
  }
  cached = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(source), Buffer.alloc(0), KEY_INFO, 32));
  return cached;
}

/** Returns iv.ciphertext.tag, base64url, joined by dots. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, body, tag].map((b) => b.toString('base64url')).join('.');
}

/**
 * Returns null rather than throwing on anything that will not decrypt: a token
 * written under a previous AUTH_SECRET is not an error to handle, it is an
 * account that needs reconnecting.
 */
export function decryptSecret(stored: string | null): string | null {
  if (!stored) return null;
  const parts = stored.split('.');
  if (parts.length !== 3) return null;

  try {
    const [iv, body, tag] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
