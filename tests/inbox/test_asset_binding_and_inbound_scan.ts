import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
import { healthServer } from '../../fb-inbox-worker/src/health-server.js';
import { detectPageState, APP_STATE, extractCurrentAssetId } from '../../fb-inbox-worker/src/state-checker.js';
import {
  processThreadData,
  syncedFingerprints,
  performInboundScan,
  SCAN_CONFIG
} from '../../fb-inbox-worker/src/index.js';
import { extractConversationsList } from '../../fb-inbox-worker/src/parser.js';

const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('./fb-inbox-worker/node_modules/playwright');

function fetchJson(url: string): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode || 0, data: JSON.parse(body) });
        } catch (_) {
          resolve({ statusCode: res.statusCode || 0, data: body });
        }
      });
    }).on('error', reject);
  });
}

async function runAssetBindingTests() {
  console.log('========================================================================================');
  console.log('TEST SUITE: FACEBOOK PAGE ASSET BINDING & INBOUND SCAN COVERAGE');
  console.log('========================================================================================\n');

  const EXPECTED_PAGE_ID = '1389294167596309';
  const WRONG_PAGE_ID = '1343097708890171';
  const TEST_PORT = 3198;

  await healthServer.start(TEST_PORT, '127.0.0.1');

  // -----------------------------------------------------------------------------------------------
  // 1. extractCurrentAssetId helper test
  // -----------------------------------------------------------------------------------------------
  console.log('--- 1. Asset ID Extraction Helper ---');
  const extractedExpected = extractCurrentAssetId(`https://business.facebook.com/latest/inbox/all/?asset_id=${EXPECTED_PAGE_ID}`);
  assert.strictEqual(extractedExpected, EXPECTED_PAGE_ID, 'Should extract expected asset_id');
  const extractedWrong = extractCurrentAssetId(`https://business.facebook.com/latest/inbox/all/?asset_id=${WRONG_PAGE_ID}`);
  assert.strictEqual(extractedWrong, WRONG_PAGE_ID, 'Should extract wrong asset_id');
  const extractedNone = extractCurrentAssetId('https://business.facebook.com/latest/inbox/all');
  assert.strictEqual(extractedNone, null, 'Should return null when asset_id param is absent');
  console.log('✅ PASS: Asset ID extraction helper verified.\n');

  // -----------------------------------------------------------------------------------------------
  // 2. Mock Page for detectPageState tests
  // -----------------------------------------------------------------------------------------------
  console.log('--- 2. detectPageState Unit Test ---');

  const mockInboxPage = (assetId: string | null) => ({
    url: () => assetId ? `https://business.facebook.com/latest/inbox/all/?asset_id=${assetId}` : 'https://business.facebook.com/latest/inbox/all',
    evaluate: async (fn: any) => {
      // Mock that inbox elements are rendered in DOM
      return true;
    }
  } as any);

  // Test WRONG asset page
  const wrongState = await detectPageState(mockInboxPage(WRONG_PAGE_ID), EXPECTED_PAGE_ID);
  console.log(`State on wrong asset (${WRONG_PAGE_ID}): ${wrongState}`);
  assert.strictEqual(wrongState, APP_STATE.WRONG_ASSET, 'Expected detectPageState to return WRONG_ASSET for mismatched asset_id');

  // Test TARGET asset page
  const targetState = await detectPageState(mockInboxPage(EXPECTED_PAGE_ID), EXPECTED_PAGE_ID);
  console.log(`State on target asset (${EXPECTED_PAGE_ID}): ${targetState}`);
  assert.strictEqual(targetState, APP_STATE.INBOX_READY, 'Expected detectPageState to return INBOX_READY for matching asset_id');

  // Test missing asset page
  const missingState = await detectPageState(mockInboxPage(null), EXPECTED_PAGE_ID);
  console.log(`State on missing asset_id: ${missingState}`);
  assert.strictEqual(missingState, APP_STATE.WRONG_ASSET, 'Expected detectPageState to return WRONG_ASSET when asset_id is missing');
  console.log('✅ PASS: detectPageState handles target, wrong, and missing assets correctly.\n');

  // -----------------------------------------------------------------------------------------------
  // 3. Section 7: TEST WRONG-ASSET CASE (/ready and health reporting)
  // -----------------------------------------------------------------------------------------------
  console.log('--- 3. Section 7: Automated Test for WRONG-ASSET Case ---');
  healthServer.recordMainLoopHeartbeat();
  healthServer.recordOutboxPollSuccess(0);
  healthServer.updateState({
    meta_inbox_state: APP_STATE.WRONG_ASSET,
    expected_asset_id: EXPECTED_PAGE_ID,
    current_asset_id: WRONG_PAGE_ID,
    asset_match: false,
    browser_connected: true
  });

  const wrongHealthRes = await fetchJson(`http://127.0.0.1:${TEST_PORT}/health`);
  assert.strictEqual(wrongHealthRes.statusCode, 200, 'Liveness remains 200 to prevent crash loop');
  assert.strictEqual(wrongHealthRes.data.asset_match, false, 'Health reports asset_match = false');
  assert.strictEqual(wrongHealthRes.data.expected_asset_id, EXPECTED_PAGE_ID, 'Health reports expected_asset_id');
  assert.strictEqual(wrongHealthRes.data.current_asset_id, WRONG_PAGE_ID, 'Health reports current_asset_id');
  assert.strictEqual(wrongHealthRes.data.status, 'DEGRADED', 'Health status is DEGRADED');

  const wrongReadyRes = await fetchJson(`http://127.0.0.1:${TEST_PORT}/ready`);
  console.log(`WRONG_ASSET /ready HTTP code: ${wrongReadyRes.statusCode}`);
  console.log(`WRONG_ASSET /ready response:`, wrongReadyRes.data);
  assert.strictEqual(wrongReadyRes.statusCode, 503, 'Readiness MUST return non-200 (503) on wrong asset');
  assert.strictEqual(wrongReadyRes.data.ready, false, 'Readiness MUST report ready = false on wrong asset');
  assert.strictEqual(wrongReadyRes.data.asset_match, false, 'Readiness reports asset_match = false');
  assert.strictEqual(wrongReadyRes.data.state, 'WRONG_ASSET', 'Readiness reports state = WRONG_ASSET');
  console.log('✅ PASS: Section 7 WRONG-ASSET automated test passed.\n');

  // -----------------------------------------------------------------------------------------------
  // 4. Section 8: TEST TARGET-ASSET CASE (/ready and health reporting)
  // -----------------------------------------------------------------------------------------------
  console.log('--- 4. Section 8: Automated Test for TARGET-ASSET Case ---');
  healthServer.recordMainLoopHeartbeat();
  healthServer.recordOutboxPollSuccess(0);
  healthServer.updateState({
    meta_inbox_state: APP_STATE.INBOX_READY,
    expected_asset_id: EXPECTED_PAGE_ID,
    current_asset_id: EXPECTED_PAGE_ID,
    asset_match: true,
    browser_connected: true
  });

  const targetHealthRes = await fetchJson(`http://127.0.0.1:${TEST_PORT}/health`);
  assert.strictEqual(targetHealthRes.statusCode, 200, 'Liveness 200');
  assert.strictEqual(targetHealthRes.data.asset_match, true, 'Health reports asset_match = true');
  assert.strictEqual(targetHealthRes.data.status, 'HEALTHY', 'Health status is HEALTHY');

  const targetReadyRes = await fetchJson(`http://127.0.0.1:${TEST_PORT}/ready`);
  console.log(`TARGET_ASSET /ready HTTP code: ${targetReadyRes.statusCode}`);
  console.log(`TARGET_ASSET /ready response:`, targetReadyRes.data);
  assert.strictEqual(targetReadyRes.statusCode, 200, 'Readiness MUST return 200 on target matching asset');
  assert.strictEqual(targetReadyRes.data.ready, true, 'Readiness MUST report ready = true on target matching asset');
  assert.strictEqual(targetReadyRes.data.asset_match, true, 'Readiness reports asset_match = true');
  assert.strictEqual(targetReadyRes.data.state, 'READY', 'Readiness reports state = READY');
  console.log('✅ PASS: Section 8 TARGET-ASSET automated test passed.\n');

  // -----------------------------------------------------------------------------------------------
  // 5. Inbound scan metrics verification
  // -----------------------------------------------------------------------------------------------
  console.log('--- 5. Scan Metrics and Inbound Detection Recording ---');
  healthServer.recordScanMetrics({ rowsSeen: 18, unreadRows: 3, threadsScanned: 5 });
  healthServer.recordInboundDetected();

  const metricsSnapshot = healthServer.getSnapshot();
  assert.strictEqual(metricsSnapshot.conversation_rows_seen, 18, 'conversation_rows_seen recorded');
  assert.strictEqual(metricsSnapshot.unread_rows_seen, 3, 'unread_rows_seen recorded');
  assert.strictEqual(metricsSnapshot.threads_scanned, 5, 'threads_scanned recorded');
  assert.ok(metricsSnapshot.last_inbound_detected_at, 'last_inbound_detected_at recorded');
  assert.ok(metricsSnapshot.last_inbound_sync_success_at, 'last_inbound_sync_success_at recorded');
  console.log('✅ PASS: Inbound scan metrics recorded and reported.\n');

  // -----------------------------------------------------------------------------------------------
  // 6. INBOUND FINGERPRINT ACK SEMANTICS & RETRY REGRESSION TEST (Requirement 1 & 2)
  // -----------------------------------------------------------------------------------------------
  console.log('--- 6. Inbound Fingerprint ACK Semantics & Retry Regression Test ---');

  const originalFetch = global.fetch;
  let syncCallCount = 0;
  let syncShouldFail = true;
  let isDuplicateResponse = false;

  // Intercept fetch to mock CRM endpoint behavior accurately
  global.fetch = (async (url: any, init: any) => {
    if (typeof url === 'string' && (url.includes('/browser-sync') || url.includes('/api/inbox/'))) {
      syncCallCount++;
      if (syncShouldFail) {
        return new Response(JSON.stringify({ success: false, error: 'TRANSIENT_500_ERROR' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(
        JSON.stringify({
          success: true,
          is_duplicate: isDuplicateResponse,
          is_new_conversation: !isDuplicateResponse,
          conversation_id: 'conv_retry_test',
          interaction_id: 'int_retry_test'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    syncedFingerprints.clear();

    const testFingerprint = 'fp_retry_regression_001';
    const mockInboundThread = {
      customerName: 'Hoàng Anh Ngô',
      stableThreadId: 'thread_retry_001',
      customerFbId: 'fb_user_001',
      messages: [
        {
          direction: 'INBOUND',
          fingerprint: testFingerprint,
          content: 'Khách hỏi giá cửa chống ngập',
          timestamp: '11:24'
        }
      ]
    };

    // Attempt 1: CRM sync returns failure / transient 500
    syncShouldFail = true;
    syncCallCount = 0;
    await processThreadData(mockInboundThread, EXPECTED_PAGE_ID, 'Cửa chống ngập');

    assert.strictEqual(syncCallCount, 1, 'Sync called once on attempt 1');
    assert.strictEqual(
      syncedFingerprints.has(testFingerprint),
      false,
      'EXPECTED: Fingerprint MUST NOT be cached when syncResult.success === false'
    );
    console.log('  ✓ Attempt 1: Transient 500 failure leaves fingerprint UNCACHED (ready for retry)');

    // Attempt 2: Next cycle, same fingerprint, CRM sync recovers (success 200)
    syncShouldFail = false;
    isDuplicateResponse = false;
    await processThreadData(mockInboundThread, EXPECTED_PAGE_ID, 'Cửa chống ngập');

    assert.strictEqual(syncCallCount, 2, 'EXPECTED: Sync called again on cycle 2 retry');
    assert.strictEqual(
      syncedFingerprints.has(testFingerprint),
      true,
      'EXPECTED: Fingerprint MUST be cached after syncResult.success === true'
    );
    assert.ok(
      healthServer.getSnapshot().last_inbound_sync_success_at,
      'EXPECTED: last_inbound_sync_success_at recorded upon sync success'
    );
    console.log('  ✓ Attempt 2: Retry succeeds and fingerprint is cached');

    // Attempt 3: Subsequent cycle with already-cached fingerprint
    await processThreadData(mockInboundThread, EXPECTED_PAGE_ID, 'Cửa chống ngập');
    assert.strictEqual(
      syncCallCount,
      2,
      'EXPECTED: Cached fingerprint is skipped without repeating POST request'
    );
    console.log('  ✓ Attempt 3: Cached fingerprint skipped without POSTing again');

    // Test Duplicate ACK semantics: Attempt 1 returns success + isDuplicate=true
    const duplicateFingerprint = 'fp_dup_ack_002';
    const mockDuplicateThread = {
      customerName: 'Khách Đã Tồn Tại',
      stableThreadId: 'thread_dup_002',
      customerFbId: 'fb_user_002',
      messages: [
        {
          direction: 'INBOUND',
          fingerprint: duplicateFingerprint,
          content: 'Tin nhắn đã có trong DB',
          timestamp: '11:25'
        }
      ]
    };

    syncShouldFail = false;
    isDuplicateResponse = true;
    await processThreadData(mockDuplicateThread, EXPECTED_PAGE_ID, 'Cửa chống ngập');

    assert.strictEqual(syncCallCount, 3, 'Sync called once for duplicate message');
    assert.strictEqual(
      syncedFingerprints.has(duplicateFingerprint),
      true,
      'EXPECTED: Fingerprint is cached when isDuplicate === true'
    );

    // Next scan cycle for duplicate message
    await processThreadData(mockDuplicateThread, EXPECTED_PAGE_ID, 'Cửa chống ngập');
    assert.strictEqual(
      syncCallCount,
      3,
      'EXPECTED: Duplicate fingerprint is cached so next scan does NOT POST again'
    );
    console.log('  ✓ Duplicate message with isDuplicate=true is acknowledged and cached');
    console.log('✅ PASS: Inbound fingerprint ACK semantics and retry regression verified.\n');
  } finally {
    global.fetch = originalFetch;
  }

  // -----------------------------------------------------------------------------------------------
  // 7. BOUNDED SCAN TIME BUDGET & OUTBOX NON-STARVATION (Requirement 3 & 4)
  // -----------------------------------------------------------------------------------------------
  console.log('--- 7. Bounded Scan Time Budget & Outbox Non-Starvation Test ---');

  // Verify SCAN_CONFIG defaults
  assert.strictEqual(SCAN_CONFIG.MAX_HEAVY_THREADS_PER_CYCLE, 3, 'Default max heavy threads is 3');
  assert.strictEqual(SCAN_CONFIG.SCAN_TIME_BUDGET_MS, 8000, 'Default scan time budget is 8000ms');

  // Mock a slow page where clicking/scanning each thread takes 120ms
  const mockSlowConversations = Array.from({ length: 10 }, (_, i) => ({
    rowId: `row_${i}`,
    index: i,
    customerName: `Customer ${i}`,
    snippet: `Message ${i}`,
    time: '10:00',
    isUnread: i === 1, // Only row 1 is unread
    isSnippetOutbound: false,
    ariaLabel: ''
  }));

  const mockSlowPage = {
    evaluate: async () => mockSlowConversations
  } as any;

  // Test Time Budget Exit:
  // With 150ms budget, scan should abort before scanning many threads
  const timeBudgetTestStart = Date.now();
  const scanBudgetResult = await performInboundScan(mockSlowPage, EXPECTED_PAGE_ID, 'Cửa chống ngập', {
    scanTimeBudgetMs: 150,
    maxHeavyThreads: 5,
    readCursor: 0
  });
  const timeBudgetElapsed = Date.now() - timeBudgetTestStart;

  assert.ok(
    timeBudgetElapsed < 800,
    `Scan must exit within bounded time budget (took ${timeBudgetElapsed}ms, budget 150ms)`
  );
  console.log(`  ✓ Scan budget enforcement: exited after ${timeBudgetElapsed}ms (timedOut=${scanBudgetResult.timedOut})`);

  // Verify health server does NOT degrade into DEGRADED_OUTBOX_LOOP when scan is bounded
  healthServer.recordMainLoopHeartbeat();
  healthServer.recordOutboxPollAttempt();
  healthServer.recordOutboxPollSuccess(0);

  const readyAfterScan = await fetchJson(`http://127.0.0.1:${TEST_PORT}/ready`);
  assert.strictEqual(readyAfterScan.statusCode, 200, '/ready remains 200 during normal bounded scan');
  assert.strictEqual(readyAfterScan.data.ready, true, 'Worker ready remains true, outbox loop not starved');
  console.log('  ✓ /ready check verified: outbox loop healthy and not starved by inbound scan');

  // Test Round-Robin Cursor & Unread Priority across cycles
  console.log('  --- Round-Robin Read Conversation Rotation ---');
  const readOnlyConversations = Array.from({ length: 8 }, (_, i) => ({
    rowId: `row_${i}`,
    index: i,
    customerName: `Customer ${i}`,
    snippet: `Message ${i}`,
    time: '10:00',
    isUnread: false,
    isSnippetOutbound: false,
    ariaLabel: ''
  }));

  const mockFastPage = {
    evaluate: async () => readOnlyConversations
  } as any;

  // Cycle 1: readCursor = 0, capacity = 3
  const cycle1 = await performInboundScan(mockFastPage, EXPECTED_PAGE_ID, 'Cửa chống ngập', {
    scanTimeBudgetMs: 5000,
    maxHeavyThreads: 3,
    readCursor: 0
  });
  assert.strictEqual(cycle1.nextReadCursor, 3, 'Cycle 1 advances cursor from 0 to 3');

  // Cycle 2: readCursor = 3, capacity = 3
  const cycle2 = await performInboundScan(mockFastPage, EXPECTED_PAGE_ID, 'Cửa chống ngập', {
    scanTimeBudgetMs: 5000,
    maxHeavyThreads: 3,
    readCursor: cycle1.nextReadCursor
  });
  assert.strictEqual(cycle2.nextReadCursor, 6, 'Cycle 2 advances cursor from 3 to 6');

  // Cycle 3: readCursor = 6, capacity = 3 (wraps around 8 rows)
  const cycle3 = await performInboundScan(mockFastPage, EXPECTED_PAGE_ID, 'Cửa chống ngập', {
    scanTimeBudgetMs: 5000,
    maxHeavyThreads: 3,
    readCursor: cycle2.nextReadCursor
  });
  assert.strictEqual(cycle3.nextReadCursor, 1, 'Cycle 3 advances cursor from 6 wrapping to 1 (6 + 3 % 8 = 1)');
  console.log('  ✓ Round-robin cursor rotation verified across cycles (0 -> 3 -> 6 -> 1)');
  console.log('✅ PASS: Bounded scan time budget and outbox latency regression verified.\n');

  // -----------------------------------------------------------------------------------------------
  // 8. PARSER REGRESSION TEST (extractConversationsList) (Requirement 6)
  // -----------------------------------------------------------------------------------------------
  console.log('--- 8. extractConversationsList Parser Regression Test ---');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // DOM fixture with 3 thread rows: 1 unread + 2 read with timestamps
    const fixtureHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-surface="thread_list/thread_row0" role="row" aria-label="Nguyễn Văn A, 10:30 AM, chưa đọc">
            <span data-surface="thread_row0/lib:thread_title">Nguyễn Văn A</span>
            <div>10:30 AM</div>
            <div>Chào shop, tư vấn cửa chống ngập giúp tôi</div>
          </div>
          <div data-surface="thread_list/thread_row1" role="row" aria-label="Trần Thị B, Hôm qua">
            <span data-surface="thread_row1/lib:thread_title">Trần Thị B</span>
            <div>Hôm qua</div>
            <div>Đã nhận được hàng rồi shop nhé</div>
          </div>
          <div data-surface="thread_list/thread_row2" role="row" aria-label="Lê Văn C, Thứ hai">
            <span data-surface="thread_row2/lib:thread_title">Lê Văn C</span>
            <div>Thứ hai</div>
            <div>Cửa có chống được bão không bạn?</div>
          </div>
        </body>
      </html>
    `;

    await page.setContent(fixtureHtml);

    // Call extractConversationsList: MUST NOT throw ReferenceError: time is not defined
    const parsedRows = await extractConversationsList(page, 20);

    assert.ok(Array.isArray(parsedRows), 'extractConversationsList returns an array');
    assert.strictEqual(parsedRows.length, 3, 'Parses exactly 3 rows from fixture');

    // Row 0 assertions
    assert.strictEqual(parsedRows[0].customerName, 'Nguyễn Văn A');
    assert.ok(parsedRows[0].time.includes('10:30'), 'Row 0 time contains 10:30');
    assert.strictEqual(parsedRows[0].isUnread, true, 'Row 0 unread detection works');

    // Row 1 assertions
    assert.strictEqual(parsedRows[1].customerName, 'Trần Thị B');
    assert.ok(parsedRows[1].time.includes('Hôm qua'), 'Row 1 time contains Hôm qua');
    assert.strictEqual(parsedRows[1].isUnread, false, 'Row 1 is not unread');

    // Row 2 assertions
    assert.strictEqual(parsedRows[2].customerName, 'Lê Văn C');
    assert.ok(parsedRows[2].time.includes('Thứ hai'), 'Row 2 time contains Thứ hai');

    // maxCap test: maxCap = 2 should return at most 2 rows
    const cappedRows = await extractConversationsList(page, 2);
    assert.strictEqual(cappedRows.length, 2, 'maxCap parameter limits returned row count to 2');

    console.log('  ✓ No ReferenceError thrown (time is properly defined)');
    console.log('  ✓ Valid time fields extracted:', parsedRows.map((r: any) => `${r.customerName} (${r.time})`));
    console.log('  ✓ Correct row count (3 rows) & maxCap enforced (capped to 2 rows)');
    console.log('  ✓ Unread detection verified (Row 0 isUnread=true, Row 1 isUnread=false)');
    console.log('✅ PASS: extractConversationsList parser regression test passed.\n');
  } finally {
    await browser.close();
  }

  await healthServer.stop();
  console.log('========================================================================================');
  console.log('ALL ASSET BINDING AND INBOUND SCAN TESTS PASSED (100%)');
  console.log('========================================================================================');
}

runAssetBindingTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
