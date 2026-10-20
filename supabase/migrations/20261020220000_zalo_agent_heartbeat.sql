-- Additive migration: Zalo Personal Agent heartbeat and operational readiness
-- Reuses public.zalo_recording_devices table with additive columns and security-definer RPCs.

ALTER TABLE public.zalo_recording_devices
  ADD COLUMN IF NOT EXISTS agent_version text,
  ADD COLUMN IF NOT EXISTS agent_status text DEFAULT 'OFFLINE' CHECK (agent_status IN ('ONLINE', 'DEGRADED', 'OFFLINE')),
  ADD COLUMN IF NOT EXISTS zalo_running boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS permissions_ok boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS permissions_detail jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS loopback_ready boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz;

CREATE INDEX IF NOT EXISTS zalo_recording_devices_last_seen_idx
  ON public.zalo_recording_devices(company_id, active, last_seen_at DESC);

-- RPC for agent to record periodic heartbeat
CREATE OR REPLACE FUNCTION public.zalo_device_heartbeat(
  p_device uuid,
  p_key_hash text,
  p_agent_version text,
  p_agent_status text,
  p_zalo_running boolean,
  p_permissions_ok boolean,
  p_permissions_detail jsonb,
  p_loopback_ready boolean,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  d public.zalo_recording_devices;
  v_status text;
BEGIN
  -- Authenticate device with HMAC hash
  SELECT * INTO d FROM public.zalo_recording_devices
  WHERE id = p_device AND active AND device_key_hash = p_key_hash FOR UPDATE;

  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id = d.company_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'ZALO_DEVICE_UNAUTHORIZED' USING ERRCODE='42501';
  END IF;

  -- Validate/derive status:
  -- Degraded if missing permissions or loopback is not ready
  IF NOT p_permissions_ok OR NOT p_loopback_ready THEN
    v_status := 'DEGRADED';
  ELSE
    v_status := CASE WHEN p_agent_status IN ('ONLINE', 'DEGRADED') THEN p_agent_status ELSE 'ONLINE' END;
  END IF;

  UPDATE public.zalo_recording_devices
  SET
    last_seen_at = now(),
    agent_version = nullif(btrim(p_agent_version), ''),
    agent_status = v_status,
    zalo_running = coalesce(p_zalo_running, false),
    permissions_ok = coalesce(p_permissions_ok, false),
    permissions_detail = coalesce(p_permissions_detail, '{}'::jsonb),
    loopback_ready = coalesce(p_loopback_ready, false),
    last_error_code = nullif(btrim(p_error_code), ''),
    last_error_at = CASE WHEN nullif(btrim(p_error_code), '') IS NOT NULL THEN now() ELSE last_error_at END
  WHERE id = d.id;

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_status,
    'device_id', d.id,
    'company_id', d.company_id,
    'last_seen_at', now()
  );
END $$;

-- RPC for CRM to query real-time device readiness
CREATE OR REPLACE FUNCTION public.zalo_get_devices_readiness(
  p_company uuid,
  p_actor uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_role text;
  v_devices jsonb;
BEGIN
  v_role := public.zalo_assert_actor(p_company, p_actor);

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', d.id,
      'device_name', d.device_name,
      'staff_user_id', d.staff_user_id,
      'is_current_staff', (d.staff_user_id = p_actor),
      'active', d.active,
      'agent_version', d.agent_version,
      'raw_status', d.agent_status,
      'computed_status', CASE
        WHEN NOT d.active THEN 'OFFLINE'
        WHEN d.last_seen_at IS NULL OR d.last_seen_at < (now() - interval '2 minutes') THEN 'OFFLINE'
        WHEN NOT d.permissions_ok OR NOT d.loopback_ready OR d.agent_status = 'DEGRADED' THEN 'DEGRADED'
        ELSE 'ONLINE'
      END,
      'zalo_running', d.zalo_running,
      'permissions_ok', d.permissions_ok,
      'permissions_detail', d.permissions_detail,
      'loopback_ready', d.loopback_ready,
      'last_error_code', d.last_error_code,
      'last_error_at', d.last_error_at,
      'last_seen_at', d.last_seen_at,
      'created_at', d.created_at
    ) ORDER BY
      (d.staff_user_id IS NOT NULL AND d.staff_user_id = p_actor) DESC,
      (d.last_seen_at >= now() - interval '2 minutes' AND d.agent_status = 'ONLINE') DESC,
      d.last_seen_at DESC NULLS LAST,
      d.created_at DESC
  ), '[]'::jsonb) INTO v_devices
  FROM public.zalo_recording_devices d
  WHERE d.company_id = p_company AND d.active;

  RETURN jsonb_build_object(
    'ok', true,
    'devices', v_devices
  );
END $$;

REVOKE ALL ON FUNCTION public.zalo_device_heartbeat FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_device_heartbeat TO service_role;

REVOKE ALL ON FUNCTION public.zalo_get_devices_readiness FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_get_devices_readiness TO service_role;
