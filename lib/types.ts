export type Role = 'admin' | 'reviewer';

export interface UserRow {
  id: string;
  email: string;
  role: Role;
  display_name: string;
  is_active: number;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  review_id: string | null;
  created_at: number;
}

export type FileKind = 'pdf' | 'image' | 'docx' | 'xlsx' | 'text';

export interface FileRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  filename: string;
  mime: string;
  kind: FileKind;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  page_count: number | null;
  extracted_text: string | null;
  pii_counts: string | null;
  created_at: number;
  deleted_at: number | null;
}

export interface SkillRow {
  id: string;
  title: string;
  description: string;
  jurisdiction: string;
  body: string;
  source_filename: string | null;
  version: number;
  enabled: number;
  sort_order: number;
  token_estimate: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ReviewRow {
  id: string;
  conversation_id: string;
  user_id: string;
  status: 'running' | 'complete' | 'failed' | 'aborted';
  model: string;
  skill_ids: string;
  pass_a_text: string | null;
  summary: string | null;
  error_text: string | null;
  extraction_ok: number;
  cost_micros: number;
  created_at: number;
  finished_at: number | null;
}

export type Severity =
  | 'filing_blocking'
  | 'compliance_risk'
  | 'math_or_carryforward_error'
  | 'missed_opportunity'
  | 'documentation_gap'
  | 'presentation_nit';

export interface PageRef {
  marker: string;
  title: string | null;
  fileId: string | null;
  startPage: number | null;
  endPage: number | null;
}

export interface FindingRow {
  id: string;
  review_id: string;
  ordinal: number;
  severity: Severity;
  category: string;
  form_code: string | null;
  line_ref: string | null;
  title: string;
  detail: string;
  recommended_action: string;
  confidence: 'high' | 'medium' | 'low';
  pages: string;
  status: 'open' | 'accepted' | 'dismissed' | 'resolved';
  created_at: number;
}

export interface Finding extends Omit<FindingRow, 'pages'> {
  pages: PageRef[];
}

export interface NormalisedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Per-review totals across every model call it made. */
export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'status'; message: string }
  | { type: 'review_started'; reviewId: string; skills: { id: string; title: string; version: number }[] }
  | { type: 'usage'; phase: string; usage: NormalisedUsage; costMicros: number }
  | { type: 'done'; reviewId?: string; costMicros?: number; extractionOk?: boolean }
  | { type: 'aborted'; message: string }
  | { type: 'error'; message: string };
