-- Zalo display-name repair and generic-name semantics.
--
-- Problems fixed:
-- 1. ZCAJS creates fallback names such as "Khách Zalo 3267". Later messages or the
--    contact directory know the real display name, but the old generic-name regex
--    only matched "Khách hàng"/"Facebook User"/"Unknown"/"Ẩn danh", so the fallback
--    name was never replaced.
-- 2. Directory sync updated identities.display_name but not customers.name or the
--    conversation metadata used by the Inbox header.
--
-- Manual/custom customer names are never overwritten. Only names recognised as
-- provider fallbacks are eligible for replacement.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_generic_customer_name(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_name IS NULL
      OR btrim(p_name) = ''
      OR btrim(p_name) ~* '^(Khách hàng|Khách Zalo|Khách hàng Zalo|Khách Zalo OA|Khách hàng Zalo OA|Facebook User|Unknown|Ẩn danh)($|\s)';
$$;

COMMENT ON FUNCTION public.is_generic_customer_name(text) IS
  'True for provider-generated fallback customer names that may be replaced by a verified display name.';

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
  v_legacy_ref text;
  v_legacy_confidence text;
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

  -- 2. Durable Idempotency Check (under lock with confirmed-alias semantics)
  --
  -- Confirmed-alias rule:
  -- When BOTH p_external_ref (canonical meta_mid_v2) AND v_legacy_ref are present
  -- AND they differ, the caller is a v2 worker. The legacy_ref is an UNCONFIRMED
  -- alias guessed from current viewport ordinal which may have shifted due to
  -- Meta DOM virtualization. We MUST NOT suppress a new canonical MID based on
  -- an unconfirmed guessed legacy collision.
  --
  -- The legacy branch only fires safely for:
  -- (a) Pure v1 callers (no v2 canonical ref, only legacy ref)
  -- (b) Edge case where p_external_ref == v_legacy_ref (same identity, no shift risk)
  --
  -- Priority: NO MESSAGE LOSS > one-time duplicate avoidance.

  v_legacy_ref := nullif(trim(coalesce(v_metadata->>'legacy_external_ref', '')), '');
  v_legacy_confidence := nullif(trim(coalesce(v_metadata->>'legacy_alias_confidence', '')), '');

  IF p_external_ref IS NOT NULL AND trim(p_external_ref) <> '' THEN
    -- 1. Always check canonical ref first (100% authoritative identity)
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

    -- 2. If not found by canonical ref, check legacy ref ONLY IF confirmed
    -- (a) Pure legacy match where canonical equals legacy (no shift risk)
    -- (b) OR explicitly confirmed by worker with historical proof (v_legacy_confidence = 'confirmed')
    -- Guessed legacy refs without proof MUST NOT suppress a new canonical MID.
    IF v_legacy_ref IS NOT NULL THEN
      IF v_legacy_ref = trim(p_external_ref) OR v_legacy_confidence = 'confirmed' THEN
        SELECT *
        INTO v_existing_interaction
        FROM public.interactions
        WHERE company_id = p_company_id
          AND channel = v_channel
          AND external_ref = v_legacy_ref
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
    END IF;
  ELSIF v_legacy_ref IS NOT NULL THEN
    -- Pure v1 caller: only legacy ref available, safe to check
    SELECT *
    INTO v_existing_interaction
    FROM public.interactions
    WHERE company_id = p_company_id
      AND channel = v_channel
      AND external_ref = v_legacy_ref
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

    IF public.is_generic_customer_name(v_cust_name)
       AND NOT public.is_generic_customer_name(trim(p_sender_name)) THEN
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


-- Apply a real Zalo display name to every CRM projection for one personal UID.
-- Customer names are only changed when the current name is still a provider fallback.
CREATE OR REPLACE FUNCTION public.apply_zalo_display_name(
  p_company uuid,
  p_external_id text,
  p_display_name text,
  p_source text DEFAULT 'message_dname'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_external_id text := btrim(coalesce(p_external_id, ''));
  v_display_name text := nullif(left(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'), 160), '');
  v_source text := coalesce(nullif(btrim(p_source), ''), 'message_dname');
  v_customer_ids uuid[];
  v_customers integer := 0;
  v_identities integer := 0;
  v_conversations integer := 0;
BEGIN
  IF p_company IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.companies WHERE id = p_company
  ) THEN
    RAISE EXCEPTION 'INVALID_COMPANY';
  END IF;
  IF v_external_id !~ '^[0-9]{5,40}$' THEN
    RAISE EXCEPTION 'INVALID_ZALO_EXTERNAL_ID';
  END IF;

  IF v_display_name IS NULL OR public.is_generic_customer_name(v_display_name) THEN
    RETURN jsonb_build_object(
      'customers', 0,
      'identities', 0,
      'conversations', 0,
      'ignored', true
    );
  END IF;

  -- Identities created by ingest may not carry ZCAJS metadata yet, so collect
  -- customers from every projection of the same personal Zalo UID.
  SELECT coalesce(array_agg(DISTINCT projected.customer_id), '{}'::uuid[])
    INTO v_customer_ids
    FROM (
      SELECT i.customer_id
        FROM public.identities i
       WHERE i.company_id = p_company
         AND i.channel = 'ZALO'
         AND i.external_id = v_external_id
      UNION
      SELECT c.customer_id
        FROM public.conversations c
       WHERE c.company_id = p_company
         AND c.channel = 'ZALO'
         AND c.external_conversation_id = v_external_id
         AND c.customer_id IS NOT NULL
    ) projected;

  IF cardinality(v_customer_ids) > 0 THEN
    UPDATE public.customers c
       SET name = v_display_name,
           updated_at = clock_timestamp()
     WHERE c.company_id = p_company
       AND c.id = ANY(v_customer_ids)
       AND public.is_generic_customer_name(c.name);
    GET DIAGNOSTICS v_customers = ROW_COUNT;
  END IF;

  UPDATE public.identities i
     SET display_name = v_display_name,
         updated_at = clock_timestamp()
   WHERE i.company_id = p_company
     AND i.channel = 'ZALO'
     AND i.external_id = v_external_id
     AND i.display_name IS DISTINCT FROM v_display_name;
  GET DIAGNOSTICS v_identities = ROW_COUNT;

  UPDATE public.conversations c
     SET metadata = coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object(
           'zalo_display_name', v_display_name,
           'zalo_display_name_source', v_source,
           'zalo_display_name_updated_at', clock_timestamp()
         ),
         updated_at = clock_timestamp()
   WHERE c.company_id = p_company
     AND c.channel = 'ZALO'
     AND c.external_conversation_id = v_external_id
     AND lower(coalesce(c.metadata->>'provider', 'zcajs')) = 'zcajs'
     AND (
       coalesce(c.metadata->>'zalo_display_name', '') IS DISTINCT FROM v_display_name
       OR coalesce(c.metadata->>'zalo_display_name_source', '') IS DISTINCT FROM v_source
     );
  GET DIAGNOSTICS v_conversations = ROW_COUNT;

  RETURN jsonb_build_object(
    'customers', v_customers,
    'identities', v_identities,
    'conversations', v_conversations,
    'ignored', false
  );
END $$;

REVOKE ALL ON FUNCTION public.apply_zalo_display_name(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zalo_display_name(uuid, text, text, text)
  TO service_role;

COMMENT ON FUNCTION public.apply_zalo_display_name(uuid, text, text, text) IS
  'Propagates a verified Zalo display name to fallback-named customers, ZCAJS identities and Inbox metadata. Manual customer names are preserved.';

-- Repair every directory candidate for a company. Used after directory sync and as
-- a one-time backfill so historical "Khách Zalo ..." rows are fixed immediately.
CREATE OR REPLACE FUNCTION public.repair_zalo_personal_display_names(p_company uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  row record;
  result jsonb;
  v_customers integer := 0;
  v_identities integer := 0;
  v_conversations integer := 0;
BEGIN
  IF p_company IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.companies WHERE id = p_company
  ) THEN
    RAISE EXCEPTION 'INVALID_COMPANY';
  END IF;

  FOR row IN
    SELECT external_id, display_name
      FROM public.zalo_personal_contact_candidates
     WHERE company_id = p_company
       AND display_name IS NOT NULL
       AND btrim(display_name) <> ''
  LOOP
    result := public.apply_zalo_display_name(
      p_company,
      row.external_id,
      row.display_name,
      'directory'
    );
    v_customers := v_customers + coalesce((result->>'customers')::integer, 0);
    v_identities := v_identities + coalesce((result->>'identities')::integer, 0);
    v_conversations := v_conversations + coalesce((result->>'conversations')::integer, 0);
  END LOOP;

  RETURN jsonb_build_object(
    'customers', v_customers,
    'identities', v_identities,
    'conversations', v_conversations
  );
END $$;

REVOKE ALL ON FUNCTION public.repair_zalo_personal_display_names(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_zalo_personal_display_names(uuid)
  TO service_role;

-- One-time production backfill.
DO $$
DECLARE
  company record;
BEGIN
  FOR company IN
    SELECT DISTINCT company_id
      FROM public.zalo_personal_contact_candidates
     WHERE display_name IS NOT NULL
       AND btrim(display_name) <> ''
  LOOP
    PERFORM public.repair_zalo_personal_display_names(company.company_id);
  END LOOP;
END $$;

-- Recover caller names that were known to the inbound live-voice session but
-- missing from the recording metadata (ZaloCall often hides the name after
-- auto-answer). This lets historical recordings become linkable again.
UPDATE public.zalo_personal_calls pc
   SET remote_display_name = btrim(s.remote_display_name),
       remote_display_name_normalized = public.zalo_normalize_display_name(s.remote_display_name),
       identity_confidence = 'MEDIUM'
  FROM public.zalo_personal_live_voice_sessions s
 WHERE pc.company_id = s.company_id
   AND pc.device_id = s.device_id
   AND pc.local_call_id = s.local_call_id
   AND pc.remote_display_name IS NULL
   AND s.remote_display_name IS NOT NULL
   AND btrim(s.remote_display_name) <> '';

-- Link via an explicitly remembered Zalo identity first.
WITH mapping_matches AS (
  SELECT pc.id, pc.company_id, (array_agg(m.customer_id ORDER BY m.customer_id))[1] AS customer_id
  FROM public.zalo_personal_calls pc
  JOIN public.zalo_customer_identity_mappings m
    ON m.company_id = pc.company_id
   AND m.zalo_account_key = pc.zalo_account_key
   AND m.remote_display_name_normalized = pc.remote_display_name_normalized
   AND m.active
  WHERE pc.customer_id IS NULL
    AND pc.recording_status = 'READY'
    AND pc.remote_display_name_normalized <> ''
  GROUP BY pc.id, pc.company_id
  HAVING count(*) = 1 AND NOT bool_or(m.needs_confirmation)
), linked_by_mapping AS (
  UPDATE public.zalo_personal_calls pc
     SET customer_id = e.customer_id,
         matching_status = 'EXACT',
         identity_ambiguous = false,
         linked_by = NULL,
         linked_at = now()
    FROM mapping_matches e
   WHERE pc.id = e.id
   RETURNING pc.company_id, pc.id, pc.customer_id
)
UPDATE public.zalo_call_transcriptions t
   SET customer_id = l.customer_id, updated_at = now()
  FROM linked_by_mapping l
 WHERE t.company_id = l.company_id AND t.call_id = l.id
   AND t.status IN ('PENDING', 'PROCESSING');

-- Then link only when exactly one CRM customer owns the recovered name.
WITH exact_matches AS (
  SELECT pc.id, pc.company_id, (array_agg(c.id ORDER BY c.id))[1] AS customer_id
  FROM public.zalo_personal_calls pc
  JOIN public.customers c
    ON c.company_id = pc.company_id
   AND public.zalo_search_name(c.name) = public.zalo_search_name(pc.remote_display_name_normalized)
  WHERE pc.customer_id IS NULL
    AND pc.recording_status = 'READY'
    AND pc.remote_display_name_normalized <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM public.zalo_customer_identity_mappings m
      WHERE m.company_id = pc.company_id
        AND m.zalo_account_key = pc.zalo_account_key
        AND m.remote_display_name_normalized = pc.remote_display_name_normalized
        AND m.active
    )
  GROUP BY pc.id, pc.company_id
  HAVING count(*) = 1
), linked_by_name AS (
  UPDATE public.zalo_personal_calls pc
     SET customer_id = e.customer_id,
         matching_status = 'EXACT',
         identity_ambiguous = false,
         linked_by = NULL,
         linked_at = now()
    FROM exact_matches e
   WHERE pc.id = e.id
   RETURNING pc.company_id, pc.id, pc.customer_id
)
UPDATE public.zalo_call_transcriptions t
   SET customer_id = l.customer_id, updated_at = now()
  FROM linked_by_name l
 WHERE t.company_id = l.company_id AND t.call_id = l.id
   AND t.status IN ('PENDING', 'PROCESSING');

COMMIT;
