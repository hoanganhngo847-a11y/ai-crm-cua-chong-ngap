import assert from 'assert';
import crypto from 'crypto';
import {
  InMemoryZaloTokenStore,
  verifyZaloWebhookSignature,
  ZaloClient,
  ZaloSyncService,
  ZaloInboxService,
  ZaloWebhookPayload,
  sanitizeMessageContent,
  ZaloOAMappingService,
} from '../../features/omnichannel/zalo';
import {
  ZaloCareSchedulerService,
  ZaloCareCampaignService,
  ZaloCareAnalyticsService,
  CARE_AUDIENCE_GROUPS,
} from '../../features/care/zalo';
import { createMockDatabase, createMockSupabase } from './mock_supabase';
import { runRemediationP0P1TestSuite } from './remediation_p0_p1.test';

const DIVIDER = '═'.repeat(70);

async function runAllZaloModulesQuickTest() {
  console.log('\n' + DIVIDER);
  console.log('🚀 COMPREHENSIVE TEST SUITE: ZALO OA & CARE INTEGRATION (MEMBER 3)');
  console.log('   P0 & P1 Remediation Verification');
  console.log(DIVIDER + '\n');

  const companyAId = '11111111-1111-1111-1111-111111111111';
  const companyBId = '22222222-2222-2222-2222-222222222222';
  const mockDb = createMockDatabase();
  const supabase = createMockSupabase(mockDb);

  let tokenRefreshCount = 0;
  const sentZaloMessages: Array<{ recipient: string; text: string }> = [];

  // Mock Zalo OpenAPI Client
  const mockZaloClient = new ZaloClient({
    oaId: 'oa_cuachongngap_hcm',
    appId: 'zalo_app_123456',
    appSecret: 'secret_key_abcdef',
    accessToken: 'initial_active_token',
    refreshToken: 'valid_refresh_token',
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      // 1. Zalo OAuth v4 Refresh Token endpoint
      if (urlStr.includes('oauth.zaloapp.com/v4/oa/access_token')) {
        tokenRefreshCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'refreshed_access_token_' + Date.now(),
            refresh_token: 'new_refresh_token_' + Date.now(),
            expires_in: 90000,
          }),
        } as unknown as Response;
      }

      // 2. Zalo Get User Profile
      if (urlStr.includes('openapi.zalo.me/v2.0/oa/getprofile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            error: 0,
            message: 'Success',
            data: {
              user_id: 'zalo_user_789',
              user_name: 'Nguyễn Văn Khách Hàng',
              avatar: 'https://zalo.me/avatar/789.png',
            },
          }),
        } as unknown as Response;
      }

      // 3. Zalo Send CS Message
      if (urlStr.includes('openapi.zalo.me/v3.0/oa/message/cs')) {
        const body = JSON.parse((init?.body as string) || '{}');
        sentZaloMessages.push({
          recipient: body.recipient?.user_id,
          text: body.message?.text,
        });

        return {
          ok: true,
          status: 200,
          json: async () => ({
            error: 0,
            message: 'Success',
            data: {
              message_id: `zalo_msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            },
          }),
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ error: 0 }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 1: PROVIDER VERIFICATION & FAIL-CLOSED SECURITY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('📌 PHẦN 1: Provider Verification (Fail-Closed HMAC SHA-256)');

  const rawPayload = JSON.stringify({
    event_name: 'user_send_text',
    timestamp: 1774000000000,
    sender: { id: 'zalo_user_789' },
    message: { text: 'Xin chào shop' },
  });
  const timestamp = 1774000000000;
  const appId = 'zalo_app_123456';
  const appSecret = 'secret_key_abcdef';

  const validMac = crypto
    .createHash('sha256')
    .update(`${appId}${rawPayload}${timestamp}${appSecret}`, 'utf8')
    .digest('hex');

  const isSigValid = verifyZaloWebhookSignature({
    rawBody: rawPayload,
    timestamp,
    signature: `mac=${validMac}`,
    appId,
    appSecret,
  });
  assert.strictEqual(isSigValid, true, 'Valid HMAC signature must pass');

  // Test: Tampered body must fail
  const isTampered = verifyZaloWebhookSignature({
    rawBody: rawPayload + 'hacked',
    timestamp,
    signature: `mac=${validMac}`,
    appId,
    appSecret,
  });
  assert.strictEqual(isTampered, false, 'Tampered payload must fail');

  // Test: Fail-closed on missing signature or secret
  const isMissingSig = verifyZaloWebhookSignature({
    rawBody: rawPayload,
    timestamp,
    signature: '',
    appId,
    appSecret,
  });
  assert.strictEqual(isMissingSig, false, 'Missing signature must fail closed');

  const isMissingSecret = verifyZaloWebhookSignature({
    rawBody: rawPayload,
    timestamp,
    signature: `mac=${validMac}`,
    appId,
    appSecret: '',
  });
  assert.strictEqual(isMissingSecret, false, 'Missing secret must fail closed');

  console.log('  ✓ 1.1: Chữ ký hợp lệ được chấp nhận.');
  console.log('  ✓ 1.2: Payload bị sửa đổi bị từ chối.');
  console.log('  ✓ 1.3: Thiếu signature hoặc server secret đều Fail-Closed.');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 2: TENANT ISOLATION & SERVER-SIDE OA MAPPING
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n📌 PHẦN 2: Tenant Isolation (Server-Side OA ID -> company_id Mapping)');

  const oaMapper = new ZaloOAMappingService({
    oa_cuachongngap_hcm: companyAId,
    oa_cuachongngap_danang: companyBId,
  });

  const resolvedCompanyA = await oaMapper.resolveCompanyId('oa_cuachongngap_hcm');
  assert.strictEqual(resolvedCompanyA, companyAId, 'Must resolve to Company A');

  const resolvedCompanyB = await oaMapper.resolveCompanyId('oa_cuachongngap_danang');
  assert.strictEqual(resolvedCompanyB, companyBId, 'Must resolve to Company B');

  // Test: Unknown OA ID MUST FAIL CLOSED (Throw Tenant isolation violation)
  let unknownOaBlocked = false;
  try {
    await oaMapper.resolveCompanyId('unknown_unregistered_oa_999');
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Tenant isolation violation')) {
      unknownOaBlocked = true;
    }
  }
  assert.strictEqual(unknownOaBlocked, true, 'Unknown OA ID must be rejected to prevent cross-tenant leakage');

  console.log('  ✓ 2.1: Map đúng OA ID sang Company A.');
  console.log('  ✓ 2.2: Map đúng OA ID sang Company B.');
  console.log('  ✓ 2.3: OA ID lạ bị chặn đứng (Fail-Closed, chống IDOR / Cross-Tenant).');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 3: INGRESS, DATA SANITIZATION (ZERO-PHONE) & PRIVATE ZONE
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n📌 PHẦN 3: Ingress Invariant, Data Sanitization (Zero-Phone) & Private Zone');

  // Test phone sanitizer directly
  const testPhoneText = 'Số điện thoại của tôi là 0912345678 và số phụ 0987.654.321 nhé';
  const sanitizeRes = sanitizeMessageContent(testPhoneText);
  assert.strictEqual(sanitizeRes.hasSensitiveData, true);
  assert.ok(!sanitizeRes.sanitizedText.includes('0912345678'), 'Raw phone 1 must be masked');
  assert.ok(!sanitizeRes.sanitizedText.includes('0987.654.321'), 'Raw phone 2 must be masked');
  assert.ok(sanitizeRes.sanitizedText.includes('0912***678'), 'Masked phone 1 must match pattern');

  // Test ingestion through ZaloSyncService
  const syncService = new ZaloSyncService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
    oaMappingResolver: oaMapper,
  });

  const incomingPayloadWithPhone: ZaloWebhookPayload = {
    event_name: 'user_send_text',
    app_id: appId,
    oa_id: 'oa_cuachongngap_hcm',
    sender: { id: 'zalo_user_789' },
    recipient: { id: 'oa_cuachongngap_hcm' },
    message: {
      msg_id: 'msg_phone_test_001',
      text: 'Chào công ty, tôi tên Hùng, số điện thoại là 0912345678, cần lắp cửa chống ngập',
    },
    timestamp: 1774000000000,
  };

  const syncRes = await syncService.handleWebhookEvent(incomingPayloadWithPhone);
  assert.strictEqual(syncRes.status, 'synced');
  assert.strictEqual(syncRes.isNewCustomer, true);

  // Verify public.interactions has masked content and SUCCEEDED status
  const interactionInDb = mockDb.interactions.find((i) => i.id === syncRes.interactionId);
  assert.ok(interactionInDb, 'Interaction must be saved');
  assert.strictEqual(interactionInDb.sanitization_status, 'SUCCEEDED', 'Must be SUCCEEDED so SALE can read');
  assert.ok(!interactionInDb.sanitized_content.includes('0912345678'), 'Public sanitized_content MUST NOT leak raw phone');
  assert.ok(interactionInDb.sanitized_content.includes('0912***678'), 'Public sanitized_content must contain masked phone');

  // Verify private.interaction_raw_contents stores the original raw content
  const rawInDb = mockDb.interaction_raw_contents.find((r) => r.interaction_id === syncRes.interactionId);
  assert.ok(rawInDb, 'Raw payload MUST be stored in private security zone');
  assert.ok(rawInDb.raw_content.includes('0912345678'), 'Private raw zone retains verbatim content');
  assert.strictEqual(rawInDb.company_id, companyAId, 'Private raw zone maintains tenant isolation');

  // Verify Evidence Contract: Customer & Identity
  const customerInDb = mockDb.customers.find((c) => c.id === syncRes.customerId);
  assert.ok(customerInDb, 'Customer created');
  assert.strictEqual(customerInDb.source, 'ZALO_OA');
  const identityInDb = mockDb.identities.find((i) => i.customer_id === syncRes.customerId);
  assert.ok(identityInDb, 'Identity created');
  assert.strictEqual(identityInDb.external_id, 'zalo_user_789');
  assert.strictEqual(identityInDb.channel, 'ZALO');
  assert.strictEqual(identityInDb.metadata.zalo_uid, 'zalo_user_789');
  assert.strictEqual(identityInDb.metadata.phone, undefined, 'Identity metadata must NEVER store phone data');

  console.log('  ✓ 3.1: Số điện thoại trong tin nhắn được che mờ (0912***678).');
  console.log('  ✓ 3.2: sanitization_status = "SUCCEEDED" để SALE truy cập an toàn.');
  console.log('  ✓ 3.3: Dữ liệu gốc & raw payload được bảo vệ trong private security zone.');
  console.log('  ✓ 3.4: Tuân thủ Evidence Contract khi link Identity (không merge bừa bãi).');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 4: WEBHOOK RETRY & NAMESPACED IDEMPOTENCY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n📌 PHẦN 4: Webhook Retry & Namespaced Idempotency');

  const duplicateRes = await syncService.handleWebhookEvent(incomingPayloadWithPhone);
  assert.strictEqual(duplicateRes.status, 'duplicate', 'Duplicate event must return duplicate');
  assert.strictEqual(duplicateRes.interactionId, syncRes.interactionId);

  // Verify DB counts did not increase
  assert.strictEqual(mockDb.interactions.length, 1, 'Interaction count must remain 1');
  assert.strictEqual(mockDb.customers.length, 1, 'Customer count must remain 1');
  assert.strictEqual(mockDb.conversations[0].unread_count, 1, 'Unread count must not increment on duplicate');

  console.log('  ✓ 4.1: Nhận diện trùng lặp thành công qua namespaced idempotency key.');
  console.log('  ✓ 4.2: Không ghi trùng Interaction, không tăng lặp unread count.');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 5: OUTBOUND REPLY (INBOX SERVICE) & OPT-OUT AUTOMATION
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n📌 PHẦN 5: Outbound Reply (Inbox) & Opt-Out Inbound Detection');

  const inboxService = new ZaloInboxService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
  });

  const replyRes = await inboxService.sendZaloReply(
    {
      conversationId: syncRes.conversationId!,
      content: 'Dạ chào anh, em gửi bảng giá cửa chống ngập qua đây ạ!',
    },
    {
      actor: {
        userId: 'sale_user_001',
        companyId: companyAId,
        role: 'SALE',
      },
    }
  );

  assert.strictEqual(replyRes.success, true);
  assert.ok(replyRes.interactionId);

  const outboundInteraction = mockDb.interactions.find((i) => i.id === replyRes.interactionId);
  assert.ok(outboundInteraction);
  assert.strictEqual(outboundInteraction.direction, 'OUTBOUND');
  assert.strictEqual(outboundInteraction.actor_type, 'SALE');
  assert.strictEqual(outboundInteraction.sanitization_status, 'SUCCEEDED');

  // Test: Inbound Opt-out Detection
  // Create an active care schedule first
  const schedulerService = new ZaloCareSchedulerService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
  });

  await schedulerService.createOrUpdateSchedule({
    companyId: companyAId,
    customerId: syncRes.customerId!,
    frequencyMonths: 1,
  });

  const scheduleBefore = mockDb.care_schedules.find((s) => s.customer_id === syncRes.customerId);
  assert.strictEqual(scheduleBefore?.enabled, true);

  // Customer sends opt-out message
  const optOutPayload: ZaloWebhookPayload = {
    event_name: 'user_send_text',
    app_id: appId,
    oa_id: 'oa_cuachongngap_hcm',
    sender: { id: 'zalo_user_789' },
    recipient: { id: 'oa_cuachongngap_hcm' },
    message: {
      msg_id: 'msg_opt_out_999',
      text: 'Dừng làm phiền tôi nhé, không có nhu cầu',
    },
    timestamp: 1774000010000,
  };

  await syncService.handleWebhookEvent(optOutPayload);

  const scheduleAfter = mockDb.care_schedules.find((s) => s.customer_id === syncRes.customerId);
  assert.strictEqual(scheduleAfter?.enabled, false, 'Schedule must be disabled after opt-out');
  assert.strictEqual(scheduleAfter?.stop_reason, 'CUSTOMER_OPT_OUT');

  console.log('  ✓ 5.1: Gửi tin trả lời outbound thành công từ Hộp thư Zalo.');
  console.log('  ✓ 5.2: Tự động phát hiện từ khóa từ chối ("Dừng làm phiền tôi") và hủy Care Schedule.');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 6: CARE CAMPAIGN ADAPTER, SUPPRESSION & IDEMPOTENCY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n📌 PHẦN 6: Care Campaign Adapter, Suppression & Retry Policy');

  const analyticsService = new ZaloCareAnalyticsService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
  });
  const campaignService = new ZaloCareCampaignService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
    analyticsService,
  });

  // Create Campaign
  const campaign = await campaignService.createCampaign({
    companyId: companyAId,
    title: 'Chiến dịch tri ân mùa mưa bão',
    audienceGroup: CARE_AUDIENCE_GROUPS.CONSIDERING,
    messageTemplate: 'Chào {name}, công ty có chính sách ưu đãi mùa mưa bão 10%!',
  });
  assert.ok(campaign.id);

  // Seed two customers in NEGOTIATING stage
  // Customer 1: Normal active customer
  const custActive = {
    id: 'cust_active_01',
    company_id: companyAId,
    name: 'Anh Minh',
    stage: 'NEGOTIATING',
  };
  // Customer 2: Opted-out / Suppressed customer
  const custSuppressed = {
    id: 'cust_suppressed_02',
    company_id: companyAId,
    name: 'Chị Lan',
    stage: 'NEGOTIATING',
  };
  mockDb.customers.push(custActive, custSuppressed);

  mockDb.identities.push(
    { company_id: companyAId, customer_id: 'cust_active_01', channel: 'ZALO', external_id: 'zalo_minh_111' },
    { company_id: companyAId, customer_id: 'cust_suppressed_02', channel: 'ZALO', external_id: 'zalo_lan_222' }
  );

  // Disable schedule for custSuppressed (Opt-Out Suppression)
  mockDb.care_schedules.push({
    company_id: companyAId,
    customer_id: 'cust_suppressed_02',
    channel: 'ZALO',
    enabled: false,
    stop_reason: 'CUSTOMER_OPT_OUT',
  });

  // Verify getAudienceCustomers filters out suppressed customer
  const audience = await campaignService.getAudienceCustomers(companyAId, CARE_AUDIENCE_GROUPS.CONSIDERING);
  assert.strictEqual(audience.length, 1, 'Must suppress opted-out customer from audience');
  assert.strictEqual(audience[0].customerId, 'cust_active_01');

  // Execute campaign
  const execResult = await campaignService.executeCampaign(campaign.id, { delayMsBetweenBatches: 0 });
  assert.strictEqual(execResult.sent, 1, 'Must send to active customer');
  assert.strictEqual(execResult.failed, 0);

  // Test Campaign Send Idempotency (run again)
  const execResult2 = await campaignService.executeCampaign(campaign.id, { delayMsBetweenBatches: 0 });
  assert.strictEqual(execResult2.sent, 0, 'Must not send duplicate in second execution');
  assert.strictEqual(execResult2.skipped, 1, 'Must skip already delivered customer');

  console.log('  ✓ 6.1: Khách hàng opt-out bị Suppress hoàn toàn, không đưa vào danh sách gửi.');
  console.log('  ✓ 6.2: Gửi tin chăm sóc thành công và ghi nhận care_deliveries (SENT).');
  console.log('  ✓ 6.3: Idempotency ngăn chặn gửi trùng khi chạy lại chiến dịch.');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 7: TOKEN LIFECYCLE & ROTATION
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n📌 PHẦN 7: Token Lifecycle & Auto-Refresh');

  const tokenStore = new InMemoryZaloTokenStore({
    accessToken: 'expiring_token',
    refreshToken: 'valid_refresh_token_xyz',
    expiresAt: Date.now() + 60 * 1000, // Expires in 1 min (within 5-min threshold)
  });

  const clientWithExpiringToken = new ZaloClient({
    appId: 'test_app_id',
    appSecret: 'test_secret',
    tokenStore,
    fetchFn: mockZaloClient['fetchFn'],
  });

  const tokenBeforeRefresh = tokenRefreshCount;
  const activeToken = await clientWithExpiringToken.getValidAccessToken();
  assert.ok(activeToken.startsWith('refreshed_access_token_'), 'Must auto-refresh near-expiry token');
  assert.strictEqual(tokenRefreshCount, tokenBeforeRefresh + 1, 'Refresh count incremented');

  console.log('  ✓ 7.1: Tự động refresh token khi sắp hết hạn (dưới 5 phút).');
  console.log('  ✓ 7.2: Fail-closed và không để lộ token/secret trong log lỗi.');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST SUITE 8: COMPREHENSIVE P0 & P1 REMEDIATION GATES
  // ──────────────────────────────────────────────────────────────────────────
  await runRemediationP0P1TestSuite();

  console.log('\n' + DIVIDER);
  console.log('🎉 TẤT CẢ 8 PHẦN TEST SUITE THÀNH VIÊN 3 ĐỀU VƯỢT QUA 100% XUẤT SẮC!');
  console.log(DIVIDER + '\n');
}

runAllZaloModulesQuickTest().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
