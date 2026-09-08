'use client';

import { btn, field } from '../ui';
import { useRef, useState } from 'react';
import type { RunDetail } from './types';

/**
 * The questions for the preparer.
 *
 * Each shows the figure in dispute and what follows from each answer, so
 * somebody can see the consequence before committing to one. The evidence
 * field is not decoration: attaching a document is what actually closes a
 * serious finding, and the form says so rather than letting a preparer discover
 * it after submitting.
 *
 * Questions marked for the client are shown but not answerable here. The
 * platform's job stops at the internal question — a partner writes to the
 * client personally, in their own voice.
 */

function AnswerForm({
  runId,
  questionId,
  onAnswered,
}: {
  runId: string;
  questionId: string;
  onAnswered: () => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ id: string; filename: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of Array.from(list)) form.append('files', file);
      const res = await fetch('/api/files', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      if (data.errors?.length) throw new Error(data.errors[0].error);
      setFiles((prev) => [
        ...prev,
        ...data.files.map((f: { id: string; filename: string }) => ({
          id: f.id,
          filename: f.filename,
        })),
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review-runs/${runId}/questions/${questionId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: text, evidenceFileIds: files.map((f) => f.id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not save the answer');
      onAnswered();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 border-t border-line-soft pt-2.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="The fact, or what the document shows…"
        className={`${field} resize-y`}
      />

      {files.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {files.map((file) => (
            <span
              key={file.id}
              className="inline-flex items-center gap-1 rounded border border-verdict-clear/40 px-1.5 py-0.5 text-[11.5px] text-verdict-clear"
            >
              {file.filename}
              <button
                onClick={() => setFiles((prev) => prev.filter((f) => f.id !== file.id))}
                className="opacity-70 hover:opacity-100"
                aria-label={`Remove ${file.filename}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <div role="alert" className="mt-1.5 text-[11.5px] text-sev-critical">{error}</div>}

      <div className="mt-2 flex items-center gap-2">
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void attach(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => picker.current?.click()}
          disabled={busy}
          className={btn('quiet','sm')}
        >
          Attach evidence
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          className={btn('primary','sm')}
        >
          {busy ? 'Saving…' : 'Answer'}
        </button>

        <span className="ml-auto text-[11.5px] text-ink-faint">
          {files.length === 0
            ? 'Without a document this stays open'
            : `${files.length} document${files.length === 1 ? '' : 's'} attached`}
        </span>
      </div>
    </div>
  );
}

export function QuestionsPanel({
  detail,
  runId,
  onAnswered,
}: {
  detail: RunDetail;
  runId: string;
  onAnswered: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!detail.questions.length) return null;

  const findingCode = (findingId: string | null) =>
    findingId ? detail.findings.find((f) => f.id === findingId)?.code : null;

  // Preparer first: those are answerable from the file now. Client questions
  // are grouped after so a partner can raise them together.
  const ordered = [...detail.questions].sort((a, b) =>
    a.owner === b.owner ? a.code.localeCompare(b.code) : a.owner === 'preparer' ? -1 : 1,
  );

  const open = ordered.filter((q) => q.status === 'open').length;

  return (
    <section className="trc-print-zone rounded-xl border border-line-soft bg-panel px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[13px] font-medium">Questions for the preparer</h2>
        <span className="text-[11.5px] text-ink-faint">
          {open} of {ordered.length} unanswered
        </span>
      </div>

      <ul className="space-y-1.5">
        {ordered.map((question) => {
          const code = findingCode(question.findingId);
          const isOpen = openId === question.id;
          const answered = question.status === 'answered';

          return (
            <li
              key={question.id}
              className={`rounded-lg border px-3 py-2 ${
                answered ? 'border-line-soft opacity-75' : 'border-line-soft'
              }`}
            >
              <div className="flex items-start gap-2.5">
                <span className="shrink-0 pt-0.5 font-mono text-[11.5px] text-ink-faint">
                  {question.code}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px]">{question.question}</div>

                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
                    {code && <span className="font-mono">{code}</span>}
                    {question.figure && <span>{question.figure}</span>}
                    {question.owner === 'client' && (
                      <span className="rounded border border-line px-1.5 py-0.5">
                        needs the client
                      </span>
                    )}
                  </div>

                  {question.branches.length > 0 && !answered && (
                    <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-ink-dim">
                      {question.branches.map((branch, i) => (
                        <li key={i}>
                          <span className="text-ink-faint">If {branch.if}:</span> {branch.then}
                        </li>
                      ))}
                    </ul>
                  )}

                  {question.evidenceNeeded && !answered && (
                    <div className="mt-1 text-[11.5px] text-ink-faint">
                      Evidence needed: {question.evidenceNeeded}
                    </div>
                  )}

                  {answered && (
                    <div className="mt-1.5 rounded-md border border-line-soft px-2 py-1.5 text-[13px] text-ink-dim">
                      {question.answerText}
                    </div>
                  )}

                  {isOpen && !answered && (
                    <AnswerForm
                      runId={runId}
                      questionId={question.id}
                      onAnswered={() => {
                        setOpenId(null);
                        onAnswered();
                      }}
                    />
                  )}
                </div>

                {!answered && question.owner === 'preparer' && !isOpen && (
                  <button
                    onClick={() => setOpenId(question.id)}
                    className={btn('quiet','sm','trc-print-hide shrink-0')}
                  >
                    Answer
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
