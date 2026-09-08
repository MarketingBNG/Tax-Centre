'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from './ui';

interface Tool {
  name: string;
  title?: string;
  description?: string;
  readOnly?: boolean;
}

interface Connector {
  id: string;
  name: string;
  url: string;
  authHeader: string | null;
  hasSecret: boolean;
  enabled: boolean;
  approved: string[];
  tools: Tool[];
  toolsFetchedAt: number | null;
  lastError: string | null;
}

const field =
  'w-full rounded-[9px] border border-line bg-panel px-3 py-2 outline-none focus:border-[#55534c]';
const btn =
  'rounded-[9px] border border-line bg-raised px-4 py-2 font-medium hover:bg-raised-hover disabled:opacity-50';
const btnPrimary =
  'rounded-[9px] bg-accent px-4 py-2 font-medium text-accent-ink hover:bg-accent-hover disabled:opacity-50';
const btnSm = 'rounded-md border border-line px-2.5 py-1 text-[13px] hover:bg-raised';
const panel = 'mb-4 rounded-xl border border-line bg-panel p-5';
const label = 'mb-1.5 mt-3 block text-[13px] text-ink-dim';

/**
 * Connectors: remote MCP servers whose tools the model may call.
 *
 * Two deliberate frictions live in this screen. Nothing a server offers is
 * available to the model until it is ticked here, so adding a connector by
 * itself grants nothing; and no conversation uses one until it is switched on
 * in that thread. Between them they make reaching an outside system something
 * somebody chose twice, rather than a default.
 */
