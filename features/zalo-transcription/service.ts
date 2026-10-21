import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../lib/supabase/admin';
import { RECORDING_BUCKET } from '../zalo-recordings/upload';
import { splitStereoChannels, MAX_PROVIDER_AUDIO_BYTES, type SplitAudioOptions, type AudioChannelSplitResult } from './audio-splitter';
import { logTranscriptionEvent, logWorkerInvocation } from './logger';
import { mergeUtterances } from './merger';
import { type TranscriptionProvider } from './provider';
import { createTranscriptionProvider } from './provider-factory';
import type { AudioTranscriptionOptions, ClaimedTranscriptionJob, RawUtteranceSegment } from './types';
import { enqueueZaloCallSummary } from '../zalo-summary/service';

/**
 * Maximum total duration for a single cron invocation (4 minutes).
 * Ensures the worker does not run indefinitely, leaving headroom before
 * typical serverless/cron timeout limits (5-10 min).
 */
const MAX_WORKER_DURATION_MS = 4 * 60 * 1000;

/**
 * Maximum total duration for processing a single transcription job (3 minutes).
 * Covers: download + ffmpeg split + 2x provider calls + DB persist.
 */
const MAX_SINGLE_JOB_DURATION_MS = 3 * 60 * 1000;

/** Cleanup allowance reserved for DB completion / failure persistence */
const CLEANUP_ALLOWANCE_MS = 5_000;

export function getTranscriptionRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function getTranscriptionFailureOutcome(currentAttempts: number, maxAttempts: number) {
  const attempts = currentAttempts + 1;
  return {
    attempts,
    terminal: attempts >= maxAttempts,
    nextRunDelayMs: getTranscriptionRetryDelayMs(attempts),
  };
}

const KNOWN_SAFE_ERROR_CODES = new Set([
  // Provider: OpenAI
  "TRANSCRIPTION_NOT_CONFIGURED",
  "TRANSCRIPTION_TIMEOUT",
  "TRANSCRIPTION_NETWORK_ERROR",
  "TRANSCRIPTION_PROVIDER_AUTH_ERROR",
  "TRANSCRIPTION_RATE_LIMITED",
  "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
  "TRANSCRIPTION_INVALID_RESPONSE",
  // Provider: Gemini
  "GEMINI_NOT_CONFIGURED",
  "GEMINI_TIMEOUT",
  "GEMINI_AUTH_ERROR",
  "GEMINI_RATE_LIMITED",
  "GEMINI_PROVIDER_UNAVAILABLE",
  "GEMINI_INVALID_RESPONSE",
  "GEMINI_AUDIO_TOO_LONG",
  "GEMINI_TIMESTAMP_MISSING",
  // Audio & media
  "AUDIO_TOO_LARGE",
  "AUDIO_PROCESSING_ERROR",
  "AUDIO_SPLIT_FAILED",
  "AUDIO_CORRUPTED",
  "INVALID_AUDIO_FORMAT",
  "FFMPEG_UNAVAILABLE",
  "RECORDING_NOT_FOUND",
  // Common classifications
  "PROVIDER_AUTH_ERROR",
  "RATE_LIMITED",
  "TIMEOUT",
  // Service & Database
  "TRANSCRIPTION_LOCK_LOST",
  "ZALO_CALL_NOT_FOUND",
  "INVALID_TRANSCRIPTION_PROVIDER",
  "INVALID_TRANSCRIPTION_MODEL",
  "INVALID_PAYLOAD",
  "PERSIST_METADATA_FAILED",
  "PERSIST_TRANSCRIPTION_FAILED",
  "CLAIM_TRANSCRIPTION_JOBS_FAILED",
  "CLAIM_TRANSCRIPTION_JOB_FAILED",
  "CLAIM_FAILED",
  "DATABASE_ERROR",
  "INVALID_LIMIT",
  "INVALID_TRANSCRIPTION_ID",
  "TARGET_NOT_CLAIMABLE",
  "TARGET_NOT_FOUND",
  "CANNOT_ENQUEUE_TRANSCRIPTION",
  "CANNOT_RETRY_TRANSCRIPTION",
  "EXPIRED_LEASE_MAX_ATTEMPTS",
  "TRANSCRIPTION_FAILED",
  "WORKER_ERROR",
]);

