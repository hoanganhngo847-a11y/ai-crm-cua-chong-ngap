-- Migration: 20261023170000_ai_brain_messenger_live_canary_and_scheduler.sql
-- Description: Phase 10 - Messenger secure scheduler and strict canary restriction (Hardened)
--
-- Invariants:
-- 1. Scheduler:
--    - In Supabase production environments with pg_cron and pg_net, creates the private
--      helper cron_internal.invoke_ai_brain_live_messenger_cron() and schedules job
--      'ai_brain_live_messenger_worker' (* * * * *).
--    - Full manual operational SQL is provided in docs/sql/ai-brain-live-messenger-scheduler-setup.sql.
--    - Uses local/CI compatibility guards so that environments lacking pg_cron / pg_net / vault
--      (like PGlite and ephemeral runners) succeed without error.
--    - Zero secrets in cron.job.command; Vault endpoint & CRON_SECRET fallback to Zalo secure values.
--    - Strictly fail-closed on missing secure Vault endpoint: NO hard-coded production URL fallback.
--    - Valid PL/pgSQL DO blocks inside dynamic SQL; eliminates bare IF/PERFORM syntax errors.
--    - Revoked from PUBLIC, anon, authenticated, service_role; postgres/supabase_admin only.
-- 2. Strict Canary Restriction:
--    - Adds scoped allowlist table public.ai_brain_live_canary_allowlist keyed
--      (company_id, channel, conversation_id, page_id).
--    - Composite foreign key (company_id, conversation_id) references public.conversations(company_id, id).
--    - Strictly numeric Page identity check (page_id ~ '^[0-9]+$').
--    - Mutations service-only (authenticated SELECT restricted to BOSS_ADMIN).
--    - Updates enqueue_ai_brain_live_delivery(): for MESSENGER, default is DENY unless explicitly allowlisted.
--    - Preserves existing ZALO behavior completely.
-- 3. Critical Transport Safety & Pre-Send Durable Dispatch Fence:
--    - Adds dispatch_started_at marker column and brain_latency_ms to public.ai_brain_live_deliveries.
--    - Provides atomic service-only RPC public.start_ai_messenger_live_dispatch() that validates
--      active lock token, unexpired lease, scope, numeric Page, canary, active settings, ownership,
--      and 24-hour window, atomically setting dispatch_started_at ONLY ONCE before provider call.
--    - Once marker is set, delivery is NEVER re-claimed or physically resent.
--    - claim_ai_brain_live_deliveries excludes non-retryable errors and deliveries with dispatch_started_at set.
--    - finish_ai_brain_live_delivery preserves real attempt counts (no fake attempts=5) and preserves known IDs.
--    - record_ai_messenger_live_outbound enforces full delivery/source/tenant scope, serializes
--      concurrent calls via FOR UPDATE, and binds external_message_id idempotently.

-- 1. Create Scoped Canary Allowlist Table with Composite FK & Numeric Page Validation
CREATE TABLE IF NOT EXISTS public.ai_brain_live_canary_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('MESSENGER', 'ZALO', 'VOICE')),
  conversation_id uuid NOT NULL,
  page_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_brain_live_canary_allowlist UNIQUE (company_id, channel, conversation_id, page_id)
);

DO $$
BEGIN
  -- Add composite FK to conversations(company_id, id) if not present
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_brain_live_canary_conversation'
  ) THEN
    ALTER TABLE public.ai_brain_live_canary_allowlist
      ADD CONSTRAINT fk_ai_brain_live_canary_conversation
      FOREIGN KEY (company_id, conversation_id)
      REFERENCES public.conversations(company_id, id)
      ON DELETE CASCADE;
  END IF;

  -- Add numeric page validation check constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_brain_live_canary_page_id_numeric'
  ) THEN
    ALTER TABLE public.ai_brain_live_canary_allowlist
      DROP CONSTRAINT IF EXISTS ai_brain_live_canary_allowlist_page_id_check;
    ALTER TABLE public.ai_brain_live_canary_allowlist
      ADD CONSTRAINT chk_ai_brain_live_canary_page_id_numeric
      CHECK (page_id ~ '^[0-9]+$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_brain_live_canary_lookup
  ON public.ai_brain_live_canary_allowlist (company_id, channel, conversation_id, page_id)
  WHERE enabled = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_ai_brain_live_canary_allowlist_updated_at'
  ) THEN
    CREATE TRIGGER trg_ai_brain_live_canary_allowlist_updated_at
      BEFORE UPDATE ON public.ai_brain_live_canary_allowlist
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

