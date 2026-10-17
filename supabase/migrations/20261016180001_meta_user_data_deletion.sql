-- ==============================================================================
-- Migration: Meta User Data Deletion Persistence & Enforcement
-- Description: Creates public.meta_data_deletion_requests table and trusted RPCs
--              to persist, resolve, audit, and minimize Meta User Data Deletion callbacks.
-- ==============================================================================

-- 1. Table: public.meta_data_deletion_requests
CREATE TABLE IF NOT EXISTS public.meta_data_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  confirmation_code text NOT NULL UNIQUE,
  request_fingerprint text NULL,
  meta_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSING', 'COMPLETED', 'REJECTED')),
  resolution_strategy text NOT NULL CHECK (resolution_strategy IN ('AUTO_MATCHED', 'MANUAL_REVIEW_REQUIRED', 'NO_MATCH', 'MANUAL_RESOLVED', 'MANUAL_REJECTED')),
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

-- Update resolution_strategy constraint if already created
ALTER TABLE public.meta_data_deletion_requests
  DROP CONSTRAINT IF EXISTS meta_data_deletion_requests_resolution_strategy_check;

ALTER TABLE public.meta_data_deletion_requests
  ADD CONSTRAINT meta_data_deletion_requests_resolution_strategy_check
  CHECK (resolution_strategy IN ('AUTO_MATCHED', 'MANUAL_REVIEW_REQUIRED', 'NO_MATCH', 'MANUAL_RESOLVED', 'MANUAL_REJECTED'));

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

-- 5. Helper Function: public._han_purge_customer_data
-- Internal shared customer purge implementation reused identically across AUTO_MATCHED and MANUAL_RESOLVED
CREATE OR REPLACE FUNCTION public._han_purge_customer_data(
    p_company uuid,
    p_customer uuid
)
    RETURNS void
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_company IS NULL OR p_customer IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = p_customer AND company_id = p_company
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND_IN_TENANT';
  END IF;

  -- 1. Anonymize customer record
  UPDATE public.customers
  SET name = 'Khách hàng đã xóa dữ liệu (Meta Data Deletion)',
      stage = 'LOST',
      updated_at = now()
  WHERE id = p_customer AND company_id = p_company;

  -- 2. Delete private contact details
  DELETE FROM private.customer_private_contacts
  WHERE customer_id = p_customer AND company_id = p_company;

  -- 3. Delete Facebook identities
  DELETE FROM public.identities
  WHERE customer_id = p_customer AND company_id = p_company AND channel = 'FACEBOOK';

  -- 4. Scrub interaction content
  UPDATE public.interactions
  SET sanitized_content = '[Dữ liệu cá nhân đã xóa theo yêu cầu Data Deletion của người dùng]',
      sanitization_status = 'SUCCEEDED',
      external_ref = 'del_' || id::text
  WHERE customer_id = p_customer AND company_id = p_company;

  -- 5. Close conversations
  UPDATE public.conversations
  SET status = 'CLOSED',
      unread_count = 0
  WHERE customer_id = p_customer AND company_id = p_company;
END;
$$;

