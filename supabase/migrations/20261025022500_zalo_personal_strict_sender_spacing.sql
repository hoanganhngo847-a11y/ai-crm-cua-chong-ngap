BEGIN;

CREATE OR REPLACE FUNCTION public.campaign_claim(p_company uuid,p_channel text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  c public.messaging_campaigns;
  r public.messaging_campaign_recipients;
BEGIN
  IF p_channel <> 'ZALO_PERSONAL' THEN
    RETURN public.campaign_claim_before_personal(p_company,p_channel);
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.messaging_campaign_settings
     WHERE company_id=p_company AND enabled
  ) THEN RETURN NULL; END IF;

  -- Serialize personal-Zalo claims for the company. This prevents concurrent worker
  -- polls from racing around the sender-wide five-minute cadence.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_company::text || ':campaign:zalo_personal:claim', 0)
  );

  SELECT * INTO c
    FROM public.messaging_campaigns ca
   WHERE ca.company_id=p_company
     AND ca.channel='ZALO_PERSONAL'
     AND ca.status IN ('RUNNING','SCHEDULED','PAUSED','CANCELLED')
     AND ca.confirmed_at IS NOT NULL
     AND coalesce(ca.scheduled_at,ca.created_at)<=clock_timestamp()
     AND EXISTS(
       SELECT 1
         FROM public.messaging_campaign_recipients q
        WHERE q.campaign_id=ca.id
          AND (
            (ca.status IN ('RUNNING','SCHEDULED') AND (
              (q.delivery_status='QUEUED' AND q.next_attempt_at<=clock_timestamp()) OR
              (q.delivery_status='CLAIMED' AND q.lease_until<clock_timestamp())
            )) OR
            (q.delivery_status='SENDING' AND q.lease_until<clock_timestamp())
          )
     )
   ORDER BY ca.created_at,ca.id
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF c.id IS NULL THEN RETURN NULL; END IF;

  WITH expired AS (
    UPDATE public.messaging_campaign_recipients
       SET delivery_status='UNCERTAIN',
           provider_error_code='LEASE_EXPIRED_AFTER_DISPATCH',
           provider_error_message_sanitized='Provider outcome unknown; reconciliation required.',
           lock_token=NULL,
           lease_until=NULL,
           updated_at=clock_timestamp()
     WHERE campaign_id=c.id
       AND delivery_status='SENDING'
       AND lease_until<clock_timestamp()
     RETURNING *
  )
  INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,event,metadata)
  SELECT company_id,campaign_id,'recipient_failed',
         jsonb_build_object('recipient_id',id,'code','LEASE_EXPIRED_AFTER_DISPATCH')
    FROM expired;

  IF c.status IN ('PAUSED','CANCELLED') THEN
    PERFORM public.campaign_recount(c.id);
    RETURN NULL;
  END IF;

  -- Hard sender-wide pacing. Even when the worker was offline and several scheduled
  -- recipients are overdue, a second dispatch cannot begin until five minutes after
  -- the previous dispatch attempt on the same personal Zalo sender.
  IF EXISTS(
    SELECT 1
      FROM public.messaging_campaign_recipients prev
      JOIN public.messaging_campaigns pc ON pc.id=prev.campaign_id
     WHERE pc.company_id=p_company
       AND pc.channel='ZALO_PERSONAL'
       AND pc.sender_account_id=c.sender_account_id
       AND prev.dispatch_started_at IS NOT NULL
       AND prev.dispatch_started_at>clock_timestamp()-interval '5 minutes'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO r
    FROM public.messaging_campaign_recipients
   WHERE campaign_id=c.id
     AND attempt_count<5
     AND (
       (delivery_status='QUEUED' AND next_attempt_at<=clock_timestamp()) OR
       (delivery_status='CLAIMED' AND lease_until<clock_timestamp())
     )
   ORDER BY next_attempt_at,created_at,id
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF r.id IS NULL THEN
    PERFORM public.campaign_recount(c.id);
    RETURN NULL;
  END IF;

  UPDATE public.messaging_campaign_recipients
     SET delivery_status='CLAIMED',
         lock_token=gen_random_uuid(),
         lease_until=clock_timestamp()+interval '60 seconds',
         updated_at=clock_timestamp()
   WHERE id=r.id
   RETURNING * INTO r;

  RETURN jsonb_build_object(
    'id',r.id,
    'company_id',r.company_id,
    'campaign_id',c.id,
    'lock_token',r.lock_token,
    'channel',c.channel
  );
END $$;

REVOKE ALL ON FUNCTION public.campaign_claim(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_claim(uuid,text) TO service_role;

COMMENT ON FUNCTION public.campaign_claim(uuid,text) IS
  'Personal Zalo claims are due-time gated and sender-wide serialized to at least one dispatch attempt every five minutes.';

COMMIT;
