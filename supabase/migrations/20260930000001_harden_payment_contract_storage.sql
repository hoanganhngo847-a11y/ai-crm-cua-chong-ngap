-- ==============================================================================
-- Migration: Fix P0/P1 Storage, Idempotency & Migration Hygiene
-- ==============================================================================

-- 1. Xóa bỏ các policy public cho bucket secure-documents
DROP POLICY IF EXISTS "Authenticated users can upload to secure-documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can download their own documents" ON storage.objects;
-- Ensure bucket is private
UPDATE storage.buckets SET public = false WHERE id = 'secure-documents';

-- 2. Đảm bảo ràng buộc tính nguyên vẹn (Unique Constraint) cho payment idempotency
ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS unique_company_provider_ref;
ALTER TABLE public.payment_transactions ADD CONSTRAINT unique_company_provider_ref UNIQUE (company_id, provider, provider_ref);

-- 3. Đảm bảo deposit_percentage hợp lệ
ALTER TABLE public.pricing_policies DROP CONSTRAINT IF EXISTS check_deposit_percentage_range;
ALTER TABLE public.pricing_policies ADD CONSTRAINT check_deposit_percentage_range 
CHECK (
    (conditions->>'deposit_percentage') IS NULL 
    OR 
    ((conditions->>'deposit_percentage')::numeric >= 0 AND (conditions->>'deposit_percentage')::numeric <= 100)
);

