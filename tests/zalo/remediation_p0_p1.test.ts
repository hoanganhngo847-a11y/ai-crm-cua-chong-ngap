import assert from 'assert';
import { ZaloSyncService } from '../../features/omnichannel/zalo/sync-service';
import { ZaloInboxService } from '../../features/omnichannel/zalo/inbox-service';
import { ZaloCareSchedulerService } from '../../features/care/zalo/scheduler-service';
import { ZaloOAMappingService, TenantResolutionError } from '../../features/omnichannel/zalo/oa-mapping';
import { ServerAuthError } from '../../lib/server-auth/errors';
import { ZaloClient, ZaloClientFactory } from '../../features/omnichannel/zalo/zalo-client';
import { MockZaloTokenStore } from '../../features/omnichannel/zalo/token-store';
import { ZaloWebhookPayload } from '../../features/omnichannel/zalo/types';
import { createMockDatabase, createMockSupabase } from './mock_supabase';

export async function runRemediationP0P1TestSuite() {
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('🛡️  P0 & P1 COMPREHENSIVE ARCHITECTURAL REMEDIATION TEST SUITE');
  console.log('   Multi-Tenant Isolation, Atomic Ingress, Durable Outbox & Scheduler');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  const companyAId = '11111111-1111-1111-1111-111111111111';
  const companyBId = '22222222-2222-2222-2222-222222222222';
  const companyAOaId = 'oa_company_a_001';
  const companyBOaId = 'oa_company_b_002';

  // =========================================================================
  // TEST 1: FAIL-CLOSED OA RESOLUTION (P0 #1)
  // =========================================================================
  console.log('📌 TEST 1: Reject ngay webhook có unknown / missing OA ID (Fail-closed)');
  {
    const mappingService = new ZaloOAMappingService({
      customMapping: {
        [companyAOaId]: companyAId,
        [companyBOaId]: companyBId,
      },
    });

    // 1.1 Unknown OA ID must throw TenantResolutionError with 403
    let unknownRejected = false;
    try {
      await mappingService.resolveCompanyId('unknown_rogue_oa_999');
    } catch (err: unknown) {
      if (err instanceof TenantResolutionError && err.httpStatus === 403) {
        unknownRejected = true;
      }
    }
    assert.strictEqual(unknownRejected, true, 'Unknown OA ID must be rejected with HTTP 403');

    // 1.2 Missing / empty OA ID must throw TenantResolutionError with 400
    let missingRejected = false;
    try {
      await mappingService.resolveCompanyId('');
    } catch (err: unknown) {
      if (err instanceof TenantResolutionError && err.httpStatus === 400) {
        missingRejected = true;
      }
    }
    assert.strictEqual(missingRejected, true, 'Missing OA ID must be rejected with HTTP 400');

    // 1.3 Valid OA ID maps correctly
    const resolvedA = await mappingService.resolveCompanyId(companyAOaId);
    assert.strictEqual(resolvedA, companyAId, 'Valid OA must resolve to correct companyId');

    console.log('  ✓ Test 1 Passed: Fail-closed tenant resolution prevents cross-tenant spoofing.\n');
  }

  // =========================================================================
  // TEST 2: DURABLE IDEMPOTENCY & CONCURRENT WEBHOOK CLAIM (P0 #2, P1 #10)
  // =========================================================================
  console.log('📌 TEST 2: Giả lập 2 webhook concurrent giống hệt nhau -> Chỉ 1 transaction claim thành công');
  {
    const mockDb = createMockDatabase();
    const supabase = createMockSupabase(mockDb);

    const syncService = new ZaloSyncService({
      supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
      defaultCompanyId: companyAId,
      zaloClient: new ZaloClient({
        companyId: companyAId,
        oaId: companyAOaId,
        accessToken: 'token_a',
        fetchFn: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ error: 0, data: { user_id: 'user_concurrent', user_name: 'Khách Đua' } }),
        })) as unknown as typeof fetch,
      }),
    });

    const payload: ZaloWebhookPayload = {
      event_name: 'user_send_text',
      oa_id: companyAOaId,
      sender: { id: 'user_concurrent' },
      recipient: { id: companyAOaId },
      message: {
        msg_id: 'msg_concurrent_race_001',
        text: 'Tin nhắn gửi nhanh đồng thời',
      },
      timestamp: Date.now(),
    };

    // Run both webhook handlings concurrently
    const [res1, res2] = await Promise.all([
      syncService.handleWebhookEvent(payload),
      syncService.handleWebhookEvent(payload),
    ]);

    // Exactly one should be 'synced' and one 'duplicate'
    const statuses = [res1.status, res2.status].sort();
    assert.deepStrictEqual(statuses, ['duplicate', 'synced'], 'Exactly 1 event claimed, duplicate rejected');

    // Verify DB integrity
    assert.strictEqual(mockDb.interactions.length, 1, 'Exactly 1 interaction must be recorded in DB');
    assert.strictEqual(mockDb.zalo_ingress_events.length, 1, 'Exactly 1 ingress event claimed in DB');
    assert.strictEqual(mockDb.conversations[0].unread_count, 1, 'Unread count must not increment twice');

    console.log('  ✓ Test 2 Passed: Ingress unique constraint invariant eliminates race conditions.\n');
  }

  // =========================================================================
  // TEST 3: ATOMIC INGRESS ROLLBACK ON PRIVATE ZONE FAILURE (P0 #3)
  // =========================================================================
  console.log('📌 TEST 3: Ghi private raw payload bị lỗi -> Toàn bộ transaction ingress rollback (Zero Orphan)');
  {
    const mockDb = createMockDatabase();
    const supabase = createMockSupabase(mockDb);

    // Override schema('private').from('interaction_raw_contents').insert to simulate failure
    const rawFailingSupabase = {
      ...supabase,
      schema: () => ({
        from: (table: string) => {
          const builder = supabase.from(table);
          if (table === 'interaction_raw_contents') {
            return {
              insert: async () => ({
                data: null,
                error: { message: 'Disk full / private schema vault encryption failed' },
              }),
            };
          }
          return builder;
        },
      }),
      from: (table: string) => {
        const builder = supabase.from(table);
        if (table === 'interaction_raw_contents') {
          return {
            insert: async () => ({
              data: null,
              error: { message: 'Disk full / private schema vault encryption failed' },
            }),
          };
        }
        return builder;
      },
    };

    const syncService = new ZaloSyncService({
      supabase: rawFailingSupabase as unknown as import('@supabase/supabase-js').SupabaseClient,
      defaultCompanyId: companyAId,
      zaloClient: new ZaloClient({
        companyId: companyAId,
        oaId: companyAOaId,
        accessToken: 'token_a',
        fetchFn: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ error: 0, data: { user_id: 'user_vault_fail', user_name: 'Khách Lỗi Vault' } }),
        })) as unknown as typeof fetch,
      }),
    });

    const payload: ZaloWebhookPayload = {
      event_name: 'user_send_text',
      oa_id: companyAOaId,
      sender: { id: 'user_vault_fail' },
      recipient: { id: companyAOaId },
      message: {
        msg_id: 'msg_vault_fail_001',
        text: 'Nội dung quan trọng không được mất raw trace',
      },
      timestamp: Date.now(),
    };

    let pipelineThrew = false;
    try {
      await syncService.handleWebhookEvent(payload);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Security Zone Ingress Violation')) {
        pipelineThrew = true;
      }
    }

    assert.strictEqual(pipelineThrew, true, 'Sync service MUST throw error when private raw data write fails');

    // Verify atomic rollback: no orphan customer, conversation, or interaction left behind
    assert.strictEqual(mockDb.interactions.length, 0, 'Rolled back: Interactions count must be 0');
    assert.strictEqual(mockDb.conversations.length, 0, 'Rolled back: Conversations count must be 0');
    assert.strictEqual(mockDb.customers.length, 0, 'Rolled back: Customers count must be 0');
    assert.strictEqual(mockDb.identities.length, 0, 'Rolled back: Identities count must be 0');

    console.log('  ✓ Test 3 Passed: Zero orphan records left on private security zone write failure.\n');
  }

  // =========================================================================
  // TEST 4: OUTBOUND BOUNDARY & CROSS-TENANT 403 FORBIDDEN (P0 #4)
  // =========================================================================
  console.log('📌 TEST 4: Outbound send với conversation không thuộc tenant của user -> Bị chặn 403 Forbidden');
  {
    const mockDb = createMockDatabase({
      conversations: [
        {
          id: 'conv_company_a_001',
          company_id: companyAId,
          customer_id: 'cust_a',
          channel: 'ZALO',
          external_conversation_id: 'zalo_uid_a',
          last_message_at: new Date().toISOString(),
          unread_count: 0,
          status: 'OPEN',
        },
      ],
      identities: [
        {
          id: 'ident_a',
          company_id: companyAId,
          customer_id: 'cust_a',
          channel: 'ZALO',
          external_id: 'zalo_uid_a',
          verified: true,
        },
      ],
    });

    const supabase = createMockSupabase(mockDb);
    const inboxService = new ZaloInboxService({
      supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
    });

    let forbiddenCaught = false;
    try {
      // User from Company B attempts to reply to Conversation belonging to Company A
      await inboxService.sendZaloReply(
        {
          conversationId: 'conv_company_a_001',
          content: 'Thử gửi tin trộm từ tenant khác',
        },
        {
          actor: {
            userId: 'attacker_sale_user',
            companyId: companyBId, // Cross-tenant!
            role: 'SALE',
          },
        }
      );
    } catch (err: unknown) {
      if (
        err instanceof ServerAuthError ||
        (err instanceof Error && err.message.includes('forbidden'))
      ) {
        forbiddenCaught = true;
      }
    }

    assert.strictEqual(forbiddenCaught, true, 'Cross-tenant outbound attempt must be rejected with 403');
    assert.strictEqual(mockDb.zalo_outbound_deliveries.length, 0, 'No outbox delivery record created');
    assert.strictEqual(mockDb.interactions.length, 0, 'No interaction record created');

    console.log('  ✓ Test 4 Passed: Outbound boundary strictly verifies tenant ownership from DB.\n');
  }

  // =========================================================================
  // TEST 5: CARE SCHEDULER PROVIDER ERROR DOES NOT ADVANCE NEXT_SEND_AT (P0 #8)
  // =========================================================================
  console.log('📌 TEST 5: Provider trả lỗi khi gửi -> DB ghi nhận FAILED, next_send_at KHÔNG bị advance sai lệch');
  {
    const originalDate = new Date('2026-09-01T08:00:00Z');
    const mockDb = createMockDatabase({
      customers: [{ id: 'cust_care_p0', company_id: companyAId, name: 'Khách Chăm Sóc', stage: 'CARE_NURTURING' }],
      identities: [{ id: 'ident_care', company_id: companyAId, customer_id: 'cust_care_p0', channel: 'ZALO', external_id: 'zalo_care_p0', verified: true }],
      care_schedules: [
        {
          id: 'sched_p0',
          company_id: companyAId,
          customer_id: 'cust_care_p0',
          channel: 'ZALO',
          frequency_months: 1,
          next_send_at: originalDate.toISOString(),
          enabled: true,
          stop_reason: null,
        },
      ],
    });

    const supabase = createMockSupabase(mockDb);

    // ZaloClient that throws an unhandled network error
    const failingClient = new ZaloClient({
      companyId: companyAId,
      oaId: companyAOaId,
      accessToken: 'valid_test_token_p0',
      fetchFn: (async () => {
        throw new Error('ETIMEDOUT: Connection to openapi.zalo.me failed');
      }) as unknown as typeof fetch,
    });

    const scheduler = new ZaloCareSchedulerService({
      supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
      zaloClient: failingClient,
    });

    const result = await scheduler.processDueSchedules({
      companyId: companyAId,
      asOfDate: new Date('2026-09-02T00:00:00Z'),
    });

    assert.strictEqual(result.processed, 1, 'Schedule was processed');
    assert.strictEqual(result.advanced, 0, 'Schedule must NOT advance on failure');
    assert.strictEqual(result.failed, 1, 'Failure must be counted');

    // Invariant: next_send_at must not have advanced
    const scheduleInDb = mockDb.care_schedules[0];
    assert.strictEqual(
      scheduleInDb.next_send_at,
      originalDate.toISOString(),
      'next_send_at must remain intact for next retry tick'
    );

    // Invariant: delivery record created in FAILED state
    assert.strictEqual(mockDb.care_deliveries.length, 1, 'Delivery record must exist');
    assert.strictEqual(mockDb.care_deliveries[0].status, 'FAILED', 'Delivery status must be FAILED');
    assert.ok(mockDb.care_deliveries[0].error_message?.includes('ETIMEDOUT'));

    console.log('  ✓ Test 5 Passed: Scheduler loop records FAILED status and preserves next_send_at.\n');
  }

  // =========================================================================
  // TEST 6: MULTI-TENANT TOKEN ROTATION & SWITCHING (P0 #6, P0 #7)
  // =========================================================================
  console.log('📌 TEST 6: Switch token/credentials chính xác theo từng OA ID trong môi trường đa tenant');
  {
    ZaloClientFactory.clearCache();

    const tokenStore = new MockZaloTokenStore([
      {
        companyId: companyAId,
        oaId: companyAOaId,
        appId: 'app_tenant_a',
        appSecret: 'secret_tenant_a',
        accessToken: 'access_token_company_a',
        refreshToken: 'refresh_token_company_a',
      },
      {
        companyId: companyBId,
        oaId: companyBOaId,
        appId: 'app_tenant_b',
        appSecret: 'secret_tenant_b',
        accessToken: 'access_token_company_b',
        refreshToken: 'refresh_token_company_b',
      },
    ]);

    const clientA = await ZaloClientFactory.getClientForOa(companyAId, companyAOaId, { tokenStore });
    const clientB = await ZaloClientFactory.getClientForOa(companyBId, companyBOaId, { tokenStore });

    const tokenA = await clientA.getValidAccessToken();
    const tokenB = await clientB.getValidAccessToken();

    assert.strictEqual(tokenA, 'access_token_company_a', 'Client A must resolve Company A token');
    assert.strictEqual(tokenB, 'access_token_company_b', 'Client B must resolve Company B token');
    assert.notStrictEqual(tokenA, tokenB, 'Tenants must never share or leak tokens');

    // Test Fail-Closed when unknown OA has no credentials
    let unknownOaFailedClosed = false;
    try {
      const clientUnknown = await ZaloClientFactory.getClientForOa('unknown_company', 'unknown_oa', { tokenStore });
      await clientUnknown.getValidAccessToken();
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Authentication failure')) {
        unknownOaFailedClosed = true;
      }
    }
    assert.strictEqual(unknownOaFailedClosed, true, 'Unknown OA must fail closed without fallback');

    console.log('  ✓ Test 6 Passed: Multi-tenant token isolation & switching verified strictly.\n');
  }

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('🎉 TẤT CẢ 6 HẠNG MỤC REMEDIATION P0 & P1 ĐỀU ĐẠT CHUẨN KIẾN TRÚC 100%!');
  console.log('══════════════════════════════════════════════════════════════════════\n');
}

// Direct execution entrypoint
const isDirectRun = Boolean(process.argv[1] && process.argv[1].includes('remediation_p0_p1.test'));
if (isDirectRun) {
  runRemediationP0P1TestSuite().catch((err) => {
    console.error('Remediation Suite Failed:', err);
    process.exit(1);
  });
}
