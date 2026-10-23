import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlertConditions } from '../../features/ai-brain/monitoring/alert-evaluator';
import type { AiPipelineMetrics, SystemHealthStatus } from '../../features/ai-brain/monitoring/types';

function createBaseMetrics(overrides: Partial<AiPipelineMetrics> = {}): AiPipelineMetrics {
  return {
    inboundCount: 20,
    brainTurns: 20,
    respondCount: 16,
    handoverCount: 3,
    noReplyCount: 1,
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
      { name: 'Supabase scheduler', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
      { name: 'Voice/Stringee', status: 'HEALTHY', lastCheckedAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

test('Alert Evaluator: CRON_CONSECUTIVE_FAILURES triggers when schedulerFailures >= 2', async () => {
  const triggeredRpcs: any[] = [];
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
    rpc: (name: string, args: any) => {
      triggeredRpcs.push({ name, args });
      return Promise.resolve({ data: [{ alert_id: 'a1', deduplicated: false, trigger_count: 1 }], error: null });
    },
  };

  const metrics = createBaseMetrics({ schedulerFailures: 3 });
  const health = createBaseHealth();

  await evaluateAlertConditions(mockSupabase, 'comp-1', { metrics, health });

  const cronAlert = triggeredRpcs.find((r) => r.args.p_alert_type === 'CRON_CONSECUTIVE_FAILURES');
  assert.ok(cronAlert, 'CRON_CONSECUTIVE_FAILURES should be recorded');
  assert.equal(cronAlert.args.p_severity, 'CRITICAL');
});

test('Alert Evaluator: JAVIS_UNAVAILABLE triggers when Javis Brain is UNHEALTHY', async () => {
  const triggeredRpcs: any[] = [];
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
    rpc: (name: string, args: any) => {
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
  const triggeredRpcs: any[] = [];
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
    rpc: (name: string, args: any) => {
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
  const triggeredRpcs: any[] = [];
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
    rpc: (name: string, args: any) => {
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
  const triggeredRpcs: any[] = [];
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
    rpc: (name: string, args: any) => {
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
  const triggeredRpcs: any[] = [];
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
    rpc: (name: string, args: any) => {
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
  const triggeredRpcs: any[] = [];
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
    rpc: (name: string, args: any) => {
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
