-- ==============================================================================
-- Migration: 20261004180001_installation_product_journey.sql
-- Description: Full product journey for Installation Scheduling & Technician Lifecycle
-- - Atomic schedule creation (Appointment ASSIGNED + Installation SCHEDULED)
-- - Technician appointment acceptance (ASSIGNED -> ACCEPTED)
-- - Work commencement lifecycle (ACCEPTED -> IN_PROGRESS)
-- - Atomic completion (Installation COMPLETED + Order COMPLETED + Appointment COMPLETED)
-- - Strictly restricted to service_role with operations_actor role checks
-- ==============================================================================

-- 1. Atomic Installation Schedule Creation RPC
-- Atomically creates INSTALLATION appointment (ASSIGNED) and Installation (SCHEDULED) in 1 locked transaction.
CREATE OR REPLACE FUNCTION public.create_installation_schedule_atomic(
  p_company_id uuid,
  p_order_id uuid,
  p_actor_id uuid,
  p_technician_id uuid,
  p_start_time timestamptz,
  p_address text,
  p_crew jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  p public.production_orders;
  o public.orders;
  i public.installations;
  a public.appointments;
  v_address text;
BEGIN
  -- 1. Authorize ACTIVE BOSS_ADMIN in the target company
  PERFORM public.operations_actor(p_company_id, p_actor_id, ARRAY['BOSS_ADMIN']);

  -- 2. Validate target technician: ACTIVE UserProfile, ACTIVE membership, role TECHNICIAN, same company
  PERFORM public.operations_actor(p_company_id, p_technician_id, ARRAY['TECHNICIAN']);

  -- 3. Input validation
  IF p_start_time IS NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT: Thời gian bắt đầu lắp đặt không được để trống.';
  END IF;

  v_address := NULLIF(btrim(p_address), '');
  IF v_address IS NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT: Địa chỉ lắp đặt không được để trống.';
  END IF;

  IF p_crew IS NULL OR jsonb_typeof(p_crew) <> 'array' OR jsonb_array_length(p_crew) = 0 THEN
    RAISE EXCEPTION 'INVALID_INPUT: Danh sách đội thợ (crew) phải có ít nhất 1 người.';
  END IF;

  -- 4. Lock ProductionOrder and Order (match QC lock order: production_orders -> orders)
  SELECT * INTO p FROM public.production_orders
  WHERE company_id = p_company_id AND order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  SELECT * INTO o FROM public.orders
  WHERE company_id = p_company_id AND id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  -- 5. Idempotency & Concurrency: Check if an installation already exists for this order
  SELECT * INTO i FROM public.installations
  WHERE company_id = p_company_id AND order_id = o.id
  FOR UPDATE;

  IF FOUND THEN
    SELECT * INTO a FROM public.appointments
    WHERE company_id = p_company_id AND id = i.appointment_id
    FOR UPDATE;

    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'installation', to_jsonb(i),
      'appointment', to_jsonb(a)
    );
  END IF;

  -- 6. Confirm states: ProductionOrder READY_FOR_DISPATCH & PASSED, Order READY_FOR_INSTALL
  IF p.status <> 'READY_FOR_DISPATCH' OR p.qc_status <> 'PASSED' OR o.order_status <> 'READY_FOR_INSTALL' THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
  END IF;

  -- 7. Create Appointment: type = INSTALLATION, status = ASSIGNED
  INSERT INTO public.appointments (
    company_id,
    customer_id,
    type,
    start_time,
    assignee_id,
    address,
    status
  ) VALUES (
    p_company_id,
    o.customer_id,
    'INSTALLATION',
    p_start_time,
    p_technician_id,
    v_address,
    'ASSIGNED'
  ) RETURNING * INTO a;

  -- 8. Create Installation: status = SCHEDULED
  INSERT INTO public.installations (
    company_id,
    customer_id,
    order_id,
    appointment_id,
    crew,
    status
  ) VALUES (
    p_company_id,
    o.customer_id,
    o.id,
    a.id,
    p_crew,
    'SCHEDULED'
  ) RETURNING * INTO i;

  -- 9. Append-only audit record
  PERFORM public.operations_audit(
    p_company_id,
    p_actor_id,
    'SCHEDULE_INSTALLATION',
    'installations',
    i.id,
    jsonb_build_object(
      'order_id', o.id,
      'appointment_id', a.id,
      'technician_id', p_technician_id,
      'start_time', p_start_time
    )
  );

  -- 10. Commit all-or-nothing
  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'installation', to_jsonb(i),
    'appointment', to_jsonb(a)
  );
END;
$$;

