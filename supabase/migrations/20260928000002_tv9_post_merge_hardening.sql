-- Migration 019: TV9 Post-Merge Hardening
-- 1. Atomically wire Response SLA into Facebook runtime (han_ingest & han_prepare_send)
-- 2. Add resolve_response_sla_on_ai_reply for complete AI reply lifecycle
-- 3. Harden activate_sales_style_profile with mandatory AAL2 check

-- ------------------------------------------------------------------------------
-- 1. ATOMIC SLA RESOLUTION ON AI REPLY: resolve_response_sla_on_ai_reply
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_response_sla_on_ai_reply(
  p_company_id uuid,
  p_conversation_id uuid,
  p_ai_claim_id uuid,
  p_ai_interaction_id uuid
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  conversation_id uuid,
  customer_id uuid,
  trigger_interaction_id uuid,
  started_at timestamptz,
  deadline_at timestamptz,
  state text,
  resolved_at timestamptz,
  sale_response_interaction_id uuid,
  ai_response_interaction_id uuid,
  ai_claimed_at timestamptz,
  ai_claim_id uuid,
  ai_claim_expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_id uuid;
  v_interaction_company_id uuid;
  v_interaction_customer_id uuid;
  v_interaction_convo_id uuid;
  v_interaction_type text;
  v_interaction_direction text;
  v_interaction_actor text;
  v_interaction_created_at timestamptz;
  v_window public.response_sla_windows%ROWTYPE;
  v_resolved_window public.response_sla_windows%ROWTYPE;
BEGIN
  -- 1. Validate Conversation existence & tenant binding
  SELECT c.customer_id
  INTO v_customer_id
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 2. Validate AI Interaction
  SELECT
    i.company_id,
    i.customer_id,
    i.conversation_id,
    i.type,
    i.direction,
    i.actor_type,
    i.created_at
  INTO
    v_interaction_company_id,
    v_interaction_customer_id,
    v_interaction_convo_id,
    v_interaction_type,
    v_interaction_direction,
    v_interaction_actor,
    v_interaction_created_at
  FROM public.interactions i
  WHERE i.id = p_ai_interaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI_INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_interaction_company_id <> p_company_id THEN
    RAISE EXCEPTION 'INTERACTION_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_interaction_convo_id IS NULL OR v_interaction_convo_id <> p_conversation_id THEN
    RAISE EXCEPTION 'INTERACTION_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_customer_id <> v_customer_id THEN
    RAISE EXCEPTION 'INTERACTION_CUSTOMER_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_type <> 'MESSAGE' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_TYPE' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_direction <> 'OUTBOUND' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_DIRECTION' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_actor <> 'AI' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_ACTOR' USING ERRCODE = '22000';
  END IF;

  -- 3. Lock OPEN SLA window for this conversation
  SELECT *
  INTO v_window
  FROM public.response_sla_windows w
  WHERE w.company_id = p_company_id
    AND w.conversation_id = p_conversation_id
    AND w.state = 'OPEN'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- 4. Verify AI claim ownership and non-expiration
  IF v_window.ai_claim_id IS NULL OR v_window.ai_claim_id <> p_ai_claim_id THEN
    RAISE EXCEPTION 'AI_CLAIM_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_window.ai_claim_expires_at IS NULL OR v_window.ai_claim_expires_at < clock_timestamp() THEN
    RAISE EXCEPTION 'AI_CLAIM_EXPIRED' USING ERRCODE = '22000';
  END IF;

  -- 5. Resolve window to AI_RESPONDED
  UPDATE public.response_sla_windows
  SET state = 'AI_RESPONDED',
      ai_response_interaction_id = p_ai_interaction_id,
      resolved_at = v_interaction_created_at,
      updated_at = clock_timestamp()
  WHERE public.response_sla_windows.id = v_window.id
  RETURNING * INTO v_resolved_window;

  -- 5b. Reset conversation status from AI_HANDLING back to OPEN
  UPDATE public.conversations
  SET status = 'OPEN',
      updated_at = clock_timestamp()
  WHERE public.conversations.id = p_conversation_id
    AND public.conversations.status = 'AI_HANDLING';

  RETURN QUERY
  SELECT
    v_resolved_window.id,
    v_resolved_window.company_id,
    v_resolved_window.conversation_id,
    v_resolved_window.customer_id,
    v_resolved_window.trigger_interaction_id,
    v_resolved_window.started_at,
    v_resolved_window.deadline_at,
    v_resolved_window.state,
    v_resolved_window.resolved_at,
    v_resolved_window.sale_response_interaction_id,
    v_resolved_window.ai_response_interaction_id,
    v_resolved_window.ai_claimed_at,
    v_resolved_window.ai_claim_id,
    v_resolved_window.ai_claim_expires_at,
    v_resolved_window.created_at,
    v_resolved_window.updated_at;
END;
$$;

COMMENT ON FUNCTION public.resolve_response_sla_on_ai_reply(uuid, uuid, uuid, uuid)
  IS 'Atomically resolves an OPEN Response SLA window when an AI response interaction is persisted. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.resolve_response_sla_on_ai_reply(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_response_sla_on_ai_reply(uuid, uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_response_sla_on_ai_reply(uuid, uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_response_sla_on_ai_reply(uuid, uuid, uuid, uuid) TO service_role;

-- ------------------------------------------------------------------------------
-- 2. HARDENED FACEBOOK INGEST WITH ATOMIC SLA OPENING: han_ingest
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.han_ingest(
    p_company uuid,
    p_channel text,
    p_external text,
    p_key text,
    p_name text,
    p_phone text,
    p_content text,
    p_safe text,
    p_safe_status text,
    p_occurred timestamptz,
    p_payload jsonb
)
    RETURNS jsonb
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer uuid;
  v_phone_customer uuid;
  v_conversation uuid;
  v_interaction uuid;
  v_existing private.han_intake_events%ROWTYPE;
  v_contact text;
  v_review boolean := false;
BEGIN
  IF p_channel IS NULL OR p_channel NOT IN ('FACEBOOK', 'WEBSITE')
    OR p_safe_status IS NULL OR p_safe_status NOT IN ('SUCCEEDED', 'FAILED')
    OR (p_channel = 'FACEBOOK' AND (p_external IS NULL OR p_external !~ '^[0-9]+:[0-9]+$'))
    OR (p_channel = 'WEBSITE' AND p_external IS NOT NULL)
    OR p_key IS NULL OR length(p_key) = 0
    OR p_content IS NULL OR p_name IS NULL
    OR length(p_external) > 250
    OR length(p_key) > 500
    OR length(p_content) > 10000
    OR length(p_name) > 100
    OR (p_safe_status = 'FAILED' AND p_safe IS NOT NULL)
    OR (p_safe_status = 'SUCCEEDED' AND p_safe IS NULL)
    OR (
      p_phone IS NOT NULL
      AND p_phone !~ '^\+[1-9][0-9]{7,14}$'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.companies
      WHERE id = p_company AND status = 'ACTIVE'
    )
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('han-intake:' || p_company::text, 0)
  );

  SELECT * INTO v_existing
  FROM private.han_intake_events
  WHERE company_id = p_company
    AND channel = p_channel
    AND event_key = p_key;

  IF FOUND THEN
    IF v_existing.external_identity IS DISTINCT FROM p_external
      OR v_existing.payload->>'content' IS DISTINCT FROM p_content
      OR v_existing.payload->>'phone' IS DISTINCT FROM p_phone
      OR v_existing.payload->>'name' IS DISTINCT FROM p_name
      OR (p_channel = 'WEBSITE' AND v_existing.payload->'source' IS DISTINCT FROM p_payload)
    THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;

    RETURN jsonb_build_object(
      'status', v_existing.status,
      'interaction_id', v_existing.interaction_id
    );
  END IF;

  INSERT INTO private.han_intake_events
  VALUES (
    p_company,
    p_channel,
    p_key,
    p_external,
    jsonb_build_object(
      'source', p_payload,
      'content', p_content,
      'phone', p_phone,
      'name', p_name,
      'occurred_at', p_occurred
    ),
    'RECEIVED',
    NULL,
    now()
  );

  SELECT customer_id INTO v_customer
  FROM public.identities
  WHERE company_id = p_company
    AND channel = p_channel
    AND external_id = p_external
    AND p_channel = 'FACEBOOK';

  IF p_phone IS NOT NULL THEN
    SELECT customer_id INTO v_phone_customer
    FROM private.customer_private_contacts
    WHERE company_id = p_company
      AND normalized_phone = p_phone;
  END IF;

  IF v_customer IS NOT NULL THEN
    SELECT normalized_phone INTO v_contact
    FROM private.customer_private_contacts
    WHERE company_id = p_company
      AND customer_id = v_customer;
  END IF;

  -- Danh tính mâu thuẫn: giữ tin, không tự gộp/sửa liên hệ.
  IF (
    v_phone_customer IS NOT NULL
    AND v_customer IS DISTINCT FROM v_phone_customer
  ) OR (
    v_contact IS NOT NULL
    AND p_phone IS NOT NULL
    AND v_contact <> p_phone
  ) THEN
    v_review := true;
    UPDATE private.han_intake_events
    SET status = 'IDENTITY_REVIEW'
    WHERE company_id = p_company
      AND channel = p_channel
      AND event_key = p_key;
  END IF;

  IF v_customer IS NULL THEN
    INSERT INTO public.customers (
      company_id, name, source, stage
    )
    VALUES (
      p_company, p_name, p_channel, 'LEAD_NEW'
    )
    RETURNING id INTO v_customer;

    INSERT INTO public.customer_stage_histories (
      company_id, customer_id, from_stage,
      to_stage, actor_type, reason
    )
    VALUES (
      p_company, v_customer, NULL,
      'LEAD_NEW', 'SYSTEM', 'OMNICHANNEL_INTAKE'
    );
  END IF;

  -- Website submissions are intake events, not persistent person identities.
  IF v_review THEN
    INSERT INTO public.audit_logs (
      company_id, action, resource_type, resource_id, customer_id, result
    ) VALUES (
      p_company, 'OMNICHANNEL_IDENTITY_REVIEW', 'Customer',
      v_customer, v_customer, 'SUCCESS'
    );
  END IF;

  IF p_channel = 'FACEBOOK' THEN
    INSERT INTO public.identities (
      company_id, customer_id, channel,
      external_id, verified
    )
    VALUES (
      p_company, v_customer, p_channel,
      p_external, false
    )
    ON CONFLICT (company_id, channel, external_id)
    DO NOTHING;
  END IF;

  IF p_phone IS NOT NULL
    AND v_phone_customer IS NULL
    AND v_contact IS NULL
  THEN
    INSERT INTO private.customer_private_contacts (
      company_id, customer_id,
      normalized_phone, raw_phone, is_verified
    )
    VALUES (
      p_company, v_customer, p_phone, p_phone, false
    );
  END IF;

  IF p_channel = 'FACEBOOK' THEN
    INSERT INTO public.conversations (
      company_id, customer_id, channel,
      external_conversation_id,
      last_message_at, unread_count
    )
    VALUES (
      p_company, v_customer, 'FACEBOOK',
      p_external, p_occurred, 1
    )
    ON CONFLICT (
      company_id, channel, external_conversation_id
    )
    DO UPDATE SET
      last_message_at = greatest(
        public.conversations.last_message_at,
        excluded.last_message_at
      ),
      unread_count = public.conversations.unread_count + 1
    RETURNING id INTO v_conversation;
  END IF;

  INSERT INTO public.interactions (
    company_id, customer_id, conversation_id,
    channel, type, direction,
    sanitized_content, sanitization_status,
    sanitized_at, sanitizer_version,
    external_ref, actor_type, created_at
  )
  VALUES (
    p_company, v_customer, v_conversation,
    p_channel, 'MESSAGE', 'INBOUND',
    p_safe, p_safe_status,
    CASE WHEN p_safe_status = 'SUCCEEDED' THEN now() END,
    'han-bounded-v2',
    p_key, 'CUSTOMER', p_occurred
  )
  RETURNING id INTO v_interaction;

  INSERT INTO private.interaction_raw_contents (
    interaction_id, company_id, raw_content, raw_payload
  )
  VALUES (
    v_interaction, p_company, p_content, p_payload
  );

  UPDATE private.han_intake_events
  SET
    status = CASE
      WHEN status = 'IDENTITY_REVIEW' THEN status
      ELSE 'PROCESSED'
    END,
    interaction_id = v_interaction
  WHERE company_id = p_company
    AND channel = p_channel
    AND event_key = p_key;

  -- Quy ước: phản hồi cho lượt chăm sóc gần nhất trong 7 ngày.
  IF p_channel = 'FACEBOOK' THEN
    UPDATE public.care_deliveries
    SET responded_at = p_occurred, status = 'RESPONDED'
    WHERE id = (
      SELECT d.id
      FROM public.care_deliveries d
      JOIN private.han_outbox o ON o.care_delivery_id = d.id
      WHERE d.company_id = p_company
        AND d.customer_id = v_customer
        AND d.channel = 'FACEBOOK'
        AND o.conversation_id = v_conversation
        AND d.sent_at <= p_occurred
        AND d.sent_at > p_occurred - interval '7 days'
        AND d.status IN (
          'SENT', 'DELIVERED', 'READ',
          'RESPONDED', 'CONVERTED_TO_SALE'
        )
      ORDER BY d.sent_at DESC
      LIMIT 1
    )
    AND responded_at IS NULL
    AND status <> 'CONVERTED_TO_SALE';
  END IF;

  -- TV9 SLA WIRING: Atomically open or reuse Response SLA window for Facebook inbound message
  IF p_channel = 'FACEBOOK' AND v_conversation IS NOT NULL THEN
    PERFORM public.open_response_sla_window(
      p_company,
      v_conversation,
      v_interaction
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'ACCEPTED',
    'interaction_id', v_interaction
  );
