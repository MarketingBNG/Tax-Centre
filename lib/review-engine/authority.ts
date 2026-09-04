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
 * There is no corpus yet. So `grounded` is currently unreachable and this gate
 * demotes every citation the model offers, keeping what it claimed in
 * `claimed_citation` — discarded silently, a pattern of invented authority
 * would be invisible; kept, it is auditable and it is the eval signal for the
 * fabrication probes.
 *
 * The database backs this up: run_findings carries
 * CHECK (authority_citation IS NULL OR authority_status = 'grounded'),
 * so even a bug here cannot store an ungrounded citation as authority.
 */

export interface AuthorityInput {
  status?: string | null;
  citation?: string | null;
  sourceSpan?: string | null;
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
  const sourceSpan = input.sourceSpan?.trim() || null;
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

  // The corpus path. Grounding means a retrieved span, not a plausible-looking
  // reference — a citation with no span is exactly the failure mode this guards.
  if (requested === 'grounded' && sourceSpan) {
    return {
      status: 'grounded',
      citation: claimed,
      sourceSpan,
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
      'A citation is only authority when it points at a retrieved source span. ' +
      'Without one it is recorded as claimed and tagged for verification.',
  };
}

/**
 * True when a finding rests on authority nobody has checked.
 *
 * Feeds the severity tree: a position taken on unverified authority is High,
 * not a footnote, because it is a position the firm cannot defend as filed.
 */
export const needsVerification = (status: AuthorityStatus): boolean => status === 'verify';
