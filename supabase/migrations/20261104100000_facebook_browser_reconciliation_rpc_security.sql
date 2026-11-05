-- Restrict backend-only Facebook Browser outbox reconciliation RPCs.
-- Their only supported callers are server-side InboxService methods using createAdminClient()
-- behind routes that verify FB_WORKER_SECRET. Direct PostgREST execution by browser roles
-- bypasses that server-side authentication and can expose or mutate outbound delivery rows.
BEGIN;

REVOKE ALL ON FUNCTION public.claim_orphan_facebook_browser_jobs(text, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_orphan_facebook_browser_jobs(text, integer, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.resolve_reconciled_facebook_browser_job(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reconciled_facebook_browser_job(uuid, text, text, text)
  TO service_role;

-- Trigger entry points are invoked by PostgreSQL triggers, not by browser RPCs.
-- Revoking direct execution does not disable their triggers.
DO $trigger_acl$
DECLARE
  signature text;
  target regprocedure;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.handle_new_user()',
    'public.repair_messenger_external_conversation_id()',
    'public.seed_du_hoc_messenger_canary()'
  ] LOOP
    target := to_regprocedure(signature);
    IF target IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', target);
    END IF;
  END LOOP;
END;
$trigger_acl$;

COMMIT;
