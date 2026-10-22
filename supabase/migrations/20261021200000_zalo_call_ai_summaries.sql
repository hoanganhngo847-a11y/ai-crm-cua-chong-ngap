-- Migration: 20261021200000_zalo_call_ai_summaries.sql
-- Zalo Call AI Summaries (Phase 2B)
-- Asynchronous LLM-powered structured call analysis with tenant isolation and lease fencing.

-- 1. Extend zalo_personal_calls with summary_status
ALTER TABLE public.zalo_personal_calls
  ADD COLUMN IF NOT EXISTS summary_status text NOT NULL DEFAULT 'NOT_STARTED'
  CHECK (summary_status IN ('NOT_STARTED', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'));

GRANT SELECT(summary_status) ON public.zalo_personal_calls TO authenticated;

-- 2. AI Summaries table
CREATE TABLE public.zalo_call_ai_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  call_id uuid NOT NULL,
  transcription_id uuid NOT NULL REFERENCES public.zalo_call_transcriptions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL DEFAULT 'v1',
  summary text,
  customer_needs jsonb NOT NULL DEFAULT '[]'::jsonb,
  objections jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  key_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  lead_temperature text CHECK (lead_temperature IS NULL OR lead_temperature IN ('HOT', 'WARM', 'COLD')),
  follow_up_required boolean NOT NULL DEFAULT false,
  follow_up_suggested_time text,
  follow_up_reason text,
  confidence text CHECK (confidence IS NULL OR confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lock_token uuid,
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_zalo_ai_summary_call FOREIGN KEY (company_id, call_id)
    REFERENCES public.zalo_personal_calls(company_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_zalo_call_ai_summaries_tx UNIQUE (company_id, transcription_id)
);

CREATE INDEX idx_zalo_call_ai_summaries_due
  ON public.zalo_call_ai_summaries (status, next_run_at)
  WHERE status IN ('PENDING', 'PROCESSING');

CREATE INDEX idx_zalo_call_ai_summaries_call
  ON public.zalo_call_ai_summaries (company_id, call_id);

CREATE INDEX idx_zalo_call_ai_summaries_tx
  ON public.zalo_call_ai_summaries (company_id, transcription_id);

CREATE INDEX IF NOT EXISTS idx_zalo_call_transcriptions_reconcile
  ON public.zalo_call_transcriptions (completed_at)
  WHERE status = 'COMPLETED';

-- 3. RLS policies and ACL
ALTER TABLE public.zalo_call_ai_summaries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.zalo_call_ai_summaries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zalo_call_ai_summaries TO service_role;
GRANT SELECT ON public.zalo_call_ai_summaries TO authenticated;

CREATE POLICY zalo_call_ai_summaries_read ON public.zalo_call_ai_summaries
  FOR SELECT TO authenticated USING (
    public.has_company_role(company_id, 'BOSS_ADMIN') OR (
      public.has_company_role(company_id, 'SALE') AND EXISTS (
        SELECT 1 FROM public.zalo_personal_calls zpc
        WHERE zpc.id = call_id AND zpc.company_id = company_id AND zpc.staff_user_id = auth.uid()
      )
    )
  );

-- 4. RPC: enqueue summary job
CREATE OR REPLACE FUNCTION public.zalo_enqueue_call_summary(
  p_company uuid,
  p_transcription_id uuid,
  p_provider text,
  p_model text,
  p_prompt_version text DEFAULT 'v1'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tx public.zalo_call_transcriptions;
  v_summary_id uuid;
  v_summary_status text;
  v_provider text;
  v_model text;
BEGIN
  IF p_company IS NULL OR p_transcription_id IS NULL OR p_provider IS NULL OR p_model IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  v_provider := trim(p_provider);
  v_model := trim(p_model);

  IF v_provider = '' OR v_model = '' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT * INTO v_tx
  FROM public.zalo_call_transcriptions
  WHERE id = p_transcription_id AND company_id = p_company;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_NOT_FOUND';
  END IF;

  IF v_tx.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'TRANSCRIPTION_NOT_COMPLETED';
  END IF;

  INSERT INTO public.zalo_call_ai_summaries (
    company_id,
    call_id,
    transcription_id,
    status,
    provider,
    model,
    prompt_version,
    next_run_at
  )
  VALUES (
    p_company,
    v_tx.call_id,
    v_tx.id,
    'PENDING',
    v_provider,
    v_model,
    COALESCE(p_prompt_version, 'v1'),
    now()
  )
  ON CONFLICT (company_id, transcription_id) DO NOTHING;

  SELECT id, status INTO v_summary_id, v_summary_status
  FROM public.zalo_call_ai_summaries
  WHERE company_id = p_company AND transcription_id = p_transcription_id;

  IF v_summary_id IS NOT NULL AND v_summary_status IS NOT NULL THEN
    UPDATE public.zalo_personal_calls
    SET summary_status = v_summary_status
    WHERE id = v_tx.call_id AND company_id = p_company;
  END IF;

  RETURN v_summary_id;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_enqueue_call_summary(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_enqueue_call_summary(uuid, uuid, text, text, text) TO service_role;

-- 5. RPC: targeted claim summary job
CREATE OR REPLACE FUNCTION public.zalo_claim_call_summary_job(
  p_company uuid,
  p_summary_id uuid,
  p_locked_by text DEFAULT 'zalo_summary_worker',
  p_lease_seconds integer DEFAULT 300
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  call_id uuid,
  transcription_id uuid,
  provider text,
  model text,
  prompt_version text,
  attempts integer,
  max_attempts integer,
  lock_token uuid,
  full_transcript text,
  utterances jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_lease_duration interval;
  v_job record;
  v_new_attempts integer;
  v_new_lock_token uuid;
  v_utterances jsonb;
BEGIN
  IF p_company IS NULL OR p_summary_id IS NULL THEN
    RETURN;
  END IF;

  v_lease_duration := (GREATEST(COALESCE(p_lease_seconds, 300), 30) || ' seconds')::interval;

  -- 1. Acquire targeted row FIRST with SELECT ... FOR UPDATE OF zcas SKIP LOCKED
  SELECT
    zcas.id,
    zcas.company_id,
    zcas.call_id,
    zcas.transcription_id,
    zcas.provider,
    zcas.model,
    zcas.prompt_version,
    zcas.status,
    zcas.attempts,
    zcas.max_attempts,
    zcas.next_run_at,
    zcas.lease_expires_at,
    zcas.started_at,
    zct.full_transcript,
    zct.status AS transcription_status
  INTO v_job
  FROM public.zalo_call_ai_summaries zcas
  JOIN public.zalo_call_transcriptions zct
    ON zct.id = zcas.transcription_id AND zct.company_id = zcas.company_id
  WHERE zcas.id = p_summary_id
    AND zcas.company_id = p_company
    AND zct.status = 'COMPLETED'
  FOR UPDATE OF zcas SKIP LOCKED;

  IF v_job.id IS NULL THEN
    RETURN;
  END IF;

  -- 2. Process based on status
  IF v_job.status = 'PENDING' THEN
    IF v_job.next_run_at > now() OR v_job.attempts >= v_job.max_attempts THEN
      RETURN;
    END IF;

    v_new_lock_token := gen_random_uuid();

    UPDATE public.zalo_call_ai_summaries zcas
    SET status = 'PROCESSING',
        lock_token = v_new_lock_token,
        locked_by = COALESCE(p_locked_by, 'zalo_summary_worker'),
        locked_at = now(),
        started_at = COALESCE(zcas.started_at, now()),
        lease_expires_at = now() + v_lease_duration,
        updated_at = now()
    WHERE zcas.id = v_job.id AND zcas.company_id = v_job.company_id;

    UPDATE public.zalo_personal_calls zpc
    SET summary_status = 'PROCESSING'
    WHERE zpc.id = v_job.call_id AND zpc.company_id = v_job.company_id;

  ELSIF v_job.status = 'PROCESSING' AND v_job.lease_expires_at IS NOT NULL AND v_job.lease_expires_at < now() THEN
    v_new_attempts := v_job.attempts + 1;

    IF v_new_attempts >= v_job.max_attempts THEN
      UPDATE public.zalo_call_ai_summaries zcas
      SET status = 'FAILED',
          lock_token = NULL,
          locked_by = NULL,
          locked_at = NULL,
          lease_expires_at = NULL,
          attempts = LEAST(v_new_attempts, 10),
          error_code = 'EXPIRED_LEASE_MAX_ATTEMPTS',
          error_message = 'Job lease expired and maximum attempts exceeded.',
          updated_at = now()
      WHERE zcas.id = v_job.id AND zcas.company_id = v_job.company_id;

      UPDATE public.zalo_personal_calls zpc
      SET summary_status = 'FAILED'
      WHERE zpc.id = v_job.call_id AND zpc.company_id = v_job.company_id;

      RETURN;
    ELSE
      v_new_lock_token := gen_random_uuid();

      UPDATE public.zalo_call_ai_summaries zcas
      SET status = 'PROCESSING',
          lock_token = v_new_lock_token,
          locked_by = COALESCE(p_locked_by, 'zalo_summary_worker'),
          locked_at = now(),
          attempts = v_new_attempts,
          lease_expires_at = now() + v_lease_duration,
          updated_at = now()
      WHERE zcas.id = v_job.id AND zcas.company_id = v_job.company_id;

      UPDATE public.zalo_personal_calls zpc
      SET summary_status = 'PROCESSING'
      WHERE zpc.id = v_job.call_id AND zpc.company_id = v_job.company_id;
    END IF;

  ELSE
    RETURN;
  END IF;

  -- 3. Load utterances ordered by sequence ASC
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'sequence', u.sequence,
        'speaker_role', u.speaker_role,
        'channel', u.channel,
        'start_ms', u.start_ms,
        'end_ms', u.end_ms,
        'text', u.text,
        'confidence', u.confidence
      ) ORDER BY u.sequence ASC
    ),
    '[]'::jsonb
  )
  INTO v_utterances
  FROM public.zalo_call_transcript_utterances u
  WHERE u.transcription_id = v_job.transcription_id
    AND u.company_id = v_job.company_id;

  RETURN QUERY
  SELECT
    v_job.id,
    v_job.company_id,
    v_job.call_id,
    v_job.transcription_id,
    v_job.provider,
    v_job.model,
    v_job.prompt_version,
    COALESCE(v_new_attempts, v_job.attempts),
    v_job.max_attempts,
    v_new_lock_token,
    v_job.full_transcript,
    v_utterances;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_claim_call_summary_job(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_call_summary_job(uuid, uuid, text, integer) TO service_role;

-- 6. RPC: bulk claim summary jobs (delegates to targeted claim)
CREATE OR REPLACE FUNCTION public.zalo_claim_call_summary_jobs(
  p_limit integer DEFAULT 10,
  p_locked_by text DEFAULT 'zalo_summary_worker',
  p_lease_seconds integer DEFAULT 300
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  call_id uuid,
  transcription_id uuid,
  provider text,
  model text,
  prompt_version text,
  attempts integer,
  max_attempts integer,
  lock_token uuid,
  full_transcript text,
  utterances jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_effective_limit integer;
  v_locked_by text;
  v_lease_seconds integer;
  v_claimed_count integer := 0;
  v_candidate record;
BEGIN
  v_effective_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_locked_by := COALESCE(p_locked_by, 'zalo_summary_worker');
  v_lease_seconds := GREATEST(COALESCE(p_lease_seconds, 300), 30);

  FOR v_candidate IN
    SELECT zcas.id, zcas.company_id
    FROM public.zalo_call_ai_summaries zcas
    JOIN public.zalo_call_transcriptions zct
      ON zct.id = zcas.transcription_id AND zct.company_id = zcas.company_id
    WHERE (
      (zcas.status = 'PENDING' AND zcas.next_run_at <= now() AND zcas.attempts < zcas.max_attempts)
      OR
      (zcas.status = 'PROCESSING' AND zcas.lease_expires_at IS NOT NULL AND zcas.lease_expires_at < now())
    )
      AND zct.status = 'COMPLETED'
    ORDER BY zcas.next_run_at ASC, zcas.created_at ASC
    FOR UPDATE OF zcas SKIP LOCKED
    LIMIT 50
  LOOP
    EXIT WHEN v_claimed_count >= v_effective_limit;

    RETURN QUERY
    SELECT *
    FROM public.zalo_claim_call_summary_job(
      v_candidate.company_id,
      v_candidate.id,
      v_locked_by,
      v_lease_seconds
    );

    IF FOUND THEN
      v_claimed_count := v_claimed_count + 1;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_claim_call_summary_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_call_summary_jobs(integer, text, integer) TO service_role;

-- 7. RPC: complete summary
CREATE OR REPLACE FUNCTION public.zalo_complete_call_summary(
  p_company uuid,
  p_summary_id uuid,
  p_lock_token uuid,
  p_summary text,
  p_customer_needs jsonb,
  p_objections jsonb,
  p_next_actions jsonb,
  p_key_points jsonb,
  p_lead_temperature text,
  p_follow_up_required boolean,
  p_follow_up_suggested_time text,
  p_follow_up_reason text,
  p_confidence text,
  p_provider text,
  p_model text,
  p_prompt_version text DEFAULT 'v1'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sum public.zalo_call_ai_summaries;
BEGIN
  SELECT * INTO v_sum
  FROM public.zalo_call_ai_summaries
  WHERE id = p_summary_id
    AND company_id = p_company
    AND lock_token = p_lock_token
    AND status = 'PROCESSING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUMMARY_LOCK_LOST';
  END IF;

  UPDATE public.zalo_call_ai_summaries
  SET status = 'COMPLETED',
      completed_at = now(),
      summary = p_summary,
      customer_needs = COALESCE(p_customer_needs, '[]'::jsonb),
      objections = COALESCE(p_objections, '[]'::jsonb),
      next_actions = COALESCE(p_next_actions, '[]'::jsonb),
      key_points = COALESCE(p_key_points, '[]'::jsonb),
      lead_temperature = p_lead_temperature,
      follow_up_required = COALESCE(p_follow_up_required, false),
      follow_up_suggested_time = p_follow_up_suggested_time,
      follow_up_reason = p_follow_up_reason,
      confidence = p_confidence,
      provider = COALESCE(p_provider, provider),
      model = COALESCE(p_model, model),
      prompt_version = COALESCE(p_prompt_version, prompt_version),
      lock_token = NULL,
      locked_by = NULL,
      locked_at = NULL,
      lease_expires_at = NULL,
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
  WHERE id = v_sum.id;

  UPDATE public.zalo_personal_calls
  SET summary_status = 'COMPLETED'
  WHERE id = v_sum.call_id AND company_id = p_company;

  INSERT INTO public.audit_logs(company_id, user_id, action, resource_type, resource_id, result, metadata)
  VALUES (
    p_company,
    NULL,
    'ZALO_CALL_AI_SUMMARY_COMPLETED',
    'ZALO_CALL_SUMMARY',
    v_sum.id,
    'SUCCESS',
    jsonb_build_object(
      'call_id', v_sum.call_id,
      'transcription_id', v_sum.transcription_id,
      'provider', COALESCE(p_provider, v_sum.provider),
      'model', COALESCE(p_model, v_sum.model)
    )
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_complete_call_summary(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, boolean, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_complete_call_summary(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, boolean, text, text, text, text, text, text) TO service_role;

-- 8. RPC: fail summary
CREATE OR REPLACE FUNCTION public.zalo_fail_call_summary(
  p_company uuid,
  p_summary_id uuid,
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
  v_sum public.zalo_call_ai_summaries;
  v_new_attempts integer;
  v_is_terminal boolean;
BEGIN
  SELECT * INTO v_sum
  FROM public.zalo_call_ai_summaries
  WHERE id = p_summary_id
    AND company_id = p_company
    AND lock_token = p_lock_token
    AND status = 'PROCESSING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUMMARY_LOCK_LOST';
  END IF;

  v_new_attempts := LEAST(v_sum.attempts + 1, 10);
  v_is_terminal := COALESCE(p_terminal, false) OR (v_new_attempts >= v_sum.max_attempts);

  UPDATE public.zalo_call_ai_summaries
  SET status = CASE WHEN v_is_terminal THEN 'FAILED' ELSE 'PENDING' END,
      attempts = v_new_attempts,
      next_run_at = CASE WHEN v_is_terminal THEN now() ELSE COALESCE(p_next_run_at, now() + interval '30 seconds') END,
      error_code = p_error_code,
      error_message = p_error_message,
      lock_token = NULL,
      locked_by = NULL,
      locked_at = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_sum.id;

  IF v_is_terminal THEN
    UPDATE public.zalo_personal_calls
    SET summary_status = 'FAILED'
    WHERE id = v_sum.call_id AND company_id = p_company;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_fail_call_summary(uuid, uuid, uuid, text, text, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_fail_call_summary(uuid, uuid, uuid, text, text, boolean, timestamptz) TO service_role;

-- 9. RPC: retry summary (authorized manual retry)
CREATE OR REPLACE FUNCTION public.zalo_retry_call_summary(
  p_company uuid,
  p_actor uuid,
  p_summary_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_sum public.zalo_call_ai_summaries;
  v_call public.zalo_personal_calls;
BEGIN
  IF p_company IS NULL OR p_actor IS NULL OR p_summary_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  v_role := public.zalo_assert_actor(p_company, p_actor);

  SELECT * INTO v_sum
  FROM public.zalo_call_ai_summaries
  WHERE id = p_summary_id AND company_id = p_company
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUMMARY_NOT_FOUND';
  END IF;

  SELECT * INTO v_call
  FROM public.zalo_personal_calls
  WHERE id = v_sum.call_id AND company_id = p_company;

  IF v_role = 'SALE' AND v_call.staff_user_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_sum.status = 'COMPLETED' THEN
    RETURN false;
  END IF;

  IF v_sum.status = 'PROCESSING' AND v_sum.lease_expires_at IS NOT NULL AND v_sum.lease_expires_at > now() THEN
    RETURN false;
  END IF;

  UPDATE public.zalo_call_ai_summaries
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
  WHERE id = v_sum.id;

  UPDATE public.zalo_personal_calls
  SET summary_status = 'PENDING'
  WHERE id = v_sum.call_id AND company_id = p_company;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_retry_call_summary(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_retry_call_summary(uuid, uuid, uuid) TO service_role;

-- 10. RPC: reconcile missing summaries for completed transcriptions
-- Drops legacy lookback overload if present to prevent signature collisions
DROP FUNCTION IF EXISTS public.zalo_reconcile_missing_call_summaries(integer, text, text, integer);

CREATE OR REPLACE FUNCTION public.zalo_reconcile_missing_call_summaries(
  p_limit integer DEFAULT 10,
  p_provider text DEFAULT 'GEMINI',
  p_model text DEFAULT 'gemini-2.5-flash',
  p_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
  reconciled_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer;
  v_item record;
  v_count integer := 0;
  v_summary_id uuid;
BEGIN
  IF p_provider IS NULL OR trim(p_provider) = '' OR p_model IS NULL OR trim(p_model) = '' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Fail-closed safety invariant:
  -- If p_since is NULL, reconciliation is a no-op to prevent unconstrained historical backfill.
  IF p_since IS NULL THEN
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  FOR v_item IN
    SELECT t.company_id, t.id AS transcription_id
    FROM public.zalo_call_transcriptions t
    LEFT JOIN public.zalo_call_ai_summaries s
      ON s.company_id = t.company_id AND s.transcription_id = t.id
    WHERE t.status = 'COMPLETED'
      AND s.id IS NULL
      AND COALESCE(t.completed_at, t.created_at) >= p_since
    ORDER BY COALESCE(t.completed_at, t.created_at) ASC
    LIMIT v_limit
  LOOP
    BEGIN
      v_summary_id := public.zalo_enqueue_call_summary(
        v_item.company_id,
        v_item.transcription_id,
        trim(p_provider),
        trim(p_model)
      );
      IF v_summary_id IS NOT NULL THEN
        v_count := v_count + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Best effort per row, do not fail entire reconciliation batch
    END;
  END LOOP;

  RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_reconcile_missing_call_summaries(integer, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_reconcile_missing_call_summaries(integer, text, text, timestamptz) TO service_role;
