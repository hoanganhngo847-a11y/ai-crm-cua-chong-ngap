import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';

// FAIL-CLOSED LOCAL URL GUARD: Must validate hostname BEFORE createClient or ANY DB/auth call
const parsedUrl = new URL(SUPABASE_URL);
if (!['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
  throw new Error(`Fail-closed: local Supabase URL required (localhost/127.0.0.1), got: ${parsedUrl.hostname}`);
}

const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be provided via process env');
}

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function runDockerPsql(sql: string): string {
  const cmd = `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -v ON_ERROR_STOP=1`;
  return execSync(cmd, { input: sql, encoding: 'utf8' });
}

test('Real Supabase: Read and execute ACTUAL migration file in native Postgres rolled-back transaction for pg_cron+pg_net branch', async () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../supabase/migrations/20261023170000_ai_brain_messenger_live_canary_and_scheduler.sql'
  );
  assert.ok(fs.existsSync(migrationPath), `Migration file must exist at ${migrationPath}`);
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  // Wrap the actual migration file inside a native Postgres rolled-back transaction
  // with pg_cron and pg_net enabled to verify the active scheduler branch without permanent DB mutation
  const transactionScript = `
BEGIN;

-- Enable extensions to activate the dynamic pg_cron+pg_net scheduler branch in the migration
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Execute the ACTUAL migration file directly (no copied SQL helper)
${migrationSql}

-- Assertions inside the transaction:
-- A. Verify cron job is registered
DO $v$
DECLARE
  v_job_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'ai_brain_live_messenger_worker'
      AND schedule = '* * * * *'
  ) INTO v_job_exists;

  IF NOT v_job_exists THEN
    RAISE EXCEPTION 'CRON_JOB_NOT_SCHEDULED';
  END IF;
END $v$;

-- B. Verify helper function security: revoked from public and service_role, granted to postgres
DO $v$
BEGIN
  IF has_function_privilege('public', 'cron_internal.invoke_ai_brain_live_messenger_cron()', 'execute') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION_PUBLIC_EXECUTE';
  END IF;
  IF has_function_privilege('service_role', 'cron_internal.invoke_ai_brain_live_messenger_cron()', 'execute') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION_SERVICE_ROLE_EXECUTE';
  END IF;
  IF NOT has_function_privilege('postgres', 'cron_internal.invoke_ai_brain_live_messenger_cron()', 'execute') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION_POSTGRES_EXECUTE_MISSING';
  END IF;
END $v$;

-- C. Verify fail closed on missing Vault endpoint
DO $v$
BEGIN
  BEGIN
    PERFORM cron_internal.invoke_ai_brain_live_messenger_cron();
    RAISE EXCEPTION 'FAIL_CLOSED_CHECK_FAILED: did not raise';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%INVALID_VAULT_ENDPOINT_CONFIG%' THEN
        RAISE EXCEPTION 'UNEXPECTED_ERROR_MESSAGE: %', SQLERRM;
      END IF;
  END;
END $v$;

-- Roll back completely so no state or cron jobs leak into local DB
ROLLBACK;
`;

  const output = runDockerPsql(transactionScript);
  assert.ok(output.includes('ROLLBACK'), 'Transaction must rollback cleanly');
});

