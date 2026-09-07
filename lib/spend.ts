import 'server-only';
import { one, getSetting } from './db';

/**
 * The firm's monthly spend cap.
 *
 * The cap has existed in `settings` since the beginning and has been reported
 * by the admin screens all along, but nothing ever enforced it — a number on a
 * dashboard rather than a control. `REVIEW_COST_CEILING_USD` bounds one review;
 * nothing bounded a month, which is the wrong way round: a single expensive
 * return is visible to whoever is running it, and a slow accumulation across
 * every user is exactly the spend nobody is watching.
 *
 * One ledger, deliberately. `usage_records` carries every model call this app
 * makes — chat, titles, and each review stage through `recordUsage` — so the
 * month's total is one SUM rather than a reconciliation between two tables that
 * would drift.
 *
 * Cheap to check: `idx_usage_created` covers the range scan, and the answer is
 * needed once per turn, not once per token.
 */

export interface SpendState {
  monthToDateUsd: number;
  capUsd: number;
  /** A cap of 0 means "no cap", matching how the settings screen reads. */
  capped: boolean;
  exceeded: boolean;
}

function monthStart(now = Date.now()): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function spendState(): Promise<SpendState> {
  const [capRaw, row] = await Promise.all([
    getSetting('monthly_cap_usd', '200'),
    one<{ c: number }>(
      `SELECT COALESCE(SUM(cost_micros), 0) AS c FROM usage_records WHERE created_at >= ?`,
      monthStart(),
    ),
  ]);
  const capUsd = Number(capRaw) || 0;
  const monthToDateUsd = Number(row?.c ?? 0) / 1_000_000;
  const capped = capUsd > 0;
  return { monthToDateUsd, capUsd, capped, exceeded: capped && monthToDateUsd >= capUsd };
}

/**
 * The sentence a person sees when the cap stops them.
 *
 * Says the number, says who can change it, and does not pretend to be a
 * transient error — a retry will not help, and implying otherwise is how
 * somebody sits refreshing instead of asking an admin.
 */
export function capMessage(state: SpendState): string {
  return (
    `This month's model spend has reached $${state.monthToDateUsd.toFixed(2)} against a ` +
    `$${state.capUsd.toFixed(2)} cap, so nothing further will run. An admin can raise the ` +
    'cap in Admin \u2192 Usage & cost.'
  );
}
