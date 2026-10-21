import 'server-only';

export interface SummaryLogPayload {
  action:
    | 'summary_enqueued'
    | 'processing_started'
    | 'summary_completed'
    | 'retry_scheduled'
    | 'summary_failed'
    | 'manual_retry_requested';
  company_id?: string;
  call_id?: string;
  transcription_id?: string;
  summary_id?: string;
  provider?: string;
  model?: string;
  error_code?: string;
  attempts?: number;
  next_run_at?: string;
  is_terminal?: boolean;
  duration_ms?: number;
}

export interface SummaryWorkerLogPayload {
  action: 'invocation_started' | 'invocation_completed' | 'invocation_failed';
  mode: 'BULK' | 'TARGETED';
  limit?: number;
  target_id?: string;
  claimed_count?: number;
  processed_count?: number;
  failed_count?: number;
  duration_ms?: number;
  error_code?: string;
}

export function logSummaryEvent(payload: SummaryLogPayload): void {
  const sanitized = {
    tag: 'zalo-call-summary',
    timestamp: new Date().toISOString(),
    action: payload.action,
    company_id: payload.company_id,
    call_id: payload.call_id,
    transcription_id: payload.transcription_id,
    summary_id: payload.summary_id,
    provider: payload.provider,
    model: payload.model,
    attempts: payload.attempts,
    error_code: payload.error_code,
    next_run_at: payload.next_run_at,
    is_terminal: payload.is_terminal,
    duration_ms: payload.duration_ms,
  };

  const line = [
    `[zalo-call-summary]`,
    `action=${sanitized.action}`,
    sanitized.company_id ? `company_id=${sanitized.company_id}` : null,
    sanitized.summary_id ? `summary_id=${sanitized.summary_id}` : null,
    sanitized.transcription_id ? `transcription_id=${sanitized.transcription_id}` : null,
    sanitized.provider ? `provider=${sanitized.provider}` : null,
    sanitized.model ? `model=${sanitized.model}` : null,
    sanitized.error_code ? `error_code=${sanitized.error_code}` : null,
    sanitized.attempts !== undefined ? `attempts=${sanitized.attempts}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  console.log(line, JSON.stringify(sanitized));
}

export function logSummaryWorkerInvocation(payload: SummaryWorkerLogPayload): void {
  const sanitized = {
    tag: 'zalo-summary-worker',
    timestamp: new Date().toISOString(),
    action: payload.action,
    mode: payload.mode,
    limit: payload.limit,
    target_id: payload.target_id,
    claimed_count: payload.claimed_count ?? 0,
    processed_count: payload.processed_count ?? 0,
    failed_count: payload.failed_count ?? 0,
    duration_ms: payload.duration_ms ?? 0,
    error_code: payload.error_code,
  };

  const line = [
    `[zalo-summary-worker]`,
    `action=${sanitized.action}`,
    `mode=${sanitized.mode}`,
    sanitized.target_id ? `target_id=${sanitized.target_id}` : null,
    sanitized.limit ? `limit=${sanitized.limit}` : null,
    `claimed=${sanitized.claimed_count}`,
    `processed=${sanitized.processed_count}`,
    `failed=${sanitized.failed_count}`,
    `duration_ms=${sanitized.duration_ms}`,
    sanitized.error_code ? `error_code=${sanitized.error_code}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  console.log(line, JSON.stringify(sanitized));
}
