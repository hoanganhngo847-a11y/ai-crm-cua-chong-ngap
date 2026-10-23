import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiMonitoringAlert,
  AiPipelineMetrics,
  AlertEvaluationResult,
  AlertSeverity,
  AlertStatus,
  AlertType,
  SystemHealthStatus,
} from './types';
import { getAiPipelineMetrics } from './metrics';
import { getSystemHealthStatus } from './health';

export interface EvaluateAlertsOptions {
  metrics?: AiPipelineMetrics;
  health?: SystemHealthStatus;
  existingAlerts?: readonly AiMonitoringAlert[];
}

interface TriggerCandidate {
  type: AlertType;
  severity: AlertSeverity;
  fingerprint: string;
  title: string;
  description: string;
  channel?: string;
  metadata: Record<string, unknown>;
}

export async function evaluateAlertConditions(
  supabase: SupabaseClient,
  companyId: string,
  options: EvaluateAlertsOptions = {}
): Promise<AlertEvaluationResult> {
  const queryErrors: Record<string, string> = {};
  let isEvaluationDegraded = false;

  const [metrics, health] = await Promise.all([
    options.metrics ? Promise.resolve(options.metrics) : getAiPipelineMetrics(supabase, companyId, { timeWindow: '1h' }),
    options.health ? Promise.resolve(options.health) : getSystemHealthStatus(supabase),
  ]);

  if (metrics.errors && Object.keys(metrics.errors).length > 0) {
    isEvaluationDegraded = true;
  }

  // Query handover backlog
  const { count: openHandoverCount, error: handoverCountErr } = await supabase
    .from('ai_handover_cases')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'OPEN');

  if (handoverCountErr) {
    queryErrors.handoverCount = handoverCountErr.message;
    isEvaluationDegraded = true;
  }

  const candidates: TriggerCandidate[] = [];

  const javisBrainComponent = health.components.find((c) => c.name === 'Javis Brain');
  const zcajsComponent = health.components.find((c) => c.name === 'ZCAJS Worker');
  const messengerComponent = health.components.find((c) => c.name === 'Messenger Transport');
  const zaloSchedulerComponent = health.components.find(
    (c) => c.name === 'Supabase Scheduler (Zalo)'
  );
  const messengerSchedulerComponent = health.components.find(
    (c) => c.name === 'Supabase Scheduler (Messenger)'
  );
  const legacySchedulerComponent = health.components.find(
    (c) => c.name === 'Supabase scheduler'
  );

  // Rule 1: CRON_CONSECUTIVE_FAILURES (Channel-specific: Zalo and Messenger separated)
  // Preserve per-channel scheduler stats so Messenger failure cannot raise false Zalo CRITICAL or be hidden by healthy Zalo.
  // 1A. Zalo Scheduler
  const zaloStats = metrics.channelSchedulerStats?.['ZALO'];
  const zaloFailures = zaloStats
    ? zaloStats.failures
    : metrics.channel === 'ZALO' || (metrics.channel === 'ALL' && zaloSchedulerComponent?.status !== 'HEALTHY')
      ? metrics.schedulerFailures
      : 0;
  const zaloConsecutiveFailures = zaloStats
    ? zaloStats.consecutiveFailures
    : metrics.channel === 'ZALO' || (metrics.channel === 'ALL' && zaloSchedulerComponent?.status !== 'HEALTHY')
      ? (metrics.schedulerConsecutiveFailures ?? 0)
      : 0;
  const zaloStatus = zaloSchedulerComponent?.status ?? zaloStats?.status;
  const zaloDetails = zaloSchedulerComponent?.details ?? zaloStats?.details;

  const zaloIsUnhealthy = zaloStatus === 'UNHEALTHY' || zaloConsecutiveFailures >= 2;
  const zaloIsDegraded = zaloStatus === 'DEGRADED';

  if ((metrics.channel === 'ZALO' || metrics.channel === 'ALL') && (zaloIsUnhealthy || zaloIsDegraded)) {
    candidates.push({
      type: 'CRON_CONSECUTIVE_FAILURES',
      severity: zaloIsUnhealthy ? 'CRITICAL' : 'HIGH',
      fingerprint: 'CRON_CONSECUTIVE_FAILURES:ZALO',
      title: 'Lỗi lập lịch Supabase pg_cron (Zalo)',
      description:
        zaloDetails ||
        `Scheduler Zalo ghi nhận thất bại liên tiếp hoặc không sẵn sàng.`,
      channel: 'ZALO',
      metadata: {
        channel: 'ZALO',
        schedulerFailures: zaloFailures,
        schedulerConsecutiveFailures: zaloConsecutiveFailures,
        schedulerStatus: zaloStatus,
      },
    });
  }

  // 1B. Messenger Scheduler
  const msgStats = metrics.channelSchedulerStats?.['MESSENGER'];
  const msgFailures = msgStats
    ? msgStats.failures
    : metrics.channel === 'MESSENGER' || (metrics.channel === 'ALL' && messengerSchedulerComponent?.status !== 'HEALTHY')
      ? metrics.schedulerFailures
      : 0;
  const msgConsecutiveFailures = msgStats
    ? msgStats.consecutiveFailures
    : metrics.channel === 'MESSENGER' || (metrics.channel === 'ALL' && messengerSchedulerComponent?.status !== 'HEALTHY')
      ? (metrics.schedulerConsecutiveFailures ?? 0)
      : 0;
  const msgStatus = messengerSchedulerComponent?.status ?? msgStats?.status;
  const msgDetails = messengerSchedulerComponent?.details ?? msgStats?.details;

  const msgIsUnhealthy = msgStatus === 'UNHEALTHY' || msgConsecutiveFailures >= 2;
  const msgIsDegraded = msgStatus === 'DEGRADED';

  if ((metrics.channel === 'MESSENGER' || metrics.channel === 'ALL') && (msgIsUnhealthy || msgIsDegraded)) {
    candidates.push({
      type: 'CRON_CONSECUTIVE_FAILURES',
      severity: msgIsUnhealthy ? 'CRITICAL' : 'HIGH',
      fingerprint: 'CRON_CONSECUTIVE_FAILURES:MESSENGER',
      title: 'Lỗi lập lịch Supabase pg_cron (Messenger)',
      description:
        msgDetails ||
        `Scheduler Messenger ghi nhận thất bại liên tiếp hoặc chưa sẵn sàng.`,
      channel: 'MESSENGER',
      metadata: {
        channel: 'MESSENGER',
        schedulerFailures: msgFailures,
        schedulerConsecutiveFailures: msgConsecutiveFailures,
        schedulerStatus: msgStatus,
      },
    });
  }

  // 1C. Fallback if channel-specific components not in health, but legacy scheduler fired
  const hasChannelCronAlert = candidates.some((c) => c.type === 'CRON_CONSECUTIVE_FAILURES');
  if (
    !hasChannelCronAlert &&
    (metrics.schedulerFailures >= 2 ||
      (metrics.schedulerConsecutiveFailures ?? 0) >= 2 ||
      (legacySchedulerComponent &&
        (legacySchedulerComponent.status === 'UNHEALTHY' ||
          legacySchedulerComponent.status === 'DEGRADED')))
  ) {
    const isUnhealthy =
      legacySchedulerComponent?.status === 'UNHEALTHY' ||
      metrics.schedulerFailures >= 2 ||
      (metrics.schedulerConsecutiveFailures ?? 0) >= 2;
    candidates.push({
      type: 'CRON_CONSECUTIVE_FAILURES',
      severity: isUnhealthy ? 'CRITICAL' : 'HIGH',
      fingerprint: `CRON_CONSECUTIVE_FAILURES:${metrics.channel === 'ALL' ? 'GLOBAL' : metrics.channel}`,
      title: 'Lỗi lập lịch Supabase pg_cron',
      description:
        legacySchedulerComponent?.details ||
        `Scheduler ghi nhận lỗi dispatch gần nhất. Tiến trình auto-reply có thể bị gián đoạn.`,
      channel: metrics.channel,
      metadata: {
        schedulerFailures: metrics.schedulerFailures,
        schedulerConsecutiveFailures: metrics.schedulerConsecutiveFailures,
        schedulerStatus: legacySchedulerComponent?.status,
      },
    });
  }

  // Rule 2: JAVIS_UNAVAILABLE
  if (javisBrainComponent && javisBrainComponent.status === 'UNHEALTHY') {
    candidates.push({
      type: 'JAVIS_UNAVAILABLE',
      severity: 'CRITICAL',
      fingerprint: 'JAVIS_UNAVAILABLE:GLOBAL',
      title: 'Dịch vụ Javis Brain không phản hồi',
      description: `Không thể kết nối hoặc xác thực với Javis Brain (${javisBrainComponent.details}).`,
      channel: 'ALL',
      metadata: { details: javisBrainComponent.details },
    });
  }

  // Rule 3: JAVIS_TIMEOUT_RATE_HIGH
  if (
    metrics.brainTurns !== null &&
    metrics.providerFailures !== null &&
    metrics.brainTurns >= 5 &&
    metrics.providerFailures / metrics.brainTurns > 0.1
  ) {
    const ratePercent = ((metrics.providerFailures / metrics.brainTurns) * 100).toFixed(1);
    candidates.push({
      type: 'JAVIS_TIMEOUT_RATE_HIGH',
      severity: 'HIGH',
      fingerprint: 'JAVIS_TIMEOUT_RATE_HIGH:GLOBAL',
      title: 'Tỷ lệ timeout Javis Brain vượt ngưỡng',
      description: `Ghi nhận ${metrics.providerFailures}/${metrics.brainTurns} lượt xử lý bị timeout hoặc lỗi provider (${ratePercent}%).`,
      channel: 'ALL',
      metadata: { providerFailures: metrics.providerFailures, brainTurns: metrics.brainTurns, ratePercent },
    });
  }

  // Rule 4: ZCAJS_UNAVAILABLE
  if (zcajsComponent && zcajsComponent.status === 'UNHEALTHY') {
    candidates.push({
      type: 'ZCAJS_UNAVAILABLE',
      severity: 'HIGH',
      fingerprint: 'ZCAJS_UNAVAILABLE:ZALO',
      title: 'ZCAJS Worker không phản hồi',
      description: `Không thể kết nối tới ZCAJS Worker (${zcajsComponent.details}). Gửi tin Zalo cá nhân có thể thất bại.`,
      channel: 'ZALO',
      metadata: { details: zcajsComponent.details },
    });
  }

  // Rule 5: MESSENGER_TRANSPORT_UNAVAILABLE
  if (messengerComponent && messengerComponent.status === 'DEGRADED') {
    candidates.push({
      type: 'MESSENGER_TRANSPORT_UNAVAILABLE',
      severity: 'HIGH',
      fingerprint: 'MESSENGER_TRANSPORT_UNAVAILABLE:MESSENGER',
      title: 'Messenger Transport lỗi cấu hình',
      description: messengerComponent.details || 'Cấu hình Facebook Page token hoặc bindings không hợp lệ.',
      channel: 'MESSENGER',
      metadata: { details: messengerComponent.details },
    });
  }

  // Rule 6: FAILED_DELIVERIES_SPIKE
  if (
    metrics.failedCount !== null &&
    (metrics.failedCount >= 3 ||
      (metrics.brainTurns !== null && metrics.brainTurns >= 5 && metrics.failedCount / metrics.brainTurns >= 0.2))
  ) {
    candidates.push({
      type: 'FAILED_DELIVERIES_SPIKE',
      severity: 'HIGH',
      fingerprint: `FAILED_DELIVERIES_SPIKE:${metrics.channel}`,
      title: 'Đột biến lỗi gửi tin AI',
      description: `Ghi nhận ${metrics.failedCount} tin gửi thất bại trong cửa sổ theo dõi.`,
      channel: metrics.channel,
      metadata: { failedCount: metrics.failedCount, brainTurns: metrics.brainTurns },
    });
  }

  // Rule 7: QUEUE_DEPTH_THRESHOLD_EXCEEDED
  if (metrics.queueDepth !== null && metrics.queueDepth > 10) {
    candidates.push({
      type: 'QUEUE_DEPTH_THRESHOLD_EXCEEDED',
      severity: 'HIGH',
      fingerprint: `QUEUE_DEPTH_THRESHOLD_EXCEEDED:${metrics.channel}`,
      title: 'Hàng đợi tin AI vượt ngưỡng',
      description: `Hiện có ${metrics.queueDepth} tin nhắn đang chờ xử lý trong hàng đợi live deliveries.`,
      channel: metrics.channel,
      metadata: { queueDepth: metrics.queueDepth },
    });
  }

  // Rule 8: OLDEST_PENDING_TOO_OLD
  if (metrics.oldestPendingAgeSeconds !== null && metrics.oldestPendingAgeSeconds > 180) {
    candidates.push({
      type: 'OLDEST_PENDING_TOO_OLD',
      severity: 'HIGH',
      fingerprint: `OLDEST_PENDING_TOO_OLD:${metrics.channel}`,
      title: 'Tin nhắn tồn đọng quá lâu trong hàng đợi',
      description: `Tin nhắn cũ nhất đang chờ gửi đã tồn tại ${metrics.oldestPendingAgeSeconds} giây (> 3 phút).`,
      channel: metrics.channel,
      metadata: { oldestPendingAgeSeconds: metrics.oldestPendingAgeSeconds },
    });
  }

  // Per-channel checks for backlog and failed spikes when evaluating 'ALL'
  if (metrics.channel === 'ALL') {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const [channelPendingRes, channelDeliveriesRes] = await Promise.all([
        supabase
          .from('ai_brain_live_deliveries')
          .select('channel, created_at')
          .eq('company_id', companyId)
          .in('send_status', ['PENDING', 'PROCESSING']),
        supabase
          .from('ai_brain_live_deliveries')
          .select('channel, send_status')
          .eq('company_id', companyId)
          .gte('created_at', oneHourAgo),
      ]);

      if (channelPendingRes.error) {
        queryErrors.channelPending = channelPendingRes.error.message;
        isEvaluationDegraded = true;
      }
      if (channelDeliveriesRes.error) {
        queryErrors.channelDeliveries = channelDeliveriesRes.error.message;
        isEvaluationDegraded = true;
      }

      const channelPendingData = !channelPendingRes.error
        ? ((channelPendingRes?.data || []) as Array<{ channel: string; created_at: string }>)
        : null;
      const channelDeliveriesData = !channelDeliveriesRes.error
        ? ((channelDeliveriesRes?.data || []) as Array<{ channel: string; send_status: string }>)
        : null;

      for (const ch of ['ZALO', 'MESSENGER'] as const) {
        // Channel backlog - only evaluate if pending query succeeded without error
        if (channelPendingData !== null) {
          const pendingForCh = channelPendingData.filter((r) => r.channel === ch);
          const chDepth = pendingForCh.length;
          let chOldestAge = 0;
          if (pendingForCh.length > 0) {
            const oldestMs = Math.min(
              ...pendingForCh.map((r) => new Date(r.created_at).getTime()).filter(Number.isFinite)
            );
            if (Number.isFinite(oldestMs)) {
              chOldestAge = Math.max(0, Math.floor((Date.now() - oldestMs) / 1000));
            }
          }

          if (chDepth > 10) {
            candidates.push({
              type: 'QUEUE_DEPTH_THRESHOLD_EXCEEDED',
              severity: 'HIGH',
              fingerprint: `QUEUE_DEPTH_THRESHOLD_EXCEEDED:${ch}`,
              title: `Hàng đợi tin AI vượt ngưỡng (${ch})`,
              description: `Kênh ${ch} hiện có ${chDepth} tin nhắn đang chờ xử lý trong hàng đợi live deliveries.`,
              channel: ch,
              metadata: { queueDepth: chDepth, channel: ch },
            });
          }

          if (chOldestAge > 180) {
            candidates.push({
              type: 'OLDEST_PENDING_TOO_OLD',
              severity: 'HIGH',
              fingerprint: `OLDEST_PENDING_TOO_OLD:${ch}`,
              title: `Tin nhắn tồn đọng quá lâu trong hàng đợi (${ch})`,
              description: `Tin nhắn kênh ${ch} cũ nhất đang chờ gửi đã tồn tại ${chOldestAge} giây (> 3 phút).`,
              channel: ch,
              metadata: { oldestPendingAgeSeconds: chOldestAge, channel: ch },
            });
          }
        }

        // Channel failed spike - only evaluate if deliveries query succeeded without error
        if (channelDeliveriesData !== null) {
          const deliveriesForCh = channelDeliveriesData.filter((r) => r.channel === ch);
          const chTurns = deliveriesForCh.length;
          const chFailed = deliveriesForCh.filter((r) => r.send_status === 'FAILED').length;
          if (chFailed >= 3 || (chTurns >= 5 && chFailed / chTurns >= 0.2)) {
            candidates.push({
              type: 'FAILED_DELIVERIES_SPIKE',
              severity: 'HIGH',
              fingerprint: `FAILED_DELIVERIES_SPIKE:${ch}`,
              title: `Đột biến lỗi gửi tin AI (${ch})`,
              description: `Kênh ${ch} ghi nhận ${chFailed} tin gửi thất bại trong cửa sổ theo dõi.`,
              channel: ch,
              metadata: { failedCount: chFailed, brainTurns: chTurns, channel: ch },
            });
          }
        }
      }
    } catch (err: unknown) {
      queryErrors.channelQueries = err instanceof Error ? err.message : String(err);
      isEvaluationDegraded = true;
    }
  }

  // Rule 9: AI_SEND_RATE_ANOMALY
  if (
    metrics.brainTurns !== null &&
    metrics.averageConfidence !== null &&
    metrics.brainTurns >= 5 &&
    metrics.averageConfidence < 0.6
  ) {
    candidates.push({
      type: 'AI_SEND_RATE_ANOMALY',
      severity: 'WARNING',
      fingerprint: `AI_SEND_RATE_ANOMALY:${metrics.channel}`,
      title: 'Độ tin cậy AI trung bình bất thường',
      description: `Độ tin cậy trung bình của AI đang ở mức ${(metrics.averageConfidence * 100).toFixed(1)}% (thấp hơn ngưỡng khuyến nghị 80%).`,
      channel: metrics.channel,
      metadata: { averageConfidence: metrics.averageConfidence, brainTurns: metrics.brainTurns },
    });
  }

  // Rule 10: HANDOVER_BACKLOG
  if (!handoverCountErr && typeof openHandoverCount === 'number' && openHandoverCount >= 5) {
    candidates.push({
      type: 'HANDOVER_BACKLOG',
      severity: 'WARNING',
      fingerprint: 'HANDOVER_BACKLOG:GLOBAL',
      title: 'Tồn đọng ca chuyển giao nhân viên',
      description: `Hiện có ${openHandoverCount} ca chuyển giao ở trạng thái OPEN chưa được nhân viên tiếp nhận xử lý.`,
      channel: 'ALL',
      metadata: { openHandoverCount },
    });
  }

  // Record / deduplicate candidates via atomic RPC
  let triggeredCount = 0;
  let deduplicatedCount = 0;

  for (const candidate of candidates) {
    const { data, error } = await supabase.rpc('record_ai_monitoring_alert', {
      p_company_id: companyId,
      p_alert_type: candidate.type,
      p_severity: candidate.severity,
      p_fingerprint: candidate.fingerprint,
      p_title: candidate.title,
      p_description: candidate.description,
      p_channel: candidate.channel || 'ALL',
      p_metadata: candidate.metadata,
    });

    if (error) {
      queryErrors.alertPersistence = error.message;
      isEvaluationDegraded = true;
    } else if (data && data.length > 0) {
      if (data[0].deduplicated) {
        deduplicatedCount++;
      } else {
        triggeredCount++;
      }
    }
  }

  // Fetch all currently active or acknowledged alerts
  const { data: alertRows, error: alertsError } = await supabase
    .from('ai_monitoring_alerts')
    .select('*')
    .eq('company_id', companyId)
    .in('status', ['ACTIVE', 'ACKNOWLEDGED'])
    .order('last_triggered_at', { ascending: false });

  let activeAlerts: AiMonitoringAlert[] = [];

  if (alertsError) {
    queryErrors.activeAlerts = alertsError.message;
    isEvaluationDegraded = true;
    // On active-alert read failure, do NOT invent candidate-* IDs or actionable fake persisted alerts.
    // Preserve genuinely known previous persisted alerts if available, clearly stale/unknown.
    // If no prior data, show unknown, never an empty clean-success message/count.
    if (options.existingAlerts && options.existingAlerts.length > 0) {
      activeAlerts = [...options.existingAlerts];
    } else {
      activeAlerts = [];
    }
  } else {
    activeAlerts = (alertRows || []).map((row) => ({
      id: String(row.id),
      companyId: String(row.company_id),
      alertType: row.alert_type as AlertType,
      severity: row.severity as AlertSeverity,
      status: row.status as AlertStatus,
      fingerprint: String(row.fingerprint),
      title: String(row.title),
      description: String(row.description),
      channel: String(row.channel || 'ALL'),
      metadata: (row.metadata || {}) as Record<string, unknown>,
      firstTriggeredAt: String(row.first_triggered_at),
      lastTriggeredAt: String(row.last_triggered_at),
      triggerCount: Number(row.trigger_count || 1),
      acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : null,
      acknowledgedBy: row.acknowledged_by ? String(row.acknowledged_by) : null,
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  return {
    evaluatedCount: 10,
    triggeredCount,
    deduplicatedCount,
    activeAlerts,
    queryErrors: Object.keys(queryErrors).length > 0 ? queryErrors : undefined,
    status: isEvaluationDegraded ? 'DEGRADED' : 'HEALTHY',
  };
}
