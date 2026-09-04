import crypto from 'node:crypto';
import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { REVIEW_PROMPT_VERSION } from '@/lib/config';
import {
  addRunDocuments,
  createRun,
  createStages,
  currentFacts,
  getEngagement,
  getRun,
  insertFindings,
  insertQuestions,
  listFindings,
  listQuestions,
  listRunDocuments,
  nextRunNumber,
  completeStage,
  listStages,
} from '@/lib/review-engine/store';
import { planStages } from '@/lib/review-engine/stage-defs';
import { stagesToRerun } from '@/lib/review-engine/versioning';
import { recordPlannedGaps } from '@/lib/review-engine/orchestrator';
import type { StageKey } from '@/lib/review-types';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Creates the next run from this one.
 *
 * Only the stages an answer could have affected actually re-run. The rest are
 * carried forward with their findings copied and their lineage recorded, so the
 * new run is a complete register rather than a partial one — a reviewer opening
 * run 2 should see the whole return, not only the parts that moved.
 *
 * The cascade is the skill's own: books drive the return, so a corrected book
 * figure re-runs everything downstream of it, while an answer about a
 * particular international form re-runs that module alone. Stage 4 always
 * re-runs, because the questions and the verdict are derived.
 *
 * Pass { full: true } to redo everything — the escape hatch for when the
 * dependency reasoning is not trusted, which is a legitimate thing to want.
 */
export async function POST(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const previous = await getRun(id);
  if (!previous) return notFound();

  const engagement = await getEngagement(previous.engagement_id);
  if (!engagement) return notFound();

  const body = await req.json().catch(() => ({}));
  const full = Boolean(body.full);

  const [priorFindings, priorQuestions, priorDocs, priorStages] = await Promise.all([
    listFindings(id),
    listQuestions(id),
    listRunDocuments(id),
    listStages(id),
  ]);

  // Documents may be swapped for corrected ones. Anything not named carries
  // over, so a re-run after fixing the return only needs the new export.
  const replacements: { fileId: string; docRole: string }[] = Array.isArray(body.documents)
    ? body.documents.map((d: Record<string, unknown>) => ({
        fileId: String(d.fileId ?? ''),
        docRole: String(d.docRole ?? 'other'),
      }))
    : [];
  const replacedRoles = new Set(replacements.map((d) => d.docRole));

  const documents = [
    ...priorDocs
      .filter((doc) => !replacedRoles.has(doc.doc_role))
      .map((doc) => ({ fileId: doc.file_id, docRole: doc.doc_role })),
    ...replacements.map((d) => ({ fileId: d.fileId, docRole: d.docRole as never })),
  ];

  // Which stages an answer touched. A question's finding says which stage
  // raised it, and that is what the cascade keys off.
  const answeredFindingIds = new Set(
    priorQuestions.filter((q) => q.status === 'answered' && q.finding_id).map((q) => q.finding_id),
  );
  const touched = [
    ...new Set(
      priorFindings
        .filter((f) => answeredFindingIds.has(f.id))
        .map((f) => f.stage_key as StageKey),
    ),
  ];

  const facts = await currentFacts(previous.engagement_id);
  const rerunning = full
    ? (planStages({ returnType: engagement.return_type, facts }).map((s) => s.stageKey) as StageKey[])
    : stagesToRerun({ touched, documentsChanged: replacements.length > 0 });

  const runNumber = await nextRunNumber(previous.engagement_id);
  const corpusHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        promptVersion: REVIEW_PROMPT_VERSION,
        model: previous.model,
        facts,
        returnType: engagement.return_type,
        documents: [...documents].map((d) => d.fileId).sort(),
      }),
    )
    .digest('hex');

  const run = await createRun(user.id, {
    engagementId: previous.engagement_id,
    runNumber,
    parentRunId: previous.id,
    status: 'pending',
    promptVersion: REVIEW_PROMPT_VERSION,
    model: previous.model,
    corpusHash,
    factsSnapshot: facts,
  });

  await addRunDocuments(run.id, documents);

  const plan = planStages({ returnType: engagement.return_type, facts });
  await createStages(
    run.id,
    plan.map((stage) => ({
      stageKey: stage.stageKey,
      seq: stage.seq,
      status:
        stage.status === 'not_applicable'
          ? 'not_applicable'
          : rerunning.includes(stage.stageKey)
            ? 'pending'
            : 'carried_forward',
    })),
  );

  // Applicability is re-decided from the current facts, so the not-applicable
  // lines are written fresh rather than carried over — an answer may have made
  // a module apply that did not before, or the reverse.
  await recordPlannedGaps(run.id, {
    notApplicable: plan
      .filter((stage) => stage.status === 'not_applicable')
      .map((stage) => ({ stageKey: stage.stageKey, reason: stage.reason })),
  });

  // Copy the findings of every stage that is not re-running, so the new
  // register is whole. Statuses come across as they stood, including the
  // answered-pending-evidence ones — a re-run must not quietly clear those.
  const carried = plan.filter(
    (stage) => stage.status !== 'not_applicable' && !rerunning.includes(stage.stageKey),
  );

  for (const stage of carried) {
    const source = priorFindings.filter((f) => f.stage_key === stage.stageKey);
    if (source.length) {
      await insertFindings(
        run.id,
        stage.stageKey,
        source.map((f) => ({
          kind: f.kind,
          defectKind: f.defect_kind,
          severity: f.severity,
          category: f.category,
          title: f.title,
          whatIsWrong: f.what_is_wrong,
          whyItMatters: f.why_it_matters,
          location: f.location_json ? JSON.parse(f.location_json) : null,
          fix: f.fix_json ? JSON.parse(f.fix_json) : null,
          authorityStatus: f.authority_status,
          authorityCitation: f.authority_citation,
          authoritySourceSpan: f.authority_source_span,
          claimedCitation: f.claimed_citation,
          evidence: f.evidence_json ? JSON.parse(f.evidence_json) : [],
          amounts: f.amounts_json ? JSON.parse(f.amounts_json) : [],
          owner: f.owner,
          status: f.status,
          statusNote: f.status_note,
          confidence: f.confidence,
          lineageKey: f.lineage_key,
          carriedFromFindingId: f.id,
        })),
      );
    }

    const stageRow = (await listStages(run.id)).find((s) => s.stage_key === stage.stageKey);
    const from = priorStages.find((s) => s.stage_key === stage.stageKey);
    if (stageRow) {
      await completeStage(stageRow.id, {
        status: 'carried_forward',
        carriedFromStageId: from?.id ?? null,
      });
    }
  }

  // Questions nobody answered come across as ignored, so "asked twice and
  // never answered" is visible rather than quietly disappearing.
  const unanswered = priorQuestions.filter((q) => q.status === 'open');
  if (unanswered.length) {
    await insertQuestions(
      run.id,
      unanswered.map((q) => ({
        findingId: null,
        owner: q.owner,
        question: q.question,
        figure: q.figure,
        branches: q.branches_json ? JSON.parse(q.branches_json) : [],
        evidenceNeeded: q.evidence_needed,
        answerKind: q.answer_kind,
        carriedFromQuestionId: q.id,
      })),
    );
  }

  return Response.json(
    {
      id: run.id,
      runNumber: run.run_number,
      rerunning,
      carriedForward: carried.map((s) => s.stageKey),
      questionsCarried: unanswered.length,
    },
    { status: 201 },
  );
}
