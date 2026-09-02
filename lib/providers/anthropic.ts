import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, MODELS, EFFORT } from '../config';
import { priceMicros } from './shared';
import type { NormalisedUsage } from '../types';
import type {
  AiProvider,
  ChatResult,
  JsonTool,
  Part,
  ProviderCapabilities,
  ReviewResult,
  StructuredResult,
  TextBlock,
  Turn,
} from './types';

let client: Anthropic | null = null;
function api(): Anthropic {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env and restart.');
  }
  if (!client) client = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 3 });
  return client;
}

function usageOf(raw: Record<string, unknown> = {}): NormalisedUsage {
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: n(raw.input_tokens),
    outputTokens: n(raw.output_tokens),
    cacheReadTokens: n(raw.cache_read_input_tokens),
    cacheWriteTokens: n(raw.cache_creation_input_tokens),
  };
}

/** Documents first with citations enabled, then the instruction text. */
function toContent(parts: Part[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  for (const part of parts) {
    if (part.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: part.base64 },
        title: part.title,
        citations: { enabled: true },
      });
    } else if (part.kind === 'text-doc') {
      blocks.push({
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: part.text },
        title: part.title,
        citations: { enabled: true },
      });
    } else if (part.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType, data: part.base64 },
      });
    } else {
      blocks.push({ type: 'text', text: part.text });
    }
  }

  // Cache the document prefix so follow-up turns read it back at 0.1x rather
  // than re-billing the whole return. The last document block is the boundary.
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'document' || blocks[i].type === 'image') {
      blocks[i].cache_control = { type: 'ephemeral' };
      break;
    }
  }
  return blocks;
}

function systemBlocks(system: string[]) {
  // Two breakpoints: the frozen preamble (shared org-wide) and the skill bundle
  // (shared until skills change). Nothing volatile may appear here.
  return system.map((text) => ({
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' },
  }));
}

export const anthropicProvider: AiProvider = {
  id: 'anthropic',

  capabilities(): ProviderCapabilities {
    return {
      nativePdf: true,
      citations: true,
      promptCaching: 'explicit-breakpoints',
      maxRequestBytes: 32 * 1024 * 1024,
      maxPdfPages: 600,
    };
  },

  isConfigured: () => Boolean(ANTHROPIC_API_KEY),
  reviewModel: () => MODELS.reviewer,

  async streamReview({ system, parts, onText, signal }): Promise<ReviewResult> {
    const model = MODELS.reviewer;

    const stream = api().messages.stream({
      model,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      system: systemBlocks(system),
      messages: [{ role: 'user', content: toContent(parts) }],
    } as never, { signal });

    if (onText) stream.on('text', (delta: string) => onText(delta));

    // Citations come from the assembled final message, not from an unverified
    // mid-stream delta shape.
    const message = (await stream.finalMessage()) as unknown as {
      content: { type: string; text?: string; citations?: Record<string, unknown>[] | null }[];
      stop_reason: string | null;
      stop_details?: { explanation?: string } | null;
      usage: Record<string, unknown>;
    };

    if (message.stop_reason === 'refusal') {
      throw new Error(
        'Claude declined this request: ' + (message.stop_details?.explanation || 'no reason given'),
      );
    }

    const blocks: TextBlock[] = message.content
      .filter((b) => b.type === 'text')
      .map((b) => ({
        text: b.text ?? '',
        citations: (b.citations ?? []).map((c) => ({
          citedText: (c.cited_text as string) ?? '',
          documentIndex: Number(c.document_index ?? 0),
          documentTitle: (c.document_title as string) ?? null,
          startPage: (c.start_page_number as number) ?? null,
          endPage: (c.end_page_number as number) ?? null,
        })),
      }));

    const usage = usageOf(message.usage);
    return { blocks, model, usage, costMicros: priceMicros(model, usage) };
  },

  async extract<T>({
    system,
    userText,
    tool,
  }: {
    system: string;
    userText: string;
    tool: JsonTool;
  }): Promise<StructuredResult<T>> {
    const model = MODELS.extractor;

    const message = (await api().messages.create({
      model,
      max_tokens: 16000,
      system,
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema, strict: true }],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: userText }],
    } as never)) as unknown as {
      content: { type: string; name?: string; input?: unknown }[];
      usage: Record<string, unknown>;
    };

    const block = message.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    const usage = usageOf(message.usage);
    return {
      data: (block?.input as T) ?? null,
      model,
      usage,
      costMicros: priceMicros(model, usage),
    };
  },

  async streamChat({ system, turns, onText, signal }): Promise<ChatResult> {
    const model = MODELS.chat;

    const stream = api().messages.stream({
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      system: systemBlocks(system),
      messages: turns.map((t) => ({ role: t.role, content: toContent(t.parts) })),
    } as never, { signal });

    if (onText) stream.on('text', (delta: string) => onText(delta));

    const message = (await stream.finalMessage()) as unknown as {
      content: { type: string; text?: string }[];
      usage: Record<string, unknown>;
    };

    const usage = usageOf(message.usage);
    return {
      text: message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      model,
      usage,
      costMicros: priceMicros(model, usage),
    };
  },
};
