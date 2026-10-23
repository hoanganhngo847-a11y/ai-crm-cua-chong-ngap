-- Additive Customer 360. CLI-created timestamp advanced after inspected latest migration
-- 20261023190000. No scheduler, channel settings, customer merges, or provider calls.
BEGIN;

ALTER TABLE public.identities DROP CONSTRAINT identities_channel_check;
ALTER TABLE public.identities ADD CONSTRAINT identities_channel_check
  CHECK (channel IN ('ZALO','FACEBOOK','WEBSITE','PHONE','EMAIL'));
ALTER TABLE public.identities ADD COLUMN display_name text CHECK (length(display_name) <= 200);
ALTER TABLE public.identities ADD CONSTRAINT c360_email_hmac
  CHECK (channel <> 'EMAIL' OR external_id ~ '^[0-9a-f]{64}$');
ALTER TABLE public.identities ADD CONSTRAINT c360_identity_scope UNIQUE(company_id,customer_id,id);

CREATE TABLE public.customer_dossier_profiles (
  company_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  address text CHECK (length(address) <= 1000),
  birth_year integer CHECK (birth_year BETWEEN 1900 AND 2100),
  special_notes text CHECK (length(special_notes) <= 4000),
  assigned_sale_id uuid,
  updated_by uuid REFERENCES public.user_profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,customer_id),
  FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id) ON DELETE CASCADE,
  FOREIGN KEY(company_id,assigned_sale_id) REFERENCES public.company_members(company_id,user_id)
);
-- EMAIL source of truth. PHONE continues using private.customer_private_contacts.
CREATE TABLE private.customer_identity_values (
  identity_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  normalized_value text NOT NULL CHECK (length(normalized_value) BETWEEN 3 AND 254),
  display_value text NOT NULL CHECK (length(display_value) <= 254),
  FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id) ON DELETE CASCADE,
  FOREIGN KEY(company_id,customer_id,identity_id) REFERENCES public.identities(company_id,customer_id,id) ON DELETE CASCADE,
  UNIQUE(company_id,normalized_value)
);
CREATE TABLE public.customer_identity_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  other_customer_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','DISMISSED','RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id) ON DELETE CASCADE,
  FOREIGN KEY(company_id,other_customer_id) REFERENCES public.customers(company_id,id) ON DELETE CASCADE,
  FOREIGN KEY(company_id,other_customer_id,identity_id) REFERENCES public.identities(company_id,customer_id,id) ON DELETE CASCADE,
  UNIQUE(company_id,customer_id,identity_id),
  CHECK(customer_id <> other_customer_id)
);
CREATE TABLE public.customer_dossier_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE public.customer_dossier_refresh (
  company_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  requested_version bigint NOT NULL DEFAULT 1,
  completed_version bigint NOT NULL DEFAULT 0,
  claimed_version bigint,
  lock_token uuid,
  lease_until timestamptz,
  due_at timestamptz NOT NULL DEFAULT now()+interval '30 seconds',
  last_manual_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  error_code text CHECK(error_code IS NULL OR error_code='AI_REFRESH_FAILED'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,customer_id),
  FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id) ON DELETE CASCADE,
  CHECK(requested_version >= completed_version AND completed_version >= 0)
);
CREATE INDEX c360_refresh_due ON public.customer_dossier_refresh(due_at)
  WHERE requested_version > completed_version;
CREATE TABLE public.customer_ai_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  version bigint NOT NULL CHECK(version > 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  source_watermark bigint NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  provider text NOT NULL DEFAULT 'javis-brain-service' CHECK(provider='javis-brain-service'),
  model text NOT NULL CHECK(length(model) BETWEEN 1 AND 100),
  contract_version text NOT NULL DEFAULT 'dossier-v1' CHECK(contract_version='dossier-v1'),
  -- CRM-owned values: model cannot choose a score, stage, or operational follow-up.
  lead_score integer CHECK(lead_score BETWEEN 0 AND 100),
  follow_up_at timestamptz,
  FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id) ON DELETE CASCADE,
  UNIQUE(company_id,customer_id,version)
);
CREATE INDEX c360_latest_snapshot ON public.customer_ai_snapshots(company_id,customer_id,version DESC);
CREATE INDEX c360_follow_up ON public.customer_ai_snapshots(company_id,follow_up_at) WHERE follow_up_at IS NOT NULL;
CREATE INDEX c360_identity_names ON public.identities USING gin(display_name public.gin_trgm_ops);
CREATE INDEX c360_owner ON public.customer_dossier_profiles(company_id,assigned_sale_id);
-- Existing interactions index is inspected separately; this covers deterministic cursor ordering.
CREATE INDEX c360_interaction_cursor ON public.interactions(company_id,customer_id,created_at DESC,id DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_dossier_profiles','customer_identity_conflicts','customer_dossier_settings',
    'customer_dossier_refresh','customer_ai_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO service_role',t);
  END LOOP;
