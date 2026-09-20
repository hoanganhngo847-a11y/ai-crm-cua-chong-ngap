BEGIN;

CREATE TABLE private.han_intake_events (
                                           company_id uuid NOT NULL REFERENCES public.companies(id),
                                           channel text NOT NULL CHECK (channel IN ('FACEBOOK', 'WEBSITE')),
                                           event_key text NOT NULL,
                                           external_identity text NOT NULL,
                                           payload jsonb NOT NULL,
                                           status text NOT NULL CHECK (
                                               status IN ('RECEIVED', 'PROCESSED', 'IDENTITY_REVIEW')
                                               ),
                                           interaction_id uuid REFERENCES public.interactions(id),
                                           created_at timestamptz NOT NULL DEFAULT now(),
                                           PRIMARY KEY (company_id, channel, event_key)
);

CREATE TABLE private.han_outbox (
                                    company_id uuid NOT NULL REFERENCES public.companies(id),
                                    request_id uuid NOT NULL,
                                    conversation_id uuid NOT NULL REFERENCES public.conversations(id),
                                    interaction_id uuid NOT NULL REFERENCES public.interactions(id),
                                    actor_id uuid NOT NULL REFERENCES public.user_profiles(id),
                                    content text NOT NULL,
                                    status text NOT NULL CHECK (
                                        status IN ('SENDING', 'SENT', 'FAILED', 'UNKNOWN')
                                        ),
                                    provider_mid text,
                                    care_delivery_id uuid REFERENCES public.care_deliveries(id),
                                    created_at timestamptz NOT NULL DEFAULT now(),
                                    PRIMARY KEY (company_id, request_id)
);

CREATE UNIQUE INDEX han_outbox_delivery_once
    ON private.han_outbox(care_delivery_id)
    WHERE care_delivery_id IS NOT NULL;

CREATE TABLE private.han_receipts (
                                      company_id uuid NOT NULL REFERENCES public.companies(id),
                                      external_identity text NOT NULL,
                                      event_key text NOT NULL,
                                      kind text NOT NULL CHECK (kind IN ('DELIVERY', 'READ')),
                                      mids text[] NOT NULL,
                                      watermark bigint,
                                      created_at timestamptz NOT NULL DEFAULT now(),
                                      PRIMARY KEY (company_id, event_key)
);

CREATE TABLE private.han_rate_buckets (
                                          company_id uuid NOT NULL REFERENCES public.companies(id),
                                          key text NOT NULL,
                                          bucket timestamptz NOT NULL,
                                          hits integer NOT NULL,
                                          PRIMARY KEY (company_id, key, bucket)
);

ALTER TABLE private.han_intake_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.han_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.han_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.han_rate_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
    private.han_intake_events,
    private.han_outbox,
    private.han_receipts,
    private.han_rate_buckets
    FROM PUBLIC, anon, authenticated;

-- Giới hạn số lần gửi form theo số điện thoại đã HMAC.
CREATE FUNCTION public.han_rate_limit(
    p_company uuid,
    p_key text
)
    RETURNS boolean
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
v_count integer;
  v_global integer;
  v_bucket timestamptz;
BEGIN
  IF p_key !~ '^[a-f0-9]{64}$'
    OR NOT EXISTS (
      SELECT 1 FROM public.companies
      WHERE id = p_company AND status = 'ACTIVE'
    )
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
END IF;

  v_bucket := to_timestamp(
    floor(extract(epoch FROM now()) / 900) * 900
  );

INSERT INTO private.han_rate_buckets
VALUES (p_company, 'global', v_bucket, 1)
    ON CONFLICT (company_id, key, bucket)
  DO UPDATE SET hits = private.han_rate_buckets.hits + 1
             RETURNING hits INTO v_global;

INSERT INTO private.han_rate_buckets
VALUES (p_company, p_key, v_bucket, 1)
    ON CONFLICT (company_id, key, bucket)
  DO UPDATE SET hits = private.han_rate_buckets.hits + 1
             RETURNING hits INTO v_count;

DELETE FROM private.han_rate_buckets
WHERE company_id = p_company
  AND bucket < now() - interval '1 day';

RETURN v_count <= 5 AND v_global <= 200;
END;
$$;

