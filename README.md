# Assistant

An internal AI assistant for USAIndiaCFO. Claude-style chat interface: sign in with a
work Google account, ask anything, attach documents and ask about those. An admin sets
house instructions once and they apply to everyone.

Next.js 16 (App Router) · React 19 · Tailwind 4 · TypeScript · Postgres · Vercel Blob

Runs on **OpenAI `gpt-5.6-luna`**. PDFs and scans are read natively.

> This was previously the Tax Review Center. The two-pass review pipeline, findings
> and severity taxonomy are gone; auth, admin, usage accounting, uploads, retention
> and PII tokenisation carried over unchanged.

## Start it

```bash
npm install
npm run dev          # http://localhost:3100
```

Four values go in `.env` — it has step-by-step instructions inside:

```
OPENAI_API_KEY=sk-...                 # platform.openai.com/api-keys
DATABASE_URL=postgres://...           # pooled connection string
BLOB_READ_WRITE_TOKEN=vercel_blob_... # Vercel → Storage → Blob
AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET   # console.cloud.google.com/apis/credentials
```

The Google OAuth client needs this exact redirect URI:

```
http://localhost:3100/api/auth/callback/google
```

Everyone in `ADMIN_EMAILS` can sign in immediately and is an admin. Admins then add
everyone else by email under **Admin → People**.

For production: `npm run build && npm start`.

> Port 3000 is used by other projects on this machine, so this defaults to **3100**.

## Deploying to Vercel

Two managed pieces rather than a local disk:

| Concern | Where it lives | Why |
|---|---|---|
| Database | Postgres (Vercel Postgres or Neon) | The filesystem is read-only and per-instance, so SQLite cannot persist |
| Uploaded documents | Vercel Blob | Same reason — a local path would vanish between upload and the message that reads it |

Steps:

1. **Create the stores.** Vercel → Storage → Postgres, and again for Blob. Link both
   to the project. That sets `POSTGRES_URL` and `BLOB_READ_WRITE_TOKEN` automatically.
   Use the **pooled** connection string: serverless opens many short-lived
   connections and a direct one runs out of slots.
2. **Set the remaining env vars** in the Vercel project: `OPENAI_API_KEY`,
   `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (generate a fresh one),
   `ADMIN_EMAILS`, `ALLOWED_EMAIL_DOMAIN`, and `AUTH_URL` set to the real domain.
3. **Add the production redirect URI** in Google Console:
   `https://your-domain/api/auth/callback/google`
4. Deploy. The schema is created on the first request — every statement is
   `IF NOT EXISTS`, so concurrent cold starts are harmless.

Locally, `vercel env pull` writes the same values into `.env.local`.

### What the platform constrains

- **A turn must finish inside `maxDuration`** — 300s in `vercel.json`, which is the
  ceiling on every Vercel plan, Hobby included. A route asking for more fails the
  build. Note that Hobby is licensed for non-commercial use.
- **Stop is instant**, because the answer streams on the request itself: aborting the
  fetch stops the model call and stops the billing. Whatever streamed is kept.
- **Uploads are capped at 20 MB per file** and buffer in memory, because a serverless
  instance has nowhere to stream them to.

## How it works

**Admin → `/admin` → Instructions** sets house instructions — text prepended to every
conversation for everyone. Good for house style, the names of your systems, or what to
do when someone asks about a client. It is sent on every message, so it should hold
only what genuinely applies every time. The built-in rules are shown alongside it so
you know what not to repeat.

**Admin → Audit log** is the append-only record of who did what: uploads, deletions,
access changes, instruction edits. Nothing in the app edits or removes a row there.

**Everyone → `/`** chats. Attach a file and it is read on that message and stays in
context for the rest of the thread — where the provider caches the document prefix it
reads back at a fraction of the input price, which beats re-fetching pages and losing
fidelity.

**Everyone → Settings** sets their own instructions, their default model, thinking
level and style, their custom styles, and what the assistant is allowed to remember
about them. Personal instructions sit on top of the admin's house text rather than
replacing it.

**Everyone → Projects** groups conversations that share a brief. A project carries its
own instructions and its own documents, and both apply to every chat inside it.

## Files it reads

