'use client';

import { useEffect } from 'react';

/**
 * Opens a stored document at a given page.
 *
 * Rendered in a sandboxed iframe pointing at our own `?inline=1` route. That
 * response carries `Content-Security-Policy: sandbox`, which puts it in an
 * opaque origin — so a hostile PDF cannot reach the reviewer's session even
 * though it is served from the same host. `#page=` is honoured by the built-in
 * PDF viewers in Chrome, Edge and Firefox.
 */
export function PdfViewer({
  fileId,
  title,
  page,
  onClose,
}: {
  fileId: string;
  title: string;
  page: number | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const src = `/api/files/${fileId}/raw?inline=1${page ? `#page=${page}` : ''}`;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-auto flex h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-line bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5">
          <b className="flex-1 truncate text-[14px]">{title}</b>
          {page ? <span className="text-[12.5px] text-ink-faint">page {page}</span> : null}
          <a
            href={`/api/files/${fileId}/raw`}
            className="rounded-md border border-line px-2.5 py-1 text-[12.5px] text-ink-dim hover:text-ink"
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

        <iframe
          key={src}
          src={src}
          title={title}
          className="flex-1 bg-white"
          sandbox=""
        />
      </div>
    </div>
  );
}
