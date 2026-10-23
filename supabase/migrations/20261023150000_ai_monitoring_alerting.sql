-- Phase 9: AI Pipeline Monitoring & Alerting Foundation.
--
-- Invariants:
-- - Stores AI pipeline monitoring alerts with strict deduplication by (company_id, fingerprint).
-- - Zero raw customer text or un-sanitized PII stored in metadata.
-- - Severity: 'CRITICAL', 'HIGH', 'WARNING', 'INFO'.
-- - Status: 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'.
-- - RLS: Authenticated BOSS_ADMIN and SALE can read alerts; only BOSS_ADMIN can acknowledge/resolve.
-- - Atomic deduplicating RPC record_ai_monitoring_alert.
-- - Atomic RPCs acknowledge_ai_monitoring_alert and resolve_ai_monitoring_alert.

-- 1. Create ai_monitoring_alerts table
CREATE TABLE IF NOT EXISTS public.ai_monitoring_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  alert_type text NOT NULL CHECK (alert_type IN (
    'CRON_CONSECUTIVE_FAILURES',
    'JAVIS_UNAVAILABLE',
    'JAVIS_TIMEOUT_RATE_HIGH',
    'ZCAJS_UNAVAILABLE',
    'MESSENGER_TRANSPORT_UNAVAILABLE',
    'FAILED_DELIVERIES_SPIKE',
    'QUEUE_DEPTH_THRESHOLD_EXCEEDED',
    'OLDEST_PENDING_TOO_OLD',
    'AI_SEND_RATE_ANOMALY',
    'HANDOVER_BACKLOG'
  )),
  severity text NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'WARNING', 'INFO')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED')),
  fingerprint text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  channel text NULL CHECK (channel IN ('ZALO', 'MESSENGER', 'VOICE', 'ALL')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_triggered_at timestamptz NOT NULL DEFAULT now(),
  last_triggered_at timestamptz NOT NULL DEFAULT now(),
  trigger_count integer NOT NULL DEFAULT 1,
  acknowledged_at timestamptz NULL,
  acknowledged_by uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for performance and deduplication
CREATE INDEX IF NOT EXISTS idx_ai_monitoring_alerts_company_status
  ON public.ai_monitoring_alerts(company_id, status);

CREATE INDEX IF NOT EXISTS idx_ai_monitoring_alerts_company_fingerprint
  ON public.ai_monitoring_alerts(company_id, fingerprint);

CREATE INDEX IF NOT EXISTS idx_ai_monitoring_alerts_last_triggered
  ON public.ai_monitoring_alerts(company_id, last_triggered_at DESC);

-- Enable RLS
ALTER TABLE public.ai_monitoring_alerts ENABLE ROW LEVEL SECURITY;

-- Revoke dangerous direct modifications from public/anon
REVOKE ALL ON public.ai_monitoring_alerts FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.ai_monitoring_alerts TO authenticated;
GRANT ALL ON public.ai_monitoring_alerts TO service_role;

-- RLS Policies
DROP POLICY IF EXISTS ai_monitoring_alerts_select_tenant ON public.ai_monitoring_alerts;
CREATE POLICY ai_monitoring_alerts_select_tenant
  ON public.ai_monitoring_alerts
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'BOSS_ADMIN')
    OR public.has_company_role(company_id, 'SALE')
  );

DROP POLICY IF EXISTS ai_monitoring_alerts_update_tenant ON public.ai_monitoring_alerts;
CREATE POLICY ai_monitoring_alerts_update_tenant
  ON public.ai_monitoring_alerts
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

DROP POLICY IF EXISTS ai_monitoring_alerts_insert_tenant ON public.ai_monitoring_alerts;
CREATE POLICY ai_monitoring_alerts_insert_tenant
  ON public.ai_monitoring_alerts
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- 2. Atomic RPC: Record or deduplicate an active alert
CREATE OR REPLACE FUNCTION public.record_ai_monitoring_alert(
  p_company_id uuid,
  p_alert_type text,
  p_severity text,
  p_fingerprint text,
  p_title text,
  p_description text,
  p_channel text DEFAULT 'ALL',
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  alert_id uuid,
  deduplicated boolean,
  trigger_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_id uuid;
  v_existing_count integer;
  v_new_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_alert_type IS NULL OR p_severity IS NULL OR p_fingerprint IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- Find existing ACTIVE alert with the same fingerprint
  SELECT id, public.ai_monitoring_alerts.trigger_count
  INTO v_existing_id, v_existing_count
  FROM public.ai_monitoring_alerts
  WHERE company_id = p_company_id
    AND fingerprint = p_fingerprint
    AND status = 'ACTIVE'
  FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    -- Deduplicate: update timestamp, increment counter, merge metadata
    UPDATE public.ai_monitoring_alerts
    SET trigger_count = v_existing_count + 1,
        last_triggered_at = now(),
        severity = p_severity,
        metadata = p_metadata,
        updated_at = now()
    WHERE id = v_existing_id;

    RETURN QUERY SELECT v_existing_id, true, v_existing_count + 1;
  ELSE
    -- Insert new active alert
    INSERT INTO public.ai_monitoring_alerts (
      company_id,
      alert_type,
      severity,
      status,
      fingerprint,
      title,
      description,
      channel,
      metadata,
      first_triggered_at,
      last_triggered_at,
      trigger_count
    ) VALUES (
      p_company_id,
      p_alert_type,
      p_severity,
      'ACTIVE',
      p_fingerprint,
      p_title,
      p_description,
      p_channel,
      p_metadata,
      now(),
      now(),
      1
    )
    RETURNING id INTO v_new_id;

    RETURN QUERY SELECT v_new_id, false, 1;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_monitoring_alert(uuid, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_ai_monitoring_alert(uuid, text, text, text, text, text, text, jsonb) TO service_role, authenticated;

-- 3. Atomic RPC: Acknowledge an alert
CREATE OR REPLACE FUNCTION public.acknowledge_ai_monitoring_alert(
  p_company_id uuid,
  p_alert_id uuid,
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
  IF p_company_id IS NULL OR p_alert_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  UPDATE public.ai_monitoring_alerts
  SET status = 'ACKNOWLEDGED',
      acknowledged_at = now(),
      acknowledged_by = p_user_id,
      updated_at = now()
  WHERE id = p_alert_id
    AND company_id = p_company_id
    AND status = 'ACTIVE';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_ai_monitoring_alert(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_ai_monitoring_alert(uuid, uuid, uuid) TO service_role, authenticated;

-- 4. Atomic RPC: Resolve an alert
CREATE OR REPLACE FUNCTION public.resolve_ai_monitoring_alert(
  p_company_id uuid,
  p_alert_id uuid,
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
  IF p_company_id IS NULL OR p_alert_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  UPDATE public.ai_monitoring_alerts
  SET status = 'RESOLVED',
      resolved_at = now(),
      updated_at = now()
  WHERE id = p_alert_id
    AND company_id = p_company_id
    AND status IN ('ACTIVE', 'ACKNOWLEDGED');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_ai_monitoring_alert(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_ai_monitoring_alert(uuid, uuid, uuid) TO service_role, authenticated;
