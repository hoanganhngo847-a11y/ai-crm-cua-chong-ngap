BEGIN;

CREATE OR REPLACE FUNCTION public.campaign_capture_optout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE normalized text; BEGIN
 IF NEW.direction<>'INBOUND' OR NEW.actor_type<>'CUSTOMER' OR NEW.channel NOT IN ('FACEBOOK','ZALO')
 OR NEW.sanitization_status NOT IN ('SUCCEEDED','NOT_REQUIRED') OR NEW.sanitized_content IS NULL THEN RETURN NEW; END IF;
 -- Lead Ads keeps its timeline entry, but the fenced lead receipt identifies it as a form.
 -- For INSERT the intake function holds the receipt lock and has not checkpointed the
 -- interaction yet. For UPDATE only the exact checkpointed interaction is a form.
 IF NEW.channel='FACEBOOK' AND NEW.conversation_id IS NULL
 AND NEW.external_ref ~ '^[0-9]+:leadgen:[0-9]+$'
 AND EXISTS (
   SELECT 1 FROM private.meta_leadgen_events e
   WHERE e.company_id=NEW.company_id
     AND e.page_id=split_part(NEW.external_ref,':',1)
     AND e.leadgen_id=split_part(NEW.external_ref,':',3)
     AND (e.interaction_id=NEW.id OR (
       TG_OP='INSERT' AND e.status='PROCESSING' AND e.interaction_id IS NULL
     ))
 ) THEN RETURN NEW; END IF;
 normalized:=btrim(regexp_replace(replace(lower(regexp_replace(normalize(NEW.sanitized_content,NFD),U&'[\0300-\036f]','','g')),'đ','d'),'[^a-z0-9]+',' ','g'));
 IF normalized IN ('stop','unsubscribe','huy','dung','ngung') OR (' '||normalized||' ') ~
 ' (dung lam phien|ngung lam phien|dung gui tin|ngung gui tin|dung gui tin nua|dung nhan tin|ngung nhan tin|dung nhan tin nua|dung nhan nua|ngung nhan nua|khong nhan tin nua|khong muon nhan tin|khong muon nhan tin nua|khong co nhu cau nhan tin|huy dang ky|huy nhan tin|tu choi nhan tin|unsubscribe|stop) ' THEN
 INSERT INTO public.messaging_suppressions(company_id,customer_id,channel,status,source,source_interaction_id)
 VALUES(NEW.company_id,NEW.customer_id,CASE NEW.channel WHEN 'ZALO' THEN 'ZALO_OA' ELSE 'FACEBOOK' END,'UNSUBSCRIBED','CUSTOMER_OPT_OUT',NEW.id)
 ON CONFLICT(company_id,customer_id,channel) DO UPDATE
 SET status='UNSUBSCRIBED',source='CUSTOMER_OPT_OUT',source_interaction_id=NEW.id,created_at=clock_timestamp(),
     revoked_at=NULL,revoked_by=NULL,revoke_reason=NULL;
 INSERT INTO public.messaging_campaign_audit(company_id,campaign_id,event,metadata)
 VALUES(NEW.company_id,NULL,'customer_optout_detected',jsonb_build_object(
   'customer_id',NEW.customer_id,
   'channel',CASE NEW.channel WHEN 'ZALO' THEN 'ZALO_OA' ELSE 'FACEBOOK' END,
   'interaction_id',NEW.id
 ));
 END IF;
 RETURN NEW;
END $$;

COMMIT;
