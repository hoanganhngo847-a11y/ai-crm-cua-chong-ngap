import 'server-only';

export type TranscriptionLogAction =
  | 'transcription_reserved'
  | 'processing_started'
  | 'provider_completed'
  | 'persisted'
  | 'failed'
  | 'retry_scheduled';

export type WorkerInvocationMode = 'BULK' | 'TARGETED';

export type WorkerLogAction =
  | 'invocation_started'
  | 'invocation_completed'
  | 'invocation_failed';

export interface StructuredWorkerInvocationLogContext {
  action: WorkerLogAction;
  mode: WorkerInvocationMode;
  target_id?: string;
  limit?: number;
  claimed_count?: number;
  claimed?: number;
  processed_count?: number;
  processed?: number;
  failed_count?: number;
  failed?: number;
  duration_ms?: number;
  error_code?: string;
}

export const ALLOWED_INVOCATION_ERROR_CODES = new Set([
  'INVALID_LIMIT',
  'INVALID_TRANSCRIPTION_ID',
  'CLAIM_FAILED',
  'DATABASE_ERROR',
  'TIMEOUT',
  'WORKER_ERROR',
]);

export function sanitizeInvocationErrorCode(code?: string): string | undefined {
  if (!code || typeof code !== 'string') return undefined;
  if (ALLOWED_INVOCATION_ERROR_CODES.has(code)) return code;
  return 'WORKER_ERROR';
}

export interface StructuredTranscriptionLogContext {
  action: TranscriptionLogAction;
  company_id: string;
  call_id: string;
  recording_id?: string;
  transcription_id?: string;
  channel?: 'LEFT' | 'RIGHT';
  provider?: string;
  model?: string;
  language?: string;
  duration_ms?: number;
  utterances_count?: number;
  attempts?: number;
  error_code?: string;
  next_run_at?: string;
  is_terminal?: boolean;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Structured logger for Zalo transcription pipeline.
 * Explicitly guards against logging raw/full transcript text, phone numbers, or provider tokens.
 */
export function sanitizeLogSafeIdentifier(val?: string, maxLen = 64): string | undefined {
  if (!val || typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (/^(?:AIza|sk-|Bearer)/i.test(trimmed)) return 'sanitized';
  if (/secret|token|key|password/i.test(trimmed)) return 'sanitized';
  if (/^[a-zA-Z0-9_\-.:/]{1,64}$/.test(trimmed) && trimmed.length <= maxLen) {
    return trimmed;
  }
  return 'sanitized';
}

export function logTranscriptionEvent(context: StructuredTranscriptionLogContext): void {
  // Construct safe payload with strictly whitelisted metadata
  const payload = {
    tag: 'zalo-transcription',
    timestamp: new Date().toISOString(),
    action: context.action,
    company_id: context.company_id,
    call_id: context.call_id,
    recording_id: context.recording_id ?? context.call_id,
    transcription_id: context.transcription_id,
    channel: context.channel,
    provider: sanitizeLogSafeIdentifier(context.provider, 32),
    model: sanitizeLogSafeIdentifier(context.model, 64),
    language: context.language,
    duration_ms: context.duration_ms,
    utterances_count: context.utterances_count,
    attempts: context.attempts,
    error_code: context.error_code,
    next_run_at: context.next_run_at,
    is_terminal: context.is_terminal,
  };

  const line = `[zalo-transcription] action=${payload.action} company_id=${payload.company_id} call_id=${payload.call_id}${payload.transcription_id ? ` transcription_id=${payload.transcription_id}` : ''}${payload.error_code ? ` error_code=${payload.error_code}` : ''}${payload.is_terminal !== undefined ? ` terminal=${payload.is_terminal}` : ''}`;

  if (context.action === 'failed' && context.is_terminal) {
    console.error(line, JSON.stringify(payload));
  } else if (context.action === 'failed') {
    console.warn(line, JSON.stringify(payload));
  } else {
    console.info(line, JSON.stringify(payload));
  }
}

export function logWorkerInvocation(context: StructuredWorkerInvocationLogContext): void {
  const safeErrorCode = sanitizeInvocationErrorCode(context.error_code);
  const isFinalOutcome = context.action === 'invocation_completed' || context.action === 'invocation_failed';

  // Only log target_id if it strictly matches UUID format; never log arbitrary invalid target strings
  const safeTargetId = context.target_id && UUID_REGEX.test(context.target_id.trim())
    ? context.target_id.trim()
    : undefined;

  const claimed = context.claimed_count ?? context.claimed ?? (isFinalOutcome ? 0 : undefined);
  const processed = context.processed_count ?? context.processed ?? (isFinalOutcome ? 0 : undefined);
  const failed = context.failed_count ?? context.failed ?? (isFinalOutcome ? 0 : undefined);
  const duration = context.duration_ms ?? (isFinalOutcome ? 0 : undefined);

  const payload: Record<string, unknown> = {
    tag: 'zalo-transcription-worker',
    timestamp: new Date().toISOString(),
    action: context.action,
    mode: context.mode,
  };

  if (safeTargetId) {
    payload.target_id = safeTargetId;
  }
  if (context.limit !== undefined) {
    payload.limit = context.limit;
  }
  if (claimed !== undefined) {
    payload.claimed_count = claimed;
  }
  if (processed !== undefined) {
    payload.processed_count = processed;
  }
  if (failed !== undefined) {
    payload.failed_count = failed;
  }
  if (duration !== undefined) {
    payload.duration_ms = duration;
  }
  if (safeErrorCode) {
    payload.error_code = safeErrorCode;
  }

  const line = `[zalo-transcription-worker] action=${payload.action} mode=${payload.mode}${safeTargetId ? ` target_id=${safeTargetId}` : ''}${payload.limit !== undefined ? ` limit=${payload.limit}` : ''}${claimed !== undefined ? ` claimed=${claimed}` : ''}${processed !== undefined ? ` processed=${processed}` : ''}${failed !== undefined ? ` failed=${failed}` : ''}${duration !== undefined ? ` duration_ms=${duration}` : ''}${payload.error_code ? ` error_code=${payload.error_code}` : ''}`;

  if (context.action === 'invocation_failed') {
    console.error(line, JSON.stringify(payload));
  } else {
    console.info(line, JSON.stringify(payload));
  }
}
