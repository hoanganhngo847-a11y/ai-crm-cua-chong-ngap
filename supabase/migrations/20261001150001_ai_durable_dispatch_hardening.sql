-- Migration: 20261001150001_ai_durable_dispatch_hardening.sql
-- Description: Durable outbound state machine, authoritative pre-dispatch DB guard,
-- provider outcome persistence, UNKNOWN/UNCERTAIN preservation, and atomic SLA finalization.

-- 1. Extend public.outbound_deliveries status constraints and add durable lease/window columns
ALTER TABLE public.outbound_deliveries DROP CONSTRAINT IF EXISTS outbound_deliveries_delivery_status_check;
ALTER TABLE public.outbound_deliveries
  ADD CONSTRAINT outbound_deliveries_delivery_status_check
  CHECK (delivery_status IN (
    'PENDING',
    'PENDING_DISPATCH',
    'QUEUED',
    'DISPATCHING',
    'PROVIDER_SENT_PENDING_FINALIZE',
    'SENT',
    'DELIVERED',
    'FAILED',
    'UNCERTAIN',
    'PROVIDER_UNCERTAIN'
  ));

ALTER TABLE public.outbound_deliveries ADD COLUMN IF NOT EXISTS lease_until timestamptz NULL;
ALTER TABLE public.outbound_deliveries ADD COLUMN IF NOT EXISTS window_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_window
  ON public.outbound_deliveries (company_id, window_id)
  WHERE window_id IS NOT NULL;

