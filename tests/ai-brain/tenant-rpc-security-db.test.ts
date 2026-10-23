import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { reconcileAuthUserFixture } from '../helpers/auth-fixture';
import { executeRawSql } from '../helpers/fixture-cleanup';

// 1. Local Supabase ONLY guard (fail-closed against non-local URLs)
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error('Tenant RPC Security DB test requires local Supabase env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY');
}

const parsedUrl = new URL(url);
if (!['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
  throw new Error(`Fail-closed: local Supabase URL required (localhost/127.0.0.1), got: ${parsedUrl.hostname}`);
}

const safeUrl: string = url;
const safeAnonKey: string = anonKey;
const safeServiceKey: string = serviceKey;

const service = createClient(safeUrl, safeServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(safeUrl, safeAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// Deterministic Tenant IDs
const TENANT_A_COMPANY_ID = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B_COMPANY_ID = '00000000-0000-4000-8000-0000000000b2';

const TENANT_A_CUSTOMER_ID = '00000000-0000-4000-8000-0000000000a2';
const TENANT_B_CUSTOMER_ID = '00000000-0000-4000-8000-0000000000b3';

const TENANT_A_CONVO_ID = '00000000-0000-4000-8000-0000000000a3';
const TENANT_B_CONVO_ID = '00000000-0000-4000-8000-0000000000b4';

const USER_A_EMAIL = 'tenant.a.boss.security@example.com';
const USER_B_EMAIL = 'tenant.b.boss.security@example.com';
const TEST_PASSWORD = 'TestPassword123!';

interface RecordAlertResult {
  alert_id: string;
  deduplicated: boolean;
  trigger_count: number;
}

interface PostgrestRpcError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

interface FunctionPrivilegeRow {
  proname: string;
  anon_can_execute: boolean;
  auth_can_execute: boolean;
  service_can_execute: boolean;
}

interface AclExplodeRow {
  proname: string;
  grantee: string;
  privilege_type: string;
}

/**
 * Strict authorization denial assertion helper.
 * Rejects PGRST202 (missing function/schema cache failure) and 42883 (undefined_function).
 * Requires exact PostgreSQL authorization error code 42501 (HTTP 403 / insufficient_privilege).
 */
function assertAuthorizationDenied(
  error: PostgrestRpcError | null,
  rpcName: string,
  caller: string
): void {
  assert.ok(error, `${caller} must receive an error when calling ${rpcName}`);
  assert.notEqual(
    error.code,
    'PGRST202',
    `Function ${rpcName} called by ${caller} returned PGRST202 (not found in schema cache) instead of authorization denial`
  );
  assert.notEqual(
    error.code,
    '42883',
    `Function ${rpcName} called by ${caller} returned 42883 (undefined_function) instead of authorization denial`
  );
  assert.equal(
    error.code,
    '42501',
    `Expected exact Postgres authorization error code 42501 for ${rpcName} called by ${caller}, got code=${error.code} message=${error.message}`
  );
  assert.match(
    error.message,
    /permission denied/i,
    `Expected permission denied message for ${rpcName} called by ${caller}, got: ${error.message}`
  );
}

let userAId: string;
let userBId: string;
let tenantAClient: SupabaseClient;
let tenantBClient: SupabaseClient;

let tenantBCaseId: string;
let tenantBAlertId: string;
let tenantBKnowledgeId: string;
let tenantBMemoryId: string;

let fixturePromise: Promise<void> | null = null;

async function provisionFixture(): Promise<void> {
  // A. Upsert Companies
  const { error: compErr } = await service.from('companies').upsert(
    [
      { id: TENANT_A_COMPANY_ID, name: 'Tenant A Isolation Test Co', status: 'ACTIVE' },
      { id: TENANT_B_COMPANY_ID, name: 'Tenant B Isolation Test Co', status: 'ACTIVE' },
    ],
    { onConflict: 'id' }
  );
  assert.ifError(compErr);

  // B. Upsert Customers
  const { error: custErr } = await service.from('customers').upsert(
    [
      {
        id: TENANT_A_CUSTOMER_ID,
        company_id: TENANT_A_COMPANY_ID,
        customer_code: 'CUST-SEC-A',
        name: 'Customer A',
        source: 'MANUAL',
        stage: 'LEAD_NEW',
      },
      {
        id: TENANT_B_CUSTOMER_ID,
        company_id: TENANT_B_COMPANY_ID,
        customer_code: 'CUST-SEC-B',
        name: 'Customer B',
        source: 'MANUAL',
        stage: 'LEAD_NEW',
      },
    ],
    { onConflict: 'id' }
  );
  assert.ifError(custErr);

  // C. Upsert Conversations
  const { error: convErr } = await service.from('conversations').upsert(
    [
      {
        id: TENANT_A_CONVO_ID,
        company_id: TENANT_A_COMPANY_ID,
        customer_id: TENANT_A_CUSTOMER_ID,
        channel: 'ZALO',
        external_conversation_id: 'ext-sec-a-convo',
        status: 'OPEN',
        ai_mode: 'ACTIVE',
      },
      {
        id: TENANT_B_CONVO_ID,
        company_id: TENANT_B_COMPANY_ID,
        customer_id: TENANT_B_CUSTOMER_ID,
        channel: 'ZALO',
        external_conversation_id: 'ext-sec-b-convo',
        status: 'OPEN',
        ai_mode: 'ACTIVE',
      },
    ],
    { onConflict: 'id' }
  );
  assert.ifError(convErr);

  // D. Create Actual Authenticated Users with company memberships
  userAId = await reconcileAuthUserFixture(service, {
    email: USER_A_EMAIL,
    password: TEST_PASSWORD,
    fullName: 'Boss Admin Tenant A',
    companyId: TENANT_A_COMPANY_ID,
    role: 'BOSS_ADMIN',
    status: 'ACTIVE',
  });

  userBId = await reconcileAuthUserFixture(service, {
    email: USER_B_EMAIL,
    password: TEST_PASSWORD,
    fullName: 'Boss Admin Tenant B',
    companyId: TENANT_B_COMPANY_ID,
    role: 'BOSS_ADMIN',
    status: 'ACTIVE',
  });

  // E. Authenticate Tenant A and Tenant B clients to obtain real JWTs
  tenantAClient = createClient(safeUrl, safeAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authDataA, error: authErrA } = await tenantAClient.auth.signInWithPassword({
    email: USER_A_EMAIL,
    password: TEST_PASSWORD,
  });
  assert.ifError(authErrA);
  assert.ok(authDataA.session?.access_token, 'Tenant A JWT acquired');

  tenantBClient = createClient(safeUrl, safeAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authDataB, error: authErrB } = await tenantBClient.auth.signInWithPassword({
    email: USER_B_EMAIL,
    password: TEST_PASSWORD,
  });
  assert.ifError(authErrB);
  assert.ok(authDataB.session?.access_token, 'Tenant B JWT acquired');

  // F. Provision Tenant B live settings (enabled = true)
  const { error: setErr } = await service.from('ai_brain_live_settings').upsert({
    company_id: TENANT_B_COMPANY_ID,
    channel: 'ZALO',
    enabled: true,
    min_confidence: 0.85,
  });
  assert.ifError(setErr);

  // Also enable live settings for Tenant A
  await service.from('ai_brain_live_settings').upsert({
    company_id: TENANT_A_COMPANY_ID,
    channel: 'ZALO',
    enabled: true,
    min_confidence: 0.85,
  });

  // G. Provision Tenant B inbound interaction & handover case via service-role
  const sourceInteractionB = randomUUID();
  const { error: intErr } = await service.from('interactions').insert({
    id: sourceInteractionB,
    company_id: TENANT_B_COMPANY_ID,
    customer_id: TENANT_B_CUSTOMER_ID,
    conversation_id: TENANT_B_CONVO_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Tenant B user needing human handover',
  });
  assert.ifError(intErr);

  const { data: caseId, error: caseErr } = await service.rpc('create_ai_handover_case', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_customer_id: TENANT_B_CUSTOMER_ID,
    p_conversation_id: TENANT_B_CONVO_ID,
    p_source_interaction_id: sourceInteractionB,
    p_reason: 'CUSTOMER_REQUESTED_HUMAN',
    p_priority: 'HIGH',
  });
  assert.ifError(caseErr);
  assert.ok(caseId);
  tenantBCaseId = caseId as string;

  // H. Provision Tenant B monitoring alert via service-role
  const { data: alertData, error: alertErr } = await service.rpc('record_ai_monitoring_alert', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_alert_type: 'HANDOVER_BACKLOG',
    p_severity: 'HIGH',
    p_fingerprint: 'TENANT_B_BACKLOG:ZALO',
    p_title: 'Tenant B Alert',
    p_description: 'Tenant B alert description',
    p_channel: 'ZALO',
  });
  assert.ifError(alertErr);
  const alertRows = alertData as RecordAlertResult[] | null;
  assert.ok(alertRows && alertRows[0]?.alert_id);
  tenantBAlertId = alertRows[0].alert_id;

  // I. Provision Tenant B Knowledge item via service-role
  const { data: kData, error: kErr } = await service.from('ai_company_knowledge').insert({
    company_id: TENANT_B_COMPANY_ID,
    category: 'FAQ',
    title: 'Tenant B Secret Product Knowledge',
    content: 'Proprietary confidential specifications for Tenant B.',
    verification_status: 'VERIFIED',
  }).select('id').single();
  assert.ifError(kErr);
  assert.ok(kData);
  tenantBKnowledgeId = (kData as { id: string }).id;

  // J. Provision Tenant B Customer Memory via service-role
  const { data: mData, error: mErr } = await service.from('ai_customer_memories').insert({
    company_id: TENANT_B_COMPANY_ID,
    customer_id: TENANT_B_CUSTOMER_ID,
    memory_type: 'FACT',
    content: 'Tenant B customer VIP preferences and private notes.',
    confidence: 0.95,
    verification_status: 'UNVERIFIED',
    lifecycle_status: 'ACTIVE',
    source_kind: 'MANUAL',
    created_by_type: 'SYSTEM',
  }).select('id').single();
  assert.ifError(mErr);
  assert.ok(mData);
  tenantBMemoryId = (mData as { id: string }).id;
}

function ensureFixture(): Promise<void> {
  if (!fixturePromise) fixturePromise = provisionFixture();
  return fixturePromise;
}

// -----------------------------------------------------------------------------
// Suite 1: Authenticated Tenant A JWT Cross-Tenant RPC Mutation Prevention
// (All negative RPC calls must return exact code 42501, rejecting schema/cache false-passes)
// -----------------------------------------------------------------------------

test('Tenant Isolation: Authenticated Tenant A JWT cannot disable Tenant B AI via emergency_disable_ai', async () => {
  await ensureFixture();

  // Ensure Tenant B is initially enabled
  const { data: initialSettings } = await service
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', TENANT_B_COMPANY_ID)
    .single();
  assert.equal(initialSettings?.enabled, true, 'Tenant B AI live setting is initially enabled');

  // Attacker Tenant A JWT attempts to call emergency_disable_ai targeting Tenant B
  const { error } = await tenantAClient.rpc('emergency_disable_ai', {
    p_company_id: TENANT_B_COMPANY_ID,
  });

  // Must fail: authenticated role does NOT have execute privilege (code 42501)
  assertAuthorizationDenied(error, 'emergency_disable_ai', 'Tenant A JWT (cross-tenant)');

  // Verify Tenant B settings were NOT mutated
  const { data: currentSettings } = await service
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', TENANT_B_COMPANY_ID)
    .single();
  assert.equal(currentSettings?.enabled, true, 'Tenant B AI must remain enabled');
});

test('Tenant Isolation: Authenticated Tenant A JWT cannot directly call emergency_disable_ai even for own company', async () => {
  await ensureFixture();

  // Direct client RPC call must be revoked; only server actions with service_role can call it
  const { error } = await tenantAClient.rpc('emergency_disable_ai', {
    p_company_id: TENANT_A_COMPANY_ID,
  });

  assertAuthorizationDenied(error, 'emergency_disable_ai', 'Tenant A JWT (own company)');
});

test('Tenant Isolation: Authenticated Tenant A JWT cannot create handover case for Tenant B', async () => {
  await ensureFixture();

  const fakeInteractionId = randomUUID();
  const { error } = await tenantAClient.rpc('create_ai_handover_case', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_customer_id: TENANT_B_CUSTOMER_ID,
    p_conversation_id: TENANT_B_CONVO_ID,
    p_source_interaction_id: fakeInteractionId,
    p_reason: 'CUSTOMER_REQUESTED_HUMAN',
    p_priority: 'HIGH',
  });

  assertAuthorizationDenied(error, 'create_ai_handover_case', 'Tenant A JWT');
});

