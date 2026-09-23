import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  openResponseSlaWindow,
  resolveResponseSlaOnSaleReply,
  claimResponseSlaForAi,
} from '../../features/automation/response-sla/services/response-sla-store';
import type { ResponseSlaClaimResult } from '../../shared/contracts/response-sla';
import {
  fetchAiAnalysisInput,
} from '../../features/ai-analysis/services/ai-analysis-store';
import {
  validateAiAnalysisOutput,
} from '../../features/ai-analysis/services/validate-ai-analysis';
import {
  runCustomerAnalysisPipeline,
  FakeDeterministicAiModel,
} from '../../features/ai-analysis/services/ai-analysis-engine';
import {
  fetchSalesStyleLearningInput,
  persistSalesStyleProfile,
  fetchActiveSalesStyleProfile,
} from '../../features/sales-style/services/sales-style-store';
import { activateSalesStyleProfile } from '../../features/sales-style/services/sales-style-activation';
import {
  validateSalesStyleOutput,
} from '../../features/sales-style/services/validate-sales-style';
import {
  fetchCompanyAnalyticsOverview,
} from '../../features/analytics/services/analytics-store';
import {
  formatBasisPoints,
  formatMoneyVnd,
  formatSeconds,
} from '../../features/analytics/utils/date-range';
import type { SalesStyleOutput } from '../../shared/contracts/sales-style';

// Supabase Local Configuration
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

// Dedicated Deterministic UUID Fixtures for M9.6A E2E Integration Gate
const COMPANY_A_ID = 'e0000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = 'e0000000-0000-0000-0000-000000000002';

const CUSTOMER_A_ID = 'e1000000-0000-0000-0000-000000000001';
const CUSTOMER_B_ID = 'e1000000-0000-0000-0000-000000000002';

const CONVO_SLA_SCENARIO_A = 'e2000000-0000-0000-0000-000000000001';
const CONVO_SLA_SCENARIO_B = 'e2000000-0000-0000-0000-000000000002';
const CONVO_SLA_SCENARIO_C = 'e2000000-0000-0000-0000-000000000003';
const CONVO_SLA_SCENARIO_D = 'e2000000-0000-0000-0000-000000000004';
const CONVO_AI_ANALYSIS_A  = 'e2000000-0000-0000-0000-000000000005';
const CONVO_STYLE_LEARN_A  = 'e2000000-0000-0000-0000-000000000006';
const CONVO_ANALYTICS_A    = 'e2000000-0000-0000-0000-000000000007';

const INT_SLA_A_TRIGGER_1   = 'e3000000-0000-0000-0000-000000000001';
const INT_SLA_A_TRIGGER_2   = 'e3000000-0000-0000-0000-000000000002';
const INT_SLA_B_TRIGGER     = 'e3000000-0000-0000-0000-000000000003';
const INT_SLA_B_SALE_REPLY  = 'e3000000-0000-0000-0000-000000000004';
const INT_SLA_C_TRIGGER     = 'e3000000-0000-0000-0000-000000000005';
const INT_SLA_D_TRIGGER     = 'e3000000-0000-0000-0000-000000000006';
const INT_SLA_D_SALE_REPLY  = 'e3000000-0000-0000-0000-000000000007';

// Users
const USER_BOSS_A = { email: 'e2e_boss_a@integration.local', password: 'Password123!', fullName: 'E2E Sếp Công ty A' };
const USER_SALE_A = { email: 'e2e_sale_a@integration.local', password: 'Password123!', fullName: 'E2E Sale Công ty A' };
const USER_TECH_A = { email: 'e2e_tech_a@integration.local', password: 'Password123!', fullName: 'E2E Tech Công ty A' };
const USER_BOSS_B = { email: 'e2e_boss_b@integration.local', password: 'Password123!', fullName: 'E2E Sếp Công ty B' };

let bossAUserId: string;
let saleAUserId: string;
let techAUserId: string;
let bossBUserId: string;

let bossAClient: SupabaseClient;
let saleAClient: SupabaseClient;
let techAClient: SupabaseClient;
let bossBClient: SupabaseClient;

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

async function ensureTestUser(
  config: { email: string; password: string; fullName: string },
  companyId: string,
  role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN'
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
      throw new Error(`Failed to create user ${config.email}: ${error?.message}`);
    }
    userId = data.user.id;
  }

  await adminClient.from('user_profiles').upsert({
    id: userId,
    full_name: config.fullName,
    status: 'ACTIVE',
  });

  await adminClient.from('company_members').upsert(
    {
      company_id: companyId,
      user_id: userId,
      role,
      status: 'ACTIVE',
    },
    { onConflict: 'company_id,user_id' }
  );

  return userId;
}

async function loginUser(config: { email: string; password: string }): Promise<SupabaseClient> {
  const client = createAnonClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: config.email,
    password: config.password,
  });
  if (error || !data.session) {
    throw new Error(`Failed to sign in as ${config.email}: ${error?.message}`);
  }
  return client;
}

