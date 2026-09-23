BEGIN;

CREATE FUNCTION pg_temp.check_it(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %', label; END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

CREATE FUNCTION pg_temp.expect_error(query text, expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE caught text;
BEGIN
    BEGIN EXECUTE query;
    EXCEPTION WHEN OTHERS THEN caught := SQLERRM;
    END;
    IF caught IS NULL OR position(expected IN caught) = 0 THEN
        RAISE EXCEPTION 'Expected %, got %', expected, coalesce(caught, 'success');
    END IF;
    RAISE NOTICE 'PASS: rejected with %', expected;
END $$;

CREATE FUNCTION pg_temp.ingest(c uuid, ext text, k text, phone text DEFAULT NULL, channel text DEFAULT 'FACEBOOK')
RETURNS jsonb LANGUAGE sql AS $$
    SELECT public.han_ingest(c, channel, ext, k, 'Khách test', phone,
        'raw 0912345678', 'cửa rộng 2.5m', 'SUCCEEDED', now(), '{}'::jsonb);
$$;

CREATE FUNCTION pg_temp.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'TEST_AUDIT_FAILURE'; END $$;

DO $$
DECLARE
    a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
    actor uuid := gen_random_uuid(); foreign_actor uuid := gen_random_uuid();
    existing uuid; incoming uuid; other uuid; conv uuid; conv_b uuid;
    interaction uuid; interaction_b uuid; request uuid := gen_random_uuid();
    campaign uuid; delivery uuid; campaign_b uuid; delivery_b uuid;
    first_result jsonb; repeated jsonb; prepared jsonb; count_before bigint;
    i integer;
BEGIN
    INSERT INTO public.companies(id, name) VALUES (a, 'Omnichannel test A'), (b, 'Omnichannel test B');
    INSERT INTO auth.users(id) VALUES(actor), (foreign_actor);
    INSERT INTO public.user_profiles(id, full_name) VALUES(actor, 'Test Sale'), (foreign_actor, 'Other Sale')
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';
    INSERT INTO public.company_members(company_id, user_id, role) VALUES(a, actor, 'SALE'), (b, foreign_actor, 'SALE');
    INSERT INTO public.customers(company_id, name, source, stage) VALUES (a, 'Existing', 'WEBSITE', 'LEAD_NEW') RETURNING id INTO existing;
    INSERT INTO private.customer_private_contacts(company_id, customer_id, normalized_phone, raw_phone, is_verified)
        VALUES(a, existing, '+84912345678', '0912345678', true);

    first_result := pg_temp.ingest(a, '123:456', 'first', '+84912345678');
    interaction := (first_result->>'interaction_id')::uuid;
    SELECT customer_id, conversation_id INTO incoming, conv FROM public.interactions WHERE id = interaction;
    PERFORM pg_temp.check_it(incoming <> existing, 'unverified phone cannot merge a new Messenger sender');
    PERFORM pg_temp.check_it((SELECT status = 'IDENTITY_REVIEW' FROM private.han_intake_events WHERE company_id = a AND event_key = 'first'), 'phone collision is queued for identity review');
    PERFORM pg_temp.check_it((SELECT customer_id = incoming FROM public.identities WHERE company_id = a AND external_id = '123:456'), 'sender identity belongs to its own customer');
    repeated := pg_temp.ingest(a, '123:456', 'first', '+84912345678');
    PERFORM pg_temp.check_it(repeated->>'interaction_id' = first_result->>'interaction_id', 'duplicate webhook preserves interaction');
    PERFORM pg_temp.check_it((SELECT count(*) = 1 FROM public.interactions WHERE company_id = a), 'duplicate webhook creates no extra interaction');
    PERFORM pg_temp.check_it((SELECT count(*) = 2 FROM public.customers WHERE company_id = a), 'duplicate webhook creates no extra customer');
    PERFORM pg_temp.expect_error(format('SELECT pg_temp.ingest(%L, %L, %L, %L)', a, '123:789', 'first', '+84912345678'), 'IDEMPOTENCY_CONFLICT');
    PERFORM pg_temp.expect_error(format('SELECT pg_temp.ingest(%L, %L, %L, %L)', a, '123:456', 'first', '+84999999999'), 'IDEMPOTENCY_CONFLICT');
    PERFORM pg_temp.ingest(a, '123:456', 'second', '+84912345678');
    PERFORM pg_temp.check_it((SELECT count(*) = 2 FROM public.customers WHERE company_id = a), 'known sender keeps its customer during phone conflict');

    first_result := pg_temp.ingest(a, NULL, 'web-1', '+84912345678', 'WEBSITE');
    repeated := pg_temp.ingest(a, NULL, 'web-1', '+84912345678', 'WEBSITE');
    PERFORM pg_temp.check_it(first_result->>'interaction_id' = repeated->>'interaction_id', 'Website request_id is idempotent');
    PERFORM pg_temp.check_it((SELECT customer_id <> existing FROM public.interactions WHERE id = (first_result->>'interaction_id')::uuid), 'Website cannot merge on an unverified phone');
    PERFORM pg_temp.ingest(a, NULL, 'web-2', '+84912345678', 'WEBSITE');
    PERFORM pg_temp.check_it(NOT EXISTS(SELECT 1 FROM public.identities WHERE company_id = a AND channel = 'WEBSITE'), 'Website requests never become persistent identities');
    PERFORM pg_temp.expect_error(format('SELECT pg_temp.ingest(%L, NULL, %L, %L, %L)', a, 'web-1', '+84999999999', 'WEBSITE'), 'IDEMPOTENCY_CONFLICT');
    PERFORM pg_temp.check_it((SELECT sanitized_content = 'cửa rộng 2.5m' FROM public.interactions WHERE id = interaction), 'public zone contains only derivative');
    PERFORM pg_temp.check_it((SELECT raw_content = 'raw 0912345678' FROM private.interaction_raw_contents WHERE interaction_id = interaction), 'raw source preserved privately');
    PERFORM pg_temp.check_it(NOT has_table_privilege('authenticated', 'private.han_intake_events', 'SELECT'), 'intake raw payload inaccessible to authenticated');
    PERFORM pg_temp.check_it(NOT has_function_privilege('authenticated', 'public.han_ingest(uuid,text,text,text,text,text,text,text,text,timestamptz,jsonb)', 'EXECUTE'), 'intake RPC service role only');

    first_result := pg_temp.ingest(b, '999:888', 'foreign');
    interaction_b := (first_result->>'interaction_id')::uuid;
    SELECT customer_id, conversation_id INTO other, conv_b FROM public.interactions WHERE id = interaction_b;
    PERFORM pg_temp.expect_error(format('UPDATE private.han_intake_events SET interaction_id = %L WHERE company_id = %L AND event_key = %L', interaction_b, a, 'first'), 'foreign key');

    prepared := public.han_prepare_send(a, conv, actor, request, 'hello', 'hello', 'SUCCEEDED', NULL);
    PERFORM pg_temp.check_it((prepared->>'claimed')::boolean, 'first send claims outbox');
    PERFORM pg_temp.check_it(NOT (public.han_prepare_send(a, conv, actor, request, 'hello', 'hello', 'SUCCEEDED', NULL)->>'claimed')::boolean, 'retry never resends a claimed request');
    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,NULL)', a, conv, actor, request, 'changed', 'changed', 'SUCCEEDED'), 'IDEMPOTENCY_CONFLICT');
    PERFORM pg_temp.expect_error(format('UPDATE private.han_outbox SET conversation_id = %L WHERE company_id = %L', conv_b, a), 'foreign key');
    PERFORM pg_temp.expect_error(format('UPDATE private.han_outbox SET interaction_id = %L WHERE company_id = %L', interaction_b, a), 'foreign key');
    PERFORM pg_temp.expect_error(format('UPDATE private.han_outbox SET actor_id = %L WHERE company_id = %L', foreign_actor, a), 'foreign key');
    PERFORM public.han_finish_send(a, request, 'UNKNOWN', NULL);
    PERFORM pg_temp.check_it(NOT (public.han_prepare_send(a, conv, actor, request, 'hello', 'hello', 'SUCCEEDED', NULL)->>'claimed')::boolean, 'ambiguous provider result is not retried automatically');

    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,NULL)', b, conv, foreign_actor, gen_random_uuid(), 'hello', 'hello', 'SUCCEEDED'), 'NOT_FOUND');
    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,NULL)', a, conv, foreign_actor, gen_random_uuid(), 'hello', 'hello', 'SUCCEEDED'), 'ACCESS_DENIED');
    UPDATE public.user_profiles SET status = 'INACTIVE' WHERE id = actor;
    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,NULL)', a, conv, actor, gen_random_uuid(), 'hello', 'hello', 'SUCCEEDED'), 'ACCESS_DENIED');
    UPDATE public.user_profiles SET status = 'ACTIVE' WHERE id = actor;
    UPDATE public.company_members SET status = 'INACTIVE' WHERE user_id = actor;
    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,NULL)', a, conv, actor, gen_random_uuid(), 'hello', 'hello', 'SUCCEEDED'), 'ACCESS_DENIED');
    UPDATE public.company_members SET status = 'ACTIVE', role = 'TECHNICIAN' WHERE user_id = actor;
    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,NULL)', a, conv, actor, gen_random_uuid(), 'hello', 'hello', 'SUCCEEDED'), 'ACCESS_DENIED');
    UPDATE public.company_members SET role = 'SALE' WHERE user_id = actor;
    UPDATE public.interactions SET created_at = now() - interval '24 hours' WHERE conversation_id = conv AND direction = 'INBOUND';
    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,NULL)', a, conv, actor, gen_random_uuid(), 'hello', 'hello', 'SUCCEEDED'), 'WINDOW_CLOSED');
    UPDATE public.interactions SET created_at = now() WHERE conversation_id = conv AND direction = 'INBOUND';

    INSERT INTO public.care_campaigns(company_id, channel, audience_rule, message_template, started_at)
        VALUES(a, 'FACEBOOK', '{}', 'Test', now()) RETURNING id INTO campaign;
    INSERT INTO public.care_deliveries(company_id, campaign_id, customer_id, idempotency_key, channel)
        VALUES(a, campaign, incoming, 'test', 'FACEBOOK') RETURNING id INTO delivery;
    INSERT INTO public.care_campaigns(company_id, channel, audience_rule, message_template, started_at)
        VALUES(b, 'FACEBOOK', '{}', 'Test', now()) RETURNING id INTO campaign_b;
    INSERT INTO public.care_deliveries(company_id, campaign_id, customer_id, idempotency_key, channel)
        VALUES(b, campaign_b, other, 'test', 'FACEBOOK') RETURNING id INTO delivery_b;
    PERFORM pg_temp.expect_error(format('UPDATE private.han_outbox SET care_delivery_id = %L WHERE company_id = %L', delivery_b, a), 'foreign key');
    INSERT INTO public.care_schedules(company_id, customer_id, channel, next_send_at, enabled)
        VALUES(a, incoming, 'FACEBOOK', now(), false);
    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,%L)', a, conv, actor, gen_random_uuid(), 'hello', 'hello', 'SUCCEEDED', delivery), 'CARE_STOPPED');

    SELECT count(*) INTO count_before FROM public.interactions WHERE company_id = a;
    CREATE TRIGGER han_test_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_audit();
    PERFORM pg_temp.expect_error(format('SELECT public.han_prepare_send(%L,%L,%L,%L,%L,%L,%L,NULL)', a, conv, actor, gen_random_uuid(), 'hello', 'hello', 'SUCCEEDED'), 'TEST_AUDIT_FAILURE');
    PERFORM pg_temp.check_it((SELECT count(*) = count_before FROM public.interactions WHERE company_id = a), 'audit failure rolls back interaction and outbox');
    PERFORM pg_temp.expect_error(format('SELECT pg_temp.ingest(%L,%L,%L,%L)', a, '123:999', 'audit-failure', '+84912345678'), 'TEST_AUDIT_FAILURE');
    PERFORM pg_temp.check_it(NOT EXISTS(SELECT 1 FROM private.han_intake_events WHERE company_id = a AND event_key = 'audit-failure'), 'identity review audit failure rolls back intake');
    DROP TRIGGER han_test_audit_failure ON public.audit_logs;

    FOR i IN 1..5 LOOP
        PERFORM pg_temp.check_it(public.han_rate_limit(a, repeat('a',64)), 'phone quota accepts first five requests');
    END LOOP;
    PERFORM pg_temp.check_it(NOT public.han_rate_limit(a, repeat('a',64)), 'phone quota blocks sixth request');
    FOR i IN 1..200 LOOP PERFORM public.han_rate_limit(b, lpad(to_hex(i),64,'0')); END LOOP;
    PERFORM pg_temp.check_it(NOT public.han_rate_limit(b, repeat('f',64)), 'company global quota blocks request 201');
END $$;
ROLLBACK;
