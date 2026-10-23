import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const service = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COMPANY_ID = '00000000-0000-4000-8000-000000000096';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000097';

async function provisionFixture(): Promise<void> {
  await service.from('companies').upsert(
    [{ id: COMPANY_ID, name: 'AI Messenger DB Fixture Co', status: 'ACTIVE' }],
    { onConflict: 'id', ignoreDuplicates: true },
  );

  await service.from('customers').upsert(
    [{
      id: CUSTOMER_ID,
      company_id: COMPANY_ID,
      customer_code: 'MSGR-CUST-1',
      name: 'Messenger Customer Test',
      source: 'MANUAL',
      stage: 'LEAD_NEW',
    }],
    { onConflict: 'id', ignoreDuplicates: true },
  );
}

test('AI Brain Messenger Live DB: Inbound customer message enqueues delivery when MESSENGER setting is enabled', async () => {
  await provisionFixture();
  // 1. Create a Facebook conversation
  const convId = randomUUID();
  const { error: convErr } = await service.from('conversations').insert({
    id: convId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'FACEBOOK',
    external_conversation_id: `page-123:user-${convId.slice(0, 8)}`,
    status: 'OPEN',
    ai_mode: 'ACTIVE',
  });
  assert.ifError(convErr);

  // 2. Ensure MESSENGER setting is disabled first
  await service.from('ai_brain_live_settings').upsert({
    company_id: COMPANY_ID,
    channel: 'MESSENGER',
    enabled: false,
    min_confidence: 0.85,
  });

  // 3. Insert inbound customer message
  const interactionDisabledId = randomUUID();
  const { error: int1Err } = await service.from('interactions').insert({
    id: interactionDisabledId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Chào shop, em cần hỏi về cửa chống ngập',
    sanitization_status: 'SUCCEEDED',
  });
  assert.ifError(int1Err);

  // Assert NOT enqueued because setting is disabled
  const { data: noDelivery } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', interactionDisabledId)
    .maybeSingle();
  assert.equal(noDelivery, null);

  // 4. Enable MESSENGER setting
  await service.from('ai_brain_live_settings').upsert({
    company_id: COMPANY_ID,
    channel: 'MESSENGER',
    enabled: true,
    min_confidence: 0.85,
  });

  // 5. Insert another inbound message
  const interactionEnabledId = randomUUID();
  const { error: int2Err } = await service.from('interactions').insert({
    id: interactionEnabledId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: convId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Shop báo giá giúp em nhé',
    sanitization_status: 'SUCCEEDED',
  });
  assert.ifError(int2Err);

  // Assert successfully enqueued with channel = 'MESSENGER'
  const { data: delivery, error: delErr } = await service
    .from('ai_brain_live_deliveries')
    .select('id, company_id, conversation_id, channel, send_status')
    .eq('source_interaction_id', interactionEnabledId)
    .maybeSingle();
  assert.ifError(delErr);
  assert.ok(delivery);
  assert.equal(delivery.company_id, COMPANY_ID);
  assert.equal(delivery.conversation_id, convId);
  assert.equal(delivery.channel, 'MESSENGER');
  assert.equal(delivery.send_status, 'PENDING');

  // 6. Claim using claim_ai_brain_live_deliveries with p_channel = 'MESSENGER'
  const lockToken = randomUUID();
  const { data: claimed, error: claimErr } = await service.rpc('claim_ai_brain_live_deliveries', {
    p_limit: 5,
    p_lock_token: lockToken,
    p_channel: 'MESSENGER',
  });
  assert.ifError(claimErr);
  assert.ok(Array.isArray(claimed));
  const myClaim = claimed.find((c: { id: string }) => c.id === delivery.id);
  assert.ok(myClaim);
  assert.equal(myClaim.channel, 'MESSENGER');

  // 7. Test record_ai_messenger_live_outbound RPC
  const externalRef = `meta:page-123:mid-fb-${randomUUID()}`;
  const draftReply = 'Dạ chào anh/chị, em là AI hỗ trợ cửa chống ngập.';
  const { data: outboundIntId, error: recErr } = await service.rpc('record_ai_messenger_live_outbound', {
    p_company_id: COMPANY_ID,
    p_customer_id: CUSTOMER_ID,
    p_conversation_id: convId,
    p_source_interaction_id: interactionEnabledId,
    p_delivery_id: delivery.id,
    p_external_ref: externalRef,
    p_content: draftReply,
    p_actor_type: 'AI',
  });
  assert.ifError(recErr);
  assert.ok(outboundIntId);

  // Verify interaction was created with direction = 'OUTBOUND', actor_type = 'AI', channel = 'FACEBOOK'
  const { data: outInt, error: outIntErr } = await service
    .from('interactions')
    .select('id, direction, actor_type, channel, sanitized_content, external_ref')
    .eq('id', outboundIntId)
    .single();
  assert.ifError(outIntErr);
  assert.equal(outInt.direction, 'OUTBOUND');
  assert.equal(outInt.actor_type, 'AI');
  assert.equal(outInt.channel, 'FACEBOOK');
  assert.equal(outInt.sanitized_content, draftReply);
  assert.equal(outInt.external_ref, externalRef);

  // Verify idempotency on second call with same externalRef
  const { data: secondId, error: secondErr } = await service.rpc('record_ai_messenger_live_outbound', {
    p_company_id: COMPANY_ID,
    p_customer_id: CUSTOMER_ID,
    p_conversation_id: convId,
    p_source_interaction_id: interactionEnabledId,
    p_delivery_id: delivery.id,
    p_external_ref: externalRef,
    p_content: draftReply,
    p_actor_type: 'AI',
  });
  assert.ifError(secondErr);
  assert.equal(secondId, outboundIntId);

  // Verify outbound interaction did NOT trigger another delivery (Zero loop verification!)
  const { data: loopDelivery } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', outboundIntId)
    .maybeSingle();
  assert.equal(loopDelivery, null);

  // 8. Finish delivery
  const { data: finished, error: finErr } = await service.rpc('finish_ai_brain_live_delivery', {
    p_id: delivery.id,
    p_lock_token: lockToken,
    p_send_status: 'SENT',
    p_decision: 'RESPOND',
    p_confidence: 0.95,
    p_external_message_id: externalRef,
  });
  assert.ifError(finErr);
  assert.equal(finished, true);
});

test('AI Brain Messenger Live DB: Handover / Paused AI does not enqueue delivery', async () => {
  const pausedConvId = randomUUID();
  const { error: convErr } = await service.from('conversations').insert({
    id: pausedConvId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    channel: 'FACEBOOK',
    external_conversation_id: `page-123:paused-${pausedConvId.slice(0, 8)}`,
    status: 'OPEN',
    ai_mode: 'PAUSED', // AI is paused
  });
  assert.ifError(convErr);

  const interactionId = randomUUID();
  const { error: intErr } = await service.from('interactions').insert({
    id: interactionId,
    company_id: COMPANY_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: pausedConvId,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitized_content: 'Alo shop ơi có ai trực không?',
    sanitization_status: 'SUCCEEDED',
  });
  assert.ifError(intErr);

  // Assert NOT enqueued because AI is paused
  const { data: noDelivery } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', interactionId)
    .maybeSingle();
  assert.equal(noDelivery, null);
});
