-- Migration: AI Brain Live Zalo Scheduler
-- Safe recurring invocation of /api/cron/ai-brain-live-zalo using pg_cron, pg_net, and Supabase Vault.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_net;
  END IF;
END $$;

-- 1. Ensure private non-exposed schema cron_internal exists
CREATE SCHEMA IF NOT EXISTS cron_internal;
REVOKE ALL ON SCHEMA cron_internal FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA cron_internal TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT USAGE ON SCHEMA cron_internal TO supabase_admin;
  END IF;
END $$;

-- 2. Create private bounded dispatch history table
CREATE TABLE IF NOT EXISTS cron_internal.ai_brain_live_zalo_dispatch_history (
  request_id bigint PRIMARY KEY,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON cron_internal.ai_brain_live_zalo_dispatch_history FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON cron_internal.ai_brain_live_zalo_dispatch_history TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT ALL ON cron_internal.ai_brain_live_zalo_dispatch_history TO supabase_admin;
  END IF;
END $$;

-- 3. Create sanitized dispatch monitoring view if net._http_response is present
DO $$
BEGIN
  IF to_regclass('net._http_response') IS NOT NULL THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW cron_internal.ai_brain_live_zalo_dispatch_status AS
      SELECT
        d.request_id,
        r.status_code,
        r.timed_out,
        CASE
          WHEN r.id IS NULL THEN NULL
          ELSE (r.timed_out OR r.error_msg IS NOT NULL OR r.status_code IS NULL OR r.status_code >= 400)
        END AS has_error,
        d.dispatched_at AS created
      FROM cron_internal.ai_brain_live_zalo_dispatch_history d
      LEFT JOIN net._http_response r ON r.id = d.request_id;
    $view$;

    REVOKE ALL ON cron_internal.ai_brain_live_zalo_dispatch_status FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT ON cron_internal.ai_brain_live_zalo_dispatch_status TO postgres;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
      GRANT SELECT ON cron_internal.ai_brain_live_zalo_dispatch_status TO supabase_admin;
    END IF;
  END IF;
END $$;

-- 4. Hardened Admin-Only Helper Function
CREATE OR REPLACE FUNCTION cron_internal.invoke_ai_brain_live_zalo_cron()
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
  -- A. Read endpoint: check specific 'ai_brain_live_zalo_endpoint' first,
  -- fallback to derivation from 'zalo_transcription_endpoint' or default production URL.
  IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
    SELECT decrypted_secret INTO v_endpoint
    FROM vault.decrypted_secrets
    WHERE name = 'ai_brain_live_zalo_endpoint'
    LIMIT 1;

    IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
      SELECT regexp_replace(decrypted_secret, '/api/cron/[a-zA-Z0-9.\-]+(\?.*)?$', '/api/cron/ai-brain-live-zalo?limit=5')
      INTO v_endpoint
      FROM vault.decrypted_secrets
      WHERE name = 'zalo_transcription_endpoint'
      LIMIT 1;
    END IF;

    -- B. Read bearer secret: check specific 'ai_brain_live_zalo_cron_secret' first,
    -- fallback to 'zalo_transcription_cron_secret'.
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'ai_brain_live_zalo_cron_secret'
    LIMIT 1;

    IF v_secret IS NULL OR btrim(v_secret) = '' THEN
      SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets
      WHERE name = 'zalo_transcription_cron_secret'
      LIMIT 1;
    END IF;
  END IF;

  IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
    v_endpoint := 'https://ai-crm-cua-chong-ngap.onrender.com/api/cron/ai-brain-live-zalo?limit=5';
  END IF;

  -- C. Strict Vault validation: sanitized constant error codes, never leaking config details
  IF v_secret IS NULL OR length(btrim(v_secret)) < 16 OR v_secret ~ '[\r\n]' THEN
    RAISE EXCEPTION 'INVALID_VAULT_SECRET_CONFIG';
  END IF;

  v_endpoint := btrim(v_endpoint);

  IF v_endpoint ~ '[\s#@]' THEN
    RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
  END IF;

  IF v_endpoint !~ '^https://[a-zA-Z0-9.\-]+(?::[0-9]{1,5})?/api/cron/ai-brain-live-zalo(\?limit=[0-9]+)?$' THEN
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
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  -- E. Record in bounded dispatch history for reliable sanitized correlation
  IF v_request_id IS NOT NULL THEN
    INSERT INTO cron_internal.ai_brain_live_zalo_dispatch_history (request_id, dispatched_at)
    VALUES (v_request_id, now())
    ON CONFLICT (request_id) DO UPDATE SET dispatched_at = EXCLUDED.dispatched_at;

    -- Prune history to keep bounded (retain latest 500 entries)
    DELETE FROM cron_internal.ai_brain_live_zalo_dispatch_history
    WHERE request_id NOT IN (
      SELECT request_id
      FROM cron_internal.ai_brain_live_zalo_dispatch_history
      ORDER BY dispatched_at DESC
      LIMIT 500
    );
  END IF;

  RETURN v_request_id;
END;
$$;

-- 5. Lock down helper function permissions
REVOKE ALL ON FUNCTION cron_internal.invoke_ai_brain_live_zalo_cron() FROM PUBLIC;
REVOKE ALL ON FUNCTION cron_internal.invoke_ai_brain_live_zalo_cron() FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cron_internal.invoke_ai_brain_live_zalo_cron() TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT EXECUTE ON FUNCTION cron_internal.invoke_ai_brain_live_zalo_cron() TO supabase_admin;
  END IF;
END $$;

-- 6. Schedule recurring 1-minute cron job in pg_cron
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai_brain_live_zalo_worker') THEN
      PERFORM cron.unschedule('ai_brain_live_zalo_worker');
    END IF;

    PERFORM cron.schedule(
      'ai_brain_live_zalo_worker',
      '* * * * *',
      'SELECT cron_internal.invoke_ai_brain_live_zalo_cron();'
    );
  END IF;
END $$;
