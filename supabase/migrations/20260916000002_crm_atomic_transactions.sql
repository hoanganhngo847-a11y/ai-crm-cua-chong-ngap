-- Migration 005: CRM Atomic Transactions & RPC Routines
-- Replaces application-level compensation rollbacks with ACID Database Transactions.
-- Enforces atomic creation of Customer + Private Contact + Identities + Stage History,
-- and atomic customer stage update with stage history logging in single transaction blocks.

-- ==============================================================================
-- 1. RPC: public.create_customer_atomic
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.create_customer_atomic(
  p_company_id uuid,
  p_name text,
  p_raw_phone text,
  p_normalized_phone text,
  p_phone_hash text,
  p_source text DEFAULT 'MANUAL',
  p_stage text DEFAULT 'LEAD_NEW',
  p_customer_code text DEFAULT NULL,
  p_is_verified boolean DEFAULT false,
  p_channel text DEFAULT NULL,
  p_external_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_code text;
  v_customer public.customers%ROWTYPE;
  v_contact private.customer_private_contacts%ROWTYPE;
  v_phone_identity public.identities%ROWTYPE;
  v_social_identity public.identities%ROWTYPE;
  v_identities jsonb := '[]'::jsonb;
  v_history public.customer_stage_histories%ROWTYPE;
  v_reason text;
  v_now timestamptz := now();
BEGIN
  -- 1. Validate mandatory fields (Fail-Closed)
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'p_name là bắt buộc';
  END IF;
  IF p_raw_phone IS NULL OR trim(p_raw_phone) = '' THEN
    RAISE EXCEPTION 'p_raw_phone là bắt buộc';
  END IF;
  IF p_normalized_phone IS NULL OR trim(p_normalized_phone) = '' THEN
    RAISE EXCEPTION 'p_normalized_phone là bắt buộc';
  END IF;
  IF p_phone_hash IS NULL OR trim(p_phone_hash) = '' THEN
    RAISE EXCEPTION 'p_phone_hash là bắt buộc';
  END IF;

  -- 2. Customer code resolution
  IF p_customer_code IS NOT NULL AND trim(p_customer_code) <> '' THEN
    v_customer_code := trim(p_customer_code);
  ELSE
    v_customer_code := public.generate_customer_code();
  END IF;

  -- 3. INSERT public.customers
  INSERT INTO public.customers (
    company_id,
    customer_code,
    name,
    source,
    stage,
    created_at,
    updated_at
  ) VALUES (
    p_company_id,
    v_customer_code,
    trim(p_name),
    coalesce(p_source, 'MANUAL'),
    coalesce(p_stage, 'LEAD_NEW'),
    v_now,
    v_now
  )
  RETURNING * INTO v_customer;

  -- 4. INSERT private.customer_private_contacts (Private Security Zone)
  INSERT INTO private.customer_private_contacts (
    company_id,
    customer_id,
    raw_phone,
    normalized_phone,
    phone_country_code,
    is_verified,
    created_at,
    updated_at
  ) VALUES (
    p_company_id,
    v_customer.id,
    trim(p_raw_phone),
    trim(p_normalized_phone),
    'VN',
    coalesce(p_is_verified, false),
    v_now,
    v_now
  )
  RETURNING * INTO v_contact;

  -- 5. INSERT public.identities for PHONE
  INSERT INTO public.identities (
    company_id,
    customer_id,
    channel,
    external_id,
    verified,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    p_company_id,
    v_customer.id,
    'PHONE',
    trim(p_phone_hash),
    coalesce(p_is_verified, false),
    '{}'::jsonb,
    v_now,
    v_now
  )
  RETURNING * INTO v_phone_identity;

  v_identities := jsonb_build_array(to_jsonb(v_phone_identity));

  -- 6. INSERT public.identities for social/external channel if provided
  IF p_channel IS NOT NULL AND trim(p_channel) <> '' AND trim(p_channel) <> 'PHONE' AND p_external_id IS NOT NULL AND trim(p_external_id) <> '' THEN
    INSERT INTO public.identities (
      company_id,
      customer_id,
      channel,
      external_id,
      verified,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      p_company_id,
      v_customer.id,
      trim(p_channel),
      trim(p_external_id),
      coalesce(p_is_verified, false),
      coalesce(p_metadata, '{}'::jsonb),
      v_now,
      v_now
    )
    RETURNING * INTO v_social_identity;

    v_identities := v_identities || jsonb_build_array(to_jsonb(v_social_identity));
  END IF;

  -- 7. INSERT public.customer_stage_histories
  IF p_note IS NOT NULL AND trim(p_note) <> '' THEN
    v_reason := 'Khách hàng mới tạo từ nguồn [' || coalesce(p_source, 'MANUAL') || ']: ' || trim(p_note);
  ELSE
    v_reason := 'Khách hàng mới tạo từ nguồn [' || coalesce(p_source, 'MANUAL') || ']';
  END IF;

  INSERT INTO public.customer_stage_histories (
    company_id,
    customer_id,
    from_stage,
    to_stage,
    actor_type,
    changed_by_user_id,
    reason,
    source_ref,
    changed_at
  ) VALUES (
    p_company_id,
    v_customer.id,
    NULL,
    coalesce(p_stage, 'LEAD_NEW'),
    'SYSTEM',
    NULL,
    v_reason,
    coalesce(p_source, 'MANUAL'),
    v_now
  )
  RETURNING * INTO v_history;

  -- 8. Return structured payload
  RETURN jsonb_build_object(
    'customer', to_jsonb(v_customer),
    'contact', jsonb_build_object(
      'raw_phone', v_contact.raw_phone,
      'normalized_phone', v_contact.normalized_phone,
      'is_verified', v_contact.is_verified
    ),
    'identities', v_identities,
    'history', to_jsonb(v_history)
  );
END;
$$;

COMMENT ON FUNCTION public.create_customer_atomic(uuid, text, text, text, text, text, text, text, boolean, text, text, jsonb, text)
  IS 'ACID Atomic creation of customer profile, private contact, identities, and initial stage history. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.create_customer_atomic(uuid, text, text, text, text, text, text, text, boolean, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_customer_atomic(uuid, text, text, text, text, text, text, text, boolean, text, text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_customer_atomic(uuid, text, text, text, text, text, text, text, boolean, text, text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_customer_atomic(uuid, text, text, text, text, text, text, text, boolean, text, text, jsonb, text) TO service_role;


-- ==============================================================================
-- 2. RPC: public.update_customer_stage_atomic
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.update_customer_stage_atomic(
  p_company_id uuid,
  p_customer_id uuid,
  p_new_stage text,
  p_note text DEFAULT NULL,
  p_changed_by uuid DEFAULT NULL,
  p_actor_type text DEFAULT 'USER',
  p_source_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_stage text;
  v_customer public.customers%ROWTYPE;
  v_history public.customer_stage_histories%ROWTYPE;
  v_reason text;
  v_now timestamptz := now();
BEGIN
  -- 1. Validate mandatory fields
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'p_customer_id là bắt buộc';
  END IF;
  IF p_new_stage IS NULL OR trim(p_new_stage) = '' THEN
    RAISE EXCEPTION 'p_new_stage là bắt buộc';
  END IF;

  -- 2. Resource Authorization & Lock customer row
  SELECT * INTO v_customer
  FROM public.customers
  WHERE id = p_customer_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Khách hàng không tồn tại hoặc không thuộc quyền quản lý của tổ chức.'
      USING ERRCODE = 'P0002';
  END IF;

  v_old_stage := v_customer.stage;

  -- 3. UPDATE public.customers
  UPDATE public.customers
  SET stage = trim(p_new_stage),
      updated_at = v_now
  WHERE id = p_customer_id
    AND company_id = p_company_id
  RETURNING * INTO v_customer;

  -- 4. INSERT public.customer_stage_histories (Strict Append-Only)
  v_reason := coalesce(trim(p_note), 'Chuyển giai đoạn sang [' || trim(p_new_stage) || ']');

  INSERT INTO public.customer_stage_histories (
    company_id,
    customer_id,
    from_stage,
    to_stage,
    actor_type,
    changed_by_user_id,
    reason,
    source_ref,
    changed_at
  ) VALUES (
    p_company_id,
    p_customer_id,
    v_old_stage,
    trim(p_new_stage),
    coalesce(p_actor_type, 'USER'),
    p_changed_by,
    v_reason,
    p_source_ref,
    v_now
  )
  RETURNING * INTO v_history;

  -- 5. Return structured payload
  RETURN jsonb_build_object(
    'customer', to_jsonb(v_customer),
    'history', to_jsonb(v_history)
  );
END;
$$;

COMMENT ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text)
  IS 'ACID Atomic update of customer stage and stage history audit trail. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_customer_stage_atomic(uuid, uuid, text, text, uuid, text, text) TO service_role;
