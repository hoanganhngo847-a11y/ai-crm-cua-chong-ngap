import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  createStringeeClientToken,
  isAllowedCrmStringeeAgentUserId,
  toStringeeSaleUserId,
} from '../features/voice/providers/stringee-provider';

console.log('--- CRM Recorded Voice Routing Regression ---');

const userUuid = '11111111-2222-4333-8444-555555555555';
const stringeeUserId = toStringeeSaleUserId(userUuid);
assert.equal(stringeeUserId, 'crm_sale_11111111222243338444555555555555');
assert.equal(isAllowedCrmStringeeAgentUserId(stringeeUserId), true);
assert.equal(isAllowedCrmStringeeAgentUserId('attacker-controlled-user'), false);

const token = createStringeeClientToken('SK_test', 'secret', stringeeUserId, 1_700_000_000);
const parts = token.split('.');
assert.equal(parts.length, 3);
const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
assert.equal(payload.iss, 'SK_test');
assert.equal(payload.userId, stringeeUserId);
assert.equal(payload.rest_api, undefined);
assert.equal(payload.exp, 1_700_003_600);

const routeSource = readFileSync('app/api/webhooks/voice/[routingToken]/route.ts', 'utf8');
const recordIndex = routeSource.indexOf("action: 'record'");
const connectIndex = routeSource.indexOf("action: 'connect'");
assert.ok(recordIndex >= 0, 'record action must exist');
assert.ok(connectIndex >= 0, 'connect action must exist');
assert.ok(recordIndex < connectIndex, 'record action must be emitted before connect');
assert.match(routeSource, /peerToPeerCall:\s*false/);
assert.match(routeSource, /isAllowedCrmStringeeAgentUserId/);

const tokenRouteSource = readFileSync('app/api/voice/client-token/route.ts', 'utf8');
assert.match(tokenRouteSource, /requireActiveMember/);
assert.match(tokenRouteSource, /CALL_PROVIDER_NOT_CONFIGURED/);
assert.match(tokenRouteSource, /Cache-Control': 'no-store, private'/);
assert.doesNotMatch(tokenRouteSource, /apiSecret\s*[:,]\s*integration\.apiSecret/);

const buttonSource = readFileSync('app/(dashboard)/calls/components/CallToCustomerButton.tsx', 'utf8');
assert.match(buttonSource, /GỌI & GHI ÂM/);
assert.match(buttonSource, /\/api\/voice\/client-token/);
assert.match(buttonSource, /getUserMedia\(\{ audio: true, video: false \}\)/);
assert.match(buttonSource, /incomingcall2/);
assert.match(buttonSource, /callCustomerViaVoiceAction/);
assert.doesNotMatch(buttonSource, /customerPhone/);

console.log('✓ Recorded SCCO, per-sale token, zero-phone browser boundary, and softphone wiring passed.');
