import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  processDueLiveDeliveries,
  LIVE_DELIVERY_WORKLOAD_ACTOR_ID,
  MESSENGER_FALLBACK_REPLY,
  MESSENGER_PHONE_RECEIVED_REPLY,
  messageContainsCustomerPhone,
  type LiveDeliveryClaim,
  type LiveDeliveryTransport,
  type LiveDeliverySendParams,
  type LiveDeliverySendOutcome,
} from '../../features/ai-brain/live-delivery';
import { cleanCustomerReply, hasInternalLeak } from '../../features/ai-brain/validation';
import type { BrainProvider, BrainTurnRequest, BrainProposal } from '../../features/ai-brain/contracts';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID_ZALO = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID_FB = '77777777-7777-4777-8777-777777777777';
const INTERACTION_ID_ZALO = '44444444-4444-4444-8444-444444444444';
const INTERACTION_ID_FB = '88888888-8888-4888-8888-888888888888';
const CLAIM_ID_ZALO = '55555555-5555-4555-8555-555555555555';
const CLAIM_ID_FB = '99999999-9999-4999-8999-999999999999';

interface MockDbConfig {
  claims?: LiveDeliveryClaim[];
  messengerSettingEnabled?: boolean;
  zaloSettingEnabled?: boolean;
  preSendMessengerEnabled?: boolean;
  canaryMessengerEnabled?: boolean;
  preSendCanaryMessengerEnabled?: boolean;
  convFbStatus?: string;
  convFbAssignedTo?: string | null;
  convFbAiMode?: string;
  convZaloStatus?: string;
  handoverRpcError?: Error | null;
  inboundFbContent?: string;
}

function createMockEngineSupabase(config: MockDbConfig = {}) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const channelQueryCounts: Record<string, number> = {};
  let canaryQueryCount = 0;

  const defaultClaims: LiveDeliveryClaim[] = config.claims ?? [
    {
      id: CLAIM_ID_ZALO,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: CONVERSATION_ID_ZALO,
      source_interaction_id: INTERACTION_ID_ZALO,
      channel: 'ZALO',
      attempts: 1,
    },
    {
      id: CLAIM_ID_FB,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: CONVERSATION_ID_FB,
      source_interaction_id: INTERACTION_ID_FB,
      channel: 'MESSENGER',
      attempts: 1,
    },
  ];

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
        async maybeSingle() {
          if (table === 'ai_brain_live_settings') {
            const channel = filters.channel as string;
            channelQueryCounts[channel] = (channelQueryCounts[channel] || 0) + 1;
            const isPreSend = channelQueryCounts[channel] > 1;

            if (channel === 'ZALO') {
              const enabled = config.zaloSettingEnabled !== false;
              return { data: { enabled, min_confidence: 0.8 }, error: null };
            }
            if (channel === 'MESSENGER') {
              const enabled = isPreSend
                ? (config.preSendMessengerEnabled !== false && config.messengerSettingEnabled !== false)
                : (config.messengerSettingEnabled !== false);
              return { data: { enabled, min_confidence: 0.85 }, error: null };
            }
          }

          if (table === 'ai_brain_live_canary_allowlist') {
            canaryQueryCount += 1;
            const isPreSend = canaryQueryCount > 1;
            if (config.canaryMessengerEnabled === false) {
              return { data: null, error: null };
            }
            if (isPreSend && config.preSendCanaryMessengerEnabled === false) {
              return { data: null, error: null };
            }
            return {
              data: {
                id: 'canary-fb-1',
                company_id: COMPANY_ID,
                channel: 'MESSENGER',
                conversation_id: CONVERSATION_ID_FB,
                page_id: '100000000000001',
                enabled: true,
              },
              error: null,
            };
          }

          if (table === 'conversations') {
            const id = filters.id as string;
            if (id === CONVERSATION_ID_ZALO) {
              return {
                data: {
                  id: CONVERSATION_ID_ZALO,
                  company_id: COMPANY_ID,
                  customer_id: CUSTOMER_ID,
                  channel: 'ZALO',
                  status: config.convZaloStatus ?? 'OPEN',
                  assigned_to: null,
                  ai_mode: 'ACTIVE',
                  external_conversation_id: 'oa_user_1',
                },
                error: null,
              };
            }
            if (id === CONVERSATION_ID_FB) {
              return {
                data: {
                  id: CONVERSATION_ID_FB,
                  company_id: COMPANY_ID,
                  customer_id: CUSTOMER_ID,
                  channel: 'FACEBOOK',
                  status: config.convFbStatus ?? 'OPEN',
                  assigned_to: config.convFbAssignedTo ?? null,
                  ai_mode: config.convFbAiMode ?? 'ACTIVE',
                  external_conversation_id: '100000000000001:200000000000002',
                },
                error: null,
              };
            }
          }

          if (table === 'interactions') {
            const id = filters.id as string;
            if (id === INTERACTION_ID_ZALO) {
              return {
                data: {
                  id: INTERACTION_ID_ZALO,
                  company_id: COMPANY_ID,
                  customer_id: CUSTOMER_ID,
                  conversation_id: CONVERSATION_ID_ZALO,
                  channel: 'ZALO',
                  type: 'MESSAGE',
                  direction: 'INBOUND',
                  actor_type: 'CUSTOMER',
                  sanitization_status: 'SUCCEEDED',
                  sanitized_content: 'Chào shop tư vấn Zalo',
                },
                error: null,
              };
            }
            if (id === INTERACTION_ID_FB) {
              return {
                data: {
                  id: INTERACTION_ID_FB,
                  company_id: COMPANY_ID,
                  customer_id: CUSTOMER_ID,
                  conversation_id: CONVERSATION_ID_FB,
                  channel: 'FACEBOOK',
                  type: 'MESSAGE',
                  direction: 'INBOUND',
                  actor_type: 'CUSTOMER',
                  sanitization_status: 'SUCCEEDED',
                  sanitized_content: config.inboundFbContent ?? 'Chào shop tư vấn Messenger',
                },
                error: null,
              };
            }
          }

          return { data: null, error: null };
        },
      };
      return builder;
    },
    async rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params });
      if (name === 'ai_brain_live_zalo_is_eligible') return { data: true, error: null };
      if (name === 'claim_ai_brain_live_deliveries') {
        return { data: defaultClaims, error: null };
      }
      if (name === 'finish_ai_brain_live_delivery' || name === 'finish_ai_brain_live_delivery_extended') {
        return { data: true, error: null };
      }
      if (name === 'create_ai_handover_case') {
        if (config.handoverRpcError) throw config.handoverRpcError;
        return { data: '55555555-5555-4555-8555-555555555555', error: null };
      }
      throw new Error(`Unexpected mock RPC: ${name}`);
    },
  };

  return client as unknown as SupabaseClient & { rpcCalls: typeof rpcCalls };
}

