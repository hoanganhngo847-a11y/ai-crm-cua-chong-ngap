-- Migration: 20261002100001_han_finish_send_read_receipt_schema_fix.sql
-- Description:
-- Fix invalid private.han_receipts.read_watermarks reference in han_finish_send.
-- Live schema of private.han_receipts uses:
--   kind = 'READ' AND watermark >= extract(epoch FROM v_row.created_at) * 1000
-- Preserves all previously hardened invariants:
--   1. SENT -> SENT, FAILED -> FAILED, UNKNOWN -> UNCERTAIN in care_deliveries.
--   2. Strict tenant-scoped care_deliveries update (WHERE id = v_row.care_delivery_id AND company_id = p_company).
--   3. Response SLA window strictly bound to dispatch_delivery_id = p_request AND dispatch_owner = 'SALE'.
--   4. Zero fallback to legacy SLA resolver.
--   5. SECURITY DEFINER, SET search_path = '', service_role only.

CREATE OR REPLACE FUNCTION public.han_finish_send(
  p_company uuid,
  p_request uuid,
  p_status text,
  p_mid text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_row private.han_outbox%ROWTYPE;
  v_conversation public.conversations%ROWTYPE;
  v_interaction public.interactions%ROWTYPE;
  v_sent_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_sla_rows integer := 0;
BEGIN
  SELECT * INTO v_row
  FROM private.han_outbox
  WHERE company_id = p_company
    AND request_id = p_request
  FOR UPDATE;

  IF NOT FOUND
      OR p_status NOT IN ('SENT', 'FAILED', 'UNKNOWN')
      OR (
        p_status = 'SENT'
        AND coalesce(length(p_mid), 0) = 0
      )
  THEN
    RAISE EXCEPTION 'INVALID_RESULT';
  END IF;

  IF v_row.status <> 'SENDING' THEN
    RETURN;
  END IF;

  SELECT * INTO v_conversation
  FROM public.conversations
  WHERE id = v_row.conversation_id
    AND company_id = p_company;

  IF p_status = 'SENT' THEN
    v_sent_at := clock_timestamp();

    -- Validate interaction integrity: must be an OUTBOUND MESSAGE
    SELECT * INTO v_interaction
    FROM public.interactions
    WHERE id = v_row.interaction_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    IF v_interaction.type <> 'MESSAGE' THEN
      RAISE EXCEPTION 'INVALID_INTERACTION_TYPE' USING ERRCODE = '22000';
    END IF;

    IF v_interaction.direction <> 'OUTBOUND' THEN
      RAISE EXCEPTION 'INVALID_INTERACTION_DIRECTION' USING ERRCODE = '22000';
    END IF;

    UPDATE private.han_outbox
    SET status = p_status,
        provider_mid = p_mid,
        sent_at = v_sent_at
    WHERE company_id = p_company
      AND request_id = p_request;

    UPDATE public.interactions
    SET external_ref =
          split_part(v_conversation.external_conversation_id, ':', 1)
              || ':' || p_mid
    WHERE id = v_row.interaction_id;

    UPDATE public.conversations
    SET last_message_at = greatest(last_message_at, v_sent_at),
        status = CASE WHEN status = 'AI_HANDLING' THEN 'OPEN' ELSE status END
    WHERE id = v_row.conversation_id;

    -- Update Response SLA window: strictly bound to dispatch_delivery_id == p_request and dispatch_owner = 'SALE'
    -- SOLE transition mechanism; zero fallback to legacy resolver
    UPDATE public.response_sla_windows
    SET state = 'SALE_RESPONDED',
        sale_response_interaction_id = v_row.interaction_id,
        resolved_at = v_sent_at,
        dispatch_owner = 'SALE',
        dispatch_state = 'PROVIDER_ACCEPTED',
        dispatch_fenced_until = NULL,
        ai_dispatch_fenced_until = NULL,
        ai_dispatch_token = NULL,
        updated_at = v_sent_at
    WHERE conversation_id = v_row.conversation_id
      AND (state = 'OPEN' OR (state = 'OPEN' AND dispatch_state = 'UNCERTAIN'))
      AND dispatch_delivery_id = p_request
      AND dispatch_owner = 'SALE';

    GET DIAGNOSTICS v_sla_rows = ROW_COUNT;
    -- If v_sla_rows = 0, p_request was not the active dispatch owner of this window;
    -- outbox is updated above but active SLA window is strictly NOT mutated or resolved.

  ELSIF p_status = 'FAILED' THEN
    UPDATE private.han_outbox
    SET status = p_status,
        provider_mid = p_mid
    WHERE company_id = p_company
      AND request_id = p_request;

    UPDATE public.response_sla_windows
    SET dispatch_owner = 'NONE',
        dispatch_state = 'FAILED',
        dispatch_token = NULL,
        dispatch_fenced_until = NULL,
        dispatch_delivery_id = NULL,
        updated_at = v_now
    WHERE conversation_id = v_row.conversation_id
      AND state = 'OPEN'
      AND dispatch_delivery_id = p_request
      AND dispatch_owner = 'SALE';

  ELSE -- UNKNOWN / network ambiguity
    UPDATE private.han_outbox
    SET status = p_status,
        provider_mid = p_mid
    WHERE company_id = p_company
      AND request_id = p_request;

    UPDATE public.response_sla_windows
    SET dispatch_state = 'UNCERTAIN',
        dispatch_fenced_until = NULL,
        ai_dispatch_fenced_until = NULL,
        updated_at = v_now
    WHERE conversation_id = v_row.conversation_id
      AND state = 'OPEN'
      AND dispatch_delivery_id = p_request
      AND dispatch_owner = 'SALE';
  END IF;

  -- Care delivery updates: NEVER downgrade UNKNOWN to FAILED
  IF v_row.care_delivery_id IS NOT NULL THEN
    UPDATE public.care_deliveries
    SET
      status = CASE
        WHEN p_status = 'SENT' THEN 'SENT'
        WHEN p_status = 'FAILED' THEN 'FAILED'
        ELSE 'UNCERTAIN'
      END,
      sent_at = CASE
        WHEN p_status = 'SENT' THEN v_sent_at
        ELSE NULL
      END,
      external_message_ref = p_mid,
      updated_at = v_now
    WHERE id = v_row.care_delivery_id
      AND company_id = p_company;

    IF p_status = 'SENT' THEN
      UPDATE public.care_deliveries
      SET status = 'DELIVERED', delivered_at = v_sent_at
      WHERE id = v_row.care_delivery_id
        AND company_id = p_company
        AND EXISTS (
          SELECT 1 FROM private.han_receipts r
          WHERE r.company_id = p_company
            AND r.external_identity =
                v_conversation.external_conversation_id
            AND p_mid = ANY(r.mids)
      );

      UPDATE public.care_deliveries
      SET
        status = 'READ',
        delivered_at = coalesce(delivered_at, v_sent_at)
      WHERE id = v_row.care_delivery_id
        AND company_id = p_company
        AND EXISTS (
          SELECT 1 FROM private.han_receipts r
          WHERE r.company_id = p_company
            AND r.external_identity =
                v_conversation.external_conversation_id
            AND r.kind = 'READ'
            AND r.watermark >=
                extract(epoch FROM v_row.created_at) * 1000
      );
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.han_finish_send(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_finish_send(uuid, uuid, text, text) TO service_role;
