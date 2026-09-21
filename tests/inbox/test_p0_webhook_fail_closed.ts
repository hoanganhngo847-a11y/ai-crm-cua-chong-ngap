import assert from 'node:assert';
import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import { GET as webhookGetHandler, POST as webhookPostHandler } from '../../app/api/inbox/webhook/route';
import { InboxIngressService } from '../../features/inbox/services/inbox-ingress.service';
import { InboxService } from '../../features/inbox/services/inbox.service';

async function runWebhookFailClosedTests() {
  console.log('======================================================================');
  console.log('STARTING P0 & P1 TEST SUITE: WEBHOOK INGRESS FAIL-CLOSED & NORMALIZED CONTRACT');
  console.log('======================================================================');

  const testCompanyA = '11111111-1111-1111-1111-111111111111';
  const testCompanyB = '22222222-2222-2222-2222-222222222222';
  const testFbSecret = 'test_fb_secret_key_super_secure_999';
  const testZaloSecret = 'test_zalo_secret_key_super_secure_888';
  const testVerifyToken = 'facebook_verify_token_prod_123';

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
    company_id: testCompanyA,
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

  // 2d. Missing company_id (Tenant Isolation): must return 400 MISSING_COMPANY_ID
  const payloadNoTenant = {
    provider: 'FACEBOOK',
    external_user_id: 'fb-user-101',
    message_id: 'msg-fb-no-tenant',
    content: 'Cửa chống ngập không có tenant',
  };
  const rawBodyNoTenant = JSON.stringify(payloadNoTenant);
  const hmacNoTenant = crypto.createHmac('sha256', testFbSecret).update(rawBodyNoTenant).digest('hex');

  const reqPostNoTenant = new NextRequest('http://localhost:3000/api/inbox/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel': 'facebook',
      'x-hub-signature-256': `sha256=${hmacNoTenant}`,
    },
    body: rawBodyNoTenant,
  });
  const resPostNoTenant = await webhookPostHandler(reqPostNoTenant);
  assert.strictEqual(resPostNoTenant.status, 400, 'Missing company_id must be rejected with 400');
  const dataPostNoTenant = await resPostNoTenant.json();
  assert.strictEqual(dataPostNoTenant.error, 'MISSING_COMPANY_ID');
  console.log('✓ PASS 2d: Missing company_id rejected with 400 MISSING_COMPANY_ID');

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
  console.log('✓ PASS 3a: Valid Facebook HMAC ingress successfully processed and saved with strict tenant isolation');

  // 3b. Idempotency test: Re-send same message_id -> returns duplicate: true (200 OK)
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
  console.log('✓ PASS 3b: Idempotency verified: duplicate message_id detected, no duplicate records created');

  // 3c. Valid Zalo OA Webhook Ingress
  process.env.ZALO_APP_SECRET = testZaloSecret;

  const samplePayloadZalo = {
    provider: 'ZALO',
    company_id: testCompanyB,
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

  // 4d. deriveTenantFromIntegrationAccount must NOT fall back to DEFAULT_COMPANY_ID
  process.env.FB_PAGE_ID = 'page-test-no-tenant';
  delete process.env.FB_COMPANY_ID;
  (process.env as any).DEFAULT_COMPANY_ID = '99999999-9999-9999-9999-999999999999';
  const derivedTenant = InboxIngressService.deriveTenantFromIntegrationAccount('FACEBOOK', 'page-test-no-tenant');
  assert.strictEqual(derivedTenant, null, 'Must NOT fall back to DEFAULT_COMPANY_ID');
  delete (process.env as any).DEFAULT_COMPANY_ID;
  delete process.env.FB_PAGE_ID;
  console.log('✓ PASS 4d: deriveTenantFromIntegrationAccount never falls back to DEFAULT_COMPANY_ID');

  console.log('\n======================================================================');
  console.log('ALL P0 & P1 WEBHOOK FAIL-CLOSED TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('======================================================================\n');
}

runWebhookFailClosedTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
