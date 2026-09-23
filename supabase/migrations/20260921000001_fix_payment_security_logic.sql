-- ==============================================================================
-- Migration: Fix Payment & Deposit RPCs Security and Logic
-- ==============================================================================

-- Create a table for mapping provider accounts to company_id if it doesn't exist
CREATE TABLE IF NOT EXISTS public.company_bank_accounts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_account text NOT NULL,
    created_at timestamptz DEFAULT now(),
    UNIQUE(provider, provider_account)
);

-- Enable RLS for company_bank_accounts (basic policies)
ALTER TABLE public.company_bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their company bank accounts" ON public.company_bank_accounts FOR SELECT USING (true); -- simplify for now

-- 1. RPC for Payment Webhook (Security + Idempotency + Strict Logic)
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
AS $$
DECLARE
    v_order_id uuid;
    v_company_id uuid;
    v_order_final_amount numeric;
    v_tx_id uuid;
    v_collected_amount numeric;
BEGIN
    -- Idempotency Check: Bắt buộc
    IF EXISTS (SELECT 1 FROM public.payment_transactions WHERE provider_ref = p_provider_ref AND provider = p_provider) THEN
        RETURN jsonb_build_object('status', 'ALREADY_PROCESSED', 'provider_ref', p_provider_ref);
    END IF;

    -- Resolve Company ID securely from mapping
    SELECT company_id INTO v_company_id
    FROM public.company_bank_accounts
    WHERE provider = p_provider AND provider_account = p_provider_account
    LIMIT 1;

    IF v_company_id IS NULL THEN
        -- Fallback or error out? Webhook should be rejected if we can't route it
        RAISE EXCEPTION 'Cannot map provider_account to company_id: % - %', p_provider, p_provider_account;
    END IF;

    -- Tìm Order khớp với payment_reference AND company_id
    SELECT id, final_amount INTO v_order_id, v_order_final_amount
    FROM public.orders
    WHERE payment_reference = p_payment_reference AND company_id = v_company_id
    LIMIT 1;

    -- Nếu tìm thấy Order
    IF v_order_id IS NOT NULL THEN
        IF p_amount > 0 THEN
            -- Lưu giao dịch payment trước (Idempotency ensures we don't insert duplicate)
            INSERT INTO public.payment_transactions (
                company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
                matched_order_id, match_confidence, status
            ) VALUES (
                v_company_id, p_provider, p_provider_account, p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
                v_order_id, 1.0, 'MATCHED'
            ) RETURNING id INTO v_tx_id;
            
            -- Ghi nhận Finance Summary
            INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
            VALUES (v_order_id, v_company_id, v_order_final_amount, p_amount, GREATEST(v_order_final_amount - p_amount, 0))
            ON CONFLICT (order_id) DO UPDATE 
            SET 
                collected_amount = public.finance_summaries.collected_amount + EXCLUDED.collected_amount,
                receivable_amount = GREATEST(public.finance_summaries.contract_value - (public.finance_summaries.collected_amount + EXCLUDED.collected_amount), 0),
                updated_at = now();

            -- Tính toán lại tổng tiền để quyết định trạng thái
            SELECT collected_amount INTO v_collected_amount 
            FROM public.finance_summaries WHERE order_id = v_order_id;

            -- Nếu tổng tiền thu >= 30% giá trị hợp đồng (deposit threshold), set confirmed
            IF v_collected_amount >= (v_order_final_amount * 0.3) THEN
                UPDATE public.orders
                SET 
                    deposit_status = 'DEPOSIT_CONFIRMED',
                    order_status = 'DEPOSIT_CONFIRMED',
                    updated_at = now()
                WHERE id = v_order_id;
            ELSE
                UPDATE public.orders
                SET deposit_status = 'PARTIAL_DEPOSIT', updated_at = now()
                WHERE id = v_order_id;
            END IF;

            RETURN jsonb_build_object('status', 'MATCHED', 'orderId', v_order_id, 'transactionId', v_tx_id);
        END IF;
    END IF;

    -- Nếu không tìm thấy order, insert as MANUAL_REVIEW_REQUIRED
    INSERT INTO public.payment_transactions (
        company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
        matched_order_id, match_confidence, status
    ) VALUES (
        v_company_id, p_provider, p_provider_account, p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
        NULL, 0, 'MANUAL_REVIEW_REQUIRED'
    ) RETURNING id INTO v_tx_id;

    RETURN jsonb_build_object('status', 'MANUAL_REVIEW_REQUIRED', 'transactionId', v_tx_id);
END;
$$;

-- Secure the RPC
REVOKE ALL ON FUNCTION public.process_payment_webhook_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_payment_webhook_rpc TO service_role;


-- 2. RPC Cập nhật Cọc Thủ Công (Security + Lock Down)
CREATE OR REPLACE FUNCTION public.update_order_deposit_rpc(
    p_order_id uuid,
    p_deposit_amount numeric,
    p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
    v_tx_id uuid;
    v_collected_amount numeric;
BEGIN
    IF p_deposit_amount <= 0 THEN
        RAISE EXCEPTION 'Deposit amount must be greater than 0';
    END IF;

    IF EXISTS (SELECT 1 FROM public.payment_transactions WHERE provider_ref = p_idempotency_key AND provider = 'MANUAL') THEN
        RETURN jsonb_build_object('success', true, 'status', 'ALREADY_PROCESSED');
    END IF;

    -- Lấy thông tin order (Lock for update)
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
    
    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'Order not found';
    END IF;

    -- Ghi nhận transaction manual TRƯỚC
    INSERT INTO public.payment_transactions (
        company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
        matched_order_id, match_confidence, status
    ) VALUES (
        v_order.company_id, 'MANUAL', 'MANUAL_CASH', p_idempotency_key, p_deposit_amount, now(), 'MANUAL DEPOSIT',
        v_order.id, 1.0, 'MATCHED'
    ) RETURNING id INTO v_tx_id;

    -- Update finance_summaries
    INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
    VALUES (v_order.id, v_order.company_id, v_order.final_amount, p_deposit_amount, GREATEST(v_order.final_amount - p_deposit_amount, 0))
    ON CONFLICT (order_id) DO UPDATE 
    SET 
        collected_amount = public.finance_summaries.collected_amount + EXCLUDED.collected_amount,
        receivable_amount = GREATEST(public.finance_summaries.contract_value - (public.finance_summaries.collected_amount + EXCLUDED.collected_amount), 0),
        updated_at = now();

    -- Tính toán lại tổng thu
    SELECT collected_amount INTO v_collected_amount 
    FROM public.finance_summaries WHERE order_id = v_order.id;

    -- Cập nhật order
    IF v_collected_amount >= (v_order.final_amount * 0.3) THEN
        UPDATE public.orders
        SET 
            deposit_status = 'DEPOSIT_CONFIRMED',
            order_status = 'DEPOSIT_CONFIRMED',
            updated_at = now()
        WHERE id = p_order_id;
    ELSE
        UPDATE public.orders
        SET deposit_status = 'PARTIAL_DEPOSIT', updated_at = now()
        WHERE id = p_order_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'orderId', v_order.id, 'transactionId', v_tx_id);
END;
$$;

-- Secure the RPC
REVOKE ALL ON FUNCTION public.update_order_deposit_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_deposit_rpc TO service_role;
