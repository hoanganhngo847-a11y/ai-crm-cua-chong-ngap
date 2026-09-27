-- ==============================================================================
-- Migration 001: Physical Database Schema Baseline
-- ==============================================================================
-- Architecture Baseline Commit: baf4b78
-- Documents:
--   - docs/PROJECT_MASTER.md
--   - docs/DATA_CONTRACT.md
--   - docs/AUTH_DESIGN.md
--   - docs/SUPABASE_SCHEMA_DESIGN.md
--   - docs/SUPABASE_RLS_DESIGN.md
--
-- Scope: Physical Schema Baseline Only (30 application tables: 28 public, 2 private)
-- Security: Fail-closed, Zero-phone in public schema, Raw interaction isolation,
--           Category E immutable relationship protection, Tenant boundaries.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EXTENSIONS
-- ------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ------------------------------------------------------------------------------
-- 2. SCHEMAS
-- ------------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

-- ------------------------------------------------------------------------------
-- 3. GLOBAL SEQUENCES
-- ------------------------------------------------------------------------------
-- Native PostgreSQL sequences for concurrency-safe, zero-lock human-readable codes
CREATE SEQUENCE IF NOT EXISTS public.customer_code_seq
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1;

CREATE SEQUENCE IF NOT EXISTS public.order_code_seq
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1;

-- ------------------------------------------------------------------------------
-- 4. UTILITY & INTEGRITY HELPER FUNCTIONS
-- ------------------------------------------------------------------------------

-- Canonical E.164 Phone Normalization (+84XXXXXXXXX for Vietnam)
CREATE OR REPLACE FUNCTION public.normalize_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_cleaned text;
BEGIN
  -- Strip all non-digit and non-plus characters
  v_cleaned := regexp_replace(p_phone, '[^0-9+]', '', 'g');

  -- Format Vietnam numbers starting with 0 (9-10 digits following)
  IF v_cleaned ~ '^0[1-9][0-9]{8}$' THEN
    v_cleaned := '+84' || substr(v_cleaned, 2);
  -- Format Vietnam numbers starting with 84 without plus
  ELSIF v_cleaned ~ '^84[1-9][0-9]{8}$' THEN
    v_cleaned := '+' || v_cleaned;
  -- Variable length domestic numbers starting with 0
  ELSIF v_cleaned ~ '^0[1-9][0-9]{7,13}$' THEN
    v_cleaned := '+84' || substr(v_cleaned, 2);
  -- Variable length domestic numbers starting with 84 without plus
  ELSIF v_cleaned ~ '^84[1-9][0-9]{7,13}$' THEN
    v_cleaned := '+' || v_cleaned;
  -- International standard E.164 with plus
  ELSIF v_cleaned ~ '^\+[1-9][0-9]{7,14}$' THEN
    NULL;
  ELSE
    -- Return cleaned value if other pattern
    RETURN v_cleaned;
  END IF;

  RETURN v_cleaned;
END;
$$;

-- Code Generation Helpers
CREATE OR REPLACE FUNCTION public.generate_customer_code()
RETURNS text
LANGUAGE sql
AS $$
  SELECT 'KH-' || lpad(nextval('public.customer_code_seq')::text, 6, '0');
$$;

CREATE OR REPLACE FUNCTION public.generate_order_code()
RETURNS text
LANGUAGE sql
AS $$
  SELECT 'DH-' || lpad(nextval('public.order_code_seq')::text, 6, '0');
$$;

-- Timestamp Auto-update Trigger Function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Strict Append-Only Enforcement Trigger Function
CREATE OR REPLACE FUNCTION public.enforce_strict_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Table % is strict append-only; UPDATE and DELETE operations are prohibited', TG_TABLE_NAME;
END;
$$;

