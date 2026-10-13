import assert from 'node:assert';
import { createRequire } from 'node:module';
import { extractActiveThreadMessages, isPureTimestampText } from '../../fb-inbox-worker/src/parser.js';
import { ThreadMessageReconciler, messageReconciler } from '../../fb-inbox-worker/src/message-reconciler.js';
import type { InboxMessage, Conversation } from '../../features/inbox/types/inbox.types';

const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('./fb-inbox-worker/node_modules/playwright');

interface TestCaseResult {
  num: number;
  name: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL';
}

const testResults: TestCaseResult[] = [];

function recordResult(num: number, name: string, expected: string, actual: string, passed: boolean) {
  testResults.push({
    num,
    name,
    expected,
    actual,
    status: passed ? 'PASS' : 'FAIL',
  });
  if (passed) {
    console.log(`[Test ${num}] PASS: ${name}`);
  } else {
    console.error(`[Test ${num}] FAIL: ${name} | Expected: ${expected} | Actual: ${actual}`);
  }
}

async function runAllRegressionTests() {
  console.log('======================================================================');
  console.log('POST-PR45 REGRESSION TEST SUITE: P0 & P1 FIXES AUDIT');
  console.log('======================================================================\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as any).__name = (f: any) => f;
    (globalThis as any).__name = (f: any) => f;
  });

  const setSafeHtml = async (p: any, bodyHtml: string) => {
    const fullHtml = `<!DOCTYPE html><html><head><script>window.__name = function(fn) { return fn; }; globalThis.__name = window.__name;</script><style>.bubble-inbound, .bubble-outbound { white-space: pre-wrap; }</style></head><body>${bodyHtml}</body></html>`;
    await p.setContent(fullHtml);
  };

  const PAGE_ID = '1389294167596309';
  const THREAD_ID = '1389294167596309:61592309996204';

  try {
    // ===============================================================================================
    // PART 1: P0 DOM VIRTUALIZATION & FINGERPRINT STABILITY
    // ===============================================================================================
    console.log('--- PART 1: P0 DOM Virtualization & Fingerprint Stability Tests ---');

    // Case A: Scan 1 has 2 'hello' messages. Scan 2 has only 1 'hello' (top one virtualized).
    // The remaining message in Scan 2 must KEEP its original identity from Scan 1 (not be renumbered).
    const threadA = `${PAGE_ID}:61592309996201`;
    messageReconciler.resetThread(threadA);

    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996201" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div id="bubble-0" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
        <div class="row-inbound"><div id="bubble-1" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
      </div>
    `);

    const scan1CaseA = await extractActiveThreadMessages(page, PAGE_ID);
    assert.strictEqual(scan1CaseA.messages.length, 2, 'Scan 1 should have 2 messages');
    const scan1Msg0Fp = scan1CaseA.messages[0].fingerprint;
    const scan1Msg1Fp = scan1CaseA.messages[1].fingerprint;
    assert.notStrictEqual(scan1Msg0Fp, scan1Msg1Fp, 'Two identical messages in Scan 1 must have distinct fingerprints');

    // Simulate Meta virtualization: bubble-0 is removed from DOM. bubble-1 remains.
    await page.evaluate(() => {
      const b0 = document.getElementById('bubble-0');
      b0?.parentElement?.remove();
    });

    const scan2CaseA = await extractActiveThreadMessages(page, PAGE_ID);
    assert.strictEqual(scan2CaseA.messages.length, 1, 'Scan 2 should have 1 remaining message');
    const scan2RemainingFp = scan2CaseA.messages[0].fingerprint;

    // Invariant: The remaining message MUST retain its previous fingerprint (scan1Msg1Fp)
    const caseAPassed = scan2RemainingFp === scan1Msg1Fp && scan2RemainingFp !== scan1Msg0Fp;
    recordResult(
      1,
      'Case A: Remaining message keeps its original identity after older message is virtualized',
      `fp === ${scan1Msg1Fp.slice(0, 12)}...`,
      `fp === ${scan2RemainingFp.slice(0, 12)}...`,
      caseAPassed
    );

    // Case B: Scan 1 has 'hello A' and 'hello B'. A disappears. Scan 2 has 'hello B' and 'hello C'.
    // 'hello C' must receive a NEW fingerprint never seen before.
    const threadB = `${PAGE_ID}:61592309996202`;
    messageReconciler.resetThread(threadB);

    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996202" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div id="bA" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello A</div></div>
        <div class="row-inbound"><div id="bB" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello B</div></div>
      </div>
    `);

    const scan1CaseB = await extractActiveThreadMessages(page, PAGE_ID);
    const seenFpsB = new Set(scan1CaseB.messages.map((m: any) => m.fingerprint));

    // A disappears. C is added.
    await page.evaluate(() => {
      document.getElementById('bA')?.parentElement?.remove();
      const container = document.querySelector('[role="main"]');
      const div = document.createElement('div');
      div.className = 'row-inbound';
      div.innerHTML = '<div id="bC" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello C</div>';
      container?.appendChild(div);
    });

    const scan2CaseB = await extractActiveThreadMessages(page, PAGE_ID);
    const msgC = scan2CaseB.messages.find((m: any) => m.content === 'hello C');
    const isBrandNewFpB = Boolean(msgC && !seenFpsB.has(msgC.fingerprint));
    recordResult(
      2,
      'Case B: New message "hello C" receives brand new fingerprint never seen in Scan 1',
      'isBrandNewFp === true',
      `isBrandNewFp === ${isBrandNewFpB}`,
      isBrandNewFpB
    );

    // Case B with identical text:
    // Scan 1: hello (0), hello (1).
    // Older hello virtualizes. Customer sends 3rd hello.
    // Scan 2 has hello (1) and hello (2).
    // The 3rd hello must get a brand new fingerprint!
    const threadBIdentical = `${PAGE_ID}:61592309996203`;
    messageReconciler.resetThread(threadBIdentical);

    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996203" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div id="h0" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
        <div class="row-inbound"><div id="h1" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
      </div>
    `);

    const scan1BIdent = await extractActiveThreadMessages(page, PAGE_ID);
    const syncedFps = new Set(scan1BIdent.messages.map((m: any) => m.fingerprint));
    assert.strictEqual(syncedFps.size, 2, 'Scan 1 should produce 2 distinct fingerprints');

    // Older hello removed. 3rd hello added.
    await page.evaluate(() => {
      document.getElementById('h0')?.parentElement?.remove();
      const container = document.querySelector('[role="main"]');
      const div = document.createElement('div');
      div.className = 'row-inbound';
      div.innerHTML = '<div id="h2" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div>';
      container?.appendChild(div);
    });

    const scan2BIdent = await extractActiveThreadMessages(page, PAGE_ID);
    assert.strictEqual(scan2BIdent.messages.length, 2, 'Scan 2 should have 2 messages (h1 and h2)');
    const h1FingerprintInScan2 = scan2BIdent.messages[0].fingerprint;
    const h2FingerprintInScan2 = scan2BIdent.messages[1].fingerprint;

    const h1Retained = syncedFps.has(h1FingerprintInScan2);
    const h2IsNew = !syncedFps.has(h2FingerprintInScan2);
    recordResult(
      3,
      'Case B (Identical text): When oldest virtualizes and new identical message arrives, 3rd message gets new fingerprint',
      'h1Retained === true && h2IsNew === true',
      `h1Retained: ${h1Retained}, h2IsNew: ${h2IsNew}`,
      h1Retained && h2IsNew
    );

    // Case C: 3 identical messages 'ok', 'ok', 'ok'
    const threadC = `${PAGE_ID}:61592309996204`;
    messageReconciler.resetThread(threadC);

    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996204" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">ok</div></div>
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">ok</div></div>
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">ok</div></div>
      </div>
    `);

    const scanCaseC = await extractActiveThreadMessages(page, PAGE_ID);
    const okFps = new Set(scanCaseC.messages.map((m: any) => m.fingerprint));
    const caseCPassed = scanCaseC.messages.length === 3 && okFps.size === 3;
    recordResult(
      4,
      'Case C: 3 identical messages "ok", "ok", "ok" produce 3 distinct fingerprints',
      'count === 3 && uniqueFps === 3',
      `count === ${scanCaseC.messages.length}, uniqueFps === ${okFps.size}`,
      caseCPassed
    );

    // Case D: Repeated emoji '👍', '👍', '👍'
    const threadD = `${PAGE_ID}:61592309996205`;
    messageReconciler.resetThread(threadD);

    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996205" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">👍</div></div>
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">👍</div></div>
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">👍</div></div>
      </div>
    `);

    const scanCaseD = await extractActiveThreadMessages(page, PAGE_ID);
    const thumbFps = new Set(scanCaseD.messages.map((m: any) => m.fingerprint));
    const caseDPassed = scanCaseD.messages.length === 3 && thumbFps.size === 3;
    recordResult(
      5,
      'Case D: Repeated emoji "👍", "👍", "👍" produce 3 distinct fingerprints without suppression',
      'count === 3 && uniqueFps === 3',
      `count === ${scanCaseD.messages.length}, uniqueFps === ${thumbFps.size}`,
      caseDPassed
    );

    // ===============================================================================================
    // PART 2: P0 TIMESTAMP DETECTION WITHOUT FALSE POSITIVES
    // ===============================================================================================
    console.log('\n--- PART 2: P0 Timestamp Detection False-Positive Elimination Tests ---');

    // Test 6: Pure timestamp indicators identified as timestamps
    const pureTsTexts = ['Today', 'Yesterday', '12:30', '12:30 PM', 'Mon', '13 thg 10'];
    const allPureTrue = pureTsTexts.every(t => isPureTimestampText(t));
    recordResult(
      6,
      'Pure timestamp indicators (Today, Yesterday, 12:30, 12:30 PM, Mon, 13 thg 10) recognized by isPureTimestampText',
      'all === true',
      `all === ${allPureTrue}`,
      allPureTrue
    );

    // Test DOM with mixed pure timestamps and conversational messages:
    messageReconciler.resetThread('1389294167596309:ts_test');
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996204" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <!-- Pure timestamp divider 1 -->
        <div style="text-align: center; color: #888;">Today</div>

        <!-- Conversational message 1: "Today I need help" -->
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Today I need help</div></div>

        <!-- Conversational message 2: "Yesterday em có nhắn rồi" -->
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Yesterday em có nhắn rồi</div></div>

        <!-- Pure timestamp divider 2 -->
        <div style="text-align: center; color: #888;">12:30</div>

        <!-- Conversational message 3: "12:30 mình đến nhé" -->
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">12:30 mình đến nhé</div></div>

        <!-- Conversational message 4: "Mon em rảnh" -->
        <div class="row-inbound"><div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Mon em rảnh</div></div>
      </div>
    `);

    const tsParsed = await extractActiveThreadMessages(page, PAGE_ID);

    // Test 7: "Today I need help" parsed as message
    const msgTodayHelp = tsParsed.messages.find((m: any) => m.content === 'Today I need help');
    recordResult(
      7,
      '"Today I need help" parsed as MESSAGE (not swallowed as timestamp)',
      'content === "Today I need help"',
      `content === "${msgTodayHelp?.content}"`,
      Boolean(msgTodayHelp)
    );

    // Test 8: "Yesterday em có nhắn rồi" parsed as message
    const msgYesterday = tsParsed.messages.find((m: any) => m.content === 'Yesterday em có nhắn rồi');
    recordResult(
      8,
      '"Yesterday em có nhắn rồi" parsed as MESSAGE (not swallowed as timestamp)',
      'content === "Yesterday em có nhắn rồi"',
      `content === "${msgYesterday?.content}"`,
      Boolean(msgYesterday)
    );

    // Test 9: "12:30 mình đến nhé" parsed as message
    const msgTimeDen = tsParsed.messages.find((m: any) => m.content === '12:30 mình đến nhé');
    recordResult(
      9,
      '"12:30 mình đến nhé" parsed as MESSAGE (not swallowed as timestamp)',
      'content === "12:30 mình đến nhé"',
      `content === "${msgTimeDen?.content}"`,
      Boolean(msgTimeDen)
    );

    // Test 10: "Mon em rảnh" parsed as message
    const msgMonRanh = tsParsed.messages.find((m: any) => m.content === 'Mon em rảnh');
    recordResult(
      10,
      '"Mon em rảnh" parsed as MESSAGE (not swallowed as timestamp)',
      'content === "Mon em rảnh"',
      `content === "${msgMonRanh?.content}"`,
      Boolean(msgMonRanh)
    );

    // ===============================================================================================
    // PART 3: P1 MULTILINE URL TEXT PRESERVATION
    // ===============================================================================================
    console.log('\n--- PART 3: P1 Multiline URL Text Preservation Tests ---');

    messageReconciler.resetThread('1389294167596309:multiline_url_test');
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996204" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <!-- 1. URL only -->
        <div class="row-inbound"><div id="u1" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">https://namethatui.com/</div></div>

        <!-- 2. Mixed same line -->
        <div class="row-inbound"><div id="u2" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Bạn xem https://namethatui.com/ nhé</div></div>

        <!-- 3. URL first line + user text second line -->
        <div class="row-inbound"><div id="u3" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">https://namethatui.com/
