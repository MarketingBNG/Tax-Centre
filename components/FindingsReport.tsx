'use client';

import { useState } from 'react';
import { Markdown } from './Markdown';
import { PdfViewer } from './PdfViewer';

export interface PageRef {
  marker: string;
  title: string | null;
  fileId: string | null;
  startPage: number | null;
  endPage: number | null;
}

export interface Finding {
  id: string;
  severity: string;
  category: string;
  form_code: string | null;
  line_ref: string | null;
  title: string;
  detail: string;
  recommended_action: string;
  confidence: string;
  pages: PageRef[];
  status: string;
}

export interface ReviewBundle {
  review: {
    id: string;
    summary: string | null;
    cost_micros: number;
    extraction_ok: number;
    status: string;
  };
  findings: Finding[];
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
}

const SEVERITY_STYLE: Record<string, string> = {
  filing_blocking: 'text-sev-blocking border-sev-blocking',
  compliance_risk: 'text-sev-risk border-sev-risk',
  math_or_carryforward_error: 'text-sev-math border-sev-math',
  missed_opportunity: 'text-sev-opportunity border-sev-opportunity',
  documentation_gap: 'text-sev-doc border-sev-doc',
  presentation_nit: 'text-sev-nit border-sev-nit',
};

// Ordered by how urgently a preparer needs to look, not alphabetically.
const SEVERITY_ORDER = [
  'filing_blocking',
  'math_or_carryforward_error',
  'compliance_risk',
  'documentation_gap',
  'missed_opportunity',
  'presentation_nit',
];

/** 12345 -> "12.3k"; token counts run long and the header is one line. */
function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function Chip({ severity, label }: { severity: string; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-[2px] text-[11.5px] font-semibold whitespace-nowrap ${
        SEVERITY_STYLE[severity] ?? 'text-ink-faint border-line'
      }`}
    >
      {label}
    </span>
  );
}

function pageLabel(p: PageRef): string {
  if (!p.startPage) return 'cited';
  if (p.endPage && p.endPage !== p.startPage) return `pp. ${p.startPage}–${p.endPage}`;
  return `p. ${p.startPage}`;
}

export function FindingsReport({
  bundle,
  labels,
}: {
  bundle: ReviewBundle;
  labels: Record<string, string>;
}) {
  const [findings, setFindings] = useState(bundle.findings);
  const [preview, setPreview] = useState<PageRef | null>(null);

  async function setStatus(finding: Finding, next: string) {
    const target = finding.status === next ? 'open' : next;
    setFindings((prev) =>
      prev.map((f) => (f.id === finding.id ? { ...f, status: target } : f)),
    );
    await fetch(`/api/findings/${finding.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: target }),
    }).catch(() => {
      // Revert on failure so the UI never claims a triage that did not save.
      setFindings((prev) =>
        prev.map((f) => (f.id === finding.id ? { ...f, status: finding.status } : f)),
      );
    });
  }

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  const { inputTokens, outputTokens } = bundle.usage;
  // usage_records is the ledger; review.cost_micros is the older single-number
  // field, kept as a fallback for reviews recorded before tokens were totalled.
  const micros = bundle.usage.costMicros || bundle.review.cost_micros;
  const cost = micros ? `$${(micros / 1e6).toFixed(3)}` : '';
  const tokens =
    inputTokens || outputTokens
      ? `${fmt(inputTokens)} in · ${fmt(outputTokens)} out`
      : '';

  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <b className="text-[14.5px]">Findings</b>
        <span className="text-[12.5px] text-ink-faint">
          {findings.length} item{findings.length === 1 ? '' : 's'}
          {tokens ? ` · ${tokens}` : ''}
          {cost ? ` · ${cost}` : ''}
        </span>
      </div>

      {bundle.review.summary ? (
        <div className="border-b border-line-soft px-4 py-3 text-ink-dim">
          <Markdown text={bundle.review.summary} />
        </div>
      ) : null}

      {Object.keys(counts).length ? (
        <div className="flex flex-wrap gap-2 border-b border-line-soft px-4 py-3">
          {SEVERITY_ORDER.filter((s) => counts[s]).map((s) => (
            <Chip key={s} severity={s} label={`${counts[s]} ${labels[s] ?? s}`} />
          ))}
        </div>
      ) : null}

      {!bundle.review.extraction_ok && findings.length === 0 ? (
        <div className="border-b border-line-soft px-4 py-3 text-[13px] text-ink-faint">
          Structured extraction was unavailable for this review — the written report below
          is complete.
        </div>
      ) : null}

      {sorted.map((f) => {
        const where = [f.form_code, f.line_ref].filter(Boolean).join(' · ');
        const done = f.status !== 'open';

        return (
          <div
            key={f.id}
            className={`border-b border-line-soft px-4 py-3 last:border-b-0 ${done ? 'opacity-50' : ''}`}
          >
            <div className="mb-1.5 flex items-start gap-2.5">
              <b className="flex-1 text-[14px] font-semibold">{f.title}</b>
              <Chip severity={f.severity} label={labels[f.severity] ?? f.severity} />
            </div>

            {where ? (
              <div className="mb-1.5 text-[12.5px] text-ink-faint">{where}</div>
            ) : null}

            <div className="mb-2 text-ink-dim">
              <Markdown text={f.detail} />
            </div>

            {f.recommended_action ? (
              <div className="text-[13.5px]">
                <span className="text-ink-faint">Action — </span>
                <Markdown text={f.recommended_action} />
              </div>
            ) : null}

            {f.pages.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {f.pages.map((p) =>
                  p.fileId ? (
                    <button
                      key={p.marker}
                      onClick={() => setPreview(p)}
                      title="Open the document at this page"
                      className="rounded-md border border-line bg-raised px-2 py-[2px] text-[11.5px] text-ink-dim hover:border-accent hover:text-accent"
                    >
                      {p.title ?? 'source'} · {pageLabel(p)}
                    </button>
                  ) : (
                    <span
                      key={p.marker}
                      className="rounded-md border border-line bg-raised px-2 py-[2px] text-[11.5px] text-ink-faint"
                    >
                      {p.title ?? 'source'} · {pageLabel(p)}
                    </span>
                  ),
                )}
              </div>
            ) : null}

            <div className="mt-2.5 flex gap-1.5">
              {['accepted', 'dismissed', 'resolved'].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(f, s)}
                  className={`rounded-md border px-2.5 py-[3px] text-[12px] transition-colors ${
                    f.status === s
                      ? 'border-accent text-accent'
                      : 'border-line text-ink-faint hover:border-ink-faint hover:text-ink'
                  }`}
                >
                  {s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      <div className="border-t border-line-soft bg-canvas px-4 py-2.5 text-[12.5px] text-ink-faint">
        Page references come from the model reading the document and are shown for
        navigation. Every finding requires preparer verification before it is acted on.
      </div>

      {preview?.fileId ? (
        <PdfViewer
          fileId={preview.fileId}
          title={preview.title ?? 'Source document'}
          page={preview.startPage}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
