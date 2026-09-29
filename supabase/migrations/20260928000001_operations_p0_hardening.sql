-- Operations owns these transactions and completion signals; no Finance mutations.
INSERT INTO storage.buckets(id,name,public,file_size_limit)
VALUES ('installation-docs','installation-docs',false,10485760)
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=10485760;
-- Restrictive policies also guard against unrelated permissive Storage policies.
CREATE POLICY operations_evidence_no_client_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated WITH CHECK(bucket_id <> 'installation-docs');
CREATE POLICY operations_evidence_no_client_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated USING(bucket_id <> 'installation-docs') WITH CHECK(bucket_id <> 'installation-docs');
CREATE POLICY operations_evidence_no_client_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated USING(bucket_id <> 'installation-docs');

CREATE TABLE public.operations_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES public.companies(id),
 order_id uuid NOT NULL,
 event_type text NOT NULL CHECK(event_type='ORDER_COMPLETED'),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT operations_outbox_order_fk FOREIGN KEY(company_id,order_id) REFERENCES public.orders(company_id,id),
 UNIQUE(company_id,order_id,event_type)
);
ALTER TABLE public.operations_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operations_outbox FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.operations_outbox TO service_role;

CREATE FUNCTION public.operations_actor(p_company uuid,p_actor uuid,p_roles text[])
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;
BEGIN
 SELECT m.role INTO r FROM public.company_members m JOIN public.user_profiles u ON u.id=m.user_id
 WHERE m.company_id=p_company AND m.user_id=p_actor AND m.status='ACTIVE' AND u.status='ACTIVE'
 FOR SHARE OF m,u;
 IF r IS NULL OR NOT(r=ANY(p_roles)) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
 RETURN r;
