import 'server-only';

import type { TranscriptionProvider } from './provider';
import type { AudioTranscriptionOptions, AudioTranscriptionResult } from './types';
import { DEFAULT_GEMINI_MODEL, GeminiTranscriptionProvider } from './gemini-provider';
import { runWithGeminiKeyPool } from '../gemini-key-pool/service';

export class PooledGeminiTranscriptionProvider implements TranscriptionProvider {
  public readonly name = 'GEMINI';
  public readonly model: string;
  private readonly explicitApiKey?: string;
  private readonly customFetch?: typeof fetch;

  constructor(options?: { apiKey?: string; model?: string; fetch?: typeof fetch }) {
    this.explicitApiKey = options?.apiKey;
    this.model = options?.model || process.env.GEMINI_TRANSCRIPTION_MODEL || DEFAULT_GEMINI_MODEL;
    this.customFetch = options?.fetch;
  }

  async transcribe(
    audioBuffer: Buffer,
    fileName: string,
    mimeType: string,
    options?: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResult> {
    if (this.explicitApiKey) {
      return new GeminiTranscriptionProvider({
        apiKey: this.explicitApiKey,
        model: this.model,
        fetch: this.customFetch,
      }).transcribe(audioBuffer, fileName, mimeType, options);
    }

    return runWithGeminiKeyPool({
      fallbackKey: process.env.GEMINI_API_KEY,
      rateLimitCode: 'GEMINI_RATE_LIMITED',
      authErrorCode: 'GEMINI_AUTH_ERROR',
      invoke: (apiKey) =>
        new GeminiTranscriptionProvider({
          apiKey,
          model: this.model,
          fetch: this.customFetch,
        }).transcribe(audioBuffer, fileName, mimeType, options),
    });
  }
}
