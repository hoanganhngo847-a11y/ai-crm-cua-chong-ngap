-- ==============================================================================
-- Migration 002: Row Level Security (RLS) Foundation & Access Control
-- ==============================================================================
-- Architecture Baseline:
--   - docs/PROJECT_MASTER.md
--   - docs/DATA_CONTRACT.md
--   - docs/AUTH_DESIGN.md
--   - docs/SUPABASE_SCHEMA_DESIGN.md
--   - docs/SUPABASE_RLS_DESIGN.md
--
-- Scope:
--   - Small, auditable, hardened PostgreSQL authorization helpers (SECURITY DEFINER / STABLE)
--   - Least-privilege role permissions & Category A/B grants/revokes
--   - Restricted Safe Staff Directory view
--   - Full RLS activation on all 30 application tables (28 public, 2 private)
--   - Table-by-table RLS policies enforcing tenant isolation and role boundaries
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. AUTHORIZATION HELPER FUNCTIONS
-- ------------------------------------------------------------------------------

-- Helper 1: Check if current authenticated user has an ACTIVE membership in target company
-- and the user's global profile status is ACTIVE.
CREATE OR REPLACE FUNCTION public.is_active_member(target_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.user_profiles up ON up.id = cm.user_id
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = target_company_id
      AND cm.status = 'ACTIVE'
      AND up.status = 'ACTIVE'
  );
$$;

-- Helper 2: Check if current authenticated user has an ACTIVE membership with specific role
-- in target company and the user's global profile status is ACTIVE.
CREATE OR REPLACE FUNCTION public.has_company_role(target_company_id uuid, required_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.user_profiles up ON up.id = cm.user_id
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = target_company_id
      AND cm.role = required_role
      AND cm.status = 'ACTIVE'
      AND up.status = 'ACTIVE'
  );
$$;

-- Helper 3: Check if current authenticated user is an ACTIVE technician assigned to target appointment
-- in an actionable lifecycle state (ASSIGNED, ACCEPTED, IN_PROGRESS).
CREATE OR REPLACE FUNCTION public.is_assigned_technician(target_appointment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.appointments a
    JOIN public.company_members cm ON cm.user_id = a.assignee_id AND cm.company_id = a.company_id
    JOIN public.user_profiles up ON up.id = cm.user_id
    WHERE a.id = target_appointment_id
      AND a.assignee_id = auth.uid()
      AND cm.role = 'TECHNICIAN'
      AND cm.status = 'ACTIVE'
      AND up.status = 'ACTIVE'
      AND a.status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS')
  );
$$;

-- Helper 4: Check if target membership belongs to current authenticated user.
CREATE OR REPLACE FUNCTION public.is_self_membership(target_member_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.id = target_member_id
      AND cm.user_id = auth.uid()
  );
$$;

