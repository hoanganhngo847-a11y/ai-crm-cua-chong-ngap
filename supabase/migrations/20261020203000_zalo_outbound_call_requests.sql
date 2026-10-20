-- Additive Zalo Personal outbound click-to-call request domain.
-- Extends Zalo Personal with server-created short-lived call requests and device claim RPCs.

CREATE TABLE public.zalo_outbound_call_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  customer_id uuid NOT NULL,
  staff_user_id uuid NOT NULL,
  device_id uuid,
  claimed_by_device_id uuid,
  phone_normalized text,
  expected_display_name text,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CLAIMED','OPENING_ZALO','CONTACT_VERIFIED','CALL_TRIGGERED','CALL_DETECTED','COMPLETED','FAILED','EXPIRED')),
  failure_reason text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  UNIQUE(company_id, id),
  FOREIGN KEY(company_id, customer_id) REFERENCES public.customers(company_id, id),
  FOREIGN KEY(company_id, staff_user_id) REFERENCES public.company_members(company_id, user_id),
  FOREIGN KEY(company_id, device_id) REFERENCES public.zalo_recording_devices(company_id, id),
  FOREIGN KEY(company_id, claimed_by_device_id) REFERENCES public.zalo_recording_devices(company_id, id)
);

CREATE INDEX ON public.zalo_outbound_call_requests(company_id, created_at DESC);
CREATE INDEX ON public.zalo_outbound_call_requests(company_id, customer_id);
CREATE INDEX ON public.zalo_outbound_call_requests(expires_at) WHERE status = 'PENDING';

ALTER TABLE public.zalo_personal_calls
  ADD COLUMN IF NOT EXISTS outbound_request_id uuid REFERENCES public.zalo_outbound_call_requests(id);
CREATE INDEX IF NOT EXISTS zalo_personal_calls_outbound_req_idx ON public.zalo_personal_calls(company_id, outbound_request_id);

ALTER TABLE public.zalo_outbound_call_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zalo_outbound_call_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zalo_outbound_call_requests TO service_role;
GRANT SELECT ON public.zalo_outbound_call_requests TO authenticated;

CREATE POLICY zalo_outbound_call_requests_read ON public.zalo_outbound_call_requests FOR SELECT TO authenticated USING (
  public.has_company_role(company_id, 'BOSS_ADMIN') OR
  (public.has_company_role(company_id, 'SALE') AND staff_user_id = auth.uid())
);

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
BEGIN
  v_role := public.zalo_assert_actor(p_company, p_actor);
  SELECT name INTO v_cust_name FROM public.customers WHERE company_id = p_company AND id = p_customer;
  IF v_cust_name IS NULL THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND' USING ERRCODE='42501'; END IF;

  -- Look up customer phone from private contacts
  SELECT normalized_phone INTO v_cust_phone
  FROM private.customer_private_contacts
  WHERE company_id = p_company AND customer_id = p_customer
  ORDER BY is_verified DESC, created_at DESC LIMIT 1;

  -- Prefer confirmed Zalo mapping if available, otherwise CRM customer name
  SELECT remote_display_name_original INTO v_mapping
  FROM public.zalo_customer_identity_mappings
  WHERE company_id = p_company AND customer_id = p_customer AND active AND NOT needs_confirmation
  ORDER BY confirmed_at DESC LIMIT 1;

  v_expected_name := coalesce(v_mapping, v_cust_name);
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
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices WHERE id = p_device AND active AND device_key_hash = p_key_hash FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;
  IF d.staff_user_id IS NOT NULL THEN PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id); END IF;

  SELECT * INTO req FROM public.zalo_outbound_call_requests WHERE id = p_request_id AND company_id = d.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND'; END IF;

  IF req.expires_at < now() THEN
    UPDATE public.zalo_outbound_call_requests SET status = 'EXPIRED' WHERE id = req.id;
    RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
  END IF;

  IF req.status NOT IN ('PENDING', 'CLAIMED') OR (req.claimed_by_device_id IS NOT NULL AND req.claimed_by_device_id <> d.id) THEN
    RAISE EXCEPTION 'ZALO_REQUEST_ALREADY_CLAIMED';
  END IF;

  IF req.device_id IS NOT NULL AND req.device_id <> d.id THEN
    RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
  END IF;

  UPDATE public.zalo_outbound_call_requests
  SET status = 'CLAIMED', claimed_at = coalesce(claimed_at, now()), claimed_by_device_id = d.id
  WHERE id = req.id;

  SELECT name INTO v_cust_name FROM public.customers WHERE company_id = d.company_id AND id = req.customer_id;

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
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices WHERE id = p_device AND active AND device_key_hash = p_key_hash FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  SELECT * INTO req FROM public.zalo_outbound_call_requests WHERE id = p_request_id AND company_id = d.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND'; END IF;

  IF req.claimed_by_device_id IS DISTINCT FROM d.id THEN
    RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
  END IF;

  UPDATE public.zalo_outbound_call_requests
  SET status = p_status,
      failure_reason = p_failure_reason,
      completed_at = CASE WHEN p_status IN ('COMPLETED', 'FAILED', 'EXPIRED') THEN now() ELSE completed_at END
  WHERE id = req.id;

  RETURN jsonb_build_object('ok', true, 'status', p_status);
