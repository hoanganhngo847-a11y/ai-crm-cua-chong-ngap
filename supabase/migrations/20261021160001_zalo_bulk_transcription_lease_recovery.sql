-- Migration: 20261021160001_zalo_bulk_transcription_lease_recovery.sql
-- Bulk transcription lease recovery and claiming wrapper over targeted claim RPC.
-- Replaces flawed bulk RPC that unconditionally reset expired PROCESSING to PENDING,
-- which caused attempts2/max3 rows to become stuck in PENDING forever and attempts10 to overflow.

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
  v_effective_limit integer;
  v_locked_by text;
  v_lease_seconds integer;
  v_claimed_count integer := 0;
  v_candidate record;
BEGIN
  -- Null/invalid p_limit clamped to [1, 50] preserving legacy contract
  v_effective_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_locked_by := COALESCE(p_locked_by, 'zalo_transcription_worker');
  v_lease_seconds := GREATEST(COALESCE(p_lease_seconds, 300), 30);

  -- Select due PENDING with attempts < max OR any expired PROCESSING,
  -- joined company + call READY / non-empty recording path,
  -- FOR UPDATE OF zct SKIP LOCKED, bounded scan (up to 50 candidates).
  FOR v_candidate IN
    SELECT zct.id, zct.company_id
    FROM public.zalo_call_transcriptions zct
    JOIN public.zalo_personal_calls zpc
      ON zpc.id = zct.call_id AND zpc.company_id = zct.company_id
    WHERE (
      (zct.status = 'PENDING' AND zct.next_run_at <= now() AND zct.attempts < zct.max_attempts)
      OR
      (zct.status = 'PROCESSING' AND zct.lease_expires_at IS NOT NULL AND zct.lease_expires_at < now())
    )
      AND zpc.recording_status = 'READY'
      AND zpc.recording_path IS NOT NULL
      AND btrim(zpc.recording_path) <> ''
    ORDER BY zct.next_run_at ASC, zct.created_at ASC
    FOR UPDATE OF zct SKIP LOCKED
    LIMIT 50
  LOOP
    EXIT WHEN v_claimed_count >= v_effective_limit;

    -- Call targeted claim RPC with server-derived company.
    -- Targeted RPC handles retry increments, atomic reclamation, and terminal exhaustion.
    RETURN QUERY
    SELECT *
    FROM public.zalo_claim_transcription_job(
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

REVOKE ALL ON FUNCTION public.zalo_claim_transcription_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_transcription_jobs(integer, text, integer) TO service_role;
