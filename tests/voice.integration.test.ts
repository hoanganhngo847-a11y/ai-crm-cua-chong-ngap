import { createHmac } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { StringeeProvider, createStringeeRestToken } from '../features/voice/providers/stringee-provider';
import {
  normalizeVoiceWebhookPayload,
  verifyWebhookSignature,
} from '../features/voice/services/webhook-processor';
import { normalizeVietnamPhoneToE164 } from '../features/voice/utils/phone';
import {
  getVoiceMediaFailureOutcome,
  getVoiceMediaRetryDelayMs,
} from '../features/voice/services/media-pipeline';
import { calculateRetryScheduledAt } from '../features/voice/services/call-attempt-scheduler';

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
  const noAnswer = normalizeVoiceWebhookPayload({
    event: '', call_status: 'ended', call_id: 'call-vn-test-12345679',
    endCallCause: '480 Temporarily Unavailable', answerDuration: 0,
  });
  assert.equal(noAnswer.status, 'no_answer');
  const failed = normalizeVoiceWebhookPayload({
    event: '', call_status: 'ended', call_id: 'call-vn-test-12345670',
    endCallCause: 'CAN_NOT_MAKE_CALL', answerDuration: 0,
  });
  assert.equal(failed.status, 'failed');

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
  assert.deepEqual(getVoiceMediaFailureOutcome(0, 5), {
    attempts: 1, terminal: false, nextRunDelayMs: 30_000,
  });
  assert.deepEqual(getVoiceMediaFailureOutcome(4, 5), {
    attempts: 5, terminal: true, nextRunDelayMs: 480_000,
  });

  const beforeVietnamMidnight = new Date('2026-09-21T16:30:00.000Z'); // 23:30 ICT
  assert.equal(calculateRetryScheduledAt(beforeVietnamMidnight, 2), '2026-09-21T19:00:00.000Z');
  assert.equal(calculateRetryScheduledAt(beforeVietnamMidnight, 3), '2026-09-22T02:00:00.000Z');
  const afterVietnamMidnight = new Date('2026-09-21T18:00:00.000Z'); // 01:00 ICT Sep 22
  assert.equal(calculateRetryScheduledAt(afterVietnamMidnight, 3), '2026-09-23T02:00:00.000Z');

  const mediaMigration = readFileSync('supabase/migrations/20260921000001_voice_media_pipeline.sql', 'utf8');
  assert.match(mediaMigration, /'call-recordings',[\s\S]*?false/);
  assert.match(mediaMigration, /uq_call_attempts_one_pending_per_customer/);
  assert.match(mediaMigration, /REVOKE ALL ON TABLE public\.voice_media_jobs FROM PUBLIC, anon, authenticated/);
  const realtimeMigration = readFileSync('supabase/migrations/20260921000002_openai_realtime.sql', 'utf8');
  assert.match(realtimeMigration, /event_id text PRIMARY KEY/);
  assert.match(realtimeMigration, /INTAKE_EXTRACTION/);
  assert.match(realtimeMigration, /get_call_transcript_for_voice_worker/);
  assert.match(realtimeMigration, /REVOKE ALL ON TABLE public\.openai_realtime_events FROM PUBLIC, anon, authenticated/);
  const hardeningMigration = readFileSync('supabase/migrations/20260922000001_voice_security_hardening.sql', 'utf8');
  assert.match(hardeningMigration, /voice_provider_integrations/);
  assert.match(hardeningMigration, /uq_calls_tenant_provider_call/);
  assert.match(hardeningMigration, /start_voice_contact_cycle/);
  assert.match(hardeningMigration, /complete_voice_attempt_transition/);
  assert.match(hardeningMigration, /actor_type, reason, source_ref/);
  assert.match(hardeningMigration, /resolve_or_create_hotline_customer/);
  assert.match(hardeningMigration, /pg_advisory_xact_lock/);
  assert.match(hardeningMigration, /VOICE_TRANSCRIPT_TENANT_MISMATCH/);
  assert.match(hardeningMigration, /VOICE_CONTACT_TENANT_MISMATCH/);
  assert.match(hardeningMigration, /claim_voice_attempt_phone/);
  assert.match(hardeningMigration, /claim_voice_media_jobs/);
  const realtimeRoute = readFileSync('app/api/webhooks/openai-realtime/[routingToken]/route.ts', 'utf8');
  assert.ok(realtimeRoute.indexOf('webhooks.unwrap') < realtimeRoute.indexOf('const { error: insertError }'));
  assert.doesNotMatch(realtimeRoute, /sip_headers/);
  assert.doesNotMatch(realtimeRoute, /COMPANY_ID_DEFAULT/);
  const stringeeRoute = readFileSync('app/api/webhooks/voice/[routingToken]/route.ts', 'utf8');
  assert.match(stringeeRoute, /providerAccountId/);
  assert.doesNotMatch(stringeeRoute, /COMPANY_ID_DEFAULT/);
  const webhookProcessor = readFileSync('features/voice/services/webhook-processor.ts', 'utf8');
  assert.match(webhookProcessor, /\.eq\('company_id', companyId\)[\s\S]*?\.eq\('provider', provider\)[\s\S]*?\.eq\('provider_call_id', providerCallId\)/);
  assert.doesNotMatch(webhookProcessor, /updateFields\.recording_ref/);
  const dispatcher = readFileSync('features/voice/services/call-dispatcher.ts', 'utf8');
  assert.match(dispatcher, /claim_voice_attempt_phone/);
  assert.doesNotMatch(dispatcher, /schema\('private'\)/);
  const searchComponent = readFileSync('app/(dashboard)/calls/components/CustomerCallSearch.tsx', 'utf8');
  assert.doesNotMatch(searchComponent, /raw_phone|normalized_phone|phoneNumber/);
  console.log('✓ voice integration scenarios passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
