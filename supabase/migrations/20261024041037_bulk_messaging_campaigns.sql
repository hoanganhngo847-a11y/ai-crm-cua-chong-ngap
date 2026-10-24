BEGIN;
-- All campaign writes are trusted RPCs. No browser/table mutation grants.
CREATE TABLE public.messaging_campaign_settings (
 company_id uuid PRIMARY KEY REFERENCES public.companies(id), enabled boolean NOT NULL DEFAULT false,
 sale_execute boolean NOT NULL DEFAULT false
);
-- Explicit operational provisioning only: no credentials stored in this registry.
-- Facebook registry must match server META_PAGE_BINDINGS; OA must match active zalo_oa_configs.
CREATE TABLE public.messaging_sender_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id),
 channel text NOT NULL CHECK(channel IN ('FACEBOOK','ZALO_OA')), external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 100),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), connected boolean NOT NULL DEFAULT false,
 verified boolean NOT NULL DEFAULT false, UNIQUE(company_id,id), UNIQUE(channel,external_id)
);
CREATE TABLE public.message_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), channel text NOT NULL CHECK(channel IN ('FACEBOOK','ZALO_OA')),
 sender_account_id uuid, provider_template_id text, template_type text NOT NULL CHECK(template_type IN ('MESSENGER_RESPONSE','OA_SERVICE','ZBS_TEMPLATE')),
 content text NOT NULL CHECK(length(content) BETWEEN 1 AND 2000), parameter_mapping jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(parameter_mapping)='object'), variables jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL CHECK(status IN ('DRAFT','ACTIVE','DISABLED','PROVIDER_PENDING','PROVIDER_APPROVED','PROVIDER_REJECTED')),
 created_by uuid NOT NULL REFERENCES public.user_profiles(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), FOREIGN KEY(company_id,sender_account_id) REFERENCES public.messaging_sender_accounts(company_id,id),
 CHECK((channel='FACEBOOK' AND template_type='MESSENGER_RESPONSE') OR (channel='ZALO_OA' AND template_type IN ('OA_SERVICE','ZBS_TEMPLATE'))),
 CHECK(template_type<>'ZBS_TEMPLATE' OR nullif(provider_template_id,'') IS NOT NULL)
);
CREATE TABLE public.messaging_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), request_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), channel text NOT NULL CHECK(channel IN ('FACEBOOK','ZALO_OA')),
 sender_account_id uuid NOT NULL, template_id uuid NOT NULL, template_snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','VALIDATING','READY','SCHEDULED','RUNNING','PAUSED','COMPLETED','PARTIALLY_FAILED','FAILED','CANCELLED')),
 validation_version int NOT NULL DEFAULT 0, selected_count int NOT NULL DEFAULT 0, eligible_count int NOT NULL DEFAULT 0, sent_count int NOT NULL DEFAULT 0,
 delivered_count int NOT NULL DEFAULT 0, failed_count int NOT NULL DEFAULT 0, skipped_count int NOT NULL DEFAULT 0,
 scheduled_at timestamptz, started_at timestamptz, finished_at timestamptz, confirmed_at timestamptz,
 confirmed_by uuid REFERENCES public.user_profiles(id), created_by uuid NOT NULL REFERENCES public.user_profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), UNIQUE(company_id,created_by,request_id),
 FOREIGN KEY(company_id,sender_account_id) REFERENCES public.messaging_sender_accounts(company_id,id),
 FOREIGN KEY(company_id,template_id) REFERENCES public.message_templates(company_id,id)
);
ALTER TABLE public.identities ADD CONSTRAINT campaign_identity_scope UNIQUE(company_id,customer_id,id);
CREATE TABLE public.messaging_campaign_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, campaign_id uuid NOT NULL, customer_id uuid NOT NULL,
 channel_identity_id uuid, conversation_id uuid, recipient_snapshot jsonb NOT NULL, personalized_payload jsonb,
 eligibility_status text NOT NULL DEFAULT 'PENDING_VALIDATION' CHECK(eligibility_status IN ('PENDING_VALIDATION','ELIGIBLE','BLOCKED_POLICY','MISSING_IDENTITY','UNSUBSCRIBED','DUPLICATE')),
 eligibility_reason text, delivery_status text NOT NULL DEFAULT 'PENDING' CHECK(delivery_status IN ('PENDING','QUEUED','CLAIMED','SENDING','SENT','DELIVERED','READ','FAILED','SKIPPED','CANCELLED','UNCERTAIN')),
 attempt_count int NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5), next_attempt_at timestamptz,
 lock_token uuid, lease_until timestamptz, dispatch_started_at timestamptz,
 provider_message_id text, provider_error_code text, provider_error_message_sanitized text,
 queued_at timestamptz, sent_at timestamptz, delivered_at timestamptz, read_at timestamptz, failed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,customer_id), UNIQUE(company_id,id),
 FOREIGN KEY(company_id,campaign_id) REFERENCES public.messaging_campaigns(company_id,id),
 FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id),
 FOREIGN KEY(company_id,customer_id,channel_identity_id) REFERENCES public.identities(company_id,customer_id,id),
 FOREIGN KEY(company_id,customer_id,conversation_id) REFERENCES public.conversations(company_id,customer_id,id)
);
CREATE UNIQUE INDEX campaign_delivery_identity ON public.messaging_campaign_recipients(campaign_id,channel_identity_id) WHERE channel_identity_id IS NOT NULL;
CREATE UNIQUE INDEX campaign_provider_message ON public.messaging_campaign_recipients(company_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX campaign_queue_due ON public.messaging_campaign_recipients(campaign_id,next_attempt_at,created_at) WHERE delivery_status IN ('QUEUED','CLAIMED','SENDING');
CREATE INDEX campaign_company_recent ON public.messaging_campaigns(company_id,created_at DESC);
CREATE TABLE public.messaging_suppressions (
 company_id uuid NOT NULL, customer_id uuid NOT NULL, channel text NOT NULL CHECK(channel IN ('FACEBOOK','ZALO_OA')),
 status text NOT NULL CHECK(status IN ('DO_NOT_MESSAGE','UNSUBSCRIBED','BLOCKED')),
 source text NOT NULL DEFAULT 'SYSTEM' CHECK(source IN ('CUSTOMER_OPT_OUT','BOSS_ADMIN','SALE_ACTION','PROVIDER','SYSTEM')),
 source_interaction_id uuid REFERENCES public.interactions(id),
 created_by uuid REFERENCES public.user_profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoked_by uuid REFERENCES public.user_profiles(id),
 revoke_reason text,
 PRIMARY KEY(company_id,customer_id,channel),
 FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id)
);
-- OA/ZBS eligibility is verified by an official provider integration, never by client checkboxes.
-- Bounded expiry, exact OA/identity/type and approved provider template prevent generic consent reuse.
CREATE TABLE public.messaging_channel_evidence (
 company_id uuid NOT NULL, sender_account_id uuid NOT NULL, customer_id uuid NOT NULL, identity_id uuid NOT NULL,
 template_type text NOT NULL CHECK(template_type IN ('OA_SERVICE','ZBS_TEMPLATE')), provider_template_id text NOT NULL DEFAULT '',
 consent_at timestamptz NOT NULL, eligible_until timestamptz NOT NULL, provider_verified_at timestamptz NOT NULL,
 PRIMARY KEY(company_id,sender_account_id,identity_id,template_type,provider_template_id),
 FOREIGN KEY(company_id,sender_account_id) REFERENCES public.messaging_sender_accounts(company_id,id),
 FOREIGN KEY(company_id,customer_id,identity_id) REFERENCES public.identities(company_id,customer_id,id),
 CHECK(eligible_until>provider_verified_at AND eligible_until<=provider_verified_at+interval '24 hours')
);
CREATE TABLE public.messaging_campaign_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), campaign_id uuid,
 actor_user_id uuid REFERENCES public.user_profiles(id), event text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(company_id,campaign_id) REFERENCES public.messaging_campaigns(company_id,id)
);
CREATE INDEX campaign_audit_recent ON public.messaging_campaign_audit(company_id,campaign_id,created_at DESC);
CREATE TABLE private.messaging_rate_buckets (
 company_id uuid NOT NULL REFERENCES public.companies(id), bucket_key text NOT NULL, minute timestamptz NOT NULL,
 used int NOT NULL DEFAULT 0, PRIMARY KEY(company_id,bucket_key)
);

