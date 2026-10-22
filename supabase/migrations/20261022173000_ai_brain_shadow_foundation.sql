-- Phase 4A: AI Brain shadow-mode queue foundation.
--
-- Invariants:
-- - Shadow mode is opt-in per company/channel; an empty settings table means OFF.
-- - Inbound webhooks never call the model synchronously. A DB trigger only enqueues.
-- - Queue rows contain server-owned scope and references, never raw provider payloads or CoT.
-- - Only sanitized inbound customer MESSAGE interactions may enqueue.
-- - service_role may SELECT/INSERT/UPDATE but intentionally may not DELETE.
-- - No customer-facing send path exists in this migration.

CREATE TABLE public.ai_brain_shadow_settings (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('MESSENGER', 'ZALO')),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel)
);

CREATE TRIGGER trg_ai_brain_shadow_settings_updated_at
  BEFORE UPDATE ON public.ai_brain_shadow_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_brain_shadow_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_brain_shadow_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_brain_shadow_settings TO service_role;

CREATE TABLE public.ai_brain_shadow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_interaction_id uuid NOT NULL REFERENCES public.interactions(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('MESSENGER', 'ZALO')),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'SKIPPED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  decision text CHECK (decision IS NULL OR decision IN ('RESPOND', 'HANDOVER', 'NO_REPLY', 'ERROR')),
  draft text,
  confidence numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  handover_required boolean,
  handover_reason text,
  provider text,
  model text,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text CHECK (error_code IS NULL OR error_code IN (
    'BRAIN_UNAVAILABLE', 'BRAIN_TIMEOUT', 'BRAIN_POLICY_DENIED',
    'BRAIN_INVALID_CONTEXT', 'BRAIN_PROVIDER_ERROR'
  )),
  turn_id uuid,
  trace_id uuid,
  tools_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  memory_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_ai_brain_shadow_runs_conversation
    FOREIGN KEY (company_id, customer_id, conversation_id)
    REFERENCES public.conversations(company_id, customer_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_ai_brain_shadow_runs_source UNIQUE (source_interaction_id),
  CHECK (jsonb_typeof(tools_used) = 'array'),
  CHECK (jsonb_typeof(source_references) = 'array'),
  CHECK (jsonb_typeof(memory_references) = 'array'),
  CHECK (draft IS NULL OR char_length(draft) <= 12000),
  CHECK (handover_reason IS NULL OR char_length(handover_reason) <= 1000),
  CHECK (provider IS NULL OR char_length(provider) <= 120),
  CHECK (model IS NULL OR char_length(model) <= 120),
  CHECK ((status = 'PROCESSING') = (lock_token IS NOT NULL)),
  CHECK (status <> 'PROCESSING' OR locked_at IS NOT NULL),
  CHECK (status NOT IN ('COMPLETED', 'SKIPPED', 'FAILED') OR completed_at IS NOT NULL)
);

