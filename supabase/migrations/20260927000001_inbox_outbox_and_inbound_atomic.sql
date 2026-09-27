-- ==============================================================================
-- MIGRATION: 20260927000001_inbox_outbox_and_inbound_atomic.sql
-- Module: Omnichannel Inbox & Outbound Dispatcher (Member 2 Ownership Boundary)
--
-- Mục tiêu:
-- 1. Tạo bảng public.outbound_deliveries phục vụ Transactional Outbox Pattern cho Outbound Messaging:
--    - Bổ sung client_command_id (uuid NULL).
--    - Ràng buộc UNIQUE chống trùng lệnh gửi: CONSTRAINT uq_outbound_deliveries_command UNIQUE (company_id, client_command_id).
--    - Khóa bảo mật RLS: Bật RLS, REVOKE toàn bộ từ authenticated và anon, chỉ GRANT ALL cho service_role.
-- 2. Cập nhật ACID Atomic RPC public.record_outbound_interaction_atomic:
--    - Thêm tham số: p_client_command_id uuid DEFAULT NULL.
--    - Idempotency check: Nếu p_client_command_id IS NOT NULL và đã tồn tại -> trả về ngay thông tin hiện có kèm is_duplicate = true.
--    - Nếu chưa tồn tại -> thực hiện trong 1 transaction:
--      + Khóa conversations (FOR UPDATE).
--      + Cập nhật conversations (last_message_at = now(), updated_at = now()).
--      + INSERT public.interactions (direction = 'OUTBOUND').
--      + INSERT private.interaction_raw_contents.
--      + INSERT public.outbound_deliveries (lưu client_command_id, delivery_status = 'PENDING_DISPATCH').
--      + Trả về kết quả bền vững kèm is_duplicate = false.
-- 3. Cập nhật RPC public.claim_pending_outbound_deliveries:
--    - Quét các bản ghi PENDING_DISPATCH (locked_at IS NULL HOẶC locked_at < now() - 5 phút)
--      HOẶC các bản ghi QUEUED bị crash (locked_at < now() - 5 phút).
--    - Khóa batch bằng FOR UPDATE SKIP LOCKED.
--    - Khi claim: cập nhật delivery_status = 'QUEUED', locked_at = now(), locked_by = p_worker_id, retry_count = retry_count + 1.
-- ==============================================================================

