-- Native Zalo timestamps and recovery imports share the existing atomic ingest.
-- A transaction-local guard prevents a history repair from generating AI replies.
CREATE OR REPLACE FUNCTION public.ingest_zcajs_message_atomic(
  p_company_id uuid, p_channel text, p_external_user_id text,
  p_sender_name text DEFAULT NULL, p_sender_phone text DEFAULT NULL,
  p_external_conversation_id text DEFAULT NULL, p_external_ref text DEFAULT NULL,
  p_sanitized_content text DEFAULT '', p_raw_content text DEFAULT '',
  p_source_metadata jsonb DEFAULT '{}'::jsonb, p_sanitization_status text DEFAULT 'SUCCEEDED',
  p_customer_id uuid DEFAULT NULL
) RETURNS TABLE (interaction_id uuid, conversation_id uuid, customer_id uuid, is_duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_result record;
  v_timestamp timestamptz := clock_timestamp();
  v_previous text := coalesce(current_setting('app.zcajs_history_ingest', true), 'false');
BEGIN
  IF upper(p_channel) <> 'ZALO' OR p_source_metadata->>'transport' IS DISTINCT FROM 'ZCAJS' THEN
    RAISE EXCEPTION 'ZCAJS_SOURCE_REQUIRED';
  END IF;
  BEGIN
    v_timestamp := coalesce(nullif(p_source_metadata->>'provider_timestamp', '')::timestamptz, v_timestamp);
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    v_timestamp := clock_timestamp();
  END;
  -- Future provider clocks cannot push a conversation permanently to the top.
  v_timestamp := least(v_timestamp, clock_timestamp());
  PERFORM set_config('app.zcajs_history_ingest',
    CASE WHEN p_source_metadata->>'recovered' = 'true' OR v_timestamp < clock_timestamp() - interval '2 minutes'
         THEN 'true' ELSE 'false' END, true);
  SELECT * INTO v_result FROM public.ingest_provider_message_atomic(
    p_company_id, p_channel, p_external_user_id, p_sender_name, p_sender_phone,
    p_external_conversation_id, p_external_ref, p_sanitized_content, p_raw_content,
    p_source_metadata, p_sanitization_status, p_customer_id);
  IF NOT v_result.is_duplicate THEN
    UPDATE public.interactions SET created_at = v_timestamp
     WHERE id = v_result.interaction_id AND company_id = p_company_id;
    UPDATE public.conversations SET last_message_at = (
      SELECT max(i.created_at) FROM public.interactions i
       WHERE i.conversation_id = v_result.conversation_id AND i.company_id = p_company_id
    ) WHERE id = v_result.conversation_id AND company_id = p_company_id;
  END IF;
  PERFORM set_config('app.zcajs_history_ingest', v_previous, true);
  RETURN QUERY SELECT v_result.interaction_id::uuid, v_result.conversation_id::uuid,
                      v_result.customer_id::uuid, v_result.is_duplicate::boolean;
END;
$$;
REVOKE ALL ON FUNCTION public.ingest_zcajs_message_atomic(uuid,text,text,text,text,text,text,text,text,jsonb,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_zcajs_message_atomic(uuid,text,text,text,text,text,text,text,text,jsonb,text,uuid) TO service_role;

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
  IF NEW.channel = 'ZALO' AND current_setting('app.zcajs_history_ingest', true) = 'true' THEN
    RETURN NEW;
  END IF;
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
