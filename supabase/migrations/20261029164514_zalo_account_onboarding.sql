-- Credentials live only in a private table, encrypted by the CRM with a dedicated
-- AES-GCM key. Browser roles cannot access this table or the server-only RPCs.
CREATE TABLE private.zalo_accounts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  encrypted_credentials jsonb NOT NULL,
  fingerprint text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'CONNECTING' CHECK (status IN ('CONNECTING','CONNECTED','ERROR','PAUSED')),
  provider_uid text,
  error_code text,
  last_heartbeat_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,id), UNIQUE(company_id,fingerprint), UNIQUE(company_id,provider_uid)
);
ALTER TABLE private.zalo_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.zalo_accounts FROM PUBLIC, anon, authenticated;
CREATE TABLE private.zalo_legacy_runtime (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id),
  provider_uid text NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.zalo_legacy_runtime ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.zalo_legacy_runtime FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.list_zalo_accounts(p_company_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'enabled',enabled,'revision',revision,
  'status',status,'provider_uid',provider_uid,'error_code',error_code,'last_heartbeat_at',last_heartbeat_at,'created_at',created_at)
  ORDER BY created_at),'[]'::jsonb) FROM private.zalo_accounts WHERE company_id=p_company_id;
$$;
CREATE FUNCTION public.save_zalo_account(p_company_id uuid,p_id uuid,p_label text,p_encrypted jsonb,p_fingerprint text,p_actor_id uuid,p_is_new boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text||':zalo-accounts',0));
 IF NOT EXISTS (SELECT 1 FROM public.company_members m JOIN public.user_profiles u ON u.id=m.user_id
  WHERE m.company_id=p_company_id AND m.user_id=p_actor_id AND m.status='ACTIVE' AND m.role='BOSS_ADMIN' AND u.status='ACTIVE')
 THEN RAISE EXCEPTION 'ZALO_ACCOUNT_FORBIDDEN'; END IF;
 IF p_is_new THEN
  IF (SELECT count(*) FROM private.zalo_accounts WHERE company_id=p_company_id)>=3 THEN RAISE EXCEPTION 'ZALO_ACCOUNT_LIMIT'; END IF;
  INSERT INTO private.zalo_accounts(id,company_id,label,encrypted_credentials,fingerprint,created_by)
  VALUES(p_id,p_company_id,btrim(p_label),p_encrypted,p_fingerprint,p_actor_id);
 ELSE
  UPDATE private.zalo_accounts SET label=btrim(p_label),encrypted_credentials=p_encrypted,fingerprint=p_fingerprint,
   revision=revision+1,enabled=true,status='CONNECTING',error_code=NULL,last_heartbeat_at=NULL,updated_at=clock_timestamp()
  WHERE id=p_id AND company_id=p_company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_ACCOUNT_NOT_FOUND'; END IF;
 END IF;
 INSERT INTO public.audit_logs(company_id,user_id,actor_id,action,resource_type,resource_id,result,metadata)
 VALUES(p_company_id,p_actor_id,p_actor_id,'ZALO_ACCOUNT_SAVED','SYSTEM_CONFIG',p_id,'SUCCESS',jsonb_build_object('account_id',p_id,'created',p_is_new));
 RETURN p_id;
END;
$$;
CREATE FUNCTION public.set_zalo_account_enabled(p_company_id uuid,p_id uuid,p_enabled boolean,p_actor_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.company_members m JOIN public.user_profiles u ON u.id=m.user_id
  WHERE m.company_id=p_company_id AND m.user_id=p_actor_id AND m.status='ACTIVE' AND m.role='BOSS_ADMIN' AND u.status='ACTIVE')
 THEN RAISE EXCEPTION 'ZALO_ACCOUNT_FORBIDDEN'; END IF;
 UPDATE private.zalo_accounts SET enabled=p_enabled,revision=revision+1,status=CASE WHEN p_enabled THEN 'CONNECTING' ELSE 'PAUSED' END,
  error_code=NULL,last_heartbeat_at=NULL,updated_at=clock_timestamp() WHERE id=p_id AND company_id=p_company_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_ACCOUNT_NOT_FOUND'; END IF;
 INSERT INTO public.audit_logs(company_id,user_id,actor_id,action,resource_type,resource_id,result,metadata)
 VALUES(p_company_id,p_actor_id,p_actor_id,'ZALO_ACCOUNT_TOGGLED','SYSTEM_CONFIG',p_id,'SUCCESS',jsonb_build_object('enabled',p_enabled));
