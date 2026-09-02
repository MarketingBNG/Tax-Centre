'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Markdown } from './Markdown';
import { Mark } from './Mark';
import { FindingsReport, type ReviewBundle } from './FindingsReport';
import { doSignOut } from '../app/actions';

interface Me {
  id: string;
  email: string;
  role: string;
  displayName: string;
  apiKeyConfigured: boolean;
  authDisabled: boolean;
  provider: string;
  citationsSupported: boolean;
  model: string;
  severityLabels: Record<string, string>;
}

interface Conversation {
  id: string;
  title: string;
  updated_at: number;
  snippet?: string | null;
}

interface Attachment {
  id: string;
  filename: string;
  kind: string;
  pageCount: number | null;
  sizeBytes: number;
  piiSummary: string | null;
}

interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  review_id: string | null;
}

const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function Chat({ me }: { me: Me }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [reviews, setReviews] = useState<Record<string, ReviewBundle>>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [draft, setDraft] = useState('');
  const [streamText, setStreamText] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ text: string; kind: 'error' | 'warn' } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Conversation[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const chatAbort = useRef<AbortController | null>(null);
  const activeReview = useRef<string | null>(null);

  const scrollDown = useCallback(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const loadConversations = useCallback(async () => {
    const res = await fetch('/api/conversations');
    if (res.ok) setConversations(await res.json());
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) return null;
    const data = await res.json();
    setMessages(data.messages);
    setReviews(data.reviews ?? {});
    return data as { runningReviewId: string | null };
  }, []);

  /**
   * Reads a review's event log from `cursor` onward.
   *
   * The review runs on the server independently of this connection, so calling
   * this again after a refresh — or after the connection drops — resumes from
   * the last cursor instead of losing the run.
   */
  const followReview = useCallback(
    async (reviewId: string, convId: string, fromCursor = 0) => {
      if (activeReview.current === reviewId) return;
      activeReview.current = reviewId;
      setBusy(true);

      let cursor = fromCursor;
      let assembled = '';
      let outcome: 'stopped' | string | null = null;

      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const res = await fetch(`/api/review/${reviewId}/stream?from=${cursor}`);
          if (!res.ok || !res.body) break;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let settled = false;

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) continue;
              let ev: Record<string, unknown>;
              try {
                ev = JSON.parse(line);
              } catch {
                continue;
              }
              if (typeof ev.cursor === 'number') cursor = ev.cursor;

              if (ev.type === 'text') {
                assembled += ev.delta as string;
                setStreamText(assembled);
              } else if (ev.type === 'status') {
                setStatusLine(ev.message as string);
              } else if (ev.type === 'aborted') {
                outcome = 'stopped';
              } else if (ev.type === 'error') {
                outcome = ev.message as string;
              } else if (ev.type === 'closed') {
                settled = true;
              }
            }
          }

          if (settled) break;
          // Connection dropped before the review finished — reconnect from the
          // cursor rather than restarting or abandoning it.
        }

        if (outcome === 'stopped') {
          setBanner({ text: 'Review stopped. Anything already written has been kept.', kind: 'warn' });
        } else if (outcome) {
          setBanner({ text: outcome, kind: 'error' });
        }
      } finally {
        activeReview.current = null;
        setStreamText(null);
        setStatusLine(null);
        setBusy(false);
        await loadConversation(convId);
        await loadConversations();
      }
    },
    [loadConversation, loadConversations],
  );

  const openConversation = useCallback(
    async (id: string) => {
      setConversationId(id);
      setAttachments([]);
      setBanner(null);
      setStreamText(null);

      const data = await loadConversation(id);
      // Reattach to a review still in flight — this is what makes refreshing
      // mid-review harmless.
      if (data?.runningReviewId) void followReview(data.runningReviewId, id, 0);
    },
    [loadConversation, followReview],
  );

  useEffect(() => {
    loadConversations();
    if (me.authDisabled) {
      setBanner({
        text: 'Sign-in is disabled (DISABLE_AUTH=true in .env). Everyone is an admin. Turn it off before anyone else can reach this.',
        kind: 'warn',
      });
    } else if (!me.apiKeyConfigured) {
      setBanner({
        text: 'No OpenAI API key configured. Add OPENAI_API_KEY to .env and restart the server.',
        kind: 'error',
      });
    }
  }, [loadConversations, me]);

  useEffect(scrollDown, [messages, streamText, scrollDown]);

  // Debounced search over titles and message text.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
      if (res.ok) setResults(await res.json());
    }, 220);
    return () => clearTimeout(timer);
  }, [query]);

  function startNew() {
    setConversationId(null);
    setMessages([]);
    setReviews({});
    setAttachments([]);
    setStreamText(null);
    setBanner(null);
    inputRef.current?.focus();
  }

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const res = await fetch('/api/conversations', { method: 'POST' });
    const conv = await res.json();
    setConversationId(conv.id);
    return conv.id;
  }

  async function uploadFiles(list: File[]) {
    if (!list.length) return;
    setBanner(null);
    setUploading(list.length);

    try {
      const convId = await ensureConversation();
      const form = new FormData();
      form.append('conversationId', convId);
      for (const f of list) form.append('files', f);

      const res = await fetch('/api/files', { method: 'POST', body: form });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      if (data.files?.length) setAttachments((prev) => [...prev, ...data.files]);
      if (data.errors?.length) {
        setBanner({
          text: data.errors
            .map((e: { filename: string; error: string }) => `${e.filename}: ${e.error}`)
            .join('  •  '),
          kind: 'error',
        });
      }
    } catch (err) {
      setBanner({ text: (err as Error).message, kind: 'error' });
    } finally {
      setUploading(0);
    }
  }

  async function send() {
    const note = draft.trim();
    const files = attachments.slice();
    if (busy || (!note && !files.length)) return;

    setBanner(null);
    setDraft('');
    setAttachments([]);

    const convId = await ensureConversation();
    const label = files.length
      ? `Review requested — ${files.map((f) => f.filename).join(', ')}${note ? `\n\n${note}` : ''}`
      : note;

    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', content: label, review_id: null },
    ]);
    setStreamText('');

    if (files.length) {
      // Reviews are detached jobs: start one, then follow its event log.
      setBusy(true);
      try {
        const res = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: convId, fileIds: files.map((f) => f.id), note }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
        await followReview(data.reviewId, convId, 0);
      } catch (err) {
        setBanner({ text: (err as Error).message, kind: 'error' });
        setStreamText(null);
        setBusy(false);
      }
      return;
    }

    // Follow-up questions are short, so they stream on the request itself.
    setBusy(true);
    const controller = new AbortController();
    chatAbort.current = controller;
    let assembled = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, question: note }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'text') {
            assembled += ev.delta as string;
            setStreamText(assembled);
          } else if (ev.type === 'error') {
            setBanner({ text: ev.message as string, kind: 'error' });
          }
        }
      }
      await loadConversation(convId);
      await loadConversations();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setBanner({ text: 'Stopped. Anything already written has been kept.', kind: 'warn' });
        await loadConversation(convId);
      } else {
        setBanner({ text: (err as Error).message, kind: 'error' });
      }
    } finally {
      chatAbort.current = null;
      setStreamText(null);
      setBusy(false);
    }
  }

  async function stop() {
    const reviewId = activeReview.current;
    if (reviewId) {
      await fetch(`/api/review/${reviewId}/abort`, { method: 'POST' }).catch(() => {});
    }
    chatAbort.current?.abort();
  }

  async function copyMessage(m: ThreadMessage) {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(m.id);
      setTimeout(() => setCopied((c) => (c === m.id ? null : c)), 1500);
    } catch {
      setBanner({ text: 'Could not copy — the browser blocked clipboard access.', kind: 'error' });
    }
  }

  async function saveRename(id: string) {
    const title = renameDraft.trim();
    setRenaming(null);
    if (!title) return;
    await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    loadConversations();
  }

  const canSend = !busy && (draft.trim().length > 0 || attachments.length > 0);
  const initial = (me.displayName || me.email).charAt(0).toUpperCase();
  const listed = results ?? conversations;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ------------------------------------------------------ sidebar */}
      <aside className="flex w-72 shrink-0 flex-col gap-2.5 border-r border-line-soft bg-panel p-3">
        <div className="flex items-center gap-2.5 px-1.5 pt-1 pb-2.5 text-[16.5px] font-semibold tracking-tight">
          <Mark size={19} />
          Tax Review Center
        </div>

        <button
          onClick={startNew}
          className="flex w-full items-center gap-2 rounded-[10px] border border-line bg-raised px-3 py-2 text-left font-medium hover:bg-raised-hover"
        >
          ＋ New review
        </button>

        {me.role === 'admin' ? (
          <Link
            href="/admin"
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] text-ink-dim hover:bg-raised hover:text-ink"
          >
            ⚙ Skills &amp; admin
          </Link>
        ) : null}

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search reviews…"
          className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] outline-none placeholder:text-ink-faint focus:border-[#3c4653]"
        />

        <div className="px-2.5 pb-1 text-[11.5px] font-semibold text-ink-faint">
          {results ? `${results.length} match${results.length === 1 ? '' : 'es'}` : 'Recent reviews'}
        </div>

        <div className="flex flex-1 flex-col gap-px overflow-y-auto">
          {listed.length === 0 ? (
            <div className="p-3 text-center text-[12.5px] text-ink-faint">
              {results ? 'Nothing found' : 'No reviews yet'}
            </div>
          ) : (
            listed.map((c) => (
              <div
                key={c.id}
                className={`group rounded-lg px-2.5 py-1.5 text-[13.5px] ${
                  c.id === conversationId
                    ? 'bg-raised text-ink'
                    : 'text-ink-dim hover:bg-raised hover:text-ink'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  {renaming === c.id ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => saveRename(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename(c.id);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      className="w-full rounded border border-accent bg-canvas px-1.5 py-0.5 text-[13px] outline-none"
                    />
                  ) : (
                    <>
                      <button
                        onClick={() => openConversation(c.id)}
                        onDoubleClick={() => {
                          setRenaming(c.id);
                          setRenameDraft(c.title);
                        }}
                        className="flex-1 truncate text-left"
                        title={`${c.title}  (double-click to rename)`}
                      >
                        {c.title}
                      </button>
                      <button
                        onClick={() => {
                          setRenaming(c.id);
                          setRenameDraft(c.title);
                        }}
                        title="Rename"
                        className="px-1 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-accent"
                      >
                        ✎
                      </button>
                      <button
                        onClick={async () => {
                          if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
                          await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
                          if (conversationId === c.id) startNew();
                          loadConversations();
                        }}
                        title="Delete"
                        className="px-1 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-sev-blocking"
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
                {c.snippet ? (
                  <div className="mt-0.5 truncate text-[11.5px] text-ink-faint">{c.snippet}</div>
                ) : null}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-2.5 border-t border-line-soft pt-2.5 text-[13px]">
          <div className="grid h-6.5 w-6.5 place-items-center rounded-full bg-accent text-[12px] font-bold text-accent-ink">
            {initial}
          </div>
          <div className="flex-1 overflow-hidden">
            <div className="truncate font-medium">{me.displayName}</div>
            <div className="text-ink-faint">{me.role === 'admin' ? 'Admin' : 'Reviewer'}</div>
          </div>
          <form action={doSignOut}>
            <button
              type="submit"
              title="Sign out"
              className="grid h-7.5 w-7.5 place-items-center rounded-lg border border-line text-ink-dim hover:bg-raised hover:text-ink"
            >
              ⏻
            </button>
          </form>
        </div>
      </aside>

      {/* --------------------------------------------------------- main */}
      <main
        className={`relative flex flex-1 flex-col overflow-hidden ${
          dragging ? 'outline-2 outline-dashed outline-accent -outline-offset-10' : ''
        }`}
        onDragEnter={(e) => {
          e.preventDefault();
          if (++dragDepth.current === 1) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          if (--dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          uploadFiles([...e.dataTransfer.files]);
        }}
      >
        <div ref={threadRef} className="flex-1 overflow-y-auto px-6 pt-7 pb-2">
          <div className="mx-auto max-w-[780px]">
            {messages.length === 0 && streamText === null ? (
              <div className="grid h-full place-content-center pb-24 text-center">
                <div className="mb-4 flex justify-center opacity-80">
                  <Mark size={34} />
                </div>
                <h1 className="mb-2.5 text-[30px] font-normal tracking-tight">Ready to review</h1>
                <p className="mx-auto max-w-[460px] text-ink-dim">
                  Attach a tax return — PDF, Word, Excel, CSV or a scan — and it will be
                  reviewed against your firm&apos;s published methodology.
                </p>
              </div>
            ) : null}

            {messages.map((m) => (
              <div key={m.id}>
                {m.role === 'assistant' && m.review_id && reviews[m.review_id] ? (
                  <FindingsReport bundle={reviews[m.review_id]} labels={me.severityLabels} />
                ) : null}
                <div className="group mb-6">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[11.5px] font-semibold tracking-wide text-ink-faint">
                      {m.role === 'user' ? 'You' : 'Review'}
                    </span>
                    <button
                      onClick={() => copyMessage(m)}
                      title="Copy to clipboard"
                      className="rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
                    >
                      {copied === m.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div
                    className={
                      m.role === 'user'
                        ? 'rounded-xl border border-line bg-raised px-4 py-3 whitespace-pre-wrap'
                        : ''
                    }
                  >
                    {m.role === 'user' ? m.content : <Markdown text={m.content} />}
                  </div>
                </div>
              </div>
            ))}

            {streamText !== null ? (
              <div className="mb-6">
                <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-faint">
                  Review
                </div>
                <Markdown text={streamText} streaming />
                {statusLine ? (
                  <div className="mt-2 text-[13px] text-ink-faint">{statusLine}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* ---------------------------------------------------- composer */}
        <div className="px-6 pt-2.5 pb-5">
          {banner ? (
            <div
              className={`mx-auto mb-2.5 flex max-w-[780px] items-start gap-3 rounded-lg border px-3 py-2 text-[13px] ${
                banner.kind === 'warn'
                  ? 'border-sev-math/35 bg-sev-math/10 text-[#dcc79a]'
                  : 'border-sev-blocking/35 bg-sev-blocking/10 text-[#e8b0b0]'
              }`}
            >
              <span className="flex-1">{banner.text}</span>
              <button onClick={() => setBanner(null)} className="opacity-60 hover:opacity-100">
                ×
              </button>
            </div>
          ) : null}

          <div className="mx-auto max-w-[780px] rounded-2xl border border-line bg-panel px-3.5 py-3 focus-within:border-[#3c4653]">
            {attachments.length ? (
              <div className="mb-2.5 flex flex-wrap gap-2">
                {attachments.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-2 rounded-[9px] border border-line bg-raised px-2.5 py-1.5 text-[12.5px]"
                  >
                    {f.filename}
                    <small className="text-ink-faint">
                      {f.pageCount ? `${f.pageCount}p` : f.kind} · {formatBytes(f.sizeBytes)}
                      {f.piiSummary ? ` · ${f.piiSummary} masked` : ''}
                    </small>
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== f.id))}
                      className="text-ink-faint hover:text-sev-blocking"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <textarea
              ref={inputRef}
              value={draft}
              rows={1}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Attach tax files and press Review — no prompt needed. Or ask a question."
              className="max-h-[220px] min-h-[26px] w-full resize-none bg-transparent outline-none placeholder:text-ink-faint"
            />

            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => fileRef.current?.click()}
                title="Attach files"
                className="grid h-7.5 w-7.5 place-items-center rounded-lg border border-line text-[16px] leading-none text-ink-dim hover:bg-raised hover:text-ink"
              >
                ＋
              </button>
              <span className="text-[12px] text-ink-faint">
                {uploading ? `Uploading ${uploading} file(s)…` : ''}
              </span>

              {busy ? (
                <button
                  onClick={stop}
                  className="ml-auto rounded-[9px] border border-line bg-raised px-3.5 py-1.5 font-medium hover:bg-raised-hover"
                >
                  ■ Stop
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!canSend}
                  className="ml-auto rounded-[9px] bg-accent px-3.5 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {attachments.length ? 'Review' : 'Send'}
                </button>
              )}
            </div>
          </div>

          <div className="mx-auto mt-2 max-w-[780px] text-center text-[12px] text-ink-faint">
            AI review aid — not tax advice. A licensed preparer must verify every item.
            {' · '}
            <span title={`provider: ${me.provider}`}>{me.model}</span>
            {me.citationsSupported ? '' : ' · page references unavailable on this provider'}
          </div>
        </div>
      </main>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept=".pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md,.tsv,.png,.jpg,.jpeg,.gif,.webp"
        onChange={(e) => {
          uploadFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
