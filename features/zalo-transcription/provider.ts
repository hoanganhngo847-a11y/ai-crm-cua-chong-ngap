import 'server-only';
import type { AudioTranscriptionOptions, AudioTranscriptionResult, RawUtteranceSegment } from './types';
import { MAX_PROVIDER_AUDIO_BYTES } from './audio-splitter';

export interface TranscriptionProvider {
  name: string;
  readonly model?: string;
  transcribe(
    audioBuffer: Buffer,
    fileName: string,
    mimeType: string,
    options?: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResult>;
}

/**
 * OpenAI Whisper transcription provider.
 *
 * Configuration:
 * - OPENAI_API_KEY: Required server-only env var. Never logged or printed.
 * - OPENAI_TRANSCRIPTION_MODEL: Optional override. Default is 'whisper-1' — the only documented
 *   model that supports verbose_json response format with segment-level timestamps.
 *   Do NOT change the default to gpt-4o-transcribe or other models without verifying
 *   that they support the verbose_json response format with segments[].
 *
 * Audio size limit:
 * - OpenAI accepts up to 25 MB per upload request.
 * - Files exceeding MAX_PROVIDER_AUDIO_BYTES are rejected BEFORE upload with AUDIO_TOO_LARGE.
 * - Phase 1 limitation: no chunked upload support. Oversized files fail permanently.
 */
export class OpenAITranscriptionProvider implements TranscriptionProvider {
  public readonly name = 'OPENAI';
  public readonly model: string;
  private readonly apiKey?: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    this.apiKey = options?.apiKey || process.env.OPENAI_API_KEY;
    // Default to 'whisper-1' — the documented model that supports verbose_json with segments.
    // See: https://developers.openai.com/api/docs/guides/speech-to-text
    this.model = options?.model || process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
  }

  async transcribe(
    audioBuffer: Buffer,
    fileName: string,
    mimeType: string,
    options?: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResult> {
    if (!this.apiKey) {
      throw new Error('TRANSCRIPTION_NOT_CONFIGURED');
    }

    // Pre-upload size gate: reject files exceeding OpenAI's 25 MB limit.
    // This is a permanent error — the mono channel file from this recording is simply too large.
    // Original recording is NEVER deleted.
    if (audioBuffer.length > MAX_PROVIDER_AUDIO_BYTES) {
      throw new Error('AUDIO_TOO_LARGE');
    }

    const form = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
    form.set('file', blob, fileName);
    form.set('model', this.model);
    form.set('response_format', 'verbose_json');

    const targetLang = options?.language?.trim();
    if (targetLang && targetLang !== 'auto') {
      form.set('language', targetLang);
    }

    if (options?.prompt) {
      form.set('prompt', options.prompt);
    }

    let response: Response;
    try {
      const defaultTimeoutSignal = AbortSignal.timeout(120_000);
      const requestSignal = options?.signal
        ? (typeof AbortSignal.any === 'function'
            ? AbortSignal.any([defaultTimeoutSignal, options.signal])
            : options.signal)
        : defaultTimeoutSignal;

      response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
        signal: requestSignal,
      });
    } catch (networkErr: unknown) {
      const msg = networkErr instanceof Error ? networkErr.message : 'Unknown network failure';
      if (/timeout|aborted/i.test(msg)) {
        throw new Error('TRANSCRIPTION_TIMEOUT');
      }
      throw new Error('TRANSCRIPTION_NETWORK_ERROR');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('TRANSCRIPTION_PROVIDER_AUTH_ERROR');
      }
      if (response.status === 429) {
        throw new Error('TRANSCRIPTION_RATE_LIMITED');
      }
      if (response.status >= 500) {
        throw new Error('TRANSCRIPTION_PROVIDER_UNAVAILABLE');
      }
      throw new Error(`TRANSCRIPTION_PROVIDER_FAILED_${response.status}`);
    }

    interface VerboseJsonSegment {
      id?: number | string;
      start: number;
      end: number;
      text: string;
      avg_logprob?: number;
    }

    interface VerboseJsonResponse {
      text?: string;
      language?: string;
      duration?: number;
      segments?: VerboseJsonSegment[];
    }

    let result: VerboseJsonResponse;
    try {
      result = (await response.json()) as VerboseJsonResponse;
    } catch {
      throw new Error('TRANSCRIPTION_INVALID_RESPONSE');
    }

    const fullText = (result.text || '').trim();
    const language = (result.language || options?.language || 'vi').toLowerCase();
    const segments: RawUtteranceSegment[] = [];

    if (Array.isArray(result.segments) && result.segments.length > 0) {
      for (const seg of result.segments) {
        const segText = (seg.text || '').trim();
        if (!segText) continue;
        const startMs = Math.max(0, Math.round((seg.start ?? 0) * 1000));
        const endMs = Math.max(startMs, Math.round((seg.end ?? seg.start ?? 0) * 1000));
        const confidence =
          typeof seg.avg_logprob === 'number'
            ? Math.max(0, Math.min(1, Math.exp(seg.avg_logprob)))
            : null;

        segments.push({
          start_ms: startMs,
          end_ms: endMs,
          text: segText,
          confidence,
          provider_segment_id: seg.id != null ? String(seg.id) : null,
        });
      }
    } else if (fullText) {
      // Fallback if provider didn't chunk segments
      const durMs = result.duration ? Math.round(result.duration * 1000) : 0;
      segments.push({
        start_ms: 0,
        end_ms: durMs,
        text: fullText,
        confidence: null,
      });
    }

    return {
      text: fullText,
      language,
      segments,
      duration_ms: result.duration ? Math.round(result.duration * 1000) : undefined,
    };
  }
}

/**
 * Mock provider for automated tests and offline simulation.
 * Never performs network requests or spends credits.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  public readonly name: string;
  public readonly model?: string;
  private responses = new Map<string, AudioTranscriptionResult>();
  private defaultResponse: (fileName: string, opts?: AudioTranscriptionOptions) => AudioTranscriptionResult;
  public calls: Array<{ fileName: string; mimeType: string; size: number; options?: AudioTranscriptionOptions }> = [];

  constructor(
    defaultResponse?: (fileName: string, opts?: AudioTranscriptionOptions) => AudioTranscriptionResult,
    options?: { name?: string; model?: string }
  ) {
    this.name = options?.name || 'MOCK';
    this.model = options?.model !== undefined ? options.model : 'mock-model';
    this.defaultResponse =
      defaultResponse ||
      ((fileName) => ({
        text: 'Nội dung bóc băng mẫu',
        language: 'vi',
        segments: [
          {
            start_ms: 0,
            end_ms: 2000,
            text: fileName.includes('customer') ? 'Chào em, tôi cần tư vấn cửa chống ngập' : 'Dạ em chào anh, bên em có các loại cửa inox',
            confidence: 0.95,
          },
        ],
      }));
  }

  setFileResponse(fileName: string, result: AudioTranscriptionResult): void {
    this.responses.set(fileName, result);
  }

  async transcribe(
    audioBuffer: Buffer,
    fileName: string,
    mimeType: string,
    options?: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResult> {
    this.calls.push({ fileName, mimeType, size: audioBuffer.length, options });
    if (this.responses.has(fileName)) {
      return this.responses.get(fileName)!;
    }
    return this.defaultResponse(fileName, options);
  }
}
