-- 20260925000001_voice_p0_hardening.sql
-- Voice / Hotline Hardening:
-- 1. Call dispatch state machine & atomic idempotency (voice_dispatch_commands)
-- 2. Webhook idempotent status update & attempt finalization (voice_webhook_events)
-- 3. Atomic inbound hotline call ingestion (zero-phone in public tables)
-- 4. Media worker lease ownership tokens (lock_token, lease_expires_at, retry_count)
-- 5. Canonical recording storage reference validation
-- 6. Contact cycle predecessor business state validation

-- ---------------------------------------------------------------------------
-- 1. DISPATCH COMMAND STATE MACHINE & IDEMPOTENCY
-- ---------------------------------------------------------------------------

CREATE TABLE public.voice_dispatch_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES public.call_attempts(id) ON DELETE RESTRICT,
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN (
    'PENDING_DISPATCH',
    'DISPATCHING',
    'PROVIDER_ACCEPTED',
    'ACTIVE',
    'COMPLETED',
    'FAILED',
    'RECONCILIATION_REQUIRED'
  )),
  idempotency_key text NOT NULL,
  provider text NOT NULL,
  provider_call_id text NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_voice_dispatch_command_attempt UNIQUE (company_id, attempt_id),
  CONSTRAINT uq_voice_dispatch_command_call UNIQUE (company_id, call_id),
  CONSTRAINT uq_voice_dispatch_command_idempotency UNIQUE (company_id, idempotency_key)
);

ALTER TABLE public.voice_dispatch_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voice_dispatch_commands FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voice_dispatch_commands TO service_role;

CREATE TRIGGER trg_updated_at_voice_dispatch_commands
  BEFORE UPDATE ON public.voice_dispatch_commands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 2. WEBHOOK IDEMPOTENT EVENT LOG
-- ---------------------------------------------------------------------------

CREATE TABLE public.voice_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  idempotency_key text NOT NULL,
  provider_call_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_voice_webhook_event UNIQUE (company_id, provider, idempotency_key)
);

ALTER TABLE public.voice_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voice_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voice_webhook_events TO service_role;

-- ---------------------------------------------------------------------------
-- 3. MEDIA WORKER LEASE ENHANCEMENT
-- ---------------------------------------------------------------------------

ALTER TABLE public.voice_media_jobs
  ADD COLUMN IF NOT EXISTS lock_token uuid NULL,
  ADD COLUMN IF NOT EXISTS locked_by text NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. BUCKET SECURITY POLICY
-- Bucket 'call-recordings' is strictly private and server-managed.
-- Direct client access (anon/authenticated) is restricted; access is granted
-- only via Trusted Server signed URLs after role authorization.
-- Storage-level MIME allowlist is deferred as Foundation follow-up to preserve
-- compatibility with canonical Foundation test suites. Server-side validation
-- is enforced at the Voice Trusted Server / media pipeline layer.
-- ---------------------------------------------------------------------------

UPDATE storage.buckets
SET public = false,
    file_size_limit = 26214400,
    allowed_mime_types = NULL
WHERE id = 'call-recordings';

