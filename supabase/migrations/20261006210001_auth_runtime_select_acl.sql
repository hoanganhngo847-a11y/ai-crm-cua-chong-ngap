-- ==============================================================================
-- Migration: Auth Runtime SELECT ACL Repair
--
-- Context:
-- The server-side auth runtime resolves the authenticated actor by reading
-- public.user_profiles and public.company_members through the user's JWT.
-- Both tables already have restrictive RLS policies, but authenticated was
-- missing table-level SELECT privileges, causing PostgREST 403 errors before
-- RLS could authorize the permitted rows.
--
-- Security model:
-- Grant only SELECT at the table ACL layer. Row visibility remains constrained
-- by the existing RLS policies (self profile / authorized membership access).
-- No RLS policy is disabled or bypassed.
-- ==============================================================================

GRANT SELECT ON TABLE public.user_profiles TO authenticated;
GRANT SELECT ON TABLE public.company_members TO authenticated;