class MockTransport implements LiveDeliveryTransport {
  public sendCalls: LiveDeliverySendParams[] = [];
  constructor(
    public readonly channel: 'ZALO' | 'MESSENGER',
    private readonly outcomeOverride?: LiveDeliverySendOutcome
  ) {}

  async sendReply(params: LiveDeliverySendParams): Promise<LiveDeliverySendOutcome> {
    this.sendCalls.push(params);
    if (this.outcomeOverride) return this.outcomeOverride;
    return {
      outcome: 'SENT',
      externalMessageId: `ext-${this.channel}-${params.claim.id.slice(0, 8)}`,
    };
  }
}

function createMockProvider(proposal: Partial<BrainProposal> = {}): BrainProvider {
  return {
    descriptor: { id: 'test-javis-provider', model: 'javis-router-v1' },
    async runTurn(_request: BrainTurnRequest): Promise<BrainProposal> {
      const decision = proposal.decision ?? 'RESPOND';
      return {
        decision,
        draft: decision === 'RESPOND' ? (proposal.draft ?? 'Dạ em chào anh/chị, em là AI hỗ trợ.') : undefined,
        confidence: proposal.confidence ?? 0.95,
        handoverReason: decision === 'HANDOVER' ? (proposal.handoverReason ?? 'CUSTOMER_REQUESTED_HUMAN') : undefined,
        toolsUsed: [],
        memoryReferences: [],
        sourceReferences: [],
      };
    },
  };
}

