'use client';

import { useMemo, useState } from 'react';
import { SeverityChip, StatusChip } from './chips';
import { severityRank } from '@/lib/review-engine/severity';
import { CATEGORY_LABELS, type Category } from '@/lib/review-types';
import type { FindingView, RunDetail } from './types';

/**
 * The whole register, filterable.
 *
 * The summary page answers "what do I do first". This answers "what else is
 * there", which is a different question and needs a different shape: agreed
 * lines and coverage notes belong here even though they never belong on the
 * summary, because a reviewer checking whether a section was examined is
 * looking for exactly those.
 */

type Sort = 'severity' | 'code' | 'stage';

export function FindingsTable({
  detail,
  onOpen,
  initialCategory,
}: {
  detail: RunDetail;
  onOpen: (finding: FindingView) => void;
  initialCategory?: string | null;
}) {
  const [category, setCategory] = useState<string | null>(initialCategory ?? null);
  const [severity, setSeverity] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('severity');

  const rows = useMemo(() => {
    let list = detail.findings;

    if (category === 'high_flag') {
      list = list.filter(
        (f) => f.isOpen && (f.severity === 'Critical' || f.severity === 'High'),
      );
    } else if (category) {
      list = list.filter((f) => f.category === category);
    }
    if (severity) list = list.filter((f) => f.severity === severity);
    if (openOnly) list = list.filter((f) => f.isOpen);

    return [...list].sort((a, b) => {
      if (sort === 'code') return a.code.localeCompare(b.code);
      if (sort === 'stage') return a.stage.localeCompare(b.stage) || a.code.localeCompare(b.code);
      return severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code);
    });
  }, [detail.findings, category, severity, openOnly, sort]);

  const counts = useMemo(
    () => ({
      total: detail.findings.length,
      open: detail.findings.filter((f) => f.isOpen).length,
      agreed: detail.findings.filter((f) => f.kind === 'agreed').length,
      coverage: detail.findings.filter((f) => f.kind === 'coverage').length,
    }),
    [detail.findings],
  );

  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-[11.5px] ${
      active ? 'border-accent text-accent' : 'border-line text-ink-dim hover:text-ink'
    }`;

  return (
    <section className="rounded-xl border border-line-soft bg-panel px-4 py-3">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-medium">The register</h2>
        <span className="text-[11.5px] text-ink-faint">
          {counts.total} lines · {counts.open} open · {counts.agreed} agreed · {counts.coverage} not
          checked
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setCategory(null)} className={pill(category === null)}>
          All
        </button>
        {(Object.keys(CATEGORY_LABELS) as Category[]).map((key) => (
          <button
            key={key}
            onClick={() => setCategory(category === key ? null : key)}
            className={pill(category === key)}
          >
            {CATEGORY_LABELS[key]}
          </button>
        ))}

        <span className="mx-1 text-ink-faint">·</span>

        {(['Critical', 'High', 'Medium', 'Low'] as const).map((level) => (
          <button
            key={level}
            onClick={() => setSeverity(severity === level ? null : level)}
            className={pill(severity === level)}
          >
            {level}
          </button>
        ))}

        <span className="mx-1 text-ink-faint">·</span>

        <button onClick={() => setOpenOnly(!openOnly)} className={pill(openOnly)}>
          Open only
        </button>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="ml-auto rounded-[6px] border border-line bg-canvas px-2 py-1 text-[11.5px] text-ink-dim outline-none"
        >
          <option value="severity">Worst first</option>
          <option value="code">By code</option>
          <option value="stage">By stage</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-ink-faint">
          Nothing matches those filters.
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((finding) => (
            <li key={finding.id}>
              <button
                onClick={() => onOpen(finding)}
                className="flex w-full flex-wrap items-start gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-left hover:bg-raised"
              >
                <span className="w-14 shrink-0 pt-1 font-mono text-[11.5px] text-ink-faint">
                  {finding.code}
                </span>
                <span className="shrink-0 pt-1">
                  <SeverityChip severity={finding.severity} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px]">{finding.title}</span>
                  {finding.kind === 'coverage' && (
                    <span className="mt-1 block text-[11.5px] text-ink-faint">
                      {finding.whatIsWrong}
                    </span>
                  )}
                </span>
                <span className="shrink-0 basis-full pl-16 sm:basis-auto sm:pt-1 sm:pl-0">
                  <StatusChip status={finding.status} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
