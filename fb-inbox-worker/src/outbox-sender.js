import { log } from './logger.js';
import { APP_STATE, detectPageState } from './state-checker.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verifies that the currently open thread in Meta Business Suite matches the target job.
 * Requirement F: Strict customer & thread ID verification. Never type in mismatched thread.
 */
export async function verifyActiveThreadTarget(page, targetCustomerFbId, targetThreadId, targetCustomerName) {
  return await page.evaluate(({ fbId, threadId, name }) => {
    // 1. Check profile link in right sidebar
    const profileLink = document.querySelector('a[href*="facebook.com/profile.php"], a[href*="facebook.com/"]');
    const href = profileLink ? profileLink.getAttribute('href') : '';
    if (fbId) {
      if (href.includes(`id=${fbId}`) || href.includes(`/${fbId}`)) {
        return { matched: true, reason: 'Matched customerFbId in right sidebar profile link' };
      }
      // If profile link exists but has a different ID -> Strict mismatch!
      if (href.includes('id=') && !href.includes(`id=${fbId}`)) {
        return { matched: false, reason: 'Active thread sidebar has different customer ID' };
      }
    }

    // 2. Check header title / customer name
    const headerEls = document.querySelectorAll(
      '[data-surface*="thread_header"] h1, [data-surface*="thread_header"] h2, [role="main"] h2'
    );
    for (const h of headerEls) {
      const text = (h.innerText || '').trim();
      if (name && text) {
        if (text.toLowerCase().includes(name.toLowerCase())) {
          return { matched: true, reason: `Matched customer display name: "${text}"` };
        }
        // If header text is distinctly different
        if (text.length > 2 && !text.toLowerCase().includes(name.toLowerCase())) {
          return { matched: false, reason: `Active header name "${text}" does not match target "${name}"` };
        }
      }
    }

    // 3. Check thread URL parameter
    if (threadId && window.location.href.includes(threadId)) {
      return { matched: true, reason: 'Matched threadId in URL' };
    }

    // Fallback: If no contradicting evidence and name/fbId absent
    if (!fbId && !name) {
      return { matched: true, reason: 'Single thread in view' };
    }

    return { matched: false, reason: 'Unable to verify active thread target' };
  }, { fbId: targetCustomerFbId, threadId: targetThreadId, name: targetCustomerName });
}

/**
 * Opens and verifies the exact conversation thread for an outbox job.
 */
export async function navigateToTargetConversation(page, job) {
  const meta = job.metadata || {};
  const customerFbId = meta.customer_fb_id;
  const externalThreadId = meta.external_conversation_id;
  const customerName = meta.customer_name;

  // 1. Check if active open thread already matches target
  const activeCheck = await verifyActiveThreadTarget(page, customerFbId, externalThreadId, customerName);
  if (activeCheck.matched) {
    log.info(`[THREAD VERIFIED] Hội thoại đang mở khớp với mục tiêu (${activeCheck.reason}).`);
    return true;
  }

  // 2. Scan conversation list rows to click target conversation
  const clicked = await page.evaluate(({ fbId, name }) => {
    const rows = Array.from(document.querySelectorAll('[data-surface*="thread_row"]'));
    for (const row of rows) {
      const text = row.innerText || '';
      if ((fbId && text.includes(fbId)) || (name && text.toLowerCase().includes(name.toLowerCase()))) {
        const clickable = row.querySelector('a, div[role="row"], div[role="button"]') || row;
        clickable.click();
        return true;
      }
    }
    return false;
  }, { fbId: customerFbId, name: customerName });

  if (clicked) {
    await sleep(2000);
    const postClickCheck = await verifyActiveThreadTarget(page, customerFbId, externalThreadId, customerName);
    return postClickCheck.matched;
  }

  // Fail safe if unable to verify target
  return false;
}

/**
 * Requirement C: Capture baseline of outbound bubbles before sending to prevent false positives.
 */