ALTER TABLE public.ai_brain_live_canary_allowlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_brain_live_canary_allowlist FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_brain_live_canary_allowlist TO authenticated;
GRANT ALL ON public.ai_brain_live_canary_allowlist TO service_role;

DROP POLICY IF EXISTS ai_brain_live_canary_select_tenant ON public.ai_brain_live_canary_allowlist;
CREATE POLICY ai_brain_live_canary_select_tenant
  ON public.ai_brain_live_canary_allowlist
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- Drop any mutation policies for authenticated: service-role only mutations
DROP POLICY IF EXISTS ai_brain_live_canary_insert_tenant ON public.ai_brain_live_canary_allowlist;
DROP POLICY IF EXISTS ai_brain_live_canary_update_tenant ON public.ai_brain_live_canary_allowlist;
DROP POLICY IF EXISTS ai_brain_live_canary_delete_tenant ON public.ai_brain_live_canary_allowlist;

-- 2. Add dispatch_started_at marker column and brain_latency_ms to ai_brain_live_deliveries
ALTER TABLE public.ai_brain_live_deliveries
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS brain_latency_ms integer CHECK (brain_latency_ms IS NULL OR brain_latency_ms >= 0),
  ADD COLUMN IF NOT EXISTS outbound_interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_brain_live_deliveries_dispatch_fence
  ON public.ai_brain_live_deliveries (id, lock_token, dispatch_started_at)
  WHERE send_status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_ai_brain_live_deliveries_outbound_int
  ON public.ai_brain_live_deliveries (outbound_interaction_id)
  WHERE outbound_interaction_id IS NOT NULL;

-- 3. Update enqueue_ai_brain_live_delivery with Strict Canary Guard and Numeric Page Check
CREATE OR REPLACE FUNCTION public.enqueue_ai_brain_live_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_live_channel text;
  v_external_conv_id text;
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

  -- Guard: Do not enqueue if conversation is closed, pending sale, assigned to human, or AI is paused
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = NEW.conversation_id
      AND c.company_id = NEW.company_id
      AND (c.status IN ('CLOSED', 'PENDING_SALE') OR c.assigned_to IS NOT NULL OR c.ai_mode = 'PAUSED')
  ) THEN
    RETURN NEW;
  END IF;

  -- Strict Canary Restriction for MESSENGER:
  -- Company enabled alone must NOT allow every customer.
  -- For MESSENGER, default is DENY unless the conversation and page are explicitly allowlisted.
  IF v_live_channel = 'MESSENGER' THEN
    SELECT c.external_conversation_id INTO v_external_conv_id
    FROM public.conversations c
    WHERE c.id = NEW.conversation_id
      AND c.company_id = NEW.company_id;

    IF v_external_conv_id IS NULL OR position(':' in v_external_conv_id) <= 1 THEN
      RETURN NEW;
    END IF;

    v_page_id := split_part(v_external_conv_id, ':', 1);

    -- Numeric Page validation: Page must be strictly numeric digits
    IF v_page_id !~ '^[0-9]+$' THEN
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

