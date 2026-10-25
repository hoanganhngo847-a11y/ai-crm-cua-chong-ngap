BEGIN;

CREATE OR REPLACE FUNCTION public.sync_zalo_personal_contacts(
  p_company uuid,
  p_contacts jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  item jsonb;
  ext text;
  display text;
  linked uuid;
  identity_customer uuid;
  conversation_customer uuid;
  candidate public.zalo_personal_contact_candidates;
  seen_count int := 0;
  auto_linked int := 0;
  auto_created int := 0;
  route_conflicts int := 0;
BEGIN
  IF p_company IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.companies WHERE id=p_company
  ) THEN RAISE EXCEPTION 'INVALID_COMPANY'; END IF;

  IF jsonb_typeof(p_contacts) <> 'array' OR jsonb_array_length(p_contacts) > 5000 THEN
    RAISE EXCEPTION 'INVALID_CONTACT_BATCH';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_contacts) LOOP
    ext := btrim(coalesce(item->>'externalUserId',''));
    display := nullif(left(regexp_replace(coalesce(item->>'displayName',''), '\\s+', ' ', 'g'),160),'');
    IF ext !~ '^[0-9]{5,40}$' THEN CONTINUE; END IF;
    seen_count := seen_count + 1;

    -- Serialize all decisions for one personal-Zalo UID inside the company.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_company::text || ':ZALO_PERSONAL:' || ext, 0));

    INSERT INTO public.zalo_personal_contact_candidates(
      company_id,external_id,display_name,status,linked_customer_id,last_seen_at,linked_at,metadata
    ) VALUES (
      p_company,ext,display,'UNLINKED',NULL,clock_timestamp(),NULL,
      jsonb_build_object('source','ZCAJS','directory','personal_directory')
    )
    ON CONFLICT(company_id,external_id) DO UPDATE SET
      display_name=coalesce(EXCLUDED.display_name,public.zalo_personal_contact_candidates.display_name),
      last_seen_at=clock_timestamp(),
      metadata=coalesce(public.zalo_personal_contact_candidates.metadata,'{}'::jsonb) || EXCLUDED.metadata;

    SELECT * INTO candidate
      FROM public.zalo_personal_contact_candidates
     WHERE company_id=p_company AND external_id=ext
     FOR UPDATE;

    -- A numeric OA/ambiguous route is never converted to personal Zalo automatically,
    -- even if an older candidate or conversation points at a customer.
    IF EXISTS (
      SELECT 1 FROM public.identities i
       WHERE i.company_id=p_company AND i.channel='ZALO' AND i.external_id=ext
         AND NOT (
           upper(coalesce(i.metadata->>'source',''))='ZCAJS'
           OR lower(coalesce(i.metadata->>'provider',''))='zcajs'
         )
    ) OR EXISTS (
      SELECT 1 FROM public.conversations c
       WHERE c.company_id=p_company AND c.channel='ZALO'
         AND c.external_conversation_id=ext
         AND lower(coalesce(c.metadata->>'provider','')) <> 'zcajs'
    ) THEN
      route_conflicts := route_conflicts + 1;
      UPDATE public.zalo_personal_contact_candidates
         SET status='UNLINKED', linked_customer_id=NULL, linked_at=NULL,
             metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
               'route_conflict',true,
               'zero_touch_blocked',true
             )
       WHERE id=candidate.id;
      CONTINUE;
    END IF;

    identity_customer := NULL;
    conversation_customer := NULL;

    -- Exact ZCAJS identity is authoritative. Display name is never a join key.
    SELECT i.customer_id INTO identity_customer
      FROM public.identities i
     WHERE i.company_id=p_company
       AND i.channel='ZALO'
       AND i.external_id=ext
       AND (
         upper(coalesce(i.metadata->>'source',''))='ZCAJS'
         OR lower(coalesce(i.metadata->>'provider',''))='zcajs'
       )
     LIMIT 1;

    -- A real ZCAJS conversation is also authoritative when it exists.
    SELECT c.customer_id INTO conversation_customer
      FROM public.conversations c
     WHERE c.company_id=p_company
       AND c.channel='ZALO'
       AND c.external_conversation_id=ext
       AND lower(coalesce(c.metadata->>'provider',''))='zcajs'
     LIMIT 1;

    -- Multiple exact UID routes must agree on the customer. Never guess through a conflict.
    IF identity_customer IS NOT NULL
       AND conversation_customer IS NOT NULL
       AND identity_customer <> conversation_customer THEN
      route_conflicts := route_conflicts + 1;
      UPDATE public.zalo_personal_contact_candidates
         SET status='UNLINKED', linked_customer_id=NULL, linked_at=NULL,
             metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
               'route_conflict',true,
               'zero_touch_blocked',true
             )
       WHERE id=candidate.id;
      CONTINUE;
    END IF;

    linked := NULL;
    IF candidate.linked_customer_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.customers
       WHERE company_id=p_company AND id=candidate.linked_customer_id
    ) THEN
      linked := candidate.linked_customer_id;
      IF (identity_customer IS NOT NULL AND identity_customer <> linked)
         OR (conversation_customer IS NOT NULL AND conversation_customer <> linked) THEN
        route_conflicts := route_conflicts + 1;
        UPDATE public.zalo_personal_contact_candidates
           SET status='UNLINKED', linked_customer_id=NULL, linked_at=NULL,
               metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
                 'route_conflict',true,
                 'zero_touch_blocked',true
               )
         WHERE id=candidate.id;
        CONTINUE;
      END IF;
    ELSE
      linked := coalesce(identity_customer,conversation_customer);
    END IF;

    -- Zero-touch path: a UID with no established route gets its own canonical Customer 360.
    -- This intentionally does NOT reuse any customer merely because the display name matches.
    IF linked IS NULL THEN
      INSERT INTO public.customers(company_id,name,source,stage)
      VALUES (
        p_company,
        coalesce(display,'Khách Zalo ' || right(ext,6)),
        'ZALO',
        'LEAD_NEW'
      ) RETURNING id INTO linked;
      auto_created := auto_created + 1;
    ELSE
      auto_linked := auto_linked + 1;
    END IF;

    INSERT INTO public.identities(
      company_id,customer_id,channel,external_id,verified,metadata,display_name,created_at,updated_at
    ) VALUES (
      p_company,linked,'ZALO',ext,false,
      jsonb_build_object(
        'source','ZCAJS',
        'provider','zcajs',
        'link_source',CASE WHEN candidate.linked_customer_id IS NULL THEN 'directory_zero_touch' ELSE 'existing_link' END,
        'directory_seen',true,
        'zero_touch',true
      ),
      display,clock_timestamp(),clock_timestamp()
    )
    ON CONFLICT(company_id,channel,external_id) DO UPDATE SET
      display_name=coalesce(EXCLUDED.display_name,public.identities.display_name),
      updated_at=clock_timestamp(),
      metadata=coalesce(public.identities.metadata,'{}'::jsonb) || EXCLUDED.metadata
    WHERE public.identities.customer_id=EXCLUDED.customer_id
      AND (
        upper(coalesce(public.identities.metadata->>'source',''))='ZCAJS'
        OR lower(coalesce(public.identities.metadata->>'provider',''))='zcajs'
      );

    UPDATE public.zalo_personal_contact_candidates
       SET status='LINKED',
           linked_customer_id=linked,
           linked_at=coalesce(linked_at,clock_timestamp()),
           metadata=(coalesce(metadata,'{}'::jsonb) - 'route_conflict' - 'zero_touch_blocked') ||
             jsonb_build_object('zero_touch',true,'link_source','uid'),
           last_seen_at=greatest(last_seen_at,clock_timestamp())
     WHERE id=candidate.id;
  END LOOP;

  RETURN jsonb_build_object(
    'seen',seen_count,
    'auto_linked',auto_linked,
    'auto_created',auto_created,
    'route_conflicts',route_conflicts
  );
