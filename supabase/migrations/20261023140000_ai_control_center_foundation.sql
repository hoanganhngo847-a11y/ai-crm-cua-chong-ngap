-- Phase 8: AI Control Center & CRM UI Foundation.
--
-- Invariants:
-- - Expands ai_brain_live_settings channel check to support 'ZALO', 'MESSENGER', 'VOICE'.
-- - Adds voice_mode ('OFF', 'TEST', 'LIVE') and model_routing_profile ('STANDARD', 'FAST', 'QUALITY').
-- - Authorizes BOSS_ADMIN to manage live settings via RLS and explicit RPCs.
-- - Authorizes BOSS_ADMIN and SALE to view ai_brain_live_deliveries and manage handover cases.
-- - Provides atomic emergency_disable_ai kill-switch RPC.
-- - Provides atomic resolve_ai_handover_case RPC.

-- 1. Expand channel support in ai_brain_live_settings
ALTER TABLE public.ai_brain_live_settings
  DROP CONSTRAINT IF EXISTS ai_brain_live_settings_channel_check;

ALTER TABLE public.ai_brain_live_settings
  ADD CONSTRAINT ai_brain_live_settings_channel_check
  CHECK (channel IN ('ZALO', 'MESSENGER', 'VOICE'));

-- 2. Add columns to ai_brain_live_settings
ALTER TABLE public.ai_brain_live_settings
  ADD COLUMN IF NOT EXISTS voice_mode text NOT NULL DEFAULT 'OFF'
  CHECK (voice_mode IN ('OFF', 'TEST', 'LIVE'));

ALTER TABLE public.ai_brain_live_settings
  ADD COLUMN IF NOT EXISTS model_routing_profile text NOT NULL DEFAULT 'STANDARD'
  CHECK (model_routing_profile IN ('STANDARD', 'FAST', 'QUALITY'));

-- 3. Update permissions and RLS for ai_brain_live_settings
GRANT SELECT, INSERT, UPDATE ON public.ai_brain_live_settings TO authenticated;

DROP POLICY IF EXISTS ai_brain_live_settings_select_tenant ON public.ai_brain_live_settings;
CREATE POLICY ai_brain_live_settings_select_tenant
  ON public.ai_brain_live_settings
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

DROP POLICY IF EXISTS ai_brain_live_settings_update_tenant ON public.ai_brain_live_settings;
CREATE POLICY ai_brain_live_settings_update_tenant
  ON public.ai_brain_live_settings
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

DROP POLICY IF EXISTS ai_brain_live_settings_insert_tenant ON public.ai_brain_live_settings;
CREATE POLICY ai_brain_live_settings_insert_tenant
  ON public.ai_brain_live_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- 4. Expand channel support and grant read access to ai_brain_live_deliveries
ALTER TABLE public.ai_brain_live_deliveries
  DROP CONSTRAINT IF EXISTS ai_brain_live_deliveries_channel_check;

ALTER TABLE public.ai_brain_live_deliveries
  ADD CONSTRAINT ai_brain_live_deliveries_channel_check
  CHECK (channel IN ('ZALO', 'MESSENGER', 'VOICE'));

GRANT SELECT ON public.ai_brain_live_deliveries TO authenticated;

DROP POLICY IF EXISTS ai_brain_live_deliveries_select_tenant ON public.ai_brain_live_deliveries;
CREATE POLICY ai_brain_live_deliveries_select_tenant
  ON public.ai_brain_live_deliveries
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'BOSS_ADMIN')
    OR public.has_company_role(company_id, 'SALE')
  );

-- 5. Atomic RPC to resolve handover case
CREATE OR REPLACE FUNCTION public.resolve_ai_handover_case(
  p_company_id uuid,
  p_case_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_company_id IS NULL OR p_case_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  UPDATE public.ai_handover_cases
  SET status = 'RESOLVED',
      resolved_at = now(),
      updated_at = now()
  WHERE id = p_case_id
    AND company_id = p_company_id
    AND status IN ('OPEN', 'CLAIMED');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_ai_handover_case(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_ai_handover_case(uuid, uuid, uuid) TO service_role, authenticated;

-- 6. Emergency kill switch RPC: instantly disables all live channels for the company
CREATE OR REPLACE FUNCTION public.emergency_disable_ai(
  p_company_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  UPDATE public.ai_brain_live_settings
  SET enabled = false,
      updated_at = now()
  WHERE company_id = p_company_id
    AND enabled = true;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.emergency_disable_ai(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emergency_disable_ai(uuid) TO service_role, authenticated;
