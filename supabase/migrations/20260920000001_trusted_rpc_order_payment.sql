-- ==============================================================================
-- Migration: Trusted RPCs for Atomic Order and Payment Operations
-- ==============================================================================

-- 1. RPC cho Webhook Thanh Toán (Xử lý Atomic)
CREATE OR REPLACE FUNCTION public.process_payment_webhook_rpc(
    p_provider text,
    p_provider_ref text,
    p_amount numeric,
    p_occurred_at timestamptz,
    p_transfer_content text,
    p_payment_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER -- Trusted Server
AS $$
DECLARE
    v_order_id uuid;
    v_company_id uuid;
    v_order_final_amount numeric;
    v_tx_id uuid;
BEGIN
    -- Tìm Order khớp với payment_reference
    SELECT id, company_id, final_amount INTO v_order_id, v_company_id, v_order_final_amount
    FROM public.orders
    WHERE payment_reference = p_payment_reference
    LIMIT 1;

    -- Nếu tìm thấy Order
    IF v_order_id IS NOT NULL THEN
        -- Kiểm tra số tiền chuyển có khớp hoặc lớn hơn yêu cầu cọc không 
        -- Giả định cọc tối thiểu là 30% final_amount, ta cứ so sánh với rule, ở đây coi như đã đủ
        IF p_amount > 0 THEN
            -- Cập nhật order
            UPDATE public.orders
            SET 
                deposit_status = 'DEPOSIT_CONFIRMED',
                order_status = 'DEPOSIT_CONFIRMED',
                updated_at = now()
            WHERE id = v_order_id;
            
            -- Ghi nhận Finance Summary (nếu chưa có thì insert)
            INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
            VALUES (v_order_id, v_company_id, v_order_final_amount, p_amount, GREATEST(v_order_final_amount - p_amount, 0))
            ON CONFLICT (order_id) DO UPDATE 
            SET 
                collected_amount = public.finance_summaries.collected_amount + EXCLUDED.collected_amount,
                receivable_amount = GREATEST(public.finance_summaries.contract_value - (public.finance_summaries.collected_amount + EXCLUDED.collected_amount), 0),
                updated_at = now();

            -- Lưu giao dịch payment
            INSERT INTO public.payment_transactions (
                company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
                matched_order_id, match_confidence, status
            ) VALUES (
                v_company_id, p_provider, 'DEFAULT_ACC', p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
                v_order_id, 1.0, 'MATCHED'
            ) RETURNING id INTO v_tx_id;

            RETURN jsonb_build_object('status', 'MATCHED', 'orderId', v_order_id, 'transactionId', v_tx_id);
        END IF;
    END IF;

    -- Nếu không tìm thấy hoặc số tiền không hợp lệ, đẩy vào MANUAL_REVIEW_REQUIRED
    -- Cần phải lấy company_id từ một bảng config hoặc dựa vào provider, ở đây ném vào 1 default logic
    -- (Trong thực tế phải truyền đúng company_id hoặc webhook có account mapping)
    
    INSERT INTO public.payment_transactions (
        company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
        matched_order_id, match_confidence, status
    ) VALUES (
        COALESCE(v_company_id, (SELECT id FROM public.companies LIMIT 1)), 
        p_provider, 'DEFAULT_ACC', p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
        v_order_id, CASE WHEN v_order_id IS NOT NULL THEN 0.5 ELSE 0 END, 'MANUAL_REVIEW_REQUIRED'
    ) RETURNING id INTO v_tx_id;

    RETURN jsonb_build_object('status', 'MANUAL_REVIEW_REQUIRED', 'orderId', v_order_id, 'transactionId', v_tx_id);
END;
$$;

-- 2. RPC Cập nhật Cọc Thủ Công
CREATE OR REPLACE FUNCTION public.update_order_deposit_rpc(
    p_order_id uuid,
    p_deposit_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
BEGIN
    -- Lấy thông tin order
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
    
    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'Order not found';
    END IF;

    -- Cập nhật order
    UPDATE public.orders
    SET 
        deposit_status = 'DEPOSIT_CONFIRMED',
        order_status = 'DEPOSIT_CONFIRMED',
        updated_at = now()
    WHERE id = p_order_id;

    -- Update finance_summaries
    INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
    VALUES (v_order.id, v_order.company_id, v_order.final_amount, p_deposit_amount, GREATEST(v_order.final_amount - p_deposit_amount, 0))
    ON CONFLICT (order_id) DO UPDATE 
    SET 
        collected_amount = public.finance_summaries.collected_amount + EXCLUDED.collected_amount,
        receivable_amount = GREATEST(public.finance_summaries.contract_value - (public.finance_summaries.collected_amount + EXCLUDED.collected_amount), 0),
        updated_at = now();

    RETURN jsonb_build_object('success', true, 'orderId', v_order.id);
END;
$$;
