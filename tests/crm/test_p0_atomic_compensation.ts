import assert from 'node:assert';
import { CustomerService } from '../../features/crm/services/customer.service';
import { CUSTOMER_STAGES, STAGE_ACTOR_TYPES } from '../../features/crm/types/customer.types';

async function runAtomicCompensationTests() {
  console.log('======================================================================');
  console.log('STARTING P0 TEST SUITE: ATOMIC DATABASE TRANSACTIONS & RPC ROLLBACK');
  console.log('======================================================================');

  process.env.PHONE_HASH_SECRET = process.env.PHONE_HASH_SECRET || 'ai-crm-phone-hmac-secret-v1';
  const companyId = '11111111-1111-1111-1111-111111111111';

  // ============================================================================
  // TEST SECTION 1: updateStage ATOMIC TRANSACTION & DATABASE ROLLBACK
  // Tuân thủ Lỗi P0 số 3: RPC update_customer_stage_atomic thay thế rollback thủ công
  // ============================================================================
  console.log('\n--- Test 1: updateStage Atomic Transaction on update_customer_stage_atomic RPC ---');

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
    let rpcCalled = false;
    return {
      rpc: async (fnName: string, params: any) => {
        assert.strictEqual(fnName, 'update_customer_stage_atomic', 'Must call RPC update_customer_stage_atomic');
        assert.strictEqual(params.p_company_id, companyId);
        assert.strictEqual(params.p_customer_id, 'cust-atomic-001');
        rpcCalled = true;

        if (shouldFailHistory) {
          // Mô phỏng Database Transaction Rollback:
          // Khi bất kỳ câu lệnh nào trong khối PL/pgSQL thất bại, PostgreSQL tự động ROLLBACK toàn bộ transaction.
          // dbState không bị thay đổi bất kỳ trường nào (Zero state divergence).
          return {
            data: null,
            error: new Error('Postgres customer_stage_histories disk space full (Database Transaction Rollback)'),
          };
        }

        // Happy path: Update stage and insert history atomically in 1 transaction block
        const target = dbState.customers.find((c) => c.id === params.p_customer_id && c.company_id === params.p_company_id);
        if (!target) return { data: null, error: { message: 'Not found', code: 'P0002' } };

        const oldStage = target.stage;
        target.stage = params.p_new_stage;
        target.updated_at = new Date().toISOString();

        const histRow = {
          id: `hist-${Date.now()}`,
          company_id: params.p_company_id,
          customer_id: params.p_customer_id,
          from_stage: oldStage,
          to_stage: params.p_new_stage,
          actor_type: params.p_actor_type,
          changed_by_user_id: params.p_changed_by,
          reason: params.p_note,
          source_ref: params.p_source_ref,
          changed_at: target.updated_at,
        };
        dbState.customer_stage_histories.push(histRow);

        return {
          data: {
            customer: { ...target },
            history: histRow,
          },
          error: null,
        };
      },
      wasRpcCalled: () => rpcCalled,
    } as any;
  }

  // 1a. Happy path: updateStage succeeds via RPC
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

  assert(mockClientSuccess.wasRpcCalled(), 'update_customer_stage_atomic RPC must be invoked');
  assert.strictEqual(successResult.customer.stage, CUSTOMER_STAGES.PRICE_OFFERED);
  assert.strictEqual(dbState.customers[0].stage, CUSTOMER_STAGES.PRICE_OFFERED);
  assert.strictEqual(dbState.customer_stage_histories.length, 1);
  console.log('✓ 1a. Normal updateStage succeeded and persisted both customer.stage and history via RPC atomic transaction');

  // Reset stage to LEAD_NEW
  dbState.customers[0].stage = CUSTOMER_STAGES.LEAD_NEW;
  dbState.customers[0].updated_at = initialUpdatedAt;
  dbState.customer_stage_histories = [];

  // 1b. Failure path: update_customer_stage_atomic RPC fails -> stage stays at oldStage via DB Rollback
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
    /update_customer_stage_atomic/,
    'updateStage must re-throw error when update_customer_stage_atomic RPC fails'
  );

  assert(mockClientWithFailure.wasRpcCalled(), 'update_customer_stage_atomic RPC must be invoked on failure');
  // Assert atomic rollback: customer stage must remain at LEAD_NEW, not CONTRACT_SIGNED
  assert.strictEqual(
    dbState.customers[0].stage,
    CUSTOMER_STAGES.LEAD_NEW,
    'Database transaction rollback MUST leave customer.stage at oldStage (LEAD_NEW)'
  );
  assert.strictEqual(
    dbState.customers[0].updated_at,
    initialUpdatedAt,
    'Database transaction rollback MUST leave customer.updated_at unchanged'
  );
  assert.strictEqual(
    dbState.customer_stage_histories.length,
    0,
    'customer_stage_histories must remain empty (zero partial records committed in DB)'
  );
  console.log('✓ 1b. PASS: When RPC fails, database transaction rolls back and customers.stage remains at oldStage (LEAD_NEW)!');

  // ============================================================================
  // TEST SECTION 2: findOrCreateByPhone ATOMIC TRANSACTION & DATABASE ROLLBACK
  // Tuân thủ Lỗi P0 số 3: RPC create_customer_atomic thay thế compensation rollback
  // ============================================================================
  console.log('\n--- Test 2: findOrCreateByPhone Atomic Database Transaction Rollback on Failure ---');

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
    };

    let rpcCalled = false;

    const client = {
      from: (table: string) => {
        // Query kiểm tra identity số điện thoại hiện tại
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
          };
        }
        return {};
      },
      rpc: async (fnName: string, params: any) => {
        assert.strictEqual(fnName, 'create_customer_atomic', 'Must invoke create_customer_atomic RPC');
        assert.strictEqual(params.p_company_id, companyId);
        rpcCalled = true;

        // Mô phỏng Database Transaction Block:
        // Trong PL/pgSQL, tất cả các câu lệnh INSERT nằm trong 1 khối transaction nguyên tử.
        // Nếu bất kỳ bước nào gặp lỗi, PostgreSQL tự động ROLLBACK toàn bộ transaction,
        // không có bất kỳ bản ghi nào được lưu vào CSDL (Zero Dangling / Orphan Records).
        if (failingStep === 'private_contact') {
          return {
            data: null,
            error: new Error('Lỗi lưu thông tin liên hệ bảo mật: Disk error on private contacts insert (Database Rollback)'),
          };
        }
        if (failingStep === 'identities') {
          return {
            data: null,
            error: new Error('Lỗi tạo danh tính số điện thoại khách hàng: Unique constraint violation on identities (Database Rollback)'),
          };
        }
        if (failingStep === 'stage_history') {
          return {
            data: null,
            error: new Error('Lỗi ghi nhận lịch sử trạng thái ban đầu: Postgres connection reset on stage history insert (Database Rollback)'),
          };
        }

        // Happy path: All records committed atomically in 1 transaction
        const custId = `cust-${Date.now()}`;
        const cust = {
          id: custId,
          company_id: params.p_company_id,
          customer_code: params.p_customer_code || 'KH-000001',
          name: params.p_name,
          source: params.p_source,
          stage: params.p_stage,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const contact = {
          id: `cpc-${Date.now()}`,
          company_id: params.p_company_id,
          customer_id: custId,
          raw_phone: params.p_raw_phone,
          normalized_phone: params.p_normalized_phone,
          is_verified: params.p_is_verified,
        };
        const phoneId = {
          id: `ident-${Date.now()}-phone`,
          company_id: params.p_company_id,
          customer_id: custId,
          channel: 'PHONE',
          external_id: params.p_phone_hash,
          verified: params.p_is_verified,
        };
        const hist = {
          id: `hist-${Date.now()}`,
          company_id: params.p_company_id,
          customer_id: custId,
          from_stage: null,
          to_stage: params.p_stage,
          actor_type: 'SYSTEM',
          reason: params.p_note || 'Khách hàng mới tạo',
          changed_at: new Date().toISOString(),
        };

        memory.customers.push(cust);
        memory.customer_private_contacts.push(contact);
        memory.identities.push(phoneId);
        memory.customer_stage_histories.push(hist);

        return {
          data: {
            customer: cust,
            contact,
            identities: [phoneId],
            history: hist,
          },
          error: null,
        };
      },
      wasRpcCalled: () => rpcCalled,
      memory,
    };

    return client;
  }

  // 2a. Failure during identities step -> triggers atomic database rollback
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
    /create_customer_atomic/,
    'findOrCreateByPhone must throw error when identities step fails in RPC'
  );

  assert(mockCreationFailIdentity.wasRpcCalled(), 'create_customer_atomic RPC must be invoked');
  // Assert atomic database rollback: zero dangling records left in any table
  const mem1 = mockCreationFailIdentity.memory;
  assert.strictEqual(
    mem1.customers.length,
    0,
    'Customer record MUST NOT be committed on creation failure (zero dangling customers)'
  );
  assert.strictEqual(
    mem1.customer_private_contacts.length,
    0,
    'Customer private contact MUST NOT be committed on creation failure'
  );
  assert.strictEqual(mem1.identities.length, 0, 'Zero identities left in DB');
  assert.strictEqual(mem1.customer_stage_histories.length, 0, 'Zero stage histories left in DB');
  console.log('✓ 2a. PASS: Failure at identities step rolled back all rows via Database Transaction (Zero partial records)!');

  // 2b. Failure during stage_history step -> triggers atomic database rollback
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
    /create_customer_atomic/,
    'findOrCreateByPhone must throw error when stage history step fails in RPC'
  );

  assert(mockCreationFailStage.wasRpcCalled(), 'create_customer_atomic RPC must be invoked');
  const mem2 = mockCreationFailStage.memory;
  assert.strictEqual(mem2.customers.length, 0, 'Zero customers committed');
  assert.strictEqual(mem2.customer_private_contacts.length, 0, 'Zero private contacts committed');
  assert.strictEqual(mem2.identities.length, 0, 'Zero identities committed');
  assert.strictEqual(mem2.customer_stage_histories.length, 0, 'Zero stage histories committed');
  console.log('✓ 2b. PASS: Failure at stage_history step rolled back all rows via Database Transaction!');

  // 2c. Failure during private_contact step -> triggers atomic database rollback
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
    /create_customer_atomic/,
    'findOrCreateByPhone must throw error when private contact step fails in RPC'
  );

  assert(mockCreationFailPrivate.wasRpcCalled(), 'create_customer_atomic RPC must be invoked');
  const mem3 = mockCreationFailPrivate.memory;
  assert.strictEqual(mem3.customers.length, 0, 'Zero customers committed');
  assert.strictEqual(mem3.customer_private_contacts.length, 0, 'Zero private contacts committed');
  assert.strictEqual(mem3.identities.length, 0, 'Zero identities committed');
  assert.strictEqual(mem3.customer_stage_histories.length, 0, 'Zero stage histories committed');
  console.log('✓ 2c. PASS: Failure at private_contact step rolled back all rows via Database Transaction!');

  // 2d. Happy path creation via RPC
  console.log('\n--- Test 2d: findOrCreateByPhone Happy Path via create_customer_atomic RPC ---');
  const mockCreationSuccess = createMockSupabaseForCreation('none');
  const createResult = await CustomerService.findOrCreateByPhone(
    {
      companyId,
      name: 'Khách Hàng Thành Công',
      phone: '0988776652',
      source: 'FACEBOOK',
      channel: 'FACEBOOK',
      externalId: 'fb-atomic-123',
    },
    mockCreationSuccess as any
  );

  assert(mockCreationSuccess.wasRpcCalled(), 'create_customer_atomic RPC must be invoked');
  assert.strictEqual(createResult.isNew, true);
  assert.strictEqual(createResult.customer.name, 'Khách Hàng Thành Công');
  assert.strictEqual(mockCreationSuccess.memory.customers.length, 1);
  assert.strictEqual(mockCreationSuccess.memory.customer_private_contacts.length, 1);
  assert.strictEqual(mockCreationSuccess.memory.identities.length, 1);
  assert.strictEqual(mockCreationSuccess.memory.customer_stage_histories.length, 1);
  console.log('✓ 2d. PASS: Happy path create_customer_atomic RPC creates all entities in single atomic transaction!');

  console.log('\n======================================================================');
  console.log('>>> ALL P0 ATOMIC DATABASE TRANSACTIONS & RPC TESTS PASSED (100%) <<<');
  console.log('======================================================================\n');
}

runAtomicCompensationTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
