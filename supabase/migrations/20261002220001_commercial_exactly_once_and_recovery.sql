-- Migration: 20261002220001_commercial_exactly_once_and_recovery.sql
-- Description: Enforce exactly-one canonical Order per PriceCalculation with database UNIQUE constraint,
-- idempotent create_order_from_calculation_rpc, enriched update_order_deposit_rpc with ALREADY_PROCESSED fields,
-- and contract generation recovery.

-- 1. Deduplicate any historical duplicate orders by creating dedicated price_calculation clones, then enforce UNIQUE constraint
DO $$
DECLARE
    r RECORD;
    v_new_calc_id uuid;
BEGIN
    FOR r IN (
        SELECT o.id as order_id, o.company_id, o.customer_id, o.price_calculation_id
        FROM (
            SELECT id, company_id, customer_id, price_calculation_id,
                   ROW_NUMBER() OVER (PARTITION BY company_id, price_calculation_id ORDER BY created_at ASC, id ASC) as rn
            FROM public.orders
        ) o
        WHERE o.rn > 1
    ) LOOP
        v_new_calc_id := gen_random_uuid();
        INSERT INTO public.price_calculations (
            id, company_id, customer_id, survey_id, pricing_policy_id, policy_version, input_data, amount, status, missing_fields, created_at
        )
        SELECT v_new_calc_id, company_id, customer_id, survey_id, pricing_policy_id, policy_version, input_data, amount, status, missing_fields, created_at
        FROM public.price_calculations
        WHERE id = r.price_calculation_id;

        -- Strictly scope replica mode to rewriting the order's immutable price_calculation_id
        SET session_replication_role = 'replica';
        UPDATE public.orders
        SET price_calculation_id = v_new_calc_id
        WHERE id = r.order_id;
        SET session_replication_role = 'origin';

        -- Append-only audit record for historical duplicate order remediation
        INSERT INTO public.audit_logs (
            id,
            company_id,
            user_id,
            action,
            resource_type,
            resource_id,
            customer_id,
            result,
            metadata,
            created_at
        ) VALUES (
            gen_random_uuid(),
            r.company_id,
            NULL,
            'ORDER_PRICE_CALCULATION_REBOUND_MIGRATION',
            'orders',
            r.order_id,
            r.customer_id,
            'SUCCESS',
            jsonb_build_object(
                'migration', '20261002220001',
                'original_price_calculation_id', r.price_calculation_id,
                'replacement_price_calculation_id', v_new_calc_id,
                'reason', 'historical_duplicate_remediation'
            ),
            now()
        );
    END LOOP;

    -- Ensure session_replication_role is guaranteed origin
    SET session_replication_role = 'origin';

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_orders_company_price_calc'
    ) THEN
        ALTER TABLE public.orders
        ADD CONSTRAINT uq_orders_company_price_calc UNIQUE (company_id, price_calculation_id);
    END IF;
END $$;

-- 2. Update create_order_from_calculation_rpc with authoritative lock + existing order check + deterministic return
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
    v_existing_order public.orders%ROWTYPE;
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

    -- Validate calculation exists and belongs to company & customer (acquires authoritative lock)
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

    -- Idempotent check: After acquiring lock, re-check for an existing canonical Order
    SELECT * INTO v_existing_order
    FROM public.orders
    WHERE company_id = p_company_id AND price_calculation_id = p_price_calculation_id;

    IF v_existing_order.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'status', 'ALREADY_EXISTS',
            'orderId', v_existing_order.id,
            'orderCode', v_existing_order.order_code,
            'finalAmount', v_existing_order.final_amount,
            'depositStatus', v_existing_order.deposit_status,
            'orderStatus', v_existing_order.order_status,
            'paymentReference', v_existing_order.payment_reference
        );
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
        'status', 'CREATED',
        'orderId', v_order_id,
        'orderCode', v_order_code,
        'finalAmount', v_calc.amount,
        'depositStatus', 'PENDING',
        'orderStatus', 'DRAFT',
        'paymentReference', p_payment_reference
    );
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_from_calculation_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_from_calculation_rpc TO service_role;


