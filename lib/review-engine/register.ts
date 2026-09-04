import 'server-only';
import * as store from './store';
import { requiredForms } from './obligations';
import { computeVerdict, verdictFindingsFrom } from './verdict';

/**
 * The review document, in the shape references/output-schema.md specifies.
 *
 * That file is the contract, and this is the only place that produces it —
 * everything the screens show is a projection of the same rows, so the export
 * and the summary cannot describe different reviews.
 *
 * Where a field is specified but the platform does not track it yet, it is
 * emitted as null. The schema is explicit that null means "not determined" and
 * never an empty string, so a null here is an honest statement that the
 * platform does not know, rather than a gap papered over with a zero.
 */

export async function buildRegister(runId: string): Promise<Record<string, unknown> | null> {
  const run = await store.getRun(runId);
  if (!run) return null;

  const [engagement, findings, tieOuts, questions, approval, documents] = await Promise.all([
    store.getEngagement(run.engagement_id),
    store.listFindings(runId),
    store.listTieOuts(runId),
    store.listQuestions(runId),
    store.currentApproval(runId),
    store.listRunDocuments(runId),
  ]);

  const facts = await store.currentFacts(run.engagement_id);
  const formsPresent = Array.isArray(facts.forms_present) ? facts.forms_present.map(String) : [];
  const required = requiredForms(engagement?.return_type ?? null, facts);

  const verdict = computeVerdict({
    findings: verdictFindingsFrom(findings),
    requiredForms: required,
    presentForms: formsPresent,
    facts,
    failedTieOuts: tieOuts
      .filter((t) => !t.agrees)
      .map((t) => ({ name: t.name, findingId: t.finding_id })),
  });

  const parse = <T,>(value: string | null, fallback: T): T => {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  };

  const codeOf = (findingId: string | null) =>
    findingId ? (findings.find((f) => f.id === findingId)?.finding_code ?? null) : null;

  // The information returns, split into what the return carries and what the
  // facts say it owes. Rule 4 turns on the second being a subset of the first.
  const informationForms = (list: string[]) =>
    list.filter((form) => /^(5471|5472|8858|8865|8621|3520|8938|926|8833|FBAR)/i.test(form));

  return {
    review_id: run.id,
    run_at: new Date(run.created_at).toISOString(),
    prompt_version: run.prompt_version,
    model_id: run.model,
    corpus_hash: run.corpus_hash,
    register_version: run.register_version,

    engagement: {
      client_id: run.engagement_id,
      entity_name: engagement?.entity_name ?? null,
      ein: engagement?.ein ?? null,
      return_type: engagement?.return_type ?? null,
      international_forms_present: informationForms(formsPresent),
      international_forms_required_by_engine: informationForms(required.map((r) => r.form)),
      tax_year: engagement?.tax_year ?? null,
      period_start: engagement?.period_start ?? null,
      period_end: engagement?.period_end ?? null,
      short_year: Boolean(engagement?.short_year),
      jurisdictions: Array.isArray(facts.jurisdictions) ? facts.jurisdictions : [],
      india_link: facts.india_link === true,
    },

    inputs_received: documents.map((doc) => ({
      type: doc.doc_role,
      doc_id: doc.file_id,
      received: true,
      parser: doc.parser_id,
      parser_confidence: doc.parser_confidence,
    })),

    /**
     * Coverage is specified with per-account sampling counts the platform does
     * not yet produce — those come from a structured ledger parse. What it does
     * know is which sections could not be checked, which is recorded as
     * coverage lines on the register.
     */
    coverage: {
      stage_1_accounts_sampled: null,
      stage_1_accounts_total: null,
      stage_1_accounts_not_sampled: null,
      not_checked: findings
        .filter((f) => f.kind === 'coverage')
        .map((f) => ({ id: f.finding_code, stage: f.stage_key, reason: f.what_is_wrong })),
    },

    findings: findings.map((f) => ({
      id: f.finding_code,
      stage: f.stage_key,
      title: f.title,
      what_is_wrong: f.what_is_wrong,
      location: parse(f.location_json, null),
      severity: f.severity,
      category: f.category,
      why_it_matters: f.why_it_matters,
      fix: parse(f.fix_json, null),
      authority: {
        status: f.authority_status,
        citation: f.authority_citation,
        source_span: f.authority_source_span,
        // Not in the specified schema, but the whole point of keeping it is
        // that an invented citation stays auditable rather than vanishing.
        claimed_citation: f.claimed_citation,
      },
      evidence: parse(f.evidence_json, [] as unknown[]),
      amounts: parse(f.amounts_json, [] as unknown[]),
      owner: f.owner,
      status: f.status,
      question_id: codeOf(f.question_id),
      confidence: f.confidence,
      lineage_key: f.lineage_key,
    })),

    questions: questions.map((q) => ({
      id: q.question_code,
      finding_id: codeOf(q.finding_id),
      owner: q.owner,
      question: q.question,
      figure: q.figure,
      branches: parse(q.branches_json, [] as unknown[]),
      evidence_needed: q.evidence_needed,
      answer: q.answer_text,
      answer_evidence_doc_ids: parse(q.answer_evidence_file_ids, [] as string[]),
      answered_by: q.answered_by,
      answered_at: q.answered_at ? new Date(q.answered_at).toISOString() : null,
      carried_from: q.carried_from_question_id,
    })),

    tie_outs: tieOuts.map((t) => ({
      name: t.name,
      left: t.left_value,
      right: t.right_value,
      agrees: Boolean(t.agrees),
      finding_id: codeOf(t.finding_id),
    })),

    verdict: {
      result: verdict.result,
      critical_open: verdict.criticalOpen,
      high_open: verdict.highOpen,
      conditions: verdict.conditions.map((c) => ({
        finding_id: c.code,
        owner: c.owner,
        due: null,
      })),
      positions_to_register: verdict.positionsToRegister.map((p) => ({
        finding_id: p.code,
        position: p.title,
        authority_status: 'verify',
      })),
      blockers: verdict.blockers,
    },

    approval: {
      approved_by: approval?.approver_name ?? null,
      approved_at: approval ? new Date(approval.approved_at).toISOString() : null,
      register_version_seen: approval?.register_version_seen ?? null,
    },
  };
}
