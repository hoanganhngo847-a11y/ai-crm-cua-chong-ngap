-- Additive hardening for inbound live voice session idempotency.
-- The previously applied inbound migrations remain immutable; this replacement
-- fences expired and terminal sessions instead of reusing them for a second
-- provider session.

CREATE OR REPLACE FUNCTION public.zalo_begin_inbound_live_voice_session(
  p_device uuid,
  p_key_hash text,
  p_local_call_id uuid,
  p_remote_display_name text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  s public.zalo_personal_live_voice_sessions;
  v_name text := nullif(btrim(p_remote_display_name), '');
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
  IF d.staff_user_id IS NOT NULL THEN
    PERFORM public.zalo_assert_actor(d.company_id, d.staff_user_id);
  END IF;

  SELECT * INTO s
  FROM public.zalo_personal_live_voice_sessions
  WHERE company_id = d.company_id AND local_call_id = p_local_call_id
  FOR UPDATE;
  IF FOUND THEN
    IF s.device_id IS DISTINCT FROM d.id OR s.direction IS DISTINCT FROM 'INBOUND' THEN
      RAISE EXCEPTION 'ZALO_LIVE_SESSION_CONFLICT';
    END IF;
    IF s.expires_at < now() AND s.status IN ('REQUESTED', 'ACTIVE') THEN
      UPDATE public.zalo_personal_live_voice_sessions
      SET status = 'EXPIRED', ended_at = now(), failure_code = 'SESSION_EXPIRED'
      WHERE id = s.id;
      RAISE EXCEPTION 'ZALO_LIVE_SESSION_EXPIRED';
    END IF;
    IF s.status IN ('ENDED', 'FAILED', 'EXPIRED') THEN
      RAISE EXCEPTION 'ZALO_LIVE_SESSION_TERMINAL';
    END IF;
    RETURN jsonb_build_object(
      'session_id', s.id, 'company_id', s.company_id, 'customer_id', s.customer_id,
      'request_id', s.outbound_request_id, 'local_call_id', s.local_call_id,
      'direction', s.direction, 'remote_display_name', s.remote_display_name,
      'status', s.status, 'expires_at', s.expires_at
    );
  END IF;

  INSERT INTO public.zalo_personal_live_voice_sessions(
    company_id, customer_id, outbound_request_id, device_id, local_call_id,
    direction, remote_display_name
  ) VALUES (d.company_id, NULL, NULL, d.id, p_local_call_id, 'INBOUND', v_name)
  RETURNING * INTO s;

  RETURN jsonb_build_object(
    'session_id', s.id, 'company_id', s.company_id, 'customer_id', s.customer_id,
    'request_id', s.outbound_request_id, 'local_call_id', s.local_call_id,
    'direction', s.direction, 'remote_display_name', s.remote_display_name,
    'status', s.status, 'expires_at', s.expires_at
  );
END $$;

REVOKE ALL ON FUNCTION public.zalo_begin_inbound_live_voice_session(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_begin_inbound_live_voice_session(uuid,text,uuid,text) TO service_role;
