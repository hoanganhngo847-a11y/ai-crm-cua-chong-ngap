-- Hardening Zalo outbound recording associations, status progression, and phone privacy.

-- 1. Replace full SELECT grant on zalo_outbound_call_requests with column-only SELECT omitting phone_normalized
REVOKE SELECT ON public.zalo_outbound_call_requests FROM authenticated;
GRANT SELECT (
  id,
  company_id,
  customer_id,
  staff_user_id,
  device_id,
  claimed_by_device_id,
  expected_display_name,
  status,
  failure_reason,
  expires_at,
  created_at,
  claimed_at,
  completed_at
) ON public.zalo_outbound_call_requests TO authenticated;

-- 2. Claim request: atomic once, device/staff scoping, replay rejection
CREATE OR REPLACE FUNCTION public.zalo_claim_outbound_call_request(
  p_device uuid,
  p_key_hash text,
  p_request_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  req public.zalo_outbound_call_requests;
  v_cust_name text;
  v_req_role text;
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices WHERE id = p_device AND active AND device_key_hash = p_key_hash FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  SELECT * INTO req FROM public.zalo_outbound_call_requests WHERE id = p_request_id AND company_id = d.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND';
  END IF;

  -- Requesting actor must have active role in company
  v_req_role := public.zalo_assert_actor(d.company_id, req.staff_user_id);

  -- Validate device staff if assigned; Boss may target any staff device if explicitly assigned to this device
  IF d.staff_user_id IS NOT NULL THEN
    PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
    IF d.staff_user_id <> req.staff_user_id THEN
      IF v_req_role <> 'BOSS_ADMIN' OR req.device_id IS DISTINCT FROM d.id THEN
        RAISE EXCEPTION 'ZALO_REQUEST_STAFF_MISMATCH';
      END IF;
    END IF;
  END IF;

  -- Device assignment check
  IF req.device_id IS NOT NULL AND req.device_id <> d.id THEN
    RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
  END IF;

  -- Expiry check at claim time
  IF req.expires_at < now() THEN
    RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
  END IF;

  -- Claim atomic once: request must be in PENDING status. Same-device replay rejected.
  IF req.status <> 'PENDING' THEN
    RAISE EXCEPTION 'ZALO_REQUEST_ALREADY_CLAIMED';
  END IF;

  UPDATE public.zalo_outbound_call_requests
  SET status = 'CLAIMED', claimed_at = now(), claimed_by_device_id = d.id
  WHERE id = req.id;

  SELECT name INTO v_cust_name FROM public.customers WHERE company_id = d.company_id AND id = req.customer_id;

  -- Return payload to authenticated claiming device including phone_normalized for dialing
  RETURN jsonb_build_object(
    'id', req.id,
    'customer_id', req.customer_id,
    'customer_name', coalesce(v_cust_name, ''),
    'phone_normalized', req.phone_normalized,
    'expected_display_name', req.expected_display_name,
    'company_id', d.company_id,
    'staff_user_id', req.staff_user_id
  );
END $$;

-- 3. Update status: forward/idempotent progression only, terminal immutable, COMPLETED blocked
CREATE OR REPLACE FUNCTION public.zalo_update_outbound_call_status(
  p_device uuid,
  p_key_hash text,
  p_request_id uuid,
  p_status text,
  p_failure_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  req public.zalo_outbound_call_requests;
  v_req_role text;
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices WHERE id = p_device AND active AND device_key_hash = p_key_hash FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  SELECT * INTO req FROM public.zalo_outbound_call_requests WHERE id = p_request_id AND company_id = d.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND';
  END IF;

  -- Must be claimed by this exact device
  IF req.claimed_by_device_id IS DISTINCT FROM d.id THEN
    RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
  END IF;

  v_req_role := public.zalo_assert_actor(d.company_id, req.staff_user_id);
  IF d.staff_user_id IS NOT NULL THEN
    PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
    IF d.staff_user_id <> req.staff_user_id THEN
      IF v_req_role <> 'BOSS_ADMIN' OR req.device_id IS DISTINCT FROM d.id THEN
        RAISE EXCEPTION 'ZALO_REQUEST_STAFF_MISMATCH';
      END IF;
    END IF;
  END IF;

  -- Client COMPLETED forbidden always; trusted recording finalization owns it
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'ZALO_STATUS_INVALID';
  END IF;

  -- Allowed statuses for agent update
  IF p_status NOT IN ('OPENING_ZALO', 'CONTACT_VERIFIED', 'CALL_TRIGGERED', 'CALL_DETECTED', 'FAILED') THEN
    RAISE EXCEPTION 'ZALO_STATUS_INVALID';
  END IF;

  -- Terminal states are immutable
  IF req.status IN ('COMPLETED', 'FAILED', 'EXPIRED') THEN
    IF req.status = p_status THEN
      RETURN jsonb_build_object('ok', true, 'status', req.status);
    END IF;
    RAISE EXCEPTION 'ZALO_STATUS_TERMINAL';
  END IF;

  -- Idempotency check for same status
  IF req.status = p_status THEN
    RETURN jsonb_build_object('ok', true, 'status', req.status);
  END IF;

  -- FAILED allowed from any non-terminal state
  IF p_status = 'FAILED' THEN
    UPDATE public.zalo_outbound_call_requests
    SET status = 'FAILED',
        failure_reason = p_failure_reason,
        completed_at = now()
    WHERE id = req.id;
    RETURN jsonb_build_object('ok', true, 'status', 'FAILED');
  END IF;

  -- Harmless async reordering: late CALL_TRIGGERED arriving when CALL_DETECTED already stored
  IF req.status = 'CALL_DETECTED' AND p_status = 'CALL_TRIGGERED' THEN
    RETURN jsonb_build_object('ok', true, 'status', req.status);
  END IF;

  -- Activation phase expiry check: non-established phases cannot advance past expires_at
  IF req.status IN ('CLAIMED', 'OPENING_ZALO', 'CONTACT_VERIFIED') THEN
    IF req.expires_at < now() THEN
      RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
    END IF;
  END IF;

  -- Legal transitions:
  -- CLAIMED -> OPENING_ZALO
  -- OPENING_ZALO -> CONTACT_VERIFIED
  -- CONTACT_VERIFIED -> CALL_TRIGGERED
  -- CONTACT_VERIFIED -> CALL_DETECTED (observed call arrives before trigger ACK)
  -- CALL_TRIGGERED -> CALL_DETECTED
  IF NOT (
    (req.status = 'CLAIMED' AND p_status = 'OPENING_ZALO') OR
    (req.status = 'OPENING_ZALO' AND p_status = 'CONTACT_VERIFIED') OR
    (req.status = 'CONTACT_VERIFIED' AND p_status IN ('CALL_TRIGGERED', 'CALL_DETECTED')) OR
    (req.status = 'CALL_TRIGGERED' AND p_status = 'CALL_DETECTED')
  ) THEN
    RAISE EXCEPTION 'ZALO_STATUS_TRANSITION_INVALID';
  END IF;

  UPDATE public.zalo_outbound_call_requests
  SET status = p_status,
      failure_reason = NULL
  WHERE id = req.id;

  RETURN jsonb_build_object('ok', true, 'status', p_status);
END $$;

-- 4. Reserve recording: strict outbound request validation, lock row, verify company/device/staff/direction/timing
CREATE OR REPLACE FUNCTION public.zalo_reserve_recording(
  p_device uuid,
  p_key_hash text,
  p_metadata jsonb,
  p_checksum text,
  p_bytes bigint,
  p_fingerprint text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  c public.zalo_personal_calls;
  req public.zalo_outbound_call_requests;
  v_id uuid;
  v_lease uuid;
  v_name text;
  v_outbound_req uuid := null;
  v_started_at timestamptz;
  v_req_role text;
  v_recording_staff uuid;
  v_call_found boolean := false;
BEGIN
  -- 1. Take device FOR UPDATE as FIRST row lock
  SELECT * INTO d FROM public.zalo_recording_devices
  WHERE id = p_device AND active AND device_key_hash = p_key_hash
  FOR UPDATE;

  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  IF d.staff_user_id IS NOT NULL THEN
    PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
  END IF;

  IF p_metadata->>'device_id' IS DISTINCT FROM p_device::text
    OR p_metadata->>'source' IS DISTINCT FROM 'ZALO_PERSONAL'
    OR (p_metadata->>'schema_version')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ZALO_INVALID_METADATA';
  END IF;

  -- 2. Parse explicit request UUID and direction
  IF p_metadata->>'crm_call_request_id' IS NOT NULL THEN
    BEGIN
      v_outbound_req := (p_metadata->>'crm_call_request_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'ZALO_REQUEST_INVALID';
    END;

    IF p_metadata->>'direction' IS DISTINCT FROM 'OUTBOUND' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DIRECTION_MISMATCH';
    END IF;
  END IF;

  -- 3. Lock call row following consistent order: Device -> Call -> Request
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_device::text||':'||(p_metadata->>'local_call_id'), 0));

  SELECT * INTO c FROM public.zalo_personal_calls
  WHERE company_id = d.company_id AND device_id = d.id AND local_call_id = (p_metadata->>'local_call_id')::uuid
  FOR UPDATE;

  IF FOUND THEN
    v_call_found := true;
    IF c.outbound_request_id IS DISTINCT FROM v_outbound_req THEN
      RAISE EXCEPTION 'ZALO_IDEMPOTENCY_CONFLICT';
    END IF;
    IF c.payload_fingerprint <> p_fingerprint OR c.recording_sha256 <> p_checksum OR c.recording_bytes <> p_bytes THEN
      RAISE EXCEPTION 'ZALO_IDEMPOTENCY_CONFLICT';
    END IF;

    -- Exact READY replay returns duplicate even if request is COMPLETED
    IF c.recording_status = 'READY' THEN
      RETURN jsonb_build_object('duplicate', true, 'call_id', c.id, 'recording_id', c.id);
    END IF;
  END IF;

  -- 4. Validate request BEFORE in_progress or new lease return
  IF v_outbound_req IS NOT NULL THEN
    SELECT * INTO req FROM public.zalo_outbound_call_requests
    WHERE id = v_outbound_req AND company_id = d.company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND';
    END IF;

    v_req_role := public.zalo_assert_actor(d.company_id, req.staff_user_id);

    IF req.claimed_at IS NULL OR req.claimed_by_device_id IS NULL THEN
      RAISE EXCEPTION 'ZALO_REQUEST_UNCLAIMED';
    END IF;

    IF req.claimed_by_device_id <> d.id THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
    END IF;

    IF req.device_id IS NOT NULL AND req.device_id <> d.id THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
    END IF;

    IF d.staff_user_id IS NOT NULL AND d.staff_user_id <> req.staff_user_id THEN
      IF v_req_role <> 'BOSS_ADMIN' OR req.device_id IS DISTINCT FROM d.id THEN
        RAISE EXCEPTION 'ZALO_REQUEST_STAFF_MISMATCH';
      END IF;
    END IF;

    IF req.status = 'FAILED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_FAILED';
    END IF;
    IF req.status = 'EXPIRED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
    END IF;
    IF req.status = 'COMPLETED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_REUSED';
    END IF;
    IF req.status NOT IN ('CALL_TRIGGERED', 'CALL_DETECTED') THEN
      RAISE EXCEPTION 'ZALO_REQUEST_INVALID_STATE';
    END IF;

    IF EXISTS(
      SELECT 1 FROM public.zalo_personal_calls
      WHERE outbound_request_id = v_outbound_req
        AND (device_id <> d.id OR local_call_id <> (p_metadata->>'local_call_id')::uuid)
    ) THEN
      RAISE EXCEPTION 'ZALO_REQUEST_REUSED';
    END IF;

    v_started_at := (p_metadata->>'started_at')::timestamptz;
    IF v_started_at < (req.created_at - interval '30 seconds') OR v_started_at < (req.claimed_at - interval '30 seconds') THEN
      RAISE EXCEPTION 'ZALO_REQUEST_TIMING_INVALID';
    END IF;
    IF v_started_at > req.expires_at THEN
      RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
    END IF;
  END IF;

  -- 5. Existing non-READY call: verify stored fields before in_progress / lease grant
  IF v_call_found THEN
    IF v_outbound_req IS NOT NULL THEN
      IF c.direction IS DISTINCT FROM 'OUTBOUND' THEN
        RAISE EXCEPTION 'ZALO_REQUEST_DIRECTION_MISMATCH';
      END IF;
      IF c.started_at < (req.created_at - interval '30 seconds') OR c.started_at < (req.claimed_at - interval '30 seconds') THEN
        RAISE EXCEPTION 'ZALO_REQUEST_TIMING_INVALID';
      END IF;
      IF c.started_at > req.expires_at THEN
        RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
      END IF;
    END IF;

    IF c.upload_lease_until > now() THEN
      RETURN jsonb_build_object('in_progress', true);
    END IF;

    v_lease := gen_random_uuid();
    UPDATE public.zalo_personal_calls
    SET upload_lease = v_lease, upload_lease_until = now() + interval '5 minutes'
    WHERE id = c.id;

    UPDATE public.zalo_recording_devices SET last_seen_at = now() WHERE id = d.id;

    RETURN jsonb_build_object('duplicate', false, 'call_id', c.id, 'recording_id', c.id, 'lease', v_lease, 'path', c.recording_path);
  END IF;

  -- 6. New call creation
  v_recording_staff := coalesce(d.staff_user_id, CASE WHEN v_outbound_req IS NOT NULL THEN req.staff_user_id ELSE NULL END);
  v_id := gen_random_uuid();
  v_lease := gen_random_uuid();
  v_name := nullif(btrim(p_metadata->>'remote_display_name'), '');

  INSERT INTO public.zalo_personal_calls(
    id, company_id, device_id, local_call_id, staff_user_id, zalo_account_key,
    direction, remote_display_name, remote_display_name_normalized, identity_confidence,
    started_at, answered_at, ended_at, duration_seconds, agent_version, audio_validation,
    recording_path, recording_bytes, recording_sha256, payload_fingerprint,
    upload_lease, upload_lease_until, outbound_request_id
  )
  VALUES (
    v_id, d.company_id, d.id, (p_metadata->>'local_call_id')::uuid, v_recording_staff, d.zalo_account_key,
    p_metadata->>'direction', v_name, public.zalo_normalize_display_name(v_name),
    CASE WHEN v_name IS NULL THEN 'UNKNOWN' ELSE 'MEDIUM' END,
    (p_metadata->>'started_at')::timestamptz, (p_metadata->>'answered_at')::timestamptz, (p_metadata->>'ended_at')::timestamptz,
    (p_metadata->>'duration_seconds')::double precision, p_metadata->>'agent_version', p_metadata->'audio_validation',
    'company/'||d.company_id||'/zalo/'||to_char((p_metadata->>'started_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY/MM')||'/'||v_id||'.m4a',
    p_bytes, p_checksum, p_fingerprint,
    v_lease, now() + interval '5 minutes', v_outbound_req
  ) RETURNING * INTO c;

  UPDATE public.zalo_recording_devices SET last_seen_at = now() WHERE id = d.id;

  RETURN jsonb_build_object('duplicate', false, 'call_id', c.id, 'recording_id', c.id, 'lease', v_lease, 'path', c.recording_path);
END $$;

-- 5. Finish recording: revalidate request row, atomic update & audit log
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
  -- 1. Take device FOR UPDATE as FIRST row lock
  SELECT * INTO d FROM public.zalo_recording_devices
  WHERE id = p_device AND active AND device_key_hash = p_key_hash
  FOR UPDATE;

  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  IF d.staff_user_id IS NOT NULL THEN
    PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
  END IF;

  -- 2. Lock call row FOR UPDATE
  SELECT * INTO c FROM public.zalo_personal_calls
  WHERE id = p_call AND company_id = d.company_id AND device_id = d.id
  FOR UPDATE;

  IF NOT FOUND OR c.upload_lease <> p_lease THEN
    RAISE EXCEPTION 'ZALO_LEASE_LOST';
  END IF;

  IF c.recording_status = 'READY' THEN
    RETURN jsonb_build_object('call_id', c.id, 'recording_id', c.id, 'duplicate', true);
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'zalo-call-recordings'
      AND name = c.recording_path
      AND (metadata->>'size')::bigint = c.recording_bytes
  ) THEN
    RAISE EXCEPTION 'ZALO_OBJECT_MISSING';
  END IF;

  v_final_staff := c.staff_user_id;

  -- 3. Direct attachment from verified outbound request
  IF c.outbound_request_id IS NOT NULL THEN
    SELECT * INTO req FROM public.zalo_outbound_call_requests
    WHERE id = c.outbound_request_id AND company_id = c.company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND';
    END IF;

    IF c.direction IS DISTINCT FROM 'OUTBOUND' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DIRECTION_MISMATCH';
    END IF;

    IF req.claimed_at IS NULL OR req.claimed_by_device_id IS NULL THEN
      RAISE EXCEPTION 'ZALO_REQUEST_UNCLAIMED';
    END IF;

    IF req.claimed_by_device_id <> d.id THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
    END IF;

    IF req.device_id IS NOT NULL AND req.device_id <> d.id THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
    END IF;

    v_req_role := public.zalo_assert_actor(c.company_id, req.staff_user_id);
    IF d.staff_user_id IS NOT NULL THEN
      PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
      IF d.staff_user_id <> req.staff_user_id THEN
        IF v_req_role <> 'BOSS_ADMIN' OR req.device_id IS DISTINCT FROM d.id THEN
          RAISE EXCEPTION 'ZALO_REQUEST_STAFF_MISMATCH';
        END IF;
      END IF;
    END IF;

    IF req.status = 'FAILED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_FAILED';
    END IF;
    IF req.status = 'EXPIRED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
    END IF;
    IF req.status = 'COMPLETED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_REUSED';
    END IF;
    IF req.status NOT IN ('CALL_TRIGGERED', 'CALL_DETECTED') THEN
      RAISE EXCEPTION 'ZALO_REQUEST_INVALID_STATE';
    END IF;

    IF c.started_at < (req.created_at - interval '30 seconds') OR c.started_at < (req.claimed_at - interval '30 seconds') THEN
      RAISE EXCEPTION 'ZALO_REQUEST_TIMING_INVALID';
    END IF;
    IF c.started_at > req.expires_at THEN
      RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
    END IF;

    IF EXISTS(
      SELECT 1 FROM public.zalo_personal_calls
      WHERE outbound_request_id = req.id
        AND id <> c.id
    ) THEN
      RAISE EXCEPTION 'ZALO_REQUEST_REUSED';
    END IF;

    IF NOT EXISTS(SELECT 1 FROM public.customers WHERE id = req.customer_id AND company_id = c.company_id) THEN
      RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
    END IF;

    v_customer := req.customer_id;

    -- Fill legacy shared outbound staff ONLY when device staff is null and call staff is null
    IF v_final_staff IS NULL AND d.staff_user_id IS NULL THEN
      v_final_staff := req.staff_user_id;
    END IF;

    UPDATE public.zalo_outbound_call_requests
    SET status = 'COMPLETED', completed_at = now()
    WHERE id = req.id;

    v_ambiguous := false;
    v_count := 1;
  END IF;

  -- 4. Fallback to confirmed mappings / name suggestions for inbound or standalone calls
  IF v_customer IS NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.company_id::text||c.zalo_account_key::text||c.remote_display_name_normalized, 0));
    SELECT count(*), coalesce(bool_or(needs_confirmation), false) INTO v_count, v_ambiguous
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
    END IF;
  END IF;

  -- 5. Atomic state transition and audit logging
  UPDATE public.zalo_personal_calls
  SET recording_status = 'READY',
      customer_id = v_customer,
      staff_user_id = v_final_staff,
      identity_ambiguous = v_ambiguous,
      matching_status = CASE
        WHEN v_customer IS NOT NULL THEN 'EXACT'
        WHEN v_count > 0 OR v_customers > 0 THEN 'SUGGESTED'
        ELSE 'UNMATCHED'
      END
  WHERE id = c.id;

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
      'actual_staff_user_id', d.staff_user_id
    )
  );

  RETURN jsonb_build_object('call_id', c.id, 'recording_id', c.id, 'duplicate', false);
