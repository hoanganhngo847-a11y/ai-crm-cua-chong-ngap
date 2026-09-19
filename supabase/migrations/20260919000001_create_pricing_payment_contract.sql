-- ==============================================================================
-- Migration: Create Pricing, Payment, Contract, Order tables
-- ==============================================================================

-- 1. Bảng pricing_policies
CREATE TABLE public.pricing_policies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    version text NOT NULL,
    conditions jsonb,
    price_rules jsonb,
    effective_at timestamptz,
    status text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 2. Bảng price_calculations
CREATE TABLE public.price_calculations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    survey_id uuid, -- Reference to surveys(id) if exists
    input_data jsonb,
    policy_version text,
    amount numeric,
    status text DEFAULT 'NEED_INFO',
    missing_fields jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 3. Bảng orders
CREATE TABLE public.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    calculation_id uuid REFERENCES public.price_calculations(id) ON DELETE SET NULL,
    total_amount numeric,
    deposit_amount numeric,
    remaining_amount numeric,
    status text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 4. Bảng payment_transactions
CREATE TABLE public.payment_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    provider_ref text UNIQUE NOT NULL,
    amount numeric NOT NULL,
    occurred_at timestamptz NOT NULL,
    transfer_content text,
    matched_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
    match_confidence text,
    status text,
    created_at timestamptz DEFAULT now()
);

-- 5. Bảng contracts
CREATE TABLE public.contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    signed_file_ref text,
    status text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- ==============================================================================
-- RLS (Row Level Security)
-- ==============================================================================

ALTER TABLE public.pricing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;

-- Policies cho pricing_policies
CREATE POLICY "BOSS_ADMIN can do all on pricing_policies"
    ON public.pricing_policies
    FOR ALL
    TO authenticated
    USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
    WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY "SALE can view pricing_policies"
    ON public.pricing_policies
    FOR SELECT
    TO authenticated
    USING (public.has_company_role(company_id, 'SALE'));

-- Policies cho price_calculations
CREATE POLICY "BOSS_ADMIN can do all on price_calculations"
    ON public.price_calculations
    FOR ALL
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = price_calculations.customer_id 
        AND public.has_company_role(c.company_id, 'BOSS_ADMIN')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = price_calculations.customer_id 
        AND public.has_company_role(c.company_id, 'BOSS_ADMIN')
    ));

CREATE POLICY "SALE can view price_calculations"
    ON public.price_calculations
    FOR SELECT
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = price_calculations.customer_id 
        AND public.has_company_role(c.company_id, 'SALE')
    ));

-- Policies cho orders
CREATE POLICY "BOSS_ADMIN can do all on orders"
    ON public.orders
    FOR ALL
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = orders.customer_id 
        AND public.has_company_role(c.company_id, 'BOSS_ADMIN')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = orders.customer_id 
        AND public.has_company_role(c.company_id, 'BOSS_ADMIN')
    ));

CREATE POLICY "SALE can view orders"
    ON public.orders
    FOR SELECT
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = orders.customer_id 
        AND public.has_company_role(c.company_id, 'SALE')
    ));

-- Policies cho payment_transactions
CREATE POLICY "BOSS_ADMIN can do all on payment_transactions"
    ON public.payment_transactions
    FOR ALL
    TO authenticated
    USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
    WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY "SALE can view payment_transactions"
    ON public.payment_transactions
    FOR SELECT
    TO authenticated
    USING (public.has_company_role(company_id, 'SALE'));

-- Policies cho contracts
CREATE POLICY "BOSS_ADMIN can do all on contracts"
    ON public.contracts
    FOR ALL
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = contracts.customer_id 
        AND public.has_company_role(c.company_id, 'BOSS_ADMIN')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = contracts.customer_id 
        AND public.has_company_role(c.company_id, 'BOSS_ADMIN')
    ));

CREATE POLICY "SALE can view contracts"
    ON public.contracts
    FOR SELECT
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.customers c 
        WHERE c.id = contracts.customer_id 
        AND public.has_company_role(c.company_id, 'SALE')
    ));
