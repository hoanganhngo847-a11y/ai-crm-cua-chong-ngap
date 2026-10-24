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
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      testDb,
    ],
    { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  ).trim();
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
const identityA = "bd000000-0000-4000-8000-000000000041";
const identityB = "bd000000-0000-4000-8000-000000000042";
const conversationA = "bd000000-0000-4000-8000-000000000051";
const conversationB = "bd000000-0000-4000-8000-000000000052";
const logicalSender = `zcajs:${company}`;

const setup = `
BEGIN;
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
INSERT INTO public.identities(
  id,company_id,customer_id,channel,external_id,verified,metadata
) VALUES
('${identityA}','${company}','${customerA}','ZALO','700000001',false,'{"source":"ZCAJS","provider":"zcajs"}'),
('${identityB}','${company}','${customerB}','ZALO','700000002',false,'{"source":"ZCAJS","provider":"zcajs"}');
INSERT INTO public.conversations(
  id,company_id,customer_id,channel,external_conversation_id
) VALUES
('${conversationA}','${company}','${customerA}','ZALO','700000001'),
('${conversationB}','${company}','${customerB}','ZALO','700000002');
`;

function createReadyCampaign() {
  const campaign = sql(
    setup + `
WITH made AS (
  SELECT (public.campaign_command(
    '${company}','${boss}','create',jsonb_build_object(
      'request_id',gen_random_uuid(),
      'name','Personal Zalo 5 minute test',
      'channel','ZALO_PERSONAL',
      'sender_account_id','${sender}',
      'template_id','${template}',
      'customer_ids',jsonb_build_array('${customerA}','${customerB}')
    )
  )->>'id')::uuid AS id
)
SELECT id FROM made;
`,
  );
  assert.match(campaign, /^[0-9a-f-]{36}$/i);
  sql(`
SELECT public.campaign_command(
  '${company}','${boss}','validate',jsonb_build_object('id','${campaign}')
);
`);
  return campaign;
}

test("personal Zalo confirm schedules recipients five minutes apart", () => {
  const campaign = createReadyCampaign();
  const version = Number(
    sql(`SELECT validation_version FROM public.messaging_campaigns WHERE id='${campaign}';`),
  );
  assert.ok(version > 0);

  sql(`
SELECT public.campaign_command(
  '${company}','${boss}','confirm',jsonb_build_object(
    'id','${campaign}',
    'expected_version',${version},
    'expected_eligible',2,
    'scheduled_at',NULL
  )
);
`);

  const spacing = Number(
    sql(`
SELECT round(extract(epoch FROM (max(next_attempt_at)-min(next_attempt_at))))::int
FROM public.messaging_campaign_recipients
WHERE campaign_id='${campaign}' AND eligibility_status='ELIGIBLE';
`),
  );
  assert.equal(spacing, 300);

  const queued = Number(
    sql(`
SELECT count(*) FROM public.messaging_campaign_recipients
WHERE campaign_id='${campaign}' AND delivery_status='QUEUED';
`),
  );
  assert.equal(queued, 2);
  sql("ROLLBACK;");
});

test("sender-wide gate prevents catch-up bursts after overdue work", () => {
  const campaign = createReadyCampaign();
  const version = Number(
    sql(`SELECT validation_version FROM public.messaging_campaigns WHERE id='${campaign}';`),
  );
  sql(`
SELECT public.campaign_command(
  '${company}','${boss}','confirm',jsonb_build_object(
    'id','${campaign}',
    'expected_version',${version},
    'expected_eligible',2,
    'scheduled_at',NULL
  )
);
`);

  const firstClaim = JSON.parse(
    sql(`SELECT public.campaign_claim('${company}','ZALO_PERSONAL')::text;`),
  ) as { id: string; lock_token: string };
  assert.ok(firstClaim.id);

  const begun = sql(`
SELECT public.campaign_begin(
  '${company}','${firstClaim.id}','${firstClaim.lock_token}'
) IS NOT NULL;
`);
  assert.equal(begun, "t");

  sql(`
UPDATE public.messaging_campaign_recipients
SET next_attempt_at=clock_timestamp()-interval '1 minute'
WHERE campaign_id='${campaign}' AND id<>'${firstClaim.id}';
`);

  const blocked = sql(
    `SELECT public.campaign_claim('${company}','ZALO_PERSONAL') IS NULL;`,
  );
  assert.equal(blocked, "t");

  sql(`
UPDATE public.messaging_campaign_recipients
SET dispatch_started_at=clock_timestamp()-interval '5 minutes 1 second'
WHERE id='${firstClaim.id}';
`);

  const secondClaim = JSON.parse(
    sql(`SELECT public.campaign_claim('${company}','ZALO_PERSONAL')::text;`),
  ) as { id: string };
  assert.ok(secondClaim.id);
  assert.notEqual(secondClaim.id, firstClaim.id);
  sql("ROLLBACK;");
});