| Format | Handling |
|---|---|
| PDF (incl. scans) | Sent natively — the model reads scanned pages via vision |
| DOCX | Text extracted with `mammoth` |
| XLSX / XLSM | Rendered per sheet with real cell addresses (`Depreciation!D14`) plus a formula index, so a broken fill pattern stays visible instead of being flattened into a plain table |
| CSV / TXT / MD | Decoded, including the UTF-16 and BOM variants Excel produces |
| PNG / JPG / GIF / WebP | Sent as images |

Type is determined by magic bytes, not the extension. Legacy `.doc`/`.xls` are
rejected with a message telling you to re-save. Nothing is silently truncated — a
file over the page limit is refused with the actual page count.

## Security

- **Sign-in is Google OAuth only** — no passwords are stored, so there is no password
  to leak, reset or brute-force. Sessions are 12-hour signed JWTs.
- **A Google login is identity, not authorisation.** Google will authenticate any
  account on earth, so access is granted by exactly two things: being listed in
  `ADMIN_EMAILS`, or being added by an admin under **Admin → People**. Anyone else is
  refused despite a perfectly valid Google session. `ALLOWED_EMAIL_DOMAIN` adds a second
  fence at the domain level. `ADMIN_EMAILS` is grant-only — removing someone from it
  does not demote them, so nobody loses access by surprise.
- **Role and active status are re-read from the database on every request**, not trusted
  from the token — so deactivating someone or changing their role takes effect on their
  next request rather than when a token expires.
- **The last active admin cannot be deactivated**, and nobody can deactivate
  themselves — otherwise the firm could be locked out of user management with no route
  back in through the UI.
- **Ownership is enforced in SQL**, inside each query, not in the UI. A member
  requesting someone else's file gets 404, not 403, so IDs cannot be probed.
  Admin cross-user reads are permitted and written to the audit log.
- **The API key never reaches the browser.** `lib/*` is marked `server-only`, so a
  client import is a build error, and nothing carries a `NEXT_PUBLIC_` prefix.
  `lib/app.ts` is the one deliberate exception: branding constants, no secrets.
- **Uploads served as attachments** with `nosniff` and a sandbox CSP, never inline,
  so a malicious PDF cannot script against a session.
- **Model output is rendered as React nodes**, never `dangerouslySetInnerHTML` —
  it derives from attacker-controlled files.
- **Prompt injection**: documents are framed as material to reason about, not
  instructions, and `web_search`/`web_fetch` are never enabled (an uploaded PDF is a
  place an attacker can put a URL — that would be an exfiltration channel).
- **A connector plus an uploaded document is that same exfiltration shape**, and it is
  the reason connectors are built the way they are. Text inside a client document can
  try to talk the model into sending something out through a tool. Four things narrow
  it: only an admin can add a connector; only tools an admin ticked are exposed at
  all; no conversation reaches one unless it was switched on in that thread; and the
  model is told, in its own frozen prompt block, that connector results are data and
  that it must never send document contents out through a connector unless asked to
  do that specific thing. Every call is in the audit log. None of that is a
  guarantee — a read-only connector in a thread with no client documents is the
  configuration to prefer, and `CONNECTORS_ENABLED=false` is the switch if one
  misbehaves.
- **Connected accounts are per person and read-only.** The token belongs to the
  user id that authorised it, so nobody sees anybody else’s Drive through this,
  and the scopes granted cannot send mail or change a file. Tokens are stored
  encrypted (AES-256-GCM, key derived from `AUTH_SECRET`), so a database dump on
  its own does not yield a working grant to somebody’s mailbox. Disconnecting
  deletes them here; the grant at Google or Box has to be withdrawn there.
- **Connector URLs are checked before use** — http/https only, and the cloud metadata
  endpoint is refused outright, so a connector cannot be pointed at the instance
  credentials.
- **The analysis sandbox is `node:vm`, which is isolation, not a security boundary.**
  The usual caveat applies and is worth stating plainly, because the code it runs is
  written by a model that has attacker-controlled documents in its context. Two things
  narrow it: code generation is disabled inside the context, which removes `eval` and
  the `Function` constructor — the vector every published vm escape goes through — and
  a fresh context starts with no `require`, `process`, `fetch` or timers, so there is
  nothing to reach the network or the disk with. Scripts are synchronous and time out
  after `ANALYSIS_TIMEOUT_MS`. Treat it as defence in depth behind the prompt rule,
  not as a substitute for it. `TOOLS_ENABLED=false` removes it entirely.
