/**
 * Gemini Dedicated Transcription Provider — Rigorous SDK Transport Mock Suite
 *
 * Verifies real provider behavior by driving the official @google/genai SDK
 * through mock transport (httpOptions.fetch closure).
 *
 * Guarantees:
 * - Synthetic test key only; strictly blocks unknown URLs and OpenAI endpoints.
 * - Tests actual upload initiation, byte chunk upload, polling, interactions inference, and file cleanup.
 * - Tests actual 401/403 (AUTH_ERROR), 429 (RATE_LIMITED), 5xx (PROVIDER_UNAVAILABLE), timeout/abort (TIMEOUT).
 * - Tests bounded file processing polling, failed file rejection, and cleanup of known handles with missing URIs.
 * - Tests strict interaction parsing (rejects malformed/incomplete/missing timestamps, never fabricates silent/vi).
 * - Tests word grouper validation (rejects reversed, out-of-order, overflow >30m, and blank text).
 * - Tests deterministic grouping (pause >1500ms, punctuation, 40-word limit).
 * - Tests Vietnamese and mixed Vietnamese/English transcripts.
 * - Tests channel mapping (LEFT=CUSTOMER, RIGHT=STAFF) with chronological merge.
 * - Verifies zero fallback to OpenAI across all failure scenarios.
 */
import assert from 'node:assert/strict';
import {
  GeminiTranscriptionProvider,
  DEFAULT_GEMINI_MODEL,
  mapGeminiError,
} from '../../features/zalo-transcription/gemini-provider';
import {
  parseDurationToMs,
  groupWordsIntoSegments,
  type GeminiWordAnnotation,
} from '../../features/zalo-transcription/word-grouper';
import { mergeUtterances } from '../../features/zalo-transcription/merger';
import { MAX_PROVIDER_AUDIO_BYTES } from '../../features/zalo-transcription/audio-splitter';

const SYNTHETIC_API_KEY = 'AIzaSySyntheticKeyForTestingOnly000';

interface InterceptedCall {
  method: string;
  url: string;
  headers: Headers;
  bodyText?: string;
  signal?: AbortSignal;
}

interface MockTransportOptions {
  onUploadInitiate?: (call: InterceptedCall) => Response | Promise<Response>;
  onUploadBytes?: (call: InterceptedCall) => Response | Promise<Response>;
  onFileGet?: (call: InterceptedCall) => Response | Promise<Response>;
  onFileDelete?: (call: InterceptedCall) => Response | Promise<Response>;
  onInteractionCreate?: (call: InterceptedCall) => Response | Promise<Response>;
}

/**
 * Creates a mock fetch function that routes SDK requests to controlled mock handlers.
 * Blocks any attempt to reach OpenAI or unknown endpoints.
 */
