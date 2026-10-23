import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkJavisBrainHealth,
  checkJavisRuntimeHealth,
  checkZcajsWorkerHealth,
  checkMessengerTransportHealth,
  checkSchedulerHealth,
  checkVoiceStringeeHealth,
  getSystemHealthStatus,
  interpretSchedulerHealth,
} from '../../features/ai-brain/monitoring/health';

test('Monitoring Health: Javis Brain returns UNCONFIGURED when environment is missing', async () => {
  const origBase = process.env.JAVIS_BRAIN_BASE_URL;
  const origToken = process.env.JAVIS_BRAIN_INTERNAL_TOKEN;
  try {
    delete process.env.JAVIS_BRAIN_BASE_URL;
    delete process.env.JAVIS_BRAIN_INTERNAL_TOKEN;

    const res = await checkJavisBrainHealth();
    assert.equal(res.name, 'Javis Brain');
    assert.equal(res.status, 'UNCONFIGURED');
  } finally {
    if (origBase) process.env.JAVIS_BRAIN_BASE_URL = origBase;
    if (origToken) process.env.JAVIS_BRAIN_INTERNAL_TOKEN = origToken;
  }
});

test('Monitoring Health: Javis Brain returns HEALTHY on 200 with contract header', async () => {
  const origBase = process.env.JAVIS_BRAIN_BASE_URL;
  const origToken = process.env.JAVIS_BRAIN_INTERNAL_TOKEN;
  try {
    process.env.JAVIS_BRAIN_BASE_URL = 'https://fake-brain.example.com';
    process.env.JAVIS_BRAIN_INTERNAL_TOKEN = 'secret-token-12345678901234567890';

    let requestedUrl = '';
    let requestHeaders: Record<string, string> = {};

    const fakeFetch = async (url: unknown, init: { headers: Record<string, string> }) => {
      requestedUrl = String(url);
      requestHeaders = init.headers;
      return new Response(JSON.stringify({ ok: true, service: 'javis-brain', version: 'v1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const res = await checkJavisBrainHealth({ fetchFn: fakeFetch as unknown as typeof fetch });
    assert.equal(res.status, 'HEALTHY');
    assert.equal(requestedUrl, 'https://fake-brain.example.com/health');
    assert.equal(requestHeaders['Authorization'], 'Bearer secret-token-12345678901234567890');
    assert.equal(requestHeaders['x-ai-brain-contract'], 'v1');
    assert.ok(typeof res.latencyMs === 'number');
  } finally {
    if (origBase) process.env.JAVIS_BRAIN_BASE_URL = origBase;
    else delete process.env.JAVIS_BRAIN_BASE_URL;
    if (origToken) process.env.JAVIS_BRAIN_INTERNAL_TOKEN = origToken;
    else delete process.env.JAVIS_BRAIN_INTERNAL_TOKEN;
  }
});

test('Monitoring Health: Javis Brain returns UNHEALTHY on 401 Unauthorized', async () => {
  const origBase = process.env.JAVIS_BRAIN_BASE_URL;
  const origToken = process.env.JAVIS_BRAIN_INTERNAL_TOKEN;
  try {
    process.env.JAVIS_BRAIN_BASE_URL = 'https://fake-brain.example.com';
    process.env.JAVIS_BRAIN_INTERNAL_TOKEN = 'wrong-token';

    const fakeFetch = async () => new Response('Unauthorized', { status: 401 });
    const res = await checkJavisBrainHealth({ fetchFn: fakeFetch as unknown as typeof fetch });
    assert.equal(res.status, 'UNHEALTHY');
    assert.ok(res.details?.includes('401'));
  } finally {
    if (origBase) process.env.JAVIS_BRAIN_BASE_URL = origBase;
    else delete process.env.JAVIS_BRAIN_BASE_URL;
    if (origToken) process.env.JAVIS_BRAIN_INTERNAL_TOKEN = origToken;
    else delete process.env.JAVIS_BRAIN_INTERNAL_TOKEN;
  }
});

test('Monitoring Health: ZCAJS returns UNCONFIGURED when worker URL is missing', async () => {
  const origUrl = process.env.ZALO_ZCAJS_WORKER_URL;
  try {
    delete process.env.ZALO_ZCAJS_WORKER_URL;
    const res = await checkZcajsWorkerHealth();
    assert.equal(res.status, 'UNCONFIGURED');
  } finally {
    if (origUrl) process.env.ZALO_ZCAJS_WORKER_URL = origUrl;
  }
});

test('Monitoring Health: Messenger Transport parses Page Bindings JSON correctly', async () => {
  const origBindings = process.env.META_PAGE_BINDINGS;
  try {
    process.env.META_PAGE_BINDINGS = JSON.stringify([
      { page: '123456', company: '00000000-0000-0000-0000-000000000001', tokenEnv: 'META_PAGE_MAIN_TOKEN' },
    ]);
    const res = await checkMessengerTransportHealth();
    assert.equal(res.status, 'HEALTHY');
    assert.ok(res.details?.includes('1 Facebook Page bindings'));
  } finally {
    if (origBindings) process.env.META_PAGE_BINDINGS = origBindings;
    else delete process.env.META_PAGE_BINDINGS;
  }
});

test('Monitoring Health: Scheduler returns DEGRADED when Supabase is not provided (never fabricate HEALTHY)', async () => {
  const res = await checkSchedulerHealth(undefined, 'ZALO');
  assert.equal(res.status, 'DEGRADED', 'Unconfigured client must not fabricate HEALTHY');
});

test('Monitoring Health: Scheduler detects fully verified healthy run via sanitized RPC', async () => {
  const mockSupabase: any = {
    rpc: (name: string, args: any) => {
      if (name === 'get_ai_channel_scheduler_health' && args.p_channel === 'ZALO') {
        return Promise.resolve({
          data: {
            channel: 'ZALO',
            job_name: 'ai_brain_live_zalo_worker',
            job_exists: true,
            job_active: true,
            job_schedule: '* * * * *',
            extension_available: true,
            view_available: true,
            runs: [
              {
                request_id: 101,
                created: new Date().toISOString(),
                status_code: 200,
                has_error: false,
                timed_out: false,
              },
            ],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: new Error('Unknown') });
    },
  };

  const res = await checkSchedulerHealth(mockSupabase, 'ZALO');
  assert.equal(res.status, 'HEALTHY');
  assert.equal(res.name, 'Supabase Scheduler (Zalo)');
  assert.ok(res.details?.includes('HTTP 200'));
});

test('Monitoring Health: Scheduler rejects null HTTP response (pending status is NOT HEALTHY)', async () => {
  const mockSupabase: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'MESSENGER',
          job_exists: true,
          job_active: true,
          job_schedule: '* * * * *',
          runs: [
            {
              request_id: 102,
              created: new Date().toISOString(),
              status_code: null, // HTTP response pending / null
              has_error: false,
              timed_out: false,
            },
          ],
        },
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockSupabase, 'MESSENGER');
  assert.notEqual(res.status, 'HEALTHY', 'Null HTTP response must NOT say HEALTHY');
  assert.equal(res.status, 'DEGRADED', 'Pending HTTP response is DEGRADED/pending');
  assert.ok(res.details?.includes('status_code is null'));
});

test('Monitoring Health: Scheduler rejects missing job in pg_cron (job_exists=false)', async () => {
  const mockSupabase: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'MESSENGER',
          job_name: 'ai_brain_live_messenger_worker',
          job_exists: false, // Job absent from cron.job
          job_active: false,
          job_schedule: null,
          runs: [],
        },
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockSupabase, 'MESSENGER');
  assert.equal(res.status, 'UNHEALTHY');
  assert.ok(res.details?.includes('chưa được đăng ký trong pg_cron'));
});

test('Monitoring Health: Scheduler rejects inactive job (job_active=false)', async () => {
  const mockSupabase: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'ZALO',
          job_name: 'ai_brain_live_zalo_worker',
          job_exists: true,
          job_active: false, // Disabled
          job_schedule: '* * * * *',
          runs: [
            {
              request_id: 103,
              created: new Date().toISOString(),
              status_code: 200,
              has_error: false,
              timed_out: false,
            },
          ],
        },
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockSupabase, 'ZALO');
  assert.equal(res.status, 'UNHEALTHY', 'Inactive job must NOT be HEALTHY');
  assert.ok(res.details?.includes('vô hiệu hóa'));
});

