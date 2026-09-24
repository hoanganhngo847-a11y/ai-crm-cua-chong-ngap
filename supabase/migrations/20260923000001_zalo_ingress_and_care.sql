-- Migration: 20260923000001_zalo_ingress_and_care.sql
-- Module: Omnichannel Zalo OA & Care Automation
-- Standards: Multi-tenant isolation, durable idempotency, atomic ingress, delivery outbox

-- 1. Zalo OA Configurations Table (Per-tenant, per-OA credentials & durable token storage)
CREATE TABLE IF NOT EXISTS public.zalo_oa_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    oa_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    app_secret TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    token_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_zalo_oa_configs_company_oa UNIQUE (company_id, oa_id),
    CONSTRAINT uq_zalo_oa_configs_oa UNIQUE (oa_id)
);

CREATE INDEX IF NOT EXISTS idx_zalo_oa_configs_lookup ON public.zalo_oa_configs (oa_id, status);
CREATE INDEX IF NOT EXISTS idx_zalo_oa_configs_company ON public.zalo_oa_configs (company_id);

-- 2. Zalo Ingress Events Table (Durable Idempotency Claim Invariant)
CREATE TABLE IF NOT EXISTS public.zalo_ingress_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    oa_id TEXT NOT NULL,
    external_ref TEXT NOT NULL,
    event_name TEXT NOT NULL,
    sender_id TEXT,
    recipient_id TEXT,
    status TEXT NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED', 'PROCESSED', 'FAILED')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_zalo_ingress_events_claim UNIQUE (company_id, oa_id, external_ref)
);

CREATE INDEX IF NOT EXISTS idx_zalo_ingress_events_claim ON public.zalo_ingress_events (company_id, oa_id, external_ref);

-- 3. Zalo Outbound Deliveries Table (Outbound Safety & Durable Outbox)
CREATE TABLE IF NOT EXISTS public.zalo_outbound_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    recipient_zalo_uid TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
    provider_msg_id TEXT,
    interaction_id UUID REFERENCES public.interactions(id) ON DELETE SET NULL,
    error_code TEXT,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zalo_outbound_deliveries_company ON public.zalo_outbound_deliveries (company_id, status);
CREATE INDEX IF NOT EXISTS idx_zalo_outbound_deliveries_idempotency ON public.zalo_outbound_deliveries (idempotency_key);

-- 4. Enable RLS and Restrict Access
ALTER TABLE public.zalo_oa_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_ingress_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_outbound_deliveries ENABLE ROW LEVEL SECURITY;

-- Deny direct access to anon and authenticated users for security-sensitive tables
REVOKE ALL ON public.zalo_oa_configs FROM anon, authenticated;
REVOKE ALL ON public.zalo_ingress_events FROM anon, authenticated;
REVOKE ALL ON public.zalo_outbound_deliveries FROM anon, authenticated;

-- Service role has full access for server-side trusted operations
GRANT ALL ON public.zalo_oa_configs TO service_role;
GRANT ALL ON public.zalo_ingress_events TO service_role;
GRANT ALL ON public.zalo_outbound_deliveries TO service_role;
