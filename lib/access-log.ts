import 'server-only';
import { one, audit } from './db';
import { ACCESS_LOG_WINDOW_MINUTES } from './config';

/**
 * Recording that somebody read a client's review.
 *
 * Every write in this app was already audited; no read was. For a firm that
 * does IRS representation that is the wrong way round — "who looked at this
 * client's file, and when" is the question an enquiry actually asks, and until
 * now nothing could answer it.
 *
 * Windowed rather than per-request, and this is the part worth being explicit
 * about. The run page polls its detail route every four seconds, so logging
 * every read would write thousands of rows a day per open tab and bury the
 * answer in its own noise. One row per person, per client, per window says the
 * same true thing and stays readable. The window is a named constant so the
 * definition is stated rather than inferred from row counts a year from now.
 *
 * Suppression only. An existing row is never updated to extend it — the audit
 * route is explicit that a log an administrator can rewrite is not evidence of
 * anything, and that applies to us writing it too.
 *
 * Deliberately not logged: /advance, /events, /abort and the detail poll. They
 * happen inside a window a `client.opened` row already covers, and the actions
 * that change something have their own audit lines already. If you are tempted
 * to add them, add a test that reads the log instead and see whether it got
 * easier or harder to answer the question.
 *
 * This lives on its own so the per-client access check can absorb it later: the
 * intent is that deciding access and recording it become one function, and no
 * route can read a client without recording it because it cannot get past the
 * decision without going through the same call.
 */

async function loggedRecently(actorId: string, action: string, targetId: string): Promise<boolean> {
  if (ACCESS_LOG_WINDOW_MINUTES <= 0) return false;
  const since = Date.now() - ACCESS_LOG_WINDOW_MINUTES * 60_000;
  const row = await one<{ one: number }>(
    `SELECT 1 AS one FROM audit_log
      WHERE actor_id = ? AND action = ? AND target_id = ? AND at > ?
      LIMIT 1`,
    actorId,
    action,
    targetId,
    since,
  );
  return Boolean(row);
}

export interface ClientReadTarget {
  engagementId: string;
  clientLabel?: string | null;
  /** Set when the read was of a particular run rather than the engagement. */
  runId?: string | null;
}

/** One row per person, per client, per window. */
export async function logClientOpen(actorId: string, target: ClientReadTarget): Promise<void> {
  if (await loggedRecently(actorId, 'client.opened', target.engagementId)) return;
  await audit(actorId, 'client.opened', 'engagement', target.engagementId, {
    clientLabel: target.clientLabel ?? null,
    runId: target.runId ?? null,
    windowMinutes: ACCESS_LOG_WINDOW_MINUTES,
  });
}

/**
 * Taking the whole register as a file.
 *
 * Never deduplicated. Reading a page and walking away with a copy are different
 * acts, the second is the one an enquiry asks about, and it is rare enough that
 * a row per occurrence costs nothing.
 */
export async function logRegisterExport(
  actorId: string,
  input: { runId: string; engagementId: string; registerVersion: number | null },
): Promise<void> {
  await audit(actorId, 'review.register_exported', 'review_run', input.runId, {
    engagementId: input.engagementId,
    registerVersion: input.registerVersion,
  });
}

/**
 * Pulling the list of every client the firm holds.
 *
 * One row, not one per client. The roster read is a single act and it reveals
 * the client list rather than any one review, so recording it per engagement
 * would write two thousand rows to say one thing — and would make the log
 * useless for the question it exists to answer. Deduplicated on the same window
 * as a client open, because the reviews home page is a normal place to sit.
 */
export async function logRosterRead(actorId: string, count: number): Promise<void> {
  if (await loggedRecently(actorId, 'client.roster_read', 'all')) return;
  await audit(actorId, 'client.roster_read', 'engagement_list', 'all', {
    count,
    windowMinutes: ACCESS_LOG_WINDOW_MINUTES,
  });
}

/**
 * A read that was refused. Not deduplicated: rare, and always interesting.
 *
 * Unused until the per-client check lands, and exported now so the vocabulary
 * is defined in one place rather than invented twice.
 */
export async function logAccessDenied(
  actorId: string,
  input: { engagementId: string; reason: string },
): Promise<void> {
  await audit(actorId, 'client.access_denied', 'engagement', input.engagementId, {
    reason: input.reason,
  });
}
