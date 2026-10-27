import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MessengerDeliveryTransport,
} from '../../features/ai-brain/live-delivery/transports/messenger-transport';
import type { LiveDeliveryClaim } from '../../features/ai-brain/live-delivery/contracts';
import type { PageBinding } from '../../features/omnichannel/facebook/binding';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const INTERACTION_ID = '44444444-4444-4444-8444-444444444444';
const CLAIM_ID = '55555555-5555-4555-8555-555555555555';
const LOCK_TOKEN = '77777777-7777-4777-8777-777777777777';
const PAGE_ID = '10987654321';
const RECIPIENT_PSID = '9876543210';
const DRAFT_TEXT = 'Dạ chào anh, em là trợ lý AI cửa chống ngập MDTech.';

interface MockDbOptions {
  convData?: Record<string, unknown> | null;
  convError?: Error | null;
  inboundData?: { created_at: string } | null;
  inboundError?: Error | null;
  recordRpcError?: Error | null;
  canaryAllowed?: boolean;
  deliveryData?: Record<string, unknown> | null;
  deliveryError?: Error | null;
  fenceAllowed?: boolean;
  fenceRpcError?: Error | null;
}

function createMockSupabase(options: MockDbOptions = {}) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

  const defaultConv = {
    id: CONVERSATION_ID,
    company_id: COMPANY_ID,
    channel: 'FACEBOOK',
    external_conversation_id: `${PAGE_ID}:${RECIPIENT_PSID}`,
  };

  const defaultInbound = {
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 mins ago (well within 24h)
  };

  const defaultDelivery = {
    id: CLAIM_ID,
    lock_token: LOCK_TOKEN,
    send_status: 'PROCESSING',
    external_message_id: null,
    dispatch_started_at: null,
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
          if (table === 'conversations') {
            if (options.convError) return { data: null, error: options.convError };
            if (options.convData !== undefined) return { data: options.convData, error: null };
            return { data: defaultConv, error: null };
          }
          if (table === 'interactions') {
            if (options.inboundError) return { data: null, error: options.inboundError };
            if (options.inboundData !== undefined) return { data: options.inboundData, error: null };
            return { data: defaultInbound, error: null };
          }
          if (table === 'ai_brain_live_canary_allowlist') {
            if (options.canaryAllowed === false) return { data: null, error: null };
            return {
              data: {
                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
            if (options.deliveryError) return { data: null, error: options.deliveryError };
            if (options.deliveryData !== undefined) return { data: options.deliveryData, error: null };
            return { data: defaultDelivery, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
    async rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params });
      if (name === 'start_ai_messenger_live_dispatch') {
        if (options.fenceRpcError) return { data: null, error: options.fenceRpcError };
        if (options.fenceAllowed === false) return { data: false, error: null };
        return { data: true, error: null };
      }
      if (name === 'record_ai_messenger_live_outbound') {
        if (options.recordRpcError) return { data: null, error: options.recordRpcError };
        return { data: '66666666-6666-4666-8666-666666666666', error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };

  return client as unknown as SupabaseClient & { rpcCalls: typeof rpcCalls };
}

const defaultClaim: LiveDeliveryClaim = {
  id: CLAIM_ID,
  company_id: COMPANY_ID,
  customer_id: CUSTOMER_ID,
  conversation_id: CONVERSATION_ID,
  source_interaction_id: INTERACTION_ID,
  channel: 'MESSENGER',
  attempts: 1,
};

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.META_PAGE_ACCESS_TOKEN = 'EAABtest-page-access-token';
  process.env.META_GRAPH_VERSION = 'v21.0';
});

afterEach(() => {
  process.env = originalEnv;
});

test('Messenger transport: successfully sends reply with atomic dispatch-start fence and records outbound interaction', async () => {
  const mockDb = createMockSupabase();
  const dispatchCalls: unknown[] = [];

  const mockDispatch = async (input: unknown) => {
    dispatchCalls.push(input);
    return { status: 'SENT' as const, mid: 'mid.123456789' };
  };

  const transport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: mockDispatch as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'SENT');
  assert.equal(result.externalMessageId, 'mid.123456789');

  // Verify dispatch parameters
  assert.equal(dispatchCalls.length, 1);
  assert.deepEqual(dispatchCalls[0], {
    page: PAGE_ID,
    recipient: RECIPIENT_PSID,
    version: 'v21.0',
    token: 'EAABtest-page-access-token',
    content: DRAFT_TEXT,
  });

  // Verify atomic dispatch fence RPC was called BEFORE recording outbound
  assert.equal(mockDb.rpcCalls.length, 2);
  assert.equal(mockDb.rpcCalls[0].name, 'start_ai_messenger_live_dispatch');
  assert.deepEqual(mockDb.rpcCalls[0].params, {
    p_delivery_id: CLAIM_ID,
    p_lock_token: LOCK_TOKEN,
    p_company_id: COMPANY_ID,
    p_customer_id: CUSTOMER_ID,
    p_conversation_id: CONVERSATION_ID,
    p_source_interaction_id: INTERACTION_ID,
    p_page_id: PAGE_ID,
    p_min_confidence: 0.85,
    p_turn_confidence: null,
  });

  // Verify timeline interaction was recorded via record_ai_messenger_live_outbound RPC
  assert.equal(mockDb.rpcCalls[1].name, 'record_ai_messenger_live_outbound');
  assert.deepEqual(mockDb.rpcCalls[1].params, {
    p_company_id: COMPANY_ID,
    p_customer_id: CUSTOMER_ID,
    p_conversation_id: CONVERSATION_ID,
    p_source_interaction_id: INTERACTION_ID,
    p_delivery_id: CLAIM_ID,
    p_external_ref: `meta:${PAGE_ID}:mid.123456789`,
    p_content: DRAFT_TEXT,
    p_actor_type: 'AI',
  });
});

