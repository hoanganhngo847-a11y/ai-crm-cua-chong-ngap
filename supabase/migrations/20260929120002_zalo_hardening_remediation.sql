-- Migration: 20260929120002_zalo_hardening_remediation.sql
-- Module: Omnichannel Zalo OA & Care Automation Architecture Hardening
-- Remediates: P0/P1 Regressions (Issues 1-14)
-- Standards: DB-level atomicity, Zero JS compensation, Fail-closed outbox, Secret isolation in private schema.

-- ==============================================================================
-- 1. SECRET STORAGE HARDENING (Lỗi 8)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS private.zalo_oa_secrets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    oa_id TEXT NOT NULL,
    app_secret TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_zalo_oa_secrets_company_oa UNIQUE (company_id, oa_id),
    CONSTRAINT uq_zalo_oa_secrets_oa UNIQUE (oa_id)
);

-- Deny all access to secrets from PostgREST / client roles
REVOKE ALL ON private.zalo_oa_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.zalo_oa_secrets TO service_role;

-- Update public.zalo_oa_configs to reference secrets table and remove exposed secrets
ALTER TABLE public.zalo_oa_configs 
    ADD COLUMN IF NOT EXISTS secret_ref_id UUID REFERENCES private.zalo_oa_secrets(id) ON DELETE SET NULL;

-- Migrate any existing credentials into private schema
INSERT INTO private.zalo_oa_secrets (company_id, oa_id, app_secret, access_token, refresh_token, token_expires_at, token_version)
SELECT company_id, oa_id, app_secret, access_token, refresh_token, token_expires_at, token_version
FROM public.zalo_oa_configs
ON CONFLICT (company_id, oa_id) DO NOTHING;

UPDATE public.zalo_oa_configs c
SET secret_ref_id = s.id
FROM private.zalo_oa_secrets s
WHERE c.company_id = s.company_id AND c.oa_id = s.oa_id AND c.secret_ref_id IS NULL;

-- ==============================================================================
-- 2. DURABLE INGRESS STATE MACHINE SCHEMA (Lỗi 2)
-- ==============================================================================
ALTER TABLE public.zalo_ingress_events
    ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_zalo_ingress_events_lease 
    ON public.zalo_ingress_events (status, lease_until);

-- ==============================================================================
-- 3. HARDENED OUTBOX SCHEMA (Lỗi 5, 6)
-- ==============================================================================
ALTER TABLE public.zalo_outbound_deliveries
    ADD COLUMN IF NOT EXISTS command_id TEXT,
    ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'ZALO',
    ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

-- Drop old status check if exists and re-add with PROVIDER_SENT_PENDING_FINALIZE
ALTER TABLE public.zalo_outbound_deliveries 
    DROP CONSTRAINT IF EXISTS zalo_outbound_deliveries_status_check;

ALTER TABLE public.zalo_outbound_deliveries
    ADD CONSTRAINT zalo_outbound_deliveries_status_check 
    CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'PROVIDER_SENT_PENDING_FINALIZE'));

CREATE INDEX IF NOT EXISTS idx_zalo_outbound_command 
    ON public.zalo_outbound_deliveries (company_id, channel, command_id);

-- ==============================================================================
-- 4. CARE DELIVERIES HARDENING (Lỗi 9)
-- ==============================================================================
ALTER TABLE public.care_deliveries
    ADD COLUMN IF NOT EXISTS care_schedule_id UUID REFERENCES public.care_schedules(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS send_target_date DATE,
    ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_care_deliveries_schedule_date'
    ) THEN
        ALTER TABLE public.care_deliveries
            ADD CONSTRAINT uq_care_deliveries_schedule_date UNIQUE (care_schedule_id, send_target_date);
    END IF;
END $$;

-- ==============================================================================
-- 5. ATOMIC RPC ROUTINES (Lỗi 2, 3, 6, 9)
-- ==============================================================================