test('Tenant Isolation: Authenticated Tenant A JWT cannot claim handover case of Tenant B', async () => {
  await ensureFixture();

  const { error } = await tenantAClient.rpc('claim_ai_handover_case', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_case_id: tenantBCaseId,
    p_user_id: userAId,
  });

  assertAuthorizationDenied(error, 'claim_ai_handover_case', 'Tenant A JWT');

  // Verify Tenant B case was NOT claimed
  const { data: caseRow } = await service
    .from('ai_handover_cases')
    .select('status, assigned_to')
    .eq('id', tenantBCaseId)
    .single();
  assert.equal(caseRow?.status, 'OPEN');
  assert.equal(caseRow?.assigned_to, null);
});

test('Tenant Isolation: Authenticated Tenant A JWT cannot resolve handover case of Tenant B', async () => {
  await ensureFixture();

  const { error } = await tenantAClient.rpc('resolve_ai_handover_case', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_case_id: tenantBCaseId,
    p_user_id: userAId,
  });

  assertAuthorizationDenied(error, 'resolve_ai_handover_case', 'Tenant A JWT');

  // Verify Tenant B case remains OPEN
  const { data: caseRow } = await service
    .from('ai_handover_cases')
    .select('status')
    .eq('id', tenantBCaseId)
    .single();
  assert.equal(caseRow?.status, 'OPEN');
});

