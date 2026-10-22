import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { BrainProposal, BrainTurnRequest, ModelBackend } from '../../services/javis-brain/types';
import { createJavisBrainServer } from '../../services/javis-brain/server';
import { CONTRACT_VERSION } from '../../services/javis-brain/validation';

const TEST_TOKEN = 'test_token_12345678901234567890123456789012';
const VALID_UUID_1 = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_2 = '22222222-2222-4222-8222-222222222222';
const VALID_UUID_3 = '33333333-3333-4333-8333-333333333333';
const VALID_UUID_4 = '44444444-4444-4444-8444-444444444444';
const VALID_UUID_5 = '55555555-5555-4555-8555-555555555555';

function createValidTurnRequest(overrides?: Record<string, unknown>): BrainTurnRequest {
  const base: BrainTurnRequest = {
    version: 'v1',
    turnId: VALID_UUID_1,
    traceId: VALID_UUID_2,
    scope: {
      companyId: VALID_UUID_3,
      customerId: VALID_UUID_4,
      conversationId: VALID_UUID_5,
      channel: 'MESSENGER',
      modality: 'TEXT',
    },
    policy: {
      permissionProfile: 'READ_ONLY',
      conversationState: 'AI_ACTIVE',
      allowDrafts: true,
    },
    input: {
      text: 'Xin chào, tôi muốn hỏi thông tin sản phẩm.',
    },
    latencyProfile: 'STANDARD',
  };
  return Object.assign({}, base, overrides);
}

class MockModelBackend implements ModelBackend {
  public callCount = 0;
  public lastInputText = '';
  public lastLatencyProfile = '';
  public delayMs = 0;
  public shouldThrow: Error | null = null;
  public nextProposal: BrainProposal = {
    decision: 'RESPOND',
    draft: 'Xin chào! Chúng tôi có thể hỗ trợ gì cho bạn?',
    confidence: 0.95,
  };

  async generate(
    inputText: string,
    options: { signal: AbortSignal; latencyProfile: string }
  ): Promise<BrainProposal> {
    this.callCount++;
    this.lastInputText = inputText;
    this.lastLatencyProfile = options.latencyProfile;

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('ABORTED'));
        });
      });
    }

    if (this.shouldThrow) {
      throw this.shouldThrow;
    }

    return this.nextProposal;
  }
}

interface TestServerHarness<T extends ModelBackend = MockModelBackend> {
  readonly server: http.Server;
  readonly baseUrl: string;
  readonly backend: T;
  readonly auditLogs: unknown[];
  close(): Promise<void>;
}

