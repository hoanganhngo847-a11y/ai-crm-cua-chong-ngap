import http from 'node:http';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { createAccountRegistry, splitAccountRecipient } from './account-supervisor.mjs';

const port = Number(process.env.PORT || 10000);
const legacyPort = 11000;
const companyId = process.env.ZCAJS_COMPANY_ID || '';
const secret = process.env.ZCAJS_WORKER_SECRET || '';
const crm = (process.env.ZCAJS_CRM_BASE_URL || '').replace(/\/$/, '');
const runtimeUrl = `${crm}/api/inbox/zalo-zcajs/accounts/runtime`;
const children = new Set();
let stopping = false;
let polling = null;
let legacyUid = null;
function launch(env, legacy = false) {
  const child = fork(new URL('./index.mjs', import.meta.url), [], { env, stdio: legacy ? 'inherit' : 'ignore', execArgv: ['--max-old-space-size=128'] });
  children.add(child); child.once('exit', () => children.delete(child));
  return child;
}
const legacy = launch({ ...process.env, PORT: String(legacyPort), ZCAJS_BIND_HOST: '127.0.0.1', ZCAJS_ACCOUNT_ID: '' }, true);
legacy.once('exit', () => { if (!stopping) { console.error('[ZCAJS manager] legacy process exited; requesting service restart'); shutdown(); } });
const registry = createAccountRegistry({ baseEnv: process.env, launch: (env) => launch(env) });
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok || body.success === false) throw new Error('ACCOUNT_RUNTIME_UNAVAILABLE');
  return body;
}
async function localHealth(childPort) { return jsonFetch(`http://127.0.0.1:${childPort}/health`, { signal: AbortSignal.timeout(2000) }); }
async function report(body) { return jsonFetch(runtimeUrl, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
async function reconcile() {
  if (polling) return polling;
  polling = (async () => {
    if (stopping) return;
    const health = await localHealth(legacyPort);
    if (health.providerUid && health.loggedIn) {
      await report({ accountId: null, status: 'CONNECTED', providerUid: health.providerUid });
      legacyUid = health.providerUid;
    }
    if (!legacyUid) throw new Error('LEGACY_ACCOUNT_NOT_READY');
    const config = await jsonFetch(runtimeUrl, { headers: { authorization: `Bearer ${secret}` } });
    if (config.companyId !== companyId) throw new Error('ACCOUNT_COMPANY_MISMATCH');
    registry.reconcile(config.accounts);
    await Promise.allSettled(registry.values().filter((slot) => slot.child).map(async (slot) => {
      const status = await localHealth(slot.port);
      if (status.loggedIn && status.listenerConnected && status.providerUid) {
        slot.connected = true;
        await report({ accountId: slot.id, revision: slot.revision, status: 'CONNECTED', providerUid: status.providerUid });
      }
    }));
  })().finally(() => { polling = null; });
  return polling;
}
function authorized(req) {
  const supplied = String(req.headers['x-worker-secret'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const actual = Buffer.from(supplied); const expected = Buffer.from(secret);
  return secret && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
    try {
      const health = await localHealth(legacyPort);
      const managed = await Promise.all(registry.values().map(async (slot) => { try { return await localHealth(slot.port); } catch { return null; } }));
      const ready = Boolean(health.loggedIn && health.listenerConnected && health.queueDurable);
      if (url.pathname === '/ready') return json(res, ready ? 200 : 503, { ready, listenerConnected: health.listenerConnected });
      return json(res, health.queueDurable ? 200 : 503, { ok: health.queueDurable, queueDurable: health.queueDurable,
        loggedIn: health.loggedIn, listenerConnected: health.listenerConnected,
        pendingInbound: (health.pendingInbound || 0) + managed.reduce((sum, h) => sum + (h?.pendingInbound || 0), 0),
        managedAccounts: registry.values().length, connectedManagedAccounts: managed.filter((h) => h?.loggedIn && h?.listenerConnected).length });
    } catch { return json(res, 503, { ok: false, ready: false }); }
  }
  if (!authorized(req)) return json(res, 401, { success: false, outcome: 'REJECTED', errorCode: 'UNAUTHORIZED' });
  if (!['/v1/send','/v1/send-media','/v1/contacts','/v1/group-details','/v1/resolve-phone'].includes(url.pathname)) return json(res, 404, { success: false });
  let body;
  if (req.method === 'POST') {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 30 * 1024 * 1024) return json(res, 413, { outcome: 'REJECTED', errorCode: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(res, 400, { outcome: 'REJECTED', errorCode: 'INVALID_BODY' }); }
  }
  let accountId = url.searchParams.get('accountId');
  if (body?.recipientZaloId) {
    const recipient = splitAccountRecipient(body.recipientZaloId);
    if (accountId && accountId !== recipient.accountId) return json(res, 400, { outcome: 'REJECTED', errorCode: 'ACCOUNT_SCOPE_MISMATCH' });
    accountId = recipient.accountId; body.recipientZaloId = recipient.peer;
  }
  let targetPort = legacyPort;
  if (accountId) {
    // Refresh authorization before every managed send; a paused or replaced
    // account can never fall back to the default Zalo sender.
    try { await reconcile(); } catch { return json(res, 503, { success: false, outcome: 'REJECTED', errorCode: 'ACCOUNT_RUNTIME_UNAVAILABLE' }); }
    const slot = registry.get(accountId);
    if (!slot?.child || slot.removed) return json(res, 409, { success: false, outcome: 'REJECTED', errorCode: 'ZALO_ACCOUNT_NOT_READY' });
    targetPort = slot.port;
  }
  url.searchParams.delete('accountId');
  try {
    const response = await fetch(`http://127.0.0.1:${targetPort}${url.pathname}${url.search}`, {
      method: req.method, headers: { 'content-type': 'application/json', 'x-worker-secret': secret },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(url.pathname === '/v1/send-media' ? 95000 : 30000),
    });
    const result = await response.json();
    if (accountId && result.outcome === 'ACCEPTED') {
      if (result.providerMessageId) result.providerMessageId = `account:${accountId}:${result.providerMessageId}`;
      if (result.providerMessageIds) result.providerMessageIds = result.providerMessageIds.map((id) => `account:${accountId}:${id}`);
    }
    return json(res, response.status, result);
  } catch { return json(res, 503, { success: false, outcome: 'UNCERTAIN', errorCode: 'WORKER_REQUEST_UNCERTAIN' }); }
}
const server = http.createServer((req, res) => { void handle(req, res).catch(() => json(res, 400, { success: false, outcome: 'REJECTED', errorCode: 'INVALID_ACCOUNT_REQUEST' })); });
server.listen(port, '0.0.0.0', () => console.log('[ZCAJS manager] ready for account configuration'));
const timer = setInterval(() => { void reconcile().catch(() => console.warn('[ZCAJS manager] account configuration temporarily unavailable')); }, 10000);
void reconcile().catch(() => {});
function shutdown() {
  if (stopping) return; stopping = true; clearInterval(timer); registry.stop();
  for (const child of children) child.kill('SIGTERM');
  server.close();
  const wait = setInterval(() => { if (!children.size) { clearInterval(wait); process.exit(0); } }, 100);
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(0); }, 10000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
