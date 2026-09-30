import { strict as assert } from 'assert';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { createAdminClient } from '@/lib/supabase/admin';
import { createWarrantyTicket } from '@/features/warranty/warranty-service';
import type { CreateWarrantyTicketInput } from '@/features/warranty/types';

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

console.log('================================================================');
console.log('STARTING SYSTEM-AUDIT P1 BACKEND REGRESSION TEST SUITE');
console.log('================================================================\n');

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

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function runP1BackendRegressionTests() {
  const adminClient = createAdminClient();
  const RUN_ID = crypto.randomUUID().slice(0, 8);
  const COMPANY_A = crypto.randomUUID();
  const COMPANY_B = crypto.randomUUID();
  const CUSTOMER_A = crypto.randomUUID();
  const CUSTOMER_B = crypto.randomUUID();
  const BOSS_A = crypto.randomUUID();
  const SALE_A = crypto.randomUUID();
  const TECH_A = crypto.randomUUID();
  const INACTIVE_USER = crypto.randomUUID();

  console.log('--- 1. P1-001 Catalog Security Assertions: Voice Claim Overload ---');
  // Catalog check: Only 3-arg claim_voice_media_jobs exists, 1-arg overload is dropped
  const voiceProcs = queryRawJson<
    Array<{
      proname: string;
      pronargs: number;
      prosecdef: boolean;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
    }>
  >(`
    SELECT
      proname,
      pronargs,
      prosecdef,
      has_function_privilege('anon', oid, 'execute') as anon_exec,
      has_function_privilege('authenticated', oid, 'execute') as auth_exec,
      has_function_privilege('service_role', oid, 'execute') as sr_exec
    FROM pg_proc
    WHERE proname = 'claim_voice_media_jobs'
      AND pronamespace = 'public'::regnamespace;
  `);

  assert.strictEqual(
    voiceProcs.length,
    1,
    `Expected exactly 1 claim_voice_media_jobs function in catalog, found: ${voiceProcs.length}`
  );
  assert.strictEqual(voiceProcs[0].pronargs, 3, 'claim_voice_media_jobs must be the 3-argument signature');
  assert.strictEqual(voiceProcs[0].prosecdef, true, 'claim_voice_media_jobs must be SECURITY DEFINER');
  assert.strictEqual(voiceProcs[0].anon_exec, false, 'anon must not have execute on claim_voice_media_jobs');
  assert.strictEqual(voiceProcs[0].auth_exec, false, 'authenticated must not have execute on claim_voice_media_jobs');
  assert.strictEqual(voiceProcs[0].sr_exec, true, 'service_role must have execute on claim_voice_media_jobs');
  testPass('P1-001 Catalog: legacy one-arg claim_voice_media_jobs(integer) is dropped; 3-arg overload is service_role only');

  console.log('\n--- Setting up Fixtures for P1-001, P1-002, and P1-003 ---');
  // Companies
  await adminClient.from('companies').insert([
    { id: COMPANY_A, name: `Company A ${RUN_ID}` },
    { id: COMPANY_B, name: `Company B ${RUN_ID}` },
  ]);

  // Customers
  await adminClient.from('customers').insert([
    { id: CUSTOMER_A, company_id: COMPANY_A, name: `Customer A ${RUN_ID}`, source: 'MANUAL', stage: 'LEAD_NEW' },
    { id: CUSTOMER_B, company_id: COMPANY_B, name: `Customer B ${RUN_ID}`, source: 'MANUAL', stage: 'LEAD_NEW' },
  ]);

  // Users & Profiles & Memberships
  for (const [uid, role, status] of [
    [BOSS_A, 'BOSS_ADMIN', 'ACTIVE'],
    [SALE_A, 'SALE', 'ACTIVE'],
    [TECH_A, 'TECHNICIAN', 'ACTIVE'],
    [INACTIVE_USER, 'SALE', 'INACTIVE'],
  ]) {
    execSync(
      `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "INSERT INTO auth.users (id, email) VALUES ('${uid}', '${uid}@test.local') ON CONFLICT DO NOTHING;"`
    );
    await adminClient.from('user_profiles').upsert({ id: uid, full_name: `User ${uid} ${RUN_ID}`, status });
    await adminClient.from('company_members').insert({
      company_id: COMPANY_A,
      user_id: uid,
      role,
      status,
    });
  }

  // ----------------------------------------------------------------------------
  // P1-001 Functional Tests: Hardened Voice Job Claim & Leases
  // ----------------------------------------------------------------------------
  console.log('\n--- 2. P1-001 Functional Lease & Reclaim Tests ---');
  const CALL_ID = crypto.randomUUID();
  await adminClient.from('calls').insert({
    id: CALL_ID,
    company_id: COMPANY_A,
    customer_id: CUSTOMER_A,
    direction: 'OUTBOUND',
    agent_type: 'AI',
    provider: 'STRINGEE',
    started_at: new Date().toISOString(),
    status: 'COMPLETED',
    transcript_status: 'PENDING',
  });

  const { data: jobData, error: jobErr } = await adminClient
    .from('voice_media_jobs')
    .insert({
      company_id: COMPANY_A,
      call_id: CALL_ID,
      job_type: 'RECORDING_IMPORT',
      status: 'PENDING',
    })
    .select('id')
    .single();
  assert(!jobErr && jobData?.id, `Job insert failed: ${jobErr?.message}`);
  const jobId = jobData.id;

  // Claim with hardened RPC
  const { data: claimed, error: claimErr } = await adminClient.rpc('claim_voice_media_jobs', {
    p_limit: 10,
    p_locked_by: 'worker_p1_test',
    p_lease_seconds: 120,
  });
  assert(!claimErr, `Claim failed: ${claimErr?.message}`);
  const targetJob = (claimed as Array<{ id: string; lock_token: string; retry_count: number }>).find((j) => j.id === jobId);
  assert.ok(targetJob, 'Job must be claimed');
  assert.ok(targetJob.lock_token, 'Claimed job must return lock_token');
  const token1 = targetJob.lock_token;

  // Verify lease_expires_at is populated in DB
  const rawJob = queryRawJson<Array<{ status: string; lock_token: string; lease_expires_at: string }>>(`
    SELECT status, lock_token, lease_expires_at FROM public.voice_media_jobs WHERE id = '${jobId}';
  `)[0];
  assert.strictEqual(rawJob.status, 'PROCESSING');
  assert.strictEqual(rawJob.lock_token, token1);
  assert.ok(rawJob.lease_expires_at, 'lease_expires_at must be populated in DB');
  testPass('P1-001: Hardened claim returns lock_token and populates lease_expires_at');

  // Stale lease expiration & reclaim
  await adminClient
    .from('voice_media_jobs')
    .update({ lease_expires_at: new Date(Date.now() - 10000).toISOString() })
    .eq('id', jobId);

  const { data: reclaimed } = await adminClient.rpc('claim_voice_media_jobs', {
    p_limit: 10,
    p_locked_by: 'worker_p1_reclaim',
    p_lease_seconds: 120,
  });
  const reclaimedTarget = (reclaimed as Array<{ id: string; lock_token: string; retry_count: number }>).find((j) => j.id === jobId);
  assert.ok(reclaimedTarget, 'Expired job must be reclaimed');
  assert.notStrictEqual(reclaimedTarget.lock_token, token1, 'Reclaimed job must have fresh lock_token');
  assert.strictEqual(reclaimedTarget.retry_count, 1, 'Reclaim must increment retry_count');
  const token2 = reclaimedTarget.lock_token;
  testPass('P1-001: Expired lease successfully reclaimed with fresh token and incremented retry_count');

  // Stale completion rejected
  const { data: staleCompResult } = await adminClient.rpc('complete_voice_media_job', {
    p_company_id: COMPANY_A,
    p_job_id: jobId,
    p_lock_token: token1,
  });
  assert.strictEqual(staleCompResult, false, 'Old token must NOT complete job');

  // Valid completion accepted
  const { data: validCompResult } = await adminClient.rpc('complete_voice_media_job', {
    p_company_id: COMPANY_A,
    p_job_id: jobId,
    p_lock_token: token2,
  });
  assert.strictEqual(validCompResult, true, 'Valid current token completes job');
  testPass('P1-001: Token matching enforced on completion; old worker cannot strand work');

  // ----------------------------------------------------------------------------
  // P1-002: Canonical Production Specifications
  // ----------------------------------------------------------------------------
  console.log('\n--- 3. P1-002 Canonical Production Specifications Tests ---');
  // Setup pricing policy
  const POLICY_ID = crypto.randomUUID();
  await adminClient.from('pricing_policies').insert({
    id: POLICY_ID,
    company_id: COMPANY_A,
    version: `v1_${RUN_ID}`,
    conditions: {
      deposit_percentage: 50,
      standard_materials: { aluminum: '6063-T5', gasket: 'EPDM' },
    },
    price_rules: { base_price_per_sqm: 5000000 },
    effective_at: new Date().toISOString(),
    status: 'ACTIVE',
  });

  // Valid calculation with width 2.0, height 1.2
  const { data: calcA } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_ID,
    p_policy_version: `v1_${RUN_ID}`,
    p_input_data: { width: 2.0, height: 1.2 },
    p_amount: 12000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert.ok(calcA?.id);

  // Order for calculation A
  const { data: orderDataA, error: orderErrA } = await adminClient.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcA.id,
    p_payment_reference: `DH-P1-A-${RUN_ID}`,
    p_actor_user_id: BOSS_A,
  });
  assert(!orderErrA && orderDataA?.orderId, `Order creation failed: ${orderErrA?.message}`);
  const ORDER_A = orderDataA.orderId;

  // Advance order to DEPOSIT_CONFIRMED
  await adminClient
    .from('orders')
    .update({ deposit_status: 'CONFIRMED', order_status: 'DEPOSIT_CONFIRMED' })
    .eq('id', ORDER_A);

  // Unsigned contract scenario
  const CONTRACT_A = crypto.randomUUID();
  await adminClient.from('contracts').insert({
    id: CONTRACT_A,
    company_id: COMPANY_A,
    order_id: ORDER_A,
    revision_no: 1,
    template_version: 'v1',
    generated_file_ref: `${COMPANY_A}/contracts/${CONTRACT_A}/revision-1/generated.pdf`,
    signed_file_ref: null,
    status: 'GENERATED',
    contract_value: 12000000,
    is_current: true,
  });

  // 1. Unsigned contract fails with CONTRACT_NOT_SIGNED
  const { error: unsignedErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_A,
    p_actor_id: BOSS_A,
    p_specs: { dimensions: '200x120cm' },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(unsignedErr && unsignedErr.message.includes('CONTRACT_NOT_SIGNED'));
  testPass('P1-002: Production creation rejected with CONTRACT_NOT_SIGNED when contract is unsigned');

  // Sign contract
  await adminClient.from('contracts').update({
    status: 'SIGNED',
    signed_file_ref: `${COMPANY_A}/contracts/${CONTRACT_A}/revision-1/signed.pdf`,
    signed_at: new Date().toISOString(),
  }).eq('id', CONTRACT_A);

  // 2. Empty specs {} rejected
  const { error: emptySpecsErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_A,
    p_actor_id: BOSS_A,
    p_specs: {},
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(emptySpecsErr && emptySpecsErr.message.includes('INVALID_TECHNICAL_INPUT'));
  testPass('P1-002: Empty specs {} rejected with INVALID_TECHNICAL_INPUT');

  // 3. Empty materials {} rejected
  const { error: emptyMatErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_A,
    p_actor_id: BOSS_A,
    p_specs: { dimensions: '200x120cm' },
    p_materials: {},
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(emptyMatErr && emptyMatErr.message.includes('INVALID_TECHNICAL_INPUT'));
  testPass('P1-002: Empty materials {} rejected with INVALID_TECHNICAL_INPUT');

  // 4. Arbitrary client-only unrecognized specs keys rejected
  const { error: arbitrarySpecsErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_A,
    p_actor_id: BOSS_A,
    p_specs: { arbitrary_unrecognized_fact: 999 },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(arbitrarySpecsErr && arbitrarySpecsErr.message.includes('INVALID_TECHNICAL_INPUT'));
  testPass('P1-002: Arbitrary client-only specs keys rejected with INVALID_TECHNICAL_INPUT');

  // 5. Arbitrary client-only unrecognized materials keys rejected
  const { error: arbitraryMatErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_A,
    p_actor_id: BOSS_A,
    p_specs: { dimensions: '200x120cm' },
    p_materials: { candy: 'chocolate_bar' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(arbitraryMatErr && arbitraryMatErr.message.includes('INVALID_TECHNICAL_INPUT'));
  testPass('P1-002: Arbitrary client-only materials keys rejected with INVALID_TECHNICAL_INPUT');

  // 6. Cross-tenant order access rejected
  const { error: crossTenantOrderErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_B,
    p_order_id: ORDER_A,
    p_actor_id: BOSS_A,
    p_specs: { dimensions: '200x120cm' },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(crossTenantOrderErr && (crossTenantOrderErr.message.includes('PERMISSION_DENIED') || crossTenantOrderErr.message.includes('RESOURCE_NOT_FOUND')));
  testPass('P1-002: Cross-tenant production creation strictly rejected');

  // 6b. Forged material value rejected (material tampering)
  const { error: tamperedMatErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_A,
    p_actor_id: BOSS_A,
    p_specs: { dimensions: '200x120cm' },
    p_materials: { aluminum: 'cheap_scrap_plastic' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(tamperedMatErr && tamperedMatErr.message.includes('INVALID_TECHNICAL_INPUT'));
  testPass('P1-002: Forged material value strictly rejected with INVALID_TECHNICAL_INPUT');

  // 7. Authoritative calculation-derived values successfully create production order;
  // Attack test: client supplies forged dimensions, width, thickness_mm, tolerance_mm.
  // Expected: dimensions=canonical, width=canonical, thickness_mm/tolerance_mm are NOT client-forged values,
  // and do NOT appear in the snapshot if no canonical source exists; client materials authoritative: NO.
  const { data: prodSuccess, error: prodSuccessErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_A,
    p_actor_id: BOSS_A,
    p_specs: {
      dimensions: '999x999cm',
      width: 9999,
      thickness_mm: 1,
      tolerance_mm: 999,
      notes: 'Priority production',
    },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!prodSuccessErr && prodSuccess?.id, `Production creation failed: ${prodSuccessErr?.message}`);
  assert.strictEqual(prodSuccess.status, 'RELEASED_TO_FACTORY');

  // Verify server-anchored canonical facts cannot be overridden by client
  const dbProd = queryRawJson<Array<{ specs: Record<string, unknown>; materials: Record<string, unknown> }>>(`
    SELECT specs, materials FROM public.production_orders WHERE id = '${prodSuccess.id}';
  `)[0];
  assert.strictEqual(dbProd.specs.canonical_source, 'PRICE_CALCULATION');
  assert.strictEqual(dbProd.specs.calculation_id, calcA.id);
  assert.strictEqual(dbProd.specs.canonical_dimensions, '200x120cm');
  // Client forged dimensions and width were stripped and strictly overridden by canonical record
  assert.strictEqual(dbProd.specs.dimensions, '200x120cm', 'Recognized-key forged spec dimensions must be ignored/overridden');
  assert.strictEqual(dbProd.specs.width, 2.0, 'Recognized-key forged spec width must be ignored/overridden');
  // Client forged thickness_mm and tolerance_mm MUST NOT survive into production snapshot
  assert.notStrictEqual(dbProd.specs.thickness_mm, 1, 'Client forged thickness_mm (1) must not survive');
  assert.strictEqual(dbProd.specs.thickness_mm, undefined, 'Missing canonical thickness must not appear in production snapshot');
  assert.notStrictEqual(dbProd.specs.tolerance_mm, 999, 'Client forged tolerance_mm (999) must not survive');
  assert.strictEqual(dbProd.specs.tolerance_mm, undefined, 'Missing canonical tolerance must not appear in production snapshot');
  assert.strictEqual(dbProd.specs.notes, 'Priority production', 'Non-canonical auxiliary note preserved');
  // Client materials are NOT authoritative; canonical materials snapshot is persisted
  assert.strictEqual(dbProd.materials.aluminum, '6063-T5');
  assert.strictEqual(dbProd.materials.gasket, 'EPDM', 'Authoritative standard materials persisted even if omitted by client');
  testPass('P1-002: Recognized-key forged spec ignored/overridden; client materials authoritative: NO');

  // 7b. Canonical thickness and tolerance derived from authoritative record; client forged values cannot override
  const POLICY_AUTH_SPECS_ID = crypto.randomUUID();
  await adminClient.from('pricing_policies').insert({
    id: POLICY_AUTH_SPECS_ID,
    company_id: COMPANY_A,
    version: `v_authspecs_${RUN_ID}`,
    conditions: {
      deposit_percentage: 50,
      standard_materials: { aluminum: '6063-T5' },
      thickness_mm: 12,
      tolerance_mm: 3,
    },
    price_rules: { base_price_per_sqm: 5000000 },
    effective_at: new Date().toISOString(),
    status: 'ACTIVE',
  });
  const { data: calcAuthSpecs } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_AUTH_SPECS_ID,
    p_policy_version: `v_authspecs_${RUN_ID}`,
    p_input_data: { width: 2.0, height: 1.0 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { data: orderAuthSpecs } = await adminClient.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcAuthSpecs.id,
    p_payment_reference: `DH-P1-AUTHSPECS-${RUN_ID}`,
    p_actor_user_id: BOSS_A,
  });
  await adminClient.from('orders').update({ deposit_status: 'CONFIRMED', order_status: 'DEPOSIT_CONFIRMED' }).eq('id', orderAuthSpecs.orderId);
  const contractAuthSpecsId = crypto.randomUUID();
  await adminClient.from('contracts').insert({
    id: contractAuthSpecsId,
    company_id: COMPANY_A,
    order_id: orderAuthSpecs.orderId,
    status: 'SIGNED',
    contract_value: 10000000,
    signed_file_ref: `${COMPANY_A}/contracts/${contractAuthSpecsId}/revision-1/signed.pdf`,
    template_version: 'v1',
    generated_file_ref: `${COMPANY_A}/contracts/${contractAuthSpecsId}/revision-1/gen.pdf`,
  });
  const { data: prodAuthSpecs, error: prodAuthSpecsErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: orderAuthSpecs.orderId,
    p_actor_id: BOSS_A,
    p_specs: { dimensions: '999x999cm', thickness_mm: 1, tolerance_mm: 999 },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!prodAuthSpecsErr && prodAuthSpecs?.id, `Production creation failed: ${prodAuthSpecsErr?.message}`);
  const dbProdAuthSpecs = queryRawJson<Array<{ specs: Record<string, unknown> }>>(`
    SELECT specs FROM public.production_orders WHERE id = '${prodAuthSpecs.id}';
  `)[0];
  assert.strictEqual(dbProdAuthSpecs.specs.dimensions, '200x100cm', 'Canonical dimensions override client forged dimensions');
  assert.strictEqual(Number(dbProdAuthSpecs.specs.thickness_mm), 12, 'Canonical thickness_mm (12) overrides client forged value (1)');
  assert.strictEqual(Number(dbProdAuthSpecs.specs.tolerance_mm), 3, 'Canonical tolerance_mm (3) overrides client forged value (999)');
  testPass('P1-002: Canonical thickness and tolerance derived from authoritative record; client forged values cannot override');

  // 8. Missing canonical technical input (missing dimensions in calculation): fail closed
  const { data: calcNoDims } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_ID,
    p_policy_version: `v1_${RUN_ID}`,
    p_input_data: { color: 'blue' }, // no dimensions
    p_amount: 1000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { data: orderNoDims } = await adminClient.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcNoDims.id,
    p_payment_reference: `DH-P1-NODIM-${RUN_ID}`,
    p_actor_user_id: BOSS_A,
  });
  await adminClient.from('orders').update({ deposit_status: 'CONFIRMED', order_status: 'DEPOSIT_CONFIRMED' }).eq('id', orderNoDims.orderId);
  const contractNoDimsId = crypto.randomUUID();
  await adminClient.from('contracts').insert({
    id: contractNoDimsId,
    company_id: COMPANY_A,
    order_id: orderNoDims.orderId,
    status: 'SIGNED',
    contract_value: 1000000,
    signed_file_ref: `${COMPANY_A}/contracts/${contractNoDimsId}/revision-1/signed.pdf`,
    template_version: 'v1',
    generated_file_ref: `${COMPANY_A}/contracts/${contractNoDimsId}/revision-1/gen.pdf`,
  });
  const { error: missingDimsErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: orderNoDims.orderId,
    p_actor_id: BOSS_A,
    p_specs: { dimensions: '200x120cm' },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(missingDimsErr && (missingDimsErr.message.includes('NEED_INFO') || missingDimsErr.message.includes('INVALID_TECHNICAL_INPUT')));
  testPass('P1-002: Missing canonical dimensions in authoritative record fails closed with NEED_INFO');

  // 9. Pricing policy without materials + calculation without materials + survey without materials
  // -> create_production_order_atomic fails closed, and prove no trigger secretly injects materials
  const POLICY_NO_MAT_ID = crypto.randomUUID();
  await adminClient.from('pricing_policies').insert({
    id: POLICY_NO_MAT_ID,
    company_id: COMPANY_A,
    version: `v_nomat_${RUN_ID}`,
    conditions: { deposit_percentage: 50 }, // plain conditions with NO materials
    price_rules: { base_price_per_sqm: 5000000 },
    effective_at: new Date().toISOString(),
    status: 'ACTIVE',
  });

  // Verify no trigger secretly injected materials into the pricing policy
  const insertedPolicy = queryRawJson<Array<{ conditions: Record<string, unknown> }>>(`
    SELECT conditions FROM public.pricing_policies WHERE id = '${POLICY_NO_MAT_ID}';
  `)[0];
  assert.strictEqual(insertedPolicy.conditions.standard_materials, undefined, 'No trigger may inject standard_materials');
  assert.strictEqual(insertedPolicy.conditions.materials, undefined, 'No trigger may inject materials');

  // Verify trigger trg_pricing_policies_default_materials is completely ABSENT
  const triggerCheck = queryRawJson<Array<{ count: string }>>(`
    SELECT count(*)::text as count FROM information_schema.triggers
    WHERE trigger_name = 'trg_pricing_policies_default_materials';
  `)[0];
  assert.strictEqual(triggerCheck.count, '0', 'trg_pricing_policies_default_materials trigger must not exist');

  const { data: calcNoMat } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_NO_MAT_ID,
    p_policy_version: `v_nomat_${RUN_ID}`,
    p_input_data: { width: 2.0, height: 1.0 }, // dimensions exist, but no materials
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { data: orderNoMat } = await adminClient.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcNoMat.id,
    p_payment_reference: `DH-P1-NOMAT-${RUN_ID}`,
    p_actor_user_id: BOSS_A,
  });
  await adminClient.from('orders').update({ deposit_status: 'CONFIRMED', order_status: 'DEPOSIT_CONFIRMED' }).eq('id', orderNoMat.orderId);
  const contractNoMatId = crypto.randomUUID();
  await adminClient.from('contracts').insert({
    id: contractNoMatId,
    company_id: COMPANY_A,
    order_id: orderNoMat.orderId,
    status: 'SIGNED',
    contract_value: 10000000,
    signed_file_ref: `${COMPANY_A}/contracts/${contractNoMatId}/revision-1/signed.pdf`,
    template_version: 'v1',
    generated_file_ref: `${COMPANY_A}/contracts/${contractNoMatId}/revision-1/gen.pdf`,
  });
  const { error: missingMatErr } = await adminClient.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: orderNoMat.orderId,
    p_actor_id: BOSS_A,
    p_specs: { dimensions: '200x100cm' },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(missingMatErr && missingMatErr.message.includes('INVALID_TECHNICAL_INPUT'));

  // Prove production order was NOT created and order did NOT become RELEASED_TO_FACTORY
  const noProdRows = queryRawJson<Array<{ count: string }>>(`
    SELECT count(*)::text as count FROM public.production_orders WHERE order_id = '${orderNoMat.orderId}';
  `)[0];
  assert.strictEqual(noProdRows.count, '0', 'Production order must not be created when materials missing');
  testPass('P1-002: Missing canonical materials in authoritative record fails closed with INVALID_TECHNICAL_INPUT (no secret trigger)');

  // ----------------------------------------------------------------------------
  // P1-003: Atomic Audited Warranty Ticket Creation
  // ----------------------------------------------------------------------------
  console.log('\n--- 4. P1-003 Atomic Audited Warranty Ticket Creation Tests ---');
  // Setup completed order and installation
  const { data: calcB } = await adminClient.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_ID,
    p_policy_version: `v1_${RUN_ID}`,
    p_input_data: { width: 1.8, height: 1.0 },
    p_amount: 9000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert.ok(calcB?.id);

  const { data: orderDataB } = await adminClient.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcB.id,
    p_payment_reference: `DH-P1-B-${RUN_ID}`,
    p_actor_user_id: BOSS_A,
  });
  assert.ok(orderDataB?.orderId);
  const ORDER_B = orderDataB.orderId;

  // Order in CONTRACT_SIGNED status (not yet COMPLETED)
  await adminClient.from('orders').update({
    deposit_status: 'CONFIRMED',
    order_status: 'CONTRACT_SIGNED',
  }).eq('id', ORDER_B);

  // 1. Incomplete order (not COMPLETED) rejected
  const { error: nonCompletedErr } = await adminClient.rpc('create_warranty_ticket_atomic', {
    p_company_id: COMPANY_A,
    p_actor_id: BOSS_A,
    p_customer_id: CUSTOMER_A,
    p_order_id: ORDER_B,
    p_issue: 'Test issue non-completed',
  });
  assert.ok(nonCompletedErr && nonCompletedErr.message.includes('INVALID_STATE_TRANSITION'));
  testPass('P1-003: Non-COMPLETED order rejected with INVALID_STATE_TRANSITION');

  // Advance order to COMPLETED
  await adminClient.from('orders').update({ order_status: 'COMPLETED' }).eq('id', ORDER_B);

  // Create appointment and installation record for ORDER_B
  const APPOINTMENT_ID = crypto.randomUUID();
  await adminClient.from('appointments').insert({
    id: APPOINTMENT_ID,
    company_id: COMPANY_A,
    customer_id: CUSTOMER_A,
    type: 'INSTALLATION',
    start_time: new Date().toISOString(),
    assignee_id: TECH_A,
    address: '123 Test Street',
    status: 'COMPLETED',
  });

  const INSTALL_ID = crypto.randomUUID();
  const { error: instErr } = await adminClient.from('installations').insert({
    id: INSTALL_ID,
    company_id: COMPANY_A,
    customer_id: CUSTOMER_A,
    order_id: ORDER_B,
    appointment_id: APPOINTMENT_ID,
    status: 'COMPLETED',
    crew: ['Crew 1'],
  });
  assert(!instErr, `Installation insert failed: ${instErr?.message}`);

  // 2. TECHNICIAN cannot create warranty ticket
  const { error: techErr } = await adminClient.rpc('create_warranty_ticket_atomic', {
    p_company_id: COMPANY_A,
    p_actor_id: TECH_A,
    p_customer_id: CUSTOMER_A,
    p_order_id: ORDER_B,
    p_issue: 'Tech attempt',
  });
  assert.ok(techErr && techErr.message.includes('PERMISSION_DENIED'));
  testPass('P1-003: TECHNICIAN actor cannot create warranty ticket (PERMISSION_DENIED)');

  // 3. Inactive actor cannot create warranty ticket
  const { error: inactiveErr } = await adminClient.rpc('create_warranty_ticket_atomic', {
    p_company_id: COMPANY_A,
    p_actor_id: INACTIVE_USER,
    p_customer_id: CUSTOMER_A,
    p_order_id: ORDER_B,
    p_issue: 'Inactive attempt',
  });
  assert.ok(inactiveErr && inactiveErr.message.includes('PERMISSION_DENIED'));
  testPass('P1-003: Inactive actor cannot create warranty ticket (PERMISSION_DENIED)');

  // 4. Cross-tenant customer/order rejected
  const { error: crossTenantTicketErr } = await adminClient.rpc('create_warranty_ticket_atomic', {
    p_company_id: COMPANY_B,
    p_actor_id: BOSS_A,
    p_customer_id: CUSTOMER_A,
    p_order_id: ORDER_B,
    p_issue: 'Cross tenant attempt',
  });
  assert.ok(crossTenantTicketErr && (crossTenantTicketErr.message.includes('PERMISSION_DENIED') || crossTenantTicketErr.message.includes('RESOURCE_NOT_FOUND')));
  testPass('P1-003: Cross-tenant customer/order rejected fail-closed');

  // 5. Wrong installation reference rejected
  const FOREIGN_INSTALL = crypto.randomUUID();
  const { error: wrongInstallErr } = await adminClient.rpc('create_warranty_ticket_atomic', {
    p_company_id: COMPANY_A,
    p_actor_id: BOSS_A,
    p_customer_id: CUSTOMER_A,
    p_order_id: ORDER_B,
    p_installation_id: FOREIGN_INSTALL,
    p_issue: 'Wrong installation attempt',
  });
  assert.ok(wrongInstallErr && wrongInstallErr.message.includes('RESOURCE_NOT_FOUND'));
  testPass('P1-003: Wrong installation reference rejected with RESOURCE_NOT_FOUND');

  // 6. BOSS_ADMIN creates valid warranty ticket -> SUCCESS + AUDIT LOG
  const { data: bossTicket, error: bossTicketErr } = await adminClient.rpc('create_warranty_ticket_atomic', {
    p_company_id: COMPANY_A,
    p_actor_id: BOSS_A,
    p_customer_id: CUSTOMER_A,
    p_order_id: ORDER_B,
    p_installation_id: INSTALL_ID,
    p_issue: 'Gasket wear after flood season',
    p_notes: 'Customer requested inspection',
    p_idempotency_key: `IDEMP_BOSS_${RUN_ID}`,
  });
  assert(!bossTicketErr && bossTicket?.id, `Boss warranty ticket failed: ${bossTicketErr?.message}`);
  assert.strictEqual(bossTicket.status, 'OPEN');
  assert.strictEqual(bossTicket.installation_id, INSTALL_ID);

  // Verify Audit Log entry created atomically
  const auditLogs = queryRawJson<Array<{ action: string; resource_type: string; resource_id: string; result: string; user_id: string }>>(`
    SELECT action, resource_type, resource_id, result, user_id FROM public.audit_logs
    WHERE company_id = '${COMPANY_A}' AND resource_id = '${bossTicket.id}';
  `);
  assert.strictEqual(auditLogs.length, 1, 'Audit log entry must be created atomically');
  assert.strictEqual(auditLogs[0].action, 'CREATE_WARRANTY_TICKET');
  assert.strictEqual(auditLogs[0].resource_type, 'warranty_tickets');
  assert.strictEqual(auditLogs[0].result, 'SUCCESS');
  assert.strictEqual(auditLogs[0].user_id, BOSS_A);
  testPass('P1-003: BOSS_ADMIN creates valid warranty ticket with atomic audit log entry');

  // 7. Idempotent retry returns same ticket deterministically
  const { data: retryTicket, error: retryTicketErr } = await adminClient.rpc('create_warranty_ticket_atomic', {
    p_company_id: COMPANY_A,
    p_actor_id: BOSS_A,
    p_customer_id: CUSTOMER_A,
    p_order_id: ORDER_B,
    p_installation_id: INSTALL_ID,
    p_issue: 'Gasket wear after flood season',
    p_notes: 'Customer requested inspection',
    p_idempotency_key: `IDEMP_BOSS_${RUN_ID}`,
  });
  assert(!retryTicketErr);
  assert.strictEqual(retryTicket.id, bossTicket.id, 'Idempotent retry must return existing ticket');
  testPass('P1-003: Idempotent retry returns existing ticket without duplicating records');

  // 8. SALE creates valid warranty ticket via TypeScript service wrapper -> SUCCESS
  const saleTicketInput: CreateWarrantyTicketInput = {
    customerId: CUSTOMER_A,
    orderId: ORDER_B,
    issue: 'Handle looseness',
    notes: 'Reported by customer over phone',
  };
  const saleTicketDTO = await createWarrantyTicket(COMPANY_A, saleTicketInput, undefined, SALE_A);
  assert.ok(saleTicketDTO.id);
  assert.strictEqual(saleTicketDTO.status, 'OPEN');
  assert.strictEqual(saleTicketDTO.installationId, INSTALL_ID, 'Installation must be automatically derived');

  const saleAuditLogs = queryRawJson<Array<{ action: string; user_id: string }>>(`
    SELECT action, user_id FROM public.audit_logs
    WHERE company_id = '${COMPANY_A}' AND resource_id = '${saleTicketDTO.id}';
  `);
  assert.strictEqual(saleAuditLogs.length, 1);
  assert.strictEqual(saleAuditLogs[0].user_id, SALE_A);
  testPass('P1-003: SALE creates valid warranty ticket via service with auto-derived installation and audit log');

  // 9. Injected audit failure rolls back warranty ticket creation completely
  execSync(`docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "
    CREATE OR REPLACE FUNCTION public.test_warranty_audit_fail() RETURNS trigger LANGUAGE plpgsql AS \\$\\$
    BEGIN
      IF NEW.action = 'CREATE_WARRANTY_TICKET' AND NEW.metadata->>'idempotency_key' = 'TRIGGER_AUDIT_FAILURE' THEN
        RAISE EXCEPTION 'INJECTED_AUDIT_FAILURE';
      END IF;
      RETURN NEW;
    END;
    \\$\\$;
    DROP TRIGGER IF EXISTS trg_test_warranty_audit_fail ON public.audit_logs;
    CREATE TRIGGER trg_test_warranty_audit_fail BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.test_warranty_audit_fail();
  "`);

  try {
    const { error: injectErr } = await adminClient.rpc('create_warranty_ticket_atomic', {
      p_company_id: COMPANY_A,
      p_actor_id: BOSS_A,
      p_customer_id: CUSTOMER_A,
      p_order_id: ORDER_B,
      p_installation_id: INSTALL_ID,
      p_issue: 'Test rollback on audit failure',
      p_idempotency_key: 'TRIGGER_AUDIT_FAILURE',
    });
    assert.ok(injectErr && injectErr.message.includes('INJECTED_AUDIT_FAILURE'));

    const uncommittedTickets = queryRawJson<Array<{ id: string }>>(`
      SELECT id FROM public.warranty_tickets WHERE issue = 'Test rollback on audit failure';
    `);
    assert.strictEqual(uncommittedTickets.length, 0, 'Warranty ticket must roll back when audit log fails');
    testPass('P1-003: Injected audit log failure rolls back warranty ticket creation completely');
  } finally {
    execSync(`docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "
      DROP TRIGGER IF EXISTS trg_test_warranty_audit_fail ON public.audit_logs;
      DROP FUNCTION IF EXISTS public.test_warranty_audit_fail();
    "`);
  }

  console.log('\n================================================================');
  console.log(`SYSTEM-AUDIT P1 BACKEND REGRESSION SUITE: ALL ${passCount} PASSED`);
  console.log('================================================================');
}

runP1BackendRegressionTests().catch((err) => {
  console.error('[FATAL] P1 Backend Regression Test failed:', err);
  process.exit(1);
});
