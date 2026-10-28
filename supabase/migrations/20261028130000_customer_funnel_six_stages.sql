-- Migration: 20261028130000_customer_funnel_six_stages.sql
-- Chuẩn hóa phễu khách hàng thành 6 giai đoạn, bảo toàn dữ liệu và lịch sử cũ.
--
-- Nguyên tắc:
-- 1. Không xóa khách hàng, tin nhắn, transcript, ghi chú hoặc lịch sử.
-- 2. Chỉ tự động ánh xạ các giá trị legacy có ý nghĩa nghiệp vụ rõ ràng.
-- 3. Giá trị legacy chưa chắc chắn được giữ nguyên và đánh dấu "cần rà soát".
-- 4. Mỗi khách hàng được migration đổi giai đoạn đều có một dòng SYSTEM history.
-- 5. Mọi RPC mới đều kiểm tra company_id và chỉ cấp quyền cho service_role.

BEGIN;

-- =============================================================================
-- 1. Hàm chuẩn hóa canonical dùng chung cho SQL, index và RPC
-- =============================================================================
CREATE OR REPLACE FUNCTION public.canonical_customer_stage(p_stage text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE pg_catalog.upper(pg_catalog.btrim(coalesce(p_stage, '')))
    -- Canonical six stages
    WHEN 'AWARENESS' THEN 'awareness'
    WHEN 'INTERESTED' THEN 'interested'
    WHEN 'DEEP_RESEARCH' THEN 'deep_research'
    WHEN 'LOW_POTENTIAL' THEN 'low_potential'
    WHEN 'HIGH_POTENTIAL' THEN 'high_potential'
    WHEN 'CONTRACT_SIGNED' THEN 'contract_signed'

    -- Legacy study-abroad stages
    WHEN 'LEAD_NEW' THEN 'awareness'
    WHEN 'CONTACT_CYCLE_1' THEN 'awareness'
    WHEN 'CONTACT_CYCLE_2' THEN 'awareness'
    WHEN 'CONTACT_CYCLE_3' THEN 'awareness'
    WHEN 'UNREACHABLE' THEN 'awareness'
    WHEN 'ZALO_FRIENDED' THEN 'awareness'
    WHEN 'IN_CARE' THEN 'interested'
    WHEN 'POTENTIAL_CLOSING' THEN 'high_potential'
    WHEN 'NOT_POTENTIAL' THEN 'low_potential'
    WHEN 'NO_DEMAND' THEN 'low_potential'
    WHEN 'CARE_NURTURING' THEN 'contract_signed'

    -- Legacy door/flood-barrier stages
    WHEN 'SURVEY_REQUESTED' THEN 'interested'
    WHEN 'SURVEY_SCHEDULED' THEN 'interested'
    WHEN 'SURVEY_COMPLETED' THEN 'interested'
    WHEN 'PRICE_CALCULATED' THEN 'high_potential'
    WHEN 'NEED_INFO' THEN 'interested'
    WHEN 'PRICE_OFFERED' THEN 'high_potential'
    WHEN 'NEGOTIATING' THEN 'high_potential'
    WHEN 'ORDER_CREATED' THEN 'high_potential'
    WHEN 'DEPOSIT_CONFIRMED' THEN 'high_potential'
    WHEN 'IN_PRODUCTION' THEN 'contract_signed'
    WHEN 'READY_FOR_INSTALL' THEN 'contract_signed'
    WHEN 'INSTALLING' THEN 'contract_signed'
    WHEN 'HANDOVER_COMPLETED' THEN 'contract_signed'
    WHEN 'WARRANTY_ACTIVE' THEN 'contract_signed'
    WHEN 'LOST' THEN 'low_potential'

    -- Vietnamese business aliases (defensive compatibility)
    WHEN 'KHACH_MOI' THEN 'awareness'
    WHEN 'LIEN_HE_LAN_1' THEN 'awareness'
    WHEN 'LIEN_HE_LAN_2' THEN 'awareness'
    WHEN 'LIEN_HE_LAN_3' THEN 'awareness'
    WHEN 'KHONG_NGHE_MAY' THEN 'awareness'
    WHEN 'DA_KET_BAN_ZALO' THEN 'awareness'
    WHEN 'DANG_CHAM_SOC' THEN 'interested'
    WHEN 'CO_TIEM_NANG' THEN 'high_potential'
    WHEN 'CHUA_TIEM_NANG' THEN 'low_potential'
    WHEN 'KHONG_NHU_CAU' THEN 'low_potential'
    WHEN 'DA_KY_HOP_DONG' THEN 'contract_signed'
    WHEN 'DA_KI_HOP_DONG' THEN 'contract_signed'
    WHEN 'CHAM_SOC_SAU_BAN' THEN 'contract_signed'
    WHEN 'DA_CO_GIA' THEN 'high_potential'
    WHEN 'DANG_THUONG_LUONG' THEN 'high_potential'

    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.canonical_customer_stage(text)
  IS 'Chuẩn hóa giá trị stage legacy/canonical về 6 mã canonical. Trả NULL nếu không nhận diện được.';

-- =============================================================================
-- 2. Mở rộng CHECK constraint: 6 canonical + toàn bộ legacy hiện có
-- =============================================================================
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_stage_check;

ALTER TABLE public.customers ADD CONSTRAINT customers_stage_check CHECK (stage IN (
  -- 6 canonical stages
  'awareness',
  'interested',
  'deep_research',
  'low_potential',
  'high_potential',
  'contract_signed',

  -- Legacy study-abroad stages (preserved for compatibility)
  'LEAD_NEW',
  'CONTACT_CYCLE_1',
  'CONTACT_CYCLE_2',
  'CONTACT_CYCLE_3',
  'UNREACHABLE',
  'ZALO_FRIENDED',
  'IN_CARE',
  'POTENTIAL_CLOSING',
  'NOT_POTENTIAL',
  'NO_DEMAND',
  'CONTRACT_SIGNED',
  'CARE_NURTURING',

  -- Legacy door/flood-barrier stages (preserved for compatibility)
  'SURVEY_REQUESTED',
  'SURVEY_SCHEDULED',
  'SURVEY_COMPLETED',
  'PRICE_CALCULATED',
  'NEED_INFO',
  'PRICE_OFFERED',
  'NEGOTIATING',
  'ORDER_CREATED',
  'DEPOSIT_CONFIRMED',
  'IN_PRODUCTION',
  'READY_FOR_INSTALL',
  'INSTALLING',
  'HANDOVER_COMPLETED',
  'WARRANTY_ACTIVE',
  'LOST'
));

CREATE INDEX IF NOT EXISTS idx_customers_company_canonical_stage
  ON public.customers (company_id, public.canonical_customer_stage(stage));

-- =============================================================================
-- 3. Bổ sung metadata lịch sử (không thay đổi dữ liệu cũ)
-- =============================================================================
ALTER TABLE public.customer_stage_histories
  ADD COLUMN IF NOT EXISTS evidence text NULL,
  ADD COLUMN IF NOT EXISTS confidence numeric(3,2) NULL
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_status IN ('UNVERIFIED', 'AI_SUGGESTED', 'VERIFIED', 'REJECTED'));

