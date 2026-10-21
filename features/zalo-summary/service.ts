import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../lib/supabase/admin';
import { logSummaryEvent, logSummaryWorkerInvocation } from './logger';
import { SUMMARY_PROMPT_VERSION } from './prompt';
import type { SummaryProvider } from './types';
import { createSummaryProvider, resolveSummaryConfig } from './provider-factory';
import type { ClaimedSummaryJob } from './types';

/** Maximum duration for an entire worker invocation (4 minutes) */
const MAX_WORKER_DURATION_MS = 4 * 60 * 1000;

/** Maximum duration for processing a single summary job (2 minutes) */
const MAX_SINGLE_JOB_DURATION_MS = 2 * 60 * 1000;

export function getSummaryRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function getSummaryFailureOutcome(currentAttempts: number, maxAttempts: number) {
  const attempts = currentAttempts + 1;
  return {
    attempts,
    terminal: attempts >= maxAttempts,
    nextRunDelayMs: getSummaryRetryDelayMs(attempts),
  };
}

const KNOWN_SAFE_SUMMARY_ERROR_CODES = new Set([
  'SUMMARY_PROVIDER_NOT_CONFIGURED',
  'SUMMARY_PROVIDER_AUTH_ERROR',
  'SUMMARY_PROVIDER_RATE_LIMITED',
  'SUMMARY_PROVIDER_TIMEOUT',
  'SUMMARY_PROVIDER_UNAVAILABLE',
  'SUMMARY_INVALID_RESPONSE',
  'SUMMARY_TRANSCRIPT_EMPTY',
  'SUMMARY_TRANSCRIPT_NOT_COMPLETED',
  'SUMMARY_LOCK_LOST',
  'INVALID_SUMMARY_PROVIDER',
  'INVALID_LIMIT',
  'INVALID_SUMMARY_ID',
  'INVALID_TRANSCRIPTION_ID',
  'DATABASE_ERROR',
  'CLAIM_FAILED',
  'EXPIRED_LEASE_MAX_ATTEMPTS',
  'CANNOT_ENQUEUE_SUMMARY',
  'SUMMARY_FAILED',
  'TRANSCRIPTION_NOT_FOUND',
  'FORBIDDEN',
  'AMBIGUOUS_TARGET',
]);

export function sanitizeSummaryErrorCode(error: unknown): string {
  const msg =
    error instanceof Error
      ? error.message.trim()
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message.trim()
        : typeof error === 'string'
          ? error.trim()
          : null;

  if (msg) {
    if (KNOWN_SAFE_SUMMARY_ERROR_CODES.has(msg)) {
      return msg;
    }
    if (/secret|token|key|password|bearer|aiza|sk-/i.test(msg)) {
      if (/auth|unauthorized|forbidden|401|403|bearer|key|credential/i.test(msg)) return 'SUMMARY_PROVIDER_AUTH_ERROR';
      return 'SUMMARY_FAILED';
    }
    if (/auth|unauthorized|forbidden|401|403|api key/i.test(msg)) return 'SUMMARY_PROVIDER_AUTH_ERROR';
    if (/rate|429|quota/i.test(msg)) return 'SUMMARY_PROVIDER_RATE_LIMITED';
    if (/timeout|aborted/i.test(msg)) return 'SUMMARY_PROVIDER_TIMEOUT';
    if (/syntax|json|schema|invalid/i.test(msg)) return 'SUMMARY_INVALID_RESPONSE';
  }
  return 'SUMMARY_FAILED';
}

export function sanitizeSummaryErrorMessage(error: unknown): string {
  const rawMsg =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : typeof error === 'string'
          ? error
          : null;

  if (rawMsg) {
    const clean = rawMsg
      .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer ***')
      .replace(/x-goog-api-key[:=\s]+\S+/gi, 'x-goog-api-key: ***')
      .replace(/key=[A-Za-z0-9_\-]+/gi, 'key=***')
      .replace(/sk-[A-Za-z0-9_\-]{20,}/gi, 'sk-***')
      .replace(/\bAIza[0-9A-Za-z_\-]{20,}\b/g, 'AIza***')
      .replace(/\/[\w.\-]+(?:\/[\w.\-]+)+/g, '[path]');
    return clean.slice(0, 300);
  }
  return 'Lỗi không xác định khi tạo tóm tắt AI.';
}

