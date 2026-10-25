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
  legacy_upgraded int := 0;
  route_identity_count bigint;
  blank_identity_count bigint;
  legacy_identity_customer uuid;
  route_conversation_count bigint;
  blank_provider_conversation_count bigint;
  route_conversation_customer_count bigint;
  legacy_conversation_customer uuid;
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

    -- Legacy compatibility: older personal-Zalo rows were created before provider metadata existed.
    -- Promote only when there is exactly one blank-metadata identity, exactly one blank-provider
    -- conversation, both point to the same customer, and this UID is now observed by the ZCAJS
    -- personal directory. Names are never used as a join key.
    SELECT count(*),
           count(*) FILTER (
             WHERE nullif(btrim(coalesce(i.metadata->>'source','')),'') IS NULL
               AND nullif(btrim(coalesce(i.metadata->>'provider','')),'') IS NULL
           ),
           max(i.customer_id::text)::uuid
      INTO route_identity_count,blank_identity_count,legacy_identity_customer
      FROM public.identities i
     WHERE i.company_id=p_company
       AND i.channel='ZALO'
       AND i.external_id=ext;

    SELECT count(*),
           count(*) FILTER (
             WHERE nullif(btrim(coalesce(c.metadata->>'provider','')),'') IS NULL
           ),
           count(DISTINCT c.customer_id),
           max(c.customer_id::text)::uuid
      INTO route_conversation_count,blank_provider_conversation_count,
           route_conversation_customer_count,legacy_conversation_customer
      FROM public.conversations c
     WHERE c.company_id=p_company
       AND c.channel='ZALO'
       AND c.external_conversation_id=ext;

    IF upper(coalesce(candidate.metadata->>'source',''))='ZCAJS'
       AND coalesce(candidate.metadata->>'directory','')='personal_directory'
       AND route_identity_count=1
       AND blank_identity_count=1
       AND route_conversation_count=1
       AND blank_provider_conversation_count=1
       AND route_conversation_customer_count=1
       AND legacy_identity_customer IS NOT NULL
       AND legacy_identity_customer=legacy_conversation_customer
       AND EXISTS (
         SELECT 1 FROM public.customers cu
          WHERE cu.company_id=p_company
            AND cu.id=legacy_identity_customer
            AND cu.source='ZALO'
       )
    THEN
      UPDATE public.identities i
         SET metadata=coalesce(i.metadata,'{}'::jsonb) || jsonb_build_object(
               'source','ZCAJS',
               'provider','zcajs',
               'directory_seen',true,
               'zero_touch',true,
               'legacy_upgraded',true,
               'link_source','legacy_exact_uid'
             ),
             display_name=coalesce(display,i.display_name),
             updated_at=clock_timestamp()
       WHERE i.company_id=p_company
         AND i.channel='ZALO'
         AND i.external_id=ext
         AND i.customer_id=legacy_identity_customer
         AND nullif(btrim(coalesce(i.metadata->>'source','')),'') IS NULL
         AND nullif(btrim(coalesce(i.metadata->>'provider','')),'') IS NULL;

      UPDATE public.conversations c
         SET metadata=coalesce(c.metadata,'{}'::jsonb) || jsonb_build_object(
               'source','ZCAJS',
               'provider','zcajs',
               'legacy_upgraded',true
             ),
             updated_at=clock_timestamp()
       WHERE c.company_id=p_company
         AND c.channel='ZALO'
         AND c.external_conversation_id=ext
         AND c.customer_id=legacy_identity_customer
         AND nullif(btrim(coalesce(c.metadata->>'provider','')),'') IS NULL;

      legacy_upgraded := legacy_upgraded + 1;
    END IF;

    -- Explicit OA/other-provider routes remain fail-closed. A safely promoted legacy route now
    -- carries ZCAJS metadata and therefore passes this guard.
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

    SELECT c.customer_id INTO conversation_customer
      FROM public.conversations c
     WHERE c.company_id=p_company
       AND c.channel='ZALO'
       AND c.external_conversation_id=ext
       AND lower(coalesce(c.metadata->>'provider',''))='zcajs'
     LIMIT 1;

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
             jsonb_build_object(
               'zero_touch',true,
               'link_source',CASE WHEN legacy_identity_customer=linked AND legacy_upgraded>0
                                  THEN 'legacy_exact_uid' ELSE 'uid' END
             ),
           last_seen_at=greatest(last_seen_at,clock_timestamp())
     WHERE id=candidate.id;
  END LOOP;

  RETURN jsonb_build_object(
    'seen',seen_count,
    'auto_linked',auto_linked,
    'auto_created',auto_created,
    'legacy_upgraded',legacy_upgraded,
    'route_conflicts',route_conflicts
  );
END $$;

REVOKE ALL ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb)
  TO service_role;

COMMENT ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb) IS
  'Zero-touch ZCAJS directory sync with safe legacy-route promotion: exact UID identity + exact UID conversation must uniquely agree on the same ZALO customer before blank legacy metadata is upgraded. Never matches by display name and never converts explicit OA routes.';

-- Re-run the already-synced directory through the hardened function so safe legacy rows are
-- upgraded immediately without waiting for another worker sync cycle.
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
