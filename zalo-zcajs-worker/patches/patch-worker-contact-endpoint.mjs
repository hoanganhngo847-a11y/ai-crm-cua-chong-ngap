import fs from 'node:fs';

const file = 'src/index.mjs';
let source = fs.readFileSync(file, 'utf8');

const importAnchor = "import { normalizeDirectMessage } from './message-normalizer.mjs';";
const importLine = "import { listPersonalZaloContacts } from './contact-directory.mjs';";
if (!source.includes(importAnchor)) throw new Error('worker contact patch import anchor missing');
if (!source.includes(importLine)) {
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const handlerAnchor = 'function requestHandler(req, res) {';
const handlerBlock = `async function handleContacts(req, res, url) {
  if (!isAuthorized(req)) {
    return json(res, 401, { success: false, error: 'UNAUTHORIZED' });
  }
  const requestedCompany = String(url.searchParams.get('companyId') || '').trim();
  if (!requestedCompany || requestedCompany !== COMPANY_ID) {
    return json(res, 403, { success: false, error: 'COMPANY_MISMATCH' });
  }
  if (!api || !loggedIn) {
    return json(res, 503, { success: false, error: 'ZCAJS_NOT_LOGGED_IN' });
  }
  try {
    const contacts = await listPersonalZaloContacts(api);
    return json(res, 200, { success: true, companyId: COMPANY_ID, contacts });
  } catch (error) {
    console.warn('[ZCAJS] contact directory read failed:', error instanceof Error ? error.message : 'unknown');
    return json(res, 502, { success: false, error: 'CONTACT_DIRECTORY_FAILED' });
  }
}

`;
if (!source.includes(handlerAnchor)) throw new Error('worker contact patch handler anchor missing');
if (!source.includes('async function handleContacts(req, res, url)')) {
  source = source.replace(handlerAnchor, `${handlerBlock}${handlerAnchor}`);
}

const routeAnchor = "  if (req.method === 'POST' && url.pathname === '/v1/send-media') {";
const routeBlock = `  if (req.method === 'GET' && url.pathname === '/v1/contacts') {
    void handleContacts(req, res, url);
    return;
  }

`;
if (!source.includes(routeAnchor)) throw new Error('worker contact patch route anchor missing');
if (!source.includes("url.pathname === '/v1/contacts'")) {
  source = source.replace(routeAnchor, `${routeBlock}${routeAnchor}`);
}

fs.writeFileSync(file, source, 'utf8');