export function isPermanentSummaryError(errorCode: string): boolean {
  const permanentCodes = new Set([
    'SUMMARY_PROVIDER_NOT_CONFIGURED',
    'SUMMARY_PROVIDER_AUTH_ERROR',
    'SUMMARY_INVALID_RESPONSE',
    'SUMMARY_TRANSCRIPT_EMPTY',
    'SUMMARY_TRANSCRIPT_NOT_COMPLETED',
    'SUMMARY_LOCK_LOST',
    'INVALID_SUMMARY_PROVIDER',
    'INVALID_LIMIT',
    'INVALID_SUMMARY_ID',
    'INVALID_TRANSCRIPTION_ID',
    'EXPIRED_LEASE_MAX_ATTEMPTS',
    'TRANSCRIPTION_NOT_FOUND',
    'FORBIDDEN',
    'AMBIGUOUS_TARGET',
  ]);
  return permanentCodes.has(errorCode);
}

/**
 * Enqueue AI summary for a completed transcription.
 * Idempotent: safe against duplicate calls.
 *
 * Resolves provider and model from explicit options or active environment config (SUMMARY_PROVIDER, etc.)
 * Validates provider before persisting and passes provider + model explicitly to RPC.
 */
export async function enqueueZaloCallSummary(
  companyId: string,
  transcriptionId: string,
  client?: SupabaseClient,
  options?: { provider?: string; model?: string; promptVersion?: string }
): Promise<string> {
  const admin = client || createAdminClient();
  const config = resolveSummaryConfig({
    provider: options?.provider,
    model: options?.model,
  });

  const { data, error } = await admin.rpc('zalo_enqueue_call_summary', {
    p_company: companyId,
    p_transcription_id: transcriptionId,
    p_provider: config.provider,
    p_model: config.model,
    p_prompt_version: options?.promptVersion || SUMMARY_PROMPT_VERSION,
  });

  if (error || !data) {
    throw new Error(`CANNOT_ENQUEUE_SUMMARY: ${error?.message || 'unknown'}`);
  }

  logSummaryEvent({
    action: 'summary_enqueued',
    company_id: companyId,
    transcription_id: transcriptionId,
    summary_id: String(data),
    provider: config.provider,
    model: config.model,
  });

  return String(data);
}

/**
 * Resolves the activation cutoff boundary for Phase 2B summary reconciliation.
 * Reconciles only transcriptions completed at or after this boundary.
 *
 * Configured via process.env.SUMMARY_ACTIVATION_CUTOFF.
 * If unset or invalid, returns null (fails closed to protect historical Phase 2A records).
 */
