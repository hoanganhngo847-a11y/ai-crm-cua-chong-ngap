import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error('AI Brain handover DB test requires local Supabase env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY');
}

const parsedUrl = new URL(url);
if (!['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
  throw new Error(`Fail-closed: local Supabase URL required (localhost/127.0.0.1), got: ${parsedUrl.hostname}`);
}

const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// Deterministic Fixture IDs for Handover tests
const FIXTURE_COMPANY_A_ID = '00000000-0000-4000-8000-000000000088';
const FIXTURE_COMPANY_B_ID = '00000000-0000-4000-8000-000000000089';
const FIXTURE_CUSTOMER_A_ID = '00000000-0000-4000-8000-000000000090';
const FIXTURE_CONVO_HO_ID = '00000000-0000-4000-8000-000000000096';
const FIXTURE_USER_A_ID = '00000000-0000-4000-8000-000000000097';

let fixturePromise: Promise<void> | null = null;

let agentUserId: string;

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
          customer_code: 'AI-HO-CUST-A',
          name: 'AI Handover Customer A',
          source: 'MANUAL',
          stage: 'LEAD_NEW',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(customerInsert.error);

  // Check for existing active member in company A
  const { data: existingMember } = await service
    .from('company_members')
    .select('user_id')
    .eq('company_id', FIXTURE_COMPANY_A_ID)
    .eq('status', 'ACTIVE')
    .limit(1)
    .maybeSingle();

  if (existingMember?.user_id) {
    agentUserId = existingMember.user_id;
  } else {
    // Create an auth user for agent
    const email = `agent-support-${randomUUID().slice(0, 8)}@example.com`;
    const { data: authData, error: authErr } = await service.auth.admin.createUser({
      email,
      password: 'Password123!',
      email_confirm: true,
    });
    assert.ifError(authErr);
    agentUserId = authData.user.id;

    const userProfileInsert = await service
      .from('user_profiles')
      .upsert({
        id: agentUserId,
        full_name: 'Agent Support A',
        status: 'ACTIVE',
      });
    assert.ifError(userProfileInsert.error);

    const memberInsert = await service
      .from('company_members')
      .upsert({
        company_id: FIXTURE_COMPANY_A_ID,
        user_id: agentUserId,
        role: 'SALE',
        status: 'ACTIVE',
      });
    assert.ifError(memberInsert.error);
  }

  const conversationInsert = await service
    .from('conversations')
    .upsert(
      [
        {
          id: FIXTURE_CONVO_HO_ID,
          company_id: FIXTURE_COMPANY_A_ID,
          customer_id: FIXTURE_CUSTOMER_A_ID,
          channel: 'ZALO',
          external_conversation_id: 'ext-zl-ho-a',
          status: 'OPEN',
          ai_mode: 'ACTIVE',
        },
      ],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(conversationInsert.error);

  // Enable live settings for company A
  await service
    .from('ai_brain_live_settings')
    .upsert({
      company_id: FIXTURE_COMPANY_A_ID,
      channel: 'ZALO',
      enabled: true,
      min_confidence: 0.85,
    });
}

function ensureFixture(): Promise<void> {
  if (!fixturePromise) {
    fixturePromise = provisionFixture();
  }
  return fixturePromise;
}

test('A: create_ai_handover_case creates case, updates conversation to PENDING_SALE & ai_mode PAUSED, and inserts interaction', async () => {
  await ensureFixture();

  const sourceInteractionId = randomUUID();
  const insertInt = await service.from('interactions').insert({
    id: sourceInteractionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_HO_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Tôi muốn khiếu nại chất lượng sản phẩm!',
  });
  assert.ifError(insertInt.error);

  // Call create_ai_handover_case RPC
  const { data: caseId, error: caseErr } = await service.rpc('create_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_customer_id: FIXTURE_CUSTOMER_A_ID,
    p_conversation_id: FIXTURE_CONVO_HO_ID,
    p_source_interaction_id: sourceInteractionId,
    p_reason: 'CUSTOMER_COMPLAINT',
    p_priority: 'HIGH',
    p_brain_turn_id: randomUUID(),
    p_metadata: { source: 'unit_test' },
  });
  assert.ifError(caseErr);
  assert.ok(caseId);

  // 1. Verify ai_handover_cases row
  const { data: caseRow } = await service
    .from('ai_handover_cases')
    .select('*')
    .eq('id', caseId)
    .single();

  assert.ok(caseRow);
  assert.equal(caseRow.company_id, FIXTURE_COMPANY_A_ID);
  assert.equal(caseRow.conversation_id, FIXTURE_CONVO_HO_ID);
  assert.equal(caseRow.reason, 'CUSTOMER_COMPLAINT');
  assert.equal(caseRow.priority, 'HIGH');
  assert.equal(caseRow.status, 'OPEN');
  assert.equal(caseRow.assigned_to, null);
  assert.equal(caseRow.claimed_at, null);
  assert.equal(caseRow.resolved_at, null);

  // 2. Verify conversation state updated
  const { data: convoRow } = await service
    .from('conversations')
    .select('status, ai_mode')
    .eq('id', FIXTURE_CONVO_HO_ID)
    .single();

  assert.equal(convoRow?.status, 'PENDING_SALE');
  assert.equal(convoRow?.ai_mode, 'PAUSED');

  // 3. Verify interaction status event was inserted
  const { data: timelineInteractions } = await service
    .from('interactions')
    .select('*')
    .eq('conversation_id', FIXTURE_CONVO_HO_ID)
    .eq('type', 'STATUS_EVENT')
    .eq('external_ref', `handover:${sourceInteractionId}`);

  assert.equal(timelineInteractions?.length, 1);
  assert.equal(timelineInteractions?.[0].actor_type, 'AI');
  assert.ok(timelineInteractions?.[0].sanitized_content.includes('CUSTOMER_COMPLAINT'));
});

