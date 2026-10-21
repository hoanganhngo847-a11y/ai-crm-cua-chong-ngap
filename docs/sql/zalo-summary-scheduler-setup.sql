-- ==============================================================================
-- Operations Setup: Zalo Call AI Summary Scheduler (pg_cron + pg_net + Vault)
-- File: docs/sql/zalo-summary-scheduler-setup.sql
--
-- PURPOSE:
--   Production-safe setup of recurring invocation for the Zalo call AI summary
--   worker (/api/cron/zalo-call-summary) using Supabase-native pg_cron, pg_net,
--   and Supabase Vault.
--
-- OPERATIONAL POLICIES & CONSTRAINTS:
--   1. RUNTIME RESTRICTION: Execute OUTSIDE automated migrations. Local PGlite
--      and CI environments do not support pg_net/pg_cron background workers.
--      Run manually by authorized database administrators in Supabase SQL Editor.
--   2. SETUP ONLY: Provisions private schema, helper function, bounded dispatch
--      history, and hardened ACLs. DOES NOT SCHEDULE ANY JOB.
--      Enabling is executed separately via zalo-summary-scheduler-enable.sql
--   3. ZERO SECRETS IN SQL / CRON COMMAND: Endpoint and bearer secret are NEVER
--      hardcoded or passed in cron.job.command. They are dynamically read at
--      runtime from Supabase Vault (vault.decrypted_secrets).
--   4. PRIVILEGE ISOLATION: The helper function lives in nonexposed schema
--      cron_internal with SECURITY DEFINER and search_path=''.
--      Execution is strictly revoked from PUBLIC, anon, authenticated, and service_role.
--      Executable strictly by postgres (and supabase_admin).
--   5. CONDITIONAL DISPATCH: Checks for eligible pending due summary jobs or expired
--      leases with linked COMPLETED transcription before calling net.http_post.
--      If no work is eligible, zero network requests occur.
-- ==============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE SCHEMA IF NOT EXISTS cron_internal;
REVOKE ALL ON SCHEMA cron_internal FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA cron_internal TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT USAGE ON SCHEMA cron_internal TO supabase_admin;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS cron_internal.zalo_summary_dispatch_history (
  request_id bigint PRIMARY KEY,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON cron_internal.zalo_summary_dispatch_history FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON cron_internal.zalo_summary_dispatch_history TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT ALL ON cron_internal.zalo_summary_dispatch_history TO supabase_admin;
  END IF;
END $$;

CREATE OR REPLACE VIEW cron_internal.zalo_summary_dispatch_status AS
SELECT
  d.request_id,
  r.status_code,
  r.timed_out,
  CASE
    WHEN r.id IS NULL THEN NULL
    ELSE (r.timed_out OR r.error_msg IS NOT NULL OR r.status_code IS NULL OR r.status_code >= 400)
  END AS has_error,
  d.dispatched_at AS created
FROM cron_internal.zalo_summary_dispatch_history d
LEFT JOIN net._http_response r ON r.id = d.request_id;

REVOKE ALL ON cron_internal.zalo_summary_dispatch_status FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON cron_internal.zalo_summary_dispatch_status TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT SELECT ON cron_internal.zalo_summary_dispatch_status TO supabase_admin;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION cron_internal.invoke_zalo_summary_cron()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_has_work boolean := false;
  v_endpoint text;
  v_secret text;
  v_request_id bigint;
BEGIN
  -- A. Guard check: only dispatch HTTP request if eligible work exists in queue.
  SELECT EXISTS (
    SELECT 1
    FROM public.zalo_call_ai_summaries zcas
    JOIN public.zalo_call_transcriptions zct
      ON zct.id = zcas.transcription_id
     AND zct.company_id = zcas.company_id
    WHERE zct.status = 'COMPLETED'
      AND (
        (
          zcas.status = 'PENDING'
          AND zcas.next_run_at <= now()
          AND zcas.attempts < zcas.max_attempts
        )
        OR
        (
          zcas.status = 'PROCESSING'
          AND zcas.lease_expires_at IS NOT NULL
          AND zcas.lease_expires_at < now()
        )
      )
  ) INTO v_has_work;

  IF NOT v_has_work THEN
    RETURN NULL;
  END IF;

  -- B. Read Vault secrets: check specific 'zalo_summary_*' first, fallback to 'zalo_transcription_*'
  SELECT decrypted_secret INTO v_endpoint
  FROM vault.decrypted_secrets
  WHERE name = 'zalo_summary_endpoint'
  LIMIT 1;

  IF v_endpoint IS NULL THEN
    SELECT regexp_replace(decrypted_secret, '/api/cron/zalo-transcription$', '/api/cron/zalo-call-summary')
    INTO v_endpoint
    FROM vault.decrypted_secrets
    WHERE name = 'zalo_transcription_endpoint'
    LIMIT 1;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'zalo_summary_cron_secret'
  LIMIT 1;

  IF v_secret IS NULL THEN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'zalo_transcription_cron_secret'
    LIMIT 1;
  END IF;

  -- C. Strict Vault validation
  IF v_secret IS NULL OR length(btrim(v_secret)) < 16 OR v_secret ~ '[\r\n]' THEN
    RAISE EXCEPTION 'INVALID_VAULT_SECRET_CONFIG';
  END IF;

  IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  v_endpoint := btrim(v_endpoint);

  IF v_endpoint ~ '[\s?#@]' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  IF v_endpoint !~ '^https://[a-zA-Z0-9.\-]+(?::[0-9]{1,5})?/api/cron/zalo-call-summary$' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  -- D. Dispatch non-blocking HTTP POST via pg_net
  SELECT net.http_post(
    url := v_endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || btrim(v_secret)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 250000
  ) INTO v_request_id;

  IF v_request_id IS NOT NULL THEN
    INSERT INTO cron_internal.zalo_summary_dispatch_history (request_id, dispatched_at)
    VALUES (v_request_id, now());

    DELETE FROM cron_internal.zalo_summary_dispatch_history
    WHERE request_id NOT IN (
      SELECT request_id
      FROM cron_internal.zalo_summary_dispatch_history
      ORDER BY dispatched_at DESC
      LIMIT 1000
    );
  END IF;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION cron_internal.invoke_zalo_summary_cron() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cron_internal.invoke_zalo_summary_cron() TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT EXECUTE ON FUNCTION cron_internal.invoke_zalo_summary_cron() TO supabase_admin;
  END IF;
END $$;

COMMIT;
