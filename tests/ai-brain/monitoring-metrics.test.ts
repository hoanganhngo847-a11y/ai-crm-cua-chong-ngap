import test from 'node:test';
import assert from 'node:assert/strict';
import { getAiPipelineMetrics } from '../../features/ai-brain/monitoring/metrics';

interface ChainableQueryMock<T> {
  eq: () => ChainableQueryMock<T>;
  in: (_field: string, values: string[]) => ChainableQueryMock<T>;
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

test('Monitoring Metrics: Aggregates real schema delivery fields (send_status, decision, confidence, skipped)', async () => {
  const fakeDeliveries = [
    {
      id: 'del-1',
      channel: 'ZALO',
      send_status: 'SENT',
      decision: 'RESPOND',
      confidence: 0.95,
      error_code: null,
      brain_latency_ms: 250,
      created_at: '2026-10-23T01:00:00.000Z',
      completed_at: '2026-10-23T01:00:02.500Z', // 2500ms delivery latency
    },
    {
      id: 'del-2',
      channel: 'ZALO',
      send_status: 'SENT',
      decision: 'RESPOND',
      confidence: 0.88,
      error_code: null,
      brain_latency_ms: 180,
      created_at: '2026-10-23T01:10:00.000Z',
      completed_at: '2026-10-23T01:10:01.500Z', // 1500ms delivery latency
    },
    {
      id: 'del-3',
      channel: 'ZALO',
      send_status: 'SKIPPED',
      decision: 'HANDOVER',
      confidence: 0.70,
      error_code: null,
      brain_latency_ms: 310,
      created_at: '2026-10-23T01:15:00.000Z',
      completed_at: '2026-10-23T01:15:00.800Z', // 800ms delivery latency
    },
    {
      id: 'del-4',
      channel: 'ZALO',
      send_status: 'SKIPPED',
      decision: 'NO_REPLY',
      confidence: 0.99,
      error_code: null,
      brain_latency_ms: 120,
      created_at: '2026-10-23T01:20:00.000Z',
      completed_at: '2026-10-23T01:20:00.500Z', // 500ms delivery latency
    },
    {
      id: 'del-5',
      channel: 'ZALO',
      send_status: 'FAILED',
      decision: 'RESPOND',
      confidence: 0.82,
      error_code: 'BRAIN_TIMEOUT',
      brain_latency_ms: 5000,
      created_at: '2026-10-23T01:25:00.000Z',
      completed_at: '2026-10-23T01:25:05.000Z', // 5000ms delivery latency
    },
  ];

  const fakePending = [
    { id: 'del-pending-1', channel: 'ZALO', created_at: '2026-10-23T01:28:00.000Z' },
  ];

  const fakeSchedulerRuns = [
    { created: '2026-10-23T01:29:00.000Z', status_code: 200, has_error: false, timed_out: false },
    { created: '2026-10-23T01:28:00.000Z', status_code: 500, has_error: true, timed_out: false },
  ];

  let pendingInStatusChecked: string[] = [];

  const mockSupabase: any = {
    rpc: (name: string, args: any) => {
      if (name === 'get_ai_channel_scheduler_health') {
        if (args.p_channel === 'ZALO') {
          return Promise.resolve({
            data: {
              channel: 'ZALO',
              job_exists: true,
              job_active: true,
              job_schedule: '* * * * *',
              runs: fakeSchedulerRuns,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: { runs: [] }, error: null });
      }
      return Promise.resolve({ data: null, error: new Error('Unknown RPC') });
    },
    from: (table: string) => {
      if (table === 'interactions') {
        return {
          select: () => createChainableQuery({ count: 12, error: null }),
        };
      }
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: (fields: string) => {
            if (fields.includes('decision')) {
              return createChainableQuery({ data: fakeDeliveries, error: null });
            }
            const query = createChainableQuery({ data: fakePending, error: null });
            query.in = (_field: string, values: string[]) => {
              pendingInStatusChecked = values;
              return query;
            };
            return query;
          },
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
  assert.equal(metrics.skippedCount, 2, 'Must count 2 SKIPPED deliveries');
  assert.equal(metrics.failedCount, 1);
  assert.equal(metrics.sendSuccess, 2);
  assert.equal(metrics.sendFailure, 1);
  assert.equal(metrics.providerFailures, 1);
  assert.equal(metrics.schedulerFailures, 1, '1 failed run in fakeSchedulerRuns');

  // Verify pending query uses PROCESSING not LOCKED
  assert.ok(pendingInStatusChecked.includes('PROCESSING'), 'Must query PROCESSING status');
  assert.ok(pendingInStatusChecked.includes('PENDING'), 'Must query PENDING status');
  assert.equal(pendingInStatusChecked.includes('LOCKED'), false, 'Must not query nonexistent LOCKED status');

  // Actual Brain Latency (from brain_latency_ms): 120ms, 180ms, 250ms, 310ms, 5000ms
  // p50 index: Math.floor(5 * 0.5) = 2 -> 250ms
  // p95 index: Math.floor(5 * 0.95) = 4 -> 5000ms
  assert.equal(metrics.p50LatencyMs, 250, 'Brain latency p50 must consume brain_latency_ms');
  assert.equal(metrics.p95LatencyMs, 5000, 'Brain latency p95 must consume brain_latency_ms');

  // Delivery Latencies (completed_at - created_at): 500ms, 800ms, 1500ms, 2500ms, 5000ms
  // p50 index: 1500ms
  assert.equal(metrics.p50DeliveryLatencyMs, 1500, 'Separately labeled delivery latency p50');
  assert.equal(metrics.p95DeliveryLatencyMs, 5000, 'Separately labeled delivery latency p95');

  // Average confidence: (0.95 + 0.88 + 0.70 + 0.99 + 0.82) / 5 = 4.34 / 5 = 0.868
  assert.equal(metrics.averageConfidence, 0.868);

  // Queue depth: 1 pending
  assert.equal(metrics.queueDepth, 1);
  // Oldest pending age: fixedNow(01:30:00) - pending(01:28:00) = 120 seconds
  assert.equal(metrics.oldestPendingAgeSeconds, 120);
});

test('Monitoring Metrics: Actual Brain latency differs from queue wait and is unavailable when no data', async () => {
  // Scenario: Worker took 10 seconds to claim and complete, but actual Brain inference took 350ms
  const fakeDeliveries = [
    {
      id: 'del-queue-wait',
      channel: 'MESSENGER',
      send_status: 'SENT',
      decision: 'RESPOND',
      confidence: 0.92,
      error_code: null,
      brain_latency_ms: 350, // Actual Brain inference
      created_at: '2026-10-23T01:00:00.000Z',
      completed_at: '2026-10-23T01:00:10.000Z', // 10,000ms queue wait + execution
    },
  ];

  const mockSupabase: any = {
    rpc: () => Promise.resolve({ data: { runs: [] }, error: null }),
    from: (table: string) => {
      if (table === 'interactions') {
        return { select: () => createChainableQuery({ count: 1, error: null }) };
      }
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: (fields: string) => {
            if (fields.includes('decision')) {
              return createChainableQuery({ data: fakeDeliveries, error: null });
            }
            return createChainableQuery({ data: [], error: null });
          },
        };
      }
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-latency-test', {
    channel: 'MESSENGER',
    timeWindow: '1h',
  });

  // Brain latency must be 350ms, NOT 10,000ms!
  assert.equal(metrics.p50LatencyMs, 350, 'Brain latency must be 350ms from brain_latency_ms');
  assert.equal(metrics.p50DeliveryLatencyMs, 10000, 'Delivery latency includes 10,000ms queue wait');

  // Now test with rows lacking brain_latency_ms (e.g. before migration or missing data)
  const fakeDeliveriesNoBrainLatency = [
    {
      id: 'del-old',
      channel: 'MESSENGER',
      send_status: 'SENT',
      decision: 'RESPOND',
      confidence: 0.90,
      error_code: null,
      brain_latency_ms: null, // No brain latency column/data
      created_at: '2026-10-23T01:00:00.000Z',
      completed_at: '2026-10-23T01:00:05.000Z',
    },
  ];

  const mockSupabaseNoLatency: any = {
    rpc: () => Promise.resolve({ data: { runs: [] }, error: null }),
    from: (table: string) => {
      if (table === 'interactions') {
        return { select: () => createChainableQuery({ count: 1, error: null }) };
      }
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: (fields: string) => {
            if (fields.includes('decision')) {
              return createChainableQuery({ data: fakeDeliveriesNoBrainLatency, error: null });
            }
            return createChainableQuery({ data: [], error: null });
          },
        };
      }
      return {};
    },
  };

  const metricsNoLatency = await getAiPipelineMetrics(mockSupabaseNoLatency, 'comp-no-latency', {
    channel: 'MESSENGER',
    timeWindow: '1h',
  });

  // When brain_latency_ms is absent, must be explicitly null (unavailable, no data, no guessing)
  assert.equal(metricsNoLatency.p50LatencyMs, null, 'Brain latency must be null when column has no data');
  assert.equal(metricsNoLatency.p95LatencyMs, null, 'Brain latency p95 must be null when column has no data');
});

test('Monitoring Metrics: Consecutive failure reset - [fail, success, fail] is streak 1, not 2', async () => {
  // Ordered newest to oldest:
  // Run 0: FAIL (most recent)
  // Run 1: SUCCESS (200) -> breaks consecutive failure streak!
  // Run 2: FAIL (older)
  const fakeRuns = [
    { created: '2026-10-23T02:00:00.000Z', status_code: 500, has_error: true, timed_out: false },
    { created: '2026-10-23T01:59:00.000Z', status_code: 200, has_error: false, timed_out: false },
    { created: '2026-10-23T01:58:00.000Z', status_code: 504, has_error: true, timed_out: true },
  ];

  const mockSupabase: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'ZALO',
          job_exists: true,
          job_active: true,
          job_schedule: '* * * * *',
          extension_available: true,
          view_available: true,
          runs: fakeRuns,
        },
        error: null,
      }),
    from: (table: string) => {
      if (table === 'interactions') return { select: () => createChainableQuery({ count: 0, error: null }) };
      if (table === 'ai_brain_live_deliveries') return { select: () => createChainableQuery({ data: [], error: null }) };
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-streak-test', {
    channel: 'ZALO',
    timeWindow: '1h',
  });

  // [fail, success, fail] streak is 1, not 2! Total failures is 2.
  assert.equal(metrics.schedulerConsecutiveFailures, 1, 'Consecutive failure streak must be 1, not 2');
  assert.equal(metrics.schedulerFailures, 2, 'Total scheduler failures must be 2');
});

