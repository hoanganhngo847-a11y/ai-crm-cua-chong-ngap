-- Botcake / Messenger page identity repair + Du học page AI configuration.
--
-- 1. Botcake forwards Messenger messages without the canonical `pageId:psid`
--    conversation key, so conversations created through that path previously
--    stored the customer UUID as `external_conversation_id`. Messenger live
--    delivery, the canary allowlist and the Graph API transport all require a
--    numeric Page ID. This migration repairs existing rows and keeps future
--    rows canonical whenever ingestion metadata contains page_id + sender_id.
-- 2. The Du học Page is explicitly allowlisted for AI live delivery and gets
--    a verified conversation-level canary row for every existing/future
--    conversation on that Page. `ai_brain_live_settings` is created only when
--    no setting exists; an operator-disabled setting is never re-enabled.
--
-- Page-scoped playbook content lives in code (`features/ai-brain/grounding/
-- page-playbook.ts`) so the AI has a safe default before any DB row exists.
-- A verified `ai_company_knowledge` row with category SALES_PLAYBOOK and
-- metadata.page_id can override that default.

BEGIN;

CREATE OR REPLACE FUNCTION public.ai_messenger_page_id(
  p_external_conversation_id text,
  p_metadata jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_external_conversation_id ~ '^[0-9]+:[0-9]+$'
      THEN split_part(p_external_conversation_id, ':', 1)
    WHEN coalesce(p_metadata->>'page_id', '') ~ '^[0-9]+$'
      THEN p_metadata->>'page_id'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.ai_messenger_page_id(text, jsonb) IS
  'Resolves a numeric Messenger Page ID from the canonical pageId:psid key or ingestion metadata.';

CREATE OR REPLACE FUNCTION public.ai_messenger_recipient_id(
  p_external_conversation_id text,
  p_metadata jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_external_conversation_id ~ '^[0-9]+:[0-9]+$'
      THEN split_part(p_external_conversation_id, ':', 2)
    WHEN coalesce(p_metadata->>'sender_id', '') ~ '^[0-9]+$'
      THEN p_metadata->>'sender_id'
    WHEN coalesce(p_metadata->>'psid', '') ~ '^[0-9]+$'
      THEN p_metadata->>'psid'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.ai_messenger_recipient_id(text, jsonb) IS
  'Resolves a numeric Messenger PSID from the canonical pageId:psid key or ingestion metadata.';

-- Before-write repair: conversation ingestion metadata already carries the
-- provider Page ID and sender PSID for Botcake. Store the canonical key so the
-- existing live-delivery trigger/RPC/transport invariants remain valid.
CREATE OR REPLACE FUNCTION public.repair_messenger_external_conversation_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page_id text;
  v_recipient_id text;
  v_canonical text;
BEGIN
  IF NEW.channel <> 'FACEBOOK' THEN
    RETURN NEW;
  END IF;

  IF NEW.external_conversation_id ~ '^[0-9]+:[0-9]+$' THEN
    RETURN NEW;
  END IF;

  v_page_id := public.ai_messenger_page_id(NEW.external_conversation_id, NEW.metadata);
  v_recipient_id := public.ai_messenger_recipient_id(NEW.external_conversation_id, NEW.metadata);
  IF v_page_id IS NULL OR v_recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_canonical := v_page_id || ':' || v_recipient_id;

  -- Never steal a canonical key from another conversation. If this happens the
  -- ingestion path should have matched that conversation instead.
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.company_id = NEW.company_id
      AND c.channel = NEW.channel
      AND c.external_conversation_id = v_canonical
      AND c.id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  NEW.external_conversation_id := v_canonical;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_repair_messenger_external_conversation_id ON public.conversations;
CREATE TRIGGER trg_repair_messenger_external_conversation_id
  BEFORE INSERT OR UPDATE OF external_conversation_id, metadata ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.repair_messenger_external_conversation_id();

-- Older Botcake rows were written before the route forwarded the Page ID. The
-- integration is single-Page (BOTCAKE_PAGE_ID), so its conversations belong to
-- the Du học Page and can be enriched before the generic repair below.
UPDATE public.conversations
SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('page_id', '1343097708890171'),
    updated_at = now()
WHERE channel = 'FACEBOOK'
  AND lower(coalesce(metadata->>'provider', '')) = 'botcake'
  AND coalesce(metadata->>'page_id', '') = '';

-- Backfill existing Botcake conversations.
UPDATE public.conversations c
SET external_conversation_id = (c.metadata->>'page_id') || ':' || (c.metadata->>'sender_id'),
    updated_at = now()
WHERE c.channel = 'FACEBOOK'
  AND c.external_conversation_id !~ '^[0-9]+:[0-9]+$'
  AND coalesce(c.metadata->>'page_id', '') ~ '^[0-9]+$'
  AND coalesce(c.metadata->>'sender_id', '') ~ '^[0-9]+$'
  AND NOT EXISTS (
    SELECT 1
    FROM public.conversations d
    WHERE d.company_id = c.company_id
      AND d.channel = c.channel
      AND d.external_conversation_id = (c.metadata->>'page_id') || ':' || (c.metadata->>'sender_id')
  );

-- Du học Page: seed conversation-level canary rows for existing conversations.
INSERT INTO public.ai_brain_live_canary_allowlist (
  company_id, channel, conversation_id, page_id, enabled
)
SELECT
  c.company_id,
  'MESSENGER',
  c.id,
  public.ai_messenger_page_id(c.external_conversation_id, c.metadata),
  true
FROM public.conversations c
WHERE c.channel = 'FACEBOOK'
  AND public.ai_messenger_page_id(c.external_conversation_id, c.metadata) = '1343097708890171'
ON CONFLICT (company_id, channel, conversation_id, page_id) DO NOTHING;

-- Du học Page: keep every new conversation explicitly allowlisted.
CREATE OR REPLACE FUNCTION public.seed_du_hoc_messenger_canary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page_id text;
BEGIN
  IF NEW.channel <> 'FACEBOOK' THEN
    RETURN NEW;
  END IF;

  v_page_id := public.ai_messenger_page_id(NEW.external_conversation_id, NEW.metadata);
  IF v_page_id IS DISTINCT FROM '1343097708890171' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.ai_brain_live_canary_allowlist (
    company_id, channel, conversation_id, page_id, enabled
  ) VALUES (
    NEW.company_id, 'MESSENGER', NEW.id, v_page_id, true
  )
  ON CONFLICT (company_id, channel, conversation_id, page_id) DO NOTHING;

  -- Create the tenant kill switch only when it has never been configured. An
  -- operator-disabled setting must remain disabled.
  INSERT INTO public.ai_brain_live_settings (
    company_id, channel, enabled, min_confidence
  ) VALUES (
    NEW.company_id, 'MESSENGER', true, 0.850
  )
  ON CONFLICT (company_id, channel) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_du_hoc_messenger_canary ON public.conversations;
-- Also fire after metadata/external-ID repair. Legacy Botcake conversations only
-- become identifiable as Du học Page conversations after their first new message
-- merges page_id + sender_id into metadata.
CREATE TRIGGER trg_seed_du_hoc_messenger_canary
  AFTER INSERT OR UPDATE OF external_conversation_id, metadata ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.seed_du_hoc_messenger_canary();

-- Enable Messenger live delivery for tenants that own the Du học Page only
-- when no setting row exists yet. A disabled row is an explicit operator
-- decision and must stay disabled.
INSERT INTO public.ai_brain_live_settings (
  company_id, channel, enabled, min_confidence
)
SELECT DISTINCT c.company_id, 'MESSENGER', true, 0.850
FROM public.conversations c
WHERE c.channel = 'FACEBOOK'
  AND (
    public.ai_messenger_page_id(c.external_conversation_id, c.metadata) = '1343097708890171'
    OR lower(coalesce(c.metadata->>'provider', '')) = 'botcake'
  )
ON CONFLICT (company_id, channel) DO NOTHING;

COMMIT;
