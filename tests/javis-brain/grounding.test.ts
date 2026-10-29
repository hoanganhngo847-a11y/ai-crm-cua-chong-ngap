import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  formatGroundingContext,
  JAVIS_BRAIN_SYSTEM_INSTRUCTION,
} from '../../services/javis-brain/model';
import { validateBrainTurnRequest } from '../../services/javis-brain/validation';
import type { BrainTurnGrounding } from '../../features/ai-brain/contracts';
import { createJavisBrainServer } from '../../services/javis-brain/server';
import { JavisBrainProvider } from '../../features/ai-brain/javis-provider';
import { createBrainService } from '../../features/ai-brain/service';

const TEST_AUTH_TOKEN = 'test-token-32-chars-long-strictly-valid-1234';

function validGrounding(): BrainTurnGrounding {
  return {
    customer: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Trần Thị B',
      customerCode: 'CUST-002',
      stage: 'PROSPECT',
    },
    conversation: {
      id: '00000000-0000-4000-8000-000000000002',
      channel: 'ZALO',
      status: 'OPEN',
      aiMode: 'ACTIVE',
      assignedTo: null,
    },
    recentMessages: [
      {
        direction: 'INBOUND',
        actorType: 'CUSTOMER',
        content: 'Cửa hàng có giao hàng tận nơi không?',
        createdAt: '2026-10-23T00:00:00.000Z',
      },
      {
        direction: 'OUTBOUND',
        actorType: 'AI',
        content: 'Chào bạn, cửa hàng có giao hàng toàn quốc ạ.',
        createdAt: '2026-10-23T00:01:00.000Z',
      },
    ],
    knowledge: [
      {
        category: 'POLICY',
        title: 'Chính sách vận chuyển',
        content: 'Miễn phí vận chuyển cho đơn hàng từ 1.000.000 VNĐ. Giao hàng nhanh nội thành trong 2 giờ.',
      },
    ],
    memories: [
      {
        type: 'PREFERENCE',
        key: 'shipping_time',
        content: 'Khách chỉ nhận hàng vào buổi chiều sau 14h',
        confidence: 0.95,
        verified: true,
      },
    ],
    businessFacts: {
      upcomingAppointmentsCount: 0,
      lastCallSummary: null,
    },
  };
}

test('Grounding Validation: validates and deepFreezes well-formed grounding request', () => {
  const rawRequest = {
    version: 'v1',
    turnId: randomUUID(),
    traceId: randomUUID(),
    scope: {
      companyId: randomUUID(),
      customerId: randomUUID(),
      conversationId: randomUUID(),
      channel: 'ZALO',
      modality: 'TEXT',
    },
    policy: {
      permissionProfile: 'READ_ONLY',
      conversationState: 'AI_ACTIVE',
      allowDrafts: true,
    },
    input: {
      text: 'Phí ship về quận Cầu Giấy là bao nhiêu?',
    },
    latencyProfile: 'STANDARD',
    grounding: validGrounding(),
  };

  const validated = validateBrainTurnRequest(rawRequest);
  assert.equal(validated.version, 'v1');
  assert.ok(validated.grounding);
  assert.equal(validated.grounding?.customer?.name, 'Trần Thị B');
  assert.equal(validated.grounding?.knowledge.length, 1);
  assert.equal(validated.grounding?.knowledge[0].title, 'Chính sách vận chuyển');
  assert.equal(validated.grounding?.memories.length, 1);
  assert.equal(validated.grounding?.memories[0].verified, true);
});

test('Grounding Validation: rejects unknown keys in grounding record', () => {
  const rawRequest = {
    version: 'v1',
    turnId: randomUUID(),
    traceId: randomUUID(),
    scope: {
      companyId: randomUUID(),
      customerId: randomUUID(),
      conversationId: randomUUID(),
      channel: 'ZALO',
      modality: 'TEXT',
    },
    policy: {
      permissionProfile: 'READ_ONLY',
      conversationState: 'AI_ACTIVE',
      allowDrafts: true,
    },
    input: {
      text: 'Test',
    },
    latencyProfile: 'STANDARD',
    grounding: {
      ...validGrounding(),
      maliciousField: 'exploit',
    },
  };

  assert.throws(() => validateBrainTurnRequest(rawRequest), {
    name: 'RequestValidationError',
  });
});

test('Grounding Formatter: produces formatted sections for model input', () => {
  const formatted = formatGroundingContext(validGrounding());

  assert.match(formatted, /\[CUSTOMER & CONVERSATION CONTEXT\]/);
  assert.match(formatted, /Customer Name: Trần Thị B/);
  assert.match(formatted, /Customer Stage: PROSPECT/);
  assert.match(formatted, /\[RECENT MESSAGES \(OLDEST TO NEWEST\)\]/);
  assert.match(formatted, /- \[CUSTOMER\]: "Cửa hàng có giao hàng tận nơi không\?"/);
  assert.match(formatted, /\[VERIFIED COMPANY KNOWLEDGE\]/);
  assert.match(formatted, /- \[POLICY\] Chính sách vận chuyển:/);
  assert.match(formatted, /\[CUSTOMER MEMORIES\]/);
  assert.match(formatted, /- \[PREFERENCE \(VERIFIED\)\] shipping_time: Khách chỉ nhận hàng vào buổi chiều sau 14h/);
});

test('Grounding System Instruction: enforces anti-hallucination and pricing authority boundaries', () => {
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /Anti-hallucination constraint/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /INSUFFICIENT_KNOWLEDGE/);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /Pricing authority boundary/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /PRICE_QUOTATION_REQUIRED/);
});

