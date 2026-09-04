'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RETURN_TYPES, type DocRole, type ReturnType } from '@/lib/review-types';

/**
 * Setting up a review.
 *
 * The document step is the point of this screen. SKILL.md distinguishes between
 * inputs a review can proceed without — as long as the register says what could
 * not be checked — and inputs that make the exercise meaningless. Showing that
 * distinction here, before anything runs, means somebody finds out they are
 * missing the prior-year trial balance while they can still go and fetch it,
 * rather than three stages into a run.
 */

interface SlotDef {
  role: DocRole;
  label: string;
  /** Blocking outright, blocking only for some returns, or advisory. */
  requirement: 'always' | 'conditional' | 'optional';
  note: string;
  conditionalFor?: ReturnType[];
}

const SLOTS: SlotDef[] = [
  {
    role: 'drake_export',
    label: 'Prepared return',
    requirement: 'always',
    note: 'All forms, schedules, statements and worksheets. Without it there is nothing to review.',
  },
  {
    role: 'trial_balance_cy',
    label: 'Trial balance — this year end',
    requirement: 'always',
    note: 'The return is checked against the books, not against itself.',
  },
  {
    role: 'trial_balance_py',
    label: 'Trial balance — prior year end',
    requirement: 'always',
    note: 'The balance sheet roll needs both years to tie out.',
  },
  {
    role: 'ownership_schedule',
    label: 'Ownership schedule / K-1 percentages',
    requirement: 'conditional',
    conditionalFor: ['1065', '1120-F', '1120-DRE-5472'],
    note: 'Required for partnerships and 5472 filers — the allocations and related-party transactions are the review.',
  },
  {
    role: 'gl_detail',
    label: 'General ledger detail',
    requirement: 'optional',
    note: 'Without it, every account that could not be sampled is flagged.',
  },
  {
    role: 'prior_year_return',
    label: 'Prior-year return as filed',
    requirement: 'optional',
    note: 'Without it, rollforward checks are flagged unverified.',
  },
  {
    role: 'bank_statement',
    label: 'Bank and loan statements',
    requirement: 'optional',
    note: 'Without them, cash and debt are flagged unreconciled.',
  },
  {
    role: 'fixed_asset_register',
    label: 'Fixed asset / depreciation schedule',
    requirement: 'optional',
    note: 'Without it, depreciation is flagged unverified.',
  },
  {
    role: 'preparer_notes',
    label: "Preparer's notes and open items",
    requirement: 'optional',
    note: 'Without them the question list will be longer.',
  },
  {
    role: 'engagement_letter',
    label: 'Engagement letter / scope',
    requirement: 'optional',
    note: 'Without it, scope is flagged as assumed.',
  },
];

interface Attached {
  role: DocRole;
  fileId: string;
  filename: string;
}

const isBlocking = (slot: SlotDef, returnType: ReturnType | ''): boolean =>
  slot.requirement === 'always' ||
  (slot.requirement === 'conditional' &&
    Boolean(returnType) &&
    Boolean(slot.conditionalFor?.includes(returnType as ReturnType)));

const input =
  'w-full rounded-[9px] border border-line bg-canvas px-3 py-1.5 text-[13px] text-ink outline-none focus:border-[#3c4653]';
const label = 'mb-1 block text-[12px] text-ink-dim';