END $$;

-- Update reserve_recording to handle optional crm_call_request_id
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
  v_id uuid;
  v_lease uuid;
  v_name text;
  v_outbound_req uuid := null;
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices WHERE id=p_device AND active AND device_key_hash=p_key_hash FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=d.company_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;
  IF d.staff_user_id IS NOT NULL THEN PERFORM public.zalo_assert_actor(d.company_id,d.staff_user_id); END IF;
  IF p_metadata->>'device_id' IS DISTINCT FROM p_device::text OR p_metadata->>'source' IS DISTINCT FROM 'ZALO_PERSONAL'
    OR (p_metadata->>'schema_version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'ZALO_INVALID_METADATA'; END IF;

  -- Validate optional outbound request association
  IF p_metadata->>'crm_call_request_id' IS NOT NULL THEN
    BEGIN
      v_outbound_req := (p_metadata->>'crm_call_request_id')::uuid;
      IF NOT EXISTS(SELECT 1 FROM public.zalo_outbound_call_requests WHERE id = v_outbound_req AND company_id = d.company_id) THEN
        v_outbound_req := null;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_outbound_req := null;
    END;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_device::text||':'||(p_metadata->>'local_call_id'),0));
  SELECT * INTO c FROM public.zalo_personal_calls WHERE company_id=d.company_id AND device_id=d.id AND local_call_id=(p_metadata->>'local_call_id')::uuid FOR UPDATE;
  IF FOUND THEN
    IF c.payload_fingerprint<>p_fingerprint OR c.recording_sha256<>p_checksum OR c.recording_bytes<>p_bytes THEN RAISE EXCEPTION 'ZALO_IDEMPOTENCY_CONFLICT'; END IF;
    IF c.recording_status='READY' THEN RETURN jsonb_build_object('duplicate',true,'call_id',c.id,'recording_id',c.id); END IF;
    IF c.upload_lease_until>now() THEN RETURN jsonb_build_object('in_progress',true); END IF;
    v_lease:=gen_random_uuid();
    UPDATE public.zalo_personal_calls SET upload_lease=v_lease,upload_lease_until=now()+interval '5 minutes' WHERE id=c.id;
    RETURN jsonb_build_object('duplicate',false,'call_id',c.id,'recording_id',c.id,'lease',v_lease,'path',c.recording_path);
  END IF;
  v_id:=gen_random_uuid(); v_lease:=gen_random_uuid(); v_name:=nullif(btrim(p_metadata->>'remote_display_name'),'');
  INSERT INTO public.zalo_personal_calls(id,company_id,device_id,local_call_id,staff_user_id,zalo_account_key,
    direction,remote_display_name,remote_display_name_normalized,identity_confidence,started_at,answered_at,ended_at,
    duration_seconds,agent_version,audio_validation,recording_path,recording_bytes,recording_sha256,payload_fingerprint,upload_lease,upload_lease_until,outbound_request_id)
  VALUES(v_id,d.company_id,d.id,(p_metadata->>'local_call_id')::uuid,d.staff_user_id,d.zalo_account_key,
    p_metadata->>'direction',v_name,public.zalo_normalize_display_name(v_name),CASE WHEN v_name IS NULL THEN 'UNKNOWN' ELSE 'MEDIUM' END,
    (p_metadata->>'started_at')::timestamptz,(p_metadata->>'answered_at')::timestamptz,(p_metadata->>'ended_at')::timestamptz,
    (p_metadata->>'duration_seconds')::double precision,p_metadata->>'agent_version',p_metadata->'audio_validation',
    'company/'||d.company_id||'/zalo/'||to_char((p_metadata->>'started_at')::timestamptz AT TIME ZONE 'UTC','YYYY/MM')||'/'||v_id||'.m4a',
    p_bytes,p_checksum,p_fingerprint,v_lease,now()+interval '5 minutes',v_outbound_req) RETURNING * INTO c;
  UPDATE public.zalo_recording_devices SET last_seen_at=now() WHERE id=d.id;
  RETURN jsonb_build_object('duplicate',false,'call_id',c.id,'recording_id',c.id,'lease',v_lease,'path',c.recording_path);
