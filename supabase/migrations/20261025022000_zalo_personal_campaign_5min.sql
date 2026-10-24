BEGIN;

ALTER TABLE public.messaging_sender_accounts
  DROP CONSTRAINT messaging_sender_accounts_channel_check,
  ADD CONSTRAINT messaging_sender_accounts_channel_check
  CHECK (channel IN ('FACEBOOK','ZALO_OA','ZALO_PERSONAL'));

ALTER TABLE public.message_templates
  DROP CONSTRAINT message_templates_channel_check,
  DROP CONSTRAINT message_templates_template_type_check,
  DROP CONSTRAINT message_templates_check,
  ADD CONSTRAINT message_templates_channel_check
    CHECK (channel IN ('FACEBOOK','ZALO_OA','ZALO_PERSONAL')),
  ADD CONSTRAINT message_templates_template_type_check
    CHECK (template_type IN ('MESSENGER_RESPONSE','OA_SERVICE','ZBS_TEMPLATE','ZALO_PERSONAL_TEXT')),
  ADD CONSTRAINT message_templates_check
    CHECK (
      (channel='FACEBOOK' AND template_type='MESSENGER_RESPONSE') OR
      (channel='ZALO_OA' AND template_type IN ('OA_SERVICE','ZBS_TEMPLATE')) OR
      (channel='ZALO_PERSONAL' AND template_type='ZALO_PERSONAL_TEXT')
    );

ALTER TABLE public.messaging_campaigns
  DROP CONSTRAINT messaging_campaigns_channel_check,
  ADD CONSTRAINT messaging_campaigns_channel_check
  CHECK (channel IN ('FACEBOOK','ZALO_OA','ZALO_PERSONAL'));

ALTER TABLE public.messaging_suppressions
  DROP CONSTRAINT messaging_suppressions_channel_check,
  ADD CONSTRAINT messaging_suppressions_channel_check
  CHECK (channel IN ('FACEBOOK','ZALO_OA','ZALO_PERSONAL'));

-- Preserve the existing audited implementations for official channels.
ALTER FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb)
  RENAME TO campaign_sync_senders_before_personal;
ALTER FUNCTION public.campaign_eligibility(uuid,uuid)
  RENAME TO campaign_eligibility_before_personal;
ALTER FUNCTION public.campaign_command(uuid,uuid,text,jsonb)
  RENAME TO campaign_command_before_personal;
ALTER FUNCTION public.campaign_claim(uuid,text)
  RENAME TO campaign_claim_before_personal;
ALTER FUNCTION public.campaign_finish(uuid,uuid,uuid,text,text,text)
  RENAME TO campaign_finish_before_personal;

