-- ==============================================================================
-- MIGRATION: 20261012113001_facebook_browser_outbox_hardening.sql
-- Module: Phase 2B.1 Failure Recovery & Live Delivery Hardening
--
-- Mục tiêu:
-- 1. Bổ sung các trường phục vụ reconciliation cho job PROCESSING bị orphan khi worker crash:
--    - processing_started_at: timestamptz NULL
--    - lease_expires_at: timestamptz NULL
--    - reconciliation_status: text NOT NULL DEFAULT 'NONE' CHECK (reconciliation_status IN ('NONE', 'RECONCILE_REQUIRED', 'RECONCILED_SENT', 'RECONCILED_NOT_SENT'))
-- 2. Cập nhật ràng buộc CHECK của status & delivery_status để hỗ trợ RECONCILE_REQUIRED.
-- 3. Cập nhật claim_facebook_browser_outbox_jobs:
--    - Ghi nhận processing_started_at và lease_expires_at (mặc định lease 2 phút)
--    - Chỉ claim các job PENDING hoặc RETRY; không tự động nuốt job PROCESSING quá hạn vào luồng gửi lại thông thường.
-- 4. Bổ sung RPC claim_orphan_facebook_browser_jobs:
--    - Tìm các job PROCESSING quá hạn lease_expires_at để worker tiến hành đối soát thread Facebook.
-- 5. Bổ sung RPC resolve_reconciled_facebook_browser_job:
--    - Cập nhật kết quả sau khi đối soát (SENT, RETRY, hoặc giữ RECONCILE_REQUIRED).
-- ==============================================================================

-- 1. Bổ sung cột vào public.outbound_deliveries
ALTER TABLE public.outbound_deliveries
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'NONE';

-- Cập nhật ràng buộc CHECK cho status
ALTER TABLE public.outbound_deliveries
  DROP CONSTRAINT IF EXISTS outbound_deliveries_status_check;

ALTER TABLE public.outbound_deliveries
  ADD CONSTRAINT outbound_deliveries_status_check
  CHECK (status IS NULL OR status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRY', 'RECONCILE_REQUIRED'));

-- Cập nhật ràng buộc CHECK cho delivery_status
ALTER TABLE public.outbound_deliveries
  DROP CONSTRAINT IF EXISTS outbound_deliveries_delivery_status_check;

ALTER TABLE public.outbound_deliveries
  ADD CONSTRAINT outbound_deliveries_delivery_status_check
  CHECK (delivery_status IN ('PENDING_DISPATCH', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'PENDING', 'PROCESSING', 'RETRY', 'RECONCILE_REQUIRED'));

-- Ràng buộc CHECK cho reconciliation_status
ALTER TABLE public.outbound_deliveries
  DROP CONSTRAINT IF EXISTS outbound_deliveries_reconciliation_status_check;

ALTER TABLE public.outbound_deliveries
  ADD CONSTRAINT outbound_deliveries_reconciliation_status_check
  CHECK (reconciliation_status IN ('NONE', 'RECONCILE_REQUIRED', 'RECONCILED_SENT', 'RECONCILED_NOT_SENT'));

-- Index hỗ trợ tìm kiếm orphan PROCESSING jobs
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_fb_browser_orphan
  ON public.outbound_deliveries (channel, provider, status, lease_expires_at)
  WHERE channel = 'FACEBOOK' AND provider = 'facebook_browser' AND status = 'PROCESSING';


-- 2. Cập nhật claim_facebook_browser_outbox_jobs
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
      processing_started_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + interval '2 minutes',
      reconciliation_status = 'NONE',
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
      )
      AND (p_company_id IS NULL OR company_id = p_company_id)
    ORDER BY created_at ASC
    LIMIT coalesce(p_limit, 5)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;


-- 3. RPC: claim_orphan_facebook_browser_jobs (Tìm các job PROCESSING bị treo / crash để worker đối soát)
CREATE OR REPLACE FUNCTION public.claim_orphan_facebook_browser_jobs(
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
  SET reconciliation_status = 'RECONCILE_REQUIRED',
      locked_at = clock_timestamp(),
      locked_by = p_worker_id,
      lease_expires_at = clock_timestamp() + interval '3 minutes',
      updated_at = clock_timestamp()
  WHERE id IN (
    SELECT id
    FROM public.outbound_deliveries
    WHERE channel = 'FACEBOOK'
      AND provider = 'facebook_browser'
      AND status = 'PROCESSING'
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
      AND (p_company_id IS NULL OR company_id = p_company_id)
    ORDER BY created_at ASC
    LIMIT coalesce(p_limit, 5)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;


-- 4. RPC: resolve_reconciled_facebook_browser_job (Cập nhật kết quả đối soát)
CREATE OR REPLACE FUNCTION public.resolve_reconciled_facebook_browser_job(
  p_job_id uuid,
  p_resolution text, -- 'SENT', 'RETRY', 'RECONCILE_REQUIRED'
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery public.outbound_deliveries%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_delivery
  FROM public.outbound_deliveries
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_resolution = 'SENT' THEN
    UPDATE public.outbound_deliveries
    SET status = 'SENT',
        delivery_status = 'SENT',
        reconciliation_status = 'RECONCILED_SENT',
        sent_at = v_now,
        delivered_at = v_now,
        last_error = NULL,
        locked_by = NULL,
        locked_at = NULL,
        lease_expires_at = NULL,
        metadata = jsonb_set(
          metadata,
          '{provider_message_id}',
          to_jsonb(coalesce(p_provider_message_id, 'reconciled_confirmed_' || v_now::text))
        ),
        updated_at = v_now
    WHERE id = p_job_id;

    -- Đồng bộ interaction sang SENT nếu có
    IF v_delivery.interaction_id IS NOT NULL THEN
      UPDATE public.interactions
      SET updated_at = v_now
      WHERE id = v_delivery.interaction_id;
    END IF;

    RETURN true;

  ELSIF p_resolution = 'RETRY' THEN
    UPDATE public.outbound_deliveries
    SET status = 'RETRY',
        delivery_status = 'RETRY',
        reconciliation_status = 'RECONCILED_NOT_SENT',
        next_retry_at = v_now + interval '10 seconds',
        last_error = coalesce(p_error, 'RECONCILED_NOT_SENT: Worker crash trước khi gửi, xếp lịch gửi lại an toàn.'),
        locked_by = NULL,
        locked_at = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE id = p_job_id;

    RETURN true;

  ELSE -- 'RECONCILE_REQUIRED' (uncertain)
    UPDATE public.outbound_deliveries
    SET status = 'RECONCILE_REQUIRED',
        delivery_status = 'RECONCILE_REQUIRED',
        reconciliation_status = 'RECONCILE_REQUIRED',
        last_error = coalesce(p_error, 'RECONCILE_UNCERTAIN: Không đủ bằng chứng xác định trạng thái gửi. Cần kiểm tra thủ công.'),
        locked_by = NULL,
        locked_at = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE id = p_job_id;

    RETURN true;
  END IF;
END;
$$;
