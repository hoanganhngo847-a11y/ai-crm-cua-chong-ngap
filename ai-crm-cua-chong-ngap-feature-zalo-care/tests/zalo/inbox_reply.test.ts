import assert from 'assert';
import { ZaloInboxService } from '../../features/omnichannel/zalo/inbox-service';
import { ZaloClient } from '../../features/omnichannel/zalo/zalo-client';
import { ServerAuthError } from '../../lib/server-auth/errors';
import { createMockSupabase, createMockDatabase } from './mock_supabase';

async function runInboxReplyTests() {
  console.log('--- TEST SUITE 2: ZALO INBOX & OUTBOUND SALE REPLY ---');

  const companyId = '11111111-1111-1111-1111-111111111111';
  const customerId = 'cust_123456';
  const conversationId = 'conv_123456';
  const saleUserId = 'sale_user_001';
  const recipientZaloId = 'zalo_user_999';

  interface ZaloApiCallRecord {
    url: string | URL | Request;
    headers?: HeadersInit;
    body: {
      recipient: { user_id: string };
      message: { text: string };
    };
  }

  let zaloApiCalledWith: ZaloApiCallRecord | null = null;

  // Mock ZaloClient
  const mockZaloClient = new ZaloClient({
    accessToken: 'test_sale_access_token',
    fetchFn: (async (url, init) => {
      const reqInit = init as { headers?: HeadersInit; body?: string };
      zaloApiCalledWith = {
        url,
        headers: reqInit?.headers,
        body: JSON.parse(reqInit?.body || '{}'),
      };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          error: 0,
          message: 'Success',
          data: {
            message_id: 'zalo_msg_out_8888',
          },
        }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  const mockDb = createMockDatabase({
    customers: [
      { id: customerId, company_id: companyId, name: 'Nguyễn Văn Khách', stage: 'NEGOTIATING' },
    ],
    conversations: [
      {
        id: conversationId,
        company_id: companyId,
        customer_id: customerId,
        channel: 'ZALO',
        external_conversation_id: recipientZaloId,
        last_message_at: '2026-09-18T10:00:00Z',
        unread_count: 2,
        status: 'OPEN',
      },
    ],
    interactions: [
      {
        id: 'int_001',
        company_id: companyId,
        customer_id: customerId,
        conversation_id: conversationId,
        channel: 'ZALO',
        type: 'MESSAGE',
        direction: 'INBOUND',
        sanitized_content: 'Báo giá cho tôi cửa 2m x 0.6m',
        external_ref: 'zalo_in_111',
        actor_type: 'CUSTOMER',
        actor_user_id: null,
        created_at: '2026-09-18T10:00:00Z',
      },
    ],
  });

  const supabase = createMockSupabase(mockDb);
  const inboxService = new ZaloInboxService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
  });

  // -------------------------------------------------------------
  // Test 2.1: Fetch conversations for Member 2 (Unified Inbox)
  // -------------------------------------------------------------
  console.log('Test 2.1: getZaloConversations() lấy danh sách hội thoại Zalo cho Hộp thư tích hợp');

  const convList = await inboxService.getZaloConversations({ companyId });
  assert.strictEqual(convList.length, 1, 'Should return 1 conversation');
  assert.strictEqual(convList[0].id, conversationId);
  assert.strictEqual(convList[0].channel, 'ZALO');
  assert.strictEqual(convList[0].customerName, 'Nguyễn Văn Khách');
  assert.strictEqual(convList[0].unreadCount, 2);

  console.log('✓ Test 2.1 Passed: Conversations retrieved correctly.');

  // -------------------------------------------------------------
  // Test 2.2: Fetch messages for a specific conversation
  // -------------------------------------------------------------
  console.log('Test 2.2: getZaloMessagesByConversation() lấy tin nhắn hội thoại');

  const messages = await inboxService.getZaloMessagesByConversation({
    companyId,
    conversationId,
  });
  assert.strictEqual(messages.length, 1, 'Should return 1 message');
  assert.strictEqual(messages[0].direction, 'INBOUND');
  assert.strictEqual(messages[0].actorType, 'CUSTOMER');
  assert.strictEqual(messages[0].content, 'Báo giá cho tôi cửa 2m x 0.6m');

  console.log('✓ Test 2.2 Passed: Messages retrieved correctly.');

  // -------------------------------------------------------------
  // Test 2.3: Sale replies from Unified Inbox via sendZaloReply
  // -------------------------------------------------------------
  console.log('Test 2.3: sendZaloReply() gửi tin thành công và ghi nhận Interaction (direction: OUTBOUND, actor_type: SALE)');

  const replyContent = 'Chào anh, cửa kích thước 2m x 0.6m bên em dùng bản inox 304 tiêu chuẩn, bảo hành 5 năm ạ.';
  const sendResult = await inboxService.sendZaloReply(
    {
      conversationId,
      content: replyContent,
    },
    {
      actor: {
        userId: saleUserId,
        companyId,
        role: 'SALE',
      },
    }
  );

  assert.strictEqual(sendResult.success, true, 'sendZaloReply must succeed');
  assert.strictEqual(sendResult.externalMessageId, 'zalo_msg_out_8888', 'Must capture Zalo OpenAPI message ID');
  assert.ok(sendResult.interactionId, 'Interaction ID must be returned');

  // Verify Zalo OpenAPI call
  const callRecord = zaloApiCalledWith as unknown as ZaloApiCallRecord;
  assert.ok(callRecord, 'Zalo API must have been invoked');
  assert.strictEqual(callRecord.body.recipient.user_id, recipientZaloId);
  assert.strictEqual(callRecord.body.message.text, replyContent);

  // Verify DB Outbound Delivery Record in outbox
  assert.strictEqual(mockDb.zalo_outbound_deliveries.length, 1, 'Should create 1 outbound delivery record');
  assert.strictEqual(mockDb.zalo_outbound_deliveries[0].status, 'SENT', 'Outbox delivery status must be SENT');
  assert.strictEqual(mockDb.zalo_outbound_deliveries[0].provider_msg_id, 'zalo_msg_out_8888');

  // Verify DB Interaction record
  assert.strictEqual(mockDb.interactions.length, 2, 'Should now have 2 interactions');
  const outboundInteraction = mockDb.interactions[1];
  assert.strictEqual(outboundInteraction.id, sendResult.interactionId);
  assert.strictEqual(outboundInteraction.direction, 'OUTBOUND', 'Direction must be OUTBOUND');
  assert.strictEqual(outboundInteraction.actor_type, 'SALE', 'Actor type must be SALE');
  assert.strictEqual(outboundInteraction.actor_user_id, saleUserId, 'actor_user_id must match saleUserId');
  assert.strictEqual(outboundInteraction.external_ref, 'zalo_msg_out_8888');
  assert.strictEqual(outboundInteraction.sanitized_content, replyContent);

  // Verify Conversation last_message_at updated
  const updatedConv = mockDb.conversations[0];
  assert.notStrictEqual(updatedConv.last_message_at, '2026-09-18T10:00:00Z', 'last_message_at should be updated to now');

  console.log('✓ Test 2.3 Passed: Outbound sale reply sent and recorded correctly via durable outbox.');

  // -------------------------------------------------------------
  // Test 2.4: Cross-Tenant Protection (P0 #4)
  // -------------------------------------------------------------
  console.log('Test 2.4: Chặn gửi tin nhắn vào conversation của tenant khác (403 Forbidden)');

  let crossTenantBlocked = false;
  try {
    await inboxService.sendZaloReply(
      {
        conversationId,
        content: 'Nỗ lực tấn công IDOR xuyên tenant',
      },
      {
        actor: {
          userId: 'attacker_sale_user',
          companyId: 'different-company-uuid-9999',
          role: 'SALE',
        },
      }
    );
  } catch (err: unknown) {
    if (
      err instanceof ServerAuthError ||
      (err instanceof Error && err.message.includes('forbidden'))
    ) {
      crossTenantBlocked = true;
    }
  }

  assert.strictEqual(crossTenantBlocked, true, 'Cross-tenant reply must be blocked with 403 Forbidden');
  console.log('✓ Test 2.4 Passed: Cross-tenant IDOR attack blocked successfully.');

  console.log('\nALL TESTS IN SUITE 2 PASSED SUCCESSFULLY! ✓\n');
}

runInboxReplyTests().catch((err) => {
  console.error('Test Suite 2 Failed:', err);
  process.exit(1);
});
