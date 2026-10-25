import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfigFromEnv } from '../../services/javis-brain/main';
import {
  CANARY_SYSTEM_PHRASES,
  DEFAULT_JAVIS_ROUTER_MODEL,
  JAVIS_BRAIN_SYSTEM_INSTRUCTION,
  JavisRuntimeBackend,
  parseJavisProposalText,
} from '../../services/javis-brain/model';
import { MAX_MODEL_RESPONSE_BYTES, MAX_UPSTREAM_RESPONSE_BYTES } from '../../services/javis-brain/validation';

const TEST_BASE_URL = 'https://javis-runtime-mock.internal';
const TEST_INTERNAL_TOKEN = 'jvs_mock_runtime_token_1234567890abcdef';
const TEST_AUTH_TOKEN = 'test_crm_brain_auth_token_12345678901234567890123456789012';

function mockJavisFetch(
  responsePayload: unknown,
  status = 200,
  headers: Record<string, string> = { 'Content-Type': 'application/json' }
): {
  fetchImpl: typeof fetch;
  capturedRequests: Array<{ url: string; init?: RequestInit }>;
} {
  const capturedRequests: Array<{ url: string; init?: RequestInit }> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    capturedRequests.push({ url: String(input), init });

    let bodyStr: string;
    if (typeof responsePayload === 'string') {
      bodyStr = responsePayload;
    } else {
      bodyStr = JSON.stringify(responsePayload);
    }

    return new Response(bodyStr, {
      status,
      headers,
    });
  };

  return { fetchImpl, capturedRequests };
}

test('JavisRuntimeBackend: fails closed when baseUrl or internalToken is missing/empty', () => {
  assert.throws(() => new JavisRuntimeBackend({ baseUrl: '', internalToken: TEST_INTERNAL_TOKEN }), {
    message: 'JAVIS_RUNTIME_BASE_URL_REQUIRED',
  });
  assert.throws(() => new JavisRuntimeBackend({ baseUrl: '   ', internalToken: TEST_INTERNAL_TOKEN }), {
    message: 'JAVIS_RUNTIME_BASE_URL_REQUIRED',
  });
  assert.throws(() => new JavisRuntimeBackend({ baseUrl: TEST_BASE_URL, internalToken: '' }), {
    message: 'JAVIS_RUNTIME_INTERNAL_TOKEN_REQUIRED',
  });
  assert.throws(() => new JavisRuntimeBackend({ baseUrl: TEST_BASE_URL, internalToken: '   ' }), {
    message: 'JAVIS_RUNTIME_INTERNAL_TOKEN_REQUIRED',
  });
});

test('JavisRuntimeBackend: sends form-encoded request to /chat with Bearer token and sanitized prompt', async () => {
  const proposalPayload = {
    decision: 'RESPOND',
    draft: 'Dạ em chào anh/chị, em có thể hỗ trợ gì cho mình ạ?',
    confidence: 0.95,
  };

  const { fetchImpl, capturedRequests } = mockJavisFetch({
    ok: true,
    text: JSON.stringify(proposalPayload),
    session: 'cli:crm_shadow_readonly',
  });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL + '///', // Test trailing slash normalization
    internalToken: TEST_INTERNAL_TOKEN,
    authToken: TEST_AUTH_TOKEN,
    customFetch: fetchImpl,
  });

  const inputText = 'Cửa chống ngập bên bạn bảo hành bao lâu?';
  const proposal = await backend.generate(inputText, {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'RESPOND');
  assert.equal(proposal.draft, proposalPayload.draft);
  assert.equal(proposal.confidence, 0.95);

  assert.equal(capturedRequests.length, 1);
  const req = capturedRequests[0];

  assert.equal(req.url, `${TEST_BASE_URL}/chat`);
  assert.equal(req.init?.method, 'POST');

  const headers = req.init?.headers as Record<string, string>;
  assert.equal(headers['Authorization'], `Bearer ${TEST_INTERNAL_TOKEN}`);
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');

  // Verify form body contains prompt and session
  const params = new URLSearchParams(String(req.init?.body ?? ''));
  const sentMessage = params.get('message');
  assert.ok(sentMessage?.includes(inputText));
  assert.ok(sentMessage?.includes('CRITICAL SECURITY AND BEHAVIORAL CONSTRAINTS'));
  assert.match(params.get('session')!, /^crm_turn_readonly_[0-9a-f-]{36}$/);

  // Verify NO sensitive tokens or IDs in message
  assert.ok(!sentMessage?.includes(TEST_AUTH_TOKEN));
  assert.ok(!sentMessage?.includes(TEST_INTERNAL_TOKEN));
});