async function setupFixtures() {
  console.log('--- Setting up M9.6A Current-System Integration Fixtures ---');

  // Clean prior test runs for these dedicated tenant UUIDs
  executeRawSql(`
    DELETE FROM public.finance_summaries WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM public.orders WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    ALTER TABLE public.price_calculations DISABLE TRIGGER trg_price_calculations_immutability;
    DELETE FROM public.price_calculations WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    ALTER TABLE public.price_calculations ENABLE TRIGGER trg_price_calculations_immutability;
    DELETE FROM public.pricing_policies WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM public.response_sla_windows WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM public.interactions WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM public.sales_style_profiles WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM public.ai_analyses WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
  `);

  // 1. Companies
  const { error: compErr } = await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'E2E Test Company A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'E2E Test Company B', status: 'ACTIVE' },
  ]);
  if (compErr) throw new Error(`Companies upsert failed: ${compErr.message}`);

  // 2. Users
  bossAUserId = await ensureTestUser(USER_BOSS_A, COMPANY_A_ID, 'BOSS_ADMIN');
  saleAUserId = await ensureTestUser(USER_SALE_A, COMPANY_A_ID, 'SALE');
  techAUserId = await ensureTestUser(USER_TECH_A, COMPANY_A_ID, 'TECHNICIAN');
  bossBUserId = await ensureTestUser(USER_BOSS_B, COMPANY_B_ID, 'BOSS_ADMIN');

  bossAClient = await loginUser(USER_BOSS_A);
  saleAClient = await loginUser(USER_SALE_A);
  techAClient = await loginUser(USER_TECH_A);
  bossBClient = await loginUser(USER_BOSS_B);
  void techAUserId;
  void bossBUserId;

  // 3. Customers
  const { error: custErr } = await adminClient.from('customers').upsert([
    {
      id: CUSTOMER_A_ID,
      company_id: COMPANY_A_ID,
      customer_code: 'KH-E2E-A',
      name: 'Khách Hàng E2E A',
      source: 'FACEBOOK',
      stage: 'LEAD_NEW',
    },
    {
      id: CUSTOMER_B_ID,
      company_id: COMPANY_B_ID,
      customer_code: 'KH-E2E-B',
      name: 'Khách Hàng E2E B',
      source: 'ZALO',
      stage: 'LEAD_NEW',
    },
  ]);
  if (custErr) throw new Error(`Customers upsert failed: ${custErr.message}`);

  // 4. Conversations
  const { error: convoErr } = await adminClient.from('conversations').upsert([
    {
      id: CONVO_SLA_SCENARIO_A,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'fb_convo_a',
      status: 'OPEN',
    },
    {
      id: CONVO_SLA_SCENARIO_B,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'fb_convo_b',
      status: 'OPEN',
    },
    {
      id: CONVO_SLA_SCENARIO_C,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'fb_convo_c',
      status: 'OPEN',
    },
    {
      id: CONVO_SLA_SCENARIO_D,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'FACEBOOK',
      external_conversation_id: 'fb_convo_d',
      status: 'OPEN',
    },
    {
      id: CONVO_AI_ANALYSIS_A,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'ZALO',
      external_conversation_id: 'zalo_convo_ai_a',
      status: 'OPEN',
    },
    {
      id: CONVO_STYLE_LEARN_A,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'ZALO',
      external_conversation_id: 'zalo_convo_style_a',
      status: 'OPEN',
    },
    {
      id: CONVO_ANALYTICS_A,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      channel: 'ZALO',
      external_conversation_id: 'zalo_convo_analytics_a',
      status: 'OPEN',
    },
  ]);
  if (convoErr) throw new Error(`Conversations upsert failed: ${convoErr.message}`);

  console.log('✓ Setup complete.');
}

