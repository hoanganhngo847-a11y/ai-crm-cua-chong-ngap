import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../lib/supabase/admin';
import { RECORDING_BUCKET } from '../zalo-recordings/upload';
import { splitStereoChannels, MAX_PROVIDER_AUDIO_BYTES, type SplitAudioOptions, type AudioChannelSplitResult } from './audio-splitter';
import { logTranscriptionEvent } from './logger';
import { mergeUtterances } from './merger';
import { OpenAITranscriptionProvider, type TranscriptionProvider } from './provider';
import type { ClaimedTranscriptionJob, RawUtteranceSegment } from './types';

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

export function sanitizeErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message.trim();
    if (/^[A-Z0-9_]{3,80}$/.test(msg)) {
      return msg;
    }
    if (/auth|unauthorized|forbidden|401|403/i.test(msg)) return 'PROVIDER_AUTH_ERROR';
    if (/rate|429/i.test(msg)) return 'RATE_LIMITED';
    if (/timeout|aborted/i.test(msg)) return 'TIMEOUT';
    if (/not found|404/i.test(msg)) return 'RECORDING_NOT_FOUND';
    if (/corrupt|invalid format|aac|audio/i.test(msg)) return 'AUDIO_PROCESSING_ERROR';
  }
  return 'TRANSCRIPTION_FAILED';
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Strip anything that looks like bearer tokens, API keys, or full local filesystem paths
    const clean = error.message
      .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer ***')
      .replace(/sk-[A-Za-z0-9_\-]{20,}/gi, 'sk-***')
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
  ]);
  return permanentCodes.has(errorCode);
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
  const provider = options?.provider || new OpenAITranscriptionProvider();
  const splitFn = options?.splitAudioFn || splitStereoChannels;
  const jobDeadline = Math.min(
    Date.now() + MAX_SINGLE_JOB_DURATION_MS,
    options?.deadline ?? (Date.now() + MAX_SINGLE_JOB_DURATION_MS)
  );
  const getRemainingMs = () => Math.max(0, jobDeadline - Date.now());

  logTranscriptionEvent({
    action: 'processing_started',
    company_id: job.company_id,
    call_id: job.call_id,
    transcription_id: job.id,
    provider: job.provider,
    attempts: job.attempts,
  });

  try {
    if (getRemainingMs() <= 0) {
      throw new Error('TIMEOUT');
    }

    // 1. Download original recording from private bucket with bounded cancellation timeout
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

    // 4. Transcribe Left (CUSTOMER) channel if not silent
    if (!split.customerSilent && split.customerAudio && split.customerAudio.length > 0) {
      if (getRemainingMs() <= 0) {
        throw new Error('TIMEOUT');
      }
      const providerTimeout = Math.min(120_000, getRemainingMs());
      const custResult = await provider.transcribe(
        split.customerAudio,
        'customer_left.m4a',
        'audio/mp4',
        {
          language: job.language,
          signal: AbortSignal.timeout(providerTimeout),
        }
      );
      customerSegments = custResult.segments;
      if (custResult.language) detectedLanguage = custResult.language;
      logTranscriptionEvent({
        action: 'provider_completed',
        company_id: job.company_id,
        call_id: job.call_id,
        transcription_id: job.id,
        channel: 'LEFT',
        provider: provider.name,
        utterances_count: customerSegments.length,
      });
    }

    // 5. Transcribe Right (STAFF) channel if not silent
    if (!split.staffSilent && split.staffAudio && split.staffAudio.length > 0) {
      if (getRemainingMs() <= 0) {
        throw new Error('TIMEOUT');
      }
      const providerTimeout = Math.min(120_000, getRemainingMs());
      const staffResult = await provider.transcribe(
        split.staffAudio,
        'staff_right.m4a',
        'audio/mp4',
        {
          language: job.language,
          signal: AbortSignal.timeout(providerTimeout),
        }
      );
      staffSegments = staffResult.segments;
      if (staffResult.language) detectedLanguage = staffResult.language;
      logTranscriptionEvent({
        action: 'provider_completed',
        company_id: job.company_id,
        call_id: job.call_id,
        transcription_id: job.id,
        channel: 'RIGHT',
        provider: provider.name,
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
      utterances_count: merged.utterances.length,
      language: detectedLanguage,
    });
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
): Promise<{ processed: number; failed: number }> {
  const admin = options?.client || createAdminClient();
  const lockedBy = options?.lockedBy || `worker_${process.pid || 1}`;
  const leaseSeconds = options?.leaseSeconds || 300;
  const workerDeadline = Date.now() + MAX_WORKER_DURATION_MS;

  let processed = 0;
  let failed = 0;

  while (processed + failed < limit) {
    if (Date.now() >= workerDeadline) {
      break;
    }

    // Claim 1 immediately processable job at a time
    const { data, error } = await admin.rpc('zalo_claim_transcription_jobs', {
      p_limit: 1,
      p_locked_by: lockedBy,
      p_lease_seconds: leaseSeconds,
    });

    if (error) {
      throw new Error(`CLAIM_TRANSCRIPTION_JOBS_FAILED: ${error.message}`);
    }

    const jobs = (data || []) as ClaimedTranscriptionJob[];
    if (jobs.length === 0) {
      // Queue is drained
      break;
    }

    const job = jobs[0];
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

  return { processed, failed };
}

/**
 * Retry a failed transcription job for an authorized actor (BOSS_ADMIN or owning SALE).
 */
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
    throw new Error(error?.message || 'CANNOT_RETRY_TRANSCRIPTION');
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