function createMockTransport(options?: MockTransportOptions) {
  const calls: InterceptedCall[] = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const parsedUrl = new URL(req.url);

    // Security Gate 1: Strict ban on OpenAI endpoints — no fallback allowed
    if (parsedUrl.hostname.includes('openai.com') || parsedUrl.hostname.includes('api.openai.com')) {
      throw new Error(`FATAL: Unauthorized network call to OpenAI detected: ${req.url}`);
    }

    // Security Gate 2: Block unknown URLs outside Google Gemini API - exact hostname check
    if (parsedUrl.hostname !== 'generativelanguage.googleapis.com') {
      throw new Error(`FATAL: Blocked unknown external request to: ${req.url}`);
    }

    const url = req.url;
    const method = req.method;
    const headers = req.headers;
    const signal = req.signal;

    let bodyText: string | undefined;
    try {
      bodyText = await req.clone().text();
    } catch {
      bodyText = undefined;
    }

    const intercepted: InterceptedCall = {
      method,
      url,
      headers,
      bodyText,
      signal,
    };
    calls.push(intercepted);

    // Route 1: Upload initiation
    if (url.includes('/upload/v1beta/files') && !url.includes('upload_id=')) {
      if (options?.onUploadInitiate) {
        return options.onUploadInitiate(intercepted);
      }
      return new Response('', {
        status: 200,
        headers: {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=mock-upload-session-001',
          'x-goog-upload-status': 'active',
          'x-goog-upload-chunk-granularity': '8388608',
        },
      });
    }

    // Route 2: Byte upload chunk
    if (url.includes('upload_id=mock-upload-session-001') || url.includes('/upload/v1beta/files?upload_id=')) {
      if (options?.onUploadBytes) {
        return options.onUploadBytes(intercepted);
      }
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/mock-test-file-001',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/mock-test-file-001',
            state: 'ACTIVE',
            mimeType: 'audio/m4a',
          },
        }),
        {
          status: 200,
          headers: {
            'x-goog-upload-status': 'final',
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // Route 3: Files GET (polling)
    if (method === 'GET' && url.includes('/v1beta/files/')) {
      if (options?.onFileGet) {
        return options.onFileGet(intercepted);
      }
      return new Response(
        JSON.stringify({
          name: 'files/mock-test-file-001',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/mock-test-file-001',
          state: 'ACTIVE',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Route 4: Interactions Create (inference)
    if (method === 'POST' && url.includes('/v1beta/interactions')) {
      if (options?.onInteractionCreate) {
        return options.onInteractionCreate(intercepted);
      }
      return new Response(
        JSON.stringify({
          id: 'int-mock-12345',
          status: 'completed',
          steps: [
            {
              content: [
                {
                  type: 'text',
                  text: 'Dạ em chào anh.',
                  annotations: [
                    { type: 'word_info', text: 'Dạ', start_offset: '0.100s', end_offset: '0.300s' },
                    { type: 'word_info', text: 'em', start_offset: '0.310s', end_offset: '0.500s' },
                    { type: 'word_info', text: 'chào', start_offset: '0.510s', end_offset: '0.800s' },
                    { type: 'word_info', text: 'anh.', start_offset: '0.810s', end_offset: '1.100s' },
                  ],
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Route 5: Files DELETE (cleanup)
    if (method === 'DELETE' && url.includes('/v1beta/files/')) {
      if (options?.onFileDelete) {
        return options.onFileDelete(intercepted);
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unhandled mock request: ${method} ${url}`);
  };

  return { mockFetch, calls };
}

async function main() {
  console.log('=== Starting Gemini Provider Rigorous SDK Transport Tests ===\n');

  // =========================================================================
  // Section 1: Provider Model & Configuration
  // =========================================================================
  {
    console.log('[Test 1] Provider initialization and model defaults');
    const pDefault = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY });
    assert.equal(pDefault.name, 'GEMINI');
    assert.equal(pDefault.model, 'gemini-3.5-transcribe', 'Default model must be gemini-3.5-transcribe');
    assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-transcribe');

    // Constructor override
    const pCustom = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, model: 'gemini-custom-model' });
    assert.equal(pCustom.model, 'gemini-custom-model', 'Constructor override model must take precedence');

    // Environment variable override
    const origEnv = process.env.GEMINI_TRANSCRIPTION_MODEL;
    try {
      process.env.GEMINI_TRANSCRIPTION_MODEL = 'gemini-env-override';
      const pEnv = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY });
      assert.equal(pEnv.model, 'gemini-env-override', 'Env var model must take precedence over default');
    } finally {
      if (origEnv !== undefined) process.env.GEMINI_TRANSCRIPTION_MODEL = origEnv;
      else delete process.env.GEMINI_TRANSCRIPTION_MODEL;
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 2: Pre-Network Validation (Zero Network Calls)
  // =========================================================================
  {
    console.log('[Test 2] Pre-network validation rejects invalid requests before calling fetch');
    const { mockFetch, calls } = createMockTransport();

    // 2a. Missing API key
    const origKey = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      const pNoKey = new GeminiTranscriptionProvider({ fetch: mockFetch });
      await assert.rejects(
        () => pNoKey.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_NOT_CONFIGURED',
        'Missing API key must reject with GEMINI_NOT_CONFIGURED'
      );
    } finally {
      if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey;
    }

    const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });

    // 2b. Audio byte size limit (> 25MB)
    const oversizedBuffer = Buffer.alloc(MAX_PROVIDER_AUDIO_BYTES + 1);
    await assert.rejects(
      () => provider.transcribe(oversizedBuffer, 'huge.m4a', 'audio/m4a'),
      (err: Error) => err.message === 'AUDIO_TOO_LARGE',
      'Buffer exceeding MAX_PROVIDER_AUDIO_BYTES must reject pre-network with AUDIO_TOO_LARGE'
    );

    // 2c. Audio duration limit (> 30 minutes = 1,800,000 ms)
    await assert.rejects(
      () => provider.transcribe(Buffer.from('audio'), 'long.m4a', 'audio/m4a', { duration_ms: 1_800_001 }),
      (err: Error) => err.message === 'GEMINI_AUDIO_TOO_LONG',
      'Audio duration > 30 minutes must reject pre-network with GEMINI_AUDIO_TOO_LONG'
    );

    // 2d. Pre-aborted caller signal
    const preAborted = AbortSignal.abort(new Error('Caller cancelled'));
    await assert.rejects(
      () => provider.transcribe(Buffer.from('audio'), 'cancelled.m4a', 'audio/m4a', { signal: preAborted }),
      (err: Error) => err.message === 'GEMINI_TIMEOUT',
      'Pre-aborted signal must reject immediately with GEMINI_TIMEOUT'
    );

    // Verify ZERO network requests were attempted for pre-network rejections
    assert.equal(calls.length, 0, 'No HTTP requests should be dispatched for pre-network failures');
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 3: Successful End-to-End Transcription & MIME Normalization
  // =========================================================================
  {
    console.log('[Test 3] End-to-end transcription with MIME normalization and cleanup');
    const { mockFetch, calls } = createMockTransport();
    const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });

    // Pass audio/mp4 to test normalization to audio/m4a
    const result = await provider.transcribe(
      Buffer.from('stereo-mono-left-channel-bytes'),
      'left_channel.mp4',
      'audio/mp4'
    );

    assert.equal(result.text, 'Dạ em chào anh.');
    assert.equal(result.language, undefined, 'Never fabricate language if omitted by caller');
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].start_ms, 100);
    assert.equal(result.segments[0].end_ms, 1100);
    assert.equal(result.segments[0].text, 'Dạ em chào anh.');
    assert.equal(result.duration_ms, 1100);

    // Verify call sequence: upload initiate -> byte upload -> interactions create -> files delete
    assert.ok(calls.length >= 4, 'Should execute initiate, byte upload, inference, and cleanup');

    // Verify upload initiation normalized to audio/m4a
    const initCall = calls.find((c) => c.url.includes('/upload/v1beta/files') && !c.url.includes('upload_id='));
    assert.ok(initCall, 'Upload initiation must occur');
    assert.equal(initCall.headers.get('x-goog-upload-header-content-type'), 'audio/m4a', 'MIME must normalize audio/mp4 to audio/m4a');

    // Verify interactions.create payload
    const inferCall = calls.find((c) => c.url.includes('/v1beta/interactions'));
    assert.ok(inferCall, 'Inference interaction must occur');
    const inferBody = JSON.parse(inferCall.bodyText || '{}');
    assert.equal(inferBody.model, 'gemini-3.5-transcribe');
    assert.equal(inferBody.store, false, 'store: false must be passed');
    assert.deepEqual(inferBody.generation_config?.transcription_config?.mode, {
      type: 'verbatim',
      timestamp_granularities: ['word'],
    });
    assert.equal(inferBody.input?.[0]?.type, 'audio');
    assert.equal(inferBody.input?.[0]?.uri, 'https://generativelanguage.googleapis.com/v1beta/files/mock-test-file-001');
    assert.equal(inferBody.input?.[0]?.mime_type, 'audio/m4a');

    // Verify cleanup was invoked in finally
    const deleteCall = calls.find((c) => c.method === 'DELETE' && c.url.includes('/v1beta/files/mock-test-file-001'));
    assert.ok(deleteCall, 'Cleanup DELETE must be invoked in finally');
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 4: Polling File Processing State (PROCESSING -> ACTIVE)
  // =========================================================================
  {
    console.log('[Test 4] Bounded polling when upload state is PROCESSING');
    let pollCount = 0;
    const { mockFetch, calls } = createMockTransport({
      onUploadBytes: () =>
        new Response(
          JSON.stringify({
            file: {
              name: 'files/processing-file-002',
              uri: 'https://generativelanguage.googleapis.com/v1beta/files/processing-file-002',
              state: 'PROCESSING', // Initial state PROCESSING
            },
          }),
          { status: 200, headers: { 'x-goog-upload-status': 'final', 'Content-Type': 'application/json' } }
        ),
      onFileGet: () => {
        pollCount++;
        // First poll: still PROCESSING; Second poll: ACTIVE
        const state = pollCount >= 2 ? 'ACTIVE' : 'PROCESSING';
        return new Response(
          JSON.stringify({
            name: 'files/processing-file-002',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/processing-file-002',
            state,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
    const result = await provider.transcribe(Buffer.from('audio'), 'poll.m4a', 'audio/m4a');
    assert.ok(result.text.length > 0);
    assert.ok(pollCount >= 2, 'File polling must occur until ACTIVE');

    // Cleanup confirmed
    const deleteCall = calls.find((c) => c.method === 'DELETE' && c.url.includes('processing-file-002'));
    assert.ok(deleteCall, 'File must be deleted after polling and inference');
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 5: File Processing Failure (FAILED state rejection)
  // =========================================================================
  {
    console.log('[Test 5] Rejection when file processing transitions to FAILED');
    const { mockFetch, calls } = createMockTransport({
      onUploadBytes: () =>
        new Response(
          JSON.stringify({
            file: {
              name: 'files/failed-file-003',
              uri: 'https://generativelanguage.googleapis.com/v1beta/files/failed-file-003',
              state: 'PROCESSING',
            },
          }),
          { status: 200, headers: { 'x-goog-upload-status': 'final', 'Content-Type': 'application/json' } }
        ),
      onFileGet: () =>
        new Response(
          JSON.stringify({
            name: 'files/failed-file-003',
            state: 'FAILED',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
    await assert.rejects(
      () => provider.transcribe(Buffer.from('audio'), 'failed.m4a', 'audio/m4a'),
      (err: Error) => err.message === 'GEMINI_PROVIDER_UNAVAILABLE',
      'File state FAILED must reject with GEMINI_PROVIDER_UNAVAILABLE'
    );

    // Verify cleanup still occurred
    const deleteCall = calls.find((c) => c.method === 'DELETE' && c.url.includes('failed-file-003'));
    assert.ok(deleteCall, 'File must still be cleaned up when processing fails');
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 6: Cleanup of Known Handle Even When URI is Missing
  // =========================================================================
  {
    console.log('[Test 6] Known handle cleaned up even when upload response is missing URI');
    const { mockFetch, calls } = createMockTransport({
      onUploadBytes: () =>
        new Response(
          JSON.stringify({
            file: {
              name: 'files/orphan-no-uri-004',
              // uri is intentionally missing
              state: 'ACTIVE',
            },
          }),
          { status: 200, headers: { 'x-goog-upload-status': 'final', 'Content-Type': 'application/json' } }
        ),
    });

    const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
    await assert.rejects(
      () => provider.transcribe(Buffer.from('audio'), 'orphan.m4a', 'audio/m4a'),
      (err: Error) => err.message === 'GEMINI_INVALID_RESPONSE',
      'Missing URI must throw GEMINI_INVALID_RESPONSE'
    );

    // Verify known handle orphan-no-uri-004 was deleted in finally
    const deleteCall = calls.find((c) => c.method === 'DELETE' && c.url.includes('orphan-no-uri-004'));
    assert.ok(deleteCall, 'Handle with missing URI must still be cleaned up in finally');
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 7: Authentication Errors (401 / 403 => GEMINI_AUTH_ERROR)
  // =========================================================================
  {
    console.log('[Test 7] Auth errors (401/403) map to permanent GEMINI_AUTH_ERROR');

    // 7a. Upload 401
    {
      const { mockFetch } = createMockTransport({
        onUploadInitiate: () => new Response('Unauthorized key', { status: 401 }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_AUTH_ERROR',
        'Upload 401 must map to GEMINI_AUTH_ERROR'
      );
    }

    // 7b. Upload 403 Forbidden
    {
      const { mockFetch } = createMockTransport({
        onUploadBytes: () => new Response('Forbidden resource', { status: 403 }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_AUTH_ERROR',
        'Upload 403 must map to GEMINI_AUTH_ERROR'
      );
    }

    // 7c. Inference 401
    {
      const { mockFetch, calls } = createMockTransport({
        onInteractionCreate: () => new Response('Permission denied', { status: 401 }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_AUTH_ERROR',
        'Inference 401 must map to GEMINI_AUTH_ERROR'
      );
      // Cleanup was called
      assert.ok(calls.some((c) => c.method === 'DELETE'), 'Cleanup must run when inference fails auth');
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 8: Rate Limit Errors (429 => GEMINI_RATE_LIMITED)
  // =========================================================================
  {
    console.log('[Test 8] Rate limit errors (429) map to transient GEMINI_RATE_LIMITED');

    // 8a. Upload 429
    {
      const { mockFetch } = createMockTransport({
        onUploadInitiate: () => new Response('Quota exceeded', { status: 429 }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_RATE_LIMITED',
        'Upload 429 must map to GEMINI_RATE_LIMITED'
      );
    }

    // 8b. Inference 429
    {
      const { mockFetch, calls } = createMockTransport({
        onInteractionCreate: () => new Response('Rate limit reached', { status: 429 }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_RATE_LIMITED',
        'Inference 429 must map to GEMINI_RATE_LIMITED'
      );
      assert.ok(calls.some((c) => c.method === 'DELETE'), 'Cleanup must run when inference is rate limited');
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 9: Server & Network Errors (5xx/network => GEMINI_PROVIDER_UNAVAILABLE)
  // =========================================================================
  {
    console.log('[Test 9] 5xx and network errors map to transient GEMINI_PROVIDER_UNAVAILABLE');

    // 9a. Upload 503
    {
      const { mockFetch } = createMockTransport({
        onUploadInitiate: () => new Response('Service Unavailable', { status: 503 }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_PROVIDER_UNAVAILABLE',
        'Upload 503 must map to GEMINI_PROVIDER_UNAVAILABLE'
      );
    }

    // 9b. Inference 500
    {
      const { mockFetch, calls } = createMockTransport({
        onInteractionCreate: () => new Response('Internal Server Error', { status: 500 }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_PROVIDER_UNAVAILABLE',
        'Inference 500 must map to GEMINI_PROVIDER_UNAVAILABLE'
      );
      assert.ok(calls.some((c) => c.method === 'DELETE'), 'Cleanup must run when inference fails 500');
    }

    // 9c. Network disconnection (ECONNRESET)
    {
      const { mockFetch } = createMockTransport({
        onUploadBytes: () => Promise.reject(new Error('ECONNRESET connection reset by peer')),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'call.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_PROVIDER_UNAVAILABLE',
        'Network error must map to GEMINI_PROVIDER_UNAVAILABLE'
      );
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 10: Cancellation & Deadline Handling (AbortSignal => GEMINI_TIMEOUT)
  // =========================================================================
  {
    console.log('[Test 10] Signal cancellation and deadline bounds');

    // 10a. Signal aborted during byte upload (SDK drops signal natively, our closure enforces it)
    {
      const abortCtrl = new AbortController();
      const { mockFetch } = createMockTransport({
        onUploadBytes: async (call) => {
          abortCtrl.abort(new Error('Caller timeout in byte upload'));
          return new Promise<Response>((_, reject) => {
            if (call.signal?.aborted) {
              reject(new Error('Request aborted'));
              return;
            }
            if (call.signal) {
              call.signal.addEventListener('abort', () => reject(new Error('Request aborted')));
            }
          });
        },
      });

      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'abort_byte.m4a', 'audio/m4a', { signal: abortCtrl.signal }),
        (err: Error) => err.message === 'GEMINI_TIMEOUT',
        'Cancellation during byte upload must map to GEMINI_TIMEOUT'
      );
    }

    // 10b. Signal aborted during inference; cleanup allowed fresh independent signal
    {
      const abortCtrl = new AbortController();
      let cleanupInvoked = false;
      const { mockFetch } = createMockTransport({
        onInteractionCreate: async (call) => {
          abortCtrl.abort(new Error('Inference timeout'));
          return new Promise<Response>((_, reject) => {
            if (call.signal?.aborted) {
              reject(new Error('Request aborted'));
              return;
            }
            if (call.signal) {
              call.signal.addEventListener('abort', () => reject(new Error('Request aborted')));
            }
          });
        },
        onFileDelete: () => {
          cleanupInvoked = true;
          return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      });

      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'abort_inf.m4a', 'audio/m4a', { signal: abortCtrl.signal }),
        (err: Error) => err.message === 'GEMINI_TIMEOUT',
        'Cancellation during inference must map to GEMINI_TIMEOUT'
      );
      assert.ok(cleanupInvoked, 'Cleanup must run with fresh independent signal after inference abort');
    }

    // 10c. Insufficient aggregate deadline window (<= CLEANUP_RESERVE_MS)
    {
      const { mockFetch } = createMockTransport();
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () =>
          provider.transcribe(Buffer.from('audio'), 'tight.m4a', 'audio/m4a', {
            deadline: Date.now() + 5000, // 5s < CLEANUP_RESERVE_MS (10s)
          }),
        (err: Error) => err.message === 'GEMINI_TIMEOUT',
        'Window smaller than cleanup reserve must reject with GEMINI_TIMEOUT'
      );
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 11: Cleanup Failure Swallowed Gracefully
  // =========================================================================
  {
    console.log('[Test 11] Cleanup failure does not mask primary transcription success');
    const { mockFetch } = createMockTransport({
      onFileDelete: () => new Response('Internal error on delete', { status: 500 }),
    });

    const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
    const result = await provider.transcribe(Buffer.from('audio'), 'del_fail.m4a', 'audio/m4a');
    assert.equal(result.text, 'Dạ em chào anh.');
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 12: Strict Interaction Parsing (Reject Malformed / Silent)
  // =========================================================================
  {
    console.log('[Test 12] Strict completed interaction parsing and validation');

    // 12a. Interaction status failed
    {
      const { mockFetch } = createMockTransport({
        onInteractionCreate: () =>
          new Response(JSON.stringify({ status: 'failed' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'status_fail.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_PROVIDER_UNAVAILABLE'
      );
    }

    // 12b. Interaction status incomplete/in_progress
    {
      const { mockFetch } = createMockTransport({
        onInteractionCreate: () =>
          new Response(JSON.stringify({ status: 'incomplete' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'incomplete.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_INVALID_RESPONSE'
      );
    }

    // 12c. Missing steps or empty steps
    {
      const { mockFetch } = createMockTransport({
        onInteractionCreate: () =>
          new Response(JSON.stringify({ status: 'completed', steps: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'empty_steps.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_INVALID_RESPONSE'
      );
    }

    // 12d. Text present but no word annotations (must reject, never fabricate timestamps or silent)
    {
      const { mockFetch } = createMockTransport({
        onInteractionCreate: () =>
          new Response(
            JSON.stringify({
              status: 'completed',
              steps: [{ content: [{ type: 'text', text: 'Chào anh', annotations: [] }] }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });
      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'no_word_info.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_TIMESTAMP_MISSING'
      );
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 13: Word Grouper Validation (Reversed, Out-of-Order, Overflow, Blank)
  // =========================================================================
  {
    console.log('[Test 13] Word grouper rejects invalid timings and blank text');

    // 13a. Reversed timestamp interval (start > end, e.g. start=2000, end=1000)
    assert.throws(
      () =>
        groupWordsIntoSegments([
          { text: 'cửa', start_offset: '2.000s', end_offset: '1.000s' },
        ]),
      (err: Error) => err.message === 'GEMINI_TIMESTAMP_MISSING',
      'Reversed interval must throw GEMINI_TIMESTAMP_MISSING'
    );

    // 13b. Out-of-order monotonic timestamps
    assert.throws(
      () =>
        groupWordsIntoSegments([
          { text: 'tôi', start_offset: '2.000s', end_offset: '2.500s' },
          { text: 'cần', start_offset: '1.500s', end_offset: '1.800s' },
        ]),
      (err: Error) => err.message === 'GEMINI_TIMESTAMP_MISSING',
      'Non-monotonic start offsets must throw GEMINI_TIMESTAMP_MISSING'
    );

    // 13c. Timestamp overflow (> 30 minutes = 1,800,000 ms)
    assert.throws(
      () =>
        groupWordsIntoSegments([
          { text: 'chào', start_offset: '1800.500s', end_offset: '1801.000s' },
        ]),
      (err: Error) => err.message === 'GEMINI_AUDIO_TOO_LONG',
      'Timestamps exceeding 30 minutes must throw GEMINI_AUDIO_TOO_LONG'
    );

    // 13d. Blank or whitespace text
    assert.throws(
      () =>
        groupWordsIntoSegments([
          { text: '   ', start_offset: '0.100s', end_offset: '0.300s' },
        ]),
      (err: Error) => err.message === 'GEMINI_INVALID_RESPONSE',
      'Blank word text must throw GEMINI_INVALID_RESPONSE'
    );

    // 13e. Malformed duration strings
    assert.equal(parseDurationToMs('invalid'), null);
    assert.equal(parseDurationToMs('-1.5s'), null);
    assert.equal(parseDurationToMs('100ms'), null);
    assert.equal(parseDurationToMs(''), null);
    assert.equal(parseDurationToMs(null), null);
    assert.equal(parseDurationToMs('0.100s'), 100);
    assert.equal(parseDurationToMs('1.5s'), 1500);
    assert.equal(parseDurationToMs('120s'), 120000);
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 14: Deterministic Word Grouping (Pause, Punctuation, 40-Word Limit)
  // =========================================================================
  {
    console.log('[Test 14] Deterministic grouping: pause > 1500ms, punctuation, 40 words');

    // 14a. Pause split (> 1500ms gap)
    const pauseWords: GeminiWordAnnotation[] = [
      { text: 'Chào', start_offset: '0.100s', end_offset: '0.400s' },
      { text: 'bạn', start_offset: '0.450s', end_offset: '0.800s' },
      // 2000ms pause (2.800s - 0.800s = 2000ms > 1500ms)
      { text: 'Tôi', start_offset: '2.800s', end_offset: '3.100s' },
      { text: 'muốn', start_offset: '3.150s', end_offset: '3.400s' },
      { text: 'hỏi', start_offset: '3.450s', end_offset: '3.700s' },
    ];
    const pauseSegments = groupWordsIntoSegments(pauseWords);
    assert.equal(pauseSegments.length, 2);
    assert.equal(pauseSegments[0].text, 'Chào bạn');
    assert.equal(pauseSegments[0].start_ms, 100);
    assert.equal(pauseSegments[0].end_ms, 800);
    assert.equal(pauseSegments[1].text, 'Tôi muốn hỏi');
    assert.equal(pauseSegments[1].start_ms, 2800);
    assert.equal(pauseSegments[1].end_ms, 3700);

    // 14b. Sentence punctuation split
    const punctWords: GeminiWordAnnotation[] = [
      { text: 'Alo?', start_offset: '0.100s', end_offset: '0.400s' },
      { text: 'Tôi', start_offset: '0.500s', end_offset: '0.800s' },
      { text: 'nghe.', start_offset: '0.850s', end_offset: '1.200s' },
      { text: 'Bạn', start_offset: '1.300s', end_offset: '1.600s' },
      { text: 'cần', start_offset: '1.650s', end_offset: '1.900s' },
      { text: 'gì!', start_offset: '1.950s', end_offset: '2.200s' },
    ];
    const punctSegments = groupWordsIntoSegments(punctWords);
    assert.equal(punctSegments.length, 3);
    assert.equal(punctSegments[0].text, 'Alo?');
    assert.equal(punctSegments[1].text, 'Tôi nghe.');
    assert.equal(punctSegments[2].text, 'Bạn cần gì!');

    // 14c. 40-word max split
    const longWords: GeminiWordAnnotation[] = [];
    for (let i = 1; i <= 45; i++) {
      const s = ((i - 1) * 0.1).toFixed(3) + 's';
      const e = (i * 0.1).toFixed(3) + 's';
      longWords.push({ text: `từ${i}`, start_offset: s, end_offset: e });
    }
    const longSegments = groupWordsIntoSegments(longWords);
    assert.equal(longSegments.length, 2, 'Should split at 40 words');
    assert.equal(longSegments[0].text.split(' ').length, 40);
    assert.equal(longSegments[1].text.split(' ').length, 5);
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 15: Vietnamese & Mixed Vietnamese/English Transcripts
  // =========================================================================
  {
    console.log('[Test 15] Vietnamese and mixed Vietnamese/English vocabulary');
    const mixedWords: GeminiWordAnnotation[] = [
      { text: 'Bên', start_offset: '0.100s', end_offset: '0.300s' },
      { text: 'em', start_offset: '0.310s', end_offset: '0.500s' },
      { text: 'có', start_offset: '0.510s', end_offset: '0.700s' },
      { text: 'model', start_offset: '0.710s', end_offset: '1.100s' },
      { text: 'cửa', start_offset: '1.110s', end_offset: '1.300s' },
      { text: 'chống', start_offset: '1.310s', end_offset: '1.600s' },
      { text: 'ngập', start_offset: '1.610s', end_offset: '1.800s' },
      { text: 'inox', start_offset: '1.810s', end_offset: '2.100s' },
      { text: '304', start_offset: '2.110s', end_offset: '2.400s' },
      { text: 'không?', start_offset: '2.410s', end_offset: '2.700s' },
    ];
    const segments = groupWordsIntoSegments(mixedWords);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'Bên em có model cửa chống ngập inox 304 không?');
    assert.equal(segments[0].start_ms, 100);
    assert.equal(segments[0].end_ms, 2700);
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 16: Channel Mapping & Chronological Merger Integration
  // =========================================================================
  {
    console.log('[Test 16] Channel mapping (LEFT=CUSTOMER, RIGHT=STAFF) with merger');
    // Customer segments (LEFT channel)
    const customerSegments = [
      { start_ms: 100, end_ms: 1200, text: 'Chào em, nhà anh bị ngập nước.' },
      { start_ms: 3500, end_ms: 5000, text: 'Em báo giá cửa inox 304 giúp anh.' },
    ];
    // Staff segments (RIGHT channel)
    const staffSegments = [
      { start_ms: 1500, end_ms: 3000, text: 'Dạ chào anh, bên em có các dòng tự động.' },
      { start_ms: 5500, end_ms: 7000, text: 'Dạ để em kết bạn Zalo gửi bảng báo giá ạ.' },
    ];

    const merged = mergeUtterances({ customerSegments, staffSegments });
    assert.equal(merged.utterances.length, 4);

    // Verify chronological alternation
    assert.equal(merged.utterances[0].speaker_role, 'CUSTOMER');
    assert.equal(merged.utterances[0].channel, 'LEFT');
    assert.equal(merged.utterances[0].start_ms, 100);

    assert.equal(merged.utterances[1].speaker_role, 'STAFF');
    assert.equal(merged.utterances[1].channel, 'RIGHT');
    assert.equal(merged.utterances[1].start_ms, 1500);

    assert.equal(merged.utterances[2].speaker_role, 'CUSTOMER');
    assert.equal(merged.utterances[2].channel, 'LEFT');
    assert.equal(merged.utterances[2].start_ms, 3500);

    assert.equal(merged.utterances[3].speaker_role, 'STAFF');
    assert.equal(merged.utterances[3].channel, 'RIGHT');
    assert.equal(merged.utterances[3].start_ms, 5500);
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 17: Sanitized Error Codes & Log Redaction
  // =========================================================================
  {
    console.log('[Test 17] Error sanitization preserves codes and protects keys');
    assert.equal(mapGeminiError(new Error('GEMINI_AUTH_ERROR')).message, 'GEMINI_AUTH_ERROR');
    assert.equal(mapGeminiError(new Error('GEMINI_RATE_LIMITED')).message, 'GEMINI_RATE_LIMITED');
    assert.equal(mapGeminiError(new Error('GEMINI_TIMEOUT')).message, 'GEMINI_TIMEOUT');
    assert.equal(mapGeminiError(new Error('GEMINI_INVALID_RESPONSE')).message, 'GEMINI_INVALID_RESPONSE');
    assert.equal(mapGeminiError(new Error('GEMINI_TIMESTAMP_MISSING')).message, 'GEMINI_TIMESTAMP_MISSING');
    assert.equal(mapGeminiError(new Error('GEMINI_AUDIO_TOO_LONG')).message, 'GEMINI_AUDIO_TOO_LONG');
    assert.equal(mapGeminiError(new Error('AUDIO_TOO_LARGE')).message, 'AUDIO_TOO_LARGE');

    // Message with synthetic Google key must NOT leak into sanitized error
    const keyLeakErr = new Error('Request with key AIzaSyFakeKeyFailedWith403: Forbidden');
    const sanitized = mapGeminiError(keyLeakErr);
    assert.equal(sanitized.message, 'GEMINI_AUTH_ERROR');
    assert.ok(!sanitized.message.includes('AIzaSy'), 'Error message must not contain raw API keys');
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 18: Aggregate Deadline Exhausted Rejects GEMINI_TIMEOUT and Skips Cleanup
  // =========================================================================
  {
    console.log('[Test 18] Cleanup skipped when aggregate deadline is exhausted');
    const realNow = Date.now;
    let virtualTime = 1_000_000;
    Date.now = () => virtualTime;

    try {
      const { mockFetch, calls } = createMockTransport({
        onInteractionCreate: () => {
          // Advance virtual time past the overall deadline (120s default)
          virtualTime += 150_000;
          return new Response(
            JSON.stringify({
              id: 'int-mock-timeout-cleanup',
              status: 'completed',
              steps: [
                {
                  content: [
                    {
                      type: 'text',
                      text: 'Dạ em chào anh.',
                      annotations: [
                        { type: 'word_info', text: 'Dạ', start_offset: '0.100s', end_offset: '0.300s' },
                        { type: 'word_info', text: 'em', start_offset: '0.310s', end_offset: '0.500s' },
                        { type: 'word_info', text: 'chào', start_offset: '0.510s', end_offset: '0.800s' },
                        { type: 'word_info', text: 'anh.', start_offset: '0.810s', end_offset: '1.100s' },
                      ],
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        },
      });

      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'auto_ttl.m4a', 'audio/m4a'),
        (err: Error) => {
          assert.equal(err.message, 'GEMINI_TIMEOUT');
          return true;
        },
        'Inference returning after aggregate deadline must reject with GEMINI_TIMEOUT'
      );

      // Verify that NO file delete was dispatched because remaining cleanup reserve was 0
      const deleteCalls = calls.filter((c) => c.method === 'DELETE');
      assert.equal(deleteCalls.length, 0, 'No delete call should be made if deadline is already exhausted');
    } finally {
      Date.now = realNow;
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 18b: Late Active Work Rejected As GEMINI_TIMEOUT But Cleaned Up In Reserve
  // =========================================================================
  {
    console.log('[Test 18b] Late active work rejected as GEMINI_TIMEOUT but cleaned up within reserve');
    const realNow = Date.now;
    let virtualTime = 1_000_000;
    Date.now = () => virtualTime;

    try {
      const { mockFetch, calls } = createMockTransport({
        onInteractionCreate: () => {
          // Advance virtual time past active deadline (110s) but before hard deadline (120s)
          // Default aggregate = 120s, cleanup reserve = 10s -> active deadline = 110s.
          // 115s is late for active work, leaving 5s remaining cleanup reservation.
          virtualTime += 115_000;
          return new Response(
            JSON.stringify({
              id: 'int-mock-late-active',
              status: 'completed',
              steps: [
                {
                  content: [
                    {
                      type: 'text',
                      text: 'Dạ em chào anh.',
                      annotations: [
                        { type: 'word_info', text: 'Dạ', start_offset: '0.100s', end_offset: '0.300s' },
                        { type: 'word_info', text: 'em', start_offset: '0.310s', end_offset: '0.500s' },
                        { type: 'word_info', text: 'chào', start_offset: '0.510s', end_offset: '0.800s' },
                        { type: 'word_info', text: 'anh.', start_offset: '0.810s', end_offset: '1.100s' },
                      ],
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        },
      });

      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'late_active.m4a', 'audio/m4a'),
        (err: Error) => {
          assert.equal(err.message, 'GEMINI_TIMEOUT');
          return true;
        },
        'Late active work returning after active deadline must reject with GEMINI_TIMEOUT'
      );

      // Verify that file delete WAS dispatched because 5s remained before hard deadline
      const deleteCalls = calls.filter((c) => c.method === 'DELETE');
      assert.equal(deleteCalls.length, 1, 'File delete must be dispatched within remaining cleanup reserve');
    } finally {
      Date.now = realNow;
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 19: Chunk Upload Missing x-goog-upload-status Fails Fast
  // =========================================================================
  {
    console.log('[Test 19] Chunk upload missing x-goog-upload-status fails fast as GEMINI_INVALID_RESPONSE');
    const { mockFetch } = createMockTransport({
      onUploadBytes: () =>
        new Response(
          JSON.stringify({
            file: {
              name: 'files/chunk-no-status',
              uri: 'https://generativelanguage.googleapis.com/v1beta/files/chunk-no-status',
              state: 'ACTIVE',
            },
          }),
          {
            status: 200,
            headers: {
              // Intentionally omit x-goog-upload-status header
              'Content-Type': 'application/json',
            },
          }
        ),
    });

    const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
    await assert.rejects(
      () => provider.transcribe(Buffer.from('audio'), 'missing_status.m4a', 'audio/m4a'),
      (err: Error) => err.message === 'GEMINI_INVALID_RESPONSE',
      'Missing x-goog-upload-status on chunk upload must fail fast with GEMINI_INVALID_RESPONSE'
    );
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 20: Unknown or Malformed File State Rejected
  // =========================================================================
  {
    console.log('[Test 20] Unknown/malformed file state rejects with GEMINI_INVALID_RESPONSE');
    const { mockFetch } = createMockTransport({
      onUploadBytes: () =>
        new Response(
          JSON.stringify({
            file: {
              name: 'files/unspecified-state',
              uri: 'https://generativelanguage.googleapis.com/v1beta/files/unspecified-state',
              state: 'STATE_UNSPECIFIED',
            },
          }),
          {
            status: 200,
            headers: {
              'x-goog-upload-status': 'final',
              'Content-Type': 'application/json',
            },
          }
        ),
    });

    const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
    await assert.rejects(
      () => provider.transcribe(Buffer.from('audio'), 'bad_state.m4a', 'audio/m4a'),
      (err: Error) => err.message === 'GEMINI_INVALID_RESPONSE',
      'Unknown file state must reject with GEMINI_INVALID_RESPONSE'
    );
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 21: Strict Parser Rejects Untimed or Partial Content
  // =========================================================================
  {
    console.log('[Test 21] Strict parser rejects partial unannotated text and untimed content');

    // 21a. Second text content item with no annotations (untimed words)
    {
      const { mockFetch } = createMockTransport({
        onInteractionCreate: () =>
          new Response(
            JSON.stringify({
              id: 'int-untimed-second',
              status: 'completed',
              steps: [
                {
                  content: [
                    {
                      type: 'text',
                      text: 'Dạ em chào anh.',
                      annotations: [
                        { type: 'word_info', text: 'Dạ', start_offset: '0.100s', end_offset: '0.300s' },
                        { type: 'word_info', text: 'em', start_offset: '0.310s', end_offset: '0.500s' },
                        { type: 'word_info', text: 'chào', start_offset: '0.510s', end_offset: '0.800s' },
                        { type: 'word_info', text: 'anh.', start_offset: '0.810s', end_offset: '1.100s' },
                      ],
                    },
                    {
                      type: 'text',
                      text: 'Tôi nghe rõ.',
                      annotations: [], // Missing annotations on second content item
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'untimed_second.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_TIMESTAMP_MISSING',
        'Second content item lacking word annotations must reject with GEMINI_TIMESTAMP_MISSING'
      );
    }

    // 21b. Partial unannotated text (annotations do not cover all content text)
    {
      const { mockFetch } = createMockTransport({
        onInteractionCreate: () =>
          new Response(
            JSON.stringify({
              id: 'int-partial-text',
              status: 'completed',
              steps: [
                {
                  content: [
                    {
                      type: 'text',
                      text: 'Dạ em chào anh, bên em có sản phẩm mới.',
                      annotations: [
                        { type: 'word_info', text: 'Dạ', start_offset: '0.100s', end_offset: '0.300s' },
                        { type: 'word_info', text: 'em', start_offset: '0.310s', end_offset: '0.500s' },
                        { type: 'word_info', text: 'chào', start_offset: '0.510s', end_offset: '0.800s' },
                        { type: 'word_info', text: 'anh,', start_offset: '0.810s', end_offset: '1.100s' },
                      ],
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      await assert.rejects(
        () => provider.transcribe(Buffer.from('audio'), 'partial.m4a', 'audio/m4a'),
        (err: Error) => err.message === 'GEMINI_TIMESTAMP_MISSING',
        'Partial unannotated text must reject with GEMINI_TIMESTAMP_MISSING'
      );
    }

    // 21c. Vietnamese NFC vs NFD Unicode normalization does not cause false rejection
    {
      const composedText = 'Dạ em chào anh';
      const decomposedText = composedText.normalize('NFD');
      assert.notEqual(composedText, decomposedText, 'NFC and NFD representations have distinct code points');

      const { mockFetch } = createMockTransport({
        onInteractionCreate: () =>
          new Response(
            JSON.stringify({
              id: 'int-unicode-nfc-nfd',
              status: 'completed',
              steps: [
                {
                  content: [
                    {
                      type: 'text',
                      text: decomposedText,
                      annotations: [
                        { type: 'word_info', text: 'Dạ'.normalize('NFC'), start_offset: '0.100s', end_offset: '0.300s' },
                        { type: 'word_info', text: 'em'.normalize('NFC'), start_offset: '0.310s', end_offset: '0.500s' },
                        { type: 'word_info', text: 'chào'.normalize('NFC'), start_offset: '0.510s', end_offset: '0.800s' },
                        { type: 'word_info', text: 'anh'.normalize('NFC'), start_offset: '0.810s', end_offset: '1.100s' },
                      ],
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      const provider = new GeminiTranscriptionProvider({ apiKey: SYNTHETIC_API_KEY, fetch: mockFetch });
      const result = await provider.transcribe(Buffer.from('audio'), 'unicode.m4a', 'audio/m4a');
      assert.ok(result.text.length > 0, 'Vietnamese NFC vs NFD Unicode variations must not cause false rejection');
    }
    console.log('  -> PASS');
  }

  // =========================================================================
  // Section 22: Exact Hostname Security Enforcement
  // =========================================================================
  {
    console.log('[Test 22] Exact hostname check blocks rogue endpoints');
    const { mockFetch } = createMockTransport();
    await assert.rejects(
      () => mockFetch('https://generativelanguage.googleapis.com.attacker.com/v1beta/test'),
      (err: Error) => err.message.includes('FATAL: Blocked unknown external request')
    );
    await assert.rejects(
      () => mockFetch('https://api.openai.com/v1/audio/transcriptions'),
      (err: Error) => err.message.includes('FATAL: Unauthorized network call to OpenAI detected')
    );
    console.log('  -> PASS');
  }

  console.log('\n=== All Gemini Provider Rigorous Tests Passed Successfully ===');
}

main().catch((err) => {
  console.error('\n[TEST RUN FAILED]:', err);
  process.exit(1);
});