- **Memory is per-person and never shared.** A fact remembered for one person is
  scoped to their user id in SQL, is listed in full under Settings → Memory, and is
  deletable one at a time or all at once.

## Data protection

- **SSN/EIN/account/routing/card tokenisation** is on by default (`PII_MODE=tokenize`).
  Identifiers in *converted* text are replaced with stable pseudonyms — `[SSN-a3f2]` —
  so the same value maps to the same token everywhere and cross-document matching
  still works, but the number does not leave the machine. Dollar amounts, dates,
  form and line numbers, addresses and names are never touched.
  **This cannot mask native PDFs or images** — those are sent as bytes and pixels.
  It reduces exposure; it does not remove PII.
- **Retention**: uploaded originals expire after `RETENTION_ORIGINALS_DAYS` (default 90).
  Conversations and the audit log are kept. Purge from **Usage & cost →
  Document retention**. This app is an assistant, not your document management
  system; a second, less-governed copy of every client PDF is liability without benefit.
- **Encryption at rest is the provider's**, not this app's — Postgres and Blob both
  encrypt at rest. Confirm that satisfies your WISP before real client data.

## Cost

`/admin` → Usage & cost shows month-to-date spend, a per-person breakdown, recent
activity with token counts, and the cache hit rate.

**If the cache hit rate drops below ~30%, something is wrong.** The likely cause is a
change that put volatile text (a date, a client name) into the cached prompt prefix.
Nothing errors when this happens — the bill just goes up.

## Tests

```bash
npm run build && npm start   # in one terminal
npm test                     # in another
```

The suite talks to the same Postgres as the app, so `DATABASE_URL` must be set. It
seeds its own users and cleans up after itself; point it at a scratch database
rather than one holding real conversations.

183 checks against a real HTTP server: the anonymous-access matrix, that an
authenticated-but-not-invited Google account is still refused, immediate effect of
deactivation, the last-admin lockout guard, magic-byte rejection, dedupe (including
that a re-upload neither steals a file from another conversation nor leaves the new
one holding an attachment the model cannot see), upload guards, PII
tokenisation precision, house instructions, the cross-user access-control matrix,
branching (retry and edit produce versions, and stepping between them works),
projects and their shelf, preferences, styles, memory, stars, archive and both
exports.

Connectors run against a stub MCP server the suite starts itself
([tests/mcp-stub.mjs](tests/mcp-stub.mjs)), which proves the client protocol rather
than mocking it: the credential really goes out, a URL pointing at the cloud metadata
endpoint is refused, a connector with nothing approved is offered to nobody, an
unknown id is discarded rather than stored, and disabling one drops it from the
threads already using it. The account flow is checked without a real Google round
trip — that it asks for a code with PKCE and read-only scopes only, that a failed
callback redirects back into the app with a message rather than dead-ending on a JSON
error, that an account nobody connected cannot be switched on, and that no token is
ever written to the database in the clear.

Every new surface is checked for ownership as well as for behaviour — one person
cannot read, rename or delete another's project, style, memory or answer, and a member
cannot see or change any connector.

Google's redirect cannot be driven headlessly, so the suite mints genuine NextAuth
session cookies from `AUTH_SECRET` rather than adding a test-only backdoor to the app —
the allowlist still applies, which is the point.

```bash
npm run test:live            # costs money — a handful of short model calls
```

The parts that only exist once a real model is on the other end: that the model
reaches for `run_analysis` and the sandbox returns the arithmetically correct total,
that a reasoning summary streams and is stored with its answer, that Continue appends
to a message instead of adding a new one, that `remember` writes a fact that then
appears in Settings, and that the model calls a connector tool, gets the real answer
back through MCP, and cannot reach a tool nobody approved however plainly it is asked
to. Kept separate from `npm test` because it bills.

## Chat behaviour

**The thread is a tree, not a list.** Every message points at the one it answers, so
an edit or a retry adds a sibling rather than overwriting anything:

- **Edit** a question and the thread re-runs from there. The original and its answer
  stay reachable behind the `‹ 2/3 ›` arrows.
- **Retry** an answer for a second attempt at the same question — switch models first
  and you get the same question answered by a different one.
- **Continue** appears when an answer hit the output ceiling or was stopped part-way.
  It extends that message rather than starting a new one.
- Stepping back through versions lands on the end of that branch, not the middle of it.

**Per-conversation controls**, in the composer:

