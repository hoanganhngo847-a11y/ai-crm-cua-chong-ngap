-- ==============================================================================
-- Operations Setup: AI Brain Live Messenger Scheduler (pg_cron + pg_net + Vault)
-- File: docs/sql/ai-brain-live-messenger-scheduler-setup.sql
--
-- PURPOSE:
--   Production-safe setup of recurring invocation for the AI Brain Live Messenger
--   worker (/api/cron/ai-brain-live-messenger) using Supabase-native pg_cron, pg_net,
--   and Supabase Vault.
--
-- OPERATIONAL POLICIES & CONSTRAINTS:
--   1. ZERO SECRETS IN SQL / CRON COMMAND: Endpoint and bearer secret are NEVER
--      hardcoded or passed in cron.job.command. They are dynamically read at
--      runtime from Supabase Vault (vault.decrypted_secrets) using names:
--      'ai_brain_live_messenger_endpoint' and 'ai_brain_live_messenger_cron_secret'
--      (with fallback to existing 'ai_brain_live_zalo_cron_secret' /
--      'zalo_transcription_cron_secret' and derived URL).
--   2. PRIVILEGE ISOLATION: The helper function lives in nonexposed schema
--      cron_internal with SECURITY DEFINER and search_path=''.
--      Execution is strictly revoked from PUBLIC, anon, authenticated, and service_role.
--      Executable strictly by postgres (and supabase_admin).
--   3. RELIABLE SANITIZED CORRELATION: Correlates pg_net request IDs via
--      cron_internal.ai_brain_live_messenger_dispatch_history and provides sanitized view
--      cron_internal.ai_brain_live_messenger_dispatch_status (request_id, status_code,
--      timed_out, has_error, created) without leaking raw headers, content, or errors.
--   4. CADENCE: Runs every minute (* * * * *) via job 'ai_brain_live_messenger_worker'.
--   5. SAFEGUARDS: Messenger company live OFF remains default across tenants.
--      No side effects on existing Zalo scheduler ('ai_brain_live_zalo_worker').
-- ==============================================================================

BEGIN;

-- 1. Ensure required extensions exist
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

