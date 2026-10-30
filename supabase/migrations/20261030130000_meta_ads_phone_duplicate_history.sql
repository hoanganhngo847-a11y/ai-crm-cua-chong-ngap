-- Migration: 20261030130000_meta_ads_phone_duplicate_history.sql
-- Description: Meta Ads lead attribution: one customer, many attribution events,
--   duplicate-phone history preservation. Implements Rule C:
--   CASE 1 new phone -> new customer + new touchpoint (NEW_PHONE, not duplicate)
--   CASE 2 unique phone match -> reuse customer + new touchpoint (MARKED duplicate)
--   CASE 3 ambiguous multiple owners -> no arbitrary pick, manual review
--   CASE 4 missing/invalid phone -> lead preserved with NO_PHONE status
--   Append-only, forward-only. No destructive operations.

BEGIN;

-- 1. Phone match audit columns on attribution touchpoints
ALTER TABLE public.lead_attribution_touchpoints
    ADD COLUMN IF NOT EXISTS normalized_phone_match_status text,
    ADD COLUMN IF NOT EXISTS is_duplicate_phone boolean;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'rl_phone_match_status'
    ) THEN
        ALTER TABLE public.lead_attribution_touchpoints
            ADD CONSTRAINT rl_phone_match_status CHECK (
                normalized_phone_match_status IS NULL OR normalized_phone_match_status IN
                ('NEW_PHONE', 'MATCHED_EXISTING', 'AMBIGUOUS_MULTIPLE', 'CONFLICT', 'NO_PHONE')
            );
    END IF;
END $$;

COMMENT ON COLUMN public.lead_attribution_touchpoints.normalized_phone_match_status IS
    'Result of canonical phone matching at lead admission: NEW_PHONE, MATCHED_EXISTING, AMBIGUOUS_MULTIPLE, CONFLICT, NO_PHONE. NULL = channel never applies phone matching.';
COMMENT ON COLUMN public.lead_attribution_touchpoints.is_duplicate_phone IS
    'True when the canonical phone was already present in the tenant for ANY customer before this submission (Rule C CASE 2/3).';

-- Retry scanner for campaign resolution backlog
CREATE INDEX IF NOT EXISTS idx_lead_attribution_pending
    ON public.lead_attribution_touchpoints(company_id)
    WHERE attribution_status = 'PENDING_SYNC';

-- 2. Persist the phone match decision on the durable leadgen event so a
--    retried webhook delivery keeps the exact same match verdict.
ALTER TABLE private.meta_leadgen_events
    ADD COLUMN IF NOT EXISTS phone_match_status text,
    ADD COLUMN IF NOT EXISTS is_duplicate_phone boolean;

