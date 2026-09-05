import 'server-only';
import type { SourceAccount } from './chart-of-accounts';
import type { BooksSource } from './books';

/**
 * Tally as a books source.
 *
 * The firm already runs a read-only Tally MCP server — 33 tools, none of which
 * can write — so this is an adapter over a connector that exists rather than a
 * second integration. That was the decision recorded against build item 1.
 *
 * What this deliberately does NOT do is give the model the Tally tools and ask
 * it to assemble a trial balance. The books are the one input the platform can
 * hard-check, and that property survives only if the figures arrive by code.
 * A model reading a ledger and typing the numbers back is a page read wearing a
 * connector's clothes.
 *
 * ## On the response shapes
 *
 * MCP tools return text, and the reference the firm holds documents what each
 * tool is *for*, not the JSON it answers with. So the parsing here is written
 * to be tolerant rather than exact: it looks for the array of records in
 * whatever envelope the server uses, and reads each record through a list of
 * candidate field names. Where it cannot find something it says so and imports
 * nothing, because a books import that silently covers half the ledger is worse
 * than one that fails.
 *
 * When the server is attached, `probeTally` prints what actually came back, and
 * the candidate lists below get narrowed to what is really there. Until then
 * this is honest about being written against a description.
 */

/** The tool that gives us one row per ledger account, with its parent group. */
export const LEDGERS_TOOL = 'tally_list_ledgers';
/** Used only to confirm which company the figures belong to. */
export const COMPANY_TOOL = 'tally_get_company';
/** Used only to fail early with something a person can act on. */
export const STATUS_TOOL = 'tally_connection_status';

/**
 * Why ledgers and not `tally_get_trial_balance`.
 *
 * The trial balance tool reports totals per account *group*. That is the right
 * shape for a tie-out and the wrong shape for this: the chart-of-accounts
 * mapping works per account, and a finding has to quote the ledger name the
 * preparer sees on their screen. Group totals cannot be drilled into after the
 * fact, so importing them would throw away the detail the review needs.
 */

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads a field by trying several names, case- and separator-insensitively. */
function field(row: Json, candidates: string[]): unknown {
  const flat = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    flat.set(k.toLowerCase().replace(/[^a-z0-9]/g, ''), v);
  }
  for (const candidate of candidates) {
    const hit = flat.get(candidate.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (hit !== undefined && hit !== null && hit !== '') return hit;
  }
  return undefined;
}

const NAME_FIELDS = ['name', 'ledgerName', 'ledger', 'accountName', 'account'];
const GROUP_FIELDS = ['parent', 'parentGroup', 'group', 'groupName', 'under', 'primaryGroup'];
const CLOSING_FIELDS = [
  'closingBalance',
  'closing',
  'balance',
  'closingBal',
  'currentBalance',
  'closingAmount',
];

/**
 * Tally reports money as a string more often than as a number, sometimes with
 * separators and a Dr/Cr suffix rather than a sign.
 *
 * Cr is returned negative, matching the signed convention the normaliser reads.
 * An unparseable value becomes null rather than zero: a balance nobody could
 * read is not a balance of nothing, and the mapping screen shows the difference.
 */
export function parseTallyAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text) return null;

  const credit = /\bcr\b\.?$/i.test(text);
  const debit = /\bdr\b\.?$/i.test(text);
  const bare = text
    .replace(/\b[dc]r\b\.?$/i, '')
    .replace(/[₹$,\s]/g, '')
    .trim();

  const negatedByParens = /^\(.*\)$/.test(bare);
  const numeric = Number(negatedByParens ? bare.slice(1, -1) : bare);
  if (!Number.isFinite(numeric)) return null;

  let value = Math.abs(numeric);
  if (credit || negatedByParens || (!debit && numeric < 0)) value = -value;
  return value;
}

/**
 * Finds the array of records inside whatever the server wrapped them in.
 *
 * Servers variously answer with a bare array, `{ ledgers: [...] }`,
 * `{ data: { items: [...] } }` and so on. Rather than guess one, this walks the
 * structure and takes the largest array of objects it finds — the ledger list
 * is the payload, and anything else in the envelope is metadata around it.
 */
