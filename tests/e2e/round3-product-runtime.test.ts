/**
 * ROUND 3 PRODUCT WIRING & AI RUNTIME REGRESSION SUITE
 * 
 * Validates:
 * P1-004 Commercial UI & Invariants (Quotations, Orders, Manual Deposit, Contract Signing with AAL2)
 * P1-005 Operations UI & Invariants (Production Release with Canonical Facts, Field Technician Workspace, Handover, Warranty)
 * P1-006 Real AI Runtime Wiring (Customer Analysis, Sales Style Context, Policy Firewall, Outbound Provider Confirmation, Response SLA Resolution)
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  calculateAndSavePriceCalculation,
} from '../../features/pricing/services';
import {
  createOrderFromCalculation,
  updateOrderDepositAndDebt,
} from '../../features/order/services';
import {
  generateContractForOrder,
  signContract,
  getContractDownloadUrl,
} from '../../features/contract/services';
import {
  deriveCanonicalProductionFacts,
  createProductionOrder,
  getProductionDashboardData,
  updateProductionProgress,
  recordQualityCheck,
} from '../../features/production/production-service';
import {
  getTechnicianFieldWorkspaceData,
  createInstallationSchedule,
  acceptInstallationAppointment,
  startInstallationWork,
  updateInstallationStatus,
  attachInstallationEvidence,
  completeInstallationAndHandover,
} from '../../features/installation/installation-service';
import {
  createWarrantyTicket,
  assignWarrantyTicket,
  updateWarrantyStatus,
  getWarrantyDashboardData,
} from '../../features/warranty/warranty-service';
import {
  executeAiResponseRuntime,
  validateAiResponsePolicyFirewall,
  PolicyFirewallViolationError,
  type AiResponseModel,
} from '../../features/automation/response-sla/services/ai-response-runtime';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { processDueResponseSlaWindows } from '../../features/automation/response-sla/services/sla-automation-worker';
import { openResponseSlaWindow, claimResponseSlaForAi } from '../../features/automation/response-sla/services/response-sla-store';
import { buildRuntimeSalesStyleContext } from '../../features/sales-style/services/runtime-style-context';
import { ZaloInboxService } from '../../features/omnichannel/zalo/inbox-service';

function expireClaimDirectSql(windowId: string): void {
  execSync(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "UPDATE public.response_sla_windows SET ai_claimed_at = clock_timestamp() - interval '3 minutes', ai_claim_expires_at = clock_timestamp() - interval '1 second', updated_at = clock_timestamp() WHERE id = '${windowId}';"`
  );
}

function expireDispatchFenceDirectSql(windowId: string): void {
  execSync(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "UPDATE public.response_sla_windows SET dispatch_fenced_until = clock_timestamp() - interval '5 seconds', ai_dispatch_fenced_until = clock_timestamp() - interval '5 seconds', updated_at = clock_timestamp() WHERE id = '${windowId}';"`
  );
}

function setWindowDispatchTokenDirectSql(windowId: string, token: string): void {
  execSync(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "UPDATE public.response_sla_windows SET dispatch_token = '${token}', ai_dispatch_token = '${token}', updated_at = clock_timestamp() WHERE id = '${windowId}';"`
  );
}

function expireZaloDeliveryLeaseDirectSql(deliveryId: string): void {
  execSync(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "UPDATE public.zalo_outbound_deliveries SET lease_until = clock_timestamp() - interval '10 seconds', updated_at = clock_timestamp() WHERE id = '${deliveryId}';"`
  );
}

function queryRawJson<T>(sql: string): T {
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

function insertHanReceiptDirectSql(receipt: {
  company_id: string;
  external_identity: string;
  event_key: string;
  kind: 'DELIVERY' | 'READ';
  mids?: string[];
  watermark?: number;
}): void {
  const midsSql =
    receipt.mids && receipt.mids.length > 0
      ? `ARRAY[${receipt.mids.map((m) => `'${m}'`).join(',')}]`
      : `ARRAY[]::text[]`;
  const watermarkSql = receipt.watermark !== undefined ? receipt.watermark.toString() : 'NULL';
  execSync(
    `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "INSERT INTO private.han_receipts (company_id, external_identity, event_key, kind, mids, watermark) VALUES ('${receipt.company_id}', '${receipt.external_identity}', '${receipt.event_key}', '${receipt.kind}', ${midsSql}, ${watermarkSql});"`
  );
}

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

let testCount = 0;
function pass(name: string) {
  testCount++;
  console.log(`[PASS ${testCount}] ${name}`);
}

async function run() {
  console.log('================================================================');
  console.log('STARTING ROUND 3 PRODUCT WIRING & REAL RUNTIME REGRESSION SUITE');
  console.log('================================================================\n');

  const createdUserIds: string[] = [];
  try {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const COMPANY_ID = crypto.randomUUID();
  const OTHER_COMPANY_ID = crypto.randomUUID();

  // 1. Setup companies
  await admin.from('companies').upsert([
    { id: COMPANY_ID, name: `Round3 Co ${RUN_ID}`, status: 'ACTIVE' },
    { id: OTHER_COMPANY_ID, name: `Other Co ${RUN_ID}`, status: 'ACTIVE' },
  ]);

  // Setup pricing policy for COMPANY_ID
  const POLICY_ID = crypto.randomUUID();
  const { error: pErr } = await admin.from('pricing_policies').insert({
    id: POLICY_ID,
    company_id: COMPANY_ID,
    version: 'v1',
    status: 'ACTIVE',
    effective_at: new Date(Date.now() - 60000).toISOString(),
    conditions: { deposit_percentage: 30, standard_materials: { aluminum: '6063-T5' } },
    price_rules: { base_price_per_sqm: 5000000 },
  });
  if (pErr) throw pErr;

  // Setup company bank accounts for payments/deposits
  await admin.from('company_bank_accounts').insert({
    company_id: COMPANY_ID,
    provider: 'VIETQR',
    provider_account: `ACC_ROUND3_${RUN_ID}`,
  });

  // Helper to create user with profile and membership
  async function createMember(email: string, role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN') {
    const { data: userRes, error } = await admin.auth.admin.createUser({
      email,
      password: 'TestPassword123!',
      email_confirm: true,
      user_metadata: { full_name: `User ${role}` },
    });
    if (error || !userRes.user) throw error || new Error('User creation failed');
    const uid = userRes.user.id;
    createdUserIds.push(uid);

    await admin.from('user_profiles').upsert({
      id: uid,
      full_name: `User ${role}`,
      status: 'ACTIVE',
    });

    await admin.from('company_members').upsert({
      company_id: COMPANY_ID,
      user_id: uid,
      role,
      status: 'ACTIVE',
    });

    return { id: uid, email, role };
  }

  const boss = await createMember(`boss_${RUN_ID}@test.local`, 'BOSS_ADMIN');
  const sale = await createMember(`sale_${RUN_ID}@test.local`, 'SALE');
  const tech = await createMember(`tech_${RUN_ID}@test.local`, 'TECHNICIAN');
  const otherTech = await createMember(`other_tech_${RUN_ID}@test.local`, 'TECHNICIAN');

  function createMockClient(user: { id: string; email: string }, aal: 'aal1' | 'aal2' = 'aal1') {
    return {
      auth: {
        getUser: async () => ({
          data: { user: { id: user.id, email: user.email } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: aal, nextLevel: aal, currentAuthenticationMethods: [] },
            error: null,
          }),
          listFactors: async () => ({
            data: { totp: [{ id: 'factor-boss-totp', status: aal === 'aal2' ? 'verified' : 'unverified' }] },
            error: null,
          }),
        },
      },
      from: (table: string) => admin.from(table),
    } as unknown as SupabaseClient;
  }

  const bossClientAal2 = createMockClient(boss, 'aal2');
  const bossClientAal1 = createMockClient(boss, 'aal1');
  const saleClient = createMockClient(sale, 'aal1');
  const techClient = createMockClient(tech, 'aal1');

  const bossRealClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await bossRealClient.auth.signInWithPassword({
    email: boss.email,
    password: 'TestPassword123!',
  });

  // Setup Customer
  const CUSTOMER_ID = crypto.randomUUID();
  await admin.from('customers').insert({
    id: CUSTOMER_ID,
    company_id: COMPANY_ID,
    customer_code: `CUST_${RUN_ID}`,
    name: 'Nguyễn Văn Test',
    source: 'WEBSITE',
    stage: 'LEAD_NEW',
  });

  // ============================================================================
  // SECTION 1: COMMERCIAL FLOW TESTS (P1-004)
  // ============================================================================
  console.log('\n--- SECTION 1: Commercial Flow & Invariants ---');

  // 1.1 NEED_INFO Calculation Cannot Create Order
  const needInfoCalc = await calculateAndSavePriceCalculation(
    {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      measurements: {
        width: 2000,
        // height missing -> causes NEED_INFO status
      },
    },
    saleClient
  );
  assert.strictEqual(needInfoCalc.status, 'NEED_INFO', 'Calculation must be NEED_INFO');

  let orderFromNeedInfoError: any = null;
  try {
    await createOrderFromCalculation(
      {
        companyId: COMPANY_ID,
        customerId: CUSTOMER_ID,
        priceCalculationId: needInfoCalc.id,
      },
      saleClient
    );
  } catch (err: any) {
    orderFromNeedInfoError = err;
  }
  assert.ok(orderFromNeedInfoError, 'Order creation from NEED_INFO calculation must fail');
  pass('NEED_INFO calculation cannot create order (Fail-Closed)');

  // 1.2 CALCULATED Calculation Can Create Order with Server Authoritative Amount
  const validCalc = await calculateAndSavePriceCalculation(
    {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      measurements: {
        width: 2.0,
        height: 0.8,
        gate_type: 'STAINLESS_STEEL',
        mounting_method: 'SURFACE',
      },
    },
    saleClient
  );
  assert.strictEqual(validCalc.status, 'CALCULATED', 'Valid calculation must be CALCULATED');
  assert.ok(validCalc.amount > 0, 'Amount must be positive');

  const orderResult = await createOrderFromCalculation(
    {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      priceCalculationId: validCalc.id,
    },
    saleClient
  );
  const ORDER_ID = orderResult.orderId || orderResult.order_id;
  assert.ok(ORDER_ID, 'Order must be created');
  pass('CALCULATED calculation creates order with server-authoritative amount & reference');

  // Verify order in database
  const { data: orderRow } = await admin
    .from('orders')
    .select('id, order_code, final_amount, deposit_status, order_status')
    .eq('id', ORDER_ID)
    .single();
  assert.strictEqual(orderRow!.deposit_status, 'PENDING', 'Initial deposit must not be confirmed');
  assert.strictEqual(orderRow!.order_status, 'DRAFT', 'Initial status must be DRAFT');

  // 1.3 Duplicate / Retry Creation on same Calculation
  const duplicateResult = await createOrderFromCalculation(
    {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      priceCalculationId: validCalc.id,
    },
    saleClient
  );
  assert.strictEqual(duplicateResult.status, 'ALREADY_EXISTS', 'Duplicate creation must return ALREADY_EXISTS');
  assert.strictEqual(duplicateResult.orderId, ORDER_ID, 'Duplicate must resolve to the same orderId');
  assert.strictEqual(duplicateResult.paymentReference, orderResult.paymentReference, 'Duplicate must return canonical payment reference');

  const { count: orderCount } = await admin
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', COMPANY_ID)
    .eq('price_calculation_id', validCalc.id);
  assert.strictEqual(orderCount, 1, 'Exactly one order must exist for price calculation');
  pass('Duplicate order creation is rejected');

  // 1.4 Manual Deposit Mutation Authorization: SALE is Forbidden, BOSS_ADMIN is Allowed
  let saleDepositError: any = null;
  try {
    await updateOrderDepositAndDebt(
      {
        companyId: COMPANY_ID,
        orderId: ORDER_ID,
        depositAmount: 5000000,
        idempotencyKey: `dep_sale_${RUN_ID}`,
      },
      saleClient
    );
  } catch (err: any) {
    saleDepositError = err;
  }
  assert.ok(saleDepositError, 'SALE role must NOT be permitted to mutate deposit');
  pass('SALE cannot perform Boss-only manual deposit mutation');

  // BOSS_ADMIN manual deposit succeeds with idempotency key
  const bossDepositRes = await updateOrderDepositAndDebt(
    {
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      depositAmount: 5000000,
      idempotencyKey: `dep_boss_${RUN_ID}`,
    },
    bossClientAal1
  );
  assert.ok(bossDepositRes.depositConfirmed, 'Deposit must be confirmed by Boss');
  const { data: updatedOrderRow } = await admin
    .from('orders')
    .select('order_status, deposit_status')
    .eq('id', ORDER_ID)
    .single();
  assert.strictEqual(updatedOrderRow!.order_status, 'DEPOSIT_CONFIRMED');
  pass('BOSS_ADMIN deposit mutation updates finance totals using trusted service');

  // 1.5 Contract Generation & AAL2 Signing Flow
  const contract = await generateContractForOrder({
    companyId: COMPANY_ID,
    orderId: ORDER_ID,
  });
  const CONTRACT_ID = contract.contractId;
  assert.ok(CONTRACT_ID, 'Contract must be generated');
  assert.ok(contract.status === 'DRAFT' || contract.status === 'GENERATED', 'Contract status must be DRAFT or GENERATED');

  // Contract view via authorized signed URL
  const signedUrlResult = await getContractDownloadUrl(
    { contractId: CONTRACT_ID, variant: 'generated' },
    bossClientAal1
  );
  assert.ok(signedUrlResult.signedUrl, 'Authorized signed URL must be generated');
  pass('Contract generated and viewable via trusted signed URL');

  // Signing contract without AAL2 must fail
  const validPdfBuffer = Buffer.from('%PDF-1.4 Mock Valid Signed Document Header\n%%EOF');
  let nonAal2SignError: any = null;
  try {
    await signContract(
      {
        companyId: COMPANY_ID,
        contractId: CONTRACT_ID,
        signedPdfBuffer: validPdfBuffer,
      },
      bossClientAal1 // AAL1
    );
  } catch (err: any) {
    nonAal2SignError = err;
  }
  assert.ok(nonAal2SignError, 'Signing contract without AAL2 must fail');
  assert.ok(
    nonAal2SignError.message.includes('MFA') || nonAal2SignError.message.includes('AAL2'),
    'Error must indicate MFA / AAL2 requirement'
  );
  pass('Contract signing unavailable without AAL2');

  // Canonical AAL2 signing succeeds
  const signedContract = await signContract(
    {
      companyId: COMPANY_ID,
      contractId: CONTRACT_ID,
      signedPdfBuffer: validPdfBuffer,
    },
    bossClientAal2 // AAL2
  );
  assert.strictEqual(signedContract.status, 'SIGNED', 'Contract status must be SIGNED');
  const { data: signedContractRow } = await admin
    .from('contracts')
    .select('status, signed_file_ref')
    .eq('id', CONTRACT_ID)
    .single();
  assert.strictEqual(signedContractRow!.status, 'SIGNED');
  assert.ok(signedContractRow!.signed_file_ref, 'Signed file ref must be recorded');
  pass('Canonical AAL2 sign succeeds and sets server-derived signed_file_ref');

  // ============================================================================
  // SECTION 2: OPERATIONS FLOW TESTS (P1-005)
  // ============================================================================
  console.log('\n--- SECTION 2: Operations Flow & Invariants ---');

  // 2.1 Canonical Production Facts Loading
  const facts = await deriveCanonicalProductionFacts(COMPANY_ID, ORDER_ID, admin);
  assert.strictEqual(facts.contractSigned, true, 'Order has signed contract');
  assert.strictEqual(facts.canRelease, true, 'Order has valid canonical facts');
  assert.ok(facts.specs?.dimensions, 'Authoritative dimensions must be derived');
  pass('Server authoritatively derives canonical production facts');

  // 2.2 Client Cannot Choose Specs: Server loads canonical facts and releases to factory
  const prodOrder = await createProductionOrder(
    COMPANY_ID,
    {
      orderId: ORDER_ID,
      deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
      specs: facts.specs!,
      materials: facts.materials!,
    },
    admin,
    boss.id
  );
  assert.ok(prodOrder.id, 'Production order created');
  assert.strictEqual(prodOrder.status, 'RELEASED_TO_FACTORY');
  const PROD_ORDER_ID = prodOrder.id;
  pass('Production order released with server-authoritative specs and materials');

  // 2.3 Production State Transitions & Quality Check
  // RELEASED_TO_FACTORY -> IN_PRODUCTION
  await updateProductionProgress(
    COMPANY_ID,
    {
      productionOrderId: PROD_ORDER_ID,
      status: 'IN_PRODUCTION',
      actorId: boss.id,
    },
    undefined,
    undefined,
    undefined,
    admin
  );

  // IN_PRODUCTION -> QC_IN_PROGRESS
  await updateProductionProgress(
    COMPANY_ID,
    {
      productionOrderId: PROD_ORDER_ID,
      status: 'QC_IN_PROGRESS',
      actorId: boss.id,
    },
    undefined,
    undefined,
    undefined,
    admin
  );

  // QC_IN_PROGRESS -> recordQualityCheck 'PASSED' -> advances production order to READY_FOR_DISPATCH and order to READY_FOR_INSTALL
  await recordQualityCheck(
    COMPANY_ID,
    {
      productionOrderId: PROD_ORDER_ID,
      qcStatus: 'PASSED',
      inspectorId: boss.id,
      notes: 'QC passed 100% watertight seal',
    },
    undefined,
    undefined,
    undefined,
    admin
  );

  const { data: updatedProdOrder } = await admin
    .from('production_orders')
    .select('status, qc_status')
    .eq('id', PROD_ORDER_ID)
    .single();
  assert.strictEqual(updatedProdOrder!.status, 'READY_FOR_DISPATCH');
  assert.strictEqual(updatedProdOrder!.qc_status, 'PASSED');

  const { data: orderAfterQc } = await admin
    .from('orders')
    .select('order_status')
    .eq('id', ORDER_ID)
    .single();
  assert.strictEqual(orderAfterQc!.order_status, 'READY_FOR_INSTALL');
  pass('Production progresses to READY_FOR_DISPATCH with QC PASSED and order advances to READY_FOR_INSTALL');

  // 2.4 Field / Technician Workspace
  // Schedule installation atomically via createInstallationSchedule (product flow)
  const scheduleRes = await createInstallationSchedule(
    COMPANY_ID,
    {
      orderId: ORDER_ID,
      technicianId: tech.id,
      startTime: new Date(Date.now() + 86400000).toISOString(),
      address: '123 Đường Bờ Sông, Q.8, TP.HCM',
      crew: ['Nguyễn Văn Thợ 1', 'Trần Văn Thợ 2'],
    },
    admin,
    boss.id
  );
  const INSTALLATION_ID = scheduleRes.installation.id;
  const APPOINTMENT_ID = scheduleRes.appointment.id;
  assert.strictEqual(scheduleRes.appointment.status, 'ASSIGNED', 'Appointment starts ASSIGNED');
  assert.strictEqual(scheduleRes.installation.status, 'SCHEDULED', 'Installation starts SCHEDULED');

  // Technician workspace shows current assigned job
  // 1. Create survey appointments: current active vs historical
  const surveyActiveId = crypto.randomUUID();
  const surveyHistoricalCompletedId = crypto.randomUUID();
  const surveyHistoricalCancelledId = crypto.randomUUID();
  const surveyOtherTechId = crypto.randomUUID();

  await admin.from('appointments').insert([
    {
      id: surveyActiveId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      type: 'SURVEY',
      start_time: new Date(Date.now() + 3600000).toISOString(),
      assignee_id: tech.id,
      address: '456 Khảo Sát Hiện Trường, Q.1',
      status: 'ASSIGNED',
    },
    {
      id: surveyHistoricalCompletedId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      type: 'SURVEY',
      start_time: new Date(Date.now() - 86400000).toISOString(),
      assignee_id: tech.id,
      address: '789 Khảo Sát Đã Xong, Q.2',
      status: 'COMPLETED',
    },
    {
      id: surveyHistoricalCancelledId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      type: 'SURVEY',
      start_time: new Date(Date.now() - 172800000).toISOString(),
      assignee_id: tech.id,
      address: '101 Khảo Sát Đã Hủy, Q.3',
      status: 'CANCELLED',
    },
    {
      id: surveyOtherTechId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      type: 'SURVEY',
      start_time: new Date(Date.now() + 7200000).toISOString(),
      assignee_id: otherTech.id,
      address: '202 Khảo Sát Của Thợ Khác, Q.4',
      status: 'ASSIGNED',
    },
  ]);

  // Create installation for otherTech to test another technician assignment
  const validCalc2 = await calculateAndSavePriceCalculation(
    {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      measurements: {
        width: 1.5,
        height: 0.6,
        gate_type: 'STAINLESS_STEEL',
        mounting_method: 'SURFACE',
      },
    },
    saleClient
  );
  const orderResult2 = await createOrderFromCalculation(
    {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      priceCalculationId: validCalc2.id,
    },
    saleClient
  );
  const otherOrderId = orderResult2.orderId || (orderResult2 as any).order_id;
  const { error: poErr } = await admin.from('production_orders').insert({
    company_id: COMPANY_ID,
    order_id: otherOrderId,
    status: 'READY_FOR_DISPATCH',
    qc_status: 'PASSED',
    specs: {},
    materials: {},
    deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  if (poErr) throw poErr;
  await admin.from('orders').update({ order_status: 'READY_FOR_INSTALL' }).eq('id', otherOrderId);

  const otherScheduleRes = await createInstallationSchedule(
    COMPANY_ID,
    {
      orderId: otherOrderId,
      technicianId: otherTech.id,
      startTime: new Date(Date.now() + 86400000).toISOString(),
      address: '789 Đường Thợ Khác, Q.7, TP.HCM',
      crew: ['Thợ Khác 1'],
    },
    admin,
    boss.id
  );
  const otherInstallDto = otherScheduleRes.installation;
  const otherApptId = otherScheduleRes.appointment.id;
  assert.strictEqual(otherScheduleRes.appointment.status, 'ASSIGNED');

  const techWorkspace = await getTechnicianFieldWorkspaceData(COMPANY_ID, tech.id, 'TECHNICIAN', admin);
  assert.strictEqual(techWorkspace.installations.length, 1, 'Assigned technician sees current installation');
  assert.strictEqual(techWorkspace.installations[0].id, INSTALLATION_ID);
  assert.strictEqual(techWorkspace.installations[0].appointmentStatus, 'ASSIGNED');
  assert.ok(
    !techWorkspace.installations.some((i) => i.id === otherInstallDto.id),
    'Assigned technician does NOT see other technician installation'
  );

  const surveyIds = techWorkspace.surveys.map((s) => s.id);
  assert.ok(surveyIds.includes(surveyActiveId), 'Technician sees active ASSIGNED survey');
  assert.ok(!surveyIds.includes(surveyHistoricalCompletedId), 'Technician does NOT see COMPLETED survey in current workspace');
  assert.ok(!surveyIds.includes(surveyHistoricalCancelledId), 'Technician does NOT see CANCELLED survey in current workspace');
  assert.ok(!surveyIds.includes(surveyOtherTechId), 'Technician does NOT see another technician survey');

  // Other technician sees their own installation, but NOT tech's installation
  const otherTechWorkspace = await getTechnicianFieldWorkspaceData(COMPANY_ID, otherTech.id, 'TECHNICIAN', admin);
  assert.strictEqual(otherTechWorkspace.installations.length, 1, 'Other technician sees their own installation');
  assert.strictEqual(otherTechWorkspace.installations[0].id, otherInstallDto.id);
  assert.strictEqual(otherTechWorkspace.installations[0].appointmentStatus, 'ASSIGNED');
  assert.ok(
    !otherTechWorkspace.installations.some((i) => i.id === INSTALLATION_ID),
    'Other technician does NOT see first technician installation'
  );
  pass('Technician workspace filters strictly by current assignment (active work only, zero cross-technician leak)');

  // Technician cannot mutate installation before accepting appointment
  let assignedMutateError: any = null;
  try {
    await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'IN_TRANSIT', admin, { userId: tech.id, role: 'TECHNICIAN' });
  } catch (err: any) {
    assignedMutateError = err;
  }
  assert.ok(assignedMutateError, 'Technician cannot mutate installation before accepting appointment');

  // Technician accepts appointment (ASSIGNED -> ACCEPTED)
  const acceptRes = await acceptInstallationAppointment(
    COMPANY_ID,
    APPOINTMENT_ID,
    admin,
    { userId: tech.id, role: 'TECHNICIAN' }
  );
  assert.strictEqual(acceptRes.success, true);
  assert.strictEqual(acceptRes.idempotent, false);

  // Other technician also accepts their appointment
  await acceptInstallationAppointment(
    COMPANY_ID,
    otherApptId,
    admin,
    { userId: otherTech.id, role: 'TECHNICIAN' }
  );

  // Unassigned technician cannot mutate installation
  let unassignedMutateError: any = null;
  try {
    await updateInstallationStatus(
      COMPANY_ID,
      INSTALLATION_ID,
      'IN_TRANSIT',
      admin,
      { userId: otherTech.id, role: 'TECHNICIAN' }
    );
  } catch (err: any) {
    unassignedMutateError = err;
  }
  assert.ok(unassignedMutateError, 'Unassigned technician cannot mutate installation status');
  pass('Unassigned technician mutation rejected (PERMISSION_DENIED)');

  // Technician starts work (ACCEPTED -> IN_PROGRESS)
  const startRes = await startInstallationWork(
    COMPANY_ID,
    INSTALLATION_ID,
    admin,
    { userId: tech.id, role: 'TECHNICIAN' }
  );
  assert.strictEqual(startRes.success, true);
  assert.strictEqual(startRes.idempotent, false);

  // Assigned technician updates progress: SCHEDULED -> IN_TRANSIT -> INSTALLING -> TESTING -> HANDOVER_PENDING
  await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'IN_TRANSIT', admin, { userId: tech.id, role: 'TECHNICIAN' });
  await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'INSTALLING', admin, { userId: tech.id, role: 'TECHNICIAN' });
  await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'TESTING', admin, { userId: tech.id, role: 'TECHNICIAN' });
  await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'HANDOVER_PENDING', admin, { userId: tech.id, role: 'TECHNICIAN' });
  pass('Installation transitions cleanly to HANDOVER_PENDING');

  // 2.5 Handover Evidence & Completion
  // Upload and attach canonical evidence paths (mock storage objects in installation-docs bucket)
  const photoId = crypto.randomUUID();
  const handoverId = crypto.randomUUID();
  const PHOTO_REF = `${COMPANY_ID}/installations/${INSTALLATION_ID}/photo/${photoId}.jpg`;
  const HANDOVER_REF = `${COMPANY_ID}/installations/${INSTALLATION_ID}/handover/${handoverId}.pdf`;

  // Create objects in installation-docs bucket for validation
  await admin.storage.from('installation-docs').upload(PHOTO_REF, Buffer.from('photo-bytes'), { contentType: 'image/jpeg' });
  await admin.storage.from('installation-docs').upload(HANDOVER_REF, Buffer.from('%PDF-1.4 mock handover'), { contentType: 'application/pdf' });

  await attachInstallationEvidence(
    COMPANY_ID,
    { installationId: INSTALLATION_ID, fileKey: PHOTO_REF, type: 'photo' },
    admin,
    { userId: tech.id, role: 'TECHNICIAN' }
  );
  await attachInstallationEvidence(
    COMPANY_ID,
    { installationId: INSTALLATION_ID, fileKey: HANDOVER_REF, type: 'handover' },
    admin,
    { userId: tech.id, role: 'TECHNICIAN' }
  );

  // Complete installation and handover
  await completeInstallationAndHandover(
    COMPANY_ID,
    { installationId: INSTALLATION_ID },
    admin,
    { userId: tech.id, role: 'TECHNICIAN' }
  );

  const { data: completedOrder } = await admin.from('orders').select('order_status').eq('id', ORDER_ID).single();
  assert.strictEqual(completedOrder!.order_status, 'COMPLETED', 'Order status must be COMPLETED after handover');

  const { data: completedInstall } = await admin.from('installations').select('status').eq('id', INSTALLATION_ID).single();
  assert.strictEqual(completedInstall!.status, 'COMPLETED', 'Installation status must be COMPLETED after handover');

  const { data: completedAppt } = await admin.from('appointments').select('status').eq('id', APPOINTMENT_ID).single();
  assert.strictEqual(completedAppt!.status, 'COMPLETED', 'Appointment status must be COMPLETED after handover');

  pass('Handover completion validates verified evidence and transitions Installation, Order, and Appointment to COMPLETED');

  // Verify completed installation is removed from technician active workspace
  const techWorkspaceAfterHandover = await getTechnicianFieldWorkspaceData(COMPANY_ID, tech.id, 'TECHNICIAN', admin);
  assert.strictEqual(
    techWorkspaceAfterHandover.installations.length,
    0,
    'Completed installation must not appear in current technician workspace'
  );
  pass('Historical COMPLETED installation is excluded from technician current workspace');

  // 2.6 Warranty Flow
  const warrantyTicket = await createWarrantyTicket(
    COMPANY_ID,
    {
      customerId: CUSTOMER_ID,
      orderId: ORDER_ID,
      installationId: INSTALLATION_ID,
      issue: 'Khách báo gioăng cao su góc trái hơi rít',
      notes: 'Hẹn xử lý trong tuần',
    },
    admin,
    sale.id
  );
  assert.ok(warrantyTicket.id);
  assert.strictEqual(warrantyTicket.status, 'OPEN');
  const TICKET_ID = warrantyTicket.id;
  pass('Warranty ticket created for COMPLETED order by SALE');

  // Boss assigns technician
  await assignWarrantyTicket(
    COMPANY_ID,
    { ticketId: TICKET_ID, technicianId: tech.id },
    admin,
    { userId: boss.id, role: 'BOSS_ADMIN' }
  );

  // Assigned technician updates status
  await updateWarrantyStatus(
    COMPANY_ID,
    { ticketId: TICKET_ID, status: 'IN_PROGRESS', notes: 'Đang kiểm tra gioăng' },
    admin,
    { userId: tech.id, role: 'TECHNICIAN' }
  );
  await updateWarrantyStatus(
    COMPANY_ID,
    { ticketId: TICKET_ID, status: 'RESOLVED', notes: 'Đã thay thế gioăng mới' },
    admin,
    { userId: tech.id, role: 'TECHNICIAN' }
  );

  const warrantyDashboard = await getWarrantyDashboardData(COMPANY_ID, tech.id, 'TECHNICIAN', admin);
  assert.strictEqual(warrantyDashboard.tickets.length, 1);
  assert.strictEqual(warrantyDashboard.tickets[0].status, 'RESOLVED');
  pass('Warranty lifecycle (create -> assign -> in_progress -> resolved) verified');

  // ============================================================================
  // SECTION 3: REAL AI RUNTIME WIRING TESTS (P1-006)
  // ============================================================================
  console.log('\n--- SECTION 3: Real AI Runtime Wiring & SLA ---');

  // Helper to open overdue Response SLA window bound to conversation
  async function createDueSlaWindow(testSuffix: string) {
    const convoId = crypto.randomUUID();
    const externalConversationId = `page_test_${RUN_ID}:psid_${testSuffix}`;
    await admin.from('conversations').insert({
      id: convoId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      external_conversation_id: externalConversationId,
      status: 'OPEN',
      assigned_to: sale.id, // assigned to Sale
    });

    const triggerIntId = crypto.randomUUID();
    const past10Min = new Date(Date.now() - 10 * 60000).toISOString();
    await admin.from('interactions').insert({
      id: triggerIntId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: convoId,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      sanitized_content: 'Cửa nhà tôi rộng 2m cao 80cm, mùa mưa hay ngập, tư vấn giúp tôi.',
      sanitization_status: 'SUCCEEDED',
      actor_type: 'CUSTOMER',
      created_at: past10Min,
    });

    const win = await openResponseSlaWindow({
      companyId: COMPANY_ID,
      conversationId: convoId,
      triggerInteractionId: triggerIntId,
    });
    return { convoId, triggerIntId, windowId: win.id, externalConversationId };
  }

  // 3.1 Policy Firewall Test: Model attempts to invent commercial commitments
  const win1 = await createDueSlaWindow('firewall');
  class ProhibitedCommitmentModel implements AiResponseModel {
    public readonly modelVersion = 'test-violator-v1';
    async generateResponse() {
      return 'Dạ chào anh, giá trọn gói bên em là 15 triệu đồng, giảm giá 10% nếu anh chuyển khoản vào STK 123456789.';
    }
  }

  // Runtime must reject invented commitments fail-closed
  let firewallViolationCaught = false;
  try {
    const res = await executeAiResponseRuntime({
      companyId: COMPANY_ID,
      windowId: win1.windowId,
      conversationId: win1.convoId,
      customerId: CUSTOMER_ID,
      model: new ProhibitedCommitmentModel(),
      client: admin,
    });
    if (!res.success) {
      assert.fail(`executeAiResponseRuntime did not reach firewall check: ${res.error}`);
    }
  } catch (err: unknown) {
    if (err instanceof PolicyFirewallViolationError) {
      firewallViolationCaught = true;
    } else {
      throw err;
    }
  }
  assert.ok(firewallViolationCaught, 'AI response containing invented price/discount/bank account must be rejected by Policy Firewall');
  pass('Policy firewall rejects invented commercial commitments fail-closed');

  // Verify SLA window is NOT resolved after firewall violation
  const { data: windowAfterViolation } = await bossRealClient
    .from('response_sla_windows')
    .select('state, ai_claim_id')
    .eq('id', win1.windowId)
    .single();
  assert.strictEqual(windowAfterViolation!.state, 'OPEN', 'Window must remain OPEN after generation rejection');
  pass('Rejected generation does not resolve SLA');

  // 3.2 Outbound Provider Confirmation: FAILED provider result does NOT resolve SLA
  const win2 = await createDueSlaWindow('failed_provider');
  class CompliantModel implements AiResponseModel {
    public readonly modelVersion = 'gpt-4o-mini-test';
    async generateResponse() {
      return 'Dạ chào anh, giải pháp cửa chống ngập tự động rất phù hợp với cửa 2m. Kỹ thuật viên bên em có thể qua khảo sát thực tế miễn phí để tư vấn kích thước và lắp ráp chuẩn xác nhất ạ.';
    }
  }

  // Count interactions in conversation before failed send attempt
  const { data: interactionsBeforeFail } = await admin
    .from('interactions')
    .select('id')
    .eq('conversation_id', win2.convoId)
    .eq('actor_type', 'AI');
  const countBeforeFail = interactionsBeforeFail?.length || 0;

  // Provider send fails (e.g. Meta API 500 error)
  const failedSendResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: win2.windowId,
    model: new CompliantModel(),
    providerSender: async () => ({
      status: 'FAILED',
      error: 'Meta Graph API network timeout',
    }),
    client: admin,
  });

  assert.strictEqual(failedSendResult.success, false);
  assert.strictEqual(failedSendResult.providerStatus, 'FAILED');
  assert.ok(failedSendResult.deliveryId, 'Delivery record must be created in outbound_deliveries');

  // Verify outbound_deliveries has status = 'FAILED' and interaction_id IS NULL
  const { data: failedDelivery } = await admin
    .from('outbound_deliveries')
    .select('delivery_status, interaction_id')
    .eq('id', failedSendResult.deliveryId)
    .single();
  assert.strictEqual(failedDelivery?.delivery_status, 'FAILED');
  assert.strictEqual(failedDelivery?.interaction_id, null, 'Failed delivery must NOT link or create an interaction row');

  // Verify ZERO interaction rows created in public.interactions for failed send
  const { data: interactionsAfterFail } = await admin
    .from('interactions')
    .select('id')
    .eq('conversation_id', win2.convoId)
    .eq('actor_type', 'AI');
  const countAfterFail = interactionsAfterFail?.length || 0;
  assert.strictEqual(countAfterFail, countBeforeFail, 'Failed provider send must NOT leave any interaction row in public.interactions');

  const { data: windowAfterFailedSend } = await bossRealClient
    .from('response_sla_windows')
    .select('state')
    .eq('id', win2.windowId)
    .single();
  assert.strictEqual(windowAfterFailedSend!.state, 'OPEN', 'SLA window must NOT resolve on FAILED provider send');
  pass('FAILED provider send does not create public interaction and does not resolve SLA');

  // 3.3 Outbound Provider Confirmation: SENT provider result resolves SLA atomically
  const win3 = await createDueSlaWindow('success_provider');
  const confirmedProviderMsgId = `meta_mid_${RUN_ID}_${Date.now()}`;
  const successfulSendResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: win3.windowId,
    model: new CompliantModel(),
    providerSender: async () => ({
      status: 'SENT',
      externalMessageId: confirmedProviderMsgId,
    }),
    client: admin,
  });

  assert.strictEqual(successfulSendResult.success, true);
  assert.strictEqual(successfulSendResult.externalMessageId, confirmedProviderMsgId);
  assert.ok(successfulSendResult.interactionId);
  assert.ok(successfulSendResult.deliveryId);

  // Verify public.interactions row exists with actor_type = 'AI'
  const { data: createdInteraction } = await admin
    .from('interactions')
    .select('id, actor_type, external_ref, direction')
    .eq('id', successfulSendResult.interactionId)
    .single();
  assert.strictEqual(createdInteraction?.actor_type, 'AI');
  assert.strictEqual(createdInteraction?.direction, 'OUTBOUND');
  assert.strictEqual(createdInteraction?.external_ref, confirmedProviderMsgId);

  // Verify outbound_deliveries has status = 'SENT' and links to interaction_id
  const { data: sentDelivery } = await admin
    .from('outbound_deliveries')
    .select('delivery_status, interaction_id, provider_message_id')
    .eq('id', successfulSendResult.deliveryId)
    .single();
  assert.strictEqual(sentDelivery?.delivery_status, 'SENT');
  assert.strictEqual(sentDelivery?.interaction_id, successfulSendResult.interactionId);
  assert.strictEqual(sentDelivery?.provider_message_id, confirmedProviderMsgId);

  // Verify SLA window is now resolved to AI_RESPONDED
  const { data: windowAfterSent } = await bossRealClient
    .from('response_sla_windows')
    .select('state, ai_response_interaction_id, resolved_at')
    .eq('id', win3.windowId)
    .single();
  assert.strictEqual(windowAfterSent!.state, 'AI_RESPONDED');
  assert.strictEqual(windowAfterSent!.ai_response_interaction_id, successfulSendResult.interactionId);
  pass('Provider confirmed SENT resolves Response SLA window to AI_RESPONDED atomically');

  // Verify conversation status is reset back to OPEN
  const { data: convoAfterSent } = await admin
    .from('conversations')
    .select('status')
    .eq('id', win3.convoId)
    .single();
  assert.strictEqual(convoAfterSent!.status, 'OPEN', 'Conversation status resets from AI_HANDLING to OPEN');
  pass('Conversation status resets to OPEN after SLA resolution');

  // 3.4 Provenance Audit
  const { data: rawRpcData, error: rawSelectErr } = await (admin as any)
    .rpc('get_interaction_raw_content', {
      p_company_id: COMPANY_ID,
      p_interaction_id: successfulSendResult.interactionId,
    });
  if (rawSelectErr) console.error('rawSelectErr:', rawSelectErr);

  assert.ok(rawRpcData && rawRpcData.length > 0, 'Interaction raw content must be persisted in private schema');
  const rawContentRow = rawRpcData[0];
  const metadata = rawContentRow!.source_metadata as Record<string, unknown>;
  assert.strictEqual(metadata.source, 'ai_response_runtime');
  assert.strictEqual(metadata.model_version, 'gpt-4o-mini-test');
  assert.strictEqual(metadata.is_neutral_default, true); // Sale has no activated custom profile yet
  assert.strictEqual(metadata.window_id, win3.windowId);
  pass('AI Response provenance is fully recorded in private audit metadata');

  // 3.5 Real Channel Dispatcher Fail-Closed (Zero Synthetic SENT)
  const winUnconfigured = await createDueSlaWindow('unconfigured_channel');
  // Call executeAiResponseRuntime WITHOUT providerSender: production real dispatcher path
  const unconfiguredResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: winUnconfigured.windowId,
    model: new CompliantModel(),
    client: admin,
  });
  assert.strictEqual(unconfiguredResult.success, false, 'Unconfigured provider must fail closed');
  assert.strictEqual(unconfiguredResult.providerStatus, 'FAILED');
  assert.ok(
    unconfiguredResult.error?.includes('NOT_CONFIGURED'),
    `Error must indicate unconfigured provider, got: ${unconfiguredResult.error}`
  );
  pass('Real channel dispatcher fails closed on unconfigured provider (zero synthetic SENT)');

  // 3.6 Real Production Automation Worker & Callsite
  const winWorker = await createDueSlaWindow('automation_worker');
  const workerSummary = await processDueResponseSlaWindows({
    companyId: COMPANY_ID,
    limit: 10,
    model: new CompliantModel(),
    providerSender: async () => ({
      status: 'SENT',
      externalMessageId: `worker_mid_${RUN_ID}_${Date.now()}`,
    }),
  });
  assert.ok(workerSummary.processed >= 1, 'Worker must process due windows');
  assert.ok(workerSummary.succeeded >= 1, 'Worker must succeed on confirmed delivery');

  const { data: windowAfterWorker } = await bossRealClient
    .from('response_sla_windows')
    .select('state')
    .eq('id', winWorker.windowId)
    .single();
  pass('Production automation worker processes overdue SLA windows end-to-end');

  // ============================================================================
  // SECTION 4: DURABLE AI DISPATCH STATE MACHINE & CONCURRENCY HARDENING (P1-006)
  // ============================================================================
  console.log('\n--- SECTION 4: Durable Outbound State Machine & Concurrency Hardening ---');

  // Test 1: Stable SLA command identity remains identical across CLAIM → RECLAIM
  const t1Win = await createDueSlaWindow('t1_stable_id');
  const t1Claim1 = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t1Win.windowId });
  assert.ok(t1Claim1.claimed && t1Claim1.claimId);
  const stableCmd1 = t1Win.windowId;
  const zaloStableCmd1 = `ai-sla-win-${t1Win.windowId}`;

  // Expire claim lease in DB via direct SQL (Item 8)
  expireClaimDirectSql(t1Win.windowId);

  // Reclaim window
  const t1Claim2 = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t1Win.windowId });
  assert.ok(t1Claim2.claimed && t1Claim2.claimId);
  assert.notStrictEqual(t1Claim1.claimId, t1Claim2.claimId, 'Claim IDs must differ across reclaims');
  const stableCmd2 = t1Win.windowId;
  const zaloStableCmd2 = `ai-sla-win-${t1Win.windowId}`;
  assert.strictEqual(stableCmd1, stableCmd2, 'Stable outbound command identity must be identical across claims');
  assert.strictEqual(zaloStableCmd1, zaloStableCmd2, 'Zalo stable command ID must be identical across claims');
  pass('Stable SLA command identity remains identical across CLAIM -> RECLAIM');

  // Test 2: Provider accepted message, DB finalization crash recovery (Item 9 end-to-end controlled runtime test)
  // Flow: provider mock invoked once -> provider returns SENT -> provider outcome persistence succeeds ->
  // force DB finalization failure -> rerun worker/reclaim -> reconciliation succeeds -> provider invocation count remains exactly 1.
  const t2Win = await createDueSlaWindow('t2_crash_worker');
  let t2InvocationCount = 0;
  const t2Mid = `mid_accepted_${RUN_ID}_${Date.now()}`;

  // Controlled failing client: simulates crash during DB finalization
  const t2FailingClient = {
    ...admin,
    rpc: async (fn: string, args: any) => {
      if (fn === 'finalize_ai_outbound_delivery_atomic') {
        return { data: null, error: { message: 'SIMULATED_DB_FINALIZATION_CRASH' } };
      }
      return (admin.rpc as any)(fn, args);
    },
    from: (table: string) => admin.from(table),
  } as unknown as SupabaseClient;

  // Run 1: provider succeeds, outcome recorded in DB as PROVIDER_SENT_PENDING_FINALIZE, but finalizer fails
  const t2Run1Result = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t2Win.windowId,
    model: new CompliantModel(),
    providerSender: async () => {
      t2InvocationCount++;
      return { status: 'SENT', externalMessageId: t2Mid };
    },
    client: t2FailingClient,
  });
  assert.strictEqual(t2InvocationCount, 1, 'Provider invocation count must be 1 after Run 1');
  assert.strictEqual(t2Run1Result.success, false, 'Run 1 must fail due to simulated finalization crash');

  // Verify delivery is durably in PROVIDER_SENT_PENDING_FINALIZE
  const { data: t2DelRow } = await admin.from('outbound_deliveries')
    .select('delivery_status, provider_message_id')
    .eq('client_command_id', t2Win.windowId)
    .single();
  assert.strictEqual(t2DelRow?.delivery_status, 'PROVIDER_SENT_PENDING_FINALIZE');
  assert.strictEqual(t2DelRow?.provider_message_id, t2Mid);

  // Expire claim lease in DB via direct SQL
  expireClaimDirectSql(t2Win.windowId);

  // Run 2: Reclaim/rerun worker with normal client and SAME providerSender: providerSender MUST NOT be called again
  const t2RetryResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t2Win.windowId,
    model: new CompliantModel(),
    providerSender: async () => {
      t2InvocationCount++;
      return { status: 'SENT', externalMessageId: 'SHOULD_NOT_BE_INVOKED' };
    },
    client: admin,
  });

  assert.strictEqual(t2InvocationCount, 1, 'Provider invocation count must remain exactly 1 after reconciliation');
  assert.strictEqual(t2RetryResult.success, true);
  assert.strictEqual(t2RetryResult.externalMessageId, t2Mid);
  const { data: t2WinRow } = await bossRealClient.from('response_sla_windows').select('state').eq('id', t2Win.windowId).single();
  assert.strictEqual(t2WinRow?.state, 'AI_RESPONDED');
  pass('Provider accepted message, DB finalization crash recovery: provider invocation count remains 1');

  // Test 3: Facebook UNKNOWN result: durable state = UNCERTAIN; after lease/retry worker runs, provider invocation count remains 1
  const t3Win = await createDueSlaWindow('t3_fb_unknown');
  let t3InvocationCount = 0;
  const t3Res1 = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t3Win.windowId,
    model: new CompliantModel(),
    providerSender: async () => {
      t3InvocationCount++;
      return { status: 'UNKNOWN', error: 'Gateway timeout 504' };
    },
    client: admin,
  });
  assert.strictEqual(t3Res1.providerStatus, 'UNCERTAIN');

  const { data: t3DelRow } = await admin.from('outbound_deliveries')
    .select('delivery_status')
    .eq('client_command_id', t3Win.windowId)
    .single();
  assert.strictEqual(t3DelRow?.delivery_status, 'UNCERTAIN', 'Delivery status must be UNCERTAIN, not FAILED');

  // Expire claim lease via direct SQL
  expireClaimDirectSql(t3Win.windowId);

  // Worker runs again: UNCERTAIN must never be automatically resent
  const t3Res2 = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t3Win.windowId,
    model: new CompliantModel(),
    providerSender: async () => {
      t3InvocationCount++;
      return { status: 'SENT', externalMessageId: 'should_not_resend' };
    },
    client: admin,
  });
  assert.strictEqual(t3Res2.success, false);
  assert.strictEqual(t3InvocationCount, 1, 'Provider must never be called again after UNCERTAIN');
  pass('Facebook UNKNOWN result: durable state = UNCERTAIN; provider invocation count remains 1');

  // Test 4: Zalo end-to-end controlled client crash recovery (Item 9 Zalo)
  // Exercise sendSystemZaloReply with a controlled canonical client and force post-provider DB finalization failure
  const t4ConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t4ConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t4TriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t4TriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t4ConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Tư vấn Zalo cửa chống ngập',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const t4Win = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t4ConvoId,
    triggerInteractionId: t4TriggerId,
  });
  const t4OaId = `oa_${RUN_ID}`;
  await admin.from('zalo_oa_configs').insert({
    company_id: COMPANY_ID,
    oa_id: t4OaId,
    app_id: `app_${RUN_ID}`,
    status: 'ACTIVE',
  });

  const t4ZaloMid = `zalo_mid_crash_${RUN_ID}`;
  let t4ZaloClientCalls = 0;

  const controlledZaloClient = {
    sendTextMessageWithOutcome: async () => {
      t4ZaloClientCalls++;
      return { outcome: 'ACCEPTED' as const, providerMsgId: t4ZaloMid };
    },
  };

  const failingZaloAdminClient = {
    ...admin,
    rpc: async (fn: string, args: any) => {
      if (fn === 'zalo_finalize_outbound_delivery') {
        return { data: null, error: { message: 'SIMULATED_ZALO_FINALIZE_FAILURE' } };
      }
      return (admin.rpc as any)(fn, args);
    },
    from: (table: string) => admin.from(table),
  } as unknown as SupabaseClient;

  // Run 1: sendSystemZaloReply with failing finalization
  const zaloServiceFailing = new ZaloInboxService({
    supabase: failingZaloAdminClient,
    clientProvider: async () => controlledZaloClient as any,
  });

  const t4ZaloRes1 = await zaloServiceFailing.sendSystemZaloReply(
    {
      conversationId: t4ConvoId,
      content: 'Tư vấn cửa chống ngập',
      commandId: `ai-sla-win-${t4Win.id}`,
      oaId: t4OaId,
    },
    {
      kind: 'SYSTEM_WORKER',
      companyId: COMPANY_ID,
      actorType: 'AI',
      workerName: 'ai-response-runtime',
    }
  );
  assert.strictEqual(t4ZaloClientCalls, 1, 'Zalo client called once in Run 1');
  assert.strictEqual(t4ZaloRes1.status, 'PENDING_FINALIZE', 'Status must be PENDING_FINALIZE after finalizer failure');

  // Verify delivery is durably in PROVIDER_SENT_PENDING_FINALIZE in DB
  const { data: t4ZaloDelRow } = await admin.from('zalo_outbound_deliveries')
    .select('status, provider_msg_id')
    .eq('id', t4ZaloRes1.deliveryId)
    .single();
  assert.strictEqual(t4ZaloDelRow?.status, 'PROVIDER_SENT_PENDING_FINALIZE');

  // Run 2: executeAiResponseRuntime reconciles Zalo PENDING_FINALIZE delivery without calling provider
  const t4Result = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t4Win.id,
    model: new CompliantModel(),
    client: admin,
    zaloServiceOptions: {
      clientProvider: () => ({
        sendTextMessageWithOutcome: async () => {
          t4ZaloClientCalls++;
          return { outcome: 'ACCEPTED', providerMsgId: 'SHOULD_NOT_BE_CALLED' };
        },
      } as any),
    },
  });

  assert.strictEqual(t4ZaloClientCalls, 1, 'Zalo provider must NOT be called again during reconciliation');
  assert.strictEqual(t4Result.success, true);
  assert.strictEqual(t4Result.externalMessageId, t4ZaloMid);
  const { data: t4WinRow } = await bossRealClient.from('response_sla_windows').select('state').eq('id', t4Win.id).single();
  assert.strictEqual(t4WinRow?.state, 'AI_RESPONDED');
  pass('Zalo PENDING_FINALIZE: controlled canonical client crash recovery: provider invocation count remains 1');

  // Helper to execute real Facebook Sale send path enforcing han_prepare_send -> provider -> han_finish_send contract
  async function executeSaleFacebookSend({
    companyId,
    conversationId,
    actorId,
    content,
    requestId = crypto.randomUUID(),
    providerSender,
  }: {
    companyId: string;
    conversationId: string;
    actorId: string;
    content: string;
    requestId?: string;
    providerSender: () => Promise<{ status: 'SENT' | 'FAILED' | 'UNKNOWN'; mid: string | null }>;
  }) {
    // 1. Pre-provider DB guard & dispatch claim (Linearization check BEFORE external send)
    const { data: prepData, error: prepErr } = await admin.rpc('han_prepare_send' as never, {
      p_company: companyId,
      p_conversation: conversationId,
      p_actor: actorId,
      p_request: requestId,
      p_content: content,
      p_safe: content,
      p_safe_status: 'SUCCEEDED',
      p_delivery: null,
    } as never);

    if (prepErr) {
      return { success: false, error: prepErr.message, claimed: false };
    }

    const prep = prepData as any;
    if (!prep?.claimed) {
      return { success: false, status: prep?.status, error: prep?.status, claimed: false };
    }

    // 2. Pre-provider boundary passed: invoke external provider
    const provRes = await providerSender();

    // 3. Post-provider resolution
    await admin.rpc('han_finish_send' as never, {
      p_company: companyId,
      p_request: requestId,
      p_status: provRes.status,
      p_mid: provRes.mid,
    } as never);

    return {
      success: provRes.status === 'SENT',
      status: provRes.status,
      mid: provRes.mid,
      claimed: true,
    };
  }

  // Scenario A (Facebook): AI obtains response-dispatch ownership -> Sale attempts send -> Sale pre-guard denies (AI_DISPATCH_FENCED)
  // Counts: Sale provider calls = 0, AI provider calls = 1, Total = 1, SLA = AI_RESPONDED
  const tScenAWin = await createDueSlaWindow('scen_a_ai_wins');
  let tScenAAiCalls = 0;
  let tScenASaleCalls = 0;
  let tScenASaleResult: any = null;
  const tScenAMid = `mid_scen_a_${RUN_ID}_${Date.now()}`;

  const tScenAResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: tScenAWin.windowId,
    conversationId: tScenAWin.convoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      tScenAAiCalls++;

      // Real concurrency: Sale attempts to send during AI in-flight provider dispatch
      tScenASaleResult = await executeSaleFacebookSend({
        companyId: COMPANY_ID,
        conversationId: tScenAWin.convoId,
        actorId: sale.id,
        content: 'Sale cố vấn can thiệp',
        providerSender: async () => {
          tScenASaleCalls++;
          return { status: 'SENT', mid: 'mid_sale_should_not_run' };
        },
      });

      return { status: 'SENT', externalMessageId: tScenAMid };
    },
    client: admin,
  });

  assert.strictEqual(tScenAAiCalls, 1, 'AI provider invocation count must be 1');
  assert.strictEqual(tScenASaleCalls, 0, 'Sale provider invocation count MUST be 0 when AI holds dispatch ownership');
  assert.strictEqual(tScenAAiCalls + tScenASaleCalls, 1, 'Total external provider invocations must be exactly 1');
  assert.strictEqual(tScenASaleResult?.claimed, false, 'Sale pre-provider guard must deny claim');
  assert.ok(
    tScenASaleResult?.error?.includes('AI_DISPATCH_FENCED'),
    `Sale guard error must be AI_DISPATCH_FENCED, got: ${tScenASaleResult?.error}`
  );
  assert.strictEqual(tScenAResult.success, true, 'AI dispatch must succeed as winner');

  const { data: tScenAWinRow } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_owner, dispatch_state, ai_response_interaction_id, sale_response_interaction_id')
    .eq('id', tScenAWin.windowId)
    .single();
  assert.strictEqual(tScenAWinRow?.state, 'AI_RESPONDED', 'Window state must resolve to AI_RESPONDED');
  assert.strictEqual(tScenAWinRow?.dispatch_owner, 'AI');
  assert.strictEqual(tScenAWinRow?.dispatch_state, 'PROVIDER_ACCEPTED');
  assert.ok(tScenAWinRow?.ai_response_interaction_id, 'ai_response_interaction_id must be set');
  assert.strictEqual(tScenAWinRow?.sale_response_interaction_id, null, 'sale_response_interaction_id must remain null');
  pass('Scenario A (Facebook): AI owns dispatch -> Sale pre-guard denies (calls: Sale=0, AI=1, Total=1, SLA=AI_RESPONDED)');

  // Scenario B (Facebook): Sale obtains response-dispatch ownership -> Hold Sale provider at barrier -> AI worker attempts dispatch -> AI denied
  // Counts: AI provider calls = 0, Sale provider calls = 1, Total = 1, SLA = SALE_RESPONDED
  const tScenBWin = await createDueSlaWindow('scen_b_sale_wins');
  let tScenBAiCalls = 0;
  let tScenBSaleCalls = 0;
  let tScenBAiResult: any = null;
  const tScenBMid = `mid_sale_scen_b_${RUN_ID}_${Date.now()}`;

  const tScenBSaleResult = await executeSaleFacebookSend({
    companyId: COMPANY_ID,
    conversationId: tScenBWin.convoId,
    actorId: sale.id,
    content: 'Chào anh, Sale hỗ trợ trước!',
    providerSender: async () => {
      tScenBSaleCalls++;

      // Controlled barrier: while Sale provider is in-flight, AI worker attempts dispatch
      tScenBAiResult = await executeAiResponseRuntime({
        companyId: COMPANY_ID,
        windowId: tScenBWin.windowId,
        conversationId: tScenBWin.convoId,
        customerId: CUSTOMER_ID,
        model: new CompliantModel(),
        providerSender: async () => {
          tScenBAiCalls++;
          return { status: 'SENT', externalMessageId: 'mid_ai_should_not_run' };
        },
        client: admin,
      });

      return { status: 'SENT', mid: tScenBMid };
    },
  });

  assert.strictEqual(tScenBSaleCalls, 1, 'Sale provider invocation count must be 1');
  assert.strictEqual(tScenBAiCalls, 0, 'AI provider invocation count MUST be 0 when Sale holds dispatch ownership');
  assert.strictEqual(tScenBAiCalls + tScenBSaleCalls, 1, 'Total external provider invocations must be exactly 1');
  assert.strictEqual(tScenBAiResult?.success, false, 'AI dispatch must be denied');
  assert.ok(
    tScenBAiResult?.error?.includes('SALE_DISPATCHING') || tScenBAiResult?.error?.includes('Sale is currently dispatching'),
    `AI guard error must indicate Sale is dispatching, got: ${tScenBAiResult?.error}`
  );
  assert.strictEqual(tScenBSaleResult.success, true, 'Sale send must succeed');

  const { data: tScenBWinRow } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_owner, dispatch_state, ai_response_interaction_id, sale_response_interaction_id')
    .eq('id', tScenBWin.windowId)
    .single();
  assert.strictEqual(tScenBWinRow?.state, 'SALE_RESPONDED', 'Window state must resolve to SALE_RESPONDED');
  assert.strictEqual(tScenBWinRow?.dispatch_owner, 'SALE');
  assert.strictEqual(tScenBWinRow?.dispatch_state, 'PROVIDER_ACCEPTED');
  assert.ok(tScenBWinRow?.sale_response_interaction_id, 'sale_response_interaction_id must be populated');
  assert.strictEqual(tScenBWinRow?.ai_response_interaction_id, null, 'ai_response_interaction_id must remain null');
  pass('Scenario B (Facebook): Sale owns dispatch -> AI pre-guard denies (calls: AI=0, Sale=1, Total=1, SLA=SALE_RESPONDED)');

  // Scenario C (Facebook): Sale obtains dispatch ownership -> Sale provider returns UNKNOWN -> AI worker runs after lease boundary
  // Result: AI provider calls = 0, state becomes/stays UNCERTAIN, no automatic send
  const tScenCWin = await createDueSlaWindow('scen_c_sale_unknown');
  let tScenCSaleCalls = 0;
  let tScenCAiCalls = 0;

  const tScenCSaleResult = await executeSaleFacebookSend({
    companyId: COMPANY_ID,
    conversationId: tScenCWin.convoId,
    actorId: sale.id,
    content: 'Tin nhắn gặp sự cố mạng',
    providerSender: async () => {
      tScenCSaleCalls++;
      return { status: 'UNKNOWN', mid: null };
    },
  });

  assert.strictEqual(tScenCSaleCalls, 1, 'Sale provider invocation count = 1');
  assert.strictEqual(tScenCSaleResult.status, 'UNKNOWN');

  // Verify window dispatch_state transitioned to UNCERTAIN
  const { data: tScenCWinAfterSale } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state')
    .eq('id', tScenCWin.windowId)
    .single();
  assert.strictEqual(tScenCWinAfterSale?.dispatch_state, 'UNCERTAIN', 'Window dispatch_state must be UNCERTAIN after Sale UNKNOWN');
  assert.strictEqual(tScenCWinAfterSale?.state, 'OPEN', 'Window remains OPEN awaiting manual resolution');

  // Simulate passing lease boundary
  expireDispatchFenceDirectSql(tScenCWin.windowId);

  // AI worker attempts to dispatch after lease expiry
  const tScenCAiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: tScenCWin.windowId,
    conversationId: tScenCWin.convoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      tScenCAiCalls++;
      return { status: 'SENT', externalMessageId: 'should_never_run' };
    },
    client: admin,
  });

  assert.strictEqual(tScenCAiCalls, 0, 'AI provider invocation count MUST remain 0 on UNCERTAIN window');
  assert.strictEqual(tScenCAiResult.success, false, 'AI dispatch must be denied fail-closed');
  assert.ok(
    tScenCAiResult.error?.includes('UNCERTAIN'),
    `AI error must indicate UNCERTAIN state, got: ${tScenCAiResult.error}`
  );

  const { data: tScenCWinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state')
    .eq('id', tScenCWin.windowId)
    .single();
  assert.strictEqual(tScenCWinFinal?.dispatch_state, 'UNCERTAIN', 'Window dispatch_state must stay UNCERTAIN');
  pass('Scenario C (Facebook): Sale returns UNKNOWN -> AI provider calls = 0, state stays UNCERTAIN (Fail-Safe)');

  // Scenario D (Facebook): AI obtains dispatch ownership -> Simulate lease expiry while unresolved -> Sale attempts send -> Sale denied (DISPATCH_UNCERTAIN)
  // Result: Sale provider calls = 0, state stays UNCERTAIN
  const tScenDWin = await createDueSlaWindow('scen_d_ai_lease_expired');
  const tScenDClaim = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: tScenDWin.windowId });

  // AI acquires dispatch authority
  const { data: tScenDGuard } = await admin.rpc('guard_ai_pre_dispatch' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: tScenDWin.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: tScenDWin.windowId,
    p_ai_claim_id: tScenDClaim.claimId,
    p_channel: 'FACEBOOK',
  } as never);
  assert.strictEqual((tScenDGuard as any)?.[0]?.granted, true, 'AI must have acquired dispatch authority');

  // Simulate dispatch lease expiry while unresolved
  expireDispatchFenceDirectSql(tScenDWin.windowId);

  let tScenDSaleCalls = 0;
  const tScenDSaleResult = await executeSaleFacebookSend({
    companyId: COMPANY_ID,
    conversationId: tScenDWin.convoId,
    actorId: sale.id,
    content: 'Sale can thiệp khi hết hạn',
    providerSender: async () => {
      tScenDSaleCalls++;
      return { status: 'SENT', mid: 'should_not_run' };
    },
  });

  assert.strictEqual(tScenDSaleCalls, 0, 'Sale provider invocation count MUST be 0 when AI dispatch expired mid-flight');
  assert.strictEqual(tScenDSaleResult.claimed, false, 'Sale pre-provider guard must deny send');
  assert.ok(
    tScenDSaleResult.error?.includes('DISPATCH_UNCERTAIN'),
    `Sale guard error must be DISPATCH_UNCERTAIN, got: ${tScenDSaleResult.error}`
  );

  const { data: tScenDWinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state')
    .eq('id', tScenDWin.windowId)
    .single();
  assert.strictEqual(tScenDWinFinal?.dispatch_state, 'UNCERTAIN', 'Window dispatch_state must become UNCERTAIN');
  pass('Scenario D (Facebook): AI in-flight lease expired -> Sale pre-guard denies with DISPATCH_UNCERTAIN (calls: Sale=0, state=UNCERTAIN)');

  // Facebook Scenario E: Sale R1 acquires dispatch ownership and provider is held at a barrier.
  // Sale R2 uses a DIFFERENT request ID and attempts send.
  // Required: R1 provider calls = 1, R2 provider calls = 0, R2 status = SALE_ALREADY_DISPATCHING, Total external calls = 1.
  // Then R1 SENT: SLA = SALE_RESPONDED.
  const tScenEWin = await createDueSlaWindow('scen_e_sale_concurrent');
  let tScenER1Calls = 0;
  let tScenER2Calls = 0;
  let tScenER2Result: any = null;
  const tScenER1Req = crypto.randomUUID();
  const tScenER2Req = crypto.randomUUID();
  const tScenEMid = `mid_sale_scen_e_${RUN_ID}_${Date.now()}`;

  const tScenER1Result = await executeSaleFacebookSend({
    companyId: COMPANY_ID,
    conversationId: tScenEWin.convoId,
    actorId: sale.id,
    content: 'Tin nhắn R1 của Sale',
    requestId: tScenER1Req,
    providerSender: async () => {
      tScenER1Calls++;

      // Barrier: While R1 is held in-flight, R2 with different request ID attempts send
      tScenER2Result = await executeSaleFacebookSend({
        companyId: COMPANY_ID,
        conversationId: tScenEWin.convoId,
        actorId: sale.id,
        content: 'Tin nhắn R2 của Sale (cạnh tranh)',
        requestId: tScenER2Req,
        providerSender: async () => {
          tScenER2Calls++;
          return { status: 'SENT', mid: 'mid_r2_should_not_run' };
        },
      });

      return { status: 'SENT', mid: tScenEMid };
    },
  });

  assert.strictEqual(tScenER1Calls, 1, 'Sale R1 provider invocation count must be 1');
  assert.strictEqual(tScenER2Calls, 0, 'Sale R2 provider invocation count MUST be 0 when R1 is in-flight');
  assert.strictEqual(tScenER1Calls + tScenER2Calls, 1, 'Total external provider calls must be exactly 1');
  assert.strictEqual(tScenER2Result?.claimed, false, 'Sale R2 pre-provider guard must deny send');
  assert.strictEqual(tScenER2Result?.status, 'SALE_ALREADY_DISPATCHING', 'Sale R2 status must be SALE_ALREADY_DISPATCHING');
  assert.strictEqual(tScenER1Result.success, true, 'Sale R1 send must succeed');

  const { data: tScenEWinRow } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_owner, dispatch_state, sale_response_interaction_id')
    .eq('id', tScenEWin.windowId)
    .single();
  assert.strictEqual(tScenEWinRow?.state, 'SALE_RESPONDED', 'Window state must resolve to SALE_RESPONDED');
  assert.strictEqual(tScenEWinRow?.dispatch_owner, 'SALE');
  assert.strictEqual(tScenEWinRow?.dispatch_state, 'PROVIDER_ACCEPTED');
  pass('Scenario E (Facebook): R1 in-flight -> R2 denied SALE_ALREADY_DISPATCHING (calls: R1=1, R2=0, Total=1, SLA=SALE_RESPONDED)');

  // Facebook Scenario F: R1 is still provider-in-flight.
  // R2 must NOT be allowed to obtain ownership or release R1's fence.
  // Prove AI provider invocation remains 0 while R1 is unresolved.
  const tScenFWin = await createDueSlaWindow('scen_f_r1_fence_integrity');
  let tScenFR1Calls = 0;
  let tScenFAiCalls = 0;
  let tScenFAiResult: any = null;
  const tScenFR1Req = crypto.randomUUID();
  const tScenFR2Req = crypto.randomUUID();

  // R1 prepares and acquires dispatch fence
  const { data: tScenFR1Prep } = await admin.rpc('han_prepare_send' as never, {
    p_company: COMPANY_ID,
    p_conversation: tScenFWin.convoId,
    p_actor: sale.id,
    p_request: tScenFR1Req,
    p_content: 'R1 in flight',
    p_safe: 'R1 in flight',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  } as never);
  assert.strictEqual((tScenFR1Prep as any)?.claimed, true, 'R1 must claim outbox and acquire fence');
  tScenFR1Calls++;

  // R2 attempts send -> denied
  const { data: tScenFR2Prep } = await admin.rpc('han_prepare_send' as never, {
    p_company: COMPANY_ID,
    p_conversation: tScenFWin.convoId,
    p_actor: sale.id,
    p_request: tScenFR2Req,
    p_content: 'R2 concurrently',
    p_safe: 'R2 concurrently',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  } as never);
  assert.strictEqual((tScenFR2Prep as any)?.claimed, false, 'R2 must be denied');
  assert.strictEqual((tScenFR2Prep as any)?.status, 'SALE_ALREADY_DISPATCHING');

  // Attempt to call han_finish_send with R2 and FAILED -> must NOT release R1's fence
  try {
    await admin.rpc('han_finish_send' as never, {
      p_company: COMPANY_ID,
      p_request: tScenFR2Req,
      p_status: 'FAILED',
      p_mid: null,
    } as never);
  } catch {}

  // AI attempts dispatch while R1 is still in-flight
  tScenFAiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: tScenFWin.windowId,
    conversationId: tScenFWin.convoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      tScenFAiCalls++;
      return { status: 'SENT', externalMessageId: 'ai_should_not_run' };
    },
    client: admin,
  });

  assert.strictEqual(tScenFAiCalls, 0, 'AI provider invocation count MUST remain 0 while R1 is unresolved');
  assert.strictEqual(tScenFAiResult.success, false, 'AI dispatch must be denied while R1 is in-flight');

  // Finish R1 as SENT
  await admin.rpc('han_finish_send' as never, {
    p_company: COMPANY_ID,
    p_request: tScenFR1Req,
    p_status: 'SENT',
    p_mid: `mid_r1_f_${RUN_ID}`,
  } as never);
  pass('Scenario F (Facebook): R1 fence integrity preserved against R2; AI calls = 0 while R1 in-flight');

  // Facebook Late Authoritative Result after UNCERTAIN:
  // Sale dispatch acquired (R1) -> lease expires -> shared state becomes UNCERTAIN
  // -> no competing AI/Sale network send occurs (R2 denied, AI denied)
  // -> original provider later returns authoritative SENT for R1
  // -> SLA resolves to SALE_RESPONDED. Total external provider calls = 1.
  const tFbLateWin = await createDueSlaWindow('scen_fb_late_authoritative');
  let tFbLateR1Calls = 0;
  let tFbLateR2Calls = 0;
  let tFbLateAiCalls = 0;
  const tFbLateR1Req = crypto.randomUUID();
  const tFbLateR2Req = crypto.randomUUID();

  // 1. R1 prepares and acquires dispatch fence
  await admin.rpc('han_prepare_send' as never, {
    p_company: COMPANY_ID,
    p_conversation: tFbLateWin.convoId,
    p_actor: sale.id,
    p_request: tFbLateR1Req,
    p_content: 'R1 ban dau',
    p_safe: 'R1 ban dau',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  } as never);
  tFbLateR1Calls++;

  // 2. Simulate dispatch lease expiry while unresolved
  expireDispatchFenceDirectSql(tFbLateWin.windowId);

  // 3. Competing Sale R2 attempts send -> pre-guard transitions & denies with DISPATCH_UNCERTAIN
  const tFbLateR2Result = await executeSaleFacebookSend({
    companyId: COMPANY_ID,
    conversationId: tFbLateWin.convoId,
    actorId: sale.id,
    content: 'R2 co gui sau khi timeout',
    requestId: tFbLateR2Req,
    providerSender: async () => {
      tFbLateR2Calls++;
      return { status: 'SENT', mid: 'r2_should_not_run' };
    },
  });
  assert.strictEqual(tFbLateR2Calls, 0, 'Competing Sale R2 provider calls must be 0');
  assert.strictEqual(tFbLateR2Result.claimed, false, 'Sale R2 pre-guard must deny send');
  assert.strictEqual(tFbLateR2Result.status, 'DISPATCH_UNCERTAIN');

  // 4. Competing AI worker attempts send -> denied fail-closed
  const tFbLateAiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: tFbLateWin.windowId,
    conversationId: tFbLateWin.convoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      tFbLateAiCalls++;
      return { status: 'SENT', externalMessageId: 'ai_should_not_run' };
    },
    client: admin,
  });
  assert.strictEqual(tFbLateAiCalls, 0, 'Competing AI provider calls must be 0');
  assert.strictEqual(tFbLateAiResult.success, false, 'AI send must be denied on UNCERTAIN window');

  // 5. Original provider later returns authoritative SENT for the SAME delivery R1
  await admin.rpc('han_finish_send' as never, {
    p_company: COMPANY_ID,
    p_request: tFbLateR1Req,
    p_status: 'SENT',
    p_mid: `mid_r1_authoritative_${RUN_ID}`,
  } as never);

  const { data: tFbLateWinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state, dispatch_owner')
    .eq('id', tFbLateWin.windowId)
    .single();
  assert.strictEqual(tFbLateWinFinal?.state, 'SALE_RESPONDED', 'Window must reconcile to SALE_RESPONDED');
  assert.strictEqual(tFbLateWinFinal?.dispatch_state, 'PROVIDER_ACCEPTED');
  assert.strictEqual(tFbLateR1Calls + tFbLateR2Calls + tFbLateAiCalls, 1, 'Total external calls must be strictly 1');
  pass('Late authoritative SENT (Facebook): Reconciles original Sale response, 0 competing external sends (Total calls = 1)');

  // Zalo Scenario A: AI acquires dispatch fence -> Sale attempts sendZaloReply -> Sale denied (BUSY / AI_DISPATCH_FENCED)
  // Counts: Sale provider calls = 0, AI provider calls = 1, Total = 1, SLA = AI_RESPONDED
  const tZaloAConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: tZaloAConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_za_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const tZaloATriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: tZaloATriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: tZaloAConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo tư vấn cửa chống ngập',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const tZaloAWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: tZaloAConvoId,
    triggerInteractionId: tZaloATriggerId,
  });

  const saleActorContext: any = {
    userId: sale.id,
    email: sale.email,
    fullName: 'User SALE',
    profileStatus: 'ACTIVE',
    companyId: COMPANY_ID,
    memberId: `${sale.id}-m`,
    role: 'SALE',
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
    isTrustedServerVerified: true,
  };

  let tZaloAAiCalls = 0;
  let tZaloASaleCalls = 0;
  let tZaloASaleResult: any = null;

  const zaloInboxServiceA = new ZaloInboxService({
    supabase: admin,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        tZaloASaleCalls++;
        return { outcome: 'ACCEPTED', providerMsgId: 'msg_sale_zalo_a' };
      },
    } as any),
  });

  const tZaloAResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: tZaloAWin.id,
    conversationId: tZaloAConvoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    zaloServiceOptions: {
      clientProvider: async () => ({
        sendTextMessageWithOutcome: async () => {
          tZaloAAiCalls++;

          // Real concurrency: Sale attempts sendZaloReply while AI provider call is in-flight
          tZaloASaleResult = await zaloInboxServiceA.sendZaloReply(
            {
              conversationId: tZaloAConvoId,
              content: 'Sale can thiệp trên Zalo',
              commandId: `sale-zalo-a-${RUN_ID}`,
              oaId: t4OaId,
            },
            saleActorContext
          );

          return { outcome: 'ACCEPTED', providerMsgId: `zalo_mid_a_${RUN_ID}` };
        },
      } as any),
    },
    client: admin,
  });

  assert.strictEqual(tZaloAAiCalls, 1, 'Zalo AI provider invocation count must be 1');
  assert.strictEqual(tZaloASaleCalls, 0, 'Zalo Sale provider invocation count MUST be 0 when AI holds dispatch fence');
  assert.strictEqual(tZaloAAiCalls + tZaloASaleCalls, 1, 'Total external Zalo provider invocations must be exactly 1');
  assert.strictEqual(tZaloASaleResult?.success, false, 'Sale sendZaloReply must be rejected');
  assert.strictEqual(tZaloASaleResult?.status, 'BUSY', 'Sale sendZaloReply status must be BUSY (AI_DISPATCH_FENCED)');
  assert.strictEqual(tZaloAResult.success, true, 'AI Zalo dispatch must succeed');

  const { data: tZaloAWinRow } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_owner, dispatch_state')
    .eq('id', tZaloAWin.id)
    .single();
  assert.strictEqual(tZaloAWinRow?.state, 'AI_RESPONDED', 'Window state must resolve to AI_RESPONDED');
  pass('Scenario A (Zalo): AI owns dispatch -> Sale sendZaloReply denied (calls: Sale=0, AI=1, Total=1, SLA=AI_RESPONDED)');

  // Zalo Scenario B: Sale obtains dispatch ownership -> AI worker attempts dispatch -> AI denied (SALE_DISPATCHING)
  // Counts: AI provider calls = 0, Sale provider calls = 1, Total = 1, SLA = SALE_RESPONDED
  const tZaloBConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: tZaloBConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_zb_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const tZaloBTriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: tZaloBTriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: tZaloBConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo tư vấn lắp đặt',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const tZaloBWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: tZaloBConvoId,
    triggerInteractionId: tZaloBTriggerId,
  });

  let tZaloBAiCalls = 0;
  let tZaloBSaleCalls = 0;
  let tZaloBAiResult: any = null;

  const zaloInboxServiceB = new ZaloInboxService({
    supabase: admin,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        tZaloBSaleCalls++;

        // Controlled barrier: while Sale provider is in-flight, AI attempts dispatch
        tZaloBAiResult = await executeAiResponseRuntime({
          companyId: COMPANY_ID,
          windowId: tZaloBWin.id,
          conversationId: tZaloBConvoId,
          customerId: CUSTOMER_ID,
          model: new CompliantModel(),
          providerSender: async () => {
            tZaloBAiCalls++;
            return { status: 'SENT', externalMessageId: 'should_not_run' };
          },
          client: admin,
        });

        return { outcome: 'ACCEPTED', providerMsgId: `msg_sale_zalo_b_${RUN_ID}` };
      },
    } as any),
  });

  const tZaloBSaleResult = await zaloInboxServiceB.sendZaloReply(
    {
      conversationId: tZaloBConvoId,
      content: 'Chào anh trên Zalo, Sale phản hồi!',
      commandId: `sale-zalo-b-${RUN_ID}`,
      oaId: t4OaId,
    },
    saleActorContext
  );

  assert.strictEqual(tZaloBSaleCalls, 1, 'Zalo Sale provider invocation count must be 1');
  assert.strictEqual(tZaloBAiCalls, 0, 'Zalo AI provider invocation count MUST be 0 when Sale holds dispatch fence');
  assert.strictEqual(tZaloBAiCalls + tZaloBSaleCalls, 1, 'Total external Zalo provider invocations must be exactly 1');
  assert.strictEqual(tZaloBAiResult?.success, false, 'AI dispatch must be denied');
  assert.ok(
    tZaloBAiResult?.error?.includes('SALE_DISPATCHING') || tZaloBAiResult?.error?.includes('Sale is currently dispatching'),
    `AI error must indicate Sale dispatching, got: ${tZaloBAiResult?.error}`
  );
  assert.strictEqual(tZaloBSaleResult.success, true, 'Sale sendZaloReply must succeed');

  const { data: tZaloBWinRow } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_owner, dispatch_state')
    .eq('id', tZaloBWin.id)
    .single();
  assert.strictEqual(tZaloBWinRow?.state, 'SALE_RESPONDED', 'Window state must resolve to SALE_RESPONDED');
  pass('Scenario B (Zalo): Sale owns dispatch -> AI pre-guard denies (calls: AI=0, Sale=1, Total=1, SLA=SALE_RESPONDED)');

  // Zalo Scenario C: Sale provider returns UNCERTAIN -> AI worker runs -> AI denied (calls: AI=0, state=UNCERTAIN)
  const tZaloCConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: tZaloCConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_zc_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const tZaloCTriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: tZaloCTriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: tZaloCConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo kiểm tra lỗi mạng',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const tZaloCWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: tZaloCConvoId,
    triggerInteractionId: tZaloCTriggerId,
  });

  let tZaloCSaleCalls = 0;
  let tZaloCAiCalls = 0;

  const zaloInboxServiceC = new ZaloInboxService({
    supabase: admin,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        tZaloCSaleCalls++;
        return { outcome: 'UNCERTAIN', errorCode: 'TIMEOUT', errorMessage: 'Network timeout' };
      },
    } as any),
  });

  const tZaloCSaleResult = await zaloInboxServiceC.sendZaloReply(
    {
      conversationId: tZaloCConvoId,
      content: 'Tin nhắn Zalo lỗi mạng',
      commandId: `sale-zalo-c-${RUN_ID}`,
      oaId: t4OaId,
    },
    saleActorContext
  );

  assert.strictEqual(tZaloCSaleCalls, 1, 'Sale provider invocation count = 1');
  assert.strictEqual(tZaloCSaleResult.status, 'UNCERTAIN');

  // AI attempts dispatch
  const tZaloCAiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: tZaloCWin.id,
    conversationId: tZaloCConvoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      tZaloCAiCalls++;
      return { status: 'SENT', externalMessageId: 'should_not_run' };
    },
    client: admin,
  });

  assert.strictEqual(tZaloCAiCalls, 0, 'AI provider invocation count MUST remain 0 on UNCERTAIN window');
  assert.strictEqual(tZaloCAiResult.success, false, 'AI dispatch must be denied fail-closed');

  const { data: tZaloCWinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state')
    .eq('id', tZaloCWin.id)
    .single();
  assert.strictEqual(tZaloCWinFinal?.dispatch_state, 'UNCERTAIN', 'Window dispatch_state must stay UNCERTAIN');
  pass('Scenario C (Zalo): Sale returns UNCERTAIN -> AI provider calls = 0, state stays UNCERTAIN (Fail-Safe)');

  // Zalo Scenario D: Sale command C1 provider held in-flight.
  // Sale command C2 is different.
  // Required: C1 provider calls = 1, C2 provider calls = 0, C2 status = BUSY (SALE_ALREADY_DISPATCHING), Total Zalo external calls = 1.
  // Then C1 ACCEPTED: SLA = SALE_RESPONDED.
  const tZaloDConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: tZaloDConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_zd_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const tZaloDTriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: tZaloDTriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: tZaloDConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo can thiep dong thoi',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const tZaloDWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: tZaloDConvoId,
    triggerInteractionId: tZaloDTriggerId,
  });

  let tZaloDC1Calls = 0;
  let tZaloDC2Calls = 0;
  let tZaloDC2Result: any = null;

  const zaloInboxServiceD2 = new ZaloInboxService({
    supabase: admin,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        tZaloDC2Calls++;
        return { outcome: 'ACCEPTED', providerMsgId: `msg_sale_zalo_d2_${RUN_ID}` };
      },
    } as any),
  });

  const zaloInboxServiceD = new ZaloInboxService({
    supabase: admin,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        tZaloDC1Calls++;

        // Barrier: While C1 is in-flight, C2 attempts sendZaloReply with different commandId
        tZaloDC2Result = await zaloInboxServiceD2.sendZaloReply(
          {
            conversationId: tZaloDConvoId,
            content: 'Sale C2 gui cung luc',
            commandId: `sale-zalo-d-c2-${RUN_ID}`,
            oaId: t4OaId,
          },
          saleActorContext
        );

        return { outcome: 'ACCEPTED', providerMsgId: `msg_sale_zalo_d_${RUN_ID}` };
      },
    } as any),
  });

  const tZaloDC1Result = await zaloInboxServiceD.sendZaloReply(
    {
      conversationId: tZaloDConvoId,
      content: 'Sale C1 dang gui',
      commandId: `sale-zalo-d-c1-${RUN_ID}`,
      oaId: t4OaId,
    },
    saleActorContext
  );

  assert.strictEqual(tZaloDC1Calls, 1, 'Sale C1 provider invocation count must be 1');
  assert.strictEqual(tZaloDC2Calls, 0, 'Sale C2 provider invocation count MUST be 0 when C1 is in-flight');
  assert.strictEqual(tZaloDC1Calls + tZaloDC2Calls, 1, 'Total external Zalo provider calls must be exactly 1');
  assert.strictEqual(tZaloDC2Result?.success, false, 'Sale C2 must be denied');
  assert.strictEqual(tZaloDC2Result?.status, 'BUSY', 'Sale C2 status must be BUSY (SALE_ALREADY_DISPATCHING)');
  assert.strictEqual(tZaloDC1Result.success, true, 'Sale C1 send must succeed');

  const { data: tZaloDWinRow } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_owner, dispatch_state')
    .eq('id', tZaloDWin.id)
    .single();
  assert.strictEqual(tZaloDWinRow?.state, 'SALE_RESPONDED', 'Window state must resolve to SALE_RESPONDED');
  pass('Scenario D (Zalo): C1 in-flight -> C2 denied SALE_ALREADY_DISPATCHING (calls: C1=1, C2=0, Total=1, SLA=SALE_RESPONDED)');

  // Zalo Scenario E: Stale or unrelated delivery cannot mutate/release shared SLA dispatch owner.
  // An outcome (REJECTED/UNCERTAIN) belonging to an old delivery cannot release C1's active fence.
  const tZaloEConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: tZaloEConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_ze_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const tZaloETriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: tZaloETriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: tZaloEConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo kiem tra stale delivery',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const tZaloEWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: tZaloEConvoId,
    triggerInteractionId: tZaloETriggerId,
  });

  // Scenario E (Zalo): Stale delivery outcome cannot release or mutate current delivery active fence
  const tZaloEC1Cmd = `active-del-c1-${RUN_ID}`;
  const { data: tZaloEC1Claim } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: tZaloEConvoId,
    p_command_id: tZaloEC1Cmd,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'Active delivery C1',
    p_sanitized_content: 'Active delivery C1',
    p_content_sha256: crypto.createHash('sha256').update('Active delivery C1').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  const c1DelId = (tZaloEC1Claim as any)?.[0]?.delivery_id;
  const c1ClaimToken = (tZaloEC1Claim as any)?.[0]?.claim_token;
  assert.ok(c1DelId, 'C1 delivery ID must exist');

  // Verify C1 currently holds the window
  const { data: tZaloEWinActive } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_delivery_id, dispatch_owner, dispatch_state')
    .eq('id', tZaloEWin.id)
    .single();
  assert.strictEqual(tZaloEWinActive?.dispatch_delivery_id, c1DelId, 'C1 must be the dispatch_delivery_id');
  assert.strictEqual(tZaloEWinActive?.dispatch_owner, 'SALE');
  assert.strictEqual(tZaloEWinActive?.dispatch_state, 'DISPATCHING');

  // Now create a stale delivery row directly in zalo_outbound_deliveries on the same conversation
  const staleDelId = crypto.randomUUID();
  const staleClaimToken = crypto.randomUUID();
  await admin.from('zalo_outbound_deliveries').insert({
    id: staleDelId,
    company_id: COMPANY_ID,
    conversation_id: tZaloEConvoId,
    customer_id: CUSTOMER_ID,
    recipient_zalo_uid: `zalo_user_ze_${RUN_ID}`,
    idempotency_key: `zalo_out:${COMPANY_ID}:stale-cmd-${RUN_ID}`,
    content: 'Stale delivery',
    status: 'SENDING',
    attempts: 1,
    command_id: `stale-cmd-${RUN_ID}`,
    channel: 'ZALO',
    lease_until: new Date(Date.now() + 120000).toISOString(),
    oa_id: t4OaId,
    actor_type: 'SALE',
    actor_user_id: sale.id,
    claim_token: staleClaimToken,
    content_sha256: crypto.createHash('sha256').update('Stale delivery').digest('hex'),
  });

  // Stale delivery attempts to record REJECTED:
  await admin.rpc('zalo_record_outbound_provider_result' as never, {
    p_delivery_id: staleDelId,
    p_claim_token: staleClaimToken,
    p_outcome: 'REJECTED',
    p_provider_msg_id: null,
    p_error_code: 'OLD_ERROR',
    p_error_message: 'Old error message',
  } as never);

  // Verify C1's active fence was NOT released!
  const { data: tZaloEWinAfterStale } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_delivery_id, dispatch_owner, dispatch_state')
    .eq('id', tZaloEWin.id)
    .single();
  assert.strictEqual(tZaloEWinAfterStale?.dispatch_delivery_id, c1DelId, 'C1 delivery ID must remain bound');
  assert.strictEqual(tZaloEWinAfterStale?.dispatch_owner, 'SALE', 'SALE ownership must NOT be released by stale delivery');
  assert.strictEqual(tZaloEWinAfterStale?.dispatch_state, 'DISPATCHING', 'State must remain DISPATCHING');

  // Verify AI cannot dispatch while C1 is in-flight
  let tZaloEAiCalls = 0;
  const tZaloEAiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: tZaloEWin.id,
    conversationId: tZaloEConvoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      tZaloEAiCalls++;
      return { status: 'SENT', externalMessageId: 'ai_should_not_run' };
    },
    client: admin,
  });
  assert.strictEqual(tZaloEAiCalls, 0, 'AI provider invocation count MUST remain 0 while C1 is in-flight');
  assert.strictEqual(tZaloEAiResult.success, false, 'AI dispatch must be denied while C1 is in-flight');

  // Finish C1 as ACCEPTED and finalize
  await admin.rpc('zalo_record_outbound_provider_result' as never, {
    p_delivery_id: c1DelId,
    p_claim_token: c1ClaimToken,
    p_outcome: 'ACCEPTED',
    p_provider_msg_id: `zalo_c1_mid_${RUN_ID}`,
  } as never);
  await admin.rpc('zalo_finalize_outbound_delivery' as never, {
    p_delivery_id: c1DelId,
  } as never);

  const { data: tZaloEWinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state, dispatch_owner')
    .eq('id', tZaloEWin.id)
    .single();
  assert.strictEqual(tZaloEWinFinal?.state, 'SALE_RESPONDED', 'Window must reconcile to SALE_RESPONDED');
  pass('Scenario E (Zalo): Stale delivery outcome cannot release or mutate current delivery active fence');

  // Zalo Late Authoritative Result after UNCERTAIN:
  // Sale dispatch acquired (C1) -> lease expires -> shared state becomes UNCERTAIN
  // -> no competing AI/Sale network send occurs (C2 denied, AI denied)
  // -> original provider later returns authoritative ACCEPTED for C1
  // -> SLA resolves to SALE_RESPONDED. Total external provider calls = 1.
  const tZaloLateConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: tZaloLateConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_zlate_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const tZaloLateTriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: tZaloLateTriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: tZaloLateConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo kiem tra late authoritative',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const tZaloLateWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: tZaloLateConvoId,
    triggerInteractionId: tZaloLateTriggerId,
  });

  let tZaloLateC1Calls = 0;
  let tZaloLateC2Calls = 0;
  let tZaloLateAiCalls = 0;
  const tZaloLateC1Cmd = `zalo-late-c1-${RUN_ID}`;
  const tZaloLateC2Cmd = `zalo-late-c2-${RUN_ID}`;

  // 1. C1 acquires dispatch fence
  const { data: tZaloLateC1Claim } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: tZaloLateConvoId,
    p_command_id: tZaloLateC1Cmd,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'Zalo C1 late send',
    p_sanitized_content: 'Zalo C1 late send',
    p_content_sha256: crypto.createHash('sha256').update('Zalo C1 late send').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  const lateC1DelId = (tZaloLateC1Claim as any)?.[0]?.delivery_id;
  const lateC1Token = (tZaloLateC1Claim as any)?.[0]?.claim_token;
  tZaloLateC1Calls++;

  // 2. Simulate dispatch lease expiry while unresolved
  expireDispatchFenceDirectSql(tZaloLateWin.id);

  // 3. Competing Sale C2 attempts send -> pre-guard transitions & denies with DISPATCH_UNCERTAIN
  const zaloInboxServiceLate = new ZaloInboxService({
    supabase: admin,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        tZaloLateC2Calls++;
        return { outcome: 'ACCEPTED', providerMsgId: 'c2_should_not_run' };
      },
    } as any),
  });
  const tZaloLateC2Result = await zaloInboxServiceLate.sendZaloReply(
    {
      conversationId: tZaloLateConvoId,
      content: 'C2 co gui khi UNCERTAIN',
      commandId: tZaloLateC2Cmd,
      oaId: t4OaId,
    },
    saleActorContext
  );
  assert.strictEqual(tZaloLateC2Calls, 0, 'Competing Sale C2 provider calls must be 0');
  assert.strictEqual(tZaloLateC2Result.success, false, 'Sale C2 must be denied');
  assert.strictEqual(tZaloLateC2Result.status, 'UNCERTAIN');

  // 4. Competing AI worker attempts dispatch -> denied fail-closed
  const tZaloLateAiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: tZaloLateWin.id,
    conversationId: tZaloLateConvoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      tZaloLateAiCalls++;
      return { status: 'SENT', externalMessageId: 'ai_should_not_run' };
    },
    client: admin,
  });
  assert.strictEqual(tZaloLateAiCalls, 0, 'Competing AI provider calls must be 0');
  assert.strictEqual(tZaloLateAiResult.success, false, 'AI send must be denied on UNCERTAIN window');

  // 5. Original provider later returns authoritative outcome for C1
  await admin.rpc('zalo_record_outbound_provider_result' as never, {
    p_delivery_id: lateC1DelId,
    p_claim_token: lateC1Token,
    p_outcome: 'ACCEPTED',
    p_provider_msg_id: `zalo_late_mid_${RUN_ID}`,
  } as never);
  await admin.rpc('zalo_finalize_outbound_delivery' as never, {
    p_delivery_id: lateC1DelId,
  } as never);

  const { data: tZaloLateWinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state, dispatch_owner')
    .eq('id', tZaloLateWin.id)
    .single();
  assert.strictEqual(tZaloLateWinFinal?.state, 'SALE_RESPONDED', 'Window must reconcile to SALE_RESPONDED');
  assert.strictEqual(tZaloLateWinFinal?.dispatch_state, 'PROVIDER_ACCEPTED');
  assert.strictEqual(tZaloLateC1Calls + tZaloLateC2Calls + tZaloLateAiCalls, 1, 'Total external calls must be strictly 1');
  pass('Late authoritative ACCEPTED (Zalo): Reconciles original Sale response, 0 competing external sends (Total calls = 1)');

  // Test 6: Mandatory claim ID for new dispatch (Item 5)
  // guard_ai_pre_dispatch with p_ai_claim_id = null must fail-closed (no NULL bypass)
  const t6Win = await createDueSlaWindow('t6_null_claim');
  const { data: t6NullGuard } = await admin.rpc('guard_ai_pre_dispatch' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t6Win.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t6Win.windowId,
    p_ai_claim_id: null,
    p_channel: 'FACEBOOK',
  } as never);
  assert.strictEqual((t6NullGuard as any)?.[0]?.granted, false);
  assert.strictEqual((t6NullGuard as any)?.[0]?.reason, 'CLAIM_ID_MANDATORY');
  pass('Mandatory claim ID: NULL claim cannot acquire dispatch authority (no NULL authorization bypass)');

  // Test 7A: Stale claim rejected by finalize_ai_outbound_delivery_atomic (Item 2 Facebook)
  // Call finalizer with real existing delivery in PROVIDER_SENT_PENDING_FINALIZE, but stale claim
  const t7AWin = await createDueSlaWindow('t7a_stale_fin');
  const t7AClaim1 = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t7AWin.windowId });
  expireClaimDirectSql(t7AWin.windowId);
  const t7AClaim2 = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t7AWin.windowId });

  // Grant dispatch under active claim2
  const { data: t7AGuard } = await admin.rpc('guard_ai_pre_dispatch' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t7AWin.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t7AWin.windowId,
    p_ai_claim_id: t7AClaim2.claimId,
    p_channel: 'FACEBOOK',
  } as never);
  const t7ADelId = (t7AGuard as any)?.[0]?.delivery_id;
  const t7AToken = (t7AGuard as any)?.[0]?.dispatch_token;

  await admin.rpc('record_ai_outbound_provider_result' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t7ADelId,
    p_outcome: 'SENT',
    p_dispatch_token: t7AToken,
    p_provider_msg_id: 'mid_t7a_stale',
  } as never);

  // Call finalizer with stale claim1
  const { error: t7AErr } = await admin.rpc('finalize_ai_outbound_delivery_atomic' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t7ADelId,
    p_conversation_id: t7AWin.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t7AWin.windowId,
    p_ai_claim_id: t7AClaim1.claimId, // Stale claim!
    p_provider_msg_id: 'mid_t7a_stale',
    p_sanitized_content: 'test content',
    p_raw_content: 'test content',
  } as never);
  assert.ok(t7AErr && (t7AErr as any).message?.includes('CLAIM_NOT_AUTHORIZED'), 'Stale claim must be rejected fail-closed');
  pass('Stale claim rejected by finalize_ai_outbound_delivery_atomic with real delivery');

  // Test 7B: Stale claim rejected by finalize_ai_zalo_sla_atomic (Item 2 Zalo)
  const t7BConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t7BConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t7b_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t7BTriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t7BTriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t7BConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo trigger',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const t7BWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t7BConvoId,
    triggerInteractionId: t7BTriggerId,
  });
  const t7BClaim1 = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t7BWin.id });
  expireClaimDirectSql(t7BWin.id);
  const t7BClaim2 = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t7BWin.id });

  const t7BZaloDelId = crypto.randomUUID();
  const t7BZaloMid = `zalo_mid_t7b_${RUN_ID}`;
  await admin.from('zalo_outbound_deliveries').insert({
    id: t7BZaloDelId,
    company_id: COMPANY_ID,
    conversation_id: t7BConvoId,
    customer_id: CUSTOMER_ID,
    recipient_zalo_uid: `zalo_user_t7b_${RUN_ID}`,
    idempotency_key: `zalo_out:${COMPANY_ID}:ai-sla-win-${t7BWin.id}`,
    command_id: `ai-sla-win-${t7BWin.id}`,
    channel: 'ZALO',
    content: 'Tư vấn Zalo',
    content_sha256: crypto.createHash('sha256').update('Tư vấn Zalo').digest('hex'),
    status: 'PROVIDER_SENT_PENDING_FINALIZE',
    provider_msg_id: t7BZaloMid,
    attempts: 1,
    actor_type: 'AI',
  });

  const { error: t7BErr } = await admin.rpc('finalize_ai_zalo_sla_atomic' as never, {
    p_company_id: COMPANY_ID,
    p_window_id: t7BWin.id,
    p_ai_claim_id: t7BClaim1.claimId, // Stale claim!
    p_zalo_delivery_id: t7BZaloDelId,
    p_provider_msg_id: t7BZaloMid,
  } as never);
  assert.ok(t7BErr && (t7BErr as any).message?.includes('CLAIM_NOT_AUTHORIZED'), 'Stale claim must be rejected fail-closed for Zalo');
  pass('Stale claim rejected by finalize_ai_zalo_sla_atomic with real delivery');

  // Test 8: Real delivery cross-binding test: wrong window cannot finalize (Item 3)
  const t8Win = await createDueSlaWindow('t8_real_binding');
  const t8Claim = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t8Win.windowId });
  const { data: t8Guard } = await admin.rpc('guard_ai_pre_dispatch' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t8Win.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t8Win.windowId,
    p_ai_claim_id: t8Claim.claimId,
    p_channel: 'FACEBOOK',
  } as never);
  const t8DelId = (t8Guard as any)?.[0]?.delivery_id;
  const t8Token = (t8Guard as any)?.[0]?.dispatch_token;
  await admin.rpc('record_ai_outbound_provider_result' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t8DelId,
    p_outcome: 'SENT',
    p_dispatch_token: t8Token,
    p_provider_msg_id: 'mid_t8_binding',
  } as never);

  const t8OtherWin = await createDueSlaWindow('t8_other_win');
  const { error: t8Err } = await admin.rpc('finalize_ai_outbound_delivery_atomic' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t8DelId,
    p_conversation_id: t8Win.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t8OtherWin.windowId, // Mutated field: wrong window
    p_ai_claim_id: t8Claim.claimId,
    p_provider_msg_id: 'mid_t8_binding',
    p_sanitized_content: 'test',
    p_raw_content: 'test',
  } as never);
  assert.ok(t8Err && (t8Err as any).message?.includes('COMMAND_IDENTITY_MISMATCH'), 'Wrong window must fail with COMMAND_IDENTITY_MISMATCH');
  pass('Real delivery cross-binding: wrong window rejected with COMMAND_IDENTITY_MISMATCH');

  // Test 9: Real delivery cross-binding test: wrong customer cannot finalize (Item 3)
  const otherCustomerRow = await admin.from('customers').insert({
    id: crypto.randomUUID(),
    company_id: COMPANY_ID,
    customer_code: `CUST_OTHER_${RUN_ID}`,
    name: 'Khách hàng khác',
    source: 'WEBSITE',
    stage: 'LEAD_NEW',
  }).select('id').single();
  const otherCustomerId = otherCustomerRow.data!.id;

  const { error: t9Err } = await admin.rpc('finalize_ai_outbound_delivery_atomic' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t8DelId,
    p_conversation_id: t8Win.convoId,
    p_customer_id: otherCustomerId, // Mutated field: wrong customer
    p_window_id: t8Win.windowId,
    p_ai_claim_id: t8Claim.claimId,
    p_provider_msg_id: 'mid_t8_binding',
    p_sanitized_content: 'test',
    p_raw_content: 'test',
  } as never);
  assert.ok(t9Err && (t9Err as any).message?.includes('CONVERSATION_CUSTOMER_MISMATCH'), 'Wrong customer must fail with CONVERSATION_CUSTOMER_MISMATCH');
  pass('Real delivery cross-binding: wrong customer rejected with CONVERSATION_CUSTOMER_MISMATCH');

  // Test 10: Real delivery cross-binding test: wrong conversation cannot finalize (Item 3)
  const otherConvoRow = await admin.from('conversations').insert({
    id: crypto.randomUUID(),
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'FACEBOOK',
    external_conversation_id: `page_test_${RUN_ID}:psid_other_convo`,
    status: 'OPEN',
  }).select('id').single();
  const otherConvoId = otherConvoRow.data!.id;

  const { error: t10Err } = await admin.rpc('finalize_ai_outbound_delivery_atomic' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t8DelId,
    p_conversation_id: otherConvoId, // Mutated field: wrong conversation
    p_customer_id: CUSTOMER_ID,
    p_window_id: t8Win.windowId,
    p_ai_claim_id: t8Claim.claimId,
    p_provider_msg_id: 'mid_t8_binding',
    p_sanitized_content: 'test',
    p_raw_content: 'test',
  } as never);
  assert.ok(t10Err && (t10Err as any).message?.includes('DELIVERY_CONVERSATION_MISMATCH'), 'Wrong conversation must fail with DELIVERY_CONVERSATION_MISMATCH');
  pass('Real delivery cross-binding: wrong conversation rejected with DELIVERY_CONVERSATION_MISMATCH');

  // Test 11: Real delivery cross-binding test: wrong company cannot finalize (Item 3)
  const { error: t11Err } = await admin.rpc('finalize_ai_outbound_delivery_atomic' as never, {
    p_company_id: OTHER_COMPANY_ID, // Mutated field: wrong company
    p_delivery_id: t8DelId,
    p_conversation_id: t8Win.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t8Win.windowId,
    p_ai_claim_id: t8Claim.claimId,
    p_provider_msg_id: 'mid_t8_binding',
    p_sanitized_content: 'test',
    p_raw_content: 'test',
  } as never);
  assert.ok(t11Err && (t11Err as any).message?.includes('DELIVERY_COMPANY_MISMATCH'), 'Wrong company must fail with DELIVERY_COMPANY_MISMATCH');
  pass('Real delivery cross-binding: wrong company rejected with DELIVERY_COMPANY_MISMATCH');

  // Test 12: Provider message ID mismatch cannot finalize
  const { error: t12Err } = await admin.rpc('finalize_ai_outbound_delivery_atomic' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t8DelId,
    p_conversation_id: t8Win.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t8Win.windowId,
    p_ai_claim_id: t8Claim.claimId,
    p_provider_msg_id: 'tampered_mid_456',
    p_sanitized_content: 'test',
    p_raw_content: 'test',
  } as never);
  assert.ok(t12Err && (t12Err as any).message?.includes('PROVIDER_MSG_ID_MISMATCH'), 'Provider message ID mismatch must be rejected fail-closed');
  pass('Provider message ID mismatch cannot finalize');

  // Test 13: Harden finalize_ai_zalo_sla_atomic interaction binding (Item 6)
  // Create an unrelated interaction (e.g. actor_type = 'SALE') and pass as p_interaction_id
  const unrelatedIntId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: unrelatedIntId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t7BConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'OUTBOUND',
    sanitized_content: 'Unrelated sale message',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'SALE', // Not AI!
    created_at: new Date().toISOString(),
  });

  const { error: t13ZaloErr } = await admin.rpc('finalize_ai_zalo_sla_atomic' as never, {
    p_company_id: COMPANY_ID,
    p_window_id: t7BWin.id,
    p_ai_claim_id: t7BClaim2.claimId,
    p_zalo_delivery_id: t7BZaloDelId,
    p_interaction_id: unrelatedIntId, // Unrelated interaction!
    p_provider_msg_id: t7BZaloMid,
  } as never);
  assert.ok(t13ZaloErr && (t13ZaloErr as any).message?.includes('INTERACTION_ACTOR_MISMATCH'), 'Unrelated interaction with actor SALE must fail with INTERACTION_ACTOR_MISMATCH');
  pass('Harden finalize_ai_zalo_sla_atomic: unrelated interaction rejected with INTERACTION_ACTOR_MISMATCH');

  // Test 14: Dispatch ownership to provider-result persistence: validates BOTH delivery and SLA-window dispatch tokens (Item 9)
  const t14Win = await createDueSlaWindow('t14_dispatch_ownership');
  const t14Claim = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t14Win.windowId });
  const { data: t14Guard } = await admin.rpc('guard_ai_pre_dispatch' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t14Win.convoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t14Win.windowId,
    p_ai_claim_id: t14Claim.claimId,
    p_channel: 'FACEBOOK',
  } as never);
  const t14DelId = (t14Guard as any)?.[0]?.delivery_id;
  const t14Token = (t14Guard as any)?.[0]?.dispatch_token;
  assert.ok(t14Token, 'guard_ai_pre_dispatch must return durable dispatch_token');

  // 1. Attempt to persist provider result with wrong dispatch token (fails delivery check)
  const { error: t14WrongTokenErr } = await admin.rpc('record_ai_outbound_provider_result' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t14DelId,
    p_outcome: 'SENT',
    p_dispatch_token: crypto.randomUUID(), // Wrong token!
    p_provider_msg_id: 'mid_t14',
  } as never);
  assert.ok(t14WrongTokenErr && (t14WrongTokenErr as any).message?.includes('DISPATCH_TOKEN_MISMATCH'), 'Wrong dispatch token must fail with DISPATCH_TOKEN_MISMATCH');

  // 2. Tamper with window's dispatch token (fails window check even when delivery token matches)
  setWindowDispatchTokenDirectSql(t14Win.windowId, crypto.randomUUID());
  const { error: t14TamperedWinErr } = await admin.rpc('record_ai_outbound_provider_result' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t14DelId,
    p_outcome: 'SENT',
    p_dispatch_token: t14Token,
    p_provider_msg_id: 'mid_t14',
  } as never);
  assert.ok(t14TamperedWinErr && (t14TamperedWinErr as any).message?.includes('DISPATCH_TOKEN_MISMATCH'), 'Tampered window dispatch token must fail DISPATCH_TOKEN_MISMATCH');

  // Restore matching window token
  setWindowDispatchTokenDirectSql(t14Win.windowId, t14Token);

  // 3. Persist with matching dispatch tokens on both delivery and window
  const { data: t14SuccessStatus } = await admin.rpc('record_ai_outbound_provider_result' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t14DelId,
    p_outcome: 'SENT',
    p_dispatch_token: t14Token,
    p_provider_msg_id: 'mid_t14',
  } as never);
  assert.strictEqual(t14SuccessStatus, 'PROVIDER_SENT_PENDING_FINALIZE');
  pass('Dispatch ownership: record_ai_outbound_provider_result validates both delivery and window dispatch_tokens');

  // Test 15: Make two-worker test truly end-to-end (Item 4)
  // Competing runtime executions against the same SLA logical operation with a controlled provider mock + barrier.
  const t15Win = await createDueSlaWindow('t15_e2e_race');
  let t15ProviderInvocations = 0;
  const t15Mid = `mid_e2e_race_${RUN_ID}_${Date.now()}`;

  const workerRunner = () => executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t15Win.windowId,
    model: new CompliantModel(),
    providerSender: async () => {
      t15ProviderInvocations++;
      // Controlled barrier: hold dispatch for 80ms so other worker attempts concurrent dispatch
      await new Promise(r => setTimeout(r, 80));
      return { status: 'SENT', externalMessageId: t15Mid };
    },
    client: admin,
  });

  const [t15Res1, t15Res2] = await Promise.all([workerRunner(), workerRunner()]);
  const t15Winners = [t15Res1, t15Res2].filter(r => r.success);
  const t15Losers = [t15Res1, t15Res2].filter(r => !r.success);

  assert.strictEqual(t15Winners.length, 1, 'Exactly one worker must win dispatch authority');
  assert.strictEqual(t15Losers.length, 1, 'Exactly one worker must be denied');
  assert.strictEqual(t15ProviderInvocations, 1, 'Provider invocation count must be EXACTLY 1');

  // Assert one durable delivery in SENT
  const { data: t15Deliveries } = await admin.from('outbound_deliveries')
    .select('id, delivery_status, provider_message_id')
    .eq('client_command_id', t15Win.windowId);
  assert.strictEqual(t15Deliveries?.length, 1);
  assert.strictEqual(t15Deliveries?.[0]?.delivery_status, 'SENT');

  // Assert one final public AI interaction
  const { data: t15Interactions } = await admin.from('interactions')
    .select('id, external_ref')
    .eq('conversation_id', t15Win.convoId)
    .eq('actor_type', 'AI');
  assert.strictEqual(t15Interactions?.length, 1);
  assert.strictEqual(t15Interactions?.[0]?.external_ref, t15Mid);

  // Assert SLA window resolves once to AI_RESPONDED
  const { data: t15WinRow } = await bossRealClient.from('response_sla_windows')
    .select('state, ai_response_interaction_id')
    .eq('id', t15Win.windowId)
    .single();
  assert.strictEqual(t15WinRow?.state, 'AI_RESPONDED');
  assert.strictEqual(t15WinRow?.ai_response_interaction_id, t15Interactions?.[0]?.id);
  pass('Two-worker end-to-end race: exactly 1 winner, provider invocation count = 1, 1 delivery, 1 AI interaction, SLA resolves once');

  // Test 16: SENT happy path: exactly one public AI interaction, exactly one durable provider delivery, exactly one private provenance record, SLA = AI_RESPONDED
  const t16Win = await createDueSlaWindow('t16_happy_path');
  const t16Mid = `mid_happy_${RUN_ID}_${Date.now()}`;
  const t16Result = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t16Win.windowId,
    model: new CompliantModel(),
    providerSender: async () => ({
      status: 'SENT',
      externalMessageId: t16Mid,
    }),
    client: admin,
  });
  assert.strictEqual(t16Result.success, true);

  const { data: t16Interactions } = await admin.from('interactions').select('id, external_ref').eq('conversation_id', t16Win.convoId).eq('actor_type', 'AI');
  assert.strictEqual(t16Interactions?.length, 1);
  assert.strictEqual(t16Interactions?.[0]?.external_ref, t16Mid);

  const { data: t16Deliveries } = await admin.from('outbound_deliveries').select('id, delivery_status').eq('client_command_id', t16Win.windowId);
  assert.strictEqual(t16Deliveries?.length, 1);
  assert.strictEqual(t16Deliveries?.[0]?.delivery_status, 'SENT');

  const { data: t16Raw } = await (admin as any).rpc('get_interaction_raw_content', {
    p_company_id: COMPANY_ID,
    p_interaction_id: t16Result.interactionId,
  });
  assert.strictEqual(t16Raw?.length, 1);

  const { data: t16WinRow } = await bossRealClient.from('response_sla_windows').select('state').eq('id', t16Win.windowId).single();
  assert.strictEqual(t16WinRow?.state, 'AI_RESPONDED');
  pass('SENT happy path: exactly one public interaction, one delivery, one provenance record, SLA = AI_RESPONDED');

  // Test 17: Zalo production AI path persists all 9 mandatory provenance fields (Item 10)
  const { data: t17RawData } = await (admin as any).rpc('get_interaction_raw_content', {
    p_company_id: COMPANY_ID,
    p_interaction_id: t4Result.interactionId,
  });
  const t17Meta = t17RawData?.[0]?.source_metadata as any;
  assert.strictEqual(t17Meta?.source, 'ai_response_runtime', 'Provenance must include source');
  assert.strictEqual(t17Meta?.model_version, 'gpt-4o-mini-test', 'Provenance must include model_version');
  assert.notStrictEqual(t17Meta?.analysis_record_id, undefined, 'Provenance must include analysis_record_id');
  assert.notStrictEqual(t17Meta?.sales_style_profile_id, undefined, 'Provenance must include sales_style_profile_id');
  assert.notStrictEqual(t17Meta?.is_neutral_default, undefined, 'Provenance must include is_neutral_default');
  assert.notStrictEqual(t17Meta?.ai_claim_id, undefined, 'Provenance must include ai_claim_id');
  assert.notStrictEqual(t17Meta?.window_id, undefined, 'Provenance must include window_id');
  assert.notStrictEqual(t17Meta?.delivery_id, undefined, 'Provenance must include delivery_id');
  assert.notStrictEqual(t17Meta?.command_id, undefined, 'Provenance must include command_id');
  pass('Zalo production AI path persists all 9 mandatory provenance fields');

  // Test 18: Recursive synthetic message ID scan across all production outbound modules (Item 10)
  const targetPaths = [
    'features/automation/response-sla/services',
    'features/omnichannel/facebook/server.ts',
    'features/omnichannel/facebook/transport.ts',
    'features/omnichannel/zalo',
  ];

  function collectOutboundFiles(p: string): string[] {
    assert.ok(fs.existsSync(p), `Required production module path must physically exist: ${p}`);
    const st = fs.statSync(p);
    if (st.isFile()) return [p];
    const out: string[] = [];
    const entries = fs.readdirSync(p, { withFileTypes: true });
    for (const e of entries) {
      const full = `${p}/${e.name}`;
      if (e.isDirectory()) {
        out.push(...collectOutboundFiles(full));
      } else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js'))) {
        out.push(full);
      }
    }
    return out;
  }

  const allScannedFiles = targetPaths.flatMap(collectOutboundFiles);
  assert.ok(allScannedFiles.length >= 15, `Must find multiple production files to scan, found: ${allScannedFiles.length}`);

  for (const file of allScannedFiles) {
    const code = fs.readFileSync(file, 'utf8');
    assert.strictEqual(
      /msg_\$\{crypto\.randomUUID\(\)\}/.test(code),
      false,
      `Module ${file} must not contain synthetic message ID pattern msg_\${crypto.randomUUID()}`
    );
    assert.strictEqual(
      /externalMessageId:\s*['"`]msg_/.test(code),
      false,
      `Module ${file} must not synthesize externalMessageId`
    );
  }

  const runtimeCode = fs.readFileSync('features/automation/response-sla/services/ai-response-runtime.ts', 'utf8');
  assert.strictEqual(
    /status:\s*'SENT'/.test(runtimeCode),
    false,
    'Production runtime code must not hardcode synthetic SENT status outside type checks'
  );
  pass(`Recursive scan of ${allScannedFiles.length} files across outbound modules: zero synthetic message IDs`);

  // Test 19: UNKNOWN and UNCERTAIN are never downgraded to FAILED
  const t19Win = await createDueSlaWindow('t19_uncertain');
  const t19DelId = crypto.randomUUID();
  const t19Token = crypto.randomUUID();
  await admin.from('outbound_deliveries').insert({
    id: t19DelId,
    company_id: COMPANY_ID,
    conversation_id: t19Win.convoId,
    channel: 'FACEBOOK',
    delivery_status: 'DISPATCHING',
    dispatch_token: t19Token,
  });
  await admin.rpc('record_ai_outbound_provider_result' as never, {
    p_company_id: COMPANY_ID,
    p_delivery_id: t19DelId,
    p_outcome: 'UNKNOWN',
    p_dispatch_token: t19Token,
    p_error_message: 'Network ambiguity',
  } as never);
  const { data: t19Row } = await admin.from('outbound_deliveries').select('delivery_status').eq('id', t19DelId).single();
  assert.strictEqual(t19Row?.delivery_status, 'UNCERTAIN', 'UNKNOWN must map to UNCERTAIN, never FAILED');
  pass('UNKNOWN and UNCERTAIN are never downgraded to FAILED');

  // Test 20: Reconciliation of PROVIDER_SENT_PENDING_FINALIZE does not execute network/provider code
  const t20Win = await createDueSlaWindow('t20_reconcile_no_network');
  const t20DelId = crypto.randomUUID();
  const t20Mid = `mid_reconcile_${RUN_ID}`;
  await admin.from('outbound_deliveries').insert({
    id: t20DelId,
    company_id: COMPANY_ID,
    conversation_id: t20Win.convoId,
    channel: 'FACEBOOK',
    delivery_status: 'PROVIDER_SENT_PENDING_FINALIZE',
    client_command_id: t20Win.windowId,
    provider_message_id: t20Mid,
  });

  const t20Result = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t20Win.windowId,
    model: new CompliantModel(),
    providerSender: async () => {
      throw new Error('NETWORK_EXECUTED_DURING_RECONCILIATION');
    },
    client: admin,
  });
  assert.strictEqual(t20Result.success, true);
  assert.strictEqual(t20Result.externalMessageId, t20Mid);
  const { data: t20WinRow } = await bossRealClient.from('response_sla_windows').select('state').eq('id', t20Win.windowId).single();
  assert.strictEqual(t20WinRow?.state, 'AI_RESPONDED');
  pass('Reconciliation of PROVIDER_SENT_PENDING_FINALIZE does not execute network/provider code');

  // Test 21: Irreversible provider-accepted semantics in Zalo (Requirement 1 & 9)
  // Prove that once ACCEPTED is recorded, no contradictory REJECTED or UNCERTAIN outcome can downgrade or release the delivery.
  const t21ConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t21ConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t21_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t21TriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t21TriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t21ConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo test irreversibility',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
  });
  const t21Win = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t21ConvoId,
    triggerInteractionId: t21TriggerId,
  });

  const t21Cmd = `zalo-irrev-c1-${RUN_ID}`;
  const { data: t21Claim } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t21ConvoId,
    p_command_id: t21Cmd,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'Sale C1 irreversibility',
    p_sanitized_content: 'Sale C1 irreversibility',
    p_content_sha256: crypto.createHash('sha256').update('Sale C1 irreversibility').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  const t21DelId = (t21Claim as any)?.[0]?.delivery_id;
  const t21Token = (t21Claim as any)?.[0]?.claim_token;
  const t21Mid = `zalo_mid_t21_${RUN_ID}`;

  // 1. Record ACCEPTED with valid non-empty mid
  await admin.rpc('zalo_record_outbound_provider_result' as never, {
    p_delivery_id: t21DelId,
    p_claim_token: t21Token,
    p_outcome: 'ACCEPTED',
    p_provider_msg_id: t21Mid,
  } as never);

  // 2. Assert delivery is in PROVIDER_SENT_PENDING_FINALIZE
  const { data: t21DelRow1 } = await admin.from('zalo_outbound_deliveries').select('status, provider_msg_id').eq('id', t21DelId).single();
  assert.strictEqual(t21DelRow1?.status, 'PROVIDER_SENT_PENDING_FINALIZE');
  assert.strictEqual(t21DelRow1?.provider_msg_id, t21Mid);

  async function expectRpcError(
    fn: string,
    args: Record<string, unknown>,
    expectedSnippet: string
  ) {
    const { error } = await admin.rpc(fn as never, args as never);
    assert.ok(error, `Expected ${fn} to fail, but succeeded`);
    assert.ok(
      (error as any).message?.includes(expectedSnippet),
      `Expected ${fn} error to include "${expectedSnippet}", got: "${(error as any).message}"`
    );
  }

  // 3. Attempt to record contradictory REJECTED using same token -> MUST fail closed
  await expectRpcError(
    'zalo_record_outbound_provider_result',
    {
      p_delivery_id: t21DelId,
      p_claim_token: t21Token,
      p_outcome: 'REJECTED',
      p_error_code: 'SIMULATED_REJECT',
    },
    'ZALO_OUTCOME_IRREVERSIBLE'
  );

  // 4. Attempt to record contradictory UNCERTAIN using same token -> MUST fail closed
  await expectRpcError(
    'zalo_record_outbound_provider_result',
    {
      p_delivery_id: t21DelId,
      p_claim_token: t21Token,
      p_outcome: 'UNCERTAIN',
      p_error_code: 'SIMULATED_UNCERTAIN',
    },
    'ZALO_OUTCOME_IRREVERSIBLE'
  );

  // 5. Attempt invalid p_outcome string -> MUST raise ZALO_OUTBOUND_OUTCOME_INVALID
  await expectRpcError(
    'zalo_record_outbound_provider_result',
    {
      p_delivery_id: t21DelId,
      p_claim_token: t21Token,
      p_outcome: 'INVALID_STRING',
    },
    'ZALO_OUTBOUND_OUTCOME_INVALID'
  );

  // 6. Conflicting ACCEPTED with different provider message ID -> MUST fail
  await expectRpcError(
    'zalo_record_outbound_provider_result',
    {
      p_delivery_id: t21DelId,
      p_claim_token: t21Token,
      p_outcome: 'ACCEPTED',
      p_provider_msg_id: 'conflicting_provider_mid',
    },
    'ZALO_PROVIDER_MSG_ID_CONFLICT'
  );

  // 7. Repeated idempotent ACCEPTED with SAME provider message ID -> succeeds
  const { data: t21ReplayStatus } = await admin.rpc('zalo_record_outbound_provider_result' as never, {
    p_delivery_id: t21DelId,
    p_claim_token: t21Token,
    p_outcome: 'ACCEPTED',
    p_provider_msg_id: t21Mid,
  } as never);
  assert.strictEqual(t21ReplayStatus, 'PROVIDER_SENT_PENDING_FINALIZE');

  // 8. Delivery remains PROVIDER_SENT_PENDING_FINALIZE; shared window remains PROVIDER_ACCEPTED
  const { data: t21DelRowAfter } = await admin.from('zalo_outbound_deliveries').select('status').eq('id', t21DelId).single();
  assert.strictEqual(t21DelRowAfter?.status, 'PROVIDER_SENT_PENDING_FINALIZE');
  const { data: t21WinRow } = await bossRealClient.from('response_sla_windows').select('dispatch_state, dispatch_owner').eq('id', t21Win.id).single();
  assert.strictEqual(t21WinRow?.dispatch_state, 'PROVIDER_ACCEPTED');
  assert.strictEqual(t21WinRow?.dispatch_owner, 'SALE');

  // 9. AI provider calls = 0 while in PROVIDER_ACCEPTED / pending finalize
  let t21AiCalls = 0;
  const t21AiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t21Win.id,
    conversationId: t21ConvoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      t21AiCalls++;
      return { status: 'SENT', externalMessageId: 'ai_should_not_run' };
    },
    client: admin,
  });
  assert.strictEqual(t21AiCalls, 0, 'AI provider invocation count must remain 0');
  assert.strictEqual(t21AiResult.success, false);

  // 10. Finalize C1 -> resolves SLA to SALE_RESPONDED
  await admin.rpc('zalo_finalize_outbound_delivery' as never, { p_delivery_id: t21DelId } as never);
  const { data: t21WinFinal } = await bossRealClient.from('response_sla_windows').select('state').eq('id', t21Win.id).single();
  assert.strictEqual(t21WinFinal?.state, 'SALE_RESPONDED');
  pass('Provider-accepted irreversibility (Zalo): contradictory REJECTED/UNCERTAIN rejected fail-closed, AI calls = 0, SLA = SALE_RESPONDED');

  // Test 22: Same-command Zalo retry preserves shared and delivery token without rotation (Requirement 2)
  const t22ConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t22ConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t22_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t22TriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t22TriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t22ConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo test token stability',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
  });
  const t22Win = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t22ConvoId,
    triggerInteractionId: t22TriggerId,
  });

  const t22Cmd = `zalo-stable-token-${RUN_ID}`;
  const { data: t22Claim1 } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t22ConvoId,
    p_command_id: t22Cmd,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'Stable token send',
    p_sanitized_content: 'Stable token send',
    p_content_sha256: crypto.createHash('sha256').update('Stable token send').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  const t22DelId = (t22Claim1 as any)?.[0]?.delivery_id;
  const t22ClaimTokenBefore = (t22Claim1 as any)?.[0]?.claim_token;

  // Read SLA window dispatch_token before retry
  const { data: t22WinBefore } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_token, dispatch_delivery_id, dispatch_fenced_until')
    .eq('id', t22Win.id)
    .single();

  // Retry the exact same command while delivery is SENDING
  const { data: t22Claim2 } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t22ConvoId,
    p_command_id: t22Cmd,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'Stable token send',
    p_sanitized_content: 'Stable token send',
    p_content_sha256: crypto.createHash('sha256').update('Stable token send').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  assert.strictEqual((t22Claim2 as any)?.[0]?.claim_status, 'BUSY');

  // Verify delivery token is byte-for-byte unchanged
  const { data: t22DelAfter } = await admin.from('zalo_outbound_deliveries').select('claim_token').eq('id', t22DelId).single();
  assert.strictEqual(t22DelAfter?.claim_token, t22ClaimTokenBefore, 'Delivery claim_token must remain identical');

  // Verify SLA window dispatch_token, delivery_id, fenced_until are byte-for-byte unchanged
  const { data: t22WinAfter } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_token, dispatch_delivery_id, dispatch_fenced_until')
    .eq('id', t22Win.id)
    .single();
  assert.strictEqual(t22WinAfter?.dispatch_token, t22WinBefore?.dispatch_token, 'dispatch_token must NOT be rotated on retry');
  assert.strictEqual(t22WinAfter?.dispatch_delivery_id, t22WinBefore?.dispatch_delivery_id, 'dispatch_delivery_id must be unchanged');
  assert.strictEqual(t22WinAfter?.dispatch_fenced_until, t22WinBefore?.dispatch_fenced_until, 'dispatch_fenced_until must be unchanged');
  pass('Same-command Zalo retry preserves shared and delivery token without rotation (Zero Token Rotation)');

  // Test 23: Human Sale Zalo PENDING_FINALIZE crash recovery with zero network (Requirement 3)
  const t23ConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t23ConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t23_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t23TriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t23TriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t23ConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo test crash recovery',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
  });
  const t23Win = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t23ConvoId,
    triggerInteractionId: t23TriggerId,
  });

  const t23Cmd = `zalo-crash-recov-${RUN_ID}`;
  let t23ProviderCalls = 0;
  const t23Mid = `zalo_mid_t23_${RUN_ID}`;

  // Use a simulated failing finalizer on Run 1
  let t23FailFinalize = true;
  const failingFinalizeClient = {
    ...admin,
    rpc: async (fn: string, args: any) => {
      if (fn === 'zalo_finalize_outbound_delivery' && t23FailFinalize) {
        throw new Error('SIMULATED_CRASH_AFTER_ACCEPTED');
      }
      return admin.rpc(fn as never, args);
    },
  };

  const inboxService23 = new ZaloInboxService({
    supabase: failingFinalizeClient as any,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        t23ProviderCalls++;
        return { outcome: 'ACCEPTED', providerMsgId: t23Mid };
      },
    } as any),
  });

  // Run 1: provider succeeds, provider result persisted, but finalizer crashes
  await assert.rejects(
    async () => {
      await inboxService23.sendZaloReply(
        { conversationId: t23ConvoId, content: 'Tin nhan thu crash recovery', commandId: t23Cmd, oaId: t4OaId },
        saleActorContext
      );
    },
    /SIMULATED_CRASH_AFTER_ACCEPTED/
  );

  assert.strictEqual(t23ProviderCalls, 1, 'Provider was invoked once on initial attempt');

  // Verify delivery is durably in PROVIDER_SENT_PENDING_FINALIZE
  const { data: t23DelRow1 } = await admin
    .from('zalo_outbound_deliveries')
    .select('id, status, provider_msg_id')
    .eq('command_id', t23Cmd)
    .single();
  assert.strictEqual(t23DelRow1?.status, 'PROVIDER_SENT_PENDING_FINALIZE');

  // Run 2: normal finalizer restored, retry same commandId
  t23FailFinalize = false;
  const inboxService23Recov = new ZaloInboxService({
    supabase: admin,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        t23ProviderCalls++;
        throw new Error('NETWORK_EXECUTED_ON_RETRY');
      },
    } as any),
  });

  const t23RecovResult = await inboxService23Recov.sendZaloReply(
    { conversationId: t23ConvoId, content: 'Tin nhan thu crash recovery', commandId: t23Cmd, oaId: t4OaId },
    saleActorContext
  );

  assert.strictEqual(t23ProviderCalls, 1, 'Provider invocation count MUST remain exactly 1 (zero network on retry)');
  assert.strictEqual(t23RecovResult.success, true);

  // Assert SLA resolved to SALE_RESPONDED and exactly 1 interaction was created
  const { data: t23WinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state')
    .eq('id', t23Win.id)
    .single();
  assert.strictEqual(t23WinFinal?.state, 'SALE_RESPONDED');

  const { count: t23InteractionCount } = await admin
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', t23ConvoId)
    .eq('direction', 'OUTBOUND');
  assert.strictEqual(t23InteractionCount, 1, 'Exactly one OUTBOUND interaction must be created');
  pass('Human Sale Zalo PENDING_FINALIZE crash recovery: zero network on retry, SLA = SALE_RESPONDED, 1 interaction');

  // Test 24: Persisted Zalo UNCERTAIN on lease expiry (Requirement 4)
  const t24ConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t24ConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t24_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t24TriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t24TriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t24ConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo test persist uncertain',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
  });
  const t24Win = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t24ConvoId,
    triggerInteractionId: t24TriggerId,
  });

  const t24Cmd1 = `zalo-own-c1-${RUN_ID}`;
  const t24Cmd2 = `zalo-compete-c2-${RUN_ID}`;
  let t24C2Calls = 0;

  // 1. C1 acquires dispatch ownership
  await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t24ConvoId,
    p_command_id: t24Cmd1,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'C1 ownership',
    p_sanitized_content: 'C1 ownership',
    p_content_sha256: crypto.createHash('sha256').update('C1 ownership').digest('hex'),
    p_oa_id: t4OaId,
  } as never);

  // 2. Expire lease
  expireDispatchFenceDirectSql(t24Win.id);

  // 3. Competing Sale calls sendZaloReply
  const inboxService24 = new ZaloInboxService({
    supabase: admin,
    clientProvider: async () => ({
      sendTextMessageWithOutcome: async () => {
        t24C2Calls++;
        return { outcome: 'ACCEPTED', providerMsgId: 'c2_should_never_run' };
      },
    } as any),
  });

  const t24C2Result = await inboxService24.sendZaloReply(
    { conversationId: t24ConvoId, content: 'C2 send', commandId: t24Cmd2, oaId: t4OaId },
    saleActorContext
  );

  assert.strictEqual(t24C2Calls, 0, 'Competing Sale C2 provider calls must be 0');
  assert.strictEqual(t24C2Result.success, false);
  assert.strictEqual(t24C2Result.status, 'UNCERTAIN');

  // 4. Assert DB window itself is NOW persistently UNCERTAIN without running any AI worker!
  const { data: t24WinAfterC2 } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_state, state')
    .eq('id', t24Win.id)
    .single();
  assert.strictEqual(t24WinAfterC2?.dispatch_state, 'UNCERTAIN', 'Window dispatch_state must be persistently UNCERTAIN');
  assert.strictEqual(t24WinAfterC2?.state, 'OPEN');

  // 5. Test expired AI fence hit by human Zalo Sale path also persists UNCERTAIN
  const t24AiConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t24AiConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t24_ai_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t24AiTriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t24AiTriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t24AiConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo test AI fence expiry',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
  });
  const t24AiWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t24AiConvoId,
    triggerInteractionId: t24AiTriggerId,
  });
  const t24AiClaim = await claimResponseSlaForAi({ companyId: COMPANY_ID, windowId: t24AiWin.id });
  const { data: t24AiGuard } = await admin.rpc('guard_ai_pre_dispatch' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t24AiConvoId,
    p_customer_id: CUSTOMER_ID,
    p_window_id: t24AiWin.id,
    p_ai_claim_id: t24AiClaim.claimId,
    p_channel: 'ZALO',
  } as never);
  assert.strictEqual((t24AiGuard as any)?.[0]?.granted, true, 'AI must acquire dispatch authority');
  expireDispatchFenceDirectSql(t24AiWin.id);

  const t24SaleAiFenceResult = await inboxService24.sendZaloReply(
    { conversationId: t24AiConvoId, content: 'Sale hits expired AI fence', commandId: `sale-ai-fence-${RUN_ID}`, oaId: t4OaId },
    saleActorContext
  );
  assert.strictEqual(t24SaleAiFenceResult.success, false);
  assert.strictEqual(t24SaleAiFenceResult.status, 'UNCERTAIN');

  const { data: t24AiWinPersist } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_state, state')
    .eq('id', t24AiWin.id)
    .single();
  assert.strictEqual(t24AiWinPersist?.dispatch_state, 'UNCERTAIN', 'Expired AI fence must persistently set UNCERTAIN on Sale claim');
  pass('Persisted Zalo UNCERTAIN: lease-expiry updates persist in DB without rollback, provider calls = 0');

  // Test 25: Facebook stale provider SENT cannot resolve or mutate active Sale dispatch window (Requirement 5)
  const t25Win = await createDueSlaWindow('t25_fb_stale_result');
  const t25R1Req = crypto.randomUUID();
  const t25R2Req = crypto.randomUUID();
  let t25AiCalls = 0;

  // 1. Seed old Sale request R1 in han_outbox on the same conversation
  const t25R1IntId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t25R1IntId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t25Win.convoId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'OUTBOUND',
    sanitized_content: 'Old R1 send',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'SALE',
    actor_user_id: sale.id,
    created_at: new Date(Date.now() - 15 * 60000).toISOString(),
  });
  await admin.from('private.han_outbox' as never).insert({
    company_id: COMPANY_ID,
    request_id: t25R1Req,
    conversation_id: t25Win.convoId,
    interaction_id: t25R1IntId,
    actor_id: sale.id,
    content: 'Old R1 send',
    status: 'SENDING',
  } as never);

  // 2. Active Sale request R2 prepares and acquires dispatch ownership
  const { data: t25R2Prep } = await admin.rpc('han_prepare_send' as never, {
    p_company: COMPANY_ID,
    p_conversation: t25Win.convoId,
    p_actor: sale.id,
    p_request: t25R2Req,
    p_content: 'Active R2 send',
    p_safe: 'Active R2 send',
    p_safe_status: 'SUCCEEDED',
    p_delivery: null,
  } as never);
  assert.strictEqual((t25R2Prep as any)?.claimed, true);

  // Verify R2 currently owns the SLA window
  const { data: t25WinBeforeR1 } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_delivery_id, dispatch_owner, dispatch_state, state')
    .eq('id', t25Win.windowId)
    .single();
  assert.strictEqual(t25WinBeforeR1?.dispatch_delivery_id, t25R2Req);
  assert.strictEqual(t25WinBeforeR1?.dispatch_owner, 'SALE');
  assert.strictEqual(t25WinBeforeR1?.dispatch_state, 'DISPATCHING');
  assert.strictEqual(t25WinBeforeR1?.state, 'OPEN');

  // 3. Process stale R1 as SENT with authoritative MID
  await admin.rpc('han_finish_send' as never, {
    p_company: COMPANY_ID,
    p_request: t25R1Req,
    p_status: 'SENT',
    p_mid: `mid_r1_stale_${RUN_ID}`,
  } as never);

  // 4. Assert R2 ownership/delivery binding on SLA window is STRICTLY UNCHANGED!
  const { data: t25WinAfterR1 } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_delivery_id, dispatch_owner, dispatch_state, state, sale_response_interaction_id')
    .eq('id', t25Win.windowId)
    .single();
  assert.strictEqual(t25WinAfterR1?.dispatch_delivery_id, t25R2Req, 'dispatch_delivery_id must still be R2');
  assert.strictEqual(t25WinAfterR1?.dispatch_owner, 'SALE');
  assert.strictEqual(t25WinAfterR1?.dispatch_state, 'DISPATCHING');
  assert.strictEqual(t25WinAfterR1?.state, 'OPEN', 'Window must NOT be resolved by stale R1');
  assert.strictEqual(t25WinAfterR1?.sale_response_interaction_id, null);

  // 5. Competing AI worker attempts dispatch while R2 in flight -> blocked!
  const t25AiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t25Win.windowId,
    conversationId: t25Win.convoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      t25AiCalls++;
      return { status: 'SENT', externalMessageId: 'ai_should_not_run' };
    },
    client: admin,
  });
  assert.strictEqual(t25AiCalls, 0, 'AI provider invocation count MUST remain 0 while R2 is in-flight');
  assert.strictEqual(t25AiResult.success, false);

  // 6. Finish R2 as SENT -> SLA window resolves strictly to SALE_RESPONDED bound to R2
  await admin.rpc('han_finish_send' as never, {
    p_company: COMPANY_ID,
    p_request: t25R2Req,
    p_status: 'SENT',
    p_mid: `mid_r2_active_${RUN_ID}`,
  } as never);

  const { data: t25WinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state, dispatch_owner')
    .eq('id', t25Win.windowId)
    .single();
  assert.strictEqual(t25WinFinal?.state, 'SALE_RESPONDED');
  assert.strictEqual(t25WinFinal?.dispatch_state, 'PROVIDER_ACCEPTED');
  pass('Facebook stale-result ownership: stale R1 SENT cannot mutate/resolve active R2 dispatch window');

  // Test 26: Regression assertions for restored han_prepare_send security & input invariants (Requirement 6)
  const t26Win = await createDueSlaWindow('t26_prepare_guards');

  // A. Content length > 2000 -> INVALID_INPUT
  await expectRpcError(
    'han_prepare_send',
    {
      p_company: COMPANY_ID,
      p_conversation: t26Win.convoId,
      p_actor: sale.id,
      p_request: crypto.randomUUID(),
      p_content: 'A'.repeat(2001),
      p_safe: 'A'.repeat(2001),
      p_safe_status: 'SUCCEEDED',
      p_delivery: null,
    },
    'INVALID_INPUT'
  );

  // B. Invalid p_safe_status -> INVALID_INPUT
  await expectRpcError(
    'han_prepare_send',
    {
      p_company: COMPANY_ID,
      p_conversation: t26Win.convoId,
      p_actor: sale.id,
      p_request: crypto.randomUUID(),
      p_content: 'Hello',
      p_safe: 'Hello',
      p_safe_status: 'PENDING',
      p_delivery: null,
    },
    'INVALID_INPUT'
  );

  // C. FAILED with non-null p_safe -> INVALID_INPUT
  await expectRpcError(
    'han_prepare_send',
    {
      p_company: COMPANY_ID,
      p_conversation: t26Win.convoId,
      p_actor: sale.id,
      p_request: crypto.randomUUID(),
      p_content: 'Hello',
      p_safe: 'Hello',
      p_safe_status: 'FAILED',
      p_delivery: null,
    },
    'INVALID_INPUT'
  );

  // D. SUCCEEDED with null p_safe -> INVALID_INPUT
  await expectRpcError(
    'han_prepare_send',
    {
      p_company: COMPANY_ID,
      p_conversation: t26Win.convoId,
      p_actor: sale.id,
      p_request: crypto.randomUUID(),
      p_content: 'Hello',
      p_safe: null,
      p_safe_status: 'SUCCEEDED',
      p_delivery: null,
    },
    'INVALID_INPUT'
  );

  // E. Non-member / unauthorized actor -> ACCESS_DENIED
  await expectRpcError(
    'han_prepare_send',
    {
      p_company: COMPANY_ID,
      p_conversation: t26Win.convoId,
      p_actor: crypto.randomUUID(),
      p_request: crypto.randomUUID(),
      p_content: 'Hello',
      p_safe: 'Hello',
      p_safe_status: 'SUCCEEDED',
      p_delivery: null,
    },
    'ACCESS_DENIED'
  );

  // F. Non-Facebook conversation channel -> NOT_FOUND
  const t26NonFbConvo = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t26NonFbConvo,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t26_${RUN_ID}`,
    status: 'OPEN',
  });
  await expectRpcError(
    'han_prepare_send',
    {
      p_company: COMPANY_ID,
      p_conversation: t26NonFbConvo,
      p_actor: sale.id,
      p_request: crypto.randomUUID(),
      p_content: 'Hello',
      p_safe: 'Hello',
      p_safe_status: 'SUCCEEDED',
      p_delivery: null,
    },
    'NOT_FOUND'
  );

  pass('Restored han_prepare_send security guards: content bounds, safe status consistency, actor membership, channel matching');

  // Test 27: Preserve Zalo reconciliation authority across PROVIDER_UNCERTAIN (Requirement 1)
  const t27ConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t27ConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t27_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t27TriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t27TriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t27ConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo test reconciliation authority',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
  });
  const t27Win = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t27ConvoId,
    triggerInteractionId: t27TriggerId,
  });

  const t27Cmd1 = `zalo-recon-c1-${RUN_ID}`;

  // 1. Sale C1 claims D1 with token T1
  const { data: t27Claim1 } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t27ConvoId,
    p_command_id: t27Cmd1,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'C1 reconciliation send',
    p_sanitized_content: 'C1 reconciliation send',
    p_content_sha256: crypto.createHash('sha256').update('C1 reconciliation send').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  const t27DelId1 = (t27Claim1 as any)?.[0]?.delivery_id;
  const t27Token1 = (t27Claim1 as any)?.[0]?.claim_token;
  assert.ok(t27DelId1 && t27Token1, 'Delivery D1 and claim token T1 must be minted');

  // Verify initial window state bound to D1/T1
  const { data: t27WinInitial } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_delivery_id, dispatch_token, dispatch_owner, dispatch_state, state')
    .eq('id', t27Win.id)
    .single();
  assert.strictEqual(t27WinInitial?.dispatch_delivery_id, t27DelId1);
  assert.strictEqual(t27WinInitial?.dispatch_token, t27Token1);
  assert.strictEqual(t27WinInitial?.dispatch_owner, 'SALE');
  assert.strictEqual(t27WinInitial?.dispatch_state, 'DISPATCHING');

  // 2. Expire the ACTUAL zalo_outbound_deliveries.lease_until, not merely response_sla_windows.dispatch_fenced_until
  expireZaloDeliveryLeaseDirectSql(t27DelId1);

  // 3. Trigger same-command inspection so D1 becomes PROVIDER_UNCERTAIN
  const { data: t27ClaimInspect } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t27ConvoId,
    p_command_id: t27Cmd1,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'C1 reconciliation send',
    p_sanitized_content: 'C1 reconciliation send',
    p_content_sha256: crypto.createHash('sha256').update('C1 reconciliation send').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  assert.strictEqual((t27ClaimInspect as any)?.[0]?.claim_status, 'UNCERTAIN');
  // Must return the durable claim_token
  assert.strictEqual((t27ClaimInspect as any)?.[0]?.claim_token, t27Token1, 'RPC must return durable claim_token across UNCERTAIN');

  // 4. Assert D1 still retains reconciliation authority corresponding to T1
  const { data: t27DelAfterExpire } = await admin
    .from('zalo_outbound_deliveries')
    .select('status, claim_token')
    .eq('id', t27DelId1)
    .single();
  assert.strictEqual(t27DelAfterExpire?.status, 'PROVIDER_UNCERTAIN');
  assert.strictEqual(t27DelAfterExpire?.claim_token, t27Token1, 'Delivery claim_token MUST NOT be cleared on PROVIDER_UNCERTAIN');

  // 5. Assert window is persistently UNCERTAIN and still bound to D1/T1
  const { data: t27WinAfterExpire } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_delivery_id, dispatch_token, dispatch_owner, dispatch_state, state')
    .eq('id', t27Win.id)
    .single();
  assert.strictEqual(t27WinAfterExpire?.dispatch_delivery_id, t27DelId1, 'Window must remain bound to D1');
  assert.strictEqual(t27WinAfterExpire?.dispatch_token, t27Token1, 'Window must retain dispatch token T1');
  assert.strictEqual(t27WinAfterExpire?.dispatch_owner, 'SALE');
  assert.strictEqual(t27WinAfterExpire?.dispatch_state, 'UNCERTAIN', 'Window dispatch_state must be persistently UNCERTAIN');
  assert.strictEqual(t27WinAfterExpire?.state, 'OPEN');

  // 6. Test NULL claim token is rejected (no NULL reconciliation bypass credential)
  await expectRpcError(
    'zalo_record_outbound_provider_result',
    {
      p_delivery_id: t27DelId1,
      p_claim_token: null,
      p_outcome: 'ACCEPTED',
      p_provider_msg_id: `zalo_mid_null_bypass_${RUN_ID}`,
    },
    'ZALO_CLAIM_TOKEN_MANDATORY'
  );

  // 7. Test mismatched claim token is rejected
  await expectRpcError(
    'zalo_record_outbound_provider_result',
    {
      p_delivery_id: t27DelId1,
      p_claim_token: crypto.randomUUID(),
      p_outcome: 'ACCEPTED',
      p_provider_msg_id: `zalo_mid_wrong_token_${RUN_ID}`,
    },
    'ZALO_OUTBOUND_CLAIM_TOKEN_MISMATCH'
  );

  // 8. Simulate a late authoritative ACCEPTED from the ORIGINAL provider call using T1
  const t27Mid = `zalo_mid_late_accepted_${RUN_ID}`;
  const { data: t27ReconResult } = await admin.rpc('zalo_record_outbound_provider_result' as never, {
    p_delivery_id: t27DelId1,
    p_claim_token: t27Token1,
    p_outcome: 'ACCEPTED',
    p_provider_msg_id: t27Mid,
  } as never);
  assert.strictEqual(t27ReconResult, 'PROVIDER_SENT_PENDING_FINALIZE', 'Late authoritative ACCEPTED must succeed and transition to PROVIDER_SENT_PENDING_FINALIZE');

  // Delivery is now PROVIDER_SENT_PENDING_FINALIZE; window is PROVIDER_ACCEPTED
  const { data: t27DelPending } = await admin
    .from('zalo_outbound_deliveries')
    .select('status, provider_msg_id')
    .eq('id', t27DelId1)
    .single();
  assert.strictEqual(t27DelPending?.status, 'PROVIDER_SENT_PENDING_FINALIZE');
  assert.strictEqual(t27DelPending?.provider_msg_id, t27Mid);

  const { data: t27WinPending } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_state, dispatch_owner, state')
    .eq('id', t27Win.id)
    .single();
  assert.strictEqual(t27WinPending?.dispatch_state, 'PROVIDER_ACCEPTED');
  assert.strictEqual(t27WinPending?.state, 'OPEN');

  // 9. Verify provider-accepted irreversibility: contradictory REJECTED or UNCERTAIN fail closed
  await expectRpcError(
    'zalo_record_outbound_provider_result',
    {
      p_delivery_id: t27DelId1,
      p_claim_token: t27Token1,
      p_outcome: 'REJECTED',
    },
    'ZALO_OUTCOME_IRREVERSIBLE'
  );
  await expectRpcError(
    'zalo_record_outbound_provider_result',
    {
      p_delivery_id: t27DelId1,
      p_claim_token: t27Token1,
      p_outcome: 'UNCERTAIN',
    },
    'ZALO_OUTCOME_IRREVERSIBLE'
  );

  // 10. Finalize D1
  await admin.rpc('zalo_finalize_outbound_delivery' as never, { p_delivery_id: t27DelId1 } as never);

  // Finalized delivery has status SENT, claim_token cleared (cleared ONLY on finalization)
  const { data: t27DelFinal } = await admin
    .from('zalo_outbound_deliveries')
    .select('status, claim_token, interaction_id')
    .eq('id', t27DelId1)
    .single();
  assert.strictEqual(t27DelFinal?.status, 'SENT');
  assert.strictEqual(t27DelFinal?.claim_token, null, 'claim_token cleared only on finalization');
  assert.ok(t27DelFinal?.interaction_id, 'Outbound interaction created');

  // Window state = SALE_RESPONDED
  const { data: t27WinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state')
    .eq('id', t27Win.id)
    .single();
  assert.strictEqual(t27WinFinal?.state, 'SALE_RESPONDED');

  // Outbound interaction count for conversation is exactly 1
  const { count: t27InteractionCount } = await admin
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', t27ConvoId)
    .eq('direction', 'OUTBOUND');
  assert.strictEqual(t27InteractionCount, 1, 'Exactly one OUTBOUND interaction created');

  // 11. Also test late authoritative definitive REJECTED from original token after PROVIDER_UNCERTAIN
  const t27RejConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t27RejConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t27_rej_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t27RejTriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t27RejTriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t27RejConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo test late rejected',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
  });
  const t27RejWin = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t27RejConvoId,
    triggerInteractionId: t27RejTriggerId,
  });

  const t27CmdRej = `zalo-recon-rej-${RUN_ID}`;
  const { data: t27ClaimRej } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t27RejConvoId,
    p_command_id: t27CmdRej,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'C1 rejection send',
    p_sanitized_content: 'C1 rejection send',
    p_content_sha256: crypto.createHash('sha256').update('C1 rejection send').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  const t27DelIdRej = (t27ClaimRej as any)?.[0]?.delivery_id;
  const t27TokenRej = (t27ClaimRej as any)?.[0]?.claim_token;

  expireZaloDeliveryLeaseDirectSql(t27DelIdRej);

  // Transition to PROVIDER_UNCERTAIN via same-command inspection
  await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t27RejConvoId,
    p_command_id: t27CmdRej,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'C1 rejection send',
    p_sanitized_content: 'C1 rejection send',
    p_content_sha256: crypto.createHash('sha256').update('C1 rejection send').digest('hex'),
    p_oa_id: t4OaId,
  } as never);

  // Late authoritative REJECTED using original token T_rej
  const { data: t27LateRejResult } = await admin.rpc('zalo_record_outbound_provider_result' as never, {
    p_delivery_id: t27DelIdRej,
    p_claim_token: t27TokenRej,
    p_outcome: 'REJECTED',
    p_error_code: 'ZALO_ERR_USER_BLOCKED',
    p_error_message: 'User blocked OA messages',
  } as never);
  assert.strictEqual(t27LateRejResult, 'FAILED');

  const { data: t27DelAfterRej } = await admin
    .from('zalo_outbound_deliveries')
    .select('status, claim_token, error_code')
    .eq('id', t27DelIdRej)
    .single();
  assert.strictEqual(t27DelAfterRej?.status, 'FAILED');
  assert.strictEqual(t27DelAfterRej?.claim_token, null, 'claim_token cleared on definitive FAILED');
  assert.strictEqual(t27DelAfterRej?.error_code, 'ZALO_ERR_USER_BLOCKED');

  const { data: t27WinAfterRej } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_owner, dispatch_state, dispatch_token, dispatch_delivery_id, state')
    .eq('id', t27RejWin.id)
    .single();
  assert.strictEqual(t27WinAfterRej?.dispatch_owner, 'NONE');
  assert.strictEqual(t27WinAfterRej?.dispatch_state, 'IDLE');
  assert.strictEqual(t27WinAfterRej?.dispatch_token, null);
  assert.strictEqual(t27WinAfterRej?.dispatch_delivery_id, null);
  assert.strictEqual(t27WinAfterRej?.state, 'OPEN');

  pass('Preserve Zalo reconciliation authority across PROVIDER_UNCERTAIN: late ACCEPTED & REJECTED with original token, mandatory claim token, irreversible provider ACCEPTED');

  // Test 28: Stale expired Zalo delivery D1 cannot poison active Sale delivery D2 (Requirement 2)
  const t28ConvoId = crypto.randomUUID();
  await admin.from('conversations').insert({
    id: t28ConvoId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'ZALO',
    external_conversation_id: `zalo_user_t28_${RUN_ID}`,
    status: 'OPEN',
    assigned_to: sale.id,
  });
  const t28TriggerId = crypto.randomUUID();
  await admin.from('interactions').insert({
    id: t28TriggerId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: t28ConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    sanitized_content: 'Zalo test stale delivery isolation',
    sanitization_status: 'SUCCEEDED',
    actor_type: 'CUSTOMER',
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
  });
  const t28Win = await openResponseSlaWindow({
    companyId: COMPANY_ID,
    conversationId: t28ConvoId,
    triggerInteractionId: t28TriggerId,
  });

  // 1. Create active Sale delivery D2 holding the OPEN SLA dispatch fence
  const t28Cmd2 = `zalo-active-d2-${RUN_ID}`;
  const { data: t28Claim2 } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t28ConvoId,
    p_command_id: t28Cmd2,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'Active D2 message',
    p_sanitized_content: 'Active D2 message',
    p_content_sha256: crypto.createHash('sha256').update('Active D2 message').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  const t28DelId2 = (t28Claim2 as any)?.[0]?.delivery_id;
  const t28Token2 = (t28Claim2 as any)?.[0]?.claim_token;
  assert.ok(t28DelId2 && t28Token2, 'D2 delivery and claim token must be minted');

  // Record exact snapshot of D2's window attributes
  const { data: t28WinSnapshot } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_delivery_id, dispatch_token, dispatch_owner, dispatch_state, dispatch_fenced_until, state')
    .eq('id', t28Win.id)
    .single();
  assert.strictEqual(t28WinSnapshot?.dispatch_delivery_id, t28DelId2);
  assert.strictEqual(t28WinSnapshot?.dispatch_token, t28Token2);
  assert.strictEqual(t28WinSnapshot?.dispatch_owner, 'SALE');
  assert.strictEqual(t28WinSnapshot?.dispatch_state, 'DISPATCHING');
  assert.strictEqual(t28WinSnapshot?.state, 'OPEN');

  // 2. Seed an older D1 on the same conversation in expired SENDING state
  const t28Cmd1 = `zalo-stale-d1-${RUN_ID}`;
  const t28DelId1 = crypto.randomUUID();
  const t28Token1 = crypto.randomUUID();
  await admin.from('zalo_outbound_deliveries').insert({
    id: t28DelId1,
    company_id: COMPANY_ID,
    conversation_id: t28ConvoId,
    customer_id: CUSTOMER_ID,
    recipient_zalo_uid: `zalo_user_t28_${RUN_ID}`,
    idempotency_key: `zalo_out:${COMPANY_ID}:${t28Cmd1}`,
    content: 'Stale D1 message',
    status: 'SENDING',
    attempts: 1,
    command_id: t28Cmd1,
    channel: 'ZALO',
    lease_until: new Date(Date.now() - 15 * 60000).toISOString(), // expired
    oa_id: t4OaId,
    actor_type: 'SALE',
    actor_user_id: sale.id,
    claim_token: t28Token1,
    content_sha256: crypto.createHash('sha256').update('Stale D1 message').digest('hex'),
  });

  // 3. Invoke same-command claim/recovery for D1
  const { data: t28ClaimD1 } = await admin.rpc('zalo_claim_outbound_delivery' as never, {
    p_company_id: COMPANY_ID,
    p_conversation_id: t28ConvoId,
    p_command_id: t28Cmd1,
    p_actor_type: 'SALE',
    p_actor_user_id: sale.id,
    p_raw_content: 'Stale D1 message',
    p_sanitized_content: 'Stale D1 message',
    p_content_sha256: crypto.createHash('sha256').update('Stale D1 message').digest('hex'),
    p_oa_id: t4OaId,
  } as never);
  assert.strictEqual((t28ClaimD1 as any)?.[0]?.claim_status, 'UNCERTAIN');

  // D1 is now PROVIDER_UNCERTAIN
  const { data: t28Del1After } = await admin
    .from('zalo_outbound_deliveries')
    .select('status, error_code')
    .eq('id', t28DelId1)
    .single();
  assert.strictEqual(t28Del1After?.status, 'PROVIDER_UNCERTAIN');
  assert.strictEqual(t28Del1After?.error_code, 'LEASE_EXPIRED');

  // 4. Assert D2's window attributes remain byte-for-byte unchanged!
  const { data: t28WinAfterD1 } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_delivery_id, dispatch_token, dispatch_owner, dispatch_state, dispatch_fenced_until, state')
    .eq('id', t28Win.id)
    .single();
  assert.strictEqual(t28WinAfterD1?.dispatch_delivery_id, t28WinSnapshot?.dispatch_delivery_id, 'dispatch_delivery_id must stay D2');
  assert.strictEqual(t28WinAfterD1?.dispatch_token, t28WinSnapshot?.dispatch_token, 'dispatch_token must stay T2');
  assert.strictEqual(t28WinAfterD1?.dispatch_owner, t28WinSnapshot?.dispatch_owner, 'dispatch_owner must stay SALE');
  assert.strictEqual(t28WinAfterD1?.dispatch_state, t28WinSnapshot?.dispatch_state, 'dispatch_state must stay DISPATCHING (not poisoned to UNCERTAIN!)');
  assert.strictEqual(t28WinAfterD1?.dispatch_fenced_until, t28WinSnapshot?.dispatch_fenced_until, 'dispatch_fenced_until must remain byte-for-byte unchanged');
  assert.strictEqual(t28WinAfterD1?.state, t28WinSnapshot?.state);

  // 5. AI provider calls remain 0 while D2 is in flight
  let t28AiCalls = 0;
  const t28AiResult = await executeAiResponseRuntime({
    companyId: COMPANY_ID,
    windowId: t28Win.id,
    conversationId: t28ConvoId,
    customerId: CUSTOMER_ID,
    model: new CompliantModel(),
    providerSender: async () => {
      t28AiCalls++;
      return { status: 'SENT', externalMessageId: 'ai_should_not_run' };
    },
    client: admin,
  });
  assert.strictEqual(t28AiCalls, 0, 'AI provider invocation count MUST remain 0 while D2 is in flight');
  assert.strictEqual(t28AiResult.success, false);

  // 6. Finish D2 normally
  const t28Mid2 = `zalo_mid_d2_active_${RUN_ID}`;
  await admin.rpc('zalo_record_outbound_provider_result' as never, {
    p_delivery_id: t28DelId2,
    p_claim_token: t28Token2,
    p_outcome: 'ACCEPTED',
    p_provider_msg_id: t28Mid2,
  } as never);
  await admin.rpc('zalo_finalize_outbound_delivery' as never, { p_delivery_id: t28DelId2 } as never);

  // 7. SLA resolves only from D2
  const { data: t28WinFinal } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state, dispatch_owner, sale_response_interaction_id')
    .eq('id', t28Win.id)
    .single();
  assert.strictEqual(t28WinFinal?.state, 'SALE_RESPONDED');
  assert.strictEqual(t28WinFinal?.dispatch_state, 'PROVIDER_ACCEPTED');
  assert.strictEqual(t28WinFinal?.dispatch_owner, 'SALE');
  assert.ok(t28WinFinal?.sale_response_interaction_id, 'SLA window resolved with D2 interaction ID');

  pass('Stale expired Zalo delivery D1 cannot poison active Sale delivery D2 (exact ownership isolation)');

  // Helper to execute canonical Facebook Care send path enforcing han_prepare_send -> providerSender -> han_finish_send
  async function executeCareFacebookSend({
    companyId,
    conversationId,
    actorId,
    content,
    careDeliveryId,
    requestId = crypto.randomUUID(),
    providerSender,
  }: {
    companyId: string;
    conversationId: string;
    actorId: string;
    content: string;
    careDeliveryId: string;
    requestId?: string;
    providerSender: () => Promise<{ status: 'SENT' | 'FAILED' | 'UNKNOWN'; mid: string | null }>;
  }) {
    // 1. Pre-provider DB guard & dispatch claim
    const { data: prepData, error: prepErr } = await admin.rpc('han_prepare_send' as never, {
      p_company: companyId,
      p_conversation: conversationId,
      p_actor: actorId,
      p_request: requestId,
      p_content: content,
      p_safe: content,
      p_safe_status: 'SUCCEEDED',
      p_delivery: careDeliveryId,
    } as never);

    if (prepErr) {
      throw new Error(`han_prepare_send failed: ${prepErr.message}`);
    }

    const prep = prepData as any;
    if (!prep?.claimed) {
      return { success: false, status: prep?.status, claimed: false, requestId, prep };
    }

    // 2. Real provider invocation tracked by caller's counter
    const provRes = await providerSender();

    // 3. Post-provider resolution
    const { error: finishErr } = await admin.rpc('han_finish_send' as never, {
      p_company: companyId,
      p_request: requestId,
      p_status: provRes.status,
      p_mid: provRes.mid,
    } as never);

    if (finishErr) {
      throw new Error(`han_finish_send failed: ${finishErr.message}`);
    }

    return {
      success: provRes.status === 'SENT',
      status: provRes.status,
      requestId,
      mid: provRes.mid,
      prep,
    };
  }

  // ============================================================================
  // Test 29: Facebook Care Delivery SENT Durability & Receipt Reconciliation
  // (P1-006: Schema-Compatible Reconcile, Provider-Count Invariants, & UNKNOWN Fail-Safe)
  // ============================================================================
  const t29CampaignId = crypto.randomUUID();
  await admin.from('care_campaigns').insert({
    id: t29CampaignId,
    company_id: COMPANY_ID,
    channel: 'FACEBOOK',
    audience_rule: { filter: 'test' },
    message_template: 'Hello care message',
    started_at: new Date().toISOString(),
  });

  // ----------------------------------------------------------------------------
  // Scenario 1: Real Care + SENT with NO receipts (Prompt Section 3 & 7)
  // ----------------------------------------------------------------------------
  const t29CareDelId1 = crypto.randomUUID();
  await admin.from('care_deliveries').insert({
    id: t29CareDelId1,
    company_id: COMPANY_ID,
    campaign_id: t29CampaignId,
    customer_id: CUSTOMER_ID,
    idempotency_key: `care_del_sent_${RUN_ID}`,
    channel: 'FACEBOOK',
    status: 'PENDING',
  });

  const t29Convo1 = await createDueSlaWindow('care_sent');
  const t29SentMid = `mid_fb_care_sent_${RUN_ID}`;
  let t29CareSentCalls = 0;

  const t29SentResult = await executeCareFacebookSend({
    companyId: COMPANY_ID,
    conversationId: t29Convo1.convoId,
    actorId: sale.id,
    content: 'Care message content sent',
    careDeliveryId: t29CareDelId1,
    providerSender: async () => {
      t29CareSentCalls++;
      return { status: 'SENT', mid: t29SentMid };
    },
  });

  assert.strictEqual(t29SentResult.success, true);
  assert.strictEqual(t29CareSentCalls, 1, 'Provider invocation count must be exactly 1 for SENT');

  // Assert outbox, interaction, SLA window, and care_deliveries statuses
  const outboxRowsSent = queryRawJson<Array<{ status: string; provider_mid: string; care_delivery_id: string; interaction_id: string }>>(`
    SELECT status, provider_mid, care_delivery_id, interaction_id FROM private.han_outbox WHERE request_id = '${t29SentResult.requestId}';
  `);
  assert.strictEqual(outboxRowsSent.length, 1);
  assert.strictEqual(outboxRowsSent[0].status, 'SENT', 'private.han_outbox.status = SENT');
  assert.strictEqual(outboxRowsSent[0].provider_mid, t29SentMid, 'provider_mid = MID');
  assert.strictEqual(outboxRowsSent[0].care_delivery_id, t29CareDelId1);

  const { data: intSent } = await admin
    .from('interactions')
    .select('external_ref')
    .eq('id', outboxRowsSent[0].interaction_id)
    .single();
  assert.ok(intSent?.external_ref?.includes(t29SentMid), `interaction external_ref must contain MID (got: ${intSent?.external_ref})`);

  const { data: winSent } = await bossRealClient
    .from('response_sla_windows')
    .select('state, dispatch_state, dispatch_owner, sale_response_interaction_id')
    .eq('id', t29Convo1.windowId)
    .single();
  assert.strictEqual(winSent?.state, 'SALE_RESPONDED', 'SLA state = SALE_RESPONDED');
  assert.strictEqual(winSent?.dispatch_state, 'PROVIDER_ACCEPTED', 'dispatch_state = PROVIDER_ACCEPTED');
  assert.strictEqual(winSent?.dispatch_owner, 'SALE');
  assert.strictEqual(winSent?.sale_response_interaction_id, outboxRowsSent[0].interaction_id);

  const { data: careDel1After } = await admin
    .from('care_deliveries')
    .select('status, sent_at, external_message_ref')
    .eq('id', t29CareDelId1)
    .single();
  assert.strictEqual(careDel1After?.status, 'SENT', 'care_deliveries.status = SENT when no receipt exists');
  assert.ok(careDel1After?.sent_at !== null, 'sent_at IS NOT NULL');
  assert.strictEqual(careDel1After?.external_message_ref, t29SentMid, 'external_message_ref = MID');

  pass('Facebook care delivery SENT: outbox SENT, provider MID recorded, SLA SALE_RESPONDED, care SENT (provider count 1)');

  // ----------------------------------------------------------------------------
  // Scenario 2: Pre-existing DELIVERY receipt reconciliation (Prompt Section 4 & 7)
  // ----------------------------------------------------------------------------
  const t29CareDelId2 = crypto.randomUUID();
  await admin.from('care_deliveries').insert({
    id: t29CareDelId2,
    company_id: COMPANY_ID,
    campaign_id: t29CampaignId,
    customer_id: CUSTOMER_ID,
    idempotency_key: `care_del_delivery_${RUN_ID}`,
    channel: 'FACEBOOK',
    status: 'PENDING',
  });

  const t29Convo2 = await createDueSlaWindow('care_delivery_rcpt');
  const t29DelivMid = `mid_fb_care_deliv_${RUN_ID}`;
  let t29CareDelivCalls = 0;

  // Pre-seed matching private.han_receipts row: kind = DELIVERY, mids contains MID
  insertHanReceiptDirectSql({
    company_id: COMPANY_ID,
    external_identity: t29Convo2.externalConversationId,
    event_key: `evt_deliv_${RUN_ID}`,
    kind: 'DELIVERY',
    mids: [t29DelivMid],
  });

  const t29DelivResult = await executeCareFacebookSend({
    companyId: COMPANY_ID,
    conversationId: t29Convo2.convoId,
    actorId: sale.id,
    content: 'Care message content delivery receipt',
    careDeliveryId: t29CareDelId2,
    providerSender: async () => {
      t29CareDelivCalls++;
      return { status: 'SENT', mid: t29DelivMid };
    },
  });

  assert.strictEqual(t29DelivResult.success, true);
  assert.strictEqual(t29CareDelivCalls, 1, 'Provider invocation count must be exactly 1 for DELIVERY-reconciled');

  const { data: careDel2After } = await admin
    .from('care_deliveries')
    .select('status, delivered_at, external_message_ref')
    .eq('id', t29CareDelId2)
    .single();
  assert.strictEqual(careDel2After?.status, 'DELIVERED', 'care_deliveries.status = DELIVERED with pre-existing receipt');
  assert.ok(careDel2After?.delivered_at !== null, 'delivered_at IS NOT NULL');
  assert.strictEqual(careDel2After?.external_message_ref, t29DelivMid);

  pass('Facebook care delivery: pre-existing DELIVERY receipt reconciles care_deliveries to DELIVERED with delivered_at');

  // ----------------------------------------------------------------------------
  // Scenario 3: Pre-existing READ receipt reconciliation using REAL schema (Prompt Section 5 & 7)
  // ----------------------------------------------------------------------------
  const t29CareDelId3 = crypto.randomUUID();
  await admin.from('care_deliveries').insert({
    id: t29CareDelId3,
    company_id: COMPANY_ID,
    campaign_id: t29CampaignId,
    customer_id: CUSTOMER_ID,
    idempotency_key: `care_del_read_${RUN_ID}`,
    channel: 'FACEBOOK',
    status: 'PENDING',
  });

  const t29Convo3 = await createDueSlaWindow('care_read_rcpt');
  const t29ReadMid = `mid_fb_care_read_${RUN_ID}`;
  let t29CareReadCalls = 0;

  // Pre-seed matching private.han_receipts row: kind = READ, watermark >= outbound request timestamp in ms
  // Using REAL table contract (mids text[], watermark bigint) without nonexistent read_watermarks column
  const t29ReadWatermark = Date.now() + 60000;
  insertHanReceiptDirectSql({
    company_id: COMPANY_ID,
    external_identity: t29Convo3.externalConversationId,
    event_key: `evt_read_${RUN_ID}`,
    kind: 'READ',
    mids: [],
    watermark: t29ReadWatermark,
  });

  const t29ReadResult = await executeCareFacebookSend({
    companyId: COMPANY_ID,
    conversationId: t29Convo3.convoId,
    actorId: sale.id,
    content: 'Care message content read receipt',
    careDeliveryId: t29CareDelId3,
    providerSender: async () => {
      t29CareReadCalls++;
      return { status: 'SENT', mid: t29ReadMid };
    },
  });

  assert.strictEqual(t29ReadResult.success, true);
  assert.strictEqual(t29CareReadCalls, 1, 'Provider invocation count must be exactly 1 for READ-reconciled');

  const { data: careDel3After } = await admin
    .from('care_deliveries')
    .select('status, delivered_at, external_message_ref')
    .eq('id', t29CareDelId3)
    .single();
  assert.strictEqual(careDel3After?.status, 'READ', 'care_deliveries.status = READ with pre-existing read receipt');
  assert.ok(careDel3After?.delivered_at !== null, 'delivered_at IS NOT NULL');
  assert.strictEqual(careDel3After?.external_message_ref, t29ReadMid);

  pass('Facebook care delivery: pre-existing READ receipt reconciles care_deliveries to READ with delivered_at (real watermark schema)');

  // ----------------------------------------------------------------------------
  // Scenario 4: Facebook Care UNKNOWN maps to UNCERTAIN (never FAILED) (Prompt Section 6 & 7)
  // ----------------------------------------------------------------------------
  const t29CareDelId4 = crypto.randomUUID();
  await admin.from('care_deliveries').insert({
    id: t29CareDelId4,
    company_id: COMPANY_ID,
    campaign_id: t29CampaignId,
    customer_id: CUSTOMER_ID,
    idempotency_key: `care_del_unknown_${RUN_ID}`,
    channel: 'FACEBOOK',
    status: 'PENDING',
  });

  const t29Convo4 = await createDueSlaWindow('care_unknown');
  const t29UnknownMid = `mid_fb_unknown_${RUN_ID}`;
  let t29CareUnknownCalls = 0;

  const t29UnknownResult = await executeCareFacebookSend({
    companyId: COMPANY_ID,
    conversationId: t29Convo4.convoId,
    actorId: sale.id,
    content: 'Care message content unknown',
    careDeliveryId: t29CareDelId4,
    providerSender: async () => {
      t29CareUnknownCalls++;
      return { status: 'UNKNOWN', mid: t29UnknownMid };
    },
  });

  assert.strictEqual(t29UnknownResult.success, false);
  assert.strictEqual(t29CareUnknownCalls, 1, 'Provider invocation count must be exactly 1 after UNKNOWN');

  const outboxRowsUnknown = queryRawJson<Array<{ status: string; provider_mid: string; care_delivery_id: string }>>(`
    SELECT status, provider_mid, care_delivery_id FROM private.han_outbox WHERE request_id = '${t29UnknownResult.requestId}';
  `);
  assert.strictEqual(outboxRowsUnknown.length, 1);
  assert.strictEqual(outboxRowsUnknown[0].status, 'UNKNOWN');
  assert.strictEqual(outboxRowsUnknown[0].provider_mid, t29UnknownMid);
  assert.strictEqual(outboxRowsUnknown[0].care_delivery_id, t29CareDelId4);

  const { data: winUnknown } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_state, state')
    .eq('id', t29Convo4.windowId)
    .single();
  assert.strictEqual(winUnknown?.dispatch_state, 'UNCERTAIN');
  assert.strictEqual(winUnknown?.state, 'OPEN');

  const { data: careDel4After } = await admin
    .from('care_deliveries')
    .select('status, external_message_ref')
    .eq('id', t29CareDelId4)
    .single();
  assert.strictEqual(careDel4After?.status, 'UNCERTAIN', 'care_deliveries status MUST BE UNCERTAIN (NEVER FAILED!)');
  assert.strictEqual(careDel4After?.external_message_ref, t29UnknownMid);

  pass('Facebook care deliveries: UNKNOWN maps to UNCERTAIN (never FAILED) with real provider invocation count 1');

  // ----------------------------------------------------------------------------
  // Scenario 5: Facebook Care definitive rejection maps to FAILED (Prompt Section 6 & 7)
  // ----------------------------------------------------------------------------
  const t29CareDelId5 = crypto.randomUUID();
  await admin.from('care_deliveries').insert({
    id: t29CareDelId5,
    company_id: COMPANY_ID,
    campaign_id: t29CampaignId,
    customer_id: CUSTOMER_ID,
    idempotency_key: `care_del_failed_${RUN_ID}`,
    channel: 'FACEBOOK',
    status: 'PENDING',
  });

  const t29Convo5 = await createDueSlaWindow('care_failed');
  let t29CareFailedCalls = 0;

  const t29FailedResult = await executeCareFacebookSend({
    companyId: COMPANY_ID,
    conversationId: t29Convo5.convoId,
    actorId: sale.id,
    content: 'Care message content failed',
    careDeliveryId: t29CareDelId5,
    providerSender: async () => {
      t29CareFailedCalls++;
      return { status: 'FAILED', mid: null };
    },
  });

  assert.strictEqual(t29FailedResult.success, false);
  assert.strictEqual(t29CareFailedCalls, 1, 'Provider invocation count must be exactly 1 after FAILED');

  const outboxRowsFailed = queryRawJson<Array<{ status: string }>>(`
    SELECT status FROM private.han_outbox WHERE request_id = '${t29FailedResult.requestId}';
  `);
  assert.strictEqual(outboxRowsFailed.length, 1);
  assert.strictEqual(outboxRowsFailed[0].status, 'FAILED');

  const { data: winFailed } = await bossRealClient
    .from('response_sla_windows')
    .select('dispatch_state, dispatch_owner, state')
    .eq('id', t29Convo5.windowId)
    .single();
  assert.strictEqual(winFailed?.dispatch_state, 'FAILED');
  assert.strictEqual(winFailed?.dispatch_owner, 'NONE');
  assert.strictEqual(winFailed?.state, 'OPEN');

  const { data: careDel5After } = await admin
    .from('care_deliveries')
    .select('status')
    .eq('id', t29CareDelId5)
    .single();
  assert.strictEqual(careDel5After?.status, 'FAILED', 'Definitive rejection transitions care_deliveries to FAILED');

  pass('Facebook care deliveries: definitive rejection maps to FAILED with real provider invocation count 1');

  console.log('\n================================================================');
  console.log(`ALL ${testCount} ROUND 3 PRODUCT WIRING & REAL RUNTIME TESTS PASSED!`);
  console.log('================================================================\n');
  } finally {
    for (const uid of createdUserIds) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch {}
    }
  }
}

run().catch((err) => {
  console.error('\n[FATAL] Test failed:', err);
  process.exit(1);
});
