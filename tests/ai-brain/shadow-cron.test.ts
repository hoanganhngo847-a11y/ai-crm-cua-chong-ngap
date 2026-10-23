import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { NextRequest } from 'next/server';
import {
  handleAiBrainShadowCron,
  GET,
  POST,
  type AiBrainShadowRouteDeps,
} from '../../app/api/cron/ai-brain-shadow/handler';

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
  const fakeDeps: AiBrainShadowRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, completed: 0, skipped: 0, failed: 0 };
    },
  };

  const consoleSpy = interceptConsole();
  try {
    // 1. Unset (undefined)
    delete process.env.CRON_SECRET;
    const req1 = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const res1 = await handleAiBrainShadowCron(req1, fakeDeps);
    assert.equal(res1.status, 503);
    const body1 = await res1.json();
    assert.deepEqual(body1, { error: 'Service unavailable' });

    // 2. Empty string
    process.env.CRON_SECRET = '';
    const req2 = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const res2 = await handleAiBrainShadowCron(req2, fakeDeps);
    assert.equal(res2.status, 503);

    // 3. Whitespace string
    process.env.CRON_SECRET = '   ';
    const req3 = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const res3 = await handleAiBrainShadowCron(req3, fakeDeps);
    assert.equal(res3.status, 503);

    assert.equal(workerCalls, 0, 'Worker should not be invoked when CRON_SECRET is unconfigured');
    assert.ok(
      consoleSpy.entries.some((entry) => entry.includes('[cron/ai-brain-shadow] CRON_SECRET is not configured')),
    );
  } finally {
    consoleSpy.restore();
  }
});

test('returns 401 when Authorization header is missing, malformed, or wrong and does not call worker', async () => {
  let workerCalls = 0;
  const fakeDeps: AiBrainShadowRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, completed: 0, skipped: 0, failed: 0 };
    },
  };

  const invalidHeaders: Array<Record<string, string>> = [
    {}, // missing authorization
    { authorization: '' }, // empty string
    { authorization: '   ' }, // whitespace only
    { authorization: 'Basic dXNlcjpwYXNz' }, // Basic auth scheme
    { authorization: 'Bearer' }, // Missing token entirely
    { authorization: 'Bearer ' }, // Whitespace token
    { authorization: 'Token something' }, // Non-bearer scheme
    { authorization: `Bearer ${TEST_SECRET} extra` }, // Trailing whitespace / multiple tokens
    { authorization: 'Bearer wrong-secret' }, // Wrong token
    { authorization: `Bearer ${TEST_SECRET.slice(0, -1)}` }, // Shorter token (length mismatch)
    { authorization: `Bearer ${TEST_SECRET}x` }, // Longer token (length mismatch)
    { authorization: `Bearer ${TEST_SECRET.replace(/1/, '2')}` }, // Same length, different character
  ];

  for (const headers of invalidHeaders) {
    const req = new NextRequest('http://localhost/api/cron/ai-brain-shadow', { headers });
    const res = await handleAiBrainShadowCron(req, fakeDeps);
    assert.equal(
      res.status,
      401,
      `Expected 401 for header ${JSON.stringify(headers)}, got ${res.status}`,
    );
    const body = await res.json();
    assert.deepEqual(body, { error: 'Unauthorized' });
  }

  assert.equal(workerCalls, 0, 'Worker must never be called on unauthorized requests');
});

test('executes worker with default limit of 5 on valid authorization', async () => {
  let passedLimit: number | undefined;
  const fakeDeps: AiBrainShadowRouteDeps = {
    processDue: async (limit: number) => {
      passedLimit = limit;
      return { claimed: 3, completed: 2, skipped: 1, failed: 0 };
    },
  };

  const req = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
    headers: { authorization: `Bearer ${TEST_SECRET}` },
  });

  const res = await handleAiBrainShadowCron(req, fakeDeps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    ok: true,
    claimed: 3,
    completed: 2,
    skipped: 1,
    failed: 0,
  });
  assert.equal(passedLimit, 5, 'Default limit must be 5');
});

