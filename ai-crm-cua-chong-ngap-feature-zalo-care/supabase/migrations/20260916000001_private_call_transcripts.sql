-- Migration 004: Private Call Transcripts Security Boundary & Bounded RPC
-- Relocates public.call_transcripts to private schema to protect sensitive verbatim transcripts.
-- Enforces fail-closed RLS with zero client policies and establishes bounded SECURITY DEFINER RPC.

-- 1. Drop existing permissive client SELECT policy from public schema before relocation
DROP POLICY IF EXISTS call_transcripts_select_boss_admin ON public.call_transcripts;

-- 2. Relocate table to private schema
-- Preserves all existing rows, IDs, constraints (PK, FKs, UNIQUE), and indexes
ALTER TABLE public.call_transcripts SET SCHEMA private;

-- 3. Ensure Row Level Security remains enabled (zero client policies = fail-closed)
ALTER TABLE private.call_transcripts ENABLE ROW LEVEL SECURITY;

-- 4. Revoke all privileges from PUBLIC, anon, and authenticated roles
REVOKE ALL ON TABLE private.call_transcripts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE private.call_transcripts TO service_role;
GRANT ALL ON TABLE private.call_transcripts TO postgres;

-- 5. Bounded RPC: Narrowly-scoped SECURITY DEFINER access to private.call_transcripts
-- Only callable by service_role; binds both company_id and call_id to eliminate cross-tenant data leakage.
CREATE OR REPLACE FUNCTION public.get_call_transcript(
  p_company_id uuid,
  p_call_id uuid
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  call_id uuid,
  transcript text,
  speakers jsonb,
  processed_at timestamptz,
  language text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    ct.id,
    ct.company_id,
    ct.call_id,
    ct.transcript,
    ct.speakers,
    ct.processed_at,
    ct.language,
    ct.created_at
  FROM private.call_transcripts ct
  WHERE ct.company_id = p_company_id
    AND ct.call_id = p_call_id;
$$;

COMMENT ON FUNCTION public.get_call_transcript(uuid, uuid)
  IS 'Trusted server RPC to securely access verbatim call transcript. Strictly restricted to service_role.';

-- 6. Enforce strict ACL on the RPC routine
REVOKE ALL ON FUNCTION public.get_call_transcript(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_call_transcript(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_call_transcript(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_transcript(uuid, uuid) TO service_role;