export function sanitizeErrorCode(error: unknown): string {
  const msg =
    error instanceof Error
      ? error.message.trim()
      : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message.trim()
        : typeof error === "string"
          ? error.trim()
          : null;

  if (msg) {
    if (KNOWN_SAFE_ERROR_CODES.has(msg)) {
      return msg;
    }
    // Prevent arbitrary uppercase secret from turning into a safe error code
    if (/secret|token|key|password|bearer|aiza|sk-/i.test(msg)) {
      if (/auth|unauthorized|forbidden|401|403|bearer/i.test(msg)) return "PROVIDER_AUTH_ERROR";
      return "TRANSCRIPTION_FAILED";
    }
    // Strict finite fallbacks only - no prefix wildcard
    if (/auth|unauthorized|forbidden|401|403/i.test(msg)) return "PROVIDER_AUTH_ERROR";
    if (/rate|429/i.test(msg)) return "RATE_LIMITED";
    if (/timeout|aborted/i.test(msg)) return "TIMEOUT";
    if (/not found|404/i.test(msg)) return "RECORDING_NOT_FOUND";
    if (/corrupt|invalid format|aac|audio/i.test(msg)) return "AUDIO_PROCESSING_ERROR";
  }
  return "TRANSCRIPTION_FAILED";
}

export function sanitizeErrorMessage(error: unknown): string {
  const rawMsg =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : typeof error === 'string'
          ? error
          : null;

  if (rawMsg) {
    // Strip anything that looks like bearer tokens, API keys, or full local filesystem paths
    const clean = rawMsg
      .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer ***')
      .replace(/x-goog-api-key[:=\s]+\S+/gi, 'x-goog-api-key: ***')
      .replace(/key=[A-Za-z0-9_\-]+/gi, 'key=***')
      .replace(/sk-[A-Za-z0-9_\-]{20,}/gi, 'sk-***')
      .replace(/\bAIza[0-9A-Za-z_\-]{20,}\b/g, 'AIza***')
      .replace(/\/[\w.\-]+(?:\/[\w.\-]+)+/g, '[path]');
    return clean.slice(0, 300);
  }
  return 'Lỗi không xác định khi bóc băng.';
}

export function isPermanentError(errorCode: string): boolean {
  const permanentCodes = new Set([
    'TRANSCRIPTION_NOT_CONFIGURED',
    'PROVIDER_AUTH_ERROR',
    'TRANSCRIPTION_PROVIDER_AUTH_ERROR',
    'RECORDING_NOT_FOUND',
    'AUDIO_CORRUPTED',
    'INVALID_AUDIO_FORMAT',
    'INVALID_PAYLOAD',
    'TRANSCRIPTION_LOCK_LOST',
    'ZALO_CALL_NOT_FOUND',
    'AUDIO_TOO_LARGE',
    'FFMPEG_UNAVAILABLE',
    'GEMINI_NOT_CONFIGURED',
    'GEMINI_AUTH_ERROR',
    'GEMINI_INVALID_RESPONSE',
    'GEMINI_TIMESTAMP_MISSING',
    'GEMINI_AUDIO_TOO_LONG',
    'INVALID_TRANSCRIPTION_PROVIDER',
    'INVALID_TRANSCRIPTION_MODEL',
    'CLAIM_TRANSCRIPTION_JOB_FAILED',
    'INVALID_LIMIT',
    'INVALID_TRANSCRIPTION_ID',
  ]);
  return permanentCodes.has(errorCode);
}

const ALLOWED_PROVIDERS = new Set(["OPENAI", "GEMINI", "MOCK"]);

export function validateSafeIdentifier(id: string, maxLen = 32): string {
  if (typeof id !== "string" || !id || id.length > maxLen) {
    throw new Error("INVALID_TRANSCRIPTION_PROVIDER");
  }
  const trimmed = id.trim();
  if (trimmed !== id || !ALLOWED_PROVIDERS.has(trimmed)) {
    throw new Error("INVALID_TRANSCRIPTION_PROVIDER");
  }
  return trimmed;
}

