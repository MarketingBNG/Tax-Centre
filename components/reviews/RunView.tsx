'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { SummaryPage } from './SummaryPage';
import { FindingDetail } from './FindingDetail';
import { SeverityChip, StatusChip } from './chips';
import { useRunAdvance } from './useRunAdvance';
import type { FindingView, RunDetail } from './types';

/**
 * One run: its progress while it works, its summary once it has finished.
 *
 * A run that is pending or running shows the stage rail and drives the advance
 * loop. A run that has finished shows the one-page summary. A halted run shows
 * both — the summary of what it did find, and plainly why it stopped, because
 * "we stopped at Stage 0 because the return type is wrong" is itself the most
 * useful thing the review produced.
 */

const STAGE_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'waiting', tone: 'text-ink-faint' },
  running: { label: 'running', tone: 'text-accent' },
  complete: { label: 'done', tone: 'text-verdict-clear' },
  failed: { label: 'failed', tone: 'text-sev-critical' },
  skipped: { label: 'skipped', tone: 'text-ink-faint' },
  not_applicable: { label: 'not applicable', tone: 'text-ink-faint' },
  carried_forward: { label: 'carried forward', tone: 'text-ink-faint' },
};

export function RunView({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openFinding, setOpenFinding] = useState<FindingView | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/review-runs/${runId}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setDetail(await res.json());
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const { running, events, error, start, halt } = useRunAdvance(runId, load);

  // Refresh the register as stages land, so findings appear while it works
  // rather than all at once at the end.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [running, load]);

  const visibleFindings = useMemo(() => {
    if (!detail) return [];
    if (!categoryFilter) return detail.findings;
    if (categoryFilter === 'high_flag') {
      return detail.findings.filter(
        (f) => f.isOpen && (f.severity === 'Critical' || f.severity === 'High'),
      );
    }
    return detail.findings.filter((f) => f.category === categoryFilter);
  }, [detail, categoryFilter]);

  if (loadError) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-6">
        <div className="rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[13px] text-[#e8b0b0]">
          {loadError}
        </div>
      </div>
    );
  }

  if (!detail) {
    return <div className="mx-auto max-w-[900px] px-6 py-6 text-[13px] text-ink-faint">Loading…</div>;
  }

  const { run } = detail;
  const notStarted = run.status === 'pending';
  const inFlight = run.status === 'running' || running;
  const blocked = run.status === 'blocked_inputs';
  const finished = ['complete', 'halted', 'failed', 'cancelled'].includes(run.status) && !running;

  return (
    <div className="mx-auto max-w-[900px] px-6 py-6">
      <div className="trc-print-hide mb-3 flex items-center justify-between">
        <Link
          href={`/reviews/${run.engagementId}`}
          className="text-[12.5px] text-ink-dim no-underline hover:text-accent"
        >
          ← {detail.engagement?.entityName || detail.engagement?.clientLabel || 'Engagement'}
        </Link>

        <div className="flex items-center gap-2">
          {finished && (
            <button
              onClick={() => window.print()}
              className="rounded-[9px] border border-line px-3 py-1.5 text-[12.5px] text-ink-dim hover:border-accent hover:text-accent"
            >
              Print
            </button>
          )}
          {(notStarted || (finished && run.status !== 'complete')) && (
            <button
              onClick={() => void start()}
              className="rounded-[9px] bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink hover:bg-accent-hover"
            >
              {notStarted ? 'Start review' : 'Resume'}
            </button>
          )}
          {inFlight && (
            <button
              onClick={halt}
              className="rounded-[9px] border border-line px-3 py-1.5 text-[12.5px] text-ink-dim hover:border-sev-blocking hover:text-sev-blocking"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {blocked && (
        <div className="mb-4 rounded-xl border border-sev-critical/35 bg-sev-critical/5 px-4 py-3">
          <div className="text-[14px] font-medium text-sev-critical">Waiting for documents</div>
          <p className="mt-1 text-[12.5px] text-ink-dim">
            This review cannot start without the documents it ties out against. Nothing has been
            spent on it.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[13px] text-[#e8b0b0]">
          {error}
        </div>
      )}

      {run.status === 'halted' && (
        <div className="mb-4 rounded-xl border border-sev-critical/35 bg-sev-critical/5 px-4 py-3">
          <div className="text-[14px] font-medium text-sev-critical">Stopped at Stage 0</div>
          <p className="mt-1 text-[12.5px] text-ink-dim">
            Something about the identity of this return is wrong, so the later stages would have
            been reviewing the wrong thing. Fix it and run again.
          </p>
        </div>
      )}

      {/* ------------------------------------------------- progress rail */}

      {(inFlight || notStarted) && (
        <section className="trc-print-hide mb-4 rounded-xl border border-line-soft bg-panel px-4 py-3">
          <ol className="space-y-1">
            {detail.stages.map((stage) => {
              const state = STAGE_STATUS[stage.status] ?? { label: stage.status, tone: 'text-ink-faint' };
              return (
                <li key={stage.key} className="flex items-baseline gap-2.5 text-[13px]">
                  <span className="w-16 shrink-0 font-mono text-[11px] text-ink-faint">
                    {stage.key}
                  </span>
                  <span className="flex-1">{stage.label}</span>
                  <span className={`text-[11.5px] ${state.tone}`}>
                    {state.label}
                    {stage.status === 'running' && <span className="trc-cursor ml-1.5" />}
                  </span>
                </li>
              );
            })}
          </ol>

          {events.length > 0 && (
            <div className="mt-3 max-h-40 overflow-y-auto border-t border-line-soft pt-2">
              {events.slice(-30).map((event, i) => (
                <div key={i} className="text-[11.5px] text-ink-faint">
                  {event.type === 'finding' ? (
                    <>
                      <span className="font-mono">{event.code}</span>{' '}
                      <span className="text-ink-dim">{event.title}</span>
                    </>
                  ) : (
                    (event.note ?? event.message ?? event.type)
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ----------------------------------------------------- the summary */}

      {(finished || detail.findings.length > 0) && (
        <SummaryPage
          detail={detail}
          onOpenFinding={setOpenFinding}
          categoryFilter={categoryFilter}
          onCategory={setCategoryFilter}
        />
      )}

      {/* ------------------------------------------------- the full register */}

      {categoryFilter && (
        <section className="trc-print-hide mt-3 rounded-xl border border-line-soft bg-panel px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-medium">
              {detail.derived.categories[categoryFilter]?.label ?? 'Findings'}
            </h2>
            <button
              onClick={() => setCategoryFilter(null)}
              className="text-[12px] text-ink-faint hover:text-ink"
            >
              Clear filter
            </button>
          </div>
          <ul className="space-y-1">
            {visibleFindings.map((finding) => (
              <li key={finding.id}>
                <button
                  onClick={() => setOpenFinding(finding)}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised"
                >
                  <span className="w-14 shrink-0 pt-0.5 font-mono text-[11px] text-ink-faint">
                    {finding.code}
                  </span>
                  <span className="shrink-0 pt-0.5">
                    <SeverityChip severity={finding.severity} />
                  </span>
                  <span className="min-w-0 flex-1 text-[13px]">{finding.title}</span>
                  <span className="shrink-0 pt-0.5">
                    <StatusChip status={finding.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {openFinding && (
        <FindingDetail finding={openFinding} onClose={() => setOpenFinding(null)} />
      )}
    </div>
  );
}