-- 3. han_ingest: duplicate-phone customer resolution (Rule C).
--    Messenger and Website semantics are unchanged: customer identity still comes
--    from the channel external_id. Phone-based reuse applies ONLY to Lead Ads
--    intake identities (page:leadgen:<id>), each of which is unique per submission.
CREATE OR REPLACE FUNCTION public.han_ingest(
    p_company uuid,
    p_channel text,
    p_external text,
    p_key text,
    p_name text,
    p_phone text,
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
  v_customer uuid;
  v_phone_customer uuid;
  v_phone_matches integer := 0;
  v_phone_ambiguous boolean := false;
  v_phone_status text := 'NO_PHONE';
  v_phone_dup boolean := false;
  v_leadgen boolean := false;
  v_conversation uuid;
  v_interaction uuid;
  v_existing private.han_intake_events%ROWTYPE;
  v_contact text;
  v_review boolean := false;
BEGIN
  IF p_channel IS NULL OR p_channel NOT IN ('FACEBOOK', 'WEBSITE')
    OR p_safe_status IS NULL OR p_safe_status NOT IN ('SUCCEEDED', 'FAILED')
    OR (p_channel = 'FACEBOOK' AND (p_external IS NULL OR (
        p_external !~ '^[0-9]+:[0-9]+$' AND NOT (
            p_external ~ '^[0-9]+:leadgen:[0-9]+$' AND p_key=p_external AND EXISTS (
                SELECT 1 FROM private.meta_leadgen_events e WHERE e.company_id=p_company
                    AND e.page_id=split_part(p_external,':',1) AND e.leadgen_id=split_part(p_external,':',3)
                    AND e.status='PROCESSING' AND e.lease_until>clock_timestamp()
            )
        )
    )))
    OR (p_channel = 'WEBSITE' AND p_external IS NOT NULL)
    OR p_key IS NULL OR length(p_key) = 0
    OR p_content IS NULL OR p_name IS NULL
    OR length(p_external) > 250
    OR length(p_key) > 500
    OR length(p_content) > 10000
    OR length(p_name) > 100
    OR (p_safe_status = 'FAILED' AND p_safe IS NOT NULL)
    OR (p_safe_status = 'SUCCEEDED' AND p_safe IS NULL)
    OR (
      p_phone IS NOT NULL
      AND p_phone !~ '^\+[1-9][0-9]{7,14}$'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.companies
      WHERE id = p_company AND status = 'ACTIVE'
    )
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  v_leadgen := p_channel = 'FACEBOOK' AND p_external ~ '^[0-9]+:leadgen:[0-9]+$';

  PERFORM pg_advisory_xact_lock(
    hashtextextended('han-intake:' || p_company::text, 0)
  );

  SELECT * INTO v_existing
  FROM private.han_intake_events
  WHERE company_id = p_company
    AND channel = p_channel
    AND event_key = p_key;

  IF FOUND THEN
    IF v_existing.external_identity IS DISTINCT FROM p_external
      OR v_existing.payload->>'content' IS DISTINCT FROM p_content
      OR v_existing.payload->>'phone' IS DISTINCT FROM p_phone
      OR v_existing.payload->>'name' IS DISTINCT FROM p_name
      OR (p_channel = 'WEBSITE' AND v_existing.payload->'source' IS DISTINCT FROM p_payload)
    THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;

    RETURN jsonb_build_object(
      'status', v_existing.status,
      'interaction_id', v_existing.interaction_id
    );
  END IF;

  INSERT INTO private.han_intake_events
  VALUES (
    p_company,
    p_channel,
    p_key,
    p_external,
    jsonb_build_object(
      'source', p_payload,
      'content', p_content,
      'phone', p_phone,
      'name', p_name,
      'occurred_at', p_occurred
    ),
    'RECEIVED',
    NULL,
    now()
  );

  SELECT customer_id INTO v_customer
  FROM public.identities
  WHERE company_id = p_company
    AND channel = p_channel
    AND external_id = p_external
    AND p_channel = 'FACEBOOK';

  -- Rule B/C: count canonical phone owners in THIS tenant only (exact match,
  -- never partial). More than one owner is an ambiguous situation that requires
  -- manual duplicate resolution (Rule C CASE 3); never pick arbitrarily.
  IF p_phone IS NOT NULL THEN
    SELECT COUNT(*) INTO v_phone_matches
    FROM private.customer_private_contacts
    WHERE company_id = p_company
      AND normalized_phone = p_phone;

    IF v_phone_matches = 1 THEN
      SELECT customer_id INTO v_phone_customer
      FROM private.customer_private_contacts
      WHERE company_id = p_company
        AND normalized_phone = p_phone;
    ELSIF v_phone_matches > 1 THEN
      v_phone_ambiguous := true;
    END IF;
  END IF;

  -- Rule C CASE 2: a Lead Ads submission whose canonical phone has exactly one
  -- owner reuses that CRM customer instead of creating a second profile.
  -- Applied only for leadgen intake identities; Messenger/Website keep their
  -- established external-identity semantics.
  IF v_customer IS NULL AND v_phone_customer IS NOT NULL AND v_leadgen THEN
    v_customer := v_phone_customer;
  END IF;

  IF v_customer IS NOT NULL THEN
    SELECT normalized_phone INTO v_contact
    FROM private.customer_private_contacts
    WHERE company_id = p_company
      AND customer_id = v_customer;
  END IF;

  -- Danh tính mâu thuẫn: giữ tin, không tự gộp/sửa liên hệ.
  IF (
    v_phone_customer IS NOT NULL
    AND v_customer IS DISTINCT FROM v_phone_customer
  ) OR (
    v_phone_ambiguous
  ) OR (
    v_contact IS NOT NULL
    AND p_phone IS NOT NULL
    AND v_contact <> p_phone
  ) THEN
    v_review := true;
    UPDATE private.han_intake_events
    SET status = 'IDENTITY_REVIEW'
    WHERE company_id = p_company
      AND channel = p_channel
      AND event_key = p_key;
  END IF;

  IF v_customer IS NULL THEN
    INSERT INTO public.customers (
      company_id, name, source, stage
    )
    VALUES (
      p_company, p_name, p_channel, 'LEAD_NEW'
    )
    RETURNING id INTO v_customer;

    INSERT INTO public.customer_stage_histories (
      company_id, customer_id, from_stage,
      to_stage, actor_type, reason
    )
    VALUES (
      p_company, v_customer, NULL,
      'LEAD_NEW', 'SYSTEM', 'OMNICHANNEL_INTAKE'
    );
  END IF;

  -- Rule C CASE 1/2: report the phone match verdict without ever returning
  -- (or logging) the phone number itself.
  v_phone_status := CASE
    WHEN p_phone IS NULL THEN 'NO_PHONE'
    WHEN v_phone_ambiguous THEN 'AMBIGUOUS_MULTIPLE'
    WHEN v_phone_customer IS NOT NULL
      AND v_customer IS DISTINCT FROM v_phone_customer THEN 'CONFLICT'
    WHEN v_phone_customer IS NOT NULL THEN 'MATCHED_EXISTING'
    ELSE 'NEW_PHONE'
  END;
  v_phone_dup := v_phone_status IN ('MATCHED_EXISTING', 'AMBIGUOUS_MULTIPLE', 'CONFLICT');

  -- Website submissions are intake events, not persistent person identities.
  IF v_review THEN
    INSERT INTO public.audit_logs (
      company_id, action, resource_type, resource_id, customer_id, result
    ) VALUES (
      p_company, 'OMNICHANNEL_IDENTITY_REVIEW', 'Customer',
      v_customer, v_customer, 'SUCCESS'
    );
  END IF;

  IF p_channel = 'FACEBOOK' THEN
    INSERT INTO public.identities (
      company_id, customer_id, channel,
      external_id, verified
    )
    VALUES (
      p_company, v_customer, p_channel,
      p_external, false
    )
    ON CONFLICT (company_id, channel, external_id)
    DO NOTHING;
  END IF;

  -- Ambiguous ownership (CASE 3) never adds another phone binding: an operator
  -- resolves the duplicate first, exactly one owner remains.
  IF p_phone IS NOT NULL
    AND NOT v_phone_ambiguous
    AND v_phone_customer IS NULL
    AND v_contact IS NULL
  THEN
    INSERT INTO private.customer_private_contacts (
      company_id, customer_id,
      normalized_phone, raw_phone, is_verified
    )
    VALUES (
      p_company, v_customer, p_phone, p_phone, false
    );
  END IF;

  IF p_channel = 'FACEBOOK' THEN
    INSERT INTO public.conversations (
      company_id, customer_id, channel,
      external_conversation_id,
      last_message_at, unread_count
    )
    VALUES (
      p_company, v_customer, 'FACEBOOK',
      p_external, p_occurred, 1
    )
    ON CONFLICT (
      company_id, channel, external_conversation_id
    )
    DO UPDATE SET
      last_message_at = greatest(
        public.conversations.last_message_at,
        excluded.last_message_at
      ),
      unread_count = public.conversations.unread_count + 1
    RETURNING id INTO v_conversation;
  END IF;

  INSERT INTO public.interactions (
    company_id, customer_id, conversation_id,
    channel, type, direction,
    sanitized_content, sanitization_status,
    sanitized_at, sanitizer_version,
    external_ref, actor_type, created_at
  )
  VALUES (
    p_company, v_customer, v_conversation,
    p_channel, 'MESSAGE', 'INBOUND',
    p_safe, p_safe_status,
    CASE WHEN p_safe_status = 'SUCCEEDED' THEN now() END,
    'han-bounded-v2',
    p_key, 'CUSTOMER', p_occurred
  )
  RETURNING id INTO v_interaction;

  INSERT INTO private.interaction_raw_contents (
    interaction_id, company_id, raw_content, raw_payload
  )
  VALUES (
    v_interaction, p_company, p_content, p_payload
  );

  UPDATE private.han_intake_events
  SET
    status = CASE
      WHEN status = 'IDENTITY_REVIEW' THEN status
      ELSE 'PROCESSED'
    END,
    interaction_id = v_interaction
  WHERE company_id = p_company
    AND channel = p_channel
    AND event_key = p_key;

  -- Quy ước: phản hồi cho lượt chăm sóc gần nhất trong 7 ngày.
  IF p_channel = 'FACEBOOK' THEN
    UPDATE public.care_deliveries
    SET responded_at = p_occurred, status = 'RESPONDED'
    WHERE id = (
      SELECT d.id
      FROM public.care_deliveries d
      JOIN private.han_outbox o ON o.care_delivery_id = d.id
      WHERE d.company_id = p_company
        AND d.customer_id = v_customer
        AND d.channel = 'FACEBOOK'
        AND o.conversation_id = v_conversation
        AND d.sent_at <= p_occurred
        AND d.sent_at > p_occurred - interval '7 days'
        AND d.status IN (
          'SENT', 'DELIVERED', 'READ',
          'RESPONDED', 'CONVERTED_TO_SALE'
        )
      ORDER BY d.sent_at DESC
      LIMIT 1
    )
    AND responded_at IS NULL
    AND status <> 'CONVERTED_TO_SALE';
  END IF;

  -- TV9 SLA WIRING: Atomically open or reuse Response SLA window for Facebook inbound message
  IF p_channel = 'FACEBOOK' AND p_external ~ '^[0-9]+:[0-9]+$' AND v_conversation IS NOT NULL THEN
    PERFORM public.open_response_sla_window(
      p_company,
      v_conversation,
      v_interaction
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'ACCEPTED',
    'interaction_id', v_interaction,
    'phone_match_status', v_phone_status,
    'is_duplicate_phone', v_phone_dup
  );
END;
$$;

COMMENT ON FUNCTION public.han_ingest(uuid, text, text, text, text, text, text, text, text, timestamptz, jsonb)
  IS 'Ingests omnichannel inbound events. Lead Ads submissions with a canonical phone that exactly matches one tenant customer reuse that customer (Rule C CASE 2); ambiguous multi-owner phones are flagged for manual duplicate resolution (CASE 3); missing or invalid phones are preserved without identity (CASE 4). Messenger and Website semantics are unchanged.';

-- The ACL on this function is preserved from previous forward migrations
-- (EXECUTE for service_role only; revoked from PUBLIC, anon, authenticated).

-- 3b. ingest_meta_leadgen_event: persist the phone match verdict alongside the
--     intake checkpoint so a durable retry replays the exact same verdict
--     without re-running or refetching anything from Meta.
CREATE OR REPLACE FUNCTION public.ingest_meta_leadgen_event(p_company_id uuid,p_leadgen_id text,p_claim_token uuid,p_ingest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_event private.meta_leadgen_events%ROWTYPE; v_args jsonb; v_result jsonb; v_customer uuid;
BEGIN
    SELECT * INTO v_event FROM private.meta_leadgen_events WHERE company_id=p_company_id AND leadgen_id=p_leadgen_id FOR UPDATE;
    IF NOT FOUND OR v_event.status<>'PROCESSING' OR v_event.claim_token IS DISTINCT FROM p_claim_token
        OR v_event.lease_until<=clock_timestamp() OR p_claim_token IS NULL THEN RAISE EXCEPTION 'LEADGEN_LEASE_LOST'; END IF;
    IF v_event.interaction_id IS NOT NULL THEN
        RETURN jsonb_build_object('interaction_id',v_event.interaction_id,'customer_id',v_event.customer_id,
            'phone_match_status',v_event.phone_match_status,'is_duplicate_phone',v_event.is_duplicate_phone);
    END IF;
    v_args := COALESCE(v_event.ingest_args,p_ingest);
    IF v_args IS NULL THEN RAISE EXCEPTION 'MISSING_INGEST_ARGS'; END IF;
    v_result := public.han_ingest(p_company_id,'FACEBOOK',v_event.page_id||':leadgen:'||p_leadgen_id,
        v_event.page_id||':leadgen:'||p_leadgen_id,v_args->>'name',v_args->>'phone',v_args->>'content',
        v_args->>'content','SUCCEEDED',v_event.occurred_at,v_args->'payload');
    IF v_result IS NULL OR (v_result->>'interaction_id') IS NULL
        OR (v_result->>'phone_match_status') IS NULL THEN
        RAISE EXCEPTION 'LEADGEN_INTAKE_INCOMPLETE';
    END IF;
    SELECT i.customer_id INTO STRICT v_customer FROM public.interactions i
        WHERE i.id=(v_result->>'interaction_id')::uuid AND i.company_id=p_company_id;
    UPDATE private.meta_leadgen_events SET ingest_args=v_args, interaction_id=(v_result->>'interaction_id')::uuid,
        customer_id=v_customer, phone_match_status=v_result->>'phone_match_status',
        is_duplicate_phone=COALESCE((v_result->>'is_duplicate_phone')::boolean,false),
        updated_at=clock_timestamp() WHERE id=v_event.id;
    RETURN v_result||jsonb_build_object('customer_id',v_customer);
END $$;
REVOKE ALL ON FUNCTION public.ingest_meta_leadgen_event(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_meta_leadgen_event(uuid,text,uuid,jsonb) TO service_role;

-- 4. record_lead_attribution_touchpoint: keep verified-evidence snapshots;
--    a direct leadgen lead whose campaign cannot be verified from synced
--    records now lands in a resolvable PENDING_SYNC state instead of a final
--    UNATTRIBUTED verdict, so a later safe retry may finish the resolution.
--    Campaign names are still only ever taken from server-synced records.
CREATE OR REPLACE FUNCTION public.record_lead_attribution_touchpoint(
    p_company uuid,
    p_customer uuid DEFAULT NULL,
    p_interaction uuid DEFAULT NULL,
    p_conversation uuid DEFAULT NULL,
    p_channel text DEFAULT 'FACEBOOK_LEAD_ADS',
    p_page_id text DEFAULT NULL,
    p_page_name text DEFAULT NULL,
    p_ad_account_id text DEFAULT NULL,
    p_meta_campaign_id text DEFAULT NULL,
    p_campaign_name text DEFAULT NULL,
    p_meta_ad_set_id text DEFAULT NULL,
    p_ad_set_name text DEFAULT NULL,
    p_meta_ad_id text DEFAULT NULL,
    p_ad_name text DEFAULT NULL,
    p_meta_form_id text DEFAULT NULL,
    p_form_name text DEFAULT NULL,
    p_meta_leadgen_id text DEFAULT NULL,
    p_referral_source text DEFAULT NULL,
    p_referral_type text DEFAULT NULL,
    p_ads_context_data jsonb DEFAULT NULL,
    p_utm_source text DEFAULT NULL,
    p_utm_medium text DEFAULT NULL,
    p_utm_campaign text DEFAULT NULL,
    p_utm_content text DEFAULT NULL,
    p_utm_term text DEFAULT NULL,
    p_fbclid text DEFAULT NULL,
    p_attribution_status text DEFAULT 'UNATTRIBUTED',
    p_attribution_method text DEFAULT 'DIRECT_LEADGEN',
    p_occurred timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_touchpoint_id uuid;
    v_has_previous boolean := false;
    v_type text := 'FIRST_TOUCH';
    v_existing_id uuid;
    v_resolved_campaign_id text;
    v_resolved_ad_set_id text;
    v_resolved_campaign text;
    v_resolved_ad_set text;
    v_resolved_ad text;
    v_resolved_form text;
    v_status text := 'UNATTRIBUTED';
    v_account_id text;
    v_raw jsonb;
    v_occurred timestamptz := COALESCE(p_occurred,now());
BEGIN
    -- 1. STRICT AUTHORIZATION CHECK (Priority 2)
    IF auth.role() = 'authenticated' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.company_members cm
            WHERE cm.company_id = p_company
              AND cm.user_id = auth.uid()
              AND cm.status = 'ACTIVE'
        ) THEN
            RAISE EXCEPTION 'UNAUTHORIZED_COMPANY_ACCESS: user % not authorized for company %', auth.uid(), p_company;
        END IF;
    END IF;

    -- 2. Verify company exists
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company) THEN
        RAISE EXCEPTION 'INVALID_COMPANY_ID: company % does not exist', p_company;
    END IF;

    -- 3. Scope validation for foreign keys
    IF p_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer AND company_id = p_company) THEN
        RAISE EXCEPTION 'CUSTOMER_COMPANY_MISMATCH: customer % does not belong to company %', p_customer, p_company;
    END IF;

    IF p_interaction IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.interactions WHERE id = p_interaction AND company_id = p_company) THEN
        RAISE EXCEPTION 'INTERACTION_COMPANY_MISMATCH: interaction % does not belong to company %', p_interaction, p_company;
    END IF;

    IF p_conversation IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = p_conversation AND company_id = p_company) THEN
        RAISE EXCEPTION 'CONVERSATION_COMPANY_MISMATCH: conversation % does not belong to company %', p_conversation, p_company;
    END IF;

    -- Serialize duplicate leadgen AND first-touch writers (including distinct leads for one customer).
    IF p_meta_leadgen_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('meta-attribution:'||p_company::text||':'||p_meta_leadgen_id,0));
    END IF;
    IF p_customer IS NOT NULL THEN
        PERFORM 1 FROM public.customers WHERE id=p_customer AND company_id=p_company FOR UPDATE;
    END IF;
    IF p_meta_leadgen_id IS NOT NULL THEN
        SELECT id INTO v_existing_id FROM public.lead_attribution_touchpoints
            WHERE company_id=p_company AND meta_leadgen_id=p_meta_leadgen_id;
        IF FOUND THEN RETURN v_existing_id; END IF;
    ELSIF p_interaction IS NOT NULL THEN
        SELECT id INTO v_existing_id FROM public.lead_attribution_touchpoints
            WHERE company_id=p_company AND interaction_id=p_interaction AND channel=p_channel;
        IF FOUND THEN RETURN v_existing_id; END IF;
    END IF;

    -- Names/status in a webhook are assertions, never evidence. Resolve all snapshots
    -- exclusively from server-synced records in this company and the same ad account.
    IF p_meta_ad_id IS NOT NULL THEN
        SELECT c.meta_campaign_id,c.name,a.meta_ad_set_id,NULL::text,a.name,c.ad_account_id
        INTO v_resolved_campaign_id,v_resolved_campaign,v_resolved_ad_set_id,v_resolved_ad_set,v_resolved_ad,v_account_id
        FROM public.meta_ads a
        JOIN public.meta_campaigns c ON c.company_id=a.company_id AND c.meta_campaign_id=a.meta_campaign_id AND c.ad_account_id=a.ad_account_id
        WHERE a.company_id=p_company AND a.meta_ad_id=p_meta_ad_id;
    ELSIF p_meta_campaign_id IS NOT NULL THEN
        SELECT c.meta_campaign_id,c.name,c.ad_account_id
        INTO v_resolved_campaign_id,v_resolved_campaign,v_account_id
        FROM public.meta_campaigns c WHERE c.company_id=p_company AND c.meta_campaign_id=p_meta_campaign_id;
    END IF;
    IF v_resolved_campaign_id IS NOT NULL THEN v_status := 'ATTRIBUTED';
    ELSIF p_meta_leadgen_id IS NOT NULL THEN
        -- Campaign resolution is pending, not final: identifiers stay preserved in
        -- raw_meta and a safe retry (retry_pending_lead_attribution) may complete
        -- resolution after a later asset sync. No campaign name is ever invented.
        v_status := 'PENDING_SYNC';
    ELSIF p_attribution_status IN ('ATTRIBUTED','INFERRED') THEN
        -- Non-leadgen channels (Website UTM / Messenger referral) keep their explicit,
        -- caller-declared status; nothing is derived from unverified names.
        v_status := p_attribution_status;
    END IF;
    IF p_meta_form_id IS NOT NULL THEN
        SELECT f.name INTO v_resolved_form FROM public.meta_lead_forms f
            WHERE f.company_id=p_company AND f.meta_form_id=p_meta_form_id
                AND (p_page_id IS NULL OR f.page_id=p_page_id);
    END IF;
    -- Keep unverified identifiers separately for reconciliation; never put them in
    -- verified campaign keys or snapshots when mapping failed.
    v_raw := COALESCE(p_ads_context_data,'{}'::jsonb)||jsonb_build_object('raw_meta',jsonb_build_object(
        'campaign_id',p_meta_campaign_id,'campaign_name',p_campaign_name,'ad_account_id',p_ad_account_id,
        'adset_id',p_meta_ad_set_id,'adset_name',p_ad_set_name,'ad_id',p_meta_ad_id,'ad_name',p_ad_name,
        'form_id',p_meta_form_id,'form_name',p_form_name));

    -- 7. Determine FIRST_TOUCH vs LATEST_TOUCH
    IF p_customer IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM public.lead_attribution_touchpoints
            WHERE company_id = p_company AND customer_id = p_customer
        ) INTO v_has_previous;

        IF v_has_previous THEN
            v_type := 'LATEST_TOUCH';
        ELSE
            v_type := 'FIRST_TOUCH';
        END IF;
    END IF;

    -- 8. Insert touchpoint
    INSERT INTO public.lead_attribution_touchpoints (
        company_id,
        customer_id,
        interaction_id,
        conversation_id,
        touchpoint_type,
        channel,
        page_id,
        page_name,
        ad_account_id,
        meta_campaign_id,
        campaign_name_snapshot,
        meta_ad_set_id,
        ad_set_name_snapshot,
        meta_ad_id,
        ad_name_snapshot,
        meta_form_id,
        form_name_snapshot,
        meta_leadgen_id,
        referral_source,
        referral_type,
        ads_context_data,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        fbclid,
        attribution_status,
        attribution_method,
        occurred_at,
        created_at
    )
    VALUES (
        p_company,
        p_customer,
        p_interaction,
        p_conversation,
        v_type,
        p_channel,
        p_page_id,
        p_page_name,
        v_account_id,
        v_resolved_campaign_id,
        v_resolved_campaign,
        v_resolved_ad_set_id,
        v_resolved_ad_set,
        p_meta_ad_id,
        v_resolved_ad,
        p_meta_form_id,
        v_resolved_form,
        p_meta_leadgen_id,
        p_referral_source,
        p_referral_type,
        v_raw,
        p_utm_source,
        p_utm_medium,
        p_utm_campaign,
        p_utm_content,
        p_utm_term,
        p_fbclid,
        v_status,
        p_attribution_method,
        v_occurred,
        now()
    )
    RETURNING id INTO v_touchpoint_id;

    -- 9. Update Customer snapshot fields atomically (First-touch strictly preserved)
    IF p_customer IS NOT NULL THEN
        IF NOT v_has_previous THEN
            UPDATE public.customers
            SET
                first_campaign_name = v_resolved_campaign,
                first_ad_name = v_resolved_ad,
                first_touch_at = v_occurred,
                latest_campaign_name = v_resolved_campaign,
                latest_ad_name = v_resolved_ad,
                latest_touch_at = v_occurred,
                attribution_status = v_status,
                updated_at = now()
            WHERE id = p_customer AND company_id = p_company;
        ELSE
            UPDATE public.customers
            SET latest_campaign_name=v_resolved_campaign, latest_ad_name=v_resolved_ad,
                latest_touch_at=v_occurred, attribution_status=v_status, updated_at=now()
            WHERE id=p_customer AND company_id=p_company AND (latest_touch_at IS NULL OR latest_touch_at<=v_occurred);
        END IF;
    END IF;

    RETURN v_touchpoint_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_lead_attribution_touchpoint FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_lead_attribution_touchpoint FROM anon;