-- 6. RPC: public.han_record_data_deletion_request
DROP FUNCTION IF EXISTS public.han_record_data_deletion_request(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.han_record_data_deletion_request(uuid, text, text, jsonb, text);

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
  v_subject_ref text;
  v_persisted_user_id text;
  v_persisted_raw jsonb;
BEGIN
  IF p_company IS NULL
     OR p_meta_user_id IS NULL OR length(trim(p_meta_user_id)) = 0
     OR p_confirmation_code IS NULL OR length(trim(p_confirmation_code)) = 0
     OR NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company AND status = 'ACTIVE')
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- Pseudonymous subject reference
  v_subject_ref := 'sub_' || substring(encode(sha256(trim(p_meta_user_id)::bytea), 'hex') from 1 for 16);

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

    -- Purge customer data via shared helper
    PERFORM public._han_purge_customer_data(p_company, v_customer);

    v_details := jsonb_build_object('purged_customer_id', v_customer);

    -- Identifier Minimization upon COMPLETED: scrub plaintext user identifier and raw request payload
    v_persisted_user_id := v_subject_ref;
    v_persisted_raw := jsonb_build_object('minimized', true);

  ELSIF v_matching_customers IS NOT NULL AND array_length(v_matching_customers, 1) > 1 THEN
    -- Ambiguous matches (>1). Fail closed: do NOT guess, queue for manual review.
    v_resolution := 'MANUAL_REVIEW_REQUIRED';
    v_status := 'RECEIVED';
    v_persisted_user_id := trim(p_meta_user_id);
    v_persisted_raw := jsonb_build_object(
      'algorithm', p_raw->>'algorithm',
      'issued_at', p_raw->>'issued_at',
      'user_id', trim(p_meta_user_id)
    );
    v_details := jsonb_build_object('candidate_customer_ids', v_matching_customers);

  ELSE
    -- No authoritative ASID match found in CRM for this Meta user_id.
    -- Kept safely as RECEIVED and MANUAL_REVIEW_REQUIRED. Zero heuristic guessing, zero auto-deletion.
    v_resolution := 'MANUAL_REVIEW_REQUIRED';
    v_status := 'RECEIVED';
    v_persisted_user_id := trim(p_meta_user_id);
    v_persisted_raw := jsonb_build_object(
      'algorithm', p_raw->>'algorithm',
      'issued_at', p_raw->>'issued_at',
      'user_id', trim(p_meta_user_id)
    );
    v_details := jsonb_build_object('reason', 'NO_AUTHORITATIVE_ASID_MAPPING');
  END IF;

  -- 3. Persist the deletion request with concurrency conflict protection
  v_request_id := gen_random_uuid();

  BEGIN
    INSERT INTO public.meta_data_deletion_requests (
      id, company_id, confirmation_code, request_fingerprint, meta_user_id, status, resolution_strategy, customer_id, raw_request, details, created_at, updated_at, processed_at
    ) VALUES (
      v_request_id, p_company, trim(p_confirmation_code), nullif(trim(p_request_fingerprint), ''), v_persisted_user_id, v_status, v_resolution, v_customer, v_persisted_raw, v_details, now(), now(), v_processed_at
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

  -- 4. Audit trail logging with pseudonymous subject_ref (NEVER logs plaintext meta_user_id)
  INSERT INTO public.audit_logs (
    company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata
  ) VALUES (
    p_company, NULL,
    CASE WHEN v_status = 'COMPLETED' THEN 'META_DATA_DELETION_PURGED' ELSE 'META_DATA_DELETION_RECEIVED' END,
    'meta_data_deletion_requests', v_request_id, v_customer, 'SUCCESS',
    jsonb_build_object(
      'confirmation_code', trim(p_confirmation_code),
      'request_fingerprint', trim(p_request_fingerprint),
      'subject_ref', v_subject_ref,
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

-- 7. RPC: public.han_resolve_data_deletion_request
-- Trusted service-role RPC for manual resolution of RECEIVED data deletion requests
DROP FUNCTION IF EXISTS public.han_resolve_data_deletion_request(uuid, text, text, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.han_resolve_data_deletion_request(
    p_company uuid,
    p_confirmation_code text,
    p_action text,
    p_customer_id uuid DEFAULT NULL,
    p_reason text DEFAULT NULL,
    p_admin_user_id uuid DEFAULT NULL
)
    RETURNS jsonb
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req public.meta_data_deletion_requests%ROWTYPE;
  v_subject_ref text;
  v_audit_user_id uuid := NULL;
  v_resolved_time timestamptz;
BEGIN
  IF p_company IS NULL
     OR p_confirmation_code IS NULL OR length(trim(p_confirmation_code)) = 0
     OR p_action IS NULL OR p_action NOT IN ('APPROVE', 'REJECT')
     OR NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company AND status = 'ACTIVE')
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  IF p_action = 'APPROVE' AND p_customer_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;

  -- Row-level locking to prevent race conditions during manual resolution
  SELECT * INTO v_req
  FROM public.meta_data_deletion_requests
  WHERE company_id = p_company
    AND confirmation_code = trim(p_confirmation_code)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELETION_REQUEST_NOT_FOUND';
  END IF;

  -- Ensure completed or rejected requests are not illegally reprocessed
  IF v_req.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'REQUEST_ALREADY_COMPLETED';
  END IF;

  IF v_req.status = 'REJECTED' THEN
    RAISE EXCEPTION 'REQUEST_ALREADY_REJECTED';
  END IF;

  -- Safely link admin user ID for audit log if active profile exists
  IF p_admin_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_profiles WHERE id = p_admin_user_id
  ) THEN
    v_audit_user_id := p_admin_user_id;
  END IF;

  -- Step 1: Explicit transition to PROCESSING state
  UPDATE public.meta_data_deletion_requests
  SET status = 'PROCESSING',
      updated_at = now()
  WHERE id = v_req.id;

  -- Step 2: Compute pseudonymous subject reference for minimization
  v_subject_ref := 'sub_' || substring(encode(sha256(trim(v_req.meta_user_id)::bytea), 'hex') from 1 for 16);
  v_resolved_time := now();

  IF p_action = 'APPROVE' THEN
    -- Tenant isolation enforcement: target customer MUST belong to the same company
    IF NOT EXISTS (
      SELECT 1 FROM public.customers
      WHERE id = p_customer_id AND company_id = p_company
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_NOT_FOUND_IN_TENANT';
    END IF;

    -- Purge customer data using the exact same shared logic as AUTO_MATCHED
    PERFORM public._han_purge_customer_data(p_company, p_customer_id);

    -- Finalize request to COMPLETED and scrub identifiers
    UPDATE public.meta_data_deletion_requests
    SET status = 'COMPLETED',
        resolution_strategy = 'MANUAL_RESOLVED',
        customer_id = p_customer_id,
        meta_user_id = v_subject_ref,
        raw_request = jsonb_build_object('minimized', true),
        details = jsonb_build_object(
          'manual_resolution', true,
          'resolved_by', v_audit_user_id,
          'purged_customer_id', p_customer_id,
          'notes', nullif(trim(p_reason), '')
        ),
        processed_at = v_resolved_time,
        updated_at = v_resolved_time
    WHERE id = v_req.id;

    -- Audit trail event with pseudonymous subject_ref (no plaintext Meta user ID)
    INSERT INTO public.audit_logs (
      company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata
    ) VALUES (
      p_company, v_audit_user_id,
      'META_DATA_DELETION_MANUAL_RESOLVED',
      'meta_data_deletion_requests', v_req.id, p_customer_id, 'SUCCESS',
      jsonb_build_object(
        'confirmation_code', v_req.confirmation_code,
        'subject_ref', v_subject_ref,
        'resolution_strategy', 'MANUAL_RESOLVED',
        'status', 'COMPLETED',
        'notes', nullif(trim(p_reason), '')
      )
    );

    RETURN jsonb_build_object(
      'confirmation_code', v_req.confirmation_code,
      'status', 'COMPLETED',
      'resolution_strategy', 'MANUAL_RESOLVED',
      'customer_id', p_customer_id,
      'created_at', v_req.created_at,
      'processed_at', v_resolved_time
    );

  ELSE -- REJECT
    -- Finalize request to REJECTED and scrub identifiers
    UPDATE public.meta_data_deletion_requests
    SET status = 'REJECTED',
        resolution_strategy = 'MANUAL_REJECTED',
        customer_id = NULL,
        meta_user_id = v_subject_ref,
        raw_request = jsonb_build_object('minimized', true),
        details = jsonb_build_object(
          'manual_resolution', true,
          'resolved_by', v_audit_user_id,
          'rejection_reason', coalesce(nullif(trim(p_reason), ''), 'UNVERIFIABLE_IDENTITY')
        ),
        processed_at = v_resolved_time,
        updated_at = v_resolved_time
    WHERE id = v_req.id;

    -- Audit trail event with pseudonymous subject_ref
    INSERT INTO public.audit_logs (
      company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata
    ) VALUES (
      p_company, v_audit_user_id,
      'META_DATA_DELETION_MANUAL_REJECTED',
      'meta_data_deletion_requests', v_req.id, NULL, 'SUCCESS',
      jsonb_build_object(
        'confirmation_code', v_req.confirmation_code,
        'subject_ref', v_subject_ref,
        'resolution_strategy', 'MANUAL_REJECTED',
        'status', 'REJECTED',
        'rejection_reason', coalesce(nullif(trim(p_reason), ''), 'UNVERIFIABLE_IDENTITY')
      )
    );

    RETURN jsonb_build_object(
      'confirmation_code', v_req.confirmation_code,
      'status', 'REJECTED',
      'resolution_strategy', 'MANUAL_REJECTED',
      'customer_id', NULL,
      'created_at', v_req.created_at,
      'processed_at', v_resolved_time
    );
  END IF;
END;
$$;

-- 8. RPC: public.han_get_data_deletion_status
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

-- 9. Permissions: service_role execution only for all trusted deletion RPCs
REVOKE ALL ON FUNCTION public._han_purge_customer_data(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._han_purge_customer_data(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public._han_purge_customer_data(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._han_purge_customer_data(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.han_record_data_deletion_request(uuid, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_record_data_deletion_request(uuid, text, text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.han_record_data_deletion_request(uuid, text, text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_record_data_deletion_request(uuid, text, text, jsonb, text) TO service_role;

REVOKE ALL ON FUNCTION public.han_resolve_data_deletion_request(uuid, text, text, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_resolve_data_deletion_request(uuid, text, text, uuid, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.han_resolve_data_deletion_request(uuid, text, text, uuid, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_resolve_data_deletion_request(uuid, text, text, uuid, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.han_get_data_deletion_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.han_get_data_deletion_status(text) FROM anon;
REVOKE ALL ON FUNCTION public.han_get_data_deletion_status(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.han_get_data_deletion_status(text) TO service_role;