END;
$$;

COMMENT ON FUNCTION public.han_ingest(uuid, text, text, text, text, text, text, text, text, timestamptz, jsonb)
  IS 'Ingests omnichannel inbound events. For Facebook messages, atomically opens or reuses the 5-minute Response SLA window in the same transaction.';

REVOKE ALL ON FUNCTION public.han_ingest(uuid, text, text, text, text, text, text, text, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_ingest(uuid, text, text, text, text, text, text, text, text, timestamptz, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.han_ingest(uuid, text, text, text, text, text, text, text, text, timestamptz, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_ingest(uuid, text, text, text, text, text, text, text, text, timestamptz, jsonb) TO service_role;

-- Track canonical sent timestamp in private.han_outbox
ALTER TABLE private.han_outbox ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- ------------------------------------------------------------------------------
-- 3. HARDENED FACEBOOK OUTBOUND WITH ATOMIC SLA RESOLUTION: han_prepare_send
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.han_prepare_send(
    p_company uuid,
    p_conversation uuid,
    p_actor uuid,
    p_request uuid,
    p_content text,
    p_safe text,
    p_safe_status text,
    p_delivery uuid
)
    RETURNS jsonb
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conversation public.conversations%ROWTYPE;
  v_existing private.han_outbox%ROWTYPE;
  v_interaction uuid;
  v_latest timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'han-send:' || p_company::text || p_request::text,
      0
    )
  );

  SELECT * INTO v_conversation
  FROM public.conversations
  WHERE company_id = p_company
    AND id = p_conversation
    AND channel = 'FACEBOOK'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members m
    JOIN public.user_profiles u ON u.id = m.user_id
    JOIN public.companies c ON c.id = m.company_id
    WHERE m.company_id = p_company
      AND m.user_id = p_actor
      AND m.status = 'ACTIVE'
      AND u.status = 'ACTIVE'
      AND c.status = 'ACTIVE'
      AND m.role IN ('BOSS_ADMIN', 'SALE')
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED';
  END IF;

  SELECT * INTO v_existing
  FROM private.han_outbox
  WHERE company_id = p_company
    AND request_id = p_request;

  IF FOUND THEN
    IF v_existing.conversation_id <> p_conversation
      OR v_existing.actor_id <> p_actor
      OR v_existing.content <> p_content
      OR v_existing.care_delivery_id IS DISTINCT FROM p_delivery
    THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;

    RETURN jsonb_build_object(
      'claimed', false,
      'status', v_existing.status
    );
  END IF;

  SELECT max(created_at) INTO v_latest
  FROM public.interactions
  WHERE company_id = p_company
    AND conversation_id = p_conversation
    AND direction = 'INBOUND'
    AND actor_type = 'CUSTOMER';

  IF v_latest IS NULL
    OR v_latest <= now() - interval '24 hours'
    OR v_latest > now()
  THEN
    RAISE EXCEPTION 'WINDOW_CLOSED';
  END IF;

  IF length(p_content) NOT BETWEEN 1 AND 2000
    OR p_content IS NULL
    OR p_safe_status IS NULL OR p_safe_status NOT IN ('FAILED', 'SUCCEEDED')
    OR (p_safe_status = 'FAILED' AND p_safe IS NOT NULL)
    OR (p_safe_status = 'SUCCEEDED' AND p_safe IS NULL)
  THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  IF p_delivery IS NOT NULL THEN
    PERFORM 1
    FROM public.care_deliveries d
    JOIN public.care_campaigns c
      ON c.id = d.campaign_id
      AND c.company_id = d.company_id
    WHERE d.id = p_delivery
      AND d.company_id = p_company
      AND d.customer_id = v_conversation.customer_id
      AND d.channel = 'FACEBOOK'
      AND c.channel = 'FACEBOOK'
      AND d.status = 'PENDING'
    FOR UPDATE OF d;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVALID_DELIVERY';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.care_schedules
      WHERE company_id = p_company
        AND customer_id = v_conversation.customer_id
        AND channel = 'FACEBOOK'
        AND enabled = false
    ) THEN
      RAISE EXCEPTION 'CARE_STOPPED';
    END IF;
  END IF;

  INSERT INTO public.interactions (
    company_id, customer_id, conversation_id,
    channel, type, direction,
    sanitized_content, sanitization_status,
    sanitized_at, sanitizer_version,
    actor_type, actor_user_id
  )
  VALUES (
    p_company, v_conversation.customer_id,
    p_conversation, 'FACEBOOK', 'MESSAGE', 'OUTBOUND',
    p_safe, p_safe_status,
    CASE WHEN p_safe_status = 'SUCCEEDED' THEN now() END,
    'han-bounded-v2', 'SALE', p_actor
  )
  RETURNING id INTO v_interaction;

  INSERT INTO private.interaction_raw_contents (
    interaction_id, company_id, raw_content
  )
  VALUES (v_interaction, p_company, p_content);

  INSERT INTO private.han_outbox (
    company_id, request_id, conversation_id,
    interaction_id, actor_id, content,
    status, care_delivery_id
  )
  VALUES (
    p_company, p_request, p_conversation,
    v_interaction, p_actor, p_content,
    'SENDING', p_delivery
  );

  INSERT INTO public.audit_logs (
    company_id, user_id, action, resource_type,
    resource_id, customer_id, result
  )
  VALUES (
    p_company, p_actor, 'MESSENGER_SEND_REQUESTED',
    'Interaction', v_interaction,
    v_conversation.customer_id, 'SUCCESS'
  );

  RETURN jsonb_build_object(
    'claimed', true,
    'status', 'SENDING'
  );