test('Tenant Isolation: Authenticated Tenant A JWT cannot resume conversation of Tenant B', async () => {
  await ensureFixture();

  const { error } = await tenantAClient.rpc('resume_ai_conversation', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_conversation_id: TENANT_B_CONVO_ID,
    p_user_id: userAId,
  });

  assertAuthorizationDenied(error, 'resume_ai_conversation', 'Tenant A JWT');
});

test('Tenant Isolation: Authenticated Tenant A JWT cannot record / forge monitoring alert for Tenant B', async () => {
  await ensureFixture();

  const { error } = await tenantAClient.rpc('record_ai_monitoring_alert', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_alert_type: 'HIGH_BACKLOG',
    p_severity: 'CRITICAL',
    p_fingerprint: 'ATTACKER_INJECTED_FINGERPRINT',
    p_title: 'Forged Alert',
    p_description: 'Malicious alert injected across tenant boundaries',
  });

  assertAuthorizationDenied(error, 'record_ai_monitoring_alert', 'Tenant A JWT');
});

test('Tenant Isolation: Authenticated Tenant A JWT cannot acknowledge monitoring alert of Tenant B', async () => {
  await ensureFixture();

  const { error } = await tenantAClient.rpc('acknowledge_ai_monitoring_alert', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_alert_id: tenantBAlertId,
    p_user_id: userAId,
  });

  assertAuthorizationDenied(error, 'acknowledge_ai_monitoring_alert', 'Tenant A JWT');

  // Verify alert status is STILL ACTIVE in Tenant B
  const { data: alertRow } = await service
    .from('ai_monitoring_alerts')
    .select('status')
    .eq('id', tenantBAlertId)
    .single();
  assert.equal(alertRow?.status, 'ACTIVE');
});

