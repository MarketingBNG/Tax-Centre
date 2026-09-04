import 'server-only';
import crypto from 'node:crypto';
import { one as readOne, all as readAll, run as exec, audit, type Param } from '@/lib/db';
import type {
  AuthorityStatus,
  Category,
  DefectKind,
  DocRole,
  EngagementFactRow,
  EngagementRow,
  FindingAmount,
  FindingEvidence,
  FindingFix,
  FindingKind,
  FindingLocation,
  FindingStatus,
  Owner,
  QuestionBranch,
  ReturnType,
  ReviewRunRow,
  RunApprovalRow,
  RunCalcRow,
  RunDocumentRow,
  RunFindingRow,
  RunQuestionRow,
  RunStageRow,
  RunStatus,
  RunTieOutRow,
  Severity,
  StageKey,
  StageStatus,
  Verdict,
} from '@/lib/review-types';

/**
 * Every read and write against the review tables.
 *
 * Two things are deliberately funnelled through here rather than left to the
 * callers:
 *
 *   - Every mutation of a finding or a question bumps review_runs.register_version
 *     in the *same statement*, using a data-modifying CTE. An approval records
 *     the version it saw, so if the bump could be skipped — or lost to a crash
 *     between two statements — a stale approval would keep looking current.
 *     One statement, one outcome.
 *
 *   - Claiming a stage is a single UPDATE ... FOR UPDATE SKIP LOCKED. Two
 *     browser tabs both calling advance, or a retry racing the instance it is
 *     replacing, must not run the same stage twice.
 */

/** A stage that has not heartbeated in this long is presumed dead and reclaimable. */
export const STALE_STAGE_MS = 120_000;

/** How many times a failing stage is re-attempted before it needs a human. */
export const MAX_STAGE_ATTEMPTS = 3;

const uuid = () => crypto.randomUUID();
const now = () => Date.now();

/**
 * BIGINT columns arrive from the driver as strings, so that values beyond
 * Number.MAX_SAFE_INTEGER survive the trip. Epoch milliseconds are nowhere
 * near that, and a string reaching `new Date()` produces Invalid Date rather
 * than an error — which is how a bad run date reaches a printed summary
 * unnoticed.
 *
 * Coerced here, at the one boundary every read passes through, rather than at
 * each call site: the row types promise `number`, and a promise kept in nine
 * places out of ten is the same bug with extra steps. The `id` columns are
 * deliberately not in this list — they are TEXT uuids everywhere except
 * run_events, which is handled where it is read.
 */
const BIGINT_KEYS = [
  'created_at',
  'updated_at',
  'started_at',
  'finished_at',
  'heartbeat_at',
  'answered_at',
  'approved_at',
  'cost_micros',
  'corpus_as_of',
] as const;

function coerce<T>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  const record = row as Record<string, unknown>;
  for (const key of BIGINT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') record[key] = Number(value);
  }
  return row;
}

/**
 * Every read in this module goes through these rather than the raw helpers, so
 * there is no way to add a query later that forgets to coerce.
 */
async function one<T>(query: string, ...params: Param[]): Promise<T | null> {
  const row = await readOne<T>(query, ...params);
  return row ? coerce(row) : null;
}

async function all<T>(query: string, ...params: Param[]): Promise<T[]> {
  return (await readAll<T>(query, ...params)).map(coerce);
}

/* ---------------------------------------------------------- engagements */

