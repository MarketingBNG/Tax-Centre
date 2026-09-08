'use client';

import { page } from '../ui-classes';
import { useCallback, useEffect, useState } from 'react';
import { SkeletonRows } from '../ui';

/**
 * Loading and reading the authority corpus.
 *
 * The paste box is the whole point of this screen. What a review may cite is
 * what the firm has loaded and holds the rights to, and until now that could
 * only be done by posting JSON at the API — which meant in practice it was
 * never going to be done at all.
 *
 * Two things are surfaced rather than hidden. A source with no effective date
 * is refused, because authority that cannot be shown to have been in force for
 * the year under review is not authority for it. And if the corpus flag is off,
 * that is stated plainly: loaded content with the flag off leaves every
 * citation demoted, which otherwise looks like the loading silently failed.
 */

const KINDS: { value: string; label: string }[] = [
  { value: 'form_instructions', label: 'Form instructions' },
  { value: 'irs_pub', label: 'IRS publication' },
  { value: 'firm_sop', label: "The firm's own SOP" },
  { value: 'irc', label: 'Internal Revenue Code' },
  { value: 'treas_reg', label: 'Treasury regulation' },
  { value: 'india_act', label: 'Indian legislation' },
  { value: 'other', label: 'Other' },
];

interface SourceRow {
  id: string;
  kind: string;
  title: string;
  citationRoot: string | null;
  versionLabel: string | null;
  effectiveFrom: number;
  effectiveTo: number | null;
  retrievedAt: number | null;
  sourceUrl: string | null;
  contentHash: string;
}

const day = (ms: number | null) => (ms === null ? null : new Date(Number(ms)).toISOString().slice(0, 10));

/**
 * Splits pasted text into passages.
 *
 * One heading line per passage, `## IRC 162(a)`, and the text under it is what
 * may be quoted. The citation has to be written by a person because it is what
 * a finding will carry onto the workpaper — guessing it from the body text
 * would put a plausible reference on a passage nobody checked.
 */
