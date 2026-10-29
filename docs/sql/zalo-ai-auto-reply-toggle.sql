-- Zalo AI auto-reply switch (run as service_role / SQL editor owner).
--
-- The durable switch is per company + channel. `channel = 'ZALO'` controls both
-- AI Brain live replies and the Response SLA runtime; manual Sale replies are
-- never affected. Groups remain excluded from AI even when this is enabled.

-- ---------------------------------------------------------------------------
-- DISABLE (temporary pause)
-- ---------------------------------------------------------------------------
BEGIN;

UPDATE public.ai_brain_live_settings
SET enabled = false,
    updated_at = now()
WHERE channel = 'ZALO'
  AND enabled = true;

-- Close already-queued replies so re-enabling later cannot send stale answers.
UPDATE public.ai_brain_live_deliveries
SET send_status = 'SKIPPED',
    error_code = 'AI_ZALO_AUTO_REPLY_DISABLED',
    completed_at = now(),
    updated_at = now()
WHERE channel = 'ZALO'
  AND send_status = 'PENDING';

COMMIT;

-- ---------------------------------------------------------------------------
-- ENABLE (restore normal AI replies)
-- ---------------------------------------------------------------------------
-- BEGIN;
--
-- INSERT INTO public.ai_brain_live_settings (
--   company_id, channel, enabled, min_confidence, updated_at
-- )
-- SELECT id, 'ZALO', true, 0.85, now()
-- FROM public.companies
-- ON CONFLICT (company_id, channel) DO UPDATE
--   SET enabled = true,
--       updated_at = now();
--
-- COMMIT;
