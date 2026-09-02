import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, assertSafeDataDir } from './config';

// Next.js hot-reloads modules in dev, which would open a new handle every time
// and eventually lock the file. Keep one connection on globalThis.
const globalForDb = globalThis as unknown as { __trcDb?: DatabaseSync };

function openDatabase(): DatabaseSync {
  assertSafeDataDir();
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

  const conn = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  // busy_timeout must be set before anything that needs a write lock, so a
  // concurrent opener waits instead of failing outright.
  conn.exec(`PRAGMA busy_timeout = 10000`);
  conn.exec(`PRAGMA journal_mode = WAL`);
  conn.exec(`PRAGMA foreign_keys = ON`);
  migrate(conn);
  return conn;
}

/**
 * Opened on first query, never at import time.
 *
 * `next build` collects page data with a worker per route; if importing a route
 * module opened the database, every worker would race to run migrations at once
 * and the build would die with SQLITE_BUSY. Building imports modules but issues
 * no queries, so deferring the open removes the race entirely.
 */
function db(): DatabaseSync {
  if (!globalForDb.__trcDb) globalForDb.__trcDb = openDatabase();
  return globalForDb.__trcDb;
}

/**
 * CREATE TABLE IF NOT EXISTS silently does nothing when the table already
 * exists, so new columns need an explicit ALTER. Without this, upgrading an
 * existing install leaves the app querying columns that are not there.
 */
function ensureColumn(
  conn: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] added ${table}.${column}`);
}

function migrate(conn: DatabaseSync): void {
  conn.exec(`
-- Identity comes from Google; this table is the allowlist and the role store.
-- There is no password column: an admin adds someone by email, and Google
-- proves they are that address.
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('admin','reviewer')),
  display_name TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New review',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL DEFAULT '',
  review_id       TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  TEXT,
  filename         TEXT NOT NULL,
  mime             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  storage_path     TEXT NOT NULL,
  page_count       INTEGER,
  extracted_text   TEXT,
  pii_counts       TEXT,
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER
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
  created_by      TEXT REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  model           TEXT NOT NULL,
  skill_ids       TEXT NOT NULL DEFAULT '[]',
  pass_a_text     TEXT,
  summary         TEXT,
  error_text      TEXT,
  extraction_ok   INTEGER NOT NULL DEFAULT 0,
  cost_micros     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id, created_at DESC);

-- Which files a review actually read, in the order they were sent. This is the
-- real file/conversation association: a file row can be shared by dedupe across
-- conversations, so conversation_id on files alone cannot answer "what did this
-- review look at" or "what should a follow-up turn re-send".
CREATE TABLE IF NOT EXISTS review_files (
  review_id      TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  file_id        TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  document_index INTEGER NOT NULL,
  PRIMARY KEY (review_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_review_files_file ON review_files(file_id);

-- Every streamed chunk of a review, so a browser that refreshes (or crashes,
-- or sleeps) can replay from where it left off instead of losing the run.
-- The integer primary key doubles as the replay cursor.
CREATE TABLE IF NOT EXISTS stream_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_find_review ON findings(review_id, ordinal);

CREATE TABLE IF NOT EXISTS usage_records (
  id                 TEXT PRIMARY KEY,
  review_id          TEXT,
  user_id            TEXT,
  purpose            TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros        INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_records(user_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`);

  // Additive migrations for installs created before these columns existed.
  ensureColumn(conn, 'files', 'pii_counts', 'TEXT');
  ensureColumn(conn, 'files', 'deleted_at', 'INTEGER');

  dropPasswordAuth(conn);
}

/**
 * Removes the password-era schema. The users table used to carry a NOT NULL
 * password_hash plus MFA columns; inserting a Google-authenticated user into
 * that table would fail the constraint, so the table is rebuilt rather than
 * patched (SQLite cannot drop a NOT NULL in place).
 */
function dropPasswordAuth(conn: DatabaseSync): void {
  const columns = conn.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === 'password_hash')) return;

  console.log('[db] migrating users off password auth');
  conn.exec(`PRAGMA foreign_keys = OFF`);
  conn.exec(`
    CREATE TABLE users_migrated (
      id           TEXT PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      role         TEXT NOT NULL CHECK (role IN ('admin','reviewer')),
      display_name TEXT NOT NULL,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL
    );
    INSERT INTO users_migrated (id, email, role, display_name, is_active, created_at)
      SELECT id, email, role, display_name, is_active, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_migrated RENAME TO users;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS mfa_challenges;
    DROP TABLE IF EXISTS mfa_recovery_codes;
  `);
  conn.exec(`PRAGMA foreign_keys = ON`);
}

/* ------------------------------------------------------------ helpers */

// node:sqlite's own SupportedValueType is not exported by every @types/node
// release, so bind the accepted set locally.
type Param = string | number | bigint | null | Uint8Array;

export function one<T>(sql: string, ...params: Param[]): T | null {
  return (db().prepare(sql).get(...params) as T | undefined) ?? null;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: Param[]) {
  return db().prepare(sql).run(...params);
}

export function getSetting(key: string, fallback: string): string {
  const row = one<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key);
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string | number): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    String(value),
  );
}

export function audit(
  actorId: string | null,
  action: string,
  targetType?: string | null,
  targetId?: string | null,
  detail?: unknown,
): void {
  run(
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
