import 'server-only';

import { createAdminClient } from '../../lib/supabase/admin';

const RECENT_CALL_LIMIT = 30;
const WINDOW_CALL_LIMIT = 1000;
const WINDOW_DAYS = 7;

export type PipelineStageStatus = 'NOT_STARTED' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface PipelineStatusCounts {
  NOT_STARTED: number;
  PENDING: number;
  PROCESSING: number;
  COMPLETED: number;
  FAILED: number;
}

export interface GeminiPoolHealth {
  visible: boolean;
  total: number;
  ready: number;
  cooling: number;
  disabled: number;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
}

export interface PipelineRecentCall {
  id: string;
  remoteDisplayName: string | null;
  direction: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  recordingStatus: string;
  matchingStatus: string;
  transcriptStatus: PipelineStageStatus;
  summaryStatus: PipelineStageStatus;
  transcription: {
    id: string;
    status: string;
    provider: string;
    model: string | null;
    attempts: number;
    maxAttempts: number;
    nextRunAt: string | null;
    errorCode: string | null;
    completedAt: string | null;
  } | null;
  summary: {
    id: string;
    status: string;
    provider: string;
    model: string;
    attempts: number;
    maxAttempts: number;
    nextRunAt: string | null;
    errorCode: string | null;
    leadTemperature: string | null;
    followUpRequired: boolean;
    completedAt: string | null;
  } | null;
}

export interface ZaloAiPipelineDashboard {
  generatedAt: string;
  windowDays: number;
  windowTruncated: boolean;
  totalCalls: number;
  recordingReady: number;
  transcription: PipelineStatusCounts;
  summary: PipelineStatusCounts;
  geminiPool: GeminiPoolHealth;
  recentCalls: PipelineRecentCall[];
}

interface StatusSource {
  transcript_status?: string | null;
  summary_status?: string | null;
  recording_status?: string | null;
}

