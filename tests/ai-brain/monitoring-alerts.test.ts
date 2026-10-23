import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { evaluateAlertConditions } from '../../features/ai-brain/monitoring/alert-evaluator';
import {
  assembleAiMonitoringDashboardState,
  fetchAiMonitoringDashboardState,
} from '../../features/ai-brain/monitoring/dashboard';
import type { AiPipelineMetrics, SystemHealthStatus } from '../../features/ai-brain/monitoring/types';

interface TriggeredRpcCall {
  name: string;
  args: Record<string, unknown>;
}

function createBaseMetrics(overrides: Partial<AiPipelineMetrics> = {}): AiPipelineMetrics {
  return {
    inboundCount: 20,
    brainTurns: 20,
    respondCount: 16,
    handoverCount: 3,
    noReplyCount: 1,
    skippedCount: 0,
    failedCount: 0,
    sendSuccess: 16,
    sendFailure: 0,
    averageConfidence: 0.92,
    p50LatencyMs: 800,
    p95LatencyMs: 1400,
    queueDepth: 1,
    oldestPendingAgeSeconds: 15,
    providerFailures: 0,
    schedulerFailures: 0,
    channel: 'ALL',
    timeWindow: '1h',
    computedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createBaseHealth(overrides: Partial<SystemHealthStatus> = {}): SystemHealthStatus {
  return {
    overall: 'HEALTHY',
    checkedAt: new Date().toISOString(),
    components: [
      { name: 'CRM', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Javis Brain', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Javis Runtime', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'ZCAJS Worker', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Messenger Transport', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Supabase Scheduler (Zalo)', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Supabase Scheduler (Messenger)', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Supabase scheduler', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Voice/Stringee', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

test('Alert Evaluator: CRON_CONSECUTIVE_FAILURES triggers when schedulerConsecutiveFailures >= 2', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a1', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({ schedulerConsecutiveFailures: 2, schedulerFailures: 3 });
  const health = createBaseHealth({
    components: [
      { name: 'Supabase Scheduler (Zalo)', status: 'DEGRADED', lastCheckedAt: new Date().toISOString() },
      { name: 'Supabase Scheduler (Messenger)', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
    ],
  });

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const cronAlert = triggeredRpcs.find((r) => r.args.p_alert_type === 'CRON_CONSECUTIVE_FAILURES');
  assert.ok(cronAlert, 'CRON_CONSECUTIVE_FAILURES should be recorded');
  assert.equal(cronAlert.args.p_severity, 'CRITICAL');
});

test('Alert Evaluator: JAVIS_UNAVAILABLE triggers when Javis Brain is UNHEALTHY', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a2', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics();
  const health = createBaseHealth({
    components: [
      { name: 'Javis Brain', status: 'UNHEALTHY', details: 'Connection refused', lastCheckedAt: new Date().toISOString() },
    ],
  });

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const javisAlert = triggeredRpcs.find((r) => r.args.p_alert_type === 'JAVIS_UNAVAILABLE');
  assert.ok(javisAlert, 'JAVIS_UNAVAILABLE should be recorded');
  assert.equal(javisAlert.args.p_severity, 'CRITICAL');
});

test('Alert Evaluator: JAVIS_TIMEOUT_RATE_HIGH triggers when timeout rate > 10%', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a3', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({ brainTurns: 10, providerFailures: 3 }); // 30% timeout rate
  const health = createBaseHealth();

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const timeoutAlert = triggeredRpcs.find((r) => r.args.p_alert_type === 'JAVIS_TIMEOUT_RATE_HIGH');
  assert.ok(timeoutAlert, 'JAVIS_TIMEOUT_RATE_HIGH should be recorded');
  assert.equal(timeoutAlert.args.p_severity, 'HIGH');
});

test('Alert Evaluator: FAILED_DELIVERIES_SPIKE triggers when failedCount >= 3', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a4', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({ failedCount: 4 });
  const health = createBaseHealth();

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const failedAlert = triggeredRpcs.find((r) => r.args.p_alert_type === 'FAILED_DELIVERIES_SPIKE');
  assert.ok(failedAlert, 'FAILED_DELIVERIES_SPIKE should be recorded');
  assert.equal(failedAlert.args.p_severity, 'HIGH');
});

test('Alert Evaluator: QUEUE_DEPTH_THRESHOLD_EXCEEDED triggers when queueDepth > 10', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a5', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({ queueDepth: 14 });
  const health = createBaseHealth();

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const queueAlert = triggeredRpcs.find((r) => r.args.p_alert_type === 'QUEUE_DEPTH_THRESHOLD_EXCEEDED');
  assert.ok(queueAlert, 'QUEUE_DEPTH_THRESHOLD_EXCEEDED should be recorded');
  assert.equal(queueAlert.args.p_severity, 'HIGH');
});

test('Alert Evaluator: OLDEST_PENDING_TOO_OLD triggers when age > 180s', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a6', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({ oldestPendingAgeSeconds: 240 });
  const health = createBaseHealth();

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const ageAlert = triggeredRpcs.find((r) => r.args.p_alert_type === 'OLDEST_PENDING_TOO_OLD');
  assert.ok(ageAlert, 'OLDEST_PENDING_TOO_OLD should be recorded');
  assert.equal(ageAlert.args.p_severity, 'HIGH');
});

test('Alert Evaluator: HANDOVER_BACKLOG triggers when open cases >= 5', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 7, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a7', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics();
  const health = createBaseHealth();

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const backlogAlert = triggeredRpcs.find((r) => r.args.p_alert_type === 'HANDOVER_BACKLOG');
  assert.ok(backlogAlert, 'HANDOVER_BACKLOG should be recorded');
  assert.equal(backlogAlert.args.p_severity, 'WARNING');
});

