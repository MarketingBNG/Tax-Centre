import { currentUser, unauthorized, notFound } from '@/lib/auth';
import {
  currentApproval,
  getEngagement,
  getRun,
  listFindings,
  listQuestions,
  listStages,
  listTieOuts,
} from '@/lib/review-engine/store';
import { severityRank } from '@/lib/review-engine/severity';
import { stageDef } from '@/lib/review-engine/stage-defs';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  OPEN_STATUSES,
  type Category,
  type Severity,
} from '@/lib/review-types';

type Ctx = { params: Promise<{ id: string }> };

const parse = <T,>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/**
 * Everything one run's screens need, in one request.
 *
 * The `derived` block is computed here rather than in the browser so the
 * summary page, the print page and the engagement list cannot disagree about
 * how many items are open or which five are worst. Counting in three places is
 * how two parts of the same page end up contradicting each other.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return notFound();

  const [engagement, stages, findings, tieOuts, questions, approval] = await Promise.all([
    getEngagement(run.engagement_id),
    listStages(id),
    listFindings(id),
    listTieOuts(id),
    listQuestions(id),
    currentApproval(id),
  ]);

  const isOpen = (status: string) => OPEN_STATUSES.includes(status as never);

  const view = findings.map((f) => ({
    id: f.id,
    code: f.finding_code,
    stage: f.stage_key,
    kind: f.kind,
    defectKind: f.defect_kind,
    severity: f.severity,
    category: f.category,
    title: f.title,
    whatIsWrong: f.what_is_wrong,
    whyItMatters: f.why_it_matters,
    location: parse(f.location_json, null),
    fix: parse(f.fix_json, null),
    authority: {
      status: f.authority_status,
      citation: f.authority_citation,
      sourceSpan: f.authority_source_span,
      claimedCitation: f.claimed_citation,
    },
    evidence: parse(f.evidence_json, [] as unknown[]),
    amounts: parse(f.amounts_json, [] as unknown[]),
    owner: f.owner,
    status: f.status,
    statusNote: f.status_note,
    confidence: f.confidence,
    questionId: f.question_id,
    isOpen: isOpen(f.status),
  }));

  // Category counts. "High-flag" is computed from severity over the same rows
  // rather than stored — one tag, two lenses, so they cannot drift apart.
  const categories: Record<string, { open: number; worst: Severity | null; label: string }> = {};
  for (const category of CATEGORIES) {
    categories[category] = { open: 0, worst: null, label: CATEGORY_LABELS[category as Category] };
  }
  categories.high_flag = { open: 0, worst: null, label: 'High-flag issues' };

  const worse = (a: Severity | null, b: Severity | null) =>
    severityRank(a) <= severityRank(b) ? a : b;

  for (const finding of view) {
    if (!finding.isOpen) continue;
    const bucket = categories[finding.category];
    if (bucket) {
      bucket.open += 1;
      bucket.worst = worse(finding.severity, bucket.worst);
    }
    if (finding.severity === 'Critical' || finding.severity === 'High') {
      categories.high_flag.open += 1;
      categories.high_flag.worst = worse(finding.severity, categories.high_flag.worst);
    }
  }

  const openSorted = view
    .filter((f) => f.isOpen && f.severity)
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code),
    );

  return Response.json({
    run: {
      id: run.id,
      engagementId: run.engagement_id,
      runNumber: run.run_number,
      status: run.status,
      haltReason: run.halt_reason,
      verdict: run.verdict,
      verdictDetail: parse(run.verdict_json, null),
      registerVersion: run.register_version,
      model: run.model,
      promptVersion: run.prompt_version,
      corpusHash: run.corpus_hash,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
      errorText: run.error_text,
      abortRequested: Boolean(run.abort_requested),
    },
    engagement: engagement && {
      id: engagement.id,
      clientLabel: engagement.client_label,
      entityName: engagement.entity_name,
      ein: engagement.ein,
      returnType: engagement.return_type,
      taxYear: engagement.tax_year,
      periodStart: engagement.period_start,
      periodEnd: engagement.period_end,
    },
    stages: stages.map((s) => ({
      key: s.stage_key,
      label: stageDef(s.stage_key).label,
      seq: s.seq,
      status: s.status,
      attempt: s.attempt,
      error: s.error_text,
      costMicros: s.cost_micros,
    })),
    findings: view,
    tieOuts: tieOuts.map((t) => ({
      id: t.id,
      name: t.name,
      leftValue: t.left_value,
      rightValue: t.right_value,
      agrees: Boolean(t.agrees),
      findingId: t.finding_id,
    })),
    questions: questions.map((q) => ({
      id: q.id,
      code: q.question_code,
      findingId: q.finding_id,
      owner: q.owner,
      question: q.question,
      figure: q.figure,
      branches: parse(q.branches_json, [] as unknown[]),
      evidenceNeeded: q.evidence_needed,
      status: q.status,
      answerText: q.answer_text,
      answeredAt: q.answered_at,
    })),
    approval: approval && {
      approvedBy: approval.approver_name,
      approvedAt: approval.approved_at,
      registerVersionSeen: approval.register_version_seen,
      verdictSeen: approval.verdict_seen,
    },
    derived: {
      categories,
      topFindingIds: openSorted.slice(0, 5).map((f) => f.id),
      openCriticalHigh: openSorted.filter(
        (f) => f.severity === 'Critical' || f.severity === 'High',
      ).length,
      escalated: view.filter((f) => f.status === 'escalated').length,
    },
  });
}
