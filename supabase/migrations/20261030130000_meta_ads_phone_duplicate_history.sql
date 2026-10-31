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

-- 3. Dedicated Lead Ads intake. The RPC itself plus the fenced lead event is
-- the discriminator; shared han_ingest remains byte-for-byte untouched.
-- A form submission is not a Messenger thread/PSID: no conversation, identity,
-- care response, SLA or AI/canary configuration is created by this path.
CREATE FUNCTION public.ingest_meta_leadgen_event(
    p_company_id uuid, p_leadgen_id text, p_claim_token uuid, p_ingest jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_event private.meta_leadgen_events%ROWTYPE;
    v_existing private.han_intake_events%ROWTYPE;
    v_args jsonb; v_payload jsonb; v_key text;
    v_name text; v_phone text; v_content text;
    v_customer uuid; v_interaction uuid;
    v_matches integer := 0;
    v_phone_status text; v_duplicate boolean;
BEGIN
    SELECT * INTO v_event FROM private.meta_leadgen_events
        WHERE company_id=p_company_id AND leadgen_id=p_leadgen_id FOR UPDATE;
    IF NOT FOUND OR v_event.status<>'PROCESSING'
        OR v_event.claim_token IS DISTINCT FROM p_claim_token OR p_claim_token IS NULL
        OR v_event.lease_until IS NULL OR v_event.lease_until<=clock_timestamp()
    THEN RAISE EXCEPTION 'LEADGEN_LEASE_LOST'; END IF;
    IF v_event.interaction_id IS NOT NULL THEN
        RETURN jsonb_build_object('interaction_id',v_event.interaction_id,'customer_id',v_event.customer_id,
            'phone_match_status',v_event.phone_match_status,'is_duplicate_phone',v_event.is_duplicate_phone);
    END IF;
    v_args := COALESCE(v_event.ingest_args,p_ingest);
    IF v_args IS NULL THEN RAISE EXCEPTION 'MISSING_INGEST_ARGS'; END IF;
    v_name:=v_args->>'name'; v_phone:=v_args->>'phone'; v_content:=v_args->>'content';
    v_key:=v_event.page_id||':leadgen:'||p_leadgen_id;
    IF jsonb_typeof(v_args) IS DISTINCT FROM 'object'
        OR v_name IS NULL OR length(v_name)>100
        OR v_content IS NULL OR length(v_content)>10000
        OR v_event.page_id !~ '^[0-9]+$' OR p_leadgen_id !~ '^[0-9]+$' OR length(v_key)>250
        OR (v_phone IS NOT NULL AND v_phone !~ '^\+[1-9][0-9]{7,14}$')
        OR (v_args ? 'payload' AND jsonb_typeof(v_args->'payload') IS DISTINCT FROM 'object')
        OR NOT EXISTS (SELECT 1 FROM public.companies WHERE id=p_company_id AND status='ACTIVE')
    THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
    v_payload:=COALESCE(v_args->'payload','{}'::jsonb)||jsonb_build_object('crm_lead_ads',true);

    -- Same tenant lock as existing ingestion, so phone admission cannot race
    -- another Lead Ads or Messenger/Website admission in this company.
    PERFORM pg_advisory_xact_lock(hashtextextended('han-intake:'||p_company_id::text,0));
    SELECT * INTO v_existing FROM private.han_intake_events
        WHERE company_id=p_company_id AND channel='FACEBOOK' AND event_key=v_key;
    IF FOUND THEN
        IF v_existing.external_identity IS DISTINCT FROM v_key
            OR v_existing.payload->>'name' IS DISTINCT FROM v_name
            OR v_existing.payload->>'phone' IS DISTINCT FROM v_phone
            OR v_existing.payload->>'content' IS DISTINCT FROM v_content
        THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
        -- Successful writes below checkpoint both records in the same transaction.
        -- An orphan intake row is not proof of successful lead ingestion.
        RAISE EXCEPTION 'LEADGEN_INTAKE_INCOMPLETE';
    END IF;
    IF v_phone IS NOT NULL THEN
        SELECT count(*) INTO v_matches FROM private.customer_private_contacts
            WHERE company_id=p_company_id AND normalized_phone=v_phone;
        IF v_matches=1 THEN
            SELECT customer_id INTO v_customer FROM private.customer_private_contacts
                WHERE company_id=p_company_id AND normalized_phone=v_phone;
        END IF;
    END IF;
    v_phone_status:=CASE WHEN v_phone IS NULL THEN 'NO_PHONE'
        WHEN v_matches>1 THEN 'AMBIGUOUS_MULTIPLE'
        WHEN v_matches=1 THEN 'MATCHED_EXISTING' ELSE 'NEW_PHONE' END;
    v_duplicate:=v_matches>0;
    IF v_customer IS NULL THEN
        INSERT INTO public.customers(company_id,name,source,stage)
            VALUES(p_company_id,v_name,'FACEBOOK','LEAD_NEW') RETURNING id INTO v_customer;
        INSERT INTO public.customer_stage_histories(company_id,customer_id,from_stage,to_stage,actor_type,reason)
            VALUES(p_company_id,v_customer,NULL,'LEAD_NEW','SYSTEM','OMNICHANNEL_INTAKE');
    END IF;
    IF v_phone_status='NEW_PHONE' THEN
        INSERT INTO private.customer_private_contacts(company_id,customer_id,normalized_phone,raw_phone,is_verified)
            VALUES(p_company_id,v_customer,v_phone,v_phone,false);
    ELSIF v_phone_status='AMBIGUOUS_MULTIPLE' THEN
        INSERT INTO public.audit_logs(company_id,action,resource_type,resource_id,customer_id,result)
            VALUES(p_company_id,'OMNICHANNEL_IDENTITY_REVIEW','Customer',v_customer,v_customer,'SUCCESS');
    END IF;
    INSERT INTO public.interactions(company_id,customer_id,conversation_id,channel,type,direction,
        sanitized_content,sanitization_status,sanitized_at,sanitizer_version,external_ref,actor_type,created_at)
        VALUES(p_company_id,v_customer,NULL,'FACEBOOK','MESSAGE','INBOUND',v_content,'SUCCEEDED',now(),
            'han-bounded-v2',v_key,'CUSTOMER',v_event.occurred_at) RETURNING id INTO v_interaction;
    INSERT INTO private.interaction_raw_contents(interaction_id,company_id,raw_content,raw_payload)
        VALUES(v_interaction,p_company_id,v_content,v_payload);
    INSERT INTO private.han_intake_events(company_id,channel,event_key,external_identity,payload,status,interaction_id)
        VALUES(p_company_id,'FACEBOOK',v_key,v_key,
            jsonb_build_object('source',v_payload,'content',v_content,'phone',v_phone,'name',v_name,'occurred_at',v_event.occurred_at),
            CASE WHEN v_matches>1 THEN 'IDENTITY_REVIEW' ELSE 'PROCESSED' END,v_interaction);
    UPDATE private.meta_leadgen_events SET ingest_args=v_args,interaction_id=v_interaction,customer_id=v_customer,
        phone_match_status=v_phone_status,is_duplicate_phone=v_duplicate,updated_at=clock_timestamp()
        WHERE id=v_event.id;
    RETURN jsonb_build_object('status','ACCEPTED','interaction_id',v_interaction,'customer_id',v_customer,
        'phone_match_status',v_phone_status,'is_duplicate_phone',v_duplicate);
END; $$;
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
