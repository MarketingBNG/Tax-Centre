import 'server-only';
import OpenAI from 'openai';
import { OPENAI_API_KEY, MODELS, EFFORT } from '../config';
import { priceMicros } from './shared';
import type { NormalisedUsage } from '../types';
import type {
  AiProvider,
  ChatResult,
  Part,
  JsonTool,
  ProviderCapabilities,
  ReviewResult,
  StructuredResult,
  Turn,
} from './types';

let client: OpenAI | null = null;
function api(): OpenAI {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to .env and restart.');
  }
  if (!client) client = new OpenAI({ apiKey: OPENAI_API_KEY, maxRetries: 3 });
  return client;
}

/** Our effort scale maps 1:1 onto the Responses API reasoning effort. */
const EFFORT_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const effort = () => (EFFORT_VALUES.includes(EFFORT) ? EFFORT : 'medium');

function usageOf(raw: Record<string, unknown> = {}): NormalisedUsage {
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const details = (raw.input_tokens_details ?? {}) as Record<string, unknown>;
  const cached = n(details.cached_tokens);
  return {
    // input_tokens includes cached tokens on this API, so subtract them out to
    // match the shape the rest of the app assumes (input = uncached remainder).
    inputTokens: Math.max(0, n(raw.input_tokens) - cached),
    outputTokens: n(raw.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0, // no write premium on this provider
  };
}

function toContent(parts: Part[]): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];

  for (const part of parts) {
    if (part.kind === 'pdf') {
      content.push({
        type: 'input_file',
        filename: part.title,
        file_data: `data:application/pdf;base64,${part.base64}`,
      });
    } else if (part.kind === 'image') {
      content.push({
        type: 'input_image',
        image_url: `data:${part.mediaType};base64,${part.base64}`,
      });
    } else if (part.kind === 'text-doc') {
      // No document type here, so a converted spreadsheet or Word file is
      // delimited text. The delimiters matter: everything inside is untrusted.
      content.push({
        type: 'input_text',
        text: `<document title="${part.title}">\n${part.text}\n</document>`,
      });
    } else {
      content.push({ type: 'input_text', text: part.text });
    }
  }
  return content;
}

/** Collects text deltas from the Responses event stream. */
async function runStream(
  request: Record<string, unknown>,
  onText?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; usage: NormalisedUsage }> {
  const stream = await api().responses.create({ ...request, stream: true } as never, { signal });

  let text = '';
  let finalUsage: Record<string, unknown> = {};

  for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
    const type = String(event.type ?? '');
    if (type === 'response.output_text.delta') {
      const delta = String(event.delta ?? '');
      text += delta;
      onText?.(delta);
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = (event.response ?? {}) as Record<string, unknown>;
      finalUsage = (response.usage ?? {}) as Record<string, unknown>;
      // output_text is the assembled convenience field; prefer it if the
      // deltas were missed for any reason.
      if (!text && typeof response.output_text === 'string') text = response.output_text;
    } else if (type === 'error' || type === 'response.failed') {
      const err = (event.error ?? {}) as Record<string, unknown>;
      throw new Error(String(err.message ?? 'The model request failed.'));
    }
  }

  return { text, usage: usageOf(finalUsage) };
}

export const openaiProvider: AiProvider = {
  id: 'openai',

  capabilities(): ProviderCapabilities {
    return {
      nativePdf: true,
      // No server-computed page locations. Findings therefore carry no page
      // anchors on this provider — see the note in providers/types.ts.
      citations: false,
      promptCaching: 'automatic',
      maxRequestBytes: 50 * 1024 * 1024,
      maxPdfPages: null,
    };
  },

  isConfigured: () => Boolean(OPENAI_API_KEY),
  reviewModel: () => MODELS.reviewer,

  async streamReview({ system, parts, onText, signal }): Promise<ReviewResult> {
    const model = MODELS.reviewer;
    const { text, usage } = await runStream(
      {
        model,
        instructions: system.join('\n\n'),
        input: [{ role: 'user', content: toContent(parts) }],
        reasoning: { effort: effort() },
        max_output_tokens: 32000,
      },
      onText,
      signal,
    );

    return {
      // One block, no citations: this provider cannot anchor to a page.
      blocks: [{ text, citations: [] }],
      model,
      usage,
      costMicros: priceMicros(model, usage),
    };
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

    const response = (await api().responses.create({
      model,
      instructions: system,
      input: [{ role: 'user', content: [{ type: 'input_text', text: userText }] }],
      text: {
        format: {
          type: 'json_schema',
          name: tool.name,
          schema: tool.schema,
          strict: true,
        },
      },
      max_output_tokens: 16000,
    } as never)) as unknown as {
      output_text?: string;
      usage?: Record<string, unknown>;
    };

    const usage = usageOf(response.usage ?? {});
    let data: T | null = null;
    try {
      data = response.output_text ? (JSON.parse(response.output_text) as T) : null;
    } catch {
      data = null; // caller falls back to the prose report
    }

    return { data, model, usage, costMicros: priceMicros(model, usage) };
  },

  async streamChat({ system, turns, onText, signal }): Promise<ChatResult> {
    const model = MODELS.chat;
    const { text, usage } = await runStream(
      {
        model,
        instructions: system.join('\n\n'),
        input: turns.map((t: Turn) =>
          // Assistant turns cannot carry input_* content parts; a plain string
          // is the accepted shape for prior model output.
          t.role === 'assistant'
            ? {
                role: 'assistant',
                content: t.parts
                  .map((p) => (p.kind === 'text' ? p.text : ''))
                  .join('')
                  .trim(),
              }
            : { role: 'user', content: toContent(t.parts) },
        ),
        reasoning: { effort: effort() },
        max_output_tokens: 16000,
      },
      onText,
      signal,
    );

    return { text, model, usage, costMicros: priceMicros(model, usage) };
  },
};
