import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_JAVIS_BRAIN_MODEL,
  GeminiModelBackend,
  JAVIS_BRAIN_SYSTEM_INSTRUCTION,
} from '../../services/javis-brain/model';
import type { BrainTurnGrounding } from '../../features/ai-brain/contracts';

const TEST_API_KEY = 'AIzaSyFakeTestGeminiApiKey_1234567890';
const TEST_AUTH_TOKEN = 'test_token_12345678901234567890123456789012';

function mockGeminiFetch(responseBody: unknown, status = 200): {
  fetchImpl: typeof fetch;
  capturedRequests: Array<{ url: string; init?: RequestInit }>;
} {
  const capturedRequests: Array<{ url: string; init?: RequestInit }> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    capturedRequests.push({ url: String(input), init });

    // The Gemini SDK expects a response shaped like Google GenAI API response
    const geminiApiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
              },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    };

    return new Response(JSON.stringify(geminiApiResponse), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fetchImpl, capturedRequests };
}

test('GeminiModelBackend: fails closed when API key is missing or empty', () => {
  assert.throws(() => new GeminiModelBackend({ apiKey: '' }));
  assert.throws(() => new GeminiModelBackend({ apiKey: '   ' } as never));
});

test('GeminiModelBackend: sends ONLY sanitized input text and verifies model configuration', async () => {
  const proposalPayload = {
    decision: 'RESPOND',
    draft: 'Xin chào anh/chị, em có thể tư vấn gì cho mình?',
    confidence: 0.92,
  };

  const { fetchImpl, capturedRequests } = mockGeminiFetch(proposalPayload);

  const backend = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    model: 'gemini-2.5-flash',
    authToken: TEST_AUTH_TOKEN,
    customFetch: fetchImpl,
  });

  const inputText = 'Sản phẩm bên mình bảo hành bao lâu vậy shop?';
  const proposal = await backend.generate(inputText, {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'RESPOND');
  assert.equal(proposal.draft, proposalPayload.draft);
  assert.equal(proposal.confidence, 0.92);

  // Verify captured SDK HTTP request
  assert.equal(capturedRequests.length, 1);
  const req = capturedRequests[0];

  // URL should target Gemini API with model gemini-2.5-flash
  assert.ok(req.url.includes('gemini-2.5-flash'));
  assert.equal(req.init?.method, 'POST');

  const reqBody = JSON.parse(String(req.init?.body ?? '{}'));

  // Verify contents: MUST contain only the sanitized input text
  assert.ok(Array.isArray(reqBody.contents));
  assert.equal(reqBody.contents.length, 1);
  assert.equal(reqBody.contents[0].parts[0].text, inputText);

  // Verify NO internal IDs, companyId, customerId, or auth token in payload
  const rawBodyString = String(req.init?.body ?? '');
  assert.ok(!rawBodyString.includes(TEST_AUTH_TOKEN));
  assert.ok(!rawBodyString.includes('companyId'));
  assert.ok(!rawBodyString.includes('customerId'));
  assert.ok(!rawBodyString.includes('turnId'));
  assert.ok(!rawBodyString.includes('traceId'));

  // Verify generationConfig
  const config = reqBody.generationConfig;
  assert.equal(config.temperature, 0.1);
  assert.equal(config.maxOutputTokens, 768);
  assert.equal(config.responseMimeType, 'application/json');

  // Verify thinkingConfig is disabled (thinkingBudget: 0)
  assert.deepEqual(config.thinkingConfig, {
    thinkingBudget: 0,
    includeThoughts: false,
  });

  // Verify system instruction is set
  assert.ok(reqBody.systemInstruction);
  assert.ok(
    reqBody.systemInstruction.parts[0].text.includes('READ_ONLY mode')
  );

  // Verify tools are NOT present in request
  assert.equal(reqBody.tools, undefined);
});