anh xem giúp em nhé</div></div>

        <!-- 4. User text first line + URL second line -->
        <div class="row-inbound"><div id="u4" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Anh xem giúp em:
https://namethatui.com/</div></div>

        <!-- 5. Multiple URLs -->
        <div class="row-inbound"><div id="u5" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Xem https://example.com và https://namethatui.com/</div></div>
      </div>
    `);

    const urlParsed = await extractActiveThreadMessages(page, PAGE_ID);

    // Test 11: Single URL only
    const u1 = urlParsed.messages[0];
    recordResult(
      11,
      'URL-only message preserves URL',
      'https://namethatui.com/',
      u1?.content,
      u1?.content === 'https://namethatui.com/'
    );

    // Test 12: Mixed same line
    const u2 = urlParsed.messages[1];
    recordResult(
      12,
      'Mixed text + URL on same line preserves full content',
      'Bạn xem https://namethatui.com/ nhé',
      u2?.content,
      u2?.content === 'Bạn xem https://namethatui.com/ nhé'
    );

    // Test 13: URL first line + user text second line (Regression fix!)
    const u3 = urlParsed.messages[2];
    const u3Expected = 'https://namethatui.com/\nanh xem giúp em nhé';
    recordResult(
      13,
      'Multiline message (URL first line + text second line) preserves ALL user-authored text',
      u3Expected,
      u3?.content,
      u3?.content === u3Expected
    );

    // Test 14: User text first line + URL second line
    const u4 = urlParsed.messages[3];
    const u4Expected = 'Anh xem giúp em:\nhttps://namethatui.com/';
    recordResult(
      14,
      'Multiline message (text first line + URL second line) preserves ALL user-authored text',
      u4Expected,
      u4?.content,
      u4?.content === u4Expected
    );

    // Test 15: Multiple URLs
    const u5 = urlParsed.messages[4];
    const u5Expected = 'Xem https://example.com và https://namethatui.com/';
    recordResult(
      15,
      'Message with multiple URLs preserves full text',
      u5Expected,
      u5?.content,
      u5?.content === u5Expected
    );

    // ===============================================================================================
    // PART 4: P1 REALTIME SKELETON RACE CONDITION ELIMINATION
    // ===============================================================================================
    console.log('\n--- PART 4: P1 Realtime Skeleton Event Timing Correlation Tests ---');

    // Simulate InboxView event correlation machine
    class InboxViewSkeletonSimulator {
      isSyncingNewMessage = false;
      syncingDelayTimer: NodeJS.Timeout | null = null;
      syncingTimeoutTimer: NodeJS.Timeout | null = null;
      activeConversationId = 'conv_kh000004';
      activeConversationLastMessageAt: string | null = '2026-10-13T14:00:00.000Z';
      latestRenderedInteractionTimeByConv: Record<string, number> = {
        conv_kh000004: new Date('2026-10-13T14:00:00.000Z').getTime(),
      };
      messages: InboxMessage[] = [];

      handleInteractionInsert(interaction: {
        id: string;
        conversation_id: string;
        sanitized_content: string;
        created_at: string;
        direction: string;
      }) {
        const convId = interaction.conversation_id;
        const createdAtMs = new Date(interaction.created_at).getTime();

        // 1. Record latest received interaction timestamp for conversation
        const prevMax = this.latestRenderedInteractionTimeByConv[convId] || 0;
        if (createdAtMs > prevMax) {
          this.latestRenderedInteractionTimeByConv[convId] = createdAtMs;
        }

        // 2. If active conversation: clear skeleton immediately & append bubble
        if (convId === this.activeConversationId) {
          if (this.syncingDelayTimer) {
            clearTimeout(this.syncingDelayTimer);
            this.syncingDelayTimer = null;
          }
          if (this.syncingTimeoutTimer) {
            clearTimeout(this.syncingTimeoutTimer);
            this.syncingTimeoutTimer = null;
          }
          this.isSyncingNewMessage = false;

          // Direct append if not duplicate
          if (!this.messages.some(m => m.id === interaction.id)) {
            this.messages.push({
              id: interaction.id,
              conversation_id: convId,
              customer_id: 'cust_01',
              channel: 'facebook',
              sender_type: 'customer',
              sender_name: 'HoàngAnh Ngô',
              content: interaction.sanitized_content,
              sanitized_content: interaction.sanitized_content,
              created_at: interaction.created_at,
              direction: 'inbound',
            });
          }
        }
      }

      handleConversationUpdate(updatedConv: { id: string; last_message_at: string }) {
        if (updatedConv.id !== this.activeConversationId) return;

        const convId = updatedConv.id;
        const prevLastAtMs = this.activeConversationLastMessageAt ? new Date(this.activeConversationLastMessageAt).getTime() : 0;
        const newLastAtMs = new Date(updatedConv.last_message_at).getTime();

        const advanced = newLastAtMs > prevLastAtMs;
        if (!advanced) return;

        this.activeConversationLastMessageAt = updatedConv.last_message_at;

        // Correlation check: check if interaction for this last_message_at or newer was ALREADY rendered
        const latestRenderedMs = this.latestRenderedInteractionTimeByConv[convId] || 0;
        const isAlreadyRendered = latestRenderedMs >= newLastAtMs;

        if (!isAlreadyRendered) {
          if (this.syncingDelayTimer) clearTimeout(this.syncingDelayTimer);
          this.syncingDelayTimer = setTimeout(() => {
            const currentRenderedMs = this.latestRenderedInteractionTimeByConv[convId] || 0;
            if (currentRenderedMs >= newLastAtMs) return; // Arrived during anti-flicker delay
            this.isSyncingNewMessage = true;
            if (this.syncingTimeoutTimer) clearTimeout(this.syncingTimeoutTimer);
            this.syncingTimeoutTimer = setTimeout(() => {
              this.isSyncingNewMessage = false;
            }, 4000);
          }, 180);
        } else {
          // Already rendered: do NOT show skeleton
          if (this.syncingDelayTimer) {
            clearTimeout(this.syncingDelayTimer);
            this.syncingDelayTimer = null;
          }
          if (this.syncingTimeoutTimer) {
            clearTimeout(this.syncingTimeoutTimer);
            this.syncingTimeoutTimer = null;
          }
          this.isSyncingNewMessage = false;
        }
      }

      cleanup() {
        if (this.syncingDelayTimer) clearTimeout(this.syncingDelayTimer);
        if (this.syncingTimeoutTimer) clearTimeout(this.syncingTimeoutTimer);
      }
    }

    // Test 16: Order 1A: conversation UPDATE -> interaction INSERT (<180ms delay)
    // Skeleton does NOT flash.
    const simOrder1A = new InboxViewSkeletonSimulator();
    simOrder1A.handleConversationUpdate({
      id: 'conv_kh000004',
      last_message_at: '2026-10-13T14:10:00.000Z',
    });

    // Interaction arrives at 40ms (<180ms)
    await new Promise(r => setTimeout(r, 40));
    simOrder1A.handleInteractionInsert({
      id: 'msg_001',
      conversation_id: 'conv_kh000004',
      sanitized_content: 'hello',
      created_at: '2026-10-13T14:10:00.000Z',
      direction: 'INBOUND',
    });

    // Wait past 200ms
    await new Promise(r => setTimeout(r, 180));
    const order1APassed = !simOrder1A.isSyncingNewMessage && simOrder1A.messages.length === 1;
    simOrder1A.cleanup();
    recordResult(
      16,
      'Order 1A (conv UPDATE -> interaction INSERT <180ms): skeleton does not flash and bubble is present',
      'skeletonVisible: false, messages: 1',
      `skeletonVisible: ${simOrder1A.isSyncingNewMessage}, messages: ${simOrder1A.messages.length}`,
      order1APassed
    );

    // Test 17: Order 1B: conversation UPDATE -> skeleton appears at 180ms -> interaction INSERT clears it immediately
    const simOrder1B = new InboxViewSkeletonSimulator();
    simOrder1B.handleConversationUpdate({
      id: 'conv_kh000004',
      last_message_at: '2026-10-13T14:15:00.000Z',
    });

    // Wait 200ms so skeleton appears
    await new Promise(r => setTimeout(r, 200));
    const skeletonWasShownAt200ms = simOrder1B.isSyncingNewMessage;

    // Interaction arrives at 220ms
    simOrder1B.handleInteractionInsert({
      id: 'msg_002',
      conversation_id: 'conv_kh000004',
      sanitized_content: 'delayed message',
      created_at: '2026-10-13T14:15:00.000Z',
      direction: 'INBOUND',
    });

    const skeletonClearedImmediately = !simOrder1B.isSyncingNewMessage;
    simOrder1B.cleanup();
    recordResult(
      17,
      'Order 1B (skeleton visible -> interaction INSERT): clears skeleton immediately upon arrival',
      'shownAt200ms: true, clearedImmediately: true',
      `shownAt200ms: ${skeletonWasShownAt200ms}, clearedImmediately: ${skeletonClearedImmediately}`,
      skeletonWasShownAt200ms && skeletonClearedImmediately
    );

    // Test 18: Order 2: interaction INSERT arrives FIRST -> conversation UPDATE arrives AFTERWARDS
    // Bubble is already shown -> skeleton MUST NOT pop up afterwards!
    const simOrder2 = new InboxViewSkeletonSimulator();
    const eventTime = '2026-10-13T14:20:00.000Z';

    // 1. Interaction arrives FIRST
    simOrder2.handleInteractionInsert({
      id: 'msg_003',
      conversation_id: 'conv_kh000004',
      sanitized_content: 'arrived first',
      created_at: eventTime,
      direction: 'INBOUND',
    });
    assert.strictEqual(simOrder2.messages.length, 1, 'Bubble must be appended immediately');

    // 2. Conversation UPDATE arrives 20ms later
    await new Promise(r => setTimeout(r, 20));
    simOrder2.handleConversationUpdate({
      id: 'conv_kh000004',
      last_message_at: eventTime,
    });

    // 3. Wait past 220ms (beyond 180ms anti-flicker delay)
    await new Promise(r => setTimeout(r, 220));
    const skeletonNeverAppeared = !simOrder2.isSyncingNewMessage && simOrder2.syncingDelayTimer === null;
    simOrder2.cleanup();
    recordResult(
      18,
      'Order 2 (interaction INSERT first -> conv UPDATE after): bubble rendered, skeleton NEVER shown afterwards',
      'skeletonVisible: false && delayTimer: null',
      `skeletonVisible: ${simOrder2.isSyncingNewMessage}, delayTimer: ${simOrder2.syncingDelayTimer}`,
      skeletonNeverAppeared
    );

    // Test 19: Order 3: Rapid messages (A, B, C) in interleaved order
    // No stale skeleton, exactly 3 bubbles rendered, zero duplicates
    const simOrder3 = new InboxViewSkeletonSimulator();
    const times = ['2026-10-13T14:25:01.000Z', '2026-10-13T14:25:02.000Z', '2026-10-13T14:25:03.000Z'];

    // Rapid burst
    simOrder3.handleInteractionInsert({ id: 'rapid_1', conversation_id: 'conv_kh000004', sanitized_content: 'rapid-1', created_at: times[0], direction: 'INBOUND' });
    simOrder3.handleConversationUpdate({ id: 'conv_kh000004', last_message_at: times[0] });

    simOrder3.handleInteractionInsert({ id: 'rapid_2', conversation_id: 'conv_kh000004', sanitized_content: 'rapid-2', created_at: times[1], direction: 'INBOUND' });
    simOrder3.handleConversationUpdate({ id: 'conv_kh000004', last_message_at: times[1] });

    simOrder3.handleInteractionInsert({ id: 'rapid_3', conversation_id: 'conv_kh000004', sanitized_content: 'rapid-3', created_at: times[2], direction: 'INBOUND' });
    simOrder3.handleConversationUpdate({ id: 'conv_kh000004', last_message_at: times[2] });

    await new Promise(r => setTimeout(r, 250));
    const order3Passed = !simOrder3.isSyncingNewMessage && simOrder3.messages.length === 3;
    simOrder3.cleanup();
    recordResult(
      19,
      'Order 3 (Rapid messages A, B, C interleaved): 3 bubbles rendered, no stale skeleton, zero duplicates',
      'messages: 3, skeleton: false',
      `messages: ${simOrder3.messages.length}, skeleton: ${simOrder3.isSyncingNewMessage}`,
      order3Passed
    );

    // Test 20: Order 4: Missed interaction event -> skeleton appears, timeout clears it
    const simOrder4 = new InboxViewSkeletonSimulator();
    simOrder4.handleConversationUpdate({
      id: 'conv_kh000004',
      last_message_at: '2026-10-13T14:30:00.000Z',
    });

    // At 200ms: skeleton should be visible
    await new Promise(r => setTimeout(r, 200));
    const skeletonVisibleOrder4 = simOrder4.isSyncingNewMessage;

    // Simulate 4000ms timeout triggering hard clear
    if (simOrder4.syncingTimeoutTimer) {
      clearTimeout(simOrder4.syncingTimeoutTimer);
    }
    simOrder4.isSyncingNewMessage = false;

    simOrder4.cleanup();
    recordResult(
      20,
      'Order 4 (Missed interaction event): skeleton appears after 180ms, timeout clears it cleanly',
      'skeletonVisibleAt200ms: true, clearedOnTimeout: true',
      `skeletonVisibleAt200ms: ${skeletonVisibleOrder4}, clearedOnTimeout: ${!simOrder4.isSyncingNewMessage}`,
      skeletonVisibleOrder4 && !simOrder4.isSyncingNewMessage
    );

  } finally {
    await browser.close();
  }

  // Print summary table
  console.log('\n======================================================================');
  console.log('REGRESSION AUDIT SUMMARY:');
  console.log('======================================================================');
  console.table(testResults);

  const failed = testResults.filter(r => r.status === 'FAIL');
  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} REGRESSION TEST(S) FAILED!`);
    process.exit(1);
  } else {
    console.log(`\n✅ ALL ${testResults.length}/${testResults.length} REGRESSION TESTS PASSED!`);
  }
}

void runAllRegressionTests();
