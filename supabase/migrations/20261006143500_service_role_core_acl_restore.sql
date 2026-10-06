-- ==============================================================================
-- Migration: Restore trusted service_role ACL for core public application tables
--
-- Context:
-- Historical core tables were created without explicit service_role DML grants.
-- The trusted server admin client uses SUPABASE_SERVICE_ROLE_KEY and is expected
-- to perform server-authorized reads/writes after independently validating the
-- caller's identity, active membership, role, company scope, and resource scope.
--
-- Security boundaries preserved:
-- - Does NOT grant anything to anon.
-- - Does NOT widen authenticated privileges.
-- - Does NOT disable or alter RLS.
-- - Does NOT grant blanket access to the private schema.
-- - Does NOT grant blanket EXECUTE on routines.
-- - Grants only DML on explicitly enumerated core public tables currently missing
--   service_role ACL, plus sequence access required by generated customer/order codes.
-- ==============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.ai_analyses,
  public.appointments,
  public.audit_logs,
  public.call_attempts,
  public.calls,
  public.care_campaigns,
  public.care_deliveries,
  public.care_schedules,
  public.companies,
  public.company_bank_accounts,
  public.company_members,
  public.contracts,
  public.conversations,
  public.customer_stage_histories,
  public.customers,
  public.finance_summaries,
  public.identities,
  public.installations,
  public.interactions,
  public.orders,
  public.payment_transactions,
  public.price_calculations,
  public.pricing_policies,
  public.production_orders,
  public.response_sla_windows,
  public.sales_style_profiles,
  public.surveys,
  public.user_profiles,
  public.warranty_tickets
TO service_role;

-- Defaults on customers.customer_code and orders.order_code call nextval().
-- USAGE + SELECT is sufficient for normal sequence-backed inserts/currval access;
-- UPDATE/setval is intentionally not granted.
GRANT USAGE, SELECT ON SEQUENCE
  public.customer_code_seq,
  public.order_code_seq
TO service_role;
