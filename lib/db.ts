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
  role         TEXT NOT NULL CHECK (role IN ('admin','member')),
  display_name TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New chat',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS usage_records (
  id                 TEXT PRIMARY KEY,
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

-- The 'reviewer' role predates this being a general assistant. Rename it in
-- place: the CHECK constraint is part of the table, so CREATE TABLE IF NOT
-- EXISTS above never revises it on a database that already has rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'users'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%reviewer%'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    UPDATE users SET role = 'member' WHERE role = 'reviewer';
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin','member'));
  END IF;
END $$;

/* ================================================================ v3 =====
   Threads become a tree, and conversations gain the settings that used to be
   global. Every statement here is additive and idempotent, so it runs on a
   populated database on a cold start exactly like the block above.
   ======================================================================== */

-- A message points at the one it answers. Siblings under the same parent are
-- alternative versions — an edited question, or a retried answer — which is
-- what makes "‹ 2/3 ›" possible without duplicating the thread.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking  TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model     TEXT;
-- 'stop' | 'length' | 'aborted' — 'length' is what earns a Continue button.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS finish    TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_log  TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS vote      INTEGER;
CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(conversation_id, parent_id);

-- head_id is the leaf the reader is currently looking at. The visible thread is
-- the walk from it back to the root, so switching branches is one UPDATE.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS head_id     TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id  TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model       TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS style       TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS thinking    TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS starred     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived_at BIGINT;
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id, updated_at DESC);

-- A project is a folder with its own instructions and its own shelf of
-- documents, both of which apply to every conversation inside it.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);

-- A file belongs to a conversation, or to a project, or to neither while it is
-- still sitting in the composer. Never to both.
ALTER TABLE files ADD COLUMN IF NOT EXISTS project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);

-- Custom writing styles. The built-in four live in lib/models.ts; only the
-- ones someone wrote themselves need a row.
CREATE TABLE IF NOT EXISTS styles (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_styles_user ON styles(user_id, created_at);

-- Facts carried between conversations. Written by the model through the
-- remember tool, always visible to the person they belong to, always deletable.
CREATE TABLE IF NOT EXISTS memories (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text                   TEXT NOT NULL,
  source_conversation_id TEXT,
  created_at             BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at DESC);

-- Per-person defaults and personal instructions, on top of the admin's house
-- text rather than instead of it.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  instructions   TEXT NOT NULL DEFAULT '',
  model          TEXT,
  style          TEXT,
  thinking       TEXT,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at     BIGINT NOT NULL
);

-- Existing threads are flat lists. Chain them into the tree shape once, then
-- record that it happened: the root of every conversation legitimately has a
-- NULL parent, so the column itself cannot tell us whether this has run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM settings WHERE key = 'migrated_message_tree') THEN
    WITH ordered AS (
      SELECT id,
             LAG(id) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS prev
        FROM messages
    )
    UPDATE messages m
       SET parent_id = o.prev
      FROM ordered o
     WHERE m.id = o.id AND o.prev IS NOT NULL;

    UPDATE conversations c
       SET head_id = (SELECT m.id FROM messages m
                       WHERE m.conversation_id = c.id
                       ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
     WHERE c.head_id IS NULL;

    INSERT INTO settings (key, value) VALUES ('migrated_message_tree', '1')
      ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

/* ================================================================ v4 =====
   Connectors: remote MCP servers whose tools the model may call.

   Firm-wide and admin-owned, like the house instructions, because a connector
   is a standing grant of access to a system rather than a personal setting.
   Nothing is exposed to the model until an admin ticks the individual tools,
   and no conversation uses one until it is switched on for that thread.
   ======================================================================== */

CREATE TABLE IF NOT EXISTS connectors (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  -- Header name and value for a static credential, e.g. Authorization /
  -- "Bearer xyz". Never sent to the browser: the admin screen reports whether
  -- a secret is set, never what it is.
  auth_header    TEXT,
  auth_value     TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  -- JSON array of tool names the admin has approved. Empty or absent means the
  -- connector contributes nothing, which is the safe reading of "not set up
  -- yet" rather than "everything".
  allowed_tools  TEXT,
  -- Cached tools/list result, refreshed from the admin screen. Discovering on
  -- every turn would add a round trip to the server before every answer.
  tools_json     TEXT,
  tools_fetched_at BIGINT,
  last_error     TEXT,
  created_by     TEXT,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connectors_enabled ON connectors(enabled);

-- Which connectors this thread may use. JSON array of ids; absent means none,
-- so a connector is never in play just because it exists.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS connectors TEXT;

/* ================================================================ v5 =====
   Connected accounts: Drive, Gmail, Box and anything else reached by signing
   in as the person rather than with a shared key.

   Per person, never shared. Two people in the same firm see their own Drive
   and nobody else's, because the token is theirs and the row is keyed by their
   user id.
   ======================================================================== */

CREATE TABLE IF NOT EXISTS oauth_accounts (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  -- Both tokens are stored encrypted; see lib/secrets.ts. A refresh token is a
  -- standing grant to read somebody mailbox, so it is the one thing in this
  -- database that must not be readable from a stolen backup alone.
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    BIGINT,
  scope         TEXT NOT NULL DEFAULT '',
  account_label TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Short-lived state for an authorisation in flight: the PKCE verifier cannot
-- live in a cookie the browser can read, and the callback needs it back.
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_to   TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states(created_at);

/* ================================================================ v6 =====
   Skills: a folder of instructions the model loads only when it applies.

   Stored here rather than read from the repo so a skill can be added or
   corrected without a deploy, and so somebody who is not a developer can add
   one at all. A firm skill belongs to everybody and is uploaded by an admin;
   a personal one belongs to the person who uploaded it and nobody else sees it.
   ======================================================================== */

-- Named agent_skills, not skills: a dead skills table survives from the
-- review era with an entirely different shape, and CREATE TABLE IF NOT EXISTS
-- would quietly do nothing while every index and query against it failed.
-- The old table is left alone; dropping it is a decision to make deliberately.
CREATE TABLE IF NOT EXISTS agent_skills (
  id          TEXT PRIMARY KEY,
  -- From the SKILL.md frontmatter. The description is the whole trigger
  -- mechanism: it is the only part in the prompt every message, and it is what
  -- the model matches a question against.
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- 'firm' applies to everybody and only an admin may add one; 'personal'
  -- belongs to user_id and is invisible to everybody else.
  scope       TEXT NOT NULL CHECK (scope IN ('firm','personal')),
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  folder      TEXT,
  created_by  TEXT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_scope ON agent_skills(scope, enabled);
CREATE INDEX IF NOT EXISTS idx_skills_user ON agent_skills(user_id);

-- The supporting files, keyed by their path inside the skill folder. Looked up
-- by exact match, which is also what makes path traversal impossible: there is
-- no filesystem to escape from.
CREATE TABLE IF NOT EXISTS agent_skill_files (
  skill_id   TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  content    TEXT NOT NULL,
  bytes      BIGINT NOT NULL,
  PRIMARY KEY (skill_id, path)
);

-- Skills pinned to a conversation: loaded in full up front rather than left for
-- the model to notice. JSON array of skill ids; absent means none pinned, and
-- the automatic route still applies.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS skills TEXT;
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
