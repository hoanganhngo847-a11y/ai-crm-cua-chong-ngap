-- ==============================================================================
-- MIGRATION: 20260916000004_outbound_delivery_outbox.sql
-- Module: Omnichannel Inbox & Outbound Dispatcher (Member 2 Ownership Boundary)
--
-- Mục tiêu:
-- 1. Tạo bảng public.outbound_deliveries phục vụ Transactional Outbox Pattern cho Outbound Messaging.
-- 2. Cập nhật ACID Atomic RPC public.record_outbound_interaction_atomic:
--    - Cập nhật conversations (last_message_at = now(), updated_at = now()).
--    - INSERT public.interactions (direction = 'OUTBOUND').
--    - INSERT private.interaction_raw_contents.
--    - INSERT public.outbound_deliveries (delivery_status = 'PENDING_DISPATCH').
--    - Đảm bảo tính Transactional: Rollback toàn bộ nếu bất kỳ bước nào lỗi.
--    - Trả về (interaction_id, conversation_id, customer_id, channel, delivery_id, delivery_status).
-- 3. Tạo RPC public.claim_pending_outbound_deliveries hỗ trợ Outbox Worker (FOR UPDATE SKIP LOCKED).
-- ==============================================================================

-- 1. Bảng public.outbound_deliveries
CREATE TABLE IF NOT EXISTS public.outbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES public.interactions(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('FACEBOOK', 'ZALO', 'SYSTEM', 'HOTLINE', 'DIRECT')),
  delivery_status text NOT NULL DEFAULT 'PENDING_DISPATCH' CHECK (delivery_status IN ('PENDING_DISPATCH', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED')),
  provider_message_id text,
  retry_count integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index phục vụ Polling Worker & Queue Dispatching
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_pending 
  ON public.outbound_deliveries (company_id, delivery_status) 
  WHERE delivery_status = 'PENDING_DISPATCH';

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_interaction 
  ON public.outbound_deliveries (interaction_id);

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_conversation 
  ON public.outbound_deliveries (conversation_id);

-- RLS & Tenant Isolation
ALTER TABLE public.outbound_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_deliveries_tenant_isolation ON public.outbound_deliveries;
CREATE POLICY outbound_deliveries_tenant_isolation ON public.outbound_deliveries
  FOR ALL
  USING (company_id = (current_setting('app.current_company_id', true))::uuid);

GRANT ALL ON TABLE public.outbound_deliveries TO service_role;
GRANT SELECT ON TABLE public.outbound_deliveries TO authenticated;


-- 2. Cập nhật RPC public.record_outbound_interaction_atomic
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
  v_delivery_channel text;
  v_interaction_id uuid;
  v_delivery_id uuid;
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

  v_delivery_channel := CASE
    WHEN v_channel IN ('FACEBOOK', 'ZALO', 'SYSTEM', 'HOTLINE', 'DIRECT') THEN v_channel
    WHEN upper(trim(v_channel)) = 'FB' THEN 'FACEBOOK'
    WHEN upper(trim(v_channel)) = 'ZL' THEN 'ZALO'
    ELSE 'DIRECT'
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

  -- 6. INSERT public.outbound_deliveries (Transactional Outbox Pattern)
  v_delivery_id := gen_random_uuid();

  INSERT INTO public.outbound_deliveries (
    id,
    company_id,
    conversation_id,
    interaction_id,
    channel,
    delivery_status,
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
    0,
    v_now,
    v_now
  );

  -- 7. Trả về kết quả bền vững
  RETURN jsonb_build_object(
    'interaction_id', v_interaction_id,
    'conversation_id', p_conversation_id,
    'customer_id', v_customer_id,
    'channel', v_channel,
    'delivery_id', v_delivery_id,
    'delivery_status', 'PENDING_DISPATCH'
  );
END;
$$;

COMMENT ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb)
  IS 'ACID Atomic outbound message reply with conversations update, interactions insert, raw content persistence, and outbound outbox delivery. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb) TO service_role;


-- 3. RPC: public.claim_pending_outbound_deliveries
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
      updated_at = now()
  WHERE id IN (
    SELECT id
    FROM public.outbound_deliveries
    WHERE company_id = p_company_id
      AND delivery_status = 'PENDING_DISPATCH'
      AND (locked_at IS NULL OR locked_at < now() - INTERVAL '5 minutes')
    ORDER BY created_at ASC
    LIMIT coalesce(p_limit, 10)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer)
  IS 'Atomic batch lock and claim pending outbound deliveries for workers using FOR UPDATE SKIP LOCKED. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_outbound_deliveries(uuid, text, integer) TO service_role;
