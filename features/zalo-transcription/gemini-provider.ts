import 'server-only';
import type { AudioTranscriptionOptions, AudioTranscriptionResult, RawUtteranceSegment } from './types';
import type { TranscriptionProvider } from './provider';
import { groupWordsIntoSegments, type GeminiWordAnnotation, GEMINI_MAX_TIMESTAMP_MS } from './word-grouper';
import { MAX_PROVIDER_AUDIO_BYTES } from './audio-splitter';

/** Default Gemini transcription model as per official documentation. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-transcribe';

/** Default aggregate deadline for the entire transcription pipeline (120 seconds). */
export const DEFAULT_AGGREGATE_TIMEOUT_MS = 120_000;

/** Headroom in milliseconds reserved exclusively for cleaning up uploaded files before deadline. */
export const CLEANUP_RESERVE_MS = 10_000;

/** Polling interval when an uploaded file is in PROCESSING state. */
export const FILE_POLL_INTERVAL_MS = 500;

/**
 * Helper to sleep with AbortSignal cancellation support.
 * Guarantees no lingering timers when aborted.
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error('GEMINI_TIMEOUT'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason || new Error('GEMINI_TIMEOUT'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Maps any error caught during Gemini operations to a sanitized, structured error code.
 * Preserves existing domain codes and sanitizes HTTP statuses and network exceptions.
 * Prevents raw payload logs and credential leaks.
 */
export function mapGeminiError(err: unknown): Error {
  if (err && typeof err === 'object') {
    const errorObj = err as {
      message?: string;
      name?: string;
      status?: number;
      statusCode?: number;
    };

    if (errorObj.message) {
      const knownCodes = new Set([
        'GEMINI_NOT_CONFIGURED',
        'AUDIO_TOO_LARGE',
        'GEMINI_AUDIO_TOO_LONG',
        'GEMINI_AUTH_ERROR',
        'GEMINI_RATE_LIMITED',
        'GEMINI_PROVIDER_UNAVAILABLE',
        'GEMINI_TIMEOUT',
        'GEMINI_INVALID_RESPONSE',
        'GEMINI_TIMESTAMP_MISSING',
      ]);
      if (knownCodes.has(errorObj.message)) {
        return err instanceof Error ? err : new Error(errorObj.message);
      }
    }

    // Check for AbortError / Timeout
    if (
      errorObj.name === 'AbortError' ||
      errorObj.name === 'TimeoutError' ||
      errorObj.name === 'RequestTimeoutError' ||
      (typeof errorObj.message === 'string' && /abort|timeout/i.test(errorObj.message)) ||
      (typeof errorObj.name === 'string' && /abort|timeout/i.test(errorObj.name))
    ) {
      return new Error('GEMINI_TIMEOUT');
    }

    // Check structured HTTP status / statusCode
    const status = errorObj.status ?? errorObj.statusCode;
    if (typeof status === 'number') {
      if (status === 401 || status === 403) {
        return new Error('GEMINI_AUTH_ERROR');
      }
      if (status === 429) {
        return new Error('GEMINI_RATE_LIMITED');
      }
      if (status >= 500 && status <= 599) {
        return new Error('GEMINI_PROVIDER_UNAVAILABLE');
      }
      if (status >= 400 && status <= 499) {
        return new Error('GEMINI_INVALID_RESPONSE');
      }
    }

    // Check message string patterns if status is unattached
    const msg = typeof errorObj.message === 'string' ? errorObj.message : '';
    if (/\b(401|403)\b|unauthorized|forbidden|api key/i.test(msg)) {
      return new Error('GEMINI_AUTH_ERROR');
    }
    if (/\b429\b|quota|rate limit|resource has been exhausted/i.test(msg)) {
      return new Error('GEMINI_RATE_LIMITED');
    }
    if (/\b5\d{2}\b|unavailable|internal error|econnreset|econnrefused|enotfound|fetch failed|network/i.test(msg)) {
      return new Error('GEMINI_PROVIDER_UNAVAILABLE');
    }
    if (/\b4\d{2}\b|bad request|invalid argument/i.test(msg)) {
      return new Error('GEMINI_INVALID_RESPONSE');
    }
  }

  return new Error('GEMINI_PROVIDER_UNAVAILABLE');
}