-- Nhận khách/tin nhắn theo transaction, không tạo trùng phone.
CREATE FUNCTION public.han_ingest(
    p_company uuid,
    p_channel text,
    p_external text,
    p_key text,
    p_name text,
    p_phone text,
    p_content text,
    p_safe text,
    p_safe_status text,
    p_occurred timestamptz,
    p_payload jsonb
)
    RETURNS jsonb
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
v_customer uuid;
  v_phone_customer uuid;
  v_conversation uuid;
  v_interaction uuid;
  v_existing private.han_intake_events%ROWTYPE;
  v_contact text;
BEGIN
  IF p_channel NOT IN ('FACEBOOK', 'WEBSITE')
    OR p_safe_status NOT IN ('SUCCEEDED', 'PENDING')
    OR length(p_external) > 250
    OR length(p_key) > 500
    OR length(p_content) > 10000
    OR length(p_name) > 100
    OR (p_safe_status = 'PENDING' AND p_safe IS NOT NULL)
    OR (
      p_phone IS NOT NULL
      AND p_phone !~ '^\+[1-9][0-9]{7,14}$'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.companies
      WHERE id = p_company AND status = 'ACTIVE'
    )
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('han-intake:' || p_company::text, 0)
  );

SELECT * INTO v_existing
FROM private.han_intake_events
WHERE company_id = p_company
  AND channel = p_channel
  AND event_key = p_key;

IF FOUND THEN
    IF v_existing.external_identity <> p_external
      OR v_existing.payload->>'content' IS DISTINCT FROM p_content
      OR v_existing.payload->>'phone' IS DISTINCT FROM p_phone
    THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
END IF;

RETURN jsonb_build_object(
        'status', v_existing.status,
        'interaction_id', v_existing.interaction_id
       );
END IF;

INSERT INTO private.han_intake_events
VALUES (
           p_company,
           p_channel,
           p_key,
           p_external,
           jsonb_build_object(
                   'source', p_payload,
                   'content', p_content,
                   'phone', p_phone,
                   'occurred_at', p_occurred
           ),
           'RECEIVED',
           NULL,
           now()
       );

SELECT customer_id INTO v_customer
FROM public.identities
WHERE company_id = p_company
  AND channel = p_channel
  AND external_id = p_external;

IF p_phone IS NOT NULL THEN
SELECT customer_id INTO v_phone_customer
FROM private.customer_private_contacts
WHERE company_id = p_company
  AND normalized_phone = p_phone;
END IF;

  IF v_customer IS NOT NULL THEN
SELECT normalized_phone INTO v_contact
FROM private.customer_private_contacts
WHERE company_id = p_company
  AND customer_id = v_customer;
END IF;

  -- Danh tính mâu thuẫn: giữ tin, không tự gộp/sửa liên hệ.
  IF (
    v_customer IS NOT NULL
    AND v_phone_customer IS NOT NULL
    AND v_customer <> v_phone_customer
  ) OR (
    v_contact IS NOT NULL
    AND p_phone IS NOT NULL
    AND v_contact <> p_phone
  ) THEN
UPDATE private.han_intake_events
SET status = 'IDENTITY_REVIEW'
WHERE company_id = p_company
  AND channel = p_channel
  AND event_key = p_key;

INSERT INTO public.audit_logs (
    company_id, action, resource_type,
    resource_id, customer_id, result
)
VALUES (
           p_company, 'OMNICHANNEL_IDENTITY_REVIEW',
           'Customer', v_customer, v_customer, 'SUCCESS'
       );
ELSE
    v_customer := coalesce(v_customer, v_phone_customer);
END IF;

  IF v_customer IS NULL THEN
    INSERT INTO public.customers (
      company_id, name, source, stage
    )
    VALUES (
      p_company, p_name, p_channel, 'LEAD_NEW'
    )
    RETURNING id INTO v_customer;

INSERT INTO public.customer_stage_histories (
    company_id, customer_id, from_stage,
    to_stage, actor_type, reason
)
VALUES (
           p_company, v_customer, NULL,
           'LEAD_NEW', 'SYSTEM', 'OMNICHANNEL_INTAKE'
       );
END IF;

