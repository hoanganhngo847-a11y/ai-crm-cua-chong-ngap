-- Migration: 20261028140000_fix_messenger_confidence_and_sla_resolution.sql
-- Description:
-- 1. Lower min_confidence for channel MESSENGER in ai_brain_live_settings to 0.700.
--    Javis Brain returns confidence 0.800 for standard inquiry turns; the previous
--    0.850 threshold caused all normal messages to be skipped with LOW_CONFIDENCE.
-- 2. Update record_ai_messenger_live_outbound: step 11 must include `resolved_at = v_now`
--    and `dispatch_state = 'PROVIDER_ACCEPTED'` to satisfy check constraint
--    `chk_response_sla_state_resolution` on public.response_sla_windows.

BEGIN;

-- 1. Lower min_confidence for MESSENGER to 0.700
UPDATE public.ai_brain_live_settings
SET min_confidence = 0.700, updated_at = now()
WHERE channel = 'MESSENGER';

-- 2. Update record_ai_messenger_live_outbound
CREATE OR REPLACE FUNCTION public.record_ai_messenger_live_outbound(
  p_company_id uuid,
  p_customer_id uuid,
  p_conversation_id uuid,
  p_source_interaction_id uuid,
  p_delivery_id uuid,
  p_external_ref text,
  p_content text,
  p_actor_type text DEFAULT 'AI'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery record;
  v_conv record;
  v_bound_interaction record;
  v_candidate record;
  v_existing_interaction_id uuid;
  v_interaction_id uuid;
  v_raw_mid text;
  v_page_id text;
  v_expected_page_id text;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Input validation & actor requirement
  IF p_company_id IS NULL
     OR p_customer_id IS NULL
     OR p_conversation_id IS NULL
     OR p_source_interaction_id IS NULL
     OR p_delivery_id IS NULL
     OR p_external_ref IS NULL
     OR p_content IS NULL
     OR length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  -- Require p_actor_type AI
  IF p_actor_type IS NOT NULL AND p_actor_type <> 'AI' THEN
    RAISE EXCEPTION 'INVALID_ACTOR_TYPE';
  END IF;

  -- 2. Validate external_ref format: accept ONLY canonical meta:Page:MID.
  IF p_external_ref !~ '^meta:[0-9]+:(.+)$' THEN
    RAISE EXCEPTION 'INVALID_EXTERNAL_REF_FORMAT';
  END IF;

  v_page_id := split_part(p_external_ref, ':', 2);
  v_raw_mid := substring(p_external_ref from '^meta:[0-9]+:(.+)$');

  IF v_raw_mid IS NULL OR btrim(v_raw_mid) = '' THEN
    RAISE EXCEPTION 'EMPTY_RAW_MID';
  END IF;

  -- 3. Lock delivery row for update first (serializes concurrent calls on the same delivery)
  SELECT d.id, d.company_id, d.customer_id, d.conversation_id, d.source_interaction_id,
         d.channel, d.send_status, d.dispatch_started_at, d.external_message_id,
         d.outbound_interaction_id
  INTO v_delivery
  FROM public.ai_brain_live_deliveries d
  WHERE d.id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND';
  END IF;

  -- Validate delivery scope
  IF v_delivery.company_id <> p_company_id
     OR v_delivery.customer_id <> p_customer_id
     OR v_delivery.conversation_id <> p_conversation_id
     OR v_delivery.source_interaction_id <> p_source_interaction_id
     OR v_delivery.channel <> 'MESSENGER' THEN
    RAISE EXCEPTION 'DELIVERY_SCOPE_MISMATCH';
  END IF;

  -- First persistence must require durable authorized dispatch_started_at.
  IF v_delivery.dispatch_started_at IS NULL OR v_delivery.send_status = 'PENDING' THEN
    RAISE EXCEPTION 'DISPATCH_NOT_AUTHORIZED';
  END IF;

  -- Enforce provider message ID consistency
  IF v_delivery.external_message_id IS NOT NULL THEN
    IF v_delivery.external_message_id <> v_raw_mid AND v_delivery.external_message_id <> p_external_ref THEN
      RAISE EXCEPTION 'DELIVERY_ALREADY_BOUND_TO_DIFFERENT_REF';
    END IF;
  END IF;

  -- 4. Lock and validate conversation row & enforce Page equal to exact bound conversation Page
  SELECT c.id, c.company_id, c.customer_id, c.channel, c.status, c.external_conversation_id
  INTO v_conv
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id
    AND c.customer_id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;

  IF v_conv.channel <> 'FACEBOOK'
     OR v_conv.external_conversation_id IS NULL
     OR v_conv.external_conversation_id !~ '^[0-9]+:[0-9]+$' THEN
    RAISE EXCEPTION 'CONVERSATION_INVALID';
  END IF;

  v_expected_page_id := split_part(v_conv.external_conversation_id, ':', 1);

  IF v_page_id <> v_expected_page_id THEN
    RAISE EXCEPTION 'PAGE_MISMATCH';
  END IF;

  -- 5. If delivery already has outbound_interaction_id bound, validate it and return
  IF v_delivery.outbound_interaction_id IS NOT NULL THEN
    SELECT i.id, i.company_id, i.customer_id, i.conversation_id, i.channel,
           i.type, i.direction, i.actor_type, i.external_ref
    INTO v_bound_interaction
    FROM public.interactions i
    WHERE i.id = v_delivery.outbound_interaction_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'BOUND_INTERACTION_NOT_FOUND';
    END IF;

    IF v_bound_interaction.company_id <> p_company_id
       OR v_bound_interaction.customer_id <> p_customer_id
       OR v_bound_interaction.conversation_id <> p_conversation_id
       OR v_bound_interaction.channel <> 'FACEBOOK'
       OR v_bound_interaction.type <> 'MESSAGE'
       OR v_bound_interaction.direction <> 'OUTBOUND'
       OR v_bound_interaction.actor_type <> 'AI'
       OR v_bound_interaction.external_ref <> p_external_ref THEN
      RAISE EXCEPTION 'BOUND_INTERACTION_SCOPE_MISMATCH';
    END IF;

    RETURN v_bound_interaction.id;
  END IF;

  -- 6. Check existing interactions for this external_ref or matching raw MID across the company
  v_existing_interaction_id := NULL;
  FOR v_candidate IN
    SELECT i.id, i.company_id, i.customer_id, i.conversation_id, i.channel,
           i.type, i.direction, i.actor_type, i.external_ref
    FROM public.interactions i
    WHERE i.company_id = p_company_id
      AND (
        i.external_ref = p_external_ref
        OR i.external_ref LIKE 'meta:%:' || v_raw_mid
        OR i.external_ref = v_raw_mid
      )
  LOOP
    IF v_candidate.external_ref <> p_external_ref
       OR v_candidate.customer_id <> p_customer_id
       OR v_candidate.conversation_id <> p_conversation_id
       OR v_candidate.channel <> 'FACEBOOK'
       OR v_candidate.type <> 'MESSAGE'
       OR v_candidate.direction <> 'OUTBOUND'
       OR v_candidate.actor_type <> 'AI' THEN
      RAISE EXCEPTION 'INTERACTION_CONFLICT';
    END IF;
    v_existing_interaction_id := v_candidate.id;
  END LOOP;

  IF v_existing_interaction_id IS NOT NULL THEN
    UPDATE public.ai_brain_live_deliveries
    SET external_message_id = COALESCE(external_message_id, v_raw_mid),
        outbound_interaction_id = v_existing_interaction_id,
        updated_at = v_now
    WHERE id = p_delivery_id;

    RETURN v_existing_interaction_id;
  END IF;

  -- 7. Insert OUTBOUND interaction for timeline
  INSERT INTO public.interactions (
    company_id,
    customer_id,
    conversation_id,
    channel,
    type,
    direction,
    sanitized_content,
    sanitization_status,
    sanitized_at,
    sanitizer_version,
    external_ref,
    actor_type,
    actor_user_id,
    created_at
  ) VALUES (
    p_company_id,
    p_customer_id,
    p_conversation_id,
    'FACEBOOK',
    'MESSAGE',
    'OUTBOUND',
    p_content,
    'SUCCEEDED',
    v_now,
    'ai-messenger-live-v1',
    p_external_ref,
    'AI',
    NULL,
    v_now
  )
  RETURNING id INTO v_interaction_id;

  -- 8. Insert raw payload for auditability
  INSERT INTO private.interaction_raw_contents (
    interaction_id,
    company_id,
    raw_content,
    raw_payload,
    source_metadata
  ) VALUES (
    v_interaction_id,
    p_company_id,
    p_content,
    jsonb_build_object('external_ref', p_external_ref, 'raw_mid', v_raw_mid),
    jsonb_build_object(
      'source', 'ai_messenger_live_delivery',
      'delivery_id', p_delivery_id,
      'source_interaction_id', p_source_interaction_id,
      'actor_type', 'AI'
    )
  );

  -- 9. Atomically bind delivery record with raw provider MID and outbound_interaction_id
  UPDATE public.ai_brain_live_deliveries
  SET external_message_id = v_raw_mid,
      outbound_interaction_id = v_interaction_id,
      updated_at = v_now
  WHERE id = p_delivery_id;

  -- 10. Update conversation activity timestamp and status
  UPDATE public.conversations c
  SET last_message_at = greatest(coalesce(c.last_message_at, v_now), v_now),
      status = CASE WHEN c.status = 'AI_HANDLING' THEN 'OPEN' ELSE c.status END
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id;

  -- 11. Resolve Response SLA window if open (includes resolved_at and dispatch_state)
  UPDATE public.response_sla_windows
  SET state = 'AI_RESPONDED',
      ai_response_interaction_id = v_interaction_id,
      resolved_at = v_now,
      dispatch_state = 'PROVIDER_ACCEPTED',
      updated_at = v_now
  WHERE company_id = p_company_id
    AND conversation_id = p_conversation_id
    AND state = 'OPEN';

  RETURN v_interaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_messenger_live_outbound(uuid, uuid, uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_messenger_live_outbound(uuid, uuid, uuid, uuid, uuid, text, text, text) TO service_role;

COMMIT;