export async function createEngagement(
  actorId: string,
  input: {
    clientLabel: string;
    entityName?: string | null;
    ein?: string | null;
    returnType?: ReturnType | null;
    taxYear?: number | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    shortYear?: boolean;
  },
): Promise<EngagementRow> {
  const id = uuid();
  const at = now();
  await exec(
    `INSERT INTO engagements
       (id, client_label, entity_name, ein, return_type, tax_year,
        period_start, period_end, short_year, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.clientLabel,
    input.entityName ?? null,
    input.ein ?? null,
    input.returnType ?? null,
    input.taxYear ?? null,
    input.periodStart ?? null,
    input.periodEnd ?? null,
    input.shortYear ? 1 : 0,
    actorId,
    at,
    at,
  );
  await audit(actorId, 'engagement.created', 'engagement', id, {
    client: input.clientLabel,
    returnType: input.returnType ?? null,
  });
  return (await getEngagement(id))!;
}

export const getEngagement = (id: string) =>
  one<EngagementRow>(`SELECT * FROM engagements WHERE id = ?`, id);

/**
 * Reviews are firm-visible, unlike chats.
 *
 * A preparer answers questions on a run a reviewer opened, and a partner
 * approves a run neither of them created. Scoping these rows to one person
 * would break the workflow they exist to support; who did what is recorded on
 * each action instead.
 */
export const listEngagements = () =>
  all<EngagementRow>(`SELECT * FROM engagements ORDER BY created_at DESC LIMIT 200`);

export interface EngagementSummaryRow extends EngagementRow {
  run_count: string;
  run_id: string | null;
  run_number: number | null;
  run_status: RunStatus | null;
  verdict: Verdict | null;
  register_version: number | null;
  run_created_at: number | null;
  open_high: string;
}

/**
 * The engagement list with each one's latest run folded in.
 *
 * One query rather than one per row: the open Critical/High count is the number
 * the list exists to show, and fetching it per engagement would make opening
 * the page cost a round trip per client.
 */
export const listEngagementSummaries = () =>
  all<EngagementSummaryRow>(
    `SELECT e.*,
            (SELECT COUNT(*) FROM review_runs rr WHERE rr.engagement_id = e.id) AS run_count,
            r.id               AS run_id,
            r.run_number       AS run_number,
            r.status           AS run_status,
            r.verdict          AS verdict,
            r.register_version AS register_version,
            r.created_at       AS run_created_at,
            COALESCE((SELECT COUNT(*) FROM run_findings f
                       WHERE f.run_id = r.id
                         AND f.severity IN ('Critical','High')
                         AND f.status IN ('open','answered_pending_evidence','escalated','client')), 0)
              AS open_high
       FROM engagements e
       LEFT JOIN LATERAL (
         SELECT * FROM review_runs WHERE engagement_id = e.id
          ORDER BY run_number DESC LIMIT 1
       ) r ON TRUE
      ORDER BY e.created_at DESC
      LIMIT 200`,
  );

export async function updateEngagement(
  actorId: string,
  id: string,
  patch: Partial<{
    clientLabel: string;
    entityName: string | null;
    ein: string | null;
    returnType: ReturnType | null;
    taxYear: number | null;
    periodStart: string | null;
    periodEnd: string | null;
    shortYear: boolean;
  }>,
): Promise<EngagementRow | null> {
  const columns: Record<string, string> = {
    clientLabel: 'client_label',
    entityName: 'entity_name',
    ein: 'ein',
    returnType: 'return_type',
    taxYear: 'tax_year',
    periodStart: 'period_start',
    periodEnd: 'period_end',
    shortYear: 'short_year',
  };
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    const value = (patch as Record<string, unknown>)[key];
    sets.push(`${column} = ?`);
    params.push(key === 'shortYear' ? (value ? 1 : 0) : ((value as string | number | null) ?? null));
  }
  if (!sets.length) return getEngagement(id);

  sets.push('updated_at = ?');
  params.push(now(), id);
  await exec(`UPDATE engagements SET ${sets.join(', ')} WHERE id = ?`, ...params);
  await audit(actorId, 'engagement.updated', 'engagement', id, patch);
  return getEngagement(id);
}

/* ---------------------------------------------------------------- facts */

/**
 * Records a fact, superseding whatever it replaces rather than overwriting it.
 *
 * A run is judged against the facts it saw. If answering a question in run 3
 * edited the row run 1 was built on, run 1's register would silently stop
 * matching its own reasoning.
 */
export async function assertFact(
  actorId: string | null,
  engagementId: string,
  key: string,
  value: unknown,
  source: EngagementFactRow['source'],
  opts: { evidenceFileId?: string | null; confidence?: number | null } = {},
): Promise<EngagementFactRow> {
  const id = uuid();
  const at = now();
  await exec(
    `INSERT INTO engagement_facts
       (id, engagement_id, key, value, source, evidence_file_id, confidence,
        superseded_by, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    id,
    engagementId,
    key,
    JSON.stringify(value ?? null),
    source,
    opts.evidenceFileId ?? null,
    opts.confidence ?? null,
    actorId,
    at,
  );
  // Point every earlier live row for this key at the new one. Done after the
  // insert so a crash between the two leaves two current rows (visible, and
  // resolved by created_at) rather than none.
  await exec(
    `UPDATE engagement_facts SET superseded_by = ?
      WHERE engagement_id = ? AND key = ? AND id <> ? AND superseded_by IS NULL`,
    id,
    engagementId,
    key,
    id,
  );
  return (await one<EngagementFactRow>(`SELECT * FROM engagement_facts WHERE id = ?`, id))!;
}

export const listCurrentFactRows = (engagementId: string) =>
  all<EngagementFactRow>(
    `SELECT * FROM engagement_facts
      WHERE engagement_id = ? AND superseded_by IS NULL
      ORDER BY key, created_at DESC`,
    engagementId,
  );

/** The current facts as a plain object, which is what the stage predicates read. */
export async function currentFacts(engagementId: string): Promise<Record<string, unknown>> {
  const rows = await listCurrentFactRows(engagementId);
  const facts: Record<string, unknown> = {};
  for (const row of rows) {
    // Newest wins where the supersede pass has not caught up yet.
    if (row.key in facts) continue;
    try {
      facts[row.key] = JSON.parse(row.value);
    } catch {
      facts[row.key] = row.value;
    }
  }
  return facts;
}

/* ----------------------------------------------------------------- runs */

export async function nextRunNumber(engagementId: string): Promise<number> {
  const row = await one<{ max: number | null }>(
    `SELECT MAX(run_number) AS max FROM review_runs WHERE engagement_id = ?`,
    engagementId,
  );
  return (row?.max ?? 0) + 1;
}

export async function createRun(
  actorId: string,
  input: {
    engagementId: string;
    runNumber: number;
    parentRunId?: string | null;
    status: RunStatus;
    promptVersion: string;
    model: string;
    corpusHash: string;
    factsSnapshot: Record<string, unknown>;
    haltReason?: string | null;
    /** The state of the authority corpus this run reads against. */
    corpusAsOf?: number;
    corpusFingerprint?: string | null;
  },
): Promise<ReviewRunRow> {
  const id = uuid();
  await exec(
    `INSERT INTO review_runs
       (id, engagement_id, run_number, parent_run_id, status, halt_reason,
        prompt_version, model, corpus_hash, facts_snapshot, register_version,
        abort_requested, corpus_as_of, corpus_fingerprint, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
    id,
    input.engagementId,
    input.runNumber,
    input.parentRunId ?? null,
    input.status,
    input.haltReason ?? null,
    input.promptVersion,
    input.model,
    input.corpusHash,
    JSON.stringify(input.factsSnapshot),
    input.corpusAsOf ?? now(),
    input.corpusFingerprint ?? null,
    actorId,
    now(),
  );
  await audit(actorId, 'review.run_created', 'review_run', id, {
    engagementId: input.engagementId,
    runNumber: input.runNumber,
    status: input.status,
  });
  return (await getRun(id))!;
}

export const getRun = (id: string) =>
  one<ReviewRunRow>(`SELECT * FROM review_runs WHERE id = ?`, id);

export const getRunByNumber = (engagementId: string, runNumber: number) =>
  one<ReviewRunRow>(
    `SELECT * FROM review_runs WHERE engagement_id = ? AND run_number = ?`,
    engagementId,
    runNumber,
  );

export const listRuns = (engagementId: string) =>
  all<ReviewRunRow>(
    `SELECT * FROM review_runs WHERE engagement_id = ? ORDER BY run_number DESC`,
    engagementId,
  );

export const latestRun = (engagementId: string) =>
  one<ReviewRunRow>(
    `SELECT * FROM review_runs WHERE engagement_id = ?
      ORDER BY run_number DESC LIMIT 1`,
    engagementId,
  );

/**
 * The most recent run with a register worth comparing.
 *
 * `complete` and `halted` both qualify: a run that stopped at a Stage 0
 * Critical still recorded why, and a run that never got past the input gate
 * recorded nothing. Excluding the latter keeps an abandoned setup from
 * presenting itself as a year that was reviewed and found clean.
 */
export const latestReviewedRun = (engagementId: string) =>
  one<ReviewRunRow>(
    `SELECT * FROM review_runs
      WHERE engagement_id = ? AND status IN ('complete','halted')
      ORDER BY run_number DESC LIMIT 1`,
    engagementId,
  );

/**
 * Earlier tax years for the same client.
 *
 * The EIN identifies the client where there is one, because the client label is
 * free text a colleague will spell differently next January. Where there is no
 * EIN it falls back to the label, matched exactly — a fuzzy match here would
 * silently compare two different clients across years, which is worse than
 * finding no history at all.
 */
export const priorYearEngagements = (engagement: EngagementRow, limit = 4) =>
  engagement.tax_year === null
    ? Promise.resolve([] as EngagementRow[])
    : all<EngagementRow>(
        `SELECT * FROM engagements
          WHERE id <> ?
            AND tax_year IS NOT NULL
            AND tax_year < ?
            AND ${engagement.ein ? 'ein = ?' : 'ein IS NULL AND client_label = ?'}
          ORDER BY tax_year DESC
          LIMIT ?`,
        engagement.id,
        engagement.tax_year,
        engagement.ein ?? engagement.client_label,
        limit,
      );

export async function setRunStatus(
  runId: string,
  status: RunStatus,
  opts: { haltReason?: string | null; errorText?: string | null } = {},
): Promise<void> {
  const at = now();
  const finished = ['complete', 'failed', 'cancelled', 'halted'].includes(status);
  // COALESCE rather than a CASE on a bound boolean: every parameter here stays
  // a plain scalar, which is all the ?-to-$n shim in lib/db.ts promises to pass
  // through unchanged.
  await exec(
    `UPDATE review_runs
        SET status = ?,
            halt_reason = COALESCE(?, halt_reason),
            error_text  = COALESCE(?, error_text),
            started_at  = COALESCE(started_at, ?),
            finished_at = COALESCE(?, finished_at)
      WHERE id = ?`,
    status,
    opts.haltReason ?? null,
    opts.errorText ?? null,
    status === 'running' ? at : null,
    finished ? at : null,
    runId,
  );
}

export async function setVerdict(runId: string, verdict: Verdict, verdictJson: unknown) {
  await exec(
    `UPDATE review_runs SET verdict = ?, verdict_json = ? WHERE id = ?`,
    verdict,
    JSON.stringify(verdictJson),
    runId,
  );
}

/**
 * Stop travels through the database, not through the request.
 *
 * The instance handling the stop is not the instance running the stage, so
 * there is no in-memory signal to raise; the running stage polls this flag.
 */
export async function requestAbort(actorId: string, runId: string): Promise<void> {
  await exec(`UPDATE review_runs SET abort_requested = 1 WHERE id = ?`, runId);
  await audit(actorId, 'review.abort_requested', 'review_run', runId, null);
}

export async function isAbortRequested(runId: string): Promise<boolean> {
  const row = await one<{ abort_requested: number }>(
    `SELECT abort_requested FROM review_runs WHERE id = ?`,
    runId,
  );
  return Boolean(row?.abort_requested);
}

export const touchRun = (runId: string) =>
  exec(`UPDATE review_runs SET heartbeat_at = ? WHERE id = ?`, now(), runId);

/* ------------------------------------------------------------ documents */

export async function addRunDocuments(
  runId: string,
  docs: { fileId: string; docRole: DocRole; parserId?: string; parserConfidence?: number | null }[],
): Promise<void> {
  let index = 0;
  for (const doc of docs) {
    await exec(
      `INSERT INTO run_documents
         (run_id, file_id, doc_role, document_index, parser_id, parser_confidence)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, file_id) DO NOTHING`,
      runId,
      doc.fileId,
      doc.docRole,
      index++,
      doc.parserId ?? 'model-visual',
      doc.parserConfidence ?? null,
    );
  }
}

export const listRunDocuments = (runId: string) =>
  all<RunDocumentRow>(
    `SELECT * FROM run_documents WHERE run_id = ? ORDER BY document_index`,
    runId,
  );

/* --------------------------------------------------------------- stages */

export async function createStages(
  runId: string,
  plan: { stageKey: StageKey; seq: number; status: StageStatus }[],
): Promise<void> {
  for (const stage of plan) {
    await exec(
      `INSERT INTO run_stages (id, run_id, stage_key, seq, status, attempt)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (run_id, stage_key) DO NOTHING`,
      uuid(),
      runId,
      stage.stageKey,
      stage.seq,
      stage.status,
    );
  }
}

export const listStages = (runId: string) =>
  all<RunStageRow>(`SELECT * FROM run_stages WHERE run_id = ? ORDER BY seq`, runId);

/**
 * Takes ownership of the next stage that needs running, or returns null when
 * there is none.
 *
 * SKIP LOCKED is what makes two concurrent advance calls safe: the second one
 * steps over the row the first is claiming instead of blocking on it and then
 * running the same stage a second time.
 *
 * A stage counts as claimable when it is pending, when it failed with attempts
 * left, or when it says it is running but stopped heartbeating — which is what
 * a killed serverless instance looks like from the outside.
 */
export async function claimNextStage(runId: string): Promise<RunStageRow | null> {
  const at = now();
  const rows = await all<RunStageRow>(
    `UPDATE run_stages
        SET status = 'running', attempt = attempt + 1,
            started_at = COALESCE(started_at, ?), heartbeat_at = ?, error_text = NULL
      WHERE id = (
        SELECT id FROM run_stages
         WHERE run_id = ?
           AND ( status = 'pending'
              OR (status = 'failed'  AND attempt < ?)
              OR (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)) )
         ORDER BY seq
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    at,
    at,
    runId,
    MAX_STAGE_ATTEMPTS,
    at - STALE_STAGE_MS,
  );
  return rows[0] ?? null;
}

