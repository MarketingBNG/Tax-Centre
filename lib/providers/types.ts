import type { NormalisedUsage } from '../types';

export type ProviderId = 'anthropic' | 'openai';

/**
 * What the abstraction cannot hide, and therefore has to declare.
 *
 * `citations` is the one that changes the product rather than the plumbing:
 * only Claude returns server-computed page locations for an arbitrary PDF.
 * Where it is false, findings carry no page anchors — we do not ask the model
 * to state page numbers and present them as provenance, because an unverifiable
 * page reference in a tax review is worse than none.
 */
export interface ProviderCapabilities {
  nativePdf: boolean;
  citations: boolean;
  promptCaching: 'explicit-breakpoints' | 'automatic' | 'none';
  maxRequestBytes: number | null;
  maxPdfPages: number | null;
}

/** Provider-neutral content parts, built by lib/ingest.ts. */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; title: string; base64: string }
  | { kind: 'image'; title: string; mediaType: string; base64: string }
  | { kind: 'text-doc'; title: string; text: string };

export interface CitationRef {
  citedText: string;
  documentIndex: number;
  documentTitle: string | null;
  startPage: number | null;
  endPage: number | null;
}

export interface TextBlock {
  text: string;
  citations: CitationRef[];
}

export interface ReviewResult {
  blocks: TextBlock[];
  model: string;
  usage: NormalisedUsage;
  costMicros: number;
}

export interface StructuredResult<T> {
  data: T | null;
  model: string;
  usage: NormalisedUsage;
  costMicros: number;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: NormalisedUsage;
  costMicros: number;
}

export interface Turn {
  role: 'user' | 'assistant';
  parts: Part[];
}

export interface JsonTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface AiProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  isConfigured(): boolean;
  reviewModel(): string;

  /** Pass A — read the documents and stream the write-up. */
  streamReview(input: {
    system: string[];
    parts: Part[];
    onText?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<ReviewResult>;

  /** Pass B — structure Pass A's text. No documents attached. */
  extract<T>(input: {
    system: string;
    userText: string;
    tool: JsonTool;
  }): Promise<StructuredResult<T>>;

  /** Follow-up turns in an existing review conversation. */
  streamChat(input: {
    system: string[];
    turns: Turn[];
    onText?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<ChatResult>;
}