/**
 * Gemini dedicated transcription provider using the Interactions API.
 *
 * Requirements:
 * - Uses official @google/genai SDK (Files API + interactions.create)
 * - Public readonly model configured default 'gemini-3.5-transcribe'
 * - Normalizes audio/mp4 to audio/m4a
 * - Typed generation_config.transcription_config.mode: { type: 'verbatim', timestamp_granularities: ['word'] }
 * - store: false passed to interactions.create
 * - Retries disabled on inference request options and Files transport (retryOptions.attempts: 1)
 * - Composes caller/internal signal via per-call client httpOptions.fetch closure on EVERY request
 * - Bounded aggregate deadline <= 120s with reserved cleanup time
 * - Fresh independent cleanup signal within reserve window (skipped if deadline exhausted; relies on auto-TTL)
 * - Polls FileState.PROCESSING boundedly, rejects FAILED, enforces ACTIVE
 * - Deletes uploaded file handle in finally (even on missing URI or failures)
 * - Strict completed interaction parser rejecting missing/malformed/partial timestamps
 * - Never fabricates silent or 'vi' language
 */
export class GeminiTranscriptionProvider implements TranscriptionProvider {
  public readonly name = 'GEMINI';
  public readonly model: string;
  private readonly apiKey?: string;
  private readonly customFetch?: typeof fetch;

  constructor(options?: { apiKey?: string; model?: string; fetch?: typeof fetch }) {
    this.apiKey = options?.apiKey || process.env.GEMINI_API_KEY;
    this.model = options?.model || process.env.GEMINI_TRANSCRIPTION_MODEL || DEFAULT_GEMINI_MODEL;
    this.customFetch = options?.fetch;
  }

