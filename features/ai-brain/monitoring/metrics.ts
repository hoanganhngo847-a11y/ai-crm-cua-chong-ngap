import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiPipelineMetrics,
  ChannelSchedulerMetricStats,
  HealthStatusLevel,
  MetricQueryErrors,
} from './types';
import { interpretSchedulerHealth } from './health';

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

type MutableMetricQueryErrors = {
  inbound?: string;
  deliveries?: string;
  pending?: string;
  scheduler?: string;
};

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

  const queryErrorsBuilder: MutableMetricQueryErrors = {};

  // 1. Query inbound interactions count
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
  // Try querying brain_latency_ms; if column is missing (not yet migrated), fall back safely
  async function fetchDeliveries() {
    let q = supabase
      .from('ai_brain_live_deliveries')
      .select('id, channel, send_status, decision, confidence, error_code, brain_latency_ms, created_at, completed_at')
      .eq('company_id', companyId)
      .gte('created_at', windowStartIso);

    if (channel !== 'ALL') {
      q = q.eq('channel', channel);
    }

    const res = await q;
    if (res.error && res.error.message && res.error.message.includes('brain_latency_ms')) {
      // Column does not exist yet; fall back without brain_latency_ms
      let fallbackQ = supabase
        .from('ai_brain_live_deliveries')
        .select('id, channel, send_status, decision, confidence, error_code, created_at, completed_at')
        .eq('company_id', companyId)
        .gte('created_at', windowStartIso);

      if (channel !== 'ALL') {
        fallbackQ = fallbackQ.eq('channel', channel);
      }
      return fallbackQ;
    }
    return res;
  }

  // 3. Query current queue depth & oldest pending
  let pendingQuery = supabase
    .from('ai_brain_live_deliveries')
    .select('id, created_at')
    .eq('company_id', companyId)
    .in('send_status', ['PENDING', 'PROCESSING'])
    .order('created_at', { ascending: true });

  if (channel !== 'ALL') {
    pendingQuery = pendingQuery.eq('channel', channel);
  }

  // 4. Query scheduler dispatch health via sanitized server RPC (service-role only)
  const channelsToCheck: Array<'ZALO' | 'MESSENGER'> =
    channel === 'ALL'
      ? ['ZALO', 'MESSENGER']
      : channel === 'ZALO' || channel === 'MESSENGER'
        ? [channel as 'ZALO' | 'MESSENGER']
        : [];

  async function querySchedulerHealth(ch: 'ZALO' | 'MESSENGER') {
    if (typeof supabase.rpc !== 'function') {
      return { channel: ch, data: null, error: new Error('RPC not available on Supabase client') };
    }
    try {
      const rpcRes = await supabase.rpc('get_ai_channel_scheduler_health', {
        p_channel: ch,
        p_limit: 15,
      });
      if (rpcRes.error) {
        return { channel: ch, data: null, error: rpcRes.error };
      }
      return { channel: ch, data: rpcRes.data, error: null };
    } catch (err: unknown) {
      return { channel: ch, data: null, error: err };
    }
  }

  const [inboundResult, deliveriesResult, pendingResult, schedulerResults] = await Promise.all([
    inboundQuery,
    fetchDeliveries(),
    pendingQuery,
    Promise.all(channelsToCheck.map((ch) => querySchedulerHealth(ch))),
  ]);

  // Handle inbound query result
  let inboundCount: number | null = null;
  if (inboundResult.error) {
    queryErrorsBuilder.inbound = inboundResult.error.message;
  } else {
    inboundCount = inboundResult.count ?? 0;
  }

  // Handle deliveries query result
  interface RawDeliveryMetricsRow {
    id: string;
    channel: string;
    send_status: string;
    decision: string | null;
    confidence: number | null;
    error_code: string | null;
    brain_latency_ms?: number | null;
    created_at: string;
    completed_at: string | null;
  }

  let brainTurns: number | null = null;
  let respondCount: number | null = null;
  let handoverCount: number | null = null;
  let noReplyCount: number | null = null;
  let skippedCount: number | null = null;
  let failedCount: number | null = null;
  let sendSuccess: number | null = null;
  let sendFailure: number | null = null;
  let providerFailures: number | null = null;
  let averageConfidence: number | null = null;
  let p50LatencyMs: number | null = null;
  let p95LatencyMs: number | null = null;
  let p50DeliveryLatencyMs: number | null = null;
  let p95DeliveryLatencyMs: number | null = null;

  if (deliveriesResult.error) {
    queryErrorsBuilder.deliveries = deliveriesResult.error.message;
  } else {
    const deliveryRows = (deliveriesResult.data || []) as RawDeliveryMetricsRow[];
    brainTurns = deliveryRows.length;
    respondCount = 0;
    handoverCount = 0;
    noReplyCount = 0;
    skippedCount = 0;
    failedCount = 0;
    sendSuccess = 0;
    sendFailure = 0;
    providerFailures = 0;
    let confidenceSum = 0;
    let confidenceCount = 0;

    const brainLatenciesMs: number[] = [];
    const deliveryLatenciesMs: number[] = [];

    for (const row of deliveryRows) {
      if (row.decision === 'RESPOND') respondCount++;
      if (row.decision === 'HANDOVER') handoverCount++;
      if (row.decision === 'NO_REPLY') noReplyCount++;

      if (row.send_status === 'SENT') sendSuccess++;
      if (row.send_status === 'SKIPPED') skippedCount++;
      if (row.send_status === 'FAILED') {
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

      if (row.confidence !== null && typeof row.confidence === 'number' && Number.isFinite(row.confidence)) {
        confidenceSum += row.confidence;
        confidenceCount++;
      }

      // Actual Brain latency: only consume brain_latency_ms column persisted from result.latencyMs
      // Exclude missing/null values, explicit unavailable if no data
      if (
        row.brain_latency_ms !== null &&
        row.brain_latency_ms !== undefined &&
        typeof row.brain_latency_ms === 'number' &&
        Number.isFinite(row.brain_latency_ms) &&
        row.brain_latency_ms >= 0
      ) {
        brainLatenciesMs.push(row.brain_latency_ms);
      }

      // Separately labeled delivery latency: completed_at - created_at (includes queue wait)
      if (row.completed_at && row.created_at) {
        const startMs = new Date(row.created_at).getTime();
        const endMs = new Date(row.completed_at).getTime();
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
          deliveryLatenciesMs.push(endMs - startMs);
        }
      }
    }

    averageConfidence =
      confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(3)) : null;

    // Actual Brain latency percentiles
    if (brainLatenciesMs.length > 0) {
      brainLatenciesMs.sort((a, b) => a - b);
      p50LatencyMs = brainLatenciesMs[Math.floor(brainLatenciesMs.length * 0.5)];
      p95LatencyMs = brainLatenciesMs[Math.min(brainLatenciesMs.length - 1, Math.floor(brainLatenciesMs.length * 0.95))];
    } else {
      p50LatencyMs = null;
      p95LatencyMs = null;
    }

    // Delivery latency percentiles
    if (deliveryLatenciesMs.length > 0) {
      deliveryLatenciesMs.sort((a, b) => a - b);
      p50DeliveryLatencyMs = deliveryLatenciesMs[Math.floor(deliveryLatenciesMs.length * 0.5)];
      p95DeliveryLatencyMs = deliveryLatenciesMs[Math.min(deliveryLatenciesMs.length - 1, Math.floor(deliveryLatenciesMs.length * 0.95))];
    } else {
      p50DeliveryLatencyMs = null;
      p95DeliveryLatencyMs = null;
    }
  }

  // Handle pending deliveries query result
  let queueDepth: number | null = null;
  let oldestPendingAgeSeconds: number | null = null;

  if (pendingResult.error) {
    queryErrorsBuilder.pending = pendingResult.error.message;
  } else {
    const pendingRows = (pendingResult.data || []) as Array<{ id: string; created_at: string }>;
    queueDepth = pendingRows.length;
    oldestPendingAgeSeconds = 0;
    if (pendingRows.length > 0) {
      const oldestMs = new Date(pendingRows[0].created_at).getTime();
      if (Number.isFinite(oldestMs)) {
        oldestPendingAgeSeconds = Math.max(0, Math.floor((now.getTime() - oldestMs) / 1000));
      }
    }
  }

  // Handle scheduler health results
  // Invariant: Unknown != numeric failure. Do NOT invent schedulerFailures=1 for empty read or errors.
  const channelSchedulerStats: Record<string, ChannelSchedulerMetricStats> = {};
  let schedulerFailures = 0;
  let schedulerConsecutiveFailures = 0;
  const channelStatuses: HealthStatusLevel[] = [];
  const channelAvailabilities: Array<'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN'> = [];

  for (const sResult of schedulerResults) {
    const interpreted = interpretSchedulerHealth(
      sResult.error ? { error: sResult.error } : sResult.data,
      sResult.channel,
      now
    );

    channelSchedulerStats[interpreted.channel] = {
      channel: interpreted.channel,
      failures: interpreted.totalFailures,
      consecutiveFailures: interpreted.consecutiveFailures,
      status: interpreted.status,
      availability: interpreted.availability,
      details: interpreted.details,
      error: interpreted.error,
    };

    if (interpreted.error) {
      queryErrorsBuilder.scheduler = interpreted.error;
    }

    schedulerFailures += interpreted.totalFailures;
    schedulerConsecutiveFailures = Math.max(
      schedulerConsecutiveFailures,
      interpreted.consecutiveFailures
    );
    channelStatuses.push(interpreted.status);
    channelAvailabilities.push(interpreted.availability);
  }

  let schedulerStatus: HealthStatusLevel = 'HEALTHY';
  let schedulerAvailability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN' = 'AVAILABLE';

  if (channelStatuses.length === 0) {
    schedulerStatus = 'HEALTHY';
    schedulerAvailability = 'AVAILABLE';
  } else if (channelStatuses.some((s) => s === 'UNHEALTHY')) {
    schedulerStatus = 'UNHEALTHY';
    schedulerAvailability = channelAvailabilities.some((a) => a === 'UNAVAILABLE')
      ? 'UNAVAILABLE'
      : 'DEGRADED';
  } else if (channelStatuses.some((s) => s === 'DEGRADED')) {
    schedulerStatus = 'DEGRADED';
    schedulerAvailability = channelAvailabilities.includes('UNKNOWN')
      ? 'UNKNOWN'
      : 'DEGRADED';
  } else if (channelStatuses.every((s) => s === 'HEALTHY')) {
    schedulerStatus = 'HEALTHY';
    schedulerAvailability = 'AVAILABLE';
  }

  const queryErrors: MetricQueryErrors | undefined =
    Object.keys(queryErrorsBuilder).length > 0 ? queryErrorsBuilder : undefined;

  return {
    inboundCount,
    brainTurns,
    respondCount,
    handoverCount,
    noReplyCount,
    skippedCount,
    failedCount,
    sendSuccess,
    sendFailure,
    averageConfidence,
    p50LatencyMs,
    p95LatencyMs,
    p50DeliveryLatencyMs,
    p95DeliveryLatencyMs,
    queueDepth,
    oldestPendingAgeSeconds,
    providerFailures,
    schedulerFailures,
    schedulerConsecutiveFailures,
    schedulerStatus,
    schedulerAvailability,
    channelSchedulerStats: Object.keys(channelSchedulerStats).length > 0 ? channelSchedulerStats : undefined,
    channel,
    timeWindow,
    computedAt: now.toISOString(),
    errors: queryErrors,
  };
}
