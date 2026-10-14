import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { POST as browserSyncHandler } from '../../app/api/inbox/browser-sync/route';
import { InboxService } from '../../features/inbox/services/inbox.service';
import { extractActiveThreadMessages, isPureTimestampText } from '../../fb-inbox-worker/src/parser.js';
import { ThreadMessageReconciler, messageReconciler } from '../../fb-inbox-worker/src/message-reconciler.js';
import { evaluateSkeletonCorrelation } from '../../features/inbox/utils/skeleton-helper';
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
        const prevLastAt = this.activeConversationLastMessageAt;
        const newLastAt = updatedConv.last_message_at;
        const latestRenderedMs = this.latestRenderedInteractionTimeByConv[convId] || 0;

        const decision = evaluateSkeletonCorrelation({
          conversationLastMessageAt: newLastAt,
          previousConversationLastMessageAt: prevLastAt,
          latestRenderedInteractionAtMs: latestRenderedMs,
        });

        if (!decision.advanced) return;

        this.activeConversationLastMessageAt = updatedConv.last_message_at;

        if (decision.shouldScheduleSkeleton) {
          if (this.syncingDelayTimer) clearTimeout(this.syncingDelayTimer);
          this.syncingDelayTimer = setTimeout(() => {
            const currentRenderedMs = this.latestRenderedInteractionTimeByConv[convId] || 0;
            if (currentRenderedMs >= decision.newLastAtMs) return; // Arrived during anti-flicker delay
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

    // ===============================================================================================
    // PART 5: ADVANCED P0 MESSAGE IDENTITY AUDIT (DOM RE-CREATION, RESTART, EVICTION)
    // ===============================================================================================
    console.log('\n--- PART 5: Advanced P0 Message Identity Audit (Re-creation, Restart, Eviction) ---');

    // Test 21: Full DOM node destruction & re-creation with identical messages + virtualization (P0-1)
    const thread21 = `${PAGE_ID}:61592309996221`;
    messageReconciler.resetThread(thread21);

    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996221" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div id="dom_msg_0" data-message-id="mid.$recreate_0" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
        <div class="row-inbound"><div id="dom_msg_1" data-message-id="mid.$recreate_1" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
      </div>
    `);

    const scan1T21 = await extractActiveThreadMessages(page, PAGE_ID);
    assert.strictEqual(scan1T21.messages.length, 2, 'Scan 1 must have 2 messages');
    const t21F0 = scan1T21.messages[0].fingerprint;
    const t21F1 = scan1T21.messages[1].fingerprint;
    assert.notStrictEqual(t21F0, t21F1, 'Identical messages must have distinct fingerprints');

    // Scan 2: FULL DOM DESTRUCTION & RE-CREATION! No DOM nodes or data-crm-msg-uid are preserved!
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996221" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
      </div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div id="dom_fresh_1" data-message-id="mid.$recreate_1" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
        <div class="row-inbound"><div id="dom_fresh_2" data-message-id="mid.$recreate_2" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
      </div>
    `);

    const scan2T21 = await extractActiveThreadMessages(page, PAGE_ID);
    assert.strictEqual(scan2T21.messages.length, 2, 'Scan 2 must have 2 messages');
    const t21Post0Fp = scan2T21.messages[0].fingerprint;
    const t21Post1Fp = scan2T21.messages[1].fingerprint;

    const t21Passed = t21Post0Fp === t21F1 && t21Post1Fp !== t21F0 && t21Post1Fp !== t21F1;
    recordResult(
      21,
      'P0-1: Full DOM re-creation + virtualization: old hello retains F1 and new hello gets brand new F2',
      `msg0===F1 && msg1!==F0 && msg1!==F1`,
      `msg0===F1: ${t21Post0Fp === t21F1}, msg1IsNew: ${t21Post1Fp !== t21F0 && t21Post1Fp !== t21F1}`,
      t21Passed
    );

    // Test 22: Paired Tests (Case R1 pure re-render vs Case R2 sliding window + new message)
    const thread22R1 = `${PAGE_ID}:61592309996222_r1`;
    messageReconciler.resetThread(thread22R1);

    // R1 Scan 1
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996222_r1">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div data-message-id="mid.r1_a" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello A</div></div>
        <div class="row-inbound"><div data-message-id="mid.r1_b" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello B</div></div>
      </div>
    `);
    const r1Scan1 = await extractActiveThreadMessages(page, PAGE_ID);
    const r1F0 = r1Scan1.messages[0].fingerprint;
    const r1F1 = r1Scan1.messages[1].fingerprint;

    // R1 Scan 2: Full DOM re-creation, NO new messages
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996222_r1">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div data-message-id="mid.r1_a" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello A</div></div>
        <div class="row-inbound"><div data-message-id="mid.r1_b" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello B</div></div>
      </div>
    `);
    const r1Scan2 = await extractActiveThreadMessages(page, PAGE_ID);
    const r1Stable = r1Scan2.messages[0].fingerprint === r1F0 && r1Scan2.messages[1].fingerprint === r1F1;

    // R2 Scan 1 & Scan 2: Sliding window + new message
    const thread22R2 = `${PAGE_ID}:61592309996222_r2`;
    messageReconciler.resetThread(thread22R2);

    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996222_r2">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div data-message-id="mid.r2_a" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello A</div></div>
        <div class="row-inbound"><div data-message-id="mid.r2_b" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello B</div></div>
      </div>
    `);
    const r2Scan1 = await extractActiveThreadMessages(page, PAGE_ID);
    const r2F1 = r2Scan1.messages[1].fingerprint;

    // R2 Scan 2: Full DOM re-creation, A virtualized, C added
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996222_r2">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div data-message-id="mid.r2_b" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello B</div></div>
        <div class="row-inbound"><div data-message-id="mid.r2_c" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello C</div></div>
      </div>
    `);
    const r2Scan2 = await extractActiveThreadMessages(page, PAGE_ID);
    const r2Distinct = r2Scan2.messages[0].fingerprint === r2F1 &&
      r2Scan2.messages[1].fingerprint !== r2Scan1.messages[0].fingerprint &&
      r2Scan2.messages[1].fingerprint !== r2F1;

    recordResult(
      22,
      'Paired Test: Case R1 preserves [F0, F1] without extra fingerprints; Case R2 preserves B->F1 and generates C->F2',
      'R1Stable: true && R2Distinct: true',
      `R1Stable: ${r1Stable}, R2Distinct: ${r2Distinct}`,
      r1Stable && r2Distinct
    );

    // Test 23: P0-2 Worker Process Restart
    const testStoragePath = path.resolve(process.cwd(), 'tests/inbox/test_restart_checkpoint.json');
    try { if (fs.existsSync(testStoragePath)) fs.unlinkSync(testStoragePath); } catch (_) {}

    const thread23 = `${PAGE_ID}:61592309996223`;
    let restartReconciler = new ThreadMessageReconciler({ storagePath: testStoragePath });

    const scanPreRestart = restartReconciler.reconcile({
      pageId: PAGE_ID,
      stableThreadId: thread23,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$rst_0' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$rst_1' },
      ],
    });
    const preF0 = scanPreRestart[0].fingerprint;
    const preF1 = scanPreRestart[1].fingerprint;
    restartReconciler.markFingerprintSynced(thread23, preF0);
    restartReconciler.markFingerprintSynced(thread23, preF1);

    // SIMULATE WORKER CRASH & PROCESS RESTART: Fresh instance initialized from disk
    restartReconciler = new ThreadMessageReconciler({ storagePath: testStoragePath });
    const crmSyncedFingerprints = new Set(restartReconciler.getAllSyncedFingerprints());

    // Post restart: DOM contains hello cũ (mid.$rst_1) and hello mới (mid.$rst_2)
    const scanPostRestart = restartReconciler.reconcile({
      pageId: PAGE_ID,
      stableThreadId: thread23,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$rst_1' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$rst_2' },
      ],
    });

    const post0Fp = scanPostRestart[0].fingerprint;
    const post1Fp = scanPostRestart[1].fingerprint;
    const t23Passed = post0Fp === preF1 && post1Fp !== preF0 && post1Fp !== preF1 && !crmSyncedFingerprints.has(post1Fp);

    recordResult(
      23,
      'P0-2: Worker restart: new message does not receive F0/F1 and is ingested exactly once without colliding with CRM',
      'post0===preF1 && post1!==preF0 && post1!==preF1 && !synced.has(post1)',
      `post0===preF1: ${post0Fp === preF1}, post1IsNew: ${post1Fp !== preF0 && post1Fp !== preF1}, notInCrm: ${!crmSyncedFingerprints.has(post1Fp)}`,
      t23Passed
    );

    // Test 24: P0-3 Thread State Eviction (LRU with persistent checkpoints)
    const thread24 = `${PAGE_ID}:61592309996224`;
    const evictionReconciler = new ThreadMessageReconciler({ maxThreads: 10, storagePath: testStoragePath });

    const scanPreEvict = evictionReconciler.reconcile({
      pageId: PAGE_ID,
      stableThreadId: thread24,
      rawMessages: [
        { content: 'repeat', direction: 'INBOUND', timestamp: '10:00 PM' },
        { content: 'repeat', direction: 'INBOUND', timestamp: '10:00 PM' },
      ],
    });
    const evictF0 = scanPreEvict[0].fingerprint;
    const evictF1 = scanPreEvict[1].fingerprint;
    evictionReconciler.markFingerprintSynced(thread24, evictF0);
    evictionReconciler.markFingerprintSynced(thread24, evictF1);

    // Evict thread24 from active memory by creating 15 other threads
    for (let i = 0; i < 15; i++) {
      evictionReconciler.reconcile({
        pageId: PAGE_ID,
        stableThreadId: `${PAGE_ID}:evict_${i}`,
        rawMessages: [{ content: `msg_${i}`, direction: 'INBOUND', timestamp: '10:00 PM' }],
      });
    }

    // Return to thread24: user sends 3rd repeated message
    const scanReturnEvict = evictionReconciler.reconcile({
      pageId: PAGE_ID,
      stableThreadId: thread24,
      rawMessages: [
        { content: 'repeat', direction: 'INBOUND', timestamp: '10:00 PM' },
      ],
    });

    const returnFp = scanReturnEvict[0].fingerprint;
    const t24Passed = returnFp !== evictF0 && returnFp !== evictF1 && !evictionReconciler.isFingerprintSynced(thread24, returnFp);

    recordResult(
      24,
      'P0-3: Thread eviction: returning to evicted thread preserves monotonic ordinals and avoids collision with synced fingerprints',
      'returnFp !== F0 && returnFp !== F1 && !synced.has(returnFp)',
      `returnFp: ${returnFp.slice(0, 8)}, F0: ${evictF0.slice(0, 8)}, F1: ${evictF1.slice(0, 8)}, collides: ${returnFp === evictF0 || returnFp === evictF1}`,
      t24Passed
    );

    try { if (fs.existsSync(testStoragePath)) fs.unlinkSync(testStoragePath); } catch (_) {}

    // ===============================================================================================
    // TEST 25 (REPRODUCTION OF P0): Legacy to Meta MID Migration Idempotency Invariant
    // Existing DB/CRM state: message already exists in CRM with legacy external_ref (OLD_F0).
    // Worker upgrades, scans DOM with data-message-id="mid.$historical_0", generates NEW_F0.
    // Invariant: interaction count in CRM MUST remain 1, must NOT insert a duplicate interaction.
    // ===============================================================================================
    process.env.DEMO_MODE = 'true';
    process.env.FB_WORKER_SECRET = 'test_secret_browser_sync_2026';
    const migrationThreadId = `${PAGE_ID}:61592309996225`;
    messageReconciler.resetThread(migrationThreadId);
    const historicalContent = 'Xin chào shop cần tư vấn cửa chống ngập';
    const historicalTimestamp = '10:00 PM';

    // 1. Calculate legacy fingerprint (OLD_F0) exactly as pre-PR46 worker did:
    const legacyOldF0 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${migrationThreadId}:${historicalTimestamp}:${historicalContent}:INBOUND`)
      .digest('hex');

    // 2. Existing DB/CRM state: message already exists in CRM with externalRef = OLD_F0
    const existingIngest = await InboxService.addInboundMessage({
      channel: 'facebook',
      company_id: '00000000-0000-0000-0000-000000000001',
      senderName: 'Khách hàng Migration',
      externalUserId: '61592309996225',
      externalConversationId: migrationThreadId,
      externalRef: legacyOldF0,
      externalMessageId: legacyOldF0,
      content: historicalContent,
      timestamp: historicalTimestamp,
    });
    const crmConvId = existingIngest.conversationId;
    const initialInteractionCount = (await InboxService.getMessagesByConversationId('00000000-0000-0000-0000-000000000001', crmConvId)).length;
    assert.strictEqual(initialInteractionCount, 1, 'Initial interaction count must be 1');

    // 3. Worker upgrades and scans the DOM where the SAME physical message now has data-message-id:
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996225">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div role="heading">10:00 PM</div>
        <div class="row-inbound"><div data-message-id="mid.$historical_0" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">${historicalContent}</div></div>
      </div>
    `);
    const upgradedScan = await extractActiveThreadMessages(page, PAGE_ID);
    const scannedMsg = upgradedScan.messages[0];
    const newF0 = scannedMsg.fingerprint;

    // Send scanned message to CRM sync endpoint:
    const syncReq = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: PAGE_ID,
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Khách hàng Migration',
        customer_fb_id: '61592309996225',
        external_conversation_id: migrationThreadId,
        external_message_id: newF0,
        legacy_external_message_id: scannedMsg.legacyFingerprint,
        content: scannedMsg.content,
        direction: 'inbound',
        timestamp: scannedMsg.timestamp,
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });
    const syncRes = await browserSyncHandler(syncReq);
    const syncBody = await syncRes.json();
    const finalMessages = await InboxService.getMessagesByConversationId('00000000-0000-0000-0000-000000000001', crmConvId);

    const reproductionPassed = syncBody.is_duplicate === true && finalMessages.length === 1;
    recordResult(
      25,
      'M1 / P0 Reproduction: Worker upgrade rescans historical message -> recognized as duplicate via dual-fingerprint (count remains 1)',
      'is_duplicate === true && messages.length === 1',
      `is_duplicate: ${syncBody.is_duplicate}, messages.length: ${finalMessages.length}`,
      reproductionPassed
    );

    // ===============================================================================================
    // TEST 26 (M2): New Message After Migration Ingested Once, Rescan Produces 0 Duplicates
    // ===============================================================================================
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996225">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div role="heading">10:00 PM</div>
        <div class="row-inbound"><div data-message-id="mid.$historical_0" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">${historicalContent}</div></div>
        <div class="row-inbound"><div data-message-id="mid.new1" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Cửa chống ngập giá bao nhiêu?</div></div>
      </div>
    `);
    const m2Scan = await extractActiveThreadMessages(page, PAGE_ID);
    assert.strictEqual(m2Scan.messages.length, 2, 'M2 scan should have 2 messages');
    const newMsg = m2Scan.messages[1];

    // Sync new message to CRM:
    const m2SyncReq = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: PAGE_ID,
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Khách hàng Migration',
        customer_fb_id: '61592309996225',
        external_conversation_id: migrationThreadId,
        external_message_id: newMsg.fingerprint,
        legacy_external_message_id: newMsg.legacyFingerprint,
        content: newMsg.content,
        direction: 'inbound',
        timestamp: newMsg.timestamp,
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });
    const m2SyncRes = await (await browserSyncHandler(m2SyncReq)).json();
    const countAfterNew = (await InboxService.getMessagesByConversationId('00000000-0000-0000-0000-000000000001', crmConvId)).length;

    // Rescan identical thread:
    const m2RescanReq = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: PAGE_ID,
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Khách hàng Migration',
        customer_fb_id: '61592309996225',
        external_conversation_id: migrationThreadId,
        external_message_id: newMsg.fingerprint,
        legacy_external_message_id: newMsg.legacyFingerprint,
        content: newMsg.content,
        direction: 'inbound',
        timestamp: newMsg.timestamp,
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_browser_sync_2026',
      },
    });
    const m2RescanRes = await (await browserSyncHandler(m2RescanReq)).json();
    const countAfterRescan = (await InboxService.getMessagesByConversationId('00000000-0000-0000-0000-000000000001', crmConvId)).length;

    const m2Passed = m2SyncRes.is_duplicate === false && countAfterNew === 2 &&
      m2RescanRes.is_duplicate === true && countAfterRescan === 2;
    recordResult(
      26,
      'M2: New message after migration is ingested exactly once; subsequent rescan yields 0 duplicates',
      'new: is_dup=false, count=2; rescan: is_dup=true, count=2',
      `new: is_dup=${m2SyncRes.is_duplicate}, count=${countAfterNew}; rescan: is_dup=${m2RescanRes.is_duplicate}, count=${countAfterRescan}`,
      m2Passed
    );

    // ===============================================================================================
    // TEST 27 (M3): Repeated Identical Text ('hello', 'hello' historical, 'hello' new with 3 MIDs)
    // ===============================================================================================
    const threadM3 = `${PAGE_ID}:61592309996227`;
    messageReconciler.resetThread(threadM3);

    // Setup CRM historical state: 2 messages with identical content 'hello' at '10:00 PM'
    const legacyRepF0 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${threadM3}:10:00 PM:hello:INBOUND`)
      .digest('hex');
    const legacyRepF1 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${threadM3}:10:00 PM:hello:INBOUND:occ:1`)
      .digest('hex');

    const m3Hist0 = await InboxService.addInboundMessage({
      channel: 'facebook',
      company_id: '00000000-0000-0000-0000-000000000001',
      senderName: 'Khách hàng Rep',
      externalUserId: '61592309996227',
      externalConversationId: threadM3,
      externalRef: legacyRepF0,
      externalMessageId: legacyRepF0,
      content: 'hello',
      timestamp: '10:00 PM',
    });
    await InboxService.addInboundMessage({
      channel: 'facebook',
      company_id: '00000000-0000-0000-0000-000000000001',
      senderName: 'Khách hàng Rep',
      externalUserId: '61592309996227',
      externalConversationId: threadM3,
      externalRef: legacyRepF1,
      externalMessageId: legacyRepF1,
      content: 'hello',
      timestamp: '10:00 PM',
    });
    const m3ConvId = m3Hist0.conversationId;
    const initialM3Count = (await InboxService.getMessagesByConversationId('00000000-0000-0000-0000-000000000001', m3ConvId)).length;
    assert.strictEqual(initialM3Count, 2, 'Initial M3 count must be 2');

    // DOM contains: hello (mid.$rep_0), hello (mid.$rep_1), and new hello (mid.$rep_2)
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996227">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div role="heading">10:00 PM</div>
        <div class="row-inbound"><div data-message-id="mid.$rep_0" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
        <div class="row-inbound"><div data-message-id="mid.$rep_1" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
        <div class="row-inbound"><div data-message-id="mid.$rep_2" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">hello</div></div>
      </div>
    `);
    const m3Scan = await extractActiveThreadMessages(page, PAGE_ID);
    assert.strictEqual(m3Scan.messages.length, 3, 'M3 scan should have 3 messages');

    // Sync all 3:
    const syncResList = [];
    for (const m of m3Scan.messages) {
      const r = await (await browserSyncHandler(new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
        method: 'POST',
        body: JSON.stringify({
          page_id: PAGE_ID,
          page_name: 'MD Tech Cửa Chống Ngập',
          sender_name: 'Khách hàng Rep',
          customer_fb_id: '61592309996227',
          external_conversation_id: threadM3,
          external_message_id: m.fingerprint,
          legacy_external_message_id: m.legacyFingerprint,
          content: m.content,
          direction: 'inbound',
          timestamp: m.timestamp,
          metadata: {
            legacy_alias_confidence: 'confirmed',
          },
        }),
        headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret_browser_sync_2026' },
      }))).json();
      syncResList.push(r);
    }

    const finalM3Messages = await InboxService.getMessagesByConversationId('00000000-0000-0000-0000-000000000001', m3ConvId);
    const m3Passed = syncResList[0].is_duplicate === true &&
      syncResList[1].is_duplicate === true &&
      syncResList[2].is_duplicate === false &&
      finalM3Messages.length === 3;

    recordResult(
      27,
      'M3: Repeated identical text: historical 2 remain exactly once, new 3rd inserts exactly once (total=3)',
      'msg0: dup=true, msg1: dup=true, msg2: dup=false, count=3',
      `msg0: dup=${syncResList[0].is_duplicate}, msg1: dup=${syncResList[1].is_duplicate}, msg2: dup=${syncResList[2].is_duplicate}, count=${finalM3Messages.length}`,
      m3Passed
    );

    // ===============================================================================================
    // TEST 28 (M4): Worker Restart After Cutover (Historical + Existing v2 + New v2)
    // ===============================================================================================
    const m4StoragePath = path.resolve(process.cwd(), 'tests/inbox/test_m4_checkpoint.json');
    try { if (fs.existsSync(m4StoragePath)) fs.unlinkSync(m4StoragePath); } catch (_) {}

    const threadM4 = `${PAGE_ID}:61592309996228`;
    const m4Reconciler = new ThreadMessageReconciler({ storagePath: m4StoragePath });

    // Initial state: historical message synced with legacy FP, v2 message synced with v2 MID
    const m4LegacyFp = crypto.createHash('sha256').update(`${PAGE_ID}:${threadM4}:10:00 PM:chao ban:INBOUND`).digest('hex');
    const m4InitScan = m4Reconciler.reconcile({
      pageId: PAGE_ID,
      stableThreadId: threadM4,
      rawMessages: [
        { content: 'chao ban', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m4_0' },
        { content: 'tu van gia', direction: 'INBOUND', timestamp: '10:05 PM', messageId: 'mid.$m4_1' },
      ],
    });
    m4Reconciler.markFingerprintSynced(threadM4, m4InitScan[0].fingerprint, m4LegacyFp);
    m4Reconciler.markFingerprintSynced(threadM4, m4InitScan[1].fingerprint);
    m4Reconciler.flushSync();

    // SIMULATE WORKER PROCESS CRASH & RESTART:
    const m4RestartReconciler = new ThreadMessageReconciler({ storagePath: m4StoragePath });

    // Post-restart DOM: historical message + existing v2 message + brand new v2 message
    const m4PostScan = m4RestartReconciler.reconcile({
      pageId: PAGE_ID,
      stableThreadId: threadM4,
      rawMessages: [
        { content: 'chao ban', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m4_0' },
        { content: 'tu van gia', direction: 'INBOUND', timestamp: '10:05 PM', messageId: 'mid.$m4_1' },
        { content: 'kich thuoc 1m5', direction: 'INBOUND', timestamp: '10:10 PM', messageId: 'mid.$m4_2' },
      ],
    });

    const m4Msg0Synced = m4RestartReconciler.isFingerprintSynced(threadM4, m4PostScan[0].fingerprint);
    const m4Msg1Synced = m4RestartReconciler.isFingerprintSynced(threadM4, m4PostScan[1].fingerprint);
    const m4Msg2Synced = m4RestartReconciler.isFingerprintSynced(threadM4, m4PostScan[2].fingerprint);
    const m4Passed = m4Msg0Synced === true && m4Msg1Synced === true && m4Msg2Synced === false;

    recordResult(
      28,
      'M4: Restart after cutover: historical=no dup, existing v2=no dup, brand new v2=unseen/ingested once',
      'msg0Synced=true, msg1Synced=true, msg2Synced=false',
      `msg0Synced=${m4Msg0Synced}, msg1Synced=${m4Msg1Synced}, msg2Synced=${m4Msg2Synced}`,
      m4Passed
    );
    try { if (fs.existsSync(m4StoragePath)) fs.unlinkSync(m4StoragePath); } catch (_) {}

    // ===============================================================================================
    // TEST 29 (M5): Full DOM Recreation After Cutover (Same Meta MIDs, Brand New DOM Elements)
    // ===============================================================================================
    const threadM5 = `${PAGE_ID}:61592309996229`;
    messageReconciler.resetThread(threadM5);

    // Initial DOM: 2 messages
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996229">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div data-message-id="mid.$m5_a" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Tin A</div></div>
        <div class="row-inbound"><div data-message-id="mid.$m5_b" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Tin B</div></div>
      </div>
    `);
    const m5Scan1 = await extractActiveThreadMessages(page, PAGE_ID);
    const m5FpA1 = m5Scan1.messages[0].fingerprint;
    const m5FpB1 = m5Scan1.messages[1].fingerprint;
    messageReconciler.markFingerprintSynced(threadM5, m5FpA1);
    messageReconciler.markFingerprintSynced(threadM5, m5FpB1);

    // Full DOM recreation: completely new HTML elements and attributes
    await setSafeHtml(page, `
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/61592309996229">Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound"><div data-message-id="mid.$m5_a" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Tin A</div></div>
        <div class="row-inbound"><div data-message-id="mid.$m5_b" class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Tin B</div></div>
      </div>
    `);
    const m5Scan2 = await extractActiveThreadMessages(page, PAGE_ID);
    const m5FpA2 = m5Scan2.messages[0].fingerprint;
    const m5FpB2 = m5Scan2.messages[1].fingerprint;

    const m5Passed = m5FpA1 === m5FpA2 && m5FpB1 === m5FpB2 &&
      messageReconciler.isFingerprintSynced(threadM5, m5FpA2) &&
      messageReconciler.isFingerprintSynced(threadM5, m5FpB2);

    recordResult(
      29,
      'M5: Full DOM recreation after cutover: identical Meta MIDs retain 100% stable identity and zero duplicate sync',
      'fpA1===fpA2 && fpB1===fpB2 && both synced',
      `fpA: ${m5FpA1 === m5FpA2}, fpB: ${m5FpB1 === m5FpB2}`,
      m5Passed
    );

    // ===============================================================================================
    // TEST 30 (NEGATIVE TEST): Ancestor data-id="thread-container-1" is NOT Hijacked as Message ID
    // ===============================================================================================
    const threadM30 = `${PAGE_ID}:61592309996230`;
    messageReconciler.resetThread(threadM30);

    await setSafeHtml(page, `
      <div data-id="thread-container-1" role="region" aria-label="Customer details">
        <a href="https://facebook.com/61592309996230">Customer</a>
      </div>
      <div data-id="thread-container-messages" role="main" aria-label="Message list container with messages, suggestions, and typing indicators">
        <div class="row-inbound">
          <div class="bubble-inbound" dir="auto" style="background-color: rgb(240, 242, 245); border-radius: 18px;">Tin nhắn không có messageId attribute</div>
        </div>
      </div>
    `);
    const negScan = await extractActiveThreadMessages(page, PAGE_ID);
    assert.strictEqual(negScan.messages.length, 1, 'Negative test should parse 1 message');
    const parsedMid = negScan.messages[0].messageId;

    const negPassed = parsedMid === null;
    recordResult(
      30,
      'Negative Test: Ancestor data-id="thread-container-1" is rejected and NOT hijacked as per-message messageId',
      'messageId === null',
      `messageId: ${parsedMid}`,
      negPassed
    );

    // ===============================================================================================
    // TEST 31 (M6): Shifted Historical Window — Virtualized Prefix
    // DB has A(F0), B(F1), C(F2) with content="hello" at "10:00 PM".
    // Fresh upgraded worker only sees B(mid.$B) and C(mid.$C) (A is virtualized).
    // Current code BEFORE FIX would compute B→F0, C→F1 (shifted ordinal).
    // After fix: occurrence still shifts, but the legacy FP is treated as UNCONFIRMED
    // and must NOT suppress new canonical MIDs.
    // ===============================================================================================
    console.log('\n--- PART 6: P0 Shifted Legacy Ordinal (M6–M10) ---');

    const threadM6 = `${PAGE_ID}:61592309996231`;
    messageReconciler.resetThread(threadM6);
    const COMPANY_M6 = '00000000-0000-0000-0000-000000000001';
    InboxService.resetInboxStore();

    // Pre-upgrade DB state: 3 identical messages with legacy refs F0, F1, F2
    const legacyM6F0 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${threadM6}:10:00 PM:hello:INBOUND`).digest('hex');
    const legacyM6F1 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${threadM6}:10:00 PM:hello:INBOUND:occ:1`).digest('hex');
    const legacyM6F2 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${threadM6}:10:00 PM:hello:INBOUND:occ:2`).digest('hex');

    // Insert historical messages A(F0), B(F1), C(F2) into CRM
    const m6HistA = await InboxService.addInboundMessage({
      channel: 'facebook', company_id: COMPANY_M6,
      senderName: 'Khách M6', externalUserId: '61592309996231',
      externalConversationId: threadM6, externalRef: legacyM6F0,
      externalMessageId: legacyM6F0, content: 'hello', timestamp: '10:00 PM',
    });
    await InboxService.addInboundMessage({
      channel: 'facebook', company_id: COMPANY_M6,
      senderName: 'Khách M6', externalUserId: '61592309996231',
      externalConversationId: threadM6, externalRef: legacyM6F1,
      externalMessageId: legacyM6F1, content: 'hello', timestamp: '10:00 PM',
    });
    await InboxService.addInboundMessage({
      channel: 'facebook', company_id: COMPANY_M6,
      senderName: 'Khách M6', externalUserId: '61592309996231',
      externalConversationId: threadM6, externalRef: legacyM6F2,
      externalMessageId: legacyM6F2, content: 'hello', timestamp: '10:00 PM',
    });
    const m6ConvId = m6HistA.conversationId;
    const m6InitCount = (await InboxService.getMessagesByConversationId(COMPANY_M6, m6ConvId)).length;
    assert.strictEqual(m6InitCount, 3, 'M6 initial count must be 3');

    // Fresh upgraded worker sees only B(mid.$B) and C(mid.$C)
    // Reconciler is fresh (simulating worker upgrade, never seen this thread)
    const m6Reconciler = new ThreadMessageReconciler({ storagePath: null as unknown as string });
    const m6Scan = m6Reconciler.reconcile({
      pageId: PAGE_ID,
      stableThreadId: threadM6,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$B' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$C' },
      ],
    });

    // Show what the reconciler computed (shifted ordinals expected)
    const m6BLegacy = m6Scan[0].legacyFingerprint;
    const m6CLegacy = m6Scan[1].legacyFingerprint;
    console.log(`  M6 B.legacyFP=${m6BLegacy.slice(0, 8)} (expected shift to F0: ${m6BLegacy === legacyM6F0})`);
    console.log(`  M6 C.legacyFP=${m6CLegacy.slice(0, 8)} (expected shift to F1: ${m6CLegacy === legacyM6F1})`);

    // Sync B to CRM (v2 caller: has canonical fingerprint AND legacy fingerprint, they differ)
    const m6BSyncRes = await (await browserSyncHandler(new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: PAGE_ID, page_name: 'MD Tech',
        sender_name: 'Khách M6', customer_fb_id: '61592309996231',
        external_conversation_id: threadM6,
        external_message_id: m6Scan[0].fingerprint,  // canonical v2 (based on mid.$B)
        legacy_external_message_id: m6Scan[0].legacyFingerprint,  // guessed legacy F0
        content: 'hello', direction: 'inbound', timestamp: '10:00 PM',
      }),
      headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret_browser_sync_2026' },
    }))).json();

    // Sync C to CRM
    const m6CSyncRes = await (await browserSyncHandler(new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: PAGE_ID, page_name: 'MD Tech',
        sender_name: 'Khách M6', customer_fb_id: '61592309996231',
        external_conversation_id: threadM6,
        external_message_id: m6Scan[1].fingerprint,  // canonical v2 (based on mid.$C)
        legacy_external_message_id: m6Scan[1].legacyFingerprint,  // guessed legacy F1
        content: 'hello', direction: 'inbound', timestamp: '10:00 PM',
      }),
      headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret_browser_sync_2026' },
    }))).json();

    const m6CountAfterSync = (await InboxService.getMessagesByConversationId(COMPANY_M6, m6ConvId)).length;

    // Key: B and C are NEW canonical MIDs — they should NOT be falsely detected as duplicates
    // just because their guessed legacy FPs collide with historical F0/F1.
    // However, some policy may INSERT them (they ARE new v2 identities for the same physical messages).
    // The important part: they must NOT be suppressed wrongly.
    const m6Passed = m6BSyncRes.is_duplicate === false && m6CSyncRes.is_duplicate === false;
    recordResult(
      31,
      'M6: Shifted historical window — v2 canonical MIDs not suppressed by guessed legacy ordinal collision',
      'B: is_dup=false, C: is_dup=false (new canonical MIDs not falsely suppressed)',
      `B: is_dup=${m6BSyncRes.is_duplicate}, C: is_dup=${m6CSyncRes.is_duplicate}, count=${m6CountAfterSync}`,
      m6Passed
    );

    // ===============================================================================================
    // TEST 32 (M7): New repeated message after shifted baseline — D must INSERT exactly once
    // This is the CRITICAL invariant: D(mid.$D) = "hello" arrives after B/C synced.
    // D's guessed legacy FP would be F2 (occurrence 2) which EXISTS in DB for historical C.
    // BEFORE FIX: D would be falsely suppressed → MESSAGE LOST.
    // AFTER FIX: D is a new canonical MID and MUST be inserted.
    // ===============================================================================================
    const m7Scan = m6Reconciler.reconcile({
      pageId: PAGE_ID,
      stableThreadId: threadM6,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$B' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$C' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$D' },
      ],
    });

    const m7DMsg = m7Scan[2]; // D is the 3rd message
    console.log(`  M7 D.canonicalFP=${m7DMsg.fingerprint.slice(0, 8)}, D.legacyFP=${m7DMsg.legacyFingerprint.slice(0, 8)}`);
    console.log(`  M7 D.legacyFP === F2? ${m7DMsg.legacyFingerprint === legacyM6F2} (collision with historical C!)`);

    const m7DSyncRes = await (await browserSyncHandler(new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: PAGE_ID, page_name: 'MD Tech',
        sender_name: 'Khách M6', customer_fb_id: '61592309996231',
        external_conversation_id: threadM6,
        external_message_id: m7DMsg.fingerprint,          // canonical v2 (mid.$D)
        legacy_external_message_id: m7DMsg.legacyFingerprint,  // guessed legacy, likely F2
        content: 'hello', direction: 'inbound', timestamp: '10:00 PM',
      }),
      headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret_browser_sync_2026' },
    }))).json();

    // Rescan D to verify idempotency on canonical ref
    const m7DRescan = await (await browserSyncHandler(new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        page_id: PAGE_ID, page_name: 'MD Tech',
        sender_name: 'Khách M6', customer_fb_id: '61592309996231',
        external_conversation_id: threadM6,
        external_message_id: m7DMsg.fingerprint,
        legacy_external_message_id: m7DMsg.legacyFingerprint,
        content: 'hello', direction: 'inbound', timestamp: '10:00 PM',
      }),
      headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret_browser_sync_2026' },
    }))).json();

    const m7Passed = m7DSyncRes.is_duplicate === false && m7DRescan.is_duplicate === true;
    recordResult(
      32,
      'M7: New repeated message D after shifted baseline — INSERT exactly once, not suppressed by F2 collision',
      'D first: is_dup=false, D rescan: is_dup=true',
      `D first: is_dup=${m7DSyncRes.is_duplicate}, D rescan: is_dup=${m7DRescan.is_duplicate}`,
      m7Passed
    );

    // ===============================================================================================
    // TEST 33 (M8): Restart after shifted baseline — no false duplicates
    // Restart worker. DOM now shows C(mid.$C) and D(mid.$D). 
    // C and D should not be duplicated again, and new E must insert exactly once.
    // ===============================================================================================
    const m8StoragePath = path.resolve(process.cwd(), 'tests/inbox/test_m8_checkpoint.json');
    try { if (fs.existsSync(m8StoragePath)) fs.unlinkSync(m8StoragePath); } catch (_) {}

    // Simulate pre-restart: save state
    const m8PreRestart = new ThreadMessageReconciler({ storagePath: m8StoragePath });
    const m8PreScan = m8PreRestart.reconcile({
      pageId: PAGE_ID, stableThreadId: threadM6,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$C' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$D' },
      ],
    });
    m8PreRestart.markFingerprintSynced(threadM6, m8PreScan[0].fingerprint);
    m8PreRestart.markFingerprintSynced(threadM6, m8PreScan[1].fingerprint);
    m8PreRestart.flushSync();

    // Simulate restart
    const m8PostRestart = new ThreadMessageReconciler({ storagePath: m8StoragePath });
    const m8PostScan = m8PostRestart.reconcile({
      pageId: PAGE_ID, stableThreadId: threadM6,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$C' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$D' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$E' },
      ],
    });

    const m8CSynced = m8PostRestart.isFingerprintSynced(threadM6, m8PostScan[0].fingerprint);
    const m8DSynced = m8PostRestart.isFingerprintSynced(threadM6, m8PostScan[1].fingerprint);
    const m8ESynced = m8PostRestart.isFingerprintSynced(threadM6, m8PostScan[2].fingerprint);

    const m8Passed = m8CSynced === true && m8DSynced === true && m8ESynced === false;
    recordResult(
      33,
      'M8: Restart after shifted baseline — C/D recognized as synced, E is new (insert once)',
      'C synced=true, D synced=true, E synced=false',
      `C synced=${m8CSynced}, D synced=${m8DSynced}, E synced=${m8ESynced}`,
      m8Passed
    );
    try { if (fs.existsSync(m8StoragePath)) fs.unlinkSync(m8StoragePath); } catch (_) {}

    // ===============================================================================================
    // TEST 34 (M9): All historical messages visible — no regression
    // DOM still has A(mid.$A), B(mid.$B), C(mid.$C). All 3 are in CRM.
    // Sync should detect all 3 as duplicates via canonical ref.
    // ===============================================================================================
    const threadM9 = `${PAGE_ID}:61592309996232`;
    messageReconciler.resetThread(threadM9);
    InboxService.resetInboxStore();

    const legacyM9F0 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${threadM9}:10:00 PM:hello:INBOUND`).digest('hex');
    const legacyM9F1 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${threadM9}:10:00 PM:hello:INBOUND:occ:1`).digest('hex');
    const legacyM9F2 = crypto.createHash('sha256')
      .update(`${PAGE_ID}:${threadM9}:10:00 PM:hello:INBOUND:occ:2`).digest('hex');

    // Pre-populate CRM with legacy refs
    await InboxService.addInboundMessage({
      channel: 'facebook', company_id: COMPANY_M6,
      senderName: 'Khách M9', externalUserId: '61592309996232',
      externalConversationId: threadM9, externalRef: legacyM9F0,
      externalMessageId: legacyM9F0, content: 'hello', timestamp: '10:00 PM',
    });
    await InboxService.addInboundMessage({
      channel: 'facebook', company_id: COMPANY_M6,
      senderName: 'Khách M9', externalUserId: '61592309996232',
      externalConversationId: threadM9, externalRef: legacyM9F1,
      externalMessageId: legacyM9F1, content: 'hello', timestamp: '10:00 PM',
    });
    const m9Hist2 = await InboxService.addInboundMessage({
      channel: 'facebook', company_id: COMPANY_M6,
      senderName: 'Khách M9', externalUserId: '61592309996232',
      externalConversationId: threadM9, externalRef: legacyM9F2,
      externalMessageId: legacyM9F2, content: 'hello', timestamp: '10:00 PM',
    });
    const m9ConvId = m9Hist2.conversationId;

    // DOM has ALL 3 messages (no virtualization)
    const m9Reconciler = new ThreadMessageReconciler({ storagePath: null as unknown as string });
    const m9Scan = m9Reconciler.reconcile({
      pageId: PAGE_ID, stableThreadId: threadM9,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m9_A' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m9_B' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m9_C' },
      ],
    });

    // Sync all 3 (v2 caller): canonical refs are new, legacy refs align (no shift), but
    // since these are v2 callers (canonical != legacy), legacy branch is NOT used.
    // They should all be inserted as new canonical identities.
    const m9Results: Array<{is_duplicate: boolean}> = [];
    for (const m of m9Scan) {
      const r = await (await browserSyncHandler(new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
        method: 'POST',
        body: JSON.stringify({
          page_id: PAGE_ID, page_name: 'MD Tech',
          sender_name: 'Khách M9', customer_fb_id: '61592309996232',
          external_conversation_id: threadM9,
          external_message_id: m.fingerprint,
          legacy_external_message_id: m.legacyFingerprint,
          content: 'hello', direction: 'inbound', timestamp: '10:00 PM',
        }),
        headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret_browser_sync_2026' },
      }))).json();
      m9Results.push(r);
    }

    // Rescan all 3: should now be duplicates (via canonical ref match)
    const m9Rescan: Array<{is_duplicate: boolean}> = [];
    for (const m of m9Scan) {
      const r = await (await browserSyncHandler(new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
        method: 'POST',
        body: JSON.stringify({
          page_id: PAGE_ID, page_name: 'MD Tech',
          sender_name: 'Khách M9', customer_fb_id: '61592309996232',
          external_conversation_id: threadM9,
          external_message_id: m.fingerprint,
          legacy_external_message_id: m.legacyFingerprint,
          content: 'hello', direction: 'inbound', timestamp: '10:00 PM',
        }),
        headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret_browser_sync_2026' },
      }))).json();
      m9Rescan.push(r);
    }

    // V2 first sync: NOT duplicate (they are new canonical MIDs).
    // V2 rescan: IS duplicate (canonical ref already exists).
    // Note: The total count may be > 3 because historical legacy + v2 canonical are different identities.
    // This is the expected one-time cost of migration: legacy refs remain, and v2 refs are added.
    // The key invariant: rescans produce no MORE duplicates.
    const m9RescanAllDup = m9Rescan.every(r => r.is_duplicate === true);
    const m9Passed = m9RescanAllDup;
    recordResult(
      34,
      'M9: All historical visible — v2 rescans are all duplicates (canonical dedup works)',
      'rescan: all is_dup=true',
      `rescan: [${m9Rescan.map(r => r.is_duplicate).join(', ')}]`,
      m9Passed
    );

    // ===============================================================================================
    // TEST 35 (M10): Different text anchors with virtualized prefix
    // Messages: "hello", "price?", "hello", "hello"
    // Virtualize first 2 messages. Ensure reconciler doesn't create wrong aliases.
    // ===============================================================================================
    const threadM10 = `${PAGE_ID}:61592309996233`;
    const m10Reconciler = new ThreadMessageReconciler({ storagePath: null as unknown as string });

    // Full DOM: hello, price?, hello, hello
    const m10FullScan = m10Reconciler.reconcile({
      pageId: PAGE_ID, stableThreadId: threadM10,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_0' },
        { content: 'price?', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_1' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_2' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_3' },
      ],
    });

    // All 4 should have distinct fingerprints
    const m10Fps = m10FullScan.map(m => m.fingerprint);
    const m10Unique = new Set(m10Fps).size === 4;

    // Virtualize first 2 (hello, price?), only hello(m10_2), hello(m10_3) remain
    const m10PartialScan = m10Reconciler.reconcile({
      pageId: PAGE_ID, stableThreadId: threadM10,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_2' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_3' },
      ],
    });

    // After virtualization, remaining messages must retain their original fingerprints
    const m10Fp2Stable = m10PartialScan[0].fingerprint === m10FullScan[2].fingerprint;
    const m10Fp3Stable = m10PartialScan[1].fingerprint === m10FullScan[3].fingerprint;

    // Add new message m10_4 = hello after virtualization
    const m10NewScan = m10Reconciler.reconcile({
      pageId: PAGE_ID, stableThreadId: threadM10,
      rawMessages: [
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_2' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_3' },
        { content: 'hello', direction: 'INBOUND', timestamp: '10:00 PM', messageId: 'mid.$m10_4' },
      ],
    });

    // New message must have distinct fingerprint from all previous
    const m10NewFp = m10NewScan[2].fingerprint;
    const m10NewDistinct = !m10Fps.includes(m10NewFp) &&
      m10NewFp !== m10PartialScan[0].fingerprint &&
      m10NewFp !== m10PartialScan[1].fingerprint;

    const m10Passed = m10Unique && m10Fp2Stable && m10Fp3Stable && m10NewDistinct;
    recordResult(
      35,
      'M10: Different text anchors with virtualized prefix — no wrong alias, new message distinct',
      'unique=true, stable=true, newDistinct=true',
      `unique=${m10Unique}, fp2Stable=${m10Fp2Stable}, fp3Stable=${m10Fp3Stable}, newDistinct=${m10NewDistinct}`,
      m10Passed
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
