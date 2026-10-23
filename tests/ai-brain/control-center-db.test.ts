import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error('AI Control Center DB test requires local Supabase env');
}

const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const FIXTURE_COMPANY_A_ID = '00000000-0000-4000-8000-000000000088';
const FIXTURE_COMPANY_B_ID = '00000000-0000-4000-8000-000000000089';
const FIXTURE_CUSTOMER_A_ID = '00000000-0000-4000-8000-000000000090';
const FIXTURE_CONVO_A_ID = '00000000-0000-4000-8000-000000000096';

let fixturePromise: Promise<void> | null = null;

async function provisionFixture(): Promise<void> {
  const companyInsert = await service
    .from('companies')
    .upsert(
      [
        { id: FIXTURE_COMPANY_A_ID, name: 'AI Control Center Fixture A', status: 'ACTIVE' },
        { id: FIXTURE_COMPANY_B_ID, name: 'AI Control Center Fixture B', status: 'ACTIVE' },
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
          customer_code: 'AI-CC-CUST-A',
          name: 'AI Control Center Customer A',
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
          id: FIXTURE_CONVO_A_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_id: FIXTURE_CUSTOMER_A_ID,
          external_conversation_id: 'ext-convo-a-control-center',
          channel: 'ZALO',
          status: 'OPEN',
          ai_mode: 'ACTIVE',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(conversationInsert.error);
}

function ensureFixture(): Promise<void> {
  if (!fixturePromise) fixturePromise = provisionFixture();
  return fixturePromise;
}

test('AI Control Center: multi-channel live settings and configuration constraints', async () => {
  await ensureFixture();

  // 1. Can upsert ZALO, MESSENGER, and VOICE settings
  const { error: zaloErr } = await service
    .from('ai_brain_live_settings')
    .upsert({
      company_id: FIXTURE_COMPANY_A_ID,
      channel: 'ZALO',
      enabled: true,
      min_confidence: 0.850,
      voice_mode: 'OFF',
      model_routing_profile: 'STANDARD',
    });
  assert.ifError(zaloErr);

  const { error: msgErr } = await service
    .from('ai_brain_live_settings')
    .upsert({
      company_id: FIXTURE_COMPANY_A_ID,
      channel: 'MESSENGER',
      enabled: true,
      min_confidence: 0.880,
      voice_mode: 'OFF',
      model_routing_profile: 'FAST',
    });
  assert.ifError(msgErr);

  const { error: voiceErr } = await service
    .from('ai_brain_live_settings')
    .upsert({
      company_id: FIXTURE_COMPANY_A_ID,
      channel: 'VOICE',
      enabled: false,
      min_confidence: 0.900,
      voice_mode: 'TEST',
      model_routing_profile: 'QUALITY',
    });
  assert.ifError(voiceErr);

  // 2. Reject unsupported channel
  const { error: invalidChanErr } = await service
    .from('ai_brain_live_settings')
    .insert({
      company_id: FIXTURE_COMPANY_A_ID,
      channel: 'TELEGRAM',
      enabled: true,
    });
  assert.ok(invalidChanErr, 'Expected invalid channel to be rejected');

  // 3. Reject invalid voice_mode
  const { error: invalidVoiceErr } = await service
    .from('ai_brain_live_settings')
    .upsert({
      company_id: FIXTURE_COMPANY_A_ID,
      channel: 'VOICE',
      voice_mode: 'INVALID_MODE',
    });
  assert.ok(invalidVoiceErr, 'Expected invalid voice_mode to be rejected');
});

test('AI Control Center: emergency kill switch disables all company live channels atomically', async () => {
  await ensureFixture();

  // Enable ZALO and MESSENGER for company A
  await service.from('ai_brain_live_settings').upsert([
    { company_id: FIXTURE_COMPANY_A_ID, channel: 'ZALO', enabled: true },
    { company_id: FIXTURE_COMPANY_A_ID, channel: 'MESSENGER', enabled: true },
    { company_id: FIXTURE_COMPANY_B_ID, channel: 'ZALO', enabled: true },
  ]);

  // Execute emergency kill switch for company A
  const { data: disabledCount, error: killErr } = await service.rpc('emergency_disable_ai', {
    p_company_id: FIXTURE_COMPANY_A_ID,
  });
  assert.ifError(killErr);
  assert.equal(disabledCount, 2);

  // Verify company A settings are disabled
  const { data: settingsA } = await service
    .from('ai_brain_live_settings')
    .select('channel, enabled')
    .eq('company_id', FIXTURE_COMPANY_A_ID);
  for (const s of settingsA || []) {
    assert.equal(s.enabled, false, `Expected channel ${s.channel} to be disabled`);
  }

  // Verify company B is unaffected
  const { data: settingsB } = await service
    .from('ai_brain_live_settings')
    .select('channel, enabled')
    .eq('company_id', FIXTURE_COMPANY_B_ID)
    .eq('channel', 'ZALO')
    .single();
  assert.equal(settingsB?.enabled, true, 'Company B should remain enabled');
});

test('AI Control Center: resolve_ai_handover_case settles case and enforces tenant isolation', async () => {
  await ensureFixture();

  // Create an interaction and handover case
  const interactionId = randomUUID();
  const { error: intErr } = await service.from('interactions').insert({
    id: interactionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_A_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Tôi muốn gặp quản lý khiếu nại dịch vụ.',
  });
  assert.ifError(intErr);

  const { data: caseId, error: caseErr } = await service.rpc('create_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_customer_id: FIXTURE_CUSTOMER_A_ID,
    p_conversation_id: FIXTURE_CONVO_A_ID,
    p_source_interaction_id: interactionId,
    p_reason: 'CUSTOMER_COMPLAINT',
    p_priority: 'HIGH',
    p_brain_turn_id: randomUUID(),
  });
  assert.ifError(caseErr);
  assert.ok(caseId);

  // Attempt to resolve with wrong company ID (Company B) -> should fail / return false
  const { data: wrongCompanyRes, error: wrongErr } = await service.rpc('resolve_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_B_ID,
    p_case_id: caseId,
  });
  assert.ifError(wrongErr);
  assert.equal(wrongCompanyRes, false, 'Resolving with wrong company must return false');

  // Resolve with correct company ID (Company A)
  const { data: resolveRes, error: resolveErr } = await service.rpc('resolve_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_case_id: caseId,
  });
  assert.ifError(resolveErr);
  assert.equal(resolveRes, true, 'Resolving with correct company must return true');

  // Verify status is RESOLVED with resolved_at populated
  const { data: resolvedCase } = await service
    .from('ai_handover_cases')
    .select('status, resolved_at')
    .eq('id', caseId)
    .single();
  assert.equal(resolvedCase?.status, 'RESOLVED');
  assert.ok(resolvedCase?.resolved_at);
});
