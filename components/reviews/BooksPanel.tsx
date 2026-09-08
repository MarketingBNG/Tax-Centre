'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SkeletonRows } from '../ui';

/**
 * The books behind an engagement.
 *
 * Two things are on this screen deliberately. The first is the import itself,
 * stamped with the three dates that answer three different questions — when the
 * data left the source system, what period it covers, and when it arrived here.
 *
 * The second is the mapping, shown in full rather than summarised. A reviewer
 * has to be able to see that "Sundry Debtors" was read as trade receivables,
 * because every books check downstream is written against the standard key and
 * a wrong mapping there is silent. The accounts the platform could not place
 * are listed first for the same reason: they were not forced into the nearest
 * guess, so somebody has to look at them.
 */

interface ImportRow {
  id: string;
  sourceSystem: string;
  sourceRef: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  extractedAt: number;
  importedAt: number;
  rowCount: number;
  unmappedCount: number;
  contentHash: string;
}

interface AccountRow {
  code: string | null;
  name: string;
  balance: number | null;
  key: string | null;
  confidence: number | null;
  reason: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  spreadsheet: 'Uploaded trial balance',
  tally: 'Tally',
  quickbooks: 'QuickBooks',
  zoho: 'Zoho Books',
  xero: 'Xero',
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const money = (value: number | null) =>
  value === null
    ? '—'
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function BooksPanel({ engagementId }: { engagementId: string }) {
  const [imports, setImports] = useState<ImportRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (importId?: string | null) => {
      const query = importId ? `?import=${encodeURIComponent(importId)}` : '';
      const res = await fetch(`/api/engagements/${engagementId}/books${query}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setImports(data.imports as ImportRow[]);
      if (importId) setAccounts(data.accounts as AccountRow[]);
      return data.imports as ImportRow[];
    },
    [engagementId],
  );

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  function open(importId: string) {
    if (selected === importId) {
      setSelected(null);
      setAccounts(null);
      return;
    }
    setSelected(importId);
    setAccounts(null);
    load(importId).catch((err: Error) => setError(err.message));
  }

  async function importFile(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const form = new FormData();
      form.append('files', files[0]);
      const upload = await fetch('/api/files', { method: 'POST', body: form });
      const uploaded = await upload.json().catch(() => ({}));
      if (!upload.ok) throw new Error(uploaded.error ?? `Upload failed (${upload.status})`);
      if (uploaded.errors?.length) throw new Error(uploaded.errors[0].error);

      const res = await fetch(`/api/engagements/${engagementId}/books`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileId: uploaded.files[0].id,
          periodStart: periodStart || null,
          periodEnd: periodEnd || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Import failed (${res.status})`);

      setNote(
        [
          data.duplicate
            ? 'That exact data was already imported, so nothing was written.'
            : `${data.rowCount} accounts read.`,
          `${data.mapped} mapped`,
          data.unmapped ? `${data.unmapped} could not be placed` : null,
          data.weak ? `${data.weak} mapped weakly and worth checking` : null,
          data.skipped ? `${data.skipped} rows unreadable` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );

      await load(data.id);
      setSelected(data.id);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const unmapped = accounts?.filter((a) => !a.key) ?? [];
  const mapped = accounts?.filter((a) => a.key) ?? [];

  return (
    <div>
      <section className="mb-5 rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="text-[14px] font-medium">Import a trial balance</h2>
        <p className="mt-1 text-[13px] text-ink-faint">
          XLSX or CSV. A PDF trial balance can be read by the model but not normalised into the
          chart of accounts, so the checks that compare accounts across clients would not run on
          it. Re-importing identical data changes nothing.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-[11.5px] text-ink-faint">
            Period start
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="mt-1 block rounded-[6px] border border-line bg-raised px-2 py-1 text-[13px] text-ink"
            />
          </label>
          <label className="text-[11.5px] text-ink-faint">
            Period end
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="mt-1 block rounded-[6px] border border-line bg-raised px-2 py-1 text-[13px] text-ink"
            />
          </label>
          <label
            className={`rounded-[9px] border border-line px-3 py-2 text-[13px] ${
              busy ? 'text-ink-faint' : 'cursor-pointer text-ink-dim hover:border-accent hover:text-accent'
            }`}
          >
            {busy ? 'Importing…' : 'Choose file'}
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              disabled={busy}
              onChange={(e) => importFile(e.target.files)}
            />
          </label>
        </div>

        {note && (
          <div className="mt-3 rounded-lg border border-line bg-raised px-3 py-2 text-[13px] text-ink-dim">
            {note}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-3 rounded-lg border border-sev-critical/35 bg-sev-critical/10 px-3 py-2 text-[13px] text-sev-critical">
            {error}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="mb-1 text-[14px] font-medium">Imports</h2>
        <p className="mb-3 text-[13px] text-ink-faint">
          The most recent import is the one a review reads. Older ones are kept so a finished run
          can still be defended against the data it actually saw.
        </p>

        {!imports && !error && <SkeletonRows rows={2} />}
        {imports?.length === 0 && (
          <div className="text-[13px] text-ink-faint">
            Nothing imported yet, so the books stage will read whatever is in the attached
            documents rather than a normalised ledger.
          </div>
        )}

        <ul className="space-y-2">
          {imports?.map((row, index) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => open(row.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left ${
                  selected === row.id
                    ? 'border-accent bg-raised'
                    : 'border-line-soft hover:border-line hover:bg-raised'
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-ink">
                    {SOURCE_LABEL[row.sourceSystem] ?? row.sourceSystem}
                    {index === 0 && (
                      <span className="ml-2 text-[11.5px] text-verdict-clear">in use</span>
                    )}
                  </span>
                  <span className="text-[11.5px] text-ink-faint">
                    {row.rowCount} accounts
                    {row.unmappedCount > 0 && (
                      <span className="text-sev-high"> · {row.unmappedCount} unplaced</span>
                    )}
                  </span>
                </div>
                <div className="mt-1 text-[11.5px] text-ink-faint">
                  Taken from the source {day(row.extractedAt)} · imported {day(row.importedAt)}
                  {row.periodStart && row.periodEnd
                    ? ` · covers ${row.periodStart} to ${row.periodEnd}`
                    : ' · period not stated'}
                </div>
              </button>

              {selected === row.id && (
                <div className="mt-2 mb-2 rounded-lg border border-line-soft p-3">
                  {!accounts && <SkeletonRows rows={2} />}

                  {unmapped.length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-[13px] font-medium text-sev-high">
                        {unmapped.length} account{unmapped.length === 1 ? '' : 's'} could not be
                        placed
                      </h3>
                      <p className="mt-1 mb-2 text-[11.5px] text-ink-faint">
                        Left unmapped rather than filed under the nearest guess. The books stage is
                        shown these too, so it cannot review a subset and report it as the whole
                        ledger.
                      </p>
                      <AccountTable rows={unmapped} />
                    </div>
                  )}

                  {mapped.length > 0 && (
                    <div>
                      <h3 className="text-[13px] font-medium">
                        {mapped.length} mapped to the firm&apos;s chart of accounts
                      </h3>
                      <p className="mt-1 mb-2 text-[11.5px] text-ink-faint">
                        The client&apos;s own code and name are kept beside the standard key — a
                        preparer cannot act on a note about a name their screen does not show.
                      </p>
                      <AccountTable rows={mapped} />
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function AccountTable({ rows }: { rows: AccountRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-ink-faint">
            <th className="border-b border-line-soft py-1 pr-3 font-normal">Code</th>
            <th className="border-b border-line-soft py-1 pr-3 font-normal">Client&apos;s name</th>
            <th className="border-b border-line-soft py-1 pr-3 text-right font-normal">Balance</th>
            <th className="border-b border-line-soft py-1 pr-3 font-normal">Standard key</th>
            <th className="border-b border-line-soft py-1 font-normal">How it was read</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const weak = row.key !== null && (row.confidence ?? 1) < 0.7;
            return (
              <tr key={`${row.code ?? ''}-${row.name}-${i}`} className="align-top">
                <td className="border-b border-line-soft/60 py-1 pr-3 font-mono text-[11.5px] text-ink-faint">
                  {row.code ?? ''}
                </td>
                <td className="border-b border-line-soft/60 py-1 pr-3 text-ink">{row.name}</td>
                <td className="border-b border-line-soft/60 py-1 pr-3 text-right font-mono text-[11.5px] text-ink-dim">
                  {money(row.balance)}
                </td>
                <td className="border-b border-line-soft/60 py-1 pr-3">
                  {row.key ? (
                    <span className={weak ? 'text-sev-high' : 'text-ink-dim'}>
                      {row.key}
                      {weak && ' (weak)'}
                    </span>
                  ) : (
                    <span className="text-sev-high">unplaced</span>
                  )}
                </td>
                <td className="border-b border-line-soft/60 py-1 text-ink-faint">
                  {row.reason ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
