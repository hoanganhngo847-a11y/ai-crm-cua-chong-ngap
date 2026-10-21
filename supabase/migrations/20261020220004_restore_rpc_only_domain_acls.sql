-- Restore bounded RPC-only access after broad core grants reopened these domains.
-- Preserve existing rows, RLS, and EXECUTE grants on SECURITY DEFINER RPCs.
REVOKE ALL ON public.response_sla_windows FROM service_role;
REVOKE ALL ON public.ai_analyses, public.sales_style_profiles FROM service_role;
NOTIFY pgrst, 'reload schema';