INSERT INTO public.identities (
    company_id, customer_id, channel,
    external_id, verified
)
VALUES (
           p_company, v_customer, p_channel,
           p_external, false
       )
    ON CONFLICT (company_id, channel, external_id)
  DO NOTHING;

IF p_phone IS NOT NULL
    AND v_phone_customer IS NULL
    AND v_contact IS NULL
  THEN
    INSERT INTO private.customer_private_contacts (
      company_id, customer_id,
      normalized_phone, raw_phone, is_verified
    )
    VALUES (
      p_company, v_customer, p_phone, p_phone, false
    );
END IF;

  IF p_channel = 'FACEBOOK' THEN
    INSERT INTO public.conversations (
      company_id, customer_id, channel,
      external_conversation_id,
      last_message_at, unread_count
    )
    VALUES (
      p_company, v_customer, 'FACEBOOK',
      p_external, p_occurred, 1
    )
    ON CONFLICT (
      company_id, channel, external_conversation_id
    )
    DO UPDATE SET
    last_message_at = greatest(
                public.conversations.last_message_at,
                excluded.last_message_at
                ),
                unread_count = public.conversations.unread_count + 1
                RETURNING id INTO v_conversation;
END IF;

INSERT INTO public.interactions (
    company_id, customer_id, conversation_id,
    channel, type, direction,
    sanitized_content, sanitization_status,
    sanitized_at, sanitizer_version,
    external_ref, actor_type, created_at
)
VALUES (
           p_company, v_customer, v_conversation,
           p_channel, 'MESSAGE', 'INBOUND',
           p_safe, p_safe_status,
           CASE WHEN p_safe_status = 'SUCCEEDED' THEN now() END,
           'han-conservative-v1',
           p_key, 'CUSTOMER', p_occurred
       )
    RETURNING id INTO v_interaction;

INSERT INTO private.interaction_raw_contents (
    interaction_id, company_id, raw_content, raw_payload
)
VALUES (
           v_interaction, p_company, p_content, p_payload
       );

UPDATE private.han_intake_events
SET
    status = CASE
                 WHEN status = 'IDENTITY_REVIEW' THEN status
                 ELSE 'PROCESSED'
        END,
    interaction_id = v_interaction
WHERE company_id = p_company
  AND channel = p_channel
  AND event_key = p_key;

-- Quy ước: phản hồi cho lượt chăm sóc gần nhất trong 7 ngày.
IF p_channel = 'FACEBOOK' THEN
UPDATE public.care_deliveries
SET responded_at = p_occurred, status = 'RESPONDED'
WHERE id = (
    SELECT d.id
    FROM public.care_deliveries d
             JOIN private.han_outbox o ON o.care_delivery_id = d.id
    WHERE d.company_id = p_company
      AND d.customer_id = v_customer
      AND d.channel = 'FACEBOOK'
      AND o.conversation_id = v_conversation
      AND d.sent_at <= p_occurred
      AND d.sent_at > p_occurred - interval '7 days'
  AND d.status IN (
    'SENT', 'DELIVERED', 'READ',
    'RESPONDED', 'CONVERTED_TO_SALE'
    )
ORDER BY d.sent_at DESC
    LIMIT 1
    )
    AND responded_at IS NULL
    AND status <> 'CONVERTED_TO_SALE';
END IF;

RETURN jsonb_build_object(
        'status', 'ACCEPTED',
        'interaction_id', v_interaction
       );
END;
$$;

-- Ghi ý định gửi trước khi gọi Meta.
CREATE FUNCTION public.han_prepare_send(
    p_company uuid,
    p_conversation uuid,
    p_actor uuid,
    p_request uuid,
    p_content text,
    p_safe text,
    p_safe_status text,
    p_delivery uuid
)
    RETURNS jsonb
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
v_conversation public.conversations%ROWTYPE;
  v_existing private.han_outbox%ROWTYPE;
  v_interaction uuid;
  v_latest timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'han-send:' || p_company::text || p_request::text,
      0
    )
  );

SELECT * INTO v_conversation
FROM public.conversations
WHERE company_id = p_company
  AND id = p_conversation
  AND channel = 'FACEBOOK'
    FOR UPDATE;

IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members m
    JOIN public.user_profiles u ON u.id = m.user_id
    JOIN public.companies c ON c.id = m.company_id
    WHERE m.company_id = p_company
      AND m.user_id = p_actor
      AND m.status = 'ACTIVE'
      AND u.status = 'ACTIVE'
      AND c.status = 'ACTIVE'
      AND m.role IN ('BOSS_ADMIN', 'SALE')
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED';
END IF;

SELECT * INTO v_existing
FROM private.han_outbox
WHERE company_id = p_company
  AND request_id = p_request;

IF FOUND THEN
    IF v_existing.conversation_id <> p_conversation
      OR v_existing.actor_id <> p_actor
      OR v_existing.content <> p_content
      OR v_existing.care_delivery_id IS DISTINCT FROM p_delivery
    THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
END IF;

RETURN jsonb_build_object(
        'claimed', false,
        'status', v_existing.status
       );
END IF;

SELECT max(created_at) INTO v_latest
FROM public.interactions
WHERE company_id = p_company
  AND conversation_id = p_conversation
  AND direction = 'INBOUND'
  AND actor_type = 'CUSTOMER';

IF v_latest IS NULL
    OR v_latest < now() - interval '24 hours'
    OR v_latest > now() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'WINDOW_CLOSED';
END IF;

  IF length(p_content) NOT BETWEEN 1 AND 2000
    OR p_safe_status NOT IN ('PENDING', 'SUCCEEDED')
    OR (p_safe_status = 'PENDING' AND p_safe IS NOT NULL)
  THEN
    RAISE EXCEPTION 'INVALID_INPUT';
END IF;

  IF p_delivery IS NOT NULL THEN
    PERFORM 1
    FROM public.care_deliveries d
    JOIN public.care_campaigns c
      ON c.id = d.campaign_id
      AND c.company_id = d.company_id
    WHERE d.id = p_delivery
      AND d.company_id = p_company
      AND d.customer_id = v_conversation.customer_id
      AND d.channel = 'FACEBOOK'
      AND c.channel = 'FACEBOOK'
      AND d.status = 'PENDING'
    FOR UPDATE OF d;

IF NOT FOUND THEN
      RAISE EXCEPTION 'INVALID_DELIVERY';
END IF;

    IF EXISTS (
      SELECT 1 FROM public.care_schedules
      WHERE company_id = p_company
        AND customer_id = v_conversation.customer_id
        AND channel = 'FACEBOOK'
        AND enabled = false
    ) THEN
      RAISE EXCEPTION 'CARE_STOPPED';
END IF;
END IF;

INSERT INTO public.interactions (
    company_id, customer_id, conversation_id,
    channel, type, direction,
    sanitized_content, sanitization_status,
    sanitized_at, sanitizer_version,
    actor_type, actor_user_id
)
VALUES (
           p_company, v_conversation.customer_id,
           p_conversation, 'FACEBOOK', 'MESSAGE', 'OUTBOUND',
           p_safe, p_safe_status,
           CASE WHEN p_safe_status = 'SUCCEEDED' THEN now() END,
           'han-conservative-v1', 'SALE', p_actor
       )
    RETURNING id INTO v_interaction;

INSERT INTO private.interaction_raw_contents (
    interaction_id, company_id, raw_content
)
VALUES (v_interaction, p_company, p_content);

INSERT INTO private.han_outbox (
    company_id, request_id, conversation_id,
    interaction_id, actor_id, content,
    status, care_delivery_id
)
VALUES (
           p_company, p_request, p_conversation,
           v_interaction, p_actor, p_content,
           'SENDING', p_delivery
       );

INSERT INTO public.audit_logs (
    company_id, user_id, action, resource_type,
    resource_id, customer_id, result
)
VALUES (
           p_company, p_actor, 'MESSENGER_SEND_REQUESTED',
           'Interaction', v_interaction,
           v_conversation.customer_id, 'SUCCESS'
       );

RETURN jsonb_build_object(
        'claimed', true,
        'status', 'SENDING'
       );
END;
$$;

CREATE FUNCTION public.han_finish_send(
    p_company uuid,
    p_request uuid,
    p_status text,
    p_mid text
)
    RETURNS void
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
v_row private.han_outbox%ROWTYPE;
  v_conversation public.conversations%ROWTYPE;
