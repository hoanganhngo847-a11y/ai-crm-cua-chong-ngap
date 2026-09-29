-- Migration: 20260920000002_operations_atomic_rpcs.sql
-- Review lần 2: Operations Atomic RPCs & Warranty State Machine Alignment
-- Schemas: Trusted Server-only RPCs for Atomic Installation Completion and Quality Check.

-- 1. Cập nhật Check Constraint trên warranty_tickets để hỗ trợ đầy đủ State Machine (P1)
ALTER TABLE public.warranty_tickets DROP CONSTRAINT IF EXISTS warranty_tickets_status_check;
ALTER TABLE public.warranty_tickets ADD CONSTRAINT warranty_tickets_status_check
  CHECK (status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED', 'CANCELLED', 'FAILED'));

-- 2. Atomic RPC: Nghiệm thu & hoàn tất bàn giao lắp đặt (P0)
-- Bọc toàn bộ trong 1 transaction nguyên tử: kiểm tra status = 'HANDOVER_PENDING'
-- -> update installations.status = 'COMPLETED'
-- -> update orders.order_status = 'COMPLETED'
-- -> insert into audit_logs.
-- Bất kỳ bước nào lỗi, Postgres tự động ROLLBACK toàn bộ.
CREATE OR REPLACE FUNCTION public.complete_installation_atomic(
  p_company_id uuid,
  p_installation_id uuid,
  p_actor_id uuid,
  p_completed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_install record;
  v_order record;
  v_completed_at timestamptz;
BEGIN
  v_completed_at := COALESCE(p_completed_at, now());

  -- 1. Khóa và truy vấn hồ sơ lắp đặt
  SELECT id, company_id, customer_id, order_id, appointment_id, status, photos, handover_ref
  INTO v_install
  FROM public.installations
  WHERE company_id = p_company_id AND id = p_installation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Không tìm thấy thông tin lắp đặt.';
  END IF;

  -- 2. Khóa và truy vấn đơn hàng tương ứng
  SELECT id, company_id, order_status
  INTO v_order
  FROM public.orders
  WHERE company_id = p_company_id AND id = v_install.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Không tìm thấy thông tin đơn hàng tương ứng.';
  END IF;

  -- Idempotency check: Nếu cả 2 đã hoàn tất từ trước
  IF v_install.status = 'COMPLETED' AND v_order.order_status = 'COMPLETED' THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'COMPLETED',
      'order_id', v_install.order_id,
      'idempotent', true
    );
  END IF;

  -- 3. Khóa State Machine: Bắt buộc ở HANDOVER_PENDING (hoặc trường hợp giải cứu nếu install đã COMPLETED nhưng order chưa COMPLETED)
  IF v_install.status <> 'HANDOVER_PENDING' AND v_install.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION: Chỉ cho phép nghiệm thu khi hồ sơ lắp đặt ở trạng thái HANDOVER_PENDING. Trạng thái hiện tại: %', v_install.status;
  END IF;

  -- 4. Cập nhật installations -> COMPLETED
  IF v_install.status <> 'COMPLETED' THEN
    UPDATE public.installations
    SET status = 'COMPLETED',
        completed_at = v_completed_at,
        updated_at = v_completed_at
    WHERE company_id = p_company_id AND id = p_installation_id;
  END IF;

  -- 5. Cập nhật orders -> COMPLETED
  IF v_order.order_status <> 'COMPLETED' THEN
    UPDATE public.orders
    SET order_status = 'COMPLETED',
        updated_at = v_completed_at
    WHERE company_id = p_company_id AND id = v_install.order_id;
  END IF;

  -- 6. Ghi audit_logs (Bắt buộc fail-closed trong transaction)
  INSERT INTO public.audit_logs (
    company_id,
    user_id,
    action,
    resource_type,
    resource_id,
    customer_id,
    result,
    metadata
  ) VALUES (
    p_company_id,
    p_actor_id,
    'COMPLETE_INSTALLATION_AND_HANDOVER',
    'installations',
    p_installation_id,
    v_install.customer_id,
    'SUCCESS',
    jsonb_build_object(
      'from_status', v_install.status,
      'to_status', 'COMPLETED',
      'order_id', v_install.order_id,
      'actor_id', p_actor_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'installation_id', p_installation_id,
    'order_id', v_install.order_id,
    'completed_at', v_completed_at
  );
END;
$$;

COMMENT ON FUNCTION public.complete_installation_atomic(uuid, uuid, uuid, timestamptz)
  IS 'Trusted server RPC: Hoàn tất nghiệm thu và bàn giao đơn hàng nguyên tử (Postgres Transaction). Strictly restricted to service_role.';

REVOKE ALL ON FUNCTION public.complete_installation_atomic(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_installation_atomic(uuid, uuid, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.complete_installation_atomic(uuid, uuid, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_installation_atomic(uuid, uuid, uuid, timestamptz) TO service_role;


-- 3. Atomic RPC: Đánh giá chất lượng sản phẩm (QC) xưởng (P0)
-- Bọc toàn bộ trong 1 transaction: kiểm tra status = 'QC_IN_PROGRESS'
-- -> update production_orders (status = 'READY_FOR_DISPATCH' / 'QC_FAILED')
-- -> update orders (order_status = 'READY_FOR_INSTALL' nếu PASSED)
-- -> insert into audit_logs trong 1 transaction duy nhất.
CREATE OR REPLACE FUNCTION public.record_quality_check_atomic(
  p_company_id uuid,
  p_production_order_id uuid,
  p_qc_status text,
  p_inspector_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prod record;
  v_order record;
  v_next_status text;
  v_db_qc_status text;
  v_timestamp timestamptz;
BEGIN
  v_timestamp := now();

  -- 1. Khóa và truy vấn lệnh sản xuất
  SELECT id, company_id, order_id, status, qc_status
  INTO v_prod
  FROM public.production_orders
  WHERE company_id = p_company_id AND id = p_production_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Không tìm thấy lệnh sản xuất để kiểm tra QC.';
  END IF;

  -- 2. Kiểm tra điều kiện trạng thái xưởng: bắt buộc QC_IN_PROGRESS
  IF v_prod.status <> 'QC_IN_PROGRESS' THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION: Lệnh xưởng phải ở trạng thái QC_IN_PROGRESS để kiểm tra QC. Trạng thái hiện tại: %', v_prod.status;
  END IF;

  -- 3. Phân định trạng thái tiếp theo dựa trên kết quả QC
  IF p_qc_status = 'PASSED' THEN
    v_next_status := 'READY_FOR_DISPATCH';
    v_db_qc_status := 'PASSED';
  ELSIF p_qc_status = 'REWORK_REQUIRED' OR p_qc_status = 'REJECTED' THEN
    v_next_status := 'QC_FAILED';
    v_db_qc_status := p_qc_status;
  ELSE
    RAISE EXCEPTION 'INVALID_INPUT: Trạng thái QC không hợp lệ: %', p_qc_status;
  END IF;

  -- 4. Cập nhật production_orders
  UPDATE public.production_orders
  SET status = v_next_status,
      qc_status = v_db_qc_status,
      updated_at = v_timestamp
  WHERE company_id = p_company_id AND id = p_production_order_id;

  -- 5. Nếu PASSED, kích hoạt orders -> READY_FOR_INSTALL
  IF v_db_qc_status = 'PASSED' THEN
    SELECT id, company_id, order_status
    INTO v_order
    FROM public.orders
    WHERE company_id = p_company_id AND id = v_prod.order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Không tìm thấy đơn hàng tương ứng với lệnh sản xuất.';
    END IF;

    UPDATE public.orders
    SET order_status = 'READY_FOR_INSTALL',
        updated_at = v_timestamp
    WHERE company_id = p_company_id AND id = v_prod.order_id;
  END IF;

  -- 6. Ghi audit_logs (Bắt buộc fail-closed trong transaction)
  INSERT INTO public.audit_logs (
    company_id,
    user_id,
    action,
    resource_type,
    resource_id,
    result,
    metadata
  ) VALUES (
    p_company_id,
    p_inspector_id,
    'RECORD_QUALITY_CHECK',
    'production_orders',
    p_production_order_id,
    'SUCCESS',
    jsonb_build_object(
      'from_status', v_prod.status,
      'to_status', v_next_status,
      'qc_status', v_db_qc_status,
      'actor_id', p_inspector_id,
      'notes', p_notes
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'production_order_id', p_production_order_id,
    'status', v_next_status,
    'qc_status', v_db_qc_status
  );
END;
$$;

COMMENT ON FUNCTION public.record_quality_check_atomic(uuid, uuid, text, uuid, text)
  IS 'Trusted server RPC: Kiểm tra chất lượng QC xưởng nguyên tử (Postgres Transaction). Strictly restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_quality_check_atomic(uuid, uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_quality_check_atomic(uuid, uuid, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_quality_check_atomic(uuid, uuid, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_quality_check_atomic(uuid, uuid, text, uuid, text) TO service_role;
