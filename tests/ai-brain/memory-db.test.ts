import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseBrainContextDataSource, type BrainContextScope } from '../../features/ai-brain';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error('AI Brain memory DB test requires local Supabase env');
}

const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function fixtureScope(): Promise<BrainContextScope> {
  const { data: customer, error } = await service
    .from('customers')
    .select('id,company_id')
    .limit(1)
    .maybeSingle();
  assert.ifError(error);
  assert.ok(customer, 'local fixture must contain at least one customer');
  return {
    companyId: String(customer.company_id),
    customerId: String(customer.id),
    conversationId: randomUUID(),
    channel: 'INTERNAL',
    traceId: randomUUID(),
  };
}

test('Phase 3 tables are private and service role cannot delete memory/knowledge', async () => {
  const scope = await fixtureScope();
  const marker = `phase3-acl-${randomUUID()}`;

  const knowledgeInsert = await service
    .from('ai_company_knowledge')
    .insert({
      company_id: scope.companyId,
      category: 'FAQ',
      title: marker,
      content: 'Verified company knowledge for an ephemeral integration test.',
      verification_status: 'VERIFIED',
      lifecycle_status: 'ACTIVE',
      source_type: 'SYSTEM',
    })
    .select('id')
    .single();
  assert.ifError(knowledgeInsert.error);
  assert.ok(knowledgeInsert.data?.id);

  const memoryInsert = await service
    .from('ai_customer_memories')
    .insert({
      company_id: scope.companyId,
      customer_id: scope.customerId,
      memory_type: 'FACT',
      memory_key: marker,
      content: 'Customer memory integration test.',
      confidence: 0.9,
      verification_status: 'UNVERIFIED',
      lifecycle_status: 'ACTIVE',
      source_kind: 'SYSTEM',
      source_channel: 'INTERNAL',
      created_by_type: 'SYSTEM',
    })
    .select('id')
    .single();
  assert.ifError(memoryInsert.error);
  assert.ok(memoryInsert.data?.id);

  const anonKnowledge = await anon.from('ai_company_knowledge').select('id').limit(1);
  assert.ok(anonKnowledge.error, 'anon must not have SELECT grant on company knowledge');

  const anonMemory = await anon.from('ai_customer_memories').select('id').limit(1);
  assert.ok(anonMemory.error, 'anon must not have SELECT grant on customer memory');

  const deleteKnowledge = await service
    .from('ai_company_knowledge')
    .delete()
    .eq('id', knowledgeInsert.data.id);
  assert.ok(deleteKnowledge.error, 'service_role intentionally has no DELETE grant on company knowledge');

  const deleteMemory = await service
    .from('ai_customer_memories')
    .delete()
    .eq('id', memoryInsert.data.id);
  assert.ok(deleteMemory.error, 'service_role intentionally has no DELETE grant on customer memory');
});

test('AI inference cannot be stored as a confirmed fact-equivalent memory', async () => {
  const scope = await fixtureScope();
  const result = await service.from('ai_customer_memories').insert({
    company_id: scope.companyId,
    customer_id: scope.customerId,
    memory_type: 'AI_INFERENCE',
    content: 'This should remain an inference, not a confirmed fact.',
    confidence: 0.99,
    verification_status: 'CONFIRMED',
    lifecycle_status: 'ACTIVE',
    source_kind: 'SYSTEM',
    source_channel: 'INTERNAL',
    created_by_type: 'SYSTEM',
    last_verified_at: new Date().toISOString(),
  });
  assert.ok(result.error, 'DB constraint must reject CONFIRMED AI_INFERENCE');
});

test('real context datasource retrieves only scoped active memory and verified company knowledge', async () => {
  const scope = await fixtureScope();
  const token = `brainphase${randomUUID().replaceAll('-', '')}`;

  const knowledgeInsert = await service.from('ai_company_knowledge').insert({
    company_id: scope.companyId,
    category: 'POLICY',
    title: `${token} policy`,
    content: `${token} is a verified policy search marker.`,
    verification_status: 'VERIFIED',
    lifecycle_status: 'ACTIVE',
    source_type: 'SYSTEM',
  });
  assert.ifError(knowledgeInsert.error);

  const unverifiedKnowledgeInsert = await service.from('ai_company_knowledge').insert({
    company_id: scope.companyId,
    category: 'POLICY',
    title: `${token} hidden`,
    content: `${token} unverified marker must not be returned.`,
    verification_status: 'UNVERIFIED',
    lifecycle_status: 'ACTIVE',
    source_type: 'SYSTEM',
  });
  assert.ifError(unverifiedKnowledgeInsert.error);

  const memoryInsert = await service.from('ai_customer_memories').insert({
    company_id: scope.companyId,
    customer_id: scope.customerId,
    memory_type: 'OBJECTION',
    memory_key: token,
    content: `${token} customer objection.`,
    confidence: 0.75,
    verification_status: 'UNVERIFIED',
    lifecycle_status: 'ACTIVE',
    source_kind: 'SYSTEM',
    source_channel: 'INTERNAL',
    created_by_type: 'AI',
  });
  assert.ifError(memoryInsert.error);

  const rejectedMemoryInsert = await service.from('ai_customer_memories').insert({
    company_id: scope.companyId,
    customer_id: scope.customerId,
    memory_type: 'OBJECTION',
    memory_key: `${token}-rejected`,
    content: `${token} rejected memory must not be returned.`,
    confidence: 0.75,
    verification_status: 'REJECTED',
    lifecycle_status: 'ACTIVE',
    source_kind: 'SYSTEM',
    source_channel: 'INTERNAL',
    created_by_type: 'AI',
  });
  assert.ifError(rejectedMemoryInsert.error);

  const source = createSupabaseBrainContextDataSource();
  const knowledge = await source.searchCompanyKnowledge(scope, token);
  assert.ok(knowledge.some((item) => item.content.includes('verified policy search marker')));
  assert.ok(!knowledge.some((item) => item.content.includes('unverified marker')));
  assert.ok(knowledge.every((item) => item.verified === true));

  const memories = await source.getCustomerMemory(scope);
  assert.ok(memories.some((item) => item.memoryKey === token && item.untrustedContent === true));
  assert.ok(!memories.some((item) => item.memoryKey === `${token}-rejected`));
});
