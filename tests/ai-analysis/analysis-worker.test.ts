import 'server-only';

import assert from 'assert';
import { createClient } from '@supabase/supabase-js';
import {
  OpenAiCustomerAnalysisModel,
  executeCustomerAnalysis,
  NoAnalyzableSourcesError,
} from '../../features/ai-analysis/services/analysis-worker';
import { FakeDeterministicAiModel } from '../../features/ai-analysis/services/ai-analysis-engine';
import type { AiAnalysisInput } from '../../shared/contracts/ai-analysis';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const COMPANY_ID = 'c1000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c2000000-0000-0000-0000-000000000001';
const EMPTY_CUSTOMER_ID = 'c2000000-0000-0000-0000-000000000002';
const CONVERSATION_ID = 'c3000000-0000-0000-0000-000000000001';

import { execSync } from 'child_process';

function executeRawSql(sql: string) {
  execSync('docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -v ON_ERROR_STOP=1 -U postgres -d postgres', {
    input: sql,
    encoding: 'utf8',
  });
}

async function setupFixtures() {
  console.log('--- Setting up AI Analysis Worker Fixtures ---');

  // Upsert company
  await adminClient.from('companies').upsert({
    id: COMPANY_ID,
    name: 'AI Analysis Worker Test Co',
    status: 'ACTIVE',
  });

  // Clean prior runs via raw SQL
  executeRawSql(`
    DELETE FROM public.ai_analyses WHERE company_id = '${COMPANY_ID}';
    DELETE FROM public.interactions WHERE company_id = '${COMPANY_ID}';
    DELETE FROM public.conversations WHERE company_id = '${COMPANY_ID}';
    DELETE FROM public.customers WHERE company_id = '${COMPANY_ID}';
  `);

  // Upsert customer with stage = LEAD_NEW
  await adminClient.from('customers').upsert([
    {
      id: CUSTOMER_ID,
      company_id: COMPANY_ID,
      name: 'Bác Ba Cửa Lớn',
      stage: 'LEAD_NEW',
      source: 'FACEBOOK',
    },
    {
      id: EMPTY_CUSTOMER_ID,
      company_id: COMPANY_ID,
      name: 'Khách Không Có Tin Nhắn',
      stage: 'LEAD_NEW',
      source: 'WEBSITE',
    },
  ]);

  // Conversation
  await adminClient.from('conversations').upsert({
    id: CONVERSATION_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'FACEBOOK',
    external_conversation_id: 'fb_ai_worker_test',
    status: 'OPEN',
  });

  // Seed interactions with varied statuses and types
  // 1. Valid customer sanitized message (SHOULD BE INGESTED)
  const { error: insErr1 } = await adminClient.from('interactions').upsert({
    id: 'c4000000-0000-0000-0000-000000000001',
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Nhà tôi ở đường Nguyễn Hữu Cảnh, ngập cao 50cm, cửa rộng 4m.',
    created_at: new Date(Date.now() - 3600000).toISOString(),
  });
  if (insErr1) throw new Error(`Insert interaction 1 failed: ${insErr1.message}`);

  // 2. Pending sanitization message (MUST BE EXCLUDED)
  const { error: insErr2 } = await adminClient.from('interactions').upsert({
    id: 'c4000000-0000-0000-0000-000000000002',
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'PENDING',
    sanitized_content: null,
    created_at: new Date(Date.now() - 3000000).toISOString(),
  });
  if (insErr2) throw new Error(`Insert interaction 2 failed: ${insErr2.message}`);

  // 3. Failed sanitization message (MUST BE EXCLUDED)
  const { error: insErr3 } = await adminClient.from('interactions').upsert({
    id: 'c4000000-0000-0000-0000-000000000003',
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'FAILED',
    sanitized_content: null,
    created_at: new Date(Date.now() - 2500000).toISOString(),
  });
  if (insErr3) throw new Error(`Insert interaction 3 failed: ${insErr3.message}`);

  // 4. Internal Note (MUST BE EXCLUDED)
  const { error: insErr4 } = await adminClient.from('interactions').upsert({
    id: 'c4000000-0000-0000-0000-000000000004',
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    channel: 'FACEBOOK',
    type: 'NOTE',
    direction: 'OUTBOUND',
    actor_type: 'SALE',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Ghi chú nội bộ: khách ưu tiên làm trước mùa mưa',
    created_at: new Date(Date.now() - 2000000).toISOString(),
  });
  if (insErr4) throw new Error(`Insert interaction 4 failed: ${insErr4.message}`);

  // 5. Another valid customer message (SHOULD BE INGESTED)
  const { error: insErr5 } = await adminClient.from('interactions').upsert({
    id: 'c4000000-0000-0000-0000-000000000005',
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Báo giá sơ bộ cho tôi nhé, muốn lắp loại tự động hạ sàn.',
    created_at: new Date(Date.now() - 1000000).toISOString(),
  });
  if (insErr5) throw new Error(`Insert interaction 5 failed: ${insErr5.message}`);
}