-- Additive suppression only. Replies keep the canonical ingestion/conversation pipeline.
CREATE FUNCTION public.campaign_capture_optout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE normalized text; BEGIN
 IF NEW.direction<>'INBOUND' OR NEW.actor_type<>'CUSTOMER' OR NEW.channel NOT IN ('FACEBOOK','ZALO')
 OR NEW.sanitization_status NOT IN ('SUCCEEDED','NOT_REQUIRED') OR NEW.sanitized_content IS NULL THEN RETURN NEW; END IF;
 normalized:=btrim(regexp_replace(replace(lower(regexp_replace(normalize(NEW.sanitized_content,NFD),U&'[\0300-\036f]','','g')),'đ','d'),'[^a-z0-9]+',' ','g'));
 IF normalized IN ('stop','unsubscribe','huy','dung','ngung') OR (' '||normalized||' ') ~
 ' (dung lam phien|ngung lam phien|dung gui tin|ngung gui tin|dung gui tin nua|dung nhan tin|ngung nhan tin|dung nhan tin nua|dung nhan nua|ngung nhan nua|khong nhan tin nua|khong muon nhan tin|khong muon nhan tin nua|khong co nhu cau nhan tin|huy dang ky|huy nhan tin|tu choi nhan tin|unsubscribe|stop) ' THEN
 INSERT INTO public.messaging_suppressions(company_id,customer_id,channel,status,source,source_interaction_id)
 VALUES(NEW.company_id,NEW.customer_id,CASE NEW.channel WHEN 'ZALO' THEN 'ZALO_OA' ELSE 'FACEBOOK' END,'UNSUBSCRIBED','CUSTOMER_OPT_OUT',NEW.id)
 ON CONFLICT(company_id,customer_id,channel) DO UPDATE
 SET status='UNSUBSCRIBED',source='CUSTOMER_OPT_OUT',source_interaction_id=NEW.id,created_at=clock_timestamp(),
     revoked_at=NULL,revoked_by=NULL,revoke_reason=NULL;
 INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,event,metadata)
 VALUES(NEW.company_id,NULL,'customer_optout_detected',jsonb_build_object(
   'customer_id',NEW.customer_id,
   'channel',CASE NEW.channel WHEN 'ZALO' THEN 'ZALO_OA' ELSE 'FACEBOOK' END,
   'interaction_id',NEW.id
 ));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_inbound_optout AFTER INSERT OR UPDATE OF sanitized_content,sanitization_status ON public.interactions
 FOR EACH ROW EXECUTE FUNCTION public.campaign_capture_optout();

