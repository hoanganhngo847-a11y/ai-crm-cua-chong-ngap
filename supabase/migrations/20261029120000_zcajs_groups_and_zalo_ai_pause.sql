-- Zalo personal (ZCAJS) groups + temporary AI auto-reply pause.
--
-- 1. Group conversations are first-class CRM conversations:
--    * group thread ids use the `group:<id>` namespace so they can never collide
--      with a personal Zalo UID
--    * group metadata (`is_group`, `group_id`, `group_name`) is persisted on the
--      conversation and merged into observed outbound conversations too
--    * groups never enqueue AI Brain live deliveries
-- 2. AI auto-replies on Zalo are temporarily disabled. Re-enable from
--    /admin/ai (AI Control Center) or docs/sql/zalo-ai-auto-reply-toggle.sql.
--    Pending deliveries are closed out so a later re-enable cannot send stale
--    replies to customers.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Provider fallback names now also cover Zalo group placeholders.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_generic_customer_name(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_name IS NULL
      OR btrim(p_name) = ''
      OR btrim(p_name) ~* '^(Khách hàng|Khách Zalo|Khách hàng Zalo|Khách Zalo OA|Khách hàng Zalo OA|Nhóm Zalo|Facebook User|Unknown|Ẩn danh)($|\s)';
$$;

COMMENT ON FUNCTION public.is_generic_customer_name(text) IS
  'True for provider-generated fallback customer names (including Zalo group placeholders) that may be replaced by a verified display name.';

-- ---------------------------------------------------------------------------
-- 2. Observed native Zalo outbound messages: persist group metadata, use the
--    group display name, and create the identity that inbound ingestion will
--    reuse (previously an outbound-first thread could orphan a customer).
-- ---------------------------------------------------------------------------
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
  v_metadata jsonb := coalesce(p_source_metadata, '{}'::jsonb);
  v_is_group boolean := lower(coalesce(p_source_metadata->>'is_group', 'false')) = 'true';
  v_group_name text := nullif(btrim(coalesce(p_source_metadata->>'group_name', '')), '');
  v_group_id text := nullif(btrim(coalesce(p_source_metadata->>'group_id', '')), '');
  v_customer_name text;
  v_display_metadata jsonb := '{}'::jsonb;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'ZCAJS_COMPANY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  v_peer_id := nullif(btrim(p_external_conversation_id), '');
  v_msg_id := nullif(btrim(p_provider_msg_id), '');
  IF v_peer_id IS NULL OR v_msg_id IS NULL THEN
    RAISE EXCEPTION 'ZCAJS_PEER_AND_MESSAGE_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF v_group_name IS NOT NULL THEN
    v_display_metadata := jsonb_build_object(
      'zalo_display_name', v_group_name,
      'zalo_display_name_source', 'group_info',
      'zalo_display_name_updated_at', v_now
    );
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

  v_external_ref := 'zcajs:self:'
    || CASE WHEN v_is_group THEN 'group:' ELSE '' END
    || v_msg_id;

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
    v_customer_name := coalesce(
      v_group_name,
      CASE
        WHEN v_is_group THEN 'Nhóm Zalo ' || right(coalesce(v_group_id, regexp_replace(v_peer_id, '^group:', '')), 4)
        ELSE 'Khách Zalo ' || right(v_peer_id, 4)
      END
    );

    INSERT INTO public.customers (
      company_id,
      name,
      source,
      stage,
      created_at,
      updated_at
    ) VALUES (
      p_company_id,
      v_customer_name,
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
      ) || v_metadata || v_display_metadata,
      v_now,
      v_now
    )
    RETURNING * INTO v_conversation;
  ELSE
    v_customer_id := v_conversation.customer_id;

    IF v_group_name IS NOT NULL THEN
      UPDATE public.customers
      SET name = v_group_name,
          updated_at = v_now
      WHERE id = v_customer_id
        AND public.is_generic_customer_name(name);
    END IF;

    UPDATE public.conversations
    SET metadata = coalesce(metadata, '{}'::jsonb) || v_metadata || v_display_metadata
    WHERE id = v_conversation.id
      AND company_id = p_company_id;
  END IF;

  -- Keep the identity graph complete even when the first observed message for a
  -- peer came from the native Zalo app instead of an inbound webhook.
  INSERT INTO public.identities (
    company_id,
    customer_id,
    channel,
    external_id,
    verified,
    metadata,
    display_name,
    created_at,
    updated_at
  ) VALUES (
    p_company_id,
    v_customer_id,
    'ZALO',
    v_peer_id,
    false,
    jsonb_build_object('provider', 'zcajs', 'is_group', v_is_group),
    v_group_name,
    v_now,
    v_now
  )
  ON CONFLICT (company_id, channel, external_id) DO UPDATE
    SET display_name = coalesce(public.identities.display_name, excluded.display_name),
        updated_at = v_now;

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
    v_metadata,
    v_metadata,
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
    'origin', 'OBSERVED_ZALO',
    'is_group', v_is_group
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_observed_zcajs_outbound_atomic(
  uuid, text, text, text, text, jsonb, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_observed_zcajs_outbound_atomic(
  uuid, text, text, text, text, jsonb, timestamptz
) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. AI Brain live enqueue: never auto-reply into a Zalo group.
-- ---------------------------------------------------------------------------
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
  -- ZALO: CLOSED, PENDING_SALE, assigned_to, ai_mode = PAUSED, or a group block enqueue.
  -- MESSENGER: PENDING_SALE is permitted; the other guards still block.
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
        OR (v_live_channel = 'ZALO' AND lower(coalesce(c.metadata->>'is_group', 'false')) = 'true')
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

    IF v_page_id IS NULL OR v_page_id !~ '^[0-9]+$' THEN
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

-- ---------------------------------------------------------------------------
-- 4. Temporarily stop AI auto-replies on Zalo.
--    This is the operational switch used by AI Control Center; it is a data
--    change so the deployed app stops replying without a code deployment.
-- ---------------------------------------------------------------------------
UPDATE public.ai_brain_live_settings
SET enabled = false,
    updated_at = clock_timestamp()
WHERE channel = 'ZALO'
  AND enabled = true;

-- Close pending automated Zalo replies so re-enabling AI later cannot deliver
-- stale answers that were generated/queued before the pause.
UPDATE public.ai_brain_live_deliveries
SET send_status = 'SKIPPED',
    error_code = 'AI_ZALO_AUTO_REPLY_DISABLED',
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE channel = 'ZALO'
  AND send_status = 'PENDING';

COMMIT;
