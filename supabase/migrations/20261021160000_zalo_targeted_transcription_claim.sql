-- Migration: 20261021160000_zalo_targeted_transcription_claim.sql
-- Targeted transcription job claiming RPC for safe single-job execution.

CREATE OR REPLACE FUNCTION public.zalo_claim_transcription_job(
  p_company uuid,
  p_transcription_id uuid,
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
  v_job record;
  v_new_attempts integer;
  v_new_lock_token uuid;
BEGIN
  -- Strict validation: both company and transcription_id must be provided
  IF p_company IS NULL OR p_transcription_id IS NULL THEN
    RETURN;
  END IF;

  v_lease_duration := (GREATEST(COALESCE(p_lease_seconds, 300), 30) || ' seconds')::interval;

  -- 1. Acquire targeted row FIRST using SELECT ... FOR UPDATE SKIP LOCKED.
  -- Includes company match, call recording READY status, and valid non-empty recording_path.
  -- If another connection holds a row lock on this target row (PENDING or PROCESSING),
  -- SKIP LOCKED returns zero rows promptly without blocking or statement timeouts.
  SELECT
    zct.id,
    zct.company_id,
    zct.call_id,
    zct.customer_id,
    zct.provider,
    zct.language,
    zct.raw_channel_layout,
    zct.status,
    zct.attempts,
    zct.max_attempts,
    zct.next_run_at,
    zct.lease_expires_at,
    zct.started_at,
    zpc.recording_path,
    zpc.audio_validation
  INTO v_job
  FROM public.zalo_call_transcriptions zct
  JOIN public.zalo_personal_calls zpc
    ON zpc.id = zct.call_id AND zpc.company_id = zct.company_id
  WHERE zct.id = p_transcription_id
    AND zct.company_id = p_company
    AND zpc.recording_status = 'READY'
    AND zpc.recording_path IS NOT NULL
    AND btrim(zpc.recording_path) <> ''
  FOR UPDATE OF zct SKIP LOCKED;

  -- If not selected (locked, wrong tenant, non-ready call, empty path, missing record)
  IF v_job.id IS NULL THEN
    RETURN;
  END IF;

  -- 2. Process only the acquired locked row based on its current status
  IF v_job.status = 'PENDING' THEN
    -- Check eligibility: must be due and not already exhausted
    IF v_job.next_run_at > now() OR v_job.attempts >= v_job.max_attempts THEN
      RETURN;
    END IF;

    v_new_lock_token := gen_random_uuid();

    UPDATE public.zalo_call_transcriptions zct
    SET status = 'PROCESSING',
        lock_token = v_new_lock_token,
        locked_by = COALESCE(p_locked_by, 'zalo_transcription_worker'),
        locked_at = now(),
        started_at = COALESCE(zct.started_at, now()),
        lease_expires_at = now() + v_lease_duration,
        updated_at = now()
    WHERE zct.id = v_job.id AND zct.company_id = v_job.company_id;

    UPDATE public.zalo_personal_calls zpc
    SET transcript_status = 'PROCESSING'
    WHERE zpc.id = v_job.call_id AND zpc.company_id = v_job.company_id;

    RETURN QUERY
    SELECT
      v_job.id,
      v_job.company_id,
      v_job.call_id,
      v_job.customer_id,
      v_job.provider,
      v_job.language,
      v_job.raw_channel_layout,
      v_job.attempts,
      v_job.max_attempts,
      v_new_lock_token AS lock_token,
      v_job.recording_path,
      v_job.audio_validation;
    RETURN;

  ELSIF v_job.status = 'PROCESSING' THEN
    -- Check if lease has expired
    IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at >= now() THEN
      -- Active lease held by another worker: cannot reclaim or claim
      RETURN;
    END IF;

    -- Expired lease: bound attempts to [0, 10] check constraint and max_attempts
    v_new_attempts := LEAST(v_job.attempts + 1, 10);

    IF v_new_attempts >= v_job.max_attempts THEN
      -- Exhausted attempts: fail closed to terminal FAILED state
      UPDATE public.zalo_call_transcriptions zct
      SET status = 'FAILED',
          completed_at = now(),
          error_code = 'EXPIRED_LEASE_MAX_ATTEMPTS',
          error_message = 'Lease expired and max attempts reached',
          lock_token = NULL,
          locked_by = NULL,
          locked_at = NULL,
          lease_expires_at = NULL,
          attempts = v_new_attempts,
          updated_at = now()
      WHERE zct.id = v_job.id AND zct.company_id = v_job.company_id;

      UPDATE public.zalo_personal_calls zpc
      SET transcript_status = 'FAILED'
      WHERE zpc.id = v_job.call_id AND zpc.company_id = v_job.company_id;

      -- Returns zero claimed
      RETURN;
    ELSE
      -- Reclaim and claim in one safe atomic operation with fresh token
      v_new_lock_token := gen_random_uuid();

      UPDATE public.zalo_call_transcriptions zct
      SET status = 'PROCESSING',
          lock_token = v_new_lock_token,
          locked_by = COALESCE(p_locked_by, 'zalo_transcription_worker'),
          locked_at = now(),
          started_at = COALESCE(zct.started_at, now()),
          lease_expires_at = now() + v_lease_duration,
          attempts = v_new_attempts,
          updated_at = now()
      WHERE zct.id = v_job.id AND zct.company_id = v_job.company_id;

      UPDATE public.zalo_personal_calls zpc
      SET transcript_status = 'PROCESSING'
      WHERE zpc.id = v_job.call_id AND zpc.company_id = v_job.company_id;

      RETURN QUERY
      SELECT
        v_job.id,
        v_job.company_id,
        v_job.call_id,
        v_job.customer_id,
        v_job.provider,
        v_job.language,
        v_job.raw_channel_layout,
        v_new_attempts AS attempts,
        v_job.max_attempts,
        v_new_lock_token AS lock_token,
        v_job.recording_path,
        v_job.audio_validation;
      RETURN;
    END IF;

  ELSE
    -- COMPLETED, FAILED, or any non-claimable status: do not touch row or updated_at
    RETURN;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_claim_transcription_job(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_transcription_job(uuid, uuid, text, integer) TO service_role;