CREATE FUNCTION public.campaign_actor(p_company uuid,p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r text; BEGIN
 SELECT m.role INTO r FROM public.company_members m JOIN public.user_profiles u ON u.id=m.user_id
 JOIN public.companies c ON c.id=m.company_id
 WHERE m.company_id=p_company AND m.user_id=p_actor AND m.status='ACTIVE' AND u.status='ACTIVE' AND c.status='ACTIVE'
 AND m.role IN ('BOSS_ADMIN','SALE');
 IF r IS NULL THEN RAISE EXCEPTION 'CAMPAIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN r;
END $$;
CREATE FUNCTION public.campaign_render(p_content text,p_values jsonb) RETURNS text
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE parts text[]; result text:=''; remaining text:=p_content; key text; pos int; BEGIN
 -- Single pass, never re-evaluate substituted customer data.
 LOOP
   parts:=regexp_match(remaining,'\{\{([a-z_]+)\}\}');
   EXIT WHEN parts IS NULL;
   key:=parts[1];
   IF key NOT IN ('customer_name','customer_code','assigned_sale_name','company_name') THEN RAISE EXCEPTION 'UNKNOWN_VARIABLE'; END IF;
   IF nullif(btrim(p_values->>key),'') IS NULL THEN RAISE EXCEPTION 'MISSING_VARIABLE'; END IF;
   pos:=strpos(remaining,'{{'||key||'}}');
   IF left(remaining,pos-1) ~ '[{}]' THEN RAISE EXCEPTION 'UNKNOWN_VARIABLE'; END IF;
   result:=result||left(remaining,pos-1)||(p_values->>key);
   remaining:=substr(remaining,pos+length(key)+4);
 END LOOP;
 IF remaining ~ '[{}]' THEN RAISE EXCEPTION 'UNKNOWN_VARIABLE'; END IF;
 RETURN result||remaining;
END $$;
CREATE FUNCTION public.campaign_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF (NEW.company_id,NEW.channel,NEW.sender_account_id,NEW.template_id,NEW.template_snapshot,NEW.created_by,NEW.request_id)
 IS DISTINCT FROM (OLD.company_id,OLD.channel,OLD.sender_account_id,OLD.template_id,OLD.template_snapshot,OLD.created_by,OLD.request_id)
 THEN RAISE EXCEPTION 'IMMUTABLE_CAMPAIGN_SNAPSHOT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_snapshot_frozen BEFORE UPDATE ON public.messaging_campaigns FOR EACH ROW EXECUTE FUNCTION public.campaign_immutable();

CREATE FUNCTION public.campaign_eligibility(p_campaign uuid,p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.messaging_campaigns; s public.messaging_sender_accounts; t public.message_templates; i public.identities;
 conv public.conversations; values jsonb; parameters jsonb; payload text;
 v_chan text; v_cust_identities int; v_conflict_count int;
BEGIN
 SELECT * INTO STRICT c FROM public.messaging_campaigns WHERE id=p_campaign;
 SELECT * INTO STRICT s FROM public.messaging_sender_accounts WHERE company_id=c.company_id AND id=c.sender_account_id;
 IF EXISTS(SELECT 1 FROM public.messaging_suppressions WHERE company_id=c.company_id AND customer_id=p_customer AND channel=c.channel AND revoked_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.care_schedules WHERE company_id=c.company_id AND customer_id=p_customer AND channel=CASE c.channel WHEN 'ZALO_OA' THEN 'ZALO' ELSE 'FACEBOOK' END AND NOT enabled)
 THEN RETURN '{"status":"UNSUBSCRIBED","reason":"UNSUBSCRIBED"}'; END IF;
 v_chan := CASE c.channel WHEN 'ZALO_OA' THEN 'ZALO' ELSE 'FACEBOOK' END;
 SELECT count(*) INTO v_cust_identities FROM public.identities WHERE company_id=c.company_id AND customer_id=p_customer AND channel=v_chan;
 IF v_cust_identities = 0 THEN RETURN '{"status":"MISSING_IDENTITY","reason":"MISSING_IDENTITY"}'; END IF;
 SELECT * INTO i FROM public.identities WHERE company_id=c.company_id AND customer_id=p_customer
 AND channel=v_chan AND split_part(external_id,':',1)=s.external_id AND external_id ~ '^[0-9]+:[0-9]+$' ORDER BY verified DESC, id LIMIT 1;
 IF i.id IS NULL THEN RETURN '{"status":"BLOCKED_POLICY","reason":"SENDER_MISMATCH"}'; END IF;
 SELECT count(DISTINCT customer_id) INTO v_conflict_count FROM public.identities WHERE company_id=c.company_id AND channel=v_chan AND external_id=i.external_id;
 IF v_conflict_count > 1 THEN RETURN '{"status":"BLOCKED_POLICY","reason":"IDENTITY_CONFLICT"}'; END IF;
 IF NOT i.verified THEN RETURN '{"status":"BLOCKED_POLICY","reason":"IDENTITY_UNVERIFIED"}'; END IF;
 IF c.channel='ZALO_OA' AND ((i.metadata->>'source'='ZCAJS') OR (i.metadata->>'provider'='zcajs')) THEN
 RETURN '{"status":"BLOCKED_POLICY","reason":"IDENTITY_UNVERIFIED"}'; END IF;
 SELECT * INTO t FROM public.message_templates WHERE company_id=c.company_id AND id=c.template_id;
 IF (t.sender_account_id IS NOT NULL AND t.sender_account_id<>c.sender_account_id) OR t.channel IS DISTINCT FROM c.channel OR t.template_type IS DISTINCT FROM c.template_snapshot->>'template_type' OR t.status NOT IN ('ACTIVE','PROVIDER_APPROVED') OR (c.template_snapshot->>'template_type'='ZBS_TEMPLATE' AND
 (t.status<>'PROVIDER_APPROVED' OR t.parameter_mapping IS DISTINCT FROM c.template_snapshot->'parameter_mapping' OR t.provider_template_id IS DISTINCT FROM c.template_snapshot->>'provider_template_id'))
 THEN RETURN '{"status":"BLOCKED_POLICY","reason":"TEMPLATE_DISABLED"}'; END IF;
 IF NOT s.connected OR NOT s.verified OR (c.channel='ZALO_OA' AND NOT EXISTS(
 SELECT 1 FROM public.zalo_oa_configs WHERE company_id=c.company_id AND oa_id=s.external_id AND app_id<>'ZCAJS' AND status='ACTIVE'))
 THEN RETURN '{"status":"BLOCKED_POLICY","reason":"SENDER_UNAVAILABLE"}'; END IF;
 SELECT * INTO conv FROM public.conversations WHERE company_id=c.company_id AND customer_id=p_customer
 AND channel=i.channel AND external_conversation_id=i.external_id;
 IF conv.id IS NULL THEN RETURN '{"status":"BLOCKED_POLICY","reason":"MISSING_IDENTITY"}'; END IF;
 -- Only inbound customer messages from the exact sender-scoped existing conversation count.
 IF c.channel='FACEBOOK' AND NOT EXISTS(SELECT 1 FROM public.interactions WHERE company_id=c.company_id AND customer_id=p_customer
 AND conversation_id=conv.id AND channel='FACEBOOK' AND type='MESSAGE' AND direction='INBOUND' AND actor_type='CUSTOMER'
 AND created_at>clock_timestamp()-interval '24 hours' AND created_at<=clock_timestamp())
 THEN RETURN '{"status":"BLOCKED_POLICY","reason":"OUTSIDE_WINDOW"}'; END IF;
 IF c.channel='ZALO_OA' AND NOT EXISTS(SELECT 1 FROM public.messaging_channel_evidence e
 WHERE e.company_id=c.company_id AND e.customer_id=p_customer AND e.sender_account_id=s.id AND e.identity_id=i.id
 AND e.template_type=c.template_snapshot->>'template_type' AND e.provider_template_id=coalesce(c.template_snapshot->>'provider_template_id','')
 AND e.consent_at<=clock_timestamp() AND e.provider_verified_at<=clock_timestamp() AND e.eligible_until>clock_timestamp())
 THEN RETURN '{"status":"BLOCKED_POLICY","reason":"NO_CONSENT"}'; END IF;
 SELECT jsonb_build_object('customer_name',cu.name,'customer_code',cu.customer_code,'company_name',co.name,'assigned_sale_name',u.full_name)
 INTO values FROM public.customers cu JOIN public.companies co ON co.id=cu.company_id
 LEFT JOIN public.customer_dossier_profiles d ON d.company_id=cu.company_id AND d.customer_id=cu.id
 LEFT JOIN public.user_profiles u ON u.id=d.assigned_sale_id WHERE cu.company_id=c.company_id AND cu.id=p_customer;
 SELECT jsonb_object_agg(key,CASE WHEN jsonb_typeof(value)='string' THEN to_jsonb(regexp_replace(value#>>'{}','[+]?[0-9][0-9 .()-]{7,}[0-9]','[phone]','g')) ELSE value END) INTO values FROM jsonb_each(values);
 BEGIN payload:=regexp_replace(public.campaign_render(c.template_snapshot->>'content',values),'[+]?[0-9][0-9 .()-]{7,}[0-9]','[phone]','g');
 EXCEPTION WHEN OTHERS THEN RETURN '{"status":"BLOCKED_POLICY","reason":"MISSING_VARIABLE"}'; END;
 IF EXISTS(SELECT 1 FROM jsonb_each_text(coalesce(c.template_snapshot->'parameter_mapping','{}')) WHERE nullif(btrim(values->>value),'') IS NULL) THEN RETURN '{"status":"BLOCKED_POLICY","reason":"MISSING_VARIABLE"}'; END IF;
 SELECT coalesce(jsonb_object_agg(key,values->>value),'{}') INTO parameters FROM jsonb_each_text(coalesce(c.template_snapshot->'parameter_mapping','{}'));
 RETURN jsonb_build_object('status','ELIGIBLE','identity_id',i.id,'conversation_id',conv.id,'payload',jsonb_build_object('text',payload,'parameters',parameters));
END $$;
CREATE FUNCTION public.campaign_recount(p_campaign uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n int; failures int; sent int; c public.messaging_campaigns; BEGIN
 SELECT * INTO STRICT c FROM public.messaging_campaigns WHERE id=p_campaign FOR UPDATE;
 SELECT count(*) FILTER(WHERE delivery_status IN ('QUEUED','CLAIMED','SENDING')),count(*) FILTER(WHERE delivery_status IN ('FAILED','UNCERTAIN')),
 count(*) FILTER(WHERE delivery_status IN ('SENT','DELIVERED','READ')) INTO n,failures,sent FROM public.messaging_campaign_recipients WHERE campaign_id=p_campaign;
 UPDATE public.messaging_campaigns SET sent_count=sent, failed_count=failures,
 delivered_count=(SELECT count(*) FROM public.messaging_campaign_recipients WHERE campaign_id=p_campaign AND delivery_status IN ('DELIVERED','READ')),
 skipped_count=(SELECT count(*) FROM public.messaging_campaign_recipients WHERE campaign_id=p_campaign AND delivery_status IN ('SKIPPED','CANCELLED')),
 updated_at=clock_timestamp() WHERE id=p_campaign;
 IF c.confirmed_at IS NOT NULL AND n=0 AND c.status IN ('RUNNING','SCHEDULED','PAUSED') THEN
 UPDATE public.messaging_campaigns SET status=CASE WHEN failures>0 THEN CASE WHEN sent>0 THEN 'PARTIALLY_FAILED' ELSE 'FAILED' END ELSE 'COMPLETED' END,
 finished_at=clock_timestamp() WHERE id=p_campaign;
 INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,event) VALUES(c.company_id,c.id,'campaign_completed');
 END IF;
END $$;
CREATE FUNCTION public.campaign_validate(p_campaign uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record; verdict jsonb; BEGIN
 FOR r IN SELECT * FROM public.messaging_campaign_recipients WHERE campaign_id=p_campaign ORDER BY id FOR UPDATE LOOP
 verdict:=public.campaign_eligibility(p_campaign,r.customer_id);
 UPDATE public.messaging_campaign_recipients SET eligibility_status=verdict->>'status',eligibility_reason=verdict->>'reason',
 channel_identity_id=(verdict->>'identity_id')::uuid,conversation_id=(verdict->>'conversation_id')::uuid,
 personalized_payload=coalesce(personalized_payload,verdict->'payload'),updated_at=clock_timestamp() WHERE id=r.id;
 END LOOP;
 UPDATE public.messaging_campaigns SET eligible_count=(SELECT count(*) FROM public.messaging_campaign_recipients WHERE campaign_id=p_campaign AND eligibility_status='ELIGIBLE'),status='READY',validation_version=validation_version+1 WHERE id=p_campaign;
END $$;

CREATE FUNCTION public.campaign_command(p_company uuid,p_actor uuid,p_command text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE role text; c public.messaging_campaigns; t public.message_templates; s public.messaging_sender_accounts;
 cid uuid; tid uuid; ids uuid[]; event text; scheduled timestamptz; content text; vars jsonb; before_validation text; after_validation text;
 v_supp public.messaging_suppressions; v_reason text; BEGIN
 role:=public.campaign_actor(p_company,p_actor);
 IF NOT EXISTS(SELECT 1 FROM public.messaging_campaign_settings WHERE company_id=p_company AND enabled) THEN RAISE EXCEPTION 'MODULE_DISABLED'; END IF;
 IF octet_length(p_input::text)>50000 THEN RAISE EXCEPTION 'INPUT_TOO_LARGE'; END IF;
 IF p_command='template' THEN
 IF role<>'BOSS_ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF p_input->>'status' NOT IN ('DRAFT','ACTIVE','DISABLED','PROVIDER_PENDING') THEN RAISE EXCEPTION 'PROVIDER_APPROVAL_REQUIRES_VERIFIED_SYNC'; END IF;
 content:=p_input->>'content';
 PERFORM public.campaign_render(content,'{"customer_name":"test","customer_code":"test","assigned_sale_name":"test","company_name":"test"}');
 IF jsonb_typeof(coalesce(p_input->'parameter_mapping','{}'))<>'object' OR EXISTS(SELECT 1 FROM jsonb_each_text(coalesce(p_input->'parameter_mapping','{}')) WHERE key !~ '^[A-Za-z0-9_]{1,80}$' OR value NOT IN ('customer_name','customer_code','assigned_sale_name','company_name')) THEN RAISE EXCEPTION 'INVALID_PARAMETER_MAPPING'; END IF;
 SELECT coalesce(jsonb_agg(DISTINCT m[1]),'[]') INTO vars FROM regexp_matches(content,'\{\{([a-z_]+)\}\}','g') m;
 tid:=coalesce((p_input->>'id')::uuid,gen_random_uuid());
 IF p_input ? 'id' AND NOT EXISTS(SELECT 1 FROM public.message_templates WHERE company_id=p_company AND id=tid) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF nullif(p_input->>'sender_account_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messaging_sender_accounts
 WHERE company_id=p_company AND id=(p_input->>'sender_account_id')::uuid AND channel=p_input->>'channel') THEN RAISE EXCEPTION 'INVALID_SENDER'; END IF;
 INSERT INTO public.message_templates(id,company_id,name,channel,sender_account_id,provider_template_id,template_type,content,parameter_mapping,variables,status,created_by)
 VALUES(tid,p_company,p_input->>'name',p_input->>'channel',(p_input->>'sender_account_id')::uuid,p_input->>'provider_template_id',p_input->>'template_type',content,coalesce(p_input->'parameter_mapping','{}'),vars,p_input->>'status',p_actor)
 ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,channel=EXCLUDED.channel,sender_account_id=EXCLUDED.sender_account_id,provider_template_id=EXCLUDED.provider_template_id,
 template_type=EXCLUDED.template_type,content=EXCLUDED.content,parameter_mapping=EXCLUDED.parameter_mapping,variables=EXCLUDED.variables,status=EXCLUDED.status,updated_at=clock_timestamp()
 WHERE public.message_templates.company_id=p_company;
 INSERT INTO public.messaging_campaign_audit(company_id,actor_user_id,event,metadata) VALUES(p_company,p_actor,'template_saved',jsonb_build_object('template_id',tid));
 RETURN jsonb_build_object('id',tid);
 ELSIF p_command='suppress' THEN
 IF role<>'BOSS_ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 INSERT INTO public.messaging_suppressions(company_id,customer_id,channel,status,source,created_by)
 VALUES(p_company,(p_input->>'customer_id')::uuid,p_input->>'channel',p_input->>'status','BOSS_ADMIN',p_actor)
 ON CONFLICT(company_id,customer_id,channel) DO UPDATE
 SET status=EXCLUDED.status,source='BOSS_ADMIN',created_by=p_actor,created_at=clock_timestamp(),
     revoked_at=NULL,revoked_by=NULL,revoke_reason=NULL;
 INSERT INTO public.messaging_campaign_audit(company_id,actor_user_id,event,metadata) VALUES(p_company,p_actor,'suppression_added',jsonb_build_object('customer_id',p_input->>'customer_id','channel',p_input->>'channel','status',p_input->>'status'));
 RETURN '{}';
 ELSIF p_command='unsuppress' THEN
 IF role<>'BOSS_ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 v_reason:=btrim(coalesce(p_input->>'reason',''));
 SELECT * INTO v_supp FROM public.messaging_suppressions
 WHERE company_id=p_company AND customer_id=(p_input->>'customer_id')::uuid AND channel=p_input->>'channel' AND revoked_at IS NULL;
 IF v_supp.company_id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF v_supp.source = 'CUSTOMER_OPT_OUT' AND length(v_reason) < 3 THEN
   RAISE EXCEPTION 'REVOKE_REASON_REQUIRED';
 END IF;
 UPDATE public.messaging_suppressions
 SET revoked_at=clock_timestamp(), revoked_by=p_actor, revoke_reason=nullif(v_reason,'')
 WHERE company_id=p_company AND customer_id=v_supp.customer_id AND channel=v_supp.channel;
 INSERT INTO public.messaging_campaign_audit(company_id,actor_user_id,event,metadata)
 VALUES(p_company,p_actor,'suppression_revoked',jsonb_build_object(
   'customer_id',p_input->>'customer_id',
   'channel',p_input->>'channel',
   'source',v_supp.source,
   'reason',nullif(v_reason,'')
 ));
 IF v_supp.source = 'CUSTOMER_OPT_OUT' THEN
   INSERT INTO public.messaging_campaign_audit(company_id,actor_user_id,event,metadata)
   VALUES(p_company,p_actor,'customer_optin_restored',jsonb_build_object(
     'customer_id',p_input->>'customer_id',
     'channel',p_input->>'channel',
     'reason',v_reason
   ));
 END IF;
 RETURN '{}';
 ELSIF p_command='create' THEN
 -- Serialize same-actor request ID before checking it: double-click creates one draft.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_company::text||p_actor::text||(p_input->>'request_id'),0));
 SELECT id INTO cid FROM public.messaging_campaigns WHERE company_id=p_company AND created_by=p_actor AND request_id=(p_input->>'request_id')::uuid;
 IF cid IS NOT NULL THEN RETURN jsonb_build_object('id',cid); END IF;
 SELECT array_agg(DISTINCT value::uuid) INTO ids FROM jsonb_array_elements_text(p_input->'customer_ids');
 IF coalesce(cardinality(ids),0) NOT BETWEEN 1 AND 500 OR jsonb_array_length(p_input->'customer_ids')>500 THEN RAISE EXCEPTION 'INVALID_RECIPIENTS'; END IF;
 IF (SELECT count(*) FROM public.customers WHERE company_id=p_company AND id=ANY(ids))<>cardinality(ids) THEN RAISE EXCEPTION 'INVALID_RECIPIENT_SCOPE'; END IF;
 SELECT * INTO t FROM public.message_templates WHERE company_id=p_company AND id=(p_input->>'template_id')::uuid AND status IN ('ACTIVE','PROVIDER_APPROVED') FOR SHARE;
 SELECT * INTO s FROM public.messaging_sender_accounts WHERE company_id=p_company AND id=(p_input->>'sender_account_id')::uuid;
 IF t.id IS NULL OR s.id IS NULL OR t.channel<>s.channel OR s.channel<>p_input->>'channel' OR (t.sender_account_id IS NOT NULL AND t.sender_account_id<>s.id)
 THEN RAISE EXCEPTION 'INVALID_TEMPLATE_OR_SENDER'; END IF;
 INSERT INTO public.messaging_campaigns(company_id,request_id,name,channel,sender_account_id,template_id,template_snapshot,selected_count,created_by)
 VALUES(p_company,(p_input->>'request_id')::uuid,p_input->>'name',s.channel,s.id,t.id,
 jsonb_build_object('name',t.name,'content',t.content,'parameter_mapping',t.parameter_mapping,'variables',t.variables,'template_type',t.template_type,'provider_template_id',t.provider_template_id,'version_at',t.updated_at),cardinality(ids),p_actor) RETURNING id INTO cid;
 INSERT INTO public.messaging_campaign_recipients(company_id,campaign_id,customer_id,recipient_snapshot)
 SELECT p_company,cid,cu.id,jsonb_build_object('name',cu.name,'customer_code',cu.customer_code,'stage',cu.stage,'assigned_sale_name',u.full_name,
 'channels',coalesce((SELECT jsonb_agg(DISTINCT channel) FROM public.identities WHERE company_id=p_company AND customer_id=cu.id AND channel IN ('FACEBOOK','ZALO')),'[]'))
 FROM public.customers cu LEFT JOIN public.customer_dossier_profiles d ON d.company_id=cu.company_id AND d.customer_id=cu.id
 LEFT JOIN public.user_profiles u ON u.id=d.assigned_sale_id WHERE cu.company_id=p_company AND cu.id=ANY(ids);
 INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,actor_user_id,event) VALUES(p_company,cid,p_actor,'campaign_created'),(p_company,cid,p_actor,'template_selected');
 RETURN jsonb_build_object('id',cid);
 END IF;
 SELECT * INTO c FROM public.messaging_campaigns WHERE company_id=p_company AND id=(p_input->>'id')::uuid FOR UPDATE;
 IF c.id IS NULL OR (role='SALE' AND c.created_by<>p_actor) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 cid:=c.id;
 IF p_command='validate' THEN
 IF c.status NOT IN ('DRAFT','READY') THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
 PERFORM public.campaign_validate(cid); event:='validation_completed';
 ELSIF p_command='confirm' THEN
 IF role<>'BOSS_ADMIN' AND NOT EXISTS(SELECT 1 FROM public.messaging_campaign_settings WHERE company_id=p_company AND sale_execute) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF c.confirmed_at IS NOT NULL THEN RETURN jsonb_build_object('id',cid); END IF;
 IF c.status<>'READY' THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
 IF (p_input->>'expected_version')::int IS DISTINCT FROM c.validation_version THEN RAISE EXCEPTION 'STALE_PREVIEW'; END IF;
 SELECT md5(string_agg(jsonb_build_array(id,eligibility_status,eligibility_reason,channel_identity_id,conversation_id,personalized_payload)::text,',' ORDER BY id)) INTO before_validation FROM public.messaging_campaign_recipients WHERE campaign_id=cid;
 PERFORM public.campaign_validate(cid);
 SELECT md5(string_agg(jsonb_build_array(id,eligibility_status,eligibility_reason,channel_identity_id,conversation_id,personalized_payload)::text,',' ORDER BY id)) INTO after_validation FROM public.messaging_campaign_recipients WHERE campaign_id=cid;
 IF before_validation IS DISTINCT FROM after_validation THEN RAISE EXCEPTION 'ELIGIBILITY_CHANGED_REVIEW_REQUIRED'; END IF;
 IF (SELECT eligible_count FROM public.messaging_campaigns WHERE id=cid) IS DISTINCT FROM (p_input->>'expected_eligible')::int
 OR (p_input->>'expected_eligible')::int<=0 THEN RAISE EXCEPTION 'ELIGIBILITY_CHANGED_REVIEW_REQUIRED'; END IF;
 scheduled:=(p_input->>'scheduled_at')::timestamptz;
 IF scheduled IS NOT NULL AND (scheduled<=clock_timestamp() OR scheduled>clock_timestamp()+interval '90 days') THEN RAISE EXCEPTION 'INVALID_SCHEDULE'; END IF;
 UPDATE public.messaging_campaigns SET status=CASE WHEN scheduled IS NULL THEN 'RUNNING' ELSE 'SCHEDULED' END,scheduled_at=scheduled,confirmed_at=clock_timestamp(),confirmed_by=p_actor WHERE id=cid;
 UPDATE public.messaging_campaign_recipients SET delivery_status=CASE WHEN eligibility_status='ELIGIBLE' THEN 'QUEUED' ELSE 'SKIPPED' END,
 queued_at=clock_timestamp(),next_attempt_at=coalesce(scheduled,clock_timestamp()) WHERE campaign_id=cid;
 event:='campaign_confirmed';
 ELSIF p_command IN ('pause','resume','cancel') THEN
 IF role<>'BOSS_ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF p_command='pause' AND c.status IN ('SCHEDULED','RUNNING') THEN UPDATE public.messaging_campaigns SET status='PAUSED' WHERE id=cid; event:='campaign_paused';
 ELSIF p_command='resume' AND c.status='PAUSED' THEN UPDATE public.messaging_campaigns SET status=CASE WHEN scheduled_at>clock_timestamp() THEN 'SCHEDULED' ELSE 'RUNNING' END WHERE id=cid; event:='campaign_resumed';
 ELSIF p_command='cancel' AND c.status IN ('DRAFT','READY','SCHEDULED','RUNNING','PAUSED') THEN
 UPDATE public.messaging_campaigns SET status='CANCELLED',finished_at=clock_timestamp() WHERE id=cid;
 UPDATE public.messaging_campaign_recipients SET delivery_status='CANCELLED',lock_token=NULL,lease_until=NULL WHERE campaign_id=cid AND delivery_status IN ('PENDING','QUEUED','CLAIMED'); event:='campaign_cancelled';
 ELSE RAISE EXCEPTION 'INVALID_STATE'; END IF;
 ELSE RAISE EXCEPTION 'INVALID_COMMAND'; END IF;
 INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,actor_user_id,event) VALUES(p_company,cid,p_actor,event);
 PERFORM public.campaign_recount(cid);
 RETURN jsonb_build_object('id',cid);
END $$;

-- Only the trusted server supplies Page bindings; OA rows come from existing official configs.
CREATE FUNCTION public.campaign_sync_senders(p_company uuid,p_actor uuid,p_pages jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.campaign_actor(p_company,p_actor);
 IF NOT EXISTS(SELECT 1 FROM public.messaging_campaign_settings WHERE company_id=p_company AND enabled) THEN RETURN; END IF;
 IF jsonb_typeof(p_pages)<>'array' OR jsonb_array_length(p_pages)>100 THEN RAISE EXCEPTION 'INVALID_PAGES'; END IF;
 UPDATE public.messaging_sender_accounts SET connected=false WHERE company_id=p_company;
 INSERT INTO public.messaging_sender_accounts(company_id,channel,external_id,name,connected)
 SELECT p_company,'FACEBOOK',x->>'id',left(coalesce(nullif(x->>'name',''),'Facebook Page'),120),(x->>'connected')::boolean
 FROM jsonb_array_elements(p_pages)x WHERE x->>'id' ~ '^[0-9]{1,100}$'
 ON CONFLICT(channel,external_id) DO UPDATE SET name=EXCLUDED.name,connected=EXCLUDED.connected
 WHERE public.messaging_sender_accounts.company_id=p_company;
 INSERT INTO public.messaging_sender_accounts(company_id,channel,external_id,name,connected)
 SELECT p_company,'ZALO_OA',oa_id,'Zalo OA '||oa_id,true FROM public.zalo_oa_configs
 WHERE company_id=p_company AND status='ACTIVE' AND app_id<>'ZCAJS' AND oa_id ~ '^[0-9]{1,100}$'
 ON CONFLICT(channel,external_id) DO UPDATE SET connected=true WHERE public.messaging_sender_accounts.company_id=p_company;
END $$;

-- Trusted server-side identity verification based on authoritative provider evidence. Never callable from browser.
CREATE FUNCTION public.campaign_verify_identity(p_company uuid,p_channel text,p_sender_id text,p_recipient_id text,p_evidence jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_channel text; v_ext text; v_identity public.identities; v_conflict_count int; v_sender public.messaging_sender_accounts; BEGIN
 IF p_channel NOT IN ('FACEBOOK','ZALO_OA') THEN RAISE EXCEPTION 'INVALID_CHANNEL'; END IF;
 IF p_sender_id !~ '^[0-9]{1,100}$' OR p_recipient_id !~ '^[0-9]{1,100}$' THEN RAISE EXCEPTION 'INVALID_IDENTIFIER'; END IF;
 v_channel:=CASE p_channel WHEN 'ZALO_OA' THEN 'ZALO' ELSE 'FACEBOOK' END;
 v_ext:=p_sender_id||':'||p_recipient_id;
 SELECT * INTO v_sender FROM public.messaging_sender_accounts WHERE company_id=p_company AND channel=p_channel AND external_id=p_sender_id;
 IF v_sender.id IS NULL OR NOT v_sender.connected THEN RAISE EXCEPTION 'SENDER_NOT_FOUND_OR_DISCONNECTED'; END IF;
 IF p_channel='ZALO_OA' AND NOT EXISTS(SELECT 1 FROM public.zalo_oa_configs WHERE company_id=p_company AND oa_id=p_sender_id AND status='ACTIVE' AND app_id<>'ZCAJS') THEN
 RAISE EXCEPTION 'OA_NOT_ACTIVE_OR_ZCAJS'; END IF;
 IF EXISTS(SELECT 1 FROM public.identities WHERE channel=v_channel AND external_id=v_ext AND company_id<>p_company) THEN
 RAISE EXCEPTION 'IDENTITY_CROSS_TENANT_CONFLICT'; END IF;
 SELECT count(DISTINCT customer_id) INTO v_conflict_count FROM public.identities WHERE company_id=p_company AND channel=v_channel AND external_id=v_ext;
 IF v_conflict_count>1 THEN RAISE EXCEPTION 'IDENTITY_CONFLICT'; END IF;
 SELECT * INTO v_identity FROM public.identities WHERE company_id=p_company AND channel=v_channel AND external_id=v_ext LIMIT 1;
 IF v_identity.id IS NULL THEN RAISE EXCEPTION 'IDENTITY_NOT_FOUND'; END IF;
 IF p_channel='ZALO_OA' AND ((v_identity.metadata->>'source'='ZCAJS') OR (v_identity.metadata->>'provider'='zcajs')) THEN
 RAISE EXCEPTION 'ZCAJS_CANNOT_BE_VERIFIED_AS_OA'; END IF;
 IF coalesce(p_evidence->>'verified','false')<>'true' AND NOT EXISTS(
 SELECT 1 FROM public.interactions WHERE company_id=p_company AND customer_id=v_identity.customer_id AND channel=v_channel AND direction='INBOUND' AND actor_type='CUSTOMER') THEN
 RAISE EXCEPTION 'AUTHORITATIVE_EVIDENCE_REQUIRED'; END IF;
 UPDATE public.identities SET verified=true WHERE id=v_identity.id AND company_id=p_company;
 INSERT INTO public.messaging_campaign_audit(company_id,event,metadata) VALUES(p_company,'identity_verified',jsonb_build_object('identity_id',v_identity.id,'customer_id',v_identity.customer_id,'channel',p_channel,'external_id',v_ext));
 RETURN jsonb_build_object('ok',true,'identity_id',v_identity.id,'customer_id',v_identity.customer_id);
END $$;

CREATE FUNCTION public.campaign_read(p_company uuid,p_actor uuid,p_input jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE role text; cid uuid:=(p_input->>'id')::uuid; result jsonb; page int:=coalesce((p_input->>'page')::int,1); filter text:=coalesce(p_input->>'status','ALL'); BEGIN
 role:=public.campaign_actor(p_company,p_actor);
 IF filter NOT IN ('ALL','RUNNING','SCHEDULED','COMPLETED','FAILED') OR page NOT BETWEEN 1 AND 10000 OR coalesce(jsonb_array_length(p_input->'customer_ids'),0)>500 THEN RAISE EXCEPTION 'INVALID_PAGE'; END IF;
 IF cid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messaging_campaigns WHERE company_id=p_company AND id=cid AND (role='BOSS_ADMIN' OR created_by=p_actor)) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT jsonb_build_object(
 'enabled',coalesce((SELECT enabled FROM public.messaging_campaign_settings WHERE company_id=p_company),false),
 'sale_execute',coalesce((SELECT sale_execute FROM public.messaging_campaign_settings WHERE company_id=p_company),false),
 'campaigns',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT c.*,u.full_name AS created_by_name FROM public.messaging_campaigns c LEFT JOIN public.user_profiles u ON u.id=c.created_by WHERE c.company_id=p_company
 AND (role='BOSS_ADMIN' OR c.created_by=p_actor) AND (filter='ALL' OR c.status=filter OR (filter='FAILED' AND c.status='PARTIALLY_FAILED')) ORDER BY c.created_at DESC LIMIT 50 OFFSET (page-1)*50)x),'[]'),
 'campaign',(SELECT to_jsonb(c)||jsonb_build_object('created_by_name',u.full_name) FROM public.messaging_campaigns c LEFT JOIN public.user_profiles u ON u.id=c.created_by WHERE c.company_id=p_company AND c.id=cid),
 'templates',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT t.* FROM public.message_templates t WHERE company_id=p_company
 AND (role='BOSS_ADMIN' OR status IN ('ACTIVE','PROVIDER_APPROVED')) ORDER BY updated_at DESC LIMIT 200)x),'[]'),
 'senders',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'channel',channel,'connected',connected,'verified',verified))
 FROM public.messaging_sender_accounts WHERE company_id=p_company),'[]'),
 'customers',coalesce((SELECT jsonb_agg(jsonb_build_object('id',cu.id,'name',cu.name,'customer_code',cu.customer_code,'stage',cu.stage,'assigned_sale_name',u.full_name,
 'channels',coalesce((SELECT jsonb_agg(DISTINCT channel) FROM public.identities WHERE company_id=p_company AND customer_id=cu.id AND channel IN ('FACEBOOK','ZALO')),'[]')))
 FROM public.customers cu LEFT JOIN public.customer_dossier_profiles d ON d.company_id=cu.company_id AND d.customer_id=cu.id
 LEFT JOIN public.user_profiles u ON u.id=d.assigned_sale_id WHERE cu.company_id=p_company AND cu.id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_input->'customer_ids'))),'[]'),
 'recipients',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'customer_id',customer_id,'recipient_snapshot',recipient_snapshot,'personalized_payload',personalized_payload,
 'eligibility_status',eligibility_status,'eligibility_reason',eligibility_reason,'delivery_status',delivery_status,'attempt_count',attempt_count,
 'provider_message_id',provider_message_id,'provider_error_code',provider_error_code,'provider_error_message_sanitized',provider_error_message_sanitized,
 'sent_at',sent_at,'delivered_at',delivered_at,'read_at',read_at,
 'suppression',(SELECT jsonb_build_object('status',su.status,'source',su.source,'created_at',su.created_at,'revoked_at',su.revoked_at) FROM public.messaging_suppressions su WHERE su.company_id=p_company AND su.customer_id=r.customer_id AND su.channel=(SELECT channel FROM public.messaging_campaigns WHERE id=cid) AND su.revoked_at IS NULL LIMIT 1))) FROM public.messaging_campaign_recipients r WHERE company_id=p_company AND campaign_id=cid),'[]'),
 'audit',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT event,actor_user_id,created_at FROM public.messaging_campaign_audit WHERE company_id=p_company AND campaign_id=cid ORDER BY created_at DESC LIMIT 100)x),'[]')
 ) INTO result;
 RETURN result;
