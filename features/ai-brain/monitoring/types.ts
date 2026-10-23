import 'server-only';

export type AlertSeverity = 'CRITICAL' | 'HIGH' | 'WARNING' | 'INFO';
export type AlertStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';

export type AlertType =
  | 'CRON_CONSECUTIVE_FAILURES'
  | 'JAVIS_UNAVAILABLE'
  | 'JAVIS_TIMEOUT_RATE_HIGH'
  | 'ZCAJS_UNAVAILABLE'
  | 'MESSENGER_TRANSPORT_UNAVAILABLE'
  | 'FAILED_DELIVERIES_SPIKE'
  | 'QUEUE_DEPTH_THRESHOLD_EXCEEDED'
  | 'OLDEST_PENDING_TOO_OLD'
  | 'AI_SEND_RATE_ANOMALY'
  | 'HANDOVER_BACKLOG';

export type HealthStatusLevel = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNCONFIGURED';

export type ComponentName =
  | 'CRM'
  | 'Javis Brain'
  | 'Javis Runtime'
  | 'ZCAJS Worker'
  | 'Messenger Transport'
  | 'Supabase scheduler'
  | 'Voice/Stringee';

export interface ComponentHealth {
  readonly name: ComponentName;
  readonly status: HealthStatusLevel;
  readonly latencyMs?: number;
  readonly lastCheckedAt: string;
  readonly details?: string;
}

export interface SystemHealthStatus {
  readonly overall: HealthStatusLevel;
  readonly components: readonly ComponentHealth[];
  readonly checkedAt: string;
}

export interface AiPipelineMetrics {
  readonly inboundCount: number;
  readonly brainTurns: number;
  readonly respondCount: number;
  readonly handoverCount: number;
  readonly noReplyCount: number;
  readonly failedCount: number;
  readonly sendSuccess: number;
  readonly sendFailure: number;
  readonly averageConfidence: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly queueDepth: number;
  readonly oldestPendingAgeSeconds: number;
  readonly providerFailures: number;
  readonly schedulerFailures: number;
  readonly channel: string;
  readonly timeWindow: '1h' | '24h' | '7d' | '30d';
  readonly computedAt: string;
}

export interface AiMonitoringAlert {
  readonly id: string;
  readonly companyId: string;
  readonly alertType: AlertType;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly fingerprint: string;
  readonly title: string;
  readonly description: string;
  readonly channel: string;
  readonly metadata: Record<string, unknown>;
  readonly firstTriggeredAt: string;
  readonly lastTriggeredAt: string;
  readonly triggerCount: number;
  readonly acknowledgedAt?: string | null;
  readonly acknowledgedBy?: string | null;
  readonly resolvedAt?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AlertEvaluationResult {
  readonly evaluatedCount: number;
  readonly triggeredCount: number;
  readonly deduplicatedCount: number;
  readonly activeAlerts: readonly AiMonitoringAlert[];
}
