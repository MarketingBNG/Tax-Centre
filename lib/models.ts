/**
 * Model and style catalogue.
 *
 * Deliberately free of `server-only` and of every environment read: the
 * composer's model picker and the style menu render this same list in the
 * browser, so it has to be importable from a client component.
 */

export interface ModelSpec {
  id: string;
  /** What the picker shows. People choose a speed/depth trade-off, not an id. */
  label: string;
  blurb: string;
  /** Whether an extended-thinking toggle does anything on this model. */
  thinking: boolean;
}

export const CHAT_MODELS: ModelSpec[] = [
  {
    id: 'gpt-5.6-luna',
    label: 'Fast',
    blurb: 'Everyday questions and document lookups',
    thinking: true,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'Balanced',
    blurb: 'Multi-step reasoning, reconciliations, longer documents',
    thinking: true,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'Deep',
    blurb: 'The hard ones — slowest and most expensive',
    thinking: true,
  },
];

export const isKnownModel = (id: string): boolean =>
  CHAT_MODELS.some((m) => m.id === id);

export const modelSpec = (id: string): ModelSpec | undefined =>
  CHAT_MODELS.find((m) => m.id === id);

export const modelLabel = (id: string): string => modelSpec(id)?.label ?? id;

/* ----------------------------------------------------------------- effort */

/**
 * How hard the model thinks before answering. `off` is not "no reasoning" on
 * every model — it is the smallest budget the provider offers — so the label
 * says Off but the value is the provider's floor.
 */
export type ThinkingLevel = 'off' | 'standard' | 'extended';

export const THINKING_LEVELS: { id: ThinkingLevel; label: string; blurb: string }[] = [
  { id: 'off', label: 'Off', blurb: 'Answer straight away' },
  { id: 'standard', label: 'Standard', blurb: 'Think a little first' },
  { id: 'extended', label: 'Extended', blurb: 'Think hard — slower, better on tricky work' },
];

export const isThinkingLevel = (v: string): v is ThinkingLevel =>
  v === 'off' || v === 'standard' || v === 'extended';

/* ----------------------------------------------------------------- styles */

export interface StylePreset {
  id: string;
  label: string;
  blurb: string;
  /** Appended to the system prompt as its own cacheable block. Empty for Normal. */
  instructions: string;
}

/**
 * The built-ins. A style is only ever a few lines: it steers shape and register,
 * and must not contradict the base prompt, because the base prompt is what keeps
 * answers grounded in the attached documents.
 */
export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'normal',
    label: 'Normal',
    blurb: 'Default',
    instructions: '',
  },
  {
    id: 'concise',
    label: 'Concise',
    blurb: 'Shorter, straight to the point',
    instructions:
      'Answer in as few words as the question genuinely needs. Lead with the ' +
      'answer, then at most a line or two of support. No preamble, no summary ' +
      'of what you are about to say, no closing offer of further help. Use a ' +
      'list only when the content is genuinely a list.',
  },
  {
    id: 'explanatory',
    label: 'Explanatory',
    blurb: 'Teaches the reasoning as it goes',
    instructions:
      'Explain your reasoning as you go, so the reader could reach the same ' +
      'conclusion themselves next time. Define the terms of art you use, say ' +
      'why a rule applies rather than only that it does, and point out the ' +
      'assumption whenever an answer rests on one.',
  },
  {
    id: 'formal',
    label: 'Formal',
    blurb: 'Client-ready register',
    instructions:
      'Write in the register of a memo to a client: complete sentences, no ' +
      'contractions, no exclamation marks, no conversational asides. Prefer ' +
      'precise nouns to hedges. State conclusions plainly and attribute every ' +
      'figure to its source document.',
  },
];

export const stylePreset = (id: string): StylePreset | undefined =>
  STYLE_PRESETS.find((s) => s.id === id);

export const DEFAULT_STYLE_ID = 'normal';
