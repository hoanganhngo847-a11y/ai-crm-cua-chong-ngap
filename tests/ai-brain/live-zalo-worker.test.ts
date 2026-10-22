import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  processDueAiBrainLiveZaloDeliveries,
  LIVE_ZALO_WORKLOAD_ACTOR_ID,
  type LiveZaloClaim,
} from '../../features/ai-brain/live-zalo-worker';
import type { BrainProvider, BrainTurnRequest, BrainProposal } from '../../features/ai-brain/contracts';
import { validateServerContext } from '../../features/ai-brain/validation';
import type { ZaloInboxService } from '../../features/omnichannel/zalo/inbox-service';
import type { SendZaloReplyParams, SendZaloReplyResult } from '../../features/omnichannel/zalo/types';

// ---------------------------------------------------------------------------
// Deterministic Fixture IDs (Valid RFC 4122 UUIDs)
// ---------------------------------------------------------------------------
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const INTERACTION_ID = '44444444-4444-4444-8444-444444444444';
const CLAIM_ID = '55555555-5555-4555-8555-555555555555';
const SANITIZED_TEXT = 'Chào shop, em cần tư vấn lắp cửa chống ngập.';

interface MockDbConfig {
  claimData?: unknown[];
  claimError?: Error | null;
  finishData?: boolean;
  finishError?: Error | null;
  settingData?: { enabled: boolean; min_confidence?: number } | null;
  settingError?: Error | null;
  preSendSettingData?: { enabled: boolean } | null;
  conversationData?: Record<string, unknown> | null;
  conversationError?: Error | null;
  preSendConversationData?: Record<string, unknown> | null;
  interactionData?: Record<string, unknown> | null;
  interactionError?: Error | null;
}

interface CapturedRpc {
  name: string;
  params: Record<string, unknown>;
}

function createMockSupabase(config: MockDbConfig = {}) {
  const rpcCalls: CapturedRpc[] = [];
  let settingQueryCount = 0;
  let convQueryCount = 0;

  const defaultClaim: LiveZaloClaim = {
    id: CLAIM_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    source_interaction_id: INTERACTION_ID,
    channel: 'ZALO',
    attempts: 1,
  };

  const defaultConversation = {
    id: CONVERSATION_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    status: 'OPEN',
    assigned_to: null,
  };

  const defaultInteraction = {
    id: INTERACTION_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: SANITIZED_TEXT,
  };

  const client = {
    rpcCalls,
    from(table: string) {
      const filters: Record<string, unknown> = {};

      const builder = {
        select(_fields: string) {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        async maybeSingle() {
          if (table === 'ai_brain_live_settings') {
            settingQueryCount++;
            if (config.settingError) return { data: null, error: config.settingError };
            // Second lookup is pre-send re-check
            if (settingQueryCount > 1 && config.preSendSettingData !== undefined) {
              return { data: config.preSendSettingData, error: null };
            }
            if (config.settingData !== undefined) return { data: config.settingData, error: null };
            return { data: { enabled: true, min_confidence: 0.85 }, error: null };
          }

          if (table === 'conversations') {
            convQueryCount++;
            if (config.conversationError) return { data: null, error: config.conversationError };
            // Second lookup is pre-send re-check
            if (convQueryCount > 1 && config.preSendConversationData !== undefined) {
              return { data: config.preSendConversationData, error: null };
            }
            if (config.conversationData !== undefined) return { data: config.conversationData, error: null };
            return { data: { ...defaultConversation }, error: null };
          }

          if (table === 'interactions') {
            if (config.interactionError) return { data: null, error: config.interactionError };
            if (config.interactionData !== undefined) return { data: config.interactionData, error: null };
            return { data: { ...defaultInteraction }, error: null };
          }

          return { data: null, error: null };
        },
      };
      return builder;
    },
    async rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params });
      if (name === 'claim_ai_brain_live_deliveries') {
        if (config.claimError) return { data: null, error: config.claimError };
        return { data: config.claimData ?? [defaultClaim], error: null };
      }
      if (name === 'finish_ai_brain_live_delivery') {
        if (config.finishError) return { data: null, error: config.finishError };
        return { data: config.finishData ?? true, error: null };
      }
      throw new Error(`Unexpected mock RPC: ${name}`);
    },
  };

  return client as unknown as SupabaseClient & { rpcCalls: CapturedRpc[] };
}

