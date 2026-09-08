'use client';

import { useEffect, useState } from 'react';
import { SeverityChip, VERDICT_WORD } from './chips';
import type { Severity, Verdict } from '@/lib/review-types';

/**
 * One run beside the one before it.
 *
 * Three columns, because there are three things a reviewer wants to know after
 * a round of fixes: what actually closed, what the fixes introduced, and what
 * is still outstanding. Closed means the check now passes — not that a number
 * moved, which is a distinction the whole immutable-run design exists to make
 * possible.
 */

interface DiffRow {
  id: string;
  code: string;
  severity: Severity | null;
  status: string;
  title: string;
}

interface Diff {
  from: { runNumber: number; verdict: Verdict | null };
  to: { runNumber: number; verdict: Verdict | null };
  verdictMoved: boolean;
  closed: DiffRow[];
  opened: DiffRow[];
  unchanged: DiffRow[];
  changed: { before: DiffRow; after: DiffRow }[];
  questionsAnswered: number;
  questionsIgnored: number;
}

function Column({
  title,
  tone,
  rows,
  empty,
}: {
  title: string;
  tone: string;
  rows: DiffRow[];
  empty: string;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-line-soft bg-panel px-3 py-3">
      <h3 className={`mb-2 text-[13px] font-medium ${tone}`}>
        {title} <span className="text-ink-faint">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-ink-faint">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-2">
              <span className="shrink-0 pt-1">
                <SeverityChip severity={row.severity} />
              </span>
              <span className="min-w-0 text-[13px]">
                <span className="font-mono text-[11.5px] text-ink-faint">{row.code}</span>{' '}
                {row.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RunCompare({ runId }: { runId: string }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/review-runs/${runId}/diff`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        return data;
      })
      .then(setDiff)
      .catch((err: Error) => setError(err.message));
  }, [runId]);

  if (error) {
    return <p className="text-[13px] text-ink-faint">{error}</p>;
  }
  if (!diff) return <p className="text-[13px] text-ink-faint">Comparing…</p>;

  return (
    <section className="space-y-3">
      <div className="rounded-xl border border-line-soft bg-panel px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-[14px] font-medium">
            Run {diff.to.runNumber} compared with run {diff.from.runNumber}
          </h2>
          <div className="text-[13px]">
            {diff.verdictMoved ? (
              <>
                <span className="text-ink-faint">
                  {diff.from.verdict ? VERDICT_WORD[diff.from.verdict] : '—'}
                </span>
                <span className="mx-2 text-ink-faint">→</span>
                <span className="text-ink">
                  {diff.to.verdict ? VERDICT_WORD[diff.to.verdict] : '—'}
                </span>
              </>
            ) : (
              <span className="text-ink-faint">
                Verdict unchanged: {diff.to.verdict ? VERDICT_WORD[diff.to.verdict] : '—'}
              </span>
            )}
          </div>
        </div>

        <div className="mt-2 text-[13px] text-ink-dim">
          {diff.closed.length} closed · {diff.opened.length} new · {diff.changed.length} changed ·{' '}
          {diff.unchanged.length} unchanged
        </div>

        {diff.questionsIgnored > 0 && (
          <div className="mt-2 rounded-lg border border-sev-high/35 bg-sev-high/5 px-3 py-2 text-[13px] text-sev-high">
            {diff.questionsIgnored} question{diff.questionsIgnored === 1 ? '' : 's'} carried over
            still unanswered. A return should not be cleared without the fact somebody asked for.
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <Column
          title="Closed"
          tone="text-verdict-clear"
          rows={diff.closed}
          empty="Nothing closed between these runs."
        />
        <Column
          title="New"
          tone="text-sev-critical"
          rows={diff.opened}
          empty="Nothing new appeared."
        />
        <Column
          title="Still open"
          tone="text-sev-high"
          rows={diff.unchanged.filter((r) =>
            ['open', 'answered_pending_evidence', 'escalated', 'client'].includes(r.status),
          )}
          empty="Nothing carried over unresolved."
        />
      </div>

      {diff.changed.length > 0 && (
        <div className="rounded-xl border border-line-soft bg-panel px-4 py-3">
          <h3 className="mb-2 text-[13px] font-medium">Changed</h3>
          <ul className="space-y-2">
            {diff.changed.map(({ before, after }) => (
              <li key={after.id} className="flex items-center gap-2 text-[13px]">
                <span className="font-mono text-[11.5px] text-ink-faint">{after.code}</span>
                <span className="min-w-0 flex-1 truncate">{after.title}</span>
                <SeverityChip severity={before.severity} />
                <span className="text-ink-faint">→</span>
                <SeverityChip severity={after.severity} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
