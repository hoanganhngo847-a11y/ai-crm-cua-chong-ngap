-- ==============================================================================
-- Migration: Meta User Data Deletion Persistence & Enforcement
-- Description: Creates public.meta_data_deletion_requests table and trusted RPCs
--              to persist, resolve, and audit Meta User Data Deletion callbacks.
-- ==============================================================================

-- 1. Table: public.meta_data_deletion_requests
CREATE TABLE IF NOT EXISTS public.meta_data_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  confirmation_code text NOT NULL UNIQUE,
  request_fingerprint text NULL,
  meta_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSING', 'COMPLETED', 'REJECTED')),
  resolution_strategy text NOT NULL CHECK (resolution_strategy IN ('AUTO_MATCHED', 'MANUAL_REVIEW_REQUIRED', 'NO_MATCH')),
  customer_id uuid NULL REFERENCES public.customers(id) ON DELETE SET NULL,
  raw_request jsonb NOT NULL DEFAULT '{}'::jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NULL,
  CONSTRAINT chk_meta_data_deletion_code_format CHECK (confirmation_code ~ '^del_[a-f0-9]{8,64}$')
);

-- Ensure request_fingerprint column exists for incremental schema application
ALTER TABLE public.meta_data_deletion_requests
  ADD COLUMN IF NOT EXISTS request_fingerprint text NULL;

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_meta_data_deletion_code
  ON public.meta_data_deletion_requests (confirmation_code);

CREATE INDEX IF NOT EXISTS idx_meta_data_deletion_company_status
  ON public.meta_data_deletion_requests (company_id, status);

