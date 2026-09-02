import 'server-only';
import { AI_PROVIDER } from '../config';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import type { AiProvider } from './types';

export function getProvider(): AiProvider {
  return AI_PROVIDER === 'anthropic' ? anthropicProvider : openaiProvider;
}

export const microsToUsd = (micros: number): number => micros / 1_000_000;

/** True when the active provider has a usable key. */
export const hasApiKey = (): boolean => getProvider().isConfigured();

export type { AiProvider, Part, ProviderCapabilities, Turn } from './types';
