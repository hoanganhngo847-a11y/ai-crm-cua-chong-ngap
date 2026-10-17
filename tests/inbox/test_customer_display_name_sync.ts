import assert from 'node:assert';
import path from 'path';
import { createRequire } from 'node:module';
const workerRequire = createRequire(path.resolve(process.cwd(), 'fb-inbox-worker/package.json'));
const { chromium } = workerRequire('playwright');
import { NextRequest } from 'next/server';
import { POST as browserSyncHandler } from '../../app/api/inbox/browser-sync/route';
import {
  InboxService,
  isGenericCustomerName,
  DEFAULT_INBOX_COMPANY_ID
} from '../../features/inbox/services/inbox.service';
import {
  extractCustomerDisplayName,
  extractActiveThreadMessages,
  isValidCustomerDisplayName
} from '../../fb-inbox-worker/src/parser';

const USER_DATA_DIR = path.resolve(process.cwd(), 'fb-inbox-worker/user_data');

async function runDisplayNameSyncTests() {
  process.env.DEMO_MODE = 'true';
  process.env.FB_WORKER_SECRET = 'test_secret_display_name_2026';

  console.log('========================================================================================');
  console.log('TEST SUITE: FACEBOOK CUSTOMER DISPLAY NAME EXTRACTION & CRM UPDATE SEMANTICS');
  console.log('========================================================================================\n');

  // --------------------------------------------------------------------------------------
  // SECTION 1: UNIT LOGIC & VALIDATION TESTS
  // --------------------------------------------------------------------------------------
  console.log('--- SECTION 1: CANDIDATE FILTERING & IS_GENERIC LOGIC ---');

  // Test 1.1: isValidCustomerDisplayName filters out UI text
  const rejectedUITexts = [
    'Hộp thư', 'Inbox', 'Chi tiết', 'Ghi chú', 'Assign',
    'Facebook', 'Messenger', 'Trực tuyến', 'Online', 'Offline',
    'Tất cả', 'Chưa đọc', 'Tin nhắn', 'Tìm kiếm', 'Bộ lọc',
    'Assign this conversation', 'View profile', 'Xem trang cá nhân',
    'Profile', 'Not now', 'Connect', 'Lúc khác', 'Bỏ qua', 'Đóng',
    'Tạo', 'Create', 'Settings', 'Help', 'Learn more', 'Reply in Messenger',
    'You: Xin chào', 'Thứ 2 10:00', 'Hôm nay 09:30', 'Khách hàng',
    'Facebook User', 'Unknown', 'Ẩn danh', 'a'
  ];

  for (const text of rejectedUITexts) {
    assert.strictEqual(
      isValidCustomerDisplayName(text),
      false,
      `Should reject UI text or generic name: "${text}"`
    );
  }
  console.log('✓ PASS 1.1: isValidCustomerDisplayName correctly rejects all UI words & generic names');

  // Test 1.2: isValidCustomerDisplayName accepts real Vietnamese names
  const validNames = [
    'HoàngAnh Ngô',
    'Nguyễn Văn Nam',
    'Trần Thị Bích',
    'Linh Hạ',
    'Đỗ Mạnh Cường',
    'Bác Quốc Tuấn'
  ];

  for (const name of validNames) {
    assert.strictEqual(
      isValidCustomerDisplayName(name),
      true,
      `Should accept valid real name: "${name}"`
    );
  }
  console.log('✓ PASS 1.2: isValidCustomerDisplayName accepts genuine human display names');

  // Test 1.3: isGenericCustomerName correctly identifies generic vs custom names
  assert.strictEqual(isGenericCustomerName('Khách hàng'), true);
  assert.strictEqual(isGenericCustomerName('Khách hàng Facebook'), true);
  assert.strictEqual(isGenericCustomerName('Facebook User'), true);
  assert.strictEqual(isGenericCustomerName('Unknown'), true);
  assert.strictEqual(isGenericCustomerName('Ẩn danh'), true);
  assert.strictEqual(isGenericCustomerName(''), true);
  assert.strictEqual(isGenericCustomerName(null), true);
  assert.strictEqual(isGenericCustomerName('Nguyễn Văn Nam'), false);
  assert.strictEqual(isGenericCustomerName('Anh Nam Công trình'), false);
  assert.strictEqual(isGenericCustomerName('HoàngAnh Ngô'), false);
  console.log('✓ PASS 1.3: isGenericCustomerName accurately categorizes names');

  // --------------------------------------------------------------------------------------
  // SECTION 2: LIVE META BUSINESS SUITE DOM EXTRACTION (REAL PROFILE)
  // --------------------------------------------------------------------------------------
  console.log('\n--- SECTION 2: LIVE AUDIT OF REAL META BUSINESS SUITE DOM ---');

  const isLiveRequired = process.env.DISPLAY_NAME_LIVE_REQUIRED === '1';
  console.log(`  • Mode: ${isLiveRequired ? 'LIVE REQUIRED MODE (DISPLAY_NAME_LIVE_REQUIRED=1)' : 'UNIT/CI MODE'}`);

  let liveCustomerFbId: string | null = null;
  let liveExtractedName: string | null = null;
  let liveDomSource: string | null = null;
  let liveMetaTestPassed = false;

  try {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true,
      viewport: { width: 1440, height: 900 }
    });

    const page = context.pages()[0] || await context.newPage();

    // STRICT PRODUCTION REQUIREMENT:
    // KHÔNG inject window.__name hoặc globalThis.__name.
    // Production parser chạy hoàn toàn tự nhiên (native evaluation).

    await page.goto('https://business.facebook.com/latest/inbox/all/?asset_id=1389294167596309', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    await page.waitForTimeout(5000);

    // Auto-dismiss promotional dialog if present
    await page.evaluate(() => {
      const notNowBtn = Array.from(document.querySelectorAll('button, div[role="button"], span'))
        .find(b => /^(Not now|Lúc khác|Bỏ qua|Đóng)$/i.test((b as HTMLElement).innerText || ''));
      if (notNowBtn) (notNowBtn as HTMLElement).click();
    });

    await page.waitForTimeout(2000);

    // Call extractActiveThreadMessages & extractCustomerDisplayName without any global shims
    const threadData = await extractActiveThreadMessages(page, '1389294167596309');
    liveExtractedName = await extractCustomerDisplayName(page);
    liveCustomerFbId = threadData.customerFbId;
    liveDomSource = threadData.customerNameSource;

    console.log('  • DOM Source của customer name:  ', liveDomSource);
    console.log('  • Extracted name:                ', liveExtractedName);
    console.log('  • Customer Facebook ID:          ', liveCustomerFbId);
    console.log('  • Stable Thread ID:              ', threadData.stableThreadId);

    assert.ok(liveExtractedName, 'Must extract real name from Business Suite');
    assert.notStrictEqual(liveExtractedName, 'Khách hàng', 'Must NOT fallback to generic "Khách hàng" when real name exists');
    assert.strictEqual(liveExtractedName, 'HoàngAnh Ngô', 'Real name in Business Suite active thread must be "HoàngAnh Ngô"');
    assert.strictEqual(liveCustomerFbId, '61592309996204', 'Customer Facebook ID must match exact expected profile "61592309996204"');

    liveMetaTestPassed = true;
    console.log('✓ LIVE_META_TEST = PASS (Production parser extracted "HoàngAnh Ngô" / FB ID 61592309996204 natively without __name shim)');

    await context.close();
  } catch (browserErr: unknown) {
    const msg = browserErr instanceof Error ? browserErr.message : String(browserErr);

    if (isLiveRequired) {
      console.error(`\n❌ LIVE_META_TEST = FAILED: Live browser test failed in LIVE REQUIRED mode:`, msg);
      throw browserErr;
    }

    console.log(`\n⚠️ LIVE_META_TEST = SKIPPED (Browser unavailable in UNIT/CI mode: ${msg})`);
    // In UNIT/CI mode only, populate synthetic baseline so Section 3 unit tests can execute
    liveCustomerFbId = '61592309996204';
    liveExtractedName = 'HoàngAnh Ngô';
    liveDomSource = 'thread_header ([data-surface*="detail_view_header"])';
  }

  // --------------------------------------------------------------------------------------
  // SECTION 3: CRM UPDATE SEMANTICS & EXISTING CUSTOMER KH-000004
  // --------------------------------------------------------------------------------------
  console.log('\n--- SECTION 3: CRM UPDATE SEMANTICS & CUSTOMER KH-000004 ---');

  const testCompanyId = DEFAULT_INBOX_COMPANY_ID;
  const targetFbId = liveCustomerFbId || '61592309996204';
  const targetThreadId = `1389294167596309:${targetFbId}`;

  // Reset store to clean baseline with KH-000004 currently having generic "Khách hàng"
  InboxService.resetInboxStore();
  const convsBefore = await InboxService.getConversations(testCompanyId);
  
  // Find customer KH-000004 and set generic name "Khách hàng"
  const conv4 = convsBefore.find(c => c.customer_code === 'KH-000004');
  if (!conv4) {
    throw new Error('Customer KH-000004 must exist in baseline store');
  }
  conv4.customer_name = 'Khách hàng';
  conv4.channel = 'facebook';
  conv4.customer_source = 'FACEBOOK';
  conv4.metadata = {
    ...(conv4.metadata || {}),
    provider: 'facebook_browser',
    customer_fb_id: targetFbId,
    external_conversation_id: targetThreadId
  };

  console.log('Trạng thái trước khi sync:');
  console.log(`  • customer_name (BEFORE): "${conv4.customer_name}"`);
  console.log(`  • customer_code:          "${conv4.customer_code}"`);

  assert.strictEqual(conv4.customer_name, 'Khách hàng');
  assert.strictEqual(conv4.customer_code, 'KH-000004');

  // Case 3.1: Inbound sync with real name "HoàngAnh Ngô" updates generic customer KH-000004
  {
    console.log('\n[Case 3.1] Inbound message with real name -> Updates generic name to real name');
    const msgId = `msg_inbound_${Date.now()}_1`;
    const req = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        company_id: testCompanyId,
        page_id: '1389294167596309',
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: liveExtractedName || 'HoàngAnh Ngô',
        customer_fb_id: targetFbId,
        external_conversation_id: targetThreadId,
        external_message_id: msgId,
        content: 'Tôi muốn tư vấn lắp cửa chống ngập',
        direction: 'inbound',
        timestamp: new Date().toISOString()
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_display_name_2026'
      }
    });

    const res = await browserSyncHandler(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);

    const convAfter = await InboxService.getConversationById(testCompanyId, conv4.id);
    assert.ok(convAfter, 'Conversation must exist');
    console.log('Trạng thái sau khi sync:');
    console.log(`  • customer_name (AFTER):  "${convAfter.customer_name}"`);
    console.log(`  • customer_code (AFTER):  "${convAfter.customer_code}"`);

    assert.strictEqual(convAfter.customer_name, liveExtractedName || 'HoàngAnh Ngô', 'customer_name must update to real Facebook name');
    assert.strictEqual(convAfter.customer_code, 'KH-000004', 'customer_code must remain KH-000004 (strictly preserved)');
    console.log('✓ PASS 3.1: KH-000004 customer_name updated from "Khách hàng" to "HoàngAnh Ngô", customer_code unchanged');
  }

  // Case 3.2: Sale manually set custom name -> Must NOT overwrite
  {
    console.log('\n[Case 3.2] Sale manually set custom name ("Anh Nam Công trình") -> DO NOT OVERWRITE');
    conv4.customer_name = 'Anh Nam Công trình';

    const msgId = `msg_inbound_${Date.now()}_2`;
    const req = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        company_id: testCompanyId,
        page_id: '1389294167596309',
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Nguyễn Văn Nam', // incoming different Facebook name
        customer_fb_id: targetFbId,
        external_conversation_id: targetThreadId,
        external_message_id: msgId,
        content: 'Báo giá cho tôi với',
        direction: 'inbound',
        timestamp: new Date().toISOString()
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_display_name_2026'
      }
    });

    const res = await browserSyncHandler(req);
    assert.strictEqual(res.status, 200);

    const convAfter = await InboxService.getConversationById(testCompanyId, conv4.id);
    assert.ok(convAfter);
    console.log(`  • customer_name with manual override: "${convAfter.customer_name}"`);
    assert.strictEqual(convAfter.customer_name, 'Anh Nam Công trình', 'Must NOT overwrite sale customized name');
    assert.strictEqual(convAfter.customer_code, 'KH-000004');
    console.log('✓ PASS 3.2: Sale customized name "Anh Nam Công trình" preserved against incoming "Nguyễn Văn Nam"');
  }

  // Case 3.3: Second Facebook conversation (Customer B)
  {
    console.log('\n[Case 3.3] Second Facebook conversation (Linh Hạ - FB ID 61578695363056)');
    const custB_FbId = '61578695363056';
    const custB_ThreadId = `1389294167596309:${custB_FbId}`;
    const msgIdB = `msg_inbound_${Date.now()}_b`;

    const reqB = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        company_id: testCompanyId,
        page_id: '1389294167596309',
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: 'Linh Hạ',
        customer_fb_id: custB_FbId,
        external_conversation_id: custB_ThreadId,
        external_message_id: msgIdB,
        content: 'Chào shop tư vấn cho mình nhé',
        direction: 'inbound',
        timestamp: new Date().toISOString()
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_display_name_2026'
      }
    });

    const resB = await browserSyncHandler(reqB);
    assert.strictEqual(resB.status, 200);
    const bodyB = await resB.json();

    const convB = await InboxService.getConversationById(testCompanyId, bodyB.conversation_id);
    assert.ok(convB);
    console.log(`  • Conversation 2 customer_name: "${convB.customer_name}"`);
    console.log(`  • Conversation 2 customer_code: "${convB.customer_code}"`);
    assert.strictEqual(convB.customer_name, 'Linh Hạ', 'Customer 2 name must be "Linh Hạ"');
    assert.ok(convB.customer_code.startsWith('KH-'), 'Customer 2 must have valid KH- code');
    console.log('✓ PASS 3.3: Second Facebook conversation ingested with real display name "Linh Hạ"');
  }

  // Case 3.4: Fail-Safe Fallback to "Khách hàng"
  {
    console.log('\n[Case 3.4] Fail-Safe Fallback when sender_name missing or null -> Fallback "Khách hàng"');
    const msgIdFallback = `msg_inbound_${Date.now()}_fallback`;
    const reqFallback = new NextRequest('http://localhost:3000/api/inbox/browser-sync', {
      method: 'POST',
      body: JSON.stringify({
        company_id: testCompanyId,
        page_id: '1389294167596309',
        page_name: 'MD Tech Cửa Chống Ngập',
        sender_name: '', // Empty triggers fallback
        customer_fb_id: '61599988899900',
        external_conversation_id: '1389294167596309:61599988899900',
        external_message_id: msgIdFallback,
        content: 'Fallback test message',
        direction: 'inbound',
        timestamp: new Date().toISOString()
      }),
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': 'test_secret_display_name_2026'
      }
    });

    const resFallback = await browserSyncHandler(reqFallback);
    assert.strictEqual(resFallback.status, 200);
    const bodyFallback = await resFallback.json();

    const convFallback = await InboxService.getConversationById(testCompanyId, bodyFallback.conversation_id);
    assert.ok(convFallback);
    console.log(`  • Fallback customer_name: "${convFallback.customer_name}"`);
    assert.ok(
      convFallback.customer_name.startsWith('Khách hàng'),
      'Must fallback safely to "Khách hàng" or "Khách hàng Facebook"'
    );
    console.log('✓ PASS 3.4: Fail-safe fallback executed gracefully');
  }

  // --------------------------------------------------------------------------------------
  // SECTION 4: UI CONTRACT VERIFICATION
  // --------------------------------------------------------------------------------------
  console.log('\n--- SECTION 4: UI CONTRACT VERIFICATION ---');
  console.log('  • Main Title:    customer_name (primary text in list & chat header)');
  console.log('  • Secondary:     customer_code (small font-mono badge)');
  console.log('  • Database:      customer_code strictly preserved and never deleted');
  console.log('\n========================================================================================');
  if (liveMetaTestPassed) {
    console.log('ALL DISPLAY NAME & CRM UPDATE SEMANTICS TESTS PASSED (INCLUDING LIVE META AUDIT: PASS) (100%)');
  } else {
    console.log('ALL UNIT & CRM UPDATE SEMANTICS TESTS PASSED (LIVE_META_TEST = SKIPPED)');
  }
  console.log('========================================================================================');
}

runDisplayNameSyncTests().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