async function runTests() {
  console.log('================================================================');
  console.log('RUNNING AI CUSTOMER ANALYSIS WORKER TEST SUITE');
  console.log('================================================================');

  await setupFixtures();

  // ============================================================================
  // TEST 1: OpenAiCustomerAnalysisModel configuration & defaults
  // ============================================================================
  console.log('\n--- Test 1: OpenAiCustomerAnalysisModel configuration ---');
  const defaultModel = new OpenAiCustomerAnalysisModel();
  assert(defaultModel.modelVersion === 'gpt-4o-mini', 'Test 1: Default modelVersion is gpt-4o-mini');

  const customModel = new OpenAiCustomerAnalysisModel({ modelVersion: 'gpt-4o' });
  assert(customModel.modelVersion === 'gpt-4o', 'Test 1: Custom modelVersion honored');
  console.log('[PASS] Test 1: OpenAiCustomerAnalysisModel options and modelVersion verified');

  // ============================================================================
  // TEST 2: executeCustomerAnalysis with Fake Model - Sanitized-only Ingestion
  // ============================================================================
  console.log('\n--- Test 2: executeCustomerAnalysis Sanitized-Only Ingestion ---');
  let receivedSourcesCount = 0;
  const testFakeModel = new FakeDeterministicAiModel('test-worker-model-v1', (input: AiAnalysisInput) => {
    receivedSourcesCount = input.sources.length;
    // Verify that only SUCCEEDED customer messages were received
    for (const src of input.sources) {
      assert(typeof src.content === 'string' && src.content.length > 0, 'Source has non-empty sanitized content');
      assert(src.actorType === 'CUSTOMER', 'Source is from CUSTOMER');
    }

    return {
      summary: 'Khách hàng ở Nguyễn Hữu Cảnh cần cửa chống ngập tự động rộng 4m.',
      stageSuggestion: 'NEED_INFO',
      stopReason: null,
      objections: [],
      nextAction: 'Lên lịch khảo sát thực địa',
      confidence: 0.95,
      evidence: 'Nhà tôi ở đường Nguyễn Hữu Cảnh, ngập cao 50cm, cửa rộng 4m.',
      // Intentionally forged modelVersion in raw output: MUST BE IGNORED
      modelVersion: 'FORGED_ATTACKER_MODEL_V999',
    };
  });

  const record = await executeCustomerAnalysis({
    companyId: COMPANY_ID,
    customerId: CUSTOMER_ID,
    model: testFakeModel,
    client: adminClient,
  });

  assert(receivedSourcesCount === 2, `Test 2: Exactly 2 sanitized customer messages ingested (got: ${receivedSourcesCount})`);
  assert(record.id, 'Test 2: Persisted analysis record has valid ID');
  assert(record.modelVersion === 'test-worker-model-v1', `Test 2: ModelVersion is trusted "test-worker-model-v1" (got: ${record.modelVersion})`);
  assert((record.modelVersion as string) !== 'FORGED_ATTACKER_MODEL_V999', 'Test 2: Forged modelVersion strictly discarded');
  assert(record.stageSuggestion === 'NEED_INFO', 'Test 2: stageSuggestion correctly saved');
  assert(record.sourceRefs.length === 2, `Test 2: sourceRefs points to exactly 2 source interactions (got: ${record.sourceRefs.length})`);
  console.log('[PASS] Test 2: Sanitized-only ingestion, source provenance, and forged modelVersion rejection verified');

  // ============================================================================
  // TEST 3: Customer Stage Immutability Invariant
  // ============================================================================
  console.log('\n--- Test 3: Customer Stage Immutability Invariant ---');
  // Verify that despite analysis suggesting 'NEED_SURVEY', customers.stage is UNCHANGED (remains LEAD_NEW)
  const { data: customerAfter } = await adminClient
    .from('customers')
    .select('stage')
    .eq('id', CUSTOMER_ID)
    .single();

  assert(customerAfter?.stage === 'LEAD_NEW', `Test 3: Customer stage remains LEAD_NEW (got: ${customerAfter?.stage})`);
  console.log('[PASS] Test 3: Customer stage remains strictly immutable (LEAD_NEW)');

  // ============================================================================
  // TEST 4: Bounded Limit Parameter
  // ============================================================================
  console.log('\n--- Test 4: Bounded Limit Parameter ---');
  let limitedSourcesCount = 0;
  const limitTestModel = new FakeDeterministicAiModel('test-limit-model', (input: AiAnalysisInput) => {
    limitedSourcesCount = input.sources.length;
    return {
      summary: 'Khách hàng cần tư vấn.',
      stageSuggestion: null,
      stopReason: null,
      objections: [],
      nextAction: 'Liên hệ lại',
      confidence: 0.5,
      evidence: 'Báo giá sơ bộ cho tôi nhé.',
    };
  });

  await executeCustomerAnalysis({
    companyId: COMPANY_ID,
    customerId: CUSTOMER_ID,
    model: limitTestModel,
    limit: 1, // Only 1 most recent message
    client: adminClient,
  });

  assert(limitedSourcesCount === 1, `Test 4: Bounded limit=1 respected (got: ${limitedSourcesCount})`);
  console.log('[PASS] Test 4: Bounded input limit=1 strictly enforced');

  // ============================================================================
  // TEST 5: No Analyzable Sources Error
  // ============================================================================
  console.log('\n--- Test 5: No Analyzable Sources Error ---');
  let thrown = false;
  try {
    await executeCustomerAnalysis({
      companyId: COMPANY_ID,
      customerId: EMPTY_CUSTOMER_ID,
      model: testFakeModel,
      client: adminClient,
    });
  } catch (err) {
    thrown = true;
    assert(err instanceof NoAnalyzableSourcesError, 'Test 5: Error is instance of NoAnalyzableSourcesError');
  }

  assert(thrown, 'Test 5: Throws NoAnalyzableSourcesError when customer has no valid interactions');
  console.log('[PASS] Test 5: Correctly throws NoAnalyzableSourcesError on empty evidence');

  console.log('\n================================================================');
  console.log('AI CUSTOMER ANALYSIS WORKER TEST SUITE: ALL PASSED');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Fatal error in AI Analysis Worker test suite:', err);
  process.exit(1);
});
