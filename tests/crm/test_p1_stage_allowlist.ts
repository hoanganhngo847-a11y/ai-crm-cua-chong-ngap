import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { toCanonicalStage, CUSTOMER_STAGES, CustomerStage } from '../../features/crm/types/customer.types';
import { CustomerService } from '../../features/crm/services/customer.service';
import { PATCH as stagePatchHandler } from '../../app/api/customers/[id]/stage/route';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import type { ActorContext } from '../../shared/contracts/auth';

async function runStageAllowlistTests() {
  console.log('======================================================================');
  console.log('STARTING P1 TEST SUITE: STRICT RUNTIME ALLOWLIST FOR toCanonicalStage');
  console.log('======================================================================');

  // ============================================================================
  // SECTION 1: UNIT TEST toCanonicalStage RUNTIME ALLOWLIST VALIDATION
  // ============================================================================
  console.log('\n--- Section 1: toCanonicalStage Runtime Allowlist ---');

  // 1a. Valid canonical stages accepted
  assert.strictEqual(toCanonicalStage(CUSTOMER_STAGES.LEAD_NEW), 'LEAD_NEW');
  assert.strictEqual(toCanonicalStage('PRICE_OFFERED'), 'PRICE_OFFERED');
  assert.strictEqual(toCanonicalStage('CONTRACT_SIGNED'), 'CONTRACT_SIGNED');
  assert.strictEqual(toCanonicalStage('HANDOVER_COMPLETED'), 'HANDOVER_COMPLETED');
  console.log('✓ PASS 1a: Valid canonical stages correctly returned');

  // 1b. Case-insensitive and trimmed canonical strings accepted
  assert.strictEqual(toCanonicalStage('  price_offered  '), 'PRICE_OFFERED');
  assert.strictEqual(toCanonicalStage('negotiating'), 'NEGOTIATING');
  console.log('✓ PASS 1b: Case-insensitive and trimmed strings correctly normalized');

  // 1c. Business aliases correctly mapped to canonical stages
  assert.strictEqual(toCanonicalStage('KHACH_MOI'), 'LEAD_NEW');
  assert.strictEqual(toCanonicalStage('khach_moi'), 'LEAD_NEW');
  assert.strictEqual(toCanonicalStage('DA_CO_GIA'), 'PRICE_OFFERED');
  assert.strictEqual(toCanonicalStage('da_co_gia'), 'PRICE_OFFERED');
  assert.strictEqual(toCanonicalStage('DANG_THUONG_LUONG'), 'NEGOTIATING');
  assert.strictEqual(toCanonicalStage('dang_thuong_luong'), 'NEGOTIATING');
  console.log('✓ PASS 1c: Business aliases mapped to canonical stages without type coercion bypass');

  // 1d. Invalid stage strings REJECTED (Fail-Closed)
  const invalidStrings = ['HACKED_STAGE', 'random_string', 'UNKNOWN', 'ADMIN_BYPASS', 'SQL_INJECTION'];
  for (const invalid of invalidStrings) {
    let threw = false;
    try {
      toCanonicalStage(invalid);
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes(`Giai đoạn khách hàng không hợp lệ: ${invalid}`));
    }
    assert(threw, `Expected toCanonicalStage to throw for invalid stage: "${invalid}"`);
  }
  console.log('✓ PASS 1d: Invalid stage strings strictly rejected with descriptive Error');

  // 1e. Non-string types and falsy values REJECTED
  const invalidTypes = [123, true, false, null, undefined, {}, [], NaN];
  for (const invalid of invalidTypes) {
    let threw = false;
    try {
      toCanonicalStage(invalid);
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes('Giai đoạn khách hàng không hợp lệ'));
    }
    assert(threw, `Expected toCanonicalStage to throw for non-string type: ${String(invalid)}`);
  }
  console.log('✓ PASS 1e: Non-string types and null/undefined strictly rejected');

  // ============================================================================
  // SECTION 2: CustomerService.updateStage PREVENTING INVALID STAGE FROM DB
  // ============================================================================
  console.log('\n--- Section 2: CustomerService.updateStage Database Protection ---');

  const testCompanyId = '11111111-1111-1111-1111-111111111111';
  let dbUpdateAttempted = false;

  const mockAdminClient = {
    from: (table: string) => {
      if (table === 'customers') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'cust-test-1',
                    company_id: testCompanyId,
                    stage: CUSTOMER_STAGES.LEAD_NEW,
                    full_name: 'Khách Test',
                  },
                  error: null,
                }),
              }),
            }),
          }),
          update: () => {
            dbUpdateAttempted = true;
            return {
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: async () => ({
                      data: {
                        id: 'cust-test-1',
                        company_id: testCompanyId,
                        stage: 'HACKED_STAGE',
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          },
        };
      }
      return {};
    },
  } as any;

  // 2a. Attempting updateStage with HACKED_STAGE must throw BEFORE any DB update
  let updateStageThrew = false;
  try {
    await CustomerService.updateStage(
      {
        customerId: 'cust-test-1',
        companyId: testCompanyId,
        newStage: 'HACKED_STAGE',
      },
      mockAdminClient
    );
  } catch (err) {
    updateStageThrew = true;
    assert((err as Error).message.includes('Giai đoạn khách hàng không hợp lệ: HACKED_STAGE'));
  }
  assert(updateStageThrew, 'updateStage must throw when newStage is invalid');
  assert.strictEqual(dbUpdateAttempted, false, 'Database UPDATE must NEVER be attempted for invalid stage');
  console.log('✓ PASS 2a: updateStage rejects invalid stage before database mutation occurs');

  // 2b. Attempting updateStage with numeric non-string stage must throw
  let updateNumericThrew = false;
  try {
    await CustomerService.updateStage(
      {
        customerId: 'cust-test-1',
        companyId: testCompanyId,
        newStage: 123 as any,
      },
      mockAdminClient
    );
  } catch (err) {
    updateNumericThrew = true;
    assert((err as Error).message.includes('Giai đoạn khách hàng không hợp lệ: 123'));
  }
  assert(updateNumericThrew, 'updateStage must throw when newStage is numeric');
  assert.strictEqual(dbUpdateAttempted, false);
  console.log('✓ PASS 2b: updateStage rejects numeric non-string stage before database mutation');

  // ============================================================================
  // SECTION 3: PATCH /api/customers/[id]/stage API ROUTE VALIDATION
  // ============================================================================
  console.log('\n--- Section 3: PATCH /api/customers/[id]/stage API Route Validation ---');

  const testActor: ActorContext = {
    userId: 'user-sale-1',
    companyId: testCompanyId,
    memberId: 'mem-sale-1',
    role: APPLICATION_ROLES.SALE,
    fullName: 'Sale Tester',
    email: 'sale@test.com',
    profileStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
    aal: 'aal1',
    isMfaEnrolled: false,
  };

  // 3a. Invalid stage 'HACKED_STAGE' in body: returns HTTP 400 INVALID_STAGE
  const reqHackedStage = new NextRequest('http://localhost:3000/api/customers/cust-test-1/stage', {
    method: 'PATCH',
    body: JSON.stringify({ to_stage: 'HACKED_STAGE', note: 'Thử tấn công stage' }),
  });
  const resHackedStage = await stagePatchHandler(reqHackedStage, {
    params: Promise.resolve({ id: 'cust-test-1' }),
    actor: testActor,
    adminClient: mockAdminClient,
  });
  assert.strictEqual(resHackedStage.status, 400, 'Invalid stage must return 400 Bad Request');
  const bodyHackedStage = await resHackedStage.json();
  assert.strictEqual(bodyHackedStage.success, false);
  assert.strictEqual(bodyHackedStage.error, 'INVALID_STAGE');
  assert(bodyHackedStage.message.includes('Giai đoạn khách hàng không hợp lệ: HACKED_STAGE'));
  console.log('✓ PASS 3a: PATCH /api/customers/[id]/stage rejects "HACKED_STAGE" with 400 INVALID_STAGE');

  // 3b. Invalid stage 'random_string' in body: returns HTTP 400 INVALID_STAGE
  const reqRandomStage = new NextRequest('http://localhost:3000/api/customers/cust-test-1/stage', {
    method: 'PATCH',
    body: JSON.stringify({ stage: 'random_string' }),
  });
  const resRandomStage = await stagePatchHandler(reqRandomStage, {
    params: Promise.resolve({ id: 'cust-test-1' }),
    actor: testActor,
    adminClient: mockAdminClient,
  });
  assert.strictEqual(resRandomStage.status, 400);
  const bodyRandomStage = await resRandomStage.json();
  assert.strictEqual(bodyRandomStage.error, 'INVALID_STAGE');
  console.log('✓ PASS 3b: PATCH /api/customers/[id]/stage rejects "random_string" with 400 INVALID_STAGE');

  // 3c. Numeric stage 123 in body: returns HTTP 400 INVALID_STAGE
  const reqNumericStage = new NextRequest('http://localhost:3000/api/customers/cust-test-1/stage', {
    method: 'PATCH',
    body: JSON.stringify({ to_stage: 123 }),
  });
  const resNumericStage = await stagePatchHandler(reqNumericStage, {
    params: Promise.resolve({ id: 'cust-test-1' }),
    actor: testActor,
    adminClient: mockAdminClient,
  });
  assert.strictEqual(resNumericStage.status, 400);
  const bodyNumericStage = await resNumericStage.json();
  assert.strictEqual(bodyNumericStage.error, 'INVALID_STAGE');
  console.log('✓ PASS 3c: PATCH /api/customers/[id]/stage rejects numeric stage with 400 INVALID_STAGE');

  // 3d. Valid stage 'PRICE_OFFERED' passes validation and processes successfully
  const mockWorkingSupabase = {
    from: (table: string) => {
      if (table === 'customers') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => {
                const getCustomer = async () => ({
                  data: {
                    id: 'cust-test-1',
                    company_id: testCompanyId,
                    stage: CUSTOMER_STAGES.LEAD_NEW,
                    full_name: 'Khách Hàng Hợp Lệ',
                    phone: '0912345678',
                  },
                  error: null,
                });
                return {
                  single: getCustomer,
                  maybeSingle: getCustomer,
                };
              },
            }),
          }),
          update: (fields: any) => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: {
                      id: 'cust-test-1',
                      company_id: testCompanyId,
                      stage: fields.stage,
                      full_name: 'Khách Hàng Hợp Lệ',
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
          insert: (row: any) => ({
            select: () => ({
              single: async () => ({
                data: { id: 'hist-1', ...row },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    },
  } as any;

  const reqValidStage = new NextRequest('http://localhost:3000/api/customers/cust-test-1/stage', {
    method: 'PATCH',
    body: JSON.stringify({ to_stage: 'PRICE_OFFERED', note: 'Báo giá thành công' }),
  });
  const resValidStage = await stagePatchHandler(reqValidStage, {
    params: Promise.resolve({ id: 'cust-test-1' }),
    actor: testActor,
    adminClient: mockWorkingSupabase,
  });
  assert.strictEqual(resValidStage.status, 200, 'Valid stage should return 200 OK');
  const bodyValidStage = await resValidStage.json();
  assert.strictEqual(bodyValidStage.success, true);
  assert.strictEqual(bodyValidStage.data.stage, 'PRICE_OFFERED');
  console.log('✓ PASS 3d: PATCH /api/customers/[id]/stage accepts canonical "PRICE_OFFERED" with 200 OK');

  // 3e. Valid business alias 'DA_CO_GIA' normalized to 'PRICE_OFFERED'
  const reqAliasStage = new NextRequest('http://localhost:3000/api/customers/cust-test-1/stage', {
    method: 'PATCH',
    body: JSON.stringify({ stage: 'DA_CO_GIA', note: 'Chuyển qua alias' }),
  });
  const resAliasStage = await stagePatchHandler(reqAliasStage, {
    params: Promise.resolve({ id: 'cust-test-1' }),
    actor: testActor,
    adminClient: mockWorkingSupabase,
  });
  assert.strictEqual(resAliasStage.status, 200);
  const bodyAliasStage = await resAliasStage.json();
  assert.strictEqual(bodyAliasStage.data.stage, 'PRICE_OFFERED');
  console.log('✓ PASS 3e: Business alias "DA_CO_GIA" normalized to canonical stage "PRICE_OFFERED"');

  // ============================================================================
  // SECTION 4: SAFE ERROR MESSAGES FOR normalizePhone (ZERO PHONE LEAK)
  // Tuân thủ Lỗi P1 (Mục 13): Loại bỏ rò rỉ số điện thoại trong thông báo lỗi
  // ============================================================================
  console.log('\n--- Section 4: normalizePhone Safe Error Messages (Zero Phone Leak) ---');

  const rawTestPhones = ['09123', '0912345678999999999', 'invalid_phone_string', ''];
  for (const rawPhone of rawTestPhones) {
    let threw = false;
    try {
      CustomerService.normalizePhone(rawPhone);
    } catch (err) {
      threw = true;
      const errorMsg = (err as Error).message;
      assert.strictEqual(errorMsg, 'Số điện thoại không đúng định dạng hợp lệ.');
      if (rawPhone) {
        assert(!errorMsg.includes(rawPhone), `Error message must NOT leak raw phone: ${rawPhone}`);
      }
    }
    assert(threw, `Expected normalizePhone to throw for invalid phone: "${rawPhone}"`);
  }
  console.log('✓ PASS 4a: normalizePhone throws safe generic error without leaking input phone in message');

  console.log('\n======================================================================');
  console.log('ALL P1 STAGE RUNTIME ALLOWLIST & SAFE ERROR TESTS PASSED! (100%)');
  console.log('======================================================================\n');
}

runStageAllowlistTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
