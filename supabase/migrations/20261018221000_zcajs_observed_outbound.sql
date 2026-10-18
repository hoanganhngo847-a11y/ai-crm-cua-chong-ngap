CREATE OR REPLACE FUNCTION public.record_observed_zcajs_outbound_atomic(
  p_company_id uuid,
  p_external_conversation_id text,
  p_provider_msg_id text,
  p_sanitized_content text,
  p_raw_content text DEFAULT '',
  p_source_metadata jsonb DEFAULT '{}'::jsonb,
  p_timestamp timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_conversation public.conversations%ROWTYPE;
  v_existing public.interactions%ROWTYPE;
  v_customer_id uuid;
  v_interaction_id uuid;
  v_existing_delivery public.outbound_deliveries%ROWTYPE;
  v_external_ref text;
  v_peer_id text;
  v_msg_id text;
  v_event_time timestamptz := coalesce(p_timestamp, clock_timestamp());
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'ZCAJS_COMPANY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  v_peer_id := nullif(btrim(p_external_conversation_id), '');
  v_msg_id := nullif(btrim(p_provider_msg_id), '');
  IF v_peer_id IS NULL OR v_msg_id IS NULL THEN
    RAISE EXCEPTION 'ZCAJS_PEER_AND_MESSAGE_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_company_id::text || ':zcajs-observed:' || v_msg_id, 0)
  );

  -- If CRM itself sent this provider message, the canonical interaction already owns it.
  SELECT * INTO v_existing_delivery
  FROM public.outbound_deliveries d
  WHERE d.company_id = p_company_id
    AND d.channel = 'ZALO'
    AND d.provider_message_id = v_msg_id
  ORDER BY d.created_at DESC
  LIMIT 1;

  IF v_existing_delivery.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'conversation_id', v_existing_delivery.conversation_id,
      'interaction_id', v_existing_delivery.interaction_id,
      'customer_id', NULL,
      'is_duplicate', true,
      'origin', 'CRM_DISPATCH'
    );
  END IF;

  v_external_ref := 'zcajs:self:' || v_msg_id;

  SELECT * INTO v_existing
  FROM public.interactions i
  WHERE i.company_id = p_company_id
    AND i.channel = 'ZALO'
    AND i.external_ref = v_external_ref
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'conversation_id', v_existing.conversation_id,
      'interaction_id', v_existing.id,
      'customer_id', v_existing.customer_id,
      'is_duplicate', true,
      'origin', 'OBSERVED_ZALO'
    );
  END IF;

  SELECT * INTO v_conversation
  FROM public.conversations c
  WHERE c.company_id = p_company_id
    AND c.channel = 'ZALO'
    AND c.external_conversation_id = v_peer_id
  FOR UPDATE;

  IF v_conversation.id IS NULL THEN
    INSERT INTO public.customers (
      company_id,
      name,
      source,
      stage,
      created_at,
      updated_at
    ) VALUES (
      p_company_id,
      'Khách Zalo ' || right(v_peer_id, 4),
      'ZALO',
      'LEAD_NEW',
      v_now,
      v_now
    )
    RETURNING id INTO v_customer_id;

    INSERT INTO public.conversations (
      company_id,
      customer_id,
      channel,
      external_conversation_id,
      last_message_at,
      unread_count,
      status,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      p_company_id,
      v_customer_id,
      'ZALO',
      v_peer_id,
      v_event_time,
      0,
      'OPEN',
      jsonb_build_object(
        'provider', 'zcajs',
        'transport', 'ZCAJS',
        'external_user_id', v_peer_id
      ),
      v_now,
      v_now
    )
    RETURNING * INTO v_conversation;
  ELSE
    v_customer_id := v_conversation.customer_id;
  END IF;

  v_interaction_id := gen_random_uuid();

  INSERT INTO public.interactions (
    id,
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
    v_interaction_id,
    p_company_id,
    v_customer_id,
    v_conversation.id,
    'ZALO',
    'MESSAGE',
    'OUTBOUND',
    coalesce(p_sanitized_content, ''),
    'SUCCEEDED',
    v_now,
    'v1',
    v_external_ref,
    'SALE',
    NULL,
    v_event_time
  );

  INSERT INTO private.interaction_raw_contents (
    interaction_id,
    company_id,
    raw_content,
    raw_payload,
    source_metadata,
    created_at
  ) VALUES (
    v_interaction_id,
    p_company_id,
    coalesce(p_raw_content, ''),
    coalesce(p_source_metadata, '{}'::jsonb),
    coalesce(p_source_metadata, '{}'::jsonb),
    v_event_time
  );

  UPDATE public.conversations
  SET last_message_at = greatest(coalesce(last_message_at, v_event_time), v_event_time),
      status = 'OPEN',
      updated_at = v_now
  WHERE id = v_conversation.id
    AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'conversation_id', v_conversation.id,
    'interaction_id', v_interaction_id,
    'customer_id', v_customer_id,
    'is_duplicate', false,
    'origin', 'OBSERVED_ZALO'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_observed_zcajs_outbound_atomic(
  uuid, text, text, text, text, jsonb, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_observed_zcajs_outbound_atomic(
  uuid, text, text, text, text, jsonb, timestamptz
) TO service_role;