END;
$$;

COMMENT ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid)
  IS 'Prepares an outbound Facebook message for dispatch into private.han_outbox with status SENDING. Does not resolve Response SLA window.';

REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) TO service_role;

-- ------------------------------------------------------------------------------
-- 3AA. CANONICAL RESPONSE SLA RESOLUTION ON SALE REPLY: resolve_response_sla_on_sale_reply
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.resolve_response_sla_on_sale_reply(
  p_company_id uuid,
  p_conversation_id uuid,
  p_sale_interaction_id uuid,
  p_resolved_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  conversation_id uuid,
  customer_id uuid,
  trigger_interaction_id uuid,
  started_at timestamptz,
  deadline_at timestamptz,
  state text,
  resolved_at timestamptz,
  sale_response_interaction_id uuid,
  ai_response_interaction_id uuid,
  ai_claimed_at timestamptz,
  ai_claim_id uuid,
  ai_claim_expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_id uuid;
  v_interaction_company_id uuid;
  v_interaction_customer_id uuid;
  v_interaction_convo_id uuid;
  v_interaction_type text;
  v_interaction_direction text;
  v_interaction_actor text;
  v_interaction_created_at timestamptz;
  v_resolved_at timestamptz;
  v_window public.response_sla_windows%ROWTYPE;
  v_resolved_window public.response_sla_windows%ROWTYPE;
  v_outbox private.han_outbox%ROWTYPE;
BEGIN
  -- 1. Validate Conversation existence & tenant binding
  SELECT c.customer_id
  INTO v_customer_id
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 2. Validate Sale Interaction (enforce company, customer, conversation alignment)
  SELECT
    i.company_id,
    i.customer_id,
    i.conversation_id,
    i.type,
    i.direction,
    i.actor_type,
    i.created_at
  INTO
    v_interaction_company_id,
    v_interaction_customer_id,
    v_interaction_convo_id,
    v_interaction_type,
    v_interaction_direction,
    v_interaction_actor,
    v_interaction_created_at
  FROM public.interactions i
  WHERE i.id = p_sale_interaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALE_INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_interaction_company_id <> p_company_id THEN
    RAISE EXCEPTION 'INTERACTION_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_interaction_convo_id IS NULL OR v_interaction_convo_id <> p_conversation_id THEN
    RAISE EXCEPTION 'INTERACTION_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_customer_id <> v_customer_id THEN
    RAISE EXCEPTION 'INTERACTION_CUSTOMER_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_type <> 'MESSAGE' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_TYPE' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_direction <> 'OUTBOUND' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_DIRECTION' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_actor <> 'SALE' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_ACTOR' USING ERRCODE = '22000';
  END IF;

  -- Canonical resolved timestamp rules:
  -- Priority 1: If matching Hán outbox row exists, outbox.sent_at is canonical and authoritative.
  -- Require outbox status = 'SENT' AND sent_at IS NOT NULL. Caller-supplied p_resolved_at is strictly ignored.
  -- If outbox is SENDING, FAILED, UNKNOWN, or sent_at is NULL, fail closed.
  SELECT *
  INTO v_outbox
  FROM private.han_outbox o
  WHERE o.company_id = p_company_id
    AND o.interaction_id = p_sale_interaction_id;

  IF FOUND THEN
    IF v_outbox.status <> 'SENT' OR v_outbox.sent_at IS NULL THEN
      RAISE EXCEPTION 'OUTBOX_NOT_CONFIRMED' USING ERRCODE = '22000';
    END IF;

    IF v_outbox.sent_at < v_interaction_created_at THEN
      RAISE EXCEPTION 'CORRUPT_OUTBOX_SENT_AT' USING ERRCODE = '22000';
    END IF;

    v_resolved_at := v_outbox.sent_at;
  ELSE
    -- Priority 2: Non-Hán / generic channel compatibility:
    IF p_resolved_at IS NOT NULL THEN
      IF p_resolved_at < v_interaction_created_at THEN
        RAISE EXCEPTION 'RESOLVED_AT_CANNOT_PRECEDE_INTERACTION' USING ERRCODE = '22000';
      END IF;
      v_resolved_at := p_resolved_at;
    ELSE
      v_resolved_at := v_interaction_created_at;
    END IF;
  END IF;

  -- 3. Lock OPEN SLA window for this conversation
  SELECT *
  INTO v_window
  FROM public.response_sla_windows w
  WHERE w.company_id = p_company_id
    AND w.conversation_id = p_conversation_id
    AND w.state = 'OPEN'
  FOR UPDATE;

  -- 4. If no OPEN window, return empty set (idempotent no-op)
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- 5. Resolve window to SALE_RESPONDED
  UPDATE public.response_sla_windows
  SET state = 'SALE_RESPONDED',
      sale_response_interaction_id = p_sale_interaction_id,
      resolved_at = v_resolved_at,
      updated_at = clock_timestamp()
  WHERE public.response_sla_windows.id = v_window.id
  RETURNING * INTO v_resolved_window;

  -- 6. If conversation was in AI_HANDLING, reset to OPEN because Sale has stepped in
  UPDATE public.conversations
  SET status = 'OPEN',
      updated_at = clock_timestamp()
  WHERE public.conversations.id = p_conversation_id
    AND public.conversations.status = 'AI_HANDLING';

  RETURN QUERY
  SELECT
    v_resolved_window.id,
    v_resolved_window.company_id,
    v_resolved_window.conversation_id,
    v_resolved_window.customer_id,
    v_resolved_window.trigger_interaction_id,
    v_resolved_window.started_at,
    v_resolved_window.deadline_at,
    v_resolved_window.state,
    v_resolved_window.resolved_at,
    v_resolved_window.sale_response_interaction_id,
    v_resolved_window.ai_response_interaction_id,
    v_resolved_window.ai_claimed_at,
    v_resolved_window.ai_claim_id,
    v_resolved_window.ai_claim_expires_at,
    v_resolved_window.created_at,
    v_resolved_window.updated_at;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid, timestamptz)
  IS 'Trusted server RPC to resolve OPEN Response SLA window when Sale replies. Canonical resolved timestamp reflects provider-confirmed delivery time. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid, timestamptz) TO service_role;

