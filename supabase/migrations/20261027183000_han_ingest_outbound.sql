-- Migration: 20261027183000_han_ingest_outbound.sql
-- Description: Atomic ingestion of Page-originated outbound Facebook messages (sent outside CRM).
--              Idempotent by external_ref (page_id:mid), resolves open Response SLA windows as
--              SALE_RESPONDED without opening SLA, and never increments customer unread count.

CREATE OR REPLACE FUNCTION public.han_ingest_outbound(
    p_company uuid,
    p_channel text,
    p_page text,
    p_customer_psid text,
    p_key text,
    p_content text,
    p_safe text,
    p_safe_status text,
    p_occurred timestamptz,
    p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_external text := p_page || ':' || p_customer_psid;
  v_customer uuid;
  v_conversation uuid;
  v_interaction uuid;
  v_mid text;
BEGIN
  -- 1. Strict validation
  IF p_channel IS NULL OR p_channel <> 'FACEBOOK'
    OR p_safe_status IS NULL OR p_safe_status NOT IN ('SUCCEEDED', 'FAILED')
    OR p_page IS NULL OR p_page !~ '^[0-9]+$'
    OR p_customer_psid IS NULL OR p_customer_psid !~ '^[0-9]+$'
    OR p_key IS NULL OR length(p_key) = 0
    OR p_content IS NULL
    OR length(p_key) > 500
    OR length(p_content) > 10000
    OR (p_safe_status = 'FAILED' AND p_safe IS NOT NULL)
    OR (p_safe_status = 'SUCCEEDED' AND p_safe IS NULL)
    OR NOT EXISTS (
      SELECT 1 FROM public.companies
      WHERE id = p_company AND status = 'ACTIVE'
    )
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- 2. Advisory lock for serialization on (company, key)
  PERFORM pg_advisory_xact_lock(
    hashtextextended('han-outbound:' || p_company::text || ':' || p_key, 0)
  );

  -- 3. Idempotency check: interaction already recorded under this external_ref
  SELECT id INTO v_interaction
  FROM public.interactions
  WHERE company_id = p_company
    AND channel = 'FACEBOOK'
    AND external_ref = p_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'PROCESSED',
      'interaction_id', v_interaction
    );
  END IF;

  -- 4. Reconciliation with CRM-originated sends:
  -- If this message was sent from CRM, private.han_outbox tracks it by provider_mid
  v_mid := CASE WHEN position(':' in p_key) > 0 THEN split_part(p_key, ':', 2) ELSE p_key END;

  SELECT interaction_id INTO v_interaction
  FROM private.han_outbox
  WHERE company_id = p_company
    AND provider_mid = v_mid;

  IF FOUND THEN
    UPDATE public.interactions
    SET external_ref = p_key
    WHERE id = v_interaction
      AND external_ref IS NULL;

    RETURN jsonb_build_object(
      'status', 'PROCESSED',
      'interaction_id', v_interaction
    );
  END IF;

  -- 5. Resolve Customer and Conversation
  SELECT customer_id INTO v_customer
  FROM public.identities
  WHERE company_id = p_company
    AND channel = 'FACEBOOK'
    AND external_id = v_external;

  IF v_customer IS NULL THEN
    INSERT INTO public.customers (
      company_id, name, source, stage
    ) VALUES (
      p_company, 'Khách Messenger', 'FACEBOOK', 'LEAD_NEW'
    )
    RETURNING id INTO v_customer;

    INSERT INTO public.customer_stage_histories (
      company_id, customer_id, from_stage,
      to_stage, actor_type, reason
    ) VALUES (
      p_company, v_customer, NULL,
      'LEAD_NEW', 'SYSTEM', 'OMNICHANNEL_OUTBOUND'
    );

    INSERT INTO public.identities (
      company_id, customer_id, channel,
      external_id, verified
    ) VALUES (
      p_company, v_customer, 'FACEBOOK',
      v_external, false
    )
    ON CONFLICT (company_id, channel, external_id)
    DO NOTHING;
  END IF;

  INSERT INTO public.conversations (
    company_id, customer_id, channel,
    external_conversation_id,
    last_message_at, unread_count
  ) VALUES (
    p_company, v_customer, 'FACEBOOK',
    v_external, p_occurred, 0
  )
  ON CONFLICT (
    company_id, channel, external_conversation_id
  )
  DO UPDATE SET
    last_message_at = greatest(
      public.conversations.last_message_at,
      excluded.last_message_at
    )
    -- unread_count is NEVER incremented for outbound messages
  RETURNING id INTO v_conversation;

  -- 6. Insert OUTBOUND interaction
  INSERT INTO public.interactions (
    company_id, customer_id, conversation_id,
    channel, type, direction,
    sanitized_content, sanitization_status,
    sanitized_at, sanitizer_version,
    external_ref, actor_type, created_at
  ) VALUES (
    p_company, v_customer, v_conversation,
    'FACEBOOK', 'MESSAGE', 'OUTBOUND',
    p_safe, p_safe_status,
    CASE WHEN p_safe_status = 'SUCCEEDED' THEN now() END,
    'han-bounded-v2',
    p_key, 'SALE', p_occurred
  )
  RETURNING id INTO v_interaction;

  -- 7. Insert raw content into private schema
  INSERT INTO private.interaction_raw_contents (
    interaction_id, company_id, raw_content, raw_payload
  ) VALUES (
    v_interaction, p_company, p_content, p_payload
  );

  -- 8. Resolve active Response SLA window if open (SALE responded outside CRM)
  UPDATE public.response_sla_windows
  SET state = 'SALE_RESPONDED',
      sale_response_interaction_id = v_interaction,
      resolved_at = p_occurred,
      dispatch_state = 'PROVIDER_ACCEPTED',
      dispatch_fenced_until = NULL,
      ai_dispatch_fenced_until = NULL,
      ai_dispatch_token = NULL,
      updated_at = p_occurred
  WHERE conversation_id = v_conversation
    AND state = 'OPEN'
    AND started_at <= p_occurred;

  RETURN jsonb_build_object(
    'status', 'ACCEPTED',
    'interaction_id', v_interaction
  );
END;
$$;

COMMENT ON FUNCTION public.han_ingest_outbound(uuid, text, text, text, text, text, text, text, timestamptz, jsonb)
  IS 'Ingests omnichannel outbound events (Page administrator replies outside CRM). Idempotent, resolves Response SLA if open, and never increments customer unread count.';

REVOKE ALL ON FUNCTION public.han_ingest_outbound(uuid, text, text, text, text, text, text, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_ingest_outbound(uuid, text, text, text, text, text, text, text, timestamptz, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.han_ingest_outbound(uuid, text, text, text, text, text, text, text, timestamptz, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_ingest_outbound(uuid, text, text, text, text, text, text, text, timestamptz, jsonb) TO service_role;