test('Real Supabase Native: Dispatch guard null/NaN/threshold/source/time/lease/canary/ownership, outbound idempotence, and original 8-arg compatibility', async () => {
  const companyId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const convId = crypto.randomUUID();
  const numericPageId = '987654321098765';
  const numericPsid = '87654321098765432';

  // 1. Provision isolated company, customer, and conversation via PostgREST
  const { error: compErr } = await serviceClient.from('companies').insert({
    id: companyId,
    name: 'Real Supabase Live Test Co',
    status: 'ACTIVE',
  });
  assert.ifError(compErr);

  const { error: custErr } = await serviceClient.from('customers').insert({
    id: customerId,
    company_id: companyId,
    customer_code: `REAL-MSGR-${Date.now().toString().slice(-6)}`,
    name: 'Real Supabase Messenger Cust',
    source: 'MANUAL',
    stage: 'LEAD_NEW',
  });
  assert.ifError(custErr);

  const { error: convErr } = await serviceClient.from('conversations').insert({
    id: convId,
    company_id: companyId,
    customer_id: customerId,
    channel: 'FACEBOOK',
    external_conversation_id: `${numericPageId}:${numericPsid}`,
    status: 'OPEN',
    ai_mode: 'ACTIVE',
  });
  assert.ifError(convErr);

  // 2. Strict Canary Allowlist: Insert allowlist entry
  const { error: canaryInsertErr } = await serviceClient
    .from('ai_brain_live_canary_allowlist')
    .insert({
      company_id: companyId,
      channel: 'MESSENGER',
      conversation_id: convId,
      page_id: numericPageId,
      enabled: true,
    });
  assert.ifError(canaryInsertErr);

  // 3. Enable live settings for MESSENGER with min_confidence = 0.85
  const { error: settingErr } = await serviceClient.from('ai_brain_live_settings').upsert({
    company_id: companyId,
    channel: 'MESSENGER',
    enabled: true,
    min_confidence: 0.85,
  });
  assert.ifError(settingErr);

  // 4. Inbound customer interaction within 24h messaging window
  const interactionId = crypto.randomUUID();
  const { error: intErr } = await serviceClient.from('interactions').insert({
    id: interactionId,
    company_id: companyId,
    customer_id: customerId,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Giá dịch vụ trọn gói bao nhiêu vậy shop?',
    sanitization_status: 'SUCCEEDED',
  });
  assert.ifError(intErr);

  // 5. Verify enqueue trigger created delivery with channel = 'MESSENGER'
  const { data: delivery, error: delErr } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('id, company_id, conversation_id, channel, send_status, attempts, dispatch_started_at')
    .eq('source_interaction_id', interactionId)
    .single();
  assert.ifError(delErr);
  assert.ok(delivery);
  assert.equal(delivery.company_id, companyId);
  assert.equal(delivery.conversation_id, convId);
  assert.equal(delivery.channel, 'MESSENGER');
  assert.equal(delivery.send_status, 'PENDING');
  assert.equal(delivery.dispatch_started_at, null);

  // 6. Claim delivery with lockToken
  const lockToken = crypto.randomUUID();
  const { data: claimed, error: claimErr } = await serviceClient.rpc('claim_ai_brain_live_deliveries', {
    p_limit: 5,
    p_lock_token: lockToken,
    p_channel: 'MESSENGER',
  });
  assert.ifError(claimErr);
  const myClaim = (claimed as Array<{ id: string }>).find((c) => c.id === delivery.id);
  assert.ok(myClaim);

  // 7. Test dispatch guard NULL turn confidence -> denied (returns false)
  const { data: fenceNullConf } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: null,
  });
  assert.equal(fenceNullConf, false, 'Dispatch fence must deny null turn confidence');

  // 8. Test dispatch guard NaN turn confidence via native psql -> denied (returns false)
  const nanResult = runDockerPsql(`
    SELECT public.start_ai_messenger_live_dispatch(
      '${delivery.id}'::uuid,
      '${lockToken}'::uuid,
      '${companyId}'::uuid,
      '${customerId}'::uuid,
      '${convId}'::uuid,
      '${interactionId}'::uuid,
      '${numericPageId}',
      0.85,
      'NaN'::numeric
    );
  `);
  assert.ok(nanResult.includes('f'), 'Dispatch fence must deny NaN turn confidence');

  // 9. Test dispatch guard threshold (turn confidence < min_confidence) -> denied (returns false)
  const { data: fenceLowConf } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.80, // 0.80 < 0.85 threshold
  });
  assert.equal(fenceLowConf, false, 'Dispatch fence must deny turn confidence below min_confidence threshold');

  // 10. Test dispatch guard source scope/content/direction/customer/channel
  // A. Wrong source interaction ID
  const { data: fenceWrongSource } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: crypto.randomUUID(),
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fenceWrongSource, false, 'Dispatch fence must deny wrong source interaction');

  // 11. Test dispatch guard lease (wrong lock token) -> denied
  const { data: fenceWrongToken } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: crypto.randomUUID(), // wrong token
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fenceWrongToken, false, 'Dispatch fence must deny wrong lock token');

  // 12. Test dispatch guard time: Future inbound -> denied
  runDockerPsql(`UPDATE public.interactions SET created_at = now() + interval '1 hour' WHERE id = '${interactionId}'::uuid;`);
  const { data: fenceFutureInbound } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fenceFutureInbound, false, 'Dispatch fence must deny future inbound');

  // Expired inbound (> 24 hours) -> denied
  runDockerPsql(`UPDATE public.interactions SET created_at = now() - interval '25 hours' WHERE id = '${interactionId}'::uuid;`);
  const { data: fenceExpiredInbound } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fenceExpiredInbound, false, 'Dispatch fence must deny expired inbound outside 24h window');

  // Restore valid created_at
  runDockerPsql(`UPDATE public.interactions SET created_at = now() - interval '5 minutes' WHERE id = '${interactionId}'::uuid;`);

  // 13. Test dispatch guard ownership & conversation state
  // A. Human assigned conversation
  const userAdminId = crypto.randomUUID();
  runDockerPsql(`
    INSERT INTO auth.users (id) VALUES ('${userAdminId}'::uuid) ON CONFLICT DO NOTHING;
    INSERT INTO public.user_profiles (id, full_name, status) VALUES ('${userAdminId}'::uuid, 'Test Admin', 'ACTIVE') ON CONFLICT DO NOTHING;
    UPDATE public.conversations SET assigned_to = '${userAdminId}'::uuid WHERE id = '${convId}'::uuid;
  `);
  const { data: fenceAssigned } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fenceAssigned, false, 'Dispatch fence must deny human assigned conversation');
  runDockerPsql(`UPDATE public.conversations SET assigned_to = NULL WHERE id = '${convId}'::uuid;`);

  // B. AI paused
  runDockerPsql(`UPDATE public.conversations SET ai_mode = 'PAUSED' WHERE id = '${convId}'::uuid;`);
  const { data: fencePaused } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fencePaused, false, 'Dispatch fence must deny paused conversation');
  runDockerPsql(`UPDATE public.conversations SET ai_mode = 'ACTIVE' WHERE id = '${convId}'::uuid;`);

  // C. Strict numeric Page:PSID check
  runDockerPsql(`UPDATE public.conversations SET external_conversation_id = '${numericPageId}:user-non-numeric' WHERE id = '${convId}'::uuid;`);
  const { data: fenceNonNumericPsid } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fenceNonNumericPsid, false, 'Dispatch fence must deny non-numeric PSID');
  runDockerPsql(`UPDATE public.conversations SET external_conversation_id = '${numericPageId}:${numericPsid}' WHERE id = '${convId}'::uuid;`);

  // 14. Test dispatch guard canary: disabled allowlist entry -> denied
  runDockerPsql(`UPDATE public.ai_brain_live_canary_allowlist SET enabled = false WHERE company_id = '${companyId}'::uuid AND conversation_id = '${convId}'::uuid;`);
  const { data: fenceCanaryDisabled } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fenceCanaryDisabled, false, 'Dispatch fence must deny disabled canary allowlist');
  runDockerPsql(`UPDATE public.ai_brain_live_canary_allowlist SET enabled = true WHERE company_id = '${companyId}'::uuid AND conversation_id = '${convId}'::uuid;`);

  // 15. All checks passed -> Atomic fence acquisition succeeds
  const { data: fenceAcquired, error: fenceErr } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.ifError(fenceErr);
  assert.equal(fenceAcquired, true, 'Dispatch fence must be acquired on valid parameters');

  // Verify dispatch_started_at is set
  const { data: deliveryFenced } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('dispatch_started_at, send_status')
    .eq('id', delivery.id)
    .single();
  assert.ok(deliveryFenced?.dispatch_started_at);

  // Durable once-only marker: immediate second fence call must return false
  const { data: fenceAgain } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: delivery.id,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.92,
  });
  assert.equal(fenceAgain, false, 'Second fence call must return false (once-only marker)');

  // 16. Outbound idempotence and consistent raw provider MID versus timeline meta:Page:MID
  const rawMid = `mid.${Date.now()}`;
  const externalRef = `meta:${numericPageId}:${rawMid}`;
  const content = 'Dạ em chào anh/chị, em là trợ lý AI hỗ trợ tư vấn dịch vụ.';

  // Concurrent record_ai_messenger_live_outbound calls
  const [res1, res2] = await Promise.all([
    serviceClient.rpc('record_ai_messenger_live_outbound', {
      p_company_id: companyId,
      p_customer_id: customerId,
      p_conversation_id: convId,
      p_source_interaction_id: interactionId,
      p_delivery_id: delivery.id,
      p_external_ref: externalRef,
      p_content: content,
      p_actor_type: 'AI',
    }),
    serviceClient.rpc('record_ai_messenger_live_outbound', {
      p_company_id: companyId,
      p_customer_id: customerId,
      p_conversation_id: convId,
      p_source_interaction_id: interactionId,
      p_delivery_id: delivery.id,
      p_external_ref: externalRef,
      p_content: content,
      p_actor_type: 'AI',
    }),
  ]);

  assert.ifError(res1.error);
  assert.ifError(res2.error);
  assert.equal(res1.data, res2.data, 'Concurrent outbound recordings must return same interaction ID');
  const outboundIntId = res1.data;

  // Verify only 1 outbound interaction was created on timeline with meta:Page:MID external_ref
  const { data: interactions } = await serviceClient
    .from('interactions')
    .select('id, external_ref, direction, actor_type, channel')
    .eq('company_id', companyId)
    .eq('external_ref', externalRef);
  assert.equal(interactions?.length, 1, 'Exactly one interaction must be inserted on timeline');
  assert.equal(interactions?.[0].direction, 'OUTBOUND');
  assert.equal(interactions?.[0].actor_type, 'AI');
  assert.equal(interactions?.[0].channel, 'FACEBOOK');

  // Verify delivery stores consistent RAW provider MID and binds outbound_interaction_id
  const { data: midDelivery } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('external_message_id, outbound_interaction_id')
    .eq('id', delivery.id)
    .single();
  assert.equal(midDelivery?.external_message_id, rawMid, 'Delivery must store consistent raw provider MID');
  assert.equal(midDelivery?.outbound_interaction_id, outboundIntId, 'Delivery must bind outbound_interaction_id');

  // Attempting to record outbound with DIFFERENT external_ref on same delivery must be denied
  const { error: differentRefErr } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_delivery_id: delivery.id,
    p_external_ref: `meta:${numericPageId}:different-unrelated-ref`,
    p_content: 'Second reply',
    p_actor_type: 'AI',
  });
  assert.ok(differentRefErr, 'Different external_ref on same delivery must be denied');

  // Negative test: record_ai_messenger_live_outbound with wrong Page in external_ref must fail PAGE_MISMATCH
  const { error: wrongPageErr } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_delivery_id: delivery.id,
    p_external_ref: `meta:123450000000000:${rawMid}`,
    p_content: content,
    p_actor_type: 'AI',
  });
  assert.ok(wrongPageErr?.message.includes('PAGE_MISMATCH'), 'Wrong Page in external_ref must be rejected with PAGE_MISMATCH');

  // Negative test: non-canonical raw ref fallback rejected
  const { error: rawRefErr } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_delivery_id: delivery.id,
    p_external_ref: rawMid,
    p_content: content,
    p_actor_type: 'AI',
  });
  assert.ok(rawRefErr?.message.includes('INVALID_EXTERNAL_REF_FORMAT'), 'Raw ref fallback must be rejected');

  // Negative test: empty raw MID rejected
  const { error: emptyMidErr1 } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_delivery_id: delivery.id,
    p_external_ref: `meta:${numericPageId}:`,
    p_content: content,
    p_actor_type: 'AI',
  });
  assert.ok(emptyMidErr1, 'Empty raw MID must be rejected');

  const { error: emptyMidErr2 } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_delivery_id: delivery.id,
    p_external_ref: `meta:${numericPageId}:   `,
    p_content: content,
    p_actor_type: 'AI',
  });
  assert.ok(emptyMidErr2, 'Whitespace raw MID must be rejected');

  // Negative test: actor_type other than AI rejected
  const { error: wrongActorErr } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_delivery_id: delivery.id,
    p_external_ref: externalRef,
    p_content: content,
    p_actor_type: 'USER',
  });
  assert.ok(wrongActorErr?.message.includes('INVALID_ACTOR_TYPE'), 'Non-AI actor type must be rejected');

  // Negative test: cannot record outbound on delivery without authorized dispatch_started_at (PENDING / unmarked)
  const unmarkedSourceId = crypto.randomUUID();
  await serviceClient.from('interactions').insert({
    id: unmarkedSourceId,
    company_id: companyId,
    customer_id: customerId,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Unmarked message',
    sanitization_status: 'SUCCEEDED',
  });
  const { data: unmarkedDelivery } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', unmarkedSourceId)
    .single();
  assert.ok(unmarkedDelivery);

  const { error: unmarkedRecordErr } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: unmarkedSourceId,
    p_delivery_id: unmarkedDelivery.id,
    p_external_ref: `meta:${numericPageId}:unmarked-mid-${Date.now()}`,
    p_content: content,
    p_actor_type: 'AI',
  });
  assert.ok(unmarkedRecordErr?.message.includes('DISPATCH_NOT_AUTHORIZED'), 'Unmarked delivery must reject record_ai_messenger_live_outbound');

  // Negative test: conflicting existing interaction with same raw MID under wrong Page, wrong actor, or wrong direction
  const conflictMid = `mid.conflict.${Date.now()}`;
  await serviceClient.from('interactions').insert({
    id: crypto.randomUUID(),
    company_id: companyId,
    customer_id: customerId,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Inbound with same ref',
    sanitization_status: 'SUCCEEDED',
    external_ref: `meta:${numericPageId}:${conflictMid}`,
  });

  const conflictSourceId = crypto.randomUUID();
  await serviceClient.from('interactions').insert({
    id: conflictSourceId,
    company_id: companyId,
    customer_id: customerId,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Another inbound',
    sanitization_status: 'SUCCEEDED',
  });
  const { data: conflictDelivery } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', conflictSourceId)
    .single();
  assert.ok(conflictDelivery);

  const conflictLock = crypto.randomUUID();
  await serviceClient.rpc('claim_ai_brain_live_deliveries', {
    p_limit: 5,
    p_lock_token: conflictLock,
    p_channel: 'MESSENGER',
  });
  await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: conflictDelivery.id,
    p_lock_token: conflictLock,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: conflictSourceId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.9,
  });

  const { error: conflictErr } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: conflictSourceId,
    p_delivery_id: conflictDelivery.id,
    p_external_ref: `meta:${numericPageId}:${conflictMid}`,
    p_content: content,
    p_actor_type: 'AI',
  });
  assert.ok(conflictErr?.message.includes('INTERACTION_CONFLICT'), 'Conflicting existing interaction must reject outbound recording');

  // Negative test: start_ai_messenger_live_dispatch requires source type = 'MESSAGE' and sanitization_status = 'SUCCEEDED'
  const nonMsgSourceId = crypto.randomUUID();
  await serviceClient.from('interactions').insert({
    id: nonMsgSourceId,
    company_id: companyId,
    customer_id: customerId,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'NOTE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Note interaction',
    sanitization_status: 'SUCCEEDED',
  });
  const nonMsgDeliveryId = crypto.randomUUID();
  const nonMsgLock = crypto.randomUUID();
  runDockerPsql(`
    INSERT INTO public.ai_brain_live_deliveries (id, company_id, customer_id, conversation_id, source_interaction_id, channel, send_status, attempts, lock_token, locked_at)
    VALUES ('${nonMsgDeliveryId}', '${companyId}', '${customerId}', '${convId}', '${nonMsgSourceId}', 'MESSENGER', 'PROCESSING', 1, '${nonMsgLock}', now());
  `);
  const { data: nonMsgAuthorized } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: nonMsgDeliveryId,
    p_lock_token: nonMsgLock,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: nonMsgSourceId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.9,
  });
  assert.equal(nonMsgAuthorized, false, 'Non-MESSAGE interaction must be denied by dispatch guard');

  const unsanitizedSourceId = crypto.randomUUID();
  await serviceClient.from('interactions').insert({
    id: unsanitizedSourceId,
    company_id: companyId,
    customer_id: customerId,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Unsanitized message',
    sanitization_status: 'PENDING',
  });
  const unsanitizedDeliveryId = crypto.randomUUID();
  const unsanitizedLock = crypto.randomUUID();
  runDockerPsql(`
    INSERT INTO public.ai_brain_live_deliveries (id, company_id, customer_id, conversation_id, source_interaction_id, channel, send_status, attempts, lock_token, locked_at)
    VALUES ('${unsanitizedDeliveryId}', '${companyId}', '${customerId}', '${convId}', '${unsanitizedSourceId}', 'MESSENGER', 'PROCESSING', 1, '${unsanitizedLock}', now());
  `);
  const { data: unsanitizedAuthorized } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: unsanitizedDeliveryId,
    p_lock_token: unsanitizedLock,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: unsanitizedSourceId,
    p_page_id: numericPageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.9,
  });
  assert.equal(unsanitizedAuthorized, false, 'Unsanitized interaction must be denied by dispatch guard');

  // 17. Assert original 8-argument finish_ai_brain_live_delivery compatibility
  // Must execute unambiguously without native Postgres "function is not unique" error
  const { data: finished8, error: fin8Err } = await serviceClient.rpc('finish_ai_brain_live_delivery', {
    p_id: delivery.id,
    p_lock_token: lockToken,
    p_send_status: 'SENT',
    p_decision: 'RESPOND',
    p_confidence: 0.92,
    p_external_message_id: rawMid,
    p_error_code: null,
    p_brain_turn_id: null,
  });
  assert.ifError(fin8Err);
  assert.equal(finished8, true, 'Original 8-argument finish_ai_brain_live_delivery must succeed unambiguously');

  // Verify delivery after finish
  const { data: deliveryAfterFin8 } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('send_status, external_message_id, attempts')
    .eq('id', delivery.id)
    .single();
  assert.equal(deliveryAfterFin8?.send_status, 'SENT');
  assert.equal(deliveryAfterFin8?.external_message_id, rawMid);
  assert.equal(deliveryAfterFin8?.attempts, 1);

  // 18. Outbound idempotence AFTER finish: Re-recording must succeed and return same interaction ID
  const { data: postFinishRecId, error: postFinishRecErr } = await serviceClient.rpc('record_ai_messenger_live_outbound', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: interactionId,
    p_delivery_id: delivery.id,
    p_external_ref: externalRef,
    p_content: content,
    p_actor_type: 'AI',
  });
  assert.ifError(postFinishRecErr);
  assert.equal(postFinishRecId, outboundIntId, 'Re-recording after finish must be idempotent and return same interaction ID');

  // 19. Test extended finish RPC (finish_ai_brain_live_delivery_extended) with brain_latency_ms on a fresh claim
  const interaction2Id = crypto.randomUUID();
  await serviceClient.from('interactions').insert({
    id: interaction2Id,
    company_id: companyId,
    customer_id: customerId,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Bên mình có hỗ trợ dịch vụ tại khu vực miền Bắc không?',
    sanitization_status: 'SUCCEEDED',
  });

  const { data: delivery2 } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', interaction2Id)
    .single();
  assert.ok(delivery2);

  const lockToken2 = crypto.randomUUID();
  await serviceClient.rpc('claim_ai_brain_live_deliveries', {
    p_limit: 5,
    p_lock_token: lockToken2,
    p_channel: 'MESSENGER',
  });

  const rawMid2 = `mid.ext.${Date.now()}`;
  const { data: finishedExt, error: finExtErr } = await serviceClient.rpc('finish_ai_brain_live_delivery_extended', {
    p_id: delivery2.id,
    p_lock_token: lockToken2,
    p_send_status: 'SENT',
    p_decision: 'RESPOND',
    p_confidence: 0.95,
    p_external_message_id: rawMid2,
    p_error_code: null,
    p_brain_turn_id: null,
    p_brain_latency_ms: 284,
  });
  assert.ifError(finExtErr);
  assert.equal(finishedExt, true);

  const { data: finalDelivery2 } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('brain_latency_ms, send_status, attempts, external_message_id')
    .eq('id', delivery2.id)
    .single();
  assert.equal(finalDelivery2?.brain_latency_ms, 284);
  assert.equal(finalDelivery2?.send_status, 'SENT');
  assert.equal(finalDelivery2?.attempts, 1);
  assert.equal(finalDelivery2?.external_message_id, rawMid2);

  // 20. Verify finished/marked deliveries are NEVER claimed again
  const { data: reClaimed } = await serviceClient.rpc('claim_ai_brain_live_deliveries', {
    p_limit: 10,
    p_lock_token: crypto.randomUUID(),
    p_channel: 'MESSENGER',
  });
  const reFound1 = (reClaimed as Array<{ id: string }>).find((c) => c.id === delivery.id);
  const reFound2 = (reClaimed as Array<{ id: string }>).find((c) => c.id === delivery2.id);
  assert.equal(reFound1, undefined, 'Finished delivery 1 must never be re-claimed');
  assert.equal(reFound2, undefined, 'Finished delivery 2 must never be re-claimed');
});