-- 3. Update update_order_deposit_rpc: Enforce ALREADY_PROCESSED returning authoritative existing result
CREATE OR REPLACE FUNCTION public.update_order_deposit_rpc(
    p_company_id uuid,
    p_order_id uuid,
    p_actor_user_id uuid,
    p_deposit_amount numeric,
    p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
    v_existing_tx public.payment_transactions%ROWTYPE;
    v_tx_id uuid;
    v_collected_amount numeric;
    v_required_deposit numeric;
    v_deposit_threshold_reached boolean := false;
    v_payload_hash text;
    v_customer_previous_stage text;
BEGIN
    IF p_deposit_amount <= 0 THEN
        RAISE EXCEPTION 'Deposit amount must be greater than 0';
    END IF;

    -- Validate actor is BOSS_ADMIN in company
    IF NOT EXISTS (
        SELECT 1 FROM public.company_members cm
        JOIN public.user_profiles up ON cm.user_id = up.id
        WHERE cm.company_id = p_company_id
          AND cm.user_id = p_actor_user_id
          AND cm.status = 'ACTIVE'
          AND up.status = 'ACTIVE'
          AND cm.role = 'BOSS_ADMIN'
    ) THEN
        RAISE EXCEPTION 'UNAUTHORIZED_BOSS_REQUIRED';
    END IF;

    -- Concurrency: Advisory lock per (company_id, idempotency_key)
    PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':MANUAL:' || p_idempotency_key));

    -- Lock Order strictly scoped to company
    SELECT * INTO v_order
    FROM public.orders
    WHERE id = p_order_id AND company_id = p_company_id
    FOR UPDATE;

    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Order not found';
    END IF;

    -- Check if idempotency key was already used
    SELECT * INTO v_existing_tx
    FROM public.payment_transactions
    WHERE company_id = p_company_id AND provider = 'MANUAL' AND provider_ref = p_idempotency_key;

    IF v_existing_tx.id IS NOT NULL THEN
        -- Section 2: Idempotency must strictly bind to matched_order_id and amount
        IF v_existing_tx.matched_order_id IS DISTINCT FROM p_order_id OR v_existing_tx.amount <> p_deposit_amount THEN
            RAISE EXCEPTION 'PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';
        END IF;

        SELECT collected_amount INTO v_collected_amount 
        FROM public.finance_summaries WHERE order_id = p_order_id;

        SELECT (pp.conditions->>'deposit_percentage')::numeric / 100 * v_order.final_amount
        INTO v_required_deposit
        FROM public.price_calculations pc
        JOIN public.pricing_policies pp ON pc.pricing_policy_id = pp.id
        WHERE pc.id = v_order.price_calculation_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'ALREADY_PROCESSED',
            'orderId', v_existing_tx.matched_order_id,
            'transactionId', v_existing_tx.id,
            'depositConfirmed', (v_order.deposit_status IN ('CONFIRMED', 'DEPOSIT_CONFIRMED')),
            'collectedAmount', COALESCE(v_collected_amount, 0),
            'requiredDeposit', v_required_deposit
        );
    END IF;

    -- Compute deterministic payload hash for manual transaction
    v_payload_hash := encode(sha256(
        (p_company_id::text || ':MANUAL:' || p_idempotency_key || ':' || p_order_id::text || ':' || p_deposit_amount::text)::bytea
    ), 'hex');

    -- Insert manual transaction
    INSERT INTO public.payment_transactions (
        company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
        matched_order_id, match_confidence, status, payload_hash, payment_reference
    ) VALUES (
        p_company_id, 'MANUAL', 'MANUAL_CASH', p_idempotency_key, p_deposit_amount, now(), 'MANUAL DEPOSIT CONFIRMATION',
        v_order.id, 1.0, 'MATCHED', v_payload_hash, v_order.payment_reference
    ) RETURNING id INTO v_tx_id;

    -- Update finance_summaries
    INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
    VALUES (v_order.id, p_company_id, v_order.final_amount, p_deposit_amount, GREATEST(v_order.final_amount - p_deposit_amount, 0))
    ON CONFLICT (order_id) DO UPDATE 
    SET 
        collected_amount = public.finance_summaries.collected_amount + EXCLUDED.collected_amount,
        receivable_amount = GREATEST(public.finance_summaries.contract_value - (public.finance_summaries.collected_amount + EXCLUDED.collected_amount), 0),
        updated_at = now();

    SELECT collected_amount INTO v_collected_amount 
    FROM public.finance_summaries WHERE order_id = p_order_id;

    SELECT (pp.conditions->>'deposit_percentage')::numeric / 100 * v_order.final_amount
    INTO v_required_deposit
    FROM public.price_calculations pc
    JOIN public.pricing_policies pp ON pc.pricing_policy_id = pp.id
    WHERE pc.id = v_order.price_calculation_id;

    IF v_required_deposit IS NULL THEN
        RAISE EXCEPTION 'POLICY_CONFIGURATION_ERROR';
    END IF;

    IF v_collected_amount >= v_required_deposit THEN
        v_deposit_threshold_reached := true;
        UPDATE public.orders
        SET 
            deposit_status = 'DEPOSIT_CONFIRMED',
            order_status = 'DEPOSIT_CONFIRMED',
            updated_at = now()
        WHERE id = p_order_id;

        -- Capture customer previous stage with row lock before updating
        SELECT stage INTO v_customer_previous_stage
        FROM public.customers
        WHERE id = v_order.customer_id AND company_id = p_company_id
        FOR UPDATE;

        -- Update customer stage to DEPOSIT_CONFIRMED only if in earlier stage
        IF v_customer_previous_stage IN ('LEAD_NEW', 'LEAD', 'SURVEY_SCHEDULED', 'SURVEY_COMPLETED', 'PRICE_CALCULATED', 'PRICE_OFFERED', 'NEGOTIATING', 'ORDER_CREATED') THEN
            UPDATE public.customers
            SET stage = 'DEPOSIT_CONFIRMED', updated_at = now()
            WHERE id = v_order.customer_id;

            INSERT INTO public.customer_stage_histories (
                company_id, customer_id, from_stage, to_stage, actor_type, changed_by_user_id, reason
            ) VALUES (
                p_company_id, v_order.customer_id, v_customer_previous_stage, 'DEPOSIT_CONFIRMED', 'USER', p_actor_user_id, 'Manual deposit confirmed by Boss Admin'
            );
        END IF;
    ELSE
        UPDATE public.orders
        SET deposit_status = 'DEPOSIT_PENDING', updated_at = now()
        WHERE id = p_order_id;
    END IF;

    -- Mandatory audit log
    INSERT INTO public.audit_logs (company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
    VALUES (
        p_company_id, p_actor_user_id, 'MANUAL_DEPOSIT_CONFIRMED', 'orders', p_order_id, v_order.customer_id, 'SUCCESS',
        jsonb_build_object('amount', p_deposit_amount, 'collected_amount', v_collected_amount, 'required_deposit', v_required_deposit)
    );

    RETURN jsonb_build_object(
        'success', true,
        'status', 'MATCHED',
        'orderId', p_order_id,
        'transactionId', v_tx_id,
        'depositConfirmed', v_deposit_threshold_reached,
        'collectedAmount', v_collected_amount,
        'requiredDeposit', v_required_deposit
    );
END;
$$;

REVOKE ALL ON FUNCTION public.update_order_deposit_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_deposit_rpc TO service_role;
