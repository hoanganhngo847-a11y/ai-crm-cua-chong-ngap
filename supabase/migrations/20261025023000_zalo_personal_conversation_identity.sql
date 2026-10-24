BEGIN;

CREATE OR REPLACE FUNCTION public.campaign_sync_senders(
  p_company uuid,
  p_actor uuid,
  p_pages jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path='' AS $$
BEGIN
  PERFORM public.campaign_sync_senders_before_personal(p_company,p_actor,p_pages);

  INSERT INTO public.messaging_sender_accounts(
    company_id,channel,external_id,name,connected,verified
  )
  SELECT p_company,'ZALO_PERSONAL',oa_id,'Zalo cá nhân',true,true
    FROM public.zalo_oa_configs
   WHERE company_id=p_company
     AND status='ACTIVE'
     AND app_id='ZCAJS'
     AND oa_id LIKE 'zcajs:%'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1
  ON CONFLICT(channel,external_id) DO UPDATE
    SET name='Zalo cá nhân',connected=true,verified=true
    WHERE public.messaging_sender_accounts.company_id=p_company;

  -- ZCAJS ingress stores its authoritative peer id on the conversation rather than
  -- on identities.metadata. Materialize that observed peer id into the canonical
  -- identities table so the existing campaign FK/fencing model remains intact.
  INSERT INTO public.identities(
    company_id,customer_id,channel,external_id,verified,metadata
  )
  SELECT
    conv.company_id,
    conv.customer_id,
    'ZALO',
    conv.external_conversation_id,
    false,
    jsonb_build_object(
      'source','ZCAJS',
      'provider','zcajs',
      'materialized_from','conversation'
    )
  FROM public.conversations conv
  WHERE conv.company_id=p_company
    AND conv.channel='ZALO'
    AND conv.customer_id IS NOT NULL
    AND conv.external_conversation_id ~ '^[0-9]+$'
    AND lower(coalesce(conv.metadata->>'provider',''))='zcajs'
  ON CONFLICT(company_id,channel,external_id) DO UPDATE
    SET metadata=public.identities.metadata || EXCLUDED.metadata,
        updated_at=clock_timestamp()
    WHERE public.identities.customer_id=EXCLUDED.customer_id;
END $$;

CREATE OR REPLACE FUNCTION public.campaign_eligibility(
  p_campaign uuid,
  p_customer uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path='' AS $$
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
  SELECT * INTO STRICT c
    FROM public.messaging_campaigns
   WHERE id=p_campaign;

  IF c.channel <> 'ZALO_PERSONAL' THEN
    RETURN public.campaign_eligibility_before_personal(p_campaign,p_customer);
  END IF;

  SELECT * INTO STRICT s
    FROM public.messaging_sender_accounts
   WHERE company_id=c.company_id
     AND id=c.sender_account_id;

  IF EXISTS(
    SELECT 1
      FROM public.messaging_suppressions
     WHERE company_id=c.company_id
       AND customer_id=p_customer
       AND channel IN ('ZALO_PERSONAL','ZALO_OA')
       AND revoked_at IS NULL
  ) OR EXISTS(
    SELECT 1
      FROM public.care_schedules
     WHERE company_id=c.company_id
       AND customer_id=p_customer
       AND channel='ZALO'
       AND NOT enabled
  ) THEN
    RETURN '{"status":"UNSUBSCRIBED","reason":"UNSUBSCRIBED"}';
  END IF;

  IF NOT s.connected
     OR NOT s.verified
     OR s.channel <> 'ZALO_PERSONAL'
     OR NOT EXISTS(
       SELECT 1
         FROM public.zalo_oa_configs
        WHERE company_id=c.company_id
          AND oa_id=s.external_id
          AND app_id='ZCAJS'
          AND status='ACTIVE'
     )
  THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"SENDER_UNAVAILABLE"}';
  END IF;

  -- The conversation is the authoritative marker that this peer was observed via
  -- the currently connected personal-Zalo transport.
  SELECT * INTO conv
    FROM public.conversations
   WHERE company_id=c.company_id
     AND customer_id=p_customer
     AND channel='ZALO'
     AND external_conversation_id ~ '^[0-9]+$'
     AND lower(coalesce(metadata->>'provider',''))='zcajs'
   ORDER BY updated_at DESC NULLS LAST,id
   LIMIT 1;

  IF conv.id IS NULL THEN
    RETURN '{"status":"MISSING_IDENTITY","reason":"MISSING_IDENTITY"}';
  END IF;

  SELECT * INTO i
    FROM public.identities
   WHERE company_id=c.company_id
     AND customer_id=p_customer
     AND channel='ZALO'
     AND external_id=conv.external_conversation_id
   ORDER BY updated_at DESC NULLS LAST,id
   LIMIT 1;

  IF i.id IS NULL THEN
    RETURN '{"status":"MISSING_IDENTITY","reason":"MISSING_IDENTITY"}';
  END IF;

  SELECT count(DISTINCT customer_id) INTO v_conflict_count
    FROM public.identities
   WHERE company_id=c.company_id
     AND channel='ZALO'
     AND external_id=i.external_id;

  IF v_conflict_count > 1 THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"IDENTITY_CONFLICT"}';
  END IF;

  SELECT * INTO t
    FROM public.message_templates
   WHERE company_id=c.company_id
     AND id=c.template_id;

  IF t.id IS NULL
     OR t.channel<>'ZALO_PERSONAL'
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
  WHERE cu.company_id=c.company_id
    AND cu.id=p_customer;

  SELECT jsonb_object_agg(
    key,
    CASE WHEN jsonb_typeof(value)='string'
      THEN to_jsonb(regexp_replace(value#>>'{}','[+]?[0-9][0-9 .()-]{7,}[0-9]','[phone]','g'))
      ELSE value END
  ) INTO values
  FROM jsonb_each(values);

  BEGIN
    payload:=regexp_replace(
      public.campaign_render(c.template_snapshot->>'content',values),
      '[+]?[0-9][0-9 .()-]{7,}[0-9]','[phone]','g'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN '{"status":"BLOCKED_POLICY","reason":"MISSING_VARIABLE"}';
  END;

  IF EXISTS(
    SELECT 1
      FROM jsonb_each_text(coalesce(c.template_snapshot->'parameter_mapping','{}'))
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

REVOKE ALL ON FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_eligibility(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb)
  TO service_role;

COMMENT ON FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb) IS
  'Syncs official senders plus the active ZCAJS logical sender and materializes personal-Zalo peer identities from ZCAJS conversations.';

COMMIT;
