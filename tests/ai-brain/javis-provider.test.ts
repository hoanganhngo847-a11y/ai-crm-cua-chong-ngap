import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBrainService,
  JavisBrainProvider,
  type BrainContextResolver,
  type BrainTurnRequest,
  type JavisFetch,
} from '../../features/ai-brain';

const companyId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';
const traceId = '55555555-5555-4555-8555-555555555555';
const token = `jvs_${'a'.repeat(48)}`;
const canary = 'sk-secret-canary-must-never-leak';
const baseUrl = 'https://javis.internal.example';

const turnRequest: BrainTurnRequest = {
  version: 'v1',
  turnId: '66666666-6666-4666-8666-666666666666',
  traceId,
  scope: {
    companyId,
    customerId,
    conversationId,
    channel: 'MESSENGER',
    modality: 'TEXT',
  },
  policy: {
    permissionProfile: 'READ_ONLY',
    conversationState: 'AI_ACTIVE',
    allowDrafts: true,
  },
  input: { text: 'Xin chào, tôi muốn hỏi thêm thông tin.' },
  latencyProfile: 'STANDARD',
};

const okEnvelope = {
  ok: true,
  version: 'v1',
  proposal: { decision: 'RESPOND', draft: 'Chào anh/chị.', confidence: 0.9 },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const resolver: BrainContextResolver = async (selector) => ({
  ...selector,
  companyId,
  caller: { actorId, actorType: 'WORKLOAD' },
  permissionProfile: 'READ_ONLY',
  conversationState: 'AI_ACTIVE',
  allowDrafts: true,
  traceId,
});

function provider(fetchImpl: JavisFetch): JavisBrainProvider {
  return new JavisBrainProvider({ baseUrl, authToken: token, fetchImpl });
}

test('adapter uses a fixed safe descriptor with no credential material', () => {
  const p = provider(async () => response(okEnvelope));
  assert.deepEqual(p.descriptor, { id: 'javis-brain-service', model: 'javis-router-v1' });
  assert.ok(Object.isFrozen(p.descriptor));
  assert.ok(!JSON.stringify(p.descriptor).includes(token));
});

test('runTurn sends the v1 turn only to the fixed HTTPS endpoint and authenticates in headers', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const p = provider(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return response(okEnvelope);
  });

  const proposal = await p.runTurn(turnRequest, { signal: new AbortController().signal });
  assert.equal(capturedUrl, `${baseUrl}/v1/brain/turn`);
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.redirect, 'error');
  assert.equal(capturedInit?.cache, 'no-store');

  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${token}`);
  assert.equal(headers['X-AI-Brain-Contract'], 'v1');
  assert.equal(headers['Content-Type'], 'application/json');

  const body = String(capturedInit?.body ?? '');
  assert.deepEqual(JSON.parse(body), turnRequest);
  assert.ok(!body.includes(token));
  assert.ok(!body.includes('Authorization'));
  assert.ok(!body.includes(actorId));
  assert.equal(proposal.decision, 'RESPOND');
  assert.equal(proposal.draft, 'Chào anh/chị.');
});

test('health check is authenticated but sends no CRM payload', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const p = provider(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return response({ ok: true, service: 'javis-brain', version: 'v1' });
  });
  const health = await p.checkHealth({ signal: new AbortController().signal });
  assert.deepEqual(health, { ok: true, service: 'javis-brain', version: 'v1' });
  assert.ok(Object.isFrozen(health));
  assert.equal(capturedUrl, `${baseUrl}/health`);
  assert.equal(capturedInit?.method, 'GET');
  assert.equal(capturedInit?.body, undefined);
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${token}`);
  assert.equal(headers['Content-Type'], undefined);
});

for (const badUrl of [
  'http://javis.internal.example',
  'http://127.0.0.1:7777',
  'https://user:pass@javis.example.com',
  'https://javis.example.com?token=abc',
  'https://javis.example.com/#secret',
  'javascript:alert(1)',
]) {
  test(`unsafe service URL is rejected: ${badUrl.split(':')[0]}`, () => {
    assert.throws(() => new JavisBrainProvider({ baseUrl: badUrl, authToken: token }));
  });
}

for (const badToken of ['', 'short', `jvs_${'a'.repeat(20)}\nsecret`, 'x'.repeat(513)]) {
  test('missing, whitespace-bearing or oversized internal token is rejected', () => {
    assert.throws(() => new JavisBrainProvider({ baseUrl, authToken: badToken }));
  });
}

test('non-2xx response body is never surfaced by the adapter', async () => {
  const p = provider(async () => response({ error: canary, token: canary }, 500));
  await assert.rejects(
    () => p.runTurn(turnRequest, { signal: new AbortController().signal }),
    (error: unknown) => error instanceof Error && error.message === 'BRAIN_HTTP_ERROR' && !error.message.includes(canary),
  );
});

