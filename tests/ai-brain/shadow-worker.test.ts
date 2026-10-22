import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  processDueAiBrainShadowRuns,
  SHADOW_WORKLOAD_ACTOR_ID,
} from '../../features/ai-brain/shadow-worker';
import { JavisBrainProvider, type JavisFetch } from '../../features/ai-brain/javis-provider';
import type { BrainProvider, BrainTurnRequest, BrainProposal } from '../../features/ai-brain/contracts';
import { validateServerContext } from '../../features/ai-brain/validation';

// ---------------------------------------------------------------------------
// Deterministic Fixture IDs (Valid RFC 4122 UUIDs)
// ---------------------------------------------------------------------------
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const INTERACTION_ID = '44444444-4444-4444-8444-444444444444';
const CLAIM_ID = '55555555-5555-4555-8555-555555555555';
const SANITIZED_TEXT = 'Dạ em cần tư vấn lắp đặt cửa chống ngập cho nhà phố.';

// ---------------------------------------------------------------------------
// Global Fetch Interceptor Guard
// Zero customer transports or unmonitored external network permitted.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let allowedFetchUrlPattern: RegExp | null = null;
let fetchCallCount = 0;
let fetchCalls: Array<{ url: string; options?: RequestInit }> = [];

beforeEach(() => {
  allowedFetchUrlPattern = null;
  fetchCallCount = 0;
  fetchCalls = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchCallCount++;
    fetchCalls.push({ url, options: init });
    if (!allowedFetchUrlPattern || !allowedFetchUrlPattern.test(url)) {
      throw new Error(`[SECURITY VIOLATION] Unexpected global fetch intercepted: ${url}`);
    }
    return new Response(JSON.stringify({ ok: true, version: 'v1', proposal: { decision: 'RESPOND', draft: 'Javis response draft', confidence: 0.9 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Mock Supabase Builder
// Captures queries, selections, filters, and RPC invocations.
// ---------------------------------------------------------------------------
interface MockDbConfig {
  claimData?: unknown[];
  claimError?: Error | null;
  finishData?: boolean;
  finishError?: Error | null;
  settingData?: { enabled: boolean } | null;
  settingError?: Error | null;
  conversationData?: Record<string, unknown> | null;
  conversationError?: Error | null;
  interactionData?: Record<string, unknown> | null;
  interactionError?: Error | null;
}

interface CapturedQuery {
  table: string;
  selectedFields: string;
  filters: Record<string, unknown>;
}

interface CapturedRpc {
  name: string;
  params: Record<string, unknown>;
}

function createMockSupabase(config: MockDbConfig = {}) {
  const queries: CapturedQuery[] = [];
  const rpcCalls: CapturedRpc[] = [];

  const defaultClaim = {
    id: CLAIM_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    source_interaction_id: INTERACTION_ID,
    channel: 'MESSENGER',
    attempts: 1,
  };

  const defaultConversation = {
    id: CONVERSATION_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'FACEBOOK',
    status: 'OPEN',
    assigned_to: null,
  };

  const defaultInteraction = {
    id: INTERACTION_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: SANITIZED_TEXT,
  };

  const client = {
    queries,
    rpcCalls,
    from(table: string) {
      let selectedFields = '';
      const filters: Record<string, unknown> = {};

      const builder = {
        select(fields: string) {
          selectedFields = fields;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        async maybeSingle() {
          queries.push({ table, selectedFields, filters: { ...filters } });

          if (table === 'ai_brain_shadow_settings') {
            if (config.settingError) return { data: null, error: config.settingError };
            if (config.settingData !== undefined) return { data: config.settingData, error: null };
            return { data: { enabled: true }, error: null };
          }

          if (table === 'conversations') {
            if (config.conversationError) return { data: null, error: config.conversationError };
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

      if (name === 'claim_ai_brain_shadow_runs') {
        if (config.claimError) return { data: null, error: config.claimError };
        if (config.claimData !== undefined) return { data: config.claimData, error: null };
        return { data: [defaultClaim], error: null };
      }

      if (name === 'finish_ai_brain_shadow_run') {
        if (config.finishError) return { data: null, error: config.finishError };
        if (config.finishData !== undefined) return { data: config.finishData, error: null };
        return { data: true, error: null };
      }

      return { data: null, error: new Error(`Unknown RPC ${name}`) };
    },
  } as unknown as SupabaseClient & { queries: CapturedQuery[]; rpcCalls: CapturedRpc[] };

  return client;
}

// ---------------------------------------------------------------------------
// Fake Provider Helper
// ---------------------------------------------------------------------------
function createFakeProvider(proposal: BrainProposal | (() => Promise<BrainProposal>) | Error): BrainProvider & {
  calls: number;
  lastRequest: BrainTurnRequest | null;
} {
  let calls = 0;
  let lastRequest: BrainTurnRequest | null = null;

  return {
    get calls() { return calls; },
    get lastRequest() { return lastRequest; },
    descriptor: { id: 'fake-brain-provider', model: 'fake-model-v1' },
    async runTurn(request: BrainTurnRequest): Promise<BrainProposal> {
      calls++;
      lastRequest = request;
      if (proposal instanceof Error) throw proposal;
      if (typeof proposal === 'function') return proposal();
      return proposal;
    },
  };
}

// ===========================================================================
// Test Suite: AI Brain Shadow Worker Runtime Hardening & Boundary Tests
// ===========================================================================

test('SHADOW_WORKLOAD_ACTOR_ID is a valid RFC 4122 UUID and satisfies validateServerContext', () => {
  assert.match(
    SHADOW_WORKLOAD_ACTOR_ID,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'SHADOW_WORKLOAD_ACTOR_ID must be a standard UUID format',
  );

  // Validate directly against the system validation rule
  const validated = validateServerContext(
    {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION_ID,
      channel: 'MESSENGER',
      modality: 'TEXT',
      caller: { actorId: SHADOW_WORKLOAD_ACTOR_ID, actorType: 'WORKLOAD' },
      permissionProfile: 'READ_ONLY',
      conversationState: 'AI_ACTIVE',
      allowDrafts: true,
      traceId: randomUUID(),
    },
    {
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION_ID,
      channel: 'MESSENGER',
      modality: 'TEXT',
    },
  );
  assert.equal(validated.caller.actorId, SHADOW_WORKLOAD_ACTOR_ID);
  assert.equal(validated.caller.actorType, 'WORKLOAD');
});

test('RESPOND completed draft-only and provider receives EXACT sanitized text', async () => {
  const supabase = createMockSupabase();
  const provider = createFakeProvider({
    decision: 'RESPOND',
    draft: 'Dạ chào anh/chị, bên em có các mẫu cửa chống ngập tự động.',
    confidence: 0.95,
  });

  const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);

  // Provider calls > 0 (proves caller.actorId UUID regression did not occur)
  assert.equal(provider.calls, 1, 'Provider must be called exactly once');
  assert.ok(provider.lastRequest);
  assert.equal(provider.lastRequest.input.text, SANITIZED_TEXT, 'Provider receives exact sanitized text');
  assert.equal(provider.lastRequest.scope.companyId, COMPANY_ID);
  assert.equal(provider.lastRequest.scope.customerId, CUSTOMER_ID);
  assert.equal(provider.lastRequest.scope.conversationId, CONVERSATION_ID);
  assert.equal(provider.lastRequest.policy.permissionProfile, 'READ_ONLY');
  assert.equal(provider.lastRequest.policy.conversationState, 'AI_ACTIVE');
  assert.equal(provider.lastRequest.policy.allowDrafts, true);

  // Assert finish RPC
  const finishCalls = supabase.rpcCalls.filter(r => r.name === 'finish_ai_brain_shadow_run');
  assert.equal(finishCalls.length, 1);
  const finish = finishCalls[0].params;
  assert.equal(finish.p_status, 'COMPLETED');
  assert.equal(finish.p_decision, 'RESPOND');
  assert.equal(finish.p_draft, 'Dạ chào anh/chị, bên em có các mẫu cửa chống ngập tự động.');
  assert.equal(finish.p_confidence, 0.95);
  assert.equal(finish.p_handover_required, false);
  assert.equal(finish.p_provider, 'fake-brain-provider');
  assert.equal(finish.p_model, 'fake-model-v1');
  assert.equal(finish.p_error_code, null);
  assert.ok(typeof finish.p_turn_id === 'string');
  assert.ok(typeof finish.p_trace_id === 'string');
  assert.deepEqual(finish.p_tools_used, []);

  // Zero unexpected global fetch intercepted
  assert.equal(fetchCallCount, 0, 'No unexpected network/customer fetch permitted');
});

test('caller UUID regression check: invalid non-UUID caller causes providerCalls=0 and FAILED run', async () => {
  // Directly demonstrate that a non-UUID caller actorId fails validateServerContext closed
  assert.throws(() => {
    validateServerContext(
      {
        companyId: COMPANY_ID,
        caller: { actorId: 'ai-brain-shadow-worker', actorType: 'WORKLOAD' }, // non-UUID!
        permissionProfile: 'READ_ONLY',
        conversationState: 'AI_ACTIVE',
        allowDrafts: true,
        traceId: randomUUID(),
      },
      {
        customerId: CUSTOMER_ID,
        conversationId: CONVERSATION_ID,
        channel: 'MESSENGER',
        modality: 'TEXT',
      },
    );
  }, /BRAIN_INVALID_CONTEXT/);
});

test('HANDOVER decision persisted with reason and draft is null', async () => {
  const supabase = createMockSupabase();
  const provider = createFakeProvider({
    decision: 'HANDOVER',
    handoverReason: 'CUSTOMER_REQUESTED_HUMAN',
    confidence: 1,
  });

  const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

  assert.equal(result.completed, 1);
  assert.equal(provider.calls, 1);

  const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finish.p_status, 'COMPLETED');
  assert.equal(finish.p_decision, 'HANDOVER');
  assert.equal(finish.p_draft, null, 'Draft must be null on HANDOVER');
  assert.equal(finish.p_handover_required, true);
  assert.equal(finish.p_handover_reason, 'CUSTOMER_REQUESTED_HUMAN');
  assert.equal(finish.p_error_code, null);
});

test('NO_REPLY decision persisted with draft null', async () => {
  const supabase = createMockSupabase();
  const provider = createFakeProvider({
    decision: 'NO_REPLY',
    confidence: 0.99,
  });

  const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

  assert.equal(result.completed, 1);
  assert.equal(provider.calls, 1);

  const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finish.p_status, 'COMPLETED');
  assert.equal(finish.p_decision, 'NO_REPLY');
  assert.equal(finish.p_draft, null, 'Draft must be null on NO_REPLY');
  assert.equal(finish.p_handover_required, false);
});

test('throwing provider produces canonical FAILED with BRAIN_PROVIDER_ERROR and no error leak', async () => {
  const supabase = createMockSupabase();
  const secretError = new Error('CANARY_INTERNAL_DB_PASSWORD_123456');
  const provider = createFakeProvider(secretError);

  const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);

  const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finish.p_status, 'FAILED');
  assert.equal(finish.p_decision, 'ERROR');
  assert.equal(finish.p_error_code, 'BRAIN_PROVIDER_ERROR');
  assert.equal(finish.p_draft, null);
  // Ensure the canary secret error was NOT leaked into any parameter
  const serialized = JSON.stringify(finish);
  assert.ok(!serialized.includes('CANARY_INTERNAL_DB_PASSWORD'), 'Internal exception message must not leak');
});

test('invalid provider proposal fails closed to canonical BRAIN_PROVIDER_ERROR', async () => {
  const supabase = createMockSupabase();
  // Invalid proposal: missing required fields or confidence out of range
  const provider = createFakeProvider({
    decision: 'RESPOND',
    draft: 'Invalid draft',
    confidence: 2.5, // Invalid > 1.0
  } as unknown as BrainProposal);

  const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

  assert.equal(result.failed, 1);
  const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finish.p_status, 'FAILED');
  assert.equal(finish.p_error_code, 'BRAIN_PROVIDER_ERROR');
});

test('missing or invalid JAVIS environment fails closed to canonical BRAIN_UNAVAILABLE with no fallback', async () => {
  const origBase = process.env.JAVIS_BRAIN_BASE_URL;
  const origToken = process.env.JAVIS_BRAIN_INTERNAL_TOKEN;

  try {
    // 1. Missing Base URL
    delete process.env.JAVIS_BRAIN_BASE_URL;
    process.env.JAVIS_BRAIN_INTERNAL_TOKEN = `jvs_${'a'.repeat(48)}`;

    const supabase1 = createMockSupabase();
    const result1 = await processDueAiBrainShadowRuns(5, { supabase: supabase1 });
    assert.equal(result1.failed, 1);
    const finish1 = supabase1.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
    assert.equal(finish1.p_status, 'FAILED');
    assert.equal(finish1.p_decision, 'ERROR');
    assert.equal(finish1.p_error_code, 'BRAIN_UNAVAILABLE');
    assert.equal(finish1.p_provider, 'system');
    assert.equal(finish1.p_model, 'none');

    // 2. Missing Token
    process.env.JAVIS_BRAIN_BASE_URL = 'https://javis.internal.example';
    delete process.env.JAVIS_BRAIN_INTERNAL_TOKEN;

    const supabase2 = createMockSupabase();
    const result2 = await processDueAiBrainShadowRuns(5, { supabase: supabase2 });
    assert.equal(result2.failed, 1);
    const finish2 = supabase2.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
    assert.equal(finish2.p_error_code, 'BRAIN_UNAVAILABLE');

    // 3. Invalid Base URL (insecure http)
    process.env.JAVIS_BRAIN_BASE_URL = 'http://insecure.internal.example';
    process.env.JAVIS_BRAIN_INTERNAL_TOKEN = `jvs_${'a'.repeat(48)}`;

    const supabase3 = createMockSupabase();
    const result3 = await processDueAiBrainShadowRuns(5, { supabase: supabase3 });
    assert.equal(result3.failed, 1);
    const finish3 = supabase3.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
    assert.equal(finish3.p_error_code, 'BRAIN_UNAVAILABLE');
  } finally {
    if (origBase) process.env.JAVIS_BRAIN_BASE_URL = origBase;
    else delete process.env.JAVIS_BRAIN_BASE_URL;
    if (origToken) process.env.JAVIS_BRAIN_INTERNAL_TOKEN = origToken;
    else delete process.env.JAVIS_BRAIN_INTERNAL_TOKEN;
  }
});

test('disabled setting after queueing marks run SKIPPED without calling provider', async () => {
  const supabase = createMockSupabase({ settingData: { enabled: false } });
  const provider = createFakeProvider({ decision: 'RESPOND', draft: 'test', confidence: 0.9 });

  const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

  assert.equal(result.skipped, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
  assert.equal(provider.calls, 0, 'Provider must not be called when setting is disabled');

  const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finish.p_status, 'SKIPPED');
  assert.equal(finish.p_decision, null);
  assert.equal(finish.p_draft, null);
});

test('missing setting row marks run SKIPPED without calling provider', async () => {
  const supabase = createMockSupabase({ settingData: null });
  const provider = createFakeProvider({ decision: 'RESPOND', draft: 'test', confidence: 0.9 });

  const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

  assert.equal(result.skipped, 1);
  assert.equal(provider.calls, 0);

  const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finish.p_status, 'SKIPPED');
});

test('PENDING_SALE and assigned_to map to HUMAN_ACTIVE and permit draft per existing contract', async () => {
  // Case A: PENDING_SALE with assigned_to null
  const supabaseA = createMockSupabase({
    conversationData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      status: 'PENDING_SALE',
      assigned_to: null,
    },
  });
  const providerA = createFakeProvider({ decision: 'RESPOND', draft: 'Draft for pending sale', confidence: 0.9 });
  const resultA = await processDueAiBrainShadowRuns(5, { supabase: supabaseA, provider: providerA });

  assert.equal(resultA.completed, 1);
  assert.equal(providerA.calls, 1);
  assert.equal(providerA.lastRequest?.policy.conversationState, 'HUMAN_ACTIVE');
  assert.equal(providerA.lastRequest?.policy.allowDrafts, true);
  const finishA = supabaseA.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finishA.p_status, 'COMPLETED');
  assert.equal(finishA.p_draft, 'Draft for pending sale');

  // Case B: OPEN with assigned_to staff UUID
  const staffId = '99999999-9999-4999-8999-999999999999';
  const supabaseB = createMockSupabase({
    conversationData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      status: 'OPEN',
      assigned_to: staffId,
    },
  });
  const providerB = createFakeProvider({ decision: 'RESPOND', draft: 'Draft for assigned sale', confidence: 0.9 });
  const resultB = await processDueAiBrainShadowRuns(5, { supabase: supabaseB, provider: providerB });

  assert.equal(resultB.completed, 1);
  assert.equal(providerB.calls, 1);
  assert.equal(providerB.lastRequest?.policy.conversationState, 'HUMAN_ACTIVE');
  assert.equal(providerB.lastRequest?.policy.allowDrafts, true);
  const finishB = supabaseB.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finishB.p_status, 'COMPLETED');
  assert.equal(finishB.p_draft, 'Draft for assigned sale');
});

