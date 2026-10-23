import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { NextRequest } from 'next/server';
import {
  handleAiBrainLiveMessengerCron,
  GET,
  POST,
  type AiBrainLiveMessengerRouteDeps,
} from '../../app/api/cron/ai-brain-live-messenger/handler';

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

function createRequest(url = 'http://localhost/api/cron/ai-brain-live-messenger', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(url), {
    headers: new Headers(headers),
  });
}

test('Messenger Cron: returns 503 when CRON_SECRET is unset or empty', async () => {
  delete process.env.CRON_SECRET;
  let workerCalls = 0;
  const deps: AiBrainLiveMessengerRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  const req = createRequest('http://localhost/api/cron/ai-brain-live-messenger', {
    Authorization: `Bearer ${TEST_SECRET}`,
  });
  const res = await handleAiBrainLiveMessengerCron(req, deps);
  assert.equal(res.status, 503);
  assert.equal(workerCalls, 0);
});

test('Messenger Cron: returns 401 on invalid or missing auth header', async () => {
  let workerCalls = 0;
  const deps: AiBrainLiveMessengerRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  const reqMissing = createRequest();
  const resMissing = await handleAiBrainLiveMessengerCron(reqMissing, deps);
  assert.equal(resMissing.status, 401);

  const reqWrong = createRequest('http://localhost/api/cron/ai-brain-live-messenger', {
    Authorization: 'Bearer wrong-secret',
  });
  const resWrong = await handleAiBrainLiveMessengerCron(reqWrong, deps);
  assert.equal(resWrong.status, 401);
  assert.equal(workerCalls, 0);
});

test('Messenger Cron: executes worker with default limit of 5 on valid auth', async () => {
  let capturedLimit: number | undefined;
  const deps: AiBrainLiveMessengerRouteDeps = {
    processDue: async (limit) => {
      capturedLimit = limit;
      return { claimed: 2, sent: 2, skipped: 0, failed: 0 };
    },
  };

  const req = createRequest('http://localhost/api/cron/ai-brain-live-messenger', {
    Authorization: `Bearer ${TEST_SECRET}`,
  });
  const res = await handleAiBrainLiveMessengerCron(req, deps);
  assert.equal(res.status, 200);
  assert.equal(capturedLimit, 5);

  const body = await res.json();
  assert.deepEqual(body, { ok: true, claimed: 2, sent: 2, skipped: 0, failed: 0 });
});

test('Messenger Cron: accepts custom limit between 1 and 10', async () => {
  let capturedLimit: number | undefined;
  const deps: AiBrainLiveMessengerRouteDeps = {
    processDue: async (limit) => {
      capturedLimit = limit;
      return { claimed: 1, sent: 1, skipped: 0, failed: 0 };
    },
  };

  const req = createRequest('http://localhost/api/cron/ai-brain-live-messenger?limit=8', {
    Authorization: `Bearer ${TEST_SECRET}`,
  });
  const res = await handleAiBrainLiveMessengerCron(req, deps);
  assert.equal(res.status, 200);
  assert.equal(capturedLimit, 8);
});

test('Messenger Cron: rejects invalid limit parameter with 400', async () => {
  let workerCalls = 0;
  const deps: AiBrainLiveMessengerRouteDeps = {
    processDue: async () => {
      workerCalls++;
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    },
  };

  const reqZero = createRequest('http://localhost/api/cron/ai-brain-live-messenger?limit=0', {
    Authorization: `Bearer ${TEST_SECRET}`,
  });
  const resZero = await handleAiBrainLiveMessengerCron(reqZero, deps);
  assert.equal(resZero.status, 400);

  const reqEleven = createRequest('http://localhost/api/cron/ai-brain-live-messenger?limit=11', {
    Authorization: `Bearer ${TEST_SECRET}`,
  });
  const resEleven = await handleAiBrainLiveMessengerCron(reqEleven, deps);
  assert.equal(resEleven.status, 400);
  assert.equal(workerCalls, 0);
});

test('Messenger Cron: GET and POST handlers enforce authentication', async () => {
  const reqUnauth = createRequest();
  const getRes = await GET(reqUnauth);
  assert.equal(getRes.status, 401);

  const postRes = await POST(reqUnauth);
  assert.equal(postRes.status, 401);
});
