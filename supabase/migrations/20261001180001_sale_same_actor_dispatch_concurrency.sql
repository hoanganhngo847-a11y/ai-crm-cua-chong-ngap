-- Migration: 20261001180001_sale_same_actor_dispatch_concurrency.sql
-- Description: Enforce same-actor Sale-vs-Sale dispatch exclusion, bind Sale provider outcomes
-- to exact shared dispatch ownership (dispatch_delivery_id and dispatch_token), add state machine DB constraints,
-- and establish composite index for hot-path active dispatch fences.

-- ============================================================================
-- 1. DB CONSTRAINTS & COMPOSITE INDEX (Requirements 6 & 7)
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_response_sla_dispatch_owner'
  ) THEN
    ALTER TABLE public.response_sla_windows
      ADD CONSTRAINT chk_response_sla_dispatch_owner
      CHECK (dispatch_owner IS NULL OR dispatch_owner IN ('AI', 'SALE', 'NONE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_response_sla_dispatch_state'
  ) THEN
    ALTER TABLE public.response_sla_windows
      ADD CONSTRAINT chk_response_sla_dispatch_state
      CHECK (dispatch_state IS NULL OR dispatch_state IN ('IDLE', 'DISPATCHING', 'PROVIDER_ACCEPTED', 'FAILED', 'UNCERTAIN'));
  END IF;
END $$;

-- Composite index for hot-path company/conversation/open-window lookups
CREATE INDEX IF NOT EXISTS idx_sla_active_dispatch_fence_composite
  ON public.response_sla_windows (company_id, conversation_id, dispatch_owner, dispatch_fenced_until)
  WHERE state = 'OPEN' AND dispatch_owner IN ('AI', 'SALE');


-- ============================================================================
-- 2. REDEFINE han_prepare_send (Requirements 1, 3, 5)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.han_prepare_send(
    p_company uuid,
    p_conversation uuid,
    p_actor uuid,
    p_request uuid,
    p_content text,
    p_safe text,
    p_safe_status text,
    p_delivery uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_existing private.han_outbox%ROWTYPE;
  v_conversation public.conversations%ROWTYPE;
  v_interaction uuid;
  v_now timestamptz := clock_timestamp();
  v_last_inbound timestamptz;
  v_sla public.response_sla_windows%ROWTYPE;
  v_sale_token uuid;
  v_lease interval := interval '120 seconds';
BEGIN
  -- Validate actor role and active status
  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members m
    JOIN public.user_profiles up ON up.id = m.user_id AND up.status = 'ACTIVE'
    WHERE m.company_id = p_company
      AND m.user_id = p_actor
      AND m.status = 'ACTIVE'
      AND m.role IN ('SALE', 'BOSS_ADMIN')
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED';
  END IF;

  -- Validate conversation exists in the company
  SELECT * INTO v_conversation
  FROM public.conversations
  WHERE id = p_conversation AND company_id = p_company
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;

  -- 24-hour Messenger window check
  SELECT max(created_at) INTO v_last_inbound
  FROM public.interactions
  WHERE conversation_id = p_conversation
    AND company_id = p_company
    AND direction = 'INBOUND';

  IF v_last_inbound IS NULL OR v_last_inbound < (v_now - interval '24 hours') THEN
    RAISE EXCEPTION 'WINDOW_CLOSED';
  END IF;

  -- Check existing outbox row for this request_id (idempotency)
  SELECT * INTO v_existing
  FROM private.han_outbox
  WHERE company_id = p_company AND request_id = p_request
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.conversation_id <> p_conversation
       OR v_existing.content <> p_content
       OR v_existing.care_delivery_id IS DISTINCT FROM p_delivery THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;

    RETURN jsonb_build_object(
      'claimed', false,
      'status', v_existing.status
    );
  END IF;

  -- Validation
  IF coalesce(btrim(p_content), '') = '' OR coalesce(btrim(p_safe), '') = '' THEN
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
  -- PRE-PROVIDER RESPONSE SLA DISPATCH FENCING (Requirements 1, 3, 5)
  -- ============================================================================
  SELECT * INTO v_sla
  FROM public.response_sla_windows
  WHERE company_id = p_company
    AND conversation_id = p_conversation
    AND state = 'OPEN'
  FOR UPDATE;

  IF FOUND THEN
    -- A. If AI currently owns dispatch
    IF v_sla.dispatch_owner = 'AI' OR v_sla.ai_dispatch_fenced_until IS NOT NULL THEN
      IF (v_sla.dispatch_state = 'DISPATCHING' OR v_sla.ai_dispatch_token IS NOT NULL) THEN
        IF coalesce(v_sla.dispatch_fenced_until, v_sla.ai_dispatch_fenced_until) > v_now THEN
          -- AI currently holds external provider dispatch authority!
          RETURN jsonb_build_object(
            'claimed', false,
            'status', 'AI_DISPATCH_FENCED'
          );
        ELSE
          -- AI dispatch lease expired mid-flight: transition logical operation to UNCERTAIN! Fail safe!
          UPDATE public.response_sla_windows
          SET
            dispatch_state = 'UNCERTAIN',
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

    -- B. If SALE currently owns dispatch (Sale-vs-Sale concurrency protection)
    IF v_sla.dispatch_owner = 'SALE' THEN
      IF v_sla.dispatch_state = 'DISPATCHING' THEN
        IF v_sla.dispatch_fenced_until > v_now THEN
          -- Sale dispatch is currently in-flight!
          -- If this is a DIFFERENT request, deny before external provider call:
          IF v_sla.dispatch_delivery_id IS DISTINCT FROM p_request THEN
            RETURN jsonb_build_object(
              'claimed', false,
              'status', 'SALE_ALREADY_DISPATCHING'
            );
          END IF;
        ELSE
          -- Existing Sale lease expired unresolved: transition to UNCERTAIN! Fail safe!
          UPDATE public.response_sla_windows
          SET
            dispatch_state = 'UNCERTAIN',
            dispatch_fenced_until = NULL,
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
          'status', 'SALE_ALREADY_RESPONDED'
        );
      END IF;
    END IF;

    -- C. If dispatch_state is UNCERTAIN (regardless of owner)
    IF v_sla.dispatch_state = 'UNCERTAIN' THEN
      -- Neither Sale nor AI may automatically dispatch a new message while outcome is ambiguous!
      RETURN jsonb_build_object(
        'claimed', false,
        'status', 'DISPATCH_UNCERTAIN'
      );
    END IF;

    -- D. Atomically acquire SALE dispatch ownership for this new send
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
  IS 'Prepares an outbound Facebook message with pre-dispatch Response SLA cross-actor and same-actor fencing.';

REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) TO service_role;


