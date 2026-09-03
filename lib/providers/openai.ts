import 'server-only';
import OpenAI from 'openai';
import { OPENAI_API_KEY, MODELS, EFFORT, MAX_OUTPUT_TOKENS, MAX_TOOL_ROUNDS } from '../config';
import { isKnownModel } from '../models';
import { priceMicros, emptyUsage, addUsage } from './shared';
import type { NormalisedUsage, ToolRun } from '../types';
import type {
  AiProvider,
  ChatResult,
  Part,
  ProviderCapabilities,
  StreamChatInput,
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
const configuredEffort = () => (EFFORT_VALUES.includes(EFFORT) ? EFFORT : 'medium');

/**
 * "Off" is the provider's floor rather than a true zero: these models always
 * reason a little, and asking for none on a model that refuses it is an error
 * rather than a faster answer.
 */
function effortFor(thinking: StreamChatInput['thinking']): string {
  if (thinking === 'off') return 'none';
  if (thinking === 'extended') return 'high';
  if (thinking === 'standard') return 'medium';
  return configuredEffort();
}

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

const turnToInput = (t: Turn): Record<string, unknown> =>
  // Assistant turns cannot carry input_* content parts; a plain string is the
  // accepted shape for prior model output.
  t.role === 'assistant'
    ? {
        role: 'assistant',
        content: t.parts
          .map((p) => (p.kind === 'text' ? p.text : ''))
          .join('')
          .trim(),
      }
    : { role: 'user', content: toContent(t.parts) };

interface RoundResult {
  text: string;
  usage: NormalisedUsage;
  /** Raw output items, echoed back verbatim when a tool round follows. */
  output: Record<string, unknown>[];
  truncated: boolean;
}

/**
 * One request. Collects text and reasoning deltas as they arrive and keeps the
 * final output items, which are what a following tool round has to replay.
 */
async function runStream(
  request: Record<string, unknown>,
  handlers: { onText?: (d: string) => void; onThinking?: (d: string) => void },
  signal?: AbortSignal,
): Promise<RoundResult> {
  const stream = await api().responses.create({ ...request, stream: true } as never, { signal });

  let text = '';
  let finalUsage: Record<string, unknown> = {};
  let output: Record<string, unknown>[] = [];
  let truncated = false;

  for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
    const type = String(event.type ?? '');

    if (type === 'response.output_text.delta') {
      const delta = String(event.delta ?? '');
      text += delta;
      handlers.onText?.(delta);
    } else if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      handlers.onThinking?.(String(event.delta ?? ''));
    } else if (type === 'response.reasoning_summary_part.done') {
      // Blank line between summary sections so they do not run together.
      handlers.onThinking?.('\n\n');
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = (event.response ?? {}) as Record<string, unknown>;
      finalUsage = (response.usage ?? {}) as Record<string, unknown>;
      output = (response.output ?? []) as Record<string, unknown>[];
      const incomplete = (response.incomplete_details ?? {}) as Record<string, unknown>;
      truncated = incomplete.reason === 'max_output_tokens';
      // output_text is the assembled convenience field; prefer it if the
      // deltas were missed for any reason.
      if (!text && typeof response.output_text === 'string') text = response.output_text;
    } else if (type === 'error' || type === 'response.failed') {
      const err = (event.error ?? {}) as Record<string, unknown>;
      throw new Error(String(err.message ?? 'The model request failed.'));
    }
  }

  return { text, usage: usageOf(finalUsage), output, truncated };
}

/** Trimmed for the collapsed one-line header above a tool panel. */
function summarise(name: string, args: Record<string, unknown>): string {
  if (name === 'run_analysis') {
    const why = String(args.explanation ?? '').trim();
    return why || 'Ran a calculation';
  }
  if (name === 'remember') return `Remembered: ${String(args.fact ?? '').slice(0, 80)}`;
  if (name === 'forget') return 'Forgot a remembered fact';

  // mcp__<connector>__<tool> reads badly in a header; show the two halves.
  const parts = name.split('__');
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return `${parts[1].replace(/_/g, ' ')} · ${parts.slice(2).join('__').replace(/_/g, ' ')}`;
  }
  return name;
}