test('accepts case-insensitive Bearer prefix', async () => {
  let called = false;
  const fakeDeps: AiBrainShadowRouteDeps = {
    processDue: async () => {
      called = true;
      return { claimed: 0, completed: 0, skipped: 0, failed: 0 };
    },
  };

  const req = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
    headers: { authorization: `bearer ${TEST_SECRET}` },
  });

  const res = await handleAiBrainShadowCron(req, fakeDeps);
  assert.equal(res.status, 200);
  assert.equal(called, true);
});

test('accepts valid integer limits from 1 to 10', async () => {
  for (let expected = 1; expected <= 10; expected++) {
    let capturedLimit: number | undefined;
    const fakeDeps: AiBrainShadowRouteDeps = {
      processDue: async (limit: number) => {
        capturedLimit = limit;
        return { claimed: 1, completed: 1, skipped: 0, failed: 0 };
      },
    };

    const req = new NextRequest(`http://localhost/api/cron/ai-brain-shadow?limit=${expected}`, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });

    const res = await handleAiBrainShadowCron(req, fakeDeps);
    assert.equal(res.status, 200, `limit=${expected} must be accepted with 200`);
    assert.equal(capturedLimit, expected, `Worker must receive parsed integer ${expected}`);
  }
});

test('rejects invalid limit values with 400 Bad Request and worker is NOT called', async () => {
  const invalidLimits = [
    '0',
    '11',
    '-1',
    '1.5',
    '5.0',
    'abc',
    '10a',
    'a10',
    '',
    '05', // leading zero
    '01', // leading zero
    '00',
    '100',
    ' 5',
    '5 ',
  ];

  for (const rawLimit of invalidLimits) {
    let workerCalls = 0;
    const fakeDeps: AiBrainShadowRouteDeps = {
      processDue: async () => {
        workerCalls++;
        return { claimed: 0, completed: 0, skipped: 0, failed: 0 };
      },
    };

    const req = new NextRequest(`http://localhost/api/cron/ai-brain-shadow?limit=${encodeURIComponent(rawLimit)}`, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });

    const res = await handleAiBrainShadowCron(req, fakeDeps);
    assert.equal(res.status, 400, `limit=${rawLimit} should return 400`);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Invalid limit parameter' });
    assert.equal(workerCalls, 0, `Worker must NOT be called for limit=${rawLimit}`);
  }
});

test('rejects duplicate query parameters with 400 Bad Request and worker is NOT called', async () => {
  const duplicateUrls = [
    'http://localhost/api/cron/ai-brain-shadow?limit=5&limit=5',
    'http://localhost/api/cron/ai-brain-shadow?limit=1&limit=2',
    'http://localhost/api/cron/ai-brain-shadow?limit=5&limit=10',
  ];

  for (const url of duplicateUrls) {
    let workerCalls = 0;
    const fakeDeps: AiBrainShadowRouteDeps = {
      processDue: async () => {
        workerCalls++;
        return { claimed: 0, completed: 0, skipped: 0, failed: 0 };
      },
    };

    const req = new NextRequest(url, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });

    const res = await handleAiBrainShadowCron(req, fakeDeps);
    assert.equal(res.status, 400, `URL ${url} should return 400`);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Invalid query parameter' });
    assert.equal(workerCalls, 0, `Worker must NOT be called for duplicate query params`);
  }
});

