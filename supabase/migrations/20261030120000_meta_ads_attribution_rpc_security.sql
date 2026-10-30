-- Migration: 20261030120000_meta_ads_attribution_rpc_security.sql
-- Description: Restrict record_lead_attribution_touchpoint RPC execution strictly to service_role (F-11)
-- Standards: Revoke from authenticated, anon, and PUBLIC; grant only to service_role.

BEGIN;

REVOKE ALL ON FUNCTION public.record_lead_attribution_touchpoint(
    uuid, uuid, uuid, uuid, text, text, text, text, text, text,
    text, text, text, text, text, text, text, text, text, jsonb,
    text, text, text, text, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_lead_attribution_touchpoint(
    uuid, uuid, uuid, uuid, text, text, text, text, text, text,
    text, text, text, text, text, text, text, text, text, jsonb,
    text, text, text, text, text, text, text, text, timestamptz
) TO service_role;

COMMIT;