| Control | What it does |
|---|---|
| Model | Fast / Balanced / Deep. Switch mid-thread; each answer records what wrote it |
| Thinking | Off, Standard, Extended. The reasoning summary streams into a collapsible block above the answer and is kept with it |
| Style | Normal, Concise, Explanatory, Formal, or one you wrote yourself |

A choice made here applies to that thread only. Defaults live in **Settings**.

**Tools the model can call mid-answer** (`TOOLS_ENABLED=false` removes both):

- **`run_analysis`** runs a short JavaScript program over the text of the attached
  documents and reports what it printed. Use it for anything that turns on arithmetic
  over more than two or three numbers — a column that has to foot, a reconciliation, a
  variance. The code and its exact output are shown under the answer, collapsed, so
  the working can be checked rather than taken on trust.
- **`remember` / `forget`** write to the memory described below.
- **Connector tools**, when a connector is switched on for that thread — see below.

**Citations.** When an answer states a figure from an attached document it carries a
numbered chip linking to that document. A citation naming a file the conversation
cannot see is dropped rather than rendered as a dead link.

**Connectors** are remote MCP servers whose tools the model may call — a document
store, a practice system, an internal API. Three separate acts stand between adding
one and it doing anything:

1. An **admin adds** it under **Admin → Connectors**, with a URL and an optional
   credential sent as a header. Only admins can see or change any of this.
2. The admin presses **Connect**, which asks the server what it offers, then **ticks
   the individual tools** the firm should use. A connector with nothing ticked
   contributes nothing and is not even offered in the composer. Tools that declare
   themselves read-only are labelled; anything else is labelled *may write*.
3. Each person **switches it on per conversation**. It is off by default in every new
   thread and is never remembered as a preference.

Every call the model makes goes in the audit log under `connector.call` with who
caused it, which tool, and the arguments. The stored credential is never returned by
any route — the admin screen says whether one is set, never what it is.
`CONNECTORS_ENABLED=false` removes all of them without deleting the configuration.

MCP servers requiring an OAuth sign-in are not supported; this takes a static header
credential, which covers internal and API-key servers. For Drive, Gmail and Box, use
connected accounts instead.

**Connected accounts** are the other half: Google Drive, Gmail and Box, reached with
each person's own login rather than a shared key. **Settings → Accounts** to connect
one; it then appears in the same composer menu as the shared connectors, and is off by
default in every thread like they are.

| Account | What it can do |
|---|---|
| Google Drive | Search files by name and contents; read Docs, Sheets, Slides and text files |
| Gmail | Search with Gmail query syntax; read a message in full |
| Box | Search files; read text files |

Four things about how this is built, all deliberate:

- **Read-only scopes, always.** `drive.readonly`, `gmail.readonly`, Box read scopes.
  Nothing here can send mail, change a file or delete anything. Adding a write scope
  would mean re-consenting everybody, which is the right amount of friction for that.
- **Per person, never shared.** The token belongs to the user id that authorised it,
  so two people running the same connector see their own Drive and nobody else's.
- **Tokens are encrypted at rest** (AES-256-GCM, key derived from `AUTH_SECRET` via
  HKDF), because a refresh token is a standing grant to read a mailbox and is the one
  thing here that must not be usable from a stolen database dump. Rotating
  `AUTH_SECRET` invalidates them all and everybody reconnects — correct, not a bug.
- **Every search and read is in the audit log** under `account.call`.

Drive and Gmail reuse the Google client already used for sign-in; enable those two APIs,
add the scopes, and add `/api/accounts/drive/callback` and `/api/accounts/gmail/callback`
as redirect URIs. Box needs its own app. `.env.example` has the click-by-click, and
Settings shows the exact redirect URI for anything not yet set up. Note that
`gmail.readonly` is a restricted scope: fine for an Internal Workspace app, but a
public one needs Google's review first.

**Projects** are a folder with their own standing instructions and their own shelf of
documents, both applied to every conversation inside. Deleting a project keeps its
conversations — they move back to the top level.

**Memory** carries facts between conversations. The model writes one when asked, or
when a lasting preference becomes clear; everything it has kept is listed under
**Settings → Memory**, individually deletable, and switched off in one click.

**Settings** holds your own instructions (on top of the admin's house text, not
instead of them), your defaults, your custom styles, your memory, and a JSON export of
everything you have here.