-- ============================================================================
-- 3. REDEFINE han_finish_send (Requirements 3 & 5)
-- ============================================================================
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
#variable_conflict use_column
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
    -- Strictly validate dispatch_delivery_id == p_request and dispatch_owner = 'SALE' (Requirement 3 & 5)
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
      AND state = 'OPEN'
      AND dispatch_delivery_id = p_request
      AND dispatch_owner = 'SALE';

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
      AND dispatch_delivery_id = p_request
      AND dispatch_owner = 'SALE';

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
      AND dispatch_delivery_id = p_request
      AND dispatch_owner = 'SALE';
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
  IS 'Finishes outbound Facebook message send, binding SLA resolution strictly to dispatch_delivery_id.';

REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_finish_send(uuid, uuid, text, text) TO service_role;


-- ============================================================================
-- 4. REDEFINE zalo_claim_outbound_delivery (Requirements 2, 3, 5)
-- ============================================================================
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
  v_existing_cmd text;
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
  -- HUMAN SALE RESPONSE SLA CROSS-ACTOR & SAME-ACTOR DISPATCH FENCING (Requirements 2, 3)
  -- ============================================================================
  IF p_actor_type = 'SALE' THEN
    SELECT * INTO v_sla
    FROM public.response_sla_windows
    WHERE company_id = p_company_id
      AND conversation_id = p_conversation_id
      AND state = 'OPEN'
    FOR UPDATE;

    IF FOUND THEN
      -- A. If dispatch_state is already UNCERTAIN
      IF v_sla.dispatch_state = 'UNCERTAIN' THEN
        RAISE EXCEPTION 'DISPATCH_UNCERTAIN' USING ERRCODE = '55000';
      END IF;

      -- B. If AI currently owns dispatch
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

      -- C. If SALE currently owns dispatch (Sale-vs-Sale concurrent dispatch prevention)
      IF v_sla.dispatch_owner = 'SALE' THEN
        IF v_sla.dispatch_state = 'DISPATCHING' THEN
          IF v_sla.dispatch_fenced_until > v_now THEN
            -- An active Sale dispatch lease exists!
            -- Check if this command belongs to the currently in-flight delivery
            IF v_sla.dispatch_delivery_id IS NOT NULL THEN
              SELECT command_id INTO v_existing_cmd
              FROM public.zalo_outbound_deliveries
              WHERE id = v_sla.dispatch_delivery_id;

              IF v_existing_cmd IS DISTINCT FROM p_command_id THEN
                -- Different Sale command while C1 is in-flight! Deny before provider call:
                RAISE EXCEPTION 'SALE_ALREADY_DISPATCHING' USING ERRCODE = '55000';
              END IF;
            ELSE
              RAISE EXCEPTION 'SALE_ALREADY_DISPATCHING' USING ERRCODE = '55000';
            END IF;
          ELSE
            -- Existing Sale lease expired unresolved: transition to UNCERTAIN! Fail safe!
            UPDATE public.response_sla_windows
            SET dispatch_state = 'UNCERTAIN',
                dispatch_fenced_until = NULL,
                updated_at = v_now
            WHERE id = v_sla.id;

            RAISE EXCEPTION 'DISPATCH_UNCERTAIN' USING ERRCODE = '55000';
          END IF;
        ELSIF v_sla.dispatch_state = 'PROVIDER_ACCEPTED' THEN
          RAISE EXCEPTION 'SALE_ALREADY_RESPONDED' USING ERRCODE = '55000';
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
                        v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
    RETURN;
  END IF;

  IF v_row.status IN ('PROVIDER_UNCERTAIN', 'UNCERTAIN') THEN
    RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' AND v_row.lease_until > v_now THEN
    RETURN QUERY SELECT 'BUSY'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  UPDATE public.zalo_outbound_deliveries
  SET claim_token = v_token, lease_until = v_now + v_lease, attempts = attempts + 1, updated_at = v_now
  WHERE id = v_row.id;

  IF p_actor_type = 'SALE' AND v_sla.id IS NOT NULL THEN
    UPDATE public.response_sla_windows
    SET dispatch_delivery_id = v_row.id
    WHERE id = v_sla.id;
  END IF;

  RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_row.oa_id, v_row.recipient_zalo_uid,
                      v_row.customer_id, NULL::text, NULL::uuid;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) TO service_role;