export function findRecords(payload: unknown): Json[] {
  let best: Json[] = [];

  const walk = (node: unknown, depth: number) => {
    if (depth > 6) return;
    if (Array.isArray(node)) {
      const records = node.filter(isRecord);
      if (records.length > best.length) best = records;
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (isRecord(node)) for (const value of Object.values(node)) walk(value, depth + 1);
  };

  walk(payload, 0);
  return best;
}

/**
 * Pulls the JSON out of a tool result.
 *
 * `callTool` hands back text, which may be JSON, may be JSON inside a fenced
 * block, and may be prose explaining a failure. Prose is not silently treated as
 * an empty ledger.
 */
export function parseToolText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** Maps one Tally ledger record onto the shape the normaliser reads. */
export function toSourceAccount(row: Json): SourceAccount | null {
  const name = field(row, NAME_FIELDS);
  if (typeof name !== 'string' || !name.trim()) return null;

  const group = field(row, GROUP_FIELDS);
  const closing = field(row, CLOSING_FIELDS);

  return {
    // Tally identifies ledgers by name, not by number. Leaving the code null is
    // correct rather than lossy: inventing one would put a number on the
    // mapping screen that the preparer's Tally does not show.
    code: null,
    name: name.trim(),
    group: typeof group === 'string' ? group.trim() : null,
    balance: parseTallyAmount(closing),
  };
}

/**
 * How a tool gets called.
 *
 * Passed in rather than imported so this can be exercised without a live Tally
 * — the adapter's job is the shape of the data, and that is testable on
 * recorded responses.
 */
export type TallyCaller = (tool: string, args: Record<string, unknown>) => Promise<string>;

export interface TallyOptions {
  /** Which loaded company to read, when Tally has more than one open. */
  company?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}

/**
 * The Tally books source.
 *
 * `ref` is the company name, which is how Tally addresses a set of books. An
 * engagement with no company recorded reads whichever company is loaded, and
 * the import is stamped with what came back so the record still says which
 * books were seen.
 */
export function tallySource(call: TallyCaller, options: TallyOptions = {}): BooksSource {
  return {
    id: 'tally',
    label: 'Tally (read-only)',

    async fetch({ ref }) {
      const company = options.company ?? ref ?? null;

      const raw = await call(LEDGERS_TOOL, {
        ...(company ? { company } : {}),
        ...(options.periodStart ? { from: options.periodStart } : {}),
        ...(options.periodEnd ? { to: options.periodEnd } : {}),
      });

      const payload = parseToolText(raw);
      if (payload === null) {
        throw new Error(
          `Tally did not return readable data. ${LEDGERS_TOOL} answered with: ` +
            `${raw.slice(0, 300)}`,
        );
      }

      const records = findRecords(payload);
      if (!records.length) {
        throw new Error(
          'Tally returned no ledger accounts. Check that the company is loaded in TallyPrime ' +
            'and that its books cover the period being reviewed.',
        );
      }

      const accounts: SourceAccount[] = [];
      let skipped = 0;
      for (const record of records) {
        const account = toSourceAccount(record);
        if (account) accounts.push(account);
        else skipped++;
      }

      if (!accounts.length) {
        throw new Error(
          `Tally returned ${records.length} rows but none carried a readable account name. ` +
            'The field names this adapter looks for may not match this server version — run ' +
            'probeTally to see what it actually returns.',
        );
      }

      return {
        accounts,
        /**
         * Tally answers from the live company file, so the extraction time is
         * now. This is the one source where that is true rather than a
         * convenient default: a nightly-snapshot connector must report the
         * snapshot's own time instead.
         */
        extractedAt: Date.now(),
        periodStart: options.periodStart ?? null,
        periodEnd: options.periodEnd ?? null,
        skipped,
      };
    },
  };
}

/**
 * What the server actually returns, printed rather than assumed.
 *
 * The adapter above is written against a description of the tools, not against
 * their output. This is the thing to run first when the connector is attached:
 * it reports the envelope, the field names on a record, and whether the amounts
 * parsed — which is what turns the tolerant guessing above into something
 * narrowed to fact.
 */
export async function probeTally(call: TallyCaller): Promise<string> {
  const lines: string[] = [];

  for (const tool of [STATUS_TOOL, COMPANY_TOOL, LEDGERS_TOOL]) {
    let text: string;
    try {
      text = await call(tool, {});
    } catch (err) {
      lines.push(`${tool}: FAILED — ${(err as Error).message}`);
      continue;
    }

    const payload = parseToolText(text);
    if (payload === null) {
      lines.push(`${tool}: not JSON. First 200 characters:`, `  ${text.slice(0, 200)}`);
      continue;
    }

    const records = findRecords(payload);
    lines.push(`${tool}: ${records.length} record(s) found.`);

    const sample = records[0];
    if (!sample) continue;

    lines.push(`  fields: ${Object.keys(sample).join(', ')}`);

    if (tool === LEDGERS_TOOL) {
      const account = toSourceAccount(sample);
      lines.push(
        account
          ? `  read as: name="${account.name}" group="${account.group ?? ''}" ` +
              `balance=${account.balance ?? 'unreadable'}`
          : '  read as: NOTHING — no field matched the candidate names for an account name.',
      );
      const unreadable = records.filter((r) => {
        const a = toSourceAccount(r);
        return a && a.balance === null;
      }).length;
      if (unreadable) {
        lines.push(`  ${unreadable} of ${records.length} rows had a balance that did not parse.`);
      }
    }
  }

  return lines.join('\n');
}