-- ------------------------------------------------------------------------------
-- 3B. HARDENED FACEBOOK FINISH SEND WITH ATOMIC SLA RESOLUTION: han_finish_send
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.han_finish_send(
    p_company uuid,
    p_request uuid,
    p_status text,
    p_mid text
)
    RETURNS void
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row private.han_outbox%ROWTYPE;
  v_conversation public.conversations%ROWTYPE;
  v_sent_at timestamptz;
BEGIN
  SELECT * INTO v_row
  FROM private.han_outbox
  WHERE company_id = p_company
    AND request_id = p_request
  FOR UPDATE;

  IF NOT FOUND
      OR p_status NOT IN ('SENT', 'FAILED', 'UNKNOWN')
      OR (
        p_status = 'SENT'
        AND coalesce(length(p_mid), 0) = 0
      )
  THEN
    RAISE EXCEPTION 'INVALID_RESULT';
  END IF;

  IF v_row.status <> 'SENDING' THEN
    RETURN;
  END IF;

  SELECT * INTO v_conversation
  FROM public.conversations
  WHERE id = v_row.conversation_id
    AND company_id = p_company;

  IF p_status = 'SENT' THEN
    v_sent_at := clock_timestamp();

    UPDATE private.han_outbox
    SET status = p_status,
        provider_mid = p_mid,
        sent_at = v_sent_at
    WHERE company_id = p_company
      AND request_id = p_request;

    UPDATE public.interactions
    SET external_ref =
          split_part(v_conversation.external_conversation_id, ':', 1)
              || ':' || p_mid
    WHERE id = v_row.interaction_id;

    UPDATE public.conversations
    SET last_message_at = greatest(last_message_at, v_sent_at)
    WHERE id = v_row.conversation_id;

    -- TV9 SLA WIRING: Atomically resolve OPEN Response SLA window only when provider confirms SENT
    -- Canonical resolved_at is the provider-confirmed SENT timestamp (v_sent_at), not interaction.created_at
    PERFORM public.resolve_response_sla_on_sale_reply(
      p_company,
      v_row.conversation_id,
      v_row.interaction_id,
      v_sent_at
    );
  ELSE
    UPDATE private.han_outbox
    SET status = p_status,
        provider_mid = p_mid
    WHERE company_id = p_company
      AND request_id = p_request;
  END IF;

  IF v_row.care_delivery_id IS NOT NULL THEN
    UPDATE public.care_deliveries
    SET
      status = CASE
                   WHEN p_status = 'SENT' THEN 'SENT'
                   WHEN p_status = 'FAILED' THEN 'FAILED'
                   ELSE 'PENDING'
          END,
      sent_at = CASE WHEN p_status = 'SENT' THEN v_sent_at END,
      external_message_ref = p_mid
    WHERE id = v_row.care_delivery_id
      AND company_id = p_company;

    IF p_status = 'SENT' THEN
      UPDATE public.care_deliveries
      SET status = 'DELIVERED', delivered_at = v_sent_at
      WHERE id = v_row.care_delivery_id
        AND EXISTS (
          SELECT 1 FROM private.han_receipts r
          WHERE r.company_id = p_company
            AND r.external_identity =
                v_conversation.external_conversation_id
            AND p_mid = ANY(r.mids)
      );

      UPDATE public.care_deliveries
      SET
        status = 'READ',
        delivered_at = coalesce(delivered_at, v_sent_at)
      WHERE id = v_row.care_delivery_id
        AND EXISTS (
          SELECT 1 FROM private.han_receipts r
          WHERE r.company_id = p_company
            AND r.external_identity =
                v_conversation.external_conversation_id
            AND r.kind = 'READ'
            AND r.watermark >=
                extract(epoch FROM v_row.created_at) * 1000
      );
    END IF;
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, resource_type,
    resource_id, customer_id, result
  )
  VALUES (
    p_company, v_row.actor_id,
    'MESSENGER_SEND_' || p_status,
    'Interaction', v_row.interaction_id,
    v_conversation.customer_id,
    CASE WHEN p_status = 'SENT' THEN 'SUCCESS' ELSE 'FAILED' END
  );