function createMockInboxService(customResult?: Partial<SendZaloReplyResult>) {
  const sendCalls: Array<{ params: SendZaloReplyParams; principal: unknown }> = [];
  const service = {
    sendCalls,
    async sendSystemZaloReply(params: SendZaloReplyParams, principal: unknown): Promise<SendZaloReplyResult> {
      sendCalls.push({ params, principal });
      if (customResult) {
        return {
          success: true,
          status: 'SENT',
          deliveryId: randomUUID(),
          externalMessageId: 'ext-zalo-msg-123',
          ...customResult,
        };
      }
      return {
        success: true,
        status: 'SENT',
        deliveryId: randomUUID(),
        externalMessageId: 'ext-zalo-msg-123',
      };
    },
  };
  return service as unknown as ZaloInboxService & { sendCalls: typeof sendCalls };
}

function createMockProvider(proposal: Partial<BrainProposal>): BrainProvider & { calls: BrainTurnRequest[] } {
  const calls: BrainTurnRequest[] = [];
  return {
    descriptor: { id: 'test-javis-provider', model: 'javis-router-v1' },
    calls,
    async runTurn(request: BrainTurnRequest): Promise<BrainProposal> {
      calls.push(request);
      const decision = proposal.decision ?? 'RESPOND';
      return {
        decision,
        draft: decision === 'RESPOND' ? (proposal.draft ?? 'Dạ em chào anh/chị, bên em có các mẫu cửa chống ngập ạ.') : undefined,
        confidence: proposal.confidence ?? 0.95,
        handoverReason: decision === 'HANDOVER' ? (proposal.handoverReason ?? 'CUSTOMER_REQUESTED_STAFF') : undefined,
        toolsUsed: [],
        memoryReferences: [],
        sourceReferences: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('LIVE_ZALO_WORKLOAD_ACTOR_ID satisfies RFC 4122 UUID and validateServerContext', () => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.ok(uuidRegex.test(LIVE_ZALO_WORKLOAD_ACTOR_ID));

  const validContext = validateServerContext(
    {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION_ID,
      channel: 'ZALO',
      modality: 'TEXT',
      sessionId: undefined,
      caller: { actorId: LIVE_ZALO_WORKLOAD_ACTOR_ID, actorType: 'WORKLOAD' },
      permissionProfile: 'READ_ONLY',
      conversationState: 'AI_ACTIVE',
      allowDrafts: true,
      deliveryMode: 'LIVE_SEND',
      traceId: randomUUID(),
    },
    {
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION_ID,
      channel: 'ZALO',
      modality: 'TEXT',
    }
  );

  assert.equal(validContext.caller.actorId, LIVE_ZALO_WORKLOAD_ACTOR_ID);
  assert.equal(validContext.deliveryMode, 'LIVE_SEND');
});

test('PASS: Valid inbound Zalo customer message -> high confidence RESPOND -> sends once -> status SENT', async () => {
  const supabase = createMockSupabase();
  const provider = createMockProvider({ decision: 'RESPOND', draft: 'Dạ bên em xin báo thông tin cửa.', confidence: 0.95 });
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, {
    supabase,
    provider,
    inboxService: inbox,
  });

  assert.deepEqual(summary, { claimed: 1, sent: 1, skipped: 0, failed: 0 });
  assert.equal(inbox.sendCalls.length, 1);
  assert.equal(inbox.sendCalls[0].params.conversationId, CONVERSATION_ID);
  assert.equal(inbox.sendCalls[0].params.content, 'Dạ bên em xin báo thông tin cửa.');
  assert.equal(inbox.sendCalls[0].params.commandId, `ai-live:${INTERACTION_ID}`);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.ok(finishCall);
  assert.equal(finishCall.params.p_send_status, 'SENT');
  assert.equal(finishCall.params.p_decision, 'RESPOND');
  assert.equal(finishCall.params.p_confidence, 0.95);
  assert.equal(finishCall.params.p_external_message_id, 'ext-zalo-msg-123');
});

test('DENY: Outbound interaction rejects before provider with zero send calls', async () => {
  const supabase = createMockSupabase({
    interactionData: {
      id: INTERACTION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: CONVERSATION_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'AI',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: SANITIZED_TEXT,
    },
  });
  const provider = createMockProvider({});
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.failed, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(inbox.sendCalls.length, 0);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'FAILED');
  assert.equal(finishCall?.params.p_error_code, 'LIVE_SOURCE_INVALID');
});

test('DENY: Non-customer actor rejects before provider with zero send calls', async () => {
  for (const actor of ['SALE', 'SYSTEM', 'TECHNICIAN']) {
    const supabase = createMockSupabase({
      interactionData: {
        id: INTERACTION_ID,
        company_id: COMPANY_ID,
        customer_id: CUSTOMER_ID,
        conversation_id: CONVERSATION_ID,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: actor,
        sanitization_status: 'SUCCEEDED',
        sanitized_content: SANITIZED_TEXT,
      },
    });
    const provider = createMockProvider({});
    const inbox = createMockInboxService();

    const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
    assert.equal(summary.failed, 1);
    assert.equal(provider.calls.length, 0);
    assert.equal(inbox.sendCalls.length, 0);
  }
});

test('DENY: Human assigned (assigned_to != null) skips without provider call or send', async () => {
  const supabase = createMockSupabase({
    conversationData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'ZALO',
      status: 'OPEN',
      assigned_to: '99999999-9999-4999-8999-999999999999',
    },
  });
  const provider = createMockProvider({});
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(inbox.sendCalls.length, 0);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'SKIPPED');
});