test('Tenant Isolation: Authenticated Tenant A JWT cannot resolve monitoring alert of Tenant B', async () => {
  await ensureFixture();

  const { error } = await tenantAClient.rpc('resolve_ai_monitoring_alert', {
    p_company_id: TENANT_B_COMPANY_ID,
    p_alert_id: tenantBAlertId,
    p_user_id: userAId,
  });

  assertAuthorizationDenied(error, 'resolve_ai_monitoring_alert', 'Tenant A JWT');

  // Verify alert status is STILL ACTIVE in Tenant B
  const { data: alertRow } = await service
    .from('ai_monitoring_alerts')
    .select('status')
    .eq('id', tenantBAlertId)
    .single();
  assert.equal(alertRow?.status, 'ACTIVE');
});

// -----------------------------------------------------------------------------
// Suite 2: Direct Tenant A JWT Live Settings Update & Upsert Targeting Tenant B
// (RLS prevents mutation, service snapshot remains enabled, positive own control works)
// -----------------------------------------------------------------------------

test('Tenant Isolation: Direct Tenant A JWT cannot update or upsert Tenant B ai_brain_live_settings (RLS / no mutation)', async () => {
  await ensureFixture();

  // 1. Initial snapshot check: verify Tenant B is enabled via service client
  const { data: initialSettings, error: initErr } = await service
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', TENANT_B_COMPANY_ID)
    .single();
  assert.ifError(initErr);
  assert.equal(initialSettings?.enabled, true, 'Tenant B AI live setting is initially enabled');

  // 2. Direct Tenant A JWT update targeting Tenant B settings
  const { data: updateData, error: updateErr } = await tenantAClient
    .from('ai_brain_live_settings')
    .update({ enabled: false })
    .eq('company_id', TENANT_B_COMPANY_ID)
    .select('*');

  // RLS filters out rows or denies; no rows must be updated/returned
  if (updateErr) {
    assert.equal(updateErr.code, '42501', `Expected 42501 if update is explicitly denied, got ${updateErr.code}`);
  }
  assert.equal(updateData?.length ?? 0, 0, 'Tenant A update targeting Tenant B must return 0 mutated rows');

  // Verify service snapshot: Tenant B settings were NOT mutated
  const { data: snapshotAfterUpdate, error: snap1Err } = await service
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', TENANT_B_COMPANY_ID)
    .single();
  assert.ifError(snap1Err);
  assert.equal(snapshotAfterUpdate?.enabled, true, 'Tenant B AI must remain enabled after Tenant A update attempt');

  // 3. Direct Tenant A JWT upsert targeting Tenant B settings
  const { data: upsertData, error: upsertErr } = await tenantAClient
    .from('ai_brain_live_settings')
    .upsert({
      company_id: TENANT_B_COMPANY_ID,
      channel: 'ZALO',
      enabled: false,
    })
    .select('*');

  // Upsert must fail RLS WITH CHECK policy with error code 42501
  assert.ok(upsertErr, 'Tenant A JWT upsert targeting Tenant B settings must fail under RLS');
  assert.equal(upsertErr.code, '42501', `Expected code 42501 for cross-tenant upsert denial, got ${upsertErr.code}`);
  assert.equal(upsertData, null, 'Upsert must not return data on failure');

  // Verify service snapshot: Tenant B settings still strictly remain enabled
  const { data: snapshotAfterUpsert, error: snap2Err } = await service
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', TENANT_B_COMPANY_ID)
    .single();
  assert.ifError(snap2Err);
  assert.equal(snapshotAfterUpsert?.enabled, true, 'Tenant B AI must remain enabled after Tenant A upsert attempt');

  // 4. Positive permitted control: Tenant A can mutate own settings where current RLS intended
  const { data: ownUpdateData, error: ownUpdateErr } = await tenantAClient
    .from('ai_brain_live_settings')
    .update({ enabled: false })
    .eq('company_id', TENANT_A_COMPANY_ID)
    .select('*');
  assert.ifError(ownUpdateErr);
  assert.ok(ownUpdateData && ownUpdateData.length > 0, 'Tenant A must be permitted to update own live settings');
  assert.equal(ownUpdateData[0]?.enabled, false, 'Tenant A own setting updated to false');

  // Verify via service snapshot that Tenant A was mutated
  const { data: tenantASnapshot, error: snapAErr } = await service
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', TENANT_A_COMPANY_ID)
    .single();
  assert.ifError(snapAErr);
  assert.equal(tenantASnapshot?.enabled, false, 'Service snapshot confirms Tenant A own setting changed to false');

  // 5. Restore fixture state: re-enable Tenant A settings (no broad production impact)
  const { error: restoreErr } = await service
    .from('ai_brain_live_settings')
    .update({ enabled: true })
    .eq('company_id', TENANT_A_COMPANY_ID);
  assert.ifError(restoreErr);

  const { data: restoredASnapshot, error: snapRestoredErr } = await service
    .from('ai_brain_live_settings')
    .select('enabled')
    .eq('company_id', TENANT_A_COMPANY_ID)
    .single();
  assert.ifError(snapRestoredErr);
  assert.equal(restoredASnapshot?.enabled, true, 'Tenant A live settings fixture restored to enabled');
});

