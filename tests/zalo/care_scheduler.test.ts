import assert from 'assert';
import { ZaloCareSchedulerService, addMonths } from '../../features/care/zalo/scheduler-service';
import { ZaloClient } from '../../features/omnichannel/zalo/zalo-client';
import { createMockSupabase, createMockDatabase } from './mock_supabase';

async function runCareSchedulerTests() {
  console.log('--- TEST SUITE 3: ZALO CARE SCHEDULER (1-MONTH CYCLE & OPT-OUT) ---');

  const companyId = '11111111-1111-1111-1111-111111111111';
  const customerId = 'cust_care_001';
  const recipientZaloId = 'zalo_uid_777';

  const messagesSent: string[] = [];

  const mockZaloClient = new ZaloClient({
    accessToken: 'test_sched_access_token',
    fetchFn: (async (_url, init) => {
      const reqInit = init as { body?: string };
      const body = JSON.parse(reqInit?.body || '{}');
      messagesSent.push(body.message.text);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          error: 0,
          message: 'Success',
          data: { message_id: `msg_care_${Date.now()}` },
        }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  const initialScheduleDate = new Date('2026-09-01T08:00:00.000Z');

  const mockDb = createMockDatabase({
    customers: [
      { id: customerId, company_id: companyId, name: 'Nguyễn Thị Bích', stage: 'CARE_NURTURING' },
    ],
    identities: [
      {
        id: 'ident_001',
        company_id: companyId,
        customer_id: customerId,
        channel: 'ZALO',
        external_id: recipientZaloId,
        verified: true,
      },
    ],
    care_schedules: [
      {
        id: 'sched_001',
        company_id: companyId,
        customer_id: customerId,
        channel: 'ZALO',
        frequency_months: 1,
        next_send_at: initialScheduleDate.toISOString(),
        enabled: true,
        stop_reason: null,
      },
    ],
  });

  const supabase = createMockSupabase(mockDb);
  const schedulerService = new ZaloCareSchedulerService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: mockZaloClient,
  });

  // -------------------------------------------------------------
  // Test 3.1: Periodic schedule trigger and 1-month advancement
  // -------------------------------------------------------------
  console.log('Test 3.1: Lập lịch CareSchedule chu kỳ 1 tháng và cập nhật next_send_at khi đến hạn');

  const asOfDate = new Date('2026-09-02T00:00:00.000Z'); // Day after schedule
  const processResult = await schedulerService.processDueSchedules({
    companyId,
    asOfDate,
  });

  assert.strictEqual(processResult.processed, 1, 'Should process 1 due schedule');
  assert.strictEqual(processResult.advanced, 1, 'Should advance 1 schedule');
  assert.strictEqual(messagesSent.length, 1, 'Should send 1 periodic message');

  // Verify next_send_at is advanced by exactly 1 month: 2026-09-01 -> 2026-10-01
  const updatedSchedule = mockDb.care_schedules[0];
  const expectedNextSend = addMonths(initialScheduleDate, 1).toISOString();
  assert.strictEqual(
    updatedSchedule.next_send_at,
    expectedNextSend,
    'next_send_at must advance by exactly 1 month'
  );
  assert.strictEqual(updatedSchedule.enabled, true, 'Schedule should remain enabled');

  console.log('✓ Test 3.1 Passed: Schedule correctly fired and advanced next_send_at by 1 month.');

  // -------------------------------------------------------------
  // Test 3.2: Customer sends refusal/opt-out message
  // -------------------------------------------------------------
  console.log('Test 3.2: Khách hàng nhắn từ chối -> tự động ngừng gửi (enabled = false, stop_reason: CUSTOMER_OPT_OUT)');

  const optOutText = 'Tôi lắp rồi, đừng làm phiền tôi nữa nhé, stop!';
  const optOutHandled = await schedulerService.checkAndHandleOptOut(
    companyId,
    customerId,
    optOutText
  );

  assert.strictEqual(optOutHandled, true, 'Should detect opt-out intent');

  const disabledSchedule = mockDb.care_schedules[0];
  assert.strictEqual(disabledSchedule.enabled, false, 'Schedule must be disabled');
  assert.strictEqual(
    disabledSchedule.stop_reason,
    'CUSTOMER_OPT_OUT',
    'stop_reason must be CUSTOMER_OPT_OUT'
  );

  console.log('✓ Test 3.2 Passed: Opt-out correctly disabled schedule.');

  // -------------------------------------------------------------
  // Test 3.3: Disabled schedule is skipped in future cycles
  // -------------------------------------------------------------
  console.log('Test 3.3: Lịch đã dừng sẽ không được quét hay gửi tin ở chu kỳ tiếp theo');

  const futureDate = new Date('2026-11-01T00:00:00.000Z');
  const futureProcessResult = await schedulerService.processDueSchedules({
    companyId,
    asOfDate: futureDate,
  });

  assert.strictEqual(futureProcessResult.processed, 0, 'No schedules should be processed');
  assert.strictEqual(messagesSent.length, 1, 'No additional messages should have been sent');

  console.log('✓ Test 3.3 Passed: Disabled schedule was safely skipped.');

  // -------------------------------------------------------------
  // Test 3.4: Provider error when sending -> FAILED status and next_send_at NOT advanced (P0 #8)
  // -------------------------------------------------------------
  console.log('Test 3.4: Gặp lỗi gửi tin -> care_deliveries ghi nhận FAILED và next_send_at KHÔNG bị dịch chuyển sai');

  const failingClientId = 'cust_fail_002';
  const failingDate = new Date('2026-09-01T08:00:00.000Z');

  mockDb.customers.push({ id: failingClientId, company_id: companyId, name: 'Khách Lỗi Mạng', stage: 'CARE_NURTURING' });
  mockDb.identities.push({ id: 'ident_fail', company_id: companyId, customer_id: failingClientId, channel: 'ZALO', external_id: 'zalo_fail_uid', verified: true });
  mockDb.care_schedules.push({
    id: 'sched_fail_002',
    company_id: companyId,
    customer_id: failingClientId,
    channel: 'ZALO',
    frequency_months: 1,
    next_send_at: failingDate.toISOString(),
    enabled: true,
    stop_reason: null,
  });

  // Client that fails sending
  const failingZaloClient = new ZaloClient({
    accessToken: 'test_sched_access_token',
    fetchFn: (async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          error: -999,
          message: 'Zalo Gateway Timeout / Provider Error',
        }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  const failingSchedulerService = new ZaloCareSchedulerService({
    supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    zaloClient: failingZaloClient,
  });

  const failResult = await failingSchedulerService.processDueSchedules({
    companyId,
    asOfDate: new Date('2026-09-02T00:00:00.000Z'),
  });

  assert.strictEqual(failResult.processed, 1, 'Should process 1 failing due schedule');
  assert.strictEqual(failResult.advanced, 0, 'Must NOT advance schedule on failure');
  assert.strictEqual(failResult.failed, 1, 'Must record 1 failure');

  const failScheduleInDb = mockDb.care_schedules.find((s) => s.id === 'sched_fail_002');
  assert.strictEqual(
    failScheduleInDb?.next_send_at,
    failingDate.toISOString(),
    'next_send_at must remain UNCHANGED on provider failure'
  );

  const failDeliveryInDb = mockDb.care_deliveries.find((d) => d.customer_id === failingClientId);
  assert.strictEqual(failDeliveryInDb?.status, 'FAILED', 'Delivery record must be FAILED');

  console.log('✓ Test 3.4 Passed: Care schedule preserved next_send_at and logged FAILED delivery.');

  console.log('\nALL TESTS IN SUITE 3 PASSED SUCCESSFULLY! ✓\n');
}

runCareSchedulerTests().catch((err) => {
  console.error('Test Suite 3 Failed:', err);
  process.exit(1);
});
