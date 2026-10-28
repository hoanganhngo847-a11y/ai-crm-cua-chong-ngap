-- Forward backfill for production: create the Messenger canary allowlist
-- foundation that 20261023170000 defines but some environments never applied.
-- Surgical scope only: this table + its constraints/index/RLS. No changes to
-- historical migrations. Safe to run when the table already exists.
--
-- Required by 20261027140000_botcake_messenger_page_and_du_hoc_ai.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_brain_live_canary_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('MESSENGER', 'ZALO', 'VOICE')),
  conversation_id uuid NOT NULL,
  page_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_brain_live_canary_allowlist UNIQUE (company_id, channel, conversation_id, page_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_brain_live_canary_conversation'
  ) THEN
    ALTER TABLE public.ai_brain_live_canary_allowlist
      ADD CONSTRAINT fk_ai_brain_live_canary_conversation
      FOREIGN KEY (company_id, conversation_id)
      REFERENCES public.conversations(company_id, id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_brain_live_canary_page_id_numeric'
  ) THEN
    ALTER TABLE public.ai_brain_live_canary_allowlist
      DROP CONSTRAINT IF EXISTS ai_brain_live_canary_allowlist_page_id_check;
    ALTER TABLE public.ai_brain_live_canary_allowlist
      ADD CONSTRAINT chk_ai_brain_live_canary_page_id_numeric
      CHECK (page_id ~ '^[0-9]+$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_brain_live_canary_lookup
  ON public.ai_brain_live_canary_allowlist (company_id, channel, conversation_id, page_id)
  WHERE enabled = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_ai_brain_live_canary_allowlist_updated_at'
  ) THEN
    CREATE TRIGGER trg_ai_brain_live_canary_allowlist_updated_at
      BEFORE UPDATE ON public.ai_brain_live_canary_allowlist
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

ALTER TABLE public.ai_brain_live_canary_allowlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_brain_live_canary_allowlist FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_brain_live_canary_allowlist TO authenticated;
GRANT ALL ON public.ai_brain_live_canary_allowlist TO service_role;

DROP POLICY IF EXISTS ai_brain_live_canary_select_tenant ON public.ai_brain_live_canary_allowlist;
CREATE POLICY ai_brain_live_canary_select_tenant
  ON public.ai_brain_live_canary_allowlist
  FOR SELECT
  TO authenticated
  USING (public.has_company_role(company_id, 'BOSS_ADMIN'));

DROP POLICY IF EXISTS ai_brain_live_canary_insert_tenant ON public.ai_brain_live_canary_allowlist;
DROP POLICY IF EXISTS ai_brain_live_canary_update_tenant ON public.ai_brain_live_canary_allowlist;
DROP POLICY IF EXISTS ai_brain_live_canary_delete_tenant ON public.ai_brain_live_canary_allowlist;

COMMIT;
