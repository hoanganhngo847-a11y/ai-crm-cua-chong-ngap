-- Customer 360: track outreach per channel and expose the customer's Facebook/Zalo names.
-- Outreach is evidence-based (outbound message/call) plus a manual mark for off-system
-- steps such as sending a Zalo friend request from a phone number collected on Facebook.
BEGIN;

ALTER TABLE public.customer_dossier_profiles
  ADD COLUMN IF NOT EXISTS facebook_outreach_at timestamptz,
  ADD COLUMN IF NOT EXISTS zalo_outreach_at timestamptz;

COMMENT ON COLUMN public.customer_dossier_profiles.facebook_outreach_at IS
  'Manual confirmation that a sale reached the customer on Facebook. Automatic outbound evidence is resolved in c360_list.';
COMMENT ON COLUMN public.customer_dossier_profiles.zalo_outreach_at IS
  'Manual confirmation that a sale reached the customer on Zalo (for example after a friend request). Automatic outbound evidence is resolved in c360_list.';

-- Outreach toggles are operational bookkeeping, not AI context. Keep the dossier
-- dirty trigger from enqueueing an AI refresh when only these timestamps change.
CREATE OR REPLACE FUNCTION public.c360_mark_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cid uuid; BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='interactions' THEN
    IF NEW.sanitized_content IS NOT DISTINCT FROM OLD.sanitized_content AND NEW.sanitization_status IS NOT DISTINCT FROM OLD.sanitization_status THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='customer_dossier_profiles' THEN
    IF (to_jsonb(NEW)-'updated_at'-'updated_by'-'facebook_outreach_at'-'zalo_outreach_at')
       IS NOT DISTINCT FROM (to_jsonb(OLD)-'updated_at'-'updated_by'-'facebook_outreach_at'-'zalo_outreach_at') THEN
      RETURN NEW;
    END IF;
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

-- Keep the per-customer outreach lookup bounded on large interaction tables.
CREATE INDEX IF NOT EXISTS c360_outbound_outreach
  ON public.interactions(company_id, customer_id, channel, created_at)
  WHERE direction = 'OUTBOUND' AND type IN ('MESSAGE', 'CALL_EVENT');
CREATE INDEX IF NOT EXISTS c360_zalo_outbound_calls
  ON public.zalo_personal_calls(company_id, customer_id, started_at)
  WHERE direction = 'OUTBOUND';