test('Grounding System Instruction: enforces answer-first, persona, and contact-request policy', () => {
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /FACEBOOK PAGE ANSWER-FIRST & DISCOVERY POLICY/);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /Never send a draft that only asks for contact details/);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /parent asking for a child/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /student\/pupil asking for themselves/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /born in 2000 or earlier/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /phone permission is YES/i);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /PAGE SCOPE POLICY/);
  assert.match(JAVIS_BRAIN_SYSTEM_INSTRUCTION, /Never mention unrelated products, other Pages/i);
});

test('Grounding Formatter: adds Facebook Page persona and contact policy block', () => {
  const base = validGrounding();
  const formatted = formatGroundingContext({
    ...base,
    conversation: {
      ...base.conversation!,
      channel: 'MESSENGER',
    },
    recentMessages: [
      {
        direction: 'INBOUND',
        actorType: 'CUSTOMER',
        content: 'Tìm hiểu cho con',
        createdAt: '2026-10-29T01:00:00.000Z',
      },
      {
        direction: 'OUTBOUND',
        actorType: 'AI',
        content: 'Dạ em hỏi thêm năm sinh và nơi ở của bé ạ.',
        createdAt: '2026-10-29T01:01:00.000Z',
      },
      {
        direction: 'INBOUND',
        actorType: 'CUSTOMER',
        content: 'Sinh năm 98, ở miền bắc',
        createdAt: '2026-10-29T01:02:00.000Z',
      },
    ],
  }, 'Sinh năm 98, ở miền bắc');

  assert.match(formatted, /\[CUSTOMER PERSONA & CONTACT POLICY\]/);
  assert.match(formatted, /PHỤ HUYNH HỎI CHO CON\/CHÁU/);
  assert.match(formatted, /AI xưng "em", gọi khách "anh\/chị"/);
  assert.match(formatted, /Được phép xin số điện thoại ở lượt này: KHÔNG/);
  assert.match(formatted, /Thông tin còn thiếu: không còn/);
});

test('Grounding Formatter: adds page scope for a named Facebook Page', () => {
  const base = validGrounding();
  const formatted = formatGroundingContext({
    ...base,
    conversation: {
      ...base.conversation!,
      channel: 'MESSENGER',
      pageName: 'Du học Đức và Học tiếng Đức CHD',
    },
  });

  assert.match(formatted, /\[PAGE SCOPE\]/);
  assert.match(formatted, /Du học Đức và Học tiếng Đức CHD/);
  assert.match(formatted, /Only discuss products\/services that belong to this Page/);
  assert.match(formatted, /Never mention unrelated products, other Pages, or other business lines/);
});

test('Grounding Formatter: does not add the Facebook Page policy to Zalo turns', () => {
  const formatted = formatGroundingContext(validGrounding(), 'Cửa hàng có giao hàng tận nơi không?');
  assert.doesNotMatch(formatted, /\[CUSTOMER PERSONA & CONTACT POLICY\]/);
});

test('E2E: JavisBrainServer receives turn with grounding and passes it to model backend', async () => {
  let capturedGrounding: BrainTurnGrounding | undefined;

  const mockBackend = {
    async generate(_text: string, options: { readonly signal: AbortSignal; readonly grounding?: BrainTurnGrounding }) {
      capturedGrounding = options.grounding;
      return {
        decision: 'RESPOND' as const,
        draft: 'Dạ đơn hàng trên 1 triệu bên em freeship, giao trong 2 giờ nội thành ạ.',
        confidence: 0.95,
      };
    },
  };

  const server = createJavisBrainServer({
    authToken: TEST_AUTH_TOKEN,
    modelBackend: mockBackend,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `https://127.0.0.1:${port}`;

  try {
    const provider = new JavisBrainProvider({
      baseUrl,
      authToken: TEST_AUTH_TOKEN,
      fetchImpl: (input, init) => {
        // Adapt HTTPS fetch test seam to local test server
        const httpUrl = String(input).replace('https:', 'http:');
        return globalThis.fetch(httpUrl, init);
      },
    });

    const testGrounding = validGrounding();
    const service = createBrainService({
      provider,
      resolveContext: async (selector) => ({
        companyId: '00000000-0000-4000-8000-000000000001',
        customerId: selector.customerId,
        conversationId: selector.conversationId,
        channel: 'ZALO',
        modality: 'TEXT',
        caller: { actorId: '00000000-0000-4000-8000-000000000099', actorType: 'WORKLOAD' },
        permissionProfile: 'READ_ONLY',
        conversationState: 'AI_ACTIVE',
        allowDrafts: true,
        deliveryMode: 'LIVE_SEND',
        traceId: randomUUID(),
        grounding: testGrounding,
      }),
    });

    const turnResult = await service.handleBrainTurn({
      customerId: '00000000-0000-4000-8000-000000000001',
      conversationId: '00000000-0000-4000-8000-000000000002',
      channel: 'ZALO',
      modality: 'TEXT',
      input: { text: 'Ship Cầu Giấy có nhanh không shop?' },
    });

    assert.equal(turnResult.decision, 'RESPOND');
    assert.match(turnResult.draft || '', /freeship/);
    assert.ok(capturedGrounding);
    assert.equal(capturedGrounding.customer?.name, 'Trần Thị B');
    assert.equal(capturedGrounding.knowledge[0].title, 'Chính sách vận chuyển');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
