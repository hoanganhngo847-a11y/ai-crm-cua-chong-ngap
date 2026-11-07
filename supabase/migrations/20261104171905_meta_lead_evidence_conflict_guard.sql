-- Forward-only remediation: conflicting intake evidence is a permanent veto.
-- Campaign assertions cannot resolve a Lead Ads event without a synced Ad mapping.
-- Description: Require same-Page Meta creative evidence before Lead Ads attribution
--   or pending-attribution retry. Unverified/mismatched events remain durable and
--   PENDING_SYNC; Messenger behavior and other channels are unchanged.
BEGIN;

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
SET search_path = ''
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
    v_page_verified boolean := false;
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

    -- Names/status in a webhook are assertions, never evidence. For Instant Forms,
    -- additionally require the Meta-fetched creative to identify this exact Page and Ad.
    -- Missing/conflicting Page evidence preserves the lead as PENDING_SYNC but cannot
    -- produce an attributed campaign.
    IF p_channel = 'FACEBOOK_LEAD_ADS' OR p_meta_leadgen_id IS NOT NULL THEN
        v_page_verified := COALESCE(
            NULLIF(btrim(p_page_id), '') IS NOT NULL
            AND NULLIF(btrim(p_meta_ad_id), '') IS NOT NULL
            AND p_meta_leadgen_id IS NOT NULL
            AND COALESCE(p_ads_context_data->>'leadgen_ad_id_conflict', 'false') = 'false'
            AND COALESCE(p_ads_context_data->>'leadgen_page_evidence_conflict', 'false') = 'false'
            AND NOT COALESCE(
                p_ads_context_data->'creative_snapshot'->>'captureTiming' = 'AT_LEAD_INTAKE' AND (
                    COALESCE(p_ads_context_data->'creative_snapshot'->>'pageIdConflict', 'false') <> 'false'
                    OR p_ads_context_data->'creative_snapshot'->>'pageId' <> p_page_id
                    OR p_ads_context_data->'creative_snapshot'->>'adId' <> p_meta_ad_id
                ), false)
            AND (
                (
                    p_ads_context_data->'leadgen_event_binding'->>'source' = 'SIGNED_META_WEBHOOK'
                    AND p_ads_context_data->'leadgen_event_binding'->>'leadgenId' = p_meta_leadgen_id
                    AND p_ads_context_data->'leadgen_event_binding'->>'pageId' = p_page_id
                    AND p_ads_context_data->'leadgen_event_binding'->>'adId' = p_meta_ad_id
                )
                OR
                (
                    p_ads_context_data->'creative_snapshot'->>'source' = 'META_MARKETING_API'
                    AND p_ads_context_data->'creative_snapshot'->>'captureTiming' = 'AT_LEAD_INTAKE'
                    AND p_ads_context_data->'creative_snapshot'->>'adId' = p_meta_ad_id
                    AND p_ads_context_data->'creative_snapshot'->>'pageId' = p_page_id
                    AND COALESCE(p_ads_context_data->'creative_snapshot'->>'pageIdConflict', 'false') = 'false'
                )
            ),
            false
        );
    ELSE
        v_page_verified := true;
    END IF;

    IF p_meta_ad_id IS NOT NULL AND v_page_verified THEN
        SELECT c.meta_campaign_id,c.name,a.meta_ad_set_id,NULL::text,a.name,c.ad_account_id
        INTO v_resolved_campaign_id,v_resolved_campaign,v_resolved_ad_set_id,v_resolved_ad_set,v_resolved_ad,v_account_id
        FROM public.meta_ads a
        JOIN public.meta_campaigns c ON c.company_id=a.company_id AND c.meta_campaign_id=a.meta_campaign_id AND c.ad_account_id=a.ad_account_id
        WHERE a.company_id=p_company AND a.meta_ad_id=p_meta_ad_id;
    ELSIF p_meta_campaign_id IS NOT NULL AND v_page_verified
        AND p_channel <> 'FACEBOOK_LEAD_ADS' AND p_meta_leadgen_id IS NULL THEN
        SELECT c.meta_campaign_id,c.name,c.ad_account_id
        INTO v_resolved_campaign_id,v_resolved_campaign,v_account_id
        FROM public.meta_campaigns c WHERE c.company_id=p_company AND c.meta_campaign_id=p_meta_campaign_id;
    END IF;
    IF v_resolved_campaign_id IS NOT NULL THEN v_status := 'ATTRIBUTED';
    ELSIF p_meta_leadgen_id IS NOT NULL OR p_channel = 'FACEBOOK_LEAD_ADS' THEN
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
    v_raw := COALESCE(p_ads_context_data,'{}'::jsonb)||jsonb_build_object(
        'leadgen_page_evidence_conflict', COALESCE(p_ads_context_data->>'leadgen_page_evidence_conflict', 'false') <> 'false' OR COALESCE(
            p_ads_context_data->'creative_snapshot'->>'captureTiming' = 'AT_LEAD_INTAKE' AND (
                COALESCE(p_ads_context_data->'creative_snapshot'->>'pageIdConflict', 'false') <> 'false'
                OR p_ads_context_data->'creative_snapshot'->>'pageId' <> p_page_id
                OR p_ads_context_data->'creative_snapshot'->>'adId' <> p_meta_ad_id
            ), false),
        'raw_meta',jsonb_build_object(
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

-- 6. Safe campaign-resolution retry for pending direct leadgen touchpoints.
--    Resolves only from server-synced ad/campaign records in the same tenant;
--    never invents a campaign name. Idempotent and bounded.
CREATE OR REPLACE FUNCTION public.retry_pending_lead_attribution(
    p_company uuid,
    p_max integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
    v_first_ad text;
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
            COALESCE(t.ads_context_data->'raw_meta'->>'campaign_id', t.meta_campaign_id) AS asserted_campaign_id,
            COALESCE(
                NULLIF(btrim(t.page_id), '') IS NOT NULL
                AND NULLIF(btrim(t.meta_ad_id), '') IS NOT NULL
                AND COALESCE(t.ads_context_data->>'leadgen_ad_id_conflict', 'false') = 'false'
                AND COALESCE(t.ads_context_data->>'leadgen_page_evidence_conflict', 'false') = 'false'
                AND NOT COALESCE(
                    t.ads_context_data->'creative_snapshot'->>'captureTiming' = 'AT_LEAD_INTAKE' AND (
                        COALESCE(t.ads_context_data->'creative_snapshot'->>'pageIdConflict', 'false') <> 'false'
                        OR t.ads_context_data->'creative_snapshot'->>'pageId' <> t.page_id
                        OR t.ads_context_data->'creative_snapshot'->>'adId' <> t.meta_ad_id
                    ), false)
                AND (
                    (
                        t.ads_context_data->'leadgen_event_binding'->>'source' = 'SIGNED_META_WEBHOOK'
                        AND t.ads_context_data->'leadgen_event_binding'->>'leadgenId' = t.meta_leadgen_id
                        AND t.ads_context_data->'leadgen_event_binding'->>'pageId' = t.page_id
                        AND t.ads_context_data->'leadgen_event_binding'->>'adId' = t.meta_ad_id
                    )
                    OR
                    (
                        t.ads_context_data->'creative_snapshot'->>'source' = 'META_MARKETING_API'
                        AND t.ads_context_data->'creative_snapshot'->>'captureTiming' = 'AT_LEAD_INTAKE'
                        AND t.ads_context_data->'creative_snapshot'->>'adId' = t.meta_ad_id
                        AND t.ads_context_data->'creative_snapshot'->>'pageId' = t.page_id
                        AND COALESCE(t.ads_context_data->'creative_snapshot'->>'pageIdConflict', 'false') = 'false'
                    )
                ),
                false
            ) AS page_verified
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

        -- A pending Lead Ads event is eligible for reconciliation only after the
        -- creative snapshot proves both the Ad ID and the originating Page ID.
        IF NOT v_row.page_verified THEN
            CONTINUE;
        END IF;

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

        -- Lead Ads resolve only via the exact server-synced Ad and campaign join.
        -- A campaign assertion plus a valid Page/Ad binding is insufficient.
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
            SELECT t.campaign_name_snapshot, t.ad_name_snapshot, t.occurred_at
            INTO v_first_name, v_first_ad, v_first_at
            FROM public.lead_attribution_touchpoints t
            WHERE t.company_id = p_company AND t.customer_id = v_row.customer_id
            ORDER BY t.occurred_at ASC
            LIMIT 1;
            UPDATE public.customers c
            SET first_campaign_name = v_first_name,
                first_ad_name = v_first_ad,
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
