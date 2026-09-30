-- ==============================================================================
-- Migration: TV7 Commercial Security Hardening RPCs
-- ==============================================================================

-- 1. Process Payment Webhook RPC (Multi-tenant, Full Logical Payload Idempotency, Atomic)
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
    v_normalized_payment_ref text;
    v_payload_hash text;
    v_customer_previous_stage text;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE';
    END IF;

    -- Canonicalize payment_reference (trim and uppercase, no reliance on arbitrary memo whitespace)
    v_normalized_payment_ref := UPPER(TRIM(COALESCE(p_payment_reference, '')));

    -- Strict company derivation from company_bank_accounts (no arbitrary tenant fallback)
    SELECT company_id INTO v_company_id
    FROM public.company_bank_accounts
    WHERE provider = p_provider AND provider_account = p_provider_account
    LIMIT 1;

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION 'UNKNOWN_PROVIDER_ACCOUNT: % - %', p_provider, p_provider_account;
    END IF;

    -- Concurrency & Idempotency: Advisory lock per provider event reference
    PERFORM pg_advisory_xact_lock(hashtext('PAYMENT:' || p_provider || ':' || p_provider_ref));

    -- Deterministic request fingerprint binding full logical payload
    v_payload_hash := encode(sha256(
        (v_company_id::text || '|' ||
         p_provider || '|' ||
         p_provider_account || '|' ||
         p_provider_ref || '|' ||
         p_amount::text || '|' ||
         v_normalized_payment_ref || '|' ||
         to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )::bytea
    ), 'hex');

    -- Check if existing payment transaction exists for provider and provider_ref
    SELECT * INTO v_existing_tx
    FROM public.payment_transactions
    WHERE provider = p_provider AND provider_ref = p_provider_ref
    LIMIT 1;

    IF v_existing_tx.id IS NOT NULL THEN
        -- Section 1: Full logical payload duplicate validation
        -- Reject if amount, provider_account, payment_reference, company, or payload_hash changed
        IF v_existing_tx.company_id <> v_company_id
           OR v_existing_tx.provider_account <> p_provider_account
           OR v_existing_tx.amount <> p_amount
           OR COALESCE(v_existing_tx.payment_reference, '') <> v_normalized_payment_ref
           OR (v_existing_tx.payload_hash IS NOT NULL AND v_existing_tx.payload_hash <> v_payload_hash) THEN
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
    WHERE payment_reference = v_normalized_payment_ref AND company_id = v_company_id
    FOR UPDATE;

    IF v_order.id IS NOT NULL THEN
        -- Insert matched transaction with logical fingerprint and payment reference
        INSERT INTO public.payment_transactions (
            company_id, provider, provider_account, provider_ref, amount, occurred_at, transfer_content,
            matched_order_id, match_confidence, status, payload_hash, payment_reference
        ) VALUES (
            v_company_id, p_provider, p_provider_account, p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
            v_order.id, 1.0, 'MATCHED', v_payload_hash, v_normalized_payment_ref
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

            -- Capture customer previous stage with row lock before updating
            SELECT stage INTO v_customer_previous_stage
            FROM public.customers
            WHERE id = v_order.customer_id AND company_id = v_company_id
            FOR UPDATE;

            -- Update customer stage to DEPOSIT_CONFIRMED only if in earlier stage
            IF v_customer_previous_stage IN ('LEAD_NEW', 'LEAD', 'SURVEY_SCHEDULED', 'SURVEY_COMPLETED', 'PRICE_CALCULATED', 'PRICE_OFFERED', 'NEGOTIATING', 'ORDER_CREATED') THEN
                UPDATE public.customers
                SET stage = 'DEPOSIT_CONFIRMED', updated_at = now()
                WHERE id = v_order.customer_id;

                INSERT INTO public.customer_stage_histories (
                    company_id, customer_id, from_stage, to_stage, actor_type, changed_by_user_id, reason
                ) VALUES (
                    v_company_id, v_order.customer_id, v_customer_previous_stage, 'DEPOSIT_CONFIRMED', 'SYSTEM', NULL, 'Webhook deposit payment confirmed'
                );
            END IF;
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
            matched_order_id, match_confidence, status, payload_hash, payment_reference
        ) VALUES (
            v_company_id, p_provider, p_provider_account, p_provider_ref, p_amount, p_occurred_at, p_transfer_content,
            NULL, 0, 'MANUAL_REVIEW_REQUIRED', v_payload_hash, v_normalized_payment_ref
        ) RETURNING id INTO v_tx_id;

        RETURN jsonb_build_object('status', 'MANUAL_REVIEW_REQUIRED', 'transactionId', v_tx_id);
    END IF;
