-- Migration: 20261027184500_facebook_sync_checkpoints.sql
-- Description: Track last-synced timestamp per Facebook Page and folder to ensure
-- robust downtime recovery and safe bounded backfill without duplicate ingestion.

CREATE TABLE IF NOT EXISTS public.facebook_sync_checkpoints (
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    page_id text NOT NULL,
    folder text NOT NULL,
    last_synced_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_facebook_sync_checkpoints PRIMARY KEY (company_id, page_id, folder)
);

ALTER TABLE public.facebook_sync_checkpoints ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.facebook_sync_checkpoints FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.facebook_sync_checkpoints TO service_role;

CREATE OR REPLACE FUNCTION public.facebook_get_sync_checkpoint(
    p_company_id uuid,
    p_page_id text,
    p_folder text
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT last_synced_at
    FROM public.facebook_sync_checkpoints
    WHERE company_id = p_company_id
      AND page_id = p_page_id
      AND folder = p_folder;
$$;

CREATE OR REPLACE FUNCTION public.facebook_set_sync_checkpoint(
    p_company_id uuid,
    p_page_id text,
    p_folder text,
    p_last_synced_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.facebook_sync_checkpoints (
        company_id,
        page_id,
        folder,
        last_synced_at,
        updated_at
    )
    VALUES (
        p_company_id,
        p_page_id,
        p_folder,
        p_last_synced_at,
        now()
    )
    ON CONFLICT (company_id, page_id, folder)
    DO UPDATE SET
        last_synced_at = EXCLUDED.last_synced_at,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.facebook_get_sync_checkpoint(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.facebook_get_sync_checkpoint(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.facebook_set_sync_checkpoint(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.facebook_set_sync_checkpoint(uuid, text, text, timestamptz) TO service_role;
