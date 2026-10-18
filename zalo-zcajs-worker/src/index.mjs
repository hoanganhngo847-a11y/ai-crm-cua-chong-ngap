import crypto from 'crypto';
import http from 'http';
import { Zalo, MessageType } from 'zca-js';

const PORT = Number(process.env.PORT || 10000);
const COMPANY_ID = (process.env.ZCAJS_COMPANY_ID || '').trim();
const CRM_BASE_URL = (process.env.ZCAJS_CRM_BASE_URL || '').trim().replace(/\/$/, '');
const WORKER_SECRET = process.env.ZCAJS_WORKER_SECRET || '';
const COOKIE_RAW = process.env.ZCAJS_COOKIE || '';
const IMEI = process.env.ZCAJS_IMEI || '';
const USER_AGENT = process.env.ZCAJS_USER_AGENT || '';
const INBOUND_MAX_RETRIES = 6;
const MAX_BODY_BYTES = 64 * 1024;

let api = null;
let loggedIn = false;
let listenerConnected = false;
let listenerRestartAttempt = 0;
let listenerRestartTimer = null;
let loginLoopRunning = false;

function requireConfig() {
  const missing = [];
  if (!COMPANY_ID) missing.push('ZCAJS_COMPANY_ID');
  if (!CRM_BASE_URL) missing.push('ZCAJS_CRM_BASE_URL');
  if (!WORKER_SECRET) missing.push('ZCAJS_WORKER_SECRET');
  if (!COOKIE_RAW) missing.push('ZCAJS_COOKIE');
  if (!IMEI) missing.push('ZCAJS_IMEI');
  if (!USER_AGENT) missing.push('ZCAJS_USER_AGENT');
  if (missing.length) {
    throw new Error(`Missing required worker configuration: ${missing.join(', ')}`);
  }

  const crmUrl = new URL(CRM_BASE_URL);
  if (process.env.NODE_ENV === 'production' && crmUrl.protocol !== 'https:') {
    throw new Error('ZCAJS_CRM_BASE_URL must use HTTPS in production.');
  }
}

function parseCookie(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && Array.isArray(parsed.cookies)) return parsed;
  } catch {
    // Fall through to plain cookie mode. Never log the cookie value.
  }
  return raw;
}

