-- Additive Zalo Personal recording domain. Existing calls/Stringee/media jobs stay unchanged.
-- Account keys are administrator-declared local account contexts, NEVER Zalo UIDs.
CREATE FUNCTION public.zalo_normalize_display_name(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT lower(btrim(regexp_replace(normalize(coalesce(p_value, ''), NFKC), '[[:space:]]+', ' ', 'g')))
$$;
CREATE FUNCTION public.zalo_search_name(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT translate(regexp_replace(normalize(public.zalo_normalize_display_name(p_value), NFD),'[̀-ͯ]','','g'),'đ','d')
$$;

CREATE TABLE public.zalo_recording_devices (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  staff_user_id uuid,
  device_name text NOT NULL CHECK (length(btrim(device_name)) BETWEEN 1 AND 100),
  zalo_account_key uuid NOT NULL DEFAULT gen_random_uuid(),
  device_key_hash text NOT NULL CHECK (device_key_hash ~ '^[a-f0-9]{64}$'),
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,staff_user_id) REFERENCES public.company_members(company_id,user_id)
);

CREATE TABLE public.zalo_personal_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  device_id uuid NOT NULL,
  local_call_id uuid NOT NULL,
  staff_user_id uuid,
  zalo_account_key uuid NOT NULL,
  customer_id uuid,
  channel text NOT NULL DEFAULT 'ZALO_PERSONAL' CHECK(channel='ZALO_PERSONAL'),
  source text NOT NULL DEFAULT 'LOCAL_AGENT' CHECK(source='LOCAL_AGENT'),
  direction text NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND','UNKNOWN')),
  remote_display_name text CHECK(length(remote_display_name) BETWEEN 1 AND 200),
  remote_display_name_normalized text NOT NULL,
  remote_identity_type text NOT NULL DEFAULT 'DISPLAY_NAME_ONLY' CHECK(remote_identity_type='DISPLAY_NAME_ONLY'),
  identity_confidence text NOT NULL CHECK(identity_confidence IN ('MEDIUM','UNKNOWN')),
  started_at timestamptz NOT NULL,
  answered_at timestamptz,
  ended_at timestamptz NOT NULL,
  duration_seconds double precision NOT NULL CHECK(duration_seconds > 0 AND duration_seconds <= 7200),
  agent_version text NOT NULL CHECK(length(agent_version) BETWEEN 1 AND 40),
  audio_validation jsonb NOT NULL,
  recording_status text NOT NULL DEFAULT 'UPLOADING' CHECK(recording_status IN ('UPLOADING','READY')),
  recording_path text NOT NULL UNIQUE,
  recording_mime text NOT NULL DEFAULT 'audio/mp4' CHECK(recording_mime='audio/mp4'),
  recording_bytes bigint NOT NULL CHECK(recording_bytes BETWEEN 1 AND 52428800),
  recording_sha256 text NOT NULL CHECK(recording_sha256 ~ '^[a-f0-9]{64}$'),
  payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[a-f0-9]{64}$'),
  upload_lease uuid NOT NULL,
  upload_lease_until timestamptz NOT NULL,
  matching_status text NOT NULL DEFAULT 'UNMATCHED' CHECK(matching_status IN ('EXACT','SUGGESTED','UNMATCHED')),
  identity_ambiguous boolean NOT NULL DEFAULT false,
  linked_by uuid REFERENCES public.user_profiles(id),
  linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id),
  UNIQUE(company_id,device_id,local_call_id),
  FOREIGN KEY(company_id,device_id) REFERENCES public.zalo_recording_devices(company_id,id),
  FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id),
  FOREIGN KEY(company_id,staff_user_id) REFERENCES public.company_members(company_id,user_id),
  CHECK(ended_at >= started_at AND (answered_at IS NULL OR answered_at BETWEEN started_at AND ended_at)),
  CHECK(abs(extract(epoch FROM ended_at-started_at)-duration_seconds) <= 2)
);
CREATE INDEX ON public.zalo_personal_calls(company_id,started_at DESC);
CREATE INDEX ON public.zalo_personal_calls(company_id,customer_id);