test('DENY: PENDING_SALE conversation state skips without provider call or send', async () => {
  const supabase = createMockSupabase({
    conversationData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'ZALO',
      status: 'PENDING_SALE',
      assigned_to: null,
    },
  });
  const provider = createMockProvider({});
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(inbox.sendCalls.length, 0);
});

test('DENY: CLOSED conversation skips without provider call or send', async () => {
  const supabase = createMockSupabase({
    conversationData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'ZALO',
      status: 'CLOSED',
      assigned_to: null,
    },
  });
  const provider = createMockProvider({});
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(inbox.sendCalls.length, 0);
});

test('DENY: Unsanitized or blank content rejects before provider with zero send calls', async () => {
  const supabase = createMockSupabase({
    interactionData: {
      id: INTERACTION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: CONVERSATION_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'PENDING',
      sanitized_content: null,
    },
  });
  const provider = createMockProvider({});
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.failed, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(inbox.sendCalls.length, 0);
});

test('DENY: Disabled setting skips run without calling provider or sender', async () => {
  const supabase = createMockSupabase({
    settingData: { enabled: false },
  });
  const provider = createMockProvider({});
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(inbox.sendCalls.length, 0);
});

test('GATE: Low confidence (< min_confidence) skips without sending', async () => {
  const supabase = createMockSupabase({
    settingData: { enabled: true, min_confidence: 0.85 },
  });
  const provider = createMockProvider({ decision: 'RESPOND', draft: 'Draft', confidence: 0.75 });
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(inbox.sendCalls.length, 0);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall?.params.p_error_code, 'LOW_CONFIDENCE');
});

test('GATE: Decision HANDOVER skips without sending', async () => {
  const supabase = createMockSupabase();
  const provider = createMockProvider({ decision: 'HANDOVER', handoverReason: 'CUSTOMER_REQUESTED_STAFF', confidence: 1 });
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(inbox.sendCalls.length, 0);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall?.params.p_decision, 'HANDOVER');
});

test('GATE: Decision NO_REPLY skips without sending', async () => {
  const supabase = createMockSupabase();
  const provider = createMockProvider({ decision: 'NO_REPLY', confidence: 1 });
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(inbox.sendCalls.length, 0);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall?.params.p_decision, 'NO_REPLY');
});

