-- ==============================================================================
-- Migration: TV7 Commercial Security Hardening RPCs
-- ==============================================================================

-- 1. Process Payment Webhook RPC (Multi-tenant, Idempotent, Atomic)
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
    v_company_id uuid;
    v_order public.orders%ROWTYPE;
    v_existing_tx public.payment_transactions%ROWTYPE;
    v_tx_id uuid;
    v_collected_amount numeric;
    v_required_deposit numeric;
    v_deposit_threshold_reached boolean := false;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE';
    END IF;

    -- Strict company derivation from company_bank_accounts (no arbitrary tenant fallback!)
    SELECT company_id INTO v_company_id
    FROM public.company_bank_accounts
    WHERE provider = p_provider AND provider_account = p_provider_account
    LIMIT 1;

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION 'UNKNOWN_PROVIDER_ACCOUNT: % - %', p_provider, p_provider_account;
    END IF;

    -- Concurrency & Idempotency: Advisory lock on (company_id, provider, provider_ref)
    PERFORM pg_advisory_xact_lock(hashtext(v_company_id::text || ':' || p_provider || ':' || p_provider_ref));

    -- Check if existing payment transaction exists
    SELECT * INTO v_existing_tx
    FROM public.payment_transactions
    WHERE company_id = v_company_id AND provider = p_provider AND provider_ref = p_provider_ref;

    IF v_existing_tx.id IS NOT NULL THEN
        -- Section 15: Payload fingerprint check. Same key + changed amount -> reject
        IF v_existing_tx.amount <> p_amount THEN
            RAISE EXCEPTION 'PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';
        END IF;

        RETURN jsonb_build_object(
            'status', 'ALREADY_PROCESSED',
            'transactionId', v_existing_tx.id,
            'provider_ref', p_provider_ref,
            'orderId', v_existing_tx.matched_order_id
        );
    END IF;

    -- Look up Order by payment_reference strictly scoped to v_company_id
    SELECT * INTO v_order
    FROM public.orders
    WHERE payment_reference = p_payment_reference AND company_id = v_company_id
    FOR UPDATE;

    IF v_order.id IS NOT NULL THEN
        -- Insert matched transaction
        INSERT INTO public.payment_transactions (
            company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
            matched_order_id, match_confidence, status
        ) VALUES (
            v_company_id, p_provider, p_provider_account, p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
            v_order.id, 1.0, 'MATCHED'
        ) RETURNING id INTO v_tx_id;

        -- Update finance_summaries atomically
        INSERT INTO public.finance_summaries (order_id, company_id, contract_value, collected_amount, receivable_amount)
        VALUES (v_order.id, v_company_id, v_order.final_amount, p_amount, GREATEST(v_order.final_amount - p_amount, 0))
        ON CONFLICT (order_id) DO UPDATE 
        SET 
            collected_amount = public.finance_summaries.collected_amount + EXCLUDED.collected_amount,
            receivable_amount = GREATEST(public.finance_summaries.contract_value - (public.finance_summaries.collected_amount + EXCLUDED.collected_amount), 0),
            updated_at = now();

        -- Calculate cumulative collected amount
        SELECT collected_amount INTO v_collected_amount 
        FROM public.finance_summaries WHERE order_id = v_order.id;

        -- Retrieve required deposit from pricing policy conditions
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
            WHERE id = v_order.id;

            -- Update customer stage to DEPOSIT_CONFIRMED if in earlier stage
            UPDATE public.customers
            SET stage = 'DEPOSIT_CONFIRMED', updated_at = now()
            WHERE id = v_order.customer_id
              AND stage IN ('LEAD_NEW', 'LEAD', 'SURVEY_SCHEDULED', 'SURVEY_COMPLETED', 'PRICE_CALCULATED', 'PRICE_OFFERED', 'NEGOTIATING', 'ORDER_CREATED');

            INSERT INTO public.customer_stage_histories (
                company_id, customer_id, from_stage, to_stage, actor_type, changed_by_user_id, reason
            ) VALUES (
                v_company_id, v_order.customer_id, v_order.deposit_status, 'DEPOSIT_CONFIRMED', 'SYSTEM', NULL, 'Webhook deposit payment confirmed'
            );
        ELSE
            UPDATE public.orders
            SET deposit_status = 'DEPOSIT_PENDING', updated_at = now()
            WHERE id = v_order.id;
        END IF;

        RETURN jsonb_build_object(
            'status', 'MATCHED',
            'orderId', v_order.id,
            'transactionId', v_tx_id,
            'depositConfirmed', v_deposit_threshold_reached,
            'collectedAmount', v_collected_amount,
            'requiredDeposit', v_required_deposit
        );
    ELSE
        -- If order not found, insert as MANUAL_REVIEW_REQUIRED with 0 match confidence
        INSERT INTO public.payment_transactions (
            company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
            matched_order_id, match_confidence, status
        ) VALUES (
            v_company_id, p_provider, p_provider_account, p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
            NULL, 0, 'MANUAL_REVIEW_REQUIRED'
        ) RETURNING id INTO v_tx_id;

        RETURN jsonb_build_object('status', 'MANUAL_REVIEW_REQUIRED', 'transactionId', v_tx_id);
    END IF;
