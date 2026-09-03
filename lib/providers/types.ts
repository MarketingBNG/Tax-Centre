import type { NormalisedUsage, ToolRun } from '../types';

export type ProviderId = 'openai';

/** What the provider can and cannot do. */
export interface ProviderCapabilities {
  nativePdf: boolean;
  promptCaching: 'explicit-breakpoints' | 'automatic' | 'none';
  maxRequestBytes: number | null;
  maxPdfPages: number | null;
  tools: boolean;
  /** Whether a reasoning summary can be streamed back alongside the answer. */
  thinking: boolean;
}

/** Provider-neutral content parts, built by lib/ingest.ts. */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; title: string; base64: string }
  | { kind: 'image'; title: string; mediaType: string; base64: string }
  | { kind: 'text-doc'; title: string; text: string };

export interface ChatResult {
  text: string;
  thinking: string;
  model: string;
  usage: NormalisedUsage;
  costMicros: number;
  /** 'length' means the answer was cut off and can be continued. */
  finish: 'stop' | 'length';
  toolRuns: ToolRun[];
}

export interface Turn {
  role: 'user' | 'assistant';
  parts: Part[];
}

/** A tool the model may call mid-answer. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
}

export interface StreamChatInput {
  system: string[];
  turns: Turn[];
  model?: string;
  /** Provider-neutral reasoning budget. */
  thinking?: 'off' | 'standard' | 'extended';
  tools?: ToolSpec[];
  /**
   * Runs one tool call and returns what the model should see. Throwing is
   * fine — the message is handed back to the model as the tool's output, so a
   * bad call is something it can correct rather than a dead turn.
   */
  runTool?: (call: ToolInvocation) => Promise<string>;
  /** Text the caller wants the answer to continue from, rather than restart. */
  prefill?: string;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolRun?: (run: ToolRun) => void;
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  isConfigured(): boolean;
  chatModel(): string;

  /** One conversational turn, streamed as it is produced. */
  streamChat(input: StreamChatInput): Promise<ChatResult>;
}
