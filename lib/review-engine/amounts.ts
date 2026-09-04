import type { AmountSourceKind, FindingAmount } from '@/lib/review-types';

/**
 * Rule 1, enforced rather than instructed.
 *
 * The model reads numbers, compares numbers and flags numbers. It never
 * originates one. That is the firm's Gate 1, and the reason is that a fluent,
 * confident, wrong figure reads as authoritative precisely because it is well
 * formatted — a depreciation number invented in prose looks exactly like one
 * computed from the schedule.
 *
 * So every amount on a finding has to point at something outside the model:
 *
 *   calc     — a figure the sandbox produced. Matched exactly against the
 *              values recorded in run_calcs, so it is provably a computation.
 *   text_doc — a figure appearing in a document's extracted text. Matched
 *              against that document, so it is provably a reading.
 *   visual   — a figure read off a PDF page. Nothing can check it, so it is
 *              recorded unverified and drags the finding's confidence down.
 *
 * Anything else is refused. An amount with no source never reaches the register.
 */

/** Cents, so 42180.00 and 42,180 compare equal without float noise. */
const cents = (value: number): number => Math.round(value * 100);

/**
 * Every number that appears in a body of text.
 *
 * Deliberately generous about formatting — thousands separators, currency
 * symbols, trailing minus, and accounting parentheses for negatives all show up
 * in trial balance exports. Both signs of a parenthesised figure are indexed:
 * a balance shown as (250) in the books is legitimately cited as -250 or 250
 * depending on which side of a comparison it is on, and refusing one of those
 * would push a correct finding into the escalation queue for no reason.
 */
export function numbersIn(text: string): Set<number> {
  const found = new Set<number>();
  const pattern = /\(?-?\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|\(?-?\$?\s?\d+(?:\.\d+)?\)?/g;

  for (const raw of text.match(pattern) ?? []) {
    const negated = /^\(.*\)$/.test(raw.trim());
    const cleaned = raw.replace(/[(),$\s]/g, '');
    if (!cleaned || cleaned === '-') continue;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) continue;
    found.add(cents(value));
    if (negated) found.add(cents(-value));
  }
  return found;
}

export interface NumberIndex {
  /** Values the sandbox produced, by calc id and in aggregate. */
  calc: Set<number>;
  calcById: Map<string, Set<number>>;
  /** Values appearing in each document's extracted text, keyed by file id and by filename. */
  byDocument: Map<string, Set<number>>;
}

export interface IndexInput {
  documents: { fileId: string; filename: string; text: string | null }[];
  calcs: { id: string; values: number[] }[];
}

export function buildNumberIndex({ documents, calcs }: IndexInput): NumberIndex {
  const calcAll = new Set<number>();
  const calcById = new Map<string, Set<number>>();
  for (const calc of calcs) {
    const set = new Set(calc.values.map(cents));
    calcById.set(calc.id, set);
    for (const value of set) calcAll.add(value);
  }

  const byDocument = new Map<string, Set<number>>();
  for (const doc of documents) {
    const set = doc.text ? numbersIn(doc.text) : new Set<number>();
    byDocument.set(doc.fileId, set);
    // Also reachable by filename: the model cites what it can see, and it sees
    // "december-bank-rec.xlsx" rather than a uuid.
    byDocument.set(doc.filename.toLowerCase(), set);
  }

  return { calc: calcAll, calcById, byDocument };
}

export interface AmountProblem {
  label: string;
  value: number;
  sourceKind: AmountSourceKind | null;
  sourceRef: string | null;
  reason: string;
}

export interface AmountCheck {
  /** Amounts that may be stored, with `verified` set to what was actually proved. */
  accepted: FindingAmount[];
  /** Amounts that must not be stored, and why. Fed back to the model as a retry. */
  problems: AmountProblem[];
  /**
   * A ceiling on the finding's confidence implied by its weakest amount.
   * A finding resting entirely on page-image reads cannot be more certain than
   * the reading was.
   */
  confidenceCap: number;
}

/** The most a page-image read may claim. Mirrors return-data.ts. */
export const VISUAL_CAP = 0.6;

/**
 * Checks a finding's amounts against what the run actually saw.
 *
 * Returns the survivors rather than throwing, so the caller can put a real
 * message in front of the model and let it correct itself — an amount it cannot
 * source is usually one it should not have claimed, and saying so is more
 * useful than discarding the whole finding.
 */
export function checkAmounts(
  amounts: (Partial<FindingAmount> & { label?: string; value?: number })[],
  index: NumberIndex,
): AmountCheck {
  const accepted: FindingAmount[] = [];
  const problems: AmountProblem[] = [];
  let cap = 1;

  for (const amount of amounts ?? []) {
    const label = String(amount.label ?? '').trim() || '(unlabelled)';
    const value = Number(amount.value);
    const sourceKind = (amount.source_kind ?? null) as AmountSourceKind | null;
    const sourceRef = amount.source_ref ? String(amount.source_ref) : null;

    if (!Number.isFinite(value)) {
      problems.push({ label, value: NaN, sourceKind, sourceRef, reason: 'The value is not a number.' });
      continue;
    }
    if (!sourceKind || !sourceRef) {
      problems.push({
        label,
        value,
        sourceKind,
        sourceRef,
        reason:
          'Every amount needs source_kind and source_ref. If the figure has to be ' +
          'computed and is not in the inputs, say "needs computation" and name what ' +
          'to compute instead of stating a number.',
      });
      continue;
    }

    if (sourceKind === 'calc') {
      const fromThisCalc = index.calcById.get(sourceRef);
      const known = fromThisCalc ? fromThisCalc.has(cents(value)) : index.calc.has(cents(value));
      if (!known) {
        problems.push({
          label,
          value,
          sourceKind,
          sourceRef,
          reason:
            `${value} is not among the figures the calculation layer produced. ` +
            'Run the calculation first and cite the result, or drop the figure.',
        });
        continue;
      }
      accepted.push({ label, value, source_kind: 'calc', source_ref: sourceRef, verified: true });
      continue;
    }

    if (sourceKind === 'text_doc') {
      const doc = index.byDocument.get(sourceRef) ?? index.byDocument.get(sourceRef.toLowerCase());
      if (!doc) {
        problems.push({
          label,
          value,
          sourceKind,
          sourceRef,
          reason: `No document called "${sourceRef}" was given to this review.`,
        });
        continue;
      }
      if (!doc.has(cents(value))) {
        problems.push({
          label,
          value,
          sourceKind,
          sourceRef,
          reason: `${value} does not appear in "${sourceRef}". Quote the figure as it is written there.`,
        });
        continue;
      }
      accepted.push({ label, value, source_kind: 'text_doc', source_ref: sourceRef, verified: true });
      continue;
    }

    if (sourceKind === 'visual') {
      // Accepted, and honestly labelled. Nothing here proves the figure — a
      // structured Drake export is what would, which is why that parser is the
      // highest-value thing still unbuilt.
      accepted.push({ label, value, source_kind: 'visual', source_ref: sourceRef, verified: false });
      cap = Math.min(cap, VISUAL_CAP);
      continue;
    }

    problems.push({
      label,
      value,
      sourceKind,
      sourceRef,
      reason: `Unknown source_kind "${String(sourceKind)}". Use calc, text_doc or visual.`,
    });
  }

  return { accepted, problems, confidenceCap: cap };
}
