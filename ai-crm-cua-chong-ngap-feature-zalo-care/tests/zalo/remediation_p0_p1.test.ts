import assert from 'assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { POST } from '../../app/api/webhooks/zalo/route';
import { ZaloSyncService } from '../../features/omnichannel/zalo/sync-service';
import { ZaloInboxService } from '../../features/omnichannel/zalo/inbox-service';
import { ZaloCareSchedulerService } from '../../features/care/zalo/scheduler-service';
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

  // Ensure global WebSocket exists for @supabase/supabase-js in Node.js < 22 test environments
  interface GlobalWithWebSocket {
    WebSocket?: unknown;
  }
  const globalScope = globalThis as unknown as GlobalWithWebSocket;
  if (typeof globalScope.WebSocket === 'undefined') {
    globalScope.WebSocket = class MockWebSocket {};
  }

  // Ensure test environment variables are set for createAdminClient()
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mock.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock_service_role_key_test';
  process.env.ZALO_APP_ID = 'test_app_id';
  process.env.ZALO_APP_SECRET = 'test_app_secret';

  // =========================================================================
  // TEST 1: RESOLVER TEST (Production Webhook Route POST without options) (Lỗi 1, 7)
  // =========================================================================
  console.log('📌 TEST 1: Resolver Test: Production webhook route POST() lookup DB đúng OA -> 200, OA lạ -> 403');
  {
    // 1.1 Verify ZaloSyncService instantiated with NO options has admin supabase client & mapper
    const prodService = new ZaloSyncService();
    assert.ok(prodService['supabase'], 'Production ZaloSyncService must have initialized supabase admin client');
    assert.ok(prodService['oaMappingResolver'], 'Production ZaloSyncService must have oaMappingResolver initialized with supabase');

    // 1.2 Intercept global fetch to test Next.js route POST(req)
    const originalFetch = globalThis.fetch;
    const appId = process.env.ZALO_APP_ID!;
    const appSecret = process.env.ZALO_APP_SECRET!;

    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const urlStr = input.toString();

        // Mock Supabase REST calls made by createAdminClient() inside POST route
        if (urlStr.includes('/rest/v1/zalo_oa_configs')) {
          if (urlStr.includes(companyAOaId)) {
            // Known OA in DB
            return new Response(
              JSON.stringify([{ company_id: companyAId, oa_id: companyAOaId, status: 'ACTIVE' }]),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          } else {
            // Unknown OA in DB (not found -> 406 or empty array)
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        // Mock RPC calls
        if (urlStr.includes('/rest/v1/rpc/zalo_claim_ingress_event')) {
          return new Response(
            JSON.stringify([{ claim_status: 'CLAIMED', current_retry_count: 0 }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (urlStr.includes('/rest/v1/rpc/zalo_process_ingress_message')) {
          return new Response(
            JSON.stringify({
              customer_id: 'cust_prod_001',
              conversation_id: 'conv_prod_001',
              interaction_id: 'int_prod_001',
              is_new_customer: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Mock Zalo provider calls
        if (urlStr.includes('openapi.zalo.me')) {
          return new Response(
            JSON.stringify({ error: 0, data: { user_id: 'user_prod_01', user_name: 'Khách Prod' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Fallback
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      // Helper to construct signed NextRequest
      const createSignedRequest = (payloadObj: Record<string, unknown>) => {
        const rawBody = JSON.stringify(payloadObj);
        const timestamp = Date.now();
        const mac = crypto
          .createHash('sha256')
          .update(`${appId}${rawBody}${timestamp}${appSecret}`, 'utf8')
          .digest('hex');

        return new NextRequest('http://localhost:3000/api/webhooks/zalo', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-zevent-signature': `mac=${mac}`,
            'x-zevent-timestamp': String(timestamp),
          },
          body: rawBody,
        });
      };

      // Test 1.A: Known OA -> Returns HTTP 200 Success
      const validPayload = {
        event_name: 'user_send_text',
        oa_id: companyAOaId,
        sender: { id: 'user_prod_01' },
        recipient: { id: companyAOaId },
        message: { msg_id: 'msg_prod_test_001', text: 'Chào shop từ route test' },
        timestamp: Date.now(),
      };
      const resValid = await POST(createSignedRequest(validPayload));
      assert.strictEqual(resValid.status, 200, 'Production route POST must return 200 for valid known OA');
      const bodyValid = await resValid.json();
      assert.strictEqual(bodyValid.error, 0, 'Response error must be 0 for success');

      // Test 1.B: Unknown OA -> Returns HTTP 403 Forbidden (TENANT_NOT_FOUND)
      const unknownPayload = {
        event_name: 'user_send_text',
        oa_id: 'unknown_rogue_oa_999',
        sender: { id: 'user_rogue' },
        recipient: { id: 'unknown_rogue_oa_999' },
        message: { msg_id: 'msg_rogue_001', text: 'Thử xâm nhập từ OA lạ' },
        timestamp: Date.now(),
      };
      const resUnknown = await POST(createSignedRequest(unknownPayload));
      assert.strictEqual(resUnknown.status, 403, 'Production route POST must return 403 for unknown OA');
      const bodyUnknown = await resUnknown.json();
      assert.strictEqual(bodyUnknown.error, 'TENANT_NOT_FOUND', 'Response must return TENANT_NOT_FOUND');
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log('  ✓ Test 1 Passed: Production webhook route lookup DB đúng OA -> 200, OA lạ -> 403.\n');
  }

  // =========================================================================
  // TEST 2: INGRESS ATOMICITY TEST (Zero JS Rollback, Clean DB Rollback) (Lỗi 2, 3, 13)
  // =========================================================================
  console.log('📌 TEST 2: Ingress Atomicity: Lỗi tại bước ghi private raw -> Rollback sạch sẽ, status = FAILED');
  {
    const mockDb = createMockDatabase();
    // Simulate private raw vault failure inside atomic RPC
    mockDb._failPrivateRaw = true;

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
          json: async () => ({ error: 0, data: { user_id: 'user_atom_01', user_name: 'Khách Atom' } }),
        })) as unknown as typeof fetch,
      }),
    });

    const rawMsgId = 'msg_atom_fail_001';
    const payload: ZaloWebhookPayload = {
      event_name: 'user_send_text',
      oa_id: companyAOaId,
      sender: { id: 'user_atom_01' },
      recipient: { id: companyAOaId },
      message: {
        msg_id: rawMsgId,
        text: 'Nội dung kiểm tra tính nguyên tử',
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

    assert.strictEqual(pipelineThrew, true, 'Sync service MUST throw error when atomic RPC fails');

    // Invariant: Zero orphan records in public/private business tables
    assert.strictEqual(mockDb.interactions.length, 0, 'Zero orphan interactions');
    assert.strictEqual(mockDb.conversations.length, 0, 'Zero orphan conversations');
    assert.strictEqual(mockDb.customers.length, 0, 'Zero orphan customers');
    assert.strictEqual(mockDb.identities.length, 0, 'Zero orphan identities');
    assert.strictEqual(mockDb.interaction_raw_contents.length, 0, 'Zero orphan raw contents');

    // Invariant: Ingress event is marked FAILED with last_error in DB
    assert.strictEqual(mockDb.zalo_ingress_events.length, 1, 'Exactly 1 ingress event tracked in DB');
    const ingressRecord = mockDb.zalo_ingress_events[0];
    assert.strictEqual(ingressRecord.status, 'FAILED', 'Ingress event status must be FAILED');
    assert.ok(ingressRecord.last_error?.includes('Security Zone Ingress Violation'), 'last_error must be recorded');

    console.log('  ✓ Test 2 Passed: DB atomic rollback verified; zero orphan records; event status = FAILED.\n');
  }

  // =========================================================================
  // TEST 3: INGRESS STATE MACHINE TEST (PROCESSED, FAILED, CLAIMED LEASE) (Lỗi 2)
  // =========================================================================
  console.log('📌 TEST 3: Ingress State Machine: PROCESSED -> duplicate; FAILED -> re-claim; CLAIMED active -> busy');
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
          json: async () => ({ error: 0, data: { user_id: 'user_sm_01', user_name: 'Khách State Machine' } }),
        })) as unknown as typeof fetch,
      }),
    });

    const msgId = 'msg_state_machine_001';
    const payload: ZaloWebhookPayload = {
      event_name: 'user_send_text',
      oa_id: companyAOaId,
      sender: { id: 'user_sm_01' },
      recipient: { id: companyAOaId },
      message: { msg_id: msgId, text: 'Kiểm tra state machine transition' },
      timestamp: Date.now(),
    };

    // 3.1 Initial failure -> Event marked FAILED
    mockDb._failProcessIngress = true;
    try {
      await syncService.handleWebhookEvent(payload);
    } catch {
      // Expected failure
    }
    assert.strictEqual(mockDb.zalo_ingress_events[0].status, 'FAILED', 'Status must be FAILED after transient failure');

    // 3.2 Resend same payload when FAILED -> Re-claim succeeds, processes to completion (PROCESSED)
    mockDb._failProcessIngress = false;
    const resRecovered = await syncService.handleWebhookEvent(payload);
    assert.strictEqual(resRecovered.status, 'synced', 'Re-claim of FAILED event must succeed and return synced');
    assert.strictEqual(mockDb.zalo_ingress_events[0].status, 'PROCESSED', 'Status transitioned to PROCESSED');
    assert.strictEqual(mockDb.zalo_ingress_events[0].retry_count, 1, 'Retry count incremented to 1');

    // 3.3 Resend same payload when PROCESSED -> Returns duplicate safely (no re-processing)
    const resDuplicate = await syncService.handleWebhookEvent(payload);
    assert.strictEqual(resDuplicate.status, 'duplicate', 'Sequential replay of PROCESSED event returns duplicate');
    assert.strictEqual(mockDb.interactions.length, 1, 'Interaction count remains 1');

    // 3.4 Event in CLAIMED state with active lease -> Returns busy / retry-later
    const busyMsgId = 'msg_busy_lease_001';
    const busyExternalRef = `zalo:${companyAId}:${companyAOaId}:${busyMsgId}`;
    mockDb.zalo_ingress_events.push({
      company_id: companyAId,
      oa_id: companyAOaId,
      external_ref: busyExternalRef,
      status: 'CLAIMED',
      lease_until: new Date(Date.now() + 120000).toISOString(), // Active lease (2 mins in future)
      retry_count: 0,
      last_error: null,
    });

    const busyPayload: ZaloWebhookPayload = {
      event_name: 'user_send_text',
      oa_id: companyAOaId,
      sender: { id: 'user_sm_01' },
      recipient: { id: companyAOaId },
      message: { msg_id: busyMsgId, text: 'Đang có worker khác xử lý' },
      timestamp: Date.now(),
    };

    const resBusy = await syncService.handleWebhookEvent(busyPayload);
    assert.strictEqual(resBusy.status, 'busy', 'Active lease event must return busy / retry-later');
    assert.ok(resBusy.message?.toLowerCase().includes('retry later'), 'Message informs caller to retry later');

    console.log('  ✓ Test 3 Passed: State transitions PROCESSED -> duplicate, FAILED -> re-claim, CLAIMED -> busy verified.\n');
  }

  // =========================================================================
  // TEST 4: OUTBOUND AUTHORIZATION TEST (Actor & Role Whitelist) (Lỗi 4)
  // =========================================================================
  console.log('📌 TEST 4: Outbound Authorization: Thiếu actor hoặc role khác SALE/BOSS_ADMIN -> Chặn 403');
  {
    const mockDb = createMockDatabase({
      conversations: [
        {
          id: 'conv_auth_001',
          company_id: companyAId,
          customer_id: 'cust_auth_01',
          channel: 'ZALO',
          external_conversation_id: 'zalo_uid_auth',
          last_message_at: new Date().toISOString(),
          unread_count: 0,
          status: 'OPEN',
        },
      ],
      identities: [
        {
          id: 'ident_auth_01',
          company_id: companyAId,
          customer_id: 'cust_auth_01',
          channel: 'ZALO',
          external_id: 'zalo_uid_auth',
          verified: true,
        },
      ],
    });

    const supabase = createMockSupabase(mockDb);
    const mockZaloClient = new ZaloClient({
      companyId: companyAId,
      oaId: companyAOaId,
      accessToken: 'token_auth',
      fetchFn: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: 0, message: 'Success', data: { message_id: 'msg_auth_sent' } }),
      })) as unknown as typeof fetch,
    });

    const inboxService = new ZaloInboxService({
      supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
      zaloClient: mockZaloClient,
    });

    const replyParams = {
      conversationId: 'conv_auth_001',
      content: 'Tin nhắn phản hồi từ nhân viên',
    };

    // 4.1 Missing actor -> Throws 401
    let missingActor401 = false;
    try {
      await inboxService.sendZaloReply(replyParams, {} as unknown as { actor: { userId: string; companyId: string; role: 'SALE' } });
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 401) {
        missingActor401 = true;
      }
    }
    assert.strictEqual(missingActor401, true, 'Missing actor must throw 401 UNAUTHORIZED');

    // 4.2 Disallowed role TECHNICIAN -> Throws 403
    let techForbidden403 = false;
    try {
      await inboxService.sendZaloReply(replyParams, {
        actor: { userId: 'tech_01', companyId: companyAId, role: 'TECHNICIAN' as unknown as 'SALE' },
      });
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403) {
        techForbidden403 = true;
      }
    }
    assert.strictEqual(techForbidden403, true, 'Role TECHNICIAN must be rejected with 403 FORBIDDEN');

    // 4.3 Tenant mismatch (Cross-tenant attempt) -> Throws 403
    let tenantMismatch403 = false;
    try {
      await inboxService.sendZaloReply(replyParams, {
        actor: { userId: 'sale_tenant_b', companyId: companyBId, role: 'SALE' },
      });
    } catch (err: unknown) {
      if (err instanceof ServerAuthError && err.status === 403) {
        tenantMismatch403 = true;
      }
    }
    assert.strictEqual(tenantMismatch403, true, 'Tenant mismatch must be rejected with 403 FORBIDDEN');

    // 4.4 Allowed role SALE with matching tenant -> Succeeds
    const resSale = await inboxService.sendZaloReply(replyParams, {
      actor: { userId: 'sale_user_01', companyId: companyAId, role: 'SALE' },
    });
    assert.strictEqual(resSale.success, true, 'Role SALE with valid tenant must succeed');

    // 4.5 Allowed role BOSS_ADMIN with matching tenant -> Succeeds
    const resBoss = await inboxService.sendZaloReply(replyParams, {
      actor: { userId: 'boss_user_01', companyId: companyAId, role: 'BOSS_ADMIN' },
    });
    assert.strictEqual(resBoss.success, true, 'Role BOSS_ADMIN with valid tenant must succeed');

    // 4.6 System Principal for automated reply -> Succeeds
    const resSys = await inboxService.sendSystemZaloReply(replyParams, { principal: 'SYSTEM' });
    assert.strictEqual(resSys.success, true, 'System principal automated reply must succeed');

    console.log('  ✓ Test 4 Passed: Actor & role authentication strictly enforced (SALE / BOSS_ADMIN whitelist).\n');
  }

  // =========================================================================
  // TEST 5: OUTBOUND FAIL-CLOSED & FINALIZE RECONCILIATION TEST (Lỗi 5, 6)
  // =========================================================================
  console.log('📌 TEST 5: Outbound Fail-Closed: Outbox fail -> Provider không gọi; Finalize fail -> PROVIDER_SENT_PENDING_FINALIZE');
  {
    const mockDb = createMockDatabase({
      conversations: [
        {
          id: 'conv_fc_001',
          company_id: companyAId,
          customer_id: 'cust_fc_01',
          channel: 'ZALO',
          external_conversation_id: 'zalo_uid_fc',
          last_message_at: new Date().toISOString(),
          unread_count: 0,
          status: 'OPEN',
        },
      ],
      identities: [
        {
          id: 'ident_fc_01',
          company_id: companyAId,
          customer_id: 'cust_fc_01',
          channel: 'ZALO',
          external_id: 'zalo_uid_fc',
          verified: true,
        },
      ],
    });

    let providerCallCount = 0;
    const trackingZaloClient = new ZaloClient({
      companyId: companyAId,
      oaId: companyAOaId,
      accessToken: 'token_fc',
      fetchFn: (async () => {
        providerCallCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            error: 0,
            message: 'Success',
            data: { message_id: `provider_msg_${providerCallCount}` },
          }),
        };
      }) as unknown as typeof fetch,
    });

    const baseSupabase = createMockSupabase(mockDb);
    mockDb._failOutboxInsert = true;

    const failingOutboxService = new ZaloInboxService({
      supabase: baseSupabase as unknown as import('@supabase/supabase-js').SupabaseClient,
      zaloClient: trackingZaloClient,
    });

    let outboxClaimFailed = false;
    try {
      await failingOutboxService.sendZaloReply(
        { conversationId: 'conv_fc_001', content: 'Tin nhắn thử fail-closed' },
        { actor: { userId: 'sale_01', companyId: companyAId, role: 'SALE' } }
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('outbox claim failed')) {
        outboxClaimFailed = true;
      }
    }

    assert.strictEqual(outboxClaimFailed, true, 'Must throw error when outbox claim fails');
    assert.strictEqual(providerCallCount, 0, 'FAIL-CLOSED INVARIANT: Provider MUST NOT be called if outbox claim fails');

    // 5.2 Provider succeeds but DB finalize crashes -> Record marked PROVIDER_SENT_PENDING_FINALIZE
    mockDb._failOutboxInsert = false;
    mockDb._failOutboundFinalize = true;
    const inboxService = new ZaloInboxService({
      supabase: baseSupabase as unknown as import('@supabase/supabase-js').SupabaseClient,
      zaloClient: trackingZaloClient,
    });

    let finalizeCrashed = false;
    try {
      await inboxService.sendZaloReply(
        { conversationId: 'conv_fc_001', content: 'Tin nhắn gửi Zalo thành công nhưng DB crash' },
        { actor: { userId: 'sale_01', companyId: companyAId, role: 'SALE' } }
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('PROVIDER_SENT_PENDING_FINALIZE')) {
        finalizeCrashed = true;
      }
    }

    assert.strictEqual(finalizeCrashed, true, 'Must flag error when DB finalize fails');
    assert.strictEqual(providerCallCount, 1, 'Provider was called exactly once');

    // Verify delivery state in DB
    const pendingFinalizeRecord = mockDb.zalo_outbound_deliveries[0];
    assert.strictEqual(
      pendingFinalizeRecord.status,
      'PROVIDER_SENT_PENDING_FINALIZE',
      'Delivery status must be PROVIDER_SENT_PENDING_FINALIZE'
    );
    assert.strictEqual(pendingFinalizeRecord.provider_msg_id, 'provider_msg_1', 'provider_msg_id must be preserved');
    assert.strictEqual(mockDb.interactions.length, 0, 'No interaction committed yet due to crash');

    // 5.3 Reconcile pending deliveries -> Retries ONLY DB finalize (NEVER re-calls provider)
    mockDb._failOutboundFinalize = false;
    const reconcileResult = await inboxService.reconcilePendingDeliveries({ companyId: companyAId });

    assert.strictEqual(reconcileResult.reconciled, 1, 'Delivery must be successfully reconciled');
    assert.strictEqual(providerCallCount, 1, 'INVARIANT: Provider call count remains 1 (NO duplicate message sent to customer)');
    assert.strictEqual(mockDb.zalo_outbound_deliveries[0].status, 'SENT', 'Outbox delivery status updated to SENT');
    assert.strictEqual(mockDb.interactions.length, 1, 'Interaction record committed into DB with provider_msg_id');

    console.log('  ✓ Test 5 Passed: Fail-closed outbox verified; crash records PROVIDER_SENT_PENDING_FINALIZE; reconcile does NOT resend provider.\n');
  }

  // =========================================================================
  // TEST 6: CARE WORKER CONCURRENT CLAIM TEST (Lỗi 9)
  // =========================================================================
  console.log('📌 TEST 6: Care Worker Claim: 2 worker chạy song song cùng target -> Chỉ đúng 1 worker claim & gửi provider 1 lần');
  {
    const originalDate = new Date('2026-09-01T08:00:00Z');
    const mockDb = createMockDatabase({
      customers: [{ id: 'cust_care_race', company_id: companyAId, name: 'Khách Chăm Sóc Đua', stage: 'CARE_NURTURING' }],
      identities: [{ id: 'ident_care_race', company_id: companyAId, customer_id: 'cust_care_race', channel: 'ZALO', external_id: 'zalo_care_race_uid', verified: true }],
      care_schedules: [
        {
          id: 'sched_race_001',
          company_id: companyAId,
          customer_id: 'cust_care_race',
          channel: 'ZALO',
          frequency_months: 1,
          next_send_at: originalDate.toISOString(),
          enabled: true,
          stop_reason: null,
        },
      ],
    });

    const supabase = createMockSupabase(mockDb);

    let careProviderSends = 0;
    const sharedClient = new ZaloClient({
      companyId: companyAId,
      oaId: companyAOaId,
      accessToken: 'token_care_race',
      fetchFn: (async () => {
        careProviderSends++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ error: 0, message: 'Success', data: { message_id: `care_msg_${careProviderSends}` } }),
        };
      }) as unknown as typeof fetch,
    });

    const worker1 = new ZaloCareSchedulerService({
      supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
      zaloClient: sharedClient,
    });

    const worker2 = new ZaloCareSchedulerService({
      supabase: supabase as unknown as import('@supabase/supabase-js').SupabaseClient,
      zaloClient: sharedClient,
    });

    // Run both workers concurrently targeting the exact same schedule and target date
    const [res1, res2] = await Promise.all([
      worker1.processDueSchedules({ companyId: companyAId, asOfDate: new Date('2026-09-02T00:00:00Z') }),
      worker2.processDueSchedules({ companyId: companyAId, asOfDate: new Date('2026-09-02T00:00:00Z') }),
    ]);

    const totalAdvanced = res1.advanced + res2.advanced;
    const totalSkipped = res1.skipped + res2.skipped;

    assert.strictEqual(totalAdvanced, 1, 'Exactly 1 worker must claim and advance the schedule');
    assert.strictEqual(totalSkipped, 1, 'Exactly 1 worker must be skipped by atomic claim');
    assert.strictEqual(careProviderSends, 1, 'Care provider send MUST be called exactly once');

    // Verify DB delivery record
    assert.strictEqual(mockDb.care_deliveries.length, 1, 'Exactly 1 care delivery record created');
    assert.strictEqual(mockDb.care_deliveries[0].status, 'SENT', 'Delivery status must be SENT');

    // Verify schedule advanced correctly
    const scheduleInDb = mockDb.care_schedules[0];
    assert.notStrictEqual(scheduleInDb.next_send_at, originalDate.toISOString(), 'Schedule next_send_at was advanced');

    console.log('  ✓ Test 6 Passed: Atomic worker claim eliminates duplicate customer care sends in parallel cluster.\n');
  }

  // =========================================================================
  // TEST 7: SECRET STORAGE HARDENING & MULTI-TENANT TOKEN SWITCHING (Lỗi 8, P0 #6/#7)
  // =========================================================================
  console.log('📌 TEST 7: Secret Storage Hardening: Multi-tenant token isolation & rotation against private.zalo_oa_secrets');
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

    console.log('  ✓ Test 7 Passed: Multi-tenant token isolation & switching verified strictly.\n');
  }

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('🎉 TẤT CẢ 7 HẠNG MỤC REMEDIATION P0 & P1 ĐỀU ĐẠT CHUẨN KIẾN TRÚC 100%!');
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
