import assert from 'node:assert';
import { CustomerService } from '../../features/crm/services/customer.service';
import { CUSTOMER_STAGES, STAGE_ACTOR_TYPES } from '../../features/crm/types/customer.types';

async function runStageHistoryTenantIsolationTests() {
  console.log('======================================================================');
  console.log('STARTING P1 TEST SUITE: TENANT SCOPING FOR getStageHistories');
  console.log('======================================================================');

  const companyA = '11111111-1111-1111-1111-111111111111';
  const companyB = '22222222-2222-2222-2222-222222222222';
  const customerA = 'cust-comp-a-01';
  const customerB = 'cust-comp-b-01';

  // Multi-tenant history records in DB
  const allHistories = [
    {
      id: 'hist-a-1',
      company_id: companyA,
      customer_id: customerA,
      from_stage: CUSTOMER_STAGES.LEAD_NEW,
      to_stage: CUSTOMER_STAGES.PRICE_OFFERED,
      actor_type: STAGE_ACTOR_TYPES.USER,
      reason: 'Báo giá cho khách A',
      changed_at: '2026-09-20T10:00:00.000Z',
    },
    {
      id: 'hist-a-2',
      company_id: companyA,
      customer_id: customerA,
      from_stage: CUSTOMER_STAGES.PRICE_OFFERED,
      to_stage: CUSTOMER_STAGES.CONTRACT_SIGNED,
      actor_type: STAGE_ACTOR_TYPES.USER,
      reason: 'Ký hợp đồng khách A',
      changed_at: '2026-09-20T11:00:00.000Z',
    },
    {
      id: 'hist-b-1',
      company_id: companyB,
      customer_id: customerB,
      from_stage: CUSTOMER_STAGES.LEAD_NEW,
      to_stage: CUSTOMER_STAGES.NEGOTIATING,
      actor_type: STAGE_ACTOR_TYPES.USER,
      reason: 'Đàm phán với khách B (Bảo mật công ty B)',
      changed_at: '2026-09-20T10:30:00.000Z',
    },
  ];

  function createMockSupabaseWithQuerySpy(executedQueries: { table: string; filters: Record<string, any> }[]) {
    return {
      from: (table: string) => ({
        select: () => {
          const filters: Record<string, any> = {};
          return {
            eq: (col1: string, val1: any) => {
              filters[col1] = val1;
              return {
                eq: (col2: string, val2: any) => {
                  filters[col2] = val2;
                  executedQueries.push({ table, filters: { ...filters } });

                  const matching = allHistories.filter(
                    (h) => h.company_id === filters['company_id'] && h.customer_id === filters['customer_id']
                  );

                  return {
                    order: () => Promise.resolve({ data: matching, error: null }),
                    then: (resolve: any) => resolve({ data: matching, error: null }),
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
  console.log('\n--- Test 1: Fail-closed on missing or empty companyId ---');

  await assert.rejects(
    async () => CustomerService.getStageHistories('', customerA),
    /companyId là tham số bắt buộc để xác thực quyền truy cập/,
    'getStageHistories must throw when companyId is empty string'
  );

  await assert.rejects(
    async () => CustomerService.getStageHistories('   ', customerA),
    /companyId là tham số bắt buộc để xác thực quyền truy cập/,
    'getStageHistories must throw when companyId is whitespace'
  );

  await assert.rejects(
    async () => CustomerService.getStageHistories(null as any, customerA),
    /companyId là tham số bắt buộc để xác thực quyền truy cập/,
    'getStageHistories must throw when companyId is null'
  );

  await assert.rejects(
    async () => CustomerService.getStageHistories(undefined as any, customerA),
    /companyId là tham số bắt buộc để xác thực quyền truy cập/,
    'getStageHistories must throw when companyId is undefined'
  );

  await assert.rejects(
    async () => CustomerService.getStageHistories(companyA, ''),
    /customerId là tham số bắt buộc/,
    'getStageHistories must throw when customerId is empty'
  );

  console.log('✓ PASS: Fail-closed strictly enforced for companyId & customerId parameters!');

  // ============================================================================
  // TEST SECTION 2: DUAL FILTER IN DATABASE QUERY (.eq('company_id').eq('customer_id'))
  // ============================================================================
  console.log('\n--- Test 2: Dual filter in DB query (.eq("company_id").eq("customer_id")) ---');
  const queriesA: { table: string; filters: Record<string, any> }[] = [];
  const clientA = createMockSupabaseWithQuerySpy(queriesA);

  const historiesA = await CustomerService.getStageHistories(companyA, customerA, clientA);

  assert.strictEqual(queriesA.length, 1);
  assert.strictEqual(queriesA[0].table, 'customer_stage_histories');
  assert.strictEqual(queriesA[0].filters['company_id'], companyA, 'Query MUST include .eq("company_id", companyA)');
  assert.strictEqual(queriesA[0].filters['customer_id'], customerA, 'Query MUST include .eq("customer_id", customerA)');

  assert.strictEqual(historiesA.length, 2);
  for (const h of historiesA) {
    assert.strictEqual(h.company_id, companyA);
    assert.strictEqual(h.customer_id, customerA);
  }
  console.log('✓ PASS: getStageHistories correctly applied dual tenant filter and returned Company A records!');

  // ============================================================================
  // TEST SECTION 3: CROSS-TENANT ISOLATION (ZERO LEAKAGE ACROSS TENANTS)
  // ============================================================================
  console.log('\n--- Test 3: Cross-tenant isolation (Zero Leakage) ---');
  const queriesCross: { table: string; filters: Record<string, any> }[] = [];
  const clientCross = createMockSupabaseWithQuerySpy(queriesCross);

  // Tenant B tries to query Customer A's histories
  const crossTenantResult = await CustomerService.getStageHistories(companyB, customerA, clientCross);

  assert.strictEqual(queriesCross[0].filters['company_id'], companyB);
  assert.strictEqual(queriesCross[0].filters['customer_id'], customerA);
  assert.strictEqual(crossTenantResult.length, 0, 'Cross-tenant lookup MUST return empty array (no leakage)');
  console.log('✓ PASS: Cross-tenant query for Customer A under Company B returned 0 records (Absolute isolation)!');

  console.log('\n======================================================================');
  console.log('>>> ALL P1 getStageHistories TENANT SCOPING TESTS PASSED (100%) <<<');
  console.log('======================================================================\n');
}

runStageHistoryTenantIsolationTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
