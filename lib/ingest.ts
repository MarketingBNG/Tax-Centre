import 'server-only';
import crypto from 'node:crypto';
import path from 'node:path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { one, run } from './db';
import { MAX_PDF_PAGES, PII_MODE } from './config';
import { putBlob, getBlob } from './storage';
import { tokenizeText, type PiiCounts } from './pii';
import type { FileRow, FileKind } from './types';
import type { Part } from './providers/types';

// Base64 inflates ~1.37x, and the whole request has to fit in memory on a
// serverless instance, so keep single files well under the platform ceiling.
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

interface Sniffed {
  kind: FileKind | 'unsupported';
  mime: string;
  label?: string;
}

/** Magic-byte sniffing. The extension and the browser's mime are untrusted. */
function sniff(b: Buffer, filename: string): Sniffed {
  const ext = path.extname(filename).slice(1).toLowerCase();

  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
    return { kind: 'pdf', mime: 'application/pdf' };
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { kind: 'image', mime: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { kind: 'image', mime: 'image/jpeg' };
  if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'GIF8')
    return { kind: 'image', mime: 'image/gif' };
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return { kind: 'image', mime: 'image/webp' };

  // OOXML files are ZIP containers; tell them apart by the parts inside.
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b) {
    const head = b.subarray(0, Math.min(b.length, 8000)).toString('latin1');
    if (head.includes('word/') || ext === 'docx')
      return {
        kind: 'docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
    if (head.includes('xl/') || ext === 'xlsx' || ext === 'xlsm')
      return {
        kind: 'xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    return { kind: 'unsupported', mime: 'application/zip', label: 'ZIP archive' };
  }

  // Legacy OLE2 container: .doc / .xls
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)
    return { kind: 'unsupported', mime: 'application/x-cfb', label: 'legacy .doc/.xls' };

  if (['csv', 'txt', 'md', 'tsv'].includes(ext)) return { kind: 'text', mime: 'text/plain' };
  if (IMAGE_MIMES[ext]) return { kind: 'image', mime: IMAGE_MIMES[ext] };

  return {
    kind: 'unsupported',
    mime: 'application/octet-stream',
    label: ext || 'unknown type',
  };
}

/** Handles the UTF-16 and BOM variants Excel exports routinely produce. */
function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Buffer.swap16() throws on an odd-length buffer, which is exactly what a
    // truncated UTF-16BE export looks like. Drop the stray byte instead.
    const even = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
    const swapped = Buffer.from(even);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

const colLetter = (n: number): string => {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/**
 * Render a workbook so cell addresses survive into the prompt. An answer that
 * says "row 14" is useless; "Depreciation!D14" is actionable. Formulas are
 * emitted alongside computed values rather than instead of them, so a broken
 * fill pattern stays visible instead of being flattened into a plain table.
 */
async function renderWorkbook(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);

  const out: string[] = [];
  const errorCells: string[] = [];
  out.push(`WORKBOOK — ${wb.worksheets.length} sheet(s)`);

  for (const ws of wb.worksheets) {
    const dim = ws.dimensions as unknown as
      | { top: number; bottom: number; left: number; right: number }
      | undefined;
    if (!dim) {
      out.push(`\n## Sheet "${ws.name}" — empty`);
      continue;
    }
    out.push(
      `\n## Sheet "${ws.name}" — rows ${dim.top}-${dim.bottom}, cols ${colLetter(dim.left)}-${colLetter(dim.right)}`,
    );

    const formulas: string[] = [];
    const lines: string[] = [];
    const maxRow = Math.min(dim.bottom, dim.top + 2000);

    for (let r = dim.top; r <= maxRow; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];

      for (let c = dim.left; c <= dim.right; c++) {
        const cell = row.getCell(c);
        if (cell.value === null || cell.value === undefined || cell.value === '') continue;
        const addr = `${colLetter(c)}${r}`;
        let value: unknown = cell.value;

        if (typeof value === 'object' && value !== null) {
          const v = value as Record<string, unknown>;
          if (v.formula !== undefined) {
            formulas.push(`${addr} = ${String(v.formula)}`);
            value = v.result ?? '';
          } else if (v.error !== undefined) {
            errorCells.push(`${ws.name}!${addr} (${String(v.error)})`);
            value = v.error;
          } else if (Array.isArray(v.richText)) {
            value = (v.richText as { text: string }[]).map((t) => t.text).join('');
          } else if (v.text !== undefined) {
            value = v.text;
          } else if (value instanceof Date) {
            value = value.toISOString().slice(0, 10);
          } else {
            value = JSON.stringify(value);
          }
        }
        cells.push(`${addr}: ${String(value)}`);
      }
      if (cells.length) lines.push(`r${r} | ${cells.join(' | ')}`);
    }

    out.push(lines.join('\n') || '(no populated cells)');
    if (dim.bottom > maxRow)
      out.push(`\n[NOTE: rows ${maxRow + 1}-${dim.bottom} not rendered — sheet exceeds row cap]`);
    if (formulas.length) {
      out.push(`\n### Formulas in "${ws.name}" (${formulas.length})`);
      out.push(formulas.slice(0, 400).join('\n'));
      if (formulas.length > 400) out.push(`[... ${formulas.length - 400} more formulas]`);
    }
  }

  if (errorCells.length)
    out.unshift(`WARNING — cells containing formula errors: ${errorCells.join(', ')}`);

  return out.join('\n');
}

