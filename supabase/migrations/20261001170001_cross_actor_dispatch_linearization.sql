-- Migration: 20261001170001_cross_actor_dispatch_linearization.sql
-- Description: Unified cross-actor dispatch ownership state machine for Response SLA windows,
-- pre-provider fencing for Sale Facebook (han_prepare_send) and Sale Zalo (zalo_claim_outbound_delivery),
-- fail-safe UNCERTAIN transitions on expired leases and UNKNOWN provider outcomes,
-- and physical index creation.

-- 1. Unified cross-actor dispatch columns on public.response_sla_windows
ALTER TABLE public.response_sla_windows
  ADD COLUMN IF NOT EXISTS dispatch_owner text NULL,
  ADD COLUMN IF NOT EXISTS dispatch_state text NULL,
  ADD COLUMN IF NOT EXISTS dispatch_token uuid NULL,
  ADD COLUMN IF NOT EXISTS dispatch_fenced_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS dispatch_delivery_id uuid NULL;

-- Physical index for active dispatch fences
CREATE INDEX IF NOT EXISTS idx_sla_active_dispatch_fence 
  ON public.response_sla_windows(id) 
  WHERE dispatch_fenced_until IS NOT NULL OR ai_dispatch_fenced_until IS NOT NULL;


-- 2. Redefine han_prepare_send with pre-provider Response SLA fencing
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
  v_sla public.response_sla_windows%ROWTYPE;
  v_sale_token uuid;
  v_now timestamptz := clock_timestamp();
  v_lease interval := interval '90 seconds';
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
    OR v_latest <= v_now - interval '24 hours'
    OR v_latest > v_now + interval '10 seconds'
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

  -- ============================================================================
  -- PRE-PROVIDER RESPONSE SLA DISPATCH FENCING (Items 1, 2, 3, 6)
  -- ============================================================================
  SELECT * INTO v_sla
  FROM public.response_sla_windows
  WHERE company_id = p_company
    AND conversation_id = p_conversation
    AND state = 'OPEN'
  FOR UPDATE;

  IF FOUND THEN
    -- Check existing dispatch ownership and state
    IF v_sla.dispatch_state = 'UNCERTAIN' AND (v_sla.dispatch_owner = 'AI' OR v_sla.ai_dispatch_fenced_until IS NOT NULL) THEN
      RETURN jsonb_build_object(
        'claimed', false,
        'status', 'DISPATCH_UNCERTAIN'
      );
    END IF;

    IF v_sla.dispatch_owner = 'AI' OR v_sla.ai_dispatch_fenced_until IS NOT NULL THEN
      IF (v_sla.dispatch_state = 'DISPATCHING' OR v_sla.ai_dispatch_token IS NOT NULL) THEN
        IF coalesce(v_sla.dispatch_fenced_until, v_sla.ai_dispatch_fenced_until) > v_now THEN
          -- AI currently holds the external provider dispatch authority!
          RETURN jsonb_build_object(
            'claimed', false,
            'status', 'AI_DISPATCH_FENCED'
          );
        ELSE
          -- AI dispatch lease expired mid-flight: transition logical operation to UNCERTAIN! Fail safe!
          UPDATE public.response_sla_windows
          SET dispatch_state = 'UNCERTAIN',
              dispatch_fenced_until = NULL,
              ai_dispatch_fenced_until = NULL,
              updated_at = v_now
          WHERE id = v_sla.id;

          RETURN jsonb_build_object(
            'claimed', false,
            'status', 'DISPATCH_UNCERTAIN'
          );
        END IF;
      ELSIF v_sla.dispatch_state = 'PROVIDER_ACCEPTED' THEN
        RETURN jsonb_build_object(
          'claimed', false,
          'status', 'AI_ALREADY_RESPONDED'
        );
      END IF;
    END IF;

    IF v_sla.dispatch_owner = 'SALE' AND v_sla.dispatch_state = 'DISPATCHING' THEN
      IF v_sla.dispatch_fenced_until <= v_now THEN
        -- Sale's own previous dispatch lease expired without resolution: transition to UNCERTAIN
        UPDATE public.response_sla_windows
        SET dispatch_state = 'UNCERTAIN',
            dispatch_fenced_until = NULL,
            updated_at = v_now
        WHERE id = v_sla.id;

        RETURN jsonb_build_object(
          'claimed', false,
          'status', 'DISPATCH_UNCERTAIN'
        );
      END IF;
    END IF;

    -- Atomically acquire SALE response dispatch ownership before returning claimed = true
    v_sale_token := gen_random_uuid();
    UPDATE public.response_sla_windows
    SET
      dispatch_owner = 'SALE',
      dispatch_state = 'DISPATCHING',
      dispatch_token = v_sale_token,
      dispatch_fenced_until = v_now + v_lease,
      dispatch_delivery_id = p_request,
      updated_at = v_now
    WHERE id = v_sla.id;
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
    CASE WHEN p_safe_status = 'SUCCEEDED' THEN v_now END,
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
  IS 'Prepares an outbound Facebook message with pre-dispatch Response SLA cross-actor fencing.';

REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) TO service_role;