END $$;
ALTER TABLE private.customer_identity_values ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.customer_identity_values FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON private.customer_identity_values TO service_role;
-- History is append-only even for service_role.
REVOKE UPDATE ON public.customer_ai_snapshots FROM service_role;

CREATE FUNCTION public.c360_bind_identity(p_company_id uuid,p_customer_id uuid,p_channel text,
  p_external_id text,p_display_name text DEFAULT NULL,p_verified boolean DEFAULT false,p_email text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE existing public.identities; BEGIN
  IF p_channel NOT IN ('ZALO','FACEBOOK','PHONE','EMAIL') OR length(btrim(p_external_id)) NOT BETWEEN 1 AND 512
    OR NOT EXISTS(SELECT 1 FROM public.customers WHERE company_id=p_company_id AND id=p_customer_id)
    THEN RAISE EXCEPTION 'INVALID_IDENTITY' USING ERRCODE='22023'; END IF;
  IF p_channel='EMAIL' AND (p_email IS NULL OR p_email <> lower(btrim(p_email)) OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    THEN RAISE EXCEPTION 'INVALID_EMAIL' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text||p_channel||p_external_id,0));
  SELECT * INTO existing FROM public.identities WHERE company_id=p_company_id AND channel=p_channel AND external_id=p_external_id;
  IF FOUND THEN
    IF existing.customer_id <> p_customer_id THEN
      INSERT INTO public.customer_identity_conflicts(company_id,customer_id,other_customer_id,identity_id)
      VALUES(p_company_id,p_customer_id,existing.customer_id,existing.id) ON CONFLICT DO NOTHING;
      RETURN jsonb_build_object('status','CONFLICT');
    END IF;
    RETURN jsonb_build_object('status','EXISTING','customerId',existing.customer_id);
  END IF;
  INSERT INTO public.identities(company_id,customer_id,channel,external_id,display_name,verified)
    VALUES(p_company_id,p_customer_id,p_channel,p_external_id,p_display_name,p_verified) RETURNING * INTO existing;
  IF p_channel='EMAIL' THEN
    INSERT INTO private.customer_identity_values(identity_id,company_id,customer_id,normalized_value,display_value)
      VALUES(existing.id,p_company_id,p_customer_id,p_email,p_email);
  END IF;
  RETURN jsonb_build_object('status','LINKED','customerId',p_customer_id);
END $$;

CREATE FUNCTION public.c360_mark_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cid uuid; BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='interactions' THEN
    IF NEW.sanitized_content IS NOT DISTINCT FROM OLD.sanitized_content AND NEW.sanitization_status IS NOT DISTINCT FROM OLD.sanitization_status THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'updated_at')=(to_jsonb(OLD)-'updated_at') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='customers' THEN cid:=NEW.id; ELSE cid:=NEW.customer_id; END IF;
  IF cid IS NOT NULL THEN
    INSERT INTO public.customer_dossier_refresh(company_id,customer_id) VALUES(NEW.company_id,cid)
    ON CONFLICT(company_id,customer_id) DO UPDATE SET
      requested_version=customer_dossier_refresh.requested_version+1,
      attempts=0,error_code=NULL,updated_at=clock_timestamp(),
      due_at=CASE WHEN customer_dossier_refresh.requested_version=customer_dossier_refresh.completed_version
        THEN clock_timestamp()+interval '30 seconds' ELSE customer_dossier_refresh.due_at END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c360_interaction_dirty AFTER INSERT OR UPDATE OF sanitized_content,sanitization_status ON public.interactions
  FOR EACH ROW WHEN(NEW.sanitization_status IN ('SUCCEEDED','NOT_REQUIRED')) EXECUTE FUNCTION public.c360_mark_dirty();