-- Restrict execution on helper functions
REVOKE ALL ON FUNCTION public.is_active_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_member(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.has_company_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_company_role(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.is_assigned_technician(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_assigned_technician(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.is_self_membership(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_self_membership(uuid) TO authenticated;

-- ------------------------------------------------------------------------------
-- 2. DATABASE GRANTS & SECURITY HARDENING
-- ------------------------------------------------------------------------------

-- Schema object creation restriction
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- Anon role fail-closed: revoke all CRM table, routine, and sequence access
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Explicitly revoke dangerous non-DML privileges (TRUNCATE, TRIGGER, REFERENCES) from browser roles
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated, anon;

-- System-wide prohibition on hard DELETE for client roles (Section 17.2)
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM authenticated, anon;

-- Category B / System-Only creation: client direct INSERT prohibited for all roles
REVOKE INSERT ON public.contracts FROM authenticated;
REVOKE INSERT ON public.installations FROM authenticated;
REVOKE INSERT ON public.user_profiles FROM authenticated;

-- Sequences hardening: authenticated only needs USAGE/SELECT for code generation, never UPDATE (setval)
REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM authenticated;

-- Category A: Column-level update restriction on user_profiles
REVOKE UPDATE ON public.user_profiles FROM authenticated;
GRANT UPDATE (full_name) ON public.user_profiles TO authenticated;

-- Category E: Immutable status trigger on user_profiles for authenticated clients
CREATE OR REPLACE FUNCTION public.prevent_user_profile_status_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'authenticated' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'user_profiles.status cannot be updated directly (Category E security rule)';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_user_profile_status_mutation() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_user_profiles_status_mutation ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_status_mutation
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_user_profile_status_mutation();

-- Category B: Safe Server-Only Mutation restrictions from direct authenticated client
REVOKE INSERT, UPDATE, DELETE ON public.company_members FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.audit_logs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.customer_stage_histories FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.call_transcripts FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.calls FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.call_attempts FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.ai_analyses FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.price_calculations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payment_transactions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.production_orders FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.finance_summaries FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.care_deliveries FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.orders FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.interactions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.sales_style_profiles FROM authenticated;

-- ------------------------------------------------------------------------------
-- 3. RESTRICTED SAFE STAFF DIRECTORY VIEW
-- ------------------------------------------------------------------------------
-- RLS DECISION 01: SALE and TECHNICIAN access safe same-company staff directory only.
-- Explicit allowlist: id, display_name, role, avatar_url.
-- No login email, phone, auth metadata, address, or sensitive fields.
CREATE OR REPLACE VIEW public.safe_staff_directory
WITH (security_invoker = false)
AS
SELECT
  cm.user_id AS id,
  up.full_name AS display_name,
  cm.role,
  NULL::text AS avatar_url
FROM public.company_members cm
JOIN public.user_profiles up ON up.id = cm.user_id
WHERE cm.status = 'ACTIVE'
  AND up.status = 'ACTIVE'
  AND public.is_active_member(cm.company_id);

REVOKE ALL ON public.safe_staff_directory FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.safe_staff_directory TO authenticated;

-- ------------------------------------------------------------------------------
-- 4. ENABLE ROW LEVEL SECURITY ON ALL PHYSICAL APPLICATION TABLES
-- ------------------------------------------------------------------------------

-- Public Schema (28 Tables)
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_stage_histories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_style_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warranty_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Private Schema (2 Tables)
ALTER TABLE private.customer_private_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.interaction_raw_contents ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY POLICIES
-- ------------------------------------------------------------------------------

-- 1. companies
CREATE POLICY companies_select_active_member
  ON public.companies
  FOR SELECT
  TO authenticated
  USING (public.is_active_member(id));

CREATE POLICY companies_update_boss_admin
  ON public.companies
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(id, 'BOSS_ADMIN'));

-- 2. user_profiles
CREATE POLICY user_profiles_select_self
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY user_profiles_update_self
  ON public.user_profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- 3. company_members
-- Non-recursive: self reads directly, boss reads via SECURITY DEFINER helper
CREATE POLICY company_members_select_boss_admin
  ON public.company_members
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY company_members_select_self
  ON public.company_members
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- 4. customers
CREATE POLICY customers_select_boss_admin
  ON public.customers
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY customers_select_sale
  ON public.customers
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY customers_insert_boss_admin
  ON public.customers
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY customers_insert_sale
  ON public.customers
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

CREATE POLICY customers_update_boss_admin
  ON public.customers
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY customers_update_sale
  ON public.customers
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'))
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

-- 5. customer_stage_histories (Strict Append-Only)
CREATE POLICY customer_stage_histories_select_boss_admin
  ON public.customer_stage_histories
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY customer_stage_histories_select_sale
  ON public.customer_stage_histories
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

-- 6. identities
CREATE POLICY identities_select_boss_admin
  ON public.identities
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY identities_select_sale
  ON public.identities
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY identities_insert_boss_admin
  ON public.identities
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY identities_insert_sale
  ON public.identities
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

CREATE POLICY identities_update_boss_admin
  ON public.identities
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY identities_update_sale
  ON public.identities
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'))
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

-- 7. interactions (Sanitized Derivative Security Zone)
-- RLS DECISION 05: BOSS sees all interactions; SALE sees only SUCCEEDED.
-- PENDING, FAILED, and NOT_REQUIRED are hidden from SALE (Fail-Closed).
CREATE POLICY interactions_select_boss_admin
  ON public.interactions
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY interactions_select_sale
  ON public.interactions
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'SALE')
    AND sanitization_status = 'SUCCEEDED'
  );

-- 8. conversations
CREATE POLICY conversations_select_boss_admin
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY conversations_select_sale
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY conversations_insert_boss_admin
  ON public.conversations
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY conversations_insert_sale
  ON public.conversations
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

CREATE POLICY conversations_update_boss_admin
  ON public.conversations
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY conversations_update_sale
  ON public.conversations
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'))
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

-- 9. calls (Metadata only)
CREATE POLICY calls_select_boss_admin
  ON public.calls
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY calls_select_sale
  ON public.calls
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

-- 10. call_attempts
CREATE POLICY call_attempts_select_boss_admin
  ON public.call_attempts
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY call_attempts_select_sale
  ON public.call_attempts
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

-- 11. call_transcripts
-- RLS DECISION 03: Raw transcript is restricted to BOSS_ADMIN audit only.
-- SALE receives sanitized derivative via Server DTO only. Direct base-table SELECT denied to SALE.
CREATE POLICY call_transcripts_select_boss_admin
  ON public.call_transcripts
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- 12. appointments
CREATE POLICY appointments_select_boss_admin
  ON public.appointments
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY appointments_select_sale
  ON public.appointments
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY appointments_select_assigned_technician
  ON public.appointments
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'TECHNICIAN')
    AND assignee_id = auth.uid()
    AND status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS')
  );