END;
$$;


-- 2. Manual Deposit RPC (BOSS ONLY, Tenant Isolated, Cumulative)
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
BEGIN
    IF p_deposit_amount <= 0 THEN
        RAISE EXCEPTION 'Deposit amount must be greater than 0';
    END IF;

    -- Section 17: Validate actor is BOSS_ADMIN in company
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
        IF v_existing_tx.amount <> p_deposit_amount THEN
            RAISE EXCEPTION 'PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'ALREADY_PROCESSED',
            'orderId', p_order_id,
            'transactionId', v_existing_tx.id
        );
    END IF;

    -- Insert manual transaction
    INSERT INTO public.payment_transactions (
        company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
        matched_order_id, match_confidence, status
    ) VALUES (
        p_company_id, 'MANUAL', 'MANUAL_CASH', p_idempotency_key, p_deposit_amount, now(), 'MANUAL DEPOSIT CONFIRMATION',
        v_order.id, 1.0, 'MATCHED'
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

        UPDATE public.customers
        SET stage = 'DEPOSIT_CONFIRMED', updated_at = now()
        WHERE id = v_order.customer_id
          AND stage IN ('LEAD_NEW', 'LEAD', 'SURVEY_SCHEDULED', 'SURVEY_COMPLETED', 'PRICE_CALCULATED', 'PRICE_OFFERED', 'NEGOTIATING', 'ORDER_CREATED');

        INSERT INTO public.customer_stage_histories (
            company_id, customer_id, from_stage, to_stage, actor_type, changed_by_user_id, reason
        ) VALUES (
            p_company_id, v_order.customer_id, v_order.deposit_status, 'DEPOSIT_CONFIRMED', 'USER', p_actor_user_id, 'Manual deposit confirmed by Boss Admin'
        );
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
        'orderId', p_order_id,
        'transactionId', v_tx_id,
        'depositConfirmed', v_deposit_threshold_reached,
        'collectedAmount', v_collected_amount,
        'requiredDeposit', v_required_deposit
    );
END;
$$;


-- 3. Claim Contract Generation RPC (Atomic, Concurrency Safe)
CREATE OR REPLACE FUNCTION public.claim_contract_generation_rpc(
    p_company_id uuid,
    p_order_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
    v_existing_contract public.contracts%ROWTYPE;
    v_contract_id uuid;
    v_revision_no integer := 1;
BEGIN
    -- Advisory lock per (company_id, order_id)
    PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':CONTRACT:' || p_order_id::text));

    SELECT * INTO v_order
    FROM public.orders
    WHERE id = p_order_id AND company_id = p_company_id
    FOR UPDATE;

    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Order not found';
    END IF;

    IF v_order.deposit_status <> 'DEPOSIT_CONFIRMED' THEN
        RAISE EXCEPTION 'DEPOSIT_NOT_CONFIRMED: Cannot generate contract until deposit is confirmed';
    END IF;

    -- Check if contract already exists
    SELECT * INTO v_existing_contract
    FROM public.contracts
    WHERE company_id = p_company_id AND order_id = p_order_id AND is_current
    LIMIT 1;

    IF v_existing_contract.id IS NOT NULL THEN
        IF v_existing_contract.status IN ('GENERATED', 'SENT_TO_CUSTOMER', 'SIGNED') AND v_existing_contract.generated_file_ref <> 'CLAIMED' THEN
            RETURN jsonb_build_object(
                'status', 'ALREADY_EXISTS',
                'contractId', v_existing_contract.id,
                'revisionNo', v_existing_contract.revision_no,
                'contractStatus', v_existing_contract.status,
                'generatedFileRef', v_existing_contract.generated_file_ref
            );
        END IF;
    END IF;

    -- Insert or claim contract row
    INSERT INTO public.contracts (
        company_id,
        order_id,
        revision_no,
        template_version,
        generated_file_ref,
        signed_file_ref,
        status,
        contract_value,
        is_current
    ) VALUES (
        p_company_id,
        p_order_id,
        v_revision_no,
        'v1',
        'CLAIMED',
        NULL,
        'GENERATED',
        v_order.final_amount,
        true
    )
    ON CONFLICT (order_id, revision_no) DO UPDATE
    SET updated_at = now()
    RETURNING id INTO v_contract_id;

    RETURN jsonb_build_object(
        'status', 'CLAIMED',
        'contractId', v_contract_id,
        'revisionNo', v_revision_no,
        'orderFinalAmount', v_order.final_amount,
        'customerId', v_order.customer_id
    );