END $$;

-- 6. Create request: validate target device active/same company, Sale eligibility, account-scoped name mapping
CREATE OR REPLACE FUNCTION public.zalo_create_outbound_call_request(
  p_company uuid,
  p_actor uuid,
  p_customer uuid,
  p_device uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_role text;
  v_cust_name text;
  v_cust_phone text;
  v_mapping text;
  v_expected_name text;
  v_req_id uuid;
  v_target_dev public.zalo_recording_devices;
BEGIN
  v_role := public.zalo_assert_actor(p_company, p_actor);
  SELECT name INTO v_cust_name FROM public.customers WHERE company_id = p_company AND id = p_customer;
  IF v_cust_name IS NULL THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND' USING ERRCODE='42501'; END IF;

  -- Validate target device if explicitly specified
  IF p_device IS NOT NULL THEN
    SELECT * INTO v_target_dev
    FROM public.zalo_recording_devices
    WHERE id = p_device AND company_id = p_company AND active;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
    END IF;

    IF v_target_dev.staff_user_id IS NOT NULL THEN
      PERFORM public.zalo_assert_actor(p_company, v_target_dev.staff_user_id);
    END IF;

    IF v_role = 'SALE' THEN
      IF v_target_dev.staff_user_id IS NOT NULL AND v_target_dev.staff_user_id <> p_actor THEN
        RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
      END IF;
    END IF;
  END IF;

  -- Look up customer phone from private contacts
  SELECT normalized_phone INTO v_cust_phone
  FROM private.customer_private_contacts
  WHERE company_id = p_company AND customer_id = p_customer
  ORDER BY is_verified DESC, created_at DESC LIMIT 1;

  -- Scope confirmed mapping to selected device account key; fallback to CRM customer name
  IF p_device IS NOT NULL AND v_target_dev.zalo_account_key IS NOT NULL THEN
    SELECT remote_display_name_original INTO v_mapping
    FROM public.zalo_customer_identity_mappings
    WHERE company_id = p_company
      AND customer_id = p_customer
      AND zalo_account_key = v_target_dev.zalo_account_key
      AND active
      AND NOT needs_confirmation
    ORDER BY confirmed_at DESC LIMIT 1;

    v_expected_name := coalesce(v_mapping, v_cust_name);
  ELSE
    v_expected_name := v_cust_name;
  END IF;

  v_req_id := gen_random_uuid();

  INSERT INTO public.zalo_outbound_call_requests(
    id, company_id, customer_id, staff_user_id, device_id, phone_normalized, expected_display_name, status, expires_at
  )
  VALUES (
    v_req_id, p_company, p_customer, p_actor, p_device, nullif(btrim(v_cust_phone), ''), v_expected_name, 'PENDING', now() + interval '5 minutes'
  );

  INSERT INTO public.audit_logs(company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
  VALUES(p_company, p_actor, 'ZALO_OUTBOUND_REQUEST_CREATED', 'ZALO_OUTBOUND_REQUEST', v_req_id, p_customer, 'SUCCESS',
    jsonb_build_object('expected_display_name', v_expected_name, 'device_id', p_device));

  RETURN jsonb_build_object(
    'request_id', v_req_id,
    'customer_id', p_customer,
    'customer_name', v_cust_name,
    'phone', nullif(btrim(v_cust_phone), ''),
    'expected_display_name', v_expected_name,
    'expires_at', (now() + interval '5 minutes')
  );
END $$;

-- 7. Devices readiness: filtered by role (SALE sees own/shared only, BOSS sees all)
CREATE OR REPLACE FUNCTION public.zalo_get_devices_readiness(
  p_company uuid,
  p_actor uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_role text;
  v_devices jsonb;
BEGIN
  v_role := public.zalo_assert_actor(p_company, p_actor);

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', d.id,
      'device_name', d.device_name,
      'staff_user_id', d.staff_user_id,
      'is_current_staff', (d.staff_user_id = p_actor),
      'active', d.active,
      'agent_version', d.agent_version,
      'raw_status', d.agent_status,
      'computed_status', CASE
        WHEN NOT d.active THEN 'OFFLINE'
        WHEN d.last_seen_at IS NULL OR d.last_seen_at < (now() - interval '2 minutes') THEN 'OFFLINE'
        WHEN NOT d.permissions_ok OR NOT d.loopback_ready OR d.agent_status = 'DEGRADED' THEN 'DEGRADED'
        ELSE 'ONLINE'
      END,
      'zalo_running', d.zalo_running,
      'permissions_ok', d.permissions_ok,
      'permissions_detail', d.permissions_detail,
      'loopback_ready', d.loopback_ready,
      'last_error_code', d.last_error_code,
      'last_error_at', d.last_error_at,
      'last_seen_at', d.last_seen_at,
      'created_at', d.created_at
    ) ORDER BY
      (d.staff_user_id IS NOT NULL AND d.staff_user_id = p_actor) DESC,
      (d.last_seen_at >= now() - interval '2 minutes' AND d.agent_status = 'ONLINE') DESC,
      d.last_seen_at DESC NULLS LAST,
      d.created_at DESC
  ), '[]'::jsonb) INTO v_devices
  FROM public.zalo_recording_devices d
  WHERE d.company_id = p_company
    AND d.active
    AND (v_role = 'BOSS_ADMIN' OR d.staff_user_id = p_actor OR d.staff_user_id IS NULL);

  RETURN jsonb_build_object(
    'ok', true,
    'devices', v_devices
  );
END $$;

-- 8. Explicitly reassert service-role-only RPC execution
REVOKE ALL ON FUNCTION public.zalo_create_outbound_call_request(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zalo_claim_outbound_call_request(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zalo_update_outbound_call_status(uuid,text,uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zalo_reserve_recording(uuid,text,jsonb,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zalo_finish_recording(uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zalo_get_devices_readiness(uuid,uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.zalo_create_outbound_call_request(uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.zalo_claim_outbound_call_request(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.zalo_update_outbound_call_status(uuid,text,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.zalo_reserve_recording(uuid,text,jsonb,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.zalo_finish_recording(uuid,text,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.zalo_get_devices_readiness(uuid,uuid) TO service_role;

NOTIFY pgrst,'reload schema';