-- 3. Create private bounded dispatch history table
CREATE TABLE IF NOT EXISTS cron_internal.ai_brain_live_messenger_dispatch_history (
  request_id bigint PRIMARY KEY,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON cron_internal.ai_brain_live_messenger_dispatch_history FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON cron_internal.ai_brain_live_messenger_dispatch_history TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT ALL ON cron_internal.ai_brain_live_messenger_dispatch_history TO supabase_admin;
  END IF;
END $$;

-- 4. Create sanitized dispatch monitoring view
CREATE OR REPLACE VIEW cron_internal.ai_brain_live_messenger_dispatch_status AS
SELECT
  d.request_id,
  r.status_code,
  r.timed_out,
  CASE
    WHEN r.id IS NULL THEN NULL
    ELSE (r.timed_out OR r.error_msg IS NOT NULL OR r.status_code IS NULL OR r.status_code >= 400)
  END AS has_error,
  d.dispatched_at AS created
FROM cron_internal.ai_brain_live_messenger_dispatch_history d
LEFT JOIN net._http_response r ON r.id = d.request_id;

REVOKE ALL ON cron_internal.ai_brain_live_messenger_dispatch_status FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON cron_internal.ai_brain_live_messenger_dispatch_status TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT SELECT ON cron_internal.ai_brain_live_messenger_dispatch_status TO supabase_admin;
  END IF;
END $$;

-- 5. Hardened Admin-Only Helper Function
CREATE OR REPLACE FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_endpoint text;
  v_secret text;
  v_request_id bigint;
BEGIN
  -- A. Read endpoint from Vault: check 'ai_brain_live_messenger_endpoint' first,
  -- fallback to derivation from 'ai_brain_live_zalo_endpoint' or 'zalo_transcription_endpoint' or default production URL.
  IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
    SELECT decrypted_secret INTO v_endpoint
    FROM vault.decrypted_secrets
    WHERE name = 'ai_brain_live_messenger_endpoint'
    LIMIT 1;

    IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
      SELECT regexp_replace(decrypted_secret, '/api/cron/[a-zA-Z0-9.\-]+(\?.*)?$', '/api/cron/ai-brain-live-messenger?limit=5')
      INTO v_endpoint
      FROM vault.decrypted_secrets
      WHERE name = 'ai_brain_live_zalo_endpoint'
      LIMIT 1;
    END IF;

    IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
      SELECT regexp_replace(decrypted_secret, '/api/cron/[a-zA-Z0-9.\-]+(\?.*)?$', '/api/cron/ai-brain-live-messenger?limit=5')
      INTO v_endpoint
      FROM vault.decrypted_secrets
      WHERE name = 'zalo_transcription_endpoint'
      LIMIT 1;
    END IF;

    -- B. Read bearer secret: check 'ai_brain_live_messenger_cron_secret' first,
    -- fallback to 'ai_brain_live_zalo_cron_secret', then 'zalo_transcription_cron_secret'.
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'ai_brain_live_messenger_cron_secret'
    LIMIT 1;

    IF v_secret IS NULL OR btrim(v_secret) = '' THEN
      SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets
      WHERE name = 'ai_brain_live_zalo_cron_secret'
      LIMIT 1;
    END IF;

    IF v_secret IS NULL OR btrim(v_secret) = '' THEN
      SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets
      WHERE name = 'zalo_transcription_cron_secret'
      LIMIT 1;
    END IF;
  END IF;

  -- Strictly fail closed: NO hard-coded production URL fallback.
  IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  -- C. Strict Vault validation: sanitized constant error codes, never leaking config details
  IF v_secret IS NULL OR length(btrim(v_secret)) < 16 OR v_secret ~ '[\r\n]' THEN
    RAISE EXCEPTION 'INVALID_VAULT_SECRET_CONFIG';
  END IF;

  v_endpoint := btrim(v_endpoint);

  IF v_endpoint ~ '[\s#@]' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  IF v_endpoint !~ '^https://[a-zA-Z0-9.\-]+(?::[0-9]{1,5})?/api/cron/ai-brain-live-messenger(\?limit=[0-9]+)?$' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  -- D. Dispatch non-blocking HTTP POST via pg_net (timeout: 60s)
  SELECT net.http_post(
    url := v_endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || btrim(v_secret)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  -- E. Record in bounded dispatch history for reliable sanitized correlation
  IF v_request_id IS NOT NULL THEN
    INSERT INTO cron_internal.ai_brain_live_messenger_dispatch_history (request_id, dispatched_at)
    VALUES (v_request_id, now())
    ON CONFLICT (request_id) DO UPDATE SET dispatched_at = EXCLUDED.dispatched_at;

    -- Prune history to keep bounded (retain latest 500 entries)
    DELETE FROM cron_internal.ai_brain_live_messenger_dispatch_history
    WHERE request_id NOT IN (
      SELECT request_id
      FROM cron_internal.ai_brain_live_messenger_dispatch_history
      ORDER BY dispatched_at DESC
      LIMIT 500
    );
  END IF;

  RETURN v_request_id;
END;
$$;

-- 6. Lock down helper function permissions
REVOKE ALL ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() FROM PUBLIC;
REVOKE ALL ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT EXECUTE ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() TO supabase_admin;
  END IF;
END $$;

-- 7. Schedule recurring 1-minute cron job in pg_cron
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai_brain_live_messenger_worker') THEN
    PERFORM cron.unschedule('ai_brain_live_messenger_worker');
  END IF;

  PERFORM cron.schedule(
    'ai_brain_live_messenger_worker',
    '* * * * *',
    'SELECT cron_internal.invoke_ai_brain_live_messenger_cron();'
  );
END $$;

COMMIT;