export async function captureOutboundBaseline(page) {
  return await page.evaluate(() => {
    const msgContainer = document.querySelector(
      '[aria-label="Message list container with messages, suggestions, and typing indicators"], [role="region"][aria-label*="Message"], [role="main"]'
    );
    if (!msgContainer) {
      return { count: 0, signatures: [], capturedAt: Date.now() };
    }

    const containerRect = msgContainer.getBoundingClientRect();
    const nodes = Array.from(msgContainer.querySelectorAll('*'));
    const signatures = [];
    let count = 0;

    for (const el of nodes) {
      const text = (el.innerText || '').trim();
      if (!text) continue;

      const isLeaf = el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === 'SPAN');
      if (!isLeaf) continue;

      let bgColor = '';
      let alignItems = '';
      let curr = el;
      for (let i = 0; i < 7 && curr && curr !== msgContainer; i++) {
        const style = window.getComputedStyle(curr);
        if (!bgColor && style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          bgColor = style.backgroundColor;
        }
        if (!alignItems && style.alignItems && style.alignItems !== 'normal') {
          alignItems = style.alignItems;
        }
        curr = curr.parentElement;
      }

      const rect = el.getBoundingClientRect();
      const relativeX = (rect.left - containerRect.left) / containerRect.width;

      const isOutbound =
        text.startsWith('You:') ||
        alignItems === 'flex-end' ||
        bgColor.includes('10, 124, 255') ||
        bgColor.includes('0, 132, 255') ||
        relativeX >= 0.40;

      if (isOutbound) {
        count++;
        // Unique signature combining text and vertical position
        const sig = `${text}::${Math.round(rect.top)}`;
        signatures.push(sig);
      }
    }

    return { count, signatures, capturedAt: Date.now() };
  });
}

/**
 * Types and sends message content into the Meta Business Suite composer.
 */
export async function typeAndSendMessage(page, content) {
  // 1. Locate composer textbox
  const composer = await page.$(
    'div[role="textbox"][contenteditable="true"], [role="main"] div[contenteditable="true"]'
  );

  if (!composer) {
    throw new Error('Không tìm thấy khung soạn thảo tin nhắn (Composer textbox not found)');
  }

  // 2. Focus and clear composer
  await composer.click();
  await sleep(300);

  // 3. Type content
  await composer.fill('');
  await page.keyboard.type(content, { delay: 25 });
  await sleep(500);

  // 4. Send message by pressing Enter
  await page.keyboard.press('Enter');
  await sleep(1000);
}

/**
 * Requirement C: Confirms that a NEW outbound bubble appeared after baseline.
 * Priority: (1) bubble count increases, (2) new signature not in baseline, (3) content matches.
 * Content match alone is rejected if no new bubble appeared.
 */
export async function confirmNewOutboundBubbleAppeared(page, expectedContent, baseline, timeoutMs = 8000) {
  const startTime = Date.now();
  const targetText = expectedContent.trim();

  while (Date.now() - startTime < timeoutMs) {
    const check = await page.evaluate(({ target, baseCount, baseSigs }) => {
      const msgContainer = document.querySelector(
        '[aria-label="Message list container with messages, suggestions, and typing indicators"], [role="region"][aria-label*="Message"], [role="main"]'
      );
      if (!msgContainer) return { confirmed: false, reason: 'NO_CONTAINER' };

      const containerRect = msgContainer.getBoundingClientRect();
      const nodes = Array.from(msgContainer.querySelectorAll('*'));
      let currentOutboundCount = 0;
      let foundNewMatchingBubble = false;

      for (const el of nodes) {
        const text = (el.innerText || '').trim();
        if (!text) continue;

        const isLeaf = el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === 'SPAN');
        if (!isLeaf) continue;

        let bgColor = '';
        let alignItems = '';
        let curr = el;
        for (let i = 0; i < 7 && curr && curr !== msgContainer; i++) {
          const style = window.getComputedStyle(curr);
          if (!bgColor && style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
            bgColor = style.backgroundColor;
          }
          if (!alignItems && style.alignItems && style.alignItems !== 'normal') {
            alignItems = style.alignItems;
          }
          curr = curr.parentElement;
        }

        const rect = el.getBoundingClientRect();
        const relativeX = (rect.left - containerRect.left) / containerRect.width;

        const isOutbound =
          text.startsWith('You:') ||
          alignItems === 'flex-end' ||
          bgColor.includes('10, 124, 255') ||
          bgColor.includes('0, 132, 255') ||
          relativeX >= 0.40;

        if (isOutbound) {
          currentOutboundCount++;
          const sig = `${text}::${Math.round(rect.top)}`;
          const isNewSig = !baseSigs.includes(sig);

          if (text.includes(target) && isNewSig) {
            foundNewMatchingBubble = true;
          }
        }
      }

      // Check criteria:
      // (1) Bubble count increased AND contains text
      // OR (2) A newly appeared bubble signature matches content
      if (foundNewMatchingBubble || (currentOutboundCount > baseCount && nodes.some(n => (n.innerText || '').includes(target)))) {
        return {
          confirmed: true,
          oldCount: baseCount,
          newCount: currentOutboundCount,
          reason: 'NEW_BUBBLE_CONFIRMED',
        };
      }

      return { confirmed: false, currentCount: currentOutboundCount, baseCount };
    }, { target: targetText, baseCount: baseline.count, baseSigs: baseline.signatures });

    if (check.confirmed) {
      return check;
    }

    await sleep(800);
  }

  return { confirmed: false, reason: 'TIMEOUT_NO_NEW_BUBBLE' };
}

