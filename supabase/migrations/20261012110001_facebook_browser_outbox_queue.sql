-- ==============================================================================
-- MIGRATION: 20261012110001_facebook_browser_outbox_queue.sql
-- Module: Phase 2B Facebook Browser Outbox Queue & Worker Dispatcher
--
-- Mục tiêu:
-- 1. Mở rộng bảng public.outbound_deliveries hiện có để phục vụ hàng đợi gửi tin trình duyệt (Phase 2B):
--    - provider: text NULL (ví dụ: 'facebook_browser')
--    - content: text NULL (nội dung câu trả lời của Sale)
--    - status: text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRY'))
--    - attempt_count: integer NOT NULL DEFAULT 0
--    - next_retry_at: timestamptz NULL
--    - last_error: text NULL
--    - sent_at: timestamptz NULL
--    - idempotency_key: text NULL
--    - metadata: jsonb NOT NULL DEFAULT '{}'::jsonb
-- 2. Đảm bảo ràng buộc CHECK của delivery_status mở rộng tương thích ngược.
-- 3. Cập nhật record_outbound_interaction_atomic:
--    - Khi hội thoại thuộc provider 'facebook_browser', lưu đầy đủ thông tin vào outbox queue.
-- 4. Bổ sung các RPC atomic:
--    - claim_facebook_browser_outbox_jobs (FOR UPDATE SKIP LOCKED)
--    - complete_facebook_browser_outbox_job
--    - fail_facebook_browser_outbox_job
--    - retry_facebook_browser_outbox_job_manual
-- ==============================================================================

-- 1. Bổ sung các cột vào public.outbound_deliveries
ALTER TABLE public.outbound_deliveries
  ADD COLUMN IF NOT EXISTS provider text NULL,
  ADD COLUMN IF NOT EXISTS content text NULL,
  ADD COLUMN IF NOT EXISTS status text NULL,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_error text NULL,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill status cho dữ liệu cũ (nếu có)
UPDATE public.outbound_deliveries
SET status = CASE
  WHEN delivery_status IN ('SENT', 'DELIVERED') THEN 'SENT'
  WHEN delivery_status = 'FAILED' THEN 'FAILED'
  WHEN delivery_status = 'QUEUED' THEN 'PROCESSING'
  ELSE 'PENDING'
END
WHERE status IS NULL;

ALTER TABLE public.outbound_deliveries
  ALTER COLUMN status SET DEFAULT 'PENDING';

-- Mở rộng ràng buộc CHECK delivery_status
ALTER TABLE public.outbound_deliveries
  DROP CONSTRAINT IF EXISTS outbound_deliveries_delivery_status_check;

ALTER TABLE public.outbound_deliveries
  ADD CONSTRAINT outbound_deliveries_delivery_status_check
  CHECK (delivery_status IN ('PENDING_DISPATCH', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'PENDING', 'PROCESSING', 'RETRY'));

-- Ràng buộc CHECK cho status
ALTER TABLE public.outbound_deliveries
  DROP CONSTRAINT IF EXISTS outbound_deliveries_status_check;