async function startTestServer<T extends ModelBackend = MockModelBackend>(options?: {
  maxConcurrency?: number;
  standardDeadlineMs?: number;
  realtimeDeadlineMs?: number;
  bodyTimeoutMs?: number;
  headersTimeoutMs?: number;
  backend?: T;
}): Promise<TestServerHarness<T>> {
  const backend = (options?.backend ?? new MockModelBackend()) as T;
  const auditLogs: unknown[] = [];

  const server = createJavisBrainServer({
    authToken: TEST_TOKEN,
    modelBackend: backend,
    maxConcurrency: options?.maxConcurrency,
    standardDeadlineMs: options?.standardDeadlineMs,
    realtimeDeadlineMs: options?.realtimeDeadlineMs,
    bodyTimeoutMs: options?.bodyTimeoutMs,
    headersTimeoutMs: options?.headersTimeoutMs,
    onAuditLog: (log) => auditLogs.push(log),
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    server,
    baseUrl,
    backend,
    auditLogs,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// -----------------------------------------------------------------------------
// Health Check Endpoint Tests
// -----------------------------------------------------------------------------

test('GET /health: valid bearer token and v1 contract returns 200 with exact health envelope', async () => {
  const harness = await startTestServer();
  try {
    const res = await fetch(`${harness.baseUrl}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const data = await res.json();
    assert.deepEqual(data, {
      ok: true,
      service: 'javis-brain',
      version: 'v1',
    });
    // Ensure no extra fields
    assert.deepEqual(Object.keys(data).sort(), ['ok', 'service', 'version']);
  } finally {
    await harness.close();
  }
});

test('GET /health: rejects missing Authorization header with 401', async () => {
  const harness = await startTestServer();
  try {
    const res = await fetch(`${harness.baseUrl}/health`, {
      method: 'GET',
      headers: {
        'X-AI-Brain-Contract': CONTRACT_VERSION,
      },
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.deepEqual(data, { error: 'UNAUTHORIZED' });
  } finally {
    await harness.close();
  }
});

test('GET /health: rejects invalid or wrong bearer token with 401', async () => {
  const harness = await startTestServer();
  try {
    const wrongToken = 'wrong_token_12345678901234567890123456789012';
    const res = await fetch(`${harness.baseUrl}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${wrongToken}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
      },
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.deepEqual(data, { error: 'UNAUTHORIZED' });
  } finally {
    await harness.close();
  }
});

test('GET /health: rejects missing or invalid X-AI-Brain-Contract header with 400', async () => {
  const harness = await startTestServer();
  try {
    // Missing contract header
    const res1 = await fetch(`${harness.baseUrl}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
    });
    assert.equal(res1.status, 400);

    // Wrong contract header version
    const res2 = await fetch(`${harness.baseUrl}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': 'v2',
      },
    });
    assert.equal(res2.status, 400);
  } finally {
    await harness.close();
  }
});

test('GET /health: rejects non-GET methods with 405 Method Not Allowed', async () => {
  const harness = await startTestServer();
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${harness.baseUrl}/health`, {
        method,
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
        },
      });
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.deepEqual(data, { error: 'METHOD_NOT_ALLOWED' });
    }
  } finally {
    await harness.close();
  }
});

test('HTTP Server: rejects unsupported paths with 404 Not Found', async () => {
  const harness = await startTestServer();
  try {
    for (const path of ['/unknown', '/v1/chat', '/turn', '/api/brain']) {
      const res = await fetch(`${harness.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
        },
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.deepEqual(data, { error: 'NOT_FOUND' });
    }
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Turn Endpoint - Transport & Header Strictness Tests
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn: valid request returns 200 with exact { ok, version, proposal } envelope', async () => {
  const harness = await startTestServer();
  try {
    const request = createValidTurnRequest();
    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.version, 'v1');
    assert.deepEqual(data.proposal, harness.backend.nextProposal);
    assert.deepEqual(Object.keys(data).sort(), ['ok', 'proposal', 'version']);

    // Check audit log
    assert.equal(harness.auditLogs.length, 1);
    const log = harness.auditLogs[0] as Record<string, unknown>;
    assert.equal(log.turnId, request.turnId);
    assert.equal(log.traceId, request.traceId);
    assert.equal(log.status, 200);
    assert.equal(log.decision, 'RESPOND');
    assert.equal(log.provider, 'javis-brain-service');
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: rejects invalid Content-Type with 415 Unsupported Media Type', async () => {
  const harness = await startTestServer();
  try {
    for (const badType of ['text/plain', 'application/xml', 'multipart/form-data']) {
      const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
          'Content-Type': badType,
        },
        body: JSON.stringify(createValidTurnRequest()),
      });
      assert.equal(res.status, 415);
      const data = await res.json();
      assert.deepEqual(data, { error: 'UNSUPPORTED_MEDIA_TYPE' });
    }
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: rejects duplicate sensitive headers with 400 Bad Request', async () => {
  const harness = await startTestServer();
  try {
    // Send raw HTTP request with duplicate Authorization header
    const address = harness.server.address() as { port: number };
    const rawReq =
      `POST /v1/brain/turn HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${address.port}\r\n` +
      `Authorization: Bearer ${TEST_TOKEN}\r\n` +
      `Authorization: Bearer ${TEST_TOKEN}\r\n` +
      `X-AI-Brain-Contract: v1\r\n` +
      `Content-Type: application/json\r\n` +
      `Connection: close\r\n` +
      `Content-Length: 2\r\n\r\n` +
      `{}`;

    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    let responseData = '';
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        socket.write(rawReq);
      });
      socket.on('data', (chunk) => {
        responseData += chunk.toString('utf8');
        if (responseData.includes('400')) {
          socket.destroy();
          resolve();
        }
      });
      socket.on('close', resolve);
      socket.on('error', resolve);
    });

    assert.ok(responseData.includes('400 Bad Request') || responseData.includes('HTTP/1.1 400'));
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: rejects malformed JSON with 400 Bad Request', async () => {
  const harness = await startTestServer();
  try {
    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: '{"invalid": json',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.deepEqual(data, { error: 'BAD_REQUEST' });
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Body Limit & Streaming Tests (32 KiB limit)
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn: rejects Content-Length > 32 KiB immediately with 413 Payload Too Large', async () => {
  const harness = await startTestServer();
  try {
    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: 'x'.repeat(32769),
    });
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.deepEqual(data, { error: 'PAYLOAD_TOO_LARGE' });
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: rejects chunked streaming body > 32 KiB with 413 Payload Too Large', async () => {
  const harness = await startTestServer();
  try {
    const address = harness.server.address() as { port: number };
    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    const chunk1 = 'A'.repeat(20000);
    const chunk2 = 'B'.repeat(20000);

    let responseData = '';
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        socket.write(
          `POST /v1/brain/turn HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${address.port}\r\n` +
            `Authorization: Bearer ${TEST_TOKEN}\r\n` +
            `X-AI-Brain-Contract: v1\r\n` +
            `Content-Type: application/json\r\n` +
            `Connection: close\r\n` +
            `Transfer-Encoding: chunked\r\n\r\n` +
            `${chunk1.length.toString(16)}\r\n${chunk1}\r\n`
        );
        setTimeout(() => {
          socket.write(`${chunk2.length.toString(16)}\r\n${chunk2}\r\n0\r\n\r\n`);
        }, 20);
      });
      socket.on('data', (chunk) => {
        responseData += chunk.toString('utf8');
        if (responseData.includes('413')) {
          socket.destroy();
          resolve();
        }
      });
      socket.on('close', resolve);
      socket.on('error', resolve);
    });

    assert.ok(responseData.includes('413 Payload Too Large') || responseData.includes('413'));
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Request Validation - Exhaustive Field Tests
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn: rejects missing or invalid fields in request', async () => {
  const harness = await startTestServer();
  try {
    const cases: Array<[string, unknown]> = [
      ['missing version', createValidTurnRequest({ version: undefined })],
      ['version not v1', createValidTurnRequest({ version: 'v2' })],
      ['missing turnId', createValidTurnRequest({ turnId: undefined })],
      ['non-uuid turnId', createValidTurnRequest({ turnId: 'not-a-uuid' })],
      ['missing traceId', createValidTurnRequest({ traceId: undefined })],
      ['non-uuid traceId', createValidTurnRequest({ traceId: '123' })],
      ['missing scope', createValidTurnRequest({ scope: undefined })],
      [
        'missing scope.companyId',
        createValidTurnRequest({
          scope: {
            customerId: VALID_UUID_4,
            conversationId: VALID_UUID_5,
            channel: 'MESSENGER',
            modality: 'TEXT',
          },
        }),
      ],
      [
        'invalid scope.channel',
        createValidTurnRequest({
          scope: {
            companyId: VALID_UUID_3,
            customerId: VALID_UUID_4,
            conversationId: VALID_UUID_5,
            channel: 'TELEGRAM',
            modality: 'TEXT',
          },
        }),
      ],
      [
        'invalid scope.modality',
        createValidTurnRequest({
          scope: {
            companyId: VALID_UUID_3,
            customerId: VALID_UUID_4,
            conversationId: VALID_UUID_5,
            channel: 'MESSENGER',
            modality: 'VIDEO',
          },
        }),
      ],
      [
        'non-uuid sessionId',
        createValidTurnRequest({
          scope: {
            companyId: VALID_UUID_3,
            customerId: VALID_UUID_4,
            conversationId: VALID_UUID_5,
            channel: 'MESSENGER',
            modality: 'TEXT',
            sessionId: 'invalid-session-uuid',
          },
        }),
      ],
      [
        'unknown key in scope',
        createValidTurnRequest({
          scope: {
            companyId: VALID_UUID_3,
            customerId: VALID_UUID_4,
            conversationId: VALID_UUID_5,
            channel: 'MESSENGER',
            modality: 'TEXT',
            extraAuthority: true,
          },
        }),
      ],
      ['missing policy', createValidTurnRequest({ policy: undefined })],
      [
        'policy.permissionProfile not READ_ONLY',
        createValidTurnRequest({
          policy: {
            permissionProfile: 'SAFE_WRITE',
            conversationState: 'AI_ACTIVE',
            allowDrafts: true,
          },
        }),
      ],
      [
        'invalid policy.conversationState',
        createValidTurnRequest({
          policy: {
            permissionProfile: 'READ_ONLY',
            conversationState: 'UNKNOWN_STATE',
            allowDrafts: true,
          },
        }),
      ],
      [
        'policy.allowDrafts not boolean',
        createValidTurnRequest({
          policy: {
            permissionProfile: 'READ_ONLY',
            conversationState: 'AI_ACTIVE',
            allowDrafts: 'true',
          },
        }),
      ],
      [
        'unknown key in policy',
        createValidTurnRequest({
          policy: {
            permissionProfile: 'READ_ONLY',
            conversationState: 'AI_ACTIVE',
            allowDrafts: true,
            bypassChecks: true,
          },
        }),
      ],
      ['missing input', createValidTurnRequest({ input: undefined })],
      ['missing input.text', createValidTurnRequest({ input: {} })],
      ['blank input.text', createValidTurnRequest({ input: { text: '   ' } })],
      ['input.text > 4000 chars', createValidTurnRequest({ input: { text: 'x'.repeat(4001) } })],
      ['unknown key in input', createValidTurnRequest({ input: { text: 'hi', extra: 123 } })],
      ['invalid latencyProfile', createValidTurnRequest({ latencyProfile: 'TURBO' })],
      ['extra root key', Object.assign(createValidTurnRequest(), { injectedRootKey: 'root' })],
    ];

    for (const [desc, payload] of cases) {
      const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400, `Expected 400 for case: ${desc}`);
      const data = await res.json();
      assert.deepEqual(data, { error: 'BAD_REQUEST' }, `Error response for case: ${desc}`);
    }
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Policy Short-Circuiting Tests (No model invocation)
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn policy: allowDrafts=false short-circuits to NO_REPLY without calling model', async () => {
  const harness = await startTestServer();
  try {
    const req = createValidTurnRequest({
      policy: {
        permissionProfile: 'READ_ONLY',
        conversationState: 'AI_ACTIVE',
        allowDrafts: false,
      },
    });

    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.proposal.decision, 'NO_REPLY');
    assert.equal(data.proposal.confidence, 1.0);
    assert.equal(harness.backend.callCount, 0, 'Model backend must NOT be invoked');
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn policy: AI_PAUSED short-circuits to NO_REPLY without calling model', async () => {
  const harness = await startTestServer();
  try {
    const req = createValidTurnRequest({
      policy: {
        permissionProfile: 'READ_ONLY',
        conversationState: 'AI_PAUSED',
        allowDrafts: true,
      },
    });

    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.proposal.decision, 'NO_REPLY');
    assert.equal(harness.backend.callCount, 0, 'Model backend must NOT be invoked');
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn policy: HANDOVER_REQUIRED short-circuits to HANDOVER without calling model', async () => {
  const harness = await startTestServer();
  try {
    const req = createValidTurnRequest({
      policy: {
        permissionProfile: 'READ_ONLY',
        conversationState: 'HANDOVER_REQUIRED',
        allowDrafts: true,
      },
    });

    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.proposal.decision, 'HANDOVER');
    assert.equal(data.proposal.handoverReason, 'CONVERSATION_STATE_HANDOVER_REQUIRED');
    assert.equal(harness.backend.callCount, 0, 'Model backend must NOT be invoked');
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn policy: HUMAN_ACTIVE with allowDrafts=true invokes model backend', async () => {
  const harness = await startTestServer();
  try {
    const req = createValidTurnRequest({
      policy: {
        permissionProfile: 'READ_ONLY',
        conversationState: 'HUMAN_ACTIVE',
        allowDrafts: true,
      },
    });

    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.proposal.decision, 'RESPOND');
    assert.equal(harness.backend.callCount, 1, 'Model backend MUST be invoked');
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Concurrency Limiting Tests (Bound concurrent calls, excess => 503)
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn concurrency: rejects excess requests beyond maxConcurrency with 503', async () => {
  const backend = new MockModelBackend();
  backend.delayMs = 200; // Hold slot for 200ms
  const harness = await startTestServer({ maxConcurrency: 2, backend });

  try {
    const makeReq = () =>
      fetch(`${harness.baseUrl}/v1/brain/turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createValidTurnRequest()),
      });

    // Fire 3 requests simultaneously
    const p1 = makeReq();
    const p2 = makeReq();
    // Brief sleep to ensure p1 & p2 acquired slots
    await new Promise((r) => setTimeout(r, 20));
    const p3 = makeReq();

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    const statuses = [res1.status, res2.status, res3.status].sort();
    assert.deepEqual(statuses, [200, 200, 503]);

    const res503 = [res1, res2, res3].find((r) => r.status === 503)!;
    const data503 = await res503.json();
    assert.deepEqual(data503, { error: 'SERVICE_UNAVAILABLE' });
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Deadline & Timeout Tests
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn: aborts and returns 504 when model call exceeds deadline', async () => {
  const backend = new MockModelBackend();
  backend.delayMs = 200;
  // Set tight deadline of 50ms
  const harness = await startTestServer({ standardDeadlineMs: 50, backend });

  try {
    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createValidTurnRequest({ latencyProfile: 'STANDARD' })),
    });

    assert.equal(res.status, 504);
    const data = await res.json();
    assert.deepEqual(data, { error: 'GATEWAY_TIMEOUT' });
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: server handles model exception safely with 500 without leaking stack', async () => {
  const backend = new MockModelBackend();
  backend.shouldThrow = new Error('Secret internal exception with canary: canary_key_12345');
  const harness = await startTestServer({ backend });

  try {
    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createValidTurnRequest()),
    });

    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes('canary_key_12345'), 'Must never leak exception text');
    const data = JSON.parse(text);
    assert.deepEqual(data, { error: 'INTERNAL_SERVER_ERROR' });
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Multilingual UTF-8 Chunking & Boundary Tests
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn: preserves valid multilingual UTF-8 across chunk boundaries', async () => {
  const backend = new MockModelBackend();
  const harness = await startTestServer({ backend });
  try {
    const address = harness.server.address() as { port: number };
    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    const vietnameseEmojiText = 'Xin chào, tôi cần tư vấn mua cửa chống ngập 🇻🇳 🎉 ✨';
    const reqBodyObj = createValidTurnRequest({
      input: { text: vietnameseEmojiText },
    });
    const reqBodyJson = JSON.stringify(reqBodyObj);
    const bodyBuffer = Buffer.from(reqBodyJson, 'utf8');

    const splitIndex = Math.floor(bodyBuffer.length / 2);
    const chunk1 = bodyBuffer.subarray(0, splitIndex);
    const chunk2 = bodyBuffer.subarray(splitIndex);

    let responseData = '';
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          `POST /v1/brain/turn HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${address.port}\r\n` +
            `Authorization: Bearer ${TEST_TOKEN}\r\n` +
            `X-AI-Brain-Contract: v1\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${bodyBuffer.length}\r\n` +
            `Connection: close\r\n\r\n`
        );
        socket.write(chunk1);
        setTimeout(() => {
          socket.write(chunk2);
        }, 10);
      });
      socket.on('data', (c) => {
        responseData += c.toString('utf8');
      });
      socket.on('close', resolve);
      socket.on('error', reject);
    });

    assert.ok(responseData.includes('200 OK'));
    assert.equal(backend.lastInputText, vietnameseEmojiText);
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: preserves unicode when chunk boundary splits in the middle of multibyte codepoint', async () => {
  const backend = new MockModelBackend();
  const harness = await startTestServer({ backend });
  try {
    const address = harness.server.address() as { port: number };
    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    // 'ế' is 3 bytes (0xE1 0xBA 0xBF)
    const testText = 'Chào ếch 🐸';
    const reqBodyJson = JSON.stringify(createValidTurnRequest({ input: { text: testText } }));
    const buf = Buffer.from(reqBodyJson, 'utf8');

    const charIndex = buf.indexOf(Buffer.from('ế', 'utf8'));
    assert.ok(charIndex !== -1);
    const splitPoint = charIndex + 1; // Split right after first byte of 'ế'
    const chunk1 = buf.subarray(0, splitPoint);
    const chunk2 = buf.subarray(splitPoint);

    let responseData = '';
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          `POST /v1/brain/turn HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${address.port}\r\n` +
            `Authorization: Bearer ${TEST_TOKEN}\r\n` +
            `X-AI-Brain-Contract: v1\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${buf.length}\r\n` +
            `Connection: close\r\n\r\n`
        );
        socket.write(chunk1);
        setTimeout(() => {
          socket.write(chunk2);
        }, 15);
      });
      socket.on('data', (c) => {
        responseData += c.toString('utf8');
      });
      socket.on('close', resolve);
      socket.on('error', reject);
    });

    assert.ok(responseData.includes('200 OK'));
    assert.equal(backend.lastInputText, testText);
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: safely rejects malformed UTF-8 bytes with 400 Bad Request', async () => {
  const harness = await startTestServer();
  try {
    const address = harness.server.address() as { port: number };
    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);

    let responseData = '';
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          `POST /v1/brain/turn HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${address.port}\r\n` +
            `Authorization: Bearer ${TEST_TOKEN}\r\n` +
            `X-AI-Brain-Contract: v1\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${invalidUtf8.length}\r\n` +
            `Connection: close\r\n\r\n`
        );
        socket.write(invalidUtf8);
      });
      socket.on('data', (c) => {
        responseData += c.toString('utf8');
      });
      socket.on('close', resolve);
      socket.on('error', reject);
    });

    assert.ok(responseData.includes('400 Bad Request') || responseData.includes('400'));
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Disconnect & Concurrency Capacity Retention Tests
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn: real client disconnect triggers abort signal and settles promptly without late unhandled rejection', async () => {
  let backendAborted = false;
  let backendSignal: AbortSignal | null = null;
  let resolveBackend: () => void;
  const backendPromise = new Promise<BrainProposal>((resolve) => {
    resolveBackend = () =>
      resolve({
        decision: 'RESPOND',
        draft: 'Resolved late',
        confidence: 0.9,
      });
  });

  const backend: ModelBackend = {
    generate(_text, options) {
      backendSignal = options.signal;
      options.signal.addEventListener('abort', () => {
        backendAborted = true;
      });
      return backendPromise;
    },
  };

  const harness = await startTestServer({ backend });
  try {
    const address = harness.server.address() as { port: number };
    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    const reqBody = JSON.stringify(createValidTurnRequest());
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        socket.write(
          `POST /v1/brain/turn HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${address.port}\r\n` +
            `Authorization: Bearer ${TEST_TOKEN}\r\n` +
            `X-AI-Brain-Contract: v1\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(reqBody)}\r\n\r\n` +
            reqBody
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 25);
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(backendAborted, true, 'AbortSignal must be triggered on client disconnect');
    assert.ok(backendSignal && (backendSignal as AbortSignal).aborted);

    // Resolve backend late and ensure zero unhandled rejections
    resolveBackend!();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn concurrency: retained capacity blocks new requests with 503 until backend promise settles', async () => {
  let backendCalls = 0;
  const resolvers: Array<() => void> = [];

  const backend: ModelBackend = {
    generate() {
      backendCalls++;
      return new Promise<BrainProposal>((resolve) => {
        resolvers.push(() => {
          resolve({ decision: 'NO_REPLY', confidence: 1.0 });
        });
      });
    },
  };

  // maxConcurrency = 2, tight deadline 40ms
  const harness = await startTestServer({
    maxConcurrency: 2,
    standardDeadlineMs: 40,
    backend,
  });

  try {
    const sendTurn = () =>
      fetch(`${harness.baseUrl}/v1/brain/turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createValidTurnRequest()),
      });

    // Request 1 and 2 start and time out at deadline
    const [res1, res2] = await Promise.all([sendTurn(), sendTurn()]);
    assert.equal(res1.status, 504);
    assert.equal(res2.status, 504);
    assert.equal(backendCalls, 2);

    // Request 3 arrives after 1 and 2 timed out.
    // BUT backend calls 1 & 2 are still pending.
    // Therefore capacity slot is retained and request 3 MUST receive 503!
    const res3 = await sendTurn();
    assert.equal(res3.status, 503);
    const data3 = await res3.json();
    assert.deepEqual(data3, { error: 'SERVICE_UNAVAILABLE' });
    assert.equal(backendCalls, 2, 'Backend 3 must NOT be called');

    // Settle 1 backend promise to free capacity
    resolvers[0]();
    await new Promise((r) => setTimeout(r, 20));

    // Request 4 arrives: proceeds to backend
    const res4Promise = sendTurn();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(backendCalls, 3);
    resolvers[2]();
    const res4 = await res4Promise;
    assert.equal(res4.status, 200);
  } finally {
    resolvers.forEach((r) => r());
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Output Boundary & Policy Precedence Tests
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn output boundary: validates proposal and rejects malformed backend results with 500 without leaking raw contents', async () => {
  const malformedOutputs = [
    { decision: 'ERROR', confidence: 0.5 },
    { decision: 'RESPOND', draft: 'ok', confidence: 0.9, unknownField: 'leaked_data' },
    { decision: 'RESPOND', draft: 'ok', confidence: 0.9, memoryReferences: ['mem_1'] },
    { decision: 'RESPOND', draft: 'ok', confidence: 1.5 },
    { decision: 'RESPOND', draft: 'ok', confidence: -0.2 },
    { decision: 'RESPOND', confidence: 0.9 }, // missing draft
    { decision: 'RESPOND', draft: null, confidence: 0.9 }, // null draft
    { decision: 'HANDOVER', handoverReason: null, confidence: 0.9 }, // null handoverReason
    { decision: 'NO_REPLY', draft: 'draft_not_allowed', confidence: 1.0 },
    { decision: 'NO_REPLY', confidence: 'not_a_number' },
  ];

  for (const malformed of malformedOutputs) {
    const backend: ModelBackend = {
      async generate() {
        return malformed as never;
      },
    };

    const harness = await startTestServer({ backend });
    try {
      const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createValidTurnRequest()),
      });

      assert.equal(res.status, 500);
      const text = await res.text();
      assert.ok(!text.includes('leaked_data'));
      assert.ok(!text.includes('mem_1'));
      const data = JSON.parse(text);
      assert.deepEqual(data, { error: 'INTERNAL_SERVER_ERROR' });
    } finally {
      await harness.close();
    }
  }
});