-- 3. Redefine han_finish_send with Sale outcome state machine
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
  v_now timestamptz := clock_timestamp();
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
    SET last_message_at = greatest(last_message_at, v_sent_at),
        status = CASE WHEN status = 'AI_HANDLING' THEN 'OPEN' ELSE status END
    WHERE id = v_row.conversation_id;

    -- Update Response SLA window: resolve to SALE_RESPONDED and complete dispatch ownership
    UPDATE public.response_sla_windows
    SET state = 'SALE_RESPONDED',
        sale_response_interaction_id = v_row.interaction_id,
        resolved_at = v_sent_at,
        dispatch_owner = 'SALE',
        dispatch_state = 'PROVIDER_ACCEPTED',
        dispatch_fenced_until = NULL,
        ai_dispatch_fenced_until = NULL,
        ai_dispatch_token = NULL,
        updated_at = v_sent_at
    WHERE conversation_id = v_row.conversation_id
      AND state = 'OPEN';

    PERFORM public.resolve_response_sla_on_sale_reply(
      p_company,
      v_row.conversation_id,
      v_row.interaction_id,
      v_sent_at
    );

  ELSIF p_status = 'FAILED' THEN
    -- Definitive rejection: release Sale dispatch authority on OPEN window
    UPDATE private.han_outbox
    SET status = p_status,
        provider_mid = p_mid
    WHERE company_id = p_company
      AND request_id = p_request;

    UPDATE public.response_sla_windows
    SET dispatch_owner = NULL,
        dispatch_state = 'FAILED',
        dispatch_token = NULL,
        dispatch_fenced_until = NULL,
        dispatch_delivery_id = NULL,
        updated_at = v_now
    WHERE conversation_id = v_row.conversation_id
      AND state = 'OPEN'
      AND dispatch_delivery_id = p_request;

  ELSE -- UNKNOWN / network ambiguity
    -- Do NOT release response operation for AI; mark dispatch outcome UNCERTAIN
    UPDATE private.han_outbox
    SET status = p_status,
        provider_mid = p_mid
    WHERE company_id = p_company
      AND request_id = p_request;

    UPDATE public.response_sla_windows
    SET dispatch_state = 'UNCERTAIN',
        dispatch_fenced_until = NULL,
        ai_dispatch_fenced_until = NULL,
        updated_at = v_now
    WHERE conversation_id = v_row.conversation_id
      AND state = 'OPEN'
      AND dispatch_delivery_id = p_request;
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
  END IF;
END;
$$;

COMMENT ON FUNCTION public.han_finish_send(uuid, uuid, text, text)
  IS 'Finishes outbound Facebook send with Sale provider outcome state machine.';

REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_finish_send(uuid, uuid, text, text) TO service_role;


-- 4. Redefine guard_ai_pre_dispatch with cross-actor dispatch ownership inspection
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
  window_state text,
  dispatch_token uuid
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
  v_dispatch_token uuid;
  v_now timestamptz := clock_timestamp();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
