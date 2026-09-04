import type { ToolSpec } from '@/lib/providers/types';
import { CATEGORIES, DEFECT_KINDS } from '@/lib/review-types';

/**
 * How a stage records what it found.
 *
 * Findings arrive through tool calls with a fixed schema, not as prose the
 * platform then parses. Two reasons, and the second is the important one:
 *
 *   - A shape enforced at the tool boundary is retried by the model when it is
 *     wrong, rather than silently half-parsed by a regex afterwards.
 *   - Prose invites the model to editorialise the parts that must not be
 *     editorialised. There is no `severity` field here on purpose: the model
 *     reports `defect_kind`, and code grades it. There is no `verdict` field
 *     either, for the same reason.
 *
 * Findings are recorded in batches as the stage works rather than in one final
 * document, so hitting the output ceiling costs the last batch instead of the
 * whole register.
 */

const LOCATION = {
  type: 'object',
  description: 'Where this is, on the form and in the books.',
  properties: {
    form: { type: ['string', 'null'], description: 'e.g. 1065, 1120-F, 5472' },
    schedule: { type: ['string', 'null'], description: 'e.g. L, M-1, K' },
    line: { type: ['string', 'null'], description: 'e.g. 1d, 22' },
    gl_account: { type: ['string', 'null'], description: 'The book account it came from.' },
  },
  required: ['form', 'schedule', 'line', 'gl_account'],
  additionalProperties: false,
} as const;

const FIX = {
  type: 'object',
  description:
    'Written for a novice Drake operator: where to go, what to type, what to re-check, ' +
    'and one line on why. No "consider whether" — say what to do, or say what fact is needed.',
  properties: {
    where: { type: 'string', description: 'The screen or location, in plain English.' },
    change: { type: 'string', description: 'Exactly what to change it to.' },
    then: { type: 'string', description: 'What to re-check afterwards.' },
    why: { type: 'string', description: 'One line.' },
  },
  required: ['where', 'change', 'then', 'why'],
  additionalProperties: false,
} as const;

const AMOUNT = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'e.g. per_return, per_bank_rec' },
    value: { type: 'number' },
    source_kind: {
      type: 'string',
      enum: ['calc', 'text_doc', 'visual'],
      description:
        'calc — a figure run_analysis printed. text_doc — a figure written in a document ' +
        'with readable text. visual — a figure read off a PDF page. Every figure needs one.',
    },
    source_ref: {
      type: 'string',
      description:
        'For calc, the calculation id you were given. For text_doc, the exact filename. ' +
        'For visual, the filename and page, e.g. return.pdf#p3.',
    },
  },
  required: ['label', 'value', 'source_kind', 'source_ref'],
  additionalProperties: false,
} as const;

const FINDING = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['exception', 'agreed', 'coverage'],
      description:
        'exception — something is wrong. agreed — checked and correct, recorded so the ' +
        'section is not silent. coverage — could not be checked, and why.',
    },
    defect_kind: {
      type: ['string', 'null'],
      enum: [...DEFECT_KINDS, null],
      description:
        'What sort of defect this is. Required on an exception, null otherwise. This is ' +
        'the only thing you say about how serious it is — the grading is not yours to make.',
    },
    category_override: {
      type: ['string', 'null'],
      enum: [...CATEGORIES, null],
      description:
        'Leave null unless this belongs somewhere other than the stage that found it — ' +
        'chiefly a transfer-pricing point raised inside the India module.',
    },
    title: { type: 'string', description: 'One short line.' },
    what_is_wrong: {
      type: 'string',
      description: 'One plain sentence a novice can act on, with both figures where two disagree.',
    },
    why_it_matters: { type: ['string', 'null'], description: 'One line.' },
    location: LOCATION,
    fix: { ...FIX, type: ['object', 'null'] },
    authority_citation: {
      type: ['string', 'null'],
      description:
        'Leave null. There is no verified corpus to cite against, so state the principle ' +
        'in plain English instead. Anything put here is recorded as claimed and never shown ' +
        'as authority.',
    },
    evidence: {
      type: 'array',
      description: 'The documents that prove the correct figure.',
      items: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The document id you were given.' },
          description: { type: 'string' },
        },
        required: ['file_id', 'description'],
        additionalProperties: false,
      },
    },
    amounts: { type: 'array', items: AMOUNT },
    owner: {
      type: ['string', 'null'],
      enum: ['preparer', 'reviewer', 'client', null],
      description: 'Who has to act. Required on anything that is not closed.',
    },
    confidence: {
      type: 'number',
      description:
        'How sure you are, 0 to 1. Be honest: below the threshold this goes to a human ' +
        'queue, which is the correct outcome for something you are guessing at.',
    },
  },
  required: [
    'kind',
    'defect_kind',
    'category_override',
    'title',
    'what_is_wrong',
    'why_it_matters',
    'location',
    'fix',
    'authority_citation',
    'evidence',
    'amounts',
    'owner',
    'confidence',
  ],
  additionalProperties: false,
} as const;

