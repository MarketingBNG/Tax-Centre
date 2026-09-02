import 'server-only';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const ROOT = process.cwd();

// Minimal .env loader — avoids a dotenv dependency. Real environment variables
// always win so a deployed host can override the file.
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const PORT = Number(process.env.PORT || 3100);

/**
 * Postgres connection string. Prefer the POOLED one: serverless opens many
 * short-lived connections, and a direct connection runs out of slots fast.
 * Vercel Postgres exposes POSTGRES_URL; Neon calls it DATABASE_URL.
 */
export const DATABASE_URL =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

/** Vercel Blob store token — where uploaded documents actually live. */
export const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
export const GOOGLE_CLIENT_ID = process.env.AUTH_GOOGLE_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.AUTH_GOOGLE_SECRET || '';

/** Optional: only addresses at this domain may sign in, e.g. usaindiacfo.com */
export const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim();

/**
 * Addresses that are always admins. Anyone listed here can sign in without
 * being invited first, and is created as (or promoted to) an admin on sign-in.
 *
 * Grant-only by design: removing someone from this list does not demote them,
 * because a silent demotion on next sign-in would be a confusing way to lose
 * access. Demote through Admin -> People instead.
 */
export const ADMIN_EMAILS: string[] = (process.env.ADMIN_EMAILS || '')
  .split(/[,;\s]+/)
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.includes('@'));

/**
 * Local preview switch. When true, every request is treated as a signed-in
 * admin and Google is bypassed entirely.
 *
 * This is a hole straight through authentication, so it is opt-in, off by
 * default, and announced in the server log and the UI. Never leave it on for
 * anything reachable beyond localhost.
 */
export const DISABLE_AUTH = process.env.DISABLE_AUTH === 'true';
export const APP_NAME = 'Tax Review Center';

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';


export type ModelRole = 'reviewer' | 'extractor' | 'chat';

export const MODELS: Record<ModelRole, string> = {
  reviewer: process.env.OPENAI_REVIEW_MODEL || 'gpt-5.6-luna',
  extractor: process.env.OPENAI_EXTRACT_MODEL || 'gpt-5.6-luna',
  chat: process.env.OPENAI_CHAT_MODEL || 'gpt-5.6-luna',
};

export const EFFORT = process.env.REVIEW_EFFORT || 'high';

/** USD per million tokens. Cached input is a flat discount, no write premium. */
export const PRICING: Record<string, { in: number; out: number; cachedIn: number }> = {
  'gpt-5.6-luna': { in: 0.2, out: 1.2, cachedIn: 0.02 },
  'gpt-5.6-terra': { in: 2, out: 12, cachedIn: 0.2 },
  'gpt-5.6-sol': { in: 4, out: 20, cachedIn: 0.4 },
};

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
export const MAX_PDF_PAGES = Number(process.env.MAX_PDF_PAGES || 600);

/**
 * PII handling for text we generate ourselves.
 *   off      — send converted text as-is
 *   tokenize — replace identifiers with stable pseudonyms ([SSN-1], [EIN-2])
 *              so cross-document relationships survive but the number does not leave
 * Native PDFs and images are always sent as-is; we cannot mask pixels.
 */
export type PiiMode = 'off' | 'tokenize';
export const PII_MODE: PiiMode = process.env.PII_MODE === 'off' ? 'off' : 'tokenize';

/** Days to keep uploaded originals. 0 disables the sweeper. */
export const RETENTION_ORIGINALS_DAYS = Number(process.env.RETENTION_ORIGINALS_DAYS || 90);

