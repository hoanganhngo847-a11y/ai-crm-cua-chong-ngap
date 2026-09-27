import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  fetchActiveSalesStyleProfile,
  persistSalesStyleProfile,
} from '../../features/sales-style/services/sales-style-store';
import { activateSalesStyleProfile } from '../../features/sales-style/services/sales-style-activation';
import type {
  SalesStyleOutput,
  SalesStyleSourceRef,
} from '../../shared/contracts/sales-style';

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
const COMPANY_A_ID = 'b0000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = 'b0000000-0000-0000-0000-000000000002';

const CUSTOMER_A_ID = 'b1000000-0000-0000-0000-000000000001';
const CUSTOMER_B_ID = 'b1000000-0000-0000-0000-000000000002';

const CONVO_A_ID = 'b2000000-0000-0000-0000-000000000001';
const CONVO_B_ID = 'b2000000-0000-0000-0000-000000000002';

const INT_A_1 = 'b3000000-0000-0000-0000-000000000001';
const INT_A_2 = 'b3000000-0000-0000-0000-000000000002';
const INT_B_1 = 'b3000000-0000-0000-0000-000000000003';
const INT_A_INBOUND = 'b3000000-0000-0000-0000-000000000004';
const INT_A_OTHER_SALE = 'b3000000-0000-0000-0000-000000000005';

// User credentials
const USER_BOSS_A = { email: 'act_boss_a@trusted.local', password: 'Password123!', fullName: 'Act Sếp Quản Trị A' };
const USER_INACTIVE_BOSS_A = { email: 'act_inact_boss_a@trusted.local', password: 'Password123!', fullName: 'Act Sếp Inactive A' };
const USER_SALE_A = { email: 'act_sale_a@trusted.local', password: 'Password123!', fullName: 'Act Nhân Viên Sale A' };
const USER_INACTIVE_SALE_A = { email: 'act_inact_sale_a@trusted.local', password: 'Password123!', fullName: 'Act Sale Inactive A' };
const USER_TECH_A = { email: 'act_tech_a@trusted.local', password: 'Password123!', fullName: 'Act Kỹ Thuật Viên A' };
const USER_BOSS_B = { email: 'act_boss_b@trusted.local', password: 'Password123!', fullName: 'Act Sếp Quản Trị B' };
const USER_SALE_B = { email: 'act_sale_b@trusted.local', password: 'Password123!', fullName: 'Act Nhân Viên Sale B' };

let bossAUserId: string;
let saleAUserId: string;
let inactiveSaleAUserId: string;
let bossBUserId: string;
let saleBUserId: string;

let bossAClient: SupabaseClient;
let inactiveBossAClient: SupabaseClient;
let saleAClient: SupabaseClient;
let techAClient: SupabaseClient;
let bossBClient: SupabaseClient;
let saleBClient: SupabaseClient;
let anonClient: SupabaseClient;

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

const SAMPLE_STYLE_OUTPUT: SalesStyleOutput = {
  salutationRules: {
    selfReferences: ['em', 'mình'],
    customerReferences: ['anh', 'chị'],
    commonOpenings: ['Dạ em chào anh/chị ạ'],
    notes: ['Chào hỏi lịch sự'],
  },
  sentenceStyle: {
    preferredLength: 'MEDIUM',
    toneDescriptors: ['chuyên nghiệp', 'nhiệt tình'],
    emojiUsage: 'LOW',
    punctuationPatterns: ['chấm câu rõ ràng'],
    notes: ['Ngắn gọn súc tích'],
  },
  questionStyle: {
    commonPatterns: ['Nhà mình rộng bao nhiêu mét ạ?'],
    discoveryApproach: ['Hỏi độ cao ngập nước'],
    followUpApproach: ['Nhắc lịch đo'],
    notes: ['Khảo sát nhu cầu'],
  },
  objectionStyle: {
    approaches: [
      {
        situation: 'Khách băn khoăn giá',
        responseApproach: 'Giải thích độ bền Inox 304 chuẩn công nghiệp',
      },
    ],
    notes: ['Tập trung vào chất lượng'],
  },
  closingStyle: {
    commonClosings: ['Em cảm ơn anh/chị'],
    callToActionPatterns: ['Anh cho em xin lịch đo nhé'],
    urgencyStyle: ['Mùa mưa đang đến gần'],
    notes: ['Chốt lịch khảo sát'],
  },
};

