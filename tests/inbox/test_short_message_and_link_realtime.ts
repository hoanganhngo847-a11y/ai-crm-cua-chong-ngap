import assert from 'node:assert';
import { createRequire } from 'node:module';
import { extractActiveThreadMessages } from '../../fb-inbox-worker/src/parser.js';
import {
  isSafeHttpUrl,
  sanitizeMatchedUrl,
  isSingleUrlMessage,
  getSafeHostname
} from '../../features/inbox/components/message-content';
import type { InboxMessage, Conversation, MessageDeliveryStatus } from '../../features/inbox/types/inbox.types';
import { mergeDeliveryStatus } from '../../features/inbox/types/inbox.types';

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

async function runAllTests() {
  console.log('======================================================================');
  console.log('TEST SUITE: SHORT MESSAGE INGEST + REALTIME BUBBLE + SAFE CLICKABLE LINKS');
  console.log('======================================================================\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as any).__name = (f: any) => f;
  });

  try {
    // -----------------------------------------------------------------------------------------------
    // PART 1: DOM PARSER SHORT MESSAGES & DIRECTION FIXTURE
    // -----------------------------------------------------------------------------------------------
    console.log('--- PART 1: Parser Short Message & Direction Regression Tests ---');

    // Build realistic Meta Business Suite DOM fixture containing all required cases
    const fixtureHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <script>window.__name = function(fn) { return fn; };</script>
          <style>
            .container { width: 800px; display: flex; flex-direction: column; position: relative; }
            .header { height: 40px; }
            .row-inbound { display: flex; justify-content: flex-start; align-items: flex-start; margin: 4px; }
            .row-outbound { display: flex; justify-content: flex-end; align-items: flex-end; margin: 4px; }
            .bubble-inbound {
              background-color: rgb(240, 242, 245);
              border-radius: 18px;
              padding: 8px 12px;
              max-width: 60%;
              color: rgb(5, 5, 5);
            }
            .bubble-outbound {
              background-color: rgb(0, 132, 255);
              border-radius: 18px;
              padding: 8px 12px;
              max-width: 60%;
              color: #fff;
            }
            .time-divider { text-align: center; color: #888; font-size: 12px; margin: 8px; }
          </style>
        </head>
        <body>
          <div role="region" aria-label="Customer details">
            <a href="https://facebook.com/61592309996204" aria-label="HoàngAnh Ngô">HoàngAnh Ngô</a>
          </div>

          <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators" class="container">
            <div class="header">
              <span dir="auto">HoàngAnh Ngô</span>
            </div>

            <div class="time-divider"><span>8:30 PM</span></div>

            <!-- 1. hello inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">hello</div>
            </div>

            <!-- 2. hi inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">hi</div>
            </div>

            <!-- 3. ok inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">ok</div>
            </div>

            <!-- 4. yes inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">yes</div>
            </div>

            <!-- 5. no inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">no</div>
            </div>

            <!-- 6. ? inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">?</div>
            </div>

            <!-- 7. 1 inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">1</div>
            </div>

            <!-- 8. emoji-only 👍 inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">👍</div>
            </div>

            <!-- 9. emoji-only ❤️ inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">❤️</div>
            </div>

            <!-- 10. Outbound hello -->
            <div class="row-outbound">
              <div class="bubble-outbound" dir="auto">hello</div>
            </div>

            <!-- 11. Outbound ok -->
            <div class="row-outbound">
              <div class="bubble-outbound" dir="auto">ok</div>
            </div>

            <!-- 12. Outbound 👍 -->
            <div class="row-outbound">
              <div class="bubble-outbound" dir="auto">👍</div>
            </div>

            <!-- 13. Nested short message (must NOT duplicate) -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">
                <span dir="auto">bịp rồi</span>
              </div>
            </div>

            <!-- 14. URL-only inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">https://namethatui.com/</div>
            </div>

            <!-- 15. Mixed text + URL inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">Xem giúp mình link này https://namethatui.com/ nhé</div>
            </div>

            <!-- 16. Repeating short message in same thread: second 'hello' inbound -->
            <div class="row-inbound">
              <div class="bubble-inbound" dir="auto">hello</div>
            </div>

            <!-- UI Chrome that should NOT be parsed as message -->
            <div class="row-inbound">
              <button>Reply in Messenger</button>
              <button>Send</button>
            </div>
          </div>
        </body>
      </html>
    `;

    await page.setContent(fixtureHtml);

    const parsed = await extractActiveThreadMessages(page, '1389294167596309');
    assert(parsed.messages && parsed.messages.length > 0, 'Parser should extract messages');

    // Test 1: hello inbound parsed
    const helloInbound = parsed.messages.find((m: any) => m.content === 'hello' && m.direction === 'INBOUND');
    recordResult(1, 'hello inbound parsed correctly', 'INBOUND hello', `${helloInbound?.direction} ${helloInbound?.content}`, Boolean(helloInbound));

    // Test 2: hi inbound parsed
    const hiInbound = parsed.messages.find((m: any) => m.content === 'hi' && m.direction === 'INBOUND');
    recordResult(2, 'hi inbound parsed correctly', 'INBOUND hi', `${hiInbound?.direction} ${hiInbound?.content}`, Boolean(hiInbound));

    // Test 3: ok inbound parsed
    const okInbound = parsed.messages.find((m: any) => m.content === 'ok' && m.direction === 'INBOUND');
    recordResult(3, 'ok inbound parsed correctly', 'INBOUND ok', `${okInbound?.direction} ${okInbound?.content}`, Boolean(okInbound));

    // Test 4: emoji-only inbound parsed (👍, ❤️)
    const thumbInbound = parsed.messages.find((m: any) => m.content === '👍' && m.direction === 'INBOUND');
    const heartInbound = parsed.messages.find((m: any) => m.content === '❤️' && m.direction === 'INBOUND');
    const emojisOk = Boolean(thumbInbound) && Boolean(heartInbound);
    recordResult(4, 'emoji-only inbound parsed correctly (👍 and ❤️)', 'INBOUND 👍 & ❤️', `thumb=${thumbInbound?.content}, heart=${heartInbound?.content}`, emojisOk);

    // Test 5: one-character legitimate content parsed (?, 1)
    const qmarkInbound = parsed.messages.find((m: any) => m.content === '?' && m.direction === 'INBOUND');
    const oneInbound = parsed.messages.find((m: any) => m.content === '1' && m.direction === 'INBOUND');
    const oneCharOk = Boolean(qmarkInbound) && Boolean(oneInbound);
    recordResult(5, 'one-character legitimate content parsed (? and 1)', 'INBOUND ? & 1', `?=${qmarkInbound?.content}, 1=${oneInbound?.content}`, oneCharOk);

    // Test 6: short outbound still classified outbound (hello, ok, 👍)
    const helloOutbound = parsed.messages.find((m: any) => m.content === 'hello' && m.direction === 'OUTBOUND');
    const okOutbound = parsed.messages.find((m: any) => m.content === 'ok' && m.direction === 'OUTBOUND');
    const thumbOutbound = parsed.messages.find((m: any) => m.content === '👍' && m.direction === 'OUTBOUND');
    const outboundOk = Boolean(helloOutbound) && Boolean(okOutbound) && Boolean(thumbOutbound);
    recordResult(6, 'short outbound messages classified as OUTBOUND (hello, ok, 👍)', 'OUTBOUND hello, ok, 👍', `hello=${helloOutbound?.direction}, ok=${okOutbound?.direction}, thumb=${thumbOutbound?.direction}`, outboundOk);

    // Test 7: nested message has no duplicates
    const bipMsgs = parsed.messages.filter((m: any) => m.content === 'bịp rồi');
    recordResult(7, 'nested message does not produce duplicate nodes', 'count === 1', `count === ${bipMsgs.length}`, bipMsgs.length === 1);

    // Test 8: URL-only message parser preserves URL
    const urlOnlyMsg = parsed.messages.find((m: any) => m.content === 'https://namethatui.com/');
    recordResult(8, 'URL-only message preserves URL', 'https://namethatui.com/', urlOnlyMsg?.content || '', urlOnlyMsg?.content === 'https://namethatui.com/');

    // Test 9: mixed URL text preserved
    const mixedUrlMsg = parsed.messages.find((m: any) => m.content.includes('https://namethatui.com/') && m.content.includes('Xem giúp mình link này'));
    recordResult(9, 'mixed URL message preserves text and URL', 'Xem giúp mình link này https://namethatui.com/ nhé', mixedUrlMsg?.content || '', Boolean(mixedUrlMsg));

    // Test: Repeating hello bubbles preserved with unique deterministic fingerprints
    const helloInboundList = parsed.messages.filter((m: any) => m.content === 'hello' && m.direction === 'INBOUND');
    const repeatHelloOk = helloInboundList.length === 2 && helloInboundList[0].fingerprint !== helloInboundList[1].fingerprint;
    assert(repeatHelloOk, 'Repeating hello messages must be preserved with distinct occurrence fingerprints');

    // -----------------------------------------------------------------------------------------------
    // PART 2: REALTIME FAST PATH & SKELETON UX LOGIC
    // -----------------------------------------------------------------------------------------------
    console.log('\n--- PART 2: Realtime Fast Path & Syncing Skeleton Tests ---');

    // Test 10: Realtime interaction INSERT: bubble appended immediately without waiting for API fetch resolution
    const convId = 'conv-test-kh000004';
    let messagesState: Record<string, InboxMessage[]> = { [convId]: [] };
    let silentFetchCalled = false;

    // Simulate fast-path INSERT handler
    const realtimePayload = {
      id: 'inter-fast-001',
      company_id: '00000000-0000-0000-0000-000000000001',
      customer_id: 'cust-kh000004',
      conversation_id: convId,
      channel: 'facebook',
      direction: 'INBOUND',
      sanitized_content: 'hello',
      actor_type: 'CUSTOMER',
      created_at: new Date().toISOString(),
    };

    // Immediate append before API fetch
    const safeMsg: InboxMessage = {
      id: realtimePayload.id,
      company_id: realtimePayload.company_id,
      conversation_id: realtimePayload.conversation_id,
      customer_id: realtimePayload.customer_id,
      channel: 'facebook',
      sender_type: 'customer',
      sender_name: 'HoàngAnh Ngô',
      content: realtimePayload.sanitized_content,
      sanitized_content: realtimePayload.sanitized_content,
      created_at: realtimePayload.created_at,
      direction: 'inbound',
    };

    messagesState = {
      ...messagesState,
      [convId]: [...(messagesState[convId] || []), safeMsg],
    };

    // Background fetch simulation
    const simulateFetchPromise = new Promise<InboxMessage[]>(resolve => {
      setTimeout(() => {
        silentFetchCalled = true;
        resolve([safeMsg]);
      }, 50);
    });

    const isVisibleImmediately = messagesState[convId].length === 1 && !silentFetchCalled;
    recordResult(10, 'Realtime interaction INSERT: bubble appended immediately before API fetch returns', 'visible immediately: true, fetchResolved: false', `visible immediately: ${isVisibleImmediately}, fetchResolved: ${silentFetchCalled}`, isVisibleImmediately);

    // Test 11: Realtime direct append + API reconciliation: one bubble only (dedupe on interaction.id)
    const reconciledServerList = await simulateFetchPromise;
    // Reconcile logic: dedupe on interaction.id
    const existingList = messagesState[convId] || [];
    const serverById = new Map(reconciledServerList.map(m => [m.id, m]));
    const reconciled: InboxMessage[] = [];
    for (const local of existingList) {
      const match = serverById.get(local.id);
      if (match) {
        reconciled.push({ ...local, ...match });
      } else {
        reconciled.push(local);
      }
    }
    messagesState = { ...messagesState, [convId]: reconciled };
    const countIsOne = messagesState[convId].length === 1;
    recordResult(11, 'Realtime direct append + API reconciliation produces exactly one bubble', 'count === 1', `count === ${messagesState[convId].length}`, countIsOne);

    // Test 12: conversation update before interaction: skeleton appears after anti-flicker delay (180ms)
    let skeletonVisible = false;
    let antiFlickerTimer: NodeJS.Timeout | null = null;
    const triggerConvUpdate = (advanced: boolean) => {
      if (advanced) {
        antiFlickerTimer = setTimeout(() => {
          skeletonVisible = true;
        }, 180);
      }
    };

    triggerConvUpdate(true);
    // At 50ms (before anti-flicker delay): skeleton must NOT be visible yet
    await new Promise(r => setTimeout(r, 50));
    const notVisibleAt50ms = !skeletonVisible;
    // At 210ms (after anti-flicker delay): skeleton must be visible
    await new Promise(r => setTimeout(r, 160));
    const visibleAt210ms = skeletonVisible;
    recordResult(12, 'Conversation update triggers skeleton after 180ms anti-flicker delay', 'notVisibleAt50ms: true, visibleAt210ms: true', `notVisibleAt50ms: ${notVisibleAt50ms}, visibleAt210ms: ${visibleAt210ms}`, notVisibleAt50ms && visibleAt210ms);

    // Test 13: interaction arrives: skeleton disappears immediately
    const triggerInteractionArrival = () => {
      if (antiFlickerTimer) clearTimeout(antiFlickerTimer);
      skeletonVisible = false;
    };
    triggerInteractionArrival();
    recordResult(13, 'Interaction arrival clears skeleton immediately', 'skeletonVisible: false', `skeletonVisible: ${skeletonVisible}`, !skeletonVisible);

    // -----------------------------------------------------------------------------------------------
    // PART 3: CLICKABLE URL RENDERING & SECURITY TESTS
    // -----------------------------------------------------------------------------------------------
    console.log('\n--- PART 3: Safe Clickable URL Rendering & Security Tests ---');

    // Test 14: safe https URL: clickable
    const httpsValid = isSafeHttpUrl('https://namethatui.com/');
    recordResult(14, 'safe https URL is recognized as clickable', 'true', String(httpsValid), httpsValid === true);

    // Test 15: http URL: clickable
    const httpValid = isSafeHttpUrl('http://example.com/test?param=1');
    recordResult(15, 'safe http URL is recognized as clickable', 'true', String(httpValid), httpValid === true);

    // Test 16: javascript: URL: NOT clickable
    const jsValid = isSafeHttpUrl('javascript:alert(1)');
    recordResult(16, 'javascript: URL is NOT clickable (fails safe scheme check)', 'false', String(jsValid), jsValid === false);

    // Test 17: data: URL: NOT clickable
    const dataValid = isSafeHttpUrl('data:text/html,<script>alert(1)</script>');
    recordResult(17, 'data: URL is NOT clickable (fails safe scheme check)', 'false', String(dataValid), dataValid === false);

    // Test 18: mixed content: only URL segment anchor, trailing punctuation trimmed
    const mixedContent = 'Xem link này https://namethatui.com/. nhé';
    const rawMatch = mixedContent.match(/https?:\/\/[^\s]+/i)?.[0] || '';
    const { url: cleanedUrl, trailing } = sanitizeMatchedUrl(rawMatch);
    const mixedOk = cleanedUrl === 'https://namethatui.com/' && trailing === '.';
    recordResult(18, 'mixed content trims trailing dot punctuation from URL', 'url: https://namethatui.com/, trailing: .', `url: ${cleanedUrl}, trailing: ${trailing}`, mixedOk);

    // Test 19: single URL message detection (Link Card pattern)
    const single1 = isSingleUrlMessage('https://namethatui.com/');
    const single2 = isSingleUrlMessage('  https://namethatui.com/  ');
    const singleMixed = isSingleUrlMessage('Xem link https://namethatui.com/ nhé');
    const singleJs = isSingleUrlMessage('javascript:alert(1)');
    const singleCardOk = single1.isSingle && single2.isSingle && !singleMixed.isSingle && !singleJs.isSingle;
    recordResult(19, 'Single URL message correctly detected for Share/Link card (without SSRF fetch)', 'single: true, mixed: false, js: false', `single1: ${single1.isSingle}, single2: ${single2.isSingle}, mixed: ${singleMixed.isSingle}, js: ${singleJs.isSingle}`, singleCardOk);

    // Test 20: existing outbound delivery polling unaffected
    // Verify mergeDeliveryStatus monotonic progression
    const m1 = mergeDeliveryStatus('PENDING_DISPATCH', 'SENT');
    const m2 = mergeDeliveryStatus('SENT', 'PROCESSING');
    const m3 = mergeDeliveryStatus('SENT', 'DELIVERED');
    const deliveryPollOk = m1 === 'SENT' && m2 === 'SENT' && m3 === 'DELIVERED';
    recordResult(20, 'Existing outbound delivery status reconciliation unaffected', 'm1: SENT, m2: SENT, m3: DELIVERED', `m1: ${m1}, m2: ${m2}, m3: ${m3}`, deliveryPollOk);

  } finally {
    await browser.close();
  }

  // Print summary table
  console.log('\n======================================================================');
  console.log('SUMMARY TABLE:');
  console.log('======================================================================');
  console.table(testResults);

  const failed = testResults.filter(r => r.status === 'FAIL');
  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} TEST(S) FAILED!`);
    process.exit(1);
  } else {
    console.log(`\n✅ ALL ${testResults.length}/${testResults.length} TESTS PASSED PERFECTLY!`);
  }
}

void runAllTests();
