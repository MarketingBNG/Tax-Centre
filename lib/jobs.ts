import 'server-only';
import { all, one, run } from './db';
import type { StreamEvent } from './types';

/**
 * Reviews run detached from the HTTP request that started them.
 *
 * A review can take minutes. If it lived inside the POST that kicked it off,
 * closing the tab or refreshing would abandon it. Instead the work runs in the
 * background, every event is appended to stream_events, and the browser reads
 * that log through a separate endpoint — so a refresh replays from a cursor
 * rather than starting over.
 */

interface RunningJob {
  controller: AbortController;
  startedAt: number;
}

const globalForJobs = globalThis as unknown as { __trcJobs?: Map<string, RunningJob> };
const jobs: Map<string, RunningJob> = (globalForJobs.__trcJobs ??= new Map());

export function registerJob(reviewId: string): AbortSignal {
  const controller = new AbortController();
  jobs.set(reviewId, { controller, startedAt: Date.now() });
  return controller.signal;
}

export function finishJob(reviewId: string): void {
  jobs.delete(reviewId);
}

export function isRunning(reviewId: string): boolean {
  return jobs.has(reviewId);
}

/** Asks a running review to stop. Returns false if it already finished. */
export function abortJob(reviewId: string): boolean {
  const job = jobs.get(reviewId);
  if (!job) return false;
  job.controller.abort();
  jobs.delete(reviewId);
  return true;
}

export function appendEvent(reviewId: string, event: StreamEvent): void {
  run(
    `INSERT INTO stream_events (review_id, payload, created_at) VALUES (?, ?, ?)`,
    reviewId,
    JSON.stringify(event),
    Date.now(),
  );
}

export interface StoredEvent {
  id: number;
  event: StreamEvent;
}

/** Events after `afterId`, oldest first. */
export function readEvents(reviewId: string, afterId: number): StoredEvent[] {
  return all<{ id: number; payload: string }>(
    `SELECT id, payload FROM stream_events WHERE review_id = ? AND id > ? ORDER BY id LIMIT 500`,
    reviewId,
    afterId,
  ).map((r) => ({ id: r.id, event: JSON.parse(r.payload) as StreamEvent }));
}

export function reviewStatus(reviewId: string): string | null {
  return one<{ status: string }>(`SELECT status FROM reviews WHERE id = ?`, reviewId)?.status ?? null;
}

/** Drops the replay log once a review is finished and read. */
export function pruneEvents(reviewId: string): void {
  run(`DELETE FROM stream_events WHERE review_id = ?`, reviewId);
}