export function resolveSummaryCutoff(): string | null {
  const raw = process.env.SUMMARY_ACTIVATION_CUTOFF;
  if (!raw || !raw.trim()) {
    return null;
  }
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

/**
 * Reconciles completed transcriptions that lack an AI summary row (e.g. transient enqueue failure).
 * Bounded by limit and an explicit activation cutoff boundary (p_since).
 * If since is not provided or resolved from SUMMARY_ACTIVATION_CUTOFF, returns 0 (fails closed).
 * Idempotent: safe against duplicate runs.
 */
export async function reconcileMissingZaloCallSummaries(
  limit = 10,
  client?: SupabaseClient,
  options?: { since?: Date | string | null }
): Promise<number> {
  const admin = client || createAdminClient();
  const config = resolveSummaryConfig();

  let sinceIso: string | null = null;
  if (options && 'since' in options) {
    if (options.since instanceof Date) {
      sinceIso = options.since.toISOString();
    } else if (typeof options.since === 'string' && options.since.trim()) {
      const d = new Date(options.since.trim());
      if (!Number.isNaN(d.getTime())) {
        sinceIso = d.toISOString();
      }
    }
  } else {
    sinceIso = resolveSummaryCutoff();
  }

  // Safety guard: do not run bulk reconciliation without an explicit activation cutoff
  if (!sinceIso) {
    return 0;
  }

  const { data, error } = await admin.rpc('zalo_reconcile_missing_call_summaries', {
    p_limit: limit,
    p_provider: config.provider,
    p_model: config.model,
    p_since: sinceIso,
  });

  if (error) {
    logSummaryEvent({
      action: 'reconciliation_failed',
      error_code: 'SUMMARY_RECONCILIATION_FAILED',
    });
    return 0;
  }

  const count = Array.isArray(data) && data.length > 0
    ? Number((data[0] as { reconciled_count?: unknown }).reconciled_count || 0)
    : typeof data === 'number'
      ? data
      : 0;

  if (count > 0) {
    logSummaryEvent({
      action: 'summary_reconciled',
      reconciled_count: count,
      provider: config.provider,
      model: config.model,
    });
  }

  return count;
}

export interface ProcessSummaryJobOptions {
  client?: SupabaseClient;
  provider?: SummaryProvider;
  deadline?: number;
}

/**
 * Process a single claimed summary job.
 */
export async function processZaloCallSummaryJob(
  job: ClaimedSummaryJob,
  options?: ProcessSummaryJobOptions
): Promise<void> {
  const admin = options?.client || createAdminClient();
  const defaultDeadline = Date.now() + MAX_SINGLE_JOB_DURATION_MS;
  const callerDeadline = options?.deadline;
  const jobDeadline = Math.min(
    defaultDeadline,
    typeof callerDeadline === 'number' && Number.isFinite(callerDeadline)
      ? callerDeadline
      : defaultDeadline
  );

  let providerName = job.provider;
  let modelName = job.model;

  try {
    if (Date.now() >= jobDeadline) {
      throw new Error('SUMMARY_PROVIDER_TIMEOUT');
    }

    const provider = options?.provider || createSummaryProvider({
      provider: job.provider,
      model: job.model,
    });
    providerName = provider.name;
    modelName = provider.model;

    logSummaryEvent({
      action: 'processing_started',
      company_id: job.company_id,
      call_id: job.call_id,
      transcription_id: job.transcription_id,
      summary_id: job.id,
      provider: providerName,
      model: modelName,
      attempts: job.attempts,
    });

    // Check transcript utterances: fail safe if empty
    if (!job.utterances || job.utterances.length === 0) {
      throw new Error('SUMMARY_TRANSCRIPT_EMPTY');
    }

    const remainingTimeoutMs = Math.max(1000, jobDeadline - Date.now());
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(new Error('SUMMARY_PROVIDER_TIMEOUT')), remainingTimeoutMs);

    let structuredOutput;
    try {
      structuredOutput = await provider.generateSummary(job.utterances, {
        signal: abortCtrl.signal,
        deadline: jobDeadline,
      });
    } finally {
      clearTimeout(timer);
    }

    // Persist completed summary atomically fenced by lock_token
    const { data: completeResult, error: completeError } = await admin.rpc(
      'zalo_complete_call_summary',
      {
        p_company: job.company_id,
        p_summary_id: job.id,
        p_lock_token: job.lock_token,
        p_summary: structuredOutput.summary,
        p_customer_needs: structuredOutput.customer_needs,
        p_objections: structuredOutput.objections,
        p_next_actions: structuredOutput.next_actions,
        p_key_points: structuredOutput.key_points,
        p_lead_temperature: structuredOutput.lead_temperature,
        p_follow_up_required: structuredOutput.follow_up.required,
        p_follow_up_suggested_time: structuredOutput.follow_up.suggested_time,
        p_follow_up_reason: structuredOutput.follow_up.reason,
        p_confidence: structuredOutput.confidence,
        p_provider: providerName,
        p_model: modelName,
        p_prompt_version: SUMMARY_PROMPT_VERSION,
      }
    );

    if (completeError || completeResult !== true) {
      throw new Error('SUMMARY_LOCK_LOST');
    }

    logSummaryEvent({
      action: 'summary_completed',
      company_id: job.company_id,
      call_id: job.call_id,
      transcription_id: job.transcription_id,
      summary_id: job.id,
      provider: providerName,
      model: modelName,
    });
  } catch (err) {
    const rawCode = sanitizeSummaryErrorCode(err);
    const sanitizedMsg = sanitizeSummaryErrorMessage(err);
    const permanent = isPermanentSummaryError(rawCode);
    const outcome = getSummaryFailureOutcome(job.attempts, job.max_attempts);
    const isTerminal = permanent || outcome.terminal;
    const nextRunAt = isTerminal
      ? null
      : new Date(Date.now() + outcome.nextRunDelayMs).toISOString();

    await admin.rpc('zalo_fail_call_summary', {
      p_company: job.company_id,
      p_summary_id: job.id,
      p_lock_token: job.lock_token,
      p_error_code: rawCode,
      p_error_message: sanitizedMsg,
      p_terminal: isTerminal,
      p_next_run_at: nextRunAt,
    });

    logSummaryEvent({
      action: isTerminal ? 'summary_failed' : 'retry_scheduled',
      company_id: job.company_id,
      call_id: job.call_id,
      transcription_id: job.transcription_id,
      summary_id: job.id,
      provider: providerName,
      model: modelName,
      error_code: rawCode,
      attempts: outcome.attempts,
      next_run_at: nextRunAt || undefined,
      is_terminal: isTerminal,
    });

    throw err;
  }
}

