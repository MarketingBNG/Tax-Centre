'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SeverityChip, StatusChip } from './chips';
import { SkeletonRows } from '../ui';
import type { Category, FindingStatus, Severity, StageKey } from '@/lib/review-types';

/**
 * This year against the earlier ones, for the same client.
 *
 * Each row is one problem and one row per year it appeared in, oldest on the
 * left, so the pattern is visible without reading anything: three marks in a
 * row is a process producing the error rather than three separate mistakes.
 */

interface Appearance {
  taxYear: number;
  engagementId: string;
  findingId: string;
  code: string;
  severity: Severity | null;
  status: FindingStatus;
  open: boolean;
}

interface RecurringItem {
  lineageKey: string;
  title: string;
  stageKey: StageKey;
  category: Category;
  where: string | null;
  appearances: Appearance[];
  yearsSeen: number;
  cameBack: boolean;
  openNow: boolean;
}

interface Payload {
  priors: { id: string; taxYear: number | null; returnType: string | null; reviewed: boolean }[];
  years: { taxYear: number; engagementId: string; runNumber: number; exceptions: number }[];
  summary: string;
  recurring: RecurringItem[];
}

const CATEGORY_LABEL: Record<string, string> = {
  bookkeeping: 'Bookkeeping',
  financial: 'Financials',
  irs_return: 'The return',
  cross_border: 'Cross-border',
  transfer_pricing: 'Transfer pricing',
};

export function RecurrencePanel({ engagementId }: { engagementId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/engagements/${engagementId}/recurrence`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body as Payload;
      })
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [engagementId]);

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-sev-critical/35 bg-sev-critical/10 px-3 py-2 text-[13px] text-sev-critical">
        {error}
      </div>
    );
  }
  if (!data) return <SkeletonRows rows={3} />;

  // Oldest first across the row, so a history reads left to right.
  const columns = data.years.map((year) => year.taxYear).sort((a, b) => a - b);
  const unreviewed = data.priors.filter((prior) => !prior.reviewed);

  return (
    <div>
      <p className="mb-5 max-w-[660px] text-[13px] text-ink-dim">{data.summary}</p>

      <section className="mb-5 rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="mb-2 text-[14px] font-medium">Years compared</h2>
        {data.years.length === 0 ? (
          <div className="text-[13px] text-ink-faint">No finished review to read yet.</div>
        ) : (
          <ul className="space-y-1">
            {data.years.map((year) => (
              <li key={year.engagementId} className="text-[13px]">
                <Link
                  href={`/reviews/${year.engagementId}/runs/${year.runNumber}`}
                  className="text-ink no-underline hover:text-accent"
                >
                  TY {year.taxYear}
                </Link>
                <span className="text-ink-faint">
                  {' '}
                  · run {year.runNumber} · {year.exceptions} exception
                  {year.exceptions === 1 ? '' : 's'}
                  {year.engagementId === engagementId ? ' · this one' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}

        {unreviewed.length > 0 && (
          <div className="mt-3 border-t border-line-soft pt-2 text-[11.5px] text-ink-faint">
            Also on file but never reviewed to a finish, so not compared:{' '}
            {unreviewed.map((prior) => `TY ${prior.taxYear}`).join(', ')}.
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="mb-1 text-[14px] font-medium">What keeps coming back</h2>
        <p className="mb-3 text-[13px] text-ink-faint">
          Matched on where the problem is and what kind it is, never on how it was worded — the
          same problem is described differently on a second pass, and that must not read as one
          closing and another appearing. Recurrence does not change a grade: an account
          misclassified three years running is exactly as wrong as one misclassified once.
        </p>

        {data.recurring.length === 0 ? (
          <div className="text-[13px] text-ink-faint">
            {data.years.length < 2
              ? 'Nothing to compare yet.'
              : 'Nothing raised this year was raised in an earlier year reviewed.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-ink-faint">
                  <th className="border-b border-line-soft py-1.5 pr-3 font-normal">Problem</th>
                  {columns.map((year) => (
                    <th
                      key={year}
                      className="border-b border-line-soft py-1.5 pr-3 text-center font-normal"
                    >
                      TY {year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.recurring.map((item) => (
                  <tr key={item.lineageKey} className="align-top">
                    <td className="border-b border-line-soft/60 py-2 pr-3">
                      <div className="text-ink">{item.title}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-faint">
                        {[
                          CATEGORY_LABEL[item.category] ?? item.category,
                          item.where,
                          `${item.yearsSeen} years`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                      {item.cameBack && (
                        <div className="mt-1 text-[11.5px] text-sev-high">
                          Settled in an earlier year and raised again since — the fix did not hold.
                        </div>
                      )}
                    </td>

                    {columns.map((year) => {
                      const hit = item.appearances.find((a) => a.taxYear === year);
                      return (
                        <td
                          key={year}
                          className="border-b border-line-soft/60 py-2 pr-3 text-center"
                        >
                          {hit ? (
                            <Link
                              href={`/reviews/${hit.engagementId}`}
                              className="inline-block no-underline"
                              title={`${hit.code} — ${hit.status}`}
                            >
                              <SeverityChip severity={hit.severity} />
                              <span className="mt-1 block">
                                <StatusChip status={hit.status} />
                              </span>
                            </Link>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
