import 'server-only';
import crypto from 'node:crypto';
import { all, one, run as exec, audit } from '@/lib/db';

/**
 * The authority corpus, and the check that makes a citation mean something.
 *
 * The failure mode this exists for is the worst one available to a tax
 * platform: correct reasoning attached to a fabricated authority. It survives
 * review precisely because it reads well — the argument is sound, the reference
 * is formatted like a reference, and nobody re-checks a citation that looks
 * right.
 *
 * So grounding is not a claim the model can make. A citation is authority only
 * when the words it quotes are found in text somebody loaded, addressed by that
 * citation, in force for the year under review. Everything else is recorded as
 * claimed and tagged for a person — never rendered as authority.
 *
 * Two consequences worth stating plainly:
 *
 *   - An empty corpus grounds nothing. That is the correct behaviour, not a
 *     degraded one: with nothing to check against, every citation is unchecked.
 *   - A citation the firm has not loaded stays refused however real it is. The
 *     platform is not claiming the section does not exist; it is declining to
 *     assert something it cannot show.
 */

const now = () => Date.now();
const uuid = () => crypto.randomUUID();

/**
 * A citation reduced to something matchable.
 *
 * People write the same reference a dozen ways — "IRC §162(a)", "Sec. 162(a)",
 * "26 U.S.C. 162(a)", "Internal Revenue Code Section 162(a)". Matching on the
 * surface form would refuse correct citations over punctuation, and refusing a
 * correct citation trains a reviewer to ignore the warning.
 */
export function normaliseCitation(raw: string): string {
  let text = raw.toLowerCase().trim();

  text = text
    .replace(/§+/g, ' ')
    // Each of these ends `\b\.?` rather than `\.?\b`: a period is not followed
    // by a word boundary, so the other order leaves the dot behind and
    // "I.R.C. 162" becomes a different citation from "IRC 162".
    .replace(/\b26\s*u\.?\s*s\.?\s*c\b\.?/g, 'irc')
    .replace(/\binternal revenue code\b/g, 'irc')
    .replace(/\bi\.?r\.?c\b\.?/g, 'irc')
    .replace(/\btreas(ury)?\b\.?\s*\breg(ulation)?s?\b\.?/g, 'treasreg')
    .replace(/\b26\s*c\.?f\.?r\.?\b/g, 'treasreg')
    // The trailing period is stripped with the word, not left behind: "Sec. 162"
    // must reduce to the same key as "Section 162", and a stray "." would make
    // them different citations.
    .replace(/\b(sections?|secs?)\b\.?/g, ' ')
    .replace(/\bform\s+instructions?\s+(for\s+)?/g, 'inst ')
    .replace(/\binstructions?\s+(to|for)\s+(form\s+)?/g, 'inst ')
    .replace(/\bpub(lication)?\.?\s*/g, 'pub ')
    .replace(/[^a-z0-9().\-]+/g, ' ')
    .trim()
    // Punctuation left at either end by a stripped word is noise, not identity.
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '');

  // "irc 162(a)(1)" -> "irc-162(a)(1)"
  return text.replace(/\s+/g, '-');
}

