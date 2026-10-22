-- Durable per-channel checkpoints for Zalo transcription retries.
-- These rows are internal worker state only. Final transcript/utterances remain authoritative
-- in zalo_call_transcriptions / zalo_call_transcript_utterances.

CREATE TABLE public.zalo_call_transcription_channel_checkpoints (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  transcription_id uuid NOT NULL REFERENCES public.zalo_call_transcriptions(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('LEFT', 'RIGHT')),
  segments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(segments) = 'array'),
  language text,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, transcription_id, channel),
  CONSTRAINT fk_zalo_tx_checkpoint_call FOREIGN KEY (company_id, call_id)
    REFERENCES public.zalo_personal_calls(company_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_zalo_tx_checkpoint_transcription
  ON public.zalo_call_transcription_channel_checkpoints (transcription_id, channel);

ALTER TABLE public.zalo_call_transcription_channel_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zalo_call_transcription_channel_checkpoints FROM PUBLIC, anon, authenticated, service_role;

-- Load checkpoints only while the caller owns the active transcription lease.
CREATE OR REPLACE FUNCTION public.zalo_get_transcription_channel_checkpoints(
  p_company uuid,
  p_transcription_id uuid,
  p_lock_token uuid
)
RETURNS TABLE (
  channel text,
  segments jsonb,
  language text,
  provider text,
  model text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.zalo_call_transcriptions zct
    WHERE zct.id = p_transcription_id
      AND zct.company_id = p_company
      AND zct.status = 'PROCESSING'
      AND zct.lock_token = p_lock_token
      AND zct.lease_expires_at IS NOT NULL
      AND zct.lease_expires_at > now()
  ) THEN
    RAISE EXCEPTION 'TRANSCRIPTION_LOCK_LOST';
  END IF;

  RETURN QUERY
  SELECT c.channel, c.segments, c.language, c.provider, c.model
  FROM public.zalo_call_transcription_channel_checkpoints c
  WHERE c.company_id = p_company
    AND c.transcription_id = p_transcription_id
  ORDER BY c.channel;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_get_transcription_channel_checkpoints(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_get_transcription_channel_checkpoints(uuid, uuid, uuid)
  TO service_role;

-- Persist a provider result immediately, before the worker moves on to the next channel.
-- call_id is derived from the fenced transcription row; the caller cannot cross-bind tenants/calls.
CREATE OR REPLACE FUNCTION public.zalo_upsert_transcription_channel_checkpoint(
  p_company uuid,
  p_transcription_id uuid,
  p_lock_token uuid,
  p_channel text,
  p_segments jsonb,
  p_language text,
  p_provider text,
  p_model text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_call_id uuid;
BEGIN
  IF p_channel NOT IN ('LEFT', 'RIGHT')
     OR p_segments IS NULL
     OR jsonb_typeof(p_segments) <> 'array'
     OR jsonb_array_length(p_segments) > 10000
     OR pg_catalog.pg_column_size(p_segments) > 5242880
     OR p_provider IS NULL OR length(p_provider) NOT BETWEEN 1 AND 32
     OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 128
     OR (p_language IS NOT NULL AND length(p_language) > 32) THEN
    RAISE EXCEPTION 'INVALID_CHANNEL_CHECKPOINT';
  END IF;

  SELECT zct.call_id INTO v_call_id
  FROM public.zalo_call_transcriptions zct
  WHERE zct.id = p_transcription_id
    AND zct.company_id = p_company
    AND zct.status = 'PROCESSING'
    AND zct.lock_token = p_lock_token
    AND zct.lease_expires_at IS NOT NULL
    AND zct.lease_expires_at > now()
  FOR UPDATE;

  IF v_call_id IS NULL THEN
    RAISE EXCEPTION 'TRANSCRIPTION_LOCK_LOST';
  END IF;

  INSERT INTO public.zalo_call_transcription_channel_checkpoints (
    company_id,
    transcription_id,
    call_id,
    channel,
    segments,
    language,
    provider,
    model
  ) VALUES (
    p_company,
    p_transcription_id,
    v_call_id,
    p_channel,
    p_segments,
    p_language,
    p_provider,
    p_model
  )
  ON CONFLICT (company_id, transcription_id, channel) DO UPDATE
  SET segments = EXCLUDED.segments,
      language = EXCLUDED.language,
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      updated_at = now();

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_upsert_transcription_channel_checkpoint(uuid, uuid, uuid, text, jsonb, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_upsert_transcription_channel_checkpoint(uuid, uuid, uuid, text, jsonb, text, text, text)
  TO service_role;