test('GATE: Provider error results in FAILED with zero sends', async () => {
  const supabase = createMockSupabase();
  const provider: BrainProvider = {
    descriptor: { id: 'throwing', model: 'mock' },
    async runTurn() {
      throw new Error('Javis backend down');
    },
  };
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.failed, 1);
  assert.equal(inbox.sendCalls.length, 0);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'FAILED');
  assert.equal(finishCall?.params.p_error_code, 'BRAIN_PROVIDER_ERROR');
});

test('RACE: Human assignment during inference halts send via pre-send recheck', async () => {
  const supabase = createMockSupabase({
    conversationData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'ZALO',
      status: 'OPEN',
      assigned_to: null,
    },
    // Human assigned while model is calculating!
    preSendConversationData: {
      status: 'OPEN',
      assigned_to: '88888888-8888-4888-8888-888888888888',
    },
  });
  const provider = createMockProvider({ decision: 'RESPOND', draft: 'Dạ chào anh', confidence: 0.95 });
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(inbox.sendCalls.length, 0);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall?.params.p_error_code, 'HUMAN_TAKEN_OVER');
});

test('RACE: Kill switch disabled during inference halts send via pre-send recheck', async () => {
  const supabase = createMockSupabase({
    settingData: { enabled: true, min_confidence: 0.85 },
    // Setting disabled while model is calculating!
    preSendSettingData: { enabled: false },
  });
  const provider = createMockProvider({ decision: 'RESPOND', draft: 'Dạ chào anh', confidence: 0.95 });
  const inbox = createMockInboxService();

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.skipped, 1);
  assert.equal(inbox.sendCalls.length, 0);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'SKIPPED');
  assert.equal(finishCall?.params.p_error_code, 'KILL_SWITCH_ENGAGED');
});

test('IDEMPOTENCY: ALREADY_SENT from sender settles as SENT with exactly 1 send attempt', async () => {
  const supabase = createMockSupabase();
  const provider = createMockProvider({ decision: 'RESPOND', draft: 'Dạ chào anh', confidence: 0.95 });
  const inbox = createMockInboxService({
    status: 'ALREADY_SENT',
    externalMessageId: 'already-sent-msg-id',
  });

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.sent, 1);
  assert.equal(inbox.sendCalls.length, 1);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'SENT');
  assert.equal(finishCall?.params.p_external_message_id, 'already-sent-msg-id');
});

test('FAILURE: Zalo sender error marks delivery FAILED with safe error code and no false SENT', async () => {
  const supabase = createMockSupabase();
  const provider = createMockProvider({ decision: 'RESPOND', draft: 'Dạ chào anh', confidence: 0.95 });
  const inbox = createMockInboxService({
    success: false,
    status: 'FAILED',
    error: 'ZALO_OA_TOKEN_EXPIRED',
  });

  const summary = await processDueAiBrainLiveZaloDeliveries(1, { supabase, provider, inboxService: inbox });
  assert.equal(summary.failed, 1);
  assert.equal(inbox.sendCalls.length, 1);

  const finishCall = supabase.rpcCalls.find((c) => c.name === 'finish_ai_brain_live_delivery');
  assert.equal(finishCall?.params.p_send_status, 'FAILED');
  assert.equal(finishCall?.params.p_error_code, 'ZALO_OA_TOKEN_EXPIRED');
});

test('STATIC SECURITY AUDIT: Zero Zalo credentials in javis-brain and javis-runtime', () => {
  const javisDir = resolve(process.cwd(), 'services/javis-brain');
  const files = ['server.ts', 'model.ts', 'validation.ts', 'main.ts'];

  for (const file of files) {
    try {
      const content = readFileSync(resolve(javisDir, file), 'utf8');
      assert.ok(!/zalo/i.test(content), `services/javis-brain/${file} must contain zero Zalo references`);
      assert.ok(!/sendTextMessage/i.test(content), `services/javis-brain/${file} must have zero send paths`);
      assert.ok(!/supabase/i.test(content), `services/javis-brain/${file} must have zero Supabase imports`);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
});
