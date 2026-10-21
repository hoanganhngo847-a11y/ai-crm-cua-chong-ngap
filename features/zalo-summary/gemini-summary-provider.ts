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

export const DEFAULT_GEMINI_SUMMARY_MODEL = 'gemini-2.5-flash';

/**
 * Maps any error caught during Gemini summary generation to canonical error codes.
 */
export function mapGeminiSummaryError(err: unknown): Error {
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
    if (/\b429\b|quota|rate limit|resource has been exhausted/i.test(msg)) {
      return new Error('SUMMARY_PROVIDER_RATE_LIMITED');
    }
    if (/\b5\d{2}\b|unavailable|internal error|econnreset|econnrefused|enotfound|fetch failed|network/i.test(msg)) {
      return new Error('SUMMARY_PROVIDER_UNAVAILABLE');
    }
    if (/\b4\d{2}\b|bad request|invalid argument|syntax/i.test(msg)) {
      return new Error('SUMMARY_INVALID_RESPONSE');
    }
  }

  return new Error('SUMMARY_PROVIDER_UNAVAILABLE');
}

export class GeminiSummaryProvider implements SummaryProvider {
  public readonly name = 'GEMINI';
  public readonly model: string;
  private readonly apiKey?: string;
  private readonly customFetch?: typeof fetch;

  constructor(options?: { apiKey?: string; model?: string; fetch?: typeof fetch }) {
    this.apiKey = options?.apiKey || process.env.GEMINI_API_KEY;
    this.model = options?.model || process.env.GEMINI_SUMMARY_MODEL || DEFAULT_GEMINI_SUMMARY_MODEL;
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

    const underlyingFetch = options?.fetch || this.customFetch || globalThis.fetch;

    const perCallFetch: typeof fetch = async (input, init) => {
      const rawInitSignal = (init?.signal ?? undefined) || undefined;
      const callerSignal = options?.signal;
      const signalToUse = callerSignal
        ? (rawInitSignal
            ? (typeof AbortSignal.any === 'function'
                ? AbortSignal.any([rawInitSignal, callerSignal])
                : callerSignal)
            : callerSignal)
        : rawInitSignal;

      return underlyingFetch(input, {
        ...init,
        signal: signalToUse,
      });
    };

    try {
      const { GoogleGenAI, Type } = await import('@google/genai');

      const client = new GoogleGenAI({
        apiKey: this.apiKey,
        httpOptions: {
          retryOptions: { attempts: 1 },
          fetch: perCallFetch,
        },
      });

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          customer_needs: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          objections: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          next_actions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          lead_temperature: {
            type: Type.STRING,
            enum: ['HOT', 'WARM', 'COLD'],
          },
          follow_up: {
            type: Type.OBJECT,
            properties: {
              required: { type: Type.BOOLEAN },
              suggested_time: { type: Type.STRING, nullable: true },
              reason: { type: Type.STRING, nullable: true },
            },
            required: ['required'],
          },
          key_points: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          confidence: {
            type: Type.STRING,
            enum: ['LOW', 'MEDIUM', 'HIGH'],
          },
        },
        required: [
          'summary',
          'customer_needs',
          'objections',
          'next_actions',
          'lead_temperature',
          'follow_up',
          'key_points',
          'confidence',
        ],
      };

      const userContent = `Here is the transcript of the call to analyze:\n\n${transcriptText}`;

      const response = await client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: 'user',
            parts: [{ text: userContent }],
          },
        ],
        config: {
          systemInstruction: SUMMARY_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema,
          temperature: 0.1,
          abortSignal: options?.signal,
        },
      });

      const rawText = response.text;
      if (!rawText || rawText.trim().length === 0) {
        throw new Error('SUMMARY_INVALID_RESPONSE');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error('SUMMARY_INVALID_RESPONSE');
      }

      return validateCallSummaryOutput(parsed);
    } catch (err) {
      throw mapGeminiSummaryError(err);
    }
  }
}
