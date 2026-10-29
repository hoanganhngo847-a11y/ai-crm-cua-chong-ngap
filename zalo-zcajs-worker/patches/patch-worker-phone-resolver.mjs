import fs from 'node:fs';

const file = 'src/index.mjs';
let source = fs.readFileSync(file, 'utf8');

const importAnchor = "import { normalizeZaloMessage } from './message-normalizer.mjs';";
const importLine = "import { resolveExactZaloPhone } from './phone-resolver.mjs';";
if (!source.includes(importAnchor)) throw new Error('worker phone resolver import anchor missing');
if (!source.includes(importLine)) {
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const handlerAnchor = 'function requestHandler(req, res) {';
const handlerBlock = `const phoneResolverCache = new Map();
const PHONE_RESOLVER_POSITIVE_TTL_MS = 60_000;
const PHONE_RESOLVER_NEGATIVE_TTL_MS = 10_000;

async function handleResolvePhone(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { success: false, error: 'UNAUTHORIZED' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return json(res, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, {
      success: false,
      error: 'INVALID_PAYLOAD',
    });
  }

  if (!body || body.companyId !== COMPANY_ID) {
    return json(res, 403, { success: false, error: 'COMPANY_MISMATCH' });
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!/^[0-9]{5,40}$/.test(userId)) {
    return json(res, 400, { success: false, error: 'INVALID_USER_ID' });
  }
  if (!api || !loggedIn || typeof api.getUserInfo !== 'function') {
    return json(res, 503, { success: false, error: 'ZCAJS_NOT_LOGGED_IN' });
  }

  const cached = phoneResolverCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.phone
      ? json(res, 200, { success: true, phone: cached.phone })
      : json(res, 404, { success: false, error: 'PHONE_NOT_AVAILABLE' });
  }
  if (cached) phoneResolverCache.delete(userId);

  try {
    const userInfo = await api.getUserInfo(userId);
    const phone = resolveExactZaloPhone(userInfo, userId);
    phoneResolverCache.set(userId, {
      phone,
      expiresAt: Date.now() + (phone ? PHONE_RESOLVER_POSITIVE_TTL_MS : PHONE_RESOLVER_NEGATIVE_TTL_MS),
    });
    if (!phone) {
      return json(res, 404, { success: false, error: 'PHONE_NOT_AVAILABLE' });
    }
    return json(res, 200, { success: true, phone });
  } catch {
    return json(res, 502, { success: false, error: 'PROFILE_LOOKUP_FAILED' });
  }
}

`;
if (!source.includes(handlerAnchor)) throw new Error('worker phone resolver handler anchor missing');
if (!source.includes('async function handleResolvePhone(req, res)')) {
  source = source.replace(handlerAnchor, `${handlerBlock}${handlerAnchor}`);
}

const routeAnchor = "  if (req.method === 'POST' && url.pathname === '/v1/send-media') {";
const routeBlock = `  if (req.method === 'POST' && url.pathname === '/v1/resolve-phone') {
    void handleResolvePhone(req, res);
    return;
  }

`;
if (!source.includes(routeAnchor)) throw new Error('worker phone resolver route anchor missing');
if (!source.includes("url.pathname === '/v1/resolve-phone'")) {
  source = source.replace(routeAnchor, `${routeBlock}${routeAnchor}`);
}

fs.writeFileSync(file, source, 'utf8');
