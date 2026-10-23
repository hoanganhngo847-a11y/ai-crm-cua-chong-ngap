-- Phase 6: Human Handover Workflow Foundation.
--
-- Invariants:
-- - Javis HANDOVER decisions trigger atomic CRM handover case creation and pause AI.
-- - Conversations have explicit ai_mode ('ACTIVE' | 'PAUSED').
-- - When human agent claims conversation, ai_mode = 'PAUSED', assigned_to is set.
-- - AI inference pre-send recheck aborts if ai_mode = 'PAUSED' or assigned_to is set.
-- - Resume AI is an explicit human action that sets ai_mode = 'ACTIVE' and resolves open cases.
-- - Handover cases are deduplicated per source interaction (UNIQUE(company_id, source_interaction_id)).

-- 1. Add ai_mode to conversations
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_mode text NOT NULL DEFAULT 'ACTIVE'
  CHECK (ai_mode IN ('ACTIVE', 'PAUSED'));

CREATE INDEX IF NOT EXISTS idx_conversations_ai_mode
  ON public.conversations (company_id, ai_mode)
  WHERE ai_mode = 'PAUSED';

-- 2. Create ai_handover_cases
CREATE TABLE public.ai_handover_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_interaction_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'CUSTOMER_REQUESTED_HUMAN',
    'CUSTOMER_COMPLAINT',
    'REFUND_REQUEST',
    'PRICE_QUOTATION_REQUIRED',
    'LEGAL_OR_POLICY',
    'PAYMENT_ISSUE',
    'LOW_CONFIDENCE',
    'INSUFFICIENT_KNOWLEDGE',
    'HIGH_VALUE_LEAD',
    'OTHER'
  )),
  priority text NOT NULL CHECK (priority IN ('URGENT', 'HIGH', 'NORMAL', 'LOW')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'CLAIMED', 'RESOLVED', 'DISMISSED')),
  assigned_to uuid NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  brain_turn_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz NULL,
  resolved_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_ai_handover_cases_customer
    FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ai_handover_cases_conversation
    FOREIGN KEY (company_id, customer_id, conversation_id)
    REFERENCES public.conversations(company_id, customer_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ai_handover_cases_interaction
    FOREIGN KEY (company_id, conversation_id, source_interaction_id)
    REFERENCES public.interactions(company_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_ai_handover_cases_source UNIQUE (company_id, source_interaction_id),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (status <> 'CLAIMED' OR claimed_at IS NOT NULL),
  CHECK (status <> 'CLAIMED' OR assigned_to IS NOT NULL),
  CHECK (status NOT IN ('RESOLVED', 'DISMISSED') OR resolved_at IS NOT NULL)
);

CREATE INDEX idx_ai_handover_cases_queue
  ON public.ai_handover_cases (company_id, status, priority, created_at DESC)
  WHERE status IN ('OPEN', 'CLAIMED');

CREATE INDEX idx_ai_handover_cases_conversation
  ON public.ai_handover_cases (company_id, conversation_id, status);

CREATE INDEX idx_ai_handover_cases_assigned
  ON public.ai_handover_cases (company_id, assigned_to, status)
  WHERE assigned_to IS NOT NULL;

CREATE TRIGGER trg_ai_handover_cases_updated_at
  BEFORE UPDATE ON public.ai_handover_cases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_handover_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_handover_cases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_handover_cases TO service_role;
GRANT SELECT, UPDATE ON public.ai_handover_cases TO authenticated;

CREATE POLICY ai_handover_cases_select_tenant
  ON public.ai_handover_cases
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'BOSS_ADMIN')
    OR public.has_company_role(company_id, 'SALE')
  );

CREATE POLICY ai_handover_cases_update_tenant
  ON public.ai_handover_cases
  FOR UPDATE
  TO authenticated
  USING (
    public.has_company_role(company_id, 'BOSS_ADMIN')
    OR public.has_company_role(company_id, 'SALE')
  )
  WITH CHECK (
    public.has_company_role(company_id, 'BOSS_ADMIN')
    OR public.has_company_role(company_id, 'SALE')
  );

