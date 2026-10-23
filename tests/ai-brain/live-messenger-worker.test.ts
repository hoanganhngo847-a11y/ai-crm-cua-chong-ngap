import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { processDueLiveDeliveries } from '../../features/ai-brain/live-delivery';
import { MessengerDeliveryTransport } from '../../features/ai-brain/live-delivery/transports/messenger-transport';
import type { BrainProvider, BrainTurnRequest, BrainProposal } from '../../features/ai-brain/contracts';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const INTERACTION_ID = '44444444-4444-4444-8444-444444444444';
const CLAIM_ID = '55555555-5555-4555-8555-555555555555';
const PAGE_ID = '1234567890';
const PSID = '9876543210';

interface MockWorkerDbConfig {
  settingEnabled?: boolean;
  minConfidence?: number;
  convStatus?: string;
  assignedTo?: string | null;
  aiMode?: string;
  dispatchResult?: { status: 'SENT' | 'FAILED' | 'UNKNOWN'; mid: string | null };
}

function createMockMessengerWorkerSupabase(config: MockWorkerDbConfig = {}) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  let currentLockToken: string | null = null;

  const defaultClaim = {
    id: CLAIM_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    source_interaction_id: INTERACTION_ID,
    channel: 'MESSENGER',
    attempts: 1,
  };

  const client = {
    rpcCalls,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select(_fields: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        order(_col: string, _opts: unknown) {
          return builder;
        },
        limit(_count: number) {
          return builder;
        },
        async maybeSingle() {
          if (table === 'ai_brain_live_settings') {
            return {
              data: {
                enabled: config.settingEnabled !== false,
                min_confidence: config.minConfidence ?? 0.85,
              },
              error: null,
            };
          }

          if (table === 'conversations') {
            return {
              data: {
                id: CONVERSATION_ID,
                company_id: COMPANY_ID,
                customer_id: CUSTOMER_ID,
                channel: 'FACEBOOK',
                status: config.convStatus ?? 'OPEN',
                assigned_to: config.assignedTo ?? null,
                ai_mode: config.aiMode ?? 'ACTIVE',
                external_conversation_id: `${PAGE_ID}:${PSID}`,
              },
              error: null,
            };
          }

          if (table === 'interactions') {
            return {
              data: {
                id: INTERACTION_ID,
                company_id: COMPANY_ID,
                customer_id: CUSTOMER_ID,
                conversation_id: CONVERSATION_ID,
                channel: 'FACEBOOK',
                type: 'MESSAGE',
                direction: 'INBOUND',
                actor_type: 'CUSTOMER',
                sanitization_status: 'SUCCEEDED',
                sanitized_content: 'Chào shop, giá bộ cửa chống ngập thế nào?',
                created_at: new Date(Date.now() - 60000).toISOString(),
              },
              error: null,
            };
          }

          if (table === 'ai_brain_live_canary_allowlist') {
            return {
              data: {
                id: 'canary-worker-1',
                company_id: COMPANY_ID,
                channel: 'MESSENGER',
                conversation_id: CONVERSATION_ID,
                page_id: PAGE_ID,
                enabled: true,
              },
              error: null,
            };
          }

          if (table === 'ai_brain_live_deliveries') {
            return {
              data: {
                id: CLAIM_ID,
                lock_token: currentLockToken,
                send_status: 'PROCESSING',
                external_message_id: null,
                dispatch_started_at: null,
              },
              error: null,
            };
          }

          return { data: null, error: null };
        },
      };
      return builder;
    },
    async rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params });
      if (name === 'claim_ai_brain_live_deliveries') {
        currentLockToken = params.p_lock_token as string;
        return { data: [defaultClaim], error: null };
      }
      if (name === 'start_ai_messenger_live_dispatch') {
        return { data: true, error: null };
      }
      if (name === 'finish_ai_brain_live_delivery' || name === 'finish_ai_brain_live_delivery_extended') {
        return { data: true, error: null };
      }
      if (name === 'record_ai_messenger_live_outbound') {
        return { data: '77777777-7777-4777-8777-777777777777', error: null };
      }
      throw new Error(`Unexpected mock RPC: ${name}`);
    },
  };

  return client as unknown as SupabaseClient & { rpcCalls: typeof rpcCalls };
}

function createTestProvider(proposal: Partial<BrainProposal> = {}): BrainProvider {
  return {
    descriptor: { id: 'test-javis-provider', model: 'javis-router-v1' },
    async runTurn(_request: BrainTurnRequest): Promise<BrainProposal> {
      const decision = proposal.decision ?? 'RESPOND';
      return {
        decision,
        draft: decision === 'RESPOND' ? (proposal.draft ?? 'Dạ chào anh, cửa chống ngập bên em bảo hành 2 năm ạ.') : undefined,
        confidence: proposal.confidence ?? 0.92,
        handoverReason: decision === 'HANDOVER' ? (proposal.handoverReason ?? 'CUSTOMER_REQUESTED_HUMAN') : undefined,
        toolsUsed: [],
        memoryReferences: [],
        sourceReferences: [],
      };
    },
  };
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.META_PAGE_ACCESS_TOKEN = 'EAABtest-token';
  process.env.META_GRAPH_VERSION = 'v21.0';
});

afterEach(() => {
  process.env = originalEnv;
});

test('Messenger worker: full end-to-end live auto-reply with Javis Brain provider', async () => {
  const mockDb = createMockMessengerWorkerSupabase();
  const dispatchCalls: unknown[] = [];

  const mockDispatch = async (input: unknown) => {
    dispatchCalls.push(input);
    return { status: 'SENT' as const, mid: 'mid.fb.123456789' };
  };

  const messengerTransport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: mockDispatch as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const provider = createTestProvider();

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);

  // Assert dispatch was called with valid parameters
  assert.equal(dispatchCalls.length, 1);

  // Assert finish was called with SENT status and externalMessageId
  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'SENT');
  assert.equal(finishCall.params.p_external_message_id, 'mid.fb.123456789');

  // Assert outbound interaction was recorded
  const recordCall = mockDb.rpcCalls.find((c) => c.name === 'record_ai_messenger_live_outbound');
  assert.ok(recordCall);
  assert.equal(recordCall.params.p_actor_type, 'AI');
});

test('Messenger worker: low confidence skips delivery and does not call transport', async () => {
  const mockDb = createMockMessengerWorkerSupabase({ minConfidence: 0.9 });
  let dispatchCalled = false;

  const messengerTransport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => {
      dispatchCalled = true;
      return { status: 'SENT', mid: 'mid.1' };
    }) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const provider = createTestProvider({ confidence: 0.82 }); // 0.82 < 0.90 -> LOW_CONFIDENCE

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(dispatchCalled, false);

  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall.params.p_error_code, 'LOW_CONFIDENCE');
});

test('Messenger worker: invalid provider proposal (empty draft) fails closed and does not call transport', async () => {
  const mockDb = createMockMessengerWorkerSupabase();
  let dispatchCalled = false;

  const messengerTransport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => {
      dispatchCalled = true;
      return { status: 'SENT', mid: 'mid.1' };
    }) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const provider = createTestProvider({ draft: '   ' }); // Whitespace only fails provider proposal validation

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 1);
  assert.equal(dispatchCalled, false);

  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'FAILED');
  assert.equal(finishCall.params.p_error_code, 'BRAIN_PROVIDER_ERROR');
});