-- Helper to recursively check forbidden phone keys and phone number scalars in JSONB metadata
CREATE OR REPLACE FUNCTION public.jsonb_has_phone_data(p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_type text;
  v_key text;
  v_elem jsonb;
  v_str text;
  v_cleaned text;
BEGIN
  v_type := jsonb_typeof(p_data);

  IF v_type = 'object' THEN
    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      IF v_key IN ('raw_phone', 'normalized_phone') THEN
        RETURN true;
      END IF;
      IF public.jsonb_has_phone_data(p_data -> v_key) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF v_type = 'array' THEN
    FOR v_elem IN SELECT jsonb_array_elements(p_data) LOOP
      IF public.jsonb_has_phone_data(v_elem) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF v_type = 'string' THEN
    v_str := trim(p_data #>> '{}');
    -- Strip common phone formatting separators: spaces, hyphens, dots, parentheses
    v_cleaned := regexp_replace(v_str, '[ \-\.\(\)]', '', 'g');

    -- Whole-scalar phone patterns:
    -- 1. Vietnam domestic mobile: 0 + [1-9] + 8 digits (10 digits total)
    -- 2. Vietnam country-code: 84 + [1-9] + 8 digits (10 digits total)
    -- 3. International E.164: + + [1-9] + 7 to 14 digits
    IF v_cleaned ~ '^0[1-9][0-9]{8}$'
       OR v_cleaned ~ '^84[1-9][0-9]{8}$'
       OR v_cleaned ~ '^\+[1-9][0-9]{7,14}$' THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$$;

-- ==============================================================================
-- 5. PHYSICAL TABLES (30 TABLES IN DEPENDENCY-SAFE ORDER)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- GROUP 1: FOUNDATION & USERS
-- ------------------------------------------------------------------------------

-- 1. companies
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. user_profiles
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. company_members
CREATE TABLE public.company_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('BOSS_ADMIN', 'SALE', 'TECHNICIAN')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_members_company_user UNIQUE (company_id, user_id)
);

-- ------------------------------------------------------------------------------
-- GROUP 2: CUSTOMER PROFILE & SECURITY ZONES
-- ------------------------------------------------------------------------------

-- 4. customers
-- ZERO-PHONE INVARIANT: No phone, raw_phone, or normalized_phone columns.
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_code text NOT NULL DEFAULT public.generate_customer_code(),
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('FACEBOOK', 'ZALO', 'ZALO_OA', 'WEBSITE', 'HOTLINE', 'ADVERTISING', 'MANUAL')),
  stage text NOT NULL CHECK (stage IN (
    'LEAD_NEW',
    'CONTACT_CYCLE_1',
    'CONTACT_CYCLE_2',
    'CONTACT_CYCLE_3',
    'UNREACHABLE',
    'SURVEY_REQUESTED',
    'SURVEY_SCHEDULED',
    'SURVEY_COMPLETED',
    'PRICE_CALCULATED',
    'NEED_INFO',
    'PRICE_OFFERED',
    'NEGOTIATING',
    'ORDER_CREATED',
    'DEPOSIT_CONFIRMED',
    'CONTRACT_SIGNED',
    'IN_PRODUCTION',
    'READY_FOR_INSTALL',
    'INSTALLING',
    'HANDOVER_COMPLETED',
    'WARRANTY_ACTIVE',
    'LOST',
    'CARE_NURTURING'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customers_company_code UNIQUE (company_id, customer_code),
  CONSTRAINT uq_customers_company_id UNIQUE (company_id, id)
);

-- 5. private.customer_private_contacts
-- Isolated in private schema; stores raw and normalized phone.
CREATE TABLE private.customer_private_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL UNIQUE,
  normalized_phone text NOT NULL CHECK (normalized_phone ~ '^\+[1-9][0-9]{7,14}$'),
  raw_phone text NOT NULL,
  phone_country_code text NOT NULL DEFAULT 'VN',
  is_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_cpc_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_cpc_company_normalized_phone UNIQUE (company_id, normalized_phone)
);

-- 6. customer_stage_histories (Strict Append-Only)
CREATE TABLE public.customer_stage_histories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  from_stage text NULL,
  to_stage text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('USER', 'AI', 'SYSTEM')),
  changed_by_user_id uuid NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  source_ref text NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_csh_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT
);

-- 7. identities
-- Phone external_id must store Keyed HMAC, never raw or normalized phone.
CREATE TABLE public.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('ZALO', 'FACEBOOK', 'WEBSITE', 'PHONE')),
  external_id text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_identities_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_identities_channel_external UNIQUE (company_id, channel, external_id),
  CONSTRAINT chk_identities_phone_external_id CHECK (channel <> 'PHONE' OR external_id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_identities_metadata_no_phone_data CHECK (NOT public.jsonb_has_phone_data(metadata))
);

-- ------------------------------------------------------------------------------
-- GROUP 3: COMMUNICATION & INBOXES
-- ------------------------------------------------------------------------------

-- 8. conversations
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('ZALO', 'FACEBOOK')),
  external_conversation_id text NOT NULL,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PENDING_SALE', 'AI_HANDLING', 'CLOSED')),
  assigned_to uuid NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_conversations_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_conversations_channel_ext UNIQUE (company_id, channel, external_conversation_id),
  CONSTRAINT uq_conversations_company_customer_id UNIQUE (company_id, customer_id, id)
);

