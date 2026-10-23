-- ==============================================================================
-- Operations Disable: AI Brain Live Messenger Scheduler (pg_cron)
-- File: docs/sql/ai-brain-live-messenger-scheduler-disable.sql
--
-- PURPOSE:
--   Idempotently disables and removes ONLY the 'ai_brain_live_messenger_worker'
--   job from pg_cron without affecting other cron jobs (e.g., Zalo, transcription).
-- ==============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai_brain_live_messenger_worker') THEN
    PERFORM cron.unschedule('ai_brain_live_messenger_worker');
    RAISE NOTICE 'Cron job ai_brain_live_messenger_worker unscheduled successfully.';
  ELSE
    RAISE NOTICE 'Cron job ai_brain_live_messenger_worker was not scheduled.';
  END IF;
END $$;
