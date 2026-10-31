-- Migration: 20261030100000_meta_ads_hardening.sql
-- Description: Token Vault Isolation, SECURITY DEFINER RPC Authorization, Durable Webhook Intake & Reporting Accuracy
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Ensure private schema exists
CREATE SCHEMA IF NOT EXISTS private;

-- =============================================================================
-- 1. PRIVATE SCHEMA: META AD ACCOUNT TOKENS (Priority 1)
-- =============================================================================
CREATE TABLE IF NOT EXISTS private.meta_ad_account_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    ad_account_id text NOT NULL,
    encrypted_access_token text NOT NULL,
    token_expires_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT uq_meta_ad_account_tokens_company_account UNIQUE (company_id, ad_account_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_ad_account_tokens_company ON private.meta_ad_account_tokens(company_id);

ALTER TABLE private.meta_ad_account_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.meta_ad_account_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.meta_ad_account_tokens TO service_role;

-- Preserve ciphertext bytes; encryption/decryption and key verification belong
-- to the server/offline verifier, never SQL or a key embedded in a migration.
-- Freeze both copies until the post-copy comparison AND column removal commit.
LOCK TABLE public.meta_ad_accounts, private.meta_ad_account_tokens IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'meta_ad_accounts' AND column_name = 'access_token'
    ) <> EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'meta_ad_accounts' AND column_name = 'token_expires_at'
    ) THEN
        RAISE EXCEPTION 'META_TOKEN_SOURCE_SCHEMA_INCOMPLETE';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'meta_ad_accounts' AND column_name = 'access_token'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM public.meta_ad_accounts
            WHERE (access_token IS NOT NULL AND access_token !~ '^[A-Za-z0-9_-]{39,}$')
               OR (access_token IS NULL AND token_expires_at IS NOT NULL)
        ) THEN
            RAISE EXCEPTION 'META_TOKEN_SOURCE_REQUIRES_VERIFICATION';
        END IF;
        -- Never overwrite an independently populated vault row, including its
        -- expiry. Operators must resolve a conflict before retrying.
        IF EXISTS (
            SELECT 1 FROM public.meta_ad_accounts a
            JOIN private.meta_ad_account_tokens t USING (company_id, ad_account_id)
            WHERE a.access_token IS NOT NULL
              AND (t.encrypted_access_token IS DISTINCT FROM a.access_token
                   OR t.token_expires_at IS DISTINCT FROM a.token_expires_at)
        ) THEN
            RAISE EXCEPTION 'META_TOKEN_VAULT_CONFLICT';
        END IF;
        INSERT INTO private.meta_ad_account_tokens (company_id, ad_account_id, encrypted_access_token, token_expires_at)
        SELECT company_id, ad_account_id, access_token, token_expires_at
        FROM public.meta_ad_accounts
        WHERE access_token IS NOT NULL
        ON CONFLICT (company_id, ad_account_id) DO NOTHING;

        IF EXISTS (
            SELECT 1 FROM public.meta_ad_accounts a
            LEFT JOIN private.meta_ad_account_tokens t USING (company_id, ad_account_id)
            WHERE a.access_token IS NOT NULL
              AND (t.id IS NULL OR t.encrypted_access_token IS DISTINCT FROM a.access_token
                   OR t.token_expires_at IS DISTINCT FROM a.token_expires_at)
        ) THEN
            RAISE EXCEPTION 'META_TOKEN_COPY_INCOMPLETE';
        END IF;
    END IF;
END $$;

-- Reached only after exact per-account ciphertext AND expiry equality. Any
-- error rolls back the copy and preserves both old columns and all account rows.
ALTER TABLE public.meta_ad_accounts
    DROP COLUMN IF EXISTS access_token,
    DROP COLUMN IF EXISTS token_expires_at;

-- Add concurrency lease columns to public.meta_ad_accounts
ALTER TABLE public.meta_ad_accounts
    ADD COLUMN IF NOT EXISTS sync_lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS sync_lease_token uuid;

