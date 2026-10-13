import crypto from 'crypto';
import { log } from './logger.js';
import { threadStore } from './thread-store.js';

export const UI_EXCLUDED_PATTERNS = [
  /^(Hộp thư|Inbox|Chi tiết|Ghi chú|Assign|Facebook|Messenger|Trực tuyến|Online|Offline)$/i,
  /^(Tất cả|Chưa đọc|Tin nhắn|Tìm kiếm|Bộ lọc|Search|Filter|Manage|Quản lý)$/i,
  /^(Ad replies|Priority|Follow up|Open Dropdown|Chỉ định|Assign this conversation)$/i,
  /^(View profile|Xem trang cá nhân|Trang cá nhân|Profile|Not now|Connect|Lúc khác|Bỏ qua|Đóng|Close)$/i,
  /^(Tạo|Create|Home|Notifications|Settings|Help|Cài đặt|Trợ giúp|Learn more|Tìm hiểu thêm)$/i,
  /^(Reply in Messenger|Enter|Đính kèm|Send|Gửi|Preview|Xem trước)$/i,
  /^(Khách hàng|Facebook User|Unknown|Ẩn danh)($|\s)/i,
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Thứ|Hôm nay|Hôm qua|\d{1,2} thg|\d{1,2}:\d{2})/i,
  /^You:/i
];

export function isValidCustomerDisplayName(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();
  if (clean.length < 2 || clean.length > 60) return false;
  for (const pattern of UI_EXCLUDED_PATTERNS) {
    if (pattern.test(clean)) return false;
  }
  if (clean.includes('\n')) return false;
  return true;
}

/**
 * Robust DOM Parser for Meta Business Suite Inbox
 * Conforms strictly to Phase 2A requirements:
 * 1. Strict INBOUND vs OUTBOUND classification via computed style, color, alignment.
 * 2. Stable thread identifier priority: direct UI threadId -> customer FB profile ID -> persistent worker mapping.
 * 3. Stable message idempotency fingerprinting.
 */

export async function extractPageName(page) {
  try {
    return await page.evaluate(() => {
      // 1. Check account picker / brand in top header or sidebar
      const selectors = [
        '[data-surface*="asset_selector"]',
        '[data-surface*="page_picker"]',
        '[data-testid*="business-asset"]',
        '[data-testid*="page_selector"]',
        '[aria-label*="Tài khoản"][aria-haspopup="menu"]',
        '[aria-label*="Trang"][aria-haspopup="menu"]',
        '[aria-label*="Business account"][aria-haspopup="menu"]',
        '[aria-label*="Account"][aria-haspopup="menu"]',
        'div[role="banner"] [role="button"] span[dir="auto"]'
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
          if (text && text.length > 1 && text.length < 80 && !/^(Tạo|Create|Home|Notifications|Inbox|Hộp thư|All tools|Settings)/i.test(text)) {
            return text.replace(/^(Trang|Tài khoản|Chuyển sang|Đổi tài khoản):\s*/i, '');
          }
        }
      }

      // 2. Check top banner profile / asset button
      const navButtons = Array.from(document.querySelectorAll('div[role="banner"] button, nav button, header button, div[role="navigation"] button'));
      const excluded = /^(Home|Notifications|Inbox|Ads|Content|Planner|Tools|All tools|Settings|Help|Create|Search|Links|Billing|Audiences|Events|Leads Center)/i;
      for (const btn of navButtons) {
        const t = (btn.innerText || '').trim();
        if (t.length >= 2 && t.length <= 50 && !excluded.test(t)) {
          return t;
        }
      }

      // 3. Fallback to asset_id in URL
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const assetId = urlParams.get('asset_id');
        if (assetId) {
          return `Page #${assetId}`;
        }
      } catch (_) {}

      return 'Trang Meta Business';
    });
  } catch (error) {
    return 'Trang Meta Business';
  }
}