test('Alert Evaluator: Deduplicates repeated alerts and increments count', async () => {
  let triggerCount = 1;
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({
              data: [
                {
                  id: 'alert-dedup-1',
                  company_id: 'comp-1',
                  alert_type: 'QUEUE_DEPTH_THRESHOLD_EXCEEDED',
                  severity: 'HIGH',
                  status: 'ACTIVE',
                  fingerprint: 'QUEUE_DEPTH_THRESHOLD_EXCEEDED:ALL',
                  title: 'Hàng đợi tin AI vượt ngưỡng',
                  description: 'Hiện có 15 tin nhắn đang chờ xử lý trong hàng đợi.',
                  channel: 'ALL',
                  metadata: {},
                  first_triggered_at: '2026-10-23T01:00:00.000Z',
                  last_triggered_at: '2026-10-23T01:05:00.000Z',
                  trigger_count: 2,
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: () => {
      triggerCount++;
      return Promise.resolve({
        data: [{ alert_id: 'alert-dedup-1', deduplicated: true, trigger_count: triggerCount }],
        error: null,
      });
    },
  };

  const metrics = createBaseMetrics({ queueDepth: 15 });
  const health = createBaseHealth();

  const res = await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  assert.equal(res.deduplicatedCount, 1);
  assert.equal(res.activeAlerts.length, 1);
  assert.equal(res.activeAlerts[0].triggerCount, 2);
});

test('Alert Evaluator: Channel-specific CRON_CONSECUTIVE_FAILURES for Messenger triggers independently of healthy Zalo', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a-msg-cron', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({ channel: 'ALL', schedulerFailures: 0, schedulerConsecutiveFailures: 0 });
  const health = createBaseHealth({
    components: [
      { name: 'CRM', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Supabase Scheduler (Zalo)', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Supabase Scheduler (Messenger)', status: 'UNHEALTHY', details: 'HTTP 500 error', lastCheckedAt: new Date().toISOString() },
    ],
  });

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const messengerAlert = triggeredRpcs.find(
    (r) => r.args.p_alert_type === 'CRON_CONSECUTIVE_FAILURES' && r.args.p_channel === 'MESSENGER'
  );
  assert.ok(messengerAlert, 'CRON_CONSECUTIVE_FAILURES for MESSENGER must trigger even when Zalo is healthy');
  assert.equal(messengerAlert.args.p_fingerprint, 'CRON_CONSECUTIVE_FAILURES:MESSENGER');
  assert.equal(messengerAlert.args.p_severity, 'CRITICAL');

  const zaloAlert = triggeredRpcs.find(
    (r) => r.args.p_alert_type === 'CRON_CONSECUTIVE_FAILURES' && r.args.p_channel === 'ZALO'
  );
  assert.equal(zaloAlert, undefined, 'Zalo is healthy so it must not trigger an alert');
});

test('Alert Evaluator: Channel-specific backlog and failed deliveries spike evaluate per channel', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: (table: string) => {
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: () => ({
            eq: () => ({
              // channelPending
              in: () =>
                Promise.resolve({
                  data: [
                    // 12 pending deliveries for MESSENGER (exceeds threshold of 10)
                    ...Array.from({ length: 12 }, () => ({
                      channel: 'MESSENGER',
                      created_at: new Date(Date.now() - 200000).toISOString(), // > 180s old
                    })),
                    // 2 pending for ZALO (normal)
                    { channel: 'ZALO', created_at: new Date().toISOString() },
                  ],
                  error: null,
                }),
              // channelDeliveries within 1h
              gte: () =>
                Promise.resolve({
                  data: [
                    // Messenger: 4 failed out of 5 (80% failure spike)
                    { channel: 'MESSENGER', send_status: 'FAILED' },
                    { channel: 'MESSENGER', send_status: 'FAILED' },
                    { channel: 'MESSENGER', send_status: 'FAILED' },
                    { channel: 'MESSENGER', send_status: 'FAILED' },
                    { channel: 'MESSENGER', send_status: 'SENT' },
                    // Zalo: 20 sent, 0 failed (healthy)
                    ...Array.from({ length: 20 }, () => ({
                      channel: 'ZALO',
                      send_status: 'SENT',
                    })),
                  ],
                  error: null,
                }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ count: 0, data: [], error: null }),
            in: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      };
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a-chan', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({ channel: 'ALL', queueDepth: 14, oldestPendingAgeSeconds: 200 });
  const health = createBaseHealth();

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  // Verify Messenger backlog alert was raised specifically for channel MESSENGER
  const msgQueueAlert = triggeredRpcs.find(
    (r) => r.args.p_alert_type === 'QUEUE_DEPTH_THRESHOLD_EXCEEDED' && r.args.p_channel === 'MESSENGER'
  );
  assert.ok(msgQueueAlert, 'Must trigger QUEUE_DEPTH_THRESHOLD_EXCEEDED for MESSENGER');
  assert.equal(msgQueueAlert.args.p_fingerprint, 'QUEUE_DEPTH_THRESHOLD_EXCEEDED:MESSENGER');

  // Verify Messenger failed spike was raised specifically for channel MESSENGER
  const msgFailedAlert = triggeredRpcs.find(
    (r) => r.args.p_alert_type === 'FAILED_DELIVERIES_SPIKE' && r.args.p_channel === 'MESSENGER'
  );
  assert.ok(msgFailedAlert, 'Must trigger FAILED_DELIVERIES_SPIKE for MESSENGER');
  assert.equal(msgFailedAlert.args.p_fingerprint, 'FAILED_DELIVERIES_SPIKE:MESSENGER');
});

test('Alert Evaluator: Messenger failure does NOT raise false Zalo CRITICAL when evaluating ALL with channelSchedulerStats', async () => {
  const triggeredRpcs: TriggeredRpcCall[] = [];
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a-crit', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({
    channel: 'ALL',
    schedulerFailures: 2,
    schedulerConsecutiveFailures: 2,
    channelSchedulerStats: {
      ZALO: {
        channel: 'ZALO',
        failures: 0,
        consecutiveFailures: 0,
        status: 'HEALTHY',
        availability: 'AVAILABLE',
      },
      MESSENGER: {
        channel: 'MESSENGER',
        failures: 2,
        consecutiveFailures: 2,
        status: 'UNHEALTHY',
        availability: 'UNAVAILABLE',
      },
    },
  });

  const health = createBaseHealth({
    components: [
      { name: 'Supabase Scheduler (Zalo)', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Supabase Scheduler (Messenger)', status: 'UNHEALTHY', details: 'HTTP 500 error', lastCheckedAt: new Date().toISOString() },
    ],
  });

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  // Messenger must trigger CRITICAL
  const msgAlert = triggeredRpcs.find(
    (r) => r.args.p_alert_type === 'CRON_CONSECUTIVE_FAILURES' && r.args.p_channel === 'MESSENGER'
  );
  assert.ok(msgAlert, 'Messenger must trigger CRON_CONSECUTIVE_FAILURES');
  assert.equal(msgAlert.args.p_severity, 'CRITICAL');
  assert.equal((msgAlert.args.p_metadata as any).schedulerConsecutiveFailures, 2);

  // Zalo MUST NOT trigger an alert at all (healthy Zalo must not receive false CRITICAL from Messenger failure)
  const zaloAlert = triggeredRpcs.find(
    (r) => r.args.p_alert_type === 'CRON_CONSECUTIVE_FAILURES' && r.args.p_channel === 'ZALO'
  );
  assert.equal(zaloAlert, undefined, 'Healthy Zalo must NOT receive false CRITICAL due to Messenger failure');
});

test('Alert Evaluator: Per-channel query errors on pending and deliveries return explicit degradation and queryErrors instead of empty clean result', async () => {
  const mockSupabase: any = {
    from: (table: string) => {
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: null, error: { message: 'Pending query failed 500' } }),
              gte: () => Promise.resolve({ data: null, error: { message: 'Deliveries 1h query failed 500' } }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ count: 0, data: [], error: null }),
            in: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      };
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  };

  const metrics = createBaseMetrics({ channel: 'ALL' });
  const health = createBaseHealth();

  const result = await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  assert.equal(result.status, 'DEGRADED', 'Evaluation must be DEGRADED on query errors');
  assert.ok(result.queryErrors, 'Must return queryErrors');
  assert.ok(result.queryErrors.channelPending?.includes('Pending query failed'), 'Records pending query error');
  assert.ok(result.queryErrors.channelDeliveries?.includes('Deliveries 1h query failed'), 'Records deliveries query error');
});