CREATE TRIGGER c360_customer_dirty AFTER INSERT OR UPDATE OF name,stage ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.c360_mark_dirty();
CREATE TRIGGER c360_profile_dirty AFTER INSERT OR UPDATE ON public.customer_dossier_profiles
  FOR EACH ROW EXECUTE FUNCTION public.c360_mark_dirty();
CREATE TRIGGER c360_identity_dirty AFTER INSERT OR UPDATE OF display_name ON public.identities
  FOR EACH ROW EXECUTE FUNCTION public.c360_mark_dirty();
CREATE TRIGGER c360_transcript_dirty AFTER INSERT OR UPDATE OF status,full_transcript ON public.zalo_call_transcriptions
  FOR EACH ROW WHEN(NEW.status='COMPLETED') EXECUTE FUNCTION public.c360_mark_dirty();
CREATE TRIGGER c360_call_dirty AFTER INSERT OR UPDATE OF customer_id,recording_status ON public.zalo_personal_calls
  FOR EACH ROW EXECUTE FUNCTION public.c360_mark_dirty();

CREATE FUNCTION public.c360_request_refresh(p_company_id uuid,p_customer_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.customers WHERE company_id=p_company_id AND id=p_customer_id)
    THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO public.customer_dossier_refresh(company_id,customer_id,due_at,last_manual_at)
    VALUES(p_company_id,p_customer_id,clock_timestamp(),clock_timestamp())
  ON CONFLICT(company_id,customer_id) DO UPDATE SET
    requested_version=CASE WHEN customer_dossier_refresh.requested_version=customer_dossier_refresh.completed_version
      THEN customer_dossier_refresh.requested_version+1 ELSE customer_dossier_refresh.requested_version END,
    due_at=least(customer_dossier_refresh.due_at,clock_timestamp()),attempts=0,
    last_manual_at=clock_timestamp()
    WHERE customer_dossier_refresh.last_manual_at IS NULL
      OR customer_dossier_refresh.last_manual_at < clock_timestamp()-interval '1 minute';
  RETURN FOUND;
END $$;

CREATE FUNCTION public.c360_claim_refresh(p_company_id uuid DEFAULT NULL,p_customer_id uuid DEFAULT NULL)
RETURNS SETOF public.customer_dossier_refresh LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN QUERY WITH candidate AS (
    SELECT q.company_id,q.customer_id FROM public.customer_dossier_refresh q
    JOIN public.customer_dossier_settings s ON s.company_id=q.company_id AND s.enabled
    WHERE q.requested_version>q.completed_version AND q.due_at<=clock_timestamp() AND q.attempts<5
      AND (q.lease_until IS NULL OR q.lease_until<clock_timestamp())
      AND (p_company_id IS NULL OR q.company_id=p_company_id)
      AND (p_customer_id IS NULL OR q.customer_id=p_customer_id)
    ORDER BY q.due_at,q.customer_id FOR UPDATE OF q SKIP LOCKED LIMIT 1
  ) UPDATE public.customer_dossier_refresh q SET claimed_version=q.requested_version,
      lock_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=q.attempts+1
    FROM candidate c WHERE q.company_id=c.company_id AND q.customer_id=c.customer_id RETURNING q.*;
END $$;