/**
 * Requirement B: Reconciliation for orphan PROCESSING job.
 * Inspects the target thread in Meta Business Suite to determine if message was sent before worker crash.
 */
export async function reconcileOrphanOutboxJob(page, job) {
  log.info(`[RECONCILIATION] Bắt đầu đối soát Job orphan ID: ${job.id}`);
  log.info(`  • Nội dung: "${job.content}"`);
  log.info(`  • Bắt đầu xử lý lúc: ${job.processing_started_at || 'Không xác định'}`);

  // 1. Verify and navigate to target conversation
  const isTargetVerified = await navigateToTargetConversation(page, job);
  if (!isTargetVerified) {
    log.warn(`[RECONCILIATION] Không thể mở đúng thread của Job ${job.id}. Chuyển sang RECONCILE_REQUIRED.`);
    return {
      resolution: 'RECONCILE_REQUIRED',
      error: 'THREAD_MISMATCH_OR_CANNOT_OPEN: Không thể mở cuộc hội thoại để đối soát.',
    };
  }

  // 2. Scan outbound bubbles in thread
  const inspection = await page.evaluate((targetText) => {
    const msgContainer = document.querySelector(
      '[aria-label="Message list container with messages, suggestions, and typing indicators"], [role="region"][aria-label*="Message"], [role="main"]'
    );
    if (!msgContainer) return { found: false, count: 0 };

    const nodes = Array.from(msgContainer.querySelectorAll('*'));
    let outboundCount = 0;
    let foundMatch = false;

    for (const el of nodes) {
      const text = (el.innerText || '').trim();
      if (!text) continue;

      const isLeaf = el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === 'SPAN');
      if (!isLeaf) continue;

      const rect = el.getBoundingClientRect();
      const containerRect = msgContainer.getBoundingClientRect();
      const relativeX = (rect.left - containerRect.left) / containerRect.width;

      const isOutbound = text.startsWith('You:') || relativeX >= 0.40;
      if (isOutbound) {
        outboundCount++;
        if (text.includes(targetText)) {
          foundMatch = true;
        }
      }
    }

    return { found: foundMatch, count: outboundCount };
  }, job.content.trim());

  if (inspection.found) {
    log.success(`[RECONCILIATION] ✅ Tìm thấy bubble outbound khớp nội dung đã xuất hiện trong thread! Đánh dấu SENT.`);
    return {
      resolution: 'SENT',
      providerMessageId: `reconciled_found_${Date.now()}`,
    };
  } else if (inspection.count > 0 && !inspection.found) {
    log.info(`[RECONCILIATION] Thread đã tải đầy đủ (${inspection.count} tin) nhưng KHÔNG có tin nhắn này. Xác nhận chưa gửi -> RETRY.`);
    return {
      resolution: 'RETRY',
      error: 'RECONCILED_NOT_SENT: Xác nhận tin nhắn chưa xuất hiện trên Facebook trước khi crash.',
    };
  } else {
    log.warn(`[RECONCILIATION] Không đủ bằng chứng xác định. Chuyển sang RECONCILE_REQUIRED.`);
    return {
      resolution: 'RECONCILE_REQUIRED',
      error: 'RECONCILE_UNCERTAIN: Container rỗng hoặc không tải được tin nhắn.',
    };
  }
}

