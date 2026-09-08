'use client';

import { useCallback, useEffect, useState } from 'react';
import { SkeletonRows, btn } from '../ui';

/**
 * The client's own accounting systems, and how to connect them.
 *
 * Three states, shown differently because each needs a different person to act:
 *
 *   not set up  — the firm has not registered the developer app. An admin does
 *                 that once, for every client at once, so the panel shows the
 *                 steps and the exact redirect URL rather than a dead button.
 *   available   — registered, this client has not authorised it yet.
 *   connected   — usable, unless the grant has since been withdrawn.
 *
 * A withdrawn grant is shown rather than hidden. It fails at import time
 * otherwise, months later, with nothing on screen explaining why.
 */

interface ConnectionRow {
  id: string;
  company: string;
  externalId: string;
  region: string | null;
  connectedAt: number;
  revoked: boolean;
  lastError: string | null;
}

interface ProviderRow {
  id: string;
  label: string;
  configured: boolean;
  setupHint: string | null;
  needsRegion: boolean;
  connections: ConnectionRow[];
}

/** Zoho only. An account on one data centre cannot be read from another. */
const ZOHO_REGIONS = [
  { value: 'in', label: 'India (zoho.in)' },
  { value: 'com', label: 'United States (zoho.com)' },
  { value: 'eu', label: 'Europe (zoho.eu)' },
  { value: 'com.au', label: 'Australia (zoho.com.au)' },
];

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function BooksConnections({
  engagementId,
  isAdmin,
}: {
  engagementId: string;
  isAdmin: boolean;
}) {
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ provider: string; text: string } | null>(null);
  const [zohoRegion, setZohoRegion] = useState('in');

  const load = useCallback(async () => {
    const res = await fetch(`/api/engagements/${engagementId}/books/connections`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setProviders(data.providers as ProviderRow[]);
  }, [engagementId]);

  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
  }, [load]);

  /*
   * The vendor sends the browser back here with a message on the query string,
   * because the callback is reached by a person rather than by code. Read it
   * once and clear it, so a refresh does not keep reporting a stale result.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('books_connected');
    const failed = params.get('books_error');
    if (!connected && !failed) return;

    if (connected) setNote(`Connected: ${connected}`);
    if (failed) setError(failed);

    params.delete('books_connected');
    params.delete('books_error');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (query ? `?${query}` : ''),
    );
  }, []);

  function connect(provider: ProviderRow) {
    const params = new URLSearchParams({ engagement: engagementId });
    if (provider.needsRegion) params.set('region', zohoRegion);
    // A full navigation, not fetch: the next stop is the vendor's own consent
    // screen and the person has to see it.
    window.location.href = `/api/books/${provider.id}/start?${params}`;
  }

  async function act(connectionId: string, action: 'disconnect' | 'probe') {
    setBusy(connectionId);
    setError(null);
    setNote(null);
    setProbe(null);
    try {
      const res = await fetch(`/api/engagements/${engagementId}/books/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, connectionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      if (action === 'disconnect') {
        setNote('Disconnected. The stored tokens are deleted here.');
        await load();
      } else if (data.ok) {
        setProbe({ provider: connectionId, text: data.report as string });
      } else {
        setError(data.error as string);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error && !providers) {
    return <p role="alert" className="text-[13px] text-rose-400">{error}</p>;
  }
  if (!providers) {
    return <SkeletonRows rows={2} />;
  }

  return (
    <section className="mb-5 rounded-xl border border-line-soft bg-panel p-4">
      <h2 className="text-[14px] font-medium">Connect the client&apos;s books</h2>
      <p className="mt-1 max-w-[640px] text-[13px] text-ink-faint">
        Read the trial balance from the client&apos;s own system instead of asking them to
        export one. Read-only. The client authorises this on their provider&apos;s own screen,
        and the grant is stored against the client rather than against whoever connected it, so
        it keeps working when the file changes hands.
      </p>

      {note && <p className="mt-3 text-[13px] text-accent">{note}</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-rose-400">{error}</p>}

      <div className="mt-4 space-y-3">
        {providers.map((provider) => (
          <div
            key={provider.id}
            className="rounded-[9px] border border-line bg-raised px-3.5 py-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium">{provider.label}</div>
                <div className="text-[11.5px] text-ink-faint">
                  {provider.configured
                    ? provider.connections.length
                      ? `${provider.connections.length} connected`
                      : 'Not connected for this client'
                    : 'Not set up on this server'}
                </div>
              </div>

              {provider.configured ? (
                <div className="flex items-center gap-2">
                  {provider.needsRegion && (
                    <select
                      value={zohoRegion}
                      onChange={(e) => setZohoRegion(e.target.value)}
                      className="rounded-[6px] border border-line bg-panel px-2 py-1 text-[13px] text-ink"
                      title="An account on one Zoho data centre cannot be read from another."
                    >
                      {ZOHO_REGIONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => connect(provider)}
                    className={btn('quiet')}
                  >
                    {provider.connections.length ? 'Connect another' : 'Connect'}
                  </button>
                </div>
              ) : (
                <span className="text-[13px] text-ink-faint">Unavailable</span>
              )}
            </div>

            {/*
              An unregistered provider explains itself rather than showing a
              button that cannot work. The redirect URL is given exactly,
              because it has to match what is registered byte for byte.
            */}
            {!provider.configured && provider.setupHint && (
              <div className="mt-3 border-t border-line-soft pt-3">
                <p className="text-[13px] text-ink-dim">{provider.setupHint}</p>
                <p className="mt-1.5 text-[11.5px] text-ink-faint">
                  Redirect URI to register:{' '}
                  <code className="text-ink-dim">
                    {typeof window === 'undefined'
                      ? ''
                      : `${window.location.origin}/api/books/${provider.id}/callback`}
                  </code>
                </p>
              </div>
            )}

            {provider.connections.map((conn) => (
              <div
                key={conn.id}
                className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-3"
              >
                <div>
                  <div className="text-[13px] text-ink">
                    {conn.company}
                    {conn.revoked && (
                      <span className="ml-2 rounded-[6px] bg-rose-500/15 px-1.5 py-0.5 text-[11.5px] text-rose-300">
                        needs reconnecting
                      </span>
                    )}
                  </div>
                  <div className="text-[11.5px] text-ink-faint">
                    Connected {day(conn.connectedAt)}
                    {conn.region ? ` · zoho.${conn.region}` : ''}
                  </div>
                  {conn.revoked && conn.lastError && (
                    <div className="mt-1 max-w-[560px] text-[11.5px] text-ink-faint">
                      {conn.lastError}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {/*
                    The probe returns raw client financial data and exists only
                    because the report parsers are written from what a vendor
                    really sends. Admins only, and it should not outlive the
                    parsers.
                  */}
                  {isAdmin && !conn.revoked && (
                    <button
                      type="button"
                      disabled={busy === conn.id}
                      onClick={() => act(conn.id, 'probe')}
                      className={btn('quiet','sm')}
                      title="Fetch the trial balance and show the shape of the response."
                    >
                      {busy === conn.id ? 'Probing…' : 'Probe'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy === conn.id}
                    onClick={() => act(conn.id, 'disconnect')}
                    className={btn('danger','sm')}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {probe && (
        <div className="mt-4 rounded-[9px] border border-line bg-raised p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] text-ink-dim">What the provider returned</span>
            <button
              type="button"
              onClick={() => setProbe(null)}
              className="text-[13px] text-ink-faint hover:text-ink"
            >
              Close
            </button>
          </div>
          <pre className="max-h-[380px] overflow-auto whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-ink-dim">
            {probe.text}
          </pre>
        </div>
      )}

      <p className="mt-4 text-[11.5px] text-ink-faint">
        Disconnecting deletes the stored tokens here. To withdraw the grant at the provider as
        well, the client removes this app from their own account settings.
      </p>
    </section>
  );
}