test('Monitoring Metrics: Unknown scheduler reads must NOT invent schedulerFailures=1, but show DEGRADED / UNKNOWN', async () => {
  const mockSupabase: any = {
    rpc: () => Promise.resolve({ data: null, error: { message: 'View not found' } }),
    from: (table: string) => {
      if (table === 'interactions') {
        return {
          select: () => createChainableQuery({ count: 0, error: null }),
        };
      }
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: () => createChainableQuery({ data: [], error: null }),
        };
      }
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-empty', {
    channel: 'MESSENGER',
    timeWindow: '24h',
  });

  assert.equal(metrics.inboundCount, 0);
  assert.equal(metrics.brainTurns, 0);
  assert.equal(metrics.sendSuccess, 0);
  assert.equal(metrics.skippedCount, 0);
  assert.equal(metrics.failedCount, 0);

  // Invariant: Unknown != numeric failure. Do NOT invent schedulerFailures=1 for empty/unknown read!
  assert.equal(
    metrics.schedulerFailures,
    0,
    `Must not invent schedulerFailures=1 for unknown read (got ${metrics.schedulerFailures})`
  );
  assert.equal(
    metrics.schedulerStatus,
    'DEGRADED',
    `Unknown scheduler read must be DEGRADED (got ${metrics.schedulerStatus})`
  );
  assert.equal(
    metrics.schedulerAvailability,
    'UNKNOWN',
    `Unknown scheduler read must set availability to UNKNOWN`
  );
  assert.ok(metrics.errors?.scheduler, 'Must record scheduler query error');
});