test('Monitoring Health: Scheduler rejects wrong cadence (e.g. 5-min instead of 1-min)', async () => {
  const mockSupabase: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'MESSENGER',
          job_exists: true,
          job_active: true,
          job_schedule: '*/5 * * * *', // Wrong cadence
          runs: [
            {
              request_id: 104,
              created: new Date().toISOString(),
              status_code: 200,
              has_error: false,
              timed_out: false,
            },
          ],
        },
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockSupabase, 'MESSENGER');
  assert.notEqual(res.status, 'HEALTHY');
  assert.equal(res.status, 'DEGRADED');
  assert.ok(res.details?.includes('Chu kỳ cron job không đúng'));
});

test('Monitoring Health: Scheduler rejects missing latest dispatch (runs=[])', async () => {
  const mockSupabase: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'ZALO',
          job_exists: true,
          job_active: true,
          job_schedule: '* * * * *',
          runs: [], // No dispatch records
        },
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockSupabase, 'ZALO');
  assert.notEqual(res.status, 'HEALTHY');
  assert.equal(res.status, 'DEGRADED');
  assert.ok(res.details?.includes('missing dispatch evidence'));
});

test('Monitoring Health: Scheduler rejects null or invalid or future timestamps', async () => {
  // 1. Null timestamp
  const mockNullTime: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          runs: [{ request_id: 1, created: null, status_code: 200, has_error: false, timed_out: false }],
        },
        error: null,
      }),
  };
  const resNull = await checkSchedulerHealth(mockNullTime, 'ZALO');
  assert.equal(resNull.status, 'DEGRADED');
  assert.ok(resNull.details?.includes('null'));

  // 2. Invalid timestamp string
  const mockInvalidTime: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          runs: [{ request_id: 2, created: 'invalid-date', status_code: 200, has_error: false, timed_out: false }],
        },
        error: null,
      }),
  };
  const resInvalid = await checkSchedulerHealth(mockInvalidTime, 'ZALO');
  assert.equal(resInvalid.status, 'DEGRADED');
  assert.ok(resInvalid.details?.includes('không hợp lệ'));

  // 3. Future timestamp
  const futureTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const mockFutureTime: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          runs: [{ request_id: 3, created: futureTime, status_code: 200, has_error: false, timed_out: false }],
        },
        error: null,
      }),
  };
  const resFuture = await checkSchedulerHealth(mockFutureTime, 'ZALO');
  assert.equal(resFuture.status, 'DEGRADED');
  assert.ok(resFuture.details?.includes('tương lai'));
});

