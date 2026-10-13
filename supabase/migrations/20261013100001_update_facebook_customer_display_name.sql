-- Migration: 20261013100001_update_facebook_customer_display_name.sql
-- Description: Forward migration updating public.ingest_provider_message_atomic with customer display name update semantics
-- Semantics:
--   existing generic customer name + incoming real Facebook display name => update real display name
--   existing manual/custom name + incoming Facebook name => keep existing manual name
--   customer_code is strictly preserved and never changed.
--   Zero data drop, zero table recreate.

CREATE OR REPLACE FUNCTION public.ingest_provider_message_atomic(
  p_company_id uuid,
  p_channel text,
  p_external_user_id text DEFAULT NULL,
  p_sender_name text DEFAULT NULL,
  p_sender_phone text DEFAULT NULL,
  p_external_conversation_id text DEFAULT NULL,
  p_external_ref text DEFAULT NULL,
  p_sanitized_content text DEFAULT '',
  p_raw_content text DEFAULT '',
  p_source_metadata jsonb DEFAULT '{}'::jsonb,
  p_sanitization_status text DEFAULT 'SUCCEEDED',
  p_customer_id uuid DEFAULT NULL
)
RETURNS TABLE (
  interaction_id uuid,
  conversation_id uuid,
  customer_id uuid,
  is_duplicate boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_channel text;
  v_sanitization_status text;
  v_customer_id uuid := NULL;
  v_cust_name text;
  v_normalized_phone text := NULL;
  v_conversation public.conversations%ROWTYPE;
  v_existing_interaction public.interactions%ROWTYPE;
  v_conversation_id uuid;
  v_interaction_id uuid;
  v_ext_conv_id text;
  v_now timestamptz := clock_timestamp();
  v_metadata jsonb := coalesce(p_source_metadata, '{}'::jsonb);
BEGIN
  -- 1. Validate mandatory fields (Fail-Closed)
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_COMPANY_ID';
  END IF;
  IF p_channel IS NULL OR trim(p_channel) = '' THEN
    RAISE EXCEPTION 'p_channel là bắt buộc'
      USING ERRCODE = '22023', HINT = 'MISSING_CHANNEL';
  END IF;

  v_channel := upper(trim(p_channel));
  IF v_channel = 'FB' THEN
    v_channel := 'FACEBOOK';
  ELSIF v_channel = 'ZL' THEN
    v_channel := 'ZALO';
  END IF;

  -- Missing provider user ID / message ID must be rejected before persistence
  IF v_channel IN ('FACEBOOK', 'ZALO') THEN
    IF p_external_user_id IS NULL OR trim(p_external_user_id) = '' THEN
      RAISE EXCEPTION 'MISSING_PROVIDER_USER_ID: Missing required provider user ID for %', v_channel
        USING ERRCODE = '22023', HINT = 'MISSING_PROVIDER_USER_ID';
    END IF;
    IF p_external_ref IS NULL OR trim(p_external_ref) = '' THEN
      RAISE EXCEPTION 'MISSING_PROVIDER_MESSAGE_ID: Missing required provider message ID for %', v_channel
        USING ERRCODE = '22023', HINT = 'MISSING_PROVIDER_MESSAGE_ID';
    END IF;
  END IF;

  -- Canonical sanitization status mapping
  v_sanitization_status := CASE
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) IN ('CLEAN', 'SANITIZED', 'SUCCEEDED') THEN 'SUCCEEDED'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'PENDING' THEN 'PENDING'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'FAILED' THEN 'FAILED'
    WHEN upper(trim(coalesce(p_sanitization_status, 'SUCCEEDED'))) = 'NOT_REQUIRED' THEN 'NOT_REQUIRED'
    ELSE 'SUCCEEDED'
  END;

  -- Chuẩn hóa số điện thoại nếu có
  IF p_sender_phone IS NOT NULL AND trim(p_sender_phone) <> '' THEN
    v_normalized_phone := CASE
      WHEN trim(p_sender_phone) ~ '^0[1-9][0-9]{8}$' THEN '+84' || substring(trim(p_sender_phone) from 2)
      WHEN trim(p_sender_phone) ~ '^\+[1-9][0-9]{7,14}$' THEN trim(p_sender_phone)
      WHEN trim(p_sender_phone) ~ '^84[1-9][0-9]{8}$' THEN '+' || trim(p_sender_phone)
      ELSE '+84' || regexp_replace(trim(p_sender_phone), '[^0-9]', '', 'g')
    END;
  END IF;

  -- Concurrency serialization mutex before Customer creation
  IF p_external_user_id IS NOT NULL AND trim(p_external_user_id) <> '' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_company_id::text || ':' || v_channel || ':' || trim(p_external_user_id), 0)
    );
  END IF;

  IF v_normalized_phone IS NOT NULL AND trim(v_normalized_phone) <> '' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_company_id::text || ':phone:' || v_normalized_phone, 0)
    );
  END IF;

  -- 2. Durable Idempotency Check (under lock)
  IF p_external_ref IS NOT NULL AND trim(p_external_ref) <> '' THEN
    SELECT *
    INTO v_existing_interaction
    FROM public.interactions
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND external_ref = trim(p_external_ref)
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT
        v_existing_interaction.id,
        v_existing_interaction.conversation_id,
        v_existing_interaction.customer_id,
        true;
      RETURN;
    END IF;
  END IF;

  -- 3. 4-Tier Customer Resolution
  IF p_customer_id IS NOT NULL THEN
    SELECT c.id INTO v_customer_id
    FROM public.customers c
    WHERE c.id = p_customer_id AND c.company_id = p_company_id
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND p_external_user_id IS NOT NULL AND trim(p_external_user_id) <> '' THEN
    SELECT idt.customer_id INTO v_customer_id
    FROM public.identities idt
    WHERE idt.company_id = p_company_id
      AND idt.channel = v_channel
      AND idt.external_id = trim(p_external_user_id)
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND v_normalized_phone IS NOT NULL THEN
    SELECT cpc.customer_id INTO v_customer_id
    FROM private.customer_private_contacts cpc
    WHERE cpc.company_id = p_company_id
      AND (cpc.normalized_phone = v_normalized_phone OR cpc.raw_phone = trim(p_sender_phone))
    LIMIT 1;

    IF v_customer_id IS NULL THEN
      v_cust_name := coalesce(nullif(trim(p_sender_name), ''), 'Khách hàng ' || v_channel);
      INSERT INTO public.customers (
        company_id, name, source, stage, created_at, updated_at
      ) VALUES (
        p_company_id, v_cust_name, v_channel, 'LEAD_NEW', v_now, v_now
      ) RETURNING id INTO v_customer_id;

      IF v_normalized_phone ~ '^\+[1-9][0-9]{7,14}$' THEN
        INSERT INTO private.customer_private_contacts (
          company_id, customer_id, raw_phone, normalized_phone, phone_country_code, is_verified, created_at, updated_at
        ) VALUES (
          p_company_id, v_customer_id, trim(p_sender_phone), v_normalized_phone, 'VN', false, v_now, v_now
        ) ON CONFLICT (company_id, normalized_phone) DO NOTHING;
      END IF;

      INSERT INTO public.customer_stage_histories (
        company_id, customer_id, from_stage, to_stage, actor_type, reason, changed_at
      ) VALUES (
        p_company_id, v_customer_id, NULL, 'LEAD_NEW', 'SYSTEM', 'Tự động tạo từ tương tác ' || v_channel, v_now
      );

      IF p_external_user_id IS NOT NULL AND trim(p_external_user_id) <> '' THEN
        INSERT INTO public.identities (
          company_id, customer_id, channel, external_id, verified, metadata, created_at, updated_at
        ) VALUES (
          p_company_id, v_customer_id, v_channel, trim(p_external_user_id), false, '{}'::jsonb, v_now, v_now
        ) ON CONFLICT (company_id, channel, external_id) DO NOTHING;
      END IF;
    END IF;
  END IF;

  IF v_customer_id IS NULL AND p_external_user_id IS NOT NULL AND trim(p_external_user_id) <> '' THEN
    v_cust_name := coalesce(nullif(trim(p_sender_name), ''), 'Khách hàng ' || v_channel);
    INSERT INTO public.customers (
      company_id, name, source, stage, created_at, updated_at
    ) VALUES (
      p_company_id, v_cust_name, v_channel, 'LEAD_NEW', v_now, v_now
    ) RETURNING id INTO v_customer_id;

    INSERT INTO public.identities (
      company_id, customer_id, channel, external_id, verified, metadata, created_at, updated_at
    ) VALUES (
      p_company_id, v_customer_id, v_channel, trim(p_external_user_id), false, '{}'::jsonb, v_now, v_now
    )
    ON CONFLICT (company_id, channel, external_id) DO UPDATE
      SET updated_at = v_now
    RETURNING customer_id INTO v_customer_id;

    INSERT INTO public.customer_stage_histories (
      company_id, customer_id, from_stage, to_stage, actor_type, reason, changed_at
    ) VALUES (
      p_company_id, v_customer_id, NULL, 'LEAD_NEW', 'SYSTEM', 'Tự động tạo từ tương tác ' || v_channel, v_now
    );
  END IF;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Inbound customer resolution failed: Fail-Closed'
      USING ERRCODE = 'P0002', HINT = 'CUSTOMER_RESOLUTION_FAILED';
  END IF;

  -- =========================================================================
  -- CRM Display Name Update Semantics:
  -- existing generic customer name + incoming real Facebook display name => update real display name
  -- existing manual/custom name + incoming Facebook name => keep existing manual name
  -- customer_code is strictly preserved and never changed.
  -- =========================================================================
  IF p_sender_name IS NOT NULL AND trim(p_sender_name) <> '' THEN
    SELECT c.name INTO v_cust_name
    FROM public.customers c
    WHERE c.id = v_customer_id;

    IF (v_cust_name IS NULL OR v_cust_name ~* '^(Khách hàng|Facebook User|Unknown|Ẩn danh)($|\s)')
       AND trim(p_sender_name) !~* '^(Khách hàng|Facebook User|Unknown|Ẩn danh)($|\s)' THEN
      UPDATE public.customers
      SET name = trim(p_sender_name),
          updated_at = v_now
      WHERE id = v_customer_id;
    END IF;
  END IF;

  -- 4. Khóa hoặc tạo mới public.conversations (Lưu trữ và cập nhật metadata)
  IF p_external_conversation_id IS NOT NULL AND trim(p_external_conversation_id) <> '' THEN
    SELECT * INTO v_conversation
    FROM public.conversations
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND external_conversation_id = trim(p_external_conversation_id)
    FOR UPDATE;
  END IF;

  IF v_conversation.id IS NULL AND v_customer_id IS NOT NULL THEN
    SELECT * INTO v_conversation
    FROM public.conversations
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND customer_id = v_customer_id
    FOR UPDATE;
  END IF;

  IF v_conversation.id IS NOT NULL THEN
    UPDATE public.conversations
    SET unread_count = public.conversations.unread_count + 1,
        last_message_at = v_now,
        status = 'OPEN',
        metadata = coalesce(public.conversations.metadata, '{}'::jsonb) || v_metadata,
        updated_at = v_now
    WHERE id = v_conversation.id
      AND company_id = p_company_id
    RETURNING * INTO v_conversation;

    v_conversation_id := v_conversation.id;
  ELSE
    v_ext_conv_id := coalesce(nullif(trim(p_external_conversation_id), ''), v_customer_id::text);

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
      v_channel,
      v_ext_conv_id,
      v_now,
      1,
      'OPEN',
      v_metadata,
      v_now,
      v_now
    )
    ON CONFLICT (company_id, channel, external_conversation_id) DO UPDATE
      SET unread_count = public.conversations.unread_count + 1,
          last_message_at = v_now,
          status = 'OPEN',
          metadata = coalesce(public.conversations.metadata, '{}'::jsonb) || v_metadata,
          updated_at = v_now
    RETURNING id INTO v_conversation_id;
  END IF;

  -- 5. INSERT public.interactions
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
    created_at
  ) VALUES (
    v_interaction_id,
    p_company_id,
    v_customer_id,
    v_conversation_id,
    v_channel,
    'MESSAGE',
    'INBOUND',
    coalesce(p_sanitized_content, ''),
    v_sanitization_status,
    v_now,
    'v1',
    nullif(trim(p_external_ref), ''),
    'CUSTOMER',
    v_now
  );

  -- 6. INSERT private.interaction_raw_contents
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
    v_now
  );

  RETURN QUERY SELECT
    v_interaction_id,
    v_conversation_id,
    v_customer_id,
    false;
END;
$$;

COMMENT ON FUNCTION public.ingest_provider_message_atomic(uuid, text, text, text, text, text, text, text, text, jsonb, text, uuid)
  IS 'ACID Atomic inbound message ingestion with metadata persistence on conversations, customer resolution, interactions, and raw payload storage.';

GRANT EXECUTE ON FUNCTION public.ingest_provider_message_atomic(uuid, text, text, text, text, text, text, text, text, jsonb, text, uuid) TO service_role;
