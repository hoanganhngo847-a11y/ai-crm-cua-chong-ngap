import { chromium } from 'playwright';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USER_DATA_DIR = path.resolve(__dirname, 'user_data');

async function run() {
  console.log('=== CHẠY PROOF-OF-CONCEPT BÓC TÁCH TOÀN BỘ MESSAGE BUBBLES ===');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 }
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://business.facebook.com/latest/inbox/all/?asset_id=1389294167596309', {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  await page.waitForTimeout(6000);

  // Click Linh Hạ (thread_row0)
  await page.evaluate(() => {
    const row0 = document.querySelector('[data-surface*="thread_row0"]');
    const clickable = row0?.querySelector('a, div[role="row"], div[role="button"]') || row0;
    clickable?.click();
  });

  await page.waitForTimeout(3000);

  const pocData = await page.evaluate(() => {
    const pageId = '1389294167596309';
    let customerFbId = null;

    // 1. Stable Customer ID / Profile Link
    const profileLink = document.querySelector('a[href*="facebook.com/profile.php"], a[href*="facebook.com/"]');
    const profileHref = profileLink ? profileLink.getAttribute('href') : null;
    if (profileHref) {
      const match = profileHref.match(/id=(\d+)/);
      if (match) customerFbId = match[1];
    }

    // Stable Thread Identifier
    const stableThreadId = customerFbId ? `${pageId}:${customerFbId}` : `fb_thread_row0`;

    // 2. Scan Message list container
    const msgContainer = document.querySelector(
      '[aria-label="Message list container with messages, suggestions, and typing indicators"], [role="region"][aria-label*="Message"], [role="main"]'
    );

    if (!msgContainer) return { error: 'Không tìm thấy container' };

    // Get all direct text elements in message feed in document order
    const rawNodes = Array.from(msgContainer.querySelectorAll('*'));
    
    // Track timestamps
    let currentTimestampText = 'Vừa xong';
    let currentUtime = null;

    const parsedMessages = [];
    const seenTexts = new Set();

    for (const el of rawNodes) {
      const text = (el.innerText || '').trim();
      if (!text) continue;

      // Check if this element is a timestamp header (e.g., "Thu 10:49 PM", "Wed 7:00 PM")
      if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Thứ|Hôm nay|Hôm qua|\d{1,2} thg|\d{1,2}:\d{2})/i.test(text) && text.length < 30) {
        currentTimestampText = text;
        const abbr = el.querySelector('abbr[data-utime]') || (el.tagName === 'ABBR' ? el : null);
        if (abbr) {
          currentUtime = abbr.getAttribute('data-utime');
        }
        continue;
      }

      // Check if leaf node containing actual message text
      // Leaf or only child is icon/span
      const isLeaf = el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === 'SPAN');
      if (!isLeaf) continue;

      // Filter out non-message UI buttons
      if (/^(Reply in Messenger|Enter|Đính kèm|Assign this conversation|View profile|More items|Send|Gửi|Preview)/i.test(text)) {
        continue;
      }

      // Determine Direction via computed style & bounding box
      let bubbleContainer = el;
      let bgColor = '';
      let alignItems = '';
      let curr = el;
      for (let i = 0; i < 7 && curr && curr !== msgContainer; i++) {
        const style = window.getComputedStyle(curr);
        if (!bgColor && style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
          bgColor = style.backgroundColor;
        }
        if (!alignItems && style.alignItems && style.alignItems !== 'normal') {
          alignItems = style.alignItems;
        }
        curr = curr.parentElement;
      }

      const rect = el.getBoundingClientRect();
      const containerRect = msgContainer.getBoundingClientRect();
      const relativeX = (rect.left - containerRect.left) / containerRect.width;

      // Direction classification:
      // Inbound: alignItems === 'flex-start' OR bgColor is grey (rgb(239, 239, 239)) OR relativeX < 0.35
      // Outbound: alignItems === 'flex-end' OR bgColor is blue (rgb(10, 124, 255)) OR relativeX >= 0.40
      const isOutbound = alignItems === 'flex-end' || bgColor.includes('10, 124, 255') || relativeX >= 0.40;
      const direction = isOutbound ? 'OUTBOUND' : 'INBOUND';

      // Avoid duplicate sub-spans of the same text
      const dedupeKey = `${direction}::${text}::${currentTimestampText}`;
      if (seenTexts.has(dedupeKey)) continue;
      seenTexts.add(dedupeKey);

      parsedMessages.push({
        text,
        direction,
        timestamp: currentTimestampText,
        utime: currentUtime,
        bgColor,
        alignItems,
        relativeX: Math.round(relativeX * 100) / 100
      });
    }

    return {
      pageId,
      customerFbId,
      stableThreadId,
      parsedMessages
    };
  });

  console.log('\n--- KẾT QUẢ PHÂN TÍCH TOÀN BỘ MESSAGE BUBBLES ---');
  console.log('Page ID:', pocData.pageId);
  console.log('Customer Facebook ID:', pocData.customerFbId);
  console.log('Stable Thread ID:', pocData.stableThreadId);
  console.log(`Tổng số tin nhắn bóc tách: ${pocData.parsedMessages.length}`);
  console.log('\nDanh sách tin nhắn đã phân loại INBOUND / OUTBOUND:');

  for (const m of pocData.parsedMessages) {
    // Generate deterministic fingerprint
    const fingerprint = crypto.createHash('sha256')
      .update(`${pocData.pageId}:${pocData.stableThreadId}:${m.utime || m.timestamp}:${m.text}:${m.direction}`)
      .digest('hex');

    console.log(`[${m.direction.padEnd(8)}] "${m.text}" | Lúc: ${m.timestamp} | Fingerprint: ${fingerprint.slice(0, 16)}... (align: ${m.alignItems}, bg: ${m.bgColor})`);
  }

  // Assertion check for requirement 8
  const hasInbound = pocData.parsedMessages.some(m => m.direction === 'INBOUND');
  const hasOutbound = pocData.parsedMessages.some(m => m.direction === 'OUTBOUND');

  console.log('\n--- KIỂM TRA ĐIỀU KIỆN PROOF-OF-CONCEPT ---');
  console.log(`Có tin nhắn INBOUND chính xác: ${hasInbound ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);
  console.log(`Có tin nhắn OUTBOUND chính xác: ${hasOutbound ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  await context.close();
}

run().catch(console.error);
