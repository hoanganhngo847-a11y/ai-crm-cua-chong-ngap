-- Migration 005: Survey Atomic Completion & DB Transaction
-- Enforces single-shot completion and atomic commitment of survey and appointment status.

-- 1. Đảm bảo bảng public.surveys tồn tại trước khi thêm constraint (Idempotent DDL)
CREATE TABLE IF NOT EXISTS public.surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  completed_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  measurements jsonb NOT NULL,
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  site_condition text NOT NULL,
  notes text NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_surveys_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_surveys_appointment FOREIGN KEY (company_id, customer_id, appointment_id)
    REFERENCES public.appointments(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_surveys_company_customer_id UNIQUE (company_id, customer_id, id)
);

-- 2. Thêm UNIQUE constraint trên bảng surveys để loại bỏ triệt để Race Condition trùng lặp (Idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_survey_appointment'
  ) THEN
    ALTER TABLE public.surveys ADD CONSTRAINT unique_survey_appointment UNIQUE (appointment_id);
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

-- 3. Tạo PostgreSQL RPC function complete_survey_atomic
CREATE OR REPLACE FUNCTION public.complete_survey_atomic(
  p_appointment_id uuid,
  p_survey_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_appointment record;
  v_survey record;
  v_now timestamptz := clock_timestamp();
  v_company_id uuid;
  v_customer_id uuid;
  v_completed_by uuid;
  v_measurements jsonb;
  v_photos jsonb;
  v_site_condition text;
  v_notes text;
  v_completed_at timestamptz;
  v_member_exists boolean;
BEGIN
  -- 3.1. Khóa dòng appointment bằng SELECT FOR UPDATE
  SELECT id, company_id, customer_id, status, type, assignee_id
  INTO v_appointment
  FROM public.appointments
  WHERE id = p_appointment_id
  FOR UPDATE;

  -- 3.2. Kiểm tra tồn tại
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APPOINTMENT_NOT_FOUND';
  END IF;

  -- 3.3. Kiểm tra type
  IF v_appointment.type <> 'SURVEY' THEN
    RAISE EXCEPTION 'APPOINTMENT_TYPE_NOT_SURVEY';
  END IF;

  -- 3.4. Kiểm tra trạng thái terminal & tiền đề (P0: Predecessor State Check)
  IF v_appointment.status IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'APPOINTMENT_ALREADY_TERMINAL';
  END IF;

  IF v_appointment.status NOT IN ('IN_PROGRESS', 'ACCEPTED') THEN
    RAISE EXCEPTION 'INVALID_PREDECESSOR_STATE: APPOINTMENT_STATE_INVALID';
  END IF;

  -- 3.5. Trích xuất an toàn & chống giả mạo danh tính (P0: Identity Spoofing Prevention)
  -- BẮT BUỘC gán company_id và customer_id từ chính bản ghi appointment đã khóa, tuyệt đối không tin payload
  v_company_id := v_appointment.company_id;
  v_customer_id := v_appointment.customer_id;

  -- completed_by: Ưu tiên payload nếu được truyền, fallback về assignee_id
  v_completed_by := COALESCE(
    (p_survey_payload->>'completed_by')::uuid,
    (p_survey_payload->>'completedBy')::uuid,
    v_appointment.assignee_id
  );

  -- Xác minh completed_by bắt buộc là thành viên ACTIVE thuộc cùng company_id
  SELECT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = v_completed_by
      AND company_id = v_company_id
      AND status = 'ACTIVE'
  ) INTO v_member_exists;

  IF NOT v_member_exists THEN
    RAISE EXCEPTION 'INVALID_COMPLETED_BY';
  END IF;

  v_measurements := COALESCE(p_survey_payload->'measurements', '{}'::jsonb);
  v_photos := COALESCE(p_survey_payload->'photos', '[]'::jsonb);
  v_site_condition := COALESCE(p_survey_payload->>'site_condition', p_survey_payload->>'siteCondition', '');
  v_notes := p_survey_payload->>'notes';
  v_completed_at := COALESCE((p_survey_payload->>'completed_at')::timestamptz, v_now);

  -- 3.6. Atomic Step A: Cập nhật appointment sang COMPLETED (có ràng buộc trạng thái tiền đề)
  UPDATE public.appointments
  SET status = 'COMPLETED',
      updated_at = v_now
  WHERE id = p_appointment_id
    AND status IN ('IN_PROGRESS', 'ACCEPTED');

  -- 3.7. Atomic Step B: Insert survey
  INSERT INTO public.surveys (
    company_id,
    customer_id,
    appointment_id,
    completed_by,
    measurements,
    photos,
    site_condition,
    notes,
    completed_at,
    created_at,
    updated_at
  ) VALUES (
    v_company_id,
    v_customer_id,
    p_appointment_id,
    v_completed_by,
    v_measurements,
    v_photos,
    v_site_condition,
    v_notes,
    v_completed_at,
    v_now,
    v_now
  )
  RETURNING * INTO v_survey;

  -- 3.8. Trả về bản ghi survey vừa tạo dạng JSON
  RETURN to_jsonb(v_survey);
END;
$$;

COMMENT ON FUNCTION public.complete_survey_atomic(uuid, jsonb)
  IS 'Single-shot atomic survey completion function: locks appointment, updates status to COMPLETED, inserts survey, rolls back automatically on error.';

-- 4. Cấu hình quyền truy cập RPC (P0: Security Boundary RPC)
-- Hàm nghiệp vụ nhạy cảm Trusted-Server: Chỉ cấp quyền EXECUTE cho service_role
-- Thu hồi toàn bộ quyền từ PUBLIC, anon, VÀ authenticated để ngăn chặn direct-RPC abuse
REVOKE ALL ON FUNCTION public.complete_survey_atomic(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_survey_atomic(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.complete_survey_atomic(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_survey_atomic(uuid, jsonb) TO service_role;
