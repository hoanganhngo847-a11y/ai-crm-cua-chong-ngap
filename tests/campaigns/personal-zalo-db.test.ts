import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const endpoint = execFileSync(
  "docker",
  ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
  { encoding: "utf8" },
).trim();
if (
  !endpoint.startsWith("unix://") ||
  (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://"))
) {
  throw new Error("LOCAL_DOCKER_ONLY");
}

const testDb = `campaign_personal_zalo_${process.pid}_${Date.now()}`;

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

const company = "bd000000-0000-4000-8000-000000000001";
const boss = "bd000000-0000-4000-8000-000000000002";
const customerA = "bd000000-0000-4000-8000-000000000011";
const customerB = "bd000000-0000-4000-8000-000000000012";
const sender = "bd000000-0000-4000-8000-000000000021";
const template = "bd000000-0000-4000-8000-000000000031";
const conversationA = "bd000000-0000-4000-8000-000000000051";
const conversationB = "bd000000-0000-4000-8000-000000000052";
const logicalSender = `zcajs:${company}`;

const setup = `BEGIN;
CREATE FUNCTION pg_temp.ok(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %',label; END IF;
END $$;
INSERT INTO public.companies(id,name,status)
VALUES('${company}','Personal Zalo synthetic','ACTIVE');
INSERT INTO auth.users(id,email)
VALUES('${boss}','personal-zalo-boss@synthetic.test');
INSERT INTO public.user_profiles(id,full_name,status)
VALUES('${boss}','Personal Zalo Boss','ACTIVE')
ON CONFLICT(id) DO UPDATE SET status='ACTIVE';
INSERT INTO public.company_members(company_id,user_id,role,status)
VALUES('${company}','${boss}','BOSS_ADMIN','ACTIVE');
INSERT INTO public.messaging_campaign_settings(company_id,enabled,sale_execute)
VALUES('${company}',true,false);
INSERT INTO public.customers(id,company_id,name,source,stage,customer_code)
VALUES
('${customerA}','${company}','Khach A','ZALO','LEAD_NEW','PZA'),
('${customerB}','${company}','Khach B','ZALO','LEAD_NEW','PZB');
INSERT INTO public.zalo_oa_configs(company_id,oa_id,app_id,status)
VALUES('${company}','${logicalSender}','ZCAJS','ACTIVE');
INSERT INTO public.messaging_sender_accounts(
  id,company_id,channel,external_id,name,connected,verified
) VALUES(
  '${sender}','${company}','ZALO_PERSONAL','${logicalSender}','Zalo cá nhân',true,true
);
INSERT INTO public.message_templates(
  id,company_id,name,channel,template_type,content,status,created_by
) VALUES(
  '${template}','${company}','Personal text','ZALO_PERSONAL','ZALO_PERSONAL_TEXT',
  'Chao {{customer_name}}','ACTIVE','${boss}'
);
-- Mirror production ingress: ZCAJS is identified on the conversation metadata and
-- no identity row is assumed to exist yet.
INSERT INTO public.conversations(
  id,company_id,customer_id,channel,external_conversation_id,metadata
) VALUES
('${conversationA}','${company}','${customerA}','ZALO','700000001','{"provider":"zcajs"}'),
('${conversationB}','${company}','${customerB}','ZALO','700000002','{"provider":"zcajs"}');
SELECT public.campaign_sync_senders('${company}','${boss}','[]'::jsonb);
SELECT pg_temp.ok(
  (SELECT count(*)=2
     FROM public.identities
    WHERE company_id='${company}'
      AND channel='ZALO'
      AND metadata->>'provider'='zcajs'),
  'ZCAJS conversations materialize canonical identities'
);
CREATE FUNCTION pg_temp.make_personal_campaign() RETURNS uuid LANGUAGE sql AS $$
  SELECT (public.campaign_command(
    '${company}','${boss}','create',jsonb_build_object(
      'request_id',gen_random_uuid(),
      'name','Personal Zalo 5 minute test',
      'channel','ZALO_PERSONAL',
      'sender_account_id','${sender}',
      'template_id','${template}',
      'customer_ids',jsonb_build_array('${customerA}','${customerB}')
    )
  )->>'id')::uuid
$$;
`;

function run(body: string) {
  const output = sql(setup + body + "\nROLLBACK;");
  assert.match(output, /ROLLBACK/);
}

test("personal Zalo confirm schedules recipients five minutes apart", () =>
  run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_personal_campaign() AS id;
SELECT public.campaign_command(
  '${company}','${boss}','validate',
  jsonb_build_object('id',(SELECT id FROM camp))
);
SELECT pg_temp.ok(
  (SELECT eligible_count=2 FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),
  'two personal Zalo recipients eligible'
);
SELECT public.campaign_command(
  '${company}','${boss}','confirm',jsonb_build_object(
    'id',(SELECT id FROM camp),
    'expected_version',(SELECT validation_version FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),
    'expected_eligible',2,
    'scheduled_at',NULL
  )
);
SELECT pg_temp.ok(
  (SELECT count(*)=2 FROM public.messaging_campaign_recipients
    WHERE campaign_id=(SELECT id FROM camp) AND delivery_status='QUEUED'),
  'both recipients queued'
);
SELECT pg_temp.ok(
  (SELECT round(extract(epoch FROM (max(next_attempt_at)-min(next_attempt_at))))::int=300
     FROM public.messaging_campaign_recipients
    WHERE campaign_id=(SELECT id FROM camp) AND eligibility_status='ELIGIBLE'),
  'queued recipients are exactly five minutes apart'
);
`));

test("sender-wide gate prevents catch-up bursts after overdue work", () =>
  run(`
CREATE TEMP TABLE camp AS SELECT pg_temp.make_personal_campaign() AS id;
SELECT public.campaign_command(
  '${company}','${boss}','validate',
  jsonb_build_object('id',(SELECT id FROM camp))
);
SELECT public.campaign_command(
  '${company}','${boss}','confirm',jsonb_build_object(
    'id',(SELECT id FROM camp),
    'expected_version',(SELECT validation_version FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),
    'expected_eligible',2,
    'scheduled_at',NULL
  )
);
CREATE TEMP TABLE first_claim AS
SELECT public.campaign_claim('${company}','ZALO_PERSONAL') AS job;
SELECT pg_temp.ok((SELECT job IS NOT NULL FROM first_claim),'first recipient claimed');
CREATE TEMP TABLE first_begin AS
SELECT public.campaign_begin(
  '${company}',
  ((SELECT job FROM first_claim)->>'id')::uuid,
  ((SELECT job FROM first_claim)->>'lock_token')::uuid
) AS job;
SELECT pg_temp.ok((SELECT job IS NOT NULL FROM first_begin),'first recipient began dispatch');
UPDATE public.messaging_campaign_recipients
   SET next_attempt_at=clock_timestamp()-interval '1 minute'
 WHERE campaign_id=(SELECT id FROM camp)
   AND id<>((SELECT job FROM first_claim)->>'id')::uuid;
SELECT pg_temp.ok(
  public.campaign_claim('${company}','ZALO_PERSONAL') IS NULL,
  'second overdue recipient remains blocked inside five minute window'
);
UPDATE public.messaging_campaign_recipients
   SET dispatch_started_at=clock_timestamp()-interval '5 minutes 1 second'
 WHERE id=((SELECT job FROM first_claim)->>'id')::uuid;
CREATE TEMP TABLE second_claim AS
SELECT public.campaign_claim('${company}','ZALO_PERSONAL') AS job;
SELECT pg_temp.ok((SELECT job IS NOT NULL FROM second_claim),'second recipient claim opens after five minutes');
SELECT pg_temp.ok(
  ((SELECT job FROM second_claim)->>'id')::uuid <> ((SELECT job FROM first_claim)->>'id')::uuid,
  'second claim is a different recipient'
);
`));
