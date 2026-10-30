-- Expose only the author fields needed by the inbox. Raw messages/payloads stay
-- private, and only the trusted server can execute this tenant-scoped projection.
CREATE TABLE IF NOT EXISTS private.zalo_group_message_authors (
  interaction_id uuid PRIMARY KEY REFERENCES public.interactions(id),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  sender_id text,
  sender_name text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.zalo_group_message_authors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.zalo_group_message_authors FROM PUBLIC, anon, authenticated;

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
     AND c.external_conversation_id LIKE 'group:%'
     AND (r.source_metadata->>'is_group' = 'true' OR a.interaction_id IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION public.get_zalo_group_message_authors(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_zalo_group_message_authors(uuid, uuid[]) TO service_role;

-- Merge under a row lock so a group refresh cannot erase metadata written by
-- simultaneous inbound delivery. Customer/identity names change in the same transaction.
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
     AND channel = 'ZALO' AND external_conversation_id ~ '^group:[0-9]{5,40}$'
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_GROUP_NOT_FOUND'; END IF;
  IF p_group->>'group_fetched_at' IS NOT NULL AND c.metadata->>'group_fetched_at' IS NOT NULL
     AND p_group->>'group_fetched_at' < c.metadata->>'group_fetched_at' THEN
    RETURN c.metadata;
  END IF;
  v_name := coalesce(nullif(btrim(p_group->>'group_name'), ''), nullif(c.metadata->>'group_name', ''),
                     'Nhóm Zalo ' || right(c.external_conversation_id, 4));
  FOREACH v_key IN ARRAY ARRAY['member_count', 'members', 'members_complete', 'group_avatar', 'group_fetched_at'] LOOP
    IF p_group ? v_key AND p_group->v_key <> 'null'::jsonb THEN
      v_patch := v_patch || jsonb_build_object(v_key, p_group->v_key);
    END IF;
  END LOOP;
  v_patch := v_patch || jsonb_build_object(
    'is_group', true, 'group_id', substr(c.external_conversation_id, 7),
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

-- A re-fetch can resolve an old "Thành viên nhóm" author. Repair only identity
-- projection on that exact group message; the raw audit table stays append-only.
CREATE OR REPLACE FUNCTION public.repair_zalo_group_message_author(
  p_company_id uuid, p_conversation_id uuid, p_external_ref text, p_author jsonb
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.zalo_group_message_authors (interaction_id, company_id, sender_id, sender_name)
  SELECT i.id, i.company_id, nullif(p_author->>'zalo_sender_id', ''), nullif(p_author->>'zalo_sender_name', '')
    FROM public.interactions i JOIN public.conversations c ON c.id = i.conversation_id AND c.company_id = i.company_id
   WHERE i.company_id = p_company_id AND i.conversation_id = p_conversation_id
     AND i.channel = 'ZALO' AND i.external_ref = p_external_ref
     AND c.external_conversation_id = 'group:' || (p_author->>'group_id')
  ON CONFLICT (interaction_id) DO UPDATE SET
    sender_id = coalesce(EXCLUDED.sender_id, private.zalo_group_message_authors.sender_id),
    sender_name = coalesce(EXCLUDED.sender_name, private.zalo_group_message_authors.sender_name),
    updated_at = clock_timestamp();
$$;
REVOKE ALL ON FUNCTION public.repair_zalo_group_message_author(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_zalo_group_message_author(uuid, uuid, text, jsonb) TO service_role;

CREATE INDEX IF NOT EXISTS idx_interactions_inbox_history_cursor
  ON public.interactions(company_id, conversation_id, created_at DESC, id DESC);
