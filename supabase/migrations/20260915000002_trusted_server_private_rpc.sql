-- Migration 003: Trusted Server Private RPC Routines
-- Narrowly-scoped SECURITY DEFINER access to private schema data for service_role only.
-- Schemas: public RPC accessing private tables without exposing private schema to PostgREST.

CREATE OR REPLACE FUNCTION public.get_customer_private_contact(
  p_company_id uuid,
  p_customer_id uuid
)
RETURNS TABLE (
  normalized_phone text,
  raw_phone text,
  is_verified boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    cpc.normalized_phone,
    cpc.raw_phone,
    cpc.is_verified
  FROM private.customer_private_contacts cpc
  WHERE cpc.company_id = p_company_id
    AND cpc.customer_id = p_customer_id;
$$;

COMMENT ON FUNCTION public.get_customer_private_contact(uuid, uuid)
  IS 'Trusted server RPC to securely access customer private contact. Strictly restricted to service_role.';

REVOKE ALL ON FUNCTION public.get_customer_private_contact(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_private_contact(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_private_contact(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_private_contact(uuid, uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.get_interaction_raw_content(
  p_company_id uuid,
  p_interaction_id uuid
)
RETURNS TABLE (
  interaction_id uuid,
  company_id uuid,
  raw_content text,
  raw_payload jsonb,
  source_metadata jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    irc.interaction_id,
    irc.company_id,
    irc.raw_content,
    irc.raw_payload,
    irc.source_metadata,
    irc.created_at
  FROM private.interaction_raw_contents irc
  WHERE irc.company_id = p_company_id
    AND irc.interaction_id = p_interaction_id;
$$;

COMMENT ON FUNCTION public.get_interaction_raw_content(uuid, uuid)
  IS 'Trusted server RPC to securely access raw interaction content. Strictly restricted to service_role.';

REVOKE ALL ON FUNCTION public.get_interaction_raw_content(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_interaction_raw_content(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_interaction_raw_content(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_interaction_raw_content(uuid, uuid) TO service_role;
