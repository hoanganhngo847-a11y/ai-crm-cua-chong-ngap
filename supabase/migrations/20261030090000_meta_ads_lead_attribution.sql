-- Migration: 20261030090000_meta_ads_lead_attribution.sql
-- Description: Meta Ads Integration & Multi-Touch Lead Attribution Schema
-- Standards: Tenant isolation (company_id), RLS, foreign keys, idempotency, strict append-only audit

-- 1. META AD ACCOUNTS (Read-only Marketing API sync)
CREATE TABLE IF NOT EXISTS public.meta_ad_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    ad_account_id text NOT NULL, -- e.g. 'act_123456789'
    name text NOT NULL,
    account_status integer DEFAULT 1,
    currency text DEFAULT 'VND',
    access_token text, -- Encrypted at rest
    token_expires_at timestamptz,
    last_synced_at timestamptz,
    sync_status text DEFAULT 'PENDING' CHECK (sync_status IN ('PENDING', 'SYNCING', 'SUCCESS', 'FAILED')),
    sync_error text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT uq_meta_ad_accounts_company_account UNIQUE (company_id, ad_account_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_ad_accounts_company ON public.meta_ad_accounts(company_id);

-- 2. META CAMPAIGNS (Marketing API campaigns, distinct from CRM care_campaigns)
CREATE TABLE IF NOT EXISTS public.meta_campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    ad_account_id text NOT NULL,
    meta_campaign_id text NOT NULL,
    name text NOT NULL,
    status text NOT NULL, -- 'ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED'
    synced_at timestamptz DEFAULT now() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT uq_meta_campaigns_company_campaign UNIQUE (company_id, meta_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_campaigns_company_account ON public.meta_campaigns(company_id, ad_account_id);

-- 4. META ADS
CREATE TABLE IF NOT EXISTS public.meta_ads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    ad_account_id text NOT NULL,
    meta_campaign_id text NOT NULL,
    meta_ad_set_id text,
    meta_ad_id text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    synced_at timestamptz DEFAULT now() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT uq_meta_ads_company_ad UNIQUE (company_id, meta_ad_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_company_adset ON public.meta_ads(company_id, meta_ad_set_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_company_ad_id ON public.meta_ads(company_id, meta_ad_id);

-- 5. META LEAD FORMS
CREATE TABLE IF NOT EXISTS public.meta_lead_forms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    page_id text NOT NULL,
    meta_form_id text NOT NULL,
    name text NOT NULL,
    status text,
    synced_at timestamptz DEFAULT now() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT uq_meta_lead_forms_company_form UNIQUE (company_id, meta_form_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_forms_company_page ON public.meta_lead_forms(company_id, page_id);

-- 7. LEAD ATTRIBUTION TOUCHPOINTS
CREATE TABLE IF NOT EXISTS public.lead_attribution_touchpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
    interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
    conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
    touchpoint_type text NOT NULL CHECK (touchpoint_type IN ('FIRST_TOUCH', 'LATEST_TOUCH', 'INTERMEDIATE')),
    channel text NOT NULL CHECK (channel IN ('FACEBOOK_LEAD_ADS', 'FACEBOOK_MESSENGER', 'WEBSITE', 'ZALO', 'HOTLINE', 'OTHER')),
    page_id text,
    page_name text,
    ad_account_id text,
    meta_campaign_id text,
    campaign_name_snapshot text,
    meta_ad_set_id text,
    ad_set_name_snapshot text,
    meta_ad_id text,
    ad_name_snapshot text,
    meta_form_id text,
    form_name_snapshot text,
    meta_leadgen_id text,
    referral_source text,
    referral_type text,
    ads_context_data jsonb,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    utm_content text,
    utm_term text,
    fbclid text,
    attribution_status text NOT NULL DEFAULT 'UNATTRIBUTED' CHECK (attribution_status IN ('ATTRIBUTED', 'UNATTRIBUTED', 'INFERRED', 'PENDING_SYNC')),
    attribution_method text NOT NULL DEFAULT 'MANUAL' CHECK (attribution_method IN ('DIRECT_LEADGEN', 'MESSENGER_REFERRAL', 'WEBSITE_UTM', 'AD_LOOKUP', 'MANUAL')),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Leadgen idempotency index: exactly one touchpoint per leadgen_id per company
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_attribution_leadgen ON public.lead_attribution_touchpoints(company_id, meta_leadgen_id)
WHERE meta_leadgen_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lead_attribution_customer ON public.lead_attribution_touchpoints(company_id, customer_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lead_attribution_campaign ON public.lead_attribution_touchpoints(company_id, meta_campaign_id);
CREATE INDEX IF NOT EXISTS idx_lead_attribution_occurred ON public.lead_attribution_touchpoints(company_id, occurred_at);

-- 8. Add attribution snapshot columns to public.customers for fast queries & filtering
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'first_campaign_name'
    ) THEN
        ALTER TABLE public.customers ADD COLUMN first_campaign_name text;
        ALTER TABLE public.customers ADD COLUMN first_ad_name text;
        ALTER TABLE public.customers ADD COLUMN first_touch_at timestamptz;
        ALTER TABLE public.customers ADD COLUMN latest_campaign_name text;
        ALTER TABLE public.customers ADD COLUMN latest_ad_name text;
        ALTER TABLE public.customers ADD COLUMN latest_touch_at timestamptz;
        ALTER TABLE public.customers ADD COLUMN attribution_status text DEFAULT 'UNATTRIBUTED';
    END IF;
END $$;

-- 9. RPC: record_lead_attribution_touchpoint
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
    v_resolved_campaign_id text := p_meta_campaign_id;
    v_resolved_ad_set_id text := p_meta_ad_set_id;
    v_resolved_campaign text := p_campaign_name;
    v_resolved_ad_set text := p_ad_set_name;
    v_resolved_ad text := p_ad_name;
    v_resolved_form text := p_form_name;
    v_status text := p_attribution_status;
BEGIN
    -- Idempotency check for leadgen_id
    IF p_meta_leadgen_id IS NOT NULL THEN
        SELECT id INTO v_existing_id
        FROM public.lead_attribution_touchpoints
        WHERE company_id = p_company
          AND meta_leadgen_id = p_meta_leadgen_id;

        IF v_existing_id IS NOT NULL THEN
            RETURN v_existing_id;
        END IF;
    END IF;

    -- Look up snapshots from synced Meta Ads metadata if names are not provided
    IF p_meta_ad_id IS NOT NULL AND (v_resolved_ad IS NULL OR v_resolved_campaign_id IS NULL) THEN
        SELECT a.name, NULL::text, c.name, a.meta_campaign_id, a.meta_ad_set_id
        INTO v_resolved_ad, v_resolved_ad_set, v_resolved_campaign, v_resolved_campaign_id, v_resolved_ad_set_id
        FROM public.meta_ads a

        LEFT JOIN public.meta_campaigns c ON c.company_id = p_company AND c.meta_campaign_id = a.meta_campaign_id
        WHERE a.company_id = p_company AND a.meta_ad_id = p_meta_ad_id;

        IF v_resolved_campaign IS NOT NULL AND v_status = 'UNATTRIBUTED' THEN
            v_status := 'ATTRIBUTED';
        END IF;
    END IF;

    IF p_meta_form_id IS NOT NULL AND v_resolved_form IS NULL THEN
        SELECT f.name INTO v_resolved_form
        FROM public.meta_lead_forms f
        WHERE f.company_id = p_company AND f.meta_form_id = p_meta_form_id;
    END IF;

    -- Determine FIRST_TOUCH vs LATEST_TOUCH
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

    -- Insert touchpoint
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
        p_ad_account_id,
        COALESCE(p_meta_campaign_id, v_resolved_campaign_id),
        v_resolved_campaign,
        COALESCE(p_meta_ad_set_id, v_resolved_ad_set_id),
        v_resolved_ad_set,
        p_meta_ad_id,
        v_resolved_ad,
        p_meta_form_id,
        v_resolved_form,
        p_meta_leadgen_id,
        p_referral_source,
        p_referral_type,
        p_ads_context_data,
        p_utm_source,
        p_utm_medium,
        p_utm_campaign,
        p_utm_content,
        p_utm_term,
        p_fbclid,
        v_status,
        p_attribution_method,
        COALESCE(p_occurred, now()),
        now()
    )
    RETURNING id INTO v_touchpoint_id;

    -- Update Customer snapshot fields atomically
    IF p_customer IS NOT NULL THEN
        IF NOT v_has_previous THEN
            UPDATE public.customers
            SET
                first_campaign_name = v_resolved_campaign,
                first_ad_name = v_resolved_ad,
                first_touch_at = COALESCE(p_occurred, now()),
                latest_campaign_name = v_resolved_campaign,
                latest_ad_name = v_resolved_ad,
                latest_touch_at = COALESCE(p_occurred, now()),
                attribution_status = v_status,
                updated_at = now()
            WHERE id = p_customer AND company_id = p_company;
        ELSE
            UPDATE public.customers
            SET
                latest_campaign_name = COALESCE(v_resolved_campaign, latest_campaign_name),
                latest_ad_name = COALESCE(v_resolved_ad, latest_ad_name),
                latest_touch_at = COALESCE(p_occurred, now()),
                attribution_status = CASE
                    WHEN v_status = 'ATTRIBUTED' THEN 'ATTRIBUTED'
                    ELSE attribution_status
                END,
                updated_at = now()
            WHERE id = p_customer AND company_id = p_company;
        END IF;
    END IF;

    RETURN v_touchpoint_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_lead_attribution_touchpoint FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_lead_attribution_touchpoint FROM anon;
GRANT EXECUTE ON FUNCTION public.record_lead_attribution_touchpoint TO service_role;
GRANT EXECUTE ON FUNCTION public.record_lead_attribution_touchpoint TO authenticated;

-- 11. ENABLE ROW LEVEL SECURITY
ALTER TABLE public.meta_ad_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_lead_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_attribution_touchpoints ENABLE ROW LEVEL SECURITY;

-- Helper RLS policies for tenant isolation
CREATE POLICY rls_meta_ad_accounts_tenant ON public.meta_ad_accounts
    FOR ALL
    TO authenticated
    USING (
        company_id IN (
            SELECT m.company_id FROM public.company_members m
            WHERE m.user_id = (SELECT auth.uid()) AND m.status = 'ACTIVE'
        )
    );

CREATE POLICY rls_meta_campaigns_tenant ON public.meta_campaigns
    FOR ALL
    TO authenticated
    USING (
        company_id IN (
            SELECT m.company_id FROM public.company_members m
            WHERE m.user_id = (SELECT auth.uid()) AND m.status = 'ACTIVE'
        )
    );

CREATE POLICY rls_meta_ads_tenant ON public.meta_ads
    FOR ALL
    TO authenticated
    USING (
        company_id IN (
            SELECT m.company_id FROM public.company_members m
            WHERE m.user_id = (SELECT auth.uid()) AND m.status = 'ACTIVE'
        )
    );

CREATE POLICY rls_meta_lead_forms_tenant ON public.meta_lead_forms
    FOR ALL
    TO authenticated
    USING (
        company_id IN (
            SELECT m.company_id FROM public.company_members m
            WHERE m.user_id = (SELECT auth.uid()) AND m.status = 'ACTIVE'
        )
    );

CREATE POLICY rls_lead_attribution_touchpoints_tenant ON public.lead_attribution_touchpoints
    FOR ALL
    TO authenticated
    USING (
        company_id IN (
            SELECT m.company_id FROM public.company_members m
            WHERE m.user_id = (SELECT auth.uid()) AND m.status = 'ACTIVE'
        )
    );

-- 12. TABLE GRANTS
GRANT ALL ON TABLE public.meta_ad_accounts TO authenticated, service_role;
GRANT ALL ON TABLE public.meta_campaigns TO authenticated, service_role;
GRANT ALL ON TABLE public.meta_ads TO authenticated, service_role;
GRANT ALL ON TABLE public.meta_lead_forms TO authenticated, service_role;
GRANT ALL ON TABLE public.lead_attribution_touchpoints TO authenticated, service_role;
