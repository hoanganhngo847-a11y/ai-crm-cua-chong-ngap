-- ==============================================================================
-- Operations Disable: Zalo Transcription Scheduler (pg_cron)
-- File: docs/sql/zalo-transcription-scheduler-disable.sql
--
-- PURPOSE:
--   Idempotently disables and removes ONLY the 'zalo-transcription-worker'
--   job from pg_cron.
--
-- OPERATIONAL POLICIES:
--   1. TARGET ISOLATION: Unschedule strictly touches 'zalo-transcription-worker'.
--      All other existing or unrelated scheduled cron jobs remain intact.
--   2. IDEMPOTENT: Safe to run multiple times. If the job is already inactive
--      or not present, it completes without error.
--   3. RUNTIME RESTRICTION: Execute OUTSIDE automated migrations directly in
--      the Supabase SQL Editor or psql by authorized administrators.
-- ==============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'zalo-transcription-worker') THEN
    PERFORM cron.unschedule('zalo-transcription-worker');
    RAISE NOTICE 'Scheduled job zalo-transcription-worker has been unscheduled successfully.';
  ELSE
    RAISE NOTICE 'Scheduled job zalo-transcription-worker was not found (already disabled).';
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- Post-Disable Verification Query
-- ------------------------------------------------------------------------------
-- Verify that 'zalo-transcription-worker' is no longer registered:
SELECT
  count(*) AS remaining_zalo_cron_jobs
FROM cron.job
WHERE jobname = 'zalo-transcription-worker';
