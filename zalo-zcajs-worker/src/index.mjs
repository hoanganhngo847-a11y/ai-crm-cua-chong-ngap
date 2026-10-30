import crypto from 'crypto';
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Zalo, MessageType } from 'zca-js';
import { normalizeZaloMessage } from './message-normalizer.mjs';
import { createInboundDelivery } from './inbound-delivery.mjs';
import { createGroupDirectory } from './group-directory.mjs';

const PORT = Number(process.env.PORT || 10000);
const ACCOUNT_ID = (process.env.ZCAJS_ACCOUNT_ID || '').trim();
const ACCOUNT_REVISION = Number(process.env.ZCAJS_ACCOUNT_REVISION || 0);
let accountVerified = !ACCOUNT_ID;
const pendingVerification = [];
const COMPANY_ID = (process.env.ZCAJS_COMPANY_ID || '').trim();
const CRM_BASE_URL = (process.env.ZCAJS_CRM_BASE_URL || '').trim().replace(/\/$/, '');
const WORKER_SECRET = process.env.ZCAJS_WORKER_SECRET || '';
const COOKIE_RAW = process.env.ZCAJS_COOKIE || '';
const IMEI = process.env.ZCAJS_IMEI || '';
const USER_AGENT = process.env.ZCAJS_USER_AGENT || '';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MEDIA_BODY_BYTES = 30 * 1024 * 1024;
const MAX_MEDIA_FILES = 5;
const MAX_MEDIA_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_TOTAL_BYTES = 20 * 1024 * 1024;
const CRM_ECHO_WINDOW_MS = 30_000;
const RECENT_PROVIDER_ID_TTL_MS = 10 * 60_000;

let api = null;
let loggedIn = false;
let listenerConnected = false;
let listenerRestartAttempt = 0;
let listenerRestartTimer = null;
let loginLoopRunning = false;
let inboundDelivery = null;

const groupDirectory = createGroupDirectory();

// Used only to suppress the self-listener echo created by a CRM-originated send.
// Manual messages sent directly in Zalo are not placed in these maps and are forwarded to CRM.
const pendingCrmSends = new Map();
const recentCrmProviderMsgIds = new Map();

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

async function readJson(req, maxBodyBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) throw new Error('BODY_TOO_LARGE');
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

function pruneCrmEchoTracking(now = Date.now()) {
  for (const [key, value] of pendingCrmSends.entries()) {
    if (now - value.startedAt > CRM_ECHO_WINDOW_MS) pendingCrmSends.delete(key);
  }
  for (const [providerMsgId, expiresAt] of recentCrmProviderMsgIds.entries()) {
    if (expiresAt <= now) recentCrmProviderMsgIds.delete(providerMsgId);
  }
}

function shouldSuppressCrmSelfEcho(message) {
  if (!message?.isSelf || message.direction !== 'outbound') return false;
  const now = Date.now();
  pruneCrmEchoTracking(now);

  if (recentCrmProviderMsgIds.has(message.messageId)) return true;

  // Group messages are rendered with a "Bạn:" author prefix; strip it so a
  // CRM-originated group send is still recognized before its msgId is recorded.
  const contentWithoutGroupPrefix = message.isGroup && message.content.startsWith('Bạn:')
    ? message.content.slice('Bạn:'.length).replace(/^\r?\n/, '').trim()
    : message.content;

  for (const pending of pendingCrmSends.values()) {
    const sameText =
      pending.text === message.content ||
      (message.isGroup && pending.text === contentWithoutGroupPrefix);
    if (
      pending.recipientZaloId === message.externalUserId &&
      sameText &&
      now - pending.startedAt <= CRM_ECHO_WINDOW_MS
    ) {
      return true;
    }
  }
  return false;
}

