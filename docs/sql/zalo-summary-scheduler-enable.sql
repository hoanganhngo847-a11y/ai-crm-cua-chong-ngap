-- ==============================================================================
-- Operations Enable: Zalo Call AI Summary Scheduler (pg_cron)
-- File: docs/sql/zalo-summary-scheduler-enable.sql
--
-- PURPOSE:
--   Schedules recurring 1-minute execution of the cron job
--   'zalo-call-summary-worker' in pg_cron.
-- ==============================================================================

DO $$
DECLARE
  v_job_id bigint;
  v_has_pg_cron boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO v_has_pg_cron;
  IF NOT v_has_pg_cron THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Extension pg_cron is not installed. Run zalo-summary-scheduler-setup.sql first.';
  END IF;

  SELECT jobid INTO v_job_id
  FROM cron.job
  WHERE jobname = 'zalo-call-summary-worker';

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule(
    'zalo-call-summary-worker',
    '* * * * *',
    'SELECT cron_internal.invoke_zalo_summary_cron();'
  );
END $$;
