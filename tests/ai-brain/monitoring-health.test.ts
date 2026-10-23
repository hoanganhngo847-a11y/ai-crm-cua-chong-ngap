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

    const fakeFetch = async (url: any, init: any) => {
      requestedUrl = String(url);
      requestHeaders = init.headers;
      return new Response(JSON.stringify({ ok: true, service: 'javis-brain', version: 'v1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const res = await checkJavisBrainHealth({ fetchFn: fakeFetch as any });
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
    const res = await checkJavisBrainHealth({ fetchFn: fakeFetch as any });
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

test('Monitoring Health: Supabase scheduler detects recent healthy run', async () => {
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () =>
            Promise.resolve({
              data: [
                {
                  created: new Date().toISOString(),
                  status_code: 200,
                  has_error: false,
                  timed_out: false,
                },
              ],
              error: null,
            }),
        }),
      }),
    }),
  };

  const res = await checkSchedulerHealth(mockSupabase);
  assert.equal(res.status, 'HEALTHY');
  assert.ok(res.details?.includes('HTTP 200'));
});

test('Monitoring Health: Supabase scheduler detects recent error run', async () => {
  const mockSupabase: any = {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () =>
            Promise.resolve({
              data: [
                {
                  created: new Date().toISOString(),
                  status_code: 504,
                  has_error: true,
                  timed_out: true,
                },
              ],
              error: null,
            }),
        }),
      }),
    }),
  };

  const res = await checkSchedulerHealth(mockSupabase);
  assert.equal(res.status, 'UNHEALTHY');
  assert.ok(res.details?.includes('HTTP 504'));
});

test('Monitoring Health: System Health aggregates component statuses', async () => {
  const systemHealth = await getSystemHealthStatus(undefined, {
    fetchFn: async () => new Response('ok', { status: 200 }),
  });

  assert.equal(systemHealth.components.length, 7);
  assert.ok(systemHealth.components.some((c) => c.name === 'CRM'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Javis Brain'));
  assert.ok(systemHealth.components.some((c) => c.name === 'ZCAJS Worker'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Messenger Transport'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Supabase scheduler'));
  assert.ok(systemHealth.components.some((c) => c.name === 'Voice/Stringee'));
});