export const openaiProvider: AiProvider = {
  id: 'openai',

  capabilities(): ProviderCapabilities {
    return {
      nativePdf: true,
      promptCaching: 'automatic',
      maxRequestBytes: 50 * 1024 * 1024,
      maxPdfPages: null,
      tools: true,
      thinking: true,
    };
  },

  isConfigured: () => Boolean(OPENAI_API_KEY),
  chatModel: () => MODELS.chat,

  async streamChat(input: StreamChatInput): Promise<ChatResult> {
    const { system, turns, tools, runTool, prefill, onText, onThinking, onToolRun, signal } =
      input;

    const model = input.model && isKnownModel(input.model) ? input.model : MODELS.chat;
    const conversation: Record<string, unknown>[] = turns.map(turnToInput);

    // Continuing a cut-off answer: hand back what was written and ask for the
    // remainder. There is no assistant prefill on this API, so the instruction
    // has to carry the "do not restart" requirement itself.
    if (prefill?.trim()) {
      conversation.push({ role: 'assistant', content: prefill });
      conversation.push({
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              'That answer was cut off. Continue it from exactly where it stops. ' +
              'Do not repeat any of it, do not re-introduce the topic, and do not ' +
              'apologise — write only the remaining text, starting mid-sentence if ' +
              'that is where it ended.',
          },
        ],
      });
    }

    const request: Record<string, unknown> = {
      model,
      instructions: system.join('\n\n'),
      reasoning:
        input.thinking === 'off'
          ? { effort: effortFor(input.thinking) }
          : { effort: effortFor(input.thinking), summary: 'auto' },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false,
    };

    if (tools?.length) {
      request.tools = tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      // Reasoning items have to survive between tool rounds, and nothing is
      // stored server-side, so the encrypted blob has to come back to us.
      request.include = ['reasoning.encrypted_content'];
    }

    let usage = emptyUsage();
    let text = '';
    let thinking = '';
    const toolRuns: ToolRun[] = [];
    let truncated = false;

    const handlers = {
      onText: (d: string) => {
        text += d;
        onText?.(d);
      },
      onThinking: (d: string) => {
        thinking += d;
        onThinking?.(d);
      },
    };

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await runStream({ ...request, input: conversation }, handlers, signal);
      usage = addUsage(usage, result.usage);
      truncated = result.truncated;

      const calls = result.output.filter((o) => o.type === 'function_call');
      if (!calls.length || !runTool) break;

      // Everything the model emitted has to be replayed, reasoning included,
      // or the API rejects the follow-up as missing its antecedent.
      conversation.push(...result.output);

      for (const call of calls) {
        const name = String(call.name ?? '');
        const rawArgs = String(call.arguments ?? '{}');
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          args = {};
        }

        const started = Date.now();
        let output: string;
        let ok = true;
        try {
          output = await runTool({ name, args });
        } catch (err) {
          ok = false;
          // Handed back rather than thrown: a bad call is something the model
          // can see and correct on the next round.
          output = `Error: ${(err as Error).message}`;
        }

        const run: ToolRun = {
          name,
          summary: summarise(name, args),
          input: rawArgs,
          output: output.slice(0, 20_000),
          ok,
          ms: Date.now() - started,
        };
        toolRuns.push(run);
        onToolRun?.(run);

        conversation.push({
          type: 'function_call_output',
          call_id: String(call.call_id ?? ''),
          output: run.output,
        });
      }

      if (round === MAX_TOOL_ROUNDS) {
        // Out of rounds. Ask once more with no tools so the turn still ends in
        // an answer rather than in silence.
        delete request.tools;
        delete request.include;
        const last = await runStream({ ...request, input: conversation }, handlers, signal);
        usage = addUsage(usage, last.usage);
        truncated = last.truncated;
        break;
      }
    }

    return {
      text,
      thinking: thinking.trim(),
      model,
      usage,
      costMicros: priceMicros(model, usage),
      finish: truncated ? 'length' : 'stop',
      toolRuns,
    };
  },
};