test('Monitoring Metrics: Query errors on inbound/deliveries/pending do not silently become 0', async () => {
  const mockSupabase: any = {
    rpc: () => Promise.resolve({ data: { runs: [] }, error: null }),
    from: (table: string) => {
      if (table === 'interactions') {
        return {
          select: () => createChainableQuery({ count: null, error: { message: 'Inbound DB error 500' } }),
        };
      }
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: () =>
            createChainableQuery({ data: null, error: { message: 'Deliveries table locked / error' } }),
        };
      }
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-errors', {
    channel: 'ALL',
    timeWindow: '24h',
  });

  // Query errors must NOT silently claim 0!
  assert.equal(metrics.inboundCount, null, 'Inbound count must be null on error');
  assert.equal(metrics.brainTurns, null, 'Brain turns must be null on error');
  assert.equal(metrics.sendSuccess, null, 'Send success must be null on error');
  assert.equal(metrics.queueDepth, null, 'Queue depth must be null on error');
  assert.ok(metrics.errors?.inbound?.includes('Inbound DB error'), 'Records inbound error');
  assert.ok(metrics.errors?.deliveries?.includes('Deliveries table locked'), 'Records deliveries error');
  assert.ok(metrics.errors?.pending?.includes('Deliveries table locked'), 'Records pending error');
});