async function runAllScenarios() {
  console.log('================================================================');
  console.log('RUNNING M9.6A CROSS-MODULE INTEGRATION GATE SCENARIOS (A – P)');
  console.log('================================================================');

  // ============================================================================
  // SCENARIO A: Inbound Customer Message -> Response SLA Window
  // ============================================================================
  console.log('\n--- Scenario A: Inbound Customer Message -> Response SLA ---');
  {
    const startedAt = new Date();
    await adminClient.from('interactions').upsert({
      id: INT_SLA_A_TRIGGER_1,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_SLA_SCENARIO_A,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Chào công ty, cửa chống ngập báo giá thế nào?',
      created_at: startedAt.toISOString(),
    });

    const windowA = await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_SLA_SCENARIO_A,
      triggerInteractionId: INT_SLA_A_TRIGGER_1,
    });

    assert(windowA.state === 'OPEN', 'Scenario A: Window state is OPEN upon inbound message');
    assert(windowA.companyId === COMPANY_A_ID, 'Scenario A: Window bound to Company A');
    assert(windowA.conversationId === CONVO_SLA_SCENARIO_A, 'Scenario A: Window bound to Conversation A');
    assert(windowA.triggerInteractionId === INT_SLA_A_TRIGGER_1, 'Scenario A: Trigger interaction recorded');

    // Deadline check: exactly +300 seconds (5 minutes)
    const startedMs = new Date(windowA.startedAt).getTime();
    const deadlineMs = new Date(windowA.deadlineAt).getTime();
    assert(deadlineMs - startedMs === 300_000, 'Scenario A: Deadline is exactly +300 seconds (5 minutes)');

    // Additional customer message before deadline: does NOT reset deadline
    await adminClient.from('interactions').upsert({
      id: INT_SLA_A_TRIGGER_2,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_SLA_SCENARIO_A,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Alo shop ơi có đó không?',
      created_at: new Date(startedMs + 60_000).toISOString(),
    });

    const windowA2 = await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_SLA_SCENARIO_A,
      triggerInteractionId: INT_SLA_A_TRIGGER_2,
    });

    assert(windowA2.id === windowA.id, 'Scenario A: Idempotently returns existing OPEN window');
    assert(windowA2.deadlineAt === windowA.deadlineAt, 'Scenario A: Additional customer message does not reset deadline');
    assert(windowA2.state === 'OPEN', 'Scenario A: Window remains OPEN before deadline');
  }

  // ============================================================================
  // SCENARIO B: Sale wins within 5 minutes -> AI Claim Denied
  // ============================================================================
  console.log('\n--- Scenario B: Sale wins within 5 minutes ---');
  {
    const startedAt = new Date();
    await adminClient.from('interactions').upsert({
      id: INT_SLA_B_TRIGGER,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_SLA_SCENARIO_B,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Tư vấn cho tôi cửa chống ngập gia đình nhé',
      created_at: startedAt.toISOString(),
    });

    const windowB = await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_SLA_SCENARIO_B,
      triggerInteractionId: INT_SLA_B_TRIGGER,
    });
    assert(windowB.state === 'OPEN', 'Scenario B: Window B opened');

    // Sale responds before 5 minutes (at +2 minutes)
    const saleReplyAt = new Date(startedAt.getTime() + 120_000);
    await adminClient.from('interactions').upsert({
      id: INT_SLA_B_SALE_REPLY,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_SLA_SCENARIO_B,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Dạ em chào anh chị! Em xin phép hỗ trợ tư vấn kích thước cửa nhà mình ạ.',
      created_at: saleReplyAt.toISOString(),
    });

    const resolvedWinB = await resolveResponseSlaOnSaleReply({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_SLA_SCENARIO_B,
      saleInteractionId: INT_SLA_B_SALE_REPLY,
    });

    assert(resolvedWinB !== null, 'Scenario B: Window resolution returned updated window');
    assert(resolvedWinB?.state === 'SALE_RESPONDED', 'Scenario B: window.state transitioned to SALE_RESPONDED');
    assert(resolvedWinB?.saleResponseInteractionId === INT_SLA_B_SALE_REPLY, 'Scenario B: sale_response_interaction_id linked');

    // AI claims after Sale reply: must be denied
    const claimAttempt = await claimResponseSlaForAi({
      companyId: COMPANY_A_ID,
      windowId: windowB.id,
    });
    assert(claimAttempt.claimed === false, 'Scenario B: AI claim is denied when Sale already responded');
    assert(claimAttempt.decision === 'SALE_ALREADY_RESPONDED', 'Scenario B: Decision reason is SALE_ALREADY_RESPONDED');

    // Verify conversation is not taken over by AI
    const { data: convoB } = await adminClient
      .from('conversations')
      .select('status')
      .eq('id', CONVO_SLA_SCENARIO_B)
      .single();
    assert(convoB?.status !== 'AI_HANDLING', 'Scenario B: Conversation status is not AI_HANDLING');
  }

  // ============================================================================
  // SCENARIO C: AI eligible after 5 minutes (Real Concurrency Test)
  // ============================================================================
  console.log('\n--- Scenario C: AI eligible after 5 minutes (Concurrent Claimants) ---');
  {
    // Trigger message in the past (10 minutes ago)
    const past10Min = new Date(Date.now() - 10 * 60 * 1000);
    await adminClient.from('interactions').upsert({
      id: INT_SLA_C_TRIGGER,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_SLA_SCENARIO_C,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Có ai trực không ạ? Mình muốn lắp cửa gấp',
      created_at: past10Min.toISOString(),
    });

    const windowC = await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_SLA_SCENARIO_C,
      triggerInteractionId: INT_SLA_C_TRIGGER,
    });
    assert(windowC.state === 'OPEN', 'Scenario C: Window C opened');

    // Real concurrency: two workers simultaneously attempt to claim window
    const [result1, result2] = await Promise.allSettled([
      claimResponseSlaForAi({ companyId: COMPANY_A_ID, windowId: windowC.id }),
      claimResponseSlaForAi({ companyId: COMPANY_A_ID, windowId: windowC.id }),
    ]);

    assert(result1.status === 'fulfilled' && result2.status === 'fulfilled', 'Scenario C: Both concurrent claims completed without unhandled crash');
    const claim1 = (result1 as PromiseFulfilledResult<ResponseSlaClaimResult>).value;
    const claim2 = (result2 as PromiseFulfilledResult<ResponseSlaClaimResult>).value;

    const successCount = (claim1.claimed ? 1 : 0) + (claim2.claimed ? 1 : 0);
    assert(successCount === 1, 'Scenario C: Exactly ONE concurrent AI claimant succeeds');

    const winner = claim1.claimed ? claim1 : claim2;
    const loser = claim1.claimed ? claim2 : claim1;

    assert(winner.decision === 'ALLOW_AI_REPLY', 'Scenario C: Winning claim decision is ALLOW_AI_REPLY');
    assert(Boolean(winner.claimId), 'Scenario C: Winning claim has valid claimId');
    assert(Boolean(winner.claimExpiresAt), 'Scenario C: Winning claim has valid claim lease expires_at');
    assert(loser.decision === 'ALREADY_CLAIMED', 'Scenario C: Losing claimant receives ALREADY_CLAIMED');

    // Audit log verification
    const { data: auditLogs } = await adminClient
      .from('audit_logs')
      .select('*')
      .eq('action', 'RESPONSE_SLA_AI_CLAIM')
      .eq('resource_id', windowC.id)
      .eq('result', 'SUCCESS');

    assert((auditLogs?.length ?? 0) >= 1, 'Scenario C: Audit log created for winning AI claim');
    assert(auditLogs?.[0]?.metadata?.decision === 'CLAIMED', 'Scenario C: Audit metadata records CLAIMED');
  }

  // ============================================================================
  // SCENARIO D: Sale race vs AI (Near-simultaneous Race Invariant)
  // ============================================================================
  console.log('\n--- Scenario D: Sale race vs AI (Sale intervention prevents dual win) ---');
  {
    const past8Min = new Date(Date.now() - 8 * 60 * 1000);
    await adminClient.from('interactions').upsert({
      id: INT_SLA_D_TRIGGER,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_SLA_SCENARIO_D,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Báo giá nhanh cho mình nhé',
      created_at: past8Min.toISOString(),
    });

    const windowD = await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_SLA_SCENARIO_D,
      triggerInteractionId: INT_SLA_D_TRIGGER,
    });
    assert(windowD.state === 'OPEN', 'Scenario D: Window D opened');

    // Sale responds in interactions
    await adminClient.from('interactions').upsert({
      id: INT_SLA_D_SALE_REPLY,
      company_id: COMPANY_A_ID,
      customer_id: CUSTOMER_A_ID,
      conversation_id: CONVO_SLA_SCENARIO_D,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'SALE',
      actor_user_id: saleAUserId,
      sanitization_status: 'SUCCEEDED',
      sanitized_content: 'Chào bạn, bên mình gửi bảng giá cửa chống ngập ngay đây ạ!',
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });

    // Concurrent race: Sale resolves window vs AI attempts claim
    const [raceSale, raceAi] = await Promise.allSettled([
      resolveResponseSlaOnSaleReply({
        companyId: COMPANY_A_ID,
        conversationId: CONVO_SLA_SCENARIO_D,
        saleInteractionId: INT_SLA_D_SALE_REPLY,
      }),
      claimResponseSlaForAi({
        companyId: COMPANY_A_ID,
        windowId: windowD.id,
      }),
    ]);

    assert(raceSale.status === 'fulfilled', 'Scenario D: Sale resolution fulfilled');
    assert(raceAi.status === 'fulfilled', 'Scenario D: AI claim attempt fulfilled');

    const aiClaimResult = (raceAi as PromiseFulfilledResult<ResponseSlaClaimResult>).value;
    assert(aiClaimResult.claimed === false, 'Scenario D: AI claim is denied due to Sale intervention');
    assert(
      aiClaimResult.decision === 'SALE_ALREADY_RESPONDED' || aiClaimResult.decision === 'WINDOW_ALREADY_RESOLVED',
      'Scenario D: AI decision strictly reflects Sale response intervention'
    );

    // Verify DB state: Window is SALE_RESPONDED, never AI_RESPONDED
    const { data: finalWinD } = await bossAClient
      .from('response_sla_windows')
      .select('state, sale_response_interaction_id, ai_response_interaction_id')
      .eq('id', windowD.id)
      .single();

    assert(finalWinD?.state === 'SALE_RESPONDED', 'Scenario D: Final window state is strictly SALE_RESPONDED');
    assert(finalWinD?.sale_response_interaction_id === INT_SLA_D_SALE_REPLY, 'Scenario D: sale_response_interaction_id is recorded');
    assert(finalWinD?.ai_response_interaction_id === null, 'Scenario D: ai_response_interaction_id is NULL (no dual-win)');
  }

  // ============================================================================
  // SCENARIO E: AI Analysis Sanitized-Only Ingestion & Safe Persistence
  // ============================================================================
  console.log('\n--- Scenario E: AI Analysis Sanitized-Only Ingestion & Immutability ---');
  {
    const intSucceeded = 'e3000000-0000-0000-0000-000000000010';
    const intPending = 'e3000000-0000-0000-0000-000000000011';
    const intFailed = 'e3000000-0000-0000-0000-000000000012';
    const intNote = 'e3000000-0000-0000-0000-000000000013';

    const { error: intErr } = await adminClient.from('interactions').upsert([
      {
        id: intSucceeded,
        company_id: COMPANY_A_ID,
        customer_id: CUSTOMER_A_ID,
        conversation_id: CONVO_AI_ANALYSIS_A,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Nhà tôi ở phố Nguyễn Trãi, cửa rộng 3.2m, mùa mưa nước ngập 50cm.',
        created_at: new Date(Date.now() - 200_000).toISOString(),
      },
      {
        id: intPending,
        company_id: COMPANY_A_ID,
        customer_id: CUSTOMER_A_ID,
        conversation_id: CONVO_AI_ANALYSIS_A,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'PENDING',
        sanitized_content: null,
        created_at: new Date(Date.now() - 150_000).toISOString(),
      },
      {
        id: intFailed,
        company_id: COMPANY_A_ID,
        customer_id: CUSTOMER_A_ID,
        conversation_id: CONVO_AI_ANALYSIS_A,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'FAILED',
        sanitized_content: null,
        created_at: new Date(Date.now() - 100_000).toISOString(),
      },
      {
        id: intNote,
        company_id: COMPANY_A_ID,
        customer_id: CUSTOMER_A_ID,
        conversation_id: CONVO_AI_ANALYSIS_A,
        channel: 'ZALO',
        type: 'NOTE',
        direction: 'OUTBOUND',
        actor_type: 'SALE',
        actor_user_id: saleAUserId,
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Khách có vẻ thiện chí, cần ưu tiên báo giá sớm.',
        created_at: new Date(Date.now() - 50_000).toISOString(),
      },
    ]);
    if (intErr) throw new Error(`Interactions upsert failed: ${intErr.message}`);

    // Fetch AI Analysis input
    const analysisInput = await fetchAiAnalysisInput(adminClient, {
      companyId: COMPANY_A_ID,
      customerId: CUSTOMER_A_ID,
    });

    assert(analysisInput.sources.length >= 1, 'Scenario E: Fetched analysis interactions');
    const includedIds = analysisInput.sources.map((i) => i.interactionId);
    assert(includedIds.includes(intSucceeded), 'Scenario E: SUCCEEDED MESSAGE is included in AI input');
    assert(!includedIds.includes(intPending), 'Scenario E: PENDING interaction is excluded');
    assert(!includedIds.includes(intFailed), 'Scenario E: FAILED interaction is excluded');
    assert(!includedIds.includes(intNote), 'Scenario E: NOTE interaction is excluded');

    // Run pipeline with FakeDeterministicAiModel
    const fakeModel = new FakeDeterministicAiModel('trusted-ai-model-v1', {
      summary: 'Khách hàng cần lắp đặt cửa chống ngập 3.2m do ngập 50cm mùa mưa.',
      confidence: 0.85,
      stageSuggestion: 'SURVEY_SCHEDULED',
      objections: ['Độ bền sản phẩm', 'Tiến độ thi công'],
      stopReason: null,
      nextAction: 'Liên hệ hẹn lịch khảo sát thực địa',
      evidence: 'Khách cung cấp kích thước 3.2m và mức ngập 50cm.',
    });

    const pipelineResult = await runCustomerAnalysisPipeline({
      client: adminClient,
      companyId: COMPANY_A_ID,
      customerId: CUSTOMER_A_ID,
      model: fakeModel,
    });

    assert(pipelineResult !== null, 'Scenario E: Pipeline produced analysis record');
    assert(pipelineResult.modelVersion === 'trusted-ai-model-v1', 'Scenario E: Trusted modelVersion persisted');
    assert(pipelineResult.stageSuggestion === 'SURVEY_SCHEDULED', 'Scenario E: Stage suggestion recorded');

    // Verify Customer.stage was NOT mutated by AI analysis (AI cannot mutate stage directly)
    const { data: custAfter } = await adminClient
      .from('customers')
      .select('stage')
      .eq('id', CUSTOMER_A_ID)
      .single();
    assert(custAfter?.stage === 'LEAD_NEW', 'Scenario E: Customer.stage is NOT mutated by AI Analysis (remains LEAD_NEW)');

    // Verify forged modelVersion output is discarded by validator
    const forgedModelOutput = {
      summary: 'Summary text',
      confidence: 0.9,
      stageSuggestion: null,
      objections: [],
      stopReason: null,
      nextAction: null,
      evidence: 'Evidence',
      modelVersion: 'malicious-forged-version',
    };
    const validatedOutput = validateAiAnalysisOutput(forgedModelOutput);
    assert(!('modelVersion' in validatedOutput), 'Scenario E: Forged modelVersion output is ignored by validator');
  }

  // ============================================================================
  // SCENARIO F: AI Analysis Business Isolation
  // ============================================================================
  console.log('\n--- Scenario F: AI Analysis Business Isolation ---');
  {
    // Company A analysis cannot ingest Company B customer
    let crossCompInputFailed = false;
    try {
      await fetchAiAnalysisInput(adminClient, {
        companyId: COMPANY_A_ID,
        customerId: CUSTOMER_B_ID, // Customer B belongs to Company B
      });
    } catch {
      crossCompInputFailed = true;
    }
    assert(crossCompInputFailed, 'Scenario F: Company A cannot fetch AI input for Customer Company B');

    // Technician denied read access to AI Analysis
    const { data: techRead, error: techReadErr } = await techAClient
      .from('ai_analyses')
      .select('*')
      .eq('company_id', COMPANY_A_ID);
    assert(
      Boolean(techReadErr) || (techRead?.length ?? 0) === 0,
      'Scenario F: Technician cannot read ai_analyses table (RLS / ACL denied)'
    );

    // Sale of same company CAN read AI analysis
    const { data: saleRead, error: saleReadErr } = await saleAClient
      .from('ai_analyses')
      .select('*')
      .eq('company_id', COMPANY_A_ID);
    assert(!saleReadErr && (saleRead?.length ?? 0) > 0, 'Scenario F: Sale of same company can read AI analyses');
  }

  // ============================================================================
  // SCENARIO G: Sales Style Learning Provenance & Filtering
  // ============================================================================
  console.log('\n--- Scenario G: Sales Style Learning Provenance ---');
  {
    const intSaleMsg1 = 'e3000000-0000-0000-0000-000000000021';
    const intSaleMsg2 = 'e3000000-0000-0000-0000-000000000022';
    const intCustMsg = 'e3000000-0000-0000-0000-000000000023';
    const intInboundSale = 'e3000000-0000-0000-0000-000000000024';

    const { error: gIntErr } = await adminClient.from('interactions').upsert([
      {
        id: intSaleMsg1,
        company_id: COMPANY_A_ID,
        customer_id: CUSTOMER_A_ID,
        conversation_id: CONVO_STYLE_LEARN_A,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'OUTBOUND',
        actor_type: 'SALE',
        actor_user_id: saleAUserId,
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Chào anh! Dạ em gửi bảng thông số kỹ thuật tấm chắn nước hợp kim nhôm ạ.',
        created_at: new Date(Date.now() - 400_000).toISOString(),
      },
      {
        id: intSaleMsg2,
        company_id: COMPANY_A_ID,
        customer_id: CUSTOMER_A_ID,
        conversation_id: CONVO_STYLE_LEARN_A,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'OUTBOUND',
        actor_type: 'SALE',
        actor_user_id: saleAUserId,
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Dạ bên em hỗ trợ khảo sát tận nơi miễn phí anh nhé.',
        created_at: new Date(Date.now() - 200_000).toISOString(),
      },
      {
        id: intCustMsg,
        company_id: COMPANY_A_ID,
        customer_id: CUSTOMER_A_ID,
        conversation_id: CONVO_STYLE_LEARN_A,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'INBOUND',
        actor_type: 'CUSTOMER',
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Ok em gửi đi anh xem.',
        created_at: new Date(Date.now() - 300_000).toISOString(),
      },
      {
        id: intInboundSale,
        company_id: COMPANY_A_ID,
        customer_id: CUSTOMER_A_ID,
        conversation_id: CONVO_STYLE_LEARN_A,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'INBOUND', // INBOUND sale (invalid for learning)
        actor_type: 'SALE',
        actor_user_id: saleAUserId,
        sanitization_status: 'SUCCEEDED',
        sanitized_content: 'Inbound message không được vào style learning.',
        created_at: new Date(Date.now() - 100_000).toISOString(),
      },
    ]);
    if (gIntErr) throw new Error(`Scenario G interactions upsert failed: ${gIntErr.message}`);

    const styleInput = await fetchSalesStyleLearningInput(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      limit: 10,
    });

    const styleIds = styleInput.sources.map((i) => i.interactionId);
    assert(styleIds.includes(intSaleMsg1), 'Scenario G: Outbound Sale message 1 included');
    assert(styleIds.includes(intSaleMsg2), 'Scenario G: Outbound Sale message 2 included');
    assert(!styleIds.includes(intCustMsg), 'Scenario G: Customer message excluded from style learning');
    assert(!styleIds.includes(intInboundSale), 'Scenario G: Inbound message excluded from style learning');

    // Chronological order verification (oldest to newest)
    const time1 = new Date(styleInput.sources.find((i) => i.interactionId === intSaleMsg1)!.createdAt).getTime();
    const time2 = new Date(styleInput.sources.find((i) => i.interactionId === intSaleMsg2)!.createdAt).getTime();
    assert(time1 < time2, 'Scenario G: Style learning input presented in chronological order');
  }

  // ============================================================================
  // SCENARIO H: Sales Style Business-Policy Firewall
  // ============================================================================
  console.log('\n--- Scenario H: Sales Style Business-Policy Firewall ---');
  {
    const intSource = 'e3000000-0000-0000-0000-000000000021';
    const forbiddenPhrases = [
      'Em cam kết giảm giá 10% cho anh ngay hôm nay',
      'Anh vui lòng đặt cọc 5 triệu giữ chỗ nhé',
      'Cam kết giá rẻ nhất thị trường không đâu bằng',
      'Em gửi hợp đồng chuyển khoản luôn',
    ];

    for (const phrase of forbiddenPhrases) {
      let failedClosed = false;
      try {
        validateSalesStyleOutput({
          salutationRules: {
            selfReferences: ['em'],
            customerReferences: ['anh'],
            commonOpenings: ['Dạ em chào anh ạ'],
            notes: [phrase],
          },
          sentenceStyle: {
            preferredLength: 'MEDIUM',
            toneDescriptors: ['chuyên nghiệp'],
            emojiUsage: 'LOW',
            punctuationPatterns: ['chấm câu'],
            notes: ['gọn gàng'],
          },
          questionStyle: {
            commonPatterns: ['Cửa rộng bao nhiêu ạ?'],
            discoveryApproach: ['hỏi mở'],
            followUpApproach: ['hẹn nhẹ'],
            notes: ['thoải mái'],
          },
          objectionStyle: {
            approaches: [{ situation: 'Ngại cắt nền', responseApproach: 'giải pháp ép phẳng' }],
            notes: ['đồng cảm'],
          },
          closingStyle: {
            commonClosings: ['Chào anh ạ'],
            callToActionPatterns: ['hẹn khảo sát'],
            urgencyStyle: ['mùa mưa đến'],
            notes: ['chốt lịch'],
          },
        });
      } catch {
        failedClosed = true;
      }
      assert(failedClosed, `Scenario H: Firewall rejected forbidden commitment: "${phrase}"`);
    }

    // Safe canonical draft must validate and persist
    const safeOutput: SalesStyleOutput = {
      salutationRules: {
        selfReferences: ['em', 'mình'],
        customerReferences: ['anh', 'chị'],
        commonOpenings: ['Dạ em chào anh/chị ạ', 'Chào bạn nhé'],
        notes: ['Luôn chào hỏi lễ phép, xưng hô phù hợp lứa tuổi'],
      },
      sentenceStyle: {
        preferredLength: 'MEDIUM',
        toneDescriptors: ['nhiệt tình', 'chuyên nghiệp', 'gần gũi'],
        emojiUsage: 'LOW',
        punctuationPatterns: ['dùng dấu chấm câu rõ ràng'],
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
            situation: 'Khách băn khoăn về độ bền so với tường gạch xây',
            responseApproach: 'Đồng cảm trước, sau đó giải thích độ bền vật liệu inox 304 và cơ chế tự động ép kín nước',
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

    const validated = validateSalesStyleOutput(safeOutput);
    assert(Boolean(validated), 'Scenario H: Safe canonical style output passes firewall validation');

    const draftProfile = await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: [{ type: 'INTERACTION', id: intSource }],
      styleOutput: safeOutput,
      modelVersion: 'trusted-style-model-v1',
    });

    assert(draftProfile.generationStatus === 'DRAFT', 'Scenario H: Canonical safe style DRAFT persisted in database');
    assert(draftProfile.companyId === COMPANY_A_ID, 'Scenario H: Draft bound to Company A');
    assert(draftProfile.saleUserId === saleAUserId, 'Scenario H: Draft bound to Sale A');
  }

  // ============================================================================
  // SCENARIO I: Style Approval Lifecycle (DRAFT -> ACTIVE -> SUPERSEDED)
  // ============================================================================
  console.log('\n--- Scenario I: Sales Style Approval Lifecycle ---');
  {
    const intSource = 'e3000000-0000-0000-0000-000000000021';

    const sampleStyle1: SalesStyleOutput = {
      salutationRules: {
        selfReferences: ['em'],
        customerReferences: ['anh'],
        commonOpenings: ['Dạ em chào anh ạ'],
        notes: ['Thân thiện'],
      },
      sentenceStyle: {
        preferredLength: 'SHORT',
        toneDescriptors: ['ấm áp'],
        emojiUsage: 'NONE',
        punctuationPatterns: ['dấu chấm rõ ràng'],
        notes: ['ngắn gọn'],
      },
      questionStyle: {
        commonPatterns: ['Cửa rộng bao nhiêu ạ?'],
        discoveryApproach: ['hỏi kích thước'],
        followUpApproach: ['hẹn nhẹ'],
        notes: ['lịch sự'],
      },
      objectionStyle: {
        approaches: [{ situation: 'Khách ngại khoan cắt', responseApproach: 'Tư vấn phương án phẳng mép sàn' }],
        notes: ['giải thích rõ ràng'],
      },
      closingStyle: {
        commonClosings: ['Em cảm ơn anh ạ'],
        callToActionPatterns: ['hẹn khảo sát'],
        urgencyStyle: ['triều cường dâng'],
        notes: ['chốt lịch hẹn'],
      },
    };

    // 1. Create first DRAFT
    const draft1 = await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: [{ type: 'INTERACTION', id: intSource }],
      styleOutput: sampleStyle1,
      modelVersion: 'trusted-style-model-v1',
    });

    // 2. Boss A activates draft1 -> ACTIVE
    const activated1 = await activateSalesStyleProfile(bossAClient, draft1.id);
    assert(activated1.generationStatus === 'ACTIVE', 'Scenario I: draft1 successfully activated to ACTIVE');
    assert(activated1.activatedByUserId === bossAUserId, 'Scenario I: activated_by_user_id records Boss A');
    assert(Boolean(activated1.activatedAt), 'Scenario I: activated_at timestamp recorded');

    // 3. Create second DRAFT (v2.0)
    const draft2 = await persistSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
      sourceRefs: [{ type: 'INTERACTION', id: intSource }],
      styleOutput: sampleStyle1,
      modelVersion: 'trusted-style-model-v1',
    });

    // 4. Boss A activates draft2 -> draft1 becomes SUPERSEDED, draft2 becomes ACTIVE
    const activated2 = await activateSalesStyleProfile(bossAClient, draft2.id);
    assert(activated2.generationStatus === 'ACTIVE', 'Scenario I: draft2 successfully activated to ACTIVE');

    // Verify draft1 was transitioned to SUPERSEDED with lineage
    const { data: superseded1 } = await bossAClient
      .from('sales_style_profiles')
      .select('generation_status, superseded_at, superseded_by_profile_id')
      .eq('id', draft1.id)
      .single();

    assert(superseded1?.generation_status === 'SUPERSEDED', 'Scenario I: Previous active profile marked SUPERSEDED');
    assert(superseded1?.superseded_by_profile_id === draft2.id, 'Scenario I: superseded_by_profile_id references new active profile');
    assert(Boolean(superseded1?.superseded_at), 'Scenario I: superseded_at timestamp recorded');

    // Verify Single-Active Invariant: exactly 1 ACTIVE profile for this company + sale
    const { data: activeProfiles } = await bossAClient
      .from('sales_style_profiles')
      .select('id')
      .eq('company_id', COMPANY_A_ID)
      .eq('sale_user_id', saleAUserId)
      .eq('generation_status', 'ACTIVE');
    assert(activeProfiles?.length === 1, 'Scenario I: Single-Active invariant holds: exactly 1 ACTIVE profile exists');

    // 5. Retry activation of already ACTIVE profile: idempotent, no error, no duplicate audit
    const retryActive = await activateSalesStyleProfile(bossAClient, draft2.id);
    assert(retryActive.generationStatus === 'ACTIVE', 'Scenario I: Idempotent activation of already active profile succeeds');

    // 6. Attempt to reactivate SUPERSEDED profile: MUST FAIL CLOSED
    let reactivateSupersededFailed = false;
    try {
      await activateSalesStyleProfile(bossAClient, draft1.id);
    } catch {
      reactivateSupersededFailed = true;
    }
    assert(reactivateSupersededFailed, 'Scenario I: Reactivation of SUPERSEDED profile is strictly prohibited (fails closed)');
  }

  // ============================================================================
  // SCENARIO K: Worker Active-Style Read
  // ============================================================================
  console.log('\n--- Scenario K: Worker Active-Style Read ---');
  {
    // 1. service_role machine read succeeds
    const activeProfile = await fetchActiveSalesStyleProfile(adminClient, {
      companyId: COMPANY_A_ID,
      saleUserId: saleAUserId,
    });

    assert(activeProfile !== null, 'Scenario K: Worker active-style read via service_role returns ACTIVE profile');
    assert(typeof activeProfile?.id === 'string' && activeProfile.id.length > 0, 'Scenario K: Returned active profile has valid ID');
    assert(Boolean(activeProfile?.activatedAt), 'Scenario K: Returned active profile has activatedAt timestamp');

    // Invariant: Bounded read must NOT return source_refs or examples or raw message content
    const returnedKeys = Object.keys(activeProfile || {});
    assert(!returnedKeys.includes('source_refs') && !returnedKeys.includes('sourceRefs'), 'Scenario K: source_refs omitted from runtime read');
    assert(!returnedKeys.includes('examples'), 'Scenario K: examples omitted from runtime read');

    // 2. Human authenticated session denied worker-only read RPC
    const { error: humanReadErr } = await bossAClient.rpc('get_active_sales_style_profile', {
      p_company_id: COMPANY_A_ID,
      p_sale_user_id: saleAUserId,
    });
    assert(Boolean(humanReadErr), 'Scenario K: Human Boss session denied worker-only RPC (permission denied)');

    const { error: anonReadErr } = await createAnonClient().rpc('get_active_sales_style_profile', {
      p_company_id: COMPANY_A_ID,
      p_sale_user_id: saleAUserId,
    });
    assert(Boolean(anonReadErr), 'Scenario K: Anonymous session denied worker-only RPC (permission denied)');
  }

  // ============================================================================
  // SCENARIO M: Analytics Semantics & Financial Snapshot Separation
  // ============================================================================
  console.log('\n--- Scenario M: Analytics Semantics & Financial Snapshot ---');
  {
    const policyId = 'e8000000-0000-0000-0000-000000000001';
    const calc1Id = 'e8100000-0000-0000-0000-000000000001';
    const orderId = 'e4000000-0000-0000-0000-000000000001';

    executeRawSql(`
      DELETE FROM public.finance_summaries WHERE company_id = '${COMPANY_A_ID}';
      DELETE FROM public.orders WHERE company_id = '${COMPANY_A_ID}';
      ALTER TABLE public.price_calculations DISABLE TRIGGER trg_price_calculations_immutability;
      DELETE FROM public.price_calculations WHERE company_id = '${COMPANY_A_ID}';
      ALTER TABLE public.price_calculations ENABLE TRIGGER trg_price_calculations_immutability;
      DELETE FROM public.pricing_policies WHERE company_id = '${COMPANY_A_ID}';

      INSERT INTO public.pricing_policies (id, company_id, version, conditions, price_rules, effective_at, status)
      VALUES ('${policyId}', '${COMPANY_A_ID}', 'V2026.E2E', '{}'::jsonb, '{}'::jsonb, '2026-01-01T00:00:00Z', 'ACTIVE');

      INSERT INTO public.price_calculations (id, company_id, customer_id, pricing_policy_id, policy_version, input_data, amount, status)
      VALUES ('${calc1Id}', '${COMPANY_A_ID}', '${CUSTOMER_A_ID}', '${policyId}', 'V2026.E2E', '{}'::jsonb, 35000000.00, 'CALCULATED');

      INSERT INTO public.orders (id, company_id, customer_id, order_code, payment_reference, price_calculation_id, deposit_status, order_status, final_amount, created_at)
      VALUES ('${orderId}', '${COMPANY_A_ID}', '${CUSTOMER_A_ID}', 'ORD-E2E-001', 'PAY-REF-E2E', '${calc1Id}', 'CONFIRMED', 'DEPOSIT_CONFIRMED', 35000000.00, '2026-09-10T10:00:00.000Z');

      INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount, completed_revenue)
      VALUES ('${orderId}', '${COMPANY_A_ID}', 35000000.00, 10000000.00, 25000000.00, 0.00);
    `);

    // In Period: 2026-09-01 to 2026-09-15
    const overviewPeriod1 = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T23:59:59.999Z',
    });

    assert(overviewPeriod1.orders.created >= 1, 'Scenario M: Period 1 includes created order');
    assert(overviewPeriod1.financeSnapshot !== null, 'Scenario M: Finance snapshot is present');

    // In Period 2: 2026-08-01 to 2026-08-15 (Order was NOT created in August)
    const overviewPeriod2 = await fetchCompanyAnalyticsOverview(bossAClient, {
      companyId: COMPANY_A_ID,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-15T23:59:59.999Z',
    });

    // Period metrics must differ appropriately
    assert(overviewPeriod2.orders.created === 0, 'Scenario M: Period 2 orders.created is 0 (period metrics changed)');

    // Finance snapshot must remain current company snapshot
    assert(
      overviewPeriod1.financeSnapshot.contractValue === overviewPeriod2.financeSnapshot.contractValue,
      'Scenario M: Finance snapshot remains company snapshot regardless of selected time window'
    );

    // Invariant: SUM(order.final_amount) is NOT treated as revenue (revenue comes from COMPLETED payments)
    assert(
      overviewPeriod1.financeSnapshot.completedRevenue !== overviewPeriod1.financeSnapshot.contractValue,
      'Scenario M: order.final_amount is strictly NOT treated as revenue'
    );
  }

  // ============================================================================
  // SCENARIO P: Zero/Empty-State Robustness
  // ============================================================================
  console.log('\n--- Scenario P: Zero/Empty-State Robustness ---');
  {
    // Query empty period for Company B
    const emptyOverview = await fetchCompanyAnalyticsOverview(bossBClient, {
      companyId: COMPANY_B_ID,
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-01-02T00:00:00.000Z',
    });

    // Check formatting utilities with empty / zero / null values
    const moneyZero = formatMoneyVnd('0.00');
    const moneyNull = formatMoneyVnd(null);
    const bpZero = formatBasisPoints(0);
    const bpNull = formatBasisPoints(null);
    const secZero = formatSeconds(0);
    const secNull = formatSeconds(null);

    const testStrings = [moneyZero, moneyNull, bpZero, bpNull, secZero, secNull];
    for (const str of testStrings) {
      assert(!str.includes('NaN'), `Scenario P: Formatted output "${str}" does NOT contain NaN`);
      assert(!str.includes('Infinity'), `Scenario P: Formatted output "${str}" does NOT contain Infinity`);
      assert(!str.includes('-Infinity'), `Scenario P: Formatted output "${str}" does NOT contain -Infinity`);
    }

    assert(emptyOverview.customers.newCustomers === 0, 'Scenario P: Empty customers count is 0');
    assert(emptyOverview.responseSla.complianceRateBasisPoints === null, 'Scenario P: Empty SLA compliance is null');
    assert(emptyOverview.responseSla.avgSaleResponseSeconds === null, 'Scenario P: Empty SLA avg response time is null');
    assert(emptyOverview.financeSnapshot.completedRevenue === '0.00', 'Scenario P: Empty completed revenue is "0.00"');
  }

  console.log('================================================================');
  console.log(`CURRENT SYSTEM INTEGRATION RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

setupFixtures()
  .then(() => runAllScenarios())
  .catch((err) => {
    console.error('Fatal error during integration tests:', err);
    process.exit(1);
  });