-- 4. Durable Atomic Pre-Send Dispatch Fence RPC
-- Evaluates active lease, scope, canary, current settings, ownership, and 24h window
-- before setting dispatch_started_at ONLY ONCE.
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
  -- Must not be NULL, not NaN, and within [0, 1]
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

  -- Validate delivery scope
  IF v_delivery.company_id <> p_company_id
     OR v_delivery.customer_id <> p_customer_id
     OR v_delivery.conversation_id <> p_conversation_id
     OR v_delivery.source_interaction_id <> p_source_interaction_id
     OR v_delivery.channel <> 'MESSENGER' THEN
    RETURN false;
  END IF;

  -- Validate active lock token and unexpired lease (5 min lease window)
  IF v_delivery.send_status <> 'PROCESSING'
     OR v_delivery.lock_token IS NULL
     OR v_delivery.lock_token <> p_lock_token
     OR v_delivery.locked_at IS NULL
     OR v_delivery.locked_at <= v_now - interval '5 minutes' THEN
    RETURN false;
  END IF;

  -- Fence: Durable once-only dispatch marker.
  -- If marker already set or already has external_message_id, deny!
  IF v_delivery.dispatch_started_at IS NOT NULL OR v_delivery.external_message_id IS NOT NULL THEN
    RETURN false;
  END IF;

  -- 4. Validate actual bound source interaction scope, content, direction, customer, channel, type, sanitization, and timestamps
  SELECT i.id, i.company_id, i.customer_id, i.conversation_id, i.channel, i.direction,
         i.actor_type, i.type, i.sanitization_status, i.sanitized_content, i.created_at
  INTO v_source
  FROM public.interactions i
  WHERE i.id = p_source_interaction_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Scope validation: select and require source type='MESSAGE' AND sanitization_status='SUCCEEDED'
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

  -- Initial check: Reject future inbound (clock skew / spoofing) and expired inbound (> 24 hours messaging window)
  IF v_source.created_at > v_now OR v_source.created_at < v_now - interval '24 hours' THEN
    RETURN false;
  END IF;

  -- 5. Lock and check current tenant settings to serialize authorization with kill-switch
  SELECT s.enabled, s.min_confidence
  INTO v_setting
  FROM public.ai_brain_live_settings s
  WHERE s.company_id = p_company_id
    AND s.channel = 'MESSENGER'
  FOR UPDATE;

  IF NOT FOUND OR v_setting.enabled <> true THEN
    RETURN false;
  END IF;

  -- Enforce current threshold: turn confidence must meet or exceed active setting threshold
  IF p_turn_confidence < v_setting.min_confidence THEN
    RETURN false;
  END IF;

  -- 6. Lock and check conversation row to serialize authorization with human takeover, pause, and close
  SELECT c.id, c.status, c.assigned_to, c.ai_mode, c.channel, c.external_conversation_id
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
     OR v_conv.status IN ('CLOSED', 'PENDING_SALE')
     OR v_conv.assigned_to IS NOT NULL
     OR v_conv.ai_mode = 'PAUSED' THEN
    RETURN false;
  END IF;

  -- Strict numeric Page:PSID shape: ^[0-9]+:[0-9]+$ and exact Page ID prefix
  IF v_conv.external_conversation_id IS NULL
     OR v_conv.external_conversation_id !~ '^[0-9]+:[0-9]+$'
     OR split_part(v_conv.external_conversation_id, ':', 1) <> p_page_id THEN
    RETURN false;
  END IF;

  -- 7. Lock and check canary allowlist row to serialize authorization with canary changes
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

  -- 8. Refresh clock_timestamp AFTER all potentially blocking settings/conversation/canary locks,
  -- immediately before dispatch authorization. Recheck lease expiry and source future/24-hour bounds.
  v_now := clock_timestamp();

  IF v_delivery.locked_at <= v_now - interval '5 minutes' THEN
    RETURN false;
  END IF;

  IF v_source.created_at > v_now OR v_source.created_at < v_now - interval '24 hours' THEN
    RETURN false;
  END IF;

  -- All checks passed! Atomically set dispatch_started_at marker (durable once-only)
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

