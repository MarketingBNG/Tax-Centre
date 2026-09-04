import type { ReturnType } from '@/lib/review-types';

/**
 * Which forms this engagement owes, from its facts alone.
 *
 * A rules table rather than a chain of conditionals, because the thing being
 * encoded is a grid: each row is one fact about ownership or accounts, and one
 * filing that follows from it. Read as a table it can be checked against the
 * instructions by a person who does not read code, which is the only review
 * that matters here.
 *
 * Everything here is a rule a partner would state the same way twice. The
 * judgement calls stay with the Stage 3 modules, which can raise a finding and
 * ask, rather than being silently pre-empted by a rule that was nearly right.
 * Where a form has a threshold the platform cannot see — 8938's, 3520's gift
 * limits — the rule raises the form and says what to test, rather than deciding.
 *
 * The point of computing this in code at all: a determination made last year
 * and carried forward without re-testing is the most common real miss in
 * cross-border practice. This is re-derived from facts on every run, so
 * "carried forward" is not something the platform can do by default.
 */

export interface Obligation {
  form: string;
  /** Plain English, so a Critical finding can quote it verbatim. */
  because: string;
  /** The fact that triggered it, for the register. */
  factKey: string;
}

/**
 * The facts the grid is keyed off.
 *
 * One list, used by the wizard that collects them, the grid that reads them and
 * the India module that mirrors them — so a fact cannot be askable without
 * being actionable, or actionable without being asked.
 */
export interface ForeignFactDef {
  key: string;
  /** As put to the preparer. */
  label: string;
  /** True where the fact implies something should also have been filed in India. */
  indiaSide: boolean;
  /** What an Indian filing for this fact would be, where there is a usual one. */
  indiaExpectation?: string;
}

export const FOREIGN_FACTS: ForeignFactDef[] = [
  {
    key: 'foreign_owner',
    label: 'A foreign person or entity owns part of this entity',
    indiaSide: true,
    indiaExpectation:
      'If the owner is Indian-resident, check the FEMA/ODI filing and whether the investment is reported on their Indian return.',
  },
  {
    key: 'foreign_subsidiary',
    label: 'This entity owns a foreign corporation',
    indiaSide: true,
    indiaExpectation:
      'If the subsidiary is Indian, check its Indian corporate return and Form 3CEB where transactions are related-party.',
  },
  {
    key: 'foreign_partnership',
    label: 'This entity holds an interest in a foreign partnership or LLP',
    indiaSide: true,
    indiaExpectation: 'For an Indian LLP, check the Indian LLP return and partner allocations.',
  },
  {
    key: 'foreign_branch',
    label: 'This entity has a foreign branch or foreign disregarded entity',
    indiaSide: true,
    indiaExpectation:
      'An Indian branch or project office files its own Indian return; check permanent-establishment exposure.',
  },
  {
    key: 'foreign_accounts',
    label: 'There are bank or financial accounts outside the US',
    indiaSide: true,
    indiaExpectation: 'Indian accounts appear in Schedule FA of the owner’s Indian return.',
  },
  {
    key: 'pfic_holdings',
    label: 'There are holdings in foreign mutual funds or other PFICs',
    indiaSide: true,
    indiaExpectation: 'Indian mutual funds are PFICs; check Schedule FA and the Indian capital-gains treatment.',
  },
  {
    key: 'foreign_trust',
    label: 'There is a foreign trust, or a gift or bequest from a foreign person',
    indiaSide: true,
    indiaExpectation: 'Check the Indian trust return and whether the gift is taxable to the recipient in India.',
  },
  {
    key: 'transfer_to_foreign_corp',
    label: 'Property or cash was transferred to a foreign corporation this year',
    indiaSide: true,
    indiaExpectation: 'For an Indian company, check the FEMA/FDI filing and the share-valuation report.',
  },
  {
    key: 'treaty_position',
    label: 'A tax-treaty position is being taken',
    indiaSide: true,
    indiaExpectation:
      'A treaty claim has two sides: check the Indian return takes a consistent position and holds a TRC and Form 10F.',
  },
  {
    key: 'india_related_party',
    label: 'There are transactions with a related party in India',
    indiaSide: true,
    indiaExpectation: 'Form 3CEB is due in India, and the rate used must match the US side.',
  },
  {
    key: 'india_link',
    label: 'This engagement has an Indian connection of any other kind',
    indiaSide: true,
  },
];

/** True where any recorded fact points outside the US. */
export const foreignFactsPresent = (facts: Record<string, unknown>): ForeignFactDef[] =>
  FOREIGN_FACTS.filter((def) => facts[def.key] === true);

const bool = (facts: Record<string, unknown>, key: string): boolean => facts[key] === true;
const num = (facts: Record<string, unknown>, key: string): number => {
  const value = facts[key];
  return typeof value === 'number' ? value : Number(value) || 0;
};
const list = (facts: Record<string, unknown>, key: string): string[] =>
  Array.isArray(facts[key]) ? (facts[key] as unknown[]).map(String) : [];

interface FormRule {
  form: string;
  factKey: string;
  because: string;
  /** Return types this rule is limited to; omitted means any. */
  returnTypes?: ReturnType[];
  when: (facts: Record<string, unknown>, returnType: ReturnType | null) => boolean;
}

/**
 * The grid. One row per (fact → filing).
 *
 * Ordered as a reviewer would work down a checklist — ownership of this entity,
 * then what this entity owns, then accounts and assets, then transactions and
 * positions taken.
 */
