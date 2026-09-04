import 'server-only';
import crypto from 'node:crypto';
import { all, one, run as exec, audit } from '@/lib/db';
import { normaliseBooks, parseTrialBalanceText, type SourceAccount } from './chart-of-accounts';

/**
 * Books imports: one interface, whatever the books live in.
 *
 * The connectors are not built — QuickBooks, Zoho and Xero each need a
 * developer app the firm has to register, and the Tally one already exists and
 * needs a decision about reuse rather than a rebuild. What is built is the
 * shape they plug into, and one source that works today: the trial balance
 * somebody uploads.
 *
 * Doing it in this order is deliberate. The valuable part of item 3 is not the
 * OAuth dance, it is that every Stage 1 check reads firm-standard keys instead
 * of whatever a particular ledger calls things — and that pays off on an
 * uploaded spreadsheet exactly as much as on a live connection.
 */

const uuid = () => crypto.randomUUID();
const now = () => Date.now();

export type SourceSystem = 'spreadsheet' | 'tally' | 'quickbooks' | 'zoho' | 'xero';

export interface BooksImportRow {
  id: string;
  engagement_id: string;
  source_system: SourceSystem;
  source_ref: string | null;
  period_start: string | null;
  period_end: string | null;
  extracted_at: number;
  row_count: number;
  unmapped_count: number;
  content_hash: string;
  imported_by: string | null;
  created_at: number;
}

export interface BooksAccountRow {
  id: string;
  import_id: string;
  source_code: string | null;
  source_name: string;
  balance_cents: number | null;
  mapped_key: string | null;
  mapped_confidence: number | null;
  mapping_reason: string | null;
}

/**
 * A source of books.
 *
 * `extractedAt` is the source's own idea of when the data was taken, not when
 * this ran — a connector pulling last night's snapshot must say so, because the
 * whole point of stamping an import is that it describes the data rather than
 * the act of importing it.
 */
export interface BooksSource {
  id: SourceSystem;
  label: string;
  fetch(input: { engagementId: string; ref: string }): Promise<{
    accounts: SourceAccount[];
    extractedAt: number;
    periodStart?: string | null;
    periodEnd?: string | null;
    /** Rows the parser could not read, reported rather than dropped. */
    skipped?: number;
  }>;
}

/** The only source that works today: an uploaded trial balance. */
export function spreadsheetSource(readText: (fileId: string) => Promise<string | null>): BooksSource {
  return {
    id: 'spreadsheet',
    label: 'Uploaded trial balance',
    async fetch({ ref }) {
      const text = await readText(ref);
      if (!text) {
        throw new Error(
          'That file has no readable text. A PDF trial balance can be read by the model but ' +
            'not normalised into the chart of accounts — export it as XLSX or CSV.',
        );
      }
      const { accounts, skipped } = parseTrialBalanceText(text);
      if (!accounts.length) {
        throw new Error('No account rows could be read out of that file.');
      }
      return {
        accounts,
        // The upload is the extraction: nothing else knows better.
        extractedAt: now(),
        skipped,
      };
    },
  };
}

export interface ImportResult {
  import: BooksImportRow;
  mapped: number;
  unmapped: number;
  weak: number;
  skipped: number;
  /** True when this exact data was already imported and nothing was written. */
  duplicate: boolean;
}

/**
 * Records one import, normalised and stamped.
 *
 * Re-importing byte-identical data returns the existing record rather than
 * creating a second one: two imports of the same books, differing only in when
 * somebody pressed the button, would make "which data did the review see"
 * ambiguous for no gain.
 */
