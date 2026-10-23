import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { context as baseContext, snapshot as baseSnapshot } from './fixture';
const context = JSON.parse(JSON.stringify(baseContext).replaceAll('cc360000','ee360000')) as typeof baseContext;
const snapshot = JSON.parse(JSON.stringify(baseSnapshot).replaceAll('cc360000','ee360000')) as typeof baseSnapshot;

// Native local Docker socket only. No env file, remote URL, or production credentials.
if (process.env.NEXT_PUBLIC_SUPABASE_URL && !['localhost','127.0.0.1'].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname)) throw new Error('LOCAL_SUPABASE_ONLY');
const endpoint = execFileSync('docker', ['context','inspect','--format','{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
if (!endpoint.startsWith('unix://') || (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))) throw new Error('LOCAL_DOCKER_ONLY');
function sql(input: string) {
  return execFileSync('docker', ['exec','-i','supabase_db_ai-crm-cua-chong-ngap','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'], { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}
test('real PostgreSQL identity, tenant ACLs, queue fencing, history, list and timeline', () => {
  const output = sql(`BEGIN;
CREATE FUNCTION pg_temp.check_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %',label; END IF; END $$;
INSERT INTO public.companies(id,name,status) VALUES('${context.companyId}','Customer 360 synthetic A','ACTIVE'),('ee360000-0000-4000-8000-000000000011','Customer 360 synthetic B','ACTIVE');
INSERT INTO public.customers(id,company_id,name,source,stage) VALUES('${context.customerId}','${context.companyId}','Synthetic Customer 360','ZALO','LEAD_NEW'),
('ee360000-0000-4000-8000-000000000012','ee360000-0000-4000-8000-000000000011','Tenant B private name','FACEBOOK','LEAD_NEW'),
('ee360000-0000-4000-8000-000000000013','${context.companyId}','Conflicting customer','MANUAL','LEAD_NEW');
SELECT public.c360_bind_identity('${context.companyId}','${context.customerId}','ZALO','synthetic-account:uid','Synthetic Zalo',true);
SELECT public.c360_bind_identity('${context.companyId}','${context.customerId}','FACEBOOK','synthetic-page:psid','Synthetic Facebook',true);
SELECT public.c360_bind_identity('${context.companyId}','${context.customerId}','PHONE',repeat('a',64),NULL,true);
SELECT public.c360_bind_identity('${context.companyId}','${context.customerId}','EMAIL',repeat('b',64),NULL,true,'synthetic@example.com');
INSERT INTO private.customer_private_contacts(company_id,customer_id,normalized_phone,raw_phone) VALUES('${context.companyId}','${context.customerId}','+84912345678','0912345678');
INSERT INTO public.customer_dossier_profiles(company_id,customer_id,address,birth_year,special_notes) VALUES('${context.companyId}','${context.customerId}','Địa chỉ local synthetic',1998,'Chỉ liên hệ buổi chiều');
SELECT pg_temp.check_ok((SELECT count(*)=4 FROM public.identities WHERE company_id='${context.companyId}' AND customer_id='${context.customerId}'),'one customer multiple identities');
SELECT pg_temp.check_ok(public.c360_bind_identity('${context.companyId}','ee360000-0000-4000-8000-000000000013','ZALO','synthetic-account:uid')->>'status'='CONFLICT','conflict fail safe');
SELECT pg_temp.check_ok((SELECT customer_id='${context.customerId}' FROM public.identities WHERE company_id='${context.companyId}' AND channel='ZALO'),'no identity rebind');
SELECT public.c360_bind_identity('ee360000-0000-4000-8000-000000000011','ee360000-0000-4000-8000-000000000012','ZALO','synthetic-account:uid','Tenant B Zalo',true);
SELECT pg_temp.check_ok((SELECT count(*)=1 FROM public.customer_identity_conflicts WHERE company_id='${context.companyId}'),'conflict surfaced');
DO $$ BEGIN
  INSERT INTO public.customer_dossier_profiles(company_id,customer_id) VALUES('${context.companyId}','ee360000-0000-4000-8000-000000000012');
  RAISE EXCEPTION 'cross tenant profile allowed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_list('${context.companyId}',p_search=>'Synthetic Zalo')->'items')=1,'Zalo search');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_list('${context.companyId}',p_search=>'synthetic@example.com')->'items')=1,'email search');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_list('${context.companyId}',p_search=>'+84912345678')->'items')=1,'phone search');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_list('${context.companyId}',p_search=>'Tenant B')->'items')=0,'cross tenant search denial');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_list('${context.companyId}',p_channel=>'FACEBOOK')->'items')=1,'channel filter');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_list('${context.companyId}',p_stage=>'LOST')->'items')=0,'stage filter');
SELECT pg_temp.check_ok((public.c360_list('${context.companyId}',p_search=>'Synthetic Zalo')->'items'->0->>'phone') NOT LIKE '%912345678%','raw phone never returned');
INSERT INTO public.customers(company_id,name,source,stage) SELECT '${context.companyId}','Paging synthetic '||n,'MANUAL','LEAD_NEW' FROM generate_series(1,26)n;
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_list('${context.companyId}',p_page=>1)->'items')=25,'server pagination first page');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_list('${context.companyId}',p_page=>2)->'items')=3,'server pagination second page');
SELECT pg_temp.check_ok((SELECT count(*)=0 FROM public.c360_claim_refresh('${context.companyId}','${context.customerId}')),'default OFF');
INSERT INTO public.customer_dossier_settings(company_id,enabled) VALUES('${context.companyId}',true);
SELECT pg_temp.check_ok(public.c360_request_refresh('${context.companyId}','${context.customerId}'),'manual request');
SELECT pg_temp.check_ok(NOT public.c360_request_refresh('${context.companyId}','${context.customerId}'),'manual dedupe/rate limit');
CREATE TEMP TABLE claim1 AS SELECT * FROM public.c360_claim_refresh('${context.companyId}','${context.customerId}');
SELECT pg_temp.check_ok((SELECT count(*)=1 FROM claim1),'first claim');
SELECT pg_temp.check_ok((SELECT count(*)=0 FROM public.c360_claim_refresh('${context.companyId}','${context.customerId}')),'no concurrent duplicate claim');
INSERT INTO public.interactions(id,company_id,customer_id,channel,type,direction,sanitized_content,sanitization_status,actor_type,created_at)
VALUES('ee360000-0000-4000-8000-000000000003','${context.companyId}','${context.customerId}','ZALO','MESSAGE','INBOUND','Tôi quan tâm cửa chống ngập. Tôi lo chi phí lắp đặt.','SUCCEEDED','CUSTOMER','2026-10-23T10:00:00Z'),
('ee360000-0000-4000-8000-000000000004','${context.companyId}','${context.customerId}','FACEBOOK','MESSAGE','OUTBOUND','Sale đã gửi thông tin chương trình.','SUCCEEDED','SALE','2026-10-23T10:01:00Z'),
('ee360000-0000-4000-8000-000000000005','${context.companyId}','${context.customerId}','WEBSITE','NOTE','OUTBOUND','Ghi chú do sale nhập.','SUCCEEDED','SALE','2026-10-23T10:02:00Z');
SELECT pg_temp.check_ok(NOT public.c360_finish_refresh('${context.companyId}','${context.customerId}',(SELECT lock_token FROM claim1),(SELECT claimed_version FROM claim1),'${JSON.stringify(snapshot)}','synthetic-javis'),'stale generation rejected');
UPDATE public.customer_dossier_refresh SET due_at=now()-interval '1 second' WHERE company_id='${context.companyId}' AND customer_id='${context.customerId}';
CREATE TEMP TABLE claim2 AS SELECT * FROM public.c360_claim_refresh('${context.companyId}','${context.customerId}');
SELECT pg_temp.check_ok(NOT public.c360_finish_refresh('${context.companyId}','${context.customerId}',gen_random_uuid(),(SELECT claimed_version FROM claim2),'${JSON.stringify(snapshot)}','synthetic-javis'),'wrong lease rejected');
SELECT pg_temp.check_ok(public.c360_finish_refresh('${context.companyId}','${context.customerId}',(SELECT lock_token FROM claim2),(SELECT claimed_version FROM claim2),'${JSON.stringify(snapshot)}','synthetic-javis'),'valid snapshot persisted');
SELECT pg_temp.check_ok(NOT public.c360_finish_refresh('${context.companyId}','${context.customerId}',(SELECT lock_token FROM claim2),(SELECT claimed_version FROM claim2),'${JSON.stringify(snapshot)}','synthetic-javis'),'idempotent finish');
SELECT pg_temp.check_ok((SELECT count(*)=1 FROM public.customer_ai_snapshots WHERE company_id='${context.companyId}'),'only one version');
UPDATE public.customer_dossier_refresh SET last_manual_at=now()-interval '2 minutes' WHERE company_id='${context.companyId}' AND customer_id='${context.customerId}';
SELECT public.c360_request_refresh('${context.companyId}','${context.customerId}');
CREATE TEMP TABLE claim3 AS SELECT * FROM public.c360_claim_refresh('${context.companyId}','${context.customerId}');
SELECT public.c360_finish_refresh('${context.companyId}','${context.customerId}',(SELECT lock_token FROM claim3),(SELECT claimed_version FROM claim3),NULL,'synthetic-javis');
SELECT pg_temp.check_ok((SELECT count(*)=1 FROM public.customer_ai_snapshots WHERE company_id='${context.companyId}'),'AI failure preserves previous snapshot');
SELECT pg_temp.check_ok((SELECT error_code='AI_REFRESH_FAILED' FROM public.customer_dossier_refresh WHERE company_id='${context.companyId}' AND customer_id='${context.customerId}'),'failure state');
SELECT pg_temp.check_ok(NOT public.c360_finish_refresh('${context.companyId}','${context.customerId}',NULL,(SELECT claimed_version FROM claim3),'${JSON.stringify(snapshot)}','synthetic-javis'),'null token and cleared lease fail closed');
SELECT pg_temp.check_ok((SELECT snapshot->'evidence'='${JSON.stringify(snapshot.evidence)}'::jsonb FROM public.customer_ai_snapshots WHERE company_id='${context.companyId}'),'evidence preserved');
UPDATE public.customer_dossier_refresh SET due_at=now()-interval '1 second' WHERE company_id='${context.companyId}' AND customer_id='${context.customerId}';
CREATE TEMP TABLE expired AS SELECT * FROM public.c360_claim_refresh('${context.companyId}','${context.customerId}');
UPDATE public.customer_dossier_refresh SET lease_until=now()-interval '1 second' WHERE company_id='${context.companyId}' AND customer_id='${context.customerId}';
SELECT pg_temp.check_ok(NOT public.c360_finish_refresh('${context.companyId}','${context.customerId}',(SELECT lock_token FROM expired),(SELECT claimed_version FROM expired),'${JSON.stringify(snapshot)}','synthetic-javis'),'expired lease rejected');
CREATE TEMP TABLE recovered AS SELECT * FROM public.c360_claim_refresh('${context.companyId}','${context.customerId}');
SELECT pg_temp.check_ok(public.c360_finish_refresh('${context.companyId}','${context.customerId}',(SELECT lock_token FROM recovered),(SELECT claimed_version FROM recovered),'${JSON.stringify(snapshot)}','synthetic-javis'),'expired claim recovered');
SELECT pg_temp.check_ok((SELECT count(*)=2 FROM public.customer_ai_snapshots WHERE company_id='${context.companyId}'),'history versions retained');
SELECT pg_temp.check_ok(public.c360_timeline('${context.companyId}','${context.customerId}')->'items'->0->>'kind'='NOTE','chronological ordering');
CREATE TEMP TABLE before_resanitize AS SELECT requested_version FROM public.customer_dossier_refresh WHERE company_id='${context.companyId}' AND customer_id='${context.customerId}';
UPDATE public.interactions SET sanitized_content=sanitized_content,sanitized_at=clock_timestamp() WHERE id='ee360000-0000-4000-8000-000000000003';
SELECT pg_temp.check_ok((SELECT requested_version FROM public.customer_dossier_refresh WHERE company_id='${context.companyId}' AND customer_id='${context.customerId}')=(SELECT requested_version FROM before_resanitize),'same interaction does not duplicate refresh');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_timeline('${context.companyId}','${context.customerId}',p_filter=>'MESSAGE')->'items')=2,'timeline filters');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_timeline('${context.companyId}','${context.customerId}',p_filter=>'AI',p_include_ai=>false)->'items')=0,'sale snapshot hidden');
SELECT pg_temp.check_ok(NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'c360_%' AND
  (has_function_privilege('anon',oid,'EXECUTE') OR has_function_privilege('authenticated',oid,'EXECUTE') OR NOT has_function_privilege('service_role',oid,'EXECUTE') OR NOT proconfig @> ARRAY['search_path=""'])),'all RPC ACL/search paths');
SELECT pg_temp.check_ok(NOT has_table_privilege('authenticated','public.customer_ai_snapshots','SELECT'),'snapshot table server only');
SELECT pg_temp.check_ok(NOT has_table_privilege('service_role','public.customer_ai_snapshots','UPDATE'),'immutable snapshot history');
SET LOCAL ROLE authenticated;
DO $$ BEGIN PERFORM public.c360_request_refresh('${context.companyId}','${context.customerId}'); RAISE EXCEPTION 'RPC unexpectedly authorized'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM public.c360_bind_identity('${context.companyId}','${context.customerId}','ZALO','bad'); RAISE EXCEPTION 'identity RPC unexpectedly authorized'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
ROLLBACK;
`);
  assert.match(output, /ROLLBACK/);
});

test('recording/transcript linkage, timeline deduplication, and real cross-tenant recording RLS denial', () => {
  const output = sql(`BEGIN;
CREATE FUNCTION pg_temp.check_ok(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %',label; END IF; END $$;
INSERT INTO public.companies(id,name,status) VALUES('${context.companyId}','C360 recording A','ACTIVE'),('ee360000-0000-4000-8000-000000000011','C360 recording B','ACTIVE');
INSERT INTO auth.users(id,email) VALUES('ee360000-0000-4000-8000-000000000021','c360-a@example.test'),('ee360000-0000-4000-8000-000000000022','c360-b@example.test');
INSERT INTO public.user_profiles(id,full_name,status) VALUES('ee360000-0000-4000-8000-000000000021','C360 Boss A','ACTIVE'),('ee360000-0000-4000-8000-000000000022','C360 Boss B','ACTIVE') ON CONFLICT(id) DO UPDATE SET status='ACTIVE';
INSERT INTO public.company_members(company_id,user_id,role,status) VALUES('${context.companyId}','ee360000-0000-4000-8000-000000000021','BOSS_ADMIN','ACTIVE'),('ee360000-0000-4000-8000-000000000011','ee360000-0000-4000-8000-000000000022','BOSS_ADMIN','ACTIVE');
INSERT INTO public.customers(id,company_id,name,source,stage) VALUES('${context.customerId}','${context.companyId}','C360 recording customer','ZALO','LEAD_NEW');
INSERT INTO public.zalo_recording_devices(id,company_id,device_name,device_key_hash,zalo_account_key) VALUES('ee360000-0000-4000-8000-000000000031','${context.companyId}','Synthetic local device',repeat('c',64),'ee360000-0000-4000-8000-000000000032');
INSERT INTO public.zalo_personal_calls(id,company_id,device_id,local_call_id,zalo_account_key,customer_id,direction,remote_display_name,remote_display_name_normalized,identity_confidence,
 started_at,ended_at,duration_seconds,agent_version,audio_validation,recording_status,recording_path,recording_bytes,recording_sha256,payload_fingerprint,upload_lease,upload_lease_until,matching_status)
VALUES('ee360000-0000-4000-8000-000000000033','${context.companyId}','ee360000-0000-4000-8000-000000000031','ee360000-0000-4000-8000-000000000034','ee360000-0000-4000-8000-000000000032','${context.customerId}',
 'INBOUND','Synthetic Customer','synthetic customer','UNKNOWN','2026-10-23T10:03:00Z','2026-10-23T10:03:30Z',30,'synthetic','{}','READY','synthetic-local-c360/recording.m4a',200,repeat('d',64),repeat('e',64),gen_random_uuid(),now()+interval '1 minute','EXACT');
INSERT INTO public.zalo_call_transcriptions(id,company_id,call_id,customer_id,status,full_transcript,completed_at)
VALUES('ee360000-0000-4000-8000-000000000035','${context.companyId}','ee360000-0000-4000-8000-000000000033','${context.customerId}','COMPLETED','CUSTOMER: Tôi quan tâm cửa chống ngập. STAFF: Sẽ gọi lại để tư vấn.',now());
INSERT INTO public.interactions(company_id,customer_id,channel,type,direction,sanitized_content,sanitization_status,actor_type,external_ref)
VALUES('${context.companyId}','${context.customerId}','ZALO','CALL_EVENT','INBOUND','Synthetic call event','SUCCEEDED','CUSTOMER','ee360000-0000-4000-8000-000000000033');
SELECT pg_temp.check_ok(jsonb_array_length(public.c360_timeline('${context.companyId}','${context.customerId}',p_filter=>'CALL')->'items')=1,'no duplicate call interaction');
SELECT pg_temp.check_ok((SELECT t.customer_id=z.customer_id AND t.call_id=z.id FROM public.zalo_call_transcriptions t JOIN public.zalo_personal_calls z ON z.company_id=t.company_id AND z.id=t.call_id WHERE t.id='ee360000-0000-4000-8000-000000000035'),'transcript references recording/customer');
SELECT set_config('request.jwt.claims','{"sub":"ee360000-0000-4000-8000-000000000021","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_ok((SELECT count(*)=1 FROM public.zalo_personal_calls WHERE id='ee360000-0000-4000-8000-000000000033'),'same tenant recording readable');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"sub":"ee360000-0000-4000-8000-000000000022","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_ok((SELECT count(*)=0 FROM public.zalo_personal_calls WHERE id='ee360000-0000-4000-8000-000000000033'),'cross tenant recording inaccessible');
SELECT pg_temp.check_ok((SELECT count(*)=0 FROM public.zalo_call_transcriptions WHERE id='ee360000-0000-4000-8000-000000000035'),'cross tenant transcript inaccessible');
RESET ROLE;
ROLLBACK;`);
  assert.match(output, /ROLLBACK/);
});
