-- Forward-only security metadata hardening. No policy or data changes.
-- public is trusted: the RLS foundation revokes CREATE from browser roles.
-- Explicit pg_temp last prevents temporary relations from taking precedence.
-- Legacy-module removal drops nine of these functions later in the chain.
-- Use a fixed allowlist so this metadata-only change supports both schemas.
DO $hardening$
DECLARE
  signature text;
  target regprocedure;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.generate_customer_code()',
    'public.generate_order_code()',
    'public.update_updated_at_column()',
    'public.enforce_strict_append_only()',
    'public.enforce_contracts_immutability()',
    'public.prevent_tenant_mutation()',
    'public.enforce_user_profiles_immutability()',
    'public.enforce_company_members_immutability()',
    'public.enforce_customers_immutability()',
    'public.enforce_cpc_immutability()',
    'public.enforce_appointments_immutability()',
    'public.enforce_surveys_integrity()',
    'public.enforce_pricing_policies_immutability()',
    'public.enforce_price_calculations_immutability()',
    'public.enforce_orders_immutability()',
    'public.enforce_payment_facts_immutability()',
    'public.enforce_installations_integrity()',
    'public.enforce_care_deliveries_immutability()',
    'public.prevent_user_profile_status_mutation()'
  ] LOOP
    target := to_regprocedure(signature);
    IF target IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', target);
    END IF;
  END LOOP;
END;
$hardening$;

-- Trigger entry point, not an RPC. PostgreSQL triggers do not require the
-- inserting role to have EXECUTE on the trigger function at execution time.
-- Keep owner/auth-admin privileges and the auth.users trigger intact.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- These backend-only tables already deny browser ACLs, but missed RLS.
-- service_role and owner-executed RPCs retain access; no browser policy needed.
-- Existence checks also support verification against the 21-migration prefix.
DO $rls$
BEGIN
  IF to_regclass('private.zalo_oa_secrets') IS NOT NULL THEN
    ALTER TABLE private.zalo_oa_secrets ENABLE ROW LEVEL SECURITY;
  END IF;
  IF to_regclass('private.zalo_outbound_payloads') IS NOT NULL THEN
    ALTER TABLE private.zalo_outbound_payloads ENABLE ROW LEVEL SECURITY;
  END IF;
  IF to_regclass('public.customer_stage_migration_audit') IS NOT NULL THEN
    ALTER TABLE public.customer_stage_migration_audit ENABLE ROW LEVEL SECURITY;
  END IF;
END;
$rls$;

-- Keep the tenant-filtered safe_staff_directory projection and RLS helpers:
-- making that view invoker would hide same-company staff behind self-only RLS.