/** The root a citation belongs to: "irc-162(a)(1)" -> "irc-162". */
export function citationRoot(raw: string): string {
  const key = normaliseCitation(raw);
  const stripped = key.replace(/\(.*$/, '');
  const parts = stripped.split('-').filter(Boolean);
  return parts.slice(0, 2).join('-');
}

export interface CorpusSourceRow {
  id: string;
  kind: string;
  title: string;
  citation_root: string;
  version_label: string | null;
  effective_from: number;
  effective_to: number | null;
  retrieved_at: number;
  source_url: string | null;
  content_hash: string;
  created_by: string | null;
  created_at: number;
}

export interface CorpusPassageRow {
  id: string;
  source_id: string;
  citation: string;
  citation_key: string;
  heading: string | null;
  body: string;
  ordinal: number;
}

export interface NewPassage {
  citation: string;
  heading?: string | null;
  body: string;
}

/**
 * Loads one dated source and its passages.
 *
 * Refuses a source with no effective date. Item 15 of the brief: a review must
 * never run against an undated snapshot, and the only way to guarantee that is
 * to make an undated source impossible to store rather than merely discouraged.
 */
export async function ingestSource(
  actorId: string | null,
  input: {
    kind: string;
    title: string;
    citationRoot?: string;
    versionLabel?: string | null;
    effectiveFrom: number;
    effectiveTo?: number | null;
    retrievedAt?: number;
    sourceUrl?: string | null;
    passages: NewPassage[];
  },
): Promise<{ source: CorpusSourceRow; passages: number }> {
  if (!Number.isFinite(input.effectiveFrom)) {
    throw new Error(
      'A corpus source needs the date it took effect. Tax authority is time-bound, and an ' +
        'undated source cannot be shown to have been in force for the year under review.',
    );
  }
  const passages = (input.passages ?? []).filter((p) => p.citation?.trim() && p.body?.trim());
  if (!passages.length) {
    throw new Error('A corpus source with no passages has nothing to ground a citation against.');
  }

  const root = normaliseCitation(input.citationRoot ?? citationRoot(passages[0].citation));
  const contentHash = crypto
    .createHash('sha256')
    .update(passages.map((p) => `${p.citation}\n${p.body}`).join('\n---\n'))
    .digest('hex')
    .slice(0, 32);

  // Same text, same root, same effective date: already loaded. Re-loading would
  // give two sources one reviewer could match and another could not.
  const existing = await one<CorpusSourceRow>(
    `SELECT * FROM corpus_sources
      WHERE citation_root = ? AND effective_from = ? AND content_hash = ?`,
    root,
    input.effectiveFrom,
    contentHash,
  );
  if (existing) {
    const count = await one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM corpus_passages WHERE source_id = ?`,
      existing.id,
    );
    return { source: existing, passages: Number(count?.n ?? 0) };
  }

  const id = uuid();
  await exec(
    `INSERT INTO corpus_sources
       (id, kind, title, citation_root, version_label, effective_from, effective_to,
        retrieved_at, source_url, content_hash, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.kind,
    input.title,
    root,
    input.versionLabel ?? null,
    input.effectiveFrom,
    input.effectiveTo ?? null,
    input.retrievedAt ?? now(),
    input.sourceUrl ?? null,
    contentHash,
    actorId,
    now(),
  );

  let ordinal = 0;
  for (const passage of passages) {
    await exec(
      `INSERT INTO corpus_passages (id, source_id, citation, citation_key, heading, body, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      uuid(),
      id,
      passage.citation.trim(),
      normaliseCitation(passage.citation),
      passage.heading?.trim() || null,
      passage.body.trim(),
      ordinal++,
    );
  }

  await audit(actorId, 'corpus.source_loaded', 'corpus_source', id, {
    kind: input.kind,
    root,
    passages: passages.length,
    effectiveFrom: input.effectiveFrom,
  });

  const source = (await one<CorpusSourceRow>(`SELECT * FROM corpus_sources WHERE id = ?`, id))!;
  return { source, passages: passages.length };
}

export const listSources = () =>
  all<CorpusSourceRow>(
    `SELECT * FROM corpus_sources ORDER BY citation_root, effective_from DESC`,
  );

/**
 * Passages for a citation, as the corpus stood on a given date.
 *
 * Ordered so an exact citation match comes before a match on the section it
 * sits under: "IRC 162(a)(1)" should return the subparagraph if it was loaded,
 * and fall back to the section only if it was not.
 */
export async function lookupCitation(
  citation: string,
  asOf: number,
): Promise<(CorpusPassageRow & { source: CorpusSourceRow })[]> {
  const key = normaliseCitation(citation);
  const root = citationRoot(citation);
  if (!key) return [];

  const rows = await all<CorpusPassageRow & CorpusSourceRow & { passage_id: string }>(
    `SELECT p.id AS passage_id, p.source_id, p.citation, p.citation_key, p.heading, p.body,
            p.ordinal, s.*
       FROM corpus_passages p
       JOIN corpus_sources s ON s.id = p.source_id
      WHERE (p.citation_key = ? OR p.citation_key LIKE ? OR s.citation_root = ?)
        AND s.effective_from <= ?
        AND (s.effective_to IS NULL OR s.effective_to >= ?)
      ORDER BY CASE WHEN p.citation_key = ? THEN 0 ELSE 1 END,
               s.effective_from DESC, p.ordinal ASC
      LIMIT 20`,
    key,
    `${key}(%`,
    root,
    asOf,
    asOf,
    key,
  );

  return rows.map((row) => ({
    id: row.passage_id,
    source_id: row.source_id,
    citation: row.citation,
    citation_key: row.citation_key,
    heading: row.heading,
    body: row.body,
    ordinal: row.ordinal,
    source: {
      id: row.source_id,
      kind: row.kind,
      title: row.title,
      citation_root: row.citation_root,
      version_label: row.version_label,
      effective_from: Number(row.effective_from),
      effective_to: row.effective_to === null ? null : Number(row.effective_to),
      retrieved_at: Number(row.retrieved_at),
      source_url: row.source_url,
      content_hash: row.content_hash,
      created_by: row.created_by,
      created_at: Number(row.created_at),
    },
  }));
}

export interface VerifiedCitation {
  ok: true;
  citation: string;
  /** The passage id and the words that were matched, for the workpaper. */
  sourceSpan: string;
  quote: string;
  source: CorpusSourceRow;
}

export interface RefusedCitation {
  ok: false;
  reason: string;
}

/** Words, lowercased, so quoting across a line break or a double space still matches. */
const words = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Whether a citation may be recorded as authority.
 *
 * Both halves have to hold: the citation is in the corpus for the year under
 * review, and the quoted words are actually in the passage. Checking only the
 * first would let a real section be attached to an invented proposition, which
 * is a subtler version of the same failure and just as hard to catch by eye.
 */
export async function verifyCitation(input: {
  citation: string;
  /** The words from the source the finding is resting on. */
  quote?: string | null;
  asOf: number;
}): Promise<VerifiedCitation | RefusedCitation> {
  const citation = input.citation.trim();
  if (!citation) return { ok: false, reason: 'No citation was given.' };

  const passages = await lookupCitation(citation, input.asOf);
  if (!passages.length) {
    return {
      ok: false,
      reason:
        `Nothing in the corpus is addressed by "${citation}" and in force for this year. ` +
        'State the principle in plain English instead — the platform will not assert authority ' +
        'it cannot show.',
    };
  }

  const quote = (input.quote ?? '').trim();
  if (!quote) {
    return {
      ok: false,
      reason:
        `"${citation}" is in the corpus, but no quoted words were given. Authority means the ` +
        'specific words the finding rests on, not the reference alone. Quote the passage.',
    };
  }
  if (words(quote).length < 25) {
    return {
      ok: false,
      reason:
        'The quoted passage is too short to be a meaningful match. Quote a full clause from ' +
        'the source.',
    };
  }

  const needle = words(quote);
  const hit = passages.find((p) => words(p.body).includes(needle));
  if (!hit) {
    return {
      ok: false,
      reason:
        `Those words do not appear in "${citation}" as the corpus holds it. Quote the source ` +
        'exactly, or state the principle in plain English and leave the authority to be verified.',
    };
  }

  return {
    ok: true,
    citation: hit.citation,
    sourceSpan: `${hit.source.title} — ${hit.citation} (passage ${hit.ordinal}, effective ${new Date(hit.source.effective_from).toISOString().slice(0, 10)})`,
    quote,
    source: hit.source,
  };
}

/**
 * What the corpus looked like on a date, in one string.
 *
 * Folded into the run's hash so two runs of the same return against different
 * states of the law are distinguishable afterwards. Without it, "we reviewed
 * this in March" and "we reviewed this in September" are the same record.
 */
export async function corpusFingerprint(asOf: number): Promise<{ fingerprint: string; sources: number }> {
  const rows = await all<{ content_hash: string; id: string }>(
    `SELECT id, content_hash FROM corpus_sources
      WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY id`,
    asOf,
    asOf,
  );
  const fingerprint = crypto
    .createHash('sha256')
    .update(rows.map((r) => r.content_hash).join('|') || 'empty-corpus')
    .digest('hex')
    .slice(0, 16);
  return { fingerprint, sources: rows.length };
}

/** True when there is anything at all to ground a citation against. */
export async function corpusHasContent(asOf: number): Promise<boolean> {
  const row = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM corpus_sources
      WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`,
    asOf,
    asOf,
  );
  return Number(row?.n ?? 0) > 0;
}
