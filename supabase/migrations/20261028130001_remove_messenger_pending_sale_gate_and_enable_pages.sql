-- Migration: 20261028130001_remove_messenger_pending_sale_gate_and_enable_pages.sql
-- Description:
-- 1. Remove PENDING_SALE gate for Facebook Messenger: AI replies immediately on inbound
--    without waiting for human sale (preserves PENDING_SALE and SLA rules for Zalo).
-- 2. Expand live delivery canary allowlist and auto-seeding to both Facebook Pages:
--    - 1343097708890171 (Du học CHD)
--    - 1026991374010112 (Cửa chống ngập / CHD Main Page)
-- 3. Ensure live delivery foundation columns and RPCs exist for production:
--    - dispatch_started_at, brain_latency_ms, outbound_interaction_id on ai_brain_live_deliveries
--    - start_ai_messenger_live_dispatch (with PENDING_SALE allowed)
--    - finish_ai_brain_live_delivery_extended
--    - enqueue_ai_brain_live_delivery (with PENDING_SALE allowed for Messenger)
-- 4. Enable ai_brain_live_settings for Messenger and schedule recurring 5-second
--    pg_cron job ai_brain_live_messenger_worker when pg_cron is present.

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Columns and Indexes on ai_brain_live_deliveries
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_brain_live_deliveries'
      AND column_name = 'dispatch_started_at'
  ) THEN
    ALTER TABLE public.ai_brain_live_deliveries
      ADD COLUMN dispatch_started_at timestamptz DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_brain_live_deliveries'
      AND column_name = 'brain_latency_ms'
  ) THEN
    ALTER TABLE public.ai_brain_live_deliveries
      ADD COLUMN brain_latency_ms integer DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_brain_live_deliveries'
      AND column_name = 'outbound_interaction_id'
  ) THEN
    ALTER TABLE public.ai_brain_live_deliveries
      ADD COLUMN outbound_interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_brain_live_deliveries_dispatch_started
  ON public.ai_brain_live_deliveries (company_id, channel, dispatch_started_at)
  WHERE dispatch_started_at IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 2. Extended finish RPC
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_ai_brain_live_delivery_extended(
  p_id uuid,
  p_lock_token uuid,
  p_send_status text,
  p_decision text DEFAULT NULL,
  p_confidence numeric DEFAULT NULL,
  p_external_message_id text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_brain_turn_id uuid DEFAULT NULL,
  p_brain_latency_ms integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows_updated integer;
  v_now timestamptz := now();
  v_attempts integer;
  v_backoff_seconds integer;
  v_is_non_retryable boolean := false;
  v_raw_mid text;
BEGIN
  IF p_id IS NULL OR p_lock_token IS NULL OR p_send_status IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF p_send_status NOT IN ('SENT', 'SKIPPED', 'FAILED') THEN
    RAISE EXCEPTION 'INVALID_STATUS';
  END IF;

  -- Extract raw provider MID if passed in meta:Page:MID format
  IF p_external_message_id IS NOT NULL AND p_external_message_id ~ '^meta:[0-9]+:(.+)$' THEN
    v_raw_mid := substring(p_external_message_id from '^meta:[0-9]+:(.+)$');
  ELSE
    v_raw_mid := p_external_message_id;
  END IF;

  IF p_error_code IN (
    'MESSENGER_DISPATCH_UNCERTAIN',
    'OUTBOUND_PERSISTENCE_FAILED',
    'CANARY_NOT_ALLOWED',
    'CANARY_RESTRICTED',
    'MESSAGING_WINDOW_CLOSED',
    'PAGE_COMPANY_MISMATCH',
    'PAGE_NOT_CONFIGURED',
    'EMPTY_DRAFT',
    'LIVE_SCOPE_INVALID',
    'LIVE_SOURCE_INVALID'
  ) THEN
    v_is_non_retryable := true;
  END IF;

  IF p_send_status = 'FAILED' THEN
    SELECT d.attempts INTO v_attempts
    FROM public.ai_brain_live_deliveries d
    WHERE d.id = p_id
      AND d.lock_token = p_lock_token
      AND d.send_status = 'PROCESSING'
      AND d.locked_at > v_now - interval '5 minutes';

    IF v_attempts IS NULL THEN
      RETURN false;
    END IF;

    IF v_is_non_retryable THEN
      UPDATE public.ai_brain_live_deliveries d
      SET send_status = 'FAILED',
          decision = p_decision,
          confidence = p_confidence,
          external_message_id = COALESCE(v_raw_mid, d.external_message_id),
          error_code = p_error_code,
          brain_turn_id = p_brain_turn_id,
          brain_latency_ms = COALESCE(p_brain_latency_ms, d.brain_latency_ms),
          completed_at = v_now,
          locked_at = NULL,
          lock_token = NULL,
          updated_at = v_now
      WHERE d.id = p_id
        AND d.lock_token = p_lock_token
        AND d.send_status = 'PROCESSING'
        AND d.locked_at > v_now - interval '5 minutes';
    ELSE
      v_backoff_seconds := LEAST(300, 30 * GREATEST(1, v_attempts));

      UPDATE public.ai_brain_live_deliveries d
      SET send_status = 'FAILED',
          decision = p_decision,
          confidence = p_confidence,
          external_message_id = COALESCE(v_raw_mid, d.external_message_id),
          error_code = p_error_code,
          brain_turn_id = p_brain_turn_id,
          brain_latency_ms = COALESCE(p_brain_latency_ms, d.brain_latency_ms),
          available_at = v_now + (v_backoff_seconds * interval '1 second'),
          completed_at = v_now,
          locked_at = NULL,
          lock_token = NULL,
          updated_at = v_now
      WHERE d.id = p_id
        AND d.lock_token = p_lock_token
        AND d.send_status = 'PROCESSING'
        AND d.locked_at > v_now - interval '5 minutes';
    END IF;

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
    RETURN v_rows_updated = 1;
  END IF;

  UPDATE public.ai_brain_live_deliveries d
  SET send_status = p_send_status,
      decision = p_decision,
      confidence = p_confidence,
      external_message_id = COALESCE(v_raw_mid, d.external_message_id),
      error_code = p_error_code,
      brain_turn_id = p_brain_turn_id,
      brain_latency_ms = COALESCE(p_brain_latency_ms, d.brain_latency_ms),
      completed_at = v_now,
      sent_at = CASE WHEN p_send_status = 'SENT' THEN v_now ELSE NULL END,
      locked_at = NULL,
      lock_token = NULL,
      updated_at = v_now
  WHERE d.id = p_id
    AND d.lock_token = p_lock_token
    AND d.send_status = 'PROCESSING'
    AND d.locked_at > v_now - interval '5 minutes';

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  RETURN v_rows_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_ai_brain_live_delivery_extended(uuid, uuid, text, text, numeric, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_ai_brain_live_delivery_extended(uuid, uuid, text, text, numeric, text, text, uuid, integer) TO service_role;

-- ------------------------------------------------------------------------------
-- 3. Atomic Dispatch-Start Fence (PENDING_SALE removed for Messenger)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_ai_messenger_live_dispatch(
  p_delivery_id uuid,
  p_lock_token uuid,
  p_company_id uuid,
  p_customer_id uuid,
  p_conversation_id uuid,
  p_source_interaction_id uuid,
  p_page_id text,
  p_min_confidence numeric DEFAULT NULL,
  p_turn_confidence numeric DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery record;
  v_source record;
  v_conv record;
  v_conv_page_id text;
  v_setting record;
  v_canary record;
  v_rows_updated integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Input sanitization & lock token requirement
  IF p_delivery_id IS NULL
     OR p_lock_token IS NULL
     OR p_company_id IS NULL
     OR p_customer_id IS NULL
     OR p_conversation_id IS NULL
     OR p_source_interaction_id IS NULL
     OR p_page_id IS NULL
     OR p_page_id !~ '^[0-9]+$' THEN
    RETURN false;
  END IF;

  -- 2. Finite confidence requirement in [0, 1]
  IF p_turn_confidence IS NULL
     OR p_turn_confidence < 0
     OR p_turn_confidence > 1
     OR p_turn_confidence = 'NaN'::numeric THEN
    RETURN false;
  END IF;

  -- 3. Lock delivery row for update & validate active lease + status + token
  SELECT d.id, d.company_id, d.customer_id, d.conversation_id, d.source_interaction_id,
         d.channel, d.lock_token, d.locked_at, d.send_status, d.dispatch_started_at,
         d.external_message_id
  INTO v_delivery
  FROM public.ai_brain_live_deliveries d
  WHERE d.id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_delivery.company_id <> p_company_id
     OR v_delivery.customer_id <> p_customer_id
     OR v_delivery.conversation_id <> p_conversation_id
     OR v_delivery.source_interaction_id <> p_source_interaction_id
     OR v_delivery.channel <> 'MESSENGER' THEN
    RETURN false;
  END IF;

  IF v_delivery.send_status <> 'PROCESSING'
     OR v_delivery.lock_token IS NULL
     OR v_delivery.lock_token <> p_lock_token
     OR v_delivery.locked_at IS NULL
     OR v_delivery.locked_at <= v_now - interval '5 minutes' THEN
    RETURN false;
  END IF;

  IF v_delivery.dispatch_started_at IS NOT NULL OR v_delivery.external_message_id IS NOT NULL THEN
    RETURN false;
  END IF;

  -- 4. Validate source interaction
  SELECT i.id, i.company_id, i.customer_id, i.conversation_id, i.channel, i.direction,
         i.actor_type, i.type, i.sanitization_status, i.sanitized_content, i.created_at
  INTO v_source
  FROM public.interactions i
  WHERE i.id = p_source_interaction_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_source.company_id <> p_company_id
     OR v_source.customer_id <> p_customer_id
     OR v_source.conversation_id <> p_conversation_id
     OR v_source.channel <> 'FACEBOOK'
     OR v_source.direction <> 'INBOUND'
     OR v_source.actor_type <> 'CUSTOMER'
     OR v_source.type <> 'MESSAGE'
     OR v_source.sanitization_status <> 'SUCCEEDED'
     OR v_source.sanitized_content IS NULL
     OR btrim(v_source.sanitized_content) = '' THEN
    RETURN false;
  END IF;

  IF v_source.created_at > v_now OR v_source.created_at < v_now - interval '24 hours' THEN
    RETURN false;
  END IF;

  -- 5. Validate tenant live setting
  SELECT s.enabled, s.min_confidence
  INTO v_setting
  FROM public.ai_brain_live_settings s
  WHERE s.company_id = p_company_id
    AND s.channel = 'MESSENGER'
  FOR UPDATE;

  IF NOT FOUND OR v_setting.enabled <> true THEN
    RETURN false;
  END IF;

  IF p_turn_confidence < v_setting.min_confidence THEN
    RETURN false;
  END IF;

  -- 6. Validate conversation state:
  -- PENDING_SALE is ALLOWED for Messenger (AI replies immediately without waiting for sale).
  -- CLOSED, assigned_to (human takeover), or ai_mode = 'PAUSED' still block.
  SELECT c.id, c.status, c.assigned_to, c.ai_mode, c.channel, c.external_conversation_id, c.metadata
  INTO v_conv
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id
    AND c.customer_id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_conv.channel <> 'FACEBOOK'
     OR v_conv.status = 'CLOSED'
     OR v_conv.assigned_to IS NOT NULL
     OR v_conv.ai_mode = 'PAUSED' THEN
    RETURN false;
  END IF;

  v_conv_page_id := public.ai_messenger_page_id(v_conv.external_conversation_id, v_conv.metadata);
  IF v_conv_page_id IS NULL OR v_conv_page_id <> p_page_id THEN
    RETURN false;
  END IF;

  -- 7. Canary allowlist verification
  SELECT a.id, a.enabled
  INTO v_canary
  FROM public.ai_brain_live_canary_allowlist a
  WHERE a.company_id = p_company_id
    AND a.channel = 'MESSENGER'
    AND a.conversation_id = p_conversation_id
    AND a.page_id = p_page_id
  FOR UPDATE;

  IF NOT FOUND OR v_canary.enabled <> true THEN
    RETURN false;
  END IF;

  -- 8. Refresh timestamp and atomically set dispatch_started_at
  v_now := clock_timestamp();
  IF v_delivery.locked_at <= v_now - interval '5 minutes' THEN
    RETURN false;
  END IF;
  IF v_source.created_at > v_now OR v_source.created_at < v_now - interval '24 hours' THEN
    RETURN false;
  END IF;

  UPDATE public.ai_brain_live_deliveries
  SET dispatch_started_at = v_now,
      updated_at = v_now
  WHERE id = p_delivery_id
    AND lock_token = p_lock_token
    AND dispatch_started_at IS NULL;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  RETURN v_rows_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.start_ai_messenger_live_dispatch(uuid, uuid, uuid, uuid, uuid, uuid, text, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_ai_messenger_live_dispatch(uuid, uuid, uuid, uuid, uuid, uuid, text, numeric, numeric) TO service_role;

-- ------------------------------------------------------------------------------
-- 4. Update enqueue_ai_brain_live_delivery (PENDING_SALE allowed for Messenger)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_ai_brain_live_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_live_channel text;
  v_external_conv_id text;
  v_conv_metadata jsonb;
  v_page_id text;
BEGIN
  IF NEW.type <> 'MESSAGE'
     OR NEW.direction <> 'INBOUND'
     OR NEW.actor_type <> 'CUSTOMER'
     OR NEW.conversation_id IS NULL
     OR NEW.sanitization_status <> 'SUCCEEDED'
     OR NEW.sanitized_content IS NULL
     OR NEW.sanitized_content !~ '[^[:space:]]' THEN
    RETURN NEW;
  END IF;

  IF NEW.channel = 'ZALO' THEN
    v_live_channel := 'ZALO';
  ELSIF NEW.channel = 'FACEBOOK' THEN
    v_live_channel := 'MESSENGER';
  ELSE
    RETURN NEW;
  END IF;

  -- Guard: Live setting must exist and be enabled for this company and channel
  IF NOT EXISTS (
    SELECT 1
    FROM public.ai_brain_live_settings s
    WHERE s.company_id = NEW.company_id
      AND s.channel = v_live_channel
      AND s.enabled = true
  ) THEN
    RETURN NEW;
  END IF;

  -- Guard: Conversation state
  -- For ZALO: CLOSED, PENDING_SALE, assigned_to IS NOT NULL, or ai_mode = 'PAUSED' block enqueue.
  -- For MESSENGER: PENDING_SALE is permitted; CLOSED, assigned_to IS NOT NULL, or ai_mode = 'PAUSED' block enqueue.
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = NEW.conversation_id
      AND c.company_id = NEW.company_id
      AND (
        c.status = 'CLOSED'
        OR (v_live_channel = 'ZALO' AND c.status = 'PENDING_SALE')
        OR c.assigned_to IS NOT NULL
        OR c.ai_mode = 'PAUSED'
      )
  ) THEN
    RETURN NEW;
  END IF;

  -- Canary Guard for MESSENGER
  IF v_live_channel = 'MESSENGER' THEN
    SELECT c.external_conversation_id, c.metadata
    INTO v_external_conv_id, v_conv_metadata
    FROM public.conversations c
    WHERE c.id = NEW.conversation_id
      AND c.company_id = NEW.company_id;

    v_page_id := public.ai_messenger_page_id(v_external_conv_id, v_conv_metadata);

    IF v_page_id IS NULL OR v_page_id !~ '^[0-9]+$' THEN
      RETURN NEW;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.ai_brain_live_canary_allowlist a
      WHERE a.company_id = NEW.company_id
        AND a.channel = 'MESSENGER'
        AND a.conversation_id = NEW.conversation_id
        AND a.page_id = v_page_id
        AND a.enabled = true
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.ai_brain_live_deliveries (
    company_id, customer_id, conversation_id, source_interaction_id, channel
  ) VALUES (
    NEW.company_id, NEW.customer_id, NEW.conversation_id, NEW.id, v_live_channel
  )
  ON CONFLICT (source_interaction_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_ai_brain_live_delivery() FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 5. Seed and Allowlist BOTH Facebook Fanpages
-- ------------------------------------------------------------------------------
-- Backfill existing conversations on both Fanpages
INSERT INTO public.ai_brain_live_canary_allowlist (
  company_id, channel, conversation_id, page_id, enabled
)
SELECT
  c.company_id,
  'MESSENGER',
  c.id,
  public.ai_messenger_page_id(c.external_conversation_id, c.metadata),
  true
FROM public.conversations c
WHERE c.channel = 'FACEBOOK'
  AND public.ai_messenger_page_id(c.external_conversation_id, c.metadata) IN ('1343097708890171', '1026991374010112')
ON CONFLICT (company_id, channel, conversation_id, page_id)
DO UPDATE SET enabled = true, updated_at = now();

-- Update trigger function to cover both Facebook Pages for future conversations
CREATE OR REPLACE FUNCTION public.seed_messenger_pages_canary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page_id text;
BEGIN
  IF NEW.channel <> 'FACEBOOK' THEN
    RETURN NEW;
  END IF;

  v_page_id := public.ai_messenger_page_id(NEW.external_conversation_id, NEW.metadata);
  IF v_page_id NOT IN ('1343097708890171', '1026991374010112') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ai_brain_live_canary_allowlist (
    company_id, channel, conversation_id, page_id, enabled
  ) VALUES (
    NEW.company_id, 'MESSENGER', NEW.id, v_page_id, true
  )
  ON CONFLICT (company_id, channel, conversation_id, page_id)
  DO UPDATE SET enabled = true, updated_at = now();

  INSERT INTO public.ai_brain_live_settings (
    company_id, channel, enabled, min_confidence
  ) VALUES (
    NEW.company_id, 'MESSENGER', true, 0.850
  )
  ON CONFLICT (company_id, channel)
  DO UPDATE SET enabled = true, updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_du_hoc_messenger_canary ON public.conversations;
DROP TRIGGER IF EXISTS trg_seed_messenger_pages_canary ON public.conversations;
CREATE TRIGGER trg_seed_messenger_pages_canary
  AFTER INSERT OR UPDATE OF external_conversation_id, metadata ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.seed_messenger_pages_canary();

-- Enable live settings for Messenger for companies associated with either Fanpage
INSERT INTO public.ai_brain_live_settings (
  company_id, channel, enabled, min_confidence
)
SELECT DISTINCT c.company_id, 'MESSENGER', true, 0.850
FROM public.conversations c
WHERE c.channel = 'FACEBOOK'
  AND (
    public.ai_messenger_page_id(c.external_conversation_id, c.metadata) IN ('1343097708890171', '1026991374010112')
    OR lower(coalesce(c.metadata->>'provider', '')) = 'botcake'
  )
ON CONFLICT (company_id, channel)
DO UPDATE SET enabled = true, updated_at = now();

-- ------------------------------------------------------------------------------
-- 6. Setup pg_cron recurring invocation for Messenger worker (if pg_cron & pg_net exist)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regnamespace('net') IS NOT NULL THEN
    -- Ensure cron_internal schema exists
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS cron_internal';
    EXECUTE 'GRANT USAGE ON SCHEMA cron_internal TO postgres';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
      EXECUTE 'GRANT USAGE ON SCHEMA cron_internal TO supabase_admin';
    END IF;

    -- Ensure dispatch history table exists
    CREATE TABLE IF NOT EXISTS cron_internal.ai_brain_live_messenger_dispatch_history (
      request_id bigint PRIMARY KEY,
      dispatched_at timestamptz NOT NULL DEFAULT now()
    );
    GRANT ALL ON cron_internal.ai_brain_live_messenger_dispatch_history TO postgres;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
      GRANT ALL ON cron_internal.ai_brain_live_messenger_dispatch_history TO supabase_admin;
    END IF;

    -- Helper function
    CREATE OR REPLACE FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron()
    RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $fn$
    DECLARE
      v_endpoint text;
      v_secret text;
      v_request_id bigint;
    BEGIN
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

      IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
        v_endpoint := 'https://ai-crm-cua-chong-ngap.onrender.com/api/cron/ai-brain-live-messenger?limit=5';
      END IF;

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

      SELECT net.http_post(
        url := v_endpoint,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || btrim(v_secret)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      ) INTO v_request_id;

      IF v_request_id IS NOT NULL THEN
        INSERT INTO cron_internal.ai_brain_live_messenger_dispatch_history (request_id, dispatched_at)
        VALUES (v_request_id, now())
        ON CONFLICT (request_id) DO UPDATE SET dispatched_at = EXCLUDED.dispatched_at;

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
    $fn$;

    REVOKE ALL ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() TO postgres;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
      GRANT EXECUTE ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() TO supabase_admin;
    END IF;

    -- Schedule 5-second recurring worker to match Zalo and deliver immediate replies
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai_brain_live_messenger_worker') THEN
      PERFORM cron.unschedule('ai_brain_live_messenger_worker');
    END IF;

    PERFORM cron.schedule(
      'ai_brain_live_messenger_worker',
      '5 seconds',
      'SELECT cron_internal.invoke_ai_brain_live_messenger_cron();'
    );
  END IF;
END $$;

COMMIT;
