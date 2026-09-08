'use client';

import { useEffect, useState } from 'react';
import type { ToolRun } from '../lib/types';

const NAMES: Record<string, string> = {
  run_analysis: 'Analysis',
  remember: 'Memory',
  forget: 'Memory',
  load_skill: 'Skill',
  read_skill_file: 'Skill',
  search_authority: 'Authority',
  record_scope: 'Register',
  record_findings: 'Register',
  record_questions: 'Register',
  record_tie_outs: 'Register',
};

/** What to call a group of these in the collapsed header. */
const NOUNS: Record<string, [string, string]> = {
  run_analysis: ['calculation', 'calculations'],
  remember: ['memory note', 'memory notes'],
  forget: ['memory note', 'memory notes'],
  load_skill: ['skill', 'skills'],
  read_skill_file: ['skill file', 'skill files'],
  search_authority: ['authority lookup', 'authority lookups'],
  record_scope: ['register write', 'register writes'],
  record_findings: ['register write', 'register writes'],
  record_questions: ['register write', 'register writes'],
  record_tie_outs: ['register write', 'register writes'],
};

function nounFor(name: string, count: number): string {
  const pair = NOUNS[name];
  if (pair) return pair[count === 1 ? 0 : 1];
  // An MCP tool: mcp__<connector>__<tool>. The connector is the useful half.
  const parts = name.split('__');
  if (parts[0] === 'mcp' && parts.length >= 3) return `${parts[1].replace(/_/g, ' ')} call${count === 1 ? '' : 's'}`;
  return count === 1 ? 'step' : 'steps';
}

/**
 * Groups runs by tool, preserving first-appearance order.
 *
 * Order matters more than tidiness: "read 8 skill files, ran 1 calculation" is
 * a description of what happened, and sorting it by count would stop being one.
 */
function describe(runs: ToolRun[]): string {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.name, (counts.get(run.name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, n]) => `${n} ${nounFor(name, n)}`)
    .join(', ');
}

/**
 * What the model did before answering.
 *
 * One collapsed row for the lot, expandable to the individual steps and from
 * there to the exact code and the exact output — because "it says the total is
 * 41,208" is only worth anything if the working can be checked. An answer that
 * leans on a calculation nobody can see is the failure mode this panel exists
 * to prevent.
 *
 * It used to render one box per step, which was fine for the one or two a chat
 * turn makes and wrong for a review stage: eight skill reads became eight
 * boxes, and the working stopped being glanceable at exactly the point there
 * was enough of it to matter. So the summary is the default and the detail is
 * one click away, in both directions.
 *
 * Two rules the collapsing has to respect. Open while the steps are still
 * arriving, closed once the answer starts — the same default Thinking uses,
 * and for the same reason. And a failed step is never hidden: it opens the
 * panel, tints it, and says so in the header, because a collapsed summary that
 * reads "9 steps" over a silent failure is worse than the wall of boxes was.
 */
export function ToolPanel({ runs, streaming = false }: { runs: ToolRun[]; streaming?: boolean }) {
  const failed = runs.filter((r) => !r.ok).length;
  const [open, setOpen] = useState(streaming || failed > 0);
  const [pinned, setPinned] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);

  useEffect(() => {
    if (!pinned) setOpen(streaming || failed > 0);
  }, [streaming, failed, pinned]);

  if (!runs.length) return null;

  const totalMs = runs.reduce((sum, r) => sum + r.ms, 0);
  const seconds = (totalMs / 1000).toFixed(1);

  const header = streaming
    ? 'Working…'
    : failed
      ? `${failed} of ${runs.length} step${runs.length === 1 ? '' : 's'} failed`
      : runs.length === 1
        ? runs[0].summary
        : describe(runs);

  return (
    <div
      className={`mb-3 rounded-lg border ${
        failed ? 'border-sev-blocking/35 bg-sev-blocking/5' : 'border-line-soft bg-panel/60'
      }`}
    >
      <button
        onClick={() => {
          setPinned(true);
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink-faint hover:text-ink-dim"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        <span className={`flex-1 truncate ${failed ? 'text-sev-blocking' : 'font-medium'}`}>
          {header}
        </span>
        {!streaming ? <span className="tabular-nums">{seconds}s</span> : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-line-soft px-2 py-2">
          {runs.map((run, i) => {
            const expanded = detail === i;
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
                  run.ok ? 'border-line-soft bg-canvas/40' : 'border-sev-blocking/35 bg-sev-blocking/5'
                }`}
              >
                <button
                  onClick={() => setDetail(expanded ? null : i)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink-faint hover:text-ink-dim"
                >
                  <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
                  <span className="rounded border border-line px-1 font-mono text-[11.5px]">
                    {NAMES[run.name] ?? run.name}
                  </span>
                  <span className="flex-1 truncate">{run.summary}</span>
                  <span className="tabular-nums">{(run.ms / 1000).toFixed(1)}s</span>
                </button>

                {expanded ? (
                  <div className="space-y-2 border-t border-line-soft px-3 py-2">
                    {run.name === 'run_analysis' ? (
                      <div>
                        <div className="mb-1 text-[11.5px] font-semibold text-ink-faint">Code</div>
                        <pre className="overflow-x-auto rounded border border-line bg-canvas p-2 font-mono text-[11.5px] leading-[1.45]">
                          {code}
                        </pre>
                      </div>
                    ) : null}
                    <div>
                      <div className="mb-1 text-[11.5px] font-semibold text-ink-faint">
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
      ) : null}
    </div>
  );
}