function blankCounts(): PipelineStatusCounts {
  return { NOT_STARTED: 0, PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
}

function toPipelineStatus(value: unknown): PipelineStageStatus {
  return value === 'PENDING' || value === 'PROCESSING' || value === 'COMPLETED' || value === 'FAILED'
    ? value
    : 'NOT_STARTED';
}

export function safePipelineErrorCode(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  return /^[A-Z][A-Z0-9_:-]{0,99}$/.test(normalized) ? normalized : 'PROVIDER_ERROR';
}

export function aggregatePipelineStatuses(rows: StatusSource[]) {
  const transcription = blankCounts();
  const summary = blankCounts();
  let recordingReady = 0;

  for (const row of rows) {
    if (row.recording_status === 'READY') recordingReady += 1;
    transcription[toPipelineStatus(row.transcript_status)] += 1;
    summary[toPipelineStatus(row.summary_status)] += 1;
  }

  return { transcription, summary, recordingReady };
}

export async function getZaloAiPipelineDashboard(companyId: string): Promise<ZaloAiPipelineDashboard> {
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) {
    throw new Error('INVALID_COMPANY');
  }

  const admin = createAdminClient();
  const generatedAt = new Date();
  const windowStart = new Date(generatedAt.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [windowResult, recentResult] = await Promise.all([
    admin
      .from('zalo_personal_calls')
      .select('recording_status,transcript_status,summary_status')
      .eq('company_id', companyId)
      .gte('started_at', windowStart)
      .order('started_at', { ascending: false })
      .limit(WINDOW_CALL_LIMIT),
    admin
      .from('zalo_personal_calls')
      .select('id,remote_display_name,direction,started_at,ended_at,duration_seconds,recording_status,matching_status,transcript_status,summary_status')
      .eq('company_id', companyId)
      .order('started_at', { ascending: false })
      .limit(RECENT_CALL_LIMIT),
  ]);

  if (windowResult.error || recentResult.error) {
    throw new Error('PIPELINE_MONITORING_UNAVAILABLE');
  }

  const windowRows = (windowResult.data || []) as StatusSource[];
  const recentRows = recentResult.data || [];
  const callIds = recentRows.map((row) => String(row.id));

  let transcriptionRows: Array<Record<string, unknown>> = [];
  let summaryRows: Array<Record<string, unknown>> = [];

  if (callIds.length > 0) {
    const [txResult, summaryResult] = await Promise.all([
      admin
        .from('zalo_call_transcriptions')
        .select('id,call_id,status,provider,model,attempts,max_attempts,next_run_at,error_code,completed_at')
        .eq('company_id', companyId)
        .in('call_id', callIds),
      admin
        .from('zalo_call_ai_summaries')
        .select('id,call_id,transcription_id,status,provider,model,attempts,max_attempts,next_run_at,error_code,lead_temperature,follow_up_required,completed_at')
        .eq('company_id', companyId)
        .in('call_id', callIds),
    ]);

    if (txResult.error || summaryResult.error) {
      throw new Error('PIPELINE_MONITORING_UNAVAILABLE');
    }

    transcriptionRows = (txResult.data || []) as Array<Record<string, unknown>>;
    summaryRows = (summaryResult.data || []) as Array<Record<string, unknown>>;
  }

  const txByCall = new Map(transcriptionRows.map((row) => [String(row.call_id), row]));
  const summaryByCall = new Map(summaryRows.map((row) => [String(row.call_id), row]));
  const aggregate = aggregatePipelineStatuses(windowRows);

  let geminiPool: GeminiPoolHealth = {
    visible: false,
    total: 0,
    ready: 0,
    cooling: 0,
    disabled: 0,
    lastUsedAt: null,
    lastSuccessAt: null,
  };

  if (process.env.GEMINI_POOL_ADMIN_COMPANY_ID === companyId) {
    const { data: poolData, error: poolError } = await admin
      .from('gemini_api_key_pool')
      .select('enabled,cooldown_until,last_used_at,last_success_at');

    if (!poolError) {
      const now = generatedAt.getTime();
      let ready = 0;
      let cooling = 0;
      let disabled = 0;
      let lastUsedAt: string | null = null;
      let lastSuccessAt: string | null = null;

      for (const item of poolData || []) {
        if (!item.enabled) {
          disabled += 1;
        } else if (item.cooldown_until && new Date(item.cooldown_until).getTime() > now) {
          cooling += 1;
        } else {
          ready += 1;
        }

        if (item.last_used_at && (!lastUsedAt || item.last_used_at > lastUsedAt)) lastUsedAt = item.last_used_at;
        if (item.last_success_at && (!lastSuccessAt || item.last_success_at > lastSuccessAt)) lastSuccessAt = item.last_success_at;
      }

      geminiPool = {
        visible: true,
        total: (poolData || []).length,
        ready,
        cooling,
        disabled,
        lastUsedAt,
        lastSuccessAt,
      };
    }
  }

  const recentCalls: PipelineRecentCall[] = recentRows.map((row) => {
    const callId = String(row.id);
    const tx = txByCall.get(callId);
    const summary = summaryByCall.get(callId);

    return {
      id: callId,
      remoteDisplayName: typeof row.remote_display_name === 'string' ? row.remote_display_name : null,
      direction: String(row.direction || 'UNKNOWN'),
      startedAt: String(row.started_at),
      endedAt: String(row.ended_at),
      durationSeconds: Number(row.duration_seconds || 0),
      recordingStatus: String(row.recording_status || 'UNKNOWN'),
      matchingStatus: String(row.matching_status || 'UNMATCHED'),
      transcriptStatus: toPipelineStatus(row.transcript_status),
      summaryStatus: toPipelineStatus(row.summary_status),
      transcription: tx
        ? {
            id: String(tx.id),
            status: String(tx.status || 'UNKNOWN'),
            provider: String(tx.provider || 'UNKNOWN'),
            model: typeof tx.model === 'string' ? tx.model : null,
            attempts: Number(tx.attempts || 0),
            maxAttempts: Number(tx.max_attempts || 0),
            nextRunAt: typeof tx.next_run_at === 'string' ? tx.next_run_at : null,
            errorCode: safePipelineErrorCode(tx.error_code),
            completedAt: typeof tx.completed_at === 'string' ? tx.completed_at : null,
          }
        : null,
      summary: summary
        ? {
            id: String(summary.id),
            status: String(summary.status || 'UNKNOWN'),
            provider: String(summary.provider || 'UNKNOWN'),
            model: String(summary.model || 'UNKNOWN'),
            attempts: Number(summary.attempts || 0),
            maxAttempts: Number(summary.max_attempts || 0),
            nextRunAt: typeof summary.next_run_at === 'string' ? summary.next_run_at : null,
            errorCode: safePipelineErrorCode(summary.error_code),
            leadTemperature: typeof summary.lead_temperature === 'string' ? summary.lead_temperature : null,
            followUpRequired: summary.follow_up_required === true,
            completedAt: typeof summary.completed_at === 'string' ? summary.completed_at : null,
          }
        : null,
    };
  });

  return {
    generatedAt: generatedAt.toISOString(),
    windowDays: WINDOW_DAYS,
    windowTruncated: windowRows.length >= WINDOW_CALL_LIMIT,
    totalCalls: windowRows.length,
    recordingReady: aggregate.recordingReady,
    transcription: aggregate.transcription,
    summary: aggregate.summary,
    geminiPool,
    recentCalls,
  };
}
