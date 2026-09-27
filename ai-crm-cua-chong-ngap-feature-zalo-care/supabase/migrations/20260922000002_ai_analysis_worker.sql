-- Migration 006: Secure AI Customer Analysis Core
-- Implements complete table ACL lockdown for public.ai_analyses to enforce RPC-only persistence,
-- bounded read RPC public.get_ai_analysis_input for service_role AI workers,
-- and bounded persist RPC public.record_ai_analysis with strict tenant isolation,
-- audit-safe source_refs validation, and zero customer stage mutation.

-- ------------------------------------------------------------------------------
-- 1. TABLE ACL LOCKDOWN (RPC-ONLY PERSISTENCE ARCHITECTURE)
-- ------------------------------------------------------------------------------
-- Revoke ALL direct table privileges from service_role.
-- Direct INSERT, UPDATE, DELETE are also revoked from PUBLIC, anon, authenticated.
-- Direct SELECT for authenticated users is governed by Foundation RLS policies (BOSS_ADMIN, SALE).
-- Only postgres superuser retains direct table mutation privileges.
REVOKE ALL ON TABLE public.ai_analyses FROM service_role;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.ai_analyses FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_analyses TO postgres;

-- ------------------------------------------------------------------------------
-- 2. BOUNDED READ RPC: public.get_ai_analysis_input
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ai_analysis_input(
  p_company_id uuid,
  p_customer_id uuid,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  interaction_id uuid,
  conversation_id uuid,
  channel text,
  direction text,
  actor_type text,
  sanitized_content text,
  created_at timestamptz,
  customer_id uuid,
  customer_code text,
  name text,
  source text,
  stage text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_company_id uuid;
  v_limit integer;
BEGIN
  -- 1. Verify customer existence
  SELECT c.company_id
  INTO v_customer_company_id
  FROM public.customers c
  WHERE c.id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 2. Verify customer tenant alignment (strict cross-tenant barrier)
  IF v_customer_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- 3. Validate bounded limit parameter (1 to 100)
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > 100) THEN
    RAISE EXCEPTION 'INVALID_LIMIT' USING ERRCODE = '22000';
  END IF;
  v_limit := COALESCE(p_limit, 50);

  -- 4. Return sanitized interactions with safe customer context
  -- STRICT ELIGIBILITY: type = 'MESSAGE' AND sanitization_status = 'SUCCEEDED' AND sanitized_content IS NOT NULL.
  -- LATEST-N SELECTION: Select newest N interactions first (ORDER BY created_at DESC, id DESC LIMIT v_limit),
  -- then reorder chronologically (ORDER BY created_at ASC, id ASC) so the model receives proper history flow.
  RETURN QUERY
  WITH latest_interactions AS (
    SELECT
      i.id AS interaction_id,
      i.conversation_id,
      i.channel,
      i.direction,
      i.actor_type,
      i.sanitized_content,
      i.created_at
    FROM public.interactions i
    WHERE i.company_id = p_company_id
      AND i.customer_id = p_customer_id
      AND i.type = 'MESSAGE'
      AND i.sanitization_status = 'SUCCEEDED'
      AND i.sanitized_content IS NOT NULL
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT v_limit
  )
  SELECT
    li.interaction_id,
    li.conversation_id,
    li.channel,
    li.direction,
    li.actor_type,
    li.sanitized_content,
    li.created_at,
    c.id AS customer_id,
    c.customer_code,
    c.name,
    c.source,
    c.stage
  FROM public.customers c
  JOIN latest_interactions li ON true
  WHERE c.id = p_customer_id
    AND c.company_id = p_company_id
  ORDER BY li.created_at ASC, li.interaction_id ASC;
END;
$$;

COMMENT ON FUNCTION public.get_ai_analysis_input(uuid, uuid, integer)
  IS 'Bounded read RPC returning safe sanitized customer MESSAGE interactions and metadata for AI analysis. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.get_ai_analysis_input(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_ai_analysis_input(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_ai_analysis_input(uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_analysis_input(uuid, uuid, integer) TO service_role;

-- ------------------------------------------------------------------------------
-- 3. BOUNDED PERSIST RPC: public.record_ai_analysis
-- ------------------------------------------------------------------------------
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
  p_model_version text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  customer_id uuid,
  source_refs jsonb,
  summary text,
  stage_suggestion text,
  stop_reason text,
  objections jsonb,
  next_action text,
  confidence numeric,
  evidence text,
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
  v_obj_text text;
  v_new_row public.ai_analyses%ROWTYPE;
