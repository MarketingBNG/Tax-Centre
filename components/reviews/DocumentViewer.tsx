'use client';

import { useDialog } from '../useDialog';

/**
 * Opens one of a review's documents, at a page where we know one.
 *
 * Recovered from the viewer the old review pipeline had, pointed at the
 * review-scoped proxy instead of the owner-scoped one so a reviewer can open
 * evidence a preparer uploaded.
 *
 * The iframe is sandboxed and the response carries
 * `Content-Security-Policy: sandbox`, which puts it in an opaque origin — a
 * hostile PDF cannot reach the reviewer's session even though it is served
 * from our own host. `#page=` is honoured by the built-in PDF viewers in
 * Chrome, Edge and Firefox.
 */
export function DocumentViewer({
  runId,
  fileId,
  title,
  page,
  onClose,
}: {
  runId: string;
  fileId: string;
  title: string;
  page: number | null;
  onClose: () => void;
}) {
  const panelRef = useDialog(onClose);

  const base = `/api/review-runs/${runId}/docs/${fileId}/raw`;
  const src = `${base}?inline=1${page ? `#page=${page}` : ''}`;

  // z-[60] puts this above the finding drawer at z-50, which is what opened it.
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/70 p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="mx-auto flex h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-line bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5">
          <b className="flex-1 truncate text-[14px]">{title}</b>
          {page ? <span className="text-[12.5px] text-ink-faint">page {page}</span> : null}
          <a
            href={base}
            className="rounded-md border border-line px-2.5 py-1 text-[12.5px] text-ink-dim no-underline hover:text-ink"
          >
            Download
          </a>
          <button
            onClick={onClose}
            className="rounded-md border border-line px-2.5 py-1 text-[12.5px] text-ink-dim hover:text-ink"
          >
            Close
          </button>
        </div>

        <iframe key={src} src={src} title={title} className="flex-1 bg-white" sandbox="" />
      </div>
    </div>
  );
}
