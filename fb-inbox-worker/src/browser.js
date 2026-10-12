import { chromium } from 'playwright';
import fs from 'fs';
import { CONFIG } from './config.js';
import { log } from './logger.js';

export async function createBrowserContext() {
  // Ensure user_data directory exists
  if (!fs.existsSync(CONFIG.USER_DATA_DIR)) {
    fs.mkdirSync(CONFIG.USER_DATA_DIR, { recursive: true });
    log.info(`Đã khởi tạo thư mục profile: ${CONFIG.USER_DATA_DIR}`);
  }

  log.info('Đang mở Chromium với persistent profile...');
  log.info(`Lưu session tại: ${CONFIG.USER_DATA_DIR}`);

  try {
    const context = await chromium.launchPersistentContext(CONFIG.USER_DATA_DIR, {
      ...CONFIG.BROWSER,
      // Provide user agent or standard settings to avoid immediate bot flags
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    });

    // Mask navigator.webdriver
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    // Handle pages
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Set reasonable navigation default
    page.setDefaultTimeout(CONFIG.NAVIGATION_TIMEOUT_MS);

    return { context, page };
  } catch (error) {
    if (error.message && error.message.includes('Process singleton')) {
      log.error('Thư mục profile đang bị khóa bởi một tiến trình trình duyệt khác. Hãy tắt các cửa sổ Chromium worker cũ và thử lại.');
    }
    throw error;
  }
}
