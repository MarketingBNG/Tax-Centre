import crypto from 'node:crypto';
import { currentUser, unauthorized, badRequest, notFound } from '@/lib/auth';
import { all } from '@/lib/db';
import { REVIEW_MODEL, REVIEW_PROMPT_VERSION } from '@/lib/config';
import {
  addRunDocuments,
  createRun,
  createStages,
  currentFacts,
  getEngagement,
  listRuns,
  nextRunNumber,
} from '@/lib/review-engine/store';
import { checkInputs } from '@/lib/review-engine/input-gate';
import { planStages } from '@/lib/review-engine/stage-defs';
import { recordPlannedGaps } from '@/lib/review-engine/orchestrator';
import { DOC_ROLES, type DocRole } from '@/lib/review-types';
import type { FileRow } from '@/lib/types';

/** Runs for one engagement. */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const engagementId = new URL(req.url).searchParams.get('engagementId');
  if (!engagementId) return badRequest('engagementId is required');

  const runs = await listRuns(engagementId);
  return Response.json(
    runs.map((run) => ({
      id: run.id,
      runNumber: run.run_number,
      status: run.status,
      verdict: run.verdict,
      registerVersion: run.register_version,
      haltReason: run.halt_reason,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
    })),
  );
}

/**
 * Creates a run.
 *
 * Nothing is sent to a model here. The input gate decides first whether the
 * review can proceed at all, and a run that cannot is still created — as
 * blocked_inputs, carrying the list of what is missing — so the team has a
 * record that a review was attempted and why it did not start, rather than an
 * error message that disappears when the tab closes.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => ({}));

  const engagementId = String(body.engagementId ?? '');
  const engagement = await getEngagement(engagementId);
  if (!engagement) return notFound();

  const documents: { fileId: string; docRole: DocRole }[] = Array.isArray(body.documents)
    ? body.documents.map((d: Record<string, unknown>) => ({
        fileId: String(d.fileId ?? ''),
        docRole: String(d.docRole ?? 'other') as DocRole,
      }))
    : [];

  if (!documents.length) return badRequest('A review needs at least one document');
  for (const doc of documents) {
    if (!DOC_ROLES.includes(doc.docRole)) return badRequest(`Unknown document role: ${doc.docRole}`);
  }

  // Every file has to exist and still be readable. Ownership is not checked:
  // a review is firm-visible work, and the preparer who uploaded the trial
  // balance is routinely not the reviewer who starts the run.
  const ids = documents.map((d) => d.fileId);
  const files = await all<FileRow>(
    `SELECT * FROM files WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    ...ids,
  );
  if (files.length !== ids.length) {
    const found = new Set(files.map((f) => f.id));
    return badRequest(`Some documents no longer exist: ${ids.filter((id) => !found.has(id)).join(', ')}`);
  }

  const facts = await currentFacts(engagementId);
  const gate = checkInputs(engagement.return_type, documents.map((d) => d.docRole));

  /**
   * What the run saw, reduced to one hash.
   *
   * Covers the document bytes, the facts, the stage sequence and the prompt
   * version — everything that could make two runs of the same engagement reach
   * different conclusions. Two runs sharing a corpus_hash examined the same
   * world, which is what makes a finding defensible months later.
   */
  const corpusHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        promptVersion: REVIEW_PROMPT_VERSION,
        model: REVIEW_MODEL,
        facts,
        returnType: engagement.return_type,
        documents: [...documents]
          .map((d) => ({ role: d.docRole, sha: files.find((f) => f.id === d.fileId)?.sha256 }))
          .sort((a, b) => `${a.role}${a.sha}`.localeCompare(`${b.role}${b.sha}`)),
      }),
    )
    .digest('hex');

  const parentRunId = (await listRuns(engagementId))[0]?.id ?? null;
  const runNumber = await nextRunNumber(engagementId);

  const run = await createRun(user.id, {
    engagementId,
    runNumber,
    parentRunId,
    status: gate.ok ? 'pending' : 'blocked_inputs',
    haltReason: gate.ok ? null : `missing_inputs:${gate.missing.map((m) => m.role).join(',')}`,
    promptVersion: REVIEW_PROMPT_VERSION,
    model: REVIEW_MODEL,
    corpusHash,
    factsSnapshot: facts,
  });

  await addRunDocuments(
    run.id,
    documents.map((d) => ({
      ...d,
      // Chosen per file once there is more than one parser; today every
      // document is read the same way.
      parserId: 'model-visual',
      parserConfidence: files.find((f) => f.id === d.fileId)?.extracted_text ? 0.95 : 0.6,
    })),
  );

  // The stage plan is recorded even for a blocked run, so the progress rail can
  // show what would have run and why it did not.
  const plan = planStages({ returnType: engagement.return_type, facts });
  await createStages(
    run.id,
    plan.map((p) => ({ stageKey: p.stageKey, seq: p.seq, status: p.status })),
  );

  // What the run already knows it will not cover goes on the register now: a
  // module this engagement does not need, and any document the gate allowed it
  // to start without. Neither is ever claimed as a stage, so nothing later
  // would write them down.
  await recordPlannedGaps(run.id, {
    notApplicable: plan
      .filter((p) => p.status === 'not_applicable')
      .map((p) => ({ stageKey: p.stageKey, reason: p.reason })),
    missingInputs: gate.warnings,
  });

  return Response.json(
    {
      id: run.id,
      runNumber: run.run_number,
      status: run.status,
      gate: {
        ok: gate.ok,
        missing: gate.missing,
        warnings: gate.warnings,
      },
      stages: plan,
    },
    { status: 201 },
  );
}
