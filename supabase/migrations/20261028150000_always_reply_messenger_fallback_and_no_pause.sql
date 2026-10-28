-- Migration: 20261028150000_always_reply_messenger_fallback_and_no_pause.sql
-- Description:
-- 1. Update create_ai_handover_case: keep ai_mode = 'ACTIVE' for FACEBOOK conversations
--    when a handover case is recorded so subsequent messages from the customer are not blocked.
--    Preserves ai_mode = 'PAUSED' for ZALO.
-- 2. Unpause existing Facebook conversations that were paused by previous handover events.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_ai_handover_case(
  p_company_id uuid,
  p_customer_id uuid,
  p_conversation_id uuid,
  p_source_interaction_id uuid,
  p_reason text,
  p_priority text DEFAULT 'NORMAL',
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

  -- Update conversation state: set status = 'PENDING_SALE'
  -- Keep ai_mode = 'ACTIVE' for FACEBOOK so AI continues to auto-reply without pausing!
  UPDATE public.conversations
  SET status = 'PENDING_SALE',
      ai_mode = CASE WHEN v_channel = 'FACEBOOK' THEN 'ACTIVE' ELSE 'PAUSED' END,
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

-- Unpause any existing Facebook conversations where ai_mode was PAUSED by handover
UPDATE public.conversations
SET ai_mode = 'ACTIVE', updated_at = now()
WHERE channel = 'FACEBOOK' AND ai_mode = 'PAUSED' AND assigned_to IS NULL;

COMMIT;