BEGIN
  -- 1. Validate customer existence and tenant binding
  SELECT c.company_id
  INTO v_customer_company_id
  FROM public.customers c
  WHERE c.id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_customer_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate confidence (finite, 0.00 <= confidence <= 1.00)
  IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 THEN
    RAISE EXCEPTION 'INVALID_CONFIDENCE' USING ERRCODE = '22000';
  END IF;

  -- 3. Validate summary (non-empty, length <= 2000)
  IF p_summary IS NULL OR pg_catalog.btrim(p_summary) = '' THEN
    RAISE EXCEPTION 'EMPTY_SUMMARY' USING ERRCODE = '22000';
  END IF;
  IF pg_catalog.length(p_summary) > 2000 THEN
    RAISE EXCEPTION 'SUMMARY_TOO_LONG' USING ERRCODE = '22000';
  END IF;

  -- 4. Validate evidence (non-empty, length <= 5000)
  IF p_evidence IS NULL OR pg_catalog.btrim(p_evidence) = '' THEN
    RAISE EXCEPTION 'EMPTY_EVIDENCE' USING ERRCODE = '22000';
  END IF;
  IF pg_catalog.length(p_evidence) > 5000 THEN
    RAISE EXCEPTION 'EVIDENCE_TOO_LONG' USING ERRCODE = '22000';
  END IF;

  -- 5. Validate model_version (trusted provenance: non-empty, length <= 100)
  IF p_model_version IS NULL OR pg_catalog.btrim(p_model_version) = '' THEN
    RAISE EXCEPTION 'EMPTY_MODEL_VERSION' USING ERRCODE = '22000';
  END IF;
  IF pg_catalog.length(p_model_version) > 100 THEN
    RAISE EXCEPTION 'MODEL_VERSION_TOO_LONG' USING ERRCODE = '22000';
  END IF;

  -- 6. Validate stage_suggestion against canonical customer stage allowlist
  IF p_stage_suggestion IS NOT NULL THEN
    IF p_stage_suggestion NOT IN (
      'LEAD_NEW',
      'CONTACT_CYCLE_1',
      'CONTACT_CYCLE_2',
      'CONTACT_CYCLE_3',
      'UNREACHABLE',
      'SURVEY_REQUESTED',
      'SURVEY_SCHEDULED',
      'SURVEY_COMPLETED',
      'PRICE_CALCULATED',
      'NEED_INFO',
      'PRICE_OFFERED',
      'NEGOTIATING',
      'ORDER_CREATED',
      'DEPOSIT_CONFIRMED',
      'CONTRACT_SIGNED',
      'IN_PRODUCTION',
      'READY_FOR_INSTALL',
      'INSTALLING',
      'HANDOVER_COMPLETED',
      'WARRANTY_ACTIVE',
      'LOST',
      'CARE_NURTURING'
    ) THEN
      RAISE EXCEPTION 'INVALID_STAGE_SUGGESTION' USING ERRCODE = '22000';
    END IF;
  END IF;

  -- 7. Validate stop_reason and next_action lengths (<= 1000)
  IF p_stop_reason IS NOT NULL AND pg_catalog.length(p_stop_reason) > 1000 THEN
    RAISE EXCEPTION 'STOP_REASON_TOO_LONG' USING ERRCODE = '22000';
  END IF;
  IF p_next_action IS NOT NULL AND pg_catalog.length(p_next_action) > 1000 THEN
    RAISE EXCEPTION 'NEXT_ACTION_TOO_LONG' USING ERRCODE = '22000';
  END IF;

  -- 8. Validate objections JSONB array (<= 20 items, string, btrim != '', <= 500 chars)
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

  -- 9. Validate source_refs (audit-safe, tenant-bound, interaction references only)
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

    -- Security: Only type 'INTERACTION' is allowed. Forbid raw/private storage pointers.
    v_ref_type := v_elem->>'type';
    IF v_ref_type IS NULL OR v_ref_type <> 'INTERACTION' THEN
      RAISE EXCEPTION 'FORBIDDEN_SOURCE_REF_TYPE' USING ERRCODE = '22000';
    END IF;

    -- Security: Forbid storing sensitive payload keys inside source_refs
    IF v_elem ? 'content' OR v_elem ? 'phone' OR v_elem ? 'transcript'
       OR v_elem ? 'recording' OR v_elem ? 'raw_payload' OR v_elem ? 'token' THEN
      RAISE EXCEPTION 'SENSITIVE_DATA_IN_SOURCE_REF' USING ERRCODE = '22000';
    END IF;

    BEGIN
      v_ref_id := (v_elem->>'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'INVALID_SOURCE_REF_UUID' USING ERRCODE = '22000';
    END;

    IF v_ref_id IS NULL THEN
      RAISE EXCEPTION 'INVALID_SOURCE_REF_UUID' USING ERRCODE = '22000';
    END IF;

    -- Look up target interaction and enforce tenant, customer, MESSAGE type, and sanitization boundaries
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
  END LOOP;

  -- 10. Append-only INSERT into public.ai_analyses
  -- INVARIANT: customers.stage is NEVER mutated.
  -- INVARIANT: customer_stage_histories is NEVER inserted.
  -- INVARIANT: previous analyses are NEVER updated.
  INSERT INTO public.ai_analyses (
    company_id,
    customer_id,
    source_refs,
    summary,
    stage_suggestion,
    stop_reason,
    objections,
    next_action,
    confidence,
    evidence,
    model_version
  ) VALUES (
    p_company_id,
    p_customer_id,
    p_source_refs,
    p_summary,
    p_stage_suggestion,
    p_stop_reason,
    p_objections,
    p_next_action,
    p_confidence,
    p_evidence,
    p_model_version
  )
  RETURNING * INTO v_new_row;

  RETURN QUERY SELECT
    v_new_row.id,
    v_new_row.company_id,
    v_new_row.customer_id,
    v_new_row.source_refs,
    v_new_row.summary,
    v_new_row.stage_suggestion,
    v_new_row.stop_reason,
    v_new_row.objections,
    v_new_row.next_action,
    v_new_row.confidence,
    v_new_row.evidence,
    v_new_row.model_version,
    v_new_row.created_at;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text)
  IS 'Bounded persist RPC for appending AI customer analysis records with strict validation and tenant integrity. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_analysis(uuid, uuid, jsonb, text, text, text, jsonb, text, numeric, text, text) TO service_role;
