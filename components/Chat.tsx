'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Markdown } from './Markdown';
import { Mark } from './Mark';
import { Thinking } from './Thinking';
import { ToolPanel } from './ToolPanel';
import { SettingsDialog } from './SettingsDialog';
import { ProjectPanel } from './ProjectPanel';
import { ComposerMenu } from './ComposerMenu';
import { btn, useConfirm } from './ui';
import { doSignOut } from '../app/actions';
import { APP_NAME } from '../lib/app';
import type { ToolRun } from '../lib/types';

interface Me {
  id: string;
  email: string;
  role: string;
  displayName: string;
  apiKeyConfigured: boolean;
  authDisabled: boolean;
  provider: string;
  model: string;
  toolsEnabled?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  updated_at: number;
  starred?: number;
  archived_at?: number | null;
  project_id?: string | null;
  snippet?: string | null;
}

interface Project {
  id: string;
  name: string;
  chatCount: number;
  docCount: number;
}

interface Attachment {
  id: string;
  filename: string;
  kind: string;
  pageCount: number | null;
  sizeBytes: number;
  piiSummary: string | null;
}

interface ThreadFile {
  id: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  pageCount: number | null;
  fromProject: boolean;
}

interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  thinking: string | null;
  model: string | null;
  finish: 'stop' | 'length' | 'aborted' | null;
  vote: number | null;
  toolRuns: ToolRun[];
  version: number;
  versionCount: number;
  versionIds: string[];
}

interface Settings {
  model: string;
  thinking: string;
  style: string;
  styleLabel: string;
  connectors: string[];
  skills: string[];
}

interface ConnectorOption {
  id: string;
  kind: 'mcp' | 'account';
  name: string;
  /** For a personal account, which one — the address it signed in as. */
  detail: string | null;
  toolCount: number;
}

interface Option {
  id: string;
  label: string;
  blurb?: string;
}

interface Pickers {
  models: Option[];
  thinkingLevels: Option[];
  styles: Option[];
}

type Action = 'send' | 'edit' | 'retry' | 'continue';

const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Pasting a wall of text is an attachment in disguise; treat it as one. */
const PASTE_AS_FILE_THRESHOLD = 4000;