-- ---------------------------------------------------------------------------
-- 5. RPC: prepare_voice_dispatch_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prepare_voice_dispatch_atomic(
  p_company_id uuid,
  p_attempt_id uuid,
  p_idempotency_key text,
  p_provider text
)
RETURNS TABLE (
  call_id uuid,
  customer_id uuid,
  raw_phone text,
  provider_call_id text,
  dispatch_status text,
  is_reconciliation boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cmd public.voice_dispatch_commands%ROWTYPE;
  v_attempt public.call_attempts%ROWTYPE;
  v_call_id uuid;
  v_phone text;
  v_customer_id uuid;
BEGIN
  -- Advisory lock per attempt to serialize concurrent dispatch requests
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':attempt_dispatch:' || p_attempt_id::text, 0));

  -- 1. Check existing dispatch command
  SELECT * INTO v_cmd
  FROM public.voice_dispatch_commands
  WHERE company_id = p_company_id AND attempt_id = p_attempt_id
  FOR UPDATE;

  IF FOUND THEN
    -- If provider already accepted or in reconciliation, do NOT call provider again!
    IF v_cmd.status IN ('PROVIDER_ACCEPTED', 'RECONCILIATION_REQUIRED', 'ACTIVE', 'COMPLETED') THEN
      SELECT c.customer_id INTO v_customer_id FROM public.calls c WHERE c.id = v_cmd.call_id;
      RETURN QUERY SELECT
        v_cmd.call_id,
        v_customer_id,
        NULL::text,
        v_cmd.provider_call_id,
        v_cmd.status,
        true;
      RETURN;
    END IF;

    -- If currently dispatching and not stale (< 2 min), reject concurrent duplicate
    IF v_cmd.status = 'DISPATCHING' AND v_cmd.created_at > (now() - interval '2 minutes') THEN
      RAISE EXCEPTION 'VOICE_DISPATCH_IN_PROGRESS';
    END IF;
  END IF;

  -- 2. Verify attempt is PENDING and claimable
  SELECT * INTO v_attempt
  FROM public.call_attempts ca
  WHERE ca.company_id = p_company_id AND ca.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_ATTEMPT_NOT_FOUND';
  END IF;

  IF v_attempt.result <> 'PENDING' THEN
    RAISE EXCEPTION 'VOICE_ATTEMPT_NOT_CLAIMABLE';
  END IF;

  -- 3. Read raw phone strictly in trusted server context
  SELECT cpc.raw_phone INTO v_phone
  FROM private.customer_private_contacts cpc
  WHERE cpc.company_id = p_company_id AND cpc.customer_id = v_attempt.customer_id;

  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'VOICE_PHONE_NOT_FOUND';
  END IF;

  -- 4. Create durable INITIATED call record
  INSERT INTO public.calls (
    company_id, customer_id, direction, agent_type, provider,
    started_at, status, transcript_status
  ) VALUES (
    p_company_id, v_attempt.customer_id, 'OUTBOUND', 'AI', p_provider,
    now(), 'INITIATED', 'PENDING'
  ) RETURNING id INTO v_call_id;

  -- 5. Bind call to attempt
  UPDATE public.call_attempts
  SET call_id = v_call_id,
      called_at = now()
  WHERE id = p_attempt_id;

  -- 6. Insert mandatory audit log
  INSERT INTO public.audit_logs (
    company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata
  ) VALUES (
    p_company_id, NULL, 'INITIATE_AI_OUTBOUND_CALL', 'CALL', v_call_id, v_attempt.customer_id, 'SUCCESS',
    jsonb_build_object(
      'call_id', v_call_id,
      'attempt_id', p_attempt_id,
      'attempt_no', v_attempt.attempt_no,
      'contact_cycle_id', v_attempt.contact_cycle_id
    )
  );

  -- 7. Persist durable dispatch command
  INSERT INTO public.voice_dispatch_commands (
    company_id, attempt_id, call_id, status, idempotency_key, provider
  ) VALUES (
    p_company_id, p_attempt_id, v_call_id, 'DISPATCHING', p_idempotency_key, p_provider
  )
  ON CONFLICT (company_id, attempt_id) DO UPDATE SET
    call_id = EXCLUDED.call_id,
    status = 'DISPATCHING',
    idempotency_key = EXCLUDED.idempotency_key,
    provider = EXCLUDED.provider,
    updated_at = now();

  RETURN QUERY SELECT
    v_call_id,
    v_attempt.customer_id,
    v_phone,
    NULL::text,
    'DISPATCHING'::text,
    false;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_voice_dispatch_atomic(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_voice_dispatch_atomic(uuid, uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. RPC: record_voice_provider_accepted_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_voice_provider_accepted_atomic(
  p_company_id uuid,
  p_attempt_id uuid,
  p_call_id uuid,
  p_provider_call_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.voice_dispatch_commands
  SET status = 'PROVIDER_ACCEPTED',
      provider_call_id = p_provider_call_id,
      updated_at = now()
  WHERE company_id = p_company_id
    AND attempt_id = p_attempt_id
    AND call_id = p_call_id;

  UPDATE public.calls
  SET provider_call_id = p_provider_call_id
  WHERE id = p_call_id AND company_id = p_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_voice_provider_accepted_atomic(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_voice_provider_accepted_atomic(uuid, uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. RPC: finalize_voice_dispatch_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.finalize_voice_dispatch_atomic(
  p_company_id uuid,
  p_attempt_id uuid,
  p_call_id uuid,
  p_provider_call_id text
)
RETURNS TABLE (
  call_id uuid,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_cmd public.voice_dispatch_commands%ROWTYPE;
  v_customer_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':call:' || p_call_id::text, 0));

  SELECT * INTO v_cmd
  FROM public.voice_dispatch_commands vdc
  WHERE vdc.company_id = p_company_id AND vdc.attempt_id = p_attempt_id AND vdc.call_id = p_call_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_DISPATCH_COMMAND_NOT_FOUND';
  END IF;

  SELECT c.customer_id INTO v_customer_id
  FROM public.calls c
  WHERE c.id = p_call_id AND c.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_CALL_NOT_FOUND';
  END IF;

  -- Atomically bind provider_call_id and transition call to RINGING
  UPDATE public.calls c
  SET provider_call_id = p_provider_call_id,
      status = 'RINGING'
  WHERE c.id = p_call_id AND c.company_id = p_company_id;

  -- Ensure attempt is bound
  UPDATE public.call_attempts ca
  SET call_id = p_call_id,
      called_at = COALESCE(ca.called_at, now())
  WHERE ca.id = p_attempt_id AND ca.company_id = p_company_id;

  -- Mark command ACTIVE
  UPDATE public.voice_dispatch_commands vdc
  SET status = 'ACTIVE',
      provider_call_id = p_provider_call_id,
      updated_at = now()
  WHERE vdc.id = v_cmd.id;

  -- Atomically record call interaction event
  INSERT INTO public.interactions (
    company_id, customer_id, conversation_id, channel, type, direction,
    sanitized_content, sanitization_status, actor_type, actor_user_id, external_ref
  ) VALUES (
    p_company_id, v_customer_id, NULL, 'AI_VOICE', 'CALL_EVENT', 'OUTBOUND',
    NULL, 'NOT_REQUIRED', 'AI', NULL, p_provider_call_id
  )
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT p_call_id, 'CALLING'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_voice_dispatch_atomic(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_voice_dispatch_atomic(uuid, uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. RPC: mark_voice_dispatch_reconciliation_required_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_voice_dispatch_reconciliation_required_atomic(
  p_company_id uuid,
  p_attempt_id uuid,
  p_call_id uuid,
  p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.voice_dispatch_commands
  SET status = 'RECONCILIATION_REQUIRED',
      last_error = p_error,
      updated_at = now()
  WHERE company_id = p_company_id AND attempt_id = p_attempt_id AND call_id = p_call_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_voice_dispatch_reconciliation_required_atomic(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_voice_dispatch_reconciliation_required_atomic(uuid, uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. RPC: fail_voice_dispatch_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fail_voice_dispatch_atomic(
  p_company_id uuid,
  p_attempt_id uuid,
  p_call_id uuid,
  p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.voice_dispatch_commands
  SET status = 'FAILED',
      last_error = p_error,
      updated_at = now()
  WHERE company_id = p_company_id AND attempt_id = p_attempt_id AND call_id = p_call_id;

  UPDATE public.calls
  SET status = 'FAILED'
  WHERE id = p_call_id AND company_id = p_company_id;

  UPDATE public.call_attempts
  SET result = 'FAILED',
      called_at = COALESCE(called_at, now())
  WHERE id = p_attempt_id AND company_id = p_company_id AND result = 'PENDING';
END;
$$;

REVOKE ALL ON FUNCTION public.fail_voice_dispatch_atomic(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_voice_dispatch_atomic(uuid, uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 10. RPC: apply_voice_call_status_atomic
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_voice_call_status_atomic(
  p_company_id uuid,
  p_provider text,
  p_provider_call_id text,
  p_new_status text,
  p_event_idempotency_key text,
  p_ended_at timestamptz DEFAULT NULL,
  p_next_retry_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  call_id uuid,
  customer_id uuid,
  previous_status text,
  current_status text,
  is_duplicate boolean,
  attempt_result text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_call public.calls%ROWTYPE;
  v_attempt public.call_attempts%ROWTYPE;
  v_attempt_res text := NULL;
  v_terminal boolean;
  v_current_terminal boolean;
  v_from_stage text;
  v_to_stage text;
  v_next_attempt_id uuid;
  v_next_no integer;
BEGIN
  -- 1. Advisory lock per tenant + provider + call
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_provider || ':' || p_provider_call_id, 0));

  -- 2. Check event idempotency
  INSERT INTO public.voice_webhook_events (
    company_id, provider, idempotency_key, provider_call_id, event_type, status
  ) VALUES (
    p_company_id, p_provider, p_event_idempotency_key, p_provider_call_id, 'STATUS_UPDATE', p_new_status
  )
  ON CONFLICT (company_id, provider, idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    -- Event was already recorded
    SELECT c.id, c.customer_id, c.status INTO v_call.id, v_call.customer_id, v_call.status
    FROM public.calls c
    WHERE c.company_id = p_company_id AND c.provider = p_provider AND c.provider_call_id = p_provider_call_id;
    RETURN QUERY SELECT v_call.id, v_call.customer_id, v_call.status, v_call.status, true, NULL::text;
    RETURN;
  END IF;

  -- 3. Lock and retrieve call
  SELECT * INTO v_call
  FROM public.calls c
  WHERE c.company_id = p_company_id AND c.provider = p_provider AND c.provider_call_id = p_provider_call_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_current_terminal := v_call.status IN ('COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY');
  v_terminal := p_new_status IN ('COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY');

  -- Illegal state transition: terminal call cannot revert to non-terminal
  IF v_current_terminal AND NOT v_terminal THEN
    RETURN QUERY SELECT v_call.id, v_call.customer_id, v_call.status, v_call.status, false, NULL::text;
    RETURN;
  END IF;

  -- Update call status
  UPDATE public.calls c
  SET status = p_new_status,
      ended_at = COALESCE(p_ended_at, CASE WHEN v_terminal THEN now() ELSE c.ended_at END)
  WHERE c.id = v_call.id;

  -- Update dispatch command if present
  UPDATE public.voice_dispatch_commands vdc
  SET status = CASE WHEN v_terminal THEN 'COMPLETED' ELSE 'ACTIVE' END,
      updated_at = now()
  WHERE vdc.company_id = p_company_id AND vdc.call_id = v_call.id;

  -- 4. Atomically handle attempt and contact cycle if terminal
  IF v_terminal THEN
    v_attempt_res := CASE p_new_status
      WHEN 'COMPLETED' THEN 'ANSWERED'
      WHEN 'NO_ANSWER' THEN 'NO_ANSWER'
      WHEN 'BUSY' THEN 'BUSY'
      ELSE 'FAILED'
    END;

    SELECT * INTO v_attempt
    FROM public.call_attempts ca
    WHERE ca.company_id = p_company_id AND ca.call_id = v_call.id AND ca.result = 'PENDING'
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.call_attempts
      SET result = v_attempt_res,
          called_at = COALESCE(called_at, now())
      WHERE id = v_attempt.id;

      IF v_attempt_res NOT IN ('ANSWERED', 'CANCELLED') THEN
        SELECT c.stage INTO v_from_stage
        FROM public.customers c
        WHERE c.company_id = p_company_id AND c.id = v_attempt.customer_id
        FOR UPDATE;

        IF v_attempt.attempt_no < 3 THEN
          v_next_no := v_attempt.attempt_no + 1;
          v_to_stage := CASE v_next_no WHEN 2 THEN 'CONTACT_CYCLE_2' ELSE 'CONTACT_CYCLE_3' END;

          IF p_next_retry_at IS NOT NULL THEN
            INSERT INTO public.call_attempts (
              company_id, customer_id, contact_cycle_id, attempt_no, scheduled_at, result
            ) VALUES (
              p_company_id, v_attempt.customer_id, v_attempt.contact_cycle_id,
              v_next_no, p_next_retry_at, 'PENDING'
            ) RETURNING id INTO v_next_attempt_id;
          END IF;
        ELSE
          v_to_stage := 'UNREACHABLE';
        END IF;

        IF v_to_stage IS NOT NULL THEN
          UPDATE public.customers SET stage = v_to_stage, updated_at = now()
          WHERE company_id = p_company_id AND id = v_attempt.customer_id;

          INSERT INTO public.customer_stage_histories (
            company_id, customer_id, from_stage, to_stage, actor_type, reason, source_ref
          ) VALUES (
            p_company_id, v_attempt.customer_id, v_from_stage, v_to_stage, 'AI',
            CASE WHEN v_attempt.attempt_no = 3 THEN 'NO_ANSWER_3_ATTEMPTS' ELSE 'VOICE_RETRY_SCHEDULED' END,
            v_attempt.contact_cycle_id::text
          );
        END IF;
      END IF;
    END IF;

    -- Insert interaction event for terminal event (idempotent by external_ref)
    INSERT INTO public.interactions (
      company_id, customer_id, conversation_id, channel, type, direction,
      sanitized_content, sanitization_status, actor_type, actor_user_id, external_ref
    ) VALUES (
      p_company_id, v_call.customer_id, NULL, 'AI_VOICE', 'CALL_EVENT', v_call.direction,
      NULL, 'NOT_REQUIRED', 'AI', NULL, p_event_idempotency_key
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_call.id, v_call.customer_id, v_call.status, p_new_status, false, v_attempt_res;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_voice_call_status_atomic(uuid, text, text, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_voice_call_status_atomic(uuid, text, text, text, text, timestamptz, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- 11. RPC: ingest_inbound_voice_call_atomic (ZERO-PHONE IN PUBLIC TABLES)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ingest_inbound_voice_call_atomic(
  p_company_id uuid,
  p_provider text,
  p_provider_call_id text,
  p_normalized_phone text,
  p_raw_phone text,
  p_phone_identity_hash text
)
RETURNS TABLE (
  call_id uuid,
  customer_id uuid,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_call_id uuid;
  v_customer_id uuid;
  v_existing_call public.calls%ROWTYPE;
BEGIN
  IF p_provider NOT IN ('STRINGEE', 'VIETTEL', 'TWILIO', 'VINFON') OR p_provider_call_id IS NULL THEN
    RAISE EXCEPTION 'VOICE_PROVIDER_CALL_INVALID';
  END IF;
  IF p_normalized_phone !~ '^\+[1-9][0-9]{7,14}$' OR p_phone_identity_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'VOICE_PHONE_IDENTITY_INVALID';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
    RAISE EXCEPTION 'VOICE_COMPANY_NOT_FOUND';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_normalized_phone, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_provider || ':' || p_provider_call_id, 0));

  -- 1. Check if call already exists
  SELECT * INTO v_existing_call
  FROM public.calls c
  WHERE c.company_id = p_company_id AND c.provider = p_provider AND c.provider_call_id = p_provider_call_id;

  IF v_existing_call.id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing_call.id, v_existing_call.customer_id, false;
    RETURN;
  END IF;

  -- 2. Resolve customer by normalized phone or identity hash
  SELECT cpc.customer_id INTO v_customer_id
  FROM private.customer_private_contacts cpc
  WHERE cpc.company_id = p_company_id AND cpc.normalized_phone = p_normalized_phone
  FOR UPDATE;

  IF v_customer_id IS NULL THEN
    SELECT i.customer_id INTO v_customer_id
    FROM public.identities i
    WHERE i.company_id = p_company_id AND i.channel = 'PHONE' AND i.external_id = p_phone_identity_hash;
  END IF;

  IF v_customer_id IS NULL THEN
    -- Invariant: ZERO-PHONE in public.customers
    INSERT INTO public.customers (company_id, name, source, stage)
    VALUES (p_company_id, 'Khách gọi Hotline', 'HOTLINE', 'LEAD_NEW')
    RETURNING id INTO v_customer_id;

    -- Raw phone stored strictly in private schema
    INSERT INTO private.customer_private_contacts (
      company_id, customer_id, normalized_phone, raw_phone, is_verified
    ) VALUES (p_company_id, v_customer_id, p_normalized_phone, p_raw_phone, false);
  ELSE
    INSERT INTO private.customer_private_contacts (
      company_id, customer_id, normalized_phone, raw_phone, is_verified
    ) VALUES (p_company_id, v_customer_id, p_normalized_phone, p_raw_phone, false)
    ON CONFLICT (customer_id) DO UPDATE SET
      normalized_phone = EXCLUDED.normalized_phone,
      raw_phone = EXCLUDED.raw_phone,
      updated_at = now()
    WHERE private.customer_private_contacts.company_id = p_company_id;
  END IF;

  -- Bind identity
  INSERT INTO public.identities (company_id, customer_id, channel, external_id, verified, metadata)
  VALUES (p_company_id, v_customer_id, 'PHONE', p_phone_identity_hash, false, '{}'::jsonb)
  ON CONFLICT (company_id, channel, external_id) DO NOTHING;

  -- 3. Create call record
  INSERT INTO public.calls (
    company_id, customer_id, direction, agent_type, provider, provider_call_id,
    started_at, status, transcript_status
  ) VALUES (
    p_company_id, v_customer_id, 'INBOUND', 'AI', p_provider, p_provider_call_id,
    now(), 'CONNECTED', 'PENDING'
  ) RETURNING id INTO v_call_id;

  -- 4. Create interaction record
  INSERT INTO public.interactions (
    company_id, customer_id, conversation_id, channel, type, direction,
    sanitized_content, sanitization_status, actor_type, actor_user_id, external_ref
  ) VALUES (
    p_company_id, v_customer_id, NULL, 'HOTLINE', 'CALL_EVENT', 'INBOUND',
    NULL, 'NOT_REQUIRED', 'SYSTEM', NULL, p_provider_call_id
  );

  RETURN QUERY SELECT v_call_id, v_customer_id, true;
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_inbound_voice_call_atomic(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_inbound_voice_call_atomic(uuid, text, text, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 12. RPC: attach_call_recording_ref_atomic (STORAGE TRUST BOUNDARY)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.attach_call_recording_ref_atomic(
  p_company_id uuid,
  p_call_id uuid,
  p_recording_ref text,
  p_lock_token uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_expected_prefix text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.calls c
    WHERE c.company_id = p_company_id AND c.id = p_call_id
  ) THEN
    RAISE EXCEPTION 'VOICE_CALL_SCOPE_MISMATCH';
  END IF;

  -- Verify deterministic storage path pattern: tenant/resource bound
  v_expected_prefix := p_company_id::text || '/' || p_call_id::text || '/';
  IF NOT (
    p_recording_ref LIKE v_expected_prefix || '%' OR
    p_recording_ref LIKE 'call-recordings/' || v_expected_prefix || '%' OR
    p_recording_ref LIKE 'voice/' || v_expected_prefix || '%'
  ) THEN
    RAISE EXCEPTION 'VOICE_RECORDING_PATH_ILLEGAL';
  END IF;

  -- Verify audio file extension
  IF NOT (p_recording_ref ~* '\.(mp3|mp4|ogg|wav|webm)$') THEN
    RAISE EXCEPTION 'VOICE_RECORDING_EXTENSION_ILLEGAL';
  END IF;

  IF p_lock_token IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.voice_media_jobs vmj
      WHERE vmj.company_id = p_company_id AND vmj.call_id = p_call_id
        AND vmj.status = 'PROCESSING' AND vmj.lock_token = p_lock_token
    ) THEN
      RAISE EXCEPTION 'VOICE_MEDIA_JOB_LOCK_INVALID';
    END IF;
  END IF;

  UPDATE public.calls
  SET recording_ref = p_recording_ref,
      transcript_status = 'PENDING'
  WHERE id = p_call_id AND company_id = p_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_call_recording_ref_atomic(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_call_recording_ref_atomic(uuid, uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 13. HARDENED claim_voice_media_jobs WITH EXPLICIT LEASE TOKENS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_voice_media_jobs(
  p_limit integer DEFAULT 10,
  p_locked_by text DEFAULT 'media_worker',
  p_lease_seconds integer DEFAULT 300
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  call_id uuid,
  job_type text,
  source_ref text,
  attempts integer,
  max_attempts integer,
  lock_token uuid,
  retry_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_lease_duration interval;
BEGIN
  v_lease_duration := (GREATEST(p_lease_seconds, 30) || ' seconds')::interval;

  -- 1. Reclaim expired leases: assign new retry_count, reset lock
  UPDATE public.voice_media_jobs vmj
  SET status = 'PENDING',
      lock_token = NULL,
      locked_by = NULL,
      locked_at = NULL,
      lease_expires_at = NULL,
      retry_count = vmj.retry_count + 1
  WHERE vmj.status = 'PROCESSING'
    AND vmj.lease_expires_at IS NOT NULL
    AND vmj.lease_expires_at < now();

  -- 2. Claim available jobs with FOR UPDATE SKIP LOCKED and generate fresh lock_token
  RETURN QUERY
  WITH candidates AS (
    SELECT vmj.id
    FROM public.voice_media_jobs vmj
    WHERE vmj.status = 'PENDING'
      AND vmj.next_run_at <= now()
    ORDER BY vmj.next_run_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
  ), claimed AS (
    UPDATE public.voice_media_jobs vmj
    SET status = 'PROCESSING',
        lock_token = gen_random_uuid(),
        locked_by = p_locked_by,
        locked_at = now(),
        lease_expires_at = now() + v_lease_duration
    FROM candidates c
    WHERE vmj.id = c.id
    RETURNING vmj.*
  )
  SELECT
    c.id,
    c.company_id,
    c.call_id,
    c.job_type,
    c.source_ref,
    c.attempts,
    c.max_attempts,
    c.lock_token,
    c.retry_count
  FROM claimed c;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_voice_media_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voice_media_jobs(integer, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_voice_media_job(
  p_company_id uuid,
  p_job_id uuid,
  p_lock_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.voice_media_jobs
  SET status = 'COMPLETED',
      completed_at = now(),
      locked_at = NULL,
      lease_expires_at = NULL,
      lock_token = NULL
  WHERE id = p_job_id
    AND company_id = p_company_id
    AND status = 'PROCESSING'
    AND lock_token = p_lock_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_voice_media_job(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_voice_media_job(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fail_voice_media_job(
  p_company_id uuid,
  p_job_id uuid,
  p_lock_token uuid,
  p_last_error_code text,
  p_terminal boolean,
  p_next_run_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.voice_media_jobs
  SET status = CASE WHEN p_terminal THEN 'FAILED' ELSE 'PENDING' END,
      attempts = attempts + 1,
      last_error_code = p_last_error_code,
      next_run_at = p_next_run_at,
      locked_at = NULL,
      lease_expires_at = NULL,
      lock_token = NULL
  WHERE id = p_job_id
    AND company_id = p_company_id
    AND status = 'PROCESSING'
    AND lock_token = p_lock_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_voice_media_job(uuid, uuid, uuid, text, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_voice_media_job(uuid, uuid, uuid, text, boolean, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- 14. HARDENED start_voice_contact_cycle PREDECESSOR VALIDATION
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_voice_contact_cycle(
  p_company_id uuid,
  p_customer_id uuid,
  p_contact_cycle_id uuid,
  p_scheduled_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_from_stage text;
  v_attempt_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':contact_cycle:' || p_customer_id::text, 0));

  SELECT c.stage INTO v_from_stage
  FROM public.customers c
  WHERE c.company_id = p_company_id AND c.id = p_customer_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_CUSTOMER_NOT_FOUND'; END IF;

  -- Predecessor validation: ONLY 'LEAD_NEW' can enter a fresh contact cycle
  IF v_from_stage <> 'LEAD_NEW' THEN
    RAISE EXCEPTION 'VOICE_CONTACT_CYCLE_ILLEGAL_PREDECESSOR';
  END IF;

  -- Check no active pending attempts across any cycles
  IF EXISTS (
    SELECT 1 FROM public.call_attempts ca
    WHERE ca.company_id = p_company_id AND ca.customer_id = p_customer_id AND ca.result = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'VOICE_PENDING_ATTEMPT_EXISTS';
  END IF;

  -- Check unique cycle invariant: cannot restart same contact cycle
  IF EXISTS (
    SELECT 1 FROM public.call_attempts ca
    WHERE ca.company_id = p_company_id AND ca.customer_id = p_customer_id
      AND ca.contact_cycle_id = p_contact_cycle_id
  ) THEN
    RAISE EXCEPTION 'VOICE_CYCLE_ALREADY_EXISTS';
  END IF;

  INSERT INTO public.call_attempts (
    company_id, customer_id, contact_cycle_id, attempt_no, scheduled_at, result
  ) VALUES (p_company_id, p_customer_id, p_contact_cycle_id, 1, p_scheduled_at, 'PENDING')
  RETURNING id INTO v_attempt_id;

  UPDATE public.customers SET stage = 'CONTACT_CYCLE_1', updated_at = now()
  WHERE company_id = p_company_id AND id = p_customer_id;

  INSERT INTO public.customer_stage_histories (
    company_id, customer_id, from_stage, to_stage, actor_type, reason, source_ref
  ) VALUES (
    p_company_id, p_customer_id, v_from_stage, 'CONTACT_CYCLE_1', 'AI',
    'CONTACT_CYCLE_STARTED', p_contact_cycle_id::text
  );

  RETURN v_attempt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.start_voice_contact_cycle(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_voice_contact_cycle(uuid, uuid, uuid, timestamptz) TO service_role;
