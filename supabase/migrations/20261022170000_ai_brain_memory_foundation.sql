-- Phase 3 AI Brain memory foundation.
--
-- CRM remains the source of truth. These tables are server-only projections for
-- verified company knowledge and customer-scoped long-term memory. There is no
-- automatic ingestion/backfill in this migration.

CREATE TABLE public.ai_company_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN (
    'COMPANY_PROFILE', 'PRODUCT', 'SERVICE', 'FAQ', 'POLICY',
    'SALES_PLAYBOOK', 'PROCESS', 'OTHER'
  )),
  title text NOT NULL,
  content text NOT NULL,
  verification_status text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_status IN ('UNVERIFIED', 'VERIFIED', 'REJECTED')),
  lifecycle_status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_status IN ('ACTIVE', 'ARCHIVED')),
  source_type text NOT NULL DEFAULT 'MANUAL'
    CHECK (source_type IN ('MANUAL', 'FILE', 'URL', 'CRM', 'SYSTEM')),
  source_ref text,
  checksum_sha256 text,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(content, ''))
  ) STORED,
  CHECK (char_length(title) BETWEEN 1 AND 300),
  CHECK (char_length(content) BETWEEN 1 AND 100000),
  CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 2048),
  CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_ai_company_knowledge_company_active
  ON public.ai_company_knowledge (company_id, verification_status, lifecycle_status, updated_at DESC);
CREATE INDEX idx_ai_company_knowledge_search
  ON public.ai_company_knowledge USING gin (search_document);

CREATE TRIGGER trg_ai_company_knowledge_updated_at
  BEFORE UPDATE ON public.ai_company_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_company_knowledge ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_company_knowledge FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_company_knowledge TO service_role;

CREATE TABLE public.ai_customer_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  memory_type text NOT NULL CHECK (memory_type IN (
    'FACT', 'PREFERENCE', 'INTENT', 'OBJECTION',
    'TEMPORARY_CONTEXT', 'AI_INFERENCE'
  )),
  memory_key text,
  content text NOT NULL,
  structured_value jsonb,
  confidence numeric(4,3) NOT NULL DEFAULT 0.500 CHECK (confidence >= 0 AND confidence <= 1),
  verification_status text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_status IN ('UNVERIFIED', 'CONFIRMED', 'REJECTED')),
  lifecycle_status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_status IN ('ACTIVE', 'SUPERSEDED', 'ARCHIVED')),
  source_kind text NOT NULL CHECK (source_kind IN (
    'INTERACTION', 'PHONE_CALL', 'ZALO_CALL', 'ZALO_SUMMARY', 'MANUAL', 'SYSTEM'
  )),
  source_channel text CHECK (source_channel IS NULL OR source_channel IN (
    'MESSENGER', 'ZALO', 'PHONE', 'WEB', 'INTERNAL'
  )),
  source_ref_id uuid,
  source_occurred_at timestamptz,
  created_by_type text NOT NULL CHECK (created_by_type IN ('HUMAN', 'AI', 'SYSTEM')),
  created_by_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  last_verified_at timestamptz,
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce(memory_key, '') || ' ' || coalesce(content, ''))
  ) STORED,
  CONSTRAINT fk_ai_customer_memories_customer
    FOREIGN KEY (company_id, customer_id)
    REFERENCES public.customers(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_ai_customer_memories_scope_id UNIQUE (company_id, customer_id, id),
  CHECK (memory_key IS NULL OR char_length(memory_key) BETWEEN 1 AND 120),
  CHECK (char_length(content) BETWEEN 1 AND 4000),
  CHECK (structured_value IS NULL OR jsonb_typeof(structured_value) IN ('object', 'array', 'string', 'number', 'boolean', 'null')),
  CHECK (NOT (memory_type = 'AI_INFERENCE' AND verification_status = 'CONFIRMED')),
  CHECK (verification_status <> 'CONFIRMED' OR last_verified_at IS NOT NULL),
  CHECK (created_by_type <> 'HUMAN' OR created_by_user_id IS NOT NULL),
  CHECK (
    source_kind IN ('MANUAL', 'SYSTEM')
    OR source_ref_id IS NOT NULL
  )
);

ALTER TABLE public.ai_customer_memories
  ADD CONSTRAINT fk_ai_customer_memories_superseded_by
  FOREIGN KEY (company_id, customer_id, superseded_by)
  REFERENCES public.ai_customer_memories(company_id, customer_id, id)
  ON DELETE RESTRICT;

CREATE INDEX idx_ai_customer_memories_customer_active
  ON public.ai_customer_memories (company_id, customer_id, lifecycle_status, verification_status, updated_at DESC);
CREATE INDEX idx_ai_customer_memories_customer_type
  ON public.ai_customer_memories (company_id, customer_id, memory_type, updated_at DESC);
CREATE INDEX idx_ai_customer_memories_source
  ON public.ai_customer_memories (company_id, customer_id, source_kind, source_ref_id)
  WHERE source_ref_id IS NOT NULL;
CREATE INDEX idx_ai_customer_memories_search
  ON public.ai_customer_memories USING gin (search_document);

CREATE TRIGGER trg_ai_customer_memories_updated_at
  BEFORE UPDATE ON public.ai_customer_memories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_customer_memories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_customer_memories FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_customer_memories TO service_role;

COMMENT ON TABLE public.ai_company_knowledge IS
  'Server-only verified company knowledge for AI Brain retrieval. No automatic ingestion.';
COMMENT ON TABLE public.ai_customer_memories IS
  'Server-only customer-scoped long-term memory with provenance, confidence and verification state.';
COMMENT ON COLUMN public.ai_customer_memories.source_ref_id IS
  'Opaque provenance reference. Never dereference without company/customer scoping in application code.';