test('GeminiModelBackend: injects Facebook Page persona and contact policy into the prompt', async () => {
  const proposalPayload = {
    decision: 'RESPOND',
    draft: 'Dạ em đã ghi nhận câu hỏi của anh/chị về du học Đức ạ.',
    confidence: 0.92,
  };
  const { fetchImpl, capturedRequests } = mockGeminiFetch(proposalPayload);

  const backend = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    model: 'gemini-2.5-flash',
    customFetch: fetchImpl,
  });

  const grounding: BrainTurnGrounding = {
    conversation: {
      id: '00000000-0000-4000-8000-000000000002',
      channel: 'MESSENGER',
      status: 'OPEN',
    },
    recentMessages: [
      {
        direction: 'INBOUND',
        actorType: 'CUSTOMER',
        content: 'Tìm hiểu cho con',
        createdAt: '2026-10-29T01:00:00.000Z',
      },
      {
        direction: 'INBOUND',
        actorType: 'CUSTOMER',
        content: 'Sinh năm 98, ở miền bắc',
        createdAt: '2026-10-29T01:02:00.000Z',
      },
    ],
    knowledge: [],
    memories: [],
  };

  await backend.generate('Sinh năm 98, ở miền bắc', {
    signal: new AbortController().signal,
    grounding,
  });

  const reqBody = JSON.parse(String(capturedRequests[0].init?.body ?? '{}'));
  const prompt = String(reqBody.contents[0].parts[0].text);
  assert.match(prompt, /\[CUSTOMER PERSONA & CONTACT POLICY\]/);
  assert.match(prompt, /PHỤ HUYNH HỎI CHO CON\/CHÁU/);
  assert.match(prompt, /AI xưng "em", gọi khách "anh\/chị"/);
  assert.match(prompt, /\[LATEST INQUIRY TO RESPOND TO\]\nSinh năm 98, ở miền bắc/);
});

test('GeminiModelBackend: handles valid HANDOVER proposal with uppercase reason', async () => {
  const handoverPayload = {
    decision: 'HANDOVER',
    handoverReason: 'CUSTOMER_REQUESTS_HUMAN_AGENT',
    confidence: 0.88,
  };

  const { fetchImpl } = mockGeminiFetch(handoverPayload);
  const backend = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: fetchImpl,
  });

  const proposal = await backend.generate('Gặp trực tiếp nhân viên tư vấn giúp tôi', {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'HANDOVER');
  assert.equal(proposal.handoverReason, 'CUSTOMER_REQUESTS_HUMAN_AGENT');
  assert.equal(proposal.confidence, 0.88);
  assert.equal(proposal.draft, undefined);
});

test('GeminiModelBackend: handles valid NO_REPLY proposal', async () => {
  const noReplyPayload = {
    decision: 'NO_REPLY',
    confidence: 0.99,
  };

  const { fetchImpl } = mockGeminiFetch(noReplyPayload);
  const backend = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: fetchImpl,
  });

  const proposal = await backend.generate('ok cảm ơn', {
    signal: new AbortController().signal,
  });

  assert.equal(proposal.decision, 'NO_REPLY');
  assert.equal(proposal.confidence, 0.99);
  assert.equal(proposal.draft, undefined);
  assert.equal(proposal.handoverReason, undefined);
});

test('GeminiModelBackend: rejects model output with decision=ERROR', async () => {
  const errorPayload = {
    decision: 'ERROR',
    confidence: 0.5,
  };

  const { fetchImpl } = mockGeminiFetch(errorPayload);
  const backend = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: fetchImpl,
  });

  await assert.rejects(
    () => backend.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && /ERROR/.test(err.message)
  );
});

test('GeminiModelBackend: rejects authority-expanding proposals (tools, memory, delivery)', async () => {
  const badCases = [
    { decision: 'RESPOND', draft: 'Hello', confidence: 0.9, toolsUsed: ['execute_sql'] },
    { decision: 'RESPOND', draft: 'Hello', confidence: 0.9, memoryReferences: ['mem_1'] },
    { decision: 'RESPOND', draft: 'Hello', confidence: 0.9, delivery: 'DRAFT_ONLY' },
    { decision: 'RESPOND', draft: 'Hello', confidence: 0.9, extraAuthority: true },
    { decision: 'HANDOVER', handoverReason: 'lowercase_reason', confidence: 0.8 },
    { decision: 'HANDOVER', handoverReason: 'INVALID-REASON-WITH-DASHES', confidence: 0.8 },
    { decision: 'RESPOND', draft: '', confidence: 0.9 }, // blank draft
    { decision: 'NO_REPLY', draft: 'Should not have draft', confidence: 0.9 },
    { decision: 'UNKNOWN_DECISION', confidence: 0.9 },
    { decision: 'RESPOND', draft: 'Hello', confidence: 1.5 }, // invalid confidence > 1
    { decision: 'RESPOND', draft: 'Hello', confidence: -0.1 }, // invalid confidence < 0
  ];

  for (const badCase of badCases) {
    const { fetchImpl } = mockGeminiFetch(badCase);
    const backend = new GeminiModelBackend({
      apiKey: TEST_API_KEY,
      customFetch: fetchImpl,
    });

    await assert.rejects(
      () => backend.generate('test', { signal: new AbortController().signal }),
      `Expected failure for case: ${JSON.stringify(badCase)}`
    );
  }
});