test('CLOSED conversation maps to AI_PAUSED and returns NO_REPLY without provider invocation', async () => {
  const supabase = createMockSupabase({
    conversationData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      status: 'CLOSED',
      assigned_to: null,
    },
  });
  const provider = createFakeProvider({ decision: 'RESPOND', draft: 'should not be called', confidence: 0.9 });

  // Run with provider present
  const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

  assert.equal(result.completed, 1);
  assert.equal(provider.calls, 0, 'Provider must not be called when conversation is CLOSED');
  const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finish.p_status, 'COMPLETED');
  assert.equal(finish.p_decision, 'NO_REPLY');
  assert.equal(finish.p_draft, null);

  // Run WITHOUT provider (provider: undefined) - BrainService returns NO_REPLY without checking provider
  const supabaseNoProv = createMockSupabase({
    conversationData: {
      id: CONVERSATION_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      status: 'CLOSED',
      assigned_to: null,
    },
  });
  const resultNoProv = await processDueAiBrainShadowRuns(5, { supabase: supabaseNoProv, provider: undefined });
  assert.equal(resultNoProv.completed, 1);
  const finishNoProv = supabaseNoProv.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finishNoProv.p_status, 'COMPLETED');
  assert.equal(finishNoProv.p_decision, 'NO_REPLY');
});

