BEGIN;

CREATE TABLE public.zalo_personal_contact_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'UNLINKED'
    CHECK (status IN ('UNLINKED','LINKED')),
  linked_customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  linked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT zalo_personal_contact_candidates_external_id_check
    CHECK (external_id ~ '^[0-9]{5,40}$'),
  CONSTRAINT zalo_personal_contact_candidates_company_external_key
    UNIQUE (company_id, external_id)
);

CREATE INDEX zalo_personal_contact_candidates_unlinked_idx
  ON public.zalo_personal_contact_candidates(company_id, last_seen_at DESC)
  WHERE status='UNLINKED';

ALTER TABLE public.zalo_personal_contact_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zalo_personal_contact_candidates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.zalo_personal_contact_candidates TO service_role;

CREATE FUNCTION public.sync_zalo_personal_contacts(
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
  seen_count int := 0;
  auto_linked int := 0;
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
    linked := NULL;

    -- Only a previously established ZCAJS identity is authoritative for automatic linking.
    -- A numeric Zalo OA identity is not evidence that the personal-account UID is the same route.
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

    IF linked IS NULL THEN
      SELECT c.customer_id INTO linked
        FROM public.conversations c
       WHERE c.company_id=p_company
         AND c.channel='ZALO'
         AND c.external_conversation_id=ext
         AND lower(coalesce(c.metadata->>'provider',''))='zcajs'
       LIMIT 1;

      IF linked IS NOT NULL THEN
        -- Do not overwrite an official/ambiguous identity that happens to share a numeric id.
        IF EXISTS (
          SELECT 1 FROM public.identities i
           WHERE i.company_id=p_company AND i.channel='ZALO' AND i.external_id=ext
             AND NOT (
               upper(coalesce(i.metadata->>'source',''))='ZCAJS'
               OR lower(coalesce(i.metadata->>'provider',''))='zcajs'
             )
        ) THEN
          linked := NULL;
        ELSE
          INSERT INTO public.identities(
            company_id,customer_id,channel,external_id,verified,metadata,created_at,updated_at
          ) VALUES (
            p_company,linked,'ZALO',ext,false,
            jsonb_build_object('source','ZCAJS','provider','zcajs','link_source','existing_conversation'),
            clock_timestamp(),clock_timestamp()
          )
          ON CONFLICT(company_id,channel,external_id) DO UPDATE
            SET updated_at=clock_timestamp(),
                metadata=coalesce(public.identities.metadata,'{}'::jsonb) ||
                  jsonb_build_object('source','ZCAJS','provider','zcajs');
          auto_linked := auto_linked + 1;
        END IF;
      END IF;
    END IF;

    INSERT INTO public.zalo_personal_contact_candidates(
      company_id,external_id,display_name,status,linked_customer_id,last_seen_at,linked_at,metadata
    ) VALUES (
      p_company,ext,display,
      CASE WHEN linked IS NULL THEN 'UNLINKED' ELSE 'LINKED' END,
      linked,clock_timestamp(),
      CASE WHEN linked IS NULL THEN NULL ELSE clock_timestamp() END,
      jsonb_build_object('source','ZCAJS','directory','personal_directory')
    )
    ON CONFLICT(company_id,external_id) DO UPDATE SET
      display_name=coalesce(EXCLUDED.display_name,public.zalo_personal_contact_candidates.display_name),
      last_seen_at=clock_timestamp(),
      status=CASE WHEN linked IS NULL AND public.zalo_personal_contact_candidates.linked_customer_id IS NULL
                  THEN 'UNLINKED' ELSE 'LINKED' END,
      linked_customer_id=coalesce(linked,public.zalo_personal_contact_candidates.linked_customer_id),
      linked_at=CASE WHEN coalesce(linked,public.zalo_personal_contact_candidates.linked_customer_id) IS NULL
                     THEN public.zalo_personal_contact_candidates.linked_at
                     ELSE coalesce(public.zalo_personal_contact_candidates.linked_at,clock_timestamp()) END,
      metadata=coalesce(public.zalo_personal_contact_candidates.metadata,'{}'::jsonb) || EXCLUDED.metadata;
  END LOOP;

  RETURN jsonb_build_object('seen',seen_count,'auto_linked',auto_linked);
END $$;

CREATE FUNCTION public.link_zalo_personal_contact(
  p_company uuid,
  p_actor uuid,
  p_candidate uuid,
  p_customer uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  role_name text;
  candidate public.zalo_personal_contact_candidates;
  existing_identity public.identities;
  existing_conversation public.conversations;
  identity_id uuid;
  conversation_id uuid;
BEGIN
  role_name := public.campaign_actor(p_company,p_actor);
  IF role_name <> 'BOSS_ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT * INTO candidate
    FROM public.zalo_personal_contact_candidates
   WHERE id=p_candidate AND company_id=p_company
   FOR UPDATE;
  IF candidate.id IS NULL THEN RAISE EXCEPTION 'CONTACT_NOT_FOUND'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.customers WHERE id=p_customer AND company_id=p_company
  ) THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND'; END IF;

  SELECT * INTO existing_identity
    FROM public.identities
   WHERE company_id=p_company AND channel='ZALO' AND external_id=candidate.external_id
   LIMIT 1 FOR UPDATE;
  IF existing_identity.id IS NOT NULL THEN
    IF NOT (
      upper(coalesce(existing_identity.metadata->>'source',''))='ZCAJS'
      OR lower(coalesce(existing_identity.metadata->>'provider',''))='zcajs'
    ) THEN
      RAISE EXCEPTION 'IDENTITY_ROUTE_CONFLICT';
    END IF;
    IF existing_identity.customer_id <> p_customer THEN
      RAISE EXCEPTION 'IDENTITY_CONFLICT';
    END IF;
  END IF;

  SELECT * INTO existing_conversation
    FROM public.conversations
   WHERE company_id=p_company AND channel='ZALO'
     AND external_conversation_id=candidate.external_id
   LIMIT 1 FOR UPDATE;
  IF existing_conversation.id IS NOT NULL THEN
    IF existing_conversation.customer_id <> p_customer THEN
      RAISE EXCEPTION 'CONVERSATION_CONFLICT';
    END IF;
    IF lower(coalesce(existing_conversation.metadata->>'provider','')) NOT IN ('','zcajs') THEN
      RAISE EXCEPTION 'CONVERSATION_ROUTE_CONFLICT';
    END IF;
    UPDATE public.conversations
       SET metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'provider','zcajs','source','ZCAJS','contact_linked',true,
             'zalo_display_name',candidate.display_name
           ),
           updated_at=clock_timestamp()
     WHERE id=existing_conversation.id
     RETURNING id INTO conversation_id;
  ELSE
    INSERT INTO public.conversations(
      company_id,customer_id,channel,external_conversation_id,
      last_message_at,unread_count,status,metadata,created_at,updated_at
    ) VALUES (
      p_company,p_customer,'ZALO',candidate.external_id,
      clock_timestamp(),0,'OPEN',jsonb_build_object(
        'provider','zcajs','source','ZCAJS','contact_linked',true,
        'zalo_display_name',candidate.display_name
      ),clock_timestamp(),clock_timestamp()
    ) RETURNING id INTO conversation_id;
  END IF;

  IF existing_identity.id IS NULL THEN
    INSERT INTO public.identities(
      company_id,customer_id,channel,external_id,verified,metadata,display_name,created_at,updated_at
    ) VALUES (
      p_company,p_customer,'ZALO',candidate.external_id,false,
      jsonb_build_object('source','ZCAJS','provider','zcajs','link_source','manual_confirmed'),
      candidate.display_name,clock_timestamp(),clock_timestamp()
    ) RETURNING id INTO identity_id;
  ELSE
    UPDATE public.identities
       SET metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'source','ZCAJS','provider','zcajs','link_source','manual_confirmed'
           ),
           display_name=coalesce(candidate.display_name,display_name),
           updated_at=clock_timestamp()
     WHERE id=existing_identity.id
     RETURNING id INTO identity_id;
  END IF;

  UPDATE public.zalo_personal_contact_candidates
     SET status='LINKED',linked_customer_id=p_customer,linked_at=clock_timestamp(),
         metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('linked_by',p_actor),
         last_seen_at=greatest(last_seen_at,clock_timestamp())
   WHERE id=candidate.id;

  INSERT INTO public.audit_logs(
    company_id,user_id,actor_id,action,resource_type,resource_id,result,metadata,created_at
  ) VALUES (
    p_company,p_actor,p_actor,'LINK_ZALO_PERSONAL_IDENTITY','CUSTOMER',p_customer,
    'SUCCESS',jsonb_build_object(
      'candidate_id',candidate.id,'identity_id',identity_id,'conversation_id',conversation_id
    ),clock_timestamp()
  );

  RETURN jsonb_build_object(
    'candidate_id',candidate.id,
    'customer_id',p_customer,
    'identity_id',identity_id,
    'conversation_id',conversation_id
  );
END $$;

REVOKE ALL ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.link_zalo_personal_contact(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_zalo_personal_contacts(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_zalo_personal_contact(uuid,uuid,uuid,uuid) TO service_role;

COMMENT ON TABLE public.zalo_personal_contact_candidates IS
  'Server-only ZCAJS directory candidates. Never auto-linked by display name or OA identity.';
COMMENT ON FUNCTION public.link_zalo_personal_contact(uuid,uuid,uuid,uuid) IS
  'Boss-confirmed personal-Zalo UID link. Rejects official/ambiguous identity routes and never matches by name.';

COMMIT;
