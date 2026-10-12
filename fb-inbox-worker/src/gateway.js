import crypto from 'crypto';
import http from 'http';
import net from 'net';
import { CONFIG } from './config.js';
import { log } from './logger.js';

class SetupGateway {
  constructor() {
    this.activeSessions = new Map(); // token -> expiresAt (timestamp)
    this.browserPage = null; // Reference to active Playwright page for manual controls
  }

  setBrowserPage(page) {
    this.browserPage = page;
  }

  // Parse Cookie header
  parseCookies(req) {
    const list = {};
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return list;

    cookieHeader.split(';').forEach((cookie) => {
      let [name, ...rest] = cookie.split('=');
      name = name.trim();
      if (!name) return;
      const value = rest.join('=').trim();
      list[name] = decodeURIComponent(value);
    });
    return list;
  }

  // Validate session token from cookie
  isValidSession(req) {
    if (!CONFIG.ENABLE_SETUP_UI) return false;
    const cookies = this.parseCookies(req);
    const token = cookies.fb_setup_session;
    if (!token) return false;

    const expiresAt = this.activeSessions.get(token);
    if (!expiresAt) return false;

    if (Date.now() > expiresAt) {
      this.activeSessions.delete(token);
      return false;
    }

    // Slide expiration window if active (max 30 mins)
    this.activeSessions.set(token, Date.now() + 30 * 60 * 1000);
    return true;
  }