/**
 * Main dispatch function for sending an outbox job via Meta Business Suite.
 */
export async function executeSendOutboxJob(page, job) {
  log.info(`[OUTBOX DISPATCH] Bắt đầu xử lý Job ID: ${job.id}`);
  log.info(`  • Nội dung cần gửi: "${job.content}"`);
  log.info(`  • Khách hàng: ${job.metadata?.customer_name || 'Khách Facebook'}`);

  // 1. Check browser page state (Requirement E)
  const state = await detectPageState(page);
  if (state === APP_STATE.LOGIN_REQUIRED || state === APP_STATE.CHECKPOINT) {
    log.error(`[FACEBOOK_SESSION_REQUIRED] Trình duyệt yêu cầu đăng nhập lại hoặc gặp Checkpoint/2FA.`);
    return {
      sessionRequired: true,
      error: 'FACEBOOK_SESSION_REQUIRED: Vui lòng đăng nhập lại trên Chromium.',
    };
  }

  // 2. Open and verify correct thread (Requirement F)
  const isTargetVerified = await navigateToTargetConversation(page, job);
  if (!isTargetVerified) {
    log.warn(`[THREAD MISMATCH] Không thể xác thực đúng cuộc hội thoại cho Job ${job.id}. Tạm dừng gửi.`);
    return {
      success: false,
      error: 'THREAD_MISMATCH: Không thể mở đúng cuộc hội thoại của khách hàng.',
      isTransient: true,
    };
  }

  // 3. Record baseline before sending (Requirement C)
  const baseline = await captureOutboundBaseline(page);
  log.info(`[BASELINE CAPTURED] Số bubble outbound hiện có trong thread: ${baseline.count}`);

  // 4. Type and send message
  try {
    await typeAndSendMessage(page, job.content);
  } catch (typeErr) {
    return {
      success: false,
      error: `Lỗi khi nhập tin nhắn: ${typeErr.message}`,
      isTransient: true,
    };
  }

  // 5. Confirm NEW outbound bubble appearance after baseline (Requirement C)
  const confirmedResult = await confirmNewOutboundBubbleAppeared(page, job.content, baseline, 8000);
  if (!confirmedResult.confirmed) {
    log.warn(`[OUTBOUND NOT CONFIRMED] Không thấy bubble outbound MỚI xuất hiện sau khi gửi. Không đánh dấu SENT.`);
    return {
      success: false,
      error: 'OUTBOUND_NOT_CONFIRMED: Đã nhấn gửi nhưng không thấy bubble phản hồi mới xuất hiện trên Messenger.',
      isTransient: true,
    };
  }

  log.success(`[OUTBOUND CONFIRMED] ✅ Đã xác nhận bubble MỚI xuất hiện trong cuộc hội thoại (Số bubble tăng từ ${baseline.count} lên ${confirmedResult.newCount})!`);

  // Requirement A Test Hook: Crash simulation after send before CRM complete
  if (
    process.env.SIMULATE_CRASH_BEFORE_COMPLETE === 'true' ||
    (process.env.CRASH_ON_JOB_ID && process.env.CRASH_ON_JOB_ID === job.id)
  ) {
    log.warn(`[CRASH SIMULATION] 💥 Cố tình kill tiến trình worker ngay trước khi gọi complete (Test A)!`);
    process.exit(137);
  }

  return {
    success: true,
    providerMessageId: `fb_outbound_${Date.now()}`,
  };
}
