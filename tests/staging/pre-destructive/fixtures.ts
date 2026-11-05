import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectTransactionEnvelope } from '../../../scripts/meta-ads/ledger-readiness';
import { quote, sql } from './local-fixture';

function originalFunction(name: string) {
  const source=readFileSync('supabase/migrations/20260928000001_operations_p0_hardening.sql','utf8');
  const found=inspectTransactionEnvelope(source).statements.find(s=>new RegExp(`^CREATE (OR REPLACE )?FUNCTION PUBLIC\\.${name.toUpperCase()}\\(`).test(s.head));
  if(!found)throw new Error('FIXTURE_FUNCTION_NOT_FOUND');
  return source.slice(found.start,found.end);
}

export function setupSyntheticDomain(db: string) {
  sql(db,`CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA private;
    REVOKE ALL ON SCHEMA private FROM PUBLIC,anon,authenticated;
    GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SET search_path='' AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE public.companies(id uuid PRIMARY KEY,name text,status text);
    CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,full_name text,status text);
    CREATE TABLE public.company_members(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies,user_id uuid REFERENCES public.user_profiles,role text,status text,UNIQUE(company_id,user_id));
    CREATE TABLE public.customers(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies,name text,UNIQUE(company_id,id));
    CREATE TABLE public.appointments(id uuid PRIMARY KEY,company_id uuid,customer_id uuid,type text,assignee_id uuid REFERENCES public.user_profiles,address text,status text,start_time timestamptz,UNIQUE(company_id,id),FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id));
    CREATE TABLE public.surveys(id uuid PRIMARY KEY,company_id uuid,customer_id uuid,appointment_id uuid,completed_by uuid,site_condition text,notes text,completed_at timestamptz,photos jsonb,measurements jsonb,FOREIGN KEY(company_id,appointment_id) REFERENCES public.appointments(company_id,id));
    CREATE TABLE public.orders(id uuid PRIMARY KEY,company_id uuid,customer_id uuid,order_status text,updated_at timestamptz DEFAULT now(),UNIQUE(company_id,id),FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id));
    CREATE TABLE public.production_orders(id uuid PRIMARY KEY,company_id uuid,order_id uuid,status text,qc_status text,updated_at timestamptz DEFAULT now(),FOREIGN KEY(company_id,order_id) REFERENCES public.orders(company_id,id));
    CREATE TABLE public.installations(id uuid PRIMARY KEY,company_id uuid,customer_id uuid,order_id uuid,appointment_id uuid,status text,photos jsonb,handover_ref text,completed_at timestamptz,FOREIGN KEY(company_id,order_id) REFERENCES public.orders(company_id,id),FOREIGN KEY(company_id,appointment_id) REFERENCES public.appointments(company_id,id));
    CREATE TABLE public.contracts(id uuid PRIMARY KEY,company_id uuid,order_id uuid,revision_no integer,template_version text,generated_file_ref text,signed_file_ref text,status text,contract_value numeric,is_current boolean,FOREIGN KEY(company_id,order_id) REFERENCES public.orders(company_id,id));
    CREATE TABLE public.calls(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies,recording_ref text);
    CREATE SEQUENCE public.fixture_audit_seq;
    CREATE TABLE public.audit_logs(id bigint PRIMARY KEY DEFAULT nextval('public.fixture_audit_seq'),company_id uuid,user_id uuid,action text,resource_type text,resource_id uuid,result text,metadata jsonb);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,content text,UNIQUE(bucket_id,name));
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON storage.objects FROM PUBLIC,anon,authenticated;
    GRANT USAGE ON SCHEMA storage TO service_role; GRANT ALL ON storage.objects TO service_role;
    CREATE TABLE private.token_store(id uuid PRIMARY KEY,company_id uuid,encrypted_token text);
    ALTER TABLE private.token_store ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON private.token_store FROM PUBLIC,anon,authenticated;
    GRANT USAGE ON SCHEMA private TO service_role; GRANT ALL ON private.token_store TO service_role;
    CREATE FUNCTION public.fixture_member(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
      SELECT EXISTS(SELECT 1 FROM public.company_members m JOIN public.user_profiles u ON u.id=m.user_id
        WHERE m.company_id=target AND m.user_id=auth.uid() AND m.status='ACTIVE' AND u.status='ACTIVE') $$;
    REVOKE ALL ON FUNCTION public.fixture_member(uuid) FROM PUBLIC,anon;
    GRANT EXECUTE ON FUNCTION public.fixture_member(uuid) TO authenticated;
    ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY self_profile ON public.user_profiles FOR SELECT TO authenticated USING(id=auth.uid());
    ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;
    CREATE POLICY self_membership ON public.company_members FOR SELECT TO authenticated USING(user_id=auth.uid());
    GRANT SELECT ON public.user_profiles,public.company_members TO authenticated,service_role;
    CREATE FUNCTION public.fixture_tenant_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
      BEGIN IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN RAISE EXCEPTION 'TENANT_IMMUTABLE'; END IF; RETURN NEW; END $$;
  `);
  for(const table of ['customers','appointments','surveys','orders','production_orders','installations','contracts','calls','audit_logs']) {
    sql(db,`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_read ON public.${table} FOR SELECT TO authenticated USING(public.fixture_member(company_id));
      GRANT SELECT ON public.${table} TO authenticated,service_role;
      CREATE TRIGGER tenant_immutable BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.fixture_tenant_immutable();`);
  }
  sql(db,originalFunction('operations_actor')+originalFunction('operations_audit')+originalFunction('record_quality_check_atomic'));
  for(const signature of ['operations_actor(uuid,uuid,text[])','operations_audit(uuid,uuid,text,text,uuid,jsonb)','record_quality_check_atomic(uuid,uuid,text,uuid,text)']) {
    sql(db,`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
  }
}

export function seedSyntheticDomain(db: string) {
  const ids={company:randomUUID(),foreign:randomUUID(),boss:randomUUID(),sale:randomUUID(),tech:randomUUID(),otherBoss:randomUUID(),customer:randomUUID(),otherCustomer:randomUUID(),appointment:randomUUID(),installationAppointment:randomUUID(),survey:randomUUID(),order:randomUUID(),production:randomUUID(),installation:randomUUID(),contract:randomUUID(),call:randomUUID(),otherCall:randomUUID()};
  const refs={survey:`${ids.company}/surveys/${ids.survey}/photo.jpg`,contract:`${ids.company}/contracts/${ids.contract}/generated.pdf`,signed:`${ids.company}/contracts/${ids.contract}/signed.pdf`,installation:`${ids.company}/installations/${ids.installation}/photo/${randomUUID()}.jpg`,handover:`${ids.company}/installations/${ids.installation}/handover/${randomUUID()}.pdf`,recording:`${ids.company}/${ids.call}/recording.mp3`,otherRecording:`${ids.foreign}/${ids.otherCall}/recording.mp3`};
  sql(db,`INSERT INTO public.companies VALUES('${ids.company}','Synthetic tenant A','ACTIVE'),('${ids.foreign}','Synthetic tenant B','ACTIVE');
    INSERT INTO public.user_profiles VALUES('${ids.boss}','Boss','ACTIVE'),('${ids.sale}','Sale','ACTIVE'),('${ids.tech}','Tech','ACTIVE'),('${ids.otherBoss}','Other boss','ACTIVE');
    INSERT INTO public.company_members VALUES('${randomUUID()}','${ids.company}','${ids.boss}','BOSS_ADMIN','ACTIVE'),('${randomUUID()}','${ids.company}','${ids.sale}','SALE','ACTIVE'),('${randomUUID()}','${ids.company}','${ids.tech}','TECHNICIAN','ACTIVE'),('${randomUUID()}','${ids.foreign}','${ids.otherBoss}','BOSS_ADMIN','ACTIVE');
    INSERT INTO public.customers VALUES('${ids.customer}','${ids.company}','Synthetic customer A'),('${ids.otherCustomer}','${ids.foreign}','Synthetic customer B');
    INSERT INTO public.appointments VALUES('${ids.appointment}','${ids.company}','${ids.customer}','SURVEY','${ids.tech}','Synthetic address','ASSIGNED',now()),('${ids.installationAppointment}','${ids.company}','${ids.customer}','INSTALLATION','${ids.tech}','Synthetic address','ASSIGNED',now());
    INSERT INTO public.surveys VALUES('${ids.survey}','${ids.company}','${ids.customer}','${ids.appointment}','${ids.tech}','SYNTHETIC',NULL,now(),${quote(JSON.stringify([refs.survey]))}::jsonb,'{}');
    INSERT INTO public.orders VALUES('${ids.order}','${ids.company}','${ids.customer}','IN_PRODUCTION',now());
    INSERT INTO public.production_orders VALUES('${ids.production}','${ids.company}','${ids.order}','QC_IN_PROGRESS','PENDING',now());
    INSERT INTO public.installations VALUES('${ids.installation}','${ids.company}','${ids.customer}','${ids.order}','${ids.installationAppointment}','SCHEDULED',${quote(JSON.stringify([refs.installation]))}::jsonb,${quote(refs.handover)},NULL);
    INSERT INTO public.contracts VALUES('${ids.contract}','${ids.company}','${ids.order}',1,'fixture-v1',${quote(refs.contract)},${quote(refs.signed)},'SIGNED',100,true);
    INSERT INTO public.calls VALUES('${ids.call}','${ids.company}',${quote(refs.recording)}),('${ids.otherCall}','${ids.foreign}',${quote(refs.otherRecording)});
    INSERT INTO private.token_store VALUES('${randomUUID()}','${ids.company}','synthetic-encrypted-placeholder');`);
  for(const [key,name] of Object.entries(refs)) {
    const bucket=key==='survey'?'survey-photos':key==='contract'||key==='signed'?'contracts':key==='installation'||key==='handover'?'installation-docs':'call-recordings';
    sql(db,`INSERT INTO storage.objects VALUES('${randomUUID()}',${quote(bucket)},${quote(name)},${quote('synthetic-file-'+key)});`);
  }
  return {ids,refs};
}