  async transcribe(
    audioBuffer: Buffer,
    fileName: string,
    mimeType: string,
    options?: AudioTranscriptionOptions & { duration_ms?: number; deadline?: number; fetch?: typeof fetch }
  ): Promise<AudioTranscriptionResult> {
    // Pre-network gate 1: API key configuration
    if (!this.apiKey) {
      throw new Error('GEMINI_NOT_CONFIGURED');
    }

    // Pre-network gate 2: Audio byte size limit
    if (audioBuffer.length > MAX_PROVIDER_AUDIO_BYTES) {
      throw new Error('AUDIO_TOO_LARGE');
    }

    // Pre-network gate 3: Audio duration limit (> 30 minutes)
    const callerDurationMs = options?.duration_ms;
    if (typeof callerDurationMs === 'number' && callerDurationMs > GEMINI_MAX_TIMESTAMP_MS) {
      throw new Error('GEMINI_AUDIO_TOO_LONG');
    }

    // Normalize audio/mp4 to audio/m4a as per official Google API specs
    let normalizedMimeType = (mimeType || '').trim().toLowerCase();
    if (normalizedMimeType === 'audio/mp4' || !normalizedMimeType) {
      normalizedMimeType = 'audio/m4a';
    }

    // Calculate aggregate deadlines and cleanup reservation
    const startTime = Date.now();
    const callerDeadline = options?.deadline;
    const overallDeadline =
      typeof callerDeadline === 'number' && Number.isFinite(callerDeadline)
        ? Math.min(callerDeadline, startTime + DEFAULT_AGGREGATE_TIMEOUT_MS)
        : startTime + DEFAULT_AGGREGATE_TIMEOUT_MS;

    const totalWindowMs = overallDeadline - startTime;
    if (totalWindowMs <= CLEANUP_RESERVE_MS) {
      throw new Error('GEMINI_TIMEOUT');
    }

    const activeDeadline = overallDeadline - CLEANUP_RESERVE_MS;
    const activeTimeoutMs = Math.max(0, activeDeadline - Date.now());

    // Active controller for the primary workload (upload, poll, inference)
    const activeController = new AbortController();
    let activeTimer: ReturnType<typeof setTimeout> | undefined;

    if (options?.signal?.aborted) {
      throw new Error('GEMINI_TIMEOUT');
    }

    const onCallerAbort = () => {
      activeController.abort(options?.signal?.reason || new Error('GEMINI_TIMEOUT'));
    };

    if (options?.signal) {
      options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    activeTimer = setTimeout(() => {
      activeController.abort(new Error('GEMINI_TIMEOUT'));
    }, activeTimeoutMs);

    // Explicit deadline and abort signal check for active primary work
    const checkActiveDeadline = () => {
      if (
        options?.signal?.aborted ||
        activeController.signal.aborted ||
        Date.now() >= activeDeadline
      ) {
        throw new Error('GEMINI_TIMEOUT');
      }
    };

    // State for tracking cleanup phase
    let remoteFileName: string | undefined;
    const underlyingFetch = options?.fetch || this.customFetch || globalThis.fetch;

    // Per-call fetch closure composing signals on EVERY request (including raw byte uploads)
    const perCallFetch: typeof fetch = async (input, init) => {
      const rawInitSignal = (init?.signal ?? undefined) || undefined;
      const signalToUse = rawInitSignal
        ? (typeof AbortSignal.any === 'function'
            ? AbortSignal.any([rawInitSignal, activeController.signal])
            : activeController.signal)
        : activeController.signal;

      const response = await underlyingFetch(input, {
        ...init,
        signal: signalToUse,
      });

      // If a chunk upload response succeeds (2xx) but omits the required x-goog-upload-status header,
      // fail fast with GEMINI_INVALID_RESPONSE so the SDK does not enter an unabortable internal chunk retry sleep.
      const reqHeaders = init?.headers
        ? new Headers(init.headers)
        : (input instanceof Request ? input.headers : undefined);
      const uploadCmd = reqHeaders?.get('x-goog-upload-command')?.toLowerCase();
      const isChunkUpload = uploadCmd?.includes('upload');
      if (isChunkUpload && response.ok && !response.headers.get('x-goog-upload-status')) {
        throw new Error('GEMINI_INVALID_RESPONSE');
      }

      return response;
    };

    try {
      checkActiveDeadline();

      // Lazy load @google/genai SDK inside try block to ensure timer/listeners are always cleaned up
      const { GoogleGenAI } = await import('@google/genai');
      const client = new GoogleGenAI({
        apiKey: this.apiKey,
        httpOptions: {
          retryOptions: { attempts: 1 },
          fetch: perCallFetch,
        },
      });

      // Step 1: Upload file to Gemini Files API
      const uploadResult = await client.files.upload({
        file: new Blob([new Uint8Array(audioBuffer)], { type: normalizedMimeType }),
        config: {
          mimeType: normalizedMimeType,
          displayName: fileName,
          abortSignal: activeController.signal,
        },
      });

      // Track known handle immediately, even if missing URI
      if (uploadResult?.name) {
        remoteFileName = uploadResult.name;
      }

      // Explicit deadline recheck after upload completes before starting downstream work
      checkActiveDeadline();

      if (!uploadResult?.name || !uploadResult?.uri) {
        throw new Error('GEMINI_INVALID_RESPONSE');
      }

      const remoteFileNameVerified: string = uploadResult.name;
      const remoteFileUri: string = uploadResult.uri;

      // Step 2: Handle file processing state
      let fileState = uploadResult.state;
      // Reject unknown or malformed file state: must be ACTIVE, PROCESSING, or FAILED
      if (fileState !== 'ACTIVE' && fileState !== 'PROCESSING' && fileState !== 'FAILED') {
        throw new Error('GEMINI_INVALID_RESPONSE');
      }
      if (fileState === 'FAILED') {
        throw new Error('GEMINI_PROVIDER_UNAVAILABLE');
      }

      while (fileState === 'PROCESSING') {
        checkActiveDeadline();

        await abortableDelay(FILE_POLL_INTERVAL_MS, activeController.signal);

        checkActiveDeadline();

        const fileInfo = await client.files.get({
          name: remoteFileNameVerified,
          config: { abortSignal: activeController.signal },
        });

        checkActiveDeadline();

        fileState = fileInfo.state;
        if (fileState !== 'ACTIVE' && fileState !== 'PROCESSING' && fileState !== 'FAILED') {
          throw new Error('GEMINI_INVALID_RESPONSE');
        }
        if (fileState === 'FAILED') {
          throw new Error('GEMINI_PROVIDER_UNAVAILABLE');
        }
      }

      // File must be confirmed ACTIVE before proceeding to inference
      if (fileState !== 'ACTIVE') {
        throw new Error('GEMINI_INVALID_RESPONSE');
      }

      // Step 3: Run inference via dedicated Interactions API
      checkActiveDeadline();

      const interaction = await client.interactions.create(
        {
          model: this.model,
          input: [
            {
              type: 'audio',
              uri: remoteFileUri,
              mime_type: normalizedMimeType,
            },
          ],
          store: false,
          generation_config: {
            transcription_config: {
              mode: {
                type: 'verbatim',
                timestamp_granularities: ['word'],
              },
            },
          },
        },
        {
          signal: activeController.signal,
          retries: { strategy: 'none' },
        }
      );

      // Explicit deadline and abort signal recheck after inference returns before parse or success
      checkActiveDeadline();

      // Step 4: Parse strictly formatted interaction response
      return this.parseInteractionResponse(interaction, options?.language);
    } catch (err: unknown) {
      throw mapGeminiError(err);
    } finally {
      if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = undefined;
      }
      if (options?.signal) {
        options.signal.removeEventListener('abort', onCallerAbort);
      }

      // Step 5: Bounded file cleanup using fresh independent signal within reserve
      // If overallDeadline is exhausted, skip cleanup (rely on Gemini Files API automatic 48h TTL)
      // Otherwise bounded fresh signal strictly within remaining reservation.
      if (remoteFileName) {
        const remainingUntilOverallDeadline = overallDeadline - Date.now();
        const cleanupRemainingMs = Math.min(CLEANUP_RESERVE_MS, remainingUntilOverallDeadline);

        if (cleanupRemainingMs > 0) {
          const fileToClean = remoteFileName;
          const cleanupController = new AbortController();
          const cleanupTimer = setTimeout(() => {
            cleanupController.abort();
          }, cleanupRemainingMs);

          try {
            const { GoogleGenAI } = await import('@google/genai');
            const cleanupClient = new GoogleGenAI({
              apiKey: this.apiKey,
              httpOptions: {
                retryOptions: { attempts: 1 },
                fetch: (input, init) => {
                  const rawInitSignal = (init?.signal ?? undefined) || undefined;
                  const signalToUse = rawInitSignal
                    ? (typeof AbortSignal.any === 'function'
                        ? AbortSignal.any([rawInitSignal, cleanupController.signal])
                        : cleanupController.signal)
                    : cleanupController.signal;
                  return underlyingFetch(input, {
                    ...init,
                    signal: signalToUse,
                  });
                },
              },
            });
            await cleanupClient.files.delete({
              name: fileToClean,
            });
          } catch {
            // Best-effort cleanup per specification; swallow to avoid masking primary error
          } finally {
            clearTimeout(cleanupTimer);
          }
        }
      }
    }
  }

