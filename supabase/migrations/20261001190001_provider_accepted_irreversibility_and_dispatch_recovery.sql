-- Migration: 20261001190001_provider_accepted_irreversibility_and_dispatch_recovery.sql
-- Description: Enforce provider-accepted irreversibility, same-command token stability,
--              PENDING_FINALIZE crash recovery, persisted lease-expiry UNCERTAIN state,
--              removal of Facebook legacy SLA bypass, and restoration of all han_prepare_send security guards.

-- ============================================================================
-- 1. REDEFINE han_prepare_send WITH ALL RESTORED SECURITY & INVARIANT GUARDS
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
DECLARE
  v_conversation public.conversations%ROWTYPE;
  v_existing private.han_outbox%ROWTYPE;
  v_interaction uuid;
  v_latest timestamptz;
  v_sla public.response_sla_windows%ROWTYPE;
  v_sale_token uuid;
  v_now timestamptz := clock_timestamp();
  v_lease interval := interval '120 seconds';
BEGIN
  -- 1. Advisory transaction lock for (company, request) idempotent serialization
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'han-send:' || p_company::text || p_request::text,
      0
    )
  );

  -- 2. Validate Conversation belongs to company and channel is FACEBOOK
  SELECT * INTO v_conversation
  FROM public.conversations
  WHERE company_id = p_company
    AND id = p_conversation
    AND channel = 'FACEBOOK'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;

  -- 3. Validate company, user profile, and membership are ACTIVE with allowed role
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

  -- 4. Existing outbox idempotency with actor_id binding
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

  -- 5. Messenger window based strictly on CUSTOMER inbound messages with future-timestamp tolerance
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

  -- 6. Content length bounds and strict p_safe_status rules
  IF length(p_content) NOT BETWEEN 1 AND 2000
    OR p_content IS NULL
    OR p_safe_status IS NULL OR p_safe_status NOT IN ('FAILED', 'SUCCEEDED')
    OR (p_safe_status = 'FAILED' AND p_safe IS NOT NULL)
    OR (p_safe_status = 'SUCCEEDED' AND p_safe IS NULL)
    OR (p_safe IS NOT NULL AND length(p_safe) NOT BETWEEN 1 AND 2000)
  THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  -- 7. Care delivery validation
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
  -- 8. PRE-PROVIDER RESPONSE SLA DISPATCH FENCING (Cross-Actor & Same-Actor)
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
          RETURN jsonb_build_object(
            'claimed', false,
            'status', 'AI_DISPATCH_FENCED'
          );
        ELSE
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

    -- B. If SALE currently owns dispatch (Same-actor concurrent dispatch prevention)
    IF v_sla.dispatch_owner = 'SALE' THEN
      IF v_sla.dispatch_state = 'DISPATCHING' THEN
        IF v_sla.dispatch_fenced_until > v_now THEN
          IF v_sla.dispatch_delivery_id IS DISTINCT FROM p_request THEN
            RETURN jsonb_build_object(
              'claimed', false,
              'status', 'SALE_ALREADY_DISPATCHING'
            );
          END IF;
        ELSE
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

    -- C. If dispatch_state is UNCERTAIN
    IF v_sla.dispatch_state = 'UNCERTAIN' THEN
      RETURN jsonb_build_object(
        'claimed', false,
        'status', 'DISPATCH_UNCERTAIN'
      );
    END IF;

    -- D. Atomically acquire SALE dispatch ownership for this send
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

REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_prepare_send(uuid, uuid, uuid, uuid, text, text, text, uuid) TO service_role;


