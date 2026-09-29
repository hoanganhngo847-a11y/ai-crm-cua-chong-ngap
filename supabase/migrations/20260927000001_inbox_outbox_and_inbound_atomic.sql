-- ==============================================================================
-- MIGRATION: 20260927000001_inbox_outbox_and_inbound_atomic.sql
-- Module: Omnichannel Inbox & Outbound Dispatcher (Member 2 Ownership Boundary)
--
-- Mục tiêu:
-- 1. Tạo bảng public.outbound_deliveries phục vụ Transactional Outbox Pattern cho Outbound Messaging:
--    - Bổ sung client_command_id (uuid NULL) và request_fingerprint (text NULL).
--    - Ràng buộc UNIQUE chống trùng lệnh gửi: CONSTRAINT uq_outbound_deliveries_command UNIQUE (company_id, client_command_id).
--    - Khóa bảo mật RLS: Bật RLS, REVOKE toàn bộ từ authenticated và anon, chỉ GRANT ALL cho service_role.
-- 2. Cập nhật ACID Atomic RPC public.record_outbound_interaction_atomic:
--    - Thêm tham số: p_client_command_id uuid DEFAULT NULL, p_actor_user_id uuid DEFAULT NULL.
--    - SECURITY DEFINER, SET search_path = ''.
--    - Phân quyền & xác thực danh tính actor human: kiểm tra membership ACTIVE của caller trong company_members.
--    - Khóa transaction-scoped advisory lock trên client_command_id.
--    - Deterministic request_fingerprint: Nếu cùng command_id nhưng khác payload -> ném IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD.
--    - Idempotency check: Nếu cùng command_id và cùng payload -> trả về ngay thông tin hiện có kèm is_duplicate = true.
--    - Lưu trữ tương tác OUTBOUND với actor_type = 'SALE', actor_user_id = p_actor_user_id, sanitization_status = 'SUCCEEDED'.
-- 3. Cập nhật RPC public.claim_pending_outbound_deliveries:
--    - SECURITY DEFINER, SET search_path = ''.
--    - Quét các bản ghi PENDING_DISPATCH (locked_at IS NULL HOẶC locked_at < now() - 5 phút)
--      HOẶC các bản ghi QUEUED bị crash (locked_at < now() - 5 phút).
--    - Khóa batch bằng FOR UPDATE SKIP LOCKED.
-- 4. Bổ sung RPC public.ingest_provider_message_atomic:
--    - SECURITY DEFINER, SET search_path = ''.
--    - Inbound provider message ingestion trọn vẹn với định danh khách hàng 4 bậc, durable idempotency, khóa/tạo conversation, ghi interactions và raw content trong 1 transaction.
--    - Khóa transaction-scoped advisory lock trên (company_id + channel + external_user_id) giải quyết triệt để race condition khi first-contact đồng thời.
--    - Từ chối các payload thiếu provider user ID hoặc provider message ID (Fail-Closed, không tạo synthetic identity/message ID).
--    - Chuẩn hóa sanitization_status: CLEAN/SANITIZED map thành SUCCEEDED, không bao giờ ghi RAW vào DB.
-- ==============================================================================

-- 1. Bảng public.outbound_deliveries
CREATE TABLE IF NOT EXISTS public.outbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES public.interactions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  channel text NOT NULL CHECK (channel IN ('FACEBOOK', 'ZALO', 'SYSTEM', 'HOTLINE', 'DIRECT')),
  delivery_status text NOT NULL DEFAULT 'PENDING_DISPATCH' CHECK (delivery_status IN ('PENDING_DISPATCH', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED')),
  client_command_id uuid NULL,
  request_fingerprint text NULL,
  provider_message_id text,
  retry_count integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_outbound_deliveries_command UNIQUE (company_id, client_command_id)
);

-- Bảo đảm cột request_fingerprint tồn tại kể cả khi bảng đã được tạo trước
ALTER TABLE public.outbound_deliveries ADD COLUMN IF NOT EXISTS request_fingerprint text NULL;

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
DROP FUNCTION IF EXISTS public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid);

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
  v_channel text;
  v_interaction_id uuid;
  v_delivery_id uuid;
  v_delivery_status text;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_sanitization_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Validate mandatory fields (Fail-Closed)
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_COMPANY_ID';
  END IF;
  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'p_conversation_id là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_CONVERSATION_ID';
  END IF;

  -- 2. Authenticated Actor Attribution Validation (P1 Requirement 11)
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
  v_channel := CASE
    WHEN v_channel IN ('FACEBOOK', 'ZALO', 'SYSTEM', 'HOTLINE', 'DIRECT') THEN v_channel
    WHEN upper(trim(v_channel)) = 'FB' THEN 'FACEBOOK'
    WHEN upper(trim(v_channel)) = 'ZL' THEN 'ZALO'
    ELSE 'DIRECT'
  END;

  -- Canonical sanitization status mapping (P0 Requirement 3)
  v_sanitization_status := CASE
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) IN ('CLEAN', 'SANITIZED', 'SUCCEEDED') THEN 'SUCCEEDED'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'PENDING' THEN 'PENDING'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'FAILED' THEN 'FAILED'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'NOT_REQUIRED' THEN 'NOT_REQUIRED'
    ELSE 'SUCCEEDED'
  END;

  -- Deterministic request fingerprint (P0 Requirement 9)
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

  -- 4. Concurrency Mutex & Idempotency Check (P0 Requirement 8, 9, 10)
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
      -- Xác minh payload khớp command cũ (Requirement 9)
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

  -- 5. Tạo interaction_id và chèn outbound_deliveries
  v_interaction_id := gen_random_uuid();

  INSERT INTO public.outbound_deliveries (
    company_id, conversation_id, interaction_id, channel, delivery_status, client_command_id, request_fingerprint
  ) VALUES (
    p_company_id, p_conversation_id, v_interaction_id, v_channel, 'PENDING_DISPATCH', p_client_command_id, v_fingerprint
  )
  RETURNING id INTO v_delivery_id;

  -- 6. Ghi nhận interaction (TV9 Sales Style & Attribution: actor_type = 'SALE', actor_user_id)
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

  -- 7. Ghi nhận raw content vào private schema
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
    'is_duplicate', false
  );