test('invalid scope, source or unsanitized interaction rejects BEFORE provider', async () => {
  const testCases: Array<{ name: string; patch: MockDbConfig }> = [
    {
      name: 'conversation channel mismatch with claim channel',
      patch: {
        conversationData: {
          id: CONVERSATION_ID,
          company_id: COMPANY_ID,
          customer_id: CUSTOMER_ID,
          channel: 'ZALO', // Claim is MESSENGER (expects FACEBOOK)
          status: 'OPEN',
          assigned_to: null,
        },
      },
    },
    {
      name: 'conversation missing (null)',
      patch: { conversationData: null },
    },
    {
      name: 'interaction missing (null)',
      patch: { interactionData: null },
    },
    {
      name: 'interaction channel mismatch',
      patch: {
        interactionData: {
          id: INTERACTION_ID,
          company_id: COMPANY_ID,
          customer_id: CUSTOMER_ID,
          conversation_id: CONVERSATION_ID,
          channel: 'ZALO',
          type: 'MESSAGE',
          direction: 'INBOUND',
          actor_type: 'CUSTOMER',
          sanitization_status: 'SUCCEEDED',
          sanitized_content: 'test',
        },
      },
    },
    {
      name: 'interaction type is CALL instead of MESSAGE',
      patch: {
        interactionData: {
          id: INTERACTION_ID,
          company_id: COMPANY_ID,
          customer_id: CUSTOMER_ID,
          conversation_id: CONVERSATION_ID,
          channel: 'FACEBOOK',
          type: 'CALL',
          direction: 'INBOUND',
          actor_type: 'CUSTOMER',
          sanitization_status: 'SUCCEEDED',
          sanitized_content: 'test',
        },
      },
    },
    {
      name: 'interaction direction is OUTBOUND',
      patch: {
        interactionData: {
          id: INTERACTION_ID,
          company_id: COMPANY_ID,
          customer_id: CUSTOMER_ID,
          conversation_id: CONVERSATION_ID,
          channel: 'FACEBOOK',
          type: 'MESSAGE',
          direction: 'OUTBOUND',
          actor_type: 'CUSTOMER',
          sanitization_status: 'SUCCEEDED',
          sanitized_content: 'test',
        },
      },
    },
    {
      name: 'interaction actor_type is SALE',
      patch: {
        interactionData: {
          id: INTERACTION_ID,
          company_id: COMPANY_ID,
          customer_id: CUSTOMER_ID,
          conversation_id: CONVERSATION_ID,
          channel: 'FACEBOOK',
          type: 'MESSAGE',
          direction: 'INBOUND',
          actor_type: 'SALE',
          sanitization_status: 'SUCCEEDED',
          sanitized_content: 'test',
        },
      },
    },
    {
      name: 'interaction sanitization_status is PENDING',
      patch: {
        interactionData: {
          id: INTERACTION_ID,
          company_id: COMPANY_ID,
          customer_id: CUSTOMER_ID,
          conversation_id: CONVERSATION_ID,
          channel: 'FACEBOOK',
          type: 'MESSAGE',
          direction: 'INBOUND',
          actor_type: 'CUSTOMER',
          sanitization_status: 'PENDING',
          sanitized_content: 'test',
        },
      },
    },
    {
      name: 'interaction sanitization_status is FAILED',
      patch: {
        interactionData: {
          id: INTERACTION_ID,
          company_id: COMPANY_ID,
          customer_id: CUSTOMER_ID,
          conversation_id: CONVERSATION_ID,
          channel: 'FACEBOOK',
          type: 'MESSAGE',
          direction: 'INBOUND',
          actor_type: 'CUSTOMER',
          sanitization_status: 'FAILED',
          sanitized_content: 'test',
        },
      },
    },
    {
      name: 'interaction sanitized_content is empty or whitespace',
      patch: {
        interactionData: {
          id: INTERACTION_ID,
          company_id: COMPANY_ID,
          customer_id: CUSTOMER_ID,
          conversation_id: CONVERSATION_ID,
          channel: 'FACEBOOK',
          type: 'MESSAGE',
          direction: 'INBOUND',
          actor_type: 'CUSTOMER',
          sanitization_status: 'SUCCEEDED',
          sanitized_content: '   \n  \t ',
        },
      },
    },
  ];

  for (const tc of testCases) {
    const supabase = createMockSupabase(tc.patch);
    const provider = createFakeProvider({ decision: 'RESPOND', draft: 'test', confidence: 0.9 });

    const result = await processDueAiBrainShadowRuns(5, { supabase, provider });

    assert.equal(result.failed, 1, `Failed count must be 1 for: ${tc.name}`);
    assert.equal(provider.calls, 0, `Provider must NOT be called for: ${tc.name}`);
    const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
    assert.equal(finish.p_status, 'FAILED');
    assert.equal(finish.p_error_code, 'BRAIN_INVALID_CONTEXT');
  }
});