-- ============================================================================
-- 2. REDEFINE han_finish_send WITH STRICT BINDING AND ZERO LEGACY RESOLVER BYPASS
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
  v_interaction public.interactions%ROWTYPE;
  v_sent_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_sla_rows integer := 0;
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

    -- Validate interaction integrity: must be an OUTBOUND MESSAGE
    SELECT * INTO v_interaction
    FROM public.interactions
    WHERE id = v_row.interaction_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    IF v_interaction.type <> 'MESSAGE' THEN
      RAISE EXCEPTION 'INVALID_INTERACTION_TYPE' USING ERRCODE = '22000';
    END IF;

    IF v_interaction.direction <> 'OUTBOUND' THEN
      RAISE EXCEPTION 'INVALID_INTERACTION_DIRECTION' USING ERRCODE = '22000';
    END IF;

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

    -- Update Response SLA window: strictly bound to dispatch_delivery_id == p_request and dispatch_owner = 'SALE'
    -- SOLE transition mechanism; zero fallback to legacy resolver (Requirement 5)
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
      AND (state = 'OPEN' OR (state = 'OPEN' AND dispatch_state = 'UNCERTAIN'))
      AND dispatch_delivery_id = p_request
      AND dispatch_owner = 'SALE';

    GET DIAGNOSTICS v_sla_rows = ROW_COUNT;
    -- If v_sla_rows = 0, p_request was not the active dispatch owner of this window;
    -- outbox is updated above but active SLA window is strictly NOT mutated or resolved.

  ELSIF p_status = 'FAILED' THEN
    UPDATE private.han_outbox
    SET status = p_status,
        provider_mid = p_mid
    WHERE company_id = p_company
      AND request_id = p_request;

    UPDATE public.response_sla_windows
    SET dispatch_owner = 'NONE',
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
        ELSE 'FAILED'
      END,
      provider_msg_id = CASE
        WHEN p_status = 'SENT' THEN p_mid
        ELSE NULL
      END,
      sent_at = CASE
        WHEN p_status = 'SENT' THEN v_sent_at
        ELSE NULL
      END,
      updated_at = v_now
    WHERE id = v_row.care_delivery_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_finish_send(uuid, uuid, text, text) TO service_role;


