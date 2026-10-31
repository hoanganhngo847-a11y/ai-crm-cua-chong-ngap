-- Final remediation, additive: do not rewrite applied production history.
BEGIN;

REVOKE ALL ON FUNCTION public.store_meta_ad_account_token(uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_meta_ad_account_token(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_meta_ad_account_token(uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_meta_ad_account_token(uuid,text) TO service_role;
REVOKE ALL ON private.meta_ad_account_tokens, private.meta_leadgen_events FROM PUBLIC, anon, authenticated;
-- Only the server sync may write the records used as attribution evidence.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.meta_ad_accounts, public.meta_campaigns,
    public.meta_ads, public.meta_lead_forms,
    public.lead_attribution_touchpoints FROM authenticated, anon;

ALTER TABLE private.meta_leadgen_events
    ADD COLUMN claim_token uuid,
    ADD COLUMN lease_until timestamptz,
    ADD COLUMN ingest_args jsonb;

DROP FUNCTION public.claim_meta_leadgen_event(uuid,text,text,text,text,timestamptz);
CREATE FUNCTION public.claim_meta_leadgen_event(
    p_company_id uuid, p_page_id text, p_leadgen_id text,
    p_form_id text DEFAULT NULL, p_ad_id text DEFAULT NULL, p_occurred timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_event private.meta_leadgen_events%ROWTYPE;
    v_token uuid := gen_random_uuid();
BEGIN
    INSERT INTO private.meta_leadgen_events AS e
        (company_id,page_id,leadgen_id,form_id,ad_id,status,occurred_at,claim_token,lease_until)
    VALUES (p_company_id,p_page_id,p_leadgen_id,p_form_id,p_ad_id,'PROCESSING',p_occurred,v_token,clock_timestamp()+interval '5 minutes')
    ON CONFLICT (company_id,leadgen_id) DO UPDATE
        SET status='PROCESSING', claim_token=v_token, lease_until=clock_timestamp()+interval '5 minutes',
            retry_count=e.retry_count+1, updated_at=clock_timestamp(), error_message=NULL
        WHERE e.page_id=EXCLUDED.page_id AND
            (e.status IN ('RECEIVED','FAILED') OR (e.status='PROCESSING' AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp())))
    RETURNING * INTO v_event;
    IF FOUND THEN
        RETURN jsonb_build_object('status','CLAIMED','claim_token',v_token,'interaction_id',v_event.interaction_id,
            'customer_id',v_event.customer_id,'occurred_at',v_event.occurred_at,'ingest_args',v_event.ingest_args);
    END IF;
    SELECT * INTO v_event FROM private.meta_leadgen_events WHERE company_id=p_company_id AND leadgen_id=p_leadgen_id;
    RETURN jsonb_build_object('status',CASE WHEN v_event.status='PROCESSED' AND v_event.page_id=p_page_id
        THEN 'ALREADY_PROCESSED' ELSE 'BUSY' END);
END; $$;
REVOKE ALL ON FUNCTION public.claim_meta_leadgen_event(uuid,text,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_meta_leadgen_event(uuid,text,text,text,text,timestamptz) TO service_role;

DROP FUNCTION public.finalize_meta_leadgen_event(uuid,text,text,uuid,uuid,text);
CREATE FUNCTION public.finalize_meta_leadgen_event(
    p_company_id uuid, p_leadgen_id text, p_claim_token uuid, p_status text,
    p_interaction_id uuid DEFAULT NULL, p_customer_id uuid DEFAULT NULL, p_error text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_event private.meta_leadgen_events%ROWTYPE;
BEGIN
    SELECT * INTO v_event FROM private.meta_leadgen_events
        WHERE company_id=p_company_id AND leadgen_id=p_leadgen_id FOR UPDATE;
    IF NOT FOUND OR v_event.status<>'PROCESSING' OR v_event.claim_token IS DISTINCT FROM p_claim_token
        OR v_event.lease_until IS NULL OR v_event.lease_until<=clock_timestamp()
        OR p_claim_token IS NULL THEN RETURN false; END IF;
    IF p_status IS NULL OR p_status NOT IN ('PROCESSED','FAILED') THEN RAISE EXCEPTION 'INVALID_FINAL_STATUS'; END IF;
    IF p_status='PROCESSED' AND NOT EXISTS (
        SELECT 1 FROM public.lead_attribution_touchpoints t WHERE t.company_id=p_company_id
            AND t.meta_leadgen_id=p_leadgen_id AND t.interaction_id=v_event.interaction_id
            AND t.customer_id=v_event.customer_id
    ) THEN RAISE EXCEPTION 'ATTRIBUTION_NOT_RECORDED'; END IF;
    UPDATE private.meta_leadgen_events SET status=p_status, claim_token=NULL, lease_until=NULL,
        error_message=p_error, updated_at=clock_timestamp()
        WHERE id=v_event.id;
    RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.finalize_meta_leadgen_event(uuid,text,uuid,text,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_meta_leadgen_event(uuid,text,uuid,text,uuid,uuid,text) TO service_role;

-- Meta form submissions are ingested by the dedicated RPC in the phone-history
-- migration. Do not replace han_ingest or any Messenger/canary function here.
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
    IF v_resolved_campaign_id IS NOT NULL THEN v_status := 'ATTRIBUTED'; END IF;
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
GRANT EXECUTE ON FUNCTION public.record_lead_attribution_touchpoint TO service_role;
GRANT EXECUTE ON FUNCTION public.record_lead_attribution_touchpoint TO authenticated;


DROP FUNCTION public.release_meta_ad_account_sync_lease(uuid,text,uuid,text,text);
CREATE FUNCTION public.release_meta_ad_account_sync_lease(
    p_company_id uuid,
    p_ad_account_id text,
    p_lease_token uuid,
    p_status text,
    p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_rows integer;
BEGIN
    IF p_status IS NULL OR p_status NOT IN ('SUCCESS','FAILED') THEN RAISE EXCEPTION 'INVALID_SYNC_STATUS'; END IF;
    -- Authorization check for authenticated users
    IF auth.role() = 'authenticated' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.company_members cm
            WHERE cm.company_id = p_company_id
              AND cm.user_id = auth.uid()
              AND cm.status = 'ACTIVE'
        ) THEN
            RAISE EXCEPTION 'UNAUTHORIZED_COMPANY_ACCESS: user % not authorized for company %', auth.uid(), p_company_id;
        END IF;
    END IF;

    UPDATE public.meta_ad_accounts
    SET
        sync_status = p_status,
        sync_error = p_error,
        sync_lease_token = NULL,
        sync_lease_until = NULL,
        last_synced_at = CASE WHEN p_status = 'SUCCESS' THEN now() ELSE last_synced_at END,
        updated_at = now()
    WHERE company_id = p_company_id
      AND ad_account_id = p_ad_account_id
      AND sync_lease_token = p_lease_token AND sync_lease_until > clock_timestamp();
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows=1;
END;
$$;

REVOKE ALL ON FUNCTION public.release_meta_ad_account_sync_lease FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_meta_ad_account_sync_lease FROM anon;
GRANT EXECUTE ON FUNCTION public.release_meta_ad_account_sync_lease TO service_role;
REVOKE ALL ON FUNCTION public.release_meta_ad_account_sync_lease FROM authenticated;


REVOKE ALL ON FUNCTION public.acquire_meta_ad_account_sync_lease(uuid,text,integer) FROM authenticated;
COMMIT;
