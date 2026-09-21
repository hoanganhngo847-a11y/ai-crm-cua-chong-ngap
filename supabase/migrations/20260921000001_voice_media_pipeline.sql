-- Voice media pipeline: private recording bucket, durable retry queue and bounded transcript writer.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'call-recordings',
  'call-recordings',
  false,
  26214400,
  ARRAY['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE public.voice_media_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  call_id uuid NOT NULL,
  job_type text NOT NULL CHECK (job_type IN ('RECORDING_IMPORT', 'TRANSCRIPTION')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  source_ref text NULL CHECK (source_ref IS NULL OR source_ref !~* '^https?://'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz NULL,
  last_error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT fk_voice_media_job_call FOREIGN KEY (company_id, call_id)
    REFERENCES public.calls(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_voice_media_job_call_type UNIQUE (company_id, call_id, job_type)
);

CREATE INDEX idx_voice_media_jobs_due
  ON public.voice_media_jobs (status, next_run_at)
  WHERE status IN ('PENDING', 'PROCESSING');

ALTER TABLE public.voice_media_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voice_media_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voice_media_jobs TO service_role;

CREATE TABLE public.voice_call_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  call_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  customer_name text NULL,
  door_type text NULL,
  width_mm integer NULL CHECK (width_mm IS NULL OR width_mm BETWEEN 100 AND 20000),
  height_mm integer NULL CHECK (height_mm IS NULL OR height_mm BETWEEN 100 AND 10000),
  flood_depth_mm integer NULL CHECK (flood_depth_mm IS NULL OR flood_depth_mm BETWEEN 0 AND 10000),
  opening_count integer NULL CHECK (opening_count IS NULL OR opening_count BETWEEN 1 AND 100),
  survey_address text NULL,
  survey_requested boolean NOT NULL DEFAULT false,
  preferred_survey_at timestamptz NULL,
  notes text NULL,
  status text NOT NULL CHECK (status IN ('INTAKE_COMPLETED', 'SURVEY_REQUESTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_voice_intake_call FOREIGN KEY (company_id, customer_id, call_id)
    REFERENCES public.calls(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_voice_intake_call UNIQUE (company_id, call_id)
);

ALTER TABLE public.voice_call_intakes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voice_call_intakes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voice_call_intakes TO service_role;

-- At most one pending outbound attempt per customer, across all contact cycles.
CREATE UNIQUE INDEX uq_call_attempts_one_pending_per_customer
  ON public.call_attempts (company_id, customer_id)
  WHERE result = 'PENDING';

CREATE OR REPLACE FUNCTION public.upsert_call_transcript(
  p_company_id uuid,
  p_call_id uuid,
  p_transcript text,
  p_speakers jsonb,
  p_language text DEFAULT 'vi'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO private.call_transcripts (company_id, call_id, transcript, speakers, language, processed_at)
  VALUES (p_company_id, p_call_id, p_transcript, COALESCE(p_speakers, '[]'::jsonb), p_language, now())
  ON CONFLICT (call_id) DO UPDATE SET
    transcript = EXCLUDED.transcript,
    speakers = EXCLUDED.speakers,
    language = EXCLUDED.language,
    processed_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_call_transcript(uuid, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_call_transcript(uuid, uuid, text, jsonb, text) TO service_role;

CREATE OR REPLACE FUNCTION public.find_customer_by_normalized_phone(
  p_company_id uuid,
  p_normalized_phone text
)
RETURNS TABLE (customer_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT cpc.customer_id
  FROM private.customer_private_contacts cpc
  WHERE cpc.company_id = p_company_id
    AND cpc.normalized_phone = p_normalized_phone;
$$;

REVOKE ALL ON FUNCTION public.find_customer_by_normalized_phone(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_customer_by_normalized_phone(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_customer_private_contact(
  p_company_id uuid,
  p_customer_id uuid,
  p_normalized_phone text,
  p_raw_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_normalized_phone !~ '^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'invalid normalized phone';
  END IF;

  INSERT INTO private.customer_private_contacts (
    company_id, customer_id, normalized_phone, raw_phone, is_verified
  ) VALUES (
    p_company_id, p_customer_id, p_normalized_phone, p_raw_phone, false
  )
  ON CONFLICT (customer_id) DO UPDATE SET
    normalized_phone = EXCLUDED.normalized_phone,
    raw_phone = EXCLUDED.raw_phone,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_customer_private_contact(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_customer_private_contact(uuid, uuid, text, text) TO service_role;