export function validateSafeModelIdentifier(model: string, maxLen = 128): string {
  if (typeof model !== "string" || !model || model.length > maxLen) {
    throw new Error("INVALID_TRANSCRIPTION_MODEL");
  }
  // Valid model strings stay EXACT; no whitespace trim that changes used model.
  if (model.trim() !== model) {
    throw new Error("INVALID_TRANSCRIPTION_MODEL");
  }
  // Reject keys/tokens: prefix sk-, bearer, or AIza anywhere
  if (/^(sk-|bearer)/i.test(model) || /AIza/i.test(model)) {
    throw new Error("INVALID_TRANSCRIPTION_MODEL");
  }
  // Safe lowercase identifier pattern length<=128 e.g optionally models/ then [a-z][a-z0-9_.:-]* allowed
  // Reject paths, whitespace, multiple slashes, uppercase
  const safePattern = /^(?:models\/)?[a-z][a-z0-9_.:-]*$/;
  if (!safePattern.test(model)) {
    throw new Error("INVALID_TRANSCRIPTION_MODEL");
  }
  return model;
}
/** Enqueue transcription for a finalized Zalo personal recording. */
export async function enqueueZaloTranscription(
  companyId: string,
  callId: string,
  client?: SupabaseClient
): Promise<string> {
  const admin = client || createAdminClient();
  const { data, error } = await admin.rpc('zalo_enqueue_transcription', {
    p_company: companyId,
    p_call: callId,
  });

  if (error || !data) {
    throw new Error(`CANNOT_ENQUEUE_TRANSCRIPTION: ${error?.message || 'unknown'}`);
  }

  logTranscriptionEvent({
    action: 'transcription_reserved',
    company_id: companyId,
    call_id: callId,
    transcription_id: String(data),
  });

  return String(data);
}

export interface ProcessJobOptions {
  client?: SupabaseClient;
  provider?: TranscriptionProvider;
  splitAudioFn?: (buffer: Buffer, opts?: SplitAudioOptions) => Promise<AudioChannelSplitResult>;
  deadline?: number;
}

/**
 * Process a single claimed transcription job through the stereo channel pipeline.
 *
 * Bounded by MAX_SINGLE_JOB_DURATION_MS and the overall worker deadline.
 * All in-flight operations (storage download, ffmpeg split, provider transcribe)
 * carry cancellation timeouts and abort signals to prevent hanging or runaway background writes.
 */
