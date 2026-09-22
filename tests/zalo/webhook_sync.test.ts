import assert from 'assert';
import { ZaloSyncService } from '../../features/omnichannel/zalo/sync-service';
import { ZaloClient } from '../../features/omnichannel/zalo/zalo-client';
import { verifyZaloWebhookSignature } from '../../features/omnichannel/zalo/webhook-verifier';
import { ZaloWebhookPayload } from '../../features/omnichannel/zalo/types';
import { createMockSupabase, createMockDatabase } from './mock_supabase';
import crypto from 'crypto';

async function runWebhookSyncTests() {
  console.log('--- TEST SUITE 1: ZALO WEBHOOK & SYNC SERVICE ---');

  const companyId = '11111111-1111-1111-1111-111111111111';
  const mockDb = createMockDatabase();
  const supabase = createMockSupabase(mockDb);

  // Mock ZaloClient
  const mockZaloClient = new ZaloClient({
    oaId: 'test_oa_id',
    appId: 'test_app_id',
    appSecret: 'test_secret',
    accessToken: 'test_access_token_123',
    fetchFn: (async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          error: 0,
          message: 'Success',
          data: {
            user_id: 'user_zalo_999',
            user_name: 'Trần Văn Khách',
          },
        }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  const syncService = new ZaloSyncService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
    defaultCompanyId: companyId,
  });

  // -------------------------------------------------------------
  // Test 1: Webhook receives a new incoming message from user
  // -------------------------------------------------------------
  console.log('Test 1.1: Webhook nhận tin mới -> parse chuẩn hóa -> tạo Customer, Identity, Conversation, Interaction');

  const incomingPayload: ZaloWebhookPayload = {
    event_name: 'user_send_text',
    app_id: 'test_app_id',
    oa_id: 'test_oa_id',
    sender: { id: 'user_zalo_999' },
    recipient: { id: 'test_oa_id' },
    message: {
      msg_id: 'msg_webhook_001',
      text: 'Chào công ty, tôi cần báo giá cửa chống ngập cho gara',
    },
    timestamp: 1774000000000,
  };

  const syncResult1 = await syncService.handleWebhookEvent(incomingPayload);

  assert.strictEqual(syncResult1.status, 'synced', 'Sync status should be "synced"');
  assert.strictEqual(syncResult1.isNewCustomer, true, 'Should create new Customer');
  assert.ok(syncResult1.customerId, 'CustomerId must be populated');
  assert.ok(syncResult1.conversationId, 'ConversationId must be populated');
  assert.ok(syncResult1.interactionId, 'InteractionId must be populated');

  // Verify DB state
  assert.strictEqual(mockDb.customers.length, 1, 'Should have exactly 1 Customer in DB');
  assert.strictEqual(mockDb.customers[0].name, 'Trần Văn Khách', 'Customer name should match profile');
  assert.strictEqual(mockDb.customers[0].source, 'ZALO_OA', 'Customer source must be ZALO_OA');
  assert.strictEqual(mockDb.customers[0].stage, 'LEAD_NEW', 'Customer stage must be LEAD_NEW');

  assert.strictEqual(mockDb.identities.length, 1, 'Should have exactly 1 Identity in DB');
  assert.strictEqual(mockDb.identities[0].channel, 'ZALO', 'Identity channel must be ZALO');
  assert.strictEqual(mockDb.identities[0].external_id, 'user_zalo_999', 'Identity external_id must match sender');
  assert.strictEqual(mockDb.identities[0].customer_id, syncResult1.customerId);

  assert.strictEqual(mockDb.conversations.length, 1, 'Should have exactly 1 Conversation in DB');
  assert.strictEqual(mockDb.conversations[0].unread_count, 1, 'Unread count should be 1');
  assert.strictEqual(mockDb.conversations[0].channel, 'ZALO');

  assert.strictEqual(mockDb.interactions.length, 1, 'Should have exactly 1 Interaction in DB');
  assert.strictEqual(mockDb.interactions[0].direction, 'INBOUND', 'Direction must be INBOUND');
  assert.strictEqual(mockDb.interactions[0].actor_type, 'CUSTOMER', 'Actor type must be CUSTOMER');
  assert.strictEqual(mockDb.interactions[0].external_ref, 'msg_webhook_001', 'external_ref must match msg_id');
  assert.strictEqual(mockDb.interactions[0].sanitized_content, 'Chào công ty, tôi cần báo giá cửa chống ngập cho gara');

  console.log('✓ Test 1.1 Passed: New customer, identity, conversation, and interaction created.');

  // -------------------------------------------------------------
  // Test 2: Idempotency Check - Duplicate webhook with same msg_id
  // -------------------------------------------------------------
  console.log('Test 1.2: Webhook gửi lại cùng message ID -> kiểm tra Idempotent chống ghi trùng');

  const duplicateResult = await syncService.handleWebhookEvent(incomingPayload);

  assert.strictEqual(duplicateResult.status, 'duplicate', 'Status must be "duplicate"');
  assert.strictEqual(duplicateResult.interactionId, syncResult1.interactionId, 'Should return existing interactionId');

  // Verify that NO new records were added
  assert.strictEqual(mockDb.customers.length, 1, 'Customer count must remain 1');
  assert.strictEqual(mockDb.identities.length, 1, 'Identity count must remain 1');
  assert.strictEqual(mockDb.conversations.length, 1, 'Conversation count must remain 1');
  assert.strictEqual(mockDb.conversations[0].unread_count, 1, 'Unread count must NOT be incremented on duplicate');
  assert.strictEqual(mockDb.interactions.length, 1, 'Interaction count must remain 1');

  console.log('✓ Test 1.2 Passed: Idempotency correctly prevented duplicate ingestion.');

  // -------------------------------------------------------------
  // Test 3: Webhook Signature Verification (MAC)
  // -------------------------------------------------------------
  console.log('Test 1.3: Xác thực chữ ký webhook Zalo (MAC SHA-256)');

  const rawBody = JSON.stringify(incomingPayload);
  const timestamp = incomingPayload.timestamp;
  const appId = 'test_app_id';
  const appSecret = 'super_secret_key_123';

  // Compute valid MAC: sha256(appId + rawBody + timestamp + appSecret)
  const validMac = crypto
    .createHash('sha256')
    .update(`${appId}${rawBody}${timestamp}${appSecret}`, 'utf8')
    .digest('hex');

  const isValid = verifyZaloWebhookSignature({
    rawBody,
    timestamp,
    signature: `mac=${validMac}`,
    appId,
    appSecret,
  });

  assert.strictEqual(isValid, true, 'Valid signature must return true');

  const isInvalid = verifyZaloWebhookSignature({
    rawBody: rawBody + 'tampered',
    timestamp,
    signature: `mac=${validMac}`,
    appId,
    appSecret,
  });

  assert.strictEqual(isInvalid, false, 'Tampered payload must fail signature check');

  console.log('✓ Test 1.3 Passed: Webhook signature verification verified.');

  console.log('\nALL TESTS IN SUITE 1 PASSED SUCCESSFULLY! ✓\n');
}

runWebhookSyncTests().catch((err) => {
  console.error('Test Suite 1 Failed:', err);
  process.exit(1);
});
