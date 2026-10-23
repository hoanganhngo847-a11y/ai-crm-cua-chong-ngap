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
  const [metrics, health] = await Promise.all([
    options.metrics ? Promise.resolve(options.metrics) : getAiPipelineMetrics(supabase, companyId, { timeWindow: '1h' }),
    options.health ? Promise.resolve(options.health) : getSystemHealthStatus(supabase),
  ]);

  // Query handover backlog
  const { count: openHandoverCount } = await supabase
    .from('ai_handover_cases')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'OPEN');

  const candidates: TriggerCandidate[] = [];

  const javisBrainComponent = health.components.find((c) => c.name === 'Javis Brain');
  const zcajsComponent = health.components.find((c) => c.name === 'ZCAJS Worker');
  const messengerComponent = health.components.find((c) => c.name === 'Messenger Transport');
  const schedulerComponent = health.components.find((c) => c.name === 'Supabase scheduler');

  // Rule 1: CRON_CONSECUTIVE_FAILURES
  if (metrics.schedulerFailures >= 2 || (schedulerComponent && schedulerComponent.status === 'UNHEALTHY')) {
    candidates.push({
      type: 'CRON_CONSECUTIVE_FAILURES',
      severity: 'CRITICAL',
      fingerprint: 'CRON_CONSECUTIVE_FAILURES:GLOBAL',
      title: 'Lỗi lập lịch Supabase pg_cron',
      description: `Scheduler ghi nhận ${metrics.schedulerFailures} lần dispatch thất bại gần nhất. Tiến trình auto-reply có thể bị gián đoạn.`,
      channel: 'ALL',
      metadata: { schedulerFailures: metrics.schedulerFailures, schedulerStatus: schedulerComponent?.status },
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
  if (metrics.brainTurns >= 5 && metrics.providerFailures / metrics.brainTurns > 0.1) {
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
  if (metrics.failedCount >= 3 || (metrics.brainTurns >= 5 && metrics.failedCount / metrics.brainTurns >= 0.2)) {
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
  if (metrics.queueDepth > 10) {
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
  if (metrics.oldestPendingAgeSeconds > 180) {
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

  // Rule 9: AI_SEND_RATE_ANOMALY
  if (metrics.brainTurns >= 5 && metrics.averageConfidence < 0.6) {
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
  const backlogCount = openHandoverCount ?? 0;
  if (backlogCount >= 5) {
    candidates.push({
      type: 'HANDOVER_BACKLOG',
      severity: 'WARNING',
      fingerprint: 'HANDOVER_BACKLOG:GLOBAL',
      title: 'Tồn đọng ca chuyển giao nhân viên',
      description: `Hiện có ${backlogCount} ca chuyển giao ở trạng thái OPEN chưa được nhân viên tiếp nhận xử lý.`,
      channel: 'ALL',
      metadata: { openHandoverCount: backlogCount },
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

    if (!error && data && data.length > 0) {
      if (data[0].deduplicated) {
        deduplicatedCount++;
      } else {
        triggeredCount++;
      }
    }
  }

  // Fetch all currently active or acknowledged alerts
  const { data: alertRows } = await supabase
    .from('ai_monitoring_alerts')
    .select('*')
    .eq('company_id', companyId)
    .in('status', ['ACTIVE', 'ACKNOWLEDGED'])
    .order('last_triggered_at', { ascending: false });

  const activeAlerts: AiMonitoringAlert[] = (alertRows || []).map((row) => ({
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

  return {
    evaluatedCount: 10,
    triggeredCount,
    deduplicatedCount,
    activeAlerts,
  };
}