CREATE TABLE public.zalo_customer_identity_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  zalo_account_key uuid NOT NULL,
  remote_display_name_original text NOT NULL,
  remote_display_name_normalized text NOT NULL CHECK(length(remote_display_name_normalized)>0),
  customer_id uuid NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES public.user_profiles(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  needs_confirmation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id),
  UNIQUE(company_id,zalo_account_key,remote_display_name_normalized,customer_id)
);
CREATE INDEX ON public.zalo_customer_identity_mappings(company_id,zalo_account_key,remote_display_name_normalized) WHERE active;

ALTER TABLE public.zalo_recording_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_personal_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_customer_identity_mappings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zalo_recording_devices, public.zalo_personal_calls, public.zalo_customer_identity_mappings FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.zalo_recording_devices, public.zalo_personal_calls, public.zalo_customer_identity_mappings TO service_role;
GRANT SELECT(id,company_id,device_id,customer_id,staff_user_id,channel,source,direction,remote_display_name,
  remote_identity_type,identity_confidence,started_at,answered_at,ended_at,duration_seconds,recording_status,
  matching_status,identity_ambiguous,created_at) ON public.zalo_personal_calls TO authenticated;
CREATE POLICY zalo_personal_calls_read ON public.zalo_personal_calls FOR SELECT TO authenticated USING (
  public.has_company_role(company_id,'BOSS_ADMIN') OR
  (public.has_company_role(company_id,'SALE') AND staff_user_id=auth.uid())
);