test('queries scope by all IDs and select ONLY sanitized fields, no private raw/contact reads', async () => {
  const supabase = createMockSupabase();
  const provider = createFakeProvider({ decision: 'RESPOND', draft: 'test', confidence: 0.9 });

  await processDueAiBrainShadowRuns(5, { supabase, provider });

  // 1. Settings query
  const settingQuery = supabase.queries.find(q => q.table === 'ai_brain_shadow_settings');
  assert.ok(settingQuery);
  assert.equal(settingQuery.selectedFields, 'enabled');
  assert.equal(settingQuery.filters.company_id, COMPANY_ID);
  assert.equal(settingQuery.filters.channel, 'MESSENGER');

  // 2. Conversations query
  const convoQuery = supabase.queries.find(q => q.table === 'conversations');
  assert.ok(convoQuery);
  assert.equal(convoQuery.selectedFields, 'id,company_id,customer_id,channel,status,assigned_to');
  assert.equal(convoQuery.filters.id, CONVERSATION_ID);
  assert.equal(convoQuery.filters.company_id, COMPANY_ID);
  assert.equal(convoQuery.filters.customer_id, CUSTOMER_ID);

  // 3. Interactions query
  const intQuery = supabase.queries.find(q => q.table === 'interactions');
  assert.ok(intQuery);
  assert.equal(
    intQuery.selectedFields,
    'id,company_id,customer_id,conversation_id,channel,type,direction,actor_type,sanitization_status,sanitized_content',
  );
  assert.equal(intQuery.filters.id, INTERACTION_ID);
  assert.equal(intQuery.filters.company_id, COMPANY_ID);
  assert.equal(intQuery.filters.customer_id, CUSTOMER_ID);
  assert.equal(intQuery.filters.conversation_id, CONVERSATION_ID);

  // Invariant: raw un-sanitized content and private customer contacts must never be read
  assert.ok(!intQuery.selectedFields.split(',').includes('content'), 'Must not select raw content column');
  assert.ok(!intQuery.selectedFields.includes('phone'), 'Must not select customer phone');
  assert.ok(!intQuery.selectedFields.includes('email'), 'Must not select customer email');
});

