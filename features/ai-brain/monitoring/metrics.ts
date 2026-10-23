import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiPipelineMetrics } from './types';

export interface GetMetricsOptions {
  channel?: string;
  timeWindow?: '1h' | '24h' | '7d' | '30d';
  now?: Date;
}

const TIME_WINDOWS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function channelToInteractionChannel(channel: string): string | null {
  const norm = channel.toUpperCase();
  if (norm === 'ZALO') return 'ZALO';
  if (norm === 'MESSENGER') return 'FACEBOOK';
  if (norm === 'VOICE') return 'AI_VOICE';
  return null;
}

export async function getAiPipelineMetrics(
  supabase: SupabaseClient,
  companyId: string,
  options: GetMetricsOptions = {}
): Promise<AiPipelineMetrics> {
  const now = options.now ?? new Date();
  const timeWindow = options.timeWindow ?? '24h';
  const durationMs = TIME_WINDOWS[timeWindow] ?? TIME_WINDOWS['24h'];
  const windowStartIso = new Date(now.getTime() - durationMs).toISOString();
  const channel = (options.channel ?? 'ALL').toUpperCase();

  // 1. Query inbound interactions count (non-sensitive count only, no text selected)
  let inboundQuery = supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('direction', 'INBOUND')
    .eq('type', 'MESSAGE');

  const mappedInteractionChannel = channel !== 'ALL' ? channelToInteractionChannel(channel) : null;
  if (mappedInteractionChannel) {
    inboundQuery = inboundQuery.eq('channel', mappedInteractionChannel);
  }

  inboundQuery = inboundQuery.gte('created_at', windowStartIso);

  // 2. Query ai_brain_live_deliveries within window
  let deliveriesQuery = supabase
    .from('ai_brain_live_deliveries')
    .select('id, channel, status, brain_decision, brain_confidence, error_code, created_at, completed_at')
    .eq('company_id', companyId)
    .gte('created_at', windowStartIso);

  if (channel !== 'ALL') {
    deliveriesQuery = deliveriesQuery.eq('channel', channel);
  }

  // 3. Query current queue depth & oldest pending (across all time, currently pending)
  let pendingQuery = supabase
    .from('ai_brain_live_deliveries')
    .select('id, created_at')
    .eq('company_id', companyId)
    .in('status', ['PENDING', 'LOCKED'])
    .order('created_at', { ascending: true });

  if (channel !== 'ALL') {
    pendingQuery = pendingQuery.eq('channel', channel);
  }

  // 4. Query scheduler dispatch failures from cron_internal (best effort)
  const schedulerQuery = supabase
    .from('ai_brain_live_zalo_dispatch_status')
    .select('created, status_code, has_error, timed_out')
    .order('created', { ascending: false })
    .limit(15);

  const [inboundResult, deliveriesResult, pendingResult, schedulerResult] = await Promise.all([
    inboundQuery,
    deliveriesQuery,
    pendingQuery,
    Promise.resolve(schedulerQuery).catch(() => ({ data: null, error: null })),
  ]);

  const inboundCount = inboundResult.count ?? 0;
  const deliveryRows = (deliveriesResult.data || []) as Array<{
    id: string;
    channel: string;
    status: string;
    brain_decision: string | null;
    brain_confidence: number | null;
    error_code: string | null;
    created_at: string;
    completed_at: string | null;
  }>;

  const pendingRows = (pendingResult.data || []) as Array<{
    id: string;
    created_at: string;
  }>;

  // Aggregate delivery metrics
  let respondCount = 0;
  let handoverCount = 0;
  let noReplyCount = 0;
  let failedCount = 0;
  let sendSuccess = 0;
  let sendFailure = 0;
  let providerFailures = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  const latenciesMs: number[] = [];

  for (const row of deliveryRows) {
    if (row.brain_decision === 'RESPOND') respondCount++;
    if (row.brain_decision === 'HANDOVER') handoverCount++;
    if (row.brain_decision === 'NO_REPLY') noReplyCount++;

    if (row.status === 'SENT') sendSuccess++;
    if (row.status === 'FAILED') {
      failedCount++;
      sendFailure++;
    }

    if (
      row.error_code === 'BRAIN_UNAVAILABLE' ||
      row.error_code === 'BRAIN_TIMEOUT' ||
      row.error_code === 'BRAIN_PROVIDER_ERROR'
    ) {
      providerFailures++;
    }

    if (row.brain_confidence !== null && typeof row.brain_confidence === 'number') {
      confidenceSum += row.brain_confidence;
      confidenceCount++;
    }

    if (row.completed_at && row.created_at) {
      const startMs = new Date(row.created_at).getTime();
      const endMs = new Date(row.completed_at).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        latenciesMs.push(endMs - startMs);
      }
    }
  }

  // Percentiles calculation
  latenciesMs.sort((a, b) => a - b);
  const p50LatencyMs =
    latenciesMs.length > 0 ? latenciesMs[Math.floor(latenciesMs.length * 0.5)] : 0;
  const p95LatencyMs =
    latenciesMs.length > 0
      ? latenciesMs[Math.min(latenciesMs.length - 1, Math.floor(latenciesMs.length * 0.95))]
      : 0;

  const averageConfidence =
    confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(3)) : 0;

  // Queue metrics
  const queueDepth = pendingRows.length;
  let oldestPendingAgeSeconds = 0;
  if (pendingRows.length > 0) {
    const oldestMs = new Date(pendingRows[0].created_at).getTime();
    if (Number.isFinite(oldestMs)) {
      oldestPendingAgeSeconds = Math.max(0, Math.floor((now.getTime() - oldestMs) / 1000));
    }
  }

  // Scheduler failure count
  let schedulerFailures = 0;
  if (schedulerResult && schedulerResult.data && Array.isArray(schedulerResult.data)) {
    for (const run of schedulerResult.data) {
      if (run.has_error || run.timed_out || (typeof run.status_code === 'number' && run.status_code !== 200)) {
        schedulerFailures++;
      }
    }
  }

  return {
    inboundCount,
    brainTurns: deliveryRows.length,
    respondCount,
    handoverCount,
    noReplyCount,
    failedCount,
    sendSuccess,
    sendFailure,
    averageConfidence,
    p50LatencyMs,
    p95LatencyMs,
    queueDepth,
    oldestPendingAgeSeconds,
    providerFailures,
    schedulerFailures,
    channel,
    timeWindow,
    computedAt: now.toISOString(),
  };
}
