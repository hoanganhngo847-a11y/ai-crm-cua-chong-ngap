import 'server-only';

import assert from 'assert';
import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildRuntimeSalesStyleContext,
  BUSINESS_POLICY_FIREWALL_WARNING,
  NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS,
} from '../../features/sales-style/services/runtime-style-context';
import {
  persistSalesStyleProfile,
} from '../../features/sales-style/services/sales-style-store';
import { activateSalesStyleProfile } from '../../features/sales-style/services/sales-style-activation';
import { elevateClientToAal2 } from '../e2e/test-mfa-helpers';
import type { SalesStyleOutput } from '../../shared/contracts/sales-style';

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

const COMPANY_A_ID = 'f0000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = 'f0000000-0000-0000-0000-000000000002';
const CUSTOMER_A_ID = 'f1000000-0000-0000-0000-000000000001';
const CONVO_A_ID = 'f2000000-0000-0000-0000-000000000001';
const INT_A_1 = 'f3000000-0000-0000-0000-000000000001';
const INT_A_2 = 'f3000000-0000-0000-0000-000000000002';

const USER_BOSS = { email: 'runtime_style_boss@trusted.local', password: 'Password123!', fullName: 'Boss Runtime Style' };
const USER_SALE = { email: 'runtime_style_sale@trusted.local', password: 'Password123!', fullName: 'Sale Runtime Style' };
const USER_SALE_OTHER = { email: 'runtime_style_other_sale@trusted.local', password: 'Password123!', fullName: 'Other Sale No Style' };

let bossUserId: string;
let saleUserId: string;
let saleOtherUserId: string;
let bossClient: SupabaseClient;

let passCount = 0;
function logPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function ensureUser(
  config: { email: string; password: string; fullName: string },
  companyId: string,
  role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN'
): Promise<string> {
  const { data: list } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
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

  return userId;
}

const VALID_STYLE_OUTPUT: SalesStyleOutput = {
  salutationRules: {
    selfReferences: ['em', 'mình'],
    customerReferences: ['anh', 'chị'],
    commonOpenings: ['Dạ em chào anh/chị ạ'],
    notes: ['Luôn chào hỏi xưng em lễ phép'],
  },
  sentenceStyle: {
    preferredLength: 'MEDIUM',
    emojiUsage: 'LOW',
    toneDescriptors: ['Chuyên nghiệp', 'Tận tâm'],
    punctuationPatterns: ['Chấm câu rõ ràng'],
    notes: ['Câu từ gãy gọn, rõ ràng'],
  },
  questionStyle: {
    commonPatterns: ['Nhà mình rộng bao nhiêu mét ạ?'],
    discoveryApproach: ['Hỏi thăm tình trạng ngập nước tại khu vực của khách'],
    followUpApproach: ['Hỏi về chiều rộng và chiều cao cửa cần lắp'],
    notes: ['Không hỏi dồn dập'],
  },
  objectionStyle: {
    approaches: [
      {
        situation: 'Khách lo lắng về độ bền của bạt và gioăng',
        responseApproach: 'Giải thích cơ chế gioăng cao su chịu lực và khung inox 304',
      },
    ],
    notes: ['Tập trung vào giải pháp kỹ thuật'],
  },
  closingStyle: {
    commonClosings: ['Dạ em cảm ơn anh/chị nhiều ạ'],
    callToActionPatterns: ['Em hẹn kỹ thuật qua đo đạc khảo sát thực tế giúp mình nhé ạ'],
    urgencyStyle: ['Mùa mưa sắp tới nên việc lắp sớm sẽ giúp gia đình yên tâm hơn ạ'],
    notes: ['Hỗ trợ chu đáo'],
  },
};

