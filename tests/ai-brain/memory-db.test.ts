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

const FIXTURE_COMPANY_A_ID = '00000000-0000-4000-8000-000000000078';
const FIXTURE_CUSTOMER_A_ID = '00000000-0000-4000-8000-000000000079';
const FIXTURE_CUSTOMER_A2_ID = '00000000-0000-4000-8000-000000000080';
const FIXTURE_COMPANY_B_ID = '00000000-0000-4000-8000-000000000081';
const FIXTURE_CUSTOMER_B_ID = '00000000-0000-4000-8000-000000000082';
let fixturePromise: Promise<void> | null = null;

async function provisionFixture(): Promise<void> {
  const companyInsert = await service
    .from('companies')
    .upsert(
      [
        { id: FIXTURE_COMPANY_A_ID, name: 'AI Brain Phase 3 CI Fixture A', status: 'ACTIVE' },
        { id: FIXTURE_COMPANY_B_ID, name: 'AI Brain Phase 3 CI Fixture B', status: 'ACTIVE' },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(companyInsert.error);

  const customerInsert = await service
    .from('customers')
    .upsert(
      [
        {
          id: FIXTURE_CUSTOMER_A_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_code: 'AI-BRAIN-PHASE3-A1',
          name: 'AI Brain Phase 3 CI Fixture Customer A1',
          source: 'MANUAL',
          stage: 'LEAD_NEW',
        },
        {
          id: FIXTURE_CUSTOMER_A2_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_code: 'AI-BRAIN-PHASE3-A2',
          name: 'AI Brain Phase 3 CI Fixture Customer A2',
          source: 'MANUAL',
          stage: 'LEAD_NEW',
        },
        {
          id: FIXTURE_CUSTOMER_B_ID,
          company_id: FIXTURE_COMPANY_B_ID,
          customer_code: 'AI-BRAIN-PHASE3-B1',
          name: 'AI Brain Phase 3 CI Fixture Customer B1',
          source: 'MANUAL',
          stage: 'LEAD_NEW',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(customerInsert.error);
}

async function fixtureScope(overrides: Partial<BrainContextScope> = {}): Promise<BrainContextScope> {
  fixturePromise ??= provisionFixture();
  await fixturePromise;
  return {
    companyId: FIXTURE_COMPANY_A_ID,
    customerId: FIXTURE_CUSTOMER_A_ID,
    conversationId: randomUUID(),
    channel: 'INTERNAL',
    traceId: randomUUID(),
    ...overrides,
  };
}

async function createAuthenticatedFixtureClient() {
  const email = `phase3-${randomUUID()}@example.test`;
  const password = `Aa1!${randomUUID()}-${randomUUID()}`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  assert.ok(created.data.user?.id);

  const client = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session);

  return { client, userId: created.data.user.id };
}

test('Phase 3 ACL is private and service_role is limited to SELECT/INSERT/UPDATE', async () => {
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
    .select('id,content')
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
    .select('id,confidence')
    .single();
  assert.ifError(memoryInsert.error);
  assert.ok(memoryInsert.data?.id);

  const knowledgeUpdate = await service
    .from('ai_company_knowledge')
    .update({ content: 'Updated verified company knowledge integration test.' })
    .eq('id', knowledgeInsert.data.id)
    .select('content')
    .single();
  assert.ifError(knowledgeUpdate.error);
  assert.equal(knowledgeUpdate.data?.content, 'Updated verified company knowledge integration test.');

  const memoryUpdate = await service
    .from('ai_customer_memories')
    .update({ confidence: 0.8 })
    .eq('id', memoryInsert.data.id)
    .select('confidence')
    .single();
  assert.ifError(memoryUpdate.error);
  assert.equal(Number(memoryUpdate.data?.confidence), 0.8);

  const anonKnowledge = await anon.from('ai_company_knowledge').select('id').limit(1);
  assert.ok(anonKnowledge.error, 'anon must not have SELECT grant on company knowledge');

  const anonMemory = await anon.from('ai_customer_memories').select('id').limit(1);
  assert.ok(anonMemory.error, 'anon must not have SELECT grant on customer memory');

  const authenticatedFixture = await createAuthenticatedFixtureClient();
  try {
    const authenticatedKnowledge = await authenticatedFixture.client.from('ai_company_knowledge').select('id').limit(1);
    assert.ok(authenticatedKnowledge.error, 'authenticated must not have SELECT grant on company knowledge');

    const authenticatedMemory = await authenticatedFixture.client.from('ai_customer_memories').select('id').limit(1);
    assert.ok(authenticatedMemory.error, 'authenticated must not have SELECT grant on customer memory');
  } finally {
    await authenticatedFixture.client.auth.signOut();
    await service.auth.admin.deleteUser(authenticatedFixture.userId);
  }

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

test('memory verification constraints reject unsafe confirmed state', async () => {
  const scope = await fixtureScope();

  const inferenceResult = await service.from('ai_customer_memories').insert({
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
  assert.ok(inferenceResult.error, 'DB constraint must reject CONFIRMED AI_INFERENCE');

  const unverifiedTimestampResult = await service.from('ai_customer_memories').insert({
    company_id: scope.companyId,
    customer_id: scope.customerId,
    memory_type: 'FACT',
    content: 'Confirmed memory without verification time must fail.',
    confidence: 0.99,
    verification_status: 'CONFIRMED',
    lifecycle_status: 'ACTIVE',
    source_kind: 'SYSTEM',
    source_channel: 'INTERNAL',
    created_by_type: 'SYSTEM',
  });
  assert.ok(unverifiedTimestampResult.error, 'CONFIRMED memory must require last_verified_at');
});

test('real datasource enforces customer/company scope, lifecycle and verification filters', async () => {
  const scope = await fixtureScope();
  const token = `brainphase${randomUUID().replaceAll('-', '')}`;

  const knowledgeInsert = await service.from('ai_company_knowledge').insert([
    {
      company_id: scope.companyId,
      category: 'POLICY',
      title: `${token} policy`,
      content: `${token} verified active company A marker.`,
      verification_status: 'VERIFIED',
      lifecycle_status: 'ACTIVE',
      source_type: 'SYSTEM',
    },
    {
      company_id: scope.companyId,
      category: 'POLICY',
      title: `${token} unverified`,
      content: `${token} unverified marker must not be returned.`,
      verification_status: 'UNVERIFIED',
      lifecycle_status: 'ACTIVE',
      source_type: 'SYSTEM',
    },
    {
      company_id: scope.companyId,
      category: 'POLICY',
      title: `${token} archived`,
      content: `${token} archived marker must not be returned.`,
      verification_status: 'VERIFIED',
      lifecycle_status: 'ARCHIVED',
      source_type: 'SYSTEM',
    },
    {
      company_id: FIXTURE_COMPANY_B_ID,
      category: 'POLICY',
      title: `${token} other company`,
      content: `${token} company B marker must not cross tenant scope.`,
      verification_status: 'VERIFIED',
      lifecycle_status: 'ACTIVE',
      source_type: 'SYSTEM',
    },
  ]);
  assert.ifError(knowledgeInsert.error);

  const memoryInsert = await service.from('ai_customer_memories').insert([
    {
      company_id: scope.companyId,
      customer_id: scope.customerId,
      memory_type: 'OBJECTION',
      memory_key: token,
      content: `${token} active customer A memory.`,
      confidence: 0.75,
      verification_status: 'UNVERIFIED',
      lifecycle_status: 'ACTIVE',
      source_kind: 'SYSTEM',
      source_channel: 'INTERNAL',
      created_by_type: 'AI',
    },
    {
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
    },
    {
      company_id: scope.companyId,
      customer_id: scope.customerId,
      memory_type: 'TEMPORARY_CONTEXT',
      memory_key: `${token}-superseded`,
      content: `${token} superseded memory must not be returned.`,
      confidence: 0.6,
      verification_status: 'UNVERIFIED',
      lifecycle_status: 'SUPERSEDED',
      source_kind: 'SYSTEM',
      source_channel: 'INTERNAL',
      created_by_type: 'AI',
    },
    {
      company_id: scope.companyId,
      customer_id: FIXTURE_CUSTOMER_A2_ID,
      memory_type: 'FACT',
      memory_key: `${token}-other-customer`,
      content: `${token} customer A2 memory must not cross customer scope.`,
      confidence: 0.9,
      verification_status: 'UNVERIFIED',
      lifecycle_status: 'ACTIVE',
      source_kind: 'INTERACTION',
      source_channel: 'MESSENGER',
      source_ref_id: FIXTURE_CUSTOMER_A_ID,
      created_by_type: 'SYSTEM',
    },
    {
      company_id: FIXTURE_COMPANY_B_ID,
      customer_id: FIXTURE_CUSTOMER_B_ID,
      memory_type: 'FACT',
      memory_key: `${token}-other-company`,
      content: `${token} company B memory must not cross tenant scope.`,
      confidence: 0.9,
      verification_status: 'UNVERIFIED',
      lifecycle_status: 'ACTIVE',
      source_kind: 'SYSTEM',
      source_channel: 'INTERNAL',
      created_by_type: 'SYSTEM',
    },
  ]);
  assert.ifError(memoryInsert.error);

  const source = createSupabaseBrainContextDataSource();
  const knowledge = await source.searchCompanyKnowledge(scope, token);
  assert.ok(knowledge.some((item) => item.content.includes('verified active company A marker')));
  assert.ok(!knowledge.some((item) => item.content.includes('unverified marker')));
  assert.ok(!knowledge.some((item) => item.content.includes('archived marker')));
  assert.ok(!knowledge.some((item) => item.content.includes('company B marker')));
  assert.ok(knowledge.every((item) => item.verified === true));

  const memories = await source.getCustomerMemory(scope);
  assert.ok(memories.some((item) => item.memoryKey === token && item.untrustedContent === true));
  assert.ok(!memories.some((item) => item.memoryKey === `${token}-rejected`));
  assert.ok(!memories.some((item) => item.memoryKey === `${token}-superseded`));
  assert.ok(!memories.some((item) => item.memoryKey === `${token}-other-customer`));
  assert.ok(!memories.some((item) => item.memoryKey === `${token}-other-company`));
});