test('Alert Evaluator: When alert query fails, preserves existing alerts from options rather than empty clean result', async () => {
  const existingAlert = {
    id: 'existing-alert-1',
    companyId: 'comp-1',
    alertType: 'JAVIS_UNAVAILABLE' as const,
    severity: 'CRITICAL' as const,
    status: 'ACTIVE' as const,
    fingerprint: 'JAVIS_UNAVAILABLE:GLOBAL',
    title: 'Dịch vụ Javis Brain không phản hồi',
    description: 'Connection refused',
    channel: 'ALL',
    metadata: {},
    firstTriggeredAt: '2026-10-23T01:00:00.000Z',
    lastTriggeredAt: '2026-10-23T01:05:00.000Z',
    triggerCount: 1,
    createdAt: '2026-10-23T01:00:00.000Z',
    updatedAt: '2026-10-23T01:05:00.000Z',
  };

  const mockSupabase: any = {
    from: (table: string) => {
      if (table === 'ai_monitoring_alerts') {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => Promise.resolve({ data: null, error: { message: 'Alerts table locked' } }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ count: 0, data: [], error: null }),
            in: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      };
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  };

  const metrics = createBaseMetrics();
  const health = createBaseHealth();

  const result = await evaluateAlertConditions(mockSupabase, 'comp-1', {
    metrics,
    health,
    existingAlerts: [existingAlert],
  });

  assert.equal(result.status, 'DEGRADED');
  assert.ok(result.queryErrors?.activeAlerts?.includes('Alerts table locked'));
  assert.equal(result.activeAlerts.length, 1, 'Must preserve existing alerts when query fails, not return empty []');
  assert.equal(result.activeAlerts[0].id, 'existing-alert-1');
});