END;
$$;
CREATE FUNCTION public.get_zalo_runtime_accounts(p_company_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'revision',revision,'encrypted_credentials',encrypted_credentials)
 ORDER BY created_at),'[]'::jsonb) FROM private.zalo_accounts WHERE company_id=p_company_id AND enabled;
$$;
CREATE FUNCTION public.report_zalo_account_runtime(p_company_id uuid,p_id uuid,p_revision integer,p_status text,p_provider_uid text DEFAULT NULL,p_error_code text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a private.zalo_accounts%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text||':zalo-accounts',0));
 IF p_id IS NULL THEN
  IF p_provider_uid IS NULL OR p_provider_uid !~ '^[0-9]{5,40}$' THEN RAISE EXCEPTION 'ZALO_UID_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM private.zalo_accounts WHERE company_id=p_company_id AND provider_uid=p_provider_uid)
  THEN RAISE EXCEPTION 'DUPLICATE_ZALO_ACCOUNT'; END IF;
  INSERT INTO private.zalo_legacy_runtime(company_id,provider_uid) VALUES(p_company_id,p_provider_uid)
  ON CONFLICT(company_id) DO UPDATE SET provider_uid=EXCLUDED.provider_uid,last_heartbeat_at=clock_timestamp();
  RETURN true;
 END IF;
 SELECT * INTO a FROM private.zalo_accounts WHERE company_id=p_company_id AND id=p_id AND enabled AND revision=p_revision FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_provider_uid IS NOT NULL THEN
  IF p_provider_uid !~ '^[0-9]{5,40}$' THEN RAISE EXCEPTION 'ZALO_UID_REQUIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM private.zalo_legacy_runtime WHERE company_id=p_company_id) THEN RAISE EXCEPTION 'ZALO_LEGACY_NOT_READY'; END IF;
  IF EXISTS(SELECT 1 FROM private.zalo_legacy_runtime WHERE company_id=p_company_id AND provider_uid=p_provider_uid)
   OR EXISTS(SELECT 1 FROM private.zalo_accounts WHERE company_id=p_company_id AND id<>p_id AND provider_uid=p_provider_uid)
  THEN RAISE EXCEPTION 'DUPLICATE_ZALO_ACCOUNT'; END IF;
  IF a.provider_uid IS NOT NULL AND a.provider_uid<>p_provider_uid THEN RAISE EXCEPTION 'ZALO_ACCOUNT_IDENTITY_CHANGED'; END IF;
 END IF;
 IF p_status NOT IN ('CONNECTING','CONNECTED','ERROR') THEN RAISE EXCEPTION 'INVALID_ZALO_ACCOUNT_STATE'; END IF;
 UPDATE private.zalo_accounts SET provider_uid=coalesce(p_provider_uid,provider_uid),status=p_status,
  error_code=p_error_code,last_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE id=p_id AND company_id=p_company_id;
 RETURN true;
END;
$$;
-- New-account conversations use independent identities/threads; a default manual
-- mode prevents history/onboarding from starting automatic customer replies.
CREATE FUNCTION private.zalo_account_conversation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.channel='ZALO' AND NEW.metadata ? 'zalo_account_id' THEN
  IF NOT EXISTS(SELECT 1 FROM private.zalo_accounts a WHERE a.company_id=NEW.company_id AND a.id::text=NEW.metadata->>'zalo_account_id')
   OR NEW.external_conversation_id NOT LIKE 'account:'||(NEW.metadata->>'zalo_account_id')||':%'
  THEN RAISE EXCEPTION 'ZALO_ACCOUNT_SCOPE_MISMATCH'; END IF;
  IF TG_OP='INSERT' THEN NEW.ai_mode:='PAUSED'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER zalo_account_conversation_scope BEFORE INSERT OR UPDATE OF metadata ON public.conversations
 FOR EACH ROW EXECUTE FUNCTION private.zalo_account_conversation_guard();
