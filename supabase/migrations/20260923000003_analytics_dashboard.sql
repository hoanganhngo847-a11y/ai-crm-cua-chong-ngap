-- Migration 009: Secure Analytics Data Layer (Milestone M9.5A)
-- Implements aggregate-only company-wide analytics RPCs for BOSS_ADMIN.
-- Enforces:
-- 1. Strict tenant isolation (company_id) and BOSS_ADMIN role authorization.
-- 2. Complete rejection of service_role, anon, public, SALE, and TECHNICIAN callers.
-- 3. Half-open interval semantics [p_from, p_to) bounded within 366 days.
-- 4. Separation between period metrics and current snapshot metrics (finance_summaries, currentStageDistribution).
-- 5. Durable Response SLA metrics from response_sla_windows.
-- 6. Event-based Care analytics directly from care_deliveries.
-- 7. Zero exposure of raw contacts, private phone numbers, transcripts, or row-level records.

-- ------------------------------------------------------------------------------
-- 1. PERFORMANCE INDEXES FOR ANALYTICS AGGREGATION
-- ------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_customers_company_created_at
  ON public.customers (company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_csh_company_changed_at
  ON public.customer_stage_histories (company_id, changed_at);

CREATE INDEX IF NOT EXISTS idx_response_sla_company_started_at
  ON public.response_sla_windows (company_id, started_at);

CREATE INDEX IF NOT EXISTS idx_calls_company_started_at
  ON public.calls (company_id, started_at);

CREATE INDEX IF NOT EXISTS idx_surveys_company_completed_at
  ON public.surveys (company_id, completed_at);

CREATE INDEX IF NOT EXISTS idx_orders_company_created_at
  ON public.orders (company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_appointments_company_survey_created
  ON public.appointments (company_id, created_at)
  WHERE (type = 'SURVEY');

CREATE INDEX IF NOT EXISTS idx_care_deliveries_company_sent_at
  ON public.care_deliveries (company_id, sent_at)
  WHERE (sent_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_care_deliveries_company_converted_at
  ON public.care_deliveries (company_id, converted_to_sale_at)
  WHERE (converted_to_sale_at IS NOT NULL);

-- ------------------------------------------------------------------------------
-- 2. PRIVILEGED HUMAN OVERVIEW RPC: public.get_company_analytics_overview
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_company_analytics_overview(
  p_company_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor_user_id uuid;
  v_actor_user_status text;
  v_actor_role text;
  v_actor_member_status text;

  -- Customer aggregates
  v_new_customers_count integer;
  v_customers_by_source jsonb;
  v_current_stage_dist jsonb;
  v_stage_transitions jsonb;

  -- SLA aggregates
  v_sla_windows_started integer;
  v_sla_sale_responded integer;
  v_sla_sale_responded_within_5m integer;
  v_sla_sale_responded_after_5m integer;
  v_sla_ai_responded integer;
  v_sla_cancelled integer;
  v_sla_still_open integer;
  v_sla_avg_sale_sec numeric;
  v_sla_avg_ai_sec numeric;
  v_sla_compliance_bp integer;

  -- Calls aggregates
  v_calls_total integer;
  v_calls_inbound integer;
  v_calls_outbound integer;
  v_calls_connected integer;
  v_calls_completed integer;
  v_calls_no_answer integer;
  v_calls_failed integer;

  -- Surveys aggregates
  v_surveys_completed integer;
  v_appt_survey_created integer;
  v_appt_survey_completed integer;
  v_appt_survey_cancelled integer;

  -- Orders aggregates
  v_orders_created integer;
  v_order_value_created text;
  v_orders_by_status jsonb;

  -- Finance snapshot
  v_fin_contract_val text;
  v_fin_collected text;
  v_fin_receivable text;
  v_fin_completed_rev text;

  -- Care aggregates
  v_care_sent integer;
  v_care_delivered integer;
  v_care_responded integer;
  v_care_converted integer;
BEGIN
  -- 1. Validate date-range inputs
  IF p_company_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'INVALID_ANALYTICS_RANGE' USING ERRCODE = '22000';
  END IF;

  IF p_from >= p_to THEN
    RAISE EXCEPTION 'INVALID_ANALYTICS_RANGE' USING ERRCODE = '22000';
  END IF;

  IF (p_to - p_from) > interval '366 days' THEN
    RAISE EXCEPTION 'INVALID_ANALYTICS_RANGE' USING ERRCODE = '22000';
  END IF;

  -- 2. Validate human actor via auth.uid()
  v_actor_user_id := auth.uid();
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT up.status
  INTO v_actor_user_status
  FROM public.user_profiles up
  WHERE up.id = v_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_actor_user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTOR_INACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT cm.role, cm.status
  INTO v_actor_role, v_actor_member_status
  FROM public.company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_MEMBERSHIP_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_actor_role <> 'BOSS_ADMIN' THEN
    RAISE EXCEPTION 'ACTOR_ROLE_NOT_BOSS_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF v_actor_member_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTOR_MEMBERSHIP_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 3. Customers in period: created_at in [p_from, p_to)
  SELECT COUNT(*)::integer
  INTO v_new_customers_count
  FROM public.customers
  WHERE company_id = p_company_id
    AND created_at >= p_from
    AND created_at < p_to;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('source', s.source, 'count', s.source_count)
      ORDER BY s.source_count DESC, s.source ASC
    ),
    '[]'::jsonb
  )
  INTO v_customers_by_source
  FROM (
    SELECT source, COUNT(*)::integer AS source_count
    FROM public.customers
    WHERE company_id = p_company_id
      AND created_at >= p_from
      AND created_at < p_to
    GROUP BY source
  ) s;

  -- 4. Current Stage Distribution: snapshot of current customer stages
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('stage', st.stage, 'count', st.stage_count)
      ORDER BY st.stage_count DESC, st.stage ASC
    ),
    '[]'::jsonb
  )
  INTO v_current_stage_dist
  FROM (
    SELECT stage, COUNT(*)::integer AS stage_count
    FROM public.customers
    WHERE company_id = p_company_id
    GROUP BY stage
  ) st;

  -- 5. Stage Transition Events: histories in [p_from, p_to)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('toStage', tr.to_stage, 'count', tr.trans_count)
      ORDER BY tr.trans_count DESC, tr.to_stage ASC
    ),
    '[]'::jsonb
  )
  INTO v_stage_transitions
  FROM (
    SELECT to_stage, COUNT(*)::integer AS trans_count
    FROM public.customer_stage_histories
    WHERE company_id = p_company_id
      AND changed_at >= p_from
      AND changed_at < p_to
    GROUP BY to_stage
  ) tr;

  -- 6. Response SLA Analytics: started_at in [p_from, p_to)
  SELECT
    COUNT(*)::integer AS windows_started,
    COUNT(*) FILTER (WHERE state = 'SALE_RESPONDED')::integer AS sale_responded,
    COUNT(*) FILTER (WHERE state = 'SALE_RESPONDED' AND resolved_at <= deadline_at)::integer AS sale_responded_within_5m,
    COUNT(*) FILTER (WHERE state = 'SALE_RESPONDED' AND resolved_at > deadline_at)::integer AS sale_responded_after_5m,
    COUNT(*) FILTER (WHERE state = 'AI_RESPONDED')::integer AS ai_responded,
    COUNT(*) FILTER (WHERE state = 'CANCELLED')::integer AS cancelled,
    COUNT(*) FILTER (WHERE state = 'OPEN')::integer AS still_open,
    ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - started_at))) FILTER (WHERE state = 'SALE_RESPONDED' AND resolved_at IS NOT NULL)::numeric, 1) AS avg_sale_sec,
    ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - started_at))) FILTER (WHERE state = 'AI_RESPONDED' AND resolved_at IS NOT NULL)::numeric, 1) AS avg_ai_sec
  INTO
    v_sla_windows_started,
    v_sla_sale_responded,
    v_sla_sale_responded_within_5m,
    v_sla_sale_responded_after_5m,
    v_sla_ai_responded,
    v_sla_cancelled,
    v_sla_still_open,
    v_sla_avg_sale_sec,
    v_sla_avg_ai_sec
  FROM public.response_sla_windows
  WHERE company_id = p_company_id
    AND started_at >= p_from
    AND started_at < p_to;

  IF v_sla_sale_responded > 0 THEN
    v_sla_compliance_bp := ROUND((v_sla_sale_responded_within_5m::numeric / v_sla_sale_responded) * 10000)::integer;
  ELSE
    v_sla_compliance_bp := NULL;
  END IF;

  -- 7. Calls Analytics: started_at in [p_from, p_to)
  SELECT
    COUNT(*)::integer AS total_calls,
    COUNT(*) FILTER (WHERE direction = 'INBOUND')::integer AS inbound_calls,
    COUNT(*) FILTER (WHERE direction = 'OUTBOUND')::integer AS outbound_calls,
    COUNT(*) FILTER (WHERE status = 'CONNECTED')::integer AS connected_calls,
    COUNT(*) FILTER (WHERE status = 'COMPLETED')::integer AS completed_calls,
    COUNT(*) FILTER (WHERE status = 'NO_ANSWER')::integer AS no_answer_calls,
    COUNT(*) FILTER (WHERE status = 'FAILED')::integer AS failed_calls
  INTO
    v_calls_total,
    v_calls_inbound,
    v_calls_outbound,
    v_calls_connected,
    v_calls_completed,
    v_calls_no_answer,
    v_calls_failed
  FROM public.calls
  WHERE company_id = p_company_id
    AND started_at >= p_from
    AND started_at < p_to;

  -- 8. Surveys Analytics: surveys completed in [p_from, p_to)
  SELECT COUNT(*)::integer
  INTO v_surveys_completed
  FROM public.surveys
  WHERE company_id = p_company_id
    AND completed_at >= p_from
    AND completed_at < p_to;

  SELECT
    COUNT(*) FILTER (WHERE created_at >= p_from AND created_at < p_to)::integer,
    COUNT(*) FILTER (WHERE status = 'COMPLETED' AND updated_at >= p_from AND updated_at < p_to)::integer,
    COUNT(*) FILTER (WHERE status = 'CANCELLED' AND updated_at >= p_from AND updated_at < p_to)::integer
  INTO
    v_appt_survey_created,
    v_appt_survey_completed,
    v_appt_survey_cancelled
  FROM public.appointments
  WHERE company_id = p_company_id
    AND type = 'SURVEY';

  -- 9. Orders Analytics: created_at in [p_from, p_to)
  SELECT
    COUNT(*)::integer,
    COALESCE(SUM(final_amount), 0)::numeric(15,2)::text
  INTO
    v_orders_created,
    v_order_value_created
  FROM public.orders
  WHERE company_id = p_company_id
    AND created_at >= p_from
    AND created_at < p_to;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('status', ord.order_status, 'count', ord.st_count)
      ORDER BY ord.st_count DESC, ord.order_status ASC
    ),
    '[]'::jsonb
  )
  INTO v_orders_by_status
  FROM (
    SELECT order_status, COUNT(*)::integer AS st_count
    FROM public.orders
    WHERE company_id = p_company_id
      AND created_at >= p_from
      AND created_at < p_to
    GROUP BY order_status
  ) ord;

  -- 10. Finance Snapshot: current company-wide snapshot ("as of now", not period-filtered)
  SELECT
    COALESCE(SUM(contract_value), 0)::numeric(15,2)::text,
    COALESCE(SUM(collected_amount), 0)::numeric(15,2)::text,
    COALESCE(SUM(receivable_amount), 0)::numeric(15,2)::text,
    COALESCE(SUM(completed_revenue), 0)::numeric(15,2)::text
  INTO
    v_fin_contract_val,
    v_fin_collected,
    v_fin_receivable,
    v_fin_completed_rev
  FROM public.finance_summaries
  WHERE company_id = p_company_id;

  -- 11. Care Analytics: deliveries event timestamps in [p_from, p_to)
  SELECT
    COUNT(*) FILTER (WHERE sent_at >= p_from AND sent_at < p_to)::integer,
    COUNT(*) FILTER (WHERE delivered_at >= p_from AND delivered_at < p_to)::integer,
    COUNT(*) FILTER (WHERE responded_at >= p_from AND responded_at < p_to)::integer,
    COUNT(*) FILTER (WHERE converted_to_sale_at >= p_from AND converted_to_sale_at < p_to)::integer
  INTO
    v_care_sent,
    v_care_delivered,
    v_care_responded,
    v_care_converted
  FROM public.care_deliveries
  WHERE company_id = p_company_id;

  -- 12. Structured aggregate response
  RETURN jsonb_build_object(
    'period', jsonb_build_object(
      'from', p_from,
      'to', p_to
    ),
    'customers', jsonb_build_object(
      'newCustomers', v_new_customers_count,
      'bySource', v_customers_by_source
    ),
    'currentStageDistribution', v_current_stage_dist,
    'stageTransitions', v_stage_transitions,
    'responseSla', jsonb_build_object(
      'windowsStarted', v_sla_windows_started,
      'saleResponded', v_sla_sale_responded,
      'saleRespondedWithin5m', v_sla_sale_responded_within_5m,
      'saleRespondedAfter5m', v_sla_sale_responded_after_5m,
      'aiResponded', v_sla_ai_responded,
      'cancelled', v_sla_cancelled,
      'stillOpen', v_sla_still_open,
      'avgSaleResponseSeconds', v_sla_avg_sale_sec,
      'avgAiResponseSeconds', v_sla_avg_ai_sec,
      'saleWithin5mCount', v_sla_sale_responded_within_5m,
      'resolvedBySaleCount', v_sla_sale_responded,
      'complianceRateBasisPoints', v_sla_compliance_bp
    ),
    'calls', jsonb_build_object(
      'totalCalls', v_calls_total,
      'inboundCalls', v_calls_inbound,
      'outboundCalls', v_calls_outbound,
      'connectedCalls', v_calls_connected,
      'completedCalls', v_calls_completed,
      'noAnswerCalls', v_calls_no_answer,
      'failedCalls', v_calls_failed
    ),
    'surveys', jsonb_build_object(
      'completedSurveys', v_surveys_completed,
      'surveyAppointmentsCreated', v_appt_survey_created,
      'surveyAppointmentsCompleted', v_appt_survey_completed,
      'surveyAppointmentsCancelled', v_appt_survey_cancelled
    ),
    'orders', jsonb_build_object(
      'created', v_orders_created,
      'orderValueCreated', v_order_value_created,
      'byStatus', v_orders_by_status
    ),
    'financeSnapshot', jsonb_build_object(
      'contractValue', v_fin_contract_val,
      'collectedAmount', v_fin_collected,
      'receivableAmount', v_fin_receivable,
      'completedRevenue', v_fin_completed_rev,
      'snapshotAt', statement_timestamp()
    ),
    'care', jsonb_build_object(
      'careSent', v_care_sent,
      'careDelivered', v_care_delivered,
      'careResponded', v_care_responded,
      'careConvertedToSale', v_care_converted
    )
  );