test('Messenger transport: recovers page and recipient from conversation metadata', async () => {
  const mockDb = createMockSupabase({
    convData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'customer-uuid-not-canonical',
      metadata: { provider: 'botcake', page_id: PAGE_ID, sender_id: RECIPIENT_PSID },
    },
  });
  const dispatchCalls: unknown[] = [];

  const transport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async (input: unknown) => {
      dispatchCalls.push(input);
      return { status: 'SENT' as const, mid: 'mid.metadata.1' };
    }) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'SENT');
  assert.deepEqual(dispatchCalls[0], {
    page: PAGE_ID,
    recipient: RECIPIENT_PSID,
    version: 'v21.0',
    token: 'EAABtest-page-access-token',
    content: DRAFT_TEXT,
  });
  assert.equal(mockDb.rpcCalls[0].name, 'start_ai_messenger_live_dispatch');
  assert.equal(mockDb.rpcCalls[0].params.p_page_id, PAGE_ID);
});

test('Messenger transport: missing lock token denies send immediately', async () => {
  const mockDb = createMockSupabase();
  let dispatchCalled = false;

  const transport = new MessengerDeliveryTransport({
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

  // Call sendReply with NO lockToken
  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.errorCode, 'MISSING_LOCK_TOKEN');
  assert.equal(dispatchCalled, false);
  assert.equal(mockDb.rpcCalls.length, 0);
});

test('Messenger transport: non-numeric Page ID fails closed', async () => {
  const mockDb = createMockSupabase({
    convData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      channel: 'FACEBOOK',
      external_conversation_id: `page-not-numeric:${RECIPIENT_PSID}`,
    },
  });
  let dispatchCalled = false;

  const transport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => {
      dispatchCalled = true;
      return { status: 'SENT', mid: 'mid.1' };
    }) as never,
  });

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.errorCode, 'INVALID_EXTERNAL_CONVERSATION_ID');
  assert.equal(dispatchCalled, false);
});

test('Messenger transport: dispatch-start fence denial halts physical dispatch (0 sends)', async () => {
  const mockDb = createMockSupabase({ fenceAllowed: false });
  let dispatchCalled = false;

  const transport = new MessengerDeliveryTransport({
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

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'SKIPPED');
  assert.equal(result.errorCode, 'DISPATCH_FENCE_DENIED');
  assert.equal(dispatchCalled, false);
  // Fencing RPC was called, but provider was never called
  assert.equal(mockDb.rpcCalls.length, 1);
  assert.equal(mockDb.rpcCalls[0].name, 'start_ai_messenger_live_dispatch');
});

test('Messenger transport: delivery lookup error fails closed and denies dispatch', async () => {
  const mockDb = createMockSupabase({
    deliveryError: new Error('DB_UNAVAILABLE'),
  });
  let dispatchCalled = false;

  const transport = new MessengerDeliveryTransport({
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

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.errorCode, 'DELIVERY_LOOKUP_FAILED');
  assert.equal(dispatchCalled, false);
});

test('Messenger transport: worker crash after dispatch-marker sets marker -> 0 second send on reclaim', async () => {
  // Simulates a delivery where dispatch_started_at was already marked before a crash
  const mockDb = createMockSupabase({
    deliveryData: {
      id: CLAIM_ID,
      lock_token: LOCK_TOKEN,
      send_status: 'PROCESSING',
      external_message_id: null,
      dispatch_started_at: '2026-10-23T04:00:00.000Z',
    },
  });

  let dispatchCalled = false;
  const transport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => {
      dispatchCalled = true;
      return { status: 'SENT', mid: 'mid.should-never-reach' };
    }) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'SKIPPED');
  assert.equal(result.errorCode, 'DISPATCH_ALREADY_STARTED');
  assert.equal(dispatchCalled, false);
});

