/**
 * The firm-standard chart of accounts, and the mapping into it.
 *
 * Item 3 of the build guidance calls this the highest-leverage piece of
 * engineering in the project, and the reason is worth restating: every Stage 1
 * check is written once against these keys instead of once per source system.
 * Tally calls it "Sundry Debtors", QuickBooks calls it "Accounts Receivable",
 * a spreadsheet calls it "A/R — trade" and account 1200. One key, one check.
 *
 * Two rules hold this together.
 *
 * The mapping is a suggestion with a confidence, never a silent decision. A
 * name it does not recognise maps to null and says so, because a receivable
 * quietly filed as revenue is a worse outcome than an unmapped line a person
 * has to look at. That is the same trade the firm's guardrails make everywhere
 * else: defer rather than guess.
 *
 * And the source line survives. Every normalised account keeps the code and
 * name it arrived with, so a finding can quote what the client's own books say
 * rather than the firm's translation of it — a preparer cannot act on "the
 * trade receivables key is wrong" if their screen says 1200 Sundry Debtors.
 */

export type AccountSide = 'debit' | 'credit';

export interface AccountKey {
  key: string;
  label: string;
  /** Where it sits on the statements, for the ratio and tie-out work. */
  group:
    | 'current_asset'
    | 'fixed_asset'
    | 'other_asset'
    | 'current_liability'
    | 'long_term_liability'
    | 'equity'
    | 'revenue'
    | 'cost_of_sales'
    | 'operating_expense'
    | 'other_income_expense'
    | 'tax';
  normalSide: AccountSide;
  /** Matched against the source name, most specific first. */
  patterns: RegExp[];
  /** Ledger code ranges that usually carry this, as a weak signal only. */
  codeHints?: RegExp[];
  /** Why this account gets looked at, where that is not obvious. */
  note?: string;
}

/**
 * The taxonomy.
 *
 * Deliberately not exhaustive. It covers what the Stage 1 and Stage 2
 * references actually test, and anything outside it maps to null rather than
 * being forced into the nearest key — a taxonomy that always finds an answer is
 * a taxonomy that is sometimes wrong without saying so.
 */
