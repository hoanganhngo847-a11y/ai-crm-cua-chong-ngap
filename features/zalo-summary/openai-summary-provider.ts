import 'server-only';
import type {
  CallSummaryStructuredOutput,
  SummaryGenerationOptions,
  SummaryProvider,
  SummaryUtterance,
} from './types';
import {
  SUMMARY_SYSTEM_INSTRUCTION,
  buildTranscriptInput,
} from './prompt';
import { validateCallSummaryOutput } from './validation';

export const DEFAULT_OPENAI_SUMMARY_MODEL = 'gpt-4o-mini';

export function mapOpenAiSummaryError(err: unknown): Error {
  if (err && typeof err === 'object') {
    const errorObj = err as {
      message?: string;
      name?: string;
      status?: number;
      statusCode?: number;
    };

    const msg = typeof errorObj.message === 'string' ? errorObj.message : '';
    const name = typeof errorObj.name === 'string' ? errorObj.name : '';

    if (
      msg === 'SUMMARY_PROVIDER_NOT_CONFIGURED' ||
      msg === 'SUMMARY_TRANSCRIPT_EMPTY' ||
      msg === 'SUMMARY_INVALID_RESPONSE' ||
      msg === 'SUMMARY_PROVIDER_TIMEOUT' ||
      msg === 'SUMMARY_PROVIDER_AUTH_ERROR' ||
      msg === 'SUMMARY_PROVIDER_RATE_LIMITED' ||
      msg === 'SUMMARY_PROVIDER_UNAVAILABLE'
    ) {
      return err instanceof Error ? err : new Error(msg);
    }

    if (
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      /abort|timeout/i.test(msg) ||
      /abort|timeout/i.test(name)
    ) {
      return new Error('SUMMARY_PROVIDER_TIMEOUT');
    }

    const status = errorObj.status ?? errorObj.statusCode;
    if (typeof status === 'number') {
      if (status === 401 || status === 403) return new Error('SUMMARY_PROVIDER_AUTH_ERROR');
      if (status === 429) return new Error('SUMMARY_PROVIDER_RATE_LIMITED');
      if (status >= 500 && status <= 599) return new Error('SUMMARY_PROVIDER_UNAVAILABLE');
      if (status >= 400 && status <= 499) return new Error('SUMMARY_INVALID_RESPONSE');
    }

    if (/\b(401|403)\b|unauthorized|forbidden|api key/i.test(msg)) {
      return new Error('SUMMARY_PROVIDER_AUTH_ERROR');
    }
    if (/\b429\b|rate limit|quota/i.test(msg)) {
      return new Error('SUMMARY_PROVIDER_RATE_LIMITED');
    }
    if (/\b5\d{2}\b|unavailable|internal error|network/i.test(msg)) {
      return new Error('SUMMARY_PROVIDER_UNAVAILABLE');
    }
    if (/\b4\d{2}\b|bad request|invalid/i.test(msg)) {
      return new Error('SUMMARY_INVALID_RESPONSE');
    }
  }

  return new Error('SUMMARY_PROVIDER_UNAVAILABLE');
}

export class OpenAISummaryProvider implements SummaryProvider {
  public readonly name = 'OPENAI';
  public readonly model: string;
  private readonly apiKey?: string;
  private readonly customFetch?: typeof fetch;

  constructor(options?: { apiKey?: string; model?: string; fetch?: typeof fetch }) {
    this.apiKey = options?.apiKey || process.env.OPENAI_API_KEY;
    this.model = options?.model || process.env.OPENAI_SUMMARY_MODEL || DEFAULT_OPENAI_SUMMARY_MODEL;
    this.customFetch = options?.fetch;
  }

  async generateSummary(
    utterances: SummaryUtterance[],
    options?: SummaryGenerationOptions
  ): Promise<CallSummaryStructuredOutput> {
    if (!this.apiKey) {
      throw new Error('SUMMARY_PROVIDER_NOT_CONFIGURED');
    }

    if (!utterances || utterances.length === 0) {
      throw new Error('SUMMARY_TRANSCRIPT_EMPTY');
    }

    const transcriptText = buildTranscriptInput(utterances);
    if (!transcriptText || transcriptText.trim().length === 0) {
      throw new Error('SUMMARY_TRANSCRIPT_EMPTY');
    }

    if (options?.signal?.aborted) {
      throw new Error('SUMMARY_PROVIDER_TIMEOUT');
    }

    try {
      const { OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey: this.apiKey,
        fetch: options?.fetch || this.customFetch,
      });

      const completion = await client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM_INSTRUCTION },
            {
              role: 'user',
              content: `Here is the transcript of the call to analyze:\n\n${transcriptText}`,
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        },
        { signal: options?.signal }
      );

      const content = completion.choices[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        throw new Error('SUMMARY_INVALID_RESPONSE');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error('SUMMARY_INVALID_RESPONSE');
      }

      return validateCallSummaryOutput(parsed);
    } catch (err) {
      throw mapOpenAiSummaryError(err);
    }
  }
}
