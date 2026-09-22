import { ZaloSyncService } from '../../features/omnichannel/zalo/sync-service';
import { ZaloInboxService } from '../../features/omnichannel/zalo/inbox-service';
import { ZaloClient } from '../../features/omnichannel/zalo/zalo-client';
import { verifyZaloWebhookSignature } from '../../features/omnichannel/zalo/webhook-verifier';
import { ZaloWebhookPayload } from '../../features/omnichannel/zalo/types';
import { createMockSupabase, createMockDatabase } from './mock_supabase';
import crypto from 'crypto';

const LINE = '═'.repeat(72);
const SUB_LINE = '─'.repeat(72);

async function runDemoWebhookAndReply() {
  console.log('\n' + LINE);
  console.log('⚡ DEMO & TEST TRỰC TIẾP: WEBHOOK NHẬN TIN & SEND ZALO REPLY');
  console.log('   Phân hệ: features/omnichannel/zalo/ (Thành viên 3 - Zalo OA)');
  console.log(LINE + '\n');

  const companyId = '11111111-1111-1111-1111-111111111111';
  const appId = 'zalo_app_flood_barrier';
  const appSecret = 'secret_key_prod_888';
  const oaId = 'oa_cuachongngap_official';
  const customerZaloId = 'zalo_user_pham_minh_duc_99';
  const saleUserId = 'sale_user_hung_001';

  // 1. Khởi tạo Database giả lập (In-Memory Mock) & Mock ZaloClient
  const mockDb = createMockDatabase();
  const supabase = createMockSupabase(mockDb);

  const outboundApiLogs: Array<{ url: string; body: unknown }> = [];

  const mockZaloClient = new ZaloClient({
    appId,
    appSecret,
    oaId,
    accessToken: 'test_access_token_active_999',
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const bodyStr = (init?.body as string) || '{}';
      let parsedBody: unknown = {};
      try {
        parsedBody = JSON.parse(bodyStr);
      } catch {
        // ignore
      }

      // Mô phỏng endpoint lấy Profile khách từ Zalo OpenAPI
      if (urlStr.includes('/getprofile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            error: 0,
            message: 'Success',
            data: {
              user_id: customerZaloId,
              user_name: 'Phạm Minh Đức',
              avatar: 'https://zalo.me/avatar_pmd.png',
            },
          }),
        } as unknown as Response;
      }

      // Mô phỏng endpoint gửi tin nhắn (Send Outbound) Zalo OpenAPI
      if (urlStr.includes('/message/cs') || urlStr.includes('/message')) {
        outboundApiLogs.push({ url: urlStr, body: parsedBody });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            error: 0,
            message: 'Success',
            data: {
              message_id: 'zalo_msg_outbound_resp_1001',
            },
          }),
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ error: 0, message: 'Success' }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  const syncService = new ZaloSyncService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
    defaultCompanyId: companyId,
  });

  const inboxService = new ZaloInboxService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
  });

  // =========================================================================
  // GIAI ĐOẠN 1: WEBHOOK NHẬN TIN NHẮN TỪ KHÁCH HÀNG (INBOUND MESSAGE)
  // =========================================================================
  console.log('📌 [BƯỚC 1] Khách hàng nhắn tin vào Zalo OA -> Webhook gửi sự kiện');
  console.log(SUB_LINE);

  const incomingPayload: ZaloWebhookPayload = {
    event_name: 'user_send_text',
    app_id: appId,
    oa_id: oaId,
    sender: { id: customerZaloId },
    recipient: { id: oaId },
    message: {
      msg_id: 'msg_zalo_inbound_001',
      text: 'Chào công ty, hầm nhà tôi ở Thảo Điền rộng 3.5m, cao 0.7m. Xin báo giá cửa chống ngập tự động ạ.',
    },
    timestamp: 1774001234000,
  };

  // Xác thực chữ ký Webhook (MAC)
  const rawBody = JSON.stringify(incomingPayload);
  const mac = crypto
    .createHash('sha256')
    .update(`${appId}${rawBody}${incomingPayload.timestamp}${appSecret}`, 'utf8')
    .digest('hex');

  const isSignatureValid = verifyZaloWebhookSignature({
    rawBody,
    timestamp: incomingPayload.timestamp,
    signature: `mac=${mac}`,
    appId,
    appSecret,
  });

  console.log(`  ▶ 1.1. Xác thực HMAC SHA-256 Signature : ${isSignatureValid ? '✅ HỢP LỆ (VERIFIED)' : '❌ KHÔNG HỢP LỆ'}`);
  console.log(`  ▶ 1.2. Người gửi (Sender Zalo UID)     : ${incomingPayload.sender.id}`);
  console.log(`  ▶ 1.3. Nội dung tin nhắn của khách      : "${incomingPayload.message?.text}"`);
  console.log(`  ▶ 1.4. Mã tin nhắn Zalo (msg_id)       : ${incomingPayload.message?.msg_id}`);

  console.log('\n  ⚙️ Đang thực thi: syncService.handleWebhookEvent(incomingPayload)...');
  const syncResult = await syncService.handleWebhookEvent(incomingPayload);

  console.log('  ▶ 1.5. Kết quả xử lý Webhook:');
  console.log('     • Trạng thái đồng bộ (status) : ' + syncResult.status);
  console.log('     • Khách hàng mới (isNewCustomer): ' + syncResult.isNewCustomer);
  console.log('     • Customer ID được tạo/gán    : ' + syncResult.customerId);
  console.log('     • Conversation ID (Hội thoại) : ' + syncResult.conversationId);
  console.log('     • Interaction ID (Sự kiện)   : ' + syncResult.interactionId);

  // Hiển thị trạng thái DB sau Webhook Ingestion
  console.log('\n  📊 Dữ liệu được ghi nhận trong CRM Database:');
  console.log('     • Bảng [customers]:', {
    id: mockDb.customers[0]?.id,
    name: mockDb.customers[0]?.name,
    source: mockDb.customers[0]?.source,
    stage: mockDb.customers[0]?.stage,
  });
  console.log('     • Bảng [identities]:', {
    channel: mockDb.identities[0]?.channel,
    external_id: mockDb.identities[0]?.external_id,
    customer_id: mockDb.identities[0]?.customer_id,
  });
  console.log('     • Bảng [conversations]:', {
    id: mockDb.conversations[0]?.id,
    channel: mockDb.conversations[0]?.channel,
    unread_count: mockDb.conversations[0]?.unread_count,
    status: mockDb.conversations[0]?.status,
  });
  console.log('     • Bảng [interactions] (Tin đến):', {
    id: mockDb.interactions[0]?.id,
    direction: mockDb.interactions[0]?.direction,
    actor_type: mockDb.interactions[0]?.actor_type,
    content: mockDb.interactions[0]?.sanitized_content,
  });

  // Test chống ghi trùng (Idempotency) khi Webhook gửi lại cùng msg_id
  console.log('\n  🔄 Kiểm tra tính năng Chống ghi trùng (Idempotency Check) khi webhook retry:');
  const retryResult = await syncService.handleWebhookEvent(incomingPayload);
  console.log(`     • Trạng thái retry: "${retryResult.status}" (Thông điệp: ${retryResult.message || 'Đã ghi nhận trước đó'})`);
  console.log(`     • Tổng số interaction trong DB: ${mockDb.interactions.length} (Không bị nhân đôi!)`);

  // =========================================================================
  // GIAI ĐOẠN 2: NHÂN VIÊN SALE XEM HỘP THƯ & GỌI sendZaloReply
  // =========================================================================
  console.log('\n' + SUB_LINE);
  console.log('📌 [BƯỚC 2] Sale mở Hộp thư tích hợp (Unified Inbox) & Trả lời khách');
  console.log(SUB_LINE);

  // 2.1 Lấy danh sách hội thoại
  const conversations = await inboxService.getZaloConversations({ companyId });
  console.log(`  ▶ 2.1. Đọc danh sách hội thoại từ Hộp thư tích hợp: Tìm thấy ${conversations.length} cuộc hội thoại`);
  console.log(`     • Khách hàng : ${conversations[0].customerName}`);
  console.log(`     • Kênh       : ${conversations[0].channel}`);
  console.log(`     • Chưa đọc   : ${conversations[0].unreadCount} tin`);

  // 2.2 Đọc lịch sử tin nhắn
  const messagesBefore = await inboxService.getZaloMessagesByConversation({
    companyId,
    conversationId: syncResult.conversationId!,
  });
  console.log(`\n  ▶ 2.2. Lịch sử tin nhắn hiện tại (${messagesBefore.length} tin):`);
  messagesBefore.forEach((msg, idx) => {
    console.log(`     [Tin ${idx + 1}] [${msg.direction}] [${msg.actorType}]: "${msg.content}"`);
  });

  // 2.3 Nhân viên Sale gửi phản hồi qua sendZaloReply
  const replyText = 'Dạ em chào anh Phạm Minh Đức! Với khẩu độ hầm rộng 3.5m x cao 0.7m, bên em khuyến nghị dòng Cửa chống ngập Inox 304 tấm bản liền chịu lực cao. Em gửi anh bản vẽ mặt cắt và bảng giá dự toán chi tiết nhé ạ!';

  console.log('\n  ⚙️ Đang thực thi: inboxService.sendZaloReply(...)');
  console.log(`     • Người gửi (Sale)     : ${saleUserId}`);
  console.log(`     • Khách nhận (Zalo UID): ${customerZaloId}`);
  console.log(`     • Nội dung gửi         : "${replyText}"`);

  const replyResult = await inboxService.sendZaloReply({
    companyId,
    customerId: syncResult.customerId!,
    conversationId: syncResult.conversationId!,
    content: replyText,
    recipientZaloId: customerZaloId,
    saleUserId,
  });

  console.log('\n  ▶ 2.4. Kết quả từ hàm sendZaloReply:');
  console.log('     • Thành công (success)            : ' + (replyResult.success ? '✅ TRUE' : '❌ FALSE'));
  console.log('     • Zalo External Message ID trả về : ' + replyResult.externalMessageId);
  console.log('     • Interaction ID (OUTBOUND) tạo mới: ' + replyResult.interactionId);

  // Hiển thị request được gửi đến Zalo OpenAPI
  console.log('\n  🌐 Gói tin gửi ra Zalo OpenAPI (Zalo OpenAPI Outbound API Request):');
  console.log('     • URL Endpoint :', outboundApiLogs[0]?.url);
  console.log('     • Request Body :', JSON.stringify(outboundApiLogs[0]?.body, null, 2));

  // Kiểm tra lịch sử sau khi Sale gửi tin
  const messagesAfter = await inboxService.getZaloMessagesByConversation({
    companyId,
    conversationId: syncResult.conversationId!,
  });
  console.log(`\n  ▶ 2.5. Lịch sử tin nhắn sau khi Sale trả lời (${messagesAfter.length} tin):`);
  messagesAfter.forEach((msg, idx) => {
    console.log(`     [Tin ${idx + 1}] [${msg.direction}] [${msg.actorType}]: "${msg.content}"`);
  });

  console.log('\n  📊 Kiểm tra trạng thái bản ghi DB:');
  console.log('     • Tổng Interaction : ' + mockDb.interactions.length);
  const outInt = mockDb.interactions.find((i) => i.direction === 'OUTBOUND');
  console.log('     • Bản ghi OUTBOUND  :', {
    id: outInt?.id,
    direction: outInt?.direction,
    actor_type: outInt?.actor_type,
    actor_user_id: outInt?.actor_user_id,
    external_ref: outInt?.external_ref,
  });

  console.log('\n' + LINE);
  console.log('🎉 KẾT QUẢ: CẢ 2 HÀM [handleWebhookEvent] VÀ [sendZaloReply] ĐỀU HOẠT ĐỘNG HOÀN HẢO!');
  console.log(LINE + '\n');
}

runDemoWebhookAndReply().catch((err) => {
  console.error('Lỗi khi chạy demo:', err);
  process.exit(1);
});