END $$;
CREATE FUNCTION public.operations_audit(p_company uuid,p_actor uuid,p_action text,p_table text,p_id uuid,p_metadata jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 INSERT INTO public.audit_logs(company_id,user_id,action,resource_type,resource_id,result,metadata)
 VALUES(p_company,p_actor,p_action,p_table,p_id,'SUCCESS',p_metadata);
$$;
CREATE FUNCTION public.operations_evidence_ref(p_company uuid,p_installation uuid,p_ref text,p_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT COALESCE(p_ref ~ ('^' || p_company::text || '/installations/' || p_installation::text || '/' ||
 CASE p_type WHEN 'photo' THEN 'photo/[0-9a-f-]{36}\.(jpg|png|webp)' WHEN 'handover' THEN 'handover/[0-9a-f-]{36}\.pdf' ELSE '$a' END || '$'),false);
$$;
CREATE FUNCTION public.create_production_order_atomic(p_company_id uuid,p_order_id uuid,p_actor_id uuid,p_specs jsonb,p_materials jsonb,p_deadline timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders; c public.contracts; p public.production_orders;
BEGIN
 PERFORM public.operations_actor(p_company_id,p_actor_id,ARRAY['BOSS_ADMIN']);
 SELECT * INTO o FROM public.orders WHERE company_id=p_company_id AND id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 IF o.order_status NOT IN ('CONTRACT_SIGNED','DEPOSIT_CONFIRMED') THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
 SELECT * INTO c FROM public.contracts WHERE company_id=p_company_id AND order_id=o.id AND is_current FOR UPDATE;
 IF NOT FOUND OR c.status <> 'SIGNED' OR NULLIF(btrim(c.signed_file_ref),'') IS NULL THEN RAISE EXCEPTION 'CONTRACT_NOT_SIGNED'; END IF;
 IF EXISTS(SELECT 1 FROM public.production_orders WHERE order_id=o.id) THEN RAISE EXCEPTION 'PRODUCTION_ALREADY_EXISTS'; END IF;
 INSERT INTO public.production_orders(company_id,order_id,specs,materials,status,deadline,qc_status)
 VALUES(p_company_id,o.id,p_specs,p_materials,'RELEASED_TO_FACTORY',p_deadline,'PENDING') RETURNING * INTO p;
 UPDATE public.orders SET order_status='IN_PRODUCTION',updated_at=now() WHERE id=o.id;
 PERFORM public.operations_audit(p_company_id,p_actor_id,'CREATE_PRODUCTION_ORDER','production_orders',p.id,jsonb_build_object('order_id',o.id));
 RETURN to_jsonb(p);
END $$;
CREATE FUNCTION public.update_production_progress_atomic(p_company_id uuid,p_production_order_id uuid,p_actor_id uuid,p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.production_orders;
BEGIN
 PERFORM public.operations_actor(p_company_id,p_actor_id,ARRAY['BOSS_ADMIN']);
 SELECT * INTO p FROM public.production_orders WHERE company_id=p_company_id AND id=p_production_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 IF p_status IS NULL OR p_status NOT IN ('RELEASED_TO_FACTORY','IN_PRODUCTION','QC_IN_PROGRESS') OR NOT (
 (p.status='PENDING_SPECS' AND p_status='RELEASED_TO_FACTORY') OR
 (p.status IN ('RELEASED_TO_FACTORY','QC_IN_PROGRESS','QC_FAILED','READY_FOR_DISPATCH') AND p_status='IN_PRODUCTION') OR
 (p.status='IN_PRODUCTION' AND p_status='QC_IN_PROGRESS')) THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
 UPDATE public.production_orders SET status=p_status,qc_status=CASE WHEN p_status='IN_PRODUCTION' THEN 'PENDING' ELSE qc_status END,updated_at=now() WHERE id=p.id;
 PERFORM public.operations_audit(p_company_id,p_actor_id,'UPDATE_PRODUCTION_PROGRESS','production_orders',p.id,jsonb_build_object('from_status',p.status,'to_status',p_status));
END $$;
CREATE OR REPLACE FUNCTION public.record_quality_check_atomic(p_company_id uuid,p_production_order_id uuid,p_qc_status text,p_inspector_id uuid,p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.production_orders; o public.orders; next_status text;
BEGIN
 PERFORM public.operations_actor(p_company_id,p_inspector_id,ARRAY['BOSS_ADMIN']);
 SELECT * INTO p FROM public.production_orders WHERE company_id=p_company_id AND id=p_production_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 SELECT * INTO o FROM public.orders WHERE company_id=p_company_id AND id=p.order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 IF p.status <> 'QC_IN_PROGRESS' OR o.order_status <> 'IN_PRODUCTION' THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
 IF p_qc_status IS NULL OR p_qc_status NOT IN ('PASSED','REWORK_REQUIRED','REJECTED') THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 next_status := CASE WHEN p_qc_status='PASSED' THEN 'READY_FOR_DISPATCH' ELSE 'QC_FAILED' END;
 UPDATE public.production_orders SET status=next_status,qc_status=p_qc_status,updated_at=now() WHERE id=p.id;
 IF p_qc_status='PASSED' THEN UPDATE public.orders SET order_status='READY_FOR_INSTALL',updated_at=now() WHERE id=o.id; END IF;
 PERFORM public.operations_audit(p_company_id,p_inspector_id,'RECORD_QUALITY_CHECK','production_orders',p.id,jsonb_build_object('from_status',p.status,'to_status',next_status,'qc_status',p_qc_status));
 RETURN jsonb_build_object('success',true);
END $$;
CREATE FUNCTION public.schedule_installation_atomic(p_company_id uuid,p_order_id uuid,p_customer_id uuid,p_appointment_id uuid,p_crew jsonb,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders; p public.production_orders; a public.appointments; i public.installations;
BEGIN
 PERFORM public.operations_actor(p_company_id,p_actor_id,ARRAY['BOSS_ADMIN']);
 -- Match QC's production -> order lock order to avoid deadlocks.
 SELECT * INTO p FROM public.production_orders WHERE company_id=p_company_id AND order_id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 SELECT * INTO o FROM public.orders WHERE company_id=p_company_id AND id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.customer_id<>p_customer_id THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 SELECT * INTO a FROM public.appointments WHERE company_id=p_company_id AND id=p_appointment_id FOR UPDATE;
 IF NOT FOUND OR a.customer_id<>p_customer_id THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 IF o.order_status<>'READY_FOR_INSTALL' OR p.status<>'READY_FOR_DISPATCH' OR p.qc_status<>'PASSED' OR a.type<>'INSTALLATION' OR a.status NOT IN ('ASSIGNED','ACCEPTED') THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
 INSERT INTO public.installations(company_id,customer_id,order_id,appointment_id,crew,status)
 VALUES(p_company_id,p_customer_id,p_order_id,p_appointment_id,p_crew,'SCHEDULED') RETURNING * INTO i;
 PERFORM public.operations_audit(p_company_id,p_actor_id,'SCHEDULE_INSTALLATION','installations',i.id,'{}');
 RETURN to_jsonb(i);
END $$;
-- One locked mutation boundary for progress and server-uploaded evidence.
CREATE FUNCTION public.mutate_installation_atomic(p_company_id uuid,p_installation_id uuid,p_actor_id uuid,p_status text DEFAULT NULL,p_ref text DEFAULT NULL,p_type text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i public.installations; a public.appointments; r text; allowed jsonb := '{"SCHEDULED":["IN_TRANSIT","INSTALLING","FAILED"],"IN_TRANSIT":["INSTALLING","FAILED"],"INSTALLING":["TESTING","HANDOVER_PENDING","FAILED"],"TESTING":["HANDOVER_PENDING","INSTALLING","FAILED"],"HANDOVER_PENDING":["TESTING","INSTALLING","FAILED"],"FAILED":["SCHEDULED","IN_TRANSIT","INSTALLING"]}';
BEGIN
 r := public.operations_actor(p_company_id,p_actor_id,ARRAY['BOSS_ADMIN','TECHNICIAN']);
 SELECT * INTO i FROM public.installations WHERE company_id=p_company_id AND id=p_installation_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 SELECT * INTO a FROM public.appointments WHERE company_id=p_company_id AND id=i.appointment_id FOR UPDATE;
 IF NOT FOUND OR a.customer_id<>i.customer_id OR a.type<>'INSTALLATION' THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 IF r='TECHNICIAN' AND a.assignee_id<>p_actor_id THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
 IF i.status='COMPLETED' OR a.status NOT IN ('ASSIGNED','ACCEPTED','IN_PROGRESS') THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
 IF p_ref IS NOT NULL THEN
  IF NOT public.operations_evidence_ref(p_company_id,i.id,p_ref,p_type) THEN RAISE EXCEPTION 'INVALID_STORAGE_REF'; END IF;
  UPDATE public.installations SET photos=CASE WHEN p_type='photo' AND NOT(photos ? p_ref) THEN photos || jsonb_build_array(p_ref) ELSE photos END,
   handover_ref=CASE WHEN p_type='handover' THEN p_ref ELSE handover_ref END,updated_at=now() WHERE id=i.id;
 ELSE
  IF NOT COALESCE((allowed->i.status) ? p_status,false) THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
  UPDATE public.installations SET status=p_status,updated_at=now() WHERE id=i.id;
 END IF;
 PERFORM public.operations_audit(p_company_id,p_actor_id,'UPDATE_INSTALLATION','installations',i.id,jsonb_build_object('to_status',p_status,'evidence_type',p_type));
END $$;
-- Replace old signature: snapshot arguments bind Storage validation to locked DB refs.
DROP FUNCTION public.complete_installation_atomic(uuid,uuid,uuid,timestamptz);
CREATE FUNCTION public.complete_installation_atomic(p_company_id uuid,p_installation_id uuid,p_actor_id uuid,p_verified_photos jsonb,p_verified_handover text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i public.installations; o public.orders; a public.appointments; r text; ref text;
BEGIN
 r := public.operations_actor(p_company_id,p_actor_id,ARRAY['BOSS_ADMIN','TECHNICIAN']);
 SELECT * INTO i FROM public.installations WHERE company_id=p_company_id AND id=p_installation_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 SELECT * INTO o FROM public.orders WHERE company_id=p_company_id AND id=i.order_id FOR UPDATE;
 IF NOT FOUND OR o.customer_id<>i.customer_id THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 SELECT * INTO a FROM public.appointments WHERE company_id=p_company_id AND id=i.appointment_id FOR UPDATE;
 IF NOT FOUND OR a.customer_id<>i.customer_id OR a.type<>'INSTALLATION' THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 IF r='TECHNICIAN' AND a.assignee_id<>p_actor_id THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
 IF i.status='COMPLETED' AND o.order_status='COMPLETED' THEN RETURN jsonb_build_object('success',true,'idempotent',true); END IF;
 IF i.status<>'HANDOVER_PENDING' OR o.order_status NOT IN ('READY_FOR_INSTALL','INSTALLING') OR a.status NOT IN ('ACCEPTED','IN_PROGRESS') THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
 IF jsonb_typeof(i.photos)<>'array' OR jsonb_array_length(i.photos)=0 OR NULLIF(btrim(i.handover_ref),'') IS NULL THEN RAISE EXCEPTION 'MISSING_EVIDENCE'; END IF;
 IF i.photos IS DISTINCT FROM p_verified_photos OR i.handover_ref IS DISTINCT FROM p_verified_handover THEN RAISE EXCEPTION 'EVIDENCE_CHANGED'; END IF;
 FOR ref IN SELECT jsonb_array_elements_text(i.photos) LOOP
  IF NOT public.operations_evidence_ref(p_company_id,i.id,ref,'photo') THEN RAISE EXCEPTION 'INVALID_STORAGE_REF'; END IF;
 END LOOP;
 IF NOT public.operations_evidence_ref(p_company_id,i.id,i.handover_ref,'handover') THEN RAISE EXCEPTION 'INVALID_STORAGE_REF'; END IF;
 UPDATE public.installations SET status='COMPLETED',completed_at=now(),updated_at=now() WHERE id=i.id;
 UPDATE public.orders SET order_status='COMPLETED',updated_at=now() WHERE id=o.id;
 PERFORM public.operations_audit(p_company_id,p_actor_id,'COMPLETE_INSTALLATION_AND_HANDOVER','installations',i.id,jsonb_build_object('order_id',o.id));
 INSERT INTO public.operations_outbox(company_id,order_id,event_type,payload) VALUES(p_company_id,o.id,'ORDER_COMPLETED',jsonb_build_object('installation_id',i.id,'completed_at',now())) ON CONFLICT(company_id,order_id,event_type) DO NOTHING;
 RETURN jsonb_build_object('success',true,'idempotent',false);
END $$;
CREATE FUNCTION public.update_warranty_status_atomic(p_company_id uuid,p_ticket_id uuid,p_actor_id uuid,p_actor_role text,p_operation text,p_status text DEFAULT NULL,p_technician_id uuid DEFAULT NULL,p_notes text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.warranty_tickets; r text; next_status text; allowed jsonb := '{"OPEN":["CANCELLED"],"ASSIGNED":["IN_PROGRESS","OPEN","CANCELLED"],"IN_PROGRESS":["RESOLVED","FAILED"],"RESOLVED":["CLOSED"],"REOPENED":["IN_PROGRESS"]}';
BEGIN
 r := public.operations_actor(p_company_id,p_actor_id,ARRAY['BOSS_ADMIN','TECHNICIAN','SALE']);
 IF r IS DISTINCT FROM p_actor_role THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
 SELECT * INTO t FROM public.warranty_tickets WHERE company_id=p_company_id AND id=p_ticket_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND'; END IF;
 IF r='TECHNICIAN' AND t.assigned_to IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
 IF p_operation='assign' THEN
  IF r<>'BOSS_ADMIN' THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
  IF t.status NOT IN ('OPEN','REOPENED','ASSIGNED') THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
  PERFORM public.operations_actor(p_company_id,p_technician_id,ARRAY['TECHNICIAN']);
  next_status := 'ASSIGNED';
 ELSIF p_operation='reopen' THEN
  IF r NOT IN ('BOSS_ADMIN','SALE') THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
  IF t.status NOT IN ('RESOLVED','CLOSED') OR NULLIF(btrim(p_notes),'') IS NULL THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
  next_status := 'REOPENED';
 ELSIF p_operation='update' THEN
  IF r NOT IN ('BOSS_ADMIN','TECHNICIAN') THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
  IF NOT COALESCE((allowed->t.status) ? p_status,false) THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION'; END IF;
  next_status := p_status;
 ELSE RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 UPDATE public.warranty_tickets SET status=next_status,
 assigned_to=CASE WHEN p_operation='assign' THEN p_technician_id WHEN next_status='OPEN' THEN NULL ELSE assigned_to END,
 resolved_at=CASE WHEN next_status='RESOLVED' THEN now() WHEN next_status='REOPENED' THEN NULL ELSE resolved_at END,
 notes=CASE WHEN p_operation='reopen' THEN concat_ws(E'\n',notes,'REOPEN: '||p_notes) ELSE COALESCE(p_notes,notes) END,updated_at=now() WHERE id=t.id;
 PERFORM public.operations_audit(p_company_id,p_actor_id,'WARRANTY_'||upper(p_operation),'warranty_tickets',t.id,jsonb_build_object('from_status',t.status,'to_status',next_status));
END $$;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
 ('operations_actor','operations_audit','operations_evidence_ref','create_production_order_atomic','update_production_progress_atomic','record_quality_check_atomic','schedule_installation_atomic','mutate_installation_atomic','complete_installation_atomic','update_warranty_status_atomic') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