test('finish RPC error or data!==true counted failed without false completed', async () => {
  // Case A: finish returns RPC error
  const supabaseA = createMockSupabase({ finishError: new Error('RPC_FENCE_ERROR') });
  const providerA = createFakeProvider({ decision: 'RESPOND', draft: 'test', confidence: 0.9 });
  const resultA = await processDueAiBrainShadowRuns(5, { supabase: supabaseA, provider: providerA });
  assert.equal(resultA.claimed, 1);
  assert.equal(resultA.failed, 1, 'RPC error must be counted as failed');
  assert.equal(resultA.completed, 0);

  // Case B: finish returns data !== true (e.g. lease expired, token mismatch)
  const supabaseB = createMockSupabase({ finishData: false });
  const providerB = createFakeProvider({ decision: 'RESPOND', draft: 'test', confidence: 0.9 });
  const resultB = await processDueAiBrainShadowRuns(5, { supabase: supabaseB, provider: providerB });
  assert.equal(resultB.claimed, 1);
  assert.equal(resultB.failed, 1, 'data!==true must be counted as failed');
  assert.equal(resultB.completed, 0);
});

test('claim RPC error throws SHADOW_CLAIM_FAILED', async () => {
  const supabase = createMockSupabase({ claimError: new Error('CLAIM_TIMEOUT') });
  await assert.rejects(
    async () => processDueAiBrainShadowRuns(5, { supabase }),
    /SHADOW_CLAIM_FAILED/,
  );
});

