-- Additive, OFF-by-default Zalo Personal live voice bridge.
-- The local agent can request a short-lived provider session only after an
-- outbound request has been claimed and the exact Zalo contact was detected.

CREATE TABLE public.zalo_personal_live_voice_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  customer_id uuid NOT NULL,
  outbound_request_id uuid NOT NULL,
  device_id uuid NOT NULL,
  local_call_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'OPENAI_REALTIME' CHECK (provider = 'OPENAI_REALTIME'),
  provider_session_id text,
  status text NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED', 'ACTIVE', 'ENDED', 'FAILED', 'EXPIRED')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  started_at timestamptz,
  ended_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, local_call_id),
  FOREIGN KEY(company_id, customer_id) REFERENCES public.customers(company_id, id),
  FOREIGN KEY(company_id, outbound_request_id) REFERENCES public.zalo_outbound_call_requests(company_id, id),
  FOREIGN KEY(company_id, device_id) REFERENCES public.zalo_recording_devices(company_id, id),
  CHECK (ended_at IS NULL OR ended_at >= created_at)
);

CREATE INDEX zalo_live_voice_sessions_scope_idx
  ON public.zalo_personal_live_voice_sessions(company_id, customer_id, created_at DESC);
CREATE INDEX zalo_live_voice_sessions_expiry_idx
  ON public.zalo_personal_live_voice_sessions(expires_at)
  WHERE status IN ('REQUESTED', 'ACTIVE');

ALTER TABLE public.zalo_personal_live_voice_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zalo_personal_live_voice_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zalo_personal_live_voice_sessions TO service_role;

-- Atomic authorization and idempotent session creation. The provider secret is
-- intentionally minted by the API route only after this RPC succeeds.
CREATE OR REPLACE FUNCTION public.zalo_begin_live_voice_session(
  p_device uuid,
  p_key_hash text,
  p_request_id uuid,
  p_local_call_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  req public.zalo_outbound_call_requests;
  s public.zalo_personal_live_voice_sessions;
  v_role text;
BEGIN
  SELECT * INTO d
  FROM public.zalo_recording_devices
  WHERE id = p_device AND active AND device_key_hash = p_key_hash
  FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  SELECT * INTO req
  FROM public.zalo_outbound_call_requests
  WHERE id = p_request_id AND company_id = d.company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_REQUEST_NOT_FOUND'; END IF;
  IF req.claimed_by_device_id IS DISTINCT FROM d.id THEN
    RAISE EXCEPTION 'ZALO_REQUEST_DEVICE_MISMATCH';
  END IF;
  IF req.status NOT IN ('CALL_TRIGGERED', 'CALL_DETECTED') THEN
    RAISE EXCEPTION 'ZALO_LIVE_CALL_NOT_CONFIRMED';
  END IF;
  v_role := public.zalo_assert_actor(d.company_id, req.staff_user_id);
  IF d.staff_user_id IS NOT NULL AND d.staff_user_id <> req.staff_user_id
     AND (v_role <> 'BOSS_ADMIN' OR req.device_id IS DISTINCT FROM d.id) THEN
    RAISE EXCEPTION 'ZALO_REQUEST_STAFF_MISMATCH';
  END IF;

  SELECT * INTO s
  FROM public.zalo_personal_live_voice_sessions
  WHERE company_id = d.company_id AND local_call_id = p_local_call_id
  FOR UPDATE;
  IF FOUND THEN
    IF s.device_id IS DISTINCT FROM d.id OR s.outbound_request_id IS DISTINCT FROM req.id THEN
      RAISE EXCEPTION 'ZALO_LIVE_SESSION_CONFLICT';
    END IF;
    IF s.expires_at < now() AND s.status IN ('REQUESTED', 'ACTIVE') THEN
      UPDATE public.zalo_personal_live_voice_sessions
      SET status = 'EXPIRED', ended_at = now(), failure_code = 'SESSION_EXPIRED'
      WHERE id = s.id;
      RAISE EXCEPTION 'ZALO_LIVE_SESSION_EXPIRED';
    END IF;
    RETURN jsonb_build_object(
      'session_id', s.id, 'company_id', s.company_id, 'customer_id', s.customer_id,
      'request_id', s.outbound_request_id, 'local_call_id', s.local_call_id,
      'status', s.status, 'expires_at', s.expires_at
    );
  END IF;

  INSERT INTO public.zalo_personal_live_voice_sessions(
    company_id, customer_id, outbound_request_id, device_id, local_call_id
  ) VALUES (d.company_id, req.customer_id, req.id, d.id, p_local_call_id)
  RETURNING * INTO s;

  RETURN jsonb_build_object(
    'session_id', s.id, 'company_id', s.company_id, 'customer_id', s.customer_id,
    'request_id', s.outbound_request_id, 'local_call_id', s.local_call_id,
    'status', s.status, 'expires_at', s.expires_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.zalo_finish_live_voice_session(
  p_device uuid,
  p_key_hash text,
  p_session_id uuid,
  p_status text,
  p_provider_session_id text DEFAULT NULL,
  p_failure_code text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  s public.zalo_personal_live_voice_sessions;
BEGIN
  SELECT * INTO d FROM public.zalo_recording_devices
  WHERE id = p_device AND active AND device_key_hash = p_key_hash FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501'; END IF;
  IF p_status NOT IN ('ACTIVE', 'ENDED', 'FAILED', 'EXPIRED') THEN
    RAISE EXCEPTION 'ZALO_LIVE_STATUS_INVALID';
  END IF;
  SELECT * INTO s FROM public.zalo_personal_live_voice_sessions
  WHERE id = p_session_id AND company_id = d.company_id AND device_id = d.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ZALO_LIVE_SESSION_NOT_FOUND'; END IF;
  IF s.status IN ('ENDED', 'FAILED', 'EXPIRED') AND s.status <> p_status THEN
    RAISE EXCEPTION 'ZALO_LIVE_STATUS_TERMINAL';
  END IF;
  UPDATE public.zalo_personal_live_voice_sessions
  SET status = p_status,
      provider_session_id = coalesce(p_provider_session_id, provider_session_id),
      failure_code = p_failure_code,
      started_at = CASE WHEN p_status = 'ACTIVE' THEN coalesce(started_at, now()) ELSE started_at END,
      ended_at = CASE WHEN p_status IN ('ENDED', 'FAILED', 'EXPIRED') THEN coalesce(ended_at, now()) ELSE ended_at END
  WHERE id = s.id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.zalo_begin_live_voice_session(uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zalo_finish_live_voice_session(uuid,text,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_begin_live_voice_session(uuid,text,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.zalo_finish_live_voice_session(uuid,text,uuid,text,text,text) TO service_role;

COMMENT ON TABLE public.zalo_personal_live_voice_sessions IS
  'Short-lived, CRM-scoped live voice sessions for the disabled Zalo Personal audio bridge.';