END $$;

-- Worker protocol: claim -> revalidate/begin -> adapter -> finish. Never reclaim SENDING for resend.
CREATE FUNCTION public.campaign_claim(p_company uuid,p_channel text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.messaging_campaigns; r public.messaging_campaign_recipients; BEGIN
 IF p_channel NOT IN ('FACEBOOK','ZALO_OA') THEN RAISE EXCEPTION 'INVALID_CHANNEL'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.messaging_campaign_settings WHERE company_id=p_company AND enabled) THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.messaging_campaigns WHERE company_id=p_company AND channel=p_channel
 AND status IN ('RUNNING','SCHEDULED','PAUSED','CANCELLED') AND confirmed_at IS NOT NULL AND coalesce(scheduled_at,created_at)<=clock_timestamp()
 AND EXISTS(SELECT 1 FROM public.messaging_campaign_recipients q WHERE q.campaign_id=messaging_campaigns.id AND
 ((messaging_campaigns.status IN ('RUNNING','SCHEDULED') AND ((q.delivery_status='QUEUED' AND q.next_attempt_at<=clock_timestamp()) OR (q.delivery_status='CLAIMED' AND q.lease_until<clock_timestamp()))) OR (q.delivery_status='SENDING' AND q.lease_until<clock_timestamp())))
 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 WITH expired AS (UPDATE public.messaging_campaign_recipients SET delivery_status='UNCERTAIN',provider_error_code='LEASE_EXPIRED_AFTER_DISPATCH',
 provider_error_message_sanitized='Provider outcome unknown; reconciliation required.',lock_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
 WHERE campaign_id=c.id AND delivery_status='SENDING' AND lease_until<clock_timestamp() RETURNING *)
 INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,event,metadata)
 SELECT company_id,campaign_id,'recipient_failed',jsonb_build_object('recipient_id',id,'code','LEASE_EXPIRED_AFTER_DISPATCH') FROM expired;
 IF c.status IN ('PAUSED','CANCELLED') THEN PERFORM public.campaign_recount(c.id); RETURN NULL; END IF;
 SELECT * INTO r FROM public.messaging_campaign_recipients WHERE campaign_id=c.id AND attempt_count<5 AND
 ((delivery_status='QUEUED' AND next_attempt_at<=clock_timestamp()) OR (delivery_status='CLAIMED' AND lease_until<clock_timestamp()))
 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF r.id IS NULL THEN PERFORM public.campaign_recount(c.id); RETURN NULL; END IF;
 UPDATE public.messaging_campaign_recipients SET delivery_status='CLAIMED',lock_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
 WHERE id=r.id RETURNING * INTO r;
 RETURN jsonb_build_object('id',r.id,'company_id',r.company_id,'campaign_id',c.id,'lock_token',r.lock_token,'channel',c.channel);
