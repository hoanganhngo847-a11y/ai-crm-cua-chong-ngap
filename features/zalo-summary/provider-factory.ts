import 'server-only';
import type { SummaryProvider } from './types';
import { GeminiSummaryProvider } from './gemini-summary-provider';
import { OpenAISummaryProvider } from './openai-summary-provider';

export function createSummaryProvider(options?: {
  provider?: string;
  model?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): SummaryProvider {
  const rawProvider = (
    options?.provider ||
    process.env.SUMMARY_PROVIDER ||
    'GEMINI'
  ).trim().toUpperCase();

  if (rawProvider === 'GEMINI') {
    return new GeminiSummaryProvider({
      apiKey: options?.apiKey,
      model: options?.model,
      fetch: options?.fetch,
    });
  }

  if (rawProvider === 'OPENAI') {
    return new OpenAISummaryProvider({
      apiKey: options?.apiKey,
      model: options?.model,
      fetch: options?.fetch,
    });
  }

  throw new Error('INVALID_SUMMARY_PROVIDER');
}
