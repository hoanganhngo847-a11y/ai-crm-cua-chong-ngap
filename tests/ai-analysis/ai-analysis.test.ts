import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  fetchAiAnalysisInput,
  persistAiAnalysis,
} from '../../features/ai-analysis/services/ai-analysis-store';
import {
  validateAiAnalysisOutput,
  AiAnalysisValidationError,
} from '../../features/ai-analysis/services/validate-ai-analysis';
import {
  runCustomerAnalysisPipeline,
  FakeDeterministicAiModel,
} from '../../features/ai-analysis/services/ai-analysis-engine';
import type {
  AiCustomerAnalysisOutput,
  AiAnalysisSourceRef,
  AiAnalysisInput,
  AiAnalysisStageSuggestion,
} from '../../shared/contracts/ai-analysis';

// Local Supabase configuration
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function createAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Deterministic UUID fixtures
const COMPANY_A_ID = '80000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = '80000000-0000-0000-0000-000000000002';

const CUSTOMER_A1_ID = '81000000-0000-0000-0000-000000000001';
const CUSTOMER_A2_ID = '81000000-0000-0000-0000-000000000002';
const CUSTOMER_B1_ID = '81000000-0000-0000-0000-000000000003';
const CUSTOMER_PAGING_ID = '81000000-0000-0000-0000-000000000004';

const CONVO_A1_ID = '82000000-0000-0000-0000-000000000001';
const CONVO_A2_ID = '82000000-0000-0000-0000-000000000002';
const CONVO_B1_ID = '82000000-0000-0000-0000-000000000003';
const CONVO_PAGING_ID = '82000000-0000-0000-0000-000000000004';

const INT_A1_SUCCEEDED_1 = '83000000-0000-0000-0000-000000000001';
const INT_A1_PENDING = '83000000-0000-0000-0000-000000000002';
const INT_A1_FAILED = '83000000-0000-0000-0000-000000000003';
const INT_A1_SUCCEEDED_2 = '83000000-0000-0000-0000-000000000004';
const INT_A2_SUCCEEDED = '83000000-0000-0000-0000-000000000005';
const INT_B1_SUCCEEDED = '83000000-0000-0000-0000-000000000006';
const INT_A1_NOTE_SUCCEEDED = '83000000-0000-0000-0000-000000000007';