  // Handle incoming HTTP requests
  async handleRequest(req, res, healthSnapshot) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // Requirement 6: When ENABLE_SETUP_UI is false, all /setup routes are strictly 404
    if (!CONFIG.ENABLE_SETUP_UI) {
      if (pathname.startsWith('/setup')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'SETUP_UI_DISABLED', message: 'Setup UI is disabled in production.' }));
        return true;
      }
      return false;
    }

    // 1. GET /setup -> Login Form or Redirect to Viewer
    if (pathname === '/setup' && method === 'GET') {
      if (this.isValidSession(req)) {
        res.writeHead(302, { Location: '/setup/viewer' });
        res.end();
        return true;
      }

      const loginHtml = this.renderLoginForm();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(loginHtml);
      return true;
    }

    // 2. POST /setup/auth -> Authenticate with SETUP_MODE_SECRET (Requirement 5)
    if (pathname === '/setup/auth' && method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let secret = '';
        try {
          if (req.headers['content-type']?.includes('application/json')) {
            const data = JSON.parse(body);
            secret = data.secret || data.passcode || '';
          } else {
            const params = new URLSearchParams(body);
            secret = params.get('secret') || params.get('passcode') || '';
          }
        } catch (_) {}

        if (!CONFIG.SETUP_MODE_SECRET || secret !== CONFIG.SETUP_MODE_SECRET) {
          log.warn('[GATEWAY] Yêu cầu xác thực /setup/auth thất bại (sai secret).');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Mã xác thực Setup không chính xác.' }));
          return;
        }

        // Issue one-time secure session token with short TTL (30 mins)
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const ttlMs = 30 * 60 * 1000;
        this.activeSessions.set(sessionToken, Date.now() + ttlMs);

        log.info('[GATEWAY] Xác thực /setup/auth thành công. Cấp cookie HttpOnly fb_setup_session.');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `fb_setup_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`,
        });
        res.end(JSON.stringify({ success: true, redirect: '/setup/viewer' }));
      });
      return true;
    }

    // 3. GET /setup/logout -> Clear Session
    if (pathname === '/setup/logout') {
      const cookies = this.parseCookies(req);
      if (cookies.fb_setup_session) {
        this.activeSessions.delete(cookies.fb_setup_session);
      }
      res.writeHead(302, {
        Location: '/setup',
        'Set-Cookie': 'fb_setup_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
      });
      res.end();
      return true;
    }

    // 4. GET /setup/viewer -> Interactive noVNC Host & Status Panel
    if (pathname === '/setup/viewer' && method === 'GET') {
      if (!this.isValidSession(req)) {
        res.writeHead(302, { Location: '/setup' });
        res.end();
        return true;
      }

      const viewerHtml = this.renderViewerPage(healthSnapshot);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(viewerHtml);
      return true;
    }

    // 5. POST /setup/reload-page -> Trigger Chromium page reload
    if (pathname === '/setup/reload-page' && method === 'POST') {
      if (!this.isValidSession(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
        return true;
      }

      if (this.browserPage) {
        this.browserPage.reload().catch(() => {});
        log.info('[GATEWAY] Người dùng yêu cầu reload trang Chromium từ Setup Viewer.');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return true;
    }

    // 6. GET /setup/novnc/* -> Proxy static files from internal websockify/noVNC HTTP (localhost:6080)
    if (pathname.startsWith('/setup/novnc/')) {
      if (!this.isValidSession(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized: setup session required');
        return true;
      }

      const internalPath = pathname.replace('/setup/novnc', '') || '/vnc.html';
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: CONFIG.INTERNAL_WEBSOCKIFY_PORT,
          path: internalPath + (parsedUrl.search || ''),
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Internal noVNC Proxy Error: ${err.message}`);
      });

      req.pipe(proxyReq);
      return true;
    }

    return false;
  }

  // Handle WebSocket Upgrade (Requirement 4 & 5: Proxy to localhost:6080 only with valid cookie)
  handleUpgrade(req, socket, head) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Reject all WebSocket upgrades if ENABLE_SETUP_UI is false
    if (!CONFIG.ENABLE_SETUP_UI) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Check valid path
    if (!pathname.startsWith('/setup/ws') && !pathname.startsWith('/websockify')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Verify HttpOnly cookie authentication
    if (!this.isValidSession(req)) {
      log.warn('[GATEWAY] Từ chối kết nối WebSocket noVNC: Cookie phiên không hợp lệ hoặc đã hết hạn.');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Proxy WebSocket stream to internal websockify (127.0.0.1:6080)
    const proxySocket = net.connect(CONFIG.INTERNAL_WEBSOCKIFY_PORT, '127.0.0.1', () => {
      // Re-send original HTTP upgrade request to local websockify
      let headersStr = `${req.method} /websockify HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === 'host') {
          headersStr += `Host: 127.0.0.1:${CONFIG.INTERNAL_WEBSOCKIFY_PORT}\r\n`;
        } else {
          headersStr += `${key}: ${value}\r\n`;
        }
      }
      headersStr += '\r\n';

      proxySocket.write(headersStr);
      if (head && head.length > 0) {
        proxySocket.write(head);
      }

      socket.pipe(proxySocket);
      proxySocket.pipe(socket);
    });

    proxySocket.on('error', (err) => {
      log.warn(`[GATEWAY] Lỗi kết nối WebSocket tới nội bộ websockify (127.0.0.1:${CONFIG.INTERNAL_WEBSOCKIFY_PORT}): ${err.message}`);
      socket.destroy();
    });

    socket.on('error', () => {
      proxySocket.destroy();
    });
  }

  renderLoginForm() {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Setup Gateway - Meta Business Suite Worker</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .icon {
      width: 48px;
      height: 48px;
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.2);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--primary);
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 1.5rem; }
    .form-group { margin-bottom: 1.25rem; }
    label { display: block; font-size: 0.8125rem; font-weight: 500; margin-bottom: 0.5rem; color: #d1d5db; }
    input[type="password"] {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #030712;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.15s ease;
    }
    input[type="password"]:focus {
      border-color: var(--primary);
    }
    button {
      width: 100%;
      padding: 0.75rem;
      background: var(--primary);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    button:hover { background: var(--primary-hover); }
    .error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: #fca5a5;
      padding: 0.75rem;
      border-radius: 8px;
      font-size: 0.8125rem;
      margin-bottom: 1rem;
      display: none;
    }
    .info-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.75rem;
      background: rgba(59, 130, 246, 0.1);
      color: #93c5fd;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <div class="info-badge">🔒 Bảo mật Setup Mode (Render Web Service)</div>
    <h1>Xác thực Quyền Quản trị</h1>
    <p>Nhập mã bí mật <code>SETUP_MODE_SECRET</code> để mở giao diện Chromium tương tác và hoàn tất đăng nhập Facebook lần đầu.</p>

    <div id="errorBox" class="error"></div>

    <form id="authForm">
      <div class="form-group">
        <label for="secret">Setup Passcode / Secret</label>
        <input type="password" id="secret" name="secret" required placeholder="Nhập chuỗi bảo mật..." autocomplete="off">
      </div>
      <button type="submit" id="submitBtn">Xác thực & Mở Trình duyệt</button>
    </form>
  </div>

  <script>
    const form = document.getElementById('authForm');
    const errorBox = document.getElementById('errorBox');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang xác thực...';

      const secret = document.getElementById('secret').value;
      try {
        const res = await fetch('/setup/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          window.location.href = data.redirect || '/setup/viewer';
        } else {
          errorBox.innerText = data.error || 'Xác thực thất bại.';
          errorBox.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.innerText = 'Xác thực & Mở Trình duyệt';
        }
      } catch (err) {
        errorBox.innerText = 'Lỗi kết nối tới máy chủ.';
        errorBox.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.innerText = 'Xác thực & Mở Trình duyệt';
      }
    });
  </script>
