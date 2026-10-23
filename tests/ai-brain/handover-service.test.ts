import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  claimHandoverCase,
  createHandoverCase,
  getActiveHandoverCaseForConversation,
  listHandoverCases,
  resumeAiConversation,
} from '../../features/ai-brain/handover/service';

function createMockClient(options: {
  rpcReturn?: unknown;
  rpcError?: Error | null;
  fromData?: unknown[];
  fromError?: Error | null;
}) {
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const fromCalls: { table: string; method: string; args: unknown }[] = [];

  const mockClient = {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (options.rpcError) {
        return { data: null, error: options.rpcError };
      }
      return { data: options.rpcReturn ?? null, error: null };
    },
    from: (table: string) => {
      const builder: any = {
        select: (fields: string) => {
          fromCalls.push({ table, method: 'select', args: fields });
          return builder;
        },
        eq: (col: string, val: unknown) => {
          fromCalls.push({ table, method: 'eq', args: { col, val } });
          return builder;
        },
        in: (col: string, val: unknown) => {
          fromCalls.push({ table, method: 'in', args: { col, val } });
          return builder;
        },
        is: (col: string, val: unknown) => {
          fromCalls.push({ table, method: 'is', args: { col, val } });
          return builder;
        },
        order: (col: string, val: unknown) => {
          fromCalls.push({ table, method: 'order', args: { col, val } });
          return builder;
        },
        range: (from: number, to: number) => {
          fromCalls.push({ table, method: 'range', args: { from, to } });
          return builder;
        },
        limit: (n: number) => {
          fromCalls.push({ table, method: 'limit', args: n });
          return builder;
        },
        maybeSingle: async () => {
          if (options.fromError) return { data: null, error: options.fromError };
          return { data: options.fromData?.[0] ?? null, error: null };
        },
        then: (resolve: any) => {
          if (options.fromError) {
            return resolve({ data: null, error: options.fromError });
          }
          return resolve({ data: options.fromData ?? [], error: null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client: mockClient, rpcCalls, fromCalls };
}

test('createHandoverCase: passes exact arguments to create_ai_handover_case RPC', async () => {
  const expectedId = '11111111-1111-4111-8111-111111111111';
  const { client, rpcCalls } = createMockClient({ rpcReturn: expectedId });

  const id = await createHandoverCase(client, {
    companyId: '00000000-0000-4000-8000-000000000001',
    customerId: '00000000-0000-4000-8000-000000000002',
    conversationId: '00000000-0000-4000-8000-000000000003',
    sourceInteractionId: '00000000-0000-4000-8000-000000000004',
    reason: 'CUSTOMER_COMPLAINT',
    priority: 'HIGH',
    brainTurnId: '00000000-0000-4000-8000-000000000005',
    metadata: { note: 'test' },
  });

  assert.equal(id, expectedId);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'create_ai_handover_case');
  assert.deepEqual(rpcCalls[0].args, {
    p_company_id: '00000000-0000-4000-8000-000000000001',
    p_customer_id: '00000000-0000-4000-8000-000000000002',
    p_conversation_id: '00000000-0000-4000-8000-000000000003',
    p_source_interaction_id: '00000000-0000-4000-8000-000000000004',
    p_reason: 'CUSTOMER_COMPLAINT',
    p_priority: 'HIGH',
    p_brain_turn_id: '00000000-0000-4000-8000-000000000005',
    p_metadata: { note: 'test' },
  });
});

test('createHandoverCase: throws when RPC returns error', async () => {
  const { client } = createMockClient({
    rpcError: new Error('DB_VIOLATION'),
  });

  await assert.rejects(
    () =>
      createHandoverCase(client, {
        companyId: '00000000-0000-4000-8000-000000000001',
        customerId: '00000000-0000-4000-8000-000000000002',
        conversationId: '00000000-0000-4000-8000-000000000003',
        sourceInteractionId: '00000000-0000-4000-8000-000000000004',
        reason: 'OTHER',
        priority: 'LOW',
      }),
    /HANDOVER_CASE_CREATE_FAILED/
  );
});

test('claimHandoverCase: calls claim_ai_handover_case RPC and returns boolean', async () => {
  const { client, rpcCalls } = createMockClient({ rpcReturn: true });

  const success = await claimHandoverCase(client, {
    companyId: '00000000-0000-4000-8000-000000000001',
    caseId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
  });

  assert.equal(success, true);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'claim_ai_handover_case');
  assert.deepEqual(rpcCalls[0].args, {
    p_company_id: '00000000-0000-4000-8000-000000000001',
    p_case_id: '11111111-1111-4111-8111-111111111111',
    p_user_id: '22222222-2222-4222-8222-222222222222',
  });
});

test('resumeAiConversation: calls resume_ai_conversation RPC', async () => {
  const { client, rpcCalls } = createMockClient({ rpcReturn: true });

  const success = await resumeAiConversation(client, {
    companyId: '00000000-0000-4000-8000-000000000001',
    conversationId: '00000000-0000-4000-8000-000000000003',
    userId: '22222222-2222-4222-8222-222222222222',
  });

  assert.equal(success, true);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'resume_ai_conversation');
  assert.deepEqual(rpcCalls[0].args, {
    p_company_id: '00000000-0000-4000-8000-000000000001',
    p_conversation_id: '00000000-0000-4000-8000-000000000003',
    p_user_id: '22222222-2222-4222-8222-222222222222',
  });
});

test('listHandoverCases: maps rows into frozen immutable domain objects', async () => {
  const mockRow = {
    id: 'case-1',
    company_id: 'comp-1',
    customer_id: 'cust-1',
    conversation_id: 'conv-1',
    source_interaction_id: 'int-1',
    reason: 'CUSTOMER_COMPLAINT',
    priority: 'HIGH',
    status: 'OPEN',
    assigned_to: null,
    brain_turn_id: 'turn-1',
    metadata: { key: 'val' },
    created_at: '2026-10-23T00:00:00Z',
    claimed_at: null,
    resolved_at: null,
    updated_at: '2026-10-23T00:00:00Z',
  };

  const { client } = createMockClient({ fromData: [mockRow] });

  const cases = await listHandoverCases(client, {
    companyId: 'comp-1',
    status: 'OPEN',
    priority: 'HIGH',
  });

  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, 'case-1');
  assert.equal(cases[0].companyId, 'comp-1');
  assert.equal(cases[0].reason, 'CUSTOMER_COMPLAINT');
  assert.equal(cases[0].priority, 'HIGH');
  assert.equal(cases[0].status, 'OPEN');
  assert.equal(cases[0].assignedTo, null);
  assert.ok(Object.isFrozen(cases));
  assert.ok(Object.isFrozen(cases[0]));
});
