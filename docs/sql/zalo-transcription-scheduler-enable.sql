-- ==============================================================================
-- Operations Enable: Zalo Transcription Scheduler (pg_cron)
-- File: docs/sql/zalo-transcription-scheduler-enable.sql
--
-- PURPOSE:
--   Idempotently registers and activates the 1-minute recurring cron job
--   'zalo-transcription-worker' in pg_cron.
--
-- OPERATIONAL PRECONDITIONS & POLICIES:
--   1. RUNTIME RESTRICTION: Execute OUTSIDE automated migrations directly in
--      the Supabase SQL Editor or psql by authorized administrators.
--   2. DEPLOYMENT DEPENDENCY: Do NOT run this script before application code
--      and schema migrations have been deployed and verified in production.
--      Rollout order:
--        Gate 1: Code Review & Local Test Pass
--        Gate 2: Apply NEW Migrations in Order:
--                1. 20261021160000_zalo_targeted_transcription_claim.sql
--                2. 20261021160001_zalo_bulk_transcription_lease_recovery.sql
--                (Do NOT re-run already-applied baseline migrations)
--        Gate 3: Production DB Schema & RPC Verification
--        Gate 4: PR CI & Quality Gate Pass
--        Gate 5: Authorized Merge & Render Deploy
--        Gate 6: Supabase Dashboard Vault Entry
--        Gate 7: Operations Setup SQL (leaves job OFF)
--        Gate 8: Controlled Single-Target Validation (strictly 1 new call)
--        Gate 9: Enable Automated Scheduler (this script)
--        Gate 10: Queue & Dispatch Monitoring
--   3. DEEP PREREQUISITE VALIDATION: Validates extension presence, helper function
--      ACLs, BOTH new claim RPCs (targeted claim 160000 + bulk lease recovery 160001),
--      bulk wrapper behavior readiness via pg_get_functiondef (zero queue invocation),
--      and actual Vault configuration VALUES (valid HTTPS URL format and minimum secret strength).
--   4. ZERO SECRETS IN COMMAND: The cron command is strictly:
--        SELECT cron_internal.invoke_zalo_transcription_cron();
--      Zero bearer tokens, zero URLs, and zero headers are stored in cron.job.
--   5. IDEMPOTENT: If 'zalo-transcription-worker' is already registered, it is
--      unscheduled and cleanly recreated with the canonical configuration.
-- ==============================================================================

DO $$
DECLARE
  v_has_pg_cron boolean;
  v_has_pg_net boolean;
  v_has_target_rpc boolean;
  v_has_bulk_rpc boolean;
  v_bulk_wraps_target boolean;
  v_has_fn boolean;
  v_endpoint text;
  v_secret text;
