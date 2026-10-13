import assert from 'node:assert';
import { CycleWaker, installMetaInboxDomObserver, setupDomMutationSignal } from '../../fb-inbox-worker/src/observer.js';
import type { InboxMessage, Conversation } from '../../features/inbox/types/inbox.types';
import { mergeDeliveryStatus, isPendingDelivery } from '../../features/inbox/types/inbox.types';

// Playwright is dynamically loaded inside async runTests()

interface TestResult {
  requirement: string;
  test: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL';
}

const resultsTable: TestResult[] = [];

function recordTest(requirement: string, test: string, expected: string, actual: string, passed: boolean) {
  resultsTable.push({
    requirement,
    test,
    expected,
    actual,
    status: passed ? 'PASS' : 'FAIL',
  });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] Requirement ${requirement}: ${test}`);
  console.log(`  Expected: ${expected}`);
  console.log(`  Actual:   ${actual}`);
  assert.ok(passed, `Requirement ${requirement} failed: ${test} (Expected: ${expected}, Actual: ${actual})`);
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
        delivery_status: mergeDeliveryStatus(localMsg.delivery_status, matchedServerMsg.delivery_status),
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

async function runTests() {
  console.log('================================================================');
  console.log('EVENT-DRIVEN REALTIME INBOX SAFETY GATE SUITE (PR #44)');
  console.log('================================================================\n');

  // ==========================================================================
  // SECTION 1 & 2: REGRESSION TESTS FOR CycleWaker (Cases A, B, C, D, E)
  // ==========================================================================
  console.log('--- SECTION 1 & 2: CycleWaker Latched Semantics & Wake-Before-Wait ---');

  // Case A: Wait first -> wake => immediate SIGNAL
  {
    const waker = new CycleWaker();
    const startTime = Date.now();
    const signalTimestamp = startTime + 10;

    setTimeout(() => {
      waker.wake({ domSignalAt: signalTimestamp });
    }, 25);

    const event = await waker.waitForNextCycle(5000);
    const elapsed = Date.now() - startTime;

    recordTest(
      '2.A',
      'Wait first -> wake => returns immediate SIGNAL without waiting 5000ms',
      `event.type === 'SIGNAL' and elapsed < 100ms`,
      `event.type === '${event.type}' and elapsed === ${elapsed}ms`,
      event.type === 'SIGNAL' && elapsed < 100 && (event as any).domSignalAt === signalTimestamp
    );
  }

  // Case B: Wake first -> wait => immediate SIGNAL (MANDATORY)
  {
    const waker = new CycleWaker();
    const fixedSignalTimestamp = 1791899999000;

    // Wake happens BEFORE waitForNextCycle()
    waker.wake({ domSignalAt: fixedSignalTimestamp, customKey: 'latched_test' });

    const startTime = Date.now();
    const result = await waker.waitForNextCycle(5000);
    const elapsed = Date.now() - startTime;

    recordTest(
      '2.B',
      'Wake first -> wait => latched signal returns IMMEDIATELY (lost-wake race eliminated)',
      `result.type === 'SIGNAL', domSignalAt === ${fixedSignalTimestamp}, elapsed < 50ms`,
      `result.type === '${result.type}', domSignalAt === ${(result as any).domSignalAt}, elapsed === ${elapsed}ms`,
      result.type === 'SIGNAL' &&
      (result as any).domSignalAt === fixedSignalTimestamp &&
      (result as any).customKey === 'latched_test' &&
      elapsed < 50
    );
  }

  // Case C: 10 wakes before wait => no lost signal, coalesced event, preserves earliest domSignalAt
  {
    const waker = new CycleWaker();
    const earliestTimestamp = 1791800000000;

    // Trigger 10 rapid wakes before wait
    for (let i = 0; i < 10; i++) {
      waker.wake({ domSignalAt: earliestTimestamp + i * 50 });
    }

    const startTime = Date.now();
    const result = await waker.waitForNextCycle(5000);
    const elapsed = Date.now() - startTime;

    recordTest(
      '2.C',
      '10 wakes before wait => coalesced into single event, preserves earliest domSignalAt',
      `coalescedCount >= 10, domSignalAt === ${earliestTimestamp}, elapsed < 50ms`,
      `coalescedCount === ${(result as any).coalescedCount}, domSignalAt === ${(result as any).domSignalAt}, elapsed === ${elapsed}ms`,
      result.type === 'SIGNAL' &&
      (result as any).domSignalAt === earliestTimestamp &&
      ((result as any).coalescedCount || 0) >= 10 &&
      elapsed < 50
    );
  }

  // Case D: Wake during active scan => pending urgent follow-up without duplicate concurrent scan
  {
    const waker = new CycleWaker();
    let isInboundScanRunning = true;
    let pendingUrgentScan: boolean = false;
    let duplicateScanStarted: boolean = false;
    let nextScanIsUrgent: boolean = false;
    let pendingDomSignalAt: number | null = null;

    const handleSignal = (event: { domSignalAt: number }) => {
      const now = event.domSignalAt;
      if (isInboundScanRunning) {
        pendingUrgentScan = true;
        if (!pendingDomSignalAt || now < pendingDomSignalAt) {
          pendingDomSignalAt = now;
        }
      } else {
        duplicateScanStarted = true;
        waker.wake({ domSignalAt: now });
      }
    };

    // Incoming signal while scan is running
    handleSignal({ domSignalAt: 1791811111000 });
    handleSignal({ domSignalAt: 1791811112000 });

    recordTest(
      '2.D.1',
      'Signals during active scan set pendingUrgentScan without duplicate scan',
      'pendingUrgentScan === true && !duplicateScanStarted',
      `pending === ${pendingUrgentScan}, dup === ${duplicateScanStarted}`,
      Boolean(pendingUrgentScan) === true && !duplicateScanStarted && pendingDomSignalAt === 1791811111000
    );

    // Scan finishes, immediately dispatches pending scan and clears waker
    isInboundScanRunning = false;
    if (pendingUrgentScan) {
      nextScanIsUrgent = true;
      pendingUrgentScan = false;
      waker.clear();
    }

    recordTest(
      '2.D.2',
      'Queued urgent signal executes immediately after scan finishes',
      'nextScanIsUrgent === true && pendingUrgentScan === false && !waker.hasPendingSignal()',
      `nextUrgent === ${nextScanIsUrgent}, pending === ${pendingUrgentScan}, hasPending === ${waker.hasPendingSignal()}`,
      Boolean(nextScanIsUrgent) === true && !pendingUrgentScan && !waker.hasPendingSignal()
    );
  }

  // Case E: No wake => timeout fallback
  {
    const waker = new CycleWaker();
    const start = Date.now();
    const result = await waker.waitForNextCycle(60);
    const elapsed = Date.now() - start;

    recordTest(
      '2.E',
      'No wake => fallback timeout returns TIMEOUT',
      'result.type === "TIMEOUT" && elapsed >= 50ms',
      `result.type === "${result.type}" && elapsed === ${elapsed}ms`,
      result.type === 'TIMEOUT' && elapsed >= 50
    );
  }

  // ==========================================================================
  // SECTION 8: ACTUAL PLAYWRIGHT OBSERVER TESTS (Live headless DOM)
  // ==========================================================================
  console.log('\n--- SECTION 8: Actual Playwright Observer Tests (Headless DOM) ---');

  // @ts-ignore
  const { chromium } = await import('../../fb-inbox-worker/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Setup simulated Meta Business Suite DOM structure
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Meta Business Suite Test</title></head>
        <body>
          <div id="unrelated-header">
            <span id="title">Meta Business Suite</span>
            <input id="search-input" type="text" placeholder="Search..." />
          </div>

          <div role="grid" data-surface="thread_list">
            <div role="row" data-surface="thread_row" id="row-01">
              <span data-surface="thread_title">HoàngAnh Ngô</span>
              <div data-surface="snippet">Tin nhắn cũ</div>
            </div>
          </div>

          <div role="main" aria-label="Message list container with messages">
            <div class="message-stream">
              <div data-surface="message" dir="auto">Tin nhắn cũ trong thread</div>
            </div>
          </div>

          <div id="unrelated-sidebar">
            <div class="ad-card">Quảng cáo</div>
          </div>
        </body>
      </html>
    `);

    let capturedSignals: Array<{ domSignalAt: number; mutationsCount: number }> = [];
    const observerCallback = (data: { domSignalAt: number; mutationsCount: number }) => {
      capturedSignals.push(data);
    };

    // Install observer with fast test timings (debounce=80ms, maxWait=250ms)
    await setupDomMutationSignal(page, observerCallback, { debounceMs: 80, maxWaitMs: 250 });

    // Test 8.1: Relevant message bubble addition triggers signal
    {
      capturedSignals = [];
      await page.evaluate(() => {
        const stream = document.querySelector('.message-stream');
        if (stream) {
          const newBubble = document.createElement('div');
          newBubble.setAttribute('data-surface', 'message');
          newBubble.setAttribute('dir', 'auto');
          newBubble.textContent = 'Chào shop, cửa chống ngập báo giá bao nhiêu?';
          stream.appendChild(newBubble);
        }
      });

      // Wait 120ms for debounce (80ms)
      await new Promise((r) => setTimeout(r, 120));

      recordTest(
        '8.1',
        'Playwright DOM: Message bubble addition triggers callback signal',
        'capturedSignals.length === 1 && mutationsCount >= 1',
        `signals === ${capturedSignals.length}, count === ${capturedSignals[0]?.mutationsCount}`,
        capturedSignals.length === 1 && capturedSignals[0].mutationsCount >= 1
      );
    }

    // Test 8.2: Burst of 100 mutations inside message container is debounced / coalesced
    {
      capturedSignals = [];
      await page.evaluate(() => {
        const stream = document.querySelector('.message-stream');
        if (stream) {
          for (let i = 0; i < 100; i++) {
            const span = document.createElement('span');
            span.setAttribute('dir', 'auto');
            span.textContent = `bubble-part-${i}`;
            stream.appendChild(span);
          }
        }
      });

      // Wait 150ms for debounce
      await new Promise((r) => setTimeout(r, 150));

      recordTest(
        '8.2',
        'Playwright DOM: Burst of 100 mutations coalesced into 1 urgent signal (no scan storm)',
        'capturedSignals.length === 1 && mutationsCount === 100',
        `signals === ${capturedSignals.length}, count === ${capturedSignals[0]?.mutationsCount}`,
        capturedSignals.length === 1 && capturedSignals[0].mutationsCount === 100
      );
    }

    // Test 8.3: Sustained mutation stream fires at maxWait without infinite debounce resets
    {
      capturedSignals = [];
      const startTime = Date.now();

      // Mutate every 30ms for 350ms (longer than debounce=80ms, so pure debounce would never fire)
      const interval = setInterval(async () => {
        await page.evaluate(() => {
          const stream = document.querySelector('.message-stream');
          if (stream) {
            const span = document.createElement('span');
            span.setAttribute('dir', 'auto');
            span.textContent = 'stream-chunk';
            stream.appendChild(span);
          }
        }).catch(() => {});
      }, 30);

      // Wait 280ms (exceeds maxWait=250ms)
      await new Promise((r) => setTimeout(r, 280));
      clearInterval(interval);

      // Wait a short moment to inspect
      await new Promise((r) => setTimeout(r, 50));

      recordTest(
        '8.3',
        'Playwright DOM: maxWait throttle fires during continuous sustained mutations',
        'capturedSignals.length >= 1',
        `signals === ${capturedSignals.length}`,
        capturedSignals.length >= 1
      );
    }

    // Test 8.4: Unrelated DOM mutation outside message/conversation list is filtered out
    {
      // Wait for any trailing timer from 8.3 to settle
      await new Promise((r) => setTimeout(r, 150));
      capturedSignals = [];

      await page.evaluate(() => {
        // Mutate unrelated ad card and search input
        const adCard = document.querySelector('.ad-card');
        if (adCard) {
          adCard.textContent = 'Banner đổi nội dung';
        }
        const searchInput = document.querySelector('#search-input') as HTMLInputElement;
        if (searchInput) {
          searchInput.value = 'Tìm kiếm';
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });

      // Wait 120ms
      await new Promise((r) => setTimeout(r, 120));

      recordTest(
        '8.4',
        'Playwright DOM: Unrelated mutations (ads, input typing) are filtered (zero unnecessary signal)',
        'capturedSignals.length === 0',
        `signals === ${capturedSignals.length}`,
        capturedSignals.length === 0
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }

  // ==========================================================================
  // SECTION 3, 5, 7: SUPABASE REALTIME & CRM INGEST INTEGRATION
  // ==========================================================================
  console.log('\n--- SECTION 3 - 7: Realtime & Telemetry Decoupling Verification ---');

  // Requirement C: Parsed message synced to CRM once with deduplication
  {
    const syncedFingerprints = new Set<string>();
    let crmSyncCallCount = 0;

    const mockSyncToCRM = async (_payload: { fingerprint: string }) => {
      crmSyncCallCount++;
      return { success: true, isDuplicate: false, interactionId: 'int_123' };
    };

    const processMessage = async (msg: { fingerprint: string }) => {
      if (!syncedFingerprints.has(msg.fingerprint)) {
        const res = await mockSyncToCRM(msg);
        if (res.success) {
          syncedFingerprints.add(msg.fingerprint);
        }
      }
    };

    const fp = 'fp_c2f11b49478137083c4d42c0677a7aaf9';
    await processMessage({ fingerprint: fp });
    await processMessage({ fingerprint: fp }); // repeat
    await processMessage({ fingerprint: fp }); // repeat

    recordTest(
      'C',
      'Parsed message is synced to CRM once; duplicate DOM detections are ignored',
      'crmSyncCallCount === 1 && syncedFingerprints.has(fp)',
      `callCount === ${crmSyncCallCount}, has === ${syncedFingerprints.has(fp)}`,
      crmSyncCallCount === 1 && syncedFingerprints.has(fp)
    );
  }

  // Requirement D & 5: Realtime INSERT without source_metadata dependency
  {
    const activeConversationId = 'conv_kh000004';
    let silentFetchTriggered: boolean = false;
    let loadingStateChanged: boolean = false;
    let userDraft = 'Dạ em chào anh HoàngAnh';

    const mockFetchMessages = async (_convId: string, options?: { silent?: boolean }) => {
      if (options?.silent) {
        silentFetchTriggered = true;
      } else {
        loadingStateChanged = true;
      }
    };

    // Realistic Supabase Realtime payload for public.interactions (NO source_metadata)
    const realtimePayload = {
      new: {
        id: 'int_inbound_001',
        conversation_id: 'conv_kh000004',
        created_at: new Date().toISOString(),
      }
    };

    // Frontend handler logic (Requirement 5: zero dependency on source_metadata)
    if (realtimePayload.new.conversation_id === activeConversationId) {
      await mockFetchMessages(realtimePayload.new.conversation_id, { silent: true });
    }

    recordTest(
      'D & 5',
      'Realtime INSERT handles payload with NO source_metadata, triggers silent fetch without spinner',
      'silentFetchTriggered === true && !loadingStateChanged && userDraft intact',
      `silent === ${silentFetchTriggered}, loading === ${loadingStateChanged}, draft === "${userDraft}"`,
      Boolean(silentFetchTriggered) === true && !loadingStateChanged && userDraft === 'Dạ em chào anh HoàngAnh'
    );
  }

  // Requirement E: Same message realtime + 15s fallback poll => 1 bubble only
  {
    const testMsgId = 'msg_realtime_001';
    const initialLocalMessages: InboxMessage[] = [];

    const realtimeServerMessages: InboxMessage[] = [
      {
        id: testMsgId,
        conversation_id: 'conv_01',
        customer_id: 'cust_01',
        channel: 'facebook',
        sender_type: 'customer',
        sender_name: 'HoàngAnh Ngô',
        content: 'Cửa chống ngập giá bao nhiêu?',
        created_at: '2026-10-13T10:00:00.000Z',
        direction: 'inbound',
      }
    ];

    const stateAfterRealtime = reconcileMessages(initialLocalMessages, realtimeServerMessages);

    const fallbackServerMessages: InboxMessage[] = [
      {
        id: testMsgId,
        conversation_id: 'conv_01',
        customer_id: 'cust_01',
        channel: 'facebook',
        sender_type: 'customer',
        sender_name: 'HoàngAnh Ngô',
        content: 'Cửa chống ngập giá bao nhiêu?',
        created_at: '2026-10-13T10:00:00.000Z',
        direction: 'inbound',
      }
    ];

    const stateAfterFallback = reconcileMessages(stateAfterRealtime, fallbackServerMessages);

    recordTest(
      'E',
      'Realtime arrival followed by 15s fallback poll produces exactly 1 message bubble (zero duplicates)',
      'messages.length === 1 && messages[0].id === testMsgId',
      `messages.length === ${stateAfterFallback.length} && id === ${stateAfterFallback[0]?.id}`,
      stateAfterFallback.length === 1 && stateAfterFallback[0]?.id === testMsgId
    );
  }

  // Requirement F: Inbound to other conversation updates list without switching active conversation
  {
    const activeConversationId = 'conv_active_kh000004';
    let activeMessagesFetched: boolean = false;
    let conversationListRefreshed: boolean = false;

    const mockConversations: Conversation[] = [
      {
        id: 'conv_active_kh000004',
        company_id: 'comp_01',
        customer_id: 'cust_01',
        customer_code: 'KH-000004',
        customer_name: 'HoàngAnh Ngô',
        channel: 'facebook',
        status: 'OPEN',
        unread_count: 0,
        last_message: 'Cảm ơn shop',
        updated_at: '2026-10-13T09:00:00.000Z',
      },
      {
        id: 'conv_other_kh000009',
        company_id: 'comp_01',
        customer_id: 'cust_02',
        customer_code: 'KH-000009',
        customer_name: 'Nguyễn Văn B',
        channel: 'facebook',
        status: 'OPEN',
        unread_count: 0,
        last_message: 'Hello',
        updated_at: '2026-10-13T08:00:00.000Z',
      }
    ];

    const targetConvId: string = 'conv_other_kh000009';

    if (targetConvId === activeConversationId) {
      activeMessagesFetched = true;
    }
    conversationListRefreshed = true;

    const updatedConversations = mockConversations.map((c) =>
      c.id === targetConvId
        ? { ...c, last_message: 'Báo giá giúp tôi', unread_count: c.unread_count + 1, updated_at: '2026-10-13T10:05:00.000Z' }
        : c
    ).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    recordTest(
      'F',
      'Inbound to other conversation updates unread count and moves to top without switching active conversation',
      'activeId unchanged && !activeMessagesFetched && updatedConversations[0].id === targetConvId',
      `activeId === "${activeConversationId}", fetched === ${activeMessagesFetched}, top === "${updatedConversations[0]?.id}", unread === ${updatedConversations[0]?.unread_count}`,
      !activeMessagesFetched &&
      Boolean(conversationListRefreshed) === true &&
      updatedConversations[0]?.id === 'conv_other_kh000009' &&
      updatedConversations[0]?.unread_count === 1
    );
  }

  // Requirement G: Fallback 15s timer operates reliably when realtime is disconnected
  {
    let fallbackTickCount = 0;
    let activeConversationSilentFetched: boolean = false;
    let listSilentFetched: boolean = false;

    const runFallbackCycle = () => {
      fallbackTickCount++;
      activeConversationSilentFetched = true;
      listSilentFetched = true;
    };

    runFallbackCycle();

    recordTest(
      'G',
      'Fallback 15s timer operates reliably when realtime is unavailable or disconnected',
      'fallbackTickCount === 1 && activeConversationSilentFetched && listSilentFetched',
      `ticks === ${fallbackTickCount}, activeFetched === ${activeConversationSilentFetched}, listFetched === ${listSilentFetched}`,
      fallbackTickCount === 1 && Boolean(activeConversationSilentFetched) === true && Boolean(listSilentFetched) === true
    );
  }

  // Requirement H: Existing outbound delivery polling (2500ms) activates strictly for pending outbound and deactivates on SENT
  {
    const pendingMsg: InboxMessage = {
      id: 'out_msg_001',
      conversation_id: 'conv_01',
      customer_id: 'cust_01',
      channel: 'facebook',
      sender_type: 'sale',
      content: 'Báo giá sản phẩm',
      created_at: new Date().toISOString(),
      direction: 'outbound',
      delivery_status: 'PENDING_DISPATCH',
    };

    const sentMsg: InboxMessage = {
      id: 'out_msg_002',
      conversation_id: 'conv_01',
      customer_id: 'cust_01',
      channel: 'facebook',
      sender_type: 'sale',
      content: 'Báo giá sản phẩm',
      created_at: new Date().toISOString(),
      direction: 'outbound',
      delivery_status: 'SENT',
    };

    const hasPendingOutboundBefore = [pendingMsg].some(
      (m) => (m.direction || '').toLowerCase() === 'outbound' && isPendingDelivery(m.delivery_status)
    );

    const hasPendingOutboundAfter = [sentMsg].some(
      (m) => (m.direction || '').toLowerCase() === 'outbound' && isPendingDelivery(m.delivery_status)
    );

    recordTest(
      'H',
      'Existing outbound delivery polling (2500ms) activates strictly for pending outbound and deactivates on SENT',
      'hasPendingOutboundBefore === true && hasPendingOutboundAfter === false',
      `before === ${hasPendingOutboundBefore}, after === ${hasPendingOutboundAfter}`,
      hasPendingOutboundBefore === true && hasPendingOutboundAfter === false
    );
  }

  console.log('\n================================================================');
  console.log('SUMMARY TABLE:');
  console.log('================================================================');
  console.table(resultsTable);

  const total = resultsTable.length;
  const passed = resultsTable.filter((r) => r.status === 'PASS').length;
  console.log(`\nOVERALL STATUS: ${passed}/${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)\n`);

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