export const CHART: AccountKey[] = [
  {
    key: 'cash',
    label: 'Cash and bank',
    group: 'current_asset',
    normalSide: 'debit',
    patterns: [/\b(cash|bank|current account|checking|savings|petty cash|undeposited)\b/i],
    codeHints: [/^1[0-1]\d\d?$/],
    note: 'Tied to the bank reconciliation, which is the first Stage 1 check.',
  },
  {
    key: 'trade_receivables',
    label: 'Trade receivables',
    group: 'current_asset',
    normalSide: 'debit',
    patterns: [
      /\b(accounts?\s*receivable|a\/?r\b|trade\s*(debtors|receivables)|sundry\s*debtors|debtors)\b/i,
    ],
    codeHints: [/^12\d\d?$/],
  },
  {
    key: 'other_receivables',
    label: 'Other receivables and advances',
    group: 'current_asset',
    normalSide: 'debit',
    patterns: [/\b(prepaid|prepayments?|advances?|deposits? paid|other receivables?|loans? to)\b/i],
  },
  {
    key: 'due_from_related_party',
    label: 'Due from a related party',
    group: 'current_asset',
    normalSide: 'debit',
    patterns: [
      /\b(due from|receivable from)\b.*\b(director|shareholder|partner|member|parent|affiliate|associate|related)\b/i,
      /\b(director|shareholder|partner|member)\b.*\b(loan|advance|drawings?)\b/i,
    ],
    note: 'A related-party balance is a disclosure and often a disguised distribution.',
  },
  {
    key: 'inventory',
    label: 'Inventory',
    group: 'current_asset',
    normalSide: 'debit',
    patterns: [/\b(inventor(y|ies)|stock in trade|closing stock|work in progress|wip)\b/i],
  },
  {
    key: 'fixed_assets',
    label: 'Fixed assets at cost',
    group: 'fixed_asset',
    normalSide: 'debit',
    patterns: [
      /\b(fixed assets?|property, plant|plant and machinery|machinery|equipment|furniture|vehicles?|leasehold|fit.?out|buildings?|land)\b/i,
    ],
    codeHints: [/^1[5-7]\d\d?$/],
  },
  {
    key: 'accumulated_depreciation',
    label: 'Accumulated depreciation',
    group: 'fixed_asset',
    normalSide: 'credit',
    patterns: [/\b(accum(ulated)?\.?\s*(depreciation|amortisation|amortization)|less depreciation)\b/i],
  },
  {
    key: 'intangibles',
    label: 'Intangible assets',
    group: 'other_asset',
    normalSide: 'debit',
    patterns: [/\b(goodwill|intangible|software (licen|develop)|trademark|patent)\b/i],
  },
  {
    key: 'suspense',
    label: 'Suspense and unclassified',
    group: 'other_asset',
    normalSide: 'debit',
    patterns: [/\b(suspense|unclassified|to be (allocated|classified)|misc(ellaneous)? clearing|clearing)\b/i],
    note: 'An open suspense balance at year end means something was never decided.',
  },
  {
    key: 'trade_payables',
    label: 'Trade payables',
    group: 'current_liability',
    normalSide: 'credit',
    patterns: [/\b(accounts?\s*payable|a\/?p\b|trade (creditors|payables)|sundry creditors|creditors)\b/i],
    codeHints: [/^2[0-1]\d\d?$/],
  },
  {
    key: 'accrued_liabilities',
    label: 'Accruals and provisions',
    group: 'current_liability',
    normalSide: 'credit',
    patterns: [/\b(accru(ed|als)|provision|outstanding (expense|liabilit))\b/i],
    codeHints: [/^22\d\d?$/],
    note: 'An accrual to a related party has a payment-timing test attached.',
  },
  {
    key: 'payroll_liabilities',
    label: 'Payroll and withholding liabilities',
    group: 'current_liability',
    normalSide: 'credit',
    patterns: [/\b(payroll (liabilit|tax)|paye|withholding|tds payable|941|futa|suta|pf payable|esi)\b/i],
  },
  {
    key: 'sales_tax_liabilities',
    label: 'Sales tax and GST',
    group: 'current_liability',
    normalSide: 'credit',
    patterns: [/\b(sales tax|use tax|gst|vat|hst)\b/i],
  },
  {
    key: 'due_to_related_party',
    label: 'Due to a related party',
    group: 'current_liability',
    normalSide: 'credit',
    patterns: [
      /\b(due to|payable to)\b.*\b(director|shareholder|partner|member|parent|affiliate|associate|related)\b/i,
      /\b(shareholder|director|partner|member)\b.*\bloan\b/i,
    ],
    note: 'The other half of the cross-border and disguised-distribution tests.',
  },
  {
    key: 'debt',
    label: 'Loans and borrowings',
    group: 'long_term_liability',
    normalSide: 'credit',
    patterns: [/\b(term loans?|bank loans?|notes? payable|mortgages?|borrowings?|line of credit|debentures?)\b/i],
  },
  {
    key: 'contributed_capital',
    label: 'Contributed capital',
    group: 'equity',
    normalSide: 'credit',
    patterns: [
      /\b(common stock|share capital|paid.?in capital|capital contribution|member(s)? capital|partner(s)? capital)\b/i,
    ],
    codeHints: [/^3[0-1]\d\d?$/],
  },
  {
    key: 'retained_earnings',
    label: 'Retained earnings',
    group: 'equity',
    normalSide: 'credit',
    patterns: [/\b(retained earnings|accumulated (profit|deficit|adjustment)|reserves and surplus)\b/i],
  },
  {
    key: 'distributions',
    label: 'Distributions and drawings',
    group: 'equity',
    normalSide: 'debit',
    // Plurals spelled out. `\b(distribution)\b` does not match "Distributions",
    // because the boundary falls before the s — the same trap that silently
    // unmapped this account the first time.
    patterns: [/\b(distributions?|dividends?|draws?|drawings?|withdrawals?)\b/i],
    note: 'The account most often misfiled as an expense, which is why it has its own key.',
  },
  {
    key: 'revenue',
    label: 'Revenue',
    group: 'revenue',
    normalSide: 'credit',
    patterns: [/\b(revenue|sales|turnover|fees? earned|service income|consulting income)\b/i],
    codeHints: [/^4\d\d\d?$/],
  },
  {
    key: 'other_income',
    label: 'Other income',
    group: 'other_income_expense',
    normalSide: 'credit',
    patterns: [/\b(interest income|other income|forex gain|gain on|rental income)\b/i],
  },
  {
    key: 'cost_of_sales',
    label: 'Cost of sales',
    group: 'cost_of_sales',
    normalSide: 'debit',
    patterns: [/\b(cost of (goods|sales|revenue)|cogs|direct (cost|material|labour|labor)|purchases)\b/i],
    codeHints: [/^5\d\d\d?$/],
  },
  {
    key: 'compensation',
    label: 'Wages and officer compensation',
    group: 'operating_expense',
    normalSide: 'debit',
    patterns: [
      /\b(salar|wage|payroll expense|officer compensation|director(s)? remuneration|bonus|commission paid)\b/i,
    ],
    codeHints: [/^6[0-1]\d\d?$/],
  },
  {
    key: 'contractor_costs',
    label: 'Contractors and professional fees',
    group: 'operating_expense',
    normalSide: 'debit',
    patterns: [
      /\b(contractor|subcontract|consult(ing|ant)|professional fee|legal (and )?(professional|fee)|audit fee|accountancy)\b/i,
    ],
    note: 'Where owner draws and related-party payments are most often hidden.',
  },
  {
    key: 'rent',
    label: 'Rent and occupancy',
    group: 'operating_expense',
    normalSide: 'debit',
    patterns: [/\b(rent|lease (expense|rental)|occupancy|premises)\b/i],
  },
  {
    key: 'meals_entertainment',
    label: 'Meals and entertainment',
    group: 'operating_expense',
    normalSide: 'debit',
    patterns: [/\b(meals?|entertainment|business meal|client (lunch|dinner)|staff welfare)\b/i],
    note: 'Carries a statutory disallowance, so it is tested every year.',
  },
  {
    key: 'travel',
    label: 'Travel',
    group: 'operating_expense',
    normalSide: 'debit',
    patterns: [/\b(travel|airfare|mileage|hotel|lodging|conveyance)\b/i],
  },
  {
    key: 'depreciation_expense',
    label: 'Depreciation and amortisation expense',
    group: 'operating_expense',
    normalSide: 'debit',
    patterns: [/\b(depreciation expense|amorti[sz]ation expense|depreciation and amorti)\b/i],
  },
  {
    key: 'non_deductible',
    label: 'Non-deductible items',
    group: 'operating_expense',
    normalSide: 'debit',
    patterns: [
      /\b(penalt(y|ies)|fines?|lobbying|political contributions?|club dues|punitive|life insurance premiums?)\b/i,
    ],
    note: 'Disallowed outright; a book-to-tax difference every time it appears.',
  },
  {
    key: 'other_operating_expense',
    label: 'Other operating expenses',
    group: 'operating_expense',
    normalSide: 'debit',
    patterns: [
      /\b(office|utilit(y|ies)|telephone|internet|insurance|repairs?|maintenance|software subscription|bank charge|advertis|marketing|training|postage|printing|stationery)\b/i,
    ],
  },
  {
    key: 'interest_expense',
    label: 'Interest expense',
    group: 'other_income_expense',
    normalSide: 'debit',
    patterns: [/\b(interest (expense|paid|on loan)|finance (cost|charge))\b/i],
  },
  {
    key: 'income_tax',
    label: 'Income tax',
    group: 'tax',
    normalSide: 'debit',
    patterns: [/\b(income tax|federal tax|state tax|corporate tax|deferred tax|tax provision)\b/i],
  },
];