END;
$$;

COMMENT ON FUNCTION public.get_company_analytics_overview(uuid, timestamptz, timestamptz)
  IS 'Privileged human RPC returning bounded aggregate company analytics overview for authenticated BOSS_ADMIN.';

REVOKE ALL ON FUNCTION public.get_company_analytics_overview(uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_company_analytics_overview(uuid, timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.get_company_analytics_overview(uuid, timestamptz, timestamptz) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_company_analytics_overview(uuid, timestamptz, timestamptz) TO authenticated;

-- ------------------------------------------------------------------------------
-- 3. PRIVILEGED HUMAN DAILY TIME-SERIES RPC: public.get_company_analytics_daily_series
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_company_analytics_daily_series(
  p_company_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_actor_user_id uuid;
  v_actor_user_status text;
  v_actor_role text;
  v_actor_member_status text;
  v_daily_series jsonb;
BEGIN
  -- 1. Validate date-range inputs
  IF p_company_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'INVALID_ANALYTICS_RANGE' USING ERRCODE = '22000';
  END IF;

  IF p_from >= p_to THEN
    RAISE EXCEPTION 'INVALID_ANALYTICS_RANGE' USING ERRCODE = '22000';
  END IF;

  IF (p_to - p_from) > interval '366 days' THEN
    RAISE EXCEPTION 'INVALID_ANALYTICS_RANGE' USING ERRCODE = '22000';
  END IF;

  -- 2. Validate human actor via auth.uid()
  v_actor_user_id := auth.uid();
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT up.status
  INTO v_actor_user_status
  FROM public.user_profiles up
  WHERE up.id = v_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_actor_user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTOR_INACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT cm.role, cm.status
  INTO v_actor_role, v_actor_member_status
  FROM public.company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_MEMBERSHIP_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_actor_role <> 'BOSS_ADMIN' THEN
    RAISE EXCEPTION 'ACTOR_ROLE_NOT_BOSS_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF v_actor_member_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTOR_MEMBERSHIP_INACTIVE' USING ERRCODE = '42501';
  END IF;

  -- 3. Daily time series with UTC day buckets
  WITH days AS (
    SELECT day::date AS day_date
    FROM generate_series(
      date_trunc('day', p_from AT TIME ZONE 'UTC'),
      date_trunc('day', (p_to - interval '1 microsecond') AT TIME ZONE 'UTC'),
      interval '1 day'
    ) AS day
  ),
  c_agg AS (
    SELECT
      (created_at AT TIME ZONE 'UTC')::date AS day_date,
      COUNT(*)::integer AS new_customers
    FROM public.customers
    WHERE company_id = p_company_id
      AND created_at >= p_from
      AND created_at < p_to
    GROUP BY 1
  ),
  o_agg AS (
    SELECT
      (created_at AT TIME ZONE 'UTC')::date AS day_date,
      COUNT(*)::integer AS orders_created,
      COALESCE(SUM(final_amount), 0)::numeric(15,2) AS order_value_created
    FROM public.orders
    WHERE company_id = p_company_id
      AND created_at >= p_from
      AND created_at < p_to
    GROUP BY 1
  ),
  sla_agg AS (
    SELECT
      (started_at AT TIME ZONE 'UTC')::date AS day_date,
      COUNT(*)::integer AS sla_windows_started,
      COUNT(*) FILTER (WHERE state = 'SALE_RESPONDED' AND resolved_at <= deadline_at)::integer AS sale_within_5m,
      COUNT(*) FILTER (WHERE state = 'AI_RESPONDED')::integer AS ai_responded
    FROM public.response_sla_windows
    WHERE company_id = p_company_id
      AND started_at >= p_from
      AND started_at < p_to
    GROUP BY 1
  ),
  care_agg AS (
    SELECT
      (converted_to_sale_at AT TIME ZONE 'UTC')::date AS day_date,
      COUNT(*)::integer AS care_converted_to_sale
    FROM public.care_deliveries
    WHERE company_id = p_company_id
      AND converted_to_sale_at >= p_from
      AND converted_to_sale_at < p_to
    GROUP BY 1
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'date', to_char(d.day_date, 'YYYY-MM-DD'),
          'newCustomers', COALESCE(c.new_customers, 0),
          'ordersCreated', COALESCE(o.orders_created, 0),
          'orderValueCreated', COALESCE(o.order_value_created, 0)::numeric(15,2)::text,
          'slaWindowsStarted', COALESCE(s.sla_windows_started, 0),
          'saleWithin5m', COALESCE(s.sale_within_5m, 0),
          'aiResponded', COALESCE(s.ai_responded, 0),
          'careConvertedToSale', COALESCE(cr.care_converted_to_sale, 0)
        )
        ORDER BY d.day_date ASC
      ),
      '[]'::jsonb
    )
  INTO v_daily_series
  FROM days d
  LEFT JOIN c_agg c ON c.day_date = d.day_date
  LEFT JOIN o_agg o ON o.day_date = d.day_date
  LEFT JOIN sla_agg s ON s.day_date = d.day_date
  LEFT JOIN care_agg cr ON cr.day_date = d.day_date;

  RETURN v_daily_series;
END;
$$;

COMMENT ON FUNCTION public.get_company_analytics_daily_series(uuid, timestamptz, timestamptz)
  IS 'Privileged human RPC returning bounded UTC daily time-series analytics for authenticated BOSS_ADMIN.';

REVOKE ALL ON FUNCTION public.get_company_analytics_daily_series(uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_company_analytics_daily_series(uuid, timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.get_company_analytics_daily_series(uuid, timestamptz, timestamptz) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_company_analytics_daily_series(uuid, timestamptz, timestamptz) TO authenticated;