async function setup() {
  console.log('--- Setting up Runtime Sales Style Context Fixtures ---');

  // Upsert companies
  await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'Runtime Style Test Co A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'Runtime Style Test Co B', status: 'ACTIVE' },
  ]);

  // Clean company_members for our test companies first to allow clean rerun
  executeRawSql(`
    DELETE FROM public.company_members WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
  `);

  // Ensure users (Each company has at most 1 active SALE)
  bossUserId = await ensureUser(USER_BOSS, COMPANY_A_ID, 'BOSS_ADMIN');
  saleUserId = await ensureUser(USER_SALE, COMPANY_A_ID, 'SALE');
  saleOtherUserId = await ensureUser(USER_SALE_OTHER, COMPANY_B_ID, 'SALE');

  // Clean prior data
  executeRawSql(`
    DELETE FROM public.response_sla_windows WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM public.sales_style_profiles WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM public.interactions WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
  `);

  // Setup customer & conversation
  const { error: custErr } = await adminClient.from('customers').upsert({
    id: CUSTOMER_A_ID,
    company_id: COMPANY_A_ID,
    name: 'Khách Thử Nghiệm Context',
    source: 'FACEBOOK',
    stage: 'LEAD_NEW',
  });
  if (custErr) throw new Error(`Customer upsert failed: ${custErr.message}`);

  const { error: convoErr } = await adminClient.from('conversations').upsert({
    id: CONVO_A_ID,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    channel: 'FACEBOOK',
    external_conversation_id: '123456789:987654321',
    status: 'OPEN',
  });
  if (convoErr) throw new Error(`Conversation upsert failed: ${convoErr.message}`);

  // Setup interactions for Sale A to form source refs
  const { error: intErr } = await adminClient.from('interactions').upsert([
    {
      id: INT_A_1,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      direction: 'OUTBOUND',
      type: 'MESSAGE',
      actor_type: 'SALE',
      actor_user_id: saleUserId,
      sanitized_content: 'Dạ em chào anh/chị, em là nhân viên tư vấn cửa chống ngập ạ.',
      sanitization_status: 'SUCCEEDED',
      created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: INT_A_2,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_A_ID,
      channel: 'FACEBOOK',
      direction: 'OUTBOUND',
      type: 'MESSAGE',
      actor_type: 'SALE',
      actor_user_id: saleUserId,
      sanitized_content: 'Dạ mình cho em xin kích thước chiều rộng cửa để bên em tư vấn ạ.',
      sanitization_status: 'SUCCEEDED',
      created_at: new Date(Date.now() - 1800000).toISOString(),
    },
  ]);
  if (intErr) {
    throw new Error(`Failed to insert interactions: ${intErr.message}`);
  }

  // Log in bossClient and elevate to AAL2
  bossClient = createAnonClient();
  const { error: signInErr } = await bossClient.auth.signInWithPassword({
    email: USER_BOSS.email,
    password: USER_BOSS.password,
  });
  if (signInErr) {
    throw new Error(`Failed to sign in boss: ${signInErr.message}`);
  }
  await elevateClientToAal2(bossClient, bossUserId);
}

