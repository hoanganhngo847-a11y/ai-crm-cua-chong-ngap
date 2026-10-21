-- ==============================================================================
-- MIGRATION: 20261020220001_fix_outbound_customer_metadata.sql
-- Module: Outbox & Outbound Deliveries Metadata Fix
--
-- Objective:
-- Fix public.record_outbound_interaction_atomic referencing non-existent
-- column v_conversation.customer_name.
-- Canonical customer name is retrieved from public.customers scoped by
-- company_id and effective customer_id, safely handling nulls and rejecting
-- any untrusted metadata.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.record_outbound_interaction_atomic(
  p_company_id uuid,
  p_conversation_id uuid,
  p_customer_id uuid DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_sanitized_content text DEFAULT NULL,
  p_raw_content text DEFAULT '',
  p_sanitization_status text DEFAULT 'SUCCEEDED',
  p_source_metadata jsonb DEFAULT '{}'::jsonb,
  p_client_command_id uuid DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conversation public.conversations%ROWTYPE;
  v_customer_id uuid;
  v_customer_name text := NULL;
  v_channel text;
  v_interaction_id uuid;
  v_delivery_id uuid;
  v_delivery_status text;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_sanitization_status text;
  v_provider text;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Validate mandatory fields
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_COMPANY_ID';
  END IF;
  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'p_conversation_id là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_CONVERSATION_ID';
  END IF;

  -- 2. Authenticated Actor Attribution Validation
  IF p_actor_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.company_members cm
      JOIN public.user_profiles up ON up.id = cm.user_id
      JOIN public.companies c ON c.id = cm.company_id
      WHERE cm.company_id = p_company_id
        AND cm.user_id = p_actor_user_id
        AND cm.status = 'ACTIVE'
        AND up.status = 'ACTIVE'
        AND c.status = 'ACTIVE'
        AND cm.role IN ('SALE', 'BOSS_ADMIN', 'ADMIN', 'BOSS')
    ) THEN
      RAISE EXCEPTION 'ACTOR_NOT_AUTHORIZED: Người dùng không có quyền gửi tin nhắn hoặc không thuộc tổ chức này.'
        USING ERRCODE = '42501', HINT = 'ACTOR_NOT_AUTHORIZED';
    END IF;
  END IF;

  -- 3. Lock conversation
  SELECT * INTO v_conversation
  FROM public.conversations
  WHERE id = p_conversation_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND: Cuộc hội thoại không tồn tại hoặc không thuộc quyền quản lý của tổ chức.'
      USING ERRCODE = 'P0002', HINT = 'CONVERSATION_NOT_FOUND';
  END IF;

  v_customer_id := coalesce(p_customer_id, v_conversation.customer_id);

  -- Resolve canonical customer name from public.customers scoped by company_id
  IF v_customer_id IS NOT NULL THEN
    SELECT c.name INTO v_customer_name
    FROM public.customers c
    WHERE c.id = v_customer_id
      AND c.company_id = p_company_id;
  END IF;

  v_channel := coalesce(nullif(upper(trim(p_channel)), ''), v_conversation.channel);
  v_channel := CASE
    WHEN v_channel IN ('FACEBOOK', 'ZALO', 'SYSTEM', 'HOTLINE', 'DIRECT') THEN v_channel
    WHEN upper(trim(v_channel)) = 'FB' THEN 'FACEBOOK'
    WHEN upper(trim(v_channel)) = 'ZL' THEN 'ZALO'
    ELSE 'DIRECT'
  END;

  v_sanitization_status := CASE
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) IN ('CLEAN', 'SANITIZED', 'SUCCEEDED') THEN 'SUCCEEDED'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'PENDING' THEN 'PENDING'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'FAILED' THEN 'FAILED'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'NOT_REQUIRED' THEN 'NOT_REQUIRED'
    ELSE 'SUCCEEDED'
  END;

  v_fingerprint := encode(
    sha256(
      convert_to(
        p_company_id::text || ':' ||
        p_conversation_id::text || ':' ||
        coalesce(v_customer_id::text, '') || ':' ||
        v_channel || ':' ||
        trim(coalesce(p_sanitized_content, '')),
        'UTF8'
      )
    ),
    'hex'
  );

  -- 4. Idempotency Check
  IF p_client_command_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_company_id::text || ':outbound_cmd:' || p_client_command_id::text, 0)
    );

    SELECT o.interaction_id, o.id, o.delivery_status, o.request_fingerprint
    INTO v_interaction_id, v_delivery_id, v_delivery_status, v_existing_fingerprint
    FROM public.outbound_deliveries o
    WHERE o.company_id = p_company_id
      AND o.client_command_id = p_client_command_id;

    IF FOUND THEN
      IF v_existing_fingerprint IS NOT NULL AND v_existing_fingerprint <> v_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: Lệnh gửi đã được sử dụng với nội dung khác.'
          USING ERRCODE = 'P0001', HINT = 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';
      END IF;

      RETURN jsonb_build_object(
        'interaction_id', v_interaction_id,
        'conversation_id', p_conversation_id,
        'customer_id', v_customer_id,
        'channel', v_channel,
        'delivery_id', v_delivery_id,
        'delivery_status', coalesce(v_delivery_status, 'PENDING_DISPATCH'),
        'is_duplicate', true
      );
    END IF;
  END IF;

  -- 5. Extract provider from conversation metadata
  v_provider := coalesce(v_conversation.metadata->>'provider', 'default');

  v_interaction_id := gen_random_uuid();

  -- Chèn outbound_deliveries
  INSERT INTO public.outbound_deliveries (
    company_id,
    conversation_id,
    interaction_id,
    channel,
    provider,
    content,
    delivery_status,
    status,
    client_command_id,
    idempotency_key,
    request_fingerprint,
    metadata
  ) VALUES (
    p_company_id,
    p_conversation_id,
    v_interaction_id,
    v_channel,
    v_provider,
    coalesce(p_raw_content, p_sanitized_content, ''),
    'PENDING_DISPATCH',
    'PENDING',
    p_client_command_id,
    coalesce(p_client_command_id::text, gen_random_uuid()::text),
    v_fingerprint,
    jsonb_build_object(
      'page_id', v_conversation.metadata->>'page_id',
      'page_name', v_conversation.metadata->>'page_name',
      'customer_fb_id', v_conversation.metadata->>'customer_fb_id',
      'external_conversation_id', v_conversation.metadata->>'external_conversation_id',
      'customer_name', v_customer_name
    )
  )
  RETURNING id INTO v_delivery_id;

  -- 6. Ghi nhận interaction
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
    created_at
  ) VALUES (
    v_interaction_id,
    p_company_id,
    v_customer_id,
    p_conversation_id,
    v_channel,
    'MESSAGE',
    'OUTBOUND',
    p_sanitized_content,
    v_sanitization_status,
    v_now,
    'v1',
    'SALE',
    p_actor_user_id,
    v_now
  );

  -- 7. Ghi nhận raw content
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
    coalesce(p_source_metadata, '{}'::jsonb),
    coalesce(p_source_metadata, '{}'::jsonb),
    v_now
  );

  -- 8. Cập nhật conversations
  UPDATE public.conversations
  SET last_message_at = v_now,
      updated_at = v_now
  WHERE id = p_conversation_id
    AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'interaction_id', v_interaction_id,
    'conversation_id', p_conversation_id,
    'customer_id', v_customer_id,
    'channel', v_channel,
    'delivery_id', v_delivery_id,
    'delivery_status', 'PENDING_DISPATCH',
    'status', 'PENDING',
    'is_duplicate', false
  );
END;
$$;

COMMENT ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid)
  IS 'ACID Atomic outbound message reply with canonical customer name resolution, actor attribution, conversation update, interactions insert, raw content persistence, client_command_id idempotency, and payload verification. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid) TO service_role;