-- 2. Technician Appointment Acceptance RPC
-- Only the exact assigned ACTIVE TECHNICIAN may accept their appointment (ASSIGNED -> ACCEPTED).
CREATE OR REPLACE FUNCTION public.accept_installation_appointment_atomic(
  p_company_id uuid,
  p_appointment_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a public.appointments;
  r text;
BEGIN
  -- 1. Authorize ACTIVE TECHNICIAN in target company
  r := public.operations_actor(p_company_id, p_actor_id, ARRAY['TECHNICIAN']);

  -- 2. Lock appointment
  SELECT * INTO a FROM public.appointments
  WHERE company_id = p_company_id AND id = p_appointment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  -- 3. Verify appointment type
  IF a.type <> 'INSTALLATION' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  -- 4. Only the exact assigned ACTIVE TECHNICIAN may accept it
  IF a.assignee_id <> p_actor_id THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  -- 5. Idempotent check
  IF a.status = 'ACCEPTED' THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true);
  END IF;

  IF a.status <> 'ASSIGNED' THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
  END IF;

  -- 6. Transition
  UPDATE public.appointments
  SET status = 'ACCEPTED',
      updated_at = now()
  WHERE id = a.id;

  -- 7. Audit log
  PERFORM public.operations_audit(
    p_company_id,
    p_actor_id,
    'ACCEPT_INSTALLATION_APPOINTMENT',
    'appointments',
    a.id,
    jsonb_build_object(
      'from_status', 'ASSIGNED',
      'to_status', 'ACCEPTED'
    )
  );

  RETURN jsonb_build_object('success', true, 'idempotent', false);
END;
$$;

-- 3. Start Installation Work RPC
-- Advances appointment status: ACCEPTED -> IN_PROGRESS
CREATE OR REPLACE FUNCTION public.start_installation_work_atomic(
  p_company_id uuid,
  p_installation_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.installations;
  a public.appointments;
  r text;
BEGIN
  r := public.operations_actor(p_company_id, p_actor_id, ARRAY['TECHNICIAN']);

  SELECT * INTO i FROM public.installations
  WHERE company_id = p_company_id AND id = p_installation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  SELECT * INTO a FROM public.appointments
  WHERE company_id = p_company_id AND id = i.appointment_id
  FOR UPDATE;

  IF NOT FOUND OR a.type <> 'INSTALLATION' THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  IF a.assignee_id <> p_actor_id THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  IF a.status = 'IN_PROGRESS' THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true);
  END IF;

  IF a.status <> 'ACCEPTED' THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
  END IF;

  UPDATE public.appointments
  SET status = 'IN_PROGRESS',
      updated_at = now()
  WHERE id = a.id;

  PERFORM public.operations_audit(
    p_company_id,
    p_actor_id,
    'START_INSTALLATION_WORK',
    'appointments',
    a.id,
    jsonb_build_object('installation_id', i.id, 'from_status', 'ACCEPTED', 'to_status', 'IN_PROGRESS')
  );

  RETURN jsonb_build_object('success', true, 'idempotent', false);
END;
$$;

