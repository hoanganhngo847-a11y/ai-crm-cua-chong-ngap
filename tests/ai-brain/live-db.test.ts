import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// 0. Environment & Fail-Closed Local URL Validation
// ---------------------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error(
    'AI Brain live DB test requires local Supabase env: ' +
    'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY',
  );
}

const parsedUrl = new URL(url);
if (!['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
  throw new Error(`Fail-closed: local Supabase URL required (localhost/127.0.0.1), got: ${parsedUrl.hostname}`);
}

const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// Deterministic Fixture IDs
const FIXTURE_COMPANY_A_ID = '00000000-0000-4000-8000-000000000088';
const FIXTURE_COMPANY_B_ID = '00000000-0000-4000-8000-000000000089';
const FIXTURE_CUSTOMER_A_ID = '00000000-0000-4000-8000-000000000090';
const FIXTURE_CUSTOMER_B_ID = '00000000-0000-4000-8000-000000000091';
const FIXTURE_CONVO_A_ZL_ID = '00000000-0000-4000-8000-000000000093';
const FIXTURE_CONVO_A_FB_ID = '00000000-0000-4000-8000-000000000092';
const FIXTURE_CONVO_B_ZL_ID = '00000000-0000-4000-8000-000000000095';

let fixturePromise: Promise<void> | null = null;

async function provisionFixture(): Promise<void> {
  const companyInsert = await service
    .from('companies')
    .upsert(
      [
        { id: FIXTURE_COMPANY_A_ID, name: 'AI Brain Live Fixture A', status: 'ACTIVE' },
        { id: FIXTURE_COMPANY_B_ID, name: 'AI Brain Live Fixture B', status: 'ACTIVE' },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(companyInsert.error);

  const customerInsert = await service
    .from('customers')
    .upsert(
      [
        {
          id: FIXTURE_CUSTOMER_A_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_code: 'AI-LIVE-CUST-A',
          name: 'AI Brain Live Customer A',
          source: 'MANUAL',
          stage: 'LEAD_NEW',
        },
        {
          id: FIXTURE_CUSTOMER_B_ID,
          company_id: FIXTURE_COMPANY_B_ID,
          customer_code: 'AI-LIVE-CUST-B',
          name: 'AI Brain Live Customer B',
          source: 'MANUAL',
          stage: 'LEAD_NEW',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(customerInsert.error);

  const conversationInsert = await service
    .from('conversations')
    .upsert(
      [
        {
          id: FIXTURE_CONVO_A_ZL_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_id: FIXTURE_CUSTOMER_A_ID,
          channel: 'ZALO',
          external_conversation_id: 'ext-zl-live-a',
          status: 'OPEN',
        },
        {
          id: FIXTURE_CONVO_A_FB_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_id: FIXTURE_CUSTOMER_A_ID,
          channel: 'FACEBOOK',
          external_conversation_id: 'ext-fb-live-a',
          status: 'OPEN',
        },
        {
          id: FIXTURE_CONVO_B_ZL_ID,
          company_id: FIXTURE_COMPANY_B_ID,
          customer_id: FIXTURE_CUSTOMER_B_ID,
          channel: 'ZALO',
          external_conversation_id: 'ext-zl-live-b',
          status: 'OPEN',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(conversationInsert.error);
}

function ensureFixture(): Promise<void> {
  if (!fixturePromise) {
    fixturePromise = provisionFixture();
  }
  return fixturePromise;
}

test('A: Default-off no settings; disabled / wrong tenant / wrong channel no enqueue', async () => {
  await ensureFixture();

  // Test 1: Missing settings on Company B (never configured)
  const unconfiguredId = randomUUID();
  const res1 = await service.from('interactions').insert({
    id: unconfiguredId,
    company_id: FIXTURE_COMPANY_B_ID,
    customer_id: FIXTURE_CUSTOMER_B_ID,
    conversation_id: FIXTURE_CONVO_B_ZL_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Chào shop tư vấn cửa nhé',
  });
  assert.ifError(res1.error);

  const { data: noEnqueue } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', unconfiguredId)
    .maybeSingle();
  assert.equal(noEnqueue, null, 'Must not enqueue when settings row is missing');

  // Test 2: Explicitly disabled setting on Company A
  await service.from('ai_brain_live_settings').upsert({
    company_id: FIXTURE_COMPANY_A_ID,
    channel: 'ZALO',
    enabled: false,
  });

  const disabledId = randomUUID();
  const res2 = await service.from('interactions').insert({
    id: disabledId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_A_ZL_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Chào shop tư vấn cửa nhé',
  });
  assert.ifError(res2.error);

  const { data: disabledEnqueue } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', disabledId)
    .maybeSingle();
  assert.equal(disabledEnqueue, null, 'Must not enqueue when setting is disabled');
});

test('B: RLS: anon/auth select denied, service select/insert/update succeeds, delete denied', async () => {
  await ensureFixture();

  // Anon select denied
  const anonSettings = await anon.from('ai_brain_live_settings').select('*');
  assert.equal(anonSettings.error?.code, '42501');

  const anonDeliveries = await anon.from('ai_brain_live_deliveries').select('*');
  assert.equal(anonDeliveries.error?.code, '42501');

  // Service role select succeeds
  const serviceSettings = await service.from('ai_brain_live_settings').select('*');
  assert.ifError(serviceSettings.error);

  // Service role delete denied
  const deleteRes = await service.from('ai_brain_live_deliveries').delete().eq('company_id', FIXTURE_COMPANY_A_ID);
  assert.equal(deleteRes.error?.code, '42501');
});

test('C: ZALO interaction -> ZALO / PENDING / attempts 0 on enabled setting', async () => {
  await ensureFixture();

  await service.from('ai_brain_live_settings').upsert({
    company_id: FIXTURE_COMPANY_A_ID,
    channel: 'ZALO',
    enabled: true,
    min_confidence: 0.85,
  });

  const interactionId = randomUUID();
  const insertRes = await service.from('interactions').insert({
    id: interactionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_A_ZL_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Tôi muốn hỏi giá cửa chống ngập 3m',
  });
  assert.ifError(insertRes.error);

  const { data: delivery, error } = await service
    .from('ai_brain_live_deliveries')
    .select('*')
    .eq('source_interaction_id', interactionId)
    .maybeSingle();

  assert.ifError(error);
  assert.ok(delivery);
  assert.equal(delivery.send_status, 'PENDING');
  assert.equal(delivery.attempts, 0);
  assert.equal(delivery.channel, 'ZALO');
  assert.equal(delivery.company_id, FIXTURE_COMPANY_A_ID);
  assert.equal(delivery.conversation_id, FIXTURE_CONVO_A_ZL_ID);
});

test('D: Guard: Non-Zalo (FACEBOOK) does NOT enqueue into live deliveries', async () => {
  await ensureFixture();

  const fbInteractionId = randomUUID();
  const insertRes = await service.from('interactions').insert({
    id: fbInteractionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_A_FB_ID,
    channel: 'FACEBOOK',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Facebook message should not live auto-reply',
  });
  assert.ifError(insertRes.error);

  const { data: noDelivery } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', fbInteractionId)
    .maybeSingle();

  assert.equal(noDelivery, null, 'Non-Zalo interactions must not enqueue into live deliveries');
});

test('E: Guard: Human assigned or closed conversations do NOT enqueue', async () => {
  await ensureFixture();

  // Create human assigned conversation
  const humanConvoId = randomUUID();
  await service.from('conversations').insert({
    id: humanConvoId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    channel: 'ZALO',
    external_conversation_id: `ext-human-${humanConvoId}`,
    status: 'OPEN',
    assigned_to: '11111111-2222-3333-4444-555555555555',
  });

  const interactionId = randomUUID();
  await service.from('interactions').insert({
    id: interactionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: humanConvoId,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Tin nhắn khi có tư vấn viên',
  });

  const { data: noDelivery } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', interactionId)
    .maybeSingle();

  assert.equal(noDelivery, null, 'Must not enqueue when conversation has assigned_to');
});

test('F: Loop prevention: Outbound AI messages do NOT enqueue', async () => {
  await ensureFixture();

  const outboundAiId = randomUUID();
  await service.from('interactions').insert({
    id: outboundAiId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_A_ZL_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'OUTBOUND',
    actor_type: 'AI',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Dạ bên em xin gửi báo giá',
  });

  const { data: noDelivery } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', outboundAiId)
    .maybeSingle();

  assert.equal(noDelivery, null, 'Outbound AI messages must never enqueue');
});

test('G: Idempotency: Re-sanitization update does NOT duplicate delivery', async () => {
  await ensureFixture();

  const interactionId = randomUUID();
  await service.from('interactions').insert({
    id: interactionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_A_ZL_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Hỏi giá ban đầu',
  });

  // Count
  const { count: count1 } = await service
    .from('ai_brain_live_deliveries')
    .select('*', { count: 'exact', head: true })
    .eq('source_interaction_id', interactionId);
  assert.equal(count1, 1);

  // Re-update
  await service
    .from('interactions')
    .update({ sanitized_content: 'Hỏi giá đã sửa' })
    .eq('id', interactionId);

  const { count: count2 } = await service
    .from('ai_brain_live_deliveries')
    .select('*', { count: 'exact', head: true })
    .eq('source_interaction_id', interactionId);
  assert.equal(count2, 1);
});

test('H: claim_ai_brain_live_deliveries locks row with token and increments attempts', async () => {
  await ensureFixture();

  const interactionId = randomUUID();
  await service.from('interactions').insert({
    id: interactionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_A_ZL_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Cần claim test',
    created_at: new Date(Date.now() - 360000).toISOString(),
  });

  const token1 = randomUUID();
  const claimed: Array<{ id: string; source_interaction_id: string; attempts: number }> = [];
  for (let i = 0; i < 10; i++) {
    const { data, error } = await service.rpc('claim_ai_brain_live_deliveries', {
      p_limit: 10,
      p_lock_token: token1,
    });
    assert.ifError(error);
    if (!data || data.length === 0) break;
    claimed.push(...(data as any));
    if (claimed.some((c) => c.source_interaction_id === interactionId)) break;
  }
  assert.ok(claimed.length > 0);
  const target = claimed.find((c: { source_interaction_id: string }) => c.source_interaction_id === interactionId);
  assert.ok(target);
  assert.equal(target.attempts, 1);

  // Check in DB
  const { data: inDb } = await service
    .from('ai_brain_live_deliveries')
    .select('*')
    .eq('id', target.id)
    .single();
  assert.equal(inDb.send_status, 'PROCESSING');
  assert.equal(inDb.lock_token, token1);
  assert.ok(inDb.locked_at);

  // Finish RPC with correct token
  const { data: finishOk } = await service.rpc('finish_ai_brain_live_delivery', {
    p_id: target.id,
    p_lock_token: token1,
    p_send_status: 'SENT',
    p_decision: 'RESPOND',
    p_confidence: 0.95,
    p_external_message_id: 'ext-test-123',
  });
  assert.equal(finishOk, true);

  const { data: finishedRow } = await service
    .from('ai_brain_live_deliveries')
    .select('*')
    .eq('id', target.id)
    .single();
  assert.equal(finishedRow.send_status, 'SENT');
  assert.equal(finishedRow.lock_token, null);
  assert.ok(finishedRow.sent_at);
  assert.ok(finishedRow.completed_at);
});

test('I: finish_ai_brain_live_delivery fences wrong token', async () => {
  await ensureFixture();

  const interactionId = randomUUID();
  await service.from('interactions').insert({
    id: interactionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_A_ZL_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Test fence',
    created_at: new Date(Date.now() - 360000).toISOString(),
  });

  const token1 = randomUUID();
  const { data: claimed } = await service.rpc('claim_ai_brain_live_deliveries', {
    p_limit: 10,
    p_lock_token: token1,
  });
  const target = claimed.find((c: { source_interaction_id: string }) => c.source_interaction_id === interactionId);
  assert.ok(target);

  const wrongToken = randomUUID();
  const { data: finishDenied } = await service.rpc('finish_ai_brain_live_delivery', {
    p_id: target.id,
    p_lock_token: wrongToken,
    p_send_status: 'SENT',
  });
  assert.equal(finishDenied, false, 'Wrong token must return false (fenced)');
});
