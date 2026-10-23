import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiMonitoringAlert,
  AiMonitoringDashboardState,
  AiPipelineMetrics,
  AlertEvaluationResult,
  SystemHealthStatus,
} from './types';
import { getAiPipelineMetrics } from './metrics';
import { getSystemHealthStatus } from './health';
import { evaluateAlertConditions } from './alert-evaluator';

export function assembleAiMonitoringDashboardState(
  metrics: AiPipelineMetrics,
  health: SystemHealthStatus,
  alertsResult: AlertEvaluationResult,
  existingAlerts?: readonly AiMonitoringAlert[]
): AiMonitoringDashboardState {
  const isStale = Boolean(
    alertsResult.status === 'DEGRADED' &&
      alertsResult.queryErrors?.activeAlerts &&
      existingAlerts &&
      existingAlerts.length > 0
  );

  return {
    metrics,
    health,
    alerts: [...alertsResult.activeAlerts],
    alertsStatus: alertsResult.status,
    evaluationStatus: alertsResult.status,
    alertsErrors: alertsResult.queryErrors,
    queryErrors: alertsResult.queryErrors,
    isAlertsStale: isStale,
  };
}

export async function fetchAiMonitoringDashboardState(
  supabase: SupabaseClient,
  companyId: string,
  options: {
    channel?: string;
    timeWindow?: '1h' | '24h' | '7d' | '30d';
    existingAlerts?: readonly AiMonitoringAlert[];
  } = {}
): Promise<AiMonitoringDashboardState> {
  const [metrics, health] = await Promise.all([
    getAiPipelineMetrics(supabase, companyId, options),
    getSystemHealthStatus(supabase),
  ]);
  const alertsResult = await evaluateAlertConditions(supabase, companyId, {
    metrics,
    health,
    existingAlerts: options.existingAlerts,
  });

  return assembleAiMonitoringDashboardState(metrics, health, alertsResult, options.existingAlerts);
}