-- =============================================================================
-- 2. PRIVATE SCHEMA: DURABLE LEADGEN WEBHOOK INTAKE (Priority 3)
-- =============================================================================
CREATE TABLE IF NOT EXISTS private.meta_leadgen_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    page_id text NOT NULL,
    leadgen_id text NOT NULL,
    form_id text,
    ad_id text,
    status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')),
    interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
    customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
    error_message text,
    retry_count integer DEFAULT 0,
    occurred_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT uq_meta_leadgen_company_lead UNIQUE (company_id, leadgen_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_leadgen_events_lookup ON private.meta_leadgen_events(company_id, leadgen_id);
ALTER TABLE private.meta_leadgen_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.meta_leadgen_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.meta_leadgen_events TO service_role;

-- =============================================================================
-- 3. TOKEN STORAGE & RETRIEVAL RPCS (Priority 1)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.store_meta_ad_account_token(
    p_company_id uuid,
    p_ad_account_id text,
    p_encrypted_access_token text,
    p_token_expires_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    -- Authorization check: if authenticated user, must be ACTIVE member of p_company_id
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

    -- Verify company exists
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id) THEN
        RAISE EXCEPTION 'INVALID_COMPANY_ID: company % does not exist', p_company_id;
    END IF;

    INSERT INTO private.meta_ad_account_tokens (
        company_id,
        ad_account_id,
        encrypted_access_token,
        token_expires_at,
        updated_at
    )
    VALUES (
        p_company_id,
        p_ad_account_id,
        p_encrypted_access_token,
        p_token_expires_at,
        now()
    )
    ON CONFLICT (company_id, ad_account_id) DO UPDATE
    SET
        encrypted_access_token = EXCLUDED.encrypted_access_token,
        token_expires_at = EXCLUDED.token_expires_at,
        updated_at = now();

    -- Touch updated_at on public.meta_ad_accounts
    UPDATE public.meta_ad_accounts
    SET updated_at = now()
    WHERE company_id = p_company_id AND ad_account_id = p_ad_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.store_meta_ad_account_token FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_meta_ad_account_token FROM anon;
GRANT EXECUTE ON FUNCTION public.store_meta_ad_account_token TO service_role;
REVOKE ALL ON FUNCTION public.store_meta_ad_account_token FROM authenticated;

CREATE OR REPLACE FUNCTION public.get_meta_ad_account_token(
    p_company_id uuid,
    p_ad_account_id text
)
RETURNS TABLE (
    encrypted_access_token text,
    token_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    -- Authorization check: if authenticated user, must be ACTIVE member of p_company_id
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

    RETURN QUERY
    SELECT t.encrypted_access_token, t.token_expires_at
    FROM private.meta_ad_account_tokens t
    WHERE t.company_id = p_company_id
      AND t.ad_account_id = p_ad_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_meta_ad_account_token FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_meta_ad_account_token FROM anon;
GRANT EXECUTE ON FUNCTION public.get_meta_ad_account_token TO service_role;
REVOKE ALL ON FUNCTION public.get_meta_ad_account_token FROM authenticated;

-- =============================================================================
-- 4. DURABLE WEBHOOK CLAIM & FINALIZE RPCS (Priority 3)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.claim_meta_leadgen_event(
    p_company_id uuid,
    p_page_id text,
    p_leadgen_id text,
    p_form_id text DEFAULT NULL,
    p_ad_id text DEFAULT NULL,
    p_occurred timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status
    FROM private.meta_leadgen_events
    WHERE company_id = p_company_id AND leadgen_id = p_leadgen_id;

    IF v_status = 'PROCESSED' THEN
        RETURN 'ALREADY_PROCESSED';
    END IF;

    INSERT INTO private.meta_leadgen_events (
        company_id,
        page_id,
        leadgen_id,
        form_id,
        ad_id,
        status,
        retry_count,
        occurred_at,
        updated_at
    )
    VALUES (
        p_company_id,
        p_page_id,
        p_leadgen_id,
        p_form_id,
        p_ad_id,
        'PROCESSING',
        0,
        p_occurred,
        now()
    )
    ON CONFLICT (company_id, leadgen_id) DO UPDATE
    SET
        status = 'PROCESSING',
        retry_count = private.meta_leadgen_events.retry_count + 1,
        form_id = COALESCE(EXCLUDED.form_id, private.meta_leadgen_events.form_id),
        ad_id = COALESCE(EXCLUDED.ad_id, private.meta_leadgen_events.ad_id),
        updated_at = now();

    RETURN 'CLAIMED';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_meta_leadgen_event FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_meta_leadgen_event FROM anon;
REVOKE ALL ON FUNCTION public.claim_meta_leadgen_event FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_meta_leadgen_event TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_meta_leadgen_event(
    p_company_id uuid,
    p_leadgen_id text,
    p_status text,
    p_interaction_id uuid DEFAULT NULL,
    p_customer_id uuid DEFAULT NULL,
    p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    UPDATE private.meta_leadgen_events
    SET
        status = p_status,
        interaction_id = COALESCE(p_interaction_id, interaction_id),
        customer_id = COALESCE(p_customer_id, customer_id),
        error_message = p_error,
        updated_at = now()
    WHERE company_id = p_company_id AND leadgen_id = p_leadgen_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_meta_leadgen_event FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_meta_leadgen_event FROM anon;
REVOKE ALL ON FUNCTION public.finalize_meta_leadgen_event FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_meta_leadgen_event TO service_role;

-- =============================================================================
-- 5. MARKETING API CONCURRENCY LEASE RPCS (Priority 4)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.acquire_meta_ad_account_sync_lease(
    p_company_id uuid,
    p_ad_account_id text,
    p_lease_duration_seconds integer DEFAULT 300
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_token uuid := gen_random_uuid();
    v_acquired boolean;
BEGIN
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
        sync_status = 'SYNCING',
        sync_lease_token = v_token,
        sync_lease_until = now() + (p_lease_duration_seconds || ' seconds')::interval,
        updated_at = now()
    WHERE company_id = p_company_id
      AND ad_account_id = p_ad_account_id
      AND (
          sync_status != 'SYNCING'
          OR sync_lease_until IS NULL
          OR sync_lease_until < now()
      );

    GET DIAGNOSTICS v_acquired = ROW_COUNT;
    IF v_acquired THEN
        RETURN v_token;
    ELSE
        RETURN NULL;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_meta_ad_account_sync_lease FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acquire_meta_ad_account_sync_lease FROM anon;
GRANT EXECUTE ON FUNCTION public.acquire_meta_ad_account_sync_lease TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_meta_ad_account_sync_lease TO authenticated;

CREATE OR REPLACE FUNCTION public.release_meta_ad_account_sync_lease(
    p_company_id uuid,
    p_ad_account_id text,
    p_lease_token uuid,
    p_status text,
    p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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
      AND (sync_lease_token = p_lease_token OR sync_lease_token IS NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.release_meta_ad_account_sync_lease FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_meta_ad_account_sync_lease FROM anon;
GRANT EXECUTE ON FUNCTION public.release_meta_ad_account_sync_lease TO service_role;
REVOKE ALL ON FUNCTION public.release_meta_ad_account_sync_lease FROM authenticated;

-- =============================================================================
-- 6. HARDENED RPC: record_lead_attribution_touchpoint (Priorities 2 & 5)
-- =============================================================================
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
    v_resolved_campaign_id text := p_meta_campaign_id;
    v_resolved_ad_set_id text := p_meta_ad_set_id;
    v_resolved_campaign text := p_campaign_name;
    v_resolved_ad_set text := p_ad_set_name;
    v_resolved_ad text := p_ad_name;
    v_resolved_form text := p_form_name;
    v_status text := p_attribution_status;
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

    -- 4. Idempotency check for leadgen_id
    IF p_meta_leadgen_id IS NOT NULL THEN
        SELECT id INTO v_existing_id
        FROM public.lead_attribution_touchpoints
        WHERE company_id = p_company
          AND meta_leadgen_id = p_meta_leadgen_id;

        IF v_existing_id IS NOT NULL THEN
            RETURN v_existing_id;
        END IF;
    END IF;

    -- 5. Look up snapshots from synced Meta Ads metadata if names are not provided
    IF p_meta_ad_id IS NOT NULL AND (v_resolved_ad IS NULL OR v_resolved_campaign_id IS NULL) THEN
        SELECT a.name, NULL::text, c.name, a.meta_campaign_id, a.meta_ad_set_id, a.ad_account_id
        INTO v_resolved_ad, v_resolved_ad_set, v_resolved_campaign, v_resolved_campaign_id, v_resolved_ad_set_id, p_ad_account_id
        FROM public.meta_ads a

        LEFT JOIN public.meta_campaigns c ON c.company_id = p_company AND c.meta_campaign_id = a.meta_campaign_id
        WHERE a.company_id = p_company AND a.meta_ad_id = p_meta_ad_id;

        IF v_resolved_campaign IS NOT NULL AND v_status = 'UNATTRIBUTED' THEN
            v_status := 'ATTRIBUTED';
        END IF;
    END IF;

    -- Resolve ad_account_id from campaign if missing
    IF p_ad_account_id IS NULL AND v_resolved_campaign_id IS NOT NULL THEN
        SELECT c.ad_account_id INTO p_ad_account_id
        FROM public.meta_campaigns c
        WHERE c.company_id = p_company AND c.meta_campaign_id = v_resolved_campaign_id;
    END IF;

    IF p_meta_form_id IS NOT NULL AND v_resolved_form IS NULL THEN
        SELECT f.name INTO v_resolved_form
        FROM public.meta_lead_forms f
        WHERE f.company_id = p_company AND f.meta_form_id = p_meta_form_id;
    END IF;

    -- 6. STRICT ATTRIBUTION RULE (Priority 5)
    -- Do not label a lead ATTRIBUTED just because it has an ad_id unless that ad is successfully
    -- mapped to a trusted Meta campaign or valid attribution record.
    IF v_status = 'ATTRIBUTED' THEN
        IF COALESCE(v_resolved_campaign_id, p_meta_campaign_id) IS NULL AND COALESCE(v_resolved_campaign, p_campaign_name) IS NULL THEN
            v_status := 'UNATTRIBUTED';
        END IF;
    END IF;

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

    -- 9. Update Customer snapshot fields atomically (First-touch strictly preserved)
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
                first_campaign_name = COALESCE(first_campaign_name, v_resolved_campaign),
                first_ad_name = COALESCE(first_ad_name, v_resolved_ad),
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
COMMIT;