test('Monitoring Metrics: Fully verified scheduler runs produce 0 failures and HEALTHY status', async () => {
  const mockSupabase: any = {
    rpc: (_name: string, _args: any) =>
      Promise.resolve({
        data: {
          channel: 'MESSENGER',
          job_exists: true,
          job_active: true,
          job_schedule: '* * * * *',
          extension_available: true,
          view_available: true,
          runs: [
            { created: new Date().toISOString(), status_code: 200, has_error: false, timed_out: false },
            { created: new Date().toISOString(), status_code: 200, has_error: false, timed_out: false },
          ],
        },
        error: null,
      }),
    from: (table: string) => {
      if (table === 'interactions') {
        return {
          select: () => createChainableQuery({ count: 5, error: null }),
        };
      }
      if (table === 'ai_brain_live_deliveries') {
        return {
          select: () => createChainableQuery({ data: [], error: null }),
        };
      }
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-healthy', {
    channel: 'MESSENGER',
    timeWindow: '24h',
  });

  assert.equal(metrics.schedulerFailures, 0);
  assert.equal(metrics.schedulerStatus, 'HEALTHY');
  assert.equal(metrics.schedulerAvailability, 'AVAILABLE');
  assert.equal(metrics.channelSchedulerStats?.['MESSENGER']?.status, 'HEALTHY');
});

test('Monitoring Metrics: Pending HTTP null response returns DEGRADED / DEGRADED (never HEALTHY, never AVAILABLE)', async () => {
  const mockSupabase: any = {
    rpc: (_name: string, _args: any) =>
      Promise.resolve({
        data: {
          channel: 'MESSENGER',
          job_exists: true,
          job_active: true,
          job_schedule: '* * * * *',
          extension_available: true,
          view_available: true,
          runs: [
            { created: new Date().toISOString(), status_code: null, has_error: false, timed_out: false },
          ],
        },
        error: null,
      }),
    from: (table: string) => {
      if (table === 'interactions') return { select: () => createChainableQuery({ count: 0, error: null }) };
      if (table === 'ai_brain_live_deliveries') return { select: () => createChainableQuery({ data: [], error: null }) };
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-pending', {
    channel: 'MESSENGER',
    timeWindow: '24h',
  });

  assert.notEqual(metrics.schedulerStatus, 'HEALTHY', 'Pending HTTP must NOT be HEALTHY');
  assert.notEqual(metrics.schedulerAvailability, 'AVAILABLE', 'Pending HTTP must NOT be AVAILABLE');
  assert.equal(metrics.schedulerStatus, 'DEGRADED');
  assert.equal(metrics.schedulerAvailability, 'DEGRADED');
  assert.equal(metrics.schedulerFailures, 0, 'Pending is not a numeric failure');
  assert.equal(metrics.schedulerConsecutiveFailures, 0);
});

