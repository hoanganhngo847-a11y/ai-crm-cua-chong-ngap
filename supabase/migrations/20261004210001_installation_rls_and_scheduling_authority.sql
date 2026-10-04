-- ==============================================================================
-- Migration: 20261004210001_installation_rls_and_scheduling_authority.sql
-- Description:
-- 1. Tighten RLS on public.appointments: authenticated direct writes (INSERT/UPDATE)
--    restricted strictly to type = 'SURVEY'. Direct writes to type = 'INSTALLATION' fail closed.
-- 2. Drop obsolete legacy split scheduling RPC: public.schedule_installation_atomic
-- 3. Idempotent scheduling payload mismatch verification in create_installation_schedule_atomic:
--    Raises INSTALLATION_SCHEDULE_ALREADY_EXISTS_WITH_DIFFERENT_PAYLOAD on mismatch.
-- 4. Tighten mutate_installation_atomic: evidence upload and progress mutation strictly
--    require appointment status in ('ACCEPTED', 'IN_PROGRESS'). ASSIGNED rejected.
-- ==============================================================================

-- 1. Appointments RLS Hardening: Restrict authenticated direct writes strictly to SURVEY
DROP POLICY IF EXISTS appointments_insert_boss_admin ON public.appointments;
CREATE POLICY appointments_insert_boss_admin
  ON public.appointments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    type = 'SURVEY'
    AND public.has_company_role(company_id, 'BOSS_ADMIN')
  );

DROP POLICY IF EXISTS appointments_insert_sale ON public.appointments;
CREATE POLICY appointments_insert_sale
  ON public.appointments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    type = 'SURVEY'
    AND public.has_company_role(company_id, 'SALE')
  );

DROP POLICY IF EXISTS appointments_update_boss_admin ON public.appointments;
CREATE POLICY appointments_update_boss_admin
  ON public.appointments
  FOR UPDATE
  TO authenticated
  USING (
    type = 'SURVEY'
    AND public.has_company_role(company_id, 'BOSS_ADMIN')
  )
  WITH CHECK (
    type = 'SURVEY'
    AND public.has_company_role(company_id, 'BOSS_ADMIN')
  );

DROP POLICY IF EXISTS appointments_update_sale ON public.appointments;
CREATE POLICY appointments_update_sale
  ON public.appointments
  FOR UPDATE
  TO authenticated
  USING (
    type = 'SURVEY'
    AND public.has_company_role(company_id, 'SALE')
  )
  WITH CHECK (
    type = 'SURVEY'
    AND public.has_company_role(company_id, 'SALE')
  );

-- 2. Retire legacy split installation scheduling RPC
DROP FUNCTION IF EXISTS public.schedule_installation_atomic(uuid, uuid, uuid, uuid, jsonb, uuid);
DROP FUNCTION IF EXISTS public.schedule_installation_atomic;

-- 3. Update create_installation_schedule_atomic with crew canonicalization & payload mismatch detection
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
  v_canonical_crew jsonb;
  v_existing_crew jsonb;
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

  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_crew) elem WHERE btrim(elem) = '') THEN
    RAISE EXCEPTION 'INVALID_INPUT: Tên thành viên đội thợ không được để trống.';
  END IF;

  -- Canonicalize crew: trim each member and sort alphabetically for deterministic comparison
  SELECT COALESCE(
    jsonb_agg(btrim(elem) ORDER BY btrim(elem)),
    '[]'::jsonb
  )
  INTO v_canonical_crew
  FROM jsonb_array_elements_text(p_crew) AS elem;

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

    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
    END IF;

    -- Canonicalize existing crew for comparison
    SELECT COALESCE(
      jsonb_agg(btrim(elem) ORDER BY btrim(elem)),
      '[]'::jsonb
    )
    INTO v_existing_crew
    FROM jsonb_array_elements_text(i.crew) AS elem;

    -- Strict logical payload mismatch check
    IF a.assignee_id <> p_technician_id
       OR a.start_time <> p_start_time
       OR btrim(a.address) <> v_address
       OR v_existing_crew <> v_canonical_crew THEN
      RAISE EXCEPTION 'INSTALLATION_SCHEDULE_ALREADY_EXISTS_WITH_DIFFERENT_PAYLOAD';
    END IF;

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

  -- 8. Create Installation: status = SCHEDULED, storing canonical crew
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
    v_canonical_crew,
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

-- 4. Tighten mutate_installation_atomic: ACCEPTED or IN_PROGRESS strictly required for all mutations
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

  -- Require ACCEPTED or IN_PROGRESS appointment for both evidence upload and progress mutation.
  -- ASSIGNED appointment cannot upload evidence or mutate installation progress.
  IF i.status = 'COMPLETED' OR a.status NOT IN ('ACCEPTED', 'IN_PROGRESS') THEN
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

-- 5. Revoke execution permissions from public/anon/authenticated and grant to service_role
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
 ('create_installation_schedule_atomic','mutate_installation_atomic') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
