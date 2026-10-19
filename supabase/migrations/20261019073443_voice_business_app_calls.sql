-- Business-aware browser test reuses the human click-to-call preparation and status pipeline.
ALTER TABLE public.calls ADD COLUMN initiated_by uuid REFERENCES public.user_profiles(id),
  ADD COLUMN request_id uuid;
CREATE UNIQUE INDEX uq_sale_voice_request ON public.calls(company_id, initiated_by, request_id);
ALTER TABLE public.call_attempts ADD COLUMN provider_call_id text;
ALTER TABLE public.voice_webhook_events ADD COLUMN call_id uuid REFERENCES public.calls(id),
  ADD COLUMN processed_at timestamptz;

CREATE TABLE public.voice_test_customers (
  customer_id uuid PRIMARY KEY REFERENCES public.customers(id),
  integration_id uuid NOT NULL REFERENCES public.voice_provider_integrations(id)
);
CREATE TABLE public.voice_browser_call_sessions (
  call_id uuid PRIMARY KEY REFERENCES public.calls(id),
  integration_id uuid NOT NULL REFERENCES public.voice_provider_integrations(id),
  from_user_id text NOT NULL, to_user_id text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  provider_call_id text UNIQUE
);
ALTER TABLE public.voice_test_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_browser_call_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_test_customers, public.voice_browser_call_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_test_customers, public.voice_browser_call_sessions TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_sale_voice_call_atomic(
  p_company_id uuid, p_customer_id uuid, p_actor_id uuid, p_provider text, p_request_id uuid,
  p_test_integration_id uuid DEFAULT NULL, p_test_from text DEFAULT NULL, p_test_to text DEFAULT NULL
) RETURNS TABLE(call_id uuid, attempt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_call uuid; v_attempt uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.company_members m JOIN public.user_profiles u ON u.id=m.user_id
    WHERE m.company_id=p_company_id AND m.user_id=p_actor_id AND m.status='ACTIVE'
      AND m.role IN ('SALE','BOSS_ADMIN') AND u.status='ACTIVE') OR
    NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.company_id=p_company_id AND c.id=p_customer_id) THEN
    RAISE EXCEPTION 'VOICE_SCOPE_FORBIDDEN';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':sale:' || p_actor_id::text,0));
  IF p_test_integration_id IS NOT NULL THEN
    IF p_provider <> 'STRINGEE' OR NOT EXISTS (
      SELECT 1 FROM public.voice_provider_integrations i JOIN public.voice_test_customers t ON t.integration_id=i.id
      JOIN public.company_members m ON m.company_id=i.company_id AND m.user_id=p_actor_id
      WHERE i.id=p_test_integration_id AND i.company_id=p_company_id AND i.provider='STRINGEE' AND i.active
        AND t.customer_id=p_customer_id AND m.role='BOSS_ADMIN' AND m.status='ACTIVE'
    ) OR p_test_from !~ '^crm_t_[A-Za-z0-9_-]{22}_a$' OR
      p_test_to IS DISTINCT FROM left(p_test_from,29) || 'b' THEN
      RAISE EXCEPTION 'VOICE_TEST_FORBIDDEN';
    END IF;
    IF EXISTS (SELECT 1 FROM public.voice_browser_call_sessions s JOIN public.calls c ON c.id=s.call_id
      WHERE c.company_id=p_company_id AND s.from_user_id=p_test_from AND s.expires_at>now()
        AND c.request_id<>p_request_id AND c.status IN ('INITIATED','RINGING','CONNECTED')) THEN
      RAISE EXCEPTION 'VOICE_TEST_BUSY';
    END IF;
  END IF;
  SELECT c.id INTO v_call FROM public.calls c WHERE c.company_id=p_company_id
    AND c.initiated_by=p_actor_id AND c.request_id=p_request_id;
  IF v_call IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.calls c WHERE c.id=v_call AND c.customer_id=p_customer_id AND c.provider=p_provider)
      THEN RAISE EXCEPTION 'VOICE_REQUEST_MISMATCH'; END IF;
    RETURN QUERY SELECT v_call, a.id FROM public.call_attempts a WHERE a.call_id=v_call;
    RETURN;
  END IF;
  v_call := gen_random_uuid();
  INSERT INTO public.calls(id,company_id,customer_id,direction,agent_type,provider,provider_call_id,
    started_at,status,transcript_status,initiated_by,request_id)
  VALUES(v_call,p_company_id,p_customer_id,'OUTBOUND','SALE',p_provider,'crm_'||v_call::text,
    now(),'INITIATED','PENDING',p_actor_id,p_request_id);
  INSERT INTO public.audit_logs(company_id,user_id,action,resource_type,resource_id,customer_id,result,metadata)
    VALUES(p_company_id,p_actor_id,'INITIATE_CALL','CALL',v_call,p_customer_id,'SUCCESS',
      jsonb_build_object('call_id',v_call,'test_only',p_test_integration_id IS NOT NULL));
  IF p_provider='STRINGEE' THEN
    -- A manual Sale attempt is not an AI contact cycle and must never trigger scheduled retries.
    INSERT INTO public.call_attempts(company_id,customer_id,contact_cycle_id,attempt_no,scheduled_at,called_at,result,call_id,provider_call_id)
      VALUES(p_company_id,p_customer_id,gen_random_uuid(),1,now(),now(),'PENDING',v_call,'crm_'||v_call::text)
      RETURNING id INTO v_attempt;
  END IF;
  IF p_test_integration_id IS NOT NULL THEN
    INSERT INTO public.voice_browser_call_sessions(call_id,integration_id,from_user_id,to_user_id)
      VALUES(v_call,p_test_integration_id,p_test_from,p_test_to);
  END IF;
  RETURN QUERY SELECT v_call,v_attempt;
