-- Migration: 20260930000001_p0_security_acl_hardening.sql
-- Description: System-Audit P0 Security Fixes
-- 1. P0-001: Close Facebook trusted-RPC authorization bypass (han_prepare_send, han_finish_send)
-- 2. P0-002: Close direct contract signing forgery and production-gate bypass (public.contracts)

-- ============================================================================
-- 1. P0-001: FACEBOOK RPC TRUST BOUNDARY HARDENING
-- ============================================================================

-- han_prepare_send: trusted server/provider primitive only.
-- Revoke execution from browser/client roles (PUBLIC, anon, authenticated).
-- Grant execution strictly to service_role.
REVOKE ALL ON FUNCTION public.han_prepare_send(
  uuid, uuid, uuid, uuid, text, text, text, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.han_prepare_send(
  uuid, uuid, uuid, uuid, text, text, text, uuid
) TO service_role;

-- han_finish_send: trusted server/provider primitive only.
-- Revoke execution from browser/client roles (PUBLIC, anon, authenticated).
-- Grant execution strictly to service_role.
REVOKE ALL ON FUNCTION public.han_finish_send(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.han_finish_send(
  uuid, uuid, text, text
) TO service_role;

-- ============================================================================
-- 2. P0-002: REMOVE DIRECT CONTRACT SIGNING BYPASS
-- ============================================================================

-- Drop the obsolete authenticated UPDATE policy that allowed direct PostgREST mutation
DROP POLICY IF EXISTS contracts_update_boss_admin ON public.contracts;

-- Explicitly revoke UPDATE privilege on public.contracts from client roles.
-- Canonical contract mutation must only occur via trusted server RPCs (e.g. finalize_contract_signing_rpc).
-- SELECT privilege for BOSS_ADMIN and SALE remains authorized by existing policies.
REVOKE UPDATE ON public.contracts FROM PUBLIC, anon, authenticated;
