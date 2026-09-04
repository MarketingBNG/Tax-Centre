import { currentUser, unauthorized, forbidden, badRequest } from '@/lib/auth';
import { corpusFingerprint, ingestSource, listSources } from '@/lib/review-engine/corpus';
import { CITATION_CORPUS_ENABLED } from '@/lib/config';

/**
 * Loading and listing the authority corpus.
 *
 * The platform ships with nothing in here on purpose. What a review may cite is
 * what the firm has loaded and is licensed to hold — form instructions, IRS
 * publications, the firm's own SOPs, statutory text where it has the rights —
 * and a citation outside that stays refused however real the section is.
 *
 * Every source has to say when it took effect. Tax authority is time-bound: the
 * same section can need a different state for a March review and a September
 * one, and a run records the corpus date it read against so the finding can be
 * defended months later against the law as it stood, not as it stands.
 */

const KINDS = [
  'irc',
  'treas_reg',
  'form_instructions',
  'irs_pub',
  'firm_sop',
  'india_act',
  'other',
];

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const sources = await listSources();
  const { fingerprint, sources: inForce } = await corpusFingerprint(Date.now());

  return Response.json({
    // Loaded content is not enough on its own: the flag is what lets a citation
    // be grounded at all, so a corpus with content and the flag off is worth
    // saying out loud rather than looking mysteriously ineffective.
    enabled: CITATION_CORPUS_ENABLED,
    fingerprint,
    inForce,
    sources: sources.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      citationRoot: s.citation_root,
      versionLabel: s.version_label,
      effectiveFrom: s.effective_from,
      effectiveTo: s.effective_to,
      retrievedAt: s.retrieved_at,
      sourceUrl: s.source_url,
      contentHash: s.content_hash,
    })),
  });
}

/**
 * Loads one source.
 *
 * Body: { kind, title, citationRoot?, versionLabel?, effectiveFrom, effectiveTo?,
 *         retrievedAt?, sourceUrl?, passages: [{ citation, heading?, body }] }
 *
 * Dates are epoch milliseconds or anything Date can parse. Re-loading identical
 * text under the same citation and date is a no-op rather than a duplicate —
 * two sources one reviewer could match and another could not is worse than
 * either of them alone.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const body = await req.json().catch(() => ({}));

  const kind = String(body.kind ?? '');
  if (!KINDS.includes(kind)) return badRequest(`kind must be one of: ${KINDS.join(', ')}`);

  const title = String(body.title ?? '').trim();
  if (!title) return badRequest('A source needs a title — it is what appears on the workpaper.');

  const asDate = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Date.parse(String(value));
    return Number.isFinite(parsed) ? Number(parsed) : null;
  };

  const effectiveFrom = asDate(body.effectiveFrom);
  if (effectiveFrom === null) {
    return badRequest(
      'effectiveFrom is required: a source that cannot be shown to have been in force for the ' +
        'year under review is not authority for it.',
    );
  }

  const passages = Array.isArray(body.passages)
    ? body.passages.map((p: Record<string, unknown>) => ({
        citation: String(p.citation ?? ''),
        heading: p.heading == null ? null : String(p.heading),
        body: String(p.body ?? ''),
      }))
    : [];
  if (!passages.length) return badRequest('passages is required, with at least one entry.');

  try {
    const { source, passages: count } = await ingestSource(user.id, {
      kind,
      title,
      citationRoot: body.citationRoot ? String(body.citationRoot) : undefined,
      versionLabel: body.versionLabel ? String(body.versionLabel) : null,
      effectiveFrom,
      effectiveTo: asDate(body.effectiveTo),
      retrievedAt: asDate(body.retrievedAt) ?? undefined,
      sourceUrl: body.sourceUrl ? String(body.sourceUrl) : null,
      passages,
    });

    return Response.json(
      {
        id: source.id,
        citationRoot: source.citation_root,
        contentHash: source.content_hash,
        passages: count,
        enabled: CITATION_CORPUS_ENABLED,
        note: CITATION_CORPUS_ENABLED
          ? undefined
          : 'Loaded, but CITATION_CORPUS_ENABLED is off, so citations are still demoted. ' +
            'Set it to true to let a verified citation be recorded as authority.',
      },
      { status: 201 },
    );
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