export async function processZaloTranscriptionJob(
  job: ClaimedTranscriptionJob,
  options?: ProcessJobOptions
): Promise<void> {
  const admin = options?.client || createAdminClient();
  const splitFn = options?.splitAudioFn || splitStereoChannels;

  const defaultDeadline = Date.now() + MAX_SINGLE_JOB_DURATION_MS;
  const callerDeadline = options?.deadline;
  const validatedDeadline =
    typeof callerDeadline === 'number' && Number.isFinite(callerDeadline)
      ? callerDeadline
      : defaultDeadline;
  const jobDeadline = Math.min(defaultDeadline, validatedDeadline);

  const getRemainingMs = () => jobDeadline - Date.now();

  let safeProvider: string | undefined;
  let safeModel: string | undefined;

  try {
    // Check deadline before any metadata or provider work
    if (getRemainingMs() <= 0) {
      throw new Error('TIMEOUT');
    }

    // 0. Resolve provider inside try/catch so any invalid configuration fails gracefully in DB
    const provider = options?.provider || createTranscriptionProvider();

    // Validate safe identifiers for provider and model to prevent injection or leaking secrets
    safeProvider = validateSafeIdentifier(provider.name, 32);

    let rawModel = provider.model;
    if (!rawModel && safeProvider === 'MOCK') {
      rawModel = 'mock-model';
    }
    if (!rawModel) {
      throw new Error('INVALID_TRANSCRIPTION_MODEL');
    }
    safeModel = validateSafeModelIdentifier(rawModel, 128);

    // Re-verify deadline before metadata work
    if (getRemainingMs() <= 0) {
      throw new Error('TIMEOUT');
    }

    logTranscriptionEvent({
      action: 'processing_started',
      company_id: job.company_id,
      call_id: job.call_id,
      transcription_id: job.id,
      provider: safeProvider,
      model: safeModel,
      attempts: job.attempts,
    });

    // Persist provider and model metadata BEFORE upload, fenced by company, call, lock_token, status, and active lease.
    // Fails before consuming any provider quota if lock is lost.
    const { data: metaData, error: metaError } = await admin.rpc(
      'zalo_set_transcription_provider_metadata',
      {
        p_company: job.company_id,
        p_transcription_id: job.id,
        p_lock_token: job.lock_token,
        p_provider: safeProvider,
        p_model: safeModel,
      }
    );

    if (metaError || metaData !== true) {
      if (
        metaError &&
        typeof metaError.message === 'string' &&
        metaError.message.includes('TRANSCRIPTION_LOCK_LOST')
      ) {
        throw new Error('TRANSCRIPTION_LOCK_LOST');
      }
      throw new Error('PERSIST_METADATA_FAILED');
    }

    // 1. Download original recording from Supabase private storage
    if (getRemainingMs() <= 0) {
      throw new Error('TIMEOUT');
    }
    const downloadTimeout = Math.min(60_000, getRemainingMs());
    const { data: fileData, error: downloadError } = await admin.storage
      .from(RECORDING_BUCKET)
      .download(job.recording_path, {}, { signal: AbortSignal.timeout(downloadTimeout) });

    if (downloadError || !fileData) {
      throw new Error('RECORDING_NOT_FOUND');
    }

    const audioBuffer = Buffer.from(await fileData.arrayBuffer());

    if (getRemainingMs() <= 0) {
      throw new Error('TIMEOUT');
    }

    // 2. Split stereo channels (Left=remote/CUSTOMER, Right=local/STAFF) with bounded ffmpeg timeout
    const splitTimeout = Math.min(60_000, getRemainingMs());
    const split = await splitFn(audioBuffer, {
      audioValidation: job.audio_validation,
      timeoutMs: splitTimeout,
    });

    // 3. Pre-upload size validation for each mono channel (conservative decimal 25_000_000 bytes)
    if (split.customerAudio && split.customerAudio.length > MAX_PROVIDER_AUDIO_BYTES) {
      throw new Error('AUDIO_TOO_LARGE');
    }
    if (split.staffAudio && split.staffAudio.length > MAX_PROVIDER_AUDIO_BYTES) {
      throw new Error('AUDIO_TOO_LARGE');
    }

    let customerSegments: RawUtteranceSegment[] = [];
    let staffSegments: RawUtteranceSegment[] = [];
    let detectedLanguage = job.language || 'vi';

    // Duration in ms from validated audio_validation.duration (converted seconds -> ms)
    const durationMs =
      typeof job.audio_validation?.duration === 'number' &&
      Number.isFinite(job.audio_validation.duration) &&
      job.audio_validation.duration > 0
        ? Math.round(job.audio_validation.duration * 1000)
        : undefined;

    // 4. Transcribe Left (CUSTOMER) channel if not silent
    if (!split.customerSilent && split.customerAudio && split.customerAudio.length > 0) {
      if (getRemainingMs() <= CLEANUP_ALLOWANCE_MS) {
        throw new Error('TIMEOUT');
      }
      const providerTimeout = Math.max(1_000, Math.min(120_000, getRemainingMs() - CLEANUP_ALLOWANCE_MS));
      const providerOptions: AudioTranscriptionOptions = {
        language: job.language,
        signal: AbortSignal.timeout(providerTimeout),
        duration_ms: durationMs,
        deadline: jobDeadline,
      };
      const custResult = await provider.transcribe(
        split.customerAudio,
        'customer_left.m4a',
        'audio/m4a',
        providerOptions
      );
      customerSegments = custResult.segments;
      if (custResult.language) detectedLanguage = custResult.language;
      logTranscriptionEvent({
        action: 'provider_completed',
        company_id: job.company_id,
        call_id: job.call_id,
        transcription_id: job.id,
        channel: 'LEFT',
        provider: safeProvider,
        model: safeModel,
        utterances_count: customerSegments.length,
      });
    }

    // 5. Transcribe Right (STAFF) channel if not silent
    if (!split.staffSilent && split.staffAudio && split.staffAudio.length > 0) {
      if (getRemainingMs() <= CLEANUP_ALLOWANCE_MS) {
        throw new Error('TIMEOUT');
      }
      const providerTimeout = Math.max(1_000, Math.min(120_000, getRemainingMs() - CLEANUP_ALLOWANCE_MS));
      const providerOptions: AudioTranscriptionOptions = {
        language: job.language,
        signal: AbortSignal.timeout(providerTimeout),
        duration_ms: durationMs,
        deadline: jobDeadline,
      };
      const staffResult = await provider.transcribe(
        split.staffAudio,
        'staff_right.m4a',
        'audio/m4a',
        providerOptions
      );
      staffSegments = staffResult.segments;
      if (staffResult.language) detectedLanguage = staffResult.language;
      logTranscriptionEvent({
        action: 'provider_completed',
        company_id: job.company_id,
        call_id: job.call_id,
        transcription_id: job.id,
        channel: 'RIGHT',
        provider: safeProvider,
        model: safeModel,
        utterances_count: staffSegments.length,
      });
    }

    // 6. Deterministically merge utterances ordered by start_ms ASC
    const merged = mergeUtterances({
      customerSegments,
      staffSegments,
    });

    // 7. Complete transcription in database atomically fenced by lock_token
    const { error: completeError } = await admin.rpc('zalo_complete_transcription', {
      p_company: job.company_id,
      p_transcription_id: job.id,
      p_lock_token: job.lock_token,
      p_full_transcript: merged.fullTranscript,
      p_utterances: merged.utterances,
      p_channels_silent: {
        left: split.customerSilent,
        right: split.staffSilent,
      },
      p_language: detectedLanguage,
    });

    if (completeError) {
      throw new Error(`PERSIST_TRANSCRIPTION_FAILED: ${completeError.message}`);
    }

    logTranscriptionEvent({
      action: 'persisted',
      company_id: job.company_id,
      call_id: job.call_id,
      transcription_id: job.id,
      provider: safeProvider,
      model: safeModel,
      utterances_count: merged.utterances.length,
      language: detectedLanguage,
    });

    // Best-effort idempotent auto-enqueue of AI summary job; non-fatal to transcription completion
    try {
      await enqueueZaloCallSummary(job.company_id, job.id, admin);
    } catch {
      // Intentionally suppressed: failure to enqueue summary must not affect transcription COMPLETED status
    }
  } catch (err: unknown) {
    const rawCode = sanitizeErrorCode(err);
    const sanitizedMsg = sanitizeErrorMessage(err);
    const permanent = isPermanentError(rawCode);
    const outcome = getTranscriptionFailureOutcome(job.attempts, job.max_attempts);
    const isTerminal = permanent || outcome.terminal;
    const nextRunAt = isTerminal
      ? null
      : new Date(Date.now() + outcome.nextRunDelayMs).toISOString();

    await admin.rpc('zalo_fail_transcription', {
      p_company: job.company_id,
      p_transcription_id: job.id,
      p_lock_token: job.lock_token,
      p_error_code: rawCode,
      p_error_message: sanitizedMsg,
      p_terminal: isTerminal,
      p_next_run_at: nextRunAt,
    });

    logTranscriptionEvent({
      action: isTerminal ? 'failed' : 'retry_scheduled',
      company_id: job.company_id,
      call_id: job.call_id,
      transcription_id: job.id,
      provider: safeProvider,
      model: safeModel,
      error_code: rawCode,
      attempts: outcome.attempts,
      next_run_at: nextRunAt || undefined,
      is_terminal: isTerminal,
    });

    throw err;
  }
}

