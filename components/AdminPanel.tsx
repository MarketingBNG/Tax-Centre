'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Mark } from './Mark';

type Tab = 'skills' | 'costs' | 'people';

interface Skill {
  id: string;
  title: string;
  description: string;
  jurisdiction: string;
  body: string;
  source_filename: string | null;
  version: number;
  enabled: number;
  token_estimate: number;
}

interface Costs {
  monthToDateUsd: number;
  capUsd: number;
  byUser: { email: string; display_name: string; calls: number; usd: number }[];
  recent: {
    id: string;
    created_at: number;
    status: string;
    extraction_ok: number;
    email: string;
    findings: number;
    usd: number;
  }[];
  cacheHitRate: number;
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
  const [tab, setTab] = useState<Tab>('skills');

  return (
    <div className="mx-auto max-w-[1000px] px-6 pt-7 pb-16">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-[21px] font-medium">
          <Mark size={20} />
          Skills &amp; admin
        </h1>
        <Link href="/" className={btn}>
          ← Back to reviews
        </Link>
      </div>

      <div className="mb-5 flex gap-1 border-b border-line-soft">
        {(
          [
            ['skills', 'Review skills'],
            ['costs', 'Usage & cost'],
            ['people', 'People'],
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

      {tab === 'skills' ? <SkillsTab /> : null}
      {tab === 'costs' ? <CostsTab /> : null}
      {tab === 'people' ? <PeopleTab /> : null}
    </div>
  );
}

/* --------------------------------------------------------------- skills */

function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bundleTokens, setBundleTokens] = useState(0);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [jurisdiction, setJurisdiction] = useState('generic');
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/skills');
    if (!res.ok) return;
    const data = await res.json();
    setSkills(data.skills);
    setBundleTokens(data.bundleTokens);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function publish(e: React.FormEvent) {
    e.preventDefault();
    setMessage('');
    if (!file && !body.trim()) {
      setMessage('Upload a document or paste some text.');
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('title', title.trim() || file?.name || 'Untitled skill');
      form.append('description', description.trim());
      form.append('jurisdiction', jurisdiction);
      if (body.trim()) form.append('body', body.trim());
      if (file) form.append('file', file);

      const res = await fetch('/api/admin/skills', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not publish');

      setTitle('');
      setDescription('');
      setBody('');
      setFile(null);
      setMessage('Published — it is now loaded into every review.');
      load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <>
      <div className={panel}>
        <h2 className="mb-1 text-[15px] font-semibold">Add a review skill</h2>
        <p className="mb-3 text-[13px] text-ink-dim">
          Upload your checklist, SOP or methodology, or paste it in. Every enabled skill is
          loaded into <em>every</em> review your team runs — they just attach files. Upload
          accepts DOCX, XLSX, CSV or TXT; a scanned PDF has no text layer to read.
        </p>

        <form onSubmit={publish}>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[200px] flex-1">
              <label className={label}>Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. 1120-S review checklist"
                className={field}
              />
            </div>
            <div className="min-w-[160px] flex-1">
              <label className={label}>Applies to</label>
              <select
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
                className={field}
              >
                <option value="generic">All reviews</option>
                <option value="us-federal">US federal</option>
                <option value="us-state">US state</option>
                <option value="india">India</option>
              </select>
            </div>
          </div>

          <label className={label}>Short description (optional)</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this skill covers"
            className={field}
          />

          <label className={label}>Upload a document</label>
          <input
            type="file"
            accept=".docx,.xlsx,.xlsm,.csv,.txt,.md"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-[13px]"
          />

          <label className={label}>…or paste the text</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              'Review the return in this order:\n1. Tie Schedule K to the K-1s\n2. Confirm officer compensation is reasonable relative to distributions'
            }
            className={`${field} min-h-[130px] resize-y font-mono text-[12.5px]`}
          />

          <div className="mt-4 flex items-center gap-3">
            <button type="submit" disabled={busy} className={btnPrimary}>
              {busy ? 'Publishing…' : 'Publish skill'}
            </button>
            {message ? <span className="text-[13px] text-ink-dim">{message}</span> : null}
          </div>
        </form>
      </div>

      <div className={panel}>
        <h2 className="mb-1 text-[15px] font-semibold">Published skills</h2>
        <p className="mb-4 text-[13px] text-ink-dim">
          {skills.length
            ? `${enabledCount} of ${skills.length} enabled · roughly ${bundleTokens.toLocaleString()} tokens loaded into every review.`
            : 'Nothing published yet — reviews fall back to general professional judgement.'}
        </p>

        {skills.map((s) => (
          <SkillCard key={s.id} skill={s} onChange={load} />
        ))}
      </div>
    </>
  );
}

function SkillCard({ skill, onChange }: { skill: Skill; onChange: () => void }) {
  const [draft, setDraft] = useState(skill.body);
  const [busy, setBusy] = useState(false);

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/admin/skills/${skill.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    onChange();
  }

  return (
    <div className="mb-3 rounded-[10px] border border-line px-4 py-3">
      <div className="mb-1.5 flex items-center gap-2.5">
        <b className="flex-1">{skill.title}</b>
        <span className="text-[12px] text-ink-faint">
          v{skill.version} · {skill.jurisdiction} · ~{skill.token_estimate.toLocaleString()} tok
        </span>
      </div>

      {skill.description ? (
        <div className="mb-2 text-[13px] text-ink-dim">{skill.description}</div>
      ) : null}
      {skill.source_filename ? (
        <div className="mb-2 text-[12px] text-ink-faint">from {skill.source_filename}</div>
      ) : null}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className={`${field} min-h-[100px] resize-y font-mono text-[12.5px]`}
      />

      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => patch({ enabled: !skill.enabled })}
          disabled={busy}
          className={
            skill.enabled
              ? 'rounded-md bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-ink'
              : btnSm
          }
        >
          {skill.enabled ? 'Enabled' : 'Disabled'}
        </button>
        <button
          onClick={() => patch({ body: draft })}
          disabled={busy || draft === skill.body}
          className={btnSm}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button
          onClick={async () => {
            if (!confirm(`Delete "${skill.title}"? Reviews already run keep their record of it.`))
              return;
            await fetch(`/api/admin/skills/${skill.id}`, { method: 'DELETE' });
            onChange();
          }}
          className={`${btnSm} text-sev-blocking`}
        >
          Delete
        </button>
      </div>
    </div>
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
            Uploaded originals expire after {retention.retentionDays} days; findings and the
            audit trail are kept. This app is a review assistant, not your document
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
        <h2 className="mb-3 text-[15px] font-semibold">Recent reviews</h2>
        {data.recent.length ? (
          <Table
            head={['When', 'Person', 'Status', 'Findings', 'Cost']}
            rows={data.recent.map((r) => [
              new Date(r.created_at).toLocaleString(),
              r.email,
              r.status === 'complete' && !r.extraction_ok ? 'complete (prose only)' : r.status,
              String(r.findings),
              usd(r.usd),
            ])}
            numeric={[3, 4]}
          />
        ) : (
          <div className="py-6 text-center text-ink-faint">No reviews yet.</div>
        )}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- people */

function PeopleTab() {
  const [people, setPeople] = useState<Person[]>([]);
  const [form, setForm] = useState({ displayName: '', email: '', role: 'reviewer' });
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
          Reviewers see only their own reviews. Admins also publish skills and see costs.
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
              setForm({ displayName: '', email: '', role: 'reviewer' });
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
                <option value="reviewer">Reviewer</option>
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
            u.role === 'admin' ? 'Admin' : 'Reviewer',
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
