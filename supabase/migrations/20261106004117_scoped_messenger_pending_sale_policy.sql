-- Scoped Messenger PENDING_SALE policy rollout.
--
-- Product decision (2026-11-06): Messenger may answer PENDING_SALE for the
-- explicitly approved tenant and two Pages below. Zalo retains its PENDING_SALE
-- gate. This migration intentionally does NOT replay the legacy colliding SQL:
-- the active funnel migration owns version 20261028130000, and later migrations
-- have newer Messenger outbound/SLA and handover behavior.
--
-- Safety:
-- - Keep the ledger-owning funnel migration and all prior migrations immutable.
-- - Update only the two Messenger enqueue/dispatch state gates; preserve all
--   current lock, confidence, source, tenant, Page, canary, and once-only checks.
-- - Backfill canary rows only for the approved tenant and Pages.
-- - Preserve pre-existing disabled canary rows and an operator-disabled live
--   setting. Create the setting only when the approved tenant has no row.
-- - Future conversations are allowlisted only for the approved tenant/Pages.
-- - Do not rewrite the existing cron helper or scheduler cadence here.
--
-- Approved tenant: de6a7bf3-b5bc-418d-92d6-f9b241472598
-- Approved Pages: 1343097708890171, 1026991374010112
--
-- This is a normal additive migration for local/CI replay. It is NOT a command
-- to apply this migration to Production.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.ai_brain_live_canary_allowlist') IS NULL
     OR to_regclass('public.ai_brain_live_settings') IS NULL THEN
    RAISE EXCEPTION 'MESSENGER_CANARY_FOUNDATION_MISSING';
  END IF;
  IF to_regprocedure('public.ai_messenger_page_id(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'MESSENGER_PAGE_ID_HELPER_MISSING';
  END IF;
  IF to_regprocedure('public.start_ai_messenger_live_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,text,numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION 'MESSENGER_DISPATCH_FENCE_MISSING';
  END IF;
END
$preflight$;

-- 1. Preserve the current dispatch fence and remove only the Messenger
-- PENDING_SALE block. Zalo is not handled by this RPC.
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

  -- PENDING_SALE is approved only for the explicitly scoped tenant and Pages.
  IF v_conv.status = 'PENDING_SALE'
     AND (
       p_company_id <> 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid
       OR v_conv_page_id NOT IN ('1343097708890171', '1026991374010112')
     ) THEN
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

-- 2. Permit enqueue for Messenger PENDING_SALE while retaining the Zalo gate.
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

    IF v_page_id IS NULL OR v_page_id !~ '^[0-9]+
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

-- 3. Seed only the explicitly approved tenant/Page conversations. DO NOTHING
--    preserves an existing disabled canary row (operator kill switch).
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
WHERE c.company_id = 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid
  AND c.channel = 'FACEBOOK'
  AND public.ai_messenger_page_id(c.external_conversation_id, c.metadata)
      IN ('1343097708890171', '1026991374010112')
ON CONFLICT (company_id, channel, conversation_id, page_id) DO NOTHING;

-- 4. Replace the existing Page seeding trigger function with a tenant-scoped
--    version covering both approved Pages. Do not auto-create or re-enable the
--    live setting from this trigger.
CREATE OR REPLACE FUNCTION public.seed_du_hoc_messenger_canary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page_id text;
BEGIN
  IF NEW.channel IS DISTINCT FROM 'FACEBOOK'
     OR NEW.company_id IS DISTINCT FROM 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid THEN
    RETURN NEW;
  END IF;

  v_page_id := public.ai_messenger_page_id(NEW.external_conversation_id, NEW.metadata);
  IF v_page_id IS NULL OR v_page_id NOT IN ('1343097708890171', '1026991374010112') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ai_brain_live_canary_allowlist (
    company_id, channel, conversation_id, page_id, enabled
  ) VALUES (
    NEW.company_id, 'MESSENGER', NEW.id, v_page_id, true
  )
  ON CONFLICT (company_id, channel, conversation_id, page_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_du_hoc_messenger_canary() IS
  'Seeds Messenger canary rows only for the approved tenant and Pages 1343097708890171 / 1026991374010112; never re-enables disabled canary or live-setting rows.';

-- 5. Create the tenant live setting only when the approved tenant exists and
--    has never had a Messenger setting. Existing enabled=false is an explicit
--    operator decision and is intentionally preserved.
INSERT INTO public.ai_brain_live_settings (
  company_id, channel, enabled, min_confidence
)
SELECT 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid, 'MESSENGER', true, 0.700
WHERE EXISTS (
  SELECT 1 FROM public.companies WHERE id = 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid
)
ON CONFLICT (company_id, channel) DO NOTHING;

COMMIT;
 THEN
      RETURN NEW;
    END IF;

    -- PENDING_SALE is a product exception only for the approved tenant and Pages.
    -- Other Messenger tenants keep their prior state gate even if stale canary rows exist.
    IF EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = NEW.conversation_id
        AND c.company_id = NEW.company_id
        AND c.status = 'PENDING_SALE'
    ) AND (
      NEW.company_id <> 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid
      OR v_page_id NOT IN ('1343097708890171', '1026991374010112')
    ) THEN
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

-- 3. Seed only the explicitly approved tenant/Page conversations. DO NOTHING
--    preserves an existing disabled canary row (operator kill switch).
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
WHERE c.company_id = 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid
  AND c.channel = 'FACEBOOK'
  AND public.ai_messenger_page_id(c.external_conversation_id, c.metadata)
      IN ('1343097708890171', '1026991374010112')
ON CONFLICT (company_id, channel, conversation_id, page_id) DO NOTHING;

-- 4. Replace the existing Page seeding trigger function with a tenant-scoped
--    version covering both approved Pages. Do not auto-create or re-enable the
--    live setting from this trigger.
CREATE OR REPLACE FUNCTION public.seed_du_hoc_messenger_canary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page_id text;
BEGIN
  IF NEW.channel IS DISTINCT FROM 'FACEBOOK'
     OR NEW.company_id IS DISTINCT FROM 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid THEN
    RETURN NEW;
  END IF;

  v_page_id := public.ai_messenger_page_id(NEW.external_conversation_id, NEW.metadata);
  IF v_page_id IS NULL OR v_page_id NOT IN ('1343097708890171', '1026991374010112') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ai_brain_live_canary_allowlist (
    company_id, channel, conversation_id, page_id, enabled
  ) VALUES (
    NEW.company_id, 'MESSENGER', NEW.id, v_page_id, true
  )
  ON CONFLICT (company_id, channel, conversation_id, page_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_du_hoc_messenger_canary() IS
  'Seeds Messenger canary rows only for the approved tenant and Pages 1343097708890171 / 1026991374010112; never re-enables disabled canary or live-setting rows.';

-- 5. Create the tenant live setting only when the approved tenant exists and
--    has never had a Messenger setting. Existing enabled=false is an explicit
--    operator decision and is intentionally preserved.
INSERT INTO public.ai_brain_live_settings (
  company_id, channel, enabled, min_confidence
)
SELECT 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid, 'MESSENGER', true, 0.700
WHERE EXISTS (
  SELECT 1 FROM public.companies WHERE id = 'de6a7bf3-b5bc-418d-92d6-f9b241472598'::uuid
)
ON CONFLICT (company_id, channel) DO NOTHING;

COMMIT;