-- 9. interactions (Sanitized Derivative Security Zone)
CREATE TABLE public.interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  conversation_id uuid NULL,
  channel text NOT NULL CHECK (channel IN ('ZALO', 'FACEBOOK', 'WEBSITE', 'HOTLINE', 'PHONE', 'AI_VOICE')),
  type text NOT NULL CHECK (type IN ('MESSAGE', 'CALL_EVENT', 'NOTE', 'STATUS_EVENT', 'APPOINTMENT_EVENT')),
  direction text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  sanitized_content text NULL,
  sanitization_status text NOT NULL DEFAULT 'PENDING' CHECK (sanitization_status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'NOT_REQUIRED')),
  sanitized_at timestamptz NULL,
  sanitizer_version text NULL,
  external_ref text NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('CUSTOMER', 'SALE', 'TECHNICIAN', 'AI', 'SYSTEM')),
  actor_user_id uuid NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_interactions_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_interactions_conversation FOREIGN KEY (company_id, customer_id, conversation_id)
    REFERENCES public.conversations(company_id, customer_id, id) ON DELETE RESTRICT
);

-- 9b. private.interaction_raw_contents (Raw Interaction Security Zone)
CREATE TABLE private.interaction_raw_contents (
  interaction_id uuid PRIMARY KEY REFERENCES public.interactions(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  raw_content text NOT NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 10. calls
CREATE TABLE public.calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  agent_type text NOT NULL CHECK (agent_type IN ('AI', 'SALE')),
  provider text NOT NULL DEFAULT 'MANUAL' CHECK (provider IN ('MANUAL', 'STRINGEE', 'VIETTEL', 'TWILIO', 'VINFON')),
  provider_call_id text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  status text NOT NULL CHECK (status IN ('INITIATED', 'RINGING', 'CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'COMPLETED')),
  recording_ref text NULL,
  transcript_status text NOT NULL CHECK (transcript_status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_calls_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_calls_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_calls_company_customer_id UNIQUE (company_id, customer_id, id)
);

-- 11. call_attempts
CREATE TABLE public.call_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  contact_cycle_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no IN (1, 2, 3)),
  scheduled_at timestamptz NOT NULL,
  called_at timestamptz NULL,
  result text NOT NULL CHECK (result IN ('PENDING', 'NO_ANSWER', 'BUSY', 'ANSWERED', 'FAILED', 'CANCELLED')),
  call_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_call_attempts_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_call_attempts_call FOREIGN KEY (company_id, customer_id, call_id)
    REFERENCES public.calls(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_call_attempts_cycle_attempt UNIQUE (company_id, customer_id, contact_cycle_id, attempt_no)
);

-- 12. call_transcripts
CREATE TABLE public.call_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  call_id uuid NOT NULL UNIQUE,
  transcript text NOT NULL,
  speakers jsonb NOT NULL DEFAULT '[]'::jsonb,
  processed_at timestamptz NOT NULL DEFAULT now(),
  language text NOT NULL DEFAULT 'vi',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_call_transcripts_call FOREIGN KEY (company_id, call_id)
    REFERENCES public.calls(company_id, id) ON DELETE RESTRICT
);

-- ------------------------------------------------------------------------------
-- GROUP 4: FIELD OPS, PRICING & CALCULATIONS
-- ------------------------------------------------------------------------------

-- 13. appointments
CREATE TABLE public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('SURVEY', 'INSTALLATION')),
  start_time timestamptz NOT NULL,
  assignee_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  address text NOT NULL,
  status text NOT NULL CHECK (status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_appointments_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_appointments_company_customer_id UNIQUE (company_id, customer_id, id)
);

-- 14. surveys
-- Single-shot completion: appointment_id NOT NULL, completed_by/completed_at NOT NULL.
CREATE TABLE public.surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  completed_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  measurements jsonb NOT NULL,
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  site_condition text NOT NULL,
  notes text NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_surveys_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_surveys_appointment FOREIGN KEY (company_id, customer_id, appointment_id)
    REFERENCES public.appointments(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_surveys_company_customer_id UNIQUE (company_id, customer_id, id)
);

-- 15. pricing_policies
CREATE TABLE public.pricing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  version text NOT NULL,
  conditions jsonb NOT NULL,
  price_rules jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pricing_policies_version UNIQUE (company_id, version),
  CONSTRAINT uq_pricing_policies_company_id_version UNIQUE (company_id, id, version)
);