END $$;

-- Update finish_recording to directly attach customer when outbound_request_id is known
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
  v_count int := 0;
  v_customers int := 0;
  v_customer uuid := null;
  v_ambiguous boolean := false;
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices WHERE id=p_device AND active AND device_key_hash=p_key_hash FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=d.company_id AND status='ACTIVE') THEN RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501'; END IF;
  IF d.staff_user_id IS NOT NULL THEN PERFORM public.zalo_assert_actor(d.company_id,d.staff_user_id); END IF;
  SELECT * INTO c FROM public.zalo_personal_calls WHERE id=p_call AND company_id=d.company_id AND device_id=d.id FOR UPDATE;
  IF NOT FOUND OR c.upload_lease<>p_lease THEN RAISE EXCEPTION 'ZALO_LEASE_LOST'; END IF;
  IF c.recording_status='READY' THEN RETURN jsonb_build_object('call_id',c.id,'recording_id',c.id,'duplicate',true); END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='zalo-call-recordings' AND name=c.recording_path
    AND (metadata->>'size')::bigint=c.recording_bytes) THEN RAISE EXCEPTION 'ZALO_OBJECT_MISSING'; END IF;

  -- 1. Direct attachment from verified outbound request (zero heuristic / zero ambiguity needed)
  IF c.outbound_request_id IS NOT NULL THEN
    SELECT customer_id INTO v_customer FROM public.zalo_outbound_call_requests
    WHERE id = c.outbound_request_id AND company_id = c.company_id;
    IF v_customer IS NOT NULL THEN
      UPDATE public.zalo_outbound_call_requests
      SET status = 'COMPLETED', completed_at = now()
      WHERE id = c.outbound_request_id;
      v_ambiguous := false;
      v_count := 1;
    END IF;
  END IF;

  -- 2. Fallback to confirmed mappings / name suggestions for inbound or standalone calls
  IF v_customer IS NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.company_id::text||c.zalo_account_key::text||c.remote_display_name_normalized,0));
    SELECT count(*),coalesce(bool_or(needs_confirmation),false) INTO v_count,v_ambiguous FROM public.zalo_customer_identity_mappings
      WHERE company_id=c.company_id AND zalo_account_key=c.zalo_account_key AND remote_display_name_normalized=c.remote_display_name_normalized AND active;
    SELECT count(*) INTO v_customers FROM public.customers WHERE company_id=c.company_id AND public.zalo_search_name(name)=public.zalo_search_name(c.remote_display_name_normalized);
    v_ambiguous:=v_ambiguous OR v_count>1 OR v_customers>1;
    IF v_count=1 AND NOT v_ambiguous AND c.remote_display_name_normalized<>'' THEN
      SELECT customer_id INTO v_customer FROM public.zalo_customer_identity_mappings WHERE company_id=c.company_id AND zalo_account_key=c.zalo_account_key AND remote_display_name_normalized=c.remote_display_name_normalized AND active;
    END IF;
  END IF;

  UPDATE public.zalo_personal_calls SET recording_status='READY',customer_id=v_customer,identity_ambiguous=v_ambiguous,
    matching_status=CASE WHEN v_customer IS NOT NULL THEN 'EXACT' WHEN v_count>0 OR v_customers>0 THEN 'SUGGESTED' ELSE 'UNMATCHED' END WHERE id=c.id;
  INSERT INTO public.audit_logs(company_id,user_id,action,resource_type,resource_id,customer_id,result,metadata)
    VALUES(c.company_id,d.staff_user_id,'ZALO_RECORDING_READY','ZALO_CALL',c.id,v_customer,'SUCCESS',
      jsonb_build_object('device_id',d.id,'outbound_request_id',c.outbound_request_id));
  RETURN jsonb_build_object('call_id',c.id,'recording_id',c.id,'duplicate',false);
END $$;

REVOKE ALL ON FUNCTION public.zalo_create_outbound_call_request(uuid,uuid,uuid,uuid),
  public.zalo_claim_outbound_call_request(uuid,text,uuid),
  public.zalo_update_outbound_call_status(uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_create_outbound_call_request(uuid,uuid,uuid,uuid),
  public.zalo_claim_outbound_call_request(uuid,text,uuid),
  public.zalo_update_outbound_call_status(uuid,text,uuid,text,text) TO service_role;

NOTIFY pgrst,'reload schema';
