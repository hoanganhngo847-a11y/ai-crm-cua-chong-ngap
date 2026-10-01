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
  scheduleInstallation,
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
import { processDueResponseSlaWindows } from '../../features/automation/response-sla/services/sla-automation-worker';
import { openResponseSlaWindow } from '../../features/automation/response-sla/services/response-sla-store';
import { buildRuntimeSalesStyleContext } from '../../features/sales-style/services/runtime-style-context';

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
  let duplicateErr: any = null;
  try {
    await createOrderFromCalculation(
      {
        companyId: COMPANY_ID,
        customerId: CUSTOMER_ID,
        priceCalculationId: validCalc.id,
      },
      saleClient
    );
  } catch (err: any) {
    duplicateErr = err;
  }
  assert.ok(duplicateErr, 'Duplicate order creation on same calculation must be rejected');
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
  // Schedule installation appointment for tech
  const APPOINTMENT_ID = crypto.randomUUID();
  await admin.from('appointments').insert({
    id: APPOINTMENT_ID,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    type: 'INSTALLATION',
    start_time: new Date(Date.now() + 86400000).toISOString(),
    assignee_id: tech.id,
    address: '123 Đường Bờ Sông, Q.8, TP.HCM',
    status: 'ACCEPTED',
  });

  const installDto = await scheduleInstallation(
    COMPANY_ID,
    {
      customerId: CUSTOMER_ID,
      orderId: ORDER_ID,
      appointmentId: APPOINTMENT_ID,
      crew: ['Nguyễn Văn Thợ 1', 'Trần Văn Thợ 2'],
    },
    admin,
    boss.id
  );
  const INSTALLATION_ID = installDto.id;

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

  const otherApptId = crypto.randomUUID();
  await admin.from('appointments').insert({
    id: otherApptId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    type: 'INSTALLATION',
    start_time: new Date(Date.now() + 86400000).toISOString(),
    assignee_id: otherTech.id,
    address: '789 Đường Thợ Khác, Q.7, TP.HCM',
    status: 'ACCEPTED',
  });
  const otherInstallDto = await scheduleInstallation(
    COMPANY_ID,
    {
      customerId: CUSTOMER_ID,
      orderId: otherOrderId,
      appointmentId: otherApptId,
      crew: ['Thợ Khác 1'],
    },
    admin,
    boss.id
  );

  const techWorkspace = await getTechnicianFieldWorkspaceData(COMPANY_ID, tech.id, 'TECHNICIAN', admin);
  assert.strictEqual(techWorkspace.installations.length, 1, 'Assigned technician sees current installation');
  assert.strictEqual(techWorkspace.installations[0].id, INSTALLATION_ID);
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
  assert.ok(
    !otherTechWorkspace.installations.some((i) => i.id === INSTALLATION_ID),
    'Other technician does NOT see first technician installation'
  );
  pass('Technician workspace filters strictly by current assignment (active work only, zero cross-technician leak)');

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
  pass('Handover completion validates verified evidence and transitions order to COMPLETED');

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
    await admin.from('conversations').insert({
      id: convoId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      external_conversation_id: `page_test_${RUN_ID}:psid_${testSuffix}`,
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
    return { convoId, triggerIntId, windowId: win.id };
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
    await executeAiResponseRuntime({
      companyId: COMPANY_ID,
      windowId: win1.windowId,
      model: new ProhibitedCommitmentModel(),
      client: admin,
    });
  } catch (err: unknown) {
    if (err instanceof PolicyFirewallViolationError) {
      firewallViolationCaught = true;
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
  assert.strictEqual(windowAfterWorker!.state, 'AI_RESPONDED', 'Production worker resolves due window to AI_RESPONDED');
  pass('Production automation worker processes overdue SLA windows end-to-end');

  console.log('\n================================================================');
  console.log(`ALL ${testCount} ROUND 3 PRODUCT WIRING & REAL RUNTIME TESTS PASSED!`);
  console.log('================================================================\n');
}

run().catch((err) => {
  console.error('\n[FATAL] Test failed:', err);
  process.exit(1);
});
