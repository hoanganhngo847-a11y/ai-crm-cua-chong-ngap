import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  createStringeeClientToken,
  isAllowedCrmStringeeAgentUserId,
  toStringeeSaleUserId,
  toStringeeTestUserIds,
  isStringeeTestPair,
  buildStringeeConnectScco,
} from '../features/voice/providers/stringee-provider';

console.log('--- CRM Recorded Voice Routing Regression ---');

const userUuid = '11111111-2222-4333-8444-555555555555';
const stringeeUserId = toStringeeSaleUserId(userUuid, 'tenant-a');
assert.match(stringeeUserId, /^crm_s_[A-Za-z0-9_-]{22}$/);
assert.ok(stringeeUserId.length <= 30);
assert.equal(stringeeUserId, toStringeeSaleUserId(userUuid, 'tenant-a'));
assert.equal(stringeeUserId.includes(userUuid.replaceAll('-', '')), false);
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
const plainScco = buildStringeeConnectScco({ action: 'connect' }, false, 'https://crm.example/events');
assert.deepEqual(plainScco, [{ action: 'connect', peerToPeerCall: true }]);
const recordedScco = buildStringeeConnectScco({ action: 'connect' }, true, 'https://crm.example/events');
assert.deepEqual(recordedScco, [
  { action: 'record', format: 'mp3', eventUrl: 'https://crm.example/events' },
  { action: 'connect', peerToPeerCall: false },
]);
assert.notEqual(stringeeUserId, toStringeeSaleUserId(userUuid, 'tenant-b'));
const pair = toStringeeTestUserIds(userUuid, 'tenant-a');
assert.ok(pair.A.length <= 30 && pair.B.length <= 30);
assert.throws(() => createStringeeClientToken('SK_test', 'secret', `crm_sale_${'a'.repeat(32)}`), /Invalid Stringee user id/);
assert.notEqual(pair.A, pair.B);
assert.notEqual(pair.A, stringeeUserId);
assert.equal(isStringeeTestPair(pair.A, pair.B, pair.A), true);
assert.equal(isStringeeTestPair(pair.A, pair.B, pair.B), false);
assert.equal(isStringeeTestPair(pair.A, pair.A, pair.A), false);
assert.equal(isStringeeTestPair(pair.A, toStringeeTestUserIds(userUuid, 'tenant-b').B, pair.A), false);
assert.equal(isStringeeTestPair(pair.A, '+84901234567', pair.A), false);
assert.match(routeSource, /isStringeeTestPair/);
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
