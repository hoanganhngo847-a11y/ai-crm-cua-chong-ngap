import { fileURLToPath } from 'node:url';
import { createBrowserContext } from './browser.js';
import { CONFIG } from './config.js';
import { log } from './logger.js';
import { detectPageState, APP_STATE } from './state-checker.js';
import {
  extractPageName,
  extractConversationsList,
  extractActiveThreadMessages,
  selectConversation
} from './parser.js';
import { syncInboundMessageToCRM } from './crm-client.js';
import { claimOutboxJobs, completeOutboxJob, failOutboxJob, claimOrphanJobs, resolveReconciledJob } from './outbox-client.js';
import { executeSendOutboxJob, reconcileOrphanOutboxJob } from './outbox-sender.js';
import { healthServer } from './health-server.js';

// Cache processed message fingerprints locally in memory
export const syncedFingerprints = new Set();

export const SCAN_CONFIG = {
  MAX_HEAVY_THREADS_PER_CYCLE: 3,
  SCAN_TIME_BUDGET_MS: 8000,
  MAX_VISIBLE_ROWS: 20
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function processThreadData(threadData, cachedPageId, cachedPageName) {
  if (!threadData || !threadData.messages || threadData.messages.length === 0) return;

  for (const msg of threadData.messages) {
    // Requirement 14: AMBIGUOUS_DIRECTION handling
    if (msg.direction === 'AMBIGUOUS_DIRECTION') {
      log.warn(`[AMBIGUOUS_DIRECTION] Bỏ qua tin nhắn không xác định rõ chiều (không mặc định inbound): "${msg.content}" (Khách: ${threadData.customerName})`);
      continue;
    }

    // Requirement 13 & 5: OUTBOUND handling
    if (msg.direction === 'OUTBOUND') {
      if (!syncedFingerprints.has(msg.fingerprint)) {
        syncedFingerprints.add(msg.fingerprint);
        log.info(`[OUTBOUND] Nhận diện tin nhắn từ Page/Doanh nghiệp: "${msg.content}" -> Bỏ qua, tuyệt đối không gửi về CRM.`);
      }
      continue;
    }

    // Requirement 5 & 6 & Final Micro-fix: INBOUND handling
    if (msg.direction === 'INBOUND') {
      const fingerprint = msg.fingerprint;

      // A. Nếu fingerprint đã cached: skip.
      if (!syncedFingerprints.has(fingerprint)) {
        // B. Nếu chưa cached: gọi syncInboundMessageToCRM trước.
        log.info(`[INBOUND] Phát hiện tin nhắn mới từ khách hàng:`);
        log.info(`  • Page ID: ${cachedPageId}`);
        log.info(`  • Tên khách hàng: ${threadData.customerName}`);
        log.info(`  • Stable Thread ID: ${threadData.stableThreadId}`);
        log.info(`  • Message Fingerprint (external_ref): ${fingerprint}`);
        log.info(`  • Nội dung: "${msg.content}"`);
        log.info(`  • Thời gian: ${msg.timestamp}`);

        const syncResult = await syncInboundMessageToCRM({
          pageId: cachedPageId,
          pageName: cachedPageName,
          senderName: threadData.customerName,
          customerFbId: threadData.customerFbId,
          externalConversationId: threadData.stableThreadId,
          externalMessageId: fingerprint,
          content: msg.content,
          timestamp: msg.timestamp
        });

        // C. Chỉ add fingerprint vào syncedFingerprints khi syncResult.success === true
        // (Bao gồm cả isDuplicate === true vì DB đã xác nhận message tồn tại)
        if (syncResult && syncResult.success) {
          syncedFingerprints.add(fingerprint);
          healthServer.recordScanSuccess();
          healthServer.recordInboundDetected();

          const statusStr = syncResult.isDuplicate ? 'DUPLICATE_IGNORED (200 OK)' : 'INGESTED_SUCCESS (200 OK)';
          log.info(`  • Trạng thái sync CRM: ${statusStr} (Interaction ID: ${syncResult.interactionId || 'N/A'})`);
          if (!syncResult.isDuplicate) {
            log.messageBox({
              pageName: cachedPageName,
              customerName: threadData.customerName,
              text: msg.content,
              timestamp: msg.timestamp,
              isUnread: true
            });
          }
        } else {
          // D. Nếu syncResult.success === false: KHÔNG add fingerprint.
          // Message được phép retry ở scan cycle kế tiếp.
          log.warn(`  • Trạng thái sync CRM: THAT_BAI (${syncResult?.error || 'Unknown error'}) - Sẽ thử lại ở chu kỳ quét sau.`);
        }
      }
    }
  }
}

async function withTimeout(promise, ms, desc) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${desc} timed out after ${ms}ms`)), ms);
  });
  // Prevent unhandled rejection if timeoutPromise rejects first
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {});
  }
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function performInboundScan(page, expectedPageId, cachedPageName, options = {}) {
  const timeBudgetMs = options.scanTimeBudgetMs ?? SCAN_CONFIG.SCAN_TIME_BUDGET_MS;
  const maxHeavyThreads = options.maxHeavyThreads ?? SCAN_CONFIG.MAX_HEAVY_THREADS_PER_CYCLE;
  let readCursor = options.readCursor ?? 0;
  const startTime = Date.now();

  let threadsScannedThisCycle = 0;
  let timedOut = false;

  // 1. Inspect active open thread in viewport (fast, no navigation click needed)
  try {
    const activeBudgetMs = Math.max(1000, Math.min(6000, timeBudgetMs - (Date.now() - startTime)));
    const activeThreadData = await withTimeout(
      extractActiveThreadMessages(page, expectedPageId),
      activeBudgetMs,
      'extractActiveThreadMessages'
    );
    if (activeThreadData && activeThreadData.messages && activeThreadData.messages.length > 0) {
      await processThreadData(activeThreadData, expectedPageId, cachedPageName);
      threadsScannedThisCycle++;
    }
  } catch (inboundErr) {
    log.warn(`[INBOUND SCAN] Không thể trích xuất active thread: ${inboundErr.message}`);
  }

  // Check budget before proceeding to conversation list
  if (Date.now() - startTime >= timeBudgetMs) {
    log.info(`[INBOUND SCAN] Đã chạm giới hạn thời gian quét (${Date.now() - startTime}ms >= ${timeBudgetMs}ms). Thoát để nhường quyền cho outbox poll.`);
    timedOut = true;
    healthServer.recordScanMetrics({
      rowsSeen: 0,
      unreadRows: 0,
      threadsScanned: threadsScannedThisCycle
    });
    return {
      threadsScanned: threadsScannedThisCycle,
      rowsSeen: 0,
      unreadRows: 0,
      nextReadCursor: readCursor,
      timedOut
    };
  }

  // 2. Scan visible conversation list (up to 20 rows visible)
  let conversations = [];
  try {
    const listBudgetMs = Math.max(1000, Math.min(6000, timeBudgetMs - (Date.now() - startTime)));
    conversations = await withTimeout(
      extractConversationsList(page, SCAN_CONFIG.MAX_VISIBLE_ROWS),
      listBudgetMs,
      'extractConversationsList'
    );
  } catch (scanErr) {
    log.warn(`[CONVERSATION SCAN] Lỗi khi quét danh sách hội thoại: ${scanErr.message}`);
  }

  const rowsSeen = conversations ? conversations.length : 0;
  const unreadRows = conversations ? conversations.filter(c => c.isUnread).length : 0;

  if (conversations && conversations.length > 0) {
    const unreadConvs = conversations.filter(c => c.isUnread);
    const readConvs = conversations.filter(c => !c.isUnread);

    // Candidates selection:
    // A. Unread conversations ALWAYS prioritized first
    const candidates = [...unreadConvs];

    // B. Round-robin read conversations to fill remaining slots up to maxHeavyThreads
    const remainingSlots = Math.max(0, maxHeavyThreads - candidates.length);
    if (readConvs.length > 0 && remainingSlots > 0) {
      const selectedRead = [];
      for (let i = 0; i < remainingSlots && i < readConvs.length; i++) {
        const idx = (readCursor + i) % readConvs.length;
        selectedRead.push(readConvs[idx]);
      }
      readCursor = (readCursor + selectedRead.length) % readConvs.length;
      candidates.push(...selectedRead);
    }

    // Limit candidates to maxHeavyThreads
    const boundedCandidates = candidates.slice(0, maxHeavyThreads);

    for (const convItem of boundedCandidates) {
      // Check time budget before starting each heavy thread scan
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeBudgetMs) {
        log.info(`[INBOUND SCAN] Đã đạt scan time budget (${elapsed}ms >= ${timeBudgetMs}ms). Kết thúc lượt quét.`);
        timedOut = true;
        break;
      }
      if (threadsScannedThisCycle >= maxHeavyThreads) {
        break;
      }

      // If thread is index 0 and was already inspected as active thread, skip clicking unless unread
      if (convItem.index === 0 && !convItem.isUnread && threadsScannedThisCycle > 0) {
        continue;
      }

      const remainingBudgetMs = Math.max(1000, timeBudgetMs - (Date.now() - startTime));
      const selectTimeout = Math.min(3000, remainingBudgetMs);

      const selected = await withTimeout(
        selectConversation(page, convItem.index),
        selectTimeout,
        `selectConversation(${convItem.index})`
      ).catch(() => false);

      if (selected) {
        await sleep(500);
        const remainingExtractBudgetMs = Math.max(1000, timeBudgetMs - (Date.now() - startTime));
        const extractTimeout = Math.min(4000, remainingExtractBudgetMs);

        const threadData = await withTimeout(
          extractActiveThreadMessages(page, expectedPageId),
          extractTimeout,
          'extractActiveThreadMessages'
        ).catch(() => null);

        if (threadData && threadData.messages && threadData.messages.length > 0) {
          await processThreadData(threadData, expectedPageId, cachedPageName);
          threadsScannedThisCycle++;
        }
      }
    }
  }

  // Record scan metrics ONCE per cycle (fix double-counting!)
  healthServer.recordScanMetrics({
    rowsSeen,
    unreadRows,
    threadsScanned: threadsScannedThisCycle
  });

  return {
    threadsScanned: threadsScannedThisCycle,
    rowsSeen,
    unreadRows,
    nextReadCursor: readCursor,
    timedOut
  };
}

async function main() {
  log.banner('META BUSINESS SUITE INBOX WORKER (PHASE 2A - CRM SYNC)');
  log.info('Đang khởi động worker...');
  log.info(`CRM Sync Endpoint: ${CONFIG.CRM_SYNC_ENDPOINT}`);
  log.info('FB_WORKER_SECRET: configured');

  let browserHandle = null;
  let isRunning = true;

  // Graceful shutdown
  const shutdown = async () => {
    if (!isRunning) return;
    isRunning = false;
    log.info('Đang dừng worker và giải phóng tài nguyên...');
    try {
      await healthServer.stop();
      if (browserHandle && browserHandle.context) {
        await browserHandle.context.close();
      }
    } catch (_) {}
    log.success('Đã tắt worker.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Start health monitoring HTTP server (Phase 3 Production Operations)
    await healthServer.start(CONFIG.HEALTH_PORT, CONFIG.HEALTH_HOST);

    browserHandle = await createBrowserContext();
    const { page } = browserHandle;
    healthServer.setBrowserPage(page);
    healthServer.updateState({ browser_connected: true, meta_inbox_state: 'NAVIGATING' });

    log.info(`Điều hướng tới Inbox: ${CONFIG.INBOX_URL}`);
    try {
      await page.goto(CONFIG.INBOX_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT_MS });
    } catch (navError) {
      log.warn(`Điều hướng ban đầu mất nhiều thời gian, tiếp tục kiểm tra trạng thái trang...`);
    }

    let hasLoggedLoginPrompt = false;
    let hasLoggedReadyMessage = false;
    let cachedPageName = 'Trang Meta Business';
    const expectedPageId = CONFIG.FB_PAGE_ID;
    const cachedPageId = expectedPageId;
    let readConversationCursor = 0;

    // Main polling loop
    while (isRunning) {
      try {
        healthServer.recordMainLoopHeartbeat();

        // 1. Check current URL and asset_id binding strictly
        let actualAssetId = null;
        try {
          actualAssetId = new URL(page.url()).searchParams.get('asset_id');
        } catch (_) {}

        const assetMatch = Boolean(actualAssetId && expectedPageId && actualAssetId === expectedPageId);
        healthServer.updateState({
          expected_asset_id: expectedPageId,
          current_asset_id: actualAssetId,
          asset_match: assetMatch
        });

        const state = await withTimeout(detectPageState(page, expectedPageId), 8000, 'detectPageState').catch((err) => {
          log.warn(`detectPageState timeout hoặc lỗi: ${err.message}`);
          return APP_STATE.NAVIGATING;
        });

        if (state === APP_STATE.DISCONNECTED) {
          healthServer.updateState({ browser_connected: false, meta_inbox_state: 'DEGRADED' });
          log.warn('Trình duyệt đã bị đóng. Kết thúc tiến trình.');
          break;
        }

        if (state === APP_STATE.LOGIN_REQUIRED) {
          healthServer.updateState({ meta_inbox_state: 'LOGIN_REQUIRED', status: 'LOGIN_REQUIRED' });
          hasLoggedReadyMessage = false;
          if (!hasLoggedLoginPrompt) {
            log.auth('Phát hiện trang Đăng nhập Meta Business Suite.');
            log.auth('👉 Vui lòng nhấn "Đăng nhập bằng Facebook", nhập tài khoản và xử lý 2FA trên cửa sổ Chromium.');
            log.auth('Worker đang chờ và sẽ tự động bắt đầu quét Inbox ngay khi bạn đăng nhập thành công...');
            hasLoggedLoginPrompt = true;
          }
          await sleep(CONFIG.WAIT_FOR_LOGIN_INTERVAL_MS);
          continue;
        }

        if (state === APP_STATE.CHECKPOINT) {
          healthServer.updateState({ meta_inbox_state: 'CHECKPOINT', status: 'LOGIN_REQUIRED' });
          hasLoggedReadyMessage = false;
          log.warn('Phát hiện màn hình kiểm tra bảo mật (Checkpoint / 2FA). Vui lòng xác thực trên trình duyệt.');
          await sleep(CONFIG.WAIT_FOR_LOGIN_INTERVAL_MS);
          continue;
        }

        // Section 3: Do NOT silently rebind cachedPageId if redirected or wrong asset
        if (state === APP_STATE.WRONG_ASSET || !assetMatch) {
          healthServer.updateState({
            meta_inbox_state: 'WRONG_ASSET',
            status: 'DEGRADED',
            current_asset_id: actualAssetId,
            asset_match: false
          });
          hasLoggedReadyMessage = false;
          log.error(`[WRONG_ASSET] actual asset_id (${actualAssetId}) !== CONFIG.FB_PAGE_ID (${expectedPageId}). Chặn xử lý inbound và outbound!`);

          // Attempt explicit navigation back to CONFIG.INBOX_URL
          log.info(`[RECOVERY] Đang thử điều hướng lại về URL mục tiêu: ${CONFIG.INBOX_URL}`);
          try {
            await page.goto(CONFIG.INBOX_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAVIGATION_TIMEOUT_MS });
          } catch (navErr) {
            log.warn(`[RECOVERY] Lỗi khi điều hướng lại: ${navErr.message}`);
          }

          await sleep(CONFIG.STATE_CHECK_INTERVAL_MS);
          continue;
        }

        if (state === APP_STATE.INBOX_READY) {
          healthServer.updateState({
            meta_inbox_state: 'READY',
            status: 'HEALTHY',
            browser_connected: true,
            current_asset_id: actualAssetId,
            expected_asset_id: expectedPageId,
            asset_match: true
          });

          if (!hasLoggedReadyMessage) {
            log.success('Đã nhận diện Meta Business Suite Inbox thành công!');
            hasLoggedLoginPrompt = false;
            hasLoggedReadyMessage = true;
          }

          // Extract Page Name (safe, non-blocking)
          try {
            const pageName = await withTimeout(extractPageName(page), 5000, 'extractPageName');
            if (pageName && pageName !== 'Trang Meta Business') {
              cachedPageName = pageName;
            }
          } catch (_) {}

          // 0. Auto-dismiss any blocking promotional modals
          await withTimeout(
            page.evaluate(() => {
              const notNowBtn = Array.from(document.querySelectorAll('button, div[role="button"]'))
                .find(b => /^(Not now|Lúc khác|Bỏ qua|Đóng)$/i.test((b.innerText || '').trim()));
              if (notNowBtn) notNowBtn.click();
            }),
            3000,
            'dismissModal'
          ).catch(() => {});

          // ===================================================================
          // 1. OUTBOX QUEUE DISPATCH FIRST (Section 7: Inbound DOM scan must not block outbound)
          // ===================================================================
          // 1a. Reconcile orphan PROCESSING jobs (Phase 2B.1 Hardening)
          try {
            const orphanJobs = await claimOrphanJobs('fb_playwright_worker_01', 5);
            if (orphanJobs && orphanJobs.length > 0) {
              log.info(`[RECONCILIATION] Tìm thấy ${orphanJobs.length} orphan job cần đối soát...`);
              for (const orphanJob of orphanJobs) {
                const recResult = await reconcileOrphanOutboxJob(page, orphanJob);
                await resolveReconciledJob(
                  orphanJob.id,
                  recResult.resolution,
                  recResult.providerMessageId,
                  recResult.error
                );
              }
            }
          } catch (orphanErr) {
            log.warn(`Lỗi khi đối soát orphan jobs: ${orphanErr.message}`);
          }

          // 1b. Process Outbox Queue (Phase 2B: CRM Reply -> Worker -> Facebook)
          try {
            const pendingJobs = await claimOutboxJobs('fb_playwright_worker_01', 3);
            if (pendingJobs && pendingJobs.length > 0) {
              log.info(`[OUTBOX QUEUE] Nhận được ${pendingJobs.length} lệnh gửi phản hồi từ CRM...`);

              for (const job of pendingJobs) {
                const sendResult = await executeSendOutboxJob(page, job);

                if (sendResult.sessionRequired) {
                  healthServer.updateState({ meta_inbox_state: 'LOGIN_REQUIRED', status: 'LOGIN_REQUIRED' });
                  log.error(`[FACEBOOK_SESSION_REQUIRED] Dừng gửi tin nhắn do phiên đăng nhập Facebook hết hạn.`);
                  break;
                }

                if (sendResult.success) {
                  await completeOutboxJob(job.id, sendResult.providerMessageId);
                  healthServer.recordDeliverySuccess();
                  log.success(`[OUTBOX SUCCESS] ✅ Đã hoàn tất gửi tin nhắn và cập nhật trạng thái SENT cho Job ${job.id}`);
                } else {
                  await failOutboxJob(job.id, sendResult.error || 'Gửi thất bại', sendResult.isTransient !== false, 3);
                  log.warn(`[OUTBOX FAILED] Đã cập nhật trạng thái lỗi cho Job ${job.id}: ${sendResult.error}`);
                }
              }
            }
          } catch (outboxErr) {
            log.warn(`Lỗi khi xử lý outbox queue: ${outboxErr.message}`);
          }

          // ===================================================================
          // 2. INBOUND SCANNING SECOND (Bounded time budget & round-robin scan)
          // ===================================================================
          const scanResult = await performInboundScan(page, expectedPageId, cachedPageName, {
            scanTimeBudgetMs: SCAN_CONFIG.SCAN_TIME_BUDGET_MS,
            maxHeavyThreads: SCAN_CONFIG.MAX_HEAVY_THREADS_PER_CYCLE,
            readCursor: readConversationCursor
          });
          readConversationCursor = scanResult.nextReadCursor;

          // Wait before next poll cycle
          await sleep(CONFIG.POLL_INTERVAL_MS);
        } else {
          healthServer.updateState({ meta_inbox_state: state });
          await sleep(CONFIG.STATE_CHECK_INTERVAL_MS);
        }
      } catch (loopError) {
        if (
          loopError.message &&
          (loopError.message.includes('Target closed') ||
            loopError.message.includes('browser has been closed') ||
            loopError.message.includes('Target page, context or browser has been closed'))
        ) {
          log.warn('Trình duyệt đã bị đóng bởi người dùng hoặc hệ điều hành. Kết thúc tiến trình worker một cách an toàn.');
          break;
        }
        log.warn(`Lỗi trong chu kỳ quét: ${loopError.message}. Sẽ thử lại...`);
        await sleep(CONFIG.POLL_INTERVAL_MS);
      }
    }
  } catch (err) {
    log.error('Lỗi khởi động worker', err);
  } finally {
    await shutdown();
  }
}

const isDirectRun = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
if (isDirectRun) {
  main();
}
