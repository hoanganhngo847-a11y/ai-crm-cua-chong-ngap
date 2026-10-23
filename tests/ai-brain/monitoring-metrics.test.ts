import test from 'node:test';
import assert from 'node:assert/strict';
import { getAiPipelineMetrics } from '../../features/ai-brain/monitoring/metrics';

test('Monitoring Metrics: Aggregates delivery decisions, success, and failures correctly', async () => {
  const fakeDeliveries = [
    {
      id: 'del-1',
      channel: 'ZALO',
      status: 'SENT',
      brain_decision: 'RESPOND',
      brain_confidence: 0.95,
      error_code: null,
      created_at: '2026-10-23T01:00:00.000Z',
      completed_at: '2026-10-23T01:00:02.500Z', // 2500ms
    },
    {
      id: 'del-2',
      channel: 'ZALO',
      status: 'SENT',
      brain_decision: 'RESPOND',
      brain_confidence: 0.88,
      error_code: null,
      created_at: '2026-10-23T01:10:00.000Z',
      completed_at: '2026-10-23T01:10:01.500Z', // 1500ms
    },
    {
      id: 'del-3',
      channel: 'ZALO',
      status: 'SKIPPED',
      brain_decision: 'HANDOVER',
      brain_confidence: 0.70,
      error_code: null,
      created_at: '2026-10-23T01:15:00.000Z',
      completed_at: '2026-10-23T01:15:00.800Z', // 800ms
    },
    {
      id: 'del-4',
      channel: 'ZALO',
      status: 'SKIPPED',
      brain_decision: 'NO_REPLY',
      brain_confidence: 0.99,
      error_code: null,
      created_at: '2026-10-23T01:20:00.000Z',
      completed_at: '2026-10-23T01:20:00.500Z', // 500ms
    },
    {
      id: 'del-5',
      channel: 'ZALO',
      status: 'FAILED',
      brain_decision: 'RESPOND',
      brain_confidence: 0.82,
      error_code: 'BRAIN_TIMEOUT',
      created_at: '2026-10-23T01:25:00.000Z',
      completed_at: '2026-10-23T01:25:05.000Z', // 5000ms
    },
  ];

  const fakePending = [
    { id: 'del-pending-1', created_at: '2026-10-23T01:28:00.000Z' },
  ];

  const fakeSchedulerRuns = [
    { created: '2026-10-23T01:29:00.000Z', status_code: 200, has_error: false, timed_out: false },
    { created: '2026-10-23T01:28:00.000Z', status_code: 500, has_error: true, timed_out: false },
  ];

  const createChainableQuery = (resolveValue: any) => {
    const builder: any = {
      eq: () => builder,
      in: () => builder,
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (onfulfilled: any, onrejected: any) => Promise.resolve(resolveValue).then(onfulfilled, onrejected),
      catch: (onrejected: any) => Promise.resolve(resolveValue).catch(onrejected),
    };
    return builder;
  };

  const mockSupabase: any = {
    from: (table: string) => {
      if (table === 'interactions') {
        return {
          select: () => createChainableQuery({ count: 12, error: null }),
        };
      }
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: (fields: string) => {
            if (fields.includes('brain_decision')) {
              return createChainableQuery({ data: fakeDeliveries, error: null });
            }
            return createChainableQuery({ data: fakePending, error: null });
          },
        };
      }
      if (table === 'ai_brain_live_zalo_dispatch_status') {
        return {
          select: () => createChainableQuery({ data: fakeSchedulerRuns, error: null }),
        };
      }
      return {};
    },
  };

  const fixedNow = new Date('2026-10-23T01:30:00.000Z');
  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-test', {
    channel: 'ZALO',
    timeWindow: '1h',
    now: fixedNow,
  });

  assert.equal(metrics.inboundCount, 12);
  assert.equal(metrics.brainTurns, 5);
  assert.equal(metrics.respondCount, 3);
  assert.equal(metrics.handoverCount, 1);
  assert.equal(metrics.noReplyCount, 1);
  assert.equal(metrics.failedCount, 1);
  assert.equal(metrics.sendSuccess, 2);
  assert.equal(metrics.sendFailure, 1);
  assert.equal(metrics.providerFailures, 1);
  assert.equal(metrics.schedulerFailures, 1);

  // Latencies: 500ms, 800ms, 1500ms, 2500ms, 5000ms
  // p50 index: Math.floor(5 * 0.5) = 2 -> 1500ms
  // p95 index: Math.floor(5 * 0.95) = 4 -> 5000ms
  assert.equal(metrics.p50LatencyMs, 1500);
  assert.equal(metrics.p95LatencyMs, 5000);

  // Average confidence: (0.95 + 0.88 + 0.70 + 0.99 + 0.82) / 5 = 4.34 / 5 = 0.868
  assert.equal(metrics.averageConfidence, 0.868);

  // Queue depth: 1 pending
  assert.equal(metrics.queueDepth, 1);
  // Oldest pending age: fixedNow(01:30:00) - pending(01:28:00) = 120 seconds
  assert.equal(metrics.oldestPendingAgeSeconds, 120);
});

test('Monitoring Metrics: Handles empty records gracefully with zeros and defaults', async () => {
  const mockSupabase: any = {
    from: (table: string) => {
      if (table === 'interactions') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  gte: () => Promise.resolve({ count: 0, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: (fields: string) => {
            if (fields.includes('brain_decision')) {
              return {
                eq: () => ({
                  gte: () => Promise.resolve({ data: [], error: null }),
                }),
              };
            }
            return {
              eq: () => ({
                in: () => ({
                  order: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            };
          },
        };
      }
      if (table === 'ai_brain_live_zalo_dispatch_status') {
        return {
          select: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-empty', {
    channel: 'ALL',
    timeWindow: '24h',
  });

  assert.equal(metrics.inboundCount, 0);
  assert.equal(metrics.brainTurns, 0);
  assert.equal(metrics.respondCount, 0);
  assert.equal(metrics.handoverCount, 0);
  assert.equal(metrics.noReplyCount, 0);
  assert.equal(metrics.failedCount, 0);
  assert.equal(metrics.sendSuccess, 0);
  assert.equal(metrics.sendFailure, 0);
  assert.equal(metrics.averageConfidence, 0);
  assert.equal(metrics.p50LatencyMs, 0);
  assert.equal(metrics.p95LatencyMs, 0);
  assert.equal(metrics.queueDepth, 0);
  assert.equal(metrics.oldestPendingAgeSeconds, 0);
  assert.equal(metrics.providerFailures, 0);
  assert.equal(metrics.schedulerFailures, 0);
});
