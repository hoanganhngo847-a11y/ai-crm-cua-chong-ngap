-- Migration 008: Sales Style Approval & Activation (M9.4B)
-- Implements lifecycle columns and integrity constraints on public.sales_style_profiles,
-- partial unique index guaranteeing exactly max 1 ACTIVE profile per Sale,
-- privileged human activation RPC public.activate_sales_style_profile,
-- and bounded runtime read RPC public.get_active_sales_style_profile.

-- ------------------------------------------------------------------------------
-- 1. LIFECYCLE SCHEMA EXTENSION ON public.sales_style_profiles
-- ------------------------------------------------------------------------------
ALTER TABLE public.sales_style_profiles
  ADD COLUMN activated_at timestamptz NULL,
  ADD COLUMN activated_by_user_id uuid NULL
    REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN superseded_at timestamptz NULL,
  ADD COLUMN superseded_by_profile_id uuid NULL;

-- ------------------------------------------------------------------------------
-- 1b. LINEAGE INTEGRITY CONSTRAINTS
-- ------------------------------------------------------------------------------
-- Unique constraint required to support composite foreign key
ALTER TABLE public.sales_style_profiles
  ADD CONSTRAINT uq_sales_style_profiles_company_sale_id
  UNIQUE (company_id, sale_user_id, id);

-- Composite foreign key enforcing same-company and same-sale lineage
ALTER TABLE public.sales_style_profiles
  ADD CONSTRAINT fk_sales_style_profiles_superseded_by_lineage
  FOREIGN KEY (company_id, sale_user_id, superseded_by_profile_id)
  REFERENCES public.sales_style_profiles (company_id, sale_user_id, id)
  ON DELETE RESTRICT;

-- Anti-reflexive check constraint forbidding self-supersede
ALTER TABLE public.sales_style_profiles
  ADD CONSTRAINT chk_sales_style_profiles_no_self_supersede
  CHECK (superseded_by_profile_id IS NULL OR superseded_by_profile_id <> id);

-- ------------------------------------------------------------------------------
-- 2. STATE INTEGRITY CHECK CONSTRAINT
-- ------------------------------------------------------------------------------
ALTER TABLE public.sales_style_profiles
  ADD CONSTRAINT chk_sales_style_profile_lifecycle CHECK (
    (
      generation_status = 'DRAFT'
      AND activated_at IS NULL
      AND activated_by_user_id IS NULL
      AND superseded_at IS NULL
      AND superseded_by_profile_id IS NULL
    ) OR (
      generation_status = 'ACTIVE'
      AND activated_at IS NOT NULL
      AND activated_by_user_id IS NOT NULL
      AND superseded_at IS NULL
      AND superseded_by_profile_id IS NULL
    ) OR (
      generation_status = 'SUPERSEDED'
      AND activated_at IS NOT NULL
      AND activated_by_user_id IS NOT NULL
      AND superseded_at IS NOT NULL
      AND superseded_by_profile_id IS NOT NULL
    )
  );

-- ------------------------------------------------------------------------------
-- 3. HARD DB INVARIANT: EXACTLY MAX 1 ACTIVE PROFILE PER SALE
-- ------------------------------------------------------------------------------
CREATE UNIQUE INDEX uq_sales_style_profiles_active_sale
  ON public.sales_style_profiles (company_id, sale_user_id)
  WHERE generation_status = 'ACTIVE';

