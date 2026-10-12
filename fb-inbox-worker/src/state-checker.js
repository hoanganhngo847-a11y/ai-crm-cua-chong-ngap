import { CONFIG } from './config.js';
import { log } from './logger.js';

export const APP_STATE = {
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CHECKPOINT: 'CHECKPOINT',
  INBOX_READY: 'INBOX_READY',
  NAVIGATING: 'NAVIGATING',
  DISCONNECTED: 'DISCONNECTED',
  UNKNOWN: 'UNKNOWN'
};

export async function detectPageState(page) {
  try {
    const rawUrl = page.url();
    let pathname = '';
    try {
      pathname = new URL(rawUrl).pathname;
    } catch (_) {
      pathname = rawUrl;
    }

    // Check for checkpoint / 2FA / security challenges
    if (CONFIG.PATTERNS.CHECKPOINT_PATH.test(pathname) || /checkpoint|two_step_verification/i.test(rawUrl)) {
      return APP_STATE.CHECKPOINT;
    }

    // Check for explicit login URLs
    if (CONFIG.PATTERNS.LOGIN_PATH.test(pathname)) {
      return APP_STATE.LOGIN_REQUIRED;
    }

    // Check DOM for login form or login buttons
    const loginStatus = await page.evaluate(() => {
      // Inputs
      const emailInput = document.querySelector('input#email, input[name="email"], input[type="email"]');
      const passInput = document.querySelector('input#pass, input[name="pass"], input[type="password"]');
      if (emailInput || passInput) {
        return { isLogin: true, reason: 'Có ô nhập email/mật khẩu' };
      }

      // Check for prominent Login with Facebook buttons on Meta Business Suite landing page
      const buttonsAndLinks = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      for (const el of buttonsAndLinks) {
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (/^(Đăng nhập|Log In|Sign In|Đăng nhập bằng Facebook|Log in with Facebook)$/i.test(text)) {
          return { isLogin: true, reason: `Phát hiện nút: "${text}"` };
        }
      }

      // Check if page title indicates login
      if (/đăng nhập|log in/i.test(document.title)) {
        return { isLogin: true, reason: 'Tiêu đề trang là Đăng nhập' };
      }

      return { isLogin: false };
    }).catch(() => ({ isLogin: false }));

    if (loginStatus.isLogin) {
      return APP_STATE.LOGIN_REQUIRED;
    }

    // Check for Inbox UI ready
    if (CONFIG.PATTERNS.INBOX_PATH.test(pathname)) {
      const isInboxRendered = await page.evaluate(() => {
        // Look for inbox-specific indicators
        const hasInboxNav = Boolean(
          document.querySelector(
            '[aria-label*="Hộp thư"], [aria-label*="Inbox"], [data-testid*="inbox"], [role="navigation"]'
          )
        );
        const hasConversations = Boolean(
          document.querySelector('[role="listitem"], [role="row"], div[data-virtualized]')
        );
        const hasSearch = Boolean(
          document.querySelector('input[placeholder*="Tìm kiếm"], input[placeholder*="Search"]')
        );
        return hasInboxNav || hasConversations || hasSearch;
      }).catch(() => false);

      if (isInboxRendered) {
        return APP_STATE.INBOX_READY;
      }
      return APP_STATE.NAVIGATING;
    }

    return APP_STATE.NAVIGATING;
  } catch (error) {
    if (error.message && error.message.includes('Target page, context or browser has been closed')) {
      return APP_STATE.DISCONNECTED;
    }
    return APP_STATE.UNKNOWN;
  }
}