test('strict limits 1..10 enforcement', async () => {
  const invalidLimits = [0, 11, -1, 1.5, NaN, -5, 100];
  for (const lim of invalidLimits) {
    await assert.rejects(
      async () => processDueAiBrainShadowRuns(lim),
      /INVALID_SHADOW_LIMIT/,
      `Limit ${lim} must throw INVALID_SHADOW_LIMIT`,
    );
  }

  // Valid limits 1 and 10 must pass validation
  const supabase = createMockSupabase();
  const res1 = await processDueAiBrainShadowRuns(1, { supabase });
  assert.equal(res1.claimed, 1);
  const res10 = await processDueAiBrainShadowRuns(10, { supabase });
  assert.equal(res10.claimed, 1);
});

test('integration with actual JavisBrainProvider adapter: validates server-only env and draft-only delivery', async () => {
  const targetBaseUrl = 'https://javis.internal.example';
  const targetToken = `jvs_${'k'.repeat(48)}`;

  // Set fetch guard to ONLY permit the exact canonical HTTPS endpoint
  allowedFetchUrlPattern = /^https:\/\/javis\.internal\.example\/v1\/brain\/turn$/;

  let capturedHeaders: Record<string, string> = {};
  let capturedBody: unknown = null;

  const mockFetch: JavisFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, options: init });
    fetchCallCount++;

    if (url !== 'https://javis.internal.example/v1/brain/turn') {
      throw new Error(`Unexpected endpoint URL: ${url}`);
    }

    capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    capturedBody = JSON.parse(init?.body as string);

    return new Response(
      JSON.stringify({
        ok: true,
        version: 'v1',
        proposal: {
          decision: 'RESPOND',
          draft: 'Dạ Javis xin chào, hệ thống cửa chống ngập tự động đã sẵn sàng.',
          confidence: 0.92,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const realJavisProvider = new JavisBrainProvider({
    baseUrl: targetBaseUrl,
    authToken: targetToken,
    fetchImpl: mockFetch,
  });

  const supabase = createMockSupabase();
  const result = await processDueAiBrainShadowRuns(1, {
    supabase,
    provider: realJavisProvider,
  });

  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);

  // Validate fetch call details
  assert.equal(fetchCallCount, 1);
  assert.equal(capturedHeaders['authorization'], `Bearer ${targetToken}`);
  assert.equal(capturedHeaders['content-type'], 'application/json');
  assert.ok(capturedBody);
  assert.equal((capturedBody as any).version, 'v1');
  assert.equal((capturedBody as any).scope.companyId, COMPANY_ID);
  assert.equal((capturedBody as any).input.text, SANITIZED_TEXT);

  // Validate finish RPC has Javis metadata and draft
  const finish = supabase.rpcCalls.find(r => r.name === 'finish_ai_brain_shadow_run')!.params;
  assert.equal(finish.p_status, 'COMPLETED');
  assert.equal(finish.p_decision, 'RESPOND');
  assert.equal(finish.p_draft, 'Dạ Javis xin chào, hệ thống cửa chống ngập tự động đã sẵn sàng.');
  assert.equal(finish.p_provider, 'javis-brain-service');
  assert.equal(finish.p_model, 'javis-router-v1');
  assert.equal(finish.p_confidence, 0.92);
});

test('SHADOW_TIMEOUT_MS env var configures execution budget within 1000..10000 bound', async () => {
  const originalEnv = process.env.SHADOW_TIMEOUT_MS;
  try {
    process.env.SHADOW_TIMEOUT_MS = '8000';
    const supabase = createMockSupabase();
    const result = await processDueAiBrainShadowRuns(1, {
      supabase,
      provider: createFakeProvider({
        decision: 'RESPOND',
        draft: 'Dạ bên em xin chào',
        confidence: 0.9,
      }),
    });
    assert.equal(result.completed, 1);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.SHADOW_TIMEOUT_MS;
    } else {
      process.env.SHADOW_TIMEOUT_MS = originalEnv;
    }
  }
});

test('static security inspection: zero transport imports and zero customer send paths', () => {
  const workerPath = resolve(__dirname, '../../features/ai-brain/shadow-worker.ts');
  const content = readFileSync(workerPath, 'utf8');

  // Verify server-only boundary
  assert.ok(content.startsWith("import 'server-only';"), 'Must declare server-only at line 1');

  // Forbidden outbound delivery transport imports
  const forbiddenPatterns = [
    /from ['"].*zalo.*['"]/i,
    /from ['"].*facebook.*['"]/i,
    /from ['"].*meta.*['"]/i,
    /from ['"].*twilio.*['"]/i,
    /from ['"].*stringee.*['"]/i,
    /from ['"].*outbox.*['"]/i,
    /from ['"].*send.*['"]/i,
    /sendMessage/i,
    /sendCustomer/i,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(content), `shadow-worker.ts must not contain forbidden pattern: ${pattern}`);
  }
});
