-- Migration: 20261023180000_ai_channel_scheduler_health_rpc.sql
-- Description: Authorized sanitized server RPC to retrieve per-channel scheduler health
--
-- Invariants:
-- - Retrieves sanitized dispatch status and cron job presence/active/schedule per channel ('ZALO' or 'MESSENGER').
-- - Strictly isolates private schema cron_internal from direct client access.
-- - search_path is locked down to empty string ('') with SECURITY DEFINER.
-- - Dynamically guards against nonexistent cron.job and views using to_regclass (defer read until available).
-- - Zero credential, header, payload, or secret command leaks (only returns request_id, status_code, timed_out, has_error, created).
-- - Accessible STRICTLY to service_role. Revoked from PUBLIC, anon, and authenticated.
-- - Unused synonym get_ai_scheduler_dispatch_status removed.

-- Drop any previous signatures or synonyms
DROP FUNCTION IF EXISTS public.get_ai_scheduler_dispatch_status(text, integer);
DROP FUNCTION IF EXISTS public.get_ai_channel_scheduler_health(text, integer);

CREATE OR REPLACE FUNCTION public.get_ai_channel_scheduler_health(
  p_channel text,
  p_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_norm_channel text;
  v_job_name text;
  v_view_name text;
  v_limit integer;
  v_job_exists boolean := NULL;
  v_job_active boolean := NULL;
  v_job_schedule text := NULL;
  v_runs jsonb := '[]'::jsonb;
  v_ext_available boolean := false;
  v_view_available boolean := false;
BEGIN
  IF p_channel IS NULL THEN
    RAISE EXCEPTION 'INVALID_CHANNEL';
  END IF;

  v_norm_channel := upper(trim(p_channel));
  v_limit := COALESCE(p_limit, 10);
  IF v_limit < 1 THEN
    v_limit := 1;
  ELSIF v_limit > 50 THEN
    v_limit := 50;
  END IF;

  IF v_norm_channel = 'ZALO' THEN
    v_job_name := 'ai_brain_live_zalo_worker';
    v_view_name := 'cron_internal.ai_brain_live_zalo_dispatch_status';
  ELSIF v_norm_channel = 'MESSENGER' THEN
    v_job_name := 'ai_brain_live_messenger_worker';
    v_view_name := 'cron_internal.ai_brain_live_messenger_dispatch_status';
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_CHANNEL';
  END IF;

  -- 1. Query cron.job guarded with exact constant jobname per channel
  IF to_regclass('cron.job') IS NOT NULL THEN
    v_ext_available := true;
    EXECUTE format(
      'SELECT true, active, schedule
       FROM cron.job
       WHERE jobname = %L
       LIMIT 1',
      v_job_name
    ) INTO v_job_exists, v_job_active, v_job_schedule;

    IF v_job_exists IS NULL THEN
      v_job_exists := false;
      v_job_active := false;
      v_job_schedule := NULL;
    END IF;
  ELSE
    -- Missing pg_cron extension: explicit unknown
    v_ext_available := false;
    v_job_exists := NULL;
    v_job_active := NULL;
    v_job_schedule := NULL;
  END IF;

  -- 2. Query dispatch status view guarded
  -- Zero secrets returned: only request_id, status_code, timed_out, has_error, created
  IF to_regclass(v_view_name) IS NOT NULL THEN
    v_view_available := true;
    EXECUTE format(
      'SELECT coalesce(jsonb_agg(r), ''[]''::jsonb)
       FROM (
         SELECT request_id, status_code, timed_out, has_error, created
         FROM %s
         ORDER BY created DESC
         LIMIT %L
       ) r',
      v_view_name,
      v_limit
    ) INTO v_runs;
  ELSE
    v_view_available := false;
    v_runs := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'channel', v_norm_channel,
    'job_name', v_job_name,
    'job_exists', v_job_exists,
    'job_active', v_job_active,
    'job_schedule', v_job_schedule,
    'extension_available', v_ext_available,
    'view_available', v_view_available,
    'runs', v_runs
  );
END;
$$;

-- Strict Service-Role Only ACL: Revoke from PUBLIC, anon, and authenticated
REVOKE ALL ON FUNCTION public.get_ai_channel_scheduler_health(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_channel_scheduler_health(text, integer) TO service_role;