export function Chat({ me }: { me: Me }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [files, setFiles] = useState<ThreadFile[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pickers, setPickers] = useState<Pickers | null>(null);
  const [availableConnectors, setAvailableConnectors] = useState<ConnectorOption[]>([]);
  const [availableSkills, setAvailableSkills] = useState<
    { id: string; name: string; scope: string }[]
  >([]);

  const [draft, setDraft] = useState('');
  const [streamText, setStreamText] = useState<string | null>(null);
  const [streamThinking, setStreamThinking] = useState('');
  const [streamTools, setStreamTools] = useState<ToolRun[]>([]);
  const [continuingId, setContinuingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [banner, setBanner] = useState<{ text: string; kind: 'error' | 'warn' } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Conversation[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [menu, setMenu] = useState<'model' | 'thinking' | 'style' | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  // Below md the sidebar is a drawer over the thread rather than a column
  // beside it; there is not room for both on a phone.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { ask, confirmDialog } = useConfirm();

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const chatAbort = useRef<AbortController | null>(null);
  const recognition = useRef<{ start: () => void; stop: () => void } | null>(null);

  const scrollDown = useCallback(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /* ------------------------------------------------------------- loading */

  const loadConversations = useCallback(async () => {
    const res = await fetch(`/api/conversations${showArchived ? '?archived=1' : ''}`);
    if (res.ok) setConversations(await res.json());
  }, [showArchived]);

  const loadProjects = useCallback(async () => {
    const res = await fetch('/api/projects');
    if (res.ok) setProjects(await res.json());
  }, []);

  const loadConnectors = useCallback(async () => {
    const res = await fetch('/api/connectors');
    if (res.ok) setAvailableConnectors(await res.json());
  }, []);

  const loadSkills = useCallback(async () => {
    const res = await fetch('/api/skills');
    if (!res.ok) return;
    const data = await res.json();
    setAvailableSkills(
      (data.skills ?? [])
        .filter((sk: { enabled: boolean }) => sk.enabled)
        .map((sk: { id: string; name: string; scope: string }) => ({
          id: sk.id,
          name: sk.name,
          scope: sk.scope,
        })),
    );
  }, []);

  const loadPickers = useCallback(async () => {
    const res = await fetch('/api/prefs');
    if (!res.ok) return;
    const data = await res.json();
    setPickers({
      models: data.models.map((m: { id: string; label: string; blurb: string }) => ({
        id: m.id,
        label: m.label,
        blurb: m.blurb,
      })),
      thinkingLevels: data.thinkingLevels.map((t: { id: string; label: string; blurb: string }) => ({
        id: t.id,
        label: t.label,
        blurb: t.blurb,
      })),
      styles: data.styles.map((s: { id: string; name: string; blurb: string }) => ({
        id: s.id,
        label: s.name,
        blurb: s.blurb,
      })),
    });

    setMemoryEnabled(data.memoryEnabled !== false);

    // A chat that does not exist yet still needs the pickers to show something,
    // so seed them from this person's defaults until a real thread is opened.
    setSettings((prev) =>
      prev ?? {
        model: data.model ?? data.defaults.model,
        thinking: data.thinking ?? data.defaults.thinking,
        style: data.style ?? data.defaults.style,
        styleLabel: '',
        connectors: [],
        skills: [],
      },
    );
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setMessages(data.messages);
    setFiles(data.files);
    setSettings(data.settings);
    setProjectId(data.conversation.projectId ?? null);
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      setConversationId(id);
      setSidebarOpen(false);
      setAttachments([]);
      setBanner(null);
      setStreamText(null);
      setStreamThinking('');
      setStreamTools([]);
      await loadConversation(id);
    },
    [loadConversation],
  );

  useEffect(() => {
    loadConversations();
    loadProjects();
    loadPickers();
    loadConnectors();
    loadSkills();
    // The OAuth round trip lands back here with a query string; say how it
    // went, then clear it so a refresh does not repeat the message.
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const failed = params.get('account_error');
    if (connected || failed) {
      setBanner(
        failed
          ? { text: 'Could not connect that account: ' + failed, kind: 'error' }
          : {
              text:
                connected +
                ' is connected. Switch it on for a chat from the connector menu in the composer.',
              kind: 'warn',
            },
      );
      window.history.replaceState({}, '', window.location.pathname);
    }

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
  }, [loadConversations, loadProjects, loadPickers, loadConnectors, loadSkills, me]);

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

  // Close a picker by clicking anywhere else.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (meta && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        fileRef.current?.click();
      } else if (meta && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        startNew();
      } else if (e.key === 'Escape' && chatAbort.current) {
        chatAbort.current.abort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* -------------------------------------------------------------- actions */

  function startNew() {
    setConversationId(null);
    setSidebarOpen(false);
    setMessages([]);
    setFiles([]);
    setAttachments([]);
    setStreamText(null);
    setStreamThinking('');
    setStreamTools([]);
    setBanner(null);
    inputRef.current?.focus();
  }

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
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

  /**
   * Every way of producing an answer goes through here: a new question, an
   * edited one, a retry and a continue differ only in what the server is asked
   * to attach the answer to.
   */
  async function run(
    action: Action,
    options: { question?: string; messageId?: string; fileIds?: string[] } = {},
  ) {
    if (busy) return;

    setBanner(null);
    setStreamText('');
    setStreamThinking('');
    setStreamTools([]);
    setContinuingId(action === 'continue' ? (options.messageId ?? null) : null);
    setBusy(true);

    const convId = await ensureConversation();
    const controller = new AbortController();
    chatAbort.current = controller;

    let assembled = '';
    let thoughts = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: convId,
          action,
          question: options.question,
          messageId: options.messageId,
          fileIds: options.fileIds ?? [],
          model: settings?.model,
          style: settings?.style,
          thinking: settings?.thinking,
          connectors: settings?.connectors ?? [],
          skills: settings?.skills ?? [],
        }),
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
          } else if (ev.type === 'thinking') {
            thoughts += ev.delta as string;
            setStreamThinking(thoughts);
          } else if (ev.type === 'tool') {
            setStreamTools((prev) => [...prev, ev.run as ToolRun]);
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
      setStreamThinking('');
      setStreamTools([]);
      setContinuingId(null);
      setBusy(false);
    }
  }

  async function send() {
    const text = draft.trim();
    const pending = attachments.slice();
    if (busy || (!text && !pending.length)) return;

    setDraft('');
    setAttachments([]);

    const names = pending.map((f) => f.filename).join(', ');
    const label = pending.length ? (text ? `${names}\n\n${text}` : names) : text;

    // Shown immediately so the thread does not sit empty while the request is
    // still being set up; replaced by the real row when the turn is reloaded.
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: 'user',
        content: label,
        createdAt: Date.now(),
        thinking: null,
        model: null,
        finish: null,
        vote: null,
        toolRuns: [],
        version: 1,
        versionCount: 1,
        versionIds: [],
      },
    ]);

    await run('send', { question: text, fileIds: pending.map((f) => f.id) });
  }

  async function switchVersion(messageId: string) {
    if (!conversationId || busy) return;
    await fetch(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headMessageId: messageId }),
    });
    await loadConversation(conversationId);
  }

  async function vote(messageId: string, value: number) {
    const current = messages.find((m) => m.id === messageId)?.vote ?? null;
    const next = current === value ? null : value;
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, vote: next } : m)));
    await fetch(`/api/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vote: next }),
    });
  }

  async function patchConversation(id: string, body: Record<string, unknown>) {
    await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadConversations();
  }

  async function applySetting(key: 'model' | 'thinking' | 'style', value: string) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setMenu(null);
    // Persisted on the conversation when one exists; a chat that has not been
    // created yet carries the choice in the next request instead.
    if (conversationId) await patchConversation(conversationId, { [key]: value });
  }

  /**
   * Switch a connector on or off for this thread. Off by default and never
   * remembered across conversations: reaching an outside system is a decision
   * made per thread, not a preference that quietly follows you around.
   */
  async function toggleConnector(id: string) {
    const active = settings?.connectors ?? [];
    const next = active.includes(id) ? active.filter((c) => c !== id) : [...active, id];
    setSettings((prev) => (prev ? { ...prev, connectors: next } : prev));
    if (conversationId) {
      await fetch(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectors: next }),
      });
    }
  }

  async function toggleMemory() {
    const next = !memoryEnabled;
    setMemoryEnabled(next);
    await fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryEnabled: next }),
    });
  }

  /** Move this conversation into a project, or back out of one. */
  async function setConversationProject(id: string | null) {
    setProjectId(id);
    if (!conversationId) return;
    await fetch(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: id }),
    });
    await Promise.all([loadConversation(conversationId), loadProjects()]);
  }

  /**
   * Capture a screen or window and attach it.
   *
   * The browser puts up its own picker and its own permission prompt, so
   * nothing is captured that the person did not choose frame by frame. One
   * still is taken and the track is stopped immediately — there is no reason
   * to keep a live screen share open after the shutter.
   */
  async function takeScreenshot() {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (!media?.getDisplayMedia) {
      setBanner({ text: 'This browser cannot capture the screen.', kind: 'warn' });
      return;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await media.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // One frame has to have arrived before the canvas has anything to draw.
      await new Promise((done) => requestAnimationFrame(() => done(null)));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      video.pause();

      const blob = await new Promise<Blob | null>((done) =>
        canvas.toBlob(done, 'image/png'),
      );
      if (!blob) throw new Error('The capture came back empty.');

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      await uploadFiles([new File([blob], `screenshot-${stamp}.png`, { type: 'image/png' })]);
    } catch (err) {
      // Cancelling the browser picker is a decision, not a failure.
      if ((err as Error).name !== 'NotAllowedError') {
        setBanner({ text: `Could not take the screenshot: ${(err as Error).message}`, kind: 'error' });
      }
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  }

  /**
   * Pin or unpin a skill for this thread.
   *
   * Unpinned does not mean unavailable: a skill still fires on its own when
   * its description matches. Pinning is for when you want it to run whatever
   * you happen to ask.
   */
  async function toggleSkill(id: string) {
    const pinned = settings?.skills ?? [];
    const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
    setSettings((prev) => (prev ? { ...prev, skills: next } : prev));
    if (conversationId) {
      await fetch(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: next }),
      });
    }
  }

  async function copyMessage(m: ThreadMessage) {
    try {
      await navigator.clipboard.writeText(m.content.replace(/\[\[cite:[^\]]*\]\]/g, ''));
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
    await patchConversation(id, { title });
  }

  /** Browser dictation where it exists; silently absent where it does not. */
  function toggleDictation() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      | (new () => {
          continuous: boolean;
          interimResults: boolean;
          lang: string;
          start: () => void;
          stop: () => void;
          onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
          onend: (() => void) | null;
          onerror: (() => void) | null;
        })
      | undefined;

    if (!Ctor) {
      setBanner({ text: 'This browser has no built-in dictation.', kind: 'warn' });
      return;
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      let heard = '';
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
      setDraft(heard.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognition.current = rec;
    rec.start();
    setListening(true);
  }

  /* --------------------------------------------------------------- render */

  const canSend = !busy && (draft.trim().length > 0 || attachments.length > 0);
  const initial = (me.displayName || me.email).charAt(0).toUpperCase();
  const listed = results ?? conversations;
  const sources = files.map((f) => ({ id: f.id, filename: f.filename }));
  const currentProject = projects.find((p) => p.id === projectId) ?? null;

  const optionLabel = (options: Option[] | undefined, id: string | undefined) =>
    options?.find((o) => o.id === id)?.label ?? id ?? '';

  const picker = (
    kind: 'model' | 'thinking' | 'style',
    options: Option[],
    selected: string,
  ) => (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setMenu(menu === kind ? null : kind);
        }}
        className="rounded-[6px] border border-line px-2 py-1 text-[13px] text-ink-dim hover:bg-raised hover:text-ink"
      >
        {optionLabel(options, selected)} ⌄
      </button>
      {menu === kind ? (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full left-0 z-20 mb-1.5 w-60 overflow-hidden rounded-xl border border-line bg-panel shadow-xl"
        >
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => applySetting(kind, o.id)}
              className={`block w-full px-3 py-2 text-left hover:bg-raised ${
                o.id === selected ? 'bg-raised' : ''
              }`}
            >
              <div className="text-[13px] font-medium">{o.label}</div>
              {o.blurb ? <div className="text-[11.5px] text-ink-faint">{o.blurb}</div> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  const versionNav = (m: ThreadMessage) =>
    m.versionCount > 1 ? (
      <span className="flex items-center gap-1 text-[11.5px] text-ink-faint">
        <button
          disabled={m.version === 1 || busy}
          onClick={() => switchVersion(m.versionIds[m.version - 2])}
          className="px-0.5 hover:text-ink disabled:opacity-30"
        >
          ‹
        </button>
        <span className="tabular-nums">
          {m.version}/{m.versionCount}
        </span>
        <button
          disabled={m.version === m.versionCount || busy}
          onClick={() => switchVersion(m.versionIds[m.version])}
          className="px-0.5 hover:text-ink disabled:opacity-30"
        >
          ›
        </button>
      </span>
    ) : null;

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* The drawer backdrop. Only ever present below md, where the sidebar
          floats over the thread instead of sitting beside it. */}
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close the menu"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/55 md:hidden"
        />
      ) : null}

      {confirmDialog}

      {/* ------------------------------------------------------ sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] shrink-0 flex-col gap-2.5 border-r border-line-soft bg-panel p-3 transition-transform duration-200 md:static md:z-auto md:max-w-none md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2.5 px-1.5 pt-1 pb-2.5 text-[16px] font-semibold tracking-tight">
          <Mark size={19} />
          {APP_NAME}
        </div>

        <button
          onClick={startNew}
          className={btn('secondary','md','w-full justify-start font-medium')}
        >
          ＋ New chat
        </button>

        <Link
          href="/reviews"
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-dim no-underline hover:bg-raised hover:text-ink"
        >
          ▣ Reviews
        </Link>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowSettings(true)}
            className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-raised hover:text-ink"
          >
            ⚙ Settings
          </button>
          {me.role === 'admin' ? (
            <Link
              href="/admin"
              className="rounded-lg px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-raised hover:text-ink"
            >
              Admin
            </Link>
          ) : null}
        </div>

        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats…"
          className="w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] outline-none placeholder:text-ink-faint focus:border-[#3c4653]"
        />

        {/* -------------------------------------------------- projects */}
        <div className="flex items-center justify-between px-2.5 pt-1 text-[11.5px] font-semibold text-ink-faint">
          <span>Projects</span>
          <button
            title="New project"
            aria-label="New project"
            onClick={async () => {
              const name = prompt('Name this project');
              if (!name?.trim()) return;
              const res = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              });
              if (res.ok) {
                const created = await res.json();
                await loadProjects();
                setOpenProject(created.id);
              }
            }}
            className="hover:text-ink"
          >
            ＋
          </button>
        </div>

        <div className="flex max-h-40 flex-col gap-px overflow-y-auto">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] ${
                p.id === projectId ? 'bg-raised text-ink' : 'text-ink-dim hover:bg-raised hover:text-ink'
              }`}
            >
              <button
                onClick={() => {
                  setProjectId(p.id);
                  startNew();
                }}
                className="flex-1 truncate text-left"
                title={`${p.chatCount} chats · ${p.docCount} documents`}
              >
                ▤ {p.name}
              </button>
              <button
                onClick={() => setOpenProject(p.id)}
                title="Project settings"
                aria-label="Project settings"
                className="px-1 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-accent"
              >
                ⚙
              </button>
            </div>
          ))}
          {projects.length === 0 ? (
            <div className="px-2.5 py-1 text-[13px] text-ink-faint">None yet</div>
          ) : null}
        </div>

        {/* ----------------------------------------------------- chats */}
        <div className="flex items-center justify-between px-2.5 pt-1 pb-1 text-[11.5px] font-semibold text-ink-faint">
          <span>
            {results
              ? `${results.length} match${results.length === 1 ? '' : 'es'}`
              : showArchived
                ? 'Archived'
                : 'Recent chats'}
          </span>
          <button onClick={() => setShowArchived((v) => !v)} className="hover:text-ink">
            {showArchived ? 'Back' : 'Archive'}
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-px overflow-y-auto">
          {listed.length === 0 ? (
            <div className="p-3 text-center text-[13px] text-ink-faint">
              {results ? 'Nothing found' : showArchived ? 'Nothing archived' : 'No chats yet'}
            </div>
          ) : (
            listed.map((c) => (
              <div
                key={c.id}
                className={`group rounded-lg px-2.5 py-1.5 text-[13px] ${
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
                        {c.starred ? '★ ' : ''}
                        {c.title}
                      </button>
                      <button
                        onClick={() => patchConversation(c.id, { starred: !c.starred })}
                        title={c.starred ? 'Unstar' : 'Star'}
                        className={`px-1 hover:text-accent ${
                          c.starred ? 'text-accent' : 'text-ink-faint opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        ★
                      </button>
                      <button
                        onClick={() => patchConversation(c.id, { archived: !showArchived })}
                        title={showArchived ? 'Unarchive' : 'Archive'}
                        className="px-1 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-accent"
                      >
                        ▢
                      </button>
                      <button
                        onClick={async () => {
                          ask({
                            title: `Delete "${c.title}"?`,
                            body: 'The whole thread goes, including anything attached to it. This cannot be undone.',
                            confirmLabel: 'Delete',
                            destructive: true,
                            onConfirm: async () => {
                              await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
                              if (conversationId === c.id) startNew();
                              loadConversations();
                            },
                          });
                        }}
                        title="Delete"
                        aria-label="Delete"
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
          <div className="grid h-6.5 w-6.5 place-items-center rounded-full bg-accent text-[13px] font-bold text-accent-ink">
            {initial}
          </div>
          <div className="flex-1 overflow-hidden">
            <div className="truncate font-medium">{me.displayName}</div>
            <div className="text-ink-faint">{me.role === 'admin' ? 'Admin' : 'Member'}</div>
          </div>
          <form action={doSignOut}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
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
        {/* The phone header. The drawer has no other way in, so unlike the
            context strip below it this bar is always present. */}
        <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-2 md:hidden">
          <button
            type="button"
            aria-label="Open the menu"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line text-ink-dim hover:bg-raised hover:text-ink"
          >
            ☰
          </button>
          <span className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
            <Mark size={16} />
            {APP_NAME}
          </span>
        </div>

        {conversationId || currentProject ? (
          <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-2 text-[13px] text-ink-faint sm:px-6">
            {currentProject ? (
              <button onClick={() => setOpenProject(currentProject.id)} className="hover:text-ink">
                ▤ {currentProject.name}
              </button>
            ) : null}
            {files.length ? (
              <span>
                {files.length} document{files.length === 1 ? '' : 's'} in context
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-2.5">
              {conversationId ? (
                <a href={`/api/export?conversationId=${conversationId}`} className="hover:text-ink">
                  Export
                </a>
              ) : null}
            </div>
          </div>
        ) : null}

        <div ref={threadRef} className="flex-1 overflow-y-auto px-4 pt-7 pb-2 sm:px-6">
          <div className="mx-auto max-w-[780px]">
            {messages.length === 0 && streamText === null ? (
              <div className="grid h-full place-content-center pb-24 text-center">
                <div className="mb-4 flex justify-center opacity-80">
                  <Mark size={34} />
                </div>
                <h1 className="mb-2.5 text-[30px] font-normal tracking-tight">How can I help?</h1>
                <p className="mx-auto max-w-[460px] text-ink-dim">
                  {currentProject
                    ? `Working in ${currentProject.name}. Its instructions and documents apply to this chat.`
                    : 'Ask anything. Attach a PDF, Word, Excel, CSV or an image and I will read it first.'}
                </p>
              </div>
            ) : null}

            {messages.map((m) => (
              <div key={m.id} className="group mb-6">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[11.5px] font-semibold tracking-wide text-ink-faint">
                    {m.role === 'user' ? 'You' : 'Assistant'}
                  </span>
                  {m.role === 'assistant' && m.model ? (
                    <span className="text-[11.5px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
                      {optionLabel(pickers?.models, m.model)}
                    </span>
                  ) : null}
                  {versionNav(m)}
                </div>

                {m.role === 'user' ? (
                  editing === m.id ? (
                    <div className="rounded-xl border border-accent bg-raised px-3 py-2.5">
                      <textarea
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={Math.min(12, editDraft.split('\n').length + 1)}
                        className="w-full resize-y bg-transparent text-[14px] outline-none"
                      />
                      <div className="mt-2 flex justify-end gap-2 text-[13px]">
                        <button
                          onClick={() => setEditing(null)}
                          className="rounded-[6px] border border-line px-2.5 py-1 hover:bg-raised-hover"
                        >
                          Cancel
                        </button>
                        <button
                          disabled={!editDraft.trim()}
                          onClick={() => {
                            const text = editDraft.trim();
                            setEditing(null);
                            run('edit', { question: text, messageId: m.id });
                          }}
                          className="rounded-[6px] bg-accent px-2.5 py-1 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-40"
                        >
                          Send
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-xl border border-line bg-raised px-4 py-3 whitespace-pre-wrap">
                        {m.content}
                      </div>
                      <div className="mt-1 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => copyMessage(m)}
                          className="rounded border border-line px-1.5 py-0.5 text-[11.5px] text-ink-faint hover:text-ink"
                        >
                          {copied === m.id ? 'Copied' : 'Copy'}
                        </button>
                        {m.id.startsWith('local-') ? null : (
                          <button
                            onClick={() => {
                              setEditing(m.id);
                              setEditDraft(m.content);
                            }}
                            className="rounded border border-line px-1.5 py-0.5 text-[11.5px] text-ink-faint hover:text-ink"
                          >
                            Edit
                          </button>
                        )}
                      </div>
                    </>
                  )
                ) : (
                  <>
                    {m.thinking ? <Thinking text={m.thinking} /> : null}
                    <ToolPanel runs={m.toolRuns} />
                    <Markdown
                      text={
                        continuingId === m.id && streamText !== null
                          ? m.content + streamText
                          : m.content
                      }
                      streaming={continuingId === m.id}
                      sources={sources}
                    />

                    {m.finish === 'length' || m.finish === 'aborted' ? (
                      <button
                        disabled={busy}
                        onClick={() => run('continue', { messageId: m.id })}
                        className={btn('secondary','sm','mt-2')}
                      >
                        {m.finish === 'length' ? 'Continue' : 'Continue from where it stopped'}
                      </button>
                    ) : null}

                    <div className="mt-1.5 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => copyMessage(m)}
                        className="rounded border border-line px-1.5 py-0.5 text-[11.5px] text-ink-faint hover:text-ink"
                      >
                        {copied === m.id ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => run('retry', { messageId: m.id })}
                        className="rounded border border-line px-1.5 py-0.5 text-[11.5px] text-ink-faint hover:text-ink disabled:opacity-40"
                      >
                        Retry
                      </button>
                      <button
                        onClick={() => vote(m.id, 1)}
                        title="Good answer"
                        aria-label="Good answer"
                        className={`rounded border border-line px-1.5 py-0.5 text-[11.5px] hover:text-ink ${
                          m.vote === 1 ? 'text-accent' : 'text-ink-faint'
                        }`}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => vote(m.id, -1)}
                        title="Bad answer"
                        aria-label="Bad answer"
                        className={`rounded border border-line px-1.5 py-0.5 text-[11.5px] hover:text-ink ${
                          m.vote === -1 ? 'text-sev-blocking' : 'text-ink-faint'
                        }`}
                      >
                        ↓
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}

            {/* A fresh answer being written. A continue streams into the message
                above instead, so this is skipped while one is running. */}
            {streamText !== null && !continuingId ? (
              <div className="mb-6">
                <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-faint">
                  Assistant
                </div>
                <Thinking text={streamThinking} streaming={!streamText} />
                <ToolPanel runs={streamTools} streaming={!streamText} />
                {streamText ? (
                  <Markdown text={streamText} streaming sources={sources} />
                ) : streamThinking ? null : (
                  <div className="text-[13px] text-ink-faint">Working…</div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* ---------------------------------------------------- composer */}
        <div className="px-4 pt-2.5 pb-5 sm:px-6">
          {banner ? (
            <div
              role="alert"
              className={`mx-auto mb-2.5 flex max-w-[780px] items-start gap-3 rounded-lg border px-3 py-2 text-[13px] ${
                banner.kind === 'warn'
                  ? 'border-sev-math/35 bg-sev-math/10 text-[#dcc79a]'
                  : 'border-sev-blocking/35 bg-sev-blocking/10 text-[#e8b0b0]'
              }`}
            >
              <span className="flex-1">{banner.text}</span>
              <button onClick={() => setBanner(null)} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
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
                    className={btn('secondary','sm')}
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
              onPaste={(e) => {
                const pasted = [...e.clipboardData.files];
                if (pasted.length) {
                  e.preventDefault();
                  uploadFiles(pasted);
                  return;
                }
                // A very long paste is a document, and reads far better as one
                // than as a screenful of grey text in the composer.
                const text = e.clipboardData.getData('text');
                if (text.length > PASTE_AS_FILE_THRESHOLD) {
                  e.preventDefault();
                  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                  uploadFiles([
                    new File([text], `pasted-${stamp}.txt`, { type: 'text/plain' }),
                  ]);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Ask anything, or attach a file…"
              className="max-h-[220px] min-h-[26px] w-full resize-none bg-transparent outline-none placeholder:text-ink-faint"
            />

            <div className="mt-2 flex items-center gap-2">
              <ComposerMenu
                onAddFiles={() => fileRef.current?.click()}
                onScreenshot={takeScreenshot}
                projects={projects}
                projectId={projectId}
                onSetProject={setConversationProject}
                connectors={availableConnectors.map((c) => ({
                  id: c.id,
                  label: c.name,
                  detail: c.detail ?? `${c.toolCount} tool${c.toolCount === 1 ? '' : 's'}`,
                }))}
                activeConnectors={settings?.connectors ?? []}
                onToggleConnector={toggleConnector}
                hasDocuments={files.length > 0}
                skills={availableSkills.map((sk) => ({
                  id: sk.id,
                  label: sk.name,
                  detail: sk.scope === 'firm' ? 'firm' : 'yours',
                }))}
                pinnedSkills={settings?.skills ?? []}
                onToggleSkill={toggleSkill}
                styles={(pickers?.styles ?? []).map((s) => ({ id: s.id, label: s.label }))}
                styleId={settings?.style ?? 'normal'}
                onSetStyle={(id) => applySetting('style', id)}
                memoryEnabled={memoryEnabled}
                onToggleMemory={toggleMemory}
                onOpenSettings={() => setShowSettings(true)}
              />

              <span className="text-[13px] text-ink-faint">
                {uploading ? `Uploading ${uploading} file(s)…` : ''}
              </span>

              <div className="ml-auto flex items-center gap-2">
                {/* What changes an answer every time stays outside the menu. */}
                {pickers && settings ? (
                  <>
                    {picker('model', pickers.models, settings.model)}
                    {picker('thinking', pickers.thinkingLevels, settings.thinking)}
                  </>
                ) : null}

                <button
                  onClick={toggleDictation}
                  title="Dictate"
                  aria-label="Dictate"
                  className={`grid h-7.5 w-7.5 place-items-center rounded-lg border text-[13px] leading-none hover:bg-raised ${
                    listening ? 'border-accent text-accent' : 'border-line text-ink-dim hover:text-ink'
                  }`}
                >
                  ●
                </button>

                {busy ? (
                  <button
                    onClick={() => chatAbort.current?.abort()}
                    className={btn('secondary')}
                  >
                    ■ Stop
                  </button>
                ) : (
                  <button
                    onClick={send}
                    disabled={!canSend}
                    className={btn('primary')}
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="mx-auto mt-2 max-w-[780px] text-center text-[13px] text-ink-faint">
            AI can make mistakes — check anything that matters.
            {' · '}
            <span title={`provider: ${me.provider}`}>
              {optionLabel(pickers?.models, settings?.model ?? me.model)}
            </span>
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

      {showSettings ? (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            loadPickers();
            if (conversationId) loadConversation(conversationId);
          }}
        />
      ) : null}

      {openProject ? (
        <ProjectPanel
          projectId={openProject}
          onClose={() => setOpenProject(null)}
          onChanged={() => {
            loadProjects();
            if (conversationId) loadConversation(conversationId);
          }}
          onOpenChat={openConversation}
        />
      ) : null}
    </div>
  );
}
