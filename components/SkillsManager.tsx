'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from './ui';

interface SkillFile {
  path: string;
  bytes: number;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  scope: 'firm' | 'personal';
  enabled: boolean;
  folder: string | null;
  updatedAt: number;
  files: SkillFile[];
  bodyChars: number;
}

const btn =
  'rounded-[9px] border border-line bg-raised px-4 py-2 text-[13px] font-medium hover:bg-raised-hover disabled:opacity-50';
const btnPrimary =
  'rounded-[9px] bg-accent px-4 py-2 text-[13px] font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50';
const btnSm = 'rounded-md border border-line px-3 py-1 text-[13px] hover:bg-raised';

const kb = (n: number) => (n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`);

/**
 * Install and manage skills.
 *
 * The same component serves both scopes: an admin managing what the whole firm
 * gets, and anybody managing their own. The only difference is which upload
 * button is offered, which is why the scope is a prop rather than two screens.
 */
export function SkillsManager({ scope }: { scope: 'firm' | 'personal' }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/skills');
    if (!res.ok) return;
    const data = await res.json();
    setSkills(data.skills);
    setIsAdmin(data.isAdmin);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setNote(null);

    const form = new FormData();
    form.append('scope', scope);
    const paths: string[] = [];
    for (const file of Array.from(list)) {
      // webkitRelativePath is what carries the folder structure; a File in a
      // form does not keep it, so it travels alongside.
      paths.push((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
      form.append('files', file);
    }
    form.append('paths', JSON.stringify(paths));

    const res = await fetch('/api/skills', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setNote(data.error ?? 'Could not install that skill.');
      return;
    }
    setNote(
      `Installed "${data.name}" with ${data.files} file(s)` +
        (data.skipped?.length ? `. Skipped ${data.skipped.length} non-text file(s).` : '.'),
    );
    load();
  }

  const shown = skills.filter((s) => s.scope === scope);
  const { ask, confirmDialog } = useConfirm();

  return (
    <div>
      {confirmDialog}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button
          className={btnPrimary}
          disabled={busy}
          onClick={() => folderRef.current?.click()}
        >
          {busy ? 'Installing…' : 'Install a skill folder'}
        </button>
        {note ? <span className="text-[13px] text-ink-dim">{note}</span> : null}
      </div>

      <p className="mb-4 text-[13px] text-ink-faint">
        Pick the folder that contains <code className="font-mono">SKILL.md</code> — not the
        one above it. Everything beside it comes too, and a folder with the same skill
        name replaces the one already here rather than adding a second copy.
      </p>

      <div className="flex flex-col gap-2">
        {shown.map((s) => (
          <div key={s.id} className="rounded-lg border border-line px-3 py-3">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] font-medium">{s.name}</span>
                  {!s.enabled ? (
                    <span className="rounded border border-line px-2 text-[11.5px] text-ink-faint">
                      off
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 line-clamp-2 text-[13px] text-ink-dim">
                  {s.description}
                </div>
                <div className="mt-1 text-[11.5px] text-ink-faint">
                  {kb(s.bodyChars)} · {s.files.length} file
                  {s.files.length === 1 ? '' : 's'}
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                <button className={btnSm} onClick={() => setOpen(open === s.id ? null : s.id)}>
                  {open === s.id ? 'Close' : 'Files'}
                </button>
                <button
                  className={btnSm}
                  onClick={async () => {
                    await fetch(`/api/skills/${s.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ enabled: !s.enabled }),
                    });
                    load();
                  }}
                >
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className={`${btnSm} hover:text-sev-blocking`}
                  onClick={() =>
                    ask({
                      title: `Delete the "${s.name}" skill?`,
                      body: 'It stops being offered to the model straight away. This cannot be undone.',
                      confirmLabel: 'Delete',
                      destructive: true,
                      onConfirm: async () => {
                        await fetch(`/api/skills/${s.id}`, { method: 'DELETE' });
                        load();
                      },
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </div>

            {open === s.id ? (
              <div className="mt-3 border-t border-line-soft pt-3">
                {s.files.length === 0 ? (
                  <div className="text-[13px] text-ink-faint">
                    Just the SKILL.md — no supporting files.
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {s.files.map((f) => (
                      <div
                        key={f.path}
                        className="flex items-center justify-between text-[13px]"
                      >
                        <span className="truncate font-mono text-ink-dim">{f.path}</span>
                        <span className="shrink-0 text-ink-faint">{kb(f.bytes)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ))}

        {shown.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-3 py-5 text-center text-[13px] text-ink-faint">
            {scope === 'firm' ? 'No firm skills installed yet' : 'No skills of your own yet'}
          </div>
        ) : null}
      </div>

      {scope === 'firm' && !isAdmin ? (
        <p className="mt-3 text-[13px] text-ink-faint">
          Only an admin can install or change a firm skill.
        </p>
      ) : null}

      <input
        ref={folderRef}
        type="file"
        hidden
        multiple
        // Non-standard but supported everywhere that matters; it is the only way
        // to keep the folder structure a skill depends on.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => {
          upload(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
