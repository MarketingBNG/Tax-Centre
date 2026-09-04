'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { VerdictChip } from './chips';
import type { ReturnType, RunStatus, Verdict } from '@/lib/review-types';

interface EngagementSummary {
  id: string;
  clientLabel: string;
  entityName: string | null;
  ein: string | null;
  returnType: ReturnType | null;
  taxYear: number | null;
  runCount: number;
  latestRun: {
    id: string;
    runNumber: number;
    status: RunStatus;
    verdict: Verdict | null;
    registerVersion: number;
    createdAt: number;
    openCriticalHigh: number;
  } | null;
}

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  blocked_inputs: 'Waiting for documents',
  pending: 'Not started',
  running: 'Running',
  halted: 'Stopped early',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function ReviewsHome() {
  const [engagements, setEngagements] = useState<EngagementSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/engagements')
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        return res.json();
      })
      .then(setEngagements)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-[21px] font-semibold tracking-tight">Reviews</h1>
          <p className="mt-1 text-[13px] text-ink-dim">
            Senior-CPA review of a prepared return: books, financials, the return itself, then the
            fixes and the questions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink-dim no-underline hover:border-accent hover:text-accent"
          >
            Back to chat
          </Link>
          <Link
            href="/reviews/new"
            className="rounded-[9px] bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink no-underline hover:bg-accent-hover"
          >
            New review
          </Link>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[13px] text-[#e8b0b0]">
          {error}
        </div>
      )}

      {!engagements && !error && <div className="text-[13px] text-ink-faint">Loading…</div>}

      {engagements?.length === 0 && (
        <div className="rounded-xl border border-dashed border-line p-8 text-center">
          <div className="text-[14px] text-ink-dim">No reviews yet.</div>
          <div className="mx-auto mt-1.5 max-w-[460px] text-[12.5px] text-ink-faint">
            A review needs the prepared return and the trial balances for both year ends. It reads
            the books first, because most return errors are book errors that were copied onto the
            form correctly.
          </div>
          <Link
            href="/reviews/new"
            className="mt-4 inline-block rounded-[9px] bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-ink no-underline hover:bg-accent-hover"
          >
            Start the first one
          </Link>
        </div>
      )}

      {engagements && engagements.length > 0 && (
        <ul className="space-y-2">
          {engagements.map((engagement) => {
            const run = engagement.latestRun;
            return (
              <li key={engagement.id}>
                <Link
                  href={`/reviews/${engagement.id}`}
                  className="block rounded-xl border border-line-soft bg-panel px-4 py-3 no-underline hover:border-line hover:bg-raised"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-[14.5px] font-medium text-ink">
                        {engagement.entityName || engagement.clientLabel}
                      </div>
                      <div className="mt-0.5 text-[12px] text-ink-faint">
                        {[
                          engagement.returnType,
                          engagement.taxYear ? `TY ${engagement.taxYear}` : null,
                          engagement.ein,
                          engagement.runCount
                            ? `${engagement.runCount} run${engagement.runCount === 1 ? '' : 's'}`
                            : 'not yet run',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <VerdictChip verdict={run?.verdict ?? null} />
                      <div className="mt-1 text-[11.5px] text-ink-faint">
                        {run ? (
                          <>
                            Run {run.runNumber} · {RUN_STATUS_LABEL[run.status]}
                            {run.openCriticalHigh > 0 && (
                              <span className="text-sev-high">
                                {' '}
                                · {run.openCriticalHigh} open
                              </span>
                            )}
                          </>
                        ) : (
                          'No runs yet'
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
