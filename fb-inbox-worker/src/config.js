import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple .env parser to avoid extra dependency
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

export const CONFIG = {
  // URLs
  INBOX_URL: `https://business.facebook.com/latest/inbox/all/?asset_id=${process.env.FB_PAGE_ID || '1389294167596309'}`,
  FALLBACK_INBOX_URL: 'https://business.facebook.com/latest/inbox/all',

  // Persistent User Data Directory (saves login cookies, local storage & session on persistent disk)
  USER_DATA_DIR: process.env.FB_PROFILE_DIR || process.env.USER_DATA_DIR || path.resolve(__dirname, '../user_data'),
  FB_PROFILE_DIR: process.env.FB_PROFILE_DIR || process.env.USER_DATA_DIR || path.resolve(__dirname, '../user_data'),

  // Node Gateway & Health Monitoring Server (Phase 3 Production Operations)
  PORT: parseInt(process.env.PORT || process.env.HEALTH_PORT || '3099', 10),
  HEALTH_PORT: parseInt(process.env.PORT || process.env.HEALTH_PORT || '3099', 10),
  HEALTH_HOST: process.env.HEALTH_HOST || '0.0.0.0',

  // Render Setup Gateway Configuration (Requirement 4, 5, 6)
  ENABLE_SETUP_UI: process.env.ENABLE_SETUP_UI === 'true',
  SETUP_MODE_SECRET: process.env.SETUP_MODE_SECRET || '',
  INTERNAL_VNC_PORT: parseInt(process.env.INTERNAL_VNC_PORT || '5900', 10),
  INTERNAL_WEBSOCKIFY_PORT: parseInt(process.env.INTERNAL_WEBSOCKIFY_PORT || '6080', 10),

  // CRM Sync Configuration (Requirement 1: Exact Inbound Endpoint)
  CRM_SYNC_ENDPOINT: process.env.CRM_SYNC_ENDPOINT || 'https://ai-crm-cua-chong-ngap.onrender.com/api/inbox/browser-sync',
  FB_WORKER_SECRET: process.env.FB_WORKER_SECRET || '',
  FB_PAGE_ID: process.env.FB_PAGE_ID || '1389294167596309',
  CRM_COMPANY_ID: process.env.CRM_COMPANY_ID || '00000000-0000-0000-0000-000000000001',
  MESSAGE_TRACE: process.env.FB_MESSAGE_TRACE === 'true',

  // Polling & intervals (ms)
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
  NAVIGATION_TIMEOUT_MS: parseInt(process.env.NAVIGATION_TIMEOUT_MS || '45000', 10),
  WAIT_FOR_LOGIN_INTERVAL_MS: 3000,
  STATE_CHECK_INTERVAL_MS: 2000,

  // Browser launch configuration
  BROWSER: {
    headless: process.env.ENABLE_SETUP_UI === 'true' ? false : (process.env.HEADLESS !== 'false'),
    viewport: { width: 1440, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--start-maximized'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  },

  // State detection keywords & regexes
  PATTERNS: {
    LOGIN_PATH: /(\/login|\/login\.php|\/loginpage|\/business\/loginpage)/i,
    CHECKPOINT_PATH: /(\/checkpoint|\/security|\/two_step_verification)/i,
    INBOX_PATH: /^\/latest\/inbox/i,
    UNREAD_TEXT: /chưa đọc|unread/i
  }
};
