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
// DATA_DIR is deliberately allowed to point outside the project (client tax
// documents should not live in the repo), so the path cannot be statically
// scoped. The ignore comment stops Turbopack tracing the whole project.
export const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ ROOT, process.env.DATA_DIR || 'data');
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export const GOOGLE_CLIENT_ID = process.env.AUTH_GOOGLE_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.AUTH_GOOGLE_SECRET || '';

/** Optional: only addresses at this domain may sign in, e.g. usaindiacfo.com */
export const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim();

/** Optional: pins who the very first sign-in may bootstrap as admin. */
export const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim();

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

/** Which provider serves reviews. Everything else adapts to this one value. */
export type ProviderName = 'anthropic' | 'openai';
export const AI_PROVIDER: ProviderName =
  process.env.AI_PROVIDER === 'anthropic' ? 'anthropic' : 'openai';

export type ModelRole = 'reviewer' | 'extractor' | 'chat';

const ANTHROPIC_MODELS: Record<ModelRole, string> = {
  reviewer: process.env.REVIEW_MODEL || 'claude-opus-5',
  extractor: process.env.EXTRACT_MODEL || 'claude-sonnet-5',
  chat: process.env.CHAT_MODEL || 'claude-opus-5',
};

const OPENAI_MODELS: Record<ModelRole, string> = {
  reviewer: process.env.OPENAI_REVIEW_MODEL || 'gpt-5.6-luna',
  extractor: process.env.OPENAI_EXTRACT_MODEL || 'gpt-5.6-luna',
  chat: process.env.OPENAI_CHAT_MODEL || 'gpt-5.6-luna',
};

export const MODELS: Record<ModelRole, string> =
  AI_PROVIDER === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS;

export const EFFORT = process.env.REVIEW_EFFORT || 'high';

/**
 * USD per million tokens, plus the multiplier applied to cached input.
 * Anthropic: cache reads 0.1x, 5-minute writes 1.25x.
 * OpenAI: cached input is a flat discount, no write premium.
 */
export const PRICING: Record<string, { in: number; out: number; cachedIn: number }> = {
  'claude-opus-5': { in: 5, out: 25, cachedIn: 0.5 },
  'claude-sonnet-5': { in: 2, out: 10, cachedIn: 0.2 },
  'claude-haiku-4-5': { in: 1, out: 5, cachedIn: 0.1 },
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

/** Refuse to start if client tax documents would land in a synced folder. */
export function assertSafeDataDir(): void {
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer || '';
  if (!oneDrive) return;
  const normalized = path.resolve(/*turbopackIgnore: true*/ DATA_DIR).toLowerCase();
  if (normalized.startsWith(path.resolve(/*turbopackIgnore: true*/ oneDrive).toLowerCase())) {
    throw new Error(
      `Refusing to start: DATA_DIR (${DATA_DIR}) is inside OneDrive (${oneDrive}). ` +
        `Client tax documents would sync to the cloud. Set DATA_DIR in .env to a path outside OneDrive.`,
    );
  }
}
