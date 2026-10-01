-- Migration: 20261001140001_ai_outbound_delivery_atomic.sql
-- Description: Canonical outbound delivery support for AI runtime (actor_type = AI)
-- 1. Drop NOT NULL constraint on outbound_deliveries.interaction_id to allow pending dispatch before delivery confirmation
-- 2. create_ai_outbound_delivery_pending: Creates pending delivery record
-- 3. record_ai_outbound_delivery_failed: Records failed provider outcome without creating interaction row
-- 4. finalize_ai_outbound_delivery_atomic: Creates public interaction (actor_type=AI), private provenance, links delivery, and resolves SLA

-- 1. Allow pending dispatch in outbound_deliveries before interaction row is minted
ALTER TABLE public.outbound_deliveries ALTER COLUMN interaction_id DROP NOT NULL;

-- 2. RPC: create_ai_outbound_delivery_pending
CREATE OR REPLACE FUNCTION public.create_ai_outbound_delivery_pending(
  p_company_id uuid,
  p_conversation_id uuid,
  p_channel text,
  p_client_command_id uuid,
  p_request_fingerprint text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery_id uuid;
  v_existing_id uuid;
  v_existing_status text;
  v_conversation_company uuid;
BEGIN
  -- Validate mandatory fields
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc' USING ERRCODE = '22023';
  END IF;
  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'p_conversation_id là bắt buộc' USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('FACEBOOK', 'ZALO', 'SYSTEM', 'HOTLINE', 'DIRECT') THEN
    RAISE EXCEPTION 'p_channel không hợp lệ' USING ERRCODE = '22023';
  END IF;

  -- Validate conversation exists and belongs to company
  SELECT company_id INTO v_conversation_company
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_conversation_company <> p_company_id THEN
    RAISE EXCEPTION 'CONVERSATION_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- Check existing command id for idempotency
  IF p_client_command_id IS NOT NULL THEN
    SELECT id, delivery_status INTO v_existing_id, v_existing_status
    FROM public.outbound_deliveries
    WHERE company_id = p_company_id
      AND client_command_id = p_client_command_id;

    IF FOUND THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  v_delivery_id := gen_random_uuid();

  INSERT INTO public.outbound_deliveries (
    id,
    company_id,
    conversation_id,
    interaction_id,
    channel,
    delivery_status,
    client_command_id,
    request_fingerprint,
    created_at,
    updated_at
  ) VALUES (
    v_delivery_id,
    p_company_id,
    p_conversation_id,
    NULL,
    p_channel,
    'PENDING_DISPATCH',
    p_client_command_id,
    p_request_fingerprint,
    clock_timestamp(),
    clock_timestamp()
  );

  RETURN v_delivery_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_ai_outbound_delivery_pending(uuid, uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_ai_outbound_delivery_pending(uuid, uuid, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_ai_outbound_delivery_pending(uuid, uuid, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_ai_outbound_delivery_pending(uuid, uuid, text, uuid, text) TO service_role;

-- 3. RPC: record_ai_outbound_delivery_failed
CREATE OR REPLACE FUNCTION public.record_ai_outbound_delivery_failed(
  p_company_id uuid,
  p_delivery_id uuid,
  p_error_message text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.outbound_deliveries
  SET
    delivery_status = 'FAILED',
    error_message = p_error_message,
    updated_at = clock_timestamp()
  WHERE id = p_delivery_id
    AND company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_outbound_delivery_failed(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_ai_outbound_delivery_failed(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_ai_outbound_delivery_failed(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_outbound_delivery_failed(uuid, uuid, text) TO service_role;

-- 4. RPC: finalize_ai_outbound_delivery_atomic
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
  v_interaction_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Validate mandatory fields
  IF p_company_id IS NULL OR p_delivery_id IS NULL OR p_conversation_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'Thông tin bắt buộc bị thiếu' USING ERRCODE = '22023';
  END IF;

  IF p_provider_msg_id IS NULL OR length(trim(p_provider_msg_id)) = 0 THEN
    RAISE EXCEPTION 'CANNOT_FINALIZE_WITHOUT_PROVIDER_MESSAGE_ID' USING ERRCODE = '22023';
  END IF;

  -- 2. Lock and validate outbound delivery
  SELECT * INTO v_delivery
  FROM public.outbound_deliveries
  WHERE id = p_delivery_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_delivery.conversation_id <> p_conversation_id THEN
    RAISE EXCEPTION 'DELIVERY_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  -- If already SENT, return existing interaction_id (idempotent replay)
  IF v_delivery.delivery_status = 'SENT' AND v_delivery.interaction_id IS NOT NULL THEN
    RETURN v_delivery.interaction_id;
  END IF;

  -- 3. Mint public interaction with actor_type = 'AI'
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

  -- 4. Mandatory Provenance in private.interaction_raw_contents (Fail-Closed)
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

  -- 5. Update outbound_deliveries with SENT status and interaction link
  UPDATE public.outbound_deliveries
  SET
    delivery_status = 'SENT',
    provider_message_id = p_provider_msg_id,
    interaction_id = v_interaction_id,
    updated_at = v_now
  WHERE id = p_delivery_id;

  -- 6. Atomically resolve Response SLA window to AI_RESPONDED
  IF p_window_id IS NOT NULL THEN
    UPDATE public.response_sla_windows
    SET
      state = 'AI_RESPONDED',
      ai_response_interaction_id = v_interaction_id,
      resolved_at = v_now,
      updated_at = v_now
    WHERE id = p_window_id
      AND company_id = p_company_id
      AND state = 'OPEN';
  END IF;

  -- 7. Reset conversation status to OPEN and update last_message_at
  UPDATE public.conversations
  SET
    status = 'OPEN',
    last_message_at = v_now,
    updated_at = v_now
  WHERE id = p_conversation_id
    AND company_id = p_company_id;

  -- 8. Audit log
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

-- 5. RPC: get_due_response_sla_windows
CREATE OR REPLACE FUNCTION public.get_due_response_sla_windows(
  p_company_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  conversation_id uuid,
  customer_id uuid,
  deadline_at timestamptz,
  ai_claim_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.id,
    w.company_id,
    w.conversation_id,
    w.customer_id,
    w.deadline_at,
    w.ai_claim_expires_at
  FROM public.response_sla_windows w
  WHERE w.state = 'OPEN'
    AND w.deadline_at <= clock_timestamp()
    AND (w.ai_claim_expires_at IS NULL OR w.ai_claim_expires_at <= clock_timestamp())
    AND (p_company_id IS NULL OR w.company_id = p_company_id)
  ORDER BY w.deadline_at ASC
  LIMIT coalesce(p_limit, 20);
END;
$$;

REVOKE ALL ON FUNCTION public.get_due_response_sla_windows(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_due_response_sla_windows(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_due_response_sla_windows(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_due_response_sla_windows(uuid, integer) TO service_role;