export async function extractConversationsList(page, maxCap = 20) {
  try {
    return await page.evaluate((cap) => {
      const results = [];
      const seenRowIds = new Set();
      const timePattern = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Thứ|Hôm nay|Hôm qua|Today|Yesterday|\d{1,2}\s*(thg|\/|-)\s*\d{1,2}|\d{1,2}:\d{2}(\s*(AM|PM))?)/i;

      // Select conversation row containers
      const rowElements = Array.from(
        document.querySelectorAll('[data-surface*="thread_list/thread_row"], [data-surface*="thread_row"], div[role="row"]')
      );

      for (const el of rowElements) {
        if (results.length >= cap) break;

        const surface = el.getAttribute('data-surface') || '';
        const match = surface.match(/thread_row(\d+)/);
        const rowKey = match ? match[0] : (el.getAttribute('id') || `row_${results.length}`);

        if (seenRowIds.has(rowKey)) continue;

        // 1. Customer Name
        const titleEl = el.querySelector('[data-surface*="lib:thread_title"]') ||
                        document.querySelector(`[data-surface*="${rowKey}/lib:thread_title"]`);
        let customerName = '';
        if (titleEl) {
          const t = (titleEl.innerText || '').trim();
          if (t && t.length >= 2 && t.length <= 60 && !/^(Hộp thư|Inbox|Chi tiết|Ghi chú|Assign|Facebook|Messenger|Trực tuyến|Move to done|Mark as)/i.test(t)) {
            customerName = t;
          }
        }

        const allLines = (el.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);

        if (!customerName && allLines.length > 0) {
          for (const line of allLines) {
            if (line.length >= 2 && line.length <= 60 && !/^(Hộp thư|Inbox|Chi tiết|Ghi chú|Assign|Facebook|Messenger|Trực tuyến|Move to done|Mark as|You:|Thứ|Hôm|Today|Yesterday|\d{1,2}:)/i.test(line)) {
              customerName = line;
              break;
            }
          }
        }

        // 2. Time & Date
        const timeLines = allLines.filter(l => timePattern.test(l));
        const time = timeLines.join(' ') || 'Vừa xong';

        // 3. Message Snippet
        let snippet = '';
        const nonTimeLines = allLines.filter(
          l => l !== customerName && !timePattern.test(l) && !/^(Move to done|Mark as follow up|Chưa đọc|Unread)/i.test(l)
        );
        if (nonTimeLines.length > 0) {
          snippet = nonTimeLines[0];
        } else if (allLines.length >= 2) {
          snippet = allLines[1];
        }

        // 4. Unread Status
        let isUnread = false;
        const ariaLabel = el.getAttribute('aria-label') || '';
        if (/chưa đọc|unread/i.test(ariaLabel) || /chưa đọc|unread/i.test(el.innerText || '')) {
          isUnread = true;
        }

        const dotOrBadge = el.querySelector('[aria-label*="unread" i], [aria-label*="chưa đọc" i], svg[aria-label*="unread" i]');
        if (dotOrBadge) {
          isUnread = true;
        }

        const colorMatches = el.innerHTML.includes('0, 132, 255') || el.innerHTML.includes('24, 119, 242');
        if (colorMatches && !snippet.startsWith('You:') && !snippet.startsWith('Bạn:')) {
          isUnread = true;
        }

        const isSnippetOutbound = snippet.startsWith('You:') || snippet.startsWith('Bạn:');

        seenRowIds.add(rowKey);
        results.push({
          rowId: rowKey,
          index: results.length,
          customerName: customerName || 'Khách hàng',
          snippet: snippet || '',
          time: time || 'Vừa xong',
          isUnread,
          isSnippetOutbound,
          ariaLabel
        });
      }

      return results;
    }, maxCap);
  } catch (error) {
    log.warn(`Lỗi khi đọc danh sách hội thoại: ${error.message}`);
    return [];
  }
}

/**
 * Extracts all message bubbles from the active conversation thread
 * Implements strict INBOUND vs OUTBOUND classification and stable ID resolution.
 */