CREATE INDEX idx_ai_brain_shadow_runs_due
  ON public.ai_brain_shadow_runs (status, available_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX idx_ai_brain_shadow_runs_scope
  ON public.ai_brain_shadow_runs (company_id, customer_id, conversation_id, created_at DESC);
CREATE INDEX idx_ai_brain_shadow_runs_channel
  ON public.ai_brain_shadow_runs (company_id, channel, created_at DESC);

CREATE TRIGGER trg_ai_brain_shadow_runs_updated_at
  BEFORE UPDATE ON public.ai_brain_shadow_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_brain_shadow_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_brain_shadow_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_brain_shadow_runs TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_ai_brain_shadow_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_channel text;
BEGIN
  IF NEW.type <> 'MESSAGE'
     OR NEW.direction <> 'INBOUND'
     OR NEW.actor_type <> 'CUSTOMER'
     OR NEW.conversation_id IS NULL
     OR NEW.sanitization_status <> 'SUCCEEDED'
     OR NEW.sanitized_content IS NULL
     OR btrim(NEW.sanitized_content) = '' THEN
    RETURN NEW;
  END IF;

  v_channel := CASE NEW.channel
    WHEN 'FACEBOOK' THEN 'MESSENGER'
    WHEN 'ZALO' THEN 'ZALO'
    ELSE NULL
  END;
  IF v_channel IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.ai_brain_shadow_settings s
    WHERE s.company_id = NEW.company_id
      AND s.channel = v_channel
      AND s.enabled = true
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ai_brain_shadow_runs (
    company_id, customer_id, conversation_id, source_interaction_id, channel
  ) VALUES (
    NEW.company_id, NEW.customer_id, NEW.conversation_id, NEW.id, v_channel
  )
  ON CONFLICT (source_interaction_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_ai_brain_shadow_run() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_interactions_ai_brain_shadow_enqueue
  AFTER INSERT OR UPDATE OF sanitization_status, sanitized_content ON public.interactions
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_ai_brain_shadow_run();

CREATE OR REPLACE FUNCTION public.claim_ai_brain_shadow_runs(
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
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_lock_token IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT r.id
    FROM public.ai_brain_shadow_runs r
    WHERE (
      r.status = 'PENDING'
      OR (
        r.status = 'FAILED'
        AND r.attempts < 5
        AND r.available_at <= now()
      )
      OR (
        r.status = 'PROCESSING'
        AND r.locked_at < now() - interval '5 minutes'
        AND r.attempts < 5
      )
    )
    ORDER BY r.available_at, r.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.ai_brain_shadow_runs r
    SET status = 'PROCESSING',
        attempts = r.attempts + 1,
        locked_at = now(),
        lock_token = p_lock_token,
        completed_at = NULL,
        updated_at = now()
    FROM candidates c
    WHERE r.id = c.id
    RETURNING r.id, r.company_id, r.customer_id, r.conversation_id,
              r.source_interaction_id, r.channel, r.attempts
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_brain_shadow_runs(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_brain_shadow_runs(integer, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_ai_brain_shadow_run(
  p_id uuid,
  p_lock_token uuid,
  p_status text,
  p_decision text DEFAULT NULL,
  p_draft text DEFAULT NULL,
  p_confidence numeric DEFAULT NULL,
  p_handover_required boolean DEFAULT NULL,
  p_handover_reason text DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_latency_ms integer DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_turn_id uuid DEFAULT NULL,
  p_trace_id uuid DEFAULT NULL,
  p_tools_used jsonb DEFAULT '[]'::jsonb,
  p_source_references jsonb DEFAULT '[]'::jsonb,
  p_memory_references jsonb DEFAULT '[]'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_status NOT IN ('COMPLETED', 'SKIPPED', 'FAILED') THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  UPDATE public.ai_brain_shadow_runs
  SET status = p_status,
      decision = p_decision,
      draft = CASE WHEN p_status = 'COMPLETED' THEN p_draft ELSE NULL END,
      confidence = p_confidence,
      handover_required = p_handover_required,
      handover_reason = p_handover_reason,
      provider = p_provider,
      model = p_model,
      latency_ms = p_latency_ms,
      error_code = p_error_code,
      turn_id = p_turn_id,
      trace_id = p_trace_id,
      tools_used = COALESCE(p_tools_used, '[]'::jsonb),
      source_references = COALESCE(p_source_references, '[]'::jsonb),
      memory_references = COALESCE(p_memory_references, '[]'::jsonb),
      available_at = CASE
        WHEN p_status = 'FAILED' THEN now() + make_interval(secs => LEAST(300, 30 * attempts))
        ELSE available_at
      END,
      completed_at = now(),
      locked_at = NULL,
      lock_token = NULL,
      updated_at = now()
  WHERE id = p_id
    AND status = 'PROCESSING'
    AND lock_token = p_lock_token;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_ai_brain_shadow_run(
  uuid, uuid, text, text, text, numeric, boolean, text, text, text, integer,
  text, uuid, uuid, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_ai_brain_shadow_run(
  uuid, uuid, text, text, text, numeric, boolean, text, text, text, integer,
  text, uuid, uuid, jsonb, jsonb, jsonb
) TO service_role;

COMMENT ON TABLE public.ai_brain_shadow_settings IS
  'Opt-in per-company/channel Shadow Mode switch. Empty table means disabled everywhere.';
COMMENT ON TABLE public.ai_brain_shadow_runs IS
  'Durable AI Brain draft-only shadow queue/results. Never a customer delivery queue.';
COMMENT ON FUNCTION public.enqueue_ai_brain_shadow_run() IS
  'Trigger-only enqueue after sanitized inbound customer message; no model/network work.';