CREATE POLICY appointments_insert_boss_admin
  ON public.appointments
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY appointments_insert_sale
  ON public.appointments
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

CREATE POLICY appointments_update_boss_admin
  ON public.appointments
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY appointments_update_sale
  ON public.appointments
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'))
  WITH CHECK (public.has_company_role(company_id, 'SALE'));



-- 13. surveys
-- RLS DECISION 02 & AUTH DECISION 05: Tech authorization derives strictly from active appointment assignment.
-- completed_by is historical audit only and never grants access.
CREATE POLICY surveys_select_boss_admin
  ON public.surveys
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY surveys_select_sale
  ON public.surveys
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY surveys_select_assigned_technician
  ON public.surveys
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'TECHNICIAN')
    AND public.is_assigned_technician(appointment_id)
  );

CREATE POLICY surveys_insert_boss_admin
  ON public.surveys
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY surveys_insert_assigned_technician
  ON public.surveys
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_company_role(company_id, 'TECHNICIAN')
    AND public.is_assigned_technician(appointment_id)
  );

CREATE POLICY surveys_update_boss_admin
  ON public.surveys
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY surveys_update_assigned_technician
  ON public.surveys
  FOR UPDATE
  TO authenticated
  USING (
    public.has_company_role(company_id, 'TECHNICIAN')
    AND public.is_assigned_technician(appointment_id)
  )
  WITH CHECK (
    public.has_company_role(company_id, 'TECHNICIAN')
    AND public.is_assigned_technician(appointment_id)
  );

-- 14. pricing_policies
-- Master pricing rules & formulas: strictly exclusive to BOSS_ADMIN. SALE & TECH denied.
CREATE POLICY pricing_policies_select_boss_admin
  ON public.pricing_policies
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY pricing_policies_insert_boss_admin
  ON public.pricing_policies
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY pricing_policies_update_boss_admin
  ON public.pricing_policies
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- 15. price_calculations (Immutable Snapshot created by Pricing Engine)
CREATE POLICY price_calculations_select_boss_admin
  ON public.price_calculations
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY price_calculations_select_sale
  ON public.price_calculations
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

