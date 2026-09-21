import assert from 'node:assert';
import { CustomerService } from '../../features/crm/services/customer.service';
import { CUSTOMER_STAGES, STAGE_ACTOR_TYPES } from '../../features/crm/types/customer.types';

async function runAtomicCompensationTests() {
  console.log('======================================================================');
  console.log('STARTING P0 TEST SUITE: ATOMIC ROLLBACK & COMPENSATION AUDIT');
  console.log('======================================================================');

  process.env.PHONE_HASH_SECRET = process.env.PHONE_HASH_SECRET || 'ai-crm-phone-hmac-secret-v1';
  const companyId = '11111111-1111-1111-1111-111111111111';

  // ============================================================================
  // TEST SECTION 1: updateStage ATOMICITY & ROLLBACK COMPENSATION
  // ============================================================================
  console.log('\n--- Test 1: updateStage Atomic Rollback on customer_stage_histories Failure ---');

  // Simulated Database State
  const initialUpdatedAt = '2026-09-20T10:00:00.000Z';
  const dbState = {
    customers: [
      {
        id: 'cust-atomic-001',
        company_id: companyId,
        customer_code: 'KH-001',
        name: 'Nguyễn Văn Atomic',
        stage: CUSTOMER_STAGES.LEAD_NEW,
        created_at: initialUpdatedAt,
        updated_at: initialUpdatedAt,
      },
    ],
    customer_stage_histories: [] as any[],
  };

  function createMockSupabaseForUpdateStage(shouldFailHistory: boolean) {
    return {
      from: (table: string) => {
        if (table === 'customers') {
          return {
            select: () => ({
              eq: (col1: string, val1: string) => ({
                eq: (col2: string, val2: string) => ({
                  maybeSingle: async () => {
                    const cust = dbState.customers.find((c) => c.id === val1 && c.company_id === val2);
                    return { data: cust ? { ...cust } : null, error: null };
                  },
                }),
              }),
            }),
            update: (payload: any) => ({
              eq: (col1: string, val1: string) => ({
                eq: (col2: string, val2: string) => {
                  const targetIndex = dbState.customers.findIndex((c) => c.id === val1 && c.company_id === val2);
                  if (targetIndex !== -1) {
                    Object.assign(dbState.customers[targetIndex], payload);
                  }
                  return {
                    select: () => ({
                      single: async () => ({
                        data: targetIndex !== -1 ? { ...dbState.customers[targetIndex] } : null,
                        error: null,
                      }),
                    }),
                    // Support direct await for compensation rollback without select().single()
                    then: (resolve: any) => resolve({ data: null, error: null }),
                  };
                },
              }),
            }),
          };
        }

        if (table === 'customer_stage_histories') {
          return {
            insert: (payload: any) => {
              if (shouldFailHistory) {
                return {
                  select: () => ({
                    single: async () => ({
                      data: null,
                      error: new Error('Postgres customer_stage_histories disk space full'),
                    }),
                  }),
                  then: (resolve: any) =>
                    resolve({ data: null, error: new Error('Postgres customer_stage_histories disk space full') }),
                };
              }

              const row = { id: `hist-${Date.now()}`, ...payload };
              dbState.customer_stage_histories.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
                then: (resolve: any) => resolve({ data: row, error: null }),
              };
            },
          };
        }

        return {};
      },
    } as any;
  }

  // 1a. Happy path: updateStage succeeds
  const mockClientSuccess = createMockSupabaseForUpdateStage(false);
  const successResult = await CustomerService.updateStage(
    {
      customerId: 'cust-atomic-001',
      companyId: companyId,
      newStage: CUSTOMER_STAGES.PRICE_OFFERED,
      note: 'Báo giá thành công',
      actorType: STAGE_ACTOR_TYPES.USER,
      actorId: 'user-001',
    },
    mockClientSuccess
  );

  assert.strictEqual(successResult.customer.stage, CUSTOMER_STAGES.PRICE_OFFERED);
  assert.strictEqual(dbState.customers[0].stage, CUSTOMER_STAGES.PRICE_OFFERED);
  assert.strictEqual(dbState.customer_stage_histories.length, 1);
  console.log('✓ 1a. Normal updateStage succeeded and persisted both customer.stage and history');

  // Reset stage to LEAD_NEW
  dbState.customers[0].stage = CUSTOMER_STAGES.LEAD_NEW;
  dbState.customers[0].updated_at = initialUpdatedAt;
  dbState.customer_stage_histories = [];

  // 1b. Failure path: customer_stage_histories insert fails -> stage rolled back to oldStage
  const mockClientWithFailure = createMockSupabaseForUpdateStage(true);

  await assert.rejects(
    async () =>
      CustomerService.updateStage(
        {
          customerId: 'cust-atomic-001',
          companyId: companyId,
          newStage: CUSTOMER_STAGES.CONTRACT_SIGNED,
          note: 'Chốt hợp đồng',
          actorType: STAGE_ACTOR_TYPES.USER,
          actorId: 'user-001',
        },
        mockClientWithFailure
      ),
    /Lỗi ghi lịch sử customer_stage_histories/,
    'updateStage must re-throw error when customer_stage_histories fails'
  );

  // Assert atomic rollback: customer stage must be rolled back to LEAD_NEW, not CONTRACT_SIGNED
  assert.strictEqual(
    dbState.customers[0].stage,
    CUSTOMER_STAGES.LEAD_NEW,
    'Compensation rollback MUST restore customer.stage to oldStage (LEAD_NEW)'
  );
  assert.strictEqual(
    dbState.customers[0].updated_at,
    initialUpdatedAt,
    'Compensation rollback MUST restore customer.updated_at to previous timestamp'
  );
  assert.strictEqual(
    dbState.customer_stage_histories.length,
    0,
    'customer_stage_histories must remain empty (zero state divergence)'
  );
  console.log('✓ 1b. PASS: When history insert fails, customers.stage is rolled back to oldStage (LEAD_NEW)!');

  // ============================================================================
  // TEST SECTION 2: findOrCreateByPhone ATOMICITY & CLEANUP COMPENSATION
  // ============================================================================
  console.log('\n--- Test 2: findOrCreateByPhone Atomic Cleanup on Partial Creation Failure ---');

  interface MockDbRecord {
    id: string;
    [key: string]: any;
  }

  function createMockSupabaseForCreation(failingStep: 'none' | 'private_contact' | 'identities' | 'stage_history') {
    const memory = {
      customers: [] as MockDbRecord[],
      customer_private_contacts: [] as MockDbRecord[],
      identities: [] as MockDbRecord[],
      customer_stage_histories: [] as MockDbRecord[],
      deletedRecords: [] as { table: string; id?: string; customer_id?: string; company_id?: string }[],
    };

    const makeQueryBuilder = (tableName: string) => {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
              then: (resolve: any) => resolve({ data: [], error: null }),
            }),
          }),
        }),
        insert: (payload: any) => {
          if (tableName === 'customer_private_contacts' && failingStep === 'private_contact') {
            return {
              select: () => ({
                single: async () => ({ data: null, error: new Error('Disk error on private contacts insert') }),
              }),
              then: (resolve: any) =>
                resolve({ data: null, error: new Error('Disk error on private contacts insert') }),
            };
          }
          if (tableName === 'identities' && failingStep === 'identities') {
            return {
              select: () => ({
                single: async () => ({ data: null, error: new Error('Unique constraint violation on identities') }),
              }),
              then: (resolve: any) =>
                resolve({ data: null, error: new Error('Unique constraint violation on identities') }),
            };
          }
          if (tableName === 'customer_stage_histories' && failingStep === 'stage_history') {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: new Error('Postgres connection reset on stage history insert'),
                }),
              }),
              then: (resolve: any) =>
                resolve({ data: null, error: new Error('Postgres connection reset on stage history insert') }),
            };
          }

          const record = { id: `id-${tableName}-${Date.now()}`, ...payload };
          (memory as any)[tableName]?.push(record);

          return {
            data: record,
            error: null,
            select: () => ({
              single: async () => ({ data: record, error: null }),
            }),
            then: (resolve: any) => resolve({ data: record, error: null }),
          };
        },
        delete: () => ({
          eq: (col1: string, val1: string) => ({
            eq: async (col2: string, val2: string) => {
              memory.deletedRecords.push({
                table: tableName,
                [col1]: val1,
                [col2]: val2,
              });
              // Perform actual in-memory deletion
              const arr: MockDbRecord[] = (memory as any)[tableName] || [];
              const filtered = arr.filter((item) => !(item[col1] === val1 && item[col2] === val2));
              (memory as any)[tableName] = filtered;
              return { data: null, error: null };
            },
          }),
        }),
      };
    };

    const client = {
      from: (table: string) => makeQueryBuilder(table),
      schema: (schemaName: string) => ({
        from: (table: string) => makeQueryBuilder(table),
      }),
      memory,
    };

    return client;
  }

  // 2a. Failure during identities step -> triggers compensation rollback
  const mockCreationFailIdentity = createMockSupabaseForCreation('identities');

  await assert.rejects(
    async () =>
      CustomerService.findOrCreateByPhone(
        {
          companyId,
          name: 'Khách Rác Thử Nghiệm',
          phone: '0988776655',
        },
        mockCreationFailIdentity as any
      ),
    /Lỗi tạo danh tính số điện thoại khách hàng/,
    'findOrCreateByPhone must throw error when identities step fails'
  );

  // Assert compensation rollback cleaned up customer and private contact
  const mem1 = mockCreationFailIdentity.memory;
  assert.strictEqual(
    mem1.customers.length,
    0,
    'Customer record MUST be completely deleted on creation failure (zero dangling customers)'
  );
  assert.strictEqual(
    mem1.customer_private_contacts.length,
    0,
    'Customer private contact MUST be cleaned up on creation failure'
  );
  assert.strictEqual(mem1.identities.length, 0, 'Zero identities left');
  assert.strictEqual(mem1.customer_stage_histories.length, 0, 'Zero stage histories left');

  // Verify deletion calls recorded
  const customerDeletedRecord = mem1.deletedRecords.find((r) => r.table === 'customers');
  assert(customerDeletedRecord, 'A delete call on customers table must have been executed');
  assert.strictEqual(customerDeletedRecord.company_id, companyId);
  console.log('✓ 2a. PASS: Failure at identities step rolled back and deleted created customer row!');

  // 2b. Failure during stage_history step -> triggers compensation rollback
  const mockCreationFailStage = createMockSupabaseForCreation('stage_history');

  await assert.rejects(
    async () =>
      CustomerService.findOrCreateByPhone(
        {
          companyId,
          name: 'Khách Rác Thử Nghiệm 2',
          phone: '0988776654',
        },
        mockCreationFailStage as any
      ),
    /Lỗi ghi nhận lịch sử trạng thái ban đầu/,
    'findOrCreateByPhone must throw error when stage history step fails'
  );

  const mem2 = mockCreationFailStage.memory;
  assert.strictEqual(
    mem2.customers.length,
    0,
    'Customer record MUST be completely deleted when stage history insert fails'
  );
  assert.strictEqual(
    mem2.customer_private_contacts.length,
    0,
    'Customer private contact MUST be cleaned up when stage history insert fails'
  );
  assert.strictEqual(
    mem2.identities.length,
    0,
    'Identities MUST be cleaned up when stage history insert fails'
  );
  assert.strictEqual(mem2.customer_stage_histories.length, 0, 'Stage history is empty');

  const customerDeletedRecord2 = mem2.deletedRecords.find((r) => r.table === 'customers');
  assert(customerDeletedRecord2, 'Delete on customers must have been executed');
  console.log('✓ 2b. PASS: Failure at stage_history step cleaned up customer, private contact, and identity rows!');

  // 2c. Failure during private_contact step -> triggers compensation rollback
  const mockCreationFailPrivate = createMockSupabaseForCreation('private_contact');

  await assert.rejects(
    async () =>
      CustomerService.findOrCreateByPhone(
        {
          companyId,
          name: 'Khách Rác Thử Nghiệm 3',
          phone: '0988776653',
        },
        mockCreationFailPrivate as any
      ),
    /Lỗi lưu thông tin liên hệ bảo mật/,
    'findOrCreateByPhone must throw error when private contact step fails'
  );

  const mem3 = mockCreationFailPrivate.memory;
  assert.strictEqual(
    mem3.customers.length,
    0,
    'Customer record MUST be deleted when private contact step fails'
  );
  assert.strictEqual(mem3.customer_private_contacts.length, 0);
  assert.strictEqual(mem3.identities.length, 0);
  const customerDeletedRecord3 = mem3.deletedRecords.find((r) => r.table === 'customers');
  assert(customerDeletedRecord3, 'Delete on customers must have been executed');
  console.log('✓ 2c. PASS: Failure at private_contact step cleaned up created customer row!');

  console.log('\n======================================================================');
  console.log('>>> ALL P0 ATOMICITY & COMPENSATION ROLLBACK TESTS PASSED (100%) <<<');
  console.log('======================================================================\n');
}

runAtomicCompensationTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
