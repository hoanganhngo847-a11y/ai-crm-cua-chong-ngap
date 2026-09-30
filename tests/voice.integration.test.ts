import { createHmac } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { StringeeProvider, createStringeeRestToken } from '../features/voice/providers/stringee-provider';
import {
  normalizeVoiceWebhookPayload,
  verifyWebhookSignature,
  processCallStatusUpdate,
  processInboundCall,
  updateCallRecordingRef,
} from '../features/voice/services/webhook-processor';
import { normalizeVietnamPhoneToE164 } from '../features/voice/utils/phone';
import {
  getVoiceMediaFailureOutcome,
  getVoiceMediaRetryDelayMs,
} from '../features/voice/services/media-pipeline';
import {
  calculateRetryScheduledAt,
} from '../features/voice/services/call-attempt-scheduler';
import { dispatchAiOutboundCall } from '../features/voice/services/call-dispatcher';
import { createAdminClient } from '../lib/supabase/admin';
import { ServerAuthError } from '../lib/server-auth/errors';
import type { CallProvider } from '../shared/contracts/sensitive';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.PHONE_IDENTITY_HMAC_SECRET = process.env.PHONE_IDENTITY_HMAC_SECRET || 'test-phone-identity-secret-32-chars-long';

async function runTests() {
  console.log('--- 1. Pure Unit & Helper Tests ---');

  // Phone normalization
  assert.equal(normalizeVietnamPhoneToE164('090 123 45 67'), '+84901234567');
  assert.equal(normalizeVietnamPhoneToE164('0084901234567'), '+84901234567');
  assert.equal(normalizeVietnamPhoneToE164('not-a-phone'), null);

  // Stringee JWT token generation
  const jwt = createStringeeRestToken('SK_test', 'secret', 1_700_000_000);
  const [header, payload, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'HS256');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).rest_api, true);
  assert.ok(signature.length > 20);

  // Webhook signature verification
  process.env.VOICE_PROVIDER = 'STRINGEE';
  process.env.VOICE_WEBHOOK_SECRET = 'signing-secret';
  const rawBody = '{"call_status":"ended"}';
  const signed = createHmac('sha1', 'signing-secret').update(rawBody).digest('base64');
  assert.equal(verifyWebhookSignature(new Headers({ 'x-stringee-signature': signed }), rawBody), true);
  assert.equal(verifyWebhookSignature(new Headers({ 'x-stringee-signature': 'invalid' }), rawBody), false);

  // Webhook payload normalization
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

  // Stringee initiateCall contract
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

  // Retry backoff calculation
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

  // Verify static migrations presence
  const mediaMigration = readFileSync('supabase/migrations/20260921000001_voice_media_pipeline.sql', 'utf8');
  assert.match(mediaMigration, /'call-recordings',[\s\S]*?false/);
  assert.match(mediaMigration, /uq_call_attempts_one_pending_per_customer/);
  assert.match(mediaMigration, /REVOKE ALL ON TABLE public\.voice_media_jobs FROM PUBLIC, anon, authenticated/);

  const hardeningMigration = readFileSync('supabase/migrations/20260922000003_voice_security_hardening.sql', 'utf8');
  assert.match(hardeningMigration, /voice_provider_integrations/);
  assert.match(hardeningMigration, /uq_calls_tenant_provider_call/);
  assert.match(hardeningMigration, /start_voice_contact_cycle/);
  assert.match(hardeningMigration, /complete_voice_attempt_transition/);

  const p0Migration = readFileSync('supabase/migrations/20260925000001_voice_p0_hardening.sql', 'utf8');
  assert.match(p0Migration, /voice_dispatch_commands/);
  assert.match(p0Migration, /prepare_voice_dispatch_atomic/);
  assert.match(p0Migration, /finalize_voice_dispatch_atomic/);
  assert.match(p0Migration, /apply_voice_call_status_atomic/);
  assert.match(p0Migration, /ingest_inbound_voice_call_atomic/);
  assert.match(p0Migration, /attach_call_recording_ref_atomic/);

  console.log('✓ Pure unit tests passed.\n');

  // ---------------------------------------------------------------------------
  // Real Local Supabase Database Integration Tests
  // ---------------------------------------------------------------------------
  console.log('--- 2. Real Local Supabase Integration Tests ---');
  const adminClient = createAdminClient();

  const COMPANY_A = '11111111-2222-3333-4444-555555555501';
  const COMPANY_B = '11111111-2222-3333-4444-555555555502';
  const CUSTOMER_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01';
  const CUSTOMER_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee02';
  const CYCLE_A1 = 'cccccccc-1111-2222-3333-444444444401';

  // Clean up test data from previous runs if any
  await adminClient.from('voice_dispatch_commands').delete().in('company_id', [COMPANY_A, COMPANY_B]);
  await adminClient.from('voice_media_jobs').delete().in('company_id', [COMPANY_A, COMPANY_B]);
  await adminClient.from('voice_webhook_events').delete().in('company_id', [COMPANY_A, COMPANY_B]);
  await adminClient.from('call_attempts').delete().in('company_id', [COMPANY_A, COMPANY_B]);
  await adminClient.from('calls').delete().in('company_id', [COMPANY_A, COMPANY_B]);
  await adminClient.from('interactions').delete().in('company_id', [COMPANY_A, COMPANY_B]);
  await adminClient.from('customer_stage_histories').delete().in('company_id', [COMPANY_A, COMPANY_B]);
  await adminClient.from('identities').delete().in('company_id', [COMPANY_A, COMPANY_B]);
  await adminClient.from('customers').delete().in('company_id', [COMPANY_A, COMPANY_B]);

  // Seed fixture companies & customers
  const { error: compErr } = await adminClient.from('companies').upsert([
    { id: COMPANY_A, name: 'Công ty Cửa Chống Ngập A' },
    { id: COMPANY_B, name: 'Công ty Cửa Chống Ngập B' },
  ]);
  assert.equal(compErr, null);

  const { error: custErr } = await adminClient.from('customers').upsert([
    { id: CUSTOMER_A, company_id: COMPANY_A, name: 'Nguyễn Văn Test A', source: 'HOTLINE', stage: 'LEAD_NEW' },
    { id: CUSTOMER_B, company_id: COMPANY_B, name: 'Trần Thị Test B', source: 'HOTLINE', stage: 'LEAD_NEW' },
  ]);
  assert.equal(custErr, null);

  const { error: contactErrA } = await adminClient.rpc('upsert_customer_private_contact', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_normalized_phone: '+84912345678',
    p_raw_phone: '0912345678',
  });
  assert.equal(contactErrA, null);

  const { error: contactErrB } = await adminClient.rpc('upsert_customer_private_contact', {
    p_company_id: COMPANY_B,
    p_customer_id: CUSTOMER_B,
    p_normalized_phone: '+84987654321',
    p_raw_phone: '0987654321',
  });
  assert.equal(contactErrB, null);

  // =========================================================================
  // SECTION A: DISPATCH
  // =========================================================================
  console.log('[Dispatch Tests]');

  // Test A1: Start contact cycle and same-company authorized dispatch
  const { data: attemptA1Id, error: cycleErr } = await adminClient.rpc('start_voice_contact_cycle', {
    p_company_id: COMPANY_A,
    p_customer_id: CUSTOMER_A,
    p_contact_cycle_id: CYCLE_A1,
    p_scheduled_at: new Date().toISOString(),
  });
  assert.equal(cycleErr, null);
  assert.ok(attemptA1Id);

  const mockProviderSuccess: CallProvider = {
    name: 'STRINGEE',
    initiateCall: async () => ({ providerCallId: 'stringee_call_rec_001', status: 'INITIATED' }),
  };

  const dispatchRes = await dispatchAiOutboundCall(
    attemptA1Id as string,
    COMPANY_A,
    mockProviderSuccess,
    'idemp_cmd_001'
  );
  assert.equal(dispatchRes.status, 'CALLING');
  assert.ok(dispatchRes.callId);

  // Verify call record in DB
  const { data: callRow } = await adminClient
    .from('calls')
    .select('id, status, provider_call_id, direction, agent_type')
    .eq('id', dispatchRes.callId)
    .single();
  assert.equal(callRow?.status, 'RINGING');
  assert.equal(callRow?.provider_call_id, 'stringee_call_rec_001');
  assert.equal(callRow?.direction, 'OUTBOUND');

  // Verify attempt bound
  const { data: attemptRow } = await adminClient
    .from('call_attempts')
    .select('id, call_id, called_at, result')
    .eq('id', attemptA1Id)
    .single();
  assert.equal(attemptRow?.call_id, dispatchRes.callId);
  assert.ok(attemptRow?.called_at);

  // Verify command state in DB
  const { data: cmdRow } = await adminClient
    .from('voice_dispatch_commands')
    .select('status, provider_call_id')
    .eq('attempt_id', attemptA1Id)
    .single();
  assert.equal(cmdRow?.status, 'ACTIVE');
  assert.equal(cmdRow?.provider_call_id, 'stringee_call_rec_001');
  console.log('✓ Same-company authorized dispatch passed');

  // Test A2: Cross-company dispatch denied
  let crossCompanyDenied = false;
  try {
    await dispatchAiOutboundCall(
      attemptA1Id as string,
      COMPANY_B, // Wrong company!
      mockProviderSuccess
    );
  } catch (err: unknown) {
    if (err instanceof ServerAuthError) {
      crossCompanyDenied = true;
    }
  }
  assert.equal(crossCompanyDenied, true, 'Cross-company dispatch must be denied');
  console.log('✓ Cross-company dispatch denied passed');

  // Test A3: Provider failure updates call and attempt to FAILED
  const CUSTOMER_FAIL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee03';
  const CYCLE_FAIL = 'cccccccc-1111-2222-3333-444444444404';
  await adminClient.from('customers').upsert({
    id: CUSTOMER_FAIL, company_id: COMPANY_A, name: 'Khách Test Fail', source: 'HOTLINE', stage: 'LEAD_NEW',
  });
  await adminClient.rpc('upsert_customer_private_contact', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_FAIL, p_normalized_phone: '+84911223344', p_raw_phone: '0911223344',
  });
  const { data: attemptFailId } = await adminClient.rpc('start_voice_contact_cycle', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_FAIL, p_contact_cycle_id: CYCLE_FAIL, p_scheduled_at: new Date().toISOString(),
  });

  const mockProviderFailure: CallProvider = {
    name: 'STRINGEE',
    initiateCall: async () => { throw new Error('Provider network connection error'); },
  };

  let providerFailedCaught = false;
  try {
    await dispatchAiOutboundCall(attemptFailId as string, COMPANY_A, mockProviderFailure);
  } catch (err: unknown) {
    if (err instanceof ServerAuthError && err.code === 'CALL_PROVIDER_FAILURE') {
      providerFailedCaught = true;
    }
  }
  assert.equal(providerFailedCaught, true, 'Provider failure must throw CALL_PROVIDER_FAILURE');

  const { data: failAttemptRow } = await adminClient
    .from('call_attempts')
    .select('result')
    .eq('id', attemptFailId)
    .single();
  assert.equal(failAttemptRow?.result, 'FAILED');
  console.log('✓ Provider failure handling passed');

  // Test A4: Provider success + persistence failure/recovery
  const CUSTOMER_RECON = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee04';
  const CYCLE_RECON = 'cccccccc-1111-2222-3333-444444444405';
  await adminClient.from('customers').upsert({
    id: CUSTOMER_RECON, company_id: COMPANY_A, name: 'Khách Test Recon', source: 'HOTLINE', stage: 'LEAD_NEW',
  });
  await adminClient.rpc('upsert_customer_private_contact', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_RECON, p_normalized_phone: '+84955667788', p_raw_phone: '0955667788',
  });
  const { data: attemptReconId } = await adminClient.rpc('start_voice_contact_cycle', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_RECON, p_contact_cycle_id: CYCLE_RECON, p_scheduled_at: new Date().toISOString(),
  });

  // Manually prepare and record provider accepted, but simulate finalize failure
  const { data: prepRecon } = await adminClient.rpc('prepare_voice_dispatch_atomic', {
    p_company_id: COMPANY_A,
    p_attempt_id: attemptReconId,
    p_idempotency_key: 'idemp_recon_001',
    p_provider: 'STRINGEE',
  });
  const reconCallId = (Array.isArray(prepRecon) ? prepRecon[0] : prepRecon).call_id;
  await adminClient.rpc('record_voice_provider_accepted_atomic', {
    p_company_id: COMPANY_A,
    p_attempt_id: attemptReconId,
    p_call_id: reconCallId,
    p_provider_call_id: 'call_rec_saved_provider_123',
  });
  await adminClient.rpc('mark_voice_dispatch_reconciliation_required_atomic', {
    p_company_id: COMPANY_A,
    p_attempt_id: attemptReconId,
    p_call_id: reconCallId,
    p_error: 'Simulated DB connection drop during finalize',
  });

  // Test A5: Retry after case 4 does NOT call provider a second time
  let providerCallCount = 0;
  const countingProvider: CallProvider = {
    name: 'STRINGEE',
    initiateCall: async () => {
      providerCallCount++;
      return { providerCallId: 'unexpected_new_call_id', status: 'INITIATED' };
    },
  };

  const reconResult = await dispatchAiOutboundCall(
    attemptReconId as string,
    COMPANY_A,
    countingProvider
  );
  assert.equal(providerCallCount, 0, 'Provider initiateCall must NOT be called on reconciliation retry!');
  assert.equal(reconResult.callId, reconCallId);

  const { data: reconCmd } = await adminClient
    .from('voice_dispatch_commands')
    .select('status, provider_call_id')
    .eq('attempt_id', attemptReconId)
    .single();
  assert.equal(reconCmd?.status, 'ACTIVE');
  assert.equal(reconCmd?.provider_call_id, 'call_rec_saved_provider_123');
  console.log('✓ Provider success + DB finalize failure & retry without 2nd provider call passed');

  // Test A6: Duplicate dispatch command concurrently
  const CUSTOMER_CONCURR = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee05';
  const CYCLE_CONCURR = 'cccccccc-1111-2222-3333-444444444406';
  await adminClient.from('customers').upsert({
    id: CUSTOMER_CONCURR, company_id: COMPANY_A, name: 'Khách Test Concurr', source: 'HOTLINE', stage: 'LEAD_NEW',
  });
  await adminClient.rpc('upsert_customer_private_contact', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_CONCURR, p_normalized_phone: '+84999887766', p_raw_phone: '0999887766',
  });
  const { data: attemptConcurrId } = await adminClient.rpc('start_voice_contact_cycle', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_CONCURR, p_contact_cycle_id: CYCLE_CONCURR, p_scheduled_at: new Date().toISOString(),
  });

  let concurrencyProviderCalls = 0;
  const slowProvider: CallProvider = {
    name: 'STRINGEE',
    initiateCall: async () => {
      concurrencyProviderCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return { providerCallId: 'stringee_concurr_001', status: 'INITIATED' };
    },
  };

  const results = await Promise.allSettled([
    dispatchAiOutboundCall(attemptConcurrId as string, COMPANY_A, slowProvider),
    dispatchAiOutboundCall(attemptConcurrId as string, COMPANY_A, slowProvider),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.ok(fulfilled.length >= 1, 'At least one concurrent dispatch must succeed');
  assert.equal(concurrencyProviderCalls, 1, 'Only one provider call must be initiated despite concurrent invocations');
  console.log('✓ Duplicate dispatch command concurrency handling passed\n');

  // =========================================================================
  // SECTION B: WEBHOOK
  // =========================================================================
  console.log('[Webhook Tests]');

  // Test B1: Webhook call status + attempt atomic update
  const webhookRes = await processCallStatusUpdate(
    {
      event: 'call.status_updated',
      provider_call_id: 'stringee_call_rec_001',
      status: 'completed',
      ended_at: new Date().toISOString(),
      event_id: 'evt_status_completed_001',
    },
    COMPANY_A,
    'STRINGEE'
  );
  assert.equal(webhookRes.handled, true);

  const { data: callUpdated } = await adminClient
    .from('calls')
    .select('status, ended_at')
    .eq('id', dispatchRes.callId)
    .single();
  assert.equal(callUpdated?.status, 'COMPLETED');

  // Attempt atomically transitioned to ANSWERED
  const { data: attemptUpdated } = await adminClient
    .from('call_attempts')
    .select('result')
    .eq('id', attemptA1Id)
    .single();
  assert.equal(attemptUpdated?.result, 'ANSWERED');

  // Interaction recorded
  const { data: interactionEvent } = await adminClient
    .from('interactions')
    .select('id, type, channel, external_ref')
    .eq('external_ref', 'evt_status_completed_001')
    .maybeSingle();
  assert.ok(interactionEvent);
  console.log('✓ Call + attempt atomic update via webhook passed');

  // Test B2: Duplicate event idempotency
  const dupWebhookRes = await processCallStatusUpdate(
    {
      event: 'call.status_updated',
      provider_call_id: 'stringee_call_rec_001',
      status: 'completed',
      ended_at: new Date().toISOString(),
      event_id: 'evt_status_completed_001', // Exact same event ID
    },
    COMPANY_A,
    'STRINGEE'
  );
  assert.equal(dupWebhookRes.handled, true);
  assert.match(dupWebhookRes.message, /duplicate event/);
  console.log('✓ Duplicate webhook idempotency passed');

  // Test B3: Cross-tenant webhook rejected
  const crossTenantWebhookRes = await processCallStatusUpdate(
    {
      event: 'call.status_updated',
      provider_call_id: 'stringee_call_rec_001', // Belongs to Company A
      status: 'completed',
      event_id: 'evt_cross_tenant_001',
    },
    COMPANY_B, // Webhook processed in Company B context!
    'STRINGEE'
  );
  assert.equal(crossTenantWebhookRes.handled, false);
  console.log('✓ Cross-tenant webhook denied passed');

  // Test B4: Illegal state transition (COMPLETED cannot revert to RINGING)
  await processCallStatusUpdate(
    {
      event: 'call.status_updated',
      provider_call_id: 'stringee_call_rec_001',
      status: 'ringing', // Illegal reversion!
      event_id: 'evt_illegal_revert_001',
    },
    COMPANY_A,
    'STRINGEE'
  );
  const { data: callNotReverted } = await adminClient
    .from('calls')
    .select('status')
    .eq('id', dispatchRes.callId)
    .single();
  assert.equal(callNotReverted?.status, 'COMPLETED');
  console.log('✓ Illegal state transition rejection passed');

  // Test B5: Concurrent terminal events
  const concurrentWebhookResults = await Promise.all([
    processCallStatusUpdate(
      { event: 'call.status_updated', provider_call_id: 'call_rec_saved_provider_123', status: 'completed', event_id: 'evt_concurr_wh_1' },
      COMPANY_A, 'STRINGEE'
    ),
    processCallStatusUpdate(
      { event: 'call.status_updated', provider_call_id: 'call_rec_saved_provider_123', status: 'completed', event_id: 'evt_concurr_wh_2' },
      COMPANY_A, 'STRINGEE'
    ),
  ]);
  assert.equal(concurrentWebhookResults[0].handled, true);
  assert.equal(concurrentWebhookResults[1].handled, true);
  console.log('✓ Concurrent terminal events handled cleanly\n');

  // =========================================================================
  // SECTION C: SCHEDULER & PREDECESSOR VALIDATION
  // =========================================================================
  console.log('[Scheduler Tests]');

  // Test C1: One active cycle invariant — cannot start new cycle when customer has pending attempt
  const CUSTOMER_CYCLE_TEST = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee06';
  await adminClient.from('customers').upsert({
    id: CUSTOMER_CYCLE_TEST, company_id: COMPANY_A, name: 'Khách Cycle Test', source: 'HOTLINE', stage: 'LEAD_NEW',
  });
  const { error: cycleInitErr } = await adminClient.rpc('start_voice_contact_cycle', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_CYCLE_TEST, p_contact_cycle_id: 'cccccccc-0000-0000-0000-000000000001', p_scheduled_at: new Date().toISOString(),
  });
  assert.equal(cycleInitErr, null);

  const { error: dupCycleErr } = await adminClient.rpc('start_voice_contact_cycle', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_CYCLE_TEST, p_contact_cycle_id: 'cccccccc-0000-0000-0000-000000000002', p_scheduled_at: new Date().toISOString(),
  });
  assert.ok(dupCycleErr, 'Cannot start 2nd active cycle when pending attempt exists');
  console.log('✓ One active cycle invariant passed');

  // Test C2: Predecessor state validation — customer in terminal/downstream state cannot start cycle
  const CUSTOMER_UNREACHABLE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee07';
  await adminClient.from('customers').upsert({
    id: CUSTOMER_UNREACHABLE, company_id: COMPANY_A, name: 'Khách Unreachable', source: 'HOTLINE', stage: 'UNREACHABLE',
  });
  const { error: unreachCycleErr } = await adminClient.rpc('start_voice_contact_cycle', {
    p_company_id: COMPANY_A, p_customer_id: CUSTOMER_UNREACHABLE, p_contact_cycle_id: 'cccccccc-0000-0000-0000-000000000003', p_scheduled_at: new Date().toISOString(),
  });
  assert.ok(unreachCycleErr, 'Terminal UNREACHABLE state cannot silently start contact cycle');
  console.log('✓ Predecessor state validation passed');

  // Test C3: Concurrent scheduler start
  const CUSTOMER_CONCURR_SCHED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee08';
  await adminClient.from('customers').upsert({
    id: CUSTOMER_CONCURR_SCHED, company_id: COMPANY_A, name: 'Khách Concurr Sched', source: 'HOTLINE', stage: 'LEAD_NEW',
  });
  const schedResults = await Promise.allSettled([
    adminClient.rpc('start_voice_contact_cycle', { p_company_id: COMPANY_A, p_customer_id: CUSTOMER_CONCURR_SCHED, p_contact_cycle_id: 'cccccccc-0000-0000-0000-000000000010', p_scheduled_at: new Date().toISOString() }),
    adminClient.rpc('start_voice_contact_cycle', { p_company_id: COMPANY_A, p_customer_id: CUSTOMER_CONCURR_SCHED, p_contact_cycle_id: 'cccccccc-0000-0000-0000-000000000011', p_scheduled_at: new Date().toISOString() }),
  ]);
  const schedFulfilled = schedResults.filter((r) => r.status === 'fulfilled' && !('value' in r && (r.value as { error?: unknown }).error));
  assert.equal(schedFulfilled.length, 1, 'Only one concurrent cycle start must succeed');
  console.log('✓ Concurrent scheduler cycle start handled cleanly\n');

  // =========================================================================
  // SECTION D: MEDIA WORKER LEASE & STORAGE TRUST BOUNDARY
  // =========================================================================
  console.log('[Media Worker Lease & Storage Tests]');

  // Test D1: Lease claim with explicit ownership token
  const CALL_MEDIA_TEST = 'aaaaaaaa-1111-2222-3333-000000000099';
  await adminClient.from('calls').upsert({
    id: CALL_MEDIA_TEST, company_id: COMPANY_A, customer_id: CUSTOMER_A,
    direction: 'OUTBOUND', agent_type: 'AI', provider: 'STRINGEE', started_at: new Date().toISOString(), status: 'COMPLETED', transcript_status: 'PENDING',
  });
  const { data: jobInsert } = await adminClient.from('voice_media_jobs').insert({
    company_id: COMPANY_A, call_id: CALL_MEDIA_TEST, job_type: 'RECORDING_IMPORT', status: 'PENDING',
  }).select('id').single();
  const jobId = jobInsert?.id;

  const { data: claimedJobs } = await adminClient.rpc('claim_voice_media_jobs', {
    p_limit: 10, p_locked_by: 'test_worker_1', p_lease_seconds: 300,
  });
  const claimedJob = ((claimedJobs || []) as Array<{ id: string; lock_token: string; retry_count: number }>).find((j) => j.id === jobId);
  assert.ok(claimedJob);
  assert.ok(claimedJob.lock_token, 'Worker lease must issue an explicit lock_token');
  const token1 = claimedJob.lock_token;

  const { data: dbClaimedJob } = await adminClient.from('voice_media_jobs').select('status, lock_token, lease_expires_at').eq('id', jobId).single();
  assert.strictEqual(dbClaimedJob?.status, 'PROCESSING');
  assert.strictEqual(dbClaimedJob?.lock_token, token1);
  assert.ok(dbClaimedJob?.lease_expires_at, 'lease_expires_at must be populated on claimed job');
  console.log('✓ Media worker lease claim with lock_token and lease_expires_at passed');

  // Test D2: Stale lease reclaim issues new token and increments retry_count
  await adminClient.from('voice_media_jobs').update({
    lease_expires_at: new Date(Date.now() - 5000).toISOString(), // Expired lease
  }).eq('id', jobId);

  const { data: reclaimedJobs } = await adminClient.rpc('claim_voice_media_jobs', {
    p_limit: 10, p_locked_by: 'test_worker_2', p_lease_seconds: 300,
  });
  const reclaimedJob = ((reclaimedJobs || []) as Array<{ id: string; lock_token: string; retry_count: number }>).find((j) => j.id === jobId);
  assert.ok(reclaimedJob);
  assert.notEqual(reclaimedJob.lock_token, token1, 'New worker must receive a fresh lock_token');
  assert.equal(reclaimedJob.retry_count, 1, 'Reclaimed lease must increment retry_count');
  const token2 = reclaimedJob.lock_token;
  console.log('✓ Stale lease reclaim with incremented retry_count passed');

  // Test D3: Stale worker with old lock_token CANNOT complete job
  const { data: staleComplete } = await adminClient.rpc('complete_voice_media_job', {
    p_company_id: COMPANY_A, p_job_id: jobId, p_lock_token: token1, // Old token!
  });
  assert.equal(staleComplete, false, 'Stale worker with old token must NOT be allowed to complete job');

  // Worker with current lock_token CAN complete
  const { data: validComplete } = await adminClient.rpc('complete_voice_media_job', {
    p_company_id: COMPANY_A, p_job_id: jobId, p_lock_token: token2,
  });
  assert.equal(validComplete, true, 'Worker with current token completes job');
  console.log('✓ Stale worker lease protection passed');

  // Test D4: Storage trust boundary — cross-tenant recording path denied
  let crossTenantStorageDenied = false;
  try {
    await updateCallRecordingRef(
      CALL_MEDIA_TEST,
      COMPANY_A,
      `${COMPANY_B}/${CALL_MEDIA_TEST}/recording.mp3` // Illegal: references Company B storage prefix!
    );
  } catch (err: unknown) {
    if (err instanceof ServerAuthError && err.code === 'RESOURCE_FORBIDDEN') {
      crossTenantStorageDenied = true;
    }
  }
  assert.equal(crossTenantStorageDenied, true, 'Cross-tenant recording path must be rejected');

  // Valid storage path succeeds
  await updateCallRecordingRef(
    CALL_MEDIA_TEST,
    COMPANY_A,
    `${COMPANY_A}/${CALL_MEDIA_TEST}/recording.mp3`
  );
  const { data: callWithRec } = await adminClient
    .from('calls')
    .select('recording_ref')
    .eq('id', CALL_MEDIA_TEST)
    .single();
  assert.equal(callWithRec?.recording_ref, `${COMPANY_A}/${CALL_MEDIA_TEST}/recording.mp3`);
  console.log('✓ Storage trust boundary and cross-tenant storage protection passed\n');

  // =========================================================================
  // SECTION E: SENSITIVE BOUNDARIES & ZERO-PHONE IN PUBLIC TABLES
  // =========================================================================
  console.log('[Sensitive Boundaries Tests]');

  // Test E1: Inbound call ingestion preserves ZERO-PHONE in public.customers
  const inboundRes = await processInboundCall(
    {
      event: 'call.inbound',
      provider_call_id: 'stringee_inbound_call_999',
      from_number: '0933445566',
      to_number: '19001234',
    },
    COMPANY_A,
    'STRINGEE'
  );
  assert.equal(inboundRes.handled, true);

  const { data: inboundCall } = await adminClient
    .from('calls')
    .select('id, customer_id')
    .eq('provider_call_id', 'stringee_inbound_call_999')
    .single();
  assert.ok(inboundCall);

  // Invariant check: public.customers has ZERO phone columns
  const { data: inboundCustomer } = await adminClient
    .from('customers')
    .select('*')
    .eq('id', inboundCall.customer_id)
    .single();
  assert.equal('phone' in (inboundCustomer || {}), false);
  assert.equal('raw_phone' in (inboundCustomer || {}), false);
  assert.equal('normalized_phone' in (inboundCustomer || {}), false);

  // Raw phone stored strictly in private schema
  const { data: privateContact } = await adminClient.rpc('find_customer_by_normalized_phone', {
    p_company_id: COMPANY_A,
    p_normalized_phone: '+84933445566',
  });
  const resolvedContact = Array.isArray(privateContact) ? privateContact[0] : privateContact;
  assert.equal(resolvedContact?.customer_id, inboundCall.customer_id);
  console.log('✓ Inbound ZERO-PHONE in public tables passed');

  // Test E2: Zero verbatim transcript in public interactions
  const { data: interactions } = await adminClient
    .from('interactions')
    .select('sanitized_content, type')
    .eq('external_ref', 'stringee_inbound_call_999');
  for (const inter of interactions || []) {
    assert.equal(inter.sanitized_content, null);
  }
  console.log('✓ Zero verbatim transcript in public interactions passed');

  // Test E3: Authenticated user cannot directly query private schema tables
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: anonData, error: anonErr } = await anonClient
    .from('call_transcripts')
    .select('*');
  assert.ok(anonErr || !anonData || anonData.length === 0, 'Anonymous cannot read call_transcripts');
  console.log('✓ Authenticated/anon client denied direct access to private transcript passed\n');

  console.log('==================================================');
  console.log('ALL VOICE UNIT & REAL SUPABASE INTEGRATION TESTS PASSED!');
  console.log('==================================================');
}

runTests().catch((error) => {
  console.error('Voice integration test failure:', error);
  process.exit(1);
});