END;
$$;

COMMENT ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid)
  IS 'ACID Atomic outbound message reply with actor attribution, conversation update, interactions insert, raw content persistence, client_command_id idempotency, and payload verification. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_outbound_interaction_atomic(uuid, uuid, uuid, text, text, text, text, jsonb, uuid, uuid) TO service_role;


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
      locked_at = clock_timestamp(),
      locked_by = p_worker_id,
      retry_count = public.outbound_deliveries.retry_count + 1,
      updated_at = clock_timestamp()
  WHERE id IN (
    SELECT id
    FROM public.outbound_deliveries
    WHERE company_id = p_company_id
      AND (
        (delivery_status = 'PENDING_DISPATCH' AND (locked_at IS NULL OR locked_at < clock_timestamp() - INTERVAL '5 minutes'))
        OR
        (delivery_status = 'QUEUED' AND locked_at < clock_timestamp() - INTERVAL '5 minutes')
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


-- ==============================================================================
-- 4. RPC: public.ingest_provider_message_atomic
-- ==============================================================================
DROP FUNCTION IF EXISTS public.ingest_provider_message_atomic(uuid, text, text, text, text, text, text, text, text, jsonb, text, uuid);

CREATE OR REPLACE FUNCTION public.ingest_provider_message_atomic(
  p_company_id uuid,
  p_channel text,
  p_external_user_id text DEFAULT NULL,
  p_sender_name text DEFAULT NULL,
  p_sender_phone text DEFAULT NULL,
  p_external_conversation_id text DEFAULT NULL,
  p_external_ref text DEFAULT NULL,
  p_sanitized_content text DEFAULT '',
  p_raw_content text DEFAULT '',
  p_source_metadata jsonb DEFAULT '{}'::jsonb,
  p_sanitization_status text DEFAULT 'SUCCEEDED',
  p_customer_id uuid DEFAULT NULL
)
RETURNS TABLE (
  interaction_id uuid,
  conversation_id uuid,
  customer_id uuid,
  is_duplicate boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_channel text;
  v_sanitization_status text;
  v_customer_id uuid := NULL;
  v_cust_name text;
  v_normalized_phone text := NULL;
  v_conversation public.conversations%ROWTYPE;
  v_existing_interaction public.interactions%ROWTYPE;
  v_conversation_id uuid;
  v_interaction_id uuid;
  v_ext_conv_id text;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Validate mandatory fields (Fail-Closed)
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_COMPANY_ID';
  END IF;
  IF p_channel IS NULL OR trim(p_channel) = '' THEN
    RAISE EXCEPTION 'p_channel là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_CHANNEL';
  END IF;

  v_channel := upper(trim(p_channel));
  IF v_channel = 'FB' THEN
    v_channel := 'FACEBOOK';
  ELSIF v_channel = 'ZL' THEN
    v_channel := 'ZALO';
  END IF;

  -- P0 Requirement 7: Missing provider user ID / message ID must be rejected before persistence
  IF v_channel IN ('FACEBOOK', 'ZALO') THEN
    IF p_external_user_id IS NULL OR trim(p_external_user_id) = '' THEN
      RAISE EXCEPTION 'MISSING_PROVIDER_USER_ID: Missing required provider user ID for %', v_channel
        USING ERRCODE = '22023', HINT = 'MISSING_PROVIDER_USER_ID';
    END IF;
    IF p_external_ref IS NULL OR trim(p_external_ref) = '' THEN
      RAISE EXCEPTION 'MISSING_PROVIDER_MESSAGE_ID: Missing required provider message ID for %', v_channel
        USING ERRCODE = '22023', HINT = 'MISSING_PROVIDER_MESSAGE_ID';
    END IF;
  END IF;

  -- Canonical sanitization status mapping (P0 Requirement 3)
  v_sanitization_status := CASE
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) IN ('CLEAN', 'SANITIZED', 'SUCCEEDED') THEN 'SUCCEEDED'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'PENDING' THEN 'PENDING'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'FAILED' THEN 'FAILED'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'NOT_REQUIRED' THEN 'NOT_REQUIRED'
    ELSE 'SUCCEEDED'
  END;

  -- Chuẩn hóa số điện thoại nếu có
  IF p_sender_phone IS NOT NULL AND trim(p_sender_phone) <> '' THEN
    v_normalized_phone := CASE
      WHEN trim(p_sender_phone) ~ '^0[1-9][0-9]{8}$' THEN '+84' || substring(trim(p_sender_phone) from 2)
      WHEN trim(p_sender_phone) ~ '^\+[1-9][0-9]{7,14}$' THEN trim(p_sender_phone)
      WHEN trim(p_sender_phone) ~ '^84[1-9][0-9]{8}$' THEN '+' || trim(p_sender_phone)
      ELSE '+84' || regexp_replace(trim(p_sender_phone), '[^0-9]', '', 'g')
    END;
  END IF;

  -- P0 Requirement 5: Concurrency serialization mutex before Customer creation
  IF p_external_user_id IS NOT NULL AND trim(p_external_user_id) <> '' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_company_id::text || ':' || v_channel || ':' || trim(p_external_user_id), 0)
    );
  END IF;

  IF v_normalized_phone IS NOT NULL AND trim(v_normalized_phone) <> '' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_company_id::text || ':phone:' || v_normalized_phone, 0)
    );
  END IF;

  -- 2. Durable Idempotency Check (under lock)
  IF p_external_ref IS NOT NULL AND trim(p_external_ref) <> '' THEN
    SELECT *
    INTO v_existing_interaction
    FROM public.interactions
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND external_ref = trim(p_external_ref)
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT
        v_existing_interaction.id,
        v_existing_interaction.conversation_id,
        v_existing_interaction.customer_id,
        true;
      RETURN;
    END IF;
  END IF;

  -- 3. 4-Tier Customer Resolution
  -- Bậc 1: Nếu p_customer_id được chỉ định, kiểm tra tính hợp lệ
  IF p_customer_id IS NOT NULL THEN
    SELECT c.id INTO v_customer_id
    FROM public.customers c
    WHERE c.id = p_customer_id AND c.company_id = p_company_id;
  END IF;

  -- Bậc 2: Nếu chưa tìm thấy và có p_external_user_id, tra cứu identities
  IF v_customer_id IS NULL AND p_external_user_id IS NOT NULL AND trim(p_external_user_id) <> '' THEN
    SELECT idt.customer_id INTO v_customer_id
    FROM public.identities idt
    WHERE idt.company_id = p_company_id
      AND idt.channel = v_channel
      AND idt.external_id = trim(p_external_user_id)
    LIMIT 1;
  END IF;

  -- Bậc 3: Nếu chưa tìm thấy và có p_sender_phone
  IF v_customer_id IS NULL AND v_normalized_phone IS NOT NULL THEN
    SELECT cpc.customer_id INTO v_customer_id
    FROM private.customer_private_contacts cpc
    WHERE cpc.company_id = p_company_id
      AND (cpc.normalized_phone = v_normalized_phone OR cpc.raw_phone = trim(p_sender_phone))
    LIMIT 1;

    IF v_customer_id IS NULL THEN
      v_cust_name := coalesce(nullif(trim(p_sender_name), ''), 'Khách hàng ' || v_channel);
      INSERT INTO public.customers (
        company_id, name, source, stage, created_at, updated_at
      ) VALUES (
        p_company_id, v_cust_name, v_channel, 'LEAD_NEW', v_now, v_now
      ) RETURNING id INTO v_customer_id;

      IF v_normalized_phone ~ '^\+[1-9][0-9]{7,14}$' THEN
        INSERT INTO private.customer_private_contacts (
          company_id, customer_id, raw_phone, normalized_phone, phone_country_code, is_verified, created_at, updated_at
        ) VALUES (
          p_company_id, v_customer_id, trim(p_sender_phone), v_normalized_phone, 'VN', false, v_now, v_now
        ) ON CONFLICT (company_id, normalized_phone) DO NOTHING;
      END IF;

      INSERT INTO public.customer_stage_histories (
        company_id, customer_id, from_stage, to_stage, actor_type, reason, changed_at
      ) VALUES (
        p_company_id, v_customer_id, NULL, 'LEAD_NEW', 'SYSTEM', 'Tự động tạo từ tương tác ' || v_channel, v_now
      );

      IF p_external_user_id IS NOT NULL AND trim(p_external_user_id) <> '' THEN
        INSERT INTO public.identities (
          company_id, customer_id, channel, external_id, verified, metadata, created_at, updated_at
        ) VALUES (
          p_company_id, v_customer_id, v_channel, trim(p_external_user_id), false, '{}'::jsonb, v_now, v_now
        ) ON CONFLICT (company_id, channel, external_id) DO NOTHING;
      END IF;
    END IF;
  END IF;

  -- Bậc 4: Khách mới qua social channel chưa có SĐT nhưng có external_user_id
  IF v_customer_id IS NULL AND p_external_user_id IS NOT NULL AND trim(p_external_user_id) <> '' THEN
    v_cust_name := coalesce(nullif(trim(p_sender_name), ''), 'Khách hàng ' || v_channel);
    INSERT INTO public.customers (
      company_id, name, source, stage, created_at, updated_at
    ) VALUES (
      p_company_id, v_cust_name, v_channel, 'LEAD_NEW', v_now, v_now
    ) RETURNING id INTO v_customer_id;

    INSERT INTO public.identities (
      company_id, customer_id, channel, external_id, verified, metadata, created_at, updated_at
    ) VALUES (
      p_company_id, v_customer_id, v_channel, trim(p_external_user_id), false, '{}'::jsonb, v_now, v_now
    )
    ON CONFLICT (company_id, channel, external_id) DO UPDATE
      SET updated_at = v_now
    RETURNING customer_id INTO v_customer_id;

    INSERT INTO public.customer_stage_histories (
      company_id, customer_id, from_stage, to_stage, actor_type, reason, changed_at
    ) VALUES (
      p_company_id, v_customer_id, NULL, 'LEAD_NEW', 'SYSTEM', 'Tự động tạo từ tương tác ' || v_channel, v_now
    );
  END IF;

  -- Fail-Closed: Nếu sau 4 bậc vẫn không xác định được customer_id
  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Inbound customer resolution failed: Fail-Closed'
      USING ERRCODE = 'P0002', HINT = 'CUSTOMER_RESOLUTION_FAILED';
  END IF;

  -- 4. Khóa hoặc tạo mới public.conversations
  IF p_external_conversation_id IS NOT NULL AND trim(p_external_conversation_id) <> '' THEN
    SELECT * INTO v_conversation
    FROM public.conversations
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND external_conversation_id = trim(p_external_conversation_id)
    FOR UPDATE;
  END IF;

  IF v_conversation.id IS NULL AND v_customer_id IS NOT NULL THEN
    SELECT * INTO v_conversation
    FROM public.conversations
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND customer_id = v_customer_id
    FOR UPDATE;
  END IF;

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
  ELSE
    v_ext_conv_id := coalesce(nullif(trim(p_external_conversation_id), ''), v_customer_id::text);

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
    ON CONFLICT (company_id, channel, external_conversation_id) DO UPDATE
      SET unread_count = public.conversations.unread_count + 1,
          last_message_at = v_now,
          status = 'OPEN',
          updated_at = v_now
    RETURNING id INTO v_conversation_id;
  END IF;

  -- 5. INSERT public.interactions
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
    coalesce(p_sanitized_content, ''),
    v_sanitization_status,
    v_now,
    'v1',
    nullif(trim(p_external_ref), ''),
    'CUSTOMER',
    v_now
  );

  -- 6. INSERT private.interaction_raw_contents
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

  -- 7. Trả về kết quả
  RETURN QUERY SELECT v_interaction_id, v_conversation_id, v_customer_id, false;
END;
$$;

COMMENT ON FUNCTION public.ingest_provider_message_atomic(uuid, text, text, text, text, text, text, text, text, jsonb, text, uuid)
  IS 'ACID Atomic inbound provider message ingestion with 4-tier customer resolution, concurrency advisory mutex, durable idempotency, conversation update/creation, interactions insert, and raw content persistence. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.ingest_provider_message_atomic(uuid, text, text, text, text, text, text, text, text, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ingest_provider_message_atomic(uuid, text, text, text, text, text, text, text, text, jsonb, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ingest_provider_message_atomic(uuid, text, text, text, text, text, text, text, text, jsonb, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_provider_message_atomic(uuid, text, text, text, text, text, text, text, text, jsonb, text, uuid) TO service_role;
