import assert from 'assert';
import { execSync } from 'child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { elevateClientToAal2 } from '../e2e/test-mfa-helpers';
import { signContract } from '../../features/contract/services';

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

function queryRawJson<T = unknown>(sql: string): T {
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

function validSamplePdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n' +
      '2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n' +
      '3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n>>\nendobj\n' +
      'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
      'trailer\n<<\n/Size 4\n/Root 1 0 R\n>>\nstartxref\n180\n%%EOF'
  );
}

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function runP0SecurityRegressionTests() {
  console.log('================================================================');
  console.log('STARTING SYSTEM-AUDIT P0 SECURITY REGRESSION TEST SUITE');
  console.log('================================================================\n');

  // ============================================================================
  // SECTION 9: CATALOG SECURITY ASSERTIONS
  // ============================================================================
  console.log('--- 1. Catalog Security Assertions ---');

  interface ProcRow {
    proname: string;
    prosecdef: boolean;
    proconfig: string[] | null;
    anon_exec: boolean;
    auth_exec: boolean;
    sr_exec: boolean;
  }

  const procRows = queryRawJson<ProcRow[]>(`
    SELECT
      proname,
      prosecdef,
      proconfig,
      has_function_privilege('anon', oid, 'execute') as anon_exec,
      has_function_privilege('authenticated', oid, 'execute') as auth_exec,
      has_function_privilege('service_role', oid, 'execute') as sr_exec
    FROM pg_proc
    WHERE proname IN ('han_prepare_send', 'han_finish_send')
      AND pronamespace = 'public'::regnamespace;
  `);

  assert.strictEqual(procRows.length, 2, 'Both han_prepare_send and han_finish_send must exist in public schema');

  for (const proc of procRows) {
    assert.strictEqual(proc.prosecdef, true, `${proc.proname} must be SECURITY DEFINER`);
    assert(
      proc.proconfig && proc.proconfig.includes('search_path=""'),
      `${proc.proname} must have SET search_path = ""`
    );
    assert.strictEqual(proc.anon_exec, false, `anon must NOT have EXECUTE on ${proc.proname}`);
    assert.strictEqual(proc.auth_exec, false, `authenticated must NOT have EXECUTE on ${proc.proname}`);
    assert.strictEqual(proc.sr_exec, true, `service_role MUST have EXECUTE on ${proc.proname}`);
  }
  testPass('Catalog ACL: han_prepare_send & han_finish_send: authenticated=NO, anon=NO, service_role=EXECUTE, secdef=true, search_path=""');

  interface TablePrivRow {
    anon_update: boolean;
    auth_update: boolean;
    sr_update: boolean;
    auth_select: boolean;
  }

  const tablePrivRows = queryRawJson<TablePrivRow[]>(`
    SELECT
      has_table_privilege('anon', 'public.contracts', 'UPDATE') as anon_update,
      has_table_privilege('authenticated', 'public.contracts', 'UPDATE') as auth_update,
      has_table_privilege('service_role', 'public.contracts', 'UPDATE') as sr_update,
      has_table_privilege('authenticated', 'public.contracts', 'SELECT') as auth_select;
  `);

  assert.strictEqual(tablePrivRows[0].anon_update, false, 'anon must NOT have UPDATE on public.contracts');
  assert.strictEqual(tablePrivRows[0].auth_update, false, 'authenticated must NOT have UPDATE on public.contracts');
  assert.strictEqual(tablePrivRows[0].sr_update, true, 'service_role MUST have UPDATE on public.contracts');
  assert.strictEqual(tablePrivRows[0].auth_select, true, 'authenticated MUST retain SELECT on public.contracts');
  testPass('Catalog ACL: public.contracts UPDATE: authenticated=NO, anon=NO, service_role=YES, auth_select=YES');

  interface PolicyRow {
    polname: string;
    polcmd: string;
  }

  const updatePolicies = queryRawJson<PolicyRow[]>(`
    SELECT polname, polcmd
    FROM pg_policy
    WHERE polrelid = 'public.contracts'::regclass AND polcmd = 'w';
  `);
  assert.strictEqual(
    updatePolicies.length,
    0,
    `No UPDATE policies should exist on public.contracts (found: ${updatePolicies.map((p) => p.polname).join(', ')})`
  );
  testPass('Catalog RLS: contracts_update_boss_admin policy confirmed removed; zero UPDATE policies on public.contracts');

  // ============================================================================
  // TEST FIXTURES SETUP
  // ============================================================================
  console.log('\n--- Setting up Test Fixtures with Unique RUN_ID ---');
  const RUN_ID = Date.now().toString().slice(-8);
  const COMPANY_A = `f7000000-0000-0000-0000-${RUN_ID.padStart(12, '0')}`;
  const COMPANY_B = `f8000000-0000-0000-0000-${RUN_ID.padStart(12, '0')}`;

  await adminClient.from('companies').upsert([
    { id: COMPANY_A, name: `Company A Security Test ${RUN_ID}`, status: 'ACTIVE' },
    { id: COMPANY_B, name: `Company B Security Test ${RUN_ID}`, status: 'ACTIVE' },
  ]);

  async function createRealAuthUser(
    email: string,
    fullName: string,
    companyId: string,
    role: 'BOSS_ADMIN' | 'SALE'
  ): Promise<{ userId: string; client: SupabaseClient }> {
    const password = 'Password123!@#$';
    const { data: userData, error: userErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (userErr || !userData.user) {
      throw new Error(`Failed to create test user ${email}: ${userErr?.message}`);
    }
    const userId = userData.user.id;

    await adminClient.from('user_profiles').upsert({
      id: userId,
      full_name: fullName,
      status: 'ACTIVE',
    });

    await adminClient.from('company_members').upsert({
      company_id: companyId,
      user_id: userId,
      role,
      status: 'ACTIVE',
    });

    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: loginErr } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (loginErr) {
      throw new Error(`Failed to login test user ${email}: ${loginErr.message}`);
    }

    return { userId, client };
  }

  const { userId: saleAId, client: saleAClient } = await createRealAuthUser(
    `sale_a_${RUN_ID}@sec.local`,
    'Sale A',
    COMPANY_A,
    'SALE'
  );
  const { userId: bossAId, client: bossAClient } = await createRealAuthUser(
    `boss_a_${RUN_ID}@sec.local`,
    'Boss A',
    COMPANY_A,
    'BOSS_ADMIN'
  );
  const { userId: bossCId, client: bossCClient } = await createRealAuthUser(
    `boss_c_${RUN_ID}@sec.local`,
    'Boss C',
    COMPANY_B,
    'BOSS_ADMIN'
  );

  // Setup customer and conversation for Facebook tests
  const customerAId = crypto.randomUUID();
  const { error: custErr } = await adminClient.from('customers').insert({
    id: customerAId,
    company_id: COMPANY_A,
    customer_code: `CUSA_${RUN_ID}`,
    name: `Customer FB ${RUN_ID}`,
    source: 'MANUAL',
    stage: 'LEAD_NEW',
  });
  assert(!custErr, `Customer insert failed: ${custErr?.message}`);

  const conversationId = crypto.randomUUID();
  const extConvo = `123456789:${RUN_ID}`;
  await adminClient.from('conversations').insert({
    id: conversationId,
    company_id: COMPANY_A,
    channel: 'FACEBOOK',
    external_conversation_id: extConvo,
    customer_id: customerAId,
    state: 'OPEN',
  });

  // Setup pricing policy, calculation, and order for contract bypass tests
  const policyId = crypto.randomUUID();
  const { error: polErr } = await adminClient.from('pricing_policies').insert({
    id: policyId,
    company_id: COMPANY_A,
    version: 'v1',
    conditions: { deposit_percentage: 30 },
    price_rules: { base_price_per_sqm: 5000000 },
    effective_at: new Date().toISOString(),
    status: 'ACTIVE',
  });
  assert(!polErr, `Pricing policy insert failed: ${polErr?.message}`);

  const { data: calcData, error: calcErr } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: customerAId,
    p_survey_id: null,
    p_pricing_policy_id: policyId,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 15000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert(!calcErr && calcData?.id, `Price calculation failed: ${calcErr?.message}`);

  const paymentRef = `DH-P0-${RUN_ID.toUpperCase()}`;
  const { data: orderData, error: orderErr } = await adminClient.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: customerAId,
    p_price_calculation_id: calcData.id,
    p_payment_reference: paymentRef,
    p_actor_user_id: bossAId,
  });
  assert(!orderErr && orderData?.orderId, `Order creation failed: ${orderErr?.message}`);
  const orderId = orderData.orderId;

  // Advance to DEPOSIT_CONFIRMED so TV8 preconditions are satisfied
  await adminClient
    .from('orders')
    .update({ deposit_status: 'CONFIRMED', order_status: 'DEPOSIT_CONFIRMED' })
    .eq('id', orderId);

  const contractId = crypto.randomUUID();
  const { error: contractInsErr } = await adminClient.from('contracts').insert({
    id: contractId,
    company_id: COMPANY_A,
    order_id: orderId,
    revision_no: 1,
    template_version: 'v1.0',
    status: 'GENERATED',
    is_current: true,
    contract_value: 15000000,
    generated_file_ref: `${COMPANY_A}/contracts/${contractId}/revision-1/generated.pdf`,
    signed_file_ref: null,
  });
  assert(!contractInsErr, `Contract insert failed: ${contractInsErr?.message}`);

  // ============================================================================
  // SECTION 4: FACEBOOK SECURITY REGRESSION TESTS
  // ============================================================================
  console.log('\n--- 2. Facebook Security Regression Tests ---');

  // A. authenticated cannot call prepare directly
  console.log('-> 4A: authenticated cannot call han_prepare_send directly');
  const requestId4A = crypto.randomUUID();
  const { data: prepDataA, error: prepErrA } = await saleAClient.rpc('han_prepare_send', {
    p_company: COMPANY_A,
    p_conversation: conversationId,
    p_actor: saleAId,
    p_request: requestId4A,
    p_content: 'Direct attacker message',
    p_safe: 'Direct attacker message',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });
  assert(prepErrA !== null, 'Direct call to han_prepare_send by authenticated SALE must fail');
  assert(
    prepErrA.message.toLowerCase().includes('permission denied'),
    `Expected permission denied error, got: ${prepErrA.message}`
  );

  const { data: prepDataBoss, error: prepErrBoss } = await bossAClient.rpc('han_prepare_send', {
    p_company: COMPANY_A,
    p_conversation: conversationId,
    p_actor: bossAId,
    p_request: crypto.randomUUID(),
    p_content: 'Direct BOSS attacker message',
    p_safe: 'Direct BOSS attacker message',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });
  assert(prepErrBoss !== null, 'Direct call to han_prepare_send by authenticated BOSS must fail');
  assert(
    prepErrBoss.message.toLowerCase().includes('permission denied'),
    `Expected permission denied error, got: ${prepErrBoss.message}`
  );
  testPass('4A: authenticated (both SALE and BOSS_ADMIN) strictly denied direct execute on han_prepare_send');

  // B. Cross-user impersonation impossible
  console.log('-> 4B: cross-user impersonation impossible');
  const requestId4B = crypto.randomUUID();
  const { error: impErr } = await saleAClient.rpc('han_prepare_send', {
    p_company: COMPANY_A,
    p_conversation: conversationId,
    p_actor: bossAId, // Impersonating Boss A
    p_request: requestId4B,
    p_content: 'Impersonated message',
    p_safe: 'Impersonated message',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });
  assert(impErr !== null, 'Impersonation attempt must be rejected fail-closed');
  assert(
    impErr.message.toLowerCase().includes('permission denied'),
    `Expected permission denied, got: ${impErr.message}`
  );

  // Verify zero outbox and zero interaction created for this request
  const outboxCheckImp = queryRawJson<unknown[]>(`
    SELECT * FROM private.han_outbox WHERE request_id = '${requestId4B}';
  `);
  assert.strictEqual(outboxCheckImp.length, 0, 'Zero outbox record must be created on rejected prepare');
  testPass('4B: Cross-user impersonation impossible: RPC blocked at database authorization boundary');

  // C. Authenticated cannot finalize provider result
  console.log('-> 4C: authenticated cannot finalize provider result');
  // First, create a valid inbound message to establish an OPEN Response SLA window
  const inKey4C = `msg_key_4c_${RUN_ID}`;
  const { data: ingestRes4C, error: ingestErr4C } = await adminClient.rpc('han_ingest', {
    p_company: COMPANY_A,
    p_channel: 'FACEBOOK',
    p_external: extConvo,
    p_key: inKey4C,
    p_name: 'Khach Hang FB',
    p_phone: '+84901234567',
    p_content: 'Hello asking for price',
    p_safe: 'Hello asking for price',
    p_safe_status: 'SUCCEEDED',
    p_occurred: new Date().toISOString(),
    p_payload: {},
  });
  assert(!ingestErr4C, `Inbound ingest succeeded: ${ingestErr4C?.message}`);
  assert(ingestRes4C?.interaction_id, 'Inbound interaction_id returned');

  const { data: intRow4C } = await adminClient
    .from('interactions')
    .select('conversation_id')
    .eq('id', ingestRes4C.interaction_id)
    .single();
  const fbConvoId = intRow4C!.conversation_id;

  // Now create an outbox record via trusted service_role flow
  const requestId4C = crypto.randomUUID();
  const { data: prepTrusted, error: prepTrustedErr } = await adminClient.rpc('han_prepare_send', {
    p_company: COMPANY_A,
    p_conversation: fbConvoId,
    p_actor: saleAId,
    p_request: requestId4C,
    p_content: 'Valid response from server',
    p_safe: 'Valid response from server',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });
  assert(!prepTrustedErr, `Trusted han_prepare_send failed: ${prepTrustedErr?.message}`);
  assert.strictEqual(prepTrusted.claimed, true, 'Trusted outbox claimed');

  // Snapshot state before attack
  interface OutboxRecord {
    status: string;
    provider_mid: string | null;
    sent_at: string | null;
  }
  const outboxBefore = queryRawJson<OutboxRecord[]>(`
    SELECT status, provider_mid, sent_at FROM private.han_outbox
    WHERE company_id = '${COMPANY_A}' AND request_id = '${requestId4C}';
  `)[0];
  assert.strictEqual(outboxBefore.status, 'SENDING');
  assert.strictEqual(outboxBefore.provider_mid, null);
  assert.strictEqual(outboxBefore.sent_at, null);

  const slaBefore = queryRawJson<{ state: string; resolved_at: string | null }[]>(`
    SELECT state, resolved_at FROM public.response_sla_windows
    WHERE conversation_id = '${fbConvoId}';
  `)[0];
  assert.strictEqual(slaBefore.state, 'OPEN');
  assert.strictEqual(slaBefore.resolved_at, null);

  const auditCountBefore = queryRawJson<{ count: string }[]>(`
    SELECT count(*) FROM public.audit_logs WHERE company_id = '${COMPANY_A}';
  `)[0].count;

  // Direct attacker call to han_finish_send as authenticated saleAClient
  const { error: finishAttackerErr } = await saleAClient.rpc('han_finish_send', {
    p_company: COMPANY_A,
    p_request: requestId4C,
    p_status: 'SENT',
    p_mid: 'attacker_forged_mid_4c',
  });
  assert(finishAttackerErr !== null, 'Direct authenticated call to han_finish_send must fail');
  assert(
    finishAttackerErr.message.toLowerCase().includes('permission denied'),
    `Expected permission denied, got: ${finishAttackerErr.message}`
  );

  // Verify ALL state is completely UNCHANGED
  const outboxAfter = queryRawJson<OutboxRecord[]>(`
    SELECT status, provider_mid, sent_at FROM private.han_outbox
    WHERE company_id = '${COMPANY_A}' AND request_id = '${requestId4C}';
  `)[0];
  assert.strictEqual(outboxAfter.status, 'SENDING', 'Outbox status must remain SENDING');
  assert.strictEqual(outboxAfter.provider_mid, null, 'provider_mid must remain null');
  assert.strictEqual(outboxAfter.sent_at, null, 'sent_at must remain null');

  const slaAfter = queryRawJson<{ state: string; resolved_at: string | null }[]>(`
    SELECT state, resolved_at FROM public.response_sla_windows
    WHERE conversation_id = '${fbConvoId}';
  `)[0];
  assert.strictEqual(slaAfter.state, 'OPEN', 'SLA window state must remain OPEN');
  assert.strictEqual(slaAfter.resolved_at, null, 'SLA resolved_at must remain null');

  const auditCountAfter = queryRawJson<{ count: string }[]>(`
    SELECT count(*) FROM public.audit_logs WHERE company_id = '${COMPANY_A}';
  `)[0].count;
  assert.strictEqual(auditCountAfter, auditCountBefore, 'Audit logs must remain unchanged');
  testPass('4C: authenticated cannot finalize provider result; all DB state, outbox, and SLA untouched');

  // D. Canonical trusted server path still works
  console.log('-> 4D: canonical trusted server path still works');
  // D1: FAILED keeps SLA OPEN
  const requestId4D1 = crypto.randomUUID();
  await adminClient.rpc('han_prepare_send', {
    p_company: COMPANY_A,
    p_conversation: fbConvoId,
    p_actor: saleAId,
    p_request: requestId4D1,
    p_content: 'Message failing provider delivery',
    p_safe: 'Message failing provider delivery',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });
  const { error: finishFailedErr } = await adminClient.rpc('han_finish_send', {
    p_company: COMPANY_A,
    p_request: requestId4D1,
    p_status: 'FAILED',
    p_mid: null,
  });
  assert(!finishFailedErr, `Trusted finish_send FAILED succeeded: ${finishFailedErr?.message}`);

  const slaAfterFailed = queryRawJson<{ state: string; resolved_at: string | null }[]>(`
    SELECT state, resolved_at FROM public.response_sla_windows
    WHERE conversation_id = '${fbConvoId}';
  `)[0];
  assert.strictEqual(slaAfterFailed.state, 'OPEN', 'FAILED provider status must NOT resolve SLA');
  assert.strictEqual(slaAfterFailed.resolved_at, null);

  // D2: SENT successfully resolves SLA to SALE_RESPONDED
  const requestId4D2 = crypto.randomUUID();
  await adminClient.rpc('han_prepare_send', {
    p_company: COMPANY_A,
    p_conversation: fbConvoId,
    p_actor: saleAId,
    p_request: requestId4D2,
    p_content: 'Successful confirmed delivery message',
    p_safe: 'Successful confirmed delivery message',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  });
  const validMid = `m_provider_sent_${RUN_ID}`;
  const { error: finishSentErr } = await adminClient.rpc('han_finish_send', {
    p_company: COMPANY_A,
    p_request: requestId4D2,
    p_status: 'SENT',
    p_mid: validMid,
  });
  assert(!finishSentErr, `Trusted finish_send SENT succeeded: ${finishSentErr?.message}`);

  const slaAfterSent = queryRawJson<{ state: string; resolved_at: string | null; sale_response_interaction_id: string | null }[]>(`
    SELECT state, resolved_at, sale_response_interaction_id FROM public.response_sla_windows
    WHERE conversation_id = '${fbConvoId}';
  `)[0];
  assert.strictEqual(slaAfterSent.state, 'SALE_RESPONDED', 'Provider SENT MUST resolve SLA to SALE_RESPONDED');
  assert(slaAfterSent.resolved_at !== null, 'resolved_at must be populated on SENT');
  assert(slaAfterSent.sale_response_interaction_id !== null, 'sale_response_interaction_id must be populated');
  testPass('4D: Trusted service_role Facebook flow operates correctly: SENT resolves SLA, FAILED preserves OPEN');

  // ============================================================================
  // SECTION 8: CONTRACT BYPASS REGRESSION TESTS
  // ============================================================================
  console.log('\n--- 3. Contract Bypass Regression Tests ---');

  // A. BOSS AAL1 direct table mutation
  console.log('-> 8A: BOSS AAL1 direct contract UPDATE denied');
  const { error: bossAal1UpdateErr } = await bossAClient
    .from('contracts')
    .update({
      status: 'SIGNED',
      signed_file_ref: 'forged/browser/path_aal1.pdf',
    })
    .eq('id', contractId);
  assert(bossAal1UpdateErr !== null, 'BOSS AAL1 direct contract UPDATE must be denied');
  assert(
    bossAal1UpdateErr.message.toLowerCase().includes('permission denied'),
    `Expected permission denied, got: ${bossAal1UpdateErr.message}`
  );

  const checkContract8A = queryRawJson<{ status: string; signed_file_ref: string | null }[]>(`
    SELECT status, signed_file_ref FROM public.contracts WHERE id = '${contractId}';
  `)[0];
  assert.strictEqual(checkContract8A.status, 'GENERATED', 'Contract status must remain GENERATED');
  assert.strictEqual(checkContract8A.signed_file_ref, null, 'signed_file_ref must remain null');
  testPass('8A: BOSS AAL1 direct contract UPDATE strictly denied fail-closed');

  // B. BOSS AAL2 direct table mutation
  console.log('-> 8B: BOSS AAL2 direct table mutation also denied');
  await elevateClientToAal2(bossAClient, 'Boss A TOTP');
  const { data: aalCheck } = await bossAClient.auth.mfa.getAuthenticatorAssuranceLevel();
  assert.strictEqual(aalCheck?.currentLevel, 'aal2', 'Boss A client must now be elevated to AAL2');

  const { error: bossAal2UpdateErr } = await bossAClient
    .from('contracts')
    .update({
      status: 'SIGNED',
      signed_file_ref: 'forged/browser/path_aal2.pdf',
    })
    .eq('id', contractId);
  assert(bossAal2UpdateErr !== null, 'BOSS AAL2 direct contract UPDATE must ALSO be denied');
  assert(
    bossAal2UpdateErr.message.toLowerCase().includes('permission denied'),
    `Expected permission denied, got: ${bossAal2UpdateErr.message}`
  );

  const checkContract8B = queryRawJson<{ status: string; signed_file_ref: string | null }[]>(`
    SELECT status, signed_file_ref FROM public.contracts WHERE id = '${contractId}';
  `)[0];
  assert.strictEqual(checkContract8B.status, 'GENERATED', 'Contract status must remain GENERATED');
  assert.strictEqual(checkContract8B.signed_file_ref, null, 'signed_file_ref must remain null');
  testPass('8B: BOSS AAL2 direct contract UPDATE strictly denied: AAL2 does not grant direct table mutation');

  // C. SALE direct contract UPDATE denied
  console.log('-> 8C: SALE direct contract UPDATE denied');
  const { error: saleUpdateErr } = await saleAClient
    .from('contracts')
    .update({
      status: 'SIGNED',
      signed_file_ref: 'forged/browser/path_sale.pdf',
    })
    .eq('id', contractId);
  assert(saleUpdateErr !== null, 'SALE direct contract UPDATE must be denied');
  assert(
    saleUpdateErr.message.toLowerCase().includes('permission denied'),
    `Expected permission denied, got: ${saleUpdateErr.message}`
  );
  testPass('8C: SALE direct contract UPDATE strictly denied');

  // D. Cross-tenant BOSS direct contract UPDATE denied
  console.log('-> 8D: Cross-tenant BOSS direct contract UPDATE denied');
  const { error: crossBossUpdateErr } = await bossCClient
    .from('contracts')
    .update({
      status: 'SIGNED',
      signed_file_ref: 'forged/browser/path_cross.pdf',
    })
    .eq('id', contractId);
  assert(crossBossUpdateErr !== null, 'Cross-tenant BOSS direct contract UPDATE must be denied');
  assert(
    crossBossUpdateErr.message.toLowerCase().includes('permission denied'),
    `Expected permission denied, got: ${crossBossUpdateErr.message}`
  );
  testPass('8D: Cross-tenant BOSS direct contract UPDATE strictly denied');

  // F (Part 1): TV8 handoff BEFORE canonical signing
  console.log('-> 8F (Part 1): TV8 handoff BEFORE canonical signing -> CONTRACT_NOT_SIGNED');
  const { error: tv8BeforeSignErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: orderId,
    p_actor_id: bossAId,
    p_specs: { dimensions: '210x110cm' },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(tv8BeforeSignErr !== null, 'Production order creation must fail when contract is not signed');
  assert(
    tv8BeforeSignErr.message.includes('CONTRACT_NOT_SIGNED'),
    `Expected CONTRACT_NOT_SIGNED, got: ${tv8BeforeSignErr.message}`
  );
  testPass('8F (Part 1): TV8 create_production_order_atomic rejected with CONTRACT_NOT_SIGNED before canonical sign');

  // E. Canonical signing path with BOSS_ADMIN AAL2
  console.log('-> 8E: Canonical signContract() with BOSS_ADMIN AAL2');
  const signResult = await signContract(
    {
      companyId: COMPANY_A,
      contractId,
      signedPdfBuffer: validSamplePdf(),
    },
    bossAClient
  );
  assert(signResult.success === true, 'signContract must succeed');
  assert.strictEqual(signResult.status, 'SIGNED', 'Contract status must be SIGNED');

  const expectedSignedPath = `${COMPANY_A}/contracts/${contractId}/revision-1/signed.pdf`;
  const canonicalContract = queryRawJson<{ status: string; signed_file_ref: string | null; signed_at: string | null }[]>(`
    SELECT status, signed_file_ref, signed_at FROM public.contracts WHERE id = '${contractId}';
  `)[0];
  assert.strictEqual(canonicalContract.status, 'SIGNED', 'Contract status must be SIGNED in DB');
  assert.strictEqual(canonicalContract.signed_file_ref, expectedSignedPath, 'signed_file_ref must match canonical path');
  assert(canonicalContract.signed_at !== null, 'signed_at timestamp must be populated');

  // Verify Storage existence
  const { data: storageObjects, error: storageErr } = await adminClient.storage
    .from('contracts')
    .list(`${COMPANY_A}/contracts/${contractId}/revision-1`);
  assert(!storageErr, `Storage list failed: ${storageErr?.message}`);
  assert(
    storageObjects?.some((obj) => obj.name === 'signed.pdf'),
    'Signed PDF must exist in canonical storage location'
  );

  // Verify Audit log
  const auditLogs = queryRawJson<{ action: string; resource_type: string; resource_id: string }[]>(`
    SELECT action, resource_type, resource_id FROM public.audit_logs
    WHERE company_id = '${COMPANY_A}' AND resource_type = 'contracts' AND resource_id = '${contractId}';
  `);
  assert(auditLogs.length > 0, 'Audit log must be recorded for contract signing');
  assert.strictEqual(auditLogs[0].action, 'CONTRACT_SIGNED');
  testPass('8E: Canonical AAL2 signing workflow succeeded: SIGNED, signed_at, canonical storage path, and audit log confirmed');

  // F (Part 2): TV8 handoff AFTER canonical signing
  console.log('-> 8F (Part 2): TV8 handoff AFTER canonical signing -> SUCCESS');
  const { data: tv8AfterSign, error: tv8AfterSignErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: orderId,
    p_actor_id: bossAId,
    p_specs: { dimensions: '210x110cm' },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!tv8AfterSignErr, `Production order creation failed after valid sign: ${tv8AfterSignErr?.message}`);
  assert(tv8AfterSign.id, 'Production order ID must be generated');
  assert.strictEqual(tv8AfterSign.status, 'RELEASED_TO_FACTORY');

  const orderAfterProd = queryRawJson<{ order_status: string }[]>(`
    SELECT order_status FROM public.orders WHERE id = '${orderId}';
  `)[0];
  assert.strictEqual(orderAfterProd.order_status, 'IN_PRODUCTION', 'Order status must transition to IN_PRODUCTION');
  testPass('8F (Part 2): TV8 create_production_order_atomic succeeds immediately after canonical AAL2 signing');

  console.log('\n================================================================');
  console.log(`SYSTEM-AUDIT P0 SECURITY REGRESSION SUITE: ALL ${passCount} PASSED`);
  console.log('================================================================');
}

runP0SecurityRegressionTests().catch((err) => {
  console.error('\n[FATAL] P0 Security Regression Test failed:', err);
  process.exit(1);
});
