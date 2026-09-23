import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  fetchSalesStyleLearningInput,
  persistSalesStyleProfile,
} from '../../features/sales-style/services/sales-style-store';
import {
  validateSalesStyleOutput,
  SalesStyleValidationError,
} from '../../features/sales-style/services/validate-sales-style';
import {
  runSalesStyleLearningPipeline,
  FakeDeterministicSalesStyleModel,
  NoStyleLearningSourcesError,
} from '../../features/sales-style/services/sales-style-engine';
import type {
  SalesStyleOutput,
  SalesStyleSourceRef,
} from '../../shared/contracts/sales-style';

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

function executeRawSql(sql: string) {
  execSync('docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -v ON_ERROR_STOP=1 -U postgres -d postgres', {
    input: sql,
    encoding: 'utf8',
  });
}

// Deterministic UUID fixtures
const COMPANY_A_ID = 'a0000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = 'a0000000-0000-0000-0000-000000000002';

const CUSTOMER_A_ID = 'a1000000-0000-0000-0000-000000000001';
const CUSTOMER_B_ID = 'a1000000-0000-0000-0000-000000000002';

const CONVO_A_ID = 'a2000000-0000-0000-0000-000000000001';
const CONVO_B_ID = 'a2000000-0000-0000-0000-000000000002';

// User credentials
const USER_BOSS_A = { email: 'style_boss_a@trusted.local', password: 'Password123!', fullName: 'Style Sếp Quản Trị A' };
const USER_SALE_A = { email: 'style_sale_a@trusted.local', password: 'Password123!', fullName: 'Style Nhân Viên Sale A' };
const USER_INACTIVE_SALE_A = { email: 'style_inactive_sale_a@trusted.local', password: 'Password123!', fullName: 'Style Sale Inactive A' };
const USER_TECH_A = { email: 'style_tech_a@trusted.local', password: 'Password123!', fullName: 'Style Kỹ Thuật Viên A' };
const USER_BOSS_B = { email: 'style_boss_b@trusted.local', password: 'Password123!', fullName: 'Style Sếp Quản Trị B' };
const USER_SALE_B = { email: 'style_sale_b@trusted.local', password: 'Password123!', fullName: 'Style Nhân Viên Sale B' };

let saleAUserId: string;
let inactiveSaleAUserId: string;
let techAUserId: string;
let bossAUserId: string;
let saleBUserId: string;

let bossAClient: SupabaseClient;
let saleAClient: SupabaseClient;
let techAClient: SupabaseClient;
let bossBClient: SupabaseClient;
let saleBClient: SupabaseClient;

// Sample interactions IDs
const INT_A_OUTBOUND_1 = 'a3000000-0000-0000-0000-000000000001';
const INT_A_OUTBOUND_2 = 'a3000000-0000-0000-0000-000000000002';
const INT_A_OUTBOUND_3 = 'a3000000-0000-0000-0000-000000000003';
const INT_A_OUTBOUND_4 = 'a3000000-0000-0000-0000-000000000004';
const INT_A_OUTBOUND_5 = 'a3000000-0000-0000-0000-000000000005';
const INT_A_OUTBOUND_6 = 'a3000000-0000-0000-0000-000000000006';
const INT_A_PENDING = 'a3000000-0000-0000-0000-000000000007';
const INT_A_FAILED = 'a3000000-0000-0000-0000-000000000008';
const INT_A_INBOUND_CUST = 'a3000000-0000-0000-0000-000000000009';
const INT_A_OUTBOUND_NOTE = 'a3000000-0000-0000-0000-000000000010';
const INT_A_OUTBOUND_TECH = 'a3000000-0000-0000-0000-000000000011';
const INT_B_OUTBOUND_SALE_B = 'a3000000-0000-0000-0000-000000000012';
const INT_A_POLICY_SENSITIVE = 'a3000000-0000-0000-0000-000000000099';

// 10 paging interactions for latest-N test
const PAGING_INT_IDS: string[] = [];
for (let i = 1; i <= 10; i++) {
  const pad = i.toString().padStart(2, '0');
  PAGING_INT_IDS.push(`a4000000-0000-0000-0000-0000000000${pad}`);
}

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

async function ensureUser(
  config: { email: string; password: string; fullName: string },
  companyId: string,
  role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN',
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'
): Promise<string> {
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
      status,
    },
    { onConflict: 'company_id,user_id' }
  );
  if (memberErr) {
    throw new Error(`Failed to configure member ${config.email}: ${memberErr.message}`);
  }

  return userId;
}

const VALID_STYLE_OUTPUT: SalesStyleOutput = {
  salutationRules: {
    selfReferences: ['em', 'mình'],
    customerReferences: ['anh', 'chị', 'bác'],
    commonOpenings: ['Dạ em chào anh/chị ạ', 'Chào bạn nhé'],
    notes: ['Luôn chào hỏi lễ phép, xưng hô phù hợp lứa tuổi'],
  },
  sentenceStyle: {
    preferredLength: 'MEDIUM',
    toneDescriptors: ['nhiệt tình', 'chuyên nghiệp', 'gần gũi'],
    emojiUsage: 'LOW',
    punctuationPatterns: ['dùng dấu chấm câu rõ ràng', 'thỉnh thoảng dùng dấu chấm than nhẹ nhàng'],
    notes: ['Câu từ gãy gọn, không lan man'],
  },
  questionStyle: {
    commonPatterns: ['Nhà mình ở khu vực nào ạ?', 'Cửa nhà mình rộng khoảng bao nhiêu mét anh nhỉ?'],
    discoveryApproach: ['Hỏi thăm tình trạng ngập nước trước, sau đó hỏi số đo sơ bộ'],
    followUpApproach: ['Nhắc lịch hẹn nhẹ nhàng sau 1 ngày'],
    notes: ['Câu hỏi mở, tạo sự thoải mái'],
  },
  objectionStyle: {
    approaches: [
      {
        situation: 'Khách kêu giá cao so với vách ngăn tự chế',
        responseApproach: 'Đồng cảm trước, sau đó giải thích độ bền vật liệu inox 304 và cơ chế tự động ép kín nước',
      },
      {
        situation: 'Khách ngại khoan cắt nền nhà',
        responseApproach: 'Tư vấn phương án thi công phẳng mép sàn, gioăng cao su thẩm mỹ không cản trở xe cộ',
      },
    ],
    notes: ['Không tranh cãi, tập trung vào giải pháp kỹ thuật an toàn dài hạn'],
  },
  closingStyle: {
    commonClosings: ['Em cảm ơn anh/chị nhiều ạ', 'Chúc gia đình một ngày tốt lành!'],
    callToActionPatterns: ['Em gửi kỹ thuật qua đo thực tế cho chuẩn xác nhé anh?'],
    urgencyStyle: ['Mùa mưa bão sắp vào đợt triều cường, mình làm sớm cho yên tâm'],
    notes: ['Chốt lịch hẹn khảo sát thực tế thay vì ép khách ra quyết định vội'],
  },
};

