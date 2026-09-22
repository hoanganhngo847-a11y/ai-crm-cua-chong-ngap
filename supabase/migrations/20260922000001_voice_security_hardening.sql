-- Voice security hardening: trusted tenant routing, bounded worker commands,
-- atomic contact-cycle transitions and atomic inbound identity resolution.

CREATE TABLE public.voice_provider_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('STRINGEE', 'OPENAI_REALTIME')),
  provider_account_id text NOT NULL,
  routing_key_hash text NOT NULL CHECK (routing_key_hash ~ '^[0-9a-f]{64}$'),
  webhook_secret_env text NOT NULL CHECK (webhook_secret_env ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  api_key_env text NULL CHECK (api_key_env IS NULL OR api_key_env ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  api_secret_env text NULL CHECK (api_secret_env IS NULL OR api_secret_env ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  from_number_env text NULL CHECK (from_number_env IS NULL OR from_number_env ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  answer_url_env text NULL CHECK (answer_url_env IS NULL OR answer_url_env ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  ai_agent_user_env text NULL CHECK (ai_agent_user_env IS NULL OR ai_agent_user_env ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  sale_agent_user_env text NULL CHECK (sale_agent_user_env IS NULL OR sale_agent_user_env ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_voice_integration_account UNIQUE (provider, provider_account_id),
  CONSTRAINT uq_voice_integration_route UNIQUE (provider, routing_key_hash),
  CONSTRAINT uq_voice_integration_company_provider UNIQUE (company_id, provider)
);

ALTER TABLE public.voice_provider_integrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voice_provider_integrations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voice_provider_integrations TO service_role;

CREATE TRIGGER trg_updated_at_voice_provider_integrations
  BEFORE UPDATE ON public.voice_provider_integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE UNIQUE INDEX uq_calls_tenant_provider_call
  ON public.calls (company_id, provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.resolve_voice_provider_integration(
  p_provider text,
  p_routing_key_hash text
)
RETURNS TABLE (
  integration_id uuid,
  company_id uuid,
  provider_account_id text,
  webhook_secret_env text,
  api_key_env text,
  api_secret_env text,
  from_number_env text,
  answer_url_env text,
  ai_agent_user_env text,
  sale_agent_user_env text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT vpi.id, vpi.company_id, vpi.provider_account_id, vpi.webhook_secret_env,
         vpi.api_key_env, vpi.api_secret_env, vpi.from_number_env, vpi.answer_url_env,
         vpi.ai_agent_user_env, vpi.sale_agent_user_env
  FROM public.voice_provider_integrations vpi
  WHERE vpi.provider = p_provider
    AND vpi.routing_key_hash = p_routing_key_hash
    AND vpi.active = true;
$$;

REVOKE ALL ON FUNCTION public.resolve_voice_provider_integration(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_voice_provider_integration(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.start_voice_contact_cycle(
  p_company_id uuid,
  p_customer_id uuid,
  p_contact_cycle_id uuid,
  p_scheduled_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_from_stage text;
  v_attempt_id uuid;
BEGIN
  SELECT c.stage INTO v_from_stage
  FROM public.customers c
  WHERE c.company_id = p_company_id AND c.id = p_customer_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_CUSTOMER_NOT_FOUND'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.call_attempts ca
    WHERE ca.company_id = p_company_id AND ca.customer_id = p_customer_id AND ca.result = 'PENDING'
  ) THEN RAISE EXCEPTION 'VOICE_PENDING_ATTEMPT_EXISTS'; END IF;

  INSERT INTO public.call_attempts (
    company_id, customer_id, contact_cycle_id, attempt_no, scheduled_at, result
  ) VALUES (p_company_id, p_customer_id, p_contact_cycle_id, 1, p_scheduled_at, 'PENDING')
  RETURNING id INTO v_attempt_id;

  UPDATE public.customers SET stage = 'CONTACT_CYCLE_1', updated_at = now()
  WHERE company_id = p_company_id AND id = p_customer_id;
  INSERT INTO public.customer_stage_histories (
    company_id, customer_id, from_stage, to_stage, actor_type, reason, source_ref
  ) VALUES (
    p_company_id, p_customer_id, v_from_stage, 'CONTACT_CYCLE_1', 'AI',
    'CONTACT_CYCLE_STARTED', p_contact_cycle_id::text
  );
  RETURN v_attempt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.start_voice_contact_cycle(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_voice_contact_cycle(uuid, uuid, uuid, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_voice_attempt_transition(
  p_company_id uuid,
  p_attempt_id uuid,
  p_result text,
  p_call_id uuid DEFAULT NULL,
  p_next_scheduled_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.call_attempts%ROWTYPE;
  v_from_stage text;
  v_next_attempt_id uuid;
  v_next_no integer;
  v_to_stage text;
BEGIN
  IF p_result NOT IN ('NO_ANSWER', 'BUSY', 'ANSWERED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'VOICE_INVALID_ATTEMPT_RESULT';
  END IF;

  SELECT * INTO v_attempt FROM public.call_attempts ca
  WHERE ca.company_id = p_company_id AND ca.id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_ATTEMPT_NOT_FOUND'; END IF;
  IF v_attempt.result <> 'PENDING' THEN RETURN NULL; END IF;

  IF p_call_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.calls c
    WHERE c.company_id = p_company_id AND c.id = p_call_id AND c.customer_id = v_attempt.customer_id
  ) THEN RAISE EXCEPTION 'VOICE_CALL_SCOPE_MISMATCH'; END IF;

  UPDATE public.call_attempts
  SET result = p_result, called_at = COALESCE(called_at, now()), call_id = COALESCE(p_call_id, call_id)
  WHERE id = p_attempt_id;

  IF p_result IN ('ANSWERED', 'CANCELLED') THEN RETURN NULL; END IF;

  SELECT c.stage INTO v_from_stage FROM public.customers c
  WHERE c.company_id = p_company_id AND c.id = v_attempt.customer_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_CUSTOMER_NOT_FOUND'; END IF;

  IF v_attempt.attempt_no < 3 THEN
    IF p_next_scheduled_at IS NULL THEN RAISE EXCEPTION 'VOICE_NEXT_SCHEDULE_REQUIRED'; END IF;
    v_next_no := v_attempt.attempt_no + 1;
    v_to_stage := CASE v_next_no WHEN 2 THEN 'CONTACT_CYCLE_2' ELSE 'CONTACT_CYCLE_3' END;
    INSERT INTO public.call_attempts (
      company_id, customer_id, contact_cycle_id, attempt_no, scheduled_at, result
    ) VALUES (
      p_company_id, v_attempt.customer_id, v_attempt.contact_cycle_id,
      v_next_no, p_next_scheduled_at, 'PENDING'
    ) RETURNING id INTO v_next_attempt_id;
  ELSE
    v_to_stage := 'UNREACHABLE';
  END IF;

  UPDATE public.customers SET stage = v_to_stage, updated_at = now()
  WHERE company_id = p_company_id AND id = v_attempt.customer_id;
  INSERT INTO public.customer_stage_histories (
    company_id, customer_id, from_stage, to_stage, actor_type, reason, source_ref
  ) VALUES (
    p_company_id, v_attempt.customer_id, v_from_stage, v_to_stage, 'AI',
    CASE WHEN v_attempt.attempt_no = 3 THEN 'NO_ANSWER_3_ATTEMPTS' ELSE 'VOICE_RETRY_SCHEDULED' END,
    v_attempt.contact_cycle_id::text
  );
  RETURN v_next_attempt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_voice_attempt_transition(uuid, uuid, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_voice_attempt_transition(uuid, uuid, text, uuid, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_voice_attempt_phone(
  p_company_id uuid,
  p_attempt_id uuid
)
RETURNS TABLE (
  customer_id uuid,
  contact_cycle_id uuid,
  attempt_no integer,
  raw_phone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.call_attempts%ROWTYPE;
  v_phone text;
BEGIN
  SELECT * INTO v_attempt FROM public.call_attempts ca
  WHERE ca.company_id = p_company_id AND ca.id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_ATTEMPT_NOT_FOUND'; END IF;
  IF v_attempt.result <> 'PENDING' OR v_attempt.called_at IS NOT NULL OR v_attempt.call_id IS NOT NULL THEN
    RAISE EXCEPTION 'VOICE_ATTEMPT_NOT_CLAIMABLE';
  END IF;

  SELECT cpc.raw_phone INTO v_phone FROM private.customer_private_contacts cpc
  WHERE cpc.company_id = p_company_id AND cpc.customer_id = v_attempt.customer_id;
  IF v_phone IS NULL THEN RAISE EXCEPTION 'VOICE_PHONE_NOT_FOUND'; END IF;

  UPDATE public.call_attempts SET called_at = now() WHERE id = p_attempt_id;
  RETURN QUERY SELECT v_attempt.customer_id, v_attempt.contact_cycle_id, v_attempt.attempt_no, v_phone;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_voice_attempt_phone(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voice_attempt_phone(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.release_voice_attempt_claim(p_company_id uuid, p_attempt_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.call_attempts SET called_at = NULL
  WHERE company_id = p_company_id AND id = p_attempt_id
    AND result = 'PENDING' AND call_id IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.release_voice_attempt_claim(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_voice_attempt_claim(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.bind_voice_attempt_call(
  p_company_id uuid,
  p_attempt_id uuid,
  p_call_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_customer_id uuid;
BEGIN
  SELECT customer_id INTO v_customer_id FROM public.call_attempts
  WHERE company_id = p_company_id AND id = p_attempt_id AND result = 'PENDING'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_ATTEMPT_NOT_FOUND'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.calls c WHERE c.company_id = p_company_id
      AND c.id = p_call_id AND c.customer_id = v_customer_id
  ) THEN RAISE EXCEPTION 'VOICE_CALL_SCOPE_MISMATCH'; END IF;
  UPDATE public.call_attempts SET call_id = p_call_id WHERE id = p_attempt_id;
END;
$$;
REVOKE ALL ON FUNCTION public.bind_voice_attempt_call(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_voice_attempt_call(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_or_create_hotline_customer(
  p_company_id uuid,
  p_normalized_phone text,
  p_raw_phone text,
  p_phone_identity_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_id uuid;
  v_identity_customer_id uuid;
BEGIN
  IF p_normalized_phone !~ '^\+[1-9][0-9]{7,14}$' OR p_phone_identity_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'VOICE_PHONE_IDENTITY_INVALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
    RAISE EXCEPTION 'VOICE_COMPANY_NOT_FOUND';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_normalized_phone, 0));

  SELECT cpc.customer_id INTO v_customer_id FROM private.customer_private_contacts cpc
  WHERE cpc.company_id = p_company_id AND cpc.normalized_phone = p_normalized_phone
  FOR UPDATE;

  SELECT i.customer_id INTO v_identity_customer_id FROM public.identities i
  WHERE i.company_id = p_company_id AND i.channel = 'PHONE' AND i.external_id = p_phone_identity_hash;

  IF v_customer_id IS NULL AND v_identity_customer_id IS NOT NULL THEN
    v_customer_id := v_identity_customer_id;
    INSERT INTO private.customer_private_contacts (
      company_id, customer_id, normalized_phone, raw_phone, is_verified
    ) VALUES (p_company_id, v_customer_id, p_normalized_phone, p_raw_phone, false);
  ELSIF v_customer_id IS NULL THEN
    INSERT INTO public.customers (company_id, name, source, stage)
    VALUES (p_company_id, 'Khách gọi Hotline', 'HOTLINE', 'LEAD_NEW')
    RETURNING id INTO v_customer_id;
    INSERT INTO private.customer_private_contacts (
      company_id, customer_id, normalized_phone, raw_phone, is_verified
    ) VALUES (p_company_id, v_customer_id, p_normalized_phone, p_raw_phone, false);
  ELSIF v_identity_customer_id IS NOT NULL AND v_identity_customer_id <> v_customer_id THEN
    RAISE EXCEPTION 'VOICE_PHONE_IDENTITY_CONFLICT';
  END IF;

  INSERT INTO public.identities (company_id, customer_id, channel, external_id, verified, metadata)
  VALUES (p_company_id, v_customer_id, 'PHONE', p_phone_identity_hash, false, '{}'::jsonb)
  ON CONFLICT (company_id, channel, external_id) DO NOTHING;
  RETURN v_customer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_or_create_hotline_customer(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_or_create_hotline_customer(uuid, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.create_inbound_voice_call(
  p_company_id uuid,
  p_customer_id uuid,
  p_provider text,
  p_provider_call_id text
)
RETURNS TABLE (call_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_call_id uuid;
  v_existing_customer_id uuid;
BEGIN
  IF p_provider NOT IN ('STRINGEE', 'VIETTEL', 'TWILIO', 'VINFON') OR p_provider_call_id IS NULL THEN
    RAISE EXCEPTION 'VOICE_PROVIDER_CALL_INVALID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers c WHERE c.company_id = p_company_id AND c.id = p_customer_id
  ) THEN RAISE EXCEPTION 'VOICE_CUSTOMER_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_provider || ':' || p_provider_call_id, 0));

  SELECT c.id, c.customer_id INTO v_call_id, v_existing_customer_id FROM public.calls c
  WHERE c.company_id = p_company_id AND c.provider = p_provider AND c.provider_call_id = p_provider_call_id;
  IF v_call_id IS NOT NULL THEN
    IF v_existing_customer_id <> p_customer_id THEN RAISE EXCEPTION 'VOICE_CALL_CUSTOMER_MISMATCH'; END IF;
    RETURN QUERY SELECT v_call_id, false;
    RETURN;
  END IF;

  INSERT INTO public.calls (
    company_id, customer_id, direction, agent_type, provider, provider_call_id,
    started_at, status, transcript_status
  ) VALUES (
    p_company_id, p_customer_id, 'INBOUND', 'AI', p_provider, p_provider_call_id,
    now(), 'CONNECTED', 'PENDING'
  ) RETURNING id INTO v_call_id;
  INSERT INTO public.interactions (
    company_id, customer_id, conversation_id, channel, type, direction,
    sanitized_content, sanitization_status, actor_type, actor_user_id, external_ref
  ) VALUES (
    p_company_id, p_customer_id, NULL, 'HOTLINE', 'CALL_EVENT', 'INBOUND',
    NULL, 'NOT_REQUIRED', 'SYSTEM', NULL, p_provider_call_id
  );
  RETURN QUERY SELECT v_call_id, true;
END;
$$;

REVOKE ALL ON FUNCTION public.create_inbound_voice_call(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_inbound_voice_call(uuid, uuid, text, text) TO service_role;

-- Harden RPCs introduced by the voice module: validate the parent tenant before mutation.
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
DECLARE v_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.calls c WHERE c.company_id = p_company_id AND c.id = p_call_id) THEN
    RAISE EXCEPTION 'VOICE_CALL_SCOPE_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.voice_media_jobs vmj
    WHERE vmj.company_id = p_company_id AND vmj.call_id = p_call_id
      AND vmj.job_type = 'TRANSCRIPTION' AND vmj.status = 'PROCESSING'
  ) THEN RAISE EXCEPTION 'VOICE_TRANSCRIPTION_JOB_NOT_CLAIMED'; END IF;
  INSERT INTO private.call_transcripts (company_id, call_id, transcript, speakers, language, processed_at)
  VALUES (p_company_id, p_call_id, p_transcript, COALESCE(p_speakers, '[]'::jsonb), p_language, now())
  ON CONFLICT (call_id) DO UPDATE SET
    transcript = EXCLUDED.transcript, speakers = EXCLUDED.speakers,
    language = EXCLUDED.language, processed_at = now()
  WHERE private.call_transcripts.company_id = p_company_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'VOICE_TRANSCRIPT_TENANT_MISMATCH'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_call_transcript(uuid, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_call_transcript(uuid, uuid, text, jsonb, text) TO service_role;

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
DECLARE v_rows integer;
BEGIN
  IF p_normalized_phone !~ '^\+[1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'invalid normalized phone'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.company_id = p_company_id AND c.id = p_customer_id) THEN
    RAISE EXCEPTION 'VOICE_CUSTOMER_SCOPE_MISMATCH';
  END IF;
  INSERT INTO private.customer_private_contacts (
    company_id, customer_id, normalized_phone, raw_phone, is_verified
  ) VALUES (p_company_id, p_customer_id, p_normalized_phone, p_raw_phone, false)
  ON CONFLICT (customer_id) DO UPDATE SET
    normalized_phone = EXCLUDED.normalized_phone, raw_phone = EXCLUDED.raw_phone, updated_at = now()
  WHERE private.customer_private_contacts.company_id = p_company_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'VOICE_CONTACT_TENANT_MISMATCH'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_customer_private_contact(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_customer_private_contact(uuid, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_voice_media_jobs(p_limit integer DEFAULT 10)
RETURNS TABLE (
  id uuid, company_id uuid, call_id uuid, job_type text,
  source_ref text, attempts integer, max_attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.voice_media_jobs SET status = 'PENDING', locked_at = NULL
  WHERE status = 'PROCESSING' AND locked_at < now() - interval '15 minutes';
  RETURN QUERY
  WITH candidates AS (
    SELECT vmj.id FROM public.voice_media_jobs vmj
    WHERE vmj.status = 'PENDING' AND vmj.next_run_at <= now()
    ORDER BY vmj.next_run_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
  ), claimed AS (
    UPDATE public.voice_media_jobs vmj
    SET status = 'PROCESSING', locked_at = now()
    FROM candidates c WHERE vmj.id = c.id
    RETURNING vmj.*
  )
  SELECT c.id, c.company_id, c.call_id, c.job_type, c.source_ref, c.attempts, c.max_attempts
  FROM claimed c;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_voice_media_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voice_media_jobs(integer) TO service_role;

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
  WHERE ct.company_id = p_company_id AND ct.call_id = p_call_id
    AND EXISTS (
      SELECT 1 FROM public.voice_media_jobs vmj
      WHERE vmj.company_id = p_company_id AND vmj.call_id = p_call_id
        AND vmj.job_type = 'INTAKE_EXTRACTION' AND vmj.status = 'PROCESSING'
    );
$$;
REVOKE ALL ON FUNCTION public.get_call_transcript_for_voice_worker(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_transcript_for_voice_worker(uuid, uuid) TO service_role;