REVOKE ALL ON FUNCTION public.record_lead_attribution_touchpoint FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_lead_attribution_touchpoint TO service_role;

-- 5. Persist the phone match verdict on the attribution touchpoint of a specific
--    Meta lead. Idempotent; service_role only; never returns phone data.
CREATE FUNCTION public.mark_lead_attribution_phone_match(
    p_company uuid,
    p_meta_leadgen_id text,
    p_phone_match_status text,
    p_is_duplicate_phone boolean DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows integer;
    v_dup boolean;
BEGIN
    IF p_company IS NULL OR p_meta_leadgen_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_REQUEST';
    END IF;
    IF p_phone_match_status IS NULL OR p_phone_match_status NOT IN
        ('NEW_PHONE','MATCHED_EXISTING','AMBIGUOUS_MULTIPLE','CONFLICT','NO_PHONE')
    THEN
        RAISE EXCEPTION 'INVALID_PHONE_MATCH_STATUS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company) THEN
        RAISE EXCEPTION 'INVALID_COMPANY_ID';
    END IF;
    -- Fence: the intake event for this company must exist.
    IF NOT EXISTS (
        SELECT 1 FROM private.meta_leadgen_events e
        WHERE e.company_id = p_company AND e.leadgen_id = p_meta_leadgen_id
    ) THEN
        RAISE EXCEPTION 'LEADGEN_EVENT_NOT_FOUND';
    END IF;

    v_dup := COALESCE(p_is_duplicate_phone,
        p_phone_match_status IN ('MATCHED_EXISTING','AMBIGUOUS_MULTIPLE','CONFLICT'));

    UPDATE public.lead_attribution_touchpoints t
    SET normalized_phone_match_status = p_phone_match_status,
        is_duplicate_phone = v_dup
    WHERE t.company_id = p_company
      AND t.meta_leadgen_id = p_meta_leadgen_id
      AND (t.normalized_phone_match_status IS DISTINCT FROM p_phone_match_status
           OR t.is_duplicate_phone IS DISTINCT FROM v_dup);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_lead_attribution_phone_match FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_lead_attribution_phone_match FROM anon;
REVOKE ALL ON FUNCTION public.mark_lead_attribution_phone_match FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_lead_attribution_phone_match TO service_role;

-- 6. Safe campaign-resolution retry for pending direct leadgen touchpoints.
--    Resolves only from server-synced ad/campaign records in the same tenant;
--    never invents a campaign name. Idempotent and bounded.
CREATE FUNCTION public.retry_pending_lead_attribution(
    p_company uuid,
    p_max integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row record;
    v_campaign_id text;
    v_campaign_name text;
    v_ad_set_id text;
    v_ad_set_name text;
    v_ad_name text;
    v_account_id text;
    v_resolved integer := 0;
    v_remaining bigint;
    v_checked integer := 0;
    v_first_name text;
    v_first_at timestamptz;
    v_latest_name text;
    v_latest_ad text;
    v_latest_status text;
    v_latest_at timestamptz;
    v_via_ad boolean;
BEGIN
    IF p_company IS NULL THEN
        RAISE EXCEPTION 'INVALID_COMPANY_ID';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company) THEN
        RAISE EXCEPTION 'INVALID_COMPANY_ID';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('meta-attribution-retry:'||p_company::text,0));

    FOR v_row IN
        SELECT t.id, t.customer_id, t.meta_ad_id,
            COALESCE(t.ads_context_data->'raw_meta'->>'campaign_id', t.meta_campaign_id) AS asserted_campaign_id
        FROM public.lead_attribution_touchpoints t
        WHERE t.company_id = p_company
          AND t.attribution_status = 'PENDING_SYNC'
          AND t.channel = 'FACEBOOK_LEAD_ADS'
          AND t.meta_leadgen_id IS NOT NULL
        ORDER BY t.occurred_at
        LIMIT GREATEST(1, LEAST(COALESCE(p_max, 200), 1000))
    LOOP
        v_checked := v_checked + 1;
        v_campaign_id := NULL;
        v_campaign_name := NULL;
        v_ad_set_id := NULL;
        v_ad_set_name := NULL;
        v_ad_name := NULL;
        v_account_id := NULL;
        v_via_ad := false;

        -- Primary evidence: the ad identifier mapped through server-synced records.
        IF v_row.meta_ad_id IS NOT NULL THEN
            SELECT c.meta_campaign_id, c.name, a.meta_ad_set_id, NULL::text, a.name, c.ad_account_id
            INTO v_campaign_id, v_campaign_name, v_ad_set_id, v_ad_set_name, v_ad_name, v_account_id
            FROM public.meta_ads a
            JOIN public.meta_campaigns c
              ON c.company_id = a.company_id
             AND c.meta_campaign_id = a.meta_campaign_id
             AND c.ad_account_id = a.ad_account_id
            WHERE a.company_id = p_company
              AND a.meta_ad_id = v_row.meta_ad_id;
            v_via_ad := v_campaign_id IS NOT NULL;
        END IF;

        -- Fallback evidence: the lead-scoped campaign identifier (webhook assertion)
        -- combined with a server-synced campaign row in the same tenant. Inferred,
        -- never fabricated: the snapshot only mirrors the synced campaign record.
        IF v_campaign_id IS NULL AND v_row.asserted_campaign_id IS NOT NULL THEN
            SELECT c.meta_campaign_id, c.name, c.ad_account_id
            INTO v_campaign_id, v_campaign_name, v_account_id
            FROM public.meta_campaigns c
            WHERE c.company_id = p_company
              AND c.meta_campaign_id = v_row.asserted_campaign_id;
        END IF;

        IF v_campaign_id IS NULL THEN
            -- Keep it pending; future asset syncs can resolve it later.
            CONTINUE;
        END IF;

        UPDATE public.lead_attribution_touchpoints t
        SET meta_campaign_id = v_campaign_id,
            campaign_name_snapshot = v_campaign_name,
            meta_ad_set_id = COALESCE(t.meta_ad_set_id, v_ad_set_id),
            ad_set_name_snapshot = COALESCE(t.ad_set_name_snapshot, v_ad_set_name),
            ad_name_snapshot = COALESCE(t.ad_name_snapshot, v_ad_name),
            ad_account_id = COALESCE(t.ad_account_id, v_account_id),
            attribution_status = CASE WHEN v_via_ad THEN 'ATTRIBUTED' ELSE 'INFERRED' END
        WHERE t.id = v_row.id
          AND t.company_id = p_company
          AND t.attribution_status = 'PENDING_SYNC';

        v_resolved := v_resolved + 1;

        IF v_row.customer_id IS NOT NULL THEN
            -- Recompute the customer's first/latest attribution projections from
            -- the preserved touchpoint history (chronological, oldest wins first-touch).
            SELECT t.campaign_name_snapshot, t.occurred_at
            INTO v_first_name, v_first_at
            FROM public.lead_attribution_touchpoints t
            WHERE t.company_id = p_company AND t.customer_id = v_row.customer_id
            ORDER BY t.occurred_at ASC
            LIMIT 1;
            UPDATE public.customers c
            SET first_campaign_name = v_first_name,
                first_touch_at = v_first_at,
                updated_at = now()
            WHERE c.id = v_row.customer_id AND c.company_id = p_company
              AND v_first_at IS NOT NULL
              AND (c.first_touch_at IS NULL OR c.first_touch_at >= v_first_at);

            SELECT t.campaign_name_snapshot, t.ad_name_snapshot, t.attribution_status, t.occurred_at
            INTO v_latest_name, v_latest_ad, v_latest_status, v_latest_at
            FROM public.lead_attribution_touchpoints t
            WHERE t.company_id = p_company AND t.customer_id = v_row.customer_id
            ORDER BY t.occurred_at DESC
            LIMIT 1;
            UPDATE public.customers c
            SET latest_campaign_name = v_latest_name,
                latest_ad_name = v_latest_ad,
                latest_touch_at = v_latest_at,
                attribution_status = v_latest_status,
                updated_at = now()
            WHERE c.id = v_row.customer_id AND c.company_id = p_company
              AND v_latest_at IS NOT NULL
              AND (c.latest_touch_at IS NULL OR c.latest_touch_at <= v_latest_at);
        END IF;
    END LOOP;

    SELECT COUNT(*) INTO v_remaining
    FROM public.lead_attribution_touchpoints
    WHERE company_id = p_company
      AND attribution_status = 'PENDING_SYNC'
      AND channel = 'FACEBOOK_LEAD_ADS'
      AND meta_leadgen_id IS NOT NULL;

    RETURN jsonb_build_object(
        'company_id', p_company,
        'checked', v_checked,
        'resolved', v_resolved,
        'remaining', v_remaining
    );
END;
$$;

REVOKE ALL ON FUNCTION public.retry_pending_lead_attribution FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retry_pending_lead_attribution FROM anon;
REVOKE ALL ON FUNCTION public.retry_pending_lead_attribution FROM authenticated;
GRANT EXECUTE ON FUNCTION public.retry_pending_lead_attribution TO service_role;

COMMIT;
