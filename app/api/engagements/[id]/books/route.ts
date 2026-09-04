import { currentUser, unauthorized, notFound, badRequest } from '@/lib/auth';
import { one } from '@/lib/db';
import { getEngagement } from '@/lib/review-engine/store';
import {
  importAccounts,
  listImports,
  recordImport,
  spreadsheetSource,
} from '@/lib/review-engine/books';
import type { FileRow } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

/**
 * The books behind an engagement, normalised into the firm's chart of accounts.
 *
 * Today the only source is an uploaded trial balance. The connectors — Tally,
 * QuickBooks, Zoho, Xero — plug in behind the same interface once the firm has
 * registered the developer apps; the valuable half of that work, which is that
 * a Stage 1 check reads one set of standard keys rather than each system's own
 * naming, is done and pays off on the spreadsheet already.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await getEngagement(id))) return notFound();

  const imports = await listImports(id);
  const detailFor = new URL(req.url).searchParams.get('import');

  return Response.json({
    imports: imports.map((row) => ({
      id: row.id,
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      // Three separate dates, and they answer three different questions: when
      // the data left the source system, what period it covers, and when it was
      // brought in here.
      extractedAt: Number(row.extracted_at),
      importedAt: Number(row.created_at),
      rowCount: row.row_count,
      unmappedCount: row.unmapped_count,
      contentHash: row.content_hash,
    })),
    accounts: detailFor
      ? (await importAccounts(detailFor)).map((a) => ({
          code: a.source_code,
          name: a.source_name,
          balance: a.balance_cents === null ? null : Number(a.balance_cents) / 100,
          key: a.mapped_key,
          confidence: a.mapped_confidence,
          reason: a.mapping_reason,
        }))
      : undefined,
  });
}

/** Body: { fileId } — a trial balance already uploaded through /api/files. */
export async function POST(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await getEngagement(id))) return notFound();

  const body = await req.json().catch(() => ({}));
  const fileId = String(body.fileId ?? '');
  if (!fileId) return badRequest('fileId is required.');

  // Existence, not ownership: reviews are firm-visible, and the preparer who
  // uploaded the trial balance is routinely not the reviewer importing it.
  const file = await one<FileRow>(
    `SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`,
    fileId,
  );
  if (!file) return notFound();

  try {
    const result = await recordImport(user.id, {
      engagementId: id,
      source: spreadsheetSource(async () => file.extracted_text ?? null),
      ref: fileId,
      periodStart: body.periodStart ? String(body.periodStart) : null,
      periodEnd: body.periodEnd ? String(body.periodEnd) : null,
    });

    return Response.json(
      {
        id: result.import.id,
        duplicate: result.duplicate,
        rowCount: result.import.row_count,
        mapped: result.mapped,
        unmapped: result.unmapped,
        weak: result.weak,
        skipped: result.skipped,
        contentHash: result.import.content_hash,
        note: result.duplicate
          ? 'This exact data was already imported, so nothing was written — the earlier import is returned.'
          : result.unmapped
            ? `${result.unmapped} account${result.unmapped === 1 ? '' : 's'} could not be mapped ` +
              'and will be put in front of the reviewer rather than guessed at.'
            : undefined,
      },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
