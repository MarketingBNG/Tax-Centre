'use client';

import { useEffect, useState } from 'react';

/**
 * Which accounting systems this server can read a client's books from.
 *
 * The registration is a firm-level fact — one developer app per vendor, for
 * every client at once — so it belongs here rather than only inside somebody's
 * engagement. The redirect URL each vendor asks for is shown exactly, because
 * it must match byte for byte and this is the screen an admin is looking at
 * while filling in the vendor's form.
 *
 * Connecting an individual client still happens on that client's books screen,
 * because a grant is authorised by a client and has to be recorded against one.
 */

interface ProviderRow {
  id: string;
  label: string;
  configured: boolean;
  setupHint: string;
  redirectUri: string;
  envKeys: string[];
  scopes: string[];
  connectedClients: number;
  needsReconnect: number;
}

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
      className="group inline-flex max-w-full items-center gap-2 text-left"
      title="Copy"
    >
      <code className="truncate rounded-[5px] bg-raised px-1.5 py-0.5 text-[11.5px] text-ink-dim group-hover:text-ink">
        {value}
      </code>
      <span className="shrink-0 text-[11px] text-ink-faint group-hover:text-accent">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}

export function BooksProvidersTab() {
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/books-providers')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setProviders(data.providers as ProviderRow[]);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  if (error) return <p className="text-[13px] text-rose-400">{error}</p>;
  if (!providers) return <p className="text-[13px] text-ink-faint">Loading…</p>;

  return (
    <div className="rounded-xl border border-line-soft bg-panel p-5">
      <h2 className="mb-1 text-[15px] font-semibold">Client books</h2>
      <p className="mb-2 max-w-[680px] text-[13px] text-ink-dim">
        Read a client&apos;s trial balance from their own accounting system instead of asking
        them to export one. You register <strong>one developer app per vendor</strong>, for the
        whole firm; clients register nothing and simply authorise it against their own company.
      </p>
      <p className="mb-5 max-w-[680px] text-[12.5px] text-ink-faint">
        Leaving a pair of keys unset is fine — that vendor reads as not set up and nothing else
        breaks. Connecting an individual client happens on that client&apos;s books screen,
        because the client is the one who authorises it.
      </p>

      <div className="space-y-3">
        {providers.map((provider) => (
          <div key={provider.id} className="rounded-[10px] border border-line px-4 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-medium">{provider.label}</div>
                <div className="text-[12px] text-ink-faint">
                  {provider.configured ? (
                    <>
                      Registered ·{' '}
                      {provider.connectedClients
                        ? `${provider.connectedClients} client${
                            provider.connectedClients === 1 ? '' : 's'
                          } connected`
                        : 'no clients connected yet'}
                      {provider.needsReconnect
                        ? ` · ${provider.needsReconnect} needs reconnecting`
                        : ''}
                    </>
                  ) : (
                    'Not set up on this server'
                  )}
                </div>
              </div>
              <span
                className={`rounded-[6px] px-2 py-0.5 text-[11.5px] ${
                  provider.configured
                    ? 'bg-accent/15 text-accent'
                    : 'bg-raised text-ink-faint'
                }`}
              >
                {provider.configured ? 'Ready' : 'Unavailable'}
              </span>
            </div>

            <div className="mt-3 border-t border-line-soft pt-3">
              <p className="text-[12.5px] text-ink-dim">{provider.setupHint}</p>

              <dl className="mt-2.5 space-y-1.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <dt className="w-[128px] shrink-0 text-[11.5px] text-ink-faint">
                    Redirect URI
                  </dt>
                  <dd className="min-w-0">
                    <Copyable value={provider.redirectUri} />
                  </dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-2">
                  <dt className="w-[128px] shrink-0 text-[11.5px] text-ink-faint">
                    Environment
                  </dt>
                  <dd className="text-[11.5px] text-ink-dim">
                    <code>{provider.envKeys.join('  ·  ')}</code>
                  </dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-2">
                  <dt className="w-[128px] shrink-0 text-[11.5px] text-ink-faint">Scopes</dt>
                  <dd className="text-[11.5px] text-ink-dim">
                    <code>{provider.scopes.join('  ·  ')}</code>
                  </dd>
                </div>
              </dl>

              {/*
                Said here rather than left to be discovered: Intuit publishes no
                read-only accounting scope, so the restraint is in the code
                rather than in the grant, and an admin approving this should
                know which of the two they are relying on.
              */}
              {provider.id === 'quickbooks' && (
                <p className="mt-2.5 text-[11.5px] text-ink-faint">
                  Intuit publishes no read-only accounting scope. This app never calls an
                  endpoint that writes, but the grant itself is not narrowed — unlike Xero and
                  Zoho, where it is.
                </p>
              )}
              {provider.id === 'zoho' && (
                <p className="mt-2.5 text-[11.5px] text-ink-faint">
                  Register in the data centre the client&apos;s account lives in. Tokens issued
                  on zoho.in are not valid on zoho.com, and sending them to the wrong host fails
                  looking like a credentials problem.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-5 text-[12px] text-ink-faint">
        Tally is not listed. It is desktop software reading a company file on a machine in the
        office, so it is reached by an adapter over the firm&apos;s own read-only MCP server
        rather than by OAuth — and it needs a route from wherever this app runs to that machine.
      </p>
    </div>
  );
}