-- 3. Update enqueue trigger function to guard against ai_mode = 'PAUSED'
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
    NEW.company_id, NEW.customer_id, NEW.conversation_id, NEW.id, 'ZALO'
  )
  ON CONFLICT (source_interaction_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- 4. Atomic RPC to create handover case and pause AI on conversation
CREATE OR REPLACE FUNCTION public.create_ai_handover_case(
  p_company_id uuid,
  p_customer_id uuid,
  p_conversation_id uuid,
  p_source_interaction_id uuid,
  p_reason text,
  p_priority text,
  p_brain_turn_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_case_id uuid;
  v_channel text;
BEGIN
  IF p_company_id IS NULL OR p_customer_id IS NULL OR p_conversation_id IS NULL OR p_source_interaction_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  IF p_reason NOT IN (
    'CUSTOMER_REQUESTED_HUMAN', 'CUSTOMER_COMPLAINT', 'REFUND_REQUEST',
    'PRICE_QUOTATION_REQUIRED', 'LEGAL_OR_POLICY', 'PAYMENT_ISSUE',
    'LOW_CONFIDENCE', 'INSUFFICIENT_KNOWLEDGE', 'HIGH_VALUE_LEAD', 'OTHER'
  ) THEN
    RAISE EXCEPTION 'INVALID_HANDOVER_REASON';
  END IF;

  IF p_priority NOT IN ('URGENT', 'HIGH', 'NORMAL', 'LOW') THEN
    RAISE EXCEPTION 'INVALID_HANDOVER_PRIORITY';
  END IF;

  -- Verify conversation exists
  SELECT channel INTO v_channel
  FROM public.conversations
  WHERE id = p_conversation_id
    AND company_id = p_company_id
    AND customer_id = p_customer_id;

  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;

  -- Insert or update existing case for this interaction
  INSERT INTO public.ai_handover_cases (
    company_id, customer_id, conversation_id, source_interaction_id,
    reason, priority, status, brain_turn_id, metadata, created_at, updated_at
  ) VALUES (
    p_company_id, p_customer_id, p_conversation_id, p_source_interaction_id,
    p_reason, p_priority, 'OPEN', p_brain_turn_id, coalesce(p_metadata, '{}'::jsonb), now(), now()
  )
  ON CONFLICT (company_id, source_interaction_id) DO UPDATE
    SET priority = CASE
          WHEN EXCLUDED.priority = 'URGENT' THEN 'URGENT'
          WHEN ai_handover_cases.priority = 'URGENT' THEN 'URGENT'
          WHEN EXCLUDED.priority = 'HIGH' THEN 'HIGH'
          ELSE ai_handover_cases.priority
        END,
        updated_at = now()
  RETURNING id INTO v_case_id;

  IF v_case_id IS NULL THEN
    SELECT id INTO v_case_id
    FROM public.ai_handover_cases
    WHERE company_id = p_company_id AND source_interaction_id = p_source_interaction_id;
  END IF;

  -- Update conversation state: set status = 'PENDING_SALE', ai_mode = 'PAUSED'
  UPDATE public.conversations
  SET status = 'PENDING_SALE',
      ai_mode = 'PAUSED',
      updated_at = now()
  WHERE id = p_conversation_id
    AND company_id = p_company_id;

  -- Record timeline event if not already recorded
  IF NOT EXISTS (
    SELECT 1 FROM public.interactions
    WHERE company_id = p_company_id
      AND conversation_id = p_conversation_id
      AND external_ref = 'handover:' || p_source_interaction_id::text
  ) THEN
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
      external_ref,
      actor_type,
      created_at
    ) VALUES (
      p_company_id,
      p_customer_id,
      p_conversation_id,
      v_channel,
      'STATUS_EVENT',
      'OUTBOUND',
      'AI Handover: ' || p_reason || ' [' || p_priority || ']',
      'SUCCEEDED',
      now(),
      'handover:' || p_source_interaction_id::text,
      'AI',
      now()
    );
  END IF;

  RETURN v_case_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_ai_handover_case(uuid, uuid, uuid, uuid, text, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_ai_handover_case(uuid, uuid, uuid, uuid, text, text, uuid, jsonb) TO service_role, authenticated;

-- 5. Atomic RPC for human agent to claim handover case
CREATE OR REPLACE FUNCTION public.claim_ai_handover_case(
  p_company_id uuid,
  p_case_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conv_id uuid;
  v_customer_id uuid;
  v_channel text;
BEGIN
  IF p_company_id IS NULL OR p_case_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- Lock and update the case
  UPDATE public.ai_handover_cases
  SET status = 'CLAIMED',
      assigned_to = p_user_id,
      claimed_at = now(),
      updated_at = now()
  WHERE id = p_case_id
    AND company_id = p_company_id
    AND status = 'OPEN'
  RETURNING conversation_id, customer_id INTO v_conv_id, v_customer_id;

  IF v_conv_id IS NULL THEN
    RETURN false;
  END IF;

  -- Update conversation: assign to agent, pause AI, set PENDING_SALE
  UPDATE public.conversations
  SET assigned_to = p_user_id,
      ai_mode = 'PAUSED',
      status = 'PENDING_SALE',
      updated_at = now()
  WHERE id = v_conv_id
    AND company_id = p_company_id;

  -- Insert status interaction into timeline
  SELECT channel INTO v_channel FROM public.conversations WHERE id = v_conv_id;
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
    actor_type,
    actor_user_id,
    created_at
  ) VALUES (
    p_company_id,
    v_customer_id,
    v_conv_id,
    coalesce(v_channel, 'ZALO'),
    'STATUS_EVENT',
    'OUTBOUND',
    'Chuyên viên đã nhận xử lý hội thoại từ hàng đợi AI.',
    'SUCCEEDED',
    now(),
    'SALE',
    p_user_id,
    now()
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_handover_case(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_ai_handover_case(uuid, uuid, uuid) TO service_role, authenticated;

-- 6. Atomic RPC to resume AI auto-reply
CREATE OR REPLACE FUNCTION public.resume_ai_conversation(
  p_company_id uuid,
  p_conversation_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_id uuid;
  v_channel text;
BEGIN
  IF p_company_id IS NULL OR p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- Update conversation: set ai_mode = 'ACTIVE' and clear assigned_to
  UPDATE public.conversations
  SET ai_mode = 'ACTIVE',
      assigned_to = NULL,
      status = CASE WHEN status = 'PENDING_SALE' THEN 'OPEN' ELSE status END,
      updated_at = now()
  WHERE id = p_conversation_id
    AND company_id = p_company_id
  RETURNING customer_id, channel INTO v_customer_id, v_channel;

  IF v_customer_id IS NULL THEN
    RETURN false;
  END IF;

  -- Resolve any open or claimed cases for this conversation
  UPDATE public.ai_handover_cases
  SET status = 'RESOLVED',
      resolved_at = now(),
      updated_at = now()
  WHERE conversation_id = p_conversation_id
    AND company_id = p_company_id
    AND status IN ('OPEN', 'CLAIMED');

  -- Insert status interaction
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
    actor_type,
    actor_user_id,
    created_at
  ) VALUES (
    p_company_id,
    v_customer_id,
    p_conversation_id,
    coalesce(v_channel, 'ZALO'),
    'STATUS_EVENT',
    'OUTBOUND',
    'AI Auto-Reply đã được kích hoạt lại cho hội thoại này.',
    'SUCCEEDED',
    now(),
    'SYSTEM',
    p_user_id,
    now()
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.resume_ai_conversation(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resume_ai_conversation(uuid, uuid, uuid) TO service_role, authenticated;
