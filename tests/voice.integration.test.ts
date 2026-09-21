import { createHmac } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { StringeeProvider, createStringeeRestToken } from '../features/voice/providers/stringee-provider';
import {
  normalizeVoiceWebhookPayload,
  verifyWebhookSignature,
} from '../features/voice/services/webhook-processor';
import { normalizeVietnamPhoneToE164 } from '../features/voice/utils/phone';
import { getVoiceMediaRetryDelayMs } from '../features/voice/services/media-pipeline';

async function runTests() {
  assert.equal(normalizeVietnamPhoneToE164('090 123 45 67'), '+84901234567');
  assert.equal(normalizeVietnamPhoneToE164('0084901234567'), '+84901234567');
  assert.equal(normalizeVietnamPhoneToE164('not-a-phone'), null);

  const jwt = createStringeeRestToken('SK_test', 'secret', 1_700_000_000);
  const [header, payload, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'HS256');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).rest_api, true);
  assert.ok(signature.length > 20);

  process.env.VOICE_PROVIDER = 'STRINGEE';
  process.env.VOICE_WEBHOOK_SECRET = 'signing-secret';
  const rawBody = '{"call_status":"ended"}';
  const signed = createHmac('sha1', 'signing-secret').update(rawBody).digest('base64');
  assert.equal(verifyWebhookSignature(new Headers({ 'x-stringee-signature': signed }), rawBody), true);
  assert.equal(verifyWebhookSignature(new Headers({ 'x-stringee-signature': 'invalid' }), rawBody), false);

  const busy = normalizeVoiceWebhookPayload({
    event: '', call_status: 'ended', call_id: 'call-vn-test-12345678',
    endCallCause: '486 Busy Here', answerDuration: 0,
  });
  assert.equal(busy.status, 'busy');
  const answered = normalizeVoiceWebhookPayload({
    event: '', call_status: 'ended', call_id: 'call-vn-test-12345678',
    endCallCause: 'USER_END_CALL', answerDuration: 35,
  });
  assert.equal(answered.status, 'completed');

  process.env.STRINGEE_FROM_NUMBER = '84281234567';
  process.env.STRINGEE_ANSWER_URL = 'https://crm.example/api/webhooks/voice';
  process.env.STRINGEE_SALE_AGENT_USER_ID = 'sale-agent';
  let outboundBody = '';
  const fakeFetch: typeof fetch = async (_input, init) => {
    outboundBody = String(init?.body || '');
    return new Response(JSON.stringify({ r: 0 }), { status: 200 });
  };
  const provider = new StringeeProvider('SK_test', 'secret', fakeFetch);
  const result = await provider.initiateCall({
    fromStaffUserId: 'staff-1', targetRawPhone: '+84901234567',
    customerId: 'customer-1', companyId: 'company-1',
  });
  assert.deepEqual(Object.keys(result).sort(), ['providerCallId', 'status']);
  assert.equal(JSON.stringify(result).includes('+84901234567'), false);
  assert.equal(outboundBody.includes('+84901234567'), true);
  assert.equal(outboundBody.includes('crmCorrelationId'), true);

  assert.equal(getVoiceMediaRetryDelayMs(1), 30_000);
  assert.equal(getVoiceMediaRetryDelayMs(2), 60_000);
  assert.equal(getVoiceMediaRetryDelayMs(20), 3_600_000);
  console.log('✓ voice integration scenarios passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