test('Generic Engine: claims both ZALO and MESSENGER and routes to their respective transports', async () => {
  const mockDb = createMockEngineSupabase();
  const zaloTransport = new MockTransport('ZALO');
  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider();

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: {
      ZALO: zaloTransport,
      MESSENGER: messengerTransport,
    },
  });

  assert.equal(result.claimed, 2);
  assert.equal(result.sent, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);

  // Assert Zalo transport received Zalo delivery
  assert.equal(zaloTransport.sendCalls.length, 1);
  assert.equal(zaloTransport.sendCalls[0].claim.channel, 'ZALO');
  assert.equal(zaloTransport.sendCalls[0].claim.id, CLAIM_ID_ZALO);

  // Assert Messenger transport received Messenger delivery
  assert.equal(messengerTransport.sendCalls.length, 1);
  assert.equal(messengerTransport.sendCalls[0].claim.channel, 'MESSENGER');
  assert.equal(messengerTransport.sendCalls[0].claim.id, CLAIM_ID_FB);
});

test('Generic Engine: passes channel filter to claim_ai_brain_live_deliveries when specified', async () => {
  const mockDb = createMockEngineSupabase({ claims: [] });
  const messengerTransport = new MockTransport('MESSENGER');

  await processDueLiveDeliveries(5, {
    supabase: mockDb,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(mockDb.rpcCalls.length, 1);
  assert.equal(mockDb.rpcCalls[0].name, 'claim_ai_brain_live_deliveries');
  assert.equal(mockDb.rpcCalls[0].params.p_channel, 'MESSENGER');
});

test('Generic Engine: Messenger pre-send kill switch halts delivery without calling transport', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    preSendMessengerEnabled: false, // Kill switch engaged right before sending!
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider();

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(messengerTransport.sendCalls.length, 0);

  // Assert finish was called with KILL_SWITCH_ENGAGED
  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall.params.p_error_code, 'KILL_SWITCH_ENGAGED');
});

test('Generic Engine: Messenger pre-send canary restriction halts delivery without calling transport', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    preSendCanaryMessengerEnabled: false, // Canary revoked right before send!
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider();

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(messengerTransport.sendCalls.length, 0);

  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall.params.p_error_code, 'CANARY_RESTRICTED');
});

test('Generic Engine: Messenger conversation in PENDING_SALE status is processed and auto-replied (remove pending sale gate)', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    convFbStatus: 'PENDING_SALE', // PENDING_SALE must NOT block Messenger AI auto-reply
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider();

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 0);
  assert.equal(messengerTransport.sendCalls.length, 1);
  assert.equal(messengerTransport.sendCalls[0].claim.channel, 'MESSENGER');
});

test('Generic Engine: Zalo conversation in PENDING_SALE status remains skipped (preserves Zalo SLA gate)', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_ZALO,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_ZALO,
        source_interaction_id: INTERACTION_ID_ZALO,
        channel: 'ZALO',
        attempts: 1,
      },
    ],
    convZaloStatus: 'PENDING_SALE', // PENDING_SALE must STILL block Zalo
  });

  const zaloTransport = new MockTransport('ZALO');
  const mockProvider = createMockProvider();

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { ZALO: zaloTransport },
    channel: 'ZALO',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(zaloTransport.sendCalls.length, 0);
});

test('Generic Engine: Human ownership on Messenger conversation halts delivery', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    convFbAssignedTo: '00000000-0000-4000-8000-000000000001', // Assigned to human agent!
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider();

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(messengerTransport.sendCalls.length, 0);
});

test('Generic Engine: Handover on Messenger creates handover case and sends fallback reply', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider({
    decision: 'HANDOVER',
    handoverReason: 'CUSTOMER_REQUESTED_HUMAN',
    confidence: 0.9,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 0);
  assert.equal(messengerTransport.sendCalls.length, 1);
  assert.equal(messengerTransport.sendCalls[0].draft, MESSENGER_FALLBACK_REPLY);

  const handoverCall = mockDb.rpcCalls.find((c) => c.name === 'create_ai_handover_case');
  assert.ok(handoverCall);
  assert.equal(handoverCall.params.p_reason, 'CUSTOMER_REQUESTED_HUMAN');
});

test('Generic Engine: Handover on Zalo creates handover case and skips send (Zalo safety preserved)', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_ZALO,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_ZALO,
        source_interaction_id: INTERACTION_ID_ZALO,
        channel: 'ZALO',
        attempts: 1,
      },
    ],
  });

  const zaloTransport = new MockTransport('ZALO');
  const mockProvider = createMockProvider({
    decision: 'HANDOVER',
    handoverReason: 'CUSTOMER_REQUESTED_HUMAN',
    confidence: 0.9,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { ZALO: zaloTransport },
    channel: 'ZALO',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(zaloTransport.sendCalls.length, 0);
});

