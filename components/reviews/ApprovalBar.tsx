'use client';

import { btn, field } from '../ui';
import { useState } from 'react';
import { VERDICT_WORD } from './chips';
import type { RunDetail } from './types';

/**
 * The sign-off.
 *
 * The bar says plainly that the AI's verdict is a first pass, because a page
 * that presents a machine verdict as a conclusion invites exactly the treatment
 * this guards against. What is actually recorded is a person, a time, and the
 * register version they read.
 *
 * A Hold offers nothing to approve — it is the default state of an unapproved
 * register, and the button says why rather than sitting there greyed out with
 * no explanation.
 */
export function ApprovalBar({
  detail,
  runId,
  onApproved,
}: {
  detail: RunDetail;
  runId: string;
  onApproved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const { run, approval } = detail;
  const verdict = run.verdict;
  const blockers = run.verdictDetail?.blockers ?? [];

  if (approval) {
    return (
      <section className="trc-print-zone rounded-xl border border-verdict-clear/40 bg-verdict-clear/5 px-4 py-3">
        <div className="text-[13px] text-verdict-clear">
          Signed off as {VERDICT_WORD[approval.verdictSeen]} by {approval.approvedBy}
        </div>
        <div className="mt-1 text-[11.5px] text-ink-faint">
          {new Date(approval.approvedAt).toLocaleString()} · register version{' '}
          {approval.registerVersionSeen}. Any later change to the register lapses this
          automatically.
        </div>
        {approval.selfApproved && (
          <div className="mt-1 text-[11.5px] text-ink-faint">
            Signed off by the person who started the run.
          </div>
        )}
      </section>
    );
  }

  const canOffer = verdict === 'clear' || verdict === 'release_with_conditions';

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review-runs/${runId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          result: verdict,
          registerVersionSeen: run.registerVersion,
          note: note.trim() || null,
        }),
      });
      const data = await res.json();

      if (res.status === 409) {
        setStale(true);
        setError(data.error);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? 'Could not record the approval');

      setConfirming(false);
      onApproved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="trc-print-hide rounded-xl border border-line-soft bg-panel px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="text-[13px]">Not yet signed off</div>
          <div className="mt-1 text-[11.5px] text-ink-faint">
            The review above is a first pass. A named person signs a return off, and what they
            saw is recorded with it.
          </div>
        </div>

        {canOffer ? (
          <button
            onClick={() => setConfirming(true)}
            className={btn('primary','md','shrink-0')}
          >
            Sign off as {VERDICT_WORD[verdict]}
          </button>
        ) : (
          <div className="max-w-[300px] shrink-0 text-right text-[11.5px] text-sev-critical">
            {verdict === 'hold'
              ? 'On hold — there is nothing to sign off until the blocking items are resolved.'
              : 'No verdict yet. Run the review first.'}
          </div>
        )}
      </div>

      {!canOffer && blockers.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-line-soft pt-2 text-[11.5px] text-ink-dim">
          {blockers.slice(0, 4).map((blocker, i) => (
            <li key={i}>— {blocker}</li>
          ))}
        </ul>
      )}

      {confirming && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <div className="text-[13px]">
            Signing off <b>{verdict ? VERDICT_WORD[verdict] : ''}</b> on register version{' '}
            <b>{run.registerVersion}</b>, with {detail.derived.openCriticalHigh} Critical or High
            item{detail.derived.openCriticalHigh === 1 ? '' : 's'} open.
          </div>

          {verdict === 'release_with_conditions' && (
            <div className="mt-2 text-[11.5px] text-sev-high">
              The conditions below stay open and owned. This is not a clearance.
            </div>
          )}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Anything to record alongside the sign-off (optional)…"
            className={`${field} mt-2 resize-y`}
          />

          {error && (
            <div role="alert" className="mt-2 rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[13px] text-alert-error-ink">
              {error}
            </div>
          )}

          <div className="mt-2 flex items-center gap-2">
            {stale ? (
              <button
                onClick={() => window.location.reload()}
                className={btn('primary','sm')}
              >
                Reload and re-read
              </button>
            ) : (
              <button
                onClick={() => void approve()}
                disabled={busy}
                className={btn('primary','sm')}
              >
                {busy ? 'Recording…' : 'Confirm sign-off'}
              </button>
            )}
            <button
              onClick={() => {
                setConfirming(false);
                setError(null);
                setStale(false);
              }}
              className={btn('quiet','sm')}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