/**
 * Bulk processing of due Zalo call summary jobs.
 */
export async function processDueZaloCallSummaryJobs(
  limit = 10,
  options?: ProcessSummaryJobOptions & {
    lockedBy?: string;
    leaseSeconds?: number;
    reconciliationSince?: Date | string | null;
  }
): Promise<{ claimed: number; processed: number; failed: number }> {
  const startTime = Date.now();

  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    logSummaryWorkerInvocation({
      action: 'invocation_failed',
      mode: 'BULK',
      limit: typeof limit === 'number' ? limit : undefined,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: 'INVALID_LIMIT',
    });
    throw new Error('INVALID_LIMIT');
  }

  logSummaryWorkerInvocation({
    action: 'invocation_started',
    mode: 'BULK',
    limit,
  });

  let admin: SupabaseClient;
  try {
    admin = options?.client || createAdminClient();
  } catch {
    logSummaryWorkerInvocation({
      action: 'invocation_failed',
      mode: 'BULK',
      limit,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: 'DATABASE_ERROR',
    });
    throw new Error('DATABASE_ERROR');
  }

  const lockedBy = options?.lockedBy || `summary_worker_${process.pid || 1}`;
  const leaseSeconds = options?.leaseSeconds || 300;
  const workerDeadline = Date.now() + MAX_WORKER_DURATION_MS;

  let claimed = 0;
  let processed = 0;
  let failed = 0;

  try {
    // Reconcile missing summary jobs for completed transcriptions at or after the activation boundary (best-effort recovery)
    try {
      await reconcileMissingZaloCallSummaries(limit, admin, {
        since: options?.reconciliationSince,
      });
    } catch {
      // Non-fatal to bulk worker execution
    }

    while (claimed < limit) {
      if (Date.now() >= workerDeadline) break;

      const { data, error } = await admin.rpc('zalo_claim_call_summary_jobs', {
        p_limit: 1,
        p_locked_by: lockedBy,
        p_lease_seconds: leaseSeconds,
      });

      if (error) {
        throw new Error(`CLAIM_FAILED: ${sanitizeSummaryErrorMessage(error)}`);
      }

      const jobs = (data || []) as ClaimedSummaryJob[];
      if (jobs.length === 0) break;

      const job = jobs[0];
      claimed++;

      try {
        await processZaloCallSummaryJob(job, {
          ...options,
          client: admin,
          deadline: workerDeadline,
        });
        processed++;
      } catch {
        failed++;
      }
    }

    logSummaryWorkerInvocation({
      action: 'invocation_completed',
      mode: 'BULK',
      limit,
      claimed_count: claimed,
      processed_count: processed,
      failed_count: failed,
      duration_ms: Date.now() - startTime,
    });

    return { claimed, processed, failed };
  } catch (err) {
    const safeCode =
      err instanceof Error && err.message === 'INVALID_LIMIT'
        ? 'INVALID_LIMIT'
        : 'CLAIM_FAILED';

    logSummaryWorkerInvocation({
      action: 'invocation_failed',
      mode: 'BULK',
      limit,
      claimed_count: claimed,
      processed_count: processed,
      failed_count: failed,
      duration_ms: Date.now() - startTime,
      error_code: safeCode,
    });

    throw err;
  }
}