BEGIN
  -- 1. Verify extension prerequisites
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO v_has_pg_cron;
  IF NOT v_has_pg_cron THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Extension pg_cron is not installed. Run zalo-transcription-scheduler-setup.sql first.';
  END IF;

  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_net') INTO v_has_pg_net;
  IF NOT v_has_pg_net THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Extension pg_net is not installed. Run zalo-transcription-scheduler-setup.sql first.';
  END IF;

  -- 2. Verify target claim RPC exists in public schema (Migration 20261021160000)
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'zalo_claim_transcription_job'
      AND pg_get_function_identity_arguments(p.oid) = 'p_company uuid, p_transcription_id uuid, p_locked_by text, p_lease_seconds integer'
  ) INTO v_has_target_rpc;

  IF NOT v_has_target_rpc THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Target claim RPC public.zalo_claim_transcription_job(uuid, uuid, text, integer) does not exist. Apply migration 20261021160000 first.';
  END IF;

  -- 3. Verify bulk claim RPC exists in public schema (Migration 20261021160001)
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'zalo_claim_transcription_jobs'
      AND pg_get_function_identity_arguments(p.oid) = 'p_limit integer, p_locked_by text, p_lease_seconds integer'
  ) INTO v_has_bulk_rpc;

  IF NOT v_has_bulk_rpc THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Bulk claim RPC public.zalo_claim_transcription_jobs(integer, text, integer) does not exist. Apply migration 20261021160001 first.';
  END IF;

  -- 4. Validate bulk RPC readiness via pg_get_functiondef (must wrap targeted RPC without invoking queue)
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'zalo_claim_transcription_jobs'
      AND pg_get_functiondef(p.oid) LIKE '%zalo_claim_transcription_job(%'
  ) INTO v_bulk_wraps_target;

  IF NOT v_bulk_wraps_target THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Bulk claim RPC does not wrap targeted claim RPC. Ensure migration 20261021160001 is applied.';
  END IF;

  -- 5. Verify claim RPC execution privileges
  IF NOT has_function_privilege('service_role', 'public.zalo_claim_transcription_job(uuid, uuid, text, integer)', 'execute') THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: service_role lacks execute privilege on public.zalo_claim_transcription_job.';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.zalo_claim_transcription_jobs(integer, text, integer)', 'execute') THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: service_role lacks execute privilege on public.zalo_claim_transcription_jobs.';
  END IF;

  -- 6. Verify helper function exists in private schema
  SELECT EXISTS(
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'cron_internal' AND p.proname = 'invoke_zalo_transcription_cron'
  ) INTO v_has_fn;

  IF NOT v_has_fn THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Function cron_internal.invoke_zalo_transcription_cron() does not exist. Run zalo-transcription-scheduler-setup.sql first.';
  END IF;

  -- 7. Verify helper function ACL prerequisites
  IF NOT has_function_privilege('postgres', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: postgres lacks execute privilege on cron_internal.invoke_zalo_transcription_cron().';
  END IF;

  IF has_function_privilege('anon', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: anon has execute privilege on cron_internal.invoke_zalo_transcription_cron().';
  END IF;

  IF has_function_privilege('authenticated', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: authenticated has execute privilege on cron_internal.invoke_zalo_transcription_cron().';
  END IF;

  IF has_function_privilege('service_role', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: service_role has execute privilege on cron_internal.invoke_zalo_transcription_cron().';
  END IF;

  -- 8. Validate Vault configuration VALUES (not merely row presence)
  SELECT decrypted_secret INTO v_endpoint
  FROM vault.decrypted_secrets
  WHERE name = 'zalo_transcription_endpoint'
  LIMIT 1;

  IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Vault entry zalo_transcription_endpoint is missing or empty. Configure via Supabase Dashboard Vault.';
  END IF;

  v_endpoint := btrim(v_endpoint);

  IF v_endpoint ~ '[\s?#@]' THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Vault entry zalo_transcription_endpoint contains forbidden characters (whitespace, query, fragment, or userinfo).';
  END IF;

  IF v_endpoint !~ '^https://[a-zA-Z0-9.\-]+(?::[0-9]{1,5})?/api/cron/zalo-transcription$' THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Vault entry zalo_transcription_endpoint must be a valid HTTPS URL ending with /api/cron/zalo-transcription.';
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'zalo_transcription_cron_secret'
  LIMIT 1;

  IF v_secret IS NULL OR length(btrim(v_secret)) < 16 OR v_secret ~ '[\r\n]' THEN
    RAISE EXCEPTION 'PREREQUISITE_FAILED: Vault entry zalo_transcription_cron_secret is missing, shorter than 16 characters, or contains newlines.';
  END IF;

  -- 9. Idempotently unschedule existing job if present
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'zalo-transcription-worker') THEN
    PERFORM cron.unschedule('zalo-transcription-worker');
    RAISE NOTICE 'Existing job zalo-transcription-worker unscheduled for clean re-registration.';
  END IF;

  -- 10. Schedule 1-minute recurring job with command-only helper call
  PERFORM cron.schedule(
    'zalo-transcription-worker',
    '* * * * *',
    'SELECT cron_internal.invoke_zalo_transcription_cron();'
  );

  RAISE NOTICE 'Scheduled job zalo-transcription-worker created successfully (* * * * *).';
END $$;

-- ------------------------------------------------------------------------------
-- Post-Enable Verification Query
-- ------------------------------------------------------------------------------
-- Verify the job is active and configured with zero secrets in cron.job:
SELECT
  jobid,
  jobname,
  schedule,
  active,
  command
FROM cron.job
WHERE jobname = 'zalo-transcription-worker';