test('Monitoring Metrics: Stale run and wrong cadence return DEGRADED in metrics', async () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const mockSupabase: any = {
    rpc: (_name: string, args: any) => {
      if (args.p_channel === 'ZALO') {
        // Stale run
        return Promise.resolve({
          data: {
            channel: 'ZALO',
            job_exists: true,
            job_active: true,
            job_schedule: '* * * * *',
            extension_available: true,
            view_available: true,
            runs: [{ created: fiveMinAgo, status_code: 200, has_error: false, timed_out: false }],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      if (table === 'interactions') return { select: () => createChainableQuery({ count: 0, error: null }) };
      if (table === 'ai_brain_live_deliveries') return { select: () => createChainableQuery({ data: [], error: null }) };
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-stale', {
    channel: 'ZALO',
    timeWindow: '24h',
  });

  assert.equal(metrics.schedulerStatus, 'DEGRADED', 'Stale run must be DEGRADED');
  assert.equal(metrics.schedulerAvailability, 'DEGRADED');
});

test('Monitoring Metrics: Mixed channels in ALL preserve per-channel evidence (healthy Zalo does not hide Messenger, Messenger does not inflate Zalo)', async () => {
  const mockSupabase: any = {
    rpc: (_name: string, args: any) => {
      if (args.p_channel === 'ZALO') {
        // Zalo is healthy
        return Promise.resolve({
          data: {
            channel: 'ZALO',
            job_exists: true,
            job_active: true,
            job_schedule: '* * * * *',
            extension_available: true,
            view_available: true,
            runs: [
              { created: new Date().toISOString(), status_code: 200, has_error: false, timed_out: false },
            ],
          },
          error: null,
        });
      }
      if (args.p_channel === 'MESSENGER') {
        // Messenger has 2 consecutive failures
        return Promise.resolve({
          data: {
            channel: 'MESSENGER',
            job_exists: true,
            job_active: true,
            job_schedule: '* * * * *',
            extension_available: true,
            view_available: true,
            runs: [
              { created: new Date().toISOString(), status_code: 500, has_error: true, timed_out: false },
              { created: new Date(Date.now() - 60000).toISOString(), status_code: 504, has_error: true, timed_out: true },
            ],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: new Error('Unknown') });
    },
    from: (table: string) => {
      if (table === 'interactions') return { select: () => createChainableQuery({ count: 0, error: null }) };
      if (table === 'ai_brain_live_deliveries') return { select: () => createChainableQuery({ data: [], error: null }) };
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-mixed', {
    channel: 'ALL',
    timeWindow: '24h',
  });

  // Aggregate status is UNHEALTHY because Messenger failed
  assert.equal(metrics.schedulerStatus, 'UNHEALTHY');
  assert.equal(metrics.schedulerFailures, 2);
  assert.equal(metrics.schedulerConsecutiveFailures, 2);

  // Per-channel stats are preserved!
  assert.ok(metrics.channelSchedulerStats, 'channelSchedulerStats must be populated');
  const zaloStats = metrics.channelSchedulerStats['ZALO'];
  const msgStats = metrics.channelSchedulerStats['MESSENGER'];

  assert.equal(zaloStats.status, 'HEALTHY', 'Zalo stats must remain HEALTHY');
  assert.equal(zaloStats.failures, 0, 'Zalo must have 0 failures');
  assert.equal(zaloStats.consecutiveFailures, 0, 'Zalo must have 0 consecutive failures');

  assert.equal(msgStats.status, 'UNHEALTHY', 'Messenger stats must be UNHEALTHY');
  assert.equal(msgStats.failures, 2, 'Messenger must have 2 failures');
  assert.equal(msgStats.consecutiveFailures, 2, 'Messenger must have 2 consecutive failures');
});

test('Monitoring Metrics: calculateSchedulerFailureStats: [fail, unknown, fail] MUST NOT streak 2 (streak is 1)', async () => {
  // [fail (500), unknown (null HTTP), fail (504)]
  const fakeRuns = [
    { created: new Date().toISOString(), status_code: 500, has_error: true, timed_out: false },
    { created: new Date(Date.now() - 60000).toISOString(), status_code: null, has_error: false, timed_out: false },
    { created: new Date(Date.now() - 120000).toISOString(), status_code: 504, has_error: true, timed_out: true },
  ];

  const mockSupabase: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'ZALO',
          job_exists: true,
          job_active: true,
          job_schedule: '* * * * *',
          extension_available: true,
          view_available: true,
          runs: fakeRuns,
        },
        error: null,
      }),
    from: (table: string) => {
      if (table === 'interactions') return { select: () => createChainableQuery({ count: 0, error: null }) };
      if (table === 'ai_brain_live_deliveries') return { select: () => createChainableQuery({ data: [], error: null }) };
      return {};
    },
  };

  const metrics = await getAiPipelineMetrics(mockSupabase, 'comp-streak-unknown', {
    channel: 'ZALO',
    timeWindow: '1h',
  });

  // [fail, unknown, fail] streak MUST be 1, NOT 2!
  assert.equal(
    metrics.schedulerConsecutiveFailures,
    1,
    `Consecutive failure streak must be 1 (got ${metrics.schedulerConsecutiveFailures}); unknown response MUST break consecutive evidence`
  );
  assert.equal(metrics.schedulerFailures, 2, 'Total failures must be 2');
});
