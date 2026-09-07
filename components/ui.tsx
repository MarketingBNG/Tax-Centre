'use client';

import { useCallback, useState } from 'react';
import { useDialog } from './useDialog';

/**
 * The three shapes every screen was rebuilding by hand.
 *
 * Errors were rendered eleven slightly different ways, "Loading…" appeared as
 * bare text in eleven places, and destructive actions went through the
 * browser's own `confirm()` — an unstyled OS box in the middle of a dark app,
 * with no room to say what is about to be deleted. None of that was a decision;
 * it was the cost of every panel being written on its own.
 */

/* ----------------------------------------------------------------- alert */

export function Alert({
  kind = 'error',
  children,
  className = '',
}: {
  kind?: 'error' | 'warn' | 'info';
  children: React.ReactNode;
  className?: string;
}) {
  const tone =
    kind === 'warn'
      ? 'border-sev-math/35 bg-sev-math/10 text-[#dcc79a]'
      : kind === 'info'
        ? 'border-line bg-raised text-ink-dim'
        : 'border-sev-blocking/35 bg-sev-blocking/10 text-[#e8b0b0]';

  return (
    // role=alert so the text is announced, not only drawn.
    <div role="alert" className={`rounded-lg border px-3 py-2 text-[13px] ${tone} ${className}`}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- skeleton */

/**
 * A placeholder the shape of what is coming.
 *
 * The point is not the shimmer, it is that the page does not jump: a row of
 * these occupies the same space the real rows will, so nothing below them moves
 * when the fetch lands.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-raised ${className}`} aria-hidden />;
}

export function SkeletonRows({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------- confirm dialog */

interface ConfirmRequest {
  title: string;
  body?: string;
  /** The word on the button. "Delete", "Purge", "Disconnect" — never "OK". */
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * Replaces `window.confirm`.
 *
 * `useConfirm()` returns an `ask` function and the element to render. Keeping
 * the element at the call site rather than in a global provider means a panel
 * that is unmounted mid-prompt takes its prompt with it.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback((req: ConfirmRequest) => setRequest(req), []);

  const dialog = request ? (
    <ConfirmDialog
      request={request}
      busy={busy}
      onClose={() => !busy && setRequest(null)}
      onConfirm={async () => {
        setBusy(true);
        try {
          await request.onConfirm();
          setRequest(null);
        } finally {
          setBusy(false);
        }
      }}
    />
  ) : null;

  return { ask, confirmDialog: dialog };
}

function ConfirmDialog({
  request,
  busy,
  onClose,
  onConfirm,
}: {
  request: ConfirmRequest;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const panelRef = useDialog(onClose);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/55 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] rounded-2xl border border-line bg-canvas p-5"
      >
        <h2 className="text-[15px] font-semibold">{request.title}</h2>
        {request.body ? <p className="mt-1.5 text-[13px] text-ink-dim">{request.body}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink-dim hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            // Focused by the dialog hook only if it is first in the DOM, which
            // it deliberately is not — Cancel takes focus on a destructive box.
            className={`rounded-[9px] px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 ${
              request.destructive
                ? 'bg-sev-blocking text-[#2a0f0f] hover:brightness-110'
                : 'bg-accent text-accent-ink hover:bg-accent-hover'
            }`}
          >
            {busy ? 'Working…' : request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