export const chartKey = (key: string): AccountKey | null =>
  CHART.find((entry) => entry.key === key) ?? null;

export interface SourceAccount {
  code?: string | null;
  name: string;
  /** Signed balance in the source's own presentation. */
  balance?: number | null;
}

export interface MappedAccount extends SourceAccount {
  key: string | null;
  confidence: number;
  /** Plain English, so an unmapped or low-confidence line explains itself. */
  reason: string;
}

/** What a name match is worth against what a code-range hint is worth. */
const NAME_CONFIDENCE = 0.9;
const CODE_CONFIDENCE = 0.55;

/**
 * Maps one source account into the taxonomy.
 *
 * Names first, codes second and only as a tie-break: every firm numbers its
 * ledger differently, and a 6300 that says "Consulting expense" in one client's
 * books is a partner draw in another's. A code-only match is returned at low
 * confidence precisely so it lands in front of a person.
 */
export function normaliseAccount(account: SourceAccount): MappedAccount {
  const name = (account.name ?? '').trim();
  const code = (account.code ?? '').toString().trim();

  const byName = CHART.filter((entry) => entry.patterns.some((p) => p.test(name)));

  if (byName.length === 1) {
    return {
      ...account,
      name,
      key: byName[0].key,
      confidence: NAME_CONFIDENCE,
      reason: `"${name}" matches ${byName[0].label}.`,
    };
  }

  if (byName.length > 1) {
    // Two keys both claim it. The code decides only if it agrees with one of
    // them; otherwise this is exactly the line a person should look at.
    const agreeing = byName.filter((entry) => entry.codeHints?.some((h) => h.test(code)));
    if (agreeing.length === 1) {
      return {
        ...account,
        name,
        key: agreeing[0].key,
        confidence: 0.75,
        reason:
          `"${name}" could be ${byName.map((e) => e.label).join(' or ')}; code ${code} ` +
          `points at ${agreeing[0].label}.`,
      };
    }
    return {
      ...account,
      name,
      key: null,
      confidence: 0,
      reason:
        `"${name}" matches more than one standard account (${byName
          .map((e) => e.label)
          .join(', ')}) and the code does not settle it. Map it by hand.`,
    };
  }

  const byCode = code ? CHART.filter((entry) => entry.codeHints?.some((h) => h.test(code))) : [];
  if (byCode.length === 1) {
    return {
      ...account,
      name,
      key: byCode[0].key,
      confidence: CODE_CONFIDENCE,
      reason:
        `Nothing in "${name}" matched, but code ${code} sits in the range usually used for ` +
        `${byCode[0].label}. Worth confirming — every firm numbers its ledger differently.`,
    };
  }

  return {
    ...account,
    name,
    key: null,
    confidence: 0,
    reason:
      `"${name}"${code ? ` (code ${code})` : ''} does not match any standard account. Left ` +
      'unmapped rather than guessed: a receivable filed as revenue is worse than a line ' +
      'somebody has to look at.',
  };
}