-- 2. Authoritative Pre-Dispatch DB Guard
-- Must be invoked immediately before any irreversible Facebook or Zalo provider call.
-- Atomically establishes dispatch authority under row lock and validates all security invariants.
CREATE OR REPLACE FUNCTION public.guard_ai_pre_dispatch(
  p_company_id uuid,
  p_conversation_id uuid,
  p_customer_id uuid,
  p_window_id uuid,
  p_ai_claim_id uuid,
  p_channel text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  granted boolean,
  reason text,
  delivery_id uuid,
  provider_msg_id text,
  interaction_id uuid,
  window_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_window public.response_sla_windows%ROWTYPE;
  v_conv public.conversations%ROWTYPE;
  v_del public.outbound_deliveries%ROWTYPE;
  v_zalo public.zalo_outbound_deliveries%ROWTYPE;
  v_sale_reply_id uuid;
  v_sale_reply_resolved_at timestamptz;
  v_stable_zalo_command text;
  v_new_delivery_id uuid;
  v_now timestamptz := clock_timestamp();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
BEGIN
  -- A. Mandatory input validation
  IF p_company_id IS NULL OR p_conversation_id IS NULL OR p_customer_id IS NULL OR p_window_id IS NULL THEN
    RETURN QUERY SELECT false, 'INVALID_ARGUMENTS'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- B. Lock SLA Window
  SELECT * INTO v_window
  FROM public.response_sla_windows
  WHERE id = p_window_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'WINDOW_NOT_FOUND'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF v_window.company_id <> p_company_id THEN
    RETURN QUERY SELECT false, 'WRONG_COMPANY'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;

  IF v_window.conversation_id <> p_conversation_id THEN
    RETURN QUERY SELECT false, 'CONVERSATION_MISMATCH'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;

  IF v_window.customer_id <> p_customer_id THEN
    RETURN QUERY SELECT false, 'CUSTOMER_MISMATCH'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;

  IF v_window.state <> 'OPEN' THEN
    RETURN QUERY SELECT false, v_window.state, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;

  IF p_ai_claim_id IS NOT NULL AND v_window.ai_claim_id IS DISTINCT FROM p_ai_claim_id THEN
    RETURN QUERY SELECT false, 'CLAIM_MISMATCH'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;

  IF v_window.ai_claim_expires_at IS NOT NULL AND v_window.ai_claim_expires_at <= v_now THEN
    RETURN QUERY SELECT false, 'CLAIM_EXPIRED'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;

  -- C. Lock Conversation
  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'CONVERSATION_NOT_FOUND'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;

  IF v_conv.status = 'CLOSED' THEN
    RETURN QUERY SELECT false, 'CONVERSATION_CLOSED'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;

  -- D. Authoritative Check: Did Sale respond after window.started_at?
  SELECT
    i.id,
    coalesce(o.sent_at, i.created_at)
  INTO
    v_sale_reply_id,
    v_sale_reply_resolved_at
  FROM public.interactions i
  LEFT JOIN private.han_outbox o
    ON o.company_id = p_company_id AND o.interaction_id = i.id
  WHERE i.company_id = p_company_id
    AND i.conversation_id = p_conversation_id
    AND i.actor_type = 'SALE'
    AND i.direction = 'OUTBOUND'
    AND i.type = 'MESSAGE'
    AND i.created_at >= v_window.started_at
    AND (
      CASE WHEN o.interaction_id IS NOT NULL THEN o.status = 'SENT' ELSE true END
    )
  ORDER BY i.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Sale won the race! Transition to SALE_RESPONDED atomically
    UPDATE public.response_sla_windows
    SET
      state = 'SALE_RESPONDED',
      sale_response_interaction_id = v_sale_reply_id,
      resolved_at = coalesce(v_sale_reply_resolved_at, v_now),
      updated_at = v_now
    WHERE id = p_window_id;

    IF v_conv.status = 'AI_HANDLING' THEN
      UPDATE public.conversations
      SET status = 'OPEN', updated_at = v_now
      WHERE id = p_conversation_id;
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
      p_window_id,
      p_customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'SALE_ALREADY_RESPONDED',
        'sale_response_interaction_id', v_sale_reply_id,
        'window_id', p_window_id
      )
    );

    RETURN QUERY SELECT false, 'SALE_ALREADY_RESPONDED'::text, NULL::uuid, NULL::text, NULL::uuid, 'SALE_RESPONDED'::text;
    RETURN;
  END IF;

  -- E. Channel-specific state machine check
  IF p_channel = 'ZALO' THEN
    v_stable_zalo_command := 'ai-sla-win-' || p_window_id::text;

    SELECT * INTO v_zalo
    FROM public.zalo_outbound_deliveries
    WHERE company_id = p_company_id
      AND channel = 'ZALO'
      AND command_id = v_stable_zalo_command
    FOR UPDATE;

    IF FOUND THEN
      IF v_zalo.status = 'SENT' THEN
        RETURN QUERY SELECT false, 'ALREADY_SENT'::text, v_zalo.id, v_zalo.provider_msg_id, v_zalo.interaction_id, v_window.state;
        RETURN;
      ELSIF v_zalo.status = 'PROVIDER_SENT_PENDING_FINALIZE' THEN
        RETURN QUERY SELECT false, 'PENDING_FINALIZE'::text, v_zalo.id, v_zalo.provider_msg_id, NULL::uuid, v_window.state;
        RETURN;
      ELSIF v_zalo.status IN ('PROVIDER_UNCERTAIN', 'UNCERTAIN') THEN
        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_zalo.id, v_zalo.provider_msg_id, NULL::uuid, v_window.state;
        RETURN;
      ELSIF v_zalo.status = 'SENDING' AND v_zalo.lease_until IS NOT NULL AND v_zalo.lease_until > v_now THEN
        RETURN QUERY SELECT false, 'BUSY'::text, v_zalo.id, NULL::text, NULL::uuid, v_window.state;
        RETURN;
      ELSIF v_zalo.status = 'SENDING' THEN
        -- Lease expired mid-flight: transition to UNCERTAIN, never auto-retry
        UPDATE public.zalo_outbound_deliveries
        SET status = 'PROVIDER_UNCERTAIN', lease_until = NULL, error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = v_now
        WHERE id = v_zalo.id;

        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_zalo.id, NULL::text, NULL::uuid, v_window.state;
        RETURN;
      END IF;
      -- If status is FAILED or PENDING, allow send
      RETURN QUERY SELECT true, 'GRANTED'::text, v_zalo.id, NULL::text, NULL::uuid, v_window.state;
      RETURN;
    END IF;

    -- No prior row: dispatch authority granted for Zalo
    RETURN QUERY SELECT true, 'GRANTED'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state;
    RETURN;

  ELSE
    -- Generic / Facebook channel backed by public.outbound_deliveries
    SELECT * INTO v_del
    FROM public.outbound_deliveries
    WHERE company_id = p_company_id
      AND client_command_id = p_window_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_del.delivery_status = 'SENT' THEN
        RETURN QUERY SELECT false, 'ALREADY_SENT'::text, v_del.id, v_del.provider_message_id, v_del.interaction_id, v_window.state;
        RETURN;
      ELSIF v_del.delivery_status = 'PROVIDER_SENT_PENDING_FINALIZE' THEN
        RETURN QUERY SELECT false, 'PENDING_FINALIZE'::text, v_del.id, v_del.provider_message_id, NULL::uuid, v_window.state;
        RETURN;
      ELSIF v_del.delivery_status IN ('UNCERTAIN', 'PROVIDER_UNCERTAIN') THEN
        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_del.id, v_del.provider_message_id, NULL::uuid, v_window.state;
        RETURN;
      ELSIF v_del.delivery_status = 'DISPATCHING' AND v_del.lease_until IS NOT NULL AND v_del.lease_until > v_now THEN
        RETURN QUERY SELECT false, 'BUSY'::text, v_del.id, NULL::text, NULL::uuid, v_window.state;
        RETURN;
      ELSIF v_del.delivery_status = 'DISPATCHING' THEN
        -- Lease expired mid-flight: transition to UNCERTAIN, never auto-retry
        UPDATE public.outbound_deliveries
        SET delivery_status = 'UNCERTAIN', lease_until = NULL, error_message = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = v_now
        WHERE id = v_del.id;

        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_del.id, NULL::text, NULL::uuid, v_window.state;
        RETURN;
      ELSIF v_del.delivery_status IN ('PENDING', 'PENDING_DISPATCH', 'FAILED') THEN
        -- Transition to DISPATCHING under active lease
        UPDATE public.outbound_deliveries
        SET
          delivery_status = 'DISPATCHING',
          lease_until = v_now + v_lease,
          locked_at = v_now,
          locked_by = 'ai_response_runtime',
          updated_at = v_now
        WHERE id = v_del.id;

        RETURN QUERY SELECT true, 'GRANTED'::text, v_del.id, NULL::text, NULL::uuid, v_window.state;
        RETURN;
      END IF;

      RETURN QUERY SELECT false, ('UNEXPECTED_STATUS_' || v_del.delivery_status)::text, v_del.id, NULL::text, NULL::uuid, v_window.state;
      RETURN;
    END IF;

    -- No prior row: insert new row in DISPATCHING state with stable command ID = window_id
    v_new_delivery_id := gen_random_uuid();
    INSERT INTO public.outbound_deliveries (
      id,
      company_id,
      conversation_id,
      interaction_id,
      channel,
      delivery_status,
      client_command_id,
      window_id,
      request_fingerprint,
      lease_until,
      locked_at,
      locked_by,
      created_at,
      updated_at
    ) VALUES (
      v_new_delivery_id,
      p_company_id,
      p_conversation_id,
      NULL,
      p_channel,
      'DISPATCHING',
      p_window_id,
      p_window_id,
      p_company_id::text || ':' || p_conversation_id::text || ':' || p_window_id::text,
      v_now + v_lease,
      v_now,
      'ai_response_runtime',
      v_now,
      v_now
    );

    RETURN QUERY SELECT true, 'GRANTED'::text, v_new_delivery_id, NULL::text, NULL::uuid, v_window.state;
    RETURN;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_ai_pre_dispatch(uuid, uuid, uuid, uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_ai_pre_dispatch(uuid, uuid, uuid, uuid, uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.guard_ai_pre_dispatch(uuid, uuid, uuid, uuid, uuid, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.guard_ai_pre_dispatch(uuid, uuid, uuid, uuid, uuid, text, integer) TO service_role;


-- 3. Record Outbound Provider Result Immediately
-- Persists provider acceptance or failure into outbound_deliveries BEFORE CRM/SLA finalization.
CREATE OR REPLACE FUNCTION public.record_ai_outbound_provider_result(
  p_company_id uuid,
  p_delivery_id uuid,
  p_outcome text,
  p_provider_msg_id text DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_del public.outbound_deliveries%ROWTYPE;
  v_new_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_company_id IS NULL OR p_delivery_id IS NULL OR p_outcome IS NULL THEN
    RAISE EXCEPTION 'MANDATORY_PARAMETERS_MISSING' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_del
  FROM public.outbound_deliveries
  WHERE id = p_delivery_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_outcome = 'SENT' THEN
    IF p_provider_msg_id IS NULL OR length(trim(p_provider_msg_id)) = 0 THEN
      RAISE EXCEPTION 'CANNOT_RECORD_SENT_WITHOUT_PROVIDER_MESSAGE_ID' USING ERRCODE = '22023';
    END IF;
    v_new_status := 'PROVIDER_SENT_PENDING_FINALIZE';

    UPDATE public.outbound_deliveries
    SET
      delivery_status = v_new_status,
      provider_message_id = p_provider_msg_id,
      lease_until = NULL,
      updated_at = v_now
    WHERE id = p_delivery_id;

  ELSIF p_outcome = 'FAILED' THEN
    v_new_status := 'FAILED';

    UPDATE public.outbound_deliveries
    SET
      delivery_status = v_new_status,
      error_message = coalesce(p_error_message, 'Provider rejected message'),
      lease_until = NULL,
      updated_at = v_now
    WHERE id = p_delivery_id;

  ELSIF p_outcome IN ('UNCERTAIN', 'UNKNOWN') THEN
    v_new_status := 'UNCERTAIN';

    UPDATE public.outbound_deliveries
    SET
      delivery_status = v_new_status,
      error_message = coalesce(p_error_message, 'Provider outcome uncertain'),
      lease_until = NULL,
      updated_at = v_now
    WHERE id = p_delivery_id;

  ELSE
    RAISE EXCEPTION 'INVALID_OUTBOUND_OUTCOME: %', p_outcome USING ERRCODE = '22023';
  END IF;

  RETURN v_new_status;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_outbound_provider_result(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_ai_outbound_provider_result(uuid, uuid, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_ai_outbound_provider_result(uuid, uuid, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_outbound_provider_result(uuid, uuid, text, text, text) TO service_role;


-- 4. Hardened finalize_ai_outbound_delivery_atomic (Blocker F)
-- Validates:
-- - delivery belongs to p_company_id
-- - delivery belongs to p_conversation_id
-- - canonical conversation belongs to company
-- - conversation.customer_id == p_customer_id
-- - delivery.channel == canonical conversation.channel
-- - SLA window belongs to the same company/conversation/customer
-- - SLA window state == OPEN
-- - SLA window.ai_claim_id == p_ai_claim_id OR finalizer uses canonical durable operation authorized by that claim
-- - delivery is in PROVIDER_SENT_PENDING_FINALIZE
-- - provider message ID matches the durably persisted provider message ID
-- - stable logical command identity matches the SLA response operation (p_window_id)
-- If any validation fails: ROLLBACK / raise.
CREATE OR REPLACE FUNCTION public.finalize_ai_outbound_delivery_atomic(
  p_company_id uuid,
  p_delivery_id uuid,
  p_conversation_id uuid,
  p_customer_id uuid,
  p_window_id uuid,
  p_ai_claim_id uuid,
  p_provider_msg_id text,
  p_sanitized_content text,
  p_raw_content text,
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery public.outbound_deliveries%ROWTYPE;
  v_conv public.conversations%ROWTYPE;
  v_window public.response_sla_windows%ROWTYPE;
  v_interaction_id uuid;
  v_rows_updated integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Validate mandatory fields
  IF p_company_id IS NULL OR p_delivery_id IS NULL OR p_conversation_id IS NULL
     OR p_customer_id IS NULL OR p_window_id IS NULL THEN
    RAISE EXCEPTION 'MANDATORY_PARAMETERS_MISSING' USING ERRCODE = '22023';
  END IF;

  IF p_provider_msg_id IS NULL OR length(trim(p_provider_msg_id)) = 0 THEN
    RAISE EXCEPTION 'CANNOT_FINALIZE_WITHOUT_PROVIDER_MESSAGE_ID' USING ERRCODE = '22023';
  END IF;

  -- 2. Lock and validate outbound delivery
  SELECT * INTO v_delivery
  FROM public.outbound_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_delivery.company_id <> p_company_id THEN
    RAISE EXCEPTION 'DELIVERY_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_delivery.conversation_id <> p_conversation_id THEN
    RAISE EXCEPTION 'DELIVERY_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  -- 3. Lock and validate canonical conversation
  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_conv.company_id <> p_company_id THEN
    RAISE EXCEPTION 'CONVERSATION_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_conv.customer_id <> p_customer_id THEN
    RAISE EXCEPTION 'CONVERSATION_CUSTOMER_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_delivery.channel <> v_conv.channel THEN
    RAISE EXCEPTION 'DELIVERY_CHANNEL_MISMATCH' USING ERRCODE = '22000';
  END IF;

  -- 4. Lock and validate SLA window
  SELECT * INTO v_window
  FROM public.response_sla_windows
  WHERE id = p_window_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WINDOW_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_window.company_id <> p_company_id THEN
    RAISE EXCEPTION 'WINDOW_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_window.conversation_id <> p_conversation_id THEN
    RAISE EXCEPTION 'WINDOW_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_window.customer_id <> p_customer_id THEN
    RAISE EXCEPTION 'WINDOW_CUSTOMER_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- 5. Validate stable logical command identity
  IF v_delivery.client_command_id IS DISTINCT FROM p_window_id THEN
    RAISE EXCEPTION 'COMMAND_IDENTITY_MISMATCH' USING ERRCODE = '22023';
  END IF;

  -- 6. Validate claim authority: window must have active claim or match stable window command
  IF v_window.ai_claim_id IS DISTINCT FROM p_ai_claim_id
     AND v_delivery.client_command_id IS DISTINCT FROM v_window.id THEN
    RAISE EXCEPTION 'CLAIM_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  -- 7. Check delivery status and provider message ID
  IF v_delivery.delivery_status = 'SENT' THEN
    -- Idempotent replay: must match same provider_msg_id and client_command_id
    IF v_delivery.provider_message_id = p_provider_msg_id
       AND v_delivery.client_command_id = p_window_id
       AND v_delivery.interaction_id IS NOT NULL THEN
      RETURN v_delivery.interaction_id;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENT_REPLAY_MISMATCH' USING ERRCODE = '23505';
    END IF;
  END IF;

  IF v_delivery.delivery_status <> 'PROVIDER_SENT_PENDING_FINALIZE' THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FINALIZABLE: Status is %', v_delivery.delivery_status USING ERRCODE = '55000';
  END IF;

  IF v_delivery.provider_message_id IS DISTINCT FROM p_provider_msg_id THEN
    RAISE EXCEPTION 'PROVIDER_MSG_ID_MISMATCH' USING ERRCODE = '22023';
  END IF;

  -- 8. Validate SLA window state
  IF v_window.state <> 'OPEN' THEN
    IF v_window.state = 'AI_RESPONDED' AND v_window.ai_response_interaction_id = v_delivery.interaction_id THEN
      RETURN v_delivery.interaction_id;
    END IF;
    RAISE EXCEPTION 'WINDOW_NOT_OPEN: State is %', v_window.state USING ERRCODE = '55000';
  END IF;

  -- 9. Mint public interaction with actor_type = 'AI'
  v_interaction_id := gen_random_uuid();

  INSERT INTO public.interactions (
    id,
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
    actor_type,
    actor_user_id,
    external_ref,
    created_at
  ) VALUES (
    v_interaction_id,
    p_company_id,
    p_customer_id,
    p_conversation_id,
    v_delivery.channel,
    'MESSAGE',
    'OUTBOUND',
    p_sanitized_content,
    'SUCCEEDED',
    v_now,
    'v1',
    'AI',
    NULL,
    p_provider_msg_id,
    v_now
  );

  -- 10. Mandatory Provenance in private.interaction_raw_contents (Fail-Closed)
  INSERT INTO private.interaction_raw_contents (
    interaction_id,
    company_id,
    raw_content,
    raw_payload,
    source_metadata,
    created_at
  ) VALUES (
    v_interaction_id,
    p_company_id,
    coalesce(p_raw_content, ''),
    '{}'::jsonb,
    coalesce(p_source_metadata, '{}'::jsonb),
    v_now
  );

  -- 11. Update outbound_deliveries to SENT
  UPDATE public.outbound_deliveries
  SET
    delivery_status = 'SENT',
    interaction_id = v_interaction_id,
    lease_until = NULL,
    updated_at = v_now
  WHERE id = p_delivery_id;

  -- 12. Atomically resolve Response SLA window to AI_RESPONDED
  UPDATE public.response_sla_windows
  SET
    state = 'AI_RESPONDED',
    ai_response_interaction_id = v_interaction_id,
    resolved_at = v_now,
    updated_at = v_now
  WHERE id = p_window_id
    AND company_id = p_company_id
    AND state = 'OPEN';

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated = 0 THEN
    RAISE EXCEPTION 'SLA_WINDOW_UPDATE_AFFECTED_ZERO_ROWS' USING ERRCODE = 'P0001';
  END IF;

  -- 13. Reset conversation status to OPEN and update last_message_at
  UPDATE public.conversations
  SET
    status = 'OPEN',
    last_message_at = v_now,
    updated_at = v_now
  WHERE id = p_conversation_id
    AND company_id = p_company_id;

  -- 14. Transactional audit log
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
    'RESPONSE_SLA_AI_RESPONDED',
    'INTERACTION',
    v_interaction_id,
    p_customer_id,
    'SUCCESS',
    jsonb_build_object(
      'delivery_id', p_delivery_id,
      'window_id', p_window_id,
      'ai_claim_id', p_ai_claim_id,
      'provider_msg_id', p_provider_msg_id
    )
  );

  RETURN v_interaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_ai_outbound_delivery_atomic(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_ai_outbound_delivery_atomic(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_ai_outbound_delivery_atomic(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_ai_outbound_delivery_atomic(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb) TO service_role;


-- 5. Trusted SECURITY DEFINER RPC for Zalo AI SLA Finalization & Provenance (Blocker G & H)
CREATE OR REPLACE FUNCTION public.finalize_ai_zalo_sla_atomic(
  p_company_id uuid,
  p_window_id uuid,
  p_ai_claim_id uuid,
  p_zalo_delivery_id uuid,
  p_interaction_id uuid DEFAULT NULL,
  p_provider_msg_id text DEFAULT NULL,
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_zalo public.zalo_outbound_deliveries%ROWTYPE;
  v_conv public.conversations%ROWTYPE;
  v_window public.response_sla_windows%ROWTYPE;
  v_interaction_id uuid;
  v_ref text;
  v_rows_updated integer;
  v_expected_command text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_company_id IS NULL OR p_window_id IS NULL OR p_zalo_delivery_id IS NULL THEN
    RAISE EXCEPTION 'MANDATORY_PARAMETERS_MISSING' USING ERRCODE = '22023';
  END IF;

  v_expected_command := 'ai-sla-win-' || p_window_id::text;

  -- 1. Lock and validate Zalo outbound delivery
  SELECT * INTO v_zalo
  FROM public.zalo_outbound_deliveries
  WHERE id = p_zalo_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZALO_DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_zalo.company_id <> p_company_id THEN
    RAISE EXCEPTION 'ZALO_DELIVERY_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_zalo.command_id IS DISTINCT FROM v_expected_command THEN
    RAISE EXCEPTION 'ZALO_COMMAND_ID_MISMATCH' USING ERRCODE = '22023';
  END IF;

  IF v_zalo.status NOT IN ('SENT', 'PROVIDER_SENT_PENDING_FINALIZE') THEN
    RAISE EXCEPTION 'ZALO_DELIVERY_NOT_FINALIZABLE: Status is %', v_zalo.status USING ERRCODE = '55000';
  END IF;

  -- 2. Lock and validate Conversation
  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = v_zalo.conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_conv.company_id <> p_company_id THEN
    RAISE EXCEPTION 'CONVERSATION_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_conv.channel <> 'ZALO' THEN
    RAISE EXCEPTION 'CONVERSATION_CHANNEL_MISMATCH' USING ERRCODE = '22000';
  END IF;

  -- 3. Lock and validate SLA window
  SELECT * INTO v_window
  FROM public.response_sla_windows
  WHERE id = p_window_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WINDOW_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_window.company_id <> p_company_id THEN
    RAISE EXCEPTION 'WINDOW_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_window.conversation_id <> v_zalo.conversation_id THEN
    RAISE EXCEPTION 'WINDOW_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_window.customer_id <> v_zalo.customer_id THEN
    RAISE EXCEPTION 'WINDOW_CUSTOMER_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- 4. Validate claim authority
  IF v_window.ai_claim_id IS DISTINCT FROM p_ai_claim_id
     AND v_zalo.command_id IS DISTINCT FROM v_expected_command THEN
    RAISE EXCEPTION 'CLAIM_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  -- 5. Determine or mint interaction
  v_interaction_id := coalesce(p_interaction_id, v_zalo.interaction_id);

  IF v_interaction_id IS NULL THEN
    v_interaction_id := gen_random_uuid();
    v_ref := 'zalo:' || v_zalo.company_id::text || ':' || coalesce(v_zalo.oa_id, 'unknown') || ':'
             || coalesce(v_zalo.provider_msg_id, coalesce(p_provider_msg_id, 'outbound:' || v_zalo.id::text));

    INSERT INTO public.interactions (
      id,
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
      v_interaction_id,
      v_zalo.company_id,
      v_zalo.customer_id,
      v_zalo.conversation_id,
      'ZALO',
      'MESSAGE',
      'OUTBOUND',
      v_zalo.content,
      'SUCCEEDED',
      v_now,
      'zalo-sanitizer-v1',
      v_ref,
      'AI',
      NULL,
      v_now
    );

    UPDATE public.zalo_outbound_deliveries
    SET status = 'SENT',
        interaction_id = v_interaction_id,
        provider_msg_id = coalesce(v_zalo.provider_msg_id, p_provider_msg_id),
        finalized_at = v_now,
        lease_until = NULL,
        error_code = NULL,
        error_message = NULL,
        updated_at = v_now
    WHERE id = v_zalo.id;
  END IF;

  -- 6. Idempotent check
  IF v_window.state = 'AI_RESPONDED' AND v_window.ai_response_interaction_id = v_interaction_id THEN
    RETURN v_interaction_id;
  END IF;

  IF v_window.state <> 'OPEN' THEN
    RAISE EXCEPTION 'WINDOW_NOT_OPEN: State is %', v_window.state USING ERRCODE = '55000';
  END IF;

  -- 7. Atomically resolve Response SLA window
  UPDATE public.response_sla_windows
  SET
    state = 'AI_RESPONDED',
    ai_response_interaction_id = v_interaction_id,
    resolved_at = v_now,
    updated_at = v_now
  WHERE id = p_window_id
    AND company_id = p_company_id
    AND state = 'OPEN';

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated = 0 THEN
    RAISE EXCEPTION 'SLA_WINDOW_UPDATE_AFFECTED_ZERO_ROWS' USING ERRCODE = 'P0001';
  END IF;

  -- 8. Enrich private.interaction_raw_contents with full AI Provenance (Blocker H)
  UPDATE private.interaction_raw_contents
  SET
    source_metadata = coalesce(source_metadata, '{}'::jsonb) || p_source_metadata,
    created_at = coalesce(created_at, v_now)
  WHERE interaction_id = v_interaction_id
    AND company_id = p_company_id;

  IF NOT FOUND THEN
    INSERT INTO private.interaction_raw_contents (
      interaction_id,
      company_id,
      raw_content,
      raw_payload,
      source_metadata,
      created_at
    ) VALUES (
      v_interaction_id,
      p_company_id,
      v_zalo.content,
      '{}'::jsonb,
      coalesce(p_source_metadata, '{}'::jsonb),
      v_now
    );
  END IF;

  -- 9. Reset conversation status to OPEN
  UPDATE public.conversations
  SET
    status = 'OPEN',
    last_message_at = v_now,
    updated_at = v_now
  WHERE id = v_zalo.conversation_id
    AND company_id = p_company_id;

  -- 10. Transactional audit log
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
    'RESPONSE_SLA_AI_RESPONDED',
    'INTERACTION',
    v_interaction_id,
    v_zalo.customer_id,
    'SUCCESS',
    jsonb_build_object(
      'zalo_delivery_id', p_zalo_delivery_id,
      'window_id', p_window_id,
      'ai_claim_id', p_ai_claim_id,
      'provider_msg_id', coalesce(v_zalo.provider_msg_id, p_provider_msg_id)
    )
  );

  RETURN v_interaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_ai_zalo_sla_atomic(uuid, uuid, uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_ai_zalo_sla_atomic(uuid, uuid, uuid, uuid, uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_ai_zalo_sla_atomic(uuid, uuid, uuid, uuid, uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_ai_zalo_sla_atomic(uuid, uuid, uuid, uuid, uuid, text, jsonb) TO service_role;

-- 6. Helper for testing: expire response SLA claim lease under SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.test_expire_response_sla_claim(p_window_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.response_sla_windows
  SET ai_claimed_at = clock_timestamp() - interval '3 minutes',
      ai_claim_expires_at = clock_timestamp() - interval '1 second',
      updated_at = clock_timestamp()
  WHERE id = p_window_id;
END;
$$;

REVOKE ALL ON FUNCTION public.test_expire_response_sla_claim(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.test_expire_response_sla_claim(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.test_expire_response_sla_claim(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.test_expire_response_sla_claim(uuid) TO service_role;