CREATE INDEX IF NOT EXISTS idx_meta_data_deletion_user
  ON public.meta_data_deletion_requests (company_id, meta_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_data_deletion_company_fingerprint
  ON public.meta_data_deletion_requests (company_id, request_fingerprint)
  WHERE request_fingerprint IS NOT NULL;

-- 3. RLS
ALTER TABLE public.meta_data_deletion_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_data_deletion_requests_select_boss_admin ON public.meta_data_deletion_requests;
CREATE POLICY meta_data_deletion_requests_select_boss_admin
  ON public.meta_data_deletion_requests
  FOR SELECT
  TO authenticated
  USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      JOIN public.user_profiles up ON up.id = cm.user_id
      WHERE cm.user_id = (SELECT auth.uid())
        AND cm.status = 'ACTIVE'
        AND up.status = 'ACTIVE'
        AND cm.role = 'BOSS_ADMIN'
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.meta_data_deletion_requests FROM authenticated, anon;
GRANT SELECT ON public.meta_data_deletion_requests TO authenticated;
GRANT ALL ON public.meta_data_deletion_requests TO service_role;

-- 4. Trigger: update_updated_at_column
DROP TRIGGER IF EXISTS trg_updated_at_meta_data_deletion ON public.meta_data_deletion_requests;
CREATE TRIGGER trg_updated_at_meta_data_deletion
  BEFORE UPDATE ON public.meta_data_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. RPC: public.han_record_data_deletion_request
DROP FUNCTION IF EXISTS public.han_record_data_deletion_request(uuid, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.han_record_data_deletion_request(
    p_company uuid,
    p_meta_user_id text,
    p_confirmation_code text,
    p_raw jsonb,
    p_request_fingerprint text DEFAULT NULL
)
    RETURNS jsonb
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.meta_data_deletion_requests%ROWTYPE;
  v_matching_customers uuid[];
  v_customer uuid := NULL;
  v_resolution text := 'NO_MATCH';
  v_status text := 'RECEIVED';
  v_processed_at timestamptz := NULL;
  v_details jsonb := '{}'::jsonb;
  v_request_id uuid;
BEGIN
  IF p_company IS NULL
     OR p_meta_user_id IS NULL OR length(trim(p_meta_user_id)) = 0
     OR p_confirmation_code IS NULL OR length(trim(p_confirmation_code)) = 0
     OR NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company AND status = 'ACTIVE')
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- 1a. Idempotency check by request_fingerprint (exact retry of Meta webhook callback)
  IF p_request_fingerprint IS NOT NULL AND length(trim(p_request_fingerprint)) > 0 THEN
    SELECT * INTO v_existing
    FROM public.meta_data_deletion_requests
    WHERE company_id = p_company
      AND request_fingerprint = trim(p_request_fingerprint);

    IF FOUND THEN
      RETURN jsonb_build_object(
        'confirmation_code', v_existing.confirmation_code,
        'status', v_existing.status,
        'resolution_strategy', v_existing.resolution_strategy,
        'customer_id', v_existing.customer_id,
        'created_at', v_existing.created_at,
        'processed_at', v_existing.processed_at
      );
    END IF;
  END IF;

  -- 1b. Idempotency check by confirmation_code
  SELECT * INTO v_existing
  FROM public.meta_data_deletion_requests
  WHERE confirmation_code = trim(p_confirmation_code);

  IF FOUND THEN
    RETURN jsonb_build_object(
      'confirmation_code', v_existing.confirmation_code,
      'status', v_existing.status,
      'resolution_strategy', v_existing.resolution_strategy,
      'customer_id', v_existing.customer_id,
      'created_at', v_existing.created_at,
      'processed_at', v_existing.processed_at
    );
  END IF;

  -- 2. Identity Resolution strictly within tenant:
  -- Only authoritative explicit ASID mapping (metadata->>'asid' or metadata->>'meta_asid') is accepted.
  -- Heuristic string equality or suffix matching on PSID (external_id) is STRICTLY PROHIBITED.
  SELECT array_agg(DISTINCT customer_id)
  INTO v_matching_customers
  FROM public.identities
  WHERE company_id = p_company
    AND channel = 'FACEBOOK'
    AND (
      metadata->>'asid' = trim(p_meta_user_id)
      OR metadata->>'meta_asid' = trim(p_meta_user_id)
    );

  IF v_matching_customers IS NOT NULL AND array_length(v_matching_customers, 1) = 1 THEN
    v_customer := v_matching_customers[1];
    v_resolution := 'AUTO_MATCHED';
    v_status := 'COMPLETED';
    v_processed_at := now();

    -- Anonymize customer record
    UPDATE public.customers
    SET name = 'Khách hàng đã xóa dữ liệu (Meta Data Deletion)',
        stage = 'LOST',
        updated_at = now()
    WHERE id = v_customer AND company_id = p_company;

    -- Delete private contact details
    DELETE FROM private.customer_private_contacts
    WHERE customer_id = v_customer AND company_id = p_company;

    -- Delete Facebook identities
    DELETE FROM public.identities
    WHERE customer_id = v_customer AND company_id = p_company AND channel = 'FACEBOOK';

    -- Scrub interaction content
    UPDATE public.interactions
    SET sanitized_content = '[Dữ liệu cá nhân đã xóa theo yêu cầu Data Deletion của người dùng]',
        sanitization_status = 'SUCCEEDED',
        external_ref = 'del_' || id::text
    WHERE customer_id = v_customer AND company_id = p_company;

    -- Close conversations
    UPDATE public.conversations
    SET status = 'CLOSED',
        unread_count = 0
    WHERE customer_id = v_customer AND company_id = p_company;

    v_details := jsonb_build_object('purged_customer_id', v_customer);

  ELSIF v_matching_customers IS NOT NULL AND array_length(v_matching_customers, 1) > 1 THEN
    -- Ambiguous matches (>1). Fail closed: do NOT guess, queue for manual review.
    v_resolution := 'MANUAL_REVIEW_REQUIRED';
    v_status := 'RECEIVED';
    v_details := jsonb_build_object('candidate_customer_ids', v_matching_customers);

  ELSE
    -- No authoritative ASID match found in CRM for this Meta user_id.
    -- Kept safely as RECEIVED and MANUAL_REVIEW_REQUIRED. Zero heuristic guessing, zero auto-deletion.
    v_resolution := 'MANUAL_REVIEW_REQUIRED';
    v_status := 'RECEIVED';
    v_details := jsonb_build_object('reason', 'NO_AUTHORITATIVE_ASID_MAPPING', 'meta_user_id', trim(p_meta_user_id));
  END IF;

  -- 3. Persist the deletion request with concurrency conflict protection
  v_request_id := gen_random_uuid();

  BEGIN
    INSERT INTO public.meta_data_deletion_requests (
      id, company_id, confirmation_code, request_fingerprint, meta_user_id, status, resolution_strategy, customer_id, raw_request, details, created_at, updated_at, processed_at
    ) VALUES (
      v_request_id, p_company, trim(p_confirmation_code), nullif(trim(p_request_fingerprint), ''), trim(p_meta_user_id), v_status, v_resolution, v_customer, p_raw, v_details, now(), now(), v_processed_at
    );
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent exact retry or race condition: fetch the winning record
    IF p_request_fingerprint IS NOT NULL AND length(trim(p_request_fingerprint)) > 0 THEN
      SELECT * INTO v_existing
      FROM public.meta_data_deletion_requests
      WHERE company_id = p_company
        AND request_fingerprint = trim(p_request_fingerprint);
      IF FOUND THEN
        RETURN jsonb_build_object(
          'confirmation_code', v_existing.confirmation_code,
          'status', v_existing.status,
          'resolution_strategy', v_existing.resolution_strategy,
          'customer_id', v_existing.customer_id,
          'created_at', v_existing.created_at,
          'processed_at', v_existing.processed_at
        );
      END IF;
    END IF;

    SELECT * INTO v_existing
    FROM public.meta_data_deletion_requests
    WHERE confirmation_code = trim(p_confirmation_code);
    IF FOUND THEN
      RETURN jsonb_build_object(
        'confirmation_code', v_existing.confirmation_code,
        'status', v_existing.status,
        'resolution_strategy', v_existing.resolution_strategy,
        'customer_id', v_existing.customer_id,
        'created_at', v_existing.created_at,
        'processed_at', v_existing.processed_at
      );
    END IF;
    RAISE;
  END;

  -- 4. Audit trail logging with valid resource_id and result
  INSERT INTO public.audit_logs (
    company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata
  ) VALUES (
    p_company, NULL,
    CASE WHEN v_status = 'COMPLETED' THEN 'META_DATA_DELETION_PURGED' ELSE 'META_DATA_DELETION_RECEIVED' END,
    'meta_data_deletion_requests', v_request_id, v_customer, 'SUCCESS',
    jsonb_build_object(
      'confirmation_code', trim(p_confirmation_code),
      'request_fingerprint', trim(p_request_fingerprint),
      'meta_user_id', trim(p_meta_user_id),
      'resolution_strategy', v_resolution,
      'status', v_status
    )
  );

  RETURN jsonb_build_object(
    'confirmation_code', trim(p_confirmation_code),
    'status', v_status,
    'resolution_strategy', v_resolution,
    'customer_id', v_customer,
    'created_at', now(),
    'processed_at', v_processed_at
  );
END;
$$;

-- 6. RPC: public.han_get_data_deletion_status
CREATE OR REPLACE FUNCTION public.han_get_data_deletion_status(
    p_confirmation_code text
)
    RETURNS jsonb
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.meta_data_deletion_requests%ROWTYPE;
BEGIN
  IF p_confirmation_code IS NULL OR length(trim(p_confirmation_code)) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.meta_data_deletion_requests
  WHERE confirmation_code = trim(p_confirmation_code);

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'confirmation_code', v_row.confirmation_code,
    'status', v_row.status,
    'resolution_strategy', v_row.resolution_strategy,
    'created_at', v_row.created_at,
    'processed_at', v_row.processed_at
  );
END;
$$;

-- Permissions: service_role execution only
REVOKE ALL ON FUNCTION public.han_record_data_deletion_request(uuid, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_record_data_deletion_request(uuid, text, text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.han_record_data_deletion_request(uuid, text, text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_record_data_deletion_request(uuid, text, text, jsonb, text) TO service_role;

REVOKE ALL ON FUNCTION public.han_get_data_deletion_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_get_data_deletion_status(text) FROM anon;
REVOKE ALL ON FUNCTION public.han_get_data_deletion_status(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_get_data_deletion_status(text) TO service_role;
