-- Migration: 20261001200001_zalo_uncertain_reconciliation_authority_and_care_unknown.sql
-- Description:
-- 1. Preserve Zalo claim_token across PROVIDER_UNCERTAIN to enable late authoritative reconciliation.
-- 2. Enforce non-null p_claim_token in zalo_record_outbound_provider_result (no NULL authorization credential).
-- 3. Narrow Zalo lease-expiry SLA window update to exact ownership predicate (prevent stale D1 poisoning active D2).
-- 4. Never downgrade Facebook UNKNOWN to FAILED in care_deliveries (map UNKNOWN -> UNCERTAIN with tenant binding).
-- 5. Preserve strict SECURITY DEFINER, search_path = '', and service_role ACLs across all redefined functions.

-- ============================================================================
-- 1. REDEFINE han_finish_send (Fix 3: Care deliveries UNKNOWN -> UNCERTAIN)
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
    -- SOLE transition mechanism; zero fallback to legacy resolver
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

  -- Care delivery updates: NEVER downgrade UNKNOWN to FAILED (Requirement 3)
  IF v_row.care_delivery_id IS NOT NULL THEN
    UPDATE public.care_deliveries
    SET
      status = CASE
        WHEN p_status = 'SENT' THEN 'SENT'
        WHEN p_status = 'FAILED' THEN 'FAILED'
        ELSE 'UNCERTAIN'
      END,
      sent_at = CASE
        WHEN p_status = 'SENT' THEN v_sent_at
        ELSE NULL
      END,
      external_message_ref = p_mid,
      updated_at = v_now
    WHERE id = v_row.care_delivery_id
      AND company_id = p_company;

    IF p_status = 'SENT' THEN
      UPDATE public.care_deliveries
      SET status = 'DELIVERED', delivered_at = v_sent_at
      WHERE id = v_row.care_delivery_id
        AND company_id = p_company
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
        AND company_id = p_company
        AND EXISTS (
          SELECT 1 FROM private.han_receipts r
          WHERE r.company_id = p_company
            AND r.external_identity =
                v_conversation.external_conversation_id
            AND p_mid = ANY(r.read_watermarks)
      );
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_finish_send(uuid, uuid, text, text) TO service_role;


-- ============================================================================
-- 2. REDEFINE zalo_claim_outbound_delivery
--    (Fix 1: Preserve claim_token on PROVIDER_UNCERTAIN;
--     Fix 2: Remove broad OR dispatch_owner = 'SALE' to prevent stale D1 poisoning active D2)
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
  v_conv public.conversations%ROWTYPE;
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_sla public.response_sla_windows%ROWTYPE;
  v_oa text;
  v_now timestamptz := clock_timestamp();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
  v_token uuid;
BEGIN
  IF p_company_id IS NULL OR p_conversation_id IS NULL OR p_command_id IS NULL
     OR p_actor_type IS NULL OR p_raw_content IS NULL OR p_sanitized_content IS NULL
     OR p_content_sha256 IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_INVALID_ARGUMENTS' USING ERRCODE = '22023';
  END IF;

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

  SELECT c.* INTO v_conv
  FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.company_id = p_company_id AND c.channel = 'ZALO'
  FOR UPDATE;

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
  -- (Requirement 1, 2 & 3: Token Stability, Crash Recovery & UNCERTAIN Reconciliation)
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

    -- Ambiguous / Uncertain: preserve claim_token for late authoritative reconciliation (Requirement 1)
    IF v_row.status IN ('PROVIDER_UNCERTAIN', 'UNCERTAIN') THEN
      RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, v_row.claim_token, v_row.oa_id, v_row.recipient_zalo_uid,
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
        -- PRESERVE claim_token for late authoritative reconciliation (Requirement 1)
        UPDATE public.zalo_outbound_deliveries
        SET status = 'PROVIDER_UNCERTAIN',
            error_code = 'LEASE_EXPIRED',
            error_message = 'Outbound delivery lease expired while in-flight',
            lease_until = NULL,
            updated_at = v_now
        WHERE id = v_row.id;

        IF p_actor_type = 'SALE' THEN
          -- EXACT OWNERSHIP PREDICATE: D1 must NEVER mutate window if window belongs to D2! (Requirement 2)
          UPDATE public.response_sla_windows
          SET dispatch_state = 'UNCERTAIN',
              dispatch_fenced_until = NULL,
              updated_at = v_now
          WHERE company_id = p_company_id
            AND conversation_id = p_conversation_id
            AND state = 'OPEN'
            AND dispatch_owner = 'SALE'
            AND dispatch_delivery_id = v_row.id
            AND dispatch_token = v_row.claim_token;
        END IF;

        RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, v_row.claim_token, v_row.oa_id, v_row.recipient_zalo_uid,
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
            -- AI lease expired: persist UNCERTAIN without transaction rollback
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
            -- Sale lease expired: persist UNCERTAIN without transaction rollback
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
-- 3. REDEFINE zalo_record_outbound_provider_result
--    (Fix 1: Preserve claim_token across PROVIDER_UNCERTAIN;
--            Enforce non-null p_claim_token;
--            Enable original claim holder to reconcile late ACCEPTED/REJECTED from PROVIDER_UNCERTAIN;
--            Preserve irreversible ACCEPTED semantics)
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
  -- 1. Validate outcome argument strictly
  IF p_outcome NOT IN ('ACCEPTED', 'REJECTED', 'UNCERTAIN') THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_OUTCOME_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 2. Require non-empty provider message ID on ACCEPTED
  IF p_outcome = 'ACCEPTED' AND coalesce(btrim(p_provider_msg_id), '') = '' THEN
    RAISE EXCEPTION 'ZALO_PROVIDER_MSG_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- 3. Require non-null p_claim_token: NULL cannot be a reconciliation credential (Requirement 1)
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'ZALO_CLAIM_TOKEN_MANDATORY' USING ERRCODE = '22023';
  END IF;

  SELECT d.* INTO v_row FROM public.zalo_outbound_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_CLAIM_TOKEN_MISMATCH' USING ERRCODE = '55000';
  END IF;

  -- 4. Source-state machine enforcement:
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

  -- C. Fresh outcome or late reconciliation recording allowed ONLY from SENDING or PROVIDER_UNCERTAIN
  IF v_row.status NOT IN ('SENDING', 'PROVIDER_UNCERTAIN') THEN
    RAISE EXCEPTION 'ZALO_INVALID_DELIVERY_STATE' USING ERRCODE = '55000';
  END IF;

  -- 5. Apply transition
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
        -- PRESERVE claim_token across PROVIDER_UNCERTAIN for late reconciliation (Requirement 1)
        lease_until = NULL,
        updated_at = v_now
    WHERE d.id = v_row.id;
  END IF;

  -- 6. Synchronize with response_sla_windows strictly matching delivery and tokens
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