export function NewReviewWizard() {
  const router = useRouter();

  const [clientLabel, setClientLabel] = useState('');
  const [entityName, setEntityName] = useState('');
  const [ein, setEin] = useState('');
  const [returnType, setReturnType] = useState<ReturnType | ''>('');
  const [taxYear, setTaxYear] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [jurisdictions, setJurisdictions] = useState('US-FED');
  const [indiaLink, setIndiaLink] = useState(false);
  const [foreignOwnerPct, setForeignOwnerPct] = useState('');
  const [foreignAccounts, setForeignAccounts] = useState(false);
  const [foreignSubsidiary, setForeignSubsidiary] = useState(false);

  const [attached, setAttached] = useState<Attached[]>([]);
  const [uploading, setUploading] = useState<DocRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickers = useRef<Record<string, HTMLInputElement | null>>({});

  const blockingMissing = useMemo(
    () =>
      SLOTS.filter(
        (slot) => isBlocking(slot, returnType) && !attached.some((a) => a.role === slot.role),
      ),
    [attached, returnType],
  );

  const canStart = clientLabel.trim() && returnType && blockingMissing.length === 0 && !busy;

  async function upload(role: DocRole, files: FileList | null) {
    if (!files?.length) return;
    setUploading(role);
    setError(null);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append('files', file);
      const res = await fetch('/api/files', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
      if (data.errors?.length) throw new Error(data.errors[0].error);

      setAttached((prev) => [
        ...prev,
        ...data.files.map((f: { id: string; filename: string }) => ({
          role,
          fileId: f.id,
          filename: f.filename,
        })),
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(null);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const facts: Record<string, unknown> = {
        jurisdictions: jurisdictions
          .split(/[,;\s]+/)
          .map((j) => j.trim().toUpperCase())
          .filter(Boolean),
        india_link: indiaLink,
        foreign_accounts: foreignAccounts,
        foreign_subsidiary: foreignSubsidiary,
      };
      if (foreignOwnerPct.trim()) facts.foreign_owner_pct = Number(foreignOwnerPct);

      const engagementRes = await fetch('/api/engagements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientLabel: clientLabel.trim(),
          entityName: entityName.trim() || null,
          ein: ein.trim() || null,
          returnType,
          taxYear: taxYear ? Number(taxYear) : null,
          periodStart: periodStart || null,
          periodEnd: periodEnd || null,
          facts,
        }),
      });
      const engagement = await engagementRes.json();
      if (!engagementRes.ok) throw new Error(engagement.error ?? 'Could not create the engagement');

      const runRes = await fetch('/api/review-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engagementId: engagement.id,
          documents: attached.map((a) => ({ fileId: a.fileId, docRole: a.role })),
        }),
      });
      const run = await runRes.json();
      if (!runRes.ok) throw new Error(run.error ?? 'Could not create the run');

      router.push(`/reviews/${engagement.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[780px] px-6 py-6">
      <h1 className="text-[21px] font-semibold tracking-tight">New review</h1>
      <p className="mt-1 mb-6 text-[13px] text-ink-dim">
        The engagement facts decide which checks run — an Indian link or a foreign owner turns on
        modules that would otherwise be skipped, and that determination is made fresh every year
        rather than carried forward.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[13px] text-[#e8b0b0]">
          {error}
        </div>
      )}

      {/* ---------------------------------------------------------- facts */}

      <section className="mb-6 rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="mb-3 text-[14px] font-medium">Engagement</h2>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Client *</label>
            <input className={input} value={clientLabel} onChange={(e) => setClientLabel(e.target.value)} />
          </div>
          <div>
            <label className={label}>Entity name</label>
            <input className={input} value={entityName} onChange={(e) => setEntityName(e.target.value)} />
          </div>
          <div>
            <label className={label}>EIN</label>
            <input className={input} value={ein} onChange={(e) => setEin(e.target.value)} />
          </div>
          <div>
            <label className={label}>Return type *</label>
            <select
              className={input}
              value={returnType}
              onChange={(e) => setReturnType(e.target.value as ReturnType | '')}
            >
              <option value="">Choose…</option>
              {RETURN_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Tax year</label>
            <input
              className={input}
              inputMode="numeric"
              value={taxYear}
              onChange={(e) => setTaxYear(e.target.value)}
              placeholder="2025"
            />
          </div>
          <div>
            <label className={label}>Jurisdictions</label>
            <input
              className={input}
              value={jurisdictions}
              onChange={(e) => setJurisdictions(e.target.value)}
              placeholder="US-FED, US-NJ, US-NYC"
            />
          </div>
          <div>
            <label className={label}>Period start</label>
            <input type="date" className={input} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </div>
          <div>
            <label className={label}>Period end</label>
            <input type="date" className={input} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
        </div>

        <div className="mt-4 border-t border-line-soft pt-3">
          <div className="mb-2 text-[12px] text-ink-dim">
            Cross-border facts — each one turns on checks that are otherwise skipped.
          </div>
          <div className="flex flex-wrap gap-4 text-[13px]">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={indiaLink} onChange={(e) => setIndiaLink(e.target.checked)} />
              Indian owner, affiliate, income or assets
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={foreignAccounts} onChange={(e) => setForeignAccounts(e.target.checked)} />
              Foreign financial accounts
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={foreignSubsidiary}
                onChange={(e) => setForeignSubsidiary(e.target.checked)}
              />
              Owns a foreign corporation
            </label>
            <label className="flex items-center gap-1.5">
              Foreign owner %
              <input
                className="w-16 rounded-[9px] border border-line bg-canvas px-2 py-1 text-[13px] outline-none focus:border-[#3c4653]"
                inputMode="numeric"
                value={foreignOwnerPct}
                onChange={(e) => setForeignOwnerPct(e.target.value)}
              />
            </label>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ documents */}

      <section className="mb-6 rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="mb-1 text-[14px] font-medium">Documents</h2>
        <p className="mb-3 text-[12px] text-ink-faint">
          Anything marked required has to be here before the review can start. The rest are
          optional — what is missing gets written onto the register rather than passed over in
          silence.
        </p>

        <ul className="space-y-1.5">
          {SLOTS.map((slot) => {
            const files = attached.filter((a) => a.role === slot.role);
            const blocking = isBlocking(slot, returnType);
            const unmet = blocking && files.length === 0;

            return (
              <li
                key={slot.role}
                className={`rounded-lg border px-3 py-2 ${
                  unmet ? 'border-sev-critical/35 bg-sev-critical/5' : 'border-line-soft'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px]">
                      {slot.label}
                      {blocking && <span className="ml-1.5 text-[11px] text-sev-critical">required</span>}
                      {slot.requirement === 'conditional' && !blocking && (
                        <span className="ml-1.5 text-[11px] text-ink-faint">
                          required for 1065 and 5472 filers
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-ink-faint">{slot.note}</div>
                    {files.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {files.map((file) => (
                          <span
                            key={file.fileId}
                            className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-dim"
                          >
                            {file.filename}
                            <button
                              type="button"
                              onClick={() =>
                                setAttached((prev) => prev.filter((a) => a.fileId !== file.fileId))
                              }
                              className="text-ink-faint hover:text-sev-blocking"
                              aria-label={`Remove ${file.filename}`}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="shrink-0">
                    <input
                      ref={(el) => {
                        pickers.current[slot.role] = el;
                      }}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        void upload(slot.role, e.target.files);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => pickers.current[slot.role]?.click()}
                      disabled={uploading !== null}
                      className="rounded-[9px] border border-line px-2.5 py-1 text-[12px] text-ink-dim hover:border-accent hover:text-accent disabled:opacity-40"
                    >
                      {uploading === slot.role ? 'Uploading…' : 'Attach'}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ---------------------------------------------------------- start */}

      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-ink-faint">
          {!returnType
            ? 'Choose a return type — it decides which documents are required.'
            : blockingMissing.length > 0
              ? `Still needed: ${blockingMissing.map((s) => s.label).join(', ')}.`
              : 'Ready to run.'}
        </div>
        <button
          type="button"
          onClick={() => void start()}
          disabled={!canStart}
          className="rounded-[9px] bg-accent px-4 py-1.5 text-[13px] font-medium text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create review'}
        </button>
      </div>
    </div>
  );
}
