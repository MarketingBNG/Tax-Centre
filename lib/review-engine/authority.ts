import { CITATION_CORPUS_ENABLED } from '@/lib/config';
import type { AuthorityStatus } from '@/lib/review-types';

/**
 * Rule 2: no citation without a source, and no source means no citation.
 *
 * A code section, regulation, form instruction or penalty figure appears on a
 * finding only if it was retrieved from a verified corpus. Otherwise the
 * finding states the principle in plain English and is tagged `verify`.
 *
 * This is the single most dangerous failure mode in a tax practice: correct
 * reasoning attached to a fabricated authority. It is dangerous specifically
 * because it survives review — the reasoning reads well, the citation looks
 * like a citation, and nobody checks a reference that is formatted correctly.
 *
 * Grounding is decided by a lookup, never by the model. corpus.ts checks that
 * the citation is in loaded text that was in force for the year, and that the
 * quoted words are actually in the passage; this gate records what that lookup
 * found. With nothing loaded, nothing grounds — which is the correct answer
 * rather than a degraded one.
 *
 * A refused citation is kept in `claimed_citation` rather than dropped.
 * Discarded silently, a pattern of invented authority would be invisible; kept,
 * it is auditable and it is the signal the fabrication probes read.
 *
 * The database backs this up: run_findings carries
 * CHECK (authority_citation IS NULL OR authority_status = 'grounded'),
 * so even a bug here cannot store an ungrounded citation as authority.
 */

export interface AuthorityInput {
  status?: string | null;
  citation?: string | null;
  sourceSpan?: string | null;
  /**
   * The result of actually looking the citation up in the corpus.
   *
   * Passed in rather than fetched here so this stays a pure function, and
   * absent means "not verified" — the safe reading. The lookup itself lives in
   * corpus.ts; this decides what may be recorded given what it found.
   */
  verified?: { citation: string; sourceSpan: string } | null;
  /** Why the lookup refused it, for the message the model gets back. */
  refusedReason?: string | null;
}

export interface GatedAuthority {
  status: AuthorityStatus;
  citation: string | null;
  sourceSpan: string | null;
  /** What the model asked for, when it was not granted. */
  claimedCitation: string | null;
  /** Set when something was taken away, for the retry message and the audit trail. */
  demotedReason: string | null;
}

const VALID: AuthorityStatus[] = ['none_required', 'grounded', 'verify'];

/**
 * Resolves what a finding is allowed to claim.
 *
 * Deliberately total: every path returns a legal combination, because the one
 * outcome that must never happen is a citation surviving on a technicality.
 */
export function gateAuthority(input: AuthorityInput): GatedAuthority {
  const claimed = input.citation?.trim() || null;
  const requested = (VALID as string[]).includes(String(input.status))
    ? (input.status as AuthorityStatus)
    : null;

  // Nothing claimed: whatever the model said, there is no authority to police.
  if (!claimed) {
    return {
      status: requested === 'grounded' ? 'verify' : (requested ?? 'none_required'),
      citation: null,
      sourceSpan: null,
      claimedCitation: null,
      demotedReason:
        requested === 'grounded'
          ? 'Marked grounded with no citation attached, so there is nothing to have grounded it.'
          : null,
    };
  }

  if (!CITATION_CORPUS_ENABLED) {
    return {
      status: 'verify',
      citation: null,
      sourceSpan: null,
      claimedCitation: claimed,
      demotedReason:
        'No verified corpus is wired up, so no citation can be grounded. State the ' +
        'principle in plain English and leave the authority to be verified.',
    };
  }

  // The corpus path. Grounding is not something the model can assert: it is
  // what the lookup found. A citation the corpus confirmed, whose quoted words
  // were found in the passage, is authority; anything else is a claim.
  if (input.verified) {
    return {
      status: 'grounded',
      citation: input.verified.citation,
      sourceSpan: input.verified.sourceSpan,
      claimedCitation: null,
      demotedReason: null,
    };
  }

  return {
    status: 'verify',
    citation: null,
    sourceSpan: null,
    claimedCitation: claimed,
    demotedReason:
      input.refusedReason ??
      'A citation is only authority when the corpus confirms it and the quoted words are ' +
        'found in the passage. Without that it is recorded as claimed and tagged for ' +
        'verification.',
  };
}

/**
 * True when a finding rests on authority nobody has checked.
 *
 * Feeds the severity tree: a position taken on unverified authority is High,
 * not a footnote, because it is a position the firm cannot defend as filed.
 */
export const needsVerification = (status: AuthorityStatus): boolean => status === 'verify';