async function setupDatabaseFixtures() {
  console.log('--- Setting up Sales Style Activation test fixtures ---');

  // 1. Companies
  const { error: errComp } = await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'Công ty Cửa Chống Ngập Activation A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'Công ty Cửa Chống Ngập Activation B', status: 'ACTIVE' },
  ]);
  if (errComp) throw new Error(`Companies upsert failed: ${errComp.message}`);

  // 2. Users & Members
  bossAUserId = await ensureUser(USER_BOSS_A, COMPANY_A_ID, 'BOSS_ADMIN', 'ACTIVE');
  await ensureUser(USER_INACTIVE_BOSS_A, COMPANY_A_ID, 'BOSS_ADMIN', 'INACTIVE');
  saleAUserId = await ensureUser(USER_SALE_A, COMPANY_A_ID, 'SALE', 'ACTIVE');
  inactiveSaleAUserId = await ensureUser(USER_INACTIVE_SALE_A, COMPANY_A_ID, 'SALE', 'INACTIVE');
  await ensureUser(USER_TECH_A, COMPANY_A_ID, 'TECHNICIAN', 'ACTIVE');
  bossBUserId = await ensureUser(USER_BOSS_B, COMPANY_B_ID, 'BOSS_ADMIN', 'ACTIVE');
  saleBUserId = await ensureUser(USER_SALE_B, COMPANY_B_ID, 'SALE', 'ACTIVE');

  // Authenticate user clients
  bossAClient = createAnonClient();
  await bossAClient.auth.signInWithPassword({ email: USER_BOSS_A.email, password: USER_BOSS_A.password });

  inactiveBossAClient = createAnonClient();
  await inactiveBossAClient.auth.signInWithPassword({
    email: USER_INACTIVE_BOSS_A.email,
    password: USER_INACTIVE_BOSS_A.password,
  });

  saleAClient = createAnonClient();
  await saleAClient.auth.signInWithPassword({ email: USER_SALE_A.email, password: USER_SALE_A.password });

  techAClient = createAnonClient();
  await techAClient.auth.signInWithPassword({ email: USER_TECH_A.email, password: USER_TECH_A.password });

  bossBClient = createAnonClient();
  await bossBClient.auth.signInWithPassword({ email: USER_BOSS_B.email, password: USER_BOSS_B.password });

  saleBClient = createAnonClient();
  await saleBClient.auth.signInWithPassword({ email: USER_SALE_B.email, password: USER_SALE_B.password });

  anonClient = createAnonClient();

  // 3. Customers
  const { error: errCust } = await adminClient.from('customers').upsert([
    {
      id: CUSTOMER_A_ID,
      company_id: COMPANY_A_ID,
      customer_code: 'KH-ACT-001',
      name: 'Khách Activation A',
      source: 'FACEBOOK',
      stage: 'LEAD_NEW',
    },
    {
      id: CUSTOMER_B_ID,
      company_id: COMPANY_B_ID,
      customer_code: 'KH-ACT-002',
      name: 'Khách Activation B',
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
      external_conversation_id: 'ext_act_a',
      status: 'OPEN',
    },
    {
      id: CONVO_B_ID,
      company_id: COMPANY_B_ID,
      customer_id: CUSTOMER_B_ID,
      channel: 'ZALO',
      external_conversation_id: 'ext_act_b',
      status: 'OPEN',
    },
  ]);
  if (errConvo) throw new Error(`Conversations upsert failed: ${errConvo.message}`);

  const now = new Date();
  const timeOffset = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60 * 1000).toISOString();

  // 5. Interactions
  const { error: errInt } = await adminClient.from('interactions').upsert([
    {
      id: INT_A_1,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Chào anh, em hỗ trợ tư vấn cửa chống ngập ạ.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(20),
    },
    {
      id: INT_A_2,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitized_content: 'Cửa nhà mình lắp ở tầng trệt đúng không anh?',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(10),
    },
    {
      id: INT_B_1,
      company_id: COMPANY_B_ID,
      customer_id: CUSTOMER_B_ID,
      conversation_id: CONVO_B_ID,
      channel: 'ZALO',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleBUserId,
      sanitized_content: 'Chào bạn, công ty cửa chống ngập xin nghe ạ.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(15),
    },
    {
      id: INT_A_INBOUND,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      actor_user_id: null,
      sanitized_content: 'Chào em, tư vấn cho anh về cửa chống ngập nhé.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(25),
    },
    {
      id: INT_A_OTHER_SALE,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: inactiveSaleAUserId,
      sanitized_content: 'Chào anh, em là nhân viên Sale khác hỗ trợ.',
      sanitization_status: 'SUCCEEDED',
      created_at: timeOffset(22),
    },
  ]);
  if (errInt) throw new Error(`Interactions upsert failed: ${errInt.message}`);

  // Clean existing profiles for these companies
  executeRawSql(`
    DELETE FROM public.sales_style_profiles WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
  `);

  console.log('--- Activation fixtures successfully initialized ---');
}

async function helperCreateDraft(
  companyId: string,
  saleUserId: string,
  interactionId: string
) {
  const sourceRefs: SalesStyleSourceRef[] = [{ type: 'INTERACTION', id: interactionId }];
  return await persistSalesStyleProfile(adminClient, {
    companyId,
    saleUserId,
    sourceRefs,
    styleOutput: SAMPLE_STYLE_OUTPUT,
    modelVersion: 'gemini-1.5-pro-preview',
  });
}