ALTER TABLE public.outbound_deliveries
  ADD CONSTRAINT outbound_deliveries_status_check
  CHECK (status IS NULL OR status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRY'));

-- Index cho worker polling
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_fb_browser_queue
  ON public.outbound_deliveries (channel, provider, status, next_retry_at)
  WHERE channel = 'FACEBOOK' AND provider = 'facebook_browser';

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_idempotency_key
  ON public.outbound_deliveries (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;


-- 2. Cập nhật record_outbound_interaction_atomic để đưa thông tin provider & content vào outbox
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
      'customer_name', v_conversation.customer_name
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


-- 3. Atomic RPC: claim_facebook_browser_outbox_jobs (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_facebook_browser_outbox_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 5,
  p_company_id uuid DEFAULT NULL
)
RETURNS SETOF public.outbound_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.outbound_deliveries
  SET status = 'PROCESSING',
      delivery_status = 'QUEUED',
      locked_at = clock_timestamp(),
      locked_by = p_worker_id,
      attempt_count = public.outbound_deliveries.attempt_count + 1,
      updated_at = clock_timestamp()
  WHERE id IN (
    SELECT id
    FROM public.outbound_deliveries
    WHERE channel = 'FACEBOOK'
      AND provider = 'facebook_browser'
      AND (
        status = 'PENDING'
        OR (status = 'RETRY' AND (next_retry_at IS NULL OR next_retry_at <= clock_timestamp()))
        OR (status = 'PROCESSING' AND locked_at < clock_timestamp() - INTERVAL '3 minutes')
      )
      AND (p_company_id IS NULL OR company_id = p_company_id)
    ORDER BY created_at ASC
    LIMIT coalesce(p_limit, 5)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_facebook_browser_outbox_jobs(text, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_facebook_browser_outbox_jobs(text, integer, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_facebook_browser_outbox_jobs(text, integer, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_facebook_browser_outbox_jobs(text, integer, uuid) TO service_role;


-- 4. Atomic RPC: complete_facebook_browser_outbox_job
CREATE OR REPLACE FUNCTION public.complete_facebook_browser_outbox_job(
  p_job_id uuid,
  p_provider_message_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  UPDATE public.outbound_deliveries
  SET status = 'SENT',
      delivery_status = 'SENT',
      sent_at = v_now,
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      last_error = NULL,
      error_message = NULL,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = v_now
  WHERE id = p_job_id;

  RETURN jsonb_build_object('success', true, 'job_id', p_job_id, 'status', 'SENT');
END;
$$;

REVOKE ALL ON FUNCTION public.complete_facebook_browser_outbox_job(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_facebook_browser_outbox_job(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.complete_facebook_browser_outbox_job(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_facebook_browser_outbox_job(uuid, text) TO service_role;


-- 5. Atomic RPC: fail_facebook_browser_outbox_job
CREATE OR REPLACE FUNCTION public.fail_facebook_browser_outbox_job(
  p_job_id uuid,
  p_error_message text,
  p_is_transient boolean DEFAULT true,
  p_max_retries integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.outbound_deliveries%ROWTYPE;
  v_new_status text;
  v_next_retry timestamptz := NULL;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_row FROM public.outbound_deliveries WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'JOB_NOT_FOUND');
  END IF;

  IF p_is_transient AND v_row.attempt_count < p_max_retries THEN
    v_new_status := 'RETRY';
    -- Exponential backoff: 2^attempt * 10s (10s, 20s, 40s...)
    v_next_retry := v_now + (power(2, v_row.attempt_count) * INTERVAL '10 seconds');
  ELSE
    v_new_status := 'FAILED';
  END IF;

  UPDATE public.outbound_deliveries
  SET status = v_new_status,
      delivery_status = CASE WHEN v_new_status = 'FAILED' THEN 'FAILED' ELSE 'PENDING_DISPATCH' END,
      next_retry_at = v_next_retry,
      last_error = p_error_message,
      error_message = p_error_message,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = v_now
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'job_id', p_job_id,
    'status', v_new_status,
    'attempt_count', v_row.attempt_count,
    'next_retry_at', v_next_retry
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fail_facebook_browser_outbox_job(uuid, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_facebook_browser_outbox_job(uuid, text, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION public.fail_facebook_browser_outbox_job(uuid, text, boolean, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fail_facebook_browser_outbox_job(uuid, text, boolean, integer) TO service_role;


-- 6. Atomic RPC: retry_facebook_browser_outbox_job_manual
CREATE OR REPLACE FUNCTION public.retry_facebook_browser_outbox_job_manual(
  p_job_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.outbound_deliveries
  SET status = 'RETRY',
      delivery_status = 'PENDING_DISPATCH',
      next_retry_at = clock_timestamp(),
      attempt_count = 0,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_job_id
    AND status = 'FAILED';

  RETURN jsonb_build_object('success', true, 'job_id', p_job_id, 'status', 'RETRY');
END;
$$;

REVOKE ALL ON FUNCTION public.retry_facebook_browser_outbox_job_manual(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retry_facebook_browser_outbox_job_manual(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.retry_facebook_browser_outbox_job_manual(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.retry_facebook_browser_outbox_job_manual(uuid) TO service_role;
