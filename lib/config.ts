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
export { APP_NAME } from './app';

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';


export type ModelRole = 'chat';

export const MODELS: Record<ModelRole, string> = {
  chat: process.env.OPENAI_CHAT_MODEL || 'gpt-5.6-luna',
};

export const EFFORT = process.env.MODEL_EFFORT || process.env.REVIEW_EFFORT || 'medium';

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


/** Ceiling on a single answer. A cut-off answer is offered a Continue button. */
export const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 16000);

/**
 * How many times the model may call tools and be asked again within one turn.
 * The whole turn shares one 300s request budget on Vercel, so this is a real
 * ceiling rather than a formality.
 */
export const MAX_TOOL_ROUNDS = Number(process.env.MAX_TOOL_ROUNDS || 4);

/** Wall-clock ceiling on one analysis script. Synchronous code only. */
export const ANALYSIS_TIMEOUT_MS = Number(process.env.ANALYSIS_TIMEOUT_MS || 5000);

/** Most remembered facts to carry into a conversation, newest first. */
export const MEMORY_LIMIT = Number(process.env.MEMORY_LIMIT || 60);

/** Set false to remove the analysis and memory tools everywhere. */
export const TOOLS_ENABLED = process.env.TOOLS_ENABLED !== 'false';

/** How long one connector request may take before it is abandoned. */
export const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || 30000);

/**
 * Set false to remove every connector from every conversation without
 * deleting the configuration — the switch to reach for if one misbehaves.
 */
export const CONNECTORS_ENABLED = process.env.CONNECTORS_ENABLED !== 'false';

/* ------------------------------------------------------- the review engine */

/**
 * Stamped on every run, and part of its corpus hash.
 *
 * Bump it whenever the stage prompts change in a way that would make two runs
 * incomparable. A finding questioned six months from now has to be explainable
 * by what the engine was at the time, not by what it is today.
 */
export const REVIEW_PROMPT_VERSION = process.env.REVIEW_PROMPT_VERSION || 'trr-1.0';

/** The model a review runs on. Reviews default higher than chat does. */
export const REVIEW_MODEL = process.env.REVIEW_MODEL || 'gpt-5.6-terra';

/**
 * Below this, a finding goes to a human instead of onto the register as fact.
 *
 * Validation rule 8: it routes to the escalated queue and never quietly
 * downgrades the severity. A system that defers 15% of the time beats one that
 * is confidently wrong 5% of the time, because the 5% is invisible.
 */
export const REVIEW_CONFIDENCE_THRESHOLD = Number(
  process.env.REVIEW_CONFIDENCE_THRESHOLD || 0.7,
);

/**
 * Whether a verified corpus of primary authority exists to cite against.
 *
 * There is none yet, so this stays false and `authority.status = 'grounded'` is
 * unreachable: a citation the model produces is recorded as claimed and the
 * finding states the principle in plain English instead. Turning this on
 * without building the retrieval behind it would re-open exactly the failure
 * mode Rule 2 exists to close.
 */
export const CITATION_CORPUS_ENABLED = process.env.CITATION_CORPUS_ENABLED === 'true';

/** Tool rounds one review stage may take. Higher than chat: a stage alternates
 *  calculation and recording, and four rounds is not enough to finish. */
export const REVIEW_MAX_TOOL_ROUNDS = Number(process.env.REVIEW_MAX_TOOL_ROUNDS || 12);

/**
 * Ceiling on one review, in US dollars.
 *
 * A review re-sends the documents once per stage. The prefix is identical
 * across stages so most of that is charged at the cached rate, but a large
 * return with a retrying stage is still the one place this project could spend
 * real money without anybody noticing. Hitting the ceiling stops the run with
 * a plain message rather than continuing quietly.
 */
export const REVIEW_COST_CEILING_USD = Number(process.env.REVIEW_COST_CEILING_USD || 8);