REVOKE ALL ON FUNCTION public.campaign_sync_senders_before_personal(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.campaign_eligibility_before_personal(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.campaign_command_before_personal(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.campaign_claim_before_personal(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.campaign_finish_before_personal(uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.campaign_sync_senders(p_company uuid,p_actor uuid,p_pages jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.campaign_sync_senders_before_personal(p_company,p_actor,p_pages);

  INSERT INTO public.messaging_sender_accounts(
    company_id,channel,external_id,name,connected,verified
  )
  SELECT p_company,'ZALO_PERSONAL',oa_id,'Zalo cá nhân',true,true
  FROM public.zalo_oa_configs
  WHERE company_id=p_company AND status='ACTIVE' AND app_id='ZCAJS'
    AND oa_id LIKE 'zcajs:%'
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1
  ON CONFLICT(channel,external_id) DO UPDATE
    SET name='Zalo cá nhân',connected=true,verified=true
    WHERE public.messaging_sender_accounts.company_id=p_company;
END $$;

CREATE FUNCTION public.campaign_eligibility(p_campaign uuid,p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  c public.messaging_campaigns;
  s public.messaging_sender_accounts;
  t public.message_templates;
  i public.identities;
  conv public.conversations;
  values jsonb;
  parameters jsonb;
  payload text;
  v_conflict_count int;
BEGIN
  SELECT * INTO STRICT c FROM public.messaging_campaigns WHERE id=p_campaign;
  IF c.channel <> 'ZALO_PERSONAL' THEN
    RETURN public.campaign_eligibility_before_personal(p_campaign,p_customer);
  END IF;

  SELECT * INTO STRICT s FROM public.messaging_sender_accounts
   WHERE company_id=c.company_id AND id=c.sender_account_id;

  IF EXISTS(
    SELECT 1 FROM public.messaging_suppressions
     WHERE company_id=c.company_id AND customer_id=p_customer
       AND channel IN ('ZALO_PERSONAL','ZALO_OA') AND revoked_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.care_schedules
     WHERE company_id=c.company_id AND customer_id=p_customer
       AND channel='ZALO' AND NOT enabled
  ) THEN
    RETURN '{"status":"UNSUBSCRIBED","reason":"UNSUBSCRIBED"}';
  END IF;

  IF NOT s.connected OR NOT s.verified OR s.channel <> 'ZALO_PERSONAL' OR NOT EXISTS(
    SELECT 1 FROM public.zalo_oa_configs
     WHERE company_id=c.company_id AND oa_id=s.external_id
       AND app_id='ZCAJS' AND status='ACTIVE'
  ) THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"SENDER_UNAVAILABLE"}';
  END IF;

  SELECT * INTO i FROM public.identities
   WHERE company_id=c.company_id AND customer_id=p_customer
     AND channel='ZALO' AND external_id ~ '^[0-9]+$'
     AND ((metadata->>'source')='ZCAJS' OR (metadata->>'provider')='zcajs')
   ORDER BY updated_at DESC NULLS LAST,id
   LIMIT 1;
  IF i.id IS NULL THEN
    RETURN '{"status":"MISSING_IDENTITY","reason":"MISSING_IDENTITY"}';
  END IF;

  SELECT count(DISTINCT customer_id) INTO v_conflict_count
    FROM public.identities
   WHERE company_id=c.company_id AND channel='ZALO' AND external_id=i.external_id;
  IF v_conflict_count > 1 THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"IDENTITY_CONFLICT"}';
  END IF;

  SELECT * INTO conv FROM public.conversations
   WHERE company_id=c.company_id AND customer_id=p_customer
     AND channel='ZALO' AND external_conversation_id=i.external_id
   ORDER BY updated_at DESC NULLS LAST,id
   LIMIT 1;
  IF conv.id IS NULL THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"MISSING_IDENTITY"}';
  END IF;

  SELECT * INTO t FROM public.message_templates
   WHERE company_id=c.company_id AND id=c.template_id;
  IF t.id IS NULL OR t.channel<>'ZALO_PERSONAL'
     OR t.template_type<>'ZALO_PERSONAL_TEXT'
     OR t.status<>'ACTIVE'
     OR (t.sender_account_id IS NOT NULL AND t.sender_account_id<>c.sender_account_id)
  THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"TEMPLATE_DISABLED"}';
  END IF;

  SELECT jsonb_build_object(
    'customer_name',cu.name,
    'customer_code',cu.customer_code,
    'company_name',co.name,
    'assigned_sale_name',u.full_name
  ) INTO values
  FROM public.customers cu
  JOIN public.companies co ON co.id=cu.company_id
  LEFT JOIN public.customer_dossier_profiles d
    ON d.company_id=cu.company_id AND d.customer_id=cu.id
  LEFT JOIN public.user_profiles u ON u.id=d.assigned_sale_id
  WHERE cu.company_id=c.company_id AND cu.id=p_customer;

  SELECT jsonb_object_agg(
    key,
    CASE WHEN jsonb_typeof(value)='string'
      THEN to_jsonb(regexp_replace(value#>>'{}','[+]?[0-9][0-9 .()-]{7,}[0-9]','[phone]','g'))
      ELSE value END
  ) INTO values FROM jsonb_each(values);

  BEGIN
    payload:=regexp_replace(
      public.campaign_render(c.template_snapshot->>'content',values),
      '[+]?[0-9][0-9 .()-]{7,}[0-9]','[phone]','g'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"MISSING_VARIABLE"}';
  END;

  IF EXISTS(
    SELECT 1 FROM jsonb_each_text(coalesce(c.template_snapshot->'parameter_mapping','{}'))
    WHERE nullif(btrim(values->>value),'') IS NULL
  ) THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"MISSING_VARIABLE"}';
  END IF;

  SELECT coalesce(jsonb_object_agg(key,values->>value),'{}') INTO parameters
    FROM jsonb_each_text(coalesce(c.template_snapshot->'parameter_mapping','{}'));

  RETURN jsonb_build_object(
    'status','ELIGIBLE',
    'identity_id',i.id,
    'conversation_id',conv.id,
    'payload',jsonb_build_object('text',payload,'parameters',parameters)
  );
END $$;

CREATE FUNCTION public.campaign_command(
  p_company uuid,p_actor uuid,p_command text,p_input jsonb DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  role text;
  c public.messaging_campaigns;
  cid uuid;
  scheduled timestamptz;
  before_validation text;
  after_validation text;
  v_base timestamptz;
BEGIN
  IF p_command <> 'confirm' THEN
    RETURN public.campaign_command_before_personal(p_company,p_actor,p_command,p_input);
  END IF;

  role:=public.campaign_actor(p_company,p_actor);
  SELECT * INTO c FROM public.messaging_campaigns
   WHERE company_id=p_company AND id=(p_input->>'id')::uuid
   FOR UPDATE;
  IF c.id IS NULL OR (role='SALE' AND c.created_by<>p_actor) THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  IF c.channel <> 'ZALO_PERSONAL' THEN
    RETURN public.campaign_command_before_personal(p_company,p_actor,p_command,p_input);
  END IF;

  cid:=c.id;
  IF role<>'BOSS_ADMIN' AND NOT EXISTS(
    SELECT 1 FROM public.messaging_campaign_settings
     WHERE company_id=p_company AND sale_execute
  ) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF c.confirmed_at IS NOT NULL THEN RETURN jsonb_build_object('id',cid); END IF;
  IF c.status<>'READY' THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
  IF (p_input->>'expected_version')::int IS DISTINCT FROM c.validation_version
    THEN RAISE EXCEPTION 'STALE_PREVIEW'; END IF;

  SELECT md5(string_agg(
    jsonb_build_array(id,eligibility_status,eligibility_reason,channel_identity_id,conversation_id,personalized_payload)::text,
    ',' ORDER BY id
  )) INTO before_validation
  FROM public.messaging_campaign_recipients WHERE campaign_id=cid;

  PERFORM public.campaign_validate(cid);

  SELECT md5(string_agg(
    jsonb_build_array(id,eligibility_status,eligibility_reason,channel_identity_id,conversation_id,personalized_payload)::text,
    ',' ORDER BY id
  )) INTO after_validation
  FROM public.messaging_campaign_recipients WHERE campaign_id=cid;

  IF before_validation IS DISTINCT FROM after_validation
    THEN RAISE EXCEPTION 'ELIGIBILITY_CHANGED_REVIEW_REQUIRED'; END IF;
  IF (SELECT eligible_count FROM public.messaging_campaigns WHERE id=cid)
       IS DISTINCT FROM (p_input->>'expected_eligible')::int
     OR (p_input->>'expected_eligible')::int<=0
    THEN RAISE EXCEPTION 'ELIGIBILITY_CHANGED_REVIEW_REQUIRED'; END IF;

  scheduled:=(p_input->>'scheduled_at')::timestamptz;
  IF scheduled IS NOT NULL AND (
    scheduled<=clock_timestamp() OR scheduled>clock_timestamp()+interval '90 days'
  ) THEN RAISE EXCEPTION 'INVALID_SCHEDULE'; END IF;

  INSERT INTO public.messaging_campaign_settings(company_id,enabled,sale_execute)
  VALUES(p_company,true,false)
  ON CONFLICT(company_id) DO UPDATE SET enabled=true;

  UPDATE public.messaging_campaigns
     SET status=CASE WHEN scheduled IS NULL THEN 'RUNNING' ELSE 'SCHEDULED' END,
         scheduled_at=scheduled,
         confirmed_at=clock_timestamp(),
         confirmed_by=p_actor
   WHERE id=cid;

  UPDATE public.messaging_campaign_recipients
     SET delivery_status='SKIPPED',queued_at=clock_timestamp(),next_attempt_at=NULL
   WHERE campaign_id=cid AND eligibility_status<>'ELIGIBLE';

  v_base:=coalesce(scheduled,clock_timestamp());
  WITH ordered AS (
    SELECT id,row_number() OVER(ORDER BY created_at,id)-1 AS seq
      FROM public.messaging_campaign_recipients
     WHERE campaign_id=cid AND eligibility_status='ELIGIBLE'
  )
  UPDATE public.messaging_campaign_recipients r
     SET delivery_status='QUEUED',
         queued_at=clock_timestamp(),
         next_attempt_at=v_base + (ordered.seq * interval '5 minutes')
    FROM ordered
   WHERE r.id=ordered.id;

  INSERT INTO public.messaging_campaign_audit(
    company_id,campaign_id,actor_user_id,event,metadata
  ) VALUES(
    p_company,cid,p_actor,'campaign_confirmed',
    jsonb_build_object('delivery_mode','ZALO_PERSONAL','spacing_seconds',300)
  );
  PERFORM public.campaign_recount(cid);
  RETURN jsonb_build_object('id',cid);
END $$;

CREATE FUNCTION public.campaign_claim(p_company uuid,p_channel text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.messaging_campaigns; r public.messaging_campaign_recipients;
BEGIN
  IF p_channel <> 'ZALO_PERSONAL' THEN
    RETURN public.campaign_claim_before_personal(p_company,p_channel);
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.messaging_campaign_settings
     WHERE company_id=p_company AND enabled
  ) THEN RETURN NULL; END IF;

  SELECT * INTO c FROM public.messaging_campaigns
   WHERE company_id=p_company AND channel='ZALO_PERSONAL'
     AND status IN ('RUNNING','SCHEDULED','PAUSED','CANCELLED')
     AND confirmed_at IS NOT NULL
     AND coalesce(scheduled_at,created_at)<=clock_timestamp()
     AND EXISTS(
       SELECT 1 FROM public.messaging_campaign_recipients q
        WHERE q.campaign_id=messaging_campaigns.id AND (
          (messaging_campaigns.status IN ('RUNNING','SCHEDULED') AND (
            (q.delivery_status='QUEUED' AND q.next_attempt_at<=clock_timestamp()) OR
            (q.delivery_status='CLAIMED' AND q.lease_until<clock_timestamp())
          )) OR
          (q.delivery_status='SENDING' AND q.lease_until<clock_timestamp())
        )
     )
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF c.id IS NULL THEN RETURN NULL; END IF;

  WITH expired AS (
    UPDATE public.messaging_campaign_recipients
       SET delivery_status='UNCERTAIN',
           provider_error_code='LEASE_EXPIRED_AFTER_DISPATCH',
           provider_error_message_sanitized='Provider outcome unknown; reconciliation required.',
           lock_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
     WHERE campaign_id=c.id AND delivery_status='SENDING' AND lease_until<clock_timestamp()
     RETURNING *
  )
  INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,event,metadata)
  SELECT company_id,campaign_id,'recipient_failed',
         jsonb_build_object('recipient_id',id,'code','LEASE_EXPIRED_AFTER_DISPATCH')
    FROM expired;

  IF c.status IN ('PAUSED','CANCELLED') THEN
    PERFORM public.campaign_recount(c.id); RETURN NULL;
  END IF;

  SELECT * INTO r FROM public.messaging_campaign_recipients
   WHERE campaign_id=c.id AND attempt_count<5 AND (
     (delivery_status='QUEUED' AND next_attempt_at<=clock_timestamp()) OR
     (delivery_status='CLAIMED' AND lease_until<clock_timestamp())
   )
   ORDER BY next_attempt_at,created_at,id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF r.id IS NULL THEN PERFORM public.campaign_recount(c.id); RETURN NULL; END IF;

  UPDATE public.messaging_campaign_recipients
     SET delivery_status='CLAIMED',lock_token=gen_random_uuid(),
         lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
   WHERE id=r.id RETURNING * INTO r;

  RETURN jsonb_build_object(
    'id',r.id,'company_id',r.company_id,'campaign_id',c.id,
    'lock_token',r.lock_token,'channel',c.channel
  );
END $$;

CREATE FUNCTION public.campaign_finish(
  p_company uuid,p_recipient uuid,p_token uuid,p_status text,
  p_message_id text DEFAULT NULL,p_code text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  ok boolean;
  v_channel text;
  v_attempt int;
BEGIN
  SELECT c.channel,r.attempt_count INTO v_channel,v_attempt
    FROM public.messaging_campaign_recipients r
    JOIN public.messaging_campaigns c ON c.id=r.campaign_id
   WHERE r.company_id=p_company AND r.id=p_recipient;

  ok:=public.campaign_finish_before_personal(
    p_company,p_recipient,p_token,p_status,p_message_id,p_code
  );

  IF ok AND v_channel='ZALO_PERSONAL' THEN
    UPDATE public.interactions
       SET channel='ZALO'
     WHERE company_id=p_company
       AND external_ref='campaign:'||p_recipient::text||':'||v_attempt::text
       AND channel='FACEBOOK';
  END IF;
  RETURN ok;
END $$;

REVOKE ALL ON FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_eligibility(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_command(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_claim(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_finish(uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_command(uuid,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_claim(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_finish(uuid,uuid,uuid,text,text,text) TO service_role;

COMMENT ON FUNCTION public.campaign_claim(uuid,text) IS
  'Claims only due recipients. ZALO_PERSONAL recipients are pre-spaced by 5 minutes at confirm time.';

COMMIT;
