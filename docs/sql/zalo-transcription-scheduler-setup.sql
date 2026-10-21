-- ==============================================================================
-- Operations Setup: Zalo Transcription Scheduler (pg_cron + pg_net + Vault)
-- File: docs/sql/zalo-transcription-scheduler-setup.sql
--
-- PURPOSE:
--   Production-safe setup of recurring invocation for the Zalo call transcription
--   worker (/api/cron/zalo-transcription) using Supabase-native pg_cron, pg_net,
--   and Supabase Vault.
--
-- OPERATIONAL POLICIES & CONSTRAINTS:
--   1. RUNTIME RESTRICTION: Execute OUTSIDE automated migrations. Local PGlite
--      and CI environments do not support pg_net/pg_cron background workers.
--      Run manually by authorized database administrators in Supabase SQL Editor.
--   2. SETUP ONLY: Provisions extensions, private schema, helper function,
--      bounded dispatch history, and hardened ACLs. DOES NOT SCHEDULE ANY JOB.
--      Enabling is executed separately via zalo-transcription-scheduler-enable.sql
--      only after migrations, PR merge, deployment, and single-target validation.
--   3. ZERO SECRETS IN SQL / CRON COMMAND: Endpoint and bearer secret are NEVER
--      hardcoded or passed in cron.job.command. They are dynamically read at
--      runtime from Supabase Vault (vault.decrypted_secrets) using EXACT names:
--      'zalo_transcription_endpoint' and 'zalo_transcription_cron_secret'.
--   4. PRIVILEGE ISOLATION: The helper function lives in nonexposed schema
--      cron_internal with SECURITY DEFINER and search_path=''.
--      Execution is strictly revoked from PUBLIC, anon, authenticated, and service_role.
--      Executable strictly by postgres (and supabase_admin).
--   5. CONDITIONAL DISPATCH: Checks for eligible pending due jobs (with remaining
--      attempt budget) or expired processing leases with linked READY recording
--      before calling net.http_post. Expired leases are included regardless of attempt
--      count so bulk claim RPC can reclaim or transition exhausted jobs to FAILED.
--      If no work is eligible, zero network requests occur.
--   6. TRANSACTIONAL SETUP & MANAGED NET ACL BOUNDARY: Entire setup executes within
--      a single transaction (BEGIN ... COMMIT). In managed Supabase, pg_net extension
--      objects are owned by supabase_admin. REVOKE statements executed by postgres
--      are best-effort defense-in-depth and cannot strip default permissions granted
--      by supabase_admin to PUBLIC; setup inspects effective privileges and emits a
--      sanitized constant notice if default managed permissions remain.
--      Security relies on PostgREST Data API exclusion (406 PGRST106) and NOLOGIN
--      enforcement on anon and authenticated roles.
--      Privilege isolation for cron_internal objects is strictly fail-closed.
--   7. RELIABLE SANITIZED CORRELATION: Correlates pg_net request IDs via
--      cron_internal.zalo_transcription_dispatch_history and provides sanitized view
--      cron_internal.zalo_transcription_dispatch_status (request_id, status_code,
--      timed_out, has_error, created) without leaking raw headers, content, or errors.
--      Missing response records return has_error = NULL (unknown/in-flight).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- STEP 1 & 2: Fully Transactional Setup (Extensions, Schema, ACLs & Helper)
-- ------------------------------------------------------------------------------
BEGIN;

-- 1. Enable Required Extensions Idempotently within Transaction
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Create nonexposed private schema
CREATE SCHEMA IF NOT EXISTS cron_internal;
REVOKE ALL ON SCHEMA cron_internal FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA cron_internal TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT USAGE ON SCHEMA cron_internal TO supabase_admin;
  END IF;
END $$;

-- 3. Drop obsolete public helper if previously created
DROP FUNCTION IF EXISTS public.invoke_zalo_transcription_cron();

