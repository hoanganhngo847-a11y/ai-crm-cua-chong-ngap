-- Add editable sale name, sale notes, marketing notes, and AI notes to Customer 360
BEGIN;

ALTER TABLE public.customer_dossier_profiles
  ADD COLUMN IF NOT EXISTS assigned_sale_name text CHECK (length(assigned_sale_name) <= 200),
  ADD COLUMN IF NOT EXISTS sale_notes text CHECK (length(sale_notes) <= 4000),
  ADD COLUMN IF NOT EXISTS marketing_notes text CHECK (length(marketing_notes) <= 4000),
  ADD COLUMN IF NOT EXISTS ai_notes text CHECK (length(ai_notes) <= 4000);

-- Backfill existing sale notes from special notes if present
UPDATE public.customer_dossier_profiles
  SET sale_notes = special_notes
  WHERE sale_notes IS NULL AND special_notes IS NOT NULL;

-- Backfill existing assigned sale names from user profiles if assigned_sale_id is set
UPDATE public.customer_dossier_profiles p
  SET assigned_sale_name = u.full_name
  FROM public.user_profiles u
  WHERE p.assigned_sale_name IS NULL AND p.assigned_sale_id = u.id;

-- Update c360_list function to select new editable columns
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

REVOKE ALL ON FUNCTION public.c360_list FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.c360_list TO service_role;

COMMIT;