for (const malformed of [
  { ok: false, version: 'v1', proposal: okEnvelope.proposal },
  { ok: true, version: 'v2', proposal: okEnvelope.proposal },
  { ...okEnvelope, secret: canary },
  { ok: true, version: 'v1', proposal: { ...okEnvelope.proposal, toolsUsed: ['delete_customer'] } },
  { ok: true, version: 'v1', proposal: { ...okEnvelope.proposal, chainOfThought: canary } },
]) {
  test('malformed or authority-expanding remote envelope is rejected', async () => {
    const p = provider(async () => response(malformed));
    await assert.rejects(() => p.runTurn(turnRequest, { signal: new AbortController().signal }));
  });
}

test('malformed health response is rejected rather than treated as ready', async () => {
  const p = provider(async () => response({ ok: true, service: 'javis-brain', version: 'v1', token: canary }));
  await assert.rejects(() => p.checkHealth({ signal: new AbortController().signal }));
});

test('BrainService maps remote HTTP failure to canonical provider error without leaking body/token', async () => {
  const p = provider(async () => response({ detail: canary, credential: token }, 503));
  const service = createBrainService({ resolveContext: resolver, provider: p, timeoutMs: 100 });
  const result = await service.handleBrainTurn({
    customerId,
    conversationId,
    channel: 'MESSENGER',
    modality: 'TEXT',
    input: { text: 'hello' },
  });
  assert.equal(result.errorCode, 'BRAIN_HTTP_ERROR');
  assert.equal(result.decision, 'ERROR');
  assert.equal(result.handoverRequired, true);
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.ok(!JSON.stringify(result).includes(token));
});

test('BrainService deadline aborts the in-flight Javis request and returns BRAIN_TIMEOUT', async () => {
  let seenSignal: AbortSignal | undefined;
  const p = provider(async (_input, init) => {
    seenSignal = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      seenSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  });
  const service = createBrainService({ resolveContext: resolver, provider: p, timeoutMs: 15 });
  const result = await service.handleBrainTurn({
    customerId,
    conversationId,
    channel: 'PHONE',
    modality: 'VOICE',
    latency: 'REALTIME',
    input: { text: 'hello' },
  });
  assert.equal(result.errorCode, 'BRAIN_TIMEOUT');
  assert.equal(seenSignal?.aborted, true);
});

test('remote service cannot replace trusted CRM scope through its proposal', async () => {
  const p = provider(async () => response({
    ok: true,
    version: 'v1',
    proposal: {
      decision: 'RESPOND',
      draft: 'Safe draft',
      confidence: 0.7,
      companyId: '99999999-9999-4999-8999-999999999999',
    },
  }));
  const service = createBrainService({ resolveContext: resolver, provider: p });
  const result = await service.handleBrainTurn({
    customerId,
    conversationId,
    channel: 'ZALO',
    modality: 'TEXT',
    input: { text: 'hello' },
  });
  assert.equal(result.errorCode, 'BRAIN_PROVIDER_ERROR');
  assert.equal(result.audit.companyId, companyId);
});

for (const [status, code] of [[401, 'BRAIN_AUTH_FAILED'], [403, 'BRAIN_AUTH_FAILED'], [400, 'BRAIN_REQUEST_INVALID'], [504, 'BRAIN_TIMEOUT']] as const) {
  test(`CRM provider classifies HTTP ${status} without reading error body`, async () => {
    const p = provider(async () => new Response(canary, { status }));
    await assert.rejects(() => p.runTurn(turnRequest, { signal: new AbortController().signal }), { message: code });
  });
}
test('CRM accepts only allowlisted structured upstream diagnostics', async () => {
  const p = provider(async () => new Response(canary, { status: 500, headers: {
    'X-AI-Brain-Error': 'MODEL_CONFIG_INVALID', 'X-AI-Brain-Phase': 'MODEL_PROVIDER', 'X-AI-Brain-Upstream-Status': '404',
  } }));
  const result = await createBrainService({ resolveContext: resolver, provider: p }).handleBrainTurn({
    customerId, conversationId, channel: 'MESSENGER', modality: 'TEXT', input: { text: 'Synthetic' },
  });
  assert.equal(result.errorCode, 'MODEL_CONFIG_INVALID');
  assert.ok(!JSON.stringify(result).includes(canary));
  const bad = provider(async () => new Response('', { status: 500, headers: {
    'X-AI-Brain-Error': 'UNKNOWN_SECRET_CODE', 'X-AI-Brain-Phase': 'MODEL_PROVIDER',
  } }));
  await assert.rejects(() => bad.runTurn(turnRequest, { signal: new AbortController().signal }), { message: 'BRAIN_HTTP_ERROR' });
});
