import 'server-only';

import type {
  CallSummaryStructuredOutput,
  SummaryGenerationOptions,
  SummaryProvider,
  SummaryUtterance,
} from './types';
import {
  DEFAULT_GEMINI_SUMMARY_MODEL,
  GeminiSummaryProvider,
} from './gemini-summary-provider';
import { runWithGeminiKeyPool } from '../gemini-key-pool/service';

export class PooledGeminiSummaryProvider implements SummaryProvider {
  public readonly name = 'GEMINI';
  public readonly model: string;
  private readonly explicitApiKey?: string;
  private readonly customFetch?: typeof fetch;

  constructor(options?: { apiKey?: string; model?: string; fetch?: typeof fetch }) {
    this.explicitApiKey = options?.apiKey;
    this.model = options?.model || process.env.GEMINI_SUMMARY_MODEL || DEFAULT_GEMINI_SUMMARY_MODEL;
    this.customFetch = options?.fetch;
  }

  async generateSummary(
    utterances: SummaryUtterance[],
    options?: SummaryGenerationOptions
  ): Promise<CallSummaryStructuredOutput> {
    if (this.explicitApiKey) {
      return new GeminiSummaryProvider({
        apiKey: this.explicitApiKey,
        model: this.model,
        fetch: this.customFetch,
      }).generateSummary(utterances, options);
    }

    return runWithGeminiKeyPool({
      fallbackKey: process.env.GEMINI_API_KEY,
      rateLimitCode: 'SUMMARY_PROVIDER_RATE_LIMITED',
      authErrorCode: 'SUMMARY_PROVIDER_AUTH_ERROR',
      invoke: (apiKey) =>
        new GeminiSummaryProvider({
          apiKey,
          model: this.model,
          fetch: this.customFetch,
        }).generateSummary(utterances, options),
    });
  }
}
