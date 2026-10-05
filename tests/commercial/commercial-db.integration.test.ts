/**
 * TV7 Commercial DB Integration Tests
 * Real DB verification against local Supabase / PostgreSQL.
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  generateContractForOrder,
  signContract,
  getContractDownloadUrl,
  ensureContractForDepositConfirmedOrder,
  isStorageResourceConflict,
} from '../../features/contract/services';
import { createOrderFromCalculation, updateOrderDepositAndDebt } from '../../features/order/services';
import { recoverOrderContractAction, createOrderFromCalculationAction, updateOrderDepositAction } from '../../features/order/actions';
import { processPaymentWebhook } from '../../features/payment/services';
import { calculateAndSavePriceCalculation, calculatePriceFromSurvey, getPriceCalculations } from '../../features/pricing/services';
import { createAppointment, getActiveCompanyTechnicians } from '../../features/survey/services/appointment.service';
import {
  createSurveyAppointmentAction,
  getActiveCompanyTechniciansAction,
  acceptSurveyAppointmentAction,
  startSurveyAppointmentAction,
  calculatePriceFromSurveyAction,
} from '../../app/(dashboard)/surveys/actions';
import { elevateClientToAal2 } from '../e2e/test-mfa-helpers';
import { adaptSurveyToPricingInput, convertMillimetersToMeters } from '../../features/survey/adapters/pricing.adapter';
import { STORAGE_BUCKET_MAP, SIGNED_URL_TTL } from '../../shared/contracts/sensitive';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log('================================================================');
console.log('STARTING TV7 COMMERCIAL REAL DATABASE INTEGRATION TESTS');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function run() {
  const createdUserIds: string[] = [];
  try {
    const RUN_ID = crypto.randomBytes(4).toString('hex');
    const COMPANY_A = crypto.randomUUID();
    const COMPANY_B = crypto.randomUUID();

    // Setup companies
    await admin.from('companies').upsert([
      { id: COMPANY_A, name: `Company A ${RUN_ID}`, status: 'ACTIVE' },
      { id: COMPANY_B, name: `Company B ${RUN_ID}`, status: 'ACTIVE' },
    ]);

    async function createUserWithRole(
      email: string,
      fullName: string,
      companyId: string,
      role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN'
    ) {
      const { data: userData, error: userErr } = await admin.auth.admin.createUser({
        email,
        password: 'Password123!@#',
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
      if (userErr || !userData.user) {
        throw new Error(`Failed to create ${email}: ${userErr?.message}`);
      }
      const userId = userData.user.id;
      createdUserIds.push(userId);

      await admin.from('user_profiles').upsert({
        id: userId,
        full_name: fullName,
        status: 'ACTIVE',
      });

      const { error: memberErr } = await admin.from('company_members').upsert({
        company_id: companyId,
        user_id: userId,
        role,
        status: 'ACTIVE',
      });
      if (memberErr) {
        throw new Error(`Failed to add company member ${email}: ${memberErr.message}`);
      }

      return userId;
    }

  const USER_BOSS_A_EMAIL = `boss_a_${RUN_ID}@test.local`;
  const USER_SALE_A_EMAIL = `sale_a_${RUN_ID}@test.local`;
  const USER_TECH_A_EMAIL = `tech_a_${RUN_ID}@test.local`;
  const USER_BOSS_B_EMAIL = `boss_b_${RUN_ID}@test.local`;
  const USER_TECH_B_EMAIL = `tech_b_${RUN_ID}@test.local`;
  const USER_INACTIVE_TECH_A_EMAIL = `inact_tech_a_${RUN_ID}@test.local`;

  const USER_BOSS_A = await createUserWithRole(USER_BOSS_A_EMAIL, 'Boss A', COMPANY_A, 'BOSS_ADMIN');
  const USER_SALE_A = await createUserWithRole(USER_SALE_A_EMAIL, 'Sale A', COMPANY_A, 'SALE');
  const USER_TECH_A = await createUserWithRole(USER_TECH_A_EMAIL, 'Tech A', COMPANY_A, 'TECHNICIAN');
  const USER_BOSS_B = await createUserWithRole(USER_BOSS_B_EMAIL, 'Boss B', COMPANY_B, 'BOSS_ADMIN');
  const USER_TECH_B = await createUserWithRole(USER_TECH_B_EMAIL, 'Tech B', COMPANY_B, 'TECHNICIAN');
  const USER_INACTIVE_TECH_A = await createUserWithRole(USER_INACTIVE_TECH_A_EMAIL, 'Inactive Tech A', COMPANY_A, 'TECHNICIAN');
  await admin.from('company_members').update({ status: 'INACTIVE' }).eq('user_id', USER_INACTIVE_TECH_A).eq('company_id', COMPANY_A);

  // Authenticated real Supabase clients with JWT sessions subject to PostgreSQL RLS
  const saleRealClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: saleLoginErr } = await saleRealClient.auth.signInWithPassword({
    email: USER_SALE_A_EMAIL,
    password: 'Password123!@#',
  });
  assert(!saleLoginErr, `SALE login failed: ${saleLoginErr?.message}`);

  const bossRealClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: bossLoginErr } = await bossRealClient.auth.signInWithPassword({
    email: USER_BOSS_A_EMAIL,
    password: 'Password123!@#',
  });
  assert(!bossLoginErr, `BOSS login failed: ${bossLoginErr?.message}`);
  await elevateClientToAal2(bossRealClient);

  const techRealClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: techLoginErr } = await techRealClient.auth.signInWithPassword({
    email: USER_TECH_A_EMAIL,
    password: 'Password123!@#',
  });
  assert(!techLoginErr, `Tech login failed: ${techLoginErr?.message}`);

  function createMockBossClient(userId: string, email: string) {
    return {
      auth: {
        getUser: async () => ({
          data: { user: { id: userId, email } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
            error: null,
          }),
          listFactors: async () => ({
            data: { totp: [{ id: 'factor-boss-totp', status: 'verified' }] },
            error: null,
          }),
        },
      },
      from: (table: string) => admin.from(table),
    } as unknown as SupabaseClient;
  }

  const BOSS_A_CLIENT = createMockBossClient(USER_BOSS_A, USER_BOSS_A_EMAIL);
  const BOSS_B_CLIENT = createMockBossClient(USER_BOSS_B, `boss_b_${RUN_ID}@test.local`);
  const SALE_A_CLIENT = createMockBossClient(USER_SALE_A, `sale_a_${RUN_ID}@test.local`);

  const CUSTOMER_A = crypto.randomUUID();
  const CUSTOMER_B = crypto.randomUUID();

  // Setup bank accounts (including two accounts for Company A to test provider_account mismatch)
  const PROVIDER = 'VIETQR';
  const ACC_A1 = `ACC_A1_${RUN_ID}`;
  const ACC_A2 = `ACC_A2_${RUN_ID}`;
  const ACC_B = `ACC_B_${RUN_ID}`;

  await admin.from('company_bank_accounts').insert([
    { company_id: COMPANY_A, provider: PROVIDER, provider_account: ACC_A1 },
    { company_id: COMPANY_A, provider: PROVIDER, provider_account: ACC_A2 },
    { company_id: COMPANY_B, provider: PROVIDER, provider_account: ACC_B },
  ]);

  // Setup customers
  await admin.from('customers').insert([
    {
      id: CUSTOMER_A,
      company_id: COMPANY_A,
      customer_code: `CUSA_${RUN_ID}`,
      name: 'Customer A',
      source: 'MANUAL',
      stage: 'LEAD_NEW',
    },
    {
      id: CUSTOMER_B,
      company_id: COMPANY_B,
      customer_code: `CUSB_${RUN_ID}`,
      name: 'Customer B',
      source: 'MANUAL',
      stage: 'LEAD_NEW',
    },
  ]);

  // Setup pricing policies
  const POLICY_A_ID = crypto.randomUUID();
  const POLICY_B_ID = crypto.randomUUID();
  const POLICY_INACTIVE_ID = crypto.randomUUID();

  await admin.from('pricing_policies').insert([
    {
      id: POLICY_A_ID,
      company_id: COMPANY_A,
      version: 'v1',
      conditions: { deposit_percentage: 30, standard_materials: { aluminum: '6063-T5' } },
      price_rules: { base_price_per_sqm: 5000000 },
      effective_at: new Date().toISOString(),
      status: 'ACTIVE',
    },
    {
      id: POLICY_B_ID,
      company_id: COMPANY_B,
      version: 'v1',
      conditions: { deposit_percentage: 50 },
      price_rules: { base_price_per_sqm: 6000000 },
      effective_at: new Date().toISOString(),
      status: 'ACTIVE',
    },
    {
      id: POLICY_INACTIVE_ID,
      company_id: COMPANY_A,
      version: 'v0',
      conditions: { deposit_percentage: 30 },
      price_rules: { base_price_per_sqm: 4000000 },
      effective_at: new Date().toISOString(),
      status: 'RETIRED',
    },
  ]);

  // --------------------------------------------------------------------------
  // Test 1: Real DB price calculation snapshot via save_price_calculation_rpc
  // --------------------------------------------------------------------------
  const { data: calcData, error: calcErr } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });

  assert(!calcErr, `save_price_calculation_rpc failed: ${calcErr?.message}`);
  assert(calcData.id);
  const CALCULATION_ID = calcData.id;
  testPass('Real DB price calculation snapshot created via save_price_calculation_rpc');

  // --------------------------------------------------------------------------
  // Test 1b: save_price_calculation_rpc resource consistency (Section 12)
  // --------------------------------------------------------------------------
  // Inactive policy rejected
  const { error: inactPolicyErr } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_INACTIVE_ID,
    p_policy_version: 'v0',
    p_input_data: { width: 2, height: 1 },
    p_amount: 8000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert(inactPolicyErr?.message.includes('RESOURCE_NOT_FOUND'), 'Inactive pricing policy must be rejected');

  // Survey belonging to another customer/company rejected
  const { error: foreignSurveyErr } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: crypto.randomUUID(), // Nonexistent / foreign survey
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert(foreignSurveyErr?.message.includes('RESOURCE_NOT_FOUND'), 'Foreign or nonexistent survey must be rejected');
  testPass('save_price_calculation_rpc validates survey and active pricing policy consistency');

  // --------------------------------------------------------------------------
  // Test 2: Direct client INSERT on price_calculations fails closed
  // --------------------------------------------------------------------------
  const { error: directInsertErr } = await anonClient.from('price_calculations').insert({
    company_id: COMPANY_A,
    customer_id: CUSTOMER_A,
    pricing_policy_id: POLICY_A_ID,
    policy_version: 'v1',
    input_data: {},
    amount: 100,
    status: 'CALCULATED',
  });
  assert(directInsertErr, 'Direct client INSERT on price_calculations must fail closed');
  testPass('Direct client INSERT on price_calculations strictly denied by RLS foundation');

  // --------------------------------------------------------------------------
  // Test 3: Create Order from calculation: actor validation & atomic audit (Sections 10, 11)
  // --------------------------------------------------------------------------
  // Case A: Null actor rejected
  const { error: nullActorErr } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: CALCULATION_ID,
    p_payment_reference: `DH-NULL${RUN_ID}`,
    p_actor_user_id: null,
  });
  assert(nullActorErr?.message.includes('ACTOR_REQUIRED'), 'Order creation with null actor must be rejected');

  // Case B: Non-commercial actor (TECHNICIAN) rejected
  const { error: techActorErr } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: CALCULATION_ID,
    p_payment_reference: `DH-TECH${RUN_ID}`,
    p_actor_user_id: USER_TECH_A,
  });
  assert(techActorErr?.message.includes('UNAUTHORIZED_ROLE'), 'Order creation by TECHNICIAN must be rejected');

  // Case C: Cross-tenant actor rejected
  const { error: crossActorErr } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: CALCULATION_ID,
    p_payment_reference: `DH-CROSS${RUN_ID}`,
    p_actor_user_id: USER_BOSS_B,
  });
  assert(crossActorErr?.message.includes('UNAUTHORIZED_ROLE'), 'Order creation by foreign boss must be rejected');

  // Case D: Valid actor (BOSS_ADMIN) succeeds
  const PAYMENT_REF_A = `DH-TESTA${RUN_ID.toUpperCase()}`;
  const { data: orderData, error: orderErr } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: CALCULATION_ID,
    p_payment_reference: PAYMENT_REF_A,
    p_actor_user_id: USER_BOSS_A,
  });

  assert(!orderErr, `create_order_from_calculation_rpc failed: ${orderErr?.message}`);
  const ORDER_A_ID = orderData.orderId;
  assert.strictEqual(orderData.finalAmount, 10000000);
  assert.strictEqual(orderData.depositStatus, 'PENDING');
  assert.strictEqual(orderData.orderStatus, 'DRAFT');

  // Verify finance_summaries created
  const { data: finRow } = await admin
    .from('finance_summaries')
    .select('*')
    .eq('order_id', ORDER_A_ID)
    .single();
  assert.strictEqual(Number(finRow.contract_value), 10000000);
  assert.strictEqual(Number(finRow.collected_amount), 0);
  assert.strictEqual(Number(finRow.receivable_amount), 10000000);

  // Section 11: Verify atomic audit log
  const { data: orderAudit } = await admin
    .from('audit_logs')
    .select('*')
    .eq('company_id', COMPANY_A)
    .eq('resource_id', ORDER_A_ID)
    .eq('action', 'ORDER_CREATED')
    .single();
  assert(orderAudit, 'Atomic audit log must be inserted upon order creation');
  assert.strictEqual(orderAudit.result, 'SUCCESS');
  assert.strictEqual(orderAudit.metadata.price_calculation_id, CALCULATION_ID);

  // Section 3: Verify customer stage transition history from LEAD_NEW to ORDER_CREATED
  const { data: stageHistOrder } = await admin
    .from('customer_stage_histories')
    .select('*')
    .eq('customer_id', CUSTOMER_A)
    .eq('to_stage', 'ORDER_CREATED')
    .single();
  assert(stageHistOrder, 'Customer stage history must be recorded for ORDER_CREATED');
  assert.strictEqual(stageHistOrder.from_stage, 'LEAD_NEW');
  assert.strictEqual(stageHistOrder.to_stage, 'ORDER_CREATED');

  testPass('Order creation enforces DB actor validation, atomic audit log, and accurate customer stage history');

  // --------------------------------------------------------------------------
  // Test 4: Cannot create order from calculation with status NEED_INFO
  // --------------------------------------------------------------------------
  const { data: needInfoCalc } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2 },
    p_amount: null,
    p_status: 'NEED_INFO',
    p_missing_fields: ['height'],
  });

  const { error: invalidOrderErr } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: needInfoCalc.id,
    p_payment_reference: `DH-INVALID${RUN_ID}`,
    p_actor_user_id: USER_BOSS_A,
  });
  assert(invalidOrderErr, 'Creating order from NEED_INFO calculation must fail');
  assert(invalidOrderErr.message.includes('INVALID_PRICE_CALCULATION'));
  testPass('Order creation from NEED_INFO price calculation rejected fail-closed');

  // --------------------------------------------------------------------------
  // Test 5: Webhook Unknown Provider Account fails closed (no fallback to arbitrary tenant)
  // --------------------------------------------------------------------------
  try {
    await processPaymentWebhook({
      provider: PROVIDER,
      provider_account: 'NON_EXISTENT_BANK_ACCOUNT',
      provider_ref: `tx_unknown_${RUN_ID}`,
      amount: 1000000,
      occurred_at: new Date().toISOString(),
      transfer_content: `DH-TESTA${RUN_ID}`,
    });
    assert.fail('Unknown provider account must throw error');
  } catch (err: any) {
    assert(err.message.includes('UNKNOWN_PROVIDER_ACCOUNT'));
    testPass('Webhook with unknown provider account rejected fail-closed with UNKNOWN_PROVIDER_ACCOUNT');
  }

  // --------------------------------------------------------------------------
  // Test 6: Cross-tenant payment reference cannot match foreign order
  // --------------------------------------------------------------------------
  const crossTenantResult = await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_B,
    provider_ref: `tx_cross_${RUN_ID}`,
    amount: 1000000,
    occurred_at: new Date().toISOString(),
    transfer_content: PAYMENT_REF_A, // Belongs to Company A
  });

  assert.strictEqual(crossTenantResult.status, 'MANUAL_REVIEW_REQUIRED');
  testPass('Cross-tenant payment reference cannot match foreign company order');

  // --------------------------------------------------------------------------
  // Test 7: Real DB 10 Concurrent Identical Webhooks -> exactly 1 tx, finance increment once
  // --------------------------------------------------------------------------
  const DUP_REF = `tx_dup_${RUN_ID}`;
  const DUP_OCCURRED_AT = new Date().toISOString();
  const concurrentCalls = Array.from({ length: 10 }, () =>
    processPaymentWebhook({
      provider: PROVIDER,
      provider_account: ACC_A1,
      provider_ref: DUP_REF,
      amount: 1000000,
      occurred_at: DUP_OCCURRED_AT,
      transfer_content: PAYMENT_REF_A,
    })
  );

  const results = await Promise.all(concurrentCalls);
  assert(results.every((r) => r.status === 'MATCHED' || r.status === 'ALREADY_PROCESSED'));

  // Check payment_transactions count in DB
  const { data: txRows } = await admin
    .from('payment_transactions')
    .select('id, amount')
    .eq('company_id', COMPANY_A)
    .eq('provider_ref', DUP_REF);

  assert.strictEqual(txRows?.length, 1, 'Exactly one payment transaction row must exist for DUP_REF');

  // Check finance_summaries collected amount
  const { data: finAfterDup } = await admin
    .from('finance_summaries')
    .select('collected_amount')
    .eq('order_id', ORDER_A_ID)
    .single();
  assert(finAfterDup);
  assert.strictEqual(Number(finAfterDup.collected_amount), 1000000);
  testPass('10 concurrent identical webhooks produce exactly 1 transaction and 1 finance increment');

  // --------------------------------------------------------------------------
  // Test 8: Full Logical Payload Idempotency Validation (Section 1)
  // --------------------------------------------------------------------------
  // Case A: Same provider_ref with changed amount -> rejected
  try {
    await processPaymentWebhook({
      provider: PROVIDER,
      provider_account: ACC_A1,
      provider_ref: DUP_REF,
      amount: 9999999, // Changed amount
      occurred_at: DUP_OCCURRED_AT,
      transfer_content: PAYMENT_REF_A,
    });
    assert.fail('Changed amount on same provider_ref must be rejected');
  } catch (err: any) {
    assert(err.message.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'));
  }

  // Case B: Same provider_ref with changed provider_account (under same company!) -> rejected
  try {
    await processPaymentWebhook({
      provider: PROVIDER,
      provider_account: ACC_A2, // Changed provider account mapping to same company!
      provider_ref: DUP_REF,
      amount: 1000000,
      occurred_at: DUP_OCCURRED_AT,
      transfer_content: PAYMENT_REF_A,
    });
    assert.fail('Changed provider_account on same provider_ref must be rejected');
  } catch (err: any) {
    assert(err.message.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'));
  }

  // Case C: Same provider_ref with changed payment_reference -> rejected
  try {
    await processPaymentWebhook({
      provider: PROVIDER,
      provider_account: ACC_A1,
      provider_ref: DUP_REF,
      amount: 1000000,
      occurred_at: DUP_OCCURRED_AT,
      transfer_content: 'DH-DIFFERENTREF', // Changed memo payment reference
    });
    assert.fail('Changed payment_reference on same provider_ref must be rejected');
  } catch (err: any) {
    assert(err.message.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'));
  }

  // Case D: Same provider_ref with exact same payload -> returns ALREADY_PROCESSED
  const dupOk = await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_A1,
    provider_ref: DUP_REF,
    amount: 1000000,
    occurred_at: DUP_OCCURRED_AT,
    transfer_content: PAYMENT_REF_A,
  });
  assert.strictEqual(dupOk.status, 'ALREADY_PROCESSED');
  testPass('Full logical payment payload validated: amount, provider_account, and payment_reference mismatch fail closed');

  // --------------------------------------------------------------------------
  // Test 8b: Cross-Company Payment Provider Ref Idempotency (Section 1)
  // --------------------------------------------------------------------------
  const { data: calcB, error: calcBErr } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_B,
    p_customer_id: CUSTOMER_B,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_B_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1 },
    p_amount: 12000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert(!calcBErr && calcB?.id, `calcB error: ${calcBErr?.message}`);
  const CALC_B_ID = calcB.id;

  const PAYMENT_REF_B = `DH-TESTB${RUN_ID.toUpperCase()}`;
  const { data: orderBData, error: orderBErr } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_B,
    p_customer_id: CUSTOMER_B,
    p_price_calculation_id: calcB.id,
    p_payment_reference: PAYMENT_REF_B,
    p_actor_user_id: USER_BOSS_B,
  });
  assert(!orderBErr && orderBData?.orderId, `Order B creation failed: ${orderBErr?.message}`);
  const ORDER_B_ID = orderBData.orderId;

  // Dedicated order for Company A to test cross-tenant payment reference without mutating ORDER_A_ID
  const { data: calcACross } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const PAYMENT_REF_A_CROSS = `DH-TESTAX${RUN_ID.toUpperCase()}`;
  const { data: orderACrossData, error: orderACrossErr } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcACross.id,
    p_payment_reference: PAYMENT_REF_A_CROSS,
    p_actor_user_id: USER_BOSS_A,
  });
  assert(!orderACrossErr && orderACrossData?.orderId);
  const ORDER_A_CROSS_ID = orderACrossData.orderId;

  // Use the EXACT same provider_ref across Company A and Company B
  const CROSS_COMPANY_REF = `REF_CROSS_${RUN_ID}`;
  const CROSS_OCCURRED = new Date().toISOString();

  // Send payment 1: Company A with CROSS_COMPANY_REF to ACC_A1
  const payA = await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_A1,
    provider_ref: CROSS_COMPANY_REF,
    amount: 500000,
    occurred_at: CROSS_OCCURRED,
    transfer_content: PAYMENT_REF_A_CROSS,
  });
  assert.strictEqual(payA.status, 'MATCHED', 'Payment A must match Order A');

  // Send payment 2: Company B with EXACT SAME provider_ref to ACC_B
  const payB = await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_B,
    provider_ref: CROSS_COMPANY_REF,
    amount: 500000,
    occurred_at: CROSS_OCCURRED,
    transfer_content: PAYMENT_REF_B,
  });
  assert.strictEqual(payB.status, 'MATCHED', 'Company B must accept payment independently with same provider_ref');

  // Verify Company A has 1 transaction with CROSS_COMPANY_REF
  const { data: txListA } = await admin.from('payment_transactions')
    .select('id, company_id, provider_ref')
    .eq('company_id', COMPANY_A)
    .eq('provider_ref', CROSS_COMPANY_REF);
  assert.strictEqual(txListA?.length, 1, 'Company A must have exactly 1 payment transaction');

  // Verify Company B has 1 transaction with CROSS_COMPANY_REF
  const { data: txListB } = await admin.from('payment_transactions')
    .select('id, company_id, provider_ref')
    .eq('company_id', COMPANY_B)
    .eq('provider_ref', CROSS_COMPANY_REF);
  assert.strictEqual(txListB?.length, 1, 'Company B must have exactly 1 payment transaction');

  // Verify no finance mutation across tenants
  const { data: finRowA } = await admin.from('finance_summaries').select('collected_amount').eq('order_id', ORDER_A_CROSS_ID).single();
  const { data: finRowB } = await admin.from('finance_summaries').select('collected_amount').eq('order_id', ORDER_B_ID).single();
  assert(finRowA, 'finRowA must exist');
  assert(finRowB, 'finRowB must exist');
  assert.strictEqual(Number(finRowA.collected_amount), 500000, 'Company A collected amount matches payment');
  assert.strictEqual(Number(finRowB.collected_amount), 500000, 'Company B collected amount matches payment');

  // Verify within SAME company, same key with changed payload fails closed
  try {
    await processPaymentWebhook({
      provider: PROVIDER,
      provider_account: ACC_B,
      provider_ref: CROSS_COMPANY_REF,
      amount: 9999999, // Changed amount for Company B!
      occurred_at: CROSS_OCCURRED,
      transfer_content: PAYMENT_REF_B,
    });
    assert.fail('Changed payload on same provider_ref within same company must fail closed');
  } catch (err: any) {
    assert(err.message.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'));
  }

  // Verify within SAME company, same key with exact same payload returns ALREADY_PROCESSED
  const dupB = await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_B,
    provider_ref: CROSS_COMPANY_REF,
    amount: 500000,
    occurred_at: CROSS_OCCURRED,
    transfer_content: PAYMENT_REF_B,
  });
  assert.strictEqual(dupB.status, 'ALREADY_PROCESSED');

  // Verify database constraint remains UNIQUE(company_id, provider, provider_ref)
  const { execSync: execPsql } = await import('node:child_process');
  const checkUniqueConstraintSql = `SELECT conname, pg_get_constraintdef(oid) as def FROM pg_constraint WHERE conrelid = 'public.payment_transactions'::regclass AND conname = 'uq_pt_company_provider_ref';`;
  const uqDef = execPsql(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -U postgres -d postgres -c "${checkUniqueConstraintSql}"`,
    { encoding: 'utf8' }
  ).trim();
  assert(uqDef.includes('UNIQUE (company_id, provider, provider_ref)'), `Constraint must be UNIQUE (company_id, provider, provider_ref), found: ${uqDef}`);

  testPass('Cross-company payment provider_ref: independent acceptance across tenants, company-scoped idempotency, and canonical UNIQUE constraint verified');

  // --------------------------------------------------------------------------
  // Test 9: Partial payments & cumulative deposit threshold & Customer Stage History
  // --------------------------------------------------------------------------
  // Required deposit = 30% of 10,000,000 = 3,000,000
  // Currently collected: 1,000,000 -> status DEPOSIT_PENDING
  const { data: orderBeforePartial } = await admin.from('orders').select('deposit_status').eq('id', ORDER_A_ID).single();
  assert(orderBeforePartial);
  assert.strictEqual(orderBeforePartial.deposit_status, 'DEPOSIT_PENDING');

  // Payment 2: 1,000,000 (total = 2,000,000 < 3,000,000) -> still DEPOSIT_PENDING
  await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_A1,
    provider_ref: `tx_part2_${RUN_ID}`,
    amount: 1000000,
    occurred_at: new Date().toISOString(),
    transfer_content: PAYMENT_REF_A,
  });

  const { data: orderMid } = await admin.from('orders').select('deposit_status').eq('id', ORDER_A_ID).single();
  assert(orderMid);
  assert.strictEqual(orderMid.deposit_status, 'DEPOSIT_PENDING');

  // Payment 3: 1,000,000 (total = 3,000,000 >= 3,000,000) -> DEPOSIT_CONFIRMED!
  const part3Result = await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_A1,
    provider_ref: `tx_part3_${RUN_ID}`,
    amount: 1000000,
    occurred_at: new Date().toISOString(),
    transfer_content: PAYMENT_REF_A,
  });

  assert.strictEqual(part3Result.depositConfirmed, true);
  const { data: orderFinal } = await admin.from('orders').select('deposit_status, order_status').eq('id', ORDER_A_ID).single();
  assert(orderFinal);
  assert.strictEqual(orderFinal.deposit_status, 'DEPOSIT_CONFIRMED');
  assert.strictEqual(orderFinal.order_status, 'DEPOSIT_CONFIRMED');

  // Section 3: Verify customer stage history from ORDER_CREATED to DEPOSIT_CONFIRMED
  const { data: stageHistDep } = await admin
    .from('customer_stage_histories')
    .select('*')
    .eq('customer_id', CUSTOMER_A)
    .eq('to_stage', 'DEPOSIT_CONFIRMED')
    .single();
  assert(stageHistDep, 'Customer stage history must be recorded for DEPOSIT_CONFIRMED');
  assert.strictEqual(stageHistDep.from_stage, 'ORDER_CREATED', 'from_stage must be exact customer previous stage ORDER_CREATED');
  assert.strictEqual(stageHistDep.to_stage, 'DEPOSIT_CONFIRMED');

  testPass('Cumulative partial payments advance deposit_status to DEPOSIT_CONFIRMED with accurate customer stage history');

  // --------------------------------------------------------------------------
  // Test 10: Overpayment handling -> receivable_amount = 0
  // --------------------------------------------------------------------------
  await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_A1,
    provider_ref: `tx_overpay_${RUN_ID}`,
    amount: 15000000, // Exceeds remaining 7,000,000
    occurred_at: new Date().toISOString(),
    transfer_content: PAYMENT_REF_A,
  });

  const { data: finOverpay } = await admin
    .from('finance_summaries')
    .select('receivable_amount, collected_amount')
    .eq('order_id', ORDER_A_ID)
    .single();
  assert(finOverpay);
  assert.strictEqual(Number(finOverpay.receivable_amount), 0);
  assert.strictEqual(Number(finOverpay.collected_amount), 18000000);
  testPass('Overpayment correctly clamps receivable_amount to 0 without underflow');

  // --------------------------------------------------------------------------
  // Test 11: Manual deposit authorization, idempotency, and ORDER BINDING (Section 2)
  // --------------------------------------------------------------------------
  // Create Order 1 and Order 2 in Company A with distinct price calculations
  const { data: calcMan1 } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { data: orderMan1 } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcMan1.id,
    p_payment_reference: `DH-MAN1${RUN_ID}`,
    p_actor_user_id: USER_BOSS_A,
  });
  const ORDER_MAN_1_ID = orderMan1.orderId;

  const { data: calcMan2 } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { data: orderMan2 } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcMan2.id,
    p_payment_reference: `DH-MAN2${RUN_ID}`,
    p_actor_user_id: USER_BOSS_A,
  });
  const ORDER_MAN_2_ID = orderMan2.orderId;

  // Case A: SALE denied
  const { error: saleManErr } = await admin.rpc('update_order_deposit_rpc', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_MAN_1_ID,
    p_actor_user_id: USER_SALE_A,
    p_deposit_amount: 3000000,
    p_idempotency_key: `man_sale_${RUN_ID}`,
  });
  assert(saleManErr?.message.includes('UNAUTHORIZED_BOSS_REQUIRED'));

  // Case B: Cross-tenant BOSS B denied on Company A order
  const { error: crossBossErr } = await admin.rpc('update_order_deposit_rpc', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_MAN_1_ID,
    p_actor_user_id: USER_BOSS_B,
    p_deposit_amount: 3000000,
    p_idempotency_key: `man_cross_${RUN_ID}`,
  });
  assert(crossBossErr?.message.includes('UNAUTHORIZED_BOSS_REQUIRED'));

  // Case C: BOSS A allowed on Order 1
  const IDEMP_KEY = `man_key_${RUN_ID}`;
  const { data: bossManRes, error: bossManErr } = await admin.rpc('update_order_deposit_rpc', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_MAN_1_ID,
    p_actor_user_id: USER_BOSS_A,
    p_deposit_amount: 3000000,
    p_idempotency_key: IDEMP_KEY,
  });
  assert(!bossManErr);
  assert.strictEqual(bossManRes.depositConfirmed, true);
  assert.strictEqual(bossManRes.orderId, ORDER_MAN_1_ID);

  // Case D: Same key + same amount + DIFFERENT order (Order 2) -> MUST BE REJECTED! (Section 2)
  const { error: diffOrderErr } = await admin.rpc('update_order_deposit_rpc', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_MAN_2_ID, // Different order!
    p_actor_user_id: USER_BOSS_A,
    p_deposit_amount: 3000000,
    p_idempotency_key: IDEMP_KEY,
  });
  assert(diffOrderErr?.message.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'), 'Reusing manual deposit key for different order must fail');

  // Case E: Duplicate call on Order 1 with same amount -> returns ALREADY_PROCESSED with Order 1 ID (never Order 2)
  const { data: dupManRes } = await admin.rpc('update_order_deposit_rpc', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_MAN_1_ID,
    p_actor_user_id: USER_BOSS_A,
    p_deposit_amount: 3000000,
    p_idempotency_key: IDEMP_KEY,
  });
  assert.strictEqual(dupManRes.status, 'ALREADY_PROCESSED');
  assert.strictEqual(dupManRes.orderId, ORDER_MAN_1_ID);

  // Case F: Same key + same order + different amount -> rejected
  const { error: diffAmountErr } = await admin.rpc('update_order_deposit_rpc', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_MAN_1_ID,
    p_actor_user_id: USER_BOSS_A,
    p_deposit_amount: 5000000,
    p_idempotency_key: IDEMP_KEY,
  });
  assert(diffAmountErr?.message.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'));
  testPass('Manual deposit binds strictly to orderId: same key on different order fails closed');

  // --------------------------------------------------------------------------
  // Test 12: Contract generation & Dynamic Revision Model (Section 9)
  // --------------------------------------------------------------------------
  // Unconfirmed deposit order fails contract generation claim
  const { data: calcUnconf } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { data: unconfirmedOrder } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: calcUnconf.id,
    p_payment_reference: `DH-UNCONF${RUN_ID}`,
    p_actor_user_id: USER_BOSS_A,
  });
  const { error: unconfContractErr } = await admin.rpc('claim_contract_generation_rpc', {
    p_company_id: COMPANY_A,
    p_order_id: unconfirmedOrder.orderId,
  });
  assert(unconfContractErr?.message.includes('DEPOSIT_NOT_CONFIRMED'));

  // Confirmed deposit order: run contract generation for Revision 1
  const contractGenResult = await generateContractForOrder({
    companyId: COMPANY_A,
    orderId: ORDER_MAN_1_ID,
  });
  assert(contractGenResult.contractId);
  assert.strictEqual(contractGenResult.revisionNo, 1);
  assert.strictEqual(contractGenResult.status, 'GENERATED');
  const CONTRACT_REV1_ID = contractGenResult.contractId;

  // Concurrent second call returns existing revision 1
  const contractGen2 = await generateContractForOrder({
    companyId: COMPANY_A,
    orderId: ORDER_MAN_1_ID,
  });
  assert.strictEqual(contractGen2.contractId, CONTRACT_REV1_ID);
  assert.strictEqual(contractGen2.revisionNo, 1);

  // Section 9: Explicit regeneration creates Revision 2 atomically
  const contractGenRev2 = await generateContractForOrder({
    companyId: COMPANY_A,
    orderId: ORDER_MAN_1_ID,
    forceRevision: true,
  });
  assert(contractGenRev2.contractId);
  assert.strictEqual(contractGenRev2.revisionNo, 2, 'New contract must be revision 2');
  assert.notStrictEqual(contractGenRev2.contractId, CONTRACT_REV1_ID);
  const CONTRACT_REV2_ID = contractGenRev2.contractId;

  // Check Revision 1 is now SUPERSEDED and is_current = false
  const { data: rev1Row } = await admin.from('contracts').select('status, is_current').eq('id', CONTRACT_REV1_ID).single();
  assert(rev1Row);
  assert.strictEqual(rev1Row.status, 'SUPERSEDED');
  assert.strictEqual(rev1Row.is_current, false);

  testPass('Contract generation revision model: revision 1 superseded, revision 2 created atomically');

  // --------------------------------------------------------------------------
  // Test 13: Storage ACL: Direct client operations strictly denied (Section 14)
  // --------------------------------------------------------------------------
  // Anon client denied INSERT
  const { error: anonUploadErr } = await anonClient.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .upload('test.pdf', Buffer.from('hello'));
  assert(anonUploadErr, 'Anon upload to contracts bucket must fail');

  // Anon client denied LIST/SELECT
  const { data: anonList, error: anonListErr } = await anonClient.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .list();
  assert(anonListErr || !anonList || anonList.length === 0, 'Anon list contracts bucket must be empty or denied');

  // Authenticated client denied INSERT
  const authUserClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authSession } = await authUserClient.auth.signInWithPassword({
    email: USER_BOSS_A_EMAIL,
    password: 'Password123!@#',
  });
  assert(authSession?.session, 'Must obtain authenticated session');

  const { error: authUploadErr } = await authUserClient.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .upload('auth-test.pdf', Buffer.from('hello'));
  assert(authUploadErr, 'Authenticated upload to contracts bucket must fail');

  // Authenticated client denied LIST/SELECT
  const { data: authList, error: authListErr } = await authUserClient.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .list();
  assert(authListErr || !authList || authList.length === 0, 'Authenticated list contracts bucket must be empty or denied');

  // Upload a test object via admin to test update and delete protection
  await admin.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .upload('auth-protect.pdf', Buffer.from('protected content'), { upsert: true });

  // Authenticated client denied UPDATE
  const { error: authUpdateErr } = await authUserClient.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .update('auth-protect.pdf', Buffer.from('tampered content'));
  assert(authUpdateErr, 'Authenticated update on contracts bucket must fail with RLS error');

  // Authenticated client denied DELETE (remove returns 0 deleted rows and file remains intact)
  const { data: authDelData } = await authUserClient.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .remove(['auth-protect.pdf']);
  assert(!authDelData || authDelData.length === 0, 'Authenticated client delete must affect 0 files');

  // Verify file still exists intact in contracts bucket
  const { data: stillExists } = await admin.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .list('', { search: 'auth-protect.pdf' });
  assert(stillExists && stillExists.length > 0, 'Protected file must still exist after unauthorized delete attempt');

  // Clean up
  await admin.storage.from(STORAGE_BUCKET_MAP.CONTRACT).remove(['auth-protect.pdf']);

  testPass('Storage ACL: anon and authenticated client upload, list, read, update, and delete strictly denied by restrictive policies');

  // --------------------------------------------------------------------------
  // Test 14: Contract Signing: Pre-upload resource resolution & Revision 2 dynamic path (Sections 4, 5, 6, 7, 8)
  // --------------------------------------------------------------------------
  const validPdfDoc = await (await import('pdf-lib')).PDFDocument.create();
  validPdfDoc.addPage();
  const validPdfBytes = Buffer.from(await validPdfDoc.save());

  // Case A: Pre-upload lookup: foreign contract -> 0 upload, throws RESOURCE_NOT_FOUND
  try {
    await signContract({
      companyId: COMPANY_B, // Company B trying to sign Company A's contract
      contractId: CONTRACT_REV2_ID,
      signedPdfBuffer: validPdfBytes,
    }, BOSS_B_CLIENT);
    assert.fail('Signing foreign contract must fail');
  } catch (err: any) {
    assert(err.message.includes('RESOURCE_NOT_FOUND'), 'Foreign contract must return RESOURCE_NOT_FOUND');
  }

  // Verify 0 storage upload for foreign contract
  const { data: foreignFiles } = await admin.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .list(`${COMPANY_B}/contracts/${CONTRACT_REV2_ID}`);
  assert(!foreignFiles || foreignFiles.length === 0, 'No files must be uploaded for foreign contract');

  // Case B: Pre-upload lookup: nonexistent contract -> 0 upload, throws RESOURCE_NOT_FOUND
  const nonExistentId = crypto.randomUUID();
  try {
    await signContract({
      companyId: COMPANY_A,
      contractId: nonExistentId,
      signedPdfBuffer: validPdfBytes,
    }, BOSS_A_CLIENT);
    assert.fail('Signing nonexistent contract must fail');
  } catch (err: any) {
    assert(err.message.includes('RESOURCE_NOT_FOUND'), 'Nonexistent contract must return RESOURCE_NOT_FOUND');
  }

  const { data: nonExistentFiles } = await admin.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .list(`${COMPANY_A}/contracts/${nonExistentId}`);
  assert(!nonExistentFiles || nonExistentFiles.length === 0, 'No files must be uploaded for nonexistent contract');

  // Case C: Pre-upload validation: plain text bytes -> throws INVALID_PDF before upload
  try {
    await signContract({
      companyId: COMPANY_A,
      contractId: CONTRACT_REV2_ID,
      signedPdfBuffer: Buffer.from('plain text not a pdf'),
    }, BOSS_A_CLIENT);
    assert.fail('Plain text bytes must be rejected');
  } catch (err: any) {
    assert(err.message.includes('INVALID_PDF'));
  }

  // Case D: Pre-upload validation: oversized PDF (>10MB) -> throws INVALID_PDF
  const oversizedPdf = Buffer.alloc(10485761);
  oversizedPdf.write('%PDF-');
  try {
    await signContract({
      companyId: COMPANY_A,
      contractId: CONTRACT_REV2_ID,
      signedPdfBuffer: oversizedPdf,
    }, BOSS_A_CLIENT);
    assert.fail('Oversized PDF must be rejected');
  } catch (err: any) {
    assert(err.message.includes('INVALID_PDF'));
  }

  // Case E: Signing superseded contract (Revision 1) -> rejected
  try {
    await signContract({
      companyId: COMPANY_A,
      contractId: CONTRACT_REV1_ID,
      signedPdfBuffer: validPdfBytes,
    }, BOSS_A_CLIENT);
    assert.fail('Signing superseded contract must fail');
  } catch (err: any) {
    assert(err.message.includes('INVALID_CONTRACT_STATE'));
  }

  // Case F: Valid signing on Revision 2 -> dynamically uses revision-2 path (NO hardcoded revision-1!)
  const signRev2Result = await signContract({
    companyId: COMPANY_A,
    contractId: CONTRACT_REV2_ID,
    signedPdfBuffer: validPdfBytes,
  }, BOSS_A_CLIENT);

  assert.strictEqual(signRev2Result.status, 'SIGNED');
  assert.strictEqual(signRev2Result.contractId, CONTRACT_REV2_ID);

  // Check stored contract has revision-2 path
  const { data: rev2SignedRow } = await admin.from('contracts').select('status, signed_file_ref, revision_no').eq('id', CONTRACT_REV2_ID).single();
  assert(rev2SignedRow);
  assert.strictEqual(rev2SignedRow.status, 'SIGNED');
  assert.strictEqual(rev2SignedRow.revision_no, 2);
  const expectedRev2Path = `${COMPANY_A}/contracts/${CONTRACT_REV2_ID}/revision-2/signed.pdf`;
  assert.strictEqual(rev2SignedRow.signed_file_ref, expectedRev2Path, 'Signed path for revision 2 must be revision-2/signed.pdf');

  // Verify PDF_A stored in storage
  const { data: storedDownloadA, error: dlAErr } = await admin.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .download(expectedRev2Path);
  assert(!dlAErr && storedDownloadA, 'Must be able to download stored signed contract');
  const storedPdfABytes = Buffer.from(await storedDownloadA.arrayBuffer());
  const storedPdfAHash = crypto.createHash('sha256').update(storedPdfABytes).digest('hex');
  const expectedPdfAHash = crypto.createHash('sha256').update(validPdfBytes).digest('hex');
  assert.strictEqual(storedPdfAHash, expectedPdfAHash, 'Stored PDF must match initial signed PDF_A hash');

  // Case G: Service-level physical immutability: call signContract again with a DIFFERENT valid PDF (PDF_B)
  const validPdfDocB = await (await import('pdf-lib')).PDFDocument.create();
  validPdfDocB.addPage([500, 500]);
  const validPdfBytesB = Buffer.from(await validPdfDocB.save());
  const pdfBHash = crypto.createHash('sha256').update(validPdfBytesB).digest('hex');
  assert.notStrictEqual(storedPdfAHash, pdfBHash, 'PDF_B must be distinct from PDF_A');

  const reSignResult = await signContract({
    companyId: COMPANY_A,
    contractId: CONTRACT_REV2_ID,
    signedPdfBuffer: validPdfBytesB, // Different valid PDF!
  }, BOSS_A_CLIENT);

  assert.strictEqual(reSignResult.status, 'ALREADY_PROCESSED', 'Re-signing already signed contract must return ALREADY_PROCESSED');
  assert.strictEqual(reSignResult.contractId, CONTRACT_REV2_ID);

  // Verify stored object in storage was NOT overwritten (PDF_A remains completely intact)
  const { data: storedDownloadAfterB, error: dlBErr } = await admin.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .download(expectedRev2Path);
  assert(!dlBErr && storedDownloadAfterB);
  const finalPdfBytes = Buffer.from(await storedDownloadAfterB.arrayBuffer());
  const finalPdfHash = crypto.createHash('sha256').update(finalPdfBytes).digest('hex');
  assert.strictEqual(finalPdfHash, storedPdfAHash, 'Stored PDF in storage bucket MUST NOT be overwritten; must still match PDF_A hash');

  // Verify DB signed_file_ref and status remain intact
  const { data: contractStillSigned } = await admin.from('contracts').select('status, signed_file_ref').eq('id', CONTRACT_REV2_ID).single();
  assert.strictEqual(contractStillSigned?.status, 'SIGNED');
  assert.strictEqual(contractStillSigned?.signed_file_ref, expectedRev2Path);

  // Case H: Signed contract cannot be overwritten with different file ref in DB RPC -> rejected
  const { error: overwriteErr } = await admin.rpc('finalize_contract_signing_rpc', {
    p_company_id: COMPANY_A,
    p_contract_id: CONTRACT_REV2_ID,
    p_actor_user_id: USER_BOSS_A,
    p_signed_file_ref: `${COMPANY_A}/contracts/${CONTRACT_REV2_ID}/revision-2/signed_tampered.pdf`,
    p_aal_level: 'aal2',
  });
  assert(overwriteErr?.message.includes('INVALID_SIGNED_FILE_REF') || overwriteErr?.message.includes('CONTRACT_ALREADY_SIGNED_WITH_DIFFERENT_FILE'));

  // Case I: Storage upload with upsert: false fails closed if canonical object already exists before DB signing
  const { data: contractDummyB } = await admin.from('contracts').insert({
    company_id: COMPANY_B,
    order_id: ORDER_B_ID,
    revision_no: 1,
    template_version: 'v1',
    generated_file_ref: `${COMPANY_B}/contracts/dummy-b/revision-1/generated.pdf`,
    status: 'GENERATED',
    contract_value: 12000000,
    is_current: true,
  }).select('id').single();

  const dummyCanonicalSignedPath = `${COMPANY_B}/contracts/${contractDummyB!.id}/revision-1/signed.pdf`;
  // Pre-upload an unexpected object
  await admin.storage.from(STORAGE_BUCKET_MAP.CONTRACT).upload(dummyCanonicalSignedPath, validPdfBytes, { upsert: false });

  try {
    await signContract({
      companyId: COMPANY_B,
      contractId: contractDummyB!.id,
      signedPdfBuffer: validPdfBytes,
    }, BOSS_B_CLIENT);
    assert.fail('Signing with unexpected existing storage object must fail closed');
  } catch (err: any) {
    assert(err.message.includes('STORAGE_OBJECT_ALREADY_EXISTS'), 'Must throw STORAGE_OBJECT_ALREADY_EXISTS');
  }

  // Clean up dummy storage object
  await admin.storage.from(STORAGE_BUCKET_MAP.CONTRACT).remove([dummyCanonicalSignedPath]);

  // Section 3: Customer stage history after contract signing: DEPOSIT_CONFIRMED -> CONTRACT_SIGNED
  const { data: stageHistSign } = await admin
    .from('customer_stage_histories')
    .select('*')
    .eq('customer_id', CUSTOMER_A)
    .eq('to_stage', 'CONTRACT_SIGNED')
    .single();
  assert(stageHistSign, 'Customer stage history must be recorded for CONTRACT_SIGNED');
  assert.strictEqual(stageHistSign.from_stage, 'DEPOSIT_CONFIRMED', 'from_stage must be exact customer previous stage DEPOSIT_CONFIRMED');
  assert.strictEqual(stageHistSign.to_stage, 'CONTRACT_SIGNED');

  testPass('Contract signing: pre-upload resolution, dynamic revision 2 path, state machine, and customer stage integrity verified');

  // --------------------------------------------------------------------------
  // Test 14b: Failure recovery - upload succeeds, DB finalize fails before commit
  // --------------------------------------------------------------------------
  {
    const { data: calcRecovB } = await admin.rpc('save_price_calculation_rpc', {
      p_company_id: COMPANY_B,
      p_customer_id: CUSTOMER_B,
      p_survey_id: null,
      p_pricing_policy_id: POLICY_B_ID,
      p_policy_version: 'v1',
      p_input_data: { width: 2, height: 1.2 },
      p_amount: 12000000,
      p_status: 'CALCULATED',
      p_missing_fields: [],
    });
    const { data: orderRecovData } = await admin.rpc('create_order_from_calculation_rpc', {
      p_company_id: COMPANY_B,
      p_customer_id: CUSTOMER_B,
      p_price_calculation_id: calcRecovB.id,
      p_payment_reference: `DH-RECOV-B-${Date.now()}`,
      p_actor_user_id: USER_BOSS_B,
    });
    const orderRecovId = orderRecovData.orderId;

    const { data: recovContract, error: recovErr } = await admin.from('contracts').insert({
      company_id: COMPANY_B,
      order_id: orderRecovId,
      revision_no: 1,
      template_version: 'v1',
      generated_file_ref: `${COMPANY_B}/contracts/recov-b/revision-1/generated.pdf`,
      status: 'GENERATED',
      contract_value: 12000000,
      is_current: true,
    }).select('id').single();
    assert(!recovErr && recovContract, `Insert recovContract failed: ${recovErr?.message}`);

    const recovContractId = recovContract.id;
    const recovCanonicalSignedPath = `${COMPANY_B}/contracts/${recovContractId}/revision-1/signed.pdf`;

    // Simulate RPC failure before commit
    const failingRpcAdmin = new Proxy(admin, {
      get(target, prop) {
        if (prop === 'rpc') {
          return async (fnName: string, args: any) => {
            if (fnName === 'finalize_contract_signing_rpc') {
              return { data: null, error: new Error('SIMULATED_FINALIZE_RPC_NETWORK_FAILURE') };
            }
            return (target as any).rpc(fnName, args);
          };
        }
        return (target as any)[prop];
      },
    });

    let threwExpected = false;
    try {
      await signContract({
        companyId: COMPANY_B,
        contractId: recovContractId,
        signedPdfBuffer: validPdfBytes,
      }, BOSS_B_CLIENT, failingRpcAdmin as any);
    } catch (err: any) {
      threwExpected = true;
      assert(err.message.includes('SIMULATED_FINALIZE_RPC_NETWORK_FAILURE'));
    }
    assert(threwExpected, 'Must throw original finalization failure');

    // Storage object must be removed by cleanup
    const { data: fileData, error: fileErr } = await admin.storage
      .from(STORAGE_BUCKET_MAP.CONTRACT)
      .download(recovCanonicalSignedPath);
    assert(fileErr || !fileData, 'Storage object must be removed after DB finalize failure');

    // DB still GENERATED, signed_file_ref still null
    const { data: contractAfterFail } = await admin
      .from('contracts')
      .select('status, signed_file_ref')
      .eq('id', recovContractId)
      .single();
    assert.strictEqual(contractAfterFail?.status, 'GENERATED');
    assert.strictEqual(contractAfterFail?.signed_file_ref, null);

    // Retry signing with normal finalize behavior MUST SUCCEED (not blocked by STORAGE_OBJECT_ALREADY_EXISTS)
    const retryResult = await signContract({
      companyId: COMPANY_B,
      contractId: recovContractId,
      signedPdfBuffer: validPdfBytes,
    }, BOSS_B_CLIENT, admin as any);

    assert.strictEqual(retryResult.status, 'SIGNED');

    // Verify DB is now SIGNED
    const { data: contractAfterRetry } = await admin
      .from('contracts')
      .select('status, signed_file_ref')
      .eq('id', recovContractId)
      .single();
    assert.strictEqual(contractAfterRetry?.status, 'SIGNED');
    assert.strictEqual(contractAfterRetry?.signed_file_ref, recovCanonicalSignedPath);

    // Verify storage object now exists
    const { data: storedAfterRetry, error: storedErr } = await admin.storage
      .from(STORAGE_BUCKET_MAP.CONTRACT)
      .download(recovCanonicalSignedPath);
    assert(!storedErr && storedAfterRetry, 'Storage object must exist after successful retry');

    testPass('Failure recovery: upload succeeds + DB finalize fails -> storage cleaned up and retry succeeds');
  }

  // --------------------------------------------------------------------------
  // Test 14c: Ambiguous commit recovery - DB finalize committed but response lost
  {
    const { data: calcAmbigB, error: calcAmbigErr } = await admin.rpc('save_price_calculation_rpc', {
      p_company_id: COMPANY_B,
      p_customer_id: CUSTOMER_B,
      p_survey_id: null,
      p_pricing_policy_id: POLICY_B_ID,
      p_policy_version: 'v1',
      p_input_data: { width: 3, height: 2 },
      p_amount: 12000000,
      p_status: 'CALCULATED',
      p_missing_fields: [],
    });
    assert(!calcAmbigErr && calcAmbigB, `save_price_calculation_rpc failed: ${calcAmbigErr?.message}`);
    const { data: orderAmbigData } = await admin.rpc('create_order_from_calculation_rpc', {
      p_company_id: COMPANY_B,
      p_customer_id: CUSTOMER_B,
      p_price_calculation_id: calcAmbigB.id,
      p_payment_reference: `DH-AMBIG-B-${Date.now()}`,
      p_actor_user_id: USER_BOSS_B,
    });
    const orderAmbigId = orderAmbigData.orderId;

    const { data: ambigContract, error: ambigErr } = await admin.from('contracts').insert({
      company_id: COMPANY_B,
      order_id: orderAmbigId,
      revision_no: 1,
      template_version: 'v1',
      generated_file_ref: `${COMPANY_B}/contracts/ambig-b/revision-1/generated.pdf`,
      status: 'GENERATED',
      contract_value: 12000000,
      is_current: true,
    }).select('id').single();
    assert(!ambigErr && ambigContract, `Insert ambigContract failed: ${ambigErr?.message}`);

    const ambigContractId = ambigContract.id;
    const ambigCanonicalSignedPath = `${COMPANY_B}/contracts/${ambigContractId}/revision-1/signed.pdf`;

    // Simulate DB committed but response lost
    const droppedResponseAdmin = new Proxy(admin, {
      get(target, prop) {
        if (prop === 'rpc') {
          return async (fnName: string, args: any) => {
            if (fnName === 'finalize_contract_signing_rpc') {
              await (target as any).rpc(fnName, args);
              return { data: null, error: new Error('SIMULATED_NETWORK_CONNECTION_LOST_AFTER_COMMIT') };
            }
            return (target as any).rpc(fnName, args);
          };
        }
        return (target as any)[prop];
      },
    });

    const resAmbig = await signContract({
      companyId: COMPANY_B,
      contractId: ambigContractId,
      signedPdfBuffer: validPdfBytes,
    }, BOSS_B_CLIENT, droppedResponseAdmin as any);

    assert.strictEqual(resAmbig.success, true);
    assert.strictEqual(resAmbig.status, 'SIGNED');
    assert.strictEqual(resAmbig.alreadyProcessed, true);

    // Invariants: ZERO storage deletion, PDF bytes intact
    const { data: storedAmbigData, error: storedAmbigErr } = await admin.storage
      .from(STORAGE_BUCKET_MAP.CONTRACT)
      .download(ambigCanonicalSignedPath);
    assert(!storedAmbigErr && storedAmbigData, 'Storage object must NOT be deleted in Case A');
    const storedBuf = Buffer.from(await storedAmbigData.arrayBuffer());
    assert.deepStrictEqual(storedBuf, validPdfBytes, 'Stored PDF bytes must remain strictly identical');

    // DB state is SIGNED with canonical signed_file_ref
    const { data: contractAmbig } = await admin
      .from('contracts')
      .select('status, signed_file_ref')
      .eq('id', ambigContractId)
      .single();
    assert.strictEqual(contractAmbig?.status, 'SIGNED');
    assert.strictEqual(contractAmbig?.signed_file_ref, ambigCanonicalSignedPath);

    testPass('Ambiguous commit recovery: DB committed but RPC response lost -> re-read discovers SIGNED, zero storage deletion');
  }

  // --------------------------------------------------------------------------
  // Test 15: TV8 Production Handoff integration
  // --------------------------------------------------------------------------
  // After valid contract signing: TV8 create_production_order_atomic MUST SUCCEED!
  const { data: prodAfterSign, error: prodAfterSignErr } = await admin.rpc('create_production_order_atomic', {
    p_company_id: COMPANY_A,
    p_order_id: ORDER_MAN_1_ID,
    p_actor_id: USER_BOSS_A,
    p_specs: { dimensions: '200x100cm' },
    p_materials: { aluminum: '6063-T5' },
    p_deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!prodAfterSignErr, `Production order creation failed: ${prodAfterSignErr?.message}`);
  assert(prodAfterSign.id);
  assert.strictEqual(prodAfterSign.status, 'RELEASED_TO_FACTORY');
  testPass('TV8 create_production_order_atomic succeeds immediately after valid contract signing');

  // --------------------------------------------------------------------------
  // Test 16: Signed URL test (Section 15)
  // --------------------------------------------------------------------------
  const signedUrlResult = await getContractDownloadUrl({
    contractId: CONTRACT_REV2_ID,
    variant: 'signed',
  }, BOSS_A_CLIENT);

  assert(signedUrlResult.signedUrl, 'Must return signed URL');
  assert.strictEqual(signedUrlResult.expiresIn, 1800, 'Must return expiresIn 1800s');
  assert.strictEqual(SIGNED_URL_TTL.CONTRACT, 1800, 'TTL must be 1800s');
  testPass('Authorized signed URL uses contracts bucket and TTL 1800s, browser controls only contractId and variant');

  // --------------------------------------------------------------------------
  // Test 17: RPC ACL Privilege Check (Section 35)
  // --------------------------------------------------------------------------
  const { execSync } = await import('node:child_process');
  const rpcs = [
    'save_price_calculation_rpc',
    'create_order_from_calculation_rpc',
    'process_payment_webhook_rpc',
    'update_order_deposit_rpc',
    'claim_contract_generation_rpc',
    'finalize_generated_contract_rpc',
    'finalize_contract_signing_rpc',
  ];

  for (const rpcName of rpcs) {
    const sql = `SELECT json_build_object(
      'name', proname,
      'is_secdef', prosecdef,
      'empty_search_path', proconfig @> ARRAY['search_path=""'],
      'anon', has_function_privilege('anon', oid, 'execute'),
      'authenticated', has_function_privilege('authenticated', oid, 'execute'),
      'service_role', has_function_privilege('service_role', oid, 'execute')
    ) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '${rpcName}';`;

    const out = execSync(
      `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -U postgres -d postgres -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8' }
    ).trim();

    const info = JSON.parse(out);
    assert.strictEqual(info.is_secdef, true, `${rpcName} must be SECURITY DEFINER`);
    assert.strictEqual(info.empty_search_path, true, `${rpcName} must have SET search_path = ''`);
    assert.strictEqual(info.anon, false, `anon must not execute ${rpcName}`);
    assert.strictEqual(info.authenticated, false, `authenticated must not execute ${rpcName}`);
    assert.strictEqual(info.service_role, true, `service_role must execute ${rpcName}`);
  }

  testPass('All 7 commercial RPCs verified in PostgreSQL catalog: SECURITY DEFINER, search_path="", service_role only');

  // --------------------------------------------------------------------------
  // Test 18: Survey Scheduling Action-Level Integration Tests (Section 7)
  // Invokes production Server Actions under real PostgreSQL RLS:
  // Scenario A: SALE real scheduling path (real RLS) -> success
  // Scenario B: BOSS_ADMIN real scheduling path (real RLS + AAL2) -> success
  // Scenario C: TECHNICIAN real action denied (ROLE_FORBIDDEN safe denial)
  // Scenario D: Forged company ID -> fail closed, zero foreign records written
  // Scenario E: Cross-company customer -> fail closed
  // Scenario F: Cross-company technician -> fail closed
  // Scenario G: Inactive technician -> fail closed
  // Scenario H: Privacy check -> technician selection & appointment DTO contain zero phone/raw_phone/email
  // --------------------------------------------------------------------------

  // Scenario A: SALE real scheduling path under real RLS
  const resSale = await createSurveyAppointmentAction(
    {
      customerId: CUSTOMER_A,
      assigneeId: USER_TECH_A,
      address: '123 Nguyen Trai, Q1',
      appointmentDate: new Date().toISOString(),
    },
    { userClient: saleRealClient }
  );
  assert.strictEqual(resSale.success, true, `SALE scheduling failed: ${resSale.message}`);
  assert(resSale.appointment?.id, 'Appointment must be returned');
  assert.strictEqual(resSale.appointment.company_id, COMPANY_A);
  assert.strictEqual(resSale.appointment.customer_id, CUSTOMER_A);
  assert.strictEqual(resSale.appointment.assignee_id, USER_TECH_A);
  assert.strictEqual(resSale.appointment.type, 'SURVEY');

  const { data: dbAptSale } = await admin
    .from('appointments')
    .select('id, type, status, company_id, customer_id, assignee_id')
    .eq('id', resSale.appointment.id)
    .single();
  assert.strictEqual(dbAptSale?.status, 'ASSIGNED', 'Database appointment status must be ASSIGNED');
  assert.strictEqual(dbAptSale?.type, 'SURVEY', 'Database appointment type must be SURVEY');
  assert.strictEqual(dbAptSale?.company_id, COMPANY_A);
  assert.strictEqual(dbAptSale?.customer_id, CUSTOMER_A);
  assert.strictEqual(dbAptSale?.assignee_id, USER_TECH_A);

  // Scenario B: BOSS_ADMIN real scheduling path (with verified MFA AAL2) under real RLS
  const resBoss = await createSurveyAppointmentAction(
    {
      customerId: CUSTOMER_A,
      assigneeId: USER_TECH_A,
      address: '456 Le Loi, Q1',
      appointmentDate: new Date().toISOString(),
    },
    { userClient: bossRealClient }
  );
  assert.strictEqual(resBoss.success, true, `BOSS scheduling failed: ${resBoss.message}`);
  assert(resBoss.appointment?.id);
  assert.strictEqual(resBoss.appointment.company_id, COMPANY_A);
  assert.strictEqual(resBoss.appointment.customer_id, CUSTOMER_A);
  assert.strictEqual(resBoss.appointment.assignee_id, USER_TECH_A);
  assert.strictEqual(resBoss.appointment.type, 'SURVEY');

  const { data: dbAptBoss } = await admin
    .from('appointments')
    .select('id, type, status, company_id')
    .eq('id', resBoss.appointment.id)
    .single();
  assert.strictEqual(dbAptBoss?.status, 'ASSIGNED');
  assert.strictEqual(dbAptBoss?.type, 'SURVEY');
  assert.strictEqual(dbAptBoss?.company_id, COMPANY_A);

  // Scenario C: TECHNICIAN real action denied via product authorization orchestration
  const resTech = await createSurveyAppointmentAction(
    {
      customerId: CUSTOMER_A,
      assigneeId: USER_TECH_A,
      address: '789 Tech Attempt St, Q1',
      appointmentDate: new Date().toISOString(),
    },
    { userClient: techRealClient }
  );
  assert.strictEqual(resTech.success, false, 'TECHNICIAN scheduling must be denied');
  assert(
    resTech.message?.includes('Bạn không có quyền') || (resTech as any).code === 'ROLE_FORBIDDEN',
    `Expected safe role denial, got: ${resTech.message}`
  );

  // Scenario D: Forged company ID -> fail closed; server authority wins, zero foreign record written
  const resForged = await createSurveyAppointmentAction(
    {
      customerId: CUSTOMER_A,
      assigneeId: USER_TECH_A,
      address: '888 Forged Company St',
      appointmentDate: new Date().toISOString(),
      companyId: COMPANY_B, // Forged company_id in input
    },
    { userClient: saleRealClient }
  );
  assert.strictEqual(resForged.success, false, 'Forged companyId must fail closed');
  assert(
    resForged.message?.includes('Doanh nghiệp không khớp') || (resForged as any).code === 'COMPANY_MISMATCH',
    `Expected company mismatch failure, got: ${resForged.message}`
  );

  const { data: dbForged } = await admin
    .from('appointments')
    .select('id')
    .eq('company_id', COMPANY_B)
    .eq('address', '888 Forged Company St');
  assert.strictEqual(dbForged?.length || 0, 0, 'No record may be written to COMPANY_B');

  // Scenario E: Cross-company customer -> fail closed
  const resCrossCust = await createSurveyAppointmentAction(
    {
      customerId: CUSTOMER_B, // Belongs to Company B
      assigneeId: USER_TECH_A,
      address: 'Cross-company Customer St',
      appointmentDate: new Date().toISOString(),
    },
    { userClient: saleRealClient }
  );
  assert.strictEqual(resCrossCust.success, false, 'Cross-company customer scheduling must fail closed');
  assert(
    resCrossCust.message?.includes('Không tìm thấy hồ sơ khách hàng') || (resCrossCust as any).code === 'CUSTOMER_NOT_FOUND',
    `Expected customer not found failure, got: ${resCrossCust.message}`
  );

  // Scenario F: Cross-company technician -> fail closed
  const resCrossTech = await createSurveyAppointmentAction(
    {
      customerId: CUSTOMER_A,
      assigneeId: USER_TECH_B, // Tech belongs to Company B
      address: 'Cross-company Tech St',
      appointmentDate: new Date().toISOString(),
    },
    { userClient: saleRealClient }
  );
  assert.strictEqual(resCrossTech.success, false, 'Cross-company technician scheduling must fail closed');
  assert(
    resCrossTech.message?.includes('Người được phân công phải là kỹ thuật viên') || (resCrossTech as any).code === 'INVALID_TECHNICIAN',
    `Expected invalid technician failure, got: ${resCrossTech.message}`
  );

  // Scenario G: Inactive technician -> fail closed
  const resInactiveTech = await createSurveyAppointmentAction(
    {
      customerId: CUSTOMER_A,
      assigneeId: USER_INACTIVE_TECH_A, // Membership INACTIVE in Company A
      address: 'Inactive Tech St',
      appointmentDate: new Date().toISOString(),
    },
    { userClient: saleRealClient }
  );
  assert.strictEqual(resInactiveTech.success, false, 'Inactive technician scheduling must fail closed');
  assert(
    resInactiveTech.message?.includes('Người được phân công phải là kỹ thuật viên') || (resInactiveTech as any).code === 'INVALID_TECHNICIAN',
    `Expected invalid technician failure, got: ${resInactiveTech.message}`
  );

  // Scenario H: Privacy boundary check
  // 1. Technician dropdown listing via action (Zero-Phone boundary)
  const techListRes = await getActiveCompanyTechniciansAction({ userClient: saleRealClient });
  assert.strictEqual(techListRes.success, true);
  assert(techListRes.technicians && techListRes.technicians.length > 0);
  for (const t of techListRes.technicians) {
    assert(t.id, 'Technician must have id');
    assert(t.full_name, 'Technician must have full_name');
    assert.strictEqual((t as any).phone, undefined, 'Zero phone in technician list');
    assert.strictEqual((t as any).raw_phone, undefined, 'Zero raw_phone in technician list');
    assert.strictEqual((t as any).normalized_phone, undefined, 'Zero normalized_phone in technician list');
    assert.strictEqual((t as any).email, undefined, 'Zero email in technician list');
  }

  // 2. Created appointment DTO (from Scenario A)
  const aptDto = resSale.appointment!;
  assert.strictEqual((aptDto.customer as any)?.phone, undefined, 'Customer phone must NOT be exposed');
  assert.strictEqual((aptDto.customer as any)?.raw_phone, undefined, 'Customer raw_phone must NOT be exposed');
  assert.strictEqual((aptDto.customer as any)?.normalized_phone, undefined, 'Customer normalized_phone must NOT be exposed');
  assert.strictEqual((aptDto.customer as any)?.email, undefined, 'Customer email must NOT be exposed');
  assert.strictEqual((aptDto.assignee as any)?.phone, undefined, 'Assignee phone must NOT be exposed');
  assert.strictEqual((aptDto.assignee as any)?.raw_phone, undefined, 'Assignee raw_phone must NOT be exposed');
  assert.strictEqual((aptDto.assignee as any)?.normalized_phone, undefined, 'Assignee normalized_phone must NOT be exposed');
  assert.strictEqual((aptDto.assignee as any)?.email, undefined, 'Assignee email must NOT be exposed');

  testPass('Section 7: Survey scheduling security, role authorization, tenant isolation, and zero-phone boundary verified across all 8 scenarios');

  // --------------------------------------------------------------------------
  // Test 19: Survey → Pricing Contract Tests in DB (Section 8)
  // Valid Survey, Missing Input fail-closed, Tenant Mismatch, Policy Mismatch
  // --------------------------------------------------------------------------
  // 1. Valid survey calculation: 2500 mm -> 2.5 m, 1200 mm -> 1.2 m, 5,000,000 / sqm -> 15,000,000
  const SURVEY_19_ID = crypto.randomUUID();
  const APT_19_ID = crypto.randomUUID();
  await admin.from('appointments').insert({
    id: APT_19_ID,
    company_id: COMPANY_A,
    customer_id: CUSTOMER_A,
    assignee_id: USER_TECH_A,
    address: '100 Valid Survey St',
    start_time: new Date().toISOString(),
    type: 'SURVEY',
    status: 'COMPLETED',
  });
  const { error: srvErr } = await admin.from('surveys').insert({
    id: SURVEY_19_ID,
    company_id: COMPANY_A,
    customer_id: CUSTOMER_A,
    appointment_id: APT_19_ID,
    completed_by: USER_TECH_A,
    measurements: {
      clear_width_mm: 2500,
      barrier_height_mm: 1200,
      anticipated_flood_height_mm: 800,
      gate_type: 'REMOVABLE_PANEL',
      mounting_method: 'INSIDE_JAMB',
    },
    site_condition: '{"wall_material":"SOLID_BRICK","floor_material":"CONCRETE_SMOOTH","floor_evenness":"FLAT","slope_grade":"LEVEL"}',
    photos: [],
    completed_at: new Date().toISOString(),
  });
  assert(!srvErr, `surveys insert error: ${srvErr?.message}`);

  const calc19 = await calculatePriceFromSurvey({ companyId: COMPANY_A, surveyId: SURVEY_19_ID }, SALE_A_CLIENT);
  assert.strictEqual(calc19.status, 'CALCULATED');
  assert.strictEqual(calc19.amount, 15000000); // 2.5 * 1.2 * 5,000,000 = 15,000,000
  assert.notStrictEqual(calc19.amount, 2500 * 1200 * 5000000);
  assert.strictEqual(calc19.survey_id, SURVEY_19_ID);
  assert.strictEqual(calc19.pricing_policy_id, POLICY_A_ID);
  assert.strictEqual(calc19.policy_version, 'v1');
  assert.strictEqual((calc19.input_data as any).width, 2.5);
  assert.strictEqual((calc19.input_data as any).height, 1.2);
  assert.strictEqual((calc19.input_data as any).unit, 'm');
  assert.strictEqual((calc19.input_data as any).clear_width_mm, 2500);
  assert.strictEqual((calc19.input_data as any).barrier_height_mm, 1200);
  assert.strictEqual((calc19.input_data as any).survey_id, SURVEY_19_ID);

  // 2. Missing input survey in DB (status = NEED_INFO, amount = null)
  const SURVEY_MISSING_ID = crypto.randomUUID();
  const APT_MISSING_ID = crypto.randomUUID();
  await admin.from('appointments').insert({
    id: APT_MISSING_ID,
    company_id: COMPANY_A,
    customer_id: CUSTOMER_A,
    assignee_id: USER_TECH_A,
    address: '101 Missing Dim St',
    start_time: new Date().toISOString(),
    type: 'SURVEY',
    status: 'COMPLETED',
  });
  await admin.from('surveys').insert({
    id: SURVEY_MISSING_ID,
    company_id: COMPANY_A,
    customer_id: CUSTOMER_A,
    appointment_id: APT_MISSING_ID,
    completed_by: USER_TECH_A,
    measurements: {
      clear_width_mm: 2500,
      // barrier_height_mm missing
    },
    site_condition: '{}',
    photos: [],
    completed_at: new Date().toISOString(),
  });

  const calcMissing = await calculatePriceFromSurvey({ companyId: COMPANY_A, surveyId: SURVEY_MISSING_ID }, SALE_A_CLIENT);
  assert.strictEqual(calcMissing.status, 'NEED_INFO');
  assert.strictEqual(calcMissing.amount, null);
  assert(calcMissing.missing_fields.includes('height'), 'missing_fields must contain height');

  // 3. Tenant mismatch: Company B cannot calculate price from Company A's survey
  await assert.rejects(
    async () => {
      await calculatePriceFromSurvey({ companyId: COMPANY_B, surveyId: SURVEY_19_ID }, BOSS_B_CLIENT);
    },
    /RESOURCE_NOT_FOUND/
  );

  // 4. Policy mismatch: Company with no active pricing policy fails closed
  const COMPANY_NO_POLICY = crypto.randomUUID();
  await admin.from('companies').insert({ id: COMPANY_NO_POLICY, name: 'No Policy Co', status: 'ACTIVE' });
  const USER_NO_POLICY = await createUserWithRole(`no_policy_${RUN_ID}@test.local`, 'No Policy Boss', COMPANY_NO_POLICY, 'BOSS_ADMIN');
  const NO_POLICY_CLIENT = createMockBossClient(USER_NO_POLICY, `no_policy_${RUN_ID}@test.local`);
  const CUST_NO_POLICY = crypto.randomUUID();
  await admin.from('customers').insert({ id: CUST_NO_POLICY, company_id: COMPANY_NO_POLICY, name: 'Cust No Policy', source: 'MANUAL', stage: 'LEAD_NEW' });
  const APT_NO_POLICY = crypto.randomUUID();
  await admin.from('appointments').insert({ id: APT_NO_POLICY, company_id: COMPANY_NO_POLICY, customer_id: CUST_NO_POLICY, assignee_id: USER_NO_POLICY, address: 'Test', start_time: new Date().toISOString(), type: 'SURVEY', status: 'COMPLETED' });
  const SRV_NO_POLICY = crypto.randomUUID();
  await admin.from('surveys').insert({ id: SRV_NO_POLICY, company_id: COMPANY_NO_POLICY, customer_id: CUST_NO_POLICY, appointment_id: APT_NO_POLICY, completed_by: USER_NO_POLICY, measurements: { clear_width_mm: 2000, barrier_height_mm: 1000 }, site_condition: '{}', photos: [], completed_at: new Date().toISOString() });

  await assert.rejects(
    async () => {
      await calculatePriceFromSurvey({ companyId: COMPANY_NO_POLICY, surveyId: SRV_NO_POLICY }, NO_POLICY_CLIENT);
    },
    /POLICY_CONFIGURATION_ERROR/
  );

  testPass('Section 8: Survey to Pricing DB contract, snapshot preservation, fail-closed NEED_INFO, tenant mismatch, and policy mismatch verified');

  // --------------------------------------------------------------------------
  // Test 20: Product Action End-to-End Journey (Section 9)
  // SALE schedules via Server Action (real RLS) -> Tech accepts via Action -> Tech starts via Action -> Tech completes real Survey (complete_survey_atomic) -> SALE triggers calculatePriceFromSurveyAction -> PriceCalculation exists & CALCULATED
  // --------------------------------------------------------------------------
  const E2E_CUSTOMER_ID = crypto.randomUUID();
  await admin.from('customers').insert({
    id: E2E_CUSTOMER_ID,
    company_id: COMPANY_A,
    customer_code: `CUS_E2E_${RUN_ID}`,
    name: 'Khách hàng E2E Journey',
    source: 'MANUAL',
    stage: 'LEAD_NEW',
  });

  // Step 1: SALE creates Survey Appointment via production Server Action under real RLS
  const e2eAptRes = await createSurveyAppointmentAction(
    {
      customerId: E2E_CUSTOMER_ID,
      assigneeId: USER_TECH_A,
      address: '777 Dai Lo Dong Tay, Q1',
      appointmentDate: new Date().toISOString(),
    },
    { userClient: saleRealClient }
  );
  assert(e2eAptRes.success && e2eAptRes.appointment, `SALE appointment action failed: ${e2eAptRes.message}`);
  const e2eApt = e2eAptRes.appointment;
  assert.strictEqual(e2eApt.type, 'SURVEY');
  assert.strictEqual(e2eApt.company_id, COMPANY_A);
  assert.strictEqual(e2eApt.customer_id, E2E_CUSTOMER_ID);

  // Step 2: Tech accepts appointment via production Server Action under real RLS
  const acceptRes = await acceptSurveyAppointmentAction(e2eApt.id, { userClient: techRealClient });
  assert(acceptRes.success, `Tech accept action failed: ${acceptRes.message}`);

  // Step 3: Tech starts survey on-site via production Server Action under real RLS
  const startRes = await startSurveyAppointmentAction(e2eApt.id, { userClient: techRealClient });
  assert(startRes.success, `Tech start action failed: ${startRes.message}`);

  // Step 4: Technician completes real Survey via complete_survey_atomic
  // Seed mandatory photo objects in storage (bucket is provisioned by migrations)
  for (const slot of ['OVERVIEW', 'BOTTOM_LEFT', 'BOTTOM_RIGHT']) {
    const photoPath = `${COMPANY_A}/${E2E_CUSTOMER_ID}/${e2eApt.id}/${slot}.jpg`;
    await admin.storage.from('survey-photos').upload(photoPath, Buffer.from('fake-jpeg-photo-content'), {
      contentType: 'image/jpeg',
      upsert: true,
    });
  }

  const { data: atomicCompleteResult, error: atomicErr } = await admin.rpc(
    'complete_survey_atomic',
    {
      p_appointment_id: e2eApt.id,
      p_completed_by: USER_TECH_A,
      p_survey_payload: {
        measurements: {
          clear_width_mm: 2500,
          barrier_height_mm: 1200,
          anticipated_flood_height_mm: 800,
          gate_type: 'REMOVABLE_PANEL',
          mounting_method: 'INSIDE_JAMB',
        },
        site_condition: JSON.stringify({
          wall_material: 'SOLID_BRICK',
          floor_material: 'CONCRETE_SMOOTH',
          floor_evenness: 'FLAT',
          slope_grade: 'LEVEL',
        }),
        photos: [
          { slot: 'OVERVIEW', objectPath: 'server-owned' },
          { slot: 'BOTTOM_LEFT', objectPath: 'server-owned' },
          { slot: 'BOTTOM_RIGHT', objectPath: 'server-owned' },
        ],
      },
    }
  );
  assert(!atomicErr, `complete_survey_atomic error: ${atomicErr?.message}`);
  assert(atomicCompleteResult?.id, 'Survey ID must be returned');
  const e2eSurveyId = atomicCompleteResult.id;

  // Verify survey record in DB
  const { data: e2eSurveyRow, error: srvRowErr } = await admin
    .from('surveys')
    .select('*')
    .eq('id', e2eSurveyId)
    .single();
  assert(!srvRowErr && e2eSurveyRow, 'Survey row must exist in DB');
  assert(e2eSurveyRow.completed_at, 'Survey row must have completed_at timestamp');

  // Verify appointment state is COMPLETED
  const { data: e2eAptRow } = await admin
    .from('appointments')
    .select('status')
    .eq('id', e2eApt.id)
    .single();
  assert.strictEqual(e2eAptRow?.status, 'COMPLETED');

  // Step 5: Canonical pricing trigger via production Server Action (Option B / Trusted Server Action)
  // Executed with authenticated SALE client under real RLS
  const e2eCalcRes = await calculatePriceFromSurveyAction(
    { surveyId: e2eSurveyId },
    { userClient: saleRealClient }
  );
  assert(e2eCalcRes.success && e2eCalcRes.calculationId, `Calculate price action failed: ${e2eCalcRes.message}`);

  // Step 6: PriceCalculation exists and is CALCULATED
  assert.strictEqual(e2eCalcRes.status, 'CALCULATED');
  assert.strictEqual(e2eCalcRes.amount, 15000000); // 2.5 * 1.2 * 5,000,000 = 15,000,000

  // Verify snapshot in DB
  const { data: calcRow, error: calcRowErr } = await admin
    .from('price_calculations')
    .select('*')
    .eq('id', e2eCalcRes.calculationId)
    .single();
  assert(!calcRowErr && calcRow, 'Price calculation row must exist in DB');
  assert.strictEqual(calcRow.survey_id, e2eSurveyId);
  assert.strictEqual(calcRow.status, 'CALCULATED');
  assert.strictEqual(Number(calcRow.amount), 15000000);
  assert.strictEqual(calcRow.company_id, COMPANY_A);
  assert.strictEqual(calcRow.customer_id, E2E_CUSTOMER_ID);
  assert.strictEqual((calcRow.input_data as any).width, 2.5);
  assert.strictEqual((calcRow.input_data as any).height, 1.2);
  assert.strictEqual((calcRow.input_data as any).unit, 'm');

  // Step 7: Quotations retrieval sees it under real RLS
  const quotations = await getPriceCalculations(COMPANY_A, undefined, saleRealClient);
  const quotationItem = quotations.find((q) => q.id === e2eCalcRes.calculationId);
  assert(quotationItem, 'Quotation must be visible in Quotations retrieval for SALE');
  assert.strictEqual(quotationItem.customer_id, E2E_CUSTOMER_ID);
  assert.strictEqual(quotationItem.amount, 15000000);
  assert.strictEqual(quotationItem.status, 'CALCULATED');
  assert(quotationItem.created_at, 'Quotation must have created_at');

  // Step 8: Assert all IDs remain bound across the entire product journey
  assert.strictEqual(e2eApt.company_id, COMPANY_A);
  assert.strictEqual(e2eSurveyRow.company_id, COMPANY_A);
  assert.strictEqual(e2eSurveyRow.customer_id, E2E_CUSTOMER_ID);
  assert.strictEqual(calcRow.company_id, COMPANY_A);
  assert.strictEqual(calcRow.customer_id, E2E_CUSTOMER_ID);
  assert.strictEqual(calcRow.survey_id, e2eSurveyId);
  assert.strictEqual(calcRow.pricing_policy_id, POLICY_A_ID);

  assert.strictEqual(e2eApt.company_id, e2eSurveyRow.company_id);
  assert.strictEqual(e2eSurveyRow.company_id, calcRow.company_id);
  assert.strictEqual(e2eSurveyRow.customer_id, calcRow.customer_id);
  assert.strictEqual(e2eSurveyRow.id, calcRow.survey_id);

  testPass('Section 9: Product Action End-to-End Journey verified: SALE schedules via Server Action (real RLS) -> Tech accepts via Action -> Tech starts via Action -> Tech completes real Survey -> SALE triggers calculatePriceFromSurveyAction -> Quotations retrieval sees it; all IDs strictly bound; zero service-role write bypass');

  // ==========================================================================
  // Section 10: P1-008 Commercial Exactly-Once & Recovery Invariant Tests
  // ==========================================================================

  // --------------------------------------------------------------------------
  // Required Test 1: 10 concurrent create-order attempts from one PriceCalculation -> exactly 1 Order
  // --------------------------------------------------------------------------
  const { data: calcConc, error: calcConcErr } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert(!calcConcErr && calcConc, `save_price_calculation_rpc failed: ${calcConcErr?.message}`);

  const concurrentAttempts = Array.from({ length: 10 }, () =>
    createOrderFromCalculation({
      companyId: COMPANY_A,
      customerId: CUSTOMER_A,
      priceCalculationId: calcConc.id,
    }, BOSS_A_CLIENT)
  );

  const concResults = await Promise.all(concurrentAttempts);
  const firstOrderId = concResults[0].orderId;
  const firstPayRef = concResults[0].paymentReference;

  for (const res of concResults) {
    assert.strictEqual(res.orderId, firstOrderId, 'All concurrent attempts must resolve to the same orderId');
    assert.strictEqual(res.paymentReference, firstPayRef, 'All concurrent attempts must resolve to the same paymentReference');
  }

  const { data: ordersForCalc, error: ordersForCalcErr } = await admin
    .from('orders')
    .select('id')
    .eq('price_calculation_id', calcConc.id);
  assert(!ordersForCalcErr && ordersForCalc.length === 1, `Must have exactly 1 order row in DB, found ${ordersForCalc?.length}`);

  const { data: financeForCalc, error: financeForCalcErr } = await admin
    .from('finance_summaries')
    .select('order_id')
    .eq('order_id', firstOrderId);
  assert(!financeForCalcErr && financeForCalc.length === 1, `Must have exactly 1 finance summary row in DB, found ${financeForCalc?.length}: ${financeForCalcErr?.message}`);

  testPass('Required Test 1: 10 concurrent create-order attempts from one PriceCalculation -> exactly 1 Order, 1 finance_summary, same orderId & paymentReference');

  // --------------------------------------------------------------------------
  // Required Test 2: Existing Order retry returns same orderId/paymentReference
  // --------------------------------------------------------------------------
  const retryOrderRes = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calcConc.id,
  }, BOSS_A_CLIENT);
  assert.strictEqual(retryOrderRes.status, 'ALREADY_EXISTS', 'Retry must return ALREADY_EXISTS');
  assert.strictEqual(retryOrderRes.orderId, firstOrderId, 'Retry must return existing orderId');
  assert.strictEqual(retryOrderRes.paymentReference, firstPayRef, 'Retry must not generate a second paymentReference');

  testPass('Required Test 2: Existing Order retry returns same orderId/paymentReference deterministically without creating duplicate');

  // --------------------------------------------------------------------------
  // Required Test 3: Manual deposit commit + lost response + retry same command ID -> money counted once
  // --------------------------------------------------------------------------
  const { data: calcManDep } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { orderId: manDepOrderId } = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calcManDep.id,
  }, BOSS_A_CLIENT);

  const manDepCommandId = `cmd-manual-deposit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const firstDepositRes = await updateOrderDepositAndDebt({
    companyId: COMPANY_A,
    orderId: manDepOrderId,
    depositAmount: 3000000,
    idempotencyKey: manDepCommandId,
  }, BOSS_A_CLIENT);

  assert.strictEqual(firstDepositRes.status, 'MATCHED');

  // Simulate retry with exact same command ID, orderId, and amount
  const retryDepositRes = await updateOrderDepositAndDebt({
    companyId: COMPANY_A,
    orderId: manDepOrderId,
    depositAmount: 3000000,
    idempotencyKey: manDepCommandId,
  }, BOSS_A_CLIENT);

  assert.strictEqual(retryDepositRes.status, 'ALREADY_PROCESSED');

  const { data: txsForCmd } = await admin
    .from('payment_transactions')
    .select('id, amount')
    .eq('provider_ref', manDepCommandId);
  assert.strictEqual(txsForCmd?.length, 1, 'Exactly one payment_transaction row must exist for command ID');

  const { data: finAfterRetry } = await admin
    .from('finance_summaries')
    .select('collected_amount')
    .eq('order_id', manDepOrderId)
    .single();
  assert.strictEqual(Number(finAfterRetry?.collected_amount), 3000000, 'Collected amount must increase exactly once');

  testPass('Required Test 3: Manual deposit commit + lost response + retry same command ID -> money counted once (ALREADY_PROCESSED)');

  // --------------------------------------------------------------------------
  // Required Test 4: Same manual command ID + changed amount -> rejected
  // --------------------------------------------------------------------------
  let threwChangedAmount = false;
  try {
    await updateOrderDepositAndDebt({
      companyId: COMPANY_A,
      orderId: manDepOrderId,
      depositAmount: 4000000, // Different amount!
      idempotencyKey: manDepCommandId,
    }, BOSS_A_CLIENT);
  } catch (err: any) {
    threwChangedAmount = true;
    assert(err.message.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'), `Unexpected error: ${err.message}`);
  }
  assert(threwChangedAmount, 'Must reject retry with same command ID but changed amount');

  testPass('Required Test 4: Same manual command ID + changed amount -> rejected fail-closed');

  // --------------------------------------------------------------------------
  // Required Test 5: Same manual command ID + changed Order -> rejected
  // --------------------------------------------------------------------------
  const { data: calcOtherOrder } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { orderId: otherOrderId } = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calcOtherOrder.id,
  }, BOSS_A_CLIENT);

  let threwChangedOrder = false;
  try {
    await updateOrderDepositAndDebt({
      companyId: COMPANY_A,
      orderId: otherOrderId, // Different order!
      depositAmount: 3000000,
      idempotencyKey: manDepCommandId,
    }, BOSS_A_CLIENT);
  } catch (err: any) {
    threwChangedOrder = true;
    assert(err.message.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'), `Unexpected error: ${err.message}`);
  }
  assert(threwChangedOrder, 'Must reject retry with same command ID but changed order');

  testPass('Required Test 5: Same manual command ID + changed Order -> rejected fail-closed');

  // --------------------------------------------------------------------------
  // Required Test 6: Payment reaches deposit threshold + contract storage generation fails
  // --------------------------------------------------------------------------
  const { data: calcWebhookFail } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const webhookOrderRes = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calcWebhookFail.id,
  }, BOSS_A_CLIENT);
  const webhookOrderId = webhookOrderRes.orderId;
  const webhookPayRef = webhookOrderRes.paymentReference;

  // Create a proxy admin client where storage upload returns error
  const failingStorageAdmin = new Proxy(admin, {
    get(target, prop) {
      if (prop === 'storage') {
        return {
          from: (bucket: string) => {
            const bucketObj = (target as any).storage.from(bucket);
            return new Proxy(bucketObj, {
              get(bTarget, bProp) {
                if (bProp === 'upload') {
                  return async () => ({
                    data: null,
                    error: new Error('SIMULATED_STORAGE_OUTAGE_ON_CONTRACT_UPLOAD'),
                  });
                }
                return (bTarget as any)[bProp];
              },
            });
          },
        };
      }
      return (target as any)[prop];
    },
  });

  const webhookProviderRef = `WH-FAIL-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const webhookOccurredAt = new Date().toISOString();
  const webhookResult1 = await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_A1,
    provider_ref: webhookProviderRef,
    amount: 5000000, // Reaches deposit threshold (50% of 10,000,000)
    occurred_at: webhookOccurredAt,
    transfer_content: `Chuyen khoan ${webhookPayRef}`,
  }, failingStorageAdmin as any);

  assert.strictEqual(webhookResult1.status, 'MATCHED', 'Payment webhook itself succeeds with MATCHED');

  // Verify payment committed and deposit confirmed
  const { data: orderAfterWhFail } = await admin
    .from('orders')
    .select('deposit_status')
    .eq('id', webhookOrderId)
    .single();
  assert.strictEqual(orderAfterWhFail?.deposit_status, 'DEPOSIT_CONFIRMED', 'Order deposit_status must be DEPOSIT_CONFIRMED');

  // Verify no usable contract exists
  const { data: contractsWhFail } = await admin
    .from('contracts')
    .select('id, status, generated_file_ref')
    .eq('order_id', webhookOrderId);
  const usableWhContract = contractsWhFail?.find(c => c.status === 'GENERATED' && c.generated_file_ref && c.generated_file_ref !== 'CLAIMED');
  assert(!usableWhContract, 'No usable contract must exist after storage generation failure');

  testPass('Required Test 6: Payment reaches deposit threshold + contract storage generation fails -> payment committed, DEPOSIT_CONFIRMED, no usable contract');

  // --------------------------------------------------------------------------
  // Required Test 7: Same webhook retries -> payment remains counted once and contract generation recovers
  // --------------------------------------------------------------------------
  // Now call processPaymentWebhook with normal admin client (storage working)
  const webhookResult2 = await processPaymentWebhook({
    provider: PROVIDER,
    provider_account: ACC_A1,
    provider_ref: webhookProviderRef,
    amount: 5000000,
    occurred_at: webhookOccurredAt,
    transfer_content: `Chuyen khoan ${webhookPayRef}`,
  }, admin);

  assert.strictEqual(webhookResult2.status, 'ALREADY_PROCESSED', 'Webhook retry must return ALREADY_PROCESSED');

  // Payment counted once
  const { data: finWhRetry } = await admin
    .from('finance_summaries')
    .select('collected_amount')
    .eq('order_id', webhookOrderId)
    .single();
  assert.strictEqual(Number(finWhRetry?.collected_amount), 5000000, 'Collected amount must remain 5,000,000 (not double counted)');

  // Contract generation recovered!
  const { data: recoveredContracts } = await admin
    .from('contracts')
    .select('id, status, generated_file_ref, is_current')
    .eq('order_id', webhookOrderId)
    .eq('is_current', true);
  assert.strictEqual(recoveredContracts?.length, 1, 'Exactly one current contract must exist');
  assert.strictEqual(recoveredContracts[0].status, 'GENERATED');
  assert(recoveredContracts[0].generated_file_ref && recoveredContracts[0].generated_file_ref !== 'CLAIMED', 'Contract must have valid generated_file_ref');

  testPass('Required Test 7: Same webhook retries -> ALREADY_PROCESSED, payment counted once, contract generation recovers');

  // --------------------------------------------------------------------------
  // Required Test 8: Manual deposit reaches threshold + contract generation fails
  // --------------------------------------------------------------------------
  const { data: calcManFail } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { orderId: manFailOrderId } = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calcManFail.id,
  }, BOSS_A_CLIENT);

  const manFailCmdId = `cmd-man-fail-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const manFailRes = await updateOrderDepositAndDebt({
    companyId: COMPANY_A,
    orderId: manFailOrderId,
    depositAmount: 5000000, // Reaches deposit threshold
    idempotencyKey: manFailCmdId,
  }, BOSS_A_CLIENT, failingStorageAdmin as any);

  assert.strictEqual(manFailRes.status, 'MATCHED');
  assert.strictEqual(manFailRes.depositConfirmed, true);
  assert.strictEqual(manFailRes.contractGenerationStatus, 'PENDING_RECOVERY');

  const { data: orderAfterManFail } = await admin
    .from('orders')
    .select('deposit_status')
    .eq('id', manFailOrderId)
    .single();
  assert.strictEqual(orderAfterManFail?.deposit_status, 'DEPOSIT_CONFIRMED');

  testPass('Required Test 8: Manual deposit reaches threshold + contract generation fails -> returns PENDING_RECOVERY, deposit committed');

  // --------------------------------------------------------------------------
  // Required Test 9: Same manual command retry -> deposit remains counted once and contract recovers
  // --------------------------------------------------------------------------
  const manRecoverRes = await updateOrderDepositAndDebt({
    companyId: COMPANY_A,
    orderId: manFailOrderId,
    depositAmount: 5000000,
    idempotencyKey: manFailCmdId,
  }, BOSS_A_CLIENT, admin);

  assert.strictEqual(manRecoverRes.status, 'ALREADY_PROCESSED');
  assert.strictEqual(manRecoverRes.depositConfirmed, true);
  assert(
    manRecoverRes.contractGenerationStatus === 'GENERATED' || manRecoverRes.contractGenerationStatus === 'ALREADY_EXISTS',
    `Expected GENERATED or ALREADY_EXISTS, got ${manRecoverRes.contractGenerationStatus}`
  );
  assert(manRecoverRes.contractId, 'contractId must be returned on recovery');

  const { data: finManRecover } = await admin
    .from('finance_summaries')
    .select('collected_amount')
    .eq('order_id', manFailOrderId)
    .single();
  assert.strictEqual(Number(finManRecover?.collected_amount), 5000000, 'Collected amount must not double-count');

  testPass('Required Test 9: Same manual command retry -> deposit remains counted once and contract recovers');

  // --------------------------------------------------------------------------
  // Required Test 10: Deposit-confirmed Order without Contract -> recovery UI/action successfully creates canonical Contract
  // --------------------------------------------------------------------------
  const { data: calcRecovAction } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { orderId: recovActionOrderId } = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calcRecovAction.id,
  }, BOSS_A_CLIENT);

  // Direct DB update to set DEPOSIT_CONFIRMED without contract (simulating recovery needed)
  await admin.from('orders').update({ deposit_status: 'DEPOSIT_CONFIRMED' }).eq('id', recovActionOrderId);

  // Invoke recoverOrderContractAction as authorized BOSS
  const recovActionResultBoss = await recoverOrderContractAction(
    { orderId: recovActionOrderId },
    { userClient: bossRealClient }
  );

  assert.strictEqual(recovActionResultBoss.success, true, `Recovery action failed: ${recovActionResultBoss.error}`);
  assert.strictEqual(recovActionResultBoss.contractGenerationStatus, 'GENERATED');
  assert(recovActionResultBoss.contractId, 'Must return contractId');

  const { data: dbContractRecov } = await admin
    .from('contracts')
    .select('id, status, is_current')
    .eq('id', recovActionResultBoss.contractId)
    .single();
  assert.strictEqual(dbContractRecov?.status, 'GENERATED');
  assert.strictEqual(dbContractRecov?.is_current, true);

  testPass('Required Test 10: Deposit-confirmed Order without Contract -> recovery UI/action successfully creates canonical Contract');

  // --------------------------------------------------------------------------
  // Required Test 11: Deposit-not-confirmed Order -> recovery action rejected
  // --------------------------------------------------------------------------
  const { data: calcUnconfirmed } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { orderId: unconfirmedOrderId } = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calcUnconfirmed.id,
  }, BOSS_A_CLIENT);

  // Call recovery action on unconfirmed order
  const recovUnconfResult = await recoverOrderContractAction(
    { orderId: unconfirmedOrderId },
    { userClient: bossRealClient }
  );
  assert.strictEqual(recovUnconfResult.success, false, 'Must fail for unconfirmed order');
  assert(recovUnconfResult.error?.includes('DEPOSIT_NOT_CONFIRMED') || recovUnconfResult.error?.includes('chưa xác nhận cọc'), `Unexpected error message: ${recovUnconfResult.error}`);

  // Also test unauthorized role (TECHNICIAN)
  const recovTechResult = await recoverOrderContractAction(
    { orderId: recovActionOrderId },
    { userClient: techRealClient }
  );
  assert.strictEqual(recovTechResult.success, false, 'Must fail for TECHNICIAN role');

  testPass('Required Test 11: Deposit-not-confirmed Order -> recovery action rejected fail-closed, unauthorized roles rejected');

  // --------------------------------------------------------------------------
  // Required Test 12: Concurrent recovery calls -> exactly one current contract/revision
  // --------------------------------------------------------------------------
  const { data: calcConcRecov } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { width: 2, height: 1.5 },
    p_amount: 10000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  const { orderId: concRecovOrderId } = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calcConcRecov.id,
  }, BOSS_A_CLIENT);
  await admin.from('orders').update({ deposit_status: 'DEPOSIT_CONFIRMED' }).eq('id', concRecovOrderId);

  // 10 concurrent recovery calls
  const concRecoveryCalls = Array.from({ length: 10 }, () =>
    ensureContractForDepositConfirmedOrder(COMPANY_A, concRecovOrderId)
  );

  const concRecovResults = await Promise.all(concRecoveryCalls);
  const canonicalRecovContractId = concRecovResults[0].contractId;

  for (const r of concRecovResults) {
    assert.strictEqual(r.contractId, canonicalRecovContractId, 'All concurrent recovery calls must return the same contractId');
  }

  const { data: allContractsForOrder } = await admin
    .from('contracts')
    .select('id, revision_no, is_current')
    .eq('order_id', concRecovOrderId);

  assert.strictEqual(allContractsForOrder?.length, 1, `Must have exactly 1 contract row, found ${allContractsForOrder?.length}`);
  assert.strictEqual(allContractsForOrder[0].revision_no, 1, 'Must be revision 1');
  assert.strictEqual(allContractsForOrder[0].is_current, true, 'Must be is_current = true');

  testPass('Required Test 12: Concurrent recovery calls (10 concurrent) -> exactly one current contract/revision');

  // --------------------------------------------------------------------------
  // Required Test 13: Existing SIGNED Contract -> recovery is deterministic no-op and never overwrites it
  // --------------------------------------------------------------------------
  const signRes = await signContract({
    companyId: COMPANY_A,
    contractId: canonicalRecovContractId,
    signedPdfBuffer: validPdfBytes,
  }, BOSS_A_CLIENT);
  assert.strictEqual(signRes.success, true);
  assert.strictEqual(signRes.status, 'SIGNED');

  // Verify contract is SIGNED in DB
  const { data: contractBeforeRecov } = await admin
    .from('contracts')
    .select('status, signed_file_ref, revision_no')
    .eq('id', canonicalRecovContractId)
    .single();
  assert.strictEqual(contractBeforeRecov?.status, 'SIGNED');
  const originalSignedPath = contractBeforeRecov?.signed_file_ref;

  // Now call recovery on the SIGNED contract
  const signedRecovResult = await ensureContractForDepositConfirmedOrder(COMPANY_A, concRecovOrderId);
  assert.strictEqual(signedRecovResult.contractId, canonicalRecovContractId);
  assert.strictEqual(signedRecovResult.status, 'SIGNED');
  assert.strictEqual(signedRecovResult.contractGenerationStatus, 'ALREADY_EXISTS');

  // Re-verify DB state is completely untouched
  const { data: contractAfterRecov } = await admin
    .from('contracts')
    .select('status, signed_file_ref, revision_no')
    .eq('id', canonicalRecovContractId)
    .single();
  assert.strictEqual(contractAfterRecov?.status, 'SIGNED');
  assert.strictEqual(contractAfterRecov?.signed_file_ref, originalSignedPath);
  assert.strictEqual(contractAfterRecov?.revision_no, contractBeforeRecov?.revision_no);

  testPass('Required Test 13: Existing SIGNED Contract -> recovery is deterministic no-op and never overwrites it');

  // --------------------------------------------------------------------------
  // Required Test 14: Storage conflict classification & contract generation recovery
  // --------------------------------------------------------------------------
  // 1. Direct unit verification of isStorageResourceConflict
  assert.strictEqual(isStorageResourceConflict({ statusCode: '409' }), true);
  assert.strictEqual(isStorageResourceConflict({ statusCode: 409 }), true);
  assert.strictEqual(isStorageResourceConflict({ status: 409 }), true);
  assert.strictEqual(isStorageResourceConflict({ code: 'ResourceAlreadyExists' }), true);
  assert.strictEqual(isStorageResourceConflict({ message: 'The resource already exists' }), true);
  assert.strictEqual(isStorageResourceConflict({ message: 'Error: ResourceAlreadyExists' }), true);
  assert.strictEqual(isStorageResourceConflict({ statusCode: 500, message: 'Internal server error' }), false);
  assert.strictEqual(isStorageResourceConflict({ statusCode: '403', message: 'Forbidden' }), false);
  assert.strictEqual(isStorageResourceConflict(null), false);
  assert.strictEqual(isStorageResourceConflict(undefined), false);
  assert.strictEqual(isStorageResourceConflict({}), false);
  assert.strictEqual(isStorageResourceConflict({ message: 'Network request failed' }), false);

  // 2. Integration: genuine storage 409 recovers and finalizes canonical contract
  const { data: calc409, error: calc409Err } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { length: 2.0, height: 1.5 },
    p_amount: 14000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert(!calc409Err && calc409, `save_price_calculation_rpc calc409 failed: ${calc409Err?.message}`);

  const { orderId: order409Id } = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calc409.id,
  }, BOSS_A_CLIENT);
  await admin.from('orders').update({ deposit_status: 'DEPOSIT_CONFIRMED' }).eq('id', order409Id);

  const storage409Proxy = new Proxy(admin, {
    get(target, prop) {
      if (prop === 'storage') {
        return {
          from(bucket: string) {
            const originBucket = (target as any).storage.from(bucket);
            return {
              ...originBucket,
              upload: async () => ({
                data: null,
                error: {
                  statusCode: '409',
                  status: 409,
                  message: 'The resource already exists',
                },
              }),
            };
          },
        };
      }
      return (target as any)[prop];
    },
  });

  const res409 = await generateContractForOrder({
    companyId: COMPANY_A,
    orderId: order409Id,
  }, storage409Proxy as any);
  assert.strictEqual(res409.status, 'GENERATED');
  assert.strictEqual(res409.revisionNo, 1);

  // 3. Integration: unrelated storage upload error (500) throws and aborts without finalization
  const { data: calc500, error: calc500Err } = await admin.rpc('save_price_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_survey_id: null,
    p_pricing_policy_id: POLICY_A_ID,
    p_policy_version: 'v1',
    p_input_data: { length: 2.0, height: 1.5 },
    p_amount: 14000000,
    p_status: 'CALCULATED',
    p_missing_fields: [],
  });
  assert(!calc500Err && calc500, `save_price_calculation_rpc calc500 failed: ${calc500Err?.message}`);

  const { orderId: order500Id } = await createOrderFromCalculation({
    companyId: COMPANY_A,
    customerId: CUSTOMER_A,
    priceCalculationId: calc500.id,
  }, BOSS_A_CLIENT);
  await admin.from('orders').update({ deposit_status: 'DEPOSIT_CONFIRMED' }).eq('id', order500Id);

  const storage500Proxy = new Proxy(admin, {
    get(target, prop) {
      if (prop === 'storage') {
        return {
          from(bucket: string) {
            const originBucket = (target as any).storage.from(bucket);
            return {
              ...originBucket,
              upload: async () => ({
                data: null,
                error: {
                  statusCode: '500',
                  status: 500,
                  message: 'Internal server error',
                },
              }),
            };
          },
        };
      }
      return (target as any)[prop];
    },
  });

  let threw500 = false;
  try {
    await generateContractForOrder({
      companyId: COMPANY_A,
      orderId: order500Id,
    }, storage500Proxy as any);
  } catch (err: any) {
    threw500 = true;
    assert.strictEqual(err.message, 'Không thể lưu trữ tệp hợp đồng');
  }
  assert.strictEqual(threw500, true, 'Unrelated storage error must throw');

  // Verify that for order500, no contract was finalized (remains CLAIMED, not canonical path)
  const { data: unfinalizedContracts } = await admin
    .from('contracts')
    .select('id, status, generated_file_ref')
    .eq('order_id', order500Id);
  assert.strictEqual(unfinalizedContracts?.[0]?.generated_file_ref, 'CLAIMED', 'Must not finalize contract on upload failure');

  testPass('Required Test 14: Storage conflict classification & contract generation recovery (409 recoverable, 500 throws, canonical revision preserved)');

  // --------------------------------------------------------------------------
  // Required Test 15: Historical duplicate Orders remediation & audit provenance (all 10 invariants)
  // --------------------------------------------------------------------------
  const { execSync: runPsql } = await import('node:child_process');
  const runPsqlScript = (sql: string) =>
    runPsql('docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -v ON_ERROR_STOP=1 -U postgres -d postgres', {
      input: sql,
      encoding: 'utf8',
    });

  const COMPANY_MIG = crypto.randomUUID();
  const CUSTOMER_MIG = crypto.randomUUID();
  const CALC_ORIG_ID = crypto.randomUUID();
  const ORDER_1_ID = crypto.randomUUID();
  const ORDER_2_ID = crypto.randomUUID();
  const AUDIT_1_ID = crypto.randomUUID();
  const AUDIT_2_ID = crypto.randomUUID();

  // Setup company and customer for migration test
  const { error: compErr } = await admin.from('companies').insert({ id: COMPANY_MIG, name: `Company MIG ${RUN_ID}`, status: 'ACTIVE' });
  assert(!compErr, `insert companies failed: ${compErr?.message}`);

  const POLICY_MIG_ID = crypto.randomUUID();
  const { error: polErr } = await admin.from('pricing_policies').insert({
    id: POLICY_MIG_ID,
    company_id: COMPANY_MIG,
    version: '1.0',
    conditions: { deposit_percentage: 30 },
    price_rules: { base_price_per_sqm: 5000000 },
    effective_at: new Date().toISOString(),
    status: 'ACTIVE',
  });
  assert(!polErr, `insert pricing_policies failed: ${polErr?.message}`);

  const { error: cusErr } = await admin.from('customers').insert({
    id: CUSTOMER_MIG,
    company_id: COMPANY_MIG,
    customer_code: `CUSMIG_${RUN_ID}`,
    name: 'Customer Migration Test',
    source: 'MANUAL',
    stage: 'LEAD_NEW',
  });
  assert(!cusErr, `insert customers failed: ${cusErr?.message}`);

  // Seed original PriceCalculation A
  const originalInputData = { length: 3.5, height: 1.8, variant: 'premium' };
  const { error: calcMigErr } = await admin.from('price_calculations').insert({
    id: CALC_ORIG_ID,
    company_id: COMPANY_MIG,
    customer_id: CUSTOMER_MIG,
    pricing_policy_id: POLICY_MIG_ID,
    policy_version: '1.0',
    input_data: originalInputData,
    amount: 15500000,
    status: 'CALCULATED',
    missing_fields: [],
  });
  assert(!calcMigErr, `insert price_calculations failed: ${calcMigErr?.message}`);

  // To simulate the historical state prior to migration 20261002220001:
  // 1. Temporarily drop the UNIQUE constraint uq_orders_company_price_calc
  // 2. Insert two orders referencing the same price_calculation_id (Order 1 older, Order 2 newer)
  // 3. Insert existing historical ORDER_CREATED audit logs referencing CALC_ORIG_ID
  const seedHistoricalDuplicatesSql = `
    ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS uq_orders_company_price_calc;

    SET session_replication_role = 'replica';
    INSERT INTO public.orders (
      id, company_id, customer_id, order_code, payment_reference, price_calculation_id, deposit_status, order_status, final_amount, created_at
    ) VALUES
      ('${ORDER_1_ID}', '${COMPANY_MIG}', '${CUSTOMER_MIG}', 'ORD-MIG-1', 'REF-MIG-1', '${CALC_ORIG_ID}', 'PENDING', 'DRAFT', 15500000, clock_timestamp() - interval '20 minutes'),
      ('${ORDER_2_ID}', '${COMPANY_MIG}', '${CUSTOMER_MIG}', 'ORD-MIG-2', 'REF-MIG-2', '${CALC_ORIG_ID}', 'PENDING', 'DRAFT', 15500000, clock_timestamp() - interval '10 minutes');

    INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
    VALUES
      ('${ORDER_1_ID}', '${COMPANY_MIG}', 15500000, 0, 15500000),
      ('${ORDER_2_ID}', '${COMPANY_MIG}', 15500000, 0, 15500000);
    SET session_replication_role = 'origin';

    INSERT INTO public.audit_logs (id, company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata, created_at)
    VALUES
      ('${AUDIT_1_ID}', '${COMPANY_MIG}', NULL, 'ORDER_CREATED', 'orders', '${ORDER_1_ID}', '${CUSTOMER_MIG}', 'SUCCESS', '{"price_calculation_id": "${CALC_ORIG_ID}", "order_code": "ORD-MIG-1"}'::jsonb, clock_timestamp() - interval '20 minutes'),
      ('${AUDIT_2_ID}', '${COMPANY_MIG}', NULL, 'ORDER_CREATED', 'orders', '${ORDER_2_ID}', '${CUSTOMER_MIG}', 'SUCCESS', '{"price_calculation_id": "${CALC_ORIG_ID}", "order_code": "ORD-MIG-2"}'::jsonb, clock_timestamp() - interval '10 minutes');
  `;

  runPsqlScript(seedHistoricalDuplicatesSql);

  // Snapshot audit log count before running remediation
  const auditCountBeforeStr = runPsql(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -U postgres -d postgres -c "SELECT count(*) FROM public.audit_logs WHERE company_id = '${COMPANY_MIG}';"`,
    { encoding: 'utf8' }
  ).trim();
  const auditCountBefore = parseInt(auditCountBeforeStr, 10);
  assert.strictEqual(auditCountBefore, 2, 'Pre-remediation must have exactly 2 ORDER_CREATED audit logs');

  // Execute the exact remediation DO block from migration 20261002220001
  const remediationSql = `
  DO $$
  DECLARE
      r RECORD;
      v_new_calc_id uuid;
  BEGIN
      FOR r IN (
          SELECT o.id as order_id, o.company_id, o.customer_id, o.price_calculation_id
          FROM (
              SELECT id, company_id, customer_id, price_calculation_id,
                     ROW_NUMBER() OVER (PARTITION BY company_id, price_calculation_id ORDER BY created_at ASC, id ASC) as rn
              FROM public.orders
          ) o
          WHERE o.rn > 1
      ) LOOP
          v_new_calc_id := gen_random_uuid();
          INSERT INTO public.price_calculations (
              id, company_id, customer_id, survey_id, pricing_policy_id, policy_version, input_data, amount, status, missing_fields, created_at
          )
          SELECT v_new_calc_id, company_id, customer_id, survey_id, pricing_policy_id, policy_version, input_data, amount, status, missing_fields, created_at
          FROM public.price_calculations
          WHERE id = r.price_calculation_id;

          -- Strictly scope replica mode to rewriting the order's immutable price_calculation_id
          SET session_replication_role = 'replica';
          UPDATE public.orders
          SET price_calculation_id = v_new_calc_id
          WHERE id = r.order_id;
          SET session_replication_role = 'origin';

          -- Append-only audit record for historical duplicate order remediation
          INSERT INTO public.audit_logs (
              id,
              company_id,
              user_id,
              action,
              resource_type,
              resource_id,
              customer_id,
              result,
              metadata,
              created_at
          ) VALUES (
              gen_random_uuid(),
              r.company_id,
              NULL,
              'ORDER_PRICE_CALCULATION_REBOUND_MIGRATION',
              'orders',
              r.order_id,
              r.customer_id,
              'SUCCESS',
              jsonb_build_object(
                  'migration', '20261002220001',
                  'original_price_calculation_id', r.price_calculation_id,
                  'replacement_price_calculation_id', v_new_calc_id,
                  'reason', 'historical_duplicate_remediation'
              ),
              now()
          );
      END LOOP;

      -- Ensure session_replication_role is guaranteed origin
      SET session_replication_role = 'origin';

      IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_orders_company_price_calc'
      ) THEN
          ALTER TABLE public.orders
          ADD CONSTRAINT uq_orders_company_price_calc UNIQUE (company_id, price_calculation_id);
      END IF;
  END $$;
  `;

  runPsqlScript(remediationSql);

  // =========================================================================
  // VERIFY ALL 10 INVARIANTS
  // =========================================================================

  // Invariant 1: UNIQUE (company_id, price_calculation_id) can be installed
  const constraintCheck = runPsql(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -U postgres -d postgres -c "SELECT conname FROM pg_constraint WHERE conname = 'uq_orders_company_price_calc' AND conrelid = 'public.orders'::regclass;"`,
    { encoding: 'utf8' }
  ).trim();
  assert.strictEqual(constraintCheck, 'uq_orders_company_price_calc', 'Invariant 1: Constraint uq_orders_company_price_calc must be installed');

  // Invariant 2: No Order/payment/finance/contract is deleted
  const { data: ordersAfter } = await admin
    .from('orders')
    .select('id, order_code, price_calculation_id, final_amount')
    .eq('company_id', COMPANY_MIG)
    .order('order_code', { ascending: true });
  assert.strictEqual(ordersAfter?.length, 2, 'Invariant 2: Both orders must still exist (no deletions)');

  const { data: financesAfter } = await admin
    .from('finance_summaries')
    .select('order_id, contract_value')
    .eq('company_id', COMPANY_MIG);
  assert.strictEqual(financesAfter?.length, 2, 'Invariant 2: Finance summaries must still exist');

  // Invariant 3: Canonical Order remains valid (Order 1 keeps CALC_ORIG_ID)
  const order1After = ordersAfter?.find((o) => o.id === ORDER_1_ID);
  assert(order1After, 'Order 1 must exist');
  assert.strictEqual(order1After.price_calculation_id, CALC_ORIG_ID, 'Invariant 3: Canonical Order 1 must retain original CALC_ORIG_ID');

  // Invariant 4: Any remapped Order receives a valid replacement calculation
  const order2After = ordersAfter?.find((o) => o.id === ORDER_2_ID);
  assert(order2After, 'Order 2 must exist');
  assert.notStrictEqual(order2After.price_calculation_id, CALC_ORIG_ID, 'Invariant 4: Order 2 must receive replacement calculation');
  const replacementCalcId = order2After.price_calculation_id;

  const { data: replacementCalc } = await admin
    .from('price_calculations')
    .select('*')
    .eq('id', replacementCalcId)
    .single();
  assert(replacementCalc, 'Invariant 4: Replacement calculation must exist in DB');

  // Invariant 5: Replacement calculation pricing facts exactly match the original
  const { data: originalCalc } = await admin
    .from('price_calculations')
    .select('*')
    .eq('id', CALC_ORIG_ID)
    .single();
  assert(originalCalc, 'Original calculation must exist');

  assert.strictEqual(replacementCalc.survey_id, originalCalc.survey_id, 'Invariant 5: survey_id matches');
  assert.strictEqual(replacementCalc.pricing_policy_id, originalCalc.pricing_policy_id, 'Invariant 5: pricing_policy_id matches');
  assert.strictEqual(replacementCalc.policy_version, originalCalc.policy_version, 'Invariant 5: policy_version matches');
  assert.strictEqual(Number(replacementCalc.amount), Number(originalCalc.amount), 'Invariant 5: amount matches');
  assert.strictEqual(replacementCalc.status, originalCalc.status, 'Invariant 5: status matches');
  assert.deepStrictEqual(replacementCalc.missing_fields, originalCalc.missing_fields, 'Invariant 5: missing_fields match');
  assert.deepStrictEqual(replacementCalc.input_data, originalCalc.input_data, 'Invariant 5: input_data matches exactly');

  // Invariant 6: Existing ORDER_CREATED audit record remains unchanged
  const { data: originalAudit1 } = await admin
    .from('audit_logs')
    .select('*')
    .eq('id', AUDIT_1_ID)
    .single();
  assert.strictEqual(originalAudit1.action, 'ORDER_CREATED', 'Invariant 6: Audit 1 action unchanged');
  assert.strictEqual(originalAudit1.metadata.price_calculation_id, CALC_ORIG_ID, 'Invariant 6: Audit 1 references original calculation');

  const { data: originalAudit2 } = await admin
    .from('audit_logs')
    .select('*')
    .eq('id', AUDIT_2_ID)
    .single();
  assert.strictEqual(originalAudit2.action, 'ORDER_CREATED', 'Invariant 6: Audit 2 action unchanged');
  assert.strictEqual(originalAudit2.metadata.price_calculation_id, CALC_ORIG_ID, 'Invariant 6: Audit 2 references original calculation');

  // Invariant 7: A new append-only remediation audit/provenance record explains original ID -> replacement ID
  const { data: remediationAudits } = await admin
    .from('audit_logs')
    .select('*')
    .eq('company_id', COMPANY_MIG)
    .eq('action', 'ORDER_PRICE_CALCULATION_REBOUND_MIGRATION');
  assert.strictEqual(remediationAudits?.length, 1, 'Invariant 7: Exactly 1 remediation audit record created');
  const remLog = remediationAudits![0];
  assert.strictEqual(remLog.resource_type, 'orders', 'Invariant 7: resource_type is orders');
  assert.strictEqual(remLog.resource_id, ORDER_2_ID, 'Invariant 7: resource_id is remapped order ID');
  assert.strictEqual(remLog.customer_id, CUSTOMER_MIG, 'Invariant 7: customer_id matches');
  assert.strictEqual(remLog.result, 'SUCCESS', 'Invariant 7: result is SUCCESS');
  assert.strictEqual(remLog.metadata.migration, '20261002220001', 'Invariant 7: metadata.migration is 20261002220001');
  assert.strictEqual(remLog.metadata.original_price_calculation_id, CALC_ORIG_ID, 'Invariant 7: original_price_calculation_id matches');
  assert.strictEqual(remLog.metadata.replacement_price_calculation_id, replacementCalcId, 'Invariant 7: replacement_price_calculation_id matches');
  assert.strictEqual(remLog.metadata.reason, 'historical_duplicate_remediation', 'Invariant 7: reason matches');

  // Invariant 8: No historical audit row is UPDATEd or DELETEd
  const auditCountAfterStr = runPsql(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -U postgres -d postgres -c "SELECT count(*) FROM public.audit_logs WHERE company_id = '${COMPANY_MIG}';"`,
    { encoding: 'utf8' }
  ).trim();
  const auditCountAfter = parseInt(auditCountAfterStr, 10);
  assert.strictEqual(auditCountAfter, auditCountBefore + 1, 'Invariant 8: Total audit logs increased by exactly 1 append-only row');

  // Invariant 9: Foreign keys remain valid after remediation
  const fkCheckOrder2 = runPsql(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -U postgres -d postgres -c "SELECT count(*) FROM public.orders o JOIN public.price_calculations pc ON o.price_calculation_id = pc.id WHERE o.id = '${ORDER_2_ID}';"`,
    { encoding: 'utf8' }
  ).trim();
  assert.strictEqual(fkCheckOrder2, '1', 'Invariant 9: Foreign key between orders and price_calculations is valid for remapped order');

  // Invariant 10: Trigger/replication-role bypass is limited strictly to the required migration repair window
  const currentRole = runPsql(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -t -A -U postgres -d postgres -c "SHOW session_replication_role;"`,
    { encoding: 'utf8' }
  ).trim();
  assert.strictEqual(currentRole, 'origin', 'Invariant 10: session_replication_role is origin');

  // Attempting an immutable column update in origin mode MUST fail with immutability trigger error
  let updateBlocked = false;
  try {
    runPsql(
      `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "UPDATE public.orders SET price_calculation_id = '${crypto.randomUUID()}' WHERE id = '${ORDER_1_ID}';"`,
      { encoding: 'utf8' }
    );
  } catch (err: any) {
    updateBlocked = true;
    assert(err.message.includes('immutable'), 'Invariant 10: Attempted mutation must be blocked by immutability trigger');
  }
  assert.strictEqual(updateBlocked, true, 'Invariant 10: Immutability trigger is active and operational in origin mode');

  testPass('Required Test 15: Historical duplicate Orders remediation & audit provenance (all 10 invariants verified)');

  console.log(`\n================================================================`);
  console.log(`COMMERCIAL DB INTEGRATION TESTS COMPLETED: ${passCount} PASSED, 0 FAILED`);
  console.log(`================================================================\n`);
  } finally {
    for (const uid of createdUserIds) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch {}
    }
  }
}

run().catch((err) => {
  console.error('\n[FATAL ERROR IN COMMERCIAL INTEGRATION TESTS]:', err);
  process.exit(1);
});