END;
$$;


-- 4. Finalize Generated Contract RPC
CREATE OR REPLACE FUNCTION public.finalize_generated_contract_rpc(
    p_company_id uuid,
    p_contract_id uuid,
    p_generated_file_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_contract public.contracts%ROWTYPE;
BEGIN
    SELECT * INTO v_contract
    FROM public.contracts
    WHERE id = p_contract_id AND company_id = p_company_id
    FOR UPDATE;

    IF v_contract.id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Contract not found';
    END IF;

    UPDATE public.contracts
    SET 
        generated_file_ref = p_generated_file_ref,
        status = 'GENERATED',
        updated_at = now()
    WHERE id = p_contract_id;

    RETURN jsonb_build_object('success', true, 'contractId', p_contract_id, 'fileRef', p_generated_file_ref);
END;
$$;


-- 5. Finalize Contract Signing RPC (AAL2 + BOSS_ADMIN required, Atomic)
CREATE OR REPLACE FUNCTION public.finalize_contract_signing_rpc(
    p_company_id uuid,
    p_contract_id uuid,
    p_actor_user_id uuid,
    p_signed_file_ref text,
    p_aal_level text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_contract public.contracts%ROWTYPE;
    v_order public.orders%ROWTYPE;
BEGIN
    -- Section 30: AAL2 enforcement
    IF p_aal_level <> 'aal2' THEN
        RAISE EXCEPTION 'AAL2_REQUIRED: Signing contracts requires AAL2 MFA authentication';
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

    -- Lock Contract
    SELECT * INTO v_contract
    FROM public.contracts
    WHERE id = p_contract_id AND company_id = p_company_id
    FOR UPDATE;

    IF v_contract.id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Contract not found';
    END IF;

    -- Lock Order
    SELECT * INTO v_order
    FROM public.orders
    WHERE id = v_contract.order_id AND company_id = p_company_id
    FOR UPDATE;

    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Order not found';
    END IF;

    -- Update contract
    UPDATE public.contracts
    SET 
        status = 'SIGNED',
        signed_at = now(),
        signed_file_ref = p_signed_file_ref,
        updated_at = now()
    WHERE id = p_contract_id;

    -- Update order to CONTRACT_SIGNED
    UPDATE public.orders
    SET 
        order_status = 'CONTRACT_SIGNED',
        updated_at = now()
    WHERE id = v_order.id;

    -- Update customer stage to CONTRACT_SIGNED
    UPDATE public.customers
    SET stage = 'CONTRACT_SIGNED', updated_at = now()
    WHERE id = v_order.customer_id;

    INSERT INTO public.customer_stage_histories (
        company_id, customer_id, from_stage, to_stage, actor_type, changed_by_user_id, reason
    ) VALUES (
        p_company_id, v_order.customer_id, v_order.order_status, 'CONTRACT_SIGNED', 'USER', p_actor_user_id, 'Contract signed by Boss Admin with AAL2'
    );

    -- Insert audit log
    INSERT INTO public.audit_logs (
        company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata
    ) VALUES (
        p_company_id, p_actor_user_id, 'CONTRACT_SIGNED', 'contracts', p_contract_id, v_order.customer_id, 'SUCCESS',
        jsonb_build_object('signed_file_ref', p_signed_file_ref, 'order_id', v_order.id, 'signed_at', now())
    );

    RETURN jsonb_build_object('success', true, 'contractId', p_contract_id, 'orderId', v_order.id, 'status', 'SIGNED');
END;
$$;

-- Explicit ACL: Revoke all from PUBLIC, anon, authenticated; Grant exclusively to service_role
REVOKE ALL ON FUNCTION public.process_payment_webhook_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_payment_webhook_rpc TO service_role;

REVOKE ALL ON FUNCTION public.update_order_deposit_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_deposit_rpc TO service_role;

REVOKE ALL ON FUNCTION public.claim_contract_generation_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contract_generation_rpc TO service_role;

REVOKE ALL ON FUNCTION public.finalize_generated_contract_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_generated_contract_rpc TO service_role;

REVOKE ALL ON FUNCTION public.finalize_contract_signing_rpc FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_contract_signing_rpc TO service_role;
