-- ==============================================================================
-- Migration: TV7 Trusted Commercial Atomic RPCs
-- ==============================================================================

-- 1. Save Price Calculation RPC
CREATE OR REPLACE FUNCTION public.save_price_calculation_rpc(
    p_company_id uuid,
    p_customer_id uuid,
    p_survey_id uuid,
    p_pricing_policy_id uuid,
    p_policy_version text,
    p_input_data jsonb,
    p_amount numeric,
    p_status text,
    p_missing_fields jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_calc_id uuid;
BEGIN
    -- Validate status & amount CHECK constraint invariant
    IF p_status = 'NEED_INFO' AND p_amount IS NOT NULL THEN
        RAISE EXCEPTION 'CHECK_VIOLATION: NEED_INFO must have NULL amount';
    END IF;
    IF p_status <> 'NEED_INFO' AND p_amount IS NULL THEN
        RAISE EXCEPTION 'CHECK_VIOLATION: CALCULATED status must have valid amount';
    END IF;

    -- Validate customer belongs to company
    IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id AND company_id = p_company_id) THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Customer does not belong to company';
    END IF;

    -- Validate survey if provided: must belong to same company and customer
    IF p_survey_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.surveys
            WHERE id = p_survey_id AND company_id = p_company_id AND customer_id = p_customer_id
        ) THEN
            RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Survey does not belong to company and customer';
        END IF;
    END IF;

    -- Validate pricing policy belongs to company, version matches, and is ACTIVE
    IF NOT EXISTS (
        SELECT 1 FROM public.pricing_policies 
        WHERE id = p_pricing_policy_id AND company_id = p_company_id AND version = p_policy_version AND status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Active pricing policy not found or version mismatch';
    END IF;

    INSERT INTO public.price_calculations (
        company_id,
        customer_id,
        survey_id,
        pricing_policy_id,
        policy_version,
        input_data,
        amount,
        status,
        missing_fields
    ) VALUES (
        p_company_id,
        p_customer_id,
        p_survey_id,
        p_pricing_policy_id,
        p_policy_version,
        p_input_data,
        p_amount,
        p_status,
        COALESCE(p_missing_fields, '[]'::jsonb)
    ) RETURNING id INTO v_calc_id;

    RETURN jsonb_build_object('id', v_calc_id, 'status', p_status, 'amount', p_amount);
END;
$$;

REVOKE ALL ON FUNCTION public.save_price_calculation_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_price_calculation_rpc TO service_role;


-- 2. Create Order From Calculation RPC
CREATE OR REPLACE FUNCTION public.create_order_from_calculation_rpc(
    p_company_id uuid,
    p_customer_id uuid,
    p_price_calculation_id uuid,
    p_payment_reference text,
    p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_calc public.price_calculations%ROWTYPE;
    v_order_id uuid;
    v_order_code text;
    v_current_customer_stage text;
BEGIN
    -- Validate actor user ID is provided (no arbitrary or NULL human actor allowed)
    IF p_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUIRED: Actor user ID must be provided';
    END IF;

    -- Validate actor is ACTIVE and has allowed commercial role (BOSS_ADMIN or SALE) in company
    IF NOT EXISTS (
        SELECT 1 FROM public.company_members cm
        JOIN public.user_profiles up ON cm.user_id = up.id
        WHERE cm.company_id = p_company_id
          AND cm.user_id = p_actor_user_id
          AND cm.status = 'ACTIVE'
          AND up.status = 'ACTIVE'
          AND cm.role IN ('BOSS_ADMIN', 'SALE')
    ) THEN
        RAISE EXCEPTION 'UNAUTHORIZED_ROLE: Actor must be active BOSS_ADMIN or SALE in company';
    END IF;

    -- Validate calculation exists and belongs to company & customer
    SELECT * INTO v_calc
    FROM public.price_calculations
    WHERE id = p_price_calculation_id AND company_id = p_company_id AND customer_id = p_customer_id
    FOR UPDATE;

    IF v_calc.id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Price calculation not found';
    END IF;

    IF v_calc.status <> 'CALCULATED' OR v_calc.amount IS NULL THEN
        RAISE EXCEPTION 'INVALID_PRICE_CALCULATION: Cannot create order from calculation status %', v_calc.status;
    END IF;

    -- Check customer stage
    SELECT stage INTO v_current_customer_stage
    FROM public.customers
    WHERE id = p_customer_id AND company_id = p_company_id
    FOR UPDATE;

    IF v_current_customer_stage IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Customer not found';
    END IF;

    -- Generate unique order code
    v_order_code := public.generate_order_code();

    -- Insert Order (server authoritative final_amount = calculation.amount)
    INSERT INTO public.orders (
        company_id,
        customer_id,
        order_code,
        payment_reference,
        price_calculation_id,
        deposit_status,
        order_status,
        final_amount
    ) VALUES (
        p_company_id,
        p_customer_id,
        v_order_code,
        p_payment_reference,
        v_calc.id,
        'PENDING',
        'DRAFT',
        v_calc.amount
    ) RETURNING id INTO v_order_id;

    -- Initialize Finance Summary
    INSERT INTO public.finance_summaries (
        order_id,
        company_id,
        contract_value,
        collected_amount,
        receivable_amount,
        completed_revenue
    ) VALUES (
        v_order_id,
        p_company_id,
        v_calc.amount,
        0,
        v_calc.amount,
        0
    );

    -- Update Customer stage to ORDER_CREATED only if customer is in earlier stage
    IF v_current_customer_stage IN ('LEAD_NEW', 'LEAD', 'SURVEY_SCHEDULED', 'SURVEY_COMPLETED', 'PRICE_CALCULATED', 'PRICE_OFFERED', 'NEGOTIATING') THEN
        UPDATE public.customers
        SET stage = 'ORDER_CREATED', updated_at = now()
        WHERE id = p_customer_id;

        INSERT INTO public.customer_stage_histories (
            company_id, customer_id, from_stage, to_stage, actor_type, changed_by_user_id, reason
        ) VALUES (
            p_company_id, p_customer_id, v_current_customer_stage, 'ORDER_CREATED', 'USER', p_actor_user_id, 'Order created from calculation'
        );
    END IF;

    -- Mandatory audit log inserted atomically (failure rolls back mutation)
    INSERT INTO public.audit_logs (
        company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata
    ) VALUES (
        p_company_id,
        p_actor_user_id,
        'ORDER_CREATED',
        'orders',
        v_order_id,
        p_customer_id,
        'SUCCESS',
        jsonb_build_object(
            'order_code', v_order_code,
            'price_calculation_id', v_calc.id,
            'final_amount', v_calc.amount
        )
    );

    RETURN jsonb_build_object(
        'orderId', v_order_id,
        'orderCode', v_order_code,
        'finalAmount', v_calc.amount,
        'depositStatus', 'PENDING',
        'orderStatus', 'DRAFT'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_from_calculation_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_from_calculation_rpc TO service_role;