CREATE FUNCTION public.c360_finish_refresh(p_company_id uuid,p_customer_id uuid,p_token uuid,p_version bigint,
  p_snapshot jsonb,p_model text,p_lead_score integer DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE q public.customer_dossier_refresh; BEGIN
  SELECT * INTO q FROM public.customer_dossier_refresh WHERE company_id=p_company_id AND customer_id=p_customer_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR q.lock_token IS NULL OR q.lease_until IS NULL
    OR q.lock_token IS DISTINCT FROM p_token OR q.claimed_version IS DISTINCT FROM p_version
    OR p_version<=q.completed_version OR q.lease_until<=clock_timestamp() THEN RETURN false; END IF;
  IF q.requested_version<>p_version THEN
    UPDATE public.customer_dossier_refresh SET lock_token=NULL,lease_until=NULL,due_at=clock_timestamp()+interval '30 seconds'
      WHERE company_id=p_company_id AND customer_id=p_customer_id;
    RETURN false;
  END IF;
  IF p_snapshot IS NULL THEN
    UPDATE public.customer_dossier_refresh SET lock_token=NULL,lease_until=NULL,error_code='AI_REFRESH_FAILED',
      due_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,q.attempts)::int))
      WHERE company_id=p_company_id AND customer_id=p_customer_id;
    RETURN false;
  END IF;
  -- The trusted CRM worker validates the full contract and exact source quotes before calling.
  IF jsonb_typeof(p_snapshot)<>'object' OR NOT (p_snapshot ?& ARRAY['summary','currentSituation','intent','evidence','confidence'])
    OR octet_length(p_snapshot::text)>24000 THEN RAISE EXCEPTION 'INVALID_SNAPSHOT'; END IF;
  INSERT INTO public.customer_ai_snapshots(company_id,customer_id,version,source_watermark,snapshot,model,lead_score)
    VALUES(p_company_id,p_customer_id,p_version,p_version,p_snapshot,p_model,p_lead_score);
  UPDATE public.customer_dossier_refresh SET completed_version=p_version,lock_token=NULL,lease_until=NULL,
    error_code=NULL,attempts=0,updated_at=clock_timestamp()
    WHERE company_id=p_company_id AND customer_id=p_customer_id;
  RETURN true;
END $$;

