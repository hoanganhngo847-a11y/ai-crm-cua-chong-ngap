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

    linked := NULL;
    IF candidate.linked_customer_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.customers
       WHERE company_id=p_company AND id=candidate.linked_customer_id
    ) THEN
      linked := candidate.linked_customer_id;
    END IF;

    -- Exact ZCAJS identity is authoritative. Display name is never a join key.
    IF linked IS NULL THEN
      SELECT i.customer_id INTO linked
        FROM public.identities i
       WHERE i.company_id=p_company
         AND i.channel='ZALO'
         AND i.external_id=ext
         AND (
           upper(coalesce(i.metadata->>'source',''))='ZCAJS'
           OR lower(coalesce(i.metadata->>'provider',''))='zcajs'
         )
       LIMIT 1;
    END IF;

    -- Exact ZCAJS conversation is also authoritative.
    IF linked IS NULL THEN
      SELECT c.customer_id INTO linked
        FROM public.conversations c
       WHERE c.company_id=p_company
         AND c.channel='ZALO'
         AND c.external_conversation_id=ext
         AND lower(coalesce(c.metadata->>'provider',''))='zcajs'
       LIMIT 1;
    END IF;

    -- A numeric OA/ambiguous route is never converted to personal Zalo automatically.
    IF linked IS NULL AND (
      EXISTS (
        SELECT 1 FROM public.identities i
         WHERE i.company_id=p_company AND i.channel='ZALO' AND i.external_id=ext
           AND NOT (
             upper(coalesce(i.metadata->>'source',''))='ZCAJS'
             OR lower(coalesce(i.metadata->>'provider',''))='zcajs'
           )
      )
      OR EXISTS (
        SELECT 1 FROM public.conversations c
         WHERE c.company_id=p_company AND c.channel='ZALO'
           AND c.external_conversation_id=ext
           AND lower(coalesce(c.metadata->>'provider','')) <> 'zcajs'
      )
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

    -- Campaign eligibility currently requires an observed canonical conversation route.
    -- Directory-only routes are CLOSED so they do not masquerade as unread/open chats.
    INSERT INTO public.conversations(
      company_id,customer_id,channel,external_conversation_id,
      last_message_at,unread_count,status,metadata,created_at,updated_at
    ) VALUES (
      p_company,linked,'ZALO',ext,
      candidate.last_seen_at,0,'CLOSED',jsonb_build_object(
        'provider','zcajs',
        'source','ZCAJS',
        'directory_materialized',true,
        'zero_touch',true,
        'zalo_display_name',display
      ),clock_timestamp(),clock_timestamp()
    )
    ON CONFLICT(company_id,channel,external_conversation_id) DO UPDATE SET
      metadata=coalesce(public.conversations.metadata,'{}'::jsonb) || EXCLUDED.metadata,
      updated_at=clock_timestamp()
    WHERE public.conversations.customer_id=EXCLUDED.customer_id
      AND lower(coalesce(public.conversations.metadata->>'provider',''))='zcajs';

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

REVOKE ALL ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb)
  TO service_role;

COMMENT ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb) IS
  'Zero-touch ZCAJS directory sync: exact UID routes are reused; otherwise a canonical Zalo Customer 360 + identity + closed conversation route is created. Never matches by display name and never converts OA routes.';

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
