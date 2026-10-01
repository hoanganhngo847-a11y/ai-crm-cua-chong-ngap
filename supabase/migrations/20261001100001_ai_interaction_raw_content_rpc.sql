-- Migration: 20261001100001_ai_interaction_raw_content_rpc.sql
-- Description: Trusted service_role RPC to record AI interaction provenance in private.interaction_raw_contents.

CREATE OR REPLACE FUNCTION public.save_ai_interaction_provenance(
  p_company_id uuid,
  p_interaction_id uuid,
  p_raw_content text,
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 1. Validate mandatory fields
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_COMPANY_ID';
  END IF;

  IF p_interaction_id IS NULL THEN
    RAISE EXCEPTION 'p_interaction_id là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_INTERACTION_ID';
  END IF;

  -- 2. Validate interaction exists and belongs to the specified company
  IF NOT EXISTS (
    SELECT 1 FROM public.interactions
    WHERE id = p_interaction_id
      AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'INTERACTION_NOT_FOUND: Tương tác không tồn tại hoặc không thuộc tổ chức'
      USING ERRCODE = 'P0002', HINT = 'INTERACTION_NOT_FOUND';
  END IF;

  -- 3. Upsert into private.interaction_raw_contents
  INSERT INTO private.interaction_raw_contents (
    interaction_id,
    company_id,
    raw_content,
    raw_payload,
    source_metadata,
    created_at
  ) VALUES (
    p_interaction_id,
    p_company_id,
    coalesce(p_raw_content, ''),
    '{}'::jsonb,
    coalesce(p_source_metadata, '{}'::jsonb),
    clock_timestamp()
  )
  ON CONFLICT (interaction_id) DO UPDATE
  SET
    raw_content = EXCLUDED.raw_content,
    source_metadata = EXCLUDED.source_metadata;
END;
$$;

COMMENT ON FUNCTION public.save_ai_interaction_provenance(uuid, uuid, text, jsonb)
  IS 'Trusted server RPC to securely save AI interaction provenance into private.interaction_raw_contents. Strictly restricted to service_role.';

REVOKE ALL ON FUNCTION public.save_ai_interaction_provenance(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_ai_interaction_provenance(uuid, uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.save_ai_interaction_provenance(uuid, uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.save_ai_interaction_provenance(uuid, uuid, text, jsonb) TO service_role;