test('rejects unknown query parameters with 400 Bad Request and worker is NOT called', async () => {
  const unknownUrls = [
    'http://localhost/api/cron/ai-brain-shadow?foo=bar',
    'http://localhost/api/cron/ai-brain-shadow?limit=5&unknown=value',
    'http://localhost/api/cron/ai-brain-shadow?target=claim-id',
    'http://localhost/api/cron/ai-brain-shadow?company_id=11111111-1111-4111-8111-111111111111',
    'http://localhost/api/cron/ai-brain-shadow?foo=1&foo=2',
  ];

  for (const url of unknownUrls) {
    let workerCalls = 0;
    const fakeDeps: AiBrainShadowRouteDeps = {
      processDue: async () => {
        workerCalls++;
        return { claimed: 0, completed: 0, skipped: 0, failed: 0 };
      },
    };

    const req = new NextRequest(url, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });

    const res = await handleAiBrainShadowCron(req, fakeDeps);
    assert.equal(res.status, 400, `URL ${url} should return 400`);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Invalid query parameter' });
    assert.equal(workerCalls, 0, `Worker must NOT be called for unknown query params`);
  }
});

test('suppresses raw exception canary and returns 500 with generic safe log', async () => {
  const fakeDeps: AiBrainShadowRouteDeps = {
    processDue: async () => {
      throw new Error(`CRITICAL_DATABASE_CRASH_CANARY:${CANARY_SECRET}`);
    },
  };

  const consoleSpy = interceptConsole();
  try {
    const req = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });

    const res = await handleAiBrainShadowCron(req, fakeDeps);
    assert.equal(res.status, 500);

    const bodyText = await res.text();
    assert.ok(
      !bodyText.includes(CANARY_SECRET),
      'Response body must NOT contain the canary exception string',
    );
    const bodyJson = JSON.parse(bodyText);
    assert.deepEqual(bodyJson, { error: 'Worker error' });

    // Assert that the canary is absent from all console outputs
    for (const entry of consoleSpy.entries) {
      assert.ok(
        !entry.includes(CANARY_SECRET),
        `Console log must NOT contain raw exception canary: "${entry}"`,
      );
    }

    // Assert that only generic safe message was logged
    assert.ok(
      consoleSpy.entries.some((entry) => entry.includes('[cron/ai-brain-shadow] worker execution failed')),
      'Safe generic log must be recorded',
    );
  } finally {
    consoleSpy.restore();
  }
});

test('GET wrapper enforces authentication without calling worker', async () => {
  // 1. Missing auth -> 401
  const reqMissing = new NextRequest('http://localhost/api/cron/ai-brain-shadow');
  const resMissing = await GET(reqMissing);
  assert.equal(resMissing.status, 401);

  // 2. Wrong auth -> 401
  const reqWrong = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
    headers: { authorization: 'Bearer wrong-token' },
  });
  const resWrong = await GET(reqWrong);
  assert.equal(resWrong.status, 401);

  // 3. Unset CRON_SECRET -> 503
  const consoleSpy = interceptConsole();
  try {
    delete process.env.CRON_SECRET;
    const reqNoSecret = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resNoSecret = await GET(reqNoSecret);
    assert.equal(resNoSecret.status, 503);
  } finally {
    consoleSpy.restore();
  }
});

test('POST wrapper enforces authentication without calling worker', async () => {
  // 1. Missing auth -> 401
  const reqMissing = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
    method: 'POST',
  });
  const resMissing = await POST(reqMissing);
  assert.equal(resMissing.status, 401);

  // 2. Wrong auth -> 401
  const reqWrong = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token' },
  });
  const resWrong = await POST(reqWrong);
  assert.equal(resWrong.status, 401);

  // 3. Unset CRON_SECRET -> 503
  const consoleSpy = interceptConsole();
  try {
    delete process.env.CRON_SECRET;
    const reqNoSecret = new NextRequest('http://localhost/api/cron/ai-brain-shadow', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    const resNoSecret = await POST(reqNoSecret);
    assert.equal(resNoSecret.status, 503);
  } finally {
    consoleSpy.restore();
  }
});

test('GET and POST do not export dependency injection to external HTTP callers', () => {
  // Standard Next.js route handler function arity: function(request: NextRequest)
  assert.equal(GET.length, 1, 'GET handler should accept only request argument');
  assert.equal(POST.length, 1, 'POST handler should accept only request argument');
});