test('GeminiModelBackend: fails closed when model output exceeds 16 KiB limit', async () => {
  const hugeText = 'A'.repeat(17000);
  const { fetchImpl } = mockGeminiFetch(hugeText);
  const backend = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: fetchImpl,
  });

  await assert.rejects(
    () => backend.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_RESPONSE_TOO_LARGE'
  );
});

test('GeminiModelBackend: fails closed when model output contains API key or internal auth token', async () => {
  // Test API Key leak
  const leakApiKeyPayload = {
    decision: 'RESPOND',
    draft: `Your key is ${TEST_API_KEY}`,
    confidence: 0.9,
  };
  const { fetchImpl: fetch1 } = mockGeminiFetch(leakApiKeyPayload);
  const backend1 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    authToken: TEST_AUTH_TOKEN,
    customFetch: fetch1,
  });

  await assert.rejects(
    () => backend1.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_SECURITY_LEAK_API_KEY'
  );

  // Test Auth Token leak
  const leakTokenPayload = {
    decision: 'RESPOND',
    draft: `Your token is ${TEST_AUTH_TOKEN}`,
    confidence: 0.9,
  };
  const { fetchImpl: fetch2 } = mockGeminiFetch(leakTokenPayload);
  const backend2 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    authToken: TEST_AUTH_TOKEN,
    customFetch: fetch2,
  });

  await assert.rejects(
    () => backend2.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_SECURITY_LEAK_AUTH_TOKEN'
  );

  // Test System Instruction leak
  const leakSystemPayload = {
    decision: 'RESPOND',
    draft: `Here is the prompt: ${JAVIS_BRAIN_SYSTEM_INSTRUCTION}`,
    confidence: 0.9,
  };
  const { fetchImpl: fetch3 } = mockGeminiFetch(leakSystemPayload);
  const backend3 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: fetch3,
  });

  await assert.rejects(
    () => backend3.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_SECURITY_LEAK_SYSTEM_INSTRUCTION'
  );
});

test('GeminiModelBackend: rejects JSON Unicode escaped credentials and prompt phrases', async () => {
  // Helper to convert an ASCII string to JSON unicode escapes: "abc" -> "\u0061\u0062\u0063"
  const toUnicodeEscapes = (str: string) =>
    str
      .split('')
      .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('');

  // 1. Escaped API Key
  const escapedKey = toUnicodeEscapes(TEST_API_KEY);
  const rawPayloadKey = `{"decision":"RESPOND","draft":"Here is your key: ${escapedKey}","confidence":0.9}`;
  const { fetchImpl: fetch1 } = mockGeminiFetch(rawPayloadKey);
  const backend1 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    authToken: TEST_AUTH_TOKEN,
    customFetch: fetch1,
  });

  await assert.rejects(
    () => backend1.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_SECURITY_LEAK_API_KEY'
  );

  // 2. Escaped Auth Token
  const escapedToken = toUnicodeEscapes(TEST_AUTH_TOKEN);
  const rawPayloadToken = `{"decision":"RESPOND","draft":"Internal token is ${escapedToken}","confidence":0.9}`;
  const { fetchImpl: fetch2 } = mockGeminiFetch(rawPayloadToken);
  const backend2 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    authToken: TEST_AUTH_TOKEN,
    customFetch: fetch2,
  });

  await assert.rejects(
    () => backend2.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_SECURITY_LEAK_AUTH_TOKEN'
  );

  // 3. Escaped Canary System Phrase
  const escapedPhrase = toUnicodeEscapes('You operate under strict READ_ONLY mode');
  const rawPayloadSystem = `{"decision":"RESPOND","draft":"Notice: ${escapedPhrase}","confidence":0.9}`;
  const { fetchImpl: fetch3 } = mockGeminiFetch(rawPayloadSystem);
  const backend3 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: fetch3,
  });

  await assert.rejects(
    () => backend3.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_SECURITY_LEAK_SYSTEM_INSTRUCTION'
  );
});

