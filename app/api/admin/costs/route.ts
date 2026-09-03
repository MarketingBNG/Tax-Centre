import { currentUser, unauthorized, forbidden } from '@/lib/auth';
import { one, all, getSetting } from '@/lib/db';
import { microsToUsd } from '@/lib/providers';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const since = monthStart.getTime();

  const total =
    (await one<{ c: number }>(
      `SELECT COALESCE(SUM(cost_micros), 0) AS c FROM usage_records WHERE created_at >= ?`,
      since,
    ))?.c ?? 0;

  const byUser = await all<{ email: string; display_name: string; cost: number; calls: number }>(
    `SELECT u.email, u.display_name,
            COALESCE(SUM(ur.cost_micros), 0) AS cost, COUNT(*) AS calls
     FROM usage_records ur JOIN users u ON u.id = ur.user_id
     WHERE ur.created_at >= ? GROUP BY u.id ORDER BY cost DESC`,
    since,
  );

  const recent = await all<{
    id: string;
    created_at: number;
    cost_micros: number;
    purpose: string;
    email: string;
    tokens: number;
  }>(
    `SELECT ur.id, ur.created_at, ur.cost_micros, ur.purpose, u.email,
            (ur.input_tokens + ur.output_tokens) AS tokens
     FROM usage_records ur JOIN users u ON u.id = ur.user_id
     ORDER BY ur.created_at DESC LIMIT 30`,
  );

  // The one metric that catches the expensive silent failure: caching works,
  // then a change puts volatile text in the cached prefix and every request
  // pays full price with nothing erroring.
  const cache = await one<{ reads: number; fresh: number; writes: number }>(
    `SELECT COALESCE(SUM(cache_read_tokens),0) AS reads,
            COALESCE(SUM(input_tokens),0) AS fresh,
            COALESCE(SUM(cache_write_tokens),0) AS writes
     FROM usage_records WHERE created_at >= ?`,
    since,
  );
  const denom = (cache?.reads ?? 0) + (cache?.fresh ?? 0) + (cache?.writes ?? 0);

  return Response.json({
    monthToDateUsd: microsToUsd(total),
    capUsd: Number(await getSetting('monthly_cap_usd', '200')),
    byUser: byUser.map((r) => ({ ...r, calls: Number(r.calls), usd: microsToUsd(r.cost) })),
    // BIGINT columns arrive as strings from the driver, and `new Date(string)`
    // on epoch millis yields Invalid Date. Coerce before they reach the client.
    recent: recent.map((r) => ({
      ...r,
      created_at: Number(r.created_at),
      tokens: Number(r.tokens),
      usd: microsToUsd(r.cost_micros),
    })),
    cacheHitRate: denom ? (cache?.reads ?? 0) / denom : 0,
  });
}
