import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

test('local Postgres: SLA, human reply, fail-fast, transient retry, ACL and claim fencing', () => {
  // Hard-coded local Docker container; this test cannot connect to production.
  const migration = readFileSync('supabase/migrations/' + readdirSync('supabase/migrations').find(n => n.endsWith('_zalo_brain_sla_and_terminal_failures.sql')), 'utf8');
  const oneMinuteMigration = readFileSync('supabase/migrations/20261025160000_zalo_brain_one_minute_sla.sql', 'utf8');
  const [company, customer, conv, inbound, token] = Array.from({ length: 5 }, () => randomUUID());
  const sql = `BEGIN;
${migration}
${oneMinuteMigration}
${oneMinuteMigration}
INSERT INTO public.companies(id,name,status) VALUES ('${company}','Synthetic SLA regression','ACTIVE');
INSERT INTO public.customers(id,company_id,customer_code,name,source,stage)
VALUES ('${customer}','${company}','SLA-${customer}','Synthetic','MANUAL','LEAD_NEW');
INSERT INTO public.conversations(id,company_id,customer_id,channel,external_conversation_id,status,ai_mode)
VALUES ('${conv}','${company}','${customer}','ZALO','synthetic-${conv}','OPEN','ACTIVE');
INSERT INTO public.ai_brain_live_settings(company_id,channel,enabled) VALUES ('${company}','ZALO',true);
INSERT INTO public.interactions(id,company_id,customer_id,conversation_id,channel,type,direction,actor_type,sanitization_status,sanitized_content)
VALUES ('${inbound}','${company}','${customer}','${conv}','ZALO','MESSAGE','INBOUND','CUSTOMER','SUCCEEDED','Synthetic inquiry');
DO $$ DECLARE d public.ai_brain_live_deliveries; n integer; BEGIN
 SELECT * INTO STRICT d FROM public.ai_brain_live_deliveries WHERE source_interaction_id='${inbound}';
 ASSERT d.available_at >= now() + interval '59 seconds', 'Initial availability must wait about one minute';
 ASSERT d.available_at < now() + interval '2 minutes', 'Initial availability must not retain the old five-minute SLA';
 SELECT count(*) INTO n FROM public.claim_ai_brain_live_deliveries(10,'${token}','ZALO') WHERE id=d.id;
 ASSERT n=0, 'Fresh inbound cannot be claimed';
 -- Advance only the synthetic clock fixtures, never sleep or change wall clock.
 UPDATE public.interactions SET created_at=now()-interval '2 minutes' WHERE id='${inbound}';
 UPDATE public.ai_brain_live_deliveries SET available_at=now()-interval '1 second' WHERE id=d.id;
 SELECT count(*) INTO n FROM public.claim_ai_brain_live_deliveries(10,'${token}','ZALO') WHERE id=d.id;
 ASSERT n=1, 'Due inbound must be claimed after one minute';
 ASSERT public.ai_brain_live_zalo_is_eligible(d.id,'${token}'), 'Due active conversation eligible';
 ASSERT NOT public.ai_brain_live_zalo_is_eligible(d.id,gen_random_uuid()), 'Wrong lease denied';
 SELECT count(*) INTO n FROM public.claim_ai_brain_live_deliveries(10,gen_random_uuid(),'ZALO') WHERE id=d.id;
 ASSERT n=0, 'Duplicate claim denied';
 UPDATE public.conversations SET ai_mode='PAUSED' WHERE id='${conv}';
 ASSERT NOT public.ai_brain_live_zalo_is_eligible(d.id,'${token}'), 'Paused conversation denied';
 UPDATE public.conversations SET ai_mode='ACTIVE' WHERE id='${conv}';
 INSERT INTO public.interactions(company_id,customer_id,conversation_id,channel,type,direction,actor_type,sanitization_status,sanitized_content,created_at)
 VALUES ('${company}','${customer}','${conv}','ZALO','MESSAGE','OUTBOUND','SALE','SUCCEEDED','Synthetic Sale reply',now()-interval '30 seconds');
 ASSERT NOT public.ai_brain_live_zalo_is_eligible(d.id,'${token}'), 'Sale reply after inbound suppresses AI';
 ASSERT public.finish_ai_brain_live_delivery(d.id,'${token}','FAILED','ERROR',0,null,'BRAIN_TIMEOUT'), 'Timeout finish';
 ASSERT (SELECT retryable FROM public.ai_brain_live_deliveries WHERE id=d.id), 'Timeout remains retryable';
 UPDATE public.ai_brain_live_deliveries SET available_at=now()-interval '1 second' WHERE id=d.id;
 SELECT count(*) INTO n FROM public.claim_ai_brain_live_deliveries(10,'${token}','ZALO') WHERE id=d.id;
 ASSERT n=1, 'Transient failure can retry';
 ASSERT public.finish_ai_brain_live_delivery(d.id,'${token}','FAILED','ERROR',0,null,'RUNTIME_AUTH_FAILED'), 'Auth finish';
 ASSERT NOT (SELECT retryable FROM public.ai_brain_live_deliveries WHERE id=d.id), 'Auth must fail fast';
 UPDATE public.ai_brain_live_deliveries SET available_at=now()-interval '1 second' WHERE id=d.id;
 SELECT count(*) INTO n FROM public.claim_ai_brain_live_deliveries(10,'${token}','ZALO') WHERE id=d.id;
 ASSERT n=0, 'Auth failure cannot be reclaimed';
 ASSERT NOT has_function_privilege('anon','public.ai_brain_live_zalo_is_eligible(uuid,uuid)','EXECUTE'), 'Anon denied';
 ASSERT NOT has_function_privilege('authenticated','public.ai_brain_live_zalo_is_eligible(uuid,uuid)','EXECUTE'), 'Client denied';
END $$;
ROLLBACK;
SELECT 'SLA_RETRY_REGRESSION_PASS';`;
  const output = execFileSync('docker', ['exec', '-i', 'supabase_db_ai-crm-cua-chong-ngap', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8' });
  assert.match(output, /SLA_RETRY_REGRESSION_PASS/);
});