export async function extractActiveThreadMessages(page, pageId) {
  try {
    const startTime = Date.now();
    const rawData = await page.evaluate(() => {
      // 1. Identify Customer Profile Link in right sidebar or thread header
      const profileLinks = Array.from(
        document.querySelectorAll('a[href*="facebook.com/profile.php"], a[href*="facebook.com/"]')
      ).filter(a => {
        const href = a.getAttribute('href') || '';
        return !href.includes('business.facebook.com') && !href.includes('/help/') && !href.includes('/pages/');
      });

      let customerFbId = null;
      let profileHref = null;
      let targetProfileLink = null;

      for (const link of profileLinks) {
        const href = link.getAttribute('href') || '';
        const idMatch = href.match(/id=(\d+)/) || href.match(/facebook\.com\/(\d+)/);
        if (idMatch) {
          customerFbId = idMatch[1];
          profileHref = href;
          targetProfileLink = link;
          break;
        }
      }

      // UI Exclusion Patterns
      const UI_PATTERNS = [
        /^(Hộp thư|Inbox|Chi tiết|Ghi chú|Assign|Facebook|Messenger|Trực tuyến|Online|Offline)$/i,
        /^(Tất cả|Chưa đọc|Tin nhắn|Tìm kiếm|Bộ lọc|Search|Filter|Manage|Quản lý)$/i,
        /^(Ad replies|Priority|Follow up|Open Dropdown|Chỉ định|Assign this conversation)$/i,
        /^(View profile|Xem trang cá nhân|Trang cá nhân|Profile|Not now|Connect|Lúc khác|Bỏ qua|Đóng|Close)$/i,
        /^(Tạo|Create|Home|Notifications|Settings|Help|Cài đặt|Trợ giúp|Learn more|Tìm hiểu thêm)$/i,
        /^(Reply in Messenger|Enter|Đính kèm|Send|Gửi|Preview|Xem trước)$/i,
        /^(Khách hàng|Facebook User|Unknown|Ẩn danh)($|\s)/i,
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Thứ|Hôm nay|Hôm qua|\d{1,2} thg|\d{1,2}:\d{2})/i,
        /^You:/i
      ];

      const validator = {
        isValid(text) {
          if (!text || typeof text !== 'string') return false;
          const clean = text.trim();
          if (clean.length < 2 || clean.length > 60) return false;
          for (const pattern of UI_PATTERNS) {
            if (pattern.test(clean)) return false;
          }
          if (clean.includes('\n')) return false;
          return true;
        }
      };

      // Customer display name resolution with strict priority:
      // 1. Thread header
      // 2. Right customer detail / profile panel
      // 3. Facebook profile link's accessible name / text
      // 4. Conversation row title
      let customerName = '';
      let customerNameSource = '';

      // Priority 1: Thread header
      const headerSelectors = [
        '[data-surface*="detail_view_header"]',
        '[data-surface*="thread_header"]',
        '[data-surface*="inbox:detail_view_header"]',
        '[data-surface*="lib:inbox:detail_view_header"]',
        '[role="main"] header',
        '[role="region"] header'
      ];

      for (const sel of headerSelectors) {
        const headerEl = document.querySelector(sel);
        if (headerEl) {
          // Check heading / prominent elements first
          const headingEls = headerEl.querySelectorAll('h1, h2, h3, [role="heading"], div[dir="auto"], span[dir="auto"]');
          for (const h of headingEls) {
            const t = (h.innerText || '').trim();
            if (validator.isValid(t)) {
              customerName = t;
              customerNameSource = `thread_header (${sel} > ${h.tagName})`;
              break;
            }
          }
          if (customerName) break;

          // Check lines in headerEl innerText
          const lines = (headerEl.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            if (validator.isValid(line)) {
              customerName = line;
              customerNameSource = `thread_header_text_line (${sel})`;
              break;
            }
          }
          if (customerName) break;
        }
      }

      // Priority 2: Right customer detail / profile panel
      if (!customerName && targetProfileLink) {
        const parent = targetProfileLink.parentElement;
        if (parent) {
          for (const child of parent.children) {
            if (child === targetProfileLink) continue;
            const t = (child.innerText || '').trim();
            if (validator.isValid(t)) {
              customerName = t;
              customerNameSource = 'right_customer_detail_panel (profile_link_sibling)';
              break;
            }
          }
        }

        if (!customerName && parent?.parentElement) {
          const grandParent = parent.parentElement;
          const candidateEls = grandParent.querySelectorAll('h1, h2, h3, div, span');
          for (const el of candidateEls) {
            const t = (el.innerText || '').trim();
            if (validator.isValid(t)) {
              customerName = t;
              customerNameSource = 'right_customer_detail_panel (ancestor_element)';
              break;
            }
          }
        }
      }

      // Priority 3: Facebook Profile link accessible name / text
      if (!customerName && targetProfileLink) {
        const ariaLabel = (targetProfileLink.getAttribute('aria-label') || '').trim();
        const titleAttr = (targetProfileLink.getAttribute('title') || '').trim();
        const linkText = (targetProfileLink.innerText || '').trim();

        if (validator.isValid(ariaLabel)) {
          customerName = ariaLabel;
          customerNameSource = 'profile_link_aria_label';
        } else if (validator.isValid(titleAttr)) {
          customerName = titleAttr;
          customerNameSource = 'profile_link_title';
        } else if (validator.isValid(linkText)) {
          customerName = linkText;
          customerNameSource = 'profile_link_text';
        }
      }

      // Priority 4: Active thread row in conversation list
      if (!customerName) {
        const activeRow = document.querySelector('[data-surface*="thread_row"][aria-selected="true"], [data-surface*="thread_row0"]');
        if (activeRow) {
          const titleEl = activeRow.querySelector('[data-surface*="lib:thread_title"]');
          const t = (titleEl?.innerText || '').trim();
          if (validator.isValid(t)) {
            customerName = t;
            customerNameSource = 'thread_row_title';
          } else {
            const firstLine = (activeRow.innerText || '').split('\n').map(l => l.trim()).filter(Boolean)[0];
            if (validator.isValid(firstLine)) {
              customerName = firstLine;
              customerNameSource = 'thread_row_first_line';
            }
          }
        }
      }

      // 2. Scan Message list container
      const msgContainer = document.querySelector(
        '[aria-label="Message list container with messages, suggestions, and typing indicators"], [role="region"][aria-label*="Message"], [role="main"]'
      );

      if (!msgContainer) {
        return { error: 'Message container not found' };
      }

      // Target candidate bubbles, text containers, and timestamps directly (avoid scanning all DOM descendants)
      const candidateSelector = [
        '[role="row"]',
        'div[dir="auto"]',
        'span[dir="auto"]',
        'p[dir="auto"]',
        'div[style*="border-radius"]',
        'div[style*="background"]',
        'abbr[data-utime]',
      ].join(', ');

      let candidateNodes = Array.from(msgContainer.querySelectorAll(candidateSelector));

      // Fallback only if specific selectors found nothing
      if (candidateNodes.length === 0) {
        candidateNodes = Array.from(msgContainer.querySelectorAll('div, span, p'));
      }

      const totalCandidates = candidateNodes.length;

      // Hard cap to safety limit (max 200 nodes), taking the latest near active conversation area
      const MAX_CANDIDATES = 200;
      if (candidateNodes.length > MAX_CANDIDATES) {
        candidateNodes = candidateNodes.slice(-MAX_CANDIDATES);
      }

      let currentTimestampText = 'Vừa xong';
      let currentUtime = null;

      const parsedMessages = [];
      const seenKeys = new Set();
      const styleCache = new Map();
      const containerRect = msgContainer.getBoundingClientRect();

      for (const el of candidateNodes) {
        const text = (el.innerText || '').trim();
        if (!text) continue;

        // Check if element is a timestamp header
        if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Thứ|Hôm nay|Hôm qua|\d{1,2} thg|\d{1,2}:\d{2})/i.test(text) && text.length < 30) {
          currentTimestampText = text;
          const abbr = el.querySelector('abbr[data-utime]') || (el.tagName === 'ABBR' ? el : null);
          if (abbr) {
            currentUtime = abbr.getAttribute('data-utime');
          }
          continue;
        }

        // Must be leaf or near-leaf message bubble text
        const isLeaf = el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === 'SPAN');
        if (!isLeaf) continue;

        // Skip non-message UI actions
        if (/^(Reply in Messenger|Enter|Đính kèm|Assign this conversation|View profile|More items|Send|Gửi|Preview)/i.test(text)) {
          continue;
        }

        // Strict Direction Classification with style cache and limited ancestor depth (max 4)
        let bgColor = '';
        let alignItems = '';
        let curr = el;
        for (let i = 0; i < 4 && curr && curr !== msgContainer; i++) {
          const inlineBg = curr.style && curr.style.backgroundColor;
          if (!bgColor && inlineBg && inlineBg !== 'rgba(0, 0, 0, 0)' && inlineBg !== 'transparent') {
            bgColor = inlineBg;
          }
          const inlineAlign = curr.style && curr.style.alignItems;
          if (!alignItems && inlineAlign && inlineAlign !== 'normal') {
            alignItems = inlineAlign;
          }

          if (!bgColor || !alignItems) {
            let style = styleCache.get(curr);
            if (!style) {
              style = window.getComputedStyle(curr);
              styleCache.set(curr, style);
            }
            if (style) {
              if (!bgColor && style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
                bgColor = style.backgroundColor;
              }
              if (!alignItems && style.alignItems && style.alignItems !== 'normal') {
                alignItems = style.alignItems;
              }
            }
          }

          if (bgColor && alignItems) break;
          curr = curr.parentElement;
        }

        const rect = el.getBoundingClientRect();
        const relativeX = containerRect.width > 0 ? (rect.left - containerRect.left) / containerRect.width : 0;

        // Outbound signals:
        // - Text starts with "You:"
        // - Parent alignItems === 'flex-end'
        // - Background color is blue: rgb(10, 124, 255), rgb(0, 132, 255), rgb(24, 119, 242)
        // - Geometric position relativeX >= 0.40 (aligned to right half)
        const isBlueBg = bgColor.includes('10, 124, 255') || bgColor.includes('0, 132, 255') || bgColor.includes('24, 119, 242');
        const isRightAligned = alignItems === 'flex-end' || relativeX >= 0.40;
        const startsWithYou = text.startsWith('You:');
        const isOutbound = startsWithYou || isBlueBg || isRightAligned;

        // Inbound signals:
        // - Text does NOT start with "You:"
        // - Parent alignItems === 'flex-start'
        // - Background color is gray: rgb(239, 239, 239), rgb(240, 242, 245), rgb(242, 243, 245)
        // - Geometric position relativeX < 0.35 (aligned to left half)
        const isGrayBg = bgColor.includes('239, 239, 239') || bgColor.includes('240, 242, 245') || bgColor.includes('242, 243, 245');
        const isLeftAligned = alignItems === 'flex-start' || (relativeX < 0.35 && relativeX >= 0);
        const isInbound = !startsWithYou && !isBlueBg && (isLeftAligned || isGrayBg);

        let direction;
        if (isOutbound && !isInbound) {
          direction = 'OUTBOUND';
        } else if (isInbound && !isOutbound) {
          direction = 'INBOUND';
        } else if (isOutbound && isInbound) {
          // If signals conflict, prioritize definitive outbound markers if present
          if (startsWithYou || isBlueBg || alignItems === 'flex-end') {
            direction = 'OUTBOUND';
          } else {
            direction = 'AMBIGUOUS_DIRECTION';
          }
        } else {
          // Neither indicator clearly present -> Must NOT default to inbound (Requirement 14)
          direction = 'AMBIGUOUS_DIRECTION';
        }

        const cleanContent = text.replace(/^You:\s*/i, '').trim();

        const dedupeKey = `${direction}::${cleanContent}::${currentTimestampText}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);

        parsedMessages.push({
          content: cleanContent,
          direction,
          timestamp: currentTimestampText,
          utime: currentUtime,
          relativeX: Math.round(relativeX * 1000) / 1000
        });
      }

      return {
        customerFbId,
        profileHref,
        customerName,
        customerNameSource,
        candidateCount: totalCandidates,
        parsedMessages
      };
    });

    const durationMs = Date.now() - startTime;
    log.info(`[INBOUND_PARSE] duration_ms=${durationMs} candidate_count=${rawData?.candidateCount || 0}`);

    if (rawData.error || !rawData.parsedMessages) {
      return { customerFbId: null, stableThreadId: null, customerName: 'Khách hàng', messages: [] };
    }

    let finalCustomerName = rawData.customerName;
    if (finalCustomerName) {
      log.info(`[CUSTOMER_NAME_RESOLVED] Tên khách hàng: "${finalCustomerName}" (Nguồn: ${rawData.customerNameSource || 'DOM'})`);
    } else {
      log.warn('[CUSTOMER_NAME_FALLBACK] Không trích xuất được tên khách hàng từ DOM Meta Business Suite, fallback: Khách hàng');
      finalCustomerName = 'Khách hàng';
    }

    // Resolve stable thread ID following Priority Order (Rule 3)
    const stableThreadId = threadStore.resolveStableThreadId(
      pageId,
      rawData.customerFbId,
      null, // direct thread ID if available
      finalCustomerName
    );

    // Compute deterministic fingerprint for each message (Rule 4)
    const messages = rawData.parsedMessages.map(m => {
      const fingerprint = crypto
        .createHash('sha256')
        .update(`${pageId}:${stableThreadId}:${m.utime || m.timestamp}:${m.content}:${m.direction}`)
        .digest('hex');

      return {
        ...m,
        fingerprint,
        stableThreadId
      };
    });

    return {
      customerFbId: rawData.customerFbId,
      profileHref: rawData.profileHref,
      customerName: finalCustomerName,
      customerNameSource: rawData.customerNameSource || 'fallback',
      stableThreadId,
      messages
    };
  } catch (error) {
    log.warn(`Lỗi khi trích xuất tin nhắn active thread: ${error.message}`);
    return { customerFbId: null, stableThreadId: null, customerName: 'Khách hàng', messages: [] };
  }
}

/**
 * Helper rõ ràng trích xuất tên hiển thị thật của khách hàng Facebook
 * Tuân thủ thứ tự ưu tiên:
 * 1. Thread header ([data-surface*="detail_view_header"], [data-surface*="thread_header"])
 * 2. Right customer detail/profile panel
 * 3. Facebook profile link accessible name / text
 * 4. Active thread row in list
 * Loại bỏ toàn bộ text UI, không lấy message body làm tên.
 * Fail safely: Fallback 'Khách hàng', log [CUSTOMER_NAME_FALLBACK].
 */
export async function extractCustomerDisplayName(page) {
  try {
    const result = await page.evaluate(() => {
      const UI_PATTERNS = [
        /^(Hộp thư|Inbox|Chi tiết|Ghi chú|Assign|Facebook|Messenger|Trực tuyến|Online|Offline)$/i,
        /^(Tất cả|Chưa đọc|Tin nhắn|Tìm kiếm|Bộ lọc|Search|Filter|Manage|Quản lý)$/i,
        /^(Ad replies|Priority|Follow up|Open Dropdown|Chỉ định|Assign this conversation)$/i,
        /^(View profile|Xem trang cá nhân|Trang cá nhân|Profile|Not now|Connect|Lúc khác|Bỏ qua|Đóng|Close)$/i,
        /^(Tạo|Create|Home|Notifications|Settings|Help|Cài đặt|Trợ giúp|Learn more|Tìm hiểu thêm)$/i,
        /^(Reply in Messenger|Enter|Đính kèm|Send|Gửi|Preview|Xem trước)$/i,
        /^(Khách hàng|Facebook User|Unknown|Ẩn danh)($|\s)/i,
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Thứ|Hôm nay|Hôm qua|\d{1,2} thg|\d{1,2}:\d{2})/i,
        /^You:/i
      ];

      const validator = {
        isValid(text) {
          if (!text || typeof text !== 'string') return false;
          const clean = text.trim();
          if (clean.length < 2 || clean.length > 60) return false;
          for (const pattern of UI_PATTERNS) {
            if (pattern.test(clean)) return false;
          }
          if (clean.includes('\n')) return false;
          return true;
        }
      };

      // 1. Thread header
      const headerSelectors = [
        '[data-surface*="detail_view_header"]',
        '[data-surface*="thread_header"]',
        '[data-surface*="inbox:detail_view_header"]',
        '[data-surface*="lib:inbox:detail_view_header"]',
        '[role="main"] header',
        '[role="region"] header'
      ];

      for (const sel of headerSelectors) {
        const headerEl = document.querySelector(sel);
        if (headerEl) {
          const headingEls = headerEl.querySelectorAll('h1, h2, h3, [role="heading"], div[dir="auto"], span[dir="auto"]');
          for (const h of headingEls) {
            const t = (h.innerText || '').trim();
            if (validator.isValid(t)) {
              return { name: t, source: `thread_header (${sel} > ${h.tagName})` };
            }
          }

          const lines = (headerEl.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            if (validator.isValid(line)) {
              return { name: line, source: `thread_header_text_line (${sel})` };
            }
          }
        }
      }

      // 2 & 3. Right customer detail panel and profile link
      const profileLinks = Array.from(
        document.querySelectorAll('a[href*="facebook.com/profile.php"], a[href*="facebook.com/"]')
      ).filter(a => {
        const href = a.getAttribute('href') || '';
        return !href.includes('business.facebook.com') && !href.includes('/help/') && !href.includes('/pages/');
      });

      for (const link of profileLinks) {
        // Priority 2: Siblings in right detail panel
        const parent = link.parentElement;
        if (parent) {
          for (const child of parent.children) {
            if (child === link) continue;
            const t = (child.innerText || '').trim();
            if (validator.isValid(t)) {
              return { name: t, source: 'right_customer_detail_panel (profile_link_sibling)' };
            }
          }
        }

        if (parent?.parentElement) {
          const grandParent = parent.parentElement;
          const candidateEls = grandParent.querySelectorAll('h1, h2, h3, div, span');
          for (const el of candidateEls) {
            const t = (el.innerText || '').trim();
            if (validator.isValid(t)) {
              return { name: t, source: 'right_customer_detail_panel (ancestor_element)' };
            }
          }
        }

        // Priority 3: Facebook Profile link accessible name / text
        const ariaLabel = (link.getAttribute('aria-label') || '').trim();
        const titleAttr = (link.getAttribute('title') || '').trim();
        const linkText = (link.innerText || '').trim();

        if (validator.isValid(ariaLabel)) {
          return { name: ariaLabel, source: 'profile_link_aria_label' };
        }
        if (validator.isValid(titleAttr)) {
          return { name: titleAttr, source: 'profile_link_title' };
        }
        if (validator.isValid(linkText)) {
          return { name: linkText, source: 'profile_link_text' };
        }
      }

      // Priority 4: Active thread row in list
      const activeRow = document.querySelector('[data-surface*="thread_row"][aria-selected="true"], [data-surface*="thread_row0"]');
      if (activeRow) {
        const titleEl = activeRow.querySelector('[data-surface*="lib:thread_title"]');
        const t = (titleEl?.innerText || '').trim();
        if (validator.isValid(t)) {
          return { name: t, source: 'thread_row_title' };
        }
        const firstLine = (activeRow.innerText || '').split('\n').map(l => l.trim()).filter(Boolean)[0];
        if (validator.isValid(firstLine)) {
          return { name: firstLine, source: 'thread_row_first_line' };
        }
      }

      return null;
    });

    if (result && result.name) {
      log.info(`[CUSTOMER_NAME_RESOLVED] extractCustomerDisplayName: "${result.name}" (Nguồn: ${result.source})`);
      return result.name;
    }

    log.warn('[CUSTOMER_NAME_FALLBACK] extractCustomerDisplayName không tìm thấy tên, fallback: Khách hàng');
    return 'Khách hàng';
  } catch (err) {
    log.warn(`[CUSTOMER_NAME_FALLBACK] extractCustomerDisplayName gặp lỗi: ${err.message}, fallback: Khách hàng`);
    return 'Khách hàng';
  }
}

export async function selectConversation(page, index = 0) {
  try {
    return await page.evaluate((idx) => {
      const row = document.querySelector(`[data-surface*="thread_row${idx}"]`);
      if (row) {
        const clickable = row.querySelector('a, div[role="row"], div[role="button"]') || row;
        clickable.click();
        return true;
      }
      const rows = document.querySelectorAll('[data-surface*="thread_row"], div[role="row"]');
      if (rows && rows[idx]) {
        const clickable = rows[idx].querySelector('a, div[role="button"]') || rows[idx];
        clickable.click();
        return true;
      }
      return false;
    }, index);
  } catch (error) {
    return false;
  }
}