BEGIN
  -- A. Mandatory input validation
  IF p_company_id IS NULL OR p_conversation_id IS NULL OR p_customer_id IS NULL OR p_window_id IS NULL THEN
    RETURN QUERY SELECT false, 'INVALID_ARGUMENTS'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- Mandatory claim ID for new dispatch (no NULL authorization bypass)
  IF p_ai_claim_id IS NULL THEN
    RETURN QUERY SELECT false, 'CLAIM_ID_MANDATORY'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- B. Lock SLA Window
  SELECT * INTO v_window
  FROM public.response_sla_windows
  WHERE id = p_window_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'WINDOW_NOT_FOUND'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_window.company_id <> p_company_id THEN
    RETURN QUERY SELECT false, 'WRONG_COMPANY'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
    RETURN;
  END IF;

  IF v_window.conversation_id <> p_conversation_id THEN
    RETURN QUERY SELECT false, 'CONVERSATION_MISMATCH'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
    RETURN;
  END IF;

  IF v_window.customer_id <> p_customer_id THEN
    RETURN QUERY SELECT false, 'CUSTOMER_MISMATCH'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
    RETURN;
  END IF;

  IF v_window.state <> 'OPEN' THEN
    RETURN QUERY SELECT false, v_window.state, NULL::uuid, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
    RETURN;
  END IF;

  IF v_window.ai_claim_id IS DISTINCT FROM p_ai_claim_id THEN
    RETURN QUERY SELECT false, 'CLAIM_MISMATCH'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
    RETURN;
  END IF;

  IF v_window.ai_claim_expires_at IS NOT NULL AND v_window.ai_claim_expires_at <= v_now THEN
    RETURN QUERY SELECT false, 'CLAIM_EXPIRED'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
    RETURN;
  END IF;

  -- ============================================================================
  -- CROSS-ACTOR DISPATCH OWNERSHIP INSPECTION (Items 2, 4, 5, 6)
  -- ============================================================================
  IF v_window.dispatch_state = 'UNCERTAIN' THEN
    RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_window.dispatch_delivery_id, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
    RETURN;
  END IF;

  IF v_window.dispatch_owner = 'SALE' THEN
    IF v_window.dispatch_state = 'DISPATCHING' THEN
      IF v_window.dispatch_fenced_until > v_now THEN
        RETURN QUERY SELECT false, 'SALE_DISPATCHING'::text, v_window.dispatch_delivery_id, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      ELSE
        -- Sale dispatch lease expired mid-flight: transition to UNCERTAIN! Never let AI compete automatically
        UPDATE public.response_sla_windows
        SET dispatch_state = 'UNCERTAIN',
            dispatch_fenced_until = NULL,
            updated_at = v_now
        WHERE id = p_window_id;

        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_window.dispatch_delivery_id, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      END IF;
    ELSIF v_window.dispatch_state = 'PROVIDER_ACCEPTED' THEN
      RETURN QUERY SELECT false, 'SALE_ALREADY_RESPONDED'::text, NULL::uuid, NULL::text, NULL::uuid, 'SALE_RESPONDED'::text, NULL::uuid;
      RETURN;
    END IF;
  END IF;

  -- C. Lock Conversation
  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'CONVERSATION_NOT_FOUND'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
    RETURN;
  END IF;

  IF v_conv.status = 'CLOSED' THEN
    RETURN QUERY SELECT false, 'CONVERSATION_CLOSED'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
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
      dispatch_owner = 'SALE',
      dispatch_state = 'PROVIDER_ACCEPTED',
      dispatch_fenced_until = NULL,
      ai_dispatch_fenced_until = NULL,
      ai_dispatch_token = NULL,
      updated_at = v_now
    WHERE id = p_window_id;

    IF v_conv.status = 'AI_HANDLING' THEN
      UPDATE public.conversations
      SET status = 'OPEN', updated_at = v_now
      WHERE id = p_conversation_id;
    END IF;

    RETURN QUERY SELECT false, 'SALE_ALREADY_RESPONDED'::text, NULL::uuid, NULL::text, NULL::uuid, 'SALE_RESPONDED'::text, NULL::uuid;
    RETURN;
  END IF;

  -- Generate durable dispatch token for ownership proof
  v_dispatch_token := gen_random_uuid();

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
        RETURN QUERY SELECT false, 'ALREADY_SENT'::text, v_zalo.id, v_zalo.provider_msg_id, v_zalo.interaction_id, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_zalo.status = 'PROVIDER_SENT_PENDING_FINALIZE' THEN
        RETURN QUERY SELECT false, 'PENDING_FINALIZE'::text, v_zalo.id, v_zalo.provider_msg_id, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_zalo.status IN ('PROVIDER_UNCERTAIN', 'UNCERTAIN') THEN
        UPDATE public.response_sla_windows
        SET dispatch_state = 'UNCERTAIN', dispatch_fenced_until = NULL, updated_at = v_now
        WHERE id = p_window_id;

        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_zalo.id, v_zalo.provider_msg_id, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_zalo.status = 'SENDING' AND v_zalo.lease_until IS NOT NULL AND v_zalo.lease_until > v_now THEN
        RETURN QUERY SELECT false, 'BUSY'::text, v_zalo.id, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_zalo.status = 'SENDING' THEN
        -- Lease expired mid-flight: transition to UNCERTAIN, never auto-retry
        UPDATE public.zalo_outbound_deliveries
        SET status = 'PROVIDER_UNCERTAIN', lease_until = NULL, error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = v_now
        WHERE id = v_zalo.id;

        UPDATE public.response_sla_windows
        SET dispatch_state = 'UNCERTAIN', dispatch_fenced_until = NULL, updated_at = v_now
        WHERE id = p_window_id;

        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_zalo.id, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      END IF;

      -- If status is FAILED or PENDING, grant dispatch under fence
      UPDATE public.response_sla_windows
      SET
        dispatch_owner = 'AI',
        dispatch_state = 'DISPATCHING',
        dispatch_token = v_dispatch_token,
        dispatch_fenced_until = v_now + v_lease,
        dispatch_delivery_id = v_zalo.id,
        ai_dispatch_fenced_until = v_now + v_lease,
        ai_dispatch_delivery_id = v_zalo.id,
        ai_dispatch_token = v_dispatch_token,
        updated_at = v_now
      WHERE id = p_window_id;

      RETURN QUERY SELECT true, 'GRANTED'::text, v_zalo.id, NULL::text, NULL::uuid, v_window.state, v_dispatch_token;
      RETURN;
    END IF;

    -- No prior row: dispatch authority granted for Zalo under fence
    UPDATE public.response_sla_windows
    SET
      dispatch_owner = 'AI',
      dispatch_state = 'DISPATCHING',
      dispatch_token = v_dispatch_token,
      dispatch_fenced_until = v_now + v_lease,
      dispatch_delivery_id = NULL,
      ai_dispatch_fenced_until = v_now + v_lease,
      ai_dispatch_delivery_id = NULL,
      ai_dispatch_token = v_dispatch_token,
      updated_at = v_now
    WHERE id = p_window_id;

    RETURN QUERY SELECT true, 'GRANTED'::text, NULL::uuid, NULL::text, NULL::uuid, v_window.state, v_dispatch_token;
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
        RETURN QUERY SELECT false, 'ALREADY_SENT'::text, v_del.id, v_del.provider_message_id, v_del.interaction_id, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_del.delivery_status = 'PROVIDER_SENT_PENDING_FINALIZE' THEN
        RETURN QUERY SELECT false, 'PENDING_FINALIZE'::text, v_del.id, v_del.provider_message_id, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_del.delivery_status IN ('UNCERTAIN', 'PROVIDER_UNCERTAIN') THEN
        UPDATE public.response_sla_windows
        SET dispatch_state = 'UNCERTAIN', dispatch_fenced_until = NULL, updated_at = v_now
        WHERE id = p_window_id;

        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_del.id, v_del.provider_message_id, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_del.delivery_status = 'DISPATCHING' AND v_del.lease_until IS NOT NULL AND v_del.lease_until > v_now THEN
        RETURN QUERY SELECT false, 'BUSY'::text, v_del.id, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_del.delivery_status = 'DISPATCHING' THEN
        -- Lease expired mid-flight: transition to UNCERTAIN, never auto-retry
        UPDATE public.outbound_deliveries
        SET delivery_status = 'UNCERTAIN', lease_until = NULL, error_message = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = v_now
        WHERE id = v_del.id;

        UPDATE public.response_sla_windows
        SET dispatch_state = 'UNCERTAIN', dispatch_fenced_until = NULL, updated_at = v_now
        WHERE id = p_window_id;

        RETURN QUERY SELECT false, 'UNCERTAIN'::text, v_del.id, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
        RETURN;
      ELSIF v_del.delivery_status IN ('PENDING', 'PENDING_DISPATCH', 'FAILED') THEN
        UPDATE public.outbound_deliveries
        SET
          delivery_status = 'DISPATCHING',
          dispatch_token = v_dispatch_token,
          lease_until = v_now + v_lease,
          locked_at = v_now,
          locked_by = 'ai_response_runtime',
          updated_at = v_now
        WHERE id = v_del.id;

        UPDATE public.response_sla_windows
        SET
          dispatch_owner = 'AI',
          dispatch_state = 'DISPATCHING',
          dispatch_token = v_dispatch_token,
          dispatch_fenced_until = v_now + v_lease,
          dispatch_delivery_id = v_del.id,
          ai_dispatch_fenced_until = v_now + v_lease,
          ai_dispatch_delivery_id = v_del.id,
          ai_dispatch_token = v_dispatch_token,
          updated_at = v_now
        WHERE id = p_window_id;

        RETURN QUERY SELECT true, 'GRANTED'::text, v_del.id, NULL::text, NULL::uuid, v_window.state, v_dispatch_token;
        RETURN;
      END IF;

      RETURN QUERY SELECT false, ('UNEXPECTED_STATUS_' || v_del.delivery_status)::text, v_del.id, NULL::text, NULL::uuid, v_window.state, NULL::uuid;
      RETURN;
    END IF;

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
      dispatch_token,
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
      v_dispatch_token,
      v_now,
      'ai_response_runtime',
      v_now,
      v_now
    );

    UPDATE public.response_sla_windows
    SET
      dispatch_owner = 'AI',
      dispatch_state = 'DISPATCHING',
      dispatch_token = v_dispatch_token,
      dispatch_fenced_until = v_now + v_lease,
      dispatch_delivery_id = v_new_delivery_id,
      ai_dispatch_fenced_until = v_now + v_lease,
      ai_dispatch_delivery_id = v_new_delivery_id,
      ai_dispatch_token = v_dispatch_token,
      updated_at = v_now
    WHERE id = p_window_id;

    RETURN QUERY SELECT true, 'GRANTED'::text, v_new_delivery_id, NULL::text, NULL::uuid, v_window.state, v_dispatch_token;
    RETURN;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_ai_pre_dispatch(uuid, uuid, uuid, uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_ai_pre_dispatch(uuid, uuid, uuid, uuid, uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.guard_ai_pre_dispatch(uuid, uuid, uuid, uuid, uuid, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.guard_ai_pre_dispatch(uuid, uuid, uuid, uuid, uuid, text, integer) TO service_role;


-- 5. Redefine record_ai_outbound_provider_result validating both delivery and window tokens
CREATE OR REPLACE FUNCTION public.record_ai_outbound_provider_result(
  p_company_id uuid,
  p_delivery_id uuid,
  p_outcome text,
  p_dispatch_token uuid,
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
  v_win public.response_sla_windows%ROWTYPE;
  v_new_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_company_id IS NULL OR p_delivery_id IS NULL OR p_outcome IS NULL OR p_dispatch_token IS NULL THEN
    RAISE EXCEPTION 'MANDATORY_PARAMETERS_MISSING' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_del
  FROM public.outbound_deliveries
  WHERE id = p_delivery_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Validate delivery dispatch token
  IF v_del.dispatch_token IS DISTINCT FROM p_dispatch_token THEN
    RAISE EXCEPTION 'DISPATCH_TOKEN_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- Validate SLA-window dispatch token if delivery is bound to a window
  IF v_del.window_id IS NOT NULL THEN
    SELECT * INTO v_win
    FROM public.response_sla_windows
    WHERE id = v_del.window_id
    FOR UPDATE;

    IF FOUND THEN
      IF coalesce(v_win.dispatch_token, v_win.ai_dispatch_token) IS DISTINCT FROM p_dispatch_token THEN
        RAISE EXCEPTION 'DISPATCH_TOKEN_MISMATCH' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF v_del.delivery_status = 'PROVIDER_SENT_PENDING_FINALIZE' AND p_outcome = 'SENT'
     AND v_del.provider_message_id IS NOT DISTINCT FROM p_provider_msg_id THEN
    RETURN 'PROVIDER_SENT_PENDING_FINALIZE';
  END IF;

  IF v_del.delivery_status NOT IN ('DISPATCHING', 'UNCERTAIN', 'PROVIDER_UNCERTAIN') THEN
    RAISE EXCEPTION 'INVALID_DELIVERY_STATE_TRANSITION: %', v_del.delivery_status USING ERRCODE = '55000';
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

    IF v_del.window_id IS NOT NULL THEN
      UPDATE public.response_sla_windows
      SET dispatch_state = 'PROVIDER_ACCEPTED',
          updated_at = v_now
      WHERE id = v_del.window_id;
    END IF;

  ELSIF p_outcome = 'FAILED' THEN
    v_new_status := 'FAILED';

    UPDATE public.outbound_deliveries
    SET
      delivery_status = v_new_status,
      error_message = coalesce(p_error_message, 'Provider rejected message'),
      lease_until = NULL,
      dispatch_token = NULL,
      updated_at = v_now
    WHERE id = p_delivery_id;

    IF v_del.window_id IS NOT NULL THEN
      UPDATE public.response_sla_windows
      SET dispatch_owner = NULL,
          dispatch_state = 'FAILED',
          dispatch_token = NULL,
          dispatch_fenced_until = NULL,
          dispatch_delivery_id = NULL,
          ai_dispatch_fenced_until = NULL,
          ai_dispatch_token = NULL,
          updated_at = v_now
      WHERE id = v_del.window_id
        AND (dispatch_token = p_dispatch_token OR ai_dispatch_token = p_dispatch_token);
    END IF;

  ELSIF p_outcome IN ('UNCERTAIN', 'UNKNOWN') THEN
    v_new_status := 'UNCERTAIN';

    UPDATE public.outbound_deliveries
    SET
      delivery_status = v_new_status,
      error_message = coalesce(p_error_message, 'Provider outcome uncertain'),
      lease_until = NULL,
      updated_at = v_now
    WHERE id = p_delivery_id;

    IF v_del.window_id IS NOT NULL THEN
      UPDATE public.response_sla_windows
      SET dispatch_state = 'UNCERTAIN',
          dispatch_fenced_until = NULL,
          ai_dispatch_fenced_until = NULL,
          updated_at = v_now
      WHERE id = v_del.window_id;
    END IF;

  ELSE
    RAISE EXCEPTION 'INVALID_OUTBOUND_OUTCOME: %', p_outcome USING ERRCODE = '22023';
  END IF;

  RETURN v_new_status;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_outbound_provider_result(uuid, uuid, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_ai_outbound_provider_result(uuid, uuid, text, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_ai_outbound_provider_result(uuid, uuid, text, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_outbound_provider_result(uuid, uuid, text, uuid, text, text) TO service_role;


-- 6. Redefine zalo_claim_outbound_delivery with Response SLA cross-actor fencing (Item 7)
CREATE OR REPLACE FUNCTION public.zalo_claim_outbound_delivery(
  p_company_id uuid,
  p_conversation_id uuid,
  p_command_id text,
  p_actor_type text,
  p_actor_user_id uuid,
  p_raw_content text,
  p_sanitized_content text,
  p_content_sha256 text,
  p_oa_id text DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  claim_status text,
  delivery_id uuid,
  claim_token uuid,
  oa_id text,
  recipient_zalo_uid text,
  customer_id uuid,
  provider_msg_id text,
  interaction_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_conv record;
  v_oa text;
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_token uuid := gen_random_uuid();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
  v_sla public.response_sla_windows%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF coalesce(btrim(p_command_id), '') = '' OR length(p_command_id) > 200 THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_COMMAND_ID_INVALID' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_raw_content), '') = '' OR coalesce(p_content_sha256, '') = '' THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_CONTENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_actor_type NOT IN ('SALE', 'AI', 'SYSTEM') THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_ACTOR_INVALID' USING ERRCODE = '22023';
  END IF;

  IF p_actor_type = 'SALE' THEN
    IF p_actor_user_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.company_members m
      JOIN public.user_profiles up ON up.id = m.user_id AND up.status = 'ACTIVE'
      WHERE m.company_id = p_company_id
        AND m.user_id = p_actor_user_id
        AND m.status = 'ACTIVE'
        AND m.role IN ('SALE', 'BOSS_ADMIN')
    ) THEN
      RAISE EXCEPTION 'ZALO_OUTBOUND_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF p_actor_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_ACTOR_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT c.id, c.customer_id, c.external_conversation_id INTO v_conv
  FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.company_id = p_company_id AND c.channel = 'ZALO';
  IF v_conv.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_oa_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.zalo_oa_configs c
      WHERE c.company_id = p_company_id AND c.oa_id = p_oa_id AND c.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'ZALO_OA_NOT_CONFIGURED' USING ERRCODE = 'P0002';
    END IF;
    v_oa := p_oa_id;
  ELSE
    v_oa := private.zalo_resolve_customer_oa(p_company_id, v_conv.customer_id);
  END IF;
  IF v_oa IS NULL THEN
    RAISE EXCEPTION 'ZALO_OA_NOT_CONFIGURED' USING ERRCODE = 'P0002';
  END IF;

  -- ============================================================================
  -- HUMAN SALE RESPONSE SLA CROSS-ACTOR DISPATCH FENCING (Item 7)
  -- ============================================================================
  IF p_actor_type = 'SALE' THEN
    SELECT * INTO v_sla
    FROM public.response_sla_windows
    WHERE company_id = p_company_id
      AND conversation_id = p_conversation_id
      AND state = 'OPEN'
    FOR UPDATE;

    IF FOUND THEN
      IF v_sla.dispatch_state = 'UNCERTAIN' THEN
        RAISE EXCEPTION 'DISPATCH_UNCERTAIN' USING ERRCODE = '55000';
      END IF;

      IF v_sla.dispatch_owner = 'AI' OR v_sla.ai_dispatch_fenced_until IS NOT NULL THEN
        IF (v_sla.dispatch_state = 'DISPATCHING' OR v_sla.ai_dispatch_token IS NOT NULL) THEN
          IF coalesce(v_sla.dispatch_fenced_until, v_sla.ai_dispatch_fenced_until) > v_now THEN
            RAISE EXCEPTION 'AI_DISPATCH_FENCED' USING ERRCODE = '55000';
          ELSE
            UPDATE public.response_sla_windows
            SET dispatch_state = 'UNCERTAIN',
                dispatch_fenced_until = NULL,
                ai_dispatch_fenced_until = NULL,
                updated_at = v_now
            WHERE id = v_sla.id;

            RAISE EXCEPTION 'DISPATCH_UNCERTAIN' USING ERRCODE = '55000';
          END IF;
        ELSIF v_sla.dispatch_state = 'PROVIDER_ACCEPTED' THEN
          RAISE EXCEPTION 'AI_ALREADY_RESPONDED' USING ERRCODE = '55000';
        END IF;
      END IF;

      -- Acquire SALE response dispatch ownership
      UPDATE public.response_sla_windows
      SET
        dispatch_owner = 'SALE',
        dispatch_state = 'DISPATCHING',
        dispatch_token = v_token,
        dispatch_fenced_until = v_now + v_lease,
        updated_at = v_now
      WHERE id = v_sla.id;
    END IF;
  END IF;

  INSERT INTO public.zalo_outbound_deliveries AS d (
    company_id, conversation_id, customer_id, recipient_zalo_uid, idempotency_key, content,
    status, attempts, command_id, channel, lease_until, oa_id, actor_type, actor_user_id,
    claim_token, content_sha256
  ) VALUES (
    p_company_id, v_conv.id, v_conv.customer_id, v_conv.external_conversation_id,
    'zalo_out:' || p_company_id::text || ':' || p_command_id, p_sanitized_content,
    'SENDING', 1, p_command_id, 'ZALO', v_now + v_lease, v_oa, p_actor_type, p_actor_user_id,
    v_token, p_content_sha256
  )
  ON CONFLICT DO NOTHING
  RETURNING d.* INTO v_row;

  IF v_row.id IS NOT NULL THEN
    INSERT INTO private.zalo_outbound_payloads (delivery_id, company_id, raw_content)
    VALUES (v_row.id, p_company_id, p_raw_content);

    IF p_actor_type = 'SALE' AND v_sla.id IS NOT NULL THEN
      UPDATE public.response_sla_windows
      SET dispatch_delivery_id = v_row.id
      WHERE id = v_sla.id;
    END IF;

    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_oa, v_row.recipient_zalo_uid,
                        v_row.customer_id, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.* INTO v_row
  FROM public.zalo_outbound_deliveries d
  WHERE d.company_id = p_company_id AND d.channel = 'ZALO' AND d.command_id = p_command_id
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_COMMAND_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF v_row.conversation_id <> v_conv.id OR v_row.content_sha256 IS DISTINCT FROM p_content_sha256 THEN
    RETURN QUERY SELECT 'CONFLICT'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
    RETURN;
  END IF;

  IF v_row.status = 'SENT' THEN
    RETURN QUERY SELECT 'ALREADY_SENT'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
    RETURN;
  END IF;

  IF v_row.status = 'PROVIDER_SENT_PENDING_FINALIZE' THEN
    RETURN QUERY SELECT 'PENDING_FINALIZE'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, v_row.provider_msg_id, NULL::uuid;
    RETURN;
  END IF;

  IF v_row.status IN ('FAILED', 'PENDING') THEN
    UPDATE public.zalo_outbound_deliveries d
    SET status = 'SENDING', attempts = d.attempts + 1, lease_until = v_now + v_lease,
        claim_token = v_token, error_code = NULL, error_message = NULL, updated_at = v_now
    WHERE d.id = v_row.id;

    IF p_actor_type = 'SALE' AND v_sla.id IS NOT NULL THEN
      UPDATE public.response_sla_windows
      SET dispatch_delivery_id = v_row.id
      WHERE id = v_sla.id;
    END IF;

    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' AND v_row.lease_until IS NOT NULL AND v_row.lease_until > v_now THEN
    RETURN QUERY SELECT 'BUSY'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' THEN
    UPDATE public.zalo_outbound_deliveries d
    SET status = 'PROVIDER_UNCERTAIN', lease_until = NULL,
        error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = v_now
    WHERE d.id = v_row.id;

    IF p_actor_type = 'SALE' AND v_sla.id IS NOT NULL THEN
      UPDATE public.response_sla_windows
      SET dispatch_state = 'UNCERTAIN', dispatch_fenced_until = NULL, updated_at = v_now
      WHERE id = v_sla.id;
    END IF;
  END IF;

  RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                      v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) TO service_role;


-- 7. Redefine zalo_record_outbound_provider_result to participate in SLA dispatch state
CREATE OR REPLACE FUNCTION public.zalo_record_outbound_provider_result(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_msg_id text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_outcome NOT IN ('ACCEPTED', 'REJECTED', 'UNCERTAIN') THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_OUTCOME_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT d.* INTO v_row FROM public.zalo_outbound_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF v_row.id IS NULL
     OR v_row.claim_token IS DISTINCT FROM p_claim_token
     OR v_row.status NOT IN ('SENDING', 'PROVIDER_UNCERTAIN') THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;

  v_status := CASE p_outcome
    WHEN 'ACCEPTED' THEN 'PROVIDER_SENT_PENDING_FINALIZE'
    WHEN 'REJECTED' THEN 'FAILED'
    ELSE 'PROVIDER_UNCERTAIN'
  END;

  UPDATE public.zalo_outbound_deliveries d
  SET status = v_status,
      provider_msg_id = CASE WHEN p_outcome = 'ACCEPTED' THEN p_provider_msg_id ELSE d.provider_msg_id END,
      provider_accepted_at = CASE WHEN p_outcome = 'ACCEPTED' THEN v_now ELSE d.provider_accepted_at END,
      error_code = CASE WHEN p_outcome = 'ACCEPTED' THEN NULL ELSE left(p_error_code, 100) END,
      error_message = CASE WHEN p_outcome = 'ACCEPTED' THEN NULL ELSE left(p_error_message, 500) END,
      lease_until = NULL,
      claim_token = CASE WHEN p_outcome = 'REJECTED' THEN NULL ELSE d.claim_token END,
      updated_at = v_now
  WHERE d.id = p_delivery_id;

  -- Synchronize with response_sla_windows if this delivery was a SALE send
  IF v_row.actor_type = 'SALE' THEN
    IF p_outcome = 'ACCEPTED' THEN
      UPDATE public.response_sla_windows
      SET dispatch_state = 'PROVIDER_ACCEPTED',
          updated_at = v_now
      WHERE conversation_id = v_row.conversation_id
        AND state = 'OPEN'
        AND dispatch_owner = 'SALE';
    ELSIF p_outcome = 'REJECTED' THEN
      UPDATE public.response_sla_windows
      SET dispatch_owner = NULL,
          dispatch_state = 'FAILED',
          dispatch_token = NULL,
          dispatch_fenced_until = NULL,
          dispatch_delivery_id = NULL,
          updated_at = v_now
      WHERE conversation_id = v_row.conversation_id
        AND state = 'OPEN'
        AND dispatch_owner = 'SALE';
    ELSE -- UNCERTAIN
      UPDATE public.response_sla_windows
      SET dispatch_state = 'UNCERTAIN',
          dispatch_fenced_until = NULL,
          updated_at = v_now
      WHERE conversation_id = v_row.conversation_id
        AND state = 'OPEN'
        AND dispatch_owner = 'SALE';
    END IF;
  END IF;

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text) TO service_role;


-- 8. Redefine zalo_finalize_outbound_delivery to resolve Response SLA on Sale send
CREATE OR REPLACE FUNCTION public.zalo_finalize_outbound_delivery(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_raw text;
  v_ref text;
  v_interaction_id uuid;
  v_existing record;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT d.* INTO v_row FROM public.zalo_outbound_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.status = 'SENT' THEN
    RETURN jsonb_build_object('interaction_id', v_row.interaction_id, 'already_finalized', true,
                              'provider_msg_id', v_row.provider_msg_id);
  END IF;

  IF v_row.status <> 'PROVIDER_SENT_PENDING_FINALIZE' THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_NOT_FINALIZABLE' USING ERRCODE = '55000';
  END IF;

  SELECT p.raw_content INTO v_raw FROM private.zalo_outbound_payloads p WHERE p.delivery_id = v_row.id;
  IF v_raw IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_PAYLOAD_MISSING' USING ERRCODE = 'P0002';
  END IF;

  PERFORM private.zalo_lock_user(v_row.company_id, v_row.recipient_zalo_uid);

  v_ref := 'zalo:' || v_row.company_id::text || ':' || coalesce(v_row.oa_id, 'unknown') || ':'
           || coalesce(v_row.provider_msg_id, 'outbound:' || v_row.id::text);

  SELECT i.id, i.actor_user_id INTO v_existing
  FROM public.interactions i
  WHERE i.company_id = v_row.company_id AND i.channel = 'ZALO' AND i.external_ref = v_ref;

  IF v_existing.id IS NOT NULL THEN
    v_interaction_id := v_existing.id;
    UPDATE public.interactions i
    SET actor_type = coalesce(v_row.actor_type, i.actor_type),
        actor_user_id = coalesce(i.actor_user_id, v_row.actor_user_id)
    WHERE i.id = v_existing.id AND i.actor_user_id IS NULL;
  ELSE
    INSERT INTO public.interactions (
      company_id, customer_id, conversation_id, channel, type, direction,
      sanitized_content, sanitization_status, sanitized_at, sanitizer_version,
      external_ref, actor_type, actor_user_id, created_at
    ) VALUES (
      v_row.company_id, v_row.customer_id, v_row.conversation_id, 'ZALO', 'MESSAGE', 'OUTBOUND',
      v_row.content, 'SUCCEEDED', v_now, 'zalo-sanitizer-v1',
      v_ref, coalesce(v_row.actor_type, 'SYSTEM'), v_row.actor_user_id,
      coalesce(v_row.provider_accepted_at, v_now)
    )
    RETURNING id INTO v_interaction_id;

    INSERT INTO private.interaction_raw_contents (interaction_id, company_id, raw_content, raw_payload, source_metadata)
    VALUES (
      v_interaction_id, v_row.company_id, v_raw,
      jsonb_build_object('recipient', jsonb_build_object('user_id', v_row.recipient_zalo_uid)),
      jsonb_build_object(
        'oa_id', v_row.oa_id,
        'recipient_id', v_row.recipient_zalo_uid,
        'provider_msg_id', v_row.provider_msg_id,
        'delivery_id', v_row.id,
        'command_id', v_row.command_id,
        'origin', 'CRM_OUTBOX'
      )
    );

    UPDATE public.conversations c
    SET last_message_at = greatest(c.last_message_at, coalesce(v_row.provider_accepted_at, v_now)),
        status = CASE WHEN c.status = 'AI_HANDLING' THEN 'OPEN' ELSE c.status END
    WHERE c.id = v_row.conversation_id;
  END IF;

  UPDATE public.zalo_outbound_deliveries d
  SET status = 'SENT', interaction_id = v_interaction_id, finalized_at = v_now,
      claim_token = NULL, lease_until = NULL, error_code = NULL, error_message = NULL, updated_at = v_now
  WHERE d.id = v_row.id;

  -- If this was a SALE send, resolve the Response SLA window to SALE_RESPONDED
  IF v_row.actor_type = 'SALE' THEN
    UPDATE public.response_sla_windows
    SET state = 'SALE_RESPONDED',
        sale_response_interaction_id = v_interaction_id,
        resolved_at = coalesce(v_row.provider_accepted_at, v_now),
        dispatch_owner = 'SALE',
        dispatch_state = 'PROVIDER_ACCEPTED',
        dispatch_fenced_until = NULL,
        ai_dispatch_fenced_until = NULL,
        ai_dispatch_token = NULL,
        updated_at = v_now
    WHERE conversation_id = v_row.conversation_id
      AND state = 'OPEN';
  END IF;

  RETURN jsonb_build_object('interaction_id', v_interaction_id, 'already_finalized', false,
                            'provider_msg_id', v_row.provider_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_finalize_outbound_delivery(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_finalize_outbound_delivery(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_finalize_outbound_delivery(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_finalize_outbound_delivery(uuid) TO service_role;


-- 9. Redefine finalize_ai_outbound_delivery_atomic to update shared dispatch ownership
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

  -- 4. Validate stable logical command identity & window binding
  IF (v_delivery.window_id IS NOT NULL AND v_delivery.window_id <> p_window_id)
     OR v_delivery.client_command_id IS DISTINCT FROM p_window_id THEN
    RAISE EXCEPTION 'COMMAND_IDENTITY_MISMATCH' USING ERRCODE = '22023';
  END IF;

  -- 5. Lock and validate SLA window
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

  -- 6. Validate claim authority (Item 2: strict validation, no unconditional bypass)
  IF p_ai_claim_id IS NULL OR v_window.ai_claim_id IS DISTINCT FROM p_ai_claim_id THEN
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

  -- 12. Atomically resolve Response SLA window to AI_RESPONDED & set dispatch ownership
  UPDATE public.response_sla_windows
  SET
    state = 'AI_RESPONDED',
    ai_response_interaction_id = v_interaction_id,
    resolved_at = v_now,
    dispatch_owner = 'AI',
    dispatch_state = 'PROVIDER_ACCEPTED',
    dispatch_fenced_until = NULL,
    ai_dispatch_fenced_until = NULL,
    ai_dispatch_token = NULL,
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


-- 10. Redefine finalize_ai_zalo_sla_atomic to update shared dispatch ownership
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
  v_supplied_interaction public.interactions%ROWTYPE;
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

  -- 4. Validate claim authority (Item 2: strict validation, no unconditional bypass)
  IF p_ai_claim_id IS NULL OR v_window.ai_claim_id IS DISTINCT FROM p_ai_claim_id THEN
    RAISE EXCEPTION 'CLAIM_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  -- 5. Determine or mint interaction with strict binding validation (Item 6)
  IF p_interaction_id IS NOT NULL THEN
    SELECT * INTO v_supplied_interaction
    FROM public.interactions
    WHERE id = p_interaction_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    IF v_supplied_interaction.company_id <> p_company_id THEN
      RAISE EXCEPTION 'INTERACTION_COMPANY_MISMATCH' USING ERRCODE = '42501';
    END IF;

    IF v_supplied_interaction.conversation_id <> v_zalo.conversation_id THEN
      RAISE EXCEPTION 'INTERACTION_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
    END IF;

    IF v_supplied_interaction.customer_id <> v_zalo.customer_id THEN
      RAISE EXCEPTION 'INTERACTION_CUSTOMER_MISMATCH' USING ERRCODE = '22000';
    END IF;

    IF v_supplied_interaction.channel <> 'ZALO' THEN
      RAISE EXCEPTION 'INTERACTION_CHANNEL_MISMATCH' USING ERRCODE = '22000';
    END IF;

    IF v_supplied_interaction.direction <> 'OUTBOUND' THEN
      RAISE EXCEPTION 'INTERACTION_DIRECTION_MISMATCH' USING ERRCODE = '22000';
    END IF;

    IF v_supplied_interaction.actor_type <> 'AI' THEN
      RAISE EXCEPTION 'INTERACTION_ACTOR_MISMATCH' USING ERRCODE = '22000';
    END IF;

    IF v_zalo.interaction_id IS NOT NULL AND v_zalo.interaction_id <> p_interaction_id THEN
      RAISE EXCEPTION 'INTERACTION_DELIVERY_MISMATCH' USING ERRCODE = '22023';
    END IF;

    v_interaction_id := p_interaction_id;
  ELSE
    v_interaction_id := v_zalo.interaction_id;
  END IF;

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

  -- 7. Atomically resolve Response SLA window & set dispatch ownership
  UPDATE public.response_sla_windows
  SET
    state = 'AI_RESPONDED',
    ai_response_interaction_id = v_interaction_id,
    resolved_at = v_now,
    dispatch_owner = 'AI',
    dispatch_state = 'PROVIDER_ACCEPTED',
    dispatch_fenced_until = NULL,
    ai_dispatch_fenced_until = NULL,
    ai_dispatch_token = NULL,
    updated_at = v_now
  WHERE id = p_window_id
    AND company_id = p_company_id
    AND state = 'OPEN';

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated = 0 THEN
    RAISE EXCEPTION 'SLA_WINDOW_UPDATE_AFFECTED_ZERO_ROWS' USING ERRCODE = 'P0001';
  END IF;

  -- 8. Record AI Provenance in private.interaction_raw_contents (strict append-only)
  IF NOT EXISTS (
    SELECT 1 FROM private.interaction_raw_contents
    WHERE interaction_id = v_interaction_id
  ) THEN
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

