import 'server-only';

export type TranscriptionLogAction =
  | 'transcription_reserved'
  | 'processing_started'
  | 'provider_completed'
  | 'persisted'
  | 'failed'
  | 'retry_scheduled';

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

/**
 * Structured logger for Zalo transcription pipeline.
 * Explicitly guards against logging raw/full transcript text, phone numbers, or provider tokens.
 */
function sanitizeLogSafeIdentifier(val?: string, maxLen = 64): string | undefined {
  if (!val || typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (/^(?:AIza|sk-|Bearer)/i.test(trimmed)) return 'sanitized';
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