async function runTests() {
  await setup();
  console.log('--- Running Runtime Sales Style Context Tests ---');

  // Test 1: Unassigned / missing saleUserId returns safe neutral default
  {
    const resUndef = await buildRuntimeSalesStyleContext({ companyId: COMPANY_A_ID, saleUserId: undefined, client: adminClient });
    assert.strictEqual(resUndef.isNeutralDefault, true, 'Undefined saleUserId must return neutral default');
    assert.strictEqual(resUndef.activeProfileId, null, 'Active profile ID must be null');
    assert.strictEqual(resUndef.appliedStyle, null, 'Applied style must be null');
    assert.ok(resUndef.styleContextPrompt.includes(NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS), 'Must contain neutral instructions');
    assert.ok(resUndef.styleContextPrompt.includes(BUSINESS_POLICY_FIREWALL_WARNING), 'Must contain policy firewall warning');

    const resNull = await buildRuntimeSalesStyleContext({ companyId: COMPANY_A_ID, saleUserId: null, client: adminClient });
    assert.strictEqual(resNull.isNeutralDefault, true, 'Null saleUserId must return neutral default');

    const resEmpty = await buildRuntimeSalesStyleContext({ companyId: COMPANY_A_ID, saleUserId: '   ', client: adminClient });
    assert.strictEqual(resEmpty.isNeutralDefault, true, 'Whitespace saleUserId must return neutral default');

    logPass('Test 1: Unassigned/missing/whitespace saleUserId safely returns neutral default with policy firewall');
  }

  // Test 2: Assigned saleUserId with NO profile at all returns safe neutral default (zero guessing)
  {
    const resNoProfile = await buildRuntimeSalesStyleContext({
      companyId: COMPANY_B_ID,
      saleUserId: saleOtherUserId,
      client: adminClient,
    });
    assert.strictEqual(resNoProfile.isNeutralDefault, true, 'Sale with no profile must return neutral default');
    assert.strictEqual(resNoProfile.activeProfileId, null, 'Active profile ID must be null');
    assert.strictEqual(resNoProfile.appliedStyle, null, 'Applied style must be null');
    assert.ok(resNoProfile.styleContextPrompt.includes(NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS));
    assert.ok(resNoProfile.styleContextPrompt.includes(BUSINESS_POLICY_FIREWALL_WARNING));

    logPass('Test 2: Assigned saleUserId with no profile returns safe neutral default (zero guessing)');
  }

  // Test 3: Assigned saleUserId with only DRAFT profile (not yet activated) returns safe neutral default
  let draftProfileId: string;
  {
    const draftProfile = await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleUserId,
      sourceRefs: [
        { type: 'INTERACTION', id: INT_A_1 },
        { type: 'INTERACTION', id: INT_A_2 },
      ],
      styleOutput: VALID_STYLE_OUTPUT,
      modelVersion: 'gpt-4o-mini-2024-07-18',
    });
    draftProfileId = draftProfile.id;
    assert.strictEqual(draftProfile.generationStatus, 'DRAFT', 'Profile must initially be DRAFT');

    const resDraft = await buildRuntimeSalesStyleContext({
      companyId: COMPANY_A_ID,
      saleUserId: saleUserId,
      client: adminClient,
    });
    assert.strictEqual(resDraft.isNeutralDefault, true, 'DRAFT profile must not be applied to AI runtime');
    assert.strictEqual(resDraft.activeProfileId, null);
    assert.strictEqual(resDraft.appliedStyle, null);

    logPass('Test 3: Sale with only DRAFT profile returns safe neutral default');
  }

  // Test 4: Assigned saleUserId with ACTIVE profile returns personalized style prompt
  {
    // Activate profile as Boss with AAL2
    await activateSalesStyleProfile(bossClient, draftProfileId);

    const resActive = await buildRuntimeSalesStyleContext({
      companyId: COMPANY_A_ID,
      saleUserId: saleUserId,
      client: adminClient,
    });

    assert.strictEqual(resActive.isNeutralDefault, false, 'Active profile must return personalized context');
    assert.strictEqual(resActive.activeProfileId, draftProfileId, 'Active profile ID must match');
    assert.ok(resActive.appliedStyle !== null, 'Applied style must be present');
    assert.strictEqual(resActive.appliedStyle.saleUserId, saleUserId);

    // Verify prompt sections
    assert.ok(resActive.styleContextPrompt.includes('[ACTIVE PERSONALIZED SALES STYLE'), 'Header matches');
    assert.ok(resActive.styleContextPrompt.includes(`(v${resActive.appliedStyle!.version})`), 'Version matches');
    assert.ok(resActive.styleContextPrompt.includes('=== QUY TẮC XƯNG HÔ (SALUTATION) ==='), 'Salutation section exists');
    assert.ok(resActive.styleContextPrompt.includes('=== PHONG CÁCH CÂU TỪ (SENTENCE STYLE) ==='), 'Sentence section exists');
    assert.ok(resActive.styleContextPrompt.includes('=== PHONG CÁCH ĐẶT CÂU HỎI (QUESTION STYLE) ==='), 'Question section exists');
    assert.ok(resActive.styleContextPrompt.includes('=== PHƯƠNG PHÁP XỬ LÝ TỪ CHỐI / THẮC MẮC (OBJECTION HANDLING) ==='), 'Objection section exists');
    assert.ok(resActive.styleContextPrompt.includes('=== PHONG CÁCH CHỐT VÀ LỜI KẾT (CLOSING STYLE) ==='), 'Closing section exists');
    assert.ok(resActive.styleContextPrompt.includes(BUSINESS_POLICY_FIREWALL_WARNING), 'Policy firewall must be appended');

    // Specific content checks
    assert.ok(resActive.styleContextPrompt.includes('Dạ em chào anh/chị ạ'));
    assert.ok(resActive.styleContextPrompt.includes('Chuyên nghiệp, Tận tâm'));
    assert.ok(resActive.styleContextPrompt.includes('khung inox 304'));

    logPass('Test 4: Assigned saleUserId with ACTIVE profile returns personalized prompt context');
  }

  // Test 5: Multi-tenant isolation - Company B querying Sale A gets neutral default
  {
    const resCompanyB = await buildRuntimeSalesStyleContext({
      companyId: COMPANY_B_ID,
      saleUserId: saleUserId,
      client: adminClient,
    });
    assert.strictEqual(resCompanyB.isNeutralDefault, true, 'Cross-company lookup must return neutral default');
    assert.strictEqual(resCompanyB.activeProfileId, null);
    assert.strictEqual(resCompanyB.appliedStyle, null);

    logPass('Test 5: Multi-tenant boundary holds (Company B querying Sale A gets neutral default)');
  }

  // Test 6: Policy violation defense-in-depth: corrupted active profile fails closed to neutral default
  {
    // Corrupt active profile directly in database to include forbidden commercial terms ("giảm giá 20%")
    executeRawSql(`
      UPDATE public.sales_style_profiles
      SET salutation_rules = jsonb_set(salutation_rules, '{greetings}', '["Dạ em chào anh/chị, bên em đang giảm giá 20% hôm nay ạ"]'::jsonb)
      WHERE id = '${draftProfileId}';
    `);

    const resCorrupted = await buildRuntimeSalesStyleContext({
      companyId: COMPANY_A_ID,
      saleUserId: saleUserId,
      client: adminClient,
    });

    assert.strictEqual(resCorrupted.isNeutralDefault, true, 'Policy violating profile must fail closed to neutral default');
    assert.strictEqual(resCorrupted.activeProfileId, null, 'Active profile ID must be null on policy failure');
    assert.strictEqual(resCorrupted.appliedStyle, null, 'Applied style must be null on policy failure');
    assert.ok(resCorrupted.styleContextPrompt.includes(NEUTRAL_DEFAULT_STYLE_INSTRUCTIONS), 'Must fallback to neutral default');

    logPass('Test 6: Policy violation in active profile triggers fail-closed fallback to neutral default');
  }

  console.log(`\nAll ${passCount} tests in runtime-style-context.test.ts PASSED!`);
}

runTests().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