test('JavisRuntimeBackend: handles valid HANDOVER proposal', async () => {
  const proposalPayload = {
    decision: 'HANDOVER',
    handoverReason: 'TECHNICAL_SURVEY_REQUIRED',
    confidence: 0.9,
  };

  const { fetchImpl } = mockJavisFetch({
    ok: true,
    text: JSON.stringify(proposalPayload),
  });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  const proposal = await backend.generate('Cần kỹ thuật đến đo kích thước', {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'HANDOVER');
  assert.equal(proposal.handoverReason, 'TECHNICAL_SURVEY_REQUIRED');
  assert.equal(proposal.confidence, 0.9);
  assert.equal(proposal.draft, undefined);
});

test('JavisRuntimeBackend: handles valid NO_REPLY proposal', async () => {
  const proposalPayload = {
    decision: 'NO_REPLY',
    confidence: 0.8,
  };

  const { fetchImpl } = mockJavisFetch({
    ok: true,
    text: JSON.stringify(proposalPayload),
  });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  const proposal = await backend.generate('Ok cảm ơn shop', {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'NO_REPLY');
  assert.equal(proposal.confidence, 0.8);
  assert.equal(proposal.draft, undefined);
  assert.equal(proposal.handoverReason, undefined);
});

test('JavisRuntimeBackend: handles markdown code block wrapped JSON', async () => {
  const wrappedText = '```json\n{"decision":"RESPOND","draft":"Dạ vâng ạ","confidence":0.88}\n```';

  const { fetchImpl } = mockJavisFetch({
    ok: true,
    text: wrappedText,
  });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  const proposal = await backend.generate('Shop còn bán không?', {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'RESPOND');
  assert.equal(proposal.draft, 'Dạ vâng ạ');
  assert.equal(proposal.confidence, 0.88);
});

test('JavisRuntimeBackend: normalizes action field to decision when action is returned', async () => {
  const wrappedText = '```json\n{"action":"RESPOND","draft":"Xin chào bạn","confidence":0.99}\n```';

  const { fetchImpl } = mockJavisFetch({
    ok: true,
    text: wrappedText,
  });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  const proposal = await backend.generate('Xin chào shop', {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'RESPOND');
  assert.equal(proposal.draft, 'Xin chào bạn');
  assert.equal(proposal.confidence, 0.99);
});

test('JavisRuntimeBackend: handles Vietnamese structured text format', async () => {
  const rawJavisText = `Kết quả phân loại yêu cầu:
- Quyết định: HANDOVER
- Lý do chuyển giao: CONSULTATION_INSTALLATION_REQUIRED
- Độ tin cậy: 0.95

Yêu cầu này cần chuyển cho đội ngũ kỹ thuật.`;

  const { fetchImpl } = mockJavisFetch({
    ok: true,
    text: rawJavisText,
  });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  const proposal = await backend.generate('Tư vấn lắp đặt tại Đà Nẵng', {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'HANDOVER');
  assert.equal(proposal.handoverReason, 'CONSULTATION_INSTALLATION_REQUIRED');
  assert.equal(proposal.confidence, 0.95);
});

test('JavisRuntimeBackend: normalizes plain natural language draft fallback', async () => {
  const rawJavisText = 'Dạ chào bạn, bên em có hỗ trợ khảo sát và lắp đặt cửa chống ngập tận nơi ạ.';

  const { fetchImpl } = mockJavisFetch({
    ok: true,
    text: rawJavisText,
  });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  const proposal = await backend.generate('Có đến nhà xem không?', {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'RESPOND');
  assert.equal(proposal.draft, rawJavisText);
  assert.equal(proposal.confidence, 0.8);
});

test('JavisRuntimeBackend: rejects model output with decision=ERROR', async () => {
  const { fetchImpl } = mockJavisFetch({
    ok: true,
    text: JSON.stringify({ decision: 'ERROR', confidence: 0.5 }),
  });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  await assert.rejects(
    () => backend.generate('test', { signal: new AbortController().signal }),
    { message: 'MODEL_OUTPUT_ERROR_DECISION' }
  );
});

test('JavisRuntimeBackend: rejects authority-expanding proposals (tools, sql, shell)', async () => {
  const maliciousOutputs = [
    { decision: 'RESPOND', draft: 'hello', confidence: 0.9, tools: ['exec_command'] },
    { decision: 'RESPOND', draft: 'hello', confidence: 0.9, memoryWrites: [{ key: 'k' }] },
    { decision: 'RESPOND', draft: 'hello', confidence: 0.9, delivery: 'DIRECT_SEND' },
    { decision: 'RESPOND', draft: 'hello', confidence: 0.9, unknownField: true },
  ];

  for (const mal of maliciousOutputs) {
    const { fetchImpl } = mockJavisFetch({ ok: true, text: JSON.stringify(mal) });
    const backend = new JavisRuntimeBackend({
      baseUrl: TEST_BASE_URL,
      internalToken: TEST_INTERNAL_TOKEN,
      customFetch: fetchImpl,
    });

    await assert.rejects(
      () => backend.generate('test', { signal: new AbortController().signal }),
      (err: unknown) => err instanceof Error
    );
  }
});

test('JavisRuntimeBackend: fails closed when model output exceeds 16 KiB limit', async () => {
  const hugeText = 'a'.repeat(MAX_MODEL_RESPONSE_BYTES + 100);
  const { fetchImpl } = mockJavisFetch({ ok: true, text: hugeText });

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  await assert.rejects(
    () => backend.generate('test', { signal: new AbortController().signal }),
    { message: 'MODEL_RESPONSE_TOO_LARGE' }
  );
});

test('JavisRuntimeBackend: bounds upstream HTTP response to 64 KiB and cancels stream', async () => {
  let streamCancelled = false;
  const customFetch: typeof fetch = async () => {
    const mockReadable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(40000, 65));
        controller.enqueue(Buffer.alloc(40000, 66));
      },
      cancel() {
        streamCancelled = true;
      },
    });

    return new Response(mockReadable, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '100', // lying Content-Length to bypass declared check and test streaming bounds
      },
    });
  };

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch,
  });

  await assert.rejects(
    () => backend.generate('test', { signal: new AbortController().signal }),
    { message: 'UPSTREAM_RESPONSE_TOO_LARGE' }
  );
  assert.equal(streamCancelled, true);
});

