'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Mark } from './Mark';
import { ConnectorsTab } from './ConnectorsTab';
import { BooksProvidersTab } from './BooksProvidersTab';
import { SkillsManager } from './SkillsManager';
import { VERDICT_WORD } from './reviews/chips';
import type { Verdict } from '@/lib/review-types';

type Tab = 'prompt' | 'costs' | 'people' | 'skills' | 'connectors' | 'books' | 'audit';

interface PromptSettings {
  basePrompt: string;
  customPrompt: string;
  tokenEstimate: number;
}

interface Costs {
  monthToDateUsd: number;
  capUsd: number;
  byUser: { email: string; display_name: string; calls: number; usd: number }[];
  recent: {
    id: string;
    created_at: number;
    email: string;
    purpose: string;
    tokens: number;
    usd: number;
  }[];
  cacheHitRate: number;
  reviewsMonthToDateUsd?: number;
  reviews?: {
    id: string;
    engagementId: string;
    runNumber: number;
    status: string;
    verdict: Verdict | null;
    createdAt: number;
    entity: string | null;
    taxYear: number | null;
    stagesRun: number;
    usd: number;
  }[];
}

interface Person {
  id: string;
  email: string;
  role: string;
  display_name: string;
  is_active: number;
}

interface Retention {
  retentionDays: number;
  liveFiles: number;
  liveBytes: number;
  dueFiles: number;
  dueBytes: number;
  purgedFiles: number;
}

const field =
  'w-full rounded-[9px] border border-line bg-panel px-3 py-2 outline-none focus:border-[#55534c]';
const btn =
  'rounded-[9px] border border-line bg-raised px-4 py-2 font-medium hover:bg-raised-hover disabled:opacity-50';
const btnPrimary =
  'rounded-[9px] bg-accent px-4 py-2 font-medium text-accent-ink hover:bg-accent-hover disabled:opacity-50';
const btnSm = 'rounded-md border border-line px-2.5 py-1 text-[12.5px] hover:bg-raised';
const panel = 'mb-4 rounded-xl border border-line bg-panel p-5';
const label = 'mb-1.5 mt-3 block text-[12.5px] text-ink-dim';

const usd = (n: number) => `$${Number(n || 0).toFixed(2)}`;
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