// Users
const USER_BOSS = { email: 'ai_boss@trusted.local', password: 'Password123!' };
const USER_SALE = { email: 'ai_sale@trusted.local', password: 'Password123!' };
const USER_TECH = { email: 'ai_tech@trusted.local', password: 'Password123!' };
const USER_SALE_B = { email: 'ai_sale_b@trusted.local', password: 'Password123!' };

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${message}`);
    failCount++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function setupDatabaseFixtures() {
  console.log('--- Setting up AI Analysis test database fixtures ---');

  // 1. Companies
  const { error: errComp } = await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'AI Test Company A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'AI Test Company B', status: 'ACTIVE' },
  ]);
  if (errComp) throw new Error(`Companies upsert failed: ${errComp.message}`);

  // Helper to ensure auth user and company membership
  async function ensureUser(
    config: { email: string; password: string; fullName: string },
    companyId: string,
    role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN'
  ) {
    const { data: list } = await adminClient.auth.admin.listUsers();
    const existing = list?.users.find((u) => u.email === config.email);

    let userId = existing?.id;
    if (!userId) {
      const { data, error } = await adminClient.auth.admin.createUser({
        email: config.email,
        password: config.password,
        email_confirm: true,
        user_metadata: { full_name: config.fullName },
      });
      if (error || !data.user) {
        throw new Error(`Failed to create ${config.email}: ${error?.message}`);
      }
      userId = data.user.id;
    }

    await adminClient.from('user_profiles').upsert({
      id: userId,
      full_name: config.fullName,
      status: 'ACTIVE',
    });

    const { error: memberErr } = await adminClient.from('company_members').upsert(
      {
        company_id: companyId,
        user_id: userId,
        role,
        status: 'ACTIVE',
      },
      { onConflict: 'company_id,user_id' }
    );
    if (memberErr) {
      throw new Error(`Failed to configure member ${config.email}: ${memberErr.message}`);
    }
  }

  await ensureUser({ ...USER_BOSS, fullName: 'AI Sếp Quản Trị' }, COMPANY_A_ID, 'BOSS_ADMIN');
  await ensureUser({ ...USER_SALE, fullName: 'AI Nhân Viên Sale' }, COMPANY_A_ID, 'SALE');
  await ensureUser({ ...USER_TECH, fullName: 'AI Kỹ Thuật Viên' }, COMPANY_A_ID, 'TECHNICIAN');
  await ensureUser({ ...USER_SALE_B, fullName: 'AI Sale Công Ty B' }, COMPANY_B_ID, 'SALE');

  // 2. Customers
  const { error: errCust } = await adminClient.from('customers').upsert([
    {
      id: CUSTOMER_A1_ID,
      company_id: COMPANY_A_ID,
      customer_code: 'KH-AI-001',
      name: 'Khách AI A1',
      source: 'FACEBOOK',
      stage: 'LEAD_NEW',
    },
    {
      id: CUSTOMER_A2_ID,
      company_id: COMPANY_A_ID,
      customer_code: 'KH-AI-002',
      name: 'Khách AI A2',
      source: 'ZALO',
      stage: 'CONTACT_CYCLE_1',
    },
    {
      id: CUSTOMER_B1_ID,
      company_id: COMPANY_B_ID,
      customer_code: 'KH-AI-B01',
      name: 'Khách AI B1',
      source: 'WEBSITE',
      stage: 'LEAD_NEW',
    },
    {
      id: CUSTOMER_PAGING_ID,
      company_id: COMPANY_A_ID,
      customer_code: 'KH-AI-PAG',
      name: 'Khách AI Phân Trang',
      source: 'FACEBOOK',
      stage: 'LEAD_NEW',
    },
  ]);
  if (errCust) throw new Error(`Customers upsert failed: ${errCust.message}`);

  // 3. Conversations
  const { error: errConvo } = await adminClient.from('conversations').upsert([
    {
      id: CONVO_A1_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A1_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'ext_ai_a1',
      status: 'OPEN',
    },
    {
      id: CONVO_A2_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A2_ID,
      channel: 'ZALO',
      external_conversation_id: 'ext_ai_a2',
      status: 'OPEN',
    },
    {
      id: CONVO_B1_ID,
      company_id: COMPANY_B_ID,
      customer_id: CUSTOMER_B1_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'ext_ai_b1',
      status: 'OPEN',
    },
    {
      id: CONVO_PAGING_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_PAGING_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'ext_ai_pag',
      status: 'OPEN',
    },
  ]);
  if (errConvo) throw new Error(`Conversations upsert failed: ${errConvo.message}`);

  const now = new Date();
  const past5Min = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const past4Min = new Date(now.getTime() - 4 * 60 * 1000).toISOString();
  const past3Min = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
  const past2Min = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const past1Min = new Date(now.getTime() - 1 * 60 * 1000).toISOString();

  // 4. Interactions
  const { error: errInt } = await adminClient.from('interactions').upsert([
    // Customer A1 - SUCCEEDED (MESSAGE)
    {
      id: INT_A1_SUCCEEDED_1,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A1_ID,
      conversation_id: CONVO_A1_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Chào công ty, cửa nhà tôi rộng 3 mét, đợt triều cường vừa rồi ngập 40cm, muốn lắp cửa chống ngập tự động.',
      sanitization_status: 'SUCCEEDED',
      sanitized_at: past5Min,
      created_at: past5Min,
    },
    // Customer A1 - PENDING (MESSAGE)
    {
      id: INT_A1_PENDING,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A1_ID,
      conversation_id: CONVO_A1_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: null,
      sanitization_status: 'PENDING',
      created_at: past4Min,
    },
    // Customer A1 - FAILED (MESSAGE)
    {
      id: INT_A1_FAILED,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A1_ID,
      conversation_id: CONVO_A1_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: null,
      sanitization_status: 'FAILED',
      created_at: past3Min,
    },
    // Customer A1 - SUCCEEDED 2 (MESSAGE)
    {
      id: INT_A1_SUCCEEDED_2,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A1_ID,
      conversation_id: CONVO_A1_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Giá khoảng bao nhiêu vậy shop? Có thể gửi kỹ thuật qua đo khảo sát không?',
      sanitization_status: 'SUCCEEDED',
      sanitized_at: past2Min,
      created_at: past2Min,
    },
    // Customer A1 - NOTE (type = NOTE, should NOT be read by AI in M9.3)
    {
      id: INT_A1_NOTE_SUCCEEDED,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A1_ID,
      conversation_id: CONVO_A1_ID,
      channel: 'FACEBOOK',
      type: 'NOTE',
      direction: 'INBOUND',
      actor_type: 'SALE',
      sanitized_content: 'Ghi chú nội bộ của sale: khách rất tiềm năng.',
      sanitization_status: 'SUCCEEDED',
      sanitized_at: past1Min,
      created_at: past1Min,
    },
    // Customer A2 - SUCCEEDED (Company A)
    {
      id: INT_A2_SUCCEEDED,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A2_ID,
      conversation_id: CONVO_A2_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Tôi muốn hỏi chính sách bảo hành.',
      sanitization_status: 'SUCCEEDED',
      sanitized_at: past1Min,
      created_at: past1Min,
    },
    // Customer B1 - SUCCEEDED (Company B)
    {
      id: INT_B1_SUCCEEDED,
      company_id: COMPANY_B_ID,
      customer_id: CUSTOMER_B1_ID,
      conversation_id: CONVO_B1_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Khách hàng công ty B cần báo giá.',
      sanitization_status: 'SUCCEEDED',
      sanitized_at: past1Min,
      created_at: past1Min,
    },
  ]);
  if (errInt) throw new Error(`Interactions upsert failed: ${errInt.message}`);

  // 5. Raw contents for INT_A1_SUCCEEDED_1 (to verify it never leaks)
  await adminClient.from('interaction_raw_contents').upsert({
    interaction_id: INT_A1_SUCCEEDED_1,
    company_id: COMPANY_A_ID,
    raw_content: 'Raw message with phone 0912345678 and secret token XYZ',
    raw_payload: { rawPhone: '0912345678', secret: 'PRIVATE_SECRET_123' },
  });

  // 6. Setup 105 interactions for Customer Paging test
  const pagingInteractions = [];
  const baseTime = now.getTime() - 200 * 60 * 1000;
  for (let i = 1; i <= 105; i++) {
    const timeIso = new Date(baseTime + i * 60 * 1000).toISOString();
    pagingInteractions.push({
      id: `84000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_PAGING_ID,
      conversation_id: CONVO_PAGING_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: `Tin nhắn thứ #${i} từ khách hàng cần hỗ trợ.`,
      sanitization_status: 'SUCCEEDED',
      sanitized_at: timeIso,
      created_at: timeIso,
    });
  }
  const { error: errPaging } = await adminClient.from('interactions').upsert(pagingInteractions);
  if (errPaging) throw new Error(`Paging interactions upsert failed: ${errPaging.message}`);
}

