import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInboundDelivery } from '../src/inbound-delivery.mjs';

function httpResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function harness(responses, overrides = {}) {
  const calls = [];
  const scheduled = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  };
  const delivery = createInboundDelivery({
    crmBaseUrl: 'https://crm.example.test/',
    workerSecret: 'worker-secret',
    fetchImpl,
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutImpl: () => {},
    logger: { warn() {}, log() {}, error() {} },
    baseDelayMs: 1_000,
    maxDelayMs: 5_000,
    queueFile: null,
    ...overrides,
  });
  return { calls, scheduled, delivery };
}

const payload = { messageId: 'm-1', externalUserId: '900001', content: 'xin chào' };

test('retries a transient CRM failure and delivers the same message later', async () => {
  const { calls, scheduled, delivery } = harness([
    httpResponse(503, { success: false }),
    httpResponse(200, { success: true }),
  ]);

  assert.equal(await delivery.deliver(payload), false);
  assert.equal(calls.length, 1);
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].ms >= 1_000);
  assert.equal(calls[0].url, 'https://crm.example.test/api/inbox/zalo-zcajs/inbound');
  assert.equal(calls[0].init.headers.authorization, 'Bearer worker-secret');

  scheduled.shift().fn();
  await flushMicrotasks();

  assert.equal(calls.length, 2);
  assert.equal(delivery.pendingCount(), 0);
});

test('does not stack parallel retries for the same Zalo message', async () => {
  const { calls, scheduled, delivery } = harness([httpResponse(503, { success: false })]);

  assert.equal(await delivery.deliver(payload), false);
  assert.equal(await delivery.deliver(payload), false);

  assert.equal(calls.length, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(delivery.pendingCount(), 1);
});

test('keeps retrying payloads rejected with a 4xx instead of losing the message', async () => {
  const { scheduled, delivery } = harness([
    httpResponse(400, { success: false, error: 'MISSING_REQUIRED_FIELDS' }),
  ]);

  assert.equal(await delivery.deliver(payload), false);
  assert.equal(scheduled.length, 1);
});

test('treats an HTTP 200 with success=false as a failed delivery', async () => {
  const { scheduled, delivery } = harness([httpResponse(200, { success: false })]);

  assert.equal(await delivery.deliver(payload), false);
  assert.equal(scheduled.length, 1);
});

test('stop clears pending retries and does not attempt again', async () => {
  const { calls, scheduled, delivery } = harness([httpResponse(503, { success: false })]);

  assert.equal(await delivery.deliver(payload), false);
  const pending = scheduled.shift();
  delivery.stop();
  assert.equal(delivery.pendingCount(), 0);

  pending.fn();
  await flushMicrotasks();
  assert.equal(calls.length, 1);
});

test('writes the payload to disk before the first CRM attempt', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-queue-'));
  const queueFile = path.join(dir, 'inbound-queue.jsonl');
  let persistedWhileSending = '';
  try {
    const delivery = createInboundDelivery({
      crmBaseUrl: 'https://crm.example.test/',
      workerSecret: 'worker-secret',
      queueFile,
      logger: { warn() {}, log() {}, error() {} },
      fetchImpl: async () => {
        persistedWhileSending = await fs.readFile(queueFile, 'utf8');
        return httpResponse(200, { success: true });
      },
    });

    assert.equal(await delivery.deliver(payload), true);
    assert.match(persistedWhileSending, /"messageId":"m-1"/);
    await delivery.flush();
    assert.equal((await fs.readFile(queueFile, 'utf8')).trim(), '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('persists an undeliverable message and replays it after a worker restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-queue-'));
  const queueFile = path.join(dir, 'inbound-queue.jsonl');
  try {
    const first = harness([httpResponse(503, { success: false })], { queueFile });
    assert.equal(await first.delivery.deliver(payload), false);
    await first.delivery.flush();
    assert.equal(first.delivery.pendingCount(), 1);

    const persisted = await fs.readFile(queueFile, 'utf8');
    assert.match(persisted, /"messageId":"m-1"/);
    first.delivery.stop();

    const calls = [];
    const second = harness([], {
      queueFile,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return httpResponse(200, { success: true });
      },
    });
    assert.equal(await second.delivery.resume(), true);
    for (let index = 0; index < 20 && second.delivery.pendingCount() > 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await second.delivery.flush();

    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(String(calls[0].init.body)).messageId, 'm-1');
    assert.equal(second.delivery.pendingCount(), 0);
    assert.equal((await fs.readFile(queueFile, 'utf8')).trim(), '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
