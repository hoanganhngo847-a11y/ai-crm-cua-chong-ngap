-- Durable OpenAI Realtime webhook idempotency. SIP headers and phone numbers are never stored here.
CREATE TABLE public.openai_realtime_events (
  event_id text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  openai_call_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('PROCESSING', 'ACCEPTED', 'FAILED')),
  error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NULL
);

ALTER TABLE public.openai_realtime_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.openai_realtime_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.openai_realtime_events TO service_role;

ALTER TABLE public.voice_media_jobs
  DROP CONSTRAINT IF EXISTS voice_media_jobs_job_type_check;
ALTER TABLE public.voice_media_jobs
  ADD CONSTRAINT voice_media_jobs_job_type_check
  CHECK (job_type IN ('RECORDING_IMPORT', 'TRANSCRIPTION', 'INTAKE_EXTRACTION'));

CREATE OR REPLACE FUNCTION public.get_call_transcript_for_voice_worker(
  p_company_id uuid,
  p_call_id uuid
)
RETURNS TABLE (transcript text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ct.transcript
  FROM private.call_transcripts ct
  WHERE ct.company_id = p_company_id
    AND ct.call_id = p_call_id;
$$;

REVOKE ALL ON FUNCTION public.get_call_transcript_for_voice_worker(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_transcript_for_voice_worker(uuid, uuid) TO service_role;