export async function recordImport(
  actorId: string | null,
  input: {
    engagementId: string;
    source: BooksSource;
    ref: string;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
): Promise<ImportResult> {
  const fetched = await input.source.fetch({ engagementId: input.engagementId, ref: input.ref });
  const normalised = normaliseBooks(fetched.accounts);

  const contentHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        normalised.accounts.map((a) => [a.code ?? '', a.name, Math.round((a.balance ?? 0) * 100)]),
      ),
    )
    .digest('hex')
    .slice(0, 32);

  const existing = await one<BooksImportRow>(
    `SELECT * FROM books_imports WHERE engagement_id = ? AND content_hash = ?`,
    input.engagementId,
    contentHash,
  );
  if (existing) {
    return {
      import: { ...existing, extracted_at: Number(existing.extracted_at), created_at: Number(existing.created_at) },
      mapped: normalised.accounts.length - normalised.unmapped.length,
      unmapped: normalised.unmapped.length,
      weak: normalised.weak.length,
      skipped: fetched.skipped ?? 0,
      duplicate: true,
    };
  }

  const id = uuid();
  await exec(
    `INSERT INTO books_imports
       (id, engagement_id, source_system, source_ref, period_start, period_end,
        extracted_at, row_count, unmapped_count, content_hash, imported_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.engagementId,
    input.source.id,
    input.ref,
    input.periodStart ?? fetched.periodStart ?? null,
    input.periodEnd ?? fetched.periodEnd ?? null,
    fetched.extractedAt,
    normalised.accounts.length,
    normalised.unmapped.length,
    contentHash,
    actorId,
    now(),
  );

  for (const account of normalised.accounts) {
    await exec(
      `INSERT INTO books_accounts
         (id, import_id, source_code, source_name, balance_cents,
          mapped_key, mapped_confidence, mapping_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      uuid(),
      id,
      account.code ?? null,
      account.name,
      account.balance === null || account.balance === undefined
        ? null
        : Math.round(account.balance * 100),
      account.key,
      account.confidence,
      account.reason,
    );
  }

  await audit(actorId, 'books.imported', 'books_import', id, {
    engagementId: input.engagementId,
    source: input.source.id,
    rows: normalised.accounts.length,
    unmapped: normalised.unmapped.length,
  });

  const row = (await one<BooksImportRow>(`SELECT * FROM books_imports WHERE id = ?`, id))!;
  return {
    import: { ...row, extracted_at: Number(row.extracted_at), created_at: Number(row.created_at) },
    mapped: normalised.accounts.length - normalised.unmapped.length,
    unmapped: normalised.unmapped.length,
    weak: normalised.weak.length,
    skipped: fetched.skipped ?? 0,
    duplicate: false,
  };
}

export const listImports = (engagementId: string) =>
  all<BooksImportRow>(
    `SELECT * FROM books_imports WHERE engagement_id = ? ORDER BY extracted_at DESC`,
    engagementId,
  );

export const latestImport = (engagementId: string) =>
  one<BooksImportRow>(
    `SELECT * FROM books_imports WHERE engagement_id = ?
      ORDER BY extracted_at DESC LIMIT 1`,
    engagementId,
  );

export const importAccounts = (importId: string) =>
  all<BooksAccountRow>(
    `SELECT * FROM books_accounts WHERE import_id = ? ORDER BY source_code NULLS LAST, source_name`,
    importId,
  );

/**
 * The normalised books as a stage reads them.
 *
 * Both halves are given to the model: the mapped keys, so a check written once
 * works across every client, and the unmapped lines, so a stage cannot quietly
 * review a subset of the ledger and report it as the whole.
 */
export async function normalisedBooksBlock(engagementId: string): Promise<string | null> {
  const latest = await latestImport(engagementId);
  if (!latest) return null;

  const accounts = await importAccounts(latest.id);
  const money = (cents: number | null) =>
    cents === null ? '' : (Number(cents) / 100).toFixed(2);

  const mapped = accounts.filter((a) => a.mapped_key);
  const unmapped = accounts.filter((a) => !a.mapped_key);

  const lines = [
    '# The books, normalised',
    '',
    `Source: ${latest.source_system}. Taken from the source system on ` +
      `${new Date(Number(latest.extracted_at)).toISOString().slice(0, 10)}. ` +
      `${latest.row_count} accounts.`,
    '',
    'Each line is the client\'s own account code and name, then the firm-standard key it maps',
    'to. Quote the client\'s code and name in a finding — the preparer\'s screen shows those,',
    'not the standard key.',
    '',
    '| Code | Name | Balance | Standard key |',
    '|---|---|---|---|',
    ...mapped.map(
      (a) =>
        `| ${a.source_code ?? ''} | ${a.source_name} | ${money(a.balance_cents)} | ${a.mapped_key} |`,
    ),
  ];

  if (unmapped.length) {
    lines.push(
      '',
      `## ${unmapped.length} account${unmapped.length === 1 ? '' : 's'} could not be mapped`,
      '',
      'These were not forced into the nearest standard key. Review them from the name and the',
      'balance, and record a coverage line for anything you cannot place.',
      '',
      ...unmapped.map((a) => `- ${a.source_code ?? ''} ${a.source_name} — ${money(a.balance_cents)}`),
    );
  }

  const weak = mapped.filter((a) => (a.mapped_confidence ?? 1) < 0.7);
  if (weak.length) {
    lines.push(
      '',
      `## ${weak.length} mapping${weak.length === 1 ? '' : 's'} worth checking`,
      '',
      ...weak.map((a) => `- ${a.source_code ?? ''} ${a.source_name} → ${a.mapped_key}: ${a.mapping_reason}`),
    );
  }

  return lines.join('\n');
}