END;
$$;


-- 2. Manual Deposit RPC (BOSS ONLY, Tenant Isolated, Order Bound, Cumulative)
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

        RETURN jsonb_build_object(
            'success', true,
            'status', 'ALREADY_PROCESSED',
            'orderId', v_existing_tx.matched_order_id,
            'transactionId', v_existing_tx.id
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
        'orderId', p_order_id,
        'transactionId', v_tx_id,
        'depositConfirmed', v_deposit_threshold_reached,
        'collectedAmount', v_collected_amount,
        'requiredDeposit', v_required_deposit
    );
END;
$$;


-- 3. Claim Contract Generation RPC (Atomic, Concurrency Safe, Revision Model)
CREATE OR REPLACE FUNCTION public.claim_contract_generation_rpc(
    p_company_id uuid,
    p_order_id uuid,
    p_force_revision boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
    v_current_contract public.contracts%ROWTYPE;
    v_contract_id uuid;
    v_max_revision integer := 0;
    v_next_revision integer;
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

    -- Look up current contract for this order
    SELECT * INTO v_current_contract
    FROM public.contracts
    WHERE company_id = p_company_id AND order_id = p_order_id AND is_current
    LIMIT 1;

    IF v_current_contract.id IS NOT NULL THEN
        -- Section 9: Never overwrite SIGNED contracts
        IF v_current_contract.status = 'SIGNED' AND p_force_revision THEN
            RAISE EXCEPTION 'CANNOT_REVISE_SIGNED_CONTRACT: Signed contracts cannot be regenerated or superseded';
        END IF;

        -- If not forcing revision: return existing canonical contract
        IF NOT p_force_revision THEN
            IF v_current_contract.status IN ('GENERATED', 'SENT_TO_CUSTOMER', 'SIGNED') AND v_current_contract.generated_file_ref <> 'CLAIMED' THEN
                RETURN jsonb_build_object(
                    'status', 'ALREADY_EXISTS',
                    'contractId', v_current_contract.id,
                    'revisionNo', v_current_contract.revision_no,
                    'contractStatus', v_current_contract.status,
                    'generatedFileRef', v_current_contract.generated_file_ref
                );
            END IF;

            RETURN jsonb_build_object(
                'status', 'CLAIMED',
                'contractId', v_current_contract.id,
                'revisionNo', v_current_contract.revision_no,
                'orderFinalAmount', v_order.final_amount,
                'customerId', v_order.customer_id
            );
        END IF;

        -- If explicit regeneration requested: previous current becomes SUPERSEDED, is_current = false
        UPDATE public.contracts
        SET is_current = false,
            status = 'SUPERSEDED',
            updated_at = now()
        WHERE id = v_current_contract.id;
    END IF;

    -- Determine next revision number atomically
    SELECT COALESCE(MAX(revision_no), 0) INTO v_max_revision
    FROM public.contracts
    WHERE company_id = p_company_id AND order_id = p_order_id;

    v_next_revision := v_max_revision + 1;

    -- Insert new current contract
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
        v_next_revision,
        'v1',
        'CLAIMED',
        NULL,
        'GENERATED',
        v_order.final_amount,
        true
    )
    RETURNING id INTO v_contract_id;

    RETURN jsonb_build_object(
        'status', 'CLAIMED',
        'contractId', v_contract_id,
        'revisionNo', v_next_revision,
        'orderFinalAmount', v_order.final_amount,
        'customerId', v_order.customer_id
    );
END;
$$;


-- 4. Finalize Generated Contract RPC (Path pattern bounded)
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
    v_expected_file_ref text;