</body>
</html>`;
  }

  renderViewerPage(healthSnapshot) {
    const state = healthSnapshot?.meta_inbox_state || 'UNKNOWN';
    const status = healthSnapshot?.status || 'UNKNOWN';
    const memoryRss = healthSnapshot?.memory?.rss_mb || 0;

    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Setup Viewer - Meta Business Suite Chromium</title>
  <style>
    :root {
      --bg: #0b0f19;
      --bar-bg: #111827;
      --border: #1f2937;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --primary: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .topbar {
      background: var(--bar-bg);
      border-bottom: 1px solid var(--border);
      padding: 0.75rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
      z-index: 10;
    }
    .left-section {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .brand {
      font-weight: 700;
      font-size: 0.9375rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      border: 1px solid var(--border);
      background: #030712;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--warning);
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 0.625rem;
    }
    .btn {
      padding: 0.45rem 0.85rem;
      font-size: 0.8125rem;
      font-weight: 600;
      border-radius: 6px;
      border: 1px solid var(--border);
      cursor: pointer;
      background: #1f2937;
      color: #fff;
      transition: all 0.15s ease;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
    }
    .btn:hover { background: #374151; }
    .btn-primary { background: var(--primary); border-color: var(--primary); }
    .btn-primary:hover { background: #2563eb; }
    .btn-danger { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.3); }
    .instructions {
      background: #0f172a;
      border-bottom: 1px solid var(--border);
      padding: 0.5rem 1.25rem;
      font-size: 0.75rem;
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .container {
      flex: 1;
      position: relative;
      background: #000;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="left-section">
      <div class="brand">
        <span>🌐 Meta Inbox Chromium</span>
      </div>
      <div class="status-pill" id="statusPill">
        <span class="status-dot" id="statusDot"></span>
        <span id="stateText">${state}</span>
      </div>
      <div style="font-size: 0.75rem; color: var(--text-muted);">
        RAM: <strong id="ramText">${memoryRss} MB</strong>
      </div>
    </div>
    <div class="actions">
      <button class="btn" onclick="reloadChromiumPage()">🔄 Tải lại trang FB</button>
      <button class="btn" onclick="refreshStatus()">📊 Check Status</button>
      <a href="/setup/logout" class="btn btn-danger">Đăng xuất</a>
    </div>
  </div>

  <div class="instructions">
    <span>💡 <strong>Hướng dẫn:</strong> Tự đăng nhập tài khoản Facebook & xử lý 2FA trên cửa sổ dưới đây. Profile sẽ được lưu vào Persistent Disk. Sau khi vào Inbox, hãy đặt <code>ENABLE_SETUP_UI=false</code> trên Render để chạy Headless 24/7.</span>
    <span>Persistent Profile: <code>/var/data/fb-user-data</code></span>
  </div>

  <div class="container">
    <iframe src="/setup/novnc/vnc.html?autoconnect=true&path=setup/ws&resize=scale" title="Chromium Virtual Display"></iframe>
  </div>

  <script>
    async function refreshStatus() {
      try {
        const res = await fetch('/health');
        const data = await res.json();
        document.getElementById('stateText').innerText = data.meta_inbox_state || 'UNKNOWN';
        document.getElementById('ramText').innerText = (data.memory?.rss_mb || 0) + ' MB';
        
        const dot = document.getElementById('statusDot');
        if (data.meta_inbox_state === 'READY' || data.meta_inbox_state === 'INBOX_READY') {
          dot.style.background = '#10b981';
        } else if (data.meta_inbox_state === 'LOGIN_REQUIRED' || data.meta_inbox_state === 'CHECKPOINT') {
          dot.style.background = '#f59e0b';
        } else {
          dot.style.background = '#ef4444';
        }
      } catch (_) {}
    }

    async function reloadChromiumPage() {
      try {
        await fetch('/setup/reload-page', { method: 'POST' });
        setTimeout(refreshStatus, 2000);
      } catch (_) {}
    }

    // Auto poll status every 5 seconds
    setInterval(refreshStatus, 5000);
  </script>
</body>
</html>`;
  }
}

export const setupGateway = new SetupGateway();
