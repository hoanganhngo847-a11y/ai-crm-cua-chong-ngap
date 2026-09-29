import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { CustomerService } from '../../features/crm/services/customer.service';
import { CUSTOMER_STAGES } from '../../features/crm/types/customer.types';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import { GET as getCustomersHandler } from '../../app/api/customers/route';

async function runUrgentTenantIsolationTests() {
  console.log('======================================================================');
  console.log('STARTING P0 TEST SUITE: TENANT ISOLATION FOR getUrgentClosingCustomers');
  console.log('======================================================================');

  const companyA = '11111111-1111-1111-1111-111111111111';
  const companyB = '22222222-2222-2222-2222-222222222222';

  // Multi-tenant customer pool in database
  const allDbCustomers = [
    {
      id: 'cust-a-1',
      company_id: companyA,
      customer_code: 'KH-A-01',
      name: 'Khách hàng A1 - Đã có giá',
      stage: CUSTOMER_STAGES.PRICE_OFFERED,
      created_at: '2026-09-20T08:00:00.000Z',
      updated_at: '2026-09-20T08:00:00.000Z',
    },
    {
      id: 'cust-a-2',
      company_id: companyA,
      customer_code: 'KH-A-02',
      name: 'Khách hàng A2 - Đang thương lượng',
      stage: CUSTOMER_STAGES.NEGOTIATING,
      created_at: '2026-09-20T09:00:00.000Z',
      updated_at: '2026-09-20T09:00:00.000Z',
    },
    {
      id: 'cust-b-1',
      company_id: companyB,
      customer_code: 'KH-B-01',
      name: 'Khách hàng B1 (Bảo mật Công ty B)',
      stage: CUSTOMER_STAGES.PRICE_OFFERED,
      created_at: '2026-09-20T08:30:00.000Z',
      updated_at: '2026-09-20T08:30:00.000Z',
    },
    {
      id: 'cust-b-2',
      company_id: companyB,
      customer_code: 'KH-B-02',
      name: 'Khách hàng B2 (Bảo mật Công ty B)',
      stage: CUSTOMER_STAGES.NEGOTIATING,
      created_at: '2026-09-20T09:30:00.000Z',
      updated_at: '2026-09-20T09:30:00.000Z',
    },
  ];

  function createMockSupabaseWithQuerySpy(executedQueries: { table: string; filters: Record<string, any> }[]) {
    return {
      from: (table: string) => ({
        select: () => {
          const currentFilters: Record<string, any> = {};
          return {
            eq: (col: string, val: any) => {
              currentFilters[col] = val;
              return {
                in: (stageCol: string, stages: string[]) => {
                  currentFilters[stageCol] = stages;
                  executedQueries.push({ table, filters: { ...currentFilters } });

                  // Return filtered results according to company_id and stage
                  const filtered = allDbCustomers.filter(
                    (c) => c.company_id === currentFilters['company_id'] && stages.includes(c.stage)
                  );
                  return {
                    order: () => ({
                      limit: (n: number) => Promise.resolve({ data: filtered.slice(0, n), error: null }),
                      then: (resolve: any) => resolve({ data: filtered, error: null }),
                    }),
                    limit: (n: number) => Promise.resolve({ data: filtered.slice(0, n), error: null }),
                    then: (resolve: any) => resolve({ data: filtered, error: null }),
                  };
                },
              };
            },
          };
        },
      }),
    } as any;
  }

  // ============================================================================
  // TEST SECTION 1: FAIL-CLOSED ON MISSING OR EMPTY companyId
  // ============================================================================
  console.log('\n--- Test 1: Fail-closed when companyId is missing or whitespace ---');

  await assert.rejects(
    async () => CustomerService.getUrgentClosingCustomers(''),
    /companyId là tham số bắt buộc/,
    'getUrgentClosingCustomers must throw when companyId is empty string'
  );

  await assert.rejects(
    async () => CustomerService.getUrgentClosingCustomers('   '),
    /companyId là tham số bắt buộc/,
    'getUrgentClosingCustomers must throw when companyId is whitespace'
  );

  await assert.rejects(
    async () => CustomerService.getUrgentClosingCustomers(null as any),
    /companyId là tham số bắt buộc/,
    'getUrgentClosingCustomers must throw when companyId is null'
  );

  await assert.rejects(
    async () => CustomerService.getUrgentClosingCustomers(undefined as any),
    /companyId là tham số bắt buộc/,
    'getUrgentClosingCustomers must throw when companyId is undefined'
  );
  console.log('✓ PASS: Fail-closed strictly enforced for missing/empty companyId!');

  // ============================================================================
  // TEST SECTION 2: COMPANY A ISOLATION
  // ============================================================================
  console.log('\n--- Test 2: Calling getUrgentClosingCustomers with Company A ---');
  const queriesA: { table: string; filters: Record<string, any> }[] = [];
  const clientA = createMockSupabaseWithQuerySpy(queriesA);

  const urgentCompanyA = await CustomerService.getUrgentClosingCustomers(
    companyA,
    5,
    APPLICATION_ROLES.SALE,
    undefined,
    clientA
  );

  // Assert query included .eq('company_id', companyA)
  assert.strictEqual(queriesA.length, 1, 'Exactly one database query must be executed');
  assert.strictEqual(queriesA[0].table, 'customers');
  assert.strictEqual(queriesA[0].filters['company_id'], companyA, 'Query MUST include .eq("company_id", companyA)');

  // Assert returned customers belong ONLY to Company A
  assert.strictEqual(urgentCompanyA.length, 2);
  for (const c of urgentCompanyA) {
    assert.strictEqual(c.company_id, companyA, `Customer ${c.id} must belong to Company A`);
    assert.notStrictEqual(c.company_id, companyB, `Customer ${c.id} must NEVER belong to Company B`);
  }
  console.log('✓ PASS: Company A call returned ONLY Company A customers!');

  // ============================================================================
  // TEST SECTION 3: COMPANY B ISOLATION (ZERO LEAKAGE TO/FROM OTHER TENANTS)
  // ============================================================================
  console.log('\n--- Test 3: Calling getUrgentClosingCustomers with Company B ---');
  const queriesB: { table: string; filters: Record<string, any> }[] = [];
  const clientB = createMockSupabaseWithQuerySpy(queriesB);

  const urgentCompanyB = await CustomerService.getUrgentClosingCustomers(
    companyB,
    5,
    APPLICATION_ROLES.SALE,
    undefined,
    clientB
  );

  // Assert query included .eq('company_id', companyB)
  assert.strictEqual(queriesB.length, 1);
  assert.strictEqual(queriesB[0].filters['company_id'], companyB, 'Query MUST include .eq("company_id", companyB)');

  // Assert returned customers belong ONLY to Company B
  assert.strictEqual(urgentCompanyB.length, 2);
  for (const c of urgentCompanyB) {
    assert.strictEqual(c.company_id, companyB, `Customer ${c.id} must belong to Company B`);
    assert.notStrictEqual(c.company_id, companyA, `Customer ${c.id} must NEVER belong to Company A`);
  }
  console.log('✓ PASS: Company B call returned ONLY Company B customers (Zero leakage)!');

  // ============================================================================
  // TEST SECTION 4: ROUTE LEVEL GET /api/customers?urgent_closing=true
  // ============================================================================
  console.log('\n--- Test 4: Route Level: GET /api/customers?urgent_closing=true Enforces actor.companyId ---');

  const saleActorA = {
    userId: 'user-sale-a',
    companyId: companyA,
    role: APPLICATION_ROLES.SALE,
    fullName: 'Sale Company A',
    email: 'sale@company-a.vn',
    memberId: 'mem-sale-a',
    aal: 'aal1' as const,
    isMfaEnrolled: false,
    profileStatus: 'ACTIVE' as const,
    membershipStatus: 'ACTIVE' as const,
  };

  // Attempt spoofing with ?company_id=companyB
  const reqSpoofed = new NextRequest(
    `http://localhost:3000/api/customers?urgent_closing=true&company_id=${companyB}&limit=10`
  );
  const resSpoofed = await getCustomersHandler(reqSpoofed, {
    actor: saleActorA,
    adminClient: clientA,
  });

  assert.strictEqual(resSpoofed.status, 200);
  const bodySpoofed = await resSpoofed.json();
  assert.strictEqual(bodySpoofed.success, true);

  // Assert returned data ONLY contains Company A customers despite spoofed query parameter
  assert(Array.isArray(bodySpoofed.data), 'data must be an array');
  assert.strictEqual(bodySpoofed.data.length, 2);
  for (const c of bodySpoofed.data) {
    assert.strictEqual(c.company_id, companyA, 'Response must strictly belong to authenticated actor.companyId');
    assert.notStrictEqual(c.company_id, companyB, 'Spoofed company_id must be completely ignored');
  }
  console.log('✓ PASS: Route strictly enforces actor.companyId and ignores client company_id spoofing!');

  console.log('\n======================================================================');
  console.log('>>> ALL P0 getUrgentClosingCustomers TENANT ISOLATION TESTS PASSED (100%) <<<');
  console.log('======================================================================\n');
}

runUrgentTenantIsolationTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
