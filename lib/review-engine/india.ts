import { FOREIGN_FACTS, foreignFactsPresent, type ForeignFactDef } from './obligations';

/**
 * India symmetry, as its own thing.
 *
 * The brief is explicit that this is the platform's actual differentiator and
 * must not become a note appended to the US findings. So it has its own module,
 * its own stage, and its own rule in the verdict: a return with an Indian link
 * cannot reach a verdict until every cross-border fact recorded on the US side
 * has been answered for on the India side.
 *
 * Answered, not resolved. "There is no Indian filing required for this, and
 * here is why" is a perfectly good answer and closes the fact. What the rule
 * refuses is silence — which is exactly what a US-only review produces, and
 * what a partner cannot tell apart from "checked and fine".
 */

export interface IndiaExpectation extends ForeignFactDef {
  /** What to look for on the Indian side, stated for the prompt. */
  expectation: string;
}

const GENERIC =
  'State whether anything is due in India for this, and if nothing is, say why not.';

/** The facts this engagement has to answer for on the India side. */
export function indiaExpectations(facts: Record<string, unknown>): IndiaExpectation[] {
  return foreignFactsPresent(facts)
    .filter((def) => def.indiaSide && def.key !== 'india_link')
    .map((def) => ({ ...def, expectation: def.indiaExpectation ?? GENERIC }));
}

/**
 * Cross-border facts with no India-side line against them.
 *
 * Matched on the fact key the model records in the finding's location, rather
 * than on the wording of the finding. Wording drifts between runs; a key does
 * not, which is the only way this check can mean the same thing twice.
 */
export function unmirroredFacts(
  facts: Record<string, unknown>,
  indiaLines: { factKey?: string | null }[],
): IndiaExpectation[] {
  const answered = new Set(
    indiaLines.map((line) => (line.factKey ?? '').trim()).filter(Boolean),
  );
  return indiaExpectations(facts).filter((fact) => !answered.has(fact.key));
}

/** The fact keys the India module is allowed to answer for, for the prompt. */
export const indiaFactKeys = (facts: Record<string, unknown>): string[] =>
  indiaExpectations(facts).map((fact) => fact.key);

/** Every India-side fact key the platform knows, for validation. */
export const ALL_INDIA_FACT_KEYS: string[] = FOREIGN_FACTS.filter((f) => f.indiaSide).map(
  (f) => f.key,
);