-- 16. orders
-- RLS DECISION 04: BOSS_ADMIN has direct SELECT. SALE reads commercial fields via trusted Server DTO.
-- Browser direct mutations denied.
CREATE POLICY orders_select_boss_admin
  ON public.orders
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- 17. payment_transactions
-- Provider banking facts: exclusive to BOSS_ADMIN reconciliation. SALE & TECH denied.
CREATE POLICY payment_transactions_select_boss_admin
  ON public.payment_transactions
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- 18. contracts
CREATE POLICY contracts_select_boss_admin
  ON public.contracts
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY contracts_select_sale
  ON public.contracts
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY contracts_update_boss_admin
  ON public.contracts
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));



-- 19. production_orders
CREATE POLICY production_orders_select_boss_admin
  ON public.production_orders
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY production_orders_select_sale
  ON public.production_orders
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

-- 20. installations
CREATE POLICY installations_select_boss_admin
  ON public.installations
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY installations_select_sale
  ON public.installations
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY installations_select_assigned_technician
  ON public.installations
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'TECHNICIAN')
    AND public.is_assigned_technician(appointment_id)
  );

CREATE POLICY installations_update_boss_admin
  ON public.installations
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));



-- 21. finance_summaries
-- Aggregated company finances: exclusive to BOSS_ADMIN. SALE & TECH denied.
CREATE POLICY finance_summaries_select_boss_admin
  ON public.finance_summaries
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- 22. care_campaigns
CREATE POLICY care_campaigns_select_boss_admin
  ON public.care_campaigns
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY care_campaigns_select_sale
  ON public.care_campaigns
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY care_campaigns_insert_boss_admin
  ON public.care_campaigns
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY care_campaigns_insert_sale
  ON public.care_campaigns
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

CREATE POLICY care_campaigns_update_boss_admin
  ON public.care_campaigns
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY care_campaigns_update_sale
  ON public.care_campaigns
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'))
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

-- 23. care_deliveries
CREATE POLICY care_deliveries_select_boss_admin
  ON public.care_deliveries
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY care_deliveries_select_sale
  ON public.care_deliveries
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

-- 24. care_schedules
CREATE POLICY care_schedules_select_boss_admin
  ON public.care_schedules
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY care_schedules_select_sale
  ON public.care_schedules
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY care_schedules_insert_boss_admin
  ON public.care_schedules
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY care_schedules_insert_sale
  ON public.care_schedules
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

CREATE POLICY care_schedules_update_boss_admin
  ON public.care_schedules
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY care_schedules_update_sale
  ON public.care_schedules
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'))
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

-- 25. ai_analyses
CREATE POLICY ai_analyses_select_boss_admin
  ON public.ai_analyses
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY ai_analyses_select_sale
  ON public.ai_analyses
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

-- 26. sales_style_profiles
CREATE POLICY sales_style_profiles_select_boss_admin
  ON public.sales_style_profiles
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY sales_style_profiles_select_sale
  ON public.sales_style_profiles
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'SALE')
    AND sale_user_id = auth.uid()
  );

-- 27. warranty_tickets
CREATE POLICY warranty_tickets_select_boss_admin
  ON public.warranty_tickets
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY warranty_tickets_select_sale
  ON public.warranty_tickets
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'SALE'));

CREATE POLICY warranty_tickets_select_assigned_technician
  ON public.warranty_tickets
  FOR SELECT
  TO authenticated
  USING (
    public.has_company_role(company_id, 'TECHNICIAN')
    AND assigned_to = auth.uid()
  );

CREATE POLICY warranty_tickets_insert_boss_admin
  ON public.warranty_tickets
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));

CREATE POLICY warranty_tickets_insert_sale
  ON public.warranty_tickets
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_company_role(company_id, 'SALE'));

CREATE POLICY warranty_tickets_update_boss_admin
  ON public.warranty_tickets
  FOR UPDATE
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'))
  WITH CHECK (public.has_company_role(company_id, 'BOSS_ADMIN'));



-- 28. audit_logs (Strict Append-Only)
CREATE POLICY audit_logs_select_boss_admin
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

-- Private Schema tables (customer_private_contacts, interaction_raw_contents)
-- have RLS enabled with ZERO policies for anon/authenticated (fail-closed, server-only).

-- ==============================================================================
-- END OF MIGRATION 002
-- ==============================================================================
