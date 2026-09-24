-- Migration 005: Survey Atomic Completion & DB Transaction
-- Enforces single-shot completion and atomic commitment of survey and appointment status.

-- 1. Thêm UNIQUE constraint trên bảng surveys để loại bỏ triệt để Race Condition trùng lặp (Idempotent)
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

-- 2. Tạo PostgreSQL RPC function complete_survey_atomic
-- P1 Hardening: p_completed_by truyền riêng biệt dưới dạng UUID, không parse từ p_survey_payload jsonb
DROP FUNCTION IF EXISTS public.complete_survey_atomic(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.complete_survey_atomic(
  p_appointment_id uuid,
  p_completed_by uuid,
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
  v_member record;
  v_now timestamptz := clock_timestamp();
  v_company_id uuid;
  v_customer_id uuid;
  v_measurements jsonb;
  v_photos jsonb;
  v_site_condition text;
  v_notes text;
  v_completed_at timestamptz;
BEGIN
  -- 2.1. Khóa dòng appointment bằng SELECT FOR UPDATE
  SELECT id, company_id, customer_id, status, type, assignee_id
  INTO v_appointment
  FROM public.appointments
  WHERE id = p_appointment_id
  FOR UPDATE;

  -- 2.2. Kiểm tra tồn tại
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APPOINTMENT_NOT_FOUND';
  END IF;

  -- 2.3. Kiểm tra type
  IF v_appointment.type <> 'SURVEY' THEN
    RAISE EXCEPTION 'APPOINTMENT_TYPE_NOT_SURVEY';
  END IF;

  -- 2.4. Kiểm tra trạng thái terminal & tiền đề (P0: Predecessor State Check)
  IF v_appointment.status IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'APPOINTMENT_ALREADY_TERMINAL';
  END IF;

  IF v_appointment.status NOT IN ('IN_PROGRESS', 'ACCEPTED') THEN
    RAISE EXCEPTION 'INVALID_PREDECESSOR_STATE: APPOINTMENT_STATE_INVALID';
  END IF;

  -- 2.5. Trích xuất an toàn & chống giả mạo danh tính (P0: Identity Spoofing Prevention)
  -- BẮT BUỘC gán company_id và customer_id từ chính bản ghi appointment đã khóa, tuyệt đối không tin payload
  v_company_id := v_appointment.company_id;
  v_customer_id := v_appointment.customer_id;

  -- 2.5.1. P1 Hardening: Xác thực p_completed_by (truyền riêng biệt, không parse từ JSON payload)
  IF p_completed_by IS NULL THEN
    RAISE EXCEPTION 'INVALID_COMPLETED_BY';
  END IF;

  -- Xác minh p_completed_by bắt buộc là thành viên ACTIVE thuộc cùng company_id
  SELECT role, status
  INTO v_member
  FROM public.company_members
  WHERE user_id = p_completed_by
    AND company_id = v_company_id
    AND status = 'ACTIVE';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_COMPLETED_BY';
  END IF;

  -- Kiểm tra phân quyền: TECHNICIAN phải là assignee_id của lịch hẹn; BOSS_ADMIN được phép
  IF v_member.role = 'TECHNICIAN' THEN
    IF v_appointment.assignee_id IS NULL OR v_appointment.assignee_id <> p_completed_by THEN
      RAISE EXCEPTION 'INVALID_COMPLETED_BY: TECHNICIAN_NOT_ASSIGNEE';
    END IF;
  ELSIF v_member.role = 'BOSS_ADMIN' THEN
    -- BOSS_ADMIN được phép hoàn tất khảo sát
    NULL;
  ELSE
    RAISE EXCEPTION 'INVALID_COMPLETED_BY';
  END IF;

  v_measurements := COALESCE(p_survey_payload->'measurements', '{}'::jsonb);
  v_photos := COALESCE(p_survey_payload->'photos', '[]'::jsonb);
  v_site_condition := COALESCE(p_survey_payload->>'site_condition', p_survey_payload->>'siteCondition', '');
  v_notes := p_survey_payload->>'notes';
  v_completed_at := COALESCE((p_survey_payload->>'completed_at')::timestamptz, v_now);

  -- 2.6. Atomic Step A: Cập nhật appointment sang COMPLETED (có ràng buộc trạng thái tiền đề)
  UPDATE public.appointments
  SET status = 'COMPLETED',
      updated_at = v_now
  WHERE id = p_appointment_id
    AND status IN ('IN_PROGRESS', 'ACCEPTED');

  -- 2.7. Atomic Step B: Insert survey
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
    p_completed_by,
    v_measurements,
    v_photos,
    v_site_condition,
    v_notes,
    v_completed_at,
    v_now,
    v_now
  )
  RETURNING * INTO v_survey;

  -- 2.8. Trả về bản ghi survey vừa tạo dạng JSON
  RETURN to_jsonb(v_survey);
END;
$$;

COMMENT ON FUNCTION public.complete_survey_atomic(uuid, uuid, jsonb)
  IS 'Single-shot atomic survey completion function: locks appointment, updates status to COMPLETED, inserts survey, rolls back automatically on error.';

-- 3. Cấu hình quyền truy cập RPC (P0: Security Boundary RPC)
-- Hàm nghiệp vụ nhạy cảm Trusted-Server: Chỉ cấp quyền EXECUTE cho service_role
-- Thu hồi toàn bộ quyền từ PUBLIC, anon, VÀ authenticated để ngăn chặn direct-RPC abuse
REVOKE ALL ON FUNCTION public.complete_survey_atomic(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_survey_atomic(uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.complete_survey_atomic(uuid, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_survey_atomic(uuid, uuid, jsonb) TO service_role;