-- ============================================================================
-- 5. REDEFINE zalo_record_outbound_provider_result (Requirements 3 & 5)
-- ============================================================================
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
#variable_conflict use_column
DECLARE
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_sla public.response_sla_windows%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_status text;
BEGIN
  SELECT d.* INTO v_row FROM public.zalo_outbound_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_CLAIM_TOKEN_MISMATCH' USING ERRCODE = '55000';
  END IF;

  IF v_row.status = 'SENT' THEN
    RETURN 'SENT';
  END IF;

  IF p_outcome = 'ACCEPTED' THEN
    v_status := 'PROVIDER_SENT_PENDING_FINALIZE';
    UPDATE public.zalo_outbound_deliveries d
    SET status = v_status,
        provider_msg_id = coalesce(p_provider_msg_id, d.provider_msg_id),
        provider_accepted_at = coalesce(d.provider_accepted_at, v_now),
        error_code = NULL,
        error_message = NULL,
        updated_at = v_now
    WHERE d.id = v_row.id;
  ELSIF p_outcome = 'REJECTED' THEN
    v_status := 'FAILED';
    UPDATE public.zalo_outbound_deliveries d
    SET status = v_status,
        error_code = coalesce(p_error_code, 'REJECTED'),
        error_message = p_error_message,
        claim_token = NULL,
        lease_until = NULL,
        updated_at = v_now
    WHERE d.id = v_row.id;
  ELSE
    v_status := 'PROVIDER_UNCERTAIN';
    UPDATE public.zalo_outbound_deliveries d
    SET status = v_status,
        error_code = coalesce(p_error_code, 'UNCERTAIN'),
        error_message = p_error_message,
        claim_token = NULL,
        lease_until = NULL,
        updated_at = v_now
    WHERE d.id = v_row.id;
  END IF;

  -- Synchronize with response_sla_windows strictly validating delivery and claim token binding (Requirement 3)
  IF v_row.actor_type = 'SALE' THEN
    SELECT * INTO v_sla
    FROM public.response_sla_windows
    WHERE conversation_id = v_row.conversation_id
      AND company_id = v_row.company_id
      AND state = 'OPEN'
    FOR UPDATE;

    IF FOUND THEN
      -- Validate exact delivery ID binding and active Sale ownership (Requirement 3)
      -- A stale or unrelated delivery must NEVER mutate or release another delivery's fence!
      IF v_sla.dispatch_delivery_id = p_delivery_id
         AND v_sla.dispatch_owner = 'SALE'
         AND v_sla.dispatch_token = p_claim_token THEN
        IF p_outcome = 'ACCEPTED' THEN
          UPDATE public.response_sla_windows
          SET dispatch_state = 'PROVIDER_ACCEPTED',
              updated_at = v_now
          WHERE id = v_sla.id;
        ELSIF p_outcome = 'REJECTED' THEN
          UPDATE public.response_sla_windows
          SET dispatch_owner = NULL,
              dispatch_state = 'FAILED',
              dispatch_token = NULL,
              dispatch_fenced_until = NULL,
              dispatch_delivery_id = NULL,
              updated_at = v_now
          WHERE id = v_sla.id;
        ELSE -- UNCERTAIN
          UPDATE public.response_sla_windows
          SET dispatch_state = 'UNCERTAIN',
              dispatch_fenced_until = NULL,
              updated_at = v_now
          WHERE id = v_sla.id;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text) TO service_role;


-- ============================================================================
-- 6. REDEFINE zalo_finalize_outbound_delivery (Requirements 3 & 5)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.zalo_finalize_outbound_delivery(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_sla public.response_sla_windows%ROWTYPE;
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

  -- Bind outcome mutation to dispatch_delivery_id == p_delivery_id and Sale ownership (Requirements 3 & 5)
  IF v_row.actor_type = 'SALE' THEN
    SELECT * INTO v_sla
    FROM public.response_sla_windows
    WHERE conversation_id = v_row.conversation_id
      AND company_id = v_row.company_id
      AND state = 'OPEN'
    FOR UPDATE;

    IF FOUND THEN
      -- Validate exact delivery binding
      IF v_sla.dispatch_delivery_id = p_delivery_id AND v_sla.dispatch_owner = 'SALE' THEN
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
        WHERE id = v_sla.id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('interaction_id', v_interaction_id, 'already_finalized', false,
                            'provider_msg_id', v_row.provider_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_finalize_outbound_delivery(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_finalize_outbound_delivery(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_finalize_outbound_delivery(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_finalize_outbound_delivery(uuid) TO service_role;