export const FORM_RULES: FormRule[] = [
  {
    form: '5472',
    factKey: 'foreign_owner_pct',
    because: 'A foreign owner holds 25% or more of a reporting corporation.',
    returnTypes: ['1120', '1120-S', '1120-F', '1120-DRE-5472'],
    when: (facts) => num(facts, 'foreign_owner_pct') >= 25 || bool(facts, 'foreign_owner'),
  },
  {
    // Named without brackets deliberately: the matcher below ignores anything
    // parenthesised, so "1120 (pro-forma)" would be satisfied by a plain 1120.
    form: 'Pro-forma 1120',
    factKey: 'foreign_owner_pct',
    because: 'A foreign-owned disregarded entity files a pro-forma 1120 to carry its 5472.',
    returnTypes: ['1120-DRE-5472'],
    when: (facts) => num(facts, 'foreign_owner_pct') >= 25 || bool(facts, 'foreign_owner'),
  },
  {
    form: '5471',
    factKey: 'foreign_subsidiary',
    because: 'The engagement records ownership of a foreign corporation.',
    when: (facts) => bool(facts, 'foreign_subsidiary'),
  },
  {
    form: '5471 Schedule M',
    factKey: 'foreign_subsidiary',
    because:
      'A controlled foreign corporation with related-party transactions reports them on Schedule M, ' +
      'and the amounts must agree with the other side of the transaction.',
    when: (facts) =>
      bool(facts, 'foreign_subsidiary') &&
      (bool(facts, 'india_related_party') || bool(facts, 'related_party_transactions')),
  },
  {
    form: '8865',
    factKey: 'foreign_partnership',
    because: 'An interest in a foreign partnership is reported on 8865; test the category of filer.',
    when: (facts) => bool(facts, 'foreign_partnership'),
  },
  {
    form: '8858',
    factKey: 'foreign_branch',
    because:
      'A foreign branch or foreign disregarded entity is reported on 8858, including where it is ' +
      'held indirectly through a CFC.',
    when: (facts) => bool(facts, 'foreign_branch'),
  },
  {
    form: 'FBAR (FinCEN 114)',
    factKey: 'foreign_accounts',
    because: 'The engagement records foreign financial accounts.',
    when: (facts) => bool(facts, 'foreign_accounts'),
  },
  {
    form: '8938',
    factKey: 'foreign_accounts',
    because:
      'Foreign financial assets are recorded. The threshold and the filer differ from the FBAR, so ' +
      'test the 8938 list against the FBAR list — a narrower 8938 is a classic miss.',
    when: (facts) => bool(facts, 'foreign_accounts') || bool(facts, 'pfic_holdings'),
  },
  {
    form: '8621',
    factKey: 'pfic_holdings',
    because:
      'A PFIC holding is reported on 8621 per fund, per year. Indian mutual funds are PFICs, which ' +
      'is the most common unnoticed instance in this firm’s book.',
    when: (facts) => bool(facts, 'pfic_holdings'),
  },
  {
    form: '3520',
    factKey: 'foreign_trust',
    because:
      'A foreign trust interest, or a gift or bequest from a foreign person, is reported on 3520. ' +
      'Test the amount against the reporting threshold for the year.',
    when: (facts) => bool(facts, 'foreign_trust') || bool(facts, 'foreign_gifts'),
  },
  {
    form: '3520-A',
    factKey: 'foreign_trust',
    because: 'A US owner of a foreign grantor trust is responsible for the trust’s own 3520-A.',
    when: (facts) => bool(facts, 'foreign_trust') && bool(facts, 'foreign_grantor_trust'),
  },
  {
    form: '926',
    factKey: 'transfer_to_foreign_corp',
    because: 'A transfer of property or cash to a foreign corporation is reported on 926.',
    when: (facts) => bool(facts, 'transfer_to_foreign_corp'),
  },
  {
    form: '8833',
    factKey: 'treaty_position',
    because:
      'A treaty-based position that overrides the Code is disclosed on 8833. An undisclosed treaty ' +
      'position is a penalty exposure independent of whether the position is right.',
    when: (facts) => bool(facts, 'treaty_position'),
  },
  {
    form: '3CEB (India)',
    factKey: 'india_related_party',
    because:
      'Related-party transactions with an Indian entity require Form 3CEB in India, and the rate ' +
      'used there must match the rate used here.',
    when: (facts) => bool(facts, 'india_related_party'),
  },
];

export function requiredForms(
  returnType: ReturnType | null,
  facts: Record<string, unknown>,
): Obligation[] {
  const required: Obligation[] = FORM_RULES.filter((rule) => {
    if (rule.returnTypes && (returnType === null || !rule.returnTypes.includes(returnType))) {
      return false;
    }
    return rule.when(facts, returnType);
  }).map((rule) => ({ form: rule.form, because: rule.because, factKey: rule.factKey }));

  // A state or city in scope means a return for it. Not a grid row: the form
  // name is the jurisdiction, so there is one rule and any number of outputs.
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
 *
 * Loose on formatting, not on identity: a schedule of a form is its own
 * obligation, so 5471 being present does not satisfy 5471 Schedule M.
 */
export function missingForms(required: Obligation[], present: string[]): Obligation[] {
  const normalise = (form: string) =>
    form.toLowerCase().replace(/^form\s+/, '').replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
  const have = new Set(present.map(normalise));
  return required.filter((req) => !have.has(normalise(req.form)));
}
