-- Migration: 20260916000003_inbox_atomic_persistence.sql
-- Enforces ACID Database Transactions for Inbound & Outbound Inbox Persistence
-- Eliminates partial state, non-atomic multi-table writes, and error swallowing.

-- ==============================================================================
-- 1. RPC: public.record_inbound_interaction_atomic
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.record_inbound_interaction_atomic(
  p_company_id uuid,
  p_customer_id uuid,
  p_channel text,
  p_external_conversation_id text,
  p_external_ref text DEFAULT NULL,
  p_sanitized_content text DEFAULT NULL,
  p_raw_content text DEFAULT '',
  p_source_metadata jsonb DEFAULT '{}'::jsonb,
  p_sanitization_status text DEFAULT 'SUCCEEDED'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_channel text;
  v_sanitization_status text;
  v_conversation public.conversations%ROWTYPE;
  v_existing_interaction public.interactions%ROWTYPE;
  v_conversation_id uuid;
  v_customer_id uuid;
  v_interaction_id uuid;
  v_ext_conv_id text;
  v_now timestamptz := now();
BEGIN
  -- 1. Validate mandatory fields (Fail-Closed)
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc';
  END IF;
  IF p_channel IS NULL OR trim(p_channel) = '' THEN
    RAISE EXCEPTION 'p_channel là bắt buộc';
  END IF;

  v_channel := upper(trim(p_channel));
  v_sanitization_status := CASE
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) IN ('SUCCEEDED', 'PENDING', 'FAILED', 'NOT_REQUIRED')
      THEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED')))
    ELSE 'SUCCEEDED'
  END;

  -- 2. Durable Idempotency Check (L2 Database check)
  -- Tra cứu trong public.interactions theo (company_id, channel, external_ref)
  IF p_external_ref IS NOT NULL AND trim(p_external_ref) <> '' THEN
    SELECT *
    INTO v_existing_interaction
    FROM public.interactions
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND external_ref = trim(p_external_ref)
    LIMIT 1;

    IF FOUND THEN
      -- Đã tồn tại: Trả về ngay, tuyệt đối KHÔNG tăng unread_count, KHÔNG thay đổi conversations
      RETURN jsonb_build_object(
        'conversation_id', v_existing_interaction.conversation_id,
        'interaction_id', v_existing_interaction.id,
        'customer_id', v_existing_interaction.customer_id,
        'is_duplicate', true
      );
    END IF;
  END IF;

  -- 3. Khóa hoặc tạo mới public.conversations
  -- 3a. Tìm theo external_conversation_id trước nếu có
  IF p_external_conversation_id IS NOT NULL AND trim(p_external_conversation_id) <> '' THEN
    SELECT * INTO v_conversation
    FROM public.conversations
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND external_conversation_id = trim(p_external_conversation_id)
    FOR UPDATE;
  END IF;

  -- 3b. Nếu chưa tìm thấy và p_customer_id có giá trị, tìm theo customer_id
  IF v_conversation.id IS NULL AND p_customer_id IS NOT NULL THEN
    SELECT * INTO v_conversation
    FROM public.conversations
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND customer_id = p_customer_id
    FOR UPDATE;
  END IF;

  -- 3c. Nếu tìm thấy: Cập nhật unread_count, last_message_at, status = 'OPEN', updated_at
  IF v_conversation.id IS NOT NULL THEN
    UPDATE public.conversations
    SET unread_count = unread_count + 1,
        last_message_at = v_now,
        status = 'OPEN',
        updated_at = v_now
    WHERE id = v_conversation.id
      AND company_id = p_company_id
    RETURNING * INTO v_conversation;

    v_conversation_id := v_conversation.id;
    v_customer_id := v_conversation.customer_id;
  ELSE
    -- 3d. Nếu chưa tìm thấy: Tạo mới cuộc hội thoại
    IF p_customer_id IS NULL THEN
      RAISE EXCEPTION 'p_customer_id là bắt buộc khi khởi tạo cuộc hội thoại mới';
    END IF;

    v_customer_id := p_customer_id;
    v_ext_conv_id := coalesce(nullif(trim(p_external_conversation_id), ''), p_customer_id::text);

    INSERT INTO public.conversations (
      company_id,
      customer_id,
      channel,
      external_conversation_id,
      last_message_at,
      unread_count,
      status,
      created_at,
      updated_at
    ) VALUES (
      p_company_id,
      v_customer_id,
      v_channel,
      v_ext_conv_id,
      v_now,
      1,
      'OPEN',
      v_now,
      v_now
    )
    RETURNING * INTO v_conversation;

    v_conversation_id := v_conversation.id;
  END IF;

  -- 4. INSERT public.interactions
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
    external_ref,
    actor_type,
    created_at
  ) VALUES (
    v_interaction_id,
    p_company_id,
    v_customer_id,
    v_conversation_id,
    v_channel,
    'MESSAGE',
    'INBOUND',
    p_sanitized_content,
    v_sanitization_status,
    v_now,
    'v1',
    nullif(trim(p_external_ref), ''),
    'CUSTOMER',
    v_now
  );

  -- 5. INSERT private.interaction_raw_contents (Strict ACID Transaction - No Swallow)
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

  -- 6. Trả về kết quả
  RETURN jsonb_build_object(
    'conversation_id', v_conversation_id,
    'interaction_id', v_interaction_id,
    'customer_id', v_customer_id,
    'is_duplicate', false
  );
