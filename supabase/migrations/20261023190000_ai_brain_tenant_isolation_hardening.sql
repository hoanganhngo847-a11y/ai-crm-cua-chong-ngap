-- Phase 10: AI Brain Tenant Isolation & RPC Security Hardening.
--
-- Security Audit Findings:
-- Main migrations Phase 6/8/9 introduced 8 SECURITY DEFINER RPCs that were granted EXECUTE to `authenticated`:
--   1. public.emergency_disable_ai(uuid)
--   2. public.resolve_ai_handover_case(uuid, uuid, uuid)
--   3. public.claim_ai_handover_case(uuid, uuid, uuid)
--   4. public.create_ai_handover_case(uuid, uuid, uuid, uuid, text, text, uuid, jsonb)
--   5. public.resume_ai_conversation(uuid, uuid, uuid)
--   6. public.record_ai_monitoring_alert(uuid, text, text, text, text, text, text, jsonb)
--   7. public.acknowledge_ai_monitoring_alert(uuid, uuid, uuid)
--   8. public.resolve_ai_monitoring_alert(uuid, uuid, uuid)
--
-- Vulnerability:
-- Because these functions are SECURITY DEFINER (running with owner privileges, bypassing table RLS)
-- and lacked internal auth.uid() / company membership checks, any authenticated user from Tenant A
-- could directly invoke them via Supabase PostgREST client with arbitrary `p_company_id` (Tenant B),
-- allowing cross-tenant mutation of AI emergency settings, handover cases, and monitoring alerts.
--
-- Call Site Verification:
-- All legitimate callers (app/actions/ai-control.ts, features/ai-brain/live-delivery/engine.ts,
-- features/ai-brain/monitoring/alert-evaluator.ts, features/ai-brain/handover/service.ts)
-- run exclusively on the trusted server. Server actions authenticate the user via requireAuthorizedActor(),
-- verify tenant membership and roles (e.g. requireBossAdmin), and invoke these RPCs using createAdminClient()
-- with service_role privileges.
--
-- Remediation:
-- Revoke EXECUTE from PUBLIC, anon, and authenticated on all 8 trusted server RPCs.
-- Preserve EXECUTE strictly for service_role.

-- 1. emergency_disable_ai
REVOKE ALL ON FUNCTION public.emergency_disable_ai(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emergency_disable_ai(uuid) TO service_role;
COMMENT ON FUNCTION public.emergency_disable_ai(uuid) IS
  'Trusted server-only RPC: instantly disables AI live channels for a company. Executable strictly by service_role after server-side actor and role verification.';

-- 2. resolve_ai_handover_case
REVOKE ALL ON FUNCTION public.resolve_ai_handover_case(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_ai_handover_case(uuid, uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.resolve_ai_handover_case(uuid, uuid, uuid) IS
  'Trusted server-only RPC: marks a handover case RESOLVED. Executable strictly by service_role after server-side actor and tenant verification.';

-- 3. claim_ai_handover_case
REVOKE ALL ON FUNCTION public.claim_ai_handover_case(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_handover_case(uuid, uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.claim_ai_handover_case(uuid, uuid, uuid) IS
  'Trusted server-only RPC: claims an open handover case for an agent. Executable strictly by service_role after server-side actor and tenant verification.';

-- 4. create_ai_handover_case
REVOKE ALL ON FUNCTION public.create_ai_handover_case(uuid, uuid, uuid, uuid, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_ai_handover_case(uuid, uuid, uuid, uuid, text, text, uuid, jsonb) TO service_role;
COMMENT ON FUNCTION public.create_ai_handover_case(uuid, uuid, uuid, uuid, text, text, uuid, jsonb) IS
  'Trusted server-only RPC: creates an AI handover case and pauses AI auto-reply. Executable strictly by service_role from backend live delivery engine or server actions.';

-- 5. resume_ai_conversation
REVOKE ALL ON FUNCTION public.resume_ai_conversation(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_ai_conversation(uuid, uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.resume_ai_conversation(uuid, uuid, uuid) IS
  'Trusted server-only RPC: resumes AI conversation auto-reply. Executable strictly by service_role after server-side actor and tenant verification.';

-- 6. record_ai_monitoring_alert
REVOKE ALL ON FUNCTION public.record_ai_monitoring_alert(uuid, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_monitoring_alert(uuid, text, text, text, text, text, text, jsonb) TO service_role;
COMMENT ON FUNCTION public.record_ai_monitoring_alert(uuid, text, text, text, text, text, text, jsonb) IS
  'Trusted server-only RPC: records or deduplicates monitoring alerts. Executable strictly by service_role from monitoring evaluator or background workers.';

-- 7. acknowledge_ai_monitoring_alert
REVOKE ALL ON FUNCTION public.acknowledge_ai_monitoring_alert(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_ai_monitoring_alert(uuid, uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.acknowledge_ai_monitoring_alert(uuid, uuid, uuid) IS
  'Trusted server-only RPC: acknowledges an active alert. Executable strictly by service_role after server-side actor and role verification.';

-- 8. resolve_ai_monitoring_alert
REVOKE ALL ON FUNCTION public.resolve_ai_monitoring_alert(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_ai_monitoring_alert(uuid, uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.resolve_ai_monitoring_alert(uuid, uuid, uuid) IS
  'Trusted server-only RPC: marks a monitoring alert RESOLVED. Executable strictly by service_role after server-side actor and role verification.';