export interface IngestedFile extends FileRow {
  deduped?: boolean;
}

export async function ingestFile(input: {
  userId: string;
  conversationId: string | null;
  /** Set instead of conversationId when the upload is going to a project shelf. */
  projectId?: string | null;
  filename: string;
  buffer: Buffer;
}): Promise<IngestedFile> {
  const { userId, conversationId, filename, buffer } = input;
  const projectId = input.projectId ?? null;
  const sniffed = sniff(buffer, filename);

  if (sniffed.kind === 'unsupported') {
    throw new Error(
      `Cannot read "${filename}" — detected ${sniffed.label}. ` +
        `Supported: PDF, DOCX, XLSX, CSV, TXT and images (PNG/JPG/GIF/WebP). ` +
        `For a legacy .doc or .xls, re-save it as .docx or .xlsx first.`,
    );
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  /**
   * Deduplication is scoped to where the upload is going.
   *
   * Matching across scopes is wrong in both directions. Re-pointing the row
   * steals the document out of the conversation that already had it, and its
   * follow-up turns silently lose the file. Handing the row back without
   * re-pointing it is no better: the new conversation shows an attachment the
   * model cannot see, and answers that it has no document.
   *
   * So a match only counts when it is already in the same place the upload is
   * going, or when it is not yet anywhere. Everything else falls through and
   * gets its own row, which is also what keeps retention honest — purging one
   * conversation cannot empty another.
   */
  const existing = await one<FileRow>(
    `SELECT * FROM files
      WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL
        AND ( (?::text IS NOT NULL AND project_id = ?)
           OR (?::text IS NOT NULL AND conversation_id = ?)
           OR (conversation_id IS NULL AND project_id IS NULL) )
      ORDER BY created_at LIMIT 1`,
    userId,
    sha256,
    projectId,
    projectId,
    conversationId,
    conversationId,
  );
  if (existing) {
    const unattached = existing.conversation_id === null && existing.project_id === null;

    // Still in the composer with nowhere to live: give it this home rather than
    // storing the same bytes twice.
    if (unattached && projectId) {
      await run(`UPDATE files SET project_id = ? WHERE id = ?`, projectId, existing.id);
      return { ...existing, project_id: projectId, deduped: true };
    }
    if (unattached && conversationId) {
      await run(`UPDATE files SET conversation_id = ? WHERE id = ?`, conversationId, existing.id);
      return { ...existing, conversation_id: conversationId, deduped: true };
    }
    return { ...existing, deduped: true };
  }

  if (buffer.length > MAX_INLINE_BYTES) {
    throw new Error(
      `"${filename}" is ${(buffer.length / 1048576).toFixed(1)} MB, over the ` +
        `${MAX_INLINE_BYTES / 1048576} MB per-file limit. Split it and upload the parts.`,
    );
  }

  let pageCount: number | null = null;
  let extracted: string | null = null;

  if (sniffed.kind === 'pdf') {
    let pdf: PDFDocument;
    try {
      // ignoreEncryption lets us LOAD an encrypted file rather than accept one.
      // Without it pdf-lib throws on encryption and we could not tell a locked
      // PDF apart from a broken one, which are different problems with
      // different remedies. The isEncrypted check below is what refuses it.
      pdf = await PDFDocument.load(buffer as unknown as ArrayBuffer, {
        ignoreEncryption: true,
      });
      pageCount = pdf.getPageCount();
    } catch {
      throw new Error(
        `"${filename}" could not be opened as a PDF. The file may be truncated or ` +
          `not really a PDF despite its name.`,
      );
    }

    // Refused here, because the alternative is failing several steps later for
    // reasons nobody can act on.
    //
    // A PDF's page tree is not encrypted even when its content streams are, so
    // the load above succeeds and the page count is correct. The bytes then go
    // to the model, which cannot read them, and the answer comes back as
    // "badly formatted or corrupted" naming no file — so with several documents
    // attached, one locked file fails the whole message and the unlocked ones
    // take the blame. pdf-lib cannot decrypt (it has no password option at
    // all), so this is a refusal rather than something we can quietly fix.
    //
    // Worth saying in the message: most of these open with no password prompt.
    // A permissions lock encrypts the content while leaving the open password
    // empty, which is why a file that looks fine is rejected here.
    if (pdf.isEncrypted) {
      throw new Error(
        `"${filename}" is encrypted, so the model cannot read it. It may well open ` +
          `without asking for a password — a permissions lock does that, and the ` +
          `content is still encrypted. Open it in a PDF reader, re-save it with ` +
          `Print to PDF, and upload that copy. If it does ask for a password, ` +
          `remove the password first.`,
      );
    }
    if (pageCount > MAX_PDF_PAGES) {
      throw new Error(
        `"${filename}" has ${pageCount} pages, over the ${MAX_PDF_PAGES}-page limit for one ` +
          `request. Split it into smaller documents — nothing is truncated silently.`,
      );
    }
  } else if (sniffed.kind === 'docx') {
    extracted = (await mammoth.extractRawText({ buffer })).value;
  } else if (sniffed.kind === 'xlsx') {
    extracted = await renderWorkbook(buffer);
  } else if (sniffed.kind === 'text') {
    extracted = decodeText(buffer);
  }

  // Tokenisation only applies to text we generated. PDFs and images go as
  // bytes and pixels — see the note in lib/pii.ts.
  let piiCounts: PiiCounts = {};
  if (extracted && PII_MODE === 'tokenize') {
    const result = await tokenizeText(extracted);
    extracted = result.text;
    piiCounts = result.counts;
  }

  const id = crypto.randomUUID();
  const ext = path.extname(filename).toLowerCase();
  const stored = await putBlob(`uploads/${userId}/${id}${ext}`, buffer, sniffed.mime);

  await run(
    `INSERT INTO files
       (id, user_id, conversation_id, project_id, filename, mime, kind, size_bytes, sha256,
        storage_path, page_count, extracted_text, pii_counts, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    userId,
    conversationId,
    projectId,
    filename,
    sniffed.mime,
    sniffed.kind,
    buffer.length,
    sha256,
    stored.pathname,
    pageCount,
    extracted,
    Object.keys(piiCounts).length ? JSON.stringify(piiCounts) : null,
    Date.now(),
  );

  return (await one<FileRow>(`SELECT * FROM files WHERE id = ?`, id))!;
}

export interface DocIndexEntry {
  fileId: string;
  title: string;
  kind: string;
}

/**
 * Turn stored files into provider-neutral parts.
 *
 * `index` records only the parts that occupy a document slot, in order,
 * because that ordering is what a citation's document_index refers to. Images
 * do not take a slot, so they are deliberately absent from it.
 */
export async function buildDocumentParts(files: FileRow[]): Promise<{
  parts: Part[];
  index: DocIndexEntry[];
}> {
  const parts: Part[] = [];
  const index: DocIndexEntry[] = [];

  for (const f of files) {
    const title = f.filename;

    if (f.kind === 'pdf' || f.kind === 'image') {
      const bytes = await getBlob(f.storage_path);
      if (!bytes) continue; // purged by retention; skip rather than crash
      if (f.kind === 'pdf') {
        parts.push({ kind: 'pdf', title, base64: bytes.toString('base64') });
        index.push({ fileId: f.id, title, kind: f.kind });
      } else {
        parts.push({ kind: 'image', title, mediaType: f.mime, base64: bytes.toString('base64') });
      }
    } else if (f.extracted_text) {
      parts.push({ kind: 'text-doc', title, text: f.extracted_text });
      index.push({ fileId: f.id, title, kind: f.kind });
    }
  }

  return { parts, index };
}