CREATE FUNCTION private.zalo_peer_thread(p_thread text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT regexp_replace(p_thread,'^account:[0-9a-fA-F-]{36}:','');
$$;
REVOKE ALL ON FUNCTION private.zalo_peer_thread(text) FROM PUBLIC,anon,authenticated;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('list_zalo_accounts','save_zalo_account','set_zalo_account_enabled','get_zalo_runtime_accounts','report_zalo_account_runtime') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION public.get_zalo_group_message_authors(
  p_company_id uuid, p_interaction_ids uuid[]
) RETURNS TABLE (interaction_id uuid, sender_id text, sender_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT i.id,
         coalesce(a.sender_id, nullif(r.source_metadata->>'zalo_sender_id', '')),
         coalesce(a.sender_name, nullif(r.source_metadata->>'zalo_sender_name', ''))
    FROM public.interactions i
    JOIN public.conversations c ON c.id = i.conversation_id AND c.company_id = i.company_id
    JOIN private.interaction_raw_contents r ON r.interaction_id = i.id AND r.company_id = i.company_id
    LEFT JOIN private.zalo_group_message_authors a ON a.interaction_id = i.id AND a.company_id = i.company_id
   WHERE i.company_id = p_company_id
     AND i.id = ANY(p_interaction_ids)
     AND i.channel = 'ZALO'
     AND private.zalo_peer_thread(c.external_conversation_id) LIKE 'group:%'
     AND (r.source_metadata->>'is_group' = 'true' OR a.interaction_id IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION public.get_zalo_group_message_authors(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_zalo_group_message_authors(uuid, uuid[]) TO service_role;


CREATE OR REPLACE FUNCTION public.sync_zalo_group_metadata(
  p_company_id uuid, p_conversation_id uuid, p_group jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.conversations%ROWTYPE;
  v_name text;
  v_patch jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  SELECT * INTO c FROM public.conversations
   WHERE id = p_conversation_id AND company_id = p_company_id
     AND channel = 'ZALO' AND private.zalo_peer_thread(external_conversation_id) ~ '^group:[0-9]{5,40}$'
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_GROUP_NOT_FOUND'; END IF;
  IF p_group->>'group_fetched_at' IS NOT NULL AND c.metadata->>'group_fetched_at' IS NOT NULL
     AND p_group->>'group_fetched_at' < c.metadata->>'group_fetched_at' THEN
    RETURN c.metadata;
  END IF;
  v_name := coalesce(nullif(btrim(p_group->>'group_name'), ''), nullif(c.metadata->>'group_name', ''),
                     'Nhóm Zalo ' || right(private.zalo_peer_thread(c.external_conversation_id), 4));
  FOREACH v_key IN ARRAY ARRAY['member_count', 'members', 'members_complete', 'group_avatar', 'group_fetched_at'] LOOP
    IF p_group ? v_key AND p_group->v_key <> 'null'::jsonb THEN
      v_patch := v_patch || jsonb_build_object(v_key, p_group->v_key);
    END IF;
  END LOOP;
  v_patch := v_patch || jsonb_build_object(
    'is_group', true, 'group_id', substr(private.zalo_peer_thread(c.external_conversation_id), 7),
    'group_name', v_name, 'zalo_display_name', v_name,
    'zalo_display_name_source', CASE WHEN nullif(p_group->>'group_name', '') IS NOT NULL THEN 'group_info'
                                   ELSE coalesce(c.metadata->>'zalo_display_name_source', 'group_fallback') END,
    'zalo_display_name_updated_at', clock_timestamp());
  UPDATE public.conversations SET metadata = coalesce(metadata, '{}'::jsonb) || v_patch
   WHERE id = c.id AND company_id = p_company_id RETURNING metadata INTO v_patch;
  UPDATE public.customers SET name = v_name WHERE id = c.customer_id AND company_id = p_company_id;
  UPDATE public.identities SET display_name = v_name, updated_at = clock_timestamp()
   WHERE company_id = p_company_id AND channel = 'ZALO' AND external_id = c.external_conversation_id;
  RETURN v_patch;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_zalo_group_metadata(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_zalo_group_metadata(uuid, uuid, jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.repair_zalo_group_message_author(
  p_company_id uuid, p_conversation_id uuid, p_external_ref text, p_author jsonb
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.zalo_group_message_authors (interaction_id, company_id, sender_id, sender_name)
  SELECT i.id, i.company_id, nullif(p_author->>'zalo_sender_id', ''), nullif(p_author->>'zalo_sender_name', '')
    FROM public.interactions i JOIN public.conversations c ON c.id = i.conversation_id AND c.company_id = i.company_id
   WHERE i.company_id = p_company_id AND i.conversation_id = p_conversation_id
     AND i.channel = 'ZALO' AND i.external_ref = p_external_ref
     AND private.zalo_peer_thread(c.external_conversation_id) = 'group:' || (p_author->>'group_id')
  ON CONFLICT (interaction_id) DO UPDATE SET
    sender_id = coalesce(EXCLUDED.sender_id, private.zalo_group_message_authors.sender_id),
    sender_name = coalesce(EXCLUDED.sender_name, private.zalo_group_message_authors.sender_name),
    updated_at = clock_timestamp();
$$;
REVOKE ALL ON FUNCTION public.repair_zalo_group_message_author(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_zalo_group_message_author(uuid, uuid, text, jsonb) TO service_role;
