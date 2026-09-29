import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { POST as postCustomersHandler } from '../../app/api/customers/route';
import { CustomerService } from '../../features/crm/services/customer.service';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import type { ActorContext } from '../../shared/contracts/auth';

process.env.PHONE_HASH_SECRET = 'ai-crm-phone-hmac-secret-v1';

async function runServerAuthorityTests() {
  console.log('======================================================================');
  console.log('STARTING P1 TEST SUITE: SERVER AUTHORITY & IDENTITY VERIFICATION LOCK');
  console.log('======================================================================');

  const testCompanyId = '11111111-1111-1111-1111-111111111111';
  const testUserId = 'user-test-boss-1';

  const bossActor: ActorContext = {
    userId: testUserId,
    companyId: testCompanyId,
    role: APPLICATION_ROLES.BOSS_ADMIN,
    profileStatus: 'ACTIVE',
    membershipStatus: 'ACTIVE',
    email: 'boss@example.com',
    fullName: 'Sếp Tổng',
    memberId: 'mem-boss-1',
    aal: 'aal1',
    isMfaEnrolled: false,
  };

  const insertedRecords: {
    customers: any[];
    privateContacts: any[];
    identities: any[];
    stageHistories: any[];
    auditLogs: any[];
  } = {
    customers: [],
    privateContacts: [],
    identities: [],
    stageHistories: [],
    auditLogs: [],
  };

  function createMockSupabaseForAuthority() {
    return {
      schema: (schemaName: string) => {
        if (schemaName === 'private') {
          return {
            from: (table: string) => {
              if (table === 'customer_private_contacts') {
                return {
                  select: () => ({
                    eq: () => ({
                      eq: () => ({
                        maybeSingle: async () => ({ data: null, error: null }),
                      }),
                    }),
                  }),
                  insert: async (row: any) => {
                    insertedRecords.privateContacts.push(row);
                    return { error: null };
                  },
                };
              }
              return {};
            },
          };
        }
        return {};
      },
      from: (table: string) => {
        if (table === 'customers') {
          return {
            insert: (row: any) => {
              insertedRecords.customers.push(row);
              return {
                select: () => ({
                  single: async () => ({
                    data: {
                      id: 'new-cust-server-auth',
                      company_id: row.company_id,
                      customer_code: 'KH-888888',
                      name: row.name,
                      source: row.source,
                      stage: row.stage,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
                }),
              };
            },
          };
        }
        if (table === 'identities') {
          return {
            select: () => {
              const query: any = {
                eq: () => query,
                maybeSingle: async () => ({ data: null, error: null }),
                then: (resolve: any) => resolve({ data: [...insertedRecords.identities], error: null }),
              };
              return query;
            },
            insert: async (row: any) => {
              insertedRecords.identities.push(row);
              return { error: null };
            },
          };
        }
        if (table === 'customer_stage_histories') {
          return {
            insert: async (row: any) => {
              insertedRecords.stageHistories.push(row);
              return { error: null };
            },
          };
        }
        if (table === 'audit_logs') {
          return {
            insert: async (row: any) => {
              insertedRecords.auditLogs.push(row);
              return { error: null };
            },
          };
        }
        return {};
      },
    } as any;
  }

  // ============================================================================
  // TEST 1: POST /api/customers Client claims { is_verified: true, external_id, channel: 'FACEBOOK' }
  // Requirement: Server MUST override is_verified to false for all identities in DB
  // ============================================================================
  console.log('\n--- Test 1: POST /api/customers - Client Self-Claim is_verified: true & FACEBOOK ---');

  // Reset tracking
  insertedRecords.customers = [];
  insertedRecords.privateContacts = [];
  insertedRecords.identities = [];
  insertedRecords.stageHistories = [];
  insertedRecords.auditLogs = [];

  const reqHackedIdentity = new NextRequest('http://localhost:3000/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Khách Tự Nhận Xác Minh',
      phone: '0912345678',
      is_verified: true,
      verified: true,
      external_id: 'fake-fb-id',
      channel: 'FACEBOOK',
    }),
  });

  const resHacked = await postCustomersHandler(reqHackedIdentity, {
    actor: bossActor,
    adminClient: createMockSupabaseForAuthority(),
  });

  assert.strictEqual(resHacked.status, 201, 'POST /api/customers should succeed with 201 Created');
  const bodyHacked = await resHacked.json();

  // 1a. Verify private contact was inserted with is_verified = false
  assert.strictEqual(insertedRecords.privateContacts.length, 1, 'Private contact must be inserted');
  assert.strictEqual(
    insertedRecords.privateContacts[0].is_verified,
    false,
    'private.customer_private_contacts.is_verified MUST be false (Server Authority override)'
  );
  console.log('✓ PASS 1a: DB customer_private_contacts saved with is_verified = false');

  // 1b. Verify phone identity was inserted with verified = false
  const phoneIdentity = insertedRecords.identities.find((i) => i.channel === 'PHONE');
  assert(phoneIdentity, 'PHONE identity must be inserted');
  assert.strictEqual(
    phoneIdentity.verified,
    false,
    'public.identities (PHONE) verified MUST be false (Server Authority override)'
  );
  console.log('✓ PASS 1b: DB PHONE identity saved with verified = false');

  // 1c. Anti-Poison Identity (Lỗi P1 số 6): Server loại bỏ hoàn toàn channel/external_id từ client
  const fbIdentity = insertedRecords.identities.find((i) => i.channel === 'FACEBOOK');
  assert.strictEqual(
    fbIdentity,
    undefined,
    'public.identities (FACEBOOK) KHÔNG được tạo từ client POST /api/customers (Anti-Poison Identity)'
  );
  console.log('✓ PASS 1c: DB FACEBOOK identity NOT created (poison identity blocked)');

  // 1d. Verify response payload identities has only PHONE with verified = false
  assert(bodyHacked.data.identities, 'Response must contain identities array');
  assert.strictEqual(bodyHacked.data.identities.length, 1, 'Only PHONE identity is returned in payload');
  assert.strictEqual(bodyHacked.data.identities[0].channel, 'PHONE');
  assert.strictEqual(bodyHacked.data.identities[0].verified, false);
  console.log('✓ PASS 1d: Response payload identities has only PHONE with verified = false');

  // ============================================================================
  // TEST 2: POST /api/customers Client claims verified: true for PHONE only
  // ============================================================================
  console.log('\n--- Test 2: POST /api/customers - Client attempts self-verification on phone ---');

  insertedRecords.customers = [];
  insertedRecords.privateContacts = [];
  insertedRecords.identities = [];

  const reqSelfVerifyPhone = new NextRequest('http://localhost:3000/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Khách Tự Xác Minh Phone',
      phone: '0988776655',
      verified: true,
      source: 'MANUAL',
    }),
  });

  const resSelfVerify = await postCustomersHandler(reqSelfVerifyPhone, {
    actor: bossActor,
    adminClient: createMockSupabaseForAuthority(),
  });

  assert.strictEqual(resSelfVerify.status, 201);
  assert.strictEqual(insertedRecords.privateContacts[0].is_verified, false);
  assert.strictEqual(insertedRecords.identities[0].verified, false);
  console.log('✓ PASS 2: Phone identity and private contact both forced to verified = false');

  // ============================================================================
  // TEST 3: Client attempts to smuggle isTrustedProvider: true in payload
  // ============================================================================
  console.log('\n--- Test 3: POST /api/customers - Client attempts to smuggle isTrustedProvider: true ---');

  insertedRecords.customers = [];
  insertedRecords.privateContacts = [];
  insertedRecords.identities = [];

  const reqSmuggleProvider = new NextRequest('http://localhost:3000/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Hacker Pretending Provider',
      phone: '0933445566',
      verified: true,
      isTrustedProvider: true, // Should be ignored/rejected by server
      is_trusted_provider: true,
      channel: 'ZALO',
      external_id: 'fake-zalo-uid',
    }),
  });

  const resSmuggle = await postCustomersHandler(reqSmuggleProvider, {
    actor: bossActor,
    adminClient: createMockSupabaseForAuthority(),
  });

  assert.strictEqual(resSmuggle.status, 201);
  assert.strictEqual(insertedRecords.privateContacts[0].is_verified, false, 'Smuggled isTrustedProvider MUST be ignored');
  const zaloIdentity = insertedRecords.identities.find((i) => i.channel === 'ZALO');
  assert.strictEqual(zaloIdentity, undefined, 'ZALO identity must NOT be created from POST /api/customers');
  assert.strictEqual(insertedRecords.identities.length, 1, 'Only PHONE identity should exist');
  assert.strictEqual(insertedRecords.identities[0].channel, 'PHONE');
  assert.strictEqual(insertedRecords.identities[0].verified, false);
  console.log('✓ PASS 3: Server ignores smuggled isTrustedProvider and blocks poison provider identity');

  // ============================================================================
  // TEST 4: Direct CustomerService.findOrCreateByPhone without isTrustedProvider
  // ============================================================================
  console.log('\n--- Test 4: CustomerService.findOrCreateByPhone without isTrustedProvider ---');

  insertedRecords.customers = [];
  insertedRecords.privateContacts = [];
  insertedRecords.identities = [];

  const resultDirectUntrusted = await CustomerService.findOrCreateByPhone(
    {
      companyId: testCompanyId,
      name: 'Direct Call Untrusted',
      phone: '0977665544',
      verified: true, // Untrusted caller sends verified: true
      channel: 'WEBSITE',
      externalId: 'sess-123456',
    },
    createMockSupabaseForAuthority()
  );

  assert.strictEqual(resultDirectUntrusted.contact.is_verified, false);
  assert.strictEqual(insertedRecords.privateContacts[0].is_verified, false);
  const websiteIdentity = insertedRecords.identities.find((i) => i.channel === 'WEBSITE');
  assert.strictEqual(websiteIdentity, undefined, 'WEBSITE identity must NOT be created without isTrustedProvider: true');
  assert.strictEqual(insertedRecords.identities.length, 1, 'Only PHONE identity should exist without isTrustedProvider');
  assert.strictEqual(insertedRecords.identities[0].channel, 'PHONE');
  assert.strictEqual(insertedRecords.identities[0].verified, false);
  assert(resultDirectUntrusted.identities.every((i) => i.verified === false));
  console.log('✓ PASS 4: CustomerService blocks social identity & defaults verified = false when isTrustedProvider is omitted/false');

  // ============================================================================
  // TEST 5: Direct CustomerService.findOrCreateByPhone WITH isTrustedProvider: true
  // ============================================================================
  console.log('\n--- Test 5: CustomerService.findOrCreateByPhone WITH isTrustedProvider: true ---');

  insertedRecords.customers = [];
  insertedRecords.privateContacts = [];
  insertedRecords.identities = [];

  const resultDirectTrusted = await CustomerService.findOrCreateByPhone(
    {
      companyId: testCompanyId,
      name: 'Trusted Provider Call',
      phone: '0977665544',
      verified: true,
      isTrustedProvider: true, // Legitimate webhook / OTP authority
      channel: 'FACEBOOK',
      externalId: 'verified-page-scoped-id',
    },
    createMockSupabaseForAuthority()
  );

  assert.strictEqual(resultDirectTrusted.contact.is_verified, true);
  assert.strictEqual(insertedRecords.privateContacts[0].is_verified, true);
  const trustedPhone = insertedRecords.identities.find((i) => i.channel === 'PHONE');
  const trustedFb = insertedRecords.identities.find((i) => i.channel === 'FACEBOOK');
  assert(trustedPhone, 'PHONE identity must be created');
  assert(trustedFb, 'FACEBOOK identity must be created when isTrustedProvider: true');
  assert.strictEqual(trustedPhone.verified, true);
  assert.strictEqual(trustedFb.verified, true);
  console.log('✓ PASS 5: CustomerService allows verified = true ONLY when isTrustedProvider: true');

  console.log('======================================================================');
  console.log('>>> ALL P1 SERVER AUTHORITY TESTS PASSED! (100%) <<<');
  console.log('======================================================================');
}

runServerAuthorityTests().catch((err) => {
  console.error('SERVER AUTHORITY TEST FAILED:', err);
  process.exit(1);
});
