'use client';

import { SeverityChip, StatusChip, VERDICT_WORD } from './chips';
import type { RunDetail, FindingView } from './types';

/**
 * The one-page audit summary.
 *
 * This is the page the team actually reads; everything the engine does exists
 * to produce it well. The zones are in the order the guidance document sets
 * out, and the order is the point — a partner reads top to bottom and stops as
 * soon as they have what they came for:
 *
 *   who and what -> the verdict -> which specialism -> the five worst -> does it tie out
 *
 * Nothing here recomputes anything. The counts, the category totals and the
 * top five all arrive from the API already derived, because a page that counted
 * its own findings would eventually disagree with the print view and the
 * engagement list about the same register.
 */

const money = (value: number): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function HeaderBand({ detail }: { detail: RunDetail }) {
  const { engagement, run, approval } = detail;
  const facts: [string, string][] = [
    ['Entity', engagement?.entityName || engagement?.clientLabel || '—'],
    ['EIN', engagement?.ein || '—'],
    ['Return', engagement?.returnType || '—'],
    ['Tax year', engagement?.taxYear ? String(engagement.taxYear) : '—'],
    ['Run', `${run.runNumber}`],
    ['Register version', `${run.registerVersion}`],
    ['Run date', new Date(run.createdAt).toLocaleDateString()],
    [
      'Reviewer',
      approval
        ? approval.approvedBy + (approval.selfApproved ? ' (started this run)' : '')
        : 'not yet signed off',
    ],
    // In front of the people running reviews, not only in an admin total a
    // month later: a review is the most expensive thing here and the cost is
    // per return.
    ['Cost to run', run.costUsd > 0 ? `$${run.costUsd.toFixed(2)}` : '—'],
  ];

  return (
    <section className="trc-print-zone rounded-xl border border-line-soft bg-panel px-4 py-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label}>
            <div className="text-[10.5px] tracking-wide text-ink-faint uppercase">{label}</div>
            <div className="mt-0.5 truncate text-[13px]">{value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The single fact a partner needs before opening anything else.
 *
 * Carries the word and the count, not only the colour — this is the line that
 * has to survive a photocopier and a reader who does not separate red from
 * amber.
 */
function VerdictBanner({ detail }: { detail: RunDetail }) {
  const verdict = detail.run.verdict;
  const open = detail.derived.openCriticalHigh;

  const style =
    verdict === 'clear'
      ? 'border-verdict-clear/45 bg-verdict-clear/10 text-verdict-clear'
      : verdict === 'release_with_conditions'
        ? 'border-sev-high/45 bg-sev-high/10 text-sev-high'
        : 'border-sev-critical/45 bg-sev-critical/10 text-sev-critical';

  const blockers = detail.run.verdictDetail?.blockers ?? [];

  return (
    // Sticky, because the register below it runs to a screen or three and the
    // verdict is the fact every one of those lines is being read against.
    //
    // The opaque wrapper is not decoration: the banner's own background is a
    // 10% tint, so without something solid behind it the register would scroll
    // visibly through the verdict. Print resets both (trc-print-sticky).
    <div className="trc-print-sticky sticky top-0 z-10 bg-canvas py-1">
    <section className={`trc-print-zone rounded-xl border px-4 py-3.5 ${verdict ? style : 'border-line text-ink-dim'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-[22px] font-semibold tracking-tight">
          {verdict ? VERDICT_WORD[verdict] : 'Not yet decided'}
        </div>
        <div className="text-[13px]">
          {open === 0
            ? 'No Critical or High items open'
            : `${open} Critical or High item${open === 1 ? '' : 's'} open`}
        </div>
      </div>

      {blockers.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[12.5px] opacity-90">
          {blockers.slice(0, 4).map((blocker, i) => (
            <li key={i}>— {blocker}</li>
          ))}
        </ul>
      )}
    </section>
    </div>
  );
}

/**
 * Six rows so the team can route work by specialism without reading every line.
 *
 * The last row is High-flag, and it is a filter rather than a category: a
 * Critical bookkeeping finding appears in Bookkeeping *and* here. That is why
 * the counts across these rows deliberately do not sum to the register total.
 */
function CategoryStrip({
  detail,
  onPick,
  active,
}: {
  detail: RunDetail;
  onPick: (key: string | null) => void;
  active: string | null;
}) {
  const order = [
    'bookkeeping',
    'financial',
    'irs_return',
    'cross_border',
    'transfer_pricing',
    'high_flag',
  ];

  const tone = (worst: string | null) =>
    worst === 'Critical'
      ? 'text-sev-critical'
      : worst === 'High'
        ? 'text-sev-high'
        : worst === 'Medium'
          ? 'text-sev-medium'
          : worst === 'Low'
            ? 'text-sev-low'
            : 'text-ink-faint';

  return (
    <section className="trc-print-zone overflow-hidden rounded-xl border border-line-soft bg-panel">
      {order.map((key, i) => {
        const row = detail.derived.categories[key];
        if (!row) return null;
        const isActive = active === key;
        return (
          <button
            key={key}
            onClick={() => onPick(isActive ? null : key)}
            className={`flex w-full items-center justify-between px-4 py-2 text-left text-[13px] ${
              i > 0 ? 'border-t border-line-soft' : ''
            } ${isActive ? 'bg-raised' : 'hover:bg-raised'} ${key === 'high_flag' ? 'border-t-2 border-line' : ''}`}
          >
            <span className={key === 'high_flag' ? 'font-medium' : ''}>{row.label}</span>
            <span className={`tabular-nums ${tone(row.worst)}`}>
              {row.open === 0 ? '—' : row.open}
            </span>
          </button>
        );
      })}
    </section>
  );
}

/** Most reviews turn on three to five real issues; surfacing them first respects the reader. */
function TopFindings({
  detail,
  onOpen,
}: {
  detail: RunDetail;
  onOpen: (finding: FindingView) => void;
}) {
  const top = detail.derived.topFindingIds
    .map((id) => detail.findings.find((f) => f.id === id))
    .filter((f): f is FindingView => Boolean(f));

  if (!top.length) {
    return (
      <section className="trc-print-zone rounded-xl border border-line-soft bg-panel px-4 py-3">
        <h2 className="mb-1 text-[13px] font-medium">Top findings</h2>
        <p className="text-[12.5px] text-ink-faint">Nothing open. Every finding is closed or agreed.</p>
      </section>
    );
  }

  return (
    <section className="trc-print-zone rounded-xl border border-line-soft bg-panel px-4 py-3">
      <h2 className="mb-2 text-[13px] font-medium">
        Top {top.length} finding{top.length === 1 ? '' : 's'}
      </h2>
      <ul className="space-y-1.5">
        {top.map((finding) => (
          <li key={finding.id}>
            <button
              onClick={() => onOpen(finding)}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised"
            >
              <span className="w-14 shrink-0 pt-0.5 font-mono text-[11px] text-ink-faint">
                {finding.code}
              </span>
              <span className="shrink-0 pt-0.5">
                <SeverityChip severity={finding.severity} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{finding.title}</span>
                {finding.fix?.change && (
                  <span className="mt-0.5 block text-[11.5px] text-ink-faint">
                    Fix: {finding.fix.change}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One glance says whether the return is internally consistent. */
function TieOutStrip({ detail }: { detail: RunDetail }) {
  if (!detail.tieOuts.length) return null;

  return (
    <section className="trc-print-zone rounded-xl border border-line-soft bg-panel px-4 py-3">
      <h2 className="mb-2 text-[13px] font-medium">Tie-outs</h2>
      <ul className="space-y-1">
        {detail.tieOuts.map((tie) => (
          <li key={tie.id} className="flex items-baseline gap-2 text-[12.5px]">
            <span className={tie.agrees ? 'text-verdict-clear' : 'text-sev-critical'}>
              {tie.agrees ? '✓' : '✕'}
            </span>
            <span className={tie.agrees ? 'text-ink-dim' : 'text-ink'}>{tie.name}</span>
            {!tie.agrees && tie.leftValue !== null && tie.rightValue !== null && (
              <span className="ml-auto shrink-0 font-mono text-[11.5px] text-sev-critical tabular-nums">
                {money(tie.leftValue)} vs {money(tie.rightValue)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Provenance, on the printed page only.
 *
 * A summary that leaves the screen has to stay attributable: a page in a
 * workpaper file with no run number is a page nobody can tie back to the
 * register it came from, or check against a later run.
 */
function PrintFooter({ detail }: { detail: RunDetail }) {
  const { run, engagement } = detail;
  return (
    <div className="hidden border-t border-line-soft pt-2 text-[10px] text-ink-faint print:block">
      {[
        engagement?.entityName || engagement?.clientLabel,
        engagement?.returnType,
        engagement?.taxYear ? `TY ${engagement.taxYear}` : null,
        `run ${run.runNumber}`,
        `register version ${run.registerVersion}`,
        new Date(run.createdAt).toLocaleDateString(),
        `${run.promptVersion} · ${run.model}`,
        run.costUsd > 0 ? `$${run.costUsd.toFixed(2)} to run` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      {' — first-pass review; a named human sign-off is what clears a return.'}
    </div>
  );
}

export function SummaryPage({
  detail,
  onOpenFinding,
  categoryFilter,
  onCategory,
}: {
  detail: RunDetail;
  onOpenFinding: (finding: FindingView) => void;
  categoryFilter: string | null;
  onCategory: (key: string | null) => void;
}) {
  return (
    <div className="trc-print-sheet space-y-3">
      <HeaderBand detail={detail} />
      <VerdictBanner detail={detail} />
      <CategoryStrip detail={detail} onPick={onCategory} active={categoryFilter} />
      <TopFindings detail={detail} onOpen={onOpenFinding} />
      <TieOutStrip detail={detail} />

      {detail.derived.escalated > 0 && (
        <section className="trc-print-zone rounded-xl border border-sev-high/35 bg-sev-high/5 px-4 py-3">
          <h2 className="text-[13px] font-medium text-sev-high">
            {detail.derived.escalated} item{detail.derived.escalated === 1 ? '' : 's'} need a reviewer
          </h2>
          <p className="mt-1 text-[12px] text-ink-dim">
            These were not confident enough to assert. Deferring is the correct outcome — they are
            here to be looked at, not to be taken on trust.
          </p>
          <ul className="mt-2 space-y-1">
            {detail.findings
              .filter((f) => f.status === 'escalated')
              .map((f) => (
                <li key={f.id}>
                  <button
                    onClick={() => onOpenFinding(f)}
                    className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-[12.5px] hover:bg-raised"
                  >
                    <span className="font-mono text-[11px] text-ink-faint">{f.code}</span>
                    <span className="min-w-0 flex-1 truncate">{f.title}</span>
                    <StatusChip status={f.status} />
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      <PrintFooter detail={detail} />
    </div>
  );
}