test('Messenger transport: fails closed when 24-hour messaging window has elapsed', async () => {
  const expiredInbound = {
    created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago (>24h)
  };
  const mockDb = createMockSupabase({ inboundData: expiredInbound });
  let dispatchCalled = false;

  const transport = new MessengerDeliveryTransport({
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

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.errorCode, 'MESSAGING_WINDOW_CLOSED');
  assert.equal(dispatchCalled, false);
  assert.equal(mockDb.rpcCalls.length, 0);
});

test('Messenger transport: fails closed on company mismatch with page binding', async () => {
  const mockDb = createMockSupabase();
  let dispatchCalled = false;

  const transport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => {
      dispatchCalled = true;
      return { status: 'SENT', mid: 'mid.1' };
    }) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: '99999999-9999-4999-8999-999999999999', // Different company!
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.errorCode, 'PAGE_COMPANY_MISMATCH');
  assert.equal(dispatchCalled, false);
});

test('Messenger transport: strict canary default-denies un-allowlisted conversations', async () => {
  const mockDb = createMockSupabase({ canaryAllowed: false });
  let dispatchCalled = false;

  const transport = new MessengerDeliveryTransport({
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

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'SKIPPED');
  assert.equal(result.errorCode, 'CANARY_NOT_ALLOWED');
  assert.equal(dispatchCalled, false);
  assert.equal(mockDb.rpcCalls.length, 0);
});

test('Messenger transport: maps provider FAILED and UNKNOWN outcomes correctly', async () => {
  const mockDb = createMockSupabase();

  // Test FAILED
  const failTransport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => ({ status: 'FAILED' as const, mid: null })) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const failResult = await failTransport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });
  assert.equal(failResult.outcome, 'FAILED');
  assert.equal(failResult.errorCode, 'MESSENGER_DISPATCH_FAILED');

  // Test UNKNOWN (network timeout / provider uncertain)
  const unknownTransport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => ({ status: 'UNKNOWN' as const, mid: null })) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const unknownResult = await unknownTransport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });
  assert.equal(unknownResult.outcome, 'UNCERTAIN');
  assert.equal(unknownResult.errorCode, 'MESSENGER_DISPATCH_UNCERTAIN');
});

test('Messenger transport: outbound persistence errors are explicit FAILED with provider ID preserved (not ordinary SENT)', async () => {
  const mockDb = createMockSupabase({
    recordRpcError: new Error('DB_DEADLOCK_ON_INTERACTIONS'),
  });

  const transport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => ({ status: 'SENT' as const, mid: 'mid.persisted-fail-1' })) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  // Explicit non-retryable failure with provider ID preserved; NOT ordinary SENT
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.externalMessageId, 'mid.persisted-fail-1');
  assert.equal(result.errorCode, 'OUTBOUND_PERSISTENCE_FAILED');
});

test('Messenger transport: prevents duplicate physical send when delivery was already sent', async () => {
  const mockDb = createMockSupabase({
    deliveryData: {
      id: CLAIM_ID,
      lock_token: LOCK_TOKEN,
      send_status: 'PROCESSING',
      external_message_id: 'mid.already-sent-prev',
      dispatch_started_at: '2026-10-23T04:00:00.000Z',
    },
  });

  let dispatchCalled = false;
  const transport = new MessengerDeliveryTransport({
    supabase: mockDb,
    dispatchFn: (async () => {
      dispatchCalled = true;
      return { status: 'SENT', mid: 'mid.should-not-reach' };
    }) as never,
    resolveBinding: () => ({
      page: PAGE_ID,
      company: COMPANY_ID,
      tokenEnv: 'META_PAGE_ACCESS_TOKEN',
    }),
  });

  const result = await transport.sendReply({
    claim: defaultClaim,
    draft: DRAFT_TEXT,
    commandId: `ai-live:${INTERACTION_ID}`,
    minConfidence: 0.85,
    lockToken: LOCK_TOKEN,
  });

  assert.equal(result.outcome, 'SENT');
  assert.equal(result.externalMessageId, 'mid.already-sent-prev');
  assert.equal(dispatchCalled, false);
});