test('B: Idempotency: duplicate create_ai_handover_case calls do not duplicate cases', async () => {
  await ensureFixture();

  const sourceInteractionId = randomUUID();
  await service.from('interactions').insert({
    id: sourceInteractionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_HO_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Tôi muốn hoàn tiền ngay!',
  });

  const { data: caseId1 } = await service.rpc('create_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_customer_id: FIXTURE_CUSTOMER_A_ID,
    p_conversation_id: FIXTURE_CONVO_HO_ID,
    p_source_interaction_id: sourceInteractionId,
    p_reason: 'REFUND_REQUEST',
    p_priority: 'URGENT',
  });

  const { data: caseId2 } = await service.rpc('create_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_customer_id: FIXTURE_CUSTOMER_A_ID,
    p_conversation_id: FIXTURE_CONVO_HO_ID,
    p_source_interaction_id: sourceInteractionId,
    p_reason: 'REFUND_REQUEST',
    p_priority: 'URGENT',
  });

  assert.equal(caseId1, caseId2);

  const { data: cases } = await service
    .from('ai_handover_cases')
    .select('id')
    .eq('source_interaction_id', sourceInteractionId);

  assert.equal(cases?.length, 1);
});

test('C: claim_ai_handover_case claims open case, assigns to agent, and prevents double claiming', async () => {
  await ensureFixture();

  const sourceInteractionId = randomUUID();
  await service.from('interactions').insert({
    id: sourceInteractionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_HO_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Gặp nhân viên tư vấn',
  });

  const { data: caseId } = await service.rpc('create_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_customer_id: FIXTURE_CUSTOMER_A_ID,
    p_conversation_id: FIXTURE_CONVO_HO_ID,
    p_source_interaction_id: sourceInteractionId,
    p_reason: 'CUSTOMER_REQUESTED_HUMAN',
    p_priority: 'NORMAL',
  });

  // First claim by user A: must succeed
  const { data: claimSuccess1, error: claimErr1 } = await service.rpc('claim_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_case_id: caseId,
    p_user_id: agentUserId,
  });
  assert.ifError(claimErr1);
  assert.equal(claimSuccess1, true);

  // Verify case state is CLAIMED
  const { data: claimedCase } = await service
    .from('ai_handover_cases')
    .select('*')
    .eq('id', caseId)
    .single();

  assert.equal(claimedCase?.status, 'CLAIMED');
  assert.equal(claimedCase?.assigned_to, agentUserId);
  assert.ok(claimedCase?.claimed_at);

  // Verify conversation has assigned_to set and ai_mode = PAUSED
  const { data: convo } = await service
    .from('conversations')
    .select('assigned_to, ai_mode')
    .eq('id', FIXTURE_CONVO_HO_ID)
    .single();

  assert.equal(convo?.assigned_to, agentUserId);
  assert.equal(convo?.ai_mode, 'PAUSED');

  // Second claim: must return false (already claimed)
  const { data: claimSuccess2 } = await service.rpc('claim_ai_handover_case', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_case_id: caseId,
    p_user_id: agentUserId,
  });
  assert.equal(claimSuccess2, false);
});

