import assert from 'assert';
import { ZaloCareCampaignService } from '../../features/care/zalo/campaign-service';
import { ZaloCareAnalyticsService } from '../../features/care/zalo/analytics-service';
import { CARE_AUDIENCE_GROUPS } from '../../features/care/zalo/types';
import { ZaloClient } from '../../features/omnichannel/zalo/zalo-client';
import { createMockSupabase, createMockDatabase } from './mock_supabase';

async function runCampaignAnalyticsTests() {
  console.log('--- TEST SUITE 4: BULK CARE CAMPAIGNS & RECONCILED ANALYTICS ---');

  const companyId = '11111111-1111-1111-1111-111111111111';

  // Mock database with customers in different stages
  const mockDb = createMockDatabase({
    customers: [
      // 2 customers in UNREACHABLE (sau 3 lần gọi)
      { id: 'c_unreach_1', company_id: companyId, name: 'Khách Không Nghe 1', stage: 'UNREACHABLE' },
      { id: 'c_unreach_2', company_id: companyId, name: 'Khách Không Nghe 2', stage: 'UNREACHABLE' },
      // 1 customer in NEGOTIATING (CONSIDERING)
      { id: 'c_negotiate_1', company_id: companyId, name: 'Khách Cân Nhắc 1', stage: 'NEGOTIATING' },
      // 1 customer in PRICE_CALCULATED (QUOTED_NOT_CLOSED)
      { id: 'c_quoted_1', company_id: companyId, name: 'Khách Báo Giá 1', stage: 'PRICE_CALCULATED' },
      // 1 customer in HANDOVER_COMPLETED (OLD_CUSTOMER)
      { id: 'c_old_1', company_id: companyId, name: 'Khách Cũ 1', stage: 'HANDOVER_COMPLETED' },
    ],
    identities: [
      { id: 'id_1', company_id: companyId, customer_id: 'c_unreach_1', channel: 'ZALO', external_id: 'zalo_unreach_1', verified: true },
      { id: 'id_2', company_id: companyId, customer_id: 'c_unreach_2', channel: 'ZALO', external_id: 'zalo_unreach_2', verified: true },
      { id: 'id_3', company_id: companyId, customer_id: 'c_negotiate_1', channel: 'ZALO', external_id: 'zalo_negotiate_1', verified: true },
      { id: 'id_4', company_id: companyId, customer_id: 'c_quoted_1', channel: 'ZALO', external_id: 'zalo_quoted_1', verified: true },
      { id: 'id_5', company_id: companyId, customer_id: 'c_old_1', channel: 'ZALO', external_id: 'zalo_old_1', verified: true },
    ],
    care_schedules: [
      // One unreachable customer opted out
      { id: 'cs_1', company_id: companyId, customer_id: 'c_unreach_2', channel: 'ZALO', enabled: false, stop_reason: 'CUSTOMER_OPT_OUT', frequency_months: 1, next_send_at: '2026-10-01T00:00:00Z' },
    ],
  });

  const supabase = createMockSupabase(mockDb);

  const sentMessages: Array<{ recipient: string; text: string }> = [];

  const mockZaloClient = new ZaloClient({
    accessToken: 'test_bulk_access_token',
    fetchFn: (async (_url, init) => {
      const reqInit = init as { body?: string };
      const body = JSON.parse(reqInit?.body || '{}');
      sentMessages.push({
        recipient: body.recipient.user_id,
        text: body.message.text,
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          error: 0,
          message: 'Success',
          data: { message_id: `msg_bulk_${Date.now()}_${Math.random()}` },
        }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  const typedSupabase = supabase as unknown as import('@supabase/supabase-js').SupabaseClient;
  const analyticsService = new ZaloCareAnalyticsService({ supabase: typedSupabase });
  const campaignService = new ZaloCareCampaignService({
    supabase: typedSupabase,
    zaloClient: mockZaloClient,
    analyticsService,
  });

  // -------------------------------------------------------------
  // Test 4.1: Audience Segmentation for UNREACHABLE_3_TIMES
  // -------------------------------------------------------------
  console.log('Test 4.1: Phân đoạn đối tượng UNREACHABLE_3_TIMES (lọc đúng stage và loại bỏ khách đã opt-out)');

  const audience = await campaignService.getAudienceCustomers(
    companyId,
    CARE_AUDIENCE_GROUPS.UNREACHABLE_3_TIMES
  );

  // Should contain c_unreach_1, but NOT c_unreach_2 (who opted out)
  assert.strictEqual(audience.length, 1, 'Audience should contain 1 eligible customer');
  assert.strictEqual(audience[0].customerId, 'c_unreach_1');
  assert.strictEqual(audience[0].zaloUid, 'zalo_unreach_1');

  console.log('✓ Test 4.1 Passed: Audience segmentation and opt-out exclusion validated.');

  // -------------------------------------------------------------
  // Test 4.2: Campaign Creation and Batch Execution
  // -------------------------------------------------------------
  console.log('Test 4.2: Tạo chiến dịch chăm sóc hàng loạt và gửi tin batch');

  const campaign = await campaignService.createCampaign({
    companyId,
    title: 'Chiến dịch hỏi thăm khách không nghe máy',
    audienceGroup: CARE_AUDIENCE_GROUPS.UNREACHABLE_3_TIMES,
    messageTemplate: 'Chào {name}, hôm trước bên em gọi tư vấn cửa chống ngập chưa liên lạc được với mình ạ.',
  });

  assert.ok(campaign.id, 'Campaign ID must be generated');
  assert.strictEqual(campaign.sentCount, 0, 'Initial sent count should be 0');

  const execResult = await campaignService.executeCampaign(campaign.id, {
    batchSize: 10,
    delayMsBetweenBatches: 0,
  });

  assert.strictEqual(execResult.sent, 1, '1 message should be sent');
  assert.strictEqual(execResult.failed, 0, '0 messages failed');
  assert.strictEqual(execResult.skipped, 0, '0 messages skipped');
  assert.strictEqual(sentMessages.length, 1, '1 Zalo API request dispatched');
  assert.strictEqual(
    sentMessages[0].text,
    'Chào Khách Không Nghe 1, hôm trước bên em gọi tư vấn cửa chống ngập chưa liên lạc được với mình ạ.'
  );

  // Verify CareDelivery was recorded
  assert.strictEqual(mockDb.care_deliveries.length, 1, '1 CareDelivery recorded');
  const delivery = mockDb.care_deliveries[0];
  assert.strictEqual(delivery.campaign_id, campaign.id);
  assert.strictEqual(delivery.customer_id, 'c_unreach_1');
  assert.strictEqual(delivery.status, 'SENT');
  assert.ok(delivery.sent_at, 'sent_at must be populated');

  console.log('✓ Test 4.2 Passed: Campaign executed and delivery recorded.');

  // -------------------------------------------------------------
  // Test 4.3: Campaign Execution Idempotency (Anti-Duplicate)
  // -------------------------------------------------------------
  console.log('Test 4.3: Chống gửi lặp trong cùng một chiến dịch (CareDelivery idempotency_key)');

  const secondExec = await campaignService.executeCampaign(campaign.id, {
    batchSize: 10,
    delayMsBetweenBatches: 0,
  });

  assert.strictEqual(secondExec.sent, 0, 'Should send 0 new messages');
  assert.strictEqual(secondExec.skipped, 1, 'Should skip 1 existing delivery');
  assert.strictEqual(sentMessages.length, 1, 'Total messages sent remains 1');

  console.log('✓ Test 4.3 Passed: Campaign execution anti-duplicate verified.');

  // -------------------------------------------------------------
  // Test 4.4: Measurement & Analytics Reconciled from CareDelivery
  // -------------------------------------------------------------
  console.log('Test 4.4: Thống kê số liệu chiến dịch (sent_count, delivered_count, response_count, converted_to_sale_count) từ CareDelivery');

  // Initial metric calculation
  let metrics = await analyticsService.getCampaignAnalytics(campaign.id);
  assert.strictEqual(metrics.sentCount, 1);
  assert.strictEqual(metrics.deliveredCount, 1);
  assert.strictEqual(metrics.responseCount, 0);
  assert.strictEqual(metrics.convertedToSaleCount, 0);

  // Simulate customer response
  delivery.status = 'RESPONDED';
  delivery.responded_at = new Date().toISOString();

  metrics = await analyticsService.getCampaignAnalytics(campaign.id);
  assert.strictEqual(metrics.responseCount, 1, 'responseCount should now be 1');
  assert.strictEqual(metrics.responseRatePercent, 100, 'responseRate should be 100%');

  // Simulate conversion to sale
  await analyticsService.recordConversionToSale(companyId, 'c_unreach_1', delivery.id);

  metrics = await analyticsService.getCampaignAnalytics(campaign.id);
  assert.strictEqual(metrics.convertedToSaleCount, 1, 'convertedToSaleCount should now be 1');
  assert.strictEqual(metrics.conversionRatePercent, 100, 'conversionRate should be 100%');

  // Verify CareCampaign persisted columns in DB
  const updatedCampaign = mockDb.care_campaigns[0];
  assert.strictEqual(updatedCampaign.sent_count, 1);
  assert.strictEqual(updatedCampaign.delivered_count, 1);
  assert.strictEqual(updatedCampaign.response_count, 1);
  assert.strictEqual(updatedCampaign.converted_to_sale_count, 1);

  // Verify Company Summary for Member 9
  const companySummary = await analyticsService.getCompanyCareSummary(companyId);
  assert.strictEqual(companySummary.totalCampaigns, 1);
  assert.strictEqual(companySummary.totalSent, 1);
  assert.strictEqual(companySummary.totalResponses, 1);
  assert.strictEqual(companySummary.totalConvertedToSale, 1);

  console.log('✓ Test 4.4 Passed: Reconciled campaign analytics verified.');

  console.log('\nALL TESTS IN SUITE 4 PASSED SUCCESSFULLY! ✓\n');
}

runCampaignAnalyticsTests().catch((err) => {
  console.error('Test Suite 4 Failed:', err);
  process.exit(1);
});
