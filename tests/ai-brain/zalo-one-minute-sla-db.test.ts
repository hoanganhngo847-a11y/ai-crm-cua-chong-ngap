import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

test('local Postgres: latest Zalo live SLA is one minute while processing lease remains fenced', () => {
  const baseMigration = readFileSync('supabase/migrations/20261025124107_zalo_brain_sla_and_terminal_failures.sql', 'utf8');
  const oneMinuteMigration = readFileSync('supabase/migrations/20261025160000_zalo_brain_one_minute_sla.sql', 'utf8');
  const [company, customer, conv, inbound, token] = Array.from({ length: 5 }, () => randomUUID());

  const sql = `BEGIN;
${baseMigration}
${oneMinuteMigration}
${oneMinuteMigration}
INSERT INTO public.companies(id,name,status) VALUES ('${company}','Synthetic one-minute SLA','ACTIVE');
INSERT INTO public.customers(id,company_id,customer_code,name,source,stage)
VALUES ('${customer}','${company}','SLA1-${customer}','Synthetic','MANUAL','LEAD_NEW');
INSERT INTO public.conversations(id,company_id,customer_id,channel,external_conversation_id,status,ai_mode)
VALUES ('${conv}','${company}','${customer}','ZALO','synthetic-${conv}','OPEN','ACTIVE');
INSERT INTO public.ai_brain_live_settings(company_id,channel,enabled) VALUES ('${company}','ZALO',true);
INSERT INTO public.interactions(id,company_id,customer_id,conversation_id,channel,type,direction,actor_type,sanitization_status,sanitized_content)
VALUES ('${inbound}','${company}','${customer}','${conv}','ZALO','MESSAGE','INBOUND','CUSTOMER','SUCCEEDED','Synthetic consultation request');
DO $$ DECLARE d public.ai_brain_live_deliveries; n integer; BEGIN
 SELECT * INTO STRICT d FROM public.ai_brain_live_deliveries WHERE source_interaction_id='${inbound}';
 ASSERT d.available_at >= now() + interval '59 seconds', 'Initial availability must wait about one minute';
 ASSERT d.available_at < now() + interval '2 minutes', 'Initial availability must not retain the old five-minute SLA';
 SELECT count(*) INTO n FROM public.claim_ai_brain_live_deliveries(10,'${token}','ZALO') WHERE id=d.id;
 ASSERT n=0, 'Fresh inbound cannot be claimed before one minute';
 UPDATE public.interactions SET created_at=now()-interval '2 minutes' WHERE id='${inbound}';
 UPDATE public.ai_brain_live_deliveries SET available_at=now()-interval '1 second' WHERE id=d.id;
 SELECT count(*) INTO n FROM public.claim_ai_brain_live_deliveries(10,'${token}','ZALO') WHERE id=d.id;
 ASSERT n=1, 'Inbound older than one minute must be claimable';
 ASSERT public.ai_brain_live_zalo_is_eligible(d.id,'${token}'), 'Claimed one-minute delivery must be eligible';
 ASSERT (SELECT locked_at > now()-interval '5 minutes' FROM public.ai_brain_live_deliveries WHERE id=d.id), 'Processing lease remains five minutes';
END $$;
ROLLBACK;
SELECT 'ONE_MINUTE_SLA_REGRESSION_PASS';`;

  const output = execFileSync(
    'docker',
    ['exec', '-i', 'supabase_db_ai-crm-cua-chong-ngap', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
    { input: sql, encoding: 'utf8' }
  );
  assert.match(output, /ONE_MINUTE_SLA_REGRESSION_PASS/);
});
