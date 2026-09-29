-- ==============================================================================
-- Migration: TV7 Base Commercial Mapping and Indexes
-- ==============================================================================

-- 1. Table for mapping provider accounts to company_id
CREATE TABLE IF NOT EXISTS public.company_bank_accounts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_account text NOT NULL,
    created_at timestamptz DEFAULT now(),
    UNIQUE(provider, provider_account)
);

-- Enable RLS for company_bank_accounts
ALTER TABLE public.company_bank_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their company bank accounts" ON public.company_bank_accounts;
CREATE POLICY "Users can view their company bank accounts" ON public.company_bank_accounts
    FOR SELECT TO authenticated
    USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- Indexes for efficient lookup
CREATE INDEX IF NOT EXISTS idx_company_bank_accounts_lookup 
    ON public.company_bank_accounts (provider, provider_account, company_id);

CREATE INDEX IF NOT EXISTS idx_orders_payment_reference_company
    ON public.orders (payment_reference, company_id);

CREATE INDEX IF NOT EXISTS idx_contracts_company_order
    ON public.contracts (company_id, order_id, is_current);
