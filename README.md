# Tax Review Center

An internal AI tax review workbench for USAIndiaCFO. Claude-style chat interface.
An admin publishes the firm's review methodology once; everyone else just attaches
tax files and gets a structured findings report back.

Next.js 16 (App Router) · React 19 · Tailwind 4 · TypeScript · SQLite (`node:sqlite`)

Two providers, switched with one line in `.env` (`AI_PROVIDER`):

| | OpenAI (`gpt-5.6-luna`) | Anthropic (`claude-opus-5`) |
|---|---|---|
| Cost per 40-page review | **~$0.02** | ~$0.58 |
| PDFs, including scans | yes, natively | yes, natively |
| Photos of receipts | yes | yes |
| Page references on findings | no | yes, API-verified |

Page references are the real trade. Only Anthropic returns server-computed page
locations, so on OpenAI findings carry no page anchors. We do not ask the model to
state page numbers and present them as provenance — an unverifiable page reference in
a tax review is worse than none.

## Start it

```bash
npm install
npm run dev          # http://localhost:3100
```

Two values go in `.env` — it has step-by-step instructions inside:

```
OPENAI_API_KEY=sk-...                 # platform.openai.com/api-keys
AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET   # console.cloud.google.com/apis/credentials
```

The Google OAuth client needs this exact redirect URI:

```
http://localhost:3100/api/auth/callback/google
```

Everyone in `ADMIN_EMAILS` can sign in immediately and is an admin. Admins then add
everyone else by email under **Admin → People**.

To use Claude instead of OpenAI, set `AI_PROVIDER=anthropic` and fill in
`ANTHROPIC_API_KEY`.

For production: `npm run build && npm start`.

> Port 3000 is used by other projects on this machine, so this defaults to **3100**.

## How it works

**Admin → `/admin`** publishes *skills*: checklists, SOPs, methodology. Upload a
DOCX/XLSX/CSV/TXT and its text is extracted, or paste it directly. Every enabled
skill is loaded into every review the whole team runs. Editing a skill bumps its
version, and each review records the versions it used.

**Reviewer → `/`** attaches tax files and presses Review. No prompting required.

Each review runs in two passes:

1. **Review pass** reads the documents and streams the write-up. On Anthropic,
   citations are enabled so page references come back from the API rather than
   being invented by the model.
2. **Extraction pass** turns that write-up into structured findings — a forced
   strict tool call on Anthropic, a JSON-schema response on OpenAI — with no
   documents attached.

On Anthropic these must be separate calls: the API rejects citations combined with a
structured output schema. Splitting them is what lets the report have both real page
numbers *and* sortable structure. If the extraction pass fails, the written review
still renders — you never lose a review to a schema error.

Severities map to workflow rather than generic high/medium/low:
`filing_blocking`, `compliance_risk`, `math_or_carryforward_error`,
`missed_opportunity`, `documentation_gap`, `presentation_nit`.

## Files it reads

| Format | Handling |
|---|---|
| PDF (incl. scans) | Sent natively — both providers read scanned pages via vision. Page-accurate citations on Anthropic only. |
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
  themselves — otherwise the firm could be locked out of skills and user management
  with no route back in through the UI.
- **Ownership is enforced in SQL**, inside each query, not in the UI. A reviewer
  requesting someone else's file gets 404, not 403, so IDs cannot be probed.
  Admin cross-user reads are permitted and written to the audit log.
- **The API key never reaches the browser.** `lib/*` is marked `server-only`, so a
  client import is a build error, and nothing carries a `NEXT_PUBLIC_` prefix.
- **Uploads served as attachments** with `nosniff` and a sandbox CSP, never inline,
  so a malicious PDF cannot script against a session.
- **Model output is rendered as React nodes**, never `dangerouslySetInnerHTML` —
  it derives from attacker-controlled files.
- **Prompt injection**: documents are framed as evidence, not instructions, and
  `web_search`/`web_fetch` are never enabled on the review path (a client PDF is a
  place an attacker can put a URL — that would be an exfiltration channel).

## Data protection

- **SSN/EIN/account/routing/card tokenisation** is on by default (`PII_MODE=tokenize`).
  Identifiers in *converted* text are replaced with stable pseudonyms — `[SSN-a3f2]` —
  so the same value maps to the same token everywhere and cross-document matching
  still works, but the number does not leave the machine. Dollar amounts, dates,
  form and line numbers, addresses and names are never touched.
  **This cannot mask native PDFs or images** — those are sent as bytes and pixels.
  It reduces exposure; it does not remove PII.
- **Retention**: uploaded originals expire after `RETENTION_ORIGINALS_DAYS` (default 90).
  Findings, reviews and the audit log are kept. Purge from **Usage & cost →
  Document retention**. This app is a review assistant, not your document management
  system; a second, less-governed copy of every client PDF is liability without benefit.
