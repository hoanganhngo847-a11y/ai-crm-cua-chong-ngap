-- Migration: 20261026140000_zalo_auto_link_customer.sql
-- Purpose:
-- 1. Automatically link any Zalo call to a customer profile. Never leave a call unlinked.
--    - Match by existing Zalo identity mapping.
--    - Match by customer name in public.customers.
--    - If no customer exists, auto-create a new customer profile and stage history.
--    - Auto-link all existing unlinked calls in the database immediately.
-- 2. Provide zalo_auto_link_call and zalo_auto_link_unlinked_calls RPCs for server actions.

-- 1. Helper function to auto-link a single call
CREATE OR REPLACE FUNCTION public.zalo_auto_link_call(
  p_company uuid,
  p_actor uuid,
  p_call uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  c public.zalo_personal_calls;
  v_role text;
  v_customer uuid;
  v_name text;
BEGIN
  IF p_actor IS NOT NULL AND p_actor <> '00000000-0000-0000-0000-000000000000'::uuid THEN
    v_role := public.zalo_assert_actor(p_company, p_actor);
  ELSE
    v_role := 'SYSTEM';
  END IF;

  SELECT * INTO c FROM public.zalo_personal_calls
  WHERE id = p_call AND company_id = p_company FOR UPDATE;

  IF NOT FOUND OR c.recording_status <> 'READY' OR (v_role = 'SALE' AND c.staff_user_id IS DISTINCT FROM p_actor) THEN
    RAISE EXCEPTION 'ZALO_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF c.customer_id IS NOT NULL THEN
    RETURN jsonb_build_object('customer_id', c.customer_id, 'created', false);
  END IF;

  -- 1. Try active identity mapping
  IF c.remote_display_name_normalized <> '' THEN
    SELECT customer_id INTO v_customer
    FROM public.zalo_customer_identity_mappings
    WHERE company_id = p_company
      AND zalo_account_key = c.zalo_account_key
      AND remote_display_name_normalized = c.remote_display_name_normalized
      AND active
    ORDER BY confirmed_at DESC NULLS LAST, created_at DESC LIMIT 1;
  END IF;

  -- 2. Try match in customers table by normalized or display name
  IF v_customer IS NULL AND c.remote_display_name_normalized <> '' THEN
    SELECT id INTO v_customer
    FROM public.customers
    WHERE company_id = p_company
      AND (public.zalo_search_name(name) = public.zalo_search_name(c.remote_display_name_normalized)
           OR public.zalo_search_name(name) = public.zalo_search_name(coalesce(c.remote_display_name, '')))
    ORDER BY updated_at DESC, created_at DESC LIMIT 1;
  END IF;

  -- 3. Auto-create new customer if none found
  IF v_customer IS NULL THEN
    IF c.remote_display_name IS NOT NULL
       AND btrim(c.remote_display_name) <> ''
       AND lower(btrim(c.remote_display_name)) NOT IN ('chưa xác định tên', 'chua xac dinh ten', 'zalo call', 'zalo', 'zalocall', 'unknown', 'cuộc gọi', 'call') THEN
      v_name := btrim(c.remote_display_name);
    ELSE
      v_name := 'Khách Zalo ' || to_char(c.started_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI');
    END IF;

    INSERT INTO public.customers (company_id, name, source, stage)
    VALUES (p_company, v_name, 'ZALO', 'LEAD_NEW')
    RETURNING id INTO v_customer;

    INSERT INTO public.customer_stage_histories (company_id, customer_id, to_stage, actor_type, changed_by_user_id, reason)
    VALUES (p_company, v_customer, 'LEAD_NEW', 'SYSTEM', CASE WHEN v_role = 'SYSTEM' THEN NULL ELSE p_actor END, 'Tự động tạo từ cuộc gọi Zalo Personal');
  END IF;

  -- 4. Create / update mapping for future calls
  IF c.remote_display_name_normalized <> '' AND v_customer IS NOT NULL THEN
    INSERT INTO public.zalo_customer_identity_mappings(
      company_id, zalo_account_key, remote_display_name_original,
      remote_display_name_normalized, customer_id, confirmed_by, needs_confirmation, active
    )
    VALUES(
      p_company, c.zalo_account_key, c.remote_display_name,
      c.remote_display_name_normalized, v_customer, CASE WHEN v_role = 'SYSTEM' THEN NULL ELSE p_actor END, false, true
    )
    ON CONFLICT(company_id, zalo_account_key, remote_display_name_normalized, customer_id)
    DO UPDATE SET active = true, updated_at = now();
  END IF;

  -- 5. Link call
  UPDATE public.zalo_personal_calls
  SET customer_id = v_customer, linked_by = CASE WHEN v_role = 'SYSTEM' THEN NULL ELSE p_actor END, linked_at = now(),
      matching_status = 'EXACT', identity_ambiguous = false
  WHERE id = c.id;

  -- Sync customer_id to transcriptions
  UPDATE public.zalo_call_transcriptions
  SET customer_id = v_customer, updated_at = now()
  WHERE company_id = p_company AND call_id = c.id;

  INSERT INTO public.audit_logs(company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
  VALUES(
    p_company, CASE WHEN v_role = 'SYSTEM' THEN NULL ELSE p_actor END, 'ZALO_CUSTOMER_AUTO_LINKED', 'ZALO_CALL', c.id, v_customer, 'SUCCESS',
    jsonb_build_object('auto', true)
  );

  RETURN jsonb_build_object('customer_id', v_customer, 'created', true);
END $$;

REVOKE ALL ON FUNCTION public.zalo_auto_link_call(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_auto_link_call(uuid,uuid,uuid) TO service_role;

-- 2. Helper to auto-link all currently unlinked calls for a company (or all companies)
CREATE OR REPLACE FUNCTION public.zalo_auto_link_unlinked_calls(p_company uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_rec record;
  v_linked int := 0;
  v_res jsonb;
BEGIN
  FOR v_rec IN
    SELECT id, company_id, staff_user_id
    FROM public.zalo_personal_calls
    WHERE customer_id IS NULL AND recording_status = 'READY'
      AND (p_company IS NULL OR company_id = p_company)
    ORDER BY started_at ASC
  LOOP
    BEGIN
      v_res := public.zalo_auto_link_call(
        v_rec.company_id,
        coalesce(v_rec.staff_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_rec.id
      );
      v_linked := v_linked + 1;
    EXCEPTION WHEN OTHERS THEN
      -- continue with next call
    END;
  END LOOP;
  RETURN v_linked;
END $$;

REVOKE ALL ON FUNCTION public.zalo_auto_link_unlinked_calls(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_auto_link_unlinked_calls(uuid) TO service_role;

-- 3. Execute auto-link for all existing unlinked calls immediately
SELECT public.zalo_auto_link_unlinked_calls(NULL);
