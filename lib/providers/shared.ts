import 'server-only';
import { PRICING } from '../config';
import type { NormalisedUsage } from '../types';

/**
 * Cost in integer millionths of a USD. Never floats for money.
 *
 * `inputTokens` is the uncached remainder, so the total prompt is
 * input + cacheRead. OpenAI charges no premium to write a cache entry, so
 * cacheWriteTokens is always zero and the term is kept only so the shape stays
 * stable if another provider is ever added back.
 */
export function priceMicros(model: string, u: NormalisedUsage): number {
  const rate = PRICING[model];
  if (!rate) {
    // An unknown model must not silently price at zero and hide spend.
    console.warn(`[pricing] no rate for "${model}" — cost will be recorded as 0`);
    return 0;
  }
  const perToken = (usd: number) => usd / 1_000_000;
  return Math.round(
    (u.inputTokens * perToken(rate.in) +
      u.cacheReadTokens * perToken(rate.cachedIn) +
      u.cacheWriteTokens * perToken(rate.in) * 1.25 +
      u.outputTokens * perToken(rate.out)) *
      1_000_000,
  );
}

export const emptyUsage = (): NormalisedUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Sums usage across the rounds of a single turn. */
export const addUsage = (a: NormalisedUsage, b: NormalisedUsage): NormalisedUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