test('Alert Evaluator: When alert query fails and no prior data exists, marks DEGRADED and does NOT invent candidate-* IDs', async () => {
  const mockSupabase: any = {
    from: (table: string) => {
      if (table === 'ai_monitoring_alerts') {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => Promise.resolve({ data: null, error: { message: 'Alerts table network timeout' } }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ count: 0, data: [], error: null }),
            in: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      };
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  };

  const metrics = createBaseMetrics();
  const health = createBaseHealth({
    components: [
      { name: 'Javis Brain', status: 'UNHEALTHY', details: 'Offline', lastCheckedAt: new Date().toISOString() },
    ],
  });

  const result = await evaluateAlertConditions(mockSupabase, 'comp-1', {
    metrics,
    health,
    existingAlerts: undefined,
  });

  assert.equal(result.status, 'DEGRADED', 'Evaluation must be DEGRADED on alert query failure');
  assert.ok(result.queryErrors?.activeAlerts?.includes('Alerts table network timeout'));
  assert.equal(result.activeAlerts.length, 0, 'Must NOT invent fake candidate alerts when read fails');
  assert.ok(!result.activeAlerts.some((a) => a.id.startsWith('candidate-')), 'No candidate-* IDs permitted');
});

test('Alert Evaluator: Alert RPC persistence failure marks evaluation DEGRADED with queryErrors.alertPersistence', async () => {
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: 0, data: [], error: null }),
          in: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    rpc: () => Promise.resolve({ data: null, error: { message: 'RPC record_ai_monitoring_alert permission denied 42501' } }),
  };

  const metrics = createBaseMetrics({ schedulerConsecutiveFailures: 2, schedulerFailures: 2 });
  const health = createBaseHealth();

  const result = await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  assert.equal(result.status, 'DEGRADED', 'RPC persistence failure must mark evaluation DEGRADED');
  assert.ok(result.queryErrors?.alertPersistence?.includes('permission denied 42501'));
});

