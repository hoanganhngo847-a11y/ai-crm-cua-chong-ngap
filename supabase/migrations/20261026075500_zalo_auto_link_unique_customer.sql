-- Auto-link only when the CRM can prove a single customer identity.
-- Unknown or ambiguous display names remain unresolved for explicit confirmation.

CREATE OR REPLACE FUNCTION public.zalo_finish_recording(
  p_device uuid,
  p_key_hash text,
  p_call uuid,
  p_lease uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  c public.zalo_personal_calls;
  req public.zalo_outbound_call_requests;
  v_count int := 0;
  v_customers int := 0;
  v_customer uuid := null;
  v_ambiguous boolean := false;
  v_req_role text;
  v_final_staff uuid;
BEGIN
  SELECT * INTO d
  FROM public.zalo_recording_devices
  WHERE id = p_device AND active AND device_key_hash = p_key_hash
  FOR UPDATE;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  IF d.staff_user_id IS NOT NULL THEN
    PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
  END IF;

  SELECT * INTO c
  FROM public.zalo_personal_calls
  WHERE id = p_call AND company_id = d.company_id AND device_id = d.id
  FOR UPDATE;

  IF NOT FOUND OR c.upload_lease <> p_lease THEN
    RAISE EXCEPTION 'ZALO_LEASE_LOST';
  END IF;

  IF c.recording_status = 'READY' THEN
    RETURN jsonb_build_object('call_id', c.id, 'recording_id', c.id, 'duplicate', true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'zalo-call-recordings'
      AND name = c.recording_path
      AND (metadata->>'size')::bigint = c.recording_bytes
  ) THEN
    RAISE EXCEPTION 'ZALO_OBJECT_MISSING';
  END IF;

  v_final_staff := c.staff_user_id;

  -- Verified outbound requests always carry the authoritative customer.
  IF c.outbound_request_id IS NOT NULL THEN
    SELECT * INTO req
    FROM public.zalo_outbound_call_requests
    WHERE id = c.outbound_request_id AND company_id = c.company_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND'; END IF;
    IF c.direction IS DISTINCT FROM 'OUTBOUND' THEN RAISE EXCEPTION 'ZALO_REQUEST_DIRECTION_MISMATCH'; END IF;
    IF req.claimed_at IS NULL OR req.claimed_by_device_id IS NULL THEN RAISE EXCEPTION 'ZALO_REQUEST_UNCLAIMED'; END IF;
    IF req.claimed_by_device_id <> d.id THEN RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH'; END IF;
    IF req.device_id IS NOT NULL AND req.device_id <> d.id THEN RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH'; END IF;

    v_req_role := public.zalo_assert_actor(c.company_id, req.staff_user_id);
    IF d.staff_user_id IS NOT NULL THEN
      PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
      IF d.staff_user_id <> req.staff_user_id
         AND (v_req_role <> 'BOSS_ADMIN' OR req.device_id IS DISTINCT FROM d.id) THEN
        RAISE EXCEPTION 'ZALO_REQUEST_STAFF_MISMATCH';
      END IF;
    END IF;

    IF req.status = 'FAILED' THEN RAISE EXCEPTION 'ZALO_REQUEST_FAILED'; END IF;
    IF req.status = 'EXPIRED' THEN RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED'; END IF;
    IF req.status = 'COMPLETED' THEN RAISE EXCEPTION 'ZALO_REQUEST_REUSED'; END IF;
    IF req.status NOT IN ('CALL_TRIGGERED', 'CALL_DETECTED') THEN RAISE EXCEPTION 'ZALO_REQUEST_INVALID_STATE'; END IF;
    IF c.started_at < (req.created_at - interval '30 seconds')
       OR c.started_at < (req.claimed_at - interval '30 seconds') THEN
      RAISE EXCEPTION 'ZALO_REQUEST_TIMING_INVALID';
    END IF;
    IF c.started_at > req.expires_at THEN RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.zalo_personal_calls
      WHERE outbound_request_id = req.id AND id <> c.id
    ) THEN
      RAISE EXCEPTION 'ZALO_REQUEST_REUSED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.customers WHERE id = req.customer_id AND company_id = c.company_id
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
    END IF;

    v_customer := req.customer_id;
    IF v_final_staff IS NULL AND d.staff_user_id IS NULL THEN v_final_staff := req.staff_user_id; END IF;
    UPDATE public.zalo_outbound_call_requests
    SET status = 'COMPLETED', completed_at = now()
    WHERE id = req.id;
    v_count := 1;
  END IF;

  -- Inbound/standalone calls auto-link only when the identity is unique.
  IF v_customer IS NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(c.company_id::text || c.zalo_account_key::text || c.remote_display_name_normalized, 0)
    );

    SELECT count(*), coalesce(bool_or(needs_confirmation), false)
    INTO v_count, v_ambiguous
    FROM public.zalo_customer_identity_mappings
    WHERE company_id = c.company_id
      AND zalo_account_key = c.zalo_account_key
      AND remote_display_name_normalized = c.remote_display_name_normalized
      AND active;

    SELECT count(*) INTO v_customers
    FROM public.customers
    WHERE company_id = c.company_id
      AND public.zalo_search_name(name) = public.zalo_search_name(c.remote_display_name_normalized);

    v_ambiguous := v_ambiguous OR v_count > 1 OR v_customers > 1;

    IF v_count = 1 AND NOT v_ambiguous AND c.remote_display_name_normalized <> '' THEN
      SELECT customer_id INTO v_customer
      FROM public.zalo_customer_identity_mappings
      WHERE company_id = c.company_id
        AND zalo_account_key = c.zalo_account_key
        AND remote_display_name_normalized = c.remote_display_name_normalized
        AND active;
    ELSIF v_count = 0 AND v_customers = 1 AND NOT v_ambiguous
          AND c.remote_display_name_normalized <> '' THEN
      SELECT id INTO v_customer
      FROM public.customers
      WHERE company_id = c.company_id
        AND public.zalo_search_name(name) = public.zalo_search_name(c.remote_display_name_normalized);
    END IF;
  END IF;

  UPDATE public.zalo_personal_calls
  SET recording_status = 'READY',
      transcript_status = 'PENDING',
      customer_id = v_customer,
      staff_user_id = v_final_staff,
      identity_ambiguous = v_ambiguous,
      matching_status = CASE
        WHEN v_customer IS NOT NULL THEN 'EXACT'
        WHEN v_count > 0 OR v_customers > 0 THEN 'SUGGESTED'
        ELSE 'UNMATCHED'
      END
  WHERE id = c.id;

  INSERT INTO public.zalo_call_transcriptions (company_id, call_id, customer_id, status, next_run_at)
  VALUES (c.company_id, c.id, v_customer, 'PENDING', now())
  ON CONFLICT (company_id, call_id) DO UPDATE
    SET customer_id = EXCLUDED.customer_id, updated_at = now()
    WHERE public.zalo_call_transcriptions.status IN ('PENDING', 'PROCESSING');

  INSERT INTO public.audit_logs(company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
  VALUES (
    c.company_id,
    coalesce(d.staff_user_id, req.staff_user_id),
    'ZALO_RECORDING_READY',
    'ZALO_CALL',
    c.id,
    v_customer,
    'SUCCESS',
    jsonb_build_object(
      'device_id', d.id,
      'outbound_request_id', c.outbound_request_id,
      'initiating_staff_user_id', req.staff_user_id,
      'actual_staff_user_id', d.staff_user_id,
      'auto_linked', v_customer IS NOT NULL
    )
  );

  RETURN jsonb_build_object('call_id', c.id, 'recording_id', c.id, 'duplicate', false);
END $$;

REVOKE ALL ON FUNCTION public.zalo_finish_recording(uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_finish_recording(uuid,text,uuid,uuid) TO service_role;

-- Repair only unambiguous existing calls. No name-based fuzzy merge and no synthetic customers.
WITH exact_matches AS (
  SELECT pc.id, pc.company_id, (array_agg(c.id ORDER BY c.id))[1] AS customer_id
  FROM public.zalo_personal_calls pc
  JOIN public.customers c
    ON c.company_id = pc.company_id
   AND public.zalo_search_name(c.name) = public.zalo_search_name(pc.remote_display_name_normalized)
  WHERE pc.customer_id IS NULL
    AND pc.recording_status = 'READY'
    AND pc.remote_display_name_normalized <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM public.zalo_customer_identity_mappings m
      WHERE m.company_id = pc.company_id
        AND m.zalo_account_key = pc.zalo_account_key
        AND m.remote_display_name_normalized = pc.remote_display_name_normalized
        AND m.active
    )
  GROUP BY pc.id, pc.company_id
  HAVING count(*) = 1
), linked AS (
  UPDATE public.zalo_personal_calls pc
  SET customer_id = e.customer_id,
      matching_status = 'EXACT',
      identity_ambiguous = false,
      linked_by = NULL,
      linked_at = now()
  FROM exact_matches e
  WHERE pc.id = e.id
  RETURNING pc.company_id, pc.id, pc.customer_id
)
UPDATE public.zalo_call_transcriptions t
SET customer_id = l.customer_id, updated_at = now()
FROM linked l
WHERE t.company_id = l.company_id AND t.call_id = l.id
  AND t.status IN ('PENDING', 'PROCESSING');

