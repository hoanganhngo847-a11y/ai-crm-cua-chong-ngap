-- ==============================================================================
-- Operations Disable: Zalo Call AI Summary Scheduler (pg_cron)
-- File: docs/sql/zalo-summary-scheduler-disable.sql
--
-- PURPOSE:
--   Disables recurring execution by unscheduling 'zalo-call-summary-worker'.
-- ==============================================================================

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id
  FROM cron.job
  WHERE jobname = 'zalo-call-summary-worker';

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;
END $$;
