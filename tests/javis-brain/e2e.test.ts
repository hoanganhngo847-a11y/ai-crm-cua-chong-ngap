import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import {
  createBrainService,
  JavisBrainProvider,
  type BrainContextResolver,
  type BrainProposal,
  type BrainTurnRequest,
  type JavisFetch,
} from '../../features/ai-brain';
import { createJavisBrainServer } from '../../services/javis-brain/server';
import type { ModelBackend } from '../../services/javis-brain/types';

const TEST_TOKEN = 'test_token_12345678901234567890123456789012';
const LOGICAL_HTTPS_BASE = 'https://javis.internal.example';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const TRACE_ID = '55555555-5555-4555-8555-555555555555';

class E2EModelBackend implements ModelBackend {
  public nextProposal: BrainProposal = {
    decision: 'RESPOND',
    draft: 'Chào bạn, cửa hàng chúng tôi mở cửa từ 8h đến 21h hàng ngày.',
    confidence: 0.94,
  };
  public shouldFail = false;

  async generate(): Promise<BrainProposal> {
    if (this.shouldFail) {
      throw new Error('BACKEND_UNAVAILABLE');
    }
    return this.nextProposal;
  }
}

interface E2EHarness {
  readonly server: http.Server;
  readonly port: number;
  readonly backend: E2EModelBackend;
  readonly provider: JavisBrainProvider;
  close(): Promise<void>;
}

/**
 * Sets up a real HTTP server on an ephemeral loopback socket (127.0.0.1).
 *
 * Test Seam Explanation:
 * JavisBrainProvider in features/ai-brain/javis-provider.ts strictly enforces that baseUrl
 * has 'https:' protocol to guarantee transport security in production.
 * To test the actual HTTP socket, framing, serialization, and networking without
 * altering production code or generating local self-signed certificates, fetchImpl
 * maps the logical HTTPS origin (https://javis.internal.example/...) directly to the real
 * loopback socket (http://127.0.0.1:<port>/...).
 */