-- 5. Update claim_ai_brain_live_deliveries with non-retryable error and marker exclusion
CREATE OR REPLACE FUNCTION public.claim_ai_brain_live_deliveries(
  p_limit integer,
  p_lock_token uuid,
  p_channel text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  customer_id uuid,
  conversation_id uuid,
  source_interaction_id uuid,
  channel text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_lock_token IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  IF p_channel IS NOT NULL AND p_channel NOT IN ('ZALO', 'MESSENGER', 'VOICE') THEN
    RAISE EXCEPTION 'INVALID_CHANNEL';
  END IF;

  -- Stale processing sweep: mark expired rows as FAILED.
  -- If dispatch_started_at is set, it is an UNCERTAIN crash failure and must never be retried.
  WITH expired_final AS (
    SELECT d.id, d.dispatch_started_at
    FROM public.ai_brain_live_deliveries d
    WHERE d.send_status = 'PROCESSING'
      AND d.locked_at < now() - interval '5 minutes'
      AND (d.attempts >= 5 OR d.dispatch_started_at IS NOT NULL)
      AND (p_channel IS NULL OR d.channel = p_channel)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_brain_live_deliveries d
  SET send_status = 'FAILED',
      error_code = CASE
        WHEN ef.dispatch_started_at IS NOT NULL THEN 'MESSENGER_DISPATCH_UNCERTAIN'
        ELSE 'BRAIN_TIMEOUT'
      END,
      completed_at = now(),
      locked_at = NULL,
      lock_token = NULL,
      updated_at = now()
  FROM expired_final ef
  WHERE d.id = ef.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT d.id
    FROM public.ai_brain_live_deliveries d
    WHERE (
      (
        d.send_status IN ('PENDING', 'FAILED')
        AND d.available_at <= now()
        AND d.attempts < 5
        AND d.dispatch_started_at IS NULL
        AND (
          d.error_code IS NULL
          OR d.error_code NOT IN (
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
          )
        )
        AND (p_channel IS NULL OR d.channel = p_channel)
      )
      OR (
        d.send_status = 'PROCESSING'
        AND d.locked_at < now() - interval '5 minutes'
        AND d.attempts < 5
        AND d.dispatch_started_at IS NULL
        AND (
          d.error_code IS NULL
          OR d.error_code NOT IN (
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
          )
        )
        AND (p_channel IS NULL OR d.channel = p_channel)
      )
    )
    ORDER BY d.available_at, d.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.ai_brain_live_deliveries d
    SET send_status = 'PROCESSING',
        attempts = d.attempts + 1,
        locked_at = now(),
        lock_token = p_lock_token,
        completed_at = NULL,
        updated_at = now()
    FROM candidates c
    WHERE d.id = c.id
    RETURNING d.id, d.company_id, d.customer_id, d.conversation_id,
              d.source_interaction_id, d.channel, d.attempts
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_brain_live_deliveries(integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_brain_live_deliveries(integer, uuid, text) TO service_role;

-- 6. Update finish_ai_brain_live_delivery and provide finish_ai_brain_live_delivery_extended:
-- Drops any 9-arg overload of finish_ai_brain_live_delivery to eliminate native Postgres ambiguity.
-- Preserves original 8-argument finish_ai_brain_live_delivery unambiguously.
-- Provides separately named extended finish RPC finish_ai_brain_live_delivery_extended with latency tracking.
DROP FUNCTION IF EXISTS public.finish_ai_brain_live_delivery(uuid, uuid, text, text, numeric, text, text, uuid, integer);

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
      -- Terminal non-retryable failure: preserve real attempts count.
      -- claim_ai_brain_live_deliveries excludes non-retryable error_code and marked rows.
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

-- Unambiguous original 8-argument interface compatibility wrapper
CREATE OR REPLACE FUNCTION public.finish_ai_brain_live_delivery(
  p_id uuid,
  p_lock_token uuid,
  p_send_status text,
  p_decision text DEFAULT NULL,
  p_confidence numeric DEFAULT NULL,
  p_external_message_id text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_brain_turn_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.finish_ai_brain_live_delivery_extended(
    p_id => p_id,
    p_lock_token => p_lock_token,
    p_send_status => p_send_status,
    p_decision => p_decision,
    p_confidence => p_confidence,
    p_external_message_id => p_external_message_id,
    p_error_code => p_error_code,
    p_brain_turn_id => p_brain_turn_id,
    p_brain_latency_ms => NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finish_ai_brain_live_delivery(uuid, uuid, text, text, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_ai_brain_live_delivery(uuid, uuid, text, text, numeric, text, text, uuid) TO service_role;

-- 7. Update record_ai_messenger_live_outbound:
-- Validates full delivery/source/tenant scope, handles concurrent calls via FOR UPDATE,
-- idempotent by delivery/source and external_ref, prevents different external_ref on same delivery.
-- Requires durable authorized dispatch_started_at (rejects PENDING/unmarked deliveries).
-- Requires canonical meta:Page:MID format matching bound conversation Page and nonempty raw MID.
-- Requires p_actor_type 'AI'.
-- Validates existing/bound interaction scope and canonical ref before reusing.
CREATE OR REPLACE FUNCTION public.record_ai_messenger_live_outbound(
  p_company_id uuid,
  p_customer_id uuid,
  p_conversation_id uuid,
  p_source_interaction_id uuid,
  p_delivery_id uuid,
  p_external_ref text,
  p_content text,
  p_actor_type text DEFAULT 'AI'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery record;
  v_conv record;
  v_bound_interaction record;
  v_candidate record;
  v_existing_interaction_id uuid;
  v_interaction_id uuid;
  v_raw_mid text;
  v_page_id text;
  v_expected_page_id text;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Input validation & actor requirement
  IF p_company_id IS NULL
     OR p_customer_id IS NULL
     OR p_conversation_id IS NULL
     OR p_source_interaction_id IS NULL
     OR p_delivery_id IS NULL
     OR p_external_ref IS NULL
     OR p_content IS NULL
     OR length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  -- Require p_actor_type AI
  IF p_actor_type IS NOT NULL AND p_actor_type <> 'AI' THEN
    RAISE EXCEPTION 'INVALID_ACTOR_TYPE';
  END IF;

  -- 2. Validate external_ref format: accept ONLY canonical meta:Page:MID.
  -- Do not accept raw ref fallback; existing transport already sends canonical refs.
  -- Require nonempty raw MID.
  IF p_external_ref !~ '^meta:[0-9]+:(.+)$' THEN
    RAISE EXCEPTION 'INVALID_EXTERNAL_REF_FORMAT';
  END IF;

  v_page_id := split_part(p_external_ref, ':', 2);
  v_raw_mid := substring(p_external_ref from '^meta:[0-9]+:(.+)$');

  IF v_raw_mid IS NULL OR btrim(v_raw_mid) = '' THEN
    RAISE EXCEPTION 'EMPTY_RAW_MID';
  END IF;

  -- 3. Lock delivery row for update first (serializes concurrent calls on the same delivery)
  SELECT d.id, d.company_id, d.customer_id, d.conversation_id, d.source_interaction_id,
         d.channel, d.send_status, d.dispatch_started_at, d.external_message_id,
         d.outbound_interaction_id
  INTO v_delivery
  FROM public.ai_brain_live_deliveries d
  WHERE d.id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND';
  END IF;

  -- Validate delivery scope
  IF v_delivery.company_id <> p_company_id
     OR v_delivery.customer_id <> p_customer_id
     OR v_delivery.conversation_id <> p_conversation_id
     OR v_delivery.source_interaction_id <> p_source_interaction_id
     OR v_delivery.channel <> 'MESSENGER' THEN
    RAISE EXCEPTION 'DELIVERY_SCOPE_MISMATCH';
  END IF;

  -- First persistence must require durable authorized dispatch_started_at.
  -- Reject PENDING / unmarked deliveries!
  IF v_delivery.dispatch_started_at IS NULL OR v_delivery.send_status = 'PENDING' THEN
    RAISE EXCEPTION 'DISPATCH_NOT_AUTHORIZED';
  END IF;

  -- Enforce provider message ID consistency:
  -- If delivery already has external_message_id recorded, refuse a different raw MID or ref
  IF v_delivery.external_message_id IS NOT NULL THEN
    IF v_delivery.external_message_id <> v_raw_mid AND v_delivery.external_message_id <> p_external_ref THEN
      RAISE EXCEPTION 'DELIVERY_ALREADY_BOUND_TO_DIFFERENT_REF';
    END IF;
  END IF;

  -- 4. Lock and validate conversation row & enforce Page equal to exact bound conversation Page
  SELECT c.id, c.company_id, c.customer_id, c.channel, c.status, c.external_conversation_id
  INTO v_conv
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id
    AND c.customer_id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;

  IF v_conv.channel <> 'FACEBOOK'
     OR v_conv.external_conversation_id IS NULL
     OR v_conv.external_conversation_id !~ '^[0-9]+:[0-9]+$' THEN
    RAISE EXCEPTION 'CONVERSATION_INVALID';
  END IF;

  v_expected_page_id := split_part(v_conv.external_conversation_id, ':', 1);

  -- Same raw MID under a different Page must fail:
  IF v_page_id <> v_expected_page_id THEN
    RAISE EXCEPTION 'PAGE_MISMATCH';
  END IF;

  -- 5. If delivery already has outbound_interaction_id bound, validate it and return (idempotent before/after finish)
  IF v_delivery.outbound_interaction_id IS NOT NULL THEN
    SELECT i.id, i.company_id, i.customer_id, i.conversation_id, i.channel,
           i.type, i.direction, i.actor_type, i.external_ref
    INTO v_bound_interaction
    FROM public.interactions i
    WHERE i.id = v_delivery.outbound_interaction_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'BOUND_INTERACTION_NOT_FOUND';
    END IF;

    -- Validate existing/bound interaction company, customer, conversation, FACEBOOK channel,
    -- MESSAGE type, OUTBOUND direction, AI actor, and canonical external_ref before reusing it.
    -- Reject conflicting reference or scope; never reuse an unrelated same-company interaction.
    IF v_bound_interaction.company_id <> p_company_id
       OR v_bound_interaction.customer_id <> p_customer_id
       OR v_bound_interaction.conversation_id <> p_conversation_id
       OR v_bound_interaction.channel <> 'FACEBOOK'
       OR v_bound_interaction.type <> 'MESSAGE'
       OR v_bound_interaction.direction <> 'OUTBOUND'
       OR v_bound_interaction.actor_type <> 'AI'
       OR v_bound_interaction.external_ref <> p_external_ref THEN
      RAISE EXCEPTION 'BOUND_INTERACTION_SCOPE_MISMATCH';
    END IF;

    RETURN v_bound_interaction.id;
  END IF;

  -- 6. Check existing interactions for this external_ref or matching raw MID across the company
  -- Validate scope and canonical ref before reusing. Reject conflicting reference or scope.
  v_existing_interaction_id := NULL;
  FOR v_candidate IN
    SELECT i.id, i.company_id, i.customer_id, i.conversation_id, i.channel,
           i.type, i.direction, i.actor_type, i.external_ref
    FROM public.interactions i
    WHERE i.company_id = p_company_id
      AND (
        i.external_ref = p_external_ref
        OR i.external_ref LIKE 'meta:%:' || v_raw_mid
        OR i.external_ref = v_raw_mid
      )
  LOOP
    -- Must strictly match canonical external_ref AND exact conversation/customer/direction/actor/channel/type
    IF v_candidate.external_ref <> p_external_ref
       OR v_candidate.customer_id <> p_customer_id
       OR v_candidate.conversation_id <> p_conversation_id
       OR v_candidate.channel <> 'FACEBOOK'
       OR v_candidate.type <> 'MESSAGE'
       OR v_candidate.direction <> 'OUTBOUND'
       OR v_candidate.actor_type <> 'AI' THEN
      RAISE EXCEPTION 'INTERACTION_CONFLICT';
    END IF;
    v_existing_interaction_id := v_candidate.id;
  END LOOP;

  IF v_existing_interaction_id IS NOT NULL THEN
    -- Reuse matching interaction and bind to delivery
    UPDATE public.ai_brain_live_deliveries
    SET external_message_id = COALESCE(external_message_id, v_raw_mid),
        outbound_interaction_id = v_existing_interaction_id,
        updated_at = v_now
    WHERE id = p_delivery_id;

    RETURN v_existing_interaction_id;
  END IF;

  -- 7. Insert OUTBOUND interaction for timeline
  INSERT INTO public.interactions (
    company_id,
    customer_id,
    conversation_id,
    channel,
    type,
    direction,
    sanitized_content,
    sanitization_status,
    sanitized_at,
    sanitizer_version,
    external_ref,
    actor_type,
    actor_user_id,
    created_at
  ) VALUES (
    p_company_id,
    p_customer_id,
    p_conversation_id,
    'FACEBOOK',
    'MESSAGE',
    'OUTBOUND',
    p_content,
    'SUCCEEDED',
    v_now,
    'ai-messenger-live-v1',
    p_external_ref,
    'AI',
    NULL,
    v_now
  )
  RETURNING id INTO v_interaction_id;

  -- 8. Insert raw payload for auditability
  INSERT INTO private.interaction_raw_contents (
    interaction_id,
    company_id,
    raw_content,
    raw_payload,
    source_metadata
  ) VALUES (
    v_interaction_id,
    p_company_id,
    p_content,
    jsonb_build_object('external_ref', p_external_ref, 'raw_mid', v_raw_mid),
    jsonb_build_object(
      'source', 'ai_messenger_live_delivery',
      'delivery_id', p_delivery_id,
      'source_interaction_id', p_source_interaction_id,
      'actor_type', 'AI'
    )
  );

  -- 9. Atomically bind delivery record with raw provider MID and outbound_interaction_id
  UPDATE public.ai_brain_live_deliveries
  SET external_message_id = v_raw_mid,
      outbound_interaction_id = v_interaction_id,
      updated_at = v_now
  WHERE id = p_delivery_id;

  -- 10. Update conversation activity timestamp and status
  UPDATE public.conversations c
  SET last_message_at = greatest(coalesce(c.last_message_at, v_now), v_now),
      status = CASE WHEN c.status = 'AI_HANDLING' THEN 'OPEN' ELSE c.status END
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id;

  -- 11. Resolve Response SLA window if open
  UPDATE public.response_sla_windows
  SET state = 'AI_RESPONDED',
      ai_response_interaction_id = v_interaction_id,
      updated_at = v_now
  WHERE company_id = p_company_id
    AND conversation_id = p_conversation_id
    AND state = 'OPEN';

  RETURN v_interaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_messenger_live_outbound(uuid, uuid, uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_messenger_live_outbound(uuid, uuid, uuid, uuid, uuid, text, text, text) TO service_role;

-- 8. Local/CI compatibility guard for scheduler:
-- In Supabase production environments where pg_cron, pg_net, and vault exist, provision scheduler.
-- Enforces valid DO blocks for scheduling and fail-closed Vault endpoint derivation (no hardcoded URL).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    EXECUTE $setup$
      CREATE SCHEMA IF NOT EXISTS cron_internal;
      REVOKE ALL ON SCHEMA cron_internal FROM PUBLIC, anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA cron_internal TO postgres;

      DO $admin$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
          GRANT USAGE ON SCHEMA cron_internal TO supabase_admin;
        END IF;
      END $admin$;

      CREATE TABLE IF NOT EXISTS cron_internal.ai_brain_live_messenger_dispatch_history (
        request_id bigint PRIMARY KEY,
        dispatched_at timestamptz NOT NULL DEFAULT now()
      );
      REVOKE ALL ON cron_internal.ai_brain_live_messenger_dispatch_history FROM PUBLIC, anon, authenticated, service_role;
      GRANT ALL ON cron_internal.ai_brain_live_messenger_dispatch_history TO postgres;

      DO $admin$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
          GRANT ALL ON cron_internal.ai_brain_live_messenger_dispatch_history TO supabase_admin;
        END IF;
      END $admin$;

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

      DO $admin$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
          GRANT SELECT ON cron_internal.ai_brain_live_messenger_dispatch_status TO supabase_admin;
        END IF;
      END $admin$;

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

        -- Strictly fail closed: NO hard-coded production URL fallback.
        IF v_endpoint IS NULL OR btrim(v_endpoint) = '' THEN
          RAISE EXCEPTION 'INVALID_VAULT_ENDPOINT_CONFIG';
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

      REVOKE ALL ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() FROM PUBLIC;
      REVOKE ALL ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() FROM anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() TO postgres;

      DO $admin$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
          GRANT EXECUTE ON FUNCTION cron_internal.invoke_ai_brain_live_messenger_cron() TO supabase_admin;
        END IF;
      END $admin$;

      -- Schedule recurring 1-minute cron job inside proper PL/pgSQL block
      DO $cron$
      BEGIN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai_brain_live_messenger_worker') THEN
          PERFORM cron.unschedule('ai_brain_live_messenger_worker');
        END IF;

        PERFORM cron.schedule(
          'ai_brain_live_messenger_worker',
          '* * * * *',
          'SELECT cron_internal.invoke_ai_brain_live_messenger_cron();'
        );
      END $cron$;
    $setup$;
  END IF;
END $$;
