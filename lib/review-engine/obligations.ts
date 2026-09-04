import type { ReturnType } from '@/lib/review-types';

/**
 * Which forms this engagement owes, from its facts alone.
 *
 * The skill files talk about an "obligation engine" as though one exists. It
 * does not. This is a deliberately small, deterministic seed of it: the rules
 * that follow unambiguously from a recorded fact, and nothing else.
 *
 * Small and honest beats large and guessed. Everything here is a rule a
 * partner would state the same way twice; the judgement calls stay with the
 * Stage 3 modules, which can raise a finding and ask, rather than being
 * silently pre-empted by a rule that was nearly right.
 *
 * The point of computing this in code at all is that a determination made last
 * year and carried forward without re-testing is the most common real miss in
 * cross-border practice. This is re-derived from facts on every run, so
 * "carried forward" is not a thing the platform can do by default.
 */

export interface Obligation {
  form: string;
  /** Plain English, so a Critical finding can quote it verbatim. */
  because: string;
  /** The fact that triggered it, for the register. */
  factKey: string;
}

const bool = (facts: Record<string, unknown>, key: string): boolean => facts[key] === true;
const num = (facts: Record<string, unknown>, key: string): number => {
  const value = facts[key];
  return typeof value === 'number' ? value : Number(value) || 0;
};
const list = (facts: Record<string, unknown>, key: string): string[] =>
  Array.isArray(facts[key]) ? (facts[key] as unknown[]).map(String) : [];

export function requiredForms(
  returnType: ReturnType | null,
  facts: Record<string, unknown>,
): Obligation[] {
  const required: Obligation[] = [];

  // A 25%-or-more foreign owner of a US corporation or disregarded entity makes
  // a 5472 mandatory, and the disregarded entity files a pro-forma 1120 to
  // carry it. Both halves are missed often enough to be worth stating.
  if (num(facts, 'foreign_owner_pct') >= 25 || bool(facts, 'foreign_owner')) {
    if (returnType === '1120' || returnType === '1120-S' || returnType === '1120-F' || returnType === '1120-DRE-5472') {
      required.push({
        form: '5472',
        because: 'A foreign owner holds 25% or more of a reporting corporation.',
        factKey: 'foreign_owner_pct',
      });
    }
    if (returnType === '1120-DRE-5472') {
      required.push({
        form: '1120 (pro-forma)',
        because: 'A foreign-owned disregarded entity files a pro-forma 1120 to carry its 5472.',
        factKey: 'foreign_owner_pct',
      });
    }
  }

  // Ownership of a foreign corporation.
  if (bool(facts, 'foreign_subsidiary')) {
    required.push({
      form: '5471',
      because: 'The engagement records ownership of a foreign corporation.',
      factKey: 'foreign_subsidiary',
    });
  }

  // Foreign financial accounts. FBAR and 8938 have different thresholds and
  // different filers, so both are raised and the module decides — but an
  // 8938 list narrower than the FBAR list is a classic miss.
  if (bool(facts, 'foreign_accounts')) {
    required.push({
      form: 'FBAR (FinCEN 114)',
      because: 'The engagement records foreign financial accounts.',
      factKey: 'foreign_accounts',
    });
    required.push({
      form: '8938',
      because: 'Foreign financial assets are recorded; test the 8938 threshold against the FBAR list.',
      factKey: 'foreign_accounts',
    });
  }

  // A state or city in scope means a return for it.
  for (const jurisdiction of list(facts, 'jurisdictions')) {
    if (jurisdiction.toUpperCase() === 'US-FED') continue;
    required.push({
      form: `${jurisdiction} return`,
      because: `${jurisdiction} is in scope for this engagement.`,
      factKey: 'jurisdictions',
    });
  }

  return required;
}

/**
 * Forms required but not present.
 *
 * Validation rule 4: a verdict other than Hold needs every required form to be
 * in the return as prepared. Comparison is loose on formatting — "Form 5472"
 * and "5472" are the same obligation, and a mismatch on punctuation must not
 * read as a missing filing.
 */
export function missingForms(required: Obligation[], present: string[]): Obligation[] {
  const normalise = (form: string) => form.toLowerCase().replace(/^form\s+/, '').replace(/[^a-z0-9]/g, '');
  const have = new Set(present.map(normalise));
  return required.filter((req) => !have.has(normalise(req.form)));
}
