'use client';

import { useCallback, useEffect, useState } from 'react';
import { SkillsManager } from './SkillsManager';

interface PickerModel {
  id: string;
  label: string;
  blurb: string;
}

interface PickerStyle {
  id: string;
  name: string;
  blurb: string;
  builtIn: boolean;
}

interface Prefs {
  instructions: string;
  model: string | null;
  style: string | null;
  thinking: string | null;
  memoryEnabled: boolean;
  defaults: { model: string; thinking: string; style: string };
  models: PickerModel[];
  thinkingLevels: { id: string; label: string; blurb: string }[];
  styles: PickerStyle[];
}

interface Account {
  id: string;
  label: string;
  blurb: string;
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  toolCount: number;
  setupHint: string | null;
  redirectUri: string | null;
}

interface Memory {
  id: string;
  text: string;
  createdAt: number;
}

type Tab = 'instructions' | 'defaults' | 'styles' | 'skills' | 'accounts' | 'memory' | 'data';

const TABS: { id: Tab; label: string }[] = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'styles', label: 'Styles' },
  { id: 'skills', label: 'Skills' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'memory', label: 'Memory' },
  { id: 'data', label: 'Your data' },
];

const when = (ms: number) => new Date(ms).toLocaleDateString();

export function SettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [tab, setTab] = useState<Tab>('instructions');
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [instructions, setInstructions] = useState('');
  const [saved, setSaved] = useState(false);

  const [styleName, setStyleName] = useState('');
  const [styleText, setStyleText] = useState('');

  const load = useCallback(async () => {
    const [p, m, a] = await Promise.all([
      fetch('/api/prefs'),
      fetch('/api/memories'),
      fetch('/api/accounts'),
    ]);
    if (p.ok) {
      const data: Prefs = await p.json();
      setPrefs(data);
      setInstructions(data.instructions);
    }
    if (m.ok) setMemories(await m.json());
    if (a.ok) setAccounts(await a.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1400);
        await load();
        onSaved();
      }
    },
    [load, onSaved],
  );

  if (!prefs) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[600px] max-h-full w-full max-w-[760px] overflow-hidden rounded-2xl border border-line bg-canvas"
      >
        <nav className="flex w-44 shrink-0 flex-col gap-px border-r border-line-soft bg-panel p-2.5">
          <div className="px-2.5 pt-1 pb-2.5 text-[15px] font-semibold tracking-tight">Settings</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-2.5 py-1.5 text-left text-[13.5px] ${
                tab === t.id ? 'bg-raised text-ink' : 'text-ink-dim hover:bg-raised hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="mt-auto flex items-center justify-between px-2.5 pt-2 text-[11.5px] text-ink-faint">
            <span>{saved ? 'Saved' : ''}</span>
            <button onClick={onClose} className="hover:text-ink">
              Close
            </button>
          </div>
        </nav>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'instructions' ? (
            <section>
              <h2 className="mb-1 text-[15px] font-semibold">Your instructions</h2>
              <p className="mb-3 text-[13px] text-ink-dim">
                Sent with every message you send, on top of the house instructions an
                admin set. Good for how you want to be answered — your role, the
                clients you cover, the format you prefer. It costs tokens on every
                message, so keep it to what genuinely always applies.
              </p>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={12}
                placeholder="I review individual returns and mostly work in California. Give me the figure first, then the reasoning. Assume I know the terminology."
                className="w-full resize-y rounded-lg border border-line bg-panel px-3 py-2.5 text-[13.5px] leading-[1.55] outline-none focus:border-[#3c4653]"
              />
              <div className="mt-2.5 flex items-center gap-2.5">
                <button
                  onClick={() => patch({ instructions })}
                  className="rounded-[9px] bg-accent px-3.5 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover"
                >
                  Save
                </button>
                <span className="text-[12px] text-ink-faint">
                  {instructions.length.toLocaleString()} characters
                </span>
              </div>
            </section>
          ) : null}

          {tab === 'defaults' ? (
            <section className="space-y-5">
              <div>
                <h2 className="mb-1 text-[15px] font-semibold">Model</h2>
                <p className="mb-2.5 text-[13px] text-ink-dim">
                  Where a new conversation starts. Any thread can be switched from the
                  composer without changing this.
                </p>
                <div className="flex flex-col gap-1.5">
                  {prefs.models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => patch({ model: m.id })}
                      className={`rounded-lg border px-3 py-2 text-left ${
                        (prefs.model ?? prefs.defaults.model) === m.id
                          ? 'border-accent bg-raised'
                          : 'border-line hover:bg-raised'
                      }`}
                    >
                      <div className="text-[13.5px] font-medium">{m.label}</div>
                      <div className="text-[12px] text-ink-faint">{m.blurb}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <h2 className="mb-1 text-[15px] font-semibold">Thinking</h2>
                <div className="flex flex-col gap-1.5">
                  {prefs.thinkingLevels.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => patch({ thinking: t.id })}
                      className={`rounded-lg border px-3 py-2 text-left ${
                        (prefs.thinking ?? prefs.defaults.thinking) === t.id
                          ? 'border-accent bg-raised'
                          : 'border-line hover:bg-raised'
                      }`}
                    >
                      <div className="text-[13.5px] font-medium">{t.label}</div>
                      <div className="text-[12px] text-ink-faint">{t.blurb}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <h2 className="mb-1 text-[15px] font-semibold">Style</h2>
                <div className="flex flex-wrap gap-1.5">
                  {prefs.styles.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => patch({ style: s.id })}
                      className={`rounded-[9px] border px-3 py-1.5 text-[13px] ${
                        (prefs.style ?? prefs.defaults.style) === s.id
                          ? 'border-accent bg-raised'
                          : 'border-line hover:bg-raised'
                      }`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {tab === 'styles' ? (
            <section>
              <h2 className="mb-1 text-[15px] font-semibold">Your styles</h2>
              <p className="mb-3 text-[13px] text-ink-dim">
                A style steers register and shape, not substance. A few lines is
                plenty — it is sent on every message written in that style.
              </p>

              <div className="mb-4 flex flex-col gap-1.5">
                {prefs.styles
                  .filter((s) => !s.builtIn)
                  .map((s) => (
                    <div
                      key={s.id}
                      className="flex items-start gap-2 rounded-lg border border-line px-3 py-2"
                    >
                      <div className="flex-1">
                        <div className="text-[13.5px] font-medium">{s.name}</div>
                        <div className="text-[12px] text-ink-faint">{s.blurb}…</div>
                      </div>
                      <button
                        onClick={async () => {
                          await fetch(`/api/styles/${s.id}`, { method: 'DELETE' });
                          load();
                        }}
                        className="text-ink-faint hover:text-sev-blocking"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                {prefs.styles.every((s) => s.builtIn) ? (
                  <div className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[12.5px] text-ink-faint">
                    No styles of your own yet
                  </div>
                ) : null}
              </div>

              <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
                <input
                  value={styleName}
                  onChange={(e) => setStyleName(e.target.value)}
                  placeholder="Name — e.g. Client email"
                  className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13.5px] outline-none focus:border-[#3c4653]"
                />
                <textarea
                  value={styleText}
                  onChange={(e) => setStyleText(e.target.value)}
                  rows={5}
                  placeholder="Write as if to a client who is not an accountant. No jargon without a short gloss. Never more than four paragraphs."
                  className="w-full resize-y rounded-lg border border-line bg-canvas px-2.5 py-2 text-[13.5px] leading-[1.55] outline-none focus:border-[#3c4653]"
                />
                <button
                  disabled={!styleName.trim() || !styleText.trim()}
                  onClick={async () => {
                    await fetch('/api/styles', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: styleName, instructions: styleText }),
                    });
                    setStyleName('');
                    setStyleText('');
                    load();
                  }}
                  className="rounded-[9px] bg-accent px-3.5 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Add style
                </button>
              </div>
            </section>
          ) : null}

          {tab === 'skills' ? (
            <section>
              <h2 className="mb-1 text-[15px] font-semibold">Your skills</h2>
              <p className="mb-3 text-[13px] text-ink-dim">
                A folder of instructions the assistant follows when it applies — your
                own checklist, your own format, your own procedure. Only you see the
                ones you install here. Firm-wide skills are set by an admin and are
                already available to you.
              </p>
              <SkillsManager scope="personal" />
            </section>
          ) : null}

          {tab === 'accounts' ? (
            <section>
              <h2 className="mb-1 text-[15px] font-semibold">Connected accounts</h2>
              <p className="mb-3 text-[13px] text-ink-dim">
                Sign in to your own Drive, mail or Box and the assistant can search and
                read them when you ask it to. Read-only, always: nothing here can send
                mail, change a file or delete anything.
              </p>
              <p className="mb-4 text-[13px] text-ink-dim">
                Connecting an account does not make it visible in your chats on its own
                — you switch it on per conversation from the composer, and every search
                or read it does is written to the audit log.
              </p>

              <div className="flex flex-col gap-2">
                {accounts.map((a) => (
                  <div key={a.id} className="rounded-lg border border-line px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <div className="flex-1">
                        <div className="text-[13.5px] font-medium">{a.label}</div>
                        <div className="text-[12px] text-ink-faint">
                          {a.connected
                            ? (a.accountLabel ?? 'Connected')
                            : a.configured
                              ? a.blurb
                              : 'Not set up on this server'}
                        </div>
                      </div>

                      {a.connected ? (
                        <button
                          onClick={async () => {
                            if (!confirm(`Disconnect ${a.label}?`)) return;
                            await fetch(`/api/accounts/${a.id}`, { method: 'DELETE' });
                            load();
                          }}
                          className="rounded-[9px] border border-line px-3 py-1.5 text-[13px] hover:border-sev-blocking hover:text-sev-blocking"
                        >
                          Disconnect
                        </button>
                      ) : a.configured ? (
                        <a
                          href={`/api/accounts/${a.id}/start`}
                          className="rounded-[9px] bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-accent-ink hover:bg-accent-hover"
                        >
                          Connect
                        </a>
                      ) : (
                        <span className="text-[12px] text-ink-faint">Unavailable</span>
                      )}
                    </div>

                    {!a.configured && a.setupHint ? (
                      <div className="mt-2 border-t border-line-soft pt-2 text-[12px] text-ink-dim">
                        {a.setupHint}
                        <div className="mt-1.5 text-ink-faint">
                          Redirect URI to register:{' '}
                          <code className="font-mono text-[11.5px]">{a.redirectUri}</code>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              <p className="mt-4 text-[12px] text-ink-faint">
                Disconnecting deletes the stored tokens here. To withdraw the grant at
                the provider as well, remove this app from your Google or Box account
                security settings.
              </p>
            </section>
          ) : null}

          {tab === 'memory' ? (
            <section>
              <h2 className="mb-1 text-[15px] font-semibold">Memory</h2>
              <p className="mb-3 text-[13px] text-ink-dim">
                Facts carried into every conversation. The assistant saves one when you
                ask it to, or when a lasting preference becomes clear. Everything it
                has kept is here, and deleting one deletes it for good.
              </p>

              <label className="mb-3 flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13.5px]">
                <input
                  type="checkbox"
                  checked={prefs.memoryEnabled}
                  onChange={(e) => patch({ memoryEnabled: e.target.checked })}
                />
                Let the assistant remember things between conversations
              </label>

              <div className="flex flex-col gap-1.5">
                {memories.map((m) => (
                  <div
                    key={m.id}
                    className="group flex items-start gap-2 rounded-lg border border-line px-3 py-2"
                  >
                    <div className="flex-1 text-[13px] leading-[1.5]">{m.text}</div>
                    <span className="shrink-0 text-[11.5px] text-ink-faint">
                      {when(m.createdAt)}
                    </span>
                    <button
                      onClick={async () => {
                        await fetch(`/api/memories/${m.id}`, { method: 'DELETE' });
                        load();
                      }}
                      title="Forget this"
                      className="text-ink-faint opacity-0 group-hover:opacity-100 hover:text-sev-blocking"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {memories.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-ink-faint">
                    Nothing remembered yet
                  </div>
                ) : null}
              </div>

              {memories.length ? (
                <button
                  onClick={async () => {
                    if (!confirm('Forget everything? This cannot be undone.')) return;
                    await fetch('/api/memories', { method: 'DELETE' });
                    load();
                  }}
                  className="mt-3 rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink-dim hover:border-sev-blocking hover:text-sev-blocking"
                >
                  Forget everything
                </button>
              ) : null}
            </section>
          ) : null}

          {tab === 'data' ? (
            <section>
              <h2 className="mb-1 text-[15px] font-semibold">Your data</h2>
              <p className="mb-3 text-[13px] text-ink-dim">
                Everything you have here, in one file: conversations, messages,
                projects, styles and remembered facts. Uploaded documents are not
                included — they are yours already and they are large.
              </p>
              <a
                href="/api/export"
                className="inline-block rounded-[9px] border border-line px-3.5 py-1.5 text-[13px] hover:bg-raised"
              >
                Download everything (JSON)
              </a>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