test('POST /v1/brain/turn policy: HANDOVER_REQUIRED takes precedence over allowDrafts=false', async () => {
  const harness = await startTestServer();
  try {
    const req = createValidTurnRequest({
      policy: {
        permissionProfile: 'READ_ONLY',
        conversationState: 'HANDOVER_REQUIRED',
        allowDrafts: false,
      },
    });

    const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.proposal.decision, 'HANDOVER');
    assert.equal(data.proposal.handoverReason, 'CONVERSATION_STATE_HANDOVER_REQUIRED');
    assert.equal(harness.backend.callCount, 0, 'Model backend must NOT be invoked');
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: slow body client exceeding bodyTimeoutMs is terminated with 408', async () => {
  const harness = await startTestServer({ bodyTimeoutMs: 100 });
  try {
    const address = harness.server.address() as { port: number };
    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    let responseData = '';
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          `POST /v1/brain/turn HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${address.port}\r\n` +
            `Authorization: Bearer ${TEST_TOKEN}\r\n` +
            `X-AI-Brain-Contract: v1\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: 500\r\n` +
            `Connection: close\r\n\r\n` +
            `{"part": 1`
        );
      });
      socket.on('data', (c) => {
        responseData += c.toString('utf8');
      });
      socket.on('close', resolve);
      socket.on('error', reject);
    });

    assert.ok(responseData.includes('408 Request Timeout') || responseData.includes('408'));
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: slow header client exceeding headersTimeoutMs is closed (short test budget)', async () => {
  const harness = await startTestServer({ headersTimeoutMs: 150 });
  try {
    const address = harness.server.address() as { port: number };
    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    let closed = false;
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        socket.write('POST /v1/brain/turn HTTP/1.1\r\nHost: 127.0.0.1\r\n');
      });
      socket.on('data', () => {
        closed = true;
        socket.destroy();
        resolve();
      });
      socket.on('close', () => {
        closed = true;
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        closed = true;
        socket.destroy();
        resolve();
      });
    });

    assert.equal(closed, true, 'Socket should be closed when headersTimeoutMs expires');
  } finally {
    await harness.close();
  }
});