-- ============================================================================
-- 3. REDEFINE zalo_claim_outbound_delivery WITH SAME-COMMAND INSPECTION FIRST,
--    ZERO TOKEN ROTATION ON BUSY/REPLAY, CRASH RECOVERY, AND PERSISTED UNCERTAIN
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
  v_token uuid;
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
  -- STEP 1: INSPECT SAME-COMMAND DELIVERY FIRST BEFORE MUTATING ANY TOKENS
  -- (Requirement 2 & 3: Token Stability & PENDING_FINALIZE Crash Recovery)
  -- ============================================================================
  SELECT d.* INTO v_row
  FROM public.zalo_outbound_deliveries d
  WHERE d.company_id = p_company_id AND d.channel = 'ZALO' AND d.command_id = p_command_id
  FOR UPDATE;

  IF v_row.id IS NOT NULL THEN
    -- Mismatch check
    IF v_row.conversation_id <> v_conv.id OR v_row.content_sha256 IS DISTINCT FROM p_content_sha256 THEN
      RETURN QUERY SELECT 'CONFLICT'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                          v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
      RETURN;
    END IF;

    -- Already finalized
    IF v_row.status = 'SENT' THEN
      RETURN QUERY SELECT 'ALREADY_SENT'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                          v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
      RETURN;
    END IF;

    -- PENDING_FINALIZE crash recovery (zero network, zero token rotation, allows Sale recovery)
    IF v_row.status = 'PROVIDER_SENT_PENDING_FINALIZE' THEN
      RETURN QUERY SELECT 'PENDING_FINALIZE'::text, v_row.id, v_row.claim_token, v_row.oa_id, v_row.recipient_zalo_uid,
                          v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
      RETURN;
    END IF;

    -- Ambiguous / Uncertain
    IF v_row.status IN ('PROVIDER_UNCERTAIN', 'UNCERTAIN') THEN
      RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                          v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
      RETURN;
    END IF;

    -- In-flight SENDING
    IF v_row.status = 'SENDING' THEN
      IF v_row.lease_until > v_now THEN
        -- Live lease: return BUSY with ZERO mutation of tokens or window
        RETURN QUERY SELECT 'BUSY'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                            v_row.customer_id, NULL::text, NULL::uuid;
        RETURN;
      ELSE
        -- Lease expired mid-flight: persist PROVIDER_UNCERTAIN on delivery and UNCERTAIN on window
        UPDATE public.zalo_outbound_deliveries
        SET status = 'PROVIDER_UNCERTAIN',
            error_code = 'LEASE_EXPIRED',
            error_message = 'Outbound delivery lease expired while in-flight',
            claim_token = NULL,
            lease_until = NULL,
            updated_at = v_now
        WHERE id = v_row.id;

        IF p_actor_type = 'SALE' THEN
          UPDATE public.response_sla_windows
          SET dispatch_state = 'UNCERTAIN',
              dispatch_fenced_until = NULL,
              updated_at = v_now
          WHERE company_id = p_company_id
            AND conversation_id = p_conversation_id
            AND state = 'OPEN'
            AND (dispatch_delivery_id = v_row.id OR dispatch_owner = 'SALE');
        END IF;

        RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                            v_row.customer_id, NULL::text, NULL::uuid;
        RETURN;
      END IF;
    END IF;

    -- If status is FAILED: genuine retryable terminal state! We will mint a new token below.
    IF v_row.status <> 'FAILED' THEN
      RAISE EXCEPTION 'ZALO_OUTBOUND_COMMAND_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END IF;

  -- ============================================================================
  -- STEP 2: RESPONSE SLA DISPATCH FENCING (NEW CLAIM OR RETRY OF FAILED)
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
        RETURN QUERY SELECT 'UNCERTAIN'::text, NULL::uuid, NULL::uuid, v_oa, v_conv.external_conversation_id,
                            v_conv.customer_id, NULL::text, NULL::uuid;
        RETURN;
      END IF;

      -- B. If AI currently owns dispatch
      IF v_sla.dispatch_owner = 'AI' OR v_sla.ai_dispatch_fenced_until IS NOT NULL THEN
        IF (v_sla.dispatch_state = 'DISPATCHING' OR v_sla.ai_dispatch_token IS NOT NULL) THEN
          IF coalesce(v_sla.dispatch_fenced_until, v_sla.ai_dispatch_fenced_until) > v_now THEN
            RAISE EXCEPTION 'AI_DISPATCH_FENCED' USING ERRCODE = '55000';
          ELSE
            -- AI lease expired: persist UNCERTAIN (Requirement 4: no raise after mutation)
            UPDATE public.response_sla_windows
            SET dispatch_state = 'UNCERTAIN',
                dispatch_fenced_until = NULL,
                ai_dispatch_fenced_until = NULL,
                updated_at = v_now
            WHERE id = v_sla.id;

            RETURN QUERY SELECT 'UNCERTAIN'::text, NULL::uuid, NULL::uuid, v_oa, v_conv.external_conversation_id,
                                v_conv.customer_id, NULL::text, NULL::uuid;
            RETURN;
          END IF;
        ELSIF v_sla.dispatch_state = 'PROVIDER_ACCEPTED' THEN
          RAISE EXCEPTION 'AI_ALREADY_RESPONDED' USING ERRCODE = '55000';
        END IF;
      END IF;

      -- C. If SALE currently owns dispatch (Sale-vs-Sale concurrency protection)
      IF v_sla.dispatch_owner = 'SALE' THEN
        IF v_sla.dispatch_state = 'DISPATCHING' THEN
          IF v_sla.dispatch_fenced_until > v_now THEN
            -- Active Sale dispatch lease exists on a DIFFERENT command (since same-command was checked in Step 1)
            RAISE EXCEPTION 'SALE_ALREADY_DISPATCHING' USING ERRCODE = '55000';
          ELSE
            -- Sale lease expired: persist UNCERTAIN (Requirement 4: no raise after mutation)
            UPDATE public.response_sla_windows
            SET dispatch_state = 'UNCERTAIN',
                dispatch_fenced_until = NULL,
                updated_at = v_now
            WHERE id = v_sla.id;

            RETURN QUERY SELECT 'UNCERTAIN'::text, NULL::uuid, NULL::uuid, v_oa, v_conv.external_conversation_id,
                                v_conv.customer_id, NULL::text, NULL::uuid;
            RETURN;
          END IF;
        ELSIF v_sla.dispatch_state = 'PROVIDER_ACCEPTED' THEN
          RAISE EXCEPTION 'SALE_ALREADY_RESPONDED' USING ERRCODE = '55000';
        END IF;
      END IF;

      -- Acquire SALE response dispatch ownership
      v_token := gen_random_uuid();
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

  IF v_token IS NULL THEN
    v_token := gen_random_uuid();
  END IF;

  -- ============================================================================
  -- STEP 3: MINT/UPDATE DELIVERY AND BIND SLA DISPATCH_DELIVERY_ID
  -- ============================================================================
  IF v_row.id IS NOT NULL AND v_row.status = 'FAILED' THEN
    -- Retry FAILED: update delivery and shared window to the SAME new token atomically
    UPDATE public.zalo_outbound_deliveries
    SET claim_token = v_token,
        lease_until = v_now + v_lease,
        status = 'SENDING',
        attempts = attempts + 1,
        error_code = NULL,
        error_message = NULL,
        updated_at = v_now
    WHERE id = v_row.id;

    IF p_actor_type = 'SALE' AND v_sla.id IS NOT NULL THEN
      UPDATE public.response_sla_windows
      SET dispatch_delivery_id = v_row.id
      WHERE id = v_sla.id;
    END IF;

    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- New delivery insertion
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
  RETURNING d.* INTO v_row;

  INSERT INTO private.zalo_outbound_payloads (delivery_id, company_id, raw_content)
  VALUES (v_row.id, p_company_id, p_raw_content);

  IF p_actor_type = 'SALE' AND v_sla.id IS NOT NULL THEN
    UPDATE public.response_sla_windows
    SET dispatch_delivery_id = v_row.id
    WHERE id = v_sla.id;
  END IF;

  RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_oa, v_row.recipient_zalo_uid,
                      v_row.customer_id, NULL::text, NULL::uuid;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer) TO service_role;