// -----------------------------------------------------------------------------
// Suite 3: Anonymous Client Denied Execution on All 8 Hardened RPCs
// -----------------------------------------------------------------------------

test('Tenant Isolation: Anonymous client is denied execute on all 8 hardened RPCs', async () => {
  await ensureFixture();

  const dummyUuid = '00000000-0000-4000-8000-000000000001';

  const calls = [
    { name: 'emergency_disable_ai', args: { p_company_id: dummyUuid } },
    {
      name: 'create_ai_handover_case',
      args: {
        p_company_id: dummyUuid,
        p_customer_id: dummyUuid,
        p_conversation_id: dummyUuid,
        p_source_interaction_id: dummyUuid,
        p_reason: 'CUSTOMER_REQUESTED_HUMAN',
        p_priority: 'HIGH',
      },
    },
    { name: 'claim_ai_handover_case', args: { p_company_id: dummyUuid, p_case_id: dummyUuid, p_user_id: dummyUuid } },
    { name: 'resolve_ai_handover_case', args: { p_company_id: dummyUuid, p_case_id: dummyUuid, p_user_id: dummyUuid } },
    { name: 'resume_ai_conversation', args: { p_company_id: dummyUuid, p_conversation_id: dummyUuid, p_user_id: dummyUuid } },
    {
      name: 'record_ai_monitoring_alert',
      args: {
        p_company_id: dummyUuid,
        p_alert_type: 'TEST',
        p_severity: 'LOW',
        p_fingerprint: 'ANON_FP',
        p_title: 'Anon Title',
        p_description: 'Anon Desc',
      },
    },
    { name: 'acknowledge_ai_monitoring_alert', args: { p_company_id: dummyUuid, p_alert_id: dummyUuid, p_user_id: dummyUuid } },
    { name: 'resolve_ai_monitoring_alert', args: { p_company_id: dummyUuid, p_alert_id: dummyUuid, p_user_id: dummyUuid } },
  ];

  for (const call of calls) {
    const { error } = await anon.rpc(call.name, call.args);
    assertAuthorizationDenied(error, call.name, 'Anonymous client');
  }
});