BEGIN
SELECT * INTO v_row
FROM private.han_outbox
WHERE company_id = p_company
  AND request_id = p_request
    FOR UPDATE;

IF NOT FOUND
    OR p_status NOT IN ('SENT', 'FAILED', 'UNKNOWN')
    OR (
      p_status = 'SENT'
      AND coalesce(length(p_mid), 0) = 0
    )
  THEN
    RAISE EXCEPTION 'INVALID_RESULT';
END IF;

  IF v_row.status <> 'SENDING' THEN
    RETURN;
END IF;

SELECT * INTO v_conversation
FROM public.conversations
WHERE id = v_row.conversation_id
  AND company_id = p_company;

UPDATE private.han_outbox
SET status = p_status, provider_mid = p_mid
WHERE company_id = p_company
  AND request_id = p_request;

IF p_status = 'SENT' THEN
UPDATE public.interactions
SET external_ref =
        split_part(v_conversation.external_conversation_id, ':', 1)
            || ':' || p_mid
WHERE id = v_row.interaction_id;

UPDATE public.conversations
SET last_message_at = greatest(last_message_at, now())
WHERE id = v_row.conversation_id;
END IF;

  IF v_row.care_delivery_id IS NOT NULL THEN
UPDATE public.care_deliveries
SET
    status = CASE
                 WHEN p_status = 'SENT' THEN 'SENT'
                 WHEN p_status = 'FAILED' THEN 'FAILED'
                 ELSE 'PENDING'
        END,
    sent_at = CASE WHEN p_status = 'SENT' THEN now() END,
    external_message_ref = p_mid
WHERE id = v_row.care_delivery_id
  AND company_id = p_company;

IF p_status = 'SENT' THEN
UPDATE public.care_deliveries
SET status = 'DELIVERED', delivered_at = now()
WHERE id = v_row.care_delivery_id
  AND EXISTS (
    SELECT 1 FROM private.han_receipts r
    WHERE r.company_id = p_company
      AND r.external_identity =
          v_conversation.external_conversation_id
      AND p_mid = ANY(r.mids)
);

UPDATE public.care_deliveries
SET
    status = 'READ',
    delivered_at = coalesce(delivered_at, now())
WHERE id = v_row.care_delivery_id
  AND EXISTS (
    SELECT 1 FROM private.han_receipts r
    WHERE r.company_id = p_company
      AND r.external_identity =
          v_conversation.external_conversation_id
      AND r.kind = 'READ'
      AND r.watermark >=
          extract(epoch FROM v_row.created_at) * 1000
);
END IF;
END IF;

INSERT INTO public.audit_logs (
    company_id, user_id, action, resource_type,
    resource_id, customer_id, result
)
VALUES (
           p_company, v_row.actor_id,
           'MESSENGER_SEND_' || p_status,
           'Interaction', v_row.interaction_id,
           v_conversation.customer_id,
           CASE WHEN p_status = 'SENT' THEN 'SUCCESS' ELSE 'FAILED' END
       );
END;
$$;

CREATE FUNCTION public.han_receipt(
    p_company uuid,
    p_external text,
    p_key text,
    p_kind text,
    p_mids text[],
    p_watermark bigint
)
    RETURNS void
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_kind NOT IN ('DELIVERY', 'READ') THEN
    RAISE EXCEPTION 'INVALID_KIND';
END IF;

INSERT INTO private.han_receipts
VALUES (
           p_company, p_external, p_key,
           p_kind, p_mids, p_watermark, now()
       )
    ON CONFLICT DO NOTHING;

UPDATE public.care_deliveries d
SET
    delivered_at = coalesce(d.delivered_at, now()),
    status = CASE
                 WHEN d.status IN ('RESPONDED', 'CONVERTED_TO_SALE')
                     THEN d.status
                 WHEN p_kind = 'READ' OR d.status = 'READ'
                     THEN 'READ'
                 ELSE 'DELIVERED'
        END
    FROM private.han_outbox o
  JOIN public.conversations c
ON c.id = o.conversation_id
    AND c.company_id = o.company_id
WHERE d.id = o.care_delivery_id
  AND d.company_id = p_company
  AND o.company_id = p_company
  AND c.external_conversation_id = p_external
  AND o.status = 'SENT'
  AND (
    o.provider_mid = ANY(p_mids)
   OR (
    p_watermark IS NOT NULL
  AND extract(epoch FROM o.created_at) * 1000 <= p_watermark
    )
    );