-- 4. Create private bounded dispatch history table for reliable request correlation
-- (pg_cron job_run_details return_message only shows '1 row' or 'SELECT 1')
CREATE TABLE IF NOT EXISTS cron_internal.zalo_transcription_dispatch_history (
  request_id bigint PRIMARY KEY,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON cron_internal.zalo_transcription_dispatch_history FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON cron_internal.zalo_transcription_dispatch_history TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT ALL ON cron_internal.zalo_transcription_dispatch_history TO supabase_admin;
  END IF;
END $$;

-- 5. Create sanitized dispatch monitoring view
-- Strictly omits raw error_msg, headers, url, and content for privacy & secret protection.
-- Missing response yields has_error = NULL (in-flight/pending); real response uses booleans.
CREATE OR REPLACE VIEW cron_internal.zalo_transcription_dispatch_status AS
SELECT
  d.request_id,
  r.status_code,
  r.timed_out,
  CASE
    WHEN r.id IS NULL THEN NULL
    ELSE (r.timed_out OR r.error_msg IS NOT NULL OR r.status_code IS NULL OR r.status_code >= 400)
  END AS has_error,
  d.dispatched_at AS created
FROM cron_internal.zalo_transcription_dispatch_history d
LEFT JOIN net._http_response r ON r.id = d.request_id;

REVOKE ALL ON cron_internal.zalo_transcription_dispatch_status FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON cron_internal.zalo_transcription_dispatch_status TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT SELECT ON cron_internal.zalo_transcription_dispatch_status TO supabase_admin;
  END IF;
END $$;

-- 6. Hardened Admin-Only Helper Function
CREATE OR REPLACE FUNCTION cron_internal.invoke_zalo_transcription_cron()
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
  -- Validates linked call company match, READY recording status, and non-empty recording_path.
  -- Pending branch respects attempt budget; expired processing branch includes all expired
  -- leases so bulk/targeted claim RPC can reclaim or terminalize exhausted attempts to FAILED.
  SELECT EXISTS (
    SELECT 1
    FROM public.zalo_call_transcriptions zct
    JOIN public.zalo_personal_calls zpc
      ON zpc.id = zct.call_id
     AND zpc.company_id = zct.company_id
    WHERE zpc.recording_status = 'READY'
      AND zpc.recording_path IS NOT NULL
      AND btrim(zpc.recording_path) <> ''
      AND (
        -- Pending due job with remaining attempt budget
        (
          zct.status = 'PENDING'
          AND zct.next_run_at <= now()
          AND zct.attempts < zct.max_attempts
        )
        OR
        -- Expired processing job: bulk RPC reclaims or terminalizes exhausted attempts to FAILED
        (
          zct.status = 'PROCESSING'
          AND zct.lease_expires_at IS NOT NULL
          AND zct.lease_expires_at < now()
        )
      )
  ) INTO v_has_work;

  -- If no queue items are eligible for processing, return immediately without network call
  IF NOT v_has_work THEN
    RETURN NULL;
  END IF;

  -- B. Read EXACT Vault secret names (no generic fallbacks)
  SELECT decrypted_secret INTO v_endpoint
  FROM vault.decrypted_secrets
  WHERE name = 'zalo_transcription_endpoint'
  LIMIT 1;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'zalo_transcription_cron_secret'
  LIMIT 1;

  -- C. Strict Vault validation: sanitized constant error codes, never leaking config details
  IF v_secret IS NULL OR length(btrim(v_secret)) < 16 OR v_secret ~ '[\r\n]' THEN
    RAISE EXCEPTION 'INVALID_VAULT_SECRET_CONFIG';
  END IF;

  IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  v_endpoint := btrim(v_endpoint);

  -- Reject query parameters, fragments, userinfo, and whitespace
  IF v_endpoint ~ '[\s?#@]' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  -- Enforce exact HTTPS endpoint /api/cron/zalo-transcription
  IF v_endpoint !~ '^https://[a-zA-Z0-9.\-]+(?::[0-9]{1,5})?/api/cron/zalo-transcription$' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  -- D. Dispatch non-blocking HTTP POST via pg_net
  -- Timeout set to 250,000ms (~250s) to provide headroom for Next.js worker 240,000ms duration
  SELECT net.http_post(
    url := v_endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || btrim(v_secret)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 250000
  ) INTO v_request_id;

  -- E. Record in bounded dispatch history for reliable sanitized correlation
  IF v_request_id IS NOT NULL THEN
    INSERT INTO cron_internal.zalo_transcription_dispatch_history (request_id, dispatched_at)
    VALUES (v_request_id, now())
    ON CONFLICT (request_id) DO UPDATE SET dispatched_at = EXCLUDED.dispatched_at;

    -- Prune history to keep bounded (retain latest 500 entries)
    DELETE FROM cron_internal.zalo_transcription_dispatch_history
    WHERE request_id NOT IN (
      SELECT request_id
      FROM cron_internal.zalo_transcription_dispatch_history
      ORDER BY dispatched_at DESC
      LIMIT 500
    );
  END IF;

  RETURN v_request_id;
END;
$$;

-- 7. Lock down helper function permissions
REVOKE ALL ON FUNCTION cron_internal.invoke_zalo_transcription_cron() FROM PUBLIC;
REVOKE ALL ON FUNCTION cron_internal.invoke_zalo_transcription_cron() FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cron_internal.invoke_zalo_transcription_cron() TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT EXECUTE ON FUNCTION cron_internal.invoke_zalo_transcription_cron() TO supabase_admin;
  END IF;
END $$;

-- 8. Harden pg_net Schema and Tables (Best-Effort Defense-in-Depth)
-- Note: In managed Supabase, pg_net objects are owned by supabase_admin.
-- When executed as postgres (non-superuser), REVOKE statements cannot strip privileges
-- granted by the extension owner (supabase_admin) to PUBLIC, resulting in standard PostgreSQL
-- warnings. These REVOKEs are retained as defense-in-depth without swallowing real errors.
-- Protection against unauthorized access is guaranteed by PostgREST Data API exclusion
-- (Accept-Profile: net returns HTTP 406 PGRST106) and anon/authenticated NOLOGIN.
REVOKE ALL ON SCHEMA net FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA net FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA net FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA net FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE ALL ON ROUTINES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

-- Explicitly revoke column privileges if any were granted (errors strictly abort transaction)
DO $$
DECLARE
  r RECORD;
  v_grantee text;
BEGIN
  FOR r IN
    SELECT grantee, table_schema, table_name, column_name, privilege_type
    FROM information_schema.column_privileges
    WHERE table_schema = 'net'
      AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  LOOP
    IF r.grantee = 'PUBLIC' THEN
      v_grantee := 'PUBLIC';
    ELSE
      v_grantee := quote_ident(r.grantee);
    END IF;
    EXECUTE format('REVOKE %s (%I) ON TABLE %I.%I FROM %s', r.privilege_type, r.column_name, r.table_schema, r.table_name, v_grantee);
  END LOOP;
END $$;

-- Preserve standard admin and privileged service_role usage without breaking existing integrations
GRANT USAGE ON SCHEMA net TO postgres, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres;
GRANT ALL ON ALL ROUTINES IN SCHEMA net TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT USAGE ON SCHEMA net TO supabase_admin;
    GRANT ALL ON ALL TABLES IN SCHEMA net TO supabase_admin;
    GRANT ALL ON ALL ROUTINES IN SCHEMA net TO supabase_admin;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO supabase_admin;
  END IF;
END $$;

-- 9. Setup Security Assertions (Fail-Closed Isolation & Managed Permissions Inspection)
DO $$
BEGIN
  -- A. Assert anon and authenticated cannot login directly (NOLOGIN enforcement)
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated')
      AND rolcanlogin = true
  ) THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: Untrusted database role (anon or authenticated) has LOGIN privilege.';
  END IF;

  -- B. Assert private schema cron_internal isolation (Fail-Closed)
  IF has_schema_privilege('anon', 'cron_internal', 'usage')
     OR has_schema_privilege('authenticated', 'cron_internal', 'usage')
     OR has_schema_privilege('service_role', 'cron_internal', 'usage')
     OR has_schema_privilege('public', 'cron_internal', 'usage') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: Unprivileged role has USAGE access on schema cron_internal.';
  END IF;

  -- C. Assert private dispatch history table isolation (Fail-Closed)
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_privileges
    WHERE table_schema = 'cron_internal'
      AND table_name = 'zalo_transcription_dispatch_history'
      AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ) THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: Unprivileged role has table grant on cron_internal.zalo_transcription_dispatch_history.';
  END IF;

  -- D. Assert private dispatch status view isolation (Fail-Closed)
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_privileges
    WHERE table_schema = 'cron_internal'
      AND table_name = 'zalo_transcription_dispatch_status'
      AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ) THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: Unprivileged role has table/view grant on cron_internal.zalo_transcription_dispatch_status.';
  END IF;

  -- E. Assert helper function execution isolation (postgres/admin only, Fail-Closed)
  IF NOT has_function_privilege('postgres', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: postgres role lacks EXECUTE privilege on cron_internal.invoke_zalo_transcription_cron().';
  END IF;

  IF has_function_privilege('anon', 'cron_internal.invoke_zalo_transcription_cron()', 'execute')
     OR has_function_privilege('authenticated', 'cron_internal.invoke_zalo_transcription_cron()', 'execute')
     OR has_function_privilege('service_role', 'cron_internal.invoke_zalo_transcription_cron()', 'execute')
     OR has_function_privilege('public', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') THEN
    RAISE EXCEPTION 'SECURITY_VIOLATION: Unprivileged role has EXECUTE privilege on cron_internal.invoke_zalo_transcription_cron().';
  END IF;

  -- F. Inspect effective pg_net privileges: emit constant sanitized NOTICE if managed permissions remain
  -- (Do NOT raise exception: managed Supabase defaults retain owner-granted permissions from supabase_admin)
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_privileges
    WHERE table_schema = 'net'
      AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  ) THEN
    RAISE NOTICE 'MANAGED_EXTENSION_NOTICE: pg_net extension objects retain default managed privileges granted by supabase_admin (mitigated by PostgREST Data API exposure boundary and anon/authenticated NOLOGIN).';
  END IF;
END $$;

COMMIT;

-- ------------------------------------------------------------------------------
-- STEP 3: Verification & Post-Setup Inspection Queries (Read-Only)
-- ------------------------------------------------------------------------------
-- Run the following queries to verify proper installation and security posture:

-- 1. Verify extensions are present
SELECT extname, extversion
FROM pg_catalog.pg_extension
WHERE extname IN ('vault', 'supabase_vault', 'pg_cron', 'pg_net')
ORDER BY extname;

-- 2. Verify function execution privilege isolation (must show true for postgres, false for public/anon/authenticated/service_role)
SELECT
  has_function_privilege('postgres', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') AS postgres_can_execute,
  has_function_privilege('anon', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') AS anon_can_execute,
  has_function_privilege('authenticated', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') AS authenticated_can_execute,
  has_function_privilege('service_role', 'cron_internal.invoke_zalo_transcription_cron()', 'execute') AS service_role_can_execute;

-- 3. Verify private schema isolation for cron_internal (must return 0 rows for untrusted roles)
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'cron_internal'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role');

-- 4. Inspect effective permissions on net schema tables
-- In managed Supabase, owner-granted privileges from supabase_admin to PUBLIC may remain.
-- This is expected and safe: net is not exposed in PostgREST Data API, and anon/authenticated have NOLOGIN.
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'net'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY table_name, grantee, privilege_type;

-- 5. Verify untrusted roles have NOLOGIN (rolcanlogin must be false)
SELECT rolname, rolcanlogin
FROM pg_roles
WHERE rolname IN ('anon', 'authenticated')
ORDER BY rolname;

-- 6. Verify Vault secret entry presence WITHOUT exposing decrypted values
SELECT name, description, created_at, updated_at
FROM vault.decrypted_secrets
WHERE name IN ('zalo_transcription_endpoint', 'zalo_transcription_cron_secret');
