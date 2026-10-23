import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  createSupabaseBrainContextDataSource,
  resolveGroundingContext,
  type BrainContextScope,
} from '../../features/ai-brain';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error('AI Brain Grounding DB test requires local Supabase env');
}

const parsedUrl = new URL(url);
if (!['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
  throw new Error(`Fail-closed: local Supabase URL required (localhost/127.0.0.1), got: ${parsedUrl.hostname}`);
}

const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const FIXTURE_COMPANY_A_ID = '00000000-0000-4000-8000-000000000078';
const FIXTURE_CUSTOMER_A_ID = '00000000-0000-4000-8000-000000000079';
const FIXTURE_COMPANY_B_ID = '00000000-0000-4000-8000-000000000081';
const FIXTURE_CUSTOMER_B_ID = '00000000-0000-4000-8000-000000000082';

async function provisionFixture(): Promise<void> {
  await service
    .from('companies')
    .upsert(
      [
        { id: FIXTURE_COMPANY_A_ID, name: 'AI Brain Phase 7 Fixture A', status: 'ACTIVE' },
        { id: FIXTURE_COMPANY_B_ID, name: 'AI Brain Phase 7 Fixture B', status: 'ACTIVE' },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );

  await service
    .from('customers')
    .upsert(
      [
        {
          id: FIXTURE_CUSTOMER_A_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_code: 'GROUNDING-CUST-A1',
          name: 'Khách hàng Test Grounding A1',
          source: 'ZALO',
          stage: 'LEAD_QUALIFIED',
        },
        {
          id: FIXTURE_CUSTOMER_B_ID,
          company_id: FIXTURE_COMPANY_B_ID,
          customer_code: 'GROUNDING-CUST-B1',
          name: 'Khách hàng Test Grounding B1',
          source: 'ZALO',
          stage: 'LEAD_NEW',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
}

test('Grounding DB: retrieves verified company knowledge via text search and enforces tenant isolation', async () => {
  await provisionFixture();

  const knowledgeAId = randomUUID();
  const knowledgeBId = randomUUID();

  // 1. Insert verified knowledge for Company A
  await service.from('ai_company_knowledge').insert({
    id: knowledgeAId,
    company_id: FIXTURE_COMPANY_A_ID,
    category: 'PRODUCT',
    title: 'Máy bơm chìm tự động Pentax 2HP',
    content: 'Máy bơm chìm Pentax 2HP chuyên dụng chống ngập tầng hầm, công suất 1500W, bảo hành 24 tháng, giá niêm yết 8.200.000 VNĐ.',
    verification_status: 'VERIFIED',
    lifecycle_status: 'ACTIVE',
    source_type: 'MANUAL',
    version: 1,
  });

  // 2. Insert verified knowledge for Company B (Tenant B)
  await service.from('ai_company_knowledge').insert({
    id: knowledgeBId,
    company_id: FIXTURE_COMPANY_B_ID,
    category: 'PRODUCT',
    title: 'Máy bơm Pentax Tenant B',
    content: 'Thông tin bảo mật riêng biệt của doanh nghiệp B.',
    verification_status: 'VERIFIED',
    lifecycle_status: 'ACTIVE',
    source_type: 'MANUAL',
    version: 1,
  });

  // 3. Insert unverified knowledge for Company A (should NOT be retrieved)
  await service.from('ai_company_knowledge').insert({
    company_id: FIXTURE_COMPANY_A_ID,
    category: 'PRODUCT',
    title: 'Sản phẩm thử nghiệm chưa duyệt Pentax',
    content: 'Giá dự kiến 5.000.000 VNĐ nhưng chưa được duyệt.',
    verification_status: 'UNVERIFIED',
    lifecycle_status: 'ACTIVE',
    source_type: 'MANUAL',
    version: 1,
  });

  const convId = randomUUID();
  await service.from('conversations').insert({
    id: convId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    channel: 'ZALO',
    status: 'OPEN',
    ai_mode: 'ACTIVE',
  });

  const scopeA: BrainContextScope = {
    companyId: FIXTURE_COMPANY_A_ID,
    customerId: FIXTURE_CUSTOMER_A_ID,
    conversationId: convId,
    channel: 'ZALO',
    traceId: randomUUID(),
  };

  const dataSource = createSupabaseBrainContextDataSource();

  // Retrieve grounding for inquiry about Pentax
  const groundingA = await resolveGroundingContext({
    scope: scopeA,
    inputText: 'Máy bơm chìm Pentax 2HP có sẵn hàng không và giá bao nhiêu?',
    dataSource,
  });

  assert.ok(groundingA.customer);
  assert.equal(groundingA.customer?.id, FIXTURE_CUSTOMER_A_ID);
  assert.ok(groundingA.customer?.name);

  // Must find verified knowledge for Company A
  assert.ok(groundingA.knowledge.length >= 1);
  const foundItem = groundingA.knowledge.find((k) => k.title.includes('Pentax 2HP'));
  assert.ok(foundItem);
  assert.match(foundItem.content, /8\.200\.000 VNĐ/);

  // Must NOT include unverified knowledge
  const unverifiedItem = groundingA.knowledge.find((k) => k.title.includes('chưa duyệt'));
  assert.equal(unverifiedItem, undefined);

  // Must NOT include Tenant B knowledge
  const tenantBItem = groundingA.knowledge.find((k) => k.title.includes('Tenant B'));
  assert.equal(tenantBItem, undefined);
});

test('Grounding DB: retrieves customer memories with privacy sanitization and tenant isolation', async () => {
  await provisionFixture();

  const convId = randomUUID();
  await service.from('conversations').insert({
    id: convId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    channel: 'ZALO',
    status: 'OPEN',
    ai_mode: 'ACTIVE',
  });

  const scopeA: BrainContextScope = {
    companyId: FIXTURE_COMPANY_A_ID,
    customerId: FIXTURE_CUSTOMER_A_ID,
    conversationId: convId,
    channel: 'ZALO',
    traceId: randomUUID(),
  };

  // Insert valid customer memory for Customer A
  await service.from('ai_customer_memories').insert({
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    memory_type: 'PREFERENCE',
    memory_key: 'preferred_brand',
    content: 'Khách hàng chỉ tin tưởng sử dụng thương hiệu Pentax hoặc Ebara của Ý.',
    confidence: 0.950,
    verification_status: 'CONFIRMED',
    lifecycle_status: 'ACTIVE',
    source_kind: 'MANUAL',
    created_by_type: 'SYSTEM',
    last_verified_at: new Date().toISOString(),
  });

  // Insert memory containing password for Customer A (should be filtered out by sanitizer)
  await service.from('ai_customer_memories').insert({
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    memory_type: 'FACT',
    memory_key: 'secret_leak',
    content: 'Mật khẩu mở cửa tầng hầm của khách: 987654',
    confidence: 0.800,
    verification_status: 'UNVERIFIED',
    lifecycle_status: 'ACTIVE',
    source_kind: 'MANUAL',
    created_by_type: 'SYSTEM',
  });

  const dataSource = createSupabaseBrainContextDataSource();
  const grounding = await resolveGroundingContext({
    scope: scopeA,
    inputText: 'Tư vấn giúp tôi giải pháp chống ngập',
    dataSource,
  });

  assert.ok(grounding.memories.length >= 1);
  const brandPref = grounding.memories.find((m) => m.key === 'preferred_brand');
  assert.ok(brandPref);
  assert.match(brandPref.content, /Ebara của Ý/);
  assert.equal(brandPref.verified, true);

  // Leaked memory must be blocked
  const leak = grounding.memories.find((m) => m.key === 'secret_leak');
  assert.equal(leak, undefined);
});