export const touchStage = (stageId: string) =>
  exec(`UPDATE run_stages SET heartbeat_at = ? WHERE id = ?`, now(), stageId);

export async function completeStage(
  stageId: string,
  input: {
    status?: Extract<StageStatus, 'complete' | 'skipped' | 'not_applicable' | 'carried_forward'>;
    model?: string | null;
    rawOutput?: string | null;
    usage?: unknown;
    costMicros?: number | null;
    inputHash?: string | null;
    carriedFromStageId?: string | null;
  } = {},
): Promise<void> {
  await exec(
    `UPDATE run_stages
        SET status = ?, model = ?, raw_output = ?, usage_json = ?, cost_micros = ?,
            input_hash = COALESCE(?, input_hash),
            carried_from_stage_id = COALESCE(?, carried_from_stage_id),
            finished_at = ?, heartbeat_at = NULL, error_text = NULL
      WHERE id = ?`,
    input.status ?? 'complete',
    input.model ?? null,
    input.rawOutput ?? null,
    input.usage === undefined ? null : JSON.stringify(input.usage),
    input.costMicros ?? null,
    input.inputHash ?? null,
    input.carriedFromStageId ?? null,
    now(),
    stageId,
  );
}

export const failStage = (stageId: string, errorText: string) =>
  exec(
    `UPDATE run_stages
        SET status = 'failed', error_text = ?, finished_at = ?, heartbeat_at = NULL
      WHERE id = ?`,
    errorText.slice(0, 4000),
    now(),
    stageId,
  );

