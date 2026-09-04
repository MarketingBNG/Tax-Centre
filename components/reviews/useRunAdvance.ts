'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Drives a run to completion, one stage per request.
 *
 * The server runs a single stage and returns, because a whole review does not
 * fit in one serverless invocation. So the loop lives here: call advance, read
 * the progress it streams, and call again until the run reports itself
 * finished.
 *
 * Stopping the loop does not stop the run — each stage commits before it
 * returns. Closing the tab mid-review leaves a run paused at a stage boundary,
 * and pressing Resume picks it up from there.
 */

export interface RunProgressEvent {
  type: string;
  stageKey?: string;
  note?: string;
  code?: string;
  severity?: string | null;
  title?: string;
  message?: string;
}

interface AdvanceOutcome {
  type: 'advanced';
  runFinished: boolean;
  runStatus: string;
  stageKey?: string;
  status?: string;
  message?: string;
}

export function useRunAdvance(runId: string, onFinished: () => void) {
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<RunProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  const halt = useCallback(() => {
    stop.current = true;
    void fetch(`/api/review-runs/${runId}/abort`, { method: 'POST' });
  }, [runId]);

  const start = useCallback(async () => {
    stop.current = false;
    setRunning(true);
    setError(null);

    try {
      // Guard against a bug turning into an unbounded spend rather than a
      // visible failure. Eight stages, plus room for retries.
      for (let step = 0; step < 24 && !stop.current; step++) {
        const res = await fetch(`/api/review-runs/${runId}/advance`, { method: 'POST' });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let outcome: AdvanceOutcome | null = null;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }

            if (event.type === 'advanced') {
              outcome = event as unknown as AdvanceOutcome;
            } else {
              setEvents((prev) => [...prev, event as unknown as RunProgressEvent]);
              if (event.type === 'error') setError(String(event.message ?? 'Something went wrong.'));
            }
          }
        }

        if (!outcome) throw new Error('The stage ended without reporting an outcome.');
        if (outcome.message && outcome.status === 'failed') setError(outcome.message);
        if (outcome.runFinished) break;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
      onFinished();
    }
  }, [runId, onFinished]);

  return { running, events, error, start, halt };
}
