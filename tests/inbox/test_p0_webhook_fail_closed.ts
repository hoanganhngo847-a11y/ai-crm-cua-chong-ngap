import assert from 'node:assert';
import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import { GET as webhookGetHandler, POST as webhookPostHandler } from '../../app/api/inbox/webhook/route';
import { InboxIngressService } from '../../features/inbox/services/inbox-ingress.service';
import { InboxService } from '../../features/inbox/services/inbox.service';
import { FacebookAdapter, deriveFacebookTenant } from '../../features/inbox/adapters/facebook.adapter';
import { ZaloAdapter, deriveZaloTenant } from '../../features/inbox/adapters/zalo.adapter';
import { ProviderAdapterRegistry } from '../../features/inbox/types/webhook.types';

async function runWebhookFailClosedTests() {
  process.env.DEMO_MODE = 'true';
  console.log('======================================================================');
  console.log('STARTING P0 & P1 TEST SUITE: WEBHOOK INGRESS FAIL-CLOSED & NORMALIZED CONTRACT');
  console.log('======================================================================');

  const testCompanyA = '11111111-1111-1111-1111-111111111111';
  const testCompanyB = '22222222-2222-2222-2222-222222222222';
  const testFbSecret = 'test_fb_secret_key_super_secure_999';
  const testZaloSecret = 'test_zalo_secret_key_super_secure_888';
  const testSystemSecret = 'test_system_secret_key_super_secure_777';
  const testVerifyToken = 'facebook_verify_token_prod_123';

  // Cấu hình Server-side Tenant Mapping an toàn (Tenant Authority thuộc độc quyền về Server)
  process.env.FB_PAGE_TENANT_MAP = JSON.stringify({
    'fb-page-101': testCompanyA,
  });
  process.env.ZALO_OA_TENANT_MAP = JSON.stringify({
    'zalo-oa-202': testCompanyB,
  });
  process.env.INBOX_WEBHOOK_SECRET = testSystemSecret;

  // Clear caches and store
  InboxIngressService.resetIngressCache();
  InboxService.resetInboxStore([], {});

  // ============================================================================
  // SECTION 1: GET HANDSHAKE CHALLENGE (FAIL-CLOSED)
  // ============================================================================
  console.log('\n--- Section 1: GET Handshake Challenge Fail-Closed ---');

  // 1a. Missing FACEBOOK_VERIFY_TOKEN in env: must return 500 CONFIGURATION_ERROR
  delete process.env.FACEBOOK_VERIFY_TOKEN;
  delete process.env.FB_VERIFY_TOKEN;

  const reqGetNoEnv = new NextRequest(
    'http://localhost:3000/api/inbox/webhook?hub.mode=subscribe&hub.challenge=test_chal_123&hub.verify_token=any',
    { method: 'GET' }
  );
  const resGetNoEnv = await webhookGetHandler(reqGetNoEnv);
  assert.strictEqual(resGetNoEnv.status, 500, 'Missing verify token in env must fail-closed with 500');
  const dataGetNoEnv = await resGetNoEnv.json();
  assert.strictEqual(dataGetNoEnv.error, 'CONFIGURATION_ERROR');
  console.log('✓ PASS 1a: Missing verify token env fails closed with 500 (no hard-coded bypass)');

  // 1b. Configure FACEBOOK_VERIFY_TOKEN, but wrong token sent: 403 FORBIDDEN
  process.env.FACEBOOK_VERIFY_TOKEN = testVerifyToken;

  const reqGetWrongToken = new NextRequest(
    'http://localhost:3000/api/inbox/webhook?hub.mode=subscribe&hub.challenge=test_chal_123&hub.verify_token=wrong_token',
    { method: 'GET' }
  );
  const resGetWrongToken = await webhookGetHandler(reqGetWrongToken);
  assert.strictEqual(resGetWrongToken.status, 403);
  console.log('✓ PASS 1b: Wrong verify token rejected with 403 FORBIDDEN');

  // 1c. Valid verify token sent: 200 OK returning challenge string
  const reqGetValidToken = new NextRequest(
    `http://localhost:3000/api/inbox/webhook?hub.mode=subscribe&hub.challenge=test_chal_123&hub.verify_token=${testVerifyToken}`,
    { method: 'GET' }
  );
  const resGetValidToken = await webhookGetHandler(reqGetValidToken);
  assert.strictEqual(resGetValidToken.status, 200);
  const textValidToken = await resGetValidToken.text();
  assert.strictEqual(textValidToken, 'test_chal_123');
  console.log('✓ PASS 1c: Valid verify token returns challenge with 200 OK');

  // ============================================================================
  // SECTION 2: POST WEBHOOK FAIL-CLOSED (MISSING SECRET & SIGNATURE)
  // ============================================================================
  console.log('\n--- Section 2: POST Webhook Fail-Closed Security ---');

  const samplePayloadFb = {
    provider: 'FACEBOOK',
    page_id: 'fb-page-101',
    company_id: '99999999-9999-9999-9999-999999999999', // Giả mạo company_id - Server PHẢI bỏ qua hoàn toàn!
    external_user_id: 'fb-user-101',
    sender_name: 'Khách hàng FB Test',
    message_id: 'msg-fb-001',
    content: 'Cửa chống ngập bản 2m giá sao em?',
  };
  const rawBodyFb = JSON.stringify(samplePayloadFb);

  // 2a. Missing FACEBOOK_APP_SECRET in env: must return 500 CONFIGURATION_ERROR (no bypass)
  delete process.env.FACEBOOK_APP_SECRET;
  delete process.env.FB_APP_SECRET;

  const reqPostNoSecret = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
      'x-hub-signature-256': 'sha256=abcdef123456',
    },
    body: rawBodyFb,
  });
  const resPostNoSecret = await webhookPostHandler(reqPostNoSecret);
  assert.strictEqual(resPostNoSecret.status, 500, 'Missing secret must fail-closed with 500');
  const dataPostNoSecret = await resPostNoSecret.json();
  assert.strictEqual(dataPostNoSecret.error, 'CONFIGURATION_ERROR');
  console.log('✓ PASS 2a: Missing secret in env rejected with 500 CONFIGURATION_ERROR (no bypass)');

  // Configure Facebook Secret in env
  process.env.FACEBOOK_APP_SECRET = testFbSecret;

  // 2b. Missing signature header: must return 401 UNAUTHORIZED
  const reqPostNoSig = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
    },
    body: rawBodyFb,
  });
  const resPostNoSig = await webhookPostHandler(reqPostNoSig);
  assert.strictEqual(resPostNoSig.status, 401, 'Missing signature header must be rejected with 401');
  const dataPostNoSig = await resPostNoSig.json();
  assert.strictEqual(dataPostNoSig.error, 'UNAUTHORIZED');
  console.log('✓ PASS 2b: Missing signature header rejected with 401 UNAUTHORIZED');

  // 2c. Invalid signature (tampered/spoofed HMAC): must return 401 UNAUTHORIZED
  const fakeSig = 'sha256=' + '0'.repeat(64);
  const reqPostFakeSig = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
      'x-hub-signature-256': fakeSig,
    },
    body: rawBodyFb,
  });
  const resPostFakeSig = await webhookPostHandler(reqPostFakeSig);
  assert.strictEqual(resPostFakeSig.status, 401, 'Invalid HMAC signature must be rejected with 401');
  const dataPostFakeSig = await resPostFakeSig.json();
  assert.strictEqual(dataPostFakeSig.error, 'UNAUTHORIZED');
  console.log('✓ PASS 2c: Invalid HMAC signature rejected with 401 UNAUTHORIZED');

  // 2d. Fail-Closed Tenant Authority:
  // 2d-1: Thiếu Page ID trong Facebook payload -> Bị từ chối với 400 INVALID_TENANT_DERIVATION
  const payloadNoPageId = {
    provider: 'FACEBOOK',
    external_user_id: 'fb-user-101',
    message_id: 'msg-fb-no-page-id',
    content: 'Cửa chống ngập không có page_id',
  };
  const rawBodyNoPageId = JSON.stringify(payloadNoPageId);
  const hmacNoPageId = crypto.createHmac('sha256', testFbSecret).update(rawBodyNoPageId).digest('hex');

  const reqPostNoPageId = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
      'x-hub-signature-256': `sha256=${hmacNoPageId}`,
    },
    body: rawBodyNoPageId,
  });
  const resPostNoPageId = await webhookPostHandler(reqPostNoPageId);
  assert.strictEqual(resPostNoPageId.status, 400, 'Missing Page ID must be rejected with 400');
  const dataPostNoPageId = await resPostNoPageId.json();
  assert.strictEqual(dataPostNoPageId.error, 'INVALID_TENANT_DERIVATION');
  console.log('✓ PASS 2d-1: Missing Page ID rejected with 400 INVALID_TENANT_DERIVATION');

  // 2d-2: Facebook webhook kèm company_id giả mạo nhưng Page ID không có trong cấu hình server -> Bị từ chối 403 TENANT_NOT_CONFIGURED (Fail-Closed)
  const payloadFakeFbTenant = {
    provider: 'FACEBOOK',
    page_id: 'unconfigured-fb-page-999',
    company_id: '33333333-3333-3333-3333-333333333333', // Fake tenant
    external_user_id: 'fb-user-fake',
    message_id: 'msg-fb-fake-tenant',
    content: 'Tấn công giả mạo tenant',
  };
  const rawBodyFakeFb = JSON.stringify(payloadFakeFbTenant);
  const hmacFakeFb = crypto.createHmac('sha256', testFbSecret).update(rawBodyFakeFb).digest('hex');

  const reqPostFakeFb = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
      'x-hub-signature-256': `sha256=${hmacFakeFb}`,
    },
    body: rawBodyFakeFb,
  });
  const resPostFakeFb = await webhookPostHandler(reqPostFakeFb);
  assert.strictEqual(resPostFakeFb.status, 403, 'Unconfigured Page ID with fake company_id must be rejected with 403');
  const dataPostFakeFb = await resPostFakeFb.json();
  assert.strictEqual(dataPostFakeFb.error, 'TENANT_NOT_CONFIGURED');
  console.log('✓ PASS 2d-2: Fake company_id with unconfigured Facebook Page ID rejected with 403 TENANT_NOT_CONFIGURED (Fail-Closed)');

  // 2d-3: Zalo webhook kèm company_id giả mạo nhưng OA ID không hợp lệ/chưa cấu hình -> Bị từ chối 403 TENANT_NOT_CONFIGURED (Fail-Closed)
  process.env.ZALO_APP_SECRET = testZaloSecret;
  const payloadFakeZaloTenant = {
    provider: 'ZALO',
    oa_id: 'unconfigured-zalo-oa-999',
    company_id: '33333333-3333-3333-3333-333333333333', // Fake tenant
    external_user_id: 'zalo-user-fake',
    message_id: 'msg-zalo-fake-tenant',
    content: 'Tấn công giả mạo Zalo tenant',
  };
  const rawBodyFakeZalo = JSON.stringify(payloadFakeZaloTenant);
  const hmacFakeZalo = crypto.createHmac('sha256', testZaloSecret).update(rawBodyFakeZalo).digest('hex');

  const reqPostFakeZalo = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'zalo',
      'x-zalo-signature': hmacFakeZalo,
    },
    body: rawBodyFakeZalo,
  });
  const resPostFakeZalo = await webhookPostHandler(reqPostFakeZalo);
  assert.strictEqual(resPostFakeZalo.status, 403, 'Unconfigured OA ID with fake company_id must be rejected with 403');
  const dataPostFakeZalo = await resPostFakeZalo.json();
  assert.strictEqual(dataPostFakeZalo.error, 'TENANT_NOT_CONFIGURED');
  console.log('✓ PASS 2d-3: Fake company_id with unconfigured Zalo OA ID rejected with 403 TENANT_NOT_CONFIGURED (Fail-Closed)');

  // ============================================================================
  // SECTION 3: VALID WEBHOOK INGRESS & NORMALIZED INGRESS CONTRACT
  // ============================================================================
  console.log('\n--- Section 3: Valid Webhook Ingress & Normalized Contract ---');

  // 3a. Valid Facebook Webhook Ingress with valid HMAC
  const validHmacFb = crypto.createHmac('sha256', testFbSecret).update(rawBodyFb).digest('hex');
  const reqPostValidFb = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
      'x-hub-signature-256': `sha256=${validHmacFb}`,
    },
    body: rawBodyFb,
  });
  const resPostValidFb = await webhookPostHandler(reqPostValidFb);
  assert.strictEqual(resPostValidFb.status, 201, 'Valid webhook must return 201 Created');
  const dataPostValidFb = await resPostValidFb.json();
  assert.strictEqual(dataPostValidFb.success, true);
  assert.strictEqual(dataPostValidFb.data.duplicate, false);
  assert.strictEqual(dataPostValidFb.data.message_id, 'msg-fb-001');

  // Verify conversation and message saved in store with correct company_id
  const convsCompanyA = await InboxService.getConversations(testCompanyA);
  assert.strictEqual(convsCompanyA.length, 1);
  assert.strictEqual(convsCompanyA[0].company_id, testCompanyA);

  const convsCompanyB = await InboxService.getConversations(testCompanyB);
  assert.strictEqual(convsCompanyB.length, 0, 'Company B must have 0 conversations (Tenant Isolation)');

  const convsSpoofed = await InboxService.getConversations('99999999-9999-9999-9999-999999999999');
  assert.strictEqual(convsSpoofed.length, 0, 'Spoofed company_id in Facebook payload must be completely ignored');
  console.log('✓ PASS 3a: Valid Facebook HMAC ingress successfully processed and saved with strict tenant isolation');

  // 3b. Idempotency test (L1 RAM Cache): Re-send same message_id -> returns duplicate: true (200 OK)
  const reqPostDuplicate = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
      'x-hub-signature-256': `sha256=${validHmacFb}`,
    },
    body: rawBodyFb,
  });
  const resPostDuplicate = await webhookPostHandler(reqPostDuplicate);
  assert.strictEqual(resPostDuplicate.status, 200, 'Duplicate message must return 200 OK');
  const dataPostDuplicate = await resPostDuplicate.json();
  assert.strictEqual(dataPostDuplicate.success, true);
  assert.strictEqual(dataPostDuplicate.data.duplicate, true);

  // Verify no duplicate conversation or messages were created
  const convsAfterDup = await InboxService.getConversations(testCompanyA);
  assert.strictEqual(convsAfterDup.length, 1);
  console.log('✓ PASS 3b: Idempotency verified: duplicate message_id detected via L1 cache, no duplicate records created');

  // 3b-1. Durable Idempotency test: Xóa sạch hoàn toàn L1 RAM cache (mô phỏng process restart / crash / eviction)
  // Gửi lại sự kiện trùng lặp -> Khẳng định hệ thống vẫn truy vấn CSDL và phát hiện trùng lặp bền vững (L2 Durable Invariant)
  InboxIngressService.resetIngressCache();
  assert.strictEqual(
    InboxIngressService.isDuplicateEvent('msg-fb-001', testCompanyA, 'FACEBOOK'),
    false,
    'L1 RAM cache must be completely cleared after reset'
  );

  const reqPostDurableDup = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
      'x-hub-signature-256': `sha256=${validHmacFb}`,
    },
    body: rawBodyFb,
  });
  const resPostDurableDup = await webhookPostHandler(reqPostDurableDup);
  assert.strictEqual(resPostDurableDup.status, 200, 'Durable duplicate must return 200 OK (not 201 Created)');
  const dataPostDurableDup = await resPostDurableDup.json();
  assert.strictEqual(dataPostDurableDup.success, true);
  assert.strictEqual(dataPostDurableDup.data.duplicate, true, 'Must detect duplicate via durable persistence');
  assert.strictEqual(dataPostDurableDup.data.message_id, 'msg-fb-001');
  assert.strictEqual(dataPostDurableDup.data.conversation_id, convsCompanyA[0].id);
  assert.strictEqual(dataPostDurableDup.data.customer_id, convsCompanyA[0].customer_id);

  // Khẳng định kho lưu trữ không bị sinh thêm cuộc hội thoại hay tin nhắn thừa
  const convsAfterDurable = await InboxService.getConversations(testCompanyA);
  assert.strictEqual(convsAfterDurable.length, 1, 'Conversations count must remain 1');
  const msgsAfterDurable = await InboxService.getMessagesByConversationId(
    testCompanyA,
    convsCompanyA[0].id,
    'BOSS_ADMIN'
  );
  assert.strictEqual(msgsAfterDurable.length, 1, 'Messages count must remain 1 (no duplicate interaction created)');

  // Khẳng định L1 cache đã được tự động nạp ngược lại từ kết quả truy vấn bền vững
  assert.strictEqual(
    InboxIngressService.isDuplicateEvent('msg-fb-001', testCompanyA, 'FACEBOOK'),
    true,
    'L1 cache must be backfilled from L2 durable match'
  );
  console.log('✓ PASS 3b-1: Durable Idempotency verified: duplicate detected via durable store across RAM reset, L1 backfilled');

  // 3b-2. Mock Supabase Database Durable Idempotency (Direct SQL test)
  // Khẳng định truy vấn CSDL chính xác theo (company_id, channel, external_ref) theo index UNIQUE Foundation
  let queriedInteractionsTable = false;
  let queriedExtRefValue = '';
  let queriedCompanyId = '';
  let queriedChannel = '';

  const mockDbClient: any = {
    from: (table: string) => {
      if (table === 'interactions') {
        queriedInteractionsTable = true;
      }
      return {
        select: (_cols: string) => ({
          eq: (col1: string, val1: string) => ({
            eq: (col2: string, val2: string) => ({
              eq: (col3: string, val3: string) => ({
                maybeSingle: async () => {
                  if (col1 === 'company_id') queriedCompanyId = val1;
                  if (col2 === 'channel') queriedChannel = val2;
                  if (col3 === 'external_ref') queriedExtRefValue = val3;
                  return {
                    data: {
                      id: 'int-durable-sql-001',
                      conversation_id: 'conv-durable-sql-001',
                      customer_id: 'cust-durable-sql-001',
                      channel: 'FACEBOOK',
                      external_ref: val3,
                    },
                    error: null,
                  };
                },
              }),
            }),
          }),
        }),
        insert: () => {
          assert.fail('Should NOT insert when duplicate is found in DB!');
        },
      };
    },
  };

  InboxIngressService.resetIngressCache();
  const dbDurableResult = await InboxIngressService.ingestNormalizedEvent(
    {
      provider: 'FACEBOOK',
      company_id: testCompanyA,
      external_user_id: 'fb-user-db-999',
      message_id: 'msg-sql-durable-999',
      content: 'Tin nhắn kiểm thử SQL durable lookup',
      timestamp: new Date().toISOString(),
    },
    mockDbClient
  );

  assert.strictEqual(dbDurableResult.success, true);
  assert.strictEqual(dbDurableResult.duplicate, true, 'Must return duplicate = true from DB lookup');
  assert.strictEqual(dbDurableResult.conversation_id, 'conv-durable-sql-001');
  assert.strictEqual(dbDurableResult.customer_id, 'cust-durable-sql-001');
  assert.strictEqual(queriedInteractionsTable, true, 'Must query interactions table in DB');
  assert.strictEqual(queriedCompanyId, testCompanyA, 'Must query with company_id for Tenant Isolation');
  assert.strictEqual(queriedChannel, 'FACEBOOK', 'Must query with channel for Tenant Isolation');
  assert.strictEqual(queriedExtRefValue, 'msg-sql-durable-999', 'Must query by external_ref matching message_id');
  console.log('✓ PASS 3b-2: Mock DB Durable Idempotency verified: queried public.interactions by (company_id, channel, external_ref)');

  // 3c. Valid Zalo OA Webhook Ingress
  process.env.ZALO_APP_SECRET = testZaloSecret;

  const samplePayloadZalo = {
    provider: 'ZALO',
    oa_id: 'zalo-oa-202',
    company_id: '99999999-9999-9999-9999-999999999999', // Giả mạo company_id - Server PHẢI bỏ qua hoàn toàn!
    external_user_id: 'zalo-user-202',
    sender_name: 'Chị Lan Zalo',
    message_id: 'msg-zalo-002',
    content: 'Tư vấn cửa chống ngập tự động cho gara ô tô',
  };
  const rawBodyZalo = JSON.stringify(samplePayloadZalo);
  const validHmacZalo = crypto.createHmac('sha256', testZaloSecret).update(rawBodyZalo).digest('hex');

  const reqPostValidZalo = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'zalo',
      'x-zalo-signature': validHmacZalo,
    },
    body: rawBodyZalo,
  });
  const resPostValidZalo = await webhookPostHandler(reqPostValidZalo);
  assert.strictEqual(resPostValidZalo.status, 201);
  const dataPostValidZalo = await resPostValidZalo.json();
  assert.strictEqual(dataPostValidZalo.success, true);
  assert.strictEqual(dataPostValidZalo.data.channel, 'zalo');

  // Verify Company B now has 1 conversation, separate from Company A
  const convsCompanyBAfter = await InboxService.getConversations(testCompanyB);
  assert.strictEqual(convsCompanyBAfter.length, 1);
  assert.strictEqual(convsCompanyBAfter[0].company_id, testCompanyB);
  assert.strictEqual(convsCompanyBAfter[0].channel, 'zalo');

  const convsSpoofedZalo = await InboxService.getConversations('99999999-9999-9999-9999-999999999999');
  assert.strictEqual(convsSpoofedZalo.length, 0, 'Spoofed company_id in Zalo payload must be completely ignored');
  console.log('✓ PASS 3c: Valid Zalo OA HMAC ingress processed and isolated to Company B');

  // 3d. Direct ingestNormalizedEvent programmatic contract test (For Member 3 & 4)
  const directEvent = {
    provider: 'FACEBOOK' as const,
    company_id: testCompanyA,
    external_user_id: 'fb-user-direct-303',
    sender_name: 'Khách hàng Direct Test',
    message_id: 'msg-direct-003',
    content: 'Tin nhắn gửi trực tiếp qua contract NormalizedIngressEvent',
    timestamp: new Date().toISOString(),
  };
  const directResult = await InboxIngressService.ingestNormalizedEvent(directEvent);
  assert.strictEqual(directResult.success, true);
  assert.strictEqual(directResult.duplicate, false);
  assert.strictEqual(directResult.message_id, 'msg-direct-003');
  console.log('✓ PASS 3d: Direct ingestNormalizedEvent contract functions cleanly for Member 3 & Member 4');

  // 3e. SYSTEM Provider Webhook Ingress (Nội bộ): Cho phép company_id khi có secret xác thực
  const samplePayloadSystem = {
    provider: 'SYSTEM',
    company_id: testCompanyA,
    external_user_id: 'sys-user-001',
    message_id: 'msg-sys-001',
    content: 'Tin nhắn nội bộ qua System Provider',
  };
  const rawBodySystem = JSON.stringify(samplePayloadSystem);
  const reqPostValidSystem = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'system',
      'x-webhook-secret': testSystemSecret,
    },
    body: rawBodySystem,
  });
  const resPostValidSystem = await webhookPostHandler(reqPostValidSystem);
  assert.strictEqual(resPostValidSystem.status, 201, 'Valid SYSTEM webhook must return 201 Created');
  const dataPostValidSystem = await resPostValidSystem.json();
  assert.strictEqual(dataPostValidSystem.success, true);

  // SYSTEM webhook thiếu company_id phải trả về 400 MISSING_COMPANY_ID
  const samplePayloadSystemNoTenant = {
    provider: 'SYSTEM',
    external_user_id: 'sys-user-002',
    message_id: 'msg-sys-002',
    content: 'Tin nhắn nội bộ thiếu company_id',
  };
  const rawBodySystemNoTenant = JSON.stringify(samplePayloadSystemNoTenant);
  const reqPostSystemNoTenant = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'system',
      'x-webhook-secret': testSystemSecret,
    },
    body: rawBodySystemNoTenant,
  });
  const resPostSystemNoTenant = await webhookPostHandler(reqPostSystemNoTenant);
  assert.strictEqual(resPostSystemNoTenant.status, 400, 'SYSTEM webhook without company_id must return 400');
  const dataPostSystemNoTenant = await resPostSystemNoTenant.json();
  assert.strictEqual(dataPostSystemNoTenant.error, 'MISSING_COMPANY_ID');
  console.log('✓ PASS 3e: SYSTEM Provider accepts valid company_id with secret and fails closed when missing');

  // ============================================================================
  // SECTION 4: ELIMINATION OF DEFAULT TENANT FALLBACK (FAIL-CLOSED VERIFICATION)
  // Tuân thủ Lỗi P1 (Mục 10): Xóa bỏ hoàn toàn DEFAULT_INBOX_COMPANY_ID fallback
  // ============================================================================
  console.log('\n--- Section 4: Elimination of DEFAULT_INBOX_COMPANY_ID Fallback ---');

  // 4a. addInboundMessage without company_id must throw Fail-Closed error immediately
  let errorAddNoTenant: Error | null = null;
  try {
    await InboxService.addInboundMessage({
      channel: 'facebook',
      senderId: 'fb-user-fail-closed',
      content: 'Tin nhắn không kèm company_id',
    } as any);
  } catch (err) {
    errorAddNoTenant = err as Error;
  }
  assert(errorAddNoTenant !== null, 'addInboundMessage must throw error when company_id is missing');
  assert.strictEqual(
    errorAddNoTenant.message,
    'company_id là bắt buộc để xử lý tin nhắn và bảo vệ cách ly tenant (Fail-Closed).'
  );
  console.log('✓ PASS 4a: addInboundMessage without company_id throws Fail-Closed exception (no default tenant fallback)');

  // 4b. addInboundMessage with invalid UUID company_id must throw Fail-Closed error
  let errorAddInvalidUuid: Error | null = null;
  try {
    await InboxService.addInboundMessage({
      channel: 'facebook',
      senderId: 'fb-user-fail-closed',
      company_id: 'invalid-not-uuid',
      content: 'Tin nhắn với invalid company_id',
    });
  } catch (err) {
    errorAddInvalidUuid = err as Error;
  }
  assert(errorAddInvalidUuid !== null, 'addInboundMessage must throw error when company_id is invalid UUID');
  assert.strictEqual(
    errorAddInvalidUuid.message,
    'company_id là bắt buộc để xử lý tin nhắn và bảo vệ cách ly tenant (Fail-Closed).'
  );
  console.log('✓ PASS 4b: addInboundMessage with invalid UUID company_id throws Fail-Closed exception');

  // 4c. ingestNormalizedEvent without company_id returns MISSING_COMPANY_ID
  const resultIngestNoTenant = await InboxIngressService.ingestNormalizedEvent({
    provider: 'FACEBOOK',
    company_id: '',
    external_user_id: 'fb-user-direct-999',
    message_id: 'msg-direct-no-tenant',
    content: 'Tin nhắn thiếu company_id trong normalized event',
    timestamp: new Date().toISOString(),
  });
  assert.strictEqual(resultIngestNoTenant.success, false);
  assert.strictEqual(resultIngestNoTenant.error, 'MISSING_COMPANY_ID');
  console.log('✓ PASS 4c: ingestNormalizedEvent with empty company_id returns MISSING_COMPANY_ID');

  // 4d. FacebookAdapter & ZaloAdapter deriveTenant must NOT fall back to DEFAULT_COMPANY_ID
  process.env.FB_PAGE_ID = 'page-test-no-tenant';
  delete process.env.FB_COMPANY_ID;
  (process.env as any).DEFAULT_COMPANY_ID = '99999999-9999-9999-9999-999999999999';
  await assert.rejects(
    async () => FacebookAdapter.deriveTenant({ page_id: 'page-test-no-tenant' }),
    (err: any) => err.code === 'TENANT_NOT_CONFIGURED',
    'FacebookAdapter must throw TENANT_NOT_CONFIGURED and NOT fall back to DEFAULT_COMPANY_ID'
  );
  assert.strictEqual(deriveFacebookTenant('page-test-no-tenant'), null);
  delete (process.env as any).DEFAULT_COMPANY_ID;
  delete process.env.FB_PAGE_ID;

  process.env.ZALO_OA_ID = 'oa-test-no-tenant';
  delete process.env.ZALO_COMPANY_ID;
  (process.env as any).DEFAULT_COMPANY_ID = '99999999-9999-9999-9999-999999999999';
  await assert.rejects(
    async () => ZaloAdapter.deriveTenant({ oa_id: 'oa-test-no-tenant' }),
    (err: any) => err.code === 'TENANT_NOT_CONFIGURED',
    'ZaloAdapter must throw TENANT_NOT_CONFIGURED and NOT fall back to DEFAULT_COMPANY_ID'
  );
  assert.strictEqual(deriveZaloTenant('oa-test-no-tenant'), null);
  delete (process.env as any).DEFAULT_COMPANY_ID;
  delete process.env.ZALO_OA_ID;
  console.log('✓ PASS 4d: FacebookAdapter & ZaloAdapter deriveTenant never fall back to DEFAULT_COMPANY_ID');

  // 4e. ProviderAdapterRegistry: Verifying Port & Registry Architecture
  assert(ProviderAdapterRegistry.has('FACEBOOK'), 'Registry must have FACEBOOK adapter registered');
  assert(ProviderAdapterRegistry.has('ZALO'), 'Registry must have ZALO adapter registered');
  assert(ProviderAdapterRegistry.has('SYSTEM'), 'Registry must have SYSTEM adapter registered');
  assert.strictEqual(ProviderAdapterRegistry.get('FACEBOOK'), FacebookAdapter);
  assert.strictEqual(ProviderAdapterRegistry.get('ZALO'), ZaloAdapter);
  console.log('✓ PASS 4e: ProviderAdapterRegistry dynamically resolves ports with clean Member 2/3/4 boundaries');

  // ============================================================================
  // SECTION 5: ATOMIC INBOUND PERSISTENCE & TRANSACTION ROLLBACK (P0 - Item 2)
  // Tuân thủ Lỗi P0 số 2: record_inbound_interaction_atomic & Transaction Rollback
  // ============================================================================
  console.log('\n--- Section 5: Atomic Inbound Persistence & Transaction Rollback ---');

  delete process.env.DEMO_MODE; // Non-demo production mode

  const mockDbState = {
    conversations: [] as any[],
    interactions: [] as any[],
    raw_contents: [] as any[],
  };

  let simulateRawInsertError = false;
  const mockAtomicClient: any = {
    from: (table: string) => ({
      select: () => ({
        maybeSingle: async () => ({
          data: { id: 'cust-atomic-001', name: 'Khách Test Atomic', customer_code: 'KH-000001', stage: 'LEAD_NEW' },
          error: null,
        }),
      }),
      insert: (record: any) => ({
        select: () => ({
          maybeSingle: async () => ({
            data: { id: record.id || 'cust-atomic-001', name: record.name, customer_code: 'KH-000001', stage: 'LEAD_NEW' },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (fnName: string, params: any) => {
      assert.strictEqual(fnName, 'record_inbound_interaction_atomic', 'Must call RPC record_inbound_interaction_atomic');
      assert.strictEqual(params.p_company_id, testCompanyA);

      // 1. Kiểm tra duplicate external_ref
      if (params.p_external_ref) {
        const existing = mockDbState.interactions.find(
          (i) => i.company_id === params.p_company_id && i.channel === params.p_channel && i.external_ref === params.p_external_ref
        );
        if (existing) {
          // Trả về duplicate = true, KHÔNG tăng unread_count, KHÔNG thay đổi conversations
          return {
            data: {
              conversation_id: existing.conversation_id,
              interaction_id: existing.id,
              customer_id: existing.customer_id,
              is_duplicate: true,
            },
            error: null,
          };
        }
      }

      // 2. Mô phỏng Transaction Rollback nếu raw content insert gặp lỗi
      if (simulateRawInsertError) {
        // Rollback: Zero changes to conversations, interactions, raw_contents
        return {
          data: null,
          error: new Error('Postgres raw_contents disk space full (Database Transaction Rollback)'),
        };
      }

      // 3. Khởi tạo/cập nhật conversation & interaction atomically
      let conv = mockDbState.conversations.find((c) => c.company_id === params.p_company_id && c.channel === params.p_channel);
      if (!conv) {
        conv = {
          id: 'conv-atomic-1',
          company_id: params.p_company_id,
          customer_id: params.p_customer_id,
          channel: params.p_channel,
          unread_count: 1,
          status: 'OPEN',
          last_message_at: new Date().toISOString(),
        };
        mockDbState.conversations.push(conv);
      } else {
        conv.unread_count += 1;
        conv.last_message_at = new Date().toISOString();
      }

      const intId = `int-${Date.now()}`;
      const interaction = {
        id: intId,
        company_id: params.p_company_id,
        customer_id: params.p_customer_id,
        conversation_id: conv.id,
        channel: params.p_channel,
        external_ref: params.p_external_ref,
        sanitized_content: params.p_sanitized_content,
        direction: 'INBOUND',
      };
      mockDbState.interactions.push(interaction);

      mockDbState.raw_contents.push({
        interaction_id: intId,
        company_id: params.p_company_id,
        raw_content: params.p_raw_content,
      });

      return {
        data: {
          conversation_id: conv.id,
          interaction_id: intId,
          customer_id: params.p_customer_id,
          is_duplicate: false,
        },
        error: null,
      };
    },
  };

  // 5a. Happy path inbound message via atomic RPC
  const inboundRes1 = await InboxService.addInboundMessage(
    {
      channel: 'facebook',
      senderId: 'fb-user-atomic-001',
      company_id: testCompanyA,
      content: 'Tin nhắn inbound kiểm thử atomic 0912345678',
      externalMessageId: 'msg-ext-atomic-001',
      customerId: 'cust-atomic-001',
    },
    mockAtomicClient
  );

  assert.strictEqual(inboundRes1.isNewConversation, true);
  assert.strictEqual(mockDbState.conversations.length, 1);
  assert.strictEqual(mockDbState.conversations[0].unread_count, 1);
  assert.strictEqual(mockDbState.interactions.length, 1);
  assert.strictEqual(mockDbState.raw_contents.length, 1);
  console.log('✓ PASS 5a: Happy path inbound message commits conversation, interaction, and raw_content atomically');

  // 5b. Duplicate concurrent/durable inbound webhook: RPC recognizes duplicate and does NOT increment unread_count
  const inboundRes2 = await InboxService.addInboundMessage(
    {
      channel: 'facebook',
      senderId: 'fb-user-atomic-001',
      company_id: testCompanyA,
      content: 'Tin nhắn inbound kiểm thử atomic 0912345678',
      externalMessageId: 'msg-ext-atomic-001', // Cùng external_ref
      customerId: 'cust-atomic-001',
    },
    mockAtomicClient
  );

  assert.strictEqual(inboundRes2.isNewConversation, false);
  assert.strictEqual(mockDbState.conversations[0].unread_count, 1, 'unread_count must NOT be incremented on duplicate');
  assert.strictEqual(mockDbState.interactions.length, 1, 'No duplicate interaction record inserted');
  assert.strictEqual(mockDbState.raw_contents.length, 1, 'No duplicate raw content record inserted');
  console.log('✓ PASS 5b: Duplicate external_ref returns is_duplicate = true without mutating conversations or unread_count');

  // 5c. Atomic Rollback: When raw content insert fails, entire transaction rolls back
  simulateRawInsertError = true;
  await assert.rejects(
    async () => {
      await InboxService.addInboundMessage(
        {
          channel: 'facebook',
          senderId: 'fb-user-atomic-002',
          company_id: testCompanyA,
          content: 'Tin nhắn gây lỗi rollback',
          externalMessageId: 'msg-ext-atomic-fail',
          customerId: 'cust-atomic-001',
        },
        mockAtomicClient
      );
    },
    /Không thể tiếp nhận tin nhắn inbound: Thao tác Atomic RPC thất bại \(Fail-Closed\)/,
    'Must fail closed when RPC transaction rolls back'
  );

  // Assert zero changes left behind
  assert.strictEqual(mockDbState.conversations[0].unread_count, 1, 'unread_count remains unchanged on failure');
  assert.strictEqual(mockDbState.interactions.length, 1, 'Zero orphan interaction committed');
  assert.strictEqual(mockDbState.raw_contents.length, 1, 'Zero raw content committed');
  console.log('✓ PASS 5c: Inbound atomic transaction rollback leaves zero partial records committed');

  // Restore DEMO_MODE for downstream
  process.env.DEMO_MODE = 'true';

  console.log('\n======================================================================');
  console.log('ALL P0 & P1 WEBHOOK FAIL-CLOSED TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('======================================================================\n');
}

runWebhookFailClosedTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