test('Monitoring Health: Supabase scheduler detects recent error run', async () => {
  const mockSupabase: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'MESSENGER',
          job_exists: true,
          job_active: true,
          job_schedule: '* * * * *',
          runs: [
            {
              request_id: 105,
              created: new Date().toISOString(),
              status_code: 504,
              has_error: true,
              timed_out: true,
            },
          ],
        },
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockSupabase, 'MESSENGER');
  assert.equal(res.status, 'UNHEALTHY');
  assert.equal(res.name, 'Supabase Scheduler (Messenger)');
  assert.ok(res.details?.includes('HTTP 504'));
});

test('Monitoring Health: Separates Zalo and Messenger scheduler health so Zalo cannot mask Messenger failure', async () => {
  const mockSupabase: any = {
    rpc: (name: string, args: any) => {
      if (name === 'get_ai_channel_scheduler_health') {
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
                {
                  request_id: 106,
                  created: new Date().toISOString(),
                  status_code: 200,
                  has_error: false,
                  timed_out: false,
                },
              ],
            },
            error: null,
          });
        }
        if (args.p_channel === 'MESSENGER') {
          // Messenger has error
          return Promise.resolve({
            data: {
              channel: 'MESSENGER',
              job_exists: true,
              job_active: true,
              job_schedule: '* * * * *',
              extension_available: true,
              view_available: true,
              runs: [
                {
                  request_id: 107,
                  created: new Date().toISOString(),
                  status_code: 500,
                  has_error: true,
                  timed_out: false,
                },
              ],
            },
            error: null,
          });
        }
      }
      return Promise.resolve({ data: null, error: new Error('Unknown RPC') });
    },
  };

  const zaloHealth = await checkSchedulerHealth(mockSupabase, 'ZALO');
  const messengerHealth = await checkSchedulerHealth(mockSupabase, 'MESSENGER');

  assert.equal(zaloHealth.status, 'HEALTHY');
  assert.equal(messengerHealth.status, 'UNHEALTHY');

  const systemHealth = await getSystemHealthStatus(mockSupabase, {
    fetchFn: async () => new Response('ok', { status: 200 }),
  });

  // ZALO HEALTHY MUST NOT MASK MESSENGER UNHEALTHY!
  assert.equal(
    systemHealth.overall,
    'UNHEALTHY',
    'Overall system health must be UNHEALTHY when Messenger scheduler fails, even if Zalo is healthy'
  );
  assert.ok(
    systemHealth.components.some(
      (c) => c.name === 'Supabase Scheduler (Messenger)' && c.status === 'UNHEALTHY'
    )
  );
  assert.ok(
    systemHealth.components.some(
      (c) => c.name === 'Supabase Scheduler (Zalo)' && c.status === 'HEALTHY'
    )
  );
});

