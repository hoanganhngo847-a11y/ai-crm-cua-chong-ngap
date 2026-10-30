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

test('requires an explicit application acknowledgement before removing a message', async () => {
  const { scheduled, delivery } = harness([httpResponse(200, null)]);
  assert.equal(await delivery.deliver(payload), false);
  assert.equal(delivery.pendingCount(), 1);
  assert.equal(scheduled.length, 1);
});

test('retains every unacknowledged message when the queue exceeds its warning threshold', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-overflow-'));
  const queueFile = path.join(dir, 'queue.jsonl');
  try {
    const { delivery } = harness(Array.from({ length: 3 }, () => httpResponse(503, {})), { queueFile, queueMaxEntries: 1 });
    for (let index = 0; index < 3; index++) await delivery.deliver({ ...payload, messageId: `m-${index}` });
    await delivery.flush();
    assert.equal(delivery.pendingCount(), 3);
    assert.equal((await fs.readFile(queueFile, 'utf8')).trim().split('\n').length, 3);
    delivery.stop();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('persists the original event before group enrichment and retries a failed lookup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-enrich-'));
  const queueFile = path.join(dir, 'queue.jsonl');
  try {
    let attempts = 0;
    const { delivery, scheduled, calls } = harness([httpResponse(200, { success: true })], {
      queueFile,
      preparePayload: async (message) => {
        assert.match(await fs.readFile(queueFile, 'utf8'), /m-1/);
        if (attempts++ === 0) throw new Error('lookup failed');
        return { ...message, groupName: 'Nhóm A' };
      },
    });
    assert.equal(await delivery.deliver(payload), false);
    assert.equal(calls.length, 0);
    scheduled.shift().fn();
    for (let i = 0; i < 50 && delivery.pendingCount(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(delivery.pendingCount(), 0);
    assert.equal(JSON.parse(calls[0].init.body).groupName, 'Nhóm A');
    await delivery.flush();
    delivery.stop();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('keeps a message pending and reports an unwritable queue', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-disk-failure-'));
  try {
    const { delivery, calls, scheduled } = harness([], { queueFile: dir });
    assert.equal(await delivery.deliver(payload), false);
    assert.equal(calls.length, 0);
    assert.equal(delivery.pendingCount(), 1);
    assert.ok(delivery.persistenceError());
    assert.equal(scheduled.length, 1);
    delivery.stop();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
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

test('preserves malformed queue bytes in a quarantine file before replay rewrites the queue', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-corrupt-'));
  const queueFile = path.join(dir, 'queue.jsonl');
  const original = JSON.stringify(payload) + '\n{"partial":';
  try {
    await fs.writeFile(queueFile, original, { mode: 0o600 });
    const { delivery } = harness([httpResponse(200, { success: true })], { queueFile });
    await delivery.resume();
    for (let i = 0; i < 50 && delivery.pendingCount(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.flush();
    const quarantine = (await fs.readdir(dir)).find((name) => name.includes('.quarantine-'));
    assert.ok(quarantine);
    assert.equal(await fs.readFile(path.join(dir, quarantine), 'utf8'), original);
    assert.equal(delivery.pendingCount(), 0);
    delivery.stop();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