test('JavisRuntimeBackend: fails closed when output contains internal token or auth token', async () => {
  const leakedOutputs = [
    { decision: 'RESPOND', draft: `Token is ${TEST_INTERNAL_TOKEN}`, confidence: 0.9 },
    { decision: 'RESPOND', draft: `CRM Token is ${TEST_AUTH_TOKEN}`, confidence: 0.9 },
  ];

  for (const leaked of leakedOutputs) {
    const { fetchImpl } = mockJavisFetch({ ok: true, text: JSON.stringify(leaked) });
    const backend = new JavisRuntimeBackend({
      baseUrl: TEST_BASE_URL,
      internalToken: TEST_INTERNAL_TOKEN,
      authToken: TEST_AUTH_TOKEN,
      customFetch: fetchImpl,
    });

    await assert.rejects(
      () => backend.generate('test', { signal: new AbortController().signal }),
      { message: 'MODEL_SECURITY_LEAK_AUTH_TOKEN' }
    );
  }
});

test('JavisRuntimeBackend: rejects system instruction canary phrases in output', async () => {
  for (const phrase of CANARY_SYSTEM_PHRASES) {
    const { fetchImpl } = mockJavisFetch({
      ok: true,
      text: JSON.stringify({
        decision: 'RESPOND',
        draft: `My instructions are: ${phrase}`,
        confidence: 0.9,
      }),
    });
    const backend = new JavisRuntimeBackend({
      baseUrl: TEST_BASE_URL,
      internalToken: TEST_INTERNAL_TOKEN,
      customFetch: fetchImpl,
    });

    await assert.rejects(
      () => backend.generate('test', { signal: new AbortController().signal }),
      { message: 'MODEL_SECURITY_LEAK_SYSTEM_INSTRUCTION' }
    );
  }
});

