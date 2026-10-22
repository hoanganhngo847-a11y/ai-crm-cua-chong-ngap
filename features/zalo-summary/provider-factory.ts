import 'server-only';
import type { SummaryProvider } from './types';
import { PooledGeminiSummaryProvider } from './pooled-gemini-summary-provider';
import { OpenAISummaryProvider } from './openai-summary-provider';

export const DEFAULT_GEMINI_SUMMARY_MODEL = 'gemini-2.5-flash';
export const DEFAULT_OPENAI_SUMMARY_MODEL = 'gpt-4o-mini';

export interface SummaryResolvedConfig {
  provider: 'GEMINI' | 'OPENAI';
  model: string;
}

/**
 * Resolves summary provider and model from explicit options or environment variables.
 *
 * Enforces:
 * - SUMMARY_PROVIDER must be 'GEMINI' or 'OPENAI' (defaults to 'GEMINI').
 * - For GEMINI: uses options.model, or GEMINI_SUMMARY_MODEL env, or DEFAULT_GEMINI_SUMMARY_MODEL.
 * - For OPENAI: uses options.model, or OPENAI_SUMMARY_MODEL env, or DEFAULT_OPENAI_SUMMARY_MODEL.
 * - Unknown or invalid provider fails closed with Error('SUMMARY_PROVIDER_NOT_CONFIGURED').
 * - No automatic fallback from Gemini to OpenAI.
 */
export function resolveSummaryConfig(options?: {
  provider?: string;
  model?: string;
}): SummaryResolvedConfig {
  const rawProvider = (
    options?.provider ||
    process.env.SUMMARY_PROVIDER ||
    'GEMINI'
  ).trim().toUpperCase();

  if (rawProvider === 'GEMINI') {
    const rawModel = (options?.model || process.env.GEMINI_SUMMARY_MODEL || DEFAULT_GEMINI_SUMMARY_MODEL).trim();
    if (!rawModel) throw new Error('SUMMARY_PROVIDER_NOT_CONFIGURED');
    return { provider: 'GEMINI', model: rawModel };
  }

  if (rawProvider === 'OPENAI') {
    const rawModel = (options?.model || process.env.OPENAI_SUMMARY_MODEL || DEFAULT_OPENAI_SUMMARY_MODEL).trim();
    if (!rawModel) throw new Error('SUMMARY_PROVIDER_NOT_CONFIGURED');
    return { provider: 'OPENAI', model: rawModel };
  }

  throw new Error('SUMMARY_PROVIDER_NOT_CONFIGURED');
}

export function createSummaryProvider(options?: {
  provider?: string;
  model?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): SummaryProvider {
  const config = resolveSummaryConfig({
    provider: options?.provider,
    model: options?.model,
  });

  if (config.provider === 'GEMINI') {
    return new PooledGeminiSummaryProvider({
      apiKey: options?.apiKey,
      model: config.model,
      fetch: options?.fetch,
    });
  }

  if (config.provider === 'OPENAI') {
    return new OpenAISummaryProvider({
      apiKey: options?.apiKey,
      model: config.model,
      fetch: options?.fetch,
    });
  }

  throw new Error('SUMMARY_PROVIDER_NOT_CONFIGURED');
}
