import type { AuthorityStatus, FindingStatus, Severity, Verdict } from '@/lib/review-types';

/**
 * The small labelled markers the summary is built from.
 *
 * Every one of them prints its word as well as its colour. A partner reading a
 * photocopy, or anyone who does not separate red from amber, gets the same
 * information as somebody looking at the screen — which matters more here than
 * usual, because the whole point of the summary page is that it can be acted
 * on without interpretation.
 */

const SEVERITY_STYLE: Record<Severity, string> = {
  Critical: 'border-sev-critical/40 bg-sev-critical/10 text-sev-critical',
  High: 'border-sev-high/40 bg-sev-high/10 text-sev-high',
  Medium: 'border-sev-medium/40 bg-sev-medium/10 text-sev-medium',
  Low: 'border-sev-low/40 bg-sev-low/10 text-sev-low',
};

export function SeverityChip({ severity }: { severity: Severity | null }) {
  // An agreed line has no severity; it says so rather than showing an empty box.
  if (!severity) {
    return (
      <span className="inline-block rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink-faint">
        Agreed
      </span>
    );
  }
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${SEVERITY_STYLE[severity]}`}
    >
      {severity}
    </span>
  );
}

const VERDICT_STYLE: Record<Verdict, string> = {
  hold: 'border-sev-critical/45 bg-sev-critical/10 text-sev-critical',
  release_with_conditions: 'border-sev-high/45 bg-sev-high/10 text-sev-high',
  clear: 'border-verdict-clear/45 bg-verdict-clear/10 text-verdict-clear',
};

export const VERDICT_WORD: Record<Verdict, string> = {
  hold: 'Hold',
  release_with_conditions: 'Release with conditions',
  clear: 'Clear for release',
};

export function VerdictChip({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) {
    return (
      <span className="inline-block rounded border border-line px-2 py-0.5 text-[11px] text-ink-faint">
        Not yet run
      </span>
    );
  }
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-[11px] font-medium ${VERDICT_STYLE[verdict]}`}
    >
      {VERDICT_WORD[verdict]}
    </span>
  );
}

/**
 * The wording here is doing real work.
 *
 * "Answered — evidence pending" has to read as unfinished, because it is: a
 * typed explanation with nothing attached does not close a High finding, and
 * showing it as answered would invite exactly the quiet clearing under deadline
 * pressure the register is meant to make harder.
 */
const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Open',
  answered_pending_evidence: 'Answered — evidence pending',
  answered: 'Answered',
  closed: 'Closed',
  changed: 'Fixed and re-checked',
  escalated: 'Needs a reviewer',
  client: 'Waiting on the client',
};

const STATUS_STYLE: Record<FindingStatus, string> = {
  open: 'border-line text-ink-dim',
  answered_pending_evidence: 'border-sev-high/40 text-sev-high',
  answered: 'border-line text-ink-dim',
  closed: 'border-verdict-clear/40 text-verdict-clear',
  changed: 'border-verdict-clear/40 text-verdict-clear',
  escalated: 'border-sev-high/40 text-sev-high',
  client: 'border-line text-ink-dim',
};

export function StatusChip({ status }: { status: FindingStatus }) {
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10.5px] ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * What a finding is allowed to claim as authority.
 *
 * `verify` is shown in amber and never as a citation, because until a corpus
 * exists nothing can be grounded — and a reference rendered as though it were
 * checked is the exact failure this whole gate exists to prevent.
 */
export function AuthorityChip({
  status,
  citation,
  claimedCitation,
}: {
  status: AuthorityStatus;
  citation?: string | null;
  claimedCitation?: string | null;
}) {
  if (status === 'none_required') return null;

  if (status === 'grounded' && citation) {
    return (
      <span className="inline-block rounded border border-verdict-clear/40 px-1.5 py-0.5 text-[10.5px] text-verdict-clear">
        {citation}
      </span>
    );
  }

  return (
    <span
      className="inline-block rounded border border-sev-high/40 px-1.5 py-0.5 text-[10.5px] text-sev-high"
      title={
        claimedCitation
          ? `The model offered "${claimedCitation}". Nothing verified it, so it is not shown as authority.`
          : 'Stated in plain English; the authority still needs checking.'
      }
    >
      Needs verifying
    </span>
  );
}
