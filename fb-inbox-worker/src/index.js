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
const syncedFingerprints = new Set();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function processThreadData(threadData, cachedPageId, cachedPageName) {
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

    // Requirement 5 & 6: INBOUND handling
    if (msg.direction === 'INBOUND') {
      const fingerprint = msg.fingerprint;

      if (!syncedFingerprints.has(fingerprint)) {
        syncedFingerprints.add(fingerprint);

        // Requirement 6: Log safe information
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

        if (syncResult.success) {
          healthServer.recordScanSuccess();
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
          log.warn(`  • Trạng thái sync CRM: THAT_BAI (${syncResult.error})`);
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
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
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
    let cachedPageId = CONFIG.FB_PAGE_ID;

    // Main polling loop
    while (isRunning) {
      try {
        healthServer.recordMainLoopHeartbeat();
        const state = await withTimeout(detectPageState(page), 8000, 'detectPageState').catch((err) => {
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

        if (state === APP_STATE.INBOX_READY) {
          healthServer.updateState({ meta_inbox_state: 'READY', status: 'HEALTHY', browser_connected: true });
          const currentTitle = await page.title().catch(() => '');

          if (!hasLoggedReadyMessage) {
            log.success('Đã nhận diện Meta Business Suite Inbox thành công!');
            hasLoggedLoginPrompt = false;
            hasLoggedReadyMessage = true;
          }

          // Extract Page Name & Page ID
          try {
            const pageName = await withTimeout(extractPageName(page), 5000, 'extractPageName');
            if (pageName && pageName !== 'Trang Meta Business') {
              cachedPageName = pageName;
            }
          } catch (_) {}

          // Try getting page ID from URL
          try {
            const urlParams = new URLSearchParams(new URL(page.url()).search);
            const assetId = urlParams.get('asset_id');
            if (assetId) cachedPageId = assetId;
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
          // 2. INBOUND SCANNING SECOND (Bounded timeout on each Playwright step)
          // ===================================================================
          try {
            // 2a. Inspect active open thread in viewport
            const activeThreadData = await withTimeout(
              extractActiveThreadMessages(page, cachedPageId),
              8000,
              'extractActiveThreadMessages'
            );
            if (activeThreadData && activeThreadData.messages && activeThreadData.messages.length > 0) {
              await processThreadData(activeThreadData, cachedPageId, cachedPageName);
            }
          } catch (inboundErr) {
            log.warn(`[INBOUND SCAN] Không thể trích xuất active thread: ${inboundErr.message}`);
          }

          try {
            // 2b. Scan conversation list for unread messages
            const conversations = await withTimeout(
              extractConversationsList(page),
              8000,
              'extractConversationsList'
            );

            if (conversations && conversations.length > 0) {
              for (let i = 0; i < Math.min(conversations.length, 5); i++) {
                const convItem = conversations[i];
                if (convItem.isUnread) {
                  await withTimeout(selectConversation(page, i), 5000, `selectConversation(${i})`).catch(() => false);
                  await sleep(1500);

                  const threadData = await withTimeout(
                    extractActiveThreadMessages(page, cachedPageId),
                    8000,
                    'extractActiveThreadMessages'
                  ).catch(() => null);
                  if (threadData) {
                    await processThreadData(threadData, cachedPageId, cachedPageName);
                  }
                }
              }
            }
          } catch (scanErr) {
            log.warn(`[CONVERSATION SCAN] Lỗi khi quét danh sách hội thoại: ${scanErr.message}`);
          }

          // Wait before next poll cycle
          await sleep(CONFIG.POLL_INTERVAL_MS);
        } else {
          healthServer.updateState({ meta_inbox_state: state });
          await sleep(CONFIG.STATE_CHECK_INTERVAL_MS);
        }
      } catch (loopError) {
        if (loopError.message && loopError.message.includes('Target closed')) {
          log.warn('Trình duyệt đã bị đóng bởi người dùng.');
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

main();
