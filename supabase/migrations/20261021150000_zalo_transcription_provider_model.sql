-- Migration: 20261021150000_zalo_transcription_provider_model.sql
-- Add model column to zalo_call_transcriptions and service-only RPC to set provider and model metadata.

ALTER TABLE public.zalo_call_transcriptions
  ADD COLUMN IF NOT EXISTS model text;

GRANT SELECT(model) ON public.zalo_call_transcriptions TO authenticated;

-- Service-only RPC to set provider and model atomically, fenced by company, transcription id, lock_token, status, and active lease
CREATE OR REPLACE FUNCTION public.zalo_set_transcription_provider_metadata(
  p_company uuid,
  p_transcription_id uuid,
  p_lock_token uuid,
  p_provider text,
  p_model text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tx public.zalo_call_transcriptions;
BEGIN
  -- Validate provider (fail closed with sanitized error code)
  IF p_provider IS NULL OR p_provider NOT IN ('OPENAI', 'GEMINI', 'MOCK') THEN
    RAISE EXCEPTION 'INVALID_TRANSCRIPTION_PROVIDER';
  END IF;

  -- Validate model (fail closed with sanitized error code)
  IF p_model IS NULL
     OR length(p_model) > 128
     OR p_model ~* '^(sk-|bearer)'
     OR p_model ~* 'AIza'
     OR p_model !~ '^(models/)?[a-z][a-z0-9_.:-]*$' THEN
    RAISE EXCEPTION 'INVALID_TRANSCRIPTION_MODEL';
  END IF;

  SELECT * INTO v_tx
  FROM public.zalo_call_transcriptions
  WHERE id = p_transcription_id
    AND company_id = p_company
    AND lock_token = p_lock_token
    AND status = 'PROCESSING'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_LOCK_LOST';
  END IF;

  UPDATE public.zalo_call_transcriptions
  SET provider = p_provider,
      model = p_model,
      updated_at = now()
  WHERE id = p_transcription_id
    AND company_id = p_company
    AND lock_token = p_lock_token;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_set_transcription_provider_metadata(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_set_transcription_provider_metadata(uuid, uuid, uuid, text, text) TO service_role;