function secureCompare(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isAuthorized(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const workerHeader = String(req.headers['x-worker-secret'] || '');
  const provided = workerHeader || bearer;
  return Boolean(provided) && secureCompare(provided, WORKER_SECRET);
}

function normalizeTimestamp(raw) {
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function normalizeDirectMessage(message) {
  if (!message || message.type !== MessageType.DirectMessage || message.isSelf) return null;
  const content = message.data?.content;
  if (typeof content !== 'string' || !content.trim()) return null;

  const messageId = String(
    message.data?.msgId || message.data?.realMsgId || message.data?.cliMsgId || ''
  ).trim();
  const externalUserId = String(message.threadId || message.data?.uidFrom || '').trim();
  if (!messageId || !externalUserId) return null;

  return {
    messageId,
    externalUserId,
    senderName: String(message.data?.dName || '').trim() || undefined,
    content: content.trim(),
    timestamp: normalizeTimestamp(message.data?.ts),
  };
}

async function postInbound(payload, attempt = 0) {
  try {
    const response = await fetch(`${CRM_BASE_URL}/api/inbox/zalo-zcajs/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_SECRET}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return;
    throw new Error(`CRM_HTTP_${response.status}`);
  } catch (error) {
    if (attempt >= INBOUND_MAX_RETRIES - 1) {
      console.error('[ZCAJS] inbound delivery exhausted retries:', error instanceof Error ? error.message : 'unknown');
      return;
    }
    const delayMs = Math.min(60_000, 1000 * 2 ** attempt);
    setTimeout(() => void postInbound(payload, attempt + 1), delayMs);
  }
}

function scheduleListenerRestart() {
  if (!api || listenerRestartTimer) return;
  const delayMs = Math.min(60_000, 1500 * 2 ** Math.min(listenerRestartAttempt, 5));
  listenerRestartAttempt += 1;
  listenerRestartTimer = setTimeout(() => {
    listenerRestartTimer = null;
    if (!api) return;
    try {
      api.listener.start();
    } catch (error) {
      console.error('[ZCAJS] listener restart failed:', error instanceof Error ? error.message : 'unknown');
      scheduleListenerRestart();
    }
  }, delayMs);
}

function attachListener(currentApi) {
  currentApi.listener.on('connected', () => {
    listenerConnected = true;
    listenerRestartAttempt = 0;
    console.log('[ZCAJS] listener connected');
  });

  currentApi.listener.on('closed', () => {
    listenerConnected = false;
    console.warn('[ZCAJS] listener closed; scheduling reconnect');
    scheduleListenerRestart();
  });

  currentApi.listener.on('error', (error) => {
    console.error('[ZCAJS] listener error:', error instanceof Error ? error.message : 'unknown');
  });

  currentApi.listener.on('message', (message) => {
    const normalized = normalizeDirectMessage(message);
    if (!normalized) return;
    void postInbound(normalized);
  });
}

async function loginLoop() {
  if (loginLoopRunning) return;
  loginLoopRunning = true;
  let attempt = 0;

  while (!api) {
    try {
      const zalo = new Zalo(
        {
          cookie: parseCookie(COOKIE_RAW),
          imei: IMEI,
          userAgent: USER_AGENT,
        },
        {
          selfListen: false,
          checkUpdate: false,
        }
      );
      const currentApi = await zalo.login();
      api = currentApi;
      loggedIn = true;
      attachListener(currentApi);
      currentApi.listener.start();
      console.log('[ZCAJS] login succeeded; listener starting');
      break;
    } catch (error) {
      loggedIn = false;
      api = null;
      const delayMs = Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5));
      attempt += 1;
      console.error('[ZCAJS] login failed; retrying:', error instanceof Error ? error.message : 'unknown');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  loginLoopRunning = false;
}

async function handleSend(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, {
      outcome: 'REJECTED',
      errorCode: 'UNAUTHORIZED',
      errorMessage: 'Worker authentication failed.',
    });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return json(res, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, {
      outcome: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      errorMessage: 'Request body is invalid.',
    });
  }

  if (!body || body.companyId !== COMPANY_ID) {
    return json(res, 403, {
      outcome: 'REJECTED',
      errorCode: 'COMPANY_MISMATCH',
      errorMessage: 'Worker is not configured for this company.',
    });
  }

  const recipientZaloId = typeof body.recipientZaloId === 'string' ? body.recipientZaloId.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!recipientZaloId || !text) {
    return json(res, 400, {
      outcome: 'REJECTED',
      errorCode: 'INVALID_ARGUMENT',
      errorMessage: 'recipientZaloId and text are required.',
    });
  }

  if (!api || !loggedIn) {
    return json(res, 503, {
      outcome: 'REJECTED',
      errorCode: 'ZCAJS_NOT_LOGGED_IN',
      errorMessage: 'Zalo session is not ready.',
    });
  }

  try {
    const result = await api.sendMessage({ msg: text }, recipientZaloId, MessageType.DirectMessage);
    const providerMessageId = String(result?.message?.msgId ?? '').trim();
    if (!providerMessageId) {
      return json(res, 502, {
        outcome: 'UNCERTAIN',
        errorCode: 'MISSING_PROVIDER_MSG_ID',
        errorMessage: 'ZCAJS returned without a stable Zalo message id.',
      });
    }

    return json(res, 200, {
      outcome: 'ACCEPTED',
      providerMessageId,
    });
  } catch (error) {
    // Once sendMessage starts, an exception can be ambiguous. Never auto-resend this request.
    return json(res, 502, {
      outcome: 'UNCERTAIN',
      errorCode: 'ZCAJS_SEND_ERROR',
      errorMessage: error instanceof Error ? error.message : 'ZCAJS send failed.',
    });
  }
}

function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      loggedIn,
      listenerConnected,
    });
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    return json(res, api && loggedIn ? 200 : 503, {
      ready: Boolean(api && loggedIn),
      listenerConnected,
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/send') {
    void handleSend(req, res);
    return;
  }

  return json(res, 404, { error: 'NOT_FOUND' });
}

requireConfig();

const server = http.createServer(requestHandler);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ZCAJS] worker listening on port ${PORT}`);
  void loginLoop();
});

function shutdown(signal) {
  console.log(`[ZCAJS] received ${signal}; shutting down`);
  if (listenerRestartTimer) clearTimeout(listenerRestartTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