// -----------------------------------------------------------------------------
// Suite 4: Trusted Service-Role Intended Operations Work Across All 8 RPCs
// (Confirms functions exist, parameter signatures match, and service_role succeeds)
// -----------------------------------------------------------------------------

test('Tenant Isolation: Service-role intended operations succeed across all 8 RPCs', async () => {
  await ensureFixture();

  // 1. Create Handover Case via service_role
  const sourceInteractionId = randomUUID();
  await service.from('interactions').insert({
    id: sourceInteractionId,
    company_id: TENANT_A_COMPANY_ID,
    customer_id: TENANT_A_CUSTOMER_ID,
    conversation_id: TENANT_A_CONVO_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Legitimate service-role handover request',
  });

  const { data: newCaseId, error: createCaseErr } = await service.rpc('create_ai_handover_case', {
    p_company_id: TENANT_A_COMPANY_ID,
    p_customer_id: TENANT_A_CUSTOMER_ID,
    p_conversation_id: TENANT_A_CONVO_ID,
    p_source_interaction_id: sourceInteractionId,
    p_reason: 'CUSTOMER_COMPLAINT',
    p_priority: 'HIGH',
  });
  assert.ifError(createCaseErr);
  assert.ok(newCaseId, 'create_ai_handover_case succeeded for service_role');

  // 2. Claim Handover Case via service_role
  const { data: claimRes, error: claimErr } = await service.rpc('claim_ai_handover_case', {
    p_company_id: TENANT_A_COMPANY_ID,
    p_case_id: newCaseId,
    p_user_id: userAId,
  });
  assert.ifError(claimErr);
  assert.equal(claimRes, true, 'claim_ai_handover_case succeeded for service_role');

  // 3. Resolve Handover Case via service_role
  const { data: resolveCaseRes, error: resolveCaseErr } = await service.rpc('resolve_ai_handover_case', {
    p_company_id: TENANT_A_COMPANY_ID,
    p_case_id: newCaseId,
    p_user_id: userAId,
  });
  assert.ifError(resolveCaseErr);
  assert.equal(resolveCaseRes, true, 'resolve_ai_handover_case succeeded for service_role');

  // 4. Resume AI Conversation via service_role
  const { data: resumeRes, error: resumeErr } = await service.rpc('resume_ai_conversation', {
    p_company_id: TENANT_A_COMPANY_ID,
    p_conversation_id: TENANT_A_CONVO_ID,
    p_user_id: userAId,
  });
  assert.ifError(resumeErr);
  assert.equal(resumeRes, true, 'resume_ai_conversation succeeded for service_role');

  // 5. Record Monitoring Alert via service_role
  const fp = `SERVICE_ROLE_FP_${randomUUID()}`;
  const { data: alertRes, error: recordAlertErr } = await service.rpc('record_ai_monitoring_alert', {
    p_company_id: TENANT_A_COMPANY_ID,
    p_alert_type: 'HANDOVER_BACKLOG',
    p_severity: 'HIGH',
    p_fingerprint: fp,
    p_title: 'Service Role Legitimate Alert',
    p_description: 'Alert created via trusted server pipeline',
    p_channel: 'ZALO',
  });
  assert.ifError(recordAlertErr);
  const legitimateAlertRows = alertRes as RecordAlertResult[] | null;
  assert.ok(legitimateAlertRows && legitimateAlertRows[0]?.alert_id);
  const newAlertId = legitimateAlertRows[0].alert_id;

  // 6. Acknowledge Monitoring Alert via service_role
  const { data: ackRes, error: ackErr } = await service.rpc('acknowledge_ai_monitoring_alert', {
    p_company_id: TENANT_A_COMPANY_ID,
    p_alert_id: newAlertId,
    p_user_id: userAId,
  });
  assert.ifError(ackErr);
  assert.equal(ackRes, true, 'acknowledge_ai_monitoring_alert succeeded for service_role');

  // 7. Resolve Monitoring Alert via service_role
  const { data: resolveAlertRes, error: resolveAlertErr } = await service.rpc('resolve_ai_monitoring_alert', {
    p_company_id: TENANT_A_COMPANY_ID,
    p_alert_id: newAlertId,
    p_user_id: userAId,
  });
  assert.ifError(resolveAlertErr);
  assert.equal(resolveAlertRes, true, 'resolve_ai_monitoring_alert succeeded for service_role');

  // 8. Emergency Disable AI via service_role
  const { data: disabledCount, error: disableErr } = await service.rpc('emergency_disable_ai', {
    p_company_id: TENANT_A_COMPANY_ID,
  });
  assert.ifError(disableErr);
  assert.ok(typeof disabledCount === 'number', 'emergency_disable_ai succeeded for service_role');
});