test('D: resume_ai_conversation sets ai_mode = ACTIVE, clears assigned_to, and resolves handover cases', async () => {
  await ensureFixture();

  const { data: resumeSuccess, error: resumeErr } = await service.rpc('resume_ai_conversation', {
    p_company_id: FIXTURE_COMPANY_A_ID,
    p_conversation_id: FIXTURE_CONVO_HO_ID,
    p_user_id: agentUserId,
  });
  assert.ifError(resumeErr);
  assert.equal(resumeSuccess, true);

  // 1. Verify conversation is restored
  const { data: convo } = await service
    .from('conversations')
    .select('status, ai_mode, assigned_to')
    .eq('id', FIXTURE_CONVO_HO_ID)
    .single();

  assert.equal(convo?.ai_mode, 'ACTIVE');
  assert.equal(convo?.assigned_to, null);
  assert.equal(convo?.status, 'OPEN');

  // 2. Verify all cases for this conversation are resolved
  const { data: openCases } = await service
    .from('ai_handover_cases')
    .select('id, status, resolved_at')
    .eq('conversation_id', FIXTURE_CONVO_HO_ID)
    .in('status', ['OPEN', 'CLAIMED']);

  assert.equal(openCases?.length, 0);

  // 3. Verify interaction status event was recorded
  const { data: resumeTimeline } = await service
    .from('interactions')
    .select('*')
    .eq('conversation_id', FIXTURE_CONVO_HO_ID)
    .eq('type', 'STATUS_EVENT')
    .eq('actor_type', 'SYSTEM')
    .order('created_at', { ascending: false })
    .limit(1);

  assert.ok(resumeTimeline?.[0].sanitized_content.includes('AI Auto-Reply đã được kích hoạt lại'));
});

test('E: Enqueue Guard: ai_mode = PAUSED halts live delivery enqueueing for new messages', async () => {
  await ensureFixture();

  // Explicitly pause conversation
  await service
    .from('conversations')
    .update({ ai_mode: 'PAUSED', status: 'OPEN', assigned_to: null })
    .eq('id', FIXTURE_CONVO_HO_ID);

  const newInteractionId = randomUUID();
  const insertRes = await service.from('interactions').insert({
    id: newInteractionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_HO_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Tin nhắn khi AI đang paused',
  });
  assert.ifError(insertRes.error);

  // Verify it did NOT enqueue into ai_brain_live_deliveries
  const { data: delivery } = await service
    .from('ai_brain_live_deliveries')
    .select('id')
    .eq('source_interaction_id', newInteractionId);

  assert.equal(delivery?.length, 0);

  // Resume AI
  await service
    .from('conversations')
    .update({ ai_mode: 'ACTIVE', status: 'OPEN', assigned_to: null })
    .eq('id', FIXTURE_CONVO_HO_ID);

  // Now a new message should enqueue!
  const resumedInteractionId = randomUUID();
  await service.from('interactions').insert({
    id: resumedInteractionId,
    company_id: FIXTURE_COMPANY_A_ID,
    customer_id: FIXTURE_CUSTOMER_A_ID,
    conversation_id: FIXTURE_CONVO_HO_ID,
    channel: 'ZALO',
    type: 'MESSAGE',
    direction: 'INBOUND',
    actor_type: 'CUSTOMER',
    sanitization_status: 'SUCCEEDED',
    sanitized_content: 'Tin nhắn khi AI đã resume',
  });

  const { data: deliveryResumed } = await service
    .from('ai_brain_live_deliveries')
    .select('id, send_status')
    .eq('source_interaction_id', resumedInteractionId);

  assert.equal(deliveryResumed?.length, 1);
  assert.equal(deliveryResumed?.[0].send_status, 'PENDING');
});

test('F: Security & RLS: anon cannot read or delete ai_handover_cases', async () => {
  await ensureFixture();

  // Anon select denied
  const { data: anonData, error: anonErr } = await anon
    .from('ai_handover_cases')
    .select('id');

  assert.equal(anonData?.length ?? 0, 0);

  // Service role delete denied
  const { error: delErr } = await service
    .from('ai_handover_cases')
    .delete()
    .eq('company_id', FIXTURE_COMPANY_A_ID);

  assert.ok(delErr, 'DELETE must be revoked from ai_handover_cases');
});
