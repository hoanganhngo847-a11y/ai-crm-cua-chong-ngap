-- Migration: 20261021120000_zalo_call_transcription.sql
-- Zalo Personal Call Transcription Phase 1
-- Asynchronous stereo transcription pipeline preserving channel identity (Left=remote/customer, Right=local/staff).

-- 1. Extend zalo_personal_calls with transcript_status
-- Default is 'NOT_STARTED': existing/historical recordings are NOT automatically enqueued.
-- Only new recordings finalized after this migration transition to 'PENDING' via zalo_finish_recording.
-- Historical recordings can be explicitly enqueued via the zalo_retry_transcription RPC (backfill action).
ALTER TABLE public.zalo_personal_calls
  ADD COLUMN IF NOT EXISTS transcript_status text NOT NULL DEFAULT 'NOT_STARTED'
  CHECK (transcript_status IN ('NOT_STARTED', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'));

GRANT SELECT(transcript_status) ON public.zalo_personal_calls TO authenticated;

-- 2. Transcriptions table
CREATE TABLE public.zalo_call_transcriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  call_id uuid NOT NULL,
  customer_id uuid,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  provider text NOT NULL DEFAULT 'OPENAI',
  language text NOT NULL DEFAULT 'vi',
  raw_channel_layout text NOT NULL DEFAULT 'stereo (Left=remote/customer, Right=local/staff)',
  channels_silent jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  full_transcript text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_zalo_transcription_call FOREIGN KEY (company_id, call_id)
    REFERENCES public.zalo_personal_calls(company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_zalo_transcription_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE SET NULL,
  CONSTRAINT uq_zalo_call_transcriptions_call UNIQUE (company_id, call_id)
);

CREATE INDEX idx_zalo_call_transcriptions_due
  ON public.zalo_call_transcriptions (status, next_run_at)
  WHERE status IN ('PENDING', 'PROCESSING');

CREATE INDEX idx_zalo_call_transcriptions_call
  ON public.zalo_call_transcriptions (company_id, call_id);

CREATE INDEX idx_zalo_call_transcriptions_customer
  ON public.zalo_call_transcriptions (company_id, customer_id);

-- 3. Utterances / segments table
CREATE TABLE public.zalo_call_transcript_utterances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  transcription_id uuid NOT NULL REFERENCES public.zalo_call_transcriptions(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  speaker_role text NOT NULL CHECK (speaker_role IN ('STAFF', 'CUSTOMER')),
  channel text NOT NULL CHECK (channel IN ('LEFT', 'RIGHT')),
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL CHECK (end_ms >= start_ms),
  text text NOT NULL,
  confidence double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  provider_segment_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_zalo_utterance_call FOREIGN KEY (company_id, call_id)
    REFERENCES public.zalo_personal_calls(company_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_zalo_transcript_utterance_seq UNIQUE (transcription_id, sequence)
);

CREATE INDEX idx_zalo_transcript_utterances_tx
  ON public.zalo_call_transcript_utterances (transcription_id, sequence);

CREATE INDEX idx_zalo_transcript_utterances_call
  ON public.zalo_call_transcript_utterances (company_id, call_id);

-- 4. RLS policies and ACL
ALTER TABLE public.zalo_call_transcriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_call_transcript_utterances ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.zalo_call_transcriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.zalo_call_transcript_utterances FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.zalo_call_transcriptions TO service_role;
GRANT ALL ON public.zalo_call_transcript_utterances TO service_role;

GRANT SELECT ON public.zalo_call_transcriptions TO authenticated;
GRANT SELECT ON public.zalo_call_transcript_utterances TO authenticated;

CREATE POLICY zalo_call_transcriptions_read ON public.zalo_call_transcriptions
  FOR SELECT TO authenticated USING (
    public.has_company_role(company_id, 'BOSS_ADMIN') OR (
      public.has_company_role(company_id, 'SALE') AND EXISTS (
        SELECT 1 FROM public.zalo_personal_calls zpc
        WHERE zpc.id = call_id AND zpc.company_id = company_id AND zpc.staff_user_id = auth.uid()
      )
    )
  );

CREATE POLICY zalo_call_transcript_utterances_read ON public.zalo_call_transcript_utterances
  FOR SELECT TO authenticated USING (
    public.has_company_role(company_id, 'BOSS_ADMIN') OR (
      public.has_company_role(company_id, 'SALE') AND EXISTS (
        SELECT 1 FROM public.zalo_personal_calls zpc
        WHERE zpc.id = call_id AND zpc.company_id = company_id AND zpc.staff_user_id = auth.uid()
      )
    )
  );

-- 5. RPC: enqueue transcription
CREATE OR REPLACE FUNCTION public.zalo_enqueue_transcription(
  p_company uuid,
  p_call uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_call public.zalo_personal_calls;
  v_tx_id uuid;
BEGIN
  SELECT * INTO v_call
  FROM public.zalo_personal_calls
  WHERE id = p_call AND company_id = p_company;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZALO_CALL_NOT_FOUND';
  END IF;

  INSERT INTO public.zalo_call_transcriptions (
    company_id,
    call_id,
    customer_id,
    status,
    next_run_at
  )
  VALUES (
    p_company,
    p_call,
    v_call.customer_id,
    'PENDING',
    now()
  )
  ON CONFLICT (company_id, call_id) DO UPDATE
    SET customer_id = EXCLUDED.customer_id,
        updated_at = now()
    WHERE public.zalo_call_transcriptions.status IN ('PENDING', 'PROCESSING')
  RETURNING id INTO v_tx_id;

  UPDATE public.zalo_personal_calls
  SET transcript_status = 'PENDING'
  WHERE id = p_call AND company_id = p_company AND transcript_status <> 'COMPLETED';

  RETURN v_tx_id;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_enqueue_transcription(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_enqueue_transcription(uuid, uuid) TO service_role;

-- 6. RPC: claim transcription jobs
CREATE OR REPLACE FUNCTION public.zalo_claim_transcription_jobs(
  p_limit integer DEFAULT 10,
  p_locked_by text DEFAULT 'zalo_transcription_worker',
  p_lease_seconds integer DEFAULT 300
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  call_id uuid,
  customer_id uuid,
  provider text,
  language text,
  raw_channel_layout text,
  attempts integer,
  max_attempts integer,
  lock_token uuid,
  recording_path text,
  audio_validation jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_lease_duration interval;
BEGIN
  v_lease_duration := (GREATEST(p_lease_seconds, 30) || ' seconds')::interval;

  -- 1. Reclaim expired leases
  UPDATE public.zalo_call_transcriptions zct
  SET status = 'PENDING',
      lock_token = NULL,
      locked_by = NULL,
      locked_at = NULL,
      lease_expires_at = NULL,
      attempts = zct.attempts + 1,
      updated_at = now()
  WHERE zct.status = 'PROCESSING'
    AND zct.lease_expires_at IS NOT NULL
    AND zct.lease_expires_at < now();

  -- 2. Claim available jobs with FOR UPDATE SKIP LOCKED
  RETURN QUERY
  WITH candidates AS (
    SELECT zct.id, zct.call_id, zct.company_id
    FROM public.zalo_call_transcriptions zct
    WHERE zct.status = 'PENDING'
      AND zct.next_run_at <= now()
      AND zct.attempts < zct.max_attempts
    ORDER BY zct.next_run_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
  ), claimed AS (
    UPDATE public.zalo_call_transcriptions zct
    SET status = 'PROCESSING',
        lock_token = gen_random_uuid(),
        locked_by = p_locked_by,
        locked_at = now(),
        started_at = COALESCE(zct.started_at, now()),
        lease_expires_at = now() + v_lease_duration,
        updated_at = now()
    FROM candidates c
    WHERE zct.id = c.id
    RETURNING zct.*
  ), updated_calls AS (
    UPDATE public.zalo_personal_calls zpc
    SET transcript_status = 'PROCESSING'
    FROM candidates c
    WHERE zpc.id = c.call_id AND zpc.company_id = c.company_id
    RETURNING zpc.id
  )
  SELECT
    cl.id,
    cl.company_id,
    cl.call_id,
    cl.customer_id,
    cl.provider,
    cl.language,
    cl.raw_channel_layout,
    cl.attempts,
    cl.max_attempts,
    cl.lock_token,
    zpc.recording_path,
    zpc.audio_validation
  FROM claimed cl
  JOIN public.zalo_personal_calls zpc
    ON zpc.id = cl.call_id AND zpc.company_id = cl.company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_claim_transcription_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_transcription_jobs(integer, text, integer) TO service_role;

-- 7. RPC: complete transcription
CREATE OR REPLACE FUNCTION public.zalo_complete_transcription(
  p_company uuid,
  p_transcription_id uuid,
  p_lock_token uuid,
  p_full_transcript text,
  p_utterances jsonb,
  p_channels_silent jsonb DEFAULT '{}'::jsonb,
  p_language text DEFAULT 'vi'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tx public.zalo_call_transcriptions;
  v_elem jsonb;
  v_seq integer;
  v_speaker text;
  v_channel text;
  v_start integer;
  v_end integer;
  v_text text;
  v_conf double precision;
  v_seg_id text;
BEGIN
  SELECT * INTO v_tx
  FROM public.zalo_call_transcriptions
  WHERE id = p_transcription_id
    AND company_id = p_company
    AND lock_token = p_lock_token
    AND status = 'PROCESSING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_LOCK_LOST';
  END IF;

  -- Insert utterances
  IF p_utterances IS NOT NULL AND jsonb_typeof(p_utterances) = 'array' THEN
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_utterances)
    LOOP
      v_seq := (v_elem->>'sequence')::integer;
      v_speaker := v_elem->>'speaker_role';
      v_channel := v_elem->>'channel';
      v_start := (v_elem->>'start_ms')::integer;
      v_end := (v_elem->>'end_ms')::integer;
      v_text := v_elem->>'text';
      v_conf := (v_elem->>'confidence')::double precision;
      v_seg_id := v_elem->>'provider_segment_id';

      IF v_seq IS NOT NULL AND v_speaker IN ('STAFF', 'CUSTOMER') AND v_channel IN ('LEFT', 'RIGHT')
         AND v_start >= 0 AND v_end >= v_start AND v_text IS NOT NULL THEN
        INSERT INTO public.zalo_call_transcript_utterances (
          company_id,
          transcription_id,
          call_id,
          sequence,
          speaker_role,
          channel,
          start_ms,
          end_ms,
          text,
          confidence,
          provider_segment_id
        )
        VALUES (
          p_company,
          v_tx.id,
          v_tx.call_id,
          v_seq,
          v_speaker,
          v_channel,
          v_start,
          v_end,
          v_text,
          v_conf,
          v_seg_id
        )
        ON CONFLICT (transcription_id, sequence) DO UPDATE
          SET speaker_role = EXCLUDED.speaker_role,
              channel = EXCLUDED.channel,
              start_ms = EXCLUDED.start_ms,
              end_ms = EXCLUDED.end_ms,
              text = EXCLUDED.text,
              confidence = EXCLUDED.confidence;
      END IF;
    END LOOP;
  END IF;

  -- Update transcription status to COMPLETED
  UPDATE public.zalo_call_transcriptions
  SET status = 'COMPLETED',
      completed_at = now(),
      full_transcript = p_full_transcript,
      channels_silent = COALESCE(p_channels_silent, '{}'::jsonb),
      language = COALESCE(p_language, language),
      lock_token = NULL,
      locked_by = NULL,
      locked_at = NULL,
      lease_expires_at = NULL,
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
  WHERE id = v_tx.id;

  -- Update call transcript_status to COMPLETED
  UPDATE public.zalo_personal_calls
  SET transcript_status = 'COMPLETED'
  WHERE id = v_tx.call_id AND company_id = p_company;

  -- Audit log
  INSERT INTO public.audit_logs(company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
  VALUES (
    p_company,
    NULL,
    'ZALO_TRANSCRIPTION_COMPLETED',
    'ZALO_CALL',
    v_tx.call_id,
    v_tx.customer_id,
    'SUCCESS',
    jsonb_build_object(
      'transcription_id', v_tx.id,
      'provider', v_tx.provider,
      'language', COALESCE(p_language, v_tx.language)
    )
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_complete_transcription(uuid, uuid, uuid, text, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_complete_transcription(uuid, uuid, uuid, text, jsonb, jsonb, text) TO service_role;

-- 8. RPC: fail transcription
CREATE OR REPLACE FUNCTION public.zalo_fail_transcription(
  p_company uuid,
  p_transcription_id uuid,
  p_lock_token uuid,
  p_error_code text,
  p_error_message text,
  p_terminal boolean,
  p_next_run_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tx public.zalo_call_transcriptions;
BEGIN
  SELECT * INTO v_tx
  FROM public.zalo_call_transcriptions
  WHERE id = p_transcription_id
    AND company_id = p_company
    AND lock_token = p_lock_token
    AND status = 'PROCESSING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_LOCK_LOST';
  END IF;

  IF p_terminal THEN
    UPDATE public.zalo_call_transcriptions
    SET status = 'FAILED',
        completed_at = now(),
        error_code = p_error_code,
        error_message = p_error_message,
        lock_token = NULL,
        locked_by = NULL,
        locked_at = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_tx.id;

    UPDATE public.zalo_personal_calls
    SET transcript_status = 'FAILED'
    WHERE id = v_tx.call_id AND company_id = p_company;
  ELSE
    UPDATE public.zalo_call_transcriptions
    SET status = 'PENDING',
        attempts = attempts + 1,
        next_run_at = COALESCE(p_next_run_at, now() + interval '30 seconds'),
        error_code = p_error_code,
        error_message = p_error_message,
        lock_token = NULL,
        locked_by = NULL,
        locked_at = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_tx.id;

    UPDATE public.zalo_personal_calls
    SET transcript_status = 'PENDING'
    WHERE id = v_tx.call_id AND company_id = p_company;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_fail_transcription(uuid, uuid, uuid, text, text, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_fail_transcription(uuid, uuid, uuid, text, text, boolean, timestamptz) TO service_role;

-- 9. RPC: retry transcription
CREATE OR REPLACE FUNCTION public.zalo_retry_transcription(
  p_company uuid,
  p_actor uuid,
  p_call uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_call public.zalo_personal_calls;
  v_tx public.zalo_call_transcriptions;
BEGIN
  v_role := public.zalo_assert_actor(p_company, p_actor);

  SELECT * INTO v_call
  FROM public.zalo_personal_calls
  WHERE id = p_call AND company_id = p_company
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZALO_CALL_NOT_FOUND';
  END IF;

  IF v_role = 'SALE' AND v_call.staff_user_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'ZALO_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_tx
  FROM public.zalo_call_transcriptions
  WHERE call_id = p_call AND company_id = p_company
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.zalo_call_transcriptions (
      company_id,
      call_id,
      customer_id,
      status,
      attempts,
      next_run_at
    )
    VALUES (
      p_company,
      p_call,
      v_call.customer_id,
      'PENDING',
      0,
      now()
    )
    RETURNING * INTO v_tx;
  ELSE
    UPDATE public.zalo_call_transcriptions
    SET status = 'PENDING',
        attempts = 0,
        next_run_at = now(),
        error_code = NULL,
        error_message = NULL,
        lock_token = NULL,
        locked_by = NULL,
        locked_at = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_tx.id;
  END IF;

  UPDATE public.zalo_personal_calls
  SET transcript_status = 'PENDING'
  WHERE id = p_call AND company_id = p_company;

  -- Audit log for retry
  INSERT INTO public.audit_logs(company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
  VALUES (
    p_company,
    p_actor,
    'ZALO_TRANSCRIPTION_RETRY',
    'ZALO_CALL',
    p_call,
    v_call.customer_id,
    'SUCCESS',
    jsonb_build_object('transcription_id', v_tx.id)
  );

  RETURN jsonb_build_object('ok', true, 'status', 'PENDING', 'call_id', p_call, 'transcription_id', v_tx.id);
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_retry_transcription(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_retry_transcription(uuid, uuid, uuid) TO service_role;

-- 10. Update zalo_finish_recording to enqueue transcription job atomically
CREATE OR REPLACE FUNCTION public.zalo_finish_recording(
  p_device uuid,
  p_key_hash text,
  p_call uuid,
  p_lease uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  c public.zalo_personal_calls;
  req public.zalo_outbound_call_requests;
  v_count int := 0;
  v_customers int := 0;
  v_customer uuid := null;
  v_ambiguous boolean := false;
  v_req_role text;
  v_final_staff uuid;
BEGIN
  -- 1. Take device FOR UPDATE as FIRST row lock
  SELECT * INTO d FROM public.zalo_recording_devices
  WHERE id = p_device AND active AND device_key_hash = p_key_hash
  FOR UPDATE;

  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  IF d.staff_user_id IS NOT NULL THEN
    PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
  END IF;

  -- 2. Lock call row FOR UPDATE
  SELECT * INTO c FROM public.zalo_personal_calls
  WHERE id = p_call AND company_id = d.company_id AND device_id = d.id
  FOR UPDATE;

  IF NOT FOUND OR c.upload_lease <> p_lease THEN
    RAISE EXCEPTION 'ZALO_LEASE_LOST';
  END IF;

  IF c.recording_status = 'READY' THEN
    RETURN jsonb_build_object('call_id', c.id, 'recording_id', c.id, 'duplicate', true);
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'zalo-call-recordings'
      AND name = c.recording_path
      AND (metadata->>'size')::bigint = c.recording_bytes
  ) THEN
    RAISE EXCEPTION 'ZALO_OBJECT_MISSING';
  END IF;

  v_final_staff := c.staff_user_id;

  -- 3. Direct attachment from verified outbound request
  IF c.outbound_request_id IS NOT NULL THEN
    SELECT * INTO req FROM public.zalo_outbound_call_requests
    WHERE id = c.outbound_request_id AND company_id = c.company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND';
    END IF;

    IF c.direction IS DISTINCT FROM 'OUTBOUND' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DIRECTION_MISMATCH';
    END IF;

    IF req.claimed_at IS NULL OR req.claimed_by_device_id IS NULL THEN
      RAISE EXCEPTION 'ZALO_REQUEST_UNCLAIMED';
    END IF;

    IF req.claimed_by_device_id <> d.id THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
    END IF;

    IF req.device_id IS NOT NULL AND req.device_id <> d.id THEN
      RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
    END IF;

    v_req_role := public.zalo_assert_actor(c.company_id, req.staff_user_id);
    IF d.staff_user_id IS NOT NULL THEN
      PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
      IF d.staff_user_id <> req.staff_user_id THEN
        IF v_req_role <> 'BOSS_ADMIN' OR req.device_id IS DISTINCT FROM d.id THEN
          RAISE EXCEPTION 'ZALO_REQUEST_STAFF_MISMATCH';
        END IF;
      END IF;
    END IF;

    IF req.status = 'FAILED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_FAILED';
    END IF;
    IF req.status = 'EXPIRED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
    END IF;
    IF req.status = 'COMPLETED' THEN
      RAISE EXCEPTION 'ZALO_REQUEST_REUSED';
    END IF;
    IF req.status NOT IN ('CALL_TRIGGERED', 'CALL_DETECTED') THEN
      RAISE EXCEPTION 'ZALO_REQUEST_INVALID_STATE';
    END IF;

    IF c.started_at < (req.created_at - interval '30 seconds') OR c.started_at < (req.claimed_at - interval '30 seconds') THEN
      RAISE EXCEPTION 'ZALO_REQUEST_TIMING_INVALID';
    END IF;
    IF c.started_at > req.expires_at THEN
      RAISE EXCEPTION 'ZALO_REQUEST_EXPIRED';
    END IF;

    IF EXISTS(
      SELECT 1 FROM public.zalo_personal_calls
      WHERE outbound_request_id = req.id
        AND id <> c.id
    ) THEN
      RAISE EXCEPTION 'ZALO_REQUEST_REUSED';
    END IF;

    IF NOT EXISTS(SELECT 1 FROM public.customers WHERE id = req.customer_id AND company_id = c.company_id) THEN
      RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
    END IF;

    v_customer := req.customer_id;

    IF v_final_staff IS NULL AND d.staff_user_id IS NULL THEN
      v_final_staff := req.staff_user_id;
    END IF;

    UPDATE public.zalo_outbound_call_requests
    SET status = 'COMPLETED', completed_at = now()
    WHERE id = req.id;

    v_ambiguous := false;
    v_count := 1;
  END IF;

  -- 4. Fallback to confirmed mappings / name suggestions for inbound or standalone calls
  IF v_customer IS NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.company_id::text||c.zalo_account_key::text||c.remote_display_name_normalized, 0));
    SELECT count(*), coalesce(bool_or(needs_confirmation), false) INTO v_count, v_ambiguous
    FROM public.zalo_customer_identity_mappings
    WHERE company_id = c.company_id
      AND zalo_account_key = c.zalo_account_key
      AND remote_display_name_normalized = c.remote_display_name_normalized
      AND active;

    SELECT count(*) INTO v_customers
    FROM public.customers
    WHERE company_id = c.company_id
      AND public.zalo_search_name(name) = public.zalo_search_name(c.remote_display_name_normalized);

    v_ambiguous := v_ambiguous OR v_count > 1 OR v_customers > 1;

    IF v_count = 1 AND NOT v_ambiguous AND c.remote_display_name_normalized <> '' THEN
      SELECT customer_id INTO v_customer
      FROM public.zalo_customer_identity_mappings
      WHERE company_id = c.company_id
        AND zalo_account_key = c.zalo_account_key
        AND remote_display_name_normalized = c.remote_display_name_normalized
        AND active;
    END IF;
  END IF;

  -- 5. Atomic state transition and audit logging
  UPDATE public.zalo_personal_calls
  SET recording_status = 'READY',
      transcript_status = 'PENDING',
      customer_id = v_customer,
      staff_user_id = v_final_staff,
      identity_ambiguous = v_ambiguous,
      matching_status = CASE
        WHEN v_customer IS NOT NULL THEN 'EXACT'
        WHEN v_count > 0 OR v_customers > 0 THEN 'SUGGESTED'
        ELSE 'UNMATCHED'
      END
  WHERE id = c.id;

  -- 6. Enqueue transcription job
  INSERT INTO public.zalo_call_transcriptions (
    company_id,
    call_id,
    customer_id,
    status,
    next_run_at
  )
  VALUES (
    c.company_id,
    c.id,
    v_customer,
    'PENDING',
    now()
  )
  ON CONFLICT (company_id, call_id) DO UPDATE
    SET customer_id = EXCLUDED.customer_id,
        updated_at = now()
    WHERE public.zalo_call_transcriptions.status IN ('PENDING', 'PROCESSING');

  INSERT INTO public.audit_logs(company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
  VALUES (
    c.company_id,
    coalesce(d.staff_user_id, req.staff_user_id),
    'ZALO_RECORDING_READY',
    'ZALO_CALL',
    c.id,
    v_customer,
    'SUCCESS',
    jsonb_build_object(
      'device_id', d.id,
      'outbound_request_id', c.outbound_request_id,
      'initiating_staff_user_id', req.staff_user_id,
      'actual_staff_user_id', d.staff_user_id
    )
  );

  RETURN jsonb_build_object('call_id', c.id, 'recording_id', c.id, 'duplicate', false);
END $$;

REVOKE ALL ON FUNCTION public.zalo_finish_recording(uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_finish_recording(uuid,text,uuid,uuid) TO service_role;

-- 11. Update zalo_link_customer to sync customer_id on zalo_call_transcriptions
CREATE OR REPLACE FUNCTION public.zalo_link_customer(
  p_company uuid,
  p_actor uuid,
  p_call uuid,
  p_customer uuid DEFAULT NULL,
  p_new_name text DEFAULT NULL,
  p_remember boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  c public.zalo_personal_calls;
  v_role text;
  v_customer uuid := p_customer;
  v_conflict boolean := false;
BEGIN
  v_role := public.zalo_assert_actor(p_company, p_actor);
  SELECT * INTO c FROM public.zalo_personal_calls WHERE id = p_call AND company_id = p_company FOR UPDATE;
  IF NOT FOUND OR c.recording_status <> 'READY' OR (v_role = 'SALE' AND c.staff_user_id IS DISTINCT FROM p_actor) THEN
    RAISE EXCEPTION 'ZALO_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF c.customer_id IS NOT NULL AND p_new_name IS NOT NULL THEN
    RETURN jsonb_build_object('customer_id', c.customer_id);
  END IF;

  IF v_customer IS NULL THEN
    IF p_new_name IS NULL OR length(btrim(p_new_name)) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'ZALO_INVALID_CUSTOMER';
    END IF;
    INSERT INTO public.customers(company_id, name, source, stage)
    VALUES(p_company, btrim(p_new_name), 'ZALO', 'LEAD_NEW')
    RETURNING id INTO v_customer;

    INSERT INTO public.customer_stage_histories(company_id, customer_id, to_stage, actor_type, changed_by_user_id, reason)
    VALUES(p_company, v_customer, 'LEAD_NEW', 'USER', p_actor, 'Created from Zalo call confirmation');
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.customers WHERE company_id = p_company AND id = v_customer) THEN
    RAISE EXCEPTION 'ZALO_INVALID_CUSTOMER';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.company_id::text||c.zalo_account_key::text||c.remote_display_name_normalized, 0));
  IF c.remote_display_name_normalized <> '' THEN
    SELECT EXISTS(
      SELECT 1 FROM public.zalo_customer_identity_mappings
      WHERE company_id = p_company AND zalo_account_key = c.zalo_account_key
        AND remote_display_name_normalized = c.remote_display_name_normalized
        AND active AND customer_id <> v_customer
    ) INTO v_conflict;

    IF v_conflict THEN
      UPDATE public.zalo_customer_identity_mappings
      SET needs_confirmation = true, updated_at = now()
      WHERE company_id = p_company AND zalo_account_key = c.zalo_account_key
        AND remote_display_name_normalized = c.remote_display_name_normalized;
    END IF;

    IF p_remember THEN
      INSERT INTO public.zalo_customer_identity_mappings(
        company_id, zalo_account_key, remote_display_name_original,
        remote_display_name_normalized, customer_id, confirmed_by, needs_confirmation
      )
      VALUES(
        p_company, c.zalo_account_key, c.remote_display_name,
        c.remote_display_name_normalized, v_customer, p_actor, v_conflict
      )
      ON CONFLICT(company_id, zalo_account_key, remote_display_name_normalized, customer_id) DO UPDATE
        SET active = true, confirmed_by = p_actor, confirmed_at = now(), updated_at = now(),
            needs_confirmation = public.zalo_customer_identity_mappings.needs_confirmation OR v_conflict;
    END IF;
  ELSIF p_remember THEN
    RAISE EXCEPTION 'ZALO_NAME_REQUIRED_FOR_MAPPING';
  END IF;

  UPDATE public.zalo_personal_calls
  SET customer_id = v_customer, linked_by = p_actor, linked_at = now(),
      matching_status = 'EXACT', identity_ambiguous = identity_ambiguous OR v_conflict
  WHERE id = c.id;

  -- Sync customer_id to transcriptions
  UPDATE public.zalo_call_transcriptions
  SET customer_id = v_customer, updated_at = now()
  WHERE company_id = p_company AND call_id = c.id;

  INSERT INTO public.audit_logs(company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
  VALUES(
    p_company, p_actor, 'ZALO_CUSTOMER_CONFIRMED', 'ZALO_CALL', c.id, v_customer, 'SUCCESS',
    jsonb_build_object('remember', p_remember, 'ambiguous', v_conflict)
  );

  RETURN jsonb_build_object('customer_id', v_customer, 'ambiguous', v_conflict);
END $$;

REVOKE ALL ON FUNCTION public.zalo_link_customer(uuid,uuid,uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_link_customer(uuid,uuid,uuid,uuid,text,boolean) TO service_role;