END $$;

-- Personal-Zalo campaigns can dispatch directly from the canonical ZCAJS identity.
-- conversation_id remains populated when a real conversation exists, but directory-only
-- contacts do not get synthetic Inbox conversations just to become campaign-eligible.
CREATE OR REPLACE FUNCTION public.campaign_eligibility(
  p_campaign uuid,
  p_customer uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
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

  SELECT * INTO i
    FROM public.identities
   WHERE company_id=c.company_id
     AND customer_id=p_customer
     AND channel='ZALO'
     AND external_id ~ '^[0-9]+$'
     AND (
       upper(coalesce(metadata->>'source',''))='ZCAJS'
       OR lower(coalesce(metadata->>'provider',''))='zcajs'
     )
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

  SELECT * INTO conv
    FROM public.conversations
   WHERE company_id=c.company_id
     AND customer_id=p_customer
     AND channel='ZALO'
     AND external_conversation_id=i.external_id
     AND lower(coalesce(metadata->>'provider',''))='zcajs'
   ORDER BY updated_at DESC NULLS LAST,id
   LIMIT 1;

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

REVOKE ALL ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.campaign_eligibility(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb)
  TO service_role;

COMMENT ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb) IS
  'Zero-touch ZCAJS directory sync: exact UID routes are reused; otherwise a canonical Zalo Customer 360 + identity is created. Never matches by display name, never creates synthetic Inbox conversations, and never converts OA routes.';
COMMENT ON FUNCTION public.campaign_eligibility(uuid,uuid) IS
  'ZALO_PERSONAL eligibility uses the canonical ZCAJS identity directly; a real conversation is optional.';

-- Backfill the already-synced directory candidates so production does not require a manual resync.
DO $$
DECLARE
  row record;
BEGIN
  FOR row IN
    SELECT company_id,
           jsonb_agg(jsonb_build_object(
             'externalUserId',external_id,
             'displayName',display_name
           ) ORDER BY external_id) AS contacts
      FROM public.zalo_personal_contact_candidates
     GROUP BY company_id
  LOOP
    PERFORM public.sync_zalo_personal_contacts(row.company_id,row.contacts);
  END LOOP;
END $$;

COMMIT;