async function startE2EHarness(): Promise<E2EHarness> {
  const backend = new E2EModelBackend();
  const server = createJavisBrainServer({
    authToken: TEST_TOKEN,
    modelBackend: backend,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as { port: number };
  const port = address.port;

  const fetchImpl: JavisFetch = async (input, init) => {
    const originalUrl = new URL(String(input));
    const loopbackUrl = new URL(originalUrl.pathname + originalUrl.search, `http://127.0.0.1:${port}`);
    return fetch(loopbackUrl, init);
  };

  const provider = new JavisBrainProvider({
    baseUrl: LOGICAL_HTTPS_BASE,
    authToken: TEST_TOKEN,
    fetchImpl,
  });

  return {
    server,
    port,
    backend,
    provider,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function createResolver(overrides?: Record<string, unknown>): BrainContextResolver {
  return async (selector) => {
    const base = {
      ...selector,
      companyId: COMPANY_ID,
      caller: { actorId: ACTOR_ID, actorType: 'WORKLOAD' as const },
      permissionProfile: 'READ_ONLY' as const,
      conversationState: 'AI_ACTIVE' as const,
      allowDrafts: true,
      traceId: TRACE_ID,
    };
    return Object.assign({}, base, overrides);
  };
}

test('E2E: JavisBrainProvider checkHealth hits real HTTP socket and returns readiness', async () => {
  const harness = await startE2EHarness();
  try {
    const health = await harness.provider.checkHealth({ signal: new AbortController().signal });
    assert.deepEqual(health, {
      ok: true,
      service: 'javis-brain',
      version: 'v1',
    });
    assert.ok(Object.isFrozen(health));
  } finally {
    await harness.close();
  }
});

test('E2E: createBrainService + JavisBrainProvider + real HTTP server: RESPOND yields DRAFT_ONLY', async () => {
  const harness = await startE2EHarness();
  try {
    harness.backend.nextProposal = {
      decision: 'RESPOND',
      draft: 'Chào bạn, cửa hàng chúng tôi mở cửa từ 8h đến 21h hàng ngày.',
      confidence: 0.94,
    };

    const resolver = createResolver();
    const service = createBrainService({
      resolveContext: resolver,
      provider: harness.provider,
    });

    const result = await service.handleBrainTurn({
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION_ID,
      channel: 'MESSENGER',
      modality: 'TEXT',
      input: { text: 'Cửa hàng mình mở cửa lúc mấy giờ ạ?' },
    });

    assert.equal(result.version, 'v1');
    assert.equal(result.decision, 'RESPOND');
    assert.equal(result.delivery, 'DRAFT_ONLY');
    assert.equal(result.draft, harness.backend.nextProposal.draft);
    assert.equal(result.confidence, 0.94);
    assert.equal(result.handoverRequired, false);
    assert.equal(result.provider, 'javis-brain-service');
    assert.equal(result.model, 'javis-router-v1');

    // Audit projection
    assert.equal(result.audit.companyId, COMPANY_ID);
    assert.equal(result.audit.customerId, CUSTOMER_ID);
    assert.equal(result.audit.conversationId, CONVERSATION_ID);
    assert.equal(result.audit.channel, 'MESSENGER');
    assert.equal(result.audit.decision, 'RESPOND');
    assert.equal(result.audit.handoverRequired, false);
  } finally {
    await harness.close();
  }
});

test('E2E: createBrainService + JavisBrainProvider + real HTTP server: HANDOVER yields no delivery', async () => {
  const harness = await startE2EHarness();
  try {
    harness.backend.nextProposal = {
      decision: 'HANDOVER',
      handoverReason: 'REQUIRES_MANAGER_APPROVAL',
      confidence: 0.85,
    };

    const resolver = createResolver();
    const service = createBrainService({
      resolveContext: resolver,
      provider: harness.provider,
    });

    const result = await service.handleBrainTurn({
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION_ID,
      channel: 'ZALO',
      modality: 'TEXT',
      input: { text: 'Tôi muốn yêu cầu hoàn tiền cho đơn hàng này ngay.' },
    });

    assert.equal(result.decision, 'HANDOVER');
    assert.equal(result.delivery, undefined);
    assert.equal(result.draft, undefined);
    assert.equal(result.handoverRequired, true);
    assert.equal(result.handoverReason, 'REQUIRES_MANAGER_APPROVAL');
    assert.equal(result.confidence, 0.85);
  } finally {
    await harness.close();
  }
});

test('E2E: createBrainService + JavisBrainProvider + real HTTP server: backend failure yields BRAIN_PROVIDER_ERROR', async () => {
  const harness = await startE2EHarness();
  try {
    harness.backend.shouldFail = true;

    const resolver = createResolver();
    const service = createBrainService({
      resolveContext: resolver,
      provider: harness.provider,
    });

    const result = await service.handleBrainTurn({
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION_ID,
      channel: 'MESSENGER',
      modality: 'TEXT',
      input: { text: 'Xin chào' },
    });

    assert.equal(result.decision, 'ERROR');
    assert.equal(result.errorCode, 'BRAIN_PROVIDER_ERROR');
    assert.equal(result.handoverRequired, true);
    assert.equal(result.delivery, undefined);
    assert.equal(result.draft, undefined);
  } finally {
    await harness.close();
  }
});

test('Static Security Audit: zero messaging/database/outbound imports in services/javis-brain', () => {
  const serviceDir = path.resolve(__dirname, '../../services/javis-brain');
  const files = fs.readdirSync(serviceDir).filter((f) => f.endsWith('.ts'));

  assert.ok(files.length >= 4, 'Must have at least 4 source files in services/javis-brain');

  const forbiddenImportPatterns = [
    /@supabase/,
    /supabase-js/,
    /from ['"]pg['"]/,
    /from ['"]postgres['"]/,
    /from ['"]\..*database/,
    /from ['"]\..*crm/,
    /from ['"]\..*inbox/,
    /from ['"]\..*zalo-recordings/,
    /from ['"]\..*summary-provider/,
    /from ['"]\..*stringee/,
    /from ['"]\..*meta_messenger/,
  ];

  for (const file of files) {
    const content = fs.readFileSync(path.join(serviceDir, file), 'utf8');

    for (const pattern of forbiddenImportPatterns) {
      assert.ok(
        !pattern.test(content),
        `Forbidden import pattern ${pattern} detected in ${file}`
      );
    }
  }
});
