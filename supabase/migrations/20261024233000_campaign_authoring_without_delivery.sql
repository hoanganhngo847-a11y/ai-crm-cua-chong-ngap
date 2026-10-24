BEGIN;

-- Keep the original, heavily-audited delivery gate intact and wrap it so
-- non-delivery authoring can run while the tenant delivery switch is off.
ALTER FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb)
  RENAME TO campaign_sync_senders_delivery_gate;
ALTER FUNCTION public.campaign_command(uuid,uuid,text,jsonb)
  RENAME TO campaign_command_delivery_gate;

REVOKE ALL ON FUNCTION public.campaign_sync_senders_delivery_gate(uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.campaign_command_delivery_gate(uuid,uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- Sender registry sync is metadata-only. It is needed so users can prepare a
-- draft against a known Page/OA even when live campaign delivery is disabled.
CREATE FUNCTION public.campaign_sync_senders(
  p_company uuid,
  p_actor uuid,
  p_pages jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_was_enabled boolean;
BEGIN
  PERFORM public.campaign_actor(p_company, p_actor);

  SELECT enabled
    INTO v_was_enabled
    FROM public.messaging_campaign_settings
   WHERE company_id = p_company
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.messaging_campaign_settings(company_id, enabled, sale_execute)
    VALUES (p_company, false, false);
    v_was_enabled := false;
  END IF;

  IF NOT v_was_enabled THEN
    UPDATE public.messaging_campaign_settings
       SET enabled = true
     WHERE company_id = p_company;
  END IF;

  BEGIN
    PERFORM public.campaign_sync_senders_delivery_gate(p_company, p_actor, p_pages);
  EXCEPTION WHEN OTHERS THEN
    IF NOT v_was_enabled THEN
      UPDATE public.messaging_campaign_settings
         SET enabled = false
       WHERE company_id = p_company;
    END IF;
    RAISE;
  END;

  IF NOT v_was_enabled THEN
    UPDATE public.messaging_campaign_settings
       SET enabled = false
     WHERE company_id = p_company;
  END IF;
END
$$;

-- Draft authoring commands never enqueue or dispatch provider traffic. The
-- legacy function still owns all validation and write invariants; the wrapper
-- only makes its existing tenant-enabled precondition transaction-locally true
-- for template/create/validate. Delivery commands retain the original gate.
CREATE FUNCTION public.campaign_command(
  p_company uuid,
  p_actor uuid,
  p_command text,
  p_input jsonb DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_was_enabled boolean;
  v_result jsonb;
BEGIN
  PERFORM public.campaign_actor(p_company, p_actor);

  IF p_command NOT IN ('template', 'create', 'validate') THEN
    RETURN public.campaign_command_delivery_gate(
      p_company,
      p_actor,
      p_command,
      p_input
    );
  END IF;

  SELECT enabled
    INTO v_was_enabled
    FROM public.messaging_campaign_settings
   WHERE company_id = p_company
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.messaging_campaign_settings(company_id, enabled, sale_execute)
    VALUES (p_company, false, false);
    v_was_enabled := false;
  END IF;

  IF NOT v_was_enabled THEN
    UPDATE public.messaging_campaign_settings
       SET enabled = true
     WHERE company_id = p_company;
  END IF;

  BEGIN
    v_result := public.campaign_command_delivery_gate(
      p_company,
      p_actor,
      p_command,
      p_input
    );
  EXCEPTION WHEN OTHERS THEN
    IF NOT v_was_enabled THEN
      UPDATE public.messaging_campaign_settings
         SET enabled = false
       WHERE company_id = p_company;
    END IF;
    RAISE;
  END;

  IF NOT v_was_enabled THEN
    UPDATE public.messaging_campaign_settings
       SET enabled = false
     WHERE company_id = p_company;
  END IF;

  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_command(uuid,uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_sync_senders(uuid,uuid,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_command(uuid,uuid,text,jsonb)
  TO service_role;

COMMENT ON FUNCTION public.campaign_command(uuid,uuid,text,jsonb) IS
  'Allows template/create/validate authoring while preserving the tenant delivery gate for execution commands.';

COMMIT;
