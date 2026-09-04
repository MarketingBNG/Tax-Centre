/**
 * Types for the review engine.
 *
 * The database rows and the vocabularies they use, kept in one place so the
 * schema in lib/db.ts, the engine modules and the UI cannot drift apart. The
 * field names deliberately mirror
 * Skills/Tax-Review-Skills/tax-return-review/references/output-schema.md —
 * that document is the contract, and a rename here is a change to it.
 *
 * No 'server-only' marker: the UI imports the vocabularies and the view shapes.
 * Nothing in this file touches the database or a secret.
 */

/* ------------------------------------------------------------ vocabularies */

export const RETURN_TYPES = [
  '1065',
  '1120',
  '1120-S',
  '1120-F',
  '1120-DRE-5472',
  '1040',
  '1040-NR',
  '1040-DUAL',
] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];

/**
 * The stage sequence, in the only order it may run.
 *
 * Stage 3 is four units rather than one so that each fits comfortably inside a
 * serverless invocation, and so a re-run can redo the international module
 * without redoing the federal one.
 */
export const STAGE_KEYS = [
  'S0',
  'S1',
  'S2',
  'S3-FED',
  'S3-INTL',
  'S3-STATE',
  'S3-INDIA',
  'S4',
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export type StageStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'skipped'
  | 'not_applicable'
  /** Copied from the previous run because nothing it depends on changed. */
  | 'carried_forward';

export type RunStatus =
  /** Required inputs are missing; the run has not started and must not. */
  | 'blocked_inputs'
  | 'pending'
  | 'running'
  /** Stopped early — a Stage 0 identity failure makes everything after it moot. */
  | 'halted'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

/** Worst first. The order the summary page ranks by. */
export const SEVERITY_ORDER: Severity[] = ['Critical', 'High', 'Medium', 'Low'];

/**
 * What sort of defect the model says this is.
 *
 * A closed vocabulary because it is the only input to the severity tree in
 * lib/review-engine/severity.ts. The model names the defect; code decides how
 * bad it is.
 */
export const DEFECT_KINDS = [
  'wrong_amount',
  'wrong_classification',
  'missing_form',
  'wrong_entity_type',
  'unsupported_position',
  'unexplained_tieout_failure',
  'missing_evidence',
  'presentation',
] as const;
export type DefectKind = (typeof DEFECT_KINDS)[number];

export type FindingKind = 'exception' | 'agreed' | 'coverage';

export type FindingStatus =
  | 'open'
  /** Answered in words with nothing attached. Still counts as open. */
  | 'answered_pending_evidence'
  | 'answered'
  | 'closed'
  | 'changed'
  /** Below the confidence threshold, or unresolvable — a human decides. */
  | 'escalated'
  | 'client';

/** Statuses that still count against the verdict. */
export const OPEN_STATUSES: FindingStatus[] = [
  'open',
  'answered_pending_evidence',
  'escalated',
  'client',
];

export type AuthorityStatus = 'none_required' | 'grounded' | 'verify';

/**
 * The five stored category tags.
 *
 * The summary page shows six rows: these plus "high-flag", which is not stored
 * anywhere because it is severity IN ('Critical','High') over this same set. A
 * Critical bookkeeping finding belongs in both rows and is one row in the
 * database. State findings fold into irs_return — the firm asked for six
 * categories, and state sits inside the return assessment.
 */
export const CATEGORIES = [
  'bookkeeping',
  'financial',
  'irs_return',
  'cross_border',
  'transfer_pricing',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  bookkeeping: 'Bookkeeping issues',
  financial: 'Financial fixes',
  irs_return: 'IRS tax return fixes',
  cross_border: 'Cross-border issues',
  transfer_pricing: 'Transfer pricing issues',
};

export type Owner = 'preparer' | 'reviewer' | 'client';

export type Verdict = 'clear' | 'release_with_conditions' | 'hold';

export const VERDICT_LABELS: Record<Verdict, string> = {
  clear: 'Clear for release',
  release_with_conditions: 'Release with conditions',
  hold: 'Hold',
};

/**
 * The roles a document can play. Which of these are mandatory depends on the
 * return type; lib/review-engine/input-gate.ts holds that matrix.
 */
export const DOC_ROLES = [
  'drake_export',
  'trial_balance_cy',
  'trial_balance_py',
  'gl_detail',
  'prior_year_return',
  'bank_statement',
  'fixed_asset_register',
  'ownership_schedule',
  'preparer_notes',
  'engagement_letter',
  /** Attached when answering a question, not at run creation. */
  'answer_evidence',
  'other',
] as const;
export type DocRole = (typeof DOC_ROLES)[number];

/**
 * How firmly an amount is tied to something outside the model.
 *
 *   calc     — produced by the sandbox; matched exactly against run_calcs.
 *   text_doc — appears in a document's extracted text; matched by substring.
 *   visual   — read off a PDF page the model could see but code cannot parse.
 *
 * Only the first two can be verified. A visual amount is recorded with
 * verified=false and a capped confidence, which is an honest description of a
 * page-image read rather than a claim about it. Structured Drake export
 * parsing is what turns those into calc-grade figures later.
 */
export type AmountSourceKind = 'calc' | 'text_doc' | 'visual';

export interface FindingAmount {
  label: string;
  value: number;
  source_kind: AmountSourceKind;
  /** A run_calcs id, a filename, or a page reference, depending on the kind. */
  source_ref: string;
  verified: boolean;
}

export interface FindingLocation {
  form: string | null;
  schedule: string | null;
  line: string | null;
  gl_account: string | null;
}

export interface FindingFix {
  where: string;
  change: string;
  then: string;
  why: string;
}

export interface FindingEvidence {
  file_id: string;
  description: string;
  where?: string | null;
}

export interface QuestionBranch {
  if: string;
  then: string;
}

/* -------------------------------------------------------------- row shapes */

export interface EngagementRow {
  id: string;
  client_label: string;
  entity_name: string | null;
  ein: string | null;
  return_type: ReturnType | null;
  tax_year: number | null;
  period_start: string | null;
  period_end: string | null;
  short_year: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface EngagementFactRow {
  id: string;
  engagement_id: string;
  key: string;
  /** JSON-encoded scalar or array. */
  value: string;
  source: 'user' | 'stage0' | 'answer';
  evidence_file_id: string | null;
  confidence: number | null;
  superseded_by: string | null;
  created_by: string | null;
  created_at: number;
}

export interface ReviewRunRow {
  id: string;
  engagement_id: string;
  run_number: number;
  parent_run_id: string | null;
  status: RunStatus;
  halt_reason: string | null;
  prompt_version: string;
  model: string;
  corpus_hash: string;
  /** JSON snapshot of the current facts when the run was created. */
  facts_snapshot: string;
  register_version: number;
  verdict: Verdict | null;
  verdict_json: string | null;
  abort_requested: number;
  heartbeat_at: number | null;
  created_by: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error_text: string | null;
}

export interface RunDocumentRow {
  run_id: string;
  file_id: string;
  doc_role: DocRole;
  document_index: number;
  parser_id: string;
  parser_confidence: number | null;
}

export interface RunStageRow {
  id: string;
  run_id: string;
  stage_key: StageKey;
  seq: number;
  status: StageStatus;
  attempt: number;
  input_hash: string | null;
  carried_from_stage_id: string | null;
  model: string | null;
  raw_output: string | null;
  usage_json: string | null;
  cost_micros: number | null;
  heartbeat_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  error_text: string | null;
}

export interface RunFindingRow {
  id: string;
  run_id: string;
  stage_key: StageKey;
  finding_code: string;
  kind: FindingKind;
  defect_kind: DefectKind | null;
  severity: Severity | null;
  category: Category;
  title: string;
  what_is_wrong: string;
  why_it_matters: string | null;
  /** JSON {@link FindingLocation}. */
  location_json: string | null;
  /** JSON {@link FindingFix}. */
  fix_json: string | null;
  authority_status: AuthorityStatus;
  authority_citation: string | null;
  authority_source_span: string | null;
  claimed_citation: string | null;
  /** JSON {@link FindingEvidence}[]. */
  evidence_json: string | null;
  /** JSON {@link FindingAmount}[]. */
  amounts_json: string | null;
  owner: Owner | null;
  status: FindingStatus;
  status_note: string | null;
  confidence: number | null;
  question_id: string | null;
  lineage_key: string | null;
  carried_from_finding_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunTieOutRow {
  id: string;
  run_id: string;
  stage_key: StageKey;
  name: string;
  left_value: number | null;
  right_value: number | null;
  left_source: string | null;
  right_source: string | null;
  agrees: number;
  finding_id: string | null;
  created_at: number;
}

export interface RunCalcRow {
  id: string;
  run_id: string;
  stage_key: StageKey;
  explanation: string | null;
  code: string;
  output: string;
  /** JSON number[] — the figures this calculation is allowed to have produced. */
  values_json: string | null;
  created_at: number;
}

export interface RunQuestionRow {
  id: string;
  run_id: string;
  question_code: string;
  finding_id: string | null;
  owner: 'preparer' | 'client';
  question: string;
  figure: string | null;
  /** JSON {@link QuestionBranch}[]. */
  branches_json: string | null;
  evidence_needed: string | null;
  status: 'open' | 'answered' | 'ignored';
  answer_kind: 'fact' | 'document' | 'yes_no' | 'text' | null;
  answer_text: string | null;
  /** JSON string[] of file ids. */
  answer_evidence_file_ids: string | null;
  answered_by: string | null;
  answered_at: number | null;
  carried_from_question_id: string | null;
  created_at: number;
}

export interface RunApprovalRow {
  id: string;
  run_id: string;
  approved_by: string;
  approved_at: number;
  register_version_seen: number;
  verdict_seen: Verdict;
  note: string | null;
}

/* ------------------------------------------------------------ helper types */

/** A parsed finding, as the API hands it to the UI. */
export interface FindingView {
  id: string;
  code: string;
  stage: StageKey;
  kind: FindingKind;
  defectKind: DefectKind | null;
  severity: Severity | null;
  category: Category;
  title: string;
  whatIsWrong: string;
  whyItMatters: string | null;
  location: FindingLocation | null;
  fix: FindingFix | null;
  authority: {
    status: AuthorityStatus;
    citation: string | null;
    sourceSpan: string | null;
    claimedCitation: string | null;
  };
  evidence: FindingEvidence[];
  amounts: FindingAmount[];
  owner: Owner | null;
  status: FindingStatus;
  statusNote: string | null;
  confidence: number | null;
  questionId: string | null;
  /** True while this still counts against the verdict. */
  isOpen: boolean;
}
