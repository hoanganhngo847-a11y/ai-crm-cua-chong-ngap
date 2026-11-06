-- Migration: 20261106012800_messenger_pending_sale_scoped_activation.sql
-- Purpose: allow Messenger PENDING_SALE through the atomic dispatch fence while
-- preserving the latest enqueue function (including Zalo group/history-ingest guards).
-- This is a new forward migration: the
-- colliding 20261028130000 history is intentionally left untouched.
--
-- Scope: the two explicitly approved Facebook Pages only.
-- Existing disabled tenant settings and disabled canary rows are never re-enabled.
-- Existing cron cadence, confidence settings, and Botcake/other-page behavior
-- are not changed by this migration.

BEGIN;

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
     OR v_conv.status = 'CLOSED'
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

-- Expand the existing page-scoped seeding trigger from the Du học Page to the
-- two approved Pages. The trigger itself already exists from 20261027140000.
-- Its ON CONFLICT DO NOTHING semantics preserve explicit kill switches.
CREATE OR REPLACE FUNCTION public.seed_du_hoc_messenger_canary()
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
  IF v_page_id IS NULL OR v_page_id NOT IN ('1343097708890171', '1026991374010112') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ai_brain_live_canary_allowlist (
    company_id, channel, conversation_id, page_id, enabled
  ) VALUES (
    NEW.company_id, 'MESSENGER', NEW.id, v_page_id, true
  )
  ON CONFLICT (company_id, channel, conversation_id, page_id) DO NOTHING;

  -- Create the tenant kill switch only when it has never been configured. An
  -- operator-disabled setting must remain disabled.
  INSERT INTO public.ai_brain_live_settings (
    company_id, channel, enabled, min_confidence
  ) VALUES (
    NEW.company_id, 'MESSENGER', true, 0.700
  )
  ON CONFLICT (company_id, channel) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Backfill only missing allowlist entries for existing conversations on the
-- approved Pages. Existing disabled entries are deliberately left disabled.
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
  AND public.ai_messenger_page_id(c.external_conversation_id, c.metadata)
      IN ('1343097708890171', '1026991374010112')
ON CONFLICT (company_id, channel, conversation_id, page_id) DO NOTHING;

-- Enable only tenants with conversations on the approved Pages, and only if
-- they have never had an explicit Messenger setting. Existing false settings
-- and configured confidence thresholds remain untouched.
INSERT INTO public.ai_brain_live_settings (
  company_id, channel, enabled, min_confidence
)
SELECT DISTINCT c.company_id, 'MESSENGER', true, 0.700
FROM public.conversations c
WHERE c.channel = 'FACEBOOK'
  AND public.ai_messenger_page_id(c.external_conversation_id, c.metadata)
      IN ('1343097708890171', '1026991374010112')
ON CONFLICT (company_id, channel) DO NOTHING;

COMMIT;