test('Alert Evaluator: Handover count query failure marks evaluation DEGRADED with queryErrors.handoverCount', async () => {
  const mockSupabase: any = {
    from: (table: string) => {
      if (table === 'ai_handover_cases') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ count: null, data: null, error: { message: 'relation ai_handover_cases does not exist' } }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            in: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      };
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  };

  const metrics = createBaseMetrics();
  const health = createBaseHealth();

  const result = await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  assert.equal(result.status, 'DEGRADED', 'Handover count query failure must mark evaluation DEGRADED');
  assert.ok(result.queryErrors?.handoverCount?.includes('does not exist'));
});

test('Dashboard Contract: assembleAiMonitoringDashboardState propagates degraded status, errors and stale flag', () => {
  const metrics = createBaseMetrics();
  const health = createBaseHealth();
  const existingAlert = {
    id: 'persisted-alert-99',
    companyId: 'comp-1',
    alertType: 'CRON_CONSECUTIVE_FAILURES' as const,
    severity: 'CRITICAL' as const,
    status: 'ACTIVE' as const,
    fingerprint: 'CRON:ZALO',
    title: 'Cron failed',
    description: 'details',
    channel: 'ZALO',
    metadata: {},
    firstTriggeredAt: '2026-10-23T01:00:00.000Z',
    lastTriggeredAt: '2026-10-23T01:05:00.000Z',
    triggerCount: 3,
    createdAt: '2026-10-23T01:00:00.000Z',
    updatedAt: '2026-10-23T01:05:00.000Z',
  };

  // 1. Degraded with prior alerts -> isAlertsStale = true, alerts preserved
  const stateWithPrior = assembleAiMonitoringDashboardState(
    metrics,
    health,
    {
      evaluatedCount: 10,
      triggeredCount: 0,
      deduplicatedCount: 0,
      activeAlerts: [existingAlert],
      status: 'DEGRADED',
      queryErrors: { activeAlerts: 'DB read error' },
    },
    [existingAlert]
  );
  assert.equal(stateWithPrior.alertsStatus, 'DEGRADED');
  assert.equal(stateWithPrior.evaluationStatus, 'DEGRADED');
  assert.equal(stateWithPrior.isAlertsStale, true);
  assert.equal(stateWithPrior.alerts.length, 1);
  assert.equal(stateWithPrior.alerts[0].id, 'persisted-alert-99');
  assert.equal(stateWithPrior.alertsErrors?.activeAlerts, 'DB read error');

  // 2. Degraded with NO prior alerts -> isAlertsStale = false, alerts empty
  const stateNoPrior = assembleAiMonitoringDashboardState(
    metrics,
    health,
    {
      evaluatedCount: 10,
      triggeredCount: 0,
      deduplicatedCount: 0,
      activeAlerts: [],
      status: 'DEGRADED',
      queryErrors: { activeAlerts: 'DB read error' },
    },
    undefined
  );
  assert.equal(stateNoPrior.alertsStatus, 'DEGRADED');
  assert.equal(stateNoPrior.evaluationStatus, 'DEGRADED');
  assert.equal(stateNoPrior.isAlertsStale, false);
  assert.equal(stateNoPrior.alerts.length, 0);
});

