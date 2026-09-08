'use client';

import { useEffect, useState } from 'react';
import { SkeletonRows } from './ui';

/**
 * Everything this server can be connected to, in one place.
 *
 * There are four surfaces — client books, return data, MCP servers and each
 * person's own accounts — and they are administered in different places by
 * different people. Answering "what can we connect" used to mean visiting all
 * four and inferring the rest, so this lists them together and says, for each,
 * what state it is in and who has to act.
 *
 * Setting anything up is still done where it belongs. This is the inventory,
 * not a second control panel.
 */

type State = 'ready' | 'needs_setup' | 'needs_route' | 'not_built' | 'unavailable';

interface Item {
  id: string;
  label: string;
  how: string;
  state: State;
  detail: string | null;
  redirectUri: string | null;
  envKeys: string[];
  scopes: string[];
  inUse: number;
  needsReconnect: number;
  note: string | null;
}

interface Group {
  id: string;
  title: string;
  blurb: string;
  where: string;
  items: Item[];
}

const BADGE: Record<State, { text: string; className: string }> = {
  ready: { text: 'Ready', className: 'bg-accent/15 text-accent' },
  needs_setup: { text: 'Needs setup', className: 'bg-amber-500/15 text-amber-300' },
  needs_route: { text: 'Needs a route', className: 'bg-amber-500/15 text-amber-300' },
  not_built: { text: 'Not built', className: 'bg-raised text-ink-faint' },
  unavailable: { text: 'Not possible', className: 'bg-raised text-ink-faint' },
};

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        )
      }
      className="group inline-flex max-w-full items-center gap-2 text-left"
      title="Copy"
    >
      <code className="truncate rounded-[6px] bg-raised px-1.5 py-0.5 text-[11.5px] text-ink-dim group-hover:text-ink">
        {value}
      </code>
      <span className="shrink-0 text-[11.5px] text-ink-faint group-hover:text-accent">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}

export function BooksProvidersTab() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/integrations')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setGroups(data.groups as Group[]);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  if (error) return <p role="alert" className="text-[13px] text-rose-400">{error}</p>;
  if (!groups) return <SkeletonRows rows={2} />;

  const ready = groups.flatMap((g) => g.items).filter((i) => i.state === 'ready').length;
  const total = groups.flatMap((g) => g.items).length;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line-soft bg-panel px-5 py-4">
        <h2 className="text-[16px] font-semibold">What we can connect</h2>
        <p className="mt-1 max-w-[700px] text-[13px] text-ink-dim">
          Every system this server can reach, and what each one is waiting for. {ready} of{' '}
          {total} are usable now. Setting one up is still done where it belongs — this is the
          inventory, not a second control panel.
        </p>
      </div>

      {groups.map((group) => (
        <div key={group.id} className="rounded-xl border border-line-soft bg-panel p-5">
          <h3 className="text-[14px] font-semibold">{group.title}</h3>
          <p className="mt-1 max-w-[700px] text-[13px] text-ink-dim">{group.blurb}</p>
          <p className="mt-1 text-[13px] text-ink-faint">{group.where}</p>

          <div className="mt-4 space-y-2.5">
            {group.items.map((item) => (
              <div key={item.id} className="rounded-[9px] border border-line px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium">{item.label}</div>
                    <div className="text-[11.5px] text-ink-faint">
                      {item.how}
                      {item.inUse ? ` · ${item.inUse} in use` : ''}
                      {item.needsReconnect
                        ? ` · ${item.needsReconnect} needs reconnecting`
                        : ''}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-[6px] px-2 py-0.5 text-[11.5px] ${
                      BADGE[item.state].className
                    }`}
                  >
                    {BADGE[item.state].text}
                  </span>
                </div>

                {(item.detail || item.redirectUri || item.envKeys.length) && (
                  <div className="mt-2.5 border-t border-line-soft pt-2.5">
                    {item.detail && (
                      <p className="text-[13px] text-ink-dim">{item.detail}</p>
                    )}

                    {/*
                      Only shown where it is still needed. A provider already
                      registered does not need its redirect URL quoted back.
                    */}
                    {item.state === 'needs_setup' && item.redirectUri && (
                      <div className="mt-2 flex flex-wrap items-baseline gap-2">
                        <span className="w-[110px] shrink-0 text-[11.5px] text-ink-faint">
                          Redirect URI
                        </span>
                        <Copyable value={item.redirectUri} />
                      </div>
                    )}
                    {item.state === 'needs_setup' && item.envKeys.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
                        <span className="w-[110px] shrink-0 text-[11.5px] text-ink-faint">
                          Environment
                        </span>
                        <code className="text-[11.5px] text-ink-dim">
                          {item.envKeys.join('  ·  ')}
                        </code>
                      </div>
                    )}
                    {item.scopes.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
                        <span className="w-[110px] shrink-0 text-[11.5px] text-ink-faint">
                          Scopes
                        </span>
                        <code className="text-[11.5px] text-ink-dim">
                          {item.scopes.join('  ·  ')}
                        </code>
                      </div>
                    )}

                    {item.note && (
                      <p className="mt-2 text-[11.5px] text-ink-faint">{item.note}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