END;
$$;

COMMENT ON FUNCTION public.han_finish_send(uuid, uuid, text, text)
  IS 'Finalizes outbound Facebook message delivery result. Atomically resolves OPEN Response SLA window only on provider-confirmed SENT status with trusted SENT timestamp.';

REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.han_finish_send(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.han_finish_send(uuid, uuid, text, text) TO service_role;

-- ------------------------------------------------------------------------------
-- 3C. HARDENED RESPONSE SLA AI CLAIM: claim_response_sla_for_ai
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_response_sla_for_ai(
  p_company_id uuid,
  p_window_id uuid
)
RETURNS TABLE (
  claimed boolean,
  decision text,
  window_id uuid,
  claim_id uuid,
  conversation_id uuid,
  customer_id uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  deadline_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window public.response_sla_windows%ROWTYPE;
  v_convo_status text;
  v_sale_reply_id uuid;
  v_sale_reply_resolved_at timestamptz;
  v_claim_id uuid;
  v_claimed_at timestamptz;
  v_claim_expires_at timestamptz;
  v_lease_duration interval := interval '2 minutes';
  v_now timestamptz := clock_timestamp();
  v_is_reclaim boolean := false;
  v_audit_decision text;
  v_result_decision text;
BEGIN
  -- A. Lock SLA Window
  SELECT *
  INTO v_window
  FROM public.response_sla_windows w
  WHERE w.id = p_window_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WINDOW_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Multi-tenant isolation: if company mismatch, record DENIED audit and return DENIED
  IF v_window.company_id <> p_company_id THEN
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      v_window.company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'WRONG_COMPANY',
        'caller_company_id', p_company_id,
        'window_id', v_window.id
      )
    );

    RETURN QUERY SELECT
      false,
      'WRONG_COMPANY'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- Check 1: Window state must be OPEN
  IF v_window.state <> 'OPEN' THEN
    DECLARE
      v_reason text := CASE
        WHEN v_window.state = 'SALE_RESPONDED' THEN 'SALE_ALREADY_RESPONDED'
        ELSE 'WINDOW_ALREADY_RESOLVED'
      END;
    BEGIN
      INSERT INTO public.audit_logs (
        company_id,
        user_id,
        action,
        resource_type,
        resource_id,
        customer_id,
        result,
        metadata
      ) VALUES (
        p_company_id,
        NULL,
        'RESPONSE_SLA_AI_CLAIM',
        'RESPONSE_SLA_WINDOW',
        v_window.id,
        v_window.customer_id,
        'DENIED',
        jsonb_build_object(
          'decision', 'DENIED',
          'reason', v_reason,
          'window_state', v_window.state,
          'conversation_id', v_window.conversation_id,
          'deadline_at', v_window.deadline_at
        )
      );

      RETURN QUERY SELECT
        false,
        v_reason,
        v_window.id,
        NULL::uuid,
        v_window.conversation_id,
        v_window.customer_id,
        NULL::timestamptz,
        NULL::timestamptz,
        v_window.deadline_at;
      RETURN;
    END;
  END IF;

  -- Check 2: Recoverable Lease Evaluation
  -- Only deny as ALREADY_CLAIMED if the existing claim lease is STILL ACTIVE (unexpired)
  IF v_window.ai_claimed_at IS NOT NULL
     AND v_window.ai_claim_expires_at IS NOT NULL
     AND v_window.ai_claim_expires_at > v_now THEN

    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'ALREADY_CLAIMED',
        'existing_claim_id', v_window.ai_claim_id,
        'claimed_at', v_window.ai_claimed_at,
        'claim_expires_at', v_window.ai_claim_expires_at,
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'ALREADY_CLAIMED'::text,
      v_window.id,
      v_window.ai_claim_id,
      v_window.conversation_id,
      v_window.customer_id,
      v_window.ai_claimed_at,
      v_window.ai_claim_expires_at,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- If an existing claim has expired, this execution is an atomic RECLAIM
  IF v_window.ai_claimed_at IS NOT NULL THEN
    v_is_reclaim := true;
  END IF;

  -- Check 3: Is deadline reached? (deadline_at <= now())
  IF v_window.deadline_at > v_now THEN
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'NOT_DUE',
        'deadline_at', v_window.deadline_at,
        'evaluated_at', v_now,
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'NOT_DUE'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- B. Lock Conversation
  SELECT c.status
  INTO v_convo_status
  FROM public.conversations c
  WHERE c.id = v_window.conversation_id
    AND c.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_convo_status = 'CLOSED' THEN
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'CONVERSATION_CLOSED',
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'CONVERSATION_CLOSED'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- For a fresh claim, conversation cannot be AI_HANDLING.
  -- For a reclaim of an expired lease, the conversation status was already AI_HANDLING from the crashed worker.
  IF NOT v_is_reclaim AND v_convo_status = 'AI_HANDLING' THEN
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'AI_ALREADY_HANDLING',
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'AI_ALREADY_HANDLING'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- C. Re-check latest Interaction for any verified SALE response after started_at
  -- CRITICAL HARDENING: For Facebook channel, ONLY provider-confirmed SENT in private.han_outbox
  -- qualifies as a Sale response. SENDING, FAILED, and UNKNOWN do NOT qualify.
  SELECT
    i.id,
    coalesce(o.sent_at, i.created_at)
  INTO
    v_sale_reply_id,
    v_sale_reply_resolved_at
  FROM public.interactions i
  LEFT JOIN private.han_outbox o
    ON o.company_id = p_company_id
   AND o.interaction_id = i.id
  WHERE i.company_id = p_company_id
    AND i.conversation_id = v_window.conversation_id
    AND i.actor_type = 'SALE'
    AND i.direction = 'OUTBOUND'
    AND i.type = 'MESSAGE'
    AND i.created_at >= v_window.started_at
    AND (
      -- If interaction is managed via Hán outbox, it MUST be confirmed SENT
      -- SENDING, FAILED, and UNKNOWN do NOT qualify as Sale response
      CASE
        WHEN o.interaction_id IS NOT NULL THEN o.status = 'SENT'
        -- Non-outbox interactions retain canonical semantics without inventing delivery status
        ELSE true
      END
    )
  ORDER BY i.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Sale replied with confirmed delivery! Resolve the window to SALE_RESPONDED
    UPDATE public.response_sla_windows
    SET state = 'SALE_RESPONDED',
        sale_response_interaction_id = v_sale_reply_id,
        resolved_at = v_sale_reply_resolved_at,
        updated_at = v_now
    WHERE public.response_sla_windows.id = v_window.id;

    -- Reset conversation back to OPEN if it was marked AI_HANDLING
    IF v_convo_status = 'AI_HANDLING' THEN
      UPDATE public.conversations
      SET status = 'OPEN',
          updated_at = v_now
      WHERE public.conversations.id = v_window.conversation_id;
    END IF;

    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'SALE_ALREADY_RESPONDED',
        'sale_response_interaction_id', v_sale_reply_id,
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'SALE_ALREADY_RESPONDED'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- D. All checks passed: ATOMIC CLAIM / RECLAIM
  v_claim_id := gen_random_uuid();
  v_claimed_at := v_now;
  v_claim_expires_at := v_now + v_lease_duration;

  UPDATE public.response_sla_windows
  SET ai_claim_id = v_claim_id,
      ai_claimed_at = v_claimed_at,
      ai_claim_expires_at = v_claim_expires_at,
      updated_at = v_claimed_at
  WHERE public.response_sla_windows.id = v_window.id;

  UPDATE public.conversations
  SET status = 'AI_HANDLING',
      updated_at = v_claimed_at
  WHERE public.conversations.id = v_window.conversation_id;

  v_audit_decision := CASE WHEN v_is_reclaim THEN 'RECLAIMED' ELSE 'CLAIMED' END;
  v_result_decision := CASE WHEN v_is_reclaim THEN 'RECLAIMED' ELSE 'ALLOW_AI_REPLY' END;

  -- Audit log: mandatory in same transaction. If insert fails, transaction rolls back!
  INSERT INTO public.audit_logs (
    company_id,
    user_id,
    action,
    resource_type,
    resource_id,
    customer_id,
    result,
    metadata
  ) VALUES (
    p_company_id,
    NULL,
    'RESPONSE_SLA_AI_CLAIM',
    'RESPONSE_SLA_WINDOW',
    v_window.id,
    v_window.customer_id,
    'SUCCESS',
    jsonb_build_object(
      'decision', v_audit_decision,
      'claim_id', v_claim_id,
      'previous_claim_id', v_window.ai_claim_id,
      'conversation_id', v_window.conversation_id,
      'deadline_at', v_window.deadline_at,
      'claimed_at', v_claimed_at,
      'claim_expires_at', v_claim_expires_at
    )
  );

  RETURN QUERY SELECT
    true,
    v_result_decision,
    v_window.id,
    v_claim_id,
    v_window.conversation_id,
    v_window.customer_id,
    v_claimed_at,
    v_claim_expires_at,
    v_window.deadline_at;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid)
  IS 'Trusted server RPC to atomically claim Response SLA window for AI with recoverable lease, re-checks, and audit logging. Only provider-confirmed SENT Facebook messages qualify as Sale response. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid) TO service_role;