test('Dashboard Contract: fetchAiMonitoringDashboardState wires caller and propagates degradation with genuinely known alerts', async () => {
  const existingAlert = {
    id: 'persisted-alert-123',
    companyId: 'comp-1',
    alertType: 'FAILED_DELIVERIES_SPIKE' as const,
    severity: 'HIGH' as const,
    status: 'ACTIVE' as const,
    fingerprint: 'FAILED:ZALO',
    title: 'Đột biến lỗi gửi tin AI (Zalo)',
    description: '3 failed',
    channel: 'ZALO',
    metadata: {},
    firstTriggeredAt: '2026-10-23T01:00:00.000Z',
    lastTriggeredAt: '2026-10-23T01:10:00.000Z',
    triggerCount: 1,
    createdAt: '2026-10-23T01:00:00.000Z',
    updatedAt: '2026-10-23T01:10:00.000Z',
  };

  interface ChainableQueryMock<T> {
    select: () => ChainableQueryMock<T>;
    eq: () => ChainableQueryMock<T>;
    in: () => ChainableQueryMock<T>;
    gte: () => ChainableQueryMock<T>;
    order: () => ChainableQueryMock<T>;
    limit: () => ChainableQueryMock<T>;
    then: <TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) => Promise<TResult1 | TResult2>;
    catch: <TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
    ) => Promise<T | TResult>;
  }

  const createChainableQuery = <T>(resolveValue: T): ChainableQueryMock<T> => {
    const builder: ChainableQueryMock<T> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (onfulfilled, onrejected) => Promise.resolve(resolveValue).then(onfulfilled, onrejected),
      catch: (onrejected) => Promise.resolve(resolveValue).catch(onrejected),
    };
    return builder;
  };

  const mockSupabase = {
    from: (table: string) => {
      if (table === 'ai_monitoring_alerts') {
        return createChainableQuery({
          data: null,
          error: { message: 'Alerts read failure simulated' },
        });
      }
      return createChainableQuery({ count: 0, data: [], error: null });
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  } as unknown as SupabaseClient;

  // Case 1: Caller provides existingAlerts on refresh during DB outage
  const dashboardState = await fetchAiMonitoringDashboardState(mockSupabase, 'comp-1', {
    channel: 'ALL',
    timeWindow: '1h',
    existingAlerts: [existingAlert],
  });

  assert.equal(dashboardState.alertsStatus, 'DEGRADED', 'Real dashboard state must reflect DEGRADED');
  assert.equal(dashboardState.isAlertsStale, true, 'Real dashboard marks stale when alert query fails');
  assert.equal(dashboardState.alerts.length, 1, 'Preserves genuinely known previous persisted alert');
  assert.equal(dashboardState.alerts[0].id, 'persisted-alert-123', 'Preserves real persisted ID without inventing candidate-*');
  assert.ok(dashboardState.alertsErrors?.activeAlerts?.includes('Alerts read failure'));

  // Case 2: Caller has NO prior data (initial load) during DB outage
  const emptyDashboardState = await fetchAiMonitoringDashboardState(mockSupabase, 'comp-1', {
    channel: 'ALL',
    timeWindow: '1h',
    existingAlerts: undefined,
  });

  assert.equal(emptyDashboardState.alertsStatus, 'DEGRADED', 'Real dashboard state must reflect DEGRADED');
  assert.equal(emptyDashboardState.alerts.length, 0, 'Never invents candidate-* fake alerts');
  assert.ok(!emptyDashboardState.alerts.some((a) => a.id.startsWith('candidate-')));
  assert.ok(emptyDashboardState.alertsErrors?.activeAlerts?.includes('Alerts read failure'));
});