-- One set-based list query; no timeline/transcript payload. Raw phone is never returned.
CREATE FUNCTION public.c360_list(p_company_id uuid,p_search text DEFAULT '',p_page integer DEFAULT 1,
  p_owner uuid DEFAULT NULL,p_channel text DEFAULT NULL,p_stage text DEFAULT NULL,p_hot boolean DEFAULT false,
  p_overdue boolean DEFAULT false,p_recent boolean DEFAULT false,p_sort text DEFAULT 'updated',p_include_ai boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; BEGIN
  IF p_page NOT BETWEEN 1 AND 10000 OR length(p_search)>200 OR p_sort NOT IN ('updated','name','contact','score','followup')
    OR (p_channel IS NOT NULL AND p_channel NOT IN ('ZALO','FACEBOOK','PHONE','EMAIL')) THEN RAISE EXCEPTION 'INVALID_FILTER'; END IF;
  WITH rows AS (
    SELECT c.id,c.customer_code,c.name,c.stage,c.source,c.updated_at,
      p.address,p.birth_year,p.special_notes,coalesce(p.assigned_sale_id,owner.assigned_to) AS assigned_sale_id,u.full_name AS assigned_sale,
      ids.zalo_name,ids.facebook_name,ids.channels,em.email,
      CASE WHEN ph.normalized_phone IS NULL THEN NULL ELSE left(ph.normalized_phone,4)||'******'||right(ph.normalized_phone,2) END AS phone,
      s.snapshot->'currentSituation'->>'text' AS current_situation,s.lead_score,s.follow_up_at,s.generated_at AS ai_updated_at,
      greatest(msg.at,zc.at) AS last_interaction,
      count(*) OVER() AS total
    FROM public.customers c
    LEFT JOIN public.customer_dossier_profiles p ON p.company_id=c.company_id AND p.customer_id=c.id
    LEFT JOIN LATERAL(SELECT assigned_to FROM public.conversations conv WHERE conv.company_id=c.company_id
      AND conv.customer_id=c.id AND conv.assigned_to IS NOT NULL ORDER BY updated_at DESC,id LIMIT 1) owner ON true
    LEFT JOIN public.user_profiles u ON u.id=coalesce(p.assigned_sale_id,owner.assigned_to)
    LEFT JOIN private.customer_private_contacts ph ON ph.company_id=c.company_id AND ph.customer_id=c.id
    LEFT JOIN LATERAL(SELECT v.normalized_value AS email FROM private.customer_identity_values v
      WHERE v.company_id=c.company_id AND v.customer_id=c.id ORDER BY v.identity_id LIMIT 1) em ON true
    LEFT JOIN LATERAL(SELECT max(coalesce(i.display_name,i.metadata->>'display_name')) FILTER(WHERE channel='ZALO') AS zalo_name,
      max(coalesce(i.display_name,i.metadata->>'display_name')) FILTER(WHERE channel='FACEBOOK') AS facebook_name,
      array_agg(DISTINCT channel) AS channels FROM public.identities i WHERE i.company_id=c.company_id AND i.customer_id=c.id) ids ON true
    LEFT JOIN LATERAL(SELECT a.snapshot,a.lead_score,a.follow_up_at,a.generated_at FROM public.customer_ai_snapshots a
      WHERE p_include_ai AND a.company_id=c.company_id AND a.customer_id=c.id ORDER BY version DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL(SELECT max(created_at) AS at FROM public.interactions i WHERE i.company_id=c.company_id AND i.customer_id=c.id) msg ON true
    LEFT JOIN LATERAL(SELECT max(started_at) AS at FROM public.zalo_personal_calls z WHERE z.company_id=c.company_id AND z.customer_id=c.id) zc ON true
    WHERE c.company_id=p_company_id
      AND (p_search='' OR c.name ILIKE '%'||p_search||'%' OR ph.normalized_phone ILIKE '%'||p_search||'%'
        OR em.email ILIKE '%'||p_search||'%' OR EXISTS(SELECT 1 FROM public.identities si
          WHERE si.company_id=c.company_id AND si.customer_id=c.id AND si.channel IN ('ZALO','FACEBOOK')
            AND (si.display_name ILIKE '%'||p_search||'%' OR si.metadata->>'display_name' ILIKE '%'||p_search||'%')))
      AND (p_owner IS NULL OR coalesce(p.assigned_sale_id,owner.assigned_to)=p_owner)
      AND (p_channel IS NULL OR p_channel=ANY(ids.channels))
      AND (p_stage IS NULL OR c.stage=p_stage)
      AND (NOT p_hot OR s.lead_score>=70)
      AND (NOT p_overdue OR s.follow_up_at<now())
      AND (NOT p_recent OR greatest(msg.at,zc.at)>now()-interval '7 days')
  ), page AS (
    SELECT * FROM rows ORDER BY
      CASE WHEN p_sort='name' THEN name END ASC,
      CASE WHEN p_sort='contact' THEN last_interaction END DESC NULLS LAST,
      CASE WHEN p_sort='score' THEN lead_score END DESC NULLS LAST,
      CASE WHEN p_sort='followup' THEN follow_up_at END ASC NULLS LAST,
      CASE WHEN p_sort='updated' THEN updated_at END DESC,id
    LIMIT 25 OFFSET (p_page-1)*25
  ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(page)-'total') FROM page),'[]'::jsonb),
    'total',coalesce((SELECT max(total) FROM rows),0),'page',p_page,'pageSize',25) INTO result;
  RETURN result;
END $$;