COMMENT ON COLUMN public.customer_stage_histories.verification_status
  IS 'UNVERIFIED: chưa xác minh; AI_SUGGESTED: do AI đề xuất; VERIFIED: con người xác nhận; REJECTED: bị từ chối.';

-- =============================================================================
-- 4. Bổ sung metadata cho AI analysis (append-only, không sửa bản ghi cũ)
-- =============================================================================
ALTER TABLE public.ai_analyses
  ADD COLUMN IF NOT EXISTS current_stage text NULL,
  ADD COLUMN IF NOT EXISTS reason text NULL,
  ADD COLUMN IF NOT EXISTS requires_verification boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS evidence_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'NOT_REQUIRED')),
  ADD COLUMN IF NOT EXISTS verified_by uuid NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS verification_note text NULL,
  ADD COLUMN IF NOT EXISTS dedupe_key text NULL,
  ADD COLUMN IF NOT EXISTS classifier_version text NULL,
  ADD COLUMN IF NOT EXISTS previous_analysis_id uuid NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_analyses_dedupe
  ON public.ai_analyses (company_id, customer_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

COMMENT ON COLUMN public.ai_analyses.verification_status
  IS 'PENDING: chờ nhân viên xác minh; ACCEPTED/REJECTED: kết quả xác minh; NOT_REQUIRED: không cần xác minh.';
COMMENT ON COLUMN public.ai_analyses.dedupe_key
  IS 'SHA-256 của model + classifier + source refs + current stage. Dùng để chống ghi trùng khi xử lý lại cùng hội thoại.';

-- =============================================================================
-- 5. Bảng audit migration: đếm trước/sau và danh sách cần rà soát
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.customer_stage_migration_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_key text NOT NULL,
  company_id uuid NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  legacy_stage text NOT NULL,
  canonical_stage text NULL,
  customer_count integer NOT NULL CHECK (customer_count >= 0),
  action text NOT NULL CHECK (action IN ('MAPPED', 'LEFT_FOR_REVIEW', 'TOTAL_BEFORE', 'TOTAL_AFTER')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_stage_migration_audit_key
  ON public.customer_stage_migration_audit (migration_key, action);

-- Ghi nhận tổng số khách hàng trước migration
INSERT INTO public.customer_stage_migration_audit (
  migration_key, company_id, legacy_stage, canonical_stage, customer_count, action
)
SELECT
  '20261028130000_customer_funnel_six_stages',
  c.company_id,
  '*',
  NULL,
  count(*)::integer,
  'TOTAL_BEFORE'
FROM public.customers c
GROUP BY c.company_id;

-- Ghi nhận phân bố legacy trước migration
INSERT INTO public.customer_stage_migration_audit (
  migration_key, company_id, legacy_stage, canonical_stage, customer_count, action
)
SELECT
  '20261028130000_customer_funnel_six_stages',
  c.company_id,
  c.stage,
  public.canonical_customer_stage(c.stage),
  count(*)::integer,
  CASE
    WHEN c.stage IN (
      'LEAD_NEW', 'CONTACT_CYCLE_1', 'CONTACT_CYCLE_2', 'CONTACT_CYCLE_3',
      'UNREACHABLE', 'ZALO_FRIENDED', 'IN_CARE', 'POTENTIAL_CLOSING',
      'NEGOTIATING', 'ORDER_CREATED', 'DEPOSIT_CONFIRMED', 'NOT_POTENTIAL',
      'NO_DEMAND', 'LOST', 'CONTRACT_SIGNED'
    ) THEN 'MAPPED'
    ELSE 'LEFT_FOR_REVIEW'
  END
FROM public.customers c
GROUP BY c.company_id, c.stage;

-- =============================================================================
-- 6. Ánh xạ có kiểm soát + ghi SYSTEM history cho từng khách hàng bị đổi
-- =============================================================================
WITH targets AS (
  SELECT
    c.id,
    c.company_id,
    c.stage AS old_stage,
    public.canonical_customer_stage(c.stage) AS new_stage
  FROM public.customers c
  WHERE c.stage IN (
    'LEAD_NEW', 'CONTACT_CYCLE_1', 'CONTACT_CYCLE_2', 'CONTACT_CYCLE_3',
    'UNREACHABLE', 'ZALO_FRIENDED', 'IN_CARE', 'POTENTIAL_CLOSING',
    'NEGOTIATING', 'ORDER_CREATED', 'DEPOSIT_CONFIRMED', 'NOT_POTENTIAL',
    'NO_DEMAND', 'LOST', 'CONTRACT_SIGNED'
  )
),
updated AS (
  UPDATE public.customers c
  SET stage = t.new_stage,
      updated_at = now()
  FROM targets t
  WHERE c.id = t.id
    AND c.company_id = t.company_id
  RETURNING c.id, c.company_id, t.old_stage, t.new_stage
)
INSERT INTO public.customer_stage_histories (
  company_id,
  customer_id,
  from_stage,
  to_stage,
  actor_type,
  changed_by_user_id,
  reason,
  source_ref,
  evidence,
  confidence,
  verification_status,
  changed_at
)
SELECT
  u.company_id,
  u.id,
  u.old_stage,
  u.new_stage,
  'SYSTEM',
  NULL,
  'Migration 20261028130000: chuẩn hóa giai đoạn cũ [' || u.old_stage || '] sang [' || u.new_stage || ']',
  'MIGRATION_20261028130000',
  'Ánh xạ tự động có kiểm soát theo bảng migration.',
  1.00,
  'VERIFIED',
  now()
FROM updated u;

-- Ghi nhận tổng số khách hàng sau migration và số còn cần rà soát
INSERT INTO public.customer_stage_migration_audit (
  migration_key, company_id, legacy_stage, canonical_stage, customer_count, action
)
SELECT
  '20261028130000_customer_funnel_six_stages',
  c.company_id,
  '*',
  NULL,
  count(*)::integer,
  'TOTAL_AFTER'
FROM public.customers c
GROUP BY c.company_id;

-- =============================================================================
-- 7. RPC: đếm khách hàng theo 6 giai đoạn (Kanban + Funnel dùng chung)
-- =============================================================================
DROP FUNCTION IF EXISTS public.get_customer_stage_counts(uuid, timestamptz, timestamptz, text, text);

CREATE OR REPLACE FUNCTION public.get_customer_stage_counts(
  p_company_id uuid,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS TABLE (
  stage text,
  customer_count bigint,
  needs_review_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'COMPANY_ID_REQUIRED' USING ERRCODE = '22000';
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT
      c.id,
      c.stage,
      public.canonical_customer_stage(c.stage) AS canonical_stage
    FROM public.customers c
    WHERE c.company_id = p_company_id
      AND (p_from IS NULL OR c.created_at >= p_from)
      AND (p_to IS NULL OR c.created_at <= p_to)
      AND (p_source IS NULL OR c.source = p_source)
      AND (
        p_search IS NULL
        OR pg_catalog.btrim(p_search) = ''
        OR c.name ILIKE '%' || p_search || '%'
        OR c.customer_code ILIKE '%' || p_search || '%'
      )
  ),
  stage_order(stage_name, ord) AS (
    VALUES
      ('awareness', 1),
      ('interested', 2),
      ('deep_research', 3),
      ('low_potential', 4),
      ('high_potential', 5),
      ('contract_signed', 6)
  )
  SELECT
    so.stage_name,
    (SELECT count(*) FROM eligible e WHERE e.canonical_stage = so.stage_name),
    (SELECT count(*) FROM eligible e
      WHERE e.canonical_stage = so.stage_name
        AND e.stage <> e.canonical_stage)
  FROM stage_order so
  ORDER BY so.ord;

  -- Trả thêm dòng 'unmapped' nếu có dữ liệu không nhận diện được.
  IF EXISTS (SELECT 1 FROM public.customers c
             WHERE c.company_id = p_company_id
               AND public.canonical_customer_stage(c.stage) IS NULL) THEN
    RETURN QUERY
    SELECT
      'unmapped'::text,
      count(*)::bigint,
      count(*)::bigint
    FROM public.customers c
    WHERE c.company_id = p_company_id
      AND public.canonical_customer_stage(c.stage) IS NULL
      AND (p_from IS NULL OR c.created_at >= p_from)
      AND (p_to IS NULL OR c.created_at <= p_to)
      AND (p_source IS NULL OR c.source = p_source)
      AND (
        p_search IS NULL
        OR pg_catalog.btrim(p_search) = ''
        OR c.name ILIKE '%' || p_search || '%'
        OR c.customer_code ILIKE '%' || p_search || '%'
      );
  END IF;
END;
$$;

COMMENT ON FUNCTION public.get_customer_stage_counts(uuid, timestamptz, timestamptz, text, text)
  IS 'Đếm khách hàng theo 6 giai đoạn canonical, có đếm riêng dữ liệu legacy cần rà soát.';

REVOKE ALL ON FUNCTION public.get_customer_stage_counts(uuid, timestamptz, timestamptz, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_stage_counts(uuid, timestamptz, timestamptz, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_stage_counts(uuid, timestamptz, timestamptz, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_stage_counts(uuid, timestamptz, timestamptz, text, text) TO service_role;

-- =============================================================================
-- 8. RPC: cập nhật giai đoạn có optimistic concurrency + metadata
-- =============================================================================
DROP FUNCTION IF EXISTS public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text);

CREATE OR REPLACE FUNCTION public.update_customer_stage_atomic(
  p_company_id uuid,
  p_customer_id uuid,
  p_new_stage text,
  p_note text DEFAULT NULL,
  p_changed_by uuid DEFAULT NULL,
  p_actor_type text DEFAULT 'USER',
  p_source_ref text DEFAULT NULL,
  p_expected_stage text DEFAULT NULL,
  p_evidence text DEFAULT NULL,
  p_confidence numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer public.customers%ROWTYPE;
  v_history public.customer_stage_histories%ROWTYPE;
  v_reason text;
  v_now timestamptz := now();
  v_old_stage text;
  v_old_canonical text;
  v_new_canonical text;
  v_expected_canonical text;
  v_actor_type text;
  v_verification_status text;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc' USING ERRCODE = '22000';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'p_customer_id là bắt buộc' USING ERRCODE = '22000';
  END IF;
  IF p_new_stage IS NULL OR pg_catalog.btrim(p_new_stage) = '' THEN
    RAISE EXCEPTION 'p_new_stage là bắt buộc' USING ERRCODE = '22000';
  END IF;
  IF p_confidence IS NOT NULL AND (p_confidence < 0 OR p_confidence > 1) THEN
    RAISE EXCEPTION 'INVALID_CONFIDENCE' USING ERRCODE = '22000';
  END IF;

  v_new_canonical := public.canonical_customer_stage(p_new_stage);
  IF v_new_canonical IS NULL THEN
    RAISE EXCEPTION 'INVALID_STAGE' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_customer
  FROM public.customers
  WHERE id = p_customer_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: Khách hàng không tồn tại hoặc không thuộc quyền quản lý của tổ chức.'
      USING ERRCODE = 'P0002', HINT = 'CUSTOMER_NOT_FOUND';
  END IF;

  v_old_stage := v_customer.stage;
  v_old_canonical := public.canonical_customer_stage(v_customer.stage);

  IF p_expected_stage IS NOT NULL AND pg_catalog.btrim(p_expected_stage) <> '' THEN
    v_expected_canonical := public.canonical_customer_stage(p_expected_stage);
    IF v_expected_canonical IS NULL OR v_expected_canonical <> v_old_canonical THEN
      RAISE EXCEPTION 'STAGE_CONFLICT'
        USING ERRCODE = '40001',
              DETAIL = v_customer.stage,
              HINT = 'STAGE_CONFLICT';
    END IF;
  END IF;

  -- Không tạo history nhiễu khi giai đoạn canonical không đổi.
  IF v_new_canonical = v_old_canonical THEN
    RETURN jsonb_build_object(
      'customer', to_jsonb(v_customer),
      'history', NULL,
      'changed', false
    );
  END IF;

  UPDATE public.customers
  SET stage = v_new_canonical,
      updated_at = v_now
  WHERE id = p_customer_id
    AND company_id = p_company_id
  RETURNING * INTO v_customer;

  v_actor_type := pg_catalog.upper(coalesce(p_actor_type, 'USER'));
  IF v_actor_type NOT IN ('USER', 'AI', 'SYSTEM') THEN
    v_actor_type := 'USER';
  END IF;

  v_verification_status := CASE
    WHEN v_actor_type = 'AI' THEN 'AI_SUGGESTED'
    ELSE 'VERIFIED'
  END;

  v_reason := coalesce(
    NULLIF(pg_catalog.btrim(p_note), ''),
    'Chuyển giai đoạn sang [' || v_new_canonical || ']'
  );

  INSERT INTO public.customer_stage_histories (
    company_id,
    customer_id,
    from_stage,
    to_stage,
    actor_type,
    changed_by_user_id,
    reason,
    source_ref,
    evidence,
    confidence,
    verification_status,
    changed_at
  ) VALUES (
    p_company_id,
    p_customer_id,
    v_old_stage,
    v_new_canonical,
    v_actor_type,
    p_changed_by,
    v_reason,
    p_source_ref,
    p_evidence,
    p_confidence,
    v_verification_status,
    v_now
  )
  RETURNING * INTO v_history;

  RETURN jsonb_build_object(
    'customer', to_jsonb(v_customer),
    'history', to_jsonb(v_history),
    'changed', true
  );
END;
$$;

COMMENT ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text, text, text, numeric)
  IS 'ACID atomic update of customer stage + append-only history with optimistic concurrency. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text, text, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text, text, text, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text, text, text, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text, text, text, numeric) TO service_role;

-- =============================================================================
-- 9. RPC: đọc transcript cuộc gọi đã hoàn tất cho bộ phân loại
-- =============================================================================
DROP FUNCTION IF EXISTS public.get_customer_call_transcript_input(uuid, uuid, integer);

CREATE OR REPLACE FUNCTION public.get_customer_call_transcript_input(
  p_company_id uuid,
  p_customer_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  utterance_id uuid,
  transcription_id uuid,
  call_id uuid,
  customer_id uuid,
  speaker_role text,
  utterance_channel text,
  utterance_text text,
  sequence integer,
  start_ms integer,
  end_ms integer,
  confidence double precision,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_company_id uuid;
  v_limit integer;
BEGIN
  SELECT c.company_id INTO v_customer_company_id
  FROM public.customers c
  WHERE c.id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_customer_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > 200) THEN
    RAISE EXCEPTION 'INVALID_LIMIT' USING ERRCODE = '22000';
  END IF;
  v_limit := coalesce(p_limit, 100);

  RETURN QUERY
  WITH latest AS (
    SELECT
      u.id AS utterance_id,
      u.transcription_id,
      u.call_id,
      t.customer_id,
      u.speaker_role,
      u.channel AS utterance_channel,
      u.text AS utterance_text,
      u.sequence,
      u.start_ms,
      u.end_ms,
      u.confidence,
      u.created_at
    FROM public.zalo_call_transcript_utterances u
    JOIN public.zalo_call_transcriptions t
      ON t.id = u.transcription_id
     AND t.company_id = u.company_id
    WHERE u.company_id = p_company_id
      AND t.customer_id = p_customer_id
      AND t.status = 'COMPLETED'
    ORDER BY u.created_at DESC, u.sequence DESC
    LIMIT v_limit
  )
  SELECT
    l.utterance_id,
    l.transcription_id,
    l.call_id,
    l.customer_id,
    l.speaker_role,
    l.utterance_channel,
    l.utterance_text,
    l.sequence,
    l.start_ms,
    l.end_ms,
    l.confidence,
    l.created_at
  FROM latest l
  ORDER BY l.created_at ASC, l.sequence ASC;
END;
$$;

COMMENT ON FUNCTION public.get_customer_call_transcript_input(uuid, uuid, integer)
  IS 'Đọc bounded transcript utterances của khách hàng để AI phân loại giai đoạn. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.get_customer_call_transcript_input(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_call_transcript_input(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_call_transcript_input(uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_call_transcript_input(uuid, uuid, integer) TO service_role;

-- =============================================================================
-- 10. RPC: ghi AI analysis mở rộng + chống ghi trùng
-- =============================================================================
DROP FUNCTION IF EXISTS public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text);

CREATE OR REPLACE FUNCTION public.record_ai_analysis(
  p_company_id uuid,
  p_customer_id uuid,
  p_source_refs jsonb,
  p_summary text,
  p_stage_suggestion text DEFAULT NULL,
  p_stop_reason text DEFAULT NULL,
  p_objections jsonb DEFAULT '[]'::jsonb,
  p_next_action text DEFAULT NULL,
  p_confidence numeric DEFAULT NULL,
  p_evidence text DEFAULT NULL,
  p_model_version text DEFAULT NULL,
  p_current_stage text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_requires_verification boolean DEFAULT true,
  p_evidence_items jsonb DEFAULT '[]'::jsonb,
  p_dedupe_key text DEFAULT NULL,
  p_classifier_version text DEFAULT NULL,
  p_previous_analysis_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  customer_id uuid,
  source_refs jsonb,
  summary text,
  stage_suggestion text,
  current_stage text,
  stop_reason text,
  objections jsonb,
  next_action text,
  confidence numeric,
  evidence text,
  evidence_items jsonb,
  reason text,
  requires_verification boolean,
  verification_status text,
  verified_by uuid,
  verified_at timestamptz,
  verification_note text,
  classifier_version text,
  dedupe_key text,
  model_version text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_company_id uuid;
  v_elem jsonb;
  v_ref_id uuid;
  v_ref_type text;
  v_int_company_id uuid;
  v_int_customer_id uuid;
  v_int_type text;
  v_int_sanitization_status text;
  v_int_sanitized_content text;
  v_utt_company_id uuid;
  v_utt_customer_id uuid;
  v_utt_status text;
  v_obj_text text;
  v_stage_suggestion text;
  v_current_stage text;
  v_new_row public.ai_analyses%ROWTYPE;
  v_existing public.ai_analyses%ROWTYPE;
  v_previous public.ai_analyses%ROWTYPE;
BEGIN
  -- 1. Tenant binding
  SELECT c.company_id INTO v_customer_company_id
  FROM public.customers c
  WHERE c.id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_customer_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- 2. Confidence
  IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 THEN
    RAISE EXCEPTION 'INVALID_CONFIDENCE' USING ERRCODE = '22000';
  END IF;

  -- 3. Summary
  IF p_summary IS NULL OR pg_catalog.btrim(p_summary) = '' THEN
    RAISE EXCEPTION 'EMPTY_SUMMARY' USING ERRCODE = '22000';
  END IF;
  IF pg_catalog.length(p_summary) > 2000 THEN
    RAISE EXCEPTION 'SUMMARY_TOO_LONG' USING ERRCODE = '22000';
  END IF;

  -- 4. Evidence
  IF p_evidence IS NULL OR pg_catalog.btrim(p_evidence) = '' THEN
    RAISE EXCEPTION 'EMPTY_EVIDENCE' USING ERRCODE = '22000';
  END IF;
  IF pg_catalog.length(p_evidence) > 5000 THEN
    RAISE EXCEPTION 'EVIDENCE_TOO_LONG' USING ERRCODE = '22000';
  END IF;

  -- 5. Model version
  IF p_model_version IS NULL OR pg_catalog.btrim(p_model_version) = '' THEN
    RAISE EXCEPTION 'EMPTY_MODEL_VERSION' USING ERRCODE = '22000';
  END IF;
  IF pg_catalog.length(p_model_version) > 100 THEN
    RAISE EXCEPTION 'MODEL_VERSION_TOO_LONG' USING ERRCODE = '22000';
  END IF;

  -- 6. Stage suggestion + current stage (normalize legacy -> canonical)
  IF p_stage_suggestion IS NOT NULL THEN
    v_stage_suggestion := public.canonical_customer_stage(p_stage_suggestion);
    IF v_stage_suggestion IS NULL THEN
      RAISE EXCEPTION 'INVALID_STAGE_SUGGESTION' USING ERRCODE = '22000';
    END IF;
  END IF;

  IF p_current_stage IS NOT NULL THEN
    v_current_stage := public.canonical_customer_stage(p_current_stage);
    IF v_current_stage IS NULL THEN
      RAISE EXCEPTION 'INVALID_CURRENT_STAGE' USING ERRCODE = '22000';
    END IF;
  END IF;

  -- 7. Stop reason / next action / reason / classifier version
  IF p_stop_reason IS NOT NULL AND pg_catalog.length(p_stop_reason) > 1000 THEN
    RAISE EXCEPTION 'STOP_REASON_TOO_LONG' USING ERRCODE = '22000';
  END IF;
  IF p_next_action IS NOT NULL AND pg_catalog.length(p_next_action) > 1000 THEN
    RAISE EXCEPTION 'NEXT_ACTION_TOO_LONG' USING ERRCODE = '22000';
  END IF;
  IF p_reason IS NOT NULL AND pg_catalog.length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'REASON_TOO_LONG' USING ERRCODE = '22000';
  END IF;
  IF p_classifier_version IS NOT NULL AND pg_catalog.length(p_classifier_version) > 100 THEN
    RAISE EXCEPTION 'CLASSIFIER_VERSION_TOO_LONG' USING ERRCODE = '22000';
  END IF;
  IF p_dedupe_key IS NOT NULL AND p_dedupe_key !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'INVALID_DEDUPE_KEY' USING ERRCODE = '22000';
  END IF;

  -- 8. Objections
  IF p_objections IS NULL OR jsonb_typeof(p_objections) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_OBJECTIONS_STRUCTURE' USING ERRCODE = '22000';
  END IF;
  IF jsonb_array_length(p_objections) > 20 THEN
    RAISE EXCEPTION 'OBJECTIONS_LIMIT_EXCEEDED' USING ERRCODE = '22000';
  END IF;
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_objections) LOOP
    IF jsonb_typeof(v_elem) <> 'string' THEN
      RAISE EXCEPTION 'INVALID_OBJECTION_ITEM' USING ERRCODE = '22000';
    END IF;
    v_obj_text := v_elem #>> '{}';
    IF pg_catalog.btrim(v_obj_text) = '' THEN
      RAISE EXCEPTION 'EMPTY_OBJECTION_ITEM' USING ERRCODE = '22000';
    END IF;
    IF pg_catalog.length(v_obj_text) > 500 THEN
      RAISE EXCEPTION 'OBJECTION_TOO_LONG' USING ERRCODE = '22000';
    END IF;
  END LOOP;

  -- 9. Evidence items (structured, quote-only, no sensitive payloads)
  IF p_evidence_items IS NULL OR jsonb_typeof(p_evidence_items) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_EVIDENCE_ITEMS_STRUCTURE' USING ERRCODE = '22000';
  END IF;
  IF jsonb_array_length(p_evidence_items) > 20 THEN
    RAISE EXCEPTION 'EVIDENCE_ITEMS_LIMIT_EXCEEDED' USING ERRCODE = '22000';
  END IF;
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_evidence_items) LOOP
    IF jsonb_typeof(v_elem) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_EVIDENCE_ITEM' USING ERRCODE = '22000';
    END IF;
    IF v_elem ? 'phone' OR v_elem ? 'recording' OR v_elem ? 'raw_payload'
       OR v_elem ? 'token' OR v_elem ? 'content' THEN
      RAISE EXCEPTION 'SENSITIVE_DATA_IN_EVIDENCE_ITEM' USING ERRCODE = '22000';
    END IF;
    v_obj_text := v_elem->>'quote';
    IF v_obj_text IS NULL OR pg_catalog.btrim(v_obj_text) = '' THEN
      RAISE EXCEPTION 'EMPTY_EVIDENCE_QUOTE' USING ERRCODE = '22000';
    END IF;
    IF pg_catalog.length(v_obj_text) > 500 THEN
      RAISE EXCEPTION 'EVIDENCE_QUOTE_TOO_LONG' USING ERRCODE = '22000';
    END IF;
    v_obj_text := v_elem->>'source';
    IF v_obj_text IS NULL OR pg_catalog.length(v_obj_text) > 50 THEN
      RAISE EXCEPTION 'INVALID_EVIDENCE_SOURCE' USING ERRCODE = '22000';
    END IF;
    v_obj_text := v_elem->>'speaker';
    IF v_obj_text IS NOT NULL AND v_obj_text NOT IN ('CUSTOMER', 'STAFF', 'UNKNOWN') THEN
      RAISE EXCEPTION 'INVALID_EVIDENCE_SPEAKER' USING ERRCODE = '22000';
    END IF;
    IF v_elem ? 'stage' AND v_elem->>'stage' IS NOT NULL
       AND public.canonical_customer_stage(v_elem->>'stage') IS NULL THEN
      RAISE EXCEPTION 'INVALID_EVIDENCE_STAGE' USING ERRCODE = '22000';
    END IF;
  END LOOP;

  -- 10. Source refs: INTERACTION hoặc CALL_TRANSCRIPT_UTTERANCE
  IF p_source_refs IS NULL OR jsonb_typeof(p_source_refs) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_REFS_STRUCTURE' USING ERRCODE = '22000';
  END IF;
  IF jsonb_array_length(p_source_refs) = 0 THEN
    RAISE EXCEPTION 'EMPTY_SOURCE_REFS' USING ERRCODE = '22000';
  END IF;
  IF jsonb_array_length(p_source_refs) > 100 THEN
    RAISE EXCEPTION 'SOURCE_REFS_LIMIT_EXCEEDED' USING ERRCODE = '22000';
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_source_refs) LOOP
    IF jsonb_typeof(v_elem) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_SOURCE_REF_ITEM' USING ERRCODE = '22000';
    END IF;

    v_ref_type := v_elem->>'type';
    IF v_ref_type IS NULL OR v_ref_type NOT IN ('INTERACTION', 'CALL_TRANSCRIPT_UTTERANCE') THEN
      RAISE EXCEPTION 'FORBIDDEN_SOURCE_REF_TYPE' USING ERRCODE = '22000';
    END IF;

    IF v_elem ? 'content' OR v_elem ? 'phone' OR v_elem ? 'transcript'
       OR v_elem ? 'recording' OR v_elem ? 'raw_payload' OR v_elem ? 'token' THEN
      RAISE EXCEPTION 'SENSITIVE_DATA_IN_SOURCE_REF' USING ERRCODE = '22000';
    END IF;

    BEGIN
      v_ref_id := (v_elem->>'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'INVALID_SOURCE_REF_UUID' USING ERRCODE = '22000';
    END;

    IF v_ref_type = 'INTERACTION' THEN
      SELECT i.company_id, i.customer_id, i.type, i.sanitization_status, i.sanitized_content
      INTO v_int_company_id, v_int_customer_id, v_int_type, v_int_sanitization_status, v_int_sanitized_content
      FROM public.interactions i
      WHERE i.id = v_ref_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'SOURCE_INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
      END IF;
      IF v_int_company_id <> p_company_id THEN
        RAISE EXCEPTION 'SOURCE_INTERACTION_TENANT_MISMATCH' USING ERRCODE = '42501';
      END IF;
      IF v_int_customer_id <> p_customer_id THEN
        RAISE EXCEPTION 'SOURCE_INTERACTION_CUSTOMER_MISMATCH' USING ERRCODE = '22000';
      END IF;
      IF v_int_type <> 'MESSAGE' THEN
        RAISE EXCEPTION 'SOURCE_INTERACTION_NOT_MESSAGE' USING ERRCODE = '22000';
      END IF;
      IF v_int_sanitization_status <> 'SUCCEEDED' THEN
        RAISE EXCEPTION 'SOURCE_INTERACTION_NOT_SANITIZED' USING ERRCODE = '22000';
      END IF;
      IF v_int_sanitized_content IS NULL OR pg_catalog.btrim(v_int_sanitized_content) = '' THEN
        RAISE EXCEPTION 'SOURCE_INTERACTION_NO_CONTENT' USING ERRCODE = '22000';
      END IF;
    ELSE
      SELECT u.company_id, t.customer_id, t.status
      INTO v_utt_company_id, v_utt_customer_id, v_utt_status
      FROM public.zalo_call_transcript_utterances u
      JOIN public.zalo_call_transcriptions t
        ON t.id = u.transcription_id
       AND t.company_id = u.company_id
      WHERE u.id = v_ref_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'SOURCE_TRANSCRIPT_NOT_FOUND' USING ERRCODE = 'P0002';
      END IF;
      IF v_utt_company_id <> p_company_id THEN
        RAISE EXCEPTION 'SOURCE_TRANSCRIPT_TENANT_MISMATCH' USING ERRCODE = '42501';
      END IF;
      IF v_utt_customer_id <> p_customer_id THEN
        RAISE EXCEPTION 'SOURCE_TRANSCRIPT_CUSTOMER_MISMATCH' USING ERRCODE = '22000';
      END IF;
      IF v_utt_status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'SOURCE_TRANSCRIPT_NOT_COMPLETED' USING ERRCODE = '22000';
      END IF;
    END IF;
  END LOOP;

  -- 11. Previous analysis reference
  IF p_previous_analysis_id IS NOT NULL THEN
    SELECT * INTO v_previous
    FROM public.ai_analyses a
    WHERE a.id = p_previous_analysis_id
      AND a.company_id = p_company_id
      AND a.customer_id = p_customer_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PREVIOUS_ANALYSIS_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- 12. Idempotency: cùng dedupe_key trả về bản ghi cũ, không tạo ghi chú trùng
  IF p_dedupe_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.ai_analyses a
    WHERE a.company_id = p_company_id
      AND a.customer_id = p_customer_id
      AND a.dedupe_key = p_dedupe_key
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT
        v_existing.id, v_existing.company_id, v_existing.customer_id, v_existing.source_refs,
        v_existing.summary, v_existing.stage_suggestion, v_existing.current_stage,
        v_existing.stop_reason, v_existing.objections, v_existing.next_action,
        v_existing.confidence, v_existing.evidence, v_existing.evidence_items,
        v_existing.reason, v_existing.requires_verification, v_existing.verification_status,
        v_existing.verified_by, v_existing.verified_at, v_existing.verification_note,
        v_existing.classifier_version, v_existing.dedupe_key, v_existing.model_version,
        v_existing.created_at;
      RETURN;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.ai_analyses (
      company_id,
      customer_id,
      source_refs,
      summary,
      stage_suggestion,
      current_stage,
      stop_reason,
      objections,
      next_action,
      confidence,
      evidence,
      evidence_items,
      reason,
      requires_verification,
      classifier_version,
      dedupe_key,
      previous_analysis_id,
      model_version
    ) VALUES (
      p_company_id,
      p_customer_id,
      p_source_refs,
      p_summary,
      v_stage_suggestion,
      v_current_stage,
      p_stop_reason,
      p_objections,
      p_next_action,
      p_confidence,
      p_evidence,
      p_evidence_items,
      p_reason,
      coalesce(p_requires_verification, true),
      p_classifier_version,
      p_dedupe_key,
      p_previous_analysis_id,
      p_model_version
    )
    RETURNING * INTO v_new_row;
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent reprocessing of the same conversation: return the winner row.
    IF p_dedupe_key IS NULL THEN
      RAISE;
    END IF;
    SELECT * INTO v_new_row
    FROM public.ai_analyses a
    WHERE a.company_id = p_company_id
      AND a.customer_id = p_customer_id
      AND a.dedupe_key = p_dedupe_key
    LIMIT 1;
  END;

  IF v_new_row.id IS NULL AND p_dedupe_key IS NOT NULL THEN
    SELECT * INTO v_new_row
    FROM public.ai_analyses a
    WHERE a.company_id = p_company_id
      AND a.customer_id = p_customer_id
      AND a.dedupe_key = p_dedupe_key
    LIMIT 1;
  END IF;

  IF v_new_row.id IS NULL THEN
    RAISE EXCEPTION 'AI_ANALYSIS_PERSIST_FAILED' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT
    v_new_row.id, v_new_row.company_id, v_new_row.customer_id, v_new_row.source_refs,
    v_new_row.summary, v_new_row.stage_suggestion, v_new_row.current_stage,
    v_new_row.stop_reason, v_new_row.objections, v_new_row.next_action,
    v_new_row.confidence, v_new_row.evidence, v_new_row.evidence_items,
    v_new_row.reason, v_new_row.requires_verification, v_new_row.verification_status,
    v_new_row.verified_by, v_new_row.verified_at, v_new_row.verification_note,
    v_new_row.classifier_version, v_new_row.dedupe_key, v_new_row.model_version,
    v_new_row.created_at;
END;
$$;

COMMENT ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text, text, text, boolean, jsonb, text, text, uuid)
  IS 'Bounded append-only AI analysis persistence with structured evidence, dedupe key and zero stage mutation.';

REVOKE ALL ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text, text, text, boolean, jsonb, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text, text, text, boolean, jsonb, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text, text, text, boolean, jsonb, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text, text, text, boolean, jsonb, text, text, uuid) TO service_role;

-- =============================================================================
-- 11. RPC: đọc danh sách gợi ý giai đoạn cho hồ sơ khách hàng
-- =============================================================================
DROP FUNCTION IF EXISTS public.get_customer_stage_suggestions(uuid, uuid, integer);

CREATE OR REPLACE FUNCTION public.get_customer_stage_suggestions(
  p_company_id uuid,
  p_customer_id uuid,
  p_limit integer DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  customer_id uuid,
  summary text,
  stage_suggestion text,
  current_stage text,
  confidence numeric,
  evidence text,
  evidence_items jsonb,
  reason text,
  stop_reason text,
  objections jsonb,
  next_action text,
  requires_verification boolean,
  verification_status text,
  verified_by uuid,
  verified_at timestamptz,
  verification_note text,
  classifier_version text,
  model_version text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_company_id uuid;
  v_limit integer;
BEGIN
  SELECT c.company_id INTO v_customer_company_id
  FROM public.customers c
  WHERE c.id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_customer_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > 50) THEN
    RAISE EXCEPTION 'INVALID_LIMIT' USING ERRCODE = '22000';
  END IF;
  v_limit := coalesce(p_limit, 10);

  RETURN QUERY
  SELECT
    a.id,
    a.company_id,
    a.customer_id,
    a.summary,
    a.stage_suggestion,
    a.current_stage,
    a.confidence,
    a.evidence,
    coalesce(a.evidence_items, '[]'::jsonb),
    a.reason,
    a.stop_reason,
    a.objections,
    a.next_action,
    a.requires_verification,
    a.verification_status,
    a.verified_by,
    a.verified_at,
    a.verification_note,
    a.classifier_version,
    a.model_version,
    a.created_at
  FROM public.ai_analyses a
  WHERE a.company_id = p_company_id
    AND a.customer_id = p_customer_id
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.get_customer_stage_suggestions(uuid, uuid, integer)
  IS 'Đọc bounded danh sách AI stage suggestions của một khách hàng. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.get_customer_stage_suggestions(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_stage_suggestions(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_stage_suggestions(uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_stage_suggestions(uuid, uuid, integer) TO service_role;

-- =============================================================================
-- 12. RPC: xác minh thủ công đề xuất giai đoạn của AI
-- =============================================================================
DROP FUNCTION IF EXISTS public.verify_ai_stage_suggestion(uuid, uuid, text, uuid, text, text, uuid);
DROP FUNCTION IF EXISTS public.verify_ai_stage_suggestion(uuid, uuid, text, uuid, text, text, uuid);

CREATE OR REPLACE FUNCTION public.verify_ai_stage_suggestion(
  p_company_id uuid,
  p_analysis_id uuid,
  p_decision text,
  p_verified_by uuid,
  p_verifier_role text,
  p_note text DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_analysis public.ai_analyses%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_result jsonb;
  v_current_canonical text;
  v_new_canonical text;
  v_decision text;
  v_role text;
  v_note text;
BEGIN
  v_decision := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  v_role := pg_catalog.upper(pg_catalog.btrim(coalesce(p_verifier_role, '')));

  IF v_decision NOT IN ('ACCEPTED', 'REJECTED') THEN
    RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE = '22000';
  END IF;
  IF v_role NOT IN ('SALE', 'BOSS_ADMIN') THEN
    RAISE EXCEPTION 'ROLE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_verified_by IS NULL THEN
    RAISE EXCEPTION 'VERIFIER_REQUIRED' USING ERRCODE = '22000';
  END IF;
  IF p_note IS NOT NULL AND pg_catalog.length(p_note) > 1000 THEN
    RAISE EXCEPTION 'NOTE_TOO_LONG' USING ERRCODE = '22000';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(p_note), '');

  SELECT * INTO v_analysis
  FROM public.ai_analyses a
  WHERE a.id = p_analysis_id
    AND a.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANALYSIS_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_customer_id IS NOT NULL AND v_analysis.customer_id <> p_customer_id THEN
    -- Không cho phép áp dụng đề xuất của khách hàng khác qua URL.
    RAISE EXCEPTION 'ANALYSIS_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_analysis.verification_status <> 'PENDING' THEN
    RAISE EXCEPTION 'ANALYSIS_ALREADY_VERIFIED' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_customer
  FROM public.customers c
  WHERE c.id = v_analysis.customer_id
    AND c.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_decision = 'REJECTED' THEN
    UPDATE public.ai_analyses
    SET verification_status = 'REJECTED',
        verified_by = p_verified_by,
        verified_at = now(),
        verification_note = v_note
    WHERE id = p_analysis_id
      AND company_id = p_company_id;

    RETURN jsonb_build_object(
      'analysis', to_jsonb(v_analysis) || jsonb_build_object(
        'verification_status', 'REJECTED',
        'verified_by', p_verified_by,
        'verified_at', now(),
        'verification_note', v_note
      ),
      'customer', NULL,
      'history', NULL
    );
  END IF;

  IF v_analysis.stage_suggestion IS NULL THEN
    RAISE EXCEPTION 'NOTHING_TO_ACCEPT' USING ERRCODE = '22000';
  END IF;

  v_new_canonical := public.canonical_customer_stage(v_analysis.stage_suggestion);
  v_current_canonical := public.canonical_customer_stage(v_customer.stage);

  IF v_new_canonical IS NULL THEN
    RAISE EXCEPTION 'INVALID_STAGE_SUGGESTION' USING ERRCODE = '22000';
  END IF;

  IF v_analysis.current_stage IS NOT NULL
     AND public.canonical_customer_stage(v_analysis.current_stage) <> v_current_canonical THEN
    RAISE EXCEPTION 'STAGE_CHANGED_SINCE_ANALYSIS'
      USING ERRCODE = '40001',
            DETAIL = v_customer.stage,
            HINT = 'STAGE_CHANGED_SINCE_ANALYSIS';
  END IF;

  IF v_new_canonical = 'contract_signed' THEN
    IF v_role <> 'BOSS_ADMIN' THEN
      RAISE EXCEPTION 'CONTRACT_SIGNED_REQUIRES_BOSS_ADMIN' USING ERRCODE = '42501';
    END IF;
    -- High-risk change: require a written verification note with real evidence.
    IF v_note IS NULL OR pg_catalog.length(v_note) < 10 THEN
      RAISE EXCEPTION 'CONTRACT_SIGNED_NOTE_REQUIRED' USING ERRCODE = '22000';
    END IF;
  END IF;

  v_result := public.update_customer_stage_atomic(
    p_company_id => p_company_id,
    p_customer_id => v_analysis.customer_id,
    p_new_stage => v_new_canonical,
    p_note => coalesce(
      v_note,
      'Nhân viên xác nhận đề xuất AI: ' || coalesce(v_analysis.reason, v_analysis.summary)
    ),
    p_changed_by => p_verified_by,
    p_actor_type => 'USER',
    p_source_ref => 'AI_ANALYSIS:' || p_analysis_id::text,
    p_expected_stage => v_customer.stage,
    p_evidence => v_analysis.evidence,
    p_confidence => v_analysis.confidence
  );

  UPDATE public.ai_analyses
  SET verification_status = 'ACCEPTED',
      verified_by = p_verified_by,
      verified_at = now(),
      verification_note = v_note
  WHERE id = p_analysis_id
    AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'analysis', to_jsonb(v_analysis) || jsonb_build_object(
      'verification_status', 'ACCEPTED',
      'verified_by', p_verified_by,
      'verified_at', now(),
      'verification_note', v_note
    ),
    'customer', v_result->'customer',
    'history', v_result->'history'
  );
END;
$$;

COMMENT ON FUNCTION public.verify_ai_stage_suggestion(uuid, uuid, text, uuid, text, text, uuid)
  IS 'Manual verification of an AI stage suggestion. Contract-signed acceptance requires BOSS_ADMIN.';

REVOKE ALL ON FUNCTION public.verify_ai_stage_suggestion(uuid, uuid, text, uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_ai_stage_suggestion(uuid, uuid, text, uuid, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.verify_ai_stage_suggestion(uuid, uuid, text, uuid, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.verify_ai_stage_suggestion(uuid, uuid, text, uuid, text, text, uuid) TO service_role;

-- =============================================================================
-- 13. Quyền đọc bảng audit migration (chỉ service_role)
-- =============================================================================
REVOKE ALL ON TABLE public.customer_stage_migration_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.customer_stage_migration_audit TO service_role;

COMMIT;