test('Real Supabase Native: Lease crossing expiry while waiting on competing row lock denies dispatch authorization', async () => {
  const companyId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const convId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const lockToken = crypto.randomUUID();
  const pageId = '987654321098765';

  runDockerPsql(`
    INSERT INTO public.companies (id, name, status) VALUES ('${companyId}', 'Native Lock Wait Co', 'ACTIVE');
    INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
    VALUES ('${customerId}', '${companyId}', 'LOCK-WAIT-1', 'Lock Wait Cust', 'MANUAL', 'LEAD_NEW');
    INSERT INTO public.conversations (id, company_id, customer_id, channel, external_conversation_id, status, ai_mode)
    VALUES ('${convId}', '${companyId}', '${customerId}', 'FACEBOOK', '${pageId}:12345678', 'OPEN', 'ACTIVE');
    INSERT INTO public.ai_brain_live_canary_allowlist (company_id, channel, conversation_id, page_id, enabled)
    VALUES ('${companyId}', 'MESSENGER', '${convId}', '${pageId}', true);
    INSERT INTO public.ai_brain_live_settings (company_id, channel, enabled, min_confidence)
    VALUES ('${companyId}', 'MESSENGER', true, 0.85);
    INSERT INTO public.interactions (id, company_id, customer_id, conversation_id, channel, type, direction, actor_type, sanitized_content, sanitization_status, created_at)
    VALUES ('${sourceId}', '${companyId}', '${customerId}', '${convId}', 'FACEBOOK', 'MESSAGE', 'INBOUND', 'CUSTOMER', 'Xin chào', 'SUCCEEDED', now());
    UPDATE public.ai_brain_live_deliveries
    SET send_status = 'PROCESSING',
        lock_token = '${lockToken}',
        locked_at = now() - interval '4 minutes 59 seconds',
        attempts = 1
    WHERE source_interaction_id = '${sourceId}';
  `);

  const { data: deliveryRow } = await serviceClient
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', sourceId)
    .single();
  assert.ok(deliveryRow);
  const deliveryId = deliveryRow.id;

  // Competing session acquires FOR UPDATE lock on conversations for 2 seconds
  const child = spawn('docker', [
    'exec', '-i', 'supabase_db_ai-crm-cua-chong-ngap',
    'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'
  ]);
  child.stdin.write(`BEGIN;\nSELECT * FROM public.conversations WHERE id = '${convId}' FOR UPDATE;\nSELECT pg_sleep(2);\nCOMMIT;\n`);
  child.stdin.end();

  // Wait 300ms so competing session has locked conversations
  await new Promise((r) => setTimeout(r, 300));

  // Now call start_ai_messenger_live_dispatch while lock is held
  // Entry-time v_now is within 5 minutes, but authorization point v_now after acquiring lock has crossed 5 minutes!
  const { data: dispatchRes, error: dispatchErr } = await serviceClient.rpc('start_ai_messenger_live_dispatch', {
    p_delivery_id: deliveryId,
    p_lock_token: lockToken,
    p_company_id: companyId,
    p_customer_id: customerId,
    p_conversation_id: convId,
    p_source_interaction_id: sourceId,
    p_page_id: pageId,
    p_min_confidence: 0.85,
    p_turn_confidence: 0.9,
  });

  assert.ifError(dispatchErr);
  assert.equal(dispatchRes, false, 'Dispatch authorization must be DENIED when lease expires while blocked on row locks');

  // Cleanup
  runDockerPsql(`
    DELETE FROM public.ai_brain_live_deliveries WHERE company_id = '${companyId}';
    DELETE FROM public.interactions WHERE company_id = '${companyId}';
    DELETE FROM public.ai_brain_live_canary_allowlist WHERE company_id = '${companyId}';
    DELETE FROM public.ai_brain_live_settings WHERE company_id = '${companyId}';
    DELETE FROM public.conversations WHERE company_id = '${companyId}';
    DELETE FROM public.customers WHERE company_id = '${companyId}';
    DELETE FROM public.companies WHERE id = '${companyId}';
  `);
});