test('Generic Engine: Handover case creation failure fails closed and records visible error', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    handoverRpcError: new Error('HANDOVER_RPC_TIMEOUT'),
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider({
    decision: 'HANDOVER',
    handoverReason: 'COMPLAINT_OR_NEGATIVE_FEEDBACK',
    confidence: 0.88,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(messengerTransport.sendCalls.length, 0);

  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'FAILED');
  assert.equal(finishCall.params.p_error_code, 'HANDOVER_CASE_CREATION_FAILED');
});

test('Generic Engine: persists actual Brain latency_ms and preserves MID on OUTBOUND_PERSISTENCE_FAILED', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
  });

  const messengerTransport = new MockTransport('MESSENGER', {
    outcome: 'FAILED',
    errorCode: 'OUTBOUND_PERSISTENCE_FAILED',
    externalMessageId: 'mid.prov-success-record-failed',
  });
  const mockProvider = createMockProvider({
    decision: 'RESPOND',
    draft: 'Dạ em chào anh, đây là phản hồi tự động.',
    confidence: 0.95,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);

  // Verify transport received lockToken and turnConfidence
  assert.equal(messengerTransport.sendCalls.length, 1);
  assert.ok(messengerTransport.sendCalls[0].lockToken);
  assert.equal(messengerTransport.sendCalls[0].turnConfidence, 0.95);

  // Verify finish_ai_brain_live_delivery received brain latency and preserved MID
  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'FAILED');
  assert.equal(finishCall.params.p_error_code, 'OUTBOUND_PERSISTENCE_FAILED');
  assert.equal(finishCall.params.p_external_message_id, 'mid.prov-success-record-failed');
  assert.equal(typeof finishCall.params.p_brain_latency_ms, 'number');
  assert.ok((finishCall.params.p_brain_latency_ms as number) >= 0);
});

test('Phone Intake Fast Path: Messenger replies immediately with confirmation when customer provides phone number without invoking provider', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'Dạ sđt của em là [số điện thoại đã ẩn] ạ',
  });

  const messengerTransport = new MockTransport('MESSENGER', {
    outcome: 'SENT',
    externalMessageId: 'mid.fast-path-phone',
  });

  let providerCalls = 0;
  const mockProvider: BrainProvider = {
    descriptor: { id: 'test-provider', model: 'test-model' },
    async runTurn() {
      providerCalls++;
      return {
        decision: 'RESPOND',
        draft: 'Should not be called',
        confidence: 0.9,
      };
    },
  };

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);

  // Provider was NOT called (0 ms latency, instant dispatch)
  assert.equal(providerCalls, 0);

  // Transport received exact confirmation template
  assert.equal(messengerTransport.sendCalls.length, 1);
  assert.equal(messengerTransport.sendCalls[0].draft, MESSENGER_PHONE_RECEIVED_REPLY);
  assert.equal(messengerTransport.sendCalls[0].turnConfidence, 1.0);

  // Finish RPC recorded with RESPOND, 1.0 confidence, and 0 latency
  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'SENT');
  assert.equal(finishCall.params.p_decision, 'RESPOND');
  assert.equal(finishCall.params.p_confidence, 1.0);
  assert.equal(finishCall.params.p_brain_latency_ms, 0);
});

test('Lead Form Silence: Messenger pre-filled lead form is skipped without provider or transport calls', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: [
      'Đã điền mẫu',
      'Phone number: [số điện thoại đã ẩn]',
      'Date of birth: 15/05/2001',
      'Email: [email đã ẩn]',
      'Full name: Lan Pham',
      'GPA: 8.5',
      'City: Hà Nội',
    ].join('\n'),
  });

  const messengerTransport = new MockTransport('MESSENGER', {
    outcome: 'SENT',
    externalMessageId: 'mid.lead-form-must-not-send',
  });

  let providerCalls = 0;
  const mockProvider: BrainProvider = {
    descriptor: { id: 'test-provider', model: 'test-model' },
    async runTurn() {
      providerCalls++;
      return {
        decision: 'RESPOND',
        draft: 'Should not be called',
        confidence: 0.9,
      };
    },
  };

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.equal(providerCalls, 0);
  assert.equal(messengerTransport.sendCalls.length, 0);

  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall.params.p_decision, 'NO_REPLY');
  assert.equal(finishCall.params.p_error_code, 'LEAD_FORM_NO_REPLY');
});

