import assert from 'node:assert';
import http from 'node:http';
import { healthServer } from '../../fb-inbox-worker/src/health-server.js';
import { detectPageState, APP_STATE, extractCurrentAssetId } from '../../fb-inbox-worker/src/state-checker.js';

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
  console.log('✅ PASS: Inbound scan metrics recorded and reported.\n');

  await healthServer.stop();
  console.log('========================================================================================');
  console.log('ALL ASSET BINDING AND INBOUND SCAN TESTS PASSED (100%)');
  console.log('========================================================================================');
}

runAssetBindingTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
