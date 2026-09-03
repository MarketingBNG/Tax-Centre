export type Role = 'admin' | 'member';

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
  /** The leaf currently being read. The visible thread is the walk back from it. */
  head_id: string | null;
  project_id: string | null;
  model: string | null;
  style: string | null;
  thinking: string | null;
  starred: number;
  archived_at: number | null;
  /** JSON array of connector ids this thread may use. */
  connectors: string | null;
}

export type FinishReason = 'stop' | 'length' | 'aborted';

/** One run of a tool, kept so the panel under an answer survives a reload. */
export interface ToolRun {
  name: string;
  /** Short human-readable line for the collapsed header. */
  summary: string;
  input: string;
  output: string;
  ok: boolean;
  ms: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
  parent_id: string | null;
  thinking: string | null;
  model: string | null;
  finish: FinishReason | null;
  /** JSON-encoded {@link ToolRun}[]. */
  tool_log: string | null;
  /** -1, 1 or null. */
  vote: number | null;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  created_at: number;
  updated_at: number;
}

export interface StyleRow {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  created_at: number;
}

export interface MemoryRow {
  id: string;
  user_id: string;
  text: string;
  source_conversation_id: string | null;
  created_at: number;
}

export interface UserPrefsRow {
  user_id: string;
  instructions: string;
  model: string | null;
  style: string | null;
  thinking: string | null;
  memory_enabled: number;
  updated_at: number;
}

export type FileKind = 'pdf' | 'image' | 'docx' | 'xlsx' | 'text';

export interface FileRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  project_id: string | null;
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

export interface NormalisedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  /** Reasoning summary, streamed separately so the UI can collapse it. */
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; run: ToolRun }
  /** Ids assigned once the turn is persisted, so the client can stop guessing. */
  | { type: 'saved'; userMessageId: string | null; assistantMessageId: string }
  | { type: 'title'; title: string }
  | { type: 'usage'; usage: NormalisedUsage; costMicros: number }
  | { type: 'done'; costMicros?: number; finish?: FinishReason }
  | { type: 'error'; message: string };

export interface ConnectorRow {
  id: string;
  name: string;
  url: string;
  auth_header: string | null;
  auth_value: string | null;
  enabled: number;
  /** JSON array of the tool names an admin has approved. */
  allowed_tools: string | null;
  /** Cached tools/list result. */
  tools_json: string | null;
  tools_fetched_at: number | null;
  last_error: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}