- **`data/` is not encrypted by this app.** It relies on BitLocker on the volume.
  Confirm BitLocker is on before real client returns go through this.
- **The startup guard refuses to run if `DATA_DIR` is inside OneDrive.** Your Desktop
  is not currently redirected, but one "Back up this folder" click would change that.

## Cost

`/admin` → Usage & cost shows month-to-date spend, cost per review, per-person
breakdown, and cache hit rate. A 40-page return runs roughly $0.02 on
gpt-5.6-luna, or $0.23–$0.58 on Claude depending on the model. Follow-up turns are
cheaper still because the documents and skill bundle are cached.

**If the cache hit rate drops below ~30%, something is wrong.** The likely cause is a
change that put volatile text (a date, a client name) into the cached prompt prefix.
Nothing errors when this happens — the bill just goes up.

## Tests

```bash
# stop the server, then:
rm -rf data && npm run build && npm start   # in one terminal
npm test                                     # in another
```

82 checks against a real HTTP server: the anonymous-access matrix, that an
authenticated-but-not-invited Google account is still refused, immediate effect of
deactivation, the last-admin lockout guard, magic-byte rejection, dedupe (including
that a re-upload does not steal a file from another conversation), upload guards, PII
tokenisation precision, and the cross-user access-control matrix.

Google's redirect cannot be driven headlessly, so the suite mints genuine NextAuth
session cookies from `AUTH_SECRET` rather than adding a test-only backdoor to the app —
the allowlist still applies, which is the point. It does not call the AI APIs.

## Chat behaviour

- **Full markdown** — tables, lists, code blocks and links, via `react-markdown`.
  Raw HTML in model output is ignored (no `rehype-raw`), which matters because that
  text derives from uploaded client documents.
- **Stop** cancels mid-run. For a review that aborts the background job; for a
  follow-up it aborts the request, and either way the model call stops billing and
  partial output is kept.
- **Refreshing mid-review loses nothing.** Reviews run detached from the request that
  started them and append every chunk to `stream_events`; the browser reads that log
  from a cursor, so a refresh, a dropped connection or a closed laptop lid all resume
  where they left off. Reopening a conversation reattaches automatically.
- **Copy** on any message, **rename** a review (double-click the title or the pencil),
  and **search** across titles and message text.
- **Page references open the document** at that page in a sandboxed viewer. The
  `?inline=1` response still carries `Content-Security-Policy: sandbox`, so it sits in
  an opaque origin and a hostile PDF cannot reach the reviewer's session.

Still not built: artifacts, projects, web search, clipboard image paste, mobile layout.

## Layout

```
app/                 pages + route handlers
  api/               auth/[...nextauth], files, review, chat, admin
  page.tsx           chat  ·  login/  admin/
components/          Chat, Markdown, FindingsReport, PdfViewer, AdminPanel, Mark
lib/
  config.ts          env, model + pricing table, OneDrive guard
  db.ts              schema + additive column migrations
  auth.ts            NextAuth + Google, the allowlist, role guards
  pii.ts             identifier tokenisation
  ai.ts              Claude adapter — the only file importing the SDK
  ingest.ts          magic-byte sniffing, extraction, document blocks
  skills.ts          skill CRUD, deterministic bundle assembly
  review.ts          two-pass pipeline, prompts, citation resolution
  retention.ts       expiry sweeper and hard delete
  jobs.ts            detached review jobs + the replayable event log
data/                SQLite + uploads. Gitignored. This is what to back up.
```

## Known advisory (assessed, not actioned)

`npm audit` reports 2 moderate advisories, both from `uuid@8` pulled in by `exceljs`:
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), a missing
buffer bounds check in `uuid.v3/v5/v6` **when the caller supplies a `buf` argument**.

`exceljs` only calls `uuid.v4()` with no arguments (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`),
so the vulnerable path is not reachable. `npm audit fix --force` would downgrade
`exceljs` from 4.x to 3.4.0 — a major regression for no security benefit. Left as-is
deliberately; re-check when exceljs updates its `uuid` dependency.

## Two things still outstanding

Neither is a code change, and neither is something this app can settle:

1. **Get Anthropic's answers in writing** on training use, retention windows, and
   whether Zero Data Retention is available on your plan — before real client returns
   go through this.
2. **Point counsel at Treas. Reg. §301.7216**, which sets distinct requirements for
   disclosing taxpayer information to preparers **outside the US** — directly relevant
   to India-based reviewers seeing US taxpayer SSNs. If the answer is that masking is
   required, `PII_MODE` already exists; only native PDFs would need more work.

Findings are model output. A reviewer signs the return, not the app.
