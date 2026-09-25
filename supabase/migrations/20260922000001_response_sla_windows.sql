-- Migration 005: Durable Response SLA Windows & Atomic AI Claim
-- Implements durable 5-minute Response SLA state, single-open invariant,
-- state integrity constraints, recoverable AI claim lease, Sale resolution,
-- and atomic AI claim with canonical re-checks and transactional audit logging.

-- ------------------------------------------------------------------------------
-- 1. TABLE: response_sla_windows
-- ------------------------------------------------------------------------------
CREATE TABLE public.response_sla_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  company_id uuid NOT NULL
    REFERENCES public.companies(id)
    ON DELETE RESTRICT,

  conversation_id uuid NOT NULL,

  customer_id uuid NOT NULL,

  trigger_interaction_id uuid NOT NULL,

  started_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,

  state text NOT NULL
    CHECK (state IN (
      'OPEN',
      'SALE_RESPONDED',
      'AI_RESPONDED',
      'CANCELLED'
    )),

  resolved_at timestamptz NULL,

  sale_response_interaction_id uuid NULL,
  ai_response_interaction_id uuid NULL,

  ai_claimed_at timestamptz NULL,
  ai_claim_id uuid NULL,
  ai_claim_expires_at timestamptz NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Note on composite keys: Conversations uses composite key (company_id, customer_id, id).
  -- Interactions uses global UUID primary key (id). The tenant relationship between
  -- interaction and company/customer/conversation is strictly validated by bounded RPCs.
  CONSTRAINT fk_response_sla_conversation
    FOREIGN KEY (company_id, customer_id, conversation_id)
    REFERENCES public.conversations(company_id, customer_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_response_sla_trigger_interaction
    FOREIGN KEY (trigger_interaction_id)
    REFERENCES public.interactions(id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_response_sla_sale_response
    FOREIGN KEY (sale_response_interaction_id)
    REFERENCES public.interactions(id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_response_sla_ai_response
    FOREIGN KEY (ai_response_interaction_id)
    REFERENCES public.interactions(id)
    ON DELETE RESTRICT,

  CONSTRAINT chk_response_sla_deadline
    CHECK (deadline_at = started_at + interval '5 minutes'),

  CONSTRAINT chk_response_sla_state_resolution
    CHECK (
      (state = 'OPEN'
        AND resolved_at IS NULL
        AND sale_response_interaction_id IS NULL
        AND ai_response_interaction_id IS NULL)
      OR
      (state = 'SALE_RESPONDED'
        AND resolved_at IS NOT NULL
        AND sale_response_interaction_id IS NOT NULL
        AND ai_response_interaction_id IS NULL)
      OR
      (state = 'AI_RESPONDED'
        AND resolved_at IS NOT NULL
        AND ai_response_interaction_id IS NOT NULL
        AND sale_response_interaction_id IS NULL)
      OR
      (state = 'CANCELLED'
        AND resolved_at IS NOT NULL
        AND sale_response_interaction_id IS NULL
        AND ai_response_interaction_id IS NULL)
    ),

  CONSTRAINT chk_response_sla_ai_claim
    CHECK (
      (ai_claimed_at IS NULL AND ai_claim_id IS NULL AND ai_claim_expires_at IS NULL)
      OR
      (ai_claimed_at IS NOT NULL AND ai_claim_id IS NOT NULL AND ai_claim_expires_at IS NOT NULL AND ai_claim_expires_at > ai_claimed_at)
    )
);

COMMENT ON TABLE public.response_sla_windows
  IS 'Durable 5-minute Response SLA tracking windows for omnichannel conversations.';

-- ------------------------------------------------------------------------------
-- 2. INDEXES & CONCURRENCY CONSTRAINTS
-- ------------------------------------------------------------------------------

-- Critical Invariant: At most one OPEN window per Conversation per Company
CREATE UNIQUE INDEX uq_response_sla_windows_single_open
  ON public.response_sla_windows (
    company_id,
    conversation_id
  )
  WHERE state = 'OPEN';

CREATE INDEX idx_response_sla_windows_convo
  ON public.response_sla_windows (company_id, customer_id, conversation_id);

CREATE INDEX idx_response_sla_windows_deadline_open
  ON public.response_sla_windows (deadline_at)
  WHERE state = 'OPEN';

-- ------------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY (RLS) & TABLE ACL (RPC-ONLY MUTATION)
-- ------------------------------------------------------------------------------
ALTER TABLE public.response_sla_windows ENABLE ROW LEVEL SECURITY;

-- Complete lockdown: Revoke all DML privileges from all non-superuser roles including service_role.
-- Direct INSERT, UPDATE, DELETE are forbidden for service_role; mutations MUST use bounded RPCs.
REVOKE ALL ON TABLE public.response_sla_windows FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.response_sla_windows TO authenticated;
GRANT ALL ON TABLE public.response_sla_windows TO postgres;

-- BOSS_ADMIN can view all SLA windows of their company
CREATE POLICY response_sla_windows_select_boss_admin
  ON public.response_sla_windows
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- SALE can view SLA windows of their company for operational visibility
CREATE POLICY response_sla_windows_select_sale
  ON public.response_sla_windows
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

-- TECHNICIAN has 0 policies -> denied by default.
-- ZERO INSERT/UPDATE/DELETE policies for authenticated, anon, or service_role -> machine mutations via RPC only.

-- ------------------------------------------------------------------------------
-- 4. RPC 1: open_response_sla_window
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_response_sla_window(
  p_company_id uuid,
  p_conversation_id uuid,
  p_trigger_interaction_id uuid
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  conversation_id uuid,
  customer_id uuid,
  trigger_interaction_id uuid,
  started_at timestamptz,
  deadline_at timestamptz,
  state text,
  resolved_at timestamptz,
  sale_response_interaction_id uuid,
  ai_response_interaction_id uuid,
  ai_claimed_at timestamptz,
  ai_claim_id uuid,
  ai_claim_expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_id uuid;
  v_interaction_company_id uuid;
  v_interaction_customer_id uuid;
  v_interaction_convo_id uuid;
  v_interaction_type text;
  v_interaction_direction text;
  v_interaction_actor text;
  v_interaction_created_at timestamptz;
  v_existing_window public.response_sla_windows%ROWTYPE;
  v_new_window public.response_sla_windows%ROWTYPE;
BEGIN
  -- 1. Validate Conversation existence & tenant binding
  SELECT c.customer_id
  INTO v_customer_id
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 2. Validate Trigger Interaction (enforce company, customer, conversation alignment)
  SELECT
    i.company_id,
    i.customer_id,
    i.conversation_id,
    i.type,
    i.direction,
    i.actor_type,
    i.created_at
  INTO
    v_interaction_company_id,
    v_interaction_customer_id,
    v_interaction_convo_id,
    v_interaction_type,
    v_interaction_direction,
    v_interaction_actor,
    v_interaction_created_at
  FROM public.interactions i
  WHERE i.id = p_trigger_interaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRIGGER_INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_interaction_company_id <> p_company_id THEN
    RAISE EXCEPTION 'INTERACTION_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_interaction_customer_id <> v_customer_id THEN
    RAISE EXCEPTION 'INTERACTION_CUSTOMER_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_convo_id IS NULL OR v_interaction_convo_id <> p_conversation_id THEN
    RAISE EXCEPTION 'INTERACTION_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_type <> 'MESSAGE' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_TYPE' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_direction <> 'INBOUND' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_DIRECTION' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_actor <> 'CUSTOMER' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_ACTOR' USING ERRCODE = '22000';
  END IF;

  -- 3. Check if an OPEN window already exists for this conversation
  SELECT *
  INTO v_existing_window
  FROM public.response_sla_windows w
  WHERE w.company_id = p_company_id
    AND w.conversation_id = p_conversation_id
    AND w.state = 'OPEN';

  IF FOUND THEN
    RETURN QUERY
    SELECT
      v_existing_window.id,
      v_existing_window.company_id,
      v_existing_window.conversation_id,
      v_existing_window.customer_id,
      v_existing_window.trigger_interaction_id,
      v_existing_window.started_at,
      v_existing_window.deadline_at,
      v_existing_window.state,
      v_existing_window.resolved_at,
      v_existing_window.sale_response_interaction_id,
      v_existing_window.ai_response_interaction_id,
      v_existing_window.ai_claimed_at,
      v_existing_window.ai_claim_id,
      v_existing_window.ai_claim_expires_at,
      v_existing_window.created_at,
      v_existing_window.updated_at;
    RETURN;
  END IF;

  -- 4. Insert new OPEN window protected by unique partial index against concurrent inserts
  BEGIN
    INSERT INTO public.response_sla_windows (
      company_id,
      conversation_id,
      customer_id,
      trigger_interaction_id,
      started_at,
      deadline_at,
      state
    ) VALUES (
      p_company_id,
      p_conversation_id,
      v_customer_id,
      p_trigger_interaction_id,
      v_interaction_created_at,
      v_interaction_created_at + interval '5 minutes',
      'OPEN'
    )
    RETURNING * INTO v_new_window;

    RETURN QUERY
    SELECT
      v_new_window.id,
      v_new_window.company_id,
      v_new_window.conversation_id,
      v_new_window.customer_id,
      v_new_window.trigger_interaction_id,
      v_new_window.started_at,
      v_new_window.deadline_at,
      v_new_window.state,
      v_new_window.resolved_at,
      v_new_window.sale_response_interaction_id,
      v_new_window.ai_response_interaction_id,
      v_new_window.ai_claimed_at,
      v_new_window.ai_claim_id,
      v_new_window.ai_claim_expires_at,
      v_new_window.created_at,
      v_new_window.updated_at;
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    -- In race condition, concurrent transaction succeeded; load that OPEN window
    SELECT *
    INTO v_existing_window
    FROM public.response_sla_windows w
    WHERE w.company_id = p_company_id
      AND w.conversation_id = p_conversation_id
      AND w.state = 'OPEN';

    IF FOUND THEN
      RETURN QUERY
      SELECT
        v_existing_window.id,
        v_existing_window.company_id,
        v_existing_window.conversation_id,
        v_existing_window.customer_id,
        v_existing_window.trigger_interaction_id,
        v_existing_window.started_at,
        v_existing_window.deadline_at,
        v_existing_window.state,
        v_existing_window.resolved_at,
        v_existing_window.sale_response_interaction_id,
        v_existing_window.ai_response_interaction_id,
        v_existing_window.ai_claimed_at,
        v_existing_window.ai_claim_id,
        v_existing_window.ai_claim_expires_at,
        v_existing_window.created_at,
        v_existing_window.updated_at;
      RETURN;
    ELSE
      RAISE EXCEPTION 'CONCURRENT_INSERT_CONFLICT' USING ERRCODE = '40001';
    END IF;
  END;
END;
$$;

COMMENT ON FUNCTION public.open_response_sla_window(uuid, uuid, uuid)
  IS 'Trusted server RPC to open or retrieve existing OPEN Response SLA window. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.open_response_sla_window(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_response_sla_window(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.open_response_sla_window(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.open_response_sla_window(uuid, uuid, uuid) TO service_role;

-- ------------------------------------------------------------------------------
-- 5. RPC 2: resolve_response_sla_on_sale_reply
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_response_sla_on_sale_reply(
  p_company_id uuid,
  p_conversation_id uuid,
  p_sale_interaction_id uuid
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  conversation_id uuid,
  customer_id uuid,
  trigger_interaction_id uuid,
  started_at timestamptz,
  deadline_at timestamptz,
  state text,
  resolved_at timestamptz,
  sale_response_interaction_id uuid,
  ai_response_interaction_id uuid,
  ai_claimed_at timestamptz,
  ai_claim_id uuid,
  ai_claim_expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer_id uuid;
  v_interaction_company_id uuid;
  v_interaction_customer_id uuid;
  v_interaction_convo_id uuid;
  v_interaction_type text;
  v_interaction_direction text;
  v_interaction_actor text;
  v_interaction_created_at timestamptz;
  v_window public.response_sla_windows%ROWTYPE;
  v_resolved_window public.response_sla_windows%ROWTYPE;
BEGIN
  -- 1. Validate Conversation existence & tenant binding
  SELECT c.customer_id
  INTO v_customer_id
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND c.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 2. Validate Sale Interaction (enforce company, customer, conversation alignment)
  SELECT
    i.company_id,
    i.customer_id,
    i.conversation_id,
    i.type,
    i.direction,
    i.actor_type,
    i.created_at
  INTO
    v_interaction_company_id,
    v_interaction_customer_id,
    v_interaction_convo_id,
    v_interaction_type,
    v_interaction_direction,
    v_interaction_actor,
    v_interaction_created_at
  FROM public.interactions i
  WHERE i.id = p_sale_interaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALE_INTERACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_interaction_company_id <> p_company_id THEN
    RAISE EXCEPTION 'INTERACTION_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_interaction_convo_id IS NULL OR v_interaction_convo_id <> p_conversation_id THEN
    RAISE EXCEPTION 'INTERACTION_CONVERSATION_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_customer_id <> v_customer_id THEN
    RAISE EXCEPTION 'INTERACTION_CUSTOMER_MISMATCH' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_type <> 'MESSAGE' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_TYPE' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_direction <> 'OUTBOUND' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_DIRECTION' USING ERRCODE = '22000';
  END IF;

  IF v_interaction_actor <> 'SALE' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION_ACTOR' USING ERRCODE = '22000';
  END IF;

  -- 3. Lock OPEN SLA window for this conversation
  SELECT *
  INTO v_window
  FROM public.response_sla_windows w
  WHERE w.company_id = p_company_id
    AND w.conversation_id = p_conversation_id
    AND w.state = 'OPEN'
  FOR UPDATE;

  -- 4. If no OPEN window, return empty set (idempotent no-op)
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- 5. Resolve window to SALE_RESPONDED
  UPDATE public.response_sla_windows
  SET state = 'SALE_RESPONDED',
      sale_response_interaction_id = p_sale_interaction_id,
      resolved_at = v_interaction_created_at,
      updated_at = clock_timestamp()
  WHERE public.response_sla_windows.id = v_window.id
  RETURNING * INTO v_resolved_window;

  -- 6. If conversation was in AI_HANDLING, reset to OPEN because Sale has stepped in
  UPDATE public.conversations
  SET status = 'OPEN',
      updated_at = clock_timestamp()
  WHERE public.conversations.id = p_conversation_id
    AND public.conversations.status = 'AI_HANDLING';

  RETURN QUERY
  SELECT
    v_resolved_window.id,
    v_resolved_window.company_id,
    v_resolved_window.conversation_id,
    v_resolved_window.customer_id,
    v_resolved_window.trigger_interaction_id,
    v_resolved_window.started_at,
    v_resolved_window.deadline_at,
    v_resolved_window.state,
    v_resolved_window.resolved_at,
    v_resolved_window.sale_response_interaction_id,
    v_resolved_window.ai_response_interaction_id,
    v_resolved_window.ai_claimed_at,
    v_resolved_window.ai_claim_id,
    v_resolved_window.ai_claim_expires_at,
    v_resolved_window.created_at,
    v_resolved_window.updated_at;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid)
  IS 'Trusted server RPC to resolve OPEN Response SLA window when Sale replies. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_response_sla_on_sale_reply(uuid, uuid, uuid) TO service_role;

-- ------------------------------------------------------------------------------
-- 6. RPC 3: claim_response_sla_for_ai (With Recoverable Lease)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_response_sla_for_ai(
  p_company_id uuid,
  p_window_id uuid
)
RETURNS TABLE (
  claimed boolean,
  decision text,
  window_id uuid,
  claim_id uuid,
  conversation_id uuid,
  customer_id uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  deadline_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window public.response_sla_windows%ROWTYPE;
  v_convo_status text;
  v_sale_reply_id uuid;
  v_sale_reply_created_at timestamptz;
  v_claim_id uuid;
  v_claimed_at timestamptz;
  v_claim_expires_at timestamptz;
  v_lease_duration interval := interval '2 minutes';
  v_now timestamptz := clock_timestamp();
  v_is_reclaim boolean := false;
  v_audit_decision text;
  v_result_decision text;
BEGIN
  -- A. Lock SLA Window
  SELECT *
  INTO v_window
  FROM public.response_sla_windows w
  WHERE w.id = p_window_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WINDOW_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Multi-tenant isolation: if company mismatch, record DENIED audit and return DENIED
  IF v_window.company_id <> p_company_id THEN
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      v_window.company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'WRONG_COMPANY',
        'caller_company_id', p_company_id,
        'window_id', v_window.id
      )
    );

    RETURN QUERY SELECT
      false,
      'WRONG_COMPANY'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- Check 1: Window state must be OPEN
  IF v_window.state <> 'OPEN' THEN
    DECLARE
      v_reason text := CASE
        WHEN v_window.state = 'SALE_RESPONDED' THEN 'SALE_ALREADY_RESPONDED'
        ELSE 'WINDOW_ALREADY_RESOLVED'
      END;
    BEGIN
      INSERT INTO public.audit_logs (
        company_id,
        user_id,
        action,
        resource_type,
        resource_id,
        customer_id,
        result,
        metadata
      ) VALUES (
        p_company_id,
        NULL,
        'RESPONSE_SLA_AI_CLAIM',
        'RESPONSE_SLA_WINDOW',
        v_window.id,
        v_window.customer_id,
        'DENIED',
        jsonb_build_object(
          'decision', 'DENIED',
          'reason', v_reason,
          'window_state', v_window.state,
          'conversation_id', v_window.conversation_id,
          'deadline_at', v_window.deadline_at
        )
      );

      RETURN QUERY SELECT
        false,
        v_reason,
        v_window.id,
        NULL::uuid,
        v_window.conversation_id,
        v_window.customer_id,
        NULL::timestamptz,
        NULL::timestamptz,
        v_window.deadline_at;
      RETURN;
    END;
  END IF;

  -- Check 2: Recoverable Lease Evaluation
  -- Only deny as ALREADY_CLAIMED if the existing claim lease is STILL ACTIVE (unexpired)
  IF v_window.ai_claimed_at IS NOT NULL
     AND v_window.ai_claim_expires_at IS NOT NULL
     AND v_window.ai_claim_expires_at > v_now THEN

    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'ALREADY_CLAIMED',
        'existing_claim_id', v_window.ai_claim_id,
        'claimed_at', v_window.ai_claimed_at,
        'claim_expires_at', v_window.ai_claim_expires_at,
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'ALREADY_CLAIMED'::text,
      v_window.id,
      v_window.ai_claim_id,
      v_window.conversation_id,
      v_window.customer_id,
      v_window.ai_claimed_at,
      v_window.ai_claim_expires_at,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- If an existing claim has expired, this execution is an atomic RECLAIM
  IF v_window.ai_claimed_at IS NOT NULL THEN
    v_is_reclaim := true;
  END IF;

  -- Check 3: Is deadline reached? (deadline_at <= now())
  IF v_window.deadline_at > v_now THEN
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'NOT_DUE',
        'deadline_at', v_window.deadline_at,
        'evaluated_at', v_now,
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'NOT_DUE'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- B. Lock Conversation
  SELECT c.status
  INTO v_convo_status
  FROM public.conversations c
  WHERE c.id = v_window.conversation_id
    AND c.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_convo_status = 'CLOSED' THEN
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'CONVERSATION_CLOSED',
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'CONVERSATION_CLOSED'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- For a fresh claim, conversation cannot be AI_HANDLING.
  -- For a reclaim of an expired lease, the conversation status was already AI_HANDLING from the crashed worker.
  IF NOT v_is_reclaim AND v_convo_status = 'AI_HANDLING' THEN
    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'AI_ALREADY_HANDLING',
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'AI_ALREADY_HANDLING'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- C. Re-check latest Interaction for any SALE response after started_at
  SELECT i.id, i.created_at
  INTO v_sale_reply_id, v_sale_reply_created_at
  FROM public.interactions i
  WHERE i.company_id = p_company_id
    AND i.conversation_id = v_window.conversation_id
    AND i.actor_type = 'SALE'
    AND i.direction = 'OUTBOUND'
    AND i.type = 'MESSAGE'
    AND i.created_at >= v_window.started_at
  ORDER BY i.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Sale replied! Resolve the window to SALE_RESPONDED
    UPDATE public.response_sla_windows
    SET state = 'SALE_RESPONDED',
        sale_response_interaction_id = v_sale_reply_id,
        resolved_at = v_sale_reply_created_at,
        updated_at = v_now
    WHERE public.response_sla_windows.id = v_window.id;

    -- Reset conversation back to OPEN if it was marked AI_HANDLING
    IF v_convo_status = 'AI_HANDLING' THEN
      UPDATE public.conversations
      SET status = 'OPEN',
          updated_at = v_now
      WHERE public.conversations.id = v_window.conversation_id;
    END IF;

    INSERT INTO public.audit_logs (
      company_id,
      user_id,
      action,
      resource_type,
      resource_id,
      customer_id,
      result,
      metadata
    ) VALUES (
      p_company_id,
      NULL,
      'RESPONSE_SLA_AI_CLAIM',
      'RESPONSE_SLA_WINDOW',
      v_window.id,
      v_window.customer_id,
      'DENIED',
      jsonb_build_object(
        'decision', 'DENIED',
        'reason', 'SALE_ALREADY_RESPONDED',
        'sale_response_interaction_id', v_sale_reply_id,
        'conversation_id', v_window.conversation_id
      )
    );

    RETURN QUERY SELECT
      false,
      'SALE_ALREADY_RESPONDED'::text,
      v_window.id,
      NULL::uuid,
      v_window.conversation_id,
      v_window.customer_id,
      NULL::timestamptz,
      NULL::timestamptz,
      v_window.deadline_at;
    RETURN;
  END IF;

  -- D. All checks passed: ATOMIC CLAIM / RECLAIM
  v_claim_id := gen_random_uuid();
  v_claimed_at := v_now;
  v_claim_expires_at := v_now + v_lease_duration;

  UPDATE public.response_sla_windows
  SET ai_claim_id = v_claim_id,
      ai_claimed_at = v_claimed_at,
      ai_claim_expires_at = v_claim_expires_at,
      updated_at = v_claimed_at
  WHERE public.response_sla_windows.id = v_window.id;

  UPDATE public.conversations
  SET status = 'AI_HANDLING',
      updated_at = v_claimed_at
  WHERE public.conversations.id = v_window.conversation_id;

  v_audit_decision := CASE WHEN v_is_reclaim THEN 'RECLAIMED' ELSE 'CLAIMED' END;
  v_result_decision := CASE WHEN v_is_reclaim THEN 'RECLAIMED' ELSE 'ALLOW_AI_REPLY' END;

  -- Audit log: mandatory in same transaction. If insert fails, transaction rolls back!
  INSERT INTO public.audit_logs (
    company_id,
    user_id,
    action,
    resource_type,
    resource_id,
    customer_id,
    result,
    metadata
  ) VALUES (
    p_company_id,
    NULL,
    'RESPONSE_SLA_AI_CLAIM',
    'RESPONSE_SLA_WINDOW',
    v_window.id,
    v_window.customer_id,
    'SUCCESS',
    jsonb_build_object(
      'decision', v_audit_decision,
      'claim_id', v_claim_id,
      'previous_claim_id', v_window.ai_claim_id,
      'conversation_id', v_window.conversation_id,
      'deadline_at', v_window.deadline_at,
      'claimed_at', v_claimed_at,
      'claim_expires_at', v_claim_expires_at
    )
  );

  RETURN QUERY SELECT
    true,
    v_result_decision,
    v_window.id,
    v_claim_id,
    v_window.conversation_id,
    v_window.customer_id,
    v_claimed_at,
    v_claim_expires_at,
    v_window.deadline_at;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid)
  IS 'Trusted server RPC to atomically claim Response SLA window for AI with recoverable lease, re-checks, and audit logging. Restricted to service_role.';

REVOKE ALL ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_response_sla_for_ai(uuid, uuid) TO service_role;
