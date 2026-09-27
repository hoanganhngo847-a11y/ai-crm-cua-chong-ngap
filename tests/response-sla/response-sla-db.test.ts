import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  openResponseSlaWindow,
  resolveResponseSlaOnSaleReply,
  claimResponseSlaForAi,
} from '../../features/automation/response-sla/services/response-sla-store';

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

// Dedicated deterministic UUID fixtures for Response SLA DB tests
const COMPANY_A_ID = '90000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = '90000000-0000-0000-0000-000000000002';

const CUSTOMER_A_ID = '91000000-0000-0000-0000-000000000001';
const CUSTOMER_B_ID = '91000000-0000-0000-0000-000000000002';

// Conversations
const CONVO_1_ID = '92000000-0000-0000-0000-000000000001'; // Normal OPEN convo
const CONVO_2_ID = '92000000-0000-0000-0000-000000000002'; // Convo for Sale resolution
const CONVO_3_ID = '92000000-0000-0000-0000-000000000003'; // Convo for Not Due claim
const CONVO_4_ID = '92000000-0000-0000-0000-000000000004'; // Convo for Due claim
const CONVO_5_ID = '92000000-0000-0000-0000-000000000005'; // Convo for Sale-before-claim
const CONVO_CLOSED_ID = '92000000-0000-0000-0000-000000000006'; // Status = CLOSED
const CONVO_AI_HANDLING_ID = '92000000-0000-0000-0000-000000000007'; // Status = AI_HANDLING
const CONVO_CONCURRENT_ID = '92000000-0000-0000-0000-000000000008'; // For concurrent AI claims
const CONVO_AUDIT_FAIL_ID = '92000000-0000-0000-0000-000000000009'; // For audit rollback test
const CONVO_COMPANY_B_ID = '92000000-0000-0000-0000-000000000010'; // In Company B
const CONVO_RECLAIM_ID = '92000000-0000-0000-0000-000000000011'; // For recoverable lease reclaim
const CONVO_CONC_RECLAIM_ID = '92000000-0000-0000-0000-000000000012'; // For concurrent reclaim

// Interactions
const INT_INBOUND_CUST_1 = '93000000-0000-0000-0000-000000000001';
const INT_INBOUND_CUST_2 = '93000000-0000-0000-0000-000000000002';
const INT_OUTBOUND_SALE_1 = '93000000-0000-0000-0000-000000000003';
const INT_OUTBOUND_AI = '93000000-0000-0000-0000-000000000004';
const INT_CALL_EVENT = '93000000-0000-0000-0000-000000000005';
const INT_COMPANY_B = '93000000-0000-0000-0000-000000000006';
const INT_DUE_TRIGGER = '93000000-0000-0000-0000-000000000007';
const INT_NOT_DUE_TRIGGER = '93000000-0000-0000-0000-000000000008';
const INT_SALE_BEFORE_CLAIM_TRIGGER = '93000000-0000-0000-0000-000000000009';
const INT_SALE_BEFORE_CLAIM_REPLY = '93000000-0000-0000-0000-000000000010';
const INT_CONCURRENT_TRIGGER = '93000000-0000-0000-0000-000000000011';
const INT_AUDIT_FAIL_TRIGGER = '93000000-0000-0000-0000-000000000012';
const INT_RECLAIM_TRIGGER = '93000000-0000-0000-0000-000000000013';
const INT_CONC_RECLAIM_TRIGGER = '93000000-0000-0000-0000-000000000014';

