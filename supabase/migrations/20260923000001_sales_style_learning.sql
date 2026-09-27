-- Migration 007: Secure Sales Style Learning Core (M9.4A)
-- Implements provenance schema extension on public.sales_style_profiles,
-- complete table ACL lockdown for RPC-only persistence,
-- bounded read RPC public.get_sales_style_learning_input,
-- and bounded persist RPC public.record_sales_style_profile with DB-derived examples,
-- trusted server-generated version, strict source_refs validation, and mandatory audit log.

-- ------------------------------------------------------------------------------
-- 1. SCHEMA EXTENSION ON public.sales_style_profiles
-- ------------------------------------------------------------------------------
ALTER TABLE public.sales_style_profiles
  ADD COLUMN source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN model_version text NULL,
  ADD COLUMN generation_status text NOT NULL DEFAULT 'DRAFT'
    CHECK (generation_status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED'));

-- ------------------------------------------------------------------------------
-- 2. TABLE ACL LOCKDOWN (RPC-ONLY PERSISTENCE ARCHITECTURE)
-- ------------------------------------------------------------------------------
-- Revoke ALL direct table privileges from service_role.
-- Direct INSERT, UPDATE, DELETE are revoked from PUBLIC, anon, authenticated.
-- Direct SELECT for authenticated users continues under Foundation RLS policies (BOSS_ADMIN, SALE).
-- Only postgres superuser retains direct table mutation privileges.
REVOKE ALL ON TABLE public.sales_style_profiles FROM service_role;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sales_style_profiles FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sales_style_profiles TO postgres;

-- ------------------------------------------------------------------------------
-- 3. BOUNDED READ RPC: public.get_sales_style_learning_input
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_style_learning_input(
  p_company_id uuid,
  p_sale_user_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  interaction_id uuid,
  channel text,
  sanitized_content text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_status text;
  v_member_role text;
  v_member_status text;
  v_limit integer;
BEGIN
  -- 1. Validate target user existence and status in user_profiles
  SELECT up.status
  INTO v_user_status
  FROM public.user_profiles up
  WHERE up.id = p_sale_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'USER_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate company membership in target company
  SELECT cm.role, cm.status
  INTO v_member_role, v_member_status
  FROM public.company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = p_sale_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_member_role <> 'SALE' THEN
    RAISE EXCEPTION 'ROLE_NOT_SALE' USING ERRCODE = '42501';
  END IF;

  IF v_member_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'MEMBERSHIP_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 3. Validate limit parameter (1 to 200)
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > 200) THEN
    RAISE EXCEPTION 'INVALID_LIMIT' USING ERRCODE = '22000';
  END IF;
  v_limit := COALESCE(p_limit, 100);

  -- 4. Query latest-N sanitized outbound SALE messages, then reorder chronologically ASC
  RETURN QUERY
  WITH latest_interactions AS (
    SELECT
      i.id AS interaction_id,
      i.channel,
      i.sanitized_content,
      i.created_at
    FROM public.interactions i
    WHERE i.company_id = p_company_id
      AND i.actor_type = 'SALE'
      AND i.actor_user_id = p_sale_user_id
      AND i.direction = 'OUTBOUND'
      AND i.type = 'MESSAGE'
      AND i.sanitization_status = 'SUCCEEDED'
      AND i.sanitized_content IS NOT NULL
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT v_limit
  )
  SELECT
    li.interaction_id,
    li.channel,
    li.sanitized_content,
    li.created_at
  FROM latest_interactions li
  ORDER BY li.created_at ASC, li.interaction_id ASC;
END;
$$;

COMMENT ON FUNCTION public.get_sales_style_learning_input(uuid, uuid, integer)
  IS 'Bounded read RPC returning sanitized outbound messages for a validated active Sale. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.get_sales_style_learning_input(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_sales_style_learning_input(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_sales_style_learning_input(uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_style_learning_input(uuid, uuid, integer) TO service_role;

-- ------------------------------------------------------------------------------
-- 4. BOUNDED PERSIST RPC: public.record_sales_style_profile
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_sales_style_profile(
  p_company_id uuid,
  p_sale_user_id uuid,
  p_source_refs jsonb,
  p_salutation_rules jsonb,
  p_sentence_style jsonb,
  p_question_style jsonb,
  p_objection_style jsonb,
  p_closing_style jsonb,
  p_model_version text
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  sale_user_id uuid,
  version text,
  salutation_rules jsonb,
  sentence_style jsonb,
  question_style jsonb,
  objection_style jsonb,
  closing_style jsonb,
  examples jsonb,
  source_refs jsonb,
  model_version text,
  generation_status text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_status text;
  v_member_role text;
  v_member_status text;
  v_elem jsonb;
  v_ref_id uuid;
  v_ref_type text;
  v_int_company_id uuid;
  v_int_actor_type text;
  v_int_actor_user_id uuid;
  v_int_direction text;
  v_int_type text;
  v_int_sanitization_status text;
  v_int_sanitized_content text;
  v_version text;
  v_derived_examples jsonb;
  v_unique_source_count integer;
  v_total_source_count integer;
  v_combined_style_text text;
  v_new_row public.sales_style_profiles%ROWTYPE;
BEGIN
  -- 1. Validate target Sale user existence and active status
  SELECT up.status
  INTO v_user_status
  FROM public.user_profiles up
  WHERE up.id = p_sale_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'USER_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate target Sale company membership in target company
  SELECT cm.role, cm.status
  INTO v_member_role, v_member_status
  FROM public.company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = p_sale_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_member_role <> 'SALE' THEN
    RAISE EXCEPTION 'ROLE_NOT_SALE' USING ERRCODE = '42501';
  END IF;

  IF v_member_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'MEMBERSHIP_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 3. Validate model_version (trusted provenance: non-null, non-empty, length <= 100)
  IF p_model_version IS NULL OR pg_catalog.btrim(p_model_version) = '' THEN
    RAISE EXCEPTION 'EMPTY_MODEL_VERSION' USING ERRCODE = '22000';
  END IF;
  IF pg_catalog.length(p_model_version) > 100 THEN
    RAISE EXCEPTION 'MODEL_VERSION_TOO_LONG' USING ERRCODE = '22000';
  END IF;

  -- 4. Validate style JSON structures at DB level (must be non-null JSON objects)
  IF p_salutation_rules IS NULL OR jsonb_typeof(p_salutation_rules) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_SALUTATION_RULES' USING ERRCODE = '22000';
  END IF;
  IF p_sentence_style IS NULL OR jsonb_typeof(p_sentence_style) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_SENTENCE_STYLE' USING ERRCODE = '22000';
  END IF;
  IF p_question_style IS NULL OR jsonb_typeof(p_question_style) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_QUESTION_STYLE' USING ERRCODE = '22000';
  END IF;
  IF p_objection_style IS NULL OR jsonb_typeof(p_objection_style) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_OBJECTION_STYLE' USING ERRCODE = '22000';
  END IF;
  IF p_closing_style IS NULL OR jsonb_typeof(p_closing_style) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_CLOSING_STYLE' USING ERRCODE = '22000';
  END IF;

  -- 4b. Business-policy content firewall at DB level (Defense in depth)
  v_combined_style_text := p_salutation_rules::text || ' ' ||
                           p_sentence_style::text || ' ' ||
                           p_question_style::text || ' ' ||
                           p_objection_style::text || ' ' ||
                           p_closing_style::text;

  IF v_combined_style_text ~* '(giảm\s*giá|chiết\s*khấu|\ydiscount\y|khuyến\s*m[aã]i|%|\ypercent\y|\yphần\s*trăm\y|giá\s*bán|mức\s*giá|báo\s*giá|bảng\s*giá|đơn\s*giá|\yvnđ\y|\yvnd\y|₫|đặt\s*cọc|tiền\s*cọc|\ycọc\y|payment\s*terms|\ythanh\s*toán\y|\ypayment\y|chuyển\s*khoản|trả\s*góp|hợp\s*đồng|\ycontract\y|bảo\s*hành|\ywarranty\y|\yphí\y|lãi\s*suất|cam\s*kết\s*(giao\s*hàng|bảo\s*hành|tiến\s*độ|giá|doanh\s*nghiệp|chất\s*lượng|hoàn\s*tiền))'
     OR v_combined_style_text ~* '\m\d+([\.,]\d{3})*\s*(triệu|nghìn|ngàn|tr|k|đồng|đ)\M' THEN
    RAISE EXCEPTION 'FORBIDDEN_BUSINESS_POLICY_IN_STYLE' USING ERRCODE = '22000';
  END IF;

  -- 5. Validate source_refs array (1 to 200 items, audit-safe)
  IF p_source_refs IS NULL OR jsonb_typeof(p_source_refs) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_REFS_STRUCTURE' USING ERRCODE = '22000';
  END IF;
  IF jsonb_array_length(p_source_refs) = 0 THEN
    RAISE EXCEPTION 'EMPTY_SOURCE_REFS' USING ERRCODE = '22000';
  END IF;
  IF jsonb_array_length(p_source_refs) > 200 THEN
    RAISE EXCEPTION 'SOURCE_REFS_LIMIT_EXCEEDED' USING ERRCODE = '22000';
  END IF;

  -- Validate uniqueness of source_refs interaction IDs (Reject duplicate source refs)
  SELECT count(DISTINCT (elem->>'id')::uuid), count(*)
  INTO v_unique_source_count, v_total_source_count
  FROM jsonb_array_elements(p_source_refs) elem;

  IF v_unique_source_count <> v_total_source_count THEN
    RAISE EXCEPTION 'DUPLICATE_SOURCE_REF' USING ERRCODE = '22000';
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_source_refs) LOOP
    IF jsonb_typeof(v_elem) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_SOURCE_REF_ITEM' USING ERRCODE = '22000';
    END IF;

    -- Security: Only type 'INTERACTION' is allowed
    v_ref_type := v_elem->>'type';
    IF v_ref_type IS NULL OR v_ref_type <> 'INTERACTION' THEN
      RAISE EXCEPTION 'FORBIDDEN_SOURCE_REF_TYPE' USING ERRCODE = '22000';
    END IF;

    -- Security: Forbid storing sensitive keys in source_refs
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

    -- Verify target interaction against strict company, sale actor, outbound, message, and sanitization boundaries
    SELECT i.company_id, i.actor_type, i.actor_user_id, i.direction, i.type, i.sanitization_status, i.sanitized_content
    INTO v_int_company_id, v_int_actor_type, v_int_actor_user_id, v_int_direction, v_int_type, v_int_sanitization_status, v_int_sanitized_content
    FROM public.interactions i
    WHERE i.id = v_ref_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'SOURCE_INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    IF v_int_company_id <> p_company_id THEN
      RAISE EXCEPTION 'SOURCE_INTERACTION_TENANT_MISMATCH' USING ERRCODE = '42501';
    END IF;

    IF v_int_actor_type <> 'SALE' OR v_int_actor_user_id <> p_sale_user_id THEN
      RAISE EXCEPTION 'SOURCE_INTERACTION_ACTOR_MISMATCH' USING ERRCODE = '22000';
    END IF;

    IF v_int_direction <> 'OUTBOUND' THEN
      RAISE EXCEPTION 'SOURCE_INTERACTION_NOT_OUTBOUND' USING ERRCODE = '22000';
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

  -- 6. Derive trusted provenance examples (metadata only: interaction_id, channel, created_at, capped at 5)
  -- CRITICAL SECURITY INVARIANT: Message content/text is NEVER stored in examples.
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'interaction_id', sub.id,
        'channel', sub.channel,
        'created_at', sub.created_at
      )
    ),
    '[]'::jsonb
  )
  INTO v_derived_examples
  FROM (
    SELECT i.id, i.channel, i.created_at
    FROM public.interactions i
    WHERE i.id IN (
      SELECT (elem->>'id')::uuid
      FROM jsonb_array_elements(p_source_refs) elem
    )
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 5
  ) sub;

  -- 7. Generate trusted unique version (server/DB generated, satisfies uq_ssp_company_version)
  v_version := 'ssp_' || replace(gen_random_uuid()::text, '-', '');

  -- 8. Append-only INSERT into public.sales_style_profiles
  -- INVARIANT: generation_status is strictly 'DRAFT' in M9.4A.
  -- INVARIANT: existing profiles are NEVER updated.
  -- INVARIANT: no customer, order, contract, pricing, or payment tables are mutated.
  INSERT INTO public.sales_style_profiles (
    company_id,
    sale_user_id,
    version,
    salutation_rules,
    sentence_style,
    question_style,
    objection_style,
    closing_style,
    examples,
    source_refs,
    model_version,
    generation_status
  ) VALUES (
    p_company_id,
    p_sale_user_id,
    v_version,
    p_salutation_rules,
    p_sentence_style,
    p_question_style,
    p_objection_style,
    p_closing_style,
    v_derived_examples,
    p_source_refs,
    p_model_version,
    'DRAFT'
  )
  RETURNING * INTO v_new_row;

  -- 9. Mandatory Audit Log entry
  -- In case audit insert fails, the entire transaction rolls back fail-closed.
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
    p_sale_user_id,
    'SALES_STYLE_PROFILE_GENERATED',
    'SALES_STYLE_PROFILE',
    v_new_row.id,
    NULL,
    'SUCCESS',
    jsonb_build_object(
      'sale_user_id', p_sale_user_id,
      'version', v_version,
      'model_version', p_model_version,
      'source_count', v_unique_source_count
    )
  );

  RETURN QUERY SELECT
    v_new_row.id,
    v_new_row.company_id,
    v_new_row.sale_user_id,
    v_new_row.version,
    v_new_row.salutation_rules,
    v_new_row.sentence_style,
    v_new_row.question_style,
    v_new_row.objection_style,
    v_new_row.closing_style,
    v_new_row.examples,
    v_new_row.source_refs,
    v_new_row.model_version,
    v_new_row.generation_status,
    v_new_row.created_at,
    v_new_row.updated_at;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.record_sales_style_profile(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text)
  IS 'Bounded persist RPC appending a new DRAFT sales style profile with DB-derived examples and audit record. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.record_sales_style_profile(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_sales_style_profile(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_sales_style_profile(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_sales_style_profile(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text) TO service_role;