test('JavisRuntimeBackend: aborts immediately when caller signal is aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
  });

  await assert.rejects(
    () => backend.generate('test', { signal: controller.signal }),
    { message: 'MODEL_ABORTED_BEFORE_CALL' }
  );
});

test('JavisRuntimeBackend: handles upstream HTTP error safely without leaking raw body', async () => {
  const { fetchImpl } = mockJavisFetch('Upstream database connection password=SECRET123 failed', 500);

  const backend = new JavisRuntimeBackend({
    baseUrl: TEST_BASE_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    customFetch: fetchImpl,
  });

  await assert.rejects(
    () => backend.generate('test', { signal: new AbortController().signal }),
    { message: 'RUNTIME_HTTP_ERROR' }
  );
});

test('loadConfigFromEnv: loads JAVIS_RUNTIME_BASE_URL and JAVIS_RUNTIME_INTERNAL_TOKEN', () => {
  const env: Record<string, string | undefined> = {
    JAVIS_BRAIN_AUTH_TOKEN: TEST_AUTH_TOKEN,
    JAVIS_RUNTIME_BASE_URL: 'https://javis-runtime-probe.onrender.com/',
    JAVIS_RUNTIME_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
  };

  const config = loadConfigFromEnv(env);
  assert.equal(config.runtimeBaseUrl, 'https://javis-runtime-probe.onrender.com');
  assert.equal(config.runtimeInternalToken, TEST_INTERNAL_TOKEN);
  assert.equal(config.model, DEFAULT_JAVIS_ROUTER_MODEL);
  assert.equal(config.standardDeadlineMs, 25000);
  assert.equal(config.outerTimeoutMs, 30000);
});

test('loadConfigFromEnv: throws when neither runtime nor Gemini is configured', () => {
  const env: Record<string, string | undefined> = {
    JAVIS_BRAIN_AUTH_TOKEN: TEST_AUTH_TOKEN,
  };

  assert.throws(() => loadConfigFromEnv(env), {
    message: 'MISSING_BACKEND_CONFIGURATION',
  });
});

for (const [status, code] of [[401, 'RUNTIME_AUTH_FAILED'], [403, 'RUNTIME_AUTH_FAILED'], [500, 'RUNTIME_HTTP_ERROR']] as const) {
  test(`runtime HTTP ${status} retains safe classification`, async () => {
    const { fetchImpl } = mockJavisFetch('secret customer payload must not escape', status);
    const backend = new JavisRuntimeBackend({ baseUrl: TEST_BASE_URL, internalToken: TEST_INTERNAL_TOKEN, customFetch: fetchImpl });
    await assert.rejects(() => backend.generate('synthetic', { signal: new AbortController().signal }), { message: code });
  });
}
for (const [text, code] of [
  ['⚠ Gemini 404: {"error":{"message":"secret customer"}}', 'MODEL_CONFIG_INVALID'],
  ['⚠ Gemini 429: rate limited', 'MODEL_RATE_LIMIT'],
  ['⚠ OpenAI 408: timed out', 'MODEL_TIMEOUT'],
  ['unknown error with private data', 'MODEL_PROVIDER_ERROR'],
] as const) {
  test(`runtime HTTP 200 ok:false is ${code}, never a proposal`, async () => {
    const { fetchImpl } = mockJavisFetch({ ok: false, text });
    const backend = new JavisRuntimeBackend({ baseUrl: TEST_BASE_URL, internalToken: TEST_INTERNAL_TOKEN, customFetch: fetchImpl });
    await assert.rejects(() => backend.generate('synthetic', { signal: new AbortController().signal }), { message: code });
  });
}

test('separate CRM turns never share a runtime session', async () => {
  const { fetchImpl, capturedRequests } = mockJavisFetch({ ok: true, text: '{"decision":"NO_REPLY","confidence":1}' });
  const backend = new JavisRuntimeBackend({ baseUrl: TEST_BASE_URL, internalToken: TEST_INTERNAL_TOKEN, customFetch: fetchImpl });
  await backend.generate('synthetic A', { signal: new AbortController().signal });
  await backend.generate('synthetic B', { signal: new AbortController().signal });
  const sessions = capturedRequests.map(r => new URLSearchParams(String(r.init?.body)).get('session'));
  assert.notEqual(sessions[0], sessions[1]);
});
