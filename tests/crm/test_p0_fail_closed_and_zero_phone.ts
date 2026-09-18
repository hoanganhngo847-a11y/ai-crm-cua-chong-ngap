import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { CustomerService } from '../../features/crm/services/customer.service';
import { CUSTOMER_STAGES, STAGE_ACTOR_TYPES } from '../../features/crm/types/customer.types';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import { GET as getCustomersHandler, POST as postCustomersHandler } from '../../app/api/customers/route';
import { PATCH as stagePatchHandler } from '../../app/api/customers/[id]/stage/route';

async function runFailClosedAndZeroPhoneTests() {
  console.log('======================================================================');
  console.log('STARTING P0 TEST SUITE: ZERO PRIVATE SCHEMA QUERY, ZERO-PHONE & FAIL-CLOSED AUDIT');
  console.log('======================================================================');

  process.env.PHONE_HASH_SECRET = process.env.PHONE_HASH_SECRET || 'ai-crm-phone-hmac-secret-v1';
  process.env.NEXT_PUBLIC_DEMO_MODE = 'true';

  const companyA = '11111111-1111-1111-1111-111111111111';
  const bossUserId = 'user-boss-001';
  const saleUserId = 'user-sale-001';

  // ============================================================================
  // TEST SECTION 1: STATIC CODE AUDIT (VERIFY ZERO DIRECT PRIVATE SCHEMA QUERIES)
  // ============================================================================
  console.log('\n--- Test 1: Static Code Inspection: Zero Direct .from("customer_private_contacts") in CRM ---');
  const crmServicePath = path.resolve('features/crm/services/customer.service.ts');
  const stageRoutePath = path.resolve('app/api/customers/[id]/stage/route.ts');
  const customersRoutePath = path.resolve('app/api/customers/route.ts');
  const customerDetailPagePath = path.resolve('app/(dashboard)/customers/[id]/page.tsx');

  const crmServiceCode = fs.readFileSync(crmServicePath, 'utf8');
  const stageRouteCode = fs.readFileSync(stageRoutePath, 'utf8');
  const customersRouteCode = fs.readFileSync(customersRoutePath, 'utf8');
  const customerDetailPageCode = fs.readFileSync(customerDetailPagePath, 'utf8');

  assert(
    !crmServiceCode.includes(".from('customer_private_contacts')"),
    'features/crm/services/customer.service.ts must NOT contain .from(\'customer_private_contacts\')'
  );
  assert(
    !stageRouteCode.includes(".from('customer_private_contacts')"),
    'app/api/customers/[id]/stage/route.ts must NOT contain .from(\'customer_private_contacts\')'
  );
  assert(
    !customersRouteCode.includes(".from('customer_private_contacts')"),
    'app/api/customers/route.ts must NOT contain .from(\'customer_private_contacts\')'
  );
  assert(
    !customerDetailPageCode.includes(".from('customer_private_contacts')"),
    'app/(dashboard)/customers/[id]/page.tsx must NOT contain .from(\'customer_private_contacts\')'
  );
  console.log('✓ PASS: All CRM services and routes contain ZERO direct queries to private.customer_private_contacts!');

  // ============================================================================
  // TEST SECTION 2: ZERO-PHONE SANITIZATION FOR SALE
  // ============================================================================
  console.log('\n--- Test 2: Zero-Phone Protection for Role SALE ---');
  const dummyCustomer = {
    id: 'cust-101',
    company_id: companyA,
    customer_code: 'KH-000101',
    name: 'Khách hàng A',
    source: 'FACEBOOK' as const,
    stage: CUSTOMER_STAGES.LEAD_NEW,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // 2a. With raw phone in contact bundle, SALE must receive masked phone
  const sanitizedForSaleWithRaw = CustomerService.sanitizeForRole(
    {
      customer: dummyCustomer,
      contact: { raw_phone: '0912345678', normalized_phone: '+84912345678' },
    },
    APPLICATION_ROLES.SALE
  );
  assert.strictEqual(sanitizedForSaleWithRaw.is_phone_masked, true, 'is_phone_masked must be true for SALE');
  assert.strictEqual(sanitizedForSaleWithRaw.phone, '09******78', 'Phone must be masked as 09******78 for SALE');
  assert(!JSON.stringify(sanitizedForSaleWithRaw).includes('0912345678'), 'Raw phone must never appear in SALE payload');

  // 2b. With contact = null, SALE receives masked phone from metadata or undefined
  const customerWithMeta = {
    ...dummyCustomer,
    metadata: { masked_phone: '09******88' },
  };
  const sanitizedForSaleNoContact = CustomerService.sanitizeForRole(
    {
      customer: customerWithMeta,
      contact: null,
    },
    APPLICATION_ROLES.SALE
  );
  assert.strictEqual(sanitizedForSaleNoContact.is_phone_masked, true);
  assert.strictEqual(sanitizedForSaleNoContact.phone, '09******88');

  // 2c. BOSS_ADMIN receives unmasked raw phone
  const sanitizedForBoss = CustomerService.sanitizeForRole(
    {
      customer: dummyCustomer,
      contact: { raw_phone: '0912345678', normalized_phone: '+84912345678' },
    },
    APPLICATION_ROLES.BOSS_ADMIN
  );
  assert.strictEqual(sanitizedForBoss.is_phone_masked, false, 'is_phone_masked must be false for BOSS_ADMIN');
  assert.strictEqual(sanitizedForBoss.phone, '0912345678', 'BOSS_ADMIN receives unmasked raw phone');
  console.log('✓ PASS: Zero-Phone sanitization strictly enforced for SALE (always masked, never raw)!');

  // ============================================================================
  // TEST SECTION 3: GET /api/customers - FAIL-CLOSED AUDIT FOR BOSS_ADMIN
  // ============================================================================
  console.log('\n--- Test 3: GET /api/customers - Fail-Closed Audit Trail ---');

  function createMockSupabaseForGet(failAudit = false) {
    return {
      from: (table: string) => {
        if (table === 'audit_logs') {
          return {
            insert: async () => {
              if (failAudit) {
                return { error: new Error('Postgres audit_logs connection failure (Simulated disk full)') };
              }
              return { error: null };
            },
          };
        }
        if (table === 'customers') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: async () => ({
                    data: [
                      {
                        id: 'cust-1',
                        company_id: companyA,
                        customer_code: 'KH-000001',
                        name: 'Anh Hoàng Nam',
                        source: 'FACEBOOK',
                        stage: 'PRICE_OFFERED',
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      },
                    ],
                    error: null,
                    count: 1,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'identities') {
          return {
            select: () => ({
              eq: () => ({
                in: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        return {};
      },
      rpc: async () => ({ data: [], error: null }),
    } as any;
  }

  // 3a. When audit succeeds for BOSS_ADMIN -> 200 OK with raw phone
  const bossActor = {
    userId: bossUserId,
    companyId: companyA,
    role: APPLICATION_ROLES.BOSS_ADMIN,
    profileStatus: 'ACTIVE' as const,
    membershipStatus: 'ACTIVE' as const,
    email: 'boss@congngap.vn',
    fullName: 'Sếp Tổng',
    memberId: 'mem-boss-001',
    aal: 'aal2' as const,
    isMfaEnrolled: true,
  };

  const reqSuccess = new NextRequest('http://localhost:3000/api/customers');
  const resSuccess = await getCustomersHandler(reqSuccess, {
    actor: bossActor,
    adminClient: createMockSupabaseForGet(false),
  });
  assert.strictEqual(resSuccess.status, 200);
  const bodySuccess = await resSuccess.json();
  assert.strictEqual(bodySuccess.success, true);
  assert.strictEqual(bodySuccess.data[0].phone, '0912345612', 'BOSS_ADMIN receives raw phone when audit succeeds');

  // 3b. When audit FAILS for BOSS_ADMIN -> HTTP 500 AUDIT_WRITE_FAILED, NO RAW PHONE
  const reqFailAudit = new NextRequest('http://localhost:3000/api/customers');
  const resFailAudit = await getCustomersHandler(reqFailAudit, {
    actor: bossActor,
    adminClient: createMockSupabaseForGet(true),
  });
  assert.strictEqual(resFailAudit.status, 500, 'Must return HTTP 500 when audit write fails');
  const bodyFailAudit = await resFailAudit.json();
  assert.strictEqual(bodyFailAudit.success, false);
  assert.strictEqual(bodyFailAudit.error, 'AUDIT_WRITE_FAILED');
  assert(!JSON.stringify(bodyFailAudit).includes('0912345612'), 'Payload must NEVER contain raw phone on audit failure');
  console.log('✓ PASS: GET /api/customers is fail-closed! Halts with 500 and zero phone exposure if audit fails.');

  // 3c. When SALE accesses GET /api/customers -> always receives masked phone, no audit fail-open risk
  const saleActor = {
    userId: saleUserId,
    companyId: companyA,
    role: APPLICATION_ROLES.SALE,
    profileStatus: 'ACTIVE' as const,
    membershipStatus: 'ACTIVE' as const,
    email: 'sale@congngap.vn',
    fullName: 'Nhân Viên Sale',
    memberId: 'mem-sale-001',
    aal: 'aal1' as const,
    isMfaEnrolled: false,
  };

  const reqSale = new NextRequest('http://localhost:3000/api/customers');
  const resSale = await getCustomersHandler(reqSale, {
    actor: saleActor,
    adminClient: createMockSupabaseForGet(false),
  });
  assert.strictEqual(resSale.status, 200);
  const bodySale = await resSale.json();
  assert.strictEqual(bodySale.success, true);
  assert.strictEqual(bodySale.data[0].is_phone_masked, true);
  assert.strictEqual(bodySale.data[0].phone, '09******12', 'SALE receives masked phone 09******12');
  console.log('✓ PASS: GET /api/customers delivers masked phone to SALE with zero phone exposure.');

  // ============================================================================
  // TEST SECTION 4: POST /api/customers - FAIL-CLOSED AUDIT FOR BOSS_ADMIN
  // ============================================================================
  console.log('\n--- Test 4: POST /api/customers - Fail-Closed Audit Trail ---');

  function createMockSupabaseForPost(failAudit = false) {
    return {
      from: (table: string) => {
        if (table === 'audit_logs') {
          return {
            insert: async () => {
              if (failAudit) {
                return { error: new Error('Postgres audit_logs deadlocked') };
              }
              return { error: null };
            },
          };
        }
        if (table === 'identities') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            insert: async () => ({ data: null, error: null }),
          };
        }
        if (table === 'customers') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: {
                    id: 'new-cust-123',
                    company_id: companyA,
                    customer_code: 'KH-999999',
                    name: 'Bác Khách Mới',
                    source: 'MANUAL',
                    stage: 'LEAD_NEW',
                    metadata: { masked_phone: '09******89' },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'customer_stage_histories') {
          return {
            insert: async () => ({ data: null, error: null }),
          };
        }
        return {};
      },
    } as any;
  }

  // 4a. When audit write fails in POST for BOSS_ADMIN -> returns 500 AUDIT_WRITE_FAILED
  const reqPostFail = new NextRequest('http://localhost:3000/api/customers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bác Khách Mới', phone: '0988776655' }),
  });
  const resPostFail = await postCustomersHandler(reqPostFail, {
    actor: bossActor,
    adminClient: createMockSupabaseForPost(true),
  });
  assert.strictEqual(resPostFail.status, 500, 'POST must return 500 when audit fails');
  const bodyPostFail = await resPostFail.json();
  assert.strictEqual(bodyPostFail.error, 'AUDIT_WRITE_FAILED');
  assert(!JSON.stringify(bodyPostFail).includes('0988776655'), 'Payload must NEVER contain raw phone on audit failure');
  console.log('✓ PASS: POST /api/customers fails closed with 500 AUDIT_WRITE_FAILED when audit insert fails!');

  // ============================================================================
  // TEST SECTION 5: PATCH /api/customers/[id]/stage - FAIL-CLOSED & ZERO-PHONE
  // ============================================================================
  console.log('\n--- Test 5: PATCH /api/customers/[id]/stage - Zero-Phone & Fail-Closed ---');

  function createMockSupabaseForPatch(failAudit = false) {
    return {
      from: (table: string) => {
        if (table === 'audit_logs') {
          return {
            insert: async () => {
              if (failAudit) {
                return { error: new Error('Simulated audit_logs error') };
              }
              return { error: null };
            },
          };
        }
        if (table === 'customers') {
          return {
            select: () => ({
              eq: (col1: string, val1: any) => ({
                eq: (col2: string, val2: any) => ({
                  maybeSingle: async () => ({
                    data: {
                      id: 'cust-101',
                      company_id: companyA,
                      customer_code: 'KH-101',
                      name: 'Nguyễn Văn A',
                      stage: CUSTOMER_STAGES.LEAD_NEW,
                      metadata: { masked_phone: '09******78' },
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: async () => ({
                      data: {
                        id: 'cust-101',
                        company_id: companyA,
                        customer_code: 'KH-101',
                        name: 'Nguyễn Văn A',
                        stage: CUSTOMER_STAGES.PRICE_OFFERED,
                        metadata: { masked_phone: '09******78' },
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'customer_stage_histories') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: {
                    id: 'hist-1',
                    company_id: companyA,
                    customer_id: 'cust-101',
                    from_stage: CUSTOMER_STAGES.LEAD_NEW,
                    to_stage: CUSTOMER_STAGES.PRICE_OFFERED,
                    actor_type: STAGE_ACTOR_TYPES.USER,
                    changed_by_user_id: saleUserId,
                    reason: 'Chuyển giai đoạn sang [PRICE_OFFERED]',
                    source_ref: null,
                    changed_at: new Date().toISOString(),
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      },
      rpc: async () => ({
        data: [{ raw_phone: '0912345678', normalized_phone: '+84912345678', is_verified: true }],
        error: null,
      }),
    } as any;
  }

  // 5a. SALE updates stage: Zero-Phone strictly enforced
  const reqStageSale = new NextRequest('http://localhost:3000/api/customers/cust-101/stage', {
    method: 'PATCH',
    body: JSON.stringify({ stage: 'PRICE_OFFERED', note: 'Báo giá hoàn tất' }),
  });
  const resStageSale = await stagePatchHandler(reqStageSale, {
    params: Promise.resolve({ id: 'cust-101' }),
    actor: saleActor,
    adminClient: createMockSupabaseForPatch(false),
  });
  assert.strictEqual(resStageSale.status, 200);
  const bodyStageSale = await resStageSale.json();
  assert.strictEqual(bodyStageSale.success, true);
  assert.strictEqual(bodyStageSale.data.is_phone_masked, true, 'is_phone_masked must be true for SALE');
  assert.strictEqual(bodyStageSale.data.phone, '09******78', 'Phone must be masked for SALE');
  assert(!JSON.stringify(bodyStageSale).includes('0912345678'), 'Raw phone must never appear in response for SALE');
  console.log('✓ PASS: PATCH /api/customers/[id]/stage enforces Zero-Phone for SALE!');

  // ============================================================================
  // TEST SECTION 6: ITEM 10 (P1) — INDEPENDENT HMAC PHONE SECRET FAIL-CLOSED
  // ============================================================================
  console.log('\n--- Test 6: Item 10 (P1) - Independent HMAC Phone Secret Fail-Closed ---');

  // 6a. Valid HMAC computed when PHONE_HASH_SECRET is set
  process.env.PHONE_HASH_SECRET = 'my-secret-key-123';
  const hmacValid = CustomerService.computePhoneHmac('+84912345678');
  assert.strictEqual(typeof hmacValid, 'string');
  assert.strictEqual(hmacValid.length, 64, 'HMAC must be 64-char sha256 hex string');

  // 6b. Throws CONFIGURATION_ERROR when PHONE_HASH_SECRET is missing or empty
  delete process.env.PHONE_HASH_SECRET;
  assert.throws(
    () => CustomerService.computePhoneHmac('+84912345678'),
    /CONFIGURATION_ERROR: Thiếu biến môi trường PHONE_HASH_SECRET bắt buộc/,
    'computePhoneHmac must throw CONFIGURATION_ERROR when PHONE_HASH_SECRET is missing'
  );

  process.env.PHONE_HASH_SECRET = '   ';
  assert.throws(
    () => CustomerService.computePhoneHmac('+84912345678'),
    /CONFIGURATION_ERROR: Thiếu biến môi trường PHONE_HASH_SECRET bắt buộc/,
    'computePhoneHmac must throw CONFIGURATION_ERROR when PHONE_HASH_SECRET is whitespace'
  );

  // 6c. POST /api/customers fails closed with 500 CONFIGURATION_ERROR when PHONE_HASH_SECRET is missing
  delete process.env.PHONE_HASH_SECRET;
  const reqPostNoSecret = new NextRequest('http://localhost:3000/api/customers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Khách Test Secret', phone: '0912345678' }),
  });
  const resPostNoSecret = await postCustomersHandler(reqPostNoSecret, {
    actor: bossActor,
    adminClient: createMockSupabaseForPost(false),
  });
  assert.strictEqual(resPostNoSecret.status, 500, 'POST /api/customers must return 500 when PHONE_HASH_SECRET missing');
  const bodyNoSecret = await resPostNoSecret.json();
  assert.strictEqual(bodyNoSecret.error, 'CONFIGURATION_ERROR');
  console.log('✓ PASS: Item 10 (P1) strictly enforced: PHONE_HASH_SECRET is independent and fail-closed!');

  // Restore valid secret
  process.env.PHONE_HASH_SECRET = 'ai-crm-phone-hmac-secret-v1';

  // ============================================================================
  // TEST SECTION 7: ITEM 8 (P1) — ELIMINATION OF MOCK FALLBACKS IN PRODUCTION
  // ============================================================================
  console.log('\n--- Test 7: Item 8 (P1) - Zero Mock Fallback in Production (NEXT_PUBLIC_DEMO_MODE !== "true") ---');
  delete process.env.NEXT_PUBLIC_DEMO_MODE; // Non-demo mode (Production)

  // 7a. GET /api/customers returns empty list when DB is empty, NOT mock customers
  function createEmptySupabaseForGet() {
    return {
      from: (table: string) => {
        if (table === 'customers') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: async () => ({
                    data: [],
                    error: null,
                    count: 0,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'identities') {
          return {
            select: () => ({
              eq: () => ({
                in: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        return {};
      },
    } as any;
  }

  const reqEmptyGet = new NextRequest('http://localhost:3000/api/customers');
  const resEmptyGet = await getCustomersHandler(reqEmptyGet, {
    actor: bossActor,
    adminClient: createEmptySupabaseForGet(),
  });
  assert.strictEqual(resEmptyGet.status, 200);
  const bodyEmptyGet = await resEmptyGet.json();
  assert.deepStrictEqual(bodyEmptyGet.data, [], 'In production, empty DB must return empty data array, NOT mock customers');

  // 7b. getStageHistories in production fails-closed on DB error
  const mockDbWithHistError = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: null, error: new Error('Postgres connection pool exhausted') }),
        }),
      }),
    }),
  } as any;

  await assert.rejects(
    async () => CustomerService.getStageHistories('cust-real-1', mockDbWithHistError),
    /DATABASE_ERROR/,
    'getStageHistories must throw DATABASE_ERROR in production when DB fails'
  );

  // 7c. getUrgentClosingCustomers in production fails-closed on DB error
  const mockDbWithUrgentError = {
    from: (table: string) => ({
      select: () => ({
        in: async () => ({ data: null, error: new Error('Table locks timeout') }),
      }),
    }),
  } as any;

  await assert.rejects(
    async () => CustomerService.getUrgentClosingCustomers(APPLICATION_ROLES.BOSS_ADMIN, undefined, mockDbWithUrgentError),
    /DATABASE_ERROR/,
    'getUrgentClosingCustomers must throw DATABASE_ERROR in production when DB query fails'
  );

  // 7d. getUrgentClosingCustomers in production returns empty list when no urgent customers
  const mockDbWithEmptyUrgent = {
    from: (table: string) => ({
      select: () => ({
        in: async () => ({ data: [], error: null }),
      }),
    }),
  } as any;

  const urgentEmpty = await CustomerService.getUrgentClosingCustomers(
    APPLICATION_ROLES.BOSS_ADMIN,
    undefined,
    mockDbWithEmptyUrgent
  );
  assert.deepStrictEqual(urgentEmpty, [], 'In production, empty DB must return empty list, not mock customers');
  console.log('✓ PASS: Item 8 (P1) strictly enforced: Zero mock fallbacks in production mode!');

  // ============================================================================
  // TEST SECTION 8: ITEM 9 (P1) — DATA INTEGRITY DURING CUSTOMER CREATION
  // ============================================================================
  console.log('\n--- Test 8: Item 9 (P1) - Data Integrity in findOrCreateByPhone ---');

  // 8a. If identities insert fails -> throws immediately (no partial state)
  function createSupabaseWithIdentityFailure() {
    return {
      from: (table: string) => {
        if (table === 'identities') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            insert: async () => ({ data: null, error: new Error('Foreign key violation on identities') }),
          };
        }
        if (table === 'customers') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: {
                    id: 'new-cust-integrity-1',
                    company_id: companyA,
                    customer_code: 'KH-111111',
                    name: 'Test Integrity',
                    source: 'MANUAL',
                    stage: 'LEAD_NEW',
                    metadata: {},
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      },
    } as any;
  }

  await assert.rejects(
    async () =>
      CustomerService.findOrCreateByPhone(
        { companyId: companyA, name: 'Test Integrity', phone: '0912345678' },
        createSupabaseWithIdentityFailure()
      ),
    /Lỗi tạo danh tính số điện thoại khách hàng/,
    'findOrCreateByPhone must throw immediately when identities insert fails'
  );

  // 8b. If customer_stage_histories insert fails -> throws immediately
  function createSupabaseWithStageHistoryFailure() {
    return {
      from: (table: string) => {
        if (table === 'identities') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            insert: async () => ({ data: null, error: null }),
          };
        }
        if (table === 'customers') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: {
                    id: 'new-cust-integrity-2',
                    company_id: companyA,
                    customer_code: 'KH-222222',
                    name: 'Test Integrity 2',
                    source: 'MANUAL',
                    stage: 'LEAD_NEW',
                    metadata: {},
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'customer_stage_histories') {
          return {
            insert: async () => ({ data: null, error: new Error('Postgres disk out of space') }),
          };
        }
        return {};
      },
    } as any;
  }

  await assert.rejects(
    async () =>
      CustomerService.findOrCreateByPhone(
        { companyId: companyA, name: 'Test Integrity 2', phone: '0912345678' },
        createSupabaseWithStageHistoryFailure()
      ),
    /Lỗi ghi nhận lịch sử trạng thái ban đầu/,
    'findOrCreateByPhone must throw immediately when customer_stage_histories insert fails'
  );

  // 8c. POST /api/customers returns HTTP 500 when database integrity error occurs
  const reqPostIntegrityFail = new NextRequest('http://localhost:3000/api/customers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Integrity Fail', phone: '0912345678' }),
  });
  const resPostIntegrityFail = await postCustomersHandler(reqPostIntegrityFail, {
    actor: bossActor,
    adminClient: createSupabaseWithIdentityFailure(),
  });
  assert.strictEqual(resPostIntegrityFail.status, 500, 'POST /api/customers must return 500 on DB integrity failure');
  const bodyIntegrityFail = await resPostIntegrityFail.json();
  assert.strictEqual(bodyIntegrityFail.error, 'DATABASE_ERROR');
  console.log('✓ PASS: Item 9 (P1) strictly enforced: Zero error swallowing, partial state prevented with 500!');

  // Reset DEMO_MODE for any downstream tests
  process.env.NEXT_PUBLIC_DEMO_MODE = 'true';

  console.log('\n======================================================================');
  console.log('>>> ALL P0 & P1 FAIL-CLOSED & DATA INTEGRITY TESTS PASSED (100%) <<<');
  console.log('======================================================================\n');
}

runFailClosedAndZeroPhoneTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
