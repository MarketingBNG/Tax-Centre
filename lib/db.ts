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

/* ================================================================ v7 =====
   The review engine: engagements, immutable runs, and the findings register.

   Every table here is prefixed engagements_/review_/run_ deliberately. A dead
   set of tables — reviews, review_files, findings, citations, stream_events —
   survives in production from the review era with entirely different shapes,
   and CREATE TABLE IF NOT EXISTS against those names would silently do nothing
   while every query below failed. Same reasoning as agent_skills above.

   Two rules are enforced by the shape of the schema rather than by discipline:

     - Severity is written only by lib/review-engine/severity.ts, from a
       defect_kind the model supplies. The model states what is wrong; code
       decides how bad it is, so two reviewers a season apart get the same
       answer to the same fact.

     - "High-flag" — the sixth category on the summary page — has no column.
       It is severity IN ('Critical','High') and nothing else. Storing it would
       create a second source of truth that could drift from the first.

   The "who did this" columns — created_by, approved_by, answered_by — carry no
   foreign key to users, for the same reason audit_log.actor_id does not: they
   record what happened, and an approval must survive the approver leaving the
   firm. A cascade would erase the sign-off along with the account, and a
   blocking reference would make removing somebody fail instead.
   ======================================================================== */

-- The client and return under review. A series of runs hangs off this row, so
-- identity stays put while the runs that examine it come and go.
CREATE TABLE IF NOT EXISTS engagements (
  id            TEXT PRIMARY KEY,
  -- Free text until there is a clients table to point at.
  client_label  TEXT NOT NULL,
  entity_name   TEXT,
  -- Tokenised where PII_MODE=tokenize, exactly as it is in extracted document
  -- text, so a Stage 0 comparison between the two still matches.
  ein           TEXT,
  return_type   TEXT,
  tax_year      INTEGER,
  period_start  TEXT,
  period_end    TEXT,
  short_year    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagements_created ON engagements(created_at DESC);

-- Facts about the engagement that drive which stages run: india_link, the
-- jurisdiction list, a foreign owner's percentage. Superseded rather than
-- edited, because a run records the facts it saw and a later correction must
-- not rewrite what an earlier run was judged on.
CREATE TABLE IF NOT EXISTS engagement_facts (
  id               TEXT PRIMARY KEY,
  engagement_id    TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  -- JSON scalar or array.
  value            TEXT NOT NULL,
  -- Where the fact came from: typed in, read by Stage 0, or supplied as the
  -- answer to a question. An answered fact is the only one that can close a
  -- finding, which is why the provenance is a column and not a comment.
  source           TEXT NOT NULL CHECK (source IN ('user','stage0','answer')),
  evidence_file_id TEXT,
  confidence       DOUBLE PRECISION,
  superseded_by    TEXT,
  created_by       TEXT,
  created_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engfacts_current
  ON engagement_facts(engagement_id, key) WHERE superseded_by IS NULL;

-- One run. run_number is the version the team talks about ("run 2 cleared it").
-- Nothing the pipeline wrote is ever edited: a correction is a new run, so the
-- diff between two runs is a fact rather than a reconstruction.
CREATE TABLE IF NOT EXISTS review_runs (
  id               TEXT PRIMARY KEY,
  engagement_id    TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  run_number       INTEGER NOT NULL,
  parent_run_id    TEXT,
  status           TEXT NOT NULL CHECK (status IN
                     ('blocked_inputs','pending','running','halted','complete','failed','cancelled')),
  -- Why a halted run stopped, e.g. 'critical_finding:S0-001'.
  halt_reason      TEXT,
  prompt_version   TEXT NOT NULL,
  model            TEXT NOT NULL,
  -- Hash over the documents, the facts snapshot, the skill content and the
  -- prompt version. Two runs with the same corpus_hash saw the same world.
  corpus_hash      TEXT NOT NULL,
  facts_snapshot   TEXT NOT NULL,
  -- Bumped by every mutation to a finding or a question. An approval names the
  -- version it saw, so approval currency is a comparison rather than a flag
  -- somebody has to remember to clear.
  register_version INTEGER NOT NULL DEFAULT 1,
  verdict          TEXT CHECK (verdict IN ('clear','release_with_conditions','hold')),
  verdict_json     TEXT,
  -- The request that asks for a stop will not reach the instance running the
  -- stage, so the stop travels through the database instead.
  abort_requested  INTEGER NOT NULL DEFAULT 0,
  heartbeat_at     BIGINT,
  created_by       TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  started_at       BIGINT,
  finished_at      BIGINT,
  error_text       TEXT,
  UNIQUE (engagement_id, run_number)
);
CREATE INDEX IF NOT EXISTS idx_runs_engagement
  ON review_runs(engagement_id, run_number DESC);

-- Exactly which files this run read, and in what role. This is inputs_received[]
-- in the output schema, and it is what corpus_hash covers.
CREATE TABLE IF NOT EXISTS run_documents (
  run_id            TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  file_id           TEXT NOT NULL REFERENCES files(id),
  doc_role          TEXT NOT NULL,
  document_index    INTEGER NOT NULL,
  -- Which ReturnData parser read it. 'model-visual' is today's only answer; a
  -- structured Drake export parser will name itself here, and the confidence
  -- it reports is what routes a doubtful field to a human instead of a guess.
  parser_id         TEXT NOT NULL DEFAULT 'model-visual',
  parser_confidence DOUBLE PRECISION,
  PRIMARY KEY (run_id, file_id)
);

-- The unit of durability. A stage is one-to-few model calls, which fits inside
-- a serverless invocation; a whole review does not. Resuming a run is just
-- claiming the next pending row, so a closed browser or a killed instance
-- costs at most the stage that was in flight.
CREATE TABLE IF NOT EXISTS run_stages (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  -- S0, S1, S2, S3-FED, S3-INTL, S3-STATE, S3-INDIA, S4.
  stage_key             TEXT NOT NULL,
  seq                   INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN
                          ('pending','running','complete','failed','skipped',
                           'not_applicable','carried_forward')),
  attempt               INTEGER NOT NULL DEFAULT 0,
  -- Documents, facts and skill content this stage saw. A re-run compares it to
  -- decide whether the stage has to run again or can be carried forward.
  input_hash            TEXT,
  carried_from_stage_id TEXT,
  model                 TEXT,
  raw_output            TEXT,
  usage_json            TEXT,
  cost_micros           BIGINT,
  heartbeat_at          BIGINT,
  started_at            BIGINT,
  finished_at           BIGINT,
  error_text            TEXT,
  UNIQUE (run_id, stage_key)
);
CREATE INDEX IF NOT EXISTS idx_runstages_next ON run_stages(run_id, seq);

-- The findings register. The model fills in the prose and the pointers; code
-- fills in finding_code, severity and category.
CREATE TABLE IF NOT EXISTS run_findings (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  stage_key      TEXT NOT NULL,
  -- S1-001, S3-006 — assigned in code, sequential within a stage.
  finding_code   TEXT NOT NULL,
  -- 'agreed' is a checked-and-fine line and 'coverage' records what could not
  -- be reached. Both exist because a reviewer who sees a silent section cannot
  -- tell whether it was clean or skipped.
  kind           TEXT NOT NULL CHECK (kind IN ('exception','agreed','coverage')),
  -- The model's statement of what sort of defect this is. It is the only input
  -- to the severity tree, and it is deliberately a closed vocabulary.
  defect_kind    TEXT CHECK (defect_kind IN
                   ('wrong_amount','wrong_classification','missing_form','wrong_entity_type',
                    'unsupported_position','unexplained_tieout_failure','missing_evidence',
                    'presentation')),
  -- Null on 'agreed' lines. Never written from model output.
  severity       TEXT CHECK (severity IN ('Critical','High','Medium','Low')),
  -- bookkeeping | financial | irs_return | cross_border | transfer_pricing.
  -- Mapped from the producing stage, so the summary can group without a second
  -- classification pass.
  category       TEXT NOT NULL,
  title          TEXT NOT NULL,
  what_is_wrong  TEXT NOT NULL,
  why_it_matters TEXT,
  -- {form, schedule, line, gl_account}
  location_json  TEXT,
  -- {where, change, then, why} — written for a novice Drake operator.
  fix_json       TEXT,
  authority_status TEXT NOT NULL DEFAULT 'none_required'
                   CHECK (authority_status IN ('none_required','grounded','verify')),
  authority_citation    TEXT,
  authority_source_span TEXT,
  -- What the model tried to cite before the gate demoted it. Kept so a pattern
  -- of invented authority is visible rather than merely discarded.
  claimed_citation TEXT,
  -- [{file_id, description, where}]
  evidence_json  TEXT,
  -- [{label, value, source_kind, source_ref, verified}] — every figure carries
  -- where it came from, because a number with no source must not reach a
  -- register at all.
  amounts_json   TEXT,
  owner          TEXT CHECK (owner IN ('preparer','reviewer','client')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN
                   ('open','answered_pending_evidence','answered','closed','changed',
                    'escalated','client')),
  status_note    TEXT,
  confidence     DOUBLE PRECISION,
  question_id    TEXT,
  -- Stable-ish identity across runs, so run 2 can say "this is the same finding
  -- you saw in run 1" even though finding codes are per-run sequential.
  lineage_key    TEXT,
  carried_from_finding_id TEXT,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  -- A citation exists only when something grounded it. With no corpus wired up
  -- yet, 'grounded' is unreachable and this constraint is what guarantees a
  -- plausible-looking code section cannot be stored as authority.
  CHECK (authority_citation IS NULL OR authority_status = 'grounded'),
  UNIQUE (run_id, finding_code)
);
CREATE INDEX IF NOT EXISTS idx_runfindings_run ON run_findings(run_id, stage_key, finding_code);
CREATE INDEX IF NOT EXISTS idx_runfindings_open ON run_findings(run_id, severity, status);

-- The tie-outs the summary shows as a row of ticks. Stored separately from
-- findings because a passing tie-out is not a finding but still has to be
-- visible — that is the whole point of the strip.
CREATE TABLE IF NOT EXISTS run_tie_outs (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  stage_key   TEXT NOT NULL,
  name        TEXT NOT NULL,
  left_value  DOUBLE PRECISION,
  right_value DOUBLE PRECISION,
  left_source  TEXT,
  right_source TEXT,
  agrees      INTEGER NOT NULL,
  finding_id  TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtieouts_run ON run_tie_outs(run_id);

-- Every calculation the sandbox ran, kept with the numbers it produced. This is
-- what makes "the model did not originate this figure" checkable rather than
-- merely instructed: an amount sourced to the calculation layer has to match a
-- value in one of these rows.
CREATE TABLE IF NOT EXISTS run_calcs (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  stage_key   TEXT NOT NULL,
  explanation TEXT,
  code        TEXT NOT NULL,
  output      TEXT NOT NULL,
  values_json TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runcalcs_run ON run_calcs(run_id);

-- The 5-10 questions for the preparer. An answer arrives here; whether it is
-- enough to close the finding is decided in code, not by the person typing.
CREATE TABLE IF NOT EXISTS run_questions (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  question_code TEXT NOT NULL,
  finding_id    TEXT,
  owner         TEXT NOT NULL CHECK (owner IN ('preparer','client')),
  question      TEXT NOT NULL,
  figure        TEXT,
  -- [{if, then}] — what follows from each possible answer, so the preparer can
  -- see the consequence before answering.
  branches_json TEXT,
  evidence_needed TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','ignored')),
  answer_kind   TEXT CHECK (answer_kind IN ('fact','document','yes_no','text')),
  answer_text   TEXT,
  -- JSON array of files.id.
  answer_evidence_file_ids TEXT,
  answered_by   TEXT,
  answered_at   BIGINT,
  -- An unanswered question carried into the next run, so "asked twice and never
  -- answered" is visible instead of quietly disappearing.
  carried_from_question_id TEXT,
  created_at    BIGINT NOT NULL,
  UNIQUE (run_id, question_code)
);
CREATE INDEX IF NOT EXISTS idx_runquestions_run ON run_questions(run_id, question_code);

-- Append-only. The current approval is the newest row whose register_version_seen
-- still matches the run's register_version; when a finding changes, the version
-- moves and the approval stops being current on its own. Nothing is deleted, so
-- "who signed this off, and what did they see" survives every later edit.
CREATE TABLE IF NOT EXISTS run_approvals (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  approved_by           TEXT NOT NULL,
  approved_at           BIGINT NOT NULL,
  register_version_seen INTEGER NOT NULL,
  verdict_seen          TEXT NOT NULL,
  note                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_runapprovals_run ON run_approvals(run_id, approved_at DESC);

-- Progress, kept so a reconnecting tab can replay what it missed and a second
-- viewer can watch a run somebody else started. Read by cursor, pruned when the
-- run ends.
CREATE TABLE IF NOT EXISTS run_events (
  id         BIGSERIAL PRIMARY KEY,
  run_id     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runevents ON run_events(run_id, id);

/* ================================================================ v8 =====
   The authority corpus.

   Rule 2 says a citation is either grounded in retrieved text or absent. Until
   there was something to retrieve from, "absent" was the only reachable state
   and every citation the model offered was demoted. These two tables are what
   makes the other half possible: text the firm has loaded, addressed by
   citation, so a reference on a finding can be checked against the words it
   claims to be quoting rather than accepted for looking like a citation.

   Nothing seeds them. What goes in is what the firm loads — form instructions,
   its own SOPs, whatever statutory text it is licensed to hold — and a citation
   outside that is still refused. A small corpus that is genuinely checked beats
   a large one that is assumed.

   Dating is mandatory, not decorative. Tax authority is time-bound: a March
   review and a September review of the same year can need different states of
   the same section. Every source carries the date it took effect and the date
   it was retrieved, a run records the corpus date it read against, and a source
   with no effective date cannot be loaded at all — an undated snapshot is
   exactly what item 15 of the brief refuses.
*/

CREATE TABLE IF NOT EXISTS corpus_sources (
  id             TEXT PRIMARY KEY,
  -- irc | treas_reg | form_instructions | irs_pub | firm_sop | india_act | other
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  -- The citation this source is authoritative for, normalised: "irc-162",
  -- "treasreg-1.162-1", "inst-1065". A lookup starts here.
  citation_root  TEXT NOT NULL,
  -- What edition this is, in the publisher's own words.
  version_label  TEXT,
  -- Epoch ms. Both required: a source that might not have been in force when
  -- the return was filed is not authority for that return.
  effective_from BIGINT NOT NULL,
  effective_to   BIGINT,
  retrieved_at   BIGINT NOT NULL,
  source_url     TEXT,
  content_hash   TEXT NOT NULL,
  created_by     TEXT,
  created_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corpussources_root
  ON corpus_sources(citation_root, effective_from DESC);

-- The retrievable unit. One passage is what a finding's source_span points at,
-- and the text is stored verbatim so a grounded citation can be checked to the
-- word by whoever reads the workpaper.
CREATE TABLE IF NOT EXISTS corpus_passages (
  id        TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_sources(id) ON DELETE CASCADE,
  -- As a person writes it: "IRC 162(a)(1)", "Treas. Reg. 1.162-1(a)".
  citation  TEXT NOT NULL,
  -- The same, normalised for matching.
  citation_key TEXT NOT NULL,
  heading   TEXT,
  body      TEXT NOT NULL,
  ordinal   INTEGER NOT NULL,
  UNIQUE (source_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_corpuspassages_key ON corpus_passages(citation_key);

/* ================================================================ v9 =====
   Books imports, normalised.

   Item 3 of the guidance: every Stage 1 check is written once against the
   firm-standard keys in lib/review-engine/chart-of-accounts.ts rather than once
   per source system. Item 4: an import is version-stamped, because a finding
   questioned six months later has to be answerable with "this is exactly the
   data the review saw".

   The source line is kept beside the mapped key on purpose. A preparer cannot
   act on "the trade receivables key is wrong" when their screen says
   1200 Sundry Debtors, so a finding quotes the client's own account and the
   platform keeps the translation to itself.

   Where an account could not be mapped, mapped_key is null and mapping_reason
   says why. Nothing is forced into the nearest key: a receivable quietly filed
   as revenue is worse than a line somebody has to look at.
*/

CREATE TABLE IF NOT EXISTS books_imports (
  id            TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  -- spreadsheet | tally | quickbooks | zoho | xero
  source_system TEXT NOT NULL,
  -- The file id, or the connector's own identifier for what was pulled.
  source_ref    TEXT,
  period_start  TEXT,
  period_end    TEXT,
  -- When the data was taken out of the source system, which is not when it was
  -- imported here and not the period it covers. All three are needed to say
  -- what the review saw.
  extracted_at  BIGINT NOT NULL,
  row_count     INTEGER NOT NULL,
  unmapped_count INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL,
  imported_by   TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booksimports_engagement
  ON books_imports(engagement_id, extracted_at DESC);

CREATE TABLE IF NOT EXISTS books_accounts (
  id               TEXT PRIMARY KEY,
  import_id        TEXT NOT NULL REFERENCES books_imports(id) ON DELETE CASCADE,
  -- Exactly as it arrived, so a finding can quote the client's own books.
  source_code      TEXT,
  source_name      TEXT NOT NULL,
  balance_cents    BIGINT,
  -- Null where nothing matched; mapping_reason then explains it.
  mapped_key       TEXT,
  mapped_confidence DOUBLE PRECISION,
  mapping_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_booksaccounts_import ON books_accounts(import_id);

-- Which state of the corpus a run read against, so the run is reproducible.
-- Added rather than folded into the v7 block above, because review_runs may
-- already exist wherever this has been deployed.
ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS corpus_as_of      BIGINT;
ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS corpus_fingerprint TEXT;
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
