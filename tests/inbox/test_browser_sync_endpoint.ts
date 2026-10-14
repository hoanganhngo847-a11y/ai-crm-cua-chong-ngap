import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { POST as browserSyncHandler } from '../../app/api/inbox/browser-sync/route';
import { InboxService } from '../../features/inbox/services/inbox.service';

async function runBrowserSyncEndpointTests() {
  process.env.DEMO_MODE = 'true';
  process.env.FB_WORKER_SECRET = 'test_secret_browser_sync_2026';

  console.log('======================================================================');
  console.log('TEST SUITE: /api/inbox/browser-sync Server-to-Server Security & Ingestion');
  console.log('======================================================================');

  // Case 1: Unauthorized - missing secret header
  {
    console.log('[Test 1] Missing x-worker-secret header -> Expect 401');
    const req = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        content: 'Xin chào',
        direction: 'inbound',
      }),
      headers: {
        'content-type': 'application/json',
      },
    });

    const res = await browserSyncHandler(req);
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error, 'UNAUTHORIZED');
    console.log('  -> PASS: 401 UNAUTHORIZED');
  }

  // Case 2: Unauthorized - wrong secret
  {
    console.log('[Test 2] Invalid x-worker-secret header -> Expect 401');
    const req = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        content: 'Xin chào',
        direction: 'inbound',
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'wrong_secret_123',
      },
    });

    const res = await browserSyncHandler(req);
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error, 'UNAUTHORIZED');
    console.log('  -> PASS: 401 UNAUTHORIZED on wrong secret');
  }

  // Case 3: Rejection of OUTBOUND message
  {
    console.log('[Test 3] direction === "outbound" -> Expect 400 (Strict Inbound Only)');
    const req = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: '1389294167596309',
        page_name: 'Cửa Chống Ngập',
        sender_name: 'Page Admin',
        external_conversation_id: 'thread_fb_001',
        external_message_id: 'msg_hash_001',
        content: 'page cửa chống ngập xin chào bạn',
        direction: 'outbound',
        timestamp: new Date().toISOString(),
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });

    const res = await browserSyncHandler(req);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error, 'INVALID_DIRECTION');
    console.log('  -> PASS: 400 INVALID_DIRECTION correctly blocks outbound messages');
  }

  // Case 4: Rejection of missing required fields
  {
    console.log('[Test 4] Missing external_conversation_id or message_id -> Expect 400');
    const req = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        direction: 'inbound',
        content: 'Tôi muốn tư vấn cửa',
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });

    const res = await browserSyncHandler(req);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error, 'MISSING_THREAD_ID');
    console.log('  -> PASS: 400 MISSING_THREAD_ID');
  }

  // Case 5: Successful Inbound Message Ingestion
  let createdConvId = '';
  const testMessageId = `msg_test_${Date.now()}`;
  {
    console.log('[Test 5] Valid INBOUND message -> Expect 200 & new conversation created');
    const req = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: '1389294167596309',
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Linh Hạ Test',
        customer_fb_id: '61578695363056',
        external_conversation_id: 'thread_linh_ha_123',
        external_message_id: testMessageId,
        content: 'xin chào page cửa chống ngập',
        direction: 'inbound',
        timestamp: '2026-10-12T10:00:00.000Z',
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });

    const res = await browserSyncHandler(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.is_duplicate, false);
    assert.ok(body.conversation_id, 'Must return conversation_id');
    assert.ok(body.interaction_id, 'Must return interaction_id');
    createdConvId = body.conversation_id;
    console.log(`  -> PASS: Ingested successfully, conversation_id=${body.conversation_id}, interaction_id=${body.interaction_id}`);
  }

  // Case 6: Idempotency Verification (Durable Deduplication)
  {
    console.log('[Test 6] Resending identical message -> Expect 200 with is_duplicate === true');
    const req = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: '1389294167596309',
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Linh Hạ Test',
        customer_fb_id: '61578695363056',
        external_conversation_id: 'thread_linh_ha_123',
        external_message_id: testMessageId,
        content: 'xin chào page cửa chống ngập',
        direction: 'inbound',
        timestamp: '2026-10-12T10:00:00.000Z',
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });

    const res = await browserSyncHandler(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.is_duplicate, true);
    assert.strictEqual(body.conversation_id, createdConvId);
    console.log('  -> PASS: Idempotency guaranteed, duplicate flagged without re-insertion');
  }

  // Case 7: Metadata Verification
  {
    console.log('[Test 7] Verify conversation metadata contains provider = facebook_browser');
    const conv = await InboxService.getConversationById(
      '00000000-0000-0000-0000-000000000001',
      createdConvId
    );
    assert.ok(conv, 'Conversation must exist');
    assert.strictEqual(conv.channel, 'facebook');
    assert.strictEqual(conv.metadata?.provider, 'facebook_browser');
    assert.strictEqual(conv.metadata?.page_id, '1389294167596309');
    assert.strictEqual(conv.metadata?.customer_fb_id, '61578695363056');
    console.log('  -> PASS: Conversation metadata correctly contains provider: facebook_browser & customer_fb_id');
  }

  // Case 8: Dual-fingerprint migration idempotency check (v1 legacy ref vs v2 new ref)
  {
    console.log('[Test 8] Dual-fingerprint deduplication: initial legacy hash, subsequent request with new hash + legacy ref -> Expect is_duplicate === true');
    const legacyHash = `legacy_hash_${Date.now()}`;
    const newHash = `new_mid_hash_${Date.now()}`;

    // 1. Initial ingestion with legacy hash
    const initialReq = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: '1389294167596309',
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Khách hàng DualRef',
        customer_fb_id: '61578695363099',
        external_conversation_id: 'thread_dual_ref_test',
        external_message_id: legacyHash,
        content: 'kiem tra dual ref',
        direction: 'inbound',
        timestamp: new Date().toISOString(),
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });
    const initRes = await (await browserSyncHandler(initialReq)).json();
    assert.strictEqual(initRes.success, true);
    assert.strictEqual(initRes.is_duplicate, false);

    // 2. Subsequent request with new v2 hash AND legacy_external_message_id
    const upgradedReq = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: '1389294167596309',
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Khách hàng DualRef',
        customer_fb_id: '61578695363099',
        external_conversation_id: 'thread_dual_ref_test',
        external_message_id: newHash,
        legacy_external_message_id: legacyHash,
        content: 'kiem tra dual ref',
        direction: 'inbound',
        timestamp: new Date().toISOString(),
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });
    const upgradedRes = await (await browserSyncHandler(upgradedReq)).json();
    assert.strictEqual(upgradedRes.success, true);
    assert.strictEqual(upgradedRes.is_duplicate, true);
    assert.strictEqual(upgradedRes.interaction_id, initRes.interaction_id);
    console.log('  -> PASS: Dual-fingerprint deduplication verified, existing legacy interaction recognized as duplicate without re-inserting');
  }

  // Case 9: GET /api/inbox/browser-sync has been REMOVED (PR #46)
  // Verify that the module no longer exports a GET handler
  {
    console.log('[Test 9] Verify GET lookup endpoint has been removed (tenant isolation + attack surface fix)');
    // Dynamic import to check exports
    const routeModule = await import('../../app/api/inbox/browser-sync/route');
    const hasGet = typeof (routeModule as Record<string, unknown>).GET === 'function';
    assert.strictEqual(hasGet, false, 'GET handler must be removed');
    console.log('  -> PASS: GET endpoint correctly removed, no longer exported');
  }

  console.log('======================================================================');
  console.log('ALL TESTS PASSED SUCCESSFULLY!');
  console.log('======================================================================');
}

runBrowserSyncEndpointTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
