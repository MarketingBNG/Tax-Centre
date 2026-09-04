'use client';

import { AuthorityChip, SeverityChip, StatusChip } from './chips';
import type { FindingView } from './types';

/**
 * One finding, in full.
 *
 * The amounts table is the part worth looking at closely. Every figure shows
 * where it came from, and a figure read off a PDF page is labelled as
 * unverified rather than presented alongside a checked one as though they were
 * equally solid. A reviewer deciding whether to trust a finding needs to know
 * which of its numbers anybody actually confirmed.
 */

const money = (value: number): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SOURCE_LABEL: Record<string, string> = {
  calc: 'computed',
  text_doc: 'read from document',
  visual: 'read off the page',
};

export function FindingDetail({
  finding,
  onClose,
}: {
  finding: FindingView;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/55" onClick={onClose}>
      <aside
        className="h-full w-[520px] max-w-full overflow-y-auto border-l border-line bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 border-b border-line-soft bg-panel px-5 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11.5px] text-ink-faint">{finding.code}</span>
              <SeverityChip severity={finding.severity} />
              <StatusChip status={finding.status} />
            </div>
            <button onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
              ×
            </button>
          </div>
          <h2 className="mt-2 text-[15px] font-medium">{finding.title}</h2>
        </header>

        <div className="space-y-5 px-5 py-4">
          <section>
            <h3 className="mb-1 text-[11px] tracking-wide text-ink-faint uppercase">What is wrong</h3>
            <p className="text-[13.5px] leading-[1.55]">{finding.whatIsWrong}</p>
            {finding.whyItMatters && (
              <p className="mt-2 text-[12.5px] text-ink-dim">{finding.whyItMatters}</p>
            )}
          </section>

          {finding.location && (
            <section>
              <h3 className="mb-1 text-[11px] tracking-wide text-ink-faint uppercase">Where</h3>
              <p className="text-[13px]">
                {[
                  finding.location.form && `Form ${finding.location.form}`,
                  finding.location.schedule && `Schedule ${finding.location.schedule}`,
                  finding.location.line && `line ${finding.location.line}`,
                  finding.location.gl_account && `GL ${finding.location.gl_account}`,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </p>
            </section>
          )}

          {finding.fix && (
            <section>
              <h3 className="mb-1.5 text-[11px] tracking-wide text-ink-faint uppercase">
                How to fix it
              </h3>
              <ol className="space-y-1.5 text-[13px]">
                <li className="flex gap-2">
                  <span className="text-ink-faint">1.</span>
                  <span>
                    <span className="text-ink-dim">Go to</span> {finding.fix.where}
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-ink-faint">2.</span>
                  <span>{finding.fix.change}</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-ink-faint">3.</span>
                  <span>
                    <span className="text-ink-dim">Then re-check</span> {finding.fix.then}
                  </span>
                </li>
              </ol>
              <p className="mt-2 text-[12px] text-ink-faint">{finding.fix.why}</p>
            </section>
          )}

          {finding.amounts.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[11px] tracking-wide text-ink-faint uppercase">Figures</h3>
              <table className="w-full text-[12.5px]">
                <tbody>
                  {finding.amounts.map((amount, i) => (
                    <tr key={i} className="border-b border-line-soft last:border-0">
                      <td className="py-1.5 pr-2 text-ink-dim">{amount.label.replace(/_/g, ' ')}</td>
                      <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                        {money(amount.value)}
                      </td>
                      <td className="py-1.5 text-right">
                        <span
                          className={amount.verified ? 'text-ink-faint' : 'text-sev-high'}
                          title={
                            amount.verified
                              ? `Checked against ${amount.source_ref}`
                              : 'Read off a page image — nothing could independently confirm it'
                          }
                        >
                          {SOURCE_LABEL[amount.source_kind] ?? amount.source_kind}
                          {!amount.verified && ' · unverified'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {(finding.authority.status !== 'none_required' || finding.evidence.length > 0) && (
            <section>
              <h3 className="mb-1.5 text-[11px] tracking-wide text-ink-faint uppercase">
                Authority and evidence
              </h3>
              <AuthorityChip
                status={finding.authority.status}
                citation={finding.authority.citation}
                claimedCitation={finding.authority.claimedCitation}
              />
              {finding.authority.claimedCitation && (
                <p className="mt-1.5 text-[11.5px] text-ink-faint">
                  The model offered “{finding.authority.claimedCitation}”. Nothing verified it, so
                  it is recorded but not shown as authority.
                </p>
              )}
              {finding.evidence.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[12.5px] text-ink-dim">
                  {finding.evidence.map((item, i) => (
                    <li key={i}>— {item.description}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="border-t border-line-soft pt-3 text-[12px] text-ink-faint">
            <div>Owner: {finding.owner ?? 'unassigned'}</div>
            <div>Found in stage {finding.stage}</div>
            {finding.confidence !== null && (
              <div>Confidence: {finding.confidence.toFixed(2)}</div>
            )}
            {finding.statusNote && <div className="mt-1 text-sev-high">{finding.statusNote}</div>}
          </section>
        </div>
      </aside>
    </div>
  );
}
