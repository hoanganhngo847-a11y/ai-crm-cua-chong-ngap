-- ==============================================================================
-- Migration: 20260929120003_zalo_round3_remediation.sql
-- Module: Omnichannel Zalo OA & Zalo Care (Member 3 — feature/zalo-care)
-- Remediates review round 3 (HEAD f480407):
--   #2  FAILED ingress events are re-claimable (claim token + lease state machine)
--   #3  Ingress is ONE PostgreSQL transaction (claim-token verified, no JS compensation)
--   #4  Outbound actor verified again inside the DB (active membership + SALE/BOSS_ADMIN)
--   #5  Stable command_id idempotency, UNIQUE(company_id, channel, command_id), fail-closed claim
--   #6  Provider result recorded before finalize; finalize is idempotent and never resends
--   #8  OA secrets live only in private schema, read/rotated via service-role RPCs, audited
--   #9  Care deliveries claimed atomically (schedule + campaign), attempt limit, uncertain policy
--   #13 Canonical namespaced external_ref zalo:{company}:{oa}:{provider_msg_id} everywhere
--
-- Also fixes defects in 20260927000001 that made its RPCs unusable against the Foundation
-- schema (care_deliveries.campaign_id NOT NULL, missing SENDING status, unknown columns,
-- private schema not exposed through PostgREST).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 0. Drop superseded RPC signatures from 20260927000001
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.zalo_claim_ingress_event(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.zalo_process_ingress_message(uuid, text, text, text, text, text, text, text, text, boolean, text, text, jsonb, bigint);
DROP FUNCTION IF EXISTS public.zalo_finalize_outbound_reply(uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.care_scheduler_claim_delivery(uuid, uuid, uuid, date, text);

-- ==============================================================================
-- 1. SECRET STORAGE (#8)
-- ==============================================================================
ALTER TABLE private.zalo_oa_secrets
  ADD COLUMN IF NOT EXISTS webhook_secret text,
  ADD COLUMN IF NOT EXISTS refresh_lease_token uuid,
  ADD COLUMN IF NOT EXISTS refresh_lease_until timestamptz;

-- The previous token store could not reach the private schema through PostgREST and
-- silently wrote rotated tokens to public.zalo_oa_configs only. Move the newest copy
-- into private before the plaintext columns are dropped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'zalo_oa_configs' AND column_name = 'app_secret'
  ) THEN
    EXECUTE $sql$
      INSERT INTO private.zalo_oa_secrets AS s
        (company_id, oa_id, app_secret, access_token, refresh_token, token_expires_at, token_version)
      SELECT company_id, oa_id, app_secret, access_token, refresh_token, token_expires_at, token_version
      FROM public.zalo_oa_configs
      ON CONFLICT (company_id, oa_id) DO UPDATE
        SET app_secret = EXCLUDED.app_secret,
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            token_expires_at = EXCLUDED.token_expires_at,
            token_version = EXCLUDED.token_version,
            updated_at = now()
        WHERE EXCLUDED.token_version >= s.token_version
    $sql$;
  END IF;
END $$;

UPDATE public.zalo_oa_configs c
SET secret_ref_id = s.id
FROM private.zalo_oa_secrets s
WHERE c.company_id = s.company_id AND c.oa_id = s.oa_id AND c.secret_ref_id IS NULL;

ALTER TABLE public.zalo_oa_configs
  DROP COLUMN IF EXISTS app_secret,
  DROP COLUMN IF EXISTS access_token,
  DROP COLUMN IF EXISTS refresh_token,
  DROP COLUMN IF EXISTS token_expires_at,
  DROP COLUMN IF EXISTS token_version;

REVOKE ALL ON private.zalo_oa_secrets FROM PUBLIC, anon, authenticated, service_role;

-- Tenant resolution for a verified webhook. Returns nothing for unknown / inactive OA.
CREATE OR REPLACE FUNCTION public.zalo_resolve_oa_tenant(p_oa_id text)
RETURNS TABLE (company_id uuid, app_id text, webhook_secret text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.company_id, c.app_id, s.webhook_secret
  FROM public.zalo_oa_configs c
  JOIN public.companies co ON co.id = c.company_id AND co.status = 'ACTIVE'
  LEFT JOIN private.zalo_oa_secrets s ON s.company_id = c.company_id AND s.oa_id = c.oa_id
  WHERE c.oa_id = p_oa_id
    AND c.status = 'ACTIVE';
$$;

CREATE OR REPLACE FUNCTION public.zalo_get_oa_credentials(p_company_id uuid, p_oa_id text)
RETURNS TABLE (
  config_id uuid,
  company_id uuid,
  oa_id text,
  app_id text,
  app_secret text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  token_version integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.company_id, c.oa_id, c.app_id, s.app_secret, s.access_token, s.refresh_token,
         s.token_expires_at, s.token_version
  FROM public.zalo_oa_configs c
  JOIN public.companies co ON co.id = c.company_id AND co.status = 'ACTIVE'
  JOIN private.zalo_oa_secrets s ON s.company_id = c.company_id AND s.oa_id = c.oa_id
  WHERE c.company_id = p_company_id
    AND c.oa_id = p_oa_id
    AND c.status = 'ACTIVE';
$$;

-- Single-flight refresh: Zalo refresh tokens are single-use, so only the lease holder
-- may call the OAuth endpoint.
CREATE OR REPLACE FUNCTION public.zalo_begin_token_refresh(
  p_company_id uuid,
  p_oa_id text,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  acquired boolean,
  lease_token uuid,
  token_version integer,
  app_id text,
  app_secret text,
  refresh_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_app_id text;
  v_secret record;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT c.app_id INTO v_app_id
  FROM public.zalo_oa_configs c
  WHERE c.company_id = p_company_id AND c.oa_id = p_oa_id AND c.status = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZALO_OA_NOT_CONFIGURED' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.* INTO v_secret
  FROM private.zalo_oa_secrets s
  WHERE s.company_id = p_company_id AND s.oa_id = p_oa_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZALO_OA_SECRET_MISSING' USING ERRCODE = 'P0002';
  END IF;

  IF v_secret.refresh_lease_until IS NOT NULL AND v_secret.refresh_lease_until > now() THEN
    RETURN QUERY SELECT false, NULL::uuid, v_secret.token_version, v_app_id, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE private.zalo_oa_secrets s
  SET refresh_lease_token = v_token,
      refresh_lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 60), 10)),
      updated_at = now()
  WHERE s.id = v_secret.id;

  RETURN QUERY SELECT true, v_token, v_secret.token_version, v_app_id, v_secret.app_secret, v_secret.refresh_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.zalo_complete_token_refresh(
  p_company_id uuid,
  p_oa_id text,
  p_lease_token uuid,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret record;
  v_config_id uuid;
  v_new_version integer;
BEGIN
  IF coalesce(p_access_token, '') = '' OR coalesce(p_refresh_token, '') = '' THEN
    RAISE EXCEPTION 'ZALO_TOKEN_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT s.* INTO v_secret
  FROM private.zalo_oa_secrets s
  WHERE s.company_id = p_company_id AND s.oa_id = p_oa_id
  FOR UPDATE;
  IF NOT FOUND OR v_secret.refresh_lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'ZALO_TOKEN_LEASE_LOST' USING ERRCODE = '40001';
  END IF;

  v_new_version := v_secret.token_version + 1;

  UPDATE private.zalo_oa_secrets s
  SET access_token = p_access_token,
      refresh_token = p_refresh_token,
      token_expires_at = p_expires_at,
      token_version = v_new_version,
      refresh_lease_token = NULL,
      refresh_lease_until = NULL,
      updated_at = now()
  WHERE s.id = v_secret.id;

  SELECT c.id INTO v_config_id
  FROM public.zalo_oa_configs c
  WHERE c.company_id = p_company_id AND c.oa_id = p_oa_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, resource_type, resource_id, result, metadata)
  VALUES (
    p_company_id, NULL, 'ZALO_OA_TOKEN_ROTATED', 'ZALO_OA_CONFIG', coalesce(v_config_id, v_secret.id), 'SUCCESS',
    jsonb_build_object('oa_id', p_oa_id, 'token_version', v_new_version)
  );

  RETURN v_new_version;
END;
$$;

CREATE OR REPLACE FUNCTION public.zalo_abort_token_refresh(
  p_company_id uuid,
  p_oa_id text,
  p_lease_token uuid,
  p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret_id uuid;
  v_config_id uuid;
BEGIN
  UPDATE private.zalo_oa_secrets s
  SET refresh_lease_token = NULL,
      refresh_lease_until = NULL,
      updated_at = now()
  WHERE s.company_id = p_company_id
    AND s.oa_id = p_oa_id
    AND s.refresh_lease_token = p_lease_token
  RETURNING s.id INTO v_secret_id;

  IF v_secret_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT c.id INTO v_config_id
  FROM public.zalo_oa_configs c
  WHERE c.company_id = p_company_id AND c.oa_id = p_oa_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, resource_type, resource_id, result, metadata)
  VALUES (
    p_company_id, NULL, 'ZALO_OA_TOKEN_ROTATED', 'ZALO_OA_CONFIG', coalesce(v_config_id, v_secret_id), 'FAILED',
    jsonb_build_object('oa_id', p_oa_id, 'error_code', left(coalesce(p_error_code, 'UNKNOWN'), 100))
  );
  RETURN true;
END;
$$;

-- OA connection management (BOSS_ADMIN via trusted server action). Secrets never leave
-- the private schema; the audit row carries only non-secret metadata.
CREATE OR REPLACE FUNCTION public.zalo_upsert_oa_connection(
  p_company_id uuid,
  p_oa_id text,
  p_app_id text,
  p_app_secret text,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz,
  p_webhook_secret text,
  p_actor_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
  v_secret_id uuid;
  v_config_id uuid;
BEGIN
  IF coalesce(btrim(p_oa_id), '') = '' OR coalesce(btrim(p_app_id), '') = '' OR coalesce(p_app_secret, '') = '' THEN
    RAISE EXCEPTION 'ZALO_OA_CONNECTION_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members m
    JOIN public.user_profiles up ON up.id = m.user_id AND up.status = 'ACTIVE'
    WHERE m.company_id = p_company_id
      AND m.user_id = p_actor_user_id
      AND m.status = 'ACTIVE'
      AND m.role = 'BOSS_ADMIN'
  ) THEN
    RAISE EXCEPTION 'ZALO_OA_CONNECTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT c.company_id INTO v_owner FROM public.zalo_oa_configs c WHERE c.oa_id = p_oa_id;
  IF v_owner IS NOT NULL AND v_owner <> p_company_id THEN
    RAISE EXCEPTION 'ZALO_OA_OWNED_BY_OTHER_COMPANY' USING ERRCODE = '42501';
  END IF;

  INSERT INTO private.zalo_oa_secrets AS s
    (company_id, oa_id, app_secret, access_token, refresh_token, token_expires_at, webhook_secret)
  VALUES
    (p_company_id, p_oa_id, p_app_secret, p_access_token, p_refresh_token, p_token_expires_at, p_webhook_secret)
  ON CONFLICT (company_id, oa_id) DO UPDATE
    SET app_secret = EXCLUDED.app_secret,
        access_token = coalesce(EXCLUDED.access_token, s.access_token),
        refresh_token = coalesce(EXCLUDED.refresh_token, s.refresh_token),
        token_expires_at = coalesce(EXCLUDED.token_expires_at, s.token_expires_at),
        webhook_secret = coalesce(EXCLUDED.webhook_secret, s.webhook_secret),
        token_version = s.token_version + 1,
        refresh_lease_token = NULL,
        refresh_lease_until = NULL,
        updated_at = now()
  RETURNING s.id INTO v_secret_id;

  INSERT INTO public.zalo_oa_configs AS c (company_id, oa_id, app_id, status, secret_ref_id)
  VALUES (p_company_id, p_oa_id, p_app_id, 'ACTIVE', v_secret_id)
  ON CONFLICT (company_id, oa_id) DO UPDATE
    SET app_id = EXCLUDED.app_id,
        status = 'ACTIVE',
        secret_ref_id = EXCLUDED.secret_ref_id,
        updated_at = now()
  RETURNING c.id INTO v_config_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, resource_type, resource_id, result, metadata)
  VALUES (
    p_company_id, p_actor_user_id, 'ZALO_OA_CONNECTION_UPSERTED', 'ZALO_OA_CONFIG', v_config_id, 'SUCCESS',
    jsonb_build_object(
      'oa_id', p_oa_id,
      'app_id', p_app_id,
      'access_token_rotated', p_access_token IS NOT NULL,
      'refresh_token_rotated', p_refresh_token IS NOT NULL,
      'webhook_secret_rotated', p_webhook_secret IS NOT NULL
    )
  );

  RETURN v_config_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.zalo_set_oa_connection_status(
  p_company_id uuid,
  p_oa_id text,
  p_status text,
  p_actor_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_config_id uuid;
BEGIN
  IF p_status NOT IN ('ACTIVE', 'INACTIVE', 'SUSPENDED') THEN
    RAISE EXCEPTION 'ZALO_OA_STATUS_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members m
    JOIN public.user_profiles up ON up.id = m.user_id AND up.status = 'ACTIVE'
    WHERE m.company_id = p_company_id
      AND m.user_id = p_actor_user_id
      AND m.status = 'ACTIVE'
      AND m.role = 'BOSS_ADMIN'
  ) THEN
    RAISE EXCEPTION 'ZALO_OA_CONNECTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  UPDATE public.zalo_oa_configs c
  SET status = p_status, updated_at = now()
  WHERE c.company_id = p_company_id AND c.oa_id = p_oa_id
  RETURNING c.id INTO v_config_id;

  IF v_config_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.audit_logs (company_id, user_id, action, resource_type, resource_id, result, metadata)
  VALUES (
    p_company_id, p_actor_user_id, 'ZALO_OA_CONNECTION_STATUS_CHANGED', 'ZALO_OA_CONFIG', v_config_id, 'SUCCESS',
    jsonb_build_object('oa_id', p_oa_id, 'status', p_status)
  );
  RETURN true;
END;
$$;

-- ==============================================================================
-- 2. SHARED PRIVATE HELPERS
-- ==============================================================================

-- Per (company, Zalo user) serialization for ingress/outbound finalize so concurrent
-- first messages from the same user never race on customer/identity/conversation.
CREATE OR REPLACE FUNCTION private.zalo_lock_user(p_company_id uuid, p_zalo_uid text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':ZALO:' || p_zalo_uid, 0)
  );
