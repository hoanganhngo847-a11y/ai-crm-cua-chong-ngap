-- Reduce the Zalo live AI reply SLA from five minutes to one minute.
-- Keep the five-minute processing lease/stale-worker timeout unchanged.
-- No historical delivery replay and no outbound sends are performed by this migration.

CREATE OR REPLACE FUNCTION public.ai_brain_live_retry_and_sla_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_source_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.channel = 'ZALO' THEN
    SELECT i.created_at INTO v_source_at FROM public.interactions i
    WHERE i.id = NEW.source_interaction_id AND i.company_id = NEW.company_id
      AND i.customer_id = NEW.customer_id AND i.conversation_id = NEW.conversation_id;
    IF v_source_at IS NULL THEN RAISE EXCEPTION 'LIVE_SOURCE_INVALID'; END IF;
    NEW.available_at := GREATEST(NEW.available_at, v_source_at + interval '1 minute');
  END IF;
  IF NEW.send_status = 'FAILED' AND (NEW.attempts >= 5 OR NEW.error_code IN (
    'BRAIN_CONFIG_MISSING', 'BRAIN_UNAVAILABLE', 'BRAIN_AUTH_FAILED', 'RUNTIME_AUTH_FAILED',
    'MODEL_CONFIG_INVALID', 'BRAIN_REQUEST_INVALID', 'RUNTIME_REQUEST_INVALID'
  )) THEN NEW.retryable := false; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS ai_brain_live_retry_and_sla_guard ON public.ai_brain_live_deliveries;
CREATE TRIGGER ai_brain_live_retry_and_sla_guard BEFORE INSERT OR UPDATE OF send_status, error_code
ON public.ai_brain_live_deliveries FOR EACH ROW EXECUTE FUNCTION public.ai_brain_live_retry_and_sla_guard();
REVOKE ALL ON FUNCTION public.ai_brain_live_retry_and_sla_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_brain_live_retry_and_sla_guard() TO service_role;

CREATE OR REPLACE FUNCTION public.ai_brain_live_zalo_is_eligible(p_id uuid, p_lock_token uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ai_brain_live_deliveries d
    JOIN public.interactions i ON i.id = d.source_interaction_id AND i.company_id = d.company_id
      AND i.customer_id = d.customer_id AND i.conversation_id = d.conversation_id
    JOIN public.conversations c ON c.id = d.conversation_id AND c.company_id = d.company_id
      AND c.customer_id = d.customer_id
    JOIN public.ai_brain_live_settings s ON s.company_id = d.company_id AND s.channel = d.channel
    WHERE d.id = p_id AND d.lock_token = p_lock_token AND d.send_status = 'PROCESSING'
      AND d.locked_at > now() - interval '5 minutes' AND d.channel = 'ZALO'
      AND s.enabled AND c.channel = 'ZALO' AND c.ai_mode = 'ACTIVE'
      AND c.assigned_to IS NULL AND c.status NOT IN ('CLOSED','PENDING_SALE')
      AND i.direction = 'INBOUND' AND i.actor_type = 'CUSTOMER' AND i.type = 'MESSAGE'
      AND i.created_at + interval '1 minute' <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.interactions reply WHERE reply.company_id = d.company_id
          AND reply.conversation_id = d.conversation_id AND reply.customer_id = d.customer_id
          AND reply.type = 'MESSAGE' AND reply.direction = 'OUTBOUND'
          AND reply.actor_type IN ('SALE','TECHNICIAN','AI') AND reply.created_at >= i.created_at
      )
  );