async function setupDatabaseFixtures() {
  console.log('--- Setting up Sales Style test database fixtures ---');

  // 1. Companies
  const { error: errComp } = await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'Công ty Cửa Chống Ngập A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'Công ty Cửa Chống Ngập B', status: 'ACTIVE' },
  ]);
  if (errComp) throw new Error(`Companies upsert failed: ${errComp.message}`);

  // 2. Users & Members
  bossAUserId = await ensureUser(USER_BOSS_A, COMPANY_A_ID, 'BOSS_ADMIN', 'ACTIVE');
  saleAUserId = await ensureUser(USER_SALE_A, COMPANY_A_ID, 'SALE', 'ACTIVE');
  inactiveSaleAUserId = await ensureUser(USER_INACTIVE_SALE_A, COMPANY_A_ID, 'SALE', 'INACTIVE');
  techAUserId = await ensureUser(USER_TECH_A, COMPANY_A_ID, 'TECHNICIAN', 'ACTIVE');
  await ensureUser(USER_BOSS_B, COMPANY_B_ID, 'BOSS_ADMIN', 'ACTIVE');
  saleBUserId = await ensureUser(USER_SALE_B, COMPANY_B_ID, 'SALE', 'ACTIVE');

  // Authenticate user clients
  bossAClient = createAnonClient();
  await bossAClient.auth.signInWithPassword({ email: USER_BOSS_A.email, password: USER_BOSS_A.password });

  saleAClient = createAnonClient();
  await saleAClient.auth.signInWithPassword({ email: USER_SALE_A.email, password: USER_SALE_A.password });

  techAClient = createAnonClient();
  await techAClient.auth.signInWithPassword({ email: USER_TECH_A.email, password: USER_TECH_A.password });

  bossBClient = createAnonClient();
  await bossBClient.auth.signInWithPassword({ email: USER_BOSS_B.email, password: USER_BOSS_B.password });

  saleBClient = createAnonClient();
  await saleBClient.auth.signInWithPassword({ email: USER_SALE_B.email, password: USER_SALE_B.password });

  // 3. Customers
  const { error: errCust } = await adminClient.from('customers').upsert([
    {
      id: CUSTOMER_A_ID,
      company_id: COMPANY_A_ID,
      customer_code: 'KH-STYLE-001',
      name: 'Khách Hàng A',
      source: 'FACEBOOK',
      stage: 'LEAD_NEW',
    },
    {
      id: CUSTOMER_B_ID,
      company_id: COMPANY_B_ID,
      customer_code: 'KH-STYLE-002',
      name: 'Khách Hàng B',
      source: 'ZALO_OA',
      stage: 'LEAD_NEW',
    },
  ]);
  if (errCust) throw new Error(`Customers upsert failed: ${errCust.message}`);

  // 4. Conversations
  const { error: errConvo } = await adminClient.from('conversations').upsert([
    {
      id: CONVO_A_ID,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'ext_style_a',
      status: 'OPEN',
    },
    {
      id: CONVO_B_ID,
      company_id: COMPANY_B_ID,
      customer_id: CUSTOMER_B_ID,
      channel: 'ZALO',
      external_conversation_id: 'ext_style_b',
      status: 'OPEN',
    },
  ]);
  if (errConvo) throw new Error(`Conversations upsert failed: ${errConvo.message}`);

  const now = new Date();
  const timeOffset = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60 * 1000).toISOString();

  // 5. Interactions
  const { error: errInt } = await adminClient.from('interactions').upsert([
    // Sale A: 6 valid sanitized outbound messages
    {
      id: INT_A_OUTBOUND_1,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Dạ em chào anh ạ, em là tư vấn viên công ty cửa chống ngập.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(60),
    },
    {
      id: INT_A_OUTBOUND_2,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Anh cho em hỏi độ rộng cửa nhà mình khoảng bao nhiêu mét ạ?',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(50),
    },
    {
      id: INT_A_OUTBOUND_3,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Tấm ngăn bên em làm từ Inox 304 chuẩn kỹ thuật chống ăn mòn nước ngập triều cường.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(40),
    },
    {
      id: INT_A_OUTBOUND_4,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Anh yên tâm bên em bảo hành kín nước tuyệt đối cho nhà mình nhé.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(30),
    },
    {
      id: INT_A_OUTBOUND_5,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Chiều mai bên em có bạn kỹ thuật qua đo đạc trực tiếp, em sắp xếp lịch cho mình nhé?',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(20),
    },
    {
      id: INT_A_OUTBOUND_6,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Em cảm ơn anh nhiều, hẹn gặp anh chiều mai ạ!',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(10),
    },
    {
      id: INT_A_POLICY_SENSITIVE,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Anh giảm 10%, khách cọc 5 triệu nhé',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(5),
    },

    // Invalid / Edge cases for filtering
    {
      id: INT_A_PENDING,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: null,
      sanitization_status: 'PENDING',
      created_at: timeOffset(9),
    },
    {
      id: INT_A_FAILED,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: null,
      sanitization_status: 'FAILED',
      created_at: timeOffset(8),
    },
    {
      id: INT_A_INBOUND_CUST,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      actor_user_id: null,
      sanitized_content: 'Cửa nhà tôi rộng 3.5m nhé.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(7),
    },
    {
      id: INT_A_OUTBOUND_NOTE,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'NOTE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Khách hẹn chiều mai sau 15h.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(6),
    },
    {
      id: INT_A_OUTBOUND_TECH,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'TECHNICIAN',
      actor_user_id: techAUserId,
      sanitized_content: 'Đã đến địa chỉ khảo sát.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(5),
    },

    // Sale B in Company B
    {
      id: INT_B_OUTBOUND_SALE_B,
      company_id: COMPANY_B_ID,
      customer_id: CUSTOMER_B_ID,
      conversation_id: CONVO_B_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleBUserId,
      sanitized_content: 'Em chào anh, em là Sale của bên chi nhánh B.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(4),
    },
  ]);
  if (errInt) throw new Error(`Interactions upsert failed: ${errInt.message}`);

  // Insert 10 paging interactions with spaced timestamps (from 100 mins ago to 91 mins ago)
  const pagingRows = PAGING_INT_IDS.map((id, idx) => ({
    id,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    conversation_id: CONVO_A_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'OUTBOUND',
    actor_type: 'SALE',
    actor_user_id: saleAUserId,
    sanitized_content: `Tin nhắn tuần tự thứ #${idx + 1}`,
    sanitization_status: 'SUCCEEDED',
    created_at: timeOffset(100 - idx), // idx 0 is 100m ago, idx 9 is 91m ago (newest of the batch)
  }));
  const { error: errPaging } = await adminClient.from('interactions').upsert(pagingRows);
  if (errPaging) throw new Error(`Paging interactions upsert failed: ${errPaging.message}`);

  console.log('--- Fixtures successfully set up ---');
}

