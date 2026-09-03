'use client';

import { useState } from 'react';
import type { ToolRun } from '../lib/types';

const NAMES: Record<string, string> = {
  run_analysis: 'Analysis',
  remember: 'Memory',
  forget: 'Memory',
};

/**
 * What the model did before answering.
 *
 * Collapsed by default and expandable to the exact code and the exact output,
 * because "it says the total is 41,208" is only worth anything if the working
 * can be checked. An answer that leans on a calculation nobody can see is the
 * failure mode this whole panel exists to prevent.
 */
export function ToolPanel({ runs }: { runs: ToolRun[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!runs.length) return null;

  return (
    <div className="mb-3 flex flex-col gap-1.5">
      {runs.map((run, i) => {
        const expanded = open === i;
        let code = '';
        try {
          code = String((JSON.parse(run.input) as { code?: string }).code ?? '');
        } catch {
          code = run.input;
        }

        return (
          <div
            key={i}
            className={`rounded-lg border ${
              run.ok ? 'border-line-soft bg-panel/60' : 'border-sev-blocking/35 bg-sev-blocking/5'
            }`}
          >
            <button
              onClick={() => setOpen(expanded ? null : i)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink-faint hover:text-ink-dim"
            >
              <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
              <span className="rounded border border-line px-1 font-mono text-[10.5px]">
                {NAMES[run.name] ?? run.name}
              </span>
              <span className="flex-1 truncate">{run.summary}</span>
              <span className="tabular-nums">{(run.ms / 1000).toFixed(1)}s</span>
            </button>

            {expanded ? (
              <div className="space-y-2 border-t border-line-soft px-3 py-2">
                {run.name === 'run_analysis' ? (
                  <div>
                    <div className="mb-1 text-[11px] font-semibold text-ink-faint">Code</div>
                    <pre className="overflow-x-auto rounded border border-line bg-canvas p-2 font-mono text-[11.5px] leading-[1.45]">
                      {code}
                    </pre>
                  </div>
                ) : null}
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-ink-faint">
                    {run.ok ? 'Output' : 'Failed'}
                  </div>
                  <pre className="max-h-[320px] overflow-auto rounded border border-line bg-canvas p-2 font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap">
                    {run.output}
                  </pre>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
