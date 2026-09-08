'use client';

import { useEffect, useState } from 'react';

/**
 * The model's reasoning summary.
 *
 * Open while it is being written, closed the moment the answer starts. That is
 * the useful default in both directions: watching it think is reassuring on a
 * slow question, and a wall of reasoning above every finished answer is not
 * what anybody came to read.
 */
export function Thinking({
  text,
  streaming = false,
  durationMs,
}: {
  text: string;
  streaming?: boolean;
  durationMs?: number;
}) {
  const [open, setOpen] = useState(streaming);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!pinned) setOpen(streaming);
  }, [streaming, pinned]);

  if (!text.trim()) return null;

  const seconds = durationMs ? Math.round(durationMs / 1000) : null;

  return (
    <div className="mb-3 rounded-lg border border-line-soft bg-panel/60">
      <button
        onClick={() => {
          setPinned(true);
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink-faint hover:text-ink-dim"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        <span className="font-medium">
          {streaming ? 'Thinking…' : seconds ? `Thought for ${seconds}s` : 'Thought about it'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-line-soft px-3 py-2 text-[13px] leading-[1.55] whitespace-pre-wrap text-ink-dim">
          {text}
          {streaming ? <span className="trc-cursor" /> : null}
        </div>
      ) : null}
    </div>
  );
}