BEGIN
    SELECT * INTO v_contract
    FROM public.contracts
    WHERE id = p_contract_id AND company_id = p_company_id
    FOR UPDATE;

    IF v_contract.id IS NULL THEN
        RAISE EXCEPTION 'RESOURCE_NOT_FOUND: Contract not found';
    END IF;

    IF NOT v_contract.is_current THEN
        RAISE EXCEPTION 'INVALID_CONTRACT_STATE: Cannot finalize non-current contract';
    END IF;

    -- Section 8: Validate canonical generated file path against locked contract
    v_expected_file_ref := p_company_id::text || '/contracts/' || p_contract_id::text || '/revision-' || v_contract.revision_no::text || '/generated.pdf';
    IF p_generated_file_ref <> v_expected_file_ref THEN
        RAISE EXCEPTION 'INVALID_GENERATED_FILE_REF: Provided path does not match canonical contract pattern';
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


-- 5. Finalize Contract Signing RPC (AAL2 + BOSS_ADMIN required, Canonical Ref Validated, State Machine Hardened)
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
    v_expected_file_ref text;
    v_customer_previous_stage text;
BEGIN
    -- Section 13: Strict AAL2 enforcement (no fallback)
    IF p_aal_level <> 'aal2' THEN
        RAISE EXCEPTION 'AAL2_REQUIRED: Signing contracts requires AAL2 MFA authentication';
    END IF;

    -- Validate actor is ACTIVE BOSS_ADMIN in company
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

    -- Section 7: Contract must be current
    IF NOT v_contract.is_current THEN
        RAISE EXCEPTION 'INVALID_CONTRACT_STATE: Cannot sign non-current contract';
    END IF;

    -- Section 8: Validate canonical signed_file_ref against locked contract revision
    v_expected_file_ref := p_company_id::text || '/contracts/' || p_contract_id::text || '/revision-' || v_contract.revision_no::text || '/signed.pdf';
    IF p_signed_file_ref <> v_expected_file_ref THEN
        RAISE EXCEPTION 'INVALID_SIGNED_FILE_REF: Provided path does not match canonical contract pattern';
    END IF;

    -- Section 7: If already SIGNED, deterministic idempotency only if same file ref supplied
    IF v_contract.status = 'SIGNED' THEN
        IF v_contract.signed_file_ref = p_signed_file_ref THEN
            RETURN jsonb_build_object(
                'success', true,
                'status', 'ALREADY_PROCESSED',
                'contractId', p_contract_id,
                'orderId', v_contract.order_id
            );
        ELSE
            RAISE EXCEPTION 'CONTRACT_ALREADY_SIGNED_WITH_DIFFERENT_FILE: Cannot overwrite signed contract';
        END IF;
    END IF;

    -- Section 7: Allowed source states: only GENERATED or SENT_TO_CUSTOMER
    IF v_contract.status NOT IN ('GENERATED', 'SENT_TO_CUSTOMER') THEN
        RAISE EXCEPTION 'INVALID_CONTRACT_STATE: Cannot sign contract with status %', v_contract.status;
    END IF;

    -- Section 7: generated_file_ref must be valid and not 'CLAIMED'
    IF v_contract.generated_file_ref IS NULL OR v_contract.generated_file_ref = 'CLAIMED' THEN
        RAISE EXCEPTION 'CONTRACT_NOT_READY: Contract PDF has not been generated';
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

    -- Section 3: Capture customer previous stage with row lock before updating
    SELECT stage INTO v_customer_previous_stage
    FROM public.customers
    WHERE id = v_order.customer_id AND company_id = p_company_id
    FOR UPDATE;

    -- Update customer stage to CONTRACT_SIGNED only if in earlier stage
    IF v_customer_previous_stage IN ('LEAD_NEW', 'LEAD', 'SURVEY_SCHEDULED', 'SURVEY_COMPLETED', 'PRICE_CALCULATED', 'PRICE_OFFERED', 'NEGOTIATING', 'ORDER_CREATED', 'DEPOSIT_CONFIRMED') THEN
        UPDATE public.customers
        SET stage = 'CONTRACT_SIGNED', updated_at = now()
        WHERE id = v_order.customer_id;

        INSERT INTO public.customer_stage_histories (
            company_id, customer_id, from_stage, to_stage, actor_type, changed_by_user_id, reason
        ) VALUES (
            p_company_id, v_order.customer_id, v_customer_previous_stage, 'CONTRACT_SIGNED', 'USER', p_actor_user_id, 'Contract signed by Boss Admin with AAL2'
        );
    END IF;

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