async function runTests() {
  await setupDatabaseFixtures();

  console.log('\n==================================================');
  console.log('STARTING SALES STYLE APPROVAL & ACTIVATION TESTS (M9.4B)');
  console.log('==================================================\n');

  // --------------------------------------------------------------------------
  // TEST GROUP 1: Canonical Activation Happy Path (Tests 1, 2, 3, 13, 21-25, 32, 34, 35)
  // --------------------------------------------------------------------------
  console.log('--- TEST GROUP 1: Canonical Activation Happy Path ---');
  const draft1 = await helperCreateDraft(COMPANY_A_ID, saleAUserId, INT_A_1);
  assert(draft1.generationStatus === 'DRAFT', 'Initial profile is DRAFT');
  assert(draft1.activatedAt === null, 'DRAFT activatedAt is null');
  assert(draft1.activatedByUserId === null, 'DRAFT activatedByUserId is null');

  const activated1 = await activateSalesStyleProfile(bossAClient, draft1.id);

  // Test 1: active same-company BOSS activates DRAFT -> ACTIVE
  assert(activated1.generationStatus === 'ACTIVE', 'Test 1: active same-company BOSS activates DRAFT -> ACTIVE');
  // Test 2: target activated_at set
  assert(activated1.activatedAt !== null, 'Test 2: target activated_at set');
  assert(typeof activated1.activatedAt === 'string', 'Test 2: target activated_at is ISO string');
  // Test 3: activated_by_user_id = actual auth.uid()
  assert(activated1.activatedByUserId === bossAUserId, 'Test 3: activated_by_user_id = actual auth.uid()');
  // Test 13: DRAFT -> ACTIVE works
  assert(activated1.id === draft1.id, 'Test 13: returned profile ID matches draft ID');
  // Test 21: new style JSON unchanged during activation
  assert(
    JSON.stringify(activated1.salutationRules) === JSON.stringify(draft1.salutationRules),
    'Test 21: salutationRules unchanged during activation'
  );
  assert(
    JSON.stringify(activated1.sentenceStyle) === JSON.stringify(draft1.sentenceStyle),
    'Test 21: sentenceStyle unchanged during activation'
  );
  assert(
    JSON.stringify(activated1.questionStyle) === JSON.stringify(draft1.questionStyle),
    'Test 21: questionStyle unchanged during activation'
  );
  assert(
    JSON.stringify(activated1.objectionStyle) === JSON.stringify(draft1.objectionStyle),
    'Test 21: objectionStyle unchanged during activation'
  );
  assert(
    JSON.stringify(activated1.closingStyle) === JSON.stringify(draft1.closingStyle),
    'Test 21: closingStyle unchanged during activation'
  );
  // Test 22: source_refs unchanged
  assert(
    JSON.stringify(activated1.sourceRefs) === JSON.stringify(draft1.sourceRefs),
    'Test 22: source_refs unchanged during activation'
  );
  // Test 23: examples unchanged
  assert(
    JSON.stringify(activated1.examples) === JSON.stringify(draft1.examples),
    'Test 23: examples unchanged during activation'
  );
  // Test 24: model_version unchanged
  assert(activated1.modelVersion === draft1.modelVersion, 'Test 24: model_version unchanged');
  // Test 25: version unchanged
  assert(activated1.version === draft1.version, 'Test 25: version unchanged');

  // Test 32: activation audit created
  const { data: audits1 } = await adminClient
    .from('audit_logs')
    .select('*')
    .eq('resource_id', draft1.id)
    .eq('action', 'SALES_STYLE_PROFILE_ACTIVATED');
  assert(audits1 !== null && audits1.length === 1, 'Test 32: activation audit created');
  const audit1 = audits1![0];
  // Test 34: audit actor is BOSS auth.uid()
  assert(audit1.user_id === bossAUserId, 'Test 34: audit actor is BOSS auth.uid()');
  assert(audit1.company_id === COMPANY_A_ID, 'Test 34: audit company_id matches');
  assert(audit1.result === 'SUCCESS', 'Test 34: audit result is SUCCESS');
  // Test 35: audit contains no style/message content
  const meta1 = audit1.metadata as Record<string, unknown>;
  assert(meta1.sale_user_id === saleAUserId, 'Test 35: audit metadata contains sale_user_id');
  assert(meta1.version === draft1.version, 'Test 35: audit metadata contains version');
  assert(meta1.previous_active_profile_id === null, 'Test 35: previous_active_profile_id is null for first activation');
  assert(meta1.salutation_rules === undefined, 'Test 35: audit contains no salutation_rules');
  assert(meta1.content === undefined, 'Test 35: audit contains no message content');
  assert(meta1.sentence_style === undefined, 'Test 35: audit contains no sentence_style');

  // --------------------------------------------------------------------------
  // TEST GROUP 2: Authorization Checks & Privilege Fail-Closed (Tests 4-9)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: Authorization & Role Checks ---');
  const draftForAuth = await helperCreateDraft(COMPANY_A_ID, saleAUserId, INT_A_2);

  // Test 4: SALE actor denied
  let saleDenied = false;
  try {
    await activateSalesStyleProfile(saleAClient, draftForAuth.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    saleDenied = msg.includes('ACTOR_ROLE_NOT_BOSS_ADMIN') || msg.includes('42501');
  }
  assert(saleDenied, 'Test 4: SALE actor denied fail-closed');

  // Test 5: TECH actor denied
  let techDenied = false;
  try {
    await activateSalesStyleProfile(techAClient, draftForAuth.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    techDenied = msg.includes('ACTOR_ROLE_NOT_BOSS_ADMIN') || msg.includes('42501');
  }
  assert(techDenied, 'Test 5: TECH actor denied fail-closed');

  // Test 6: BOSS other company denied
  let bossBDenied = false;
  try {
    await activateSalesStyleProfile(bossBClient, draftForAuth.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    bossBDenied = msg.includes('ACTOR_MEMBERSHIP_NOT_FOUND') || msg.includes('42501');
  }
  assert(bossBDenied, 'Test 6: BOSS other company denied fail-closed');

  // Test 7: inactive BOSS denied
  let inactBossDenied = false;
  try {
    await activateSalesStyleProfile(inactiveBossAClient, draftForAuth.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    inactBossDenied = msg.includes('ACTOR_MEMBERSHIP_INACTIVE') || msg.includes('42501');
  }
  assert(inactBossDenied, 'Test 7: inactive BOSS denied fail-closed');

  // Test 8: anonymous denied
  let anonDenied = false;
  try {
    await activateSalesStyleProfile(anonClient, draftForAuth.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    anonDenied = msg.includes('UNAUTHENTICATED') || msg.includes('42501');
  }
  assert(anonDenied, 'Test 8: anonymous denied fail-closed');

  // Test 9: service_role cannot execute human activation RPC
  let serviceRoleDenied = false;
  try {
    await activateSalesStyleProfile(adminClient, draftForAuth.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    serviceRoleDenied =
      msg.includes('permission denied for function') ||
      msg.includes('42501') ||
      msg.includes('UNAUTHENTICATED');
  }
  assert(serviceRoleDenied, 'Test 9: service_role cannot execute human activation RPC');

  // --------------------------------------------------------------------------
  // TEST GROUP 3: Target Resource Validation (Tests 10, 11, 12)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: Target Resource & Sale Revalidation ---');

  // Test 10: target profile not found -> fail
  let notFoundFailed = false;
  try {
    await activateSalesStyleProfile(bossAClient, randomUUID());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    notFoundFailed = msg.includes('PROFILE_NOT_FOUND') || msg.includes('P0002');
  }
  assert(notFoundFailed, 'Test 10: target profile not found fails closed with PROFILE_NOT_FOUND');

  // Test 11: inactive target Sale -> deny
  const inactIntId = 'b3000000-0000-0000-0000-000000000099';
  executeRawSql(`
    INSERT INTO public.interactions (
      id, company_id, customer_id, conversation_id, channel, type, direction,
      actor_type, actor_user_id, sanitized_content, sanitization_status, created_at
    ) VALUES (
      '${inactIntId}', '${COMPANY_A_ID}', '${CUSTOMER_A_ID}', '${CONVO_A_ID}', 'FACEBOOK', 'MESSAGE', 'OUTBOUND',
      'SALE', '${inactiveSaleAUserId}', 'Dạ em chào anh', 'SUCCEEDED', now()
    ) ON CONFLICT (id) DO NOTHING;
  `);

  const inactDraftId = randomUUID();
  const inactVersion = 'ssp_' + randomUUID().replace(/-/g, '');
  executeRawSql(`
    INSERT INTO public.sales_style_profiles (
      id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
      objection_style, closing_style, examples, source_refs, model_version, generation_status
    ) VALUES (
      '${inactDraftId}', '${COMPANY_A_ID}', '${inactiveSaleAUserId}', '${inactVersion}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
      '[]'::jsonb, '[{"type": "INTERACTION", "id": "${inactIntId}"}]'::jsonb,
      'gemini-1.5-pro', 'DRAFT'
    );
  `);

  let inactiveSaleDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, inactDraftId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    inactiveSaleDenied = msg.includes('TARGET_SALE_INACTIVE') || msg.includes('42501');
  }
  assert(inactiveSaleDenied, 'Test 11: inactive target Sale denied fail-closed');

  // Test 12: target no longer SALE -> deny
  const roleTestDraft = await helperCreateDraft(COMPANY_A_ID, saleAUserId, INT_A_2);
  executeRawSql(`UPDATE public.company_members SET role = 'TECHNICIAN' WHERE company_id = '${COMPANY_A_ID}' AND user_id = '${saleAUserId}';`);

  let roleChangedDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, roleTestDraft.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    roleChangedDenied = msg.includes('TARGET_NOT_SALE') || msg.includes('42501');
  }
  assert(roleChangedDenied, 'Test 12: target no longer SALE denied fail-closed');

  // Restore Sale A role to SALE
  executeRawSql(`UPDATE public.company_members SET role = 'SALE' WHERE company_id = '${COMPANY_A_ID}' AND user_id = '${saleAUserId}';`);

  // --------------------------------------------------------------------------
  // TEST GROUP 4: Idempotency & Supersede Semantics (Tests 14-20, 26, 33)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: Idempotency & Supersede Semantics ---');

  // Test 14: ACTIVE retry is idempotent
  const auditCountBefore = (
    await adminClient
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .eq('resource_id', draft1.id)
      .eq('action', 'SALES_STYLE_PROFILE_ACTIVATED')
  ).count;

  const retryActivated1 = await activateSalesStyleProfile(bossAClient, draft1.id);
  assert(retryActivated1.id === draft1.id, 'Test 14: ACTIVE retry returns existing profile ID');
  assert(retryActivated1.activatedAt === activated1.activatedAt, 'Test 14: ACTIVE retry preserves activatedAt timestamp');
  assert(retryActivated1.version === activated1.version, 'Test 14: ACTIVE retry preserves version');

  // Test 15: ACTIVE retry does not duplicate audit
  const auditCountAfter = (
    await adminClient
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .eq('resource_id', draft1.id)
      .eq('action', 'SALES_STYLE_PROFILE_ACTIVATED')
  ).count;
  assert(auditCountBefore === auditCountAfter, 'Test 15: ACTIVE retry does not duplicate audit log');

  // Now activate draftForAuth (draft 2) -> this should supersede draft 1!
  const activated2 = await activateSalesStyleProfile(bossAClient, draftForAuth.id);
  assert(activated2.generationStatus === 'ACTIVE', 'Test 17: draft 2 transitioned to ACTIVE');

  // Test 17: existing ACTIVE becomes SUPERSEDED
  const { data: supersededRows } = await bossAClient
    .from('sales_style_profiles')
    .select('*')
    .eq('id', draft1.id);
  assert(supersededRows !== null && supersededRows.length === 1, 'Found old active row in DB');
  const oldActive = supersededRows![0];
  assert(oldActive.generation_status === 'SUPERSEDED', 'Test 17: existing ACTIVE becomes SUPERSEDED');

  // Test 18: old superseded_at populated
  assert(oldActive.superseded_at !== null, 'Test 18: old superseded_at populated');

  // Test 19: old superseded_by_profile_id = new active ID
  assert(oldActive.superseded_by_profile_id === draftForAuth.id, 'Test 19: old superseded_by_profile_id = new active ID');

  // Retains original activated_at and activated_by_user_id
  assert(oldActive.activated_at === activated1.activatedAt, 'Old profile preserves original activated_at');
  assert(oldActive.activated_by_user_id === bossAUserId, 'Old profile preserves original activated_by_user_id');

  // Test 20: old style JSON unchanged
  assert(
    JSON.stringify(oldActive.salutation_rules) === JSON.stringify(draft1.salutationRules),
    'Test 20: old salutation_rules unchanged'
  );
  assert(
    JSON.stringify(oldActive.sentence_style) === JSON.stringify(draft1.sentenceStyle),
    'Test 20: old sentence_style unchanged'
  );
  assert(
    JSON.stringify(oldActive.question_style) === JSON.stringify(draft1.questionStyle),
    'Test 20: old question_style unchanged'
  );
  assert(
    JSON.stringify(oldActive.objection_style) === JSON.stringify(draft1.objectionStyle),
    'Test 20: old objection_style unchanged'
  );
  assert(
    JSON.stringify(oldActive.closing_style) === JSON.stringify(draft1.closingStyle),
    'Test 20: old closing_style unchanged'
  );

  // Test 16: SUPERSEDED cannot reactivate
  let reactivateDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draft1.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    reactivateDenied = msg.includes('PROFILE_ALREADY_SUPERSEDED') || msg.includes('22000');
  }
  assert(reactivateDenied, 'Test 16: SUPERSEDED cannot reactivate fail-closed with PROFILE_ALREADY_SUPERSEDED');

  // Test 26: exactly one ACTIVE per (company_id, sale_user_id)
  const { data: allActiveRows } = await bossAClient
    .from('sales_style_profiles')
    .select('id')
    .eq('company_id', COMPANY_A_ID)
    .eq('sale_user_id', saleAUserId)
    .eq('generation_status', 'ACTIVE');
  assert(allActiveRows !== null && allActiveRows.length === 1, 'Test 26: exactly one ACTIVE per (company_id, sale_user_id)');
  assert(allActiveRows![0].id === draftForAuth.id, 'Test 26: canonical active profile matches latest activated');

  // Test 33: supersede audit created when replacing ACTIVE
  const { data: supersedeAudits } = await adminClient
    .from('audit_logs')
    .select('*')
    .eq('resource_id', draft1.id)
    .eq('action', 'SALES_STYLE_PROFILE_SUPERSEDED');
  assert(supersedeAudits !== null && supersedeAudits.length === 1, 'Test 33: supersede audit created');
  const supAudit = supersedeAudits![0];
  assert(supAudit.user_id === bossAUserId, 'Test 33: supersede audit user_id is boss auth.uid()');
  const supMeta = supAudit.metadata as Record<string, unknown>;
  assert(supMeta.superseded_by_profile_id === draftForAuth.id, 'Test 33: metadata has superseded_by_profile_id');
  assert(supMeta.sale_user_id === saleAUserId, 'Test 33: metadata has sale_user_id');

  // --------------------------------------------------------------------------
  // TEST GROUP 5: Tenant Isolation & Multi-Sale Isolation (Tests 30, 31)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: Tenant & Sale Isolation ---');

  // Create and activate draft for Sale B in Company B
  const draftB1 = await helperCreateDraft(COMPANY_B_ID, saleBUserId, INT_B_1);
  const activatedB1 = await activateSalesStyleProfile(bossBClient, draftB1.id);
  assert(activatedB1.generationStatus === 'ACTIVE', 'Sale B in Company B activated');
  assert(activatedB1.activatedByUserId === bossBUserId, 'Sale B activated by boss B');

  // Test 30 & 31: Verify Company A activation did not affect Sale B, and vice versa
  const { data: compAActive } = await bossAClient
    .from('sales_style_profiles')
    .select('id')
    .eq('company_id', COMPANY_A_ID)
    .eq('generation_status', 'ACTIVE');
  assert(compAActive !== null && compAActive.length === 1, 'Test 31: Company A still has exactly 1 active profile');
  assert(compAActive![0].id === draftForAuth.id, 'Test 30: Company A active profile untouched');

  const { data: compBActive } = await bossBClient
    .from('sales_style_profiles')
    .select('id')
    .eq('company_id', COMPANY_B_ID)
    .eq('generation_status', 'ACTIVE');
  assert(compBActive !== null && compBActive.length === 1, 'Test 31: Company B has exactly 1 active profile');
  assert(compBActive![0].id === draftB1.id, 'Test 31: Company B active profile matches Sale B');

  // --------------------------------------------------------------------------
  // TEST GROUP 6: Hard DB Invariant: Partial Unique Index (Test 27)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 6: Partial Unique Index Hard Safety Net ---');
  let uniqueViolationCaught = false;
  try {
    const rogueId = randomUUID();
    const rogueVersion = 'ssp_' + randomUUID().replace(/-/g, '');
    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status,
        activated_at, activated_by_user_id
      ) VALUES (
        '${rogueId}', '${COMPANY_A_ID}', '${saleAUserId}', '${rogueVersion}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
        '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb,
        'gemini-1.5-pro', 'ACTIVE',
        now(), '${bossAUserId}'
      );
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    uniqueViolationCaught =
      msg.includes('uq_sales_style_profiles_active_sale') || msg.includes('23505');
  }
  assert(
    uniqueViolationCaught,
    'Test 27: partial unique index independently rejects second ACTIVE if RPC bypass attempted from postgres fixture'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 7: Real Concurrency Testing (Tests 28, 29)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 7: Real Concurrency Test ---');
  // Create two distinct DRAFT profiles for Sale A
  const concDraft1 = await helperCreateDraft(COMPANY_A_ID, saleAUserId, INT_A_1);
  const concDraft2 = await helperCreateDraft(COMPANY_A_ID, saleAUserId, INT_A_2);

  console.log(`Launching concurrent activations: ${concDraft1.id} & ${concDraft2.id}`);
  const results = await Promise.allSettled([
    activateSalesStyleProfile(bossAClient, concDraft1.id),
    activateSalesStyleProfile(bossAClient, concDraft2.id),
  ]);

  const settledSuccesses = results.filter((r) => r.status === 'fulfilled');
  console.log(`Concurrent results: ${settledSuccesses.length} fulfilled out of 2`);

  // Test 28: exactly one ACTIVE at end
  const { data: concActiveRows } = await bossAClient
    .from('sales_style_profiles')
    .select('id, generation_status')
    .eq('company_id', COMPANY_A_ID)
    .eq('sale_user_id', saleAUserId)
    .eq('generation_status', 'ACTIVE');
  assert(concActiveRows !== null && concActiveRows.length === 1, 'Test 28: exactly one ACTIVE at end of concurrency');

  // Test 29: concurrent loser/winner leaves other profile SUPERSEDED, not two ACTIVE
  const { data: testPairRows } = await bossAClient
    .from('sales_style_profiles')
    .select('id, generation_status, superseded_by_profile_id')
    .in('id', [concDraft1.id, concDraft2.id]);
  assert(testPairRows !== null && testPairRows.length === 2, 'Found both concurrent profiles in DB');

  const activeInPair = testPairRows!.filter((r) => r.generation_status === 'ACTIVE');
  const supersededInPair = testPairRows!.filter((r) => r.generation_status === 'SUPERSEDED');
  assert(activeInPair.length === 1, 'Test 29: exactly 1 ACTIVE profile in the concurrent pair');
  assert(supersededInPair.length === 1, 'Test 29: exactly 1 SUPERSEDED profile in the concurrent pair');
  assert(
    supersededInPair[0].superseded_by_profile_id === activeInPair[0].id,
    'Test 29: loser profile superseded_by_profile_id points to winner'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 8: Audit Failure Rollback (Tests 36, 37)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 8: Audit Failure Rollback ---');
  // Current active is activeInPair[0].id.
  // Create a new draft. Then attach a failing trigger to audit_logs for action SALES_STYLE_PROFILE_ACTIVATED.
  const rollbackDraft = await helperCreateDraft(COMPANY_A_ID, saleAUserId, INT_A_1);

  executeRawSql(`
    CREATE OR REPLACE FUNCTION public.test_fail_audit_activation()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'SALES_STYLE_PROFILE_ACTIVATED' THEN
        RAISE EXCEPTION 'SIMULATED_AUDIT_LOG_ACTIVATION_FAILURE' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_test_fail_audit_activation ON public.audit_logs;
    CREATE TRIGGER trg_test_fail_audit_activation
      BEFORE INSERT ON public.audit_logs
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_audit_activation();
  `);

  let auditFailErrorThrown = false;
  try {
    await activateSalesStyleProfile(bossAClient, rollbackDraft.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    auditFailErrorThrown =
      msg.includes('SIMULATED_AUDIT_LOG_ACTIVATION_FAILURE') || msg.includes('P0001');
  }

  // Remove the failing trigger immediately
  executeRawSql(`
    DROP TRIGGER IF EXISTS trg_test_fail_audit_activation ON public.audit_logs;
    DROP FUNCTION IF EXISTS public.test_fail_audit_activation();
  `);

  assert(auditFailErrorThrown, 'Test 36: RPC failed with audit exception');

  // Test 36: target remains DRAFT (rolled back)
  const { data: rbDraftRows } = await bossAClient
    .from('sales_style_profiles')
    .select('generation_status')
    .eq('id', rollbackDraft.id);
  assert(rbDraftRows !== null && rbDraftRows[0].generation_status === 'DRAFT', 'Test 36: target activation rolled back (remains DRAFT)');

  // Test 37: prior ACTIVE remains ACTIVE (rollback of supersede)
  const { data: priorActiveRows } = await bossAClient
    .from('sales_style_profiles')
    .select('generation_status')
    .eq('id', activeInPair[0].id);
  assert(
    priorActiveRows !== null && priorActiveRows[0].generation_status === 'ACTIVE',
    'Test 37: old profile supersede rolled back (remains ACTIVE)'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 9: Table ACL Mutation Lockdown (Tests 38, 39)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 9: Table ACL Mutation Lockdown ---');
  // Test 38: authenticated direct UPDATE table remains denied
  const { error: bossUpdateErr } = await bossAClient
    .from('sales_style_profiles')
    .update({ generation_status: 'ACTIVE' })
    .eq('id', rollbackDraft.id);
  assert(
    bossUpdateErr !== null && (bossUpdateErr.code === '42501' || bossUpdateErr.message.includes('permission denied')),
    'Test 38: authenticated BOSS direct UPDATE denied by table ACL'
  );

  const { error: saleUpdateErr } = await saleAClient
    .from('sales_style_profiles')
    .update({ generation_status: 'ACTIVE' })
    .eq('id', rollbackDraft.id);
  assert(
    saleUpdateErr !== null && (saleUpdateErr.code === '42501' || saleUpdateErr.message.includes('permission denied')),
    'Test 38: authenticated SALE direct UPDATE denied by table ACL'
  );

  // Test 39: service_role direct UPDATE remains denied
  const { error: adminUpdateErr } = await adminClient
    .from('sales_style_profiles')
    .update({ generation_status: 'ACTIVE' })
    .eq('id', rollbackDraft.id);
  assert(
    adminUpdateErr !== null && (adminUpdateErr.code === '42501' || adminUpdateErr.message.includes('permission denied')),
    'Test 39: service_role direct UPDATE remains denied by table ACL'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 10: Bounded Active Profile Runtime Read RPC (Tests 40-44)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 10: Bounded Active Profile Read RPC ---');

  // Test 40: bounded active-profile RPC service_role succeeds
  const activeProfileRuntime = await fetchActiveSalesStyleProfile(adminClient, {
    companyId: COMPANY_A_ID,
    saleUserId: saleAUserId,
  });
  assert(activeProfileRuntime !== null, 'Test 40: bounded active-profile RPC service_role succeeds');
  assert(activeProfileRuntime!.id === activeInPair[0].id, 'Test 40: returned active profile ID matches canonical active');
  assert(activeProfileRuntime!.saleUserId === saleAUserId, 'Test 40: returned saleUserId matches');
  assert(activeProfileRuntime!.version.startsWith('ssp_'), 'Test 40: returned version is valid');
  assert(typeof activeProfileRuntime!.activatedAt === 'string', 'Test 40: returned activatedAt is valid');

  // Test 41: active-profile RPC returns only ACTIVE (null when no active exists)
  const inactiveSaleRuntime = await fetchActiveSalesStyleProfile(adminClient, {
    companyId: COMPANY_A_ID,
    saleUserId: inactiveSaleAUserId,
  }).catch(() => null);
  assert(inactiveSaleRuntime === null, 'Test 41: active-profile RPC returns null/empty when no ACTIVE exists');

  // Test 42: active-profile RPC returns max one
  assert(
    typeof activeProfileRuntime === 'object' && !Array.isArray(activeProfileRuntime),
    'Test 42: active-profile RPC returns max one record'
  );

  // Test 43: active-profile RPC excludes source_refs/examples
  const runtimeKeys = Object.keys(activeProfileRuntime!);
  assert(!runtimeKeys.includes('source_refs'), 'Test 43: active-profile RPC excludes source_refs');
  assert(!runtimeKeys.includes('sourceRefs'), 'Test 43: active-profile RPC excludes sourceRefs');
  assert(!runtimeKeys.includes('examples'), 'Test 43: active-profile RPC excludes examples');

  // Test 44: active-profile RPC wrong company gives no access/fails closed
  let crossCompFailed = false;
  try {
    await fetchActiveSalesStyleProfile(adminClient, {
      companyId: COMPANY_B_ID,
      saleUserId: saleAUserId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    crossCompFailed = msg.includes('MEMBERSHIP_NOT_FOUND') || msg.includes('42501');
  }
  assert(crossCompFailed, 'Test 44: active-profile RPC wrong company gives no access/fails closed');

  // --------------------------------------------------------------------------
  // TEST GROUP 11: RLS Select Verification (Tests 45-47)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 11: Foundation RLS Read Baseline ---');

  // Test 45: SALE can read own profiles
  const { data: saleOwnProfiles, error: saleSelectErr } = await saleAClient
    .from('sales_style_profiles')
    .select('id, sale_user_id');
  assert(saleSelectErr === null, 'Sale SELECT does not error');
  assert(
    saleOwnProfiles !== null && saleOwnProfiles.length > 0,
    'Test 45: SALE can read own profiles via RLS'
  );
  assert(
    saleOwnProfiles!.every((p) => p.sale_user_id === saleAUserId),
    'Test 45: all profiles read by SALE strictly belong to SALE'
  );

  // Test 46: BOSS can read same-company profiles
  const { data: bossSameCompProfiles, error: bossSelectErr } = await bossAClient
    .from('sales_style_profiles')
    .select('id, company_id');
  assert(bossSelectErr === null, 'Boss SELECT does not error');
  assert(
    bossSameCompProfiles !== null && bossSameCompProfiles.length > 0,
    'Test 46: BOSS can read same-company profiles via RLS'
  );
  assert(
    bossSameCompProfiles!.every((p) => p.company_id === COMPANY_A_ID),
    'Test 46: all profiles read by BOSS strictly belong to Company A'
  );

  // Test 47: TECH cannot read profiles (0 rows)
  const { data: techProfiles, error: techSelectErr } = await techAClient
    .from('sales_style_profiles')
    .select('id');
  assert(techSelectErr === null, 'Tech SELECT does not error');
  assert(techProfiles !== null && techProfiles.length === 0, 'Test 47: TECH cannot read profiles (0 rows)');

  // --------------------------------------------------------------------------
  // TEST GROUP 12: Business Tables Mutation Integrity (Test 48)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 12: Business Invariants ---');
  // Test 48: no customer/order/pricing/payment/stage mutation occurs
  const { data: custRow } = await adminClient.from('customers').select('stage').eq('id', CUSTOMER_A_ID).single();
  assert(custRow?.stage === 'LEAD_NEW', 'Test 48: customer stage remains LEAD_NEW');

  const { data: orders } = await adminClient.from('orders').select('id').eq('company_id', COMPANY_A_ID);
  assert(orders !== null && orders.length === 0, 'Test 48: zero order rows mutated or created');

  const { data: payments } = await adminClient.from('payment_transactions').select('id').eq('company_id', COMPANY_A_ID);
  assert(payments !== null && payments.length === 0, 'Test 48: zero payment transactions created');

  // --------------------------------------------------------------------------
  // TEST GROUP 13: DB CHECK Constraint Tests (Section 23)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 13: DB CHECK Constraint Tests ---');

  // 1. DRAFT + activated_at rejected
  let draftActivatedAtRejected = false;
  try {
    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status,
        activated_at
      ) VALUES (
        '${randomUUID()}', '${COMPANY_A_ID}', '${saleAUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
        '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb,
        'gemini-1.5-pro', 'DRAFT',
        now()
      );
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    draftActivatedAtRejected =
      msg.includes('chk_sales_style_profile_lifecycle') || msg.includes('23514');
  }
  assert(draftActivatedAtRejected, 'Section 23: DRAFT + activated_at rejected by CHECK constraint');

  // 2. ACTIVE + NULL activated_by_user_id rejected
  let activeNullActivatedByRejected = false;
  try {
    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status,
        activated_at, activated_by_user_id
      ) VALUES (
        '${randomUUID()}', '${COMPANY_A_ID}', '${saleAUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
        '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb,
        'gemini-1.5-pro', 'ACTIVE',
        now(), NULL
      );
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    activeNullActivatedByRejected =
      msg.includes('chk_sales_style_profile_lifecycle') || msg.includes('23514');
  }
  assert(activeNullActivatedByRejected, 'Section 23: ACTIVE + NULL activated_by rejected by CHECK constraint');

  // 3. ACTIVE + superseded_at rejected
  let activeSupersededAtRejected = false;
  try {
    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status,
        activated_at, activated_by_user_id, superseded_at
      ) VALUES (
        '${randomUUID()}', '${COMPANY_A_ID}', '${saleAUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
        '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb,
        'gemini-1.5-pro', 'ACTIVE',
        now(), '${bossAUserId}', now()
      );
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    activeSupersededAtRejected =
      msg.includes('chk_sales_style_profile_lifecycle') || msg.includes('23514');
  }
  assert(activeSupersededAtRejected, 'Section 23: ACTIVE + superseded_at rejected by CHECK constraint');

  // 4. SUPERSEDED + NULL superseded_by_profile_id rejected
  let supersededNullRefRejected = false;
  try {
    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status,
        activated_at, activated_by_user_id, superseded_at, superseded_by_profile_id
      ) VALUES (
        '${randomUUID()}', '${COMPANY_A_ID}', '${saleAUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
        '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb,
        'gemini-1.5-pro', 'SUPERSEDED',
        now(), '${bossAUserId}', now(), NULL
      );
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    supersededNullRefRejected =
      msg.includes('chk_sales_style_profile_lifecycle') || msg.includes('23514');
  }
  assert(supersededNullRefRejected, 'Section 23: SUPERSEDED + NULL superseded_by_profile_id rejected by CHECK constraint');

  // --------------------------------------------------------------------------
  // TEST GROUP 14: Untrusted & Legacy DRAFT Provenance & Safety Tests (10 tests)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 14: Untrusted & Legacy DRAFT Provenance & Safety Tests ---');

  // Helper to insert arbitrary raw DRAFT via postgres superuser
  function insertRawDraft(overrides: {
    id?: string;
    companyId?: string;
    saleUserId?: string;
    modelVersion?: string | null;
    sourceRefs?: string;
    salutationRules?: string;
    sentenceStyle?: string;
    questionStyle?: string;
    objectionStyle?: string;
    closingStyle?: string;
    examples?: string;
  }): string {
    const draftId = overrides.id || randomUUID();
    const compId = overrides.companyId || COMPANY_A_ID;
    const saleId = overrides.saleUserId || saleAUserId;
    const modelVer = overrides.modelVersion === null ? 'NULL' : `'${overrides.modelVersion ?? 'gemini-1.5-pro'}'`;
    const sRefs = overrides.sourceRefs ?? `'[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb`;
    const sal = overrides.salutationRules ?? `'${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}'::jsonb`;
    const sent = overrides.sentenceStyle ?? `'${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}'::jsonb`;
    const q = overrides.questionStyle ?? `'${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}'::jsonb`;
    const obj = overrides.objectionStyle ?? `'${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}'::jsonb`;
    const cls = overrides.closingStyle ?? `'${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}'::jsonb`;
    const ex = overrides.examples ?? `'[]'::jsonb`;

    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status
      ) VALUES (
        '${draftId}', '${compId}', '${saleId}', 'ssp_${randomUUID().replace(/-/g, '')}',
        ${sal}, ${sent}, ${q}, ${obj}, ${cls}, ${ex}, ${sRefs}, ${modelVer}, 'DRAFT'
      );
    `);
    return draftId;
  }

  // 1. DRAFT model_version = NULL -> activation denied
  const draftNullModelVer = insertRawDraft({ modelVersion: null });
  let nullModelVerDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftNullModelVer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    nullModelVerDenied = msg.includes('PROFILE_PROVENANCE_INVALID') || msg.includes('22000');
  }
  assert(nullModelVerDenied, 'Test 14.1: DRAFT model_version = NULL -> activation denied (PROFILE_PROVENANCE_INVALID)');

  // 2. blank model_version -> denied
  const draftBlankModelVer = insertRawDraft({ modelVersion: '   ' });
  let blankModelVerDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftBlankModelVer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    blankModelVerDenied = msg.includes('PROFILE_PROVENANCE_INVALID') || msg.includes('22000');
  }
  assert(blankModelVerDenied, 'Test 14.2: blank model_version -> activation denied (PROFILE_PROVENANCE_INVALID)');

  // 3. source_refs = [] -> denied
  const draftEmptyRefs = insertRawDraft({ sourceRefs: `'[]'::jsonb` });
  let emptyRefsDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftEmptyRefs);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    emptyRefsDenied = msg.includes('PROFILE_PROVENANCE_INVALID') || msg.includes('22000');
  }
  assert(emptyRefsDenied, 'Test 14.3: source_refs = [] -> activation denied (PROFILE_PROVENANCE_INVALID)');

  // 4. duplicate source refs -> denied
  const draftDupRefs = insertRawDraft({
    sourceRefs: `'[{"type": "INTERACTION", "id": "${INT_A_1}"}, {"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb`,
  });
  let dupRefsDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftDupRefs);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    dupRefsDenied = msg.includes('PROFILE_PROVENANCE_INVALID') || msg.includes('22000');
  }
  assert(dupRefsDenied, 'Test 14.4: duplicate source refs -> activation denied (PROFILE_PROVENANCE_INVALID)');

  // 5. source của Sale khác -> denied
  const draftOtherSaleSource = insertRawDraft({
    sourceRefs: `'[{"type": "INTERACTION", "id": "${INT_A_OTHER_SALE}"}]'::jsonb`,
  });
  let otherSaleSourceDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftOtherSaleSource);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    otherSaleSourceDenied = msg.includes('PROFILE_SOURCE_INVALID') || msg.includes('22000');
  }
  assert(otherSaleSourceDenied, 'Test 14.5: source của Sale khác -> activation denied (PROFILE_SOURCE_INVALID)');

  // 6. source inbound/customer -> denied
  const draftInboundSource = insertRawDraft({
    sourceRefs: `'[{"type": "INTERACTION", "id": "${INT_A_INBOUND}"}]'::jsonb`,
  });
  let inboundSourceDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftInboundSource);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    inboundSourceDenied = msg.includes('PROFILE_SOURCE_INVALID') || msg.includes('22000');
  }
  assert(inboundSourceDenied, 'Test 14.6: source inbound/customer -> activation denied (PROFILE_SOURCE_INVALID)');

  // 7. style chứa "giảm 10%" -> denied
  const draftDiscountStyle = insertRawDraft({
    closingStyle: `'{"commonClosings": ["Dạ em giảm 10% cho anh chị ngay hôm nay"], "callToActionPatterns": [], "urgencyStyle": "", "notes": []}'::jsonb`,
  });
  let discountStyleDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftDiscountStyle);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    discountStyleDenied = msg.includes('PROFILE_STYLE_POLICY_UNSAFE') || msg.includes('22000');
  }
  assert(discountStyleDenied, 'Test 14.7: style chứa "giảm 10%" -> activation denied (PROFILE_STYLE_POLICY_UNSAFE)');

  // 8. style chứa "cọc 5 triệu" -> denied
  const draftDepositStyle = insertRawDraft({
    objectionStyle: `'{"approaches": [{"situation": "giá cao", "responseApproach": "khách chỉ cần cọc 5 triệu là làm"}], "notes": []}'::jsonb`,
  });
  let depositStyleDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftDepositStyle);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    depositStyleDenied = msg.includes('PROFILE_STYLE_POLICY_UNSAFE') || msg.includes('22000');
  }
  assert(depositStyleDenied, 'Test 14.8: style chứa "cọc 5 triệu" -> activation denied (PROFILE_STYLE_POLICY_UNSAFE)');

  // 9. legacy examples chứa content -> denied
  const draftLegacyContentEx = insertRawDraft({
    examples: `'[{"interaction_id": "${INT_A_1}", "channel": "FACEBOOK", "created_at": "${new Date().toISOString()}", "content": "Tin nhắn mẫu làm rò rỉ nội dung"}]'::jsonb`,
  });
  let legacyContentExDenied = false;
  try {
    await activateSalesStyleProfile(bossAClient, draftLegacyContentEx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    legacyContentExDenied = msg.includes('PROFILE_EXAMPLES_UNSAFE') || msg.includes('22000');
  }
  assert(legacyContentExDenied, 'Test 14.9: legacy examples chứa content -> activation denied (PROFILE_EXAMPLES_UNSAFE)');

  // 10. canonical M9.4A DRAFT vẫn activate thành công
  const canonicalDraft = await helperCreateDraft(COMPANY_A_ID, saleAUserId, INT_A_1);
  const activatedCanonical = await activateSalesStyleProfile(bossAClient, canonicalDraft.id);
  assert(
    activatedCanonical.generationStatus === 'ACTIVE',
    'Test 14.10: canonical M9.4A DRAFT vẫn activate thành công với generationStatus = ACTIVE'
  );
  assert(
    activatedCanonical.activatedAt !== null,
    'Test 14.10: canonical activated profile has activatedAt timestamp'
  );
  assert(
    activatedCanonical.activatedByUserId === bossAUserId,
    'Test 14.10: canonical activated profile has activatedByUserId = Boss A'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 15: DB Lineage Integrity Constraints (Section 3)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 15: DB Lineage Integrity Constraints ---');

  // Test 15.1: self supersede -> reject
  const selfSupersedeProfId = randomUUID();
  let selfSupersedeRejected = false;
  try {
    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status,
        activated_at, activated_by_user_id, superseded_at, superseded_by_profile_id
      ) VALUES (
        '${selfSupersedeProfId}', '${COMPANY_A_ID}', '${saleAUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
        '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb,
        'gemini-1.5-pro', 'SUPERSEDED',
        now(), '${bossAUserId}', now(), '${selfSupersedeProfId}'
      );
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    selfSupersedeRejected =
      msg.includes('chk_sales_style_profiles_no_self_supersede') || msg.includes('23514');
  }
  assert(selfSupersedeRejected, 'Test 15.1: self supersede -> rejected by chk_sales_style_profiles_no_self_supersede');

  // Test 15.2: Sale A -> Sale B supersede ref -> reject (cross-sale within same company)
  // Create profile for another Sale in Company A (inactiveSaleAUserId)
  const otherSaleInCompAProfId = randomUUID();
  executeRawSql(`
    INSERT INTO public.sales_style_profiles (
      id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
      objection_style, closing_style, examples, source_refs, model_version, generation_status
    ) VALUES (
      '${otherSaleInCompAProfId}', '${COMPANY_A_ID}', '${inactiveSaleAUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
      '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_OTHER_SALE}"}]'::jsonb,
      'gemini-1.5-pro', 'DRAFT'
    );
  `);

  // Attempt Sale A profile to reference another Sale's profile in Company A
  const crossSaleProfId = randomUUID();
  let crossSaleSupersedeRejected = false;
  try {
    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status,
        activated_at, activated_by_user_id, superseded_at, superseded_by_profile_id
      ) VALUES (
        '${crossSaleProfId}', '${COMPANY_A_ID}', '${saleAUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
        '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb,
        'gemini-1.5-pro', 'SUPERSEDED',
        now(), '${bossAUserId}', now(), '${otherSaleInCompAProfId}'
      );
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    crossSaleSupersedeRejected =
      msg.includes('fk_sales_style_profiles_superseded_by_lineage') || msg.includes('23503');
  }
  assert(crossSaleSupersedeRejected, 'Test 15.2: Sale A -> Sale B supersede ref -> rejected by composite FK');

  // Test 15.3: Company A -> Company B supersede ref -> reject (cross-company)
  // Create profile for Sale B in Company B
  const compBProfId = randomUUID();
  executeRawSql(`
    INSERT INTO public.sales_style_profiles (
      id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
      objection_style, closing_style, examples, source_refs, model_version, generation_status
    ) VALUES (
      '${compBProfId}', '${COMPANY_B_ID}', '${saleBUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
      '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
      '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_B_1}"}]'::jsonb,
      'gemini-1.5-pro', 'DRAFT'
    );
  `);

  // Attempt Sale A in Company A profile to reference profile in Company B
  const crossCompProfId = randomUUID();
  let crossCompSupersedeRejected = false;
  try {
    executeRawSql(`
      INSERT INTO public.sales_style_profiles (
        id, company_id, sale_user_id, version, salutation_rules, sentence_style, question_style,
        objection_style, closing_style, examples, source_refs, model_version, generation_status,
        activated_at, activated_by_user_id, superseded_at, superseded_by_profile_id
      ) VALUES (
        '${crossCompProfId}', '${COMPANY_A_ID}', '${saleAUserId}', 'ssp_${randomUUID().replace(/-/g, '')}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.salutationRules)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.sentenceStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.questionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.objectionStyle)}',
        '${JSON.stringify(SAMPLE_STYLE_OUTPUT.closingStyle)}',
        '[]'::jsonb, '[{"type": "INTERACTION", "id": "${INT_A_1}"}]'::jsonb,
        'gemini-1.5-pro', 'SUPERSEDED',
        now(), '${bossAUserId}', now(), '${compBProfId}'
      );
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    crossCompSupersedeRejected =
      msg.includes('fk_sales_style_profiles_superseded_by_lineage') || msg.includes('23503');
  }
  assert(crossCompSupersedeRejected, 'Test 15.3: Company A -> Company B supersede ref -> rejected by composite FK');

  console.log('\n==================================================');
  console.log(`ACTIVATION TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================\n');
}

runTests().catch((err: unknown) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