export const RECORD_FINDINGS_TOOL: ToolSpec = {
  name: 'record_findings',
  description:
    'Record what you have found so far. Call this as you go rather than saving everything ' +
    'for the end — several small calls are expected, and a batch that is recorded cannot be ' +
    'lost if you run out of room later.\n\n' +
    'Record an "agreed" line for every section you checked and found correct. A reviewer ' +
    'looking at a silent section cannot tell whether it was clean or skipped, so silence is ' +
    'never an acceptable outcome for a section you examined.',
  parameters: {
    type: 'object',
    properties: { findings: { type: 'array', items: FINDING } },
    required: ['findings'],
    additionalProperties: false,
  },
};

export const RECORD_TIE_OUTS_TOOL: ToolSpec = {
  name: 'record_tie_outs',
  description:
    'Record a check that two figures must agree — K-1 totals against Schedule K, Schedule L ' +
    'against M-2, 5472 Part IV against the ledger. Record these whether or not they agree: ' +
    'the summary shows them as a row of ticks, and a tick that is simply absent tells the ' +
    'reader nothing.',
  parameters: {
    type: 'object',
    properties: {
      tie_outs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'e.g. K-1 box 1 total = Schedule K line 1' },
            left_value: { type: ['number', 'null'] },
            right_value: { type: ['number', 'null'] },
            left_source: { type: ['string', 'null'], description: 'Where the left figure came from.' },
            right_source: { type: ['string', 'null'] },
            agrees: { type: 'boolean' },
          },
          required: ['name', 'left_value', 'right_value', 'left_source', 'right_source', 'agrees'],
          additionalProperties: false,
        },
      },
    },
    required: ['tie_outs'],
    additionalProperties: false,
  },
};

export const RECORD_SCOPE_TOOL: ToolSpec = {
  name: 'record_scope',
  description:
    'Stage 0 only. Confirm the identity of what is being reviewed, and list every form the ' +
    'return actually contains. The form list is compared against what the engagement facts ' +
    'require, so a missing information return is caught here rather than assumed.',
  parameters: {
    type: 'object',
    properties: {
      entity_name: { type: ['string', 'null'] },
      ein: { type: ['string', 'null'], description: 'As it appears; it may be tokenised.' },
      return_type: { type: ['string', 'null'] },
      tax_year: { type: ['number', 'null'] },
      period_start: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      period_end: { type: ['string', 'null'] },
      short_year: { type: ['boolean', 'null'] },
      forms_present: {
        type: 'array',
        description: 'Every form and schedule in the return, e.g. ["1065","K-1","5472"].',
        items: { type: 'string' },
      },
      matches_engagement: {
        type: 'boolean',
        description: 'False if anything disagrees with the engagement record. Say what, in a finding.',
      },
    },
    required: [
      'entity_name',
      'ein',
      'return_type',
      'tax_year',
      'period_start',
      'period_end',
      'short_year',
      'forms_present',
      'matches_engagement',
    ],
    additionalProperties: false,
  },
};

/* --------------------------------------------------------------- validation */

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Checks one finding from a tool call.
 *
 * Hand-rolled rather than a schema library: the repo carries no validator
 * dependency, and the rules worth enforcing here are semantic ones a JSON
 * Schema cannot express anyway — an exception needs a defect kind, anything
 * still open needs an owner.
 */
export function validateFinding(raw: unknown, at: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const path = `findings[${at}]`;

  if (typeof raw !== 'object' || raw === null) {
    return [{ path, message: 'Expected an object.' }];
  }
  const f = raw as Record<string, unknown>;

  const kind = String(f.kind ?? '');
  if (!['exception', 'agreed', 'coverage'].includes(kind)) {
    issues.push({ path: `${path}.kind`, message: 'Must be exception, agreed or coverage.' });
  }
  if (!String(f.title ?? '').trim()) {
    issues.push({ path: `${path}.title`, message: 'A finding needs a title.' });
  }
  if (!String(f.what_is_wrong ?? '').trim()) {
    issues.push({ path: `${path}.what_is_wrong`, message: 'Say what is wrong, in one plain sentence.' });
  }

  if (kind === 'exception') {
    const defect = f.defect_kind == null ? null : String(f.defect_kind);
    if (!defect || !(DEFECT_KINDS as readonly string[]).includes(defect)) {
      issues.push({
        path: `${path}.defect_kind`,
        message: `An exception needs a defect_kind, one of: ${DEFECT_KINDS.join(', ')}.`,
      });
    }
    if (!f.fix || typeof f.fix !== 'object') {
      issues.push({
        path: `${path}.fix`,
        message: 'An exception needs a fix — where to go, what to change, what to re-check, and why.',
      });
    }
    if (!f.owner) {
      issues.push({ path: `${path}.owner`, message: 'An exception needs an owner: preparer, reviewer or client.' });
    }
  }

  const confidence = Number(f.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    issues.push({ path: `${path}.confidence`, message: 'confidence must be a number between 0 and 1.' });
  }

  return issues;
}

/** A message the model can act on, rather than a stack trace it cannot. */
export const describeIssues = (issues: ValidationIssue[]): string =>
  issues.map((i) => `- ${i.path}: ${i.message}`).join('\n');