test('Monitoring Health: System Health aggregates component statuses', async () => {
  const systemHealth = await getSystemHealthStatus(undefined, {
    fetchFn: async () => new Response('ok', { status: 200 }),
  });

  assert.ok(systemHealth.components.length >= 7);
  assert.ok(systemHealth.components.some((c) => c.name === 'CRM'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Javis Brain'));
  assert.ok(systemHealth.components.some((c) => c.name === 'ZCAJS Worker'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Messenger Transport'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Supabase Scheduler (Zalo)'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Supabase Scheduler (Messenger)'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Supabase scheduler'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Voice/Stringee'));
});

test('Monitoring Health: Rejects legacy array without metadata (returns DEGRADED, never HEALTHY)', async () => {
  const mockLegacyArray: any = {
    rpc: () =>
      Promise.resolve({
        data: [
          {
            request_id: 201,
            created: new Date().toISOString(),
            status_code: 200,
            has_error: false,
            timed_out: false,
          },
        ],
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockLegacyArray, 'MESSENGER');
  assert.equal(res.status, 'DEGRADED', 'Legacy array missing job metadata must NEVER return HEALTHY');
  assert.ok(res.details?.includes('mảng kết quả cũ'));
});

test('Monitoring Health: Rejects null job_exists / job_active metadata (returns DEGRADED, never HEALTHY)', async () => {
  const mockNullJobExists: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'ZALO',
          job_exists: null,
          job_active: null,
          job_schedule: '* * * * *',
          extension_available: true,
          view_available: true,
          runs: [
            {
              request_id: 202,
              created: new Date().toISOString(),
              status_code: 200,
              has_error: false,
              timed_out: false,
            },
          ],
        },
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockNullJobExists, 'ZALO');
  assert.equal(res.status, 'DEGRADED', 'Null job_exists must remain DEGRADED, never HEALTHY');
  assert.ok(res.details?.includes('Metadata cron job không xác định'));
});

test('Monitoring Health: Rejects stale run older than 4 minutes (returns DEGRADED)', async () => {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const mockStaleRun: any = {
    rpc: () =>
      Promise.resolve({
        data: {
          channel: 'MESSENGER',
          job_exists: true,
          job_active: true,
          job_schedule: '* * * * *',
          extension_available: true,
          view_available: true,
          runs: [
            {
              request_id: 203,
              created: fiveMinutesAgo,
              status_code: 200,
              has_error: false,
              timed_out: false,
            },
          ],
        },
        error: null,
      }),
  };

  const res = await checkSchedulerHealth(mockStaleRun, 'MESSENGER');
  assert.equal(res.status, 'DEGRADED', 'Run older than 4 minutes must be DEGRADED (stale)');
  assert.ok(res.details?.includes('phút'));
});

test('Monitoring Health: interpretSchedulerHealth rejects null/undefined has_error or timed_out flags (returns DEGRADED/UNKNOWN, not failed dispatch)', () => {
  const now = new Date('2026-10-23T05:00:00.000Z');
  const mockRpcData = {
    channel: 'MESSENGER',
    job_name: 'ai_brain_live_messenger_worker',
    job_exists: true,
    job_active: true,
    job_schedule: '* * * * *',
    extension_available: true,
    view_available: true,
    runs: [
      {
        request_id: 301,
        created: '2026-10-23T04:59:30.000Z',
        status_code: 200,
        has_error: null, // Unknown flag!
        timed_out: null, // Unknown flag!
      },
    ],
  };

  const res = interpretSchedulerHealth(mockRpcData, 'MESSENGER', now);
  assert.equal(res.status, 'DEGRADED', 'Null flags must return DEGRADED, not HEALTHY');
  assert.equal(res.availability, 'UNKNOWN', 'Null flags must return availability UNKNOWN');
  assert.equal(res.consecutiveFailures, 0, 'Unknown flags must NOT fabricate failed dispatch count');
  assert.equal(res.totalFailures, 0, 'Unknown flags must NOT fabricate total failures');
  assert.ok(res.details.includes('chưa được xác thực rõ ràng') || res.details.includes('has_error'));
});

test('Monitoring Health: interpretSchedulerHealth rejects channel mismatch (ZALO metadata interpreted for MESSENGER returns DEGRADED/UNKNOWN)', () => {
  const now = new Date('2026-10-23T05:00:00.000Z');
  const mockZaloData = {
    channel: 'ZALO',
    job_name: 'ai_brain_live_zalo_worker',
    job_exists: true,
    job_active: true,
    job_schedule: '* * * * *',
    extension_available: true,
    view_available: true,
    runs: [
      {
        request_id: 302,
        created: '2026-10-23T04:59:30.000Z',
        status_code: 200,
        has_error: false,
        timed_out: false,
      },
    ],
  };

  // Passing a ZALO object when requested channel is MESSENGER
  const res = interpretSchedulerHealth(mockZaloData, 'MESSENGER', now);
  assert.equal(res.status, 'DEGRADED', 'Channel mismatch must return DEGRADED, not HEALTHY');
  assert.equal(res.availability, 'UNKNOWN', 'Channel mismatch must return availability UNKNOWN');
  assert.equal(res.channel, 'MESSENGER');
  assert.ok(res.details.includes('không khớp') || res.details.includes('ZALO'));
});

test('Monitoring Health: interpretSchedulerHealth declares HEALTHY on positively verified false error/timeout flags and matching channel', () => {
  const now = new Date('2026-10-23T05:00:00.000Z');
  const mockHealthyData = {
    channel: 'MESSENGER',
    job_name: 'ai_brain_live_messenger_worker',
    job_exists: true,
    job_active: true,
    job_schedule: '* * * * *',
    extension_available: true,
    view_available: true,
    runs: [
      {
        request_id: 303,
        created: '2026-10-23T04:59:30.000Z',
        status_code: 200,
        has_error: false,
        timed_out: false,
      },
    ],
  };

  const res = interpretSchedulerHealth(mockHealthyData, 'MESSENGER', now);
  assert.equal(res.status, 'HEALTHY', 'Positively verified flags must return HEALTHY');
  assert.equal(res.availability, 'AVAILABLE');
  assert.equal(res.consecutiveFailures, 0);
  assert.equal(res.totalFailures, 0);
});