// -----------------------------------------------------------------------------
// Exact Required Field & Unknown Key Schema Gap Tests
// -----------------------------------------------------------------------------

test('POST /v1/brain/turn schema gaps: rejects missing required keys and unknown keys in root, scope, policy, and input', async () => {
  const harness = await startTestServer();
  try {
    const sendPayload = async (payload: unknown) => {
      const res = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      return res.status;
    };

    // Root unknown key
    assert.equal(await sendPayload({ ...createValidTurnRequest(), unknownRootKey: 'bad' }), 400);

    // Root missing keys
    for (const key of ['version', 'turnId', 'traceId', 'scope', 'policy', 'input', 'latencyProfile']) {
      const req = createValidTurnRequest();
      delete ((req as unknown) as Record<string, unknown>)[key];
      assert.equal(await sendPayload(req), 400, `Missing root key: ${key}`);
    }

    // Scope unknown key
    assert.equal(
      await sendPayload(
        createValidTurnRequest({
          scope: { ...createValidTurnRequest().scope, unknownScopeKey: 'bad' } as never,
        })
      ),
      400
    );

    // Scope missing required keys
    for (const key of ['companyId', 'customerId', 'conversationId', 'channel', 'modality']) {
      const baseScope = { ...createValidTurnRequest().scope };
      delete (baseScope as Record<string, unknown>)[key];
      assert.equal(
        await sendPayload(createValidTurnRequest({ scope: baseScope as never })),
        400,
        `Missing scope key: ${key}`
      );
    }

    // Scope invalid UUIDs
    for (const key of ['companyId', 'customerId', 'conversationId']) {
      assert.equal(
        await sendPayload(
          createValidTurnRequest({ scope: { ...createValidTurnRequest().scope, [key]: 'not-a-uuid' } })
        ),
        400
      );
      assert.equal(
        await sendPayload(
          createValidTurnRequest({ scope: { ...createValidTurnRequest().scope, [key]: 12345 } as never })
        ),
        400
      );
    }

    // Policy unknown key
    assert.equal(
      await sendPayload(
        createValidTurnRequest({
          policy: { ...createValidTurnRequest().policy, unknownPolicyKey: true } as never,
        })
      ),
      400
    );

    // Policy invalid values
    assert.equal(
      await sendPayload(
        createValidTurnRequest({
          policy: { ...createValidTurnRequest().policy, permissionProfile: 'ADMIN' as never },
        })
      ),
      400
    );
    assert.equal(
      await sendPayload(
        createValidTurnRequest({
          policy: { ...createValidTurnRequest().policy, conversationState: 'INVALID_STATE' as never },
        })
      ),
      400
    );
    assert.equal(
      await sendPayload(
        createValidTurnRequest({
          policy: { ...createValidTurnRequest().policy, allowDrafts: 'yes' as never },
        })
      ),
      400
    );

    // Input unknown key
    assert.equal(
      await sendPayload(
        createValidTurnRequest({
          input: { text: 'hello', extraInputKey: 123 } as never,
        })
      ),
      400
    );

    // Input text limits (blank, >4000 chars, >12000 bytes)
    assert.equal(await sendPayload(createValidTurnRequest({ input: { text: '   ' } })), 400);
    assert.equal(await sendPayload(createValidTurnRequest({ input: { text: 'x'.repeat(4001) } })), 400);
    assert.equal(await sendPayload(createValidTurnRequest({ input: { text: '🇻🇳'.repeat(3001) } })), 400);
  } finally {
    await harness.close();
  }
});

test('POST /v1/brain/turn: rejects non-identity Content-Encoding and malformed Authorization header', async () => {
  const harness = await startTestServer();
  try {
    const resEncoding = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'X-AI-Brain-Contract': CONTRACT_VERSION,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: JSON.stringify(createValidTurnRequest()),
    });
    assert.equal(resEncoding.status, 415);

    const badAuthHeaders = [
      '',
      'Basic 12345678901234567890123456789012',
      'Bearer',
      'Bearer short',
      `Bearer ${TEST_TOKEN}_wrong`,
    ];

    for (const badAuth of badAuthHeaders) {
      const resAuth = await fetch(`${harness.baseUrl}/v1/brain/turn`, {
        method: 'POST',
        headers: {
          Authorization: badAuth,
          'X-AI-Brain-Contract': CONTRACT_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createValidTurnRequest()),
      });
      assert.equal(resAuth.status, 401, `Failed for Authorization: "${badAuth}"`);
    }
  } finally {
    await harness.close();
  }
});