-- 1. Bảng public.outbound_deliveries
CREATE TABLE IF NOT EXISTS public.outbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES public.interactions(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('FACEBOOK', 'ZALO', 'SYSTEM', 'HOTLINE', 'DIRECT')),
  delivery_status text NOT NULL DEFAULT 'PENDING_DISPATCH' CHECK (delivery_status IN ('PENDING_DISPATCH', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED')),
  client_command_id uuid NULL,
  provider_message_id text,
  retry_count integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_outbound_deliveries_command UNIQUE (company_id, client_command_id)
);

-- Index phục vụ Polling Worker & Queue Dispatching
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_pending
  ON public.outbound_deliveries (company_id, delivery_status, created_at)
  WHERE delivery_status IN ('PENDING_DISPATCH', 'QUEUED');

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_interaction
  ON public.outbound_deliveries (interaction_id);

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_conversation
  ON public.outbound_deliveries (conversation_id);

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_command
  ON public.outbound_deliveries (company_id, client_command_id)
  WHERE client_command_id IS NOT NULL;

-- Khóa bảo mật RLS: Bật RLS, REVOKE toàn bộ quyền từ authenticated và anon, chỉ GRANT ALL cho service_role
ALTER TABLE public.outbound_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.outbound_deliveries FROM PUBLIC;
REVOKE ALL ON TABLE public.outbound_deliveries FROM anon;
REVOKE ALL ON TABLE public.outbound_deliveries FROM authenticated;
GRANT ALL ON TABLE public.outbound_deliveries TO service_role;


-- 2. Cập nhật RPC public.record_outbound_interaction_atomic
DROP FUNCTION IF EXISTS public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.record_outbound_interaction_atomic(
  p_company_id uuid,
  p_conversation_id uuid,
  p_customer_id uuid DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_sanitized_content text DEFAULT NULL,
  p_raw_content text DEFAULT '',
  p_sanitization_status text DEFAULT 'SUCCEEDED',
  p_source_metadata jsonb DEFAULT '{}'::jsonb,
  p_client_command_id uuid DEFAULT NULL
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
  v_delivery_channel text;
  v_interaction_id uuid;
  v_delivery_id uuid;
  v_sanitization_status text;
  v_now timestamptz := now();
  v_existing_delivery record;
BEGIN
  -- 1. Validate mandatory fields
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc';
  END IF;
  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'p_conversation_id là bắt buộc';
  END IF;

  -- 2. Idempotency check via client_command_id:
  -- Nếu p_client_command_id IS NOT NULL và đã tồn tại -> trả về ngay thông tin hiện có kèm is_duplicate = true
  IF p_client_command_id IS NOT NULL THEN
    SELECT
      od.id AS delivery_id,
      od.interaction_id,
      od.conversation_id,
      od.channel,
      od.delivery_status,
      i.customer_id
    INTO v_existing_delivery
    FROM public.outbound_deliveries od
    JOIN public.interactions i ON i.id = od.interaction_id
    WHERE od.company_id = p_company_id
      AND od.client_command_id = p_client_command_id
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'interaction_id', v_existing_delivery.interaction_id,
        'conversation_id', v_existing_delivery.conversation_id,
        'customer_id', v_existing_delivery.customer_id,
        'channel', v_existing_delivery.channel,
        'delivery_id', v_existing_delivery.delivery_id,
        'delivery_status', v_existing_delivery.delivery_status,
        'is_duplicate', true
      );
    END IF;
  END IF;

  -- 3. Resource Authorization & Lock conversation (FOR UPDATE)
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

  v_delivery_channel := CASE
    WHEN v_channel IN ('FACEBOOK', 'ZALO', 'SYSTEM', 'HOTLINE', 'DIRECT') THEN v_channel
    WHEN upper(trim(v_channel)) = 'FB' THEN 'FACEBOOK'
    WHEN upper(trim(v_channel)) = 'ZL' THEN 'ZALO'
    ELSE 'DIRECT'
  END;

  -- 4. Cập nhật conversations: last_message_at = now(), updated_at = now()
  UPDATE public.conversations
  SET last_message_at = v_now,
      updated_at = v_now
  WHERE id = p_conversation_id
    AND company_id = p_company_id;

  -- 5. INSERT public.interactions với direction = 'OUTBOUND'
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

  -- 6. INSERT private.interaction_raw_contents (Strict ACID Transaction - No Swallow)
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

  -- 7. INSERT public.outbound_deliveries (Transactional Outbox Pattern với client_command_id)
  v_delivery_id := gen_random_uuid();

  INSERT INTO public.outbound_deliveries (
    id,
    company_id,
    conversation_id,
    interaction_id,
    channel,
    delivery_status,
    client_command_id,
    retry_count,
    created_at,
    updated_at
  ) VALUES (
    v_delivery_id,
    p_company_id,
    p_conversation_id,
    v_interaction_id,
    v_delivery_channel,
    'PENDING_DISPATCH',
    p_client_command_id,
    0,
    v_now,
    v_now
  );

  -- 8. Trả về kết quả bền vững với is_duplicate = false
  RETURN jsonb_build_object(
    'interaction_id', v_interaction_id,
    'conversation_id', p_conversation_id,
    'customer_id', v_customer_id,
    'channel', v_channel,
    'delivery_id', v_delivery_id,
    'delivery_status', 'PENDING_DISPATCH',
    'is_duplicate', false
  );
END;
$$;

COMMENT ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid)
  IS 'ACID Atomic outbound message reply with conversations update, interactions insert, raw content persistence, client_command_id idempotency, and outbound outbox delivery. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid) TO service_role;


-- 3. RPC: public.claim_pending_outbound_deliveries
DROP FUNCTION IF EXISTS public.claim_pending_outbound_deliveries(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.claim_pending_outbound_deliveries(
  p_company_id uuid,
  p_worker_id text,
  p_limit integer DEFAULT 10
)
RETURNS SETOF public.outbound_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc';
  END IF;

  RETURN QUERY
  UPDATE public.outbound_deliveries
  SET delivery_status = 'QUEUED',
      locked_at = now(),
      locked_by = p_worker_id,
      retry_count = public.outbound_deliveries.retry_count + 1,
      updated_at = now()
  WHERE id IN (
    SELECT id
    FROM public.outbound_deliveries
    WHERE company_id = p_company_id
      AND (
        (delivery_status = 'PENDING_DISPATCH' AND (locked_at IS NULL OR locked_at < now() - INTERVAL '5 minutes'))
        OR
        (delivery_status = 'QUEUED' AND locked_at < now() - INTERVAL '5 minutes')
      )
    ORDER BY created_at ASC
    LIMIT coalesce(p_limit, 10)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer)
  IS 'Atomic batch lock and claim pending/crashed outbound deliveries for workers using FOR UPDATE SKIP LOCKED. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer) TO service_role;