END;
$$;

CREATE FUNCTION public.han_care_stats(
    p_company uuid,
    p_campaign uuid
)
    RETURNS jsonb
    LANGUAGE sql
    SECURITY DEFINER
SET search_path = ''
AS $$
SELECT jsonb_build_object(
               'sent', count(*) FILTER (WHERE sent_at IS NOT NULL),
               'delivered', count(*) FILTER (WHERE delivered_at IS NOT NULL),
               'responded', count(*) FILTER (WHERE responded_at IS NOT NULL),
               'converted_to_sale',
               count(*) FILTER (WHERE converted_to_sale_at IS NOT NULL),
               'failed', count(*) FILTER (WHERE status = 'FAILED'),
               'pending', count(*) FILTER (WHERE status = 'PENDING')
       )
FROM public.care_deliveries
WHERE company_id = p_company
  AND campaign_id = p_campaign
  AND channel = 'FACEBOOK';
$$;

CREATE FUNCTION public.han_message_states(
    p_company uuid,
    p_conversation uuid,
    p_ids uuid[]
)
    RETURNS TABLE(interaction_id uuid, status text)
    LANGUAGE sql
    SECURITY DEFINER
SET search_path = ''
AS $$
SELECT
    o.interaction_id,
    CASE
        WHEN o.status = 'SENDING'
            AND o.created_at < now() - interval '2 minutes'
        THEN 'UNKNOWN'
        ELSE o.status
END
FROM private.han_outbox o
  WHERE o.company_id = p_company
    AND o.conversation_id = p_conversation
    AND o.interaction_id = ANY(p_ids);
$$;

CREATE FUNCTION public.han_mark_read(
    p_company uuid,
    p_conversation uuid,
    p_actor uuid,
    p_seen uuid
)
    RETURNS integer
    LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
v_seen public.interactions%ROWTYPE;
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members m
    JOIN public.user_profiles u ON u.id = m.user_id
    WHERE m.company_id = p_company
      AND m.user_id = p_actor
      AND m.status = 'ACTIVE'
      AND u.status = 'ACTIVE'
      AND m.role IN ('BOSS_ADMIN', 'SALE')
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED';
END IF;

  PERFORM 1
  FROM public.conversations
  WHERE company_id = p_company
    AND id = p_conversation
    AND channel = 'FACEBOOK'
  FOR UPDATE;

IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
END IF;

SELECT * INTO v_seen
FROM public.interactions
WHERE id = p_seen
  AND company_id = p_company
  AND conversation_id = p_conversation;

IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
END IF;

SELECT count(*) INTO v_count
FROM public.interactions
WHERE company_id = p_company
  AND conversation_id = p_conversation
  AND direction = 'INBOUND'
  AND (created_at, id) > (v_seen.created_at, v_seen.id);

UPDATE public.conversations
SET unread_count = v_count
WHERE id = p_conversation
  AND company_id = p_company;

RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION
    public.han_rate_limit(uuid,text),
    public.han_ingest(uuid,text,text,text,text,text,text,text,text,timestamptz,jsonb),
    public.han_prepare_send(uuid,uuid,uuid,uuid,text,text,text,uuid),
    public.han_finish_send(uuid,uuid,text,text),
    public.han_receipt(uuid,text,text,text,text[],bigint),
    public.han_care_stats(uuid,uuid),
    public.han_message_states(uuid,uuid,uuid[]),
    public.han_mark_read(uuid,uuid,uuid,uuid)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.han_rate_limit(uuid,text),
  public.han_ingest(uuid,text,text,text,text,text,text,text,text,timestamptz,jsonb),
  public.han_prepare_send(uuid,uuid,uuid,uuid,text,text,text,uuid),
  public.han_finish_send(uuid,uuid,text,text),
  public.han_receipt(uuid,text,text,text,text[],bigint),
  public.han_care_stats(uuid,uuid),
  public.han_message_states(uuid,uuid,uuid[]),
  public.han_mark_read(uuid,uuid,uuid,uuid)
TO service_role;

COMMIT;