CREATE INDEX idx_sales_style_profiles_superseded_by
  ON public.sales_style_profiles (superseded_by_profile_id)
  WHERE superseded_by_profile_id IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 4. PRIVILEGED HUMAN ACTIVATION RPC: public.activate_sales_style_profile
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activate_sales_style_profile(
  p_profile_id uuid
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
  activated_at timestamptz,
  activated_by_user_id uuid,
  superseded_at timestamptz,
  superseded_by_profile_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor_user_id uuid;
  v_actor_user_status text;
  v_actor_role text;
  v_actor_member_status text;
  v_target_company_id uuid;
  v_target_sale_user_id uuid;
  v_target_status text;
  v_sale_member_role text;
  v_sale_member_status text;
  v_target_sale_user_status text;
  v_target_row public.sales_style_profiles%ROWTYPE;
  v_old_active_row public.sales_style_profiles%ROWTYPE;
  v_now timestamptz;
  v_elem jsonb;
  v_ex jsonb;
  v_ref_id uuid;
  v_unique_source_count integer;
  v_total_source_count integer;
  v_int_company_id uuid;
  v_int_actor_type text;
  v_int_actor_user_id uuid;
  v_int_direction text;
  v_int_type text;
  v_int_sanitization_status text;
  v_int_sanitized_content text;
  v_combined_style_text text;
BEGIN
  -- 1. Derive target resource and verify existence
  SELECT
    ssp.company_id,
    ssp.sale_user_id,
    ssp.generation_status
  INTO
    v_target_company_id,
    v_target_sale_user_id,
    v_target_status
  FROM public.sales_style_profiles ssp
  WHERE ssp.id = p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 2. Validate human actor via auth.uid()
  v_actor_user_id := auth.uid();
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  -- Verify actor profile in user_profiles
  SELECT up.status
  INTO v_actor_user_status
  FROM public.user_profiles up
  WHERE up.id = v_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_actor_user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTOR_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- Verify actor company membership: must be same company, role BOSS_ADMIN, status ACTIVE
  SELECT cm.role, cm.status
  INTO v_actor_role, v_actor_member_status
  FROM public.company_members cm
  WHERE cm.company_id = v_target_company_id
    AND cm.user_id = v_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_MEMBERSHIP_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_actor_role <> 'BOSS_ADMIN' THEN
    RAISE EXCEPTION 'ACTOR_ROLE_NOT_BOSS_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF v_actor_member_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTOR_MEMBERSHIP_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 3. Concurrency serialization mutex: Lock target Sale company_members row FOR UPDATE
  SELECT cm.role, cm.status
  INTO v_sale_member_role, v_sale_member_status
  FROM public.company_members cm
  WHERE cm.company_id = v_target_company_id
    AND cm.user_id = v_target_sale_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_SALE_MEMBERSHIP_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  -- 4. Revalidate target Sale at activation time
  IF v_sale_member_role <> 'SALE' THEN
    RAISE EXCEPTION 'TARGET_NOT_SALE' USING ERRCODE = '42501';
  END IF;

  IF v_sale_member_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'TARGET_SALE_INACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT up.status
  INTO v_target_sale_user_status
  FROM public.user_profiles up
  WHERE up.id = v_target_sale_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_SALE_USER_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_target_sale_user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'TARGET_SALE_USER_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 5. Lock target profile FOR UPDATE
  SELECT *
  INTO v_target_row
  FROM public.sales_style_profiles ssp
  WHERE ssp.id = p_profile_id
  FOR UPDATE;

  -- Allowed state transitions:
  -- SUPERSEDED cannot be activated
  IF v_target_row.generation_status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'PROFILE_ALREADY_SUPERSEDED' USING ERRCODE = '22000';
  END IF;

  -- Idempotency: ACTIVE -> ACTIVE no-op
  IF v_target_row.generation_status = 'ACTIVE' THEN
    -- Verify invariant sanity
    IF v_target_row.activated_at IS NULL OR v_target_row.activated_by_user_id IS NULL
       OR v_target_row.superseded_at IS NOT NULL OR v_target_row.superseded_by_profile_id IS NOT NULL THEN
      RAISE EXCEPTION 'CORRUPT_ACTIVE_PROFILE_STATE' USING ERRCODE = '22000';
    END IF;

    -- Return existing active profile without updating or creating duplicate audit
    RETURN QUERY SELECT
      v_target_row.id,
      v_target_row.company_id,
      v_target_row.sale_user_id,
      v_target_row.version,
      v_target_row.salutation_rules,
      v_target_row.sentence_style,
      v_target_row.question_style,
      v_target_row.objection_style,
      v_target_row.closing_style,
      v_target_row.examples,
      v_target_row.source_refs,
      v_target_row.model_version,
      v_target_row.generation_status,
      v_target_row.activated_at,
      v_target_row.activated_by_user_id,
      v_target_row.superseded_at,
      v_target_row.superseded_by_profile_id,
      v_target_row.created_at,
      v_target_row.updated_at;
    RETURN;
  END IF;

  IF v_target_row.generation_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_PROFILE_STATUS' USING ERRCODE = '22000';
  END IF;

  -- ============================================================================
  -- 5b. PROVENANCE REVALIDATION OF DRAFT PROFILE (Defense-in-depth against untrusted DRAFTs)
  -- ============================================================================
  -- 1. Validate model_version: non-null, non-empty trimmed, length <= 100
  IF v_target_row.model_version IS NULL
     OR pg_catalog.btrim(v_target_row.model_version) = ''
     OR pg_catalog.length(v_target_row.model_version) > 100 THEN
    RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
  END IF;

  -- 2. Validate source_refs: jsonb array, 1..200 items, no duplicates, valid shape INTERACTION
  IF v_target_row.source_refs IS NULL
     OR jsonb_typeof(v_target_row.source_refs) <> 'array'
     OR jsonb_array_length(v_target_row.source_refs) = 0
     OR jsonb_array_length(v_target_row.source_refs) > 200 THEN
    RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
  END IF;

  -- Validate each item in source_refs for shape and sensitive data
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_target_row.source_refs) LOOP
    IF jsonb_typeof(v_elem) <> 'object' THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF (v_elem->>'type') IS NULL OR (v_elem->>'type') <> 'INTERACTION' THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_elem ? 'content' OR v_elem ? 'sanitized_content' OR v_elem ? 'message_text'
       OR v_elem ? 'phone' OR v_elem ? 'transcript' OR v_elem ? 'recording'
       OR v_elem ? 'raw_payload' OR v_elem ? 'token' THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END IF;

    BEGIN
      v_ref_id := (v_elem->>'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END;

    IF v_ref_id IS NULL THEN
      RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
    END IF;
  END LOOP;

  -- Check for duplicate IDs in source_refs
  SELECT count(DISTINCT (elem->>'id')::uuid), count(*)
  INTO v_unique_source_count, v_total_source_count
  FROM jsonb_array_elements(v_target_row.source_refs) elem;

  IF v_unique_source_count <> v_total_source_count THEN
    RAISE EXCEPTION 'PROFILE_PROVENANCE_INVALID' USING ERRCODE = '22000';
  END IF;

  -- 3. Revalidate each source interaction against public.interactions:
  -- same company, actor_type = SALE, actor_user_id = target sale, direction = OUTBOUND,
  -- type = MESSAGE, sanitization_status = SUCCEEDED, sanitized_content IS NOT NULL & non-empty
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_target_row.source_refs) LOOP
    v_ref_id := (v_elem->>'id')::uuid;

    SELECT
      i.company_id,
      i.actor_type,
      i.actor_user_id,
      i.direction,
      i.type,
      i.sanitization_status,
      i.sanitized_content
    INTO
      v_int_company_id,
      v_int_actor_type,
      v_int_actor_user_id,
      v_int_direction,
      v_int_type,
      v_int_sanitization_status,
      v_int_sanitized_content
    FROM public.interactions i
    WHERE i.id = v_ref_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = 'P0002';
    END IF;

    IF v_int_company_id <> v_target_company_id THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '42501';
    END IF;

    IF v_int_actor_type <> 'SALE' OR v_int_actor_user_id <> v_target_sale_user_id THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_int_direction <> 'OUTBOUND' THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_int_type <> 'MESSAGE' THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_int_sanitization_status <> 'SUCCEEDED' THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;

    IF v_int_sanitized_content IS NULL OR pg_catalog.btrim(v_int_sanitized_content) = '' THEN
      RAISE EXCEPTION 'PROFILE_SOURCE_INVALID' USING ERRCODE = '22000';
    END IF;
  END LOOP;

  -- 4. Style safety at activation: DB-level business policy firewall
  IF v_target_row.salutation_rules IS NULL OR jsonb_typeof(v_target_row.salutation_rules) <> 'object'
     OR v_target_row.sentence_style IS NULL OR jsonb_typeof(v_target_row.sentence_style) <> 'object'
     OR v_target_row.question_style IS NULL OR jsonb_typeof(v_target_row.question_style) <> 'object'
     OR v_target_row.objection_style IS NULL OR jsonb_typeof(v_target_row.objection_style) <> 'object'
     OR v_target_row.closing_style IS NULL OR jsonb_typeof(v_target_row.closing_style) <> 'object' THEN
    RAISE EXCEPTION 'PROFILE_STYLE_POLICY_UNSAFE' USING ERRCODE = '22000';
  END IF;

  v_combined_style_text := v_target_row.salutation_rules::text || ' ' ||
                           v_target_row.sentence_style::text || ' ' ||
                           v_target_row.question_style::text || ' ' ||
                           v_target_row.objection_style::text || ' ' ||
                           v_target_row.closing_style::text;

  IF v_combined_style_text ~* '(giảm\s*giá|chiết\s*khấu|\ydiscount\y|khuyến\s*m[aã]i|%|\ypercent\y|\yphần\s*trăm\y|giá\s*bán|mức\s*giá|báo\s*giá|bảng\s*giá|đơn\s*giá|\yvnđ\y|\yvnd\y|₫|đặt\s*cọc|tiền\s*cọc|\ycọc\y|payment\s*terms|\ythanh\s*toán\y|\ypayment\y|chuyển\s*khoản|trả\s*góp|hợp\s*đồng|\ycontract\y|bảo\s*hành|\ywarranty\y|\yphí\y|lãi\s*suất|cam\s*kết\s*(giao\s*hàng|bảo\s*hành|tiến\s*độ|giá|doanh\s*nghiệp|chất\s*lượng|hoàn\s*tiền))'
     OR v_combined_style_text ~* '\m\d+([\.,]\d{3})*\s*(triệu|nghìn|ngàn|tr|k|đồng|đ)\M' THEN
    RAISE EXCEPTION 'PROFILE_STYLE_POLICY_UNSAFE' USING ERRCODE = '22000';
  END IF;

  -- 5. Legacy examples validation: array 0..5 items, metadata only, strictly no content/sanitized_content/phone/etc.
  IF v_target_row.examples IS NULL OR jsonb_typeof(v_target_row.examples) <> 'array' THEN
    RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
  END IF;

  IF jsonb_array_length(v_target_row.examples) > 5 THEN
    RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
  END IF;

  FOR v_ex IN SELECT * FROM jsonb_array_elements(v_target_row.examples) LOOP
    IF jsonb_typeof(v_ex) <> 'object' THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END IF;

    -- Forbid sensitive / leaky keys in examples
    IF v_ex ? 'content' OR v_ex ? 'sanitized_content' OR v_ex ? 'message_text'
       OR v_ex ? 'phone' OR v_ex ? 'transcript' OR v_ex ? 'recording'
       OR v_ex ? 'raw_payload' OR v_ex ? 'token' THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END IF;

    -- Metadata shape check: must contain interaction_id, channel, created_at
    IF NOT (v_ex ? 'interaction_id' AND v_ex ? 'channel' AND v_ex ? 'created_at') THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END IF;

    -- Strict whitelist: no other keys allowed
    IF (SELECT count(*) FROM jsonb_object_keys(v_ex) k WHERE k NOT IN ('interaction_id', 'channel', 'created_at')) > 0 THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END IF;

    BEGIN
      PERFORM (v_ex->>'interaction_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PROFILE_EXAMPLES_UNSAFE' USING ERRCODE = '22000';
    END;
  END LOOP;

  -- Transaction timestamp for atomic transition
  v_now := clock_timestamp();

  -- 6. Lock current ACTIVE profile for this sale (if any exists)
  SELECT *
  INTO v_old_active_row
  FROM public.sales_style_profiles ssp
  WHERE ssp.company_id = v_target_company_id
    AND ssp.sale_user_id = v_target_sale_user_id
    AND ssp.generation_status = 'ACTIVE'
  FOR UPDATE;

  -- 7. Supersede old active profile if found
  IF FOUND AND v_old_active_row.id IS NOT NULL THEN
    UPDATE public.sales_style_profiles ssp
    SET generation_status = 'SUPERSEDED',
        superseded_at = v_now,
        superseded_by_profile_id = p_profile_id,
        updated_at = v_now
    WHERE ssp.id = v_old_active_row.id;

    -- Mandatory audit log for superseded profile
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
      v_target_company_id,
      v_actor_user_id,
      'SALES_STYLE_PROFILE_SUPERSEDED',
      'SALES_STYLE_PROFILE',
      v_old_active_row.id,
      NULL,
      'SUCCESS',
      jsonb_build_object(
        'sale_user_id', v_target_sale_user_id,
        'superseded_by_profile_id', p_profile_id
      )
    );
  END IF;

  -- 8. Activate target profile
  UPDATE public.sales_style_profiles ssp
  SET generation_status = 'ACTIVE',
      activated_at = v_now,
      activated_by_user_id = v_actor_user_id,
      updated_at = v_now
  WHERE ssp.id = p_profile_id
  RETURNING * INTO v_target_row;

  -- Mandatory audit log for activated profile
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
    v_target_company_id,
    v_actor_user_id,
    'SALES_STYLE_PROFILE_ACTIVATED',
    'SALES_STYLE_PROFILE',
    p_profile_id,
    NULL,
    'SUCCESS',
    jsonb_build_object(
      'sale_user_id', v_target_sale_user_id,
      'version', v_target_row.version,
      'previous_active_profile_id', v_old_active_row.id
    )
  );

  RETURN QUERY SELECT
    v_target_row.id,
    v_target_row.company_id,
    v_target_row.sale_user_id,
    v_target_row.version,
    v_target_row.salutation_rules,
    v_target_row.sentence_style,
    v_target_row.question_style,
    v_target_row.objection_style,
    v_target_row.closing_style,
    v_target_row.examples,
    v_target_row.source_refs,
    v_target_row.model_version,
    v_target_row.generation_status,
    v_target_row.activated_at,
    v_target_row.activated_by_user_id,
    v_target_row.superseded_at,
    v_target_row.superseded_by_profile_id,
    v_target_row.created_at,
    v_target_row.updated_at;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.activate_sales_style_profile(uuid)
  IS 'Privileged human RPC activating a DRAFT sales style profile, superseding any prior ACTIVE profile for the same Sale. Requires authenticated BOSS_ADMIN in the same company.';