CREATE OR REPLACE FUNCTION public.c360_list(
  p_company_id uuid,
  p_search text DEFAULT '',
  p_page integer DEFAULT 1,
  p_owner uuid DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_hot boolean DEFAULT false,
  p_overdue boolean DEFAULT false,
  p_recent boolean DEFAULT false,
  p_sort text DEFAULT 'updated',
  p_include_ai boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; BEGIN
  IF p_page NOT BETWEEN 1 AND 10000 OR length(p_search) > 200 OR p_sort NOT IN ('updated','name','contact','score','followup')
    OR (p_channel IS NOT NULL AND p_channel NOT IN ('ZALO','FACEBOOK','PHONE','EMAIL')) THEN RAISE EXCEPTION 'INVALID_FILTER'; END IF;
  WITH rows AS (
    SELECT c.id, c.customer_code, c.name, c.stage, c.source, c.updated_at,
      p.address, p.birth_year, p.special_notes,
      coalesce(p.assigned_sale_id, owner.assigned_to) AS assigned_sale_id,
      coalesce(nullif(trim(p.assigned_sale_name), ''), u.full_name) AS assigned_sale,
      p.assigned_sale_name,
      coalesce(p.sale_notes, p.special_notes) AS sale_notes,
      p.marketing_notes,
      coalesce(p.ai_notes, s.snapshot->'currentSituation'->>'text') AS ai_notes,
      ids.zalo_name, ids.facebook_name, ids.channels, em.email,
      CASE WHEN ph.normalized_phone IS NULL THEN NULL ELSE left(ph.normalized_phone, 4)||'******'||right(ph.normalized_phone, 2) END AS phone,
      coalesce(fb.at, p.facebook_outreach_at) AS facebook_outreach_at,
      CASE WHEN fb.at IS NOT NULL THEN 'AUTO'
        WHEN p.facebook_outreach_at IS NOT NULL THEN 'MANUAL' END AS facebook_outreach_source,
      coalesce(zalo.at, p.zalo_outreach_at) AS zalo_outreach_at,
      CASE WHEN zalo.at IS NOT NULL THEN 'AUTO'
        WHEN p.zalo_outreach_at IS NOT NULL THEN 'MANUAL' END AS zalo_outreach_source,
      s.snapshot->'currentSituation'->>'text' AS current_situation, s.lead_score, s.follow_up_at, s.generated_at AS ai_updated_at,
      greatest(msg.at, zc.at) AS last_interaction,
      count(*) OVER() AS total
    FROM public.customers c
    LEFT JOIN public.customer_dossier_profiles p ON p.company_id = c.company_id AND p.customer_id = c.id
    LEFT JOIN LATERAL(SELECT assigned_to FROM public.conversations conv WHERE conv.company_id = c.company_id
      AND conv.customer_id = c.id AND conv.assigned_to IS NOT NULL ORDER BY updated_at DESC, id LIMIT 1) owner ON true
    LEFT JOIN public.user_profiles u ON u.id = coalesce(p.assigned_sale_id, owner.assigned_to)
    LEFT JOIN private.customer_private_contacts ph ON ph.company_id = c.company_id AND ph.customer_id = c.id
    LEFT JOIN LATERAL(SELECT v.normalized_value AS email FROM private.customer_identity_values v
      WHERE v.company_id = c.company_id AND v.customer_id = c.id ORDER BY v.identity_id LIMIT 1) em ON true
    LEFT JOIN LATERAL(SELECT max(coalesce(i.display_name, i.metadata->>'display_name')) FILTER(WHERE channel = 'ZALO') AS zalo_name,
      max(coalesce(i.display_name, i.metadata->>'display_name')) FILTER(WHERE channel = 'FACEBOOK') AS facebook_name,
      array_agg(DISTINCT channel) AS channels FROM public.identities i WHERE i.company_id = c.company_id AND i.customer_id = c.id) ids ON true
    LEFT JOIN LATERAL(SELECT min(i.created_at) AS at FROM public.interactions i
      WHERE i.company_id = c.company_id AND i.customer_id = c.id
        AND i.channel = 'FACEBOOK' AND i.direction = 'OUTBOUND' AND i.type IN ('MESSAGE', 'CALL_EVENT')) fb ON true
    LEFT JOIN LATERAL(SELECT least(
        (SELECT min(i.created_at) FROM public.interactions i
          WHERE i.company_id = c.company_id AND i.customer_id = c.id
            AND i.channel = 'ZALO' AND i.direction = 'OUTBOUND' AND i.type IN ('MESSAGE', 'CALL_EVENT')),
        (SELECT min(z.started_at) FROM public.zalo_personal_calls z
          WHERE z.company_id = c.company_id AND z.customer_id = c.id AND z.direction = 'OUTBOUND')) AS at) zalo ON true
    LEFT JOIN LATERAL(SELECT a.snapshot, a.lead_score, a.follow_up_at, a.generated_at FROM public.customer_ai_snapshots a
      WHERE p_include_ai AND a.company_id = c.company_id AND a.customer_id = c.id ORDER BY version DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL(SELECT max(created_at) AS at FROM public.interactions i WHERE i.company_id = c.company_id AND i.customer_id = c.id) msg ON true
    LEFT JOIN LATERAL(SELECT max(started_at) AS at FROM public.zalo_personal_calls z WHERE z.company_id = c.company_id AND z.customer_id = c.id) zc ON true
    WHERE c.company_id = p_company_id
      AND (p_search = '' OR c.name ILIKE '%'||p_search||'%' OR ph.normalized_phone ILIKE '%'||p_search||'%'
        OR em.email ILIKE '%'||p_search||'%'
        OR p.assigned_sale_name ILIKE '%'||p_search||'%'
        OR u.full_name ILIKE '%'||p_search||'%'
        OR p.sale_notes ILIKE '%'||p_search||'%'
        OR p.marketing_notes ILIKE '%'||p_search||'%'
        OR p.ai_notes ILIKE '%'||p_search||'%'
        OR EXISTS(SELECT 1 FROM public.identities si
          WHERE si.company_id = c.company_id AND si.customer_id = c.id AND si.channel IN ('ZALO', 'FACEBOOK')
            AND (si.display_name ILIKE '%'||p_search||'%' OR si.metadata->>'display_name' ILIKE '%'||p_search||'%')))
      AND (p_owner IS NULL OR coalesce(p.assigned_sale_id, owner.assigned_to) = p_owner)
      AND (p_channel IS NULL OR p_channel = ANY(ids.channels))
      AND (p_stage IS NULL OR c.stage = p_stage)
      AND (NOT p_hot OR s.lead_score >= 70)
      AND (NOT p_overdue OR s.follow_up_at < now())
      AND (NOT p_recent OR greatest(msg.at, zc.at) > now() - interval '7 days')
  ), page AS (
    SELECT * FROM rows ORDER BY
      CASE WHEN p_sort = 'name' THEN name END ASC,
      CASE WHEN p_sort = 'contact' THEN last_interaction END DESC NULLS LAST,
      CASE WHEN p_sort = 'score' THEN lead_score END DESC NULLS LAST,
      CASE WHEN p_sort = 'followup' THEN follow_up_at END ASC NULLS LAST,
      CASE WHEN p_sort = 'updated' THEN updated_at END DESC, id
    LIMIT 25 OFFSET (p_page - 1) * 25
  ) SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(to_jsonb(page) - 'total') FROM page), '[]'::jsonb),
    'total', coalesce((SELECT max(total) FROM rows), 0),
    'page', p_page,
    'pageSize', 25
  ) INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.c360_contacts(p_company_id uuid, p_customer_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'phone', (SELECT left(normalized_phone, 4)||'******'||right(normalized_phone, 2)
      FROM private.customer_private_contacts WHERE company_id = p_company_id AND customer_id = p_customer_id),
    'assignedSaleId', (SELECT assigned_to FROM public.conversations WHERE company_id = p_company_id
      AND customer_id = p_customer_id AND assigned_to IS NOT NULL ORDER BY updated_at DESC, id LIMIT 1),
    'lastInteraction', greatest(
      (SELECT max(created_at) FROM public.interactions WHERE company_id = p_company_id AND customer_id = p_customer_id),
      (SELECT max(started_at) FROM public.zalo_personal_calls WHERE company_id = p_company_id AND customer_id = p_customer_id)),
    'facebookOutreachAt', (SELECT min(created_at) FROM public.interactions
      WHERE company_id = p_company_id AND customer_id = p_customer_id
        AND channel = 'FACEBOOK' AND direction = 'OUTBOUND' AND type IN ('MESSAGE', 'CALL_EVENT')),
    'zaloOutreachAt', least(
      (SELECT min(created_at) FROM public.interactions
        WHERE company_id = p_company_id AND customer_id = p_customer_id
          AND channel = 'ZALO' AND direction = 'OUTBOUND' AND type IN ('MESSAGE', 'CALL_EVENT')),
      (SELECT min(started_at) FROM public.zalo_personal_calls
        WHERE company_id = p_company_id AND customer_id = p_customer_id AND direction = 'OUTBOUND'))
  )
$$;

REVOKE ALL ON FUNCTION public.c360_list FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.c360_list TO service_role;
REVOKE ALL ON FUNCTION public.c360_contacts FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.c360_contacts TO service_role;

COMMIT;
