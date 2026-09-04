import 'server-only';
import { buildDocumentParts, type DocIndexEntry } from '@/lib/ingest';
import type { FileRow } from '@/lib/types';
import type { Part } from '@/lib/providers/types';
import type { DocRole } from '@/lib/review-types';

/**
 * How the review engine reads the documents it is given.
 *
 * There is one implementation today — the model looks at the pages. That is an
 * honest description of what happens with a Drake PDF: there is no text layer
 * being parsed, so a figure read off page 3 is a figure the model saw, and
 * nothing in code can confirm it.
 *
 * The interface exists because that is the thing most worth replacing. A
 * structured Drake or ProConnect export would give typed fields instead of
 * pixels, which turns the mandatory tie-outs (K-1 total = Schedule K line,
 * L = M-2, 5472 Part IV = ledger) from something the model asserts into
 * something the calculation layer computes. When that parser arrives it
 * implements this interface, reports a high confidence for the fields it read,
 * and everything downstream keeps working unchanged.
 *
 * Until then `parserId` on every document says 'model-visual', and the amounts
 * gate treats figures sourced that way as unverified — see lib/review-engine/amounts.ts.
 */

export interface ParsedDocument {
  fileId: string;
  filename: string;
  docRole: DocRole;
  /** Which parser read it — recorded on run_documents so a run is reproducible. */
  parserId: string;
  /**
   * How far the parser trusts its own reading, 0-1.
   *
   * A page-image read cannot be checked, so it is capped well below a parsed
   * field would be. Below REVIEW_CONFIDENCE_THRESHOLD, a finding resting on it
   * is escalated to a human rather than asserted.
   */
  confidence: number;
  /**
   * Machine-readable text, where there is any. Spreadsheets and Word documents
   * have it; PDFs do not, which is the whole limitation described above.
   */
  text: string | null;
}

export interface ReturnData {
  /** Provider-neutral parts, in the order the model receives them. */
  parts: Part[];
  /** Document slots, in the order a citation's document_index refers to. */
  index: DocIndexEntry[];
  documents: ParsedDocument[];
}

export interface ReturnDataParser {
  id: string;
  parse(files: { file: FileRow; docRole: DocRole }[]): Promise<ReturnData>;
}

/**
 * Confidence a page-image read is allowed to claim.
 *
 * Deliberately below the escalation threshold's neighbourhood: it is not a
 * judgement about this particular document, it is a statement that nothing
 * verified it.
 */
export const VISUAL_CONFIDENCE = 0.6;
/** Text a parser actually extracted — a cell address, a paragraph — is checkable. */
export const EXTRACTED_CONFIDENCE = 0.95;

export const ModelVisualParser: ReturnDataParser = {
  id: 'model-visual',

  async parse(files) {
    const { parts, index } = await buildDocumentParts(files.map((f) => f.file));

    return {
      parts,
      index,
      documents: files.map(({ file, docRole }) => ({
        fileId: file.id,
        filename: file.filename,
        docRole,
        parserId: 'model-visual',
        // A spreadsheet or a Word file was genuinely read into text; a PDF was
        // handed over as pages for the model to look at. The difference matters
        // enough downstream to record it per document rather than per run.
        confidence: file.extracted_text ? EXTRACTED_CONFIDENCE : VISUAL_CONFIDENCE,
        text: file.extracted_text,
      })),
    };
  },
};

/** The parser to use for a document. One today; chosen per file once there are more. */
export const parserFor = (_file: FileRow): ReturnDataParser => ModelVisualParser;