-- ------------------------------------------------------------------------------
-- 4. HARDENED SALES STYLE ACTIVATION WITH MANDATORY AAL2: activate_sales_style_profile
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activate_sales_style_profile(
  p_profile_id uuid
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  sale_user_id uuid,
  version text,
  salutation_rules jsonb,
  sentence_style jsonb,
  question_style jsonb,
  objection_style jsonb,
  closing_style jsonb,
  examples jsonb,
  source_refs jsonb,
  model_version text,
  generation_status text,
  activated_at timestamptz,
  activated_by_user_id uuid,
  superseded_at timestamptz,
  superseded_by_profile_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_target_company_id uuid;
  v_target_sale_user_id uuid;
  v_target_status text;
  v_actor_user_id uuid;
  v_actor_user_status text;
  v_actor_role text;
  v_actor_member_status text;
  v_sale_member_role text;
  v_sale_member_status text;
  v_target_sale_user_status text;
  v_target_row public.sales_style_profiles%ROWTYPE;
  v_old_active_row public.sales_style_profiles%ROWTYPE;
  v_activated_row public.sales_style_profiles%ROWTYPE;
  v_now timestamptz;
  v_elem jsonb;
  v_ex jsonb;
  v_ref_id uuid;
  v_unique_source_count integer;
  v_total_source_count integer;
  v_int_company_id uuid;
  v_int_actor_type text;
  v_int_actor_user_id uuid;
  v_int_direction text;
  v_int_type text;
  v_int_sanitization_status text;
  v_int_sanitized_content text;
  v_combined_style_text text;
BEGIN
  -- 1. Derive target resource and verify existence
  SELECT
    ssp.company_id,
    ssp.sale_user_id,
    ssp.generation_status
  INTO
    v_target_company_id,
    v_target_sale_user_id,
    v_target_status
  FROM public.sales_style_profiles ssp
  WHERE ssp.id = p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 2. Validate human actor via auth.uid()
  v_actor_user_id := auth.uid();
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  -- Enforce AAL2: Boss activation of AI Sales Style is a privileged sensitive admin action
  IF coalesce((auth.jwt() ->> 'aal'), '') <> 'aal2' THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- Verify actor profile in user_profiles
  SELECT up.status
  INTO v_actor_user_status
  FROM public.user_profiles up
  WHERE up.id = v_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_actor_user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTOR_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- Verify actor company membership: must be same company, role BOSS_ADMIN, status ACTIVE
  SELECT cm.role, cm.status
  INTO v_actor_role, v_actor_member_status
  FROM public.company_members cm
  WHERE cm.company_id = v_target_company_id
    AND cm.user_id = v_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_MEMBERSHIP_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_actor_role <> 'BOSS_ADMIN' THEN
    RAISE EXCEPTION 'ACTOR_ROLE_NOT_BOSS_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF v_actor_member_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTOR_MEMBERSHIP_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 3. Concurrency serialization mutex: Lock target Sale company_members row FOR UPDATE
  SELECT cm.role, cm.status
  INTO v_sale_member_role, v_sale_member_status
  FROM public.company_members cm
  WHERE cm.company_id = v_target_company_id
    AND cm.user_id = v_target_sale_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_SALE_MEMBERSHIP_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  -- 4. Revalidate target Sale at activation time
  IF v_sale_member_role <> 'SALE' THEN
    RAISE EXCEPTION 'TARGET_NOT_SALE' USING ERRCODE = '42501';
  END IF;

  IF v_sale_member_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'TARGET_SALE_INACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT up.status
  INTO v_target_sale_user_status
  FROM public.user_profiles up
  WHERE up.id = v_target_sale_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_SALE_USER_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_target_sale_user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'TARGET_SALE_USER_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 5. Lock target profile FOR UPDATE
  SELECT *
  INTO v_target_row
  FROM public.sales_style_profiles ssp
  WHERE ssp.id = p_profile_id
  FOR UPDATE;

  -- Allowed state transitions:
  -- SUPERSEDED cannot be activated
  IF v_target_row.generation_status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'PROFILE_ALREADY_SUPERSEDED' USING ERRCODE = '22000';
  END IF;

  -- Idempotency: ACTIVE -> ACTIVE no-op
  IF v_target_row.generation_status = 'ACTIVE' THEN
    -- Verify invariant sanity
    IF v_target_row.activated_at IS NULL OR v_target_row.activated_by_user_id IS NULL
       OR v_target_row.superseded_at IS NOT NULL OR v_target_row.superseded_by_profile_id IS NOT NULL THEN
      RAISE EXCEPTION 'CORRUPT_ACTIVE_PROFILE_STATE' USING ERRCODE = '22000';
    END IF;

    -- Return existing active profile without updating or creating duplicate audit
    RETURN QUERY SELECT
      v_target_row.id,
      v_target_row.company_id,
      v_target_row.sale_user_id,
      v_target_row.version,
      v_target_row.salutation_rules,
      v_target_row.sentence_style,
      v_target_row.question_style,
      v_target_row.objection_style,
      v_target_row.closing_style,
      v_target_row.examples,
      v_target_row.source_refs,
      v_target_row.model_version,
      v_target_row.generation_status,
      v_target_row.activated_at,
      v_target_row.activated_by_user_id,
      v_target_row.superseded_at,
      v_target_row.superseded_by_profile_id,
      v_target_row.created_at,
      v_target_row.updated_at;
    RETURN;
  END IF;

  IF v_target_row.generation_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_PROFILE_STATUS' USING ERRCODE = '22000';
  END IF;

  -- ============================================================================
  -- 5b. PROVENANCE REVALIDATION OF DRAFT PROFILE (Defense-in-depth against untrusted DRAFTs)
  -- ============================================================================
  -- 1. Validate model_version: non-null, non-empty trimmed, length <= 100
  IF v_target_row.model_version IS NULL
     OR pg_catalog.btrim(v_target_row.model_version) = ''
     OR pg_catalog.length(v_target_row.model_version) > 100 THEN
    RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
  END IF;

  -- 2. Validate source_refs: jsonb array, 1..200 items, no duplicates, valid shape INTERACTION
  IF v_target_row.source_refs IS NULL
     OR jsonb_typeof(v_target_row.source_refs) <> 'array'
     OR jsonb_array_length(v_target_row.source_refs) = 0
     OR jsonb_array_length(v_target_row.source_refs) > 200 THEN
    RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
  END IF;

  -- Validate each item in source_refs for shape and sensitive data
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_target_row.source_refs) LOOP
    IF jsonb_typeof(v_elem) <> 'object' THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF (v_elem->>'type') IS NULL OR (v_elem->>'type') <> 'INTERACTION' THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_elem ? 'content' OR v_elem ? 'sanitized_content' OR v_elem ? 'message_text'
       OR v_elem ? 'phone' OR v_elem ? 'transcript' OR v_elem ? 'recording'
       OR v_elem ? 'raw_payload' OR v_elem ? 'token' THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF (SELECT count(*) FROM jsonb_object_keys(v_elem) k WHERE k NOT IN ('type', 'id')) > 0 THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END IF;

    BEGIN
      v_ref_id := (v_elem->>'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END;
  END LOOP;

  -- Check duplicates in source_refs
  SELECT count(DISTINCT (elem->>'id')::uuid), count(*)
  INTO v_unique_source_count, v_total_source_count
  FROM jsonb_array_elements(v_target_row.source_refs) AS elem;

  IF v_unique_source_count <> v_total_source_count THEN
    RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
  END IF;

  -- 3. Verify each source interaction in DB: same Company, same Sale user, OUTBOUND, MESSAGE, SUCCEEDED
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_target_row.source_refs) LOOP
    v_ref_id := (v_elem->>'id')::uuid;

    SELECT
      i.company_id,
      i.actor_type,
      i.actor_user_id,
      i.direction,
      i.type,
      i.sanitization_status,
      i.sanitized_content
    INTO
      v_int_company_id,
      v_int_actor_type,
      v_int_actor_user_id,
      v_int_direction,
      v_int_type,
      v_int_sanitization_status,
      v_int_sanitized_content
    FROM public.interactions i
    WHERE i.id = v_ref_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = 'P0002';
    END IF;

    IF v_int_company_id <> v_target_company_id THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '42501';
    END IF;

    IF v_int_actor_type <> 'SALE' OR v_int_actor_user_id <> v_target_sale_user_id THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_int_direction <> 'OUTBOUND' THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_int_type <> 'MESSAGE' THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_int_sanitization_status <> 'SUCCEEDED' THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_int_sanitized_content IS NULL OR pg_catalog.btrim(v_int_sanitized_content) = '' THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;
  END LOOP;

  -- 4. Style safety at activation: DB-level business policy firewall
  IF v_target_row.salutation_rules IS NULL OR jsonb_typeof(v_target_row.salutation_rules) <> 'object'
     OR v_target_row.sentence_style IS NULL OR jsonb_typeof(v_target_row.sentence_style) <> 'object'
     OR v_target_row.question_style IS NULL OR jsonb_typeof(v_target_row.question_style) <> 'object'
     OR v_target_row.objection_style IS NULL OR jsonb_typeof(v_target_row.objection_style) <> 'object'
     OR v_target_row.closing_style IS NULL OR jsonb_typeof(v_target_row.closing_style) <> 'object' THEN
    RAISE EXCEPTION 'PROFILE_STYLE_POLICY_UNSAFE' USING ERRCODE = '22000';
  END IF;

  v_combined_style_text := v_target_row.salutation_rules::text || ' ' ||
                           v_target_row.sentence_style::text || ' ' ||
                           v_target_row.question_style::text || ' ' ||
                           v_target_row.objection_style::text || ' ' ||
                           v_target_row.closing_style::text;

  IF v_combined_style_text ~* '(giảm\s*giá|chiết\s*khấu|\ydiscount\y|khuyến\s*m[aã]i|%|\ypercent\y|\yphần\s*trăm\y|giá\s*bán|mức\s*giá|báo\s*giá|bảng\s*giá|đơn\s*giá|\yvnđ\y|\yvnd\y|₫|đặt\s*cọc|tiền\s*cọc|\ycọc\y|payment\s*terms|\ythanh\s*toán\y|\ypayment\y|chuyển\s*khoản|trả\s*góp|hợp\s*đồng|\ycontract\y|bảo\s*hành|\ywarranty\y|\yphí\y|lãi\s*suất|cam\s*kết\s*(giao\s*hàng|bảo\s*hành|tiến\s*độ|giá|doanh\s*nghiệp|chất\s*lượng|hoàn\s*tiền))'
     OR v_combined_style_text ~* '\m\d+([\.,]\d{3})*\s*(triệu|nghìn|ngàn|tr|k|đồng|đ)\M' THEN
    RAISE EXCEPTION 'PROFILE_STYLE_POLICY_UNSAFE' USING ERRCODE = '22000';
  END IF;

  -- 5. Legacy examples validation: array 0..5 items, metadata only, strictly no content/sanitized_content/phone/etc.
  IF v_target_row.examples IS NULL OR jsonb_typeof(v_target_row.examples) <> 'array' THEN
    RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
  END IF;

  IF jsonb_array_length(v_target_row.examples) > 5 THEN
    RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
  END IF;

  FOR v_ex IN SELECT * FROM jsonb_array_elements(v_target_row.examples) LOOP
    IF jsonb_typeof(v_ex) <> 'object' THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END IF;

    -- Forbid sensitive / leaky keys in examples
    IF v_ex ? 'content' OR v_ex ? 'sanitized_content' OR v_ex ? 'message_text'
       OR v_ex ? 'phone' OR v_ex ? 'transcript' OR v_ex ? 'recording'
       OR v_ex ? 'raw_payload' OR v_ex ? 'token' THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END IF;

    -- Metadata shape check: must contain interaction_id, channel, created_at
    IF NOT (v_ex ? 'interaction_id' AND v_ex ? 'channel' AND v_ex ? 'created_at') THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END IF;

    -- Strict whitelist: no other keys allowed
    IF (SELECT count(*) FROM jsonb_object_keys(v_ex) k WHERE k NOT IN ('interaction_id', 'channel', 'created_at')) > 0 THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END IF;

    BEGIN
      PERFORM (v_ex->>'interaction_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END;
  END LOOP;

  -- Transaction timestamp for atomic transition
  v_now := clock_timestamp();

  -- 6. Lock current ACTIVE profile for this sale (if any exists)
  SELECT *
  INTO v_old_active_row
  FROM public.sales_style_profiles ssp
  WHERE ssp.company_id = v_target_company_id
    AND ssp.sale_user_id = v_target_sale_user_id
    AND ssp.generation_status = 'ACTIVE'
  FOR UPDATE;

  -- 7. Supersede old active profile if found
  IF FOUND THEN
    UPDATE public.sales_style_profiles ssp
    SET generation_status = 'SUPERSEDED',
        superseded_at = v_now,
        superseded_by_profile_id = p_profile_id,
        updated_at = v_now
    WHERE ssp.id = v_old_active_row.id;

    -- Mandatory audit log for superseded profile
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      v_target_company_id,
      v_actor_user_id,
      'SALES_STYLE_PROFILE_SUPERSEDED',
      'SALES_STYLE_PROFILE',
      v_old_active_row.id,
      NULL,
      'SUCCESS',
      jsonb_build_object(
        'sale_user_id', v_target_sale_user_id,
        'superseded_by_profile_id', p_profile_id
      )
    );
  END IF;

  -- 8. Activate target profile
  UPDATE public.sales_style_profiles ssp
  SET generation_status = 'ACTIVE',
      activated_at = v_now,
      activated_by_user_id = v_actor_user_id,
      updated_at = v_now
  WHERE ssp.id = p_profile_id
  RETURNING * INTO v_target_row;

  -- Mandatory audit log for activated profile
  INSERT INTO public.audit_logs (
    company_id,
    user_id,
    action,
    resource_type,
    resource_id,
    customer_id,
    result,
    metadata
  ) VALUES (
    v_target_company_id,
    v_actor_user_id,
    'SALES_STYLE_PROFILE_ACTIVATED',
    'SALES_STYLE_PROFILE',
    p_profile_id,
    NULL,
    'SUCCESS',
    jsonb_build_object(
      'sale_user_id', v_target_sale_user_id,
      'version', v_target_row.version,
      'previous_active_profile_id', v_old_active_row.id
    )
  );

  RETURN QUERY SELECT
    v_target_row.id,
    v_target_row.company_id,
    v_target_row.sale_user_id,
    v_target_row.version,
    v_target_row.salutation_rules,
    v_target_row.sentence_style,
    v_target_row.question_style,
    v_target_row.objection_style,
    v_target_row.closing_style,
    v_target_row.examples,
    v_target_row.source_refs,
    v_target_row.model_version,
    v_target_row.generation_status,
    v_target_row.activated_at,
    v_target_row.activated_by_user_id,
    v_target_row.superseded_at,
    v_target_row.superseded_by_profile_id,
    v_target_row.created_at,
    v_target_row.updated_at;
END;
$$;

COMMENT ON FUNCTION public.activate_sales_style_profile(uuid)
  IS 'Activates a DRAFT sales style profile, superseding any existing active profile for the sale. Strictly enforces human BOSS_ADMIN with AAL2 via auth.jwt(). Restricted to authenticated.';

REVOKE ALL ON FUNCTION public.activate_sales_style_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_sales_style_profile(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.activate_sales_style_profile(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.activate_sales_style_profile(uuid) TO authenticated;