**Rendering**: full markdown — tables, lists, code blocks with copy buttons, links —
plus LaTeX via KaTeX and ```mermaid fences as diagrams. Raw HTML in model output is
ignored (no `rehype-raw`), which matters because that text derives from uploaded
documents.

**Also**: star and archive chats, rate an answer, export one conversation as Markdown,
drag-and-drop and paste files straight into the composer, paste more than 4,000
characters and it becomes an attachment, dictate with the browser's own speech
recognition where it has one, `⌘K` to search and `⌘⇧O` for a new chat.

**Stop** aborts the request, which stops the model call billing; partial output is
kept and offered a Continue button.

Still not built: web search, share-by-link, artifacts, mobile layout, and MCP servers
that require an OAuth sign-in of their own.
Refreshing mid-answer loses the in-flight stream — the old detached-job machinery that
survived a refresh went with the review pipeline.

## Layout

```
app/                 pages + route handlers
  api/               auth, chat, conversations, messages, files, projects, prefs,
                     memories, styles, connectors, accounts, search, export, admin
  page.tsx           chat  ·  login/  admin/
components/          Chat, Markdown, Thinking, ToolPanel, SettingsDialog,
                     ProjectPanel, Mermaid, AdminPanel, ConnectorsTab, Mark
lib/
  app.ts             branding constants — the only lib file safe to import client-side
  models.ts          model + style catalogue; the other file the browser may import
  config.ts          env, model + pricing table, tool limits
  db.ts              Postgres pool, schema, and the ?-to-$n placeholder shim
  auth.ts            NextAuth + Google, the allowlist, role guards
  pii.ts             identifier tokenisation
  providers/         OpenAI adapter — the only place importing the SDK; owns the
                     tool loop and the reasoning stream
  ingest.ts          magic-byte sniffing, extraction, document blocks
  prompt.ts          the frozen rules, and how the system blocks are ordered
  prefs.ts           per-person defaults, custom styles, memories, projects
  mcp.ts             a small MCP client: initialize, tools/list, tools/call
  connectors.ts      connector store, the approved-tool list, and the call path
  secrets.ts         AES-256-GCM for stored account tokens
  accounts/          Drive, Gmail and Box: the OAuth flow, the token store,
                     and the read-only tools each one contributes
  thread.ts          the message tree: walking it, branching it, appending to it
  tools.ts           the analysis sandbox and the memory tools
  chat.ts            one conversational turn: prompt, documents, tools, accounting
  storage.ts         Vercel Blob: uploaded documents
  retention.ts       expiry sweeper and hard delete
vercel.json          per-route function limits
```

### Why the system prompt is assembled in that order

`assembleSystemBlocks` emits blocks most-stable-first: the frozen base, then the
citation and tool rules, the admin's house text, the project's instructions, the
style, the person's own instructions, their memories, and last the list of documents
attached to this conversation.

A cached prefix survives only up to the first byte that changed. Putting the memories
above the house text, or merging the blocks into one string, costs nothing visible and
quietly destroys the cache for everybody. Watch the cache hit rate after touching it.

### Left in the database

The old `reviews`, `review_files`, `findings`, `citations`, `stream_events` and
`skills` tables are no longer created or read, but existing rows were **not** dropped —
deleting a firm's review history is a decision to make deliberately, not a side effect
of a refactor. Drop them by hand when you are sure you want them gone.

## Known advisory (assessed, not actioned)

`npm audit` reports 2 moderate advisories, both from `uuid@8` pulled in by `exceljs`:
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), a missing
buffer bounds check in `uuid.v3/v5/v6` **when the caller supplies a `buf` argument**.

`exceljs` only calls `uuid.v4()` with no arguments (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`),
so the vulnerable path is not reachable. `npm audit fix --force` would downgrade
`exceljs` from 4.x to 3.4.0 — a major regression for no security benefit. Left as-is
deliberately; re-check when exceljs updates its `uuid` dependency.

## Still outstanding

**Get OpenAI's answers in writing** on training use, retention windows, and whether a
zero-retention arrangement is available on your plan — before real client data goes
through this.

The §301.7216 question that applied to the review tool no longer applies in the same
form, since nobody is now reviewing US taxpayer returns through it by design. If
client documents are attached to chats anyway, it applies again — the regulation
follows the data, not the app's name.

Answers are model output. Check anything that matters.