/**
 * Targeted processing of a single Zalo call summary job by summaryId or transcriptionId.
 */
export async function processTargetedZaloCallSummaryJob(
  target: { summaryId?: string; transcriptionId?: string },
  options?: ProcessSummaryJobOptions & { companyId?: string; lockedBy?: string; leaseSeconds?: number }
): Promise<{ claimed: number; processed: number; failed: number }> {
  const startTime = Date.now();
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const rawSummaryId = target.summaryId;
  const rawTxId = target.transcriptionId;

  if (rawSummaryId && !UUID_REGEX.test(rawSummaryId)) {
    logSummaryWorkerInvocation({
      action: 'invocation_failed',
      mode: 'TARGETED',
      target_id: undefined,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: 'INVALID_SUMMARY_ID',
    });
    throw new Error('INVALID_SUMMARY_ID');
  }

  if (rawTxId && !UUID_REGEX.test(rawTxId)) {
    logSummaryWorkerInvocation({
      action: 'invocation_failed',
      mode: 'TARGETED',
      target_id: undefined,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: 'INVALID_TRANSCRIPTION_ID',
    });
    throw new Error('INVALID_TRANSCRIPTION_ID');
  }

  if (rawSummaryId && rawTxId) {
    logSummaryWorkerInvocation({
      action: 'invocation_failed',
      mode: 'TARGETED',
      target_id: undefined,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: 'AMBIGUOUS_TARGET',
    });
    throw new Error('Provide exactly one targeted identifier');
  }

  if (!rawSummaryId && !rawTxId) {
    throw new Error('INVALID_SUMMARY_ID');
  }

  const targetId = rawSummaryId || rawTxId!;
  logSummaryWorkerInvocation({
    action: 'invocation_started',
    mode: 'TARGETED',
    target_id: targetId,
  });

  let admin: SupabaseClient;
  try {
    admin = options?.client || createAdminClient();
  } catch {
    logSummaryWorkerInvocation({
      action: 'invocation_failed',
      mode: 'TARGETED',
      target_id: targetId,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: 0,
      error_code: 'DATABASE_ERROR',
    });
    throw new Error('DATABASE_ERROR');
  }

  const lockedBy = options?.lockedBy || `summary_worker_targeted_${process.pid || 1}`;
  const leaseSeconds = options?.leaseSeconds || 300;
  const workerDeadline = Date.now() + MAX_WORKER_DURATION_MS;

  // Resolve summary row (and companyId)
  let resolvedSummaryId: string | undefined;
  let companyId: string | undefined;

  try {
    let query = admin.from('zalo_call_ai_summaries').select('id, company_id');
    if (rawSummaryId) {
      query = query.eq('id', rawSummaryId);
    } else {
      query = query.eq('transcription_id', rawTxId!);
    }

    const { data: row, error: lookupError } = await query.maybeSingle();

    if (lookupError) {
      logSummaryWorkerInvocation({
        action: 'invocation_failed',
        mode: 'TARGETED',
        target_id: targetId,
        claimed_count: 0,
        processed_count: 0,
        failed_count: 0,
        duration_ms: Date.now() - startTime,
        error_code: 'DATABASE_ERROR',
      });
      throw new Error('DATABASE_ERROR');
    }

    if (!row || !row.id || !row.company_id) {
      if (rawTxId) {
        // Targeted recovery: if transcription is COMPLETED but summary is missing, auto-enqueue
        const { data: tx } = await admin
          .from('zalo_call_transcriptions')
          .select('id, company_id, status')
          .eq('id', rawTxId)
          .maybeSingle();

        if (tx && tx.status === 'COMPLETED') {
          try {
            const enqueuedId = await enqueueZaloCallSummary(tx.company_id, tx.id, admin);
            resolvedSummaryId = enqueuedId;
            companyId = tx.company_id;
          } catch {
            // Non-fatal, fall through to 0 claimed
          }
        }
      }

      if (!resolvedSummaryId || !companyId) {
        logSummaryWorkerInvocation({
          action: 'invocation_completed',
          mode: 'TARGETED',
          target_id: targetId,
          claimed_count: 0,
          processed_count: 0,
          failed_count: 0,
          duration_ms: Date.now() - startTime,
        });
        return { claimed: 0, processed: 0, failed: 0 };
      }
    } else {
      resolvedSummaryId = row.id;
      companyId = row.company_id;
    }

    if (options?.companyId && options.companyId !== companyId) {
      logSummaryWorkerInvocation({
        action: 'invocation_completed',
        mode: 'TARGETED',
        target_id: targetId,
        claimed_count: 0,
        processed_count: 0,
        failed_count: 0,
        duration_ms: Date.now() - startTime,
      });
      return { claimed: 0, processed: 0, failed: 0 };
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'DATABASE_ERROR') throw err;
    throw new Error('DATABASE_ERROR');
  }

  if (!resolvedSummaryId || !companyId) {
    return { claimed: 0, processed: 0, failed: 0 };
  }

  // Claim single targeted summary job
  const { data: claimData, error: claimError } = await admin.rpc('zalo_claim_call_summary_job', {
    p_company: companyId,
    p_summary_id: resolvedSummaryId,
    p_locked_by: lockedBy,
    p_lease_seconds: leaseSeconds,
  });

  if (claimError) {
    throw new Error(`CLAIM_FAILED: ${sanitizeSummaryErrorMessage(claimError)}`);
  }

  const jobs = (claimData || []) as ClaimedSummaryJob[];
  if (jobs.length === 0) {
    logSummaryWorkerInvocation({
      action: 'invocation_completed',
      mode: 'TARGETED',
      target_id: targetId,
      claimed_count: 0,
      processed_count: 0,
      failed_count: 0,
      duration_ms: Date.now() - startTime,
    });
    return { claimed: 0, processed: 0, failed: 0 };
  }

  const job = jobs[0];
  let processed = 0;
  let failed = 0;

  try {
    await processZaloCallSummaryJob(job, {
      ...options,
      client: admin,
      deadline: workerDeadline,
    });
    processed = 1;
  } catch {
    failed = 1;
  }

  logSummaryWorkerInvocation({
    action: 'invocation_completed',
    mode: 'TARGETED',
    target_id: targetId,
    claimed_count: 1,
    processed_count: processed,
    failed_count: failed,
    duration_ms: Date.now() - startTime,
  });

  return { claimed: 1, processed, failed };
}

/**
 * Manual retry of a failed summary job by authorized actor.
 */
export async function retryZaloCallSummary(
  companyId: string,
  userId: string,
  summaryId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const admin = client || createAdminClient();
  const { data, error } = await admin.rpc('zalo_retry_call_summary', {
    p_company: companyId,
    p_actor: userId,
    p_summary_id: summaryId,
  });

  if (error) {
    throw new Error(error.message || 'Không thể thử lại tóm tắt AI.');
  }

  logSummaryEvent({
    action: 'manual_retry_requested',
    company_id: companyId,
    summary_id: summaryId,
  });

  return data === true;
}