  /**
   * Strictly parse the Interactions API response.
   *
   * Expected structure:
   * interaction.status === "completed"
   * interaction.steps[].content[].annotations[] where type === "word_info"
   *
   * Rejects failed/incomplete/malformed responses, missing timestamps, and partial unannotated text.
   * Never fabricates silent or Vietnamese language.
   */
  private parseInteractionResponse(
    interaction: unknown,
    targetLanguage?: string
  ): AudioTranscriptionResult {
    if (!interaction || typeof interaction !== 'object') {
      throw new Error('GEMINI_INVALID_RESPONSE');
    }

    const interactionRecord = interaction as {
      status?: string;
      steps?: Array<{
        content?: Array<{
          type?: string;
          text?: string;
          annotations?: Array<{
            type?: string;
            text?: string;
            start_offset?: string;
            end_offset?: string;
          }>;
        }>;
      }>;
    };

    if (interactionRecord.status !== 'completed') {
      if (interactionRecord.status === 'failed') {
        throw new Error('GEMINI_PROVIDER_UNAVAILABLE');
      }
      throw new Error('GEMINI_INVALID_RESPONSE');
    }

    if (!Array.isArray(interactionRecord.steps) || interactionRecord.steps.length === 0) {
      throw new Error('GEMINI_INVALID_RESPONSE');
    }

    const wordAnnotations: GeminiWordAnnotation[] = [];
    const stripForComparison = (s: string) => s.normalize('NFC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

    for (const step of interactionRecord.steps) {
      if (!step || typeof step !== 'object') continue;
      if (!Array.isArray(step.content)) continue;

      for (const contentItem of step.content) {
        if (!contentItem || typeof contentItem !== 'object') continue;

        const contentText = typeof contentItem.text === 'string' ? contentItem.text.trim() : '';
        const itemAnnotations: GeminiWordAnnotation[] = [];

        if (Array.isArray(contentItem.annotations)) {
          for (const ann of contentItem.annotations) {
            if (!ann || typeof ann !== 'object') continue;
            if (ann.type !== 'word_info') continue;

            itemAnnotations.push({
              text: typeof ann.text === 'string' ? ann.text : '',
              start_offset: typeof ann.start_offset === 'string' ? ann.start_offset : '',
              end_offset: typeof ann.end_offset === 'string' ? ann.end_offset : '',
            });
          }
        }

        // Strict validation: Reject non-empty text content without usable word annotations
        if (contentText.length > 0 && itemAnnotations.length === 0) {
          throw new Error('GEMINI_TIMESTAMP_MISSING');
        }

        // Verify annotated word text covers content text (fail closed on partial unannotated text)
        if (contentText.length > 0) {
          const strippedContent = stripForComparison(contentText);
          const strippedAnnotations = stripForComparison(itemAnnotations.map((a) => a.text).join(''));
          if (strippedContent.length > 0 && strippedContent !== strippedAnnotations) {
            throw new Error('GEMINI_TIMESTAMP_MISSING');
          }
        }

        for (const ann of itemAnnotations) {
          wordAnnotations.push(ann);
        }
      }
    }

    if (wordAnnotations.length === 0) {
      throw new Error('GEMINI_TIMESTAMP_MISSING');
    }

    const segments: RawUtteranceSegment[] = groupWordsIntoSegments(wordAnnotations);
    if (segments.length === 0) {
      throw new Error('GEMINI_TIMESTAMP_MISSING');
    }

    const fullText = segments.map((s) => s.text).join(' ');
    const durationMs = segments[segments.length - 1].end_ms;

    return {
      text: fullText,
      language: targetLanguage,
      segments,
      duration_ms: durationMs,
    };
  }
}