CREATE FUNCTION public.c360_contacts(p_company_id uuid,p_customer_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object('phone',(SELECT left(normalized_phone,4)||'******'||right(normalized_phone,2)
    FROM private.customer_private_contacts WHERE company_id=p_company_id AND customer_id=p_customer_id),
    'assignedSaleId',(SELECT assigned_to FROM public.conversations WHERE company_id=p_company_id
      AND customer_id=p_customer_id AND assigned_to IS NOT NULL ORDER BY updated_at DESC,id LIMIT 1),
    'lastInteraction',greatest((SELECT max(created_at) FROM public.interactions WHERE company_id=p_company_id AND customer_id=p_customer_id),
      (SELECT max(started_at) FROM public.zalo_personal_calls WHERE company_id=p_company_id AND customer_id=p_customer_id)))
$$;

CREATE FUNCTION public.c360_emails(p_company_id uuid,p_customer_id uuid) RETURNS SETOF text
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT normalized_value FROM private.customer_identity_values
  WHERE company_id=p_company_id AND customer_id=p_customer_id ORDER BY identity_id
$$;

-- Server-side timeline paging across canonical sources, with one row per recording.
CREATE FUNCTION public.c360_timeline(p_company_id uuid,p_customer_id uuid,p_page integer DEFAULT 1,
  p_filter text DEFAULT 'ALL',p_staff_id uuid DEFAULT NULL,p_include_ai boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; BEGIN
  IF p_page NOT BETWEEN 1 AND 10000 OR p_filter NOT IN ('ALL','MESSAGE','CALL','NOTE','AI','EVENT')
    THEN RAISE EXCEPTION 'INVALID_FILTER'; END IF;
  WITH events AS (
    SELECT 'interaction:'||i.id AS id,CASE i.type WHEN 'MESSAGE' THEN 'MESSAGE' WHEN 'NOTE' THEN 'NOTE'
      WHEN 'CALL_EVENT' THEN 'CALL' ELSE 'EVENT' END AS kind,i.channel,i.direction,
      i.created_at AS at,i.sanitized_content AS content,i.id AS source_id
      FROM public.interactions i WHERE i.company_id=p_company_id AND i.customer_id=p_customer_id
        AND i.sanitization_status IN ('SUCCEEDED','NOT_REQUIRED')
        AND NOT(i.type='CALL_EVENT' AND (EXISTS(SELECT 1 FROM public.zalo_personal_calls z
          WHERE z.company_id=i.company_id AND z.customer_id=i.customer_id AND i.external_ref=z.id::text)
          OR EXISTS(SELECT 1 FROM public.calls c WHERE c.company_id=i.company_id AND c.customer_id=i.customer_id AND i.external_ref=c.id::text)))
    UNION ALL
    SELECT 'recording:'||z.id,'CALL',z.channel,z.direction,z.started_at,
      concat('Cuộc gọi Zalo · ',round(z.duration_seconds)::text,' giây · ',z.recording_status),z.id
      FROM public.zalo_personal_calls z WHERE z.company_id=p_company_id AND z.customer_id=p_customer_id
        AND (p_staff_id IS NULL OR z.staff_user_id=p_staff_id)
    UNION ALL
    SELECT 'call:'||c.id,'CALL',c.provider,c.direction,c.started_at,'Cuộc gọi · '||c.status,c.id
      FROM public.calls c WHERE p_include_ai AND c.company_id=p_company_id AND c.customer_id=p_customer_id
    UNION ALL
    SELECT 'appointment:'||a.id,'EVENT','CRM',NULL,a.start_time,'Lịch hẹn · '||a.status,a.id
      FROM public.appointments a WHERE a.company_id=p_company_id AND a.customer_id=p_customer_id
        AND NOT EXISTS(SELECT 1 FROM public.interactions i WHERE i.company_id=a.company_id AND i.customer_id=a.customer_id AND i.external_ref=a.id::text)
    UNION ALL
    SELECT 'snapshot:'||s.id,'AI','AI',NULL,s.generated_at,s.snapshot->'summary'->>'text',s.id
      FROM public.customer_ai_snapshots s WHERE p_include_ai AND s.company_id=p_company_id AND s.customer_id=p_customer_id
    UNION ALL
    SELECT 'stage:'||h.id,'EVENT','CRM',NULL,h.changed_at,h.from_stage||' → '||h.to_stage,h.id
      FROM public.customer_stage_histories h WHERE h.company_id=p_company_id AND h.customer_id=p_customer_id
    UNION ALL
    SELECT 'handover:'||h.id,'EVENT','CRM',NULL,h.created_at,'Chuyển giao cho sale: '||h.reason,h.id
      FROM public.ai_handover_cases h WHERE h.company_id=p_company_id AND h.customer_id=p_customer_id
  ), filtered AS(SELECT * FROM events WHERE p_filter='ALL' OR kind=p_filter), page AS(
    SELECT * FROM filtered ORDER BY at DESC,id DESC LIMIT 30 OFFSET (p_page-1)*30
  ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY at DESC,id DESC) FROM page),'[]'::jsonb),
    'total',(SELECT count(*) FROM filtered),'page',p_page,'pageSize',30) INTO result;
  RETURN result;
END $$;

-- ACLs are explicit for every function, including trigger functions.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname LIKE 'c360\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END $$;
COMMIT;