export interface NormalisedBooks {
  accounts: MappedAccount[];
  /** Lines nobody could map, which the review has to be told about. */
  unmapped: MappedAccount[];
  /** Mapped only on a code range, so worth a glance. */
  weak: MappedAccount[];
  /** Totals per key, in the source's own signing. */
  totals: Record<string, number>;
  debitTotal: number;
  creditTotal: number;
}

/** Below this a mapping is reported as weak rather than relied on. */
export const WEAK_MAPPING_BELOW = 0.7;

export function normaliseBooks(accounts: SourceAccount[]): NormalisedBooks {
  const mapped = accounts.map(normaliseAccount);
  const totals: Record<string, number> = {};
  let debitTotal = 0;
  let creditTotal = 0;

  for (const account of mapped) {
    const balance = Number(account.balance ?? 0);
    if (!Number.isFinite(balance)) continue;
    if (balance >= 0) debitTotal += balance;
    else creditTotal += -balance;
    if (account.key) totals[account.key] = (totals[account.key] ?? 0) + balance;
  }

  return {
    accounts: mapped,
    unmapped: mapped.filter((a) => !a.key),
    weak: mapped.filter((a) => a.key && a.confidence < WEAK_MAPPING_BELOW),
    totals,
    debitTotal: Math.round(debitTotal * 100) / 100,
    creditTotal: Math.round(creditTotal * 100) / 100,
  };
}

/**
 * Reads a trial balance out of delimited text.
 *
 * Handles the shapes that actually arrive: a code column and a name column with
 * either one signed balance or separate debit and credit columns. Anything it
 * cannot make sense of is skipped and counted, never guessed at — a row read
 * wrongly is a figure the review would go on to check against nothing.
 */