REVOKE ALL ON FUNCTION public.activate_sales_style_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_sales_style_profile(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.activate_sales_style_profile(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.activate_sales_style_profile(uuid) TO authenticated;

-- ------------------------------------------------------------------------------
-- 5. BOUNDED ACTIVE PROFILE RUNTIME READ RPC: public.get_active_sales_style_profile
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_active_sales_style_profile(
  p_company_id uuid,
  p_sale_user_id uuid
)
RETURNS TABLE (
  id uuid,
  sale_user_id uuid,
  version text,
  salutation_rules jsonb,
  sentence_style jsonb,
  question_style jsonb,
  objection_style jsonb,
  closing_style jsonb,
  model_version text,
  activated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user_status text;
  v_member_role text;
  v_member_status text;
  v_active_count integer;
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

  -- 3. Verify integrity: count cannot exceed 1
  SELECT count(*)
  INTO v_active_count
  FROM public.sales_style_profiles ssp
  WHERE ssp.company_id = p_company_id
    AND ssp.sale_user_id = p_sale_user_id
    AND ssp.generation_status = 'ACTIVE';

  IF v_active_count > 1 THEN
    RAISE EXCEPTION 'MULTIPLE_ACTIVE_PROFILES' USING ERRCODE = '22000';
  END IF;

  -- 4. Return runtime-safe fields (excludes source_refs and examples)
  RETURN QUERY
  SELECT
    ssp.id,
    ssp.sale_user_id,
    ssp.version,
    ssp.salutation_rules,
    ssp.sentence_style,
    ssp.question_style,
    ssp.objection_style,
    ssp.closing_style,
    ssp.model_version,
    ssp.activated_at
  FROM public.sales_style_profiles ssp
  WHERE ssp.company_id = p_company_id
    AND ssp.sale_user_id = p_sale_user_id
    AND ssp.generation_status = 'ACTIVE';
END;
$$;

COMMENT ON FUNCTION public.get_active_sales_style_profile(uuid, uuid)
  IS 'Bounded runtime read RPC returning the canonical ACTIVE sales style profile for a validated Sale. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.get_active_sales_style_profile(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_active_sales_style_profile(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_active_sales_style_profile(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_sales_style_profile(uuid, uuid) TO service_role;
