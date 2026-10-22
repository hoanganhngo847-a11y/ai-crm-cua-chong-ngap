-- Phase 5: AI Brain Zalo Live Auto-Reply Foundation.
--
-- Invariants:
-- - Live auto-reply is opt-in per company for channel ZALO; an empty settings table means OFF.
-- - Inbound webhooks never call the model synchronously. A DB trigger only enqueues.
-- - Queue rows contain server-owned scope and references, never raw provider payloads, CoT, or credentials.
-- - Only sanitized inbound customer MESSAGE interactions on channel ZALO may enqueue.
-- - Deliveries have UNIQUE(source_interaction_id) ensuring at most ONE AI send per inbound message.
-- - Conversations that are CLOSED, PENDING_SALE, or have assigned_to set (human owned) are NOT auto-replied.
-- - service_role may SELECT/INSERT/UPDATE but intentionally may not DELETE.

CREATE TABLE public.ai_brain_live_settings (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('ZALO')),
  enabled boolean NOT NULL DEFAULT false,
  min_confidence numeric(4,3) NOT NULL DEFAULT 0.850 CHECK (min_confidence >= 0 AND min_confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel)
);

CREATE TRIGGER trg_ai_brain_live_settings_updated_at
  BEFORE UPDATE ON public.ai_brain_live_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_brain_live_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_brain_live_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_brain_live_settings TO service_role;

CREATE TABLE public.ai_brain_live_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_interaction_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('ZALO')),
  send_status text NOT NULL DEFAULT 'PENDING'
    CHECK (send_status IN ('PENDING', 'PROCESSING', 'SENT', 'SKIPPED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  decision text CHECK (decision IS NULL OR decision IN ('RESPOND', 'HANDOVER', 'NO_REPLY', 'ERROR')),
  confidence numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  external_message_id text,
  error_code text,
  brain_turn_id uuid,
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_ai_brain_live_deliveries_conversation
    FOREIGN KEY (company_id, customer_id, conversation_id)
    REFERENCES public.conversations(company_id, customer_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ai_brain_live_deliveries_source_interaction
    FOREIGN KEY (company_id, conversation_id, source_interaction_id)
    REFERENCES public.interactions(company_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_ai_brain_live_deliveries_source UNIQUE (source_interaction_id),
  CHECK ((send_status = 'PROCESSING') = (lock_token IS NOT NULL)),
  CHECK (send_status <> 'PROCESSING' OR locked_at IS NOT NULL),
  CHECK (send_status NOT IN ('SENT', 'SKIPPED', 'FAILED') OR completed_at IS NOT NULL),
  CHECK (send_status <> 'SENT' OR sent_at IS NOT NULL)
);

CREATE INDEX idx_ai_brain_live_deliveries_due
  ON public.ai_brain_live_deliveries (send_status, available_at, created_at)
  WHERE send_status IN ('PENDING', 'FAILED');
CREATE INDEX idx_ai_brain_live_deliveries_stale_processing
  ON public.ai_brain_live_deliveries (locked_at, attempts)
  WHERE send_status = 'PROCESSING';
CREATE INDEX idx_ai_brain_live_deliveries_scope
  ON public.ai_brain_live_deliveries (company_id, customer_id, conversation_id, created_at DESC);
CREATE INDEX idx_ai_brain_live_deliveries_channel
  ON public.ai_brain_live_deliveries (company_id, channel, created_at DESC);

CREATE TRIGGER trg_ai_brain_live_deliveries_updated_at
  BEFORE UPDATE ON public.ai_brain_live_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_brain_live_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_brain_live_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_brain_live_deliveries TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_ai_brain_live_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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

  IF NEW.channel <> 'ZALO' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.ai_brain_live_settings s
    WHERE s.company_id = NEW.company_id
      AND s.channel = 'ZALO'
      AND s.enabled = true
  ) THEN
    RETURN NEW;
  END IF;

  -- Guard: Do not enqueue if conversation is closed or currently assigned to a human agent
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = NEW.conversation_id
      AND c.company_id = NEW.company_id
      AND (c.status IN ('CLOSED', 'PENDING_SALE') OR c.assigned_to IS NOT NULL)
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ai_brain_live_deliveries (
    company_id, customer_id, conversation_id, source_interaction_id, channel
  ) VALUES (
    NEW.company_id, NEW.customer_id, NEW.conversation_id, NEW.id, 'ZALO'
  )
  ON CONFLICT (source_interaction_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_ai_brain_live_delivery() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_interactions_ai_brain_live_enqueue
  AFTER INSERT OR UPDATE OF sanitization_status, sanitized_content ON public.interactions
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_ai_brain_live_delivery();

CREATE OR REPLACE FUNCTION public.claim_ai_brain_live_deliveries(
  p_limit integer,
  p_lock_token uuid
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

  WITH expired_final AS (
    SELECT d.id
    FROM public.ai_brain_live_deliveries d
    WHERE d.send_status = 'PROCESSING'
      AND d.locked_at < now() - interval '5 minutes'
      AND d.attempts >= 5
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
      )
      OR (
        d.send_status = 'PROCESSING'
        AND d.locked_at < now() - interval '5 minutes'
        AND d.attempts < 5
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

REVOKE ALL ON FUNCTION public.claim_ai_brain_live_deliveries(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_brain_live_deliveries(integer, uuid) TO service_role;

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
DECLARE
  v_rows_updated integer;
  v_now timestamptz := now();
  v_attempts integer;
  v_backoff_seconds integer;
BEGIN
  IF p_id IS NULL OR p_lock_token IS NULL OR p_send_status IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF p_send_status NOT IN ('SENT', 'SKIPPED', 'FAILED') THEN
    RAISE EXCEPTION 'INVALID_STATUS';
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

    v_backoff_seconds := LEAST(300, 30 * GREATEST(1, v_attempts));

    UPDATE public.ai_brain_live_deliveries d
    SET send_status = 'FAILED',
        decision = p_decision,
        confidence = p_confidence,
        external_message_id = p_external_message_id,
        error_code = p_error_code,
        brain_turn_id = p_brain_turn_id,
        available_at = v_now + (v_backoff_seconds * interval '1 second'),
        completed_at = v_now,
        locked_at = NULL,
        lock_token = NULL,
        updated_at = v_now
    WHERE d.id = p_id
      AND d.lock_token = p_lock_token
      AND d.send_status = 'PROCESSING'
      AND d.locked_at > v_now - interval '5 minutes';

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
    RETURN v_rows_updated = 1;
  END IF;

  UPDATE public.ai_brain_live_deliveries d
  SET send_status = p_send_status,
      decision = p_decision,
      confidence = p_confidence,
      external_message_id = p_external_message_id,
      error_code = p_error_code,
      brain_turn_id = p_brain_turn_id,
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

REVOKE ALL ON FUNCTION public.finish_ai_brain_live_delivery(uuid, uuid, text, text, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_ai_brain_live_delivery(uuid, uuid, text, text, numeric, text, text, uuid) TO service_role;