-- Dedicated bucket: no browser Storage policies, all access through authorized server endpoints.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('zalo-call-recordings','zalo-call-recordings',false,52428800,ARRAY['audio/mp4'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
CREATE POLICY zalo_recording_server_only ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated
  USING(bucket_id<>'zalo-call-recordings') WITH CHECK(bucket_id<>'zalo-call-recordings');

CREATE FUNCTION public.zalo_assert_actor(p_company uuid,p_actor uuid,p_boss_only boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_role text;
BEGIN
  SELECT m.role INTO v_role FROM public.company_members m
  JOIN public.user_profiles u ON u.id=m.user_id JOIN public.companies c ON c.id=m.company_id
  WHERE m.company_id=p_company AND m.user_id=p_actor AND m.status='ACTIVE' AND u.status='ACTIVE' AND c.status='ACTIVE';
  IF v_role IS NULL OR v_role NOT IN ('BOSS_ADMIN','SALE') OR (p_boss_only AND v_role<>'BOSS_ADMIN') THEN
    RAISE EXCEPTION 'ZALO_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN v_role;
END $$;

CREATE FUNCTION public.zalo_manage_device(p_company uuid,p_actor uuid,p_device uuid,p_name text,p_hash text,p_staff uuid DEFAULT NULL,p_revoke boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.zalo_assert_actor(p_company,p_actor,true);
  IF p_revoke THEN
    UPDATE public.zalo_recording_devices SET active=false WHERE company_id=p_company AND id=p_device;
    IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_NOT_FOUND'; END IF;
  ELSE
    IF p_staff IS NOT NULL THEN PERFORM public.zalo_assert_actor(p_company,p_staff); END IF;
    -- Re-registration never mutates an account context or silently reactivates a revoked credential.
    INSERT INTO public.zalo_recording_devices(id,company_id,staff_user_id,device_name,device_key_hash)
    VALUES(p_device,p_company,p_staff,p_name,p_hash);
  END IF;
  INSERT INTO public.audit_logs(company_id,user_id,action,resource_type,resource_id,result,metadata)
  VALUES(p_company,p_actor,CASE WHEN p_revoke THEN 'ZALO_DEVICE_REVOKED' ELSE 'ZALO_DEVICE_REGISTERED' END,'ZALO_DEVICE',p_device,'SUCCESS','{}');
  RETURN p_device;
END $$;

CREATE FUNCTION public.zalo_reserve_recording(p_device uuid,p_key_hash text,p_metadata jsonb,p_checksum text,p_bytes bigint,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.zalo_recording_devices; c public.zalo_personal_calls; v_id uuid; v_lease uuid; v_name text;
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices WHERE id=p_device AND active AND device_key_hash=p_key_hash FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=d.company_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;
  IF d.staff_user_id IS NOT NULL THEN PERFORM public.zalo_assert_actor(d.company_id,d.staff_user_id); END IF;
  IF p_metadata->>'device_id' IS DISTINCT FROM p_device::text OR p_metadata->>'source' IS DISTINCT FROM 'ZALO_PERSONAL'
    OR (p_metadata->>'schema_version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'ZALO_INVALID_METADATA'; END IF;
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
    duration_seconds,agent_version,audio_validation,recording_path,recording_bytes,recording_sha256,payload_fingerprint,upload_lease,upload_lease_until)
  VALUES(v_id,d.company_id,d.id,(p_metadata->>'local_call_id')::uuid,d.staff_user_id,d.zalo_account_key,
    p_metadata->>'direction',v_name,public.zalo_normalize_display_name(v_name),CASE WHEN v_name IS NULL THEN 'UNKNOWN' ELSE 'MEDIUM' END,
    (p_metadata->>'started_at')::timestamptz,(p_metadata->>'answered_at')::timestamptz,(p_metadata->>'ended_at')::timestamptz,
    (p_metadata->>'duration_seconds')::double precision,p_metadata->>'agent_version',p_metadata->'audio_validation',
    'company/'||d.company_id||'/zalo/'||to_char((p_metadata->>'started_at')::timestamptz AT TIME ZONE 'UTC','YYYY/MM')||'/'||v_id||'.m4a',
    p_bytes,p_checksum,p_fingerprint,v_lease,now()+interval '5 minutes') RETURNING * INTO c;
  UPDATE public.zalo_recording_devices SET last_seen_at=now() WHERE id=d.id;
  RETURN jsonb_build_object('duplicate',false,'call_id',c.id,'recording_id',c.id,'lease',v_lease,'path',c.recording_path);
END $$;

CREATE FUNCTION public.zalo_finish_recording(p_device uuid,p_key_hash text,p_call uuid,p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.zalo_recording_devices; c public.zalo_personal_calls; v_count int; v_customers int; v_customer uuid; v_ambiguous boolean;
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices WHERE id=p_device AND active AND device_key_hash=p_key_hash FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=d.company_id AND status='ACTIVE') THEN RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501'; END IF;
  IF d.staff_user_id IS NOT NULL THEN PERFORM public.zalo_assert_actor(d.company_id,d.staff_user_id); END IF;
  SELECT * INTO c FROM public.zalo_personal_calls WHERE id=p_call AND company_id=d.company_id AND device_id=d.id FOR UPDATE;
  IF NOT FOUND OR c.upload_lease<>p_lease THEN RAISE EXCEPTION 'ZALO_LEASE_LOST'; END IF;
  IF c.recording_status='READY' THEN RETURN jsonb_build_object('call_id',c.id,'recording_id',c.id,'duplicate',true); END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='zalo-call-recordings' AND name=c.recording_path
    AND (metadata->>'size')::bigint=c.recording_bytes) THEN RAISE EXCEPTION 'ZALO_OBJECT_MISSING'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.company_id::text||c.zalo_account_key::text||c.remote_display_name_normalized,0));
  SELECT count(*),coalesce(bool_or(needs_confirmation),false) INTO v_count,v_ambiguous FROM public.zalo_customer_identity_mappings
    WHERE company_id=c.company_id AND zalo_account_key=c.zalo_account_key AND remote_display_name_normalized=c.remote_display_name_normalized AND active;
  SELECT count(*) INTO v_customers FROM public.customers WHERE company_id=c.company_id AND public.zalo_search_name(name)=public.zalo_search_name(c.remote_display_name_normalized);
  v_ambiguous:=v_ambiguous OR v_count>1 OR v_customers>1;
  IF v_count=1 AND NOT v_ambiguous AND c.remote_display_name_normalized<>'' THEN
    SELECT customer_id INTO v_customer FROM public.zalo_customer_identity_mappings WHERE company_id=c.company_id AND zalo_account_key=c.zalo_account_key AND remote_display_name_normalized=c.remote_display_name_normalized AND active;
  END IF;
  UPDATE public.zalo_personal_calls SET recording_status='READY',customer_id=v_customer,identity_ambiguous=v_ambiguous,
    matching_status=CASE WHEN v_customer IS NOT NULL THEN 'EXACT' WHEN v_count>0 OR v_customers>0 THEN 'SUGGESTED' ELSE 'UNMATCHED' END WHERE id=c.id;
  INSERT INTO public.audit_logs(company_id,user_id,action,resource_type,resource_id,result,metadata)
    VALUES(c.company_id,d.staff_user_id,'ZALO_RECORDING_READY','ZALO_CALL',c.id,'SUCCESS',jsonb_build_object('device_id',d.id));
  RETURN jsonb_build_object('call_id',c.id,'recording_id',c.id,'duplicate',false);
END $$;

CREATE FUNCTION public.zalo_link_customer(p_company uuid,p_actor uuid,p_call uuid,p_customer uuid DEFAULT NULL,p_new_name text DEFAULT NULL,p_remember boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.zalo_personal_calls; v_role text; v_customer uuid:=p_customer; v_conflict boolean:=false;
BEGIN
  v_role:=public.zalo_assert_actor(p_company,p_actor);
  SELECT * INTO c FROM public.zalo_personal_calls WHERE id=p_call AND company_id=p_company FOR UPDATE;
  IF NOT FOUND OR c.recording_status<>'READY' OR (v_role='SALE' AND c.staff_user_id IS DISTINCT FROM p_actor) THEN RAISE EXCEPTION 'ZALO_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- A repeated create/link action returns the existing attachment, never creates a second customer.
  IF c.customer_id IS NOT NULL AND p_new_name IS NOT NULL THEN RETURN jsonb_build_object('customer_id',c.customer_id); END IF;
  IF v_customer IS NULL THEN
    IF p_new_name IS NULL OR length(btrim(p_new_name)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'ZALO_INVALID_CUSTOMER'; END IF;
    INSERT INTO public.customers(company_id,name,source,stage) VALUES(p_company,btrim(p_new_name),'ZALO','LEAD_NEW') RETURNING id INTO v_customer;
    INSERT INTO public.customer_stage_histories(company_id,customer_id,to_stage,actor_type,changed_by_user_id,reason)
      VALUES(p_company,v_customer,'LEAD_NEW','USER',p_actor,'Created from Zalo call confirmation');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.customers WHERE company_id=p_company AND id=v_customer) THEN RAISE EXCEPTION 'ZALO_INVALID_CUSTOMER'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.company_id::text||c.zalo_account_key::text||c.remote_display_name_normalized,0));
  IF c.remote_display_name_normalized<>'' THEN
    SELECT EXISTS(SELECT 1 FROM public.zalo_customer_identity_mappings WHERE company_id=p_company AND zalo_account_key=c.zalo_account_key
      AND remote_display_name_normalized=c.remote_display_name_normalized AND active AND customer_id<>v_customer) INTO v_conflict;
    -- Any contradictory manual link poisons automatic reuse, even without "remember".
    IF v_conflict THEN UPDATE public.zalo_customer_identity_mappings SET needs_confirmation=true,updated_at=now()
      WHERE company_id=p_company AND zalo_account_key=c.zalo_account_key AND remote_display_name_normalized=c.remote_display_name_normalized; END IF;
    IF p_remember THEN
      INSERT INTO public.zalo_customer_identity_mappings(company_id,zalo_account_key,remote_display_name_original,remote_display_name_normalized,customer_id,confirmed_by,needs_confirmation)
      VALUES(p_company,c.zalo_account_key,c.remote_display_name,c.remote_display_name_normalized,v_customer,p_actor,v_conflict)
      ON CONFLICT(company_id,zalo_account_key,remote_display_name_normalized,customer_id) DO UPDATE
        SET active=true,confirmed_by=p_actor,confirmed_at=now(),updated_at=now(),needs_confirmation=public.zalo_customer_identity_mappings.needs_confirmation OR v_conflict;
    END IF;
  ELSIF p_remember THEN RAISE EXCEPTION 'ZALO_NAME_REQUIRED_FOR_MAPPING'; END IF;
  UPDATE public.zalo_personal_calls SET customer_id=v_customer,linked_by=p_actor,linked_at=now(),matching_status='EXACT',identity_ambiguous=identity_ambiguous OR v_conflict WHERE id=c.id;
  INSERT INTO public.audit_logs(company_id,user_id,action,resource_type,resource_id,customer_id,result,metadata)
    VALUES(p_company,p_actor,'ZALO_CUSTOMER_CONFIRMED','ZALO_CALL',c.id,v_customer,'SUCCESS',jsonb_build_object('remember',p_remember,'ambiguous',v_conflict));
  RETURN jsonb_build_object('customer_id',v_customer,'ambiguous',v_conflict);
END $$;

-- All mutations are trusted server-only RPCs. User identity is verified before every server call.
REVOKE ALL ON FUNCTION public.zalo_assert_actor(uuid,uuid,boolean),public.zalo_manage_device(uuid,uuid,uuid,text,text,uuid,boolean),
  public.zalo_reserve_recording(uuid,text,jsonb,text,bigint,text),public.zalo_finish_recording(uuid,text,uuid,uuid),
  public.zalo_link_customer(uuid,uuid,uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_assert_actor(uuid,uuid,boolean),public.zalo_manage_device(uuid,uuid,uuid,text,text,uuid,boolean),
  public.zalo_reserve_recording(uuid,text,jsonb,text,bigint,text),public.zalo_finish_recording(uuid,text,uuid,uuid),
  public.zalo_link_customer(uuid,uuid,uuid,uuid,text,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.zalo_normalize_display_name(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_normalize_display_name(text) TO service_role;
REVOKE ALL ON FUNCTION public.zalo_search_name(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_search_name(text) TO service_role;

CREATE FUNCTION public.zalo_search_customers(p_company uuid,p_actor uuid,p_call uuid,p_search text DEFAULT NULL)
RETURNS TABLE(id uuid,name text,customer_code text) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.zalo_personal_calls; v_role text; v_search text;
BEGIN
  v_role:=public.zalo_assert_actor(p_company,p_actor);
  SELECT * INTO c FROM public.zalo_personal_calls WHERE company_id=p_company AND public.zalo_personal_calls.id=p_call;
  IF NOT FOUND OR (v_role='SALE' AND c.staff_user_id IS DISTINCT FROM p_actor) THEN RAISE EXCEPTION 'ZALO_FORBIDDEN' USING ERRCODE='42501'; END IF;
  v_search:=public.zalo_search_name(coalesce(p_search,c.remote_display_name));
  IF length(v_search)<2 OR length(v_search)>200 THEN RETURN; END IF;
  RETURN QUERY SELECT u.id,u.name,u.customer_code FROM public.customers u WHERE u.company_id=p_company AND
    (position(v_search IN public.zalo_search_name(u.name))>0 OR position(v_search IN lower(u.customer_code))>0 OR
     (p_search IS NULL AND EXISTS(SELECT 1 FROM public.zalo_customer_identity_mappings m WHERE m.company_id=p_company AND m.customer_id=u.id AND m.zalo_account_key=c.zalo_account_key AND m.remote_display_name_normalized=c.remote_display_name_normalized AND m.active)))
    ORDER BY u.name,u.id LIMIT 20;
END $$;
REVOKE ALL ON FUNCTION public.zalo_search_customers(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_search_customers(uuid,uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
