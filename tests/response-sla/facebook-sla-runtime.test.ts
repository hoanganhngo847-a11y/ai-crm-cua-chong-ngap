import 'server-only';

import assert from 'assert';
import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { claimResponseSlaForAi } from '../../features/automation/response-sla/services/response-sla-store';
import { fetchCompanyAnalyticsOverview } from '../../features/analytics/services/analytics-store';
import { elevateClientToAal2 } from '../e2e/test-mfa-helpers';

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

interface OutboxRow {
  company_id: string;
  request_id: string;
  conversation_id: string;
  interaction_id: string;
  actor_id: string;
  content: string;
  status: string;
  provider_mid: string | null;
  care_delivery_id: string | null;
  created_at: string;
  sent_at: string | null;
}

function queryRawJson<T = OutboxRow[]>(sql: string): T {
  const cleanSql = sql.trim().replace(/;+$/, '');
  const wrapped = `SELECT json_agg(t) FROM (${cleanSql}) t;`;
  const result = execSync(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -v ON_ERROR_STOP=1 -U postgres -d postgres -c "${wrapped.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  );
  const trimmed = result.trim();
  if (!trimmed || trimmed === '') return [] as unknown as T;
  return JSON.parse(trimmed) as T;
}

// Dedicated UUIDs for Facebook SLA Runtime Test
const COMPANY_A_ID = 'f1000000-0000-0000-0000-000000000001';
const COMPANY_B_ID = 'f1000000-0000-0000-0000-000000000002';
const SALE_A_USER_ID = 'f2000000-0000-0000-0000-000000000001';
const BOSS_A_USER_ID = 'f2000000-0000-0000-0000-000000000002';
const SALE_B_USER_ID = 'f2000000-0000-0000-0000-000000000003';
const SALE_A_EMAIL = 'sale_fb_sla_a@test.company.com';
const BOSS_A_EMAIL = 'boss_fb_sla_a@test.company.com';
const SALE_B_EMAIL = 'sale_fb_sla_b@test.company.com';
const PASSWORD = 'TestPassword123!@#';

let saleClient: SupabaseClient;
let bossClient: SupabaseClient;
let saleBClient: SupabaseClient;

async function setupFixtures() {
  console.log('--- Setting up Facebook SLA Runtime Fixtures ---');

  // Upsert Company A and Company B
  await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'Facebook SLA Test Co A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'Facebook SLA Test Co B', status: 'ACTIVE' },
  ]);

  // Ensure Sale User A
  const { data: saleAAuth } = await adminClient.auth.admin.createUser({
    email: SALE_A_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  }).catch(async () => {
    const { data: users } = await adminClient.auth.admin.listUsers();
    return { data: { user: users.users.find((u) => u.email === SALE_A_EMAIL) } };
  });

  const saleAId = saleAAuth?.user?.id || SALE_A_USER_ID;
  await adminClient.from('user_profiles').upsert({
    id: saleAId,
    full_name: 'Sale Facebook SLA A',
    status: 'ACTIVE',
  });
  await adminClient.from('company_members').upsert({
    company_id: COMPANY_A_ID,
    user_id: saleAId,
    role: 'SALE',
    status: 'ACTIVE',
  });

  // Ensure Boss User A
  const { data: bossAAuth } = await adminClient.auth.admin.createUser({
    email: BOSS_A_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  }).catch(async () => {
    const { data: users } = await adminClient.auth.admin.listUsers();
    return { data: { user: users.users.find((u) => u.email === BOSS_A_EMAIL) } };
  });

  const bossAId = bossAAuth?.user?.id || BOSS_A_USER_ID;
  await adminClient.from('user_profiles').upsert({
    id: bossAId,
    full_name: 'Boss Facebook SLA A',
    status: 'ACTIVE',
  });
  await adminClient.from('company_members').upsert({
    company_id: COMPANY_A_ID,
    user_id: bossAId,
    role: 'BOSS_ADMIN',
    status: 'ACTIVE',
  });

  // Ensure Sale User B (Company B)
  const { data: saleBAuth } = await adminClient.auth.admin.createUser({
    email: SALE_B_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  }).catch(async () => {
    const { data: users } = await adminClient.auth.admin.listUsers();
    return { data: { user: users.users.find((u) => u.email === SALE_B_EMAIL) } };
  });

  const saleBId = saleBAuth?.user?.id || SALE_B_USER_ID;
  await adminClient.from('user_profiles').upsert({
    id: saleBId,
    full_name: 'Sale Facebook SLA B',
    status: 'ACTIVE',
  });
  await adminClient.from('company_members').upsert({
    company_id: COMPANY_B_ID,
    user_id: saleBId,
    role: 'SALE',
    status: 'ACTIVE',
  });

  // Log in Sale client A
  saleClient = createAnonClient();
  const { error: saleLoginErr } = await saleClient.auth.signInWithPassword({
    email: SALE_A_EMAIL,
    password: PASSWORD,
  });
  if (saleLoginErr) throw new Error(`Sale A login failed: ${saleLoginErr.message}`);

  // Log in Boss client A & elevate to AAL2
  bossClient = createAnonClient();
  const { error: bossLoginErr } = await bossClient.auth.signInWithPassword({
    email: BOSS_A_EMAIL,
    password: PASSWORD,
  });
  if (bossLoginErr) throw new Error(`Boss A login failed: ${bossLoginErr.message}`);
  await elevateClientToAal2(bossClient, 'Boss FB SLA A TOTP');

  // Log in Sale client B
  saleBClient = createAnonClient();
  const { error: saleBLoginErr } = await saleBClient.auth.signInWithPassword({
    email: SALE_B_EMAIL,
    password: PASSWORD,
  });
  if (saleBLoginErr) throw new Error(`Sale B login failed: ${saleBLoginErr.message}`);

  // Clean test companies SLA windows and interactions
  executeRawSql(`
    DELETE FROM public.response_sla_windows WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM private.han_outbox WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
    DELETE FROM private.han_intake_events WHERE company_id IN ('${COMPANY_A_ID}', '${COMPANY_B_ID}');
  `);
  await adminClient.from('interactions').delete().in('company_id', [COMPANY_A_ID, COMPANY_B_ID]);
  await adminClient.from('conversations').delete().in('company_id', [COMPANY_A_ID, COMPANY_B_ID]);
  await adminClient.from('identities').delete().in('company_id', [COMPANY_A_ID, COMPANY_B_ID]);
  await adminClient.from('customers').delete().in('company_id', [COMPANY_A_ID, COMPANY_B_ID]);
}

