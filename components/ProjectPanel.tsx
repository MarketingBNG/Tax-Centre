'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ProjectFile {
  id: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  pageCount: number | null;
}

interface Project {
  id: string;
  name: string;
  instructions: string;
  files: ProjectFile[];
  conversations: { id: string; title: string; updated_at: number }[];
}

const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/**
 * A project's own instructions and its shelf of documents.
 *
 * Both apply to every conversation in the project, which is the whole point:
 * the standing context for a client or a matter gets set up once instead of
 * being re-attached and re-explained at the top of every thread.
 */
export function ProjectPanel({
  projectId,
  onClose,
  onChanged,
  onOpenChat,
}: {
  projectId: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenChat: (id: string) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (!res.ok) return;
    const data: Project = await res.json();
    setProject(data);
    setName(data.name);
    setInstructions(data.instructions);
  }, [projectId]);

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

  async function save() {
    await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, instructions }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
    onChanged();
    load();
  }

  async function upload(list: File[]) {
    if (!list.length) return;
    setError(null);
    setUploading(list.length);
    try {
      const form = new FormData();
      form.append('projectId', projectId);
      for (const f of list) form.append('files', f);

      const res = await fetch('/api/files', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      if (data.errors?.length) {
        setError(
          data.errors
            .map((e: { filename: string; error: string }) => `${e.filename}: ${e.error}`)
            .join('  •  '),
        );
      }
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(0);
    }
  }

  if (!project) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[620px] max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-line bg-canvas"
      >
        <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            className="flex-1 rounded-lg bg-transparent px-1 py-0.5 text-[16px] font-semibold tracking-tight outline-none hover:bg-raised focus:bg-raised"
          />
          <span className="text-[11.5px] text-ink-faint">{saved ? 'Saved' : ''}</span>
          <button onClick={onClose} className="px-1 text-ink-faint hover:text-ink">
            ×
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <h3 className="mb-1 text-[13.5px] font-semibold">Project instructions</h3>
            <p className="mb-2 text-[12.5px] text-ink-dim">
              Prepended to every conversation in this project. The standing brief — who
              the client is, which year, what to assume, what never to assume.
            </p>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={save}
              rows={7}
              placeholder="This project covers the 2025 return for a two-partner LLC in Texas. Amounts are in USD. When I ask about a schedule, assume the federal one unless I say state."
              className="w-full resize-y rounded-lg border border-line bg-panel px-3 py-2.5 text-[13.5px] leading-[1.55] outline-none focus:border-[#3c4653]"
            />
          </section>

          <section>
            <div className="mb-2 flex items-center gap-2.5">
              <h3 className="flex-1 text-[13.5px] font-semibold">
                Documents
                <span className="ml-1.5 font-normal text-ink-faint">
                  in every chat in this project
                </span>
              </h3>
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded-[9px] border border-line px-2.5 py-1 text-[12.5px] hover:bg-raised"
              >
                {uploading ? `Uploading ${uploading}…` : '＋ Add'}
              </button>
            </div>

            {error ? (
              <div className="mb-2 rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[12.5px] text-[#e8b0b0]">
                {error}
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              {project.files.map((f) => (
                <div
                  key={f.id}
                  className="group flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]"
                >
                  <span className="flex-1 truncate">{f.filename}</span>
                  <small className="text-ink-faint">
                    {f.pageCount ? `${f.pageCount}p` : f.kind} · {formatBytes(f.sizeBytes)}
                  </small>
                  <button
                    onClick={async () => {
                      await fetch(`/api/files/${f.id}`, { method: 'DELETE' });
                      load();
                      onChanged();
                    }}
                    title="Remove from project"
                    className="text-ink-faint opacity-0 group-hover:opacity-100 hover:text-sev-blocking"
                  >
                    ×
                  </button>
                </div>
              ))}
              {project.files.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-ink-faint">
                  Nothing on the shelf yet
                </div>
              ) : null}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[13.5px] font-semibold">
              Chats
              <span className="ml-1.5 font-normal text-ink-faint">{project.conversations.length}</span>
            </h3>
            <div className="flex flex-col gap-px">
              {project.conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    onOpenChat(c.id);
                    onClose();
                  }}
                  className="truncate rounded-lg px-2.5 py-1.5 text-left text-[13.5px] text-ink-dim hover:bg-raised hover:text-ink"
                >
                  {c.title}
                </button>
              ))}
              {project.conversations.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-ink-faint">
                  No chats in this project yet
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept=".pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md,.tsv,.png,.jpg,.jpeg,.gif,.webp"
        onChange={(e) => {
          upload([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