-- 4. Mutate Installation Atomic RPC
-- Enforces appointment lifecycle: ACCEPTED/IN_PROGRESS required. First mutation promotes ACCEPTED -> IN_PROGRESS.
CREATE OR REPLACE FUNCTION public.mutate_installation_atomic(
  p_company_id uuid,
  p_installation_id uuid,
  p_actor_id uuid,
  p_status text DEFAULT NULL,
  p_ref text DEFAULT NULL,
  p_type text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.installations;
  a public.appointments;
  r text;
  allowed jsonb := '{"SCHEDULED":["IN_TRANSIT","INSTALLING","FAILED"],"IN_TRANSIT":["INSTALLING","FAILED"],"INSTALLING":["TESTING","HANDOVER_PENDING","FAILED"],"TESTING":["HANDOVER_PENDING","INSTALLING","FAILED"],"HANDOVER_PENDING":["TESTING","INSTALLING","FAILED"],"FAILED":["SCHEDULED","IN_TRANSIT","INSTALLING"]}';
BEGIN
  r := public.operations_actor(p_company_id, p_actor_id, ARRAY['BOSS_ADMIN','TECHNICIAN']);
  SELECT * INTO i FROM public.installations WHERE company_id = p_company_id AND id = p_installation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;

  SELECT * INTO a FROM public.appointments WHERE company_id = p_company_id AND id = i.appointment_id FOR UPDATE;
  IF NOT FOUND OR a.customer_id <> i.customer_id OR a.type <> 'INSTALLATION' THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;

  IF r = 'TECHNICIAN' AND a.assignee_id <> p_actor_id THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;

  IF i.status = 'COMPLETED' OR a.status NOT IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
  END IF;

  IF p_ref IS NOT NULL THEN
    IF NOT public.operations_evidence_ref(p_company_id, i.id, p_ref, p_type) THEN
      RAISE EXCEPTION 'INVALID_STORAGE_REF';
    END IF;
    UPDATE public.installations
    SET photos = CASE WHEN p_type = 'photo' AND NOT(photos ? p_ref) THEN photos || jsonb_build_array(p_ref) ELSE photos END,
        handover_ref = CASE WHEN p_type = 'handover' THEN p_ref ELSE handover_ref END,
        updated_at = now()
    WHERE id = i.id;
  ELSE
    IF NOT COALESCE((allowed->i.status) ? p_status, false) THEN
      RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
    END IF;

    -- Technician must accept job before mutating installation progress
    IF a.status = 'ASSIGNED' THEN
      RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
    END IF;

    -- When appointment is ACCEPTED and field work mutates, promote appointment -> IN_PROGRESS
    IF a.status = 'ACCEPTED' THEN
      UPDATE public.appointments SET status = 'IN_PROGRESS', updated_at = now() WHERE id = a.id;
    END IF;

    -- If installation enters INSTALLING, advance order_status to INSTALLING if it was READY_FOR_INSTALL
    IF p_status = 'INSTALLING' THEN
      UPDATE public.orders SET order_status = 'INSTALLING', updated_at = now()
      WHERE company_id = p_company_id AND id = i.order_id AND order_status = 'READY_FOR_INSTALL';
    END IF;

    UPDATE public.installations SET status = p_status, updated_at = now() WHERE id = i.id;
  END IF;

  PERFORM public.operations_audit(
    p_company_id,
    p_actor_id,
    'UPDATE_INSTALLATION',
    'installations',
    i.id,
    jsonb_build_object('to_status', p_status, 'evidence_type', p_type)
  );
END;
$$;

-- 5. Complete Installation Atomic RPC
-- Atomically completes: Installation -> COMPLETED, Order -> COMPLETED, Appointment -> COMPLETED.
CREATE OR REPLACE FUNCTION public.complete_installation_atomic(
  p_company_id uuid,
  p_installation_id uuid,
  p_actor_id uuid,
  p_verified_photos jsonb,
  p_verified_handover text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.installations;
  o public.orders;
  a public.appointments;
  r text;
  ref text;
BEGIN
  r := public.operations_actor(p_company_id, p_actor_id, ARRAY['BOSS_ADMIN','TECHNICIAN']);
  SELECT * INTO i FROM public.installations WHERE company_id = p_company_id AND id = p_installation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;

  SELECT * INTO o FROM public.orders WHERE company_id = p_company_id AND id = i.order_id FOR UPDATE;
  IF NOT FOUND OR o.customer_id <> i.customer_id THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;

  SELECT * INTO a FROM public.appointments WHERE company_id = p_company_id AND id = i.appointment_id FOR UPDATE;
  IF NOT FOUND OR a.customer_id <> i.customer_id OR a.type <> 'INSTALLATION' THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;

  IF r = 'TECHNICIAN' AND a.assignee_id <> p_actor_id THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;

  -- Idempotency check: if all are already completed
  IF i.status = 'COMPLETED' AND o.order_status = 'COMPLETED' THEN
    IF a.status <> 'COMPLETED' THEN
      UPDATE public.appointments SET status = 'COMPLETED', updated_at = now() WHERE id = a.id;
    END IF;
    RETURN jsonb_build_object('success', true, 'idempotent', true);
  END IF;

  -- Predecessor checks: installation HANDOVER_PENDING, order in READY_FOR_INSTALL/INSTALLING, appointment in ACCEPTED/IN_PROGRESS
  IF i.status <> 'HANDOVER_PENDING' OR o.order_status NOT IN ('READY_FOR_INSTALL','INSTALLING') OR a.status NOT IN ('ACCEPTED','IN_PROGRESS') THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
  END IF;

  -- Mandatory evidence checks
  IF jsonb_typeof(i.photos) <> 'array' OR jsonb_array_length(i.photos) = 0 OR NULLIF(btrim(i.handover_ref), '') IS NULL THEN
    RAISE EXCEPTION 'MISSING_EVIDENCE';
  END IF;

  IF i.photos IS DISTINCT FROM p_verified_photos OR i.handover_ref IS DISTINCT FROM p_verified_handover THEN
    RAISE EXCEPTION 'EVIDENCE_CHANGED';
  END IF;

  FOR ref IN SELECT jsonb_array_elements_text(i.photos) LOOP
    IF NOT public.operations_evidence_ref(p_company_id, i.id, ref, 'photo') THEN
      RAISE EXCEPTION 'INVALID_STORAGE_REF';
    END IF;
  END LOOP;

  IF NOT public.operations_evidence_ref(p_company_id, i.id, i.handover_ref, 'handover') THEN
    RAISE EXCEPTION 'INVALID_STORAGE_REF';
  END IF;

  -- Update all 3 records atomically in one transaction
  UPDATE public.installations SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = i.id;
  UPDATE public.orders SET order_status = 'COMPLETED', updated_at = now() WHERE id = o.id;
  UPDATE public.appointments SET status = 'COMPLETED', updated_at = now() WHERE id = a.id;

  PERFORM public.operations_audit(
    p_company_id,
    p_actor_id,
    'COMPLETE_INSTALLATION_AND_HANDOVER',
    'installations',
    i.id,
    jsonb_build_object('order_id', o.id, 'appointment_id', a.id)
  );

  INSERT INTO public.operations_outbox (company_id, order_id, event_type, payload)
  VALUES (p_company_id, o.id, 'ORDER_COMPLETED', jsonb_build_object('installation_id', i.id, 'completed_at', now()))
  ON CONFLICT (company_id, order_id, event_type) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'idempotent', false);
END;
$$;

-- 6. Apply strictly fail-closed security grants
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
 ('create_installation_schedule_atomic','accept_installation_appointment_atomic','start_installation_work_atomic','mutate_installation_atomic','complete_installation_atomic') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
