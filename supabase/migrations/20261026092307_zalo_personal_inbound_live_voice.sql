-- Extend the disabled live voice session domain to support inbound calls from
-- any Zalo personal caller. Unknown callers are allowed to use company-only
-- grounding; customer-specific grounding is added only when the CRM resolves it.

ALTER TABLE public.zalo_personal_live_voice_sessions
  ALTER COLUMN customer_id DROP NOT NULL,
  ALTER COLUMN outbound_request_id DROP NOT NULL,
  ALTER COLUMN provider SET DEFAULT 'GEMINI_LIVE';

ALTER TABLE public.zalo_personal_live_voice_sessions
  DROP CONSTRAINT IF EXISTS zalo_personal_live_voice_sessions_provider_check,
  ADD CONSTRAINT zalo_personal_live_voice_sessions_provider_check
    CHECK (provider IN ('OPENAI_REALTIME', 'GEMINI_LIVE'));

ALTER TABLE public.zalo_personal_live_voice_sessions
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'OUTBOUND'
    CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  ADD COLUMN IF NOT EXISTS remote_display_name text
    CHECK (remote_display_name IS NULL OR length(btrim(remote_display_name)) BETWEEN 1 AND 200);

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

COMMENT ON FUNCTION public.zalo_begin_inbound_live_voice_session(uuid,text,uuid,text) IS
  'Creates a short-lived inbound Zalo live voice session for any caller; unknown callers receive company-only grounding.';