export function AdminPanel() {
  const [tab, setTab] = useState<Tab>('prompt');

  return (
    <div className="mx-auto max-w-[1000px] px-6 pt-7 pb-16">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-[21px] font-medium">
          <Mark size={20} />
          Admin
        </h1>
        <div className="flex items-center gap-2">
          <Link href="/admin/corpus" className={btn}>
            Citation library
          </Link>
          <Link href="/" className={btn}>
            ← Back to chat
          </Link>
        </div>
      </div>

      <div className="mb-5 flex gap-1 border-b border-line-soft">
        {(
          [
            ['prompt', 'Instructions'],
            ['costs', 'Usage & cost'],
            ['people', 'People'],
            ['skills', 'Skills'],
            ['connectors', 'Connectors'],
            ['books', 'Connections'],
            ['audit', 'Audit log'],
          ] as [Tab, string][]
        ).map(([key, text]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`border-b-2 px-3.5 py-2 font-medium ${
              tab === key ? 'border-accent text-ink' : 'border-transparent text-ink-faint'
            }`}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === 'prompt' ? <PromptTab /> : null}
      {tab === 'costs' ? <CostsTab /> : null}
      {tab === 'people' ? <PeopleTab /> : null}
      {tab === 'skills' ? (
        <div className={panel}>
          <h2 className="mb-1 text-[15px] font-semibold">Firm skills</h2>
          <p className="mb-3 text-[13px] text-ink-dim">
            A skill is a folder of instructions the assistant loads when it applies.
            Only the name and description of each one travel in every prompt, so a
            large procedure costs almost nothing until it fires. These apply to
            everybody; people can also install their own under Settings.
          </p>
          <SkillsManager scope="firm" />
        </div>
      ) : null}
      {tab === 'connectors' ? <ConnectorsTab /> : null}
      {tab === 'books' ? <BooksProvidersTab /> : null}
      {tab === 'audit' ? <AuditTab /> : null}
    </div>
  );
}

/* --------------------------------------------------------- instructions */

function PromptTab() {
  const [data, setData] = useState<PromptSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/prompt');
    if (!res.ok) return;
    const body: PromptSettings = await res.json();
    setData(body);
    setDraft(body.customPrompt);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch('/api/admin/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customPrompt: draft }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not save');
      setMessage('Saved — every new message uses this.');
      load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={panel}>
        <h2 className="mb-1 text-[15px] font-semibold">House instructions</h2>
        <p className="mb-3 text-[13px] text-ink-dim">
          Added to <em>every</em> conversation, for everyone. Good for house style, the
          names of your systems, or what to do when someone asks about a client. It is
          sent on every message, so keep it to what genuinely applies every time.
        </p>

        <textarea
          className={`${field} min-h-[220px] font-mono text-[13px]`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. We are a US-India accounting firm. Prefer plain English over jargon. Never put client names in examples."
        />

        <div className="mt-3 flex items-center gap-3">
          <button
            className={btnPrimary}
            disabled={busy || draft === data?.customPrompt}
            onClick={save}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {data ? (
            <span className="text-[12.5px] text-ink-faint">
              ~{data.tokenEstimate.toLocaleString()} tokens on every message
            </span>
          ) : null}
          {message ? <span className="text-[13px] text-ink-dim">{message}</span> : null}
        </div>
      </div>

      <div className={panel}>
        <h2 className="mb-1 text-[15px] font-semibold">Built-in rules</h2>
        <p className="mb-3 text-[13px] text-ink-dim">
          Always applied, before your text. Shown so you know what not to repeat.
        </p>
        <pre className="max-h-[280px] overflow-auto rounded-[9px] border border-line bg-raised p-3 text-[12.5px] whitespace-pre-wrap text-ink-dim">
          {data?.basePrompt ?? ''}
        </pre>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- costs */

function CostsTab() {
  const [data, setData] = useState<Costs | null>(null);
  const [retention, setRetention] = useState<Retention | null>(null);
  const [cap, setCap] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, r] = await Promise.all([
      fetch('/api/admin/costs').then((x) => (x.ok ? x.json() : null)),
      fetch('/api/admin/retention').then((x) => (x.ok ? x.json() : null)),
    ]);
    if (c) {
      setData(c);
      setCap(String(c.capUsd));
    }
    if (r) setRetention(r);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <div className="p-6 text-center text-ink-faint">Loading…</div>;

  const pct = data.capUsd ? Math.min(100, (data.monthToDateUsd / data.capUsd) * 100) : 0;
  const cacheLow = data.cacheHitRate < 0.3;

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-3.5">
        <div className="min-w-[170px] flex-1 rounded-xl border border-line bg-panel px-4 py-3.5">
          <div className="mb-1.5 text-[12px] text-ink-faint">Spend this month</div>
          <div className="text-[22px] font-semibold tabular-nums">{usd(data.monthToDateUsd)}</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
            <i className="block h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 text-[12px] text-ink-faint">of {usd(data.capUsd)} cap</div>
        </div>

        <div className="min-w-[170px] flex-1 rounded-xl border border-line bg-panel px-4 py-3.5">
          <div className="mb-1.5 text-[12px] text-ink-faint">Cache hit rate</div>
          <div className="text-[22px] font-semibold tabular-nums">
            {(data.cacheHitRate * 100).toFixed(0)}%
          </div>
          <div className={`mt-1.5 text-[12px] ${cacheLow ? 'text-sev-math' : 'text-ink-faint'}`}>
            {cacheLow
              ? 'Low — check nothing volatile entered the prompt prefix'
              : 'Healthy'}
          </div>
        </div>

        {retention ? (
          <div className="min-w-[170px] flex-1 rounded-xl border border-line bg-panel px-4 py-3.5">
            <div className="mb-1.5 text-[12px] text-ink-faint">Stored documents</div>
            <div className="text-[22px] font-semibold tabular-nums">{retention.liveFiles}</div>
            <div className="mt-1.5 text-[12px] text-ink-faint">
              {mb(retention.liveBytes)} · {retention.purgedFiles} purged
            </div>
          </div>
        ) : null}
      </div>

      <div className={panel}>
        <h2 className="mb-1 text-[15px] font-semibold">Monthly spend cap</h2>
        <p className="mb-3 text-[13px] text-ink-dim">
          A guide rail for watching the month, shown on this page.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[180px]">
            <label className={label}>Cap (USD)</label>
            <input
              type="number"
              min={0}
              step={10}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className={field}
            />
          </div>
          <button
            onClick={async () => {
              setBusy(true);
              await fetch('/api/admin/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ monthlyCapUsd: Number(cap) }),
              });
              setBusy(false);
              setNote('Saved.');
              load();
            }}
            disabled={busy}
            className={btn}
          >
            Save
          </button>
          {note ? <span className="text-[13px] text-ink-dim">{note}</span> : null}
        </div>
      </div>

      {retention ? (
        <div className={panel}>
          <h2 className="mb-1 text-[15px] font-semibold">Document retention</h2>
          <p className="mb-3 text-[13px] text-ink-dim">
            Uploaded originals expire after {retention.retentionDays} days; conversations
            and the audit trail are kept. This app is an assistant, not your document
            management system — a second copy of every client PDF is liability without
            benefit. <b>{retention.dueFiles}</b> file(s) ({mb(retention.dueBytes)}) are past
            retention now.
          </p>
          <button
            onClick={async () => {
              if (!confirm(`Purge ${retention.dueFiles} expired document(s)? This deletes the stored files.`))
                return;
              setBusy(true);
              const res = await fetch('/api/admin/retention', { method: 'POST' });
              const result = await res.json();
              setBusy(false);
              setNote(`Purged ${result.deleted} file(s), freed ${mb(result.freedBytes)}.`);
              load();
            }}
            disabled={busy || retention.dueFiles === 0}
            className={btn}
          >
            {busy ? 'Purging…' : 'Purge expired documents'}
          </button>
        </div>
      ) : null}

      {data.reviews?.length ? (
        <div className={panel}>
          <h2 className="mb-1 text-[15px] font-semibold">Reviews, priced per return</h2>
          <p className="mb-3 text-[13px] text-ink-dim">
            {usd(data.reviewsMonthToDateUsd ?? 0)} this month. Kept separate from chat because it
            answers a different question: chat spend is managed by the cap above, while a review is
            priced per return and the number that matters is what one file costs. A run showing{' '}
            {usd(0)} did no model work — it was blocked on its inputs, or every stage was carried
            forward from the run before it.
          </p>
          <Table
            head={['Return', 'Run', 'Stages', 'Verdict', 'Cost']}
            rows={data.reviews.map((r) => [
              <a
                key="r"
                href={`/reviews/${r.engagementId}/runs/${r.runNumber}`}
                className="no-underline hover:text-accent"
              >
                {r.entity ?? '(engagement removed)'}
                <div className="text-[12px] text-ink-faint">
                  {[r.taxYear ? `TY ${r.taxYear}` : null, new Date(r.createdAt).toLocaleDateString()]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </a>,
              String(r.runNumber),
              `${r.stagesRun}`,
              r.verdict ? VERDICT_WORD[r.verdict] ?? r.verdict : r.status,
              usd(r.usd),
            ])}
            numeric={[1, 2, 4]}
          />
        </div>
      ) : null}

      <div className={panel}>
        <h2 className="mb-3 text-[15px] font-semibold">By person, this month</h2>
        {data.byUser.length ? (
          <Table
            head={['Person', 'API calls', 'Cost']}
            rows={data.byUser.map((u) => [
              <div key="p">
                {u.display_name || u.email}
                <div className="text-[12px] text-ink-faint">{u.email}</div>
              </div>,
              String(u.calls),
              usd(u.usd),
            ])}
            numeric={[1, 2]}
          />
        ) : (
          <div className="py-6 text-center text-ink-faint">No usage yet this month.</div>
        )}
      </div>

      <div className={panel}>
        <h2 className="mb-3 text-[15px] font-semibold">Recent activity</h2>
        {data.recent.length ? (
          <Table
            head={['When', 'Person', 'Kind', 'Tokens', 'Cost']}
            rows={data.recent.map((r) => [
              new Date(r.created_at).toLocaleString(),
              r.email,
              r.purpose,
              r.tokens.toLocaleString(),
              usd(r.usd),
            ])}
            numeric={[3, 4]}
          />
        ) : (
          <div className="py-6 text-center text-ink-faint">Nothing yet.</div>
        )}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- people */

function PeopleTab() {
  const [people, setPeople] = useState<Person[]>([]);
  const [form, setForm] = useState({ displayName: '', email: '', role: 'member' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const rows = await fetch('/api/admin/users').then((x) => (x.ok ? x.json() : []));
    setPeople(rows);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className={panel}>
        <h2 className="mb-1 text-[15px] font-semibold">Add someone</h2>
        <p className="mb-3 text-[13px] text-ink-dim">
          Everyone signs in with Google — there are no passwords. Adding someone here puts
          their work email on the access list; until then Google sign-in is refused.
          Members see only their own chats. Admins also set the house instructions and see costs.
        </p>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setMessage('');
            setBusy(true);
            try {
              const res = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? 'Could not create');
              setForm({ displayName: '', email: '', role: 'member' });
              setMessage('Added — they can now sign in with that Google account.');
              load();
            } catch (err) {
              setMessage((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[180px] flex-1">
              <label className={label}>Name</label>
              <input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                className={field}
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <label className={label}>Email</label>
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className={field}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[140px] flex-1">
              <label className={label}>Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className={field}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button type="submit" disabled={busy} className={btnPrimary}>
              Create account
            </button>
            {message ? <span className="text-[13px] text-ink-dim">{message}</span> : null}
          </div>
        </form>
      </div>

      <div className={panel}>
        <h2 className="mb-3 text-[15px] font-semibold">People</h2>
        <Table
          head={['Name', 'Email', 'Role', 'Status', '']}
          rows={people.map((u) => [
            u.display_name,
            u.email,
            u.role === 'admin' ? 'Admin' : 'Member',
            u.is_active ? 'Active' : 'Deactivated',
            <button
              key="a"
              onClick={async () => {
                const res = await fetch(`/api/admin/users/${u.id}/active`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ active: !u.is_active }),
                });
                if (!res.ok) {
                  const d = await res.json().catch(() => ({}));
                  alert(d.error ?? 'Could not change');
                  return;
                }
                load();
              }}
              className={btnSm}
            >
              {u.is_active ? 'Deactivate' : 'Reactivate'}
            </button>,
          ])}
          numeric={[4]}
        />
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- table */

function Table({
  head,
  rows,
  numeric = [],
}: {
  head: string[];
  rows: React.ReactNode[][];
  numeric?: number[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className={`border-b border-line-soft px-2.5 py-2 text-[12px] font-semibold text-ink-faint ${
                  numeric.includes(i) ? 'text-right' : 'text-left'
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={`border-b border-line-soft px-2.5 py-2 ${
                    numeric.includes(c) ? 'text-right tabular-nums' : 'text-left'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------- audit log */

interface AuditEntry {
  id: string;
  at: number;
  action: string;
  actor: string | null;
  target: string | null;
  detail: string | null;
}

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<{ action: string; count: number }[]>([]);
  const [filter, setFilter] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (action: string, before = 0, append = false) => {
    setBusy(true);
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (before) params.set('before', String(before));
    const res = await fetch(`/api/admin/audit?${params}`);
    if (res.ok) {
      const data = await res.json();
      setEntries((prev) => (append ? [...prev, ...data.entries] : data.entries));
      setActions(data.actions);
      setHasMore(data.hasMore);
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    load(filter);
  }, [load, filter]);

  return (
    <div>
      <div className={panel}>
        <h2 className="mb-1 text-[15px] font-semibold">Audit log</h2>
        <p className="mb-3 text-[13px] text-ink-dim">
          Who did what, and when. Append-only: nothing in this app edits or deletes a
          row here, which is what makes it worth having. Uploads, deletions, access
          changes and instruction edits are all recorded.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setFilter('')}
            className={`${btnSm} ${filter === '' ? 'border-accent text-ink' : 'text-ink-dim'}`}
          >
            Everything
          </button>
          {actions.map((a) => (
            <button
              key={a.action}
              onClick={() => setFilter(a.action)}
              className={`${btnSm} ${filter === a.action ? 'border-accent text-ink' : 'text-ink-dim'}`}
            >
              {a.action}
              <span className="ml-1.5 text-ink-faint">{a.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={panel}>
        <Table
          head={['When', 'Who', 'Action', 'Target', 'Detail']}
          rows={entries.map((e) => [
            new Date(e.at).toLocaleString(),
            e.actor ?? <span className="text-ink-faint">system</span>,
            <code key="a" className="font-mono text-[12px]">
              {e.action}
            </code>,
            <span key="t" className="text-ink-dim">
              {e.target ?? '—'}
            </span>,
            <span key="d" className="text-[12px] text-ink-faint">
              {e.detail ?? ''}
            </span>,
          ])}
        />
        {entries.length === 0 && !busy ? (
          <div className="py-6 text-center text-[13px] text-ink-faint">Nothing logged yet</div>
        ) : null}
        {hasMore ? (
          <button
            disabled={busy}
            onClick={() => load(filter, entries[entries.length - 1]?.at ?? 0, true)}
            className={`${btn} mt-3`}
          >
            {busy ? 'Loading…' : 'Load more'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