$$;
REVOKE ALL ON FUNCTION public.ai_brain_live_zalo_is_eligible(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_brain_live_zalo_is_eligible(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_ai_brain_live_deliveries(p_limit integer, p_lock_token uuid, p_channel text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, company_id uuid, customer_id uuid, conversation_id uuid, source_interaction_id uuid, channel text, attempts integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_lock_token IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  IF p_channel IS NOT NULL AND p_channel NOT IN ('ZALO', 'MESSENGER', 'VOICE') THEN
    RAISE EXCEPTION 'INVALID_CHANNEL';
  END IF;

  -- Five minutes here is a processing lease timeout, not the customer reply SLA.
  WITH expired_final AS (
    SELECT d.id, to_jsonb(d)->>'dispatch_started_at' AS dispatch_started_at
    FROM public.ai_brain_live_deliveries d
    WHERE d.send_status = 'PROCESSING'
      AND d.locked_at < now() - interval '5 minutes'
      AND (d.attempts >= 5 OR (to_jsonb(d)->>'dispatch_started_at') IS NOT NULL)
      AND (p_channel IS NULL OR d.channel = p_channel)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_brain_live_deliveries d
  SET send_status = 'FAILED',
      error_code = CASE
        WHEN ef.dispatch_started_at IS NOT NULL THEN 'MESSENGER_DISPATCH_UNCERTAIN'
        ELSE 'BRAIN_TIMEOUT'
      END,
      completed_at = now(),
      locked_at = NULL,
      lock_token = NULL,
      updated_at = now()
  FROM expired_final ef
  WHERE d.id = ef.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT d.id
    FROM public.ai_brain_live_deliveries d
    WHERE (
      (
        d.send_status IN ('PENDING', 'FAILED')
        AND d.retryable
        AND d.available_at <= now()
        AND (d.channel <> 'ZALO' OR EXISTS (
          SELECT 1 FROM public.interactions i WHERE i.id = d.source_interaction_id
          AND i.company_id = d.company_id AND i.conversation_id = d.conversation_id
          AND i.created_at + interval '1 minute' <= now()
        ))
        AND d.attempts < 5
        AND (to_jsonb(d)->>'dispatch_started_at') IS NULL
        AND (
          d.error_code IS NULL
          OR d.error_code NOT IN (
            'MESSENGER_DISPATCH_UNCERTAIN',
            'OUTBOUND_PERSISTENCE_FAILED',
            'CANARY_NOT_ALLOWED',
            'CANARY_RESTRICTED',
            'MESSAGING_WINDOW_CLOSED',
            'PAGE_COMPANY_MISMATCH',
            'PAGE_NOT_CONFIGURED',
            'EMPTY_DRAFT',
            'LIVE_SCOPE_INVALID',
            'LIVE_SOURCE_INVALID'
          )
        )
        AND (p_channel IS NULL OR d.channel = p_channel)
      )
      OR (
        d.retryable AND d.send_status = 'PROCESSING'
        AND d.locked_at < now() - interval '5 minutes'
        AND d.attempts < 5
        AND (to_jsonb(d)->>'dispatch_started_at') IS NULL
        AND (
          d.error_code IS NULL
          OR d.error_code NOT IN (
            'MESSENGER_DISPATCH_UNCERTAIN',
            'OUTBOUND_PERSISTENCE_FAILED',
            'CANARY_NOT_ALLOWED',
            'CANARY_RESTRICTED',
            'MESSAGING_WINDOW_CLOSED',
            'PAGE_COMPANY_MISMATCH',
            'PAGE_NOT_CONFIGURED',
            'EMPTY_DRAFT',
            'LIVE_SCOPE_INVALID',
            'LIVE_SOURCE_INVALID'
          )
        )
        AND (p_channel IS NULL OR d.channel = p_channel)
      )
    )
    ORDER BY d.available_at, d.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.ai_brain_live_deliveries d
    SET send_status = 'PROCESSING',
        attempts = d.attempts + 1,
        locked_at = now(),
        lock_token = p_lock_token,
        completed_at = NULL,
        updated_at = now()
    FROM candidates c
    WHERE d.id = c.id
    RETURNING d.id, d.company_id, d.customer_id, d.conversation_id,
              d.source_interaction_id, d.channel, d.attempts
  )
  SELECT * FROM claimed;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_ai_brain_live_deliveries(integer,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_brain_live_deliveries(integer,uuid,text) TO service_role;