/**
 * Claim and process due Zalo transcription jobs using Postgres SKIP LOCKED.
 *
 * Bounded by:
 * - limit: max jobs to process across the invocation (default 10)
 * - MAX_WORKER_DURATION_MS: total invocation time limit (4 minutes)
 * - Each individual job is bounded by MAX_SINGLE_JOB_DURATION_MS (3 minutes) and the worker deadline
 *
 * Jobs are claimed 1 at a time immediately before processing. This guarantees
 * that each job begins processing with a fresh 300s lease rather than having sequentially
 * claimed batch jobs expire in memory while earlier jobs are executing.
 */
export async function processDueZaloTranscriptionJobs(
  limit = 10,
  options?: ProcessJobOptions & { lockedBy?: string; leaseSeconds?: number }
): Promise<{ claimed: number; processed: number; failed: number }> {
  const startTime = Date.now();

  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    logWorkerInvocation({
      action: "invocation_failed",
      mode: "BULK",
      limit: typeof limit === "number" ? limit : undefined,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: "INVALID_LIMIT",
    });
    throw new Error("INVALID_LIMIT");
  }

  logWorkerInvocation({
    action: "invocation_started",
    mode: "BULK",
    limit,
  });

  let admin: SupabaseClient;
  try {
    admin = options?.client || createAdminClient();
  } catch {
    logWorkerInvocation({
      action: "invocation_failed",
      mode: "BULK",
      limit,
      claimed: 0,
      processed: 0,
      failed: 0,
      duration_ms: 0,
      error_code: "DATABASE_ERROR",
    });
    throw new Error("DATABASE_ERROR");
  }

  const lockedBy = options?.lockedBy || `worker_${process.pid || 1}`;
  const leaseSeconds = options?.leaseSeconds || 300;
  const workerDeadline = Date.now() + MAX_WORKER_DURATION_MS;

  let claimed = 0;
  let processed = 0;
  let failed = 0;

  try {
    while (claimed < limit) {
      if (Date.now() >= workerDeadline) {
        break;
      }

      // Claim 1 immediately processable job at a time
      const { data, error } = await admin.rpc("zalo_claim_transcription_jobs", {
        p_limit: 1,
        p_locked_by: lockedBy,
        p_lease_seconds: leaseSeconds,
      });

      if (error) {
        const sanitized = sanitizeErrorMessage(error);
        throw new Error(`CLAIM_TRANSCRIPTION_JOBS_FAILED: ${sanitized}`);
      }

      const jobs = (data || []) as ClaimedTranscriptionJob[];
      if (jobs.length === 0) {
        // Queue is drained
        break;
      }

      const job = jobs[0];
      claimed++;
      try {
        await processZaloTranscriptionJob(job, {
          ...options,
          client: admin,
          deadline: workerDeadline,
        });
        processed++;
      } catch {
        failed++;
      }
    }

    logWorkerInvocation({
      action: "invocation_completed",
      mode: "BULK",
      limit,
      claimed,
      processed,
      failed,
      duration_ms: Date.now() - startTime,
    });

    return { claimed, processed, failed };
  } catch (err) {
    const safeCode =
      err instanceof Error && err.message === "INVALID_LIMIT"
        ? "INVALID_LIMIT"
        : "CLAIM_FAILED";

    logWorkerInvocation({
      action: "invocation_failed",
      mode: "BULK",
      limit,
      claimed,
      processed,
      failed,
      duration_ms: Date.now() - startTime,
      error_code: safeCode,
    });

    throw err;
  }
}

