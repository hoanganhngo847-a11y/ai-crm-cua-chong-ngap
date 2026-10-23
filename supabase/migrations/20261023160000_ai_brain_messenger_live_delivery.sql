-- Migration: 20261023160000_ai_brain_messenger_live_delivery.sql
-- Description: Phase 10 - AI Messenger Live Auto-Reply
--
-- Invariants:
-- 1. Updates enqueue_ai_brain_live_delivery() to support both 'ZALO' and 'FACEBOOK' customer inbound messages:
--    - 'ZALO' checks ai_brain_live_settings for channel = 'ZALO' and enqueues with delivery channel = 'ZALO'.
--    - 'FACEBOOK' checks ai_brain_live_settings for channel = 'MESSENGER' and enqueues with delivery channel = 'MESSENGER'.
--    - Default settings for MESSENGER is disabled (OFF) across tenants.
--    - Preserves all safety guards: ai_mode <> 'PAUSED', assigned_to IS NULL, status NOT IN ('CLOSED', 'PENDING_SALE').
--    - Strict idempotency via ON CONFLICT (source_interaction_id) DO NOTHING.
-- 2. Updates claim_ai_brain_live_deliveries(p_limit, p_lock_token, p_channel) to support optional channel filtering.
-- 3. Provides atomic trusted RPC record_ai_messenger_live_outbound for creating timeline interaction
--    with direction = 'OUTBOUND', actor_type = 'AI', channel = 'FACEBOOK'.

-- 1. Redefine enqueue_ai_brain_live_delivery trigger function to support ZALO and FACEBOOK
CREATE OR REPLACE FUNCTION public.enqueue_ai_brain_live_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_live_channel text;
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

-- 2. Update claim_ai_brain_live_deliveries with optional channel filtering
DROP FUNCTION IF EXISTS public.claim_ai_brain_live_deliveries(integer, uuid);

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

  WITH expired_final AS (
    SELECT d.id
    FROM public.ai_brain_live_deliveries d
    WHERE d.send_status = 'PROCESSING'
      AND d.locked_at < now() - interval '5 minutes'
      AND d.attempts >= 5
      AND (p_channel IS NULL OR d.channel = p_channel)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_brain_live_deliveries d
  SET send_status = 'FAILED',
      error_code = 'BRAIN_TIMEOUT',
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
        AND (p_channel IS NULL OR d.channel = p_channel)
      )
      OR (
        d.send_status = 'PROCESSING'
        AND d.locked_at < now() - interval '5 minutes'
        AND d.attempts < 5
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

-- 3. Atomic RPC to record AI Messenger live outbound interaction
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
  v_interaction_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
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

  -- Check if interaction for this external_ref already exists (idempotency check)
  SELECT i.id INTO v_interaction_id
  FROM public.interactions i
  WHERE i.company_id = p_company_id
    AND i.channel = 'FACEBOOK'
    AND i.external_ref = p_external_ref
  LIMIT 1;

  IF v_interaction_id IS NOT NULL THEN
    RETURN v_interaction_id;
  END IF;

  -- Insert OUTBOUND interaction for timeline
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
    coalesce(p_actor_type, 'AI'),
    NULL,
    v_now
  )
  RETURNING id INTO v_interaction_id;

  -- Insert raw payload for auditability
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
    jsonb_build_object('external_ref', p_external_ref),
    jsonb_build_object(
      'source', 'ai_messenger_live_delivery',
      'delivery_id', p_delivery_id,
      'source_interaction_id', p_source_interaction_id,
      'actor_type', coalesce(p_actor_type, 'AI')
    )
  );

  -- Update conversation activity timestamp and status
  UPDATE public.conversations c
  SET last_message_at = greatest(c.last_message_at, v_now),
      status = CASE WHEN c.status = 'AI_HANDLING' THEN 'OPEN' ELSE c.status END
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id;

  -- Resolve Response SLA window if open
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