export function parsePassages(text: string): { citation: string; body: string }[] {
  const out: { citation: string; body: string }[] = [];
  let current: { citation: string; body: string[] } | null = null;

  for (const line of text.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) out.push({ citation: current.citation, body: current.body.join('\n').trim() });
      current = { citation: heading[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push({ citation: current.citation, body: current.body.join('\n').trim() });

  return out.filter((p) => p.citation && p.body);
}

export function CorpusPanel() {
  const [state, setState] = useState<{
    enabled: boolean;
    fingerprint: string;
    inForce: number;
    sources: SourceRow[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [kind, setKind] = useState('form_instructions');
  const [title, setTitle] = useState('');
  const [citationRoot, setCitationRoot] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [text, setText] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/corpus');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setState(data);
  }, []);

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  const passages = parsePassages(text);

  async function submit() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch('/api/admin/corpus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          title: title.trim(),
          citationRoot: citationRoot.trim() || undefined,
          versionLabel: versionLabel.trim() || null,
          effectiveFrom: effectiveFrom || null,
          effectiveTo: effectiveTo || null,
          sourceUrl: sourceUrl.trim() || null,
          passages,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      setNote(
        `Loaded ${data.passages} passage${data.passages === 1 ? '' : 's'}.` +
          (data.note ? ` ${data.note}` : ''),
      );
      setText('');
      setTitle('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = title.trim() && effectiveFrom && passages.length > 0 && !busy;

  return (
    <div className={page.wide}>
      <header className="mb-6">
        <h1 className="text-[21px] font-semibold tracking-tight">The citation library</h1>
        <p className="mt-1 max-w-[640px] text-[13px] text-ink-dim">
          A review may only cite text loaded here, and must quote the words it relies on. Both
          halves are checked: that the citation is in the library and was in force for the year
          under review, and that the quoted words really appear in the passage. A real section
          attached to words it does not contain is refused too.
        </p>
      </header>

      {state && (
        <div
          className={`mb-5 rounded-lg border px-3 py-2 text-[13px] ${
            state.enabled
              ? 'border-line bg-raised text-ink-dim'
              : 'border-sev-high/40 bg-sev-high/10 text-sev-high'
          }`}
        >
          {state.enabled ? (
            <>
              Grounding is on. {state.inForce} source{state.inForce === 1 ? '' : 's'} in force
              today · corpus fingerprint{' '}
              <span className="font-mono text-[11.5px]">{state.fingerprint}</span>
            </>
          ) : (
            <>
              CITATION_CORPUS_ENABLED is off, so every citation is still demoted to &ldquo;needs
              verifying&rdquo; however much is loaded here. Set it to true to let a verified
              citation be recorded as authority.
            </>
          )}
        </div>
      )}

      <section className="mb-5 rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="text-[14px] font-medium">Load a source</h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-[11.5px] text-ink-faint">
            Kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="mt-1 block w-full rounded-[6px] border border-line bg-raised px-2 py-1.5 text-[13px] text-ink"
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-[11.5px] text-ink-faint">
            Title — this is what appears on the workpaper
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="2025 Instructions for Form 1065"
              className="mt-1 block w-full rounded-[6px] border border-line bg-raised px-2 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="text-[11.5px] text-ink-faint">
            In force from — required
            <input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className="mt-1 block w-full rounded-[6px] border border-line bg-raised px-2 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="text-[11.5px] text-ink-faint">
            In force until — leave blank if it still is
            <input
              type="date"
              value={effectiveTo}
              onChange={(e) => setEffectiveTo(e.target.value)}
              className="mt-1 block w-full rounded-[6px] border border-line bg-raised px-2 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="text-[11.5px] text-ink-faint">
            Citation root — optional, e.g. IRC or Form 1065
            <input
              value={citationRoot}
              onChange={(e) => setCitationRoot(e.target.value)}
              className="mt-1 block w-full rounded-[6px] border border-line bg-raised px-2 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="text-[11.5px] text-ink-faint">
            Version label — optional, e.g. Rev. Jan 2025
            <input
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
              className="mt-1 block w-full rounded-[6px] border border-line bg-raised px-2 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="text-[11.5px] text-ink-faint sm:col-span-2">
            Where it came from — optional
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://www.irs.gov/…"
              className="mt-1 block w-full rounded-[6px] border border-line bg-raised px-2 py-1.5 text-[13px] text-ink"
            />
          </label>
        </div>

        <div className="mt-4">
          <label className="text-[11.5px] text-ink-faint">
            The text. Start each passage with a heading line holding its citation:
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              spellCheck={false}
              placeholder={
                '## IRC 162(a)\nThere shall be allowed as a deduction all the ordinary and necessary ' +
                'expenses paid or incurred during the taxable year in carrying on any trade or business…\n\n' +
                '## IRC 274(n)\nThe amount allowable as a deduction … shall not exceed 50 percent of ' +
                'the amount of such expense or item.'
              }
              className="mt-1 block w-full rounded-[6px] border border-line bg-raised px-2 py-2 font-mono text-[11.5px] text-ink"
            />
          </label>
          <div className="mt-1.5 text-[11.5px] text-ink-faint">
            {passages.length === 0
              ? 'No passages read yet — each one needs a heading line for its citation, and text under it.'
              : `${passages.length} passage${passages.length === 1 ? '' : 's'}: ${passages
                  .slice(0, 6)
                  .map((p) => p.citation)
                  .join(', ')}${passages.length > 6 ? ', …' : ''}`}
          </div>
        </div>

        <button
          type="button"
          disabled={!ready}
          onClick={submit}
          className={`mt-4 rounded-[9px] px-3.5 py-1.5 text-[13px] font-medium ${
            ready
              ? 'bg-accent text-accent-ink hover:bg-accent-hover'
              : 'border border-line text-ink-faint'
          }`}
        >
          {busy ? 'Loading…' : 'Load into the library'}
        </button>

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
        <h2 className="mb-3 text-[14px] font-medium">What is loaded</h2>

        {!state && !error && <SkeletonRows rows={3} />}
        {state?.sources.length === 0 && (
          <div className="text-[13px] text-ink-faint">
            Nothing is loaded, so nothing can be cited at all. That is the correct behaviour rather
            than a fault: a review states the principle in plain English and marks it &ldquo;needs
            verifying&rdquo;.
          </div>
        )}

        <ul className="space-y-1.5">
          {state?.sources.map((source) => (
            <li
              key={source.id}
              className="rounded-lg border border-line-soft px-3 py-2 text-[13px]"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink">{source.title}</span>
                <span className="shrink-0 text-[11.5px] text-ink-faint">
                  {KINDS.find((k) => k.value === source.kind)?.label ?? source.kind}
                </span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-ink-faint">
                In force {day(source.effectiveFrom)}
                {source.effectiveTo ? ` to ${day(source.effectiveTo)}` : ' onwards'}
                {source.citationRoot ? ` · cites under ${source.citationRoot}` : ''}
                {source.versionLabel ? ` · ${source.versionLabel}` : ''}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