test('GeminiModelBackend: rejects malicious non-text part keys and never logs to console (no .text getter)', async () => {
  const syntheticToken = 'synthetic_secret_token_never_log_me_99999';
  const customFetch: typeof fetch = async () => {
    const rawResponseBody = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({ decision: 'NO_REPLY', confidence: 1.0 }),
                [syntheticToken]: 'malicious_value',
              },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    };
    return new Response(JSON.stringify(rawResponseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const backend = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch,
  });

  const interceptedLogs: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...args: unknown[]) => {
    interceptedLogs.push(args.map(String).join(' '));
  };
  console.log = (...args: unknown[]) => {
    interceptedLogs.push(args.map(String).join(' '));
  };

  try {
    await assert.rejects(
      () => backend.generate('test', { signal: new AbortController().signal }),
      (err: unknown) => err instanceof Error && err.message === 'MODEL_NON_TEXT_PART_REJECTED'
    );

    // Verify ZERO console logs / warns occurred containing the synthetic token
    assert.equal(
      interceptedLogs.some((l) => l.includes(syntheticToken)),
      false,
      'Synthetic token was logged to console!'
    );
    assert.equal(interceptedLogs.length, 0, 'No console logs/warnings should be emitted');
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }
});

test('GeminiModelBackend: rejects multiple candidates and thought/CoT parts', async () => {
  // 1. Multiple candidates
  const multiCandidateFetch: typeof fetch = async () => {
    const body = {
      candidates: [
        { content: { parts: [{ text: '{"decision":"NO_REPLY","confidence":1.0}' }] } },
        { content: { parts: [{ text: '{"decision":"NO_REPLY","confidence":0.8}' }] } },
      ],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const backend1 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: multiCandidateFetch,
  });
  await assert.rejects(
    () => backend1.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_MULTIPLE_CANDIDATES_REJECTED'
  );

  // 2. Thought / CoT part
  const thoughtFetch: typeof fetch = async () => {
    const body = {
      candidates: [
        {
          content: {
            parts: [
              { text: '{"decision":"NO_REPLY","confidence":1.0}', thought: true },
            ],
          },
        },
      ],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const backend2 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: thoughtFetch,
  });
  await assert.rejects(
    () => backend2.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'MODEL_NON_TEXT_PART_REJECTED'
  );
});

test('GeminiModelBackend: rejects null fields (draft or handoverReason)', async () => {
  const nullCases = [
    { decision: 'RESPOND', draft: null, confidence: 0.9 },
    { decision: 'HANDOVER', handoverReason: null, confidence: 0.9 },
    { decision: 'HANDOVER', handoverReason: 'VALID_REASON', draft: null, confidence: 0.9 },
    { decision: 'NO_REPLY', draft: null, confidence: 1.0 },
  ];

  for (const c of nullCases) {
    const { fetchImpl } = mockGeminiFetch(c);
    const backend = new GeminiModelBackend({
      apiKey: TEST_API_KEY,
      customFetch: fetchImpl,
    });
    await assert.rejects(
      () => backend.generate('test', { signal: new AbortController().signal }),
      `Expected rejection for null field in: ${JSON.stringify(c)}`
    );
  }
});

test('GeminiModelBackend: bounds upstream HTTP response to 64 KiB and cancels stream', async () => {
  // 1. Declared Content-Length > 64 KiB
  const declaredOversizedFetch: typeof fetch = async () => {
    return new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '70000',
      },
    });
  };

  const backend1 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: declaredOversizedFetch,
  });
  await assert.rejects(
    () => backend1.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'UPSTREAM_RESPONSE_TOO_LARGE'
  );

  // 2. Streamed bytes > 64 KiB with lying Content-Length
  let streamCancelled = false;
  const lyingLengthFetch: typeof fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(40000, 'x'));
        controller.enqueue(Buffer.alloc(40000, 'y'));
      },
      cancel() {
        streamCancelled = true;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '100', // lying Content-Length
      },
    });
  };

  const backend2 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: lyingLengthFetch,
  });
  await assert.rejects(
    () => backend2.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'UPSTREAM_RESPONSE_TOO_LARGE'
  );
  assert.equal(streamCancelled, true, 'Upstream stream must be cancelled when exceeding 64 KiB');

  // 3. Upstream non-2xx: body never read or logged, throws UPSTREAM_HTTP_ERROR
  let non2xxBodyRead = false;
  const non2xxFetch: typeof fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        non2xxBodyRead = true;
        controller.enqueue(Buffer.from('{"error":"sensitive_internal_trace"}'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 500,
      statusText: 'Internal Error',
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const backend3 = new GeminiModelBackend({
    apiKey: TEST_API_KEY,
    customFetch: non2xxFetch,
  });
  await assert.rejects(
    () => backend3.generate('test', { signal: new AbortController().signal }),
    (err: unknown) => err instanceof Error && err.message === 'UPSTREAM_HTTP_ERROR'
  );
});