-- ============================================================================
-- 4. REDEFINE zalo_record_outbound_provider_result WITH STRICT SOURCE-STATE
--    MACHINE AND IRREVERSIBLE PROVIDER ACCEPTANCE (Requirement 1 & 9)
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
  -- 1. Validate outcome argument strictly (Requirement 1)
  IF p_outcome NOT IN ('ACCEPTED', 'REJECTED', 'UNCERTAIN') THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_OUTCOME_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 2. Require non-empty provider message ID on ACCEPTED
  IF p_outcome = 'ACCEPTED' AND coalesce(btrim(p_provider_msg_id), '') = '' THEN
    RAISE EXCEPTION 'ZALO_PROVIDER_MSG_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT d.* INTO v_row FROM public.zalo_outbound_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_CLAIM_TOKEN_MISMATCH' USING ERRCODE = '55000';
  END IF;

  -- 3. Source-state machine enforcement:
  -- A. If already SENT:
  IF v_row.status = 'SENT' THEN
    IF p_outcome = 'ACCEPTED' THEN
      IF v_row.provider_msg_id IS NOT NULL AND v_row.provider_msg_id IS DISTINCT FROM p_provider_msg_id THEN
        RAISE EXCEPTION 'ZALO_PROVIDER_MSG_ID_CONFLICT' USING ERRCODE = '55000';
      END IF;
      RETURN 'SENT';
    ELSE
      RAISE EXCEPTION 'ZALO_OUTCOME_IRREVERSIBLE' USING ERRCODE = '55000';
    END IF;
  END IF;

  -- B. If already PROVIDER_SENT_PENDING_FINALIZE:
  IF v_row.status = 'PROVIDER_SENT_PENDING_FINALIZE' THEN
    IF p_outcome = 'ACCEPTED' THEN
      -- Idempotent replay with same provider message ID succeeds
      IF v_row.provider_msg_id IS NOT NULL AND v_row.provider_msg_id IS DISTINCT FROM p_provider_msg_id THEN
        RAISE EXCEPTION 'ZALO_PROVIDER_MSG_ID_CONFLICT' USING ERRCODE = '55000';
      END IF;
      RETURN 'PROVIDER_SENT_PENDING_FINALIZE';
    ELSE
      -- Contradictory REJECTED/UNCERTAIN after durable ACCEPTED must fail closed!
      RAISE EXCEPTION 'ZALO_OUTCOME_IRREVERSIBLE' USING ERRCODE = '55000';
    END IF;
  END IF;

  -- C. Fresh outcome recording allowed ONLY from SENDING or PROVIDER_UNCERTAIN
  IF v_row.status NOT IN ('SENDING', 'PROVIDER_UNCERTAIN') THEN
    RAISE EXCEPTION 'ZALO_INVALID_DELIVERY_STATE' USING ERRCODE = '55000';
  END IF;

  -- 4. Apply transition
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
  ELSE -- UNCERTAIN
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

  -- 5. Synchronize with response_sla_windows strictly matching delivery and tokens
  IF v_row.actor_type = 'SALE' THEN
    IF p_outcome = 'ACCEPTED' THEN
      UPDATE public.response_sla_windows
      SET dispatch_state = 'PROVIDER_ACCEPTED',
          updated_at = v_now
      WHERE company_id = v_row.company_id
        AND conversation_id = v_row.conversation_id
        AND dispatch_owner = 'SALE'
        AND dispatch_delivery_id = p_delivery_id
        AND dispatch_token = p_claim_token
        AND state = 'OPEN';
    ELSIF p_outcome = 'REJECTED' THEN
      UPDATE public.response_sla_windows
      SET dispatch_owner = 'NONE',
          dispatch_state = 'IDLE',
          dispatch_token = NULL,
          dispatch_fenced_until = NULL,
          dispatch_delivery_id = NULL,
          updated_at = v_now
      WHERE company_id = v_row.company_id
        AND conversation_id = v_row.conversation_id
        AND dispatch_owner = 'SALE'
        AND dispatch_delivery_id = p_delivery_id
        AND dispatch_token = p_claim_token
        AND state = 'OPEN';
    ELSE -- UNCERTAIN
      UPDATE public.response_sla_windows
      SET dispatch_state = 'UNCERTAIN',
          dispatch_fenced_until = NULL,
          updated_at = v_now
      WHERE company_id = v_row.company_id
        AND conversation_id = v_row.conversation_id
        AND dispatch_owner = 'SALE'
        AND dispatch_delivery_id = p_delivery_id
        AND dispatch_token = p_claim_token
        AND state = 'OPEN';
    END IF;

  ELSIF v_row.actor_type = 'AI' THEN
    SELECT * INTO v_sla
    FROM public.response_sla_windows
    WHERE company_id = v_row.company_id
      AND conversation_id = v_row.conversation_id
      AND state = 'OPEN'
    FOR UPDATE;

    IF FOUND THEN
      IF v_sla.ai_dispatch_token = p_claim_token
         OR (v_sla.dispatch_owner = 'AI' AND v_sla.dispatch_token = p_claim_token)
         OR (v_sla.dispatch_delivery_id = p_delivery_id)
      THEN
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
              ai_dispatch_fenced_until = NULL,
              ai_dispatch_token = NULL,
              updated_at = v_now
          WHERE id = v_sla.id;
        ELSE -- UNCERTAIN
          UPDATE public.response_sla_windows
          SET dispatch_state = 'UNCERTAIN',
              dispatch_fenced_until = NULL,
              ai_dispatch_fenced_until = NULL,
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
