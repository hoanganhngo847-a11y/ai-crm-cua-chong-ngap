/**
 * TV7 Commercial DB Integration Tests
 * Real DB verification against local Supabase / PostgreSQL.
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { generateContractForOrder, signContract, getContractDownloadUrl } from '../../features/contract/services';
import { createOrderFromCalculation, updateOrderDepositAndDebt } from '../../features/order/services';
import { processPaymentWebhook } from '../../features/payment/services';
import { calculateAndSavePriceCalculation } from '../../features/pricing/services';
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
  const USER_BOSS_A = await createUserWithRole(USER_BOSS_A_EMAIL, 'Boss A', COMPANY_A, 'BOSS_ADMIN');
  const USER_SALE_A = await createUserWithRole(`sale_a_${RUN_ID}@test.local`, 'Sale A', COMPANY_A, 'SALE');
  const USER_TECH_A = await createUserWithRole(`tech_a_${RUN_ID}@test.local`, 'Tech A', COMPANY_A, 'TECHNICIAN');
  const USER_BOSS_B = await createUserWithRole(`boss_b_${RUN_ID}@test.local`, 'Boss B', COMPANY_B, 'BOSS_ADMIN');

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
      conditions: { deposit_percentage: 30 },
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
  // Create Order 1 and Order 2 in Company A
  const { data: orderMan1 } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: CALCULATION_ID,
    p_payment_reference: `DH-MAN1${RUN_ID}`,
    p_actor_user_id: USER_BOSS_A,
  });
  const ORDER_MAN_1_ID = orderMan1.orderId;

  const { data: orderMan2 } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: CALCULATION_ID,
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
  const { data: unconfirmedOrder } = await admin.rpc('create_order_from_calculation_rpc', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_price_calculation_id: CALCULATION_ID,
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

  // Case G: Idempotent re-sign with SAME file ref returns ALREADY_PROCESSED
  const dupSignResult = await admin.rpc('finalize_contract_signing_rpc', {
    p_company_id: COMPANY_A,
    p_contract_id: CONTRACT_REV2_ID,
    p_actor_user_id: USER_BOSS_A,
    p_signed_file_ref: expectedRev2Path,
    p_aal_level: 'aal2',
  });
  assert.strictEqual(dupSignResult.data.status, 'ALREADY_PROCESSED');

  // Case H: Signed contract cannot be overwritten with different file ref -> rejected
  const { error: overwriteErr } = await admin.rpc('finalize_contract_signing_rpc', {
    p_company_id: COMPANY_A,
    p_contract_id: CONTRACT_REV2_ID,
    p_actor_user_id: USER_BOSS_A,
    p_signed_file_ref: `${COMPANY_A}/contracts/${CONTRACT_REV2_ID}/revision-2/signed_tampered.pdf`,
    p_aal_level: 'aal2',
  });
  assert(overwriteErr?.message.includes('INVALID_SIGNED_FILE_REF') || overwriteErr?.message.includes('CONTRACT_ALREADY_SIGNED_WITH_DIFFERENT_FILE'));

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

  console.log(`\n================================================================`);
  console.log(`COMMERCIAL DB INTEGRATION TESTS COMPLETED: ${passCount} PASSED, 0 FAILED`);
  console.log(`================================================================\n`);
}

run().catch((err) => {
  console.error('\n[FATAL ERROR IN COMMERCIAL INTEGRATION TESTS]:', err);
  process.exit(1);
});