END;
$$;

COMMENT ON FUNCTION public.record_inbound_interaction_atomic(uuid, uuid, text, text, text, text, text, jsonb, text)
  IS 'ACID Atomic inbound message ingestion with durable idempotency and raw content persistence. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_inbound_interaction_atomic(uuid, uuid, text, text, text, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_inbound_interaction_atomic(uuid, uuid, text, text, text, text, text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_inbound_interaction_atomic(uuid, uuid, text, text, text, text, text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_inbound_interaction_atomic(uuid, uuid, text, text, text, text, text, jsonb, text) TO service_role;


-- ==============================================================================
-- 2. RPC: public.record_outbound_interaction_atomic
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.record_outbound_interaction_atomic(
  p_company_id uuid,
  p_conversation_id uuid,
  p_customer_id uuid DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_sanitized_content text DEFAULT NULL,
  p_raw_content text DEFAULT '',
  p_sanitization_status text DEFAULT 'SUCCEEDED',
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conversation public.conversations%ROWTYPE;
  v_customer_id uuid;
  v_channel text;
  v_interaction_id uuid;
  v_sanitization_status text;
  v_now timestamptz := now();
BEGIN
  -- 1. Validate mandatory fields
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc';
  END IF;
  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'p_conversation_id là bắt buộc';
  END IF;

  -- 2. Resource Authorization & Lock conversation
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
  v_channel := coalesce(nullif(upper(trim(p_channel)), ''), v_conversation.channel);
  v_sanitization_status := CASE
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) IN ('SUCCEEDED', 'PENDING', 'FAILED', 'NOT_REQUIRED')
      THEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED')))
    ELSE 'SUCCEEDED'
  END;

  -- 3. Cập nhật conversations: last_message_at = now(), updated_at = now()
  UPDATE public.conversations
  SET last_message_at = v_now,
      updated_at = v_now
  WHERE id = p_conversation_id
    AND company_id = p_company_id;

  -- 4. INSERT public.interactions với direction = 'OUTBOUND'
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
    v_now
  );

  -- 5. INSERT private.interaction_raw_contents (Strict ACID Transaction - No Swallow)
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

  -- 6. Trả về kết quả
  RETURN jsonb_build_object(
    'interaction_id', v_interaction_id,
    'conversation_id', p_conversation_id,
    'customer_id', v_customer_id,
    'channel', v_channel
  );
END;
$$;

COMMENT ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb)
  IS 'ACID Atomic outbound message reply with conversations update, interactions insert, and raw content persistence. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb) TO service_role;