END $$;
CREATE FUNCTION public.campaign_begin(p_company uuid,p_recipient uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.messaging_campaigns; r public.messaging_campaign_recipients; s public.messaging_sender_accounts; verdict jsonb;
 key text; allowance int; bucket private.messaging_rate_buckets; role text; BEGIN
 SELECT ca.* INTO c FROM public.messaging_campaigns ca JOIN public.messaging_campaign_recipients re ON re.campaign_id=ca.id
 WHERE re.id=p_recipient AND re.company_id=p_company AND ca.company_id=p_company FOR UPDATE OF ca;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.messaging_campaign_recipients WHERE company_id=p_company AND id=p_recipient FOR UPDATE;
 IF r.delivery_status<>'CLAIMED' OR p_token IS NULL OR r.lock_token IS DISTINCT FROM p_token OR r.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 IF c.status NOT IN ('RUNNING','SCHEDULED') OR c.confirmed_at IS NULL OR coalesce(c.scheduled_at,c.created_at)>clock_timestamp() OR
 NOT EXISTS(SELECT 1 FROM public.messaging_campaign_settings WHERE company_id=p_company AND enabled) THEN RETURN NULL; END IF;
 -- Revoked authorizations stop unsent work too.
 BEGIN role:=public.campaign_actor(p_company,c.confirmed_by); EXCEPTION WHEN OTHERS THEN role:=NULL; END;
 IF role IS NULL OR (role<>'BOSS_ADMIN' AND NOT EXISTS(SELECT 1 FROM public.messaging_campaign_settings WHERE company_id=p_company AND sale_execute)) THEN
 UPDATE public.messaging_campaigns SET status='PAUSED' WHERE id=c.id; RETURN NULL; END IF;
 verdict:=public.campaign_eligibility(c.id,r.customer_id);
 IF verdict->>'status'<>'ELIGIBLE' OR (verdict->>'identity_id')::uuid IS DISTINCT FROM r.channel_identity_id OR
 (verdict->>'conversation_id')::uuid IS DISTINCT FROM r.conversation_id THEN
 UPDATE public.messaging_campaign_recipients SET eligibility_status=CASE WHEN verdict->>'status'='ELIGIBLE' THEN 'BLOCKED_POLICY' ELSE verdict->>'status' END,
 eligibility_reason=coalesce(verdict->>'reason','IDENTITY_CHANGED'),delivery_status='SKIPPED',lock_token=NULL,lease_until=NULL WHERE id=r.id;
 PERFORM public.campaign_recount(c.id); RETURN NULL; END IF;
 -- Fixed lock order: company -> channel -> sender; shared across campaigns.
 FOREACH key IN ARRAY ARRAY['company','channel:'||c.channel,'sender:'||c.sender_account_id::text] LOOP
 allowance:=CASE WHEN key='company' THEN 60 WHEN key LIKE 'channel:%' THEN 30 ELSE 10 END;
 INSERT INTO private.messaging_rate_buckets(company_id,bucket_key,minute) VALUES(p_company,key,date_trunc('minute',clock_timestamp())) ON CONFLICT DO NOTHING;
 SELECT * INTO bucket FROM private.messaging_rate_buckets WHERE company_id=p_company AND bucket_key=key FOR UPDATE;
 IF bucket.minute<date_trunc('minute',clock_timestamp()) THEN UPDATE private.messaging_rate_buckets SET minute=date_trunc('minute',clock_timestamp()),used=0 WHERE company_id=p_company AND bucket_key=key; bucket.used:=0; END IF;
 IF bucket.used>=allowance THEN
 UPDATE public.messaging_campaign_recipients SET delivery_status='QUEUED',next_attempt_at=date_trunc('minute',clock_timestamp())+interval '1 minute',lock_token=NULL,lease_until=NULL WHERE id=r.id; RETURN NULL; END IF;
 END LOOP;
 UPDATE private.messaging_rate_buckets SET used=used+1 WHERE company_id=p_company AND bucket_key IN ('company','channel:'||c.channel,'sender:'||c.sender_account_id::text);
 IF c.started_at IS NULL THEN INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,event) VALUES(p_company,c.id,'campaign_started'); END IF;
 UPDATE public.messaging_campaigns SET status='RUNNING',started_at=coalesce(started_at,clock_timestamp()) WHERE id=c.id;
 UPDATE public.messaging_campaign_recipients SET delivery_status='SENDING',attempt_count=attempt_count+1,dispatch_started_at=clock_timestamp(),
 lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE id=r.id;
 SELECT * INTO s FROM public.messaging_sender_accounts WHERE company_id=p_company AND id=c.sender_account_id;
 RETURN jsonb_build_object('id',r.id,'company_id',p_company,'campaign_id',c.id,'lock_token',p_token,'channel',c.channel,
 'sender_external_id',s.external_id,'recipient_external_id',(SELECT external_id FROM public.identities WHERE id=r.channel_identity_id AND company_id=p_company),
 'personalized_payload',r.personalized_payload,'template_snapshot',c.template_snapshot);