-- 16. price_calculations (Immutable Snapshot)
CREATE TABLE public.price_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  survey_id uuid NULL,
  pricing_policy_id uuid NOT NULL,
  policy_version text NOT NULL,
  input_data jsonb NOT NULL,
  amount numeric(15,2) NULL CHECK (amount IS NULL OR amount >= 0),
  status text NOT NULL CHECK (status IN ('CALCULATED', 'NEED_INFO', 'EXPIRED', 'SUPERSEDED')),
  missing_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_pc_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_pc_survey FOREIGN KEY (company_id, customer_id, survey_id)
    REFERENCES public.surveys(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_pc_policy_version FOREIGN KEY (company_id, pricing_policy_id, policy_version)
    REFERENCES public.pricing_policies(company_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT uq_price_calculations_company_customer_id UNIQUE (company_id, customer_id, id),
  CONSTRAINT chk_pc_need_info_amount CHECK ((status = 'NEED_INFO' AND amount IS NULL) OR (status <> 'NEED_INFO'))
);

-- ------------------------------------------------------------------------------
-- GROUP 5: COMMERCIAL, PAYMENTS & CONTRACTS
-- ------------------------------------------------------------------------------

-- 17. orders
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  order_code text NOT NULL DEFAULT public.generate_order_code(),
  payment_reference text NOT NULL,
  price_calculation_id uuid NOT NULL,
  deposit_status text NOT NULL CHECK (deposit_status IN ('PENDING', 'DEPOSIT_PENDING', 'CONFIRMED', 'DEPOSIT_CONFIRMED', 'REFUNDED')),
  order_status text NOT NULL CHECK (order_status IN (
    'DRAFT',
    'DEPOSIT_CONFIRMED',
    'CONTRACT_SIGNED',
    'IN_PRODUCTION',
    'READY_FOR_INSTALL',
    'INSTALLING',
    'HANDOVER_COMPLETED',
    'HANDED_OVER',
    'COMPLETED',
    'CANCELLED'
  )),
  final_amount numeric(15,2) NOT NULL CHECK (final_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_orders_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_pricing FOREIGN KEY (company_id, customer_id, price_calculation_id)
    REFERENCES public.price_calculations(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_orders_company_order_code UNIQUE (company_id, order_code),
  CONSTRAINT uq_orders_company_payment_ref UNIQUE (company_id, payment_reference),
  CONSTRAINT uq_orders_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_orders_company_customer_id UNIQUE (company_id, customer_id, id)
);

-- 18. payment_transactions
-- Idempotency: UNIQUE (company_id, provider, provider_ref). Masked provider_account.
CREATE TABLE public.payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_account text NOT NULL,
  provider_ref text NOT NULL,
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  occurred_at timestamptz NOT NULL,
  transfer_content text NOT NULL,
  matched_order_id uuid NULL,
  match_confidence numeric(3,2) NULL CHECK (match_confidence >= 0 AND match_confidence <= 1),
  status text NOT NULL CHECK (status IN ('PENDING', 'MATCHED', 'MANUAL_REVIEW_REQUIRED', 'REJECTED', 'RECONCILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_pt_matched_order FOREIGN KEY (company_id, matched_order_id)
    REFERENCES public.orders(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_pt_company_provider_ref UNIQUE (company_id, provider, provider_ref)
);

-- 19. contracts
CREATE TABLE public.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  revision_no integer NOT NULL DEFAULT 1 CHECK (revision_no >= 1),
  template_version text NOT NULL,
  generated_file_ref text NOT NULL,
  signed_file_ref text NULL,
  status text NOT NULL CHECK (status IN ('GENERATED', 'SENT_TO_CUSTOMER', 'SIGNED', 'REJECTED', 'SUPERSEDED')),
  contract_value numeric(15,2) NOT NULL CHECK (contract_value >= 0),
  signed_at timestamptz NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_contracts_order FOREIGN KEY (company_id, order_id)
    REFERENCES public.orders(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_contracts_order_revision UNIQUE (order_id, revision_no)
);

-- ------------------------------------------------------------------------------
-- GROUP 6: PRODUCTION, INSTALLATION & FINANCE
-- ------------------------------------------------------------------------------

-- 20. production_orders
CREATE TABLE public.production_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL UNIQUE,
  specs jsonb NOT NULL,
  materials jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_SPECS', 'RELEASED_TO_FACTORY', 'IN_PRODUCTION', 'QC_IN_PROGRESS', 'QC_PASSED', 'QC_FAILED', 'READY_FOR_DISPATCH')),
  deadline timestamptz NOT NULL,
  qc_status text NOT NULL CHECK (qc_status IN ('PENDING', 'PASSED', 'REWORK_REQUIRED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_production_orders_order FOREIGN KEY (company_id, order_id)
    REFERENCES public.orders(company_id, id) ON DELETE RESTRICT
);

-- 21. installations
-- Crew is descriptive snapshot jsonb; no separate crew member child table.
CREATE TABLE public.installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL UNIQUE,
  appointment_id uuid NOT NULL,
  crew jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('SCHEDULED', 'IN_TRANSIT', 'INSTALLING', 'TESTING', 'HANDOVER_PENDING', 'COMPLETED', 'FAILED')),
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  handover_ref text NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_installations_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_installations_order FOREIGN KEY (company_id, customer_id, order_id)
    REFERENCES public.orders(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_installations_appointment FOREIGN KEY (company_id, customer_id, appointment_id)
    REFERENCES public.appointments(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_installations_company_customer_order_id UNIQUE (company_id, customer_id, order_id, id)
);

-- 22. finance_summaries
CREATE TABLE public.finance_summaries (
  order_id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  contract_value numeric(15,2) NOT NULL DEFAULT 0 CHECK (contract_value >= 0),
  collected_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (collected_amount >= 0),
  receivable_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (receivable_amount >= 0),
  completed_revenue numeric(15,2) NOT NULL DEFAULT 0 CHECK (completed_revenue >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_summaries_order FOREIGN KEY (company_id, order_id)
    REFERENCES public.orders(company_id, id) ON DELETE RESTRICT
);

-- ------------------------------------------------------------------------------
-- GROUP 7: CARE CAMPAIGNS, AI & AFTER-SALES
-- ------------------------------------------------------------------------------

-- 23. care_campaigns
CREATE TABLE public.care_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('ZALO', 'FACEBOOK')),
  audience_rule jsonb NOT NULL,
  message_template text NOT NULL,
  started_at timestamptz NOT NULL,
  sent_count integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  delivered_count integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  response_count integer NOT NULL DEFAULT 0 CHECK (response_count >= 0),
  converted_to_sale_count integer NOT NULL DEFAULT 0 CHECK (converted_to_sale_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_care_campaigns_company_id UNIQUE (company_id, id)
);

-- 24. care_deliveries
-- Idempotency: UNIQUE (company_id, idempotency_key).
CREATE TABLE public.care_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  campaign_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('ZALO', 'FACEBOOK')),
  external_message_ref text NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RESPONDED', 'CONVERTED_TO_SALE', 'SKIPPED')),
  sent_at timestamptz NULL,
  delivered_at timestamptz NULL,
  responded_at timestamptz NULL,
  converted_to_sale_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_cd_campaign FOREIGN KEY (company_id, campaign_id)
    REFERENCES public.care_campaigns(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_cd_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_cd_company_idempotency_key UNIQUE (company_id, idempotency_key)
);

-- 25. care_schedules
CREATE TABLE public.care_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('ZALO', 'FACEBOOK')),
  frequency_months integer NOT NULL DEFAULT 1 CHECK (frequency_months >= 1),
  next_send_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  stop_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_cs_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_cs_customer_channel UNIQUE (company_id, customer_id, channel)
);

-- 26. ai_analyses
CREATE TABLE public.ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  source_refs jsonb NOT NULL,
  summary text NOT NULL,
  stage_suggestion text NULL,
  stop_reason text NULL,
  objections jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_action text NULL,
  confidence numeric(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence text NOT NULL,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_ai_analyses_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT
);

-- 27. sales_style_profiles
CREATE TABLE public.sales_style_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  sale_user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  version text NOT NULL,
  salutation_rules jsonb NOT NULL,
  sentence_style jsonb NOT NULL,
  question_style jsonb NOT NULL,
  objection_style jsonb NOT NULL,
  closing_style jsonb NOT NULL,
  examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ssp_company_version UNIQUE (company_id, version)
);

-- 28. warranty_tickets
CREATE TABLE public.warranty_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  installation_id uuid NULL,
  issue text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED')),
  assigned_to uuid NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_wt_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_wt_order FOREIGN KEY (company_id, customer_id, order_id)
    REFERENCES public.orders(company_id, customer_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_wt_installation FOREIGN KEY (company_id, customer_id, order_id, installation_id)
    REFERENCES public.installations(company_id, customer_id, order_id, id) ON DELETE RESTRICT
);

-- ------------------------------------------------------------------------------
-- GROUP 8: SECURITY & AUDIT
-- ------------------------------------------------------------------------------

-- 29. audit_logs (Strict Append-Only)
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  user_id uuid NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  customer_id uuid NULL,
  result text NOT NULL CHECK (result IN ('SUCCESS', 'DENIED', 'FAILED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_audit_logs_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id) ON DELETE RESTRICT
);

-- ==============================================================================
-- 6. INDEXES & PARTIAL INDEXES
-- ==============================================================================

-- companies
CREATE INDEX idx_companies_status ON public.companies (status);

-- user_profiles
CREATE INDEX idx_user_profiles_status ON public.user_profiles (status);

-- company_members
CREATE UNIQUE INDEX uq_company_members_single_active_sale
  ON public.company_members (company_id)
  WHERE role = 'SALE' AND status = 'ACTIVE';

CREATE INDEX idx_company_members_lookup
  ON public.company_members (user_id, company_id, status);

-- customers
CREATE INDEX idx_customers_company_stage
  ON public.customers (company_id, stage);

CREATE INDEX idx_customers_company_name_trgm
  ON public.customers USING gin (name gin_trgm_ops);

-- customer_stage_histories
CREATE INDEX idx_csh_customer_time
  ON public.customer_stage_histories (company_id, customer_id, changed_at DESC);

-- conversations
CREATE INDEX idx_conversations_inbox
  ON public.conversations (company_id, status, last_message_at DESC);

-- interactions
CREATE UNIQUE INDEX uq_interactions_company_channel_ext_ref
  ON public.interactions (company_id, channel, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE INDEX idx_interactions_timeline
  ON public.interactions (company_id, customer_id, created_at DESC);

CREATE INDEX idx_interactions_conversation
  ON public.interactions (conversation_id, created_at ASC)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX idx_interactions_sanitization
  ON public.interactions (company_id, sanitization_status);

-- private.interaction_raw_contents
CREATE INDEX idx_irc_company
  ON private.interaction_raw_contents (company_id);

-- calls
CREATE UNIQUE INDEX idx_calls_provider_call
  ON public.calls (company_id, provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;

CREATE INDEX idx_calls_lookup
  ON public.calls (company_id, customer_id, started_at DESC);

-- call_attempts
CREATE INDEX idx_call_attempts_scheduler
  ON public.call_attempts (company_id, result, scheduled_at)
  WHERE result = 'PENDING';

-- appointments
CREATE INDEX idx_appointments_technician
  ON public.appointments (company_id, assignee_id, start_time ASC);

-- pricing_policies
CREATE INDEX idx_pricing_policies_active
  ON public.pricing_policies (company_id, status)
  WHERE status = 'ACTIVE';

-- price_calculations
CREATE INDEX idx_price_calculations_customer
  ON public.price_calculations (company_id, customer_id, created_at DESC);

-- orders
CREATE INDEX idx_orders_customer
  ON public.orders (company_id, customer_id);

CREATE INDEX idx_orders_status
  ON public.orders (company_id, order_status);

-- payment_transactions
CREATE INDEX idx_payment_transactions_matched
  ON public.payment_transactions (company_id, matched_order_id)
  WHERE matched_order_id IS NOT NULL;

CREATE INDEX idx_payment_transactions_status
  ON public.payment_transactions (company_id, status, occurred_at DESC);

-- contracts
CREATE UNIQUE INDEX uq_contracts_order_current
  ON public.contracts (order_id)
  WHERE is_current = true;

CREATE INDEX idx_contracts_status
  ON public.contracts (company_id, status);

-- production_orders
CREATE INDEX idx_production_orders_status
  ON public.production_orders (company_id, status, deadline ASC);

-- installations
CREATE INDEX idx_installations_status
  ON public.installations (company_id, status);

-- finance_summaries
CREATE INDEX idx_finance_summaries_company
  ON public.finance_summaries (company_id);

-- care_campaigns
CREATE INDEX idx_care_campaigns_channel
  ON public.care_campaigns (company_id, channel, started_at DESC);

-- care_deliveries
CREATE INDEX idx_cd_status
  ON public.care_deliveries (company_id, status);

CREATE INDEX idx_cd_message_ref
  ON public.care_deliveries (company_id, external_message_ref)
  WHERE external_message_ref IS NOT NULL;

-- care_schedules
CREATE INDEX idx_cs_scheduler
  ON public.care_schedules (company_id, enabled, next_send_at ASC)
  WHERE enabled = true;

-- ai_analyses
CREATE INDEX idx_ai_analyses_customer
  ON public.ai_analyses (company_id, customer_id, created_at DESC);

-- sales_style_profiles
CREATE INDEX idx_ssp_lookup
  ON public.sales_style_profiles (company_id, sale_user_id, created_at DESC);

-- warranty_tickets
CREATE INDEX idx_warranty_tickets_status
  ON public.warranty_tickets (company_id, status);

CREATE INDEX idx_warranty_tickets_assigned
  ON public.warranty_tickets (company_id, assigned_to, status)
  WHERE assigned_to IS NOT NULL;

-- audit_logs
CREATE INDEX idx_audit_logs_company_time
  ON public.audit_logs (company_id, created_at DESC);

CREATE INDEX idx_audit_logs_resource
  ON public.audit_logs (company_id, resource_type, resource_id);

CREATE INDEX idx_audit_logs_user
  ON public.audit_logs (company_id, user_id, created_at DESC);

-- ==============================================================================
-- 7. CATEGORY E: IMMUTABLE TENANT & RELATIONSHIP INTEGRITY TRIGGERS
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 7.1. Generic Tenant Mutation Prevention
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_tenant_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'company_id is immutable on % (tenant boundary violation)', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- Apply generic tenant protection
CREATE TRIGGER trg_tenant_mutation_members BEFORE UPDATE ON public.company_members FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_customers BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_cpc BEFORE UPDATE ON private.customer_private_contacts FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_identities BEFORE UPDATE ON public.identities FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_conversations BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_interactions BEFORE UPDATE ON public.interactions FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_calls BEFORE UPDATE ON public.calls FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_attempts BEFORE UPDATE ON public.call_attempts FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_appointments BEFORE UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_surveys BEFORE UPDATE ON public.surveys FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_pricing BEFORE UPDATE ON public.pricing_policies FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_orders BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_payments BEFORE UPDATE ON public.payment_transactions FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_contracts BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_production BEFORE UPDATE ON public.production_orders FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_installations BEFORE UPDATE ON public.installations FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_finance BEFORE UPDATE ON public.finance_summaries FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_campaigns BEFORE UPDATE ON public.care_campaigns FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_deliveries BEFORE UPDATE ON public.care_deliveries FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_schedules BEFORE UPDATE ON public.care_schedules FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_ai BEFORE UPDATE ON public.ai_analyses FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_styles BEFORE UPDATE ON public.sales_style_profiles FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();
CREATE TRIGGER trg_tenant_mutation_warranty BEFORE UPDATE ON public.warranty_tickets FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_mutation();

-- ------------------------------------------------------------------------------
-- 7.2. Specific Parent & Core Identifier Immutability Triggers
-- ------------------------------------------------------------------------------

-- user_profiles: id immutable
CREATE OR REPLACE FUNCTION public.enforce_user_profiles_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'user_profiles.id is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_user_profiles_immutability
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_user_profiles_immutability();

-- company_members: user_id immutable
CREATE OR REPLACE FUNCTION public.enforce_company_members_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'company_members.user_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_company_members_immutability
  BEFORE UPDATE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_members_immutability();

-- customers: customer_code immutable
CREATE OR REPLACE FUNCTION public.enforce_customers_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_code IS DISTINCT FROM OLD.customer_code THEN
    RAISE EXCEPTION 'customers.customer_code is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_customers_immutability
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_customers_immutability();

-- private.customer_private_contacts: customer_id immutable
CREATE OR REPLACE FUNCTION public.enforce_cpc_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'customer_private_contacts.customer_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_cpc_immutability
  BEFORE UPDATE ON private.customer_private_contacts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cpc_immutability();

-- appointments: customer_id immutable, type immutable if referenced
CREATE OR REPLACE FUNCTION public.enforce_appointments_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'appointments.customer_id is immutable';
  END IF;
  IF NEW.type IS DISTINCT FROM OLD.type THEN
    IF EXISTS (SELECT 1 FROM public.surveys WHERE appointment_id = OLD.id)
       OR EXISTS (SELECT 1 FROM public.installations WHERE appointment_id = OLD.id) THEN
      RAISE EXCEPTION 'Cannot change appointment type when related survey or installation exists';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_appointments_immutability
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_appointments_immutability();

-- surveys: appointment type verification on insert, core fields immutable on update
CREATE OR REPLACE FUNCTION public.enforce_surveys_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.appointments a
      WHERE a.id = NEW.appointment_id
        AND a.company_id = NEW.company_id
        AND a.customer_id = NEW.customer_id
        AND a.type = 'SURVEY'
    ) THEN
      RAISE EXCEPTION 'Survey appointment must be of type SURVEY and belong to the same company and customer';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
       OR NEW.completed_by IS DISTINCT FROM OLD.completed_by
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'Survey customer_id, appointment_id, completed_by, and completed_at are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_surveys_integrity
  BEFORE INSERT OR UPDATE ON public.surveys
  FOR EACH ROW EXECUTE FUNCTION public.enforce_surveys_integrity();

-- pricing_policies: active policy core rules immutable, cannot revert to DRAFT
CREATE OR REPLACE FUNCTION public.enforce_pricing_policies_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'ACTIVE' THEN
    IF NEW.status = 'DRAFT' THEN
      RAISE EXCEPTION 'Active pricing policy cannot be reverted to DRAFT';
    END IF;
    IF NEW.version IS DISTINCT FROM OLD.version
       OR NEW.conditions IS DISTINCT FROM OLD.conditions
       OR NEW.price_rules IS DISTINCT FROM OLD.price_rules
       OR NEW.effective_at IS DISTINCT FROM OLD.effective_at THEN
      RAISE EXCEPTION 'Active pricing policy rules and version are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_pricing_policies_immutability
  BEFORE UPDATE ON public.pricing_policies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pricing_policies_immutability();

-- price_calculations: immutable snapshot
CREATE OR REPLACE FUNCTION public.enforce_price_calculations_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'price_calculations records are immutable snapshots and cannot be updated or deleted';
END;
$$;
CREATE TRIGGER trg_price_calculations_immutability
  BEFORE UPDATE OR DELETE ON public.price_calculations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_price_calculations_immutability();

-- orders: core relationship & sequence keys immutable
CREATE OR REPLACE FUNCTION public.enforce_orders_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.order_code IS DISTINCT FROM OLD.order_code
     OR NEW.price_calculation_id IS DISTINCT FROM OLD.price_calculation_id THEN
    RAISE EXCEPTION 'orders customer_id, order_code, and price_calculation_id are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_orders_immutability
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_orders_immutability();

-- payment_transactions: provider facts immutable
CREATE OR REPLACE FUNCTION public.enforce_payment_facts_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.transfer_content IS DISTINCT FROM OLD.transfer_content THEN
    RAISE EXCEPTION 'payment_transactions provider source facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_payment_facts_immutability
  BEFORE UPDATE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_facts_immutability();

-- contracts: signed contract immutability
CREATE OR REPLACE FUNCTION public.enforce_contracts_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'contracts.order_id is immutable';
  END IF;
  IF OLD.signed_file_ref IS NOT NULL OR OLD.status = 'SIGNED' THEN
    IF NEW.contract_value IS DISTINCT FROM OLD.contract_value
       OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
       OR NEW.template_version IS DISTINCT FROM OLD.template_version
       OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.generated_file_ref IS DISTINCT FROM OLD.generated_file_ref
       OR NEW.signed_file_ref IS DISTINCT FROM OLD.signed_file_ref THEN
      RAISE EXCEPTION 'Signed contract terms and file references are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_contracts_immutability
  BEFORE UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contracts_immutability();

-- installations: appointment type verification on insert, keys immutable on update
CREATE OR REPLACE FUNCTION public.enforce_installations_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.appointments a
      WHERE a.id = NEW.appointment_id
        AND a.company_id = NEW.company_id
        AND a.customer_id = NEW.customer_id
        AND a.type = 'INSTALLATION'
    ) THEN
      RAISE EXCEPTION 'Installation appointment must be of type INSTALLATION and belong to the same company and customer';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id THEN
      RAISE EXCEPTION 'installations customer_id, order_id, and appointment_id are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_installations_integrity
  BEFORE INSERT OR UPDATE ON public.installations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_installations_integrity();

-- care_deliveries: campaign, customer, idempotency_key immutable
CREATE OR REPLACE FUNCTION public.enforce_care_deliveries_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'care_deliveries customer_id, campaign_id, and idempotency_key are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_care_deliveries_immutability
  BEFORE UPDATE ON public.care_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_care_deliveries_immutability();

-- ------------------------------------------------------------------------------
-- 7.3. Strict Append-Only Triggers
-- ------------------------------------------------------------------------------
CREATE TRIGGER trg_append_only_audit_logs
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_strict_append_only();

CREATE TRIGGER trg_append_only_stage_histories
  BEFORE UPDATE OR DELETE ON public.customer_stage_histories
  FOR EACH ROW EXECUTE FUNCTION public.enforce_strict_append_only();

CREATE TRIGGER trg_append_only_raw_contents
  BEFORE UPDATE OR DELETE ON private.interaction_raw_contents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_strict_append_only();

-- ------------------------------------------------------------------------------
-- 7.4. Auto-update `updated_at` Triggers
-- ------------------------------------------------------------------------------
CREATE TRIGGER trg_updated_at_companies BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_user_profiles BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_customers BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_cpc BEFORE UPDATE ON private.customer_private_contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_identities BEFORE UPDATE ON public.identities FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_conversations BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_appointments BEFORE UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_surveys BEFORE UPDATE ON public.surveys FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_pricing_policies BEFORE UPDATE ON public.pricing_policies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_orders BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_payment_transactions BEFORE UPDATE ON public.payment_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_contracts BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_production_orders BEFORE UPDATE ON public.production_orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_installations BEFORE UPDATE ON public.installations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_finance_summaries BEFORE UPDATE ON public.finance_summaries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_care_campaigns BEFORE UPDATE ON public.care_campaigns FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_care_deliveries BEFORE UPDATE ON public.care_deliveries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_care_schedules BEFORE UPDATE ON public.care_schedules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_sales_style_profiles BEFORE UPDATE ON public.sales_style_profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_updated_at_warranty_tickets BEFORE UPDATE ON public.warranty_tickets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ==============================================================================
-- 8. SUPABASE AUTH USER PROVISIONING TRIGGER
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, full_name, status)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'Thành viên mới'),
    'ACTIVE'
  );
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created') THEN
      CREATE TRIGGER on_auth_user_created
        AFTER INSERT ON auth.users
        FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
    END IF;
  END IF;
END $$;

-- ==============================================================================
-- 9. PRIVATE SCHEMA ISOLATION FOUNDATION
-- ==============================================================================
-- Ensure private schema is strictly inaccessible to browser clients (PostgREST)
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon;
REVOKE ALL ON SCHEMA private FROM authenticated;

REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA private FROM PUBLIC, anon, authenticated;

-- ==============================================================================
-- END OF MIGRATION 001
-- ==============================================================================
