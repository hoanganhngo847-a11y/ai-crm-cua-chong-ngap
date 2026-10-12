import assert from 'node:assert';
import crypto from 'node:crypto';
import { InboxService, DEFAULT_INBOX_COMPANY_ID } from '../../features/inbox/services/inbox.service';
import type { InboxMessage } from '../../features/inbox/types/inbox.types';

interface TestResult {
  test: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL';
}

const resultsTable: TestResult[] = [];

function recordTest(test: string, expected: string, actual: string, passed: boolean) {
  resultsTable.push({
    test,
    expected,
    actual,
    status: passed ? 'PASS' : 'FAIL',
  });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${test}`);
  console.log(`  Expected: ${expected}`);
  console.log(`  Actual:   ${actual}`);
  assert.ok(passed, `Test failed: ${test} (Expected: ${expected}, Actual: ${actual})`);
}

/**
 * Simulates the frontend smart reconciliation logic in inbox-view.tsx
 */
function reconcileMessages(
  localMessages: InboxMessage[],
  serverMessages: InboxMessage[]
): InboxMessage[] {
  if (!localMessages || localMessages.length === 0) {
    return serverMessages;
  }

  const serverById = new Map<string, InboxMessage>();
  const serverByCommandId = new Map<string, InboxMessage>();
  for (const sm of serverMessages) {
    if (sm.id) serverById.set(sm.id, sm);
    if (sm.client_command_id) serverByCommandId.set(sm.client_command_id, sm);
  }

  const reconciled: InboxMessage[] = [];
  const matchedServerIds = new Set<string>();

  for (const localMsg of localMessages) {
    const matchedServerMsg =
      (localMsg.id ? serverById.get(localMsg.id) : null) ||
      (localMsg.client_command_id ? serverByCommandId.get(localMsg.client_command_id) : null);

    if (matchedServerMsg) {
      reconciled.push({
        ...localMsg,
        ...matchedServerMsg,
        client_command_id: localMsg.client_command_id || matchedServerMsg.client_command_id,
      });
      if (matchedServerMsg.id) matchedServerIds.add(matchedServerMsg.id);
    } else {
      reconciled.push(localMsg);
    }
  }

  for (const sm of serverMessages) {
    if (sm.id && !matchedServerIds.has(sm.id)) {
      reconciled.push(sm);
    }
  }

  return reconciled;
}

function isPendingDelivery(status?: string): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s === 'PENDING_DISPATCH' || s === 'PENDING' || s === 'PROCESSING' || s === 'RETRY' || s === 'QUEUED';
}

async function runDeliveryStatusPollingUxTests() {
  process.env.DEMO_MODE = 'true';
  InboxService.resetInboxStore();

  console.log('========================================================================================');
  console.log('TEST SUITE: OUTBOUND DELIVERY STATUS REFRESH & SMART POLLING UX');
  console.log('========================================================================================\n');

  // Setup: Tạo hội thoại Facebook với tin nhắn inbound từ khách
  const inboundRes = await InboxService.addInboundMessage({
    channel: 'facebook',
    company_id: DEFAULT_INBOX_COMPANY_ID,
    senderName: 'Khách hàng Demo',
    externalUserId: 'fb-user-123',
    externalConversationId: '1389294167596309:fb-user-123',
    externalRef: `ref-${Date.now()}`,
    content: 'Tư vấn giúp tôi cửa chống ngập',
    metadata: {
      provider: 'facebook_browser',
      page_id: '1389294167596309',
      page_name: 'MD Tech Cửa Chống Ngập',
      customer_fb_id: 'fb-user-123',
      source: 'meta_business_suite_browser',
    },
  });
  const conversationId = inboundRes.conversationId;

  // --------------------------------------------------------------------------
  // Check 1: Message mới ban đầu có delivery_status = PENDING_DISPATCH
  // --------------------------------------------------------------------------
  const clientCommandId = crypto.randomUUID();
  const sentMessage = await InboxService.sendMessage({
    conversation_id: conversationId,
    company_id: DEFAULT_INBOX_COMPANY_ID,
    content: 'Chào bạn, cửa chống ngập tự động bên mình giá 12.000.000đ',
    sender_type: 'sale',
    clientCommandId,
  });

  recordTest(
    '1. Message mới ban đầu = PENDING_DISPATCH',
    'delivery_status: PENDING_DISPATCH',
    `delivery_status: ${sentMessage.delivery_status}`,
    sentMessage.delivery_status === 'PENDING_DISPATCH'
  );

  // --------------------------------------------------------------------------
  // Check 2 & 3: Worker mark SENT và API history trả lại SENT
  // --------------------------------------------------------------------------
  const claimedJobs = await InboxService.claimFacebookBrowserOutboxJobs('worker-test-01', 5);
  const targetJob = claimedJobs.find((j) => j.idempotency_key === clientCommandId || j.content.includes('12.000.000đ'));
  assert.ok(targetJob, 'Target job must be claimed by worker');

  await InboxService.completeFacebookBrowserOutboxJob(targetJob.id, 'mid-fb-sent-123');

  const historyAfterSent = await InboxService.getMessagesByConversationId(
    DEFAULT_INBOX_COMPANY_ID,
    conversationId,
    'sale'
  );
  const outboundInHistory = historyAfterSent.find((m) => m.id === sentMessage.id || m.client_command_id === clientCommandId);
  assert.ok(outboundInHistory, 'Outbound message must exist in conversation history');

  recordTest(
    '2 & 3. Worker mark SENT -> API history trả lại SENT',
    'delivery_status: SENT',
    `delivery_status: ${outboundInHistory.delivery_status}`,
    outboundInHistory.delivery_status === 'SENT'
  );

  // --------------------------------------------------------------------------
  // Check 4 & 5: Frontend polling cập nhật bubble hiện tại, không tạo duplicate bubble
  // --------------------------------------------------------------------------
  // Optimistic local state ban đầu chỉ có message với PENDING_DISPATCH
  const initialLocalMessages: InboxMessage[] = [
    {
      id: inboundRes.interactionId,
      conversation_id: conversationId,
      customer_id: inboundRes.customerId,
      channel: 'facebook',
      sender_type: 'customer',
      content: 'Tư vấn giúp tôi cửa chống ngập',
      created_at: new Date(Date.now() - 60000).toISOString(),
      direction: 'inbound',
    },
    {
      ...sentMessage,
      delivery_status: 'PENDING_DISPATCH', // Optimistic ban đầu
    },
  ];

  // Thực hiện reconcile khi server trả về history có trạng thái SENT
  const reconciled = reconcileMessages(initialLocalMessages, historyAfterSent);

  const outboundReconciled = reconciled.filter((m) => (m.direction || '').toLowerCase() === 'outbound');
  const hasExactOneOutbound = outboundReconciled.length === 1;
  const isUpdatedToSent = outboundReconciled[0]?.delivery_status === 'SENT';

  recordTest(
    '4. Frontend polling cập nhật bubble hiện tại sang SENT',
    'delivery_status: SENT',
    `delivery_status: ${outboundReconciled[0]?.delivery_status}`,
    isUpdatedToSent
  );

  recordTest(
    '5. Không tạo duplicate bubble khi reconcile',
    'outbound bubble count: 1',
    `outbound bubble count: ${outboundReconciled.length}`,
    hasExactOneOutbound
  );

  // --------------------------------------------------------------------------
  // Check 6: Polling dừng sau khi tất cả outbound messages đã SENT
  // --------------------------------------------------------------------------
  const shouldPollAfterSent = reconciled.some(
    (m) => (m.direction || '').toLowerCase() === 'outbound' && isPendingDelivery(m.delivery_status)
  );

  recordTest(
    '6. Polling dừng sau khi message chuyển sang SENT',
    'shouldPoll: false (timer cleared)',
    `shouldPoll: ${shouldPollAfterSent}`,
    !shouldPollAfterSent
  );

  // --------------------------------------------------------------------------
  // Check 7: FAILED hiển thị đúng
  // --------------------------------------------------------------------------
  const failCommandId = crypto.randomUUID();
  const failMsg = await InboxService.sendMessage({
    conversation_id: conversationId,
    company_id: DEFAULT_INBOX_COMPANY_ID,
    content: 'Tin nhắn gửi thử thất bại',
    sender_type: 'sale',
    clientCommandId: failCommandId,
  });

  const jobsToFail = await InboxService.claimFacebookBrowserOutboxJobs('worker-test-01', 5);
  const targetFailJob = jobsToFail.find((j) => j.idempotency_key === failCommandId);
  assert.ok(targetFailJob, 'Target fail job must be claimed');

  // Đánh dấu fail vĩnh viễn (isTransient = false)
  await InboxService.failFacebookBrowserOutboxJob(targetFailJob.id, 'NETWORK_UNREACHABLE', false);

  const historyAfterFail = await InboxService.getMessagesByConversationId(
    DEFAULT_INBOX_COMPANY_ID,
    conversationId,
    'sale'
  );
  const failedInHistory = historyAfterFail.find((m) => m.client_command_id === failCommandId || m.id === failMsg.id);

  recordTest(
    '7. FAILED hiển thị đúng trong history',
    'delivery_status: FAILED',
    `delivery_status: ${failedInHistory?.delivery_status}`,
    failedInHistory?.delivery_status === 'FAILED'
  );

  // --------------------------------------------------------------------------
  // Check 8: RECONCILE_REQUIRED hiển thị đúng
  // --------------------------------------------------------------------------
  const orphanCommandId = crypto.randomUUID();
  const orphanMsg = await InboxService.sendMessage({
    conversation_id: conversationId,
    company_id: DEFAULT_INBOX_COMPANY_ID,
    content: 'Tin nhắn cần đối soát',
    sender_type: 'sale',
    clientCommandId: orphanCommandId,
  });

  const orphanJobs = await InboxService.claimFacebookBrowserOutboxJobs('worker-test-01', 5);
  const targetOrphan = orphanJobs.find((j) => j.idempotency_key === orphanCommandId);
  assert.ok(targetOrphan, 'Target orphan job must be claimed');

  targetOrphan.reconciliation_status = 'RECONCILE_REQUIRED';

  const historyAfterOrphan = await InboxService.getMessagesByConversationId(
    DEFAULT_INBOX_COMPANY_ID,
    conversationId,
    'sale'
  );
  const orphanInHistory = historyAfterOrphan.find((m) => m.client_command_id === orphanCommandId || m.id === orphanMsg.id);

  recordTest(
    '8. RECONCILE_REQUIRED hiển thị đúng trong history',
    'delivery_status: RECONCILE_REQUIRED',
    `delivery_status: ${orphanInHistory?.delivery_status}`,
    orphanInHistory?.delivery_status === 'RECONCILE_REQUIRED'
  );

  // --------------------------------------------------------------------------
  // Check 9: Inbound message không bị ảnh hưởng (delivery_status is undefined)
  // --------------------------------------------------------------------------
  const inboundInHistory = historyAfterSent.find((m) => (m.direction || '').toLowerCase() === 'inbound');
  assert.ok(inboundInHistory, 'Inbound message must exist');

  recordTest(
    '9. Inbound message không bị ảnh hưởng (delivery_status undefined)',
    'delivery_status: undefined',
    `delivery_status: ${inboundInHistory.delivery_status}`,
    inboundInHistory.delivery_status === undefined
  );

  // --------------------------------------------------------------------------
  // Check 10: Zalo outbound không có browser outbox row -> delivery_status === undefined (KHÔNG tự thành SENT)
  // --------------------------------------------------------------------------
  const zaloInbound = await InboxService.addInboundMessage({
    channel: 'zalo',
    company_id: DEFAULT_INBOX_COMPANY_ID,
    senderName: 'Khách Zalo Test',
    senderId: 'zalo-user-999',
    content: 'Xin chào qua Zalo',
  });

  const zaloReply = await InboxService.sendMessage({
    conversation_id: zaloInbound.conversationId,
    company_id: DEFAULT_INBOX_COMPANY_ID,
    content: 'Chào anh qua Zalo OA ạ',
    sender_type: 'sale',
  });

  const zaloHistory = await InboxService.getMessagesByConversationId(
    DEFAULT_INBOX_COMPANY_ID,
    zaloInbound.conversationId,
    'sale'
  );

  const zaloOutbound = zaloHistory.find((m) => m.id === zaloReply.id);
  assert.ok(zaloOutbound, 'Zalo outbound message must exist in history');

  recordTest(
    '10. Zalo outbound không có browser outbox row -> delivery_status === undefined (KHÔNG tự thành SENT)',
    'delivery_status: undefined',
    `delivery_status: ${zaloOutbound.delivery_status}`,
    zaloOutbound.delivery_status === undefined
  );

  // --------------------------------------------------------------------------
  // Check 11: Graph API / non-browser outbound -> delivery_status === undefined (KHÔNG tự thành SENT)
  // --------------------------------------------------------------------------
  const graphInbound = await InboxService.addInboundMessage({
    channel: 'facebook',
    company_id: DEFAULT_INBOX_COMPANY_ID,
    senderName: 'Khách Graph API',
    externalUserId: 'fb-graph-user-456',
    externalConversationId: 'graph-conv-456',
    content: 'Hỏi giá qua Graph API',
    metadata: {
      provider: 'facebook_graph', // Non-browser provider
    },
  });

  const graphReply = await InboxService.sendMessage({
    conversation_id: graphInbound.conversationId,
    company_id: DEFAULT_INBOX_COMPANY_ID,
    content: 'Chào anh qua Facebook Graph API',
    sender_type: 'sale',
  });

  const graphHistory = await InboxService.getMessagesByConversationId(
    DEFAULT_INBOX_COMPANY_ID,
    graphInbound.conversationId,
    'sale'
  );

  const graphOutbound = graphHistory.find((m) => m.id === graphReply.id);
  assert.ok(graphOutbound, 'Graph API outbound message must exist in history');

  recordTest(
    '11. Graph API/non-browser outbound -> delivery_status === undefined (KHÔNG tự thành SENT)',
    'delivery_status: undefined',
    `delivery_status: ${graphOutbound.delivery_status}`,
    graphOutbound.delivery_status === undefined
  );

  // --------------------------------------------------------------------------
  // Check 12: DB canonical: Outbound interaction có row SENT -> trả lại SENT
  // --------------------------------------------------------------------------
  const convDbId = 'conv-db-0000-0000-0000-000000000001';
  const outboundIntId = 'int-db-outbound-0000-0000-0001';

  function createMockDbClient(options: {
    deliveries?: Array<{ interaction_id: string; delivery_status?: string; status?: string; reconciliation_status?: string }>;
    deliveryError?: { message: string };
  }) {
    const createChain = () => {
      const chain: any = {
        eq: () => chain,
        in: async () => {
          if (options.deliveryError) {
            return { data: null, error: options.deliveryError };
          }
          return { data: options.deliveries || [], error: null };
        },
        order: async () => ({
          data: [
            {
              id: outboundIntId,
              company_id: DEFAULT_INBOX_COMPANY_ID,
              customer_id: 'cust-db-01',
              conversation_id: convDbId,
              channel: 'facebook',
              type: 'MESSAGE',
              direction: 'OUTBOUND',
              sanitized_content: 'Tin nhắn canonical DB outbound test',
              sanitization_status: 'SUCCEEDED',
              actor_type: 'SALE',
              created_at: new Date().toISOString(),
            },
          ],
          error: null,
        }),
        maybeSingle: async () => ({
          data: {
            id: convDbId,
            company_id: DEFAULT_INBOX_COMPANY_ID,
            customer_id: 'cust-db-01',
            channel: 'facebook',
            unread_count: 0,
          },
          error: null,
        }),
      };
      return chain;
    };

    return {
      from: (_table: string) => ({
        select: (_cols?: string) => createChain(),
        update: () => createChain(),
      }),
    } as any;
  }

  process.env.DEMO_MODE = 'false';

  const dbClientSent = createMockDbClient({
    deliveries: [{ interaction_id: outboundIntId, delivery_status: 'SENT', status: 'SENT' }],
  });
  const msgsSent = await InboxService.getMessagesByConversationId(
    DEFAULT_INBOX_COMPANY_ID,
    convDbId,
    'sale',
    dbClientSent
  );
  const msgSent = msgsSent.find((m) => m.id === outboundIntId);

  recordTest(
    '12. DB canonical: Outbound interaction có row SENT -> trả lại SENT',
    'delivery_status: SENT',
    `delivery_status: ${msgSent?.delivery_status}`,
    msgSent?.delivery_status === 'SENT'
  );

  // --------------------------------------------------------------------------
  // Check 13: DB canonical: Outbound interaction KHÔNG có delivery row -> delivery_status === undefined
  // --------------------------------------------------------------------------
  const dbClientEmpty = createMockDbClient({ deliveries: [] });
  const msgsEmpty = await InboxService.getMessagesByConversationId(
    DEFAULT_INBOX_COMPANY_ID,
    convDbId,
    'sale',
    dbClientEmpty
  );
  const msgEmpty = msgsEmpty.find((m) => m.id === outboundIntId);

  recordTest(
    '13. DB canonical: Outbound interaction KHÔNG có delivery row -> delivery_status === undefined (KHÔNG fail-open thành SENT)',
    'delivery_status: undefined',
    `delivery_status: ${msgEmpty?.delivery_status}`,
    msgEmpty?.delivery_status === undefined
  );

  // --------------------------------------------------------------------------
  // Check 14: DB canonical: Lỗi batch query outbound_deliveries -> không trả SENT giả
  // --------------------------------------------------------------------------
  const dbClientErr = createMockDbClient({ deliveryError: { message: 'Database connection failed' } });
  const msgsErr = await InboxService.getMessagesByConversationId(
    DEFAULT_INBOX_COMPANY_ID,
    convDbId,
    'sale',
    dbClientErr
  );
  const msgErr = msgsErr.find((m) => m.id === outboundIntId);

  recordTest(
    '14. DB canonical: Lỗi batch query outbound_deliveries -> không trả SENT giả (delivery_status === undefined)',
    'delivery_status: undefined',
    `delivery_status: ${msgErr?.delivery_status}`,
    msgErr?.delivery_status === undefined
  );

  // Khôi phục DEMO_MODE
  process.env.DEMO_MODE = 'true';

  console.log('\n========================================================================================');
  console.log('ACCEPTANCE MATRIX: DELIVERY STATUS REFRESH & SMART POLLING UX');
  console.log('========================================================================================\n');
  console.table(resultsTable);

  const allPassed = resultsTable.every((r) => r.status === 'PASS');
  assert.ok(allPassed, 'All delivery status UX tests must PASS');
  console.log(`\nOVERALL STATUS: ALL ${resultsTable.length} TESTS PASSED (100%)\n`);
}

runDeliveryStatusPollingUxTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