END $$;
CREATE FUNCTION public.campaign_finish(p_company uuid,p_recipient uuid,p_token uuid,p_status text,p_message_id text DEFAULT NULL,p_code text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.messaging_campaigns; r public.messaging_campaign_recipients; result text; BEGIN
 SELECT ca.* INTO c FROM public.messaging_campaigns ca JOIN public.messaging_campaign_recipients re ON re.campaign_id=ca.id
 WHERE re.id=p_recipient AND re.company_id=p_company AND ca.company_id=p_company FOR UPDATE OF ca;
 IF c.id IS NULL THEN RETURN false; END IF;
 SELECT * INTO r FROM public.messaging_campaign_recipients WHERE company_id=p_company AND id=p_recipient FOR UPDATE;
 IF r.delivery_status<>'SENDING' OR p_token IS NULL OR r.lock_token IS DISTINCT FROM p_token THEN RETURN false; END IF;
 IF p_status NOT IN ('SENT','TRANSIENT','PERMANENT','UNCERTAIN') OR p_status IS NULL THEN RAISE EXCEPTION 'INVALID_RESULT'; END IF;
 IF p_status='SENT' AND (nullif(btrim(p_message_id),'') IS NULL OR length(p_message_id)>250) THEN p_status:='UNCERTAIN'; p_code:='MISSING_PROVIDER_ID'; END IF;
 result:=CASE WHEN p_status='SENT' THEN 'SENT' WHEN p_status='UNCERTAIN' THEN 'UNCERTAIN'
 WHEN p_status='TRANSIENT' AND r.attempt_count<5 AND c.status<>'CANCELLED' THEN 'QUEUED' ELSE 'FAILED' END;
 UPDATE public.messaging_campaign_recipients SET delivery_status=result,provider_message_id=CASE WHEN result='SENT' THEN p_message_id ELSE NULL END,
 provider_error_code=CASE WHEN p_code ~ '^[A-Za-z0-9_.:-]{1,100}$' THEN p_code WHEN result<>'SENT' THEN 'PROVIDER_ERROR' END,
 provider_error_message_sanitized=CASE WHEN result<>'SENT' THEN 'Provider rejected or outcome unknown; see error code.' END,
 next_attempt_at=CASE WHEN result='QUEUED' THEN clock_timestamp()+make_interval(secs=>least(3600,30*power(2,r.attempt_count-1)::int)) END,
 sent_at=CASE WHEN result='SENT' THEN clock_timestamp() END,failed_at=CASE WHEN result IN ('FAILED','UNCERTAIN') THEN clock_timestamp() END,
 lock_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=r.id;
 -- Communication event stays in the exact existing Inbox conversation. Never create another thread.
 INSERT INTO public.interactions(company_id,customer_id,conversation_id,channel,type,direction,sanitized_content,sanitization_status,sanitized_at,sanitizer_version,actor_type,actor_user_id,external_ref)
 VALUES(p_company,r.customer_id,r.conversation_id,CASE c.channel WHEN 'ZALO_OA' THEN 'ZALO' ELSE 'FACEBOOK' END,'STATUS_EVENT','OUTBOUND',
 'Campaign: '||regexp_replace(c.name,'[+]?[0-9][0-9 .()-]{7,}[0-9]','[phone]','g')||' | Template: '||regexp_replace(c.template_snapshot->>'name','[+]?[0-9][0-9 .()-]{7,}[0-9]','[phone]','g')||' | Delivery: '||result,
 'SUCCEEDED',clock_timestamp(),'campaign-v1','SYSTEM',c.confirmed_by,'campaign:'||r.id::text||':'||r.attempt_count::text)
 ON CONFLICT DO NOTHING;
 INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,event,metadata) VALUES(p_company,c.id,CASE WHEN result='SENT' THEN 'recipient_sent' ELSE 'recipient_failed' END,
 jsonb_build_object('recipient_id',r.id,'status',result,'code',CASE WHEN p_code ~ '^[A-Za-z0-9_.:-]{1,100}$' THEN p_code ELSE NULL END));
 PERFORM public.campaign_recount(c.id); RETURN true;
