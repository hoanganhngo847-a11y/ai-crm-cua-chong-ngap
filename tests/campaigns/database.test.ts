import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// Local socket only, synthetic data, rollback. Never reads .env or remote credentials.
const endpoint = execFileSync(
  "docker",
  ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
  { encoding: "utf8" },
).trim();
if (
  !endpoint.startsWith("unix://") ||
  (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://"))
)
  throw new Error("LOCAL_DOCKER_ONLY");
const testDb = `campaign_test_${process.pid}_${Date.now()}`;
function sql(input: string) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_ai-crm-cua-chong-ngap",
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      testDb,
    ],
    { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
}
before(() => {
  execFileSync("docker", [
    "exec",
    "supabase_db_ai-crm-cua-chong-ngap",
    "createdb",
    "-U",
    "supabase_admin",
    testDb,
  ]);
  const schema = execFileSync(
    "docker",
    [
      "exec",
      "supabase_db_ai-crm-cua-chong-ngap",
      "pg_dump",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "--schema-only",
      "--no-publications",
      "--no-subscriptions",
      "--no-owner",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  sql(schema);
  // These drops run solely in the disposable test database, never the dev database.
  sql(`DROP TABLE IF EXISTS public.messaging_channel_evidence,public.messaging_suppressions,public.messaging_campaign_audit,public.messaging_campaign_recipients,public.messaging_campaigns,public.message_templates,public.messaging_sender_accounts,public.messaging_campaign_settings,private.messaging_rate_buckets CASCADE;
    ALTER TABLE public.identities DROP CONSTRAINT IF EXISTS campaign_identity_scope;
    DO $$ DECLARE f record; BEGIN FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'campaign_%' LOOP EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE',f.sig); END LOOP; END $$;`);
  sql(
    readFileSync(
      "supabase/migrations/20261024041037_bulk_messaging_campaigns.sql",
      "utf8",
    ),
  );
});
after(() => {
  execFileSync("docker", [
    "exec",
    "supabase_db_ai-crm-cua-chong-ngap",
    "dropdb",
    "-U",
    "supabase_admin",
    "--force",
    testDb,
  ]);
});
const A = "bc000000-0000-4000-8000-000000000001",
  B = "bc000000-0000-4000-8000-000000000002";
const boss = "bc000000-0000-4000-8000-000000000011",
  sale = "bc000000-0000-4000-8000-000000000012",
  tech = "bc000000-0000-4000-8000-000000000013";
const cust = "bc000000-0000-4000-8000-000000000021",
  other = "bc000000-0000-4000-8000-000000000022",
  missing = "bc000000-0000-4000-8000-000000000023";
const sender = "bc000000-0000-4000-8000-000000000031",
  otherSender = "bc000000-0000-4000-8000-000000000032",
  oa = "bc000000-0000-4000-8000-000000000033";
const template = "bc000000-0000-4000-8000-000000000041",
  zaloTemplate = "bc000000-0000-4000-8000-000000000042";
const identity = "bc000000-0000-4000-8000-000000000051",
  conversation = "bc000000-0000-4000-8000-000000000061";
const setup = `BEGIN;
CREATE FUNCTION pg_temp.ok(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.denied(statement text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN RETURN; END;
 RAISE EXCEPTION 'Expected rejection: %',statement; END $$;
INSERT INTO public.companies(id,name,status) VALUES('${A}','Campaign synthetic A','ACTIVE'),('${B}','Campaign synthetic B','ACTIVE');
INSERT INTO auth.users(id,email) VALUES('${boss}','campaign-boss@synthetic.test'),('${sale}','campaign-sale@synthetic.test'),('${tech}','campaign-tech@synthetic.test');
INSERT INTO public.user_profiles(id,full_name,status) VALUES('${boss}','Boss synthetic','ACTIVE'),('${sale}','Sale synthetic','ACTIVE'),('${tech}','Tech synthetic','ACTIVE') ON CONFLICT(id) DO UPDATE SET status='ACTIVE';
INSERT INTO public.company_members(company_id,user_id,role,status) VALUES('${A}','${boss}','BOSS_ADMIN','ACTIVE'),('${A}','${sale}','SALE','ACTIVE'),('${A}','${tech}','TECHNICIAN','ACTIVE');
INSERT INTO public.messaging_campaign_settings(company_id,enabled) VALUES('${A}',true),('${B}',true);
INSERT INTO public.customers(id,company_id,name,source,stage) VALUES('${cust}','${A}','Synthetic Customer','FACEBOOK','LEAD_NEW'),('${other}','${B}','PRIVATE TENANT B','FACEBOOK','LEAD_NEW'),('${missing}','${A}','Missing identity','MANUAL','LEAD_NEW');
INSERT INTO public.messaging_sender_accounts(id,company_id,channel,external_id,name,connected,verified) VALUES('${sender}','${A}','FACEBOOK','111','Synthetic Page',true,true),('${otherSender}','${B}','FACEBOOK','222','Tenant B Page',true,true),('${oa}','${A}','ZALO_OA','333','Synthetic OA',false,false);
INSERT INTO public.message_templates(id,company_id,name,channel,template_type,content,status,created_by) VALUES('${template}','${A}','Synthetic approved template','FACEBOOK','MESSENGER_RESPONSE','Hello {{customer_name}} at {{company_name}}','ACTIVE','${boss}');
INSERT INTO public.message_templates(id,company_id,name,channel,template_type,provider_template_id,content,status,created_by) VALUES('${zaloTemplate}','${A}','Synthetic ZBS','ZALO_OA','ZBS_TEMPLATE','provider-approved-synthetic','Hello {{customer_name}}','PROVIDER_APPROVED','${boss}');
INSERT INTO public.identities(id,company_id,customer_id,channel,external_id,verified) VALUES('${identity}','${A}','${cust}','FACEBOOK','111:12345',true);
INSERT INTO public.conversations(id,company_id,customer_id,channel,external_conversation_id) VALUES('${conversation}','${A}','${cust}','FACEBOOK','111:12345');
INSERT INTO public.interactions(company_id,customer_id,conversation_id,channel,type,direction,actor_type,sanitized_content,sanitization_status) VALUES('${A}','${cust}','${conversation}','FACEBOOK','MESSAGE','INBOUND','CUSTOMER','Hello','SUCCEEDED');
CREATE FUNCTION pg_temp.make_campaign(actor uuid DEFAULT '${boss}',chan text DEFAULT 'FACEBOOK',sid uuid DEFAULT '${sender}',tid uuid DEFAULT '${template}',recipients jsonb DEFAULT '["${cust}","${missing}"]') RETURNS uuid LANGUAGE sql AS $$
 SELECT (public.campaign_command('${A}',actor,'create',jsonb_build_object('request_id',gen_random_uuid(),'name','Synthetic campaign','channel',chan,'sender_account_id',sid,'template_id',tid,'customer_ids',recipients))->>'id')::uuid $$;
CREATE FUNCTION pg_temp.ready_confirm(cid uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',cid));
 PERFORM public.campaign_command('${A}','${boss}','confirm',jsonb_build_object('id',cid,'expected_version',(SELECT validation_version FROM public.messaging_campaigns WHERE id=cid),'expected_eligible',1,'scheduled_at',NULL)); END $$;
`;
function run(body: string) {
  assert.match(sql(setup + body + "\nROLLBACK;"), /ROLLBACK/);
}

test("DB tenant scope, RBAC, sender, immutable snapshot, duplicates, Zero-Phone and suppression", () =>
  run(`
SELECT pg_temp.denied($q$SELECT public.campaign_read('${B}','${boss}')$q$);
SELECT pg_temp.denied($q$SELECT public.campaign_read('${A}','${tech}')$q$);
SELECT pg_temp.denied($q$SELECT pg_temp.make_campaign(sid=>'${otherSender}')$q$);
SELECT pg_temp.denied($q$SELECT pg_temp.make_campaign(recipients=>'["${other}"]')$q$);
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign(recipients=>'["${cust}","${cust}","${missing}"]') id;
SELECT pg_temp.ok((SELECT selected_count=2 FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'duplicate customer deduplicated');
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.messaging_campaign_recipients WHERE delivery_status<>'PENDING'),'create never queues');
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok((SELECT eligible_count=1 FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'one eligible');
SELECT pg_temp.ok((SELECT eligibility_status='MISSING_IDENTITY' FROM public.messaging_campaign_recipients WHERE customer_id='${missing}'),'Facebook missing');
UPDATE public.message_templates SET content='CHANGED' WHERE id='${template}';
SELECT pg_temp.ok((SELECT template_snapshot->>'content' LIKE 'Hello%' FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'immutable template snapshot');
SELECT pg_temp.denied($q$UPDATE public.messaging_campaigns SET template_snapshot='{}' WHERE id=(SELECT id FROM camp)$q$);
SELECT pg_temp.denied($q$SELECT public.campaign_command('${A}','${sale}','template','{}')$q$);
SELECT pg_temp.denied($q$SELECT public.campaign_command('${A}','${boss}','template','{"name":"bad","channel":"FACEBOOK","template_type":"MESSENGER_RESPONSE","content":"{{phone}}","status":"ACTIVE"}')$q$);
SELECT pg_temp.ok(public.campaign_read('${A}','${boss}',jsonb_build_object('id',(SELECT id FROM camp)))::text NOT LIKE '%external_id%','routing identity stays server side');
INSERT INTO public.messaging_suppressions(company_id,customer_id,channel,status,created_by) VALUES('${A}','${cust}','FACEBOOK','UNSUBSCRIBED','${boss}');
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok((SELECT eligibility_status='UNSUBSCRIBED' FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'suppression hard block');
SELECT pg_temp.denied($q$SELECT public.campaign_command('${A}','${boss}','confirm',jsonb_build_object('id',(SELECT id FROM camp),'expected_version',(SELECT validation_version FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'expected_eligible',1))$q$);
`));

test("DB confirm idempotency, bounded claims, lease fencing, timeline, Inbox and monotonic receipts", () =>
  run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign() id;
SELECT pg_temp.ready_confirm((SELECT id FROM camp));
SELECT public.campaign_command('${A}','${boss}','confirm',jsonb_build_object('id',(SELECT id FROM camp),'expected_version',(SELECT validation_version FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'expected_eligible',1));
SELECT pg_temp.ok((SELECT count(*)=1 FROM public.messaging_campaign_audit WHERE event='campaign_confirmed'),'one confirm');
CREATE TEMP TABLE claim AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
SELECT pg_temp.ok(public.campaign_claim('${A}','FACEBOOK') IS NULL,'no overlapping duplicate claim');
SELECT pg_temp.ok(public.campaign_begin('${A}',((SELECT job FROM claim)->>'id')::uuid,gen_random_uuid()) IS NULL,'wrong fencing token');
SELECT pg_temp.ok(public.campaign_begin('${B}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid) IS NULL,'cross tenant worker denied');
CREATE TEMP TABLE started AS SELECT public.campaign_begin('${A}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid) job;
SELECT pg_temp.ok((SELECT job->>'recipient_external_id'='111:12345' FROM started),'exact identity');
SELECT pg_temp.ok((SELECT job->'personalized_payload'->>'text'='Hello Synthetic Customer at Campaign synthetic A' FROM started),'exact personalization');
SELECT pg_temp.ok(public.campaign_finish('${A}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid,'SENT','synthetic-provider-id',NULL),'finish sent');
SELECT pg_temp.ok(NOT public.campaign_finish('${A}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid,'SENT','synthetic-provider-id',NULL),'idempotent finish');
SELECT pg_temp.ok((SELECT sent_count=1 AND status='COMPLETED' AND skipped_count=1 FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'truthful counts');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM jsonb_array_elements(public.c360_timeline('${A}','${cust}')->'items') e WHERE e->>'content' LIKE 'Campaign:%Delivery: SENT'),'Customer 360 timeline');
SELECT pg_temp.ok((SELECT count(*)=1 FROM public.conversations WHERE company_id='${A}' AND customer_id='${cust}'),'no fragmented thread');
SELECT pg_temp.ok((SELECT conversation_id='${conversation}' FROM public.interactions WHERE external_ref LIKE 'campaign:%'),'same Inbox conversation');
SELECT public.han_ingest('${A}','FACEBOOK','111:12345','campaign-reply-synthetic','Synthetic Customer',NULL,'Thanks','Thanks','SUCCEEDED',clock_timestamp(),'{}');
SELECT pg_temp.ok((SELECT count(*)=1 FROM public.conversations WHERE company_id='${A}' AND customer_id='${cust}'),'recipient reply reuses Inbox conversation');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM public.interactions WHERE company_id='${A}' AND customer_id='${cust}' AND conversation_id='${conversation}' AND sanitized_content='Thanks'),'real ingress reply in existing Inbox');
SELECT pg_temp.ok(public.campaign_receipt('${A}','${sender}','synthetic-provider-id','READ'),'read receipt');
SELECT public.campaign_receipt('${A}','${sender}','synthetic-provider-id','DELIVERED');
SELECT pg_temp.ok((SELECT delivery_status='READ' AND delivered_at IS NOT NULL FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'receipt monotonic');
SELECT pg_temp.ok(NOT public.campaign_receipt('${B}','${otherSender}','synthetic-provider-id','READ'),'tenant receipt denial');
`));

test("DB scheduled revalidation, pause/resume/cancel and unsent-only cancellation", () =>
  run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign() id;
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT public.campaign_command('${A}','${boss}','confirm',jsonb_build_object('id',(SELECT id FROM camp),'expected_version',(SELECT validation_version FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'expected_eligible',1,'scheduled_at',clock_timestamp()+interval '1 hour'));
SELECT pg_temp.ok(public.campaign_claim('${A}','FACEBOOK') IS NULL,'future schedule not claimed');
SELECT public.campaign_command('${A}','${boss}','pause',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok(public.campaign_claim('${A}','FACEBOOK') IS NULL,'paused');
SELECT public.campaign_command('${A}','${boss}','resume',jsonb_build_object('id',(SELECT id FROM camp)));
UPDATE public.messaging_campaigns SET scheduled_at=clock_timestamp()-interval '1 second' WHERE id=(SELECT id FROM camp);
UPDATE public.messaging_campaign_recipients SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE campaign_id=(SELECT id FROM camp);
CREATE TEMP TABLE claim AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
UPDATE public.interactions SET created_at=clock_timestamp()-interval '25 hours' WHERE conversation_id='${conversation}';
SELECT pg_temp.ok(public.campaign_begin('${A}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid) IS NULL,'scheduled window expired');
SELECT pg_temp.ok((SELECT eligibility_reason='OUTSIDE_WINDOW' AND delivery_status='SKIPPED' FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'blocked before transport');
UPDATE public.interactions SET created_at=clock_timestamp() WHERE conversation_id='${conversation}';
CREATE TEMP TABLE nextcamp AS SELECT pg_temp.make_campaign() id;
SELECT pg_temp.ready_confirm((SELECT id FROM nextcamp));
CREATE TEMP TABLE claim2 AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
SELECT public.campaign_command('${A}','${boss}','pause',jsonb_build_object('id',(SELECT id FROM nextcamp)));
SELECT pg_temp.ok(public.campaign_begin('${A}',((SELECT job FROM claim2)->>'id')::uuid,((SELECT job FROM claim2)->>'lock_token')::uuid) IS NULL,'pause after claim fences send');
SELECT public.campaign_command('${A}','${boss}','resume',jsonb_build_object('id',(SELECT id FROM nextcamp)));
SELECT public.campaign_begin('${A}',((SELECT job FROM claim2)->>'id')::uuid,((SELECT job FROM claim2)->>'lock_token')::uuid);
SELECT public.campaign_command('${A}','${boss}','cancel',jsonb_build_object('id',(SELECT id FROM nextcamp)));
SELECT pg_temp.ok((SELECT delivery_status='SENDING' FROM public.messaging_campaign_recipients WHERE campaign_id=(SELECT id FROM nextcamp) AND customer_id='${cust}'),'inflight not retracted');
SELECT public.campaign_finish('${A}',((SELECT job FROM claim2)->>'id')::uuid,((SELECT job FROM claim2)->>'lock_token')::uuid,'SENT','sent-before-cancel',NULL);
SELECT pg_temp.ok((SELECT status='CANCELLED' AND sent_count=1 FROM public.messaging_campaigns WHERE id=(SELECT id FROM nextcamp)),'cancel preserves sent');
`));

test("DB transient-only retries, permanent no-retry, expired pre/post-dispatch lease recovery", () =>
  run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign() id;
SELECT pg_temp.ready_confirm((SELECT id FROM camp));
CREATE TEMP TABLE claim AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
UPDATE public.messaging_campaign_recipients SET lease_until=clock_timestamp()-interval '1 second' WHERE delivery_status='CLAIMED';
CREATE TEMP TABLE claim2 AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
SELECT pg_temp.ok((SELECT job->>'lock_token' FROM claim)<>(SELECT job->>'lock_token' FROM claim2),'new recovered token');
SELECT pg_temp.ok(public.campaign_begin('${A}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid) IS NULL,'old lease fenced');
SELECT public.campaign_begin('${A}',((SELECT job FROM claim2)->>'id')::uuid,((SELECT job FROM claim2)->>'lock_token')::uuid);
SELECT public.campaign_finish('${A}',((SELECT job FROM claim2)->>'id')::uuid,((SELECT job FROM claim2)->>'lock_token')::uuid,'TRANSIENT',NULL,'429');
SELECT pg_temp.ok((SELECT delivery_status='QUEUED' AND next_attempt_at>clock_timestamp() AND attempt_count=1 FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'transient bounded backoff');
SELECT pg_temp.ok(public.campaign_claim('${A}','FACEBOOK') IS NULL,'not due');
UPDATE public.messaging_campaign_recipients SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE customer_id='${cust}';
CREATE TEMP TABLE claim3 AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
SELECT public.campaign_begin('${A}',((SELECT job FROM claim3)->>'id')::uuid,((SELECT job FROM claim3)->>'lock_token')::uuid);
SELECT public.campaign_finish('${A}',((SELECT job FROM claim3)->>'id')::uuid,((SELECT job FROM claim3)->>'lock_token')::uuid,'PERMANENT',NULL,'POLICY_REJECTION');
SELECT pg_temp.ok((SELECT delivery_status='FAILED' AND next_attempt_at IS NULL FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'permanent no retry');
CREATE TEMP TABLE camp2 AS SELECT pg_temp.make_campaign() id;
SELECT pg_temp.ready_confirm((SELECT id FROM camp2));
CREATE TEMP TABLE claim4 AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
SELECT public.campaign_begin('${A}',((SELECT job FROM claim4)->>'id')::uuid,((SELECT job FROM claim4)->>'lock_token')::uuid);
UPDATE public.messaging_campaign_recipients SET lease_until=clock_timestamp()-interval '1 second' WHERE campaign_id=(SELECT id FROM camp2) AND delivery_status='SENDING';
SELECT pg_temp.ok(public.campaign_claim('${A}','FACEBOOK') IS NULL,'never reclaim dispatch for resend');
SELECT pg_temp.ok((SELECT delivery_status='UNCERTAIN' FROM public.messaging_campaign_recipients WHERE campaign_id=(SELECT id FROM camp2) AND customer_id='${cust}'),'uncertain terminal');
`));

test("DB Zalo OA official-only, exact provider template, consent and connection gates", () =>
  run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign(chan=>'ZALO_OA',sid=>'${oa}',tid=>'${zaloTemplate}') id;
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok((SELECT eligibility_status='MISSING_IDENTITY' FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'missing Zalo identity');
INSERT INTO public.identities(company_id,customer_id,channel,external_id,verified) VALUES('${A}','${cust}','ZALO','333:6789',true);
INSERT INTO public.conversations(company_id,customer_id,channel,external_conversation_id) VALUES('${A}','${cust}','ZALO','333:6789');
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok((SELECT eligibility_reason='SENDER_UNAVAILABLE' FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'OA disconnected');
INSERT INTO public.zalo_oa_configs(company_id,oa_id,app_id,status) VALUES('${A}','333','synthetic-app','ACTIVE');
UPDATE public.messaging_sender_accounts SET connected=true,verified=true WHERE id='${oa}';
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok((SELECT eligibility_reason='NO_CONSENT' FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'no provider evidence');
INSERT INTO public.messaging_channel_evidence(company_id,sender_account_id,customer_id,identity_id,template_type,provider_template_id,consent_at,provider_verified_at,eligible_until)
SELECT '${A}','${oa}','${cust}',id,'ZBS_TEMPLATE','provider-approved-synthetic',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour' FROM public.identities WHERE company_id='${A}' AND channel='ZALO';
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok((SELECT eligible_count=1 FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'official evidence eligible');
UPDATE public.message_templates SET status='PROVIDER_REJECTED' WHERE id='${zaloTemplate}';
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok((SELECT eligibility_reason='TEMPLATE_DISABLED' FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'provider rejected');
UPDATE public.message_templates SET status='PROVIDER_APPROVED' WHERE id='${zaloTemplate}';
INSERT INTO public.care_schedules(company_id,customer_id,channel,next_send_at,enabled,stop_reason) VALUES('${A}','${cust}','ZALO',clock_timestamp(),false,'CUSTOMER_OPT_OUT');
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.ok((SELECT eligibility_status='UNSUBSCRIBED' FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'existing Zalo optout honored');
`));

test("DB service-only ACLs, RLS, intended actors, feature flag, SALE opt-in", () =>
  run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign(actor=>'${sale}') id;
SELECT public.campaign_command('${A}','${sale}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.denied($q$SELECT public.campaign_command('${A}','${sale}','confirm',jsonb_build_object('id',(SELECT id FROM camp),'expected_version',(SELECT validation_version FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'expected_eligible',1))$q$);
UPDATE public.messaging_campaign_settings SET sale_execute=true WHERE company_id='${A}';
SELECT public.campaign_command('${A}','${sale}','confirm',jsonb_build_object('id',(SELECT id FROM camp),'expected_version',(SELECT validation_version FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'expected_eligible',1));
SELECT pg_temp.denied($q$SELECT public.campaign_command('${A}','${sale}','pause',jsonb_build_object('id',(SELECT id FROM camp)))$q$);
UPDATE public.messaging_campaign_settings SET enabled=false WHERE company_id='${A}';
SELECT pg_temp.ok(public.campaign_claim('${A}','FACEBOOK') IS NULL,'tenant OFF');
SELECT pg_temp.denied($q$SELECT pg_temp.make_campaign()$q$);
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'campaign_%' AND
(has_function_privilege('anon',oid,'EXECUTE') OR has_function_privilege('authenticated',oid,'EXECUTE') OR NOT proconfig @> ARRAY['search_path=""'])),'RPC ACL/search paths');
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('messaging_campaigns','messaging_campaign_recipients','message_templates','messaging_suppressions')
AND (NOT relrowsecurity OR has_table_privilege('authenticated',oid,'SELECT') OR has_table_privilege('service_role',oid,'UPDATE'))),'tables RPC only');
SET LOCAL ROLE authenticated;
DO $$ BEGIN PERFORM public.campaign_read('${A}','${boss}'); RAISE EXCEPTION 'unexpected access'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
`));

test("stale preview and same-count swapped eligibility cannot be confirmed", () =>
  run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign() id;
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
SELECT pg_temp.denied($q$SELECT public.campaign_command('${A}','${boss}','confirm',jsonb_build_object('id',(SELECT id FROM camp),'expected_version',1,'expected_eligible',1))$q$);
INSERT INTO public.identities(company_id,customer_id,channel,external_id,verified) VALUES('${A}','${missing}','FACEBOOK','111:9999',true);
INSERT INTO public.conversations(company_id,customer_id,channel,external_conversation_id) VALUES('${A}','${missing}','FACEBOOK','111:9999');
INSERT INTO public.interactions(company_id,customer_id,conversation_id,channel,type,direction,actor_type,sanitized_content,sanitization_status)
SELECT '${A}','${missing}',id,'FACEBOOK','MESSAGE','INBOUND','CUSTOMER','Hello','SUCCEEDED' FROM public.conversations WHERE company_id='${A}' AND customer_id='${missing}';
INSERT INTO public.messaging_suppressions(company_id,customer_id,channel,status) VALUES('${A}','${cust}','FACEBOOK','BLOCKED');
SELECT pg_temp.denied($q$SELECT public.campaign_command('${A}','${boss}','confirm',jsonb_build_object('id',(SELECT id FROM camp),'expected_version',2,'expected_eligible',1))$q$);
SELECT pg_temp.ok((SELECT confirmed_at IS NULL FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),'no accidental send after same-count swap');
`));
test("inbound optout, disabled template, missing variable, server-side sender sync and exact frozen payload", () =>
  run(`
SELECT public.campaign_sync_senders('${A}','${boss}','[{"id":"111","name":"Bound Page","connected":true}]');
SELECT pg_temp.ok((SELECT connected FROM public.messaging_sender_accounts WHERE id='${sender}'),'tenant page sync');
INSERT INTO public.zalo_oa_configs(company_id,oa_id,app_id,status) VALUES('${A}','4444','ZCAJS','ACTIVE');
SELECT public.campaign_sync_senders('${A}','${boss}','[{"id":"111","name":"Bound Page","connected":true}]');
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM public.messaging_sender_accounts WHERE external_id='4444'),'personal ZCAJS never registered');
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign() id;
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
UPDATE public.customers SET name='Changed after preview' WHERE id='${cust}';
SELECT pg_temp.ready_confirm((SELECT id FROM camp));
CREATE TEMP TABLE claim AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
SELECT pg_temp.ok(public.campaign_begin('${A}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid)->'personalized_payload'->>'text'='Hello Synthetic Customer at Campaign synthetic A','exact frozen preview payload');
SELECT public.campaign_finish('${A}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid,'SENT','frozen-payload-id',NULL);
UPDATE public.message_templates SET content='{{assigned_sale_name}}' WHERE id='${template}';
CREATE TEMP TABLE camp2 AS SELECT pg_temp.make_campaign() id;
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp2)));
SELECT pg_temp.ok((SELECT eligibility_reason='MISSING_VARIABLE' FROM public.messaging_campaign_recipients WHERE campaign_id=(SELECT id FROM camp2) AND customer_id='${cust}'),'missing variable blocked');
UPDATE public.message_templates SET status='DISABLED' WHERE id='${template}';
SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp2)));
SELECT pg_temp.ok((SELECT eligibility_reason='TEMPLATE_DISABLED' FROM public.messaging_campaign_recipients WHERE campaign_id=(SELECT id FROM camp2) AND customer_id='${cust}'),'disabled template');
INSERT INTO public.interactions(company_id,customer_id,conversation_id,channel,type,direction,actor_type,sanitized_content,sanitization_status)
VALUES('${A}','${cust}','${conversation}','FACEBOOK','MESSAGE','INBOUND','CUSTOMER','Dừng nhắn tin cho tôi','SUCCEEDED');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM public.messaging_suppressions WHERE company_id='${A}' AND customer_id='${cust}' AND channel='FACEBOOK'),'Vietnamese optout captured');
`));
test('provider IDs, retry budget and company rate limits fail closed',()=>run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign() id;
SELECT pg_temp.ready_confirm((SELECT id FROM camp));
CREATE TEMP TABLE claim AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
INSERT INTO private.messaging_rate_buckets(company_id,bucket_key,minute,used) VALUES('${A}','company',date_trunc('minute',clock_timestamp()),60);
SELECT pg_temp.ok(public.campaign_begin('${A}',((SELECT job FROM claim)->>'id')::uuid,((SELECT job FROM claim)->>'lock_token')::uuid) IS NULL,'company cap');
SELECT pg_temp.ok((SELECT attempt_count=0 AND delivery_status='QUEUED' FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'rate limit does not send or spend attempt');
UPDATE private.messaging_rate_buckets SET used=0;
UPDATE public.messaging_campaign_recipients SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE customer_id='${cust}';
CREATE TEMP TABLE claim2 AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
SELECT public.campaign_begin('${A}',((SELECT job FROM claim2)->>'id')::uuid,((SELECT job FROM claim2)->>'lock_token')::uuid);
SELECT public.campaign_finish('${A}',((SELECT job FROM claim2)->>'id')::uuid,((SELECT job FROM claim2)->>'lock_token')::uuid,'SENT',NULL,NULL);
SELECT pg_temp.ok((SELECT delivery_status='UNCERTAIN' AND provider_message_id IS NULL FROM public.messaging_campaign_recipients WHERE customer_id='${cust}'),'missing provider ID never success');
CREATE TEMP TABLE camp2 AS SELECT pg_temp.make_campaign() id;
SELECT pg_temp.ready_confirm((SELECT id FROM camp2));
UPDATE public.messaging_campaign_recipients SET attempt_count=4 WHERE campaign_id=(SELECT id FROM camp2) AND customer_id='${cust}';
CREATE TEMP TABLE claim3 AS SELECT public.campaign_claim('${A}','FACEBOOK') job;
SELECT public.campaign_begin('${A}',((SELECT job FROM claim3)->>'id')::uuid,((SELECT job FROM claim3)->>'lock_token')::uuid);
SELECT public.campaign_finish('${A}',((SELECT job FROM claim3)->>'id')::uuid,((SELECT job FROM claim3)->>'lock_token')::uuid,'TRANSIENT',NULL,'429');
SELECT pg_temp.ok((SELECT delivery_status='FAILED' AND attempt_count=5 AND next_attempt_at IS NULL FROM public.messaging_campaign_recipients WHERE campaign_id=(SELECT id FROM camp2) AND customer_id='${cust}'),'retry budget exhausted');
`));
const concurrent = (query: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("docker", [
      "exec",
      "-i",
      "supabase_db_ai-crm-cua-chong-ngap",
      "psql",
      "-X",
      "-qAt",
      "-U",
      "supabase_admin",
      "-d",
      testDb,
      "-v",
      "ON_ERROR_STOP=1",
    ]);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)),
    );
    child.stdin.end(query);
  });
test("real concurrent creation, confirmation, queue claim and fenced finish are idempotent", async () => {
  const output = sql(
    setup +
      `CREATE TEMP TABLE camp AS SELECT pg_temp.make_campaign() id;
 SELECT public.campaign_command('${A}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp)));
 SELECT 'campaign-id:'||id FROM camp;COMMIT;`,
  );
  const cid = output.match(/campaign-id:([a-f0-9-]{36})/)![1];
  const request = {
    request_id: "bc000000-0000-4000-8000-000000000071",
    name: "Concurrent duplicate",
    channel: "FACEBOOK",
    sender_account_id: sender,
    template_id: template,
    customer_ids: [cust],
  };
  const create = `SELECT public.campaign_command('${A}','${boss}','create','${JSON.stringify(request)}');`;
  const creates = await Promise.all([
    concurrent(`BEGIN;${create} SELECT pg_sleep(0.2);COMMIT;`),
    concurrent(create),
  ]);
  assert.equal(
    JSON.parse(creates[0].split("\n")[0]).id,
    JSON.parse(creates[1].split("\n")[0]).id,
  );
  const confirm = `SELECT public.campaign_command('${A}','${boss}','confirm',jsonb_build_object('id','${cid}','expected_version',1,'expected_eligible',1));`;
  await Promise.all([
    concurrent(`BEGIN;${confirm} SELECT pg_sleep(0.2);COMMIT;`),
    concurrent(confirm),
  ]);
  const claims = await Promise.all([
    concurrent(
      `BEGIN; SELECT coalesce(public.campaign_claim('${A}','FACEBOOK')::text,'null'); SELECT pg_sleep(0.2); COMMIT;`,
    ),
    concurrent(
      `SELECT coalesce(public.campaign_claim('${A}','FACEBOOK')::text,'null');`,
    ),
  ]);
  const jobs = claims.map((v) => JSON.parse(v.split("\n")[0])).filter(Boolean);
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  await concurrent(
    `SELECT public.campaign_begin('${A}','${job.id}','${job.lock_token}');`,
  );
  const finish = `SELECT public.campaign_finish('${A}','${job.id}','${job.lock_token}','SENT','concurrent-provider-id',NULL);`;
  const finishes = await Promise.all([concurrent(finish), concurrent(finish)]);
  assert.deepEqual(finishes.sort(), ["f", "t"]);
  const counts = await concurrent(
    `SELECT count(*) FROM public.messaging_campaign_audit WHERE campaign_id='${cid}' AND event='recipient_sent';`,
  );
  assert.equal(counts, "1");
});
