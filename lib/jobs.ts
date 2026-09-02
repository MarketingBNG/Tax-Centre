import 'server-only';
import { all, one, run } from './db';
import type { StreamEvent } from './types';

/**
 * Reviews run detached from the request that started them, and every event is
 * appended to stream_events so the browser can replay from a cursor.
 *
 * On a single long-lived server this could keep the running job in memory. It
 * cannot here: each request may be served by a different instance, so both the
 * stop signal and the "is it still alive" question have to travel through the
 * database.
 */

/* ------------------------------------------------------------- stopping */

export async function requestAbort(reviewId: string): Promise<void> {
  await run(`UPDATE reviews SET abort_requested = 1 WHERE id = ?`, reviewId);
}

export async function isAbortRequested(reviewId: string): Promise<boolean> {
  const row = await one<{ abort_requested: number }>(
    `SELECT abort_requested FROM reviews WHERE id = ?`,
    reviewId,
  );
  return Boolean(Number(row?.abort_requested ?? 0));
}

/**
 * Turns the stop flag into an AbortSignal the provider can use, by polling
 * while a model call is in flight. Two seconds is cheap next to the call, and
 * the caller must stop() it so the interval does not hold the instance open.
 */
export function abortSignalFor(reviewId: string): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setInterval(() => {
    void isAbortRequested(reviewId)
      .then((stopped) => {
        if (stopped) controller.abort();
      })
      // A transient database blip must not kill a running review.
      .catch(() => undefined);
  }, 2000);

  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

/* ------------------------------------------------------------ liveness */

const STALE_AFTER_MS = 120_000;

/**
 * A review is alive while it keeps touching heartbeat_at. Without this, an
 * instance killed mid-review — a deploy, a timeout — would leave the row
 * 'running' forever and the stream would never close.
 */
export async function heartbeat(reviewId: string): Promise<void> {
  await run(`UPDATE reviews SET heartbeat_at = ? WHERE id = ?`, Date.now(), reviewId);
}

export async function isStale(reviewId: string): Promise<boolean> {
  const row = await one<{ heartbeat_at: string | null; created_at: string }>(
    `SELECT heartbeat_at, created_at FROM reviews WHERE id = ?`,
    reviewId,
  );
  if (!row) return true;
  return Date.now() - Number(row.heartbeat_at ?? row.created_at) > STALE_AFTER_MS;
}

/** Closes out a review whose instance died without recording an outcome. */
export async function markStaleFailed(reviewId: string): Promise<void> {
  await run(
    `UPDATE reviews SET status = 'failed', error_text = ?, finished_at = ?
     WHERE id = ? AND status = 'running'`,
    'The review stopped unexpectedly — the server instance running it went away.',
    Date.now(),
    reviewId,
  );
}

/* --------------------------------------------------------- event log */

export async function appendEvent(reviewId: string, event: StreamEvent): Promise<void> {
  await run(
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
export async function readEvents(reviewId: string, afterId: number): Promise<StoredEvent[]> {
  const rows = await all<{ id: string; payload: string }>(
    `SELECT id, payload FROM stream_events WHERE review_id = ? AND id > ? ORDER BY id LIMIT 500`,
    reviewId,
    afterId,
  );
  // BIGSERIAL arrives as a string from the driver; the replay cursor is numeric.
  return rows.map((r) => ({ id: Number(r.id), event: JSON.parse(r.payload) as StreamEvent }));
}

export async function reviewStatus(reviewId: string): Promise<string | null> {
  const row = await one<{ status: string }>(`SELECT status FROM reviews WHERE id = ?`, reviewId);
  return row?.status ?? null;
}

/** Drops the replay log for a finished review. */
export async function pruneEvents(reviewId: string): Promise<void> {
  await run(`DELETE FROM stream_events WHERE review_id = ?`, reviewId);
}
