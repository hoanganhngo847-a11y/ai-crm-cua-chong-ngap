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
  | 'Supabase Scheduler (Zalo)'
  | 'Supabase Scheduler (Messenger)'
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

export interface SchedulerDispatchRun {
  readonly request_id: number | string;
  readonly status_code: number | null;
  readonly timed_out: boolean;
  readonly has_error: boolean;
  readonly created: string;
}

export interface SchedulerHealthRpcResult {
  readonly channel: string;
  readonly job_name?: string;
  readonly job_exists: boolean | null;
  readonly job_active: boolean | null;
  readonly job_schedule: string | null;
  readonly extension_available?: boolean;
  readonly view_available?: boolean;
  readonly runs: readonly SchedulerDispatchRun[];
}

export interface InterpretedSchedulerHealth {
  readonly channel: 'ZALO' | 'MESSENGER';
  readonly status: HealthStatusLevel;
  readonly availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly consecutiveFailures: number;
  readonly totalFailures: number;
  readonly details: string;
  readonly error?: string;
}

export interface ChannelSchedulerMetricStats {
  readonly channel: 'ZALO' | 'MESSENGER';
  readonly failures: number;
  readonly consecutiveFailures: number;
  readonly status: HealthStatusLevel;
  readonly availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly details?: string;
  readonly error?: string;
}

export interface MetricQueryErrors {
  readonly inbound?: string;
  readonly deliveries?: string;
  readonly pending?: string;
  readonly scheduler?: string;
}

export interface AiPipelineMetrics {
  readonly inboundCount: number | null;
  readonly brainTurns: number | null;
  readonly respondCount: number | null;
  readonly handoverCount: number | null;
  readonly noReplyCount: number | null;
  readonly skippedCount: number | null;
  readonly failedCount: number | null;
  readonly sendSuccess: number | null;
  readonly sendFailure: number | null;
  readonly averageConfidence: number | null;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly p50DeliveryLatencyMs?: number | null;
  readonly p95DeliveryLatencyMs?: number | null;
  readonly queueDepth: number | null;
  readonly oldestPendingAgeSeconds: number | null;
  readonly providerFailures: number | null;
  readonly schedulerFailures: number;
  readonly schedulerConsecutiveFailures?: number;
  readonly schedulerStatus?: HealthStatusLevel;
  readonly schedulerAvailability?: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly channelSchedulerStats?: Record<string, ChannelSchedulerMetricStats>;
  readonly channel: string;
  readonly timeWindow: '1h' | '24h' | '7d' | '30d';
  readonly computedAt: string;
  readonly errors?: MetricQueryErrors;
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
  readonly queryErrors?: Record<string, string>;
  readonly status?: HealthStatusLevel;
}

export interface AiMonitoringDashboardState {
  readonly metrics: AiPipelineMetrics;
  readonly health: SystemHealthStatus;
  readonly alerts: readonly AiMonitoringAlert[];
  readonly alertsStatus?: HealthStatusLevel;
  readonly evaluationStatus?: HealthStatusLevel;
  readonly alertsErrors?: Record<string, string>;
  readonly queryErrors?: Record<string, string>;
  readonly isAlertsStale?: boolean;
}