test('Reasoning Leak Suppression: strips internal chain-of-thought and sends only customer-facing message', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'Tư vấn du học Đức giúp mình',
  });

  const messengerTransport = new MockTransport('MESSENGER', {
    outcome: 'SENT',
    externalMessageId: 'mid.clean-reply',
  });

  const rawLeakedDraft = `Dựa trên yêu cầu của khách hàng Lan Pham và quy tắc tư vấn từ playbook, tôi xin đưa ra quyết định xử lý như sau.

- Khách hàng mới gửi yêu cầu tư vấn chung chung.
- Theo quy định, yêu cầu tư vấn chung không phải là chuyển giao cho người thật ngay, mà là phản hồi bằng câu hỏi làm rõ hoặc xin thông tin theo kịch bản.

Bạn có thể gửi phản hồi mẫu cho khách hàng:
Dạ em chào anh/chị, em hỗ trợ tư vấn cho mình nhé. Anh/chị cho em xin số điện thoại liên hệ để chuyên viên bên em hỗ trợ chi tiết hơn cho mình ạ.`;

  const mockProvider = createMockProvider({
    decision: 'RESPOND',
    draft: rawLeakedDraft,
    confidence: 0.9,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);

  // Transport received ONLY the cleaned customer-facing message. The premature
  // phone request is removed because discovery has not started yet.
  assert.equal(messengerTransport.sendCalls.length, 1);
  assert.equal(
    messengerTransport.sendCalls[0].draft,
    'Dạ em chào anh/chị, em hỗ trợ tư vấn cho mình nhé.'
  );
  assert.equal(hasInternalLeak(messengerTransport.sendCalls[0].draft), false);
  assert.equal(/số\s*điện\s*thoại|sđt|sdt/iu.test(messengerTransport.sendCalls[0].draft), false);
});

test('Persistent Internal Leak: provider proposal with thought leak fails closed and never calls transport', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'Tư vấn giúp mình',
  });

  const messengerTransport = new MockTransport('MESSENGER', {
    outcome: 'SENT',
    externalMessageId: 'mid.fallback-reply',
  });

  // Pure thought without any customer-facing draft
  const pureThoughtDraft = `Dựa trên yêu cầu của khách hàng và quy tắc tư vấn từ playbook, cần chuyển giao cho người thật ngay.`;

  const mockProvider = createMockProvider({
    decision: 'RESPOND',
    draft: pureThoughtDraft,
    confidence: 0.88,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);

  // Transport was NEVER called with leaked reasoning
  assert.equal(messengerTransport.sendCalls.length, 0);

  const finishCall = mockDb.rpcCalls.find(
    (c) => c.name === 'finish_ai_brain_live_delivery_extended' || c.name === 'finish_ai_brain_live_delivery'
  );
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'FAILED');
  assert.equal(finishCall.params.p_error_code, 'BRAIN_PROVIDER_ERROR');
});

test('Persona Style: parent handover fallback keeps em/anh-chị pronouns', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'Tìm hiểu cho con',
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider({
    decision: 'HANDOVER',
    handoverReason: 'CUSTOMER_REQUESTED_HUMAN',
    confidence: 0.9,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.sent, 1);
  assert.equal(messengerTransport.sendCalls[0].draft, MESSENGER_FALLBACK_REPLY);
  assert.match(messengerTransport.sendCalls[0].draft, /anh\/chị/);
});

test('Persona Style: student handover fallback uses ad/em pronouns', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'Em là sinh viên, tư vấn cho em ạ',
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider({
    decision: 'HANDOVER',
    handoverReason: 'CUSTOMER_REQUESTED_HUMAN',
    confidence: 0.9,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.sent, 1);
  const draft = messengerTransport.sendCalls[0].draft;
  assert.match(draft, /^Dạ ad/);
  assert.match(draft, /câu hỏi của em/);
  assert.doesNotMatch(draft, /anh\/chị/);
});

test('Identity Guard: a robot question gets the human Page salesperson answer', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'Tôi muốn biết bạn là ai? Vì tôi không trò chuyện với robot???',
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider({
    decision: 'RESPOND',
    draft: 'Dạ, em là trợ lý tư vấn của hệ thống ạ. Anh/chị cần tư vấn gì ạ?',
    confidence: 0.9,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.sent, 1);
  const draft = messengerTransport.sendCalls[0].draft;
  assert.equal(draft, 'Dạ, em là sale trực page của công ty ạ.');
  assert.doesNotMatch(draft, /trợ\s*lý|robot|chatbot|\bAI\b|hệ\s*thống/iu);
});