async function runAllSalesStyleTests() {
  console.log('\n==================================================');
  console.log('STARTING SECURE SALES STYLE LEARNING TESTS (M9.4A)');
  console.log('==================================================\n');

  await setupDatabaseFixtures();

  // ---------------------------------------------------------------------------
  // Test 1: active SALE same company → input được lấy
  // ---------------------------------------------------------------------------
  const inputA = await fetchSalesStyleLearningInput(adminClient, {
    companyId: COMPANY_A_ID,
    saleUserId: saleAUserId,
  });
  assert(inputA.sources.length >= 6, 'Test 1: active SALE same company returns sanitized messages');
  assert(inputA.companyId === COMPANY_A_ID, 'Test 1: input contains target companyId');
  assert(inputA.saleUserId === saleAUserId, 'Test 1: input contains target saleUserId');

  // ---------------------------------------------------------------------------
  // Test 2: inactive Sale → denied
  // ---------------------------------------------------------------------------
  let test2Denied = false;
  try {
    await fetchSalesStyleLearningInput(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: inactiveSaleAUserId,
    });
  } catch (err: unknown) {
    test2Denied = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('MEMBERSHIP_INACTIVE') || msg.includes('42501'), `Test 2: inactive sale throws MEMBERSHIP_INACTIVE (got: ${msg})`);
  }
  assert(test2Denied, 'Test 2: inactive Sale denied fail-closed');

  // ---------------------------------------------------------------------------
  // Test 3: wrong Company → denied
  // ---------------------------------------------------------------------------
  let test3Denied = false;
  try {
    await fetchSalesStyleLearningInput(adminClient, {
      companyId: COMPANY_B_ID, // wrong company for Sale A
      saleUserId: saleAUserId,
    });
  } catch (err: unknown) {
    test3Denied = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('MEMBERSHIP_NOT_FOUND') || msg.includes('42501'), `Test 3: wrong company throws MEMBERSHIP_NOT_FOUND (got: ${msg})`);
  }
  assert(test3Denied, 'Test 3: wrong Company denied fail-closed');

  // ---------------------------------------------------------------------------
  // Test 4: TECH target → denied
  // ---------------------------------------------------------------------------
  let test4Denied = false;
  try {
    await fetchSalesStyleLearningInput(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: techAUserId,
    });
  } catch (err: unknown) {
    test4Denied = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('ROLE_NOT_SALE') || msg.includes('42501'), `Test 4: tech target throws ROLE_NOT_SALE (got: ${msg})`);
  }
  assert(test4Denied, 'Test 4: TECH target denied fail-closed');

  // ---------------------------------------------------------------------------
  // Test 5: BOSS target → denied nếu không phải SALE
  // ---------------------------------------------------------------------------
  let test5Denied = false;
  try {
    await fetchSalesStyleLearningInput(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: bossAUserId,
    });
  } catch (err: unknown) {
    test5Denied = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('ROLE_NOT_SALE') || msg.includes('42501'), `Test 5: boss target throws ROLE_NOT_SALE (got: ${msg})`);
  }
  assert(test5Denied, 'Test 5: BOSS target denied fail-closed');

  // ---------------------------------------------------------------------------
  // Test 6: only actor_type SALE
  // ---------------------------------------------------------------------------
  const hasNonSaleActor = inputA.sources.some((s) => s.interactionId === INT_A_OUTBOUND_TECH);
  assert(!hasNonSaleActor, 'Test 6: interactions with actor_type != SALE are excluded');

  // ---------------------------------------------------------------------------
  // Test 7: only actor_user_id target Sale
  // ---------------------------------------------------------------------------
  const hasOtherSaleMsg = inputA.sources.some((s) => s.interactionId === INT_B_OUTBOUND_SALE_B);
  assert(!hasOtherSaleMsg, 'Test 7: interactions of other sales are excluded');

  // ---------------------------------------------------------------------------
  // Test 8: only direction OUTBOUND
  // ---------------------------------------------------------------------------
  const hasInbound = inputA.sources.some((s) => s.interactionId === INT_A_INBOUND_CUST);
  assert(!hasInbound, 'Test 8: inbound interactions are excluded');

  // ---------------------------------------------------------------------------
  // Test 9: only MESSAGE
  // ---------------------------------------------------------------------------
  const hasNote = inputA.sources.some((s) => s.interactionId === INT_A_OUTBOUND_NOTE);
  assert(!hasNote, 'Test 9: non-MESSAGE interactions (NOTE) are excluded');

  // ---------------------------------------------------------------------------
  // Test 10: only SUCCEEDED sanitized
  // ---------------------------------------------------------------------------
  const hasPending = inputA.sources.some((s) => s.interactionId === INT_A_PENDING);
  const hasFailed = inputA.sources.some((s) => s.interactionId === INT_A_FAILED);
  assert(!hasPending && !hasFailed, 'Test 10: PENDING and FAILED sanitization interactions are excluded');

  // ---------------------------------------------------------------------------
  // Test 11: raw/private data không xuất hiện
  // ---------------------------------------------------------------------------
  const firstSource = inputA.sources[0];
  const keys = Object.keys(firstSource);
  assert(
    !keys.includes('phone') &&
    !keys.includes('raw_phone') &&
    !keys.includes('transcript') &&
    !keys.includes('raw_payload') &&
    !keys.includes('customer_name'),
    'Test 11: raw phone, transcript, and customer PII are completely absent from DTO'
  );

  // ---------------------------------------------------------------------------
  // Test 12: Sale A không học message Sale B
  // ---------------------------------------------------------------------------
  const inputB = await fetchSalesStyleLearningInput(adminClient, {
    companyId: COMPANY_B_ID,
    saleUserId: saleBUserId,
  });
  const overlap = inputA.sources.some((sa) => inputB.sources.some((sb) => sb.interactionId === sa.interactionId));
  assert(!overlap, 'Test 12: Sale A and Sale B message sets are strictly isolated');

  // ---------------------------------------------------------------------------
  // Test 13: latest-N lấy message mới nhất
  // ---------------------------------------------------------------------------
  // Request limit 5 for Sale A (who has at least 16 messages total)
  const inputLatest5 = await fetchSalesStyleLearningInput(adminClient, {
    companyId: COMPANY_A_ID,
    saleUserId: saleAUserId,
    limit: 5,
  });
  assert(inputLatest5.sources.length === 5, 'Test 13: exactly 5 messages returned when limit=5');
  // Newest message INT_A_OUTBOUND_6 (10 mins ago) must be present
  const hasNewest = inputLatest5.sources.some((s) => s.interactionId === INT_A_OUTBOUND_6);
  assert(hasNewest, 'Test 13: newest message appears in latest-N selection');
  // Oldest message (100 mins ago) must NOT be present in top 5
  const hasOldest = inputLatest5.sources.some((s) => s.interactionId === PAGING_INT_IDS[0]);
  assert(!hasOldest, 'Test 13: older messages outside limit are excluded');

  // ---------------------------------------------------------------------------
  // Test 14: chronological reorder đúng
  // ---------------------------------------------------------------------------
  let isSortedAsc = true;
  for (let i = 0; i < inputLatest5.sources.length - 1; i++) {
    const tCurrent = new Date(inputLatest5.sources[i].createdAt).getTime();
    const tNext = new Date(inputLatest5.sources[i + 1].createdAt).getTime();
    if (tCurrent > tNext) {
      isSortedAsc = false;
      break;
    }
  }
  assert(isSortedAsc, 'Test 14: latest-N items are correctly reordered in chronological ASC order');

  // ---------------------------------------------------------------------------
  // Test 15: validator valid output → pass
  // ---------------------------------------------------------------------------
  const validated = validateSalesStyleOutput(VALID_STYLE_OUTPUT);
  assert(validated.sentenceStyle.preferredLength === 'MEDIUM', 'Test 15: validator accepts valid output');

  // ---------------------------------------------------------------------------
  // Test 16: malformed output → reject
  // ---------------------------------------------------------------------------
  let test16Rejected = false;
  try {
    validateSalesStyleOutput({ ...VALID_STYLE_OUTPUT, salutationRules: null });
  } catch (err) {
    if (err instanceof SalesStyleValidationError) test16Rejected = true;
  }
  assert(test16Rejected, 'Test 16: malformed output rejected fail-closed');

  // ---------------------------------------------------------------------------
  // Test 17: invalid enum → reject
  // ---------------------------------------------------------------------------
  let test17Rejected = false;
  try {
    validateSalesStyleOutput({
      ...VALID_STYLE_OUTPUT,
      sentenceStyle: { ...VALID_STYLE_OUTPUT.sentenceStyle, preferredLength: 'SUPER_LONG' },
    });
  } catch (err) {
    if (err instanceof SalesStyleValidationError) test17Rejected = true;
  }
  assert(test17Rejected, 'Test 17: invalid preferredLength enum rejected');

  // ---------------------------------------------------------------------------
  // Test 18: oversized arrays/string → reject
  // ---------------------------------------------------------------------------
  let test18Rejected = false;
  try {
    validateSalesStyleOutput({
      ...VALID_STYLE_OUTPUT,
      salutationRules: {
        ...VALID_STYLE_OUTPUT.salutationRules,
        selfReferences: Array(15).fill('em'), // max 10
      },
    });
  } catch (err) {
    if (err instanceof SalesStyleValidationError) test18Rejected = true;
  }
  assert(test18Rejected, 'Test 18: oversized array rejected');

  // ---------------------------------------------------------------------------
  // Test 19: forged modelVersion từ model → ignored/rejected
  // ---------------------------------------------------------------------------
  let test19Rejected = false;
  try {
    validateSalesStyleOutput({
      ...VALID_STYLE_OUTPUT,
      modelVersion: 'gemini-forged-version',
    });
  } catch (err) {
    if (err instanceof SalesStyleValidationError) test19Rejected = true;
  }
  assert(test19Rejected, 'Test 19: model returning modelVersion rejected as unknown key');

  // ---------------------------------------------------------------------------
  // Test 20: forged version → ignored/rejected
  // ---------------------------------------------------------------------------
  let test20Rejected = false;
  try {
    validateSalesStyleOutput({
      ...VALID_STYLE_OUTPUT,
      version: 'v1.0.0-forged',
    });
  } catch (err) {
    if (err instanceof SalesStyleValidationError) test20Rejected = true;
  }
  assert(test20Rejected, 'Test 20: model returning version rejected as unknown key');

  // ---------------------------------------------------------------------------
  // Test 21: pricing/discount top-level key → reject
  // ---------------------------------------------------------------------------
  let test21Rejected = false;
  try {
    validateSalesStyleOutput({
      ...VALID_STYLE_OUTPUT,
      discountRule: 'Always give 10% discount',
    });
  } catch (err) {
    if (err instanceof SalesStyleValidationError) test21Rejected = true;
  }
  assert(test21Rejected, 'Test 21: pricing/discount top-level key strictly rejected by firewall');

  // ---------------------------------------------------------------------------
  // Test 21b: Content Firewall: "giảm 10%" in notes → validator reject
  // ---------------------------------------------------------------------------
  let test21bRejected = false;
  try {
    validateSalesStyleOutput({
      ...VALID_STYLE_OUTPUT,
      salutationRules: {
        ...VALID_STYLE_OUTPUT.salutationRules,
        notes: ['Thường giảm 10% để khách chốt'],
      },
    });
  } catch (err) {
    if (err instanceof SalesStyleValidationError && err.message.includes('Business policy violation detected')) {
      test21bRejected = true;
    }
  }
  assert(test21bRejected, 'Test 21b: "giảm 10%" in notes rejected by TS content firewall');

  // ---------------------------------------------------------------------------
  // Test 21c: Content Firewall: "cọc 5 triệu" in responseApproach → validator reject
  // ---------------------------------------------------------------------------
  let test21cRejected = false;
  try {
    validateSalesStyleOutput({
      ...VALID_STYLE_OUTPUT,
      objectionStyle: {
        ...VALID_STYLE_OUTPUT.objectionStyle,
        approaches: [
          {
            situation: 'Khách hỏi đặt cọc giữ lịch',
            responseApproach: 'Yêu cầu khách cọc 5 triệu để tiến hành chuẩn bị vật tư',
          },
        ],
      },
    });
  } catch (err) {
    if (err instanceof SalesStyleValidationError && err.message.includes('Business policy violation detected')) {
      test21cRejected = true;
    }
  }
  assert(test21cRejected, 'Test 21c: "cọc 5 triệu" in responseApproach rejected by TS content firewall');

  // ---------------------------------------------------------------------------
  // Test 21d: Content Firewall: "12.000.000 VNĐ" in closing text → validator reject
  // ---------------------------------------------------------------------------
  let test21dRejected = false;
  try {
    validateSalesStyleOutput({
      ...VALID_STYLE_OUTPUT,
      closingStyle: {
        ...VALID_STYLE_OUTPUT.closingStyle,
        commonClosings: ['Tổng chi phí lắp đặt là 12.000.000 VNĐ anh nhé'],
      },
    });
  } catch (err) {
    if (err instanceof SalesStyleValidationError && err.message.includes('Business policy violation detected')) {
      test21dRejected = true;
    }
  }
  assert(test21dRejected, 'Test 21d: "12.000.000 VNĐ" in closing text rejected by TS content firewall');

  // ---------------------------------------------------------------------------
  // Test 21e: Pure stylistic text (including "2-3 câu") → validator passes
  // ---------------------------------------------------------------------------
  const test21ePassed = validateSalesStyleOutput({
    ...VALID_STYLE_OUTPUT,
    sentenceStyle: {
      ...VALID_STYLE_OUTPUT.sentenceStyle,
      notes: ['Dùng 2-3 câu ngắn gọn, diễn đạt súc tích'],
    },
  });
  assert(test21ePassed !== null, 'Test 21e: valid pure stylistic text (including "2-3 câu") passes validator');

  // ---------------------------------------------------------------------------
  // Test 22: invalid source_ref tenant → reject
  // ---------------------------------------------------------------------------
  let test22Rejected = false;
  try {
    await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: [{ type: 'INTERACTION', id: INT_B_OUTBOUND_SALE_B }], // belongs to Company B
      styleOutput: VALID_STYLE_OUTPUT,
      modelVersion: 'test-model-v1',
    });
  } catch (err: unknown) {
    test22Rejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('SOURCE_INTERACTION_TENANT_MISMATCH'), `Test 22: tenant mismatch error thrown (got: ${msg})`);
  }
  assert(test22Rejected, 'Test 22: cross-tenant source_ref rejected fail-closed');

  // ---------------------------------------------------------------------------
  // Test 23: source_ref Sale khác → reject
  // ---------------------------------------------------------------------------
  // Insert an outbound message in Company A authored by another user (Tech A)
  let test23Rejected = false;
  try {
    await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: [{ type: 'INTERACTION', id: INT_A_OUTBOUND_TECH }], // authored by Tech, not Sale A
      styleOutput: VALID_STYLE_OUTPUT,
      modelVersion: 'test-model-v1',
    });
  } catch (err: unknown) {
    test23Rejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('SOURCE_INTERACTION_ACTOR_MISMATCH'), `Test 23: actor mismatch error thrown (got: ${msg})`);
  }
  assert(test23Rejected, 'Test 23: source_ref of non-target sale rejected');

  // ---------------------------------------------------------------------------
  // Test 24: source_ref Customer inbound → reject
  // ---------------------------------------------------------------------------
  let test24Rejected = false;
  try {
    await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: [{ type: 'INTERACTION', id: INT_A_INBOUND_CUST }], // customer inbound
      styleOutput: VALID_STYLE_OUTPUT,
      modelVersion: 'test-model-v1',
    });
  } catch (err: unknown) {
    test24Rejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(
      msg.includes('SOURCE_INTERACTION_ACTOR_MISMATCH') || msg.includes('SOURCE_INTERACTION_NOT_OUTBOUND'),
      `Test 24: customer inbound error thrown (got: ${msg})`
    );
  }
  assert(test24Rejected, 'Test 24: customer inbound source_ref rejected');

  // ---------------------------------------------------------------------------
  // Test 24b: duplicate source_refs [A, A] → reject DUPLICATE_SOURCE_REF
  // ---------------------------------------------------------------------------
  let test24bRejected = false;
  try {
    await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: [
        { type: 'INTERACTION', id: INT_A_OUTBOUND_1 },
        { type: 'INTERACTION', id: INT_A_OUTBOUND_1 },
      ],
      styleOutput: VALID_STYLE_OUTPUT,
      modelVersion: 'test-model-v1',
    });
  } catch (err: unknown) {
    test24bRejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('DUPLICATE_SOURCE_REF'), `Test 24b: duplicate source refs throws DUPLICATE_SOURCE_REF (got: ${msg})`);
  }
  assert(test24bRejected, 'Test 24b: duplicate source refs rejected fail-closed');

  // ---------------------------------------------------------------------------
  // Test 24c: duplicate refs cannot inflate audit metadata source_count
  // ---------------------------------------------------------------------------
  const { data: auditAfterDup } = await adminClient
    .from('audit_logs')
    .select('id')
    .eq('action', 'SALES_STYLE_PROFILE_GENERATED')
    .eq('result', 'SUCCESS')
    .contains('metadata', { source_count: 2 });
  assert((auditAfterDup?.length ?? 0) === 0, 'Test 24c: duplicate refs rejected fail-closed, preventing audit source_count inflation');

  // ---------------------------------------------------------------------------
  // Test 25: valid profile creates new DRAFT
  // ---------------------------------------------------------------------------
  const sourceRefsA: SalesStyleSourceRef[] = [
    { type: 'INTERACTION', id: INT_A_OUTBOUND_1 },
    { type: 'INTERACTION', id: INT_A_OUTBOUND_2 },
    { type: 'INTERACTION', id: INT_A_OUTBOUND_3 },
    { type: 'INTERACTION', id: INT_A_OUTBOUND_4 },
    { type: 'INTERACTION', id: INT_A_OUTBOUND_5 },
    { type: 'INTERACTION', id: INT_A_OUTBOUND_6 },
  ];

  const profile1 = await persistSalesStyleProfile(adminClient, {
    companyId: COMPANY_A_ID,
    saleUserId: saleAUserId,
    sourceRefs: sourceRefsA,
    styleOutput: VALID_STYLE_OUTPUT,
    modelVersion: 'gpt-4o-style-test',
  });
  assert(profile1.generationStatus === 'DRAFT', 'Test 25: profile generation_status is strictly DRAFT');
  assert(profile1.companyId === COMPANY_A_ID, 'Test 25: profile companyId matches');
  assert(profile1.saleUserId === saleAUserId, 'Test 25: profile saleUserId matches');

  // ---------------------------------------------------------------------------
  // Test 26: version do server sinh và unique
  // ---------------------------------------------------------------------------
  assert(profile1.version.startsWith('ssp_'), 'Test 26: version starts with trusted prefix ssp_');
  assert(profile1.version.length > 10, 'Test 26: version is robust UUID-derived string');

  // ---------------------------------------------------------------------------
  // Test 27: second generation tạo record khác, không overwrite
  // ---------------------------------------------------------------------------
  const profile2 = await persistSalesStyleProfile(adminClient, {
    companyId: COMPANY_A_ID,
    saleUserId: saleAUserId,
    sourceRefs: sourceRefsA,
    styleOutput: VALID_STYLE_OUTPUT,
    modelVersion: 'gpt-4o-style-test',
  });
  assert(profile2.id !== profile1.id, 'Test 27: second profile has a distinct record ID');
  assert(profile2.version !== profile1.version, 'Test 27: second profile has a distinct unique version');

  // Verify both profiles exist in DB (append-only) via authorized saleAClient
  const { data: allProfiles } = await saleAClient
    .from('sales_style_profiles')
    .select('id')
    .eq('sale_user_id', saleAUserId);
  assert((allProfiles?.length ?? 0) >= 2, 'Test 27: database contains multiple distinct profile versions (no overwrite)');

  // ---------------------------------------------------------------------------
  // Test 28: trusted model version được persist
  // ---------------------------------------------------------------------------
  assert(profile1.modelVersion === 'gpt-4o-style-test', 'Test 28: trusted modelVersion is correctly persisted');

  // ---------------------------------------------------------------------------
  // Test 28b: p_model_version = NULL → direct RPC reject
  // ---------------------------------------------------------------------------
  const { error: errNullModel } = await adminClient.rpc('record_sales_style_profile', {
    p_company_id: COMPANY_A_ID,
    p_sale_user_id: saleAUserId,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A_OUTBOUND_1 }],
    p_salutation_rules: VALID_STYLE_OUTPUT.salutationRules,
    p_sentence_style: VALID_STYLE_OUTPUT.sentenceStyle,
    p_question_style: VALID_STYLE_OUTPUT.questionStyle,
    p_objection_style: VALID_STYLE_OUTPUT.objectionStyle,
    p_closing_style: VALID_STYLE_OUTPUT.closingStyle,
    p_model_version: null,
  });
  assert(
    errNullModel !== null && errNullModel.message.includes('EMPTY_MODEL_VERSION'),
    `Test 28b: NULL model_version rejected fail-closed with EMPTY_MODEL_VERSION (got: ${errNullModel?.message})`
  );

  // ---------------------------------------------------------------------------
  // Test 28c: p_model_version = '' → direct RPC reject
  // ---------------------------------------------------------------------------
  const { error: errEmptyModel } = await adminClient.rpc('record_sales_style_profile', {
    p_company_id: COMPANY_A_ID,
    p_sale_user_id: saleAUserId,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A_OUTBOUND_1 }],
    p_salutation_rules: VALID_STYLE_OUTPUT.salutationRules,
    p_sentence_style: VALID_STYLE_OUTPUT.sentenceStyle,
    p_question_style: VALID_STYLE_OUTPUT.questionStyle,
    p_objection_style: VALID_STYLE_OUTPUT.objectionStyle,
    p_closing_style: VALID_STYLE_OUTPUT.closingStyle,
    p_model_version: '',
  });
  assert(
    errEmptyModel !== null && errEmptyModel.message.includes('EMPTY_MODEL_VERSION'),
    `Test 28c: empty model_version rejected fail-closed with EMPTY_MODEL_VERSION (got: ${errEmptyModel?.message})`
  );

  // ---------------------------------------------------------------------------
  // Test 28d: p_model_version = '   ' → direct RPC reject
  // ---------------------------------------------------------------------------
  const { error: errWhitespaceModel } = await adminClient.rpc('record_sales_style_profile', {
    p_company_id: COMPANY_A_ID,
    p_sale_user_id: saleAUserId,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A_OUTBOUND_1 }],
    p_salutation_rules: VALID_STYLE_OUTPUT.salutationRules,
    p_sentence_style: VALID_STYLE_OUTPUT.sentenceStyle,
    p_question_style: VALID_STYLE_OUTPUT.questionStyle,
    p_objection_style: VALID_STYLE_OUTPUT.objectionStyle,
    p_closing_style: VALID_STYLE_OUTPUT.closingStyle,
    p_model_version: '   ',
  });
  assert(
    errWhitespaceModel !== null && errWhitespaceModel.message.includes('EMPTY_MODEL_VERSION'),
    `Test 28d: whitespace model_version rejected fail-closed with EMPTY_MODEL_VERSION (got: ${errWhitespaceModel?.message})`
  );

  // ---------------------------------------------------------------------------
  // Test 29: examples store provenance metadata ONLY (no message text/content)
  // ---------------------------------------------------------------------------
  assert(Array.isArray(profile1.examples) && profile1.examples.length > 0, 'Test 29: examples array is populated');
  const allExamplesAreMetadataOnly = profile1.examples.every((ex) => {
    const raw = ex as unknown as Record<string, unknown>;
    const hasInteractionId = typeof raw.interaction_id === 'string' && raw.interaction_id.length > 0;
    const hasChannel = typeof raw.channel === 'string' && raw.channel.length > 0;
    const hasCreatedAt = typeof raw.created_at === 'string' && raw.created_at.length > 0;
    const hasNoContent = raw.content === undefined;
    const hasNoSanitizedContent = raw.sanitized_content === undefined;
    const hasNoMessageText = raw.message_text === undefined;
    return hasInteractionId && hasChannel && hasCreatedAt && hasNoContent && hasNoSanitizedContent && hasNoMessageText;
  });
  assert(
    allExamplesAreMetadataOnly,
    'Test 29: examples store ONLY trusted provenance metadata (interaction_id, channel, created_at) and ZERO message bodies'
  );

  // ---------------------------------------------------------------------------
  // Test 29b: source message contains sensitive business text -> examples contains ZERO sensitive terms
  // ---------------------------------------------------------------------------
  const profileWithSensitiveSource = await persistSalesStyleProfile(adminClient, {
    companyId: COMPANY_A_ID,
    saleUserId: saleAUserId,
    sourceRefs: [{ type: 'INTERACTION', id: INT_A_POLICY_SENSITIVE }],
    styleOutput: VALID_STYLE_OUTPUT,
    modelVersion: 'gpt-4o-style-test',
  });
  const serializedExamples = JSON.stringify(profileWithSensitiveSource.examples);
  assert(
    !serializedExamples.includes('10%') &&
    !serializedExamples.includes('5 triệu') &&
    !serializedExamples.includes('giảm') &&
    !serializedExamples.includes('cọc'),
    'Test 29b: examples does NOT contain "10%", "5 triệu", "giảm", "cọc", or any message body from sensitive source interaction'
  );

  // ---------------------------------------------------------------------------
  // Test 30: examples <= configured cap (<= 5)
  // ---------------------------------------------------------------------------
  assert(profile1.examples.length <= 5, `Test 30: examples capped at <= 5 (got ${profile1.examples.length})`);

  // ---------------------------------------------------------------------------
  // Test 31: authenticated Boss/Sale không direct INSERT
  // ---------------------------------------------------------------------------
  const { error: errDirectInsertBoss } = await bossAClient.from('sales_style_profiles').insert({
    company_id: COMPANY_A_ID,
    sale_user_id: saleAUserId,
    version: 'ssp_direct_boss',
    salutation_rules: {},
    sentence_style: {},
    question_style: {},
    objection_style: {},
    closing_style: {},
  });
  assert(errDirectInsertBoss !== null, 'Test 31: authenticated Boss direct INSERT denied');

  const { error: errDirectInsertSale } = await saleAClient.from('sales_style_profiles').insert({
    company_id: COMPANY_A_ID,
    sale_user_id: saleAUserId,
    version: 'ssp_direct_sale',
    salutation_rules: {},
    sentence_style: {},
    question_style: {},
    objection_style: {},
    closing_style: {},
  });
  assert(errDirectInsertSale !== null, 'Test 31: authenticated Sale direct INSERT denied');

  // ---------------------------------------------------------------------------
  // Test 31b: DB Content Firewall: direct RPC with "giảm 10%" in style JSON → DB reject
  // ---------------------------------------------------------------------------
  const { error: errDbPolicy1 } = await adminClient.rpc('record_sales_style_profile', {
    p_company_id: COMPANY_A_ID,
    p_sale_user_id: saleAUserId,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A_OUTBOUND_1 }],
    p_salutation_rules: { ...VALID_STYLE_OUTPUT.salutationRules, notes: ['Thường giảm 10% cho khách chốt'] },
    p_sentence_style: VALID_STYLE_OUTPUT.sentenceStyle,
    p_question_style: VALID_STYLE_OUTPUT.questionStyle,
    p_objection_style: VALID_STYLE_OUTPUT.objectionStyle,
    p_closing_style: VALID_STYLE_OUTPUT.closingStyle,
    p_model_version: 'test-model-v1',
  });
  assert(
    errDbPolicy1 !== null && errDbPolicy1.message.includes('FORBIDDEN_BUSINESS_POLICY_IN_STYLE'),
    `Test 31b: DB rejects "giảm 10%" with FORBIDDEN_BUSINESS_POLICY_IN_STYLE (got: ${errDbPolicy1?.message})`
  );

  // ---------------------------------------------------------------------------
  // Test 31c: DB Content Firewall: direct RPC with "cọc 5 triệu" in responseApproach → DB reject
  // ---------------------------------------------------------------------------
  const { error: errDbPolicy2 } = await adminClient.rpc('record_sales_style_profile', {
    p_company_id: COMPANY_A_ID,
    p_sale_user_id: saleAUserId,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A_OUTBOUND_1 }],
    p_salutation_rules: VALID_STYLE_OUTPUT.salutationRules,
    p_sentence_style: VALID_STYLE_OUTPUT.sentenceStyle,
    p_question_style: VALID_STYLE_OUTPUT.questionStyle,
    p_objection_style: {
      ...VALID_STYLE_OUTPUT.objectionStyle,
      approaches: [{ situation: 'Khách hỏi cọc', responseApproach: 'Yêu cầu khách cọc 5 triệu' }],
    },
    p_closing_style: VALID_STYLE_OUTPUT.closingStyle,
    p_model_version: 'test-model-v1',
  });
  assert(
    errDbPolicy2 !== null && errDbPolicy2.message.includes('FORBIDDEN_BUSINESS_POLICY_IN_STYLE'),
    `Test 31c: DB rejects "cọc 5 triệu" with FORBIDDEN_BUSINESS_POLICY_IN_STYLE (got: ${errDbPolicy2?.message})`
  );

  // ---------------------------------------------------------------------------
  // Test 31d: DB Content Firewall: direct RPC with "12.000.000 VNĐ" in closings → DB reject
  // ---------------------------------------------------------------------------
  const { error: errDbPolicy3 } = await adminClient.rpc('record_sales_style_profile', {
    p_company_id: COMPANY_A_ID,
    p_sale_user_id: saleAUserId,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A_OUTBOUND_1 }],
    p_salutation_rules: VALID_STYLE_OUTPUT.salutationRules,
    p_sentence_style: VALID_STYLE_OUTPUT.sentenceStyle,
    p_question_style: VALID_STYLE_OUTPUT.questionStyle,
    p_objection_style: VALID_STYLE_OUTPUT.objectionStyle,
    p_closing_style: {
      ...VALID_STYLE_OUTPUT.closingStyle,
      commonClosings: ['Báo giá trọn gói 12.000.000 VNĐ'],
    },
    p_model_version: 'test-model-v1',
  });
  assert(
    errDbPolicy3 !== null && errDbPolicy3.message.includes('FORBIDDEN_BUSINESS_POLICY_IN_STYLE'),
    `Test 31d: DB rejects "12.000.000 VNĐ" with FORBIDDEN_BUSINESS_POLICY_IN_STYLE (got: ${errDbPolicy3?.message})`
  );

  // ---------------------------------------------------------------------------
  // Test 31e: DB Content Firewall: direct RPC with "Cam kết bảo hành 5 năm" → DB reject
  // ---------------------------------------------------------------------------
  const { error: errDbPolicy4 } = await adminClient.rpc('record_sales_style_profile', {
    p_company_id: COMPANY_A_ID,
    p_sale_user_id: saleAUserId,
    p_source_refs: [{ type: 'INTERACTION', id: INT_A_OUTBOUND_1 }],
    p_salutation_rules: VALID_STYLE_OUTPUT.salutationRules,
    p_sentence_style: VALID_STYLE_OUTPUT.sentenceStyle,
    p_question_style: VALID_STYLE_OUTPUT.questionStyle,
    p_objection_style: {
      ...VALID_STYLE_OUTPUT.objectionStyle,
      notes: ['Cam kết bảo hành 5 năm toàn diện'],
    },
    p_closing_style: VALID_STYLE_OUTPUT.closingStyle,
    p_model_version: 'test-model-v1',
  });
  assert(
    errDbPolicy4 !== null && errDbPolicy4.message.includes('FORBIDDEN_BUSINESS_POLICY_IN_STYLE'),
    `Test 31e: DB rejects "Cam kết bảo hành 5 năm" with FORBIDDEN_BUSINESS_POLICY_IN_STYLE (got: ${errDbPolicy4?.message})`
  );

  // ---------------------------------------------------------------------------
  // Test 32: service_role direct mutation denied
  // ---------------------------------------------------------------------------
  const { error: errDirectServiceRole } = await adminClient.from('sales_style_profiles').insert({
    company_id: COMPANY_A_ID,
    sale_user_id: saleAUserId,
    version: 'ssp_direct_service_role',
    salutation_rules: {},
    sentence_style: {},
    question_style: {},
    objection_style: {},
    closing_style: {},
  });
  assert(
    errDirectServiceRole !== null && errDirectServiceRole.code === '42501',
    'Test 32: service_role direct INSERT denied by PostgreSQL table ACL revocation'
  );

  const { error: errDirectServiceRoleSelect } = await adminClient
    .from('sales_style_profiles')
    .select('id')
    .limit(1);
  assert(
    errDirectServiceRoleSelect !== null && errDirectServiceRoleSelect.code === '42501',
    'Test 32b: service_role direct SELECT denied by complete table ACL revocation'
  );

  // ---------------------------------------------------------------------------
  // Test 33: bounded persist RPC succeeds
  // ---------------------------------------------------------------------------
  assert(Boolean(profile1.id), 'Test 33: bounded persist RPC succeeds via service_role execution');

  // ---------------------------------------------------------------------------
  // Test 34: TECH cannot SELECT
  // ---------------------------------------------------------------------------
  const { data: techSelectData } = await techAClient.from('sales_style_profiles').select('*');
  assert((techSelectData?.length ?? 0) === 0, 'Test 34: TECHNICIAN cannot SELECT any sales style profiles (0 rows)');

  // ---------------------------------------------------------------------------
  // Test 35: Sale chỉ SELECT profile của chính mình
  // ---------------------------------------------------------------------------
  const { data: saleASelectData } = await saleAClient.from('sales_style_profiles').select('*');
  assert((saleASelectData?.length ?? 0) >= 2, 'Test 35: Sale A can SELECT their own profiles');
  const allBelongToSaleA = Boolean(saleASelectData && saleASelectData.length > 0 && saleASelectData.every((p) => p.sale_user_id === saleAUserId));
  assert(allBelongToSaleA, 'Test 35: All selected profiles strictly belong to Sale A');

  // ---------------------------------------------------------------------------
  // Test 36: Sale A không SELECT Sale B profile
  // ---------------------------------------------------------------------------
  // First persist a profile for Sale B in Company B
  const profileB = await persistSalesStyleProfile(adminClient, {
    companyId: COMPANY_B_ID,
    saleUserId: saleBUserId,
    sourceRefs: [{ type: 'INTERACTION', id: INT_B_OUTBOUND_SALE_B }],
    styleOutput: VALID_STYLE_OUTPUT,
    modelVersion: 'gpt-4o-style-test',
  });

  const hasSaleBProfileInSaleA = Boolean(saleASelectData?.some((p) => p.id === profileB.id));
  assert(!hasSaleBProfileInSaleA, 'Test 36: Sale A cannot SELECT Sale B profile');

  // ---------------------------------------------------------------------------
  // Test 37: Boss cùng Company SELECT được
  // ---------------------------------------------------------------------------
  const { data: bossASelectData } = await bossAClient.from('sales_style_profiles').select('*');
  const hasProfile1InBossA = Boolean(bossASelectData?.some((p) => p.id === profile1.id));
  assert(hasProfile1InBossA, 'Test 37: Boss in Company A can SELECT Sale A profile');

  // ---------------------------------------------------------------------------
  // Test 38: wrong-company Boss không SELECT
  // ---------------------------------------------------------------------------
  const { data: bossBSelectData } = await bossBClient.from('sales_style_profiles').select('*');
  const hasCompanyAProfileInBossB = Boolean(bossBSelectData?.some((p) => p.company_id === COMPANY_A_ID));
  assert(!hasCompanyAProfileInBossB, 'Test 38: Boss in Company B cannot SELECT Company A profiles');

  // ---------------------------------------------------------------------------
  // Test 39: audit success được ghi
  // ---------------------------------------------------------------------------
  const { data: auditLogs } = await adminClient
    .from('audit_logs')
    .select('*')
    .eq('resource_type', 'SALES_STYLE_PROFILE')
    .eq('resource_id', profile1.id);

  assert((auditLogs?.length ?? 0) === 1, 'Test 39: audit_log entry created for profile generation');
  const audit = auditLogs![0];
  assert(audit.action === 'SALES_STYLE_PROFILE_GENERATED', 'Test 39: audit action matches');
  assert(audit.result === 'SUCCESS', 'Test 39: audit result is SUCCESS');
  assert(audit.metadata.sale_user_id === saleAUserId, 'Test 39: audit metadata contains sale_user_id');
  assert(audit.metadata.version === profile1.version, 'Test 39: audit metadata contains version');
  assert(audit.metadata.model_version === 'gpt-4o-style-test', 'Test 39: audit metadata contains model_version');
  assert(audit.metadata.source_count === 6, 'Test 39: audit metadata contains source_count');

  // ---------------------------------------------------------------------------
  // Test 40: audit failure rollback profile creation
  // ---------------------------------------------------------------------------
  executeRawSql(`
    CREATE OR REPLACE FUNCTION trigger_fail_sales_style_audit_for_test()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.action = 'SALES_STYLE_PROFILE_GENERATED' AND NEW.metadata->>'model_version' = 'FORCED_AUDIT_FAIL_MODEL' THEN
        RAISE EXCEPTION 'SIMULATED_AUDIT_LOG_FAILURE';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_test_fail_audit ON public.audit_logs;
    CREATE TRIGGER trg_test_fail_audit
    BEFORE INSERT ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION trigger_fail_sales_style_audit_for_test();
  `);

  let auditFailedError = false;
  try {
    await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: sourceRefsA,
      styleOutput: VALID_STYLE_OUTPUT,
      modelVersion: 'FORCED_AUDIT_FAIL_MODEL',
    });
  } catch (err: unknown) {
    auditFailedError = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('SIMULATED_AUDIT_LOG_FAILURE'), `Test 40: RPC failed with audit exception (got: ${msg})`);
  }
  assert(auditFailedError, 'Test 40: Profile creation failed closed on audit error');

  // Verify that NO profile with FORCED_AUDIT_FAIL_MODEL exists in DB (transaction rollback)
  const { data: failedProfiles } = await bossAClient
    .from('sales_style_profiles')
    .select('id')
    .eq('model_version', 'FORCED_AUDIT_FAIL_MODEL');
  assert((failedProfiles?.length ?? 0) === 0, 'Test 40: profile creation rolled back completely (0 rows in DB)');

  // Clean up test trigger
  executeRawSql(`
    DROP TRIGGER IF EXISTS trg_test_fail_audit ON public.audit_logs;
    DROP FUNCTION IF EXISTS trigger_fail_sales_style_audit_for_test();
  `);

  // ---------------------------------------------------------------------------
  // Test 41: không UPDATE customer/stage/order/pricing/payment
  // ---------------------------------------------------------------------------
  const { data: custAfter } = await adminClient
    .from('customers')
    .select('stage')
    .eq('id', CUSTOMER_A_ID)
    .single();
  assert(custAfter?.stage === 'LEAD_NEW', 'Test 41: customer stage untouched (remains LEAD_NEW)');

  // ---------------------------------------------------------------------------
  // Test 42: no profile becomes ACTIVE in M9.4A
  // ---------------------------------------------------------------------------
  const { count: activeCount } = await bossAClient
    .from('sales_style_profiles')
    .select('*', { count: 'exact', head: true })
    .eq('generation_status', 'ACTIVE');
  assert(activeCount === 0, 'Test 42: exactly 0 profiles have generation_status = ACTIVE in M9.4A');

  // ---------------------------------------------------------------------------
  // Pipeline Integration Test: runSalesStyleLearningPipeline
  // ---------------------------------------------------------------------------
  console.log('\n--- Running Sales Style Pipeline Integration Test ---');
  const fakeModel = new FakeDeterministicSalesStyleModel('gemini-2.5-flash-test', VALID_STYLE_OUTPUT);
  const pipelineResult = await runSalesStyleLearningPipeline({
    model: fakeModel,
    companyId: COMPANY_A_ID,
    saleUserId: saleAUserId,
    client: adminClient,
    limit: 10,
  });
  assert(pipelineResult.generationStatus === 'DRAFT', 'Pipeline: output is DRAFT profile');
  assert(pipelineResult.modelVersion === 'gemini-2.5-flash-test', 'Pipeline: trusted modelVersion persisted');
  assert(pipelineResult.version.startsWith('ssp_'), 'Pipeline: version generated by server');

  // Verify pipeline throws NoStyleLearningSourcesError when target sale has 0 messages
  const COMPANY_C_ID = 'a0000000-0000-0000-0000-000000000003';
  await adminClient.from('companies').upsert([{ id: COMPANY_C_ID, name: 'Công ty C', status: 'ACTIVE' }]);
  const saleCId = await ensureUser(
    { email: 'style_sale_c@trusted.local', password: 'Password123!', fullName: 'Sale C' },
    COMPANY_C_ID,
    'SALE',
    'ACTIVE'
  );

  let emptySourceCaught = false;
  try {
    await runSalesStyleLearningPipeline({
      model: fakeModel,
      companyId: COMPANY_C_ID,
      saleUserId: saleCId,
      client: adminClient,
    });
  } catch (err) {
    if (err instanceof NoStyleLearningSourcesError) {
      emptySourceCaught = true;
    }
  }
  assert(emptySourceCaught, 'Pipeline: 0 messages available throws NoStyleLearningSourcesError fail-closed');

  console.log('\n==================================================');
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllSalesStyleTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