-- 4. Rewrite RPC process_payment_webhook_rpc
DROP FUNCTION IF EXISTS public.process_payment_webhook_rpc(text, text, text, numeric, timestamptz, text, text);
CREATE OR REPLACE FUNCTION public.process_payment_webhook_rpc(
    p_provider text,
    p_provider_account text,
    p_provider_ref text,
    p_amount numeric,
    p_occurred_at timestamptz,
    p_transfer_content text,
    p_payment_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order_id uuid;
    v_company_id uuid;
    v_order_final_amount numeric;
    v_tx_id uuid;
    v_collected_amount numeric;
    v_required_deposit numeric;
    v_old_deposit_status text;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than 0';
    END IF;

    SELECT company_id INTO v_company_id
    FROM public.company_bank_accounts
    WHERE provider = p_provider AND provider_account = p_provider_account
    LIMIT 1;

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION 'Cannot map provider_account to company_id: % - %', p_provider, p_provider_account;
    END IF;

    SELECT id, final_amount, deposit_status INTO v_order_id, v_order_final_amount, v_old_deposit_status
    FROM public.orders
    WHERE payment_reference = p_payment_reference AND company_id = v_company_id
    LIMIT 1;

    IF v_order_id IS NOT NULL THEN
        INSERT INTO public.payment_transactions (
            company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
            matched_order_id, match_confidence, status
        ) VALUES (
            v_company_id, p_provider, p_provider_account, p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
            v_order_id, 1.0, 'MATCHED'
        ) 
        ON CONFLICT (company_id, provider, provider_ref) DO NOTHING
        RETURNING id INTO v_tx_id;
        
        IF v_tx_id IS NULL THEN
            RETURN jsonb_build_object('status', 'ALREADY_PROCESSED', 'provider_ref', p_provider_ref);
        END IF;

        INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
        VALUES (v_order_id, v_company_id, v_order_final_amount, p_amount, GREATEST(v_order_final_amount - p_amount, 0))
        ON CONFLICT (order_id) DO UPDATE 
        SET 
            collected_amount = public.finance_summaries.collected_amount + EXCLUDED.collected_amount,
            receivable_amount = GREATEST(public.finance_summaries.contract_value - (public.finance_summaries.collected_amount + EXCLUDED.collected_amount), 0),
            updated_at = now();

        SELECT collected_amount INTO v_collected_amount 
        FROM public.finance_summaries WHERE order_id = v_order_id;

        SELECT (pp.conditions->>'deposit_percentage')::numeric / 100 * v_order_final_amount
             INTO v_required_deposit
             FROM public.price_calculations pc
             JOIN public.pricing_policies pp ON pc.pricing_policy_id = pp.id
             WHERE pc.id = (SELECT price_calculation_id FROM public.orders WHERE id = v_order_id);
             
        IF v_required_deposit IS NULL THEN
            RAISE EXCEPTION 'POLICY_CONFIGURATION_ERROR';
        END IF;

        IF v_collected_amount >= v_required_deposit THEN
            UPDATE public.orders
            SET 
                deposit_status = 'DEPOSIT_CONFIRMED',
                order_status = 'DEPOSIT_CONFIRMED',
                updated_at = now()
            WHERE id = v_order_id;
            
            IF v_old_deposit_status IS DISTINCT FROM 'DEPOSIT_CONFIRMED' THEN
                RETURN jsonb_build_object('status', 'MATCHED', 'deposit_state', 'DEPOSIT_JUST_CONFIRMED', 'orderId', v_order_id, 'transactionId', v_tx_id);
            END IF;
        ELSE
            UPDATE public.orders
            SET deposit_status = 'DEPOSIT_PENDING', updated_at = now()
            WHERE id = v_order_id;
        END IF;

        RETURN jsonb_build_object('status', 'MATCHED', 'orderId', v_order_id, 'transactionId', v_tx_id);
    END IF;

    INSERT INTO public.payment_transactions (
        company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
        matched_order_id, match_confidence, status
    ) VALUES (
        v_company_id, p_provider, p_provider_account, p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
        NULL, 0, 'MANUAL_REVIEW_REQUIRED'
    ) 
    ON CONFLICT (company_id, provider, provider_ref) DO NOTHING
    RETURNING id INTO v_tx_id;
    
    IF v_tx_id IS NULL THEN
        RETURN jsonb_build_object('status', 'ALREADY_PROCESSED', 'provider_ref', p_provider_ref);
    END IF;

    RETURN jsonb_build_object('status', 'MANUAL_REVIEW_REQUIRED', 'transactionId', v_tx_id);
END;
$$;
REVOKE ALL ON FUNCTION public.process_payment_webhook_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_payment_webhook_rpc TO service_role;

-- 5. Rewrite update_order_deposit_rpc
DROP FUNCTION IF EXISTS public.update_order_deposit_rpc(uuid, numeric, text);
CREATE OR REPLACE FUNCTION public.update_order_deposit_rpc(
    p_order_id uuid,
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
    v_tx_id uuid;
    v_collected_amount numeric;
    v_required_deposit numeric;
    v_old_deposit_status text;
BEGIN
    IF p_deposit_amount <= 0 THEN
        RAISE EXCEPTION 'Deposit amount must be greater than 0';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'Order not found';
    END IF;
    
    v_old_deposit_status := v_order.deposit_status;

    INSERT INTO public.payment_transactions (
        company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
        matched_order_id, match_confidence, status
    ) VALUES (
        v_order.company_id, 'MANUAL', 'MANUAL_CASH', p_idempotency_key, p_deposit_amount, now(), 'MANUAL DEPOSIT',
        v_order.id, 1.0, 'MATCHED'
    ) 
    ON CONFLICT (company_id, provider, provider_ref) DO NOTHING
    RETURNING id INTO v_tx_id;
    
    IF v_tx_id IS NULL THEN
        RETURN jsonb_build_object('success', true, 'status', 'ALREADY_PROCESSED');
    END IF;

    INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
    VALUES (v_order.id, v_order.company_id, v_order.final_amount, p_deposit_amount, GREATEST(v_order.final_amount - p_deposit_amount, 0))
    ON CONFLICT (order_id) DO UPDATE 
    SET 
        collected_amount = public.finance_summaries.collected_amount + EXCLUDED.collected_amount,
        receivable_amount = GREATEST(public.finance_summaries.contract_value - (public.finance_summaries.collected_amount + EXCLUDED.collected_amount), 0),
        updated_at = now();

    SELECT collected_amount INTO v_collected_amount 
    FROM public.finance_summaries WHERE order_id = v_order.id;

    SELECT (pp.conditions->>'deposit_percentage')::numeric / 100 * v_order.final_amount
         INTO v_required_deposit
         FROM public.price_calculations pc
         JOIN public.pricing_policies pp ON pc.pricing_policy_id = pp.id
         WHERE pc.id = v_order.price_calculation_id;

    IF v_required_deposit IS NULL THEN
        RAISE EXCEPTION 'POLICY_CONFIGURATION_ERROR';
    END IF;

    IF v_collected_amount >= v_required_deposit THEN
        UPDATE public.orders
        SET 
            deposit_status = 'DEPOSIT_CONFIRMED',
            order_status = 'DEPOSIT_CONFIRMED',
            updated_at = now()
        WHERE id = p_order_id;
        
        IF v_old_deposit_status IS DISTINCT FROM 'DEPOSIT_CONFIRMED' THEN
             RETURN jsonb_build_object('success', true, 'deposit_state', 'DEPOSIT_JUST_CONFIRMED', 'orderId', v_order.id, 'transactionId', v_tx_id);
        END IF;
    ELSE
        UPDATE public.orders
        SET deposit_status = 'DEPOSIT_PENDING', updated_at = now()
        WHERE id = p_order_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'orderId', v_order.id, 'transactionId', v_tx_id);
END;
$$;
REVOKE ALL ON FUNCTION public.update_order_deposit_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_deposit_rpc TO service_role;
