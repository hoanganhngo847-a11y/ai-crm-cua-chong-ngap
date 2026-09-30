-- ==============================================================================
-- P1 BACKEND SECURITY & WORKFLOW REMEDIATION
-- Migration: 20260930120001_p1_backend_remediation.sql
--
-- Remediations:
-- 1. P1-001: Drop obsolete one-argument public.claim_voice_media_jobs(integer)
--    overload. Retain strictly canonical leased claim primitive
--    claim_voice_media_jobs(integer, text, integer) for service_role only.
-- 2. P1-002: Hardened create_production_order_atomic: require non-empty specs/materials,
--    validate against authoritative price_calculations and surveys records,
--    reject arbitrary client-only keys, prevent client-authoritative override of technical specifications.
-- 3. P1-003: Atomic audited create_warranty_ticket_atomic RPC: validate actor
--    (BOSS_ADMIN, SALE), active membership, tenant isolation, COMPLETED order status,
--    installation binding without cross-tenant fallback, and atomic audit logging.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. P1-001: DROP OBSOLETE VOICE MEDIA JOB CLAIM OVERLOAD
-- ------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.claim_voice_media_jobs(integer);

-- Re-affirm strict service_role ACL on canonical leased overload
REVOKE ALL ON FUNCTION public.claim_voice_media_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voice_media_jobs(integer, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.complete_voice_media_job(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_voice_media_job(uuid, uuid, uuid) TO service_role;

-- ------------------------------------------------------------------------------
-- 2. P1-002: CANONICAL PRODUCTION SPECIFICATIONS & MATERIALS DERIVATION
-- ------------------------------------------------------------------------------

-- Ensure any legacy default materials triggers or functions are completely removed.
-- Manufacturing business facts must NOT be guessed, invented, or defaulted.
DROP TRIGGER IF EXISTS trg_pricing_policies_default_materials ON public.pricing_policies;
DROP FUNCTION IF EXISTS public.set_default_pricing_policy_materials();

CREATE OR REPLACE FUNCTION public.create_production_order_atomic(
  p_company_id uuid,
  p_order_id uuid,
  p_actor_id uuid,
  p_specs jsonb,
  p_materials jsonb,
  p_deadline timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  o public.orders;
  c public.contracts;
  p public.production_orders;
  pc public.price_calculations;
  pp public.pricing_policies;
  s public.surveys;
  v_canonical_specs jsonb;
  v_canonical_materials jsonb;
  v_final_specs jsonb;
  v_final_materials jsonb;
  v_canonical_dim text;
  v_cw_mm numeric;
  v_bh_mm numeric;
  v_w numeric;
  v_h numeric;
  v_key text;
BEGIN
  -- 1. Validate actor: BOSS_ADMIN only
  PERFORM public.operations_actor(p_company_id, p_actor_id, ARRAY['BOSS_ADMIN']);

  -- 2. Reject empty or null client specs / materials
  IF p_specs IS NULL OR jsonb_typeof(p_specs) = 'null' OR p_specs = '{}'::jsonb
     OR p_materials IS NULL OR jsonb_typeof(p_materials) = 'null' OR p_materials = '{}'::jsonb THEN
    RAISE EXCEPTION 'INVALID_TECHNICAL_INPUT';
  END IF;

  -- 3. Reject arbitrary client-only specs keys (must be domain-recognized technical fields or notes)
  FOR v_key IN SELECT jsonb_object_keys(p_specs) LOOP
    IF v_key NOT IN (
      'dimensions', 'clear_width_mm', 'barrier_height_mm', 'width', 'height',
      'gate_type', 'mounting_method', 'thickness_mm', 'tolerance_mm', 'notes'
    ) THEN
      RAISE EXCEPTION 'INVALID_TECHNICAL_INPUT';
    END IF;
  END LOOP;

  -- 4. Reject arbitrary client-only materials keys (must be domain-recognized material specifications)
  FOR v_key IN SELECT jsonb_object_keys(p_materials) LOOP
    IF v_key NOT IN (
      'aluminum', 'inox', 'steel', 'gasket', 'seal', 'profile', 'panel', 'frame', 'hardware', 'fasteners'
    ) THEN
      RAISE EXCEPTION 'INVALID_TECHNICAL_INPUT';
    END IF;
    -- Material value must not be empty or blank string
    IF NULLIF(btrim(p_materials->>v_key), '') IS NULL THEN
      RAISE EXCEPTION 'INVALID_TECHNICAL_INPUT';
    END IF;
  END LOOP;

  -- 5. Fetch order with row lock
  SELECT * INTO o FROM public.orders WHERE company_id = p_company_id AND id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  IF o.order_status NOT IN ('CONTRACT_SIGNED', 'DEPOSIT_CONFIRMED') THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
  END IF;

  -- 6. Contract gate: valid signed contract required
  SELECT * INTO c FROM public.contracts
  WHERE company_id = p_company_id AND order_id = o.id AND is_current FOR UPDATE;
  IF NOT FOUND OR c.status <> 'SIGNED' OR NULLIF(btrim(c.signed_file_ref), '') IS NULL THEN
    RAISE EXCEPTION 'CONTRACT_NOT_SIGNED';
  END IF;

  -- 7. Prevent duplicate production order
  IF EXISTS(SELECT 1 FROM public.production_orders WHERE order_id = o.id) THEN
    RAISE EXCEPTION 'PRODUCTION_ALREADY_EXISTS';
  END IF;

  -- 8. Fetch authoritative price calculation record
  SELECT * INTO pc FROM public.price_calculations
  WHERE id = o.price_calculation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  -- Multi-tenant and customer boundary validation
  IF pc.company_id <> p_company_id THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  IF pc.customer_id <> o.customer_id THEN
    RAISE EXCEPTION 'MISMATCHED_CUSTOMER_REFERENCE';
  END IF;

  -- Check calculation status: fail closed if input missing or incomplete
  IF pc.status = 'NEED_INFO' THEN
    RAISE EXCEPTION 'Cannot release to production: missing canonical dimensions or barrier type'
      USING ERRCODE = 'NEED_INFO';
  END IF;
  IF pc.status <> 'CALCULATED' THEN
    RAISE EXCEPTION 'INVALID_TECHNICAL_INPUT';
  END IF;
  IF pc.input_data IS NULL OR pc.input_data = '{}'::jsonb THEN
    RAISE EXCEPTION 'INVALID_TECHNICAL_INPUT';
  END IF;

  -- 9. Fetch and validate authoritative pricing policy
  SELECT * INTO pp FROM public.pricing_policies
  WHERE id = pc.pricing_policy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;
  IF pp.company_id <> p_company_id THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  -- 10. Validate survey if bound to calculation
  IF pc.survey_id IS NOT NULL THEN
    SELECT * INTO s FROM public.surveys
    WHERE id = pc.survey_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
    END IF;
    IF s.company_id <> p_company_id THEN
      RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF s.customer_id <> o.customer_id THEN
      RAISE EXCEPTION 'MISMATCHED_CUSTOMER_REFERENCE';
    END IF;
    IF s.measurements IS NULL OR s.measurements = '{}'::jsonb THEN
      RAISE EXCEPTION 'INVALID_TECHNICAL_INPUT';
    END IF;
  END IF;

  -- 11. Derive authoritative canonical materials from persisted records
  IF s.id IS NOT NULL AND jsonb_typeof(s.measurements->'materials') = 'object' AND s.measurements->'materials' <> '{}'::jsonb THEN
    v_canonical_materials := s.measurements->'materials';
  ELSIF jsonb_typeof(pc.input_data->'materials') = 'object' AND pc.input_data->'materials' <> '{}'::jsonb THEN
    v_canonical_materials := pc.input_data->'materials';
  ELSIF jsonb_typeof(pp.conditions->'materials') = 'object' AND pp.conditions->'materials' <> '{}'::jsonb THEN
    v_canonical_materials := pp.conditions->'materials';
  ELSIF jsonb_typeof(pp.conditions->'standard_materials') = 'object' AND pp.conditions->'standard_materials' <> '{}'::jsonb THEN
    v_canonical_materials := pp.conditions->'standard_materials';
  ELSIF jsonb_typeof(pp.price_rules->'materials') = 'object' AND pp.price_rules->'materials' <> '{}'::jsonb THEN
    v_canonical_materials := pp.price_rules->'materials';
  ELSIF jsonb_typeof(pp.price_rules->'standard_materials') = 'object' AND pp.price_rules->'standard_materials' <> '{}'::jsonb THEN
    v_canonical_materials := pp.price_rules->'standard_materials';
  ELSE
    v_canonical_materials := NULL;
  END IF;

  -- Fail-closed if authoritative materials are missing
  IF v_canonical_materials IS NULL OR jsonb_typeof(v_canonical_materials) = 'null' OR v_canonical_materials = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot release to production: canonical materials specification is missing'
      USING ERRCODE = 'INVALID_TECHNICAL_INPUT';
  END IF;

  -- Detect and reject material tampering / client forgery
  FOR v_key IN SELECT jsonb_object_keys(p_materials) LOOP
    IF v_canonical_materials ? v_key THEN
      IF (p_materials->>v_key) <> (v_canonical_materials->>v_key) THEN
        RAISE EXCEPTION 'Production order material specification cannot contradict canonical policy/survey materials'
          USING ERRCODE = 'INVALID_TECHNICAL_INPUT';
      END IF;
    END IF;
  END LOOP;

  -- Client materials are NOT authoritative; canonical materials are strictly persisted
  v_final_materials := v_canonical_materials;

  -- 12. Derive authoritative canonical specifications (server-authoritative; client cannot override)
  IF s.id IS NOT NULL THEN
    v_cw_mm := NULLIF(s.measurements->>'clear_width_mm', '')::numeric;
    v_bh_mm := NULLIF(s.measurements->>'barrier_height_mm', '')::numeric;
    IF v_cw_mm IS NULL OR v_bh_mm IS NULL OR v_cw_mm <= 0 OR v_bh_mm <= 0 THEN
      RAISE EXCEPTION 'Cannot release to production: missing canonical dimensions or barrier type'
        USING ERRCODE = 'NEED_INFO';
    END IF;
    v_canonical_dim := v_cw_mm::text || 'x' || v_bh_mm::text || 'mm';
    v_canonical_specs := jsonb_build_object(
      'dimensions', v_canonical_dim,
      'canonical_dimensions', v_canonical_dim,
      'canonical_source', 'SURVEY',
      'calculation_id', pc.id,
      'survey_id', s.id,
      'clear_width_mm', v_cw_mm,
      'barrier_height_mm', v_bh_mm
    );
    IF s.measurements ? 'gate_type' AND NULLIF(btrim(s.measurements->>'gate_type'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('gate_type', s.measurements->>'gate_type');
    ELSIF pc.input_data ? 'gate_type' AND NULLIF(btrim(pc.input_data->>'gate_type'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('gate_type', pc.input_data->>'gate_type');
    END IF;
    IF s.measurements ? 'mounting_method' AND NULLIF(btrim(s.measurements->>'mounting_method'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('mounting_method', s.measurements->>'mounting_method');
    ELSIF pc.input_data ? 'mounting_method' AND NULLIF(btrim(pc.input_data->>'mounting_method'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('mounting_method', pc.input_data->>'mounting_method');
    END IF;
    -- Canonical thickness from survey -> calculation -> policy
    IF s.measurements ? 'thickness_mm' AND NULLIF(btrim(s.measurements->>'thickness_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('thickness_mm', (s.measurements->>'thickness_mm')::numeric);
    ELSIF pc.input_data ? 'thickness_mm' AND NULLIF(btrim(pc.input_data->>'thickness_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('thickness_mm', (pc.input_data->>'thickness_mm')::numeric);
    ELSIF pp.conditions ? 'thickness_mm' AND NULLIF(btrim(pp.conditions->>'thickness_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('thickness_mm', (pp.conditions->>'thickness_mm')::numeric);
    END IF;
    -- Canonical tolerance from survey -> calculation -> policy
    IF s.measurements ? 'tolerance_mm' AND NULLIF(btrim(s.measurements->>'tolerance_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('tolerance_mm', (s.measurements->>'tolerance_mm')::numeric);
    ELSIF pc.input_data ? 'tolerance_mm' AND NULLIF(btrim(pc.input_data->>'tolerance_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('tolerance_mm', (pc.input_data->>'tolerance_mm')::numeric);
    ELSIF pp.conditions ? 'tolerance_mm' AND NULLIF(btrim(pp.conditions->>'tolerance_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('tolerance_mm', (pp.conditions->>'tolerance_mm')::numeric);
    END IF;
  ELSE
    v_w := NULLIF(pc.input_data->>'width', '')::numeric;
    v_h := NULLIF(pc.input_data->>'height', '')::numeric;
    v_cw_mm := NULLIF(pc.input_data->>'clear_width_mm', '')::numeric;
    v_bh_mm := NULLIF(pc.input_data->>'barrier_height_mm', '')::numeric;

    IF v_w IS NOT NULL AND v_h IS NOT NULL AND v_w > 0 AND v_h > 0 THEN
      v_canonical_dim := (round(v_w * 100)::text || 'x' || round(v_h * 100)::text || 'cm');
      v_canonical_specs := jsonb_build_object(
        'dimensions', v_canonical_dim,
        'canonical_dimensions', v_canonical_dim,
        'canonical_source', 'PRICE_CALCULATION',
        'calculation_id', pc.id,
        'width', v_w,
        'height', v_h
      );
    ELSIF v_cw_mm IS NOT NULL AND v_bh_mm IS NOT NULL AND v_cw_mm > 0 AND v_bh_mm > 0 THEN
      v_canonical_dim := (v_cw_mm::text || 'x' || v_bh_mm::text || 'mm');
      v_canonical_specs := jsonb_build_object(
        'dimensions', v_canonical_dim,
        'canonical_dimensions', v_canonical_dim,
        'canonical_source', 'PRICE_CALCULATION',
        'calculation_id', pc.id,
        'clear_width_mm', v_cw_mm,
        'barrier_height_mm', v_bh_mm
      );
    ELSIF pc.input_data ? 'dimensions' AND NULLIF(btrim(pc.input_data->>'dimensions'), '') IS NOT NULL THEN
      v_canonical_dim := pc.input_data->>'dimensions';
      v_canonical_specs := jsonb_build_object(
        'dimensions', v_canonical_dim,
        'canonical_dimensions', v_canonical_dim,
        'canonical_source', 'PRICE_CALCULATION',
        'calculation_id', pc.id
      );
    ELSE
      -- Incomplete or missing canonical technical input: fail closed
      RAISE EXCEPTION 'Cannot release to production: missing canonical dimensions or barrier type'
        USING ERRCODE = 'NEED_INFO';
    END IF;

    IF pc.input_data ? 'gate_type' AND NULLIF(btrim(pc.input_data->>'gate_type'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('gate_type', pc.input_data->>'gate_type');
    END IF;
    IF pc.input_data ? 'mounting_method' AND NULLIF(btrim(pc.input_data->>'mounting_method'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('mounting_method', pc.input_data->>'mounting_method');
    END IF;
    -- Canonical thickness from calculation -> policy
    IF pc.input_data ? 'thickness_mm' AND NULLIF(btrim(pc.input_data->>'thickness_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('thickness_mm', (pc.input_data->>'thickness_mm')::numeric);
    ELSIF pp.conditions ? 'thickness_mm' AND NULLIF(btrim(pp.conditions->>'thickness_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('thickness_mm', (pp.conditions->>'thickness_mm')::numeric);
    END IF;
    -- Canonical tolerance from calculation -> policy
    IF pc.input_data ? 'tolerance_mm' AND NULLIF(btrim(pc.input_data->>'tolerance_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('tolerance_mm', (pc.input_data->>'tolerance_mm')::numeric);
    ELSIF pp.conditions ? 'tolerance_mm' AND NULLIF(btrim(pp.conditions->>'tolerance_mm'), '') IS NOT NULL THEN
      v_canonical_specs := v_canonical_specs || jsonb_build_object('tolerance_mm', (pp.conditions->>'tolerance_mm')::numeric);
    END IF;
  END IF;

  -- Technical specifications are strictly server-authoritative.
  -- Every technical field must come from an authoritative persisted source.
  -- Client cannot inject or override technical facts (dimensions, thickness_mm, tolerance_mm, width, height, gate_type, mounting_method).
  -- Only non-technical operational note is accepted from client input (bounded to 1000 characters).
  v_final_specs := v_canonical_specs;
  IF p_specs ? 'notes' AND NULLIF(btrim(p_specs->>'notes'), '') IS NOT NULL THEN
    v_final_specs := v_final_specs || jsonb_build_object('notes', left(btrim(p_specs->>'notes'), 1000));
  END IF;

  -- 12. Insert production order
  INSERT INTO public.production_orders(
    company_id,
    order_id,
    specs,
    materials,
    status,
    deadline,
    qc_status
  ) VALUES (
    p_company_id,
    o.id,
    v_final_specs,
    v_final_materials,
    'RELEASED_TO_FACTORY',
    p_deadline,
    'PENDING'
  ) RETURNING * INTO p;

  -- 13. Advance order status
  UPDATE public.orders SET order_status = 'IN_PRODUCTION', updated_at = now() WHERE id = o.id;

  -- 14. Audit log
  PERFORM public.operations_audit(
    p_company_id,
    p_actor_id,
    'CREATE_PRODUCTION_ORDER',
    'production_orders',
    p.id,
    jsonb_build_object('order_id', o.id)
  );

  RETURN to_jsonb(p);
END;
$$;

-- ------------------------------------------------------------------------------
-- 3. P1-003: ATOMIC AUDITED WARRANTY TICKET CREATION RPC
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_warranty_ticket_atomic(
  p_company_id uuid,
  p_actor_id uuid,
  p_customer_id uuid,
  p_order_id uuid,
  p_installation_id uuid DEFAULT NULL,
  p_issue text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_cust public.customers;
  v_order public.orders;
  v_inst public.installations;
  v_derived_inst_id uuid := NULL;
  v_ticket public.warranty_tickets;
  v_existing_id uuid;
BEGIN
  -- 1. Validate actor: BOSS_ADMIN or SALE required, active membership and active user profile
  v_role := public.operations_actor(p_company_id, p_actor_id, ARRAY['BOSS_ADMIN', 'SALE']);

  -- 2. Validate issue description
  IF NULLIF(btrim(p_issue), '') IS NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  -- 3. Check idempotency if key provided
  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT resource_id INTO v_existing_id
    FROM public.audit_logs
    WHERE company_id = p_company_id
      AND action = 'CREATE_WARRANTY_TICKET'
      AND metadata->>'idempotency_key' = p_idempotency_key
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT * INTO v_ticket FROM public.warranty_tickets
      WHERE id = v_existing_id AND company_id = p_company_id;
      IF FOUND THEN
        RETURN to_jsonb(v_ticket);
      END IF;
    END IF;
  END IF;

  -- 4. Validate customer belongs to company
  SELECT * INTO v_cust FROM public.customers
  WHERE company_id = p_company_id AND id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  -- 5. Validate order belongs to company and customer
  SELECT * INTO v_order FROM public.orders
  WHERE company_id = p_company_id AND customer_id = p_customer_id AND id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
  END IF;

  -- 6. Require order status COMPLETED
  IF v_order.order_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION';
  END IF;

  -- 7. Validate or derive installation belonging strictly to this company, customer, and order
  IF p_installation_id IS NOT NULL THEN
    SELECT * INTO v_inst FROM public.installations
    WHERE company_id = p_company_id AND customer_id = p_customer_id AND order_id = p_order_id AND id = p_installation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESOURCE_NOT_FOUND';
    END IF;
    v_derived_inst_id := v_inst.id;
  ELSE
    SELECT id INTO v_derived_inst_id FROM public.installations
    WHERE company_id = p_company_id AND customer_id = p_customer_id AND order_id = p_order_id
    ORDER BY created_at DESC LIMIT 1;
  END IF;

  -- 8. Insert warranty ticket
  INSERT INTO public.warranty_tickets (
    company_id,
    customer_id,
    order_id,
    installation_id,
    issue,
    status,
    assigned_to,
    notes,
    opened_at
  ) VALUES (
    p_company_id,
    p_customer_id,
    p_order_id,
    v_derived_inst_id,
    btrim(p_issue),
    'OPEN',
    NULL,
    p_notes,
    now()
  ) RETURNING * INTO v_ticket;

  -- 9. Insert audit log atomically in the same transaction
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
    'CREATE_WARRANTY_TICKET',
    'warranty_tickets',
    v_ticket.id,
    p_customer_id,
    'SUCCESS',
    jsonb_build_object(
      'order_id', p_order_id,
      'installation_id', v_derived_inst_id,
      'idempotency_key', p_idempotency_key
    )
  );

  RETURN to_jsonb(v_ticket);
END;
$$;

-- ------------------------------------------------------------------------------
-- 4. ACL ENFORCEMENT FOR NEW / UPDATED RPCs (SERVICE_ROLE ONLY)
-- ------------------------------------------------------------------------------

DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT oid::regprocedure FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN (
        'create_production_order_atomic',
        'create_warranty_ticket_atomic'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