export function parseTrialBalanceText(text: string): { accounts: SourceAccount[]; skipped: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const accounts: SourceAccount[] = [];
  let skipped = 0;

  const number = (raw: string): number | null => {
    const cleaned = (raw ?? '').replace(/[$,\s]/g, '');
    if (!cleaned || cleaned === '-') return null;
    const negative = /^\(.*\)$/.test(cleaned);
    const value = Number(cleaned.replace(/[()]/g, ''));
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
  };

  const cellsOf = (line: string) =>
    line
      .split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)|\s{2,}\|?\s*/)
      .map((c) => c.replace(/^"|"$/g, '').trim());

  /**
   * Columns are read from the header where there is one.
   *
   * Guessing from position gets a credit-only row wrong — one number in the
   * credit column looks exactly like one number in a single balance column, and
   * the sign is the difference between revenue of 310,000 and revenue of
   * negative 310,000. That is not a rounding difference, it is the wrong return.
   */
  let debitAt: number | null = null;
  let creditAt: number | null = null;
  let balanceAt: number | null = null;
  let codeAt: number | null = null;
  let nameAt: number | null = null;

  for (const line of lines) {
    const cells = cellsOf(line);
    if (cells.some((c) => number(c) !== null)) continue;
    const lower = cells.map((c) => c.toLowerCase());
    const find = (re: RegExp) => {
      const i = lower.findIndex((c) => re.test(c));
      return i >= 0 ? i : null;
    };
    const d = find(/^debits?$/);
    const c = find(/^credits?$/);
    const b = find(/^(balance|amount|closing balance)$/);
    if (d !== null || c !== null || b !== null) {
      debitAt = d;
      creditAt = c;
      balanceAt = b;
      codeAt = find(/^(account|a\/?c|code|gl|ledger)/);
      nameAt = find(/^(description|name|particulars|account name)/);
      break;
    }
  }

  for (const line of lines) {
    const cells = cellsOf(line);
    if (cells.length < 2) {
      skipped++;
      continue;
    }

    const numbers = cells.map(number);
    if (!numbers.some((n) => n !== null)) {
      // The header, or a section heading. Either way not an account.
      skipped++;
      continue;
    }

    // A totals line is arithmetic over the rows above it, not an account. Left
    // out rather than mapped: it would double every balance it sums.
    if (/^(total|grand total|sub.?total|balance c\/?f)/i.test(cells[0] || '')) {
      skipped++;
      continue;
    }

    const codeCell =
      codeAt !== null && /^[0-9][0-9.\-]{0,9}$/.test(cells[codeAt] ?? '')
        ? cells[codeAt]
        : /^[0-9][0-9.\-]{1,9}$/.test(cells[0])
          ? cells[0]
          : null;

    const nameCell =
      (nameAt !== null && cells[nameAt]) ||
      cells.find((c, i) => c !== codeCell && numbers[i] === null && c.length > 1) ||
      cells[0];

    let balance: number | null = null;

    if (debitAt !== null || creditAt !== null) {
      const debit = debitAt !== null ? (numbers[debitAt] ?? 0) : 0;
      const credit = creditAt !== null ? (numbers[creditAt] ?? 0) : 0;
      // Credits negative, so the two sides of a balanced trial balance sum to
      // zero and a normalised total means something.
      balance = debit - credit;
    } else if (balanceAt !== null && numbers[balanceAt] !== null) {
      balance = numbers[balanceAt];
    } else {
      const values = numbers
        .map((n, i) => ({ n, i }))
        .filter((v) => v.n !== null && cells[v.i] !== codeCell);
      if (!values.length) {
        skipped++;
        continue;
      }
      balance =
        values.length >= 2
          ? (values[values.length - 2].n ?? 0) - (values[values.length - 1].n ?? 0)
          : (values[values.length - 1].n ?? 0);
    }

    if (!nameCell || nameCell === codeCell) {
      skipped++;
      continue;
    }

    accounts.push({ code: codeCell, name: nameCell, balance });
  }

  return { accounts, skipped };
}