// Authenticated test user credentials (from existing fixtures)
const USER_BOSS = { email: 'sec_boss@trusted.local', password: 'Password123!' };
const USER_SALE = { email: 'sec_sale@trusted.local', password: 'Password123!' };
const USER_TECH = { email: 'sec_tech@trusted.local', password: 'Password123!' };

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
  console.log('--- Setting up Response SLA test database fixtures ---');

  // 1. Companies
  const { error: errComp } = await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'SLA Test Company A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'SLA Test Company B', status: 'ACTIVE' },
  ]);
  if (errComp) throw new Error(`Companies upsert failed: ${errComp.message}`);

  // 1b. Ensure company memberships and auth users for test users in COMPANY_A_ID
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

  await ensureUser({ ...USER_BOSS, fullName: 'Lê Quản Trị (Sếp)' }, COMPANY_A_ID, 'BOSS_ADMIN');
  await ensureUser({ ...USER_SALE, fullName: 'Nguyễn Văn Sale' }, COMPANY_A_ID, 'SALE');
  await ensureUser({ ...USER_TECH, fullName: 'Trần Kỹ Thuật' }, COMPANY_A_ID, 'TECHNICIAN');

  // 2. Customers
  const { error: errCust } = await adminClient.from('customers').upsert([
    { id: CUSTOMER_A_ID, company_id: COMPANY_A_ID, customer_code: 'KH-SLA-001', name: 'Khách SLA A', source: 'ZALO', stage: 'LEAD_NEW' },
    { id: CUSTOMER_B_ID, company_id: COMPANY_B_ID, customer_code: 'KH-SLA-002', name: 'Khách SLA B', source: 'FACEBOOK', stage: 'LEAD_NEW' },
  ]);
  if (errCust) throw new Error(`Customers upsert failed: ${errCust.message}`);

  // 3. Conversations
  const { error: errConvo } = await adminClient.from('conversations').upsert([
    { id: CONVO_1_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'ZALO', external_conversation_id: 'ext_sla_1', status: 'OPEN' },
    { id: CONVO_2_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'FACEBOOK', external_conversation_id: 'ext_sla_2', status: 'OPEN' },
    { id: CONVO_3_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'ZALO', external_conversation_id: 'ext_sla_3', status: 'OPEN' },
    { id: CONVO_4_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'FACEBOOK', external_conversation_id: 'ext_sla_4', status: 'OPEN' },
    { id: CONVO_5_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'ZALO', external_conversation_id: 'ext_sla_5', status: 'OPEN' },
    { id: CONVO_CLOSED_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'FACEBOOK', external_conversation_id: 'ext_sla_closed', status: 'CLOSED' },
    { id: CONVO_AI_HANDLING_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'ZALO', external_conversation_id: 'ext_sla_ai', status: 'AI_HANDLING' },
    { id: CONVO_CONCURRENT_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'FACEBOOK', external_conversation_id: 'ext_sla_conc', status: 'OPEN' },
    { id: CONVO_AUDIT_FAIL_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'ZALO', external_conversation_id: 'ext_sla_audit', status: 'OPEN' },
    { id: CONVO_COMPANY_B_ID, company_id: COMPANY_B_ID, customer_id: CUSTOMER_B_ID, channel: 'FACEBOOK', external_conversation_id: 'ext_sla_b', status: 'OPEN' },
    { id: CONVO_RECLAIM_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'ZALO', external_conversation_id: 'ext_sla_reclaim', status: 'OPEN' },
    { id: CONVO_CONC_RECLAIM_ID, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, channel: 'FACEBOOK', external_conversation_id: 'ext_sla_creclaim', status: 'OPEN' },
  ]);
  if (errConvo) throw new Error(`Conversations upsert failed: ${errConvo.message}`);

  const now = new Date();
  const past10Min = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const past8Min = new Date(now.getTime() - 8 * 60 * 1000).toISOString();
  const past2Min = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const past1Min = new Date(now.getTime() - 1 * 60 * 1000).toISOString();

  // 4. Interactions
  const { error: errInt } = await adminClient.from('interactions').upsert([
    // CONVO 1: Two customer inbounds
    { id: INT_INBOUND_CUST_1, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_1_ID, channel: 'ZALO', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past2Min },
    { id: INT_INBOUND_CUST_2, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_1_ID, channel: 'ZALO', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past1Min },

    // CONVO 2: Customer inbound + Sale outbound
    { id: INT_OUTBOUND_SALE_1, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_2_ID, channel: 'FACEBOOK', type: 'MESSAGE', direction: 'OUTBOUND', actor_type: 'SALE', created_at: past1Min },
    { id: INT_OUTBOUND_AI, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_2_ID, channel: 'FACEBOOK', type: 'MESSAGE', direction: 'OUTBOUND', actor_type: 'AI', created_at: past1Min },
    { id: INT_CALL_EVENT, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_2_ID, channel: 'HOTLINE', type: 'CALL_EVENT', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past1Min },

    // CONVO 3: Not Due (started 2 min ago)
    { id: INT_NOT_DUE_TRIGGER, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_3_ID, channel: 'ZALO', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past2Min },

    // CONVO 4: Due (started 10 min ago)
    { id: INT_DUE_TRIGGER, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_4_ID, channel: 'FACEBOOK', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past10Min },

    // CONVO 5: Sale replied before claim
    { id: INT_SALE_BEFORE_CLAIM_TRIGGER, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_5_ID, channel: 'ZALO', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past10Min },
    { id: INT_SALE_BEFORE_CLAIM_REPLY, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_5_ID, channel: 'ZALO', type: 'MESSAGE', direction: 'OUTBOUND', actor_type: 'SALE', created_at: past8Min },

    // CONVO CONCURRENT: Trigger 10 min ago
    { id: INT_CONCURRENT_TRIGGER, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_CONCURRENT_ID, channel: 'FACEBOOK', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past10Min },

    // CONVO AUDIT FAIL: Trigger 10 min ago
    { id: INT_AUDIT_FAIL_TRIGGER, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_AUDIT_FAIL_ID, channel: 'ZALO', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past10Min },

    // CONVO RECLAIM: Trigger 10 min ago
    { id: INT_RECLAIM_TRIGGER, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_RECLAIM_ID, channel: 'ZALO', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past10Min },

    // CONVO CONCURRENT RECLAIM: Trigger 10 min ago
    { id: INT_CONC_RECLAIM_TRIGGER, company_id: COMPANY_A_ID, customer_id: CUSTOMER_A_ID, conversation_id: CONVO_CONC_RECLAIM_ID, channel: 'FACEBOOK', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past10Min },

    // Company B Interaction
    { id: INT_COMPANY_B, company_id: COMPANY_B_ID, customer_id: CUSTOMER_B_ID, conversation_id: CONVO_COMPANY_B_ID, channel: 'FACEBOOK', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', created_at: past2Min },
  ]);
  if (errInt) throw new Error(`Interactions upsert failed: ${errInt.message}`);

  // Clean existing windows for these test conversations using privileged psql
  // (because service_role direct DELETE is strictly revoked)
  executeRawSql(`DELETE FROM public.response_sla_windows WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');`);

  console.log('✓ Database fixtures created.');
}