END $$;
-- Monotonic delivery receipts for future authenticated official webhook adapters. No public route.
CREATE FUNCTION public.campaign_receipt(p_company uuid,p_sender uuid,p_message_id text,p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.messaging_campaign_recipients; c public.messaging_campaigns; BEGIN
 IF p_status NOT IN ('DELIVERED','READ') OR p_status IS NULL THEN RAISE EXCEPTION 'INVALID_RECEIPT'; END IF;
 SELECT ca.* INTO c FROM public.messaging_campaigns ca JOIN public.messaging_campaign_recipients re ON re.campaign_id=ca.id
 WHERE ca.company_id=p_company AND ca.sender_account_id=p_sender AND re.provider_message_id=p_message_id AND re.delivery_status IN ('SENT','DELIVERED','READ') FOR UPDATE OF ca;
 IF c.id IS NULL THEN RETURN false; END IF;
 SELECT * INTO r FROM public.messaging_campaign_recipients WHERE company_id=p_company AND campaign_id=c.id AND provider_message_id=p_message_id FOR UPDATE;
 UPDATE public.messaging_campaign_recipients SET delivery_status=CASE WHEN delivery_status='READ' THEN 'READ' ELSE p_status END,
 delivered_at=coalesce(delivered_at,clock_timestamp()),read_at=CASE WHEN p_status='READ' THEN coalesce(read_at,clock_timestamp()) ELSE read_at END WHERE id=r.id;
 UPDATE public.interactions SET sanitized_content=regexp_replace(sanitized_content,'Delivery: [A-Z]+$','Delivery: '||CASE WHEN r.delivery_status='READ' THEN 'READ' ELSE p_status END)
 WHERE company_id=p_company AND external_ref='campaign:'||r.id::text||':'||r.attempt_count::text;
 PERFORM public.campaign_recount(c.id); RETURN true;
END $$;

DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['messaging_campaign_settings','messaging_sender_accounts','message_templates','messaging_campaigns',
 'messaging_campaign_recipients','messaging_suppressions','messaging_channel_evidence','messaging_campaign_audit'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 -- Tenant actor checks are inside RPCs. Even service clients cannot mutate tables directly.
 END LOOP;
 ALTER TABLE private.messaging_rate_buckets ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON private.messaging_rate_buckets FROM PUBLIC,anon,authenticated,service_role;
 FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'campaign\_%' ESCAPE '\' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb),public.campaign_read(uuid,uuid,jsonb),public.campaign_command(uuid,uuid,text,jsonb),
 public.campaign_claim(uuid,text),public.campaign_begin(uuid,uuid,uuid),public.campaign_finish(uuid,uuid,uuid,text,text,text),
 public.campaign_receipt(uuid,uuid,text,text),public.campaign_verify_identity(uuid,text,text,text,jsonb) TO service_role;
COMMIT;