test('Contact Policy: strips a premature phone request but preserves the answer', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'Điều kiện du học Đức thế nào ạ?',
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider({
    decision: 'RESPOND',
    draft: 'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1. Anh/chị cho em xin sđt nhé.',
    confidence: 0.95,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.sent, 1);
  assert.equal(
    messengerTransport.sendCalls[0].draft,
    'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1.',
  );
});

test('Contact Policy: replaces a phone-only draft with a non-phone fallback', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'Tư vấn du học Đức giúp mình',
  });

  const messengerTransport = new MockTransport('MESSENGER');
  const mockProvider = createMockProvider({
    decision: 'RESPOND',
    draft: 'Dạ, để em hỗ trợ tư vấn chi tiết về điều kiện, anh/chị cho em xin số điện thoại liên hệ nhé ạ!',
    confidence: 0.95,
  });

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(result.sent, 1);
  assert.equal(messengerTransport.sendCalls[0].draft, MESSENGER_FALLBACK_REPLY);
  assert.equal(/số\s*điện\s*thoại|sđt|sdt/iu.test(messengerTransport.sendCalls[0].draft), false);
});

test('Phone Fast Path: a phone message with a question goes to the model so the question is answered', async () => {
  const mockDb = createMockEngineSupabase({
    claims: [
      {
        id: CLAIM_ID_FB,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID_FB,
        source_interaction_id: INTERACTION_ID_FB,
        channel: 'MESSENGER',
        attempts: 1,
      },
    ],
    inboundFbContent: 'SĐT 0912345678, cho mình hỏi học phí bao nhiêu ạ?',
  });

  const messengerTransport = new MockTransport('MESSENGER');
  let providerCalls = 0;
  const mockProvider: BrainProvider = {
    descriptor: { id: 'test-provider', model: 'test-model' },
    async runTurn() {
      providerCalls++;
      return {
        decision: 'RESPOND',
        draft: 'Học phí phụ thuộc vào trường và ngành, anh/chị đang quan tâm ngành nào ạ?',
        confidence: 0.95,
      };
    },
  };

  const result = await processDueLiveDeliveries(5, {
    supabase: mockDb,
    provider: mockProvider,
    transports: { MESSENGER: messengerTransport },
    channel: 'MESSENGER',
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.sent, 1);
  assert.equal(
    messengerTransport.sendCalls[0].draft,
    'Học phí phụ thuộc vào trường và ngành, anh/chị đang quan tâm ngành nào ạ?',
  );
});

test('Helper functions: messageContainsCustomerPhone and cleanCustomerReply', () => {
  // Phone detection tests
  assert.equal(messageContainsCustomerPhone('[số điện thoại đã ẩn]'), true);
  assert.equal(messageContainsCustomerPhone('Phone number: [số điện thoại đã ẩn]'), true);
  assert.equal(messageContainsCustomerPhone('Sđt của mình là 0912345678 nhé'), true);
  assert.equal(messageContainsCustomerPhone('0988 123 456'), true);
  assert.equal(messageContainsCustomerPhone('+84912345678'), true);
  assert.equal(messageContainsCustomerPhone('Học phí bên mình bao nhiêu?'), false);
  assert.equal(messageContainsCustomerPhone('Mình sinh năm 2004, ở Hà Nội'), false);

  // Clean reply tests
  const withPreamble = `Dựa trên yêu cầu của khách hàng Huệ Nguyễn về việc tư vấn du học Đức và quy trình cần thu thập số điện thoại, bạn có thể gửi phản hồi trực tiếp cho khách hàng như sau:

Dạ em chào anh/chị Huệ Nguyễn ạ. Anh/chị vui lòng cho em xin số điện thoại liên hệ nhé.`;
  assert.equal(
    cleanCustomerReply(withPreamble),
    'Dạ em chào anh/chị Huệ Nguyễn ạ. Anh/chị vui lòng cho em xin số điện thoại liên hệ nhé.'
  );

  const cleanAlready = 'Dạ em chào anh/chị, em hỗ trợ tư vấn cho mình nhé ạ.';
  assert.equal(cleanCustomerReply(cleanAlready), cleanAlready);
});