$$;

-- Resolves the OA a customer talks to: last inbound OA seen for the customer, else the
-- company's only ACTIVE OA. NULL when ambiguous or not configured.
CREATE OR REPLACE FUNCTION private.zalo_resolve_customer_oa(p_company_id uuid, p_customer_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_oa text;
  v_count integer;
BEGIN
  SELECT r.source_metadata ->> 'oa_id' INTO v_oa
  FROM public.interactions i
  JOIN private.interaction_raw_contents r ON r.interaction_id = i.id
  JOIN public.zalo_oa_configs c
    ON c.company_id = i.company_id AND c.oa_id = r.source_metadata ->> 'oa_id' AND c.status = 'ACTIVE'
  WHERE i.company_id = p_company_id
    AND i.customer_id = p_customer_id
    AND i.channel = 'ZALO'
  ORDER BY i.created_at DESC
  LIMIT 1;

  IF v_oa IS NOT NULL THEN
    RETURN v_oa;
  END IF;

  SELECT count(*), min(c.oa_id) INTO v_count, v_oa
  FROM public.zalo_oa_configs c
  WHERE c.company_id = p_company_id AND c.status = 'ACTIVE';

  IF v_count = 1 THEN
    RETURN v_oa;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.zalo_lock_user(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.zalo_resolve_customer_oa(uuid, uuid) FROM PUBLIC;

-- ==============================================================================
-- 3. INGRESS STATE MACHINE + ATOMIC PIPELINE (#2, #3, #13)
-- ==============================================================================
ALTER TABLE public.zalo_ingress_events
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

CREATE OR REPLACE FUNCTION public.zalo_claim_ingress_event(
  p_company_id uuid,
  p_oa_id text,
  p_external_ref text,
  p_event_name text,
  p_sender_id text,
  p_recipient_id text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (claim_status text, event_id uuid, retry_count integer, claim_token uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_row public.zalo_ingress_events%ROWTYPE;
  v_token uuid := gen_random_uuid();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
BEGIN
  IF p_company_id IS NULL OR coalesce(p_oa_id, '') = '' OR coalesce(p_external_ref, '') = '' THEN
    RAISE EXCEPTION 'ZALO_INGRESS_INVALID_CLAIM' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.zalo_ingress_events AS e
    (company_id, oa_id, external_ref, event_name, sender_id, recipient_id, status, lease_until, retry_count, claim_token)
  VALUES
    (p_company_id, p_oa_id, p_external_ref, coalesce(p_event_name, 'unknown'), p_sender_id, p_recipient_id,
     'CLAIMED', now() + v_lease, 0, v_token)
  ON CONFLICT ON CONSTRAINT uq_zalo_ingress_events_claim DO NOTHING
  RETURNING e.* INTO v_row;

  IF v_row.id IS NOT NULL THEN
    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, 0, v_token;
    RETURN;
  END IF;

  SELECT e.* INTO v_row
  FROM public.zalo_ingress_events e
  WHERE e.company_id = p_company_id AND e.oa_id = p_oa_id AND e.external_ref = p_external_ref
  FOR UPDATE;

  IF v_row.status = 'PROCESSED' THEN
    RETURN QUERY SELECT 'DUPLICATE'::text, v_row.id, v_row.retry_count, NULL::uuid;
    RETURN;
  END IF;

  IF v_row.status = 'FAILED'
     OR (v_row.status = 'CLAIMED' AND (v_row.lease_until IS NULL OR v_row.lease_until < now())) THEN
    UPDATE public.zalo_ingress_events e
    SET status = 'CLAIMED',
        retry_count = e.retry_count + 1,
        lease_until = now() + v_lease,
        claim_token = v_token,
        updated_at = now()
    WHERE e.id = v_row.id;

    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_row.retry_count + 1, v_token;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'BUSY'::text, v_row.id, v_row.retry_count, NULL::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.zalo_fail_ingress_event(
  p_event_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.zalo_ingress_events e
  SET status = 'FAILED',
      lease_until = NULL,
      claim_token = NULL,
      last_error = left(coalesce(p_error, 'UNKNOWN'), 500),
      updated_at = now()
  WHERE e.id = p_event_id
    AND e.status = 'CLAIMED'
    AND e.claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

-- Verifies the caller still owns the claim and locks the ingress row for this transaction.
CREATE OR REPLACE FUNCTION private.zalo_lock_owned_ingress_event(
  p_event_id uuid,
  p_claim_token uuid,
  p_company_id uuid,
  p_oa_id text,
  p_external_ref text
)
RETURNS public.zalo_ingress_events
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_event public.zalo_ingress_events%ROWTYPE;
BEGIN
  SELECT e.* INTO v_event
  FROM public.zalo_ingress_events e
  WHERE e.id = p_event_id
  FOR UPDATE;

  IF v_event.id IS NULL
     OR v_event.company_id <> p_company_id
     OR v_event.oa_id <> p_oa_id
     OR v_event.external_ref <> p_external_ref THEN
    RAISE EXCEPTION 'ZALO_INGRESS_EVENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  IF v_event.status <> 'PROCESSED'
     AND (v_event.status <> 'CLAIMED' OR v_event.claim_token IS DISTINCT FROM p_claim_token) THEN
    RAISE EXCEPTION 'ZALO_INGRESS_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;

  RETURN v_event;
END;
$$;

REVOKE ALL ON FUNCTION private.zalo_lock_owned_ingress_event(uuid, uuid, uuid, text, text) FROM PUBLIC;

-- ONE transaction: customer/identity + conversation + interaction + private raw
-- + care response/opt-out + ingress PROCESSED. Any failure rolls back everything.
CREATE OR REPLACE FUNCTION public.zalo_process_ingress_message(
  p_event_id uuid,
  p_claim_token uuid,
  p_company_id uuid,
  p_oa_id text,
  p_external_ref text,
  p_raw_msg_id text,
  p_zalo_user_uid text,
  p_user_name text,
  p_event_name text,
  p_sender_id text,
  p_recipient_id text,
  p_is_inbound boolean,
  p_sanitized_content text,
  p_raw_content text,
  p_raw_payload jsonb,
  p_event_at timestamptz,
  p_opt_out boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.zalo_ingress_events%ROWTYPE;
  v_event_at timestamptz := least(coalesce(p_event_at, now()), now());
  v_customer_id uuid;
  v_conv record;
  v_conversation_id uuid;
  v_conversation_customer_id uuid;
  v_interaction_id uuid;
  v_existing record;
  v_is_new_customer boolean := false;
  v_care_delivery_id uuid;
  v_schedule_id uuid;
BEGIN
  IF coalesce(p_zalo_user_uid, '') = '' THEN
    RAISE EXCEPTION 'ZALO_INGRESS_MISSING_USER' USING ERRCODE = '22023';
  END IF;

  v_event := private.zalo_lock_owned_ingress_event(p_event_id, p_claim_token, p_company_id, p_oa_id, p_external_ref);

  IF v_event.status = 'PROCESSED' THEN
    SELECT i.id, i.customer_id, i.conversation_id INTO v_existing
    FROM public.interactions i WHERE i.id = v_event.interaction_id;
    RETURN jsonb_build_object(
      'duplicate', true,
      'interaction_id', v_existing.id,
      'customer_id', v_existing.customer_id,
      'conversation_id', v_existing.conversation_id,
      'is_new_customer', false
    );
  END IF;

  PERFORM private.zalo_lock_user(p_company_id, p_zalo_user_uid);

  -- Canonical ref already recorded (e.g. outbound finalize wrote our own message
  -- before Zalo echoed it back as oa_send_*): link, do not duplicate.
  SELECT i.id, i.customer_id, i.conversation_id INTO v_existing
  FROM public.interactions i
  WHERE i.company_id = p_company_id AND i.channel = 'ZALO' AND i.external_ref = p_external_ref;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.zalo_ingress_events e
    SET status = 'PROCESSED', interaction_id = v_existing.id, lease_until = NULL, claim_token = NULL,
        processed_at = now(), updated_at = now()
    WHERE e.id = p_event_id;

    RETURN jsonb_build_object(
      'duplicate', true,
      'interaction_id', v_existing.id,
      'customer_id', v_existing.customer_id,
      'conversation_id', v_existing.conversation_id,
      'is_new_customer', false
    );
  END IF;

  -- 1. Customer + Identity
  SELECT i.customer_id INTO v_customer_id
  FROM public.identities i
  WHERE i.company_id = p_company_id AND i.channel = 'ZALO' AND i.external_id = p_zalo_user_uid;

  IF v_customer_id IS NULL THEN
    v_is_new_customer := true;
    INSERT INTO public.customers (company_id, name, source, stage)
    VALUES (
      p_company_id,
      coalesce(nullif(btrim(p_user_name), ''), 'Khách Zalo ' || right(p_zalo_user_uid, 4)),
      'ZALO_OA',
      'LEAD_NEW'
    )
    RETURNING id INTO v_customer_id;

    INSERT INTO public.identities (company_id, customer_id, channel, external_id, verified, metadata)
    VALUES (p_company_id, v_customer_id, 'ZALO', p_zalo_user_uid, false,
            jsonb_build_object('source', 'ZALO_OA', 'oa_id', p_oa_id));
  END IF;

  -- 2. Conversation (row lock; unread/status mutation is part of this transaction)
  SELECT c.id, c.customer_id INTO v_conv
  FROM public.conversations c
  WHERE c.company_id = p_company_id AND c.channel = 'ZALO' AND c.external_conversation_id = p_zalo_user_uid
  FOR UPDATE;

  IF v_conv.id IS NOT NULL THEN
    v_conversation_id := v_conv.id;
    v_conversation_customer_id := v_conv.customer_id;
    UPDATE public.conversations c
    SET last_message_at = greatest(c.last_message_at, v_event_at),
        unread_count = c.unread_count + CASE WHEN p_is_inbound THEN 1 ELSE 0 END,
        status = CASE WHEN p_is_inbound AND c.status = 'CLOSED' THEN 'OPEN' ELSE c.status END
    WHERE c.id = v_conv.id;
  ELSE
    INSERT INTO public.conversations (company_id, customer_id, channel, external_conversation_id, last_message_at, unread_count, status)
    VALUES (p_company_id, v_customer_id, 'ZALO', p_zalo_user_uid, v_event_at,
            CASE WHEN p_is_inbound THEN 1 ELSE 0 END, 'OPEN')
    RETURNING id INTO v_conversation_id;
    v_conversation_customer_id := v_customer_id;
  END IF;

  -- 3. Public sanitized interaction with canonical namespaced external_ref
  INSERT INTO public.interactions (
    company_id, customer_id, conversation_id, channel, type, direction,
    sanitized_content, sanitization_status, sanitized_at, sanitizer_version,
    external_ref, actor_type, actor_user_id, created_at
  ) VALUES (
    p_company_id, v_conversation_customer_id, v_conversation_id, 'ZALO', 'MESSAGE',
    CASE WHEN p_is_inbound THEN 'INBOUND' ELSE 'OUTBOUND' END,
    p_sanitized_content, 'SUCCEEDED', now(), 'zalo-sanitizer-v1',
    p_external_ref,
    CASE WHEN p_is_inbound THEN 'CUSTOMER' ELSE 'SALE' END,
    NULL, v_event_at
  )
  RETURNING id INTO v_interaction_id;

  -- 4. Private raw zone (provider message id lives only in source_metadata)
  INSERT INTO private.interaction_raw_contents (interaction_id, company_id, raw_content, raw_payload, source_metadata)
  VALUES (
    v_interaction_id, p_company_id, p_raw_content, coalesce(p_raw_payload, '{}'::jsonb),
    jsonb_build_object(
      'oa_id', p_oa_id,
      'sender_id', p_sender_id,
      'recipient_id', p_recipient_id,
      'event_name', p_event_name,
      'event_at', v_event_at,
      'provider_msg_id', p_raw_msg_id,
      'origin', CASE WHEN p_is_inbound THEN 'ZALO_USER' ELSE 'ZALO_OA_CONSOLE' END
    )
  );

  -- 5. Care side effects (inbound only)
  IF p_is_inbound THEN
    SELECT d.id INTO v_care_delivery_id
    FROM public.care_deliveries d
    WHERE d.company_id = p_company_id
      AND d.customer_id = v_conversation_customer_id
      AND d.channel = 'ZALO'
      AND d.status IN ('SENT', 'DELIVERED', 'READ')
      AND d.sent_at >= v_event_at - interval '30 days'
    ORDER BY d.sent_at DESC
    LIMIT 1
    FOR UPDATE;

    IF v_care_delivery_id IS NOT NULL THEN
      UPDATE public.care_deliveries d
      SET status = 'RESPONDED',
          responded_at = v_event_at,
          delivered_at = coalesce(d.delivered_at, v_event_at)
      WHERE d.id = v_care_delivery_id;
    END IF;

    IF p_opt_out THEN
      INSERT INTO public.care_schedules AS s (company_id, customer_id, channel, frequency_months, next_send_at, enabled, stop_reason)
      VALUES (p_company_id, v_conversation_customer_id, 'ZALO', 1, now(), false, 'CUSTOMER_OPT_OUT')
      ON CONFLICT ON CONSTRAINT uq_cs_customer_channel DO UPDATE
        SET enabled = false, stop_reason = 'CUSTOMER_OPT_OUT'
      RETURNING s.id INTO v_schedule_id;

      INSERT INTO public.audit_logs (company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
      VALUES (p_company_id, NULL, 'CARE_SCHEDULE_STOPPED', 'CARE_SCHEDULE', v_schedule_id, v_conversation_customer_id,
              'SUCCESS', jsonb_build_object('channel', 'ZALO', 'stop_reason', 'CUSTOMER_OPT_OUT', 'interaction_id', v_interaction_id));
    END IF;
  END IF;

  -- 6. Ingress PROCESSED in the same transaction
  UPDATE public.zalo_ingress_events e
  SET status = 'PROCESSED', interaction_id = v_interaction_id, lease_until = NULL, claim_token = NULL,
      last_error = NULL, processed_at = now(), updated_at = now()
  WHERE e.id = p_event_id;

  RETURN jsonb_build_object(
    'duplicate', false,
    'customer_id', v_conversation_customer_id,
    'conversation_id', v_conversation_id,
    'interaction_id', v_interaction_id,
    'is_new_customer', v_is_new_customer,
    'care_delivery_responded_id', v_care_delivery_id,
    'opted_out', coalesce(p_opt_out AND p_is_inbound, false)
  );
END;
$$;

-- Delivery receipts, seen receipts, follow/unfollow. Same claim-token discipline.
CREATE OR REPLACE FUNCTION public.zalo_process_ingress_status_event(
  p_event_id uuid,
  p_claim_token uuid,
  p_company_id uuid,
  p_oa_id text,
  p_external_ref text,
  p_kind text,
  p_zalo_user_uid text,
  p_provider_msg_ids text[],
  p_event_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.zalo_ingress_events%ROWTYPE;
  v_event_at timestamptz := least(coalesce(p_event_at, now()), now());
  v_updated integer := 0;
  v_customer_id uuid;
  v_schedule_id uuid;
  v_already_stopped boolean;
BEGIN
  IF p_kind NOT IN ('DELIVERED', 'READ', 'FOLLOW', 'UNFOLLOW') THEN
    RAISE EXCEPTION 'ZALO_STATUS_EVENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_event := private.zalo_lock_owned_ingress_event(p_event_id, p_claim_token, p_company_id, p_oa_id, p_external_ref);
  IF v_event.status = 'PROCESSED' THEN
    RETURN jsonb_build_object('duplicate', true, 'updated', 0);
  END IF;

  IF p_kind = 'DELIVERED' AND coalesce(array_length(p_provider_msg_ids, 1), 0) > 0 THEN
    UPDATE public.care_deliveries d
    SET delivered_at = coalesce(d.delivered_at, v_event_at),
        status = CASE WHEN d.status = 'SENT' THEN 'DELIVERED' ELSE d.status END
    WHERE d.company_id = p_company_id
      AND d.channel = 'ZALO'
      AND d.external_message_ref = ANY (p_provider_msg_ids)
      AND d.status IN ('SENT', 'DELIVERED', 'READ', 'RESPONDED', 'CONVERTED_TO_SALE')
      AND d.delivered_at IS NULL;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF p_kind = 'READ' AND coalesce(array_length(p_provider_msg_ids, 1), 0) > 0 THEN
    UPDATE public.care_deliveries d
    SET delivered_at = coalesce(d.delivered_at, v_event_at),
        status = CASE WHEN d.status IN ('SENT', 'DELIVERED') THEN 'READ' ELSE d.status END
    WHERE d.company_id = p_company_id
      AND d.channel = 'ZALO'
      AND d.external_message_ref = ANY (p_provider_msg_ids)
      AND d.status IN ('SENT', 'DELIVERED');
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF p_kind = 'UNFOLLOW' AND coalesce(p_zalo_user_uid, '') <> '' THEN
    SELECT i.customer_id INTO v_customer_id
    FROM public.identities i
    WHERE i.company_id = p_company_id AND i.channel = 'ZALO' AND i.external_id = p_zalo_user_uid;

    IF v_customer_id IS NOT NULL THEN
      SELECT NOT s.enabled INTO v_already_stopped
      FROM public.care_schedules s
      WHERE s.company_id = p_company_id AND s.customer_id = v_customer_id AND s.channel = 'ZALO'
      FOR UPDATE;

      IF coalesce(v_already_stopped, false) = false THEN
        INSERT INTO public.care_schedules AS s (company_id, customer_id, channel, frequency_months, next_send_at, enabled, stop_reason)
        VALUES (p_company_id, v_customer_id, 'ZALO', 1, now(), false, 'ZALO_UNFOLLOWED')
        ON CONFLICT ON CONSTRAINT uq_cs_customer_channel DO UPDATE
          SET enabled = false, stop_reason = 'ZALO_UNFOLLOWED'
        RETURNING s.id INTO v_schedule_id;

        INSERT INTO public.audit_logs (company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
        VALUES (p_company_id, NULL, 'CARE_SCHEDULE_STOPPED', 'CARE_SCHEDULE', v_schedule_id, v_customer_id,
                'SUCCESS', jsonb_build_object('channel', 'ZALO', 'stop_reason', 'ZALO_UNFOLLOWED'));
        v_updated := 1;
      END IF;
    END IF;
  END IF;
  -- FOLLOW never re-enables a stopped schedule (PROJECT_MASTER §13).

  UPDATE public.zalo_ingress_events e
  SET status = 'PROCESSED', lease_until = NULL, claim_token = NULL, last_error = NULL,
      processed_at = now(), updated_at = now()
  WHERE e.id = p_event_id;

  RETURN jsonb_build_object('duplicate', false, 'updated', v_updated);
END;
$$;

-- ==============================================================================
-- 4. OUTBOUND OUTBOX (#4, #5, #6, #13)
-- ==============================================================================
ALTER TABLE public.zalo_outbound_deliveries
  ADD COLUMN IF NOT EXISTS oa_id text,
  ADD COLUMN IF NOT EXISTS actor_type text,
  ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS content_sha256 text,
  ADD COLUMN IF NOT EXISTS provider_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

ALTER TABLE public.zalo_outbound_deliveries DROP CONSTRAINT IF EXISTS zalo_outbound_deliveries_status_check;
ALTER TABLE public.zalo_outbound_deliveries
  ADD CONSTRAINT zalo_outbound_deliveries_status_check
  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'PROVIDER_SENT_PENDING_FINALIZE', 'PROVIDER_UNCERTAIN'));

ALTER TABLE public.zalo_outbound_deliveries DROP CONSTRAINT IF EXISTS chk_zalo_outbound_actor_type;
ALTER TABLE public.zalo_outbound_deliveries
  ADD CONSTRAINT chk_zalo_outbound_actor_type
  CHECK (actor_type IS NULL OR actor_type IN ('SALE', 'AI', 'SYSTEM'));

DROP INDEX IF EXISTS public.idx_zalo_outbound_command;
CREATE UNIQUE INDEX IF NOT EXISTS uq_zalo_outbound_command
  ON public.zalo_outbound_deliveries (company_id, channel, command_id)
  WHERE command_id IS NOT NULL;

-- Raw outbound text is sensitive (customer may be sent a phone number); keep it private.
CREATE TABLE IF NOT EXISTS private.zalo_outbound_payloads (
  delivery_id uuid PRIMARY KEY REFERENCES public.zalo_outbound_deliveries(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  raw_content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.zalo_outbound_payloads FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.zalo_outbound_payloads (delivery_id, company_id, raw_content)
SELECT d.id, d.company_id, d.content FROM public.zalo_outbound_deliveries d
ON CONFLICT (delivery_id) DO NOTHING;

-- public.zalo_outbound_deliveries.content now holds sanitized text only.
UPDATE public.zalo_outbound_deliveries d
SET content = regexp_replace(d.content, '(\+84|0)([ .-]*[0-9]){9,10}', '[SỐ ĐIỆN THOẠI ĐÃ ĐƯỢC BẢO VỆ]', 'g')
WHERE d.content ~ '(\+84|0)([ .-]*[0-9]){9,10}';

CREATE OR REPLACE FUNCTION public.zalo_claim_outbound_delivery(
  p_company_id uuid,
  p_conversation_id uuid,
  p_command_id text,
  p_actor_type text,
  p_actor_user_id uuid,
  p_raw_content text,
  p_sanitized_content text,
  p_content_sha256 text,
  p_oa_id text DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  claim_status text,
  delivery_id uuid,
  claim_token uuid,
  oa_id text,
  recipient_zalo_uid text,
  customer_id uuid,
  provider_msg_id text,
  interaction_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_conv record;
  v_oa text;
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_token uuid := gen_random_uuid();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
BEGIN
  IF coalesce(btrim(p_command_id), '') = '' OR length(p_command_id) > 200 THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_COMMAND_ID_INVALID' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_raw_content), '') = '' OR coalesce(p_content_sha256, '') = '' THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_CONTENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_actor_type NOT IN ('SALE', 'AI', 'SYSTEM') THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_ACTOR_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Defense in depth: a human send must come from an ACTIVE SALE/BOSS_ADMIN of this company.
  IF p_actor_type = 'SALE' THEN
    IF p_actor_user_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.company_members m
      JOIN public.user_profiles up ON up.id = m.user_id AND up.status = 'ACTIVE'
      WHERE m.company_id = p_company_id
        AND m.user_id = p_actor_user_id
        AND m.status = 'ACTIVE'
        AND m.role IN ('SALE', 'BOSS_ADMIN')
    ) THEN
      RAISE EXCEPTION 'ZALO_OUTBOUND_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF p_actor_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_ACTOR_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT c.id, c.customer_id, c.external_conversation_id INTO v_conv
  FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.company_id = p_company_id AND c.channel = 'ZALO';
  IF v_conv.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_oa_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.zalo_oa_configs c
      WHERE c.company_id = p_company_id AND c.oa_id = p_oa_id AND c.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'ZALO_OA_NOT_CONFIGURED' USING ERRCODE = 'P0002';
    END IF;
    v_oa := p_oa_id;
  ELSE
    v_oa := private.zalo_resolve_customer_oa(p_company_id, v_conv.customer_id);
  END IF;
  IF v_oa IS NULL THEN
    RAISE EXCEPTION 'ZALO_OA_NOT_CONFIGURED' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.zalo_outbound_deliveries AS d (
    company_id, conversation_id, customer_id, recipient_zalo_uid, idempotency_key, content,
    status, attempts, command_id, channel, lease_until, oa_id, actor_type, actor_user_id,
    claim_token, content_sha256
  ) VALUES (
    p_company_id, v_conv.id, v_conv.customer_id, v_conv.external_conversation_id,
    'zalo_out:' || p_company_id::text || ':' || p_command_id, p_sanitized_content,
    'SENDING', 1, p_command_id, 'ZALO', now() + v_lease, v_oa, p_actor_type, p_actor_user_id,
    v_token, p_content_sha256
  )
  ON CONFLICT DO NOTHING
  RETURNING d.* INTO v_row;

  IF v_row.id IS NOT NULL THEN
    INSERT INTO private.zalo_outbound_payloads (delivery_id, company_id, raw_content)
    VALUES (v_row.id, p_company_id, p_raw_content);

    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_oa, v_row.recipient_zalo_uid,
                        v_row.customer_id, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.* INTO v_row
  FROM public.zalo_outbound_deliveries d
  WHERE d.company_id = p_company_id AND d.channel = 'ZALO' AND d.command_id = p_command_id
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_COMMAND_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF v_row.conversation_id <> v_conv.id OR v_row.content_sha256 IS DISTINCT FROM p_content_sha256 THEN
    RETURN QUERY SELECT 'CONFLICT'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
    RETURN;
  END IF;

  IF v_row.status = 'SENT' THEN
    RETURN QUERY SELECT 'ALREADY_SENT'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, v_row.provider_msg_id, v_row.interaction_id;
    RETURN;
  END IF;

  IF v_row.status = 'PROVIDER_SENT_PENDING_FINALIZE' THEN
    RETURN QUERY SELECT 'PENDING_FINALIZE'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, v_row.provider_msg_id, NULL::uuid;
    RETURN;
  END IF;

  IF v_row.status IN ('FAILED', 'PENDING') THEN
    -- FAILED means the provider definitively did NOT accept the message: safe to resend.
    UPDATE public.zalo_outbound_deliveries d
    SET status = 'SENDING', attempts = d.attempts + 1, lease_until = now() + v_lease,
        claim_token = v_token, error_code = NULL, error_message = NULL, updated_at = now()
    WHERE d.id = v_row.id;

    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' AND v_row.lease_until IS NOT NULL AND v_row.lease_until > now() THEN
    RETURN QUERY SELECT 'BUSY'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                        v_row.customer_id, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' THEN
    -- Worker died mid-send: provider outcome unknown. Never auto-resend.
    UPDATE public.zalo_outbound_deliveries d
    SET status = 'PROVIDER_UNCERTAIN', lease_until = NULL,
        error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = now()
    WHERE d.id = v_row.id;
  END IF;

  RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, NULL::uuid, v_row.oa_id, v_row.recipient_zalo_uid,
                      v_row.customer_id, v_row.provider_msg_id, NULL::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.zalo_record_outbound_provider_result(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_msg_id text,
  p_error_code text,
  p_error_message text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_status text;
BEGIN
  IF p_outcome NOT IN ('ACCEPTED', 'REJECTED', 'UNCERTAIN') THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_OUTCOME_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT d.* INTO v_row FROM public.zalo_outbound_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;

  -- The claim holder knows the truth even if its lease expired and the row was
  -- pessimistically marked PROVIDER_UNCERTAIN meanwhile.
  IF v_row.id IS NULL
     OR v_row.claim_token IS DISTINCT FROM p_claim_token
     OR v_row.status NOT IN ('SENDING', 'PROVIDER_UNCERTAIN') THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;

  v_status := CASE p_outcome
    WHEN 'ACCEPTED' THEN 'PROVIDER_SENT_PENDING_FINALIZE'
    WHEN 'REJECTED' THEN 'FAILED'
    ELSE 'PROVIDER_UNCERTAIN'
  END;

  UPDATE public.zalo_outbound_deliveries d
  SET status = v_status,
      provider_msg_id = CASE WHEN p_outcome = 'ACCEPTED' THEN p_provider_msg_id ELSE d.provider_msg_id END,
      provider_accepted_at = CASE WHEN p_outcome = 'ACCEPTED' THEN now() ELSE d.provider_accepted_at END,
      error_code = CASE WHEN p_outcome = 'ACCEPTED' THEN NULL ELSE left(p_error_code, 100) END,
      error_message = CASE WHEN p_outcome = 'ACCEPTED' THEN NULL ELSE left(p_error_message, 500) END,
      lease_until = NULL,
      claim_token = CASE WHEN p_outcome = 'REJECTED' THEN NULL ELSE d.claim_token END,
      updated_at = now()
  WHERE d.id = p_delivery_id;

  RETURN v_status;
END;
$$;

-- Idempotent finalize: interaction + private raw + conversation + delivery SENT in ONE
-- transaction. Never talks to the provider; safe to retry by delivery id.
CREATE OR REPLACE FUNCTION public.zalo_finalize_outbound_delivery(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.zalo_outbound_deliveries%ROWTYPE;
  v_raw text;
  v_ref text;
  v_interaction_id uuid;
  v_existing record;
  v_now timestamptz := now();
BEGIN
  SELECT d.* INTO v_row FROM public.zalo_outbound_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.status = 'SENT' THEN
    RETURN jsonb_build_object('interaction_id', v_row.interaction_id, 'already_finalized', true,
                              'provider_msg_id', v_row.provider_msg_id);
  END IF;

  IF v_row.status <> 'PROVIDER_SENT_PENDING_FINALIZE' THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_NOT_FINALIZABLE' USING ERRCODE = '55000';
  END IF;

  SELECT p.raw_content INTO v_raw FROM private.zalo_outbound_payloads p WHERE p.delivery_id = v_row.id;
  IF v_raw IS NULL THEN
    RAISE EXCEPTION 'ZALO_OUTBOUND_PAYLOAD_MISSING' USING ERRCODE = 'P0002';
  END IF;

  PERFORM private.zalo_lock_user(v_row.company_id, v_row.recipient_zalo_uid);

  v_ref := 'zalo:' || v_row.company_id::text || ':' || coalesce(v_row.oa_id, 'unknown') || ':'
           || coalesce(v_row.provider_msg_id, 'outbound:' || v_row.id::text);

  SELECT i.id, i.actor_user_id INTO v_existing
  FROM public.interactions i
  WHERE i.company_id = v_row.company_id AND i.channel = 'ZALO' AND i.external_ref = v_ref;

  IF v_existing.id IS NOT NULL THEN
    -- Zalo echoed oa_send_* before we finalized: attribute the actor, do not duplicate.
    v_interaction_id := v_existing.id;
    UPDATE public.interactions i
    SET actor_type = coalesce(v_row.actor_type, i.actor_type),
        actor_user_id = coalesce(i.actor_user_id, v_row.actor_user_id)
    WHERE i.id = v_existing.id AND i.actor_user_id IS NULL;
  ELSE
    INSERT INTO public.interactions (
      company_id, customer_id, conversation_id, channel, type, direction,
      sanitized_content, sanitization_status, sanitized_at, sanitizer_version,
      external_ref, actor_type, actor_user_id, created_at
    ) VALUES (
      v_row.company_id, v_row.customer_id, v_row.conversation_id, 'ZALO', 'MESSAGE', 'OUTBOUND',
      v_row.content, 'SUCCEEDED', v_now, 'zalo-sanitizer-v1',
      v_ref, coalesce(v_row.actor_type, 'SYSTEM'), v_row.actor_user_id,
      coalesce(v_row.provider_accepted_at, v_now)
    )
    RETURNING id INTO v_interaction_id;

    INSERT INTO private.interaction_raw_contents (interaction_id, company_id, raw_content, raw_payload, source_metadata)
    VALUES (
      v_interaction_id, v_row.company_id, v_raw,
      jsonb_build_object('recipient', jsonb_build_object('user_id', v_row.recipient_zalo_uid)),
      jsonb_build_object(
        'oa_id', v_row.oa_id,
        'recipient_id', v_row.recipient_zalo_uid,
        'provider_msg_id', v_row.provider_msg_id,
        'delivery_id', v_row.id,
        'command_id', v_row.command_id,
        'origin', 'CRM_OUTBOX'
      )
    );

    UPDATE public.conversations c
    SET last_message_at = greatest(c.last_message_at, coalesce(v_row.provider_accepted_at, v_now))
    WHERE c.id = v_row.conversation_id;
  END IF;

  UPDATE public.zalo_outbound_deliveries d
  SET status = 'SENT', interaction_id = v_interaction_id, finalized_at = v_now,
      claim_token = NULL, lease_until = NULL, error_code = NULL, error_message = NULL, updated_at = v_now
  WHERE d.id = v_row.id;

  RETURN jsonb_build_object('interaction_id', v_interaction_id, 'already_finalized', false,
                            'provider_msg_id', v_row.provider_msg_id);
END;
$$;

-- ==============================================================================
-- 5. CARE DELIVERIES (#9)
-- ==============================================================================
ALTER TABLE public.care_deliveries DROP CONSTRAINT IF EXISTS care_deliveries_status_check;
ALTER TABLE public.care_deliveries
  ADD CONSTRAINT care_deliveries_status_check
  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RESPONDED',
                    'CONVERTED_TO_SALE', 'SKIPPED', 'UNCERTAIN'));

ALTER TABLE public.care_deliveries
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS oa_id text,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_message text;

-- CareDelivery always belongs to a CareCampaign (DATA_CONTRACT §23); periodic schedule
-- sends use one system campaign per company/channel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_care_campaigns_periodic
  ON public.care_campaigns (company_id, channel)
  WHERE (audience_rule ->> 'kind') = 'PERIODIC_SCHEDULE';

CREATE OR REPLACE FUNCTION private.care_advance_schedule(p_schedule_id uuid, p_as_of timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_next timestamptz;
  v_freq integer;
  v_guard integer := 0;
BEGIN
  SELECT s.next_send_at, s.frequency_months INTO v_next, v_freq
  FROM public.care_schedules s WHERE s.id = p_schedule_id FOR UPDATE;
  IF v_next IS NULL THEN
    RETURN NULL;
  END IF;

  LOOP
    v_next := v_next + make_interval(months => greatest(v_freq, 1));
    v_guard := v_guard + 1;
    EXIT WHEN v_next > p_as_of OR v_guard >= 240;
  END LOOP;

  UPDATE public.care_schedules s SET next_send_at = v_next WHERE s.id = p_schedule_id;
  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION private.care_advance_schedule(uuid, timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.care_claim_schedule_delivery(
  p_company_id uuid,
  p_schedule_id uuid,
  p_default_template text,
  p_as_of timestamptz DEFAULT now(),
  p_lease_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE (
  claim_status text,
  delivery_id uuid,
  claim_token uuid,
  customer_id uuid,
  customer_name text,
  recipient_zalo_uid text,
  oa_id text,
  message_template text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_sched record;
  v_customer record;
  v_uid text;
  v_oa text;
  v_campaign record;
  v_target date;
  v_key text;
  v_row public.care_deliveries%ROWTYPE;
  v_token uuid := gen_random_uuid();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30));
  v_as_of timestamptz := coalesce(p_as_of, now());
BEGIN
  SELECT s.* INTO v_sched
  FROM public.care_schedules s
  WHERE s.id = p_schedule_id AND s.company_id = p_company_id AND s.channel = 'ZALO'
  FOR UPDATE;

  IF v_sched.id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, 0;
    RETURN;
  END IF;
  IF NOT v_sched.enabled THEN
    RETURN QUERY SELECT 'STOPPED'::text, NULL::uuid, NULL::uuid, v_sched.customer_id, NULL::text, NULL::text, NULL::text, NULL::text, 0;
    RETURN;
  END IF;
  IF v_sched.next_send_at > v_as_of THEN
    RETURN QUERY SELECT 'NOT_DUE'::text, NULL::uuid, NULL::uuid, v_sched.customer_id, NULL::text, NULL::text, NULL::text, NULL::text, 0;
    RETURN;
  END IF;

  SELECT c.id, c.name INTO v_customer FROM public.customers c WHERE c.id = v_sched.customer_id AND c.company_id = p_company_id;

  SELECT i.external_id INTO v_uid
  FROM public.identities i
  WHERE i.company_id = p_company_id AND i.customer_id = v_sched.customer_id AND i.channel = 'ZALO'
  ORDER BY i.created_at DESC
  LIMIT 1;

  v_oa := private.zalo_resolve_customer_oa(p_company_id, v_sched.customer_id);
  IF v_uid IS NOT NULL AND v_oa IS NULL THEN
    -- Configuration problem: leave the schedule due, do not burn a cycle.
    RETURN QUERY SELECT 'OA_NOT_CONFIGURED'::text, NULL::uuid, NULL::uuid, v_sched.customer_id, NULL::text, NULL::text, NULL::text, NULL::text, 0;
    RETURN;
  END IF;

  INSERT INTO public.care_campaigns AS cc (company_id, channel, audience_rule, message_template, started_at)
  VALUES (
    p_company_id, 'ZALO',
    jsonb_build_object('kind', 'PERIODIC_SCHEDULE', 'audienceGroup', 'PERIODIC_CARE', 'title', 'Chăm sóc định kỳ Zalo'),
    coalesce(nullif(btrim(p_default_template), ''), 'Chào {name}, Cửa Chống Ngập xin gửi lời hỏi thăm định kỳ.'),
    now()
  )
  ON CONFLICT (company_id, channel) WHERE (audience_rule ->> 'kind') = 'PERIODIC_SCHEDULE' DO NOTHING;

  SELECT cc.id, cc.message_template INTO v_campaign
  FROM public.care_campaigns cc
  WHERE cc.company_id = p_company_id AND cc.channel = 'ZALO' AND (cc.audience_rule ->> 'kind') = 'PERIODIC_SCHEDULE';

  v_target := (v_sched.next_send_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_key := 'care_sched:' || v_sched.id::text || ':' || v_target::text || ':ZALO';

  IF v_uid IS NULL THEN
    INSERT INTO public.care_deliveries (company_id, campaign_id, customer_id, idempotency_key, channel, status,
                                        care_schedule_id, send_target_date, attempt_count, error_code)
    VALUES (p_company_id, v_campaign.id, v_sched.customer_id, v_key, 'ZALO', 'SKIPPED',
            v_sched.id, v_target, 0, 'NO_ZALO_IDENTITY')
    ON CONFLICT DO NOTHING;
    PERFORM private.care_advance_schedule(v_sched.id, v_as_of);
    RETURN QUERY SELECT 'NO_ZALO_IDENTITY'::text, NULL::uuid, NULL::uuid, v_sched.customer_id, NULL::text, NULL::text, NULL::text, NULL::text, 0;
    RETURN;
  END IF;

  INSERT INTO public.care_deliveries AS d (company_id, campaign_id, customer_id, idempotency_key, channel, status,
                                           care_schedule_id, send_target_date, lease_until, attempt_count,
                                           claim_token, oa_id)
  VALUES (p_company_id, v_campaign.id, v_sched.customer_id, v_key, 'ZALO', 'SENDING',
          v_sched.id, v_target, now() + v_lease, 1, v_token, v_oa)
  ON CONFLICT DO NOTHING
  RETURNING d.* INTO v_row;

  IF v_row.id IS NOT NULL THEN
    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_sched.customer_id, v_customer.name, v_uid, v_oa,
                        v_campaign.message_template, 1;
    RETURN;
  END IF;

  SELECT d.* INTO v_row
  FROM public.care_deliveries d
  WHERE d.company_id = p_company_id AND d.idempotency_key = v_key
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    -- Conflict on (care_schedule_id, send_target_date) with a legacy key.
    SELECT d.* INTO v_row
    FROM public.care_deliveries d
    WHERE d.care_schedule_id = v_sched.id AND d.send_target_date = v_target
    FOR UPDATE;
  END IF;

  IF v_row.status IN ('SENT', 'DELIVERED', 'READ', 'RESPONDED', 'CONVERTED_TO_SALE', 'SKIPPED', 'UNCERTAIN') THEN
    PERFORM private.care_advance_schedule(v_sched.id, v_as_of);
    RETURN QUERY SELECT 'ALREADY_RESOLVED'::text, v_row.id, NULL::uuid, v_sched.customer_id, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' AND v_row.lease_until IS NOT NULL AND v_row.lease_until > now() THEN
    RETURN QUERY SELECT 'BUSY'::text, v_row.id, NULL::uuid, v_sched.customer_id, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' THEN
    -- Outcome unknown (worker crashed / timed out): do not risk a duplicate care message.
    UPDATE public.care_deliveries d
    SET status = 'UNCERTAIN', lease_until = NULL, error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN'
    WHERE d.id = v_row.id;
    PERFORM private.care_advance_schedule(v_sched.id, v_as_of);
    RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, NULL::uuid, v_sched.customer_id, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
    RETURN;
  END IF;

  -- FAILED / PENDING
  IF v_row.attempt_count >= greatest(coalesce(p_max_attempts, 3), 1) THEN
    UPDATE public.care_deliveries d
    SET status = 'SKIPPED', lease_until = NULL, claim_token = NULL, error_code = 'MAX_ATTEMPTS_EXCEEDED'
    WHERE d.id = v_row.id;
    PERFORM private.care_advance_schedule(v_sched.id, v_as_of);
    RETURN QUERY SELECT 'EXHAUSTED'::text, v_row.id, NULL::uuid, v_sched.customer_id, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
    RETURN;
  END IF;

  UPDATE public.care_deliveries d
  SET status = 'SENDING', lease_until = now() + v_lease, attempt_count = d.attempt_count + 1,
      claim_token = v_token, oa_id = v_oa, error_code = NULL, error_message = NULL
  WHERE d.id = v_row.id;

  RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_sched.customer_id, v_customer.name, v_uid, v_oa,
                      v_campaign.message_template, v_row.attempt_count + 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.care_claim_campaign_delivery(
  p_campaign_id uuid,
  p_customer_id uuid,
  p_lease_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE (
  claim_status text,
  delivery_id uuid,
  claim_token uuid,
  customer_name text,
  recipient_zalo_uid text,
  oa_id text,
  message_template text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_campaign record;
  v_customer record;
  v_uid text;
  v_oa text;
  v_key text;
  v_opted_out boolean;
  v_row public.care_deliveries%ROWTYPE;
  v_token uuid := gen_random_uuid();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30));
BEGIN
  SELECT cc.id, cc.company_id, cc.message_template INTO v_campaign
  FROM public.care_campaigns cc WHERE cc.id = p_campaign_id AND cc.channel = 'ZALO';
  IF v_campaign.id IS NULL THEN
    RAISE EXCEPTION 'CARE_CAMPAIGN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT c.id, c.name INTO v_customer
  FROM public.customers c WHERE c.id = p_customer_id AND c.company_id = v_campaign.company_id;
  IF v_customer.id IS NULL THEN
    RAISE EXCEPTION 'CARE_CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_key := p_campaign_id::text || ':' || p_customer_id::text || ':ZALO';

  SELECT NOT s.enabled INTO v_opted_out
  FROM public.care_schedules s
  WHERE s.company_id = v_campaign.company_id AND s.customer_id = p_customer_id AND s.channel = 'ZALO';

  SELECT i.external_id INTO v_uid
  FROM public.identities i
  WHERE i.company_id = v_campaign.company_id AND i.customer_id = p_customer_id AND i.channel = 'ZALO'
  ORDER BY i.created_at DESC
  LIMIT 1;

  v_oa := private.zalo_resolve_customer_oa(v_campaign.company_id, p_customer_id);

  INSERT INTO public.care_deliveries AS d (company_id, campaign_id, customer_id, idempotency_key, channel, status,
                                           lease_until, attempt_count, claim_token, oa_id, error_code)
  VALUES (
    v_campaign.company_id, p_campaign_id, p_customer_id, v_key, 'ZALO',
    CASE WHEN coalesce(v_opted_out, false) OR v_uid IS NULL OR v_oa IS NULL THEN 'SKIPPED' ELSE 'SENDING' END,
    CASE WHEN coalesce(v_opted_out, false) OR v_uid IS NULL OR v_oa IS NULL THEN NULL ELSE now() + v_lease END,
    CASE WHEN coalesce(v_opted_out, false) OR v_uid IS NULL OR v_oa IS NULL THEN 0 ELSE 1 END,
    CASE WHEN coalesce(v_opted_out, false) OR v_uid IS NULL OR v_oa IS NULL THEN NULL ELSE v_token END,
    v_oa,
    CASE
      WHEN coalesce(v_opted_out, false) THEN 'SUPPRESSED_OPT_OUT'
      WHEN v_uid IS NULL THEN 'NO_ZALO_IDENTITY'
      WHEN v_oa IS NULL THEN 'OA_NOT_CONFIGURED'
      ELSE NULL
    END
  )
  ON CONFLICT DO NOTHING
  RETURNING d.* INTO v_row;

  IF v_row.id IS NOT NULL THEN
    IF v_row.status = 'SKIPPED' THEN
      RETURN QUERY SELECT 'SKIPPED'::text, v_row.id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, 0;
    ELSE
      RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_customer.name, v_uid, v_oa, v_campaign.message_template, 1;
    END IF;
    RETURN;
  END IF;

  SELECT d.* INTO v_row
  FROM public.care_deliveries d
  WHERE d.company_id = v_campaign.company_id AND d.idempotency_key = v_key
  FOR UPDATE;

  IF v_row.status IN ('FAILED', 'PENDING') THEN
    IF coalesce(v_opted_out, false) THEN
      UPDATE public.care_deliveries d
      SET status = 'SKIPPED', claim_token = NULL, lease_until = NULL, error_code = 'SUPPRESSED_OPT_OUT'
      WHERE d.id = v_row.id;
      RETURN QUERY SELECT 'SKIPPED'::text, v_row.id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
      RETURN;
    END IF;
    IF v_row.attempt_count >= greatest(coalesce(p_max_attempts, 3), 1) OR v_uid IS NULL OR v_oa IS NULL THEN
      RETURN QUERY SELECT 'EXHAUSTED'::text, v_row.id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
      RETURN;
    END IF;

    UPDATE public.care_deliveries d
    SET status = 'SENDING', lease_until = now() + v_lease, attempt_count = d.attempt_count + 1,
        claim_token = v_token, oa_id = v_oa, error_code = NULL, error_message = NULL
    WHERE d.id = v_row.id;
    RETURN QUERY SELECT 'CLAIMED'::text, v_row.id, v_token, v_customer.name, v_uid, v_oa, v_campaign.message_template,
                        v_row.attempt_count + 1;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' AND v_row.lease_until IS NOT NULL AND v_row.lease_until > now() THEN
    RETURN QUERY SELECT 'BUSY'::text, v_row.id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
    RETURN;
  END IF;

  IF v_row.status = 'SENDING' THEN
    UPDATE public.care_deliveries d
    SET status = 'UNCERTAIN', lease_until = NULL, error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN'
    WHERE d.id = v_row.id;
    RETURN QUERY SELECT 'UNCERTAIN'::text, v_row.id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ALREADY_RESOLVED'::text, v_row.id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_row.attempt_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.care_complete_delivery(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_msg_id text,
  p_error_code text,
  p_error_message text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sched_id uuid;
  v_row public.care_deliveries%ROWTYPE;
  v_status text;
BEGIN
  IF p_outcome NOT IN ('ACCEPTED', 'REJECTED', 'UNCERTAIN') THEN
    RAISE EXCEPTION 'CARE_OUTCOME_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Maintain consistent lock order: care_schedules -> care_deliveries to prevent deadlock
  SELECT d.care_schedule_id INTO v_sched_id FROM public.care_deliveries d WHERE d.id = p_delivery_id;
  IF v_sched_id IS NOT NULL THEN
    PERFORM 1 FROM public.care_schedules s WHERE s.id = v_sched_id FOR UPDATE;
  END IF;

  SELECT d.* INTO v_row FROM public.care_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF v_row.id IS NULL
     OR v_row.claim_token IS DISTINCT FROM p_claim_token
     OR v_row.status NOT IN ('SENDING', 'UNCERTAIN') THEN
    RAISE EXCEPTION 'CARE_DELIVERY_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;

  v_status := CASE p_outcome WHEN 'ACCEPTED' THEN 'SENT' WHEN 'REJECTED' THEN 'FAILED' ELSE 'UNCERTAIN' END;

  UPDATE public.care_deliveries d
  SET status = v_status,
      sent_at = CASE WHEN p_outcome = 'ACCEPTED' THEN now() ELSE d.sent_at END,
      external_message_ref = CASE WHEN p_outcome = 'ACCEPTED' THEN p_provider_msg_id ELSE d.external_message_ref END,
      error_code = CASE WHEN p_outcome = 'ACCEPTED' THEN NULL ELSE left(p_error_code, 100) END,
      error_message = CASE WHEN p_outcome = 'ACCEPTED' THEN NULL ELSE left(p_error_message, 500) END,
      lease_until = NULL,
      claim_token = NULL
  WHERE d.id = p_delivery_id;

  -- A periodic schedule advances only on a sent (or possibly-sent) message; a definite
  -- rejection leaves it due so the next tick re-claims the SAME delivery row.
  IF v_row.care_schedule_id IS NOT NULL AND p_outcome <> 'REJECTED' THEN
    PERFORM private.care_advance_schedule(v_row.care_schedule_id, now());
  END IF;

  RETURN v_status;
END;
$$;

-- ==============================================================================
-- 7. TV2 UNIFIED INBOX ↔ TV3 PROVIDER DISPATCHER INTEGRATION
-- ==============================================================================

-- 7.1 Extend public.outbound_deliveries check constraint to support UNCERTAIN status
ALTER TABLE public.outbound_deliveries DROP CONSTRAINT IF EXISTS outbound_deliveries_delivery_status_check;
ALTER TABLE public.outbound_deliveries
  ADD CONSTRAINT outbound_deliveries_delivery_status_check
  CHECK (delivery_status IN ('PENDING_DISPATCH', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNCERTAIN'));

-- 7.2 Link public.zalo_outbound_deliveries as transport extension
ALTER TABLE public.zalo_outbound_deliveries
  ADD COLUMN IF NOT EXISTS canonical_delivery_id uuid REFERENCES public.outbound_deliveries(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_zalo_outbound_canonical_delivery
  ON public.zalo_outbound_deliveries (canonical_delivery_id)
  WHERE canonical_delivery_id IS NOT NULL;

-- 7.3 Atomic Claim of Canonical Outbound Delivery for Zalo Dispatcher
CREATE OR REPLACE FUNCTION public.zalo_claim_canonical_delivery(
  p_delivery_id uuid,
  p_worker_id text,
  p_override_oa_id text DEFAULT NULL
)
RETURNS TABLE (
  delivery_id uuid,
  company_id uuid,
  conversation_id uuid,
  interaction_id uuid,
  customer_id uuid,
  recipient_zalo_uid text,
  oa_id text,
  raw_content text,
  sanitized_content text,
  client_command_id uuid,
  claim_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_del public.outbound_deliveries%ROWTYPE;
  v_conv record;
  v_raw text;
  v_sanitized text;
  v_oa text;
BEGIN
  SELECT * INTO v_del
  FROM public.outbound_deliveries d
  WHERE d.id = p_delivery_id AND d.channel = 'ZALO'
  FOR UPDATE SKIP LOCKED;

  IF v_del.id IS NULL THEN
    SELECT * INTO v_del FROM public.outbound_deliveries d WHERE d.id = p_delivery_id;
    IF v_del.id IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, 'NOT_FOUND'::text;
      RETURN;
    ELSIF v_del.delivery_status = 'SENT' THEN
      RETURN QUERY SELECT v_del.id, v_del.company_id, v_del.conversation_id, v_del.interaction_id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_del.client_command_id, 'ALREADY_SENT'::text;
      RETURN;
    ELSIF v_del.delivery_status = 'UNCERTAIN' THEN
      RETURN QUERY SELECT v_del.id, v_del.company_id, v_del.conversation_id, v_del.interaction_id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_del.client_command_id, 'UNCERTAIN'::text;
      RETURN;
    ELSE
      RETURN QUERY SELECT v_del.id, v_del.company_id, v_del.conversation_id, v_del.interaction_id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_del.client_command_id, 'BUSY'::text;
      RETURN;
    END IF;
  END IF;

  IF v_del.delivery_status NOT IN ('PENDING_DISPATCH', 'QUEUED', 'FAILED') THEN
    RETURN QUERY SELECT v_del.id, v_del.company_id, v_del.conversation_id, v_del.interaction_id, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, v_del.client_command_id, v_del.delivery_status;
    RETURN;
  END IF;

  SELECT c.id, c.customer_id, c.external_conversation_id INTO v_conv
  FROM public.conversations c
  WHERE c.id = v_del.conversation_id AND c.company_id = v_del.company_id;

  IF v_conv.id IS NULL THEN
    RAISE EXCEPTION 'ZALO_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_override_oa_id IS NOT NULL THEN
    v_oa := p_override_oa_id;
  ELSE
    v_oa := private.zalo_resolve_customer_oa(v_del.company_id, v_conv.customer_id);
  END IF;

  IF v_oa IS NULL THEN
    SELECT c.oa_id INTO v_oa
    FROM public.zalo_oa_configs c
    WHERE c.company_id = v_del.company_id AND c.status = 'ACTIVE'
    LIMIT 1;
  END IF;

  IF v_oa IS NULL THEN
    RAISE EXCEPTION 'ZALO_OA_NOT_CONFIGURED' USING ERRCODE = 'P0002';
  END IF;

  -- Raw outbound content from private.interaction_raw_contents
  SELECT p.raw_content INTO v_raw
  FROM private.interaction_raw_contents p
  WHERE p.interaction_id = v_del.interaction_id AND p.company_id = v_del.company_id;

  SELECT i.sanitized_content INTO v_sanitized
  FROM public.interactions i
  WHERE i.id = v_del.interaction_id;

  IF v_raw IS NULL OR v_raw = '' THEN
    v_raw := coalesce(v_sanitized, '');
  END IF;

  UPDATE public.outbound_deliveries
  SET delivery_status = 'QUEUED',
      locked_at = clock_timestamp(),
      locked_by = p_worker_id,
      retry_count = retry_count + 1,
      updated_at = clock_timestamp()
  WHERE id = v_del.id;

  RETURN QUERY SELECT
    v_del.id,
    v_del.company_id,
    v_del.conversation_id,
    v_del.interaction_id,
    v_conv.customer_id,
    v_conv.external_conversation_id,
    v_oa,
    v_raw,
    v_sanitized,
    v_del.client_command_id,
    'CLAIMED'::text;
END;
$$;

-- 7.4 Finalize Canonical Outbound Delivery
CREATE OR REPLACE FUNCTION public.zalo_finalize_canonical_outbound(
  p_delivery_id uuid,
  p_provider_msg_id text,
  p_oa_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_del public.outbound_deliveries%ROWTYPE;
  v_canonical_ref text;
BEGIN
  IF coalesce(btrim(p_provider_msg_id), '') = '' THEN
    RAISE EXCEPTION 'ZALO_PROVIDER_MSG_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_del
  FROM public.outbound_deliveries d
  WHERE d.id = p_delivery_id
  FOR UPDATE;

  IF v_del.id IS NULL THEN
    RETURN false;
  END IF;

  v_canonical_ref := 'zalo:' || v_del.company_id::text || ':' || p_oa_id || ':' || p_provider_msg_id;

  UPDATE public.outbound_deliveries
  SET delivery_status = 'SENT',
      provider_message_id = p_provider_msg_id,
      locked_at = NULL,
      locked_by = NULL,
      error_message = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_delivery_id;

  UPDATE public.interactions
  SET external_ref = v_canonical_ref
  WHERE id = v_del.interaction_id;

  IF v_del.client_command_id IS NOT NULL THEN
    UPDATE public.zalo_outbound_deliveries
    SET status = 'SENT',
        provider_msg_id = p_provider_msg_id,
        canonical_delivery_id = p_delivery_id,
        updated_at = clock_timestamp()
    WHERE company_id = v_del.company_id
      AND (command_id = v_del.client_command_id::text OR canonical_delivery_id = p_delivery_id);
  END IF;

  RETURN true;
END;
$$;

-- 7.5 Record Canonical Outbound Failure (FAILED or UNCERTAIN)
CREATE OR REPLACE FUNCTION public.zalo_record_canonical_failure(
  p_delivery_id uuid,
  p_error_message text,
  p_is_uncertain boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_del public.outbound_deliveries%ROWTYPE;
  v_new_status text;
  v_zalo_status text;
BEGIN
  SELECT * INTO v_del
  FROM public.outbound_deliveries d
  WHERE d.id = p_delivery_id
  FOR UPDATE;

  IF v_del.id IS NULL THEN
    RETURN false;
  END IF;

  IF p_is_uncertain THEN
    v_new_status := 'UNCERTAIN';
    v_zalo_status := 'PROVIDER_UNCERTAIN';
  ELSE
    v_new_status := 'FAILED';
    v_zalo_status := 'FAILED';
  END IF;

  UPDATE public.outbound_deliveries
  SET delivery_status = v_new_status,
      error_message = p_error_message,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_delivery_id;

  IF v_del.client_command_id IS NOT NULL THEN
    UPDATE public.zalo_outbound_deliveries
    SET status = v_zalo_status,
        error_message = p_error_message,
        canonical_delivery_id = p_delivery_id,
        updated_at = clock_timestamp()
    WHERE company_id = v_del.company_id
      AND (command_id = v_del.client_command_id::text OR canonical_delivery_id = p_delivery_id);
  END IF;

  RETURN true;
END;
$$;

-- 7.6 Atomic Care Schedule Reactivation with Invariant Audit Log
CREATE OR REPLACE FUNCTION public.care_reactivate_schedule(
  p_company_id uuid,
  p_customer_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_frequency_months integer DEFAULT 1,
  p_next_send_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_schedule_id uuid;
  v_prev_reason text;
  v_next timestamptz := coalesce(p_next_send_at, now() + make_interval(months => coalesce(p_frequency_months, 1)));
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'A reactivation reason is required' USING ERRCODE = '22023';
  END IF;

  -- Defense in depth: Verify actor is BOSS_ADMIN of company
  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members m
    JOIN public.user_profiles up ON up.id = m.user_id AND up.status = 'ACTIVE'
    WHERE m.company_id = p_company_id
      AND m.user_id = p_actor_user_id
      AND m.status = 'ACTIVE'
      AND m.role = 'BOSS_ADMIN'
  ) THEN
    RAISE EXCEPTION 'Only BOSS_ADMIN may reactivate care schedule' USING ERRCODE = '42501';
  END IF;

  SELECT s.id, s.stop_reason INTO v_schedule_id, v_prev_reason
  FROM public.care_schedules s
  WHERE s.company_id = p_company_id AND s.customer_id = p_customer_id AND s.channel = 'ZALO'
  FOR UPDATE;

  IF v_schedule_id IS NULL THEN
    INSERT INTO public.care_schedules (company_id, customer_id, channel, frequency_months, next_send_at, enabled, stop_reason)
    VALUES (p_company_id, p_customer_id, 'ZALO', coalesce(p_frequency_months, 1), v_next, true, NULL)
    RETURNING id INTO v_schedule_id;
  ELSE
    UPDATE public.care_schedules
    SET enabled = true,
        stop_reason = NULL,
        frequency_months = coalesce(p_frequency_months, frequency_months),
        next_send_at = v_next,
        updated_at = clock_timestamp()
    WHERE id = v_schedule_id;
  END IF;

  -- Atomic audit log: in same transaction; if audit fails, the whole reactivation rolls back
  INSERT INTO public.audit_logs (company_id, user_id, action, resource_type, resource_id, customer_id, result, metadata)
  VALUES (
    p_company_id,
    p_actor_user_id,
    'CARE_SCHEDULE_REACTIVATED',
    'CARE_SCHEDULE',
    v_schedule_id,
    p_customer_id,
    'SUCCESS',
    jsonb_build_object(
      'previous_stop_reason', v_prev_reason,
      'reason', left(btrim(p_reason), 300)
    )
  );

  RETURN v_schedule_id;
END;
$$;

-- ==============================================================================
-- 8. GRANTS: service role only
-- ==============================================================================
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.zalo_resolve_oa_tenant(text)',
    'public.zalo_get_oa_credentials(uuid, text)',
    'public.zalo_begin_token_refresh(uuid, text, integer)',
    'public.zalo_complete_token_refresh(uuid, text, uuid, text, text, timestamptz)',
    'public.zalo_abort_token_refresh(uuid, text, uuid, text)',
    'public.zalo_upsert_oa_connection(uuid, text, text, text, text, text, timestamptz, text, uuid)',
    'public.zalo_set_oa_connection_status(uuid, text, text, uuid)',
    'public.zalo_claim_ingress_event(uuid, text, text, text, text, text, integer)',
    'public.zalo_fail_ingress_event(uuid, uuid, text)',
    'public.zalo_process_ingress_message(uuid, uuid, uuid, text, text, text, text, text, text, text, text, boolean, text, text, jsonb, timestamptz, boolean)',
    'public.zalo_process_ingress_status_event(uuid, uuid, uuid, text, text, text, text, text[], timestamptz)',
    'public.zalo_claim_outbound_delivery(uuid, uuid, text, text, uuid, text, text, text, text, integer)',
    'public.zalo_record_outbound_provider_result(uuid, uuid, text, text, text, text)',
    'public.zalo_finalize_outbound_delivery(uuid)',
    'public.care_claim_schedule_delivery(uuid, uuid, text, timestamptz, integer, integer)',
    'public.care_claim_campaign_delivery(uuid, uuid, integer, integer)',
    'public.care_complete_delivery(uuid, uuid, text, text, text, text)',
    'public.zalo_claim_canonical_delivery(uuid, text, text)',
    'public.zalo_finalize_canonical_outbound(uuid, text, text)',
    'public.zalo_record_canonical_failure(uuid, text, boolean)',
    'public.care_reactivate_schedule(uuid, uuid, uuid, text, integer, timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END $$;