async function runTests() {
  console.log('================================================================');
  console.log('RUNNING FACEBOOK SLA RUNTIME REAL DB INTEGRATION SUITE');
  console.log('================================================================');

  await setupFixtures();

  const { data: saleUserData } = await saleClient.auth.getUser();
  const saleUserId = saleUserData.user!.id;

  const extConvo1 = `123456789:${Date.now()}`;
  const extConvo2 = `987654321:${Date.now()}`;

  // ============================================================================
  // TEST 1: Facebook Inbound via han_ingest Atomically Opens 5-Minute SLA Window
  // ============================================================================
  console.log('\n--- Test 1: Inbound via han_ingest opens SLA window ---');
  const ingestKey1 = `msg_key_${Date.now()}_1`;
  const { data: ingestRes1, error: ingestErr1 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo1,
    p_key: ingestKey1,
    p_name: 'Nguyễn Văn A',
    p_phone: '+84901234567',
    p_content: 'Chào shop, tôi muốn hỏi giá cửa chống ngập 3m',
    p_safe: 'Chào shop, tôi muốn hỏi giá cửa chống ngập 3m',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: { source: 'fb_ad' },
  });

  assert(!ingestErr1, `Test 1: han_ingest succeeded: ${ingestErr1?.message}`);
  assert(ingestRes1?.interaction_id, 'Test 1: interaction_id returned');

  const interactionId1 = ingestRes1.interaction_id as string;
  const { data: int1 } = await adminClient
    .from('interactions')
    .select('conversation_id')
    .eq('id', interactionId1)
    .single();

  assert(int1?.conversation_id, 'Test 1: conversation exists for interaction');
  const convoId1 = int1.conversation_id as string;

  const { data: windows1, error: winErr1 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId1);

  assert(!winErr1, `Test 1: Query response_sla_windows succeeded: ${winErr1?.message}`);
  assert(windows1 && windows1.length === 1, `Test 1: Exactly 1 window exists (found: ${windows1?.length})`);

  const win1 = windows1[0];
  assert(win1.state === 'OPEN', `Test 1: Window state is OPEN (got: ${win1.state})`);
  assert(win1.company_id === COMPANY_A_ID, 'Test 1: Window bound to Company A');
  assert(win1.trigger_interaction_id === interactionId1, 'Test 1: trigger_interaction_id matches ingest interaction');
  assert(win1.sale_response_interaction_id === null, 'Test 1: sale_response_interaction_id is null');

  const startedAtMs = new Date(win1.started_at).getTime();
  const deadlineAtMs = new Date(win1.deadline_at).getTime();
  const diffSec = Math.round((deadlineAtMs - startedAtMs) / 1000);
  assert(diffSec === 300, `Test 1: Deadline is exactly +300s (5m) (got: ${diffSec}s)`);
  console.log('[PASS] Test 1: Facebook inbound atomically opens 5-minute Response SLA window');

  // ============================================================================
  // TEST 2: Multiple Inbound Messages Before Sale Reply (Idempotent Window)
  // ============================================================================
  console.log('\n--- Test 2: Multiple Inbounds Before Sale Reply (Idempotent Window) ---');
  const ingestKey2 = `msg_key_${Date.now()}_2`;
  const { data: ingestRes2, error: ingestErr2 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo1,
    p_key: ingestKey2,
    p_name: 'Nguyễn Văn A',
    p_phone: '+84901234567',
    p_content: 'Shop ơi có ai trực không?',
    p_safe: 'Shop ơi có ai trực không?',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });

  assert(!ingestErr2, `Test 2: Second han_ingest succeeded: ${ingestErr2?.message}`);
  assert(ingestRes2?.interaction_id !== interactionId1, 'Test 2: Second interaction created');

  const { data: windows2 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId1);

  assert(windows2 && windows2.length === 1, `Test 2: Still exactly 1 window for conversation (found: ${windows2?.length})`);
  assert(windows2[0].state === 'OPEN', 'Test 2: Window remains OPEN');
  assert(windows2[0].deadline_at === win1.deadline_at, 'Test 2: Deadline is unchanged (not reset by subsequent message)');
  console.log('[PASS] Test 2: Additional inbound messages keep existing OPEN window without deadline reset');

  // ============================================================================
  // TEST 3: Replay Inbound Event with Same Idempotency Key -> No-Op
  // ============================================================================
  console.log('\n--- Test 3: Replay duplicate inbound event ---');
  const { data: replayRes, error: replayErr } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo1,
    p_key: ingestKey2,
    p_name: 'Nguyễn Văn A',
    p_phone: '+84901234567',
    p_content: 'Shop ơi có ai trực không?',
    p_safe: 'Shop ơi có ai trực không?',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });

  assert(!replayErr, `Test 3: Replay han_ingest succeeded idempotently: ${replayErr?.message}`);
  assert(replayRes?.interaction_id === ingestRes2.interaction_id, 'Test 3: Returns existing interaction ID');

  const { data: windows3 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId1);

  assert(windows3 && windows3.length === 1, `Test 3: No new window created on replay (count: ${windows3?.length})`);
  console.log('[PASS] Test 3: Replaying exact duplicate event is idempotent (no duplicate window)');

  // ============================================================================
  // TEST 4: Concurrent Inbound Messages on Clean Conversation -> Single Window
  // ============================================================================
  console.log('\n--- Test 4: Concurrent Inbound Messages on Clean Conversation ---');
  const concurrentPromises = Array.from({ length: 5 }, (_, i) =>
    adminClient.rpc('han_ingest', {
      p_company: COMPANY_A_ID,
      p_channel: 'FACEBOOK',
      p_external: extConvo2,
      p_key: `conc_key_${Date.now()}_${i}`,
      p_name: 'Khách Hàng B',
      p_phone: '+84912345678',
      p_content: `Tin nhắn đồng thời ${i + 1}`,
      p_safe: `Tin nhắn đồng thời ${i + 1}`,
      p_safe_status: 'SUCCEEDED',
      p_occurred: new Date(Date.now() - 5000).toISOString(),
      p_payload: {},
    })
  );

  const concurrentResults = await Promise.all(concurrentPromises);
  for (const r of concurrentResults) {
    assert(!r.error, `Test 4: Concurrent ingest call succeeded: ${r.error?.message}`);
  }

  const { data: int2 } = await adminClient
    .from('interactions')
    .select('conversation_id')
    .eq('id', concurrentResults[0].data.interaction_id)
    .single();

  const convoId2 = int2!.conversation_id as string;
  const { data: windows4 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId2);

  assert(windows4 && windows4.length === 1, `Test 4: Exactly 1 OPEN window created despite concurrency (found: ${windows4?.length})`);
  assert(windows4[0].state === 'OPEN', 'Test 4: Window is OPEN');
  console.log('[PASS] Test 4: Concurrent inbound messages result in strictly 1 OPEN SLA window');

  // ============================================================================
  // TEST 9: P0 — Prepare does NOT resolve SLA window
  // ============================================================================
  console.log('\n--- Test 9: Prepare does NOT resolve SLA window ---');
  const nowTs = Date.now();
  const extConvo9 = `123456789:${nowTs}09`;
  const { data: ingestRes9, error: ingestErr9 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo9,
    p_key: `ingest_9_${nowTs}`,
    p_name: 'Khách Test 9',
    p_phone: '+84909000009',
    p_content: 'Hỏi giá cửa 9',
    p_safe: 'Hỏi giá cửa 9',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr9, `Test 9: han_ingest succeeded: ${ingestErr9?.message}`);
  const intId9 = ingestRes9.interaction_id;
  const { data: intRow9 } = await adminClient.from('interactions').select('conversation_id').eq('id', intId9).single();
  const convoId9 = intRow9!.conversation_id;

  const requestId9 = crypto.randomUUID();
  const { data: prepRes9, error: prepErr9 } = await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId9,
    p_actor: saleUserId,
    p_request: requestId9,
    p_content: 'Dạ giá cửa loại 9 là 10 triệu ạ',
    p_safe: 'Dạ giá cửa loại 9 là 10 triệu ạ',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });
  assert(!prepErr9, `Test 9: han_prepare_send succeeded: ${prepErr9?.message}`);
  assert(prepRes9?.claimed === true, 'Test 9: Outbox claimed');
  assert(prepRes9?.status === 'SENDING', 'Test 9: Outbox status is SENDING');

  // Check private.han_outbox
  const outboxRows9 = queryRawJson(
    `SELECT * FROM private.han_outbox WHERE company_id = '${COMPANY_A_ID}' AND request_id = '${requestId9}';`
  );
  assert(outboxRows9 && outboxRows9[0]?.status === 'SENDING', 'Test 9: outbox.status is SENDING');

  // Check SLA window: MUST REMAIN OPEN, resolved_at IS NULL, sale_response_interaction_id IS NULL
  const { data: winRows9 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId9);
  assert(winRows9 && winRows9.length === 1, 'Test 9: 1 window exists');
  assert(winRows9[0].state === 'OPEN', `Test 9: SLA state MUST BE OPEN (got: ${winRows9[0].state})`);
  assert(winRows9[0].sale_response_interaction_id === null, 'Test 9: sale_response_interaction_id IS NULL');
  assert(winRows9[0].resolved_at === null, 'Test 9: resolved_at IS NULL');
  console.log('[PASS] Test 9: han_prepare_send creates SENDING outbox and leaves SLA OPEN');

  // ============================================================================
  // TEST 10: FAILED keeps SLA OPEN
  // ============================================================================
  console.log('\n--- Test 10: FAILED keeps SLA OPEN ---');
  const { error: finishErr10 } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId9,
    p_status: 'FAILED',
    p_mid: null,
  });
  assert(!finishErr10, `Test 10: han_finish_send FAILED succeeded: ${finishErr10?.message}`);

  const outboxRows10 = queryRawJson(
    `SELECT * FROM private.han_outbox WHERE company_id = '${COMPANY_A_ID}' AND request_id = '${requestId9}';`
  );
  assert(outboxRows10 && outboxRows10[0]?.status === 'FAILED', 'Test 10: outbox.status is FAILED');

  const { data: winRows10 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId9);
  assert(winRows10 && winRows10[0].state === 'OPEN', 'Test 10: SLA state MUST REMAIN OPEN after FAILED send');
  assert(winRows10[0].sale_response_interaction_id === null, 'Test 10: sale_response_interaction_id is null');
  assert(winRows10[0].resolved_at === null, 'Test 10: resolved_at is null');
  console.log('[PASS] Test 10: han_finish_send with FAILED updates outbox but keeps SLA OPEN');

  // ============================================================================
  // TEST 11: UNKNOWN keeps SLA OPEN
  // ============================================================================
  console.log('\n--- Test 11: UNKNOWN keeps SLA OPEN ---');
  const extConvo11 = `123456789:${nowTs}11`;
  const { data: ingestRes11, error: ingestErr11 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo11,
    p_key: `ingest_11_${nowTs}`,
    p_name: 'Khách Test 11',
    p_phone: '+84909000011',
    p_content: 'Hỏi giá cửa 11',
    p_safe: 'Hỏi giá cửa 11',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr11, `Test 11: han_ingest succeeded: ${ingestErr11?.message}`);
  const { data: intRow11 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes11.interaction_id).single();
  const convoId11 = intRow11!.conversation_id;

  const requestId11 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId11,
    p_actor: saleUserId,
    p_request: requestId11,
    p_content: 'Tin nhắn test 11',
    p_safe: 'Tin nhắn test 11',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const { error: finishErr11 } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId11,
    p_status: 'UNKNOWN',
    p_mid: null,
  });
  assert(!finishErr11, `Test 11: han_finish_send UNKNOWN succeeded: ${finishErr11?.message}`);

  const { data: winRows11 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId11);
  assert(winRows11 && winRows11[0].state === 'OPEN', 'Test 11: SLA state MUST REMAIN OPEN after UNKNOWN send');
  console.log('[PASS] Test 11: han_finish_send with UNKNOWN keeps SLA OPEN');

  // ============================================================================
  // TEST 12: FAILED send does not block AI claim when deadline is due
  // ============================================================================
  console.log('\n--- Test 12: FAILED send does not block AI claim ---');
  // Make deadline due for conversation 9 (which had a FAILED send)
  executeRawSql(`UPDATE public.response_sla_windows SET started_at = now() - interval '6 minutes', deadline_at = now() - interval '1 minute' WHERE id = '${winRows9[0].id}';`);

  const claimRes12 = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: winRows9[0].id,
  });

  assert(claimRes12.claimed === true, `Test 12: AI claimed successfully despite previous FAILED send (decision: ${claimRes12.decision})`);
  assert(claimRes12.decision === 'ALLOW_AI_REPLY', `Test 12: Decision is ALLOW_AI_REPLY (got: ${claimRes12.decision})`);
  assert((claimRes12.decision as string) !== 'SALE_ALREADY_RESPONDED', 'Test 12: FAILED send must NOT block AI claim as SALE_ALREADY_RESPONDED');
  console.log('[PASS] Test 12: FAILED send does not count as Sale response and does not block AI claim');

  // ============================================================================
  // TEST 13: SENT resolves SLA window
  // ============================================================================
  console.log('\n--- Test 13: SENT resolves SLA window ---');
  const extConvo13 = `123456789:${nowTs}13`;
  const { data: ingestRes13, error: ingestErr13 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo13,
    p_key: `ingest_13_${nowTs}`,
    p_name: 'Khách Test 13',
    p_phone: '+84909000013',
    p_content: 'Hỏi giá cửa 13',
    p_safe: 'Hỏi giá cửa 13',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr13, `Test 13: han_ingest succeeded: ${ingestErr13?.message}`);
  const { data: intRow13 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes13.interaction_id).single();
  const convoId13 = intRow13!.conversation_id;

  const requestId13 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId13,
    p_actor: saleUserId,
    p_request: requestId13,
    p_content: 'Chào anh, báo giá cửa 13 là 15 triệu',
    p_safe: 'Chào anh, báo giá cửa 13 là 15 triệu',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  // Verify SLA is still OPEN before provider confirmation
  const { data: winBefore13 } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId13).single();
  assert(winBefore13.state === 'OPEN', 'Test 13: SLA is OPEN before SENT confirmation');

  const providerMid13 = `m_mid_test_13_${nowTs}`;
  const { error: finishErr13 } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId13,
    p_status: 'SENT',
    p_mid: providerMid13,
  });
  assert(!finishErr13, `Test 13: han_finish_send SENT succeeded: ${finishErr13?.message}`);

  // Assert outbox = SENT, provider_mid set
  const outboxRows13 = queryRawJson(
    `SELECT * FROM private.han_outbox WHERE company_id = '${COMPANY_A_ID}' AND request_id = '${requestId13}';`
  );
  assert(outboxRows13 && outboxRows13[0]?.status === 'SENT', 'Test 13: outbox is SENT');
  assert(outboxRows13[0]?.provider_mid === providerMid13, 'Test 13: provider_mid is saved');

  // Assert interaction external_ref set
  const { data: intRows13 } = await adminClient
    .from('interactions')
    .select('*')
    .eq('id', outboxRows13[0].interaction_id);
  assert(intRows13 && intRows13[0].external_ref?.includes(providerMid13), 'Test 13: interaction.external_ref updated with mid');

  // Assert SLA = SALE_RESPONDED, sale_response_interaction_id linked, resolved_at NOT NULL
  const { data: winAfter13 } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId13).single();
  assert(winAfter13.state === 'SALE_RESPONDED', `Test 13: SLA window transitioned to SALE_RESPONDED (got: ${winAfter13.state})`);
  assert(winAfter13.sale_response_interaction_id === outboxRows13[0].interaction_id, 'Test 13: sale_response_interaction_id matches outbox interaction');
  assert(winAfter13.resolved_at !== null, 'Test 13: resolved_at timestamp is set');
  console.log('[PASS] Test 13: han_finish_send with provider-confirmed SENT resolves SLA to SALE_RESPONDED');

  // ============================================================================
  // TEST 14: SENT blocks later AI claim
  // ============================================================================
  console.log('\n--- Test 14: SENT blocks later AI claim ---');
  // Attempt AI claim on conversation 13 which is now SALE_RESPONDED
  const claimRes14 = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: winAfter13.id,
  });

  assert(claimRes14.claimed === false, 'Test 14: Claim denied because Sale responded');
  assert(claimRes14.decision === 'SALE_ALREADY_RESPONDED', `Test 14: Decision is SALE_ALREADY_RESPONDED (got: ${claimRes14.decision})`);
  console.log('[PASS] Test 14: Provider-confirmed SENT blocks later AI claim with SALE_ALREADY_RESPONDED');

  // ============================================================================
  // TEST 15: SENDING does not count as Sale response
  // ============================================================================
  console.log('\n--- Test 15: SENDING does not count as Sale response ---');
  const extConvo15 = `123456789:${nowTs}15`;
  const { data: ingestRes15, error: ingestErr15 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo15,
    p_key: `ingest_15_${nowTs}`,
    p_name: 'Khách Test 15',
    p_phone: '+84909000015',
    p_content: 'Hỏi giá cửa 15',
    p_safe: 'Hỏi giá cửa 15',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr15, `Test 15: han_ingest succeeded: ${ingestErr15?.message}`);
  const { data: intRow15 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes15.interaction_id).single();
  const convoId15 = intRow15!.conversation_id;

  const requestId15 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId15,
    p_actor: saleUserId,
    p_request: requestId15,
    p_content: 'Báo giá 15 đang gửi...',
    p_safe: 'Báo giá 15 đang gửi...',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const { data: win15 } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId15).single();
  // Make deadline due while outbox is still SENDING
  executeRawSql(`UPDATE public.response_sla_windows SET started_at = now() - interval '6 minutes', deadline_at = now() - interval '1 minute' WHERE id = '${win15.id}';`);

  // AI claim runs while message is in SENDING
  const claimRes15 = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: win15.id,
  });

  assert(claimRes15.claimed === true, `Test 15: AI claim allowed while message is SENDING (decision: ${claimRes15.decision})`);
  assert(claimRes15.decision === 'ALLOW_AI_REPLY', `Test 15: Decision is ALLOW_AI_REPLY (got: ${claimRes15.decision})`);
  assert((claimRes15.decision as string) !== 'SALE_ALREADY_RESPONDED', 'Test 15: SENDING must NOT block AI claim as SALE_ALREADY_RESPONDED');
  console.log('[PASS] Test 15: Message in SENDING status does NOT block AI claim');

  // ============================================================================
  // TEST 16: Tenant isolation
  // ============================================================================
  console.log('\n--- Test 16: Tenant isolation ---');
  // Attempt 16A: Company B calls han_finish_send on Company A request
  const { error: crossFinishErr } = await saleBClient.rpc('han_finish_send', {
    p_company: COMPANY_B_ID,
    p_request: requestId15, // belongs to Company A
    p_status: 'SENT',
    p_mid: 'mid_cross_tenant_fail',
  });
  assert(crossFinishErr !== null, 'Test 16: Cross-tenant finish_send must fail');
  assert(crossFinishErr.message.includes('INVALID_RESULT'), `Test 16: Expected INVALID_RESULT, got: ${crossFinishErr.message}`);

  // Verify Company A outbox is STILL SENDING
  const checkOutbox16 = queryRawJson(
    `SELECT status FROM private.han_outbox WHERE company_id = '${COMPANY_A_ID}' AND request_id = '${requestId15}';`
  );
  assert(checkOutbox16 && checkOutbox16[0]?.status === 'SENDING', 'Test 16: Company A outbox status untouched');

  // Attempt 16B: Company B calls claimResponseSlaForAi on Company A window
  const crossClaimRes = await claimResponseSlaForAi({
    companyId: COMPANY_B_ID,
    windowId: win15.id, // belongs to Company A
  });
  assert(crossClaimRes.claimed === false, 'Test 16: Cross-tenant AI claim must be denied');
  assert(crossClaimRes.decision === 'WRONG_COMPANY', `Test 16: Expected WRONG_COMPANY, got: ${crossClaimRes.decision}`);

  // Verify Company A window is unchanged
  const { data: checkWin16 } = await saleClient.from('response_sla_windows').select('company_id, state').eq('id', win15.id).single();
  assert(checkWin16?.company_id === COMPANY_A_ID, 'Test 16: Company ID intact');
  console.log('[PASS] Test 16: Tenant isolation strictly enforced; zero cross-tenant state mutation');

  // ============================================================================
  // TEST 17: Atomic rollback
  // ============================================================================
  console.log('\n--- Test 17: Atomic rollback on failure during han_finish_send ---');
  const extConvo17 = `123456789:${nowTs}17`;
  const { data: ingestRes17, error: ingestErr17 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo17,
    p_key: `ingest_17_${nowTs}`,
    p_name: 'Khách Test 17',
    p_phone: '+84909000017',
    p_content: 'Hỏi giá cửa 17',
    p_safe: 'Hỏi giá cửa 17',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr17, `Test 17: han_ingest succeeded: ${ingestErr17?.message}`);
  const { data: intRow17 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes17.interaction_id).single();
  const convoId17 = intRow17!.conversation_id;

  const requestId17 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId17,
    p_actor: saleUserId,
    p_request: requestId17,
    p_content: 'Báo giá 17 cần rollback',
    p_safe: 'Báo giá 17 cần rollback',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const outboxBefore17 = queryRawJson(
    `SELECT interaction_id, status FROM private.han_outbox WHERE request_id = '${requestId17}';`
  );
  const prepInteractionId17 = outboxBefore17[0]!.interaction_id;

  // Induce a deterministic failure in SLA resolution during han_finish_send(SENT):
  // Temporarily corrupt interaction type to 'NOTE' so resolve_response_sla_on_sale_reply throws INVALID_INTERACTION_TYPE
  executeRawSql(`UPDATE public.interactions SET type = 'NOTE' WHERE id = '${prepInteractionId17}';`);

  // Call han_finish_send with SENT - should fail inside resolve_response_sla_on_sale_reply
  const { error: atomicRollbackErr } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId17,
    p_status: 'SENT',
    p_mid: 'mid_atomic_fail_17',
  });
  assert(atomicRollbackErr !== null, 'Test 17: han_finish_send failed due to SLA error');
  assert(
    atomicRollbackErr.message.includes('INVALID_INTERACTION_TYPE'),
    `Test 17: Expected INVALID_INTERACTION_TYPE error, got: ${atomicRollbackErr.message}`
  );

  // VERIFY REAL POSTGRES TRANSACTION ROLLBACK:
  // 1. outbox status must remain SENDING (NOT SENT!)
  const outboxAfter17 = queryRawJson(
    `SELECT status, provider_mid FROM private.han_outbox WHERE request_id = '${requestId17}';`
  );
  assert(outboxAfter17 && outboxAfter17[0]?.status === 'SENDING', `Test 17: Outbox rolled back to SENDING (got: ${outboxAfter17[0]?.status})`);
  assert(outboxAfter17[0]?.provider_mid === null, 'Test 17: provider_mid is null (rolled back)');

  // 2. interaction external_ref must remain NULL
  const { data: intAfter17 } = await adminClient
    .from('interactions')
    .select('external_ref')
    .eq('id', prepInteractionId17)
    .single();
  assert(intAfter17?.external_ref === null, 'Test 17: external_ref is null (rolled back)');

  // 3. SLA window must remain OPEN
  const { data: winAfter17 } = await saleClient
    .from('response_sla_windows')
    .select('state, sale_response_interaction_id, resolved_at')
    .eq('conversation_id', convoId17)
    .single();
  assert(winAfter17?.state === 'OPEN', `Test 17: SLA window state rolled back to OPEN (got: ${winAfter17?.state})`);
  assert(winAfter17?.sale_response_interaction_id === null, 'Test 17: sale_response_interaction_id is null');
  assert(winAfter17?.resolved_at === null, 'Test 17: resolved_at is null');

  // Revert type back to MESSAGE
  executeRawSql(`UPDATE public.interactions SET type = 'MESSAGE' WHERE id = '${prepInteractionId17}';`);
  console.log('[PASS] Test 17: Real Postgres atomic rollback verified; failure during SLA resolution reverts outbox and interaction');

  // ============================================================================
  // TEST 18: Race / ordering
  // ============================================================================
  console.log('\n--- Test 18: Race / ordering ---');
  // Race A: SENT committed first -> subsequent AI claim is denied
  const extConvo18a = `123456789:${nowTs}181`;
  const { data: ingestRes18a, error: ingestErr18a } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo18a,
    p_key: `ingest_18a_${nowTs}`,
    p_name: 'Khách Test 18A',
    p_phone: '+84909000018',
    p_content: 'Hỏi giá cửa 18A',
    p_safe: 'Hỏi giá cửa 18A',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr18a, `Test 18A: han_ingest succeeded: ${ingestErr18a?.message}`);
  const { data: intRow18a } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes18a.interaction_id).single();
  const convoId18a = intRow18a!.conversation_id;
  const requestId18a = crypto.randomUUID();

  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId18a,
    p_actor: saleUserId,
    p_request: requestId18a,
    p_content: 'Chào 18A',
    p_safe: 'Chào 18A',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId18a,
    p_status: 'SENT',
    p_mid: `mid_18a_${nowTs}`,
  });

  const { data: win18a } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId18a).single();
  const claimRes18a = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: win18a.id,
  });
  assert(claimRes18a.claimed === false, 'Test 18A: AI claim denied because SENT committed first');
  assert(claimRes18a.decision === 'SALE_ALREADY_RESPONDED', `Test 18A: Decision is SALE_ALREADY_RESPONDED (got: ${claimRes18a.decision})`);

  // Race B: AI claim committed first, THEN provider SENT arrives
  const extConvo18b = `123456789:${nowTs}182`;
  const { data: ingestRes18b, error: ingestErr18b } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo18b,
    p_key: `ingest_18b_${nowTs}`,
    p_name: 'Khách Test 18B',
    p_phone: '+84909000019',
    p_content: 'Hỏi giá cửa 18B',
    p_safe: 'Hỏi giá cửa 18B',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr18b, `Test 18B: han_ingest succeeded: ${ingestErr18b?.message}`);
  const { data: intRow18b } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes18b.interaction_id).single();
  const convoId18b = intRow18b!.conversation_id;
  const { data: win18b } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId18b).single();

  // Make deadline due and claim AI first
  executeRawSql(`UPDATE public.response_sla_windows SET started_at = now() - interval '6 minutes', deadline_at = now() - interval '1 minute' WHERE id = '${win18b.id}';`);
  const claimRes18b = await claimResponseSlaForAi({
    companyId: COMPANY_A_ID,
    windowId: win18b.id,
  });
  assert(claimRes18b.claimed === true, 'Test 18B: AI claim succeeds first');

  // Verify conversation is now in AI_HANDLING
  const { data: convoAfterClaim18b } = await adminClient.from('conversations').select('status').eq('id', convoId18b).single();
  assert(convoAfterClaim18b?.status === 'AI_HANDLING', 'Test 18B: Conversation is in AI_HANDLING');

  // Now Sale message arrives and completes with SENT:
  const requestId18b = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId18b,
    p_actor: saleUserId,
    p_request: requestId18b,
    p_content: 'Chào 18B từ Sale người thật',
    p_safe: 'Chào 18B từ Sale người thật',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const { error: finishErr18b } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId18b,
    p_status: 'SENT',
    p_mid: `mid_18b_${nowTs}`,
  });
  assert(!finishErr18b, `Test 18B: han_finish_send SENT succeeded: ${finishErr18b?.message}`);

  // Assert SLA window transitioned to SALE_RESPONDED
  const { data: winAfter18b } = await saleClient.from('response_sla_windows').select('state').eq('id', win18b.id).single();
  assert(winAfter18b?.state === 'SALE_RESPONDED', `Test 18B: SLA window resolved to SALE_RESPONDED (got: ${winAfter18b?.state})`);

  // Assert conversation status was reset from AI_HANDLING back to OPEN
  const { data: convoAfterSent18b } = await adminClient.from('conversations').select('status').eq('id', convoId18b).single();
  assert(convoAfterSent18b?.status === 'OPEN', `Test 18B: Conversation reset from AI_HANDLING back to OPEN (got: ${convoAfterSent18b?.status})`);
  console.log('[PASS] Test 18: Race and ordering semantics validated; AI_HANDLING gracefully resets to OPEN on confirmed Sale send');

  // ============================================================================
  // TEST 19: New Customer Inbound After Sale Reply Opens NEW SLA Window
  // ============================================================================
  console.log('\n--- Test 19: New customer message opens new SLA window ---');
  const ingestKey3 = `msg_key_${Date.now()}_3`;
  const { data: ingestRes3, error: ingestErr3 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo13,
    p_key: ingestKey3,
    p_name: 'Khách Test 13',
    p_phone: '+84909000013',
    p_content: 'Loại tự động có bảo hành bao lâu em?',
    p_safe: 'Loại tự động có bảo hành bao lâu em?',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });

  assert(!ingestErr3, `Test 19: New han_ingest succeeded: ${ingestErr3?.message}`);

  const { data: windows19 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId13)
    .order('created_at', { ascending: true });

  assert(windows19 && windows19.length === 2, `Test 19: Exactly 2 windows exist (found: ${windows19?.length})`);
  assert(windows19[0].state === 'SALE_RESPONDED', 'Test 19: 1st window remains SALE_RESPONDED');
  assert(windows19[1].state === 'OPEN', 'Test 19: 2nd window is OPEN');
  assert(windows19[1].trigger_interaction_id === ingestRes3.interaction_id, 'Test 19: 2nd window points to new interaction');
  console.log('[PASS] Test 19: New customer inbound after resolved window opens a new OPEN SLA window');

  // ============================================================================
  // TEST 20: Analytics Aggregates Real SLA Metrics
  // ============================================================================
  console.log('\n--- Test 20: Analytics Aggregates Real SLA Metrics ---');
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const overview = await fetchCompanyAnalyticsOverview(bossClient, {
    companyId: COMPANY_A_ID,
    from,
    to,
  });

  assert(overview !== null, 'Test 20: Analytics overview returned');
  assert(overview.responseSla.windowsStarted >= 2, `Test 20: windowsStarted recorded (got: ${overview.responseSla.windowsStarted})`);
  assert(overview.responseSla.saleRespondedWithin5m >= 1, `Test 20: saleRespondedWithin5m recorded (got: ${overview.responseSla.saleRespondedWithin5m})`);
  assert(overview.responseSla.complianceRateBasisPoints !== null && overview.responseSla.complianceRateBasisPoints > 0, `Test 20: complianceRateBasisPoints > 0 (got: ${overview.responseSla.complianceRateBasisPoints})`);
  console.log(`[PASS] Test 20: Real SLA metrics aggregated: started=${overview.responseSla.windowsStarted}, saleResponded=${overview.responseSla.saleRespondedWithin5m}, complianceBp=${overview.responseSla.complianceRateBasisPoints}`);

  // ============================================================================
  // TEST 21: PREPARE before deadline, SENT after deadline
  // ============================================================================
  console.log('\n--- Test 21: PREPARE before deadline, SENT after deadline ---');
  // Baseline analytics before Test 21
  const analyticsBefore21 = await fetchCompanyAnalyticsOverview(bossClient, {
    companyId: COMPANY_A_ID,
    from,
    to,
  });
  const baselineSaleWithin5m = analyticsBefore21.responseSla.saleRespondedWithin5m;
  const baselineSaleResponded = analyticsBefore21.responseSla.saleResponded;

  const extConvo21 = `123456789:${nowTs}21`;
  const { data: ingestRes21, error: ingestErr21 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo21,
    p_key: `ingest_21_${nowTs}`,
    p_name: 'Khách Test 21',
    p_phone: '+84909000021',
    p_content: 'Hỏi giá cửa 21',
    p_safe: 'Hỏi giá cửa 21',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr21, `Test 21: han_ingest succeeded: ${ingestErr21?.message}`);
  const { data: intRow21 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes21.interaction_id).single();
  const convoId21 = intRow21!.conversation_id;

  const requestId21 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId21,
    p_actor: saleUserId,
    p_request: requestId21,
    p_content: 'Báo giá 21 gửi muộn qua Meta',
    p_safe: 'Báo giá 21 gửi muộn qua Meta',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const outboxRows21 = queryRawJson(
    `SELECT interaction_id FROM private.han_outbox WHERE request_id = '${requestId21}';`
  );
  const prepIntId21 = outboxRows21[0].interaction_id;

  // Simulate timing where:
  // 1. SLA window started ~5 minutes ago (deadline was 10 seconds ago)
  // 2. Prepare interaction was created 3 seconds BEFORE deadline
  // 3. SENT happens at now() (10 seconds AFTER deadline!)
  // Note: Check constraint enforces: deadline_at = started_at + interval '5 minutes'
  executeRawSql(`
    UPDATE public.response_sla_windows
    SET started_at = started_at - interval '310 seconds',
        deadline_at = deadline_at - interval '310 seconds'
    WHERE conversation_id = '${convoId21}';
    UPDATE public.interactions
    SET created_at = (SELECT deadline_at - interval '3 seconds' FROM public.response_sla_windows WHERE conversation_id = '${convoId21}')
    WHERE id = '${prepIntId21}';
  `);

  // Verify prepare was strictly before deadline
  const { data: prepIntCheck21 } = await adminClient.from('interactions').select('created_at').eq('id', prepIntId21).single();
  const { data: winBefore21 } = await saleClient.from('response_sla_windows').select('deadline_at').eq('conversation_id', convoId21).single();
  assert(
    new Date(prepIntCheck21!.created_at).getTime() < new Date(winBefore21!.deadline_at).getTime(),
    'Test 21: Prepare interaction was created BEFORE deadline'
  );

  // Now Meta provider confirms SENT after deadline
  const providerMid21 = `m_mid_test_21_${nowTs}`;
  const { error: finishErr21 } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId21,
    p_status: 'SENT',
    p_mid: providerMid21,
  });
  assert(!finishErr21, `Test 21: han_finish_send succeeded: ${finishErr21?.message}`);

  // Assert SLA window state = SALE_RESPONDED and resolved_at > deadline_at
  const { data: winAfter21 } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId21).single();
  assert(winAfter21.state === 'SALE_RESPONDED', `Test 21: SLA state is SALE_RESPONDED (got: ${winAfter21.state})`);
  assert(winAfter21.resolved_at !== null, 'Test 21: resolved_at is not null');
  assert(
    new Date(winAfter21.resolved_at).getTime() > new Date(winAfter21.deadline_at).getTime(),
    `Test 21: resolved_at (${winAfter21.resolved_at}) > deadline_at (${winAfter21.deadline_at})`
  );
  assert(
    new Date(winAfter21.resolved_at).getTime() > new Date(prepIntCheck21!.created_at).getTime(),
    'Test 21: resolved_at is strictly after prepare interaction created_at'
  );

  // Check real Analytics overview:
  // saleResponded MUST increase by 1, but saleRespondedWithin5m MUST NOT increase!
  const analyticsAfter21 = await fetchCompanyAnalyticsOverview(bossClient, {
    companyId: COMPANY_A_ID,
    from,
    to,
  });
  assert(
    analyticsAfter21.responseSla.saleResponded === baselineSaleResponded + 1,
    `Test 21: Total saleResponded increased (got: ${analyticsAfter21.responseSla.saleResponded}, expected: ${baselineSaleResponded + 1})`
  );
  assert(
    analyticsAfter21.responseSla.saleRespondedWithin5m === baselineSaleWithin5m,
    `Test 21: CRITICAL REGRESSION TEST - saleRespondedWithin5m did NOT increase for late provider SENT (got: ${analyticsAfter21.responseSla.saleRespondedWithin5m}, baseline: ${baselineSaleWithin5m})`
  );
  console.log('[PASS] Test 21: Late provider SENT (prepare before deadline, SENT after deadline) resolved_at > deadline_at and NOT counted in saleRespondedWithin5m');

  // ============================================================================
  // TEST 22: PREPARE before deadline, SENT before deadline
  // ============================================================================
  console.log('\n--- Test 22: PREPARE before deadline, SENT before deadline ---');
  const extConvo22 = `123456789:${nowTs}22`;
  const { data: ingestRes22, error: ingestErr22 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo22,
    p_key: `ingest_22_${nowTs}`,
    p_name: 'Khách Test 22',
    p_phone: '+84909000022',
    p_content: 'Hỏi giá cửa 22',
    p_safe: 'Hỏi giá cửa 22',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr22, `Test 22: han_ingest succeeded: ${ingestErr22?.message}`);
  const { data: intRow22 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes22.interaction_id).single();
  const convoId22 = intRow22!.conversation_id;

  const requestId22 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId22,
    p_actor: saleUserId,
    p_request: requestId22,
    p_content: 'Báo giá 22 gửi đúng giờ',
    p_safe: 'Báo giá 22 gửi đúng giờ',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const providerMid22 = `m_mid_test_22_${nowTs}`;
  const { error: finishErr22 } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId22,
    p_status: 'SENT',
    p_mid: providerMid22,
  });
  assert(!finishErr22, `Test 22: han_finish_send succeeded: ${finishErr22?.message}`);

  const { data: winAfter22 } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId22).single();
  assert(winAfter22.state === 'SALE_RESPONDED', `Test 22: SLA state is SALE_RESPONDED (got: ${winAfter22.state})`);
  assert(
    new Date(winAfter22.resolved_at).getTime() <= new Date(winAfter22.deadline_at).getTime(),
    `Test 22: resolved_at (${winAfter22.resolved_at}) <= deadline_at (${winAfter22.deadline_at})`
  );

  // Check real Analytics overview:
  // saleRespondedWithin5m MUST increase by 1!
  const analyticsAfter22 = await fetchCompanyAnalyticsOverview(bossClient, {
    companyId: COMPANY_A_ID,
    from,
    to,
  });
  assert(
    analyticsAfter22.responseSla.saleRespondedWithin5m === baselineSaleWithin5m + 1,
    `Test 22: saleRespondedWithin5m increased by 1 for on-time send (got: ${analyticsAfter22.responseSla.saleRespondedWithin5m}, baseline: ${baselineSaleWithin5m})`
  );
  console.log('[PASS] Test 22: On-time provider SENT (prepare before deadline, SENT before deadline) resolved_at <= deadline_at and counted in saleRespondedWithin5m');

  // ============================================================================
  // TEST 23: resolved_at is not interaction.created_at
  // ============================================================================
  console.log('\n--- Test 23: resolved_at is not interaction.created_at ---');
  const extConvo23 = `123456789:${nowTs}23`;
  const { data: ingestRes23, error: ingestErr23 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo23,
    p_key: `ingest_23_${nowTs}`,
    p_name: 'Khách Test 23',
    p_phone: '+84909000023',
    p_content: 'Hỏi giá cửa 23',
    p_safe: 'Hỏi giá cửa 23',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr23, `Test 23: han_ingest succeeded: ${ingestErr23?.message}`);
  const { data: intRow23 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes23.interaction_id).single();
  const convoId23 = intRow23!.conversation_id;

  const requestId23 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId23,
    p_actor: saleUserId,
    p_request: requestId23,
    p_content: 'Báo giá 23 đo lường delay',
    p_safe: 'Báo giá 23 đo lường delay',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const outboxRows23 = queryRawJson(
    `SELECT interaction_id FROM private.han_outbox WHERE request_id = '${requestId23}';`
  );
  const prepIntId23 = outboxRows23[0].interaction_id;

  // Artificially simulate delay between prepare and provider confirmation
  executeRawSql(`
    UPDATE public.interactions
    SET created_at = clock_timestamp() - interval '3 seconds'
    WHERE id = '${prepIntId23}';
  `);

  const { data: prepIntBefore23 } = await adminClient.from('interactions').select('created_at').eq('id', prepIntId23).single();

  const providerMid23 = `m_mid_test_23_${nowTs}`;
  const { error: finishErr23 } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId23,
    p_status: 'SENT',
    p_mid: providerMid23,
  });
  assert(!finishErr23, `Test 23: han_finish_send succeeded: ${finishErr23?.message}`);

  const { data: winAfter23 } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId23).single();
  const prepCreatedAtMs = new Date(prepIntBefore23!.created_at).getTime();
  const resolvedAtMs = new Date(winAfter23.resolved_at).getTime();

  assert(
    winAfter23.resolved_at !== prepIntBefore23!.created_at,
    `Test 23: resolved_at (${winAfter23.resolved_at}) MUST NOT equal interaction.created_at (${prepIntBefore23!.created_at})`
  );
  assert(
    resolvedAtMs > prepCreatedAtMs,
    `Test 23: resolved_at (${resolvedAtMs}ms) MUST be strictly greater than interaction.created_at (${prepCreatedAtMs}ms)`
  );
  // Also verify outbox.sent_at matches winAfter23.resolved_at
  const outboxAfter23 = queryRawJson(
    `SELECT sent_at FROM private.han_outbox WHERE request_id = '${requestId23}';`
  );
  assert(outboxAfter23[0]?.sent_at !== null, 'Test 23: outbox.sent_at is not null');
  assert(
    new Date(outboxAfter23[0].sent_at!).getTime() === resolvedAtMs,
    'Test 23: SLA resolved_at exactly matches outbox.sent_at'
  );
  console.log(`[PASS] Test 23: Explicitly proven resolved_at (${winAfter23.resolved_at}) != interaction.created_at (${prepIntBefore23!.created_at}) and matches outbox.sent_at`);

  // ============================================================================
  // TEST 24: FAILED still has no resolved timestamp
  // ============================================================================
  console.log('\n--- Test 24: FAILED still has no resolved timestamp ---');
  const extConvo24 = `123456789:${nowTs}24`;
  const { data: ingestRes24, error: ingestErr24 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo24,
    p_key: `ingest_24_${nowTs}`,
    p_name: 'Khách Test 24',
    p_phone: '+84909000024',
    p_content: 'Hỏi giá cửa 24',
    p_safe: 'Hỏi giá cửa 24',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr24, `Test 24: han_ingest succeeded: ${ingestErr24?.message}`);
  const { data: intRow24 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes24.interaction_id).single();
  const convoId24 = intRow24!.conversation_id;

  const requestId24 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId24,
    p_actor: saleUserId,
    p_request: requestId24,
    p_content: 'Báo giá 24 thất bại',
    p_safe: 'Báo giá 24 thất bại',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const { error: finishErr24 } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId24,
    p_status: 'FAILED',
    p_mid: null,
  });
  assert(!finishErr24, `Test 24: han_finish_send FAILED succeeded: ${finishErr24?.message}`);

  const { data: winAfter24 } = await saleClient.from('response_sla_windows').select('*').eq('conversation_id', convoId24).single();
  assert(winAfter24.state === 'OPEN', `Test 24: SLA window state remains OPEN (got: ${winAfter24.state})`);
  assert(winAfter24.resolved_at === null, 'Test 24: resolved_at IS NULL');
  assert(winAfter24.sale_response_interaction_id === null, 'Test 24: sale_response_interaction_id IS NULL');

  const outboxAfter24 = queryRawJson(
    `SELECT status, sent_at FROM private.han_outbox WHERE request_id = '${requestId24}';`
  );
  assert(outboxAfter24[0].status === 'FAILED', 'Test 24: Outbox status is FAILED');
  assert(outboxAfter24[0].sent_at === null, 'Test 24: Outbox sent_at IS NULL');
  console.log('[PASS] Test 24: FAILED send preserves SLA OPEN with resolved_at NULL and outbox.sent_at NULL');

  // ============================================================================
  // TEST 25: Caller backdate cannot override Facebook SENT time
  // ============================================================================
  console.log('\n--- Test 25: Caller backdate cannot override Facebook SENT time ---');
  const extConvo25 = `123456789:${nowTs}25`;
  const { data: ingestRes25, error: ingestErr25 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo25,
    p_key: `ingest_25_${nowTs}`,
    p_name: 'Khách Test 25',
    p_phone: '+84909000025',
    p_content: 'Hỏi giá cửa 25',
    p_safe: 'Hỏi giá cửa 25',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr25, `Test 25: han_ingest succeeded: ${ingestErr25?.message}`);
  const { data: intRow25 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes25.interaction_id).single();
  const convoId25 = intRow25!.conversation_id;

  const requestId25 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId25,
    p_actor: saleUserId,
    p_request: requestId25,
    p_content: 'Báo giá 25 backdate attack',
    p_safe: 'Báo giá 25 backdate attack',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const outboxRows25 = queryRawJson<OutboxRow[]>(
    `SELECT interaction_id FROM private.han_outbox WHERE request_id = '${requestId25}';`
  );
  const prepIntId25 = outboxRows25[0].interaction_id;

  // Setup exact test invariant:
  // interaction.created_at = 14:04:00 (deadline - 60s)
  // deadline = 14:05:00
  // provider SENT = 14:05:10 (deadline + 10s)
  // outbox.sent_at = 14:05:10
  // Direct trusted RPC attempt with: p_resolved_at = 14:04:30 (deadline - 30s)
  executeRawSql(`
    UPDATE public.response_sla_windows
    SET started_at = started_at - interval '310 seconds',
        deadline_at = deadline_at - interval '310 seconds'
    WHERE conversation_id = '${convoId25}';
    UPDATE public.interactions
    SET created_at = (SELECT deadline_at - interval '60 seconds' FROM public.response_sla_windows WHERE conversation_id = '${convoId25}')
    WHERE id = '${prepIntId25}';
    UPDATE private.han_outbox
    SET status = 'SENT',
        sent_at = (SELECT deadline_at + interval '10 seconds' FROM public.response_sla_windows WHERE conversation_id = '${convoId25}'),
        provider_mid = 'mid_test_25_${nowTs}'
    WHERE request_id = '${requestId25}';
  `);

  const outboxBeforeRpc25 = queryRawJson<OutboxRow[]>(
    `SELECT status, sent_at FROM private.han_outbox WHERE request_id = '${requestId25}';`
  );
  const canonicalSentAt25 = outboxBeforeRpc25[0].sent_at!;
  const canonicalSentAtMs25 = new Date(canonicalSentAt25).getTime();

  const { data: winBefore25 } = await saleClient
    .from('response_sla_windows')
    .select('deadline_at, state')
    .eq('conversation_id', convoId25)
    .single();
  assert(winBefore25!.state === 'OPEN', 'Test 25: SLA window is OPEN before resolve attempt');
  const deadlineMs25 = new Date(winBefore25!.deadline_at).getTime();
  const fakeResolvedAt25 = new Date(deadlineMs25 - 30_000).toISOString(); // 14:04:30

  // Direct trusted RPC attempt with fake backdated p_resolved_at:
  const { error: rpcErr25 } = await adminClient.rpc('resolve_response_sla_on_sale_reply', {
    p_company_id: COMPANY_A_ID,
    p_conversation_id: convoId25,
    p_sale_interaction_id: prepIntId25,
    p_resolved_at: fakeResolvedAt25,
  });
  assert(!rpcErr25, `Test 25: RPC call succeeded: ${rpcErr25?.message}`);

  const { data: winAfter25 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId25)
    .single();

  assert(winAfter25.state === 'SALE_RESPONDED', `Test 25: state is SALE_RESPONDED (got: ${winAfter25.state})`);
  const resolvedAtMs25 = new Date(winAfter25.resolved_at).getTime();
  assert(
    resolvedAtMs25 === canonicalSentAtMs25,
    `Test 25: resolved_at (${winAfter25.resolved_at}) MUST equal canonical outbox.sent_at (${canonicalSentAt25})`
  );
  assert(
    winAfter25.resolved_at !== fakeResolvedAt25,
    `Test 25: resolved_at (${winAfter25.resolved_at}) MUST NOT equal caller fake p_resolved_at (${fakeResolvedAt25})`
  );
  assert(
    resolvedAtMs25 > deadlineMs25,
    `Test 25: Canonical resolved_at (${resolvedAtMs25}ms) > deadline_at (${deadlineMs25}ms)`
  );

  // Analytics semantics verification:
  const saleResponded25 = winAfter25.state === 'SALE_RESPONDED';
  const saleWithin5m25 = new Date(winAfter25.resolved_at).getTime() <= new Date(winAfter25.deadline_at).getTime();
  assert(saleResponded25 === true, 'Test 25: Analytics: saleResponded = yes');
  assert(saleWithin5m25 === false, 'Test 25: Analytics: saleWithin5m = no');
  console.log('[PASS] Test 25: Caller backdate cannot override Facebook SENT time; canonical sent_at wins (saleResponded=yes, saleWithin5m=no)');

  // ============================================================================
  // TEST 26: Hán outbox SENDING cannot be force-resolved
  // ============================================================================
  console.log('\n--- Test 26: Hán outbox SENDING cannot be force-resolved ---');
  const extConvo26 = `123456789:${nowTs}26`;
  const { data: ingestRes26, error: ingestErr26 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo26,
    p_key: `ingest_26_${nowTs}`,
    p_name: 'Khách Test 26',
    p_phone: '+84909000026',
    p_content: 'Hỏi giá cửa 26',
    p_safe: 'Hỏi giá cửa 26',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr26, `Test 26: han_ingest succeeded: ${ingestErr26?.message}`);
  const { data: intRow26 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes26.interaction_id).single();
  const convoId26 = intRow26!.conversation_id;

  const requestId26 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId26,
    p_actor: saleUserId,
    p_request: requestId26,
    p_content: 'Báo giá 26 đang gửi',
    p_safe: 'Báo giá 26 đang gửi',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const outboxRows26 = queryRawJson<OutboxRow[]>(
    `SELECT interaction_id, status, sent_at FROM private.han_outbox WHERE request_id = '${requestId26}';`
  );
  assert(outboxRows26[0].status === 'SENDING', 'Test 26: Outbox status is SENDING');
  assert(outboxRows26[0].sent_at === null, 'Test 26: Outbox sent_at is NULL');
  const prepIntId26 = outboxRows26[0].interaction_id;

  const { data: winBefore26 } = await saleClient
    .from('response_sla_windows')
    .select('deadline_at, state')
    .eq('conversation_id', convoId26)
    .single();
  assert(winBefore26!.state === 'OPEN', 'Test 26: SLA window is initially OPEN');
  const fakeTime26 = new Date(new Date(winBefore26!.deadline_at).getTime() - 60_000).toISOString();

  // Attempt to force-resolve while still SENDING:
  const { error: rpcErr26 } = await adminClient.rpc('resolve_response_sla_on_sale_reply', {
    p_company_id: COMPANY_A_ID,
    p_conversation_id: convoId26,
    p_sale_interaction_id: prepIntId26,
    p_resolved_at: fakeTime26,
  });

  assert(Boolean(rpcErr26), `Test 26: Force-resolve on SENDING outbox MUST reject (got error: ${rpcErr26?.message})`);

  const { data: winAfter26 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId26)
    .single();
  assert(winAfter26.state === 'OPEN', `Test 26: SLA window remains OPEN after rejected force-resolve (got: ${winAfter26.state})`);
  assert(winAfter26.resolved_at === null, 'Test 26: resolved_at remains NULL');
  assert(winAfter26.sale_response_interaction_id === null, 'Test 26: sale_response_interaction_id remains NULL');
  console.log('[PASS] Test 26: Hán outbox SENDING cannot be force-resolved; rejects and SLA remains OPEN');

  // ============================================================================
  // TEST 27: Hán outbox FAILED cannot be force-resolved
  // ============================================================================
  console.log('\n--- Test 27: Hán outbox FAILED cannot be force-resolved ---');
  const extConvo27 = `123456789:${nowTs}27`;
  const { data: ingestRes27, error: ingestErr27 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo27,
    p_key: `ingest_27_${nowTs}`,
    p_name: 'Khách Test 27',
    p_phone: '+84909000027',
    p_content: 'Hỏi giá cửa 27',
    p_safe: 'Hỏi giá cửa 27',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr27, `Test 27: han_ingest succeeded: ${ingestErr27?.message}`);
  const { data: intRow27 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes27.interaction_id).single();
  const convoId27 = intRow27!.conversation_id;

  const requestId27 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId27,
    p_actor: saleUserId,
    p_request: requestId27,
    p_content: 'Báo giá 27 thất bại',
    p_safe: 'Báo giá 27 thất bại',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const { error: finishErr27 } = await saleClient.rpc('han_finish_send', {
    p_company: COMPANY_A_ID,
    p_request: requestId27,
    p_status: 'FAILED',
    p_mid: null,
  });
  assert(!finishErr27, `Test 27: han_finish_send FAILED succeeded: ${finishErr27?.message}`);

  const outboxRows27 = queryRawJson<OutboxRow[]>(
    `SELECT interaction_id, status, sent_at FROM private.han_outbox WHERE request_id = '${requestId27}';`
  );
  assert(outboxRows27[0].status === 'FAILED', 'Test 27: Outbox status is FAILED');
  assert(outboxRows27[0].sent_at === null, 'Test 27: Outbox sent_at is NULL');
  const prepIntId27 = outboxRows27[0].interaction_id;

  // Call resolve with arbitrary old timestamp
  const arbitraryOldTs27 = new Date(Date.now() - 600_000).toISOString();
  const { error: rpcErr27 } = await adminClient.rpc('resolve_response_sla_on_sale_reply', {
    p_company_id: COMPANY_A_ID,
    p_conversation_id: convoId27,
    p_sale_interaction_id: prepIntId27,
    p_resolved_at: arbitraryOldTs27,
  });

  assert(Boolean(rpcErr27), `Test 27: Force-resolve on FAILED outbox MUST reject (got error: ${rpcErr27?.message})`);

  const { data: winAfter27 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId27)
    .single();
  assert(winAfter27.state === 'OPEN', `Test 27: SLA window remains OPEN after rejected force-resolve (got: ${winAfter27.state})`);
  assert(winAfter27.resolved_at === null, 'Test 27: resolved_at remains NULL');
  assert(winAfter27.sale_response_interaction_id === null, 'Test 27: sale_response_interaction_id remains NULL');
  console.log('[PASS] Test 27: Hán outbox FAILED cannot be force-resolved; rejects and SLA remains OPEN');

  // ============================================================================
  // TEST 28: Hán SENT canonical value wins
  // ============================================================================
  console.log('\n--- Test 28: Hán SENT canonical value wins ---');
  const extConvo28 = `123456789:${nowTs}28`;
  const { data: ingestRes28, error: ingestErr28 } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A_ID,
    p_channel: 'FACEBOOK',
    p_external: extConvo28,
    p_key: `ingest_28_${nowTs}`,
    p_name: 'Khách Test 28',
    p_phone: '+84909000028',
    p_content: 'Hỏi giá cửa 28',
    p_safe: 'Hỏi giá cửa 28',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date(Date.now() - 5000).toISOString(),
    p_payload: {},
  });
  assert(!ingestErr28, `Test 28: han_ingest succeeded: ${ingestErr28?.message}`);
  const { data: intRow28 } = await adminClient.from('interactions').select('conversation_id').eq('id', ingestRes28.interaction_id).single();
  const convoId28 = intRow28!.conversation_id;

  const requestId28 = crypto.randomUUID();
  await saleClient.rpc('han_prepare_send', {
    p_company: COMPANY_A_ID,
    p_conversation: convoId28,
    p_actor: saleUserId,
    p_request: requestId28,
    p_content: 'Báo giá 28 canonical test',
    p_safe: 'Báo giá 28 canonical test',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });

  const outboxRows28 = queryRawJson<OutboxRow[]>(
    `SELECT interaction_id FROM private.han_outbox WHERE request_id = '${requestId28}';`
  );
  const prepIntId28 = outboxRows28[0].interaction_id;

  // Set known canonical sent timestamp T_sent (must be >= interaction.created_at)
  const T_sent = new Date().toISOString();
  executeRawSql(`
    UPDATE private.han_outbox
    SET status = 'SENT',
        sent_at = '${T_sent}',
        provider_mid = 'mid_test_28_${nowTs}'
    WHERE request_id = '${requestId28}';
  `);

  // Fake timestamp distinctly different from T_sent
  const T_fake = new Date(Date.now() - 120_000).toISOString();

  const { error: rpcErr28 } = await adminClient.rpc('resolve_response_sla_on_sale_reply', {
    p_company_id: COMPANY_A_ID,
    p_conversation_id: convoId28,
    p_sale_interaction_id: prepIntId28,
    p_resolved_at: T_fake,
  });
  assert(!rpcErr28, `Test 28: resolve_response_sla_on_sale_reply succeeded: ${rpcErr28?.message}`);

  const { data: winAfter28 } = await saleClient
    .from('response_sla_windows')
    .select('*')
    .eq('conversation_id', convoId28)
    .single();

  assert(winAfter28.state === 'SALE_RESPONDED', `Test 28: state is SALE_RESPONDED (got: ${winAfter28.state})`);
  assert(
    new Date(winAfter28.resolved_at).getTime() === new Date(T_sent).getTime(),
    `Test 28: resolved_at (${winAfter28.resolved_at}) MUST equal T_sent (${T_sent})`
  );
  assert(
    new Date(winAfter28.resolved_at).getTime() !== new Date(T_fake).getTime(),
    `Test 28: resolved_at (${winAfter28.resolved_at}) MUST NOT equal T_fake (${T_fake})`
  );
  console.log('[PASS] Test 28: Hán SENT canonical value wins; resolved_at = T_sent and resolved_at != T_fake');

  console.log('\n================================================================');
  console.log('FACEBOOK SLA RUNTIME REAL DB INTEGRATION SUITE: ALL PASSED');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Fatal error in Facebook SLA Runtime test suite:', err);
  process.exit(1);
});
