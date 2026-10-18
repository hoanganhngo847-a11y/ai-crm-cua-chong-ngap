import assert from 'node:assert/strict';
import fs from 'node:fs';

const endpoint = fs.readFileSync('app/api/inbox/zalo-zcajs/dispatch/route.ts', 'utf8');
const poller = fs.readFileSync('zalo-zcajs-worker/src/dispatch-loop.mjs', 'utf8');
const dockerfile = fs.readFileSync('zalo-zcajs-worker/Dockerfile', 'utf8');

assert.match(
  endpoint,
  /dispatchPendingZaloDeliveries\(companyId/,
  'CRM dispatch endpoint must drain the canonical Zalo durable outbox.'
);
assert.match(
  endpoint,
  /ZALO_ZCAJS_WORKER_SECRET/,
  'CRM dispatch endpoint must require the server-side worker secret.'
);
assert.match(
  endpoint,
  /ZALO_ZCAJS_COMPANY_ID/,
  'CRM dispatch endpoint must derive company ownership from server configuration.'
);
assert.match(
  poller,
  /127\.0\.0\.1:\$\{PORT\}\/ready/,
  'Worker poller must wait for the local ZCAJS session to be ready before draining outbound messages.'
);
assert.match(
  poller,
  /\/api\/inbox\/zalo-zcajs\/dispatch/,
  'Worker poller must trigger the authenticated CRM dispatch endpoint.'
);
assert.match(
  dockerfile,
  /node src\/dispatch-loop\.mjs & exec node src\/index\.mjs/,
  'Docker image must run the durable outbound poller alongside the ZCAJS listener.'
);

console.log('[PASS] ZCAJS durable outbound dispatch wiring is present.');