END;
$$;
REVOKE ALL ON FUNCTION public.prepare_sale_voice_call_atomic(uuid,uuid,uuid,text,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_sale_voice_call_atomic(uuid,uuid,uuid,text,uuid,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.bind_sale_voice_provider_call(p_company_id uuid,p_call_id uuid,p_provider_call_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_call public.calls%ROWTYPE; e record; v_provider text;
BEGIN
  SELECT c.provider INTO v_provider FROM public.calls c WHERE c.id=p_call_id AND c.company_id=p_company_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || v_provider || ':' || p_provider_call_id,0));
  SELECT * INTO v_call FROM public.calls c WHERE c.id=p_call_id AND c.company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR p_provider_call_id IS NULL OR length(p_provider_call_id)>220 THEN
    RAISE EXCEPTION 'VOICE_BIND_FORBIDDEN'; END IF;
  IF v_call.provider_call_id='crm_'||p_call_id::text THEN
    UPDATE public.calls SET provider_call_id=p_provider_call_id WHERE id=p_call_id;
    UPDATE public.call_attempts SET provider_call_id=p_provider_call_id WHERE call_id=p_call_id AND company_id=p_company_id;
  ELSIF p_provider_call_id <> v_call.provider_call_id AND p_provider_call_id <> 'crm_'||p_call_id::text THEN
    RAISE EXCEPTION 'VOICE_BIND_CONFLICT';
  END IF;
  FOR e IN SELECT * FROM public.voice_webhook_events w WHERE w.company_id=p_company_id AND w.provider=v_call.provider
    AND w.provider_call_id=p_provider_call_id AND w.processed_at IS NULL ORDER BY w.created_at LOOP
    PERFORM public.apply_voice_call_status_atomic(p_company_id,v_call.provider,p_provider_call_id,e.status,e.idempotency_key);
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.bind_sale_voice_provider_call(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_sale_voice_provider_call(uuid,uuid,text) TO service_role;

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
  v_event public.voice_webhook_events%ROWTYPE;
  v_rank integer;
  v_next_rank integer;
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

  SELECT * INTO v_event FROM public.voice_webhook_events e
    WHERE e.company_id=p_company_id AND e.provider=p_provider AND e.idempotency_key=p_event_idempotency_key FOR UPDATE;
  IF v_event.processed_at IS NOT NULL THEN
    SELECT c.id,c.customer_id,c.status INTO v_call.id,v_call.customer_id,v_call.status
      FROM public.calls c WHERE c.company_id=p_company_id AND c.provider=p_provider AND c.provider_call_id=p_provider_call_id;
    RETURN QUERY SELECT v_call.id,v_call.customer_id,v_call.status,v_call.status,true,NULL::text;
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

  IF p_new_status NOT IN ('INITIATED','RINGING','CONNECTED','COMPLETED','FAILED','NO_ANSWER','BUSY') THEN
    RAISE EXCEPTION 'VOICE_STATUS_INVALID'; END IF;
  UPDATE public.voice_webhook_events SET call_id=v_call.id,processed_at=now() WHERE id=v_event.id;
  v_rank := CASE v_call.status WHEN 'INITIATED' THEN 1 WHEN 'RINGING' THEN 2 WHEN 'CONNECTED' THEN 3 ELSE 4 END;
  v_next_rank := CASE p_new_status WHEN 'INITIATED' THEN 1 WHEN 'RINGING' THEN 2 WHEN 'CONNECTED' THEN 3 ELSE 4 END;
  -- First terminal outcome wins; delayed created/ringing events never regress an answered call.
  IF v_current_terminal OR v_next_rank < v_rank THEN
    RETURN QUERY SELECT v_call.id,v_call.customer_id,v_call.status,v_call.status,false,NULL::text;
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

      IF v_call.agent_type='AI' AND v_attempt_res NOT IN ('ANSWERED', 'CANCELLED') THEN
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
      p_company_id, v_call.customer_id, NULL, CASE WHEN v_call.agent_type='SALE' THEN 'PHONE' ELSE 'AI_VOICE' END, 'CALL_EVENT', v_call.direction,
      NULL, 'NOT_REQUIRED', CASE WHEN v_call.agent_type='SALE' THEN 'SYSTEM' ELSE 'AI' END, NULL, p_event_idempotency_key
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_call.id, v_call.customer_id, v_call.status, p_new_status, false, v_attempt_res;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_voice_call_status_atomic(uuid, text, text, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_voice_call_status_atomic(uuid, text, text, text, text, timestamptz, timestamptz) TO service_role;


CREATE OR REPLACE FUNCTION public.bind_voice_browser_test_call(
  p_integration_id uuid,p_from text,p_to text,p_provider_call_id text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_call uuid; v_company uuid; e record;
BEGIN
  IF p_provider_call_id !~ '^call-[A-Za-z0-9-]{8,200}$' THEN RAISE EXCEPTION 'VOICE_CALL_ID_INVALID'; END IF;
  SELECT i.company_id INTO v_company FROM public.voice_provider_integrations i WHERE i.id=p_integration_id AND i.active;
  IF v_company IS NULL THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_company::text || ':STRINGEE:' || p_provider_call_id,0));
  SELECT c.id,c.company_id INTO v_call,v_company FROM public.voice_browser_call_sessions s
    JOIN public.calls c ON c.id=s.call_id JOIN public.voice_provider_integrations i ON i.id=s.integration_id
    WHERE s.integration_id=p_integration_id AND i.active AND i.company_id=c.company_id
      AND s.from_user_id=p_from AND s.to_user_id=p_to
      AND (s.provider_call_id=p_provider_call_id OR
        (s.provider_call_id IS NULL AND s.expires_at>now() AND c.status='INITIATED'))
    ORDER BY c.created_at DESC LIMIT 1 FOR UPDATE OF s,c;
  IF v_call IS NULL THEN RETURN NULL; END IF;
  PERFORM public.bind_sale_voice_provider_call(v_company,v_call,p_provider_call_id);
  UPDATE public.voice_browser_call_sessions SET provider_call_id=p_provider_call_id WHERE call_id=v_call;
  -- Status webhooks may race the signed Answer URL. Reconcile persisted, unprocessed events.
  FOR e IN SELECT * FROM public.voice_webhook_events w WHERE w.company_id=v_company AND w.provider='STRINGEE'
    AND w.provider_call_id=p_provider_call_id AND w.processed_at IS NULL ORDER BY w.created_at LOOP
    PERFORM public.apply_voice_call_status_atomic(v_company,'STRINGEE',p_provider_call_id,e.status,e.idempotency_key);
  END LOOP;
  RETURN v_call;
END;
$$;
REVOKE ALL ON FUNCTION public.bind_voice_browser_test_call(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_voice_browser_test_call(uuid,text,text,text) TO service_role;
