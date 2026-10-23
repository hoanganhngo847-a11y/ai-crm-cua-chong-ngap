import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { NextRequest } from 'next/server';
import {
  handleAiBrainLiveZaloCron,
  GET,
  POST,
  type AiBrainLiveZaloRouteDeps,
} from '../../app/api/cron/ai-brain-live-zalo/handler';

const TEST_SECRET = 'cron-secret-super-secure-token-12345';
const CANARY_SECRET = 'canary-super-secret-do-not-leak-into-logs-or-response';

let originalEnvCronSecret: string | undefined;

beforeEach(() => {
  originalEnvCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (originalEnvCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalEnvCronSecret;
  }
});

function interceptConsole() {
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const entries: string[] = [];

  console.error = (...args: unknown[]) => {
    entries.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    entries.push(args.map(String).join(' '));
  };
  console.log = (...args: unknown[]) => {
    entries.push(args.map(String).join(' '));
  };

  return {
    entries,
    restore() {
      console.error = originalError;
      console.warn = originalWarn;
      console.log = originalLog;
    },
  };
}

test('returns 503 when CRON_SECRET is unset or empty and does not call worker', async () => {
  let workerCalls = 0;
  const fakeDeps: AiBrainLiveZaloRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  const emptyCases = [undefined, '', '   '];
  for (const emptyVal of emptyCases) {
    const consoleTrap = interceptConsole();
    if (emptyVal === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = emptyVal;
    }

    const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });

    const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Service unavailable' });
    assert.equal(workerCalls, 0);

    const joinedLogs = consoleTrap.entries.join('\n');
    assert.ok(joinedLogs.includes('[cron/ai-brain-live-zalo] CRON_SECRET is not configured'));
    consoleTrap.restore();
  }
});

test('returns 401 when Authorization header is missing, malformed, or wrong and does not call worker', async () => {
  let workerCalls = 0;
  const fakeDeps: AiBrainLiveZaloRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  const badHeaders: Array<Record<string, string>> = [
    {},
    { authorization: '' },
    { authorization: 'Basic dXNlcjpwYXNz' },
    { authorization: 'Bearer' },
    { authorization: `Bearer ${TEST_SECRET}-wrong` },
    { authorization: `Bearer wrong-token` },
    { authorization: `Token ${TEST_SECRET}` },
  ];

  for (const headers of badHeaders) {
    const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo', {
      method: 'POST',
      headers,
    });
    const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Unauthorized' });
    assert.equal(workerCalls, 0);
  }
});

test('executes worker with default limit of 5 on valid authorization', async () => {
  let receivedLimit: number | undefined;
  const fakeDeps: AiBrainLiveZaloRouteDeps = {
    processDue: async (limit) => {
      receivedLimit = limit;
      return { claimed: 3, sent: 2, skipped: 1, failed: 0 };
    },
  };

  const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_SECRET}` },
  });

  const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, claimed: 3, sent: 2, skipped: 1, failed: 0 });
  assert.equal(receivedLimit, 5);
});

test('accepts case-insensitive Bearer prefix', async () => {
  let workerCalls = 0;
  const fakeDeps: AiBrainLiveZaloRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  for (const prefix of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
    const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo', {
      method: 'POST',
      headers: { authorization: `${prefix} ${TEST_SECRET}` },
    });
    const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
    assert.equal(res.status, 200);
  }
  assert.equal(workerCalls, 4);
});

test('accepts valid integer limits from 1 to 10', async () => {
  const limits = [1, 2, 5, 9, 10];
  for (const lim of limits) {
    let captured: number | undefined;
    const fakeDeps: AiBrainLiveZaloRouteDeps = {
      processDue: async (limit) => {
        captured = limit;
        return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
      },
    };

    const req = new NextRequest(`http://localhost:3000/api/cron/ai-brain-live-zalo?limit=${lim}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });

    const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
    assert.equal(res.status, 200);
    assert.equal(captured, lim);
  }
});

test('rejects invalid limit values with 400 Bad Request and worker is NOT called', async () => {
  let workerCalls = 0;
  const fakeDeps: AiBrainLiveZaloRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  const invalidLimits = ['0', '-1', '11', '100', '3.5', 'abc', '1a', '', ' '];
  for (const val of invalidLimits) {
    const req = new NextRequest(`http://localhost:3000/api/cron/ai-brain-live-zalo?limit=${encodeURIComponent(val)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });

    const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Invalid limit parameter' });
    assert.equal(workerCalls, 0);
  }
});

test('rejects duplicate query parameters with 400 Bad Request and worker is NOT called', async () => {
  let workerCalls = 0;
  const fakeDeps: AiBrainLiveZaloRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo?limit=5&limit=5', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_SECRET}` },
  });

  const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: 'Invalid query parameter' });
  assert.equal(workerCalls, 0);
});

test('rejects unknown query parameters with 400 Bad Request and worker is NOT called', async () => {
  let workerCalls = 0;
  const fakeDeps: AiBrainLiveZaloRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo?limit=5&foo=bar', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_SECRET}` },
  });

  const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: 'Invalid query parameter' });
  assert.equal(workerCalls, 0);
});

test('suppresses raw exception canary and returns 500 with generic safe log', async () => {
  const consoleTrap = interceptConsole();
  const fakeDeps: AiBrainLiveZaloRouteDeps = {
    processDue: async () => {
      throw new Error(`CRITICAL_FAILURE_${CANARY_SECRET}`);
    },
  };

  const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_SECRET}` },
  });

  const res = await handleAiBrainLiveZaloCron(req, fakeDeps);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, { error: 'Worker error' });

  const joinedLogs = consoleTrap.entries.join('\n');
  assert.ok(!joinedLogs.includes(CANARY_SECRET));
  assert.ok(joinedLogs.includes('[cron/ai-brain-live-zalo] worker execution failed'));
  consoleTrap.restore();
});

test('GET wrapper enforces authentication without calling worker', async () => {
  const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo', {
    method: 'GET',
    headers: { authorization: 'Bearer wrong-token' },
  });

  const res = await GET(req);
  assert.equal(res.status, 401);
});

test('POST wrapper enforces authentication without calling worker', async () => {
  const req = new NextRequest('http://localhost:3000/api/cron/ai-brain-live-zalo', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token' },
  });

  const res = await POST(req);
  assert.equal(res.status, 401);
});
