import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';

const COMPANY_ID = '00000000-0000-4000-8000-000000000096';
const OTHER_COMPANY_ID = '00000000-0000-4000-8000-000000000099';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000097';
const PAGE_ID = '987654321012345';

test('AI Brain Messenger Live DB: strict canary allowlist, enqueue trigger, dispatch fence, claim, and outbound recording', async () => {
  const harness = await createPgliteSupabase();
  const { db, client: service } = harness;

  try {
    // 1. Provision companies & customer
    await db.query(
      `INSERT INTO public.companies (id, name, status) VALUES ($1, 'AI Messenger DB Fixture Co', 'ACTIVE'), ($2, 'Other Co', 'ACTIVE') ON CONFLICT DO NOTHING`,
      [COMPANY_ID, OTHER_COMPANY_ID],
    );

    await db.query(
      `INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
       VALUES ($1, $2, 'MSGR-CUST-1', 'Messenger Customer Test', 'MANUAL', 'LEAD_NEW')
       ON CONFLICT DO NOTHING`,
      [CUSTOMER_ID, COMPANY_ID],
    );

    // 2. Create a Facebook conversation with numeric Page identity and numeric PSID
    const convId = randomUUID();
    const { error: convErr } = await service.from('conversations').insert({
      id: convId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      external_conversation_id: `${PAGE_ID}:87654321098765001`,
      status: 'OPEN',
      ai_mode: 'ACTIVE',
    });
    assert.ifError(convErr);

    // 3. Ensure MESSENGER live setting is disabled first
    await db.query(
      `INSERT INTO public.ai_brain_live_settings (company_id, channel, enabled, min_confidence)
       VALUES ($1, 'MESSENGER', false, 0.85)
       ON CONFLICT (company_id, channel) DO UPDATE SET enabled = false`,
      [COMPANY_ID],
    );

    // 4. Inbound customer message when MESSENGER setting is disabled -> NOT enqueued
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
      sanitized_content: 'Chào shop, em cần tư vấn thông tin dịch vụ',
      sanitization_status: 'SUCCEEDED',
    });
    assert.ifError(int1Err);

    const { data: noDelivery1 } = await service
      .from('ai_brain_live_deliveries')
      .select('id')
      .eq('source_interaction_id', interactionDisabledId)
      .maybeSingle();
    assert.equal(noDelivery1, null);

    // 5. Enable MESSENGER live setting, BUT canary allowlist has NO entry for this conversation!
    await db.query(
      `INSERT INTO public.ai_brain_live_settings (company_id, channel, enabled, min_confidence)
       VALUES ($1, 'MESSENGER', true, 0.85)
       ON CONFLICT (company_id, channel) DO UPDATE SET enabled = true`,
      [COMPANY_ID],
    );

    const interactionCanaryDeniedId = randomUUID();
    const { error: intCanaryErr } = await service.from('interactions').insert({
      id: interactionCanaryDeniedId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: convId,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Shop ơi tư vấn giúp em với',
      sanitization_status: 'SUCCEEDED',
    });
    assert.ifError(intCanaryErr);

    // Strict Canary Check: Must NOT enqueue because conversation is not allowlisted!
    const { data: noDeliveryCanary } = await service
      .from('ai_brain_live_deliveries')
      .select('id')
      .eq('source_interaction_id', interactionCanaryDeniedId)
      .maybeSingle();
    assert.equal(noDeliveryCanary, null, 'Unallowlisted customer message must default-deny and NOT enqueue');

    // 6. Canary check constraint: Non-numeric page ID must fail
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.ai_brain_live_canary_allowlist (company_id, channel, conversation_id, page_id)
           VALUES ($1, 'MESSENGER', $2, 'non-numeric-page')`,
          [COMPANY_ID, convId],
        );
      },
      /chk_ai_brain_live_canary_page_id_numeric/,
      'Canary allowlist must reject non-numeric page identity'
    );

    // 7. Canary composite FK: Conversation from different company must fail FK constraint
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.ai_brain_live_canary_allowlist (company_id, channel, conversation_id, page_id)
           VALUES ($1, 'MESSENGER', $2, $3)`,
          [OTHER_COMPANY_ID, convId, PAGE_ID], // Mismatched company_id for convId!
        );
      },
      /fk_ai_brain_live_canary_conversation/,
      'Canary allowlist must enforce composite FK (company_id, conversation_id)'
    );

    // 8. Explicitly allowlist this conversation + page in canary allowlist
    const { error: canaryInsertErr } = await service.from('ai_brain_live_canary_allowlist').insert({
      company_id: COMPANY_ID,
      channel: 'MESSENGER',
      conversation_id: convId,
      page_id: PAGE_ID,
      enabled: true,
    });
    assert.ifError(canaryInsertErr);

    // 9. Insert inbound message NOW that it is allowlisted
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
      .select('id, company_id, customer_id, conversation_id, source_interaction_id, channel, send_status, attempts')
      .eq('source_interaction_id', interactionEnabledId)
      .maybeSingle();
    assert.ifError(delErr);
    assert.ok(delivery);
    assert.equal(delivery.company_id, COMPANY_ID);
    assert.equal(delivery.conversation_id, convId);
    assert.equal(delivery.channel, 'MESSENGER');
    assert.equal(delivery.send_status, 'PENDING');
    assert.equal(delivery.attempts, 0);

    // 10. Claim using claim_ai_brain_live_deliveries with p_channel = 'MESSENGER'
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
    assert.equal(myClaim.attempts, 1);

    // 11. Test start_ai_messenger_live_dispatch atomic fence RPC
    // Attempt with wrong lock token -> must return false (denied)
    const { data: fenceDeniedWrongToken } = await service.rpc('start_ai_messenger_live_dispatch', {
      p_delivery_id: delivery.id,
      p_lock_token: randomUUID(), // Wrong token!
      p_company_id: COMPANY_ID,
      p_customer_id: CUSTOMER_ID,
      p_conversation_id: convId,
      p_source_interaction_id: interactionEnabledId,
      p_page_id: PAGE_ID,
      p_min_confidence: 0.85,
      p_turn_confidence: 0.9,
    });
    assert.equal(fenceDeniedWrongToken, false, 'Fence must deny wrong lock token');

    // Attempt with valid parameters -> must return true (acquired) and mark dispatch_started_at
    const { data: fenceAcquired, error: fenceErr } = await service.rpc('start_ai_messenger_live_dispatch', {
      p_delivery_id: delivery.id,
      p_lock_token: lockToken,
      p_company_id: COMPANY_ID,
      p_customer_id: CUSTOMER_ID,
      p_conversation_id: convId,
      p_source_interaction_id: interactionEnabledId,
      p_page_id: PAGE_ID,
      p_min_confidence: 0.85,
      p_turn_confidence: 0.9,
    });
    assert.ifError(fenceErr);
    assert.equal(fenceAcquired, true, 'Fence must be acquired on valid claim');

    // Verify dispatch_started_at is set on delivery row
    const { data: markedDelivery } = await service
      .from('ai_brain_live_deliveries')
      .select('dispatch_started_at')
      .eq('id', delivery.id)
      .single();
    assert.ok(markedDelivery?.dispatch_started_at, 'dispatch_started_at must be populated');

    // Attempt to fence again -> must return false (UPDATE marker atomically only once!)
    const { data: fenceAgain } = await service.rpc('start_ai_messenger_live_dispatch', {
      p_delivery_id: delivery.id,
      p_lock_token: lockToken,
      p_company_id: COMPANY_ID,
      p_customer_id: CUSTOMER_ID,
      p_conversation_id: convId,
      p_source_interaction_id: interactionEnabledId,
      p_page_id: PAGE_ID,
      p_min_confidence: 0.85,
      p_turn_confidence: 0.9,
    });
    assert.equal(fenceAgain, false, 'Second fence call must return false (atomic once)');

    // 12. Test record_ai_messenger_live_outbound RPC
    const rawMid = `mid-fb-${randomUUID()}`;
    const externalRef = `meta:${PAGE_ID}:${rawMid}`;
    const draftReply = 'Dạ chào anh/chị, em là trợ lý AI hỗ trợ tư vấn dịch vụ.';
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

    // Verify timeline interaction was created with direction = 'OUTBOUND', actor_type = 'AI', channel = 'FACEBOOK'
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

    // Verify delivery external_message_id stores raw MID and outbound_interaction_id is bound atomically
    const { data: updatedDelivery } = await service
      .from('ai_brain_live_deliveries')
      .select('external_message_id, outbound_interaction_id')
      .eq('id', delivery.id)
      .single();
    assert.ok(updatedDelivery);
    assert.equal(updatedDelivery.external_message_id, rawMid);
    assert.equal(updatedDelivery.outbound_interaction_id, outboundIntId);

    // Verify idempotency on second call with same externalRef (before finish)
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

    // Attempting to record outbound for same delivery with a DIFFERENT externalRef must be rejected
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.record_ai_messenger_live_outbound($1, $2, $3, $4, $5, $6, $7, 'AI')`,
          [
            COMPANY_ID,
            CUSTOMER_ID,
            convId,
            interactionEnabledId,
            delivery.id,
            `meta:${PAGE_ID}:different-unrelated-ref`,
            'Different reply content',
          ],
        );
      },
      /DELIVERY_ALREADY_BOUND_TO_DIFFERENT_REF/,
      'Cannot bind second unrelated externalRef to same delivery'
    );

    // Negative test: record_ai_messenger_live_outbound with wrong Page in externalRef must fail PAGE_MISMATCH
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.record_ai_messenger_live_outbound($1, $2, $3, $4, $5, $6, $7, 'AI')`,
          [
            COMPANY_ID,
            CUSTOMER_ID,
            convId,
            interactionEnabledId,
            delivery.id,
            `meta:123450000000000:${rawMid}`,
            draftReply,
          ],
        );
      },
      /PAGE_MISMATCH/,
      'Wrong Page in externalRef must be rejected'
    );

    // Negative test: non-canonical raw ref format rejected
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.record_ai_messenger_live_outbound($1, $2, $3, $4, $5, $6, $7, 'AI')`,
          [
            COMPANY_ID,
            CUSTOMER_ID,
            convId,
            interactionEnabledId,
            delivery.id,
            rawMid,
            draftReply,
          ],
        );
      },
      /INVALID_EXTERNAL_REF_FORMAT/,
      'Raw ref fallback must not be accepted'
    );

    // Negative test: empty raw MID rejected
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.record_ai_messenger_live_outbound($1, $2, $3, $4, $5, $6, $7, 'AI')`,
          [
            COMPANY_ID,
            CUSTOMER_ID,
            convId,
            interactionEnabledId,
            delivery.id,
            `meta:${PAGE_ID}:   `,
            draftReply,
          ],
        );
      },
      /EMPTY_RAW_MID/,
      'Whitespace-only raw MID must be rejected'
    );
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.record_ai_messenger_live_outbound($1, $2, $3, $4, $5, $6, $7, 'AI')`,
          [
            COMPANY_ID,
            CUSTOMER_ID,
            convId,
            interactionEnabledId,
            delivery.id,
            `meta:${PAGE_ID}:`,
            draftReply,
          ],
        );
      },
      /INVALID_EXTERNAL_REF_FORMAT/,
      'Empty raw MID format must be rejected'
    );

    // Negative test: actor_type other than AI rejected
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.record_ai_messenger_live_outbound($1, $2, $3, $4, $5, $6, $7, 'USER')`,
          [
            COMPANY_ID,
            CUSTOMER_ID,
            convId,
            interactionEnabledId,
            delivery.id,
            externalRef,
            draftReply,
          ],
        );
      },
      /INVALID_ACTOR_TYPE/,
      'Non-AI actor type must be rejected'
    );

    // Negative test: cannot record outbound on delivery without authorized dispatch_started_at (PENDING / unmarked)
    const unmarkedSourceId = randomUUID();
    await db.query(
      `INSERT INTO public.interactions (id, company_id, customer_id, conversation_id, channel, type, direction, actor_type, sanitized_content, sanitization_status, created_at)
       VALUES ($1, $2, $3, $4, 'FACEBOOK', 'MESSAGE', 'INBOUND', 'CUSTOMER', 'Unmarked msg', 'SUCCEEDED', clock_timestamp())`,
      [unmarkedSourceId, COMPANY_ID, CUSTOMER_ID, convId],
    );
    // Find the auto-enqueued delivery (which is PENDING with dispatch_started_at IS NULL)
    const { data: unmarkedDelivery } = await service
      .from('ai_brain_live_deliveries')
      .select('id')
      .eq('source_interaction_id', unmarkedSourceId)
      .single();
    assert.ok(unmarkedDelivery);

    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.record_ai_messenger_live_outbound($1, $2, $3, $4, $5, $6, $7, 'AI')`,
          [
            COMPANY_ID,
            CUSTOMER_ID,
            convId,
            unmarkedSourceId,
            unmarkedDelivery.id,
            `meta:${PAGE_ID}:unmarked-mid-${randomUUID()}`,
            draftReply,
          ],
        );
      },
      /DISPATCH_NOT_AUTHORIZED/,
      'Delivery without dispatch_started_at must be rejected'
    );

    // Negative test: conflicting existing interaction with same raw MID under wrong Page, wrong actor, or wrong direction
    const conflictMid = `mid-conflict-${randomUUID()}`;
    await db.query(
      `INSERT INTO public.interactions (id, company_id, customer_id, conversation_id, channel, type, direction, actor_type, sanitized_content, sanitization_status, external_ref, created_at)
       VALUES ($1, $2, $3, $4, 'FACEBOOK', 'MESSAGE', 'INBOUND', 'CUSTOMER', 'Conflicting inbound', 'SUCCEEDED', $5, clock_timestamp())`,
      [randomUUID(), COMPANY_ID, CUSTOMER_ID, convId, `meta:${PAGE_ID}:${conflictMid}`],
    );

    const conflictSourceId = randomUUID();
    await db.query(
      `INSERT INTO public.interactions (id, company_id, customer_id, conversation_id, channel, type, direction, actor_type, sanitized_content, sanitization_status, created_at)
       VALUES ($1, $2, $3, $4, 'FACEBOOK', 'MESSAGE', 'INBOUND', 'CUSTOMER', 'Conflict source', 'SUCCEEDED', clock_timestamp())`,
      [conflictSourceId, COMPANY_ID, CUSTOMER_ID, convId],
    );
    const { data: conflictDelivery } = await service
      .from('ai_brain_live_deliveries')
      .select('id')
      .eq('source_interaction_id', conflictSourceId)
      .single();
    assert.ok(conflictDelivery);

    const conflictLock = randomUUID();
    await db.query(
      `UPDATE public.ai_brain_live_deliveries
       SET send_status = 'PROCESSING', attempts = 1, lock_token = $1, locked_at = clock_timestamp(), dispatch_started_at = clock_timestamp()
       WHERE id = $2`,
      [conflictLock, conflictDelivery.id],
    );

    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.record_ai_messenger_live_outbound($1, $2, $3, $4, $5, $6, $7, 'AI')`,
          [
            COMPANY_ID,
            CUSTOMER_ID,
            convId,
            conflictSourceId,
            conflictDelivery.id,
            `meta:${PAGE_ID}:${conflictMid}`,
            draftReply,
          ],
        );
      },
      /INTERACTION_CONFLICT/,
      'Conflicting interaction with non-OUTBOUND direction must not be reused'
    );

    // Negative test: start_ai_messenger_live_dispatch requires source type = 'MESSAGE' and sanitization_status = 'SUCCEEDED'
    const nonMessageSourceId = randomUUID();
    await db.query(
      `INSERT INTO public.interactions (id, company_id, customer_id, conversation_id, channel, type, direction, actor_type, sanitized_content, sanitization_status, created_at)
       VALUES ($1, $2, $3, $4, 'FACEBOOK', 'NOTE', 'INBOUND', 'CUSTOMER', 'Note content', 'SUCCEEDED', clock_timestamp())`,
      [nonMessageSourceId, COMPANY_ID, CUSTOMER_ID, convId],
    );
    const nonMsgDeliveryId = randomUUID();
    const nonMsgLock = randomUUID();
    await db.query(
      `INSERT INTO public.ai_brain_live_deliveries (id, company_id, customer_id, conversation_id, source_interaction_id, channel, send_status, attempts, lock_token, locked_at)
       VALUES ($1, $2, $3, $4, $5, 'MESSENGER', 'PROCESSING', 1, $6, clock_timestamp())`,
      [nonMsgDeliveryId, COMPANY_ID, CUSTOMER_ID, convId, nonMessageSourceId, nonMsgLock],
    );
    const { data: nonMsgFenced } = await service.rpc('start_ai_messenger_live_dispatch', {
      p_delivery_id: nonMsgDeliveryId,
      p_lock_token: nonMsgLock,
      p_company_id: COMPANY_ID,
      p_customer_id: CUSTOMER_ID,
      p_conversation_id: convId,
      p_source_interaction_id: nonMessageSourceId,
      p_page_id: PAGE_ID,
      p_min_confidence: 0.85,
      p_turn_confidence: 0.9,
    });
    assert.equal(nonMsgFenced, false, 'Source interaction with type <> MESSAGE must deny dispatch');

    const unsanitizedSourceId = randomUUID();
    await db.query(
      `INSERT INTO public.interactions (id, company_id, customer_id, conversation_id, channel, type, direction, actor_type, sanitized_content, sanitization_status, created_at)
       VALUES ($1, $2, $3, $4, 'FACEBOOK', 'MESSAGE', 'INBOUND', 'CUSTOMER', 'Unsanitized msg', 'PENDING', clock_timestamp())`,
      [unsanitizedSourceId, COMPANY_ID, CUSTOMER_ID, convId],
    );
    const unsanitizedDeliveryId = randomUUID();
    const unsanitizedLock = randomUUID();
    await db.query(
      `INSERT INTO public.ai_brain_live_deliveries (id, company_id, customer_id, conversation_id, source_interaction_id, channel, send_status, attempts, lock_token, locked_at)
       VALUES ($1, $2, $3, $4, $5, 'MESSENGER', 'PROCESSING', 1, $6, clock_timestamp())`,
      [unsanitizedDeliveryId, COMPANY_ID, CUSTOMER_ID, convId, unsanitizedSourceId, unsanitizedLock],
    );
    const { data: unsanitizedFenced } = await service.rpc('start_ai_messenger_live_dispatch', {
      p_delivery_id: unsanitizedDeliveryId,
      p_lock_token: unsanitizedLock,
      p_company_id: COMPANY_ID,
      p_customer_id: CUSTOMER_ID,
      p_conversation_id: convId,
      p_source_interaction_id: unsanitizedSourceId,
      p_page_id: PAGE_ID,
      p_min_confidence: 0.85,
      p_turn_confidence: 0.9,
    });
    assert.equal(unsanitizedFenced, false, 'Source interaction with sanitization_status <> SUCCEEDED must deny dispatch');

    // 13. Finish delivery with finish_ai_brain_live_delivery_extended and brain_latency_ms
    const { data: finished, error: finErr } = await service.rpc('finish_ai_brain_live_delivery_extended', {
      p_id: delivery.id,
      p_lock_token: lockToken,
      p_send_status: 'SENT',
      p_decision: 'RESPOND',
      p_confidence: 0.95,
      p_external_message_id: rawMid,
      p_brain_latency_ms: 184,
    });
    assert.ifError(finErr);
    assert.equal(finished, true);

    // Verify idempotency on re-record AFTER finish
    const { data: postFinishId, error: postFinErr } = await service.rpc('record_ai_messenger_live_outbound', {
      p_company_id: COMPANY_ID,
      p_customer_id: CUSTOMER_ID,
      p_conversation_id: convId,
      p_source_interaction_id: interactionEnabledId,
      p_delivery_id: delivery.id,
      p_external_ref: externalRef,
      p_content: draftReply,
      p_actor_type: 'AI',
    });
    assert.ifError(postFinErr);
    assert.equal(postFinishId, outboundIntId, 'Re-recording after finish must be idempotent');

    // Verify delivery has brain_latency_ms persisted and raw MID preserved
    const { data: finalDelivery } = await service
      .from('ai_brain_live_deliveries')
      .select('brain_latency_ms, send_status, attempts, external_message_id, outbound_interaction_id')
      .eq('id', delivery.id)
      .single();
    assert.equal(finalDelivery?.brain_latency_ms, 184);
    assert.equal(finalDelivery?.send_status, 'SENT');
    assert.equal(finalDelivery?.attempts, 1, 'Real attempt count 1 must be preserved');
    assert.equal(finalDelivery?.external_message_id, rawMid);
    assert.equal(finalDelivery?.outbound_interaction_id, outboundIntId);

    // 14. Test non-retryable failure preservation (NO fake attempts=5):
    // Insert a dummy pending delivery, claim it, and finish with MESSENGER_DISPATCH_UNCERTAIN
    const dummyInteractionId = randomUUID();
    await service.from('interactions').insert({
      id: dummyInteractionId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: convId,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Test uncertain outcome',
      sanitization_status: 'SUCCEEDED',
    });

    const { data: dummyDelivery } = await service
      .from('ai_brain_live_deliveries')
      .select('id')
      .eq('source_interaction_id', dummyInteractionId)
      .single();
    assert.ok(dummyDelivery);

    const lockToken2 = randomUUID();
    await service.rpc('claim_ai_brain_live_deliveries', {
      p_limit: 5,
      p_lock_token: lockToken2,
      p_channel: 'MESSENGER',
    });

    // Finish as FAILED with MESSENGER_DISPATCH_UNCERTAIN and brain_latency_ms via extended finish
    await service.rpc('finish_ai_brain_live_delivery_extended', {
      p_id: dummyDelivery.id,
      p_lock_token: lockToken2,
      p_send_status: 'FAILED',
      p_decision: 'RESPOND',
      p_confidence: 0.9,
      p_error_code: 'MESSENGER_DISPATCH_UNCERTAIN',
      p_brain_latency_ms: 215,
    });

    // Verify real attempts count is preserved (1, not fake 5)
    const { data: terminalDelivery } = await service
      .from('ai_brain_live_deliveries')
      .select('send_status, attempts, error_code, brain_latency_ms')
      .eq('id', dummyDelivery.id)
      .single();
    assert.ok(terminalDelivery);
    assert.equal(terminalDelivery.send_status, 'FAILED');
    assert.equal(terminalDelivery.attempts, 1, 'Real attempt count must be preserved, not forced to 5');
    assert.equal(terminalDelivery.error_code, 'MESSENGER_DISPATCH_UNCERTAIN');
    assert.equal(terminalDelivery.brain_latency_ms, 215);

    // Next worker claim must NEVER re-claim this uncertain delivery
    const lockToken3 = randomUUID();
    const { data: reClaimed } = await service.rpc('claim_ai_brain_live_deliveries', {
      p_limit: 5,
      p_lock_token: lockToken3,
      p_channel: 'MESSENGER',
    });
    const foundUncertain = (reClaimed as Array<{ id: string }>).find((c) => c.id === dummyDelivery.id);
    assert.equal(foundUncertain, undefined, 'Uncertain delivery must not be claimed for physical retry');
  } finally {
    await harness.close();
  }
});