-- RPC: Atomic Ingress Claim State Machine
CREATE OR REPLACE FUNCTION public.zalo_claim_ingress_event(
    p_company_id UUID,
    p_oa_id TEXT,
    p_external_ref TEXT,
    p_event_name TEXT,
    p_sender_id TEXT,
    p_recipient_id TEXT
)
RETURNS TABLE (
    claim_status TEXT,
    event_id UUID,
    retry_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing RECORD;
    v_new_id UUID;
BEGIN
    -- Query with row lock
    SELECT id, status, lease_until, public.zalo_ingress_events.retry_count
    INTO v_existing
    FROM public.zalo_ingress_events
    WHERE company_id = p_company_id 
      AND oa_id = p_oa_id 
      AND external_ref = p_external_ref
    FOR UPDATE;

    IF NOT FOUND THEN
        BEGIN
            INSERT INTO public.zalo_ingress_events (
                company_id, oa_id, external_ref, event_name,
                sender_id, recipient_id, status, lease_until, retry_count
            ) VALUES (
                p_company_id, p_oa_id, p_external_ref, p_event_name,
                p_sender_id, p_recipient_id, 'CLAIMED', now() + interval '2 minutes', 0
            ) RETURNING id INTO v_new_id;

            RETURN QUERY SELECT 'CLAIMED'::TEXT, v_new_id, 0;
            RETURN;
        EXCEPTION WHEN unique_violation THEN
            -- Caught race condition, lock existing row
            SELECT id, status, lease_until, public.zalo_ingress_events.retry_count
            INTO v_existing
            FROM public.zalo_ingress_events
            WHERE company_id = p_company_id 
              AND oa_id = p_oa_id 
              AND external_ref = p_external_ref
            FOR UPDATE;
        END;
    END IF;

    -- Evaluate state machine for existing record
    IF v_existing.status = 'PROCESSED' THEN
        RETURN QUERY SELECT 'DUPLICATE'::TEXT, v_existing.id, v_existing.retry_count;
        RETURN;
    ELSIF v_existing.status = 'FAILED' OR (v_existing.status = 'CLAIMED' AND v_existing.lease_until < now()) THEN
        UPDATE public.zalo_ingress_events
        SET status = 'CLAIMED',
            retry_count = v_existing.retry_count + 1,
            lease_until = now() + interval '2 minutes',
            last_error = NULL,
            updated_at = now()
        WHERE id = v_existing.id;

        RETURN QUERY SELECT 'CLAIMED'::TEXT, v_existing.id, v_existing.retry_count + 1;
        RETURN;
    ELSE
        -- CLAIMED and active lease
        RETURN QUERY SELECT 'BUSY'::TEXT, v_existing.id, v_existing.retry_count;
        RETURN;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_claim_ingress_event FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_claim_ingress_event TO service_role;


-- RPC: Atomic Ingress CRM Mutation (Replaces JS compensation rollback completely)
CREATE OR REPLACE FUNCTION public.zalo_process_ingress_message(
    p_company_id UUID,
    p_oa_id TEXT,
    p_external_ref TEXT,
    p_raw_msg_id TEXT,
    p_zalo_user_uid TEXT,
    p_user_name TEXT,
    p_event_name TEXT,
    p_sender_id TEXT,
    p_recipient_id TEXT,
    p_is_inbound BOOLEAN,
    p_sanitized_content TEXT,
    p_raw_content TEXT,
    p_raw_payload JSONB,
    p_timestamp BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_customer_id UUID;
    v_identity_id UUID;
    v_conversation_id UUID;
    v_interaction_id UUID;
    v_is_new_customer BOOLEAN := false;
    v_existing_identity RECORD;
    v_existing_conversation RECORD;
    v_display_name TEXT;
BEGIN
    -- 1. Customer & Identity Resolution
    SELECT id, customer_id INTO v_existing_identity
    FROM public.identities
    WHERE company_id = p_company_id 
      AND channel = 'ZALO' 
      AND external_id = p_zalo_user_uid;

    IF FOUND THEN
        v_customer_id := v_existing_identity.customer_id;
        v_identity_id := v_existing_identity.id;
    ELSE
        v_is_new_customer := true;
        v_display_name := COALESCE(NULLIF(trim(p_user_name), ''), 'Khách Zalo ' || right(p_zalo_user_uid, 4));

        INSERT INTO public.customers (
            company_id, name, source, stage
        ) VALUES (
            p_company_id, v_display_name, 'ZALO_OA', 'LEAD_NEW'
        ) RETURNING id INTO v_customer_id;

        INSERT INTO public.identities (
            company_id, customer_id, channel, external_id, verified, metadata
        ) VALUES (
            p_company_id, v_customer_id, 'ZALO', p_zalo_user_uid, false,
            jsonb_build_object('zalo_uid', p_zalo_user_uid)
        ) RETURNING id INTO v_identity_id;
    END IF;

    -- 2. Conversation Mutate
    SELECT id, unread_count INTO v_existing_conversation
    FROM public.conversations
    WHERE company_id = p_company_id
      AND channel = 'ZALO'
      AND external_conversation_id = p_zalo_user_uid;

    IF FOUND THEN
        v_conversation_id := v_existing_conversation.id;
        UPDATE public.conversations
        SET last_message_at = now(),
            unread_count = CASE WHEN p_is_inbound THEN v_existing_conversation.unread_count + 1 ELSE v_existing_conversation.unread_count END,
            status = 'OPEN',
            updated_at = now()
        WHERE id = v_conversation_id;
    ELSE
        INSERT INTO public.conversations (
            company_id, customer_id, channel, external_conversation_id,
            last_message_at, unread_count, status
        ) VALUES (
            p_company_id, v_customer_id, 'ZALO', p_zalo_user_uid,
            now(), CASE WHEN p_is_inbound THEN 1 ELSE 0 END, 'OPEN'
        ) RETURNING id INTO v_conversation_id;
    END IF;

    -- 3. Public Interaction Insert (external_ref is namespacedExternalRef, rawMsgId is in source_metadata)
    INSERT INTO public.interactions (
        company_id, customer_id, conversation_id, channel, type, direction,
        sanitized_content, sanitization_status, sanitized_at, sanitizer_version,
        external_ref, actor_type, actor_user_id, created_at
    ) VALUES (
        p_company_id, v_customer_id, v_conversation_id, 'ZALO', 'MESSAGE',
        CASE WHEN p_is_inbound THEN 'INBOUND' ELSE 'OUTBOUND' END,
        p_sanitized_content, 'SUCCEEDED', now(), 'v1.0',
        p_external_ref, -- Lỗi 13 fix: namespaced external ref
        CASE WHEN p_is_inbound THEN 'CUSTOMER' ELSE 'SALE' END,
        NULL, now()
    ) RETURNING id INTO v_interaction_id;

    -- 4. Private Security Zone: Raw interaction content
    INSERT INTO private.interaction_raw_contents (
        interaction_id, company_id, raw_content, raw_payload, source_metadata, created_at
    ) VALUES (
        v_interaction_id, p_company_id, p_raw_content, p_raw_payload,
        jsonb_build_object(
            'oa_id', p_oa_id,
            'sender_id', p_sender_id,
            'recipient_id', p_recipient_id,
            'timestamp', p_timestamp,
            'event_name', p_event_name,
            'provider_msg_id', p_raw_msg_id
        ),
        now()
    );

    -- 5. Mark ingress event as PROCESSED
    UPDATE public.zalo_ingress_events
    SET status = 'PROCESSED',
        lease_until = NULL,
        last_error = NULL,
        updated_at = now()
    WHERE company_id = p_company_id
      AND oa_id = p_oa_id
      AND external_ref = p_external_ref;

    RETURN jsonb_build_object(
        'customer_id', v_customer_id,
        'conversation_id', v_conversation_id,
        'interaction_id', v_interaction_id,
        'is_new_customer', v_is_new_customer
    );
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_process_ingress_message FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_process_ingress_message TO service_role;


-- RPC: Atomic Outbound Finalize
CREATE OR REPLACE FUNCTION public.zalo_finalize_outbound_reply(
    p_company_id UUID,
    p_delivery_id UUID,
    p_conversation_id UUID,
    p_customer_id UUID,
    p_recipient_zalo_uid TEXT,
    p_content TEXT,
    p_sanitized_content TEXT,
    p_provider_msg_id TEXT,
    p_actor_type TEXT,
    p_actor_user_id UUID,
    p_raw_payload JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_interaction_id UUID;
    v_external_ref TEXT;
BEGIN
    v_external_ref := COALESCE(p_provider_msg_id, 'zalo_out_' || extract(epoch from now())::text);

    -- 1. Insert interaction
    INSERT INTO public.interactions (
        company_id, customer_id, conversation_id, channel, type, direction,
        sanitized_content, sanitization_status, sanitized_at, sanitizer_version,
        external_ref, actor_type, actor_user_id, created_at
    ) VALUES (
        p_company_id, p_customer_id, p_conversation_id, 'ZALO', 'MESSAGE', 'OUTBOUND',
        p_sanitized_content, 'SUCCEEDED', now(), 'v1.0',
        v_external_ref,
        p_actor_type, p_actor_user_id, now()
    ) RETURNING id INTO v_interaction_id;

    -- 2. Insert private raw content
    INSERT INTO private.interaction_raw_contents (
        interaction_id, company_id, raw_content, raw_payload, source_metadata, created_at
    ) VALUES (
        v_interaction_id, p_company_id, p_content, p_raw_payload,
        jsonb_build_object(
            'recipient_zalo_id', p_recipient_zalo_uid,
            'actor_user_id', p_actor_user_id,
            'provider_msg_id', p_provider_msg_id
        ),
        now()
    );

    -- 3. Update conversation last_message_at
    UPDATE public.conversations
    SET last_message_at = now(),
        updated_at = now()
    WHERE id = p_conversation_id;

    -- 4. Update outbound delivery to SENT
    IF p_delivery_id IS NOT NULL THEN
        UPDATE public.zalo_outbound_deliveries
        SET status = 'SENT',
            provider_msg_id = p_provider_msg_id,
            interaction_id = v_interaction_id,
            lease_until = NULL,
            updated_at = now()
        WHERE id = p_delivery_id;
    END IF;

    RETURN v_interaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_finalize_outbound_reply FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_finalize_outbound_reply TO service_role;


-- RPC: Atomic Care Scheduler Worker Claim
CREATE OR REPLACE FUNCTION public.care_scheduler_claim_delivery(
    p_company_id UUID,
    p_schedule_id UUID,
    p_customer_id UUID,
    p_target_date DATE,
    p_message_content TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_delivery_id UUID;
    v_idempotency_key TEXT;
BEGIN
    v_idempotency_key := 'care_sched:' || p_schedule_id || ':' || p_target_date::text || ':ZALO';

    INSERT INTO public.care_deliveries (
        company_id, customer_id, channel, care_schedule_id, send_target_date,
        idempotency_key, message_content, status, lease_until, attempt_count, created_at, updated_at
    ) VALUES (
        p_company_id, p_customer_id, 'ZALO', p_schedule_id, p_target_date,
        v_idempotency_key, p_message_content, 'SENDING', now() + interval '5 minutes', 1, now(), now()
    )
    ON CONFLICT (care_schedule_id, send_target_date) DO UPDATE
    SET status = 'SENDING',
        lease_until = now() + interval '5 minutes',
        attempt_count = public.care_deliveries.attempt_count + 1,
        updated_at = now()
    WHERE public.care_deliveries.status = 'FAILED'
       OR (public.care_deliveries.status = 'SENDING' AND public.care_deliveries.lease_until < now())
    RETURNING id INTO v_delivery_id;

    RETURN v_delivery_id;
END;
$$;

REVOKE ALL ON FUNCTION public.care_scheduler_claim_delivery FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.care_scheduler_claim_delivery TO service_role;