export function ConnectorsTab() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [globallyEnabled, setGloballyEnabled] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('Authorization');
  const [authValue, setAuthValue] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/connectors');
    if (!res.ok) return;
    const data = await res.json();
    setConnectors(data.connectors);
    setGloballyEnabled(data.connectorsEnabled);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    const res = await fetch(`/api/admin/connectors/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) setNote((await res.json().catch(() => ({}))).error ?? 'Could not save.');
    setBusy(null);
    await load();
  }

  async function refresh(id: string) {
    setBusy(id);
    setNote(null);
    const res = await fetch(`/api/admin/connectors/${id}/refresh`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    setNote(
      data.error
        ? `Could not reach it: ${data.error}`
        : `Found ${data.tools?.length ?? 0} tool(s). Tick the ones this firm should use.`,
    );
    setBusy(null);
    setOpen(id);
    await load();
  }

  const { ask, confirmDialog } = useConfirm();

  return (
    <div>
      {confirmDialog}
      <div className={panel}>
        <h2 className="mb-1 text-[16px] font-semibold">Connectors</h2>
        <p className="mb-3 text-[13px] text-ink-dim">
          An MCP server whose tools the assistant may call — a document store, a
          practice system, an internal API. Adding one grants nothing on its own:
          you tick the individual tools here, and each person switches the
          connector on for the conversations where they want it.
        </p>
        <p className="mb-3 text-[13px] text-ink-dim">
          <b>Think about this alongside uploaded documents.</b> A conversation that
          holds a client return and can also reach an outside system is the shape of
          an exfiltration path: text inside a document can try to talk the model into
          sending something out. The assistant is told never to send document
          contents through a connector unless asked, and every call is in the audit
          log — but the safest connectors are the ones that only read, and the safest
          time to use one is in a thread with no client documents in it.
        </p>
        {!globallyEnabled ? (
          <div className="rounded-lg border border-sev-math/35 bg-sev-math/10 px-3 py-2 text-[13px] text-[#dcc79a]">
            CONNECTORS_ENABLED is false in the environment, so none of these are in
            play regardless of what is configured here.
          </div>
        ) : null}
        {note ? <div className="mt-2 text-[13px] text-ink-dim">{note}</div> : null}
      </div>

      {connectors.map((c) => (
        <div key={c.id} className={panel}>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex-1">
              <div className="flex items-center gap-2 text-[16px] font-semibold">
                {c.name}
                {!c.enabled ? (
                  <span className="rounded border border-line px-1.5 py-0.5 text-[11.5px] font-normal text-ink-faint">
                    off
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 font-mono text-[13px] text-ink-faint">{c.url}</div>
            </div>
            <span className="text-[13px] text-ink-dim">
              {c.approved.length} of {c.tools.length} tools approved
            </span>
            <button className={btnSm} disabled={busy === c.id} onClick={() => refresh(c.id)}>
              {busy === c.id ? 'Checking…' : c.tools.length ? 'Refresh' : 'Connect'}
            </button>
            <button className={btnSm} onClick={() => setOpen(open === c.id ? null : c.id)}>
              {open === c.id ? 'Close' : 'Tools'}
            </button>
            <button className={btnSm} onClick={() => patch(c.id, { enabled: !c.enabled })}>
              {c.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className={`${btnSm} hover:text-sev-blocking`}
              onClick={() =>
                ask({
                  title: `Delete the "${c.name}" connector?`,
                  body: 'Every chat that had it switched on loses those tools. This cannot be undone.',
                  confirmLabel: 'Delete',
                  destructive: true,
                  onConfirm: async () => {
                    await fetch(`/api/admin/connectors/${c.id}`, { method: 'DELETE' });
                    load();
                  },
                })
              }
            >
              Delete
            </button>
          </div>

          {c.lastError ? (
            <div role="alert" className="mt-2.5 rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[13px] text-[#e8b0b0]">
              Last attempt failed: {c.lastError}
            </div>
          ) : null}

          {open === c.id ? (
            <div className="mt-3 border-t border-line-soft pt-3">
              {c.tools.length === 0 ? (
                <p className="text-[13px] text-ink-dim">
                  Nothing discovered yet. Press Connect to ask the server what it offers.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {c.tools.map((t) => {
                    const on = c.approved.includes(t.name);
                    return (
                      <label
                        key={t.name}
                        className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-raised"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          className="mt-1"
                          onChange={() =>
                            patch(c.id, {
                              allowedTools: on
                                ? c.approved.filter((n) => n !== t.name)
                                : [...c.approved, t.name],
                            })
                          }
                        />
                        <span className="flex-1">
                          <span className="flex items-center gap-2 text-[13px] font-medium">
                            {t.title ?? t.name}
                            {t.readOnly ? (
                              <span className="rounded border border-line px-1 text-[11.5px] font-normal text-ink-faint">
                                read only
                              </span>
                            ) : (
                              <span className="rounded border border-sev-math/40 px-1 text-[11.5px] font-normal text-[#dcc79a]">
                                may write
                              </span>
                            )}
                          </span>
                          <span className="block font-mono text-[11.5px] text-ink-faint">
                            {t.name}
                          </span>
                          {t.description ? (
                            <span className="mt-0.5 block text-[13px] text-ink-dim">
                              {t.description.slice(0, 220)}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 border-t border-line-soft pt-3">
                <label className={label}>Credential header</label>
                <div className="flex flex-wrap items-end gap-2.5">
                  <input
                    defaultValue={c.authHeader ?? ''}
                    placeholder="Authorization"
                    className={`${field} w-[200px]`}
                    onBlur={(e) => patch(c.id, { authHeader: e.target.value })}
                  />
                  <input
                    type="password"
                    placeholder={c.hasSecret ? 'stored — type to replace' : 'Bearer …'}
                    className={`${field} w-full sm:w-[280px]`}
                    onBlur={(e) => {
                      if (e.target.value) {
                        patch(c.id, { authValue: e.target.value });
                        e.target.value = '';
                      }
                    }}
                  />
                  <span className="pb-2 text-[13px] text-ink-faint">
                    {c.hasSecret ? 'A secret is set. It is never shown again.' : 'No secret set.'}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ))}

      <div className={panel}>
        <h2 className="mb-1 text-[16px] font-semibold">Add a connector</h2>
        <p className="text-[13px] text-ink-dim">
          The URL of an MCP server speaking Streamable HTTP. Servers that require an
          OAuth sign-in are not supported yet — this takes a static credential sent as
          a header.
        </p>

        <label className={label}>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Practice document store"
          className={field}
        />

        <label className={label}>URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.example.com/mcp"
          className={field}
        />

        <div className="flex flex-wrap gap-3">
          <div className="w-[220px]">
            <label className={label}>Credential header (optional)</label>
            <input
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value)}
              className={field}
            />
          </div>
          <div className="w-full sm:w-[320px]">
            <label className={label}>Value (optional)</label>
            <input
              type="password"
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              placeholder="Bearer …"
              className={field}
            />
          </div>
        </div>

        <button
          className={`${btnPrimary} mt-4`}
          disabled={!name.trim() || !url.trim() || busy === 'new'}
          onClick={async () => {
            setBusy('new');
            setNote(null);
            const res = await fetch('/api/admin/connectors', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                url,
                authHeader: authValue ? authHeader : null,
                authValue: authValue || null,
              }),
            });
            const data = await res.json().catch(() => ({}));
            setBusy(null);
            if (!res.ok) {
              setNote(data.error ?? 'Could not add it.');
              return;
            }
            setName('');
            setUrl('');
            setAuthValue('');
            await load();
            await refresh(data.id);
          }}
        >
          Add and connect
        </button>
      </div>

      <div className={panel}>
        <h2 className="mb-1 text-[16px] font-semibold">What is recorded</h2>
        <p className="text-[13px] text-ink-dim">
          Every call the model makes through a connector is written to the audit log
          with who caused it, which tool, and the arguments — see the Audit log tab and
          filter on <code className="font-mono text-[13px]">connector.call</code>.
          Approving or removing a tool is logged too. Credentials never are.
        </p>
      </div>
    </div>
  );
}