// -----------------------------------------------------------------------------
// Suite 5: Native Catalog ACL Verification via Local Docker psql
// (Directly reads pg_proc catalog aclexplode and has_function_privilege; no secrets printed)
// -----------------------------------------------------------------------------

test('Tenant Isolation: Native catalog ACL check via local psql confirms all 8 RPCs are revoked from anon/authenticated and service_role only', async () => {
  await ensureFixture();

  // 1. has_function_privilege catalog check
  const privSql = `
    SELECT json_agg(row_to_json(t)) FROM (
      SELECT
        p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_execute,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'emergency_disable_ai',
          'resolve_ai_handover_case',
          'claim_ai_handover_case',
          'create_ai_handover_case',
          'resume_ai_conversation',
          'record_ai_monitoring_alert',
          'acknowledge_ai_monitoring_alert',
          'resolve_ai_monitoring_alert'
        )
      ORDER BY p.proname
    ) t;
  `;

  const rawPriv = executeRawSql(privSql);
  const jsonPrivMatch = rawPriv.match(/\[[\s\S]*\]/);
  assert.ok(jsonPrivMatch, 'Expected JSON array in psql output for function privilege check');
  const privRows = JSON.parse(jsonPrivMatch[0]) as FunctionPrivilegeRow[];

  assert.equal(privRows.length, 8, 'Catalog must contain all 8 hardened RPCs');
  for (const row of privRows) {
    assert.equal(row.anon_can_execute, false, `Catalog check: ${row.proname} must have anon_can_execute = false`);
    assert.equal(row.auth_can_execute, false, `Catalog check: ${row.proname} must have auth_can_execute = false`);
    assert.equal(row.service_can_execute, true, `Catalog check: ${row.proname} must have service_can_execute = true`);
  }

  // 2. aclexplode catalog check
  const aclSql = `
    SELECT json_agg(row_to_json(a_rows)) FROM (
      SELECT
        p.proname,
        (a).grantee::regrole::text AS grantee,
        (a).privilege_type AS privilege_type
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'emergency_disable_ai',
          'resolve_ai_handover_case',
          'claim_ai_handover_case',
          'create_ai_handover_case',
          'resume_ai_conversation',
          'record_ai_monitoring_alert',
          'acknowledge_ai_monitoring_alert',
          'resolve_ai_monitoring_alert'
        )
      ORDER BY p.proname, grantee
    ) a_rows;
  `;

  const rawAcl = executeRawSql(aclSql);
  const jsonAclMatch = rawAcl.match(/\[[\s\S]*\]/);
  assert.ok(jsonAclMatch, 'Expected JSON array in psql output for aclexplode check');
  const aclRows = JSON.parse(jsonAclMatch[0]) as AclExplodeRow[];

  assert.ok(aclRows.length >= 8, 'Must return ACL entries for all functions');
  for (const row of aclRows) {
    assert.ok(
      row.grantee === 'postgres' || row.grantee === 'service_role',
      `Catalog aclexplode: unexpected grantee ${row.grantee} with ${row.privilege_type} on ${row.proname}`
    );
    assert.notEqual(row.grantee, 'anon', `aclexplode: anon must not hold grant on ${row.proname}`);
    assert.notEqual(row.grantee, 'authenticated', `aclexplode: authenticated must not hold grant on ${row.proname}`);
    assert.notEqual(row.grantee, 'public', `aclexplode: PUBLIC must not hold grant on ${row.proname}`);
  }
});

// -----------------------------------------------------------------------------
// Suite 6: RLS Knowledge, Memory, and Settings Read Isolation
// -----------------------------------------------------------------------------