/* ------------------------------------------------------------- findings */

export interface NewFinding {
  kind: FindingKind;
  defectKind: DefectKind | null;
  /** Assigned by lib/review-engine/severity.ts, never taken from model output. */
  severity: Severity | null;
  category: Category;
  title: string;
  whatIsWrong: string;
  whyItMatters?: string | null;
  location?: FindingLocation | null;
  fix?: FindingFix | null;
  authorityStatus?: AuthorityStatus;
  authorityCitation?: string | null;
  authoritySourceSpan?: string | null;
  claimedCitation?: string | null;
  evidence?: FindingEvidence[];
  amounts?: FindingAmount[];
  owner?: Owner | null;
  status?: FindingStatus;
  statusNote?: string | null;
  confidence?: number | null;
  lineageKey?: string | null;
  carriedFromFindingId?: string | null;
}

/**
 * Finding codes are sequential per stage number within a run — S1-001, S3-006.
 *
 * The four Stage 3 units share one S3 series, because the register is read as
 * one document and "S3-INTL-002" would leak the pipeline's internal shape into
 * a page a novice Drake operator has to follow.
 */
const codePrefix = (stageKey: StageKey) => stageKey.split('-')[0];

export async function insertFindings(
  runId: string,
  stageKey: StageKey,
  findings: NewFinding[],
): Promise<RunFindingRow[]> {
  if (!findings.length) return [];

  const prefix = codePrefix(stageKey);
  const existing = await one<{ max: string | null }>(
    `SELECT MAX(finding_code) AS max FROM run_findings
      WHERE run_id = ? AND finding_code LIKE ?`,
    runId,
    `${prefix}-%`,
  );
  let seq = existing?.max ? Number(existing.max.split('-').pop()) || 0 : 0;

  const ids: string[] = [];
  for (const finding of findings) {
    const id = uuid();
    const at = now();
    ids.push(id);
    await exec(
      `INSERT INTO run_findings
         (id, run_id, stage_key, finding_code, kind, defect_kind, severity, category,
          title, what_is_wrong, why_it_matters, location_json, fix_json,
          authority_status, authority_citation, authority_source_span, claimed_citation,
          evidence_json, amounts_json, owner, status, status_note, confidence,
          lineage_key, carried_from_finding_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      runId,
      stageKey,
      `${prefix}-${String(++seq).padStart(3, '0')}`,
      finding.kind,
      finding.defectKind ?? null,
      finding.severity ?? null,
      finding.category,
      finding.title,
      finding.whatIsWrong,
      finding.whyItMatters ?? null,
      finding.location ? JSON.stringify(finding.location) : null,
      finding.fix ? JSON.stringify(finding.fix) : null,
      finding.authorityStatus ?? 'none_required',
      finding.authorityCitation ?? null,
      finding.authoritySourceSpan ?? null,
      finding.claimedCitation ?? null,
      finding.evidence ? JSON.stringify(finding.evidence) : null,
      finding.amounts ? JSON.stringify(finding.amounts) : null,
      finding.owner ?? null,
      finding.status ?? 'open',
      finding.statusNote ?? null,
      finding.confidence ?? null,
      finding.lineageKey ?? null,
      finding.carriedFromFindingId ?? null,
      at,
      at,
    );
  }

  await bumpRegisterVersion(runId);
  return all<RunFindingRow>(
    `SELECT * FROM run_findings WHERE id IN (${ids.map(() => '?').join(',')})
      ORDER BY finding_code`,
    ...ids,
  );
}

export const listFindings = (runId: string) =>
  all<RunFindingRow>(
    `SELECT * FROM run_findings WHERE run_id = ? ORDER BY finding_code`,
    runId,
  );

export const getFinding = (id: string) =>
  one<RunFindingRow>(`SELECT * FROM run_findings WHERE id = ?`, id);

/**
 * Changes a finding's workflow state and bumps the register version in one
 * statement.
 *
 * Only status, its note, and the question link are mutable. What the pipeline
 * wrote — the prose, the amounts, the severity — is immutable for the life of
 * the run; a correction is a new run, which is what makes a run-to-run diff
 * mean something.
 */
export async function updateFindingStatus(
  actorId: string | null,
  findingId: string,
  patch: { status?: FindingStatus; statusNote?: string | null; questionId?: string | null },
): Promise<RunFindingRow | null> {
  const rows = await all<RunFindingRow>(
    `WITH target AS (
       SELECT run_id FROM run_findings WHERE id = ?
     ), bumped AS (
       UPDATE review_runs SET register_version = register_version + 1
        WHERE id = (SELECT run_id FROM target)
     )
     UPDATE run_findings
        SET status      = COALESCE(?, status),
            status_note = COALESCE(?, status_note),
            question_id = COALESCE(?, question_id),
            updated_at  = ?
      WHERE id = ?
      RETURNING *`,
    findingId,
    patch.status ?? null,
    patch.statusNote ?? null,
    patch.questionId ?? null,
    now(),
    findingId,
  );
  const row = rows[0] ?? null;
  if (row) {
    await audit(actorId, 'review.finding_status', 'run_finding', findingId, {
      runId: row.run_id,
      code: row.finding_code,
      status: row.status,
    });
  }
  return row;
}

/** Clears a stage's output so a retry cannot leave two copies of its findings. */
export async function clearStageOutput(runId: string, stageKey: StageKey): Promise<void> {
  await exec(`DELETE FROM run_findings WHERE run_id = ? AND stage_key = ?`, runId, stageKey);
  await exec(`DELETE FROM run_tie_outs WHERE run_id = ? AND stage_key = ?`, runId, stageKey);
  await exec(`DELETE FROM run_calcs   WHERE run_id = ? AND stage_key = ?`, runId, stageKey);
}

/**
 * Records that a named person checked an unverifiable figure against its source.
 *
 * The figure keeps its source_kind — it was still read off a page, and pretending
 * otherwise would lose the reason it needed confirming. What changes is that
 * somebody is now on the record as having looked, which is the only thing that
 * can substitute for a check the platform cannot perform.
 *
 * A finding escalated solely because of unconfirmed figures returns to open once
 * the last of them is confirmed. One escalated for low model confidence stays
 * escalated: that was never about the figures.
 */
export async function confirmAmount(
  actorId: string,
  findingId: string,
  label: string,
): Promise<RunFindingRow | null> {
  const finding = await one<RunFindingRow>(`SELECT * FROM run_findings WHERE id = ?`, findingId);
  if (!finding) return null;

  let amounts: FindingAmount[];
  try {
    amounts = JSON.parse(finding.amounts_json || '[]') as FindingAmount[];
  } catch {
    return null;
  }

  const target = amounts.find((a) => a.label === label && a.needs_confirmation);
  if (!target) return finding;

  target.needs_confirmation = false;
  target.confirmed_by = actorId;
  target.confirmed_at = now();

  const stillWaiting = amounts.some((a) => a.needs_confirmation);
  const wasFigureEscalation =
    finding.status === 'escalated' && (finding.status_note ?? '').includes('page image');

  const rows = await all<RunFindingRow>(
    `WITH bumped AS (
       UPDATE review_runs SET register_version = register_version + 1 WHERE id = ?
     )
     UPDATE run_findings
        SET amounts_json = ?, status = ?, status_note = ?, updated_at = ?
      WHERE id = ?
      RETURNING *`,
    finding.run_id,
    JSON.stringify(amounts),
    !stillWaiting && wasFigureEscalation ? 'open' : finding.status,
    !stillWaiting && wasFigureEscalation
      ? 'Figures confirmed against the source by a named reviewer.'
      : finding.status_note,
    now(),
    findingId,
  );

  await audit(actorId, 'review.amount_confirmed', 'run_finding', findingId, {
    runId: finding.run_id,
    code: finding.finding_code,
    label,
    value: target.value,
  });
  return rows[0] ?? null;
}

/* -------------------------------------------------------------- tie-outs */

export async function insertTieOuts(
  runId: string,
  stageKey: StageKey,
  tieOuts: {
    name: string;
    leftValue: number | null;
    rightValue: number | null;
    leftSource?: string | null;
    rightSource?: string | null;
    agrees: boolean;
    findingId?: string | null;
  }[],
): Promise<void> {
  for (const tie of tieOuts) {
    await exec(
      `INSERT INTO run_tie_outs
         (id, run_id, stage_key, name, left_value, right_value,
          left_source, right_source, agrees, finding_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuid(),
      runId,
      stageKey,
      tie.name,
      tie.leftValue,
      tie.rightValue,
      tie.leftSource ?? null,
      tie.rightSource ?? null,
      tie.agrees ? 1 : 0,
      tie.findingId ?? null,
      now(),
    );
  }
}

export const listTieOuts = (runId: string) =>
  all<RunTieOutRow>(`SELECT * FROM run_tie_outs WHERE run_id = ? ORDER BY created_at`, runId);

/* ----------------------------------------------------------------- calcs */

export async function recordCalc(
  runId: string,
  stageKey: StageKey,
  input: { explanation?: string | null; code: string; output: string; values: number[] },
): Promise<RunCalcRow> {
  const id = uuid();
  await exec(
    `INSERT INTO run_calcs (id, run_id, stage_key, explanation, code, output, values_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    runId,
    stageKey,
    input.explanation ?? null,
    input.code,
    input.output,
    JSON.stringify(input.values),
    now(),
  );
  return (await one<RunCalcRow>(`SELECT * FROM run_calcs WHERE id = ?`, id))!;
}

export const listCalcs = (runId: string) =>
  all<RunCalcRow>(`SELECT * FROM run_calcs WHERE run_id = ? ORDER BY created_at`, runId);

/* ------------------------------------------------------------- questions */

export interface NewQuestion {
  findingId?: string | null;
  owner: 'preparer' | 'client';
  question: string;
  figure?: string | null;
  branches?: QuestionBranch[];
  evidenceNeeded?: string | null;
  answerKind?: RunQuestionRow['answer_kind'];
  carriedFromQuestionId?: string | null;
}

export async function insertQuestions(
  runId: string,
  questions: NewQuestion[],
): Promise<RunQuestionRow[]> {
  if (!questions.length) return [];

  const existing = await one<{ count: string }>(
    `SELECT COUNT(*) AS count FROM run_questions WHERE run_id = ?`,
    runId,
  );
  let seq = Number(existing?.count ?? 0);

  const ids: string[] = [];
  for (const question of questions) {
    const id = uuid();
    ids.push(id);
    await exec(
      `INSERT INTO run_questions
         (id, run_id, question_code, finding_id, owner, question, figure,
          branches_json, evidence_needed, status, answer_kind,
          carried_from_question_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id,
      runId,
      `Q-${++seq}`,
      question.findingId ?? null,
      question.owner,
      question.question,
      question.figure ?? null,
      question.branches ? JSON.stringify(question.branches) : null,
      question.evidenceNeeded ?? null,
      question.answerKind ?? null,
      question.carriedFromQuestionId ?? null,
      now(),
    );
  }

  await bumpRegisterVersion(runId);
  return all<RunQuestionRow>(
    `SELECT * FROM run_questions WHERE id IN (${ids.map(() => '?').join(',')})
      ORDER BY created_at`,
    ...ids,
  );
}

export const listQuestions = (runId: string) =>
  all<RunQuestionRow>(`SELECT * FROM run_questions WHERE run_id = ? ORDER BY created_at`, runId);

export const getQuestion = (id: string) =>
  one<RunQuestionRow>(`SELECT * FROM run_questions WHERE id = ?`, id);

/**
 * Records an answer.
 *
 * answered_by comes from the session at the call site and is never taken from
 * the request body — an approval trail whose author can be typed in is not a
 * trail. Whether the answer is enough to close the linked finding is decided
 * in lib/review-engine/questions.ts, not here.
 */
export async function recordAnswer(
  actorId: string,
  questionId: string,
  input: { answerText: string; evidenceFileIds: string[]; answerKind?: RunQuestionRow['answer_kind'] },
): Promise<RunQuestionRow | null> {
  const rows = await all<RunQuestionRow>(
    `WITH target AS (
       SELECT run_id FROM run_questions WHERE id = ?
     ), bumped AS (
       UPDATE review_runs SET register_version = register_version + 1
        WHERE id = (SELECT run_id FROM target)
     )
     UPDATE run_questions
        SET status = 'answered', answer_text = ?, answer_evidence_file_ids = ?,
            answer_kind = COALESCE(?, answer_kind), answered_by = ?, answered_at = ?
      WHERE id = ?
      RETURNING *`,
    questionId,
    input.answerText,
    JSON.stringify(input.evidenceFileIds),
    input.answerKind ?? null,
    actorId,
    now(),
    questionId,
  );
  const row = rows[0] ?? null;
  if (row) {
    await audit(actorId, 'review.question_answered', 'run_question', questionId, {
      runId: row.run_id,
      code: row.question_code,
      evidenceCount: input.evidenceFileIds.length,
    });
  }
  return row;
}

/* ------------------------------------------------------------- approvals */

/**
 * Records a named sign-off against the exact register version the approver saw.
 *
 * The caller checks that version against the run's current one first and
 * refuses a stale approval; storing it here regardless would be recording that
 * somebody approved a document that had already changed.
 */
export async function recordApproval(
  actorId: string,
  runId: string,
  input: { registerVersionSeen: number; verdictSeen: Verdict; note?: string | null },
): Promise<RunApprovalRow> {
  const id = uuid();
  await exec(
    `INSERT INTO run_approvals
       (id, run_id, approved_by, approved_at, register_version_seen, verdict_seen, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    runId,
    actorId,
    now(),
    input.registerVersionSeen,
    input.verdictSeen,
    input.note ?? null,
  );
  await audit(actorId, 'review.approved', 'review_run', runId, {
    registerVersion: input.registerVersionSeen,
    verdict: input.verdictSeen,
  });
  return (await one<RunApprovalRow>(`SELECT * FROM run_approvals WHERE id = ?`, id))!;
}

export const listApprovals = (runId: string) =>
  all<RunApprovalRow>(
    `SELECT * FROM run_approvals WHERE run_id = ? ORDER BY approved_at DESC`,
    runId,
  );

/**
 * The approval that still stands, if any.
 *
 * An approval whose register_version_seen has been overtaken is not current —
 * that is rule 7, and expressing it as a comparison rather than a nullable
 * column means no code path can forget to clear it.
 */
export async function currentApproval(
  runId: string,
): Promise<(RunApprovalRow & { approver_name: string }) | null> {
  // LEFT JOIN: approved_by carries no foreign key, so that a sign-off outlives
  // the account that made it. An approval by somebody since removed still
  // stands and still has to render.
  return one<RunApprovalRow & { approver_name: string }>(
    `SELECT a.*, COALESCE(u.display_name, '(removed user)') AS approver_name
       FROM run_approvals a
       LEFT JOIN users u ON u.id = a.approved_by
       JOIN review_runs r ON r.id = a.run_id
      WHERE a.run_id = ? AND a.register_version_seen = r.register_version
      ORDER BY a.approved_at DESC
      LIMIT 1`,
    runId,
  );
}

/* ---------------------------------------------------------------- events */

export async function appendEvent(runId: string, payload: unknown): Promise<void> {
  await exec(
    `INSERT INTO run_events (run_id, payload, created_at) VALUES (?, ?, ?)`,
    runId,
    JSON.stringify(payload),
    now(),
  );
}

export const eventsAfter = (runId: string, cursor: number, limit = 500) =>
  all<{ id: string; payload: string }>(
    `SELECT id, payload FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?`,
    runId,
    cursor,
    limit,
  );

export const pruneEvents = (runId: string) =>
  exec(`DELETE FROM run_events WHERE run_id = ?`, runId);

/* --------------------------------------------------------------- private */

/**
 * Used only where a mutation cannot be folded into one statement with its bump
 * — inserts, which create rows rather than updating one addressable row.
 */
async function bumpRegisterVersion(runId: string): Promise<void> {
  await exec(
    `UPDATE review_runs SET register_version = register_version + 1 WHERE id = ?`,
    runId,
  );
}

/** Exposed for the approve route, which reads the version it is validating. */
export async function registerVersion(runId: string): Promise<number | null> {
  const row = await one<{ register_version: number }>(
    `SELECT register_version FROM review_runs WHERE id = ?`,
    runId,
  );
  return row?.register_version ?? null;
}