async function runAllTests() {
  console.log('\n==================================================');
  console.log('STARTING SECURE AI CUSTOMER ANALYSIS TESTS (M9.3)');
  console.log('==================================================\n');

  await setupDatabaseFixtures();

  // Create authenticated client sessions
  const bossClient = createAnonClient();
  await bossClient.auth.signInWithPassword(USER_BOSS);

  const saleClient = createAnonClient();
  await saleClient.auth.signInWithPassword(USER_SALE);

  const techClient = createAnonClient();
  await techClient.auth.signInWithPassword(USER_TECH);

  const saleBClient = createAnonClient();
  await saleBClient.auth.signInWithPassword(USER_SALE_B);

  // ---------------------------------------------------------------------------
  // Test 1: same-company sanitized interactions -> input được trả
  // ---------------------------------------------------------------------------
  const inputA1 = await fetchAiAnalysisInput(adminClient, {
    companyId: COMPANY_A_ID,
    customerId: CUSTOMER_A1_ID,
  });
  assert(
    inputA1.sources.length >= 2,
    'Test 1: same-company sanitized interactions returned in input'
  );
  assert(
    inputA1.customer.customerCode === 'KH-AI-001',
    'Test 1: customer safe context includes customerCode'
  );

  // ---------------------------------------------------------------------------
  // Test 2: wrong company -> denied/no data
  // ---------------------------------------------------------------------------
  let test2Denied = false;
  try {
    await fetchAiAnalysisInput(adminClient, {
      companyId: COMPANY_B_ID,
      customerId: CUSTOMER_A1_ID, // Customer A1 belongs to Company A
    });
  } catch (err: unknown) {
    test2Denied = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(
      msg.includes('TENANT_MISMATCH') || msg.includes('42501'),
      `Test 2: wrong company throws TENANT_MISMATCH (got: ${msg})`
    );
  }
  assert(test2Denied, 'Test 2: wrong company access denied fail-closed');

  // ---------------------------------------------------------------------------
  // Test 3: wrong customer -> denied/no data
  // ---------------------------------------------------------------------------
  let test3Denied = false;
  try {
    await fetchAiAnalysisInput(adminClient, {
      companyId: COMPANY_A_ID,
      customerId: '81000000-0000-0000-0000-999999999999', // non-existent customer
    });
  } catch (err: unknown) {
    test3Denied = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(
      msg.includes('CUSTOMER_NOT_FOUND') || msg.includes('P0002'),
      `Test 3: wrong customer throws CUSTOMER_NOT_FOUND (got: ${msg})`
    );
  }
  assert(test3Denied, 'Test 3: non-existent customer access denied fail-closed');

  // ---------------------------------------------------------------------------
  // Test 4: PENDING sanitized interaction -> không được AI đọc
  // ---------------------------------------------------------------------------
  const hasPending = inputA1.sources.some((s) => s.interactionId === INT_A1_PENDING);
  assert(!hasPending, 'Test 4: PENDING sanitized interaction is NOT read by AI');

  // ---------------------------------------------------------------------------
  // Test 5: FAILED sanitization -> không đọc
  // ---------------------------------------------------------------------------
  const hasFailed = inputA1.sources.some((s) => s.interactionId === INT_A1_FAILED);
  assert(!hasFailed, 'Test 5: FAILED sanitization interaction is NOT read by AI');

  // ---------------------------------------------------------------------------
  // Test 6: SUCCEEDED + sanitized_content -> được đọc
  // ---------------------------------------------------------------------------
  const hasSucceeded1 = inputA1.sources.some((s) => s.interactionId === INT_A1_SUCCEEDED_1);
  const hasSucceeded2 = inputA1.sources.some((s) => s.interactionId === INT_A1_SUCCEEDED_2);
  assert(
    hasSucceeded1 && hasSucceeded2,
    'Test 6: SUCCEEDED interactions with sanitized_content are read successfully'
  );

  // ---------------------------------------------------------------------------
  // Test 7: raw/private content không xuất hiện trong DTO
  // ---------------------------------------------------------------------------
  const dtoString = JSON.stringify(inputA1);
  assert(
    !dtoString.includes('0912345678'),
    'Test 7: Raw phone number does NOT appear in AI input DTO'
  );
  assert(
    !dtoString.includes('PRIVATE_SECRET_123'),
    'Test 7: Private raw payload does NOT appear in AI input DTO'
  );
  assert(
    !dtoString.includes('raw_content'),
    'Test 7: Raw content property is absent from input DTO'
  );

  // ---------------------------------------------------------------------------
  // Test 8: validator accepts valid result
  // ---------------------------------------------------------------------------
  const validOutput: AiCustomerAnalysisOutput = {
    summary: 'Khách hàng có nhu cầu bảo vệ nhà trước đợt triều cường, cửa rộng 3m.',
    stageSuggestion: 'SURVEY_REQUESTED',
    stopReason: 'Cần biết báo giá dự toán trước khi quyết định.',
    objections: ['Băn khoăn về chi phí lắp đặt', 'Lo ngại tính thẩm mỹ của cửa'],
    nextAction: 'Gửi bảng giá sơ bộ và đề xuất đặt lịch kỹ thuật khảo sát tận nơi.',
    confidence: 0.85,
    evidence: 'Cửa rộng 3 mét, đợt triều cường vừa rồi ngập 40cm, muốn khảo sát.',
  };
  const validated = validateAiAnalysisOutput(validOutput);
  assert(validated.confidence === 0.85, 'Test 8: validator accepts valid result correctly');

  // ---------------------------------------------------------------------------
  // Test 9: confidence < 0 -> reject
  // ---------------------------------------------------------------------------
  let test9ValidatorRejected = false;
  try {
    validateAiAnalysisOutput({ ...validOutput, confidence: -0.05 });
  } catch (err) {
    if (err instanceof AiAnalysisValidationError) test9ValidatorRejected = true;
  }
  assert(test9ValidatorRejected, 'Test 9: validator rejects confidence < 0');

  const { error: test9RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: 'Test summary',
    p_confidence: -0.1,
    p_evidence: 'Test evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test9RpcErr !== null && test9RpcErr.message.includes('INVALID_CONFIDENCE'),
    'Test 9: RPC rejects confidence < 0'
  );

  // ---------------------------------------------------------------------------
  // Test 10: confidence > 1 -> reject
  // ---------------------------------------------------------------------------
  let test10ValidatorRejected = false;
  try {
    validateAiAnalysisOutput({ ...validOutput, confidence: 1.05 });
  } catch (err) {
    if (err instanceof AiAnalysisValidationError) test10ValidatorRejected = true;
  }
  assert(test10ValidatorRejected, 'Test 10: validator rejects confidence > 1');

  const { error: test10RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: 'Test summary',
    p_confidence: 1.5,
    p_evidence: 'Test evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test10RpcErr !== null && test10RpcErr.message.includes('INVALID_CONFIDENCE'),
    'Test 10: RPC rejects confidence > 1'
  );

  // ---------------------------------------------------------------------------
  // Test 11: invalid stage -> reject
  // ---------------------------------------------------------------------------
  let test11ValidatorRejected = false;
  try {
    validateAiAnalysisOutput({
      ...validOutput,
      stageSuggestion: 'STAGE_NOT_IN_ALLOWLIST' as unknown as AiAnalysisStageSuggestion,
    });
  } catch (err) {
    if (err instanceof AiAnalysisValidationError) test11ValidatorRejected = true;
  }
  assert(test11ValidatorRejected, 'Test 11: validator rejects invalid stage suggestion');

  const { error: test11RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: 'Test summary',
    p_stage_suggestion: 'STAGE_NOT_IN_ALLOWLIST',
    p_confidence: 0.5,
    p_evidence: 'Test evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test11RpcErr !== null && test11RpcErr.message.includes('INVALID_STAGE_SUGGESTION'),
    'Test 11: RPC rejects invalid stage suggestion'
  );

  // ---------------------------------------------------------------------------
  // Test 12: empty summary -> reject
  // ---------------------------------------------------------------------------
  let test12ValidatorRejected = false;
  try {
    validateAiAnalysisOutput({ ...validOutput, summary: '   ' });
  } catch (err) {
    if (err instanceof AiAnalysisValidationError) test12ValidatorRejected = true;
  }
  assert(test12ValidatorRejected, 'Test 12: validator rejects empty summary');

  const { error: test12RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: '   ',
    p_confidence: 0.5,
    p_evidence: 'Test evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test12RpcErr !== null && test12RpcErr.message.includes('EMPTY_SUMMARY'),
    'Test 12: RPC rejects empty summary'
  );

  // ---------------------------------------------------------------------------
  // Test 13: invalid objections structure -> reject
  // ---------------------------------------------------------------------------
  let test13ValidatorRejected = false;
  try {
    validateAiAnalysisOutput({ ...validOutput, objections: 'not-an-array' as unknown as string[] });
  } catch (err) {
    if (err instanceof AiAnalysisValidationError) test13ValidatorRejected = true;
  }
  assert(test13ValidatorRejected, 'Test 13: validator rejects non-array objections');

  const { error: test13RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: 'Test summary',
    p_objections: '"not-an-array"' as unknown as string[],
    p_confidence: 0.5,
    p_evidence: 'Test evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test13RpcErr !== null && test13RpcErr.message.includes('INVALID_OBJECTIONS_STRUCTURE'),
    'Test 13: RPC rejects non-array objections'
  );

  // ---------------------------------------------------------------------------
  // Test 14: invalid source_refs tenant -> persist denied
  // ---------------------------------------------------------------------------
  const { error: test14RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_B1_SUCCEEDED }], // Belongs to Company B
    p_summary: 'Cross-tenant analysis attempt',
    p_confidence: 0.5,
    p_evidence: 'Some evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test14RpcErr !== null && test14RpcErr.message.includes('SOURCE_INTERACTION_TENANT_MISMATCH'),
    'Test 14: invalid source_refs tenant rejected with SOURCE_INTERACTION_TENANT_MISMATCH'
  );

  // ---------------------------------------------------------------------------
  // Test 15: source interaction của Customer khác -> denied
  // ---------------------------------------------------------------------------
  const { error: test15RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A2_SUCCEEDED }], // Same company, different customer A2
    p_summary: 'Cross-customer analysis attempt',
    p_confidence: 0.5,
    p_evidence: 'Some evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test15RpcErr !== null && test15RpcErr.message.includes('SOURCE_INTERACTION_CUSTOMER_MISMATCH'),
    'Test 15: source interaction of different customer rejected with SOURCE_INTERACTION_CUSTOMER_MISMATCH'
  );

  // ---------------------------------------------------------------------------
  // Test 16: valid analysis -> insert thành công
  // ---------------------------------------------------------------------------
  const validSourceRefs: AiAnalysisSourceRef[] = [
    { type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 },
    { type: 'INTERACTION', id: INT_A1_SUCCEEDED_2 },
  ];

  const analysis1 = await persistAiAnalysis(adminClient, {
    companyId: COMPANY_A_ID,
    customerId: CUSTOMER_A1_ID,
    sourceRefs: validSourceRefs,
    analysis: validOutput,
    modelVersion: 'gpt-4o-2026-09-v1',
  });
  assert(typeof analysis1.id === 'string', 'Test 16: valid analysis persisted successfully with UUID');
  assert(analysis1.companyId === COMPANY_A_ID, 'Test 16: persisted analysis has correct companyId');
  assert(analysis1.customerId === CUSTOMER_A1_ID, 'Test 16: persisted analysis has correct customerId');
  assert(analysis1.confidence === 0.85, 'Test 16: persisted analysis has exact confidence');

  // ---------------------------------------------------------------------------
  // Test 17: insert tạo record mới, không overwrite analysis trước
  // ---------------------------------------------------------------------------
  const validOutput2: AiCustomerAnalysisOutput = {
    ...validOutput,
    summary: 'Phân tích lần hai sau khi khách nhắn thêm thông tin chi tiết.',
    stageSuggestion: 'PRICE_CALCULATED',
    confidence: 0.9,
  };
  const analysis2 = await persistAiAnalysis(adminClient, {
    companyId: COMPANY_A_ID,
    customerId: CUSTOMER_A1_ID,
    sourceRefs: validSourceRefs,
    analysis: validOutput2,
    modelVersion: 'gpt-4o-2026-09-v1',
  });
  assert(analysis2.id !== analysis1.id, 'Test 17: Second analysis creates a distinct new record ID');

  // Verify records via authorized bossClient (since direct service_role SELECT is revoked!)
  const { data: analysesList } = await bossClient
    .from('ai_analyses')
    .select('id')
    .eq('customer_id', CUSTOMER_A1_ID);
  assert(
    (analysesList?.length || 0) >= 2,
    'Test 17: Both analysis records exist in database (append-only history)'
  );

  // ---------------------------------------------------------------------------
  // Test 18: analysis không đổi customers.stage
  // ---------------------------------------------------------------------------
  const { data: customerAfter } = await bossClient
    .from('customers')
    .select('stage')
    .eq('id', CUSTOMER_A1_ID)
    .single();
  assert(
    customerAfter?.stage === 'LEAD_NEW',
    `Test 18: Customer stage remains LEAD_NEW (got: ${customerAfter?.stage}) - ZERO stage mutation`
  );

  // ---------------------------------------------------------------------------
  // Test 19: analysis không tạo stage history
  // ---------------------------------------------------------------------------
  const { data: stageHistories } = await bossClient
    .from('customer_stage_histories')
    .select('id')
    .eq('customer_id', CUSTOMER_A1_ID);
  assert(
    (stageHistories?.length || 0) === 0,
    'Test 19: Zero customer_stage_histories records created by AI analysis'
  );

  // ---------------------------------------------------------------------------
  // Test 20: authenticated browser không thể INSERT ai_analyses
  // ---------------------------------------------------------------------------
  const { error: bossInsertErr } = await bossClient.from('ai_analyses').insert({
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A1_ID,
    source_refs: validSourceRefs,
    summary: 'Direct client insert attempt',
    confidence: 0.5,
    evidence: 'Evidence',
    model_version: 'direct',
  });
  assert(
    bossInsertErr !== null,
    'Test 20: Authenticated browser (Boss) cannot INSERT ai_analyses directly'
  );

  const { error: saleInsertErr } = await saleClient.from('ai_analyses').insert({
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A1_ID,
    source_refs: validSourceRefs,
    summary: 'Direct sale insert attempt',
    confidence: 0.5,
    evidence: 'Evidence',
    model_version: 'direct',
  });
  assert(
    saleInsertErr !== null,
    'Test 20: Authenticated browser (Sale) cannot INSERT ai_analyses directly'
  );

  // ---------------------------------------------------------------------------
  // Test 21: TECHNICIAN không SELECT analysis
  // ---------------------------------------------------------------------------
  const { data: techData } = await techClient
    .from('ai_analyses')
    .select('*')
    .eq('customer_id', CUSTOMER_A1_ID);
  assert(
    !techData || techData.length === 0,
    'Test 21: TECHNICIAN receives 0 rows when selecting ai_analyses'
  );

  // ---------------------------------------------------------------------------
  // Test 22: SALE same-company SELECT được
  // ---------------------------------------------------------------------------
  const { data: saleData } = await saleClient
    .from('ai_analyses')
    .select('*')
    .eq('customer_id', CUSTOMER_A1_ID);
  assert(
    (saleData?.length || 0) >= 2,
    'Test 22: SALE in same company can SELECT ai_analyses'
  );

  // ---------------------------------------------------------------------------
  // Test 23: SALE wrong-company không SELECT được
  // ---------------------------------------------------------------------------
  const { data: saleBData } = await saleBClient
    .from('ai_analyses')
    .select('*')
    .eq('customer_id', CUSTOMER_A1_ID);
  assert(
    !saleBData || saleBData.length === 0,
    'Test 23: SALE in Company B receives 0 rows for Company A customer analysis'
  );

  // ---------------------------------------------------------------------------
  // Test 24: BOSS_ADMIN same-company SELECT được
  // ---------------------------------------------------------------------------
  const { data: bossData } = await bossClient
    .from('ai_analyses')
    .select('*')
    .eq('customer_id', CUSTOMER_A1_ID);
  assert(
    (bossData?.length || 0) >= 2,
    'Test 24: BOSS_ADMIN in same company can SELECT ai_analyses'
  );

  // ---------------------------------------------------------------------------
  // Test 25: direct service_role mutation & SELECT nếu đã bị revoke -> denied
  // ---------------------------------------------------------------------------
  const { error: directServiceRoleInsertErr } = await adminClient.from('ai_analyses').insert({
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A1_ID,
    source_refs: validSourceRefs,
    summary: 'Direct service_role mutation attempt',
    confidence: 0.5,
    evidence: 'Evidence',
    model_version: 'direct',
  });
  assert(
    directServiceRoleInsertErr !== null &&
      (directServiceRoleInsertErr.code === '42501' ||
        directServiceRoleInsertErr.message.includes('permission denied')),
    'Test 25: Direct service_role INSERT denied by PostgreSQL table ACL revocation'
  );

  const { error: directServiceRoleSelectErr } = await adminClient.from('ai_analyses').select('*');
  assert(
    directServiceRoleSelectErr !== null &&
      (directServiceRoleSelectErr.code === '42501' ||
        directServiceRoleSelectErr.message.includes('permission denied')),
    'Test 25b: Direct service_role SELECT denied by complete table ACL revocation'
  );

  // ---------------------------------------------------------------------------
  // Test 26: bounded persist RPC vẫn thành công
  // ---------------------------------------------------------------------------
  const analysis3 = await persistAiAnalysis(adminClient, {
    companyId: COMPANY_A_ID,
    customerId: CUSTOMER_A1_ID,
    sourceRefs: validSourceRefs,
    analysis: {
      ...validOutput,
      summary: 'Bounded persist RPC execution test',
    },
    modelVersion: 'trusted-rpc-v1',
  });
  assert(
    typeof analysis3.id === 'string',
    'Test 26: Bounded persist RPC succeeds when called by service_role'
  );

  // ---------------------------------------------------------------------------
  // Test 27: fake model malformed output -> pipeline fail closed
  // ---------------------------------------------------------------------------
  const malformedModel = new FakeDeterministicAiModel('test-malformed-v1', {
    summary: '', // Invalid empty summary
    confidence: 2.0, // Invalid confidence > 1
  });

  let test27PipelineFailed = false;
  try {
    await runCustomerAnalysisPipeline({
      model: malformedModel,
      companyId: COMPANY_A_ID,
      customerId: CUSTOMER_A1_ID,
      client: adminClient,
    });
  } catch (err) {
    if (err instanceof AiAnalysisValidationError) {
      test27PipelineFailed = true;
    }
  }
  assert(test27PipelineFailed, 'Test 27: Malformed model output causes pipeline to fail closed');

  // ---------------------------------------------------------------------------
  // Test 28: fake valid model -> persist đúng source refs/model_version
  // ---------------------------------------------------------------------------
  const deterministicModel = new FakeDeterministicAiModel(
    'trusted-pipeline-v1',
    (input: AiAnalysisInput) => ({
      summary: `Phân tích tự động dựa trên ${input.sources.length} tương tác của khách ${input.customer.name}`,
      stageSuggestion: 'SURVEY_REQUESTED' as const,
      stopReason: null,
      objections: ['Đang cân nhắc phương án kỹ thuật'],
      nextAction: 'Liên hệ tư vấn kích thước chi tiết',
      confidence: 0.92,
      evidence: `Khách hàng đề cập: "${input.sources[0]?.content}"`,
    })
  );

  const pipelineResult = await runCustomerAnalysisPipeline({
    model: deterministicModel,
    companyId: COMPANY_A_ID,
    customerId: CUSTOMER_A1_ID,
    client: adminClient,
  });

  assert(
    pipelineResult.modelVersion === 'trusted-pipeline-v1',
    'Test 28: Pipeline persists trusted model.modelVersion'
  );
  assert(
    pipelineResult.sourceRefs.length >= 2,
    'Test 28: Pipeline automatically binds correct source_refs from sanitized inputs'
  );
  assert(
    pipelineResult.confidence === 0.92,
    'Test 28: Pipeline persists validated confidence'
  );

  // ---------------------------------------------------------------------------
  // Test 29: Trusted Model Provenance (Model output provides forged modelVersion)
  // ---------------------------------------------------------------------------
  const forgedModel = new FakeDeterministicAiModel(
    'real-trusted-v2',
    {
      ...validOutput,
      summary: 'Thử nghiệm giả mạo model_version từ nội dung LLM',
      modelVersion: 'FORGED_MODEL_XYZ', // LLM attempts to forge model version
    }
  );

  const forgedPipelineResult = await runCustomerAnalysisPipeline({
    model: forgedModel,
    companyId: COMPANY_A_ID,
    customerId: CUSTOMER_A1_ID,
    client: adminClient,
  });

  assert(
    forgedPipelineResult.modelVersion === 'real-trusted-v2',
    'Test 29: Pipeline ignores forged modelVersion in LLM output and stores trusted model.modelVersion'
  );

  // ---------------------------------------------------------------------------
  // Test 30: DB-side validation: 21 objections -> reject
  // ---------------------------------------------------------------------------
  const objections21 = Array.from({ length: 21 }, (_, i) => `Objection #${i + 1}`);
  const { error: test30RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: '21 objections test',
    p_objections: objections21,
    p_confidence: 0.5,
    p_evidence: 'Some evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test30RpcErr !== null && test30RpcErr.message.includes('OBJECTIONS_LIMIT_EXCEEDED'),
    'Test 30: DB RPC rejects 21 objections with OBJECTIONS_LIMIT_EXCEEDED'
  );

  // ---------------------------------------------------------------------------
  // Test 31: DB-side validation: objection > 500 chars -> reject
  // ---------------------------------------------------------------------------
  const longObjection = 'a'.repeat(501);
  const { error: test31RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: 'Long objection test',
    p_objections: [longObjection],
    p_confidence: 0.5,
    p_evidence: 'Some evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test31RpcErr !== null && test31RpcErr.message.includes('OBJECTION_TOO_LONG'),
    'Test 31: DB RPC rejects objection > 500 characters with OBJECTION_TOO_LONG'
  );

  // ---------------------------------------------------------------------------
  // Test 32: DB-side validation: stop_reason > 1000 chars -> reject
  // ---------------------------------------------------------------------------
  const longStopReason = 'b'.repeat(1001);
  const { error: test32RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: 'Long stop reason test',
    p_stop_reason: longStopReason,
    p_confidence: 0.5,
    p_evidence: 'Some evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test32RpcErr !== null && test32RpcErr.message.includes('STOP_REASON_TOO_LONG'),
    'Test 32: DB RPC rejects stop_reason > 1000 chars with STOP_REASON_TOO_LONG'
  );

  // ---------------------------------------------------------------------------
  // Test 33: DB-side validation: next_action > 1000 chars -> reject
  // ---------------------------------------------------------------------------
  const longNextAction = 'c'.repeat(1001);
  const { error: test33RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: 'Long next action test',
    p_next_action: longNextAction,
    p_confidence: 0.5,
    p_evidence: 'Some evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test33RpcErr !== null && test33RpcErr.message.includes('NEXT_ACTION_TOO_LONG'),
    'Test 33: DB RPC rejects next_action > 1000 chars with NEXT_ACTION_TOO_LONG'
  );

  // ---------------------------------------------------------------------------
  // Test 34: DB-side validation: empty objection string -> reject
  // ---------------------------------------------------------------------------
  const { error: test34RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_SUCCEEDED_1 }],
    p_summary: 'Empty objection test',
    p_objections: ['   '],
    p_confidence: 0.5,
    p_evidence: 'Some evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test34RpcErr !== null && test34RpcErr.message.includes('EMPTY_OBJECTION_ITEM'),
    'Test 34: DB RPC rejects empty whitespace objection with EMPTY_OBJECTION_ITEM'
  );

  // ---------------------------------------------------------------------------
  // Test 35: Latest-N selection with > 100 interactions
  // ---------------------------------------------------------------------------
  const pagingInput = await fetchAiAnalysisInput(adminClient, {
    companyId: COMPANY_A_ID,
    customerId: CUSTOMER_PAGING_ID,
    limit: 50,
  });

  assert(
    pagingInput.sources.length === 50,
    `Test 35: Latest-N selection returns exactly 50 interactions (got: ${pagingInput.sources.length})`
  );

  // Interaction #105 (newest) must be in the set
  const hasNewest105 = pagingInput.sources.some((s) => s.content.includes('#105'));
  assert(hasNewest105, 'Test 35: Newest interaction (#105) appears in the latest-N selection');

  // Interaction #1 (oldest outside limit) must NOT be in the set
  const hasOldest1 = pagingInput.sources.some((s) => s.content.includes('#1 '));
  assert(!hasOldest1, 'Test 35: Old interaction outside limit (#1) does NOT appear in the selection');

  // Verify chronology: sources must be ordered in chronological ascending order
  let isChronological = true;
  for (let i = 1; i < pagingInput.sources.length; i++) {
    const prev = new Date(pagingInput.sources[i - 1].createdAt).getTime();
    const curr = new Date(pagingInput.sources[i].createdAt).getTime();
    if (curr < prev) {
      isChronological = false;
      break;
    }
  }
  assert(isChronological, 'Test 35: Output of latest-N selection is re-ordered in chronological ASC order');

  // ---------------------------------------------------------------------------
  // Test 36: Strict MESSAGE eligibility
  // ---------------------------------------------------------------------------
  // In input RPC: Non-MESSAGE interaction (INT_A1_NOTE_SUCCEEDED) should NOT appear in inputA1
  const hasNote = inputA1.sources.some((s) => s.interactionId === INT_A1_NOTE_SUCCEEDED);
  assert(!hasNote, 'Test 36: Non-MESSAGE interaction (NOTE) is NOT returned by get_ai_analysis_input');

  // In persist RPC: Passing non-MESSAGE interaction in source_refs must be rejected
  const { error: test36RpcErr } = await adminClient.rpc('record_ai_analysis', {
    p_company_id: COMPANY_A_ID,
    p_customer_id: CUSTOMER_A1_ID,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A1_NOTE_SUCCEEDED }],
    p_summary: 'Non-message source ref test',
    p_confidence: 0.5,
    p_evidence: 'Some evidence',
    p_model_version: 'test-v1',
  });
  assert(
    test36RpcErr !== null && test36RpcErr.message.includes('SOURCE_INTERACTION_NOT_MESSAGE'),
    'Test 36: DB RPC rejects non-MESSAGE interaction in source_refs with SOURCE_INTERACTION_NOT_MESSAGE'
  );

  console.log('\n==================================================');
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