test('RLS Isolation: Authenticated Tenant A JWT cannot read Tenant B ai_company_knowledge', async () => {
  await ensureFixture();

  // 1. Direct query by Tenant B company ID is denied (table-level permission denied or 0 rows)
  const { data: crossRows, error: crossErr } = await tenantAClient
    .from('ai_company_knowledge')
    .select('*')
    .eq('company_id', TENANT_B_COMPANY_ID);

  if (crossErr) {
    assert.equal(crossErr.code, '42501', `Expected code 42501 on knowledge table denial, got ${crossErr.code}`);
    assert.match(crossErr.message.toLowerCase(), /permission denied/i);
  } else {
    assert.equal(crossRows?.length ?? 0, 0, 'Tenant A must receive 0 rows for Tenant B knowledge');
  }

  // 2. Direct query by specific Tenant B item ID
  const { data: specificRow, error: specificErr } = await tenantAClient
    .from('ai_company_knowledge')
    .select('*')
    .eq('id', tenantBKnowledgeId)
    .maybeSingle();

  if (specificErr) {
    assert.equal(specificErr.code, '42501', `Expected code 42501 on specific item denial, got ${specificErr.code}`);
    assert.match(specificErr.message.toLowerCase(), /permission denied/i);
  } else {
    assert.equal(specificRow, null, 'Tenant A cannot read specific Tenant B knowledge item');
  }
});

test('RLS Isolation: Authenticated Tenant A JWT cannot read Tenant B ai_customer_memories', async () => {
  await ensureFixture();

  // 1. Direct query by Tenant B company ID is denied (table-level permission denied or 0 rows)
  const { data: crossRows, error: crossErr } = await tenantAClient
    .from('ai_customer_memories')
    .select('*')
    .eq('company_id', TENANT_B_COMPANY_ID);

  if (crossErr) {
    assert.equal(crossErr.code, '42501', `Expected code 42501 on memories table denial, got ${crossErr.code}`);
    assert.match(crossErr.message.toLowerCase(), /permission denied/i);
  } else {
    assert.equal(crossRows?.length ?? 0, 0, 'Tenant A must receive 0 rows for Tenant B customer memories');
  }

  // 2. Direct query by specific Tenant B memory ID
  const { data: specificRow, error: specificErr } = await tenantAClient
    .from('ai_customer_memories')
    .select('*')
    .eq('id', tenantBMemoryId)
    .maybeSingle();

  if (specificErr) {
    assert.equal(specificErr.code, '42501', `Expected code 42501 on specific memory denial, got ${specificErr.code}`);
    assert.match(specificErr.message.toLowerCase(), /permission denied/i);
  } else {
    assert.equal(specificRow, null, 'Tenant A cannot read specific Tenant B customer memory');
  }
});

test('RLS Isolation: Authenticated Tenant A JWT cannot read Tenant B ai_brain_live_settings', async () => {
  await ensureFixture();

  // 1. Query with Tenant B filter returns 0 rows
  const { data: crossRows, error: crossErr } = await tenantAClient
    .from('ai_brain_live_settings')
    .select('*')
    .eq('company_id', TENANT_B_COMPANY_ID);

  assert.ifError(crossErr);
  assert.equal(crossRows?.length ?? 0, 0, 'Tenant A must receive 0 rows for Tenant B settings');

  // 2. General select returns only Tenant A rows
  const { data: ownRows, error: ownErr } = await tenantAClient
    .from('ai_brain_live_settings')
    .select('*');

  assert.ifError(ownErr);
  assert.ok(ownRows && ownRows.length > 0, 'Tenant A can read own live settings');
  for (const row of ownRows) {
    assert.equal(row.company_id, TENANT_A_COMPANY_ID, 'Returned settings must belong strictly to Tenant A');
  }
});

test('RLS Isolation: Authenticated Tenant A JWT cannot read Tenant B ai_monitoring_alerts or ai_handover_cases', async () => {
  await ensureFixture();

  // 1. Monitoring alerts
  const { data: alertRows, error: alertErr } = await tenantAClient
    .from('ai_monitoring_alerts')
    .select('*')
    .eq('company_id', TENANT_B_COMPANY_ID);

  assert.ifError(alertErr);
  assert.equal(alertRows?.length ?? 0, 0, 'Tenant A must receive 0 rows for Tenant B monitoring alerts');

  // 2. Handover cases
  const { data: caseRows, error: caseErr } = await tenantAClient
    .from('ai_handover_cases')
    .select('*')
    .eq('company_id', TENANT_B_COMPANY_ID);

  assert.ifError(caseErr);
  assert.equal(caseRows?.length ?? 0, 0, 'Tenant A must receive 0 rows for Tenant B handover cases');
});