test('AI Brain Messenger Live DB: Handover / Paused AI / Human-assigned does not enqueue delivery', async () => {
  const harness = await createPgliteSupabase();
  const { db, client: service } = harness;

  try {
    await db.query(
      `INSERT INTO public.companies (id, name, status) VALUES ($1, 'AI Messenger DB Fixture Co', 'ACTIVE') ON CONFLICT DO NOTHING`,
      [COMPANY_ID],
    );
    await db.query(
      `INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
       VALUES ($1, $2, 'MSGR-CUST-1', 'Messenger Customer Test', 'MANUAL', 'LEAD_NEW')
       ON CONFLICT DO NOTHING`,
      [CUSTOMER_ID, COMPANY_ID],
    );
    await db.query(
      `INSERT INTO public.ai_brain_live_settings (company_id, channel, enabled, min_confidence)
       VALUES ($1, 'MESSENGER', true, 0.85)
       ON CONFLICT (company_id, channel) DO UPDATE SET enabled = true`,
      [COMPANY_ID],
    );

    // Paused conversation
    const pausedConvId = randomUUID();
    await service.from('conversations').insert({
      id: pausedConvId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      external_conversation_id: `${PAGE_ID}:87654321098765002`,
      status: 'OPEN',
      ai_mode: 'PAUSED',
    });
    await service.from('ai_brain_live_canary_allowlist').insert({
      company_id: COMPANY_ID,
      channel: 'MESSENGER',
      conversation_id: pausedConvId,
      page_id: PAGE_ID,
      enabled: true,
    });

    const interactionPausedId = randomUUID();
    await service.from('interactions').insert({
      id: interactionPausedId,
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

    const { data: noDeliveryPaused } = await service
      .from('ai_brain_live_deliveries')
      .select('id')
      .eq('source_interaction_id', interactionPausedId)
      .maybeSingle();
    assert.equal(noDeliveryPaused, null, 'Paused conversation must not enqueue');

    // Human-assigned conversation
    const userAdminId = randomUUID();
    await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [userAdminId]);
    await db.query(
      `INSERT INTO public.user_profiles (id, full_name, status) VALUES ($1, 'Admin Agent', 'ACTIVE') ON CONFLICT DO NOTHING`,
      [userAdminId],
    );

    const assignedConvId = randomUUID();
    await service.from('conversations').insert({
      id: assignedConvId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      external_conversation_id: `${PAGE_ID}:87654321098765003`,
      status: 'OPEN',
      assigned_to: userAdminId,
      ai_mode: 'ACTIVE',
    });
    await service.from('ai_brain_live_canary_allowlist').insert({
      company_id: COMPANY_ID,
      channel: 'MESSENGER',
      conversation_id: assignedConvId,
      page_id: PAGE_ID,
      enabled: true,
    });

    const interactionAssignedId = randomUUID();
    await service.from('interactions').insert({
      id: interactionAssignedId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: assignedConvId,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Chào em, anh cần gặp bạn phụ trách',
      sanitization_status: 'SUCCEEDED',
    });

    const { data: noDeliveryAssigned } = await service
      .from('ai_brain_live_deliveries')
      .select('id')
      .eq('source_interaction_id', interactionAssignedId)
      .maybeSingle();
    assert.equal(noDeliveryAssigned, null, 'Human assigned conversation must not enqueue');

    // PENDING_SALE conversation for Messenger: MUST enqueue and allow dispatch fence (remove pending sale gate)
    const pendingSaleConvId = randomUUID();
    await service.from('conversations').insert({
      id: pendingSaleConvId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      channel: 'FACEBOOK',
      external_conversation_id: `${PAGE_ID}:87654321098765004`,
      status: 'PENDING_SALE',
      assigned_to: null,
      ai_mode: 'ACTIVE',
    });
    await service.from('ai_brain_live_canary_allowlist').insert({
      company_id: COMPANY_ID,
      channel: 'MESSENGER',
      conversation_id: pendingSaleConvId,
      page_id: PAGE_ID,
      enabled: true,
    });

    const interactionPendingSaleId = randomUUID();
    await service.from('interactions').insert({
      id: interactionPendingSaleId,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      conversation_id: pendingSaleConvId,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Chào fanpage, tư vấn cho mình ngay nhé!',
      sanitization_status: 'SUCCEEDED',
    });

    const { data: deliveryPendingSale } = await service
      .from('ai_brain_live_deliveries')
      .select('id')
      .eq('source_interaction_id', interactionPendingSaleId)
      .maybeSingle();
    assert.ok(deliveryPendingSale, 'PENDING_SALE Messenger conversation MUST enqueue delivery without waiting for sale');

    // Claim and test dispatch fence
    const lockPending = randomUUID();
    const { data: claimedPending } = await service.rpc('claim_ai_brain_live_deliveries', {
      p_limit: 5,
      p_lock_token: lockPending,
      p_channel: 'MESSENGER',
    });
    const foundPending = (claimedPending as Array<{ id: string }>).find((c) => c.id === deliveryPendingSale.id);
    assert.ok(foundPending, 'PENDING_SALE Messenger delivery must be claimable');

    const { data: fenceAcquiredPending, error: fenceErrPending } = await service.rpc('start_ai_messenger_live_dispatch', {
      p_delivery_id: deliveryPendingSale.id,
      p_lock_token: lockPending,
      p_company_id: COMPANY_ID,
      p_customer_id: CUSTOMER_ID,
      p_conversation_id: pendingSaleConvId,
      p_source_interaction_id: interactionPendingSaleId,
      p_page_id: PAGE_ID,
      p_min_confidence: 0.85,
      p_turn_confidence: 0.9,
    });
    assert.ifError(fenceErrPending);
    assert.equal(fenceAcquiredPending, true, 'start_ai_messenger_live_dispatch fence must be acquired for PENDING_SALE conversation');
  } finally {
    await harness.close();
  }
});

test('AI Brain Messenger Live DB: ACL and tenant isolation on canary allowlist', async () => {
  const harness = await createPgliteSupabase();
  const { db } = harness;

  try {
    // 1. Verify table privileges
    const { rows: anonPrivs } = await db.query<{ has_priv: boolean }>(
      `SELECT has_table_privilege('anon', 'public.ai_brain_live_canary_allowlist', 'select') AS has_priv`,
    );
    assert.equal(anonPrivs[0]?.has_priv, false, 'anon must not have SELECT on canary allowlist');

    const { rows: pubPrivs } = await db.query<{ has_priv: boolean }>(
      `SELECT has_table_privilege('public', 'public.ai_brain_live_canary_allowlist', 'select') AS has_priv`,
    );
    assert.equal(pubPrivs[0]?.has_priv, false, 'PUBLIC must not have SELECT on canary allowlist');

    const { rows: srPrivs } = await db.query<{ has_priv: boolean }>(
      `SELECT has_table_privilege('service_role', 'public.ai_brain_live_canary_allowlist', 'select') AS has_priv`,
    );
    assert.equal(srPrivs[0]?.has_priv, true, 'service_role must have SELECT on canary allowlist');

    // Authenticated must NOT have INSERT, UPDATE, DELETE (service-only mutation)
    const { rows: authInsertPriv } = await db.query<{ has_priv: boolean }>(
      `SELECT has_table_privilege('authenticated', 'public.ai_brain_live_canary_allowlist', 'insert') AS has_priv`,
    );
    assert.equal(authInsertPriv[0]?.has_priv, false, 'authenticated must not have INSERT on canary allowlist');

    const { rows: authUpdatePriv } = await db.query<{ has_priv: boolean }>(
      `SELECT has_table_privilege('authenticated', 'public.ai_brain_live_canary_allowlist', 'update') AS has_priv`,
    );
    assert.equal(authUpdatePriv[0]?.has_priv, false, 'authenticated must not have UPDATE on canary allowlist');

    // 2. Verify helper function is revoked from PUBLIC, anon, authenticated, service_role
    const { rows: fnExists } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'cron_internal' AND p.proname = 'invoke_ai_brain_live_messenger_cron'
      ) AS exists`,
    );

    if (fnExists[0]?.exists) {
      const { rows: fnPrivs } = await db.query<{
        has_pub: boolean;
        has_anon: boolean;
        has_auth: boolean;
        has_sr: boolean;
      }>(
        `SELECT has_function_privilege('public', 'cron_internal.invoke_ai_brain_live_messenger_cron()', 'execute') AS has_pub,
                has_function_privilege('anon', 'cron_internal.invoke_ai_brain_live_messenger_cron()', 'execute') AS has_anon,
                has_function_privilege('authenticated', 'cron_internal.invoke_ai_brain_live_messenger_cron()', 'execute') AS has_auth,
                has_function_privilege('service_role', 'cron_internal.invoke_ai_brain_live_messenger_cron()', 'execute') AS has_sr`,
      );
      assert.equal(fnPrivs[0]?.has_pub, false);
      assert.equal(fnPrivs[0]?.has_anon, false);
      assert.equal(fnPrivs[0]?.has_auth, false);
      assert.equal(fnPrivs[0]?.has_sr, false);
    }
  } finally {
    await harness.close();
  }
});