async function reportAccountState(status, providerUid, errorCode) {
  if (!ACCOUNT_ID) return;
  const response = await fetch(`${CRM_BASE_URL}/api/inbox/zalo-zcajs/accounts/runtime`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_SECRET}` },
    body: JSON.stringify({ accountId: ACCOUNT_ID, revision: ACCOUNT_REVISION, status, providerUid, errorCode }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw new Error(result.error || 'ACCOUNT_VERIFICATION_FAILED');
}

async function postInbound(payload) {
  if (ACCOUNT_ID) payload = { ...payload, accountId: ACCOUNT_ID };
  if (!inboundDelivery) {
    inboundDelivery = createInboundDelivery({
      crmBaseUrl: CRM_BASE_URL,
      workerSecret: WORKER_SECRET,
      preparePayload: enrichInbound,
    });
  }
  return inboundDelivery.deliver(payload);
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

async function enrichInbound(normalized) {
  if (normalized.isGroup && normalized.groupId && api) {
    const details = await groupDirectory.get(api, normalized.groupId);
    if (details) {
      if (details.groupName) normalized.groupName = details.groupName;
      if (details.totalMember !== undefined) normalized.totalMember = details.totalMember;
      if (details.avatar) normalized.groupAvatar = details.avatar;
      normalized.groupMembers = details.members;
      normalized.membersComplete = details.membersComplete;
      normalized.groupFetchedAt = details.fetchedAt;
      const sender = details.members.find((member) => member.id === normalized.senderId);
      if (sender?.name) normalized.senderDisplayName = sender.name;
    }
  }
  return normalized;
}

function attachListener(currentApi) {
  currentApi.listener.on('connected', () => {
    listenerConnected = true;
    listenerRestartAttempt = 0;
    console.log('[ZCAJS] listener connected');
    void reportAccountState('CONNECTED', String(currentApi.getOwnId())).catch(() => {});
  });

  currentApi.listener.on('closed', () => {
    listenerConnected = false;
    console.warn('[ZCAJS] listener closed; scheduling reconnect');
    void reportAccountState('ERROR', undefined, 'LISTENER_DISCONNECTED').catch(() => {});
    scheduleListenerRestart();
  });

  currentApi.listener.on('error', (error) => {
    console.error('[ZCAJS] listener error:', error instanceof Error ? error.message : 'unknown');
  });

  currentApi.listener.on('group_event', (event) => {
    const id = event.threadId || event.data?.groupId;
    if (id) groupDirectory.invalidate(id);
  });

  currentApi.listener.on('message', (message) => {
    const normalized = normalizeZaloMessage(message);
    if (!normalized) return;
    if (shouldSuppressCrmSelfEcho(normalized)) return;
    if (!accountVerified) { pendingVerification.push(normalized); return; }
    void postInbound(normalized).catch((error) => {
      console.error(
        '[ZCAJS] inbound post failed:',
        error instanceof Error ? error.message : 'unknown'
      );
    });
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
          selfListen: true,
          checkUpdate: false,
        }
      );
      const currentApi = await zalo.login();
      api = currentApi;
      loggedIn = true;
      attachListener(currentApi);
      // Verify the real Zalo UID before opening another WebSocket. This stops
      // duplicate credentials from kicking the existing account's listener.
      await reportAccountState('CONNECTING', String(currentApi.getOwnId()));
      accountVerified = true;
      for (const buffered of pendingVerification.splice(0)) void postInbound(buffered);
      currentApi.listener.start();
      console.log('[ZCAJS] login succeeded; listener starting');
      break;
    } catch (error) {
      if (ACCOUNT_ID) {
        const allowed = ['DUPLICATE_ZALO_ACCOUNT','ZALO_ACCOUNT_IDENTITY_CHANGED','ZALO_LEGACY_NOT_READY'];
        const code = allowed.includes(error?.message) ? error.message : 'LOGIN_FAILED';
        await reportAccountState('ERROR', undefined, code).catch(() => {});
        process.exit(1);
      }
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

function resolveZaloThread(recipient) {
  const raw = String(recipient || '').trim();
  const groupMatch = /^group:([0-9]{5,40})$/.exec(raw);
  if (groupMatch) {
    return { threadId: groupMatch[1], messageType: MessageType.GroupMessage };
  }
  return { threadId: raw, messageType: MessageType.DirectMessage };
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

  const pendingKey = crypto.randomUUID();
  pendingCrmSends.set(pendingKey, {
    recipientZaloId,
    text,
    startedAt: Date.now(),
  });

  try {
    const { threadId, messageType } = resolveZaloThread(recipientZaloId);
    const result = await api.sendMessage({ msg: text }, threadId, messageType);
    const providerMessageId = String(result?.message?.msgId ?? '').trim();
    if (!providerMessageId) {
      return json(res, 502, {
        outcome: 'UNCERTAIN',
        errorCode: 'MISSING_PROVIDER_MSG_ID',
        errorMessage: 'ZCAJS returned without a stable Zalo message id.',
      });
    }

    recentCrmProviderMsgIds.set(providerMessageId, Date.now() + RECENT_PROVIDER_ID_TTL_MS);
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
  } finally {
    pendingCrmSends.delete(pendingKey);
    pruneCrmEchoTracking();
  }
}

function extensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'audio/mpeg') return '.mp3';
  if (mime === 'application/pdf') return '.pdf';
  return '';
}

function safeMediaFilename(name, mimeType, index) {
  const raw = path.basename(String(name || `attachment-${index + 1}`));
  const sanitized = raw.replace(/[^a-zA-Z0-9._()\- ]+/g, '_').replace(/\.{2,}/g, '.').slice(0, 120);
  const existingExt = path.extname(sanitized);
  const fallbackExt = extensionForMime(mimeType);
  return sanitized || `attachment-${index + 1}${fallbackExt || '.bin'}`;
}

function decodeBase64File(value) {
  if (typeof value !== 'string' || !value) throw new Error('INVALID_BASE64');
  const normalized = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error('INVALID_BASE64');
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) throw new Error('EMPTY_FILE');
  return buffer;
}

async function handleSendMedia(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, {
      outcome: 'REJECTED',
      errorCode: 'UNAUTHORIZED',
      errorMessage: 'Worker authentication failed.',
    });
  }

  let body;
  try {
    body = await readJson(req, MAX_MEDIA_BODY_BYTES);
  } catch (error) {
    return json(res, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, {
      outcome: 'REJECTED',
      errorCode: 'INVALID_MEDIA_PAYLOAD',
      errorMessage: 'Media request body is invalid.',
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
  const files = Array.isArray(body.files) ? body.files : [];

  if (!recipientZaloId || files.length === 0 || files.length > MAX_MEDIA_FILES) {
    return json(res, 400, {
      outcome: 'REJECTED',
      errorCode: 'INVALID_ARGUMENT',
      errorMessage: 'recipientZaloId and 1-5 files are required.',
    });
  }
  if (!api || !loggedIn) {
    return json(res, 503, {
      outcome: 'REJECTED',
      errorCode: 'ZCAJS_NOT_LOGGED_IN',
      errorMessage: 'Zalo session is not ready.',
    });
  }

  let totalBytes = 0;
  const decoded = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const item = files[index] || {};
      const buffer = decodeBase64File(item.dataBase64);
      if (buffer.length > MAX_MEDIA_FILE_BYTES) throw new Error('FILE_TOO_LARGE');
      totalBytes += buffer.length;
      if (totalBytes > MAX_MEDIA_TOTAL_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
      decoded.push({
        name: safeMediaFilename(item.name, item.mimeType, index),
        mimeType: String(item.mimeType || 'application/octet-stream'),
        buffer,
      });
    }
  } catch (error) {
    return json(res, 413, {
      outcome: 'REJECTED',
      errorCode: error instanceof Error ? error.message : 'INVALID_MEDIA_FILE',
      errorMessage: 'One or more media files are invalid or too large.',
    });
  }

  let tempDir;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-media-'));
    const localPaths = [];
    for (let index = 0; index < decoded.length; index += 1) {
      const item = decoded[index];
      let fileName = item.name;
      if (!path.extname(fileName)) fileName += extensionForMime(item.mimeType) || '.bin';
      const localPath = path.join(tempDir, `${index}-${fileName}`);
      await fs.writeFile(localPath, item.buffer, { flag: 'wx' });
      localPaths.push(localPath);
    }

    // Deliberately do not register this send in the text echo-suppression maps.
    // The self-listener event contains Zalo's canonical CDN/attachment payload, which
    // the CRM needs in order to render the sent media in the unified timeline.
    const { threadId, messageType } = resolveZaloThread(recipientZaloId);
    const result = await api.sendMessage(
      { msg: text || '', attachments: localPaths },
      threadId,
      messageType
    );

    const providerMessageIds = [
      result?.message?.msgId,
      ...(Array.isArray(result?.attachment) ? result.attachment.map((item) => item?.msgId) : []),
    ]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);

    if (providerMessageIds.length === 0) {
      return json(res, 502, {
        outcome: 'UNCERTAIN',
        errorCode: 'MISSING_PROVIDER_MSG_ID',
        errorMessage: 'ZCAJS returned without stable media message ids.',
      });
    }

    return json(res, 200, {
      outcome: 'ACCEPTED',
      providerMessageIds,
    });
  } catch (error) {
    return json(res, 502, {
      outcome: 'UNCERTAIN',
      errorCode: 'ZCAJS_MEDIA_SEND_ERROR',
      errorMessage: error instanceof Error ? error.message : 'ZCAJS media send failed.',
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function handleGroupDetails(req, res, url) {
  if (!isAuthorized(req)) {
    return json(res, 401, { success: false, error: 'UNAUTHORIZED' });
  }
  if (url.searchParams.get('companyId') !== COMPANY_ID) {
    return json(res, 403, { success: false, error: 'COMPANY_MISMATCH' });
  }
  const groupId = String(url.searchParams.get('groupId') || '').trim();
  if (!/^[0-9]{5,40}$/.test(groupId)) {
    return json(res, 400, { success: false, error: 'INVALID_GROUP_ID' });
  }
  if (!api || !loggedIn) {
    return json(res, 503, { success: false, error: 'ZCAJS_NOT_LOGGED_IN' });
  }
  try {
    const details = await groupDirectory.get(api, groupId, { force: url.searchParams.get('refresh') === '1' });
    return json(res, details ? 200 : 502, { success: Boolean(details), group: details || null });
  } catch (error) {
    return json(res, 502, { success: false, error: 'GROUP_LOOKUP_FAILED' });
  }
}

function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    const queueDurable = !inboundDelivery?.persistenceError();
    return json(res, queueDurable ? 200 : 503, {
      ok: queueDurable,
      queueDurable,
      loggedIn,
      providerUid: api && loggedIn ? String(api.getOwnId()) : null,
      listenerConnected,
      pendingInbound: inboundDelivery?.pendingCount?.() ?? 0,
    });
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    const ready = Boolean(api && loggedIn && listenerConnected && !inboundDelivery?.persistenceError());
    return json(res, ready ? 200 : 503, {
      ready,
      listenerConnected,
    });
  }

  if (req.method === 'GET' && url.pathname === '/v1/group-details') {
    void handleGroupDetails(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/send-media') {
    void handleSendMedia(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/send') {
    void handleSend(req, res);
    return;
  }

  return json(res, 404, { error: 'NOT_FOUND' });
}

requireConfig();

inboundDelivery = createInboundDelivery({
  crmBaseUrl: CRM_BASE_URL,
  workerSecret: WORKER_SECRET,
  preparePayload: enrichInbound,
});
const recoveryReady = inboundDelivery.resume().catch((error) => {
  console.error(
    '[ZCAJS] inbound queue recovery failed:',
    error instanceof Error ? error.message : 'unknown'
  );
});

const server = http.createServer(requestHandler);
server.listen(PORT, process.env.ZCAJS_BIND_HOST || '0.0.0.0', () => {
  console.log(`[ZCAJS] worker listening on port ${PORT}`);
  void recoveryReady.then(() => loginLoop());
});

function shutdown(signal) {
  console.log(`[ZCAJS] received ${signal}; shutting down`);
  if (listenerRestartTimer) clearTimeout(listenerRestartTimer);
  inboundDelivery?.stop();
  server.close(() => { void inboundDelivery?.flush().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