/**
 * Claim and process a single targeted Zalo transcription job.
 *
 * Guarantees:
 * - Strictly claims only the requested transcription ID; never falls back to bulk
 * - Validates UUID format and server-derived tenant isolation
 * - Restricts lease reclamation strictly to the targeted job
 * - Enforces caller / worker deadlines and fresh lease
 * - Missing or not-due job returns zero { claimed: 0, processed: 0, failed: 0 }
 */
export async function processTargetedZaloTranscriptionJob(
  transcriptionId: string,
  options?: ProcessJobOptions & { companyId?: string; lockedBy?: string; leaseSeconds?: number }
): Promise<{ claimed: number; processed: number; failed: number }> {
  const startTime = Date.now();
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof transcriptionId !== "string" || !UUID_REGEX.test(transcriptionId)) {
    logWorkerInvocation({
      action: "invocation_failed",
      mode: "TARGETED",
      target_id: undefined,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: "INVALID_TRANSCRIPTION_ID",
    });
    throw new Error("INVALID_TRANSCRIPTION_ID");
  }

  logWorkerInvocation({
    action: "invocation_started",
    mode: "TARGETED",
    target_id: transcriptionId,
  });

  let admin: SupabaseClient;
  try {
    admin = options?.client || createAdminClient();
  } catch {
    logWorkerInvocation({
      action: "invocation_failed",
      mode: "TARGETED",
      target_id: transcriptionId,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: "DATABASE_ERROR",
    });
    throw new Error("DATABASE_ERROR");
  }

  const lockedBy = options?.lockedBy || `worker_targeted_${process.pid || 1}`;
  const leaseSeconds = options?.leaseSeconds || 300;
  const workerDeadline = Date.now() + MAX_WORKER_DURATION_MS;

  // 1. Service-side company_id derivation
  let companyId: string;
  try {
    const { data: jobRow, error: lookupError } = await admin
      .from("zalo_call_transcriptions")
      .select("company_id")
      .eq("id", transcriptionId)
      .maybeSingle();

    if (lookupError) {
      logWorkerInvocation({
        action: "invocation_failed",
        mode: "TARGETED",
        target_id: transcriptionId,
        claimed_count: 0,
        processed_count: 0,
        failed_count: 0,
        duration_ms: Date.now() - startTime,
        error_code: "DATABASE_ERROR",
      });
      throw new Error("DATABASE_ERROR");
    }

    if (!jobRow || !jobRow.company_id) {
      // Missing job: returns zero claimed, processed, failed
      logWorkerInvocation({
        action: "invocation_completed",
        mode: "TARGETED",
        target_id: transcriptionId,
        claimed: 0,
        processed: 0,
        failed: 0,
        duration_ms: Date.now() - startTime,
      });
      return { claimed: 0, processed: 0, failed: 0 };
    }

    if (options?.companyId && options.companyId !== jobRow.company_id) {
      logWorkerInvocation({
        action: "invocation_completed",
        mode: "TARGETED",
        target_id: transcriptionId,
        claimed: 0,
        processed: 0,
        failed: 0,
        duration_ms: Date.now() - startTime,
      });
      return { claimed: 0, processed: 0, failed: 0 };
    }

    companyId = jobRow.company_id;
  } catch (err) {
    if (err instanceof Error && err.message === "DATABASE_ERROR") {
      throw err;
    }
    logWorkerInvocation({
      action: "invocation_failed",
      mode: "TARGETED",
      target_id: transcriptionId,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: Date.now() - startTime,
      error_code: "DATABASE_ERROR",
    });
    throw new Error("DATABASE_ERROR");
  }

  // 2. Call targeted claim RPC with both company and transcription ID
  let jobs: ClaimedTranscriptionJob[] = [];
  try {
    const { data, error: claimError } = await admin.rpc("zalo_claim_transcription_job", {
      p_company: companyId,
      p_transcription_id: transcriptionId,
      p_locked_by: lockedBy,
      p_lease_seconds: leaseSeconds,
    });

    if (claimError) {
      logWorkerInvocation({
        action: "invocation_failed",
        mode: "TARGETED",
        target_id: transcriptionId,
        claimed_count: 0,
        processed_count: 0,
        failed_count: 0,
        duration_ms: Date.now() - startTime,
        error_code: "CLAIM_FAILED",
      });
      const sanitized = sanitizeErrorMessage(claimError);
      throw new Error(`CLAIM_TRANSCRIPTION_JOB_FAILED: ${sanitized}`);
    }

    jobs = (data || []) as ClaimedTranscriptionJob[];
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("CLAIM_TRANSCRIPTION_JOB_FAILED")) {
      throw err;
    }
    logWorkerInvocation({
      action: "invocation_failed",
      mode: "TARGETED",
      target_id: transcriptionId,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: Date.now() - startTime,
      error_code: "CLAIM_FAILED",
    });
    throw new Error("CLAIM_FAILED");
  }

  if (jobs.length === 0) {
    // Target could not be claimed (not due, active lease, mismatched tenant, call not ready, etc.)
    logWorkerInvocation({
      action: "invocation_completed",
      mode: "TARGETED",
      target_id: transcriptionId,
      claimed: 0,
      processed: 0,
      failed: 0,
      duration_ms: Date.now() - startTime,
    });
    return { claimed: 0, processed: 0, failed: 0 };
  }

  const job = jobs[0];
  let processed = 0;
  let failed = 0;

  try {
    await processZaloTranscriptionJob(job, {
      ...options,
      client: admin,
      deadline: workerDeadline,
    });
    processed = 1;
  } catch {
    failed = 1;
  }

  const result = { claimed: 1, processed, failed };
  logWorkerInvocation({
    action: "invocation_completed",
    mode: "TARGETED",
    target_id: transcriptionId,
    claimed: 1,
    processed,
    failed,
    duration_ms: Date.now() - startTime,
  });

  return result;
}

export async function retryZaloTranscriptionJob(
  companyId: string,
  actorId: string,
  callId: string,
  client?: SupabaseClient
): Promise<{ ok: boolean; status: string }> {
  const admin = client || createAdminClient();
  const { data, error } = await admin.rpc('zalo_retry_transcription', {
    p_company: companyId,
    p_actor: actorId,
    p_call: callId,
  });

  if (error || !data) {
    const sanitized = sanitizeErrorMessage(error || new Error('CANNOT_RETRY_TRANSCRIPTION'));
    throw new Error(sanitized);
  }

  const ret = data as { ok: boolean; status: string; transcription_id?: string };
  logTranscriptionEvent({
    action: 'retry_scheduled',
    company_id: companyId,
    call_id: callId,
    transcription_id: ret.transcription_id,
  });

  return ret;
}
