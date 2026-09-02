import 'server-only';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { DATABASE_URL } from './config';

/**
 * Postgres, reached through a connection pooler.
 *
 * `prepare: false` is required: pgbouncer in transaction mode (which Neon and
 * Vercel Postgres both use) cannot support server-side prepared statements, and
 * leaving it on produces intermittent "prepared statement already exists"
 * errors under concurrency rather than a clean failure.
 *
 * The pool is created lazily and cached on globalThis so Next's dev-time module
 * reloading — and serverless instance reuse — do not open a new one per request.
 */
const globalForDb = globalThis as unknown as {
  __trcSql?: postgres.Sql;
  __trcMigrated?: Promise<void>;
};

function connect(): postgres.Sql {
  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Create a Postgres database (Vercel → Storage → ' +
        'Postgres, or neon.tech) and put its pooled connection string in .env.',
    );
  }
  return postgres(DATABASE_URL, {
    prepare: false,
    // Serverless invocations are short-lived; a small ceiling avoids exhausting
    // the pooler when several run at once.
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
    // Schema setup uses IF NOT EXISTS, so every cold start logs a NOTICE per
    // existing index. Nothing is wrong; just don't print it.
    onnotice: () => {},
  });
}

export function sql(): postgres.Sql {
  if (!globalForDb.__trcSql) globalForDb.__trcSql = connect();
  return globalForDb.__trcSql;
}

/* ---------------------------------------------------------------- schema */

const SCHEMA = `
-- Identity comes from Google; this table is the allowlist and the role store.
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('admin','reviewer')),
  display_name TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New review',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL DEFAULT '',
  review_id       TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

-- storage_path holds a private blob pathname, not a URL: a public blob URL is
-- itself a capability and would route around the ownership checks.
CREATE TABLE IF NOT EXISTS files (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  TEXT,
  filename         TEXT NOT NULL,
  mime             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  size_bytes       BIGINT NOT NULL,
  sha256           TEXT NOT NULL,
  storage_path     TEXT NOT NULL,
  page_count       INTEGER,
  extracted_text   TEXT,
  pii_counts       TEXT,
  created_at       BIGINT NOT NULL,
  deleted_at       BIGINT
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(user_id, sha256);

CREATE TABLE IF NOT EXISTS skills (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  jurisdiction    TEXT NOT NULL DEFAULT 'generic',
  body            TEXT NOT NULL,
  source_filename TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  enabled         INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 100,
  token_estimate  INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

-- abort_requested replaces the in-process registry the single-server build
-- used: on serverless a Stop request almost never lands on the instance running
-- the review, so the signal has to travel through shared storage.
CREATE TABLE IF NOT EXISTS reviews (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           TEXT NOT NULL,
  model            TEXT NOT NULL,
  skill_ids        TEXT NOT NULL DEFAULT '[]',
  pass_a_text      TEXT,
  summary          TEXT,
  error_text       TEXT,
  extraction_ok    INTEGER NOT NULL DEFAULT 0,
  cost_micros      BIGINT NOT NULL DEFAULT 0,
  abort_requested  INTEGER NOT NULL DEFAULT 0,
  heartbeat_at     BIGINT,
  created_at       BIGINT NOT NULL,
  finished_at      BIGINT
);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

CREATE TABLE IF NOT EXISTS review_files (
  review_id      TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  file_id        TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  document_index INTEGER NOT NULL,
  PRIMARY KEY (review_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_review_files_file ON review_files(file_id);

CREATE TABLE IF NOT EXISTS stream_events (
  id         BIGSERIAL PRIMARY KEY,
  review_id  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stream_review ON stream_events(review_id, id);

CREATE TABLE IF NOT EXISTS citations (
  id             TEXT PRIMARY KEY,
  review_id      TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  marker         TEXT NOT NULL,
  document_index INTEGER NOT NULL,
  document_title TEXT,
  file_id        TEXT,
  cited_text     TEXT NOT NULL DEFAULT '',
  start_page     INTEGER,
  end_page       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cit_review ON citations(review_id);

CREATE TABLE IF NOT EXISTS findings (
  id                 TEXT PRIMARY KEY,
  review_id          TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL,
  severity           TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT '',
  form_code          TEXT,
  line_ref           TEXT,
  title              TEXT NOT NULL,
  detail             TEXT NOT NULL DEFAULT '',
  recommended_action TEXT NOT NULL DEFAULT '',
  confidence         TEXT NOT NULL DEFAULT 'medium',
  pages              TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'open',
  created_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_find_review ON findings(review_id, ordinal);

CREATE TABLE IF NOT EXISTS usage_records (
  id                 TEXT PRIMARY KEY,
  review_id          TEXT,
  user_id            TEXT,
  purpose            TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micros        BIGINT NOT NULL DEFAULT 0,
  created_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_records(user_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          BIGINT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

-- A skill is firm methodology, not personal property: it must outlive whoever
-- published it. Without ON DELETE SET NULL the reference blocks deleting that
-- account entirely. Guarded so the lock is only taken when the constraint is
-- actually wrong (confdeltype 'n' means SET NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'skills'
      AND c.conname = 'skills_created_by_fkey'
      AND c.confdeltype = 'n'
  ) THEN
    ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_created_by_fkey;
    ALTER TABLE skills ADD CONSTRAINT skills_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
`;

/**
 * Runs once per process. Every query awaits this, so a cold start cannot race a
 * half-built schema — and because every statement is IF NOT EXISTS, several
 * instances starting at once is harmless.
 */
function migrate(): Promise<void> {
  if (!globalForDb.__trcMigrated) {
    globalForDb.__trcMigrated = sql()
      .unsafe(SCHEMA)
      .then(() => undefined)
      .catch((err) => {
        // Let the next request retry rather than caching a failure forever.
        globalForDb.__trcMigrated = undefined;
        throw err;
      });
  }
  return globalForDb.__trcMigrated;
}

/* --------------------------------------------------------------- helpers */

export type Param = string | number | boolean | null;

/**
 * Queries keep the `?` placeholder style the app was written with and are
 * rewritten to Postgres's `$1, $2` here, so sixty-odd call sites did not have
 * to be edited twice.
 */
function toPositional(query: string): string {
  let n = 0;
  return query.replace(/\?/g, () => `$${++n}`);
}

export async function one<T>(query: string, ...params: Param[]): Promise<T | null> {
  await migrate();
  const rows = await sql().unsafe(toPositional(query), params as never[]);
  return (rows[0] as T | undefined) ?? null;
}

export async function all<T>(query: string, ...params: Param[]): Promise<T[]> {
  await migrate();
  const rows = await sql().unsafe(toPositional(query), params as never[]);
  return rows as unknown as T[];
}

export async function run(query: string, ...params: Param[]): Promise<void> {
  await migrate();
  await sql().unsafe(toPositional(query), params as never[]);
}

export async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await one<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key);
  return row ? row.value : fallback;
}

export async function setSetting(key: string, value: string | number): Promise<void> {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    key,
    String(value),
  );
}

export async function audit(
  actorId: string | null,
  action: string,
  targetType?: string | null,
  targetId?: string | null,
  detail?: unknown,
): Promise<void> {
  await run(
    `INSERT INTO audit_log (id, at, actor_id, action, target_type, target_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    Date.now(),
    actorId,
    action,
    targetType ?? null,
    targetId ?? null,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

/** True when a Postgres connection string is configured. */
export const isDatabaseConfigured = (): boolean => Boolean(DATABASE_URL);