async function runTests() {
  await setupDatabaseFixtures();

  console.log('\n==================================================');
  console.log('RUNNING RESPONSE SLA PERSISTENCE & CONCURRENCY TESTS');
  console.log('==================================================\n');

  // ---------------------------------------------------------------------------
  // Test 1: First inbound customer message -> creates OPEN window
  // ---------------------------------------------------------------------------
  const win1 = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_1_ID,
    triggerInteractionId: INT_INBOUND_CUST_1,
  });
  assert(win1.state === 'OPEN', 'Test 1: First inbound customer message creates OPEN window');
  assert(win1.conversationId === CONVO_1_ID, 'Test 1: Window binds correct conversation');
  assert(win1.customerId === CUSTOMER_A_ID, 'Test 1: Window derives correct customer');
  assert(win1.resolvedAt === null, 'Test 1: OPEN window has resolvedAt = null');
  assert(win1.aiClaimedAt === null, 'Test 1: OPEN window has aiClaimedAt = null');
  assert(win1.aiClaimExpiresAt === null, 'Test 1: OPEN window has aiClaimExpiresAt = null');

  // Verify deadline is exactly started_at + 300 seconds
  const startMs = new Date(win1.startedAt).getTime();
  const deadlineMs = new Date(win1.deadlineAt).getTime();
  assert(deadlineMs - startMs === 300 * 1000, 'Test 1: Deadline is startedAt + exactly 300 seconds');

  // ---------------------------------------------------------------------------
  // Test 2: Second inbound customer message -> returns same window, deadline unchanged
  // ---------------------------------------------------------------------------
  const win2 = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_1_ID,
    triggerInteractionId: INT_INBOUND_CUST_2,
  });
  assert(win2.id === win1.id, 'Test 2: Second inbound message returns same window ID');
  assert(win2.startedAt === win1.startedAt, 'Test 2: startedAt is NOT reset');
  assert(win2.deadlineAt === win1.deadlineAt, 'Test 2: deadlineAt is NOT reset');

  // ---------------------------------------------------------------------------
  // Test 3: Concurrent/open retry -> only one OPEN window
  // ---------------------------------------------------------------------------
  const concurrentOpens = await Promise.all([
    openResponseSlaWindow({ companyId: COMPANY_A_ID, conversationId: CONVO_1_ID, triggerInteractionId: INT_INBOUND_CUST_1 }),
    openResponseSlaWindow({ companyId: COMPANY_A_ID, conversationId: CONVO_1_ID, triggerInteractionId: INT_INBOUND_CUST_2 }),
  ]);
  assert(concurrentOpens[0].id === concurrentOpens[1].id, 'Test 3: Concurrent calls resolve to identical window');

  // Query using boss client (authenticated)
  const bossClient = createAnonClient();
  await bossClient.auth.signInWithPassword(USER_BOSS);
  const { data: openRows } = await bossClient
    .from('response_sla_windows')
    .select('id')
    .eq('company_id', COMPANY_A_ID)
    .eq('conversation_id', CONVO_1_ID)
    .eq('state', 'OPEN');
  assert(openRows?.length === 1, 'Test 3: Database maintains exactly 1 OPEN window for conversation');

  // ---------------------------------------------------------------------------
  // Test 4: Trigger interaction from wrong Company -> denied
  // ---------------------------------------------------------------------------
  let test4Error = false;
  try {
    await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_1_ID,
      triggerInteractionId: INT_COMPANY_B, // from Company B
    });
  } catch {
    test4Error = true;
  }
  assert(test4Error, 'Test 4: Trigger interaction from wrong Company is denied');

  // ---------------------------------------------------------------------------
  // Test 5: Interaction from wrong Conversation -> denied
  // ---------------------------------------------------------------------------
  let test5Error = false;
  try {
    await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_1_ID,
      triggerInteractionId: INT_OUTBOUND_SALE_1, // from CONVO_2
    });
  } catch {
    test5Error = true;
  }
  assert(test5Error, 'Test 5: Interaction from wrong Conversation is denied');

  // ---------------------------------------------------------------------------
  // Test 6: Interaction not CUSTOMER/INBOUND/MESSAGE -> denied
  // ---------------------------------------------------------------------------
  let test6aError = false;
  try {
    await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_2_ID,
      triggerInteractionId: INT_OUTBOUND_SALE_1, // OUTBOUND SALE
    });
  } catch {
    test6aError = true;
  }
  assert(test6aError, 'Test 6a: Non-CUSTOMER interaction rejected');

  let test6bError = false;
  try {
    await openResponseSlaWindow({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_2_ID,
      triggerInteractionId: INT_CALL_EVENT, // CALL_EVENT type
    });
  } catch {
    test6bError = true;
  }
  assert(test6bError, 'Test 6b: Non-MESSAGE interaction rejected');

  // ---------------------------------------------------------------------------
  // Test 7: Sale reply -> resolves OPEN window
  // ---------------------------------------------------------------------------
  const custMsgConvo2 = '93000000-0000-0000-0000-000000000021';
  await adminClient.from('interactions').upsert({
    id: custMsgConvo2,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    conversation_id: CONVO_2_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
  });
  await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_2_ID,
    triggerInteractionId: custMsgConvo2,
  });

  const resolvedWin = await resolveResponseSlaOnSaleReply({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_2_ID,
    saleInteractionId: INT_OUTBOUND_SALE_1,
  });
  assert(resolvedWin !== null, 'Test 7: resolveResponseSlaOnSaleReply returns resolved window');
  assert(resolvedWin?.state === 'SALE_RESPONDED', 'Test 7: Window state transitioned to SALE_RESPONDED');
  assert(resolvedWin?.saleResponseInteractionId === INT_OUTBOUND_SALE_1, 'Test 7: saleResponseInteractionId bound correctly');
  assert(resolvedWin?.resolvedAt !== null, 'Test 7: resolvedAt is populated');

  // ---------------------------------------------------------------------------
  // Test 8: Non-SALE outbound -> cannot resolve as SALE
  // ---------------------------------------------------------------------------
  let test8Error = false;
  try {
    await resolveResponseSlaOnSaleReply({
      companyId: COMPANY_A_ID,
      conversationId: CONVO_2_ID,
      saleInteractionId: INT_OUTBOUND_AI, // AI actor
    });
  } catch {
    test8Error = true;
  }
  assert(test8Error, 'Test 8: AI outbound interaction cannot resolve SLA as SALE');

  // ---------------------------------------------------------------------------
  // Test 9: Claim before 5 minutes -> denied (NOT_DUE)
  // ---------------------------------------------------------------------------
  const notDueWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_3_ID,
    triggerInteractionId: INT_NOT_DUE_TRIGGER,
  });
  const claimNotDue = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: notDueWin.id,
  });
  assert(claimNotDue.claimed === false, 'Test 9: Claim before 5 minutes is NOT claimed');
  assert(claimNotDue.decision === 'NOT_DUE', 'Test 9: Decision reason is NOT_DUE');

  // ---------------------------------------------------------------------------
  // Test 10: Claim exactly at/after deadline -> success with recoverable lease
  // ---------------------------------------------------------------------------
  const dueWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_4_ID,
    triggerInteractionId: INT_DUE_TRIGGER,
  });
  const claimDue = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: dueWin.id,
  });
  assert(claimDue.claimed === true, 'Test 10: Claim after deadline succeeds');
  assert(claimDue.decision === 'ALLOW_AI_REPLY', 'Test 10: Decision is ALLOW_AI_REPLY');
  assert(typeof claimDue.claimId === 'string' && claimDue.claimId.length > 0, 'Test 10: claimId is generated');
  assert(claimDue.claimedAt !== null, 'Test 10: claimedAt timestamp is recorded');
  assert(claimDue.claimExpiresAt !== null, 'Test 10: claimExpiresAt lease timestamp is recorded');

  // Verify lease duration is > claimedAt
  const claimMs = new Date(claimDue.claimedAt!).getTime();
  const expireMs = new Date(claimDue.claimExpiresAt!).getTime();
  assert(expireMs > claimMs, 'Test 10: claimExpiresAt is in the future');

  // Verify conversation status is updated to AI_HANDLING
  const { data: convo4 } = await adminClient
    .from('conversations')
    .select('status')
    .eq('id', CONVO_4_ID)
    .single();
  assert(convo4?.status === 'AI_HANDLING', 'Test 10: Conversation status updated to AI_HANDLING');

  // ---------------------------------------------------------------------------
  // Test 11: Sale reply existing before claim -> AI denied
  // ---------------------------------------------------------------------------
  const saleBeforeClaimWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_5_ID,
    triggerInteractionId: INT_SALE_BEFORE_CLAIM_TRIGGER,
  });
  const claimWithSaleReply = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: saleBeforeClaimWin.id,
  });
  assert(claimWithSaleReply.claimed === false, 'Test 11: Claim denied when Sale already replied');
  assert(claimWithSaleReply.decision === 'SALE_ALREADY_RESPONDED', 'Test 11: Decision reason is SALE_ALREADY_RESPONDED');

  // Verify window was auto-resolved to SALE_RESPONDED in DB
  const { data: win5Db } = await bossClient
    .from('response_sla_windows')
    .select('state, sale_response_interaction_id')
    .eq('id', saleBeforeClaimWin.id)
    .single();
  assert(win5Db?.state === 'SALE_RESPONDED', 'Test 11: Window was auto-resolved to SALE_RESPONDED in DB');
  assert(win5Db?.sale_response_interaction_id === INT_SALE_BEFORE_CLAIM_REPLY, 'Test 11: Found Sale interaction linked');

  // ---------------------------------------------------------------------------
  // Test 12: Conversation CLOSED -> AI denied
  // ---------------------------------------------------------------------------
  const intClosedTrigger = '93000000-0000-0000-0000-000000000031';
  await adminClient.from('interactions').upsert({
    id: intClosedTrigger,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    conversation_id: CONVO_CLOSED_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const closedWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_CLOSED_ID,
    triggerInteractionId: intClosedTrigger,
  });
  const claimClosed = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: closedWin.id,
  });
  assert(claimClosed.claimed === false, 'Test 12: Claim denied when Conversation is CLOSED');
  assert(claimClosed.decision === 'CONVERSATION_CLOSED', 'Test 12: Decision is CONVERSATION_CLOSED');

  // ---------------------------------------------------------------------------
  // Test 13: Conversation AI_HANDLING -> AI denied
  // ---------------------------------------------------------------------------
  const intAiTrigger = '93000000-0000-0000-0000-000000000032';
  await adminClient.from('interactions').upsert({
    id: intAiTrigger,
    company_id: COMPANY_A_ID,
    customer_id: CUSTOMER_A_ID,
    conversation_id: CONVO_AI_HANDLING_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const aiHandlingWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_AI_HANDLING_ID,
    triggerInteractionId: intAiTrigger,
  });
  const claimAiHandling = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: aiHandlingWin.id,
  });
  assert(claimAiHandling.claimed === false, 'Test 13: Claim denied when Conversation is AI_HANDLING');
  assert(claimAiHandling.decision === 'AI_ALREADY_HANDLING', 'Test 13: Decision is AI_ALREADY_HANDLING');

  // ---------------------------------------------------------------------------
  // Test 14: Two concurrent AI claims -> only one succeeds
  // ---------------------------------------------------------------------------
  const concWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_CONCURRENT_ID,
    triggerInteractionId: INT_CONCURRENT_TRIGGER,
  });
  const [claimWorker1, claimWorker2] = await Promise.all([
    claimResponseSlaForAi({ companyId: COMPANY_A_ID, windowId: concWin.id }),
    claimResponseSlaForAi({ companyId: COMPANY_A_ID, windowId: concWin.id }),
  ]);
  const successCount = (claimWorker1.claimed ? 1 : 0) + (claimWorker2.claimed ? 1 : 0);
  assert(successCount === 1, 'Test 14: Exactly one concurrent AI claim succeeds');
  const failedWorker = claimWorker1.claimed ? claimWorker2 : claimWorker1;
  assert(failedWorker.decision === 'ALREADY_CLAIMED', 'Test 14: Losing concurrent claim gets ALREADY_CLAIMED');

  // ---------------------------------------------------------------------------
  // Test 15: Claim from wrong Company -> denied
  // ---------------------------------------------------------------------------
  const claimWrongComp = await claimResponseSlaForAi({
    companyId: COMPANY_B_ID, // wrong company for concWin (belongs to COMPANY_A)
    windowId: concWin.id,
  });
  assert(claimWrongComp.claimed === false, 'Test 15: Cross-company AI claim is denied');
  assert(claimWrongComp.decision === 'WRONG_COMPANY', 'Test 15: Cross-company decision is WRONG_COMPANY');

  // ---------------------------------------------------------------------------
  // Test 16: Successful claim writes audit
  // ---------------------------------------------------------------------------
  const { data: auditEntries } = await adminClient
    .from('audit_logs')
    .select('*')
    .eq('action', 'RESPONSE_SLA_AI_CLAIM')
    .eq('resource_id', dueWin.id)
    .eq('result', 'SUCCESS');
  assert((auditEntries?.length ?? 0) >= 1, 'Test 16: Audit log created for successful AI claim');
  const auditMeta = auditEntries?.[0]?.metadata;
  assert(auditMeta?.decision === 'CLAIMED', 'Test 16: Audit metadata contains decision: CLAIMED');
  assert(auditMeta?.claim_id === claimDue.claimId, 'Test 16: Audit metadata records matching claim_id');
  assert(Boolean(auditMeta?.claim_expires_at), 'Test 16: Audit metadata records claim_expires_at');

  // ---------------------------------------------------------------------------
  // Test 17: Audit failure -> claim rolls back/fails closed
  // ---------------------------------------------------------------------------
  const auditFailWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_AUDIT_FAIL_ID,
    triggerInteractionId: INT_AUDIT_FAIL_TRIGGER,
  });

  // Inject temporary trigger to simulate audit write failure for this specific window
  executeRawSql(`
    CREATE OR REPLACE FUNCTION trigger_fail_audit_for_test()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.action = 'RESPONSE_SLA_AI_CLAIM' AND NEW.resource_id = '${auditFailWin.id}'::uuid THEN
        RAISE EXCEPTION 'FORCED_AUDIT_LOG_FAILURE_FOR_TEST';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_test_audit_failure ON public.audit_logs;
    CREATE TRIGGER trg_test_audit_failure
    BEFORE INSERT ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION trigger_fail_audit_for_test();
  `);

  let auditFailedError = false;
  try {
    await claimResponseSlaForAi({
      companyId: COMPANY_A_ID,
      windowId: auditFailWin.id,
    });
  } catch {
    auditFailedError = true;
  }
  assert(auditFailedError, 'Test 17: Claim throws when audit log insertion fails');

  // Verify rollback: window ai_claimed_at must still be NULL, conversation status must NOT be AI_HANDLING
  const { data: winAfterFail } = await bossClient
    .from('response_sla_windows')
    .select('ai_claimed_at, ai_claim_id')
    .eq('id', auditFailWin.id)
    .single();
  assert(winAfterFail?.ai_claimed_at === null, 'Test 17: ai_claimed_at rolled back to null');
  assert(winAfterFail?.ai_claim_id === null, 'Test 17: ai_claim_id rolled back to null');

  const { data: convoAfterFail } = await adminClient
    .from('conversations')
    .select('status')
    .eq('id', CONVO_AUDIT_FAIL_ID)
    .single();
  assert(convoAfterFail?.status === 'OPEN', 'Test 17: Conversation status rolled back to OPEN');

  // Clean up trigger
  executeRawSql(`
    DROP TRIGGER IF EXISTS trg_test_audit_failure ON public.audit_logs;
    DROP FUNCTION IF EXISTS trigger_fail_audit_for_test();
  `);

  // ---------------------------------------------------------------------------
  // Test 18: No raw phone/message/transcript in returned DTO
  // ---------------------------------------------------------------------------
  const winKeys = Object.keys(win1);
  const forbiddenKeywords = ['phone', 'raw', 'transcript', 'content', 'message'];
  const hasForbiddenWinKey = winKeys.some((k) =>
    forbiddenKeywords.some((fw) => k.toLowerCase().includes(fw) && !k.toLowerCase().includes('interactionid'))
  );
  assert(!hasForbiddenWinKey, 'Test 18a: No sensitive content fields in ResponseSlaDurableWindow DTO');

  const claimKeys = Object.keys(claimDue);
  const hasForbiddenClaimKey = claimKeys.some((k) =>
    forbiddenKeywords.some((fw) => k.toLowerCase().includes(fw))
  );
  assert(!hasForbiddenClaimKey, 'Test 18b: No sensitive content fields in ResponseSlaClaimResult DTO');

  // ---------------------------------------------------------------------------
  // Test 19: Browser/authenticated cannot directly INSERT/UPDATE response_sla_windows
  // ---------------------------------------------------------------------------
  const anonClient = createAnonClient();
  const { error: anonInsertErr } = await anonClient
    .from('response_sla_windows')
    .insert({
      company_id: COMPANY_A_ID,
      conversation_id: CONVO_1_ID,
      customer_id: CUSTOMER_A_ID,
      trigger_interaction_id: INT_INBOUND_CUST_1,
      started_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 300000).toISOString(),
      state: 'OPEN',
    });
  assert(Boolean(anonInsertErr), 'Test 19a: Anon direct INSERT rejected by RLS/privileges');

  const saleClient = createAnonClient();
  const { data: saleAuth } = await saleClient.auth.signInWithPassword(USER_SALE);
  assert(Boolean(saleAuth.session), 'Test 19b: Sale signs in');

  const { error: saleInsertErr } = await saleClient
    .from('response_sla_windows')
    .insert({
      company_id: COMPANY_A_ID,
      conversation_id: CONVO_1_ID,
      customer_id: CUSTOMER_A_ID,
      trigger_interaction_id: INT_INBOUND_CUST_1,
      started_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 300000).toISOString(),
      state: 'OPEN',
    });
  assert(Boolean(saleInsertErr), 'Test 19c: Authenticated SALE direct INSERT rejected by table ACL (42501)');

  const { error: saleUpdateErr } = await saleClient
    .from('response_sla_windows')
    .update({ state: 'CANCELLED' })
    .eq('id', win1.id);
  assert(Boolean(saleUpdateErr), 'Test 19d: Authenticated SALE direct UPDATE rejected by table ACL (42501)');

  // Direct RPC execution as authenticated SALE
  const { error: saleRpcErr } = await saleClient.rpc('open_response_sla_window', {
    p_company_id: COMPANY_A_ID,
    p_conversation_id: CONVO_1_ID,
    p_trigger_interaction_id: INT_INBOUND_CUST_1,
  });
  assert(Boolean(saleRpcErr), 'Test 19e: Direct RPC execution by authenticated user rejected by ACL (42501)');

  // ---------------------------------------------------------------------------
  // Test 20: TECHNICIAN cannot SELECT if RLS policy intentionally excludes them
  // ---------------------------------------------------------------------------
  const techClient = createAnonClient();
  const { data: techAuth } = await techClient.auth.signInWithPassword(USER_TECH);
  assert(Boolean(techAuth.session), 'Test 20a: Tech signs in');

  const { data: techSelect } = await techClient
    .from('response_sla_windows')
    .select('*');
  assert(techSelect?.length === 0, 'Test 20b: TECHNICIAN SELECT yields 0 rows (RLS excludes technician)');

  // BOSS_ADMIN can select their company's rows
  const { data: bossSelect } = await bossClient
    .from('response_sla_windows')
    .select('*')
    .eq('company_id', COMPANY_A_ID);
  assert((bossSelect?.length ?? 0) > 0, 'Test 20c: BOSS_ADMIN can SELECT company SLA windows');

  // SALE can also select their company's rows for visibility
  const { data: saleSelect } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('company_id', COMPANY_A_ID);
  assert((saleSelect?.length ?? 0) > 0, 'Test 20d: SALE can SELECT company SLA windows');

  // ---------------------------------------------------------------------------
  // Test 21: P0 — Service Role CANNOT directly INSERT, UPDATE, or DELETE (RPC-only)
  // ---------------------------------------------------------------------------
  const { error: srInsertErr } = await adminClient
    .from('response_sla_windows')
    .insert({
      company_id: COMPANY_A_ID,
      conversation_id: CONVO_1_ID,
      customer_id: CUSTOMER_A_ID,
      trigger_interaction_id: INT_INBOUND_CUST_1,
      started_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 300000).toISOString(),
      state: 'OPEN',
    });
  assert(Boolean(srInsertErr), 'Test 21a: Service Role direct INSERT is denied by table ACL (42501)');

  const { error: srUpdateErr } = await adminClient
    .from('response_sla_windows')
    .update({ state: 'CANCELLED' })
    .eq('id', win1.id);
  assert(Boolean(srUpdateErr), 'Test 21b: Service Role direct UPDATE is denied by table ACL (42501)');

  const { error: srDeleteErr } = await adminClient
    .from('response_sla_windows')
    .delete()
    .eq('id', win1.id);
  assert(Boolean(srDeleteErr), 'Test 21c: Service Role direct DELETE is denied by table ACL (42501)');

  // ---------------------------------------------------------------------------
  // Test 22: P0 — Recoverable AI Claim Lease & Reclaim
  // ---------------------------------------------------------------------------
  const reclaimWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_RECLAIM_ID,
    triggerInteractionId: INT_RECLAIM_TRIGGER,
  });

  // Step A: Worker 1 claims window
  const worker1Claim = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: reclaimWin.id,
  });
  assert(worker1Claim.claimed === true, 'Test 22a: Worker 1 initial claim succeeds');

  // Step B: Active claim -> Worker 2 is denied with ALREADY_CLAIMED
  const worker2ActiveAttempt = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: reclaimWin.id,
  });
  assert(worker2ActiveAttempt.claimed === false, 'Test 22b: Active claim denies Worker 2');
  assert(worker2ActiveAttempt.decision === 'ALREADY_CLAIMED', 'Test 22b: Active claim decision is ALREADY_CLAIMED');

  // Step C: Simulate lease expiration (e.g. worker 1 crashed) by setting expired lease in past
  executeRawSql(`
    UPDATE public.response_sla_windows
    SET ai_claimed_at = now() - interval '3 minutes',
        ai_claim_expires_at = now() - interval '1 minute'
    WHERE id = '${reclaimWin.id}';
  `);

  // Step D: Expired claim -> Worker 2 can atomically RECLAIM
  const worker2Reclaim = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: reclaimWin.id,
  });
  assert(worker2Reclaim.claimed === true, 'Test 22c: Worker 2 successfully reclaims expired lease');
  assert(worker2Reclaim.decision === 'RECLAIMED', 'Test 22c: Reclaim decision is RECLAIMED');
  assert(worker2Reclaim.claimId !== worker1Claim.claimId, 'Test 22c: Reclaim issues new unique claimId');

  const reclaimExpireMs = new Date(worker2Reclaim.claimExpiresAt!).getTime();
  assert(reclaimExpireMs > Date.now(), 'Test 22c: Reclaimed window has active refreshed lease');

  // Step E: Verify audit log for RECLAIMED
  const { data: reclaimAudits } = await adminClient
    .from('audit_logs')
    .select('*')
    .eq('action', 'RESPONSE_SLA_AI_CLAIM')
    .eq('resource_id', reclaimWin.id)
    .order('created_at', { ascending: false });
  assert(reclaimAudits?.[0]?.metadata?.decision === 'RECLAIMED', 'Test 22d: Audit log records decision: RECLAIMED');
  assert(reclaimAudits?.[0]?.metadata?.previous_claim_id === worker1Claim.claimId, 'Test 22d: Audit log tracks previous_claim_id');

  // ---------------------------------------------------------------------------
  // Test 23: P0 — Concurrent Reclaim: Only 1 worker succeeds when lease expires
  // ---------------------------------------------------------------------------
  const concReclaimWin = await openResponseSlaWindow({
    companyId: COMPANY_A_ID,
    conversationId: CONVO_CONC_RECLAIM_ID,
    triggerInteractionId: INT_CONC_RECLAIM_TRIGGER,
  });
  await claimResponseSlaForAi({ companyId: COMPANY_A_ID, windowId: concReclaimWin.id });

  // Expire the lease
  executeRawSql(`
    UPDATE public.response_sla_windows
    SET ai_claimed_at = now() - interval '3 minutes',
        ai_claim_expires_at = now() - interval '1 minute'
    WHERE id = '${concReclaimWin.id}';
  `);

  // Two workers race to reclaim
  const [reclaimA, reclaimB] = await Promise.all([
    claimResponseSlaForAi({ companyId: COMPANY_A_ID, windowId: concReclaimWin.id }),
    claimResponseSlaForAi({ companyId: COMPANY_A_ID, windowId: concReclaimWin.id }),
  ]);
  const reclaimSuccessCount = (reclaimA.claimed ? 1 : 0) + (reclaimB.claimed ? 1 : 0);
  assert(reclaimSuccessCount === 1, 'Test 23: Exactly one concurrent reclaim succeeds');
  const losingReclaim = reclaimA.claimed ? reclaimB : reclaimA;
  assert(losingReclaim.decision === 'ALREADY_CLAIMED', 'Test 23: Losing concurrent reclaimer gets ALREADY_CLAIMED');

  // ---------------------------------------------------------------------------
  // Test 24: P1 — State integrity CHECK constraints enforced
  // ---------------------------------------------------------------------------
  // 24a: SALE_RESPONDED without sale_response_interaction_id must fail CHECK
  let chkSaleErr = false;
  try {
    executeRawSql(`
      INSERT INTO public.response_sla_windows (
        company_id, conversation_id, customer_id, trigger_interaction_id,
        started_at, deadline_at, state, resolved_at, sale_response_interaction_id
      ) VALUES (
        '${COMPANY_A_ID}', '${CONVO_1_ID}', '${CUSTOMER_A_ID}', '${INT_INBOUND_CUST_1}',
        now(), now() + interval '5 minutes', 'SALE_RESPONDED', now(), NULL
      );
    `);
  } catch {
    chkSaleErr = true;
  }
  assert(chkSaleErr, 'Test 24a: SALE_RESPONDED without sale_response_interaction_id rejected by CHECK constraint');

  // 24b: AI_RESPONDED without ai_response_interaction_id must fail CHECK
  let chkAiErr = false;
  try {
    executeRawSql(`
      INSERT INTO public.response_sla_windows (
        company_id, conversation_id, customer_id, trigger_interaction_id,
        started_at, deadline_at, state, resolved_at, ai_response_interaction_id
      ) VALUES (
        '${COMPANY_A_ID}', '${CONVO_1_ID}', '${CUSTOMER_A_ID}', '${INT_INBOUND_CUST_1}',
        now(), now() + interval '5 minutes', 'AI_RESPONDED', now(), NULL
      );
    `);
  } catch {
    chkAiErr = true;
  }
  assert(chkAiErr, 'Test 24b: AI_RESPONDED without ai_response_interaction_id rejected by CHECK constraint');

  // 24c: OPEN with resolved_at != NULL must fail CHECK
  let chkOpenErr = false;
  try {
    executeRawSql(`
      INSERT INTO public.response_sla_windows (
        company_id, conversation_id, customer_id, trigger_interaction_id,
        started_at, deadline_at, state, resolved_at
      ) VALUES (
        '${COMPANY_A_ID}', '${CONVO_1_ID}', '${CUSTOMER_A_ID}', '${INT_INBOUND_CUST_1}',
        now(), now() + interval '5 minutes', 'OPEN', now()
      );
    `);
  } catch {
    chkOpenErr = true;
  }
  assert(chkOpenErr, 'Test 24c: OPEN window with resolved_at != NULL rejected by CHECK constraint');

  // 24d: SALE_RESPONDED with both sale and ai response IDs must fail CHECK
  let chkSaleBothErr = false;
  try {
    executeRawSql(`
      INSERT INTO public.response_sla_windows (
        company_id, conversation_id, customer_id, trigger_interaction_id,
        started_at, deadline_at, state, resolved_at, sale_response_interaction_id, ai_response_interaction_id
      ) VALUES (
        '${COMPANY_A_ID}', '${CONVO_1_ID}', '${CUSTOMER_A_ID}', '${INT_INBOUND_CUST_1}',
        now(), now() + interval '5 minutes', 'SALE_RESPONDED', now(), '${INT_OUTBOUND_SALE_1}', '${INT_OUTBOUND_AI}'
      );
    `);
  } catch {
    chkSaleBothErr = true;
  }
  assert(chkSaleBothErr, 'Test 24d: SALE_RESPONDED with both sale and ai response IDs rejected by CHECK constraint');

  // 24e: AI_RESPONDED with both ai and sale response IDs must fail CHECK
  let chkAiBothErr = false;
  try {
    executeRawSql(`
      INSERT INTO public.response_sla_windows (
        company_id, conversation_id, customer_id, trigger_interaction_id,
        started_at, deadline_at, state, resolved_at, sale_response_interaction_id, ai_response_interaction_id
      ) VALUES (
        '${COMPANY_A_ID}', '${CONVO_1_ID}', '${CUSTOMER_A_ID}', '${INT_INBOUND_CUST_1}',
        now(), now() + interval '5 minutes', 'AI_RESPONDED', now(), '${INT_OUTBOUND_SALE_1}', '${INT_OUTBOUND_AI}'
      );
    `);
  } catch {
    chkAiBothErr = true;
  }
  assert(chkAiBothErr, 'Test 24e: AI_RESPONDED with both ai and sale response IDs rejected by CHECK constraint');

  // 24f: CANCELLED with sale response ID must fail CHECK
  let chkCancelledSaleErr = false;
  try {
    executeRawSql(`
      INSERT INTO public.response_sla_windows (
        company_id, conversation_id, customer_id, trigger_interaction_id,
        started_at, deadline_at, state, resolved_at, sale_response_interaction_id
      ) VALUES (
        '${COMPANY_A_ID}', '${CONVO_1_ID}', '${CUSTOMER_A_ID}', '${INT_INBOUND_CUST_1}',
        now(), now() + interval '5 minutes', 'CANCELLED', now(), '${INT_OUTBOUND_SALE_1}'
      );
    `);
  } catch {
    chkCancelledSaleErr = true;
  }
  assert(chkCancelledSaleErr, 'Test 24f: CANCELLED with sale response ID rejected by CHECK constraint');

  // 24g: CANCELLED with AI response ID must fail CHECK
  let chkCancelledAiErr = false;
  try {
    executeRawSql(`
      INSERT INTO public.response_sla_windows (
        company_id, conversation_id, customer_id, trigger_interaction_id,
        started_at, deadline_at, state, resolved_at, ai_response_interaction_id
      ) VALUES (
        '${COMPANY_A_ID}', '${CONVO_1_ID}', '${CUSTOMER_A_ID}', '${INT_INBOUND_CUST_1}',
        now(), now() + interval '5 minutes', 'CANCELLED', now(), '${INT_OUTBOUND_AI}'
      );
    `);
  } catch {
    chkCancelledAiErr = true;
  }
  assert(chkCancelledAiErr, 'Test 24g: CANCELLED with AI response ID rejected by CHECK constraint');

  // 24h: Conversation deletion is RESTRICTed when SLA window exists
  let delConvoErr = false;
  try {
    executeRawSql(`
      DELETE FROM public.conversations
      WHERE id = '${CONVO_1_ID}';
    `);
  } catch {
    delConvoErr = true;
  }
  assert(delConvoErr, 'Test 24h: Conversation deletion rejected by ON DELETE RESTRICT on SLA window');

  // 24i: Trigger interaction deletion is RESTRICTed when SLA window exists
  let delIntErr = false;
  try {
    executeRawSql(`
      DELETE FROM public.interactions
      WHERE id = '${INT_INBOUND_CUST_1}';
    `);
  } catch {
    delIntErr = true;
  }
  assert(delIntErr, 'Test 24i: Trigger interaction deletion rejected by ON DELETE RESTRICT on SLA window');

  console.log('\n==================================================');
  console.log(`RESPONSE SLA DB TESTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
